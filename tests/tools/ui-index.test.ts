import { describe, expect, test } from 'bun:test'
import '../../src/tools/AskUserQuestionTool/index.ts'
import '../../src/tools/BashTool/index.ts'
import '../../src/tools/FileEditTool/index.ts'
import '../../src/tools/FileReadTool/index.ts'
import '../../src/tools/FileWriteTool/index.ts'
import '../../src/tools/GlobTool/index.ts'
import '../../src/tools/GrepTool/index.ts'
import '../../src/tools/TaskTool/index.ts'
import '../../src/tools/ToolSearchTool/index.ts'
import '../../src/tools/VisionTool/index.ts'
import '../../src/tools/WebFetchTool/index.ts'
import '../../src/tools/WebSearchTool/index.ts'
import { AskUserQuestionToolUI } from '../../src/tools/AskUserQuestionTool/UI.tsx'
import { BashToolUI } from '../../src/tools/BashTool/UI.tsx'
import { FileEditToolUI } from '../../src/tools/FileEditTool/UI.tsx'
import { FileReadToolUI } from '../../src/tools/FileReadTool/UI.tsx'
import { FileWriteToolUI } from '../../src/tools/FileWriteTool/UI.tsx'
import { GlobToolUI } from '../../src/tools/GlobTool/UI.tsx'
import { GrepToolUI } from '../../src/tools/GrepTool/UI.tsx'
import { TaskToolUI } from '../../src/tools/TaskTool/UI.tsx'
import { VisionToolUI } from '../../src/tools/VisionTool/UI.tsx'
import { WebFetchToolUI } from '../../src/tools/WebFetchTool/UI.tsx'
import { WebSearchToolUI } from '../../src/tools/WebSearchTool/UI.tsx'
import { formatToolActivity, formatToolDetail, formatToolStatus, formatToolSummary, getToolDefinition } from '../../src/tools/registry.ts'
import { ToolPreviewController } from '../../src/tools/previewController.ts'
import { ToolExecutionComponent } from '../../src/tui/components/toolExecution.ts'

function renderText(ui: any): string {
  return ui.render(120, 40).join('\n')
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}

function complete(content = 'done', isError = false) {
  return { content: [{ type: 'text', text: content }], isError }
}

describe('tool UI and registration modules', () => {
  test('registered tool index modules expose descriptions, formatters, and UI constructors', () => {
    const read = getToolDefinition('read')!
    expect(read.presentation.View).toBe(FileReadToolUI)
    expect(formatToolActivity('read', { file_path: 'src/a.ts' })).toContain('Reading')
    expect(formatToolDetail('read', { file_path: 'src/a.ts' })).toBe('a.ts')
    expect(formatToolStatus('read', { file_path: 'a' }, { returnedLines: 1, totalLines: 2 })).toBe('1/2 lines')
    expect(formatToolSummary('read', {
      content: [{ type: 'text', text: 'x' }],
      isError: false,
      details: { path: 'a', returnedLines: 1, totalLines: 2, truncated: true },
    })).toContain('truncated')

    expect(getToolDefinition('WebSearch')?.agent.formatDescription?.({ query: 'hello' })).toContain('hello')
    expect(getToolDefinition('grep')?.agent.extractMatchContent?.({ pattern: 'abc' })).toBe('abc')
  })

  test('shared preview controller starts collapsed with zero rows and owns toggle state', () => {
    const preview = new ToolPreviewController()
    expect(preview.visibleRows(12)).toBe(0)
    expect(preview.hasToggle(12)).toBe(true)
    expect(preview.toggleLabel()).toBe('[Expand preview]')
    preview.toggle()
    expect(preview.visibleRows(12)).toBe(12)
    expect(preview.toggleLabel()).toBe('[Collapse preview]')
    preview.setExpanded(false)
    expect(preview.visibleRows(12)).toBe(0)
  })

  test('basic tool UIs render pending, running, success, error, details, and expanded states', () => {
    const cases: Array<{ ui: any; details: Record<string, unknown>; args?: Record<string, unknown> }> = [
      { ui: new BashToolUI('1', { command: 'printf hi', description: 'Say hi' }), details: { stdout: 'hi\n', stderr: '', output: Array.from({ length: 14 }, (_, i) => `line ${i}`).join('\n'), exitCode: 1 }, args: { command: 'echo changed' } },
      { ui: new FileReadToolUI('2', { file_path: '/tmp/a.txt' }), details: { path: '/tmp/a.txt', totalLines: 10, returnedLines: 2, truncated: true } },
      { ui: new FileEditToolUI('3', { file_path: '/tmp/a.txt', old_string: 'a', new_string: 'b' }), details: { path: '/tmp/a.txt', replacements: 1, additions: 1, removals: 1 } },
      { ui: new FileWriteToolUI('4', { file_path: '/tmp/a.txt', content: 'abc' }), details: { path: '/tmp/a.txt', bytesWritten: 3, additions: 1, removals: 0, isNewFile: true, preview: 'abc', written: true } },
      { ui: new GlobToolUI('5', { pattern: '**/*.ts' }), details: { numFiles: 2, filenames: ['a.ts', 'b.ts'], truncated: false, durationMs: 5 } },
      { ui: new GrepToolUI('6', { pattern: 'alpha' }), details: { mode: 'content', numFiles: 1, filenames: ['a.ts'], numLines: 1, numMatches: 1, truncated: false } },
      { ui: new VisionToolUI('7', { image_source: 'image.png' }), details: { source: 'image.png', mimeType: 'image/png', sourceType: 'file' } },
      { ui: new WebFetchToolUI('8', { url: 'https://example.com', prompt: 'read' }), details: { url: 'https://example.com', finalUrl: 'https://example.com/final', bytes: 20, code: 200, codeText: 'OK', contentType: 'text/html', truncated: true, durationMs: 10 } },
      { ui: new WebSearchToolUI('9', { query: 'alpha' }), details: { query: 'alpha', results: [{ title: 'A', url: 'https://a.test' }], durationMs: 10 } },
    ]

    for (const { ui, details, args } of cases) {
      expect(renderText(ui).length).toBeGreaterThan(0)
      ui.markExecutionStarted()
      ui.updateElapsed?.(1500)
      if (args && ui.updateArgs) ui.updateArgs(args)
      ui.updateDetails?.(details)
      ui.updateResult(complete('partial'), true)
      expect(renderText(ui).length).toBeGreaterThan(0)
      ui.setExpanded?.(true)
      ui.updateResult(complete('done'), false)
      expect(renderText(ui)).toContain('✓')
      ui.updateResult(complete('failed', true), false)
      expect(renderText(ui)).toContain('✗')
    }
  })

  test('remaining specialized previews start collapsed and expose clickable header actions', () => {
    const glob = new GlobToolUI('glob-preview', { pattern: '**/*.ts' })
    const filenames = Array.from({ length: 12 }, (_, index) => `src/file-${index}.ts`)
    glob.updateDetails({ numFiles: filenames.length, filenames, truncated: false })
    glob.updateResult(complete(filenames.join('\n')))
    expect(renderText(glob)).not.toContain('src/file-0.ts')
    expect(renderText(glob)).toContain('[Expand preview]')
    const globTarget = glob.getInteractionTargets(glob.render(120, 40))[0]
    expect(globTarget).toBeDefined()
    globTarget!.activate()
    expect(renderText(glob)).toContain('src/file-0.ts')
    expect(renderText(glob)).toContain('[Collapse preview]')

    const grep = new GrepToolUI('grep-preview', { pattern: 'needle' })
    const matches = Array.from({ length: 12 }, (_, index) => `src/file-${index}.ts:${index + 1}: needle`)
    const grepResult = complete(matches.join('\n'))
    grep.updateDetails({ mode: 'content', numFiles: 12, numMatches: 12 })
    grep.updateResult(grepResult)
    expect(renderText(grep)).not.toContain('src/file-0.ts')
    expect(renderText(grep)).toContain('[Expand preview]')
    grep.getInteractionTargets(grep.render(120, 40))[0]!.activate()
    expect(renderText(grep)).toContain('src/file-0.ts:1: needle')
    expect(grepResult.content[0]?.text).toBe(matches.join('\n'))

    const webSearch = new WebSearchToolUI('search-preview', { query: 'docs' })
    webSearch.updateDetails({ query: 'docs', results: [{ title: 'First result', url: 'https://example.test', snippet: 'Useful snippet' }] })
    webSearch.updateResult(complete('model-facing search result'))
    expect(renderText(webSearch)).not.toContain('First result')
    expect(renderText(webSearch)).toContain('[Expand preview]')
    webSearch.setExpanded(true)
    expect(renderText(webSearch)).toContain('First result')
    expect(renderText(webSearch)).toContain('Useful snippet')

    const webFetch = new WebFetchToolUI('fetch-preview', { url: 'https://example.test' })
    const fetched = complete(Array.from({ length: 220 }, (_, index) => `page line ${index}`).join('\n'))
    webFetch.updateDetails({ url: 'https://example.test', code: 200, bytes: 4000 })
    webFetch.updateResult(fetched)
    expect(renderText(webFetch)).not.toContain('page line 0')
    webFetch.setExpanded(true)
    const fetchPreview = renderText(webFetch)
    expect(fetchPreview).toContain('page line 0')
    expect(fetchPreview).toContain('more lines')
    expect(fetchPreview).not.toContain('page line 219')
    expect(fetched.content[0]?.text).toContain('page line 219')

    const vision = new VisionToolUI('vision-preview', { image_source: 'photo.png' })
    const visionResult = {
      content: [{ type: 'text', text: 'Image description' }, { type: 'image', data: 'secret-image-payload' }],
      isError: false,
    }
    vision.updateDetails({ source: 'photo.png', sourceType: 'file', mimeType: 'image/png' })
    vision.updateResult(visionResult)
    expect(renderText(vision)).not.toContain('Image description')
    vision.setExpanded(true)
    expect(renderText(vision)).toContain('Image description')
    expect(renderText(vision)).not.toContain('secret-image-payload')

    const task = new TaskToolUI('task-preview', { action: 'write', title: 'Plan' })
    task.updateDetails({
      action: 'write',
      list: { id: 'list', title: 'Plan', tasks: Array.from({ length: 10 }, (_, index) => ({ id: `${index}`, content: `Task ${index}`, completed: false, pending: false })) },
    })
    task.updateResult(complete('task result'))
    expect(renderText(task)).not.toContain('Task 0')
    expect(renderText(task)).toContain('[Expand preview]')
    task.setExpanded(true)
    expect(renderText(task)).toContain('Task 0')

    const ask = new AskUserQuestionToolUI('ask-preview', { questions: [{ question: 'Choose?', header: 'Choice', options: [] }] })
    ask.updateDetails({ questions: [{ question: 'Choose?', header: 'Choice', options: [] }], answers: { 'Choose?': 'A' } })
    ask.updateResult(complete('answered'))
    expect(renderText(ask)).not.toContain('Choose?')
    expect(renderText(ask)).toContain('[Expand preview]')
    ask.setExpanded(true)
    expect(renderText(ask)).toContain('Choose?')
    expect(renderText(ask)).toContain('→ A')
  })

  test('shared fallback preview is collapsed, clickable, bounded, and presentation-only', () => {
    const output = Array.from({ length: 140 }, (_, index) => `line ${index}`).join('\n')
    const result = complete(output)
    const fallback = new ToolExecutionComponent('mcp__demo__inspect', 'generic', { query: 'state' })
    fallback.updateResult(result)

    const collapsed = renderText(fallback)
    expect(collapsed).toContain('[Expand preview]')
    expect(collapsed).not.toContain('line 1\n')
    const target = fallback.getInteractionTargets(fallback.render(120, 40))[0]
    expect(target).toBeDefined()
    target!.activate()
    const expanded = renderText(fallback)
    expect(expanded).toContain('line 0')
    expect(expanded).toContain('more output')
    expect(expanded).not.toContain('line 139')
    expect(result.content[0]?.text).toBe(output)

    const imageOnly = new ToolExecutionComponent('mcp__demo__image', 'binary', {})
    imageOnly.updateResult({ content: [{ type: 'image', data: 'hidden' }], isError: false })
    expect(renderText(imageOnly)).not.toContain('[Expand preview]')
    expect(renderText(imageOnly)).not.toContain('hidden')
  })

  test('read UI hides file contents by default and expands on request; edit UI previews diffs', () => {
    const read = new FileReadToolUI('read', { file_path: '/tmp/a.txt' })
    read.updateDetails({ path: '/tmp/a.txt', totalLines: 20, returnedLines: 20 })
    read.updateResult(complete(Array.from({ length: 20 }, (_, i) => `${i + 1} | read line ${i + 1}`).join('\n')), false)
    expect(renderText(read)).not.toContain('read line 1')
    expect(renderText(read)).not.toContain('read line 20')
    expect(renderText(read)).toContain('[Expand preview]')
    expect(stripAnsi(renderText(read))).toMatch(/read .*\[Expand preview\]/)
    read.setExpanded(true)
    expect(renderText(read)).toContain('read line 1')
    expect(renderText(read)).toContain('read line 20')
    read.setExpanded(false)
    expect(renderText(read)).not.toContain('read line 20')

    const projectedRead = new FileReadToolUI('read-projection', { file_path: '/tmp/projected.txt' })
    projectedRead.updateDetails({
      path: '/tmp/projected.txt',
      totalLines: 2,
      returnedLines: 2,
      previewLines: ['alpha', 'beta'],
      previewStartLine: 7,
    })
    projectedRead.updateResult(complete('alpha\nbeta'))
    projectedRead.setExpanded(true)
    expect(stripAnsi(renderText(projectedRead))).toMatch(/7\s+alpha/)
    expect(stripAnsi(renderText(projectedRead))).toMatch(/8\s+beta/)
    // TUI numbering comes from details and never gets added to Agent content.
    expect(projectedRead['result'].content[0].text).toBe('alpha\nbeta')

    const readWithoutDetails = new FileReadToolUI('read-no-details', { file_path: '/tmp/b.txt' })
    readWithoutDetails.updateResult(complete('sensitive file content'), false)
    expect(renderText(readWithoutDetails)).not.toContain('sensitive file content')
    expect(renderText(readWithoutDetails)).toContain('[Expand preview]')
    readWithoutDetails.setExpanded(true)
    expect(renderText(readWithoutDetails)).toContain('sensitive file content')

    const edit = new FileEditToolUI('edit', { file_path: '/tmp/a.txt' })
    const diff = ['@@ -1,1 +1,1 @@', '-old content', '+new content', ...Array.from({ length: 12 }, (_, i) => ` context ${i + 1}`)]
    edit.updateDetails({
      path: '/tmp/a.txt',
      replacements: 1,
      additions: 1,
      removals: 1,
      diff,
      phase: 'preparing',
    })
    expect(renderText(edit)).not.toContain('old content')
    expect(renderText(edit)).not.toContain('new content')
    expect(renderText(edit)).toContain('[Expand preview]')
    expect(stripAnsi(renderText(edit))).toMatch(/edit .*\[Expand preview\]/)
    edit.updateResult(complete(), false)
    expect(renderText(edit)).not.toContain('old content')
    expect(renderText(edit)).not.toContain('context 12')
    edit.setExpanded(true)
    expect(renderText(edit)).toContain('context 12')
    expect(renderText(edit)).toContain('old content')
    expect(renderText(edit)).toContain('new content')
    edit.setExpanded(false)
    expect(renderText(edit)).not.toContain('context 12')
  })

  test('write UI previews content for approval and after completion, but not while streaming or writing', () => {
    const write = new FileWriteToolUI('write', { file_path: '/tmp/a.txt', content: 'print(1)' })
    const content = Array.from({ length: 20 }, (_, i) => `print(${i + 1})`).join('\n')
    write.markExecutionStarted()
    write.updateArgs({ file_path: '/tmp/a.txt', content })
    write.updateDetails({
      path: '/tmp/a.txt',
      bytesWritten: Buffer.byteLength(content),
      additions: 20,
      removals: 0,
      isNewFile: true,
      preview: content,
      phase: 'preparing',
    })
    write.updateResult(complete('partial'), true)
    expect(renderText(write)).toContain('+20 lines')
    expect(renderText(write)).not.toContain('print(1)')
    expect(renderText(write)).not.toContain('print(20)')
    expect(write.hasToggleButton()).toBe(false)

    write.updateDetails({
      path: '/tmp/a.txt',
      bytesWritten: Buffer.byteLength(content),
      additions: 20,
      removals: 0,
      isNewFile: true,
      preview: content,
      phase: 'approval',
    })
    expect(renderText(write)).toContain('awaiting approval')
    expect(renderText(write)).not.toContain('print(1)')
    expect(renderText(write)).toContain('[Expand preview]')
    expect(stripAnsi(renderText(write))).toMatch(/write .*\[Expand preview\]/)
    expect(renderText(write)).not.toContain('print(20)')
    expect(write.hasToggleButton()).toBe(true)
    write.setExpanded(true)
    expect(renderText(write)).toContain('print(20)')
    write.setExpanded(false)

    write.updateDetails({
      path: '/tmp/a.txt',
      additions: 20,
      isNewFile: true,
      preview: content,
      phase: 'writing',
    })
    expect(renderText(write)).toContain('+20 lines')
    expect(renderText(write)).not.toContain('print(1)')
    expect(write.hasToggleButton()).toBe(false)

    write.updateResult(complete('done'), false)
    expect(renderText(write)).not.toContain('print(1)')
    expect(renderText(write)).not.toContain('print(20)')
    expect(write.hasToggleButton()).toBe(true)
    write.setExpanded(true)
    expect(renderText(write)).toContain('print(20)')
    write.setExpanded(false)
    expect(renderText(write)).not.toContain('print(20)')

    const overwrite = new FileWriteToolUI('overwrite', { file_path: '/tmp/old.txt' })
    overwrite.updateDetails({
      path: '/tmp/old.txt',
      additions: 1,
      removals: 1,
      isNewFile: false,
      preview: 'new line\n',
      diff: ['@@ -1,1 +1,1 @@', '-old line', '+new line'],
      phase: 'approval',
    })
    expect(renderText(overwrite)).not.toContain('-old line')
    expect(renderText(overwrite)).toContain('[Expand preview]')
    overwrite.setExpanded(true)
    expect(renderText(overwrite)).toContain('-old line')
    expect(renderText(overwrite)).toContain('+new line')
    expect(stripAnsi(renderText(overwrite))).toMatch(/1\s+│ -old line/)
  })

  test('large truncated write previews stay collapsed and cap expanded output', () => {
    const content = Array.from({ length: 2_050 }, (_, index) => `line-${index}`).join('\n')
    const write = new FileWriteToolUI('large-write', { file_path: '/tmp/large.txt', content })
    write.updateDetails({
      path: '/tmp/large.txt',
      additions: 2_050,
      isNewFile: true,
      preview: content,
      diff: [],
      diffTruncated: true,
      phase: 'approval',
    })

    const collapsed = renderText(write)
    expect(collapsed).toContain('[Expand preview]')
    expect(collapsed).not.toContain('line-0')

    write.setExpanded(true)
    const expanded = renderText(write)
    expect(expanded).toContain('line-0')
    expect(expanded).toContain('Preview limited to 2000 of 2050 lines')
    expect(expanded).not.toContain('line-2049')
  })

  test('Ask and Task UIs render special structured states', () => {
    const ask = new AskUserQuestionToolUI('ask', {
      questions: [{
        question: 'Pick?',
        header: 'Pick',
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      }],
    })
    ask.updateDetails({
      questions: [{
        question: 'Pick?',
        header: 'Pick',
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      }],
      answers: { 'Pick?': 'A' },
    })
    ask.updateResult(complete('answered'), false)
    expect(renderText(ask)).toContain('A')

    const task = new TaskToolUI('task', { action: 'write', title: 'Plan' })
    task.updateDetails({
      action: 'write',
      list: {
        id: 'list-1',
        title: 'Plan',
        tasks: [
          { id: 'task-1', content: 'Read', completed: false, pending: false },
          { id: 'task-2', content: 'Write', completed: true, pending: false },
          { id: 'task-3', content: 'Run', completed: false, pending: true },
        ],
      },
    })
    task.updateResult(complete('tasks'), false)
    expect(renderText(task)).toContain('Plan')

    const mark = new TaskToolUI('mark', { action: 'mark', task_id: 'task-1' })
    mark.markExecutionStarted()
    expect(renderText(mark)).toContain('Updating')
    mark.updateResult(complete('Validation failed for tool "task":\n- task_id: required', true), false)
    expect(renderText(mark)).toContain('incomplete')

    const claim = new TaskToolUI('claim', { action: 'claim' })
    claim.updateDetails({
      action: 'claim',
      list: { id: 'list-2', title: 'Empty', tasks: [] },
    })
    claim.updateResult(complete('empty'), false)
    expect(renderText(claim)).toContain('All tasks are complete')
  })
})
