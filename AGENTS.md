# Repository instructions

## Working agreements
- Read the relevant source and tests before making claims or edits. Treat repository behavior as unverified until supported by code or an allowed test; distinguish confirmed facts from hypotheses.
- Respect the requested scope. For read-only audits, do not edit files, run commands that modify the repository or user environment, or start/dispatch workers. Do not delegate to subagents unless explicitly asked.
- Check the working tree before editing. Preserve all existing user/Codex changes: never discard, overwrite, stash, reset, or commit them unless explicitly asked. If a target file is being edited concurrently, stop and coordinate rather than overwrite it.
- Make the smallest focused change. Do not remove unrelated functionality, introduce dependencies, or add compatibility layers for obsolete data without an explicit requirement.
- Keep secrets out of output and logs. Do not repeat API keys, OAuth codes/tokens, or other credentials found in source, logs, URLs, or screenshots.

## Project-specific guidance
- Place new Model Gateway daemon code under `src/daemon/`. Preserve the existing direct Pi integration and provider/auth behavior; `--no-daemon` must continue to use the in-process path.
- This is a TypeScript/Bun project. Use the package manager and versions declared in `package.json`; do not assume npm scripts that are not defined there.
- Model integration and gateway work must follow the [Model Integration and Harness-Agnostic Gateway specification](docs/specs/model_intergration_spec.md). Check the [live pi-ai upstream documentation](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md) and relevant upstream source when designing or updating provider/model integration; then verify every API against the exact dependency version pinned by `package.json` and `bun.lock`. The live `main` documentation is a discovery/reference source, not runtime truth: do not fetch or adopt unpinned code/catalog data at runtime, and do not modify dependency source.
- Preserve the single-Agent core and CLI/TUI runtime. Do not reintroduce a GUI or multi-Agent swarm/worker behavior unless explicitly requested. Keep independent capabilities (for example, general task management and Git/worktree functionality) separate from orchestration features.
- When changing Agent behavior, inspect the full path across message conversion, system prompts, tool registration/discovery, permissions, model selection, and session persistence. Keep user-facing capability claims consistent with tools actually exposed at runtime.
- Store all test code under the repository-root `tests/` directory. Never place test files inside `src/`; use `tests/` (plural) for unit, integration, and related test code.
- Update or add focused tests for behavior changes. The test script is `bun test ./tests` (`bun run test`); the build script is `bun run build`. Builds generate output, so do not run them during an explicitly read-only task or when generated-file changes are outside scope. There is no lint script currently declared in `package.json`.
- Do not hand-edit generated build/package output such as `dist/` or `packaging/out/` unless the task explicitly requires it.

### Model Gateway configuration and documentation
- Gateway bind defaults to `127.0.0.1`; host precedence is `--gateway-host` > `MICROCODE_GATEWAY_HOST` > `gateway.host` in `~/.microcode/config.json` > default. Port follows the corresponding `--gateway-port` > `MICROCODE_GATEWAY_PORT` > `gateway.port` > `43127` precedence.
- `/gateway` in the TUI persists a host selection and restarts/re-handshakes the daemon. `0.0.0.0` is a bind address only; remote clients must use the server's reachable interface address or DNS name.
- Keep operator setup and OpenAI/Anthropic client examples in `README.md` aligned with the CLI and tested endpoints. Explain that the current gateway uses one shared client token and does not provide TLS, per-client identity, quotas, or tenant isolation; never describe raw public binding as production-secure.

## Reporting and verification
- For audits and reviews, cite concrete `file:line` locations and relevant symbols. Separate source-proven conclusions from behavior that still needs runtime verification.
- Report which checks were actually run and their results; do not imply that tests/builds passed if they were not run.
- For changes, summarize modified files and verification performed, including any checks skipped and why.
