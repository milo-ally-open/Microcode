import { registerTool } from '../registry.ts'
import { TOOL_SEARCH_TOOL_NAME } from './ToolSearchTool.ts'
import { joinSummaryParts, statusPrefix } from '../summary.ts'

// ToolSearchTool is instantiated separately with discovery callbacks in agent.ts.
registerTool({
  name: TOOL_SEARCH_TOOL_NAME,
  policy: { defaultPermission: 'allow' },
  agent: {
    create: () => {
      throw new Error('ToolSearchTool must be created via createToolSearchTool() in agent.ts')
    },
    description: 'Discover and load deferred tools by name or keyword',
    shouldDefer: false,
    summarizeResult: (context) => {
      const details = context.details ?? {}
      const query = typeof details.query === 'string' ? `query="${details.query}"` : undefined
      const matches = Array.isArray(details.matches) ? details.matches : []
      return `[tool_search] ${statusPrefix(context)}${joinSummaryParts([
        query,
        `${matches.length} matches`,
        matches.length > 0 ? `tools: ${matches.slice(0, 8).join(', ')}${matches.length > 8 ? ', ...' : ''}` : undefined,
      ])}`
    },
    formatDescription: (input) => typeof input.query === 'string' ? `search: ${input.query}` : '(tool search)',
    extractMatchContent: (input) => typeof input.query === 'string' ? input.query : undefined,
  },
  presentation: {},
})
