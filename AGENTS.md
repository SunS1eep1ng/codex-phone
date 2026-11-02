# codex-phone agent instructions

This is an unofficial, self-hosted Windows/Android companion for **existing native Codex Desktop conversations**. Read README.md and docs/agent-setup.md before installation; Chinese instructions are in README.zh-CN.md and docs/agent-setup.zh-CN.md.

## Installation requests

- Run setup/doctor before making changes. Use the CLI's JSON results; distinguish relay availability from a successful native `thread/list`.
- Keep runtime state outside this checkout. Generate credentials per installation; never reuse example IDs, a maintainer endpoint, or another user's secrets.
- Reuse the user's installed desktop app and logged-in account. Never copy OpenAI authentication files to a phone, relay, issue, or this repository. Never substitute a standalone Codex CLI conversation or another model provider.
- Account authorization, phone installation/pairing, and normal desktop exit are human actions. Prepare and test the concrete configuration first, then explain exactly what the user needs to do. Prefer Cloudflare device authorization; expired codes must be replaced, not retried indefinitely.
- Do not force-close Desktop, kill a foreign port owner, change system DNS/proxy, disable TLS checks, buy a domain, or upgrade a paid service. Optional process-local proxy configuration is supported.
- Unsupported Desktop internals require a compatibility diagnosis. Do not invent a private API or blindly patch the installed application/upstream bundles.
- Custom HTTPS endpoints must forward to our authenticated gateway and support WebSockets. Test unauthenticated rejection even when a reverse proxy rewrites Host to localhost.
- A repeated setup is an upgrade/repair of the same installation: preserve identities, authorized phones and customized settings. Uninstall removes only owned local resources and conditionally restores shortcuts; cloud deletion is a separate explicit action.

## Development requests

- Default tests use temporary state and mocks. Never point them at an existing deployment, rotate real pairing codes, revoke real phones, or stop real tunnels.
- Native/phone acceptance is opt-in and its tested versions must be recorded honestly. Source/build checks do not prove a phone installed or connected.
- Keep upstream provenance and MIT notices. Do not commit official Desktop binaries, extracted app code, runtime data, logs, signed APKs, signing keys, or generated cloud account configuration.
- Run `npm run build`, `npm test`, `npm run audit:publish` and the relevant Windows/Android checks. Use Conventional Commits, no Co-Authored-By trailer.
- For maintainer-requested changes to `SunS1eep1ng/codex-phone`, commit and push completed changes after the relevant checks pass. Release publication and live deployment are separate tasks.
- Preserve the working private deployment when developing or testing another instance. Use a separate state root, process identity and adapter namespace.
