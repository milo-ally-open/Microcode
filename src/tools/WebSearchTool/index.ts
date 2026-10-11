import { registerTool } from '../registry.ts'
import { createWebSearchTool, TOOL_DEFAULT_PERMISSION, TOOL_NAME } from './WebSearchTool.ts'
import { WebSearchToolUI } from './UI.tsx'
import { preview } from '../../utils/displayUtils.ts'
import { joinSummaryParts, statusPrefix } from '../summary.ts'

registerTool({
  name: TOOL_NAME,
  policy: { defaultPermission: TOOL_DEFAULT_PERMISSION },
  agent: {
    create: () => createWebSearchTool(),
    description: 'Search the web for current information. Supports domain allow/block filters and returns source URLs.',
    shouldDefer: false,
    formatDescription: (input) => typeof input.query === 'string' ? `search "${input.query}"` : 'search web',
    extractMatchContent: (input) => typeof input.query === 'string' ? input.query : undefined,
    summarizeResult: (context) => {
      const details = context.details ?? {}
      const query = typeof details.query === 'string' ? `query="${details.query}"` : undefined
      const results = Array.isArray(details.results) ? details.results : []
      const top = results.length > 0
        ? `top: ${results.slice(0, 3).map((item: any) => item.title || item.url).filter(Boolean).join('; ')}`
        : undefined
      return `[WebSearch] ${statusPrefix(context)}${joinSummaryParts([query, `${results.length} results`, top])}`
    },
  },
  presentation: {
    View: WebSearchToolUI,
    activity: ({ input }) =>
      typeof input.query === 'string'
        ? `Searching ${input.query}`
        : 'Searching the web',
    detail: ({ input }) =>
      typeof input.query === 'string' ? preview(input.query, 42) : 'web search',
    status: ({ details }) => {
      if (!details) return 'Searching...'
      const results = Array.isArray(details.results) ? details.results.length : undefined
      return results !== undefined && results > 0 ? `${results} results` : undefined
    },
  },
})
