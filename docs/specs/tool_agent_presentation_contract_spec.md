# Tool Agent/Presentation Contract Specification

**Status:** Implementation target
**Scope:** Built-in, deferred, and dynamically registered tools; initially the terminal UI

## 1. Purpose

Every tool has two consumers with different needs:

1. The Agent needs a stable machine contract and bounded, useful results for the model.
2. The user needs a readable activity view, concise summaries, and optional previews that can
   be expanded without changing what the Agent received.

This specification makes those contracts explicit, keeps their data paths separate, and defines
one registration and lifecycle pattern for every tool.

## 2. Core rule

Presentation is a projection of tool activity, not part of the model result. Rendering choices
must never rewrite, decorate, or enlarge the content returned to the model. Conversely, an
Agent-facing output limit must not accidentally dictate the UI preview limit.

```text
Tool call ──> Agent contract ──> model content ──> Agent transcript
                  │
                  └── structured updates/results ──> presentation projection ──> TUI
                                                        ├─ summary/status
                                                        └─ preview + interaction
```

## 3. Responsibilities

### 3.1 Agent contract

Owns the tool name, description, input schema, execution, model-facing result content, and any
limits or truncation required to keep model context useful and bounded. Discovery/defer behavior
and model capability requirements also belong here.

Agent content is semantic output. It must not contain terminal colors, UI button labels, display
line numbers, or formatting added solely for readability. A tool may return meaningful line
numbers as part of its domain result only when the model itself needs those numbers to refer to
source locations; this must be an explicit tool contract, not an incidental UI choice.

### 3.2 Shared semantic facts

Execution may produce structured facts such as paths, exit codes, byte counts, change counts,
truncation flags, and raw/unformatted preview data. These facts are not presentation strings.
They must be typed, bounded, and safe to retain for rendering. No ANSI escapes or pre-rendered
controls belong here.

The Agent result's `content` is the model channel. Structured `details` are local execution/UI
metadata and must not be implicitly serialized into model context. If a detail is needed by the
model, put it deliberately in model content and test that contract.

### 3.3 User presentation contract

Owns human-readable activity, compact arguments/status/summary, and a view over structured facts.
It may provide a tool-specific preview source or projection, while shared TUI components own
common preview behavior:

- previews start collapsed and show zero body rows by default;
- expand/collapse state is per tool call and does not mutate execution results;
- line-number gutters, diff coloring, and terminal-safe clipping are presentation transforms;
- user preview limits are independent from model-output limits and remain bounded;
- interactive controls expose semantic hit regions/actions; layout must not discover controls by
  searching rendered text.

Specialized views may choose their own content layout, but they must use the same lifecycle and
preview interaction contract.

### 3.4 Policy and lifecycle

Permission defaults and approval decisions are execution policy, not rendering. The application
coordinates lifecycle events—created, streaming input, awaiting approval, running, partial update,
completed, failed, and cancelled—and sends those events to the tool presentation adapter.
Approval-preview data is produced by a tool hook where needed; the application must not branch on
individual tool names to construct tool-specific preview details.

## 4. Registration shape

Each tool is registered once, with explicit Agent, policy, and presentation sections. Names below
are illustrative; the implementation may use different property names while preserving this
boundary.

```ts
registerTool({
  name: 'read',
  policy: { defaultPermission: 'allow' },
  agent: {
    create: createFileReadTool,
    discoverability: 'core',
    // schema, description, model-facing result policy are carried by the AgentTool.
  },
  presentation: {
    View: FileReadToolView,
    activity: formatReadActivity,
    status: formatReadStatus,
    project: projectReadEvent,
  },
})
```

MCP and other runtime-created tools use the same definition shape. A tool without a specialized
view uses a shared generic view; it does not bypass the presentation contract.

## 5. Lifecycle and view model

The app sends typed lifecycle events to a presentation adapter. Adapters produce a view model
rather than independently reimplementing result bookkeeping:

```ts
type ToolPhase =
  | 'pending'
  | 'running'
  | 'awaiting-approval'
  | 'completed'
  | 'failed'
  | 'cancelled'

interface ToolViewModel {
  title: string
  phase: ToolPhase
  status?: string
  summary?: string
  preview?: {
    rows: PreviewRow[]
    totalRows: number
    truncated: boolean
  }
}
```

`PreviewRow` is unstyled semantic data (for example, source text plus optional old/new line
numbers and a diff kind). A shared preview controller owns collapsed/expanded state and the
zero-row default. Tool views retain domain-specific rendering, but publish semantic interaction
targets (`toggle-preview` plus a row/column hit region and action); the layout only maps those
targets into the viewport and never searches rendered chat text for button labels.

## 6. Output and truncation policy

- The Agent result is bounded before it enters model context; the tool defines its model-facing
  truncation policy and communicates truncation in semantic text/metadata where useful.
- Presentation details are separately bounded for memory and terminal safety. Expansion reveals
  the available user preview, not unbounded process output.
- The UI may have a different cap and omission summary than the Agent result. It must not claim
  that a preview is complete when it is capped.
- Read/file previews use logical file line numbers in the TUI. Bash stdout/stderr remains verbatim
  by default and when expanded; it is not assigned source-code line numbers.
- File edit/write diffs retain unstyled old/new line coordinates and change kinds; the TUI adds
  gutters and colors.

## 7. Design constraints

1. A UI-only change cannot alter tool schema, execution, permissions, model result content, or
   Agent-side truncation.
2. Changing preview expansion cannot alter a persisted message or a later model request.
3. The application orchestrator handles generic lifecycle and policy. Tool-specific projection
   and approval preparation live behind the registered presentation adapter.
4. No presentation component depends on a hard-coded tool-name switch for common behavior.
5. No layout code parses visible labels to infer which action a component represents.
6. Pure utilities for numbering and diff decoration operate on presentation data and are tested
   without shelling out or mutating repository files.

## 8. Migration and verification

Implement the contract in small, testable steps:

1. Split registry definitions into `agent`, `policy`, and `presentation`; migrate core registry
   consumers, permission lookups, deferred discovery, and dynamic MCP registration.
2. Introduce typed lifecycle/view-model contracts and a shared preview controller with explicit
   action hit regions.
3. Migrate Read, Bash, Edit, and Write first because they exercise raw output, file content,
   approval previews, and diffs. Remove presentation-only transformations from their Agent
   content paths.
4. Migrate remaining built-in tools and generic MCP views to the same contract.
5. Add contract tests for every registered tool and focused tests proving that UI projection,
   line numbering, folding, and truncation never mutate model-facing results.

The migration is complete when every tool uses the same registration/lifecycle contract, all
tool-specific display behavior is reachable through its presentation adapter, and the tests prove
that Agent content and user previews remain independent.
