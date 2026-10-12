import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApplicationRuntime } from '../../src/runtime/ApplicationRuntime.ts'
import type { RuntimeCommandEnvelope, RuntimeCommandResponse, RuntimeEvent, RuntimeSnapshot } from '../../src/runtime/protocol.ts'
import type { RuntimeFactoryResult } from '../../src/runtime/RuntimeFactory.ts'
import type { McpClientManager } from '../../src/mcp/client.ts'
import { DesktopBackend } from '../../src/desktop/DesktopBackend.ts'
import type { DesktopSettingsSnapshot } from '../../src/desktop/protocol.ts'
import type { DesktopModelSettings } from '../../src/desktop/settings.ts'

const TEST_SECRET = 'test-secret-value-never-real'

function runtimeSnapshot(cwd: string): RuntimeSnapshot {
  return {
    protocolVersion: 1,
    sequence: 0,
    lifecycle: 'ready',
    project: { cwd },
    session: { id: 'session-1', metadata: null, draft: true },
    agent: {} as RuntimeSnapshot['agent'],
    messages: [],
    mcpServers: [],
    plugins: null,
  }
}

describe('DesktopBackend', () => {
  test('applies MCP settings through the existing manager and requires command confirmation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'microcode-desktop-mcp-toggle-'))
    const cwd = join(root, 'project')
    await mkdir(join(cwd, '.microcode'), { recursive: true })
    await writeFile(join(cwd, '.microcode', 'config.json'), JSON.stringify({
      mcpServers: { 'sample-server': { command: 'node', args: ['server.js'] } },
    }))
    let state: RuntimeSnapshot = {
      ...runtimeSnapshot(cwd),
      agent: { ...runtimeSnapshot(cwd).agent, skills: { available: [], loaded: [] } } as RuntimeSnapshot['agent'],
      mcpServers: [{ name: 'sample-server', status: 'connected', tools: [], resources: [] }],
    }
    const managerCalls: boolean[] = []
    let syncCalls = 0
    const mcpManager = {
      setServerEnabled: async (name: string, enabled: boolean) => {
        if (name !== 'sample-server') return false
        managerCalls.push(enabled)
        state = { ...state, mcpServers: [{ ...state.mcpServers[0]!, status: enabled ? 'connected' : 'disabled' }] }
        return true
      },
    } as unknown as McpClientManager
    const runtime = {
      getSnapshot: () => state,
      subscribe: () => () => undefined,
      dispatch: async (envelope: RuntimeCommandEnvelope): Promise<RuntimeCommandResponse> => {
        if (envelope.command.type === 'mcp.sync') syncCalls++
        return { protocolVersion: 1, commandId: envelope.commandId, ok: true, result: undefined }
      },
      close: async () => undefined,
    } as unknown as ApplicationRuntime
    const modelSettings = {
      getSnapshot: async () => ({ models: [], providers: [], mcpServers: [], mcpDiagnostics: [], plugins: null, skills: [], skillDiagnostics: [] }),
    } as unknown as DesktopModelSettings
    const backend = new DesktopBackend(async () => ({
      runtime,
      startupWarnings: [],
      mcpReady: Promise.resolve(),
      mcpServers: {},
      mcpManager,
    } satisfies RuntimeFactoryResult & { mcpManager: McpClientManager }), undefined, modelSettings)

    try {
      await backend.handle('workspace.open', { cwd })
      const disabled = await backend.handle('mcp.set_enabled', { name: 'sample-server', enabled: false }) as DesktopSettingsSnapshot
      expect(disabled.mcpServers[0]).toMatchObject({ status: 'disabled', enabled: false, scope: 'legacy' })
      await expect(backend.handle('mcp.set_enabled', { name: 'sample-server', enabled: true })).rejects.toThrow('Confirm the command')
      const enabled = await backend.handle('mcp.set_enabled', { name: 'sample-server', enabled: true, confirmed: true }) as DesktopSettingsSnapshot
      expect(enabled.mcpServers[0]).toMatchObject({ status: 'connected', enabled: true, scope: 'legacy' })
      expect(managerCalls).toEqual([false, true])
      expect(syncCalls).toBe(2)
    } finally {
      await backend.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('leaves the selected model unchanged when the runtime rejects a switch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'microcode-desktop-model-failure-'))
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    const state: RuntimeSnapshot = {
      ...runtimeSnapshot(cwd),
      agent: {
        ...runtimeSnapshot(cwd).agent,
        model: { id: 'original-model', provider: 'sample-provider', api: 'openai-completions', name: 'Original' },
        skills: { available: [], loaded: [] },
      } as RuntimeSnapshot['agent'],
    }
    const runtime = {
      getSnapshot: () => state,
      subscribe: () => () => undefined,
      dispatch: async (envelope: RuntimeCommandEnvelope) => ({
        protocolVersion: 1,
        commandId: envelope.commandId,
        ok: false,
        error: { code: 'command_failed', message: 'The runtime rejected this model.' },
      } satisfies RuntimeCommandResponse),
      close: async () => undefined,
    } as unknown as ApplicationRuntime
    const modelSettings = {
      assertModelConfigured: async () => undefined,
      getSnapshot: async () => ({ models: [], providers: [], mcpServers: [], mcpDiagnostics: [], plugins: null, skills: [], skillDiagnostics: [] }),
    } as unknown as DesktopModelSettings
    const backend = new DesktopBackend(async () => ({ runtime, startupWarnings: [], mcpReady: Promise.resolve() } satisfies RuntimeFactoryResult), undefined, modelSettings)

    try {
      await backend.handle('workspace.open', { cwd })
      await expect(backend.handle('model.switch', { id: 'new-model', provider: 'sample-provider', api: 'openai-completions' })).rejects.toThrow('The runtime rejected this model.')
      expect(backend.getSnapshot().runtime?.agent.model?.id).toBe('original-model')
    } finally {
      await backend.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps provider credentials out of settings results and reports canceled sign-in', async () => {
    let configured = false
    const getSnapshot = async (): Promise<DesktopSettingsSnapshot> => ({
      models: [],
      providers: [{ id: 'sample-provider', name: 'Sample Provider', configured, savedCredential: configured, choices: [] }],
      mcpServers: [],
      mcpDiagnostics: [],
      plugins: null,
      skills: [],
      skillDiagnostics: [],
    })
    const modelSettings = {
      getSnapshot,
      login: async (_providerId: string, _authType: string, interaction: { prompt(prompt: unknown): Promise<string> }) => {
        const credential = await interaction.prompt({ type: 'secret', message: 'Enter API key' })
        if (credential === TEST_SECRET) configured = true
      },
    } as unknown as DesktopModelSettings
    const backend = new DesktopBackend(undefined, undefined, modelSettings, async () => TEST_SECRET)
    const events: unknown[] = []
    const unsubscribe = backend.subscribe((event) => events.push(event))

    try {
      const result = await backend.handle('auth.login', { providerId: 'sample-provider', authType: 'api_key' }) as { status: string; settings: DesktopSettingsSnapshot }
      expect(result.status).toBe('signed_in')
      expect(result.settings.providers[0]?.configured).toBe(true)
      expect(JSON.stringify(result)).not.toContain(TEST_SECRET)
      expect(JSON.stringify(events)).not.toContain(TEST_SECRET)
    } finally {
      unsubscribe()
      await backend.close()
    }

    const cancelledSettings = {
      getSnapshot: async () => ({ models: [], providers: [{ id: 'sample-provider', name: 'Sample Provider', configured: false, savedCredential: false, choices: [] }], mcpServers: [], mcpDiagnostics: [], plugins: null, skills: [], skillDiagnostics: [] }),
      login: async (_providerId: string, _authType: string, interaction: { prompt(prompt: unknown): Promise<string> }) => interaction.prompt({ type: 'secret', message: 'Enter API key' }),
    } as unknown as DesktopModelSettings
    let promptOpened!: () => void
    const opened = new Promise<void>((resolve) => { promptOpened = resolve })
    const cancelableBackend = new DesktopBackend(
      undefined,
      undefined,
      cancelledSettings,
      (_prompt, signal) => new Promise<string>((_resolve, reject) => {
        promptOpened()
        signal.addEventListener('abort', () => reject(new Error('Authentication cancelled.')), { once: true })
      }),
    )
    try {
      const login = cancelableBackend.handle('auth.login', { providerId: 'sample-provider', authType: 'api_key' }) as Promise<{ status: string; settings: DesktopSettingsSnapshot }>
      await opened
      expect(await cancelableBackend.handle('auth.cancel_login')).toEqual({ accepted: true })
      const result = await login
      expect(result.status).toBe('cancelled')
      expect(result.settings.providers[0]?.configured).toBe(false)
    } finally {
      await cancelableBackend.close()
    }
  })

  test('returns confirmed plugin state only after the runtime applies it and preserves invalid status on failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'microcode-desktop-plugin-state-'))
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    const validPlugin = { name: 'sample-plugin', version: '1.0.0', description: 'Test', rootDir: cwd, scope: 'project' as const, valid: true, health: 'ready' as const, enabled: false, skills: [], servers: [], diagnostics: [] }
    let state: RuntimeSnapshot = {
      ...runtimeSnapshot(cwd),
      agent: { ...runtimeSnapshot(cwd).agent, skills: { available: [], loaded: [] } } as RuntimeSnapshot['agent'],
      plugins: { plugins: [validPlugin], skills: [], diagnostics: [] },
    }
    const runtime = {
      getSnapshot: () => state,
      subscribe: () => () => undefined,
      dispatch: async (envelope: RuntimeCommandEnvelope): Promise<RuntimeCommandResponse> => {
        if (envelope.command.type === 'plugin.set_enabled_many') {
          const enabled = envelope.command.states['sample-plugin']
          if (!state.plugins?.plugins[0]?.valid) {
            return { protocolVersion: 1, commandId: envelope.commandId, ok: false, error: { code: 'command_failed', message: 'Plugin is invalid and cannot be enabled.' } }
          }
          state = { ...state, plugins: { ...state.plugins, plugins: [{ ...state.plugins.plugins[0]!, enabled: Boolean(enabled) }] } }
        }
        return { protocolVersion: 1, commandId: envelope.commandId, ok: true, result: undefined }
      },
      close: async () => undefined,
    } as unknown as ApplicationRuntime
    const modelSettings = {
      getSnapshot: async () => ({ models: [], providers: [], mcpServers: [], mcpDiagnostics: [], plugins: null, skills: [], skillDiagnostics: [] }),
    } as unknown as DesktopModelSettings
    const backend = new DesktopBackend(async () => ({ runtime, startupWarnings: [], mcpReady: Promise.resolve() } satisfies RuntimeFactoryResult), undefined, modelSettings)

    try {
      await backend.handle('workspace.open', { cwd })
      const applied = await backend.handle('plugin.set_enabled', { scope: 'project', name: 'sample-plugin', enabled: true }) as DesktopSettingsSnapshot
      expect(applied.plugins?.plugins[0]?.enabled).toBe(true)

      state = { ...state, plugins: { plugins: [{ ...validPlugin, valid: false, health: 'invalid', enabled: false, diagnostics: ['Invalid manifest'] }], skills: [], diagnostics: ['Invalid manifest'] } }
      await expect(backend.handle('plugin.set_enabled', { scope: 'project', name: 'sample-plugin', enabled: true })).rejects.toThrow('Plugin is invalid')
      const status = await backend.handle('settings.list') as DesktopSettingsSnapshot
      expect(status.plugins?.plugins[0]).toMatchObject({ valid: false, health: 'invalid', enabled: false })
      expect(status.plugins?.diagnostics).toContain('Invalid manifest')
    } finally {
      await backend.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('restores pending approvals in snapshots and accepts each request only once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'microcode-desktop-backend-'))
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    let publishRuntimeEvent: ((event: RuntimeEvent) => void) | undefined
    let permissionDispatches = 0
    let closeCount = 0
    const fakeRuntime = {
      getSnapshot: () => runtimeSnapshot(cwd),
      subscribe: (listener: (event: RuntimeEvent) => void) => { publishRuntimeEvent = listener; return () => { publishRuntimeEvent = undefined } },
      dispatch: async (envelope: RuntimeCommandEnvelope) => {
        if (envelope.command.type === 'permission.respond') {
          permissionDispatches++
          publishRuntimeEvent?.({
            protocolVersion: 1,
            sequence: 2,
            emittedAt: 2,
            sessionId: 'session-1',
            type: 'permission.resolved',
            requestId: envelope.command.requestId,
            allowed: envelope.command.decision !== 'deny',
          })
          return { protocolVersion: 1, commandId: envelope.commandId, ok: true, result: { requestId: envelope.command.requestId, accepted: true } }
        }
        return { protocolVersion: 1, commandId: envelope.commandId, ok: true, result: undefined }
      },
      close: async () => { closeCount++ },
    } as unknown as ApplicationRuntime
    const backend = new DesktopBackend(async () => ({
      runtime: fakeRuntime,
      startupWarnings: [],
      mcpReady: Promise.resolve(),
    } satisfies RuntimeFactoryResult))

    try {
      await backend.handle('workspace.open', { cwd })
      publishRuntimeEvent?.({
        protocolVersion: 1,
        sequence: 1,
        emittedAt: 1,
        sessionId: 'session-1',
        type: 'permission.requested',
        request: { requestId: 'approval-1', sessionId: 'session-1', kind: 'tool', toolName: 'write', input: { path: 'a.ts' }, description: 'Write a.ts' },
      })
      expect(backend.getSnapshot().pendingPermissions.map((item) => item.requestId)).toEqual(['approval-1'])

      expect(await backend.handle('permission.respond', { requestId: 'approval-1', decision: 'allow' })).toEqual({ accepted: true })
      expect(backend.getSnapshot().pendingPermissions).toEqual([])
      expect(await backend.handle('permission.respond', { requestId: 'approval-1', decision: 'allow' })).toEqual({ accepted: false })
      expect(permissionDispatches).toBe(1)
    } finally {
      await backend.close()
      await rm(root, { recursive: true, force: true })
    }
    expect(closeCount).toBe(1)
  })

  test('forwards incremental stream events and routes cancellation without losing the terminal state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'microcode-desktop-cancel-'))
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    let publishRuntimeEvent: ((event: RuntimeEvent) => void) | undefined
    let finishPrompt: (() => void) | undefined
    let sequence = 0
    const events: RuntimeEvent[] = []
    const emit = (input: Omit<RuntimeEvent, 'protocolVersion' | 'sequence' | 'emittedAt' | 'sessionId'>) => {
      const event = { ...input, protocolVersion: 1, sequence: ++sequence, emittedAt: sequence, sessionId: 'session-1' } as RuntimeEvent
      events.push(event)
      publishRuntimeEvent?.(event)
    }
    const fakeRuntime = {
      getSnapshot: () => ({ ...runtimeSnapshot(cwd), sequence }),
      subscribe: (listener: (event: RuntimeEvent) => void) => { publishRuntimeEvent = listener; return () => { publishRuntimeEvent = undefined } },
      dispatch: async (envelope: RuntimeCommandEnvelope) => {
        const success = (result: unknown) => ({ protocolVersion: 1 as const, commandId: envelope.commandId, ok: true as const, result })
        if (envelope.command.type === 'agent.prompt') {
          emit({ type: 'prompt.started' })
          emit({
            type: 'agent.event',
            event: {
              type: 'message_update',
              agentId: 'agent-1',
              message: { role: 'assistant', id: 'assistant-1', timestamp: 1, content: [{ type: 'text', text: 'Partial response' }] },
              assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Partial response' },
            },
          } as unknown as Omit<RuntimeEvent, 'protocolVersion' | 'sequence' | 'emittedAt' | 'sessionId'>)
          await new Promise<void>((resolve) => {
            finishPrompt = () => {
              emit({ type: 'prompt.completed', aborted: true })
              resolve()
            }
          })
          return success(undefined)
        }
        if (envelope.command.type === 'agent.cancel') {
          finishPrompt?.()
          finishPrompt = undefined
        }
        return success(undefined)
      },
      close: async () => undefined,
    } as unknown as ApplicationRuntime
    const backend = new DesktopBackend(async () => ({ runtime: fakeRuntime, startupWarnings: [], mcpReady: Promise.resolve() } satisfies RuntimeFactoryResult))

    try {
      await backend.handle('workspace.open', { cwd })
      const prompt = backend.handle('prompt.send', { prompt: 'Test cancel handling.' })
      expect(events.map((event) => event.type)).toEqual(['prompt.started', 'agent.event'])
      const cancellation = backend.handle('prompt.cancel')
      await Promise.all([prompt, cancellation])
      expect(events.at(-1)).toMatchObject({ type: 'prompt.completed', aborted: true })
      expect(sequence).toBe(3)
    } finally {
      await backend.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
