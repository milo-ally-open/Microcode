import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Api, AuthType, ImageContent } from '@earendil-works/pi-ai'
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'
import type { PermissionMode } from '../permissions/types.ts'
import { ensureBootstrapMacro } from '../macro.ts'
import { GitRepository } from '../git/GitRepository.ts'
import { RuntimeFactory } from '../runtime/RuntimeFactory.ts'
import { McpClientManager } from '../mcp/client.ts'
import { discoverMcpCapabilities, safeMcpConfigSummary } from '../mcp/capabilities.ts'
import type { PluginScope } from '../plugins/types.ts'
import type { RuntimeCommand, RuntimeCommandResponse, RuntimeEvent, RuntimePermissionRequest } from '../runtime/protocol.ts'
import type { ApplicationRuntime } from '../runtime/ApplicationRuntime.ts'
import type { RuntimeFactoryResult } from '../runtime/RuntimeFactory.ts'
import type { DesktopBackendSnapshot, DesktopEvent, DesktopFileDiff, DesktopModelOption, DesktopReviewSnapshot, DesktopSettingsMcpServer, DesktopSettingsSnapshot } from './protocol.ts'
import { DesktopTerminalManager } from './TerminalManager.ts'
import { DesktopRequestError, isLikelySecretFile, redactDisplayText } from './security.ts'
import { DesktopModelSettings } from './settings.ts'
import { openProviderAuthUrl, promptForProviderAuth, showDeviceCode, type ProviderAuthPrompt } from './authPrompt.ts'

// The desktop backend is bundled as its own Bun executable entry point. Register
// statically bundled OAuth implementations here as well as in the CLI entry.
registerBunOAuthFlows()

const MAX_DIFF_BYTES = 512 * 1024
const MAX_UNTRACKED_BYTES = 256 * 1024
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

type Runtime = Pick<ApplicationRuntime, 'getSnapshot' | 'subscribe' | 'dispatch' | 'close'>
interface DesktopRuntimeFactoryResult extends RuntimeFactoryResult {
  readonly mcpManager?: McpClientManager
}
type RuntimeCreator = (cwd: string) => Promise<DesktopRuntimeFactoryResult>
type GitRepositoryOpener = (cwd: string) => Promise<GitRepository>
type Listener = (event: DesktopEvent) => void

async function createDesktopRuntime(cwd: string): Promise<DesktopRuntimeFactoryResult> {
  const mcpManager = new McpClientManager()
  const created = await RuntimeFactory.create({ cwd, microcodeVersion: '0.1.0', mcp: mcpManager })
  return { ...created, mcpManager }
}

function errorText(error: unknown): string {
  return redactDisplayText(error instanceof Error ? error.message : String(error))
}

function authSmokeDiagnostic(error: unknown): string {
  return errorText(error)
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b(code|state|verifier|challenge|access_token|refresh_token)=\S+/gi, '$1=[redacted]')
    .slice(0, 240)
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function requireString(value: unknown, field: string, maxLength: number, nonEmpty = true): string {
  if (typeof value !== 'string' || (nonEmpty && !value.trim()) || value.length > maxLength || value.includes('\0')) {
    throw new DesktopRequestError('invalid_request', `Invalid ${field}.`)
  }
  return value
}

function requireImages(value: unknown): readonly ImageContent[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 4) throw new DesktopRequestError('invalid_request', 'Choose up to four images.')
  const images = value.map((entry) => {
    const image = object(entry)
    if (!image || Object.keys(image).some((key) => !['type', 'mimeType', 'data'].includes(key))
      || image.type !== 'image'
      || typeof image.mimeType !== 'string'
      || !IMAGE_MIME_TYPES.has(image.mimeType)
      || typeof image.data !== 'string'
      || image.data.length > 12 * 1024 * 1024
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) {
      throw new DesktopRequestError('invalid_request', 'The selected image is invalid or too large.')
    }
    return image as unknown as ImageContent
  })
  return Object.freeze(images)
}

function unwrap<T>(response: RuntimeCommandResponse<T>): T {
  if (!response.ok) throw new DesktopRequestError('backend_unavailable', `${response.error.code}: ${response.error.message}`)
  return response.result
}

function withinDirectory(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** Desktop-only adapter. It owns the current project runtime and exposes read-only review data. */
export class DesktopBackend {
  private runtime?: Runtime
  private unsubscribeRuntime?: () => void
  private mcpManager?: McpClientManager
  private workspace?: string
  private startupWarnings: readonly string[] = Object.freeze([])
  private readonly pendingPermissions = new Map<string, RuntimePermissionRequest>()
  private readonly listeners = new Set<Listener>()
  private readonly terminals = new DesktopTerminalManager((event) => this.publish(event))
  private readonly modelSettings: DesktopModelSettings
  private authController?: AbortController
  private commandNumber = 0
  private closed = false

  constructor(
    private readonly createRuntime: RuntimeCreator = createDesktopRuntime,
    private readonly openGitRepository: GitRepositoryOpener = (cwd) => GitRepository.open(cwd),
    modelSettings: DesktopModelSettings = new DesktopModelSettings(),
    private readonly promptAuth: ProviderAuthPrompt = promptForProviderAuth,
    private readonly openAuthUrl: (url: string) => Promise<void> = openProviderAuthUrl,
    private readonly displayDeviceCode: typeof showDeviceCode = showDeviceCode,
  ) {
    this.modelSettings = modelSettings
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): DesktopBackendSnapshot {
    return Object.freeze({
      workspace: this.workspace ?? null,
      runtime: this.runtime?.getSnapshot() ?? null,
      pendingPermissions: Object.freeze([...this.pendingPermissions.values()]),
      startupWarnings: this.startupWarnings,
    })
  }

  async handle(method: string, payload?: unknown): Promise<unknown> {
    if (this.closed && method !== 'app.close') throw new DesktopRequestError('backend_unavailable', 'Desktop backend is closed.')
    switch (method) {
      case 'app.ready': return this.getSnapshot()
      case 'workspace.open': return this.openWorkspace(requireString(object(payload)?.cwd, 'workspace path', 4096))
      case 'snapshot.get': return this.getSnapshot()
      case 'sessions.list': return this.command({ type: 'session.list', cwd: this.requireWorkspace(), withTitles: true })
      case 'session.new': {
        this.command({ type: 'session.begin_draft', cwd: this.requireWorkspace() })
        return this.getSnapshot()
      }
      case 'session.select': {
        const sessionId = requireString(object(payload)?.sessionId, 'session ID', 128)
        this.command({ type: 'session.resume', sessionId, cwd: this.requireWorkspace() })
        return this.getSnapshot()
      }
      case 'prompt.send': {
        const request = object(payload)
        const prompt = requireString(request?.prompt, 'prompt', 120_000)
        const images = requireImages(request?.images)
        this.command({ type: 'agent.prompt', prompt, ...(images ? { images } : {}) })
        return undefined
      }
      case 'prompt.cancel': this.command({ type: 'agent.cancel' }); return undefined
      case 'permission.respond': {
        const request = object(payload)
        const requestId = requireString(request?.requestId, 'permission request ID', 128)
        if (!this.pendingPermissions.has(requestId)) return Object.freeze({ accepted: false })
        const decision = request?.decision
        const answers = object(request?.answers)
        if (decision !== 'allow' && decision !== 'allow_session' && decision !== 'deny') {
          throw new DesktopRequestError('invalid_request', 'Unsupported permission decision.')
        }
        const result = await this.command({
          type: 'permission.respond',
          requestId,
          decision,
          ...(answers ? { answers: answers as Readonly<Record<string, string>> } : {}),
          ...(typeof request?.block === 'boolean' ? { block: request.block } : {}),
        })
        return Object.freeze({ accepted: object(result)?.accepted === true })
      }
      case 'permission.set_mode': {
        const mode = object(payload)?.mode
        if (typeof mode !== 'string' || !['interactive', 'auto-approve', 'plan'].includes(mode)) throw new DesktopRequestError('invalid_request', 'Permission mode is invalid.')
        this.command({ type: 'permission.set_mode', mode: mode as PermissionMode })
        return undefined
      }
      case 'models.list': return this.modelSettings.listModels()
      case 'model.switch': {
        const model = object(payload)
        const selection = {
          id: requireString(model?.id, 'model ID', 160),
          provider: requireString(model?.provider, 'model provider', 120),
          api: requireString(model?.api, 'model API', 120) as Api,
        }
        await this.modelSettings.assertModelConfigured(selection)
        await this.command({
          type: 'model.switch',
          modelId: selection.id,
          provider: selection.provider,
          api: selection.api,
        })
        return this.getSnapshot()
      }
      case 'settings.list': return this.getSettingsSnapshot()
      case 'auth.login': {
        const request = object(payload)
        const providerId = requireString(request?.providerId, 'provider ID', 120)
        const authType = request?.authType
        if (authType !== 'oauth' && authType !== 'api_key') throw new DesktopRequestError('invalid_request', 'Unsupported provider sign-in method.')
        return this.loginProvider(providerId, authType)
      }
      case 'auth.logout': {
        const providerId = requireString(object(payload)?.providerId, 'provider ID', 120)
        await this.modelSettings.logout(providerId)
        return this.getSettingsSnapshot()
      }
      case 'auth.cancel_login': {
        if (!this.authController) return Object.freeze({ accepted: false })
        this.authController.abort()
        return Object.freeze({ accepted: true })
      }
      case 'mcp.set_enabled': {
        const request = object(payload)
        const name = requireString(request?.name, 'MCP server name', 120)
        if (typeof request?.enabled !== 'boolean' || (request.confirmed !== undefined && typeof request.confirmed !== 'boolean')) {
          throw new DesktopRequestError('invalid_request', 'MCP server settings are invalid.')
        }
        const current = (await this.getSettingsSnapshot()).mcpServers.find((server) => server.name === name)
        if (!current) throw new DesktopRequestError('invalid_request', 'That MCP server is no longer available.')
        if (request.enabled && current.confirmationRequired && request.confirmed !== true) {
          throw new DesktopRequestError('invalid_request', 'Confirm the command that this MCP server will run before enabling it.')
        }
        const manager = this.mcpManager
        if (!manager) throw new DesktopRequestError('backend_unavailable', 'MCP manager is unavailable for this workspace.')
        const changed = await manager.setServerEnabled(name, request.enabled)
        if (!changed) throw new DesktopRequestError('invalid_request', 'That MCP server is no longer available.')
        await this.command({ type: 'mcp.sync' })
        return this.getSettingsSnapshot()
      }
      case 'plugin.set_enabled': {
        const request = object(payload)
        const scope = request?.scope
        if (scope !== 'user' && scope !== 'project') throw new DesktopRequestError('invalid_request', 'Plugin scope is invalid.')
        const name = requireString(request?.name, 'plugin name', 128)
        if (typeof request?.enabled !== 'boolean' || (request.confirmed !== undefined && typeof request.confirmed !== 'boolean')) {
          throw new DesktopRequestError('invalid_request', 'Plugin settings are invalid.')
        }
        const plugin = this.runtime?.getSnapshot().plugins?.plugins.find((entry) => entry.name === name && entry.scope === scope)
        if (!plugin) throw new DesktopRequestError('invalid_request', 'That plugin is no longer available.')
        if (request.enabled && plugin.servers.some((server) => server.transport === 'stdio') && request.confirmed !== true) {
          throw new DesktopRequestError('invalid_request', 'Confirm the plugin command before enabling this plugin.')
        }
        await this.command({ type: 'plugin.set_enabled_many', scope: scope as PluginScope, states: { [name]: request.enabled } })
        return this.getSettingsSnapshot()
      }
      case 'skill.set_loaded': {
        const request = object(payload)
        const name = requireString(request?.name, 'skill name', 160)
        if (typeof request?.loaded !== 'boolean') throw new DesktopRequestError('invalid_request', 'Skill settings are invalid.')
        const skill = this.runtime?.getSnapshot().agent.skills.available.find((entry) => entry.name === name)
        if (!skill) throw new DesktopRequestError('invalid_request', 'That skill is no longer available.')
        await this.command({ type: request.loaded ? 'skill.load' : 'skill.unload', name })
        return this.getSettingsSnapshot()
      }
      case 'review.status': return this.reviewStatus()
      case 'review.diff': return this.readDiff(requireString(object(payload)?.path, 'file path', 4096))
      case 'terminal.create': {
        const request = object(payload)
        return this.terminals.create(this.requireWorkspace(), requireInteger(request?.cols, 'terminal columns'), requireInteger(request?.rows, 'terminal rows'))
      }
      case 'terminal.write': {
        const request = object(payload)
        this.terminals.write(requireString(request?.terminalId, 'terminal ID', 128), requireString(request?.data, 'terminal input', 64 * 1024, false))
        return undefined
      }
      case 'terminal.resize': {
        const request = object(payload)
        this.terminals.resize(requireString(request?.terminalId, 'terminal ID', 128), requireInteger(request?.cols, 'terminal columns'), requireInteger(request?.rows, 'terminal rows'))
        return undefined
      }
      case 'terminal.close': return this.terminals.close(requireString(object(payload)?.terminalId, 'terminal ID', 128))
      case 'app.close': await this.close(); return undefined
      default: throw new DesktopRequestError('invalid_request', `Unsupported desktop operation: ${method}.`)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const runtime = this.runtime
    this.runtime = undefined
    this.mcpManager = undefined
    this.unsubscribeRuntime?.()
    this.unsubscribeRuntime = undefined
    this.pendingPermissions.clear()
    this.authController?.abort()
    this.authController = undefined
    await this.terminals.closeAll()
    if (runtime) await runtime.close()
    this.publish({ type: 'backend.status', status: 'closed' })
  }

  private async openWorkspace(candidate: string): Promise<DesktopBackendSnapshot> {
    const canonical = await realpath(resolve(candidate)).catch(() => {
      throw new DesktopRequestError('workspace_unavailable', 'The selected folder cannot be opened.')
    })
    const details = await stat(canonical).catch(() => null)
    if (!details?.isDirectory()) throw new DesktopRequestError('workspace_unavailable', 'Choose an existing project folder.')

    let created: DesktopRuntimeFactoryResult
    try {
      ensureBootstrapMacro()
      created = await this.createRuntime(canonical)
    } catch (error) {
      throw new DesktopRequestError('workspace_unavailable', errorText(error))
    }

    const previous = this.runtime
    await this.terminals.closeAll()
    this.unsubscribeRuntime?.()
    this.runtime = created.runtime
    this.mcpManager = created.mcpManager
    this.workspace = canonical
    this.startupWarnings = Object.freeze(created.startupWarnings.map((warning) => redactDisplayText(warning)))
    this.pendingPermissions.clear()
    this.unsubscribeRuntime = created.runtime.subscribe((event) => this.onRuntimeEvent(event))
    if (previous) await previous.close().catch(() => undefined)
    const snapshot = this.getSnapshot()
    this.publish({ type: 'workspace.changed', snapshot })
    void created.mcpReady.catch(() => undefined)
    return snapshot
  }

  private async command(command: RuntimeCommand): Promise<unknown> {
    const runtime = this.requireRuntime()
    const response = await runtime.dispatch({ commandId: `desktop-${++this.commandNumber}`, command })
    return unwrap(response)
  }

  private async getSettingsSnapshot(): Promise<DesktopSettingsSnapshot> {
    const [modelSnapshot, capabilities] = await Promise.all([
      this.modelSettings.getSnapshot(),
      this.workspace
        ? discoverMcpCapabilities(this.workspace)
        : Promise.resolve({ servers: [], diagnostics: [] }),
    ])
    const runtime = this.runtime?.getSnapshot() ?? null
    const stateByName = new Map((runtime?.mcpServers ?? []).map((server) => [server.name, server]))
    const serverOptions = new Map<string, DesktopSettingsMcpServer>()
    const addServer = (
      name: string,
      scope: DesktopSettingsMcpServer['scope'],
      summary: string,
      transport: DesktopSettingsMcpServer['transport'],
    ) => {
      if (serverOptions.has(name)) return
      const state = stateByName.get(name)
      const status = state?.status ?? 'disconnected'
      serverOptions.set(name, Object.freeze({
        name,
        scope,
        summary: redactDisplayText(summary),
        transport,
        status,
        enabled: state ? state.status !== 'disabled' : false,
        confirmationRequired: transport === 'stdio',
        error: state?.error,
        tools: state?.tools ?? Object.freeze([]),
        resources: state?.resources ?? Object.freeze([]),
        instructions: state?.instructions,
      }))
    }

    for (const server of capabilities.servers) {
      addServer(server.name, server.scope, safeMcpConfigSummary(server.config), 'command' in server.config ? 'stdio' : 'remote')
    }
    for (const plugin of runtime?.plugins?.plugins ?? []) {
      if (!plugin.enabled) continue
      for (const server of plugin.servers) {
        addServer(server.qualifiedName, 'plugin', server.safeCommandSummary, server.transport === 'stdio' ? 'stdio' : 'remote')
      }
    }
    for (const state of runtime?.mcpServers ?? []) {
      addServer(state.name, 'runtime', 'MCP server', 'remote')
    }

    const loadedSkills = new Set((runtime?.agent.skills.loaded ?? []).map((skill) => skill.name))
    const skills = (runtime?.agent.skills.available ?? []).map((skill) => Object.freeze({
      name: skill.name,
      description: redactDisplayText(skill.description),
      loaded: loadedSkills.has(skill.name),
      ...(skill.scope ? { scope: skill.scope } : {}),
    }))
    return Object.freeze({
      ...modelSnapshot,
      mcpServers: Object.freeze([...serverOptions.values()]),
      mcpDiagnostics: Object.freeze(capabilities.diagnostics.map(redactDisplayText)),
      plugins: runtime?.plugins ?? null,
      skills: Object.freeze(skills),
      skillDiagnostics: Object.freeze((runtime?.agent.skills.diagnostics ?? []).map(redactDisplayText)),
    })
  }

  private async loginProvider(providerId: string, authType: AuthType): Promise<{
    readonly status: 'signed_in' | 'cancelled'
    readonly settings: DesktopSettingsSnapshot
  }> {
    if (this.authController) throw new DesktopRequestError('backend_unavailable', 'Another provider sign-in is already in progress.')
    const controller = new AbortController()
    this.authController = controller
    let notificationFailed = false
    try {
      await this.modelSettings.login(providerId, authType, {
        signal: controller.signal,
        prompt: async (prompt) => {
          const signal = prompt.signal ? AbortSignal.any([controller.signal, prompt.signal]) : controller.signal
          try {
            return await this.promptAuth(prompt, signal)
          } catch (error) {
            if (signal.aborted || /cancel(?:led|ed)/i.test(error instanceof Error ? error.message : String(error))) {
              controller.abort()
              throw new Error('Authentication cancelled.')
            }
            throw error
          }
        },
        notify: (event) => {
          if (event.type === 'auth_url') {
            void this.openAuthUrl(event.url).catch(() => {
              notificationFailed = true
              controller.abort()
            })
          } else if (event.type === 'device_code') {
            void this.displayDeviceCode(event).catch(() => {
              notificationFailed = true
              controller.abort()
            })
          }
          // Provider text notifications are deliberately not forwarded to renderer or logs.
        },
      })
      const settings = await this.getSettingsSnapshot()
      const provider = settings.providers.find((item) => item.id === providerId)
      if (!provider?.configured) throw new Error('Sign-in did not produce a verified provider credential.')
      return Object.freeze({ status: 'signed_in', settings })
    } catch (error) {
      if (controller.signal.aborted && !notificationFailed) {
        return Object.freeze({ status: 'cancelled', settings: await this.getSettingsSnapshot() })
      }
      const smokeDiagnostic = process.env.MICROCODE_DESKTOP_SMOKE_TEST === '1'
        ? ` (${authSmokeDiagnostic(error)})`
        : ''
      const message = notificationFailed
        ? 'The system browser or native sign-in prompt could not be opened.'
        : `Provider sign-in failed. Review the provider status and try again.${smokeDiagnostic}`
      throw new DesktopRequestError('backend_unavailable', message)
    } finally {
      if (this.authController === controller) this.authController = undefined
    }
  }

  private async reviewStatus(): Promise<DesktopReviewSnapshot> {
    const cwd = this.requireWorkspace()
    try {
      const repository = await this.openGitRepository(cwd)
      const status = await repository.status()
      return Object.freeze({
        available: true,
        root: status.root,
        branch: status.branch,
        ahead: status.ahead,
        behind: status.behind,
        changes: Object.freeze(status.changes.map((change) => Object.freeze({
          path: change.path,
          ...(change.previousPath ? { previousPath: change.previousPath } : {}),
          staged: change.staged,
          unstaged: change.unstaged,
          untracked: change.untracked,
          status: `${change.indexStatus}${change.worktreeStatus}`.trim() || 'M',
        }))),
      })
    } catch (error) {
      return Object.freeze({ available: false, changes: Object.freeze([]), message: errorText(error) })
    }
  }

  private async readDiff(pathValue: string): Promise<DesktopFileDiff> {
    const cwd = this.requireWorkspace()
    const path = pathValue.replaceAll('\\', '/')
    const parts = path.split('/')
    if (path.startsWith('/') || parts.includes('..') || path.includes(':') || !path) {
      throw new DesktopRequestError('invalid_request', 'Select a file inside the current repository.')
    }
    if (isLikelySecretFile(path)) {
      return Object.freeze({ path, text: 'Diff hidden because this file name suggests credentials or private key material.', truncated: false, binary: false })
    }
    const repository = await this.openGitRepository(cwd)
    const status = await repository.status()
    const change = status.changes.find((entry) => entry.path.replaceAll('\\', '/') === path)
    if (!change) throw new DesktopRequestError('invalid_request', 'This file is no longer listed as changed.')

    if (change.untracked) {
      const rootPath = await realpath(repository.root)
      const fullPath = await realpath(resolve(repository.root, path)).catch(() => '')
      if (!fullPath || !withinDirectory(rootPath, fullPath)) {
        throw new DesktopRequestError('invalid_request', 'The selected file resolves outside the repository.')
      }
      const details = await stat(fullPath)
      if (!details.isFile()) throw new DesktopRequestError('invalid_request', 'Select a regular file to review.')
      if (details.size > MAX_UNTRACKED_BYTES) {
        return Object.freeze({ path, text: `Untracked file is larger than ${MAX_UNTRACKED_BYTES / 1024} KiB.`, truncated: false, binary: false })
      }
      const bytes = await readFile(fullPath)
      const binary = bytes.includes(0)
      const text = binary ? 'Binary file; preview is not available.' : `New file: ${path}\n\n${bytes.toString('utf8')}`
      return Object.freeze({ path, text: redactDisplayText(text), truncated: false, binary })
    }

    const diffPaths = change.previousPath ? [change.previousPath, path] : [path]
    const [staged, unstaged] = await Promise.all([
      change.staged ? repository.diff(true, diffPaths) : Promise.resolve(''),
      change.unstaged ? repository.diff(false, diffPaths) : Promise.resolve(''),
    ])
    const text = [staged && `Staged changes\n${staged}`, unstaged && `Unstaged changes\n${unstaged}`].filter(Boolean).join('\n')
    const truncated = Buffer.byteLength(text, 'utf8') > MAX_DIFF_BYTES
    const prefix = Buffer.from(text, 'utf8').subarray(0, MAX_DIFF_BYTES).toString('utf8')
    const binary = /Binary files .* differ/.test(text)
    return Object.freeze({
      path,
      text: binary ? 'Binary file; textual diff is not available.' : redactDisplayText(truncated ? `${prefix}\n\n[Diff truncated at 512 KiB]` : text || 'No text diff is available.'),
      truncated,
      binary,
    })
  }

  private requireWorkspace(): string {
    if (!this.workspace) throw new DesktopRequestError('workspace_unavailable', 'Open a project folder first.')
    return this.workspace
  }

  private requireRuntime(): Runtime {
    if (!this.runtime) throw new DesktopRequestError('workspace_unavailable', 'Open a project folder first.')
    return this.runtime
  }

  private onRuntimeEvent(event: RuntimeEvent): void {
    if (event.type === 'permission.requested') this.pendingPermissions.set(event.request.requestId, event.request)
    if (event.type === 'permission.resolved') this.pendingPermissions.delete(event.requestId)
    this.publish({ type: 'runtime.event', event })
  }

  private publish(event: DesktopEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch { /* A disconnected renderer cannot interrupt Agent work. */ }
    }
  }
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1000) {
    throw new DesktopRequestError('invalid_request', `Invalid ${field}.`)
  }
  return value
}
