# Runtime adapter integration notes

These examples use the shared TypeScript runtime surface. They show how a Desktop backend or an ACP-facing adapter can map its own requests into the runtime; they do not implement Electron IPC or the ACP protocol.

## Ownership and lifecycle

`RuntimeFactory` is the composition root: it loads project instructions and plugin metadata, creates or accepts the existing session/MCP managers, constructs the existing `MicrocodeAgent` through `createMicrocodeAgentRuntime`, and registers the existing Git worktree tool. The Agent and current model layer retain prompt execution, tools, permission policy, model/provider selection, and message persistence integration. `ApplicationRuntime` owns project/session transitions, command validation, ordered event publication, pending approval requests, MCP/plugin reconciliation, and coordinated shutdown. Adapters consume runtime DTOs and do not create a second Agent or access those managers directly.

## Desktop backend: open and observe a session

Create one runtime per project context in the backend. Subscribe before rendering the initial state; `subscribeWithSnapshot()` attaches the listener and captures the snapshot synchronously, so queued events can be compared with the snapshot sequence without a reconnect race.

```ts
const { runtime } = await RuntimeFactory.create({ cwd: projectDirectory, microcodeVersion })
const queued: RuntimeEvent[] = []
let initialStateRendered = false

const connection = runtime.subscribeWithSnapshot((event) => {
  if (!initialStateRendered) queued.push(event)
  else applyRuntimeEvent(event)
})

renderRuntimeSnapshot(connection.snapshot)
initialStateRendered = true
for (const event of queued) {
  if (event.sequence > connection.snapshot.sequence) applyRuntimeEvent(event)
}

const opened = await runtime.dispatch({
  commandId: 'desktop:open-session:1',
  command: { type: 'session.resume', sessionId: internalSessionId, cwd: projectDirectory },
})
if (!opened.ok) showRuntimeError(opened.error)
```

For a later reconnect to the same runtime, call `subscribeWithSnapshot()` again and replace the client view from its returned snapshot. If the backend is recreated, create a runtime for the same project and issue `session.resume`; the session repository restores persisted messages.

## ACP adapter: map external session identity and approval

Keep ACP session IDs in adapter-owned state and map each one to the runtime's internal session ID. Send prompts and cancellation through commands; forward `agent.event` payloads to the external protocol. Do not invoke tools or permission policy from the adapter.

```ts
const created = await runtime.dispatch({
  commandId: 'acp:new-session:1',
  command: { type: 'session.ensure_created', cwd: projectDirectory },
})
if (!created.ok) return reportRuntimeError(created.error)
externalToInternalSession.set(acpSessionId, created.result)

const unsubscribe = runtime.subscribe((event) => {
  if (event.type === 'agent.event') forwardAgentEvent(acpSessionId, event)
  if (event.type === 'permission.requested') requestExternalApproval(acpSessionId, event.request)
})

await runtime.dispatch({
  commandId: 'acp:prompt:2',
  command: { type: 'agent.prompt', prompt: incomingPrompt },
})
```

When the external client answers an approval request, send `permission.respond` with the `requestId` from `permission.requested`. A response with `accepted: false` means the request is no longer pending (for example, it was cancelled during runtime shutdown). Map external cancellation to `agent.cancel`; `prompt.completed` reports whether the run was aborted.

## Command and lifecycle errors

The current contract version is `RUNTIME_PROTOCOL_VERSION = 1`. Snapshots, events, and command responses include `protocolVersion`; command envelopes may include it, and a supplied incompatible value returns `protocol_version_mismatch`. The version field makes the TypeScript boundary explicit; it does not imply a wire protocol or IPC compatibility guarantee.

Every dispatch response echoes `commandId`. Successful responses contain `result`; failures contain `{ code, message }`:

- `runtime_closed`: the runtime is closing or closed; reject new work and release the adapter subscription.
- `agent_busy`: an operation requiring an idle Agent was rejected; keep the current session view and retry after the active prompt completes.
- `session_not_found`: the requested session ID does not exist in this project context.
- `session_project_mismatch`: the requested session belongs to another project; create a runtime for that project before opening it.
- `protocol_version_mismatch`: the envelope named a runtime version this implementation does not support.
- `command_failed`: an unexpected or command-specific failure. The message is diagnostic text, not a stable machine-readable value.

A prompt cancellation completes through the event stream with `prompt.completed.aborted: true`. `runtime.close()` is idempotent, rejects new commands as soon as closing starts, cancels active Agent work, denies pending permission requests, persists the session, disconnects MCP, closes the session manager, and then releases runtime-owned cleanup hooks. It rejects with aggregated cleanup diagnostics only after attempting those steps.

The current contract is a TypeScript API within the Bun backend. A future IPC or ACP transport must serialize these DTOs and map its own protocol errors at the adapter boundary; it must not expose manager instances or depend on error message text.
