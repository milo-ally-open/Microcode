# Models, Integrations, and Settings Specification

## ADDED Requirements

### Requirement: 模型界面反映 runtime 状态
桌面端 MUST 显示 runtime 可用模型和当前选择，并通过 runtime 切换。只有收到成功确认后才能更新当前模型。

#### Scenario: 切换模型
- **Given** runtime 返回多个可用模型
- **When** 用户选择另一个模型
- **Then** runtime 执行切换并确认后更新 UI

#### Scenario: 模型不可用
- **Given** 凭据缺失或 provider 不可访问
- **When** 用户选择该模型
- **Then** UI 显示原因和设置入口
- **And** 当前模型保持不变

### Requirement: 凭据状态可见而秘密不可读
UI MUST 展示认证状态和登录结果；secret MUST 由现有 keyring/config 流程持有，不能返回或缓存到 renderer，也不能写入日志。

#### Scenario: Provider 登录完成
- **Given** 用户启动现有 provider 登录流程
- **When** 授权成功、失败或取消
- **Then** backend 返回状态摘要
- **And** renderer 不接收 access token、refresh token 或 API key

### Requirement: 集成管理沿用现有 manager
MCP、插件和 skills 清单/启用状态 MUST 来自现有 manager。配置错误须显示诊断和真实生效状态；不得只更新 UI 本地状态。

#### Scenario: 启用扩展
- **Given** manager 列出一个可启用扩展
- **When** 用户启用
- **Then** runtime 校验配置并返回实际状态
- **And** 无效扩展不会显示为启用
