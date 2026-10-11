import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { stripVTControlCharacters } from 'util'
import { Type, type Static } from 'typebox'
import type { PermissionBehavior } from '../../permissions/types.ts'

export const TOOL_NAME = 'bash'
export const TOOL_DEFAULT_PERMISSION: PermissionBehavior = 'ask'

const shellConfig = getShellConfig()

const bashSchema = Type.Object({
  command: Type.String({ description: `${shellConfig.name} command to execute` }),
  timeout: Type.Optional(
    Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' }),
  ),
  description: Type.Optional(
    Type.String({
      description:
        'Clear description of what this command does (shown to user before execution)',
    }),
  ),
})

export type BashToolInput = Static<typeof bashSchema>

export interface BashToolDetails {
  stdout: string
  stderr: string
  output: string
  displayOutput: string
  displayTruncated: boolean
  exitCode: number | null
}

const MAX_CAPTURED_OUTPUT_CHARS = 20_000
const CAPTURED_OUTPUT_HEAD_CHARS = 5_000
// UI 可展开的输出单独限幅；不能让 Agent 的上下文截断策略限制用户预览。
const MAX_DISPLAY_OUTPUT_CHARS = 80_000
const DISPLAY_OUTPUT_HEAD_CHARS = 20_000

interface OutputCapture {
  head: string
  tail: string
  totalChars: number
  truncated: boolean
  maxChars: number
  headChars: number
}

function appendOutput(capture: OutputCapture, chunk: string): void {
  capture.totalChars += chunk.length
  if (!capture.truncated) {
    const combined = capture.head + chunk
    if (combined.length <= capture.maxChars) {
      capture.head = combined
      return
    }
    capture.truncated = true
    capture.head = combined.slice(0, capture.headChars)
    capture.tail = combined.slice(-(capture.maxChars - capture.headChars))
    return
  }
  capture.tail = (capture.tail + chunk).slice(-(capture.maxChars - capture.headChars))
}

function readOutput(capture: OutputCapture): string {
  if (!capture.truncated) return capture.head
  const omittedChars = capture.totalChars - capture.head.length - capture.tail.length
  return `${capture.head}\n\n... [${omittedChars} characters omitted] ...\n\n${capture.tail}`
}

function createOutputCapture(
  maxChars = MAX_CAPTURED_OUTPUT_CHARS,
  headChars = CAPTURED_OUTPUT_HEAD_CHARS,
): OutputCapture {
  return { head: '', tail: '', totalChars: 0, truncated: false, maxChars, headChars }
}

function normalizeTerminalOutput(value: string): string {
  const withoutAnsi = stripVTControlCharacters(value)
    .replace(/\r\n/g, '\n')
    .replace(/\0/g, '')

  return withoutAnsi
    .split('\n')
    .map((line) => {
      // A bare carriage return means "overwrite this terminal line".
      let current = line.split('\r').at(-1) ?? ''
      while (current.includes('\b')) {
        current = current.replace(/[^\b]\b/g, '')
      }
      return current.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trimEnd()
    })
    .join('\n')
}

function getShellConfig(): { shell: string; args: string[]; name: string } {
  if (process.platform === 'win32') {
    if (process.env.PSModulePath || process.env.SHELL?.includes('powershell')) {
      return { shell: 'powershell.exe', args: ['-NoProfile', '-Command'], name: 'PowerShell' }
    }
    return { shell: 'cmd.exe', args: ['/c'], name: 'cmd.exe' }
  }
  return { shell: '/bin/bash', args: ['-c'], name: 'Bash' }
}

export function createBashTool(cwd: string): AgentTool<typeof bashSchema, BashToolDetails> {
  return {
    name: TOOL_NAME,
    label: shellConfig.name,
    description: `Execute a shell command in ${shellConfig.name} and return its output.`,
    parameters: bashSchema,
    async execute(
      _toolCallId: string,
      params: BashToolInput,
      signal?: AbortSignal,
      onUpdate?: (partial: AgentToolResult<BashToolDetails>) => void,
    ): Promise<AgentToolResult<BashToolDetails>> {
      const { command, timeout } = params

      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`)
      }

      const { shell, args } = getShellConfig()
      const stdoutCapture = createOutputCapture()
      const stderrCapture = createOutputCapture()
      const outputCapture = createOutputCapture()
      const displayCapture = createOutputCapture(MAX_DISPLAY_OUTPUT_CHARS, DISPLAY_OUTPUT_HEAD_CHARS)
      let updateTimer: ReturnType<typeof setTimeout> | undefined

      const emitUpdate = () => {
        updateTimer = undefined
        const cleanStdout = normalizeTerminalOutput(readOutput(stdoutCapture))
        const cleanStderr = normalizeTerminalOutput(readOutput(stderrCapture))
        const cleanOutput = normalizeTerminalOutput(readOutput(outputCapture))
        const displayOutput = normalizeTerminalOutput(readOutput(displayCapture))
        onUpdate?.({
          content: [{ type: 'text', text: cleanOutput }],
          details: {
            stdout: cleanStdout,
            stderr: cleanStderr,
            output: cleanOutput,
            displayOutput,
            displayTruncated: displayCapture.truncated,
            exitCode: null,
          },
        })
      }

      const scheduleUpdate = () => {
        if (!onUpdate || updateTimer) return
        updateTimer = setTimeout(emitUpdate, 200)
      }

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(shell, [...args, command], {
          cwd,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })

        let timedOut = false
        let timeoutHandle: NodeJS.Timeout | undefined

        if (timeout && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true
            try {
              process.kill(-child.pid!, 'SIGKILL')
            } catch {
              child.kill('SIGKILL')
            }
          }, timeout * 1000)
        }

        child.stdout?.on('data', (data: Buffer) => {
          const text = data.toString()
          appendOutput(stdoutCapture, text)
          appendOutput(outputCapture, text)
          appendOutput(displayCapture, text)
          scheduleUpdate()
        })

        child.stderr?.on('data', (data: Buffer) => {
          const text = data.toString()
          appendOutput(stderrCapture, text)
          appendOutput(outputCapture, text)
          appendOutput(displayCapture, text)
          scheduleUpdate()
        })

        const onAbort = () => {
          try {
            process.kill(-child.pid!, 'SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
        }
        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }

        child.on('close', (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle)
          if (updateTimer) {
            clearTimeout(updateTimer)
            emitUpdate()
          }
          if (timedOut) {
            resolve(null)
          } else {
            resolve(code)
          }
        })

        child.on('error', (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle)
          if (updateTimer) clearTimeout(updateTimer)
          reject(err)
        })
      })

      const stdout = normalizeTerminalOutput(readOutput(stdoutCapture))
      const stderr = normalizeTerminalOutput(readOutput(stderrCapture))
      const output = normalizeTerminalOutput(readOutput(outputCapture))
      const displayOutput = normalizeTerminalOutput(readOutput(displayCapture))

      return {
        content: [{ type: 'text', text: output || '(no output)' }],
        details: { stdout, stderr, output, displayOutput, displayTruncated: displayCapture.truncated, exitCode },
      }
    },
  }
}
