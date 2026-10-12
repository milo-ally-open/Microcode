# Proposal: ACP Agent Adapter

## Why

Microcode 若只能由自有 TUI/Desktop 调用，用户仍需切换工具才能使用 Agent。实现 ACP adapter 后，Zed 等 ACP Client 可启动 Microcode，并继续复用 Microcode 自己的 session、工具、模型和权限逻辑。

## What Changes

- 提供 ACP v1 Agent 入口，首发使用 stdio JSON-RPC。
- 将 ACP 初始化、session、prompt、取消、更新和权限请求映射到共享 runtime。
- 定义外部 session ID 与 runtime session ID 映射和能力声明。
- 保持 adapter 薄，不复制 agent/harness/provider 实现。

## Capabilities

- `acp-agent-process`: ACP host 启动并协商 Microcode Agent。
- `acp-session-bridge`: ACP session 映射到 runtime session。
- `acp-permission-bridge`: 权限请求经 ACP Client 审批后返回内核。

## Impact

依赖 01 runtime 契约。首发只支持稳定 ACP v1；Microcode Desktop 作为 ACP Client 连接第三方 Agent 不在本工作流范围，ACP v2 draft/experimental 暂不支持。
