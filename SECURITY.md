# Security / 安全说明

Only the latest prerelease is maintained initially. The internal Desktop adapter is version-sensitive; see docs/compatibility.md. This project is not affiliated with OpenAI and has not received an independent security audit.

Security properties: all public business HTTP/WSS requires a phone session; Host rewriting never bypasses it; local control and Agent endpoints use independent secrets on loopback; pairing is one-use, time/attempt limited; revocation invalidates sessions and closes active WebSockets; no upstream standalone model/CLI fallback is exposed. Never expose the control/CDP ports or put private state/signing keys in Git.

A paired phone can operate the desktop user's agent, files and tools. Protect your phone and OS account. The HTTPS relay can inspect traffic; there is no application-level E2EE. Public device ID/name are expected metadata. Compromised local accounts, malicious installed Desktop code, and compromised user-operated relays are outside the gateway's trust boundary.

Please use GitHub's **Report a vulnerability** feature if enabled. If it is unavailable, open an issue containing only a request for a private reporting channel, without exploit details, credentials or personal data. Do not post live pairing codes, tokens, logs or configuration. Include affected commit/version, assumptions, expected/observed behavior, and a minimal synthetic reproduction privately.

首版暂只维护最新预发行版，尚未经过独立安全审计。公开业务 HTTP／WSS 必须有手机授权，Host 改写不能绕过；管理与 Agent 使用独立回环密钥；配对限制次数与时效，撤销关闭会话和实时连接。不要暴露 CDP／管理端口，也不要把状态与签名私钥提交。

手机可操作桌面用户的代理、工具和文件；中转能观察流量，未实现应用层端到端加密。报告漏洞优先使用 GitHub 私密报告；未开启时只公开请求私密渠道，不公开漏洞细节或真实凭证。提供版本、假设及使用模拟数据的最小复现。
