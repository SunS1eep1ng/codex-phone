# AI agent deployment runbook

Read `AGENTS.md`, then this file. Work with the user's actual environment, not a maintainer installation. All commands run from the checkout root. Do not ask users to edit source code for ordinary configuration.

## 1. Preflight

1. Check Windows x64, `node --version` (>=24.16.0), Git and a signed-in official Codex Desktop installation. Do not read or copy OpenAI auth files.
2. Inspect an existing codex-phone state/`status` before installing again. Preserve it for upgrades. A separate test deployment must use `--state` or `CODEX_PHONE_STATE` and independent relay resources.
3. Ask only for facts that cannot be discovered: outside-network access, owned HTTPS/WSS endpoint versus Cloudflare, optional process-local proxy. Do not assume a proxy port or require a paid domain.
4. Read `docs/compatibility.md`. An untested version is not automatically supported; a failed capability probe is a compatibility issue, not a reason to patch Desktop.

## 2. Prepare locally

```powershell
npm ci
npm run build
npm test
node scripts/manage.mjs setup --json
```

`setup` generates a unique computer ID, separate local administrator/Agent secrets and restricted state directory. Repeating it preserves identity, authorized phones and customized settings. Shortcuts point to this checkout; keep it in a stable location. Node and project dependencies are required on the computer, not the phone. Do not run release signing tools for an ordinary installation.

## 3. Configure the user's relay

Cloudflare: prepare the deployment, then run `npx wrangler login` and let the human authorize in the browser. Use current Wrangler options/authorization, including script publishing and KV permissions. If the human's OAuth callback fails because its listener exited, start a fresh login and give a fresh link/code. Expired codes must not be reused.

Run `npx wrangler whoami` to discover account choices. If multiple accounts are present, ask the user which one. Never paste OAuth tokens into chat, logs or Git. Then:

```powershell
node scripts/manage.mjs relay cloudflare deploy --account USER_ACCOUNT_ID --json
```

The command generates a Worker name, creates a namespace unless one is explicitly provided, publishes the checked-in Worker template and sets a random registration secret. Runtime Wrangler configuration lives outside Git. Retrying the same command reuses saved resources. A new account/domain/payment is a human decision; default to free services without buying or upgrading anything.

Provided HTTPS: use `setup --endpoint https://USER_ORIGIN`; help the user configure their existing proxy according to `docs/relay.md`. Only the gateway port may be forwarded. Port numbers are discovered in private `config.json`; never publish that file. The control interface and Desktop CDP are local only. Proxy Host rewriting must not grant authorization.

An optional `setup --proxy http://USER_PROXY:PORT` affects project processes; do not alter system settings. On errors, test computer and phone separately. A phone reaching a Worker health route does not prove the computer can reach it.

## 4. Start and diagnose

```powershell
node scripts/manage.mjs start --json
node scripts/manage.mjs doctor --json
```

Use structured fields, not string matching localized shell output. Exit 0 = success, 2 = human action/unfinished readiness, 1 = failed operation. `status` describes service state; `doctor` must confirm native `thread/list`, endpoint identity and rejection of anonymous HTTP and WSS.

If Desktop was launched without loopback CDP, ask the human to exit it **normally**, including the tray icon. The service waits and opens it automatically. It never kills Desktop or a foreign port owner. Old live and new registered Store versions may coexist: reuse a verified official running instance even if its version differs from the installed package.

A failed native manager/module/history probe means unsupported Desktop internals. Record the version/error without conversation contents. Stop diagnosis at that boundary; do not silently substitute CLI sessions, independent APIs, credential extraction or source patches.

## 5. Human phone acceptance

1. Download the signed public APK from this repository's release; verify SHA-256. The APK has no preset gateway. API 26 is an installation minimum, not a promise about old WebView compatibility.
2. Run `pair --open`. This rotates only this installation's one-use pairing code. The page and JSON contain secrets; do not put them in issues or Git.
3. The user installs the APK and types the address/code, or pastes its `codexphone-public://pair` link.
4. Choose an existing native conversation, send a harmless test message, and verify the same native ID and reply on Desktop.
5. Close/reopen APK without a password; test mobile data; deliberately exercise a permission request with an innocuous operation and confirm the approval is reflected on Desktop.
6. For an isolated acceptance deployment, restart its own tunnel and verify that the fixed address and saved phone authorization recover. Never restart another deployment for this check.

Record each check as tested, failed or not tested. Do not infer phone runtime behavior from compilation, mock tests or a different prototype.

## 6. Recovery, upgrade and removal

Use `docs/troubleshooting.md`. Configuration changes require `stop`/`start`; after code updates run `scripts/Update.ps1`. Pair again only when authorization is expired/revoked or the identity changed, not for every tunnel rotation. `phones list/revoke` manages authorization.

Local `uninstall` removes owned project state/shortcuts, not official Desktop or cloud resources. Cloud deletion is separate and must target exact saved Worker/KV resources with explicit user authorization. On another computer, deploy and re-pair. Moving official conversations and project files is a separate user task.
