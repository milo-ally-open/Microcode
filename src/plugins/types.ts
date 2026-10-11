import type { McpServerConfig } from '../mcp/types.ts'
import type { Skill } from '../skill.ts'

export type PluginScope = 'user' | 'project'
export type PluginHealth = 'ready' | 'warning' | 'invalid' | 'incompatible'

export interface PluginManifest {
  $schema?: string
  name: string
  version: string
  description: string
  author?: { name: string; email?: string; url?: string }
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  extensions?: {
    'com.microcode'?: { minVersion?: string }
    [key: string]: unknown
  }
}

export interface PluginPreference {
  enabled: boolean
}

export interface PluginServer {
  pluginName: string
  scope: 'plugin'
  sourcePath: string
  name: string
  qualifiedName: string
  config: McpServerConfig
  transport: string
  safeCommandSummary: string
}

export interface PluginRecord {
  name: string
  version: string
  description: string
  author?: string
  homepage?: string
  repository?: string
  license?: string
  rootDir: string
  scope: PluginScope
  valid: boolean
  health: PluginHealth
  enabled: boolean
  skills: Skill[]
  servers: PluginServer[]
  diagnostics: string[]
}

export interface PluginSnapshot {
  plugins: readonly PluginRecord[]
  skills: readonly Skill[]
  mcpServers: Readonly<Record<string, McpServerConfig>>
  diagnostics: readonly string[]
}

export interface PluginValidationResult {
  valid: boolean
  name?: string
  version?: string
  description?: string
  author?: string
  homepage?: string
  repository?: string
  license?: string
  rootDir: string
  skills: Skill[]
  servers: PluginServer[]
  diagnostics: string[]
  incompatible?: boolean
}
