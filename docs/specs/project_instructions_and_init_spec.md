# 项目指令文件与 `/init` 规范

**状态：**已实现初版  
**范围：**项目级持久指令发现、系统提示词注入，以及 TUI `/init` 命令  
**目标：**让 Microcode 兼容读取项目中的 `AGENTS.md` 和 `CLAUDE.md`，并通过 `/init` 创建或改进 Microcode 自己的 `MICRO.md`。

## 1. 调研结论

### Codex

- Codex CLI 的 `/init` 在当前目录生成一个 `AGENTS.md` 脚手架，供用户检查、修改并提交；命令本身不是完整的项目扫描报告。[Codex CLI slash commands](https://developers.openai.com/codex/cli/slash-commands/)
- Codex 在会话启动时发现指令文件：先读全局 `~/.codex/AGENTS.override.md` 或 `AGENTS.md`，再从项目根目录到当前工作目录逐层查找。每层优先选择 override，其次 `AGENTS.md`，再检查配置的备用文件名；每层至多加载一个文件。内容按根目录到当前目录拼接，子目录内容靠后。[Codex `AGENTS.md` 指南](https://developers.openai.com/codex/guides/agents-md)
- Codex 文档说明默认合并上限为 32 KiB，并跳过空文件。项目指令用于行为指导，不替代工具权限设置。

### Claude Code

- Claude Code 的 `/init` 分析代码库并生成含构建命令、测试说明和项目约定的 `CLAUDE.md`。文件已存在时，它会建议改进，而不是直接覆盖。[Claude Code memory / `/init`](https://code.claude.com/docs/en/memory)
- Claude Code 会从当前目录及其祖先目录读取内存文件；嵌套子目录中的文件在访问相应目录时才加载。不同层级按根到当前目录顺序追加，而非相互覆盖。用户级 `~/.claude/CLAUDE.md` 也可以提供全局偏好。[Claude Code memory loading](https://code.claude.com/docs/en/memory)
- Claude Code 新版本可以读取 `AGENTS.md`。默认情况下，如果当前目录或祖先目录存在 `CLAUDE.md`、`.claude/CLAUDE.md` 或 `CLAUDE.local.md`，则优先走 Claude 文件路径；否则读取 `AGENTS.md`。也可通过设置选择只读一种或两种文件。[Claude Code `AGENTS.md` compatibility](https://code.claude.com/docs/en/memory#agents-md)
- Claude Code 支持 `@path` 导入、项目规则、个人/本地文件等更多能力。本规范不要求 Microcode 一次实现 Claude Code 的全部内存系统。

### 对 Microcode 的判断

两者的共同能力是：持久化项目指令、按工作目录选择适用范围、在每次模型工作时提供这些指令，并用 `/init` 根据仓库实际内容建立初稿。Microcode 当前已经组装 system prompt，但 `getSystemPrompt()` 不接收项目指令；当前 `/` 命令表和手写帮助列表也没有 `/init`。因此需要同时定义“怎样发现并加载文件”和“怎样生成/更新文件”，不能只加一个 slash 命令。

Microcode 的文件名约定与两个参考产品不同：加载器必须兼容 `AGENTS.md`、`CLAUDE.md`，同时原生读取 `MICRO.md`；`/init` 只能创建或更新当前目录下的 `MICRO.md`，不能创建、改写或覆盖另两种文件。

## 2. 目标行为

### 2.1 指令文件发现与加载

1. Microcode 启动交互会话时，以启动目录为工作目录；找到该目录所在的 Git 工作树根目录，按根目录到工作目录的顺序检查每一级。
2. 无 Git 根目录时，只检查启动目录。不得向工作目录下的所有子树递归加载指令，以免把无关子项目规则塞进上下文。
3. 每一级目录独立识别 `AGENTS.md`、`CLAUDE.md` 和 `MICRO.md`；如果同级多个文件存在，按 `AGENTS.md`、`CLAUDE.md`、`MICRO.md` 的固定顺序加载。它们都是实际指令文件，不隐式互相覆盖。根目录层先于更深层，越靠近工作目录的内容越靠后。
4. 空文件跳过，符号链接不作为指令文件读取。所有加载文件设一个合并字节上限（默认 32 KiB）；达到上限时按确定顺序截断后续加载，并通过 `/instructions` 显示哪些文件未加载/被截断。
5. v1 只读取文件正文，不展开 Claude 的 `@path` 导入语法，也不读取 `.claude/rules/`、`CLAUDE.local.md`、`AGENTS.override.md`、用户级或组织管理级指令。`/instructions` 应列出已加载文件和跳过/截断原因。
6. 以清楚的文件路径标题和边界将内容加入模型 system prompt。仓库指令不能覆盖 Microcode 的系统级约束、用户权限设置或安全限制；加载指令不能自动批准工具。
7. 新指令须进入常规 Agent prompt 构建路径，并与压缩时使用的 system prompt 保持一致。会话恢复也应重新发现当前文件，而不是依赖旧 session 中持久化的 system prompt。
8. 当前工作目录或指令文件内容变化后，Microcode 应提供刷新入口；至少 `/init` 成功后必须重载指令并更新 system prompt，使其在下一条用户消息开始前生效。

### 2.2 `/init` 交互

1. `/init` 是内置 slash 命令，出现在自动补全和 `/help` 中。它作用于当前工作目录，允许在仓库子目录创建对应范围的说明文件。
2. 使用单 Agent 分析当前仓库：读取 README、包清单、构建/测试配置、主要入口、顶层目录和少量代表性源码，归纳实际架构和约定。不得启动 swarm 或子 Agent。
3. 生成内容只写可从仓库证实且对后续工作有帮助的信息：项目用途、主要目录/入口、实际命令、代码约定、测试规范、重要边界。无法确认的信息标为待确认或省略，不得编造命令或架构结论。
4. 扫描是只读的；不得运行项目命令、安装依赖或遍历依赖缓存。忽略 `.git`、依赖目录、构建产物、二进制和凭证文件（例如 `.env`）。不得将密钥、令牌、个人机器路径或 session 内容写入指令文件。
5. `/init` 固定将 `MICRO.md` 作为唯一输出目标，不提供切换成 `AGENTS.md` 或 `CLAUDE.md` 的选项。即使目录中已有 `AGENTS.md` 或 `CLAUDE.md`，也只读取它们作为上下文，不修改它们。
6. `/init` 分析期间只开放受限的只读项目文件工具；模型不得写文件或运行 shell。应用展示拟生成内容，并通过 TUI 的明确“应用/取消”选择确认后，才写入 `MICRO.md`。
7. `MICRO.md` 已存在时不静默覆盖。先读取原文件并保留仍有效的约定；展示完整的新草案供审阅。保存前验证分析期间文件未变化；用户取消或检测到并发修改时保留原文件。
8. 保存成功后重载适用的指令文件并更新 Agent system prompt；`/instructions reload` 也可在外部编辑后单独刷新，不触发模型请求。
9. 分析、写入或重载失败时，保留现有文件，显示可操作错误；不可将部分生成内容静默当作成功。
10. 草案及所有先前指令文件必须能完整放入 32 KiB 合并上限；超出剩余预算时拒绝保存并提示缩短指令。

## 3. 生成内容约定

生成的项目指令应简短、可验证、维护成本低。建议包括：

- 项目是什么，以及重要入口/目录各自负责什么。
- 仓库中实际存在的开发、构建、测试、打包命令；只有配置文件证据明确时才列出。
- 仓库特有的代码组织和测试放置规则。
- 关键行为边界或容易误用的开发流程。
- 对命令的必要限制，例如生成文件、需真实服务或会访问外部系统。

不应复制完整 README、依赖清单、自动可推断的目录树或通用编程建议。控制文件长度，优先将长期有效的项目约定写入文件。

## 4. 实现落点

这是后续实现的模块边界，不预先规定具体类名：

- 新增 instruction discovery 模块：负责 Git 根目录/工作目录解析、候选文件读取、顺序、字节上限和来源诊断。
- 在启动流程创建 Agent 前发现项目指令，并把结果传入 prompt assembler；当前启动路径在 `src/main.tsx`，system prompt 组装在 `src/prompt/prompts.ts` 与 `src/agent/MicrocodeAgent.ts`。
- 提供运行期重载方法，使 `/init` 保存成功或 `/instructions reload` 后更新 system prompt 和 compaction 使用的 prompt。
- 在 `src/tui/app.ts` 的内置命令表、slash dispatcher 和手写 `/help` 列表注册 `/init`。
- 仓库测试放在 `tests/` 下，按本仓库约定不得将测试文件放入 `src/`。

## 5. 验收标准

- 启动时能按预期加载项目根目录至当前工作目录之间的 `AGENTS.md`、`CLAUDE.md`、`MICRO.md`，并按固定顺序呈现。
- 同目录两文件、空文件、无 Git 根目录、子目录指令、合并上限和读文件失败均有确定行为与测试。
- 项目指令进入首次模型请求、会话恢复和上下文压缩使用的 prompt；刷新后不会重复拼接旧内容。
- `/init` 无论 `AGENTS.md`、`CLAUDE.md` 是否存在，都只创建/更新 `MICRO.md`；现有文件不会被改写。
- 已有文件不会被静默覆盖；应用前在 TUI 显示完整差异，取消/拒绝保留原文件。
- 生成器不运行构建/测试命令、不访问忽略目录和凭证文件，不写入秘密或机器特定路径。
- 保存成功后新指令在当前 session 的下一条用户消息前生效；保存失败不会报告成功。
- `/init` 出现在补全与 `/help` 中，CLI 交互可取消且不会卡住 TUI。

## 6. 明确不在 v1 范围

- 完整兼容 Codex fallback filename 配置、`AGENTS.override.md`、Claude 的 `CLAUDE.local.md`、`.claude/rules/`、组织策略文件和按路径懒加载。
- 展开 Claude `@path` imports，或复现 Claude 对项目外导入的授权系统。
- 自动执行项目的 build/test/lint 命令，或替用户安装/配置开发环境。
- 自动生成子目录规则、MCP 配置、skills、hooks 或 Swarm/子 Agent。
- 将模型生成内容不经用户许可自动写入已存在的 `MICRO.md`。

## 7. 官方资料

- OpenAI Codex CLI `/init`：<https://developers.openai.com/codex/cli/slash-commands/>
- OpenAI Codex `AGENTS.md` 发现和合并规则：<https://developers.openai.com/codex/guides/agents-md>
- Anthropic Claude Code `/init` 与 memory 文件加载：<https://code.claude.com/docs/en/memory>
- Anthropic Claude Code 对 `AGENTS.md` 的支持与优先行为：<https://code.claude.com/docs/en/memory#agents-md>
