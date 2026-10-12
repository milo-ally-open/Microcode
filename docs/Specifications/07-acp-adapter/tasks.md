# Tasks: ACP Agent Adapter

- [x] 核对官方 ACP v1 schema、stdio framing、session 和 permission 方法。
- [x] 验证官方 TypeScript SDK `@agentclientprotocol/sdk@1.8.0` 在锁定 Bun `1.3.14` 下可用。
- [x] 定义 ACP 与 runtime session ID 映射和连接资源所有权。
- [x] 实现 initialize、能力协商和 ACP Agent 入口。
- [x] 实现 session create/load（仅在 runtime 支持时）、prompt、cancel 和 update 映射。
- [x] 映射权限请求并覆盖拒绝、超时和断连；一次批准与会话批准都回传共享 runtime。
- [x] 确保 stdout 仅含 JSON-RPC，stderr/log 不含秘密；ACP TCK transport/stderr 检查通过。
- [x] 添加 SDK 流契约测试，覆盖事件回放顺序、MCP 传输映射、权限决定和取消/断连竞态。
- [x] 使用官方 ACP TCK `0.2.0` 对真实 Bun 子进程运行 v1 全套：`CONFORMANT`，39 项通过、17 项因未声明能力或未提供认证方法而跳过、0 项失败。
- [ ] Zed UI 宿主冒烟：本机 Windows 与 WSL 均未发现 Zed 命令或安装；需在装有 Zed 的环境补测。TCK v1 子进程宿主验证已通过。
- [x] 更新 CLI 帮助、README 和 Zed 自定义 Agent 启动示例。

全仓验证：`bun test ./tests`（Bun `1.3.14`）为 262 pass、1 skip、0 fail。Zed 冒烟是当前唯一环境阻塞项。
