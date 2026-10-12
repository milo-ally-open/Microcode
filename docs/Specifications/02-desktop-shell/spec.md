# Desktop Shell Specification

## ADDED Requirements

### Requirement: renderer 通过受限 bridge 访问 runtime
Renderer MUST 在 sandbox 与 context isolation 下运行，并仅通过显式 allowlist bridge 调用 backend。MUST NOT 暴露 Node integration、任意 IPC、secret storage、任意文件访问或无约束的命令执行 API；用户可通过受限 bridge 操作当前项目的交互式 Bash PTY。

#### Scenario: 合法 IPC 调用
- **Given** backend 已就绪且协议兼容
- **When** renderer 请求会话快照
- **Then** 主进程校验并转发类型化请求
- **And** renderer 收到类型化结果

#### Scenario: 未授权 IPC 调用
- **Given** renderer 请求未公开通道或错误 payload
- **When** 主进程处理请求
- **Then** 请求被拒绝且不会执行本地命令

### Requirement: 桌面应用管理 backend 生命周期
Desktop MUST 启停其拥有的 runtime backend，呈现启动、就绪、重连、失败状态，并在退出时请求优雅关闭。

#### Scenario: Backend 启动失败
- **Given** backend 无法启动或协议不兼容
- **When** 应用打开
- **Then** 用户看到可理解的错误和日志位置
- **And** 界面不会伪装为可用或无限等待

### Requirement: 工作台符合桌面编码应用的信息层级
界面 MUST 具有左侧应用导航和项目树（每个项目包含其会话）、中间主工作区、可收起的右侧文件/变更审阅面板、可展开的底部 Bash PTY 终端，以及固定于对话底部的 composer。会话不得脱离项目单独列出，也不需要最近会话列表。整体体验参考用户提供的 Codex Desktop 截图；界面模式优先参考 T3Code 的实际 React 页面/组件。使用 Microcode 自有品牌、组件和视觉资源。

#### Scenario: 打开变更审阅
- **Given** 当前会话产生了文件改动
- **When** 用户打开右侧变更面板
- **Then** 对话仍可见，右侧显示文件列表和选中 diff
- **And** 收起面板后会话状态不变

#### Scenario: 展开终端
- **Given** 当前项目已打开
- **When** 用户展开底部终端面板
- **Then** 当前项目目录下启动真实 Bash PTY，支持输入、ANSI 输出和终端尺寸调整
- **And** 收起后 PTY、会话状态和 composer 状态保持不变

#### Scenario: 窄窗口布局
- **Given** 窗口缩至支持的最小宽度
- **When** 布局重排
- **Then** 侧栏/面板可折叠且主要操作仍可访问
