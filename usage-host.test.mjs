import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, createAdapter, createHub, createSessionUsage, createSubagent, CLI_INPUT_BUDGET, flattenWithMeta, meterStream, nativeUsagePlatform, usageFilePath } from './index.js';
import { createUsageStore, USAGE_VERSION, usageDayKey } from './usage-store.mjs';

const memoryStore = () => createUsageStore({ debounceMs: 60000 });
const recentOf = store => store.snapshot({ range: 'all', includeTests: true }).recent;

function cliHub(store, behavior = async (_p, _prompt, _model, { onText }) => { onText('O'); onText('K'); return { text: 'OK' }; }) {
  return createHub({ usage: store, cliCaller: behavior });
}

test('hub.call records ok calls with chars, TTFT, estimated tokens and no prompt text', async () => {
  const store = memoryStore();
  const hub = cliHub(store);
  await hub.call('codex', 'secret prompt text', { model: 'gpt-6.1-sol', reasoningEffort: 'high' });
  const [record] = recentOf(store);
  assert.equal(record.platform, 'codex');
  assert.equal(record.channel, 'chat');
  assert.equal(record.status, 'ok');
  assert.equal(record.effort, 'high');
  assert.equal(record.inputChars, 'secret prompt text'.length);
  assert.equal(record.outputChars, 2);
  assert.equal(record.tokenSource, 'estimated');
  assert(Number.isFinite(record.ttftMs));
  assert(!JSON.stringify(store.snapshot({ range: 'all' })).includes('secret prompt'));
  assert.equal(store.snapshot({ range: 'all' }).totals.inputTokens, 0);
  assert(store.snapshot({ range: 'all' }).totals.estimatedInputTokens > 0);
  hub.dispose();
});

test('hub.call records errors and aborts with the characters already streamed', async () => {
  const store = memoryStore();
  const failing = cliHub(store, async (_p, _prompt, _model, { onText }) => { onText('partial'); throw new Error('upstream exploded'); });
  await assert.rejects(failing.call('codex', 'x'));
  const controller = new AbortController();
  const hanging = cliHub(store, (_p, _prompt, _model, { onText, signal }) => new Promise((_resolve, reject) => {
    onText('ab');
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const pending = hanging.call('codex', 'y', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);
  const [aborted, failed] = recentOf(store);
  assert.deepEqual([failed.status, failed.outputChars], ['error', 7]);
  assert.deepEqual([aborted.status, aborted.outputChars], ['aborted', 2]);
  failing.dispose(); hanging.dispose();
});

test('connection tests are metered on the test channel and hidden by default', async () => {
  const store = memoryStore();
  const hub = cliHub(store);
  const result = await hub.test('codex');
  assert.equal(result.ok, true);
  assert.equal(recentOf(store)[0].channel, 'test');
  assert.equal(store.snapshot({ range: 'all' }).totals.calls, 0);
  assert.equal(store.snapshot({ range: 'all', includeTests: true }).totals.calls, 1);
  hub.dispose();
});

test('subagent tasks are metered on the subagent channel', async () => {
  const store = memoryStore();
  const hub = cliHub(store);
  const run = await createSubagent(hub, 'codex').start({ prompt: [{ type: 'text', text: 'do it' }] });
  assert.equal((await run.result).stopReason, 'completed');
  assert.equal(recentOf(store)[0].channel, 'subagent');
  assert.equal(recentOf(store)[0].model, '平台自动选择');
  hub.dispose();
});

test('flattenWithMeta reports the composition of the prompt actually sent', () => {
  const short = flattenWithMeta({ system: 'policy', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(short.inputChars, short.prompt.length);
  assert.equal(short.inputBudget, CLI_INPUT_BUDGET);
  assert.deepEqual([short.systemChars, short.historyChars, short.omittedChars], [6, 'user: hi'.length, 0]);
  const long = flattenWithMeta({ system: 'S'.repeat(20000), messages: [{ role: 'user', content: 'x'.repeat(30000) }, { role: 'user', content: 'LATEST' }] });
  assert(long.inputChars <= CLI_INPUT_BUDGET);
  assert(long.systemChars <= 6000);
  assert(long.omittedChars > 0);
  assert(long.prompt.endsWith('LATEST'));
});

test('adapter passes flatten metadata so context and watermark reach the snapshot', async () => {
  const store = memoryStore();
  const hub = cliHub(store);
  const adapter = createAdapter(hub, 'codex');
  const events = [];
  for await (const event of adapter.stream({ model: 'gpt-6.1-sol', system: 'S'.repeat(20000), messages: [{ role: 'user', content: 'x'.repeat(30000) }] })) events.push(event);
  assert.equal(events.at(-1).reason.kind, 'stop');
  const snapshot = store.snapshot({ range: 'all', platform: 'codex' });
  assert.equal(snapshot.totals.inputBudgetMax, CLI_INPUT_BUDGET);
  assert(snapshot.totals.omittedChars > 0);
  assert(snapshot.totals.systemChars > 0);
  assert.equal(snapshot.lastContext.platform, 'codex');
  assert(snapshot.lastContext.inputChars <= CLI_INPUT_BUDGET);
  hub.dispose();
});

async function drain(stream, stopAfter = Infinity) {
  const events = [];
  for await (const event of stream) { events.push(event); if (events.length >= stopAfter) break; }
  return events;
}

test('meterStream records host usage as actual tokens and finish kinds as status', async () => {
  const records = [];
  const meter = meterStream(record => records.push(record), 'codex');
  async function* ok() {
    yield { type: 'text-delta', text: '你好' };
    yield { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 2, outputTokens: 4, reasoningTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  await drain(meter(ok(), { model: 'gpt-6.1-sol', reasoningEffort: 'low', system: 'sys', messages: [{ role: 'user', content: 'hello' }] }));
  assert.deepEqual([records[0].status, records[0].inputTokens, records[0].outputTokens, records[0].reasoningTokens, records[0].tokenSource], ['ok', 42, 4, 1, 'actual']);
  assert.deepEqual([records[0].systemChars, records[0].historyChars, records[0].outputChars, records[0].effort], [3, 5, 2, 'low']);
  assert(Number.isFinite(records[0].ttftMs));

  async function* failed() { yield { type: 'finish', reason: { kind: 'error' } }; }
  await drain(meter(failed(), { model: 'm' }));
  assert.equal(records[1].status, 'error');
  assert.equal(records[1].tokenSource, 'estimated');

  async function* throws() { yield { type: 'text-delta', text: 'a' }; throw new Error('boom'); }
  await assert.rejects(drain(meter(throws(), { model: 'm' })));
  assert.equal(records[2].status, 'error');

  async function* endless() { for (;;) yield { type: 'text-delta', text: 'z' }; }
  await drain(meter(endless(), { model: 'm' }), 3);
  assert.equal(records[3].status, 'aborted');
  assert.equal(records[3].outputChars, 3);
});

test('native session events map to deepseek/custom only, skip replays and duplicates', () => {
  let clock = 1_000_000;
  const records = [];
  const sessions = createSessionUsage(record => records.push(record), { now: () => clock });
  const header = (provider, time, extra = {}) => ({ type: 'request/header', time, data: { header: { config: { provider, model: 'deepseek-v4', reasoningEffort: 'max', ...extra } } } });
  const message = (seq, time, data = {}) => ({ type: 'assistant/message', seq, time, data: { content: [{ type: 'text', text: 'answer' }, { type: 'tool-use', input: { secret: 1 } }], ...data } });

  sessions.event({ id: 's1' }, header('deepseek-account', clock - 60000));
  sessions.event({ id: 's1' }, message(1, clock - 59000));
  assert.equal(records.length, 0, 'history replay must not count');

  sessions.event({ id: 's1' }, header('deepseek-account', clock + 10));
  sessions.event({ id: 's1' }, message(2, clock + 1510, { usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 20 } }));
  sessions.event({ id: 's1' }, message(2, clock + 1510));
  assert.equal(records.length, 1, 'duplicate seq must not count twice');
  const [first] = records;
  assert.deepEqual([first.platform, first.channel, first.source, first.status, first.effort], ['deepseek', 'native', 'session', 'ok', 'max']);
  assert.deepEqual([first.inputChars, first.inputCharsUnknown, first.outputChars, first.latencyMs], [0, true, 6, 1500]);
  assert.deepEqual([first.inputTokens, first.outputTokens, first.tokenSource], [1000, 20, 'actual']);

  sessions.event({ id: 's2' }, header('cursor', clock + 20));
  sessions.event({ id: 's2' }, message(1, clock + 30));
  sessions.event({ id: 's3' }, header('codex', clock + 20));
  sessions.event({ id: 's3' }, message(1, clock + 30));
  assert.equal(records.length, 1, 'hub-managed providers are metered by their adapters');

  sessions.event({ id: 's4' }, header('my-proxy', clock + 40));
  sessions.event({ id: 's4' }, message(1, clock + 50, { stopReason: 'aborted' }));
  assert.deepEqual([records[1].platform, records[1].status, records[1].tokenSource], ['custom', 'aborted', 'unknown']);

  sessions.dispose('s4');
  sessions.event({ id: 's4' }, message(2, clock + 60));
  assert.equal(records.length, 2, 'disposed sessions forget their header');
  assert.deepEqual(['deepseek-official', 'openai-codex', 'workbuddy', '', null].map(nativeUsagePlatform), ['deepseek', null, null, null, null]);
});

test('usage file path prefers the explicit override, then the profile directory', () => {
  assert.equal(usageFilePath({ DSH_AI_HUB_USAGE_FILE: 'X:/u.json', DSH_PROFILE_DIR: 'Y:/p' }), 'X:/u.json');
  assert.equal(usageFilePath({ DSH_PROFILE_DIR: 'Y:/p' }), join('Y:/p', 'data', 'dsh-ai-hub', 'usage.json'));
  assert.match(usageFilePath({ DSH_PROFILE: 'desktop' }), /[\\/]\.dsh[\\/]profiles[\\/]desktop[\\/]data[\\/]dsh-ai-hub[\\/]usage\.json$/);
  assert.match(usageFilePath({}), /[\\/]\.dsh[\\/]data[\\/]dsh-ai-hub[\\/]usage\.json$/);
});

function hostContext({ llm = {} } = {}) {
  const routes = new Map(), services = new Map(), listeners = new Map(), effects = [], adapters = new Map();
  let edits = 0;
  const ctx = {
    fiber: { entry: 'test-entry' },
    get: name => name === 'configEditor' ? { edit: async (_entry, fn) => { edits += 1; fn({}); } } : services.get(name),
    provide: (name, value) => { services.set(name, value); return () => services.delete(name); },
    effect: fn => { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); return dispose; },
    on: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); },
    llm: { registerAdapter: (ids, adapter) => { adapters.set(ids[0], adapter); return () => {}; }, registerConfigurableProviders: () => () => {}, ...llm },
    subagents: { registerProvider: () => () => {} },
    tools: { register: () => () => {} },
    webServer: { register: route => { routes.set(route.path, route); return () => {}; }, getOrigin: () => 'http://127.0.0.1:1' }
  };
  const api = async body => {
    const req = {
      method: 'POST', headers: { host: '127.0.0.1:1', 'x-dsh-ai-hub': '1', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { yield JSON.stringify(body); }, once() {}, off() {}
    };
    let status, text = '';
    const res = { destroyed: false, writeHead(code) { status = code; }, end(value) { text = value; }, once() {}, off() {} };
    await routes.get('/plugins/dsh-ai-hub/api').handler(req, res);
    return { status, ...JSON.parse(text) };
  };
  const dispose = async () => { for (const fn of effects.reverse()) await fn(); };
  return { ctx, api, listeners, adapters, dispose, edits: () => edits };
}

function withUsageFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-hub-host-'));
  const path = join(dir, 'usage.json');
  const previous = process.env.DSH_AI_HUB_USAGE_FILE;
  process.env.DSH_AI_HUB_USAGE_FILE = path;
  t.after(() => { if (previous === undefined) delete process.env.DSH_AI_HUB_USAGE_FILE; else process.env.DSH_AI_HUB_USAGE_FILE = previous; rmSync(dir, { recursive: true, force: true }); });
  return path;
}

test('dashboard refresh scopes requests and reuses persisted startup data', async t => {
  withUsageFile(t);
  const calls = [];
  const host = hostContext({llm:{listModels:async () => [{id:'deepseek-test'}]}});
  const get = host.ctx.get;
  host.ctx.get = key => key === 'deepseekAccount' ? {
    getState: async () => {calls.push('deepseek');return {status:'credential-stored',links:{private:'test-link'}};},
    getProfile: async () => ({status:'ready',value:{contact:'fixture@example.com'}}),
    getBalance: async () => ({status:'ready',value:[]})
  } : get(key);
  const config = {platforms:{codex:{enabled:false},cursor:{enabled:false},'workbuddy-cn':{enabled:false}}};
  apply(host.ctx, config);
  try {
    const hub = host.ctx.get('aiHub');
    hub.quota = async (p, force) => {calls.push([p,'quota',force]);return {kind:'window',windows:[]};};
    hub.catalogInfo = async (p, force) => {calls.push([p,'models',force]);return {models:[{id:'gemini-test'}]};};
    const refreshed = await host.api({action:'refreshDashboard'});
    assert.equal(refreshed.value.deepseek.profile.value.contact,'f***@example.com');
    assert.equal(refreshed.value.deepseek.links,undefined);
    assert.deepEqual(calls,['deepseek',['antigravity','quota',true],['antigravity','models',true]]);
    calls.length = 0;
    await host.api({action:'dashboard'});
    assert.deepEqual(calls,[]);
    await host.api({action:'refreshDashboard',platform:'antigravity'});
    assert.deepEqual(calls,[['antigravity','quota',true],['antigravity','models',true]]);
    const restarted = hostContext();
    apply(restarted.ctx, config);
    try {
      const cached = await restarted.api({action:'dashboard'});
      assert.equal(cached.value.catalogs.antigravity.models[0].id,'gemini-test');
      assert.equal(cached.value.deepseek.profile.value.contact,'f***@example.com');
    } finally { await restarted.dispose(); }
  } finally { await host.dispose(); }
});

test('apply wires session events, usage RPC and file persistence without editing config', async t => {
  const path = withUsageFile(t);
  const host = hostContext();
  apply(host.ctx, {});
  const now = Date.now();
  host.listeners.get('session/event')({ id: 'n1' }, { type: 'request/header', time: now, data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-v4' } } } });
  host.listeners.get('session/event')({ id: 'n1' }, { type: 'assistant/message', seq: 1, time: now + 5, data: { content: [{ type: 'text', text: 'hi' }] } });

  const snapshot = await host.api({ action: 'usageSnapshot', range: 'today', platform: 'deepseek', model: 'v4' });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.value.persistence, 'file');
  assert.equal(snapshot.value.totals.calls, 1);
  assert.equal(snapshot.value.filters.model, 'v4');
  assert.equal(snapshot.value.recent[0].channel, 'native');
  assert.equal(snapshot.value.platforms[0].inputCharsUnknownCalls, 1);
  assert.equal((await host.api({ action: 'usageSnapshot', range: 'today', model: 'nope' })).value.totals.calls, 0);

  await host.dispose();
  assert.equal(host.edits(), 0, 'usage must not go through configEditor, which restarts the plugin');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.v, USAGE_VERSION);
  assert.equal(saved.recent.length, 1);

  const again = hostContext();
  apply(again.ctx, {});
  assert.equal((await again.api({ action: 'usageSnapshot', range: 'all' })).value.totals.calls, 1);
  const reset = await again.api({ action: 'usageReset', platform: 'deepseek' });
  assert.equal(reset.value.totals.calls, 0);
  assert.equal((await again.api({ action: 'p0Usage' })).value.usage.length, 0);
  await again.dispose();
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).recent.length, 0);
});

test('0.5.0 config usage seeds the new file once', async t => {
  const path = withUsageFile(t);
  const at = Date.now();
  const legacy = { v: USAGE_VERSION, days: { [usageDayKey(at)]: { k: { platform: 'cursor', model: 'kimi', source: 'adapter', channel: 'chat', calls: 3, ok: 3 } } }, recent: [] };
  const host = hostContext();
  apply(host.ctx, { aiHubUsage: legacy });
  assert.equal((await host.api({ action: 'usageSnapshot', range: 'today' })).value.totals.calls, 3);
  await host.dispose();
  assert(existsSync(path));
  const reloaded = hostContext();
  apply(reloaded.ctx, { aiHubUsage: { v: USAGE_VERSION, days: {}, recent: [] } });
  assert.equal((await reloaded.api({ action: 'usageSnapshot', range: 'today' })).value.totals.calls, 3, 'an existing file wins over config');
  await reloaded.dispose();
});

test('Codex proxied through the host llm is metered even though it bypasses hub.call', async t => {
  withUsageFile(t);
  const llm = {
    listProviders: () => [{ id: 'openai-codex' }],
    listModels: async () => [],
    resolveModelInfo: async (_provider, id) => ({ id }),
    stream: async function* () { yield { type: 'text-delta', text: 'ok' }; yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } }; yield { type: 'finish', reason: { kind: 'stop' } }; }
  };
  const host = hostContext({ llm });
  apply(host.ctx, {});
  const call = await host.adapters.get('codex').prepareCall('codex', 'gpt-6.1-sol');
  await drain(call.stream({ messages: [{ role: 'user', content: 'hey' }] }));
  const { value } = await host.api({ action: 'usageSnapshot', range: 'today', platform: 'codex' });
  assert.equal(value.totals.calls, 1);
  assert.equal(value.totals.inputTokens, 5);
  assert.equal(value.recent[0].model, 'gpt-6.1-sol');
  await host.dispose();
});
