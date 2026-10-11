import type { McpServerConfig } from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function validateMcpServerConfig(name: string, value: unknown): McpServerConfig {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || name.includes('--')) {
    throw new Error(`invalid MCP server name "${name}"`)
  }
  if (!isRecord(value)) throw new Error(`MCP server "${name}" must be an object`)

  if (typeof value.command === 'string') {
    if (!value.command.trim()) throw new Error(`MCP server "${name}" command must not be empty`)
    if (value.type !== undefined && value.type !== 'stdio') throw new Error(`MCP server "${name}" has unsupported stdio type`)
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((item) => typeof item !== 'string'))) {
      throw new Error(`MCP server "${name}" args must be an array of strings`)
    }
    if (value.env !== undefined && (!isRecord(value.env) || Object.values(value.env).some((item) => typeof item !== 'string'))) {
      throw new Error(`MCP server "${name}" env must contain string values`)
    }
    if (value.cwd !== undefined && typeof value.cwd !== 'string') throw new Error(`MCP server "${name}" cwd must be a string`)
    return value as unknown as McpServerConfig
  }

  if (typeof value.url !== 'string' || !['sse', 'http', 'streamableHttp', 'ws'].includes(String(value.type))) {
    throw new Error(`MCP server "${name}" must use stdio { command } or remote { type, url }`)
  }
  let url: URL
  try { url = new URL(value.url) } catch { throw new Error(`MCP server "${name}" URL must be absolute`) }
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (!secure && !loopback) throw new Error(`MCP server "${name}" must use a secure URL except on loopback`)
  if (value.headers !== undefined && (!isRecord(value.headers) || Object.values(value.headers).some((item) => typeof item !== 'string'))) {
    throw new Error(`MCP server "${name}" headers must contain string values`)
  }
  return value as unknown as McpServerConfig
}

export interface ParsedMcpJson {
  servers: Map<string, McpServerConfig>
  diagnostics: string[]
}

/** Parse a plugin or standalone package through the same MCP schema. */
export function parseMcpJson(content: string, sourcePath: string): ParsedMcpJson {
  const servers = new Map<string, McpServerConfig>()
  const diagnostics: string[] = []
  let parsed: unknown
  try { parsed = JSON.parse(content) } catch (error) {
    return { servers, diagnostics: [`${sourcePath}: invalid JSON (${error instanceof Error ? error.message : 'parse error'})`] }
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    return { servers, diagnostics: [`${sourcePath}: mcp.json must contain an mcpServers object`] }
  }
  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    try { servers.set(name, validateMcpServerConfig(name, value)) }
    catch (error) { diagnostics.push(`${sourcePath}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  return { servers, diagnostics }
}
