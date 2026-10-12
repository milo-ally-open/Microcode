# Microcode Desktop Specifications

本目录将从 `microcode-cli` 抽取内核、构建 Microcode 桌面应用并支持 ACP 的工作拆成七个可评审、可分派的 OpenSpec 风格工作流。每个工作流含 `proposal.md`（动机与影响）、`spec.md`（可验收需求）、`design.md`（技术边界）和 `tasks.md`（任务清单）；按本项目约定放在 `docs/Specifications/<workflow>/`。

## 评估与目标架构

这项改造可行，但应复用原项目内核并重构入口边界，而不是把两个项目的代码直接拼在一起。Microcode 已有 Agent、会话持久化、模型/provider、权限、工具、MCP、插件、项目指令和 Git 能力。`MicrocodeAgent` 已提供快照、消息、prompt、订阅、模型切换和权限等能力；主要工作是把当前与 TUI 耦合的应用组装提炼为共享 runtime，再增加桌面和 ACP adapters。TUI 必须继续可用。

目标分层：

1. **Clients/adapters**：现有 TUI、React/Electron Desktop、ACP Agent adapter。
2. **Microcode Application Runtime**：项目/session 生命周期、事件、权限交互和 adapters。
3. **MicrocodeAgent / harness**：Agent 执行及现有 tools、skills、MCP、Git 能力。
4. **Model Layer**：Pi AI、providers 及现有 Model Gateway。

以上是目标职责，不代表仓库已经实现。初期 runtime 可以组合调用现有模块，不要求先大规模搬动代码。现有 Model Gateway 是模型 API 兼容层，不是 Desktop/ACP 的完整 agent runtime IPC。

## 三种参考的边界

- **`microcode-cli`**（https://github.com/milo-ally-open/microcode-cli）是 Microcode 内核和行为的只读来源。所有产品代码改动写入 `microcode` 仓库。
- **T3Code**（https://github.com/pingdotgg/t3code）是 UI 结构和交互实现的主要参考仓库。实现 UI 的 Agent 应检查相关 React 页面和组件，例如 AppSidebarLayout、ChatView、Sidebar、ChatComposer、ComposerPendingApprovalPanel、ChangedFilesTree 和 ThreadTerminalDrawer；路径变化时应搜索对应实现。提取设计模式并映射到 Microcode，不复制源码、品牌或资产，不引入其服务端、多端同步或远程编排架构。
- **用户提供的 Codex Desktop 截图**定义最终桌面工作台体验：左侧应用导航/项目/会话，中间对话区，右侧变更审阅，底部可展开终端，以及固定 composer；保持桌面应用的信息密度和面板操作感，使用 Microcode 自有品牌与视觉 tokens。

ACP 角色按协议语义定义：Zed/Harness 等宿主是 ACP Client，Microcode 提供被宿主启动的 ACP Agent adapter。首发使用稳定 ACP v1；v2 draft/experimental 暂不纳入。

## 工作流和顺序

| 编号 | 工作流 | 目标 | 依赖/顺序 |
| --- | --- | --- | --- |
| 01 | [kernel-runtime](01-kernel-runtime/proposal.md) | 抽取共享 Application Runtime 和协议契约 | 先做 |
| 02 | [desktop-shell](02-desktop-shell/proposal.md) | React/Electron 外壳及核心对话体验 | 01 契约稳定后开始 |
| 03 | [agent-conversation](03-agent-conversation/proposal.md) | 对话流、工具状态和审批交互 | 01、02 |
| 04 | [workspace-git](04-workspace-git/proposal.md) | 项目、变更审阅、Git/worktree | 01；桌面 UI 对接 02 |
| 05 | [model-integrations-settings](05-model-integrations-settings/proposal.md) | 模型、认证、MCP/插件设置 | 01；桌面 UI 对接 02 |
| 07 | [acp-adapter](07-acp-adapter/proposal.md) | 让 Zed 等 ACP Client 调用 Microcode runtime | 01 契约稳定后可并行 |
| 06 | [packaging-release](06-packaging-release/proposal.md) | Windows 安装包和整体验收 | 02–05、07 集成后最后做 |

建议先完成 01，再启动 02；runtime 契约稳定后，03–05 和 07 可按接口并行，最后执行 06。子 Agent 应独立负责明确的模块边界，避免同时改 runtime 核心。

## 共通约束与验收

- 所有 Agent 业务状态、会话、权限和工具执行均由 Microcode 内核/runtime 持有；renderer 只呈现状态并提交命令。
- 保留现有 CLI/TUI、provider 登录、`--no-daemon` 路径和已有工具/审批语义。
- Electron renderer 启用 sandbox 和 context isolation；不暴露任意 IPC、shell、文件系统或凭据操作。
- 项目选择、变更审阅、终端和设置均经受控 backend/runtime API。
- 首发暂按 Windows x64 规划；macOS/Linux 是否同属首发需在实施前决策。
- 完成标准以对应测试、类型检查、启动/安装验证和人工验收证据为准；无法验证的能力标明限制，不报为通过。

## 主要风险和未决项

需要 spike 验证 Electron 与 Bun sidecar、native keyring、sidecar 生命周期、Windows 路径与安装包。还需确认首发是否覆盖全部 MCP/插件/worktree 能力、ACP host 的目标版本，以及是否要求跨平台同时发布。若安全 IPC 或 native 依赖验证失败，应先调整进程方案或缩小首发范围。

## 参考资料

- [Microcode CLI source](https://github.com/milo-ally-open/microcode-cli)
- [Microcode desktop target](https://github.com/milo-ally-open/microcode)
- [T3Code repository](https://github.com/pingdotgg/t3code)
- [T3Code architecture](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md)
- [T3Code web UI notes](https://github.com/pingdotgg/t3code/blob/main/docs/internals/web-ui.md)
- [OpenSpec spec-driven schema](https://github.com/Fission-AI/OpenSpec/blob/main/docs-lab/reference/schemas/spec-driven/index.md)
- [ACP protocol](https://github.com/agentclientprotocol/agent-client-protocol)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
