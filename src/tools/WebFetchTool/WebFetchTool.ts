import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type, type Static } from 'typebox'
import type { PermissionBehavior } from '../../permissions/types.ts'

export const TOOL_NAME = 'WebFetch'
export const TOOL_DEFAULT_PERMISSION: PermissionBehavior = 'allow'

const MAX_BYTES = 10 * 1024 * 1024
const MAX_OUTPUT_CHARS = 100_000

const webFetchSchema = Type.Object({
  url: Type.String({ description: 'The fully-formed URL to fetch content from' }),
  prompt: Type.String({
    description: 'What information to extract or analyze from the fetched content',
  }),
})

export type WebFetchToolInput = Static<typeof webFetchSchema>

export interface WebFetchToolDetails {
  url: string
  finalUrl: string
  bytes: number
  code: number
  codeText: string
  contentType: string
  truncated: boolean
  durationMs: number
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    )
}

function htmlToText(html: string): string {
  const withoutHidden = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')

  const withBreaks = withoutHidden
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|section|article|header|footer|main|aside|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '- ')
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href, text) => {
      const label = decodeHtml(String(text).replace(/<[^>]+>/g, ' ')).trim()
      const url = decodeHtml(String(href)).trim()
      return label && url ? `${label} (${url})` : label || url
    })

  return decodeHtml(withBreaks.replace(/<[^>]+>/g, ' '))
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  const parsed = new URL(trimmed)
  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are not supported.')
  }
  if (parsed.protocol === 'http:') {
    parsed.protocol = 'https:'
    return parsed.toString()
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS URLs are supported.')
  }
  return parsed.toString()
}

function buildOutput(
  inputUrl: string,
  finalUrl: string,
  prompt: string,
  content: string,
  truncated: boolean,
): string {
  const sections = [
    `Fetched URL: ${inputUrl}`,
    finalUrl !== inputUrl ? `Final URL: ${finalUrl}` : undefined,
    `Prompt: ${prompt}`,
    '',
    'Content:',
    content,
    truncated
      ? `\n[Content truncated to ${MAX_OUTPUT_CHARS.toLocaleString()} characters.]`
      : undefined,
  ]
  return sections.filter((section): section is string => section !== undefined).join('\n')
}

export function createWebFetchTool(): AgentTool<typeof webFetchSchema, WebFetchToolDetails> {
  return {
    name: TOOL_NAME,
    label: 'WebFetch',
    description:
      'Fetch a URL and return readable page content for analysis. Use for public web pages; authenticated or private URLs may fail.',
    parameters: webFetchSchema,
    async execute(
      _toolCallId: string,
      params: WebFetchToolInput,
      signal?: AbortSignal,
      onUpdate?: (partial: AgentToolResult<WebFetchToolDetails>) => void,
    ): Promise<AgentToolResult<WebFetchToolDetails>> {
      const startedAt = Date.now()
      const url = normalizeUrl(params.url)

      onUpdate?.({
        content: [{ type: 'text', text: `Fetching ${url}...` }],
        details: {
          url,
          finalUrl: url,
          bytes: 0,
          code: 0,
          codeText: '',
          contentType: '',
          truncated: false,
          durationMs: 0,
        },
      })

      const response = await fetch(url, {
        signal,
        redirect: 'follow',
        headers: {
          Accept: 'text/markdown,text/html,text/plain,*/*',
          'User-Agent': 'Microcode/0.1 WebFetch',
        },
      })

      const contentType = response.headers.get('content-type') ?? ''
      const contentLength = Number(response.headers.get('content-length') ?? '0')
      if (contentLength > MAX_BYTES) {
        throw new Error(`Response is too large to fetch (${contentLength} bytes).`)
      }

      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > MAX_BYTES) {
        throw new Error(`Response is too large to fetch (${buffer.byteLength} bytes).`)
      }

      const raw = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
      const readable = contentType.includes('html') ? htmlToText(raw) : raw
      const truncated = readable.length > MAX_OUTPUT_CHARS
      const content = truncated ? readable.slice(0, MAX_OUTPUT_CHARS) : readable

      const details: WebFetchToolDetails = {
        url,
        finalUrl: response.url || url,
        bytes: buffer.byteLength,
        code: response.status,
        codeText: response.statusText,
        contentType,
        truncated,
        durationMs: Date.now() - startedAt,
      }

      if (!response.ok) {
        throw new Error(`Web fetch failed: ${response.status} ${response.statusText}`)
      }

      return {
        content: [
          {
            type: 'text',
            text: buildOutput(url, response.url || url, params.prompt, content, truncated),
          },
        ],
        details,
      }
    },
  }
}
