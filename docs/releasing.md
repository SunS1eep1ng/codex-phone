# Release procedure / 发布流程

1. Use a clean checkout. `npm ci`, `npm run build`, `npm test`, `npm run audit:publish`. Default checks never use live state.
2. Verify source/asset hashes in upstream.lock.json, upstream MIT notice, dependency lock and selected public-file manifest. Never commit official extracted code, credentials, logs or account-specific cloud configuration.
3. Build unsigned APK in CI and locally. Locally sign using `android/README.md` and a separate project key outside Git/CI. Verify signature, package name, blank gateway and SHA-256. Inspect release archives separately from Git source.
4. Run explicit native acceptance and record exact tested versions in compatibility.md. Label phone/provider cases not actually exercised. Never carry prototype evidence into a new version as if re-tested.
5. Commit only whitelisted files. Create/push the intended public repository after the privacy/license checks. CI needs no cloud credentials and publishes no signed release automatically.
6. Create tag/release `v<VERSION>` as a **prerelease**, attach signed `codex-phone-v<VERSION>.apk`, SHA-256 and a source/distribution archive if provided. Describe actual validation and untested boundaries. Signing keys/passwords remain local.

Use GitHub's public repository and release settings intentionally. If adding paid resources, new account authorizations or destructive cloud deletion, get explicit user action first. An automated approval rejection must be reported accurately rather than bypassed.

发布前完成白名单、来源、许可证、隐私和产物检查。CI 无云凭证、只构建未签名 APK；维护者在本地独立签名。逐项记录真实验证范围，未实测项明确标记。预发行候选使用 prerelease 标志，附件仅含通用签名 APK／校验与检查后的分发包，不含私钥或私人配置。费用、新账号授权与云删除需另行明确操作。
