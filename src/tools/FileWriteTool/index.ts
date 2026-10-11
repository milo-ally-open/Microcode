import { registerTool } from '../registry.ts'
import { existsSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { createFileWriteTool, previewFileWrite, TOOL_NAME, TOOL_DEFAULT_PERMISSION, type FileWriteToolInput } from './FileWriteTool.ts'
import { FileWriteToolUI } from './UI.tsx'
import { basename, formatBytes } from '../../utils/displayUtils.ts'
import { count, countLines, joinSummaryParts, statusPrefix, text } from '../summary.ts'

registerTool({
  name: TOOL_NAME,
  policy: { defaultPermission: TOOL_DEFAULT_PERMISSION },
  agent: {
    create: createFileWriteTool,
    formatDescription: (input) => typeof input.file_path === 'string' ? `write ${input.file_path}` : '(unknown file)',
    extractMatchContent: (input) => typeof input.file_path === 'string' ? input.file_path : undefined,
    summarizeResult: (context) => {
      const details = context.details ?? {}
      const state = details.written === false ? 'not written' : 'written'
      const warning = typeof details.warning === 'string' ? `warning: ${details.warning}` : undefined
      return `[write] ${statusPrefix(context)}${joinSummaryParts([
        text(details.path), state, count(details.bytesWritten, 'bytes'),
        count(details.additions, 'additions'), count(details.removals, 'removals'), warning,
      ])}`
    },
  },
  presentation: {
    View: FileWriteToolUI,
    projectInput: (cwd, input) => {
      const filePath = typeof input.file_path === 'string' ? input.file_path : ''
      const content = typeof input.content === 'string' ? input.content : ''
      const path = filePath ? (isAbsolute(filePath) ? filePath : resolve(cwd, filePath)) : ''
      return {
        path: path || filePath,
        bytesWritten: Buffer.byteLength(content, 'utf8'),
        additions: countLines(content),
        removals: 0,
        isNewFile: path ? !existsSync(path) : false,
        preview: content,
        phase: 'preparing',
      }
    },
    prepareApproval: async (cwd, input) => {
      const filePath = typeof input.file_path === 'string' ? input.file_path : ''
      const content = typeof input.content === 'string' ? input.content : ''
      const path = filePath ? (isAbsolute(filePath) ? filePath : resolve(cwd, filePath)) : ''
      try {
        return { ...await previewFileWrite(cwd, input as FileWriteToolInput), phase: 'approval' }
      } catch (error) {
        return {
          path: path || filePath,
          bytesWritten: Buffer.byteLength(content, 'utf8'),
          additions: countLines(content),
          removals: 0,
          isNewFile: path ? !existsSync(path) : false,
          preview: content,
          previewNotice: `Diff unavailable: ${error instanceof Error ? error.message : 'unable to read file'}`,
          phase: 'approval',
        }
      }
    },
    activity: ({ input }) =>
      typeof input.file_path === 'string'
        ? `Writing ${input.file_path}`
        : 'Writing a file',
    detail: ({ input }) =>
      typeof input.file_path === 'string' ? basename(input.file_path) : 'write',
    status: ({ details }) => {
      if (!details) return 'Writing...'
      if (details.phase === 'preparing') return 'Preparing...'
      if (details.phase === 'writing') return 'Writing...'
      const bytes = typeof details.bytesWritten === 'number' ? details.bytesWritten : 0
      return bytes > 0 ? formatBytes(bytes) : 'Writing...'
    },
  },
})
