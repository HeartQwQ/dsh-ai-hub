import { cnModels, cnCall, cnCredits } from './cn-client.mjs';
import { normalizeModels, parseCliModels, selectModels, createProxyAdapter, recommendedModels, withVariantReasoning, collapseModels, projectSelection, resolveVariant } from './catalog.mjs';
import { createP0 } from './p0.mjs';
import { createWorkbuddy } from './workbuddy.mjs';
import { createWorkbuddyAdapter } from './workbuddy-chat.mjs';
import { createMcpBridge, extractPendingToolResults, formatMcpPrompt, packPromptTurns } from './mcp-bridge.mjs';
import { createLoginActions } from './login-actions.mjs';
import { nativeProviderSnapshot } from './native-config.mjs';
import { createUsageStore, createFileBackend, fromGatewayRecord, toGatewayRecord } from './usage-store.mjs';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT, PLATFORMS, DEFAULTS, detect, runProcess, cliCall, codexRpc, codexAccount, codexQuota, codexModels, cursorQuota, cursorAccount, publicAccountIdentity, failure, safe } from './runtime.mjs';
export const name='ai-hub';
export const inject=['llm','subagents','tools','webServer','workspaceRegistry','credentials'];
const NAMES={codex:'Codex',cursor:'Cursor',antigravity:'Antigravity','workbuddy-cn':'WorkBuddy CN'};
const QUOTA_TTL = 5 * 60_000;
const QUOTA_RETRY = 60_000;

function parseAntigravityUsage(output) {
 const windows = new Map();
 for (const line of output.split(/\r?\n/)) {
  const columns = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\t').map(value => value.trim());
  if (columns.length !== 4) continue;
  const [group, period, percent, reset] = columns;
  if (!group || !/limit/i.test(period) || !/^\d{1,3}(?:\.\d+)?%$/.test(percent)) continue;
  const remainingPercent = Number(percent.slice(0, -1));
  const resetTime = Date.parse(reset);
  if (remainingPercent > 100 || !/^\d{4}-\d{2}-\d{2}T/.test(reset) || !Number.isFinite(resetTime)) continue;
  const windowName = /five hour|5\s*h(?:our)?/i.test(period) ? '5 小时' : /weekly|week/i.test(period) ? '每周' : /daily|day/i.test(period) ? '每日' : /monthly|month/i.test(period) ? '每月' : period;
  const id = `${group}:${period}`;
  windows.set(id, {id, label: `${group} · ${windowName}`, remainingPercent, resetAt: new Date(resetTime).toISOString()});
 }
 return [...windows.values()];
}
const EFFORTS={
 'workbuddy-cn':[{id:'low',name:'低'},{id:'medium',name:'中'},{id:'high',name:'高'}]
};
const DEFAULT_EFFORT={'workbuddy-cn':'medium'};
const withReasoning=(platform,model)=>model.reasoning?model:{...model,reasoning:{efforts:EFFORTS[platform],defaultEffort:DEFAULT_EFFORT[platform]}};
const clone=x=>JSON.parse(JSON.stringify(x));
export function normalizeSettings(raw={}){
 const out=clone(DEFAULTS);
 for(const p of PLATFORMS){const v=raw[p];if(!v||typeof v!=='object')continue;if(typeof v.enabled==='boolean')out[p].enabled=v.enabled;if(Array.isArray(v.visibleModels))out[p].visibleModels=[...new Set(v.visibleModels.filter(x=>typeof x==='string'&&x.length<=160&&!x.startsWith('-')))].slice(0,400);if(p==='workbuddy-cn'&&typeof v.showCredits==='boolean')out[p].showCredits=v.showCredits;}
 return out;
}
export const CLI_INPUT_BUDGET=24000;
export function flattenWithMeta(options,budget=CLI_INPUT_BUDGET){
 // CLI models never emit DSH tool calls; DSH tool schemas are deliberately not forwarded.
 // The CLI backend still ships its own file/shell tools, so no text-only directive is
 // prepended: an earlier "text conversation only" line suppressed those tools outright.
 const blocks=c=>typeof c==='string'?c:Array.isArray(c)?c.map(b=>b.type==='text'?b.text:`[${b.type} omitted]`).join('\n'):'';
 const system=blocks(options.system??options.systemPrompt??'').trim();
 const turns=(options.messages??[]).map(m=>`${m.role}: ${blocks(m.content)}`).filter(text=>text.length>0);
 // Some hosts build a very large system prompt (tool catalogue, agent guide). The
 // CLI transports cap a single prompt at 26000 characters, so keep a bounded
 // system excerpt plus the newest turns and drop older history explicitly.
 return packPromptTurns({
  system,
  turns,
  budget,
  systemMaxChars:6000,
  systemRatio:0.4,
  pinFirstUser:false,
  emptyFallback:''
 });
}
export function flatten(options,budget=CLI_INPUT_BUDGET){
 return flattenWithMeta(options,budget).prompt;
}
const blockText=c=>typeof c==='string'?c:Array.isArray(c)?c.filter(b=>b?.type==='text').map(b=>b.text??'').join('\n'):'';
const finiteNumber=v=>typeof v==='number'&&Number.isFinite(v)?v:undefined;
// Host usage events split input into uncached / cache-read / cache-write parts.
function hostUsageTokens(usage){
 if(!usage||typeof usage!=='object')return null;
 const input=[usage.inputTokens,usage.cacheReadTokens,usage.cacheWriteTokens].map(finiteNumber).filter(v=>v!==undefined);
 const output=finiteNumber(usage.outputTokens);
 if(!input.length&&output===undefined)return null;
 return {inputTokens:input.length?input.reduce((a,b)=>a+b,0):undefined,outputTokens:output,reasoningTokens:finiteNumber(usage.reasoningTokens),tokenSource:'actual'};
}
/** Wraps a proxied llm.stream so calls that bypass hub.call still reach the usage store. */
export function meterStream(record,platform){
 return (source,options={})=>(async function*(){
  const started=Date.now(),system=blockText(options.system??options.systemPrompt??''),history=(options.messages??[]).map(m=>blockText(m?.content)).join('\n');
  let firstText=null,output='',usage=null,status=null,completed=false;
  try{
   for await(const event of await source){
    if(event?.type==='text-delta'&&typeof event.text==='string'){if(firstText===null)firstText=Date.now();output+=event.text;}
    else if(event?.type==='tool-call-delta'&&typeof event.argumentsDelta==='string'){if(firstText===null)firstText=Date.now();output+=event.argumentsDelta;}
    else if(event?.type==='usage')usage=event.usage;
    else if(event?.type==='finish')status=event.reason?.kind==='stop'||event.reason?.kind==='tool-calls'?'ok':event.reason?.kind==='aborted'?'aborted':'error';
    yield event;
   }
   completed=true;
  }catch(error){status=options.signal?.aborted?'aborted':'error';throw error;}
  finally{
   const tokens=hostUsageTokens(usage);
   const meta=options.inputMeta;
   try{record({platform,providerId:platform,model:String(options.model?.id??options.model??''),effort:options.reasoningEffort,channel:'chat',source:'adapter',status:status??(completed?'ok':'aborted'),latencyMs:Date.now()-started,ttftMs:firstText===null?undefined:firstText-started,inputChars:meta?.inputChars??(system.length+history.length),inputBudget:meta?.inputBudget,omittedChars:meta?.omittedChars??0,systemChars:meta?.systemChars??system.length,historyChars:meta?.historyChars??history.length,outputChars:output.length,...(tokens??{tokenSource:'estimated',inputText:meta?.prompt??(system+history),outputText:output})});}catch{}
  }
 })();
}
const CLI_PROVIDERS=new Set([...PLATFORMS,'openai-codex','workbuddy']);
/** Hub-managed and CLI providers are metered by their adapters, never from session events. */
export function nativeUsagePlatform(provider){
 const id=typeof provider==='string'?provider:'';
 if(!id||CLI_PROVIDERS.has(id))return null;
 return id.startsWith('deepseek')?'deepseek':'custom';
}
/** Maps live `session/event` request headers and assistant messages to usage records. */
export function createSessionUsage(record,{now=()=>Date.now()}={}){
 // Events older than activation are history replays and must not be counted again.
 const startedAt=now(),headers=new Map(),seen=new Map();
 return {
  event(session,event){
   const id=typeof session?.id==='string'?session.id:'';
   if(!id||!event||typeof event.type!=='string')return;
   const time=finiteNumber(event.time);
   if(time!==undefined&&time<startedAt-5000)return;
   if(event.type==='request/header'){
    const config=event.data?.header?.config;
    if(config&&typeof config==='object')headers.set(id,{provider:typeof config.provider==='string'?config.provider:'',model:typeof config.model==='string'?config.model:'',effort:typeof config.reasoningEffort==='string'&&config.reasoningEffort?config.reasoningEffort:undefined,at:time});
    return;
   }
   if(event.type!=='assistant/message')return;
   const key=id+':'+String(event.seq??time??'');
   if(seen.has(key))return;
   seen.set(key,true);if(seen.size>5000)seen.delete(seen.keys().next().value);
   const header=headers.get(id);
   const platform=nativeUsagePlatform(header?.provider);
   if(!platform||!header.model)return;
   const data=event.data??{};
   const stop=String(data.stopReason??data.finishReason??'');
   record({at:time??now(),platform,providerId:header.provider,model:header.model,effort:header.effort,channel:'native',source:'session',
    status:/abort|cancel/i.test(stop)?'aborted':/error|fail/i.test(stop)?'error':'ok',
    latencyMs:header.at!==undefined&&time!==undefined&&time>=header.at?time-header.at:undefined,
    inputChars:0,inputCharsUnknown:true,outputChars:blockText(data.content??data.message?.content).length,
    ...(hostUsageTokens(data.usage??data.message?.usage)??{tokenSource:'unknown'})});
   header.at=undefined;
  },
  dispose(id){headers.delete(id);}
 };
}
/** Usage lives in a data file: editing plugin config would restart the plugin. */
export function usageFilePath(env=process.env,ctx){
 if(env.DSH_AI_HUB_USAGE_FILE)return env.DSH_AI_HUB_USAGE_FILE;
 const profile=env.DSH_PROFILE_DIR||(env.DSH_PROFILE?join(homedir(),'.dsh','profiles',env.DSH_PROFILE):'');
 if(profile)return join(profile,'data','dsh-ai-hub','usage.json');
 try{
  const homePath=ctx&&typeof ctx.get==='function'?ctx.get('dshHomePath'):null;
  if(typeof homePath==='function')return homePath('data','dsh-ai-hub','usage.json');
 }catch{}
 return join(env.DSH_HOME||join(homedir(),'.dsh'),'data','dsh-ai-hub','usage.json');
}
export function createHub({config={},save,workspaces,scratch,catalogUpstream,creditsWorkbuddy,callWorkbuddy,workbuddyAuth,loadModels,usage,processRunner=runProcess,cliDetect=detect,cliCaller=cliCall,loadCodexModels=codexModels,mcpSpawn}={}){
 let settings=normalizeSettings(config.platforms),disposed=false,settingsQueue=Promise.resolve();
 const lifetime=new AbortController();
 const settingsListeners=new Set();
 const states=new Map(),quotas=new Map(),catalogs=new Map(),catalogPending=new Map(),active=new Set(),pending=new Map();
 const valid=p=>{if(!PLATFORMS.includes(p))throw new Error('Unknown platform / 未知平台');return p;};
 const enabled=p=>{valid(p);if(disposed)throw new Error('Hub disposed');if(!settings[p].enabled)throw new Error('DISABLED / 平台已禁用');};
 const recordUsage=event=>{try{usage?.record(event);}catch{}};
 const mcpBridge=createMcpBridge({cliDetect,...(mcpSpawn?{spawnProcess:mcpSpawn}:{}),...(scratch?{scratch}:{}),resolveModelId:async(p,m,effort)=>m&&(p==='cursor'||p==='antigravity')?resolveVariant(await catalog(p),m,effort):m,resolveEnv:async p=>p==='workbuddy-cn'&&workbuddyAuth?{CODEBUDDY_AUTH_TOKEN:await workbuddyAuth()}:undefined,onState:(p,next)=>states.set(p,{...states.get(p),...next})});
 async function tracked(p,fn){enabled(p);const start=Date.now();states.set(p,{...states.get(p),state:'testing'});try{const result=await fn();states.set(p,{state:'connected',checkedAt:new Date().toISOString(),latencyMs:Date.now()-start,lastError:null});return result;}catch(e){states.set(p,{state:'error',checkedAt:new Date().toISOString(),latencyMs:Date.now()-start,lastError:failure(e)});throw e;}}
 async function catalog(p,refresh=false){valid(p);if(!settings[p].enabled)return [];const cached=catalogs.get(p);if(!refresh&&cached&&(cached.error?Date.now()-(cached.attemptedAt??0)<QUOTA_RETRY:Date.now()-cached.at<600000))return cached.models;
  // DSH resolves every model of a provider concurrently. Share one CLI catalog load
  // instead of spawning a CLI process per model (Cursor exposes 270 models).
  if(catalogPending.has(p))return catalogPending.get(p);
  const task=loadCatalog(p,refresh);catalogPending.set(p,task);
  try{return await task;}finally{if(catalogPending.get(p)===task)catalogPending.delete(p);}
 }
 async function loadCatalog(p,refresh){const cached=catalogs.get(p);let models=[];
  try{
   if(loadModels) models=await loadModels(p,lifetime.signal);
   else if(p==='cursor'||p==='antigravity') {
    const cli=cliDetect(p);
    const result=await processRunner({command:cli.command,args:[...cli.prefix,'models']},{timeoutMs:25000,signal:lifetime.signal,cwd:scratch});
    const discovered=parseCliModels(result.stdout,p);
    if((result.code!==0||!discovered.length)&&/please sign in|sign in to view|not logged|unauthorized|authentication required/i.test(result.stdout+result.stderr))throw new Error('AUTH_BOUNDARY: '+p+' CLI 需要登录，请在登录终端完成授权');
    if(result.code!==0)throw new Error(p+': model catalog unavailable / CLI 模型目录读取失败');
    models=discovered;
   }
   else if(p==='workbuddy-cn')models=catalogUpstream?await catalogUpstream():await cnModels(lifetime.signal);
   else if(p==='codex')models=await loadCodexModels(lifetime.signal,scratch);
   models=normalizeModels(models,p);
   if(p==='codex'&&loadModels&&!models.length){
    models=normalizeModels(await loadCodexModels(lifetime.signal,scratch),p);
   }
   if(!models.length)throw new Error(p+': upstream returned no models / 上游未返回模型目录');
   models=withVariantReasoning(models,p);
 if(EFFORTS[p])models=models.map(model=>withReasoning(p,model));
   catalogs.set(p,{at:Date.now(),attemptedAt:Date.now(),models});states.set(p,{...states.get(p),catalogError:null});return models;
  }catch(e){states.set(p,{...states.get(p),catalogError:failure(e)});catalogs.set(p,{at:cached?.at??0,attemptedAt:Date.now(),models:cached?.models??[],error:failure(e)});return cached?.models??[];}
 }
 async function visibleModels(p){valid(p);return collapseModels(selectModels(await catalog(p),settings[p].visibleModels).models);}
 async function catalogInfo(p,refresh=false){
  const models=await catalog(p,refresh),cached=catalogs.get(p),selection=selectModels(models,settings[p].visibleModels);
  return {models:collapseModels(models),visibleModels:projectSelection(models,settings[p].visibleModels),recommendedModels:p==='cursor'?projectSelection(models,recommendedModels(models)):[],at:cached?.at?new Date(cached.at).toISOString():null,stale:Boolean(cached?.error),error:cached?.error??null,
   selectionWarning:selection.missing.length?{missing:selection.missing,fallback:selection.fallback}:null};
 }
 // `channel` selects CLI permissions (model/subagent); `usageChannel` overrides the metered channel, e.g. test.
 async function call(p,prompt,{channel='model',usageChannel,model,signal,cwd,onText,reasoningEffort,inputMeta}={}){
  enabled(p);
  const started=Date.now(),input=String(prompt??'');
  let firstToken=null,streamed='';
  const controller=new AbortController();const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();active.add(controller);
  const emit=text=>{if(firstToken===null)firstToken=Date.now();streamed+=text;onText?.(text);};
  let resolvedModel=model;
  const meter=(status,output)=>recordUsage({platform:p,providerId:p,model:resolvedModel??'平台自动选择',requestedModel:model,effort:reasoningEffort,channel:usageChannel??(channel==='subagent'?'subagent':'chat'),source:'adapter',status,latencyMs:Date.now()-started,ttftMs:firstToken===null?undefined:firstToken-started,inputChars:inputMeta?.inputChars??input.length,inputBudget:inputMeta?.inputBudget,omittedChars:inputMeta?.omittedChars??0,systemChars:inputMeta?.systemChars??0,historyChars:inputMeta?.historyChars??input.length,outputChars:output.length,tokenSource:'estimated',inputText:input,outputText:output});
  try{
   if(model&&(p==='cursor'||p==='antigravity'))resolvedModel=resolveVariant(await catalog(p),model,reasoningEffort);
   const result=await tracked(p,()=>p==='workbuddy-cn'?(callWorkbuddy?callWorkbuddy(prompt,resolvedModel,{signal:controller.signal,onText:emit,reasoningEffort}):cnCall(prompt,resolvedModel??'auto',{signal:controller.signal,onText:emit})):cliCaller(p,prompt,resolvedModel,{channel,signal:controller.signal,cwd:cwd??scratch,onText:emit,reasoningEffort,timeoutMs:120000}));
   meter('ok',typeof result?.text==='string'?result.text:streamed);
   return result;
  }catch(error){
   meter(controller.signal.aborted?'aborted':'error',streamed);
   throw error;
  }finally{signal?.removeEventListener('abort',abort);active.delete(controller);}
 }
 async function quota(p,refresh=false){
  valid(p);
  if(pending.has(p))return pending.get(p);
  const old=quotas.get(p);
  const lastAttempt=Date.parse(old?.attemptedAt || old?.updatedAt);
  if(!refresh&&old&&Date.now()-lastAttempt<(old.error?QUOTA_RETRY:QUOTA_TTL))return clone(old);
  const request=(async()=>{const q={platform:p,kind:'unknown',source:'unavailable',updatedAt:null,stale:false};try{
   enabled(p);
   if(p==='cursor'){
    q.source='cursor-dashboard';
    const windows=await cursorQuota(lifetime.signal);
    Object.assign(q,{kind:'window',windows});
   }
   if(p==='antigravity'){
    Object.assign(q,{source:'antigravity-cli',modelCount:catalogs.get(p)?.models.length});
    const cli=cliDetect(p);
    const result=await processRunner({command:cli.command,args:[...cli.prefix,'--print','/usage','--output-format','text']},{timeoutMs:20000,signal:lifetime.signal,cwd:scratch});
    const windows=result.code===0?parseAntigravityUsage(result.stdout):[];
    if(!windows.length){
     if(/please sign in|sign in to|authentication required|unauthorized|login required|unauthenticated/i.test(result.stdout+result.stderr))throw new Error('AUTH_BOUNDARY: Antigravity CLI 需要登录');
     if(catalogs.get(p)?.error?.code==='AUTH')throw new Error('AUTH_BOUNDARY: Antigravity CLI 需要登录');
     if(!old){
      const recentCatalog=catalogs.get(p);
      const justChecked=recentCatalog&&Date.now()-(recentCatalog.attemptedAt??recentCatalog.at??0)<5000;
      q.modelCount=(await catalog(p,justChecked?false:refresh)).length;
      if(catalogs.get(p)?.error?.code==='AUTH')throw new Error('AUTH_BOUNDARY: Antigravity CLI 需要登录');
     }
     throw new Error('Antigravity 未返回可读取的额度');
    }
    Object.assign(q,{kind:'window',windows});
   }
   if(p==='codex'){const raw=await codexQuota(lifetime.signal,scratch);const r=raw.rateLimits??{};const windows=[];for(const [id,w] of Object.entries({primary:r.primary,secondary:r.secondary})){if(!w)continue;windows.push({id:w.windowDurationMins===300?'5h':w.windowDurationMins===10080?'weekly':id,usedPercent:w.usedPercent,windowDurationMins:w.windowDurationMins,resetAt:w.resetsAt?new Date(w.resetsAt*1000).toISOString():null});}Object.assign(q,{kind:'window',source:raw.source||'codex-app-server',windows,plan:r.planType,resetCredits:raw.rateLimitResetCredits?.availableCount??r.rateLimitResetCredits?.availableCount??null});}
   if(p==='workbuddy-cn'){Object.assign(q,{kind:'credits',source:'workbuddy-cn-billing-api',region:'cn',credits:{remaining:null,multiplier:null}});if(creditsWorkbuddy){const c=await creditsWorkbuddy(lifetime.signal);q.credits={remaining:c.remaining??null,multiplier:c.multiplier??null};q.note=c.remaining==null?'cn-auth-unavailable':null;}else{Object.assign(q,{note:'cn-auth-unavailable'});q.credits=await cnCredits(lifetime.signal);q.source='workbuddy-cn-billing-api';}}
   q.updatedAt=new Date().toISOString();
   quotas.set(p,q);return clone(q);
  }catch(e){const result={...q,...old,modelCount:q.modelCount??old?.modelCount,stale:Boolean(old&&old.kind!=='unknown'),attemptedAt:new Date().toISOString(),error:failure(e)};quotas.set(p,result);return clone(result);}})();pending.set(p,request);try{return await request;}finally{pending.delete(p);}
 }
 const hub={
  settings:()=>clone(settings),
  updateSettings(patch){const operation=async()=>{if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('Invalid settings');for(const [p,v]of Object.entries(patch)){valid(p);if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Invalid platform settings');for(const k of Object.keys(v))if(!['enabled','visibleModels',...(p==='workbuddy-cn'?['region','showCredits']:[])].includes(k))throw new Error(`Unknown setting: ${k}`);if(v.region!==undefined&&v.region!=='cn')throw new Error('CN only');if(v.showCredits!==undefined&&typeof v.showCredits!=='boolean')throw new Error('Invalid showCredits');if(v.enabled!==undefined&&typeof v.enabled!=='boolean')throw new Error('Invalid enabled');if(v.visibleModels!==undefined&&(!Array.isArray(v.visibleModels)||v.visibleModels.some(x=>typeof x!=='string'||x.length>160||x.startsWith('-'))))throw new Error('Invalid visibleModels');}
   const candidate=normalizeSettings(Object.fromEntries(PLATFORMS.map(p=>[p,{...settings[p],...patch[p]}])));if(!save)throw new Error('Config editor unavailable / 无法持久化设置');await save(candidate);settings=candidate;for(const listener of settingsListeners) {try{listener();}catch{}}return hub.settings();};const result=settingsQueue.then(operation);settingsQueue=result.catch(()=>{});return result;},
  status(p){valid(p);let available=false;try{detect(p);available=true;}catch{}return {platform:p,enabled:settings[p].enabled,available,...(states.get(p)??{}),state:settings[p].enabled?(states.get(p)?.state??'unknown'):'disabled',modelChannel:['workbuddy-cn','cursor','antigravity'].includes(p)?'tools':'text',subagentChannel:p==='workbuddy-cn'?'text':p==='codex'?'builtin':'cli'};},
  quota,catalog,catalogInfo,visibleModels,call,
  hasMcpSession(messages){return mcpBridge.hasSuspendedSessionFor(messages);},
  async *mcpStream(p,options={}){
   enabled(p);
   const requested=typeof options.model==='string'?options.model:options.model?.id;
   const resuming=mcpBridge.hasSuspendedSessionFor(options.messages);
   const resolved=requested&&!resuming&&(p==='cursor'||p==='antigravity')?resolveVariant(await catalog(p),requested,options.reasoningEffort):requested;
   let flat;
   if(resuming){
    const pending=extractPendingToolResults(options.messages);
    const parts=pending?[...[...pending.resultsById.values()].map(r=>r.content),...(pending.trailingText?[pending.trailingText]:[])]:[];
    const text=parts.join('\n');
    flat={prompt:text,inputChars:text.length,systemChars:0,historyChars:text.length,omittedChars:0};
   }else{
    flat=formatMcpPrompt(options);
   }
   yield* meterStream(recordUsage,p)(mcpBridge.stream(p,{...options,model:resolved??requested}),{...options,model:resolved??requested??'平台自动选择',inputMeta:flat});
  },
  onSettingsChanged(listener){settingsListeners.add(listener);return ()=>settingsListeners.delete(listener);},
  async test(p,channel='model',options={}){valid(p);if(!['model','subagent'].includes(channel))throw new Error('Invalid channel');const at=new Date().toISOString();try{const r=await call(p,'Reply with exactly OK. Do not use tools or access files.',{channel,usageChannel:'test',...options});return {ok:r.text.trim()==='OK',platform:p,channel,answer:safe(r.text),at,...hub.status(p),warning:r.warning};}catch(e){states.set(p,{...states.get(p),state:'error',lastError:failure(e)});return {ok:false,platform:p,channel,at,error:failure(e),...hub.status(p)};}},
  async projects(){if(!workspaces) return {projects:[],error:'DSH workspace service unavailable / 无法读取项目列表'};return workspaces();},
  platformSnapshot(){return {settings:hub.settings(),platforms:PLATFORMS.map(p=>({...hub.status(p),quota:quotas.get(p)??null,models:catalogs.get(p)?.models??[]}))};},
  async snapshot(){await Promise.all(PLATFORMS.filter(p=>settings[p].enabled).map(p=>quota(p)));return {...hub.platformSnapshot(),projects:await hub.projects()};},
  usageSnapshot(options={}){return (usage??createUsageStore()).snapshot(options);},
  usageReset(platform){return (usage??createUsageStore()).reset(platform);},
  usageFlush(){return usage?usage.flush():Promise.resolve();},
  dispose(){disposed=true;settingsListeners.clear();lifetime.abort();for(const c of active)c.abort();mcpBridge.dispose();usage?.dispose?.();}
 };return hub;
}
export function createAdapter(hub,platform){
 const resolve=async(provider,id)=>{
  let info=null;
  try{info=(await hub.catalog(platform)).find(model=>model.id===id)??null;}catch{}
  return {provider,id,name:info?.name??id,context:{contextWindow:info?.contextWindow??200000},defaultMaxTokens:info?.maxOutput??32768,inputModalities:info?.inputModalities??['text'],...(info?.reasoning?{reasoning:info.reasoning}:{})};
 };
 async function* stream(options){
  const useMcp=(platform==='cursor'||platform==='antigravity')&&typeof hub.mcpStream==='function'&&((Array.isArray(options?.tools)&&options.tools.length>0)||Boolean(hub.hasMcpSession?.(options?.messages)));
  if(useMcp){
   try{yield* hub.mcpStream(platform,options);}
   catch(e){yield {type:'finish',reason:options?.signal?.aborted?{kind:'aborted'}:{kind:'error',failure:failure(e)}};}
   return;
  }
  const queue=[];let wake,done=false,error,answer='';const controller=new AbortController();const upstream=options.signal;const abort=()=>controller.abort();upstream?.addEventListener('abort',abort,{once:true});if(upstream?.aborted)controller.abort();const emit=t=>{if(!answer)queue.push({type:'block-start',index:0,blockType:'text'});answer+=t;queue.push({type:'text-delta',index:0,text:t});wake?.();};
  const flat=flattenWithMeta(options);
  const task=Promise.resolve().then(()=>hub.call(platform,flat.prompt,{model:typeof options.model==='string'?options.model:options.model?.id,signal:controller.signal,onText:emit,reasoningEffort:options.reasoningEffort,inputMeta:flat})).catch(e=>{error=e;}).finally(()=>{done=true;wake?.();});
  try{while(!done||queue.length){if(queue.length){yield queue.shift();continue;}await new Promise(r=>{wake=r;});wake=null;}if(answer)yield {type:'block-end',index:0,block:{type:'text',text:answer}};yield {type:'finish',reason:controller.signal.aborted?{kind:'aborted'}:error?{kind:'error',failure:failure(error)}:{kind:'stop'}};}finally{controller.abort();upstream?.removeEventListener('abort',abort);await task;}
 }
 return {providerInfo:()=>({id:platform,name:NAMES[platform]}),providerRetryPolicy:()=>undefined,imageRequestPricing:()=>undefined,imageRequestTarget:(_p,_m,i)=>({width:i.width,height:i.height,maxBytes:i.bytes}),listModels:()=>hub.visibleModels(platform),resolveModel:resolve,prepareCall:async(p,m,signal)=>{signal?.throwIfAborted();return {model:await resolve(p,m),stream:o=>stream({...o,model:m,signal:o.signal??signal})};},stream};
}
export function createSubagent(hub,platform){return {name:platform==='workbuddy-cn'?'workbuddy':platform,capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false},inheritsParentContext:false,async start(request){if(!Array.isArray(request.prompt)||request.prompt.some(b=>b.type!=='text'))throw new Error('Only text tasks supported');const controller=new AbortController();const abort=()=>controller.abort();request.signal?.addEventListener('abort',abort,{once:true});if(request.signal?.aborted)controller.abort();const id=randomUUID();const result=hub.call(platform,request.prompt.map(b=>b.text).join('\n'),{channel:'subagent',signal:controller.signal,cwd:request.cwd??request.parent?.cwd}).then(r=>({output:[{type:'text',text:r.text}],stopReason:'completed'}),e=>({output:[{type:'text',text:failure(e).message}],diagnostic:failure(e).message,stopReason:controller.signal.aborted?'aborted':'error'})).finally(()=>request.signal?.removeEventListener('abort',abort));return {id,result,async dispose(){controller.abort();await result;}};}};}
export function apply(ctx,config={}){
 for(const [file,type] of Object.entries({'deepseek.ico':'image/x-icon','workbuddy.svg':'image/svg+xml','cursor.svg':'image/svg+xml','codex.png':'image/png','antigravity.svg':'image/svg+xml'})){
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/plugins/dsh-ai-hub/assets/platforms/'+file,handler:async(req,res)=>{
   if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'allow':'GET, HEAD'});return res.end();}
   try{const bytes=await readFile(new URL('./assets/platforms/'+file,import.meta.url));res.writeHead(200,{'content-type':type,'content-length':bytes.length,'cache-control':'public, max-age=3600','x-content-type-options':'nosniff'});res.end(req.method==='HEAD'?undefined:bytes);}catch{res.writeHead(404);res.end();}
  }}));
 }
 const editor=ctx.get('configEditor');const entry=ctx.fiber?.entry;
 const usagePath=usageFilePath(process.env,ctx);
 const usageBackend=usagePath?createFileBackend(usagePath):null;
 const loaded=usageBackend?.load();
 // Config `aiHubUsage` from 0.5.0 is read once as a migration seed and never written back.
 const usageStore=createUsageStore({
  initial:loaded?.status==='ok'?loaded.value:!usageBackend||loaded?.status==='missing'?config.aiHubUsage:undefined,
  persist:usageBackend?state=>usageBackend.save(state):undefined,
  persistence:'file'
 });
 if(loaded?.status==='missing'&&config.aiHubUsage)usageStore.flush({force:true});
 ctx.effect(()=>()=>usageStore.dispose());
 if(typeof ctx.on==='function')ctx.effect(()=>{
  const sessions=createSessionUsage(input=>usageStore.record(input));
  const offEvent=ctx.on('session/event',(session,event)=>{try{sessions.event(session,event);}catch{}});
  const offDisposed=ctx.on('session/disposed',session=>{try{sessions.dispose(session?.id);}catch{}});
  return ()=>{offEvent?.();offDisposed?.();};
 });
 const registered=(()=>{try{return new Set(ctx.llm.listProviders().map(row=>row.id));}catch{return new Set();}})();
 const codexUpstream=registered.has('codex')?'codex':registered.has('openai-codex')?'openai-codex':null;
 const workbuddy=createWorkbuddy({credentials:ctx.get('credentials')});
 const readCliCatalog=async(p,signal)=>{const cli=detect(p);const result=await runProcess({command:cli.command,args:[...cli.prefix,'models']},{signal,timeoutMs:25000});if(result.code!==0||/not logged|unauthorized|authentication required/i.test(result.stdout+result.stderr))throw new Error(p+': model catalog unavailable');return parseCliModels(result.stdout,p);};
 // No profile access: persistence is exclusively delegated to the official editor.
 const hub=createHub({config,usage:usageStore,save:editor&&entry!==undefined?platforms=>editor.edit(entry,current=>({...current,platforms})):undefined,
  catalogUpstream:async()=> (await workbuddy.listModels()).models,
  ...(codexUpstream?{loadModels:async(p,signal)=>p==='codex'?ctx.llm.listModels(codexUpstream):p==='workbuddy-cn'?(await workbuddy.listModels()).models:await readCliCatalog(p,signal)}:{}),
  callWorkbuddy:(prompt,model,options)=>workbuddy.chat(prompt,model,options),
  workbuddyAuth:()=>workbuddy.accessToken(),
  creditsWorkbuddy:async()=>{try{const value=await workbuddy.credits();return {remaining:value.remaining,multiplier:null};}catch{return {remaining:null,multiplier:null};}},
  workspaces:async()=>{const service=ctx.get('workspaceRegistry');if(!service||typeof service.list!=='function')return {projects:[],error:'DSH workspaceRegistry service unavailable'};const rows=await service.list();const list=Array.isArray(rows)?rows:rows?.workspaces;if(!Array.isArray(list))return {projects:[],error:'Unsupported workspace list response'};return {projects:list.map(w=>({id:String(w.id??w.path),name:String(w.title??w.path??w.id),path:w.path??null,sessionCount:w.sessionIds?.length??0}))};}});
 ctx.effect(()=>{const release=ctx.provide('aiHub',hub);return ()=>{hub.dispose();return release();};});
 const handles=new Map();
 const register=(p,adapter)=>ctx.effect(()=>{const handle=ctx.llm.registerAdapter([p],adapter);handles.set(p,handle);return ()=>{handles.delete(p);handle();};});
 for(const p of ['cursor','antigravity','workbuddy-cn']){
  // Preserve existing owners: registering over them makes Harness reject activation.
  if(!registered.has(p)) {
   register(p,p==='workbuddy-cn'?createWorkbuddyAdapter({hub,client:workbuddy,provider:p,name:NAMES[p],meter:meterStream(input=>usageStore.record(input),p)}):createAdapter(hub,p));
   if(typeof ctx.llm.registerConfigurableProviders==='function')ctx.effect(()=>ctx.llm.registerConfigurableProviders([{provider:p,displayName:NAMES[p],settingsNs:'dsh-ai-hub',settingsPath:[],declared:false}]));
  }
  if(hub.settings()[p].enabled)ctx.effect(()=>ctx.subagents.registerProvider(createSubagent(hub,p)));
 }
 if(!registered.has('codex')){
  register('codex',codexUpstream?createProxyAdapter(ctx.llm,hub,'codex',codexUpstream,'Codex',meterStream(input=>usageStore.record(input),'codex')):createAdapter(hub,'codex'));
  if(typeof ctx.llm.registerConfigurableProviders==='function')ctx.effect(()=>ctx.llm.registerConfigurableProviders([{provider:'codex',displayName:'Codex',settingsNs:'dsh-ai-hub',settingsPath:[],declared:false}]));
 }
 // Same-route replacement is the public Harness notification mechanism. It
 // refreshes native model pickers after visibility/enabled settings are saved.
 ctx.effect(()=>hub.onSettingsChanged(()=>{for(const [provider,handle] of handles)handle.replace?.([provider]);}));
  const p0=createP0({
    config: config.aiHubP0 ?? {},
    save: async state => {
      if (!editor || entry === undefined) throw new Error('Config editor unavailable / 无法持久化账号');
      await editor.edit(entry, current => ({ ...current, aiHubP0: state }));
    },
    credentials: ctx.get('credentials'),
    webServer: ctx.webServer,
    onUsage: event => usageStore.record(fromGatewayRecord(event)),
    readUsage: limit => usageStore.snapshot({ range: 'all', channel: 'gateway', limit }).recent.map(toGatewayRecord)
  });
  // Gateway records used to live only in p0 memory; import any the store has not seen.
  usageStore.backfill(p0.memoryUsage().map(fromGatewayRecord).filter(Boolean));
  ctx.effect(() => () => p0.dispose());
  ctx.effect(() => ctx.provide('aiHubP0', p0.service));
  const deepseekAccountSnapshot=async()=>{
  const account=ctx.get('deepseekAccount');
  if(!account) return {available:false,signedOut:true,error:'DSH DeepSeek account service unavailable'};
  const client={version:'0.2.2-rc.1',locale:'zh-CN',timezoneOffsetSeconds:-new Date().getTimezoneOffset()*60};
  let state=null,profile=null,balance=null,models=[];
  try{state=await account.getState();}catch(error){return {available:true,signedOut:true,error:failure(error),state:null};}
  const signedIn=state?.status==='credential-stored';
  if(signedIn){
   try {
    const result = await account.getProfile(client);
    if (result?.status === 'ready' && result.value) {
     const { name, contact, id, avatarUrl } = result.value;
     const identity = publicAccountIdentity({ name, contact: contact || id, avatarUrl });
     profile = { status: 'ready', value: { name: identity.name, contact: identity.account, avatarUrl: identity.avatarUrl } };
    } else if (result?.status === 'failed') profile = { status: 'failed' };
   } catch {}
   try{balance=await account.getBalance(client);}catch(error){balance={error:failure(error)};}
   try{models=await ctx.llm.listModels('deepseek-account');}catch{}
  }
  return {available:true,signedOut:!signedIn,state,profile,balance,models,links:state?.links??null};
 };
 const loginActions=createLoginActions({getAccount:()=>ctx.get('deepseekAccount'),getOrigin:()=>ctx.webServer.getOrigin(),detectCLI:detect});
 const jsonSafe=value=>JSON.parse(JSON.stringify(value));
 const readPlatformAccount = async (p, signal) => {
   if (!['cursor','codex'].includes(p) || !hub.settings()[p].enabled) return null;
   if (p === 'cursor') {
    const profile = await cursorAccount(signal);
    const name = [profile.firstName, profile.lastName].filter(value => typeof value === 'string').join(' ');
    return publicAccountIdentity({ name, contact: profile.email, avatarUrl: profile.profilePictureUrl });
   }
   const { account } = await codexAccount(signal);
   return account?.type === 'chatgpt' ? publicAccountIdentity({ contact: account.email }) : null;
 };
 const dashboardFile = usagePath ? createFileBackend(join(dirname(usagePath), 'dashboard.json')) : null;
 const savedDashboard = dashboardFile?.load();
 const dashboard = {version:1, platformAccounts:{}, accountErrors:{}, catalogs:{}, quotas:{},
  ...(savedDashboard?.status === 'ok' && savedDashboard.value?.version === 1 ? savedDashboard.value : {})};
 const dashboardSnapshot = () => {
  const snapshot = hub.platformSnapshot();
  snapshot.platforms = snapshot.platforms.map(row => ({
   ...row,
   quota: row.enabled ? dashboard.quotas[row.platform] ?? row.quota : null
  }));
  return {...dashboard, snapshot};
 };
 const cacheDeepseek = value => {
  const {state, links, ...publicData} = value;
  dashboard.deepseek = publicData.error && dashboard.deepseek
   ? {...dashboard.deepseek, error:publicData.error} : {...publicData, updatedAt:new Date().toISOString()};
  return value;
 };
 const cacheWorkbuddy = value => {
  dashboard.workbuddy = value;
  return value;
 };
 let activeRefresh, dashboardStopped = false;
 const dashboardAbort = new AbortController();
 const refreshDashboard = (force = false, selected) => {
  if (dashboardStopped) return dashboardSnapshot();
  if (activeRefresh) {
   if (!force || activeRefresh.force && activeRefresh.selected === selected) return activeRefresh.promise;
   return activeRefresh.promise.then(() => refreshDashboard(force, selected));
  }
  const jobs = [];
  if (!selected || selected === 'deepseek') jobs.push(deepseekAccountSnapshot().then(cacheDeepseek));
  const settings = hub.settings();
  for (const p of selected ? [selected] : PLATFORMS) {
   if (!settings[p]?.enabled) continue;
   if (p === 'workbuddy-cn') jobs.push(workbuddy.snapshot().then(value => {
    cacheWorkbuddy(value);
    dashboard.quotas[p] = {kind:'credits', source:'workbuddy-cn-billing-api',
     credits:{remaining:value.credits?.remaining ?? null}, updatedAt:new Date().toISOString(),
     ...(value.error ? {error:failure(value.error)} : {})};
   }));
   else jobs.push(hub.quota(p, force).then(value => {
    const last = dashboard.quotas[p];
    dashboard.quotas[p] = value.error && value.kind === 'unknown' && last?.kind !== 'unknown' && last
     ? {...last, error:value.error, attemptedAt:value.attemptedAt, stale:true} : value;
   }));
   jobs.push(hub.catalogInfo(p, force).then(value => {
    const last = dashboard.catalogs[p];
    dashboard.catalogs[p] = value.error && !value.models.length && last?.models.length
     ? {...last, error:value.error, stale:true} : value;
   }));
   if (p === 'workbuddy-cn') jobs.push(workbuddy.checkinStatus(dashboardAbort.signal)
    .then(value => {dashboard.workbuddyCheckin = value;})
    .catch(error => {dashboard.workbuddyCheckin = {error:failure(error)};}));
   if (p === 'cursor' || p === 'codex') jobs.push(readPlatformAccount(p, dashboardAbort.signal)
    .then(value => {
     dashboard.platformAccounts[p] = value;
     delete dashboard.accountErrors[p];
    })
    .catch(error => {
     const reason = failure(error);
     dashboard.accountErrors[p] = reason;
     if (reason.code === 'AUTH') dashboard.platformAccounts[p] = null;
    }));
  }
  const promise = Promise.allSettled(jobs).then(async () => {
   if (!dashboardStopped) {
    if (!selected) dashboard.updatedAt = new Date().toISOString();
    await dashboardFile?.save(dashboard).catch(() => {});
   }
   return dashboardSnapshot();
  }).finally(() => {activeRefresh = null;});
  activeRefresh = {force, selected, promise};
  return promise;
 };
 ctx.effect(() => {
  const start = setTimeout(() => refreshDashboard(true), 0);
  const timer = setInterval(() => refreshDashboard(), 5 * 60_000);
  start.unref?.();
  timer.unref?.();
  return () => {
   dashboardStopped = true;
   clearTimeout(start);
   clearInterval(timer);
   dashboardAbort.abort();
  };
 });
 const dispatch=async (args,signal)=>{
  const p=args.platform;
  if (args.action === 'dashboard') return dashboardSnapshot();
  if (args.action === 'refreshDashboard') {
   if (p !== undefined && p !== 'deepseek' && !PLATFORMS.includes(p)) throw new Error('Unknown platform');
   return refreshDashboard(true,p);
  }
  if (args.action === 'snapshot' && args.platformsOnly === true) return hub.platformSnapshot();
  if (args.action === 'platformAccount') return readPlatformAccount(p,signal);
  if (args.action === 'deepseekAccount') return cacheDeepseek(await deepseekAccountSnapshot());
  if (args.action === 'workbuddySnapshot') return cacheWorkbuddy(await workbuddy.snapshot());
  if (args.action === 'workbuddyCheckin') {
   if (!hub.settings()['workbuddy-cn'].enabled) throw new Error('WorkBuddy 已停用');
   const result = await workbuddy.claimCheckin(signal);
   dashboard.workbuddyCheckin = result;
   return result;
  }
  if (typeof args.action === 'string' && args.action.startsWith('p0')) return p0.dispatch(args.action, args);
  switch(args.action){case 'nativeProviders':return nativeProviderSnapshot({llm:ctx.llm,settings:ctx.get('settings'),credentials:ctx.get('credentials')});case 'deepseekLoginStart':return loginActions.startDeepseek(args.switchAccount === true);case 'deepseekLoginCancel':return loginActions.cancelDeepseek(args.attemptId);case 'platformLogin':return loginActions.openPlatform(args.platform, args.switchAccount === true);case 'llmProviders':return ctx.llm.listProviders();case 'llmModels':{const provider=String(args.provider??'');if(!provider)throw new Error('provider required');return ctx.llm.listModels(provider);}case 'llmResolve':{const provider=String(args.provider??'');const model=String(args.model??'');if(!provider||!model)throw new Error('provider and model required');return ctx.llm.resolveModelInfo(provider,model);}case 'llmCatalog':{const providers=ctx.llm.listProviders();const groups=[];const failures=[];await Promise.all(providers.map(async provider=>{try{const models=await ctx.llm.listModels(provider.id);const entries=await Promise.all(models.map(async model=>{let resolved=null;try{resolved=await ctx.llm.resolveModelInfo(provider.id,model.id);}catch{}return {id:model.id,name:model.name??model.id,...(resolved?.reasoning?{reasoning:resolved.reasoning}:{})};}));groups.push({id:provider.id,name:provider.name,models:entries});}catch(error){failures.push({id:provider.id,message:failure(error).message});}}));return {groups,failures};}case 'usageSnapshot':return hub.usageSnapshot({range:args.range,platform:args.platform,channel:args.channel,model:args.model,includeTests:args.includeTests===true,limit:args.limit});case 'usageReset':return hub.usageReset(args.platform);case 'workbuddySnapshot':return workbuddy.snapshot();case 'workbuddyLoginStart':return workbuddy.startLogin();case 'workbuddyLoginPoll':return workbuddy.pollLogin(String(args.loginId??''));case 'workbuddyModels':return workbuddy.listModels();case 'workbuddyCredits':return workbuddy.credits();case 'deepseekAccount':return deepseekAccountSnapshot();case 'snapshot':return hub.snapshot();case 'status':return hub.status(p);case 'quota':return hub.quota(p,Boolean(args.refresh));case 'test':return hub.test(p,args.channel,{signal,reasoningEffort:typeof args.reasoningEffort==='string'?args.reasoningEffort:undefined});case 'settings':return hub.settings();case 'updateSettings':return hub.updateSettings(args.patch);case 'models':return hub.catalogInfo(p,Boolean(args.refresh));case 'projects':return hub.projects();default:throw new Error('Unknown hub action');}
 };
 ctx.effect(()=>ctx.tools.register({name:'hub_manage',description:'Read AI Hub status, quota and settings; refresh quota, test connectivity or update platform settings. Same operations as the office UI.',parameters:{action:{type:'string',required:true,enum:['snapshot','status','quota','test','settings','updateSettings','models','projects']},platform:{type:'string',enum:PLATFORMS},refresh:{type:'boolean'},channel:{type:'string',enum:['model','subagent']},patch:{type:'object',additionalProperties:true}},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},isConcurrencySafe:args=>!['test','updateSettings'].includes(args?.action),execute:(args,exec)=>dispatch(args,exec?.signal).then(jsonSafe)}));
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/plugins/dsh-ai-hub/api',handler:async(req,res)=>{
  const json=(status,value)=>{if(res.destroyed)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
  const requestAbort=new AbortController();const cancel=()=>requestAbort.abort();
  req.once?.('aborted',cancel);res.once?.('close',cancel);
  try{
   const address=req.socket?.remoteAddress??'';
   const local=address==='::1'||/^(?:::ffff:)?127\./.test(address);
   const host=new URL('http://'+req.headers.host).hostname;
   if(!local||!['localhost','127.0.0.1','[::1]'].includes(host))return json(403,{error:'Local requests only'});
   if(req.method!=='POST')return json(405,{error:'POST required'});
   if(req.headers['x-dsh-ai-hub']!=='1'||!/^application\/json\b/.test(req.headers['content-type']??''))return json(403,{error:'Invalid request headers'});
   if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)return json(403,{error:'Cross-origin request refused'});
   let text='';for await(const chunk of req){text+=chunk;if(text.length>16384)return json(413,{error:'Request too large'});}
   json(200,{ok:true,value:jsonSafe(await dispatch(JSON.parse(text),requestAbort.signal))});
  }catch(e){json(400,{ok:false,error:failure(e)});}finally{req.off?.('aborted',cancel);res.off?.('close',cancel);}
 }}));
}
