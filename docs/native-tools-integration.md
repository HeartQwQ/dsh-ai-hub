# 各平台接入 DSH 原生工具调用：核实结论与 WorkBuddy CN 实现

记录时间：2026-11-14。结论来自本机安装包源码、已安装插件源码和对 WorkBuddy CN 的真实请求（仅免费模型 `hy4free`）。线上网关规则可能随时变化，以下“实测”只代表记录当天的行为。

## 总结论

- 只有 DSH 宿主自己跑 agent 循环、模型返回结构化 `tool-call` 时，才能和 DeepSeek 原生工具能力对齐。CLI 自己跑循环时，hub 只能收回最终文本。
- WorkBuddy CN 的 `hy4free` 原生支持 OpenAI 风格的 `tool_calls`。hub 现已为 `workbuddy-cn` 实现原生适配器（`workbuddy-chat.mjs`），在中性系统提示下多步工具循环实测通过。
- **DSH 主会话目前仍无法使用 WorkBuddy CN**：腾讯网关按系统提示内容识别 DSH，返回 HTTP 400、业务码 11128（`Illegal API invocation from an unapproved channel`）。这是服务方的渠道限制，hub 不做规避，只给出明确报错。
- Codex 通过 `dsh-codex-subscription` 的 `openai-codex` 代理，代码路径上已带宿主工具。Cursor 和 Antigravity 没有可供 hub 直连的工具接口，只能走 CLI 子代理或 MCP 混合接入。

## 宿主协议（DSH 安装包 `resources/app.asar`）

### 流式块

`@deepseek-ai/dsh-llm` 的 `BlockAssembler` 是唯一的组装算法。适配器输出的 `StreamChunk` 有七种：

| 块 | 字段 |
| --- | --- |
| `block-start` | `index`、`blockType`（`text` / `reasoning` / `tool-call`） |
| `text-delta` / `reasoning-delta` | `index`、`text` |
| `tool-call-delta` | `index`、`id`、可选 `name`、`argumentsDelta`；每个分片都要带 `id`，组装器会用它覆盖 |
| `block-end` | `index`、完整 `block`；先到的 `block-end` 为准 |
| `usage` | `inputTokens`（不含缓存）、`outputTokens`、`totalTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens` |
| `finish` | `reason.kind` 取 `stop` / `tool-calls` / `max-tokens` / `aborted` / `error`；`max-tokens` 时组装器丢弃工具调用 |

### 请求

`GenerateOptions` 包含 `provider`、`model`、`reasoningEffort`、`messages`、`system`（字符串）、`tools`、`toolHistory`、`temperature`、`maxTokens`、`stop`、`signal`。没有 `toolChoice`。

- `ToolSchema` 是 `{ name, description, parameters, deferLoading? }`。
- 消息角色有 `system`、`developer`、`user`、`assistant`、`tool`。assistant 的 `tool-call` 块是 `{ type, id, name, arguments: JSON 字符串 }`。工具结果消息带 `toolCallId` 和可选 `isError`。
- 模型信息不声明 `toolUpdate` 时，运行时会删掉 developer 消息，并去掉 `deferLoading`，适配器拿到的是完整的当前工具表。
- 模型 `inputModalities` 不含 `image` 时，运行时把图片投影成文字。

### 失败

适配器抛出的异常由运行时转成 `finish` 块：信号已中止时为 `aborted`，否则为 `error`。普通 `Error` 只要带自身的 `code` 属性就能被分类，可选附带 `status`、`providerRetryAfterMs`。常用 code：`AUTH`、`QUOTA`、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`、`SERVER`、`MALFORMED_RESPONSE`、`EMPTY_RESPONSE`、`STREAM_CLOSED`。

### 工具服务

`@deepseek-ai/dsh-tools` 的 `ToolsService` 提供 `definitions()`、`schemas()`、`get()`、`execute()`，没有 `list()`。`execute()` 走宿主执行器，审批和沙箱仍然生效。插件根上下文能看到全局注册的工具；会话工具挂在 `agent.ctx` 上，不出现在根列表。`restrict()` 不能从插件根上下文调用。MCP 桥的前提已经具备，缺口在会话作用域和审批。

## 各平台核实

| 主张 | 结论 | 依据 |
| --- | --- | --- |
| 完全对齐必须由宿主跑循环 | 成立 | 宿主流有 `tool-call-delta`；hub 的 CLI 适配器明确丢弃工具 |
| Codex 已能完全等同 | 成立（代码路径） | `openai-codex` 已注册时，hub 的 `codex` 原样代理；pi-ai 会发送 function tools |
| Codex 复用 `~/.codex/auth.json` | 不成立 | `dsh-codex-subscription` 是独立 ChatGPT OAuth，令牌存于 DSH 凭据库 |
| Antigravity / Cursor 只能混合接入 | 成立 | 两边都没有公开的 HTTP 工具接口，CLI 只回文本 |
| Antigravity `session/new` 可按会话注入 `mcpServers` | 未定 | `agy acp` 和 `mcpServers` 解析存在，二进制中没有 `session/new` 字面量 |
| 子代理自动跟随父会话 | 部分成立 | 进程内 `subagent` 继承父会话的 provider/model；`subagent_cursor` 等仍走 CLI 文本 |
| WorkBuddy 上游支持原生工具 | 成立（实测） | 见下节 |

### Codex

- hub 在 `codex` 这个 id 未被占用时，用 `createProxyAdapter` 代理到 `openai-codex`。请求原样交给 `llm.stream`，只改 `provider`。
- 上游地址是 `https://chatgpt.com/backend-api/codex/responses`。
- 额度查询仍走 Codex CLI 的 `app-server`，和聊天代理是两条路。
- `openai-codex` 未注册时，hub 退回文本 `createAdapter`，工具会丢失。

### Cursor 与 Antigravity

- Cursor 的模型通道是 `cursor-agent --mode ask`。Antigravity 的 `step_update`（工具进度）被丢弃，只保留最终文本。
- 输入预算 24,000 字符，`cliCall` 拒绝超过 26,000 字符的 prompt。
- Antigravity：`agy acp` 提供 ACP stdio 服务，`agy mcp` 可以增删查 MCP；`--input-format stream-json` 能从 stdin 读入，可绕开命令行长度限制，hub 目前用的是 `-p <prompt>`。
- Cursor：`cursor-agent --approve-mcps` 配合项目级 `.cursor/mcp.json` 可接 MCP。内部 protobuf AgentService 未逆向，不作为已核实接口。
- 两边的工具循环都留在子进程里，做不到和宿主原生工具卡片走同一条执行链。

### 风险

- Codex 插件把订阅 OAuth 发到 `chatgpt.com`，WorkBuddy 把登录凭据发到 `copilot.tencent.com`，这类条款风险在现有插件里已经存在。
- WorkBuddy 的渠道校验（11128）说明腾讯明确不允许 DSH 这类第三方客户端调用该接口。

## WorkBuddy CN 原生适配器

### 实测的网关行为（`hy4free`，2026-11-14）

- 端点：`POST https://copilot.tencent.com/v2/chat/completions`，SSE 返回，夹带 `: heartbeat` 注释行。
- 返回的 `model` 是 `hy4-free`，推理默认开启，走 `delta.reasoning_content`。
- 空值一律是 `""`：`content`、`reasoning_content`、`refusal`、`finish_reason` 都是空串，`tool_calls` 是空数组。
- 工具调用：第一个分片带 `id`（如 `chatcmpl-tool-…`）、`name` 和空 `arguments`；后续分片 `name` 为空串、不带 `id`，只能按 `index` 归并参数。
- 最后一帧同时带 `finish_reason: "tool_calls"`（或 `stop`）、`usage` 和一个空的 `function_call`，之后是 `data: [DONE]`。
- usage 含 `prompt_tokens`、`completion_tokens`、`total_tokens`、`completion_tokens_details.reasoning_tokens`、`cached_tokens`。
- 同一轮可以返回多个并行工具调用；assistant 历史带 `reasoning_content` 和 `tool_calls` 回传后正常继续。
- `stream_options.include_usage` 被接受。
- 系统提示含 DSH 身份句（如 `You are an AI agent powered by DeepSeek Harness`）时，返回 HTTP 400，业务码 11128。中性系统提示正常。

`/v3/config` 中 `hy4free` 的关键字段：`maxInputTokens 960000`、`maxOutputTokens 64000`、`supportsToolCall true`、`supportsImages true`、`onlyReasoning true`、`reasoning.supportedEfforts ["high"]`、`reasoning.defaultEffort "high"`、`reasoning.canDisableThinking false`、`credits "x0.00"`。`hy3` 同样免费并支持工具。

### 实现

| 文件 | 内容 |
| --- | --- |
| `workbuddy-chat.mjs` | `toChatBody` 转换请求；`translateEvents` 把 SSE 转成宿主流式块；`classifyFailure` 映射失败码；`streamChat` 带 180 秒无数据看门狗；`createWorkbuddyAdapter` 组装适配器 |
| `workbuddy.mjs` | 新增 `openChat`：鉴权后发送请求，401 时刷新一次令牌重试；模型目录读取 `reasoning.supportedEfforts` / `defaultEffort` |
| `index.js` | `workbuddy-cn` 注册原生适配器，经 `meterStream` 记录用量；状态中 `modelChannel` 为 `tools` |
| `workbuddy-chat.test.mjs` | 8 个用例，夹具采用实测分片形状 |

请求转换规则：

- `system` 和最前面的 system/developer 文本合并成首条 system 消息，没有时用 `You are a helpful assistant.` 补位。网关要求首条必须是 system 消息，且拒绝 `developer` 角色。
- 历史中段的 system/developer 文本作为 system 消息原位保留；`tool-addition` / `tool-removal` 块忽略。
- assistant 消息转成 `content`、`reasoning_content`、`tool_calls`，参数为空时补 `{}`。
- 工具结果转成 `role: "tool"` 和 `tool_call_id`，空结果填 `(empty)`，出错时填 `Error`。
- 工具表转成 `type: "function"`，并带 `tool_choice: "auto"`；网关只接受字符串形式。
- 始终 `stream: true`；只在宿主显式给出时发送 `max_tokens`、`temperature`、`stop`。
- `reasoning_effort` 只在模型支持该档位时发送。`hy4free` 只发 `high`。
- 图片暂按文字占位发送，模型信息声明 `inputModalities: ["text"]`，由运行时投影。

失败映射：

| 网关返回 | code |
| --- | --- |
| 业务码 11128 | `INVALID_REQUEST`，附中文说明，不重试 |
| 401 / 403 | `AUTH` |
| 402 或额度、积分不足 | `QUOTA` |
| 429 或限流文案 | `RATE_LIMIT`，读取 `Retry-After` |
| 400 / 413 且上下文超长 | `CONTEXT_WINDOW_EXCEEDED` |
| 其他 400 / 413 / 422 | `INVALID_REQUEST` |
| 5xx 或无状态 | `SERVER` |
| `finish_reason: "length"` | 结束原因 `max-tokens` |
| `finish_reason: "content_filter"` | `CONTENT_FILTERED` |
| 无内容 | `EMPTY_RESPONSE` |

只要出现过工具调用，结束原因就是 `tool-calls`，即使网关报的是 `stop`。

### 有意不做的部分

`dsh-connect-workbuddy` 5.21.3 的 shim 会改写或打散 DSH 身份句、插入零宽字符、在 11128 后换中性开头重试，以绕过渠道校验。这属于规避服务方的访问限制，hub 不移植这部分，也不建议靠修改提示措辞绕过。DSML 文本标记恢复（`<tool_calls>` / `<invoke>`）暂未实现：实测 `hy4free` 返回的是原生 `tool_calls`。

`dsh-connect-workbuddy` 已安装在 desktop profile 的 `node_modules`，但不在 bundles 列表里；崩溃日志记录它在 2026-11-11 被设为 `enabled: false`。

### 验证

- `node --test workbuddy-chat.test.mjs`：8 个用例通过。
- `npm test`：123 个用例通过；`node validate.mjs` 通过。
- 真实端到端（宿主 `BlockAssembler` 组装，`hy4free`，中性系统提示）：
  - 第一步调用 `list_files`；
  - 第二步并行调用两次 `read_file`；
  - 第三步回答“这个项目运行时会在控制台输出数字 42。”。
  - 每步约 1–2 秒，usage 和结束原因正确。
- 同一脚本换成 DSH 身份句开头：第一步即返回 11128。
- 探测时禁止了令牌刷新，凭据只放在内存，未改动任何凭据存储，也未打印凭据。
- 尚未在重启后的 DSH 桌面主会话中验证；按上面的实测，主会话预计会显示 11128 报错。

## 后续选项

- 在主会话中正当使用混元模型：申请腾讯混元官方 API 密钥，在 DSH 中配置为 OpenAI 兼容的自定义服务商。
- WorkBuddy 的子代理纯文本路径（`subagent_workbuddy`）不经过 DSH 系统提示，不受本次改动影响。
- Antigravity 可尝试 `agy mcp` 或 ACP；Cursor 可尝试项目级 `.cursor/mcp.json` 加 `--approve-mcps`。两者都到不了宿主原生工具卡片。
- MCP 桥可基于 `ctx.tools.definitions()` / `schemas()` / `execute()`，只监听回环，按会话下发一次性令牌；会话工具需要拿到对应的 `agent.ctx`。
