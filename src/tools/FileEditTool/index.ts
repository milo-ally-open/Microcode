import { registerTool } from '../registry.ts'
import { createFileEditTool, previewFileEdit, TOOL_NAME, TOOL_DEFAULT_PERMISSION, type FileEditToolInput } from './FileEditTool.ts'
import { FileEditToolUI } from './UI.tsx'
import { basename } from '../../utils/displayUtils.ts'
import { count, countLines, joinSummaryParts, statusPrefix, text } from '../summary.ts'

registerTool({
  name: TOOL_NAME,
  policy: { defaultPermission: TOOL_DEFAULT_PERMISSION },
  agent: {
    create: createFileEditTool,
    formatDescription: (input) => typeof input.file_path === 'string' ? `edit ${input.file_path}` : '(unknown file)',
    extractMatchContent: (input) => typeof input.file_path === 'string' ? input.file_path : undefined,
    summarizeResult: (context) => {
      const details = context.details ?? {}
      return `[edit] ${statusPrefix(context)}${joinSummaryParts([
        text(details.path), count(details.replacements, 'replacements'),
        count(details.additions, 'additions'), count(details.removals, 'removals'),
      ])}`
    },
  },
  presentation: {
    View: FileEditToolUI,
    projectInput: (_cwd, input) => {
      const oldString = typeof input.old_string === 'string' ? input.old_string : ''
      const newString = typeof input.new_string === 'string' ? input.new_string : ''
      return {
        path: typeof input.file_path === 'string' ? input.file_path : '',
        additions: countLines(newString),
        removals: countLines(oldString),
        replacements: input.replace_all === true ? 0 : 1,
        phase: 'preparing',
      }
    },
    prepareApproval: async (cwd, input) => {
      const filePath = typeof input.file_path === 'string' ? input.file_path : ''
      const oldString = typeof input.old_string === 'string' ? input.old_string : ''
      const newString = typeof input.new_string === 'string' ? input.new_string : ''
      try {
        return { ...await previewFileEdit(cwd, input as FileEditToolInput), phase: 'preparing' }
      } catch (error) {
        return {
          path: filePath,
          replacements: input.replace_all === true ? 0 : 1,
          additions: countLines(newString),
          removals: countLines(oldString),
          diff: [],
          previewNotice: `Preview unavailable: ${error instanceof Error ? error.message : 'unable to read file'}`,
          phase: 'preparing',
        }
      }
    },
    activity: ({ input }) =>
      typeof input.file_path === 'string'
        ? `Editing ${input.file_path}`
        : 'Editing a file',
    detail: ({ input }) =>
      typeof input.file_path === 'string' ? basename(input.file_path) : 'edit',
    status: ({ details }) => {
      if (!details) return 'Editing...'
      if (details.phase === 'preparing') return 'Preparing...'
      if (details.phase === 'writing') return 'Writing...'
      const additions = typeof details.additions === 'number' ? details.additions : 0
      const removals = typeof details.removals === 'number' ? details.removals : 0
      return `${additions}+ ${removals}-`
    },
  },
})
