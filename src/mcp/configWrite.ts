import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { CustomModelDef } from '../models/custom.ts'
import { getUserConfigPath, getProjectConfigPath } from './config.ts'
import type { McpServerConfig, McpConfig } from './types.ts'

export type ConfigScope = 'user' | 'project'

export interface ProjectConfigWriteResult {
  path: string
  count: number
  names: string[]
}

type ProjectConfig = Record<string, unknown> & {
  mcpServers?: Record<string, McpServerConfig>
  models?: CustomModelDef[]
}

async function readProjectConfig(path: string): Promise<ProjectConfig> {
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ProjectConfig : {}
  } catch {
    return {}
  }
}

async function writeProjectConfig(path: string, config: ProjectConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validateProjectMcpServer(name: string, value: unknown): McpServerConfig {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid MCP server name "${name}". Use letters, numbers, hyphens, or underscores.`)
  }
  if (!isRecord(value)) throw new Error(`Invalid MCP server "${name}": expected an object.`)
  if (typeof value.command === 'string') return value as unknown as McpServerConfig
  if (typeof value.url === 'string' && ['sse', 'http', 'streamableHttp', 'ws'].includes(String(value.type))) {
    return value as unknown as McpServerConfig
  }
  throw new Error(`Invalid MCP server "${name}": expected stdio { command } or remote { type, url }.`)
}

function extractProjectMcpServers(parsed: unknown): Record<string, McpServerConfig> {
  if (!isRecord(parsed)) throw new Error('MCP config must be a JSON object.')
  const source = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed
  const entries = Object.entries(source)
  if (entries.length === 0) throw new Error('No MCP servers found in pasted config.')
  return Object.fromEntries(entries.map(([name, server]) => [name, validateProjectMcpServer(name, server)]))
}

function validateProjectModel(value: unknown): CustomModelDef {
  if (!isRecord(value)) throw new Error('Invalid model: expected an object.')
  for (const key of ['id', 'name', 'api', 'baseUrl'] as const) {
    if (typeof value[key] !== 'string' || !String(value[key]).trim()) {
      throw new Error(`Invalid model: "${key}" is required.`)
    }
  }
  if (typeof value.contextWindow !== 'number') throw new Error('Invalid model: "contextWindow" must be a number.')
  if (typeof value.maxTokens !== 'number') throw new Error('Invalid model: "maxTokens" must be a number.')
  return value as unknown as CustomModelDef
}

function extractProjectModels(parsed: unknown): CustomModelDef[] {
  const source = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.models)
      ? parsed.models
      : isRecord(parsed)
        ? [parsed]
        : []
  const models = source.map(validateProjectModel)
  if (models.length === 0) throw new Error('No models found in pasted config.')
  return models
}

export async function mergeProjectMcpServers(cwd: string, rawJson: string): Promise<ProjectConfigWriteResult> {
  const servers = extractProjectMcpServers(parseJson(rawJson))
  const path = getProjectConfigPath(cwd)
  const config = await readProjectConfig(path)
  config.mcpServers = { ...(config.mcpServers ?? {}), ...servers }
  await writeProjectConfig(path, config)
  const names = Object.keys(servers)
  return { path, count: names.length, names }
}

export async function mergeProjectModels(cwd: string, rawJson: string): Promise<ProjectConfigWriteResult> {
  const models = extractProjectModels(parseJson(rawJson))
  const path = getProjectConfigPath(cwd)
  const config = await readProjectConfig(path)
  const merged = new Map<string, CustomModelDef>()
  for (const model of config.models ?? []) merged.set(model.id, model)
  for (const model of models) merged.set(model.id, model)
  config.models = [...merged.values()]
  await writeProjectConfig(path, config)
  return { path, count: models.length, names: models.map((model) => model.id) }
}

function getConfigPath(scope: ConfigScope, cwd: string): string {
  return scope === 'user' ? getUserConfigPath() : getProjectConfigPath(cwd)
}

function validateServerName(name: string): void {
  if (!name) {
    throw new Error('Server name is required.')
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(
      `Invalid server name "${name}". Names can only contain letters, numbers, hyphens, and underscores.`,
    )
  }
}

async function readConfigFile(path: string): Promise<McpConfig> {
  try {
    const content = await readFile(path, 'utf-8')
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object' && parsed.mcpServers) {
      return parsed as McpConfig
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return { mcpServers: {} }
}

async function writeConfigFile(path: string, config: McpConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const content = JSON.stringify(config, null, 2) + '\n'
  await writeFile(path, content, 'utf-8')
}

export async function addMcpServer(
  name: string,
  serverConfig: McpServerConfig,
  scope: ConfigScope,
  cwd: string,
): Promise<string> {
  validateServerName(name)

  const configPath = getConfigPath(scope, cwd)
  const config = await readConfigFile(configPath)

  if (config.mcpServers[name]) {
    throw new Error(
      `MCP server "${name}" already exists in ${scope} config. Remove it first or use a different name.`,
    )
  }

  config.mcpServers[name] = serverConfig
  await writeConfigFile(configPath, config)

  return configPath
}

export async function removeMcpServer(
  name: string,
  scope: ConfigScope,
  cwd: string,
): Promise<string> {
  validateServerName(name)

  const configPath = getConfigPath(scope, cwd)
  const config = await readConfigFile(configPath)

  if (!config.mcpServers[name]) {
    throw new Error(`MCP server "${name}" not found in ${scope} config.`)
  }

  delete config.mcpServers[name]
  await writeConfigFile(configPath, config)

  return configPath
}

export async function listMcpServers(
  scope: ConfigScope | 'all',
  cwd: string,
): Promise<{ scope: ConfigScope; name: string; config: McpServerConfig }[]> {
  const results: { scope: ConfigScope; name: string; config: McpServerConfig }[] = []

  const scopes: ConfigScope[] = scope === 'all' ? ['user', 'project'] : [scope]

  for (const s of scopes) {
    const configPath = getConfigPath(s, cwd)
    const config = await readConfigFile(configPath)
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      results.push({ scope: s, name, config: serverConfig })
    }
  }

  return results
}

export function parseEnvVars(envArray: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of envArray) {
    const eqIndex = entry.indexOf('=')
    if (eqIndex === -1) {
      throw new Error(
        `Invalid environment variable format: "${entry}". Expected KEY=value.`,
      )
    }
    const key = entry.substring(0, eqIndex).trim()
    const value = entry.substring(eqIndex + 1)
    if (!key) {
      throw new Error(`Empty key in environment variable: "${entry}"`)
    }
    env[key] = value
  }
  return env
}

export function parseHeaders(headerArray: string[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const header of headerArray) {
    const colonIndex = header.indexOf(':')
    if (colonIndex === -1) {
      throw new Error(
        `Invalid header format: "${header}". Expected "Header-Name: value".`,
      )
    }
    const key = header.substring(0, colonIndex).trim()
    const value = header.substring(colonIndex + 1).trim()
    if (!key) {
      throw new Error(`Empty key in header: "${header}"`)
    }
    headers[key] = value
  }
  return headers
}

export function getScopeDescription(scope: ConfigScope): string {
  return scope === 'user'
    ? getUserConfigPath()
    : `project .microcode/config.json`
}
