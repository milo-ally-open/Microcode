# Proposal: Models, Integrations, and Settings

## Why

桌面用户需要检查模型、认证和 MCP/插件等集成。Microcode 已有这些核心能力；桌面设置应呈现真实状态并复用安全存储，避免第二套凭据实现。

## What Changes

- 展示模型清单、当前选择、可用性和切换结果。
- 展示认证方式/状态及已有登录/退出流程结果，不暴露 secret。
- 接入 MCP、插件和 skills 的发现、启用及错误状态。
- 明确配置生效范围和是否需要刷新 session。

## Capabilities

- `model-settings`: 浏览和选择模型。
- `credential-status`: 查看认证状态和结果。
- `extensions-settings`: 管理 MCP/插件/skills。

## Impact

依赖 runtime 与 desktop bridge；复用 `src/models/`、`src/mcp/`、`src/plugins/`、keyring 及现有配置。
