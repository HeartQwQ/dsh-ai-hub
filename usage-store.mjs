import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const USAGE_VERSION = 1;
export const USAGE_RETENTION_DAYS = 90;
export const USAGE_RECENT_LIMIT = 200;
export const USAGE_PLATFORMS = ['codex', 'cursor', 'antigravity', 'workbuddy-cn', 'deepseek', 'custom'];
export const USAGE_CHANNELS = ['chat', 'subagent', 'test', 'gateway', 'native'];
/** Upper bounds (ms) of the persisted latency histogram; one extra overflow bin follows. */
export const LATENCY_BINS = [250, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000, 7500, 10000, 15000, 20000, 30000, 45000, 60000, 90000, 120000, 180000];
const DAY_MS = 24 * 60 * 60 * 1000;
const RANGES = new Set(['today', '7d', '30d', 'all']);
const SOURCES = ['adapter', 'gateway', 'session'];
const STATUSES = ['ok', 'error', 'aborted'];
const TOKEN_SOURCES = ['actual', 'estimated', 'unknown'];
const SUM_FIELDS = [
  'calls', 'ok', 'error', 'aborted',
  'inputChars', 'outputChars', 'systemChars', 'historyChars', 'omittedChars',
  'inputTokens', 'outputTokens', 'reasoningTokens', 'estInputTokens', 'estOutputTokens',
  'tokenActualCalls', 'tokenEstimatedCalls', 'tokenUnknownCalls', 'inputCharsUnknownCalls',
  'latencyMsSum', 'latencyCount', 'ttftMsSum', 'ttftCount'
];
const MAX_FIELDS = ['inputBudgetMax', 'latencyMsMax'];

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const nonNegative = value => {
  const number = finite(value);
  return number === undefined ? 0 : Math.max(0, number);
};
const optionalNonNegative = value => {
  const number = finite(value);
  return number === undefined ? undefined : Math.max(0, number);
};
const text = (value, limit = 200) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const clone = value => JSON.parse(JSON.stringify(value));
const isCjk = char => /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(char);
const errorText = error => error instanceof Error ? error.message : String(error);

/** Rough public estimate for transports that do not report usage. */
export function estimateTokens(value) {
  const source = typeof value === 'string' ? value : '';
  if (!source) return 0;
  let cjk = 0;
  for (const char of source) if (isCjk(char)) cjk += 1;
  const other = source.length - cjk;
  return Math.ceil(cjk / 1.5 + other / 4);
}

export function usageDayKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localMidnight(value) {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// Calendar arithmetic instead of fixed 24h steps keeps day keys correct across DST.
function shiftDays(midnight, days) {
  const date = new Date(midnight);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

function rangeDays(range) {
  return range === 'today' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : null;
}

function latencyBin(ms) {
  const index = LATENCY_BINS.findIndex(bound => ms <= bound);
  return index < 0 ? LATENCY_BINS.length : index;
}

function emptySums() {
  const sums = {};
  for (const field of SUM_FIELDS) sums[field] = 0;
  for (const field of MAX_FIELDS) sums[field] = 0;
  sums.latencyHist = new Array(LATENCY_BINS.length + 1).fill(0);
  return sums;
}

function emptyBucket(record) {
  return {
    platform: record.platform,
    model: record.model,
    effort: record.effort ?? null,
    source: record.source,
    channel: record.channel,
    ...emptySums()
  };
}

function addSums(target, source) {
  for (const field of SUM_FIELDS) target[field] += source[field] ?? 0;
  for (const field of MAX_FIELDS) target[field] = Math.max(target[field], source[field] ?? 0);
  for (let index = 0; index < target.latencyHist.length; index += 1) target.latencyHist[index] += source.latencyHist?.[index] ?? 0;
}

function addRecord(bucket, record) {
  bucket.calls += 1;
  bucket[record.status] += 1;
  bucket.inputChars += record.inputChars;
  bucket.outputChars += record.outputChars;
  bucket.systemChars += record.systemChars;
  bucket.historyChars += record.historyChars;
  bucket.omittedChars += record.omittedChars;
  bucket.inputBudgetMax = Math.max(bucket.inputBudgetMax, record.inputBudget ?? 0);
  if (record.inputCharsUnknown) bucket.inputCharsUnknownCalls += 1;
  if (record.tokenSource === 'actual') {
    bucket.inputTokens += record.inputTokens ?? 0;
    bucket.outputTokens += record.outputTokens ?? 0;
    bucket.reasoningTokens += record.reasoningTokens ?? 0;
    bucket.tokenActualCalls += 1;
  } else if (record.tokenSource === 'estimated') {
    bucket.estInputTokens += record.inputTokens ?? 0;
    bucket.estOutputTokens += record.outputTokens ?? 0;
    bucket.tokenEstimatedCalls += 1;
  } else {
    bucket.tokenUnknownCalls += 1;
  }
  if (record.latencyMs !== undefined) {
    bucket.latencyMsSum += record.latencyMs;
    bucket.latencyCount += 1;
    bucket.latencyMsMax = Math.max(bucket.latencyMsMax, record.latencyMs);
    bucket.latencyHist[latencyBin(record.latencyMs)] += 1;
  }
  if (record.ttftMs !== undefined) {
    bucket.ttftMsSum += record.ttftMs;
    bucket.ttftCount += 1;
  }
}

function normalizeRecord(input, now) {
  const platform = text(input?.platform, 40);
  const model = text(input?.model);
  if (!USAGE_PLATFORMS.includes(platform) || !model) return null;
  const channel = USAGE_CHANNELS.includes(input?.channel) ? input.channel : 'chat';
  const source = SOURCES.includes(input?.source) ? input.source : 'adapter';
  const status = STATUSES.includes(input?.status) ? input.status : 'error';
  let inputTokens = optionalNonNegative(input?.inputTokens);
  let outputTokens = optionalNonNegative(input?.outputTokens);
  let reasoningTokens = optionalNonNegative(input?.reasoningTokens);
  let tokenSource = TOKEN_SOURCES.includes(input?.tokenSource) ? input.tokenSource : undefined;
  if (tokenSource === 'estimated') {
    if (inputTokens === undefined) inputTokens = estimateTokens(input?.inputText ?? '');
    if (outputTokens === undefined) outputTokens = estimateTokens(input?.outputText ?? '');
    reasoningTokens = undefined;
  } else if (tokenSource === 'actual' || tokenSource === undefined) {
    tokenSource = inputTokens !== undefined || outputTokens !== undefined ? 'actual' : 'unknown';
  }
  if (tokenSource === 'unknown') inputTokens = outputTokens = reasoningTokens = undefined;
  const requestedModel = text(input?.requestedModel);
  const at = finite(input?.at) ?? now;
  const record = {
    id: text(input?.id, 80) || randomUUID(),
    at,
    platform,
    providerId: text(input?.providerId, 120) || undefined,
    model,
    requestedModel: requestedModel && requestedModel !== model ? requestedModel : undefined,
    effort: text(input?.effort, 40) || undefined,
    channel,
    source,
    status,
    latencyMs: optionalNonNegative(input?.latencyMs),
    ttftMs: optionalNonNegative(input?.ttftMs),
    inputChars: nonNegative(input?.inputChars),
    outputChars: nonNegative(input?.outputChars),
    systemChars: nonNegative(input?.systemChars),
    historyChars: nonNegative(input?.historyChars),
    omittedChars: nonNegative(input?.omittedChars),
    inputBudget: optionalNonNegative(input?.inputBudget) || undefined,
    inputTokens,
    outputTokens,
    reasoningTokens,
    tokenSource
  };
  if (input?.inputCharsUnknown === true) record.inputCharsUnknown = true;
  return record;
}

/** Maps a legacy `p0` gateway record (HTTP status, ISO time) to a UsageRecord input. */
export function fromGatewayRecord(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const status = entry.status === 'aborted' ? 'aborted' : Number(entry.status) === 200 ? 'ok' : 'error';
  const actual = entry.tokenSource === 'actual' || finite(entry.promptTokens) !== undefined || finite(entry.completionTokens) !== undefined;
  return {
    id: typeof entry.id === 'string' ? entry.id : undefined,
    at: Date.parse(entry.time) || undefined,
    platform: entry.provider === 'deepseek' ? 'deepseek' : 'custom',
    providerId: entry.provider,
    model: entry.model,
    requestedModel: entry.requestedModel,
    effort: entry.effort,
    channel: 'gateway',
    source: 'gateway',
    status,
    latencyMs: entry.latencyMs,
    ttftMs: entry.ttftMs,
    inputChars: entry.inputChars ?? 0,
    outputChars: entry.outputChars ?? 0,
    systemChars: Math.min(entry.systemChars ?? 0, entry.inputChars ?? 0),
    historyChars: Math.max(0, (entry.inputChars ?? 0) - (entry.systemChars ?? 0)),
    inputTokens: actual ? entry.promptTokens : undefined,
    outputTokens: actual ? entry.completionTokens : undefined,
    reasoningTokens: actual ? entry.reasoningTokens : undefined,
    tokenSource: actual ? 'actual' : 'unknown'
  };
}

/** Legacy `p0Usage` projection of a gateway UsageRecord. */
export function toGatewayRecord(record) {
  const tokens = record.tokenSource === 'actual' ? (record.inputTokens ?? 0) + (record.outputTokens ?? 0) : null;
  return {
    id: record.id,
    time: new Date(record.at).toISOString(),
    provider: record.providerId ?? record.platform,
    account: null,
    model: record.model,
    status: record.status === 'ok' ? 200 : record.status,
    latencyMs: record.latencyMs ?? null,
    inputChars: record.inputChars,
    outputChars: record.outputChars,
    tokens,
    promptTokens: record.tokenSource === 'actual' ? record.inputTokens ?? null : null,
    completionTokens: record.tokenSource === 'actual' ? record.outputTokens ?? null : null,
    tokenSource: record.tokenSource,
    source: 'gateway'
  };
}

function emptyState() {
  return { v: USAGE_VERSION, days: {}, recent: [], updatedAt: 0 };
}

function bucketKey(record) {
  return [record.platform, record.model, record.effort ?? '', record.source, record.channel].join('\u0000');
}

function normalizeBucket(value) {
  if (!value || typeof value !== 'object') return null;
  const platform = text(value.platform, 40);
  const model = text(value.model);
  if (!USAGE_PLATFORMS.includes(platform) || !model) return null;
  const bucket = emptyBucket({
    platform,
    model,
    effort: text(value.effort, 40) || null,
    source: SOURCES.includes(value.source) ? value.source : 'adapter',
    channel: USAGE_CHANNELS.includes(value.channel) ? value.channel : 'chat'
  });
  for (const field of [...SUM_FIELDS, ...MAX_FIELDS]) bucket[field] = nonNegative(value[field]);
  if (Array.isArray(value.latencyHist) && value.latencyHist.length === bucket.latencyHist.length) {
    bucket.latencyHist = value.latencyHist.map(nonNegative);
  }
  // Early 0.5.0 builds summed estimated tokens into the actual fields.
  if (bucket.tokenActualCalls === 0 && bucket.tokenEstimatedCalls > 0 && !bucket.estInputTokens && !bucket.estOutputTokens) {
    bucket.estInputTokens = bucket.inputTokens;
    bucket.estOutputTokens = bucket.outputTokens;
    bucket.inputTokens = bucket.outputTokens = 0;
  }
  if (!bucket.calls) return null;
  return bucket;
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== USAGE_VERSION) return emptyState();
  const state = emptyState();
  if (raw.days && typeof raw.days === 'object' && !Array.isArray(raw.days)) {
    for (const [day, buckets] of Object.entries(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !buckets || typeof buckets !== 'object') continue;
      const safe = {};
      for (const value of Object.values(buckets)) {
        const bucket = normalizeBucket(value);
        if (!bucket) continue;
        const key = bucketKey(bucket);
        if (safe[key]) addSums(safe[key], bucket);
        else safe[key] = bucket;
      }
      if (Object.keys(safe).length) state.days[day] = safe;
    }
  }
  if (Array.isArray(raw.recent)) {
    state.recent = raw.recent.map(value => normalizeRecord(value, 0)).filter(record => record && record.at > 0);
    state.recent.sort((a, b) => b.at - a.at);
  }
  state.updatedAt = finite(raw.updatedAt) ?? 0;
  return state;
}

function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function histogramPercentile(sums, ratio) {
  const count = sums.latencyHist.reduce((total, value) => total + value, 0);
  if (!count) return null;
  const target = Math.ceil(count * ratio);
  let seen = 0;
  for (let index = 0; index < sums.latencyHist.length; index += 1) {
    seen += sums.latencyHist[index];
    if (seen >= target) return Math.min(LATENCY_BINS[index] ?? sums.latencyMsMax, sums.latencyMsMax || Infinity);
  }
  return sums.latencyMsMax || null;
}

function summarize(sums, records) {
  // Exact P95 when every timed call in scope is still in the recent window; otherwise
  // the persisted histogram gives an upper-bound estimate flagged as p95Exact=false.
  const latencies = records.map(record => record.latencyMs).filter(value => value !== undefined);
  const exact = latencies.length >= sums.latencyCount;
  const p95 = sums.latencyCount
    ? exact ? percentile(latencies.sort((a, b) => a - b), 0.95) : histogramPercentile(sums, 0.95)
    : null;
  return {
    calls: sums.calls,
    ok: sums.ok,
    error: sums.error,
    aborted: sums.aborted,
    successRate: sums.calls ? sums.ok / sums.calls : null,
    inputChars: sums.inputChars,
    outputChars: sums.outputChars,
    systemChars: sums.systemChars,
    historyChars: sums.historyChars,
    omittedChars: sums.omittedChars,
    inputBudgetMax: sums.inputBudgetMax || null,
    inputCharsUnknownCalls: sums.inputCharsUnknownCalls,
    inputTokens: sums.inputTokens,
    outputTokens: sums.outputTokens,
    reasoningTokens: sums.reasoningTokens,
    estimatedInputTokens: sums.estInputTokens,
    estimatedOutputTokens: sums.estOutputTokens,
    tokenActualCalls: sums.tokenActualCalls,
    tokenEstimatedCalls: sums.tokenEstimatedCalls,
    tokenUnknownCalls: sums.tokenUnknownCalls,
    avgLatencyMs: sums.latencyCount ? sums.latencyMsSum / sums.latencyCount : null,
    p95LatencyMs: p95,
    p95Exact: sums.latencyCount ? exact : null,
    avgTtftMs: sums.ttftCount ? sums.ttftMsSum / sums.ttftCount : null
  };
}

/**
 * Durable JSON file backend. Writes go to a temp file and are renamed into place so a
 * crash never leaves a half-written document. A corrupt file is moved aside once.
 */
export function createFileBackend(path) {
  return {
    path,
    load() {
      let raw;
      try { raw = readFileSync(path, 'utf8'); }
      catch (error) { if (error?.code === 'ENOENT') return { status: 'missing' }; return { status: 'unreadable', error: errorText(error) }; }
      try { return { status: 'ok', value: JSON.parse(raw.replace(/^\uFEFF/, '')) }; }
      catch (error) {
        try { renameSync(path, `${path}.corrupt-${Date.now()}`); } catch {}
        return { status: 'corrupt', error: errorText(error) };
      }
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(state), 'utf8');
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        throw error;
      }
    }
  };
}

export function createUsageStore({
  initial,
  persist,
  persistence: label = 'config',
  now = () => Date.now(),
  retentionDays = USAGE_RETENTION_DAYS,
  recentLimit = USAGE_RECENT_LIMIT,
  debounceMs = 800,
  retryMs = 5000
} = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const persistence = typeof persist === 'function' ? label : 'memory';
  let state = normalizeState(initial);
  let timer = null;
  let dirty = false;
  let writing = null;
  let failures = 0;
  let persistError = null;
  let persistedAt = null;
  let disposed = false;

  const cutoffDay = () => usageDayKey(shiftDays(localMidnight(clock()), -(retentionDays - 1)));
  const trim = () => {
    const cutoff = cutoffDay();
    for (const day of Object.keys(state.days)) if (day < cutoff) delete state.days[day];
    const cutoffAt = shiftDays(localMidnight(clock()), -(retentionDays - 1));
    state.recent = state.recent.filter(record => record.at >= cutoffAt);
    if (state.recent.length > recentLimit) state.recent.length = recentLimit;
  };
  trim();

  const write = async () => {
    if (!persist) return;
    while (writing) await writing;
    if (!dirty) return;
    dirty = false;
    const payload = clone(state);
    writing = (async () => {
      try {
        await persist(payload);
        persistError = null;
        persistedAt = clock();
        failures = 0;
      } catch (error) {
        persistError = errorText(error);
        dirty = true;
        failures += 1;
        if (!disposed && !timer) {
          timer = setTimeout(() => { timer = null; write(); }, Math.min(60000, retryMs * 2 ** (failures - 1)));
          timer.unref?.();
        }
      } finally {
        writing = null;
      }
    })();
    return writing;
  };

  const schedule = () => {
    dirty = true;
    if (!persist || disposed || timer) return;
    timer = setTimeout(() => { timer = null; write(); }, debounceMs);
    timer.unref?.();
  };
  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  const add = record => {
    const day = usageDayKey(record.at);
    if (!day || day < cutoffDay()) return false;
    const buckets = state.days[day] ?? (state.days[day] = {});
    const key = bucketKey(record);
    addRecord(buckets[key] ?? (buckets[key] = emptyBucket(record)), record);
    return true;
  };

  const filters = ({ range = '7d', platform, channel, includeTests = false, model } = {}) => {
    const selected = RANGES.has(range) ? range : '7d';
    const platformId = text(platform, 40);
    const channelId = text(channel, 40);
    const query = text(model).toLowerCase();
    const days = rangeDays(selected);
    const start = days === null ? null : shiftDays(localMidnight(clock()), -(days - 1));
    const tests = includeTests === true || channelId === 'test';
    const scope = row => (!platformId || row.platform === platformId) &&
      (!channelId || row.channel === channelId) &&
      (tests || row.channel !== 'test') &&
      (!query || String(row.model).toLowerCase().includes(query));
    return {
      range: selected,
      platform: platformId || null,
      channel: channelId || null,
      includeTests: tests,
      model: query || null,
      startDay: start === null ? null : usageDayKey(start),
      matchBucket: scope,
      matchRecord: record => (start === null || record.at >= start) && scope(record)
    };
  };

  const snapshot = (options = {}) => {
    const filter = filters(options);
    const limit = Math.max(1, Math.min(recentLimit, Math.floor(Number(options.limit)) || recentLimit));
    const current = clock();
    const today = localMidnight(current);
    const scoped = [];
    for (const [day, values] of Object.entries(state.days)) {
      if (filter.startDay && day < filter.startDay) continue;
      for (const bucket of Object.values(values)) if (filter.matchBucket(bucket)) scoped.push([day, bucket]);
    }
    const recentAll = state.recent.filter(filter.matchRecord);

    const group = (keyOf, init) => {
      const map = new Map();
      for (const [day, bucket] of scoped) {
        const key = keyOf(bucket, day);
        const row = map.get(key) ?? { ...init(bucket, day), sums: emptySums() };
        addSums(row.sums, bucket);
        map.set(key, row);
      }
      return map;
    };
    const totalSums = emptySums();
    for (const [, bucket] of scoped) addSums(totalSums, bucket);
    const totals = summarize(totalSums, recentAll);
    const share = calls => totals.calls ? calls / totals.calls : 0;

    const platforms = [...group(bucket => bucket.platform, bucket => ({ platform: bucket.platform })).values()]
      .map(row => {
        const values = summarize(row.sums, recentAll.filter(record => record.platform === row.platform));
        return { platform: row.platform, ...values, share: share(values.calls) };
      })
      .sort((a, b) => b.calls - a.calls);

    const models = [...group(
      bucket => [bucket.platform, bucket.model, bucket.effort ?? ''].join('\u0000'),
      bucket => ({ platform: bucket.platform, model: bucket.model, effort: bucket.effort ?? null })
    ).values()]
      .map(row => ({
        platform: row.platform,
        model: row.model,
        effort: row.effort,
        ...summarize(row.sums, recentAll.filter(record => record.platform === row.platform && record.model === row.model && (record.effort ?? null) === row.effort))
      }))
      .sort((a, b) => b.calls - a.calls || b.inputChars - a.inputChars);

    const channels = [...group(bucket => bucket.channel, bucket => ({ channel: bucket.channel })).values()]
      .map(row => {
        const values = summarize(row.sums, recentAll.filter(record => record.channel === row.channel));
        return { channel: row.channel, ...values, share: share(values.calls) };
      })
      .sort((a, b) => USAGE_CHANNELS.indexOf(a.channel) - USAGE_CHANNELS.indexOf(b.channel));

    const byDay = group((_bucket, day) => day, (_bucket, day) => ({ date: day }));
    const dayKeys = [];
    const span = rangeDays(filter.range);
    const first = span === null
      ? Object.keys(state.days).sort()[0]
      : usageDayKey(shiftDays(today, -(span - 1)));
    if (first) {
      const [year, month, date] = first.split('-').map(Number);
      for (let at = new Date(year, month - 1, date).getTime(); at <= today; at = shiftDays(at, 1)) dayKeys.push(usageDayKey(at));
    }
    const days = dayKeys.map(date => {
      const row = byDay.get(date);
      const values = summarize(row?.sums ?? emptySums(), []);
      return {
        date,
        calls: values.calls, ok: values.ok, error: values.error, aborted: values.aborted,
        inputChars: values.inputChars, outputChars: values.outputChars,
        systemChars: values.systemChars, historyChars: values.historyChars, omittedChars: values.omittedChars,
        inputTokens: values.inputTokens, outputTokens: values.outputTokens,
        estimatedInputTokens: values.estimatedInputTokens, estimatedOutputTokens: values.estimatedOutputTokens
      };
    });

    const latest = recentAll.find(record => record.inputBudget > 0);
    return {
      generatedAt: new Date(current).toISOString(),
      range: filter.range,
      filters: { platform: filter.platform, channel: filter.channel, includeTests: filter.includeTests, model: filter.model },
      persistence,
      persistError: persistError ?? undefined,
      persistedAt: persistedAt ? new Date(persistedAt).toISOString() : null,
      updatedAt: state.updatedAt ? new Date(state.updatedAt).toISOString() : null,
      totals,
      platforms,
      channels,
      days,
      models,
      lastContext: latest ? {
        at: latest.at, platform: latest.platform, model: latest.model,
        inputChars: latest.inputChars, inputBudget: latest.inputBudget,
        systemChars: latest.systemChars, historyChars: latest.historyChars, omittedChars: latest.omittedChars
      } : null,
      recent: clone(recentAll.slice(0, limit))
    };
  };

  return {
    get persistence() { return persistence; },
    record(input) {
      const record = normalizeRecord(input, clock());
      if (!record || !add(record)) return null;
      state.recent.unshift(record);
      if (state.recent.length > 1 && state.recent[1].at > record.at) state.recent.sort((a, b) => b.at - a.at);
      trim();
      state.updatedAt = clock();
      schedule();
      return clone(record);
    },
    /** Idempotently imports records by id; used to backfill gateway history kept elsewhere. */
    backfill(list) {
      if (!Array.isArray(list) || !list.length) return 0;
      const ids = new Set(state.recent.map(record => record.id));
      let imported = 0;
      for (const input of list) {
        const record = normalizeRecord(input, clock());
        if (!record || ids.has(record.id) || !add(record)) continue;
        ids.add(record.id);
        state.recent.push(record);
        imported += 1;
      }
      if (!imported) return 0;
      state.recent.sort((a, b) => b.at - a.at);
      trim();
      state.updatedAt = clock();
      schedule();
      return imported;
    },
    snapshot,
    reset(platform) {
      const target = text(platform, 40);
      if (target) {
        for (const [day, buckets] of Object.entries(state.days)) {
          for (const [key, bucket] of Object.entries(buckets)) if (bucket.platform === target) delete buckets[key];
          if (!Object.keys(buckets).length) delete state.days[day];
        }
        state.recent = state.recent.filter(record => record.platform !== target);
      } else {
        state = emptyState();
      }
      state.updatedAt = clock();
      dirty = true;
      clearTimer();
      return write().then(() => snapshot({ range: 'all', platform: target || undefined, includeTests: true }));
    },
    flush({ force = false } = {}) {
      if (force) dirty = true;
      clearTimer();
      return write();
    },
    /** Final flush is attempted even though no further retries will be scheduled. */
    dispose() {
      disposed = true;
      clearTimer();
      return write().catch(() => {});
    }
  };
}
