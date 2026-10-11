import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type, type Static } from 'typebox'
import { isAbsolute, resolve } from 'path'
import type { PermissionBehavior } from '../../permissions/types.ts'
import { isImageFilePath, readImageToBase64 } from '../../utils/imageUtils.ts'

export const TOOL_NAME = 'vision'
export const TOOL_DEFAULT_PERMISSION: PermissionBehavior = 'allow'

const VisionToolSchema = Type.Object({
  image_source: Type.String({
    description:
      'URL (http/https) or local file path of the image to load. Supports PNG, JPEG, GIF, WebP, BMP. IMPORTANT: do NOT pass "[Image: ...]" placeholder names here — those images are already attached to the conversation and visible to you directly.',
  }),
  prompt: Type.String({
    description:
      'What you want to know about the image. Be specific about what details to extract, analyze, or describe.',
  }),
})

export type VisionToolInput = Static<typeof VisionToolSchema>

export interface VisionToolDetails {
  source: string
  mimeType: string
  sourceType: 'url' | 'file'
}

export function createVisionTool(cwd: string): AgentTool<typeof VisionToolSchema, VisionToolDetails> {
  return {
    name: TOOL_NAME,
    label: 'Process Image',
    description:
      'Load an image from a URL or local file path into the conversation. Use this to fetch images the user references by URL or disk path. Do NOT use for [Image: ...] placeholders — those images are already attached and visible.',
    parameters: VisionToolSchema,
    async execute(
      _toolCallId: string,
      params: VisionToolInput,
      _signal?: AbortSignal,
      onUpdate?: (partial: AgentToolResult<VisionToolDetails>) => void,
    ): Promise<AgentToolResult<VisionToolDetails>> {
      const { image_source, prompt } = params
      const sourceType: 'url' | 'file' = (image_source.startsWith('http://') || image_source.startsWith('https://')) ? 'url' : 'file'

      onUpdate?.({
        content: [{ type: 'text', text: `Analyzing ${image_source}...` }],
        details: { source: image_source, sourceType, mimeType: '...' },
      })
      let base64Data: string
      let mimeType: string

      if (sourceType === 'url') {
        try {
          const response = await fetch(image_source)
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`)
          }
          const contentType = response.headers.get('content-type') ?? 'image/png'
          const arrayBuffer = await response.arrayBuffer()
          base64Data = Buffer.from(arrayBuffer).toString('base64')
          mimeType = contentType.split(';')[0]!.trim()
        } catch (err) {
          throw new Error(
            `Failed to fetch image from URL: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      } else {
        const resolvedPath = isAbsolute(image_source)
          ? image_source
          : resolve(cwd, image_source)

        if (!isImageFilePath(resolvedPath)) {
          throw new Error(
            `File does not exist or is not a supported image format: ${resolvedPath}`,
          )
        }

        try {
          const result = readImageToBase64(resolvedPath)
          base64Data = result.data
          mimeType = result.mimeType
        } catch (err) {
          throw new Error(
            `Failed to read image file: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: `Image from ${sourceType}: ${image_source}\n\nUser prompt: ${prompt}`,
          },
          { type: 'image', data: base64Data, mimeType },
        ] as any[],
        details: {
          source: image_source,
          mimeType,
          sourceType,
        },
      }
    },
  }
}
