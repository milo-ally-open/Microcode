import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { randomUUID } from 'crypto'
import { loadSkills } from '../skill.ts'
import { getProjectConfigPath, getUserConfigPath } from '../mcp/config.ts'
import { parseMcpJson } from '../mcp/parseConfig.ts'
import type { McpServerConfig } from '../mcp/types.ts'
import type {
  PluginManifest,
  PluginPreference,
  PluginRecord,
  PluginScope,
  PluginServer,
  PluginSnapshot,
  PluginValidationResult,
} from './types.ts'

const MAX_MANIFEST_BYTES = 32 * 1024
const MAX_SKILL_BYTES = 512 * 1024
const MAX_SKILLS = 64
const MAX_TREE_ENTRIES = 4096
const MAX_TREE_DEPTH = 8
const PLUGIN_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const CONFIG_DIRS = ['.git', 'node_modules']

interface PluginConfigFile {
  plugins?: Record<string, PluginPreference>
  [key: string]: unknown
}

interface Candidate {
  rootDir: string
  scope: PluginScope
  directoryName: string
  validation: PluginValidationResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function preferenceFrom(value: unknown): PluginPreference {
  return { enabled: isRecord(value) && value.enabled === true }
}

async function readConfig(path: string): Promise<{ config: PluginConfigFile; diagnostic?: string }> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return { config: {}, diagnostic: `${path}: expected a JSON object` }
    const plugins = isRecord(parsed.plugins) ? parsed.plugins : undefined
    return { config: { ...parsed, plugins: plugins as Record<string, PluginPreference> | undefined } }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { config: {} }
    return {
      config: {},
      diagnostic: `${path}: plugin settings could not be read (${error instanceof Error ? error.message : String(error)}); the file is preserved and plugin-setting changes will be refused until it is valid JSON`,
    }
  }
}

function versionParts(version: string): number[] {
  return version.split(/[.+-]/, 1)[0].split('.').map((part) => Number(part))
}

function isVersionAtLeast(current: string, minimum: string): boolean {
  const left = versionParts(current)
  const right = versionParts(minimum)
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index]
  }
  return true
}

function summarizeServer(name: string, config: McpServerConfig): { transport: string; safeCommandSummary: string } {
  void name
  if ('command' in config) {
    const args = config.args ?? []
    const secretValues = [
      ...Object.values(config.env ?? {}),
    ].filter(Boolean)
    const safeArgs: string[] = []
    let redactNext = false
    for (const arg of args) {
      if (redactNext) {
        safeArgs.push('[redacted]')
        redactNext = false
        continue
      }
      if (/^(?:--?)?(?:api[-_]?key|token|secret|password|credential|authorization)$/i.test(arg)) {
        safeArgs.push(arg)
        redactNext = true
        continue
      }
      if (/^(?:--?)?(?:api[-_]?key|token|secret|password|credential|authorization)=/i.test(arg)) {
        safeArgs.push(`${arg.slice(0, arg.indexOf('=') + 1)}[redacted]`)
        continue
      }
      if (secretValues.some((secret) => arg.includes(secret)) || /^(?:sk-|gh[pousr]_|xox[baprs]-|eyJ[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{40,})/.test(arg)) {
        safeArgs.push('[redacted]')
        continue
      }
      safeArgs.push(arg)
    }
    return {
      transport: 'stdio',
      safeCommandSummary: `stdio → ${basename(config.command) || 'command configured'}${safeArgs.length ? ` ${safeArgs.join(' ')}` : ''}`,
    }
  }
  let endpoint = config.url
  try { endpoint = new URL(config.url).origin } catch {}
  return { transport: config.type, safeCommandSummary: `${config.type} → ${endpoint}` }
}

async function verifySkillTree(rootDir: string): Promise<string[]> {
  const diagnostics: string[] = []
  let count = 0
  let entriesSeen = 0

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > MAX_TREE_DEPTH) {
      diagnostics.push(`${dir}: skill directory nesting exceeds ${MAX_TREE_DEPTH}`)
      return
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      diagnostics.push(`${dir}: cannot read skill directory (${error instanceof Error ? error.message : String(error)})`)
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || CONFIG_DIRS.includes(entry.name)) continue
      entriesSeen++
      if (entriesSeen > MAX_TREE_ENTRIES) {
        diagnostics.push(`${rootDir}: plugin skill tree exceeds the ${MAX_TREE_ENTRIES}-entry limit`)
        return
      }
      const fullPath = join(dir, entry.name)
      const info = await lstat(fullPath)
      if (info.isSymbolicLink()) {
        diagnostics.push(`${fullPath}: symbolic links are not supported in plugin skills`)
        continue
      }
      if (info.isDirectory()) {
        await visit(fullPath, depth + 1)
        continue
      }
      if (!info.isFile() || entry.name !== 'SKILL.md') continue
      count++
      if (count > MAX_SKILLS) {
        diagnostics.push(`${rootDir}: plugin exceeds the ${MAX_SKILLS}-skill limit`)
        return
      }
      if (info.size > MAX_SKILL_BYTES) diagnostics.push(`${fullPath}: skill file exceeds ${MAX_SKILL_BYTES} bytes`)
      const canonical = await realpath(fullPath)
      if (!isWithin(rootDir, canonical)) diagnostics.push(`${fullPath}: resolved path escapes the plugin root`)
    }
  }

  await visit(rootDir, 0)
  return diagnostics
}

export async function validatePluginDirectory(
  inputPath: string,
  scope: PluginScope = 'user',
  expectedDirectoryName?: string,
  microcodeVersion = '0.1.0',
): Promise<PluginValidationResult> {
  void scope
  const requestedRoot = resolve(inputPath)
  const diagnostics: string[] = []
  let rootDir = requestedRoot
  let manifest: PluginManifest | undefined
  let incompatible = false
  let skills: PluginValidationResult['skills'] = []
  let servers: PluginServer[] = []

  try {
    const rootInfo = await lstat(requestedRoot)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error('plugin root must be a real directory, not a symlink')
    }
    rootDir = await realpath(requestedRoot)
  } catch (error) {
    diagnostics.push(`${requestedRoot}: ${error instanceof Error ? error.message : String(error)}`)
    return { valid: false, rootDir, skills, servers, diagnostics }
  }

  try {
    const manifestPath = join(rootDir, 'plugin.json')
    const info = await lstat(manifestPath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('plugin.json must be a regular file')
    if (info.size > MAX_MANIFEST_BYTES) throw new Error(`plugin.json exceeds ${MAX_MANIFEST_BYTES} bytes`)
    const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (!isRecord(parsed)) throw new Error('plugin.json must contain a JSON object')
    if (typeof parsed.name !== 'string' || !PLUGIN_NAME.test(parsed.name) || parsed.name.length > 64) {
      throw new Error('name must be a lowercase kebab-case identifier (maximum 64 characters)')
    }
    if (expectedDirectoryName && parsed.name !== expectedDirectoryName) {
      throw new Error(`manifest name "${parsed.name}" must match directory "${expectedDirectoryName}"`)
    }
    if (typeof parsed.version !== 'string' || !SEMVER.test(parsed.version)) {
      throw new Error('version must be a semantic version such as 1.2.3')
    }
    if (typeof parsed.description !== 'string' || !parsed.description.trim() || parsed.description.length > 1024) {
      throw new Error('description is required and must be at most 1024 characters')
    }
    for (const unsupported of ['agents', 'hooks', 'commands', 'mcpServers', 'lspServers', 'scripts']) {
      if (unsupported in parsed) diagnostics.push(`unsupported manifest component "${unsupported}" is ignored`)
    }
    for (const field of ['homepage', 'repository', 'license']) {
      if (parsed[field] !== undefined && (typeof parsed[field] !== 'string' || parsed[field].length > 2048)) {
        throw new Error(`${field} must be a string of at most 2048 characters`)
      }
    }
    if (parsed.extensions !== undefined && !isRecord(parsed.extensions)) {
      throw new Error('extensions must be an object')
    }
    const microcodeExt = isRecord(parsed.extensions) ? parsed.extensions['com.microcode'] : undefined
    if (microcodeExt !== undefined && !isRecord(microcodeExt)) {
      throw new Error('extensions.com.microcode must be an object')
    }
    if (isRecord(microcodeExt) && microcodeExt.minVersion !== undefined) {
      if (typeof microcodeExt.minVersion !== 'string' || !SEMVER.test(microcodeExt.minVersion)) {
        throw new Error('extensions.com.microcode.minVersion must be a semantic version')
      }
      if (!isVersionAtLeast(microcodeVersion, microcodeExt.minVersion)) {
        incompatible = true
        diagnostics.push(`requires Microcode ${microcodeExt.minVersion} or newer`)
      }
    }
    if (parsed.author !== undefined && (!isRecord(parsed.author) || typeof parsed.author.name !== 'string')) {
      throw new Error('author must be an object with a name')
    }
    manifest = parsed as unknown as PluginManifest
  } catch (error) {
    diagnostics.push(`${join(rootDir, 'plugin.json')}: ${error instanceof Error ? error.message : String(error)}`)
    return { valid: false, rootDir, skills, servers, diagnostics }
  }

  const skillsDir = join(rootDir, 'skills')
  try {
    const info = await lstat(skillsDir)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('skills must be a directory, not a symlink')
    const treeDiagnostics = await verifySkillTree(skillsDir)
    diagnostics.push(...treeDiagnostics)
    const unsafeTree = treeDiagnostics.some((message) => /exceeds the|symbolic links|escapes the plugin root|skill file exceeds/.test(message))
    if (!unsafeTree) {
      const loaded = loadSkills({ cwd: rootDir, skillPaths: [skillsDir], includeDefaults: false })
      diagnostics.push(...loaded.diagnostics)
      skills = loaded.skills.slice(0, MAX_SKILLS).map((skill) => ({ ...skill, name: `${manifest!.name}:${skill.name}`, scope: 'plugin', pluginId: manifest!.name }))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      diagnostics.push(`${skillsDir}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const mcpPath = join(rootDir, 'mcp.json')
  try {
    const info = await lstat(mcpPath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('mcp.json must be a regular file')
    if (info.size > MAX_MANIFEST_BYTES) throw new Error(`mcp.json exceeds ${MAX_MANIFEST_BYTES} bytes`)
    const parsed = parseMcpJson(await readFile(mcpPath, 'utf8'), mcpPath)
    diagnostics.push(...parsed.diagnostics)
    for (const [name, config] of parsed.servers) {
      const qualifiedName = `${manifest.name}--${name}`
      const summary = summarizeServer(name, config)
      servers.push({ pluginName: manifest.name, scope: 'plugin', sourcePath: mcpPath, name, qualifiedName, config, ...summary })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      diagnostics.push(`${mcpPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const valid = Boolean(manifest)
  return {
    valid,
    name: manifest?.name,
    version: manifest?.version,
    description: manifest?.description,
    author: manifest?.author?.name,
    homepage: manifest?.homepage,
    repository: manifest?.repository,
    license: manifest?.license,
    rootDir,
    skills: incompatible ? [] : skills,
    servers: incompatible ? [] : servers,
    diagnostics,
    incompatible,
  }
}

export class PluginManager {
  private records: PluginRecord[] = []
  private diagnostics: string[] = []

  private constructor(
    private readonly cwd: string,
    private readonly paths: {
      userPluginsDir: string
      userConfigPath: string
      projectConfigPath: string
      microcodeVersion: string
    },
  ) {}

  static async create(cwd: string, microcodeVersion = '0.1.0', overrides: Partial<{
    userPluginsDir: string
    userConfigPath: string
    projectConfigPath: string
  }> = {}): Promise<PluginManager> {
    const resolvedCwd = resolve(cwd)
    const manager = new PluginManager(resolvedCwd, {
      userPluginsDir: overrides.userPluginsDir ?? join(homedir(), '.microcode', 'plugins'),
      userConfigPath: overrides.userConfigPath ?? getUserConfigPath(),
      projectConfigPath: overrides.projectConfigPath ?? getProjectConfigPath(resolvedCwd),
      microcodeVersion,
    })
    await manager.refresh(microcodeVersion)
    return manager
  }

  async refresh(microcodeVersion = this.paths.microcodeVersion): Promise<PluginSnapshot> {
    this.paths.microcodeVersion = microcodeVersion
    const projectRoot = join(this.cwd, '.microcode', 'plugins')
    const [userConfig, projectConfig, userCandidates, projectCandidates] = await Promise.all([
      readConfig(this.paths.userConfigPath),
      readConfig(this.paths.projectConfigPath),
      this.discoverRoot(this.paths.userPluginsDir, 'user', microcodeVersion),
      this.discoverRoot(projectRoot, 'project', microcodeVersion),
    ])
    const diagnostics = [
      userConfig.diagnostic,
      projectConfig.diagnostic,
      ...userCandidates.diagnostics,
      ...projectCandidates.diagnostics,
    ].filter((item): item is string => Boolean(item))
    const byName = new Map<string, Candidate>()
    for (const candidate of userCandidates.candidates) byName.set(candidate.validation.name ?? candidate.directoryName, candidate)
    for (const candidate of projectCandidates.candidates) byName.set(candidate.validation.name ?? candidate.directoryName, candidate)

    const userPrefs = userConfig.config.plugins ?? {}
    const projectPrefs = projectConfig.config.plugins ?? {}
    const records: PluginRecord[] = []
    const mcpServers: Record<string, McpServerConfig> = {}
    const skills: PluginRecord['skills'] = []
    const occupiedServerNames = new Set<string>()

    for (const [name, candidate] of [...byName.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const validation = candidate.validation
      const rawPreference = Object.hasOwn(projectPrefs, name) ? projectPrefs[name] : userPrefs[name]
      const preference = preferenceFrom(rawPreference)
      const recordDiagnostics = [...validation.diagnostics]
      const enabled = validation.valid && !validation.incompatible && preference.enabled
      const recordSkills = validation.skills
      const recordServers = validation.valid && !validation.incompatible ? validation.servers : []
      for (const server of recordServers) {
        if (occupiedServerNames.has(server.qualifiedName)) {
          recordDiagnostics.push(`MCP server name collision: ${server.qualifiedName}`)
          continue
        }
        occupiedServerNames.add(server.qualifiedName)
        if (enabled) mcpServers[server.qualifiedName] = {
          ...server.config,
          ...('command' in server.config ? { cwd: candidate.rootDir } : {}),
        } as McpServerConfig
      }

      if (enabled) skills.push(...recordSkills)
      records.push({
        name,
        version: validation.version ?? 'unknown',
        description: validation.description ?? 'Invalid plugin package',
        author: validation.author,
        homepage: validation.homepage,
        repository: validation.repository,
        license: validation.license,
        rootDir: candidate.rootDir,
        scope: candidate.scope,
        valid: validation.valid,
        health: validation.incompatible ? 'incompatible' : !validation.valid ? 'invalid' : recordDiagnostics.length ? 'warning' : 'ready',
        enabled,
        skills: recordSkills,
        servers: recordServers,
        diagnostics: recordDiagnostics,
      })
    }

    this.records = records
    this.diagnostics = diagnostics
    return this.getSnapshot(mcpServers, skills)
  }

  getSnapshot(
    mcpServers?: Readonly<Record<string, McpServerConfig>>,
    skills?: readonly import('../skill.ts').Skill[],
  ): PluginSnapshot {
    const resolvedServers = mcpServers ?? this.buildMcpServers()
    const resolvedSkills = skills ?? this.records.filter((plugin) => plugin.enabled).flatMap((plugin) => plugin.skills)
    return Object.freeze({
      plugins: Object.freeze(this.records.map((plugin) => Object.freeze({
        ...plugin,
        skills: Object.freeze([...plugin.skills]) as unknown as PluginRecord['skills'],
        servers: Object.freeze([...plugin.servers]) as unknown as PluginRecord['servers'],
        diagnostics: Object.freeze([...plugin.diagnostics]) as unknown as string[],
      }))),
      skills: Object.freeze([...resolvedSkills]),
      mcpServers: Object.freeze({ ...resolvedServers }),
      diagnostics: Object.freeze([...this.diagnostics]),
    })
  }

  getPlugins(): readonly PluginRecord[] {
    return this.records
  }

  findPlugin(name: string): PluginRecord | undefined {
    return this.records.find((plugin) => plugin.name === name)
  }

  async setEnabled(name: string, enabled: boolean): Promise<PluginSnapshot> {
    const plugin = this.findPlugin(name)
    if (!plugin) throw new Error(`Plugin "${name}" was not found.`)
    if (!plugin.valid) throw new Error(`Plugin "${name}" is invalid and cannot be enabled.`)
    if (plugin.health === 'incompatible') throw new Error(`Plugin "${name}" is incompatible with this Microcode version.`)
    const scope = plugin.scope
    await this.updatePreference(name, scope, (current) => ({ ...current, enabled }))
    return this.refresh()
  }

  async setEnabledMany(scope: PluginScope, desiredStates: ReadonlyMap<string, boolean>): Promise<PluginSnapshot> {
    const changes = new Map<string, boolean>()
    for (const [name, enabled] of desiredStates) {
      const plugin = this.findPlugin(name)
      if (!plugin) throw new Error(`Plugin "${name}" was not found.`)
      if (plugin.scope !== scope) throw new Error(`Plugin "${name}" does not belong to the ${scope} scope.`)
      if (enabled && !plugin.valid) throw new Error(`Plugin "${name}" is invalid and cannot be enabled.`)
      if (enabled && plugin.health === 'incompatible') throw new Error(`Plugin "${name}" is incompatible with this Microcode version.`)
      if (plugin.enabled !== enabled) changes.set(name, enabled)
    }
    if (changes.size === 0) return this.getSnapshot()

    const path = scope === 'user' ? this.paths.userConfigPath : this.paths.projectConfigPath
    let config: PluginConfigFile = {}
    try {
      const raw = await readFile(path, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed)) throw new Error('expected a JSON object')
      config = parsed as PluginConfigFile
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Cannot update plugin settings in ${path}: existing config is invalid and was left unchanged (${error instanceof Error ? error.message : String(error)})`)
      }
    }

    const plugins = isRecord(config.plugins) ? config.plugins : {}
    const updatedPlugins = { ...plugins }
    for (const [name, enabled] of changes) {
      const current = preferenceFrom(updatedPlugins[name])
      updatedPlugins[name] = { ...current, enabled }
    }
    config.plugins = updatedPlugins as Record<string, PluginPreference>
    await mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`
    try {
      await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, path)
    } catch (error) {
      await import('fs/promises').then(({ rm }) => rm(temporaryPath, { force: true })).catch(() => {})
      throw error
    }
    return this.refresh()
  }

  private buildMcpServers(): Record<string, McpServerConfig> {
    const servers: Record<string, McpServerConfig> = {}
    for (const plugin of this.records) {
      if (!plugin.enabled || !plugin.valid || plugin.health === 'incompatible') continue
      for (const server of plugin.servers) {
        servers[server.qualifiedName] = {
          ...server.config,
          ...('command' in server.config ? { cwd: plugin.rootDir } : {}),
        } as McpServerConfig
      }
    }
    return servers
  }

  private async updatePreference(
    name: string,
    scope: PluginScope,
    update: (preference: PluginPreference) => PluginPreference,
  ): Promise<void> {
    const path = scope === 'user' ? this.paths.userConfigPath : this.paths.projectConfigPath
    let config: PluginConfigFile = {}
    try {
      const raw = await readFile(path, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed)) throw new Error('expected a JSON object')
      config = parsed as PluginConfigFile
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Cannot update plugin settings in ${path}: existing config is invalid and was left unchanged (${error instanceof Error ? error.message : String(error)})`)
      }
    }

    const plugins = isRecord(config.plugins) ? config.plugins : {}
    const current = preferenceFrom(plugins[name])
    config.plugins = { ...plugins, [name]: update(current) }
    await mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`
    try {
      await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, path)
    } catch (error) {
      await import('fs/promises').then(({ rm }) => rm(temporaryPath, { force: true })).catch(() => {})
      throw error
    }
  }

  private async discoverRoot(rootDir: string, scope: PluginScope, microcodeVersion: string): Promise<{
    candidates: Candidate[]
    diagnostics: string[]
  }> {
    const candidates: Candidate[] = []
    const diagnostics: string[] = []
    let entries
    try {
      const info = await lstat(rootDir)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        return { candidates, diagnostics: [`${rootDir}: plugin directory must not be a symlink`] }
      }
      entries = await readdir(rootDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { candidates, diagnostics }
      return { candidates, diagnostics: [`${rootDir}: ${error instanceof Error ? error.message : String(error)}`] }
    }

    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.name.startsWith('.')) continue
      const path = join(rootDir, entry.name)
      if (!entry.isDirectory()) {
        if (entry.isSymbolicLink()) diagnostics.push(`${path}: plugin package symlink is not supported`)
        continue
      }
      const validation = await validatePluginDirectory(path, scope, entry.name, microcodeVersion)
      candidates.push({ rootDir: validation.rootDir, scope, directoryName: entry.name, validation })
    }
    return { candidates, diagnostics }
  }
}

export { PluginManager as default }
