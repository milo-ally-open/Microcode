export type CapabilityScope = 'system' | 'user' | 'project' | 'plugin' | 'path' | 'legacy'

export interface McpStdioServerConfig {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface McpSSEServerConfig {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

export interface McpHTTPServerConfig {
  type: 'http' | 'streamableHttp'
  url: string
  headers?: Record<string, string>
}

export interface McpWebSocketServerConfig {
  type: 'ws'
  url: string
  headers?: Record<string, string>
}

export type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHTTPServerConfig
  | McpWebSocketServerConfig

export type McpScope = CapabilityScope

export interface ResolvedMcpServer {
  name: string
  config: McpServerConfig
  scope: McpScope
  packageName?: string
  sourcePath?: string
  pluginId?: string
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>
}

export interface McpToolInfo {
  name: string
  serverName: string
  description: string
  inputSchema: Record<string, any>
}

export interface McpResourceInfo {
  uri: string
  name: string
  serverName: string
  mimeType?: string
  description?: string
}

export type McpServerStatus =
  | 'connected'
  | 'failed'
  | 'pending'
  | 'disconnected'
  | 'disabled'

export interface McpServerState {
  name: string
  config: McpServerConfig
  status: McpServerStatus
  error?: string
  tools: McpToolInfo[]
  resources: McpResourceInfo[]
  instructions?: string
}
