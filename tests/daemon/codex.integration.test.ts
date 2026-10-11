import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from '@earendil-works/pi-ai'
import { getAllModels } from '../../src/models/index.ts'
import { createGatewayServer } from '../../src/daemon/server.ts'
import type { GatewayModelRuntime, GatewayRequestOptions, GatewayServerHandle } from '../../src/daemon/types.ts'

const enabled = process.env.MICROCODE_CODEX_INTEGRATION === '1'
if (enabled) setDefaultTimeout(60_000)
const DUMMY_GATEWAY_TOKEN = 'local-codex-smoke-token'
const expectedText = 'Codex reached the Microcode Model Gateway.'
// Keep the Codex CLI on its regular Responses request path. The fake runtime does not call the
// provider; Responses API metadata lets the gateway validate Codex's opt-in summary field.
const catalogModel = getAllModels().find((item) => item.provider === 'deepseek' && item.id === 'deepseek-v4-pro')!
const model = { ...catalogModel, api: 'openai-responses' } as Model<any>

let testHome: string | undefined
let codexHomePath: string | undefined
let gateway: GatewayServerHandle | undefined

afterEach(async () => {
  await gateway?.stop()
  gateway = undefined
  if (codexHomePath) await rm(codexHomePath, { recursive: true, force: true })
  codexHomePath = undefined
  if (testHome) await rm(testHome, { recursive: true, force: true })
  testHome = undefined
})

function resultMessage(): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: expectedText }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 8, output: 9, cacheRead: 0, cacheWrite: 0, totalTokens: 17, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 1_700_000_000_000,
  }
}

function runtimeForCodex(
  calls: Array<{ context: Context; options: GatewayRequestOptions }>,
  observedEvents: string[],
  resolvedModels: string[],
  returnToolCall = false,
): GatewayModelRuntime {
  return {
    getModels: () => [model],
    getProviders: () => [],
    checkAuth: async () => undefined,
    login: async () => undefined,
    logout: async () => undefined,
    resolveModel: (id) => {
      resolvedModels.push(id)
      return id === `${model.provider}/${model.id}` || id === model.id ? model : undefined
    },
    async *stream(_selected: Model<any>, context, options) {
      calls.push({ context, options })
      const hasToolResult = context.messages.some((message) => message.role === 'toolResult')
      if (returnToolCall && !hasToolResult) {
        const call = { type: 'toolCall', id: 'call_codex_roundtrip', name: 'exec_command', arguments: { cmd: "printf 'MICROCODE_CODEX_TOOL_ROUNDTRIP'" } } as const
        const message: AssistantMessage = { ...resultMessage(), content: [call], stopReason: 'toolUse' }
        const toolEvents: AssistantMessageEvent[] = [
          { type: 'start', partial: message },
          { type: 'toolcall_start', contentIndex: 0, partial: message },
          { type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(call.arguments), partial: message },
          { type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message },
          { type: 'done', reason: 'toolUse', message },
        ]
        for (const event of toolEvents) {
          options.signal?.throwIfAborted()
          observedEvents.push(event.type)
          yield event
        }
        return
      }
      const message = resultMessage()
      const events: AssistantMessageEvent[] = [
        { type: 'start', partial: message },
        { type: 'text_start', contentIndex: 0, partial: message },
        { type: 'text_delta', contentIndex: 0, delta: expectedText },
        { type: 'text_end', contentIndex: 0, content: expectedText, partial: message },
        { type: 'done', reason: 'stop', message },
      ]
      for (const event of events) {
        options.signal?.throwIfAborted()
        observedEvents.push(event.type)
        yield event
      }
    },
    async complete(_selected: Model<any>, context, options) {
      calls.push({ context, options })
      options.signal?.throwIfAborted()
      return resultMessage()
    },
  }
}

async function runCodex(args: string[], env: NodeJS.ProcessEnv, prompt: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const executable = process.env.MICROCODE_CODEX_BIN || 'codex'
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: testHome, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 45_000)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.stdin.end(prompt)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

async function runGatewaySmoke(returnToolCall = false) {
  testHome = await mkdtemp(join(tmpdir(), 'microcode-codex-gateway-'))
  const codexHome = codexHomePath = await mkdtemp(join(homedir(), '.microcode-codex-gateway-'))
  const calls: Array<{ context: Context; options: GatewayRequestOptions }> = []
  const observedEvents: string[] = []
  const resolvedModels: string[] = []
  gateway = createGatewayServer({
    token: DUMMY_GATEWAY_TOKEN,
    rpcToken: 'internal-test-token',
    runtime: runtimeForCodex(calls, observedEvents, resolvedModels, returnToolCall),
    port: 0,
  })
  const baseUrl = `http://${gateway.hostname}:${gateway.port}/v1`
  await writeFile(join(codexHome, 'config.toml'), [
    `model = "${model.provider}/${model.id}"`,
    'model_provider = "microcode"',
    'sandbox_mode = "read-only"',
    '[model_providers.microcode]',
    'name = "Microcode Gateway Integration Test"',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    'env_key = "MICROCODE_CODEX_SMOKE_TOKEN"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    '',
  ].join('\n'), { mode: 0o600 })
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: testHome,
    CODEX_HOME: codexHome,
    TERM: 'dumb',
    MICROCODE_CODEX_SMOKE_TOKEN: DUMMY_GATEWAY_TOKEN,
    CODEX_DISABLE_UPDATE_CHECK: '1',
  }
  const result = await runCodex([
    'exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--json', '-',
  ], env, 'Reply with the exact text the test server sends.')
  return { result, calls, observedEvents, resolvedModels }
}

describe('installed Codex CLI gateway smoke', () => {
  if (!enabled) {
    test.skip('set MICROCODE_CODEX_INTEGRATION=1 to run against the installed Codex CLI', () => {})
    return
  }

  test('sends a Responses streaming text turn through the gateway with configured auth', async () => {
    const { result, calls, resolvedModels } = await runGatewaySmoke()

    if (result.code !== 0) {
      throw new Error(`Codex CLI exited ${result.code}. Resolved models=${resolvedModels.join(',')}; calls=${calls.length}; events=${observedEvents.join(',')}. stdout: ${result.stdout.slice(-1500)} stderr: ${result.stderr.slice(-1500)}`)
    }
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(expectedText)
    expect(result.stdout + result.stderr).not.toContain(DUMMY_GATEWAY_TOKEN)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.some((call) => call.context.messages.some((message) => message.role === 'user'))).toBe(true)
    expect(calls.some((call) => call.options.toolChoice === 'auto')).toBe(true)
  })

  test('completes a client-owned function tool round trip through Codex', async () => {
    const { result, calls, observedEvents, resolvedModels } = await runGatewaySmoke(true)
    if (result.code !== 0) {
      throw new Error(`Codex CLI exited ${result.code}. Resolved models=${resolvedModels.join(',')}; calls=${calls.length}; events=${observedEvents.join(',')}. stdout: ${result.stdout.slice(-1500)} stderr: ${result.stderr.slice(-1500)}`)
    }
    expect(result.stdout).toContain('MICROCODE_CODEX_TOOL_ROUNDTRIP')
    expect(result.stdout).toContain(expectedText)
    expect(result.stdout + result.stderr).not.toContain(DUMMY_GATEWAY_TOKEN)
    expect(observedEvents).toContain('toolcall_start')
    expect(calls.some((call) => call.context.messages.some((message) => message.role === 'toolResult' && JSON.stringify(message).includes('MICROCODE_CODEX_TOOL_ROUNDTRIP')))).toBe(true)
  })
})
