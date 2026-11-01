# Third-party notices

codex-phone is MIT © 2026 SunS1eep1ng. It reuses code and assets under their original licenses; authorship is not reassigned.

## codex-remote-bridge / codexui

- Repository: https://github.com/YusenDu/codex-remote-bridge
- Original: https://github.com/friuns2/codexui
- Baseline: v0.1.101; exact archive URLs/hashes: upstream.lock.json.
- Used: static web UI, exported Express server, Desktop Agent relay/protocol. The renderer bootstrap is adapted as readable source in src/renderer-bootstrap.ts; local-operation shapes follow local_ops.rs.
- New here: Node Agent/native manager discovery and canonical history, gateway auth/pairing/revocation, Windows lifecycle/CLI, relay providers, generic Android client/build tooling and documentation.

Upstream license:

```text
MIT License

Copyright (c) 2026 Pavel Voronin, Igor Levochkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Other dependencies

Node dependencies, including Express (MIT), ws (MIT), Commander (MIT), esbuild (MIT), highlight.js (BSD-3-Clause), Firebase (Apache-2.0), Wrangler (MIT/Apache-2.0), and their transitive dependencies retain their own notices. Pinned resolved versions/integrity values are in package-lock.json. The upstream web archive contains its original third-party assets. cloudflared is separately downloaded from Cloudflare's official release (Apache-2.0), checksum/version pinned in upstream.lock.json. Android SDK/JDK are build prerequisites, not redistributed by this source repository.

OpenAI Codex Desktop, its login data and extracted application JavaScript are not redistributed. Product names identify interoperability and do not imply endorsement.
