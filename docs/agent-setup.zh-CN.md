# AI agent 部署指南

先读 `AGENTS.md`，再按本指南操作。所有命令在仓库根目录运行，使用当前用户的环境，不复用维护者的安装数据。普通配置通过命令或私有配置项完成，不临时修改源码。

## 1. 检查现状

1. 确认 Windows x64、Node >=24.16.0、Git，以及已安装并登录的官方 Codex 桌面应用；不要读取或复制 OpenAI 登录文件。
2. 重复安装前先检查现有状态和 status。升级保留身份与授权。另建测试部署时，使用 `--state` 或 `CODEX_PHONE_STATE`，并使用独立中转资源。
3. 只询问无法自动发现的信息：是否外出访问、使用自有 HTTPS／WSS 还是 Cloudflare、是否需要进程级代理。不得假定代理端口，不要求购买域名。
4. 阅读 `docs/compatibility.md`。未实测版本不等于已支持；能力检查失败应报告兼容性问题，不能直接修改桌面应用。

## 2. 准备本地代码

```powershell
npm ci
npm run build
npm test
node scripts/manage.mjs setup --json
```

setup 生成独立电脑身份、管理与 Agent 密钥，限制状态目录权限。重复执行保留身份、手机授权和自定义设置。快捷方式指向仓库，请放在固定目录。电脑需要 Node 和项目依赖，手机不用构建工具。普通安装不要调用发行签名脚本。

## 3. 配置用户中转

Cloudflare：先准备部署，运行 `npx wrangler login`，由用户在浏览器完成授权。按当前 Wrangler 的要求申请发布脚本与 KV 等权限。若 OAuth 回调因本地监听器退出而失败，重启登录并给出新链接或短码，不反复使用过期码。

通过 `npx wrangler whoami` 获取可用账号，存在多个账号时请用户选择。不要将 OAuth token 粘贴到对话、日志或 Git。随后运行：

```powershell
node scripts/manage.mjs relay cloudflare deploy --account USER_ACCOUNT_ID --json
```

命令生成 Worker 名称、创建或复用指定 KV、发布仓库模板并设置随机注册密钥。Wrangler 配置写入私有状态目录；重试复用已保存资源。新增账号、域名或付费服务必须由用户决定，默认不购买、不升级。

自有 HTTPS：用 `setup --endpoint https://USER_ORIGIN` 设置入口，按 `docs/relay.md` 帮用户配置已有代理。仅转发私有 config.json 中的网关端口；不要公开整个配置文件、管理接口或桌面 CDP。代理改写 Host 不得授予授权。

如有需要，用 `setup --proxy http://USER_PROXY:PORT` 配置进程级代理，不改系统设置。网络出错分别检查电脑与手机；手机能打开 Worker 健康地址，并不能证明电脑也能访问。

## 4. 启动与诊断

```powershell
node scripts/manage.mjs start --json
node scripts/manage.mjs doctor --json
```

读取结构化字段，不匹配本地化报错字符串。退出码 0 表示成功、2 表示需人工操作或尚未就绪、1 表示操作失败。status 只描述后台状态，doctor 必须验证原生 `thread/list`、入口身份及匿名 HTTP／WSS 拒绝。

桌面应用如果没带回环 CDP 启动，请用户**正常退出一次，包括托盘**，后台会等待并自动打开。不要强制关闭应用、不要结束其他端口的进程。Store 更新后旧的运行版本和新的注册版本可以并存：验证为官方实例后复用旧进程，不仅检查最新安装路径。

原生模块、manager 或历史检查失败时，报告不兼容的版本和不含会话内容的错误。不能替换成 CLI 会话、独立模型 API、提取凭证或临时补丁来绕过。

## 5. 由用户完成手机验收

1. 下载本仓库 release 的签名 APK 并核验 SHA-256。通用 APK 不预设地址；API 26 只是安装下限，仍需要现代 WebView。
2. 执行 `pair --open`，只轮换当前安装的一次性配对码。配对页和 JSON 含敏感信息，不得提交或发到 issue。
3. 用户安装 APK，输入入口与配对码，或粘贴 `codexphone-public://pair` 链接。
4. 在已有原生会话发无副作用测试消息，电脑核对同一 ID 和回复。
5. APK 重开免密、移动数据访问、无害操作触发的权限审批分别验收。
6. 在隔离测试部署内重启它自己的隧道，确认固定地址和已存授权恢复；不要重启其他部署来测试。

逐项记录“已实测／失败／尚未实测”，不能用编译通过、模拟测试或另一套原型的结果替代。

## 6. 恢复、升级、卸载

按 `docs/troubleshooting.zh-CN.md` 处理。配置变更用 stop/start 加载；代码更新运行 `scripts/Update.ps1`。仅在身份改变、授权过期或撤销时重新配对，隧道换址不用重配。用 phones list/revoke 管理手机授权。

本地 uninstall 只移除本项目组件和自有状态，不删除官方桌面应用与云资源。删除云端资源需用户明确授权，并精确使用已保存的 Worker／KV 标识。换电脑重新部署、重新配对；官方会话和项目文件另行迁移。
