import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { ROOT, detect, failure, safe } from './runtime.mjs';

const DEFAULT_BATCH_MS = 50;
const MAX_BATCH_MS = 200;
const DEFAULT_SUSPEND_TTL_MS = 5 * 60_000;
const DEFAULT_TURN_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 2 * 1024 * 1024;

export function normalizeInputSchema(parameters) {
  const base = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
    ? { ...parameters }
    : {};
  if (base.type !== 'object') base.type = 'object';
  if (!base.properties || typeof base.properties !== 'object' || Array.isArray(base.properties)) {
    base.properties = {};
  }
  return base;
}

export function toMcpToolDescriptor(tool) {
  const name = String(tool?.name ?? '').trim();
  if (!name) return null;
  return {
    name,
    description: String(tool?.description || `Execute host tool ${name}`),
    inputSchema: normalizeInputSchema(tool?.parameters),
    _meta: { 'antigravity/alwaysLoad': true, defer_loading: false }
  };
}

export function resolveCanonicalToolName(rawName, tools = []) {
  const name = String(rawName ?? '').trim();
  if (!name) return '';
  const names = tools.map(t => String(t?.name ?? '').trim()).filter(Boolean);
  if (names.includes(name)) return name;
  for (const prefix of ['mcp__dsh__', 'dsh-bridge_dsh_', 'dsh_bridge_dsh_', 'dsh-bridge_', 'dsh_']) {
    if (name.startsWith(prefix)) {
      const stripped = name.slice(prefix.length);
      if (names.includes(stripped)) return stripped;
    }
  }
  const suffixMatch = names
    .filter(candidate => name.endsWith(`_${candidate}`) || name.endsWith(`/${candidate}`) || name.endsWith(`.${candidate}`))
    .sort((a, b) => b.length - a.length)[0];
  return suffixMatch || name;
}

function contentBlocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool-call' && typeof block.name === 'string') {
      const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {});
      parts.push(`[tool-call ${block.name}(${args})]`);
    } else if (block.type === 'reasoning' && typeof block.text === 'string') {
      continue;
    } else if (typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type) {
      parts.push(`[${block.type} omitted]`);
    }
  }
  return parts.join('\n');
}

export function extractPendingToolResults(messages) {
  if (!Array.isArray(messages) || !messages.length) return null;
  let assistantIndex = -1;
  let expectedIds = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const calls = blocks.filter(b => b && typeof b === 'object' && b.type === 'tool-call' && typeof b.id === 'string');
      if (calls.length > 0) {
        assistantIndex = i;
        expectedIds = calls.map(c => c.id);
      }
      break;
    }
  }
  if (assistantIndex === -1 || !expectedIds.length) return null;
  const resultsById = new Map();
  const trailingNotes = [];
  for (let i = assistantIndex + 1; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'tool' && typeof msg.toolCallId === 'string') {
      const text = contentBlocksToText(msg.content);
      resultsById.set(msg.toolCallId, {
        toolCallId: msg.toolCallId,
        content: text || (msg.isError ? 'Tool execution failed.' : 'OK'),
        isError: Boolean(msg.isError)
      });
    } else if (msg.role === 'user' || msg.role === 'developer' || msg.role === 'system') {
      const text = contentBlocksToText(msg.content).trim();
      if (text) trailingNotes.push(`${msg.role}: ${text}`);
    }
  }
  if (!resultsById.size) return null;
  return {
    toolCallIds: expectedIds,
    resultsById,
    trailingText: trailingNotes.join('\n\n')
  };
}

function clipMiddle(text, limit) {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  const marker = `\n…[${text.length - limit} characters omitted]…\n`;
  if (marker.length >= limit) return text.slice(0, limit);
  const room = limit - marker.length;
  const head = Math.floor(room * 0.55);
  const tail = room - head;
  return text.slice(0, head) + marker + text.slice(-tail);
}

export function formatMcpPrompt(options = {}, budget = 24000) {
  const toolNames = (options.tools ?? []).map(t => t?.name).filter(Boolean);
  const bridgeDirective = toolNames.length
    ? `[MCP Tool Bridge]\nYou have access to host tools via the "dsh" MCP server (${toolNames.join(', ')}). When a tool is needed, invoke the corresponding MCP tool directly instead of describing or simulating tool calls in plain text.`
    : '';
  const rawSystem = contentBlocksToText(options.system ?? options.systemPrompt ?? '').trim();
  const systemCombined = [bridgeDirective, rawSystem].filter(Boolean).join('\n\n');
  const turns = [];
  for (const msg of options.messages ?? []) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'tool') {
      const text = contentBlocksToText(msg.content);
      turns.push(`tool (${msg.toolCallId ?? 'result'}${msg.isError ? ', error' : ''}): ${text}`);
    } else {
      const text = contentBlocksToText(msg.content);
      if (text) turns.push(`${msg.role}: ${text}`);
    }
  }
  const originalChars = systemCombined.length + turns.reduce((sum, t) => sum + t.length, 0);
  let remaining = Math.max(0, budget - 2);
  const systemBudget = Math.min(7000, Math.floor(remaining * 0.42));
  const systemText = systemCombined ? clipMiddle(systemCombined, systemBudget) : '';
  remaining = Math.max(0, remaining - systemText.length - 2);
  const kept = [];
  let omitted = false;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn.length + 2 <= remaining) {
      kept.unshift(turn);
      remaining -= turn.length + 2;
      continue;
    }
    if (kept.length === 0 && remaining > 0) {
      const clipped = clipMiddle(turn, remaining - 2);
      if (clipped) {
        kept.unshift(clipped);
        remaining = 0;
      }
      omitted = true;
    } else {
      omitted = true;
    }
    break;
  }
  const includedChars = systemText.length + kept.reduce((sum, t) => sum + t.length, 0);
  const historyChars = kept.reduce((sum, t) => sum + t.length, 0);
  const omittedChars = Math.max(0, originalChars - includedChars);
  const note = '[Earlier conversation was omitted to fit the CLI input limit.]';
  if (omitted) {
    while (kept.length > 1 && remaining < note.length + 2) {
      remaining += kept.shift().length + 2;
    }
    if (remaining >= note.length + 2) {
      kept.unshift(note);
      remaining -= note.length + 2;
    }
  }
  const prompt = [...(systemText ? [systemText] : []), ...kept].join('\n\n') || 'user: (empty)';
  const output = prompt.length > budget ? clipMiddle(prompt, budget) : prompt;
  return {
    prompt: output,
    inputChars: output.length,
    inputBudget: budget,
    systemChars: systemText.length,
    historyChars,
    omittedChars
  };
}

export function normalizeCliUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const num = (...keys) => {
    for (const k of keys) {
      const v = raw[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
    }
    return undefined;
  };
  const input = num('inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens');
  const output = num('outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens');
  const cacheRead = num('cacheReadTokens', 'cache_read_tokens', 'cache_read_input_tokens', 'cached_tokens');
  const cacheWrite = num('cacheWriteTokens', 'cache_write_tokens', 'cache_creation_input_tokens');
  const reasoning = num('reasoningTokens', 'reasoning_tokens', 'thinking_tokens');
  const total = num('totalTokens', 'total_tokens');
  if (input === undefined && output === undefined && total === undefined) return null;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    totalTokens: total ?? ((input ?? 0) + (output ?? 0)),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {})
  };
}

export function setupMcpWorkspace(platform, sessionDir, mcpUrl, tools = []) {
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(join(sessionDir, '.git'), { recursive: true });
  if (platform === 'cursor') {
    const cursorDir = join(sessionDir, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        dsh: { url: mcpUrl }
      }
    }, null, 2));
    return;
  }
  if (platform === 'antigravity') {
    const pluginDir = join(sessionDir, '.agents', 'plugins', 'dsh-bridge');
    const pluginAgentsDir = join(pluginDir, 'agents');
    const workspaceAgentsDir = join(sessionDir, '.agents', 'agents');
    mkdirSync(pluginAgentsDir, { recursive: true });
    mkdirSync(workspaceAgentsDir, { recursive: true });
    const eagerTools = {};
    for (const tool of tools) {
      if (tool?.name) eagerTools[String(tool.name)] = { eager: true };
    }
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'dsh-bridge',
      version: '1.0.0',
      description: 'DSH MCP host tool bridge'
    }, null, 2));
    writeFileSync(join(pluginDir, 'mcp_config.json'), JSON.stringify({
      mcpServers: {
        dsh: {
          url: mcpUrl,
          ...(Object.keys(eagerTools).length ? { tools: eagerTools } : {})
        }
      }
    }, null, 2));
    const agentMarkdown = [
      '---',
      'name: dsh-host',
      'description: DSH Host Agent',
      'mainAgent: true',
      'subagent: false',
      'excludeDefaultComponents: true',
      'inheritCustomizations: true',
      '---',
      '# DSH Host Agent',
      'You are operating inside DeepSeek Harness. Use the MCP tools provided by the dsh server whenever you need to execute a tool.'
    ].join('\n');
    writeFileSync(join(pluginAgentsDir, 'dsh-host.md'), agentMarkdown);
    writeFileSync(join(workspaceAgentsDir, 'dsh-host.md'), agentMarkdown);
    return;
  }
  if (platform === 'workbuddy-cn') {
    const eagerTools = {};
    for (const tool of tools) {
      if (tool?.name) eagerTools[String(tool.name)] = { eager: true, defer_loading: false };
    }
    writeFileSync(join(sessionDir, 'mcp-config.json'), JSON.stringify({
      mcpServers: {
        dsh: {
          type: 'http',
          url: mcpUrl,
          alwaysLoad: true,
          defer_loading: false,
          ...(Object.keys(eagerTools).length ? { tools: eagerTools } : {})
        }
      }
    }, null, 2));
  }
}

export function buildMcpCliCommand(platform, prompt, model, reasoningEffort, sessionDir, cli = detect(platform)) {
  if (platform === 'cursor') {
    const target = reasoningEffort
      ? (() => {
          const match = String(model ?? '').match(/-(none|minimal|low|medium|high|xhigh|max|extra-high)(-fast)?$/);
          return match ? String(model).slice(0, -match[0].length) + '-' + reasoningEffort + (match[2] || '') : model;
        })()
      : model;
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--stream-partial-output',
      '--trust',
      '--approve-mcps',
      '-f',
      '--workspace', sessionDir,
      '--allowed-tools', 'mcp_tool_call,get_mcp_tools_tool_call',
      ...(target ? ['--model', target] : []),
      '--',
      prompt
    ];
    return { command: cli.command, args: [...cli.prefix, ...args] };
  }
  if (platform === 'antigravity') {
    const settings = JSON.stringify({ trustedWorkspaces: [sessionDir] });
    const args = [
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--agent', 'dsh-host',
      '--settings', settings,
      ...(model ? ['--model', model] : []),
      '-p',
      prompt
    ];
    return { command: cli.command, args: [...cli.prefix, ...args] };
  }
  if (platform === 'workbuddy-cn') {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--no-session-persistence',
      '--tools', '',
      '--strict-mcp-config',
      '--mcp-config', join(sessionDir, 'mcp-config.json'),
      '-y',
      ...(model ? ['--model', model] : []),
      ...(reasoningEffort && reasoningEffort !== 'off' ? ['--effort', reasoningEffort] : []),
      '--',
      prompt
    ];
    return { command: cli.command, args: [...cli.prefix, ...args] };
  }
  throw new Error(`Unsupported MCP bridge platform: ${platform}`);
}

export function createMcpBridge({
  cliDetect = detect,
  spawnProcess = spawn,
  scratch = join(ROOT, 'scratch'),
  batchWindowMs = DEFAULT_BATCH_MS,
  maxBatchWindowMs = MAX_BATCH_MS,
  suspendTtlMs = DEFAULT_SUSPEND_TTL_MS,
  turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  resolveModelId = async (_platform, model) => model,
  resolveEnv = async (_platform) => undefined,
  onState = () => {}
} = {}) {
  const scratchRoot = resolve(scratch);
  const suspendedByCallId = new Map();
  const activeSessions = new Set();
  let disposed = false;

  function removeScratchDir(dir, retries = 4) {
    if (!dir) return;
    const resolved = resolve(dir);
    if (!resolved.startsWith(scratchRoot + sep)) return;
    try {
      rmSync(resolved, { recursive: true, force: true });
    } catch {
      if (retries > 0) {
        const timer = setTimeout(() => removeScratchDir(resolved, retries - 1), 40);
        timer.unref?.();
      }
    }
  }

  function findSuspendedSession(pendingResults) {
    if (!pendingResults || !pendingResults.toolCallIds.length) return null;
    for (const id of pendingResults.toolCallIds) {
      const session = suspendedByCallId.get(id);
      if (session && !session.closed) return session;
    }
    for (const id of pendingResults.resultsById.keys()) {
      const session = suspendedByCallId.get(id);
      if (session && !session.closed) return session;
    }
    return null;
  }

  async function createSession(platform, options) {
    mkdirSync(scratchRoot, { recursive: true });
    const sessionDir = mkdtempSync(join(scratchRoot, `mcp-${platform}-`));
    const token = randomUUID().replace(/-/g, '');
    const session = {
      id: randomUUID(),
      platform,
      sessionDir,
      token,
      tools: Array.isArray(options.tools) ? options.tools : [],
      pendingById: new Map(),
      pendingBatch: [],
      batchTimer: null,
      maxBatchTimer: null,
      suspendTimer: null,
      turnTimer: null,
      turn: null,
      child: null,
      server: null,
      lines: null,
      closed: false,
      processExited: false,
      exitCode: null,
      stderr: '',
      processError: null,
      terminalResult: false,
      usage: null,
      sessionText: '',
      sessionReasoning: '',
      callSeq: 0
    };

    const respondJson = (res, status, payload) => {
      if (res.writableEnded || res.destroyed) return;
      const body = JSON.stringify(payload);
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      });
      res.end(body);
    };

    const flushBatchToTurn = () => {
      clearTimeout(session.batchTimer);
      clearTimeout(session.maxBatchTimer);
      session.batchTimer = null;
      session.maxBatchTimer = null;
      const turn = session.turn;
      if (!turn || turn.done || !session.pendingBatch.length) return;
      const batch = session.pendingBatch.splice(0, session.pendingBatch.length);
      turn.closeOpenBlock();
      for (const call of batch) {
        const idx = turn.nextIndex++;
        const argsText = typeof call.arguments === 'string'
          ? (call.arguments || '{}')
          : JSON.stringify(call.arguments ?? {});
        turn.enqueue({ type: 'block-start', index: idx, blockType: 'tool-call' });
        turn.enqueue({ type: 'tool-call-delta', index: idx, id: call.id, name: call.name, argumentsDelta: argsText });
        turn.enqueue({
          type: 'block-end',
          index: idx,
          block: { type: 'tool-call', id: call.id, name: call.name, arguments: argsText }
        });
        suspendedByCallId.set(call.id, session);
      }
      turn.suspended = true;
      turn.enqueue({ type: 'finish', reason: { kind: 'tool-calls' } });
      turn.finishTurn();
      clearTimeout(session.turnTimer);
      session.suspendTimer = setTimeout(() => {
        session.destroy(new Error('MCP suspended session expired'));
      }, suspendTtlMs);
      session.suspendTimer.unref?.();
    };

    const scheduleBatch = () => {
      clearTimeout(session.batchTimer);
      session.batchTimer = setTimeout(flushBatchToTurn, batchWindowMs);
      if (!session.maxBatchTimer) {
        session.maxBatchTimer = setTimeout(flushBatchToTurn, maxBatchWindowMs);
      }
    };

    const handleRpcMessage = (msg, res) => {
      if (!msg || typeof msg !== 'object') {
        res.writeHead(202).end();
        return;
      }
      if (msg.id === undefined || msg.id === null) {
        res.writeHead(202).end();
        return;
      }
      const method = String(msg.method ?? '');
      if (method === 'initialize') {
        respondJson(res, 200, {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion || '2025-11-25',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'dsh-mcp-bridge', version: '1.0.0' },
            instructions: 'Use the tools exposed by this server to perform all host actions.'
          }
        });
        return;
      }
      if (method === 'ping') {
        respondJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: {} });
        return;
      }
      if (method === 'tools/list') {
        const tools = (session.tools ?? []).map(toMcpToolDescriptor).filter(Boolean);
        respondJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools } });
        return;
      }
      if (method === 'resources/list') {
        respondJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { resources: [] } });
        return;
      }
      if (method === 'prompts/list') {
        respondJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { prompts: [] } });
        return;
      }
      if (method === 'tools/call') {
        const rawName = msg.params?.name;
        const canonicalName = resolveCanonicalToolName(rawName, session.tools);
        if (!canonicalName) {
          respondJson(res, 200, {
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32602, message: 'Missing tool name' }
          });
          return;
        }
        const rawArgs = msg.params?.arguments ?? {};
        const callId = `mcp_call_${session.id.slice(0, 8)}_${++session.callSeq}`;
        const entry = {
          id: callId,
          rpcId: msg.id,
          name: canonicalName,
          arguments: rawArgs,
          res,
          settled: false
        };
        session.pendingById.set(callId, entry);
        session.pendingBatch.push(entry);
        res.on('close', () => {
          if (!entry.settled) {
            entry.settled = true;
            session.pendingById.delete(callId);
            suspendedByCallId.delete(callId);
          }
        });
        scheduleBatch();
        return;
      }
      respondJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });
    };

    const server = createServer((req, res) => {
      req.socket?.setTimeout?.(0);
      req.socket?.setNoDelay?.(true);
      const url = String(req.url ?? '');
      const pathname = url.split('?')[0];
      if (pathname.startsWith('/.well-known/')) {
        res.writeHead(404).end();
        return;
      }
      if (pathname !== `/mcp/${token}` && !pathname.startsWith(`/mcp/${token}/`)) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(405, { allow: 'POST, DELETE' }).end();
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(200).end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST, DELETE' }).end();
        return;
      }
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > MAX_OUTPUT_CHARS) req.destroy();
      });
      req.on('end', () => {
        if (!body.trim()) {
          res.writeHead(202).end();
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          respondJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          return;
        }
        if (Array.isArray(parsed)) {
          const requests = parsed.filter(item => item && item.id !== undefined && item.id !== null);
          if (!requests.length) {
            res.writeHead(202).end();
            return;
          }
          handleRpcMessage(requests[0], res);
          return;
        }
        handleRpcMessage(parsed, res);
      });
    });

    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
    session.server = server;
    const address = server.address();
    const mcpUrl = `http://127.0.0.1:${address.port}/mcp/${token}`;
    setupMcpWorkspace(platform, sessionDir, mcpUrl, session.tools);

    session.resolvePendingCall = (entry, contentText, isError = false) => {
      if (!entry || entry.settled) return;
      entry.settled = true;
      session.pendingById.delete(entry.id);
      suspendedByCallId.delete(entry.id);
      respondJson(entry.res, 200, {
        jsonrpc: '2.0',
        id: entry.rpcId,
        result: {
          content: [{ type: 'text', text: String(contentText ?? '') }],
          isError: Boolean(isError)
        }
      });
    };

    session.destroy = (reason) => {
      if (session.closed) return;
      session.closed = true;
      activeSessions.delete(session);
      clearTimeout(session.batchTimer);
      clearTimeout(session.maxBatchTimer);
      clearTimeout(session.suspendTimer);
      clearTimeout(session.turnTimer);
      for (const [id, entry] of session.pendingById.entries()) {
        suspendedByCallId.delete(id);
        if (!entry.settled) {
          entry.settled = true;
          try { entry.res.destroy(); } catch {}
        }
      }
      session.pendingById.clear();
      session.pendingBatch.length = 0;
      try { session.lines?.close(); } catch {}
      if (session.child && !session.processExited) {
        try { session.child.kill(); } catch {}
        const killer = setTimeout(() => {
          try { session.child?.kill('SIGKILL'); } catch {}
        }, 2000);
        killer.unref?.();
      }
      try { session.server?.close(); } catch {}
      removeScratchDir(session.sessionDir);
      if (session.turn && !session.turn.done) {
        if (reason) session.processError = session.processError ?? reason;
        session.turn.onProcessDone();
      }
    };

    const handleCliEvent = (event) => {
      if (!event || typeof event !== 'object') return;
      if (event.usage) session.usage = event.usage;
      const turn = session.turn;
      if (platform === 'antigravity') {
        if (event.event === 'result') {
          session.terminalResult = true;
          if (event.result?.usage) session.usage = event.result.usage;
          if (event.result?.status !== 'SUCCESS') {
            session.processError = new Error(safe(event.result?.error ?? event.result?.status ?? 'Antigravity failed'));
          } else if (typeof event.result?.response === 'string') {
            turn?.applySnapshotText(event.result.response);
          }
        }
        return;
      }
      if (event.type === 'thinking' || event.type === 'reasoning') {
        const text = typeof event.text === 'string' ? event.text : typeof event.delta === 'string' ? event.delta : '';
        if (text) turn?.appendReasoning(text);
        return;
      }
      if (event.type === 'assistant') {
        const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
        const thinking = blocks
          .filter(x => x && x.type === 'thinking' && typeof x.thinking === 'string')
          .map(x => x.thinking)
          .join('');
        if (thinking) turn?.applySnapshotReasoning(thinking);
        const text = blocks
          .filter(x => x && x.type === 'text' && typeof x.text === 'string')
          .map(x => x.text)
          .join('');
        if (text) turn?.applySnapshotText(text);
        return;
      }
      if (['text', 'text-delta', 'assistant-delta'].includes(event.type)) {
        const text = event.text ?? event.delta ?? '';
        if (typeof text === 'string' && text) turn?.appendText(text);
        return;
      }
      const delta = event.type === 'stream_event'
        ? event.event?.delta
        : event.type === 'content_block_delta'
          ? event.delta
          : undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        turn?.appendText(delta.text);
        return;
      }
      if (event.type === 'result') {
        session.terminalResult = true;
        if (event.is_error || event.subtype?.startsWith('error')) {
          const msg = (event.errors ?? [event.result ?? 'CLI failure']).join('; ');
          session.processError = new Error(safe(msg));
        } else if (typeof event.result === 'string') {
          turn?.applySnapshotText(event.result);
        }
        return;
      }
      if (event.type === 'error') {
        session.processError = new Error(safe(event.error?.message ?? event.error ?? event.message ?? 'CLI error'));
      }
    };

    session.spawnCli = (spec, extraEnv) => {
      const child = spawnProcess(spec.command, spec.args, {
        cwd: sessionDir,
        shell: false,
        windowsHide: true,
        ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
        stdio: ['pipe', 'pipe', 'pipe']
      });
      session.child = child;
      let stdoutChars = 0;
      const lines = createInterface({ input: child.stdout });
      session.lines = lines;
      lines.on('line', line => {
        stdoutChars += line.length + 1;
        if (stdoutChars > MAX_OUTPUT_CHARS) {
          session.processError = new Error('CLI output limit exceeded');
          session.destroy(session.processError);
          return;
        }
        const trimmed = line.trim();
        if (!trimmed || trimmed[0] !== '{') return;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          return;
        }
        try {
          handleCliEvent(event);
        } catch (err) {
          session.processError = err;
          session.destroy(err);
        }
      });
      child.stderr.on('data', chunk => {
        session.stderr = (session.stderr + chunk.toString()).slice(-8192);
      });
      child.on('error', err => {
        session.processError = err;
        session.processExited = true;
        session.turn?.onProcessDone();
        session.destroy(err);
      });
      child.on('close', code => {
        session.exitCode = code;
        session.processExited = true;
        if (session.closed) {
          removeScratchDir(session.sessionDir);
          return;
        }
        if (session.pendingBatch.length > 0 && session.turn && !session.turn.done) {
          flushBatchToTurn();
          return;
        }
        session.turn?.onProcessDone();
        if (!session.turn?.suspended) {
          session.destroy();
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end();
    };

    activeSessions.add(session);
    return session;
  }

  function attachTurn(session, signal) {
    const queue = [];
    let wake = null;
    const turnPrefix = session.sessionText;
    const turnReasoningPrefix = session.sessionReasoning;
    const turn = {
      nextIndex: 0,
      openBlock: null,
      turnText: '',
      lastSnapshot: '',
      turnReasoning: '',
      lastReasoningSnapshot: '',
      hadOutput: false,
      suspended: false,
      aborted: false,
      timedOut: false,
      done: false,
      enqueue(chunk) {
        queue.push(chunk);
        if (wake) {
          const resolveWake = wake;
          wake = null;
          resolveWake();
        }
      },
      closeOpenBlock() {
        if (!turn.openBlock) return;
        turn.enqueue({
          type: 'block-end',
          index: turn.openBlock.index,
          block: { type: turn.openBlock.type, text: turn.openBlock.text }
        });
        turn.openBlock = null;
      },
      appendReasoning(text) {
        if (!text || turn.done) return;
        if (turn.openBlock?.type !== 'reasoning') {
          turn.closeOpenBlock();
          turn.openBlock = { type: 'reasoning', index: turn.nextIndex++, text: '' };
          turn.enqueue({ type: 'block-start', index: turn.openBlock.index, blockType: 'reasoning' });
        }
        turn.openBlock.text += text;
        turn.turnReasoning += text;
        session.sessionReasoning += text;
        turn.hadOutput = true;
        turn.enqueue({ type: 'reasoning-delta', index: turn.openBlock.index, text });
      },
      appendText(text) {
        if (!text || turn.done) return;
        if (turn.openBlock?.type !== 'text') {
          turn.closeOpenBlock();
          turn.openBlock = { type: 'text', index: turn.nextIndex++, text: '' };
          turn.enqueue({ type: 'block-start', index: turn.openBlock.index, blockType: 'text' });
        }
        turn.openBlock.text += text;
        turn.turnText += text;
        session.sessionText += text;
        turn.hadOutput = true;
        turn.enqueue({ type: 'text-delta', index: turn.openBlock.index, text });
      },
      applySnapshotText(rawText) {
        applyCumulativeSnapshot(rawText, 'sessionText', 'turnText', 'lastSnapshot', turnPrefix, turn.appendText);
      },
      applySnapshotReasoning(rawText) {
        applyCumulativeSnapshot(rawText, 'sessionReasoning', 'turnReasoning', 'lastReasoningSnapshot', turnReasoningPrefix, turn.appendReasoning);
      },
      finishTurn() {
        if (turn.done) return;
        turn.done = true;
        if (wake) {
          const resolveWake = wake;
          wake = null;
          resolveWake();
        }
      },
      onProcessDone() {
        if (turn.done) return;
        turn.closeOpenBlock();
        if (turn.aborted || signal?.aborted) {
          turn.enqueue({ type: 'finish', reason: { kind: 'aborted' } });
          turn.finishTurn();
          return;
        }
        if (turn.timedOut) {
          const err = new Error('TIMEOUT');
          onState(session.platform, { state: 'error', checkedAt: new Date().toISOString(), lastError: failure(err) });
          turn.enqueue({ type: 'finish', reason: { kind: 'error', failure: failure(err) } });
          turn.finishTurn();
          return;
        }
        const badExit = session.exitCode !== 0 || session.processError || (!session.terminalResult && !turn.hadOutput);
        if (badExit) {
          const err = session.processError || new Error(`${session.platform}: exit=${session.exitCode}; ${safe(session.stderr) || 'Missing terminal result or empty answer / 无终止结果或回答'}`);
          onState(session.platform, { state: 'error', checkedAt: new Date().toISOString(), lastError: failure(err) });
          turn.enqueue({ type: 'finish', reason: { kind: 'error', failure: failure(err) } });
          turn.finishTurn();
          return;
        }
        onState(session.platform, { state: 'connected', checkedAt: new Date().toISOString(), lastError: null });
        const normalizedUsage = normalizeCliUsage(session.usage);
        if (normalizedUsage) {
          turn.enqueue({ type: 'usage', usage: normalizedUsage });
        }
        turn.enqueue({ type: 'finish', reason: { kind: 'stop' } });
        turn.finishTurn();
      },
      async *iterate() {
        const onAbort = () => {
          turn.aborted = true;
          session.destroy(new Error('ABORTED'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        clearTimeout(session.turnTimer);
        session.turnTimer = setTimeout(() => {
          turn.timedOut = true;
          session.destroy(new Error('TIMEOUT'));
        }, turnTimeoutMs);
        session.turnTimer.unref?.();
        try {
          while (!turn.done || queue.length > 0) {
            if (queue.length > 0) {
              yield queue.shift();
              continue;
            }
            await new Promise(r => { wake = r; });
          }
        } finally {
          clearTimeout(session.turnTimer);
          signal?.removeEventListener('abort', onAbort);
          if (!turn.suspended && !session.closed) {
            session.destroy();
          }
        }
      }
    };
    const applyCumulativeSnapshot = (rawText, sessionField, turnField, lastField, prefix, appendFn) => {
      if (typeof rawText !== 'string' || !rawText || turn.done) return;
      if (rawText === session[sessionField]) return;
      let candidate = rawText;
      if (prefix && candidate.startsWith(prefix)) {
        candidate = candidate.slice(prefix.length);
        if (!turn[turnField].startsWith('\n') && !turn[turnField].startsWith('\r')) {
          candidate = candidate.replace(/^(?:\r?\n)+/, '');
        }
        if (!candidate) return;
      }
      if (candidate === turn[turnField]) return;
      if (candidate.startsWith(turn[turnField])) {
        appendFn(candidate.slice(turn[turnField].length));
        turn[lastField] = candidate;
        return;
      }
      if (candidate.length >= 8 && turn[turnField].endsWith(candidate)) return;
      if (turn[lastField] && candidate.startsWith(turn[lastField])) {
        appendFn(candidate.slice(turn[lastField].length));
        turn[lastField] = candidate;
        return;
      }
      appendFn(candidate);
      turn[lastField] = candidate;
    };
    session.turn = turn;
    return turn;
  }

  async function* stream(platform, options = {}) {
    if (disposed) {
      yield { type: 'finish', reason: { kind: 'error', failure: failure(new Error('Hub disposed')) } };
      return;
    }
    if (options.signal?.aborted) {
      yield { type: 'finish', reason: { kind: 'aborted' } };
      return;
    }
    const pendingResults = extractPendingToolResults(options.messages);
    const existingSession = findSuspendedSession(pendingResults);
    if (existingSession) {
      clearTimeout(existingSession.suspendTimer);
      existingSession.suspendTimer = null;
      if (Array.isArray(options.tools) && options.tools.length) {
        existingSession.tools = options.tools;
      }
      const turn = attachTurn(existingSession, options.signal);
      const pendingEntries = [...existingSession.pendingById.values()];
      for (let i = 0; i < pendingEntries.length; i += 1) {
        const entry = pendingEntries[i];
        const result = pendingResults.resultsById.get(entry.id);
        let text = result ? result.content : 'Tool result not provided.';
        if (i === pendingEntries.length - 1 && pendingResults.trailingText) {
          text = `${text}\n\n[Follow-up context]\n${pendingResults.trailingText}`;
        }
        existingSession.resolvePendingCall(entry, text, result ? result.isError : true);
      }
      if (existingSession.processExited && !turn.done) {
        turn.onProcessDone();
      }
      yield* turn.iterate();
      return;
    }

    let session;
    try {
      const requestedModel = typeof options.model === 'string' ? options.model : options.model?.id;
      const resolvedModel = requestedModel ? await resolveModelId(platform, requestedModel, options.reasoningEffort) : undefined;
      const cli = cliDetect(platform);
      const extraEnv = await resolveEnv(platform);
      session = await createSession(platform, options);
      const turn = attachTurn(session, options.signal);
      const flat = formatMcpPrompt(options);
      const spec = buildMcpCliCommand(platform, flat.prompt, resolvedModel, options.reasoningEffort, session.sessionDir, cli);
      session.spawnCli(spec, extraEnv);
      yield* turn.iterate();
    } catch (err) {
      session?.destroy(err);
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted' } };
      } else {
        onState(platform, { state: 'error', checkedAt: new Date().toISOString(), lastError: failure(err) });
        yield { type: 'finish', reason: { kind: 'error', failure: failure(err) } };
      }
    }
  }

  function hasSuspendedSessionFor(messages) {
    const pending = extractPendingToolResults(messages);
    return Boolean(findSuspendedSession(pending));
  }

  function dispose() {
    disposed = true;
    for (const session of [...activeSessions]) {
      session.destroy(new Error('Hub disposed'));
    }
    activeSessions.clear();
    suspendedByCallId.clear();
  }

  return {
    stream,
    hasSuspendedSessionFor,
    dispose
  };
}
