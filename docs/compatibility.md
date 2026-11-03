# Compatibility and acceptance / 兼容与验收

Evidence date: 2026-11-03.

The unreleased 0.1.1 source passes isolated fault-injection and browser recovery tests. Its new Desktop-owned manager-service adapter was also checked against Desktop 26.1027.3384.0 using native thread/list, same-thread read, and pending-approval snapshot reads. Sending messages and responding to live approvals remain separate phone acceptance checks.

0.1.1 源码已做隔离故障注入与浏览器恢复验证，并通过桌面版 26.1027.3384.0 的新会话服务实机只读检查：原生会话列表、同一会话读取、待审批快照。手机发送消息和实际审批分别验收；发行 APK 版本见 Releases。

| Component / check                                | Status / 状态                                   | Evidence / 范围                                                                                             |
| ------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Windows 11 x64 + Node 24.16.0                    | Tested / 已实测                                 | Build, isolated gateway/Agent tests, native read-only check                                                 |
| Official Desktop 26.1023.6123.0                  | 0.1.0 read-only tested / 旧版只读已实测         | 0.1.1 remains isolated-only; do not infer live acceptance                                                   |
| Official Desktop 26.1027.3384.0                  | 0.1.1 native read-only tested / 原生只读已实测  | Desktop-owned service discovery, thread/list, same-thread read and pending approvals; no new manager or CLI |
| Other Desktop versions                           | Not tested / 尚未实测                           | Capability probe required; no compatibility claim                                                           |
| Upstream v0.1.101                                | Tested / 已实测                                 | Verified archive hashes, bundled library/static UI, isolated full Agent integration                         |
| Native send/resume + approval adapter            | Simulated / 模拟已验证                          | Same thread ID, resume-before-send, approval notification/reply mapping                                     |
| Public APK API 26 / target 35                    | 0.1.1 build/signing verified / 构建签名已验证   | aapt2/javac/d8/zipalign/apksigner; API 26 is an install minimum                                             |
| Recovery/rollback/control/stream lifecycle       | Isolated tested / 隔离已验证                    | No native/phone/real cloud actions; details in CHANGELOG and test files                                     |
| New public APK on Huawei Mate 70 HarmonyOS 4.x   | Not tested / 尚未实测                           | Earlier personal prototype worked; that is not acceptance of this APK                                       |
| Cloudflare template                              | Isolated workerd tested / 隔离运行时已验证      | KV registration, authenticated WSS upgrade forwarding; no live account involved                             |
| New managed provider on a real account           | Not tested / 尚未实测                           | Per-user deployment/phone reachability required                                                             |
| Provided HTTPS                                   | Contract + isolated auth tests / 接口与隔离验证 | Live server/domain acceptance depends on user deployment                                                    |
| Other Windows versions, macOS/Linux desktop, iOS | Not supported/tested / 不支持或未实测           | Outside v1 scope                                                                                            |

## Required acceptance for an installation / 每套安装的验收

- [ ] `doctor --json`: native thread/list, relay identity, anonymous HTTP and WSS rejected.
- [ ] Existing native thread continued on phone; same ID/reply visible on Desktop.
- [ ] APK closed/reopened without password; last conversation restored.
- [ ] Innocuous permission request approved on phone and reflected on Desktop.
- [ ] Mobile-data access to the user's fixed endpoint.
- [ ] Own test tunnel rotated; fixed origin and saved authorization recover.
- [ ] Dedicated Start-menu entry launches/reuses the correct official instance, including after Store update.
- [ ] Own phone authorization revoked; old HTTP/WSS rejected and active WS closed.

Default `npm test` uses temporary config and mocks. `npm run test:native -- --allow-desktop-read` is an explicit read-only desktop check, never a restart. Live phone/tunnel checks require the user's participation and are never silently run against another installation. Failed internal capability checks require a maintained compatibility fix, not arbitrary agent source edits.

默认测试只用临时状态与模拟服务，原生测试需显式选择且不重启应用。手机／中转实测需用户配合，不能对其他安装悄悄操作。内部接口不兼容由项目维护修复，不能交给每位用户的 agent 临时改核心源码。
