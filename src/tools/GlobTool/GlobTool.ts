import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { type Static, Type } from 'typebox'
import type { PermissionBehavior } from '../../permissions/types.ts'
import { globSearch } from '../../utils/searchUtils.ts'

export const TOOL_NAME = 'glob'
export const TOOL_DEFAULT_PERMISSION: PermissionBehavior = 'allow'

const DEFAULT_LIMIT = 1000
const MAX_RESULT_SIZE_CHARS = 100_000

const globSchema = Type.Object({
  pattern: Type.String({
    description: 'Glob pattern to match files, e.g. "**/*.ts" or "src/**/*.spec.ts"',
  }),
  path: Type.Optional(
    Type.String({ description: 'Directory to search in (default: current working directory)' }),
  ),
})

export type GlobToolInput = Static<typeof globSchema>

export interface GlobToolDetails {
  numFiles: number
  filenames: string[]
  truncated: boolean
  durationMs: number
}

export function createGlobTool(cwd: string): AgentTool<typeof globSchema, GlobToolDetails> {
  return {
    name: TOOL_NAME,
    label: 'Glob',
    description:
      'Find files matching a glob pattern. Returns file paths sorted by modification time (newest first). Use this when you need to find files by name patterns.',
    parameters: globSchema,
    async execute(
      _toolCallId: string,
      params: GlobToolInput,
      signal?: AbortSignal,
      onUpdate?: (partial: AgentToolResult<GlobToolDetails>) => void,
    ): Promise<AgentToolResult<GlobToolDetails>> {
      const result = await globSearch(cwd, params.path, params.pattern, {
        maxResults: DEFAULT_LIMIT,
        signal,
      })

      if (result.files.length === 0) {
        const details: GlobToolDetails = {
          numFiles: 0,
          filenames: [],
          truncated: false,
          durationMs: result.durationMs,
        }
        return {
          content: [{ type: 'text', text: 'No files found matching pattern' }],
          details,
        }
      }

      let output = result.files.join('\n')
      const byteTruncated = output.length > MAX_RESULT_SIZE_CHARS
      if (byteTruncated) {
        output = output.slice(0, MAX_RESULT_SIZE_CHARS)
      }

      const notices: string[] = []
      if (result.truncated) notices.push(`${DEFAULT_LIMIT} results limit reached`)
      if (byteTruncated) notices.push(`${MAX_RESULT_SIZE_CHARS / 1000}KB output limit reached`)
      if (notices.length > 0) output += `\n\n[Truncated: ${notices.join(', ')}]`

      const details: GlobToolDetails = {
        numFiles: result.files.length,
        filenames: result.files,
        truncated: result.truncated || byteTruncated,
        durationMs: result.durationMs,
      }

      if (onUpdate) {
        onUpdate({ content: [{ type: 'text', text: output }], details })
      }

      return { content: [{ type: 'text', text: output }], details }
    },
  }
}
