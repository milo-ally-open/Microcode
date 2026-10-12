# Proposal: Desktop Shell

## Why

桌面产品需要窗口、应用生命周期和 renderer/backend 通信。内核依赖 Bun 能力，不能让 renderer 直接持有 Agent、文件系统或凭据。

## What Changes

- 建立 React renderer、Electron 主进程、窄 IPC bridge 与 Bun runtime sidecar。
- 管理启动、退出、崩溃、重连与协议版本协商。
- 以 T3Code 作为 UI 结构/交互实现的主要参考，以用户提供的 Codex Desktop 截图作为整体体验目标。
- 建立 Microcode 自有 tokens、导航、组件和桌面工作台布局。

## Capabilities

- `desktop-lifecycle`: 窗口和 sidecar 生命周期。
- `secure-bridge`: allowlist IPC 与输入校验。
- `desktop-workbench`: 项目/会话导航、工作区、面板和 composer。

## Impact

新增桌面 app 与打包配置。实施前必须验证 Electron + Bun sidecar、keyring/native module 和 Windows 路径兼容性。
