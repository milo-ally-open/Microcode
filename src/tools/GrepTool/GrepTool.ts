import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { type Static, Type } from 'typebox'
import type { PermissionBehavior } from '../../permissions/types.ts'
import { grepSearch } from '../../utils/searchUtils.ts'

export const TOOL_NAME = 'grep'
export const TOOL_DEFAULT_PERMISSION: PermissionBehavior = 'allow'

const grepSchema = Type.Object({
  pattern: Type.String({ description: 'The regular expression pattern to search for in file contents' }),
  path: Type.Optional(
    Type.String({
      description: 'File or directory to search in. Defaults to current working directory.',
    }),
  ),
  glob: Type.Optional(
    Type.String({ description: 'Glob pattern to filter files, e.g. "*.ts" or "*.{js,ts}".' }),
  ),
  output_mode: Type.Optional(
    Type.Union(
      [
        Type.Literal('content', { description: 'Show matching lines (supports context, -A, -B, -C)' }),
        Type.Literal('files_with_matches', { description: 'Show file paths only' }),
        Type.Literal('count', { description: 'Show match counts per file' }),
      ],
      { description: 'Output mode. Default: "content".' },
    ),
  ),
  '-A': Type.Optional(Type.Number({ description: 'Lines to show after each match. Requires output_mode: "content".' })),
  '-B': Type.Optional(Type.Number({ description: 'Lines to show before each match. Requires output_mode: "content".' })),
  '-C': Type.Optional(
    Type.Number({ description: 'Lines to show before and after each match. Requires output_mode: "content".' }),
  ),
  context: Type.Optional(
    Type.Number({
      description:
        'Lines to show before and after each match (equivalent to -C). Requires output_mode: "content".',
    }),
  ),
  '-n': Type.Optional(
    Type.Boolean({ description: 'Show line numbers in output. Default: true. Requires output_mode: "content".' }),
  ),
  '-i': Type.Optional(Type.Boolean({ description: 'Case insensitive search' })),
  type: Type.Optional(
    Type.String({ description: 'File type to search. Common types: js, ts, py, rust, go, java, etc.' }),
  ),
  head_limit: Type.Optional(
    Type.Number({ description: 'Limit output to first N entries. Default: 250. Pass 0 for unlimited.' }),
  ),
  offset: Type.Optional(Type.Number({ description: 'Skip first N entries before applying head_limit. Default: 0.' })),
  multiline: Type.Optional(
    Type.Boolean({ description: 'Enable multiline mode where . matches newlines. Default: false.' }),
  ),
})

export type GrepToolInput = Static<typeof grepSchema>

export interface GrepToolDetails {
  mode: 'content' | 'files_with_matches' | 'count'
  numFiles: number
  filenames: string[]
  numLines?: number
  numMatches?: number
  appliedLimit?: number
  appliedOffset?: number
  truncated: boolean
}

export function createGrepTool(cwd: string): AgentTool<typeof grepSchema, GrepToolDetails> {
  return {
    name: TOOL_NAME,
    label: 'Grep',
    description:
      'Search file contents for a regex pattern. Supports full regex syntax, output modes (content/files_with_matches/count), file type filtering, context lines, and pagination.',
    parameters: grepSchema,
    async execute(
      _toolCallId: string,
      params: GrepToolInput,
      signal?: AbortSignal,
      onUpdate?: (partial: AgentToolResult<GrepToolDetails>) => void,
    ): Promise<AgentToolResult<GrepToolDetails>> {
      const outputMode = params.output_mode || 'content'
      const contextC = params['-C'] ?? params.context

      const result = await grepSearch(cwd, params.path, params.pattern, {
        outputMode,
        glob: params.glob,
        type: params.type,
        caseInsensitive: params['-i'],
        multiline: params.multiline,
        contextBefore: contextC ? undefined : params['-B'],
        contextAfter: contextC ? undefined : params['-A'],
        contextAround: contextC,
        showLineNumbers: params['-n'],
        headLimit: params.head_limit,
        offset: params.offset,
        signal,
      })

      const details: GrepToolDetails = {
        mode: outputMode,
        numFiles: result.numFiles,
        filenames: result.filenames,
        numLines: result.numLines,
        numMatches: result.numMatches,
        appliedLimit: result.appliedLimit,
        appliedOffset: result.appliedOffset,
        truncated: result.truncated,
      }

      if (onUpdate) {
        onUpdate({ content: [{ type: 'text', text: result.output }], details })
      }

      return { content: [{ type: 'text', text: result.output }], details }
    },
  }
}
