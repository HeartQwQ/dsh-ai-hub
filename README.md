# DSH AI Hub 0.5.18

## 当前需求状态

| 需求 | 当前状态 |
| --- | --- |
| 平台模型管理与用量 | 顶部保留总览、平台和用量。平台内可查看账号、模型和用量。API Key 和对应模型在 DSH 原生「设置 → 模型」管理。 |
| Antigravity 额度 | 通过 `agy --print /usage --output-format text` 读取剩余比例和重置时间。平台健康按「Gemini 4 Argon：周」和「Gemini Models：5h；周」分两行显示，详情保留各组额度。正常额度刷新只启动一次 CLI。 |
| 后台同步 | 宿主启动后预读账号、额度和模型，并将展示数据缓存到本地。后台每五分钟更新，可见页面每十五秒或在窗口聚焦时读取本机缓存。 |
| 平台顺序 | 总览和平台侧栏都按 DeepSeek 账号、WorkBuddy CN、Codex、Cursor、Antigravity 的顺序展示。 |
| 登录状态 | 总览与平台页共用状态判断。登录态、额度和模型目录均可用时显示「已登录」。Antigravity 以成功读取受登录保护的额度确认登录，账号邮箱暂不读取。 |
| 授权后更新 | DeepSeek 和 WorkBuddy 授权完成后立即刷新对应平台。终端登录启动后，回到 DSH 时自动复查对应平台。 |
| 刷新入口 | 顶部刷新重读全部平台，平台页工具栏只刷新当前平台。两处均覆盖账号、额度和模型，启动预读及页面缓存读取不触发刷新动画。 |
| 平台页布局 | 侧栏用品牌图标和平台名称导航。右侧内容区上下留白 12px、左右 16px，卡片铺满可用宽度。「账号」页签按账号、余额或额度、模型列表排列，「用量」独立展示。总览的平台信息、额度和状态等宽排列，额度文字左对齐。 |
| 账号页控件 | 更新时间只显示时分，位于刷新按钮旁。各平台统一模型网格和切换账号按钮样式，已有测活入口放在模型搜索栏后方。 |
| WorkBuddy 积分 | 账号页使用统一额度卡，显示可用积分、当期基础积分、剩余量和有效期，其他积分包可展开。每日签到由用户点击领取，启动和后台同步只查询状态。 |
| 切换账号 | 各平台在账号栏右侧统一显示「切换账号」。DeepSeek、Codex 和 Cursor 在用户确认退出后重新授权，WorkBuddy 走网页授权，Antigravity 在 AGY 终端内通过 `/logout` 切换。 |
| 平台账号资料 | 「账号与额度」统一身份栏，「平台健康」用脱敏账号替代模型数量。DeepSeek 和 Cursor 读取平台头像、姓名和账号，WorkBuddy 显示昵称和掩码账号，Codex 显示掩码登录邮箱。未提供头像时用通用图标，Antigravity 账号资料目前不可用。 |
| DeepSeek 账号页 | 恢复单张账号卡及余额、赠送余额、模型三项布局，模型管理入口仍可用。平台健康在 DeepSeek 账号行显示 DSH 余额。 |
| Codex 额度 | 5 小时和每周窗口按剩余比例显示，保留重置时间。 |
| Codex 模型目录 | 模型管理页优先读取 DSH 内置 Codex 适配器。目录为空时，通过本机 Codex app-server 的只读接口读取。「重新读取」会重试内置目录。 |
| 聊天模型选择器 | 输入区菜单在「模型」上方提供「平台」。切换平台后只展示该平台的模型，选定模型时更新当前会话。积分倍率与推理等级沿用会话目录。 |
| 模型选择 | 插件不再配置默认模型。会话使用当次选中的模型，未指定模型的测活和子代理由对应平台选择。旧的 `platforms.*.model` 字段读取时忽略，下次保存平台设置时移除。 |
|Cursor 双额度池 | 复用本机 Cursor CLI 登录态读取 Cursor Models 和 Other Models 的剩余比例及重置时间。总览分两行显示剩余比例，详情还显示重置时间，窄屏也可见。宿主返回旧版套餐信息时，总览提示完整重启 Harness；登录失效时需恢复 Cursor CLI 登录。该服务使用 Cursor 客户端的内部接口，接口变更及其他套餐仍待验证。 |
| Windows CLI 闪窗 | 后台 CLI 使用隐藏窗口启动。本次减少额度轮询引起的重复启动。只读额度查询中未检测到新终端窗口，真实模型调用时的闪窗仍待复测。 |

## 待办事项 (TODO)

- [ ] **WorkBuddy 企业账号积分与用量分流**：当凭据包含非空 `enterpriseId` 时，支持调用企业账单接口 `POST /v2/billing/meter/get-enterprise-user-usage`（解析 `credit`、`limitNum`、`remainDay`，计算 `remaining = Math.max(0, limitNum - credit)`），与个人资源包接口 `get-user-resource` 分流展示。

## 底层登录态与账号信息优化

- **WorkBuddy 桌面端 5.6.0+ 字段解密与凭据优先级**：
  - 支持识别并解密 WorkBuddy 5.6.0+ 桌面端 `.info` 文件中的 `$wbEncrypted`（AES-256-GCM + `WB-AAD\0` 关联数据）加密字段；当检测到加密桌面凭据但无法读取本机密钥时，返回明确的 `AUTH_BOUNDARY` 提示（引导使用 Web 登录或配置 `WORKBUDDY_APP_EXECUTABLE`）。
  - 扫描 `%LOCALAPPDATA%` 与 `%APPDATA%` 下的 `CodeBuddyExtension\Data\Public\auth` 目录，始终优先使用实时文件（`workbuddy-desktop-ai.info`、`workbuddy-desktop.info`）而非保留远期过期时间的历史备份 `.info` 文件，并按 `lastRefreshTime` → `expiresAt` → `mtimeMs` 排序。
  - 凭据加载与刷新单飞合并（Single-Flight）、提前 5 分钟刷新、刷新请求移除陈旧 `Authorization` 头、保留 `nickname` 等账号信息；当刷新接口因网络或 5xx 失败但当前 `accessToken` 距过期仍大于 30 秒时，自动回退复用有效 Token。
- **Codex 本机 `auth.json` 快速解析与直连用量回退**：
  - 优先读取 `~/.codex/auth.json`（或 `CODEX_HOME/auth.json`），通过本地解码 `id_token` / `access_token` JWT 提取邮箱、账号 ID 与套餐类型，无需每次启动 `codex app-server` 子进程。
  - 当本地 Token 有效时直接请求 `GET https://chatgpt.com/backend-api/wham/usage`（含单飞合并与 429 `Retry-After` 解析），失败或过期时平滑回退到 `codex app-server` RPC。
- **Cursor 与 Antigravity (`agy`) 同源优化**：
  - Cursor：支持本地解码 `%APPDATA%\Cursor\auth.json`（含跨平台路径回退）JWT 预判过期时间（提前 5 分钟刷新窗口）；当配置了 `apiKey`（或 `CURSOR_API_KEY`）时支持直连 `POST /auth/exchange_user_api_key` 换取新 Token，OAuth 登录态支持通过 `cursor-agent status --format json` 刷新重试；读取 `~/.cursor/cli-config.json` 的 `authInfo` 自动携带 `x-cursor-team-id` 与 `x-cursor-client-type: cli` 请求头，并在 `GetMe` 偶发失败时优先回退读取本地 `cli-config.json` 缓存的邮箱与昵称；Dashboard 请求单飞合并（兼容传入 `AbortSignal`）、识别 429 `Retry-After`。
  - Antigravity (`agy`)：额度与模型目录共享 `AUTH_BOUNDARY` 鉴权失败判定，并行刷新 `catalogInfo` 与 `quota` 时复用刚完成的目录探测结果（避免重复启动 `agy.exe models`），并对目录读取失败增加 60 秒退避缓存（防止未登录时每次解析模型重复拉起 CLI 子进程）。

## 0.5.3 额度同步与账号页恢复

基于已安装的 0.5.2 增量更新。Antigravity 额度进入账号与额度、用量面板。前端可见时每分钟检查缓存，服务端合并并发请求，到期时读取新值。手动刷新可立即重试。

## 0.5.2 移除本机网关与设置页

- 删除本机网关的 HTTP 路由：`/plugins/dsh-ai-hub/gateway/*` 不再注册，不再向外部客户端转发。
- 删除客户端网关开关、Base URL、网关 Key、轮换、外部客户端接入片段和网关状态提示。
- 删除顶部「设置」页；顶部页签为 `总览 / 平台 / 用量`。
- DeepSeek 平台只保留账号登录；DeepSeek API 与自定义 provider 统一在「API 接口」。
- 保留 `p0` 账号数据与历史 `gateway` 用量记录用于兼容/统计，不提供新的网关入口。
- `p0Snapshot` 不再返回 gateway 信息；旧的网关 Key 不再生成或轮换。

## 0.5.1 用量采集补全与独立持久化

- 用量写入数据文件 `<DSH_PROFILE_DIR>/data/dsh-ai-hub/usage.json`；没有 `DSH_PROFILE_DIR` / `DSH_PROFILE` 时回退到 `<DSH_HOME>/data/dsh-ai-hub/usage.json`（默认 `~/.dsh`），`DSH_AI_HUB_USAGE_FILE` 可覆盖，测试使用临时路径。不再写插件配置：通过 `configEditor` 修改普通配置会重启插件，每次调用后写入会导致反复重启。0.5.0 写在配置里的 `aiHubUsage` 只在文件不存在时作为种子迁移一次，之后不再读写。原子写入（临时文件后改名），800ms 合并写入，失败保留数据并指数退避重试（上限 60 秒），卸载时最后写一次；文件损坏时改名为 `usage.json.corrupt-<时间>` 并从空开始；无法解析数据目录时为内存模式，界面显示「仅内存」。
- 三个采集来源：
  - Hub adapter / 子代理 / 测活经 `hub.call` 记录，含 `flattenWithMeta` 的系统提示、历史、裁剪、实际发送和预算；中断与失败按已流出字符记录；测活固定为 `test` 渠道，默认不计入。
  - 已有 `openai-codex` 时 Codex 由宿主 `llm.stream` 代理，不经 `hub.call`，现在由 `meterStream` 包装计量，宿主 usage 事件按实际 Token 记录（输入含缓存读写）。
  - 本机网关按正文字符计数（不再是 JSON 长度），记录 `reasoning_effort`、请求模型；流式响应透传时解析 SSE 的回答字符、TTFT 与末尾 usage；客户端断开记为中断，流中途上游失败记为失败。
  - DSH 原生会话仅监听实时 `session/event`：`request/header` 取 provider / 模型 / 强度，`assistant/message` 取输出字符、usage 和延迟。只记录 DeepSeek 与自定义 provider，Hub 自己的 CLI provider 不重复计数；插件启动前的历史事件与重复 seq 不计；读不到发送内容，输入字符显示「未读取」而不是 0。
- Token 口径分开存储：实际、`≈` 估算、未读取（—）各自累计，估算值从不加进实际值；0.5.0 早期把估算写进实际字段的日桶在加载时迁移。不做费用估算，不伪造缓存命中。
- 日聚合按日期保留 90 天（不是按桶数），最近 200 条明细。P95 在范围内全部调用仍在明细中时为精确值，否则用持久化的延迟直方图给出上界估计，界面标 `≈`。
- `usageSnapshot` 新增 `model` 筛选（服务端过滤，界面搜索 300ms 防抖）、`channels`、`lastContext`、`p95Exact`、`avgTtftMs`、成功/失败与实际/估算 Token 分列字段；`usageReset({platform})` 可只清一个平台。`p0Usage` / `p0Snapshot.usage` 改为读取统一存储的网关记录。
- 回填：旧版网关记录只存在 `p0` 内存中，从未持久化，因此升级前的进程内记录无法找回；启动时仍按 id 幂等导入 `p0` 内存记录。
- 新增 `usage-host.test.mjs`（hub.call、adapter 元数据、子代理、测活、Codex 代理、原生会话、文件持久化与迁移、HTTP RPC），扩充 `usage-store.test.mjs` 与 `p0.test.mjs`、`client.test.mjs`。

## 0.5.0 用量与界面重构

- 顶部页签改为 `总览 / 平台 / 用量 / 设置`，删除路由页、路由规则、候选链和路线图。
- 「模型管理」保持独立入口，不依赖 `dsh-ai-park`；办公室与模型管理互不干扰。
- 每个平台主画布增加 `账号与额度 / 模型管理 / 用量` 三个业务页签；平台用量独立统计。
- 全局「用量」汇总 Hub adapter、本机网关和 DSH 原生 DeepSeek 调用；支持平台/渠道/模型筛选、包含测活、CSV/JSON 导出、清空统计。
- 用量记录区分真实 Token、`≈` 估算 Token 和未知值；CLI 平台以字符数为真实口径。
- 记录上下文字符构成：系统提示、历史对话、裁剪省略、实际发送、预算。
- 日聚合保留 90 天，最近 200 条明细；持久化到数据文件（0.5.1 起，见上）。
- 移除页面上的路由文案、顶部宣传副标题、主要 Section 描述、径向渐变和 KPI 渐变。
- 用量接口：`usageSnapshot`、`usageReset`；`p0Usage` 保留兼容。

## 0.4.2 Antigravity 连接状态与登录终端

修复 Antigravity 顶部“已接入”但正文仍要求连接的矛盾：可读模型目录是接入依据，额度类型 unknown 不再被当作未登录。真实 AUTH 错误优先于旧的 connected 状态与缓存模型。CLI 明确要求 Please sign in 时保留 AUTH 分类；成功返回目录时不把初始化日志的 not logged in 当作鉴权失败。

Windows 快捷登录由隐藏 helper 使用 Start-Process -WindowStyle Normal 显式创建新 PowerShell 交互窗口。只有收到新进程确认才返回请求已提交；通过专用标题与窗口句柄确认终端时才显示“已打开”，兼容 Windows Terminal 承载窗口。spawn 本身不作为窗口打开的证据。未确认窗口或启动失败时提供真实提示和复制命令入口，不执行自动授权。

官方 CLI 登录说明：https://antigravity.google/docs/install?tab=cli 。Antigravity 继续无参数启动交互界面，不发起模型对话。

## 0.4.1 旧后端兼容

修复新版页面调用旧 Host 时出现 `Unknown hub action`。Client 直接调用 DSH 已有的 `remote.llm.listProviders/listConfigurableProviders`、`remote.settings.describe`、`remote.credentials.describe([ref])` 和 `remote.session.modelCatalog`，使用 Remote 的 `{ok,value}` 包装；不依赖新增的 Hub HTTP action。模型目录在一次刷新内共享，只读取一次。

Client 构建时内置 `native-config.mjs` 的共享读取逻辑，避免后端模块缓存与客户端版本不同步。保留旧非 Remote 预览的 HTTP 回退。密钥值不读取、不复制；此更改不影响内置设置的凭据写入。

## 0.4.0 统一内置模型设置

API 配置改为读取 DSH 原生的 `llm.listConfigurableProviders()`、脱敏 `settings.describe()` 和 `credentials.describe(ref)`，模型来自 `llm.listModels(provider)`。DeepSeek API 使用宿主的 `deepseek-official` 提供商，和其他 API 提供商一起归入「API 接口」；账号登录仍是独立的 `deepseek-account`，不与 API Key 混用。

删除 Client 自有的添加 API Key 侧栏；所有配置入口通过 `sidebar.settings` 已注册的共享 store 调用 `actions.openSection('models')`，打开同一个 DSH 设置 → 模型 页。密钥不读取、不复制、不返回 Client。配置状态不代表已执行付费对话。

监听 settings/document-updated、credentials/reference-updated、credentials/record-updated、llm/adapters-updated 和连接重置，合并短时间的刷新；窗口回到前台补读，可见页面每 15 秒兜底刷新。读取失败明确显示错误，不将旧网关账号状态充当原生配置状态。

旧网关的独立账号、凭据和候选顺序保留；没有自动迁移或删除。内置 API 通过 DSH 自己的提供商路由使用，本次未将内置 Key 复制到旧网关。宿主没有统一 API 余额接口时显示未知。

## 0.3.1 图标与账号页修复

原生图标在构建时以 data URI 内置到 Client，不再依赖桌面 dsh-app 协议对静态图片路径的转发。源图文件与来源清单继续随插件分发。DeepSeek、WorkBuddy 账号区改为账号信息条、额度主卡与模型管理入口，减少重复标题并支持窄屏堆叠。

## 0.3.0 平台工作台

「平台」页改为左侧平台图标导航、右侧单平台业务。包含 DeepSeek、WorkBuddy CN、Cursor、Codex、Antigravity 与 API 接口；DeepSeek 仅保留账号登录，DeepSeek API 与自定义 OpenAI 兼容提供商统一在「API 接口」。当前选择保存在浏览器本地，键盘支持方向键、Home、End 切换平台。

品牌图标以原始文件保存在 `assets/platforms/`，构建后内置客户端，不依赖静态路由或远程图片。DeepSeek、WorkBuddy、Cursor 和 Antigravity 图标来自官方网站，Codex 图标来自本机已安装的官方应用；来源与 SHA-256 见 `assets/platforms/sources.json`。API 接口使用通用接口图标。

未连接时显示相应登录或配置入口，已连接时展示账号、额度和模型管理。状态未知、登录失效和额度读取失败分别展示，不将未知余额伪造为零。模型目录延迟到打开该平台的模型页时读取。

DeepSeek 使用当前 Harness 的 startSignIn / cancelSignIn 授权能力，回调地址来自 Host 本机 HTTP 服务；WorkBuddy 继续使用已有 Web 登录。Cursor / Codex / Antigravity 的快捷登录由用户点击后打开可见交互窗口，不在后台代替用户完成授权。非 Windows 环境保留命令行登录方式。登录进程只接收固定参数，凭据仍归对应客户端管理。

新增 `login-actions.mjs` 与离线测试；没有自动执行真实登录或付费推理。数据与既有配置无需迁移。

## 0.2.0 独立模型管理页

AI HUB 已从办公室迁出，在 Harness 左侧直接注册「模型管理」入口与对应 main 主面板。总览、平台、账号、路由、用量、网关及可选模型设置均由本插件自己的 Client 提供，不依赖办公室插件或其 API。办公室只保留房间和角色功能。

后端接口、凭据、模型筛选与配置存储保持原样，无需迁移数据。同步更新两个插件后重新加载或重启 Harness；不再从办公室顶部寻找 AI HUB。`node --test client.test.mjs` 检查独立入口与主面板注册契约。

## 0.1.4 WorkBuddy 积分倍率

读取 WorkBuddy 模型目录的 `credits`（字符串或数字），在原生模型选择器中通过模型 `badge` 显示 `积分 ×N`，保持模型 ID、名称与路由不变。零倍率正常显示，缺失或无法识别的值不生成标签；不推算倍率，也不把每千 token 的价格当成倍率。刷新模型目录后采用上游新值。

该标签使用 Harness 已有模型 badge 能力，模型列表和已选模型处均由原生选择器渲染。本轮不修改 Harness 安装文件，不读取真实登录凭据，也不进行付费推理。需要重新加载插件或重启 Harness 后查看。

## 0.1.3 同模型强度变体合并

Cursor / Antigravity 的 Low、Medium、High 等型号按系列合并为一个原生模型选项，强度由 reasoning 菜单选择；实际请求会映射到目录中的对应型号。名称不额外拼接强度，避免宿主再次显示强度时重复。普通、fast、thinking 以及不同渠道保持独立。

旧会话的精确型号 ID 和原筛选配置保留；设置目录返回合并后的 ID 投影，界面勾选与原生选择器同步。更新需要重新加载插件或重启 Harness。本轮不主动重启正在使用的应用。

## 0.1.2 模型选择器修复

- 目录解析支持 JSON、ANSI、命名空间 ID 与新的模型家族；过滤 CLI 的提示行，不把提示误认为模型。
- 模型读取失败返回明确错误，刷新失败保留上次结果，不生成未经目录验证的占位模型。
- 失效的筛选不会把原生选择器清空；Cursor 回退到当前目录中存在的常用模型，其他渠道回退完整目录，界面提示重新选择。
- Cursor 默认保持最多八个常用模型；设置中可自行勾选、恢复常用或显式全部显示，完整目录不等于默认可选列表。
- Codex 转接重映射 provider，保留上下文及思考强度；已有同名原生 provider 时保留其所有权。Codex CLI 支持桌面版本目录探测及模型目录分页。
- Cursor 普通与 fast 版分别建立思考强度组选项；WorkBuddy 保留上游目录返回的能力字段。
- 保存 Hub 管理的渠道筛选后，通过官方注册句柄通知原生模型选择器刷新。原生已有同名 provider 的可见性仍由原 provider 管理，Hub 不覆盖其他插件。
- AI Park「设置 → 可选模型」按渠道折叠；Cursor 先显示已选模型，其他模型继续折叠；提供搜索和按需显示更多。

新增离线回归：`node --test catalog.test.mjs`。模型目录读取不证明模型可调用；本轮不进行真实推理、充值或自动恢复插件配置。

整合 Cursor、Antigravity、Codex、WorkBuddy CN 的模型、子代理、额度与设置服务；另提供 DeepSeek / OpenAI 兼容 API 账号管理和本地网关。使用 Node 内置模块；Client 使用 Host 提供的 React，不安装额外 npm 依赖。

## 本次修复（2026-11-08）

本机 Harness 0.2.2-rc.1 的启动日志确认：旧版本将 `ai-hub/gateway-key` 写进凭据文件的 `refs`，重启时凭据服务拒绝加载，导致整个应用启动失败。新增账号的旧名称 `ai-hub/account/<id>/api-key` 也有同样问题。

Harness 的两个凭据命名空间不同：

| API | 名称规则 | 本插件用途 |
| --- | --- | --- |
| `resolve / set / unset` | `^[A-Za-z_][A-Za-z0-9_]*$` | 网关 Key 与用户添加的 API Key |
| `readRecord / modifyRecord` | 两段小写字母、数字、连字符，以 `/` 分隔 | WorkBuddy 授权记录 `ai-hub/workbuddy-cn` |

0.1.1 在写入前验证引用名称。网关固定使用 `AI_HUB_GATEWAY_KEY`，复用本机启动修复中已改名的条目，不重新生成密钥。API 账号引用为 `AI_HUB_ACCOUNT_<账号 ID 的 UTF-8 大写十六进制>_API_KEY`，编码保留 ID 区别。WorkBuddy 的记录键保持原格式。

其他改进：

- 账号、排序、模型筛选和网关开关串行保存，保存成功后再更新生效状态；添加账号保存失败时清理临时密钥，删除保存失败时保留账号与密钥。
- 删除账号时若配置已保存但密钥清理失败，会明确报错。配置与凭据是两个独立服务，不能声称跨服务原子事务。
- 自定义平台目前只有一个 Base URL，多个账号必须使用同一地址，避免新增账号静默改变已有账号的请求目标；地址不接受内嵌用户名、密码、查询参数或片段。
- 模型目录请求合并、缓存最长十分钟；变更账号时使模型及余额缓存失效；读取不到首个账号密钥时继续尝试其他账号。
- 网关密钥每次操作重新读取，外部修改或轮换后下次请求即可生效。
- 网关上游请求默认两分钟超时，覆盖响应头和响应体；客户端断开和插件卸载会取消转发。流式转发使用带背压的 pipeline。
- 仅在尚未发送响应时尝试其他账号。流式响应已经开始后发生错误会终止连接，不拼接两个账号的回答。
- 无效请求返回 400，上游非法 JSON 返回 502，超时返回 504；上游 400 等请求错误不盲目切换账号重试。错误响应不回显上游原始错误正文。
- 修复自测对本机 CLI 安装的依赖，以及测试对旧版上下文截断策略和已移除 UI 插槽的断言。

## 文件与入口

| 文件 | 职责 |
| --- | --- |
| `index.js` | Host 服务、模型 adapter、子代理、管理工具、HTTP 入口 |
| `p0.mjs` | API 账号、模型目录、DeepSeek 余额、本地 OpenAI 兼容网关 |
| `workbuddy.mjs` | WorkBuddy CN 凭据获取/刷新、登录流程、模型、积分和聊天 |
| `runtime.mjs` | CLI 探测、无 shell 子进程、事件解析、Codex app-server 只读查询 |
| `cn-client.mjs` | 未注入 WorkBuddy 客户端时的最小 CN API 回退与积分解析 |
| `client.js` | 左侧「模型管理」入口、独立主面板、账号/渠道/模型/网关设置及本地化资源 |
| `locale/`、`icon.svg` | 本地化字典与图标 |
| `selftest.mjs` | 原有 Host/CLI 契约测试，使用替身上下文及本机 Node 子进程 |
| `p0.test.mjs` | 账号、凭据、缓存、网关和流式错误回归测试 |
| `validate.mjs` | 分发清单、patch 子集、字典、主题 token、模块依赖及语法检查 |

办公室界面由 `dsh-ai-park` 插件负责；模型管理界面由本插件独立注册，两者可以分别打开。

### Host 服务

`aiHub` 提供 `status / quota / settings / updateSettings / catalog / test / projects / snapshot`。CLI 是否存在、是否能读取目录和模型请求是否成功是不同状态；模型测试会真实消耗额度，不在插件激活时自动执行。

`aiHubP0` 提供 `providers / accounts / models / gateway / setGatewayEnabled / rotateGatewayKey / visibleModels / setVisibleModels / reorderAccounts / testProvider / quota / usage`。增删 API 账号通过 HTTP 分发的 `p0AddAccount / p0DeleteAccount` 完成。`p0Test` 仅检查模型目录接口，不证明聊天模型调用成功。

HTTP 管理入口：`POST /plugins/dsh-ai-hub/api`，JSON body，要求 `x-dsh-ai-hub: 1`，限制 loopback 和同源请求；与 Agent 工具 `hub_manage` 共用 Host 分发。工具公开的 action 集合小于 HTTP 集合，不暴露密钥轮换等 P0 管理操作。

网关入口：`/plugins/dsh-ai-hub/gateway/v1/models` 和 `/plugins/dsh-ai-hub/gateway/v1/chat/completions`，使用自己的 Bearer Key。模型名称是 `deepseek/<model>` 或 `custom/<model>`，未带平台前缀时默认为 DeepSeek；支持 JSON 与流式响应。自定义平台没有统一余额 API，不虚构余额。

Cursor / Antigravity 模型 adapter 仅支持文本，不转交 DSH 工具 schema；工具任务使用子代理。CLI 文本输入预算默认 24,000 字符，过长时保留系统摘录和最近消息并插入省略标记。CLI 子代理执行它们各自的工具循环。

WorkBuddy 当前源码会读取 DSH 授权记录，并可能发现本地 vault / 桌面授权文件或刷新 token，也实现了 Web 登录流程；这与早期版本“完全不读取凭据、未实现鉴权”的说明不同。本次未改动这些行为，也未进行真实登录或凭据读取验证。

## 验证

在插件目录中执行：

```powershell
node validate.mjs
node selftest.mjs
node --test p0.test.mjs
```

这三项检查不调用付费模型、不登录第三方、不读取真实凭据。P0 测试使用内存凭据与回环 HTTP 服务。静态检查和原有自测在 `evidence/` 写入脱敏结果；测试临时目录在 `scratch/` 内创建并清理。

`node build.mjs` 在修改 locale 或平台源图后重建 Client 字典与内置图标。`node verify.mjs all` 会调用真实平台并可能消耗额度，不属于默认自测；不得把历史真实调用结果当成当前连通性证明。

通过本地检查只证明这些契约与回归场景，不证明 Harness 已激活插件、第三方鉴权成功、真实模型与子代理可用，也不证明桌面 UI 渲染和交互已验收。

## 更新与回退

更新前备份原插件文件。若安装的是目录 link，替换源码后在 Harness 通过插件管理流程启用并重启；不要直接覆盖整个 profile 或自动恢复其他第三方插件。已有冲突的同名 provider 需按原安装方案处理。

本次不自动启用插件、不改 profile、不修改真实账号与凭据、不执行充值或模型测活。已发生启动崩溃的旧凭据文件需要先备份并离线修复非法 refs；插件未启动前无法自行修复凭据服务。旧 API 账号的非法名称不再被读取，需在备份后按新名称迁移或重新添加。本机先前修复过的网关名称已兼容。

回退源码到 0.1.0 也会恢复非法引用写入的缺陷；回退前应禁用插件并保留已修正的凭据备份。
