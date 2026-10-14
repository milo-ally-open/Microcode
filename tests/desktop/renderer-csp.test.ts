import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

describe('desktop renderer content security policy', () => {
  test('allows xterm inline styles needed for configured fonts and ANSI colors', async () => {
    const rendererPath = fileURLToPath(new URL('../../src/desktop/renderer/index.html', import.meta.url))
    const html = await readFile(rendererPath, 'utf8')
    expect(html).toContain("style-src 'self' 'unsafe-inline'")
    expect(html).toContain("script-src 'self'")
    expect(html).toContain("connect-src 'none'")
  })

  test('keeps every renderer stylesheet color in grayscale', async () => {
    const stylePath = fileURLToPath(new URL('../../src/desktop/renderer/style.css', import.meta.url))
    const style = await readFile(stylePath, 'utf8')
    const colors = [...style.matchAll(/#([\da-f]{3,8})\b/gi)].map((match) => match[1]!)

    expect(colors.length).toBeGreaterThan(0)
    for (const hex of colors) {
      const expanded = hex.length <= 4
        ? [...hex.slice(0, 3)].map((channel) => channel + channel).join('')
        : hex.slice(0, 6)
      expect(expanded.slice(0, 2)).toBe(expanded.slice(2, 4))
      expect(expanded.slice(0, 2)).toBe(expanded.slice(4, 6))
    }
  })
})
