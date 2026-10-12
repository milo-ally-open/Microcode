import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'

export type DesktopTerminalEvent =
  | { readonly type: 'terminal.data'; readonly terminalId: string; readonly data: string }
  | { readonly type: 'terminal.exit'; readonly terminalId: string; readonly exitCode: number; readonly signal: string | null }

interface TerminalProcess {
  readonly terminal: Bun.Terminal
  readonly process: Bun.Subprocess
  readonly exited: Promise<number>
}

function clampDimensions(cols: number, rows: number): { readonly cols: number; readonly rows: number } {
  return { cols: Math.max(20, Math.min(300, Math.floor(cols))), rows: Math.max(5, Math.min(100, Math.floor(rows))) }
}

async function shellCommand(workspace: string): Promise<{ readonly command: string[]; readonly cwd?: string }> {
  if (process.platform !== 'win32') return { command: [Bun.which('bash') ?? 'bash', '--login'], cwd: workspace }

  const packagedBash = process.env.MICROCODE_GIT_BASH_EXECUTABLE
  if (packagedBash) return { command: [packagedBash, '--login', '-i'], cwd: workspace }

  const resolved = Bun.spawnSync({
    cmd: ['wsl.exe', '--exec', 'wslpath', '-u', workspace],
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  })
  const linuxWorkspace = resolved.stdout?.toString('utf8').trim()
  if (!resolved.success || !linuxWorkspace?.startsWith('/')) {
    throw new Error('Could not map this project folder into WSL. Check that WSL and wslpath are available.')
  }
  return {
    command: ['wsl.exe', '--cd', linuxWorkspace, '--exec', 'env', 'TERM=xterm-256color', 'COLORTERM=truecolor', 'bash', '--login'],
    cwd: workspace,
  }
}

/** Owns the interactive Bash sessions exposed by the desktop terminal panel. */
export class DesktopTerminalManager {
  private readonly terminals = new Map<string, TerminalProcess>()

  constructor(private readonly emit: (event: DesktopTerminalEvent) => void) {}

  async create(workspacePath: string, cols: number, rows: number): Promise<string> {
    const workspace = await realpath(workspacePath).catch(() => '')
    const details = workspace ? await stat(workspace).catch(() => null) : null
    if (!details?.isDirectory()) throw new Error('The project folder is no longer available for the terminal.')

    const { command, cwd } = await shellCommand(workspace)
    const terminalId = randomUUID()
    const dimensions = clampDimensions(cols, rows)
    const child = Bun.spawn(command, {
      ...(cwd ? { cwd } : {}),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      terminal: {
        ...dimensions,
        name: 'xterm-256color',
        data: (_terminal, data) => this.emit({ type: 'terminal.data', terminalId, data: Buffer.from(data).toString('base64') }),
      },
    })
    const terminal = child.terminal
    if (!terminal) {
      child.kill()
      throw new Error('The Bash process did not receive a pseudo-terminal.')
    }

    const entry: TerminalProcess = { terminal, process: child, exited: child.exited }
    this.terminals.set(terminalId, entry)
    void entry.exited.then((exitCode) => this.finish(terminalId, entry, exitCode))
    return terminalId
  }

  write(terminalId: string, data: string): void {
    const entry = this.get(terminalId)
    entry.terminal.write(data)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const entry = this.get(terminalId)
    const dimensions = clampDimensions(cols, rows)
    entry.terminal.resize(dimensions.cols, dimensions.rows)
  }

  async close(terminalId: string): Promise<void> {
    const entry = this.terminals.get(terminalId)
    if (!entry) return
    if (entry.process.exitCode !== null || entry.process.signalCode !== null) {
      this.finish(terminalId, entry, entry.process.exitCode ?? 1)
      return
    }

    entry.process.kill('SIGTERM')
    let timeout: ReturnType<typeof setTimeout> | undefined
    const exitCode = await Promise.race([
      entry.exited,
      new Promise<undefined>((resolve) => { timeout = setTimeout(() => resolve(undefined), 2_000) }),
    ])
    if (timeout) clearTimeout(timeout)
    if (exitCode === undefined) {
      entry.process.kill('SIGKILL')
      this.finish(terminalId, entry, await entry.exited)
    } else {
      this.finish(terminalId, entry, exitCode)
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.terminals.keys()].map((terminalId) => this.close(terminalId)))
  }

  private get(terminalId: string): TerminalProcess {
    const entry = this.terminals.get(terminalId)
    if (!entry) throw new Error('The Bash terminal is no longer running.')
    return entry
  }

  private finish(terminalId: string, entry: TerminalProcess, exitCode: number): void {
    if (this.terminals.get(terminalId) !== entry) return
    this.terminals.delete(terminalId)
    if (!entry.terminal.closed) entry.terminal.close()
    this.emit({ type: 'terminal.exit', terminalId, exitCode, signal: entry.process.signalCode })
  }
}
