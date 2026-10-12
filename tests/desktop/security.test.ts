import { describe, expect, test } from 'bun:test'
import { isLikelySecretFile, redactDisplayText, redactDisplayValue, validateRendererIpc } from '../../src/desktop/security.ts'

describe('desktop renderer boundary', () => {
  test('accepts only bounded, explicitly shaped renderer requests', () => {
    expect(() => validateRendererIpc('sendPrompt', { prompt: 'Summarize this file.' })).not.toThrow()
    expect(() => validateRendererIpc('sendPrompt', {
      prompt: 'Describe this image.',
      images: [{ type: 'image', mimeType: 'image/png', data: 'aGk=' }],
    })).not.toThrow()
    expect(() => validateRendererIpc('sendPrompt', { prompt: 'Hello', runShell: true })).toThrow()
    expect(() => validateRendererIpc('readDiff', { path: '../outside.txt' })).not.toThrow()
    expect(() => validateRendererIpc('respondToPermission', { requestId: 'x', decision: 'run', command: 'whoami' })).toThrow()
    expect(() => validateRendererIpc('createTerminal', { cols: 120, rows: 32 })).not.toThrow()
    expect(() => validateRendererIpc('writeTerminal', { terminalId: 'pty-1', data: 'pwd\r' })).not.toThrow()
    expect(() => validateRendererIpc('writeTerminal', { terminalId: 'pty-1', data: 'pwd\r', cwd: 'C:\\' })).toThrow()
    expect(() => validateRendererIpc('resizeTerminal', { terminalId: 'pty-1', cols: 10000, rows: 32 })).toThrow()
    expect(() => validateRendererIpc('bootstrap' as never, { arbitrary: true })).toThrow()
  })

  test('limits settings IPC to credential-free provider and integration commands', () => {
    expect(() => validateRendererIpc('getSettingsSnapshot')).not.toThrow()
    expect(() => validateRendererIpc('loginProvider', { providerId: 'openai', authType: 'api_key' })).not.toThrow()
    expect(() => validateRendererIpc('loginProvider', { providerId: 'openai', authType: 'api_key', apiKey: 'renderer-secret' })).toThrow()
    expect(() => validateRendererIpc('cancelProviderLogin')).not.toThrow()
    expect(() => validateRendererIpc('setMcpEnabled', { name: 'sample-server', enabled: true, confirmed: true })).not.toThrow()
    expect(() => validateRendererIpc('setMcpEnabled', { name: 'sample-server', enabled: true, env: { API_KEY: 'renderer-secret' } })).toThrow()
    expect(() => validateRendererIpc('setPluginEnabled', { scope: 'project', name: 'sample-plugin', enabled: false })).not.toThrow()
    expect(() => validateRendererIpc('setSkillLoaded', { name: 'reviewer', loaded: true })).not.toThrow()
  })

  test('redacts secret-like values and identifies credential files', () => {
    expect(redactDisplayText('api_key=abc123 and Bearer abc.def')).toBe('api_key=[redacted] and [redacted]')
    expect(redactDisplayValue({ apiKey: 'secret', message: 'sk-12345678901234567890' })).toEqual({
      apiKey: '[redacted]',
      message: '[redacted]',
    })
    expect(isLikelySecretFile('.env.local')).toBe(true)
    expect(isLikelySecretFile('server-key.pem')).toBe(true)
    expect(isLikelySecretFile('src/config.ts')).toBe(false)
  })
})
