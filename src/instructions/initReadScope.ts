import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const RESTRICTED_PATH_SEGMENTS = new Set([
  '.git', 'node_modules', 'dist', 'coverage', 'out', '.microcode',
  '.npm', '.ssh', '.aws', '.config',
])

function isSensitiveSegment(segment: string): boolean {
  const name = segment.toLowerCase()
  return name.startsWith('.env')
    || /(^|[._-])(credentials?|secrets?|tokens?)([._-]|$)/i.test(name)
    || /(?:api[-_]?key|access[-_]?token|refresh[-_]?token)/i.test(name)
    || /\.(?:pem|key|p12|pfx|keystore)$/i.test(name)
    || name === '.npmrc'
    || name === '.netrc'
    || name === 'id_rsa'
    || name === 'id_ed25519'
}

export async function assertInitReadPath(cwd: string, requestedPath: unknown): Promise<void> {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    throw new Error('The read-only project scan requires a file path.')
  }
  const root = await realpath(cwd)
  const requested = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(cwd, requestedPath)
  const requestedRelative = relative(root, requested)
  if (!isWithinRoot(requestedRelative)) {
    throw new Error('The read-only project scan may only read files inside the current project directory.')
  }

  const target = await realpath(requested)
  const targetRelative = relative(root, target)
  if (!isWithinRoot(targetRelative)) {
    throw new Error('The read-only project scan may only read files inside the current project directory.')
  }

  const segments = [...requestedRelative.split(sep), ...targetRelative.split(sep)]
  if (segments.some((segment) => RESTRICTED_PATH_SEGMENTS.has(segment.toLowerCase()) || isSensitiveSegment(segment))) {
    throw new Error('The requested path is excluded from the read-only project scan.')
  }
}

function isWithinRoot(path: string): boolean {
  return path.length > 0
    && path !== '..'
    && !path.startsWith(`..${sep}`)
    && !isAbsolute(path)
}
