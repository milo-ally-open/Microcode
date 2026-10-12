# Workspace and Git Specification

## ADDED Requirements

### Requirement: 安全打开和切换项目
用户 MUST 能通过系统目录选择器选择项目。backend MUST 验证路径存在且为目录，并将路径绑定到 runtime session。renderer MUST NOT 通过任意路径直接读写文件。

#### Scenario: 打开有效项目
- **Given** 用户选择有效项目目录
- **When** runtime 打开项目
- **Then** 以该目录为项目根并加载适用项目指令
- **And** UI 显示项目名称与路径

#### Scenario: 最近项目路径失效
- **Given** 最近项目记录指向不存在或无权访问目录
- **When** 用户尝试打开
- **Then** UI 显示错误并允许重新选择
- **And** 不启动该目录下的 Agent 操作

### Requirement: 变更可在上下文中审阅
用户 MUST 能看到新增、修改、删除和重命名文件，并查看 backend 提供的 diff。二进制或超大文件 MUST 显示不能完整呈现的说明。

#### Scenario: 查看工作区改动
- **Given** 项目有未提交变更
- **When** 用户打开 Codex 风格右侧变更面板
- **Then** 文件树显示状态并可查看文本 diff
- **And** 中间对话上下文保持可见

### Requirement: Git 操作遵循既有安全语义
Git 操作 MUST 调用内核或现有 Git service，遵循仓库检测、确认和错误处理。renderer MUST NOT 拼接 shell 命令。

#### Scenario: Git 操作失败
- **Given** 仓库状态改变或操作无法安全执行
- **When** 用户发起 Git 工作流
- **Then** UI 显示明确失败并保留可恢复状态
- **And** 不报告成功
