/** Microcode 的横向宽字形；6×5 实心像素面体，为横画之间保留真实间隙。 */
const GLYPHS: Record<string, readonly string[]> = {
  M: ['█    █', '██  ██', '█ ██ █', '█    █', '█    █'],
  I: ['██████', '  ██  ', '  ██  ', '  ██  ', '██████'],
  C: [' █████', '██    ', '██    ', '██    ', ' █████'],
  R: ['█████ ', '██  ██', '█████ ', '██ ██ ', '██  ██'],
  O: [' ████ ', '██  ██', '██  ██', '██  ██', ' ████ '],
  D: ['█████ ', '██  ██', '██  ██', '██  ██', '█████ '],
  // E 使用五行：上下横之间各留一行，让三条横画在终端字高下仍彼此分离。
  E: ['██████', '██    ', '████  ', '██    ', '██████'],
}

const COMPACT_GLYPHS: Record<string, readonly string[]> = {
  M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
  I: ['█████', '  █  ', '  █  ', '  █  ', '█████'],
  C: [' ████', '█    ', '█    ', '█    ', ' ████'],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
  O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  D: ['████ ', '█   █', '█   █', '█   █', '████ '],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
}

const WORD_GLYPHS = [...'MICROCODE'].map((letter) => GLYPHS[letter]!)

function extrudeGlyph(glyph: readonly string[]): string[] {
  return Array.from({ length: 6 }, (_, row) => {
    const cells = Array<string>(7).fill(' ')

    // 侧面与正面同一行相接，避免终端高字符格把斜向阴影显示成悬空色块。
    if (row < glyph.length && glyph[row]![5] === '█') cells[6] = '▓'
    // 仅在字形底边投影；E、C、O 等字腔保持原样，不会被阴影填满。
    if (row === glyph.length) {
      for (let column = 0; column < 6; column++) {
        if (glyph[glyph.length - 1]![column] === '█') cells[column + 1] = '▓'
      }
    }
    if (row < glyph.length) {
      for (let column = 0; column < 6; column++) {
        if (glyph[row]![column] === '█') cells[column] = '█'
      }
    }
    return cells.join('')
  })
}

const EXTRUDED_WORD_GLYPHS = WORD_GLYPHS.map(extrudeGlyph)
export const LOGO_LINES = Array.from({ length: 6 }, (_, row) =>
  EXTRUDED_WORD_GLYPHS.map((glyph) => glyph[row]!).join(' '),
)

export const COMPACT_LOGO_LINES = Array.from({ length: 5 }, (_, row) =>
  [...'MICROCODE'].map((letter) => COMPACT_GLYPHS[letter]![row]).join(' '),
)
