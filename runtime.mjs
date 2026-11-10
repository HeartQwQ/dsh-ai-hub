import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { CURSOR_DEFAULT_MODELS } from './catalog.mjs';
export const ROOT = dirname(fileURLToPath(import.meta.url));
export const PLATFORMS = ['codex','cursor','antigravity','workbuddy-cn'];
export const DEFAULTS = {codex:{enabled:true,visibleModels:[]},cursor:{enabled:true,visibleModels:CURSOR_DEFAULT_MODELS},antigravity:{enabled:true,visibleModels:[]},'workbuddy-cn':{enabled:true,region:'cn',showCredits:true,visibleModels:[]}};
export function safe(value) { return String(value ?? '').replace(/(?:Bearer\s+|sk-)[\w.\-]+/gi,'[redacted]').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g,'[redacted]').replace(/((?:token|api.?key|secret|authorization|cookie)["'\s:=]+)[^\s,;"'}]+/gi,'$1[redacted]').replace(/[A-Fa-f0-9]{40,}/g,'[redacted]').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,'[email]').slice(-1600); }
export function failure(error) { const text=safe(error?.message ?? error); return {code:/AUTH_BOUNDARY|401|unauthoriz|not logged|authenticat/i.test(text)?'AUTH':/429|rate.limit/i.test(text)?'RATE_LIMIT':/quota|credit|balance|积分|额度/i.test(text)?'QUOTA':'PROVIDER_ERROR',message:text}; }

export function decodeJwtPayload(token) {
 if (typeof token !== 'string') return null;
 const parts = token.trim().split('.');
 if (parts.length < 2 || !parts[1]) return null;
 try {
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
 } catch {
  return null;
 }
}

function parseRetryAfterMs(response, maxMs = 5 * 60_000) {
 if (response?.status !== 429) return undefined;
 const raw = response.headers?.get?.('retry-after')?.trim();
 if (!raw) return undefined;
 const seconds = Number(raw);
 const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(raw) - Date.now();
 return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, maxMs) : undefined;
}

function firstNonEmpty(...values) {
 for (const value of values) {
  if (typeof value === 'string' && value.trim()) return value.trim();
 }
 return '';
}

const CURSOR_REFRESH_MARGIN_MS = 5 * 60_000;
const cursorInflight = new Map();

function resolveCursorAuthPath(appData) {
 if (typeof appData === 'string' && appData.trim()) return join(appData.trim(), 'Cursor', 'auth.json');
 if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Cursor', 'auth.json');
 if (process.platform === 'darwin') return join(homedir(), '.cursor', 'auth.json');
 return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cursor', 'auth.json');
}

export async function readCursorCliConfig({ cursorConfigDir, homeDir } = {}) {
 const base = cursorConfigDir
  || process.env.CURSOR_CONFIG_DIR
  || (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'cursor') : join(homeDir || process.env.USERPROFILE || homedir(), '.cursor'));
 if (!base) return null;
 try {
  const doc = JSON.parse(await readFile(join(base, 'cli-config.json'), 'utf8'));
  if (!doc || typeof doc !== 'object') return null;
  const info = doc.authInfo && typeof doc.authInfo === 'object' ? doc.authInfo : null;
  if (!info) return null;
  return {
   email: firstNonEmpty(info.email),
   displayName: firstNonEmpty(info.displayName),
   userId: typeof info.userId === 'number' && Number.isSafeInteger(info.userId) ? info.userId : undefined,
   authId: firstNonEmpty(info.authId),
   teamId: typeof info.teamId === 'number' && Number.isInteger(info.teamId) && info.teamId > 0 ? info.teamId : undefined,
   activeTeamId: typeof info.activeTeamId === 'number' && Number.isInteger(info.activeTeamId) && info.activeTeamId > 0 ? info.activeTeamId : undefined
  };
 } catch {
  return null;
 }
}

async function readCursorAuthFile(appData) {
 const auth = JSON.parse(await readFile(resolveCursorAuthPath(appData), 'utf8'));
 const accessToken = typeof auth?.accessToken === 'string' && /^[\w.~-]+$/.test(auth.accessToken) ? auth.accessToken : '';
 const refreshToken = typeof auth?.refreshToken === 'string' && auth.refreshToken.trim() ? auth.refreshToken.trim() : '';
 const apiKey = typeof auth?.apiKey === 'string' && auth.apiKey.trim() ? auth.apiKey.trim() : '';
 const payload = decodeJwtPayload(accessToken);
 const expiresAtMs = typeof payload?.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : 0;
 return { accessToken, refreshToken, apiKey, payload, expiresAtMs };
}

// Use the same read-only DashboardService methods as the Cursor client.
async function cursorDashboard(method, signal, { appData = process.env.APPDATA, cursorConfigDir, homeDir, fetchUsage = fetch, refreshCli } = {}) {
 const loginRequired = () => new Error('AUTH_BOUNDARY: 请在 Cursor CLI 登录或刷新登录状态');
 if (appData !== undefined && !appData && process.platform === 'win32') throw loginRequired();
 signal?.throwIfAborted();
 const canShare = fetchUsage === fetch && !refreshCli && !cursorConfigDir && !homeDir;
 const key = `${appData || 'default'}:${method}`;
 if (canShare && cursorInflight.has(key)) return cursorInflight.get(key);
 const task = (async () => {
  let auth;
  try { auth = await readCursorAuthFile(appData); } catch { throw loginRequired(); }
  if (!auth.accessToken && !auth.apiKey) throw loginRequired();
  const tryExchangeApiKey = async () => {
   const keyToExchange = auth.apiKey || (appData === process.env.APPDATA ? process.env.CURSOR_API_KEY : '');
   if (!keyToExchange || !/^[\w.~-]+$/.test(keyToExchange)) return false;
   try {
    const res = await fetchUsage('https://api2.cursor.sh/auth/exchange_user_api_key', {
     method: 'POST',
     redirect: 'error',
     headers: { 'content-type': 'application/json', authorization: `Bearer ${keyToExchange}` },
     body: '{}',
     signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    if (typeof data?.accessToken === 'string' && /^[\w.~-]+$/.test(data.accessToken)) {
     auth = {
      ...auth,
      accessToken: data.accessToken,
      refreshToken: typeof data.refreshToken === 'string' && data.refreshToken ? data.refreshToken : auth.refreshToken,
      payload: decodeJwtPayload(data.accessToken),
      expiresAtMs: (decodeJwtPayload(data.accessToken)?.exp ?? 0) * 1000
     };
     return true;
    }
   } catch {}
   return false;
  };
  const tryCliRefresh = async () => {
   if (await tryExchangeApiKey()) return true;
   if (!auth.refreshToken) return false;
   try {
    if (typeof refreshCli === 'function') await refreshCli(signal);
    else if (fetchUsage === fetch && appData === process.env.APPDATA) {
     const cli = detect('cursor');
     await runProcess({ command: cli.command, args: [...cli.prefix, 'status', '--format', 'json'] }, { timeoutMs: 10_000, signal });
    } else return false;
    auth = await readCursorAuthFile(appData);
    return Boolean(auth.accessToken && (!auth.expiresAtMs || auth.expiresAtMs > Date.now()));
   } catch {
    return false;
   }
  };
  if (!auth.accessToken || (auth.expiresAtMs && auth.expiresAtMs <= Date.now() + CURSOR_REFRESH_MARGIN_MS)) {
   const refreshed = await tryCliRefresh();
   if (!refreshed && (!auth.accessToken || (auth.expiresAtMs && auth.expiresAtMs <= Date.now()))) {
    throw loginRequired();
   }
  }
  const shouldReadCliConfig = Boolean(cursorConfigDir || homeDir || appData === process.env.APPDATA);
  const cliConfig = shouldReadCliConfig ? await readCursorCliConfig({ cursorConfigDir, homeDir }) : null;
  const matchedCliConfig = cliConfig && (!cliConfig.authId || !auth.payload?.sub || cliConfig.authId === auth.payload.sub) ? cliConfig : null;
  const activeTeamId = matchedCliConfig?.activeTeamId;
  const send = async token => {
   const timeout = AbortSignal.timeout(12_000);
   return fetchUsage('https://api2.cursor.sh/aiserver.v1.DashboardService/' + method, {
    method: 'POST',
    redirect: 'error',
    headers: {
     'content-type': 'application/json',
     'connect-protocol-version': '1',
     'x-cursor-client-type': 'cli',
     ...(activeTeamId ? { 'x-cursor-team-id': String(activeTeamId) } : {}),
     authorization: `Bearer ${token}`
    },
    body: '{}',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
   });
  };
  let response = await send(auth.accessToken);
  if ((response.status === 401 || response.status === 403) && await tryCliRefresh()) {
   response = await send(auth.accessToken);
  }
  if (response.status === 401 || response.status === 403) throw loginRequired();
  if (response.status === 429) {
   const err = new Error('429 rate limit: Cursor 用量读取受限（HTTP 429）');
   const retryAfterMs = parseRetryAfterMs(response);
   if (retryAfterMs !== undefined) Object.defineProperty(err, 'retryAfterMs', { value: retryAfterMs });
   throw err;
  }
  if (!response.ok) throw new Error(`Cursor 用量读取失败（HTTP ${response.status}）`);
  return response.json();
 })();
 if (canShare) cursorInflight.set(key, task);
 try { return await task; }
 finally { if (canShare && cursorInflight.get(key) === task) cursorInflight.delete(key); }
}

export async function cursorQuota(signal, options) {
 const usage = await cursorDashboard('GetCurrentPeriodUsage', signal, options);
 const resetMs = Number(usage.billingCycleEnd);
 const resetAt = Number.isFinite(resetMs) && resetMs > 0 && resetMs <= 8.64e15 ? new Date(resetMs).toISOString() : null;
 const windows = [];
 for (const [id, label, value] of [
  ['cursor-models', 'Cursor Models', usage.planUsage?.autoPercentUsed],
  ['other-models', 'Other Models', usage.planUsage?.apiPercentUsed]
 ]) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
   windows.push({ id, label, remainingPercent: Math.round(Math.max(0, 100 - value) * 100) / 100, resetAt });
  }
 }
 if (!windows.length) throw new Error('Cursor 未返回个人额度池数据');
 return windows;
}

export async function cursorAccount(signal, options = {}) {
 try {
  return await cursorDashboard('GetMe', signal, options);
 } catch (error) {
  if (/AUTH_BOUNDARY/i.test(String(error?.message || ''))) throw error;
  const appData = options.appData ?? process.env.APPDATA;
  if (appData || process.platform !== 'win32') {
   try {
    const { payload, expiresAtMs } = await readCursorAuthFile(appData);
    if (!expiresAtMs || expiresAtMs > Date.now()) {
     const shouldReadCliConfig = Boolean(options.cursorConfigDir || options.homeDir || appData === process.env.APPDATA);
     const cliConfig = shouldReadCliConfig ? await readCursorCliConfig(options) : null;
     if (cliConfig?.email && (!cliConfig.authId || !payload?.sub || cliConfig.authId === payload.sub)) {
      return { email: cliConfig.email, firstName: cliConfig.displayName || '', lastName: '' };
     }
     const email = firstNonEmpty(payload?.email, payload?.['https://cursor.com/profile']?.email);
     if (email) {
      return { email, firstName: firstNonEmpty(payload?.given_name, payload?.name), lastName: firstNonEmpty(payload?.family_name) };
     }
    }
   } catch {}
  }
  if (typeof options.statusFallback === 'function') {
   const status = await options.statusFallback(signal);
   if (status?.userInfo?.email) return { email: status.userInfo.email, firstName: status.userInfo.firstName || '', lastName: '' };
  }
  throw error;
 }
}

export function publicAccountIdentity({ name, contact, avatarUrl } = {}) {
 const text = value => typeof value === 'string' ? value.trim().slice(0, 160) : '';
 const identifier = text(contact);
 const at = identifier.lastIndexOf('@');
 let account = '';
 if (at > 0) account = identifier.slice(0, 1) + '***' + identifier.slice(at);
 else if (identifier.includes('*')) account = identifier;
 else if (identifier.length > 6) account = identifier.slice(0, 3) + '******' + identifier.slice(-3);
 else if (identifier) account = '***';
 let avatar = '';
 try {
  const url = new URL(avatarUrl);
  if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) avatar = url.href;
 } catch {}
 const displayName = text(name);
 return { name: displayName === identifier || displayName.includes('@') ? '' : displayName, account, avatarUrl: avatar };
}
export function detect(platform) {
 const local=process.env.LOCALAPPDATA ?? '';
 if(platform==='cursor'){const root=join(local,'cursor-agent','versions'); const dirs=existsSync(root)?readdirSync(root).filter(x=>/^\d{4}\.\d+\.\d+/.test(x)&&!x.endsWith('.previous')).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})):[]; for(const ver of dirs){ const dir=join(root,ver); if(existsSync(join(dir,'index.js'))&&existsSync(join(dir,'node.exe')))return {command:join(dir,'node.exe'),prefix:[join(dir,'index.js')],version:ver}; } }
 if(platform==='antigravity'){const command=join(local,'agy','bin','agy.exe'); if(existsSync(command))return {command,prefix:[]};}
 if(platform==='workbuddy-cn'){const entry=join(local,'Programs','WorkBuddy','resources','app.asar.unpacked','cli','dist','codebuddy-lite-wb.mjs');if(existsSync(entry))return {command:process.execPath,prefix:[entry]};}
 if(platform==='codex'){const home=process.env.USERPROFILE ?? ''; const candidates=[
  join(home,'.codex','packages','standalone','current','bin','codex.exe'),
  join(home,'.codex','packages','app-server-daemon','current','bin','codex.exe'),
  join(home,'.codex','plugins','.plugin-appserver','codex.exe'),
  join(home,'.dsh','profiles','desktop','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe')
 ];
 const versioned=join(local,'OpenAI','Codex','bin');
 if(existsSync(versioned))for(const folder of readdirSync(versioned).filter(name=>/^[a-zA-Z0-9._-]+$/.test(name)).map(name=>join(versioned,name)).filter(path=>{try{return statSync(path).isDirectory();}catch{return false;}}).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs))candidates.push(join(folder,'codex.exe'));
 const command=candidates.find(existsSync);if(command)return {command,prefix:[]};}
 throw new Error(`${platform}: CLI unavailable / 未找到 CLI`);
}
export function command(platform,prompt,model,channel='model',reasoningEffort,cli=detect(platform)){
 let args;
 if(platform==='cursor'){const target=reasoningEffort?(()=>{const match=String(model).match(/-(none|minimal|low|medium|high|xhigh|max|extra-high)(-fast)?$/);return match?String(model).slice(0,-match[0].length)+'-'+reasoningEffort+(match[2]||''):model;})():model;args=['-p','--output-format','stream-json',...(channel==='model'?['--stream-partial-output','--trust','--mode','ask']:['--force','--trust']),...(target?['--model',target]:[]),'--',prompt];}
 if(platform==='antigravity')args=['--output-format','stream-json','--dangerously-skip-permissions',...(model?['--model',model]:[]),'-p',prompt];
 if(platform==='workbuddy-cn')args=['-p','--output-format','stream-json','--no-session-persistence',...(model?['--model',model]:[]),'--max-turns','8','--permission-mode','default','--',prompt];
 if(platform==='codex')args=['exec','--json','--skip-git-repo-check',...(model?['-m',model]:[]),'-c',`model_reasoning_effort="${reasoningEffort||'high'}"`,prompt];
 return {...cli,args:[...cli.prefix,...args]};
}
// No raw stdout/stderr is logged or persisted. Bounded capture is private to a run.
export async function runProcess(spec,{cwd=join(ROOT,'scratch'),signal,timeoutMs=120000,onEvent=()=>{}}={}) {
 signal?.throwIfAborted();
 if(cwd===join(ROOT,'scratch'))mkdirSync(cwd,{recursive:true});
 return new Promise((resolve,reject)=>{
  const child=spawn(spec.command,spec.args,{cwd,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',settled=false,timedOut=false,killer,parseError;
  const stop=()=>{child.kill();if(!killer){killer=setTimeout(()=>child.kill('SIGKILL'),2000);killer.unref();}};
  const abort=()=>stop();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)stop();
  const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
   if(parseError)return;
   if(stdout.length+line.length>2*1024*1024){parseError=new Error('CLI output limit exceeded');stop();return;}
   stdout+=line+'\n';let event;try{event=JSON.parse(line);}catch{return;}
   try{onEvent(event);}catch(e){parseError=e;stop();}
  });
  child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-8192);});
  const finish=(err,code)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killer);signal?.removeEventListener('abort',abort);lines.close();const e=err??parseError;if(e||timedOut||signal?.aborted)reject(new Error(timedOut?'TIMEOUT':signal?.aborted?'ABORTED':safe(e)));else resolve({stdout,stderr,code});};
  child.on('error',err=>finish(err));child.on('close',code=>finish(null,code));
  child.stdin.on('error',()=>{});child.stdin.end();
 });
}
export function collector(platform,onText=()=>{}) {
 let text='',last='',error='',terminal=false,usage;
 const append=t=>{if(!t)return;text+=t;if(text.length>2*1024*1024)throw new Error('Output limit exceeded');onText(t);};
 const snapshot=t=>{if(typeof t!=='string'||!t||t===text)return;if(t.startsWith(text)){append(t.slice(text.length));last=t;return;}if(t.length>=8&&text.endsWith(t))return;if(last&&t.startsWith(last)){append(t.slice(last.length));last=t;return;}append(t);last=t;};
 function event(e){
  if(e.usage)usage=e.usage;
  if(platform==='antigravity'){
   if(e.event==='result'){terminal=true;if(e.result?.status!=='SUCCESS')error=safe(e.result?.error??e.result?.status??'Antigravity failed');else snapshot(e.result.response);}
   // step_update is status/tool progress, not necessarily assistant text. Final response is authoritative.
   return;
  }
  if(platform==='codex'){
   if(e.type==='item.completed'&&e.item?.type==='agent_message')snapshot(e.item.text);
   if(e.type==='turn.completed')terminal=true;
   if(e.type==='turn.failed'||e.type==='error')error=safe(e.error?.message??e.message??'Codex failed');return;
  }
  if(e.type==='assistant')snapshot((e.message?.content??[]).filter(x=>x.type==='text').map(x=>x.text).join(''));
  if(['text','text-delta','assistant-delta'].includes(e.type))append(e.text??e.delta??'');
  const delta=e.type==='stream_event'?e.event?.delta:e.type==='content_block_delta'?e.delta:undefined;
  if(delta?.type==='text_delta')append(delta.text);
  if(e.type==='result'){terminal=true;if(e.is_error||e.subtype?.startsWith('error'))error=safe((e.errors??[e.result??'CLI failure']).join('; '));else snapshot(e.result);}
  if(e.type==='error')error=safe(e.error?.message??e.error??e.message);
 }
 return {event,snapshot,get text(){return text;},finish(code,stderr){if(code!==0||error||!terminal||!text.trim())throw new Error(error||`${platform}: exit=${code}; ${safe(stderr)||'Missing terminal result or empty answer / 无终止结果或回答'}`);return {text,usage};}};
}
export async function cliCall(platform,prompt,model,options={}){if(typeof prompt!=='string'||!prompt.trim()||prompt.length>26000)throw new Error('Task must be text with 1..26000 characters');const c=collector(platform,options.onText);const r=await runProcess(command(platform,prompt,model,options.channel,options.reasoningEffort),{...options,onEvent:c.event});return {...c.finish(r.code,r.stderr),warning:/code.mode.*host|host.*code.mode/i.test(r.stderr)?'Codex code-mode host warning (non-fatal if answer succeeds)':undefined};}
export async function codexRpc(method='account/rateLimits/read',signal,cwd=join(ROOT,'scratch'),params={}){
 if(!['account/read','account/rateLimits/read','model/list'].includes(method))throw new Error('Unsupported read-only Codex method');
 signal?.throwIfAborted();mkdirSync(cwd,{recursive:true});const cli=detect('codex');
 return new Promise((resolve,reject)=>{
  const child=spawn(cli.command,['app-server'],{cwd,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout});let ending=false,settled=false,value,error,killer;
  const finish=(err,result)=>{if(ending)return;ending=true;error=err;value=result;clearTimeout(timer);child.stdin.end();child.kill();killer=setTimeout(()=>child.kill('SIGKILL'),2000);killer.unref();};
  const abort=()=>finish(new Error('ABORTED'));signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>finish(new Error('Codex app-server timeout')),20000);
  const settle=()=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killer);signal?.removeEventListener('abort',abort);lines.close();if(!ending)error=new Error('Codex app-server closed before reply');error?reject(error):resolve(value);};
  child.on('error',e=>{error=e;ending=true;settle();});child.on('close',settle);child.stderr.resume();child.stdin.on('error',()=>{});
  lines.on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}if(ending)return;if(m.id===1){if(m.error)return finish(new Error(safe(m.error.message)));child.stdin.write(JSON.stringify({method:'initialized'})+'\n');child.stdin.write(JSON.stringify({id:2,method,params})+'\n');}if(m.id===2){if(m.error)finish(new Error(safe(m.error.message)));else finish(null,m.result);}});
  child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'dsh-ai-hub',version:'0.1.0'},capabilities:{experimentalApi:true}}})+'\n');
  if(signal?.aborted)abort();
 });
}
export async function readCodexAuth({ codexHome, homeDir } = {}) {
 const base = codexHome || process.env.CODEX_HOME || join(homeDir || process.env.USERPROFILE || homedir(), '.codex');
 if (!base) return null;
 let doc;
 try { doc = JSON.parse(await readFile(join(base, 'auth.json'), 'utf8')); } catch { return null; }
 if (!doc || typeof doc !== 'object') return null;
 const tokens = doc.tokens && typeof doc.tokens === 'object' ? doc.tokens : doc;
 const accessToken = firstNonEmpty(tokens.access_token, tokens.accessToken);
 const idToken = firstNonEmpty(tokens.id_token, tokens.idToken);
 const refreshToken = firstNonEmpty(tokens.refresh_token, tokens.refreshToken);
 const accessPayload = decodeJwtPayload(accessToken);
 const idPayload = decodeJwtPayload(idToken);
 const accessProfile = accessPayload?.['https://api.openai.com/profile'];
 const idProfile = idPayload?.['https://api.openai.com/profile'];
 const accessAuth = accessPayload?.['https://api.openai.com/auth'];
 const idAuth = idPayload?.['https://api.openai.com/auth'];
 const email = firstNonEmpty(idPayload?.email, accessProfile?.email, accessPayload?.email, idProfile?.email);
 const name = firstNonEmpty(idPayload?.name, accessProfile?.name, accessPayload?.name, idProfile?.name);
 const accountId = firstNonEmpty(tokens.account_id, tokens.accountId, accessAuth?.chatgpt_account_id, idAuth?.chatgpt_account_id);
 const planType = firstNonEmpty(accessAuth?.chatgpt_plan_type, idAuth?.chatgpt_plan_type);
 const exp = typeof accessPayload?.exp === 'number' && Number.isFinite(accessPayload.exp)
  ? accessPayload.exp
  : (typeof idPayload?.exp === 'number' && Number.isFinite(idPayload.exp) ? idPayload.exp : 0);
 const expiresAtMs = exp > 0 ? exp * 1000 : 0;
 if (!accessToken && !idToken && !email) return null;
 return { accessToken, idToken, refreshToken, accountId, email, name, planType, expiresAtMs };
}

function mapCodexWhamWindow(win, nowSeconds) {
 if (!win || typeof win !== 'object') return undefined;
 const usedPercent = win.used_percent;
 const seconds = win.limit_window_seconds;
 if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return undefined;
 if (!Number.isInteger(seconds) || seconds <= 0) return undefined;
 const resetsAt = Number.isSafeInteger(win.reset_at) && win.reset_at > 0
  ? win.reset_at
  : (Number.isInteger(win.reset_after_seconds) && win.reset_after_seconds > 0 ? nowSeconds + win.reset_after_seconds : undefined);
 return {
  usedPercent,
  windowDurationMins: Math.round(seconds / 60),
  ...(resetsAt !== undefined ? { resetsAt } : {})
 };
}

function parseCodexWhamUsage(data, fallbackPlanType, nowMs = Date.now()) {
 if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Codex returned malformed usage response');
 const nowSeconds = Math.floor(nowMs / 1000);
 const rl = data.rate_limit && typeof data.rate_limit === 'object' ? data.rate_limit : {};
 const primary = mapCodexWhamWindow(rl.primary_window, nowSeconds);
 const secondary = mapCodexWhamWindow(rl.secondary_window, nowSeconds);
 if (!primary && !secondary) throw new Error('Codex usage response contained no rate-limit windows');
 const planType = typeof data.plan_type === 'string' && data.plan_type.trim() ? data.plan_type.trim() : (fallbackPlanType || undefined);
 const availableCount = Number.isSafeInteger(data.rate_limit_reset_credits?.available_count) && data.rate_limit_reset_credits.available_count >= 0
  ? data.rate_limit_reset_credits.available_count
  : undefined;
 return {
  rateLimits: {
   ...(primary ? { primary } : {}),
   ...(secondary ? { secondary } : {}),
   ...(planType ? { planType } : {})
  },
  ...(availableCount !== undefined ? { rateLimitResetCredits: { availableCount } } : {}),
  source: 'codex-wham-usage'
 };
}

export async function codexAccount(signal, options = {}) {
 const local = await readCodexAuth(options);
 if (local?.email && (!local.expiresAtMs || local.expiresAtMs > Date.now() || local.refreshToken)) {
  return {
   account: {
    type: 'chatgpt',
    email: local.email,
    ...(local.name ? { name: local.name } : {}),
    ...(local.planType ? { planType: local.planType } : {})
   },
   source: 'codex-auth-file'
  };
 }
 const rpc = options.rpc ?? codexRpc;
 return rpc('account/read', signal, options.cwd, { refreshToken: false });
}

let codexQuotaInflight = null;

export async function codexQuota(signal, cwd, options = {}) {
 signal?.throwIfAborted();
 const isDefault = !options.codexHome && !options.homeDir && !options.fetchUsage && !options.rpc;
 if (isDefault && codexQuotaInflight) return codexQuotaInflight;
 const task = (async () => {
  const local = await readCodexAuth(options);
  if (local?.accessToken && local?.accountId && (!local.expiresAtMs || local.expiresAtMs > Date.now() + 60_000)) {
   const fetchUsage = options.fetchUsage ?? fetch;
   const timeout = AbortSignal.timeout(12_000);
   try {
    const response = await fetchUsage('https://chatgpt.com/backend-api/wham/usage', {
     method: 'GET',
     redirect: 'error',
     headers: {
      authorization: `Bearer ${local.accessToken}`,
      'chatgpt-account-id': local.accountId,
      accept: 'application/json',
      'cache-control': 'no-store'
     },
     signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (response.status === 429) {
     const err = new Error('429 rate limit: ChatGPT usage request rate limited (HTTP 429)');
     const retryAfterMs = parseRetryAfterMs(response);
     if (retryAfterMs !== undefined) Object.defineProperty(err, 'retryAfterMs', { value: retryAfterMs });
     if (options.fallbackRpc === false) throw err;
    } else if (response.status === 401 || response.status === 403) {
     if (options.fallbackRpc === false) throw new Error('AUTH_BOUNDARY: Codex 登录状态已失效，请重新登录');
    } else if (response.ok) {
     const body = await response.json();
     return parseCodexWhamUsage(body, local.planType);
    } else if (options.fallbackRpc === false) {
     throw new Error(`ChatGPT usage request failed (HTTP ${response.status})`);
    }
   } catch (err) {
    if (options.fallbackRpc === false || signal?.aborted) throw err;
   }
  }
  const rpc = options.rpc ?? codexRpc;
  return rpc('account/rateLimits/read', signal, cwd);
 })();
 if (isDefault) codexQuotaInflight = task;
 try { return await task; }
 finally { if (isDefault && codexQuotaInflight === task) codexQuotaInflight = null; }
}
export async function codexModels(signal,cwd=join(ROOT,'scratch'),rpc=codexRpc){
 const rows=[],seen=new Set();let cursor;
 do {
  signal?.throwIfAborted();
  const result=await rpc('model/list',signal,cwd,cursor?{cursor}:{});
  rows.push(...(Array.isArray(result?.data)?result.data:Array.isArray(result)?result:[]));
  cursor=typeof result?.nextCursor==='string'&&result.nextCursor?result.nextCursor:undefined;
  if(cursor&&seen.has(cursor))throw new Error('Codex model catalog repeated a pagination cursor');
  if(cursor)seen.add(cursor);
  if(seen.size>100)throw new Error('Codex model catalog pagination limit exceeded');
 } while(cursor);
 return rows.filter(row=>row&&typeof row.id==='string'&&row.id&&row.hidden!==true).map(row=>({
  id:row.id,
  name:typeof row.displayName==='string'&&row.displayName?row.displayName:row.id,
  description:typeof row.description==='string'?row.description:undefined,
  defaultReasoningEffort:typeof row.defaultReasoningEffort==='string'?row.defaultReasoningEffort:undefined,
  reasoning:Array.isArray(row.supportedReasoningEfforts)&&row.supportedReasoningEfforts.length?{
   efforts:row.supportedReasoningEfforts.filter(e=>e&&typeof e.reasoningEffort==='string').map(e=>({id:e.reasoningEffort,name:e.reasoningEffort,description:typeof e.description==='string'?e.description:undefined})),
   defaultEffort:typeof row.defaultReasoningEffort==='string'?row.defaultReasoningEffort:undefined
  }:undefined,
  inputModalities:Array.isArray(row.inputModalities)?row.inputModalities:undefined,
  isDefault:row.isDefault===true
 }));
}
