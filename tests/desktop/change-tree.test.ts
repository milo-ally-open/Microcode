import { describe, expect, test } from 'bun:test'
import { buildReviewChangeTree, filterReviewChangeTree } from '../../src/desktop/renderer/change-tree.ts'
import type { DesktopReviewChange } from '../../src/desktop/protocol.ts'

function change(path: string): DesktopReviewChange {
  return { path, status: ' M', staged: false, unstaged: true, untracked: false }
}

describe('desktop review change tree', () => {
  test('groups nested paths, sorts folders before files, and retains each Git status', () => {
    expect(buildReviewChangeTree([
      change('src/z.ts'),
      { ...change('README.md'), status: 'A ', staged: true, unstaged: false },
      { ...change('src/components/App.tsx'), status: 'R ', staged: true, unstaged: false },
    ])).toEqual([
      {
        kind: 'directory',
        name: 'src',
        path: 'src',
        children: [
          {
            kind: 'directory',
            name: 'components',
            path: 'src/components',
            children: [{ kind: 'file', name: 'App.tsx', path: 'src/components/App.tsx', change: { ...change('src/components/App.tsx'), status: 'R ', staged: true, unstaged: false } }],
          },
          { kind: 'file', name: 'z.ts', path: 'src/z.ts', change: change('src/z.ts') },
        ],
      },
      { kind: 'file', name: 'README.md', path: 'README.md', change: { ...change('README.md'), status: 'A ', staged: true, unstaged: false } },
    ])
  })

  test('normalizes Windows separators and ignores empty paths', () => {
    expect(buildReviewChangeTree([change('src\\app.ts'), change('\\')])).toEqual([
      { kind: 'directory', name: 'src', path: 'src', children: [{ kind: 'file', name: 'app.ts', path: 'src/app.ts', change: change('src\\app.ts') }] },
    ])
  })

  test('filters files by path while retaining matching ancestor folders', () => {
    const tree = buildReviewChangeTree([change('src/components/App.tsx'), change('src/runtime.ts'), change('README.md')])
    expect(filterReviewChangeTree(tree, 'components/app')).toEqual([
      {
        kind: 'directory',
        name: 'src',
        path: 'src',
        children: [
          {
            kind: 'directory',
            name: 'components',
            path: 'src/components',
            children: [{ kind: 'file', name: 'App.tsx', path: 'src/components/App.tsx', change: change('src/components/App.tsx') }],
          },
        ],
      },
    ])
    expect(filterReviewChangeTree(tree, '  ')).toEqual(tree)
  })
})
