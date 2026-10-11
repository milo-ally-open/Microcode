import { lstat, readFile, readdir } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'
import { getProjectConfigPath, getUserConfigPath } from './config.ts'
import { parseMcpJson } from './parseConfig.ts'
import type { McpServerConfig, ResolvedMcpServer } from './types.ts'

export interface McpCapabilitiesResult {
  servers: ResolvedMcpServer[]
  configs: Record<string, McpServerConfig>
  diagnostics: string[]
}

export function safeMcpConfigSummary(config: McpServerConfig): string {
  if ('command' in config) {
    const args: string[] = []
    const original = config.args ?? []
    const secretValues = Object.values(config.env ?? {}).filter(Boolean)
    let redactNext = false
    for (const arg of original) {
      if (redactNext) { args.push('[redacted]'); redactNext = false; continue }
      if (/^(?:--?)?(?:api[-_]?key|token|secret|password|credential|authorization)$/i.test(arg)) {
        args.push(arg); redactNext = true; continue
      }
      if (/^(?:-H|--header|--headers|--auth|--password|-u)$/i.test(arg)) { args.push(arg); redactNext = true; continue }
      if (/^(?:--?)?(?:api[-_]?key|token|secret|password|credential|authorization)=/i.test(arg)) {
        args.push(`${arg.slice(0, arg.indexOf('=') + 1)}[redacted]`); continue
      }
      if (secretValues.some((secret) => arg.includes(secret)) || /^(?:sk-|gh[pousr]_|xox[baprs]-|eyJ[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{40,})/.test(arg)) {
        args.push('[redacted]'); continue
      }
      args.push(arg)
    }
    return `stdio → ${basename(config.command) || 'command configured'}${args.length ? ` ${args.join(' ')}` : ''}`
  }
  let endpoint = config.url
  try { endpoint = new URL(config.url).origin } catch {}
  return `${config.type} → ${endpoint}`
}

interface Candidate extends ResolvedMcpServer {
  priority: number
}

async function discoverPackages(
  root: string,
  scope: 'system' | 'user' | 'project',
  diagnostics: string[],
): Promise<Candidate[]> {
  const found: Candidate[] = []
  let entries
  try {
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      diagnostics.push(`${root}: MCP package root must be a real directory`)
      return found
    }
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostics.push(`${root}: ${error instanceof Error ? error.message : String(error)}`)
    return found
  }
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (scope !== 'system' && entry.name.startsWith('.')) continue
    if (entry.name === 'node_modules' || !entry.isDirectory()) continue
    const packageDir = join(root, entry.name)
    const configPath = join(packageDir, 'mcp.json')
    try {
      const packageInfo = await lstat(packageDir)
      const fileInfo = await lstat(configPath)
      if (packageInfo.isSymbolicLink() || !packageInfo.isDirectory() || fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
        diagnostics.push(`${configPath}: MCP package and mcp.json must be regular paths`)
        continue
      }
      if (fileInfo.size > 32 * 1024) {
        diagnostics.push(`${configPath}: mcp.json exceeds 32768 bytes`)
        continue
      }
      const parsed = parseMcpJson(await readFile(configPath, 'utf8'), configPath)
      diagnostics.push(...parsed.diagnostics)
      for (const [name, config] of parsed.servers) {
        const effectiveConfig: McpServerConfig = 'command' in config ? { ...config, cwd: config.cwd ?? packageDir } : config
        const priority = scope === 'system' ? 100 : scope === 'project' ? 40 : 20
        found.push({ name, config: effectiveConfig, scope, packageName: entry.name, sourcePath: configPath, priority })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostics.push(`${configPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return found
}

async function discoverLegacy(configPath: string, scope: 'user' | 'project', diagnostics: string[]): Promise<Candidate[]> {
  let config: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      diagnostics.push(`${configPath}: config.json must contain a JSON object`)
      return []
    }
    config = parsed as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      diagnostics.push(`${configPath}: config.json could not be read as valid JSON`)
    }
    return []
  }
  const map = config.mcpServers
  if (map === undefined) return []
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    diagnostics.push(`${configPath}: mcpServers must be an object`)
    return []
  }
  const parsed = parseMcpJson(JSON.stringify({ mcpServers: map }), configPath)
  diagnostics.push(...parsed.diagnostics)
  const priority = scope === 'project' ? 50 : 30
  return [...parsed.servers].map(([name, serverConfig]) => ({
    name, config: serverConfig, scope: 'legacy', sourcePath: configPath,
    priority,
  }))
}

export async function discoverMcpCapabilities(cwd: string): Promise<McpCapabilitiesResult> {
  const userHome = join(homedir(), '.microcode')
  const projectHome = join(cwd, '.microcode')
  const diagnostics: string[] = []
  const candidates = [
    ...await discoverPackages(join(userHome, 'mcp', '.system'), 'system', diagnostics),
    ...await discoverPackages(join(userHome, 'mcp'), 'user', diagnostics),
    ...await discoverLegacy(getUserConfigPath(), 'user', diagnostics),
    ...await discoverPackages(join(projectHome, 'mcp'), 'project', diagnostics),
    ...await discoverLegacy(getProjectConfigPath(cwd), 'project', diagnostics),
  ].sort((a, b) => b.priority - a.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const selected = new Map<string, Candidate>()
  for (const item of candidates) {
    const current = selected.get(item.name)
    if (current) {
      diagnostics.push(current.scope === 'system'
        ? `MCP server "${item.name}" conflicts with reserved system server; ${item.scope} server ignored.`
        : `MCP server "${item.name}" from ${item.sourcePath ?? item.scope} conflicts with ${current.sourcePath ?? current.scope}; ${current.scope} source selected.`)
      continue
    }
    selected.set(item.name, item)
  }

  // Any system identifier remains reserved even if a higher-level source was encountered first.
  const systemNames = new Set(candidates.filter((item) => item.scope === 'system').map((item) => item.name))
  for (const [name, item] of [...selected]) {
    if (systemNames.has(name) && item.scope !== 'system') {
      selected.delete(name)
      const system = candidates.find((candidate) => candidate.name === name && candidate.scope === 'system')
      if (system) selected.set(name, system)
      diagnostics.push(`MCP server "${name}" conflicts with reserved system server; ${item.scope} server ignored.`)
    }
  }

  const resolved: ResolvedMcpServer[] = []
  const configs: Record<string, McpServerConfig> = {}
  for (const item of selected.values()) {
    const server = { name: item.name, config: item.config, scope: item.scope, packageName: item.packageName, sourcePath: item.sourcePath, pluginId: item.pluginId }
    resolved.push(server)
    configs[item.name] = item.config
  }
  return { servers: resolved, configs, diagnostics }
}
