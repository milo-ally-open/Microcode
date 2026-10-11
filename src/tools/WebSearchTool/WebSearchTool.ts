import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type, type Static } from 'typebox'
import type { PermissionBehavior } from '../../permissions/types.ts'

export const TOOL_NAME = 'WebSearch'
export const TOOL_DEFAULT_PERMISSION: PermissionBehavior = 'allow'

const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/'
const DEFAULT_MAX_RESULTS = 8
const MAX_RESULTS = 20

const webSearchSchema = Type.Object({
  query: Type.String({ description: 'The search query to use' }),
  allowed_domains: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Only include search results from these domains',
    }),
  ),
  blocked_domains: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Never include search results from these domains',
    }),
  ),
  max_results: Type.Optional(
    Type.Number({
      description: `Maximum number of results to return. Default: ${DEFAULT_MAX_RESULTS}.`,
    }),
  ),
})

export type WebSearchToolInput = Static<typeof webSearchSchema>

export interface WebSearchResult {
  title: string
  url: string
  snippet?: string
}

export interface WebSearchToolDetails {
  query: string
  results: WebSearchResult[]
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
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    )
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeResultUrl(rawUrl: string): string | undefined {
  const decoded = decodeHtml(rawUrl)
  try {
    const url = new URL(decoded)
    const redirected = url.searchParams.get('uddg')
    if (redirected) return redirected
    return url.toString()
  } catch {
    // DuckDuckGo sometimes returns protocol-relative URLs like //duckduckgo.com/l/?uddg=...
    try {
      const url = new URL(`https:${decoded}`)
      const redirected = url.searchParams.get('uddg')
      if (redirected) return redirected
      return url.toString()
    } catch {
      return undefined
    }
  }
}

function hostMatches(hostname: string, domains: readonly string[]): boolean {
  const normalizedHost = hostname.toLowerCase()
  return domains.some((domain) => {
    const normalizedDomain = domain.toLowerCase().replace(/^https?:\/\//, '').split('/')[0]!
    return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`)
  })
}

function isResultAllowed(
  resultUrl: string,
  allowedDomains?: readonly string[],
  blockedDomains?: readonly string[],
): boolean {
  try {
    const hostname = new URL(resultUrl).hostname
    if (allowedDomains?.length && !hostMatches(hostname, allowedDomains)) return false
    if (blockedDomains?.length && hostMatches(hostname, blockedDomains)) return false
    return true
  } catch {
    return false
  }
}

function parseDuckDuckGoHtml(
  html: string,
  allowedDomains?: readonly string[],
  blockedDomains?: readonly string[],
): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const seen = new Set<string>()
  const resultOpenTags = [...html.matchAll(/<div[^>]*class="[^"]*result results_links[^"]*"[^>]*>/gi)]

  for (let i = 0; i < resultOpenTags.length; i++) {
    const startIdx = resultOpenTags[i]!.index
    const endIdx =
      i + 1 < resultOpenTags.length
        ? resultOpenTags[i + 1]!.index
        : html.indexOf('<div class="nav"', startIdx)
    const block = html.slice(startIdx, endIdx >= startIdx ? endIdx : startIdx + 3000)

    const linkMatch = block.match(
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    )
    if (!linkMatch) continue

    const url = normalizeResultUrl(linkMatch[1]!)
    if (!url || seen.has(url)) continue
    if (!isResultAllowed(url, allowedDomains, blockedDomains)) continue

    const snippetMatch = block.match(
      /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
    )

    seen.add(url)
    results.push({
      title: stripTags(linkMatch[2]!),
      url,
      snippet: snippetMatch ? stripTags(snippetMatch[1]!) : undefined,
    })
  }

  return results
}

function formatResults(query: string, results: readonly WebSearchResult[]): string {
  if (results.length === 0) {
    return `No web search results found for "${query}".`
  }

  const lines = [`Web search results for "${query}":`]
  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`)
    lines.push(`   ${result.url}`)
    if (result.snippet) lines.push(`   ${result.snippet}`)
  })
  lines.push('')
  lines.push('Use relevant URLs from these results as sources in your final response.')
  return lines.join('\n')
}

export function createWebSearchTool(): AgentTool<typeof webSearchSchema, WebSearchToolDetails> {
  return {
    name: TOOL_NAME,
    label: 'WebSearch',
    description:
      'Search the web for current information. Supports optional allowed_domains and blocked_domains filters. Include relevant result URLs as sources in the final response.',
    parameters: webSearchSchema,
    async execute(
      _toolCallId: string,
      params: WebSearchToolInput,
      signal?: AbortSignal,
      onUpdate?: (partial: AgentToolResult<WebSearchToolDetails>) => void,
    ): Promise<AgentToolResult<WebSearchToolDetails>> {
      const query = params.query.trim()
      if (!query) throw new Error('Missing search query.')
      if (params.allowed_domains?.length && params.blocked_domains?.length) {
        throw new Error('Cannot specify both allowed_domains and blocked_domains.')
      }

      const maxResults = Math.min(
        Math.max(1, Math.floor(params.max_results ?? DEFAULT_MAX_RESULTS)),
        MAX_RESULTS,
      )
      const startedAt = Date.now()

      onUpdate?.({
        content: [{ type: 'text', text: `Searching the web for "${query}"...` }],
        details: { query, results: [], durationMs: 0 },
      })

      const searchUrl = `${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}`
      const response = await fetch(searchUrl, {
        signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Microcode/0.1 WebSearch',
        },
      })
      if (!response.ok) {
        throw new Error(`Web search failed: ${response.status} ${response.statusText}`)
      }

      const html = await response.text()
      const results = parseDuckDuckGoHtml(
        html,
        params.allowed_domains,
        params.blocked_domains,
      ).slice(0, maxResults)
      const details = { query, results, durationMs: Date.now() - startedAt }

      return {
        content: [{ type: 'text', text: formatResults(query, results) }],
        details,
      }
    },
  }
}