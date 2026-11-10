import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeProviderSnapshot,nativeRemoteSnapshot} from './native-config.mjs';
const entry=(provider,settingsNs,path=[])=>({provider,displayName:provider,settingsNs,settingsPath:path});
function fixture({missing=false,credentialError=false,modelError=false}={}){
 const reads=[];
 return {reads,llm:{listProviders:()=>[{id:'deepseek-official'},{id:'my-api'},{id:'cursor'}],listConfigurableProviders:()=>[entry('deepseek-official','llm-deepseek'),entry('my-api','pi-ai',['providers','my-api']),entry('cursor','dsh-ai-hub')],listModels:async id=>{if(modelError)throw Error('secret-test-value');return [{id:id+'-model',name:'Example',apiKey:'secret-test-value',badge:{text:'Preview',other:'secret-test-value'}}];}},
 settings:{describe:options=>{assert.deepEqual(options,{redactSecrets:true});return [{ns:'llm-deepseek',value:{apiKeyEnv:'CUSTOM_DS_KEY',baseURL:'https://api.deepseek.com',apiKey:'secret-test-value'}},{ns:'pi-ai',value:{providers:{'my-api':{apiKeyEnv:'MY_API_KEY',baseURL:'https://example.invalid/v1'}}}}];}},
 credentials:{describe:async ref=>{reads.push(ref);if(credentialError)throw Error('secret-test-value');return {configured:!missing,value:'secret-test-value'};},resolve:()=>{throw Error('must not read keys');}}};
}
test('读取内置 DeepSeek 和自定义嵌套配置，不返回密钥或完整配置',async()=>{const ctx=fixture();const data=await nativeProviderSnapshot(ctx);assert.equal(data.providers.length,2);assert(data.providers.every(row=>row.configured));assert.equal(data.providers[0].kind,'deepseek');assert.equal(data.providers[1].kind,'custom');assert.deepEqual(ctx.reads,['CUSTOM_DS_KEY','MY_API_KEY']);assert(!JSON.stringify(data).includes('secret-test-value'));});
test('未配置凭据时不调用模型目录，不把已注册路由当成已配置',async()=>{const ctx=fixture({missing:true});ctx.llm.listModels=()=>{throw Error('unexpected model request');};const data=await nativeProviderSnapshot(ctx);assert(data.providers.every(row=>row.configured===false&&row.modelCount===0));});
test('凭据查询失败保留未知状态，无密钥异常回传',async()=>{const ctx=fixture({credentialError:true,modelError:true});const data=await nativeProviderSnapshot(ctx);assert(data.providers.every(row=>row.configured===null));assert(!JSON.stringify(data).includes('secret-test-value'));});
test('配置变更按次读取，无陈旧配置缓存',async()=>{const ctx=fixture();assert((await nativeProviderSnapshot(ctx)).providers[0].configured);ctx.credentials.describe=async()=>({configured:false});assert.equal((await nativeProviderSnapshot(ctx)).providers[0].configured,false);});
test('宿主接口缺失明确不可用',async()=>{assert.equal((await nativeProviderSnapshot({llm:{}})).available,false);});
test('余额接口未提供时不编造余额，带认证信息的URL不传给客户端',async()=>{const ctx=fixture();ctx.settings.describe=()=>[{ns:'llm-deepseek',value:{baseURL:'https://user:secret-test-value@example.invalid/?key=secret-test-value'}}];const row=(await nativeProviderSnapshot(ctx)).providers[0];assert.equal(row.baseUrl,'');assert(!('balance' in row));});
test('客户端使用 DSH 既有 Remote 协议，模型目录一次读取，不依赖 Hub 新 action',async()=>{
 const ctx=fixture();let catalogReads=0;
 const ok=value=>Promise.resolve({ok:true,value});
 const remote={llm:{listProviders:()=>ok(ctx.llm.listProviders()),listConfigurableProviders:()=>ok(ctx.llm.listConfigurableProviders())},settings:{describe:()=>ok({namespaces:ctx.settings.describe({redactSecrets:true})})},credentials:{describe:async refs=>{assert(Array.isArray(refs));return ok(Object.fromEntries(await Promise.all(refs.map(async ref=>[ref,await ctx.credentials.describe(ref)]))));}},session:{modelCatalog:async()=>{catalogReads++;return ok({groups:[{id:'deepseek-official',models:[{id:'ds',name:'DeepSeek'}]},{id:'my-api',models:[{id:'custom',name:'Custom'}]}]});}}};
 const answer=await nativeRemoteSnapshot(remote);assert.equal(catalogReads,1);assert.deepEqual(answer.providers.map(row=>row.models[0].id),['ds','custom']);assert(!JSON.stringify(answer).includes('secret-test-value'));
 remote.settings.describe=()=>Promise.resolve({ok:false,error:{message:'Settings unavailable'}});await assert.rejects(nativeRemoteSnapshot(remote),/Settings unavailable/);
});
