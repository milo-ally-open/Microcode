import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import type {
  FileSystem,
  FileInfo,
  FileKind,
  Result,
  FileError,
} from '@earendil-works/pi-agent-core'

function ok<T>(value: T): Result<T, FileError> {
  return { ok: true, value }
}

function err(code: FileError['code'], message: string, path?: string): Result<never, FileError> {
  return { ok: false, error: { code, message, path, name: 'FileError' } as FileError }
}

function toFileKind(stats: import('fs').Stats): FileKind {
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isDirectory()) return 'directory'
  return 'file'
}

/**
 * Node.js implementation of the pi-agent-core FileSystem interface.
 */
export class NodeFileSystem implements FileSystem {
  cwd: string

  constructor(cwd: string) {
    this.cwd = cwd
  }

  async openTextLineReader(p: string, _context: unknown): Promise<any> {
    try {
      const content = await fs.readFile(path.resolve(this.cwd, p), 'utf8')
      const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? []
      let index = 0
      return ok({
        async readLine() {
          const line = lines[index++]
          return { ok: true as const, value: line === undefined ? undefined : {
            text: line.endsWith('\n') ? line.slice(0, -1).replace(/\r$/, '') : line.replace(/\r$/, ''),
            terminated: line.endsWith('\n'),
          } }
        },
        async close() {},
      })
    } catch (e: any) {
      if (e.code === 'ENOENT') return err('not_found', `File not found: ${p}`, p)
      return err('unknown', e.message, p)
    }
  }

  async absolutePath(p: string): Promise<Result<string, FileError>> {
    try {
      return ok(path.resolve(this.cwd, p))
    } catch (e) {
      return err('unknown', `Failed to resolve path: ${e}`, p)
    }
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    try {
      return ok(path.join(...parts))
    } catch (e) {
      return err('unknown', `Failed to join paths: ${e}`)
    }
  }

  async readTextFile(p: string): Promise<Result<string, FileError>> {
    try {
      const abs = path.resolve(this.cwd, p)
      const content = await fs.readFile(abs, 'utf-8')
      return ok(content)
    } catch (e: any) {
      if (e.code === 'ENOENT') return err('not_found', `File not found: ${p}`, p)
      if (e.code === 'EACCES') return err('permission_denied', `Permission denied: ${p}`, p)
      return err('unknown', e.message, p)
    }
  }

  async readTextLines(p: string, options?: { maxLines?: number }): Promise<Result<string[], FileError>> {
    try {
      const abs = path.resolve(this.cwd, p)
      const content = await fs.readFile(abs, 'utf-8')
      const lines = content.split('\n')
      if (options?.maxLines) {
        return ok(lines.slice(0, options.maxLines))
      }
      return ok(lines)
    } catch (e: any) {
      if (e.code === 'ENOENT') return err('not_found', `File not found: ${p}`, p)
      if (e.code === 'EACCES') return err('permission_denied', `Permission denied: ${p}`, p)
      return err('unknown', e.message, p)
    }
  }

  async readBinaryFile(p: string): Promise<Result<Uint8Array, FileError>> {
    try {
      const abs = path.resolve(this.cwd, p)
      const content = await fs.readFile(abs)
      return ok(new Uint8Array(content))
    } catch (e: any) {
      if (e.code === 'ENOENT') return err('not_found', `File not found: ${p}`, p)
      if (e.code === 'EACCES') return err('permission_denied', `Permission denied: ${p}`, p)
      return err('unknown', e.message, p)
    }
  }

  async writeFile(p: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    try {
      const abs = path.resolve(this.cwd, p)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content)
      return ok(undefined)
    } catch (e: any) {
      if (e.code === 'EACCES') return err('permission_denied', `Permission denied: ${p}`, p)
      return err('unknown', e.message, p)
    }
  }

  async appendFile(p: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    try {
      const abs = path.resolve(this.cwd, p)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.appendFile(abs, content)
      return ok(undefined)
    } catch (e: any) {
      if (e.code === 'EACCES') return err('permission_denied', `Permission denied: ${p}`, p)
      return err('unknown', e.message, p)
    }
  }

  async renameFile(sourcePath: string, destinationPath: string): Promise<Result<void, FileError>> {
    try {
      await fs.rename(path.resolve(this.cwd, sourcePath), path.resolve(this.cwd, destinationPath))
      return ok(undefined)
    } catch (e: any) {
      return err(e.code === 'EACCES' ? 'permission_denied' : 'unknown', e.message, sourcePath)
    }
  }

  async fileInfo(p: string): Promise<Result<FileInfo, FileError>> {
    try {
      const abs = path.resolve(this.cwd, p)
      const stats = await fs.lstat(abs)
      return ok({
        name: path.basename(abs),
        path: abs,
        kind: toFileKind(stats),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      })
    } catch (e: any) {
      if (e.code === 'ENOENT') return err('not_found', `Path not found: ${p}`, p)
      return err('unknown', e.message, p)
    }
  }

  async listDir(p: string): Promise<Result<FileInfo[], FileError>> {
    try {
      const abs = path.resolve(this.cwd, p)
      const entries = await fs.readdir(abs, { withFileTypes: true })
      const results: FileInfo[] = []
      for (const entry of entries) {
        const entryPath = path.join(abs, entry.name)
        try {
          const stats = await fs.lstat(entryPath)
          results.push({
            name: entry.name,
            path: entryPath,
            kind: toFileKind(stats),
            size: stats.size,
            mtimeMs: stats.mtimeMs,
          })
        } catch {
          // Skip entries we can't stat
        }
      }
      return ok(results)
    } catch (e: any) {
      if (e.code === 'ENOENT') return err('not_found', `Directory not found: ${p}`, p)
      if (e.code === 'ENOTDIR') return err('not_directory', `Not a directory: ${p}`, p)
      return err('unknown', e.message, p)
    }
  }

  async canonicalPath(p: string): Promise<Result<string, FileError>> {
    try {
      const abs = path.resolve(this.cwd, p)
      const real = await fs.realpath(abs)
      return ok(real)
    } catch (e: any) {
      if (e.code === 'ENOENT') return err('not_found', `Path not found: ${p}`, p)
      return err('unknown', e.message, p)
    }
  }

  async exists(p: string): Promise<Result<boolean, FileError>> {
    try {
      const abs = path.resolve(this.cwd, p)
      await fs.access(abs)
      return ok(true)
    } catch {
      return ok(false)
    }
  }

  async createDir(p: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>> {
    try {
      const abs = path.resolve(this.cwd, p)
      await fs.mkdir(abs, { recursive: options?.recursive ?? true })
      return ok(undefined)
    } catch (e: any) {
      if (e.code === 'EACCES') return err('permission_denied', `Permission denied: ${p}`, p)
      return err('unknown', e.message, p)
    }
  }

  async remove(p: string, options?: { recursive?: boolean; force?: boolean }): Promise<Result<void, FileError>> {
    try {
      const abs = path.resolve(this.cwd, p)
      await fs.rm(abs, { recursive: options?.recursive ?? false, force: options?.force ?? false })
      return ok(undefined)
    } catch (e: any) {
      if (!options?.force) {
        if (e.code === 'ENOENT') return err('not_found', `Path not found: ${p}`, p)
        if (e.code === 'EACCES') return err('permission_denied', `Permission denied: ${p}`, p)
      }
      return err('unknown', e.message, p)
    }
  }

  async createTempDir(prefix?: string): Promise<Result<string, FileError>> {
    try {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix ?? 'tmp-'))
      return ok(dir)
    } catch (e: any) {
      return err('unknown', e.message)
    }
  }

  async createTempFile(options?: { prefix?: string; suffix?: string }): Promise<Result<string, FileError>> {
    try {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), options?.prefix ?? 'tmp-'))
      const filePath = path.join(dir, `file${options?.suffix ?? ''}`)
      await fs.writeFile(filePath, '')
      return ok(filePath)
    } catch (e: any) {
      return err('unknown', e.message)
    }
  }

  async cleanup(): Promise<void> {
    // No-op for Node.js filesystem
  }
}
