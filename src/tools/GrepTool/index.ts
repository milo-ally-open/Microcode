import { registerTool } from '../registry.ts'
import { createGrepTool, TOOL_NAME, TOOL_DEFAULT_PERMISSION } from './GrepTool.ts'
import { GrepToolUI } from './UI.tsx'
import { preview } from '../../utils/displayUtils.ts'
import { boolTag, count, joinSummaryParts, previewList, statusPrefix } from '../summary.ts'

registerTool({
  name: TOOL_NAME,
  policy: { defaultPermission: TOOL_DEFAULT_PERMISSION },
  agent: {
    create: createGrepTool,
    description:
      'Search file contents with regex using ripgrep. Supports full regex syntax, output modes (content/files_with_matches/count), file type filtering, context lines, and pagination (head_limit/offset). Use in preference to running grep/rg from Bash.',
    formatDescription: (input) => {
      if (typeof input.pattern === 'string') {
        const mode = input.output_mode ? ` [${input.output_mode}]` : ''
        return `grep /${input.pattern}/${mode}`
      }
      return '(unknown pattern)'
    },
    extractMatchContent: (input) => typeof input.pattern === 'string' ? input.pattern : undefined,
    summarizeResult: (context) => {
      const details = context.details ?? {}
      const mode = typeof details.mode === 'string' ? `mode=${details.mode}` : undefined
      return `[grep] ${statusPrefix(context)}${joinSummaryParts([
        mode, count(details.numFiles, 'files'), count(details.numMatches, 'matches'),
        count(details.numLines, 'lines'), boolTag(details.truncated, 'truncated'),
        previewList(details.filenames, 5, 'files'),
      ])}`
    },
  },
  presentation: {
    View: GrepToolUI,
    activity: ({ input }) =>
      typeof input.pattern === 'string'
        ? `Searching for ${input.pattern}`
        : 'Searching the codebase',
    detail: ({ input }) =>
      typeof input.pattern === 'string' ? preview(input.pattern, 30) : 'grep',
    status: ({ details }) => {
      if (!details) return 'Searching...'
      const matches = typeof details.numMatches === 'number' ? details.numMatches : 0
      const files = typeof details.numFiles === 'number' ? details.numFiles : 0
      return files > 0 ? `${matches} matches · ${files} files` : `${matches} matches`
    },
  },
})
