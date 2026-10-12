# Design: Packaging and Release

## 构建产物

锁定依赖与 Electron/Bun/runtime protocol 版本。产物记录平台、架构、版本、commit、协议版本和校验信息。必须在目标 Windows 环境验证 backend，不能以开发机可启动代替。

## 安装与数据

安装器明确安装范围。设置、项目记录、凭据保留各自存储路径。卸载说明用户数据是否保留；升级不得静默删除 session、配置或日志。自动更新另行决策。

## 发布门槛和风险

CI 运行类型检查、测试、生产构建和产物检查；候选包在干净 Windows 环境验证安装、启动、sidecar 通信、退出、覆盖升级和卸载。检查 native keyring、路径空格、权限、sidecar 孤儿进程及日志脱敏。macOS/Linux 不在首发承诺范围，除非产品范围另行扩展。
