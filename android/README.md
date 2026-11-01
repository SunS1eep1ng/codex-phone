# Android build and signing / Android 构建签名

Users download a signed APK from GitHub Releases. No Google services or Android SDK are required on the phone. Min API 26, target 35, modern system WebView required. Package `io.github.suns1eep1ng.codexphone`; dev `.dev`; pairing schemes `codexphone-public` and `codexphone-public-dev`. The default gateway is blank. Neither can overwrite the earlier personal prototype package.

用户直接下载 release 的签名 APK，无需 Google 服务或构建工具。最低 API 26、target 35，需现代系统 WebView。公开版和开发版独立包名／配对 scheme，入口留空，不覆盖早期私人原型。

Build prerequisites: JDK 17+, Android SDK platform android-35, build-tools 35.0.0. Set `JAVA_HOME` and `ANDROID_SDK_ROOT` (`ANDROID_HOME` accepted). Tools/platform paths can be provided explicitly for a nonstandard SDK layout.

```powershell
npm run build:android
# Or:
node scripts/android-build.mjs --jdk JDK_DIRECTORY --tools BUILD_TOOLS_DIRECTORY --platform PATH_TO_ANDROID_JAR
# Separate ID, still unsigned:
npm run build:android -- --debug
```

The script runs aapt2, javac, d8, jar and zipalign, producing `release/codex-phone-v<VERSION>-unsigned.apk`. It does not fetch private configuration or sign automatically. Android SDK/JDK licenses must be accepted by the builder; they are not bundled. CI installs the declared platform/build-tools and uploads only the unsigned APK.

构建使用 aapt2、javac、d8、jar 与 zipalign，不读取用户连接配置、不自动签名。构建者自行接受 Android SDK／JDK 许可；CI 仅输出未签名产物。

Maintainer signing (local only):

```powershell
# Choose a private folder OUTSIDE the checkout; back it up securely.
$env:CODEX_PHONE_SIGNING_DIR = 'YOUR_PRIVATE_SIGNING_DIRECTORY'
# For nonstandard SDK layout, optionally set CODEX_PHONE_ANDROID_TOOLS.
node scripts/sign-apk.mjs
```

First run creates a new project RSA-3072 PKCS12 key and random password file, restricts its directory ACL, signs and verifies the aligned APK, then writes its SHA-256 file. Subsequent releases must keep the same project signer. Do not use someone else's key, an old personal-app key, CI secrets or a checked-in key. The password is read from a file, not included in command text. Keep both key and password backed up outside the repository. `--debug` signs the separate dev APK.

首次签名创建独立项目 RSA-3072 密钥和随机密码文件并限制目录权限，再签名、验证和输出 SHA-256。后续更新保留相同签名者，不复用私用原型密钥，不上传 Git／CI。密码通过文件传递，另行安全备份密钥与密码。

Verify on a phone: install public/dev app alongside the prototype, enter a separately deployed test gateway/code, continue one native thread, approve an innocuous tool action, close/reopen without a password, and check mobile-data access/tunnel rotation. Build success alone does not validate WebView layout or device behavior.

Project release signing certificate SHA-256: `5a1f35de0a59784a74d9cc281605c57904858f865427ecf76dbf17809030f3e5`. This is the public certificate fingerprint, not the private key.

实机验收须安装公开／开发版到独立测试入口，检查原生续接、无害审批、重开免密、移动网络及换址恢复。编译成功不能证明布局或设备运行效果。
