import { readdirSync, existsSync } from 'fs'
import { stat, readFile } from 'fs/promises'
import { isAbsolute, resolve } from 'path'

// ============================================================================
// Constants
// ============================================================================

const VCS_REGEX = /(?:^|\/)\.(?:git|svn|hg|bzr|jj|sl)(?:\/|$)/
const MAX_FILE_SIZE = 1_000_000 // skip files >1MB for grep
const MAX_LINE_LENGTH = 500
const MAX_RESULT_SIZE_CHARS = 20_000
const MAX_GLOB_RESULT_CHARS = 100_000
const GLOB_REGEX_CACHE_SIZE = 64

const TYPE_MAP: Record<string, string[]> = {
  js: ['*.js', '*.jsx', '*.mjs', '*.cjs'],
  ts: ['*.ts', '*.tsx', '*.mts', '*.cts'],
  py: ['*.py', '*.pyi', '*.pyx', '*.pyw'],
  rust: ['*.rs'],
  go: ['*.go'],
  java: ['*.java', '*.kt', '*.kts', '*.scala'],
  rb: ['*.rb', '*.rake', '*.gemspec'],
  php: ['*.php', '*.phtml', '*.phtml'],
  swift: ['*.swift'],
  c: ['*.c', '*.h'],
  cpp: ['*.cpp', '*.cxx', '*.cc', '*.c++', '*.hpp', '*.hxx', '*.hh', '*.h++'],
  cs: ['*.cs'],
  sh: ['*.sh', '*.bash', '*.zsh', '*.fish'],
  md: ['*.md', '*.mdx'],
  json: ['*.json', '*.jsonc', '*.json5'],
  yaml: ['*.yaml', '*.yml'],
  xml: ['*.xml', '*.svg', '*.xsd', '*.xsl'],
  html: ['*.html', '*.htm', '*.xhtml'],
  css: ['*.css', '*.scss', '*.less', '*.sass'],
  sql: ['*.sql'],
  proto: ['*.proto'],
  tf: ['*.tf', '*.tfvars', '*.hcl'],
  vue: ['*.vue'],
  svelte: ['*.svelte'],
  lua: ['*.lua'],
  dart: ['*.dart'],
  elixir: ['*.ex', '*.exs', '*.heex'],
  erlang: ['*.erl', '*.hrl'],
  haskell: ['*.hs', '*.lhs'],
  ocaml: ['*.ml', '*.mli'],
  fsharp: ['*.fs', '*.fsx', '*.fsi'],
  clojure: ['*.clj', '*.cljs', '*.cljc', '*.edn'],
  nix: ['*.nix'],
  zig: ['*.zig', '*.zon'],
  nim: ['*.nim', '*.nims'],
  groovy: ['*.groovy', '*.gradle', '*.gvy', '*.gy'],
  toml: ['*.toml'],
  docker: ['Dockerfile', '.dockerignore', 'docker-compose.yml', 'docker-compose.yaml', '*.dockerfile'],
  make: ['Makefile', '*.mk', 'GNUmakefile'],
  cmake: ['CMakeLists.txt', '*.cmake'],
  graphql: ['*.graphql', '*.gql'],
  prisma: ['*.prisma'],
  julia: ['*.jl'],
  astro: ['*.astro'],
  twig: ['*.twig'],
  jinja: ['*.jinja', '*.jinja2', '*.j2'],
  handlebars: ['*.hbs', '*.handlebars'],
  ejs: ['*.ejs'],
  erb: ['*.erb'],
  vim: ['*.vim', '.vimrc'],
  r: ['*.r', '*.R', '*.Rmd', '*.Rproj'],
  rst: ['*.rst', '*.rest'],
  tex: ['*.tex', '*.sty', '*.cls', '*.bib'],
  ps1: ['*.ps1', '*.psm1', '*.psd1'],
  bat: ['*.bat', '*.cmd'],
  patch: ['*.patch', '*.diff'],
}

// Binary-ish extensions to skip during grep
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.bmp', '.heic', '.heif', '.avif',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.zst', '.lz4', '.br',
  '.exe', '.dll', '.so', '.dylib', '.wasm',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.ogg', '.flac', '.aac', '.webm', '.flv',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.o', '.a', '.obj', '.lib', '.class', '.pyc', '.pyo', '.pyd',
  '.db', '.sqlite', '.sqlite3', '.sqlite',
  '.bin', '.dat', '.pak', '.unity3d', '.asset',
  '.map', '.tsbuildinfo',
  '.iso', '.dmg', '.deb', '.rpm',
  '.jar', '.war', '.ear',
  '.nupkg', '.vsix', '.gem', '.whl', '.egg',
  '.iml', '.DS_Store',
  '.lockb',
])

// ============================================================================
// Glob-to-Regex conversion
// ============================================================================

const globRegexCache = new Map<string, RegExp>()

/**
 * Convert a glob pattern to a RegExp for matching relative file paths.
 * Results are cached — the same pattern string reuses its RegExp.
 * Supports: **, *, ?, [abc], [!abc], {a,b,c}, \ escaping.
 */
function getGlobRegex(pattern: string): RegExp {
  const cached = globRegexCache.get(pattern)
  if (cached) return cached

  const regex = compileGlobRegex(pattern)

  // LRU-style eviction: delete oldest entry when cache is full
  if (globRegexCache.size >= GLOB_REGEX_CACHE_SIZE) {
    const firstKey = globRegexCache.keys().next().value
    if (firstKey !== undefined) globRegexCache.delete(firstKey)
  }
  globRegexCache.set(pattern, regex)
  return regex
}

function compileGlobRegex(pattern: string): RegExp {
  let regex = ''
  let i = 0
  const len = pattern.length

  while (i < len) {
    const ch = pattern[i]!

    // ** — match across path segments
    if (ch === '*' && pattern[i + 1] === '*') {
      const nextIsSlash = i + 2 < len && pattern[i + 2] === '/'
      const atEnd = i + 2 >= len

      if (atEnd && i === 0) {
        regex += '.*'
        i += 2
      } else if (nextIsSlash) {
        regex += '(?:.+/)?'
        i += 3
      } else {
        regex += '.*'
        i += 2
      }
      continue
    }

    if (ch === '*') {
      regex += '[^/]*'
      i++
      continue
    }

    if (ch === '?') {
      regex += '[^/]'
      i++
      continue
    }

    if (ch === '[') {
      const close = pattern.indexOf(']', i)
      if (close === -1) { regex += '\\['; i++; continue }
      let inner = pattern.slice(i + 1, close)
      if (inner.startsWith('!')) inner = '^' + inner.slice(1)
      regex += '[' + inner + ']'
      i = close + 1
      continue
    }

    if (ch === '{') {
      const end = findMatchingBrace(pattern, i)
      if (end === -1) { regex += '\\{'; i++; continue }
      regex += '(?:' + splitBraceAlternatives(pattern.slice(i + 1, end))
        .map((a) => compileGlobSegment(a)).join('|') + ')'
      i = end + 1
      continue
    }

    if (ch === '\\' && i + 1 < len) {
      regex += escapeRegexChar(pattern[i + 1]!)
      i += 2
      continue
    }

    if ('.+^${}()|'.includes(ch)) {
      regex += '\\' + ch
    } else {
      regex += ch
    }
    i++
  }

  return new RegExp('^' + regex + '$')
}

function compileGlobSegment(seg: string): string {
  let r = ''
  let i = 0
  while (i < seg.length) {
    const ch = seg[i]!
    if (ch === '*') {
      if (seg[i + 1] === '*') { r += '.*'; i += 2 }
      else { r += '[^/]*'; i++ }
    } else if (ch === '?') {
      r += '[^/]'; i++
    } else if (ch === '[') {
      const close = seg.indexOf(']', i)
      if (close === -1) { r += '\\['; i++; continue }
      let inner = seg.slice(i + 1, close)
      if (inner.startsWith('!')) inner = '^' + inner.slice(1)
      r += '[' + inner + ']'
      i = close + 1
    } else if (ch === '{') {
      const end = findMatchingBrace(seg, i)
      if (end === -1) { r += '\\{'; i++; continue }
      r += '(?:' + splitBraceAlternatives(seg.slice(i + 1, end))
        .map((a) => compileGlobSegment(a)).join('|') + ')'
      i = end + 1
    } else if (ch === '\\' && i + 1 < seg.length) {
      r += escapeRegexChar(seg[i + 1]!); i += 2
    } else {
      if ('.+^${}()|'.includes(ch)) r += '\\' + ch
      else r += ch
      i++
    }
  }
  return r
}

function findMatchingBrace(s: string, start: number): number {
  let depth = 0
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}') { depth--; if (depth === 0) return i }
    else if (s[i] === '\\' && i + 1 < s.length) i++
  }
  return -1
}

function splitBraceAlternatives(inner: string): string[] {
  const parts: string[] = []
  let depth = 0, start = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === ',' && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1 }
    else if (ch === '\\' && i + 1 < inner.length) i++
  }
  parts.push(inner.slice(start))
  return parts
}

function escapeRegexChar(ch: string): string {
  return '.+^${}()|[]*?\\'.includes(ch) ? '\\' + ch : ch
}

// ============================================================================
// Fast path: extension-only glob matching
// ============================================================================

/** A glob pattern is "simple" if it's just `*.ext` or `*.*.ext` — no special chars. */
function isSimpleGlob(pattern: string): boolean {
  // Must start with * and not contain: **, ?, [, ], {, }
  if (!pattern.startsWith('*')) return false
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '?' || ch === '[' || ch === ']' || ch === '{' || ch === '}') return false
  }
  // "**" is not simple
  if (pattern.includes('**')) return false
  return true
}

/**
 * If every glob is a simple `*.ext` pattern, return the set of matching extensions.
 * Otherwise return null (caller must use full regex matching).
 */
function tryGetSimpleExtensions(patterns: string[]): string[] | null {
  const exts: string[] = []
  for (const p of patterns) {
    if (!isSimpleGlob(p)) return null
    // Strip leading '*' to get the extension suffix
    exts.push(p.slice(1))
  }
  return exts
}

// ============================================================================
// Path utilities
// ============================================================================

function shouldSkipForGrep(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  const lastDot = lower.lastIndexOf('.')
  if (lastDot !== -1) {
    if (SKIP_EXTENSIONS.has(lower.slice(lastDot))) return true
    // Skip .min.* bundles (but allow .min.ts/.min.js for grepping)
    if (lower.includes('.min.') && !lower.endsWith('.min.ts') && !lower.endsWith('.min.js')) return true
  }
  return false
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

// ============================================================================
// File system helpers
// ============================================================================

function resolveSearchDir(cwd: string, inputPath?: string): string {
  if (!inputPath) return cwd
  return isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath)
}

async function getMtimes(rootDir: string, relPaths: string[]): Promise<Map<string, number>> {
  const results = await Promise.allSettled(
    relPaths.map(async (p) => {
      const s = await stat(resolve(rootDir, p))
      return { path: p, mtime: s.mtimeMs } as const
    }),
  )
  const map = new Map<string, number>()
  for (const r of results) {
    if (r.status === 'fulfilled') map.set(r.value.path, r.value.mtime)
  }
  return map
}

function listFiles(rootDir: string, extraGlobs?: string[]): string[] {
  let files: string[]
  try {
    files = (readdirSync(rootDir, { recursive: true }) as string[]).map(normalizeRelativePath)
  } catch {
    return []
  }

  // Filter VCS dirs — single regex test, zero allocations
  files = files.filter((f) => !VCS_REGEX.test(f))

  // Apply extra glob filters if specified
  if (extraGlobs && extraGlobs.length > 0) {
    // Fast path: if all globs are simple *.ext, use endsWith
    const simpleExts = tryGetSimpleExtensions(extraGlobs)
    if (simpleExts) {
      files = files.filter((f) => simpleExts.some((ext) => f.endsWith(ext)))
    } else {
      const regexes = extraGlobs.map((g) => getGlobRegex(g))
      files = files.filter((f) => regexes.some((r) => r.test(f)))
    }
  }

  return files
}

// ============================================================================
// Glob search
// ============================================================================

export interface GlobSearchOptions {
  maxResults?: number
  signal?: AbortSignal
}

export interface GlobSearchResult {
  files: string[]
  truncated: boolean
  durationMs: number
}

export async function globSearch(
  cwd: string,
  inputPath: string | undefined,
  pattern: string,
  options: GlobSearchOptions = {},
): Promise<GlobSearchResult> {
  const t0 = Date.now()
  const searchDir = resolveSearchDir(cwd, inputPath)
  const maxResults = options.maxResults ?? 1000

  if (!existsSync(searchDir)) {
    throw new Error(`Path not found: ${searchDir}`)
  }

  let allFiles: string[]
  try {
    allFiles = (readdirSync(searchDir, { recursive: true }) as string[]).map(normalizeRelativePath)
  } catch {
    return { files: [], truncated: false, durationMs: Date.now() - t0 }
  }

  if (options.signal?.aborted) throw new Error('Operation aborted')

  // Filter VCS dirs
  allFiles = allFiles.filter((f) => !VCS_REGEX.test(f))

  // Filter by glob pattern
  const regex = getGlobRegex(pattern)
  const matched = allFiles.filter((f) => regex.test(f))

  if (matched.length === 0) {
    return { files: [], truncated: false, durationMs: Date.now() - t0 }
  }

  if (options.signal?.aborted) throw new Error('Operation aborted')

  // Sort by modification time (newest first)
  const mtimes = await getMtimes(searchDir, matched)
  matched.sort((a, b) => {
    const ma = mtimes.get(a) ?? 0
    const mb = mtimes.get(b) ?? 0
    if (mb !== ma) return mb - ma
    return a.localeCompare(b)
  })

  const truncated = matched.length > maxResults
  const result = truncated ? matched.slice(0, maxResults) : matched

  return { files: result, truncated, durationMs: Date.now() - t0 }
}

// ============================================================================
// Grep search
// ============================================================================

export interface GrepSearchOptions {
  outputMode?: 'content' | 'files_with_matches' | 'count'
  glob?: string
  type?: string
  caseInsensitive?: boolean
  multiline?: boolean
  contextBefore?: number
  contextAfter?: number
  contextAround?: number
  showLineNumbers?: boolean
  headLimit?: number
  offset?: number
  signal?: AbortSignal
}

export interface GrepSearchResult {
  output: string
  numFiles: number
  filenames: string[]
  numMatches: number
  numLines?: number
  appliedLimit?: number
  appliedOffset?: number
  truncated: boolean
}

const DEFAULT_HEAD_LIMIT = 250

export async function grepSearch(
  cwd: string,
  inputPath: string | undefined,
  pattern: string,
  options: GrepSearchOptions = {},
): Promise<GrepSearchResult> {
  const searchDir = resolveSearchDir(cwd, inputPath)
  const outputMode = options.outputMode ?? 'content'
  const headLimit = options.headLimit ?? DEFAULT_HEAD_LIMIT
  const offset = options.offset ?? 0

  if (!existsSync(searchDir)) {
    throw new Error(`Path not found: ${searchDir}`)
  }

  // Build file filter globs
  const extraGlobs: string[] = []
  if (options.glob) {
    for (const g of options.glob.split(/[\s,]+/)) {
      if (g) extraGlobs.push(g)
    }
  }
  if (options.type) {
    const typeGlobs = TYPE_MAP[options.type]
    if (typeGlobs) extraGlobs.push(...typeGlobs)
  }

  // Get candidate files
  const candidateFiles = listFiles(searchDir, extraGlobs.length > 0 ? extraGlobs : undefined)
    .filter((f) => !shouldSkipForGrep(f))

  if (candidateFiles.length === 0) {
    return {
      output: 'No files to search',
      numFiles: 0,
      filenames: [],
      numMatches: 0,
      truncated: false,
    }
  }

  // Build regex
  let regex: RegExp
  try {
    let flags = 'g'
    if (options.caseInsensitive) flags += 'i'
    if (options.multiline) flags += 's'
    regex = new RegExp(pattern, flags)
  } catch (err) {
    throw new Error(`Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`)
  }

  const ctxBefore = options.contextAround ?? options.contextBefore ?? 0
  const ctxAfter = options.contextAround ?? options.contextAfter ?? 0
  const showLineNums = options.showLineNumbers !== false

  type MatchEntry = {
    filePath: string
    lineNumber: number
    lineText: string
    matchCount: number
  }
  const allMatches: MatchEntry[] = []

  // Process files in parallel batches for I/O efficiency
  const BATCH_SIZE = 16

  for (let bi = 0; bi < candidateFiles.length; bi += BATCH_SIZE) {
    if (options.signal?.aborted) throw new Error('Operation aborted')

    const batch = candidateFiles.slice(bi, bi + BATCH_SIZE)
    const batchResults = await Promise.allSettled(
      batch.map(async (relPath) => {
        const absPath = resolve(searchDir, relPath)

        // Read file (skip explicit stat — readFile throws on failure, and we check content.length)
        let content: string
        try {
          content = await readFile(absPath, 'utf-8')
        } catch {
          return { relPath, matches: [] as MatchEntry[] }
        }

        // Skip files that are too large (likely minified/binary)
        if (content.length > MAX_FILE_SIZE) {
          return { relPath, matches: [] as MatchEntry[] }
        }

        if (options.signal?.aborted) throw new Error('Operation aborted')

        const fileMatches: MatchEntry[] = []

        if (outputMode === 'files_with_matches') {
          // Fast path: test regex on full content without splitting into lines
          if (regex.test(content)) {
            fileMatches.push({ filePath: relPath, lineNumber: 0, lineText: '', matchCount: 1 })
          }
        } else if (outputMode === 'count') {
          // Use matchAll for fast streaming count
          const matchIter = content.matchAll(regex)
          let count = 0
          for (const _ of matchIter) count++
          if (count > 0) {
            fileMatches.push({ filePath: relPath, lineNumber: 0, lineText: String(count), matchCount: count })
          }
        } else {
          // Content mode: need line-level detail for context and line numbers
          const lines = content.split('\n')
          const alreadyIncluded = new Set<number>()

          for (let li = 0; li < lines.length; li++) {
            const line = lines[li]!
            if (line.length > MAX_LINE_LENGTH * 2) continue

            regex.lastIndex = 0
            if (!regex.test(line)) continue

            regex.lastIndex = 0

            // Add context lines before
            const cStart = Math.max(0, li - ctxBefore)
            for (let ci = cStart; ci < li; ci++) {
              if (!alreadyIncluded.has(ci)) {
                alreadyIncluded.add(ci)
                fileMatches.push({
                  filePath: relPath,
                  lineNumber: ci + 1,
                  lineText: lines[ci]!.slice(0, MAX_LINE_LENGTH),
                  matchCount: 1,
                })
              }
            }

            // Matching line
            if (!alreadyIncluded.has(li)) {
              alreadyIncluded.add(li)
              fileMatches.push({
                filePath: relPath,
                lineNumber: li + 1,
                lineText: line.slice(0, MAX_LINE_LENGTH),
                matchCount: 1,
              })
            }

            // Add context lines after
            const cEnd = Math.min(lines.length, li + 1 + ctxAfter)
            for (let ci = li + 1; ci < cEnd; ci++) {
              if (!alreadyIncluded.has(ci)) {
                alreadyIncluded.add(ci)
                fileMatches.push({
                  filePath: relPath,
                  lineNumber: ci + 1,
                  lineText: lines[ci]!.slice(0, MAX_LINE_LENGTH),
                  matchCount: 1,
                })
              }
            }
          }
        }

        return { relPath, matches: fileMatches }
      }),
    )

    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value.matches.length > 0) {
        allMatches.push(...r.value.matches)
      }
    }
  }

  return formatGrepOutput(outputMode, allMatches, headLimit, offset, showLineNums)
}

function formatGrepOutput(
  outputMode: 'content' | 'files_with_matches' | 'count',
  allMatches: Array<{ filePath: string; lineNumber: number; lineText: string; matchCount: number }>,
  headLimit: number,
  offset: number,
  showLineNums: boolean,
): GrepSearchResult {
  if (allMatches.length === 0) {
    return {
      output: 'No matches found',
      numFiles: 0,
      filenames: [],
      numMatches: 0,
      truncated: false,
    }
  }

  let outputLines: string[] = []
  let numFiles = 0
  let numMatchesValue = 0
  let filenames: string[] = []
  let linesTruncated = false
  let truncated = false
  const notices: string[] = []

  if (outputMode === 'content') {
    const effective = offset > 0 ? allMatches.slice(offset) : allMatches
    const limited = headLimit > 0 && effective.length > headLimit
      ? effective.slice(0, headLimit)
      : effective

    const fileSet = new Set<string>()
    for (const m of limited) {
      fileSet.add(m.filePath)
      const lineText = m.lineText.replace(/\r$/, '')
      const displayText = lineText.length > MAX_LINE_LENGTH
        ? lineText.slice(0, MAX_LINE_LENGTH) + '...'
        : lineText
      if (displayText !== lineText) linesTruncated = true

      if (showLineNums) {
        outputLines.push(`${m.filePath}:${m.lineNumber}: ${displayText}`)
      } else {
        outputLines.push(`${m.filePath}: ${displayText}`)
      }
    }
    numFiles = fileSet.size
    numMatchesValue = limited.length
    filenames = [...fileSet]
    truncated = headLimit > 0 && allMatches.length > offset + headLimit
  } else if (outputMode === 'files_with_matches') {
    const uniqueFiles = [...new Set(allMatches.map((m) => m.filePath))]
    uniqueFiles.sort()

    const offsetFiles = offset > 0 ? uniqueFiles.slice(offset) : uniqueFiles
    const limitedFiles = headLimit > 0 && offsetFiles.length > headLimit
      ? offsetFiles.slice(0, headLimit)
      : offsetFiles

    outputLines = limitedFiles
    numFiles = limitedFiles.length
    numMatchesValue = uniqueFiles.length
    filenames = limitedFiles
    truncated = headLimit > 0 && uniqueFiles.length > offset + headLimit
  } else {
    // Count mode — aggregate per file
    const countMap = new Map<string, number>()
    let total = 0
    for (const m of allMatches) {
      countMap.set(m.filePath, (countMap.get(m.filePath) ?? 0) + m.matchCount)
      total += m.matchCount
    }
    const uniqueFiles = [...countMap.keys()]
    uniqueFiles.sort((a, b) => (countMap.get(b) ?? 0) - (countMap.get(a) ?? 0))

    const offsetFiles = offset > 0 ? uniqueFiles.slice(offset) : uniqueFiles
    const limitedFiles = headLimit > 0 && offsetFiles.length > headLimit
      ? offsetFiles.slice(0, headLimit)
      : offsetFiles

    for (const fp of limitedFiles) {
      outputLines.push(`${fp}:${countMap.get(fp)}`)
    }
    numFiles = limitedFiles.length
    numMatchesValue = total
    filenames = limitedFiles
    truncated = headLimit > 0 && uniqueFiles.length > offset + headLimit
  }

  let output = outputLines.join('\n')

  if (truncated) notices.push(`${headLimit} results limit reached`)
  if (linesTruncated) notices.push(`Some lines truncated to ${MAX_LINE_LENGTH} chars`)

  const maxChars = outputMode === 'files_with_matches' ? MAX_GLOB_RESULT_CHARS : MAX_RESULT_SIZE_CHARS
  if (output.length > maxChars) {
    output = output.slice(0, maxChars)
    notices.push(`${maxChars / 1000}KB output limit reached`)
    truncated = true
  }

  if (notices.length > 0) {
    output += `\n\n[Truncated: ${notices.join('. ')}]`
  }

  const appliedLimit = truncated ? headLimit : undefined
  const appliedOffset = offset > 0 ? offset : undefined

  return {
    output,
    numFiles,
    filenames,
    numMatches: numMatchesValue,
    numLines: outputMode === 'content' ? outputLines.length : undefined,
    appliedLimit,
    appliedOffset,
    truncated: truncated || linesTruncated,
  }
}
