#!/usr/bin/env bun
/**
 * Build script for microcode.
 * Compiles a standalone executable and installs it to a platform-appropriate location.
 *
 * Usage:
 *   bun run build.ts              # Build + install
 *   bun run build.ts --no-install # Build only (skip install)
 */
import * as path from 'path'
import * as os from 'os'
import { chmodSync, existsSync, statSync } from 'fs'
import { spawnSync } from 'child_process'
import { diagnoseWindowsPath, installBinaryAtomically } from './packaging/build-install.ts'
import { compileBinaryAtomically } from './packaging/build-compile.ts'

// ============================================================================
// ANSI helpers
// ============================================================================

const ESC = '\x1b'
const RESET = `${ESC}[0m`
const BOLD = `${ESC}[1m`
const DIM = `${ESC}[2m`
const CLEAR_LINE = `${ESC}[2K\r`

const fg = {
  cyan: (s: string) => `${ESC}[36m${s}${RESET}`,
  green: (s: string) => `${ESC}[32m${s}${RESET}`,
  yellow: (s: string) => `${ESC}[33m${s}${RESET}`,
  gray: (s: string) => `${ESC}[90m${s}${RESET}`,
  white: (s: string) => `${ESC}[37m${s}${RESET}`,
  red: (s: string) => `${ESC}[31m${s}${RESET}`,
}

const bold = (s: string) => `${BOLD}${s}${RESET}`
const dim = (s: string) => `${DIM}${s}${RESET}`

function write(s: string) {
  process.stdout.write(s)
}

// ============================================================================
// Progress bar
// ============================================================================

const BAR_WIDTH = 28
const BAR_FILLED = '━'
const BAR_EMPTY = '─'
const SPINNER_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']

function renderBar(ratio: number): string {
  const filled = Math.round(ratio * BAR_WIDTH)
  const empty = BAR_WIDTH - filled
  return fg.cyan(BAR_FILLED.repeat(filled)) + dim(BAR_EMPTY.repeat(empty))
}

// ============================================================================
// Build config
// ============================================================================

const PROJECT_DIR = import.meta.dir
const IS_WINDOWS = process.platform === 'win32'
const BINARY_NAME = IS_WINDOWS ? 'microcode.exe' : 'microcode'
const COMPILED_BINARY = path.join(PROJECT_DIR, 'dist', BINARY_NAME)

function getInstallDir(): string {
  if (IS_WINDOWS) {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'microcode', 'bin')
  }
  return path.join(os.homedir(), '.local', 'bin')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ============================================================================
// Build steps
// ============================================================================

interface StepResult {
  modules?: number
  bundleMs?: number
  compileMs?: number
}

async function runBuild(): Promise<StepResult> {
  return compileBinaryAtomically(COMPILED_BINARY, compileBinary, (source, destination) =>
    installBinaryAtomically(source, destination, undefined,
      IS_WINDOWS ? undefined : (temporaryPath) => chmodSync(temporaryPath, 0o755)),
  )
}

async function compileBinary(outputPath: string): Promise<StepResult> {
  const result: StepResult = {}
  let spinnerIdx = 0
  let startTime = Date.now()

  const proc = Bun.spawn({
    cmd: ['bun', 'build', './src/entry.ts', '--compile', '--outfile=' + outputPath],
    cwd: PROJECT_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdoutReader = proc.stdout.getReader()
  const stderrReader = proc.stderr.getReader()
  let stdoutBuf = ''
  let stderrBuf = ''

  const consume = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    append: (chunk: string) => void,
  ) => {
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      append(decoder.decode(value, { stream: true }))
    }
    append(decoder.decode())
  }

  const poll = setInterval(() => {
    const elapsed = Date.now() - startTime
    const frame = SPINNER_FRAMES[spinnerIdx++ % SPINNER_FRAMES.length]
    write(`${CLEAR_LINE}  ${fg.cyan(frame)}  ${dim('compiling')} ${renderBar(Math.min(elapsed / 3000, 0.95))} ${dim(formatMs(elapsed))}`)
  }, 80)

  let exitCode: number
  try {
    const results = await Promise.all([
      consume(stdoutReader, (chunk) => { stdoutBuf += chunk }),
      consume(stderrReader, (chunk) => { stderrBuf += chunk }),
      proc.exited,
    ])
    exitCode = results[2]
  } finally {
    clearInterval(poll)
  }

  if (exitCode !== 0) {
    const diagnostic = stderrBuf.trim() || stdoutBuf.trim()
    throw new Error(`Compiler exited with code ${exitCode}${diagnostic ? `:\n${diagnostic}` : '.'}`)
  }

  const bundleMatch = stdoutBuf.match(/\[(\d+)ms\]\s+bundle\s+(\d+)\s+modules/)
  const compileMatch = stdoutBuf.match(/\[(\d+)ms\]\s+compile/)

  if (bundleMatch) {
    result.modules = parseInt(bundleMatch[2])
    result.bundleMs = parseInt(bundleMatch[1])
  }
  if (compileMatch) {
    result.compileMs = parseInt(compileMatch[1])
  }

  return result
}

function stepDone(label: string, detail: string) {
  write(`${CLEAR_LINE}  ${fg.green('✓')}  ${bold(label)}  ${dim(detail)}\n`)
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const skipInstall = process.argv.includes('--no-install')
  const startTime = Date.now()

  // Header
  write('\n')
  write(`  ${bold('microcode')} ${dim('build')}\n`)
  write(`  ${dim('─'.repeat(44))}\n\n`)

  // Step 1: Compile
  write(`  ${fg.cyan('◉')}  ${dim('resolving modules...')}\n`)
  const result = await runBuild()

  const moduleInfo = result.modules ? `${result.modules} modules` : ''
  const timingParts = []
  if (result.bundleMs) timingParts.push(`bundle ${formatMs(result.bundleMs)}`)
  if (result.compileMs) timingParts.push(`compile ${formatMs(result.compileMs)}`)
  const timingInfo = timingParts.join(' · ')

  stepDone('compile', [moduleInfo, timingInfo].filter(Boolean).join('  '))
  write(`  ${dim('artifact')}  ${COMPILED_BINARY}\n`)

  // Step 2: Verify output
  if (!existsSync(COMPILED_BINARY)) {
    write(`  ${fg.red('✗')}  ${bold('build failed')} — output not found\n\n`)
    process.exit(1)
  }
  const binarySize = statSync(COMPILED_BINARY).size
  stepDone('verify', `${formatBytes(binarySize)}`)

  // Step 3: Install
  if (!skipInstall) {
    const installDir = getInstallDir()
    const installPath = path.join(installDir, BINARY_NAME)

    await installBinaryAtomically(
      COMPILED_BINARY,
      installPath,
      undefined,
      IS_WINDOWS ? undefined : (temporaryPath) => chmodSync(temporaryPath, 0o755),
    )
    stepDone('install', `updated ${installPath}`)
  } else {
    stepDone('install', 'skipped (--no-install)')
  }

  // Footer
  const totalMs = Date.now() - startTime
  write(`  ${dim('─'.repeat(44))}\n`)
  write(`  ${fg.green('▲')}  ${bold('done')}  ${dim(formatMs(totalMs))}  `)
  write(dim('·'))
  const helpCommand = IS_WINDOWS
    ? `& "${path.join(getInstallDir(), BINARY_NAME)}" --help`
    : 'microcode --help'
  write(`  ${dim('run')} ${fg.cyan(helpCommand)}\n\n`)

  // Windows PATH diagnostics
  if (!skipInstall && IS_WINDOWS) {
    const installDir = getInstallDir()
    const installPath = path.join(installDir, BINARY_NAME)
    const lookup = spawnSync('where.exe', ['microcode'], { encoding: 'utf8', windowsHide: true })
    const candidates = lookup.stdout?.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean) ?? []
    const diagnosis = diagnoseWindowsPath(installPath, candidates)

    write(`  ${dim('PATH lookup (where.exe microcode):')}\n`)
    if (candidates.length === 0) {
      write(`  ${fg.yellow('!')}  ${dim('No executable named microcode was found through PATH.') }\n`)
    } else {
      candidates.forEach((candidate, index) => {
        const marker = index === diagnosis.canonicalIndex
          ? fg.green('canonical')
          : dim(`hit ${index + 1}`)
        write(`    ${marker}  ${candidate}\n`)
      })
    }

    if (diagnosis.shadowingCandidates.length > 0) {
      write(`  ${fg.yellow('!')}  ${bold('PATH conflict')}: an earlier executable can shadow the canonical installation.\n`)
      write(`  ${dim('  Inspect this PowerShell session:')}\n`)
      write(`  ${fg.cyan('  Get-Command -All microcode | Format-List CommandType,Name,Source,Definition')}\n`)
      write(`  ${dim('  Run the canonical executable directly:')}\n`)
      write(`  ${fg.cyan(`  & "${installPath}" --help`)}\n`)
      write(`  ${dim(`  Move ${installDir} before the stale directory in PATH, or remove the stale entry yourself.`)}\n`)
    } else if (!diagnosis.canonicalIsOnPath) {
      write(`  ${fg.yellow('!')}  ${dim(`${installDir} is not present in executable PATH results.`)}\n`)
      write(`  ${dim('  Add this directory to PATH yourself, then open a new terminal:')}\n`)
      write(`  ${fg.cyan(`  ${installDir}`)}\n`)
      write(`  ${dim('  PowerShell can also resolve aliases/functions first; inspect with:')}\n`)
      write(`  ${fg.cyan('  Get-Command -All microcode | Format-List CommandType,Name,Source,Definition')}\n`)
    } else {
      write(`  ${fg.green('✓')}  ${dim('The canonical executable is the first executable PATH hit.') }\n`)
      write(`  ${dim('  PowerShell aliases/functions can still take precedence; verify with Get-Command -All microcode.')}\n`)
    }
    if (lookup.error) write(`  ${fg.yellow('!')}  ${dim(`Could not run where.exe: ${lookup.error.message}`)}\n`)
    write('\n')
  }
}

void main().catch((error: unknown) => {
  write(`${CLEAR_LINE}${fg.red('✗')}  ${bold('build failed')}: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
