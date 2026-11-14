import test from 'node:test';
import assert from 'node:assert/strict';
import { toChatBody, translateEvents, classifyFailure, createWorkbuddyAdapter } from './workbuddy-chat.mjs';

const frame = (delta, extra = {}) => ({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '', reasoning_content: '', tool_calls: [], ...delta }, finish_reason: '' , ...extra.choice }], usage: null, ...extra.top });
async function* from(events) { for (const event of events) yield event; }
async function collect(iterable) { const out = []; for await (const chunk of iterable) out.push(chunk); return out; }
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

test('toChatBody maps system, history, tool calls, tool results and tools', () => {
  const body = toChatBody({
    model: 'hy4free',
    system: 'SYS',
    reasoningEffort: 'high',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: '' }, { type: 'tool-call', id: 'c1', name: 'get_weather', arguments: '{"city":"SZ"}' }] },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'sunny' }] },
      { role: 'developer', content: [{ type: 'text', text: 'late note' }, { type: 'tool-addition', toolName: 'x' }] }
    ],
    tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } }]
  }, { reasoning: { efforts: [{ id: 'high', name: '高' }] } });
  assert.equal(body.stream, true);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.reasoning_effort, 'high');
  assert.deepEqual(body.messages[0], { role: 'system', content: 'SYS' });
  assert.deepEqual(body.messages[2], { role: 'assistant', content: '', reasoning_content: 'think', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SZ"}' } }] });
  assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 'c1', content: 'sunny' });
  assert.deepEqual(body.messages[4], { role: 'system', content: 'late note' });
  assert.equal(body.tools[0].function.name, 'get_weather');
});

test('toChatBody guarantees a leading system message and drops unsupported efforts', () => {
  const body = toChatBody({ model: 'hy4free', reasoningEffort: 'medium', messages: [{ role: 'user', content: 'hi' }] }, { reasoning: { efforts: [{ id: 'high', name: '高' }] } });
  assert.equal(body.messages[0].role, 'system');
  assert.ok(body.messages[0].content.length > 0);
  assert.equal('reasoning_effort' in body, false);
  assert.equal('tools' in body, false);
});

test('translateEvents assembles hy4free reasoning and index-keyed tool call deltas', async () => {
  const chunks = await collect(translateEvents(from([
    frame({ role: 'assistant' }),
    frame({ reasoning_content: 'Okay' }),
    frame({ reasoning_content: ', call it.' }),
    frame({ tool_calls: [{ id: 'chatcmpl-tool-1', type: 'function', function: { name: 'get_weather', arguments: '' }, index: 0 }] }),
    frame({ tool_calls: [{ function: { name: '', arguments: '{"city": "Shenzhen"' }, index: 0 }] }),
    frame({ tool_calls: [{ function: { name: '', arguments: '}' }, index: 0 }] }),
    frame({ function_call: { name: '', arguments: '' } }, { choice: { finish_reason: 'tool_calls' }, top: { usage: { prompt_tokens: 235, completion_tokens: 207, total_tokens: 442, completion_tokens_details: { reasoning_tokens: 190, cached_tokens: 0 } } } })
  ])));
  const ends = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block);
  assert.deepEqual(ends, [
    { type: 'reasoning', text: 'Okay, call it.' },
    { type: 'tool-call', id: 'chatcmpl-tool-1', name: 'get_weather', arguments: '{"city": "Shenzhen"}' }
  ]);
  assert.ok(chunks.filter(chunk => chunk.type === 'tool-call-delta').every(chunk => chunk.id === 'chatcmpl-tool-1'));
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 235, outputTokens: 207, totalTokens: 442, reasoningTokens: 190 } });
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
});

test('translateEvents keeps text and reasoning in separate ordered blocks', async () => {
  const chunks = await collect(translateEvents(from([frame({ reasoning_content: 'r' }), frame({ content: 'Hel' }), frame({ content: 'lo' }), frame({}, { choice: { finish_reason: 'stop' } })])));
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-start').map(chunk => [chunk.index, chunk.blockType]), [[0, 'reasoning'], [1, 'text']]);
  assert.deepEqual(chunks.find(chunk => chunk.type === 'block-end' && chunk.index === 1).block, { type: 'text', text: 'Hello' });
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' });
});

test('translateEvents maps length, empty answers and in-band errors', async () => {
  const truncated = await collect(translateEvents(from([frame({ content: 'x' }, { choice: { finish_reason: 'length' } })])));
  assert.deepEqual(truncated.at(-1).reason, { kind: 'max-tokens' });
  await assert.rejects(collect(translateEvents(from([frame({}, { choice: { finish_reason: 'stop' } })]))), { code: 'EMPTY_RESPONSE' });
  await assert.rejects(collect(translateEvents(from([{ code: 11128, msg: '渠道校验失败' }]))), { code: 'INVALID_REQUEST', message: /11128/ });
});

test('classifyFailure maps gateway answers to Harness codes', () => {
  assert.equal(classifyFailure(401, '{}').code, 'AUTH');
  assert.equal(classifyFailure(429, '{"msg":"too many requests"}', new Headers({ 'retry-after': '3' })).providerRetryAfterMs, 3000);
  assert.equal(classifyFailure(400, '{"code":11128,"msg":"x"}').code, 'INVALID_REQUEST');
  assert.equal(classifyFailure(400, '{"msg":"积分不足"}').code, 'QUOTA');
  assert.equal(classifyFailure(503, 'busy').code, 'SERVER');
});

test('adapter streams native tool calls through the injected client and meter', async () => {
  const sent = [];
  const metered = [];
  const hub = {
    settings: () => ({ 'workbuddy-cn': { enabled: true } }),
    catalog: async () => [{ id: 'hy4free', name: 'Hy4', contextWindow: 960000, maxOutput: 64000, reasoning: { efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' } }],
    visibleModels: async () => [{ provider: 'workbuddy-cn', id: 'hy4free', name: 'Hy4' }]
  };
  const client = { openChat: async body => { sent.push(body); return sse([frame({ tool_calls: [{ id: 't1', function: { name: 'read', arguments: '{}' }, index: 0 }] }, { choice: { finish_reason: 'tool_calls' } })]); } };
  const adapter = createWorkbuddyAdapter({ hub, client, meter: (stream, request) => (async function* () { metered.push(request.model); yield* stream; })() });
  const prepared = await adapter.prepareCall('workbuddy-cn', 'hy4free');
  assert.equal(prepared.model.context.contextWindow, 960000);
  assert.equal(prepared.model.reasoning.defaultEffort, 'high');
  const chunks = await collect(prepared.stream({ provider: 'workbuddy-cn', model: 'hy4free', system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], tools: [{ name: 'read', description: 'r', parameters: { type: 'object' } }] }));
  assert.equal(sent[0].model, 'hy4free');
  assert.equal(sent[0].tools.length, 1);
  assert.deepEqual(metered, ['hy4free']);
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
});

test('adapter surfaces HTTP failures and refuses when disabled', async () => {
  const hub = { settings: () => ({ 'workbuddy-cn': { enabled: true } }), catalog: async () => [], visibleModels: async () => [] };
  const adapter = createWorkbuddyAdapter({ hub, client: { openChat: async () => new Response('{"code":11128,"msg":"渠道校验"}', { status: 400 }) } });
  await assert.rejects(collect(adapter.stream({ model: 'hy4free', messages: [{ role: 'user', content: 'x' }] })), { code: 'INVALID_REQUEST' });
  const off = createWorkbuddyAdapter({ hub: { ...hub, settings: () => ({ 'workbuddy-cn': { enabled: false } }) }, client: { openChat: async () => { throw new Error('must not send'); } } });
  await assert.rejects(collect(off.stream({ model: 'hy4free', messages: [] })), { code: 'PROVIDER_DISABLED' });
});

test('adapter delegates tools and 11128 channel-rejected requests to hub.mcpStream when available', async () => {
  const mcpCalls = [];
  const metered = [];
  const hub = {
    settings: () => ({ 'workbuddy-cn': { enabled: true } }),
    catalog: async () => [{ id: 'glm-5.3', name: 'GLM-5.3' }],
    visibleModels: async () => [{ provider: 'workbuddy-cn', id: 'glm-5.3', name: 'GLM-5.3' }],
    hasMcpSession: messages => Array.isArray(messages) && messages.some(m => m.role === 'tool'),
    async *mcpStream(_provider, options) {
      mcpCalls.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'mcp-ok' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'mcp-ok' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  };
  let openChatCalls = 0;
  const adapter = createWorkbuddyAdapter({
    hub,
    client: {
      openChat: async () => {
        openChatCalls++;
        if (openChatCalls === 1) return new Response('{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}', { status: 400 });
        return new Response('{"error":{"message":"bad key"}}', { status: 401 });
      }
    },
    meter: (stream, request) => (async function* () {
      metered.push(request.model);
      yield* stream;
    })()
  });

  // 1) Request with tools goes straight to mcpStream without calling openChat
  const withTools = await collect(adapter.stream({
    model: 'glm-5.3',
    messages: [{ role: 'user', content: 'use tool' }],
    tools: [{ name: 'read_file', description: 'r', parameters: { type: 'object' } }]
  }));
  assert.equal(openChatCalls, 0);
  assert.equal(mcpCalls.length, 1);
  assert.equal(withTools.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'mcp-ok');

  // 2) Active resumed MCP session goes to mcpStream even without tools array
  await collect(adapter.stream({
    model: 'glm-5.3',
    messages: [{ role: 'tool', toolCallId: 'c1', content: 'done' }]
  }));
  assert.equal(openChatCalls, 0);
  assert.equal(mcpCalls.length, 2);

  // 3) Request without tools that hits 11128 falls back to mcpStream without triggering outer meter error
  const fallback = await collect(adapter.stream({
    model: 'glm-5.3',
    system: 'Custom DSH prompt',
    messages: [{ role: 'user', content: 'hi' }]
  }));
  assert.equal(openChatCalls, 1);
  assert.equal(mcpCalls.length, 3);
  assert.deepEqual(metered, []);
  assert.equal(fallback.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'mcp-ok');

  // 4) Non-11128 errors (e.g. 401) still go through meter and reject without falling back
  await assert.rejects(
    collect(adapter.stream({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] })),
    { code: 'AUTH' }
  );
  assert.equal(openChatCalls, 2);
  assert.equal(mcpCalls.length, 3);
  assert.deepEqual(metered, ['glm-5.3']);
});
