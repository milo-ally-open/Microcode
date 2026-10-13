import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path'
import { indexReleaseFiles, verifyReleaseFiles, type DesktopReleaseManifest } from './manifest.ts'
import { DESKTOP_TRANSPORT_PROTOCOL_VERSION } from '../../../src/desktop/protocol.ts'
import { RUNTIME_PROTOCOL_VERSION } from '../../../src/runtime/protocol.ts'

const projectRoot = resolve(import.meta.dir, '../../..')
const packageVersionData = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as { readonly version: string }
const packageVersion = packageVersionData.version
const gitLock = JSON.parse(await readFile(join(import.meta.dir, 'runtime-lock.json'), 'utf8')) as {
  readonly bun: {
    readonly version: string
    readonly archive: string
    readonly sha256: string
    readonly licenseFile: string
    readonly licenseSha256: string
    readonly download: string
  }
  readonly gitForWindows: { readonly version: string; readonly archive: string; readonly sha256: string; readonly download: string }
  readonly nsis: { readonly version: string; readonly archive: string; readonly sha256: string; readonly download: string }
}

if (process.arch !== 'x64') throw new Error(`Windows release builds require an x64 tool host; found ${process.arch}.`)
const isWsl = process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME)
if (process.platform !== 'win32' && !isWsl) throw new Error('Run the Windows x64 release build on Windows or from WSL attached to Windows.')

function readOutputDirectory(): string {
  const args = process.argv.slice(2)
  const index = args.findIndex((argument) => argument === '--out-dir' || argument.startsWith('--out-dir='))
  if (index >= 0) {
    const value = args[index] === '--out-dir' ? args[index + 1] : args[index].slice('--out-dir='.length)
    if (!value || value.startsWith('--')) throw new Error('--out-dir requires a directory path.')
    return resolve(projectRoot, value)
  }
  return join(projectRoot, 'dist', 'releases', `microcode-desktop-v${packageVersion}-windows-x64`)
}

const outputDirectory = readOutputDirectory()
const releaseParent = dirname(outputDirectory)
const outputInstaller = join(releaseParent, `${basename(outputDirectory)}-setup.exe`)
const outputInstallerChecksum = `${outputInstaller}.sha256`
const relativeOutput = relative(projectRoot, outputDirectory)
if (relativeOutput.startsWith('..') || resolve(projectRoot, relativeOutput) !== outputDirectory) {
  throw new Error('Windows release output must stay under the target repository.')
}
await mkdir(releaseParent, { recursive: true })
for (const path of [outputDirectory, outputInstaller, outputInstallerChecksum]) {
  try {
    await stat(path)
    throw new Error(`Refusing to overwrite existing release output: ${path}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing to overwrite')) throw error
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code !== 'ENOENT') throw error
  }
}

let validationDirectory: string | undefined
let packageDirectory: string | undefined
let buildSucceeded = false
try {
validationDirectory = await mkdtemp(join(releaseParent, '.microcode-validation-'))
packageDirectory = await mkdtemp(join(releaseParent, '.microcode-candidate-'))
const validationRoot = validationDirectory
const packageRoot = packageDirectory
const runtimeCache = join(projectRoot, 'dist', 'toolchain', 'desktop-windows-x64')
const brandDirectory = join(validationRoot, 'installer-brand')
await mkdir(runtimeCache, { recursive: true })

function safeOutput(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/((?:api.?key|access.?token|refresh.?token|secret|password|authorization|credential)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
}

function nsisPath(value: string): string {
  if (value.includes('"') || /[\r\n]/.test(value)) throw new Error(`NSIS paths may not contain quotes or line breaks: ${value}`)
  return value.replaceAll('$', '$$').replaceAll('/', '\\')
}

async function writeUninstallerFileList(directory: string, files: DesktopReleaseManifest['files']): Promise<void> {
  const parentDirectories = new Set<string>()
  const commands = files.map(({ path }) => {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) parentDirectories.add(parts.slice(0, index).join('/'))
    return `Delete "$INSTDIR\\${nsisPath(path)}"`
  })
  const orderedDirectories = [...parentDirectories].sort((left, right) => {
    const depth = right.split('/').length - left.split('/').length
    return depth || right.localeCompare(left)
  })
  commands.push(...orderedDirectories.map((path) => `RMDir "$INSTDIR\\${nsisPath(path)}"`))
  await writeFile(directory, `${commands.join('\n')}\n`)
}

async function run(command: readonly string[], options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {}): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const processHandle = Bun.spawn({
    cmd: [...command],
    cwd: options.cwd ?? projectRoot,
    env: options.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])
  return { exitCode, stdout, stderr }
}

function failProcess(label: string, result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string }): never {
  const diagnostic = safeOutput(`${result.stderr}\n${result.stdout}`).trim().slice(-6000)
  throw new Error(`${label} failed with exit code ${result.exitCode}.${diagnostic ? `\n${diagnostic}` : ''}`)
}

function windowsPath(path: string): string {
  if (process.platform === 'win32') return path
  const result = Bun.spawnSync({ cmd: ['wslpath', '-w', path], stdout: 'pipe', stderr: 'pipe' })
  if (!result.success) throw new Error(`Could not convert a repository path for the Windows packager: ${safeOutput(result.stderr.toString('utf8'))}`)
  return result.stdout.toString('utf8').trim()
}

async function runPowerShell(script: string, parameters: Readonly<Record<string, string>>): Promise<string> {
  const args = ['powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', windowsPath(script)]
  const pathParameters = new Set([
    'RepositoryRoot', 'CacheRoot', 'Application', 'SmokeRoot', 'SourceDirectory', 'OutputFile', 'ArchivePath',
    'SetupExecutable', 'InstallRoot', 'OutputDirectory', 'CompilerPath', 'ScriptPath', 'PackageDirectory',
    'UninstallFiles', 'BrandIcon', 'WizardBitmap', 'SmokeDefaultInstallDirectory', 'SmokeStartMenuPath', 'SmokeDesktopPath', 'InstallDirectory',
  ])
  for (const [name, value] of Object.entries(parameters)) args.push(`-${name}`, pathParameters.has(name) ? windowsPath(value) : value)
  const result = await run(args, { env: buildEnvironment })
  if (result.exitCode !== 0) failProcess(basename(script), result)
  return result.stdout.trim()
}

function listFromTestOutput(output: string): { readonly passed: number; readonly skipped: number; readonly failed: 0 } {
  const match = output.match(/(?:^|\n)\s*(\d+)\s+pass\s*\n\s*(\d+)\s+skip\s*\n\s*0\s+fail\b/m)
  if (!match) throw new Error('The test command passed without emitting the expected pass/skip/fail summary.')
  return { passed: Number(match[1]), skipped: Number(match[2]), failed: 0 }
}

async function sourceTreeDigest(root: string): Promise<string> {
  const excludedDirectories = new Set(['.git', 'node_modules', 'dist', '.microcode', 'coverage', 'out', '.codex', '.vscode'])
  const entries: Array<{ readonly path: string; readonly fullPath: string }> = []
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const child of children) {
      if (child.isDirectory() && excludedDirectories.has(child.name)) continue
      const fullPath = join(directory, child.name)
      if (child.isSymbolicLink()) throw new Error(`Source inputs may not contain symlinks: ${fullPath}`)
      if (child.isDirectory()) await visit(fullPath)
      else if (child.isFile()) entries.push({ path: relative(root, fullPath).split('\\').join('/'), fullPath })
    }
  }
  await visit(root)
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const hash = createHash('sha256')
  for (const entry of entries) {
    hash.update(entry.path).update('\0').update(await readFile(entry.fullPath)).update('\0')
  }
  return hash.digest('hex')
}

async function gitState(gitExecutable: string): Promise<{ readonly commit: string; readonly dirty: boolean }> {
  const commit = await run([gitExecutable, 'rev-parse', 'HEAD'])
  if (commit.exitCode !== 0) failProcess('git rev-parse HEAD', commit)
  const status = await run([gitExecutable, 'status', '--porcelain', '--untracked-files=all'])
  if (status.exitCode !== 0) failProcess('git status', status)
  return { commit: commit.stdout.trim(), dirty: status.stdout.trim().length > 0 }
}

const environment: NodeJS.ProcessEnv = { ...process.env }
const toolBin = dirname(process.execPath)
const existingPathKey = Object.keys(environment).find((name) => name.toLowerCase() === 'path')
const existingPath = existingPathKey ? environment[existingPathKey] ?? '' : ''
for (const name of Object.keys(environment)) {
  if (name.toLowerCase() === 'path') delete environment[name]
}
environment[process.platform === 'win32' ? 'Path' : 'PATH'] = [toolBin, existingPath].filter(Boolean).join(delimiter)
for (const name of Object.keys(environment)) {
  if (/(?:^|_)(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/i.test(name)) delete environment[name]
}
const buildEnvironment = environment

console.log(`Building Microcode Desktop ${packageVersion} for Windows x64 with Bun ${Bun.version}.`)
await runPowerShell(join(import.meta.dir, 'Prepare-WindowsToolchain.ps1'), {
  RepositoryRoot: projectRoot,
  CacheRoot: runtimeCache,
})
console.log('Verified the pinned Electron, Bun, and portable Git Windows runtimes.')

const electronDirectory = join(runtimeCache, 'electron-44.7.0-win32-x64')
const bunDirectory = join(runtimeCache, 'bun-1.3.14-windows-x64')
const bunExecutable = join(bunDirectory, 'bun-windows-x64', 'bun.exe')
const gitDirectory = join(runtimeCache, `git-for-windows-${gitLock.gitForWindows.version}-x64`)
const nsisDirectory = join(runtimeCache, `nsis-${gitLock.nsis.version}`, `nsis-${gitLock.nsis.version}`)
const nsisCompiler = join(nsisDirectory, 'makensis.exe')
await stat(nsisCompiler)
console.log(`Verified the pinned NSIS ${gitLock.nsis.version} setup compiler.`)
const gitExecutable = process.platform === 'win32' ? join(gitDirectory, 'cmd', 'git.exe') : 'git'
const gitStateBeforeChecks = await gitState(gitExecutable)
const sourceDigestBeforeChecks = await sourceTreeDigest(projectRoot)
const bunLicensePath = join(import.meta.dir, gitLock.bun.licenseFile)
const bunLicenseSha256 = createHash('sha256').update(await readFile(bunLicensePath)).digest('hex')
if (bunLicenseSha256 !== gitLock.bun.licenseSha256) throw new Error('The checked-in Bun third-party license file does not match its locked SHA-256.')
const typescriptPackage = JSON.parse(await readFile(join(projectRoot, 'node_modules/typescript/package.json'), 'utf8')) as { readonly version: string }

const typecheck = await run([process.execPath, 'run', 'typecheck'], { env: buildEnvironment })
if (typecheck.exitCode !== 0) failProcess('TypeScript typecheck', typecheck)
console.log(`Typecheck passed with TypeScript ${typescriptPackage.version}.`)

const testRun = await run([process.execPath, 'run', 'test'], { env: buildEnvironment })
if (testRun.exitCode !== 0) failProcess('bun run test', testRun)
const testResults = listFromTestOutput(`${testRun.stdout}\n${testRun.stderr}`)
console.log(`Tests passed: ${testResults.passed}; skipped: ${testResults.skipped}; failed: 0.`)

const cliOutput = join(validationRoot, 'microcode.exe')
const cliBuild = await run([process.execPath, 'run', 'build', '--no-install', '--out', cliOutput, '--target', 'bun-windows-x64'], { env: buildEnvironment })
if (cliBuild.exitCode !== 0) failProcess('CLI/TUI production build', cliBuild)
await stat(cliOutput)
console.log('CLI/TUI production build passed for bun-windows-x64.')

const electronFiles = await readdir(electronDirectory)
for (const entry of electronFiles) {
  const source = join(electronDirectory, entry)
  const destination = join(packageRoot, entry)
  if (entry === 'electron.exe') continue
  await cp(source, destination, { recursive: true, errorOnExist: true })
}
await cp(join(electronDirectory, 'electron.exe'), join(packageRoot, 'Microcode.exe'))
const resourcesDirectory = join(packageRoot, 'resources')
await mkdir(resourcesDirectory, { recursive: true })
const appDirectory = join(resourcesDirectory, 'app')
await mkdir(appDirectory, { recursive: true })
await cp(gitDirectory, join(resourcesDirectory, 'git'), { recursive: true, errorOnExist: true })
await runPowerShell(join(import.meta.dir, 'Generate-InstallerBrandAssets.ps1'), {
  LogoPath: join(projectRoot, 'assets', 'microcode-logo-light.png'),
  OutputDirectory: brandDirectory,
})

const mainBuild = await Bun.build({
  entrypoints: [join(projectRoot, 'src/desktop/main.ts')],
  outdir: appDirectory,
  naming: { entry: 'main.mjs' },
  target: 'node',
  format: 'esm',
  external: ['electron'],
  define: { __MICROCODE_DESKTOP_VERSION__: JSON.stringify(packageVersion) },
})
const preloadBuild = await Bun.build({
  entrypoints: [join(projectRoot, 'src/desktop/preload.ts')],
  outdir: appDirectory,
  naming: { entry: 'preload.cjs' },
  target: 'node',
  format: 'cjs',
  external: ['electron'],
})
const rendererBuild = await Bun.build({
  entrypoints: [join(projectRoot, 'src/desktop/renderer/main.tsx')],
  outdir: appDirectory,
  naming: { entry: 'renderer.js' },
  target: 'browser',
  format: 'esm',
  jsx: { factory: 'h', fragment: 'Fragment', runtime: 'classic' },
})
const backendBuild = await Bun.build({
  entrypoints: [join(projectRoot, 'src/desktop/backend.ts')],
  outdir: resourcesDirectory,
  naming: { entry: 'backend.mjs' },
  target: 'bun',
  format: 'esm',
  define: { __MICROCODE_DESKTOP_VERSION__: JSON.stringify(packageVersion) },
})
for (const result of [mainBuild, preloadBuild, rendererBuild, backendBuild]) {
  if (!result.success) {
    const diagnostics = result.logs.map((log) => log.message).join('\n')
    throw new Error(`Desktop production build failed.${diagnostics ? `\n${safeOutput(diagnostics)}` : ''}`)
  }
}

await Promise.all([
  cp(bunExecutable, join(resourcesDirectory, 'microcode-backend.exe')),
  cp(bunLicensePath, join(resourcesDirectory, 'BUN-LICENSE.md')),
  cp(join(brandDirectory, 'Microcode.ico'), join(resourcesDirectory, 'microcode.ico')),
  cp(join(projectRoot, 'node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node'), join(resourcesDirectory, 'keyring.win32-x64-msvc.node')),
  cp(join(projectRoot, 'src/desktop/renderer/index.html'), join(appDirectory, 'index.html')),
  cp(join(projectRoot, 'src/desktop/renderer/style.css'), join(appDirectory, 'style.css')),
  cp(join(projectRoot, 'node_modules/@xterm/xterm/css/xterm.css'), join(appDirectory, 'xterm.css')),
  writeFile(join(appDirectory, 'package.json'), `${JSON.stringify({ name: 'microcode-desktop', productName: 'Microcode', version: packageVersion, main: 'main.mjs', private: true }, null, 2)}\n`),
  cp(join(import.meta.dir, 'Install-Microcode.ps1'), join(packageRoot, 'Install-Microcode.ps1')),
  cp(join(import.meta.dir, 'Uninstall-Microcode.ps1'), join(packageRoot, 'Uninstall-Microcode.ps1')),
])

const manifestWithoutFiles: Omit<DesktopReleaseManifest, 'files'> = {
  schemaVersion: 1,
  product: 'Microcode',
  version: packageVersion,
  commit: gitStateBeforeChecks.commit,
  sourceTreeSha256: sourceDigestBeforeChecks,
  sourceDirty: gitStateBeforeChecks.dirty,
  platform: 'windows',
  architecture: 'x64',
  minimumWindows: { release: 'Windows 11 25H2', build: 26200, serverRelease: 'Windows Server 2025', serverBuild: 26100 },
  installScope: 'current-user',
  codeSigning: 'unsigned',
  updatePolicy: 'manual',
  toolchain: {
    bun: '1.3.14',
    bunArchiveSha256: gitLock.bun.sha256,
    bunLicenseSha256,
    electron: '44.7.0',
    gitForWindows: '2.54.0.windows.1',
    gitArchiveSha256: gitLock.gitForWindows.sha256,
    nsis: gitLock.nsis.version,
    nsisArchiveSha256: gitLock.nsis.sha256,
    desktopTransportProtocolVersion: DESKTOP_TRANSPORT_PROTOCOL_VERSION,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  },
  validation: {
    typecheck: { status: 'passed', compiler: `TypeScript ${typescriptPackage.version}` },
    tests: { status: 'passed', ...testResults },
    cliBuild: { status: 'passed', host: 'bun-windows-x64' },
    desktopBuild: { status: 'passed' },
    packagedBackendSmoke: { status: 'pending' },
    installationUpgradeUninstallSmoke: { status: 'pending' },
  },
}
const releaseFiles = await indexReleaseFiles(packageRoot)
let manifest: DesktopReleaseManifest = { ...manifestWithoutFiles, files: releaseFiles }
let manifestHash = ''
const writeCandidateManifest = async (): Promise<void> => {
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`
  manifestHash = createHash('sha256').update(manifestBytes).digest('hex')
  await writeFile(join(packageRoot, 'release-manifest.json'), manifestBytes)
  await writeFile(join(packageRoot, 'release-manifest.sha256'), `${manifestHash}  release-manifest.json\n`)
}
await writeCandidateManifest()
await verifyReleaseFiles(packageRoot, manifest.files)

const uninstallFileList = join(validationRoot, 'uninstall-files.nsh')
await writeUninstallerFileList(uninstallFileList, manifest.files)

const smokeLog = await runPowerShell(join(projectRoot, 'tests', 'packaging', 'windows', 'Smoke-PackagedBackend.ps1'), {
  Application: join(packageRoot, 'Microcode.exe'),
  SmokeRoot: join(validationRoot, 'packaged-backend'),
})
console.log(smokeLog)

manifest = {
  ...manifest,
  validation: {
    ...manifest.validation,
    packagedBackendSmoke: {
      status: 'passed',
      workspace: 'passed',
      conversationSession: 'passed',
      reviewDiff: 'passed',
      gitBashTerminal: 'passed',
      gitBashTerminalColors: 'passed',
      openAiCodexOAuth: 'authorization-url-opened-and-cancelled',
      secretScan: 'passed',
      orphanProcessScan: 'passed',
    },
  },
}
await writeCandidateManifest()
await verifyReleaseFiles(packageRoot, manifest.files)

const candidateInstaller = join(validationRoot, basename(outputInstaller))
const smokeId = createHash('sha256').update(validationRoot).digest('hex').slice(0, 12)
const smokeRoot = join(validationRoot, 'installation')
const smokeProfile = join(smokeRoot, 'Windows profile with spaces')
const smokeInstallDirectory = join(smokeRoot, 'Chosen install location with spaces')
const smokeStartMenuPath = join(smokeProfile, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', `Microcode Smoke ${smokeId}`)
const smokeDesktopPath = join(smokeProfile, 'Desktop')
await runPowerShell(join(import.meta.dir, 'Compile-WindowsSetup.ps1'), {
  CompilerPath: nsisCompiler,
  ScriptPath: join(import.meta.dir, 'Microcode-Setup.nsi'),
  PackageDirectory: packageRoot,
  UninstallFiles: uninstallFileList,
  BrandIcon: join(brandDirectory, 'Microcode.ico'),
  WizardBitmap: join(brandDirectory, 'Microcode-Wizard.bmp'),
  OutputFile: candidateInstaller,
  ProductVersion: packageVersion,
  BuildMode: 'smoke',
  SmokeId: smokeId,
  SmokeDefaultInstallDirectory: join(smokeRoot, 'NSIS default install location'),
  SmokeStartMenuPath: smokeStartMenuPath,
  SmokeDesktopPath: smokeDesktopPath,
})
const installSmoke = await runPowerShell(join(projectRoot, 'tests', 'packaging', 'windows', 'Smoke-InstallUpgradeUninstall.ps1'), {
  SetupExecutable: candidateInstaller,
  SmokeRoot: smokeRoot,
  SmokeId: smokeId,
  SmokeStartMenuPath: smokeStartMenuPath,
  SmokeDesktopPath: smokeDesktopPath,
  InstallDirectory: smokeInstallDirectory,
  PackageDirectory: packageRoot,
  ProductVersion: packageVersion,
})
console.log(installSmoke)

manifest = {
  ...manifest,
  validation: {
    ...manifest.validation,
    installationUpgradeUninstallSmoke: { status: 'passed', userDataPreserved: true },
  },
}
await writeCandidateManifest()
await verifyReleaseFiles(packageRoot, manifest.files)

await runPowerShell(join(import.meta.dir, 'Compile-WindowsSetup.ps1'), {
  CompilerPath: nsisCompiler,
  ScriptPath: join(import.meta.dir, 'Microcode-Setup.nsi'),
  PackageDirectory: packageDirectory,
  UninstallFiles: uninstallFileList,
  BrandIcon: join(brandDirectory, 'Microcode.ico'),
  WizardBitmap: join(brandDirectory, 'Microcode-Wizard.bmp'),
  OutputFile: outputInstaller,
  ProductVersion: packageVersion,
  BuildMode: 'release',
})
const installerHash = createHash('sha256').update(await readFile(outputInstaller)).digest('hex')
await writeFile(outputInstallerChecksum, `${installerHash}  ${basename(outputInstaller)}\n`)
const installerSize = (await stat(outputInstaller)).size
buildSucceeded = true
console.log(`Windows setup wizard created: ${outputInstaller}`)
console.log(`Installer size: ${installerSize} bytes; release manifest SHA-256: ${manifestHash}`)
console.log(`Installer SHA-256: ${installerHash}`)
console.log(`Installer checksum: ${outputInstallerChecksum}`)
console.log(`Code signing is not configured. This artifact is an unsigned candidate; automatic updates are disabled.`)
} finally {
  const temporaryPaths = [validationDirectory, packageDirectory].filter((path): path is string => Boolean(path))
  const cleanupResults = await Promise.allSettled(temporaryPaths.map((path) => rm(path, { recursive: true, force: true })))
  if (!buildSucceeded) {
    cleanupResults.push(...await Promise.allSettled([
      rm(outputInstaller, { force: true }),
      rm(outputInstallerChecksum, { force: true }),
    ]))
  }
  const cleanupFailures = cleanupResults.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
  if (cleanupFailures.length > 0) {
    const message = `Could not remove ${cleanupFailures.length} Windows release build temporary path(s).`
    if (buildSucceeded) throw new Error(message, { cause: cleanupFailures[0] })
    console.error(message)
  }
}
