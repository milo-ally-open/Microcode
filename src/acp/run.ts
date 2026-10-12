import * as acp from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import { type ThinkingLevel } from '@earendil-works/pi-agent-core'
import { GatewayClient } from '../daemon/client.ts'
import { ensureGatewayDaemon } from '../daemon/lifecycle.ts'
import { initializeTuiModelTransport } from '../daemon/startup.ts'
import { RuntimeFactory } from '../runtime/RuntimeFactory.ts'
import { SessionManager } from '../session/SessionManager.ts'
import type { PermissionMode } from '../permissions/types.ts'
import { AcpAgentAdapter } from './adapter.ts'

declare const MACRO: { VERSION: string }

interface AcpOptions {
  readonly noDaemon: boolean
  readonly modelId?: string
  readonly permissionMode?: PermissionMode
  readonly thinkingLevel?: ThinkingLevel
  readonly gatewayPort?: string
  readonly gatewayHost?: string
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
const PERMISSION_MODES: readonly PermissionMode[] = ['interactive', 'auto-approve', 'plan']

export async function runAcpAgent(args: readonly string[]): Promise<void> {
  const options = parseOptions(args)
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    debug: console.debug,
  }
  console.log = (...values: unknown[]) => console.error(...values)
  console.info = (...values: unknown[]) => console.error(...values)
  console.warn = (...values: unknown[]) => console.error(...values)
  console.debug = (...values: unknown[]) => console.error(...values)

  try {
    process.title = 'microcode acp'
  } catch {}

  const adapter = new AcpAgentAdapter({
    version: MACRO.VERSION,
    createRuntime: async (cwd) => {
      let gatewayClient: GatewayClient | undefined
      if (!options.noDaemon) {
        const transport = await initializeTuiModelTransport(
          () => ensureGatewayDaemon(options.gatewayPort, options.gatewayHost),
          fetch,
          cwd,
          options.modelId,
        )
        if (transport.mode === 'gateway') {
          gatewayClient = transport.client
        } else {
          process.stderr.write('Model Gateway handshake failed; using the in-process model path for this ACP session.\n')
        }
      }

      const factory = await RuntimeFactory.create({
        cwd,
        microcodeVersion: MACRO.VERSION,
        sessions: new SessionManager(),
        agent: {
          modelId: options.modelId,
          thinkingLevel: options.thinkingLevel,
          permission: { mode: options.permissionMode ?? 'interactive' },
          identity: { id: 'assistant-acp', name: 'Microcode', role: 'assistant' },
          ...(gatewayClient ? {
            initialModelConfig: gatewayClient.getProjectDefaultModelConfig(options.modelId),
            resolveModelConfig: (id, api, provider) => gatewayClient!.resolveProjectModel(id, api, provider),
            resolveModelApiKey: () => undefined,
            streamFn: gatewayClient.streamSimple,
            models: gatewayClient.asModelsProxy(),
          } : {}),
        },
      })
      void factory.mcpReady.catch(() => undefined)
      return { runtime: factory.runtime, mcpServers: factory.mcpServers }
    },
  })

  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  )
  const connection = adapter.app.connect(stream)
  const closeOnSignal = () => connection.close()
  process.once('SIGINT', closeOnSignal)
  process.once('SIGTERM', closeOnSignal)

  try {
    await connection.closed
  } catch {
    process.stderr.write('ACP stdio connection closed after a transport error.\n')
  } finally {
    process.removeListener('SIGINT', closeOnSignal)
    process.removeListener('SIGTERM', closeOnSignal)
    await adapter.close()
    console.log = originalConsole.log
    console.info = originalConsole.info
    console.warn = originalConsole.warn
    console.debug = originalConsole.debug
  }
}

function parseOptions(args: readonly string[]): AcpOptions {
  let noDaemon = false
  let modelId: string | undefined
  let permissionMode: PermissionMode | undefined
  let thinkingLevel: ThinkingLevel | undefined
  let gatewayPort: string | undefined
  let gatewayHost: string | undefined

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--no-daemon') {
      noDaemon = true
    } else if (arg === '--model') {
      modelId = requiredValue(args, ++index, arg)
    } else if (arg === '--permission' || arg === '--permission-mode') {
      const value = requiredValue(args, ++index, arg).toLowerCase()
      if (!PERMISSION_MODES.includes(value as PermissionMode)) {
        throw new Error(`Invalid permission mode: ${value}. Valid modes: ${PERMISSION_MODES.join(', ')}`)
      }
      permissionMode = value as PermissionMode
    } else if (arg === '--thinking') {
      const value = requiredValue(args, ++index, arg).toLowerCase()
      if (!THINKING_LEVELS.includes(value as (typeof THINKING_LEVELS)[number])) {
        throw new Error(`Invalid thinking level: ${value}. Valid levels: ${THINKING_LEVELS.join(', ')}`)
      }
      thinkingLevel = value as ThinkingLevel
    } else if (arg === '--gateway-port') {
      gatewayPort = requiredValue(args, ++index, arg)
    } else if (arg.startsWith('--gateway-port=')) {
      gatewayPort = arg.slice('--gateway-port='.length)
    } else if (arg === '--gateway-host') {
      gatewayHost = requiredValue(args, ++index, arg)
    } else if (arg.startsWith('--gateway-host=')) {
      gatewayHost = arg.slice('--gateway-host='.length)
    } else {
      throw new Error(`Unknown ACP option: ${arg}`)
    }
  }

  return { noDaemon, modelId, permissionMode, thinkingLevel, gatewayPort, gatewayHost }
}

function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index]
  if (!value || value.startsWith('--')) throw new Error(`Missing value after ${option}`)
  return value
}
