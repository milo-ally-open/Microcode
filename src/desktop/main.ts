import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, delimiter, extname, join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { DesktopBackendHost } from './DesktopBackendHost.ts'
import { formatRendererFailureDiagnostic } from './diagnostics.ts'
import type { DesktopBackendSnapshot, DesktopImageAttachment, DesktopProjectRef } from './protocol.ts'
import { DesktopRequestError, redactDisplayText, validateRendererIpc } from './security.ts'
import { DESKTOP_APP_VERSION } from './buildInfo.ts'

if (process.argv.includes('--microcode-smoke-test')) process.env.MICROCODE_DESKTOP_SMOKE_TEST = '1'

const mainDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(mainDirectory, '../..')
const rendererEntry = join(mainDirectory, 'index.html')
app.setName('Microcode')
const packagedGitRoot = app.isPackaged ? join(process.resourcesPath, 'git') : undefined
function recentProjectsFile(): string {
  return join(app.getPath('userData'), 'recent-projects.json')
}
const MAX_RECENT_PROJECTS = 12
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
})

const backend = new DesktopBackendHost(projectRoot, {
  ...(app.isPackaged ? {
    backendExecutable: join(process.resourcesPath, 'microcode-backend.exe'),
    backendArguments: ['run', join(process.resourcesPath, 'backend.mjs')],
  } : {}),
  ...(packagedGitRoot ? {
    environment: {
      MICROCODE_GIT_BASH_EXECUTABLE: join(packagedGitRoot, 'bin', 'bash.exe'),
      NAPI_RS_NATIVE_LIBRARY_PATH: join(process.resourcesPath, 'keyring.win32-x64-msvc.node'),
      PATH: [join(packagedGitRoot, 'cmd'), join(packagedGitRoot, 'mingw64', 'bin'), join(packagedGitRoot, 'usr', 'bin'), process.env.PATH ?? ''].join(delimiter),
    },
  } : {}),
  expectedAppVersion: DESKTOP_APP_VERSION,
  workingDirectory: projectRoot,
})
let mainWindow: BrowserWindow | null = null
let lastWorkspace: string | undefined
let isQuitting = false
let shutdownReady = false

function projectId(path: string): string {
  return createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex').slice(0, 20)
}

function projectRef(path: string): DesktopProjectRef {
  return Object.freeze({ id: projectId(path), path, name: basename(path) || path })
}

async function readRecentProjects(): Promise<DesktopProjectRef[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(recentProjectsFile(), 'utf8'))
    if (!Array.isArray(parsed)) return []
    const existing: DesktopProjectRef[] = []
    for (const item of parsed.slice(0, MAX_RECENT_PROJECTS)) {
      if (!item || typeof item.path !== 'string' || item.path.length > 4096) continue
      try {
        const resolvedPath = resolve(item.path)
        if (!(await stat(resolvedPath)).isDirectory()) continue
        existing.push(projectRef(resolvedPath))
      } catch { /* Removed folders no longer appear in Recents. */ }
    }
    return existing
  } catch {
    return []
  }
}

async function rememberProject(path: string): Promise<void> {
  const current = await readRecentProjects()
  const next = [projectRef(path), ...current.filter((item) => item.path !== path)].slice(0, MAX_RECENT_PROJECTS)
  await mkdir(dirname(recentProjectsFile()), { recursive: true })
  await writeFile(recentProjectsFile(), `${JSON.stringify(next.map(({ path: entry }) => ({ path: entry })), null, 2)}\n`, 'utf8')
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id || !event.senderFrame) {
    throw new DesktopRequestError('invalid_request', 'IPC sender is not the desktop renderer.')
  }
  try {
    const senderPath = resolve(fileURLToPath(event.senderFrame.url))
    if (senderPath !== resolve(rendererEntry)) throw new Error('Unexpected renderer URL.')
  } catch {
    throw new DesktopRequestError('invalid_request', 'IPC sender is not the local Microcode page.')
  }
}

function emitToRenderer(event: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('desktop:event', event)
  }
}

async function requireBackendSnapshot(): Promise<DesktopBackendSnapshot> {
  if (backend.status.status !== 'ready') throw new DesktopRequestError('backend_unavailable', backend.status.message || 'Runtime backend is not ready.')
  return backend.request<DesktopBackendSnapshot>('snapshot.get')
}

async function openWorkspace(path: string): Promise<DesktopBackendSnapshot> {
  if (backend.status.status !== 'ready') throw new DesktopRequestError('backend_unavailable', backend.status.message || 'Runtime backend is not ready.')
  const result = await backend.request<DesktopBackendSnapshot>('workspace.open', { cwd: path })
  lastWorkspace = result.workspace || path
  await rememberProject(lastWorkspace)
  return result
}

function register<TPayload = undefined, TResult = unknown>(
  channel: string,
  method: Parameters<typeof validateRendererIpc>[0],
  handler: (payload: TPayload) => Promise<TResult> | TResult,
): void {
  ipcMain.handle(channel, async (event, payload: TPayload) => {
    assertTrustedRenderer(event)
    validateRendererIpc(method, payload)
    return handler(payload)
  })
}

register('desktop:bootstrap', 'bootstrap', async () => {
  const snapshot = backend.status.status === 'ready' ? await requireBackendSnapshot().catch(() => null) : null
  if (snapshot?.workspace) lastWorkspace = snapshot.workspace
  return {
    backendStatus: backend.status,
    recentProjects: await readRecentProjects(),
    logsPath: app.getPath('logs'),
    snapshot,
  }
})

register('desktop:retry-backend', 'retryBackend', async () => {
  await backend.close()
  await backend.start()
  if (lastWorkspace) await backend.request('workspace.open', { cwd: lastWorkspace })
})

register('desktop:choose-workspace', 'chooseWorkspace', async () => {
  const selection = await dialog.showOpenDialog(mainWindow!, {
    title: 'Open a project folder',
    properties: ['openDirectory'],
  })
  const path = selection.filePaths[0]
  return selection.canceled || !path ? null : openWorkspace(path)
})

register('desktop:open-recent-project', 'openRecentProject', async ({ projectId: selectedId }: { projectId: string }) => {
  const project = (await readRecentProjects()).find((entry) => entry.id === selectedId)
  if (!project) throw new DesktopRequestError('workspace_unavailable', 'That recent project is no longer available.')
  return openWorkspace(project.path)
})

register('desktop:get-snapshot', 'getSnapshot', requireBackendSnapshot)
register('desktop:list-sessions', 'listSessions', () => backend.request('sessions.list'))
register('desktop:new-session', 'startNewSession', () => backend.request('session.new'))
register('desktop:select-session', 'selectSession', ({ sessionId }: { sessionId: string }) => backend.request('session.select', { sessionId }))
register('desktop:send-prompt', 'sendPrompt', ({ prompt, images }: { prompt: string; images?: unknown }) => backend.request('prompt.send', { prompt, ...(images ? { images } : {}) }))
register('desktop:cancel-prompt', 'cancelPrompt', () => backend.request('prompt.cancel'))
register('desktop:respond-permission', 'respondToPermission', (payload: { requestId: string; decision: 'allow' | 'allow_session' | 'deny'; answers?: Readonly<Record<string, string>>; block?: boolean }) => backend.request('permission.respond', payload))
register('desktop:set-permission-mode', 'setPermissionMode', ({ mode }: { mode: string }) => backend.request('permission.set_mode', { mode }))
register('desktop:list-models', 'listModels', () => backend.request('models.list'))
register('desktop:switch-model', 'switchModel', (model: { id: string; provider: string; api: string }) => backend.request('model.switch', model))
register('desktop:get-settings', 'getSettingsSnapshot', () => backend.request('settings.list'))
register('desktop:login-provider', 'loginProvider', (payload: { providerId: string; authType: 'oauth' | 'api_key' }) => backend.request('auth.login', payload))
register('desktop:logout-provider', 'logoutProvider', (payload: { providerId: string }) => backend.request('auth.logout', payload))
register('desktop:cancel-provider-login', 'cancelProviderLogin', () => backend.request('auth.cancel_login'))
register('desktop:set-mcp-enabled', 'setMcpEnabled', (payload: { name: string; enabled: boolean; confirmed?: boolean }) => backend.request('mcp.set_enabled', payload))
register('desktop:set-plugin-enabled', 'setPluginEnabled', (payload: { scope: 'user' | 'project'; name: string; enabled: boolean; confirmed?: boolean }) => backend.request('plugin.set_enabled', payload))
register('desktop:set-skill-loaded', 'setSkillLoaded', (payload: { name: string; loaded: boolean }) => backend.request('skill.set_loaded', payload))
register('desktop:review-status', 'reviewStatus', () => backend.request('review.status'))
register('desktop:read-diff', 'readDiff', ({ path }: { path: string }) => backend.request('review.diff', { path }))
register('desktop:terminal-create', 'createTerminal', ({ cols, rows }: { cols: number; rows: number }) => backend.request('terminal.create', { cols, rows }))
register('desktop:terminal-write', 'writeTerminal', ({ terminalId, data }: { terminalId: string; data: string }) => backend.request('terminal.write', { terminalId, data }))
register('desktop:terminal-resize', 'resizeTerminal', ({ terminalId, cols, rows }: { terminalId: string; cols: number; rows: number }) => backend.request('terminal.resize', { terminalId, cols, rows }))
register('desktop:terminal-close', 'closeTerminal', ({ terminalId }: { terminalId: string }) => backend.request('terminal.close', { terminalId }))

register('desktop:choose-images', 'chooseImages', async () => {
  const selection = await dialog.showOpenDialog(mainWindow!, {
    title: 'Attach images',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  })
  if (selection.canceled || selection.filePaths.length === 0) return [] as DesktopImageAttachment[]
  if (selection.filePaths.length > 4) throw new DesktopRequestError('invalid_request', 'Choose up to four images at a time.')
  const attachments: DesktopImageAttachment[] = []
  for (const path of selection.filePaths) {
    const mimeType = IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()]
    if (!mimeType) throw new DesktopRequestError('invalid_request', 'Choose a PNG, JPEG, WebP, or GIF image.')
    const info = await stat(path)
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new DesktopRequestError('invalid_request', 'Each image must be smaller than 4 MiB.')
    const data = (await readFile(path)).toString('base64')
    attachments.push(Object.freeze({ name: basename(path), image: Object.freeze({ type: 'image', mimeType, data }) as DesktopImageAttachment['image'] }))
  }
  return Object.freeze(attachments)
})

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1512,
    height: 960,
    minWidth: 760,
    minHeight: 600,
    show: false,
    backgroundColor: '#111416',
    title: 'Microcode',
    icon: process.platform === 'win32'
      ? (app.isPackaged ? join(process.resourcesPath, 'microcode.ico') : join(projectRoot, 'assets', 'microcode-logo-light.png'))
      : undefined,
    webPreferences: {
      preload: join(mainDirectory, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  })
  mainWindow = window
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, target) => {
    if (target !== pathToFileURL(rendererEntry).href) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.on('closed', () => { if (mainWindow === window) mainWindow = null })
  void window.loadFile(rendererEntry).then(() => window.show())
  return window
}

backend.subscribe((event) => emitToRenderer(event))

app.setAppUserModelId('com.microcode.desktop')
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') {
      console.error(formatRendererFailureDiagnostic(details.reason, details.exitCode))
    }
  })
})
app.on('before-quit', (event) => {
  if (shutdownReady) return
  event.preventDefault()
  if (isQuitting) return
  isQuitting = true
  void backend.close().finally(() => {
    shutdownReady = true
    app.quit()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
})

app.whenReady().then(async () => {
  if (process.argv.includes('--microcode-smoke-test')) {
    try {
      await mkdir(app.getPath('userData'), { recursive: true })
      await backend.start()
      const snapshot = await backend.request<DesktopBackendSnapshot>('snapshot.get')
      if (snapshot.workspace !== null || snapshot.runtime !== null) throw new Error('Packaged backend returned an unexpected initial workspace snapshot.')
      const report: Record<string, unknown> = {
        appVersion: DESKTOP_APP_VERSION,
        backendVersion: backend.status.appVersion,
        runtimeProtocolVersion: backend.status.runtimeProtocolVersion,
        transportProtocolVersion: 1,
      }

      const workspaceArgument = process.argv.find((argument) => argument.startsWith('--microcode-smoke-workspace='))
      if (workspaceArgument) {
        const requestedWorkspace = workspaceArgument.slice('--microcode-smoke-workspace='.length)
        if (!requestedWorkspace) throw new Error('Packaged workspace smoke requires a workspace directory.')
        const opened = await backend.request<DesktopBackendSnapshot>('workspace.open', { cwd: requestedWorkspace })
        if (!opened.workspace || !opened.runtime?.session || opened.runtime.project.cwd !== opened.workspace) {
          throw new Error('Packaged backend did not open a project and initialize its conversation session.')
        }
        const newDraft = await backend.request<DesktopBackendSnapshot>('session.new')
        if (!newDraft.runtime?.session || newDraft.runtime.project.cwd !== opened.workspace) {
          throw new Error('Packaged backend did not start a conversation session for the opened project.')
        }
        const sessions = await backend.request<unknown>('sessions.list')
        if (!Array.isArray(sessions)) throw new Error('Packaged backend did not return a session list for the opened project.')

        const review = await backend.request<{ readonly available: boolean; readonly changes: readonly { readonly path: string }[] }>('review.status')
        if (!review.available || !review.changes.some((change) => change.path === 'README.md')) {
          throw new Error('Packaged Git runtime did not find the expected project change.')
        }
        const diff = await backend.request<{ readonly text: string; readonly binary: boolean }>('review.diff', { path: 'README.md' })
        if (diff.binary || !diff.text.includes('packaged-review-after')) throw new Error('Packaged right-side review did not return the project diff.')

        const terminalMarker = 'MICROCODE_PACKAGED_TERMINAL_SMOKE_OK'
        let terminalOutput = ''
        let resolveTerminalOutput!: () => void
        let rejectTerminalOutput!: (error: Error) => void
        const terminalOutputReady = new Promise<void>((resolve, reject) => {
          resolveTerminalOutput = resolve
          rejectTerminalOutput = reject
        })
        const terminalTimeout = setTimeout(() => rejectTerminalOutput(new Error('The packaged Git Bash terminal did not return its smoke marker.')), 15_000)
        const unsubscribe = backend.subscribe((event) => {
          if (event.type !== 'terminal.data') return
          terminalOutput += Buffer.from(event.data, 'base64').toString('utf8')
          if (terminalOutput.includes(terminalMarker)) resolveTerminalOutput()
        })
        let terminalId: string | undefined
        let promptColorVerified = false
        try {
          terminalId = await backend.request<string>('terminal.create', { cols: 80, rows: 24 })
          const promptDeadline = Date.now() + 5_000
          while (Date.now() < promptDeadline) {
            if (terminalOutput.includes('\u001b[32m') && /\r?\n\$ /.test(terminalOutput)) {
              promptColorVerified = true
              break
            }
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
          if (!promptColorVerified) throw new Error('The packaged Git Bash prompt did not emit its ANSI color sequence.')
          const markerSplit = Math.floor(terminalMarker.length / 2)
          const markerPrefix = terminalMarker.slice(0, markerSplit)
          const markerSuffix = terminalMarker.slice(markerSplit)
          await backend.request('terminal.write', { terminalId, data: `printf '\\033[32m%s%s\\033[0m\\n' '${markerPrefix}' '${markerSuffix}'\r` })
          await terminalOutputReady
        } finally {
          clearTimeout(terminalTimeout)
          unsubscribe()
          if (terminalId) await backend.request('terminal.close', { terminalId }).catch(() => undefined)
        }
        report.workspace = 'passed'
        report.conversationSession = 'passed'
        report.reviewDiff = 'passed'
        report.gitBashTerminal = 'passed'
        report.gitBashTerminalColors = 'passed'

        const models = await backend.request<readonly { readonly id: string; readonly provider: string; readonly api: string; readonly authentication: string }[]>('models.list')
        const unconfiguredModel = models.find((model) => model.authentication === 'missing')
        if (unconfiguredModel) {
          try {
            await backend.request('model.switch', unconfiguredModel)
            throw new Error('An unconfigured provider model was unexpectedly accepted.')
          } catch (error) {
            if (!(error instanceof Error) || !/has no configured credentials/i.test(error.message)) throw error
            report.providerWithoutCredentials = 'clear-configuration-error'
          }
        } else {
          report.providerWithoutCredentials = 'not-tested-no-unconfigured-model'
        }

        const oauthLogin = backend.request<{ readonly status: string }>('auth.login', { providerId: 'openai-codex', authType: 'oauth' })
        const oauthStartup = await Promise.race([
          oauthLogin.then(() => 'completed' as const),
          new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 500)),
        ])
        if (oauthStartup !== 'pending') throw new Error('OpenAI Codex OAuth ended before exposing its browser authorization URL.')
        await backend.request('auth.cancel_login')
        const oauthResult = await oauthLogin
        if (oauthResult.status !== 'cancelled') throw new Error('OpenAI Codex OAuth smoke login did not cancel cleanly.')
        report.openAiCodexOAuth = 'authorization-url-opened-and-cancelled'
      }

      console.log(`MICROCODE_DESKTOP_SMOKE_OK ${JSON.stringify(report)}`)
      await backend.close()
      shutdownReady = true
      app.quit()
    } catch (error) {
      await backend.close().catch(() => undefined)
      console.error(`MICROCODE_DESKTOP_SMOKE_FAILED ${redactDisplayText(error instanceof Error ? error.message : String(error))}`)
      app.exit(1)
    }
    return
  }
  try {
    await mkdir(app.getPath('userData'), { recursive: true })
    await backend.start()
  }
  catch (error) {
    emitToRenderer({ type: 'backend.status', status: 'failed', message: error instanceof Error ? error.message : String(error) })
  }
  createMainWindow()
}).catch((error: unknown) => {
  console.error('Microcode desktop startup failed:', redactDisplayText(error instanceof Error ? error.message : String(error)))
  app.quit()
})
