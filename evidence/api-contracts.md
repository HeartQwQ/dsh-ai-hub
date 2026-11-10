# API 契约核对记录

2026-11-04，通过 shell 的只读 HTTPS 请求取得 npm 元数据和包类型声明，在 Node 内存中解压；没有运行、安装或复制第三方实现到本 bundle。

| 来源 | 已确认的契约 |
|---|---|
| `@deepseek-ai/dsh-workspace@0.2.2-rc.1`，`lib/types/index.d.ts` / `types.d.ts` | Host service 为 `workspaceRegistry`；`list(): Workspace[]`；Workspace 字段 `id/title/path/sessionIds`。之前猜测的 `workspaces` 未用于最终实现。 |
| `@deepseek-ai/cordis@4.1.0`，`lib/types/reflect.d.ts` | `ctx.provide(name, value)` 返回卸载 disposer；`get` 可读取可选服务；资源随所属 fiber 清理。 |
| `@deepseek-ai/dsh-llm@0.2.2-rc.1`，`lib/types/index.d.ts` / `types.d.ts` | `registerAdapter`、`registerConfigurableProviders`、`listModels/resolveModel/prepareCall/stream`；GenerateOptions 含 messages、可选 system/tools/signal。 |
| `@deepseek-ai/dsh-client-ui-conversation@0.2.2-rc.1`，`client/contract/slots.d.ts` | `conversation.header.leading` 是 root/single，无 owner 专属属性；无 session 时可显示。 |
| `@deepseek-ai/dsh-client-ui-layout@0.2.2-rc.1`，`client/index.d.ts` | `shell.overlay` 是 root/list，独立 id 可添加浮层。 |
| 本地 `dsh-platforms` / `dsh-cursor-model` / `dsh-office` | 自有 adapter 与 subagent 协议、patch、Client 模块壳与 locale/slot 生命周期；没有直接依赖这些旧插件。 |
| 第三方 `dsh-connect-workbuddy/lib`（只读参考） | 固定 CN `copilot.tencent.com/v3/config`、`/v2/chat/completions` 与 `www.codebuddy.cn/v2/billing/meter/get-user-resource`；积分字段仅作协议参考，最小投影独立重写；鉴权涉及读取桌面凭证，未执行此部分。 |

元数据来源（Primary package registry）：
- https://registry.npmjs.org/@deepseek-ai%2Fdsh-workspace/0.2.2-rc.1
- https://registry.npmjs.org/@deepseek-ai%2Fcordis/4.1.0
- https://registry.npmjs.org/@deepseek-ai%2Fdsh-llm/0.2.2-rc.1
- https://registry.npmjs.org/@deepseek-ai%2Fdsh-client-ui-conversation/0.2.2-rc.1
- https://registry.npmjs.org/@deepseek-ai%2Fdsh-client-ui-layout/0.2.2-rc.1

限制：任务只允许 shell/文件工具，且禁止安装和读取 app.asar，因此没有 live cordis inspection 或 installed Client/Host 断言。以上类型契约核对与本地替身上下文测试都不等同于 Lead 安装后的实际运行验收。
