# 正式版准备审计与整改规范

**状态：**已实施，验证待执行
**范围：**CLI/TUI 发布流程、项目指令与 `/init` 安全边界、明确未使用的旧代码
**目标：**修复本轮静态审计确认的发布阻断风险，并为后续跨平台桌面应用保留清楚的运行时边界。

## 1. 审计确认

本轮只读审计检查了仓库入口、`package.json`、Bun 编译/安装脚本、CLI 打包脚本、项目指令加载器、`/init` 与 `/instructions` 命令，以及模型配置 facade 的引用点。未运行测试或构建。

### 1.1 正式发布风险

1. `build.ts` 启动编译子进程后没有检查退出码；只要 `dist/microcode[.exe]` 中残留旧文件，失败的本次编译也会通过“输出存在”检查，并可能把旧二进制安装出去。编译器 stderr 同时未被消费，输出量较大时子进程可能阻塞。
2. Windows 上 `build.ts` 安装到 `%LOCALAPPDATA%\microcode\microcode.exe`，而 CLI 包的 `install.cmd` 安装到 `%LOCALAPPDATA%\microcode\bin\microcode.exe`。同一项目的两种安装方式产生不同的 PATH 位置。
3. `build.ts` 先删除现有安装文件再复制新二进制。复制失败会丢失可用的旧安装。
4. CLI `--help` 把自定义模型配置格式指向仓库中不存在的 `CLAUDE.md`；实际配置说明位于 `README.md`。

### 1.2 `/init` 与指令刷新

1. `/init` 通过常规 Agent prompt 执行；提示词要求模型只写 `MICRO.md`，但 Agent 仍拥有 Bash、Edit、Write 等完整工具。因此目标文件限制目前不是运行时代码边界。
2. `/instructions` 只显示 Agent 启动时缓存的文件列表。用户在会话中修改 `AGENTS.md`、`CLAUDE.md` 或 `MICRO.md` 后没有独立重载入口；重新运行 `/init` 会额外发起模型请求。

### 1.3 旧代码

1. `src/config.ts` 是标记为 deprecated 的模型配置 facade；源码运行路径没有导入它，只有 `tests/models/config.test.ts` 依赖。包是 private，没有声明该 facade 为公开 API。应将测试改为直接覆盖 `src/models/` 当前 API 并删除 facade，避免保留只供自身旧调用方式使用的兼容层。
2. `packaging/lib.ts` 导出的 `copyDir` 在仓库内没有调用点，应删除。

## 2. 实施要求

### 2.1 构建和安装

- 编译步骤必须同时收集 stdout/stderr，并检查实际退出码；任何非零退出都立即失败，不能进入输出检查或安装步骤。
- 进度轮询在所有成功/失败路径中都必须清理。
- 在替换安装二进制前先复制到同目录临时文件并设置可执行权限，然后以 rename 完成替换；失败时保留原安装并清理临时文件。
- Windows build 安装目录统一使用 `%LOCALAPPDATA%\microcode\bin`，与打包安装脚本和文档一致。
- Windows PATH 提示按大小写不敏感方式检查已有目录。

### 2.2 项目指令与 `/init`

- `/instructions` 支持 `reload` 参数；重新发现适用的指令文件、更新 Agent 与压缩所用 system prompt，并报告加载结果/诊断。无参数时继续只读显示缓存状态。
- `/init` 的模型分析阶段只能使用受限的只读文件读取工具，不得调用 Bash、Edit、Write、MCP 或其他可能产生副作用的工具。读取路径必须在当前项目目录内，并拒绝符号链接逃逸、VCS/依赖/构建目录、环境文件和凭证路径；项目文件清单限制深度并跳过依赖/构建目录与符号链接。
- 模型输出完整的 MICRO.md 草案，由 TUI 展示并通过明确的“应用/取消”选择获取用户同意。只有用户选择应用后，应用层才写入当前工作目录下的 `MICRO.md`。
- 保存必须校验工作目录的原文件快照未在分析期间变化。新文件使用独占创建；已存在文件只在快照一致时更新。拒绝、取消、冲突或写入失败时不得报告成功，也不得修改 `AGENTS.md`、`CLAUDE.md` 或其他路径。
- `/init` 提案不得超过单文件和合并后的 32 KiB 指令预算；保存后验证完整文件确实进入 Agent 与 compaction prompt。
- 写入成功后重新加载指令并更新当前 Agent/system prompt；取消时保留旧 prompt 和文件。

### 2.3 旧代码清理

- 删除未被应用运行时使用、包也未公开的 `src/config.ts` 兼容 facade。
- 将对应测试改为使用 `src/models/registry.ts` 的正式 API，保留模型发现、选择、配置解析和 key 解析行为的断言。
- 删除无调用点的 `packaging/lib.ts` `copyDir` helper。
- 将 CLI 配置说明链接从不存在的 `CLAUDE.md` 改为 `README.md`。
- 不删除 `src/config/` 目录中的项目配置写入实现；该模块与旧模型 facade 职责不同且有实际调用方。

## 3. 架构边界与后续桌面化

- 保留 CLI/TUI 作为当前产品运行时，不新增 GUI，不把 TUI 依赖引入 Agent、模型、session 或权限领域模块。
- 项目指令发现/持久化属于应用服务能力；TUI 负责展示草案与确认，Agent 只在只读范围内分析，最终写入边界由应用代码执行。
- 平台差异留在 build/package 与具体系统集成边界；本次只统一已经确认的 Windows 安装路径，不声称完成 Linux/macOS 打包验证或桌面签名/安装器设计。

## 4. 验收标准

- 编译失败时 build 流程非零退出，不检查/安装残留二进制；stdout、stderr 均持续消费，spinner 总会停止，并显示编译诊断。
- 安装新二进制失败时已有安装保持可用；Windows build 与 package installer 指向同一 bin 目录。
- `/init` 执行时 Agent 工具快照只包含受限的 `read` 工具；草案由 TUI 明确确认后才写入 `MICRO.md`。
- 新建与更新 MICRO.md 都能检测并发修改；取消和冲突保持文件原样；成功后重新加载 prompt。
- `/instructions reload` 更新文件集合、内容、诊断以及 compaction prompt；无参数命令不触发磁盘重载。
- 删除旧 facade 和无调用 helper 后，源码不再引用旧 API；测试保留当前 registry 能力断言。
- 不修改生成目录，不运行构建/测试。提交前仅做只读静态检查和 diff 检查，并如实报告未执行的验证。

## 5. 明确不在本次范围

- 全仓库格式化、目录重排、TUI 重写、桌面 GUI/框架迁移。
- 新增外部依赖、安装器、自动更新、代码签名、应用沙箱或跨平台 CI 矩阵。
- 改变工具权限模式的现有全局语义；`/init` 的隔离只在该命令的分析生命周期内生效。
- 对所有源码做自动 tree-shaking 式死代码删除；本次只清理有明确静态证据且能确认非公开的旧代码。
