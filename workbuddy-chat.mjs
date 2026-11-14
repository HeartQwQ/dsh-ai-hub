// Native WorkBuddy CN chat-completions route: DSH requests in, DSH stream chunks out.
const FALLBACK_SYSTEM = 'You are a helpful assistant.';
const IDLE_TIMEOUT_MS = 180_000;
const CHANNEL_REJECTED = 11128;

export class WorkbuddyChatError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'WorkbuddyChatError';
    this.code = code;
    for (const [key, value] of Object.entries(extra)) if (value !== undefined) this[key] = value;
  }
}

const textOf = blocks => typeof blocks === 'string' ? blocks
  : Array.isArray(blocks) ? blocks.filter(block => block?.type === 'text').map(block => block.text ?? '').join('') : '';

function userContent(blocks) {
  if (typeof blocks === 'string') return blocks;
  const parts = [];
  for (const block of blocks ?? []) {
    switch (block?.type) {
      case 'text': if (block.text) parts.push(block.text); break;
      case 'image': parts.push('[image omitted: this route sends text only]'); break;
      case 'reasoning':
      case 'tool-call': break;
      default: throw new WorkbuddyChatError(`WorkBuddy cannot represent ${String(block?.type)} content`, 'UNSUPPORTED_CONTENT');
    }
  }
  return parts.join('\n');
}

function assistantMessage(message) {
  let content = '', reasoning = '';
  const calls = [];
  for (const block of message.content ?? []) {
    switch (block?.type) {
      case 'text': content += block.text ?? ''; break;
      case 'reasoning': reasoning += block.text ?? ''; break;
      case 'tool-call': calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments || '{}' } }); break;
      default: break;
    }
  }
  if (!content && !calls.length) return null;
  return { role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) };
}

/** Converts a DSH GenerateOptions request into the WorkBuddy chat-completions body. */
export function toChatBody(options, model = {}) {
  const head = [typeof options.system === 'string' ? options.system : textOf(options.system)];
  const messages = [];
  for (const message of options.messages ?? []) {
    switch (message?.role) {
      case 'system':
      case 'developer': {
        const text = textOf(message.content);
        if (!text) break;
        if (messages.length) messages.push({ role: 'system', content: text });
        else head.push(text);
        break;
      }
      case 'user': {
        const content = userContent(message.content);
        if (content) messages.push({ role: 'user', content });
        break;
      }
      case 'assistant': {
        const converted = assistantMessage(message);
        if (converted) messages.push(converted);
        break;
      }
      case 'tool': {
        const content = userContent(message.content);
        messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: content || (message.isError ? 'Error' : '(empty)') });
        break;
      }
      default: throw new WorkbuddyChatError(`WorkBuddy cannot represent message role ${String(message?.role)}`, 'UNSUPPORTED_CONTENT');
    }
  }
  const system = head.filter(Boolean).join('\n\n');
  const tools = (options.tools ?? []).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description ?? '', parameters: tool.parameters ?? { type: 'object', properties: {} } } }));
  const effort = options.reasoningEffort;
  const efforts = model.reasoning?.efforts?.map(row => row.id);
  return {
    model: options.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'system', content: system || FALLBACK_SYSTEM }, ...messages],
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.stop?.length ? { stop: options.stop } : {}),
    ...(effort && effort !== 'off' && (!efforts || efforts.includes(effort)) ? { reasoning_effort: effort } : {})
  };
}

function businessCode(detail) {
  const value = detail?.code ?? detail?.error?.code;
  const code = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;
  return code === 0 ? undefined : code;
}
function businessMessage(detail) {
  for (const value of [detail?.error?.message, detail?.displayMsg, detail?.msg, detail?.message, detail?.error]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** Maps HTTP and in-band WorkBuddy failures onto Harness failure codes. */
export function classifyFailure(status, raw, headers) {
  let detail = null;
  try { detail = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {}
  const code = businessCode(detail);
  const text = businessMessage(detail) || (typeof raw === 'string' ? raw.slice(0, 200) : '');
  const label = `WorkBuddy${status ? ` HTTP ${status}` : ''}${code !== undefined ? ` · ${code}` : ''}${text ? ` · ${text}` : ''}`;
  const retry = headers?.get?.('retry-after');
  const retryMs = retry == null ? NaN : /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
  const extra = { status: status || undefined, providerRetryAfterMs: Number.isFinite(retryMs) && retryMs > 0 ? retryMs : undefined };
  if (code === CHANNEL_REJECTED) return new WorkbuddyChatError(`WorkBuddy 渠道校验拒绝了本次请求（11128），网关不接受当前系统提示：${label}`, 'INVALID_REQUEST', extra);
  if (status === 401 || status === 403) return new WorkbuddyChatError(`WorkBuddy 凭据无效或已过期，请重新登录：${label}`, 'AUTH', extra);
  if (status === 402 || /quota|insufficient|额度|积分不足|余额/i.test(text)) return new WorkbuddyChatError(label, 'QUOTA', extra);
  if (status === 429 || /rate.?limit|too many|频繁|限流/i.test(text)) return new WorkbuddyChatError(label, 'RATE_LIMIT', extra);
  if (/context|too long|maximum.*tokens|超出.*长度/i.test(text) && (status === 400 || status === 413)) return new WorkbuddyChatError(label, 'CONTEXT_WINDOW_EXCEEDED', extra);
  if (status === 400 || status === 413 || status === 422) return new WorkbuddyChatError(label, 'INVALID_REQUEST', extra);
  if (!status || status >= 500) return new WorkbuddyChatError(label, 'SERVER', extra);
  return new WorkbuddyChatError(label, `HTTP_${status}`, extra);
}

async function* sseEvents(body, touch) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      touch();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') return;
        let event;
        try { event = JSON.parse(payload); } catch { throw new WorkbuddyChatError('WorkBuddy SSE contains invalid JSON', 'MALFORMED_RESPONSE'); }
        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function toUsage(raw) {
  const prompt = Number(raw?.prompt_tokens) || 0;
  const cached = Number(raw?.prompt_tokens_details?.cached_tokens ?? raw?.completion_tokens_details?.cached_tokens) || 0;
  const output = Number(raw?.completion_tokens) || 0;
  const reasoning = Number(raw?.completion_tokens_details?.reasoning_tokens) || 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: output,
    totalTokens: Number(raw?.total_tokens) || prompt + output,
    ...(cached ? { cacheReadTokens: cached } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {})
  };
}

function finishOf(raw, hasToolCalls) {
  switch (raw) {
    case 'length': return { kind: 'max-tokens' };
    case 'content_filter': throw new WorkbuddyChatError('WorkBuddy 内容审核中止了本次回复', 'CONTENT_FILTERED');
    default: return hasToolCalls ? { kind: 'tool-calls' } : { kind: 'stop' };
  }
}

/** Translates WorkBuddy SSE events into Harness stream chunks. */
export async function* translateEvents(events) {
  let next = 0, open = null, usage, finishReason, sawEvent = false;
  const calls = new Map();
  const closeOpen = function* () {
    if (!open) return;
    yield { type: 'block-end', index: open.index, block: { type: open.type, text: open.text } };
    open = null;
  };
  const appendText = function* (type, text) {
    if (open?.type !== type) {
      yield* closeOpen();
      open = { type, index: next++, text: '' };
      yield { type: 'block-start', index: open.index, blockType: type };
    }
    open.text += text;
    yield { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: open.index, text };
  };
  for await (const event of events) {
    sawEvent = true;
    if (event?.error || (businessCode(event) !== undefined && !Array.isArray(event?.choices))) throw classifyFailure(0, event);
    if (event?.usage && typeof event.usage === 'object') usage = toUsage(event.usage);
    const choice = Array.isArray(event?.choices) ? event.choices[0] : undefined;
    if (!choice) continue;
    const delta = choice.delta ?? {};
    const reasoning = [delta.reasoning_content, delta.reasoning, delta.reasoning_text].find(value => typeof value === 'string' && value.length);
    if (reasoning) yield* appendText('reasoning', reasoning);
    if (typeof delta.content === 'string' && delta.content.length) yield* appendText('text', delta.content);
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const key = Number.isInteger(call?.index) ? call.index : call?.id ?? calls.size;
      let state = calls.get(key);
      if (!state) {
        yield* closeOpen();
        state = { index: next++, id: call?.id || `call_${Date.now().toString(36)}_${calls.size}`, name: call?.function?.name || '', args: '' };
        calls.set(key, state);
        yield { type: 'block-start', index: state.index, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: state.index, id: state.id, ...(state.name ? { name: state.name } : {}), argumentsDelta: '' };
      } else if (!state.name && call?.function?.name) {
        state.name = call.function.name;
        yield { type: 'tool-call-delta', index: state.index, id: state.id, name: state.name, argumentsDelta: '' };
      }
      const args = typeof call?.function?.arguments === 'string' ? call.function.arguments : '';
      if (args) {
        state.args += args;
        yield { type: 'tool-call-delta', index: state.index, id: state.id, argumentsDelta: args };
      }
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason;
  }
  if (!sawEvent) throw new WorkbuddyChatError('WorkBuddy stream ended without any event', 'STREAM_CLOSED');
  yield* closeOpen();
  for (const state of calls.values()) {
    if (!state.name) throw new WorkbuddyChatError('WorkBuddy returned a tool call without a name', 'MALFORMED_RESPONSE');
    yield { type: 'block-end', index: state.index, block: { type: 'tool-call', id: state.id, name: state.name, arguments: state.args || '{}' } };
  }
  if (next === 0) throw new WorkbuddyChatError('WorkBuddy returned an empty response', 'EMPTY_RESPONSE');
  if (usage) yield { type: 'usage', usage };
  yield { type: 'finish', reason: finishOf(finishReason, calls.size > 0) };
}

/** One request: POST, check the answer, translate its SSE with an idle watchdog. */
export async function* streamChat(openChat, body, signal) {
  const idle = new AbortController();
  let timer;
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new WorkbuddyChatError(`WorkBuddy stream idle for ${IDLE_TIMEOUT_MS / 1000}s`, 'STREAM_CLOSED')), IDLE_TIMEOUT_MS); };
  const combined = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
  touch();
  try {
    const response = await openChat(body, { signal: combined });
    if (!response.ok) throw classifyFailure(response.status, await response.text().catch(() => ''), response.headers);
    if (!response.body) throw new WorkbuddyChatError('WorkBuddy chat returned no body', 'STREAM_CLOSED');
    if (!/event-stream/i.test(response.headers.get('content-type') ?? '')) throw classifyFailure(response.status, await response.text().catch(() => ''), response.headers);
    yield* translateEvents(sseEvents(response.body, touch));
  } catch (error) {
    if (idle.signal.aborted && !signal?.aborted) throw idle.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Harness LLM adapter for the `workbuddy-cn` provider. */
export function createWorkbuddyAdapter({ hub, client, provider = 'workbuddy-cn', name = 'WorkBuddy CN', meter = stream => stream }) {
  const check = () => { if (!hub.settings()[provider]?.enabled) throw new WorkbuddyChatError('DISABLED / 平台已禁用', 'PROVIDER_DISABLED'); };
  const resolve = async (_provider, id) => {
    let info = null;
    try { info = (await hub.catalog(provider)).find(model => model.id === id) ?? null; } catch {}
    return {
      provider, id, name: info?.name ?? id,
      context: { contextWindow: info?.contextWindow ?? 200000 },
      defaultMaxTokens: info?.maxOutput ?? 32768,
      inputModalities: ['text'],
      ...(info?.badge ? { badge: info.badge } : {}),
      ...(info?.reasoning ? { reasoning: info.reasoning } : {})
    };
  };
  const run = (options, model) => {
    check();
    const request = { ...options, model: model.id };
    if (typeof hub.mcpStream === 'function' && ((Array.isArray(options?.tools) && options.tools.length > 0) || Boolean(hub.hasMcpSession?.(options?.messages)))) {
      return hub.mcpStream(provider, request);
    }
    if (typeof hub.mcpStream !== 'function') {
      return meter(streamChat(client.openChat, toChatBody(request, model), options.signal), request);
    }
    return (async function* () {
      const primary = streamChat(client.openChat, toChatBody(request, model), options.signal);
      const iter = primary[Symbol.asyncIterator]();
      let first;
      try {
        first = await iter.next();
      } catch (error) {
        await iter.return?.().catch(() => {});
        if (error?.code === 'INVALID_REQUEST' && /11128/.test(String(error?.message ?? ''))) {
          yield* hub.mcpStream(provider, request);
          return;
        }
        yield* meter((async function* () { throw error; })(), request);
        return;
      }
      const resumed = (async function* () {
        try {
          if (!first.done) yield first.value;
          for (;;) {
            const next = await iter.next();
            if (next.done) break;
            yield next.value;
          }
        } finally {
          await iter.return?.().catch(() => {});
        }
      })();
      yield* meter(resumed, request);
    })();
  };
  return {
    providerInfo: () => ({ id: provider, name }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_p, _m, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    listModels: () => hub.visibleModels(provider),
    resolveModel: resolve,
    async prepareCall(_provider, id, signal) {
      signal?.throwIfAborted();
      const model = await resolve(provider, id);
      return { model, stream: options => run({ ...options, signal: options.signal ?? signal }, model) };
    },
    stream: options => (async function* () { yield* run(options, await resolve(provider, options.model)); })()
  };
}
