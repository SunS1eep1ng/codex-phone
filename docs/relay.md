# Relay providers / 中转提供者

The phone needs a stable HTTPS origin with WSS support. A provider implements configuration, start, stop and health checks. Cloudflare is managed by the project; a provided HTTPS service is externally managed. Neither is allowed to replace gateway authentication.

手机需要固定 HTTPS 入口与 WSS。中转提供者负责配置、启动、停止和健康检查。Cloudflare 生命周期由项目管理；自有 HTTPS 服务由用户外部维护。两者均不能代替网关认证。

## Cloudflare

Source: `src/worker-template.mjs`. It expects:

| Binding / 配置 | Purpose / 用途 |
|---|---|
| `DESKTOP_ENDPOINTS` (KV) | Current HTTPS Quick Tunnel origin / 当前隧道地址 |
| `DEVICE_ID` (variable) | Installation-generated identity / 安装时生成的设备身份 |
| `REGISTRATION_SECRET` (secret) | Authenticates PC origin updates / 验证电脑地址更新 |

`relay cloudflare deploy --account ACCOUNT_ID [--name NAME] [--namespace KV_ID]` creates private Wrangler configuration and resources. The private account, IDs and secret do not belong in this template or repository. Use your own account; choose it explicitly if more than one exists. Wrangler login, script publishing and KV permissions are required. No domain purchase is required for a workers.dev address.

部署命令会创建私有 Wrangler 配置、Worker 与 KV。账号、资源 ID 和密钥不写入仓库模板。使用自己的账号，多账号需明确选择；需要 Wrangler 登录、脚本发布与 KV 权限。workers.dev 入口无需购买域名。

The managed provider downloads the checksum-pinned Windows x64 cloudflared binary. It starts an owned Quick Tunnel to the authenticated loopback gateway. Registration is sent only when the origin changes, avoiding continuous KV writes. It restarts its child after exit, reads live logs with Node's normal shared-file behavior, and retries registration after errors. KV propagation/cache can delay recovery by about a minute. The cloudflared process can use the optional process-local proxy; no system changes are made.

提供者下载并验证固定 cloudflared，创建只转发到认证网关的 Quick Tunnel。仅地址改变时写 KV，不持续消耗写入额度；子进程退出会恢复，注册失败会重试，活动日志通过允许共享的方式读取。KV 缓存／传播可能使恢复延迟约一分钟。代理只影响相关进程。

Worker routes:

| Route | Behavior |
|---|---|
| `GET /_bridge/health` | Worker reachability, **not** native readiness / 仅 Worker 可达性 |
| `POST /_bridge/register` | Bearer registration secret + exact device ID; HTTPS `*.trycloudflare.com` origins only |
| Other HTTP/WSS | Forward to saved origin, keep phone cookies, strip local-admin headers; gateway still authenticates |

The Worker is a TLS endpoint and can inspect traffic. Quick Tunnels are a convenience/free-tier example with provider limits, no SLA and no guarantee in every region. For sustained availability you may use your own managed HTTPS ingress instead. Cloud resources are not deleted by local uninstall. Inspect the saved Worker name/KV ID first; only delete those exact resources after explicit authorization. Do not delete an account's whole namespace inventory.

Worker 能看到 TLS 解密后的内容。Quick Tunnel 是受限额与地区可达性影响的免费示例，没有 SLA。长期可用性要求较高时可接入自有 HTTPS 服务。本地卸载不删除云资源；删除前核对私有配置里的精确 Worker／KV，另获授权，不批量清空账号资源。

## Provided HTTPS/WSS contract / 自有入口约束

Set `setup --endpoint https://your-origin.example`, then start the service to allocate/save ports. Forward **only** `config.ports.gateway`, never `config.ports.control` or `.desktop`. The reverse proxy must reach the computer; remote proxies require an independently maintained secure tunnel/private network. Do not expose unencrypted HTTP on the Internet.

先设置入口，启动后从私有配置读取已保存的网关端口。只转发 gateway，不能转发 control／desktop。远端代理到电脑的连通性由用户自行维护，例如独立安全隧道或专网；不要把明文 HTTP 暴露到互联网。

Example nginx on a machine that can securely reach the local gateway (replace placeholders):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
server {
    listen 443 ssl;
    server_name YOUR_DOMAIN;
    ssl_certificate YOUR_CERTIFICATE;
    ssl_certificate_key YOUR_PRIVATE_KEY;
    location / {
        proxy_pass http://127.0.0.1:YOUR_SAVED_GATEWAY_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 300s;
        proxy_buffering off;
        proxy_cache off;
    }
}
```

- Preserve `Cookie`, `Set-Cookie`, request bodies, query strings, error status and WebSocket frames. Do not cache business responses.
- Keep the origin root path; subpath mounting is not supported in v1. Use publicly valid TLS, do not disable certificate validation.
- `Host` can be rewritten; it cannot confer authorization. `Origin`, when present, must match the configured public origin.
- `relay check`/`doctor` check identity and **401** responses to anonymous HTTP and WSS. Also test revocation and mobile-data access during acceptance.

保留 Cookie、请求正文、查询串、错误状态与 WebSocket；不缓存业务响应。v1 只支持域名根路径，不支持挂载到子路径。必须使用有效 TLS，不关闭证书检查。Host 可改变但不能授予权限；有 Origin 时必须匹配配置的公开入口。doctor 检查身份和匿名 HTTP／WSS 的 401，另行实测撤销与移动网络。

## Mobile API / 手机接口

| Route | Contract |
|---|---|
| `GET /phone-api/info` | Public `deviceId`, `deviceName`; no readiness guarantee |
| `POST /phone-api/pair` | `{deviceId,code,name}` → one-use code consumed; `phoneId,credential,deviceId,deviceName,expiresAt` + Secure HttpOnly cookie |
| `POST /phone-api/session` | `{deviceId,phoneId,credential}` → renewed session cookie |
| `POST /phone-api/unpair` | Same credential payload → revoke credential/sessions/active WSS |
| `GET /phone-api/health` | Authenticated native readiness |
| `GET /codex-api/*`, `WS /codex-api/ws` | Authenticated upstream/native business paths |

Codes: 8 digits, 10 minutes, 20 wrong attempts. Credential: up to 365 days; session: up to 28 days. Server persists only hashes. Client keeps the credential in AES-GCM storage backed by Android Keystore. This authorizes access to native tools and files as the desktop user; pair only a phone you trust.

配对码 8 位、10 分钟、最多 20 次错误；长期凭证最多 365 天，临时会话最多 28 天。服务器只存哈希，手机使用 Android Keystore 支持的 AES-GCM 存储。授权手机可以以桌面用户身份操作原生工具和文件，请只配对自己信任的手机。
