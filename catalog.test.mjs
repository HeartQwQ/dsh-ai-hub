import assert from 'node:assert/strict';
import test from 'node:test';
import { createHub, createAdapter, apply, normalizeSettings } from './index.js';
import { normalizeModels, parseCliModels, selectModels, createProxyAdapter, withVariantReasoning, collapseModels, projectSelection, resolveVariant, creditMultiplier } from './catalog.mjs';
import { codexModels, command } from './runtime.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// apply() persists usage under the profile; keep test hosts away from the real one.
process.env.DSH_AI_HUB_USAGE_FILE = join(tmpdir(), `ai-hub-catalog-test-${process.pid}`, 'usage.json');

const rows = provider => [{ provider, id: 'vendor/model-new', name: '新模型' }, { provider, id: 'old', name: '旧模型' }];
test('WorkBuddy 倍率兼容数字、小数和上游字符串，不把未知值当成零', () => {
  for (const [raw, expected] of [[2,2],['2.00',2],[' 0.5 ',0.5],['×1.5',1.5],['2x',2],[0,0],['0',0]]) assert.equal(creditMultiplier(raw),expected);
  for (const raw of [undefined,null,'',true,false,-1,NaN,Infinity,'unknown','2积分/千token',{},'0.5~2']) assert.equal(creditMultiplier(raw),undefined);
});
test('WorkBuddy 使用原生 badge 显示倍率，保持模型 ID 与名称', () => {
  const list=normalizeModels([{id:'kimi-k3',name:'Kimi K3',credits:'1.50'},{id:'free-fixture',name:'Fixture',credits:0}],'workbuddy-cn');
  assert.deepEqual(list[0].badge,{text:'积分 ×1.5'}); assert.equal(list[0].id,'kimi-k3');assert.equal(list[0].name,'Kimi K3');
  assert.equal(list[1].badge.text,'积分 ×0');
  assert.deepEqual(normalizeModels(list,'workbuddy-cn')[0].badge,list[0].badge);
});
test('缺失/无效倍率不生成标签；其他渠道不套用 WorkBuddy 积分语义',()=>{
  for(const credits of [undefined,null,'',NaN,-1,'unknown'])assert.equal(normalizeModels([{id:'m',credits}],'workbuddy-cn')[0].badge,undefined);
  for(const provider of ['cursor','codex','antigravity'])assert.equal(normalizeModels([{id:'m',credits:'2'}],provider)[0].badge,undefined);
});
test('倍率贯穿 Host adapter 目录与设置目录；刷新使用上游新值',async()=>{
  let credits='2';const hub=createHub({loadModels:async()=>[{id:'kimi-k3',name:'Kimi K3',credits}]});
  const adapter=createAdapter(hub,'workbuddy-cn');assert.equal((await adapter.listModels())[0].badge.text,'积分 ×2');
  assert.equal((await hub.catalogInfo('workbuddy-cn')).models[0].badge.text,'积分 ×2');
  credits=0.5;await hub.catalogInfo('workbuddy-cn',true);assert.equal((await adapter.listModels())[0].badge.text,'积分 ×0.5');hub.dispose();
});
test('各渠道规范化目录：重映射 provider、去重、保留命名空间及能力', () => {
  const input = [{ ...rows('native')[0], reasoning: { efforts: [{ id: 'high', name: '高' }] } }, rows('native')[0], { id: '' }, { id: 'fallback' }];
  for (const platform of ['cursor', 'codex', 'antigravity', 'workbuddy-cn']) {
    const result = normalizeModels(input, platform);
    assert.equal(result.length, 2); assert.equal(result[0].provider, platform);
    assert.equal(result[1].name, 'fallback'); assert.equal(result[0].reasoning.efforts[0].id, 'high');
  }
});
test('CLI 目录支持文本、JSON、ANSI、新模型家族及带斜杠的 ID', () => {
  for (const provider of ['cursor', 'antigravity']) {
    const text = '\x1b[32mAvailable models\x1b[0m\n\nauto - Auto (default)\nqwen/new-model - 新模型\nother-model   Other Model\nTip: use --model to switch.\n';
    assert.deepEqual(parseCliModels(text, provider).map(row => row.id), ['auto', 'qwen/new-model', 'other-model']);
    assert.equal(parseCliModels(JSON.stringify({ data: rows(provider) }), provider).length, 2);
  }
});
test('Cursor 默认使用精简清单；显式空列表仍允许用户选择全部', () => {
  assert(normalizeSettings().cursor.visibleModels.length <= 8);
  assert(normalizeSettings().cursor.visibleModels.includes('auto'));
  const models = Array.from({ length: 270 }, (_, i) => ({ provider: 'cursor', id: 'model-' + i, name: 'Model ' + i }));
  assert.equal(selectModels(models, ['removed']).models.length, 8);
  assert.equal(selectModels(models, []).models.length, 270);
  assert.equal(selectModels(models, ['__none__']).models.length, 0);
  assert.deepEqual(projectSelection(models, ['__none__']), ['__none__']);
});
test('目录更名后筛选不会清空选择器；仍有效的用户筛选保持不变', () => {
  const all = rows('codex');
  assert.equal(selectModels(all, ['removed']).models.length, 2);
  assert.deepEqual(selectModels(all, ['old', 'removed']).models.map(row => row.id), ['old']);
});
test('目录失败显式报告错误；刷新失败保留上次目录；不制造配置模型', async () => {
  let failed = false;
  const hub = createHub({ loadModels: async p => { if (failed) throw Error('401 not logged in'); return rows(p); } });
  assert.equal((await hub.catalogInfo('antigravity')).models.length, 2);
  failed = true;
  const stale = await hub.catalogInfo('antigravity', true);
  assert.equal(stale.models.length, 2); assert.equal(stale.stale, true); assert.equal(stale.error.code, 'AUTH');
  const missing = await hub.catalogInfo('codex', true);
  assert.deepEqual(missing.models, []); assert(missing.error); hub.dispose();
});
test('并发目录解析只发起一次请求，保留完整模型集', async () => {
  let calls = 0;
  const hub = createHub({ loadModels: async p => { calls++; return Array.from({ length: 270 }, (_, i) => ({ id: 'm-' + i, name: 'M ' + i })); } });
  await Promise.all(Array.from({ length: 50 }, () => hub.catalog('cursor')));
  assert.equal(calls, 1); assert.equal((await hub.catalog('cursor')).length, 270); hub.dispose();
});
test('Cursor fast 与普通模型的思考强度不混用', async () => {
  const hub = createHub({ loadModels: async () => ['test-high', 'test-low', 'test-high-fast', 'test-xhigh-fast'].map(id => ({ id, name: id })) });
  const list = await hub.catalog('cursor');
  assert.deepEqual(list.find(row => row.id === 'test-high').reasoning.efforts.map(row => row.id), ['low', 'high']);
  assert.deepEqual(list.find(row => row.id === 'test-high-fast').reasoning.efforts.map(row => row.id), ['high', 'xhigh']);
  const cli = command('cursor', 'fixture', 'test-high-fast', 'model', 'xhigh', { command: 'fixture', prefix: [] });
  assert(cli.args.includes('test-xhigh-fast')); hub.dispose();
});

test('截图中的 Antigravity 三种强度合并成一个模型，强度完整保留', async () => {
  const raw = ['medium','high','low'].map(effort => ({ id:'gemini-4-argon-'+effort, name:'Gemini 4 Argon ('+effort+')' }));
  const hub = createHub({ loadModels:async()=>raw });
  const adapter = createAdapter(hub,'antigravity');
  const models = await adapter.listModels();
  assert.equal(models.length,1);assert.equal(models[0].name,'Gemini 4 Argon');
  const info = await adapter.resolveModel('antigravity',models[0].id);
  assert.deepEqual(info.reasoning.efforts.map(row=>row.id),['low','medium','high']);
  const legacy = await adapter.resolveModel('antigravity','gemini-4-argon-high');
  assert.equal(legacy.id,'gemini-4-argon-high');assert.equal(legacy.name,'Gemini 4 Argon');
  assert.equal(legacy.reasoning.defaultEffort,'high');hub.dispose();
});
test('选择不同思考强度实际发送正确 CLI 型号，绝不只改显示', async () => {
  const sent=[];
  const hub=createHub({loadModels:async()=>['low','medium','high'].map(effort=>({id:'gemini-4-argon-'+effort,name:'Gemini 4 Argon ('+effort+')'})),cliCaller:async(p,prompt,model)=>{sent.push(model);return{text:'fixture'};}});
  for(const reasoningEffort of ['low','medium','high'])await hub.call('antigravity','fixture',{model:'gemini-4-argon-medium',reasoningEffort});
  assert.deepEqual(sent,['gemini-4-argon-low','gemini-4-argon-medium','gemini-4-argon-high']);
  await assert.rejects(hub.call('antigravity','fixture',{model:'gemini-4-argon-medium',reasoningEffort:'max'}),/Unsupported/);
  assert.equal(sent.length,3);hub.dispose();
});
test('Cursor 不再重复拼接强度，多个已勾选变体仅显示一个选项', async () => {
  const hub=createHub({config:{platforms:{cursor:{visibleModels:['gpt-test-high','gpt-test-low']}}},loadModels:async()=>[
    {id:'gpt-test-high',name:'Codex Test High · 高'}, {id:'gpt-test-low',name:'Codex Test Low · 低'}
  ]});
  const models=await createAdapter(hub,'cursor').listModels();
  assert.equal(models.length,1);assert.equal(models[0].name,'Codex Test');
  assert(!models[0].name.includes('高'));hub.dispose();
});
test('普通、fast、thinking 和不同渠道不会错误合并',()=>{
  const raw=normalizeModels(['test-high','test-low','test-high-fast','test-low-fast','test-thinking-high'].map(id=>({id,name:id})),'cursor');
  const all=withVariantReasoning(raw,'cursor');
  assert.equal(collapseModels(all).length,3);
  const fast=all.find(row=>row.id==='test-high-fast');assert.equal(resolveVariant(all,fast.id,'low'),'test-low-fast');
  assert.equal(collapseModels([...all,{...all[0],provider:'antigravity'}]).length,4);
});
test('设置目录按系列合并，兼容旧筛选且不修改持久化配置', async()=>{
  const hub=createHub({config:{platforms:{antigravity:{visibleModels:['gemini-4-argon-high','gemini-4-argon-low']}}},loadModels:async()=>['low','medium','high'].map(e=>({id:'gemini-4-argon-'+e,name:'Gemini 4 Argon ('+e+')'}))});
  const result=await hub.catalogInfo('antigravity');
  assert.equal(result.models.length,1);assert.deepEqual(result.visibleModels,['gemini-4-argon-medium']);
  assert.deepEqual(hub.settings().antigravity.visibleModels,['gemini-4-argon-high','gemini-4-argon-low']);
  hub.dispose();
});
test('Codex 转接的列表和精确元数据保留身份、上下文及思考强度', async () => {
  let streamed;
  const upstreamInfo = { provider: 'openai-codex', id: 'm', name: 'Model', context: { contextWindow: 100000 }, reasoning: { efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' } };
  const llm = { listModels: async () => [upstreamInfo], resolveModelInfo: async () => upstreamInfo, stream: options => { streamed = options; return options; } };
  const hub = createHub();
  const proxy = createProxyAdapter(llm, hub, 'codex', 'openai-codex', 'Codex');
  assert.equal((await proxy.listModels())[0].provider, 'codex');
  const prepared = await proxy.prepareCall('codex', 'm');
  assert.equal(prepared.model.provider, 'codex'); assert.deepEqual(prepared.model.reasoning, upstreamInfo.reasoning);
  prepared.stream({ model: 'wrong', reasoningEffort: 'high' });
  assert.equal(streamed.provider, 'openai-codex'); assert.equal(streamed.model, 'm'); assert.equal(streamed.reasoningEffort, 'high');
  hub.dispose();
});
test('WorkBuddy 模型能力不再被目录投影丢弃', async () => {
  const hub = createHub({ loadModels: async p => [{ id: 'm', name: 'Model', contextWindow: 88000, maxOutput: 12000, reasoning: { efforts: [{ id: 'high', name: '高' }] } }] });
  const info = await createAdapter(hub, 'workbuddy-cn').resolveModel('workbuddy-cn', 'm');
  assert.equal(info.context.contextWindow, 88000); assert.equal(info.defaultMaxTokens, 12000); hub.dispose();
});
test('Codex 模型目录读取全部分页；循环 cursor 会被拒绝', async () => {
  const params = [];
  const models = await codexModels(undefined, undefined, async (_method, _signal, _cwd, page) => {
    params.push(page); return page.cursor ? { data: [{ id: 'second', displayName: 'Second' }] } : { data: [{ id: 'first', displayName: 'First' }], nextCursor: 'next' };
  });
  assert.deepEqual(models.map(row => row.id), ['first', 'second']); assert.deepEqual(params, [{}, { cursor: 'next' }]);
  await assert.rejects(codexModels(undefined, undefined, async () => ({ data: [], nextCursor: 'loop' })), /repeated/);
});
function host(nativeProviders = []) {
  const services = new Map(), adapters = new Map(), routes = new Map(), effects = []; let updates = 0;
  const ctx = { fiber: { entry: 'fixture' }, get: name => name === 'configEditor' ? { edit: async (_entry, change) => change({}) } : services.get(name),
    provide: (name, service) => { services.set(name, service); return () => services.delete(name); },
    effect: effect => { const dispose = effect(); if (dispose) effects.push(dispose); return dispose; },
    llm: {
      listProviders: () => [...nativeProviders, ...adapters.keys()].map(id => ({ id, name: id })),
      listModels: async id => rows(id), resolveModelInfo: async (provider, id) => ({ provider, id, name: id }),
      registerAdapter: (ids, adapter) => {
        assert(!nativeProviders.includes(ids[0]), 'must preserve native provider'); adapters.set(ids[0], adapter);
        const dispose = () => adapters.delete(ids[0]); dispose.replace = () => { updates++; }; return dispose;
      }, registerConfigurableProviders: () => () => {}
    }, subagents: { registerProvider: () => () => {} }, tools: { register: () => () => {} },
    webServer: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } }
  };
  apply(ctx, {});
  return { services, adapters, routes, updates: () => updates, dispose: () => effects.reverse().forEach(fn => fn()) };
}
test('已有 Codex provider 不会重复注册导致插件激活失败', () => {
  const h = host(['codex']); assert.equal(h.adapters.has('codex'), false); h.dispose();
});
test('保存筛选后通知原生选择器刷新；保存失败不发布更新', async () => {
  const h = host();
  await h.services.get('aiHub').updateSettings({ cursor: { visibleModels: ['auto'] } });
  assert(h.updates() > 0); h.dispose();
  const hub = createHub({ save: async () => { throw Error('save failed'); } });
  let updates = 0; hub.onSettingsChanged(() => { updates++; });
  await assert.rejects(hub.updateSettings({ cursor: { visibleModels: ['auto'] } }));
  assert.equal(updates, 0); hub.dispose();
});
test('Hub Codex 转接目录与原生目录一致，不调用无关 CLI 伪造模型', async () => {
  const h = host(['openai-codex']);
  const catalog = await h.services.get('aiHub').catalog('codex');
  assert.equal(catalog[0].id, 'vendor/model-new');
  assert.equal((await h.adapters.get('codex').listModels())[0].provider, 'codex'); h.dispose();
});
