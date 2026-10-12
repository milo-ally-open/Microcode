import { createMicrocodeAgentRuntime } from '../agent/index.ts'
import type { CreateMicrocodeAgentOptions } from '../agent/types.ts'
import { PluginManager } from '../plugins/PluginManager.ts'
import { SessionManager } from '../session/SessionManager.ts'
import { McpClientManager } from '../mcp/client.ts'
import { discoverMcpCapabilities } from '../mcp/capabilities.ts'
import { loadProjectInstructions } from '../instructions/projectInstructions.ts'
import { createGitWorkTreeTool } from '../tools/index.ts'
import { GitWorkTreeSystem } from '../git/index.ts'
import type { McpServerConfig } from '../mcp/types.ts'
import { cleanupImageCache } from '../utils/imageUtils.ts'
import { ApplicationRuntime } from './ApplicationRuntime.ts'

export interface RuntimeFactoryOptions {
  readonly cwd: string
  readonly microcodeVersion: string
  readonly agent?: Omit<CreateMicrocodeAgentOptions, 'cwd' | 'projectInstructions' | 'pluginSkills' | 'pluginDiagnostics' | 'persistence'>
  readonly sessions?: SessionManager
  readonly plugins?: PluginManager
  readonly mcp?: McpClientManager
}

export interface RuntimeFactoryResult {
  readonly runtime: ApplicationRuntime
  readonly startupWarnings: readonly string[]
  readonly mcpReady: Promise<void>
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>
}

/** Creates the project-scoped resource graph around the existing MicrocodeAgent. */
export class RuntimeFactory {
  static async create(options: RuntimeFactoryOptions): Promise<RuntimeFactoryResult> {
    const cwd = options.cwd
    const [plugins, instructions] = await Promise.all([
      options.plugins ? Promise.resolve(options.plugins) : PluginManager.create(cwd, options.microcodeVersion),
      loadProjectInstructions(cwd),
    ])
    const sessions = options.sessions ?? new SessionManager()
    const mcp = options.mcp ?? new McpClientManager()
    sessions.beginDraft(cwd)
    const pluginSnapshot = plugins.getSnapshot()
    const agent = createMicrocodeAgentRuntime({
      ...options.agent,
      cwd,
      projectInstructions: instructions,
      pluginSkills: [...pluginSnapshot.skills],
      pluginDiagnostics: [
        ...pluginSnapshot.diagnostics,
        ...pluginSnapshot.plugins.flatMap((plugin) => plugin.diagnostics.map((diagnostic) => `${plugin.name}: ${diagnostic}`)),
      ],
      persistence: sessions,
    })
    agent.addTools([createGitWorkTreeTool(() => GitWorkTreeSystem.open(cwd))])

    const runtime = new ApplicationRuntime({
      cwd,
      agent,
      sessions,
      mcp,
      plugins,
      onClosed: (sessionId) => cleanupImageCache(sessionId ?? ''),
    })
    const capabilities = await discoverMcpCapabilities(cwd)
    const startupWarnings = [...capabilities.diagnostics, ...pluginSnapshot.diagnostics.map((message) => `Plugin discovery: ${message}`)]
    const seenMcpNames = new Set(Object.keys(capabilities.configs))
    const mcpServers: Record<string, McpServerConfig> = { ...capabilities.configs }
    for (const [name] of Object.entries(pluginSnapshot.mcpServers)) {
      if (seenMcpNames.has(name)) {
        startupWarnings.push(`Plugin MCP server "${name}" conflicts with a configured MCP server; plugin server skipped.`)
      } else {
        seenMcpNames.add(name)
        mcpServers[name] = pluginSnapshot.mcpServers[name]!
      }
    }
    for (const plugin of pluginSnapshot.plugins) {
      if (plugin.health === 'invalid' || plugin.health === 'incompatible') {
        startupWarnings.push(`Plugin '${plugin.name}' is ${plugin.health}; inspect it with /plugins.`)
      }
    }
    const mcpReady = runtime.configureMcpServers(capabilities.configs)
    void mcpReady.catch(() => undefined)
    return {
      runtime,
      startupWarnings: Object.freeze(startupWarnings),
      mcpReady,
      mcpServers: Object.freeze(mcpServers),
    }
  }
}
