import { describe, expect, test } from 'bun:test'
import { Fragment, h, jsx, jsxs } from '../../src/tui/jsxFactory.ts'
import { InlineSelectPrompt } from '../../src/tui/components/inlineSelectPrompt.ts'
import { AppLayout } from '../../src/tui/components/appLayout.ts'
import { ChatTranscript, TurnTimeline } from '../../src/tui/components/turnTimeline.ts'
import { getBashModeBorderColor, getEditorTheme, getMarkdownTheme, theme } from '../../src/tui/theme.ts'
import { countContentLines, formatBytes, formatCompletedStatus, formatRunningStatus, getProgressFrame } from '../../src/tui/toolPresentation.ts'
import { Container, SelectList, Text, type Component } from '@earendil-works/pi-tui'
import { App } from '../../src/tui/app.ts'
import { autocompleteMaxVisibleForHeight, MicrocodeEditor } from '../../src/tui/components/microcodeEditor.ts'
import { AssistantMessageComponent } from '../../src/tui/components/assistantMessage.ts'
import { getEditorTheme } from '../../src/tui/theme.ts'
import { createSessionTitle, firstSentence, normalizeSessionTitle } from '../../src/tui/sessionTitle.ts'
import { parseBashInput } from '../../src/tui/bashInput.ts'
import {
  getAgentActivityLabel,
  transitionAgentActivity,
  type AgentActivityState,
} from '../../src/tui/agentActivity.ts'
import { COMPACT_LOGO_LINES, LOGO_LINES } from '../../src/tui/logo.ts'
import { WelcomeBanner } from '../../src/tui/components/welcomeBanner.ts'

describe('tui modules', () => {
  test('startup logo is a compact Unicode pixel wordmark', () => {
    expect(LOGO_LINES).toHaveLength(6)
    expect(LOGO_LINES.some((line) => line.includes('█'))).toBe(true)
    expect(LOGO_LINES.every((line) => line.length === 71)).toBe(true)
    expect(LOGO_LINES.some((line) => line.includes('▓'))).toBe(true)
    // E 的三条面体横画各自分行；贴边侧影不能填入字腔或漂浮在旁边。
    expect(LOGO_LINES[0]!.slice(64, 71)).toBe('██████▓')
    expect(LOGO_LINES[1]!.slice(64, 71)).toBe('██     ')
    expect(LOGO_LINES[2]!.slice(64, 71)).toBe('████   ')
    expect(LOGO_LINES[3]!.slice(64, 71)).toBe('██     ')
    expect(LOGO_LINES[4]!.slice(64, 71)).toBe('██████▓')
    expect(LOGO_LINES[5]!.slice(64, 71)).toBe(' ▓▓▓▓▓▓')
    expect(COMPACT_LOGO_LINES[2]!.slice(-5)).toBe('████ ')
    expect(COMPACT_LOGO_LINES[3]!.slice(-5)).toBe('█    ')
    expect(COMPACT_LOGO_LINES[4]!.slice(-5)).toBe('█████')
  })

  test('welcome banner frames the logo and adapts to narrower terminals', () => {
    const banner = new WelcomeBanner()
    const wide = banner.render(80)
    expect(wide[0]).toContain('╭')
    expect(wide.join('\n')).toContain('long-running sessions')
    expect(wide.every((line) => line.replace(/\u001b\[[0-9;]*m/g, '').length === 80)).toBe(true)

    const narrow = banner.render(60)
    expect(narrow.join('\n')).toContain('Agentic coding assistant')
    expect(narrow.every((line) => line.replace(/\u001b\[[0-9;]*m/g, '').length === 60)).toBe(true)

    const compact = banner.render(40)
    expect(compact.every((line) => line.replace(/\u001b\[[0-9;]*m/g, '').length === 40)).toBe(true)
  })

  test('theme helpers return styled strings and editor/markdown contracts', () => {
    expect(theme.fg('unknown', 'text')).toBe('text')
    expect(theme.bold('text')).toContain('text')
    expect(getMarkdownTheme().code('x')).toContain('x')
    expect(getEditorTheme().selectList.noMatch('none')).toContain('none')
    expect(getBashModeBorderColor()('|')).toContain('|')
  })

  test('tool presentation formats durations, bytes, frames, and line counts', () => {
    expect(getProgressFrame(10)).toBe('●')
    expect(formatRunningStatus(1500, 'reading')).toBe('reading · 1.5s')
    expect(formatCompletedStatus(61_000)).toBe('completed · 1m 1s')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(countContentLines('a\nb\n')).toBe(2)
  })

  test('session titles stay on one line and are limited by character count', () => {
    expect(firstSentence('Fix the parser. Then add tests.')).toBe('Fix the parser.')
    expect(firstSentence('修复解析器。然后补测试。')).toBe('修复解析器。')
    expect(normalizeSessionTitle('Useful title\nextra line')).toBe('Useful title')
    const longTitle = normalizeSessionTitle('界'.repeat(70))
    expect(Array.from(longTitle)).toHaveLength(60)
    expect(longTitle.endsWith('...')).toBe(true)
  })

  test('gateway startup result is rendered as a visible success or fallback message', () => {
    const app = Object.create(App.prototype) as any
    const chatContainer = new ChatTranscript()
    Object.assign(app, { startupMessages: [], chatContainer, ui: { requestRender() {} } })
    app.addStartupMessage('Model Gateway handshake successful (protocol 1, 42 models).', 'success')
    app.addStartupMessage('Model Gateway handshake failed: unavailable. Falling back to --no-daemon mode.', 'error')
    app.renderStartupMessages()

    const rendered = chatContainer.render(120).join('\n')
    expect(rendered).toContain('Model Gateway handshake successful (protocol 1, 42 models).')
    expect(rendered).toContain('Model Gateway handshake failed: unavailable. Falling back to --no-daemon mode.')
  })

  test('/gateway opens a bind-address picker and applies the selected address', async () => {
    const children: Component[] = []
    let changedHost: string | undefined
    const app = Object.create(App.prototype) as any
    Object.assign(app, {
      editor: { addToHistory() {}, setText() {} },
      chatContainer: {
        addChild: (child: Component) => children.push(child),
        removeChild: (child: Component) => { const index = children.indexOf(child); if (index >= 0) children.splice(index, 1) },
      },
      ui: { setFocus() {}, requestRender() {} },
      agent: { isBusy: () => false },
      gatewayBindControl: {
        getBindHost: () => '127.0.0.1',
        setBindHost: async (host: string) => { changedHost = host },
      },
      showStatus() {},
      showError() {},
    })

    expect(app.handleSlashCommand('/gateway')).toBe(true)
    const picker = children.find((child) => child instanceof SelectList) as SelectList | undefined
    expect(picker).toBeDefined()
    picker!.onSelect?.({ value: '0.0.0.0', label: 'All IPv4 interfaces' })
    await Promise.resolve()
    expect(changedHost).toBe('0.0.0.0')
  })

  test('/gateway accepts a directly supplied interface address', async () => {
    let changedHost: string | undefined
    const app = Object.create(App.prototype) as any
    Object.assign(app, {
      editor: { addToHistory() {} },
      agent: { isBusy: () => false },
      gatewayBindControl: {
        getBindHost: () => '127.0.0.1',
        setBindHost: async (host: string) => { changedHost = host },
      },
      showStatus() {},
      showError() {},
    })
    app.handleGatewayCommand('192.168.1.22')
    await Promise.resolve()
    expect(changedHost).toBe('192.168.1.22')
  })

  test('model command resolves daemon-only models from the injected project catalog', async () => {
    const catalogModel = {
      id: 'catalog-only-model',
      provider: 'custom:project-catalog',
      name: 'Project Catalog Model',
      api: 'openai-completions',
    }
    let switched: unknown[] = []
    const app = Object.create(App.prototype) as any
    Object.assign(app, {
      modelCatalog: { getProjectModels: () => [catalogModel] },
      agent: {
        switchModel: (...args: unknown[]) => {
          switched = args
          return { model: catalogModel, provider: catalogModel.provider }
        },
      },
      chatContainer: new ChatTranscript(),
      ui: { requestRender() {} },
      footer: { invalidate() {} },
      pendingImages: [],
      suppressTrailingQuote: false,
    })

    await app.handleModelCommand('catalog-only-model')

    expect(switched).toEqual(['catalog-only-model', undefined, 'custom:project-catalog'])
  })

  test('gateway auth command uses provider catalog and auth status supplied over RPC', async () => {
    let providersRequested = 0
    let statusesRequested = 0
    let selectedItems: unknown[] = []
    const app = Object.create(App.prototype) as any
    Object.assign(app, {
      modelAuth: {
        async listProviders() {
          providersRequested++
          return [{ id: 'gateway-provider', name: 'Gateway Provider', authChoices: [] }]
        },
        async getAuthStatus() {
          statusesRequested++
          return [{ providerId: 'gateway-provider', configured: true, type: 'oauth' }]
        },
      },
      async selectAuthOption(_title: string, items: unknown[]) {
        selectedItems = items
      },
    })

    await app.handleAuthCommand('status', '')

    expect(providersRequested).toBe(1)
    expect(statusesRequested).toBe(1)
    expect(selectedItems).toEqual([{
      value: 'gateway-provider',
      label: 'Gateway Provider',
      description: 'gateway-provider · oauth',
    }])
  })

  test('session title generation uses the opening sentence and falls back to clipped input', async () => {
    let requestedSeed = ''
    const generated = await createSessionTitle('Fix parser errors. Add tests after.', async (seed) => {
      requestedSeed = seed
      return 'Parser error fix'
    })
    expect(requestedSeed).toBe('Fix parser errors.')
    expect(generated).toBe('Parser error fix')

    const fallback = await createSessionTitle('界'.repeat(70), async () => {
      throw new Error('title provider unavailable')
    })
    expect(Array.from(fallback)).toHaveLength(60)
    expect(fallback.endsWith('...')).toBe(true)
  })

  test('bash input distinguishes normal, excluded, empty, and ordinary prompts', () => {
    expect(parseBashInput('! pwd')).toEqual({ command: 'pwd', excludeFromContext: false })
    expect(parseBashInput('!! git status')).toEqual({ command: 'git status', excludeFromContext: true })
    expect(parseBashInput('!')).toEqual({ command: '', excludeFromContext: false })
    expect(parseBashInput('hello')).toBeNull()
  })

  test('jsx factory creates intrinsic and functional components', () => {
    const text = h('text', null, 'hello')
    const box = h('box', null, text)
    const custom = h((props: any) => h('text', null, props.label), { label: 'custom' })

    expect(text.render(20, 10).join('\n')).toContain('hello')
    expect(box.render(20, 10).join('\n')).toContain('hello')
    expect(custom.render(20, 10).join('\n')).toContain('custom')
    expect(Fragment({}).render(20, 10)).toEqual([])
    expect(jsx).toBe(h)
    expect(jsxs).toBe(h)
  })

  test('inline select prompt stays in the turn and becomes a result after selection', () => {
    const choices = new SelectList([{ value: 'allow', label: 'Allow' }], 1, {
      selectedPrefix: (text) => text,
      selectedText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
    })
    const prompt = new InlineSelectPrompt('Question: What should I do?', choices)

    expect(prompt.render(80).join('\n')).toContain('Question: What should I do?')
    expect(prompt.render(80).join('\n')).toContain('Allow')

    prompt.complete('selected answer')
    expect(prompt.render(80).join('\n')).toContain('selected answer')
    prompt.complete('answer')
    expect(prompt.render(80).join('\n')).toContain('answer')
    expect(prompt.render(80).join('\n')).not.toContain('Allow')
  })

  test('turn timeline renders the same component only once', () => {
    const row = new Text('tool completed')
    const timeline = new TurnTimeline()
    timeline.addEntry(new Text('user input'), 'user')
    timeline.addEntry(row, 'tool')
    timeline.addEntry(row, 'tool')

    expect(timeline.render(80).filter((line) => line.includes('tool completed'))).toHaveLength(1)
  })

  test('context compaction is recorded as a concise status in the active turn', () => {
    const timeline = new TurnTimeline()
    timeline.addEntry(new Text('user input'), 'user')
    const app = Object.create(App.prototype) as any
    Object.assign(app, {
      activeTurnTimeline: timeline,
      turnFinalized: false,
      compacting: false,
      chatContainer: new ChatTranscript(),
      footer: { invalidate() {} },
      ui: { requestRender() {} },
    })

    app.appendContextCompactedEntry()

    expect(timeline.render(80).join('\n')).toContain('Context Compacted')
    expect(app.chatContainer.children).toHaveLength(0)
  })

  test('manual compaction gets its own status timeline instead of modifying an old turn', () => {
    const oldTurn = new TurnTimeline()
    oldTurn.addEntry(new Text('previous turn'), 'user')
    const chatContainer = new ChatTranscript()
    chatContainer.addChild(oldTurn)
    const app = Object.create(App.prototype) as any
    Object.assign(app, {
      activeTurnTimeline: oldTurn,
      turnFinalized: true,
      compacting: true,
      chatContainer,
      footer: { invalidate() {} },
      ui: { requestRender() {} },
    })

    app.appendContextCompactedEntry()

    expect(oldTurn.render(80).join('\n')).not.toContain('Context Compacted')
    expect(chatContainer.render(80).join('\n')).toContain('Context Compacted')
  })

  test('turn timeline derives preview hit targets from the same render pass', () => {
    let renderCount = 0
    const row = {
      render: () => {
        renderCount++
        return ['tool [Expand preview]']
      },
      getInteractionTargets: (renderedLines: readonly string[]) => {
        expect(renderedLines).toEqual(['tool [Expand preview]'])
        return [{
          action: 'toggle-preview' as const,
          rowOffset: 0,
          startColumn: 6,
          endColumn: 21,
          activate: () => {},
        }]
      },
    } as unknown as Component
    const timeline = new TurnTimeline()
    timeline.addEntry(new Text('user input'), 'user')
    timeline.addEntry(row, 'tool')

    timeline.render(80)
    const targets = timeline.getToolInteractionTargets(80)

    expect(renderCount).toBe(1)
    expect(targets).toHaveLength(1)
  })

  test('preview click coordinates include preceding transcript rows', () => {
    let expanded = false
    const toolRow = {
      render: () => ['tool [Expand preview]'],
      getInteractionTargets: () => [{
        action: 'toggle-preview' as const,
        rowOffset: 0,
        startColumn: 6,
        endColumn: 21,
        activate: () => { expanded = !expanded },
      }],
    } as unknown as Component
    const timeline = new TurnTimeline()
    timeline.addEntry(new Text('user request'), 'user')
    timeline.addEntry(toolRow, 'tool')
    const transcript = new ChatTranscript()
    transcript.addChild(new Text('earlier conversation'))
    transcript.addChild(timeline)

    const layout = new AppLayout(
      { render: () => ['header'] },
      transcript,
      [{ render: () => ['editor'] }],
      () => 8,
      (width) => transcript.getToolInteractionTargets(width),
    )
    const rendered = layout.render(80)
    const buttonRow = rendered.findIndex((line) => line.includes('[Expand preview]')) + 1

    expect(buttonRow).toBeGreaterThan(0)
    expect(layout.handleInput(`\x1b[<0;10;${buttonRow}M`)).toBe(true)
    expect(expanded).toBe(true)
  })

  test('startup resume renders restored messages immediately like session switching', () => {
    const messages = [
      { role: 'user', content: 'restored question', timestamp: 1 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal reasoning' },
          { type: 'text', text: 'restored answer' },
        ],
        stopReason: 'stop',
        timestamp: 2,
      },
    ] as any[]
    const app = Object.create(App.prototype) as any
    let requestedRender = false
    let followedLatest = false
    Object.assign(app, {
      agent: { getMessages: () => messages },
      chatContainer: new Container(),
      toolRows: new Map(),
      pendingTools: new Map(),
      appLayout: { followLatest: () => { followedLatest = true } },
      footer: { invalidate() {} },
      ui: { requestRender: () => { requestedRender = true } },
      activeTurnTimeline: undefined,
      turnFinalized: false,
    })

    app.restoreInitialSessionHistory()

    const rendered = app.chatContainer.render(100).join('\n')
    expect(rendered).toContain('restored question')
    expect(rendered).toContain('restored answer')
    expect(rendered).not.toContain('internal reasoning')
    expect(rendered).not.toContain('Analysis complete')
    expect(rendered).not.toContain('Analyzing…')
    expect(followedLatest).toBe(true)
    expect(requestedRender).toBe(true)
  })

  test('app layout keeps the editor and footer anchored while chat output grows', () => {
    const header: Component = { render: () => ['header'] }
    const chat: Component = { render: () => Array.from({ length: 20 }, (_, index) => `chat ${index}`) }
    const editor: Component = { render: () => ['editor'] }
    const footer: Component = { render: () => ['footer'] }
    const layout = new AppLayout(header, chat, [editor, footer], () => 8)

    const lines = layout.render(80)
    expect(lines).toHaveLength(8)
    expect(lines[0]).toBe('header')
    expect(lines.at(-2)).toBe('editor')
    expect(lines.at(-1)).toBe('footer')
    expect(lines.some((line) => line.includes('chat 19'))).toBe(true)
    expect(lines).not.toContain('chat 0')
  })

  test('tool preview buttons toggle only the clicked tool row', () => {
    let firstExpanded = false
    let secondExpanded = false
    const layout = new AppLayout(
      { render: () => ['header'] },
      { render: () => ['read one [Expand preview]', 'read two [Collapse preview]'] },
      [{ render: () => ['editor', 'footer'] }],
      () => 8,
      () => [
        { action: 'toggle-preview', rowOffset: 0, startColumn: 10, endColumn: 30, activate: () => { firstExpanded = !firstExpanded } },
        { action: 'toggle-preview', rowOffset: 1, startColumn: 10, endColumn: 30, activate: () => { secondExpanded = !secondExpanded } },
      ],
    )
    layout.render(80)

    expect(layout.handleInput('\x1b[<0;17;3M')).toBe(true)
    expect(firstExpanded).toBe(false)
    expect(secondExpanded).toBe(true)
  })

  test('chat viewport pages through history and pauses following until returning to latest', () => {
    let chatLines = Array.from({ length: 12 }, (_, index) => `chat ${index}`)
    const header: Component = { render: () => ['header'] }
    const chat: Component = { render: () => chatLines }
    const bottom: Component = { render: () => ['editor', 'footer'] }
    const layout = new AppLayout(header, chat, [bottom], () => 8)

    let lines = layout.render(80)
    expect(lines.some((line) => line.includes('chat 11'))).toBe(true)
    expect(lines.some((line) => line.includes('↕ Scroll: mouse wheel · PgUp/PgDn'))).toBe(true)
    expect(layout.handleInput('\x1b[5~')).toBe(true)
    lines = layout.render(80)
    expect(lines.some((line) => line.includes('Return to bottom'))).toBe(true)
    expect(lines.some((line) => line.includes('chat 4'))).toBe(true)

    chatLines = [...chatLines, 'chat 12', 'chat 13']
    lines = layout.render(80)
    expect(lines.some((line) => line.includes('chat 4'))).toBe(true)
    expect(lines.some((line) => line.includes('chat 13'))).toBe(false)

    expect(layout.handleInput('\x1b[6~')).toBe(true)
    expect(layout.handleInput('\x1b[6~')).toBe(true)
    lines = layout.render(80)
    expect(lines.some((line) => line.includes('chat 13'))).toBe(true)
    expect(lines.some((line) => line.includes('↕ Scroll: mouse wheel · PgUp/PgDn'))).toBe(true)
    expect(layout.handleInput('\x1b[5~', true)).toBe(false)
  })

  test('chat viewport scrolls with the mouse wheel and returns to latest from its button', () => {
    const chatLines = Array.from({ length: 12 }, (_, index) => `chat ${index}`)
    const layout = new AppLayout(
      { render: () => ['header'] },
      { render: () => chatLines },
      [{ render: () => ['editor', 'footer'] }],
      () => 8,
    )
    layout.render(80)

    // Wheel-up/down moves by a few lines, not a full page.
    expect(layout.handleInput('\x1b[<64;40;4M')).toBe(true)
    expect(layout.render(80).some((line) => line.includes('chat 5'))).toBe(true)

    // Clicks outside the return button remain ignored.
    expect(layout.handleInput('\x1b[<0;79;3M')).toBe(false)
    expect(layout.render(80).some((line) => line.includes('chat 5'))).toBe(true)

    // The button is rendered on row 6; clicking it returns to the newest output.
    expect(layout.handleInput('\x1b[<0;10;6M')).toBe(true)
    const latestLines = layout.render(80)
    expect(latestLines.some((line) => line.includes('chat 11'))).toBe(true)
    expect(latestLines.some((line) => line.includes('Return to bottom'))).toBe(false)

    expect(layout.handleInput('\x1b[<64;40;4M')).toBe(true)
    expect(layout.handleInput('\x1b[<65;40;4M')).toBe(true)
    expect(layout.render(80).some((line) => line.includes('chat 11'))).toBe(true)
    expect(layout.handleInput('\x1b[<0;80;6m')).toBe(false)
    expect(layout.handleInput('\x1b[<64;40;4M', true)).toBe(false)
  })

  test('autocomplete uses available terminal height up to the list limit', () => {
    expect(autocompleteMaxVisibleForHeight(24)).toBe(10)
    expect(autocompleteMaxVisibleForHeight(60)).toBe(20)
    expect(autocompleteMaxVisibleForHeight(12)).toBe(3)
  })

  test('assistant transcript keeps thinking blocks out of visible history', () => {
    const assistant = new AssistantMessageComponent(getMarkdownTheme())
    assistant.updateContent({
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'internal reasoning' }],
    } as any)

    const rendered = assistant.render(80).join('\n')
    expect(rendered).not.toContain('internal reasoning')
    expect(rendered).not.toContain('Analyzing…')
    expect(rendered).not.toContain('Analysis complete')
  })

  test('agent activity follows a provider-neutral finite state machine', () => {
    let state: AgentActivityState = { phase: 'idle' }
    state = transitionAgentActivity(state, { type: 'thinking' })
    expect(getAgentActivityLabel(state)).toBe('Analyzing…')

    state = transitionAgentActivity(state, { type: 'preparing-tool' })
    expect(getAgentActivityLabel(state)).toBe('Preparing tool call…')
    state = transitionAgentActivity(state, { type: 'tool-started', toolName: 'Read' })
    expect(getAgentActivityLabel(state)).toBe('Running Read…')
    state = transitionAgentActivity(state, { type: 'tool-finished', pendingTools: 0 })
    expect(getAgentActivityLabel(state)).toBe('Analyzing…')
    state = transitionAgentActivity(state, { type: 'responding', pendingTools: 0 })
    expect(getAgentActivityLabel(state)).toBe('Responding…')
    state = transitionAgentActivity(state, { type: 'work-finished', pendingTools: 0 })
    expect(getAgentActivityLabel(state)).toBeUndefined()
  })

  test('agent activity ignores stale and duplicate lifecycle events', () => {
    const idle: AgentActivityState = { phase: 'idle' }
    expect(transitionAgentActivity(idle, { type: 'tool-finished', pendingTools: 0 })).toBe(idle)
    expect(transitionAgentActivity(idle, { type: 'responding', pendingTools: 0 })).toBe(idle)
    expect(transitionAgentActivity(idle, { type: 'preparing-tool' })).toBe(idle)
    expect(transitionAgentActivity(idle, { type: 'tool-started', toolName: 'Bash' })).toBe(idle)
    expect(transitionAgentActivity(idle, { type: 'work-finished', pendingTools: 2 })).toBe(idle)

    const responding: AgentActivityState = { phase: 'responding' }
    expect(transitionAgentActivity(responding, { type: 'thinking' })).toBe(responding)
    expect(transitionAgentActivity(responding, { type: 'responding', pendingTools: 0 })).toBe(responding)
    const running: AgentActivityState = { phase: 'running-tool', toolName: 'Read' }
    expect(transitionAgentActivity(running, { type: 'thinking' })).toBe(running)
    expect(transitionAgentActivity(running, { type: 'preparing-tool' })).toBe(running)

    const justFinished: AgentActivityState = { phase: 'idle' }
    const repeatedFinish = transitionAgentActivity(justFinished, { type: 'work-finished', pendingTools: 0 })
    expect(repeatedFinish).toBe(justFinished)
  })

  test('agent activity permits a real response-to-tool handoff', () => {
    const preparing = transitionAgentActivity(
      { phase: 'responding' },
      { type: 'preparing-tool' },
    )
    expect(preparing).toEqual({ phase: 'preparing-tool' })
    expect(transitionAgentActivity(preparing, { type: 'tool-started', toolName: 'Bash' }))
      .toEqual({ phase: 'running-tool', toolName: 'Bash' })
  })

  test('model turn ends do not add transcript gaps until the user turn is finalized', () => {
    const app = Object.create(App.prototype) as any
    let onAgentEvent: ((event: any) => void) | undefined
    const transcriptChildren: unknown[] = []
    app.agent = {
      subscribe: (listener: (event: any) => void) => { onAgentEvent = listener },
      persistMessages: async () => {},
    }
    app.permissionPromptActive = false
    app.pendingTools = new Map([['tool-1', {}]])
    app.activeTurnTimeline = { setActivity: () => {} }
    app.chatContainer = { addChild: (child: unknown) => transcriptChildren.push(child) }
    app.turnFinalized = false
    app.titleGenerated = true
    app.setAgentActivity = () => {}
    app.clearPendingToolState = () => {}
    app.updateContextUsage = () => {}
    app.footer = { invalidate: () => {} }
    app.ui = { requestRender: () => {} }
    app.isAgentBusy = () => false
    app.applyQueuedMcpState = () => {}

    app.setupAgentSubscription()
    const emit = onAgentEvent!
    for (let i = 0; i < 8; i++) {
      emit({ type: 'turn_end', message: { role: 'assistant', stopReason: 'toolUse' } })
    }
    expect(transcriptChildren).toHaveLength(0)

    emit({ type: 'turn_end', message: { role: 'assistant', stopReason: 'stop' } })
    expect(transcriptChildren).toHaveLength(1)

    // agent_end may follow the final turn_end; finalization must stay idempotent.
    emit({ type: 'agent_end' })
    expect(transcriptChildren).toHaveLength(1)
  })

  test('Git menu opens a local branch picker and switches the selected branch directly', async () => {
    const app = Object.create(App.prototype) as any
    const pickers: Array<{ title: string; items: Array<{ value: string; label: string }>; onSelect: (value: string) => void }> = []
    const commands: string[] = []
    const statuses: string[] = []
    app.showGitPicker = (title: string, _subtitle: string, items: any[], onSelect: (value: string) => void) => {
      pickers.push({ title, items, onSelect })
    }
    app.showStatus = (message: string) => statuses.push(message)
    app.showError = (message: string) => statuses.push(message)
    app.handleGitCommand = async (command: string) => { commands.push(command) }

    const repository = {
      root: '/repo',
      status: async () => ({ branch: 'main', changes: [] }),
      branches: async () => [
        { name: 'feature/ui', current: false },
        { name: 'main', current: true },
      ],
    }
    await app.showGitActionMenu(repository)
    const menu = pickers[0]!
    expect(menu.items.find((item) => item.value === 'branches')).toMatchObject({ label: 'Branch' })
    expect(menu.items.find((item) => item.value === 'log')).toMatchObject({ label: 'Log' })
    menu.onSelect('log')
    expect(commands).toContain('log')
    menu.onSelect('branches')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const branchPicker = pickers.find((picker) => picker.title === 'Local branches')!
    expect(branchPicker.items.map((item) => item.label)).toEqual(['  feature/ui', '● main'])
    branchPicker.onSelect('feature/ui')
    expect(commands).toContain('branch switch "feature/ui"')
    branchPicker.onSelect('main')
    expect(statuses).toContain('Already on branch main.')
  })

  test('Git menu commit opens a dedicated message prompt instead of pre-filling a slash command', async () => {
    const app = Object.create(App.prototype) as any
    const children: any[] = []
    const inputWrites: string[] = []
    const commands: string[] = []
    let menuItems: Array<{ value: string; label: string }> = []
    app.editor = {
      onSubmit: () => {},
      onEscape: () => {},
      setText: (value: string) => inputWrites.push(value),
    }
    app.chatContainer = {
      addChild: (child: any) => children.push(child),
      removeChild: (child: any) => { const index = children.indexOf(child); if (index >= 0) children.splice(index, 1) },
    }
    app.ui = { setFocus: () => {}, requestRender: () => {} }
    app.handleGitCommand = async (command: string) => { commands.push(command) }
    app.showGitPicker = (_title: string, _subtitle: string, items: Array<{ value: string; label: string }>, onSelect: (value: string) => void) => {
      menuItems = items
      app.menuOnSelect = onSelect
    }
    await app.showGitActionMenu({
      root: '/repo',
      status: async () => ({ branch: 'main', changes: [] }),
    })
    expect(menuItems.find((item) => item.value === 'commit')).toMatchObject({ label: 'Commit' })
    app.menuOnSelect('commit')

    expect(children[0].render(80).join('')).toContain('Commit message')
    expect(inputWrites).toEqual([''])
    app.editor.onSubmit('fix: keep branch status fresh')
    expect(commands).toEqual(['commit "fix: keep branch status fresh"'])
    expect(children).toHaveLength(0)
  })

  test('turn activity updates replace the current row instead of appending history', () => {
    const timeline = new TurnTimeline()
    timeline.setActivity('Thinking…')
    timeline.setActivity('Running tools…')

    const rendered = timeline.render(80).join('\n')
    expect(rendered).toContain('Running tools…')
    expect(rendered).not.toContain('Thinking…')
    expect(timeline.render(80)).toHaveLength(1)
  })

  test('concise activity and elapsed time remain visible while tool cards are active', () => {
    const app = Object.create(App.prototype) as any
    let displayedActivity: string | undefined
    app.agentWorking = true
    app.agentActivityLabel = 'Running Bash…'
    app.workingStartedAt = Date.now() - 11_000
    app.workingFrameIndex = 0
    app.workingTimer = 1 // Prevent creating a real interval in this unit test.
    app.workingText = null
    app.pendingTools = new Map([['tool-1', {}]])
    app.activeTurnTimeline = {
      setActivity: (activity: string | undefined) => { displayedActivity = activity },
    }

    app.updateWorkingIndicator()

    expect(displayedActivity).toContain('Running Bash…')
    expect(displayedActivity).toContain('11s')
  })

  test('skill completion opens immediately after $ and updates while typing', async () => {
    const editor = new MicrocodeEditor({ requestRender() {}, terminal: { rows: 24 } } as any, getEditorTheme(), { paddingX: 1 })
    editor.setAutocompleteProvider({
      async getSuggestions(lines, cursorLine, cursorCol) {
        const beforeCursor = (lines[cursorLine] ?? '').slice(0, cursorCol)
        const start = beforeCursor.lastIndexOf('$')
        if (start < 0) return null
        const prefix = beforeCursor.slice(start)
        return {
          items: [
            { value: '$note', label: '$note', description: 'Notes skill' },
            { value: '$notes', label: '$notes', description: 'Expanded notes skill' },
          ],
          prefix,
        }
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        const next = [...lines]
        const before = next[cursorLine] ?? ''
        const start = cursorCol - prefix.length
        next[cursorLine] = `${before.slice(0, start)}${item.value} ${before.slice(cursorCol)}`
        return { lines: next, cursorLine, cursorCol: start + item.value.length + 1 }
      },
    })

    editor.handleInput('$')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(editor.isShowingAutocomplete()).toBe(true)
    const rendered = editor.render(80)
    const suggestionIndex = rendered.findIndex((line) => line.includes('$note'))
    const inputIndex = rendered.findIndex((line) => line.includes('$') && !line.includes('$note') && !line.includes('$notes'))
    expect(suggestionIndex).toBeGreaterThanOrEqual(0)
    expect(inputIndex).toBeGreaterThan(suggestionIndex)

    editor.handleInput('n')
    editor.handleInput('o')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(editor.getText()).toBe('$no')
    expect(editor.isShowingAutocomplete()).toBe(true)

    editor.handleInput('\t')
    expect(editor.getText()).toBe('$note ')
    expect(editor.isShowingAutocomplete()).toBe(false)
  })
})
