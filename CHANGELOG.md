# Changelog

## 0.1.1 — local recovery candidate / 本地恢复修复候选

- Preserve shared native connections after ordinary RPC rejections; fence old renderer generations and cancel in-progress connections on stop.
- Bound Agent queue/response memory, serialize chunks with send callbacks, and expose authenticated reconnect/resync state. Unknown write outcomes are never automatically replayed.
- Persist minimal write-operation metadata before dispatch; mark interrupted/unknown outcomes for conversation reconciliation without saving prompts.
- Recover phone views from authoritative native history/approvals after foreground/network/stream or native-epoch changes. Preserve unsent drafts/attachments and the selected conversation.
- Fence stale Android pairing, renewal and WebView callbacks so they cannot replace a newer connection or pairing screen.
- Close active HTTP event streams and WebSockets after revocation/expiry. Reject malformed Upgrade requests without terminating the service.
- Authenticate local control requests and responses with nonce-bound HMAC; never send the raw administrator secret to a potentially reused port.
- Use a single abortable tunnel recovery monitor. Add an opt-in external companion supervisor; explicit stop/uninstall inhibits restart.
- Prepare candidate dependencies/build/tests before switching installations; roll back failed activation and preserve the previous code, phone state and credentials. Stable management/Start-menu entries follow the verified active generation.
- Canonicalize private paths, serialize first setup, retry bounded Windows sharing conflicts, and make parser errors honor JSON mode.
- Replace the upstream service worker as readable project code; never cache auth/business HTML or error JSON. Compose the recovery script into HTML at build time without modifying upstream compiled JavaScript.
- Prevent bundled CLI help/status from invoking the build-time upstream preparer.

修复普通错误误断连接、停止／重连竞态、发送背压、流式授权撤销、端口身份验证、升级回退、路径／并发初始化及 CLI JSON 契约。手机恢复只读取权威历史与审批，保护草稿，不重发结果不确定的操作。iOS 和新的中转架构本次不实现。

This candidate is verified with isolated tests; true Desktop/phone/relay acceptance is separate. It has not been deployed over an existing personal installation merely by building it.

## 0.1.0 — 2026-11-01

Initial MIT Windows/Android prerelease, pinned upstream UI/server, native Node Agent, pairing gateway, relay providers and bilingual deployment guides.
