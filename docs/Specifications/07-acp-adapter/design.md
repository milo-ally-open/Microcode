# Design: ACP Agent Adapter

## 协议角色

Zed/Harness 等外部宿主是 ACP Client；Microcode 子进程在该连接中作为 ACP Agent。仓库内 adapter 是协议入口。若以后要让 Microcode Desktop 连接第三方 ACP Agent，应另立工作流。

## 传输与版本

首发由 ACP host 启动 Microcode 子进程，以 stdin/stdout 传输 ACP v1 JSON-RPC，stderr 记录诊断。评估官方 TypeScript SDK `@agentclientprotocol/sdk` 与 Bun 的兼容性；如需补缺口，只实现薄 transport，不自创 wire format。稳定 v1 与 draft v2 隔离，首发不启用 v2。

## 映射

- `initialize`: 协议版本、能力和实现信息协商。
- `session/new` / 可选 `session/load`: 调用 runtime 项目/session API，维护外部 ID 映射。
- `session/prompt` / `session/cancel`: 调用 runtime prompt/取消。
- `session/update`: 映射消息、工具活动、文件变化和终态。
- 权限请求：映射到 ACP Client permission request，响应交回 runtime；拒绝、超时和断连不隐式授权。

实际方法、update 类型和 capability 必须按 ACP v1 schema/SDK 核实。只有确实委托给 host 并经 runtime 授权的文件、terminal 或 MCP 能力才可声明。adapter 不拥有第二套持久化、模型选择或工具策略。

## 验证

使用官方 schema/SDK 测试 initialize、session、updates、permissions，再用官方测试 client 或 Zed 做真实启动冒烟；记录 host 版本和能力差异。ACP v2 单独评审，不混用。
