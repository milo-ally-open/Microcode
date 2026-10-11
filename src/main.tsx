import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createMicrocodeAgentRuntime } from './agent/index.ts'
import { getAllModels, getCustomModelDefs, getModels } from './models/index.ts'
import { App } from './tui/app.ts'
import { McpClientManager } from './mcp/client.ts'
import { getProjectConfigPath, getUserConfigPath, isMcpConfigEmpty } from './mcp/config.ts'
import { discoverMcpCapabilities, safeMcpConfigSummary } from './mcp/capabilities.ts'
import type { ConfigScope } from './mcp/configWrite.ts'
import { SessionManager } from './session/SessionManager.ts'
import { createGitWorkTreeTool } from './tools/index.ts'
import { type PermissionMode, PERMISSION_MODES } from './permissions/index.ts'
import { cleanupImageCache } from './utils/imageUtils.ts'
import { GitWorkTreeSystem } from './git/index.ts'
import { loadProjectInstructions } from './instructions/projectInstructions.ts'
import { PluginManager } from './plugins/PluginManager.ts'
import { GatewayClient } from './daemon/client.ts'
import { ensureGatewayDaemon, getGatewayStatus, rotateGatewayToken, showGatewayToken, stopGatewayDaemon } from './daemon/lifecycle.ts'
import { runGatewayDaemon } from './daemon/run.ts'
import { initializeTuiModelTransport } from './daemon/startup.ts'
import { GATEWAY_PROTOCOL_VERSION } from './daemon/server.ts'
import { configuredGatewayHost, setConfiguredGatewayHost } from './daemon/config.ts'

declare const MACRO: {
  VERSION: string
}

export type CliHelpTopic = 'root' | 'gateway' | 'mcp' | 'model'

const ROOT_HELP = `Microcode
Terminal-native AI coding assistant

USAGE
  microcode [OPTIONS]
  microcode [OPTIONS] --resume [SESSION_ID]
  microcode <COMMAND> [ARGS]

COMMANDS
  gateway [COMMAND]       Manage the Model Gateway daemon
  mcp list                List configured Model Context Protocol servers
  model list              List models available to Microcode

OPTIONS
  -h, --help              Show help (use with a command for command-specific help)
  -v, --version           Show the installed version
  --resume [SESSION_ID]   Resume a session by ID, or the most recent session
  --model <PROVIDER/ID>   Select the initial model for this session
  --thinking <LEVEL>      Set reasoning depth: off, minimal, low, medium, high, xhigh
  --permission <MODE>     Set approvals: interactive, auto-approve, or plan
  --permission-mode <MODE> Alias for --permission
  --no-daemon             Use the in-process model runtime; do not connect to the gateway
  --gateway-port <PORT>   Override the gateway port for this invocation
  --gateway-host <HOST>   Override the gateway bind address (default: 127.0.0.1)

MODEL GATEWAY
  Normal startup uses the per-user gateway after a compatibility handshake. Its
  default bind address is loopback; configure another address explicitly if needed.
  If startup or handshake fails, Microcode reports the reason and uses the in-process
  runtime for that invocation. The gateway remains available after the TUI exits.
  Run 'microcode gateway --help' for lifecycle, port, and security details.

INTERACTIVE USE
  Start Microcode to open the terminal interface, then enter a prompt to start a turn.
  Inside the interface, use /help for slash commands and keyboard shortcuts.

CONFIGURATION
  User settings:    ~/.microcode/config.json
  Project settings: .microcode/config.json
  Gateway port:     MICROCODE_GATEWAY_PORT (default: 43127)
  Gateway address:  MICROCODE_GATEWAY_HOST (default: 127.0.0.1)
  Provider auth:    /login and /auth in the TUI; provider API-key variables or API_KEY
  Model selection:  MODEL, OPENAI_MODEL, ANTHROPIC_MODEL, GEMINI_MODEL
  API endpoints:    BASE_URL or provider-specific base URL variables
  See 'microcode model list' and the README for provider and configuration details.

EXAMPLES
  microcode
  microcode --resume
  microcode --resume 01a0ed2a
  microcode model list
  microcode mcp list --scope project
  microcode gateway status

Use 'microcode <COMMAND> --help' for command-specific help.`

const GATEWAY_HELP = `Microcode Model Gateway
Local model inference service for Microcode and compatible API clients.

USAGE
  microcode gateway [COMMAND] [OPTIONS]

COMMANDS
  start                   Start or reuse the daemon, then verify its API handshake
  status                  Report whether the configured gateway is reachable
  stop                    Gracefully stop the recorded daemon and cancel active work
  token                   Print the client token (sensitive credential)
  token --rotate          Replace the client token while the gateway is stopped

  With no command, 'status' is used.

OPTIONS
  -h, --help              Show this help
  --gateway-port <PORT>   Port override for start, status, and token --rotate
  --gateway-host <HOST>   Bind address override for start and status

PORT SELECTION
  Default:                127.0.0.1:43127
  Host precedence:        --gateway-host, MICROCODE_GATEWAY_HOST,
                          ~/.microcode/config.json (gateway.host), then default
  Port precedence:        --gateway-port, MICROCODE_GATEWAY_PORT,
                          ~/.microcode/config.json (gateway.port), then default
  Use 0.0.0.0 to listen on all IPv4 interfaces, or provide a specific interface
  address. A conflicting live daemon is not stopped or replaced automatically.
  'stop' targets the daemon recorded in local metadata.

CLIENT AUTHENTICATION
  The gateway token authenticates local API clients; it is separate from provider
  credentials and the private Microcode TUI token. 'token' prints a secret: do not
  share it or include it in logs. Token rotation is refused while a gateway is running;
  update clients with the new token after rotation.

API-COMPATIBLE ENDPOINTS
  GET  /v1/models
  POST /v1/chat/completions   OpenAI Chat Completions
  POST /v1/responses          OpenAI Responses
  POST /v1/messages           Anthropic Messages

  Provider sign-in and credentials are managed by Microcode. The gateway performs
  inference only; client harnesses retain their own tools, approvals, and sessions.

EXAMPLES
  microcode gateway status
  microcode gateway start
  microcode gateway token
  microcode gateway token --rotate
  microcode gateway stop
  microcode gateway status --gateway-port 43128
  microcode gateway start --gateway-host 0.0.0.0`

const MCP_HELP = `Microcode MCP Commands
Discover Model Context Protocol servers configured for the current user or project.

USAGE
  microcode mcp list [OPTIONS]

COMMANDS
  list                    List configured MCP servers (default when omitted)

OPTIONS
  --scope <SCOPE>         Filter by configuration scope: user, project, or all
                          Default: all
  -h, --help              Show this help

EXAMPLES
  microcode mcp list
  microcode mcp list --scope user
  microcode mcp list --scope project`

const MODEL_HELP = `Microcode Model Commands
Inspect model providers and models available to the current runtime.

USAGE
  microcode model list [OPTIONS]

COMMANDS
  list                    List models with provider/model IDs and capabilities

OPTIONS
  --no-daemon             Read the in-process model catalog without starting or using
                          the Model Gateway
  --gateway-port <PORT>   Select the gateway port for this command
  --gateway-host <HOST>   Select the gateway bind address for this command
  -h, --help              Show this help

By default, model listing uses the gateway catalog after a handshake and falls back
to the in-process catalog if the gateway is unavailable.

EXAMPLES
  microcode model list
  microcode model list --no-daemon
  microcode model list --gateway-port 43128`

const HELP_TEXT: Record<CliHelpTopic, string> = {
  root: ROOT_HELP,
  gateway: GATEWAY_HELP,
  mcp: MCP_HELP,
  model: MODEL_HELP,
}

export function formatCliHelp(topic: CliHelpTopic = 'root'): string {
  return HELP_TEXT[topic]
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  const val = args[idx + 1]
  if (!val || val.startsWith('-')) return undefined
  return val
}

function gatewayPortArgument(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg.startsWith('--gateway-port=')) return arg.slice('--gateway-port='.length)
    if (arg === '--gateway-port') return args[index + 1] ?? ''
  }
  return undefined
}

function gatewayHostArgument(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg.startsWith('--gateway-host=')) return arg.slice('--gateway-host='.length)
    if (arg === '--gateway-host') return args[index + 1] ?? ''
  }
  return undefined
}

async function handleMcpList(args: string[]): Promise<void> {
  const scope = (parseFlag(args, '--scope') ?? 'all') as ConfigScope | 'all'

  try {
    const registry = await discoverMcpCapabilities(process.cwd())
    const servers = registry.servers.filter((server) => scope === 'all' ||
      server.scope === scope ||
      (server.scope === 'legacy' && server.sourcePath === (scope === 'user' ? getUserConfigPath() : getProjectConfigPath(process.cwd()))))

    if (servers.length === 0) {
      console.log('No MCP servers configured.')
      return
    }

    console.log('Discovered MCP servers:\n')
    for (const server of servers) {
      console.log(`  ${server.name} [${server.scope}${server.packageName ? `/${server.packageName}` : ''}]`)
      console.log(`    ${safeMcpConfigSummary(server.config)}`)
      if (server.sourcePath) console.log(`    ${server.sourcePath}`)
    }
    for (const diagnostic of registry.diagnostics) console.error(`  ${diagnostic}`)
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

async function handleGatewayCommand(args: string[], portOverride?: string, hostOverride?: string): Promise<void> {
  const command = args[1] ?? 'status'
  try {
    if (command === 'start') {
      const connection = await ensureGatewayDaemon(portOverride, hostOverride)
      const handshake = await new GatewayClient(connection).handshake()
      console.log(`Model Gateway handshake successful (protocol ${handshake.protocolVersion}, ${handshake.modelCount} models).`)
      const bindHost = connection.host.includes(':') && !connection.host.startsWith('[') ? `[${connection.host}]` : connection.host
      console.log(`Model Gateway running at http://${bindHost}:${connection.port} (protocol ${GATEWAY_PROTOCOL_VERSION}).`)
    } else if (command === 'status') {
      const status = await getGatewayStatus(portOverride, hostOverride)
      if (!status.running) {
        console.log('Model Gateway is not running.')
        return
      }
      console.log(`Model Gateway running at http://${status.host}:${status.port} (version ${status.version ?? 'unknown'}, protocol ${status.protocolVersion ?? 'unknown'}).`)
    } else if (command === 'stop') {
      const stopped = await stopGatewayDaemon()
      console.log(stopped ? 'Model Gateway stopped.' : 'Model Gateway was not running.')
    } else if (command === 'token') {
      if (args.includes('--rotate')) {
        const token = await rotateGatewayToken(portOverride, hostOverride)
        console.log(`Gateway token rotated. Restart clients and start Microcode to use the new token:\n${token}`)
      } else {
        console.log(await showGatewayToken())
      }
    } else {
      console.error(`Unknown gateway subcommand: ${command}`)
      console.error("Run 'microcode gateway --help' for command usage.")
      process.exitCode = 1
    }
  } catch (error) {
    console.error(`Gateway error: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

async function handleModelList(noDaemon = false, portOverride?: string, hostOverride?: string): Promise<void> {
  let gatewayClient: GatewayClient | undefined
  if (!noDaemon) {
    const transport = await initializeTuiModelTransport(() => ensureGatewayDaemon(portOverride, hostOverride), fetch, process.cwd())
    if (transport.mode === 'gateway') {
      gatewayClient = transport.client
      console.log(`Model Gateway handshake successful (protocol ${transport.protocolVersion}, ${transport.modelCount} models).`)
    } else {
      console.error(`Model Gateway handshake failed: ${transport.reason.replace(/[.]+$/, '')}. Falling back to direct model listing for this command.`)
    }
  }
  const all = gatewayClient ? [...gatewayClient.getProjectModels()] : getAllModels()
  const customs = gatewayClient ? [] : getCustomModelDefs()
  const customIds = new Set(customs.map((c) => c.id))

  if (all.length === 0) {
    console.log('No models available.')
    return
  }

  console.log('Available models (provider/model):\n')
  const providers = gatewayClient
    ? [...new Set(all.map((model) => String(model.provider)))].map((id) => ({ id, name: id }))
    : getModels().getProviders()
  for (const provider of providers) {
    const providerModels = all.filter((model) => model.provider === provider.id)
    if (providerModels.length === 0) continue
    console.log(`${provider.name} (${provider.id})${!gatewayClient && 'auth' in provider && provider.auth.oauth?.isSubscription ? ' · subscription OAuth' : ''}`)
    for (const m of providerModels) {
      const isCustom = customIds.has(m.id) || String(m.provider).startsWith('custom:')
      const source = gatewayClient ? '[gateway]' : isCustom ? '[custom]' : '[built-in]'
      const keyInfo = gatewayClient
        ? ' (auth managed by gateway)'
        : (m as any).apiKeyEnv
          ? ` (key: $${(m as any).apiKeyEnv})`
          : 'auth' in provider && provider.auth.oauth && !provider.auth.apiKey?.login
            ? ' (OAuth: /login)'
            : ` (key: ${m.api === 'openai-completions' ? '$OPENAI_API_KEY' : m.api === 'anthropic-messages' ? '$ANTHROPIC_API_KEY' : m.api === 'google-generative-ai' ? '$GEMINI_API_KEY' : '$API_KEY'})`
      const reasoning = m.reasoning ? ', reasoning' : ''
      const vision = m.input.includes('image') ? ', vision' : ''

      console.log(`  ${m.provider}/${m.id} ${source}`)
      console.log(`    ${m.name} | ${m.api}${gatewayClient ? '' : ` | ${m.baseUrl}`}`)
      console.log(`    context: ${m.contextWindow.toLocaleString()}, max tokens: ${m.maxTokens.toLocaleString()}${reasoning}${vision}${keyInfo}`)
      console.log()
    }
  }
}

export async function main(): Promise<void> {
  // Set process title for better visibility in process lists
  try {
    // Try to set process title (may be limited on some platforms)
    process.title = 'microcode'
    // Also set argv0 if possible
    process.argv0 = 'microcode'
  } catch {
    // process.title may not be supported on all platforms
  }

  const args = process.argv.slice(2)
  const gatewayPortOverride = gatewayPortArgument(args)
  const gatewayHostOverride = gatewayHostArgument(args)
  const modelIdx = args.indexOf('--model')
  let modelId: string | undefined
  if (modelIdx !== -1) {
    modelId = args[modelIdx + 1]
    if (!modelId || modelId.startsWith('-')) {
      console.error('Missing model ID after --model')
      process.exit(1)
    }
  }

  if (process.env.MICROCODE_GATEWAY_CHILD === '1') {
    await runGatewayDaemon()
    return
  }

  // Handle --version/-v
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(`${MACRO.VERSION} (Microcode)`)
    process.exit(0)
  }

  // Help is handled before daemon startup and other command side effects.
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(formatCliHelp())
    return
  }

  if (['gateway', 'mcp', 'model'].includes(args[0] ?? '') && args.slice(1).some((arg) => arg === '--help' || arg === '-h')) {
    console.log(formatCliHelp(args[0] as 'gateway' | 'mcp' | 'model'))
    return
  }

  if (args[0] === 'gateway') {
    await handleGatewayCommand(args, gatewayPortOverride, gatewayHostOverride)
    return
  }

  // Handle mcp subcommands: microcode mcp list
  if (args[0] === 'mcp') {
    const subcommand = args[1]
    const mcpArgs = args.slice(2)

    if (subcommand === 'list' || !subcommand) {
      await handleMcpList(mcpArgs)
      process.exit(0)
    } else {
      console.error(`Unknown mcp subcommand: ${subcommand}`)
      console.error("Run 'microcode mcp --help' for command usage.")
      process.exit(1)
    }
  }

  // Handle model subcommands: microcode model list
  if (args[0] === 'model') {
    const subcommand = args[1]
    if (subcommand === 'list') {
      await handleModelList(args.includes('--no-daemon'), gatewayPortOverride, gatewayHostOverride)
      process.exit(0)
    } else {
      console.error(`Unknown model subcommand: ${subcommand}`)
      console.error("Run 'microcode model --help' for command usage.")
      process.exit(1)
    }
  }

  let gatewayClient: GatewayClient | undefined
  let gatewayStartupMessage: { message: string; kind: 'success' | 'error' } | undefined
  if (!args.includes('--no-daemon')) {
    const transport = await initializeTuiModelTransport(() => ensureGatewayDaemon(gatewayPortOverride, gatewayHostOverride), fetch, process.cwd(), modelId)
    if (transport.mode === 'gateway') {
      gatewayClient = transport.client
      gatewayStartupMessage = {
        message: `Model Gateway handshake successful (protocol ${transport.protocolVersion}, ${transport.modelCount} models).`,
        kind: 'success',
      }
    } else {
      gatewayStartupMessage = {
        message: `Model Gateway handshake failed: ${transport.reason.replace(/[.]+$/, '')}. Falling back to --no-daemon mode for this session (in-process model path).`,
        kind: 'error',
      }
    }
  }

  const cwd = process.cwd()
  const pluginManager = await PluginManager.create(cwd, MACRO.VERSION)
  const pluginSnapshot = pluginManager.getSnapshot()
  const projectInstructions = await loadProjectInstructions(cwd)
  const resumeFlagIdx = args.indexOf('--resume')
  const resumeFlag = resumeFlagIdx !== -1
  // Session ID is the arg after --resume, if it exists and isn't another flag
  const resumeSessionId = resumeFlag
    ? (args[resumeFlagIdx + 1] && !args[resumeFlagIdx + 1].startsWith('-')
        ? args[resumeFlagIdx + 1]
        : undefined)
    : undefined
  const filteredArgs: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--gateway-port') {
      index++
      continue
    }
    if (arg === '--gateway-host') {
      index++
      continue
    }
    if (arg.startsWith('--gateway-port=') || arg.startsWith('--gateway-host=') || arg.startsWith('-')) continue
    filteredArgs.push(arg)
  }

  // Parse --permission / --permission-mode flag
  const permModeIdx = args.indexOf('--permission') !== -1
    ? args.indexOf('--permission')
    : args.indexOf('--permission-mode')
  let permissionMode: PermissionMode | undefined
  if (permModeIdx !== -1) {
    const modeArg = args[permModeIdx + 1]?.toLowerCase()
    if (modeArg && PERMISSION_MODES.includes(modeArg as PermissionMode)) {
      permissionMode = modeArg as PermissionMode
    } else {
      console.error(`Invalid permission mode: ${modeArg}. Valid modes: ${PERMISSION_MODES.join(', ')}`)
      process.exit(1)
    }
  }

  // Parse --thinking flag
  const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
  type ThinkingLevel = (typeof THINKING_LEVELS)[number]
  const thinkingIdx = args.indexOf('--thinking')
  let thinkingLevel: ThinkingLevel | undefined
  if (thinkingIdx !== -1) {
    const levelArg = args[thinkingIdx + 1]?.toLowerCase()
    if (levelArg && THINKING_LEVELS.includes(levelArg as ThinkingLevel)) {
      thinkingLevel = levelArg as ThinkingLevel
    } else {
      console.error(`Invalid thinking level: ${levelArg}. Valid levels: ${THINKING_LEVELS.join(', ')}`)
      process.exit(1)
    }
  }

  // Create session manager
  const sessionManager = new SessionManager()

  // Resume or create session
  let restoredMessages: AgentMessage[] | null = null
  if (resumeFlag) {
    let targetSession = null

    if (resumeSessionId) {
      // Resume specific session by ID
      const sessions = await sessionManager.list()
      targetSession = sessions.find((s) => s.id.startsWith(resumeSessionId)) ?? null
      if (!targetSession) {
        console.error(`Session not found: ${resumeSessionId}`)
        process.exit(1)
      }
    } else {
      // Resume latest session for this directory
      targetSession = await sessionManager.getLatestSession(cwd)
    }

    if (targetSession) {
      try {
        restoredMessages = await sessionManager.open(targetSession)
        console.log(`Resumed session: ${targetSession.id.slice(0, 8)}`)
      } catch (error) {
        console.error(`Failed to resume session: ${error instanceof Error ? error.message : String(error)}`)
        sessionManager.beginDraft(cwd)
      }
    } else {
      console.log('No previous session found. Starting new session.')
      sessionManager.beginDraft(cwd)
    }
  } else {
    sessionManager.beginDraft(cwd)
  }

  // Create MCP client and agent without waiting for MCP servers
  const mcpClient = new McpClientManager()
  const agent = createMicrocodeAgentRuntime({
    cwd,
    projectInstructions,
    modelId,
    thinkingLevel,
    permission: { mode: permissionMode },
    pluginSkills: [...pluginSnapshot.skills],
    pluginDiagnostics: [...pluginSnapshot.diagnostics, ...pluginSnapshot.plugins.flatMap((plugin) => plugin.diagnostics.map((diagnostic) => `${plugin.name}: ${diagnostic}`))],
    persistence: sessionManager,
    identity: {
      id: `assistant-${sessionManager.getSessionId() ?? 'session'}`,
      name: 'Microcode',
      role: 'assistant',
    },
    ...(gatewayClient ? {
      initialModelConfig: gatewayClient.getProjectDefaultModelConfig(modelId),
      resolveModelConfig: (id, api, provider) => gatewayClient!.resolveProjectModel(id, api, provider),
      resolveModelApiKey: () => undefined,
      streamFn: gatewayClient.streamSimple,
      models: gatewayClient.asModelsProxy(),
    } : {}),
  })
  // Restore messages if resuming
  if (restoredMessages && restoredMessages.length > 0) {
    agent.replaceMessages(restoredMessages, 'rebuild')
  }

  agent.addTools([createGitWorkTreeTool(() => GitWorkTreeSystem.open(cwd))])

  // Create TUI app (REPL starts immediately)
  let activeGatewayHost = gatewayClient?.bindHost
  const gatewayBindControl = gatewayClient ? {
    getBindHost: () => activeGatewayHost ?? configuredGatewayHost(gatewayHostOverride),
    setBindHost: async (host: string) => {
      const previousHost = activeGatewayHost ?? configuredGatewayHost(gatewayHostOverride)
      if (host === previousHost) return
      await setConfiguredGatewayHost(host)
      try {
        await stopGatewayDaemon()
        const connection = await ensureGatewayDaemon(gatewayPortOverride, host)
        await new GatewayClient(connection).handshake()
        gatewayClient!.setConnection(connection)
        activeGatewayHost = host
      } catch (error) {
        await stopGatewayDaemon().catch(() => undefined)
        await setConfiguredGatewayHost(previousHost)
        try {
          const restored = await ensureGatewayDaemon(gatewayPortOverride, previousHost)
          await new GatewayClient(restored).handshake()
          gatewayClient!.setConnection(restored)
          activeGatewayHost = previousHost
        } catch (restoreError) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}; restoring the previous gateway address also failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`)
        }
        throw error
      }
    },
  } : undefined
  const app = new App(agent, mcpClient, sessionManager, gatewayClient
    ? (model, context, options) => gatewayClient!.completeSimple(model, context, options)
    : undefined, gatewayClient, gatewayClient, gatewayBindControl)
  if (gatewayStartupMessage) app.addStartupMessage(gatewayStartupMessage.message, gatewayStartupMessage.kind)
  const activeMcpServerNames = new Set<string>()
  app.setPluginManager(pluginManager, async (updatedSnapshot) => {
    const snapshot = updatedSnapshot ?? await pluginManager.refresh(MACRO.VERSION)
    const standaloneRegistry = await discoverMcpCapabilities(cwd)
    const standalone = standaloneRegistry.configs
    const desired = { ...standalone }
    const collisions: string[] = []
    for (const [name, config] of Object.entries(snapshot.mcpServers)) {
      if (Object.hasOwn(desired, name)) {
        collisions.push(`Plugin MCP server "${name}" conflicts with a configured MCP server; plugin server skipped.`)
        continue
      }
      desired[name] = config
    }
    for (const name of activeMcpServerNames) {
      if (!Object.hasOwn(desired, name)) {
        await mcpClient.removeServer(name)
        activeMcpServerNames.delete(name)
      }
    }
    const configsToConnect: Array<[string, typeof desired[string]]> = []
    for (const [name, config] of Object.entries(desired)) {
      const current = mcpClient.getServer(name)
      if (current && JSON.stringify(current.config) === JSON.stringify(config) && current.status !== 'disconnected' && current.status !== 'disabled') {
        activeMcpServerNames.add(name)
        continue
      }
      configsToConnect.push([name, config])
    }
    await Promise.allSettled(configsToConnect.map(async ([name, config]) => {
      await mcpClient.connectServer(name, config)
      activeMcpServerNames.add(name)
    }))
    agent.setPluginSkills([...snapshot.skills], [...snapshot.diagnostics, ...snapshot.plugins.flatMap((plugin) => plugin.diagnostics.map((diagnostic) => `${plugin.name}: ${diagnostic}`))])
    app.updateMcpState(mcpClient)
    for (const warning of collisions) app.addStartupWarning(warning)
    for (const warning of standaloneRegistry.diagnostics) app.addStartupWarning(warning)
  })
  for (const warning of pluginSnapshot.diagnostics) app.addStartupWarning(`Plugin discovery: ${warning}`)
  for (const plugin of pluginSnapshot.plugins) {
    if (plugin.health === 'invalid' || plugin.health === 'incompatible') {
      app.addStartupWarning(`Plugin '${plugin.name}' is ${plugin.health}; inspect it with /plugins.`)
    }
  }

  // Wire permission prompt to TUI (own tool calls)
  agent.setPermissionRequestHandler(
    (toolName, input, description) => app.promptPermission(toolName, input, description),
  )
  // Wire ask_user_question interactive handler to TUI
  agent.setAskUserQuestionHandler(
    (toolName, input) => app.promptAskUserQuestion(toolName, input),
  )

  // Handle exit from TUI (Ctrl+C, Ctrl+D, Escape)
  app.onExit = async () => {
    try {
      await agent.persistMessages()
    } catch {
      // Ignore save errors on shutdown
    }
    await sessionManager.close()
    await mcpClient.disconnectAll()
    const sessionId = sessionManager.getSessionId()
    if (sessionId) {
      console.log(`\nResume this session with: microcode --resume ${sessionId.slice(0, 8)}`)
    }
    cleanupImageCache(sessionId ?? '')
    process.exit(0)
  }

  // Connect MCP servers in background — non-blocking
  const standaloneRegistry = await discoverMcpCapabilities(cwd)
  for (const warning of standaloneRegistry.diagnostics) app.addStartupWarning(warning)
  const combinedMcpConfigs = { ...standaloneRegistry.configs }
  for (const [name, config] of Object.entries(pluginSnapshot.mcpServers)) {
    if (Object.hasOwn(combinedMcpConfigs, name)) {
      app.addStartupWarning(`Plugin MCP server "${name}" conflicts with a configured MCP server; plugin server skipped.`)
      continue
    }
    combinedMcpConfigs[name] = config
  }
  for (const name of Object.keys(combinedMcpConfigs)) activeMcpServerNames.add(name)
  if (!isMcpConfigEmpty(combinedMcpConfigs)) {
    void mcpClient.connectAll(combinedMcpConfigs).then(() => {
      // Rebuild system prompt with MCP info and deferred tool names
      app.updateMcpState(mcpClient)

      // Notify user in chat
      app.showMcpReady(mcpClient.getServerStates())
    })
  } else {
    app.updateMcpState(mcpClient)
  }

  // Handle graceful shutdown
  const shutdown = async () => {
    // Save session before exit
    try {
      await agent.persistMessages()
    } catch {
      // Ignore save errors on shutdown
    }
    await sessionManager.close()
    await mcpClient.disconnectAll()
    app.stop()
    // Print resume command
    const sessionId = sessionManager.getSessionId()
    if (sessionId) {
      console.log(`\nResume this session with: microcode --resume ${sessionId.slice(0, 8)}`)
    }
    cleanupImageCache(sessionId ?? '')
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })

  // If there's an initial prompt argument, send it after app starts
  const initialPrompt = filteredArgs.join(' ')
  if (initialPrompt) {
    // Will be handled after app.run() starts
  }

  await app.run()
}

if (import.meta.main) void main()
