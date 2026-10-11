import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
  McpServerConfig,
  McpToolInfo,
  McpResourceInfo,
  McpServerState,
} from './types.ts'

export class McpClientManager {
  private servers = new Map<string, McpServerState>()
  private clients = new Map<string, Client>()
  private operationIds = new Map<string, number>()

  async connectServer(name: string, config: McpServerConfig): Promise<void> {
    const operationId = (this.operationIds.get(name) ?? 0) + 1
    this.operationIds.set(name, operationId)
    const existing = this.clients.get(name)
    if (existing) {
      await existing.close().catch(() => {})
      this.clients.delete(name)
    }
    const state: McpServerState = {
      name,
      config,
      status: 'pending',
      tools: [],
      resources: [],
    }
    this.servers.set(name, state)

    try {
      const client = new Client(
        { name: 'microcode', version: '0.1.0' },
        { capabilities: {} },
      )
      this.clients.set(name, client)

      let transport
      if (config.type === 'sse') {
        transport = new SSEClientTransport(new URL(config.url))
      } else if (config.type === 'http' || config.type === 'streamableHttp') {
        transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: config.headers ? { headers: config.headers } : undefined,
        })
      } else if (config.type === 'ws') {
        // WebSocket - use SSE as fallback since WS transport may not be available
        transport = new SSEClientTransport(new URL(config.url))
      } else {
        // stdio (default)
        const stdioConfig = config as {
          command: string
          args?: string[]
          env?: Record<string, string>
          cwd?: string
        }
        transport = new StdioClientTransport({
          command: stdioConfig.command,
          args: stdioConfig.args ?? [],
          env: stdioConfig.env,
          cwd: stdioConfig.cwd,
          stderr: 'ignore',
        })
      }

      await client.connect(transport)
      if (this.operationIds.get(name) !== operationId || this.servers.get(name) !== state) {
        await client.close().catch(() => {})
        if (this.clients.get(name) === client) this.clients.delete(name)
        return
      }

      // List tools from this server
      const toolsResult = await client.listTools()
      if (this.operationIds.get(name) !== operationId || this.servers.get(name) !== state) {
        await client.close().catch(() => {})
        if (this.clients.get(name) === client) this.clients.delete(name)
        return
      }
      state.tools = (toolsResult.tools ?? []).map((tool) => ({
        name: tool.name,
        serverName: name,
        description: tool.description ?? '',
        inputSchema: (tool.inputSchema ?? {}) as Record<string, any>,
      }))

      // List resources from this server
      try {
        const resourcesResult = await client.listResources()
        state.resources = (resourcesResult.resources ?? []).map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          serverName: name,
          mimeType: resource.mimeType,
          description: resource.description,
        }))
      } catch {
        // Resources may not be supported by this server
        state.resources = []
      }

      // Get server instructions if available
      try {
        const serverInstructions = (client as any).getServerInstructions?.()
        if (serverInstructions) {
          state.instructions = serverInstructions
        }
      } catch {
        // Instructions not available
      }

      state.status = 'connected'
    } catch (error) {
      const client = this.clients.get(name)
      if (client && this.operationIds.get(name) === operationId) {
        await client.close().catch(() => {})
        this.clients.delete(name)
      }
      if (this.operationIds.get(name) !== operationId || this.servers.get(name) !== state) return
      state.status = 'failed'
      state.error = error instanceof Error ? error.message : String(error)
    }
  }

  async connectAll(configs: Record<string, McpServerConfig>): Promise<void> {
    const entries = Object.entries(configs)
    await Promise.allSettled(
      entries.map(([name, config]) => this.connectServer(name, config)),
    )
  }

  getServerStates(): McpServerState[] {
    return Array.from(this.servers.values())
  }

  getConnectedServers(): McpServerState[] {
    return Array.from(this.servers.values()).filter(
      (s) => s.status === 'connected',
    )
  }

  getServer(name: string): McpServerState | undefined {
    return this.servers.get(name)
  }

  async removeServer(name: string): Promise<boolean> {
    this.operationIds.set(name, (this.operationIds.get(name) ?? 0) + 1)
    const client = this.clients.get(name)
    if (client) {
      await client.close().catch(() => {})
      this.clients.delete(name)
    }
    return this.servers.delete(name)
  }

  setServerEnabled(name: string, enabled: boolean): boolean {
    const server = this.servers.get(name)
    if (!server) return false

    if (enabled) {
      if (server.status === 'disabled') {
        // Reconnect
        void this.connectServer(name, server.config)
        return true
      }
    } else {
      // Disconnect and mark as disabled
      const client = this.clients.get(name)
      if (client) {
        void client.close().catch(() => {})
        this.clients.delete(name)
      }
      server.status = 'disabled'
      server.tools = []
      server.resources = []
      return true
    }
    return false
  }

  async reconnectServer(name: string): Promise<boolean> {
    const server = this.servers.get(name)
    if (!server) return false

    // Disconnect existing client
    const client = this.clients.get(name)
    if (client) {
      await client.close().catch(() => {})
      this.clients.delete(name)
    }

    // Reconnect
    await this.connectServer(name, server.config)
    return server.status === 'connected'
  }

  getAllTools(): McpToolInfo[] {
    const tools: McpToolInfo[] = []
    for (const server of this.servers.values()) {
      if (server.status === 'connected') {
        tools.push(...server.tools)
      }
    }
    return tools
  }

  getAllResources(): McpResourceInfo[] {
    const resources: McpResourceInfo[] = []
    for (const server of this.servers.values()) {
      if (server.status === 'connected') {
        resources.push(...server.resources)
      }
    }
    return resources
  }

  async readResource(
    serverName: string,
    uri: string,
  ): Promise<{ contents: Array<{ uri: string; text?: string; mimeType?: string }> }> {
    const client = this.clients.get(serverName)
    if (!client) {
      throw new Error(`MCP server "${serverName}" not connected`)
    }

    const result = await client.readResource({ uri })
    return result as {
      contents: Array<{ uri: string; text?: string; mimeType?: string }>
    }
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, any>,
  ): Promise<{ content: Array<{ type: string; text?: string }> }> {
    const client = this.clients.get(serverName)
    if (!client) {
      throw new Error(`MCP server "${serverName}" not connected`)
    }

    const result = await client.callTool({ name: toolName, arguments: args })
    return result as { content: Array<{ type: string; text?: string }> }
  }

  async disconnectAll(): Promise<void> {
    for (const name of this.servers.keys()) {
      this.operationIds.set(name, (this.operationIds.get(name) ?? 0) + 1)
    }
    for (const [, client] of this.clients) {
      try {
        await client.close()
      } catch {
        // Ignore close errors
      }
    }
    this.clients.clear()
    for (const server of this.servers.values()) {
      if (server.status !== 'disabled') {
        server.status = 'disconnected'
      }
    }
  }
}
