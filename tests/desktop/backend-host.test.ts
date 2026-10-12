import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { DesktopBackendHost } from '../../src/desktop/DesktopBackendHost.ts'

describe('DesktopBackendHost sidecar lifecycle', () => {
  test('negotiates the transport version, serves IPC, and exits cleanly', async () => {
    const projectRoot = resolve(import.meta.dir, '../..')
    const host = new DesktopBackendHost(projectRoot)
    const observedStatuses: string[] = []
    const unsubscribe = host.subscribe((event) => {
      if (event.type === 'backend.status') observedStatuses.push(event.status)
    })

    try {
      await host.start()
      expect(host.status.status).toBe('ready')
      expect(host.status).toMatchObject({ appVersion: 'dev', runtimeProtocolVersion: 1 })
      const snapshot = await host.request<{ readonly workspace: string | null; readonly runtime: unknown }>('snapshot.get')
      expect(snapshot).toMatchObject({ workspace: null, runtime: null })
    } finally {
      await host.close()
      unsubscribe()
    }

    expect(host.status.status).toBe('closed')
    expect(observedStatuses).toContain('ready')
    expect(observedStatuses.at(-1)).toBe('closed')
  }, 20_000)

  test('refuses Agent operations when the packaged app and backend versions do not match', async () => {
    const projectRoot = resolve(import.meta.dir, '../..')
    const host = new DesktopBackendHost(projectRoot, { expectedAppVersion: '0.0.0' })
    try {
      await expect(host.start()).rejects.toThrow(/version mismatch.*repair Microcode/i)
      expect(host.status.status).toBe('failed')
      expect(host.status.message).toMatch(/Reinstall or repair Microcode with one matching release/)
      await expect(host.request('snapshot.get')).rejects.toThrow()
    } finally {
      await host.close()
    }
  }, 20_000)
})
