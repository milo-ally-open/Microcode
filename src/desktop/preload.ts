import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge, DesktopEvent } from './protocol.ts'
import type { PermissionMode } from '../permissions/types.ts'
import type { ImageContent } from '@earendil-works/pi-ai'
import type { DesktopModelOption } from './protocol.ts'
import type { AuthType } from '@earendil-works/pi-ai'
import type { PluginScope } from '../plugins/types.ts'

const bridge: DesktopBridge = Object.freeze({
  bootstrap: () => ipcRenderer.invoke('desktop:bootstrap'),
  retryBackend: () => ipcRenderer.invoke('desktop:retry-backend'),
  chooseWorkspace: () => ipcRenderer.invoke('desktop:choose-workspace'),
  openRecentProject: (projectId: string) => ipcRenderer.invoke('desktop:open-recent-project', { projectId }),
  getSnapshot: () => ipcRenderer.invoke('desktop:get-snapshot'),
  listSessions: () => ipcRenderer.invoke('desktop:list-sessions'),
  startNewSession: () => ipcRenderer.invoke('desktop:new-session'),
  selectSession: (sessionId: string) => ipcRenderer.invoke('desktop:select-session', { sessionId }),
  sendPrompt: (prompt: string, images?: readonly ImageContent[]) => ipcRenderer.invoke('desktop:send-prompt', { prompt, ...(images ? { images } : {}) }),
  cancelPrompt: () => ipcRenderer.invoke('desktop:cancel-prompt'),
  respondToPermission: (requestId: string, decision: 'allow' | 'allow_session' | 'deny', answers?: Readonly<Record<string, string>>, block?: boolean) => ipcRenderer.invoke('desktop:respond-permission', {
    requestId,
    decision,
    ...(answers ? { answers } : {}),
    ...(block === undefined ? {} : { block }),
  }),
  setPermissionMode: (mode: PermissionMode) => ipcRenderer.invoke('desktop:set-permission-mode', { mode }),
  listModels: () => ipcRenderer.invoke('desktop:list-models'),
  switchModel: (model: Pick<DesktopModelOption, 'id' | 'provider' | 'api'>) => ipcRenderer.invoke('desktop:switch-model', model),
  getSettingsSnapshot: () => ipcRenderer.invoke('desktop:get-settings'),
  loginProvider: (providerId: string, authType: AuthType) => ipcRenderer.invoke('desktop:login-provider', { providerId, authType }),
  logoutProvider: (providerId: string) => ipcRenderer.invoke('desktop:logout-provider', { providerId }),
  cancelProviderLogin: () => ipcRenderer.invoke('desktop:cancel-provider-login'),
  setMcpEnabled: (name: string, enabled: boolean, confirmed?: boolean) => ipcRenderer.invoke('desktop:set-mcp-enabled', { name, enabled, ...(confirmed ? { confirmed: true } : {}) }),
  setPluginEnabled: (scope: PluginScope, name: string, enabled: boolean, confirmed?: boolean) => ipcRenderer.invoke('desktop:set-plugin-enabled', { scope, name, enabled, ...(confirmed ? { confirmed: true } : {}) }),
  setSkillLoaded: (name: string, loaded: boolean) => ipcRenderer.invoke('desktop:set-skill-loaded', { name, loaded }),
  reviewStatus: () => ipcRenderer.invoke('desktop:review-status'),
  readDiff: (path: string) => ipcRenderer.invoke('desktop:read-diff', { path }),
  chooseImages: () => ipcRenderer.invoke('desktop:choose-images'),
  createTerminal: (cols: number, rows: number) => ipcRenderer.invoke('desktop:terminal-create', { cols, rows }),
  writeTerminal: (terminalId: string, data: string) => ipcRenderer.invoke('desktop:terminal-write', { terminalId, data }),
  resizeTerminal: (terminalId: string, cols: number, rows: number) => ipcRenderer.invoke('desktop:terminal-resize', { terminalId, cols, rows }),
  closeTerminal: (terminalId: string) => ipcRenderer.invoke('desktop:terminal-close', { terminalId }),
  onEvent: (listener: (event: DesktopEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: DesktopEvent) => listener(payload)
    ipcRenderer.on('desktop:event', handler)
    return () => ipcRenderer.removeListener('desktop:event', handler)
  },
})

contextBridge.exposeInMainWorld('microcodeDesktop', bridge)
