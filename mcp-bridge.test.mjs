import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMcpCliCommand,
  createMcpBridge,
  extractPendingToolResults,
  formatMcpPrompt,
  normalizeInputSchema,
  resolveCanonicalToolName,
  setupMcpWorkspace,
  toMcpToolDescriptor
} from './mcp-bridge.mjs';
import { createAdapter, createHub, flattenWithMeta, meterStream } from './index.js';
import { createWorkbuddyAdapter } from './workbuddy-chat.mjs';
import { createUsageStore } from './usage-store.mjs';

test('setupMcpWorkspace 与 buildMcpCliCommand 为 Cursor 和 Antigravity 生成隔离的会话配置与参数', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-ws-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const cursorDir = join(root, 'cursor-session');
  const tools = [
    { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }
  ];
  setupMcpWorkspace('cursor', cursorDir, 'http://127.0.0.1:43210/mcp/tok1', tools);
  assert.equal(existsSync(join(cursorDir, '.git')), true);
  assert.equal(existsSync(join(cursorDir, '.git', 'HEAD')), true);
  assert.equal(existsSync(join(cursorDir, '.git', 'refs', 'heads')), true);
  assert.equal(existsSync(join(cursorDir, '.git', 'objects')), true);
  assert.equal(readFileSync(join(cursorDir, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main\n');
  const cursorMcp = JSON.parse(readFileSync(join(cursorDir, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(cursorMcp.mcpServers.dsh.url, 'http://127.0.0.1:43210/mcp/tok1');

  const cursorCmd = buildMcpCliCommand(
    'cursor',
    'user: hi',
    'gpt-5.4-medium',
    'high',
    cursorDir,
    { command: 'cursor-agent.exe', prefix: [] }
  );
  assert.equal(cursorCmd.command, 'cursor-agent.exe');
  assert(cursorCmd.args.includes('--approve-mcps'));
  assert(cursorCmd.args.includes('--trust'));
  assert(cursorCmd.args.includes('-f'));
  assert(!cursorCmd.args.includes('--exclude-workspace-context'));
  const wsIdx = cursorCmd.args.indexOf('--workspace');
  assert.notEqual(wsIdx, -1);
  assert.equal(cursorCmd.args[wsIdx + 1], cursorDir);
  const allowedIdx = cursorCmd.args.indexOf('--allowed-tools');
  assert.notEqual(allowedIdx, -1);
  assert.equal(cursorCmd.args[allowedIdx + 1], 'mcp_tool_call,get_mcp_tools_tool_call');
  const modelIdx = cursorCmd.args.indexOf('--model');
  assert.equal(cursorCmd.args[modelIdx + 1], 'gpt-5.4-high');

  const agyDir = join(root, 'agy-session');
  setupMcpWorkspace('antigravity', agyDir, 'http://127.0.0.1:43211/mcp/tok2', tools);
  const pluginJson = JSON.parse(readFileSync(join(agyDir, '.agents', 'plugins', 'dsh-bridge', 'plugin.json'), 'utf8'));
  assert.equal(pluginJson.name, 'dsh-bridge');
  const agyMcp = JSON.parse(readFileSync(join(agyDir, '.agents', 'plugins', 'dsh-bridge', 'mcp_config.json'), 'utf8'));
  assert.equal(agyMcp.mcpServers.dsh.url, 'http://127.0.0.1:43211/mcp/tok2');
  assert.deepEqual(agyMcp.mcpServers.dsh.tools, { get_weather: { eager: true } });
  const agentMd = readFileSync(join(agyDir, '.agents', 'agents', 'dsh-host.md'), 'utf8');
  assert(agentMd.includes('excludeDefaultComponents: true'));
  assert(agentMd.includes('inheritCustomizations: true'));

  const agyCmd = buildMcpCliCommand(
    'antigravity',
    'user: hi',
    'gemini-3-flash',
    undefined,
    agyDir,
    { command: 'agy.exe', prefix: [] }
  );
  assert.equal(agyCmd.command, 'agy.exe');
  assert(agyCmd.args.includes('--dangerously-skip-permissions'));
  assert(agyCmd.args.includes('--disable-slash-commands'));
  const agentIdx = agyCmd.args.indexOf('--agent');
  assert.equal(agyCmd.args[agentIdx + 1], 'dsh-host');
  const settingsIdx = agyCmd.args.indexOf('--settings');
  assert.deepEqual(JSON.parse(agyCmd.args[settingsIdx + 1]), { trustedWorkspaces: [agyDir] });

  const wbDir = join(root, 'wb-session');
  setupMcpWorkspace('workbuddy-cn', wbDir, 'http://127.0.0.1:43212/mcp/tok3', tools);
  const wbMcp = JSON.parse(readFileSync(join(wbDir, 'mcp-config.json'), 'utf8'));
  assert.equal(wbMcp.mcpServers.dsh.type, 'http');
  assert.equal(wbMcp.mcpServers.dsh.url, 'http://127.0.0.1:43212/mcp/tok3');
  assert.equal(wbMcp.mcpServers.dsh.alwaysLoad, true);
  assert.equal(wbMcp.mcpServers.dsh.defer_loading, false);
  assert.deepEqual(wbMcp.mcpServers.dsh.tools, { get_weather: { eager: true, defer_loading: false } });

  const wbCmd = buildMcpCliCommand(
    'workbuddy-cn',
    'user: hi',
    'glm-5.3',
    'high',
    wbDir,
    { command: 'node.exe', prefix: ['codebuddy-lite-wb.mjs'] }
  );
  assert.equal(wbCmd.command, 'node.exe');
  assert.equal(wbCmd.args[0], 'codebuddy-lite-wb.mjs');
  assert(wbCmd.args.includes('--include-partial-messages'));
  assert(wbCmd.args.includes('--strict-mcp-config'));
  assert(wbCmd.args.includes('--no-session-persistence'));
  assert(wbCmd.args.includes('-y'));
  assert.equal(wbCmd.args[wbCmd.args.indexOf('--tools') + 1], '');
  assert.equal(wbCmd.args[wbCmd.args.indexOf('--mcp-config') + 1], join(wbDir, 'mcp-config.json'));
  assert.equal(wbCmd.args[wbCmd.args.indexOf('--model') + 1], 'glm-5.3');
  assert.equal(wbCmd.args[wbCmd.args.indexOf('--effort') + 1], 'high');

  const wbOffCmd = buildMcpCliCommand(
    'workbuddy-cn',
    'user: hi',
    'glm-5.3',
    'off',
    wbDir,
    { command: 'node.exe', prefix: ['codebuddy-lite-wb.mjs'] }
  );
  assert(!wbOffCmd.args.includes('--effort'));
});

test('工具名称规范化、Schema 转换与待处理工具结果提取', () => {
  const tools = [{ name: 'read_file' }, { name: 'run_shell_command' }];
  assert.equal(resolveCanonicalToolName('read_file', tools), 'read_file');
  assert.equal(resolveCanonicalToolName('mcp__dsh__read_file', tools), 'read_file');
  assert.equal(resolveCanonicalToolName('dsh-bridge_dsh_run_shell_command', tools), 'run_shell_command');
  assert.equal(resolveCanonicalToolName('custom_prefix/read_file', tools), 'read_file');

  const descriptor = toMcpToolDescriptor({ name: 'ping_host', description: '', parameters: null });
  assert.equal(descriptor.name, 'ping_host');
  assert.deepEqual(descriptor.inputSchema, { type: 'object', properties: {} });
  assert.equal(descriptor._meta['antigravity/alwaysLoad'], true);
  assert.equal(descriptor._meta.defer_loading, false);
  assert.deepEqual(normalizeInputSchema({ type: 'object', properties: { a: { type: 'number' } } }), {
    type: 'object',
    properties: { a: { type: 'number' } }
  });

  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'check files' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking...' },
        { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } },
        { type: 'tool-call', id: 'call_2', name: 'read_file', arguments: { path: 'b.txt' } }
      ]
    },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'content A' }] },
    { role: 'tool', toolCallId: 'call_2', isError: true, content: 'ENOENT' },
    { role: 'user', content: 'Also summarize.' }
  ];
  const extracted = extractPendingToolResults(messages);
  assert.deepEqual(extracted.toolCallIds, ['call_1', 'call_2']);
  assert.equal(extracted.resultsById.get('call_1').content, 'content A');
  assert.equal(extracted.resultsById.get('call_1').isError, false);
  assert.equal(extracted.resultsById.get('call_2').content, 'ENOENT');
  assert.equal(extracted.resultsById.get('call_2').isError, true);
  assert.equal(extracted.trailingText, 'user: Also summarize.');

  const promptMeta = formatMcpPrompt({
    system: 'Be concise.',
    tools: [{ name: 'read_file' }],
    messages: [{ role: 'user', content: 'Hello' }]
  });
  assert(promptMeta.prompt.includes('[MCP Tool Bridge]'));
  assert(promptMeta.prompt.includes('read_file'));
  assert(promptMeta.prompt.includes('Be concise.'));
  assert(promptMeta.prompt.includes('user: Hello'));
});

test('Cursor MCP Suspend-and-Yield：并发工具调用挂起、宿主回填结果、增量去重与用量计量', async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-mcp-cursor-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const cursorSimFile = join(scratch, 'cursor-sim.mjs');
  writeFileSync(cursorSimFile, [
    "import { readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const mcpCfg = JSON.parse(readFileSync(join(process.cwd(), '.cursor', 'mcp.json'), 'utf8'));",
    "const url = mcpCfg.mcpServers.dsh.url;",
    "const post = async (body) => {",
    "  const res = await fetch(url, {",
    "    method: 'POST',",
    "    headers: { 'content-type': 'application/json' },",
    "    body: JSON.stringify(body)",
    "  });",
    "  if (res.status === 202) return null;",
    "  return res.json();",
    "};",
    "await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });",
    "await post({ jsonrpc: '2.0', method: 'notifications/initialized' });",
    "const listRes = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });",
    "if (!listRes?.result?.tools?.length) {",
    "  process.stderr.write('No tools exposed');",
    "  process.exit(2);",
    "}",
    "process.stdout.write(JSON.stringify({ type: 'thinking', text: 'Planning weather lookup...' }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Checking cities: ' }] } }) + '\\n');",
    "const [r1, r2] = await Promise.all([",
    "  post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mcp__dsh__get_weather', arguments: { city: 'Beijing' } } }),",
    "  post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mcp__dsh__get_weather', arguments: { city: 'Shanghai' } } })",
    "]);",
    "const t1 = r1.result.content[0].text;",
    "const t2 = r2.result.content[0].text;",
    "const full = 'Checking cities: ' + t1 + ' & ' + t2;",
    "process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: full }] } }) + '\\n');",
    "process.stdout.write(JSON.stringify({",
    "  type: 'result',",
    "  result: 'Checking cities: \\n\\n' + t1 + ' & ' + t2,",
    "  usage: { input_tokens: 55, output_tokens: 22, cache_read_input_tokens: 10 }",
    "}) + '\\n');"
  ].join('\n'));

  const usageStore = createUsageStore();
  const hub = createHub({
    scratch,
    usage: usageStore,
    loadModels: async () => [{ id: 'gpt-5.4-medium', name: 'GPT-5.4' }],
    cliDetect: () => ({ command: process.execPath, prefix: [cursorSimFile] })
  });
  t.after(() => hub.dispose());

  assert.equal(hub.status('cursor').modelChannel, 'tools');
  assert.equal(hub.status('antigravity').modelChannel, 'tools');

  const adapter = createAdapter(hub, 'cursor');
  const tools = [
    {
      name: 'get_weather',
      description: 'Lookup city weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
    }
  ];

  // Turn 1: User asks for weather -> CLI calls 2 tools concurrently -> stream yields tool-calls and suspends
  const turn1Chunks = [];
  for await (const chunk of adapter.stream({
    model: 'gpt-5.4-medium',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Weather in Beijing and Shanghai?' }] }],
    tools
  })) {
    turn1Chunks.push(chunk);
  }

  const reasoningText = turn1Chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('');
  assert.equal(reasoningText, 'Planning weather lookup...');
  const turn1Text = turn1Chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('');
  assert.equal(turn1Text, 'Checking cities: ');

  const toolEndBlocks = turn1Chunks
    .filter(c => c.type === 'block-end' && c.block?.type === 'tool-call')
    .map(c => c.block);
  assert.equal(toolEndBlocks.length, 2);
  assert.equal(toolEndBlocks[0].name, 'get_weather');
  assert.equal(typeof toolEndBlocks[0].arguments, 'string');
  assert.deepEqual(JSON.parse(toolEndBlocks[0].arguments), { city: 'Beijing' });
  assert.equal(toolEndBlocks[1].name, 'get_weather');
  assert.equal(typeof toolEndBlocks[1].arguments, 'string');
  assert.deepEqual(JSON.parse(toolEndBlocks[1].arguments), { city: 'Shanghai' });
  assert.equal(turn1Chunks.at(-1).type, 'finish');
  assert.equal(turn1Chunks.at(-1).reason.kind, 'tool-calls');

  // Turn 2: Host supplies tool results -> suspended CLI resumes and finishes
  const turn2Messages = [
    { role: 'user', content: [{ type: 'text', text: 'Weather in Beijing and Shanghai?' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking cities: ' },
        ...toolEndBlocks
      ]
    },
    { role: 'tool', toolCallId: toolEndBlocks[0].id, content: [{ type: 'text', text: 'Beijing 20C' }] },
    { role: 'tool', toolCallId: toolEndBlocks[1].id, content: [{ type: 'text', text: 'Shanghai 26C' }] }
  ];
  assert.equal(hub.hasMcpSession(turn2Messages), true);

  const turn2Chunks = [];
  for await (const chunk of adapter.stream({
    model: 'gpt-5.4-medium',
    messages: turn2Messages,
    tools
  })) {
    turn2Chunks.push(chunk);
  }

  const turn2Text = turn2Chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('');
  assert.equal(turn2Text, 'Beijing 20C & Shanghai 26C');
  const usageChunk = turn2Chunks.find(c => c.type === 'usage');
  assert.ok(usageChunk);
  assert.equal(usageChunk.usage.inputTokens, 55);
  assert.equal(usageChunk.usage.outputTokens, 22);
  assert.equal(usageChunk.usage.cacheReadTokens, 10);
  assert.equal(turn2Chunks.at(-1).type, 'finish');
  assert.equal(turn2Chunks.at(-1).reason.kind, 'stop');
  assert.equal(hub.hasMcpSession(turn2Messages), false);

  const snap = usageStore.snapshot({ platform: 'cursor' });
  assert.equal(snap.totals.calls, 2);
  assert.equal(snap.totals.ok, 2);
  assert.equal(snap.totals.error, 0);
  const turn2UsageRecord = snap.recent[0];
  assert.equal(turn2UsageRecord.omittedChars, 0);
  assert.equal(turn2UsageRecord.inputChars, 'Beijing 20C\nShanghai 26C'.length);
});

test('Antigravity MCP 多步链式工具调用（Turn 1 -> Turn 2 -> Turn 3）与探测端点兼容', async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-mcp-agy-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const agySimFile = join(scratch, 'agy-sim.mjs');
  writeFileSync(agySimFile, [
    "import { readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const cfg = JSON.parse(readFileSync(join(process.cwd(), '.agents', 'plugins', 'dsh-bridge', 'mcp_config.json'), 'utf8'));",
    "const url = cfg.mcpServers.dsh.url;",
    "const base = new URL(url).origin;",
    "const oauthRes = await fetch(base + '/.well-known/oauth-protected-resource');",
    "if (oauthRes.status !== 404) process.exit(3);",
    "const badTokenRes = await fetch(base + '/mcp/wrong-token', { method: 'POST', body: '{}' });",
    "if (badTokenRes.status !== 404) process.exit(7);",
    "const getRes = await fetch(url, { method: 'GET' });",
    "if (getRes.status !== 405) process.exit(4);",
    "const post = async (body) => {",
    "  const r = await fetch(url, {",
    "    method: 'POST',",
    "    headers: { 'content-type': 'application/json' },",
    "    body: JSON.stringify(body)",
    "  });",
    "  if (r.status === 202) return null;",
    "  return r.json();",
    "};",
    "const disc = await post({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });",
    "if (disc?.error?.code !== -32601) process.exit(5);",
    "await post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25' } });",
    "const list = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });",
    "if (!list.result.tools.every(t => t._meta?.['antigravity/alwaysLoad'] === true)) process.exit(6);",
    "const step1 = await post({",
    "  jsonrpc: '2.0',",
    "  id: 4,",
    "  method: 'tools/call',",
    "  params: { name: 'dsh-bridge_dsh_read_config', arguments: { key: 'theme' } }",
    "});",
    "const step2 = await post({",
    "  jsonrpc: '2.0',",
    "  id: 5,",
    "  method: 'tools/call',",
    "  params: { name: 'dsh-bridge_dsh_write_config', arguments: { key: 'theme', value: step1.result.content[0].text + '-pro' } }",
    "});",
    "process.stdout.write(JSON.stringify({ event: 'init' }) + '\\n');",
    "process.stdout.write(JSON.stringify({",
    "  event: 'result',",
    "  result: {",
    "    status: 'SUCCESS',",
    "    response: 'Updated: ' + step2.result.content[0].text,",
    "    usage: { input_tokens: 80, output_tokens: 15 }",
    "  }",
    "}) + '\\n');"
  ].join('\n'));

  const hub = createHub({
    scratch,
    loadModels: async () => [{ id: 'gemini-3-flash', name: 'Gemini 3 Flash' }],
    cliDetect: () => ({ command: process.execPath, prefix: [agySimFile] })
  });
  t.after(() => hub.dispose());

  const adapter = createAdapter(hub, 'antigravity');
  const tools = [
    { name: 'read_config', description: 'Read config key', parameters: { type: 'object', properties: { key: { type: 'string' } } } },
    { name: 'write_config', description: 'Write config key', parameters: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } } } }
  ];

  // Turn 1 -> read_config
  const t1 = [];
  for await (const c of adapter.stream({
    model: 'gemini-3-flash',
    messages: [{ role: 'user', content: 'Upgrade theme config' }],
    tools
  })) {
    t1.push(c);
  }
  const call1 = t1.find(c => c.type === 'block-end' && c.block?.type === 'tool-call')?.block;
  assert.ok(call1);
  assert.equal(call1.name, 'read_config');
  assert.equal(typeof call1.arguments, 'string');
  assert.deepEqual(JSON.parse(call1.arguments), { key: 'theme' });
  assert.equal(t1.at(-1).reason.kind, 'tool-calls');

  // Turn 2 -> supplies read_config result -> receives write_config tool call
  const messages2 = [
    { role: 'user', content: 'Upgrade theme config' },
    { role: 'assistant', content: [call1] },
    { role: 'tool', toolCallId: call1.id, content: 'dark' }
  ];
  const t2 = [];
  for await (const c of adapter.stream({
    model: 'gemini-3-flash',
    messages: messages2,
    tools
  })) {
    t2.push(c);
  }
  const call2 = t2.find(c => c.type === 'block-end' && c.block?.type === 'tool-call')?.block;
  assert.ok(call2);
  assert.equal(call2.name, 'write_config');
  assert.equal(typeof call2.arguments, 'string');
  assert.deepEqual(JSON.parse(call2.arguments), { key: 'theme', value: 'dark-pro' });
  assert.equal(t2.at(-1).reason.kind, 'tool-calls');

  // Turn 3 -> supplies write_config result -> receives final answer
  const messages3 = [
    ...messages2,
    { role: 'assistant', content: [call2] },
    { role: 'tool', toolCallId: call2.id, content: 'saved(dark-pro)' }
  ];
  const t3 = [];
  for await (const c of adapter.stream({
    model: 'gemini-3-flash',
    messages: messages3,
    tools
  })) {
    t3.push(c);
  }
  const finalText = t3.filter(c => c.type === 'text-delta').map(c => c.text).join('');
  assert.equal(finalText, 'Updated: saved(dark-pro)');
  assert.equal(t3.find(c => c.type === 'usage')?.usage.inputTokens, 80);
  assert.equal(t3.at(-1).reason.kind, 'stop');
});

test('无 tools 时保持原有 cliCaller 快速路径，挂起会话支持取消并清理临时目录', async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-mcp-abort-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  let legacyCalls = 0;
  const hub = createHub({
    scratch,
    cliCaller: async (_platform, _prompt, _model, options) => {
      legacyCalls++;
      options?.onText?.('legacy-ok');
      return { text: 'legacy-ok' };
    }
  });
  t.after(() => hub.dispose());

  const adapter = createAdapter(hub, 'cursor');
  const plainChunks = [];
  for await (const c of adapter.stream({
    messages: [{ role: 'user', content: 'just chat' }]
  })) {
    plainChunks.push(c);
  }
  assert.equal(legacyCalls, 1);
  assert.equal(plainChunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'legacy-ok');

  let capturedSessionDir = '';
  const hangFile = join(scratch, 'hang-sim.mjs');
  writeFileSync(hangFile, 'setInterval(() => {}, 1000);\n');
  const bridgeReal = createMcpBridge({
    scratch,
    cliDetect: () => ({ command: process.execPath, prefix: [hangFile] }),
    spawnProcess: (cmd, args, opts) => {
      capturedSessionDir = opts.cwd;
      return spawn(cmd, args, opts);
    }
  });
  t.after(() => bridgeReal.dispose());

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 60);
  const abortChunks = [];
  for await (const c of bridgeReal.stream('cursor', {
    messages: [{ role: 'user', content: 'abort me' }],
    tools: [{ name: 'noop' }],
    signal: controller.signal
  })) {
    abortChunks.push(c);
  }
  assert.equal(abortChunks.at(-1).type, 'finish');
  assert.equal(abortChunks.at(-1).reason.kind, 'aborted');
  assert.ok(capturedSessionDir);
  for (let i = 0; i < 15 && existsSync(capturedSessionDir); i += 1) {
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(existsSync(capturedSessionDir), false);
});

test('WorkBuddy CLI MCP 桥接：注入 CODEBUDDY_AUTH_TOKEN、thinking 解析与工具挂起恢复', async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-mcp-wb-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const wbSimFile = join(scratch, 'wb-sim.mjs');
  writeFileSync(wbSimFile, [
    "import { readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "if (process.env.CODEBUDDY_AUTH_TOKEN !== 'wb-secret-token') { process.stderr.write('Missing token'); process.exit(2); }",
    "const cfg = JSON.parse(readFileSync(join(process.cwd(), 'mcp-config.json'), 'utf8'));",
    "const url = cfg.mcpServers.dsh.url;",
    "const post = async body => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();",
    "await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });",
    "const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });",
    "if (list.result.tools[0]._meta.defer_loading !== false) { process.stderr.write('defer_loading should be false'); process.exit(3); }",
    "process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Need magic number.' }] } }) + '\\n');",
    "const call = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mcp__dsh__get_magic', arguments: {} } });",
    "const val = call.result.content[0].text;",
    "process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Magic: ' + val }] } }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Magic: ' + val, usage: { input_tokens: 12, output_tokens: 5 } }) + '\\n');"
  ].join('\n'));

  let spawnedEnv = null;
  const hub = createHub({
    scratch,
    loadModels: async () => [{ id: 'glm-5.3', name: 'GLM-5.3' }],
    workbuddyAuth: async () => 'wb-secret-token',
    cliDetect: () => ({ command: process.execPath, prefix: [wbSimFile] }),
    mcpSpawn: (cmd, args, opts) => {
      spawnedEnv = opts.env;
      return spawn(cmd, args, opts);
    }
  });
  t.after(() => hub.dispose());

  const adapter = createWorkbuddyAdapter({
    hub,
    client: { openChat: async () => { throw new Error('openChat must be bypassed when tools are provided'); } }
  });
  const tools = [{ name: 'get_magic', description: 'Magic', parameters: { type: 'object', properties: {} } }];

  const t1 = [];
  for await (const c of adapter.stream({
    model: 'glm-5.3',
    reasoningEffort: 'high',
    messages: [{ role: 'user', content: 'Get magic number' }],
    tools
  })) {
    t1.push(c);
  }
  assert.equal(spawnedEnv?.CODEBUDDY_AUTH_TOKEN, 'wb-secret-token');
  assert.equal(t1.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), 'Need magic number.');
  const callBlock = t1.find(c => c.type === 'block-end' && c.block?.type === 'tool-call')?.block;
  assert.equal(callBlock?.name, 'get_magic');
  assert.equal(t1.at(-1).reason.kind, 'tool-calls');

  const t2 = [];
  for await (const c of adapter.stream({
    model: 'glm-5.3',
    messages: [
      { role: 'user', content: 'Get magic number' },
      { role: 'assistant', content: [callBlock] },
      { role: 'tool', toolCallId: callBlock.id, content: '424242' }
    ],
    tools
  })) {
    t2.push(c);
  }
  assert.equal(t2.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'Magic: 424242');
  assert.equal(t2.at(-1).reason.kind, 'stop');
});

test('formatMcpPrompt 在超大单轮后接续“继续”时保留原始目标与近期上下文', () => {
  const bigTurn = 'TOOL_HEAD_MARK ' + 'x'.repeat(39000) + ' SUBAGENT_SETTLED_TAIL';
  const shortHistory = formatMcpPrompt({
    system: 'host-system-prompt',
    messages: [
      { role: 'user', content: 'GOAL_ANCHOR: Inspect all DSH plugins' },
      { role: 'assistant', content: 'ASSESSED_EARLIER: Scanned antigravity & cursor.' },
      { role: 'tool', toolCallId: 'c1', content: bigTurn },
      { role: 'user', content: '继续' }
    ]
  }, 24000);
  assert.equal(shortHistory.inputChars <= 24000, true);
  assert(shortHistory.prompt.includes('GOAL_ANCHOR: Inspect all DSH plugins'));
  assert(shortHistory.prompt.includes('ASSESSED_EARLIER: Scanned antigravity & cursor.'));
  assert(shortHistory.prompt.includes('TOOL_HEAD_MARK'));
  assert(shortHistory.prompt.includes('SUBAGENT_SETTLED_TAIL'));
  assert(shortHistory.prompt.endsWith('user: 继续'));
  assert.equal(shortHistory.omittedChars > 0, true);

  const manyTurns = [
    { role: 'user', content: 'GOAL_ANCHOR: Inspect all DSH plugins in workspace' },
    ...Array.from({ length: 14 }, (_, idx) => ({
      role: idx % 2 === 0 ? 'assistant' : 'user',
      content: `OLD_TURN_${idx}_` + 'm'.repeat(1600)
    })),
    { role: 'assistant', content: 'RECENT_BEFORE_40K: agent-1 started scanning plugins.' },
    { role: 'user', content: bigTurn },
    { role: 'user', content: '继续' }
  ];
  const deepHistory = formatMcpPrompt({ system: 'host-system-prompt', messages: manyTurns }, 24000);
  assert.equal(deepHistory.inputChars <= 24000, true);
  assert(deepHistory.prompt.includes('GOAL_ANCHOR: Inspect all DSH plugins in workspace'));
  assert(deepHistory.prompt.includes('[Earlier conversation was omitted to fit the CLI input limit.]'));
  assert(deepHistory.prompt.includes('RECENT_BEFORE_40K: agent-1 started scanning plugins.'));
  assert(deepHistory.prompt.includes('SUBAGENT_SETTLED_TAIL'));
  assert(deepHistory.prompt.endsWith('user: 继续'));
  assert.equal(deepHistory.omittedChars > 0, true);
});

test('流式 thinking_delta 去重以及流事件/RPC 活动刷新空闲超时（静默仍触发 TIMEOUT）', async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-mcp-idle-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const slowStreamFile = join(scratch, 'wb-stream-sim.mjs');
  writeFileSync(slowStreamFile, [
    "const sleep = ms => new Promise(r => setTimeout(r, ms));",
    "for (let i = 0; i < 5; i += 1) {",
    "  await sleep(75);",
    "  process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'step-' + i } } }) + '\\n');",
    "}",
    "await sleep(75);",
    "process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done ' } } }) + '\\n');",
    "await sleep(75);",
    "process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } } }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'step-0step-1step-2step-3step-4' }, { type: 'text', text: 'Done answer' }] } }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done answer' }) + '\\n');"
  ].join('\n'));

  const bridge = createMcpBridge({
    scratch,
    turnTimeoutMs: 220,
    cliDetect: () => ({ command: process.execPath, prefix: [slowStreamFile] })
  });
  t.after(() => bridge.dispose());

  const chunks = [];
  for await (const c of bridge.stream('workbuddy-cn', {
    messages: [{ role: 'user', content: 'stream slowly' }],
    tools: [{ name: 'noop' }]
  })) {
    chunks.push(c);
  }
  assert.equal(chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), 'step-0step-1step-2step-3step-4');
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'Done answer');
  assert.equal(chunks.at(-1).type, 'finish');
  assert.equal(chunks.at(-1).reason.kind, 'stop');

  const silentFile = join(scratch, 'wb-silent-sim.mjs');
  writeFileSync(silentFile, 'setInterval(() => {}, 1000);\n');
  const silentBridge = createMcpBridge({
    scratch,
    turnTimeoutMs: 120,
    cliDetect: () => ({ command: process.execPath, prefix: [silentFile] })
  });
  t.after(() => silentBridge.dispose());

  const timeoutChunks = [];
  for await (const c of silentBridge.stream('workbuddy-cn', {
    messages: [{ role: 'user', content: 'hang silently' }],
    tools: [{ name: 'noop' }]
  })) {
    timeoutChunks.push(c);
  }
  assert.equal(timeoutChunks.at(-1).type, 'finish');
  assert.equal(timeoutChunks.at(-1).reason.kind, 'error');
  assert.match(timeoutChunks.at(-1).reason.failure.message, /TIMEOUT/);
});

test('多步流式 JSONL 原始体积超过 2MB 但正文未超限时不会误触发 CLI output limit exceeded', async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-mcp-bigjson-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const bigJsonSimFile = join(scratch, 'wb-bigjson-sim.mjs');
  writeFileSync(bigJsonSimFile, [
    "const pad = 'p'.repeat(420);",
    "let rawBytes = 0;",
    "for (let i = 0; i < 6500; i += 1) {",
    "  const line = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: pad } } }) + '\\n';",
    "  rawBytes += line.length;",
    "  process.stdout.write(line);",
    "}",
    "if (rawBytes <= 2.5 * 1024 * 1024) throw new Error('Expected > 2.5MB raw stdout');",
    "process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Large stream completed' } } }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Large stream completed' }] } }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Large stream completed' }) + '\\n');"
  ].join('\n'));

  const bridge = createMcpBridge({
    scratch,
    cliDetect: () => ({ command: process.execPath, prefix: [bigJsonSimFile] })
  });
  t.after(() => bridge.dispose());

  const chunks = [];
  for await (const c of bridge.stream('workbuddy-cn', {
    messages: [{ role: 'user', content: 'run many streamed steps' }],
    tools: [{ name: 'noop' }]
  })) {
    chunks.push(c);
  }
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'Large stream completed');
  assert.equal(chunks.at(-1).type, 'finish');
  assert.equal(chunks.at(-1).reason.kind, 'stop');
});

test('messages 中的 role:system 会提取到系统提示预算并保留在截断标记之前（含 flattenWithMeta 与 meterStream）', async () => {
  const sysText = 'DSH_SYSTEM_POLICY_ANCHOR: Always use host workspace.';
  const msgs = [
    { role: 'system', content: sysText },
    { role: 'user', content: 'FIRST_USER_GOAL: Build archify architecture diagrams' },
    ...Array.from({ length: 12 }, (_, idx) => ({
      role: idx % 2 === 0 ? 'assistant' : 'user',
      content: `MIDDLE_${idx}_` + 'z'.repeat(1800)
    })),
    { role: 'user', content: 'LATEST_USER_REQUEST' }
  ];

  const mcpMeta = formatMcpPrompt({ tools: [{ name: 'read' }], messages: msgs }, 12000);
  const sysPos = mcpMeta.prompt.indexOf(sysText);
  const omittedPos = mcpMeta.prompt.indexOf('[Earlier conversation was omitted to fit the CLI input limit.]');
  assert.notEqual(sysPos, -1);
  assert.notEqual(omittedPos, -1);
  assert(sysPos < omittedPos, 'system message must stay in system section before omitted marker');
  assert(mcpMeta.prompt.includes('mcp-*'));
  assert(mcpMeta.prompt.includes('FIRST_USER_GOAL'));
  assert(mcpMeta.prompt.endsWith('user: LATEST_USER_REQUEST'));
  assert(mcpMeta.systemChars >= sysText.length);

  const flatMeta = flattenWithMeta({ messages: msgs }, 12000);
  const flatSysPos = flatMeta.prompt.indexOf(sysText);
  const flatOmittedPos = flatMeta.prompt.indexOf('[Earlier conversation was omitted to fit the CLI input limit.]');
  assert.notEqual(flatSysPos, -1);
  assert.notEqual(flatOmittedPos, -1);
  assert(flatSysPos < flatOmittedPos);
  assert.equal(flatMeta.systemChars, sysText.length);

  const recorded = [];
  const metered = meterStream(r => recorded.push(r), 'cursor');
  async function* singleStop() {
    yield { type: 'text-delta', text: 'ok' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  for await (const _ of metered(singleStop(), {
    model: 'grok-4.7',
    messages: [{ role: 'system', content: 'SYS_PART' }, { role: 'user', content: 'USR' }]
  })) {
    // drain stream
  }
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].systemChars, 'SYS_PART'.length);
  assert.equal(recorded[0].historyChars, 'USR'.length);
});
