# Proposal: Workspace and Git

## Why

编码 Agent 必须绑定到明确项目，并让用户看见代码发生了什么变化。桌面端需要项目选择、Git 状态和变更审阅，同时限制 renderer 的文件和命令访问。

## What Changes

- 通过系统目录选择器打开项目并显示最近项目。
- 展示 Git 状态、变更文件和 diff。
- 接入已有 Git/worktree 能力并保留安全确认。
- 将变更审阅放入 Codex Desktop 风格工作台的右侧面板。

## Capabilities

- `project-workspace`: 选择、打开和切换项目。
- `change-review`: 文件树与 diff。
- `git-workflows`: 状态、分支及现有 Git 工作流。

## Impact

依赖 runtime 和 desktop bridge，复用 `src/git/`、项目指令及 worktree 能力。renderer 不执行 shell/Git。
