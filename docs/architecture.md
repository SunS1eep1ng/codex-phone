# Architecture, privacy and migration / 架构、隐私与迁移

## Ownership boundaries / 组件职责

- `src/native.mjs` discovers the already installed official Windows Desktop renderer via loopback CDP, probes manager methods, and validates a real native request. It does not copy credentials, extract application code into the release, or start Codex CLI.
- `src/renderer-bootstrap.ts` is an attributed MIT source adaptation. It finds a live local manager, resumes the same thread before sending, reads canonical history, and forwards notifications/approvals. Each process uses its own namespace; disposing it does not remove another companion's listeners.
- `src/agent.mjs` speaks upstream Agent v1 over a separate secret-protected local endpoint. It reconnects, limits concurrent work, coalesces recent duplicate requests and chunks large responses. Deduplication is process-local/recent, not an exactly-once guarantee after a PC/process crash; do not automatically replay a failed turn/start with a new request ID.
- `src/gateway.mjs` owns the actual listening HTTP server and upgrade authorization. Upstream receives already-authorized business traffic; its Agent endpoint is not exposed there. Control/Agent use a separate loopback port. No global HTTP prototype hooks or compiled bundle rewrites are used.
- `src/windows.mjs`, `service.mjs`, `cli.mjs` manage discovery, port ownership, dedicated shortcuts, process lease, component recovery and diagnostics. Desktop is never force-closed. The foreground service supervises its components; it does not install a Windows service or task that restarts the supervisor itself.
- `src/relay.mjs` implements Cloudflare and externally provided HTTPS. Per-user cloud identifiers/secrets stay in private state.
- `android/` contains the generic Java WebView client, separate public/dev IDs, blank default origin, HTTPS-only navigation and Keystore credential handling.

职责边界：原生模块只接官方桌面；渲染器源码适配器继续同一会话并转发审批；Agent 实现协议、分块和有限重复请求合并；网关统一处理监听与授权；Windows 模块管理启动和组件恢复；中转模块使用每位用户的配置；APK 不含维护者入口。重复请求保护不跨电脑／进程崩溃提供严格 exactly-once，发送失败不能盲目以新 ID 重放。

## State / 私有状态

Default `%LOCALAPPDATA%\codex-phone`, overridable with `CODEX_PHONE_STATE`/`--state`. Restrictive ACL permits current user and SYSTEM on Windows. Identity, secrets, phone credential/session hashes, generated Wrangler config, ports, process lease and logs live here. Upstream's `CODEX_HOME` is redirected into its own private subdirectory, so it does not use/mutate the user's official Codex configuration. Runtime writes are atomic and auth writes are serialized.

默认私有目录包含身份、密钥、手机授权哈希、Wrangler 配置、端口、运行租约与日志，Windows ACL 限制当前用户和 SYSTEM。上游的 CODEX_HOME 指向该安装自己的子目录，不使用官方 Codex 配置。配置原子写入，认证状态串行保存。

Public files are selected by a checked-in manifest. Runtime configs, logs, pairing pages, keys, signed APKs, caches and extracted official JavaScript are not tracked. Release assets are separately inspected. No existing prototype installation is used as a source tree to upload wholesale.

公开文件由白名单选择。私有配置、日志、配对页、签名密钥、缓存和官方提取代码不跟踪；签名 APK 单独检查后作为 release 附件发布，不把现有安装目录整体上传。

## Trust / 信任范围

The phone has the user's native coding-agent authority, including tools and local file access allowed by Desktop. Local administrator malware or an attacker controlling your desktop account is outside the phone gateway's protection. HTTPS protects transport to/from the relay, but the relay terminates TLS and can see or modify requests. This release does not implement application-level end-to-end encryption. Device identity detects accidental/wrong routing; it is not remote attestation.

手机获得桌面编码代理的操作能力，包括桌面允许的文件和工具。网关不抵御已经控制桌面账户的恶意程序。HTTPS 保护传输，中转终止 TLS 并能观察／修改流量；首版不提供应用层端到端加密。设备 ID 防止错误路由，不是远程证明。

The public info endpoint exposes the installation's device ID and display name. No analytics are added by this project. Reused upstream UI can contain links/assets/integrations from upstream; unsupported API surfaces are blocked, but this is not a claim of a comprehensive third-party code audit. Inspect dependencies and your relay provider before granting access to sensitive work.

公开 info 接口含设备 ID 和显示名称。本项目不新增统计遥测；复用界面可能含上游链接／资源／集成，未支持的 API 已限制，但这不代表对全部第三方代码完成了全面审计。

## Recovery and installation generations / 恢复与安装代

The authenticated `/phone-api/recovery` probe exposes a stable service/native epoch and unresolved operation metadata. Full recovery obtains the native thread and approval snapshot before refreshing the existing UI. A document identifier associates an event-stream gap with its page; a new page does not inherit a late close from an older document. Drafts and selected attachments defer refresh. The identifier is not authentication. Multiple tabs share the origin cookie, so explicit multi-tab stream association remains outside the first single-WebView scope.

The journal stores only operation IDs, methods, thread/turn IDs, input hashes and outcome states. Interrupted pending writes become uncertain after restart. Neither reconnect nor the supervisor replays them. A user can acknowledge an uncertain record only after checking the conversation; acknowledging is not executing or declaring the native task completed.

Admin control protocol v2 signs both requests and responses with nonce-bound HMAC. The raw admin secret is not placed in request headers. A valid port/JSON response is insufficient to identify the service. Existing v0.1.0 upgrades stop the old service with its retained old CLI before switching; do not overwrite its dependencies or CLI first.

Installers prepare immutable code generations under private `install/generations`, then switch a validated active pointer. Interrupted activation chooses the previous verified generation; failed activation restores it. The bootstrap checkout hosts the stable launcher/management entry and must remain available. Uninstall removes pointers immediately and schedules bounded cleanup of marker-verified generations after its parent exits; it never removes arbitrary source directories.

The dedicated launcher enables an external supervisor for the companion. It recovers a dead companion with bounded retry delays and does not force-close native Desktop. Explicit stop/uninstall inhibits recovery. Quick Tunnels remain a testing-oriented provider without an uptime guarantee or SSE support; recovery uses WSS plus authoritative snapshots. No new cloud provider or iOS client is included in this patch.

恢复探测区分原生读取、Agent 握手与页面事件断档，真正恢复时再取历史／审批快照。草稿和附件会延迟刷新。操作日志不存 prompt，未知结果由用户核对，不能自动重发。管理接口使用双向 HMAC；升级保留旧代，候选通过准备再切换；卸载的代目录清理由退出后助手验证归属后有界执行。独立守护只恢复本项目后台，主动停止会抑制恢复，不强制关闭原生桌面。

## Migration / 迁移

Source and APK are reusable. Private identity, phone authorizations and cloud resources belong to an installation. On a new PC: install/sign in to official Desktop, move its conversations/projects through an appropriate separate process, deploy codex-phone with a new state directory, configure your own relay, and re-pair the phone. Do not copy another person's state or signer. Keep your release signing key backed up separately if you maintain the APK, because Android updates require the same signer.

代码和 APK 可复用，私有身份、手机授权和云资源属于具体安装。换电脑需安装登录官方应用、另行迁移会话／项目、重新部署中转与配对；不要复制他人的状态或签名。维护 APK 时要另行备份项目签名密钥，Android 原位升级需要同一签名者。
