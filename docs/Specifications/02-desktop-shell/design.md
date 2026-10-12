# Design: Desktop Shell

## 进程模型

候选架构为 Electron 主进程 + React sandbox renderer + Bun backend sidecar。React 负责展示和输入；Electron 主进程负责窗口与窄 IPC；Bun backend 持有 runtime、文件操作、工具和 provider 调用。主进程不承载 Agent 业务规则，日志不得输出 secret。

## UI 参考与映射

T3Code 是 UI 结构与交互实现的主要参考。实现前检查其当前源码，重点查看 `AppSidebarLayout`、`ChatView`、`Sidebar`、`ChatComposer`、`ComposerPendingApprovalPanel`、`ChangedFilesTree`、`ThreadTerminalDrawer` 等对应页面/组件；实际路径变化时搜索等价实现。形成“参考模式 -> Microcode 组件/交互”的映射后再实现。

用户提供的 Codex Desktop 截图定义整体产品体验：左侧应用导航/项目/会话，中间对话和文件工作区，右侧变更审阅，底部终端，固定 composer 显示附件、模型和权限模式。使用深色、高信息密度布局，支持标签、面板折叠/调整和键盘导航。UI 用 Microcode 自有 tokens、图标、颜色和文案，不复制源码或品牌资产。

## IPC 与验证

bridge 只开放 runtime 命令和事件订阅，禁止通用 `invoke(channel,payload)`。消息校验大小、字段和版本；错误使用稳定码。sidecar 重启后重新协商并通过快照恢复。先验证 Bun 打包、native keyring、Windows 路径/空格、开发热重载和进程回收，再扩展 UI。
