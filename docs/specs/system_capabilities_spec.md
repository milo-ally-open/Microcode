# Microcode System Capabilities 规范

**状态：** Proposed；架构规范，分阶段实现

**版本：** 0.1

**范围：** System、user、project 三种基础 capability scope；Skill 与 standalone MCP 的发现、优先级、信任和来源元数据

**设计日期：** 2026-09-28

## 1. 目标与术语

Microcode MUST 将 Skill 与 standalone MCP 视为同一扩展体系中的两类 capability，并为它们提供一致的 scope、发现、来源标记和冲突处理规则。Skill 提供文件形式的工作流指引；MCP 提供连接到外部 server 的配置。Plugin 是组合、分发和启用 capability 的 packaging/source，不是第四种基础 scope。

本规范中的 **MUST**、**MUST NOT**、**SHOULD** 和 **MAY** 表示规范性要求。

基础 scope：

- **system**：随 Microcode 版本分发、由 Microcode 安装和管理的内置 capability。
- **user**：用户的全局 capability。
- **project**：当前项目的 capability。

其他来源元数据可包括 `plugin`、`path` 和 `legacy`。它们用于表达来源，不改变上述三个基础 scope 的含义。Plugin 是 package/source；plugin 内的 Skill 和 MCP 在 registry 中标记为 `plugin`，并带有 `pluginId`。

## 2. 目录与路径

令 `MICROCODE_HOME` 为用户 home 下的 `.microcode` 目录。正式路径如下：

| Capability | System | User | Project |
| --- | --- | --- | --- |
| Skill | `~/.microcode/skills/.system/` | `~/.microcode/skills/` | `<cwd>/.microcode/skills/` |
| MCP package | `~/.microcode/mcp/.system/` | `~/.microcode/mcp/` | `<cwd>/.microcode/mcp/` |
| Plugin | 不适用 | `~/.microcode/plugins/` | `<cwd>/.microcode/plugins/` |

Skill package 以 `<skill-name>/SKILL.md` 为入口；MCP package 以 `<package-name>/mcp.json` 为入口。MCP package 允许包含 README、脚本和其他配套资产。MCP package ID 与其中声明的 server ID 不要求相同，也不要求一一对应。

扫描 user 根目录时 MUST 排除其中的 `.system/` 子目录；system root 是独立来源，必须显式加载。项目目录下的 `skills/.system/` 和 `mcp/.system/` 没有 system 含义，MUST 忽略。递归扫描普通 capability 时 MUST 忽略隐藏目录；system loader 可显式读取 `.system/`。

## 3. System capabilities 管理与分发

`~/.microcode/<capability>/.system/` 是 Microcode-owned managed directory，不是用户 capability 目录的别名。其内容 MUST 来自 Microcode binary 随附的内嵌 assets；运行中的 binary MUST NOT 依赖源码 checkout 或安装包源码目录。

Microcode 启动早期 MUST 确保 system capability 已物化。安装器 MUST 根据内嵌内容计算稳定的 SHA-256 fingerprint，并与 `.system/.manifest.json` 中的 fingerprint 比较。manifest 至少包含：

```json
{
  "schemaVersion": 1,
  "managedBy": "microcode",
  "microcodeVersion": "0.2.0",
  "fingerprint": "sha256:...",
  "generatedAt": "2026-09-28T00:00:00Z"
}
```

fingerprint MUST 覆盖 capability 文件路径与内容，并采用确定性排序；文件元数据和 binary 版本号本身不得替代内容 fingerprint。fingerprint 相同时 SHOULD 跳过写入。不同或 marker 无效时，安装器 MUST 在同一文件系统的 staging directory 中构建完整新树，再以原子方式替换 managed tree，并写入新 manifest。安装过程中断不得留下被 loader 当作完整版本使用的半成品。平台无法原子替换非空目录时，必须采用可恢复的备份/替换流程。

Microcode MAY 删除并重建 system tree；用户可以查看其中的文件，但 MUST NOT 将手工修改视为持久配置。Creator MUST NOT 把普通用户或项目 capability 写入 `.system/`。system tree 损坏或 marker 不兼容时，启动 MUST 尝试从内嵌 assets 重建；重建失败时必须给出诊断，且不得把损坏内容报告为成功安装。

第一批 system Skills 为 `skill-creator`、`mcp-creator` 和 `plugin-creator`。system MCP 目录和 manifest 协议从 v0.1 起定义，即使初始内嵌 MCP package 数量为零也适用。

## 4. Skill 发现、来源和优先级

Skill runtime 继续使用 file-backed `SKILL.md` contract。加载器 MUST 保留来源信息，至少定义：

```ts
export type CapabilityScope =
  | 'system'
  | 'user'
  | 'project'
  | 'plugin'
  | 'path'
  | 'legacy'

export type SkillScope = CapabilityScope

export interface Skill {
  name: string
  description: string
  filePath: string
  baseDir: string
  scope: SkillScope
  disableModelInvocation: boolean
  pluginId?: string
}
```

Skill loader MUST 显式发现 system、user、project 和调用方提供的额外 paths，再通过独立冲突解析步骤生成最终列表；不得依赖目录扫描调用顺序来定义优先级。建议接口继续接受 `cwd`、`skillPaths` 和 `includeDefaults`，并在加载默认来源时先确保 system Skills 已安装。

Skill name 是全局唯一的运行时 ID。system Skill 名称是保留 ID：与之同名的 user、project 或额外 path Skill MUST 被忽略，system Skill MUST 获胜，并产生清楚的诊断，例如：

```text
Skill "skill-creator" conflicts with reserved system skill; user skill ignored.
```

对于非保留 ID，普通优先级 MUST 为 `project > user`。本规范的明确额外 path 优先级为 `path > project > user`；同一优先级内按发现顺序保留首个条目。额外 paths 也不得覆盖 system 保留 ID。重复扫描同一个实际文件不得产生重复 Skill。Plugin Skills 仍使用 plugin namespace（如 `<plugin-id>:<skill-name>`）并保留 `pluginId`；它们不得冒充 system Skill。

## 5. MCP package 格式与来源元数据

Standalone MCP package 中的 `mcp.json` MUST 复用 Plugin 已有的 MCP JSON schema 和解析/验证路径：根对象包含 `mcpServers` object，其条目使用统一的 `McpServerConfig`。实现 MUST 复用等价于 `parseMcpJson()` 与 `validateMcpServerConfig()` 的公共逻辑，不得为 standalone MCP 发明另一种 schema。

package ID 表示目录 package；`mcpServers` 中每个 key 表示 server ID。一个 package MAY 声明多个 server，第一版 Creator MAY 默认生成一个 package 对应一个 server。

合并后不得仅返回 `Record<string, McpServerConfig>`。MCP registry 至少保留以下信息：

```ts
export type McpScope = CapabilityScope

export interface ResolvedMcpServer {
  name: string
  config: McpServerConfig
  scope: McpScope
  packageName?: string
  sourcePath?: string
  pluginId?: string
}
```

日志和诊断不得泄露 env、headers 或其他 secret 值。

## 6. MCP 发现、冲突和 legacy 兼容

MCP discovery 至少包含以下来源：system MCP packages、user MCP packages、user legacy config、project MCP packages、project legacy config，以及已启用 plugin 提供的 MCP。项目级 `.system/` 必须忽略。解析、验证、来源标记和冲突解析应是可辨认的阶段。

system MCP server ID 是保留 ID；同名 user、project、legacy 或 plugin server MUST 被忽略，且产生诊断。其余来源在同一 server ID 冲突时按以下优先级选择：

```text
project config.json.mcpServers
  > project mcp/<package>/mcp.json
  > user config.json.mcpServers
  > user mcp/<package>/mcp.json
```

Plugin server 按既有 plugin namespace/冲突规则保持隔离，不得借由 package ID 或 server ID 覆盖保留 system ID。所有冲突必须产生来源可读的诊断。

v0.1 MUST 保留 `~/.microcode/config.json` 与 `<cwd>/.microcode/config.json` 中的 `mcpServers` 兼容读取。legacy 来源标记为 `legacy`，在同一 scope 内高于该 scope 的目录 MCP；project 来源仍高于 user 来源。legacy `mcpServers` 在此迁移阶段继续保持现有连接行为；其弃用须另行定义。

## 7. MCP connection 与工具权限

Microcode 不提供 MCP trust/approval 状态或 trust 命令。发现并成功验证的 standalone system/user/project/legacy MCP MUST 自动连接；Plugin MCP MUST 在所属 Plugin 启用时自动连接，并在 Plugin 禁用时断开。配置无效、名称冲突或 Plugin 未启用的 server 不得连接，并应提供来源明确的诊断。

MCP connection 不授予工具调用权限。所有 MCP tool calls、资源读取和其他操作仍 MUST 经过现有 Microcode permission policy；连接 server 不得绕过 `PermissionManager` 或用户配置的 allow/ask/deny 规则。MCP server command、endpoint、scope 和来源路径应在 `/mcp` 状态列表中可见，敏感值仍须脱敏。

运行时重新发现 capability 时 MUST reconcile 所有 MCP 来源：新出现或配置变化的 server 应连接或替换；不再存在、Plugin 被禁用或与 reserved/system ID 冲突的 server 应断开并从 Agent runtime 移除 tools/resources。`/mcp` MUST 仅列出 MCP 状态，不接受子命令；展示前应触发该 reconcile。Plugin MCP 的启用和禁用操作 MUST 集中在 `/plugins`。

## 8. Creator 约定

三个 system Creator Skills 都 MUST 遵守相同 scope 默认值：未指定 scope 时写入 user scope；明确要求为当前项目创建时写入 project scope；任何 Creator 都不得将普通内容写入 system root。

Creator MUST 先读取当前 `<env>` 中的 operating system、shell、Microcode home 与 working directory，再决定文件路径和命令。路径 MUST 使用当前平台的路径规则；MUST NOT 假定用户运行 Linux、POSIX shell 或 Unix 路径。Skill 文本 SHOULD 用 “Microcode home 下的相对目录” 等跨平台表述，不应把 Unix home 缩写当成可直接执行的路径。环境信息缺失时，Creator MUST 先确定操作系统再构造路径。

- `skill-creator`：user 输出到 `~/.microcode/skills/<name>/`；project 输出到 `<cwd>/.microcode/skills/<name>/`。
- `mcp-creator`：user 输出到 `~/.microcode/mcp/<package>/mcp.json`；project 输出到 `<cwd>/.microcode/mcp/<package>/mcp.json`。先验证配置；有效配置发现后会自动连接，创建文件本身不代表连接已成功。
- `plugin-creator`：分别输出到 `~/.microcode/plugins/<plugin>/` 或 `<cwd>/.microcode/plugins/<plugin>/`，其中 package 内组件放在 `skills/` 与 plugin 根目录 `mcp.json`。它复用 skill-creator 与 mcp-creator 的内容和验证约定，但遵循 Plugin package 布局。

## 9. 统一 discovery pipeline

Skill、MCP 与 Plugin 应逐步收敛到清晰的能力发现流程：

```text
filesystem / embedded assets
  → discovery
  → validation
  → source metadata
  → collision resolution
  → source-specific enablement (Plugin MCP)
  → normalized registry
  → Agent runtime
```

实现可保留 `loadSkills()`、`loadMcpConfig()` 等现有入口作为兼容 façade；内部职责必须能明确区分。Capability registry 中的来源与路径元数据应足以支持 UI 显示 scope、package、来源路径和连接状态。

## 10. 实施阶段

此规范覆盖最终目标，实施按可独立 review 的阶段推进：

1. **System Skills 与 Skill precedence：**内嵌初始 system Skills、fingerprint/manifest 安装、system reserved names、`Skill.scope`、project > user。若分 PR，可先只带一个最小 system asset 验证 materialization 协议，再加入 Creator 内容。
2. **目录式 standalone MCP：**MCP packages、统一 parser、来源元数据、legacy 合并及 deterministic precedence；发现并验证有效配置后自动连接。
3. **MCP runtime：**发现配置后自动连接，并在配置变化或来源禁用时同步连接生命周期。
4. **Creator Skills：**发布 skill-creator、mcp-creator、plugin-creator，并让 Creator 按本规范写入目标 scope。

每一阶段 MUST 保持单 Agent 核心与 CLI/TUI runtime，不引入 GUI 或多 Agent orchestration；已有 `config.json.mcpServers` 行为在迁移期继续受支持。

## 11. 验收要求

实现本规范时至少验证：

- system assets 在 source/development 与编译 binary 的支持方式明确；binary 不依赖外部源码目录。
- 相同 fingerprint 不重写；assets 改变、marker 缺失/损坏或 managed tree 不完整时可恢复安装。
- Skill user 扫描跳过 `.system`；system Skill 显式加载；保留名不会被 user/project/path/plugin 覆盖；普通项目 Skill 覆盖 user Skill。
- Skill 与 MCP registry 返回正确 scope 和路径；MCP package 支持一对多 server。
- MCP 同 scope 内 config 优先目录 package，project 整体优先 user；system ID 保留。
- legacy config 仍可用；有效 standalone MCP 自动连接；enabled Plugin MCP 在 Plugin 启用期间连接，并在禁用时断开。
- 日志、诊断和 UI 不泄露 MCP secrets；MCP 连接不绕过工具调用权限。
