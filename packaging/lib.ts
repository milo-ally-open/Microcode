import { chmod, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'

export const projectRoot = resolve(import.meta.dir, '..')
export const packagingRoot = join(projectRoot, 'packaging')
export const outRoot = join(packagingRoot, 'out')
export const stagingRoot = join(outRoot, 'staging')

export interface PackageMeta {
  name: string
  version: string
}

export function platformTag(): string {
  const platform = process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'macos'
      : process.platform
  return `${platform}-${process.arch}`
}

export async function readPackageMeta(): Promise<PackageMeta> {
  const raw = await readFile(join(projectRoot, 'package.json'), 'utf8')
  const parsed = JSON.parse(raw) as { name?: string; version?: string }
  return {
    name: parsed.name ?? 'microcode',
    version: parsed.version ?? '0.0.0',
  }
}

function isAccessError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function removeWithRetry(path: string): Promise<void> {
  const attempts = process.platform === 'win32' ? 5 : 1
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === attempts || !isAccessError(error)) throw error
      await delay(150 * attempt)
    }
  }
}

export async function resetDir(path: string): Promise<string> {
  try {
    await removeWithRetry(path)
  } catch (error) {
    if (process.platform !== 'win32' || !isAccessError(error)) throw error

    const stalePath = `${path}.stale-${process.pid}-${Date.now()}`
    try {
      await rename(path, stalePath)
      removeWithRetry(stalePath).catch(() => {})
    } catch (renameError) {
      if (!isAccessError(renameError)) throw renameError
      const alternatePath = `${path}.build-${process.pid}-${Date.now()}`
      console.warn(`Could not remove locked staging directory; using ${alternatePath}`)
      await removeWithRetry(alternatePath)
      await mkdir(alternatePath, { recursive: true })
      return alternatePath
    }
  }
  await mkdir(path, { recursive: true })
  return path
}

export async function copyFileExecutable(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, { force: true })
  if (process.platform !== 'win32') await chmod(to, 0o755)
}

export async function writeExecutable(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
  if (process.platform !== 'win32') await chmod(path, 0o755)
}

export async function run(cmd: string[], options: { cwd?: string } = {}): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd ?? projectRoot,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${cmd.join(' ')}`)
  }
}

export async function assertExists(path: string): Promise<void> {
  await stat(path)
}

export async function archiveDirectory(sourceDir: string, artifactBase: string): Promise<string> {
  await mkdir(outRoot, { recursive: true })
  const parent = dirname(sourceDir)
  const name = basename(sourceDir)

  if (process.platform === 'win32') {
    const archivePath = `${artifactBase}.zip`
    await removeWithRetry(archivePath)
    await run([
      'powershell',
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path ${JSON.stringify(sourceDir)} -DestinationPath ${JSON.stringify(archivePath)} -Force`,
    ])
    return archivePath
  }

  const archivePath = `${artifactBase}.tar.gz`
  await removeWithRetry(archivePath)
  await run(['tar', '-czf', archivePath, '-C', parent, name])
  return archivePath
}

export function formatDone(label: string, value: string): void {
  console.log(`✓ ${label}: ${value}`)
}
