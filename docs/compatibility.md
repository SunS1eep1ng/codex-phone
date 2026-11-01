# Compatibility and acceptance / 兼容与验收

Evidence date: 2026-11-01. Scope is explicit; a prototype result does not validate this new implementation.

| Component / check | Status / 状态 | Evidence / 范围 |
|---|---|---|
| Windows 11 x64 + Node 24.16.0 | Tested / 已实测 | Build, isolated gateway/Agent tests, native read-only check |
| Official Desktop 26.1023.6123.0 | Read-only tested / 只读已实测 | New adapter discovers live manager, real thread/list and canonical thread/read |
| Other Desktop versions | Not tested / 尚未实测 | Capability probe required; no compatibility claim |
| Upstream v0.1.101 | Tested / 已实测 | Verified archive hashes, bundled library/static UI, isolated full Agent integration |
| Native send/resume + approval adapter | Simulated / 模拟已验证 | Same thread ID, resume-before-send, approval notification/reply mapping |
| Public APK API 26 / target 35 | Build verified / 构建已验证 | aapt2/javac/d8/zipalign; API 26 is an install minimum |
| New public APK on Huawei Mate 70 HarmonyOS 4.x | Not tested / 尚未实测 | Earlier personal prototype worked; that is not acceptance of this APK |
| Cloudflare template | Isolated workerd tested / 隔离运行时已验证 | KV registration, authenticated WSS upgrade forwarding; no live account involved |
| New managed provider on a real account | Not tested / 尚未实测 | Per-user deployment/phone reachability required |
| Provided HTTPS | Contract + isolated auth tests / 接口与隔离验证 | Live server/domain acceptance depends on user deployment |
| Other Windows versions, macOS/Linux desktop, iOS | Not supported/tested / 不支持或未实测 | Outside v1 scope |

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
