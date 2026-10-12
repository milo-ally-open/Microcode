# Design: Models, Integrations, and Settings

## 状态来源

model/provider/auth/MCP/plugin manager 是权威来源。runtime 暴露查询和受控命令；renderer 不维护第二份配置数据库。配置更新由 backend schema validation。

## 凭据与扩展

凭据继续使用现有 auth/keyring 流程。OAuth 由 backend 调用系统浏览器并处理回调；API key、一次性代码等输入留在受信任的原生对话框和 backend 内，renderer 只显示等待、成功、取消和错误。当前 Windows 桌面目标使用 WinForms 原生输入框；其他平台暂不提供交互式 provider 登录。日志及事件不得含秘密或敏感授权参数。MCP/插件优先接入现有发现、验证和启停 API；command/env 等高影响配置需确认并脱敏。

## 生效范围

继续遵守用户级和项目级配置优先级。需重建 Agent/session 时，由 runtime 返回影响范围，UI 不自行推断。T3Code 只供桌面设置交互参考，不作为 Microcode provider/config 行为来源。

## 桌面交互参考与映射

参考了 T3Code 的 [ProviderSettingsPanel](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/settings/ProviderSettingsPanel.tsx) 和 [ProviderInstanceCard](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/settings/ProviderInstanceCard.tsx)：先给出 provider 清单和可读状态，再在对应 provider 行上放置配置操作；模型选择保持为独立且可聚焦的列表。Microcode 将这些交互映射到自有深色工作区：一个设置窗口包含 Models、Providers & auth、MCP servers、Plugins、Skills 五个分区；状态标签来自现有 manager/runtime 快照，按钮操作只在 backend 返回新快照后提交，并在成功后显示生效范围。命令型 MCP/plugin 启用前展示脱敏命令并要求确认。没有复用 T3Code 的品牌素材、配置格式或 provider 逻辑。
