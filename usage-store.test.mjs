import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createFileBackend, createUsageStore, estimateTokens, fromGatewayRecord, toGatewayRecord, usageDayKey, USAGE_RECENT_LIMIT, USAGE_VERSION } from './usage-store.mjs';

const NOW = new Date(2026, 10, 9, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function record(store, value) {
  return store.record({ at: NOW, platform: 'cursor', model: 'kimi-k3-max', channel: 'chat', source: 'adapter', status: 'ok', ...value });
}

test('estimateTokens stays conservative for mixed text', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('你好世界'), 3);
  assert(estimateTokens('hello 世界') > 0);
});

test('aggregates per platform/model and excludes test calls by default', async () => {
  let saved;
  const store = createUsageStore({ now: () => NOW, persist: async state => { saved = state; } });
  record(store, { inputChars: 400, outputChars: 80, inputText: 'abcd'.repeat(100), tokenSource: 'estimated', effort: 'low', latencyMs: 1200, ttftMs: 300 });
  record(store, { platform: 'codex', model: 'gpt-6.1-sol', inputChars: 200, outputChars: 40, inputTokens: 50, outputTokens: 10, tokenSource: 'actual', latencyMs: 2400 });
  record(store, { channel: 'test', inputChars: 5, outputChars: 2, latencyMs: 10 });
  record(store, { at: NOW - 8 * DAY, inputChars: 999, outputChars: 1 });

  const snapshot = store.snapshot({ range: '7d' });
  assert.equal(snapshot.persistence, 'config');
  assert.equal(snapshot.totals.calls, 2);
  assert.equal(snapshot.totals.ok, 2);
  assert.equal(snapshot.totals.successRate, 1);
  assert.equal(snapshot.totals.inputChars, 600);
  assert.equal(snapshot.totals.outputChars, 120);
  assert.equal(snapshot.platforms.length, 2);
  assert.equal(snapshot.models.length, 2);
  assert.equal(snapshot.days.length, 7);
  assert.equal(snapshot.recent.length, 2);
  assert.equal(snapshot.totals.p95LatencyMs, 2400);
  assert.equal(snapshot.totals.avgLatencyMs, 1800);

  const withTests = store.snapshot({ range: '7d', includeTests: true });
  assert.equal(withTests.totals.calls, 3);
  assert.equal(store.snapshot({ range: '7d', platform: 'codex' }).totals.calls, 1);

  await store.flush();
  assert(saved);
  assert.equal(saved.v, USAGE_VERSION);
  assert(Object.keys(saved.days).length > 0);
});

test('today range only includes today and persistence round-trips', async () => {
  let saved;
  const store = createUsageStore({ now: () => NOW, persist: async state => { saved = state; } });
  record(store, { inputChars: 100, inputTokens: 20, outputTokens: 5, tokenSource: 'actual' });
  record(store, { at: NOW - DAY, inputChars: 100, inputTokens: 20, outputTokens: 5, tokenSource: 'actual' });
  assert.equal(store.snapshot({ range: 'today' }).totals.calls, 1);
  assert.equal(store.snapshot({ range: 'all' }).totals.calls, 2);
  await store.flush();
  const restored = createUsageStore({ initial: saved, now: () => NOW });
  assert.equal(restored.snapshot({ range: 'all' }).totals.calls, 2);
  assert.equal(restored.persistence, 'memory');
  assert.equal(usageDayKey(NOW), '2026-11-09');
});

test('reset clears buckets and recent records', async () => {
  let saved;
  const store = createUsageStore({ now: () => NOW, persist: async state => { saved = state; } });
  record(store, { inputChars: 10, inputTokens: 2, outputTokens: 1, tokenSource: 'actual' });
  const cleared = await store.reset();
  assert.equal(cleared.totals.calls, 0);
  assert.equal(store.snapshot({ range: 'all' }).totals.calls, 0);
  assert.deepEqual(Object.keys(saved.days), []);
});

test('malformed initial state is ignored and never crashes', () => {
  const store = createUsageStore({ initial: { v: 1, days: { bad: 'x' }, recent: [{ nope: true }] }, now: () => NOW });
  assert.equal(store.snapshot({ range: 'all' }).totals.calls, 0);
  record(store, { inputChars: 1, outputChars: 1 });
  assert.equal(store.snapshot({ range: 'today' }).totals.calls, 1);
});

test('aborted and errored calls are counted separately', () => {
  const store = createUsageStore({ now: () => NOW });
  record(store, { status: 'error', inputChars: 20 });
  record(store, { status: 'aborted', inputChars: 10 });
  const snapshot = store.snapshot({ range: 'today' });
  assert.equal(snapshot.totals.calls, 2);
  assert.equal(snapshot.totals.error, 1);
  assert.equal(snapshot.totals.aborted, 1);
  assert.equal(snapshot.totals.ok, 0);
  assert.equal(snapshot.totals.successRate, 0);
});

test('7d/30d/all ranges return continuous day rows and respect boundaries', () => {
  const store = createUsageStore({ now: () => NOW });
  record(store, {});
  record(store, { at: NOW - 6 * DAY });
  record(store, { at: NOW - 7 * DAY });
  record(store, { at: NOW - 29 * DAY });
  record(store, { at: NOW - 40 * DAY });
  const week = store.snapshot({ range: '7d' });
  assert.equal(week.totals.calls, 2);
  assert.equal(week.days.length, 7);
  assert.equal(week.days.at(-1).date, '2026-11-09');
  assert.equal(week.days.filter(day => day.calls).length, 2);
  assert.equal(store.snapshot({ range: '30d' }).totals.calls, 4);
  assert.equal(store.snapshot({ range: '30d' }).days.length, 30);
  const all = store.snapshot({ range: 'all' });
  assert.equal(all.totals.calls, 5);
  assert.equal(all.days[0].date, usageDayKey(NOW - 40 * DAY));
  assert.equal(all.days.length, 41);
  assert.equal(store.snapshot({ range: 'bogus' }).range, '7d');
});

test('actual, estimated and unknown tokens stay separate', () => {
  const store = createUsageStore({ now: () => NOW });
  record(store, { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, tokenSource: 'actual' });
  record(store, { inputText: 'abcd'.repeat(10), outputText: 'abcd', tokenSource: 'estimated' });
  record(store, { tokenSource: 'unknown', inputTokens: 999 });
  record(store, {});
  const { totals } = store.snapshot({ range: 'today' });
  assert.deepEqual([totals.inputTokens, totals.outputTokens, totals.reasoningTokens], [100, 20, 5]);
  assert.deepEqual([totals.estimatedInputTokens, totals.estimatedOutputTokens], [10, 1]);
  assert.deepEqual([totals.tokenActualCalls, totals.tokenEstimatedCalls, totals.tokenUnknownCalls], [1, 1, 2]);
  const recent = store.snapshot({ range: 'today' }).recent;
  assert(recent.every(item => !('inputText' in item) && !('outputText' in item)));
});

test('legacy buckets that mixed estimates into actual fields are migrated', () => {
  const day = usageDayKey(NOW);
  const initial = { v: USAGE_VERSION, days: { [day]: { k: { platform: 'cursor', model: 'm', source: 'adapter', channel: 'chat', calls: 2, ok: 2, inputTokens: 40, outputTokens: 8, tokenEstimatedCalls: 2 } } }, recent: [] };
  const { totals } = createUsageStore({ initial, now: () => NOW }).snapshot({ range: 'today' });
  assert.deepEqual([totals.inputTokens, totals.estimatedInputTokens, totals.estimatedOutputTokens], [0, 40, 8]);
});

test('context composition, budget and latest watermark come from adapter metadata', () => {
  const store = createUsageStore({ now: () => NOW });
  record(store, { at: NOW - 1000, inputChars: 900, systemChars: 100, historyChars: 800, omittedChars: 0, inputBudget: 24000 });
  record(store, { inputChars: 24000, systemChars: 2000, historyChars: 22000, omittedChars: 5000, inputBudget: 24000 });
  const snapshot = store.snapshot({ range: 'today' });
  assert.deepEqual([snapshot.totals.systemChars, snapshot.totals.historyChars, snapshot.totals.omittedChars, snapshot.totals.inputBudgetMax], [2100, 22800, 5000, 24000]);
  assert.equal(snapshot.lastContext.inputChars, 24000);
  assert.equal(snapshot.lastContext.omittedChars, 5000);
  assert.equal(createUsageStore({ now: () => NOW }).snapshot().lastContext, null);
});

test('platform, channel, model and test filters apply to buckets and recent alike', () => {
  const store = createUsageStore({ now: () => NOW });
  record(store, { model: 'kimi-k3-max', channel: 'chat' });
  record(store, { model: 'Claude-Opus', channel: 'subagent' });
  record(store, { platform: 'deepseek', model: 'deepseek-chat', channel: 'native', source: 'session', inputCharsUnknown: true });
  record(store, { platform: 'deepseek', model: 'deepseek-chat', channel: 'gateway', source: 'gateway' });
  record(store, { channel: 'test' });
  const check = (options, calls) => {
    const snapshot = store.snapshot({ range: 'today', ...options });
    assert.equal(snapshot.totals.calls, calls, JSON.stringify(options));
    assert.equal(snapshot.recent.length, calls, JSON.stringify(options));
  };
  check({}, 4);
  check({ includeTests: true }, 5);
  check({ channel: 'test' }, 1);
  check({ platform: 'deepseek' }, 2);
  check({ channel: 'native' }, 1);
  check({ model: 'claude' }, 1);
  check({ model: 'DEEPSEEK', channel: 'gateway' }, 1);
  const snapshot = store.snapshot({ range: 'today' });
  assert.deepEqual(snapshot.channels.map(row => row.channel), ['chat', 'subagent', 'gateway', 'native']);
  assert.equal(snapshot.channels[0].share, 0.25);
  assert.equal(snapshot.platforms.find(row => row.platform === 'deepseek').inputCharsUnknownCalls, 1);
  assert.equal(store.snapshot({ range: 'today', model: 'claude' }).filters.model, 'claude');
});

test('P95 is exact inside the recent window and a flagged histogram estimate beyond it', () => {
  const small = createUsageStore({ now: () => NOW });
  for (let index = 1; index <= 20; index += 1) record(small, { latencyMs: index * 100 });
  assert.equal(small.snapshot({ range: 'today' }).totals.p95LatencyMs, 1900);
  assert.equal(small.snapshot({ range: 'today' }).totals.p95Exact, true);
  const capped = createUsageStore({ now: () => NOW, recentLimit: 5 });
  for (let index = 1; index <= 20; index += 1) record(capped, { latencyMs: index * 100, ttftMs: 50 });
  const { totals } = capped.snapshot({ range: 'today' });
  assert.equal(totals.p95Exact, false);
  assert.equal(totals.p95LatencyMs, 2000);
  assert.equal(totals.avgTtftMs, 50);
  assert.equal(totals.calls, 20);
  assert.equal(capped.snapshot({ range: 'today' }).recent.length, 5);
  assert.equal(createUsageStore({ now: () => NOW }).snapshot().totals.p95LatencyMs, null);
});

test('recent records are capped at 200 while day buckets keep every call', () => {
  const store = createUsageStore({ now: () => NOW });
  for (let index = 0; index < USAGE_RECENT_LIMIT + 25; index += 1) record(store, { at: NOW - index });
  const snapshot = store.snapshot({ range: 'today', limit: 1000 });
  assert.equal(snapshot.recent.length, USAGE_RECENT_LIMIT);
  assert.equal(snapshot.totals.calls, USAGE_RECENT_LIMIT + 25);
  assert.equal(snapshot.recent[0].at, NOW);
  assert.equal(store.snapshot({ range: 'today', limit: 3 }).recent.length, 3);
});

test('retention drops buckets and records older than 90 days by date', () => {
  let clock = NOW;
  const store = createUsageStore({ now: () => clock });
  record(store, { at: NOW - 89 * DAY });
  record(store, { at: NOW - 90 * DAY });
  record(store, {});
  assert.equal(store.snapshot({ range: 'all' }).totals.calls, 2);
  clock = NOW + DAY;
  store.record({ at: clock, platform: 'cursor', model: 'm', status: 'ok' });
  const all = store.snapshot({ range: 'all' });
  assert.equal(all.totals.calls, 2);
  assert.equal(all.days[0].date, usageDayKey(NOW));
  assert.equal(all.recent.length, 2);
});

test('reset can clear a single platform', async () => {
  const store = createUsageStore({ now: () => NOW });
  record(store, {});
  record(store, { platform: 'codex', model: 'gpt' });
  const cleared = await store.reset('cursor');
  assert.equal(cleared.totals.calls, 0);
  assert.equal(cleared.filters.platform, 'cursor');
  assert.equal(store.snapshot({ range: 'all' }).totals.calls, 1);
  assert.equal(store.snapshot({ range: 'all' }).recent[0].platform, 'codex');
});

test('file backend round-trips atomically and moves a corrupt file aside', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-hub-usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'nested', 'usage.json');
  const backend = createFileBackend(path);
  assert.equal(backend.load().status, 'missing');
  const store = createUsageStore({ now: () => NOW, persist: state => backend.save(state), persistence: 'file' });
  record(store, { inputChars: 12 });
  await store.flush();
  assert.equal(store.snapshot().persistence, 'file');
  assert(store.snapshot().persistedAt);
  const loaded = backend.load();
  assert.equal(loaded.status, 'ok');
  assert.equal(createUsageStore({ initial: loaded.value, now: () => NOW }).snapshot({ range: 'today' }).totals.inputChars, 12);
  assert.deepEqual(readdirSync(join(dir, 'nested')), ['usage.json']);
  writeFileSync(path, '{broken');
  assert.equal(backend.load().status, 'corrupt');
  assert(!existsSync(path));
  assert(readdirSync(join(dir, 'nested')).some(name => name.startsWith('usage.json.corrupt-')));
  assert.equal(createUsageStore({ initial: undefined, now: () => NOW }).snapshot().totals.calls, 0);
});

test('failed writes keep data dirty, surface the error and retry', async () => {
  let attempts = 0, saved;
  const store = createUsageStore({ now: () => NOW, debounceMs: 1, retryMs: 5, persist: async state => { attempts += 1; if (attempts === 1) throw new Error('disk full'); saved = state; } });
  record(store, {});
  await store.flush();
  assert.equal(store.snapshot().persistError, 'disk full');
  assert.equal(store.snapshot().totals.calls, 1);
  for (let index = 0; index < 50 && !saved; index += 1) await delay(5);
  assert.equal(attempts, 2);
  assert.equal(store.snapshot().persistError, undefined);
  assert.equal(Object.keys(saved.days).length, 1);
});

test('debounced writes coalesce and dispose performs the final flush', async () => {
  let writes = 0, saved;
  const store = createUsageStore({ now: () => NOW, debounceMs: 10000, persist: async state => { writes += 1; saved = state; } });
  for (let index = 0; index < 5; index += 1) record(store, {});
  assert.equal(writes, 0);
  await store.dispose();
  assert.equal(writes, 1);
  assert.equal(saved.recent.length, 5);
});

test('gateway records map both ways and backfill is idempotent by id', () => {
  const legacy = { id: 'g1', time: new Date(NOW).toISOString(), provider: 'deepseek', model: 'deepseek-chat', status: 200, latencyMs: 30, inputChars: 10, systemChars: 4, outputChars: 3, promptTokens: 6, completionTokens: 2, tokens: 8, tokenSource: 'actual', effort: 'high' };
  const failed = { id: 'g2', time: new Date(NOW).toISOString(), provider: 'custom', model: 'x', status: 429, inputChars: 1, outputChars: 0, tokenSource: 'unknown' };
  const aborted = { ...failed, id: 'g3', status: 'aborted' };
  const store = createUsageStore({ now: () => NOW });
  assert.equal(store.backfill([legacy, failed, aborted].map(fromGatewayRecord)), 3);
  assert.equal(store.backfill([legacy, failed].map(fromGatewayRecord)), 0);
  const snapshot = store.snapshot({ range: 'today', channel: 'gateway' });
  assert.deepEqual([snapshot.totals.calls, snapshot.totals.ok, snapshot.totals.error, snapshot.totals.aborted], [3, 1, 1, 1]);
  assert.deepEqual([snapshot.totals.systemChars, snapshot.totals.historyChars], [4, 8]);
  const back = toGatewayRecord(snapshot.recent.find(item => item.id === 'g1'));
  assert.deepEqual([back.status, back.tokens, back.promptTokens, back.provider, back.time], [200, 8, 6, 'deepseek', legacy.time]);
  assert.equal(toGatewayRecord(snapshot.recent.find(item => item.id === 'g2')).tokens, null);
  assert.equal(fromGatewayRecord(null), null);
});
