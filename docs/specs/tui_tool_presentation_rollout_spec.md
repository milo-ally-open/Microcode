# TUI Tool Presentation Rollout Specification

**Status:** Approved for implementation
**Scope:** User-facing TUI presentation for every built-in, deferred, and runtime-created tool
**Out of scope:** Tool schemas, execution, permissions, model-facing results, discovery, and AI-side truncation

## 1. Goal

Make tool activity readable and consistent in the transcript. Read, Bash, Edit, and Write already
have dedicated previews and are the reference behavior. Every other tool must either provide a
specialized view with the same preview affordance or use the shared generic tool view.

The user-facing view is a projection only. It must never rewrite tool arguments, tool results,
persisted messages, or content sent to the Agent.

## 2. Shared presentation contract

- Keep the tool name, concise identifying input, lifecycle status, elapsed time, and a short result
  summary visible in the compact row.
- Long or detailed result bodies start collapsed: zero body rows are rendered until the user
  expands the preview.
- When a preview exists, show `[Expand preview]` in the tool header row; while expanded, show
  `[Collapse preview]` in that same row. The action must be exposed as a semantic interaction
  target, not inferred by the transcript from its rendered label.
- Expansion is local to an individual tool invocation. It has no effect on tool execution or on
  any Agent-facing data.
- Expanded previews remain bounded and report omitted content when clipped. Partial streaming may
  update the summary, but must not flood the transcript with body output.
- Do not synthesize source line numbers for arbitrary command, web, MCP, or text output. Preserve
  useful domain locations already present in content. Bash remains verbatim and unnumbered.
- Errors use a concise summary in the collapsed row and expose the bounded full error detail only
  in the expanded preview.
- Empty/no-result outputs do not show a non-functional toggle.

## 3. Tool-specific presentation

| Tool family | Compact row | Expanded preview |
| --- | --- | --- |
| Glob | Pattern, file count, truncation and duration | Bounded matching paths from presentation details/result |
| Grep | Pattern, output mode, file/match counts, truncation and duration | Bounded match output, preserving the tool's existing file/line locations |
| WebSearch | Query, result count and duration | Bounded result entries (title, URL, snippet), with readable separation |
| WebFetch | Host/path, HTTP status, response size/truncation and duration | Bounded fetched text or error text; never dump an unbounded page |
| Vision | Source, source type, media type and status | Bounded textual result/error; never render or expose the encoded image payload |
| Task | Action/list title and completed/total summary | Task rows, with completion markers; long lists are bounded |
| Ask | Question count and answered count/status | Questions and selected answers; the permission interaction itself remains usable and is not hidden by preview folding |
| ToolSearch, Skill, MCP, MCP resources, Git worktree, and any other tool without a specialized view | Shared generic row: friendly tool label, concise input summary, completion/error and concise output summary | Bounded text output and, when useful, structured input/details; no arbitrary line numbering |
| Read, Bash, Edit, Write | Existing dedicated presentation | Preserve current behavior; only regression-test against the shared contract |

## 4. Coverage and fallback

Every registered tool and every runtime-created tool-call row must have a user presentation. A
specialized `presentation.View` is optional; absence means the shared generic view, not a plain or
unbounded output dump. This includes dynamically named MCP tools and tools registered outside
the static tool index.

Ask is a special case only in that its permission prompt is a separate user interaction. The
transcript preview must not replace, delay, or obscure that prompt; after it completes, its
question/answer details follow the normal collapsed-preview behavior.

## 5. Limits and safe rendering

- Default preview body: 0 rows.
- Specialized text preview cap: at most 200 rendered rows unless an existing tool-specific cap is
  lower; include an omission notice when clipped.
- Generic fallback: at most 100 rendered rows and 20,000 characters, with an omission notice.
- Compact summaries must be single-line, whitespace-normalized, and capped to avoid pushing status
  metadata off-screen.
- For web and vision views, present only text and safe metadata; never render binary/image blocks.

## 6. Verification

Focused tests must cover each specialized non-core view's compact state, zero-row default,
functional expand/collapse target, bounded expanded preview, and error/no-output behavior. The
shared fallback must be tested with text, structured details, large output, and image/binary
blocks. The complete registered definition set must be checked so every active built-in has
either a specialized view or the generic fallback path. Tests must prove presentation-only
transforms do not modify the model-facing `ToolResult.content`.

Run focused tool UI tests, the full `bun run test` suite, and `bun run build`. Do not edit generated
build output.
