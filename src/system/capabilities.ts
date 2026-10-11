import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import skillCreator from './skills/skill-creator/SKILL.md' with { type: 'text' }
import mcpCreator from './skills/mcp-creator/SKILL.md' with { type: 'text' }
import pluginCreator from './skills/plugin-creator/SKILL.md' with { type: 'text' }

export interface EmbeddedSystemPackage {
  name: string
  files: Readonly<Record<string, string>>
}

export const SYSTEM_SKILLS: readonly EmbeddedSystemPackage[] = [
  { name: 'skill-creator', files: { 'SKILL.md': skillCreator } },
  { name: 'mcp-creator', files: { 'SKILL.md': mcpCreator } },
  { name: 'plugin-creator', files: { 'SKILL.md': pluginCreator } },
]

export const SYSTEM_MCP_PACKAGES: readonly EmbeddedSystemPackage[] = []

function compareName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export interface SystemManifest {
  schemaVersion: 1
  managedBy: 'microcode'
  microcodeVersion: string
  fingerprint: string
  generatedAt: string
}

export function getSystemSkillsRoot(): string {
  return join(homedir(), '.microcode', 'skills', '.system')
}

export function getSystemMcpRoot(): string {
  return join(homedir(), '.microcode', 'mcp', '.system')
}

function getVersion(): string {
  return (globalThis as typeof globalThis & { MACRO?: { VERSION?: string } }).MACRO?.VERSION ?? '0.1.0'
}

function fingerprintAssets(assets: readonly EmbeddedSystemPackage[]): string {
  const hash = createHash('sha256')
  const sorted = [...assets].sort((a, b) => compareName(a.name, b.name))
  for (const asset of sorted) {
    for (const [path, content] of Object.entries(asset.files).sort(([a], [b]) => compareName(a, b))) {
      const normalizedPath = `${asset.name}/${path.replace(/\\/g, '/')}`
      hash.update(normalizedPath).update('\0').update(content).update('\0')
    }
  }
  return `sha256:${hash.digest('hex')}`
}

function validManifest(root: string, fingerprint: string, assets: readonly EmbeddedSystemPackage[]): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(root, '.manifest.json'), 'utf8')) as Partial<SystemManifest>
    if (parsed.schemaVersion !== 1 || parsed.managedBy !== 'microcode' || parsed.fingerprint !== fingerprint) return false
    for (const asset of assets) {
      for (const [path, content] of Object.entries(asset.files)) {
        if (readFileSync(join(root, asset.name, path), 'utf8') !== content) return false
      }
    }
    return true
  } catch {
    return false
  }
}

function replaceManagedTree(root: string, buildTree: (stage: string) => void): void {
  const parent = dirname(root)
  mkdirSync(parent, { recursive: true })
  const stage = join(parent, `.system-stage-${randomUUID()}`)
  const backup = join(parent, `.system-backup-${randomUUID()}`)
  let movedOld = false
  try {
    mkdirSync(stage, { recursive: true })
    buildTree(stage)
    if (existsSync(root)) {
      renameSync(root, backup)
      movedOld = true
    }
    try {
      renameSync(stage, root)
    } catch (error) {
      if (movedOld) renameSync(backup, root)
      movedOld = false
      throw error
    }
    if (movedOld) rmSync(backup, { recursive: true, force: true })
  } finally {
    rmSync(stage, { recursive: true, force: true })
    if (movedOld && existsSync(backup) && !existsSync(root)) renameSync(backup, root)
    else rmSync(backup, { recursive: true, force: true })
  }
}

function materialize(root: string, assets: readonly EmbeddedSystemPackage[], version: string): void {
  const fingerprint = fingerprintAssets(assets)
  if (validManifest(root, fingerprint, assets)) return
  replaceManagedTree(root, (stage) => {
    for (const asset of assets) {
      for (const [relativePath, content] of Object.entries(asset.files)) {
        const destination = join(stage, asset.name, relativePath)
        mkdirSync(dirname(destination), { recursive: true })
        writeFileSync(destination, content, { encoding: 'utf8', mode: 0o600 })
      }
    }
    const manifest: SystemManifest = {
      schemaVersion: 1,
      managedBy: 'microcode',
      microcodeVersion: version,
      fingerprint,
      generatedAt: new Date().toISOString(),
    }
    writeFileSync(join(stage, '.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  })
}

/** Materialize embedded system capabilities before any default discovery. */
export function installSystemCapabilities(): string[] {
  const diagnostics: string[] = []
  try {
    materialize(getSystemSkillsRoot(), SYSTEM_SKILLS, getVersion())
  } catch (error) {
    diagnostics.push(`${getSystemSkillsRoot()}: system Skills could not be installed (${error instanceof Error ? error.message : String(error)})`)
  }
  try {
    materialize(getSystemMcpRoot(), SYSTEM_MCP_PACKAGES, getVersion())
  } catch (error) {
    diagnostics.push(`${getSystemMcpRoot()}: system MCP directory could not be installed (${error instanceof Error ? error.message : String(error)})`)
  }
  return diagnostics
}

export function getSystemSkillNames(): readonly string[] {
  return SYSTEM_SKILLS.map((skill) => skill.name)
}
