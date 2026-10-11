/**
 * Custom model loader — reads user-defined models from the Microcode config.
 *
 * Two locations (merged, project overrides user):
 *   ~/.microcode/config.json   (user-level)
 *   .microcode/config.json     (project-level)
 *
 * Format:
 *   { "models": [{ id, name, api, baseUrl, apiKeyEnv?, reasoning?, thinkingFormat?, ... }] }
 */

import { type Api, type Model } from '@earendil-works/pi-ai'
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ============================================================================
// Config file types
// ============================================================================

export interface CustomModelDef {
  id: string
  name: string
  api: Api
  baseUrl: string
  /** Env var name that holds the API key for this model. Falls back to protocol defaults. */
  apiKeyEnv?: string
  reasoning?: boolean
  /** Thinking parameter format. Maps to compat.thinkingFormat. */
  thinkingFormat?: 'openai' | 'openrouter' | 'deepseek' | 'together' | 'zai' | 'qwen' | 'qwen-chat-template'
  input?: ('text' | 'image')[]
  contextWindow: number
  maxTokens: number
  headers?: Record<string, string>
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

export interface CustomModelsConfig {
  models: CustomModelDef[]
}

// ============================================================================
// File paths
// ============================================================================

function userConfigPath(): string {
  return join(homedir(), '.microcode', 'config.json')
}

function projectConfigPath(cwd: string): string {
  return join(cwd, '.microcode', 'config.json')
}

// ============================================================================
// Load & parse
// ============================================================================

function readJsonFile(path: string): unknown | null {
  try {
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function parseModelsConfig(data: unknown): CustomModelDef[] {
  if (!data || typeof data !== 'object') return []
  const obj = data as Record<string, unknown>
  if (!Array.isArray(obj.models)) return []
  return obj.models.filter(
    (m: unknown): m is CustomModelDef =>
      typeof m === 'object' && m !== null &&
      typeof (m as any).id === 'string' &&
      typeof (m as any).name === 'string' &&
      typeof (m as any).api === 'string' &&
      typeof (m as any).baseUrl === 'string' &&
      typeof (m as any).contextWindow === 'number' &&
      typeof (m as any).maxTokens === 'number',
  )
}

/**
 * Load custom models from both config files.
 * Project-level models with the same ID override user-level ones.
 */
export function loadCustomModels(cwd?: string): CustomModelDef[] {
  const userModels = parseModelsConfig(readJsonFile(userConfigPath()))
  const projectModels = parseModelsConfig(readJsonFile(projectConfigPath(cwd ?? process.cwd())))

  // Merge: project overrides user by ID
  const merged = new Map<string, CustomModelDef>()
  for (const m of userModels) merged.set(m.id, m)
  for (const m of projectModels) merged.set(m.id, m)

  return [...merged.values()]
}

// ============================================================================
// Convert to Model<Api>
// ============================================================================

function buildCompat(def: CustomModelDef): Model<Api>['compat'] {
  if (def.api === 'openai-completions') {
    const compat: any = {}
    if (def.thinkingFormat) {
      compat.thinkingFormat = def.thinkingFormat
    }
    if (def.thinkingFormat === 'deepseek') {
      compat.requiresReasoningContentOnAssistantMessages = true
    }
    return Object.keys(compat).length > 0 ? compat : undefined
  }
  return undefined
}

export function customModelToModel(def: CustomModelDef, provider = 'custom'): Model<Api> {
  return {
    id: def.id,
    name: def.name,
    api: def.api,
    provider,
    ...(def.apiKeyEnv ? { apiKeyEnv: def.apiKeyEnv } : {}),
    baseUrl: def.baseUrl,
    reasoning: def.reasoning ?? false,
    input: def.input ?? ['text'],
    contextWindow: def.contextWindow,
    maxTokens: def.maxTokens,
    headers: def.headers,
    cost: def.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: buildCompat(def),
  }
}
