# 排错指南

先运行 `node dist/cli.mjs status --json`，再运行 `doctor --json`。service.log 只在本地查看，不要公开原始日志、配对页、配置、凭证、项目路径或会话内容。

| 症状／代码 | 含义与处理 |
|---|---|
| `service_not_running`／`service_start_failed` | 运行 start，检查私有 service.log、Node 版本、构建是否完成、目录权限及保存的端口。 |
| `desktop_normal_exit_required` | 官方应用没启用回环 CDP；正常退出并关闭托盘，后台等待后自动打开。 |
| `desktop_not_installed` | 安装并登录官方 Windows 应用，不要用 CLI 替代。 |
| `desktop_port_owner_invalid` | 端口不属于官方回环实例；不能结束它，检查真实运行版本与配置。 |
| `UNSUPPORTED_DESKTOP_*`／manager 或历史错误 | 内部接口改变或没有兼容的本地 manager。提供版本和脱敏错误，由项目维护兼容性，不临时修改官方程序。 |
| 握手通过但 doctor 失败 | Agent 连接或握手不够，继续检查原生 thread/list、登录与完整历史。 |
| `relay_not_configured` | 配置自有 HTTPS 入口或部署 Cloudflare。 |
| `relay_unavailable` | 分别检查入口身份、TLS／DNS、隧道日志、Worker 注册与匿名 HTTP／WSS 拒绝。 |
| `authentication_boundary_failed` | 反向代理指向了认证网关以外的服务，修正路由，不绕过检查。 |
| `service_already_starting` | 另一进程持有服务租约，等待并看 status。不要删活跃租约；已退出 PID 的租约会在下次启动恢复。 |
| `pairing_expired`／`pairing_locked` | 重新运行 pair。码有效 10 分钟，错误 20 次后该码锁定。 |
| `wrong_computer` | 入口身份与配对／已存电脑身份不一致，修正入口，不忽略身份校验。 |
| `phone_not_authorized` | 凭证过期或被撤销，或临时会话无效。应用用 Keystore 凭证续期；长期授权失效才重新配对。 |
| 老会话没有历史 | 显式运行原生历史只读验收，不能只依赖渲染器缓存。 |
| 仅 Wi-Fi 能用 | 用移动数据测试固定 HTTPS 入口，不只检查电脑回环服务。 |
| Worker health 能开但界面不行 | health 只证明 Worker 可达，还需检查电脑注册、phone-api/info、doctor 和手机授权。 |
| Store 更新后多版本并存 | 验证旧进程仍属官方后复用，下一次正常退出时再打开新版本。 |
| 旧 Android 的网页错误 | 更新系统 WebView。无需 Google 服务，但需要现代网页引擎。 |

Cloudflare 恢复：后台会重启自己创建的 cloudflared 子进程，并向固定 Worker 注册新地址。KV 更新可能约一分钟才传播。Worker 不能唤醒离线／休眠电脑；电脑应保持唤醒，接入层持续运行。当前后台只监督组件，不负责自身崩溃或 Windows 登录自启动；整个接入层停止或退出后，重新打开 Codex Phone。

账号授权：本地 OAuth 回调监听器消失时重新登录；缺少 `workers_scripts:write` 是 Cloudflare 发布授权问题，不能归因于桌面连接。不要把 token 粘贴进脚本或公开报告。先检查免费额度与服务可用性，不能承诺任意规模永久免费。

Windows 已知经验：空日志合法；读活动日志必须允许共享；子进程退出码要保留；重复启动必须通过认证管理接口复用。不要恢复原型的全局 HTTP 钩子、打包字符串补丁、上游默认 Tauri Agent 配置或私人代理端口。

提交 issue 请提供操作系统、Node／桌面版本、中转类型、错误码与失败验收步骤，移除地址、ID、用户名和会话内容。[安全报告](../SECURITY.md)也不能含有效凭证。
