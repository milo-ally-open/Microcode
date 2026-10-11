# Project guidance

## Purpose

Microcode is a TypeScript/Bun CLI and TUI coding agent. Its core is single-Agent; tools provide capabilities such as file operations, shell execution, search, session/task management, and Git worktrees.

## Layout and entry points

- `src/entry.ts` — executable entry point; initializes the TUI app from `src/tui/app.ts`.
- `src/agent/` — Agent setup and orchestration; `MicrocodeAgent.ts` is the central implementation.
- `src/tools/` — built-in tools. Tool definitions register through `src/tools/registry.ts`; `src/tools/index.ts` assembles tools.
- `src/permissions/`, `src/models/`, `src/session/`, `src/tasks/`, `src/git/` — permission rules, model selection/credentials, persisted sessions, task lists, and Git worktree behavior.
- `src/tui/` — terminal UI and components; `src/prompt/` — prompt construction.
- `tests/` mirrors feature areas under `src/`; keep all tests in the repository-root `tests/` directory.
- `build.ts` — Bun build configuration; `docs/` contains specifications.

## Commands

Confirmed package scripts (`package.json`):

- `bun run dev` — run `src/entry.ts` in development mode.
- `bun run build` — build with `build.ts` (generates output under `dist/`).
- `bun run test` or `bun test ./tests` — run the test suite.

Use Bun and the versions/dependencies declared in `package.json` and `bun.lock`. No lint script is declared.

## Conventions and boundaries

- Use TypeScript and follow the existing feature-oriented `src/` and mirrored `tests/` structure. Add focused tests for behavior changes.
- Agent behavior spans prompt construction, tool registration/discovery, permissions, model selection, and session persistence; inspect the relevant paths together before changing capabilities. Keep user-facing capability descriptions consistent with tools exposed at runtime.
- Preserve the single-Agent core and CLI/TUI runtime. Keep general task management and Git/worktree functionality distinct from orchestration; do not add a GUI or multi-Agent workers without an explicit requirement.
- Do not edit generated output such as `dist/` or `packaging/out/` unless explicitly required. Avoid unrelated refactors and dependencies.
