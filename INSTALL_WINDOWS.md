# Windows 安装包

本文说明如何从源码生成 Microcode 的 Windows 安装包。请在 Windows x64 环境中，从项目根目录执行命令。

## 前置条件

- 安装并使用项目要求的 Bun **1.3.14**。构建脚本会检查 Bun 版本。
- 已检出项目源码，并能访问网络，以便首次构建时下载锁定版本的打包工具链。

## 生成安装包

在项目根目录打开 PowerShell，运行：

```powershell
bun --version
bun install --frozen-lockfile
bun run desktop:release:windows
```

构建会执行类型检查、测试、生产构建，以及打包后的后端和安装、升级、卸载检查。任一检查失败时，构建会报错并清理临时目录。

## 输出文件

成功后，默认生成以下两个文件：

```text
dist\releases\microcode-desktop-v0.1.0-windows-x64-setup.exe
dist\releases\microcode-desktop-v0.1.0-windows-x64-setup.exe.sha256
```

双击 `*-setup.exe` 启动安装向导。向导支持选择安装位置，并按当前用户安装。安装包目前未签名，Windows 可能显示 SmartScreen 提示。

## 删除 `dist` 后重新构建

删除整个 `dist` 不会删除项目源码或当前安装的 Bun。再次运行构建命令时，脚本会重新创建 `dist`，并在 `dist\toolchain\desktop-windows-x64\` 下载和缓存打包所需的 Electron、Bun Windows 运行时、PortableGit 和 NSIS。首次重建需要网络，后续构建会复用该缓存。

这里下载的 Bun Windows 运行时是随 Microcode 应用打包的组件，构建不会安装、升级或替换你用于运行命令的 Bun。

构建成功或失败后，候选包和验证目录会自动清理。工具链缓存与最终发布文件会保留在 `dist` 中。
