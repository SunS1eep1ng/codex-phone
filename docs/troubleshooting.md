# Troubleshooting

Run `node dist/cli.mjs status --json`, then `doctor --json`. Inspect private `service.log` only locally. Do not post raw logs, pairing pages/configuration, tokens, project paths or conversation contents.

| Symptom/code | Meaning and action |
|---|---|
| `service_not_running` / `service_start_failed` | Run start. Inspect private service.log. Check Node version, completed build, directory ACL and saved ports. |
| `desktop_normal_exit_required` | Official Desktop is running without loopback CDP. Exit normally including tray; service waits and relaunches it. |
| `desktop_not_installed` | Install and sign in to the official Windows app. Do not substitute Codex CLI. |
| `desktop_port_owner_invalid` | Port owner is not an official loopback-only Desktop process. Never kill it; inspect configuration and actual running app versions. |
| `UNSUPPORTED_DESKTOP_*` / manager/history error | Internal interface changed or no compatible local manager. Report app version and sanitized error. Maintainers own compatibility changes; do not patch installed application code. |
| Native handshake passes but doctor fails | A handshake/Agent socket is insufficient. Confirm `thread/list`, login and canonical history. |
| `relay_not_configured` | Set a provided HTTPS origin or deploy the Cloudflare provider. |
| `relay_unavailable` | Check endpoint identity, TLS/DNS, tunnel log, Worker registration and anonymous HTTP/WSS rejection separately. |
| `authentication_boundary_failed` | Reverse proxy exposed something other than the authenticated gateway. Fix routing; do not bypass the check. |
| `service_already_starting` | Another process owns the service lease. Wait and inspect status. Do not delete a live lease. A lease from a dead PID is recovered on next start. |
| `pairing_expired` / `pairing_locked` | Generate a fresh code with pair. Codes last 10 min; 20 wrong attempts lock that code. |
| `wrong_computer` | Endpoint device identity differs from pairing/saved identity. Correct the endpoint; do not ignore the mismatch. |
| `phone_not_authorized` | Expired/revoked phone credential or invalid session. App renews sessions from its Keystore credential; if revoked/expired, pair again. |
| Old conversation shows no history | Verify canonical history with opt-in native acceptance; use the full native history path, not renderer cache alone. |
| Phone works on Wi-Fi only | Test fixed HTTPS endpoint over mobile data. Check the user's network, not only the PC's loopback server. |
| Worker health works but UI fails | Health proves Worker reachability only. Check registration and `/phone-api/info`, then doctor and phone pairing. |
| Multiple app versions after Store update | Reuse an official running instance even if a newer package is registered; upgrade on the next normal exit. |
| WebView errors on an old Android | Update the system WebView. No Google services are required, but a modern browser engine is. |

Cloudflare recovery: the service restarts its owned cloudflared child and registers a new origin at the fixed Worker. KV changes may take roughly a minute to propagate. A worker cannot wake a sleeping/offline PC; keep the computer awake and the companion running. The current process supervises components, not its own crash or Windows logon. Reopen Codex Phone after stopping/crashing the companion.

Account authorization: use a fresh Wrangler login if a callback listener is gone. Missing `workers_scripts:write` is a Cloudflare authorization issue, not native Desktop failure. Never paste account tokens into a command body or public report. Check free-tier limits and provider availability before claiming zero-cost operation at arbitrary scale.

Windows implementation lessons: empty logs are valid; live log readers must allow sharing; owned child processes must retain exit status; duplicated starts must reuse authenticated control state. Do not restore the prototype's global HTTP hook, compiled-string patches, default Tauri Agent config, or private proxy/ports as a workaround.

For an issue, include OS, Node version, Desktop package version, relay type, error code and which acceptance step failed. Remove addresses, IDs, user names and content. [Security reports](../SECURITY.md) must not contain live credentials.
