import { open, readFile, lstat, rename, rm, chmod, link } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join, resolve } from 'node:path'

export interface MicroFileSnapshot {
  path: string
  content?: string
  mode?: number
}

export async function readMicroFile(cwd: string): Promise<MicroFileSnapshot> {
  const filePath = resolve(cwd, 'MICRO.md')
  try {
    const info = await lstat(filePath)
    if (!info.isFile()) throw new Error(`${filePath} is not a regular file`)
    return {
      path: filePath,
      content: await readFile(filePath, 'utf8'),
      mode: info.mode,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: filePath }
    }
    throw error
  }
}

export async function writeMicroFile(
  cwd: string,
  expected: MicroFileSnapshot,
  content: string,
): Promise<void> {
  const target = resolve(cwd, 'MICRO.md')
  if (expected.path !== target) throw new Error('MICRO.md target changed during initialization.')

  const current = await readMicroFile(cwd)
  if (current.content !== expected.content) {
    throw new Error('MICRO.md changed while the proposal was being prepared. Reload instructions and try again.')
  }

  const temporary = join(cwd, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(content, 'utf8')
    } finally {
      await handle.close()
    }
    if (expected.content !== undefined && process.platform !== 'win32' && expected.mode !== undefined) {
      await chmod(temporary, expected.mode & 0o777)
    }

    if (expected.content === undefined) {
      try {
        await link(temporary, target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error('MICRO.md was created while the proposal was being prepared. Reload instructions and try again.')
        }
        throw error
      }
    } else {
      const latest = await readMicroFile(cwd)
      if (latest.content !== expected.content) {
        throw new Error('MICRO.md changed while the proposal was being prepared. Reload instructions and try again.')
      }
      await rename(temporary, target)
    }
  } finally {
    await rm(temporary, { force: true })
  }
}
