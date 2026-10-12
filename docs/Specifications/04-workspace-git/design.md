# Design: Workspace and Git

## 项目生命周期

通过 Electron 主进程受控目录选择器取得路径，由 backend 再次校验。最近项目仅保存路径和展示信息。切换项目前处理运行任务并释放旧 session 资源。

## Git 与变更审阅

扩展现有 `src/git/` 接口，返回稳定状态和 diff DTO，限制超大读取。UI Agent 应检查 T3Code changed-files/file-tree/diff 对应的实际页面组件，并将模式映射到 Microcode；在 Codex Desktop 风格工作台中用右侧可收起面板承载文件树与 diff，切换文件不丢失对话。所有写操作执行前重新验证仓库状态。

## 终端和风险

首发若包含终端，仅呈现 runtime 明确启动的受控任务输出；renderer 不得任意指定进程或参数。Windows 路径、UNC、符号链接、ignore 与超大 diff 需真实环境验证。工作区根约束不能替代操作系统权限。
