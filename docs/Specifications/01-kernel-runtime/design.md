# Design: Shared Runtime

## 目标分层

1. TUI、Desktop backend、ACP Agent adapter：client adapters。
2. Application Runtime：项目/session 生命周期、事件、权限交互、adapter 编排。
3. MicrocodeAgent/harness：Agent 执行、tools、skills、MCP、Git 等已有能力。
4. Model Layer：Pi AI、providers 和现有 Model Gateway。

这是逻辑职责边界，不要求首轮迁移所有源文件。runtime 可先通过 composition root 组合已有 manager。

## 建议模块

- `ApplicationRuntime`: 生命周期、项目/session 打开、命令分发、订阅和关闭。
- `RuntimeFactory`: 集中装配现有模块与依赖。
- `RuntimeProtocol`: 与 React、TUI widget、Electron API 无关的 TypeScript DTO。
- `TuiAdapter`: 将输入转成 runtime 命令、将事件交给现有 TUI。
- `DesktopBackendAdapter`：后续向窄 IPC 暴露 runtime 契约。
- `AcpAgentAdapter`：后续将 ACP v1 请求/通知映射到 runtime；Microcode 对外扮演 ACP Agent。

流式结果用事件订阅，操作用 request/response 命令。快照用于首屏和重连恢复；事件携带递增序号、类型化 payload、稳定 session ID。adapter 显式映射外部与内部 session ID。

## 迁移与风险

先提取与 UI 无关的 composition/resource lifecycle，再迁移现有 TUI 流程作兼容验证。多 client 竞争同一 session 时需要序列化 prompt 或返回 busy 状态。当前代码含 Bun API 和 native keyring 依赖；用最小 spike 验证 Bun backend、Electron sidecar、IPC 和 keyring，不预设 renderer 可直接导入内核。
