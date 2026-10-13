import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

export interface ReleaseFile {
  readonly path: string
  readonly size: number
  readonly sha256: string
}

export interface DesktopReleaseManifest {
  readonly schemaVersion: 1
  readonly product: 'Microcode'
  readonly version: string
  readonly commit: string
  readonly sourceTreeSha256: string
  readonly sourceDirty: boolean
  readonly platform: 'windows'
  readonly architecture: 'x64'
  readonly minimumWindows: {
    readonly release: 'Windows 11 25H2'
    readonly build: 26200
    readonly serverRelease: 'Windows Server 2025'
    readonly serverBuild: 26100
  }
  readonly installScope: 'current-user'
  readonly codeSigning: 'unsigned'
  readonly updatePolicy: 'manual'
  readonly toolchain: {
    readonly bun: '1.3.14'
    readonly bunArchiveSha256: string
    readonly bunLicenseSha256: string
    readonly electron: '44.7.0'
    readonly gitForWindows: '2.54.0.windows.1'
    readonly gitArchiveSha256: string
    readonly nsis: '3.13'
    readonly nsisArchiveSha256: string
    readonly desktopTransportProtocolVersion: number
    readonly runtimeProtocolVersion: number
  }
  readonly validation: {
    readonly typecheck: { readonly status: 'passed'; readonly compiler: string }
    readonly tests: { readonly status: 'passed'; readonly passed: number; readonly skipped: number; readonly failed: 0 }
    readonly cliBuild: { readonly status: 'passed'; readonly host: string }
    readonly desktopBuild: { readonly status: 'passed' }
    readonly packagedBackendSmoke: {
      readonly status: 'pending' | 'passed'
      readonly workspace?: 'passed'
      readonly conversationSession?: 'passed'
      readonly reviewDiff?: 'passed'
      readonly gitBashTerminal?: 'passed'
      readonly secretScan?: 'passed'
      readonly orphanProcessScan?: 'passed'
    }
    readonly installationUpgradeUninstallSmoke: { readonly status: 'pending' | 'passed'; readonly userDataPreserved?: true }
  }
  readonly files: readonly ReleaseFile[]
}

function isMetadataFile(path: string): boolean {
  return path === 'release-manifest.json' || path === 'release-manifest.sha256'
}

function toPackagePath(path: string): string {
  return path.split(sep).join('/')
}

function isSafePackagePath(path: string): boolean {
  if (path.length === 0 || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false
  const parts = path.split('/')
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
}

export async function indexReleaseFiles(root: string): Promise<ReleaseFile[]> {
  const base = resolve(root)
  const files: ReleaseFile[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const stat = await lstat(absolute)
      if (stat.isSymbolicLink()) throw new Error(`Release packages may not contain symbolic links: ${absolute}`)
      if (stat.isDirectory()) {
        await visit(absolute)
        continue
      }
      if (!stat.isFile()) throw new Error(`Unsupported release package entry: ${absolute}`)
      const path = toPackagePath(relative(base, absolute))
      if (isMetadataFile(path)) continue
      const digest = createHash('sha256').update(await readFile(absolute)).digest('hex')
      files.push({ path, size: stat.size, sha256: digest })
    }
  }
  await visit(base)
  return files
}

export async function verifyReleaseFiles(root: string, expectedFiles: readonly ReleaseFile[]): Promise<void> {
  const expected = new Map<string, ReleaseFile>()
  for (const file of expectedFiles) {
    if (!isSafePackagePath(file.path) || expected.has(file.path)) throw new Error(`Invalid or duplicate release manifest path: ${file.path}`)
    expected.set(file.path, file)
  }

  const actualFiles = await indexReleaseFiles(root)
  if (actualFiles.length !== expected.size) throw new Error(`Release package inventory mismatch (expected ${expected.size} files, found ${actualFiles.length}).`)
  for (const actual of actualFiles) {
    const expectedFile = expected.get(actual.path)
    if (!expectedFile) throw new Error(`Unexpected release package file: ${actual.path}`)
    if (actual.size !== expectedFile.size || actual.sha256 !== expectedFile.sha256) {
      throw new Error(`Release package integrity check failed for ${actual.path}.`)
    }
  }
}
