export type AgentActivityState =
  | { phase: 'idle' }
  | { phase: 'thinking' }
  | { phase: 'preparing-tool' }
  | { phase: 'running-tool'; toolName: string }
  | { phase: 'running-tools' }
  | { phase: 'responding' }

export type AgentActivityEvent =
  | { type: 'thinking' }
  | { type: 'preparing-tool' }
  | { type: 'tool-started'; toolName: string }
  | { type: 'tool-finished'; pendingTools: number }
  | { type: 'responding'; pendingTools: number }
  | { type: 'work-finished'; pendingTools: number }

/** Maps Agent lifecycle events to a provider-neutral state machine. Invalid or stale
 * transitions preserve the current state instead of reviving an earlier activity. */
export function transitionAgentActivity(
  current: AgentActivityState,
  event: AgentActivityEvent,
): AgentActivityState {
  // A new turn is opened explicitly by `thinking`; after work has returned to idle,
  // delayed per-message/tool events must not bring the previous turn back to life.
  if (current.phase === 'idle') {
    if (event.type === 'thinking') return { phase: 'thinking' }
    return current
  }

  // `thinking` starts a turn from idle. After tool/answer work has advanced,
  // repeated message-start events must not roll the activity back.
  if (event.type === 'thinking' && current.phase !== 'thinking') return current

  switch (event.type) {
    case 'thinking':
      return current
    case 'preparing-tool':
      if (current.phase === 'running-tool' || current.phase === 'running-tools') return current
      return current.phase === 'preparing-tool' ? current : { phase: 'preparing-tool' }
    case 'tool-started':
      return { phase: 'running-tool', toolName: event.toolName }
    case 'tool-finished':
    case 'work-finished':
      return event.pendingTools > 0
        ? { phase: 'running-tools' }
        : event.type === 'tool-finished'
          ? { phase: 'thinking' }
          : { phase: 'idle' }
    case 'responding':
      if (event.pendingTools > 0) return { phase: 'running-tools' }
      return current.phase === 'responding' ? current : { phase: 'responding' }
  }
}

export function getAgentActivityLabel(state: AgentActivityState): string | undefined {
  switch (state.phase) {
    case 'thinking': return 'Analyzing…'
    case 'preparing-tool': return 'Preparing tool call…'
    case 'running-tool': return `Running ${state.toolName}…`
    case 'running-tools': return 'Running tools…'
    case 'responding': return 'Responding…'
    case 'idle': return undefined
  }
}
