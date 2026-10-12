# Agent Conversation Specification

## ADDED Requirements

### Requirement: 提交、流式接收和取消任务
用户 MUST 能查看当前会话、提交 prompt 并取消运行任务。UI 状态 MUST 能从 runtime 快照和事件恢复。

#### Scenario: 流式响应
- **Given** 可用模型和打开的 session
- **When** 用户提交非空 prompt
- **Then** 用户消息立即显示，Agent 增量按序追加
- **And** 终态清楚显示成功、失败或取消

#### Scenario: 取消运行任务
- **Given** 当前 session 正在执行任务
- **When** 用户请求取消
- **Then** runtime 收到取消命令并反馈终态
- **And** 迟到事件不会导致重复提交或状态回退

### Requirement: 工具活动清楚且安全
UI MUST 展示工具名称、运行状态、可安全展示的输入摘要及结果/错误；敏感字段 MUST 脱敏。工具执行与权限策略由内核负责。

#### Scenario: 工具执行成功或失败
- **Given** Agent 发起工具调用
- **When** 工具状态事件到达
- **Then** 活动卡片显示运行和结果状态
- **And** 大型输出可折叠且不阻塞输入

### Requirement: 权限请求需要明确响应
每个待决审批 MUST 显示操作类别、目标和必要上下文，只提供 runtime 支持的选项。关闭窗口或断连 MUST NOT 隐式批准。

#### Scenario: 用户处理审批
- **Given** runtime 发出待审批请求
- **When** 用户批准或拒绝
- **Then** 对应 request ID 的决定只提交一次
- **And** UI 等待 runtime 确认后再标记完成

#### Scenario: 断线后恢复待审批请求
- **Given** session 有未处理审批
- **When** renderer 重新连接
- **Then** 快照重新显示该审批
- **And** 不发生自动批准
