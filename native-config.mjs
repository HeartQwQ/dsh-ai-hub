// Read public provider facts through the same services used by DSH Models settings.
// Never resolve, copy, or return an API key.
const LOCAL = new Set(['deepseek-account','cursor','codex','openai-codex','antigravity','workbuddy-cn']);
const at = (value,path) => path.reduce((node,key)=>node&&typeof node==='object'&&Object.hasOwn(node,key)?node[key]:undefined,value);
const validRef = ref => typeof ref==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref);
const publicURL = raw => {try{const url=new URL(raw);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash?url.origin+url.pathname:'';}catch{return '';}};
export async function nativeProviderSnapshot({llm,settings,credentials}) {
 if(typeof llm?.listConfigurableProviders!=='function'||typeof settings?.describe!=='function')return {available:false,providers:[],error:'当前宿主没有提供模型配置读取接口'};
 const [registered,directory,namespaces]=await Promise.all([llm.listProviders(),llm.listConfigurableProviders(),settings.describe({redactSecrets:true})]);
 const active=new Set(registered.map(row=>row.id));
 const providers=await Promise.all(directory.filter(row=>row.settingsNs!=='dsh-ai-hub'&&!LOCAL.has(row.provider)).map(async entry=>{
  const namespace=namespaces.find(row=>row.ns===entry.settingsNs);
  const profile=at(namespace?.value,entry.settingsPath||[]);
  const ref=validRef(profile?.apiKeyEnv)?profile.apiKeyEnv:entry.provider==='deepseek-official'?'DEEPSEEK_API_KEY':entry.provider.toUpperCase().replace(/[^A-Z0-9]+/g,'_')+'_API_KEY';
  const refs=validRef(profile?.apiKeyEnv)?[ref]:[ref,...(entry.nativeAuth?.env||[]).filter(validRef)];
  let configured=false,error=null;
  if(profile!==undefined){
   try{if(typeof credentials?.describe!=='function')configured=null;else{const facts=await Promise.all([...new Set(refs)].map(key=>credentials.describe(key)));configured=facts.some(info=>info.configured===true);}}
   catch{configured=null;error='凭据状态暂不可用';}
  }
  let models=[];
  if(active.has(entry.provider)&&configured!==false){
   try{models=(await llm.listModels(entry.provider)).map(model=>({id:String(model.id),name:String(model.name||model.id),...(model.badge?.text?{badge:{text:String(model.badge.text)}}:{})}));if(configured===null&&models.length)configured=true;}
   catch{error='模型目录读取失败，请在内置模型设置中检查配置';}
  }
  return {id:entry.provider,name:entry.displayName||entry.provider,kind:entry.provider==='deepseek-official'?'deepseek':'custom',configured,active:active.has(entry.provider),baseUrl:publicURL(profile?.baseURL||profile?.baseUrl||entry.defaultBaseURL),models,modelCount:models.length,...(error?{error}:{})};
 }));
 return {available:true,providers,updatedAt:new Date().toISOString()};
}

export async function nativeRemoteSnapshot(remote) {
 if(typeof remote?.llm?.listConfigurableProviders!=='function'||typeof remote?.settings?.describe!=='function'||typeof remote?.credentials?.describe!=='function'||typeof remote?.session?.modelCatalog!=='function')throw new Error('DSH 内置模型接口尚未就绪，请重新加载客户端');
 const unwrap=async promise=>{const answer=await promise;if(answer?.ok!==true)throw new Error(answer?.error?.message||'DSH 内置接口读取失败');return answer.value;};
 let catalog;
 return nativeProviderSnapshot({
  llm:{listProviders:()=>unwrap(remote.llm.listProviders()),listConfigurableProviders:()=>unwrap(remote.llm.listConfigurableProviders()),listModels:async id=>{catalog??=unwrap(remote.session.modelCatalog());const value=await catalog;return value.groups.find(group=>group.id===id)?.models||[];}},
  settings:{describe:async()=>{const value=await unwrap(remote.settings.describe());return value.namespaces;}},
  credentials:{describe:async ref=>(await unwrap(remote.credentials.describe([ref])))[ref]}
 });
}
