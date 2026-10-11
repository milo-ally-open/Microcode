import { describe, expect, test } from 'bun:test'
import { ensureBootstrapMacro } from '../../src/macro.ts'

describe('macro module', () => {
  test('bootstraps default global macro exactly once', () => {
    delete (globalThis as any).MACRO
    ensureBootstrapMacro()
    const first = (globalThis as any).MACRO
    ensureBootstrapMacro()

    expect((globalThis as any).MACRO).toBe(first)
    expect(first.VERSION).toBe('0.1.0')
    expect(first.ISSUES_EXPLAINER).toContain('github')
  })
})
