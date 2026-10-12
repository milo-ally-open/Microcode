import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { DESKTOP_TRANSPORT_PROTOCOL_VERSION, type DesktopEvent } from './protocol.ts'
import { redactDisplayText } from './security.ts'
import { DESKTOP_APP_VERSION } from './buildInfo.ts'
import { RUNTIME_PROTOCOL_VERSION } from '../runtime/protocol.ts'

const FRAME_PREFIX = '@@MICROCODE_DESKTOP@@'
const MAX_LINE_BYTES = 24 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface HostEvent {
  readonly protocolVersion: typeof DESKTOP_TRANSPORT_PROTOCOL_VERSION
  readonly kind: 'event'
  readonly event: DesktopEvent
}

interface HostResponse {
  readonly protocolVersion: typeof DESKTOP_TRANSPORT_PROTOCOL_VERSION
  readonly kind: 'response'
  readonly id: string
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

export interface DesktopBackendHostOptions {
  readonly backendExecutable?: string
  readonly backendArguments?: readonly string[]
  readonly environment?: Readonly<Record<string, string>>
  readonly expectedAppVersion?: string
  readonly expectedRuntimeProtocolVersion?: number
  readonly workingDirectory?: string
}

/** Electron-main owner for the Bun runtime sidecar's narrow JSON-line channel. */
export class DesktopBackendHost {
  private child?: ChildProcessWithoutNullStreams
  private state: 'starting' | 'ready' | 'failed' | 'closed' = 'closed'
  private statusMessage?: string
  private nextRequest = 0
  private buffer = ''
  private closing = false
  private appVersion?: string
  private runtimeProtocolVersion?: number
  private readonly requests = new Map<string, PendingRequest>()
  private readonly listeners = new Set<(event: DesktopEvent) => void>()
  private readyResolve?: () => void
  private readyReject?: (error: Error) => void

  constructor(private readonly projectRoot: string, private readonly options: DesktopBackendHostOptions = {}) {}

  get status(): Extract<DesktopEvent, { readonly type: 'backend.status' }> {
    return {
      type: 'backend.status',
      status: this.state,
      ...(this.statusMessage ? { message: this.statusMessage } : {}),
      ...(this.appVersion ? { appVersion: this.appVersion } : {}),
      ...(this.runtimeProtocolVersion !== undefined ? { runtimeProtocolVersion: this.runtimeProtocolVersion } : {}),
    }
  }

  subscribe(listener: (event: DesktopEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    if (this.state === 'ready' && this.child) return
    this.state = 'starting'
    this.statusMessage = undefined
    this.appVersion = undefined
    this.runtimeProtocolVersion = undefined
    this.emit(this.status)
    const backendEntry = join(this.projectRoot, 'src', 'desktop', 'backend.ts')
    const command = this.options.backendExecutable
      ? [this.options.backendExecutable, ...(this.options.backendArguments ?? [])]
      : [process.env.MICROCODE_BUN_EXECUTABLE || 'bun', 'run', backendEntry]
    const environment: NodeJS.ProcessEnv = { ...process.env }
    let pathOverride: string | undefined
    for (const [name, value] of Object.entries(this.options.environment ?? {})) {
      if (process.platform === 'win32' && name.toLowerCase() === 'path') pathOverride = value
      else environment[name] = value
    }
    if (process.platform === 'win32') {
      const pathName = Object.keys(environment).find((name) => name.toLowerCase() === 'path')
      const pathValue = pathOverride ?? (pathName ? environment[pathName] : undefined)
      for (const name of Object.keys(environment)) {
        if (name.toLowerCase() === 'path') delete environment[name]
      }
      if (pathValue) environment.Path = pathValue
    }
    environment.MICROCODE_DESKTOP_SIDECAR = '1'
    const child = spawn(command[0], command.slice(1), {
      cwd: this.options.workingDirectory ?? this.projectRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.closing = false
    this.buffer = ''
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })

    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.state !== 'ready') this.statusMessage = redactDisplayText(chunk.toString('utf8')).slice(-1200)
    })
    child.on('error', (error) => this.fail(`Could not start the Microcode runtime backend: ${error.message}`))
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      if (this.closing || this.state === 'failed') return
      const suffix = code === null ? ` (${signal ?? 'unknown signal'})` : ` (exit code ${code})`
      this.fail(`The Microcode runtime backend stopped unexpectedly${suffix}.`)
    })

    const timeout = setTimeout(() => this.fail('The runtime backend did not become ready within 15 seconds.'), 15_000)
    try {
      await ready
    } finally {
      clearTimeout(timeout)
      this.readyResolve = undefined
      this.readyReject = undefined
    }
  }

  async request<T>(method: string, payload?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.state !== 'ready' || !this.child) throw new Error(this.statusMessage || 'Runtime backend is not ready.')
    const id = `desktop-rpc-${++this.nextRequest}`
    const frame = `${JSON.stringify({ protocolVersion: DESKTOP_TRANSPORT_PROTOCOL_VERSION, kind: 'request', id, method, ...(payload === undefined ? {} : { payload }) })}\n`
    if (Buffer.byteLength(frame, 'utf8') > MAX_LINE_BYTES) throw new Error('Request exceeds the desktop transport size limit.')

    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id)
        reject(new Error(`Desktop request ${method} timed out.`))
      }, timeoutMs)
      this.requests.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
    })
    this.child.stdin.write(frame, (error) => {
      if (!error) return
      const pending = this.requests.get(id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.requests.delete(id)
      pending.reject(error)
    })
    return response
  }

  async close(): Promise<void> {
    const child = this.child
    if (!child) {
      this.state = 'closed'
      return
    }
    this.closing = true
    try {
      if (this.state === 'ready') await this.request('app.close', undefined, 12_000)
    } catch {
      // Closing the pipe aborts the owned runtime; it never grants pending permissions.
    }
    if (!child.stdin.destroyed) child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit').then(() => true, () => true)
      let timeout: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), 5_000) })
      const didExit = await Promise.race([exited, timedOut])
      if (timeout) clearTimeout(timeout)
      if (!didExit) child.kill()
    }
    this.child = undefined
    this.state = 'closed'
    this.statusMessage = undefined
    this.appVersion = undefined
    this.runtimeProtocolVersion = undefined
    this.rejectRequests(new Error('Runtime backend closed.'))
    this.emit(this.status)
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LINE_BYTES * 2) {
      this.fail('Runtime backend output exceeded the desktop transport limit.')
      this.child?.kill()
      this.buffer = ''
      return
    }
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.consumeLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private consumeLine(line: string): void {
    if (!line.startsWith(FRAME_PREFIX)) return
    let decoded: unknown
    try {
      decoded = JSON.parse(line.slice(FRAME_PREFIX.length)) as unknown
    } catch {
      this.fail('Runtime backend returned malformed desktop protocol data.')
      return
    }
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)
      || (decoded as { readonly protocolVersion?: unknown }).protocolVersion !== DESKTOP_TRANSPORT_PROTOCOL_VERSION) {
      this.fail('Runtime backend uses an incompatible desktop protocol version. Restart the desktop backend.')
      return
    }
    const frame = decoded as HostEvent | HostResponse
    if (frame.kind === 'event') {
      const eventValue: unknown = frame.event
      if (eventValue === null || typeof eventValue !== 'object' || typeof (eventValue as { readonly type?: unknown }).type !== 'string') {
        this.fail('Runtime backend returned malformed desktop event data.')
        return
      }
      const event = eventValue as DesktopEvent
      if (event.type === 'backend.status') {
        if (event.status === 'ready') {
          const expectedAppVersion = this.options.expectedAppVersion ?? DESKTOP_APP_VERSION
          const expectedRuntimeProtocolVersion = this.options.expectedRuntimeProtocolVersion ?? RUNTIME_PROTOCOL_VERSION
          if (event.appVersion !== expectedAppVersion || event.runtimeProtocolVersion !== expectedRuntimeProtocolVersion) {
            const actualAppVersion = event.appVersion ?? 'unknown'
            const actualRuntimeProtocolVersion = event.runtimeProtocolVersion ?? 'unknown'
            this.fail(`Microcode desktop/backend version mismatch (app ${expectedAppVersion}, backend ${actualAppVersion}; runtime protocol ${expectedRuntimeProtocolVersion}/${actualRuntimeProtocolVersion}). Reinstall or repair Microcode with one matching release before using Agent actions.`)
            this.child?.kill()
            return
          }
          this.appVersion = event.appVersion
          this.runtimeProtocolVersion = event.runtimeProtocolVersion
        }
        this.state = event.status
        this.statusMessage = event.message
        if (event.status === 'ready') this.readyResolve?.()
        if (event.status === 'failed') this.readyReject?.(new Error(event.message || 'Runtime backend failed to start.'))
      }
      this.emit(event)
      return
    }
    if (frame.kind !== 'response' || typeof frame.id !== 'string') return
    const pending = this.requests.get(frame.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.requests.delete(frame.id)
    if (frame.ok) pending.resolve(frame.result)
    else pending.reject(new Error(frame.error?.message || 'Desktop backend command failed.'))
  }

  private fail(message: string): void {
    this.state = 'failed'
    this.statusMessage = redactDisplayText(message)
    this.emit(this.status)
    this.readyReject?.(new Error(this.statusMessage))
    this.rejectRequests(new Error(this.statusMessage))
  }

  private rejectRequests(error: Error): void {
    for (const pending of this.requests.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.requests.clear()
  }

  private emit(event: DesktopEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch { /* A window that is navigating cannot interrupt backend work. */ }
    }
  }
}
