import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { getSystemSkillNames, getSystemSkillsRoot, installSystemCapabilities } from './system/capabilities.ts'
import type { CapabilityScope } from './mcp/types.ts'
export type { CapabilityScope } from './mcp/types.ts'

const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024

const IGNORE_FILE_NAMES = ['.gitignore', '.ignore', '.fdignore']

function toPosixPath(p: string): string {
  return p.split(sep).join('/')
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('#') && !trimmed.startsWith('\\#')) return null

  let pattern = line
  let negated = false

  if (pattern.startsWith('!')) {
    negated = true
    pattern = pattern.slice(1)
  } else if (pattern.startsWith('\\!')) {
    pattern = pattern.slice(1)
  }

  if (pattern.startsWith('/')) {
    pattern = pattern.slice(1)
  }

  const prefixed = prefix ? `${prefix}${pattern}` : pattern
  return negated ? `!${prefixed}` : prefixed
}

interface IgnoreMatcher {
  ignores(path: string): boolean
  add(patterns: string | string[]): void
}

class SimpleIgnore implements IgnoreMatcher {
  private patterns: string[] = []

  ignores(path: string): boolean {
    const normalized = toPosixPath(path)
    for (const pattern of this.patterns) {
      if (this.matchPattern(normalized, pattern)) {
        return true
      }
    }
    return false
  }

  private matchPattern(path: string, pattern: string): boolean {
    const isNegated = pattern.startsWith('!')
    const actualPattern = isNegated ? pattern.slice(1) : pattern
    
    if (actualPattern === '') return false
    
    // Simple glob matching
    const regexPattern = actualPattern
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
      .replace(/\./g, '\\.')
    
    const regex = new RegExp(regexPattern)
    const matches = regex.test(path)
    
    return isNegated ? !matches : matches
  }

  add(patterns: string | string[]): void {
    if (typeof patterns === 'string') {
      this.patterns.push(patterns)
    } else {
      this.patterns.push(...patterns)
    }
  }
}

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
  const relativeDir = relative(rootDir, dir)
  const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : ''

  for (const filename of IGNORE_FILE_NAMES) {
    const ignorePath = join(dir, filename)
    if (!existsSync(ignorePath)) continue
    try {
      const content = readFileSync(ignorePath, 'utf-8')
      const patterns = content
        .split(/\r?\n/)
        .map((line) => prefixIgnorePattern(line, prefix))
        .filter((line): line is string => Boolean(line))
      if (patterns.length > 0) {
        ig.add(patterns)
      }
    } catch {}
  }
}

export interface SkillFrontmatter {
  name?: string
  description?: string
  'disable-model-invocation'?: boolean
  [key: string]: unknown
}

export type SkillScope = CapabilityScope

export interface Skill {
  name: string
  description: string
  filePath: string
  baseDir: string
  scope: SkillScope
  disableModelInvocation: boolean
  pluginId?: string
}

export interface LoadSkillsResult {
  skills: Skill[]
  diagnostics: string[]
}

function validateName(name: string): string[] {
  const errors: string[] = []

  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`)
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push('name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)')
  }

  if (name.startsWith('-') || name.endsWith('-')) {
    errors.push('name must not start or end with a hyphen')
  }

  if (name.includes('--')) {
    errors.push('name must not contain consecutive hyphens')
  }

  return errors
}

function validateDescription(description: string | undefined): string[] {
  const errors: string[] = []

  if (!description || description.trim() === '') {
    errors.push('description is required')
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`)
  }

  return errors
}

export interface LoadSkillsFromDirOptions {
  dir: string
  source: SkillScope
}

function loadSkillsFromDirInternal(
  dir: string,
  source: SkillScope,
  includeRootFiles: boolean,
  ignoreMatcher?: IgnoreMatcher,
  rootDir?: string,
): LoadSkillsResult {
  const skills: Skill[] = []
  const diagnostics: string[] = []

  if (!existsSync(dir)) {
    return { skills, diagnostics }
  }

  const root = rootDir ?? dir
  const ig = ignoreMatcher ?? new SimpleIgnore()
  addIgnoreRules(ig, dir, root)

  try {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

    // Check for SKILL.md first (skill root)
    for (const entry of entries) {
      if (entry.name !== 'SKILL.md') {
        continue
      }

      const fullPath = join(dir, entry.name)

      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        try {
          isFile = statSync(fullPath).isFile()
        } catch {
          continue
        }
      }

      const relPath = toPosixPath(relative(root, fullPath))
      if (!isFile || ig.ignores(relPath)) {
        continue
      }

      const result = loadSkillFromFile(fullPath, source)
      if (result.skill) {
        skills.push(result.skill)
      }
      diagnostics.push(...result.diagnostics)
      return { skills, diagnostics }
    }

    // Scan for other skills
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue
      }

      if (entry.name === 'node_modules') {
        continue
      }

      const fullPath = join(dir, entry.name)

      let isDirectory = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(fullPath)
          isDirectory = stats.isDirectory()
          isFile = stats.isFile()
        } catch {
          continue
        }
      }

      const relPath = toPosixPath(relative(root, fullPath))
      const ignorePath = isDirectory ? `${relPath}/` : relPath
      if (ig.ignores(ignorePath)) {
        continue
      }

      if (isDirectory) {
        const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root)
        skills.push(...subResult.skills)
        diagnostics.push(...subResult.diagnostics)
        continue
      }

      if (!isFile || !includeRootFiles || !entry.name.endsWith('.md')) {
        continue
      }

      const result = loadSkillFromFile(fullPath, source)
      if (result.skill) {
        skills.push(result.skill)
      }
      diagnostics.push(...result.diagnostics)
    }
  } catch {}

  return { skills, diagnostics }
}

function parseFrontmatter<T>(content: string): { frontmatter: T; content: string } {
  const frontmatter: any = {}
  let body = content

  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (match) {
    const yamlSection = match[1]
    body = match[2]

    const lines = yamlSection.split('\n')
    for (const line of lines) {
      const colonIndex = line.indexOf(':')
      if (colonIndex > 0) {
        const key = line.slice(0, colonIndex).trim()
        let value = line.slice(colonIndex + 1).trim()
        
        // Handle boolean values
        if (value === 'true') frontmatter[key] = true as any
        else if (value === 'false') frontmatter[key] = false as any
        // Handle quoted strings
        else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          frontmatter[key] = value.slice(1, -1)
        }
        else {
          frontmatter[key] = value
        }
      }
    }
  }

  return { frontmatter: frontmatter as T, content: body }
}

function loadSkillFromFile(
  filePath: string,
  source: SkillScope,
): { skill: Skill | null; diagnostics: string[] } {
  const diagnostics: string[] = []

  try {
    const rawContent = readFileSync(filePath, 'utf-8')
    const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent)
    const skillDir = dirname(filePath)
    const parentDirName = basename(skillDir)

    const descErrors = validateDescription(frontmatter.description)
    for (const error of descErrors) {
      diagnostics.push(`${filePath}: ${error}`)
    }

    const name = frontmatter.name || parentDirName

    const nameErrors = validateName(name)
    for (const error of nameErrors) {
      diagnostics.push(`${filePath}: ${error}`)
    }

    if (!frontmatter.description || frontmatter.description.trim() === '') {
      return { skill: null, diagnostics }
    }

    return {
      skill: {
        name,
        description: frontmatter.description,
        filePath,
        baseDir: skillDir,
        scope: source,
        disableModelInvocation: frontmatter['disable-model-invocation'] === true,
      },
      diagnostics,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failed to parse skill file'
    diagnostics.push(`${filePath}: ${message}`)
    return { skill: null, diagnostics }
  }
}

export function readSkillBody(skill: Skill): string {
  const rawContent = readFileSync(skill.filePath, 'utf-8')
  const { content } = parseFrontmatter<SkillFrontmatter>(rawContent)
  return content
}

export function formatSkillsForPrompt(skills: Skill[]): string {
  const visibleSkills = skills.filter((s) => !s.disableModelInvocation)

  if (visibleSkills.length === 0) {
    return ''
  }

  const lines = [
    '\n\nThe following skills provide specialized instructions for specific tasks.',
    'Users can reference a skill as $skill-name (or a plugin skill as $plugin:skill-name) to include its instructions in that request. Only enabled plugins can be referenced as #plugin-name to include their package description and invocable skill guidance. Use /plugins to list and enable disabled plugins. A plugin mention does not change plugin enablement or grant tool permissions. The skill tool can also load a skill when needed.',
    '',
    '<available_skills>',
  ]

  for (const skill of visibleSkills) {
    lines.push('  <skill>')
    lines.push(`    <name>${escapeXml(skill.name)}</name>`)
    lines.push(`    <description>${escapeXml(skill.description)}</description>`)
    lines.push('  </skill>')
  }

  lines.push('</available_skills>')

  return lines.join('\n')
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export interface LoadSkillsOptions {
  cwd: string
  skillPaths: string[]
  includeDefaults: boolean
}

const CONFIG_DIR_NAME = '.microcode'

function getAgentDir(): string {
  return join(homedir(), '.microcode')
}

function normalizePath(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2))
  if (trimmed.startsWith('~')) return join(homedir(), trimmed.slice(1))
  return trimmed
}

function resolveSkillPath(p: string, cwd: string): string {
  const normalized = normalizePath(p)
  return isAbsolute(normalized) ? normalized : resolve(cwd, normalized)
}

export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
  const { cwd, skillPaths, includeDefaults } = options

  const resolvedAgentDir = getAgentDir()

  const candidates: Skill[] = []
  const allDiagnostics: string[] = []

  function addSkills(result: LoadSkillsResult) {
    allDiagnostics.push(...result.diagnostics)
    candidates.push(...result.skills)
  }

  if (includeDefaults) {
    allDiagnostics.push(...installSystemCapabilities())
    addSkills(loadSkillsFromDirInternal(getSystemSkillsRoot(), 'system', true))
    addSkills(loadSkillsFromDirInternal(join(resolvedAgentDir, 'skills'), 'user', true))
    addSkills(loadSkillsFromDirInternal(resolve(cwd, CONFIG_DIR_NAME, 'skills'), 'project', true))
  }

  const userSkillsDir = join(resolvedAgentDir, 'skills')
  const projectSkillsDir = resolve(cwd, CONFIG_DIR_NAME, 'skills')

  const isUnderPath = (target: string, root: string): boolean => {
    const normalizedRoot = resolve(root)
    if (target === normalizedRoot) {
      return true
    }
    const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`
    return target.startsWith(prefix)
  }

  const getSource = (resolvedPath: string): SkillScope => {
    if (isUnderPath(resolvedPath, getSystemSkillsRoot())) return 'system'
    if (!includeDefaults) {
      if (isUnderPath(resolvedPath, userSkillsDir)) return 'user'
      if (isUnderPath(resolvedPath, projectSkillsDir)) return 'project'
    } else {
      if (isUnderPath(resolvedPath, projectSkillsDir)) return 'project'
      if (isUnderPath(resolvedPath, userSkillsDir)) return 'user'
    }
    return 'path'
  }

  for (const rawPath of skillPaths) {
    const resolvedPath = resolveSkillPath(rawPath, cwd)
    if (!existsSync(resolvedPath)) {
      allDiagnostics.push(`${resolvedPath}: skill path does not exist`)
      continue
    }

    try {
      const stats = statSync(resolvedPath)
      const source = getSource(resolvedPath)
      if (stats.isDirectory()) {
        addSkills(loadSkillsFromDirInternal(resolvedPath, source, true))
      } else if (stats.isFile() && resolvedPath.endsWith('.md')) {
        const result = loadSkillFromFile(resolvedPath, source)
        if (result.skill) {
          addSkills({ skills: [result.skill], diagnostics: result.diagnostics })
        } else {
          allDiagnostics.push(...result.diagnostics)
        }
      } else {
        allDiagnostics.push(`${resolvedPath}: skill path is not a markdown file`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed to read skill path'
      allDiagnostics.push(`${resolvedPath}: ${message}`)
    }
  }

  const systemNames = new Set(includeDefaults ? getSystemSkillNames() : candidates.filter((skill) => skill.scope === 'system').map((skill) => skill.name))
  const priority: Record<SkillScope, number> = {
    system: 100,
    path: 30,
    project: 20,
    user: 10,
    plugin: 0,
    legacy: 0,
  }
  candidates.sort((a, b) => priority[b.scope] - priority[a.scope])
  const skillMap = new Map<string, Skill>()
  const realPathSet = new Set<string>()
  for (const skill of candidates) {
    const realPath = resolve(skill.filePath)
    if (realPathSet.has(realPath)) continue
    const existing = skillMap.get(skill.name)
    if (existing) {
      if (systemNames.has(skill.name) && existing.scope === 'system') {
        allDiagnostics.push(`Skill "${skill.name}" conflicts with reserved system skill; ${skill.scope} skill ignored.`)
      } else {
        allDiagnostics.push(`Skill "${skill.name}" collision between ${existing.filePath} (${existing.scope}) and ${skill.filePath} (${skill.scope}); ${existing.scope} skill selected.`)
      }
      continue
    }
    if (systemNames.has(skill.name) && skill.scope !== 'system') {
      allDiagnostics.push(`Skill "${skill.name}" conflicts with reserved system skill; ${skill.scope} skill ignored.`)
      continue
    }
    skillMap.set(skill.name, skill)
    realPathSet.add(realPath)
  }

  return {
    skills: Array.from(skillMap.values()),
    diagnostics: allDiagnostics,
  }
}
