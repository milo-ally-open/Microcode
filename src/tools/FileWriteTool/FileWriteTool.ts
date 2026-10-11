import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { createHash } from 'crypto'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname, isAbsolute, resolve } from 'path'
import { Type, type Static } from 'typebox'
import type { PermissionBehavior } from '../../permissions/types.ts'
import { countContentLines } from '../../tui/toolPresentation.ts'
import { countLineChanges, generateDiff } from '../../utils/diffUtils.ts'

export const TOOL_NAME = 'write'
export const TOOL_DEFAULT_PERMISSION: PermissionBehavior = 'ask'

const writeSchema = Type.Object({
  file_path: Type.String({ description: 'Path to the file to write (relative or absolute)' }),
  content: Type.String({ description: 'Content to write to the file' }),
  force: Type.Optional(
    Type.Boolean({
      description:
        'Overwrite even if the file changed after this write started. Defaults to false.',
      default: false,
    }),
  ),
})

export type FileWriteToolInput = Static<typeof writeSchema>

export interface FileWriteToolDetails {
  path: string
  bytesWritten: number
  additions: number
  removals: number
  isNewFile: boolean
  preview?: string
  diff?: string[]
  diffTruncated?: boolean
  phase?: 'preparing' | 'writing' | 'complete'
  warning?: string
  written?: boolean
}

interface FileSnapshot {
  exists: boolean
  fingerprint?: string
  content?: string
}

const writeQueues = new Map<string, Promise<void>>()
const writeRevisions = new Map<string, number>()

async function snapshotFile(filePath: string): Promise<FileSnapshot> {
  try {
    const [content, info] = await Promise.all([
      readFile(filePath),
      stat(filePath),
    ])
    return {
      exists: true,
      fingerprint: createHash('sha256')
        .update(content)
        .update(String(info.mtimeMs))
        .digest('hex'),
      content: content.toString('utf8'),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false }
    }
    throw error
  }
}

function withFileWriteLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(operation)
  const tail = result.then(() => undefined, () => undefined)
  writeQueues.set(filePath, tail)
  return result.finally(() => {
    if (writeQueues.get(filePath) === tail) {
      writeQueues.delete(filePath)
      writeRevisions.delete(filePath)
    }
  })
}

function conflictResult(
  filePath: string,
  warning: string,
): AgentToolResult<FileWriteToolDetails> {
  return {
    content: [{ type: 'text', text: `Warning: ${warning}` }],
    details: {
      path: filePath,
      bytesWritten: 0,
      additions: 0,
      removals: 0,
      isNewFile: false,
      warning,
      written: false,
      phase: 'complete',
    },
  }
}

function getWriteChanges(oldContent: string, newContent: string, filePath: string) {
  if (oldContent.length + newContent.length > 1_000_000) {
    return {
      ...countLineChanges(oldContent, newContent),
      diff: [],
      diffTruncated: true,
    }
  }

  const { patch, additions, removals } = generateDiff(oldContent, newContent, filePath)
  const diff = patch.hunks.flatMap((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines,
  ])
  return { additions, removals, diff, diffTruncated: false }
}

export async function previewFileWrite(
  cwd: string,
  params: FileWriteToolInput,
): Promise<FileWriteToolDetails> {
  const filePath = isAbsolute(params.file_path)
    ? params.file_path
    : resolve(cwd, params.file_path)
  const current = await snapshotFile(filePath)
  return {
    path: filePath,
    bytesWritten: Buffer.byteLength(params.content, 'utf8'),
    ...getWriteChanges(current.content ?? '', params.content, filePath),
    isNewFile: !current.exists,
    preview: params.content,
    phase: 'preparing',
  }
}

export function createFileWriteTool(
  cwd: string,
): AgentTool<typeof writeSchema, FileWriteToolDetails> {
  return {
    name: TOOL_NAME,
    label: 'Write',
    description:
      'Write content to a file. Creates the file if it does not exist and overwrites an unchanged existing file. Concurrent changes are preserved unless force=true.',
    parameters: writeSchema,
    async execute(
      _toolCallId: string,
      params: FileWriteToolInput,
      _signal?: AbortSignal,
      onUpdate?: (partial: AgentToolResult<FileWriteToolDetails>) => void,
    ): Promise<AgentToolResult<FileWriteToolDetails>> {
      const filePath = isAbsolute(params.file_path)
        ? params.file_path
        : resolve(cwd, params.file_path)

      onUpdate?.({
        content: [{ type: 'text', text: `Preparing write ${filePath}` }],
        details: {
          path: filePath,
          bytesWritten: Buffer.byteLength(params.content, 'utf8'),
          additions: countContentLines(params.content),
          removals: 0,
          isNewFile: false,
          phase: 'preparing',
        },
      })

      const invocationRevision = writeRevisions.get(filePath) ?? 0
      const initial = await snapshotFile(filePath)

      await mkdir(dirname(filePath), { recursive: true })

      const isNewFile = !initial.exists
      const changes = getWriteChanges(initial.content ?? '', params.content, filePath)
      const bytesWritten = Buffer.byteLength(params.content, 'utf8')
      const preview = params.content

      onUpdate?.({
        content: [{ type: 'text', text: `Writing ${filePath}` }],
        details: {
          path: filePath,
          bytesWritten,
          ...changes,
          isNewFile,
          preview,
          phase: 'writing',
        },
      })

      return withFileWriteLock(filePath, async () => {
        const current = await snapshotFile(filePath)
        const changed = initial.exists
          ? !current.exists || current.fingerprint !== initial.fingerprint
          : current.exists
        const earlierInvocationWrote =
          (writeRevisions.get(filePath) ?? 0) !== invocationRevision

        if ((changed || earlierInvocationWrote) && params.force !== true) {
          return conflictResult(
            filePath,
            `File changed while this write was pending; no content was written: ${filePath}. Read the current file and retry, or pass force=true to overwrite it.`,
          )
        }

        if (!initial.exists && !current.exists && params.force !== true) {
          try {
            await writeFile(filePath, params.content, {
              encoding: 'utf8',
              flag: 'wx',
            })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            return conflictResult(
              filePath,
              `File was created concurrently; no content was written: ${filePath}. Read the current file and retry, or pass force=true to overwrite it.`,
            )
          }
        } else {
          await writeFile(filePath, params.content, 'utf8')
        }
        writeRevisions.set(filePath, invocationRevision + 1)

        return {
          content: [{
            type: 'text',
            text: `File written successfully: ${filePath} (${bytesWritten} bytes)`,
          }],
          details: {
            path: filePath,
            bytesWritten,
            ...changes,
            isNewFile,
            preview,
            written: true,
            phase: 'complete',
          },
        }
      })
    },
  }
}
