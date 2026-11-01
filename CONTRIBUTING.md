# Contributing

Read AGENTS.md. Keep changes scoped, use isolated state/mocks by default, and document actually tested Desktop/Android versions. Run build, tests and the publication audit. An upstream baseline update needs new archive hashes, provenance review and native acceptance; do not patch compiled strings or copied official app JavaScript.

Add public files explicitly to public-files.json. Do not commit runtime data, account resources, keys, logs, pairing pages or binaries. CI produces unsigned APKs only. Conventional Commits are preferred. Security reports follow SECURITY.md.

贡献前阅读 AGENTS.md；默认使用隔离测试，新增公开文件加入白名单。上游升级需更新哈希、来源审查和原生验收，不改打包字符串或提交官方提取代码。不要把私人状态、签名、日志和账号配置放入仓库，CI 只构建未签名 APK。
