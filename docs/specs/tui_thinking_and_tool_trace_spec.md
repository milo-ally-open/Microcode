# TUI 思维状态与工具轨迹呈现规范

**状态：**已实现初版，持续按实际使用反馈调整

**范围：**`src/tui/` 与 `src/tools/*/UI.tsx` 中的终端消息、思维状态和工具调用展示
**目标：**让 Microcode 的工作过程易读、可追踪、可打断，同时避免把整段原始思维内容和工具输出持续铺满终端。

## 1. 调研结论

### Claude Code

- 默认交互聚焦当前会话；`Esc` 可中断当前回复或工具调用，也可关闭对话框。
- `Ctrl+O` 打开/关闭 transcript viewer。该视图展示更详细的工具使用和执行信息、时间戳及每条 assistant 消息所用模型；一些默认折叠的信息会在该视图中展开。Claude Code 文档举例说明重复 MCP 调用可以在常规视图中合并成一行。
- 官方文档把 transcript viewer 定义为详细活动的查看入口，而不是要求主对话始终展开所有底层细节。

### Codex CLI

- 官方 CLI 文档强调在同一个终端工作循环中观察命令和 diff、继续引导正在进行的工作；输入区支持 `Esc` 中断/编辑、`Enter` 注入当前轮指令、`Tab` 排队后续输入。
- Codex CLI 的 TUI 文档说明 fenced Markdown 代码块和文件 diff 会做语法高亮；其命令参考也把 `/copy`、`/raw` 等能力作为查看和复制输出的独立操作。
- 公开的 CLI 文档没有承诺展示模型的原始思维链。OpenAI 对 reasoning tokens 的说明指出原始 reasoning 不通过 API 暴露；reasoning summary 是可选输出，并需要显式选择。

### 对 Microcode 的启示

参考两类 CLI 的共同点：主时间线突出用户消息、最终答复、正在执行的动作和结果；详细轨迹作为按需查看的信息。思维链的 UI 应显示“正在分析/执行”等安全状态或模型明确提供的摘要，不应将 provider 的内部 reasoning 内容当作通用、稳定、可公开的文本格式。

## 2. 当前实现与已知边界

当前代码的事实依据：

- `AssistantMessageComponent.updateContent()` 只将普通 assistant text block 放入可见 transcript；thinking block 正文不会显示，也不会生成 `Analyzing…` 或 `Analysis complete` 历史行（`src/tui/components/assistantMessage.ts`）。
- `App.setupAgentSubscription()` 消费 Agent、assistant message、tool lifecycle、turn end 等事件；工具调用按 `toolCallId` 跟踪，活动标签写入当前 turn timeline 的单一活动行（`src/tui/app.ts`、`src/tui/components/turnTimeline.ts`）。
- `transitionAgentActivity()` 将 provider-neutral 事件折叠为 idle、thinking、preparing-tool、running-tool(s)、responding 状态；状态仅用于 TUI 活动行，耗时由 App 单独呈现（`src/tui/agentActivity.ts`、`src/tui/app.ts`）。
- 转换会参考当前状态：idle 只接受新一轮的 thinking，不接受迟到的工具/消息事件；工具或回答阶段不会被迟到的 thinking 事件回退。真实的 responding → preparing-tool 工具交接仍然有效。重复的当前状态事件保持幂等。
- Agent 事件目前没有跨 turn 的 generation/sequence 标识。因此，状态机能拒绝不符合当前阶段的事件并抑制常见重复事件，但无法仅凭事件内容识别一个与新 turn 状态同样合法的、跨 turn 延迟事件；若订阅层未来引入异步/乱序投递，应由事件层补充 turn 标识或序号。
- 规范后续章节描述的是目标交互和验收方向；它们不应被误读为当前全部已实现。工具详情、工作段归属和详情浏览能力须以对应组件与 App 的实际代码为准。

本规范只要求改造 TUI。若某一模型/供应商不提供安全的进度摘要，界面显示确定性的状态标签即可；不能要求模型额外输出隐藏 reasoning，也不通过修改 Agent prompt 来伪造它。

## 3. 设计原则

1. **区分思维状态与思维内容。** 思维状态是诸如“分析中”“调用工具”“等待结果”的可公开进度；原始思维文本不是状态标签。
2. **默认简洁，细节按需展开。** 时间线默认显示摘要行，工具参数和完整结果可以通过快捷键或明确的展开操作查看。
3. **保留真实顺序和状态。** 工具调用按实际事件顺序显示；状态来自事件，不根据模型文本推测。
4. **流式界面稳定。** 增量更新尽量刷新当前活动行/卡片，不反复销毁整段 transcript，也不在模型和工具交接时闪烁“已完成”。
5. **用连续的时间线连接一轮工作。** 有工具调用时，思维状态、工具调用和最终回答挂在同一条纵向轨道上；普通对话不显示轨道。
6. **适配终端。** 状态不能只依赖颜色或特殊 Unicode 字符；窄终端中摘要应截断而不是撑破布局。
7. **保留原始对话语义。** 视图折叠只改变呈现，不删除 session 消息，不改工具参数或返回值。
8. **避免整块状态底色。** 用户消息、工具调用和结果使用紧凑行显示；状态由符号和文字表达，默认文本为白色，轨道使用中性色。
9. **权限审批不改写聊天区域高度。** 审批选项作为覆盖层呈现，关闭后保留原有消息位置，不把审批提示和结果追加进对话记录。

## 4. 目标交互

### 4.1 一轮工作过程

每个 user turn 在视觉上形成连贯的工作段，按发生顺序包含：

```text
› 修复登录回调并运行相关检查
│
├─ • 正在分析 · 1.2s
│
├─ Read   src/auth/callback.ts                 完成 · 36ms
│
├─ Edit   src/auth/callback.ts                 修改 2 处 · 完成 · 81ms
│
├─ Bash   bun test tests/auth                  运行中 · 4.3s
│
├─ • 正在整理结果…
│
└─ • 登录回调现在会校验 state，并覆盖成功与失败分支……
```

以上是建议展示样式示例，不是新增 Agent 行为。只有当底层事件足以确认状态时才展示对应内容。

用户消息是时间线的起点；后续每个状态、工具调用和最终答复沿同一条纵向连接线排列。中间项目使用 `├─`，当前工作段的最后一项使用 `└─`；竖线 `│` 在各项之间延续，使整轮过程视觉上成为一条连贯轨迹。轨道仅是展示结构，不表示调用之间存在因果关系。

工作段应能辨认轮次边界，但不能把多个并行工具伪装成串行：可按启动顺序列出，同时分别维护运行状态；若底层事件能确认并行关系，可在共用时间线下并列/缩进呈现并行调用，同时保留各自状态。不能确认并行关系时，按事件顺序列出，不推断依赖。本阶段不增加 Swarm/多 Agent 视图。

长文本换行时，续行需缩进到项目文本起始列，不能与连接线或下一个项目混在一起。窄终端应优先缩短摘要并保留关键状态；连接符不可用或终端字符宽度异常时，退化为缩进与状态标签仍可读的列表。详细视图切换和折叠工具详情时，轨道应保持稳定，不因展开输出改变轮次归属。

### 4.2 思维状态和 thinking block

- 所有 provider 统一使用有限状态机，不读取 reasoning/thinking 正文或 provider 专属摘要字段。
- 状态只由可观察的 Agent/工具事件驱动：`Analyzing…`、`Preparing tool call…`、`Running <tool>…`、`Running tools…`、`Responding…` 和空闲。
- 工具完成后若模型仍在工作则回到 `Analyzing…`；turn 结束或中断时清除活动行。活动行原位更新并带已处理时长，不进入 transcript 或 session 持久化。
- assistant transcript 只渲染普通 text block；thinking block 继续留在 Agent/provider 消息上下文中供模型协议处理，但不创建 `Analyzing…` 或 `Analysis complete` 历史行。
- 工具开始时显示真实工具卡片，并由工具状态更新活动行；工具结束后回到分析状态。最终回答开始时切换为 Responding，turn 结束时清理活动行。
- 中断时明确显示 `已中断`，不将未完成的 reasoning block 当成最终答复。

### 4.3 工具调用行和详情

折叠行提供：状态图标/文字、工具名、短参数摘要、耗时或运行时长、简短结果摘要。常见摘要优先显示路径、命令、查询关键字、变更文件数或错误概要；未知工具使用通用安全格式。

展开详情可包含：格式化后的完整参数、流式状态/进度、完整 text result、错误内容和已有的结构化详情（例如 diff）。渲染长结果时应有合理的高度上限/分页或滚动策略，不能一次把无限输出注入主视图。

调用中参数可能尚未完整。未完成的参数应标成“准备调用”或同等状态；执行结束前不能显示成功标记。错误与取消状态应明确区分。工具结果如果没有文本，使用组件已有的 details 或简洁的“无文本输出”状态。

重复且没有额外诊断价值的调用允许在默认视图中折叠/聚合，但详情视图必须能逐条检查每次调用的 ID、参数、状态和结果。聚合不能遮盖失败、权限交互、取消、不同参数或顺序差异。

### 4.4 详情浏览和快捷键

建议沿用 Claude Code 的“主视图轻量、transcript 细节可切换”思路，并保持 Microcode 现有按键习惯：

- `Ctrl+O`：在主对话精简视图与详细轨迹视图间切换（若与现有快捷键冲突，实施时优先检查 `src/tui/app.ts` 的键盘路由，并在 spec 更新中说明替代键）。
- `Enter`：展开/折叠当前选中的工具行；若 pi-tui 的滚动容器无法稳定提供行选择，则先采用统一的“展开本轮工具详情”操作，不应做脆弱的鼠标/光标猜测。
- `Esc`：先关闭轨迹详情/折叠状态，再按现有优先级中断正在运行的请求或关闭其它弹层；不得吞掉中断键。
- 展开和切换视图不能让输入框丢失文本、焦点或光标位置。
- 最近活动和正在运行的工具应易于定位；后台滚动时不可强制跳回底部，除非用户此前就在底部跟随输出。

这里的键位是提案。实施前需核对 TUI 当前的输入、滚动和快捷键分派能力；能力不足时先采用最低复杂度、可访问的全局视图开关。

## 5. TUI 内部呈现模型

此节定义 UI 组件可以采用的 view model，不要求改 Agent event schema 或 session 格式：

```ts
type TurnPresentation = {
  turnId: string
  activity?: { source: string; phase: 'thinking' | 'responding'; text?: string }
  items: Array<
    | { kind: 'assistant-text'; messageId: string; text: string; streaming: boolean }
    | { kind: 'tool'; toolCallId: string; name: string; args: unknown;
        state: 'preparing' | 'running' | 'success' | 'error' | 'cancelled';
        result?: unknown; elapsedMs?: number }
    | { kind: 'turn-status'; state: 'working' | 'interrupted' | 'error' | 'complete' }
  >
}
```

view model 必须由 TUI 收到的 agent events 与可读的 message state 派生。有限状态机状态只存在于临时 UI 字段，不加入 `items` 或 session messages。事件缺字段时显示“未知/运行中”，不要推断成功。`toolCallId` 是工具调用匹配键；工具事件更新原行而不是追加重复行。结构可以按现有 `Container`/组件能力简化，但不得将显示用状态写回会话消息。

## 6. 文件边界与预计修改面

实现呈现改造，预计涉及：

- `components/assistantMessage.ts`：assistant 文本与 thinking-status 的视图组装。
- `src/tui/agentActivity.ts`：将 Agent/工具生命周期事件映射到统一有限状态与标签。
- `components/turnTimeline.ts`、`app.ts`：将状态更新到单一活动行，按工具/回答/结束生命周期替换或清理。
- `components/toolExecution.ts`：摘要/详情两种视图、参数与结果的安全截断、清晰状态。
- `app.ts`：按事件更新工具行和工作段；提供视图开关、键盘焦点和滚动行为。
- `theme.ts`、`toolPresentation.ts`：必要的状态样式和文本摘要辅助。

不改 provider 协议实现、session schema、prompt、工具实现或依赖。状态机仅位于 TUI 层。用户消息、slash 命令、权限确认、认证交互、取消流程须保持正常工作。

## 7. 验收标准

- 一般对话默认不显示原始 thinking 文本；用户能区分“仍在分析”“正在运行工具”“已完成”“已中断”和“失败”。
- 所有 provider 均通过相同的有限状态机显示分析、工具准备、工具执行和回答状态；活动行带已处理时长，不展示 thinking block 正文。
- 多个 reasoning block 或多次模型调用只更新同一活动行，不产生重复 `Analysis complete` / `Analyzing…` transcript 项；活动更新不写入 session。
- 每个 user turn 的思维状态、工具调用和最终答复由一条连续纵向时间线连接；换行、展开工具详情和窄终端布局不会破坏归属关系或可读性。
- 详细轨迹开关能查看同一轮的完整工具顺序，工具参数、部分输出和最终输出能匹配到正确 `toolCallId`。
- 长参数、换行命令、大型工具输出、空输出、工具报错、工具取消及多个未完成工具不会撑破布局或导致错误状态。
- 流式工具参数与 `tool_execution_start/update/end` 事件更新同一条目，不出现重复卡片；model-to-tool 交接没有虚假的 completed 闪烁。
- 折叠/展开不影响发送输入、Esc 中断、session 持久化、工具执行和输出内容。
- 窄终端下仍可阅读；色彩缺失时状态文字也足以传达含义；长内容有界且可继续查看。
- 改动限定在 `src/tui/`；本轮规格先行阶段不实现代码、不运行测试或构建。

## 8. 参考资料

以下资料在 **2026-09-27** 查阅；产品界面会演进，正式实现前请重新核对快捷键和文档。

- Anthropic, [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode)：`Esc` 行为、`Ctrl+O` transcript viewer、详细工具执行和默认折叠/展开行为。
- Anthropic, [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)：`--verbose` 的 turn-by-turn 输出行为及 CLI 模式说明。
- OpenAI, [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)：终端工作循环、正在进行时查看命令和 diff、快捷操作入口。
- OpenAI, [Codex CLI customization](https://learn.chatgpt.com/docs/cli-customization)：TUI 的代码块/diff 高亮、主题和 prompt editor。
- OpenAI, [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)：Codex CLI 的快捷键、slash commands、`/copy` 和 `/raw`。
- OpenAI, [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)：reasoning tokens、reasoning summary 的选择机制；raw reasoning 不通过 API 以可读文本返回。
