import { describe, expect, test } from 'bun:test'
import { applySettingsAction } from '../../src/desktop/renderer/settingsActions.ts'

describe('desktop settings actions', () => {
  test('commits effective status and its notice only after backend confirmation', async () => {
    const before = { enabled: false }
    let current = before
    let notice = ''
    const applied = await applySettingsAction(
      async () => ({ enabled: true }),
      (snapshot) => { current = snapshot; notice = 'Plugin preference was applied to this runtime.' },
      () => undefined,
    )

    expect(applied).toBe(true)
    expect(current).toEqual({ enabled: true })
    expect(notice).toContain('was applied')
  })

  test('keeps prior settings and hides the success notice when the operation fails', async () => {
    const before = { enabled: false }
    let current = before
    let notice = ''
    const failures: unknown[] = []
    const applied = await applySettingsAction(
      async () => { throw new Error('Configuration is invalid.') },
      (snapshot) => { current = snapshot; notice = 'Plugin preference was applied.' },
      (error) => failures.push(error),
    )

    expect(applied).toBe(false)
    expect(current).toBe(before)
    expect(notice).toBe('')
    expect(failures).toHaveLength(1)
  })
})
