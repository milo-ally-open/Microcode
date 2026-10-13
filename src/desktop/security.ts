import { PERMISSION_MODES } from '../permissions/types.ts'

export type RendererIpcMethod =
  | 'bootstrap'
  | 'retryBackend'
  | 'chooseWorkspace'
  | 'openRecentProject'
  | 'getSnapshot'
  | 'listSessions'
  | 'startNewSession'
  | 'selectSession'
  | 'sendPrompt'
  | 'cancelPrompt'
  | 'respondToPermission'
  | 'setPermissionMode'
  | 'listModels'
  | 'switchModel'
  | 'getSettingsSnapshot'
  | 'loginProvider'
  | 'logoutProvider'
  | 'cancelProviderLogin'
  | 'setMcpEnabled'
  | 'setPluginEnabled'
  | 'setSkillLoaded'
  | 'reviewStatus'
  | 'readDiff'
  | 'createTerminal'
  | 'writeTerminal'
  | 'resizeTerminal'
  | 'closeTerminal'
  | 'chooseImages'

export class DesktopRequestError extends Error {
  constructor(readonly code: 'invalid_request' | 'workspace_unavailable' | 'backend_unavailable', message: string) {
    super(message)
    this.name = 'DesktopRequestError'
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function boundedString(value: unknown, maximum: number, nonEmpty = true): value is string {
  return typeof value === 'string' && value.length <= maximum && (!nonEmpty || value.trim().length > 0)
}

function safeAnswers(value: unknown): boolean {
  const answers = record(value)
  return answers !== null
    && Object.keys(answers).length <= 32
    && Object.entries(answers).every(([key, answer]) => boundedString(key, 160) && typeof answer === 'string' && answer.length <= 4000)
}

/** Rejects unknown renderer operations and validates each public IPC payload. */
export function validateRendererIpc(method: RendererIpcMethod, payload?: unknown): void {
  const value = payload === undefined ? {} : record(payload)
  if (!value) throw new DesktopRequestError('invalid_request', 'Request payload must be an object.')

  switch (method) {
    case 'bootstrap':
    case 'retryBackend':
    case 'chooseWorkspace':
    case 'getSnapshot':
    case 'listSessions':
    case 'startNewSession':
    case 'cancelPrompt':
    case 'listModels':
    case 'getSettingsSnapshot':
    case 'cancelProviderLogin':
    case 'reviewStatus':
    case 'chooseImages':
      if (Object.keys(value).length !== 0) throw new DesktopRequestError('invalid_request', 'This operation does not accept a payload.')
      return
    case 'createTerminal':
      if (!exactKeys(value, ['cols', 'rows']) || !boundedInteger(value.cols, 1, 300) || !boundedInteger(value.rows, 1, 100)) break
      return
    case 'writeTerminal':
      if (!exactKeys(value, ['terminalId', 'data']) || !boundedString(value.terminalId, 128) || !boundedString(value.data, 64 * 1024, false)) break
      return
    case 'resizeTerminal':
      if (!exactKeys(value, ['terminalId', 'cols', 'rows']) || !boundedString(value.terminalId, 128)
        || !boundedInteger(value.cols, 1, 300) || !boundedInteger(value.rows, 1, 100)) break
      return
    case 'closeTerminal':
      if (!exactKeys(value, ['terminalId']) || !boundedString(value.terminalId, 128)) break
      return
    case 'openRecentProject':
      if (!exactKeys(value, ['projectId']) || !boundedString(value.projectId, 100)) break
      return
    case 'selectSession':
      if (!exactKeys(value, ['sessionId']) || !boundedString(value.sessionId, 128)) break
      return
    case 'sendPrompt':
      if (!exactKeys(value, ['prompt', 'images']) || !boundedString(value.prompt, 120_000)) break
      if (value.images !== undefined && (!Array.isArray(value.images) || value.images.length > 4 || value.images.some((entry) => {
        const image = record(entry)
        return !image || !exactKeys(image, ['type', 'mimeType', 'data']) || image.type !== 'image'
          || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(String(image.mimeType))
          || typeof image.data !== 'string' || image.data.length > 12 * 1024 * 1024
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)
      }))) break
      return
    case 'respondToPermission':
      if (!exactKeys(value, ['requestId', 'decision', 'answers', 'block'])
        || !boundedString(value.requestId, 128)
        || !['allow', 'allow_session', 'deny'].includes(String(value.decision))
        || (value.answers !== undefined && !safeAnswers(value.answers))
        || (value.block !== undefined && typeof value.block !== 'boolean')) break
      return
    case 'setPermissionMode':
      if (!exactKeys(value, ['mode']) || !PERMISSION_MODES.includes(value.mode as (typeof PERMISSION_MODES)[number])) break
      return
    case 'switchModel':
      if (!exactKeys(value, ['id', 'provider', 'api'])
        || !boundedString(value.id, 160)
        || !boundedString(value.provider, 120)
        || !boundedString(value.api, 120)) break
      return
    case 'loginProvider':
      if (!exactKeys(value, ['providerId', 'authType']) || !boundedString(value.providerId, 120)
        || !['oauth', 'api_key'].includes(String(value.authType))) break
      return
    case 'logoutProvider':
      if (!exactKeys(value, ['providerId']) || !boundedString(value.providerId, 120)) break
      return
    case 'setMcpEnabled':
      if (!exactKeys(value, ['name', 'enabled', 'confirmed']) || !boundedString(value.name, 120)
        || typeof value.enabled !== 'boolean' || (value.confirmed !== undefined && typeof value.confirmed !== 'boolean')) break
      return
    case 'setPluginEnabled':
      if (!exactKeys(value, ['scope', 'name', 'enabled', 'confirmed']) || !['user', 'project'].includes(String(value.scope))
        || !boundedString(value.name, 128) || typeof value.enabled !== 'boolean'
        || (value.confirmed !== undefined && typeof value.confirmed !== 'boolean')) break
      return
    case 'setSkillLoaded':
      if (!exactKeys(value, ['name', 'loaded']) || !boundedString(value.name, 160) || typeof value.loaded !== 'boolean') break
      return
    case 'readDiff':
      if (!exactKeys(value, ['path']) || !boundedString(value.path, 4096) || value.path.includes('\0')) break
      return
  }
  throw new DesktopRequestError('invalid_request', `Invalid payload for ${method}.`)
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

const SENSITIVE_KEY = /(?:api.?key|access.?token|refresh.?token|secret|password|authorization|cookie|private.?key|credential)/i
const SECRET_TEXT = /\b(?:Bearer\s+)[A-Za-z0-9._~+/-]+=*|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi
const ASSIGNMENT_SECRET = /((?:api.?key|access.?token|refresh.?token|secret|password|authorization|cookie|private.?key|credential)\s*[:=]\s*)([^\s,;]+)/gi

export function redactDisplayText(value: string): string {
  return value
    .replace(SECRET_TEXT, '[redacted]')
    .replace(ASSIGNMENT_SECRET, '$1[redacted]')
}

export function redactDisplayValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[nested value hidden]'
  if (typeof value === 'string') return redactDisplayText(value)
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactDisplayValue(item, depth + 1))
  const object = record(value)
  if (!object) return value
  return Object.fromEntries(Object.entries(object).slice(0, 100).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? '[redacted]' : redactDisplayValue(item, depth + 1),
  ]))
}

export function isLikelySecretFile(path: string): boolean {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  return name === '.env'
    || name.startsWith('.env.')
    || /(?:^|[._-])(secret|credential|private-key)(?:[._-]|$)/i.test(name)
    || /\.(?:pem|p12|pfx|key)$/i.test(name)
}
