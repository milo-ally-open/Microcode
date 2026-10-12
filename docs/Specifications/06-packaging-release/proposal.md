# Proposal: Desktop Packaging and Release

## Why

桌面改造只有在目标设备能安装、启动和卸载时才算交付。Electron、Bun sidecar 和 native keyring 需要独立发布流程与验证门槛。

## What Changes

- 建立可复现的开发/生产构建和桌面产物。
- 将 renderer、Electron 主进程及兼容 Bun backend 一同打包。
- 定义安装、启动、日志、卸载和首发升级体验。
- 在 CI 验证测试、产物和安装包冒烟。

## Capabilities

- `desktop-build`: 可复现构建和产物元数据。
- `desktop-installation`: 安装、启动、退出与卸载。
- `release-validation`: 自动门槛与人工验收清单。

## Impact

依赖 02–05、07 稳定集成版本。首发暂按 Windows x64；其他平台需产品决策。
