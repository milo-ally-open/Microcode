# Proposal: Agent Conversation and Approval UI

## Why

桌面端核心路径是通过 Microcode Agent 完成任务，并理解消息流、工具执行与权限请求。仅显示文本会丢失现有 TUI 能力；由 renderer 判断权限会绕过内核。

## What Changes

- 实现历史消息、流式输出、输入 composer 和取消。
- 呈现可折叠工具活动、结果、错误和任务终态。
- 显示待审批请求并将选择回传 runtime。
- 复用 T3Code 对话/审批交互模式，遵循 Codex Desktop 工作台信息层级。

## Capabilities

- `conversation-stream`: 历史与实时消息。
- `agent-activity`: 工具和任务状态。
- `permission-approval-ui`: 用户审批流程。

## Impact

依赖 01 runtime 契约和 02 desktop bridge；继续使用内核的 prompt、session、权限与工具实现。
