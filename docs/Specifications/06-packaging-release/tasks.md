# Tasks: Packaging and Release

- [x] 确定首发平台、最低系统版本、安装范围、签名和更新策略：Windows x64，Windows 11 25H2 / Windows Server 2025，当前用户安装，unsigned，手动更新。
- [x] 固定 Electron/Bun/toolchain 版本并建立可复现构建；同一源码状态下两次独立完整 Windows x64 构建得到相同 ZIP SHA-256（`09fe2541eeca5717debf504166c46e31088cd07e118165f407e805ed70013b47`）。
- [x] 将 UI、backend 和资源打入产物并校验版本元数据及 Desktop/backend 协议握手。
- [x] 处理 Windows 路径/权限、sidecar 退出及孤儿进程；安装路径含空格、用户级升级/卸载和 backend 关闭均通过自动冒烟。
- [x] 建立 CI：类型检查、测试、Windows x64 生产构建和产物完整性工作流已加入；本地完整流水线通过，远端 Actions 运行待确认。
- [ ] 在干净 Windows x64 环境验收安装、启动、项目对话、退出、升级和卸载。
- [x] 使用测试凭据 sentinel 检查打包启动输出及应用日志未泄漏 provider 凭据。
- [x] 检查失败/崩溃诊断场景不泄漏凭据或敏感内容：renderer 崩溃诊断仅写入 Electron 原因枚举和数值退出码；测试注入凭据样式文本后确认诊断不包含该内容，backend 启动错误继续经过脱敏处理。
- [x] 编写安装、排障和数据保留说明。

自动验收运行于 Windows 11 25H2 build 26200 的开发机，并使用隔离临时用户目录；这不等同于干净设备或可见 UI 验收。候选包 manifest 标记 `sourceDirty: true`，且未签名；人工验收和发布签核仍未完成。

两次独立完整构建的产物大小均为 363,487,344 bytes，SHA-256 一致；归档内 9,593 个文件，版本 0.1.0，commit `94ae1404a7e462da9d972133338186c68187ea98`。候选产物位于 `dist/releases/microcode-desktop-v0.1.0-windows-x64-diagnostics-a.zip` 和 `dist/releases/microcode-desktop-v0.1.0-windows-x64-diagnostics-b.zip`。
