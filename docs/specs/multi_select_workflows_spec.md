# Multi-select Workflows Specification

**Status:** Implemented Sections 3–4
**Version:** 0.1  
**Date:** 2026-09-28

## 1. Purpose

Microcode MUST provide a consistent keyboard interaction for operations where users commonly apply the same state change to several independent items. The interaction uses Space to toggle individual items and Enter to confirm the complete selection, following the existing task reminder browser and `MultiSelectList` component.

This specification covers bulk Skill activation and Plugin enablement first, and records other places where multi-select is useful.

## 2. Shared interaction contract

- Up/Down MUST move the active row.
- Space MUST toggle the active row without immediately applying a change.
- Enter MUST confirm the selected set as one user action.
- Escape MUST cancel and leave all state unchanged.
- A row's checked state MUST represent its current state when the screen opens. The user edits it into the desired final state; checked MUST NOT mean “perform this toggle now.”
- The screen MUST show the Space/Enter/Escape hints and selected count.
- Unavailable items MUST be visibly disabled and MUST NOT be included in the confirmed set.
- If the confirmed desired state equals the initial state, the operation MUST be a no-op.
- The UI MUST report completion or errors without claiming changes that were not applied.

## 3. Skill activation

The Skills enable/disable workflow MUST use multi-select. It MUST list the Skills currently available to the Agent, show each Skill's source scope and enabled state, and preselect currently enabled Skills. On confirmation, Microcode MUST load newly selected Skills and unload deselected Skills. The flow MUST reject changes while the Agent is busy and MUST report per-Skill failures while continuing independent changes.

This operation changes which Skill instructions are loaded into the Agent prompt. It does not create, edit, or delete Skill packages.

Confirmed Skill changes MUST be hot-applied to the Agent prompt without restarting Microcode. A selected Skill's latest file content MUST be read when it is loaded.

The `/skills` list MUST refresh the Skill catalog before displaying it, so newly added Skills and source/status changes are visible.

## 4. Plugin enablement

Plugin enablement MUST support selecting multiple Plugins in one operation. Since user and project preferences are stored in separate configuration files, the UI MUST scope a batch to one source scope at a time (`user` or `project`). It MUST show Plugin name, scope, current enabled state, and health; current enabled Plugins are preselected. Invalid or incompatible Plugins MUST be disabled in the selection list and MUST NOT be enabled by the batch.

On confirmation, Microcode MUST compare the desired enabled state with the initial state, update only changed preferences in the selected scope, preserve unrelated configuration and Plugin preferences, persist the changes with an atomic file replacement, and refresh Plugin discovery once. If there are no changes, it MUST perform no write and no refresh. The action MUST be rejected while the Agent is busy.

Confirmed Plugin changes MUST be hot-applied without restarting Microcode: Plugin Skills MUST update in the Agent prompt, and Plugin MCP servers MUST be connected or removed to match the newly enabled set. Plugin discovery and runtime synchronization MUST happen once per batch.

The `/plugins` command MUST refresh Plugin discovery before showing its action menu, so packages added or changed while Microcode is running can be listed and enabled or disabled without restarting.

## 5. MCP discovery and runtime

MCP has no trust/revoke workflow. Valid standalone MCP configurations connect when discovered; enabled Plugins contribute their MCP servers to the runtime. The `/mcp` listing MUST rediscover and reconcile MCP packages before displaying them. Microcode does not watch capability directories continuously: Skill catalogs are rescanned as the Agent prepares a prompt, `/plugins` refreshes Plugin discovery and enablement, and `/mcp` rediscovers standalone MCP packages and reconciles active connections.

## 6. Other multi-select candidates

- Task reminder management already uses the shared multi-select interaction and serves as the reference behavior.
- Bulk enabling/disabling Skills and Plugins is in scope for this version.
- MCP status remains a list-only command; Plugin enablement remains managed through `/plugins`.
- Multi-file or multi-package operations may use the interaction when they have a clear all-or-nothing confirmation and per-item results.

Model/provider selection and individual permission prompts SHOULD remain single-selection because they choose one value or one object. A permission request MUST NOT be silently generalized into a batch approval.

## 7. Implementation notes

The shared TUI component is `MultiSelectList`. Callers MUST resolve the confirmed desired state explicitly and MUST NOT depend on item ordering to imply precedence. Bulk persistence APIs SHOULD accept a set of desired values, make one durable update, and perform one runtime refresh after persistence succeeds.
