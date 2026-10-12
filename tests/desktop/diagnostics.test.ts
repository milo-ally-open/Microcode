import { describe, expect, test } from 'bun:test'
import { formatRendererFailureDiagnostic } from '../../src/desktop/diagnostics.ts'

describe('desktop failure diagnostics', () => {
  test('records renderer crash metadata without accepting arbitrary content', () => {
    expect(formatRendererFailureDiagnostic('crashed', 17)).toBe(
      'Microcode renderer process stopped (reason=crashed, exitCode=17).',
    )
    const diagnostic = formatRendererFailureDiagnostic('crashed api_key=sentinel-secret', Number.NaN)
    expect(diagnostic).toBe('Microcode renderer process stopped (reason=unknown, exitCode=unknown).')
    expect(diagnostic).not.toContain('sentinel-secret')
  })
})
