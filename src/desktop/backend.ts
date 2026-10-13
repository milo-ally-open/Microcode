import { createInterface } from 'node:readline'
import { stdin, stdout } from 'node:process'
import { DesktopBackend } from './DesktopBackend.ts'
import type { ProviderAuthPrompt } from './authPrompt.ts'
import { DESKTOP_TRANSPORT_PROTOCOL_VERSION } from './protocol.ts'
import { DesktopRequestError, redactDisplayText } from './security.ts'
import { DESKTOP_APP_VERSION } from './buildInfo.ts'
import { RUNTIME_PROTOCOL_VERSION } from '../runtime/protocol.ts'

const FRAME_PREFIX = '@@MICROCODE_DESKTOP@@'
const MAX_REQUEST_BYTES = 24 * 1024 * 1024
const smokeTest = process.env.MICROCODE_DESKTOP_SMOKE_TEST === '1'
const smokeAuthPrompt: ProviderAuthPrompt = async (prompt, signal) => {
  if (prompt.type === 'select') {
    const browser = prompt.options.find((option) => option.id === 'browser')
    if (!browser) throw new Error('OpenAI Codex did not offer browser sign-in.')
    return browser.id
  }
  if (prompt.type === 'manual_code') {
    return new Promise<string>((_resolve, reject) => {
      const cancel = () => {
        signal.removeEventListener('abort', cancel)
        reject(new Error('Authentication cancelled.'))
      }
      if (signal.aborted) cancel()
      else signal.addEventListener('abort', cancel, { once: true })
    })
  }
  throw new Error('Unexpected credential prompt in the OAuth startup smoke test.')
}
const smokeOpenAuthUrl = async (value: string): Promise<void> => {
  const url = new URL(value)
  if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/oauth/authorize') {
    throw new Error('OpenAI Codex returned an unexpected authorization URL.')
  }
}
const backend = smokeTest
  ? new DesktopBackend(undefined, undefined, undefined, smokeAuthPrompt, smokeOpenAuthUrl)
  : new DesktopBackend()
const activeRequests = new Set<string>()

function writeFrame(value: unknown): void {
  stdout.write(`${FRAME_PREFIX}${JSON.stringify({ ...(value as Record<string, unknown>), protocolVersion: DESKTOP_TRANSPORT_PROTOCOL_VERSION })}\n`)
}

backend.subscribe((event) => writeFrame({ kind: 'event', event }))
writeFrame({ kind: 'event', event: {
  type: 'backend.status',
  status: 'ready',
  appVersion: DESKTOP_APP_VERSION,
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
} })

const input = createInterface({ input: stdin, crlfDelay: Infinity })
for await (const line of input) {
  if (Buffer.byteLength(line, 'utf8') > MAX_REQUEST_BYTES) {
    writeFrame({ kind: 'response', id: 'invalid', ok: false, error: { code: 'invalid_request', message: 'Request exceeded the desktop transport size limit.' } })
    continue
  }

  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    writeFrame({ kind: 'response', id: 'invalid', ok: false, error: { code: 'invalid_request', message: 'Desktop transport received malformed JSON.' } })
    continue
  }
  const request = message !== null && typeof message === 'object' && !Array.isArray(message)
    ? message as Record<string, unknown>
    : null
  const id = typeof request?.id === 'string' && request.id.length <= 128 ? request.id : 'invalid'
  if (request?.protocolVersion !== DESKTOP_TRANSPORT_PROTOCOL_VERSION) {
    writeFrame({ kind: 'response', id, ok: false, error: { code: 'protocol_version_mismatch', message: 'Desktop transport protocol version is incompatible.' } })
    continue
  }
  if (request?.kind !== 'request' || typeof request.method !== 'string' || id === 'invalid') {
    writeFrame({ kind: 'response', id, ok: false, error: { code: 'invalid_request', message: 'Desktop transport request shape is invalid.' } })
    continue
  }
  if (activeRequests.has(id)) {
    writeFrame({ kind: 'response', id, ok: false, error: { code: 'invalid_request', message: 'Duplicate desktop request ID.' } })
    continue
  }

  activeRequests.add(id)
  void backend.handle(request.method, request.payload).then(
    (result) => writeFrame({ kind: 'response', id, ok: true, result }),
    (error: unknown) => writeFrame({
      kind: 'response',
      id,
      ok: false,
      error: {
        code: error instanceof DesktopRequestError ? error.code : 'command_failed',
        message: redactDisplayText(error instanceof Error ? error.message : String(error)),
      },
    }),
  ).finally(() => activeRequests.delete(id))
}

await backend.close().catch(() => undefined)
