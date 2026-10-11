import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Copy a session's original JSONL log into a project-local, session-specific archive. */
export async function exportSessionJsonl(
  sourcePath: string,
  projectDirectory: string,
  sessionId: string,
): Promise<string> {
  const destinationDirectory = join(projectDirectory, '.microcode', 'sessions')
  // Session IDs are the stable identity; source filenames may collide when
  // sessions are imported or copied from another machine.
  const safeSessionId = encodeURIComponent(sessionId).replace(/%/g, '_')
  const destinationPath = join(destinationDirectory, `session-${safeSessionId}.jsonl`)

  await mkdir(destinationDirectory, { recursive: true })
  await copyFile(sourcePath, destinationPath)

  return destinationPath
}
