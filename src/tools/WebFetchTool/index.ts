import { registerTool } from '../registry.ts'
import { createWebFetchTool, TOOL_DEFAULT_PERMISSION, TOOL_NAME } from './WebFetchTool.ts'
import { WebFetchToolUI } from './UI.tsx'
import { formatBytes, shortUrl } from '../../utils/displayUtils.ts'
import { boolTag, count, joinSummaryParts, statusPrefix, text } from '../summary.ts'

registerTool({
  name: TOOL_NAME,
  policy: { defaultPermission: TOOL_DEFAULT_PERMISSION },
  agent: {
    create: () => createWebFetchTool(),
    description: 'Fetch a public URL and return readable page content for analysis. Authenticated or private URLs may fail.',
    shouldDefer: false,
    formatDescription: (input) => typeof input.url === 'string' ? `web fetch ${input.url}` : 'web fetch',
    extractMatchContent: (input) => typeof input.url === 'string' ? input.url : undefined,
    summarizeResult: (context) => {
      const details = context.details ?? {}
      const status = typeof details.code === 'number'
        ? `HTTP ${details.code}${typeof details.codeText === 'string' && details.codeText ? ` ${details.codeText}` : ''}`
        : undefined
      return `[WebFetch] ${statusPrefix(context)}${joinSummaryParts([
        text(details.finalUrl) ?? text(details.url), status, count(details.bytes, 'bytes'),
        text(details.contentType), boolTag(details.truncated, 'truncated'),
      ])}`
    },
  },
  presentation: {
    View: WebFetchToolUI,
    activity: ({ input }) =>
      typeof input.url === 'string'
        ? `Fetching ${shortUrl(input.url)}`
        : 'Fetching a web page',
    detail: ({ input }) =>
      typeof input.url === 'string' ? shortUrl(input.url) : 'web fetch',
    status: ({ details }) => {
      if (!details) return 'Fetching...'
      const bytes = typeof details.bytes === 'number' ? details.bytes : 0
      const code = typeof details.code === 'number' && details.code > 0 ? String(details.code) : undefined
      const size = bytes > 0 ? formatBytes(bytes) : undefined
      return [code, size].filter(Boolean).join(' · ') || undefined
    },
  },
})
