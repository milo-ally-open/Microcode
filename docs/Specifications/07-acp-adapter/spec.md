# ACP Agent Adapter Specification

## ADDED Requirements

### Requirement: Microcode 提供兼容 ACP v1 的 Agent
Microcode MUST 通过 stdio JSON-RPC 为支持的 ACP host 提供稳定 ACP v1 Agent 入口。初始化 MUST 协商协议版本和能力，且 MUST NOT 声明未实现能力。

#### Scenario: Host 启动并初始化
- **Given** ACP host 启动 Microcode 进程
- **When** host 使用 ACP v1 发送 `initialize`
- **Then** Microcode 返回 v1、实现信息和真实支持的能力
- **And** 进程继续接受 session 请求

#### Scenario: 协议版本不兼容
- **Given** host 请求不兼容版本
- **When** 初始化协商
- **Then** adapter 按 ACP 版本协商规则回应或关闭并报告错误
- **And** 不在不兼容协议下启动 Agent session

### Requirement: ACP session 使用共享 runtime
Adapter MUST 将 session 创建、prompt、取消及 runtime 支持时的恢复映射到共享 Application Runtime，并按连接维护外部/内部 session ID。Runtime updates MUST 转为 ACP 通知。

#### Scenario: 创建会话并流式运行
- **Given** ACP 连接已初始化
- **When** host 创建 session 并发送 prompt
- **Then** adapter 创建/选择对应 runtime session
- **And** 消息、工具和 turn 更新按序转发至终态

#### Scenario: 取消 prompt
- **Given** ACP session 有活动 prompt
- **When** host 请求取消
- **Then** adapter 向同一 runtime session 请求取消
- **And** 转发终态且不丢弃已发出的更新

### Requirement: 权限决定遵守 Microcode 策略
Runtime 要求审批时，adapter MUST 通过 ACP Client 请求授权并把决定返回 runtime。Client 断连、能力缺失或超时 MUST NOT 自动批准。

#### Scenario: Client 批准受保护操作
- **Given** runtime 发出关联 ACP session 的权限请求
- **When** ACP Client 批准
- **Then** adapter 将响应关联到正确 request/session
- **And** 最终是否执行仍由 runtime policy 决定

#### Scenario: 审批待决时断连
- **Given** ACP Client 在审批完成前断开
- **When** adapter 检测到连接关闭
- **Then** 操作保持未批准并执行 runtime 的取消/超时策略

### Requirement: 能力、错误和传输输出诚实
Adapter MUST 只声明已实现能力，将 runtime 错误映射为 ACP 错误/stop reason，并把诊断输出到协议流之外。stdout 承载 JSON-RPC 时不得输出 banner 或日志。

#### Scenario: 记录诊断
- **Given** ACP 使用 stdio 通信
- **When** backend 记录运行诊断
- **Then** stdout 保持合法 JSON-RPC framing
- **And** 诊断进入 stderr 或日志文件
