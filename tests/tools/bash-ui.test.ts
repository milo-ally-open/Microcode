import { describe, expect, test } from 'bun:test'
import { BashToolUI } from '../../src/tools/BashTool/UI.tsx'

describe('BashToolUI', () => {
  test('hides all output by default and preserves output verbatim when expanded', () => {
    const output = Array.from({ length: 60 }, (_, index) => `ROW_${String(index).padStart(3, '0')}`).join('\n')
    const component = new BashToolUI('tool-call', { command: 'cat long-file.txt' })
    component.updateDetails({ stdout: output, stderr: '', output, exitCode: 0 })
    component.updateResult({ content: [{ type: 'text', text: output }], isError: false })

    const collapsed = component.render(120).join('\n')
    expect(collapsed).not.toContain('ROW_000')
    expect(collapsed).not.toContain('ROW_059')
    expect(collapsed).not.toContain('ROW_030')
    expect(collapsed).toContain('[Expand preview]')
    expect(collapsed.split('\n').some((line) => line.includes('[Expand preview]'))).toBe(true)
    expect(component.hasToggleButton()).toBe(true)

    component.setExpanded(true)
    const expanded = component.render(120).join('\n')
    expect(expanded).toContain('ROW_030')
    expect(expanded).toContain('ROW_029')
    expect(expanded).not.toContain('│ ROW_029')
  })

  test('keeps a very long output line hidden until expanded', () => {
    const output = 'x'.repeat(5_000)
    const component = new BashToolUI('tool-call', { command: 'cat single-line.txt' })
    component.updateDetails({ stdout: output, stderr: '', output, exitCode: 0 })
    component.updateResult({ content: [{ type: 'text', text: output }], isError: false })

    const collapsed = component.render(120).join('\n')
    expect(collapsed).toContain('[Expand preview]')
    expect(collapsed).not.toContain(output)
    expect(component.hasToggleButton()).toBe(true)

    component.setExpanded(true)
    const expanded = component.render(120).join('\n')
    expect((expanded.match(/x/g) ?? []).length).toBeGreaterThanOrEqual(5_000)
    expect(expanded).not.toContain('│ ')
  })

  test('restores malformed historical output fields without throwing', () => {
    const component = new BashToolUI('tool-call', { command: 'echo test' })
    component.updateDetails({ stdout: 12, stderr: null, output: { old: 'shape' }, exitCode: 0 })

    expect(() => component.render(80)).not.toThrow()
  })
})
