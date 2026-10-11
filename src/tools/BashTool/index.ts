import { registerTool } from '../registry.ts'
import { createBashTool, TOOL_NAME, TOOL_DEFAULT_PERMISSION } from './BashTool.ts'
import { BashToolUI } from './UI.tsx'
import { preview } from '../../utils/displayUtils.ts'
import { joinSummaryParts, producedText, statusPrefix } from '../summary.ts'

registerTool({
  name: TOOL_NAME,
  policy: { defaultPermission: TOOL_DEFAULT_PERMISSION },
  agent: {
    create: createBashTool,
    formatDescription: (input) => typeof input.command === 'string' ? input.command : '(unknown command)',
    extractMatchContent: (input) => typeof input.command === 'string' ? input.command : undefined,
    summarizeResult: (context) => {
      const details = context.details ?? {}
      const exitCode = details.exitCode === null || typeof details.exitCode === 'number'
        ? `exit=${details.exitCode}`
        : undefined
      return `[bash] ${statusPrefix(context)}${joinSummaryParts([exitCode, producedText(context)])}`
    },
  },
  presentation: {
    View: BashToolUI,
    activity: () => 'Running a command',
    detail: ({ input }) => {
      const command = typeof input.command === 'string' ? input.command : ''
      return preview(command, 40) || 'bash'
    },
    status: ({ details }) => {
      if (!details) return 'Running...'
      const stdout = typeof details.stdout === 'string' ? details.stdout : ''
      const stderr = typeof details.stderr === 'string' ? details.stderr : ''
      const lines = (stdout + stderr).split('\n').filter((line) => line.length > 0).length
      return lines > 0 ? `${lines} lines` : undefined
    },
  },
})
