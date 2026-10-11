import { registerTool } from '../registry.ts'
import { createVisionTool, TOOL_NAME, TOOL_DEFAULT_PERMISSION } from './VisionTool.ts'
import { VisionToolUI } from './UI.tsx'
import { joinSummaryParts, statusPrefix, text } from '../summary.ts'

registerTool({
  name: TOOL_NAME,
  policy: { defaultPermission: TOOL_DEFAULT_PERMISSION },
  agent: {
    create: (cwd: string) => createVisionTool(cwd),
    description:
      'Load an image from a URL or local file path into the conversation. Use for fetching images the user references by URL or disk path. Do NOT use for [Image: ...] placeholders — those images are already attached and visible.',
    formatDescription: (input) => {
      const src = typeof input.image_source === 'string' ? input.image_source : '(unknown source)'
      const prompt = typeof input.prompt === 'string' ? ` "${input.prompt.slice(0, 40)}"` : ''
      return `vision ${src}${prompt}`
    },
    extractMatchContent: (input) => typeof input.image_source === 'string' ? input.image_source : undefined,
    shouldDefer: false,
    summarizeResult: (context) => {
      const details = context.details ?? {}
      return `[vision] ${statusPrefix(context)}${joinSummaryParts([
        text(details.source), text(details.sourceType), text(details.mimeType),
      ])}`
    },
  },
  presentation: {
    View: VisionToolUI,
    activity: () => 'Analyzing image',
    status: () => 'Analyzing image...',
  },
})
