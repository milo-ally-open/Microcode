# Tasks: Shared Runtime

- [x] 盘点 TUI 启动依赖，记录 Agent/session/plugin/MCP/tool/permission 生命周期。
- [x] 评审 runtime 命令、事件、快照和版本契约。
- [x] 明确 Runtime、MicrocodeAgent/harness、Model Layer 的逻辑所有权。
- [x] 提取 composition root 与 resource lifecycle，不改变已有行为。
- [x] 实现项目/session 打开、prompt、取消、审批响应和关闭 API。
- [x] 将现有 TUI 迁移为 runtime adapter，删除重复的 Agent 组装。
- [x] 增加事件顺序、断连快照恢复、资源清理和协议错误测试。
- [x] 运行相关测试、类型检查并验证 CLI/TUI 启动及任务流程。
- [x] 为 Desktop 和 ACP adapter 记录接口示例与错误语义。
