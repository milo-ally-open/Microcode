# Packaging and Release Specification

## ADDED Requirements

### Requirement: 安装包包含完整可运行应用
首发产物 MUST 包含 renderer、Electron 主进程、兼容版本 Bun backend 和所需资源。干净 Windows x64 环境安装后 MUST 可启动并完成项目对话冒烟。

#### Scenario: 干净环境安装启动
- **Given** 满足系统要求且未安装开发工具的 Windows x64 设备
- **When** 用户安装并启动发布包
- **Then** 应用启动 backend 并显示工作台
- **And** 用户可打开项目并完成模型请求或收到明确错误

### Requirement: UI/backend 协议版本兼容
Desktop 与 backend MUST 使用同版或声明兼容范围。不兼容时必须阻止 Agent 操作并显示修复路径。

#### Scenario: 版本不兼容
- **Given** renderer 与 backend 协议不兼容
- **When** 应用启动
- **Then** 应用报告冲突并拒绝启动 Agent 操作

### Requirement: 发布有可追踪验证
候选发布 MUST 记录版本、commit、平台和测试结果，通过测试、构建及安装冒烟；日志不得泄漏 provider secrets。

#### Scenario: 发布检查失败
- **Given** 测试或安装冒烟失败
- **When** 发布流程运行
- **Then** 候选版本标记失败且不得发布
