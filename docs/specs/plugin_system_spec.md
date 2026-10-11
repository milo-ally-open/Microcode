# Microcode Plugin System — Implementation Specification

**Status:** Proposed; research/design only, not implemented
**Owner:** Microcode harness
**Scope:** CLI/TUI plugin packaging, discovery, validation, enablement, and integration with existing skill and MCP capabilities
**Design date:** 2026-09-28

## 1. Purpose

Add a plugin system that lets a user install a reusable bundle of workflow instructions and optional external tools, enable or disable it, and use it across Microcode sessions. A plugin is a packaging and lifecycle boundary around capabilities the harness already understands; it is not a second agent, a replacement for the tool registry, or arbitrary code loaded into the Microcode process.

The initial implementation must preserve Microcode's single-Agent core and CLI/TUI runtime. It should reuse `SKILL.md` and MCP rather than inventing new model-facing protocols. Plugin-provided content must not bypass tool permission checks.

## 2. Research findings and terminology

OpenAI Codex packages skills, MCP server connections, and lifecycle hooks as plugins; the newer portable package layout uses a root `plugin.json`, a `skills/` directory, and optional `mcp.json`, with OpenAI-specific settings under `extensions.com.openai`. Claude Code treats a plugin as a directory of components—skills, agents, hooks, MCP servers, and other supported integrations—loaded as one unit, usually with `.claude-plugin/plugin.json`. In both systems, the component does the runtime work; the plugin groups, identifies, distributes, and enables components.

Microcode uses these terms:

- **Plugin package:** A directory with a manifest and zero or more supported component directories/files.
- **Plugin identity:** The stable, kebab-case manifest `name`; it namespaces all contributed capabilities.
- **Plugin source:** Where the package came from (initially a local directory; later a marketplace entry and pinned repository revision).
- **Installed plugin:** A validated package stored in Microcode's plugin area.
- **Enabled plugin:** An installed package whose supported components Microcode loads in the current scope.
- **Skill:** Markdown workflow guidance and supporting read-only/package assets, parsed and loaded through the existing skill path.
- **MCP server:** An external process or remote server exposing protocol-defined tools/resources, connected by the existing MCP client.
- **Marketplace:** A catalog of plugin identities and source references. It is not itself a plugin runtime or executable.

## 3. Goals

1. Load a local plugin directory using a validated, documented manifest.
2. Discover plugin skills and expose them using collision-resistant namespaced IDs.
3. Optionally connect plugin-declared MCP servers and expose their tools through Microcode's normal tool discovery and permission flow.
4. Provide actionable validation/load diagnostics and user-visible plugin status.
5. Support user and project scopes with deterministic precedence and explicit enablement.
6. Keep plugin resolution, component registration, and lifecycle management outside the core Agent loop.
7. Leave a path for marketplace distribution without requiring network installation in the first release.

## 4. Non-goals for the first release

- Plugin-defined subagents, agent teams, task spawning, or any multi-Agent orchestration.
- In-process JavaScript/TypeScript imports, dynamic native modules, WASM extensions, or arbitrary `require()` hooks.
- Lifecycle shell hooks, startup scripts, post-install scripts, executable `bin/` contributions, or automatic formatters.
- Marketplace browsing, remote Git cloning/updating, signatures, or background auto-update.
- GUI/plugin webviews or changes to the terminal interaction model beyond a small `/plugins` menu.
- Replacing existing user/project skill discovery or standalone MCP configuration.
- Treating a plugin's instructions as permission to ignore system, developer, repository, or user instructions.

## 5. Package format

### 5.1 Initial package layout

```text
plugin-root/
  plugin.json                 # required identity and metadata
  mcp.json                    # optional Microcode MCP server declarations
  skills/                     # optional; one <skill>/SKILL.md per skill
    review/
      SKILL.md
      references/             # optional supporting material
      assets/                 # optional static assets
```

`plugin.json` is the root manifest. It should use the portable Agent Plugins identity fields where practical (`$schema`, `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`) and place Microcode-only options under `extensions.com.microcode`. Microcode must not claim compatibility with another host's component semantics merely because it accepts a shared manifest shape.

The initial supported component locations are fixed: `skills/` and `mcp.json`. Do not add path aliases or plugin-defined custom scanners in v1. `extensions.com.microcode` may declare a minimum Microcode version and optional presentation metadata; it must not let a manifest disable path-containment checks or tool permissions.

Example identity manifest (illustrative):

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "review-kit",
  "version": "0.1.0",
  "description": "Reusable code review workflows",
  "author": { "name": "Example Team" },
  "license": "MIT",
  "extensions": {
    "com.microcode": {
      "minVersion": "0.1.0"
    }
  }
}
```

### 5.2 MCP configuration

`mcp.json` contains an `mcpServers` object. Initially, each entry uses Microcode's existing `McpServerConfig` form (`stdio` command/args/env, or supported remote transport URL/headers). A later compatibility adapter may accept other portable MCP configuration variants, but the adapter must normalize to one internal type and reject unsupported fields instead of silently dropping security-relevant configuration.

At runtime, server names are qualified with the plugin identity, for example `review-kit__docs`; MCP tool names remain the existing `mcp__<server>__<tool>` shape using that qualified server name. The complete identifier must be stable, unique, and reversible to its plugin/server/tool parts. Reject collisions rather than letting a plugin shadow a built-in tool or another plugin's server.

Enabling a valid plugin starts its declared MCP servers automatically. Disabling the plugin disconnects its servers. Skills-only plugins have no MCP connection lifecycle.

### 5.3 Manifest validation

The validator must check:

- Required `name`, legal kebab-case syntax, maximum lengths, and supported semantic-version syntax for `version`.
- Valid JSON, known schema version, recognized component paths, and well-typed extension fields.
- `SKILL.md` presence and valid skill frontmatter (`name`, `description`, invocation flags supported by Microcode).
- Unique plugin IDs and namespaced skill/server/tool IDs across all enabled plugins.
- Every resolved component path remains within the canonical plugin root. Reject `..`, absolute component paths, symlink escapes, dangling symlinks, and non-regular files where files are expected.
- Bounded manifest/skill sizes, reasonable component counts/depth, and no traversal into `node_modules`, `.git`, or hidden paths not explicitly part of the package layout.
- MCP transport configuration is structurally valid. Do not log secret values from `env` or `headers`; redact them in UI and diagnostics.
- If a declared minimum Microcode version is newer than the running version, mark the plugin incompatible and do not partially load it.

Validation is read-only and must complete before any MCP connection is attempted. One invalid plugin must not prevent other valid plugins or Microcode itself from starting.

## 6. Discovery, scope, and state

### 6.1 Scope directories

- **User scope:** `~/.microcode/plugins/<plugin-name>/`.
- **Project scope:** `<repo>/.microcode/plugins/<plugin-name>/`.
- **Explicit path:** A CLI option for development/testing, scoped to that process only.

The exact project configuration filename should remain consistent with existing `.microcode/config.json`; use that file for enabled-plugin IDs and scope overrides rather than introducing a second competing settings file.

### 6.2 Enablement precedence

Use explicit configuration with deterministic precedence:

1. Project-level `plugins` entry overrides the same user-level plugin ID.
2. An explicit project disable suppresses the user-level enable for that project.
3. Explicit-path plugins are session-only and must not mutate user/project configuration.
4. Unknown IDs and missing package directories produce diagnostics; they are not silently ignored.

Example configuration shape (subject to alignment with current config schema):

```json
{
  "plugins": {
    "review-kit": {
      "enabled": true
    }
  }
}
```

Plugin enablement is the sole package-level switch. MCP servers from enabled plugins connect automatically; disabled plugins may still be inspected but contribute no runtime MCP servers.

## 7. Runtime architecture and integration

### 7.1 New module boundaries

Add a `src/plugins/` module with focused responsibilities:

- `types.ts`: manifest, source, installed/enabled state, diagnostics, and immutable runtime snapshot types.
- `manifest.ts`: parse and validate manifest/frontmatter schemas.
- `paths.ts`: canonical path resolution and root containment checks.
- `discovery.ts`: discover user/project/explicit local package roots and apply scope precedence.
- `PluginManager.ts`: produce an effective immutable snapshot; own enable/disable state transitions and diagnostics, not tool execution.
- `marketplace.ts`: reserved for a later phase; do not ship a partial remote installer in v1.

The manager returns component descriptions/configuration; it does not import plugin code and does not mutate the global tool registry. The Agent remains the only model loop.

### 7.2 Startup and session lifecycle

1. Resolve `cwd`, existing user/project config, and configured plugin package roots.
2. Discover and validate every package; apply scope and enablement state.
3. Construct a plugin snapshot containing skills, enabled-plugin MCP server configs, and diagnostics.
4. Merge plugin skills into the skill catalog using namespaced IDs such as `review-kit:review`.
5. Create the normal Microcode agent with this catalog, keeping existing standalone user/project skills available.
6. Connect MCP servers from enabled plugins alongside discovered standalone MCP servers.
7. After successful connection, register their tools with the existing tool manager, rebuild tool discovery state, and update the prompt/status view.
8. On disable, disconnect that plugin's servers, remove its tools/resources from the agent, remove its skills from future discovery, and rebuild the effective prompt/tool snapshot. Do not remove or rewrite conversation history.
9. On shutdown, close all plugin-owned MCP clients using the existing MCP disconnect lifecycle.

Connection failures are isolated per server and shown in `/plugins` and `/mcp` diagnostics. Reconnects must replace a server's old tool set rather than duplicate it.

### 7.3 Skill integration

Extend skill identity to distinguish a display name from a stable qualified ID. Standalone skills keep their current names and behavior; plugin skills resolve as `<plugin>:<skill>`. Update skill autocomplete, `$skill-name` mention parsing, `/skills`, snapshots, diagnostics, load/unload operations, and the skill tool to use qualified IDs without ambiguity.

Preserve current lazy-loading behavior: catalog metadata is available for selection, while complete skill bodies enter context only when loaded or invoked. Supporting references/assets remain package-relative. A plugin skill may guide the model through Microcode's existing tools, but it cannot grant itself tools or permission rules.

Users MUST be able to explicitly reference an enabled Plugin as `#plugin-name` to inject that package's description and invocable Skill guidance into the current request. Typing `#` MUST trigger autocomplete after refreshing Plugin discovery, so newly enabled packages are available immediately. Plugin discovery and runtime synchronization MUST also refresh before each submitted user turn. Autocomplete and `#` mention resolution MUST include only valid, compatible enabled Plugins. Disabled packages MUST remain visible in `/plugins` so users can enable them. The injected package content MUST be framed as untrusted guidance. A `#plugin-name` mention MUST NOT change the Plugin's enabled state or grant tool permissions. Existing `$plugin-name:skill-name` mentions remain supported for selecting one Plugin Skill.

### 7.4 MCP/tool integration

Use `McpClientManager` and the existing tool wrappers rather than creating a parallel invocation path. After an MCP connection changes, call the agent's MCP tool-configuration/update path and refresh the dynamic tool registry. Ensure unload/disconnect removes the corresponding server's discovered tools, pending tools, resources, and permissions.

Dynamic plugin tool permissions must be represented explicitly in the permission system. Unknown external tools must not accidentally receive an allow decision because a name is absent from a static built-in registry. Default plugin MCP tool behavior is `ask` in interactive mode; explicit user rules may allow/deny specific tools, and deny always wins. Plan/read-only mode must continue to block mutating tools.

Do not expose all plugin MCP schemas in the initial prompt when the existing deferred-tool mechanism can discover them on demand. Keep tool names/descriptions discoverable; load full schema when selected. Resource reads and MCP actions use existing permission/approval semantics.

### 7.5 TUI/CLI surface

`/plugins` MUST offer only `List plugins` and `Enable/disable plugins` actions (plus `Cancel`). Listing shows plugin identity, source scope, enabled state, component counts, health, and diagnostics. Enable/disable uses the shared multi-select interaction and applies the desired state for one scope. Runtime changes are hot-applied when safe; changes MUST be rejected or queued while the Agent is busy.

In the input editor, `$skill-name`, `#plugin-name`, and `@file` mentions MUST use visibly distinct highlight colors. Keep their color assignments centralized so future UI changes do not make Plugin mentions indistinguishable from Skills or files.

V1 does not need install/uninstall commands; local packages can be placed in the documented directory. Future phases may add `install`, `remove`, `marketplace add/list`, and `update`.

## 8. Security model

1. **No in-process package code.** Plugin packages cannot import Microcode internals or execute lifecycle scripts in v1.
2. **MCP is executable integration.** A stdio MCP server starts a child process with the user's OS privileges. Discovered valid standalone MCP servers connect automatically; Plugin MCP servers connect while their Plugin is enabled. Remote MCP endpoints may read/send data under configured credentials.
3. **Tool calls remain permission-gated.** MCP connection does not approve model-requested actions. Each tool call passes through `PermissionManager` and current mode/rules.
4. **Skill text is untrusted package content.** Clearly delimit plugin instructions in model context; they may provide workflow advice but cannot override system/developer/user/repository instructions, access controls, permission decisions, or capability availability. Never treat manifest descriptions or skill text as executable authorization.
5. **No secret disclosure.** Redact environment variables, authorization headers, and credentials from snapshots, logs, TUI summaries, errors, and exported sessions where applicable.
6. **Containment.** All package-owned file reads are rooted under the canonical package directory. Component references cannot escape that root through traversal or symlinks.
7. **Fail closed, isolate failures.** Invalid, incompatible, or failed components are unavailable; report why. Never fall back to a same-named component from another plugin after a validation failure.
8. **No automatic remote code updates.** Updates and source revisions are explicit.

## 9. Current Microcode touchpoints and prerequisite work

The following source facts inform the design; implementation should re-check them at that time:

- User and project skill directories are currently loaded by `loadSkills` in `src/skill/skill.ts` (including duplicate-name handling around lines 413–430 and default locations around 436–438).
- `AgentSkillManager` owns the available/loaded catalog, and `MicrocodeAgent` passes it into prompt/tool setup (`src/agent/AgentSkillManager.ts`, `src/agent/MicrocodeAgent.ts`).
- MCP configuration is merged in `src/mcp/config.ts`; connection and discovery happen in `src/mcp/client.ts`.
- `AgentToolManager` stores core, deferred, discovered, and external tools (`src/agent/AgentToolManager.ts`); built-in tool definitions currently use a module-global registry (`src/tools/registry.ts`). Plugin contribution must be instance-scoped and removable, not process-global.
- The current MCP connection callback in `src/main.tsx` updates the TUI's MCP status/prompt path. In the inspected tree, no caller of `MicrocodeAgent.configureMcpTools` was found. Confirm the current state and wire tested MCP tool registration before relying on plugin MCP integration.
- `src/entry.ts` documents Bun compiled-binary use. External MCP processes avoid requiring the compiled host to dynamically import arbitrary plugin source.

## 10. Phased implementation plan

### Phase 0 — Verify/fix MCP foundation

- Add an integration test proving a connected MCP tool is discoverable, permission-checked, callable, and removed after disable/disconnect.
- Ensure the running Agent's tool list is refreshed after MCP connection and reconnection.
- Fix lifecycle cleanup/duplicate-registration behavior before plugins depend on it.

### Phase 1 — Local skill-only plugins

- Add manifest and path validation, local user/project/explicit discovery, enable state, namespace, diagnostics, `/plugins` list and enable/disable actions, and tests.
- No network, no server startup, no arbitrary scripts.

### Phase 2 — Plugin MCP

- Parse plugin-local `mcp.json`, namespace server IDs, connect servers while the Plugin is enabled, attach/remove tools dynamically, and pass every invocation through permission management.
- Add reload/disable/disconnect behavior and per-server failure reporting.

### Phase 3 — Distribution

- Add marketplace catalog format and CLI management. Pin Git-based sources to a commit/ref, stage installs into a temporary sibling directory, validate before atomic activation, preserve the previous install on failure, and require explicit updates.
- Revalidate changed package content before activation.

### Phase 4 — Consider optional hooks

- Only proceed with an explicit lifecycle event contract, timeout/cancellation policy, safe environment/input schema, consent UX, and sandbox strategy. A hook running with user privileges is not equivalent to a normal model-mediated tool call.

## 11. Tests and acceptance criteria

Place all tests under `tests/plugins/`.

### Manifest/discovery tests

- Valid minimal plugin and skills-only plugin load successfully.
- Invalid JSON, invalid names/version, unsupported schema, malformed frontmatter, and missing files yield precise diagnostics and do not crash startup.
- User/project precedence and explicit disable behavior are deterministic.
- Duplicate plugin IDs and duplicate qualified capability names are rejected without shadowing.
- Traversal, absolute paths, symlink escape, hidden-directory scanning, and oversized inputs are rejected.
- A broken plugin does not prevent valid plugins or Microcode startup.

### Skills tests

- Plugin skill names are qualified and autocomplete/explicit invocation resolve the correct skill.
- Existing standalone skill names/paths continue working unchanged.
- Skill bodies load lazily; supporting assets resolve inside the package root.
- Disabling/removing a plugin removes its skills from the available catalog and prompt while preserving session messages.
- Malicious prompt content cannot bypass tool permissions or elevate component access in deterministic harness tests; add eval cases for instruction-boundary behavior.

### MCP and permission tests

- Disabled plugin MCP servers never connect; skills-only plugins need no separate MCP setting.
- An enabled plugin server starts once, discovers namespaced tools, and is visible to ToolSearch.
- Calls use the registered schema and pass through allow/ask/deny/plan policies; unknown tools fail closed.
- Disable/reconnect removes stale tools and resources; re-enable does not duplicate them.
- Connection failures/timeouts are isolated and visible; secrets never appear in logs/snapshots/diagnostics.

### CLI/TUI tests

- `/plugins` lists state and component health and supports enable/disable.
- Enable/disable during an active turn is deferred or rejected with a clear status, never mutating the live tool set unsafely.
- Short terminal widths, missing packages, malformed manifests, and long diagnostic text remain readable.

### Release acceptance

- `bun test ./tests` passes.
- `bun run build` passes, and a compiled CLI can load a skills-only plugin and connect to an enabled plugin's MCP server without dynamic in-process plugin imports.
- Documentation explains supported components, install roots, enablement, scope precedence, and limitations.
- No plugin mechanism introduces subagents, agent teams, a GUI, or unreviewed background execution.

## 12. Documentation/research references

Official references checked on 2026-09-28:

- OpenAI, [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins): plugin concept, skills, MCP, optional UI, lifecycle hooks.
- OpenAI, [Package your plugin](https://developers.openai.com/plugins/build/plugins): portable root manifest, package layout, MCP config, OpenAI extensions, local/repo marketplaces, hook trust.
- OpenAI, [Skills](https://developers.openai.com/plugins/concepts/skills): workflow guidance vs server-backed capabilities.
- OpenAI, [MCP server](https://developers.openai.com/plugins/concepts/mcp-server): tools/resources/prompts and client/server invocation flow.
- Anthropic, [Claude Code plugins overview](https://code.claude.com/docs/en/plugins): package, marketplace, scopes, load lifecycle, and installed footprint.
- Anthropic, [Create a plugin](https://code.claude.com/docs/en/plugins/create): manifest and default directory layout.
- Anthropic, [Plugin components](https://code.claude.com/docs/en/plugins/components): skills, commands, agents, hooks, MCP and other component types.
- Anthropic, [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference): metadata, dependencies, component path declarations, containment rules.
- Anthropic, [Plugin security and trust](https://code.claude.com/docs/en/plugins/security): local execution privileges, hooks/MCP processes, and the distinction between plugin trust and tool-call permissions.
