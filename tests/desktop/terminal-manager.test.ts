import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopTerminalEvent } from '../../src/desktop/TerminalManager.ts'
import { DesktopTerminalManager } from '../../src/desktop/TerminalManager.ts'

async function waitFor(events: readonly DesktopTerminalEvent[], condition: (output: string) => boolean): Promise<string> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const output = events.flatMap((event) => event.type === 'terminal.data' ? [Buffer.from(event.data, 'base64').toString('utf8')] : []).join('')
    if (condition(output)) return output
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const output = events.flatMap((event) => event.type === 'terminal.data' ? [Buffer.from(event.data, 'base64').toString('utf8')] : []).join('')
  throw new Error(`Timed out waiting for Bash PTY output. Received: ${output}`)
}

describe('desktop Bash PTY', () => {
  if (process.platform === 'win32') {
    test.skip('runs the POSIX Bash integration check on the Linux desktop host', () => undefined)
  } else {
    test('runs interactive Bash in the project, accepts input, resizes, and closes', async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'microcode-terminal-'))
      const events: DesktopTerminalEvent[] = []
      const manager = new DesktopTerminalManager((event) => events.push(event))
      let terminalId = ''

      try {
        terminalId = await manager.create(workspace, 84, 24)
        manager.write(terminalId, 'test -t 0 && printf "%s%s\\n" "__PTY_" "TTY_OK__"; printf "%s%s:%s\\n" "__PTY_" "CWD__" "$PWD"; printf "%s%s\\n" "__PTY_" "READY__"\n')
        const initialOutput = await waitFor(events, (output) => output.includes('__PTY_READY__'))
        expect(initialOutput).toContain('__PTY_TTY_OK__')
        expect(initialOutput).toContain(`__PTY_CWD__:${workspace}`)

        manager.write(terminalId, 'printf "__PTY_COLOR_ENV__%s:%s\\n" "$TERM" "$COLORTERM"\n')
        const colorEnvironment = await waitFor(events, (output) => output.includes('__PTY_COLOR_ENV__xterm-256color:truecolor'))
        expect(colorEnvironment).toContain('__PTY_COLOR_ENV__xterm-256color:truecolor')

        manager.write(terminalId, "printf '\\033[32m__ANSI_GREEN__\\033[0m\\n'\n")
        const ansiOutput = await waitFor(events, (output) => output.includes('\u001b[32m__ANSI_GREEN__\u001b[0m'))
        expect(ansiOutput).toContain('\u001b[32m__ANSI_GREEN__\u001b[0m')

        manager.resize(terminalId, 113, 37)
        manager.write(terminalId, 'stty size; printf "%s%s\\n" "__PTY_" "RESIZED__"\n')
        const resizedOutput = await waitFor(events, (output) => output.includes('__PTY_RESIZED__'))
        expect(resizedOutput).toContain('37 113')

        await manager.close(terminalId)
        expect(events.some((event) => event.type === 'terminal.exit' && event.terminalId === terminalId)).toBe(true)
      } finally {
        await manager.closeAll()
        await rm(workspace, { recursive: true, force: true })
      }
    })
  }
})
