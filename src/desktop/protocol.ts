import type { Api, AuthType, ImageContent, Model } from '@earendil-works/pi-ai'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { PermissionMode } from '../permissions/types.ts'
import type { RuntimeEvent, RuntimeMcpServerSnapshot, RuntimePermissionRequest, RuntimePluginSnapshot, RuntimeSnapshot } from '../runtime/protocol.ts'
import type { DesktopTerminalEvent } from './TerminalManager.ts'
import type { PluginScope } from '../plugins/types.ts'

export const DESKTOP_TRANSPORT_PROTOCOL_VERSION = 1 as const

export interface DesktopProjectRef {
  readonly id: string
  readonly path: string
  readonly name: string
}

export interface DesktopBackendSnapshot {
  readonly workspace: string | null
  readonly runtime: RuntimeSnapshot | null
  readonly pendingPermissions: readonly RuntimePermissionRequest[]
  readonly startupWarnings: readonly string[]
}

export type DesktopBackendStatus = Extract<DesktopEvent, { readonly type: 'backend.status' }>

export type DesktopEvent =
  | {
      readonly type: 'backend.status'
      readonly status: 'starting' | 'ready' | 'failed' | 'closed'
      readonly message?: string
      readonly appVersion?: string
      readonly runtimeProtocolVersion?: number
    }
  | { readonly type: 'runtime.event'; readonly event: RuntimeEvent }
  | { readonly type: 'workspace.changed'; readonly snapshot: DesktopBackendSnapshot }
  | DesktopTerminalEvent

export interface DesktopModelOption {
  readonly id: string
  readonly provider: string
  readonly api: Model<Api>['api']
  readonly name: string
  readonly contextWindow: number
  readonly authentication: 'configured' | 'missing' | 'error'
  readonly authType?: AuthType
  readonly authSource?: string
}

export interface DesktopAuthProvider {
  readonly id: string
  readonly name: string
  readonly configured: boolean
  readonly authType?: AuthType
  readonly source?: string
  readonly savedCredential: boolean
  readonly statusError?: boolean
  readonly choices: readonly Readonly<{ type: AuthType; label: string; description: string }>[]
}

export interface DesktopSettingsMcpServer extends RuntimeMcpServerSnapshot {
  readonly scope: 'system' | 'user' | 'project' | 'legacy' | 'path' | 'plugin' | 'runtime'
  readonly summary: string
  readonly transport: 'stdio' | 'remote'
  readonly enabled: boolean
  readonly confirmationRequired: boolean
}

export interface DesktopSettingsSkill {
  readonly name: string
  readonly description: string
  readonly loaded: boolean
  readonly scope?: string
}

export interface DesktopSettingsSnapshot {
  readonly models: readonly DesktopModelOption[]
  readonly providers: readonly DesktopAuthProvider[]
  readonly mcpServers: readonly DesktopSettingsMcpServer[]
  readonly mcpDiagnostics: readonly string[]
  readonly plugins: RuntimePluginSnapshot | null
  readonly skills: readonly DesktopSettingsSkill[]
  readonly skillDiagnostics: readonly string[]
}

export interface DesktopReviewChange {
  readonly path: string
  readonly previousPath?: string
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
  readonly status: string
}

export interface DesktopReviewSnapshot {
  readonly available: boolean
  readonly root?: string
  readonly branch?: string
  readonly ahead?: number
  readonly behind?: number
  readonly changes: readonly DesktopReviewChange[]
  readonly message?: string
}

export interface DesktopFileDiff {
  readonly path: string
  readonly text: string
  readonly truncated: boolean
  readonly binary: boolean
}

export interface DesktopImageAttachment {
  readonly name: string
  readonly image: ImageContent
}

export interface DesktopBridge {
  bootstrap(): Promise<{ readonly backendStatus: DesktopBackendStatus; readonly recentProjects: readonly DesktopProjectRef[]; readonly logsPath: string; readonly snapshot: DesktopBackendSnapshot | null }>
  retryBackend(): Promise<void>
  chooseWorkspace(): Promise<DesktopBackendSnapshot | null>
  openRecentProject(projectId: string): Promise<DesktopBackendSnapshot>
  getSnapshot(): Promise<DesktopBackendSnapshot>
  listSessions(): Promise<readonly unknown[]>
  startNewSession(): Promise<DesktopBackendSnapshot>
  selectSession(sessionId: string): Promise<DesktopBackendSnapshot>
  sendPrompt(prompt: string, images?: readonly ImageContent[]): Promise<void>
  cancelPrompt(): Promise<void>
  respondToPermission(requestId: string, decision: 'allow' | 'allow_session' | 'deny', answers?: Readonly<Record<string, string>>, block?: boolean): Promise<{ readonly accepted: boolean }>
  setPermissionMode(mode: PermissionMode): Promise<void>
  listModels(): Promise<readonly DesktopModelOption[]>
  switchModel(model: Pick<DesktopModelOption, 'id' | 'provider' | 'api'>): Promise<DesktopBackendSnapshot>
  getSettingsSnapshot(): Promise<DesktopSettingsSnapshot>
  loginProvider(providerId: string, authType: AuthType): Promise<{ readonly status: 'signed_in' | 'cancelled'; readonly settings: DesktopSettingsSnapshot }>
  logoutProvider(providerId: string): Promise<DesktopSettingsSnapshot>
  cancelProviderLogin(): Promise<{ readonly accepted: boolean }>
  setMcpEnabled(name: string, enabled: boolean, confirmed?: boolean): Promise<DesktopSettingsSnapshot>
  setPluginEnabled(scope: PluginScope, name: string, enabled: boolean, confirmed?: boolean): Promise<DesktopSettingsSnapshot>
  setSkillLoaded(name: string, loaded: boolean): Promise<DesktopSettingsSnapshot>
  reviewStatus(): Promise<DesktopReviewSnapshot>
  readDiff(path: string): Promise<DesktopFileDiff>
  chooseImages(): Promise<readonly DesktopImageAttachment[]>
  createTerminal(cols: number, rows: number): Promise<string>
  writeTerminal(terminalId: string, data: string): Promise<void>
  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void>
  closeTerminal(terminalId: string): Promise<void>
  onEvent(listener: (event: DesktopEvent) => void): () => void
}

declare global {
  interface Window {
    readonly microcodeDesktop: DesktopBridge
  }
}

export type DesktopMessage = AgentMessage
