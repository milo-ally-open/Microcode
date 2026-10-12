# Proposal: Shared Application Runtime

## Why

当前 Agent 能力已由 `MicrocodeAgent`、session、tools、permissions 等模块承载，但应用组合仍集中在 TUI 启动入口。桌面端若直接复用 TUI 入口会继承终端耦合；若另建 agent 组合则会造成工具、审批、模型和会话行为分叉。

## What Changes

- 将项目/session 生命周期、事件分发、权限交互和 client adapter 编排收敛到 runtime facade。
- 为 TUI、Desktop backend 和 ACP adapter 定义统一命令、事件与快照契约。
- 保留现有 CLI/TUI，以适配层迁移，不重写内核。
- 明确 Application Runtime、MicrocodeAgent/harness 与 Model Layer 的职责。

## Capabilities

- `application-runtime`: 创建/关闭 runtime，打开项目/session，提交 prompt，取消和订阅事件。
- `runtime-event-contract`: 标准消息、工具、审批、错误和终态事件。
- `client-adapters`: TUI、Desktop、ACP 接入同一 runtime。

## Impact

主要涉及 `src/main.tsx`、`src/agent/`、`src/session/`、`src/tools/`、`src/permissions/` 和相关测试。本工作流不实现 Electron 界面，不改变 Agent 决策和工具安全策略。
