import { describe, expect, test } from 'bun:test'
import { MultiSelectList } from '../../src/tui/components/multiSelectList.ts'
import { canRunGitCommand, isGitMutation, parseGitCommand, requiresGitConfirmation, splitGitCommandArgs } from '../../src/git/commands.ts'

describe('Git command parsing and policy', () => {
  test('parses the documented direct command surface', () => {
    expect(parseGitCommand('')).toEqual({ action: 'menu' })
    expect(parseGitCommand('status')).toEqual({ action: 'status' })
    expect(parseGitCommand('diff --staged')).toEqual({ action: 'diff-staged' })
    expect(parseGitCommand('branch create feature/ui')).toEqual({ action: 'branch-create', name: 'feature/ui' })
    expect(parseGitCommand('branch switch feature/ui')).toEqual({ action: 'branch-switch', name: 'feature/ui' })
    expect(parseGitCommand('branch delete feature/ui')).toEqual({ action: 'branch-delete', name: 'feature/ui' })
    expect(parseGitCommand('stage "folder with spaces/file.txt"')).toEqual({ action: 'stage', paths: ['folder with spaces/file.txt'] })
    expect(parseGitCommand('add "folder with spaces/file.txt"')).toEqual({ action: 'stage', paths: ['folder with spaces/file.txt'] })
    expect(parseGitCommand('unstage file.txt')).toEqual({ action: 'unstage', paths: ['file.txt'] })
    expect(parseGitCommand('discard file.txt')).toEqual({ action: 'discard', paths: ['file.txt'] })
    expect(parseGitCommand('commit add feature')).toEqual({ action: 'commit', message: 'add feature' })
    expect(parseGitCommand('stash save this work')).toEqual({ action: 'stash-push', message: 'save this work' })
    expect(parseGitCommand('stash apply stash@{2}')).toEqual({ action: 'stash-apply', ref: 'stash@{2}' })
    expect(parseGitCommand('stash pop')).toEqual({ action: 'stash-pop', ref: undefined })
  })

  test('rejects unsupported Git passthrough and malformed quoting', () => {
    expect(parseGitCommand('reset --hard')).toMatchObject({ action: 'unknown' })
    expect(parseGitCommand('push --force')).toMatchObject({ action: 'unknown' })
    expect(parseGitCommand('stage "unterminated')).toMatchObject({ action: 'unknown' })
    expect(splitGitCommandArgs('stage "path with spaces/file" D:\\repo\\file.txt')).toEqual([
      'stage', 'path with spaces/file', 'D:\\repo\\file.txt',
    ])
  })

  test('keeps reads unguarded and requires confirmation for remote or destructive operations', () => {
    const status = parseGitCommand('status')
    const push = parseGitCommand('push')
    const discardWithPaths = parseGitCommand('discard file.txt')
    const discardPicker = parseGitCommand('discard')
    const stashPop = parseGitCommand('stash pop')
    const stashPopDirect = parseGitCommand('stash pop stash@{0}')
    expect(isGitMutation(status)).toBe(false)
    expect(isGitMutation(push)).toBe(true)
    expect(requiresGitConfirmation(push)).toBe(true)
    expect(requiresGitConfirmation(discardWithPaths)).toBe(true)
    expect(requiresGitConfirmation(discardPicker)).toBe(false)
    expect(requiresGitConfirmation(stashPop)).toBe(false)
    expect(requiresGitConfirmation(stashPopDirect)).toBe(true)
    expect(canRunGitCommand(status, true)).toBe(true)
    expect(canRunGitCommand(push, true)).toBe(false)
    expect(canRunGitCommand(push, false)).toBe(true)
  })

  test('cancelling a multi-path picker never confirms selected paths', () => {
    const list = new MultiSelectList([{ value: 'file.txt', label: 'file.txt' }], 5, {
      selectedText: (text) => text,
      disabledText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => text,
    })
    let confirmed = false
    let cancelled = false
    list.onConfirm = () => { confirmed = true }
    list.onCancel = () => { cancelled = true }
    list.handleInput('\u001b')
    expect(cancelled).toBe(true)
    expect(confirmed).toBe(false)
  })
})
