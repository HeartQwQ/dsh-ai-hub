import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { selectModels } from './catalog.mjs';

const PROVIDERS = {
  deepseek: { id: 'deepseek', name: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com/v1' },
  custom: { id: 'custom', name: '自定义 OpenAI 兼容', defaultBaseUrl: '' }
};
const MAX_USAGE = 500;
const clone = value => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
// Refs are POSIX identifiers, unlike the two-segment keys used by readRecord.
// Validate at our boundary: this Harness release accepts invalid refs on write
// but rejects the entire credential document when it next starts.
const credentialRef = value => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new TypeError('Invalid AI Hub credential reference');
  return value;
};
const KEY_REF = id => credentialRef(`AI_HUB_ACCOUNT_${Buffer.from(id, 'utf8').toString('hex').toUpperCase()}_API_KEY`);
const GATEWAY_REF = credentialRef('AI_HUB_GATEWAY_KEY');
const hasProvider = id => Object.hasOwn(PROVIDERS, id);
const serial = () => {
  let tail = Promise.resolve();
  return operation => {
    const task = tail.then(operation);
    tail = task.catch(() => {});
    return task;
  };
};

function normalizeBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('baseUrl must be http(s)');
    if (url.username || url.password || url.search || url.hash) return '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

const partText = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('') : '';
const requestChars = body => Array.isArray(body.messages)
  ? body.messages.reduce((sum, message) => sum + partText(message?.content).length, 0)
  : partText(body.input).length;
const systemChars = body => Array.isArray(body.messages)
  ? body.messages.reduce((sum, message) => sum + (['system', 'developer'].includes(message?.role) ? partText(message.content).length : 0), 0)
  : 0;
const responseChars = payload => Array.isArray(payload.choices)
  ? payload.choices.reduce((sum, choice) => sum + partText(choice?.message?.content).length, 0)
  : 0;
const usageNumbers = usage => {
  const value = key => Number.isFinite(usage?.[key]) ? usage[key] : undefined;
  const promptTokens = value('prompt_tokens');
  const completionTokens = value('completion_tokens');
  const reasoningTokens = Number.isFinite(usage?.completion_tokens_details?.reasoning_tokens) ? usage.completion_tokens_details.reasoning_tokens : undefined;
  const tokens = value('total_tokens') ?? ((promptTokens ?? 0) + (completionTokens ?? 0) || null);
  return { tokens, promptTokens, completionTokens, reasoningTokens, tokenSource: promptTokens !== undefined || completionTokens !== undefined ? 'actual' : 'unknown' };
};

const isAbortError = (error, depth = 0) => Boolean(error) && depth < 4 && (
  error.name === 'AbortError' || error.code === 20 || error.code === 'ABORT_ERR' || error.code === 'ERR_STREAM_PREMATURE_CLOSE'
  || (Array.isArray(error.errors) && error.errors.some(item => isAbortError(item, depth + 1)))
  || isAbortError(error.cause, depth + 1)
);

/** Pass-through SSE observer: counts streamed answer characters and keeps the final usage chunk. */
function sseMeter() {
  const decoder = new TextDecoder();
  let buffer = '';
  const meter = { firstAt: null, outputChars: 0, usage: null };
  const scan = line => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const json = JSON.parse(data);
      for (const choice of Array.isArray(json?.choices) ? json.choices : []) {
        if (typeof choice?.delta?.content === 'string') meter.outputChars += choice.delta.content.length;
      }
      if (json?.usage && typeof json.usage === 'object') meter.usage = json.usage;
    } catch {}
  };
  meter.stream = new Transform({
    transform(chunk, _encoding, done) {
      if (meter.firstAt === null) meter.firstAt = Date.now();
      buffer += decoder.decode(chunk, { stream: true });
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        scan(buffer.slice(0, index).replace(/\r$/, ''));
        buffer = buffer.slice(index + 1);
      }
      if (buffer.length > 1024 * 1024) buffer = '';
      done(null, chunk);
    },
    flush(done) { scan(buffer.trim()); done(); }
  });
  return meter;
}

function loadState(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const providers = {};
  for (const id of Object.keys(PROVIDERS)) {
    providers[id] = { baseUrl: normalizeBaseUrl(raw.providers?.[id]?.baseUrl) || PROVIDERS[id].defaultBaseUrl };
  }
  const accounts = Array.isArray(raw.accounts) ? raw.accounts.filter(account =>
    account && typeof account === 'object' &&
    hasProvider(account.providerId) &&
    typeof account.id === 'string' && /^[\w.-]{1,80}$/.test(account.id)
  ).map(account => ({
    id: account.id,
    providerId: account.providerId,
    label: String(account.label || '').slice(0, 60) || '账号',
    keyTail: String(account.keyTail || '').slice(-4),
    createdAt: String(account.createdAt || now()),
    enabled: account.enabled !== false
  })) : [];
  const visibleModels = {};
  for (const id of Object.keys(PROVIDERS)) {
    visibleModels[id] = Array.isArray(raw.visibleModels?.[id]) ? raw.visibleModels[id].filter(x => typeof x === 'string').slice(0, 500) : [];
  }
  return {
    accounts,
    providers,
    visibleModels,
    gateway: { enabled: raw.gateway?.enabled !== false }
  };
}

export function createP0({ config = {}, save, credentials, webServer, fetchImpl = globalThis.fetch, requestTimeoutMs = 120000, onUsage, readUsage } = {}) {
  let state = loadState(config);
  const usage = [];
  const cache = new Map();
  const mutate = serial();
  const keyOperation = serial();
  const lifetime = new AbortController();
  const modelPending = new Map();
  const withResponse = async (url, options, timeoutMs, consume) => {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new DOMException('Upstream timed out', 'TimeoutError')), timeoutMs);
    timer.unref?.();
    const signal = AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : []), timeout.signal]);
    let response;
    try {
      signal.throwIfAborted();
      response = await fetchImpl(url, { ...options, redirect: 'error', signal });
      return await consume(response, signal);
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  };

  const persist = async candidate => {
    lifetime.signal.throwIfAborted();
    if (!save) throw new Error('Config editor unavailable');
    await save(clone(candidate));
    state = candidate;
    cache.clear();
    modelPending.clear();
    quotaCache.clear();
  };
  const requireCredentials = () => {
    lifetime.signal.throwIfAborted();
    if (!credentials || typeof credentials.set !== 'function' || typeof credentials.resolve !== 'function' || typeof credentials.unset !== 'function') {
      throw new Error('DSH credentials service unavailable');
    }
    return credentials;
  };
  const accountKey = async account => {
    const resolved = await requireCredentials().resolve(KEY_REF(account.id));
    if (!resolved?.value) throw new Error('账号 Key 不存在，请重新添加');
    return resolved.value;
  };
  const providerBase = providerId => {
    const base = normalizeBaseUrl(state.providers[providerId]?.baseUrl);
    if (!base) throw new Error('请先设置该平台的 Base URL');
    return base;
  };
  const accountsFor = providerId => state.accounts.filter(account => account.providerId === providerId && account.enabled);
  const providers = () => Object.keys(PROVIDERS).map(id => {
    const list = accountsFor(id);
    return {
      id,
      name: PROVIDERS[id].name,
      baseUrl: state.providers[id]?.baseUrl || '',
      accountCount: list.length,
      enabled: list.length > 0,
      state: list.length ? 'connected' : 'unconfigured'
    };
  });
  const accounts = providerId => state.accounts.filter(account => !providerId || account.providerId === providerId).map(account => ({
    id: account.id,
    providerId: account.providerId,
    label: account.label,
    keyMasked: account.keyTail ? `••••${account.keyTail}` : '••••',
    enabled: account.enabled,
    createdAt: account.createdAt
  }));
  const ensureGatewayKey = () => keyOperation(async () => {
    const creds = requireCredentials();
    const existing = await creds.resolve(GATEWAY_REF);
    if (existing?.value) return existing.value;
    const key = 'sk-hub-' + randomUUID().replace(/-/g, '');
    await creds.set(GATEWAY_REF, key);
    return key;
  });
  const gatewayInfo = async () => {
    const key = await ensureGatewayKey();
    const origin = webServer?.getOrigin?.() ?? '';
    return {
      enabled: state.gateway.enabled,
      baseUrl: origin + '/plugins/dsh-ai-hub/gateway/v1',
      keyMasked: 'sk-hub-••••' + key.slice(-4),
      path: '/plugins/dsh-ai-hub/gateway/v1'
    };
  };
  const rotateGatewayKey = () => keyOperation(async () => {
    const key = 'sk-hub-' + randomUUID().replace(/-/g, '');
    await requireCredentials().set(GATEWAY_REF, key);
    return { key, keyMasked: 'sk-hub-••••' + key.slice(-4) };
  });
  const addAccount = input => mutate(async () => {
    const providerId = String(input?.providerId || '');
    if (!hasProvider(providerId)) throw new Error('未知平台');
    const apiKey = String(input?.apiKey || '').trim();
    if (!apiKey || apiKey.length > 8192) throw new Error('API Key 必须为 1..8192 字符');
    const candidate = clone(state);
    if (providerId === 'custom') {
      const baseUrl = normalizeBaseUrl(input?.baseUrl);
      if (!baseUrl) throw new Error('自定义平台需要合法 http(s) Base URL');
      if (candidate.accounts.some(account => account.providerId === 'custom') && candidate.providers.custom.baseUrl !== baseUrl) {
        throw new Error('自定义平台的账号必须使用相同 Base URL；请先移除原有账号');
      }
      candidate.providers.custom.baseUrl = baseUrl;
    }
    const id = 'acct-' + randomUUID();
    await requireCredentials().set(KEY_REF(id), apiKey);
    const account = {
      id,
      providerId,
      label: String(input?.label || '').trim().slice(0, 60) || (PROVIDERS[providerId].name + ' 账号'),
      keyTail: apiKey.slice(-4),
      createdAt: now(),
      enabled: true
    };
    candidate.accounts.push(account);
    try { await persist(candidate); }
    catch (error) {
      try { await requireCredentials().unset(KEY_REF(id)); }
      catch { throw new Error('账号保存失败，临时凭据清理也失败；请检查凭据服务', { cause: error }); }
      throw error;
    }
    return accounts(providerId);
  });
  const deleteAccount = id => mutate(async () => {
    const candidate = clone(state);
    const index = candidate.accounts.findIndex(account => account.id === id);
    if (index < 0) throw new Error('账号不存在');
    const [account] = candidate.accounts.splice(index, 1);
    if (!candidate.accounts.some(row => row.providerId === account.providerId && row.enabled)) {
      candidate.visibleModels[account.providerId] = [];
      if (account.providerId === 'custom') candidate.providers.custom.baseUrl = '';
    }
    await persist(candidate);
    try { await requireCredentials().unset(KEY_REF(account.id)); }
    catch { throw new Error('账号删除已保存，但凭据清理失败；请检查凭据服务'); }
    return accounts(account.providerId);
  });
  const refreshModels = async providerId => {
    if (!hasProvider(providerId)) throw new Error('未知平台');
    const list = accountsFor(providerId);
    if (!list.length) throw new Error('该平台还没有账号');
    const originalState = state;
    const baseUrl = providerBase(providerId);
    let lastError;
    for (const account of list) {
      try {
        const key = await accountKey(account);
        const data = await withResponse(baseUrl + '/models', {
          headers: { authorization: 'Bearer ' + key }
        }, 20000, async response => {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        });
        if (!Array.isArray(data?.data)) throw new Error('模型目录响应缺少 data 数组');
        const rows = data.data;
        const models = rows.map(row => ({
          id: typeof row?.id === 'string' ? row.id : '',
          name: String(row?.name ?? row?.id ?? ''),
          ownedBy: String(row?.owned_by ?? row?.ownedBy ?? '')
        })).filter(row => row.id);
        const result = { models, at: now(), account: account.label };
        // A settings/account change while loading must not repopulate old data.
        if (state === originalState) cache.set(providerId, result);
        return clone(result);
      } catch (error) {
        lastError = error;
        if (lifetime.signal.aborted) throw error;
      }
    }
    throw new Error('模型目录读取失败：' + String(lastError?.message ?? lastError));
  };
  const models = async (providerId, refresh = false) => {
    if (!hasProvider(providerId)) throw new Error('未知平台');
    const cached = cache.get(providerId);
    if (!refresh && cached && Date.now() - Date.parse(cached.at) < 600000) return clone(cached);
    if (!modelPending.has(providerId)) {
      const task = refreshModels(providerId).finally(() => { if (modelPending.get(providerId) === task) modelPending.delete(providerId); });
      modelPending.set(providerId, task);
    }
    return clone(await modelPending.get(providerId));
  };
  const visibleModels = providerId => {
    if (!hasProvider(providerId)) throw new Error('未知平台');
    const ids = state.visibleModels[providerId] || [];
    return [...ids];
  };
  const reorderAccounts = ids => mutate(async () => {
    const wanted = Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [];
    if (!wanted.length) throw new Error('账号顺序为空');
    const existing = new Map(state.accounts.map(account => [account.id, account]));
    const next = [];
    for (const id of wanted) {
      const account = existing.get(id);
      if (!account) continue;
      next.push(account);
      existing.delete(id);
    }
    next.push(...existing.values());
    await persist({ ...clone(state), accounts: next });
    return accounts();
  });
  const testProvider = async providerId => {
    if (!hasProvider(providerId)) throw new Error('未知平台');
    const list = accountsFor(providerId);
    if (!list.length) throw new Error('该平台还没有账号');
    const started = Date.now();
    const result = await refreshModels(providerId);
    return { ok: true, providerId, latencyMs: Date.now() - started, modelCount: result.models.length, checkedAt: now() };
  };
  const quotaCache = new Map();
  const quota = async (providerId, refresh = false) => {
    if (!hasProvider(providerId)) throw new Error('未知平台');
    const cached = quotaCache.get(providerId);
    if (!refresh && cached && Date.now() - cached.at < 60000) return clone(cached.value);
    const originalState = state;
    const list = accountsFor(providerId);
    if (!list.length) return { providerId, kind: 'unknown', source: 'unconfigured', updatedAt: now(), stale: false, error: { code: 'AUTH_MISSING', message: '该平台还没有账号' } };
    if (providerId !== 'deepseek') {
      const value = { providerId, kind: 'unknown', source: 'not-available', updatedAt: now(), stale: false, note: '自定义平台没有统一余额接口' };
      if (state === originalState) quotaCache.set(providerId, { at: Date.now(), value });
      return clone(value);
    }
    const account = list[0];
    try {
      const key = await accountKey(account);
      const base = providerBase(providerId).replace(/\/v1$/, '');
      const data = await withResponse(base + '/user/balance', { headers: { authorization: 'Bearer ' + key } }, 15000, async response => {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      });
      const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : null;
      const value = {
        providerId,
        kind: 'credits',
        source: 'deepseek-balance',
        updatedAt: now(),
        stale: false,
        available: data?.is_available !== false,
        currency: info?.currency || 'CNY',
        remaining: info?.total_balance != null ? Number(info.total_balance) : null,
        granted: info?.granted_balance != null ? Number(info.granted_balance) : null,
        toppedUp: info?.topped_up_balance != null ? Number(info.topped_up_balance) : null
      };
      if (state === originalState) quotaCache.set(providerId, { at: Date.now(), value });
      return clone(value);
    } catch (error) {
      const value = { providerId, kind: 'unknown', source: 'deepseek-balance', updatedAt: now(), stale: true, error: { code: 'QUOTA_ERROR', message: String(error?.message ?? error) } };
      if (state === originalState) quotaCache.set(providerId, { at: Date.now(), value });
      return clone(value);
    }
  };

  const setVisibleModels = (providerId, ids) => mutate(async () => {
    if (!hasProvider(providerId)) throw new Error('未知平台');
    const candidate = clone(state);
    candidate.visibleModels[providerId] = [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id.length <= 160))].slice(0, 500);
    await persist(candidate);
    return visibleModels(providerId);
  });
  const setGatewayEnabled = enabled => mutate(async () => {
    if (typeof enabled !== 'boolean') throw new Error('enabled 必须为布尔值');
    await persist({ ...clone(state), gateway: { enabled } });
    return gatewayInfo();
  });
  const gatewayModels = async () => {
    const result = [];
    for (const providerId of Object.keys(PROVIDERS)) {
      if (!accountsFor(providerId).length) continue;
      try {
        const catalog = await models(providerId);
        const ids = visibleModels(providerId);
        for (const model of selectModels(catalog.models, ids).models) {
          result.push({ id: `${providerId}/${model.id}`, object: 'model', created: 0, owned_by: providerId, name: model.name || model.id });
        }
      } catch {}
    }
    return result;
  };
  const recordUsage = entry => {
    const record = { id: randomUUID(), time: now(), ...entry };
    usage.unshift(record);
    if (usage.length > MAX_USAGE) usage.length = MAX_USAGE;
    try { onUsage?.(record); } catch {}
  };
  const readRecent = limit => {
    if (readUsage) { try { return clone(readUsage(limit)); } catch {} }
    return clone(usage.slice(0, limit));
  };
  const parseModel = value => {
    const raw = String(value || '');
    if (!raw) throw new Error('model is required');
    const slash = raw.indexOf('/');
    const providerId = slash > 0 ? raw.slice(0, slash) : 'deepseek';
    const modelId = slash > 0 ? raw.slice(slash + 1) : raw;
    if (!hasProvider(providerId) || !modelId) throw new Error('未知模型');
    return { providerId, modelId, publicId: `${providerId}/${modelId}` };
  };
  const gatewayAuth = async req => {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return false;
    const expected = await ensureGatewayKey();
    const supplied = Buffer.from(token);
    const wanted = Buffer.from(expected);
    return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
  };
  const gatewayError = (res, status, message, code = 'GATEWAY_ERROR') => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: { message, type: 'ai_hub_gateway_error', code } }));
  };
  const handleGateway = async (req, res) => {
    if (!state.gateway.enabled) return gatewayError(res, 404, 'AI HUB gateway is disabled');
    const disconnected = new AbortController();
    const cancel = () => { if (!res.writableEnded) disconnected.abort(); };
    req.once?.('aborted', cancel);
    res.once?.('close', cancel);
    try {
      if (!(await gatewayAuth(req))) return gatewayError(res, 401, 'Missing or invalid gateway key', 'GATEWAY_UNAUTHORIZED');
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/^\/plugins\/dsh-ai-hub\/gateway/, '');
      if (req.method === 'GET' && path === '/v1/models') {
        const data = await gatewayModels();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ object: 'list', data }));
        return;
      }
      if (req.method === 'POST' && path === '/v1/chat/completions') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > 32 * 1024 * 1024) return gatewayError(res, 413, 'Request body too large', 'GATEWAY_LIMIT');
          chunks.push(bytes);
        }
        let body, parsed;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected object');
          if (typeof body.model !== 'string') throw new Error('Invalid model');
          if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new Error('Invalid stream');
          parsed = parseModel(body.model);
        } catch { return gatewayError(res, 400, 'Invalid chat request or model', 'INVALID_REQUEST'); }
        const candidates = accountsFor(parsed.providerId);
        if (!candidates.length) return gatewayError(res, 503, 'No account for ' + parsed.providerId, 'ROUTE_NO_CANDIDATE');
        const started = Date.now();
        const callFields = { provider: parsed.providerId, model: parsed.modelId, requestedModel: body.model, effort: typeof body.reasoning_effort === 'string' ? body.reasoning_effort : null, inputChars: requestChars(body), systemChars: systemChars(body) };
        let lastError;
        for (const account of candidates) {
          let meter = null;
          try {
            const key = await accountKey(account);
            const outcome = await withResponse(providerBase(parsed.providerId) + '/chat/completions', {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
              body: JSON.stringify({ ...body, model: parsed.modelId }),
              signal: disconnected.signal
            }, requestTimeoutMs, async (response, signal) => {
            if (!response.ok) {
              lastError = { status: response.status, message: 'Upstream HTTP ' + response.status };
              if ([401, 403, 429].includes(response.status) || response.status >= 500) return 'retry';
              recordUsage({ ...callFields, account: account.id, status: response.status, latencyMs: Date.now() - started, outputChars: 0, tokenSource: 'unknown', source: 'gateway' });
              gatewayError(res, response.status, lastError.message, 'UPSTREAM_ERROR');
              return 'done';
            }
            if (body.stream) {
              if (!response.body) throw new Error('Upstream returned no stream');
              res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
                'x-ai-hub-provider': parsed.providerId,
                'x-ai-hub-account': account.id
              });
              meter = sseMeter();
              await pipeline(response.body, meter.stream, res, { signal });
              recordUsage({ ...callFields, account: account.id, status: 200, latencyMs: Date.now() - started, ttftMs: meter.firstAt === null ? null : meter.firstAt - started, outputChars: meter.outputChars, ...usageNumbers(meter.usage), source: 'gateway-stream' });
              return 'done';
            }
            const payload = await response.json();
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid upstream JSON');
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'x-ai-hub-provider': parsed.providerId,
              'x-ai-hub-account': account.id
            });
            res.end(JSON.stringify(payload));
            recordUsage({ ...callFields, account: account.id, status: 200, latencyMs: Date.now() - started, outputChars: responseChars(payload), ...usageNumbers(payload.usage), source: 'gateway' });
            return 'done';
            });
            if (outcome === 'done') return;
          } catch (error) {
            const partial = () => ({ ...callFields, account: account.id, latencyMs: Date.now() - started, ttftMs: meter?.firstAt == null ? null : meter.firstAt - started, outputChars: meter?.outputChars ?? 0, ...usageNumbers(meter?.usage), source: meter ? 'gateway-stream' : 'gateway' });
            // A failed pipeline closes `res` itself, so the disconnect flag alone cannot tell who stopped the call.
            const clientStopped = lifetime.signal.aborted || (disconnected.signal.aborted && isAbortError(error));
            if (disconnected.signal.aborted || lifetime.signal.aborted) { recordUsage({ ...partial(), status: clientStopped ? 'aborted' : 502 }); res.destroy(); return; }
            // Once bytes were sent, retrying would splice two answers together.
            if (res.headersSent) { recordUsage({ ...partial(), status: 502 }); res.destroy(); return; }
            lastError = { status: error?.name === 'TimeoutError' ? 504 : 502, message: error?.name === 'TimeoutError' ? 'Upstream timed out' : 'Upstream request failed' };
          }
        }
        recordUsage({ ...callFields, account: null, status: Number(lastError?.status) >= 400 ? Number(lastError.status) : 502, latencyMs: Date.now() - started, outputChars: 0, tokenSource: 'unknown', source: 'gateway' });
        return gatewayError(res, Number(lastError?.status) >= 400 ? Number(lastError.status) : 502, 'All candidates failed: ' + String(lastError?.message || 'unknown'), 'ROUTE_FAILED');
      }
      return gatewayError(res, 404, 'Not found', 'NOT_FOUND');
    } catch (error) {
      return gatewayError(res, 500, 'Gateway operation failed', 'GATEWAY_ERROR');
    } finally {
      req.off?.('aborted', cancel);
      res.off?.('close', cancel);
    }
  };
  const dispatch = async (action, args = {}) => {
    switch (action) {
      case 'p0Snapshot': {
        return {
          providers: providers(),
          accounts: accounts(),
          visibleModels: clone(state.visibleModels),
          usage: readRecent(50)
        };
      }
      case 'p0Providers': return providers();
      case 'p0Accounts': return accounts(args.providerId);
      case 'p0AddAccount': return addAccount(args);
      case 'p0DeleteAccount': return deleteAccount(String(args.id ?? ''));
      case 'p0ReorderAccounts': return reorderAccounts(args.ids);
      case 'p0Test': return testProvider(String(args.providerId ?? ''));
      case 'p0Quota': return quota(String(args.providerId ?? ''), Boolean(args.refresh));
      case 'p0Models': return models(String(args.providerId ?? ''), Boolean(args.refresh));
      case 'p0VisibleModels': return { visible: visibleModels(String(args.providerId ?? '')) };
      case 'p0SetVisibleModels': return setVisibleModels(String(args.providerId ?? ''), args.ids);
      case 'p0Gateway': return gatewayInfo();
      case 'p0SetGateway': return setGatewayEnabled(args.enabled);
      case 'p0RotateGatewayKey': return rotateGatewayKey();
      case 'p0Usage': return { usage: readRecent(Math.max(1, Math.min(MAX_USAGE, Number(args.limit) || 50))) };
      default: throw new Error('Unknown AI HUB action');
    }
  };
  return {
    handleGateway,
    dispatch,
    dispose: () => lifetime.abort(),
    memoryUsage: () => clone(usage),
    service: {
      providers,
      accounts,
      models,
      gateway: gatewayInfo,
      setGatewayEnabled,
      rotateGatewayKey,
      visibleModels,
      setVisibleModels,
      reorderAccounts,
      testProvider,
      quota,
      usage: () => readRecent(50)
    }
  };
}
