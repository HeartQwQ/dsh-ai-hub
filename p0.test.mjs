import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createP0 } from './p0.mjs';

const GATEWAY_REF = 'AI_HUB_GATEWAY_KEY';
const FIXTURE_KEY = 'fixture-gateway-key';
const refFor = id => `AI_HUB_ACCOUNT_${Buffer.from(id).toString('hex').toUpperCase()}_API_KEY`;
function fixture(options = {}) {
  const refs = new Map([[GATEWAY_REF, FIXTURE_KEY]]);
  const saved = [];
  const credentials = {
    resolve: async name => { assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/); return refs.has(name) ? { value: refs.get(name) } : undefined; },
    set: async (name, value) => { assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/); refs.set(name, value); },
    unset: async name => { assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/); refs.delete(name); }
  };
  const hub = createP0({ credentials, save: async value => saved.push(structuredClone(value)), ...options });
  const add = (label = '测试账号', providerId = 'deepseek') => hub.dispatch('p0AddAccount', { providerId, label, apiKey: 'fixture-account-key', ...(providerId === 'custom' ? { baseUrl: 'http://fixture.invalid/v1' } : {}) });
  return { hub, refs, saved, credentials, add };
}
// Ports fetch() refuses ("bad port"); a random listen port can land on one of them.
const FETCH_BLOCKED_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
async function listenLocal(server) {
  for (;;) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    if (!FETCH_BLOCKED_PORTS.has(server.address().port)) return;
    await new Promise(resolve => server.close(resolve));
  }
}
async function gateway(t, hub) {
  const server = createServer((req, res) => { hub.handleGateway(req, res).catch(error => res.destroy(error)); });
  await listenLocal(server);
  t.after(async () => { hub.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/plugins/dsh-ai-hub/gateway/v1`;
  return (body = { model: 'deepseek/chat' }, key = FIXTURE_KEY) => fetch(base + '/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer ' + key }, body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

test('凭据引用写入后可按启动规则重新加载，网关复用上次修复的名称', async () => {
  const f = fixture();
  await f.add();
  await f.hub.dispatch('p0Gateway');
  const account = f.hub.service.accounts()[0];
  assert.equal(f.refs.get(refFor(account.id)), 'fixture-account-key');
  for (const name of f.refs.keys()) assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
  assert(!JSON.stringify(f.saved).includes('fixture-account-key'));
  assert.equal(f.refs.get(GATEWAY_REF), FIXTURE_KEY);
  f.hub.dispose();
});

test('新增账号保存失败会回滚凭据、账号与自定义地址', async () => {
  const f = fixture({ save: async () => { throw Error('editor rejected'); } });
  await assert.rejects(f.add('自定义', 'custom'), /editor rejected/);
  assert.deepEqual(f.hub.service.accounts(), []);
  assert.equal(f.hub.service.providers().find(p => p.id === 'custom').baseUrl, '');
  assert.equal(f.refs.size, 1);
  f.hub.dispose();
});

test('多个自定义账号不能把已有密钥隐式切换到另一个地址', async () => {
  const f = fixture();
  await f.add('原有', 'custom');
  await assert.rejects(f.hub.dispatch('p0AddAccount', {
    providerId: 'custom', apiKey: 'another-fixture-key', baseUrl: 'https://other.invalid/v1'
  }), /相同 Base URL/);
  assert.equal(f.hub.service.accounts().length, 1);
  assert.equal(f.hub.service.providers().find(p => p.id === 'custom').baseUrl, 'http://fixture.invalid/v1');
  f.hub.dispose();
});

test('插件卸载后拒绝继续写入凭据', async () => {
  const f = fixture();
  f.hub.dispose();
  await assert.rejects(f.add());
  assert.equal(f.refs.size, 1);
});

test('删除账号保存失败不会删除可用密钥或改变账号', async () => {
  let reject = false;
  const f = fixture({ save: async () => { if (reject) throw Error('save failed'); } });
  await f.add();
  const account = f.hub.service.accounts()[0];
  reject = true;
  await assert.rejects(f.hub.dispatch('p0DeleteAccount', { id: account.id }), /save failed/);
  assert.equal(f.hub.service.accounts().length, 1);
  assert.equal(f.refs.get(refFor(account.id)), 'fixture-account-key');
  f.hub.dispose();
});

test('并发账号与模型设置串行保存，不丢失彼此更新', async () => {
  const f = fixture({ save: async () => { await delay(5); } });
  await Promise.all([f.add('一'), f.add('二'), f.hub.dispatch('p0SetVisibleModels', { providerId: 'deepseek', ids: ['chat'] })]);
  assert.deepEqual(f.hub.service.accounts().map(a => a.label), ['一', '二']);
  assert.deepEqual(f.hub.service.visibleModels('deepseek'), ['chat']);
  f.hub.dispose();
});

test('可见模型和网关开关保存失败不改变生效状态，队列随后可恢复', async () => {
  let reject = true;
  const f = fixture({ save: async () => { if (reject) throw Error('save failed'); } });
  await assert.rejects(f.hub.dispatch('p0SetVisibleModels', { providerId: 'deepseek', ids: ['x'] }));
  await assert.rejects(f.hub.dispatch('p0SetGateway', { enabled: false }));
  assert.deepEqual(f.hub.service.visibleModels('deepseek'), []);
  assert.equal((await f.hub.service.gateway()).enabled, true);
  reject = false;
  assert.equal((await f.hub.dispatch('p0SetGateway', { enabled: false })).enabled, false);
  f.hub.dispose();
});

test('只读快照和模型列表不会泄漏可变状态引用', async () => {
  const f = fixture();
  await f.hub.dispatch('p0SetVisibleModels', { providerId: 'deepseek', ids: ['chat'] });
  const snapshot = await f.hub.dispatch('p0Snapshot');
  snapshot.visibleModels.deepseek.push('mutated');
  f.hub.service.visibleModels('deepseek').push('mutated');
  assert.deepEqual(f.hub.service.visibleModels('deepseek'), ['chat']);
  f.hub.dispose();
});

test('未知平台、原型名称和不合法的自定义地址会被拒绝', async () => {
  const f = fixture();
  for (const providerId of ['constructor', '__proto__', 'toString']) {
    await assert.rejects(f.add('bad', providerId), /未知平台/);
    await assert.rejects(f.hub.service.models(providerId), /未知平台/);
  }
  for (const baseUrl of ['file:///tmp', 'https://user:secret@example.invalid', 'https://example.invalid?key=secret']) {
    await assert.rejects(f.hub.dispatch('p0AddAccount', { providerId: 'custom', apiKey: 'fixture', baseUrl }), /Base URL/);
  }
  assert.equal(f.refs.size, 1);
  f.hub.dispose();
});

test('并发模型读取共享请求；缺失首个账号密钥时可尝试下一个账号', async () => {
  let calls = 0;
  const f = fixture({ fetchImpl: async () => { calls++; await delay(10); return Response.json({ data: [{ id: 'chat' }] }); } });
  await f.add('缺少密钥');
  await f.add('可用账号');
  f.refs.delete(refFor(f.hub.service.accounts()[0].id));
  const [a, b] = await Promise.all([f.hub.service.models('deepseek'), f.hub.service.models('deepseek')]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  a.models.length = 0;
  assert.equal((await f.hub.service.models('deepseek')).models.length, 1);
  f.hub.dispose();
});

test('新增账号会使旧余额缓存失效', async () => {
  let calls = 0;
  const f = fixture({ fetchImpl: async () => { calls++; return Response.json({ balance_infos: [{ total_balance: '12.5' }] }); } });
  await f.add();
  assert.equal((await f.hub.service.quota('deepseek')).remaining, 12.5);
  await f.hub.service.quota('deepseek');
  assert.equal(calls, 1);
  await f.add('另一个');
  await f.hub.service.quota('deepseek');
  assert.equal(calls, 2);
  f.hub.dispose();
});

test('网关密钥外部更新后，下次请求立即读取新值', async t => {
  const f = fixture();
  await f.hub.service.gateway();
  f.refs.set(GATEWAY_REF, 'new-fixture-key');
  const request = await gateway(t, f.hub);
  assert.equal((await request()).status, 401);
  assert.equal((await request({ model: 'deepseek/chat' }, 'new-fixture-key')).status, 503);
});

test('多字节错误密钥返回 401，不会引发 Buffer 长度异常', async t => {
  const f = fixture();
  const request = await gateway(t, f.hub);
  const wrong = 'é'.repeat(FIXTURE_KEY.length);
  assert.equal((await request({ model: 'deepseek/chat' }, wrong)).status, 401);
});

test('无效 JSON、空值、非字符串模型和非法 stream 返回 400', async t => {
  const f = fixture();
  const request = await gateway(t, f.hub);
  for (const body of ['{', 'null', '[]', '{}', { model: {} }, { model: 'constructor/chat' }, { model: 'chat', stream: 'true' }]) {
    assert.equal((await request(body)).status, 400);
  }
});

test('上游 429 切换账号，400 不盲目重试，错误不回显密钥', async t => {
  let calls = 0, status = 429;
  const f = fixture({ fetchImpl: async () => { calls++; return status === 429 && calls === 2 ? Response.json({ choices: [], usage: { total_tokens: 8 } }) : new Response('fixture-account-key', { status }); } });
  await f.add('一'); await f.add('二');
  const request = await gateway(t, f.hub);
  const ok = await request();
  assert.equal(ok.status, 200); await ok.json();
  assert.equal(calls, 2);
  assert.equal(f.hub.service.usage()[0].tokens, 8);
  calls = 0; status = 400;
  const bad = await request();
  assert.equal(bad.status, 400);
  assert(!(await bad.text()).includes('fixture-account-key'));
  assert.equal(calls, 1);
});

test('上游成功状态但 JSON 损坏时返回 502，不伪造 null 成功响应', async t => {
  const f = fixture({ fetchImpl: async () => new Response('{broken') });
  await f.add();
  const request = await gateway(t, f.hub);
  assert.equal((await request()).status, 502);
});

test('网关用量按正文字符计数，记录思考强度且不保存正文', async t => {
  const seen = [];
  const f = fixture({ onUsage: record => seen.push(record), fetchImpl: async () => Response.json({ choices: [{ message: { content: '好的' } }], usage: { prompt_tokens: 7, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 1 } } }) });
  await f.add();
  const request = await gateway(t, f.hub);
  const body = { model: 'deepseek/chat', reasoning_effort: 'high', messages: [{ role: 'system', content: '规则' }, { role: 'user', content: [{ type: 'text', text: '你好呀' }] }] };
  assert.equal((await request(body)).status, 200);
  const [record] = seen;
  assert.deepEqual([record.inputChars, record.systemChars, record.outputChars], [5, 2, 2]);
  assert.deepEqual([record.effort, record.requestedModel, record.model], ['high', 'deepseek/chat', 'chat']);
  assert.deepEqual([record.promptTokens, record.completionTokens, record.reasoningTokens, record.tokenSource], [7, 2, 1, 'actual']);
  assert(!JSON.stringify(record).includes('你好呀'));
});

test('提供 readUsage 时 p0Usage 与快照读取统一用量存储', async () => {
  const f = fixture({ readUsage: limit => [{ id: 'from-store', limit }] });
  assert.deepEqual((await f.hub.dispatch('p0Usage', { limit: 3 })).usage, [{ id: 'from-store', limit: 3 }]);
  assert.equal((await f.hub.dispatch('p0Snapshot')).usage[0].id, 'from-store');
});

test('流式响应完整透传并记录成功用量', async t => {
  const expected = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n';
  const f = fixture({ fetchImpl: async () => new Response(expected) });
  await f.add();
  const request = await gateway(t, f.hub);
  const response = await request({ model: 'deepseek/chat', stream: true });
  assert.equal(await response.text(), expected);
  await delay(10);
  const [record] = f.hub.service.usage();
  assert.equal(record?.source, 'gateway-stream');
  assert.equal(record.outputChars, 2);
  assert.equal(record.promptTokens, 3);
  assert.equal(record.tokenSource, 'actual');
  assert(Number.isFinite(record.ttftMs));
});

test('流式中断后终止连接，不重试第二账号或重复发送响应头', async t => {
  let calls = 0;
  const f = fixture({ fetchImpl: async () => {
    calls++;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); setTimeout(() => controller.error(Error('broken stream')), 30); }
    }));
  } });
  await f.add('一'); await f.add('二');
  const request = await gateway(t, f.hub);
  const response = await request({ model: 'deepseek/chat', stream: true });
  await assert.rejects(response.text());
  assert.equal(calls, 1);
  for (let i = 0; i < 20 && !f.hub.service.usage().length; i++) await delay(10);
  const [failed] = f.hub.service.usage();
  assert.equal(f.hub.service.usage().length, 1);
  assert.equal(failed.status, 502);
  assert.equal(failed.source, 'gateway-stream');
});

test('超时覆盖响应体读取，不只等待响应头', async t => {
  const upstream = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); });
  await listenLocal(upstream);
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const f = fixture({ requestTimeoutMs: 80, fetchImpl: (_url, options) => fetch(`http://127.0.0.1:${upstream.address().port}`, options) });
  await f.add();
  const request = await gateway(t, f.hub);
  assert.equal((await request()).status, 504);
});

test('客户端关闭流时取消上游请求', async t => {
  let cancelled = false;
  const f = fixture({ fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); signal.addEventListener('abort', () => { cancelled = true; controller.error(signal.reason); }, { once: true }); }
  })) });
  await f.add();
  const request = await gateway(t, f.hub);
  const response = await request({ model: 'deepseek/chat', stream: true });
  const reader = response.body.getReader(); await reader.read(); await reader.cancel();
  for (let i = 0; i < 20 && !cancelled; i++) await delay(10);
  assert.equal(cancelled, true);
  for (let i = 0; i < 20 && !f.hub.service.usage().length; i++) await delay(10);
  assert.equal(f.hub.service.usage()[0]?.status, 'aborted');
});
