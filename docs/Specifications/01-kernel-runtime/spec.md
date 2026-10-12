# Runtime Kernel Specification

## ADDED Requirements

### Requirement: 共用 runtime 负责生命周期和 adapter 编排
Application Runtime MUST 管理项目与会话生命周期、事件分发、权限交互和 client adapters，并协调现有 agent、tool、plugin/MCP manager 的资源生命周期。Agent/harness 与工具执行继续由 `MicrocodeAgent` 及现有模块负责；runtime MUST NOT 复制一套 Agent 实现。TUI、Desktop 和 ACP adapter MUST 调用同一 runtime 能力。

#### Scenario: Desktop 打开已保存会话
- **Given** 一个有效项目和已保存 session
- **When** Desktop backend 请求打开该 session
- **Then** runtime 恢复 session 并提供快照、消息历史和事件订阅
- **And** 整个流程不需要启动 TUI 或模拟终端输入

#### Scenario: ACP 与 Desktop 共用会话状态
- **Given** ACP adapter 和 Desktop 连接到共享 runtime
- **When** 两端读取同一 session 状态
- **Then** 两端观察到一致的 Agent、消息和任务状态
- **And** 工具执行与权限判定仍由同一内核策略负责

#### Scenario: 关闭 runtime
- **Given** runtime 拥有 Agent、插件或 MCP 子进程等资源
- **When** 调用关闭操作
- **Then** 新操作被拒绝，活动任务按契约取消或完成，所拥有资源被释放

### Requirement: 命令、事件和快照有稳定契约
Runtime MUST 为 session 创建/选择、prompt、取消、审批响应、模型切换和订阅定义类型化契约。事件 MUST 携带 session 标识及可检测顺序；adapter MUST 将外部协议映射到该契约，不得绕过 runtime 直接操作内部对象。

#### Scenario: 流式事件和重连恢复
- **Given** client 已订阅一个 session
- **When** Agent 产生消息增量、工具状态变化和最终状态
- **Then** client 按顺序接收类型化事件
- **And** 断连后可通过快照恢复一致状态

### Requirement: 保持原有 CLI/TUI 和内核行为
Runtime 抽取 MUST 保留 provider/model、提示词、工具、权限、session persistence、MCP、插件及 project instruction 行为。桌面 adapter MUST NOT 绕过内核权限策略。

#### Scenario: 原 TUI 入口执行任务
- **Given** 用户使用现有 CLI/TUI 启动方式和配置
- **When** 用户提交任务并触发工具
- **Then** 行为、权限、输出和会话保存符合原有契约
