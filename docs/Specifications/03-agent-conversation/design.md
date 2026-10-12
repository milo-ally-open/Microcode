# Design: Agent Conversation

## 组件与状态

对话画布消费 runtime 快照/事件；composer 只提交 prompt/取消；工具卡片展示活动；审批面板按 request ID 跟踪待决项。runtime 是状态唯一来源。模型、消息增量、工具活动、任务状态和权限请求使用独立 DTO；序号缺口时拉取快照，避免重复消息。

UI Agent 应检查 T3Code 对话、composer、工具活动和审批相关 React 组件，把可复用交互映射到 Microcode 的 runtime 事件。整体工作台感受按 Codex Desktop 截图：侧栏选项目/会话，中间保留对话，右侧变更审阅和底部终端可按需展开。composer 显示附件、模型和权限模式；任何权限变化都要通过 runtime 明确确认。

## 隐私与错误

展示可操作的 provider/tool/network 错误摘要；详细诊断从日志查看。API keys、环境变量、命令中的秘密不可出现在消息卡片或日志。审批按钮由 runtime 返回的选项驱动。
