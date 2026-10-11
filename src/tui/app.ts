import type { AgentMessage, ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { AuthEvent, AuthPrompt, AuthType } from '@earendil-works/pi-ai'
import {
  TUI,
  ProcessTerminal,
  Container,
  Text,
  Spacer,
  SelectList,
  type SelectItem,
  type Component,
  type AutocompleteProvider,
  type SlashCommand,
} from '@earendil-works/pi-tui'
import chalk from 'chalk'
import { createTwoFilesPatch } from 'diff'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { networkInterfaces } from 'node:os'
import { getAllModels, getModels, resolveApiKey } from '../models/index.ts'
import { getProviderAuthChoices, type ProviderAuthChoice } from '../models/authChoices.ts'
import { theme, getEditorTheme, getMarkdownTheme, getBashModeBorderColor } from './theme.ts'
import { MicrocodeEditor } from './components/microcodeEditor.ts'
import { FooterComponent } from './components/footer.ts'
import { AppLayout } from './components/appLayout.ts'
import { AssistantMessageComponent } from './components/assistantMessage.ts'
import { WelcomeBanner } from './components/welcomeBanner.ts'
import {
  getAgentActivityLabel,
  transitionAgentActivity,
  type AgentActivityEvent,
  type AgentActivityState,
} from './agentActivity.ts'
import { ToolExecutionComponent } from './components/toolExecution.ts'
import { BashExecutionComponent } from './components/bashExecution.ts'
import { parseBashInput } from './bashInput.ts'
import { dispatchToolLifecycle, getToolDefinition, getToolUIConstructor, type ToolUIComponent } from '../tools/registry.ts'
import { UserMessage } from './components/userMessage.ts'
import { ChatTranscript, TurnTimeline } from './components/turnTimeline.ts'
import { InlineSelectPrompt } from './components/inlineSelectPrompt.ts'
import type { ImageContent } from '@earendil-works/pi-ai'
import { modelSupportsImages } from '../models/index.ts'
import {
  collectImagePathsFromText,
  stripImagePathsFromText,
  tryReadImageFromPath,
  storeImage,
  type CachedImage,
} from '../utils/imageUtils.ts'
import { readClipboardImage } from '../utils/clipboardImage.ts'
import { resolve } from 'path'
import type { McpClientManager } from '../mcp/client.ts'
import type { McpServerState } from '../mcp/types.ts'
import { discoverMcpCapabilities, type McpCapabilitiesResult } from '../mcp/capabilities.ts'
import type { PluginManager } from '../plugins/PluginManager.ts'
import type { PluginScope, PluginSnapshot } from '../plugins/types.ts'
import { TOOL_NAME as BASH_TOOL_NAME } from '../tools/BashTool/BashTool.ts'
import { TOOL_NAME as READ_TOOL_NAME } from '../tools/FileReadTool/FileReadTool.ts'
import { TOOL_NAME as WRITE_TOOL_NAME } from '../tools/FileWriteTool/FileWriteTool.ts'
import { TOOL_NAME as EDIT_TOOL_NAME } from '../tools/FileEditTool/FileEditTool.ts'
import { SessionManager } from '../session/SessionManager.ts'
import { exportSessionJsonl } from '../session/exportSession.ts'
import { DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES, loadProjectInstructions } from '../instructions/projectInstructions.ts'
import { buildInitTaskPrompt, extractInitDraft, getInitProjectFileOutline } from '../instructions/initProjectGuidance.ts'
import { readMicroFile, writeMicroFile, type MicroFileSnapshot } from '../instructions/writeMicroFile.ts'
import type { MicrocodeAgent, MicrocodeAgentEvent } from '../agent/index.ts'
import { type PermissionMode, PERMISSION_MODES } from '../permissions/index.ts'
import type { TaskList } from '../tasks/TaskSystem.ts'
import { MultiSelectList, type MultiSelectItem } from './components/multiSelectList.ts'
import { applyWorkspaceFileCompletion, buildWorkspaceFileContext, filterWorkspaceFiles, formatFileMention, getMentionedImagePaths, listWorkspaceFiles } from './workspaceFiles.ts'
import { applySkillCompletion, buildSkillMentionContext, filterInvocableSkills, highlightSkillMatch, stripInjectedSkillContextForDisplay } from './skillMentions.ts'
import { applyPluginCompletion, buildPluginMentionContext, filterMentionablePlugins, highlightPluginMatch, isPluginAutocompleteContext } from './pluginMentions.ts'
import { createSessionTitle, normalizeSessionTitle } from './sessionTitle.ts'
import {
  canRunGitCommand,
  GitRepository,
  parseGitCommand,
  requiresGitConfirmation,
  type GitCommand,
  type GitFileChange,
} from '../git/index.ts'



declare const MACRO: {
  VERSION: string
}

const APP_NAME = 'Microcode'
const INTERACTIVE_SHELL_COMMANDS = new Set(['node', 'codex', 'claude', 'microcode'])
const NON_INTERACTIVE_FLAGS = new Set(['--help', '-h', '--version', '-v'])
const MICROCODE_NON_INTERACTIVE_SUBCOMMANDS = new Set(['mcp', 'model'])

interface GatewayAuthControl {
  listProviders(): Promise<Array<{ id: string; name: string; authChoices: ProviderAuthChoice[] }>>
  getAuthStatus(): Promise<Array<{ providerId: string; configured: boolean; type?: AuthType; error?: boolean }>>
  login(providerId: string, authType: AuthType, interaction: {
    signal: AbortSignal
    prompt(prompt: AuthPrompt): Promise<string>
    notify(event: AuthEvent): void
  }): Promise<void>
  logout(providerId: string): Promise<void>
}

interface GatewayBindControl {
  getBindHost(): string
  setBindHost(host: string): Promise<void>
}

function splitShellWords(command: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaping = false

  for (const ch of command.trim()) {
    if (escaping) {
      current += ch
      escaping = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaping = true
      continue
    }
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch
      continue
    }
    if (ch === quote) {
      quote = undefined
      continue
    }
    if (/\s/.test(ch) && !quote) {
      if (current) {
        words.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }

  if (current) words.push(current)
  return words
}

function getShellConfig(): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    if (process.env.PSModulePath || process.env.SHELL?.includes('powershell')) {
      return { shell: 'powershell.exe', args: ['-NoProfile', '-Command'] }
    }
    return { shell: 'cmd.exe', args: ['/c'] }
  }
  return { shell: '/bin/bash', args: ['-c'] }
}

export function isBareInteractiveCommand(command: string): boolean {
  if (/[|&;<>()]/.test(command)) return false
  const words = splitShellWords(command)
  const first = words[0]?.split(/[\\/]/).at(-1)
  if (!first || !INTERACTIVE_SHELL_COMMANDS.has(first)) return false
  if (words.length === 1) return true
  if (words.some((word) => NON_INTERACTIVE_FLAGS.has(word))) return false
  if (first === 'node') return false
  if (first === 'microcode' && MICROCODE_NON_INTERACTIVE_SUBCOMMANDS.has(words[1])) return false
  return true
}

const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'clear', description: 'Clear the conversation history' },
  { name: 'compact', description: 'Compress conversation context (usage: /compact [instructions])', argumentHint: '[instructions]' },
  { name: 'status', description: 'Show context usage, token statistics, and model details' },
  { name: 'model', description: 'Browse providers and select a model (usage: /model [provider/model])', argumentHint: '[provider/model]' },
  { name: 'login', description: 'Sign in to a model provider (usage: /login <provider> [api_key|oauth])', argumentHint: '<provider> [api_key|oauth]' },
  { name: 'logout', description: 'Sign out of a model provider (usage: /logout <provider>)', argumentHint: '<provider>' },
  { name: 'auth', description: 'Show provider authentication status' },
  { name: 'gateway', description: 'View or change the Model Gateway listen address (usage: /gateway [HOST])', argumentHint: '[HOST]' },
  { name: 'thinking', description: 'Show or set thinking depth (usage: /thinking [level])', argumentHint: '[off|minimal|low|medium|high|xhigh|max]' },
  { name: 'mcp', description: 'List MCP servers' },
  { name: 'session', description: 'Browse and load saved sessions', argumentHint: '' },
  { name: 'export', description: 'Export the current conversation JSONL into .microcode/' },
  { name: 'init', description: 'Analyze the project and create or update MICRO.md' },
  { name: 'instructions', description: 'Show or reload project instruction files', argumentHint: '[reload]' },
  { name: 'tasks', description: 'Browse tasks and prioritize unfinished work in the current session', argumentHint: '' },
  { name: 'new', description: 'Start a new conversation session' },
  { name: 'permission', description: 'Show or switch permission mode (usage: /permission [mode])', argumentHint: '[mode]' },
  { name: 'skills', description: 'List, enable, or disable skills' },
  { name: 'plugins', description: 'List and enable or disable plugins' },
  { name: 'git', description: 'Inspect and manage the current Git repository' },
  { name: 'exit', description: 'Exit Microcode' },
  { name: 'help', description: 'Show help and available commands' },
]

export class App {
  private ui: TUI
  private headerContainer: Container
  private chatContainer: ChatTranscript
  private statusContainer: Container
  private editorContainer: Container
  private workingContainer: Container
  private agent: MicrocodeAgent
  private editor!: MicrocodeEditor
  private footer: FooterComponent
  private appLayout!: AppLayout
  private isInitialized = false
  private streamingComponent?: AssistantMessageComponent
  private streamingMessage?: AssistantMessage
  private pendingTools = new Map<string, ToolUIComponent>()
  private pendingToolStartedAt = new Map<string, number>()
  private streamingToolLastRenderAt = new Map<string, number>()
  private toolCallMetadata = new Map<string, { name: string; args: Record<string, unknown> }>()
  private toolRows = new Map<string, ToolUIComponent>()
  private activeTurnTimeline?: TurnTimeline
  private turnFinalized = false
  private activityState: AgentActivityState = { phase: 'idle' }
  private toolElapsedTimer?: ReturnType<typeof setInterval>
  private agentWorking = false
  private lastSigintTime = 0
  private mcpClient?: McpClientManager
  private queuedMcpClient?: McpClientManager
  private pluginManager?: PluginManager
  private onPluginsChanged?: (snapshot?: PluginSnapshot) => Promise<void>
  private pluginDiscoveryRefresh?: Promise<PluginSnapshot>
  private pluginDiscoveryRefreshedAt = 0
  private pluginRuntimeRefreshPending = false
  private sessionManager: SessionManager
  private compacting = false
  private permissionPromptActive = false
  private pendingEventsWhilePermission: Array<() => void> = []
  private isBashMode = false
  private bashComponent?: BashExecutionComponent
  private activeBashProcess?: ChildProcessWithoutNullStreams
  private bashCancelRequested = false
  private gitOperationActive = false
  private startupWarnings: string[] = []
  private startupMessages: Array<{ message: string; kind: 'success' | 'error' }> = []
  private pendingImages: CachedImage[] = []
  private workspaceFileIndex?: Promise<string[]>
  private workspaceFileIndexUpdatedAt = 0
  private imagePathProcessing = false
  private suppressTrailingQuote = false
  private titleGenerated = false
  private firstUserInputForTitle?: string
  private workingText: Text | null = null
  private agentActivityLabel = 'Working…'
  private modelCompletion?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessage>
  private modelCatalog?: { getProjectModels(): readonly Model<Api>[] }
  private modelAuth?: GatewayAuthControl
  private gatewayBindControl?: GatewayBindControl
  private workingStartedAt = 0
  private workingFrameIndex = 0
  private workingTimer: ReturnType<typeof setInterval> | undefined
  private mouseTrackingEnabled = false
  onExit?: () => void | Promise<void>

  constructor(
    agent: MicrocodeAgent,
    mcpClient?: McpClientManager,
    sessionManager?: SessionManager,
    modelCompletion?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessage>,
    modelCatalog?: { getProjectModels(): readonly Model<Api>[] },
    modelAuth?: GatewayAuthControl,
    gatewayBindControl?: GatewayBindControl,
  ) {
    this.agent = agent
    this.mcpClient = mcpClient
    this.sessionManager = sessionManager ?? new SessionManager()
    this.modelCompletion = modelCompletion
    this.modelCatalog = modelCatalog
    this.modelAuth = modelAuth
    this.gatewayBindControl = gatewayBindControl
    this.agent.setPersistence(this.sessionManager)
    this.ui = new TUI(new ProcessTerminal())
    // Clear stale rows when a long injected prompt disappears; otherwise Windows consoles can retain it below the footer.
    this.ui.setClearOnShrink(true)
    this.headerContainer = new Container()
    this.chatContainer = new ChatTranscript()
    this.statusContainer = new Container()
    this.editorContainer = new Container()
    this.workingContainer = new Container()
    this.footer = new FooterComponent(
      agent,
      process.cwd(),
    )
  }

  getSessionManager(): SessionManager {
    return this.sessionManager
  }

  setPluginManager(manager: PluginManager, onChanged: (snapshot?: PluginSnapshot) => Promise<void>): void {
    this.pluginManager = manager
    this.onPluginsChanged = onChanged
  }

  /** Queue a warning to be shown in the chat area after TUI initializes. */
  addStartupWarning(message: string): void {
    this.startupWarnings.push(message)
  }

  /** Queue a durable gateway startup result for the visible transcript. */
  addStartupMessage(message: string, kind: 'success' | 'error'): void {
    this.startupMessages.push({ message, kind })
  }

  private renderStartupMessages(): void {
    for (const { message, kind } of this.startupMessages) {
      const color = kind === 'success' ? theme.fg('success', `✓ ${message}`) : theme.fg('error', `✗ ${message}`)
      this.chatContainer.addChild(new Text(color, 1, 0))
      this.chatContainer.addChild(new Spacer(1))
    }
    if (this.startupMessages.length > 0) this.ui.requestRender()
  }

  async run(): Promise<void> {
    this.init()
    this.setupAgentSubscription()
    this.restoreInitialSessionHistory()

    // Show existing session title in footer (e.g., from --resume)
    const currentId = this.sessionManager.getSessionId()
    if (currentId) {
      const existingTitle = this.sessionManager.getTitle(currentId)
      if (existingTitle) {
        this.titleGenerated = true
        this.footer.setSessionTitle(existingTitle)
        this.footer.invalidate()
        this.ui.requestRender()
      }
    }

    // Show any queued startup warnings
    for (const msg of this.startupWarnings) {
      this.chatContainer.addChild(new Text(chalk.hex('#ffff00')(`⚠ ${msg}`), 1, 0))
      this.chatContainer.addChild(new Spacer(1))
    }
    if (this.startupWarnings.length > 0) {
      this.ui.requestRender()
    }

    this.renderStartupMessages()

    // Main interactive loop
    while (true) {
      const rawInput = await this.getUserInput()
      if (!rawInput.trim()) continue

      // Handle bash commands (! for normal, !! for excluded from context)
      const bashInput = parseBashInput(rawInput)
      if (bashInput) {
        if (bashInput.command) {
          await this.handleBashCommand(bashInput.command, bashInput.excludeFromContext)
          this.isBashMode = false
        }
        continue
      }

      // Handle slash commands locally
      if (rawInput.startsWith('/')) {
        const handled = this.handleSlashCommand(rawInput.trim())
        if (handled) continue
      }

      // --- Image processing at submit time ---
      // If pendingImages were already populated by onChange, skip re-scanning.
      const imagePaths = this.pendingImages.length === 0
        ? collectImagePathsFromText(rawInput)
        : []
      const userInput = stripImagePathsFromText(rawInput)

      if (imagePaths.length > 0) {
        if (modelSupportsImages(this.agent.getCurrentModel())) {
          for (const filePath of imagePaths) {
            const image = tryReadImageFromPath(filePath)
            if (image) {
              await this.sessionManager.ensureCreated(process.cwd())
              const sessionId = this.sessionManager.getSessionId() ?? 'unknown'
              const { cachePath, fileName } = storeImage(image.data, image.mimeType, sessionId)
              this.pendingImages.push({ cachePath, fileName, mimeType: image.mimeType, base64Data: image.data })
            }
          }
        } else {
          this.showStatus(
            chalk.hex('#ffff00')(
              'Warning: Current model does not support image input. Switch to a vision-capable model (e.g. Gemini, MiMo v2.5).',
            ),
          )
        }
      }

      await this.addMentionedImages(userInput)

      // Skip if nothing to send (no text and no images)
      const images = this.getPendingImageContents()
      if (!userInput.trim() && images.length === 0) continue
      await this.sessionManager.ensureCreated(process.cwd())
      if (!this.titleGenerated && this.firstUserInputForTitle === undefined &&
        !this.agent.getMessages().some((message) => message.role === 'user')) {
        this.firstUserInputForTitle = userInput
      }

      // Start a new visual turn in the chat timeline.
      this.activeTurnTimeline = new TurnTimeline()
      this.activeTurnTimeline.addEntry(new UserMessage(userInput, images.length > 0 ? images : undefined), 'user')
      this.chatContainer.addChild(this.activeTurnTimeline)
      this.turnFinalized = false
      this.ui.requestRender()

      try {
        await this.refreshPluginDiscovery(true)
        const withFileContext = await this.addMentionedFileContext(userInput)
        const withSkillContext = buildSkillMentionContext(
          withFileContext,
          this.agent.getSkills().filter((skill) => !this.agent.isSkillLoaded(skill.name)),
          userInput,
        )
        const promptInput = buildPluginMentionContext(withSkillContext, this.pluginManager?.getPlugins() ?? [], userInput)
        if (images.length > 0) {
          await this.agent.prompt(promptInput, images)
        } else {
          await this.agent.prompt(promptInput)
        }
        this.clearPendingImages()
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
        this.appendTurnEntry(new Text(chalk.hex('#cc6666')(`Error: ${errorMessage}`), 1, 0))
        this.finishTurn()
        this.activeTurnTimeline = undefined
        this.ui.requestRender()
      }
    }
  }

  private init(): void {
    if (this.isInitialized) return

    this.headerContainer.addChild(new WelcomeBanner())

    // Editor with border
    this.editor = new MicrocodeEditor(this.ui, getEditorTheme(), { paddingX: 1 })
    this.editor.getPluginNames = () => (this.pluginManager?.getPlugins() ?? []).filter((plugin) => plugin.enabled).map((plugin) => plugin.name)

    // Set up slash command autocomplete
    this.setupSlashCommands()

    this.editor.onSubmit = (text: string) => {
      this.handleEditorSubmit(text)
    }

    // Detect bash mode (! prefix)
    this.editor.onChange = (text: string) => {
      const wasBashMode = this.isBashMode
      this.isBashMode = text.trimStart().startsWith('!')
      if (wasBashMode !== this.isBashMode) {
        this.updateEditorBorderColor()
      }

      if (this.imagePathProcessing) return

      // Suppress trailing quote left behind after an image path was stripped.
      // Terminal drag-drop sends characters one by one. When a path is quoted
      // (e.g. '/path/file.jpg'), the regex may match before the closing quote
      // arrives. After we replace the path with a placeholder, the closing quote
      // arrives as a separate event — strip it from the end of the text.
      if (this.suppressTrailingQuote) {
        this.suppressTrailingQuote = false
        if (text.endsWith("'") || text.endsWith('"')) {
          this.editor.setText(text.slice(0, -1))
          return
        }
      }

      // Scan for image file paths.
      // Quoted paths (with spaces) require both quotes to match, so the closing
      // quote has already arrived and processing is safe.
      // Unquoted paths match immediately; the trailing quote (if any) will be
      // handled by suppressTrailingQuote above on the next onChange.
      const imagePaths = collectImagePathsFromText(text)
      if (imagePaths.length > 0) {
        this.imagePathProcessing = true

        const newImages: CachedImage[] = []
        if (modelSupportsImages(this.agent.getCurrentModel())) {
          for (const filePath of imagePaths) {
            const image = tryReadImageFromPath(filePath)
            if (image) {
              const sessionId = this.sessionManager.getSessionId() ?? 'unknown'
              const { cachePath, fileName } = storeImage(image.data, image.mimeType, sessionId)
              newImages.push({ cachePath, fileName, mimeType: image.mimeType, base64Data: image.data })
            }
          }
        } else {
          this.showStatus(
            chalk.hex('#ffff00')(
              'Warning: Current model does not support image input. Switch to a vision-capable model.',
            ),
          )
        }

        this.pendingImages = newImages

        let clean = stripImagePathsFromText(text)
        if (newImages.length > 0) {
          const markers = newImages.map(img => `[Image: ${img.fileName}]`).join(' ')
          clean = clean ? `${clean} ${markers}` : markers
        }
        // setText triggers onChange synchronously; imagePathProcessing guard
        // prevents the suppressTrailingQuote check from firing prematurely.
        this.editor.setText(clean)
        this.suppressTrailingQuote = true
        this.imagePathProcessing = false
      }
    }

    // App-level key handlers on the Editor (pi-coding-agent pattern)
    this.editor.onEscape = () => {
      const now = Date.now()
      if (now - this.lastSigintTime < 500) {
        this.exit()
        return
      }
      this.lastSigintTime = now
      if (this.activeBashProcess) {
        this.cancelBashCommand()
      } else if (this.isAgentBusy()) {
        this.agent.abort()
      } else {
        this.editor.setText('')
      }
    }
    this.editor.onCtrlC = () => {
      if (this.permissionPromptActive) {
        this.exit()
      } else if (this.activeBashProcess) {
        this.cancelBashCommand()
      } else if (this.isAgentBusy()) {
        this.agent.abort()
      } else {
        this.exit()
      }
    }
    this.editor.onCtrlD = () => {
      this.exit()
    }
    this.editor.onPasteImage = () => {
      void this.pasteClipboardImage()
    }

    this.ui.addInputListener((data) => {
      if (this.appLayout.handleInput(data, this.editor.isShowingAutocomplete())) {
        this.ui.requestRender()
        return { consume: true }
      }
      return undefined
    })

    this.editorContainer.addChild(this.editor)

    // 输入区固定在终端底部；对话内容只使用它上方的剩余空间。
    this.appLayout = new AppLayout(
      this.headerContainer,
      this.chatContainer,
      [this.statusContainer, this.editorContainer, this.workingContainer, this.footer],
      () => this.ui.terminal.rows,
      (width) => this.chatContainer.getToolInteractionTargets(width),
    )
    this.ui.addChild(this.appLayout)

    this.ui.setFocus(this.editor)
    this.ui.start()
    // Enable SGR mouse reporting with button-drag events for the conversation scrollbar.
    this.ui.terminal.write('\x1b[?1002h\x1b[?1006h')
    this.mouseTrackingEnabled = true
    this.isInitialized = true
  }

  private setupSlashCommands(): void {
    const provider: AutocompleteProvider = {
      getSuggestions: async (
        lines: string[],
        cursorLine: number,
        cursorCol: number,
        _options: { signal: AbortSignal; force?: boolean },
      ) => {
        const currentLine = lines[cursorLine] ?? ''
        const textBeforeCursor = currentLine.slice(0, cursorCol)

        const hashIndex = textBeforeCursor.lastIndexOf('#')
        const hashPrefix = hashIndex >= 0 ? textBeforeCursor.slice(hashIndex) : ''
        if (isPluginAutocompleteContext(textBeforeCursor) && hashPrefix.startsWith('#')) {
          await this.refreshPluginDiscovery(false, false)
          const query = hashPrefix.slice(1).toLowerCase()
          const matches = filterMentionablePlugins(this.pluginManager?.getPlugins() ?? [], query).slice(0, 100)
          if (matches.length === 0) return null
          return {
            items: matches.map((plugin) => ({
              value: `#${plugin.name}`,
              label: highlightPluginMatch(`#${plugin.name}`, query, (match) => chalk.cyan.bold(match)),
              description: plugin.description,
            })),
            prefix: hashPrefix,
          }
        }

        const dollarIndex = textBeforeCursor.lastIndexOf('$')
        const dollarPrefix = dollarIndex >= 0 ? textBeforeCursor.slice(dollarIndex) : ''
        const isSkillMention = dollarPrefix.startsWith('$') &&
          (dollarIndex === 0 || /[\s([{]/.test(textBeforeCursor[dollarIndex - 1] ?? ''))
        if (isSkillMention) {
          const query = dollarPrefix.slice(1).toLowerCase()
          const matches = filterInvocableSkills(this.agent.getSkills(), query).slice(0, 100)
          if (matches.length === 0) return null
          return {
            items: matches.map((skill) => ({
              value: `$${skill.name}`,
              label: highlightSkillMatch(`$${skill.name}`, query, (match) => chalk.cyan.bold(match)),
              description: skill.description,
            })),
            prefix: dollarPrefix,
          }
        }

        const atIndex = textBeforeCursor.lastIndexOf('@')
        const atPrefix = atIndex >= 0 ? textBeforeCursor.slice(atIndex) : ''
        const isFileMention = atPrefix.startsWith('@') &&
          (atIndex === 0 || /[\s([{]/.test(textBeforeCursor[atIndex - 1] ?? ''))
        if (isFileMention) {
          const query = atPrefix.startsWith('@"')
            ? atPrefix.slice(2).toLowerCase()
            : atPrefix.slice(1).toLowerCase()
          const files = await this.getWorkspaceFiles(query.length === 0)
          const matches = filterWorkspaceFiles(files, query).slice(0, 100)
          if (matches.length === 0) return null
          return {
            items: matches.map((path) => ({
              value: formatFileMention(path),
              label: path,
              description: 'Workspace file',
            })),
            prefix: atPrefix,
          }
        }

        if (!textBeforeCursor.startsWith('/')) return null

        const query = textBeforeCursor.slice(1).toLowerCase()
        const builtinMatches = BUILTIN_SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(query))

        const allMatches = builtinMatches.map((cmd) => ({
          value: `/${cmd.name}`,
          label: `/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ''}`,
          description: cmd.description ?? '',
        }))

        if (allMatches.length === 0) return null

        return {
          items: allMatches,
          prefix: textBeforeCursor,
        }
      },

      applyCompletion: (
        lines: string[],
        cursorLine: number,
        _cursorCol: number,
        item: { value: string; label: string; description?: string },
        _prefix: string,
      ) => {
        const newLines = [...lines]
        if (_prefix.startsWith('$')) {
          return applySkillCompletion(lines, cursorLine, _cursorCol, _prefix, item.value.slice(1))
        }
        if (_prefix.startsWith('#')) {
          return applyPluginCompletion(lines, cursorLine, _cursorCol, _prefix, item.value.slice(1))
        }
        if (_prefix.startsWith('@')) {
          return applyWorkspaceFileCompletion(lines, cursorLine, _cursorCol, _prefix, item.label)
        }
        newLines[cursorLine] = item.value + ' '
        return {
          lines: newLines,
          cursorLine,
          cursorCol: item.value.length + 1,
        }
      },
    }

    this.editor.setAutocompleteProvider(provider)
  }

  private async addMentionedFileContext(input: string): Promise<string> {
    const cwd = this.agent.getSnapshot().cwd
    const indexedFiles = new Set(await this.getWorkspaceFiles())
    return buildWorkspaceFileContext(cwd, input, indexedFiles, async (path) => {
      return this.authorizeMentionedFileRead(cwd, path)
    })
  }

  private async addMentionedImages(input: string): Promise<void> {
    const cwd = this.agent.getSnapshot().cwd
    const indexedFiles = new Set(await this.getWorkspaceFiles(true))
    const paths = getMentionedImagePaths(input, indexedFiles)
    if (paths.length === 0) return
    if (!modelSupportsImages(this.agent.getCurrentModel())) {
      this.showStatus('Current model does not support image input. Switch to a vision-capable model.')
      return
    }

    for (const path of paths) {
      if (!await this.authorizeMentionedFileRead(cwd, path)) continue
      const image = tryReadImageFromPath(resolve(cwd, path))
      if (!image) continue
      await this.sessionManager.ensureCreated(cwd)
      const sessionId = this.sessionManager.getSessionId() ?? 'unknown'
      const stored = storeImage(image.data, image.mimeType, sessionId)
      this.pendingImages.push({
        cachePath: stored.cachePath,
        fileName: stored.fileName,
        mimeType: image.mimeType,
        base64Data: image.data,
      })
    }
  }

  private async getWorkspaceFiles(forceRefresh = false): Promise<string[]> {
    const stale = Date.now() - this.workspaceFileIndexUpdatedAt >= 500
    if (forceRefresh || stale || !this.workspaceFileIndex) {
      this.workspaceFileIndexUpdatedAt = Date.now()
      this.workspaceFileIndex = listWorkspaceFiles(this.agent.getSnapshot().cwd)
    }
    return this.workspaceFileIndex
  }

  private async authorizeMentionedFileRead(cwd: string, path: string): Promise<boolean> {
    const permissionInput = { file_path: resolve(cwd, path) }
    const permission = this.agent.checkPermission(READ_TOOL_NAME, permissionInput)
    if (permission.allowed) return true
    if (permission.reason !== 'ask') return false
    return this.agent.requestToolPermission(
      READ_TOOL_NAME,
      permissionInput,
      `Read workspace file ${path} as context for this message`,
    )
  }

  private async pasteClipboardImage(): Promise<void> {
    const image = await readClipboardImage()
    if (!image) {
      this.showStatus('Clipboard has no supported image, or image clipboard access is unavailable.')
      return
    }
    if (!modelSupportsImages(this.agent.getCurrentModel())) {
      this.showStatus('Current model does not support image input. Switch to a vision-capable model.')
      return
    }
    const sessionId = this.sessionManager.getSessionId() ?? 'unknown'
    const stored = storeImage(image.data, image.mimeType, sessionId)
    const cached: CachedImage = {
      cachePath: stored.cachePath,
      fileName: stored.fileName,
      mimeType: image.mimeType,
      base64Data: image.data,
    }
    this.pendingImages.push(cached)
    this.imagePathProcessing = true
    const currentText = this.editor.getText()
    const marker = `[Image: ${cached.fileName}]`
    this.editor.setText(currentText ? `${currentText} ${marker}` : marker)
    this.imagePathProcessing = false
    this.showStatus(`Added clipboard image ${cached.fileName}.`)
  }

  private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
    // Create UI component for display
    this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext)
    this.chatContainer.addChild(this.bashComponent)
    this.ui.requestRender()

    if (isBareInteractiveCommand(command)) {
      this.bashComponent.appendOutput(
        'This command starts an interactive terminal session, which cannot run inside Microcode\'s inline shell.\n' +
        'Run it in a separate terminal, or pass a non-interactive flag/subcommand such as --help, --version, or an explicit script.\n',
      )
      this.bashComponent.setComplete(undefined, true)
      this.bashComponent = undefined
      this.updateEditorBorderColor()
      this.ui.requestRender()
      return
    }

    try {
      const { spawn } = await import('child_process')
      const { shell, args } = getShellConfig()
      const component = this.bashComponent
      this.bashCancelRequested = false

      await new Promise<void>((resolve) => {
        const child = spawn(shell, [...args, command], {
          cwd: process.cwd(),
          detached: process.platform !== 'win32',
          stdio: 'pipe',
          windowsHide: true,
        })

        this.activeBashProcess = child
        child.stdin.end()

        child.stdout.on('data', (data: Buffer) => {
          component?.appendOutput(data.toString())
          this.ui.requestRender()
        })
        child.stderr.on('data', (data: Buffer) => {
          component?.appendOutput(data.toString())
          this.ui.requestRender()
        })

        child.on('close', (code) => {
          if (this.activeBashProcess === child) {
            this.activeBashProcess = undefined
          }
          component?.setComplete(code ?? undefined, this.bashCancelRequested)
          this.bashCancelRequested = false
          if (this.bashComponent === component) {
            this.bashComponent = undefined
          }
          this.updateEditorBorderColor()
          this.footer.invalidate()
          this.ui.requestRender()
          resolve()
        })

        child.on('error', (error) => {
          if (this.activeBashProcess === child) {
            this.activeBashProcess = undefined
          }
          component?.appendOutput(`Failed to start command: ${error.message}\n`)
          component?.setComplete(undefined, false)
          this.bashCancelRequested = false
          if (this.bashComponent === component) {
            this.bashComponent = undefined
          }
          this.updateEditorBorderColor()
          this.footer.invalidate()
          this.ui.requestRender()
          resolve()
        })
      })
    } catch (error) {
      if (this.bashComponent) {
        this.bashComponent.setComplete(undefined, false)
      }
      this.showError(`Bash command failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      this.activeBashProcess = undefined
      this.bashCancelRequested = false
      this.bashComponent = undefined
      this.updateEditorBorderColor()
    }
  }

  private cancelBashCommand(): void {
    const child = this.activeBashProcess
    if (!child) return

    this.bashCancelRequested = true
    try {
      if (process.platform !== 'win32' && child.pid) {
        process.kill(-child.pid, 'SIGTERM')
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      try {
        child.kill('SIGTERM')
      } catch {}
    }

    setTimeout(() => {
      if (this.activeBashProcess !== child) return
      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, 'SIGKILL')
        } else {
          child.kill('SIGKILL')
        }
      } catch {}
    }, 1000).unref()
  }

  private updateEditorBorderColor(): void {
    if (this.isBashMode) {
      this.editor.borderColor = getBashModeBorderColor()
    } else {
      this.editor.borderColor = (text: string) => theme.fg('blue', text)
    }
    this.ui.requestRender()
  }

  private handleSlashCommand(input: string): boolean {
    this.editor.addToHistory(input)
    const trimmedInput = input.trim()
    const commandEnd = trimmedInput.search(/\s/)
    const command = (commandEnd < 0 ? trimmedInput : trimmedInput.slice(0, commandEnd)).toLowerCase()
    const args = commandEnd < 0 ? '' : trimmedInput.slice(commandEnd).trimStart()

    switch (command) {
      case '/clear':
        this.chatContainer.clear()
        this.activeTurnTimeline = undefined
        this.toolRows.clear()
        this.pendingTools.clear()
        this.turnFinalized = false
        this.showStatus('Conversation cleared.')
        return true

      case '/compact':
        this.handleCompactCommand(args)
        return true

      case '/status':
        this.handleStatusCommand()
        return true

      case '/model':
        void this.handleModelCommand(args || undefined)
        return true

      case '/login':
        void this.handleAuthCommand('login', args)
        return true

      case '/logout':
        void this.handleAuthCommand('logout', args)
        return true

      case '/auth':
        void this.handleAuthCommand('status', args)
        return true

      case '/gateway':
        void this.handleGatewayCommand(args)
        return true

      case '/mcp':
        void this.handleMcpCommand(args)
        return true

      case '/session':
        this.handleSessionCommand(args)
        return true

      case '/export':
        void this.handleExportCommand()
        return true

      case '/init':
        void this.handleInitCommand()
        return true

      case '/instructions':
        void this.handleInstructionsCommand(args)
        return true

      case '/tasks':
        this.handleTasksCommand()
        return true


      case '/permission':
        this.handlePermissionCommand(args)
        return true

      case '/thinking':
        this.handleThinkingCommand(args)
        return true

      case '/skills':
        this.handleSkillsCommand()
        return true

      case '/plugins':
        void this.handlePluginsCommand()
        return true

      case '/git':
        void this.handleGitCommand(args)
        return true

      case '/exit':
        this.exit()
        return true

      case '/new':
        this.handleNewSession()
        return true

      case '/help':
        this.showHelp()
        return true

      default: {
        this.showError(`Unknown command: ${command}. Type /help for available commands.`)
        return true
      }
    }
  }

  private async handleExportCommand(): Promise<void> {
    try {
      await this.agent.persistMessages()
      const metadata = this.sessionManager.getMetadata()
      if (!metadata) {
        this.showError('There is no saved conversation to export yet.')
        return
      }

      const destinationPath = await exportSessionJsonl(metadata.path, process.cwd(), metadata.id)
      this.showStatus(`Conversation exported to ${destinationPath}`)
    } catch (error) {
      this.showError(`Could not export conversation: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async handleInitCommand(): Promise<void> {
    if (this.isAgentBusy()) {
      this.showStatus('Agent is busy — press Esc or Ctrl+C to cancel, then run /init.')
      return
    }

    const cwd = process.cwd()
    let before: MicroFileSnapshot
    try {
      before = await readMicroFile(cwd)
    } catch (error) {
      this.showError(`Could not read MICRO.md: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const targetPath = before.path
    let fileOutline: string[]
    try {
      fileOutline = await getInitProjectFileOutline(cwd)
    } catch (error) {
      this.showError(`Could not inspect project layout: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    const timeline = new TurnTimeline()
    timeline.addEntry(new UserMessage('/init'), 'user')
    this.activeTurnTimeline = timeline
    this.chatContainer.addChild(timeline)
    this.turnFinalized = false
    this.ui.requestRender()

    const messageCountBeforeInit = this.agent.getMessages().length
    let promptError: unknown
    try {
      await this.agent.promptReadOnly(buildInitTaskPrompt(cwd, fileOutline))
    } catch (error) {
      promptError = error
    }

    if (promptError) {
      this.showError(`Project initialization failed: ${promptError instanceof Error ? promptError.message : String(promptError)}`)
      return
    }

    try {
      const latestAssistant = this.agent.getMessages().slice(messageCountBeforeInit).reverse()
        .find((message): message is AssistantMessage => message.role === 'assistant')
      const response = latestAssistant?.content
        .reduce((text, block) => block.type === 'text' ? `${text}${block.text}\n` : text, '') ?? ''
      const proposal = extractInitDraft(response)
      if (proposal === undefined) {
        this.showError('The project analysis did not return a complete MICRO.md proposal. No files were changed.')
        return
      }
      if (Buffer.byteLength(proposal, 'utf8') > DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES) {
        this.showError(`The MICRO.md proposal exceeds the ${DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES}-byte project instruction limit. Ask for a shorter proposal.`)
        return
      }
      if (proposal === before.content) {
        this.showStatus('MICRO.md already matches the proposed project guidance.')
        return
      }

      const proposalDiff = createTwoFilesPatch(
        targetPath,
        targetPath,
        before.content ?? '',
        proposal,
        'current',
        'proposed',
      )
      this.chatContainer.addChild(new Spacer(1))
      this.chatContainer.addChild(new Text(proposalDiff, 1, 0))
      this.ui.requestRender()

      const decision = await this.selectAuthOption(`Apply the proposed ${targetPath}?`, [
        { value: 'apply', label: 'Apply MICRO.md', description: 'Write the reviewed proposal to this file' },
        { value: 'cancel', label: 'Cancel', description: 'Leave MICRO.md unchanged' },
      ])
      if (decision !== 'apply') {
        this.showStatus('MICRO.md update cancelled. No files were changed.')
        return
      }

      const currentInstructions = await loadProjectInstructions(cwd)
      const otherInstructionBytes = currentInstructions.files
        .filter((file) => file.path !== targetPath)
        .reduce((total, file) => total + file.bytes, 0)
      if (otherInstructionBytes + Buffer.byteLength(proposal, 'utf8') > DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES) {
        this.showError('The proposal does not fit in the remaining project instruction budget. Shorten existing instruction files or ask for a shorter MICRO.md proposal.')
        return
      }

      await writeMicroFile(cwd, before, proposal)
    } catch (error) {
      this.showError(`Could not save MICRO.md: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    try {
      const instructions = await loadProjectInstructions(cwd)
      this.agent.updateProjectInstructions(instructions)
      const loadedFile = instructions.files.find((file) => file.path === targetPath)
      if (!loadedFile || loadedFile.truncated || loadedFile.content !== proposal) {
        this.showError(`MICRO.md was saved, but the complete file could not be loaded within the ${DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES}-byte combined instruction limit.`)
        return
      }
      this.showStatus(`Project instructions saved to ${targetPath} and reloaded.`)
    } catch (error) {
      this.showError(`MICRO.md was saved, but project instructions could not be reloaded: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async handleInstructionsCommand(args: string): Promise<void> {
    const option = args.trim().toLowerCase()
    if (option && option !== 'reload') {
      this.showError('Usage: /instructions [reload]')
      return
    }

    if (option === 'reload') {
      if (this.isAgentBusy()) {
        this.showStatus('Agent is busy — wait for the current turn to finish before reloading instructions.')
        return
      }
      try {
        const instructions = await loadProjectInstructions(process.cwd())
        this.agent.updateProjectInstructions(instructions)
        this.showStatus(`Reloaded project instructions (${instructions.files.length} files, ${instructions.totalBytes} bytes).`)
        for (const diagnostic of instructions.diagnostics) {
          this.chatContainer.addChild(new Text(`  ${theme.dim(diagnostic)}`, 1, 0))
        }
        if (instructions.diagnostics.length) this.chatContainer.addChild(new Spacer(1))
        this.ui.requestRender()
      } catch (error) {
        this.showError(`Could not reload project instructions: ${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }

    const instructions = this.agent.getProjectInstructions()
    if (!instructions || instructions.files.length === 0) {
      this.showStatus('No project instruction files are currently loaded.')
    } else {
      this.showStatus(`Loaded project instructions (${instructions.totalBytes} bytes):`)
      for (const file of instructions.files) {
        this.chatContainer.addChild(new Text(`  ${file.path}${file.truncated ? ' (truncated)' : ''}`, 1, 0))
      }
      this.ui.requestRender()
    }

    for (const diagnostic of instructions?.diagnostics ?? []) {
      this.chatContainer.addChild(new Text(`  ${theme.dim(diagnostic)}`, 1, 0))
    }
    if (instructions?.diagnostics.length) {
      this.chatContainer.addChild(new Spacer(1))
      this.ui.requestRender()
    }
  }

  private async handleAuthCommand(action: 'login' | 'logout' | 'status', args: string): Promise<void> {
    if (this.modelAuth) {
      await this.handleGatewayAuthCommand(action, args, this.modelAuth)
      return
    }
    const abortController = new AbortController()
    try {
      const models = getModels()
      if (action === 'status') {
        const providers = models.getProviders()
        const statuses: SelectItem[] = []
        for (const provider of providers) {
          let status = 'not configured'
          try {
            const auth = await models.checkAuth(provider.id)
            if (auth) status = `${auth.type}${auth.source ? ` · ${auth.source}` : ''}`
          } catch (error) {
            status = `error · ${error instanceof Error ? error.message : String(error)}`
          }
          statuses.push({ value: provider.id, label: provider.name, description: `${provider.id} · ${status}` })
        }
        await this.selectAuthOption('Provider authentication status', statuses)
        return
      }

      const [providerArg, requestedType] = args.trim().split(/\s+/, 2)
      const providerId = providerArg || await this.selectAuthOption(
        action === 'login' ? 'Choose a provider to sign in' : 'Choose a provider to sign out',
        models.getProviders().map((provider) => ({ value: provider.id, label: provider.name, description: provider.id })),
      )
      if (!providerId) return
      const provider = models.getProvider(providerId)
      if (!provider) throw new Error(`Unknown provider "${providerId}". Run /auth to list providers.`)

      if (action === 'logout') {
        await models.logout(providerId)
        this.showStatus(`Signed out of ${provider.name}.`)
        return
      }

      const authChoices = getProviderAuthChoices(provider)
      if (authChoices.length === 0) {
        throw new Error(`Provider ${provider.name} has no interactive sign-in method. Configure its ambient credentials and try again.`)
      }
      const requestedAuthType: AuthType | undefined = requestedType === 'oauth' || requestedType === 'api_key'
        ? requestedType
        : undefined
      if (requestedAuthType && !authChoices.some((choice) => choice.value === requestedAuthType)) {
        throw new Error(`Provider ${provider.name} does not support ${requestedAuthType === 'oauth' ? 'OAuth' : 'interactive API key'} login.`)
      }
      const type: AuthType | undefined = requestedAuthType
        ?? (authChoices.length > 1
          ? await this.selectAuthOption(`Choose a sign-in method for ${provider.name}`, authChoices) as AuthType | undefined
          : authChoices[0]?.value)
      if (!type) return
      await models.login(providerId, type, {
        signal: abortController.signal,
        prompt: async (prompt) => {
          if (prompt.type !== 'select') return this.promptAuthValue(prompt, abortController)
          const selected = await this.selectAuthOption(prompt.message, prompt.options, prompt.signal)
          if (!selected) {
            if (!prompt.signal?.aborted) abortController.abort()
            throw new Error('Authentication cancelled.')
          }
          return selected
        },
        notify: (event) => {
          if (event.type === 'auth_url') {
            this.showStatus(`${event.instructions ?? 'Complete authorization in your browser.'} ${event.url}`)
            void this.openAuthUrl(event.url)
          } else if (event.type === 'device_code') {
            this.showStatus(`Code: ${event.userCode} · ${event.verificationUri}`)
            void this.openAuthUrl(event.verificationUri)
          } else {
            this.showStatus(event.message)
          }
        },
      })
      this.showStatus(`Signed in to ${provider.name}.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (abortController.signal.aborted || /cancel(?:led|ed)/i.test(message)) {
        if (action === 'login') this.showStatus('Sign-in cancelled.')
        return
      }
      this.showError(message)
    }
  }

  private async handleGatewayCommand(args: string): Promise<void> {
    const control = this.gatewayBindControl
    if (!control) {
      this.showStatus('Gateway address controls are unavailable in this session. Start Microcode with the Model Gateway enabled, then run /gateway.')
      return
    }
    if (this.agent.isBusy()) {
      this.showStatus('Gateway settings cannot be changed while the Agent is working. Finish or interrupt the current turn, then retry.')
      return
    }
    if (args.trim()) {
      await this.applyGatewayBindHost(args.trim())
      return
    }

    const currentHost = control.getBindHost()
    const addresses = [...new Set(Object.values(networkInterfaces()).flatMap((entries) =>
      (entries ?? [])
        .filter((entry) => !entry.internal && (entry.family === 'IPv4' || entry.family === 4))
        .map((entry) => entry.address)))]
    const choices: SelectItem[] = [
      { value: '127.0.0.1', label: 'Loopback · 127.0.0.1', description: 'Only accept connections from this computer' },
      { value: '0.0.0.0', label: 'All IPv4 interfaces · 0.0.0.0', description: 'Listen on every IPv4 network interface' },
      ...addresses.map((address) => ({
        value: address,
        label: `Network interface · ${address}`,
        description: address === currentHost ? 'Current bind address' : 'Listen only on this interface',
      })),
    ]
    if (!choices.some((choice) => choice.value === currentHost)) {
      choices.unshift({ value: currentHost, label: `Current · ${currentHost}`, description: 'Currently configured bind address' })
    }
    choices.push({ value: '__custom__', label: 'Enter an address…', description: 'Use /gateway <IP address or hostname>' })

    const list = new SelectList(choices, Math.min(choices.length, 12), {
      selectedPrefix: (text) => chalk.cyan(text),
      selectedText: (text) => chalk.cyan(text),
      description: (text) => theme.dim(text),
      scrollInfo: (text) => theme.dim(text),
      noMatch: (text) => theme.dim(text),
    })
    this.chatContainer.addChild(new Text(theme.fg('accent', 'Model Gateway listen address'), 1, 0))
    this.chatContainer.addChild(new Text(theme.dim(`Current: ${currentHost}`), 1, 0))
    this.chatContainer.addChild(list)
    this.ui.setFocus(list)
    this.ui.requestRender()

    const close = () => {
      this.chatContainer.removeChild(list)
      this.chatContainer.addChild(new Spacer(1))
      this.ui.setFocus(this.editor)
    }
    list.onSelect = (item) => {
      close()
      if (item.value === '__custom__') {
        this.editor.setText('/gateway ')
        this.ui.requestRender()
        return
      }
      void this.applyGatewayBindHost(item.value)
      this.ui.requestRender()
    }
    list.onCancel = () => {
      close()
      this.showStatus('Gateway menu closed.')
    }
  }

  private async applyGatewayBindHost(host: string): Promise<void> {
    if (this.agent.isBusy()) {
      this.showStatus('Gateway settings were not changed because the Agent became busy.')
      return
    }
    try {
      await this.gatewayBindControl?.setBindHost(host)
      this.showStatus(`Model Gateway is now listening on ${host}.`)
    } catch (error) {
      this.showError(`Could not change the gateway listen address: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async handleGatewayAuthCommand(action: 'login' | 'logout' | 'status', args: string, gateway: GatewayAuthControl): Promise<void> {
    const abortController = new AbortController()
    try {
      const providers = await gateway.listProviders()
      if (action === 'status') {
        const statuses = await gateway.getAuthStatus()
        const byId = new Map(statuses.map((status) => [status.providerId, status]))
        await this.selectAuthOption('Provider authentication status', providers.map((provider) => {
          const auth = byId.get(provider.id)
          const status = auth?.error ? 'error' : auth?.configured ? auth.type ?? 'configured' : 'not configured'
          return { value: provider.id, label: provider.name, description: `${provider.id} · ${status}` }
        }))
        return
      }

      const [providerArg, requestedType] = args.trim().split(/\s+/, 2)
      const providerId = providerArg || await this.selectAuthOption(
        action === 'login' ? 'Choose a provider to sign in' : 'Choose a provider to sign out',
        providers.map((provider) => ({ value: provider.id, label: provider.name, description: provider.id })),
      )
      if (!providerId) return
      const provider = providers.find((entry) => entry.id === providerId)
      if (!provider) throw new Error(`Unknown provider "${providerId}". Run /auth to list providers.`)

      if (action === 'logout') {
        await gateway.logout(providerId)
        this.showStatus(`Signed out of ${provider.name}.`)
        return
      }

      if (provider.authChoices.length === 0) {
        throw new Error(`Provider ${provider.name} has no interactive sign-in method. Configure its ambient credentials and try again.`)
      }
      const requestedAuthType: AuthType | undefined = requestedType === 'oauth' || requestedType === 'api_key'
        ? requestedType
        : undefined
      if (requestedAuthType && !provider.authChoices.some((choice) => choice.value === requestedAuthType)) {
        throw new Error(`Provider ${provider.name} does not support ${requestedAuthType === 'oauth' ? 'OAuth' : 'interactive API key'} login.`)
      }
      const type = requestedAuthType
        ?? (provider.authChoices.length > 1
          ? await this.selectAuthOption(`Choose a sign-in method for ${provider.name}`, provider.authChoices) as AuthType | undefined
          : provider.authChoices[0]?.value)
      if (!type) return

      await gateway.login(providerId, type, {
        signal: abortController.signal,
        prompt: async (prompt) => {
          if (prompt.type !== 'select') return this.promptAuthValue(prompt, abortController)
          const selected = await this.selectAuthOption(prompt.message, prompt.options, prompt.signal)
          if (!selected) {
            if (!prompt.signal?.aborted) abortController.abort()
            throw new Error('Authentication cancelled.')
          }
          return selected
        },
        notify: (event) => {
          if (event.type === 'auth_url') {
            this.showStatus(`${event.instructions ?? 'Complete authorization in your browser.'} ${event.url}`)
            void this.openAuthUrl(event.url)
          } else if (event.type === 'device_code') {
            this.showStatus(`Code: ${event.userCode} · ${event.verificationUri}`)
            void this.openAuthUrl(event.verificationUri)
          } else {
            this.showStatus(event.message)
          }
        },
      })
      this.showStatus(`Signed in to ${provider.name}.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (abortController.signal.aborted || /cancel(?:led|ed)/i.test(message)) {
        if (action === 'login') this.showStatus('Sign-in cancelled.')
        return
      }
      this.showError(message)
    }
  }

  private async promptAuthValue(prompt: AuthPrompt, authController?: AbortController): Promise<string> {
    if (prompt.type === 'manual_code') return this.promptAuthCode(prompt, authController)
    const placeholder = 'placeholder' in prompt ? prompt.placeholder : undefined
    const secret = prompt.type === 'secret'
    const notice = new Text(
      theme.fg('accent', `${prompt.message}${placeholder ? ` (${placeholder})` : ''} · Enter to submit · Esc to cancel`),
      1,
      0,
    )
    const inputLine = new Text('> ', 1, 0)
    this.chatContainer.addChild(notice)
    this.chatContainer.addChild(inputLine)
    this.ui.requestRender()

    return new Promise<string>((resolve, reject) => {
      let value = ''
      let settled = false
      let removeInputListener = () => {}
      const cleanup = () => {
        if (settled) return
        settled = true
        removeInputListener()
        prompt.signal?.removeEventListener('abort', onAbort)
        authController?.signal.removeEventListener('abort', onAbort)
        this.chatContainer.removeChild(inputLine)
        this.chatContainer.removeChild(notice)
        this.ui.setFocus(this.editor)
        this.ui.requestRender()
      }
      const onAbort = () => {
        cleanup()
        // A second Escape immediately after cancelling auth must not be
        // mistaken for the app-level double-Escape exit gesture.
        this.lastSigintTime = 0
        if (!authController?.signal.aborted && !prompt.signal?.aborted) authController?.abort()
        reject(new Error('Authentication cancelled.'))
      }
      const cancel = () => {
        authController?.abort()
        if (!settled) onAbort()
      }
      const updateInput = () => {
        inputLine.setText(`> ${secret ? '*'.repeat([...value].length) : value}`)
        this.ui.requestRender()
      }
      const appendText = (text: string) => {
        for (const char of text) {
          if (char === '\r' || char === '\n') continue
          if (char === '\u007f' || char === '\b') {
            value = [...value].slice(0, -1).join('')
          } else if (char >= ' ') {
            value += char
          }
        }
        updateInput()
      }

      removeInputListener = this.ui.addInputListener((data) => {
        if (data === '\u001b' || data === '\u0003' || data === '\u0004') {
          cancel()
          return { consume: true }
        }
        if (data === '\r' || data === '\n') {
          const answer = value.trim()
          if (!answer) {
            cancel()
          } else {
            cleanup()
            resolve(answer)
          }
          return { consume: true }
        }

        const pasteStart = '\u001b[200~'
        const pasteEnd = '\u001b[201~'
        if (data.startsWith(pasteStart) && data.endsWith(pasteEnd)) {
          appendText(data.slice(pasteStart.length, -pasteEnd.length))
          return { consume: true }
        }
        if (data.startsWith('\u001b[')) {
          // Let terminal reports through to TUI (for example, image cell size).
          if (/^\u001b\[6;\d+;\d+t$/.test(data)) return undefined
          return { consume: true }
        }
        appendText(data)
        return { consume: true }
      })

      prompt.signal?.addEventListener('abort', onAbort, { once: true })
      authController?.signal.addEventListener('abort', onAbort, { once: true })
      if (prompt.signal?.aborted || authController?.signal.aborted) onAbort()
    })
  }

  private promptAuthCode(prompt: Extract<AuthPrompt, { type: 'manual_code' }>, authController?: AbortController): Promise<string> {
    const previousSubmit = this.editor.onSubmit
    const previousEscape = this.editor.onEscape
    const notice = new Text(theme.fg('accent', `${prompt.message} Press Esc to cancel.`), 1, 0)
    this.chatContainer.addChild(notice)
    this.editor.setText('')
    this.ui.setFocus(this.editor)
    this.ui.requestRender()

    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        if (settled) return
        settled = true
        prompt.signal?.removeEventListener('abort', onAbort)
        authController?.signal.removeEventListener('abort', onAbort)
        this.editor.onSubmit = previousSubmit
        this.editor.onEscape = previousEscape
        this.chatContainer.removeChild(notice)
        this.editor.setText('')
        this.ui.setFocus(this.editor)
        this.ui.requestRender()
      }
      const onAbort = () => {
        cleanup()
        reject(new Error('Authentication cancelled.'))
      }
      this.editor.onSubmit = (value: string) => {
        const code = value.trim()
        if (!code) return
        cleanup()
        resolve(code)
      }
      this.editor.onEscape = () => {
        authController?.abort()
        cleanup()
        reject(new Error('Authentication cancelled.'))
      }
      if (prompt.signal?.aborted) return onAbort()
      prompt.signal?.addEventListener('abort', onAbort, { once: true })
      authController?.signal.addEventListener('abort', onAbort, { once: true })
      if (authController?.signal.aborted) onAbort()
    })
  }

  private async selectAuthOption(
    title: string,
    options: readonly { value?: string; id?: string; label: string; description?: string }[],
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (options.length === 0) return undefined
    const items: SelectItem[] = options.map((option) => ({
      value: option.value ?? option.id ?? option.label,
      label: option.label,
      description: option.description,
    }))
    const list = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (text) => chalk.cyan(text),
      selectedText: (text) => chalk.cyan(text),
      description: (text) => theme.dim(text),
      scrollInfo: (text) => theme.dim(text),
      noMatch: (text) => theme.dim(text),
    })
    const removeFilter = this.addSelectListFilter(list)
    this.editorContainer.removeChild(this.editor)
    const titleText = new Text(theme.fg('accent', title), 1, 0)
    this.chatContainer.addChild(titleText)
    this.chatContainer.addChild(list)
    this.ui.setFocus(list)
    this.ui.requestRender()
    return new Promise((resolve) => {
      let finished = false
      const finish = (value?: string) => {
        if (finished) return
        finished = true
        signal?.removeEventListener('abort', onAbort)
        removeFilter()
        this.chatContainer.removeChild(list)
        this.chatContainer.removeChild(titleText)
        this.editorContainer.addChild(this.editor)
        this.ui.setFocus(this.editor)
        this.ui.requestRender()
        resolve(value)
      }
      const onAbort = () => finish()
      list.onSelect = (item) => finish(item.value)
      list.onCancel = () => finish()
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  private addSelectListFilter(list: SelectList): () => void {
    let filter = ''
    return this.ui.addInputListener((data) => {
      if (data === '\u007f' || data === '\b') {
        if (filter) {
          filter = filter.slice(0, -1)
          list.setFilter(filter)
          this.ui.requestRender()
        }
        return { consume: true }
      }
      if (Array.from(data).length === 1 && data >= ' ' && !data.startsWith('\u001b')) {
        filter += data
        list.setFilter(filter)
        this.ui.requestRender()
        return { consume: true }
      }
      return undefined
    })
  }

  private async openAuthUrl(url: string): Promise<void> {
    const parsed = URL.canParse(url) ? new URL(url) : undefined
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
      this.showError(`Refusing to open an invalid authentication URL: ${url}`)
      return
    }
    const command = process.platform === 'win32'
      ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url]
      : process.platform === 'darwin' ? ['open', url] : ['xdg-open', url]
    try {
      const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
      void child.exited.then((code) => {
        if (code !== 0) this.showError(`Could not open the browser automatically. Open this URL: ${url}`)
      })
    } catch {
      this.showError(`Could not open the browser automatically. Open this URL: ${url}`)
    }
  }

  private async handleCompactCommand(args: string): Promise<void> {
    if (this.compacting) {
      this.showError('Compaction already in progress.')
      return
    }

    const customInstructions = args.trim() || undefined
    this.compacting = true

    try {
      await this.agent.compact({
        instructions: customInstructions,
        persistToSession: true,
      })

      // Update footer
      this.updateContextUsage()
      this.footer.invalidate()
    } catch (error) {
      this.showError(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.compacting = false
      this.ui.requestRender()
    }
  }

  private appendContextCompactedEntry(): void {
    const entry = new Text(theme.fg('accent', 'Context Compacted'), 1, 0)
    if (this.compacting || !this.activeTurnTimeline || this.turnFinalized) {
      const timeline = new TurnTimeline()
      timeline.addEntry(entry, 'status')
      this.chatContainer.addChild(timeline)
      this.chatContainer.addChild(new Spacer(1))
    } else {
      this.activeTurnTimeline.addEntry(entry, 'status')
    }
    this.updateContextUsage()
    this.footer.invalidate()
    this.ui.requestRender()
  }

  private handleStatusCommand(): void {
    const tokenStats = this.agent.getTokenStats()
    const { context: usage } = tokenStats

    const formatTokens = (value: number): string => value.toLocaleString('en-US')
    const formatPrice = (value: number): string => {
      if (value === 0) return '$0'
      if (value < 0.0001) return `$${value.toFixed(6)}`
      return `$${value.toFixed(4)}`
    }

    const lines: string[] = [
      theme.fg('accent', 'Status'),
      '',
      theme.bold('Context window'),
    ]

    const ratio = Math.min(1, Math.max(0, usage.usedTokens / usage.contextWindow))
    const barWidth = 24
    const filled = Math.round(ratio * barWidth)
    const bar = `${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}`
    lines.push(
      `  ${theme.fg('accent', bar)}  ${usage.percentUsed}% used`,
      `  Used       ${formatTokens(usage.usedTokens)} / ${formatTokens(usage.contextWindow)} tokens`,
      `  Remaining  ${formatTokens(usage.remainingTokens)} tokens (${usage.percentRemaining}%)`,
      `  Breakdown  system ${formatTokens(usage.systemPromptTokens)} + messages ${formatTokens(usage.messageTokens)}`,
    )

    // Show the current session's accumulated usage by model.
    const mergedByModel: Record<string, { modelId: string; provider: string; api: string; requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; totalCost: number }> = {}

    const mergeStats = (stats: Readonly<import('../agent/AgentTokenTracker.js').AgentTokenSnapshot>) => {
      for (const [key, mu] of Object.entries(stats.byModel)) {
        const existing = mergedByModel[key]
        if (existing) {
          existing.requests += mu.requests
          existing.inputTokens += mu.inputTokens
          existing.outputTokens += mu.outputTokens
          existing.cacheReadTokens += mu.cacheReadTokens
          existing.cacheWriteTokens += mu.cacheWriteTokens
          existing.totalTokens += mu.totalTokens
          existing.totalCost += mu.totalCost
        } else {
          mergedByModel[key] = { ...mu }
        }
      }
    }

    mergeStats(tokenStats)

    const modelUsages = Object.values(mergedByModel)
    if (modelUsages.length > 0) {
      lines.push('', theme.bold('Usage by model'))
      for (const mu of modelUsages) {
        lines.push(
          `  ${mu.modelId} (${mu.provider}, ${mu.api})`,
          `    ${formatTokens(mu.requests)} requests · ${formatTokens(mu.totalTokens)} tokens · ${formatPrice(mu.totalCost)}`,
        )
      }
    }

    for (const line of lines) {
      this.chatContainer.addChild(new Text(line, 1, 0))
    }
    this.chatContainer.addChild(new Spacer(1))
    this.ui.requestRender()
  }

  private async handleSessionCommand(_args: string): Promise<void> {
    const sessions = await this.sessionManager.listWithTitles()
    const currentId = this.sessionManager.getSessionId()

    if (sessions.length === 0) {
      this.chatContainer.addChild(
        new Text(theme.dim('No saved sessions found.'), 1, 0),
      )
      this.chatContainer.addChild(new Spacer(1))
      this.ui.requestRender()
      return
    }

    const items: SelectItem[] = []
    for (const s of sessions.slice(0, 20)) {
      const isCurrent = s.id === currentId
      const prefix = isCurrent ? '* ' : '  '
      const date = new Date(s.createdAt).toLocaleString()
      const title = s.title ?? theme.dim('(no title)')
      const label = `${prefix}${title}`
      const desc = `${s.id.slice(0, 8)}  ${date}  ${s.cwd}${isCurrent ? ' (current)' : ''}`
      items.push({ value: s.id, label, description: desc })
    }
    items.push({ value: '__cancel__', label: 'Cancel', description: 'Return without loading' })

    const selectList = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (text) => chalk.cyan(text),
      selectedText: (text) => chalk.cyan(text),
      description: (text) => theme.dim(text),
      scrollInfo: (text) => theme.dim(text),
      noMatch: (text) => theme.dim(text),
    })

    this.chatContainer.addChild(
      new Text(theme.fg('accent', 'Select a session to load:'), 1, 0),
    )
    this.chatContainer.addChild(selectList)
    this.ui.setFocus(selectList)
    this.ui.requestRender()

    let finished = false

    const removeListener = this.ui.addInputListener((data) => {
      if (data === '\x03') {
        finished = true
        removeListener()
        this.chatContainer.removeChild(selectList)
        this.chatContainer.addChild(new Spacer(1))
        this.ui.setFocus(this.editor)
        this.ui.requestRender()
        return { consume: true }
      }
      return undefined
    })

    const finish = async (value?: string) => {
      if (finished) return
      if (!value || value === '__cancel__') {
        finished = true
        removeListener()
        this.chatContainer.removeChild(selectList)
        this.chatContainer.addChild(new Text(theme.dim('Cancelled.'), 1, 0))
        this.chatContainer.addChild(new Spacer(1))
        this.ui.setFocus(this.editor)
        this.ui.requestRender()
        return
      }

      const selected = sessions.find((s) => s.id === value)
      if (!selected) return

      finished = true
      removeListener()
      this.chatContainer.removeChild(selectList)

      if (selected.id === currentId) {
        this.chatContainer.addChild(
          new Text(theme.dim('Already in this session.'), 1, 0),
        )
        this.chatContainer.addChild(new Spacer(1))
        this.ui.setFocus(this.editor)
        this.ui.requestRender()
        return
      }

      try {
        await this.agent.persistMessages()
        const messages = await this.sessionManager.switchToSession(selected)

        // Replace messages on agent
        this.agent.replaceMessages(messages, 'rebuild')

        // Rebuild system prompt preserving loaded skills
        this.rebuildSystemPromptForResume()

        // Clear and re-render chat
        this.rerenderChat(messages)

        this.chatContainer.addChild(
          new Text(theme.fg('accent', `Loaded session: ${selected.title ?? selected.id.slice(0, 8)}`), 1, 0),
        )
        this.chatContainer.addChild(
          new Text(theme.dim(`  ${selected.id}  ${new Date(selected.createdAt).toLocaleString()}`), 1, 0),
        )
        this.chatContainer.addChild(new Spacer(1))
        this.updateContextUsage()
        // Show session title in footer
        this.footer.setSessionTitle(selected.title ?? null)
        this.footer.invalidate()
      } catch (error) {
        this.chatContainer.addChild(
          new Text(theme.fg('red', `Failed to load session: ${error instanceof Error ? error.message : 'Unknown error'}`), 1, 0),
        )
        this.chatContainer.addChild(new Spacer(1))
      }

      this.ui.setFocus(this.editor)
      this.ui.requestRender()
    }

    selectList.onSelect = (item) => finish(item.value)
    selectList.onCancel = () => finish(undefined)
  }

  private async handleTasksCommand(): Promise<void> {
    if (!this.sessionManager.getSessionId()) {
      this.showError('No active session.')
      return
    }

    let lists: TaskList[]
    try {
      lists = await this.sessionManager.listTaskLists()
    } catch (error) {
      this.showError(`Failed to load tasks: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    if (lists.length === 0) {
      this.chatContainer.addChild(
        new Text(theme.dim('No task lists in the current session.'), 1, 0),
      )
      this.chatContainer.addChild(new Spacer(1))
      this.ui.requestRender()
      return
    }

    const listItems: SelectItem[] = lists.map((list) => {
      const completed = list.tasks.filter((task) => task.completed).length
      return {
        value: list.id,
        label: `${completed === list.tasks.length ? '✓' : '▣'} ${list.title}`,
        description: `${completed}/${list.tasks.length} completed  ${list.id}`,
      }
    })
    listItems.push({
      value: '__cancel__',
      label: 'Cancel',
      description: 'Return without opening a task list',
    })

    const listSelect = new SelectList(listItems, Math.min(listItems.length, 10), {
      selectedPrefix: (text) => chalk.cyan(text),
      selectedText: (text) => chalk.cyan(text),
      description: (text) => theme.dim(text),
      scrollInfo: (text) => theme.dim(text),
      noMatch: (text) => theme.dim(text),
    })
    const heading = new Text(
      theme.fg('accent', 'Task lists in this session:'),
      1,
      0,
    )
    this.chatContainer.addChild(heading)
    this.chatContainer.addChild(listSelect)
    this.ui.setFocus(listSelect)
    this.ui.requestRender()

    let finished = false
    let activeSelect: Component = listSelect
    const close = (message?: string) => {
      if (finished) return
      finished = true
      removeListener()
      this.chatContainer.removeChild(activeSelect)
      if (message) this.chatContainer.addChild(new Text(message, 1, 0))
      this.chatContainer.addChild(new Spacer(1))
      this.ui.setFocus(this.editor)
      this.ui.requestRender()
    }
    const removeListener = this.ui.addInputListener((data) => {
      if (data === '\x03') {
        close(theme.dim('Closed task browser.'))
        return { consume: true }
      }
      return undefined
    })

    const showTasks = (list: TaskList) => {
      this.chatContainer.removeChild(activeSelect)
      heading.setText(
        `${theme.fg('accent', list.title)}  ${theme.dim('(Space toggle · Enter confirm · Esc back)')}`,
      )

      // Track original reminder state so we can compute toggle diffs
      const reminderBefore = new Map<string, boolean>()
      const preSelected: number[] = []
      const taskItems: MultiSelectItem[] = list.tasks.map((task, index) => {
        reminderBefore.set(task.id, task.reminder === true)
        if (task.reminder) preSelected.push(index)
        const marker = task.pending ? '◌ ' : '  '
        return {
          value: task.id,
          label: `${marker}${task.content}`,
          description: task.completed
            ? `${task.id}  completed`
            : task.pending
              ? `${task.id}  pending`
              : `${task.id}`,
          disabled: task.completed,
        }
      })
      const taskSelect = new MultiSelectList(
        taskItems,
        Math.min(taskItems.length, 14),
        {
          selectedText: (text) => chalk.cyan(text),
          disabledText: (text) => theme.dim(text),
          description: (text) => theme.dim(text),
          scrollInfo: (text) => theme.dim(text),
        },
        preSelected.length > 0 ? preSelected : undefined,
      )
      activeSelect = taskSelect
      this.chatContainer.addChild(taskSelect)
      this.ui.setFocus(taskSelect)
      this.ui.requestRender()

      taskSelect.onConfirm = async (selected) => {
        const selectedIds = new Set(selected.map((item) => item.value))

        const toAdd: string[] = []
        const toRemove: string[] = []

        for (const task of list.tasks) {
          if (task.completed) continue
          const wasReminded = reminderBefore.get(task.id) ?? false
          const isNowSelected = selectedIds.has(task.id)
          if (!wasReminded && isNowSelected) {
            toAdd.push(task.id)
          } else if (wasReminded && !isNowSelected) {
            toRemove.push(task.id)
          }
        }

        if (toAdd.length === 0 && toRemove.length === 0) {
          close()
          return
        }

        const added: string[] = []
        const removed: string[] = []
        const errors: string[] = []
        for (const id of toAdd) {
          const task = list.tasks.find((t) => t.id === id)!
          try {
            await this.sessionManager.remindTask(list.id, id, true)
            added.push(task.content)
          } catch (error) {
            errors.push(`${task.content}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        for (const id of toRemove) {
          const task = list.tasks.find((t) => t.id === id)!
          try {
            await this.sessionManager.remindTask(list.id, id, false)
            removed.push(task.content)
          } catch (error) {
            errors.push(`${task.content}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }

        let message = ''
        if (added.length > 0) {
          message += `${theme.fg('accent', '◆')} Prioritized ${added.length} task${added.length > 1 ? 's' : ''}:\n`
          for (const content of added) {
            message += `  ${theme.fg('text', content)}\n`
          }
        }
        if (removed.length > 0) {
          message += `${theme.dim('✕')} Removed ${removed.length} task${removed.length > 1 ? 's' : ''}:\n`
          for (const content of removed) {
            message += `  ${theme.dim(content)}\n`
          }
        }
        if (added.length > 0 || removed.length > 0) {
          message += `  ${theme.dim('Microcode will be reminded until each task is marked complete.')}`
        }
        if (errors.length > 0) {
          message += `\n${theme.fg('error', `Failed: ${errors.join('; ')}`)}`
        }
        close(message || undefined)
      }

      taskSelect.onCancel = () => {
        this.chatContainer.removeChild(taskSelect)
        activeSelect = listSelect
        heading.setText(theme.fg('accent', 'Task lists in this session:'))
        this.chatContainer.addChild(listSelect)
        this.ui.setFocus(listSelect)
        this.ui.requestRender()
      }
    }

    listSelect.onSelect = (item) => {
      if (item.value === '__cancel__') {
        close(theme.dim('Closed task browser.'))
        return
      }
      const list = lists.find((candidate) => candidate.id === item.value)
      if (list) showTasks(list)
    }
    listSelect.onCancel = () => close(theme.dim('Closed task browser.'))
  }

  private async handleNewSession(): Promise<void> {
    await this.agent.persistMessages()
    this.sessionManager.beginDraft(process.cwd())

    // Reset state
    this.agent.clearMessages()
    this.activeTurnTimeline = undefined
    this.toolRows.clear()
    this.pendingTools.clear()
    this.turnFinalized = false
    this.titleGenerated = false
    this.firstUserInputForTitle = undefined
    this.footer.setSessionTitle(null)
    this.footer.invalidate()

    // Clear chat and show confirmation
    this.chatContainer.clear()
    this.chatContainer.addChild(
      new Text(theme.fg('accent', 'New session ready.'), 1, 0),
    )
    this.chatContainer.addChild(new Spacer(1))
    this.ui.requestRender()
  }

  private async generateSessionTitle(originalInput?: string): Promise<void> {
    let text = originalInput
    if (text === undefined) {
      const firstUser = this.agent.getMessages().find((m) => m.role === 'user')
      if (!firstUser) return
      if (typeof firstUser.content === 'string') {
        text = firstUser.content.split(/\r?\n/, 1)[0] ?? ''
      } else if (Array.isArray(firstUser.content)) {
        text = firstUser.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join(' ')
          .split(/\r?\n/, 1)[0] ?? ''
      } else {
        text = ''
      }
    }

    text = text.replace(/\s+/g, ' ').trim()
    if (!text) return

    const title = await createSessionTitle(text, async (openingSentence) => {
      const model = this.agent.getCurrentModel()
      const complete = this.modelCompletion ?? ((selectedModel, context, options) => getModels().completeSimple(selectedModel, context, options))
      const result = await complete(model, {
        systemPrompt: 'Generate a short, concise title (5 words max) for a conversation. Reply with ONLY the title, no quotes, no explanation.',
        messages: [{ role: 'user', content: [{ type: 'text', text: `Generate a title for a conversation that starts with: "${openingSentence.slice(0, 200)}"` }] }],
      } as any, { maxTokens: 30, temperature: 0.3 })

      const titleContent = result.content.find((c: any) => c.type === 'text') as any
      return titleContent?.text?.trim().replace(/^["']|["']$/g, '') ?? ''
    })

    const sessionId = this.sessionManager.getSessionId()
    if (sessionId) {
      const conciseTitle = normalizeSessionTitle(title)
      this.sessionManager.setTitle(sessionId, conciseTitle)
      this.footer.setSessionTitle(conciseTitle)
      this.footer.invalidate()
      this.ui.requestRender()
    }
  }

  /**
   * Rebuild system prompt for a resumed session, preserving loaded skills.
   */
  private rebuildSystemPromptForResume(): void {
    this.agent.refreshSystemPrompt()
  }

  /** Render messages loaded by `--resume` before the first input prompt appears. */
  private restoreInitialSessionHistory(): void {
    const messages = this.agent.getMessages()
    if (messages.length === 0) return

    // 复用内部 session 切换的历史渲染路径，保证启动恢复与手动切换表现一致。
    this.rerenderChat([...messages])
    this.appLayout.followLatest()
    this.updateContextUsage()
    this.ui.requestRender()
  }

  /**
   * Clear the chat container and re-render all messages from history.
   */
  private rerenderChat(messages: AgentMessage[]): void {
    this.chatContainer.clear()
    this.toolRows.clear()
    this.pendingTools.clear()
    this.activeTurnTimeline = undefined
    this.turnFinalized = false

    for (const msg of messages) {
      if (msg.role === 'user') {
        let text = ''
        let images: ImageContent[] | undefined
        if (typeof msg.content === 'string') {
          text = msg.content
        } else if (Array.isArray(msg.content)) {
          const textParts = msg.content.filter((c: any) => c.type === 'text').map((c: any) => c.text)
          text = textParts.join('\n')
          const imageParts = msg.content.filter((c: any) => c.type === 'image') as ImageContent[]
          if (imageParts.length > 0) images = imageParts
        }
        const timeline = new TurnTimeline()
        // Mention-injected capability guidance is appended to Agent prompts, not the user's visible message.
        timeline.addEntry(new UserMessage(stripInjectedSkillContextForDisplay(text), images), 'user')
        this.chatContainer.addChild(timeline)
        this.activeTurnTimeline = timeline
        this.turnFinalized = false
      } else if (msg.role === 'assistant') {
        if (!this.activeTurnTimeline) {
          this.activeTurnTimeline = new TurnTimeline()
          this.chatContainer.addChild(this.activeTurnTimeline)
        }
        const component = new AssistantMessageComponent(getMarkdownTheme())
        component.updateContent(msg as any)
        this.activeTurnTimeline.addEntry(component, 'assistant')

        for (const block of msg.content) {
          if (block.type !== 'toolCall') continue
          const row = this.createToolRow(block.id, block.name, block.arguments ?? {})
          dispatchToolLifecycle(row, { phase: 'running' })
          this.activeTurnTimeline.addEntry(row, 'tool')
        }

        if (msg.stopReason === 'aborted') {
          this.activeTurnTimeline.addEntry(new Text(theme.fg('error', 'Interrupted'), 1, 0))
          this.turnFinalized = true
        } else if (msg.stopReason === 'error') {
          this.activeTurnTimeline.addEntry(new Text(theme.fg('error', `Error: ${msg.errorMessage || 'Unknown error'}`), 1, 0))
          this.turnFinalized = true
        } else if (msg.stopReason === 'stop') {
          this.turnFinalized = true
        }
      } else if ((msg as any).role === 'toolResult') {
        const toolResult = msg as any
        let row = this.toolRows.get(toolResult.toolCallId)
        if (!row) {
          row = this.createToolRow(toolResult.toolCallId, toolResult.toolName, {})
          dispatchToolLifecycle(row, { phase: 'running' })
          this.appendTurnEntry(row, 'tool')
        }
        dispatchToolLifecycle(row, {
          phase: toolResult.isError === true ? 'failed' : 'completed',
          result: {
            content: toolResult.content ?? [],
            isError: toolResult.isError === true,
            ...(toolResult.details && typeof toolResult.details === 'object' ? { details: toolResult.details } : {}),
          },
        })
      }
    }

    this.activeTurnTimeline = undefined
  }

  private async handleModelCommand(searchTerm?: string): Promise<void> {
    let allModels: Model<Api>[]
    try {
      allModels = [...(this.modelCatalog?.getProjectModels() ?? getAllModels())]
    } catch (error) {
      this.showError(`Could not load models: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    if (searchTerm?.trim()) {
      const term = searchTerm.trim()
      const exact = allModels.filter((model) => `${model.provider}/${model.id}` === term || model.id === term)
      if (exact.length === 1) {
        this.switchModel(`${exact[0]!.provider}/${exact[0]!.id}`)
        return
      }
      this.showModelChoices(allModels.filter((model) =>
        `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(term.toLowerCase()),
      ), `Models matching “${term}”`)
      return
    }

    const providers = this.modelCatalog
      ? [...new Set(allModels.map((model) => String(model.provider)))].map((providerId) => ({
          value: providerId,
          label: providerId,
          description: `${allModels.filter((model) => String(model.provider) === providerId).length} models · ${providerId}`,
        }))
      : getModels().getProviders()
          .map((provider) => ({
            value: provider.id,
            label: provider.name,
            description: `${allModels.filter((model) => model.provider === provider.id).length} models · ${provider.id}`,
          }))
          .filter((provider) => !provider.description.startsWith('0 models'))
    const currentProvider = String(this.agent.getCurrentModel().provider)
    const items: SelectItem[] = providers.map((provider) => ({ ...provider, label: `${provider.label}${provider.value === currentProvider ? ' (current)' : ''}` }))
    const selectList = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (text) => chalk.cyan(text),
      selectedText: (text) => chalk.cyan(text),
      description: (text) => theme.dim(text),
      scrollInfo: (text) => theme.dim(text),
      noMatch: (text) => theme.dim(text),
    }, { maxPrimaryColumnWidth: 52 })
    const removeFilter = this.addSelectListFilter(selectList)
    const providerTitle = new Text(theme.fg('accent', 'Choose provider — type to filter'), 1, 0)
    this.chatContainer.addChild(providerTitle)
    this.chatContainer.addChild(selectList)
    this.ui.setFocus(selectList)
    this.ui.requestRender()
    selectList.onSelect = (item) => {
      removeFilter()
      this.chatContainer.removeChild(selectList)
      this.chatContainer.removeChild(providerTitle)
      this.showModelChoices(allModels.filter((model) => model.provider === item.value), `${item.label} models`)
    }
    selectList.onCancel = () => {
      removeFilter()
      this.chatContainer.removeChild(selectList)
      this.chatContainer.removeChild(providerTitle)
      this.chatContainer.addChild(new Spacer(1))
      this.ui.setFocus(this.editor)
      this.ui.requestRender()
    }
  }

  private showModelChoices(models: Model<Api>[], title: string): void {
    if (models.length === 0) {
      this.showError('No matching models.')
      return
    }
    const currentModel = this.agent.getCurrentModel()
    const currentId = currentModel.id
    const currentApi = currentModel.api
    const currentProvider = currentModel.provider

    const items: SelectItem[] = models.sort((a, b) => a.id.localeCompare(b.id)).map((m) => {
      const isCurrent = m.id === currentId && m.api === currentApi && m.provider === currentProvider
      return {
        value: `${m.provider}/${m.id}`,
        label: `${m.name ?? m.id}${isCurrent ? ' (current)' : ''}`,
        description: `${m.id} · ${m.api}`,
      }
    })

    const selectList = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (text) => chalk.cyan(text),
      selectedText: (text) => chalk.cyan(text),
      description: (text) => theme.dim(text),
      scrollInfo: (text) => theme.dim(text),
      noMatch: (text) => theme.dim(text),
    }, { maxPrimaryColumnWidth: 52 })
    const removeFilter = this.addSelectListFilter(selectList)

    const label = theme.fg('accent', `${title} — type to filter`)
    const titleText = new Text(label, 1, 0)
    this.chatContainer.addChild(titleText)
    this.chatContainer.addChild(selectList)
    this.ui.setFocus(selectList)
    this.ui.requestRender()

    let finished = false
    const removeListener = this.ui.addInputListener((data) => {
      if (data === '\x03') {
        // Ctrl+C
        finished = true
        removeListener()
        this.chatContainer.removeChild(selectList)
        this.chatContainer.addChild(new Spacer(1))
        this.ui.setFocus(this.editor)
        this.ui.requestRender()
        return { consume: true }
      }
      return undefined
    })

    const finish = (selectedValue?: string) => {
      if (finished) return
      finished = true
      removeFilter()
      removeListener()
      this.chatContainer.removeChild(selectList)
      this.chatContainer.removeChild(titleText)

      if (selectedValue) {
        this.switchModel(selectedValue)
      }

      this.chatContainer.addChild(new Spacer(1))
      this.ui.setFocus(this.editor)
      this.ui.requestRender()
    }

    selectList.onSelect = (item) => {
      finish(item.value)
    }

    selectList.onCancel = () => {
      finish()
    }
  }

  /** Switch to a model by ID and update all dependent state. */
  private switchModel(modelId: string, api?: Api): void {
    try {
      const slash = modelId.indexOf('/')
      const provider = slash > 0 ? modelId.slice(0, slash) : undefined
      const id = provider ? modelId.slice(slash + 1) : modelId
      const snapshot = this.agent.switchModel(id, api, provider)
      const model = snapshot.model

      // Clear image state on model switch
      this.clearPendingImages()
      this.suppressTrailingQuote = false

      // Rebuild footer with new model info
      this.footer.invalidate()

      this.showStatus(`Model switched to: ${snapshot.provider}/${model.id} (${model.api})`)
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error))
    }
  }

  private async handleMcpCommand(args: string): Promise<void> {
    const mcpClient = this.mcpClient
    if (!mcpClient) {
      this.showError('No MCP client available.')
      return
    }
    if (args.trim()) {
      this.showError('The /mcp command only lists MCP servers. Use /plugins to list or enable and disable plugins.')
      return
    }

    let registry: McpCapabilitiesResult
    try {
      if (this.agent.isBusy()) {
        this.showStatus('MCP runtime refresh will be applied after the active turn finishes.')
        await this.pluginManager?.refresh()
      } else {
        await this.onPluginsChanged?.()
      }
      registry = await discoverMcpCapabilities(process.cwd())
    } catch (error) {
      this.showError(`Could not discover MCP servers: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    let removedStaleDirectoryServer = false
    for (const state of mcpClient.getServerStates()) {
      const definition = registry.servers.find((item) => item.name === state.name && (item.scope === 'user' || item.scope === 'project'))
      if (definition && JSON.stringify(definition.config) !== JSON.stringify(state.config)) {
        await mcpClient.removeServer(state.name)
        removedStaleDirectoryServer = true
      }
    }
    if (removedStaleDirectoryServer) this.updateMcpState(mcpClient)

    const states = mcpClient.getServerStates()
    const pluginMcpServers = (this.pluginManager?.getPlugins() ?? []).flatMap((plugin) =>
      plugin.servers.map((server) => ({ plugin, server })),
    )
    if (states.length === 0 && registry.servers.length === 0 && pluginMcpServers.length === 0) {
      this.chatContainer.addChild(
        new Text(theme.dim('No MCP servers configured.'), 1, 0),
      )
      this.chatContainer.addChild(new Spacer(1))
      this.ui.requestRender()
      return
    }

    this.chatContainer.addChild(
      new Text(theme.fg('accent', 'MCP Servers:'), 1, 0),
    )
    this.chatContainer.addChild(new Spacer(1))

    const pluginServerNames = new Set(pluginMcpServers.map(({ server }) => server.qualifiedName))
    for (const state of states) {
      if (pluginServerNames.has(state.name)) continue
      const statusIcon = state.status === 'connected' ? '✓'
        : state.status === 'failed' ? '✗'
        : state.status === 'disabled' ? '○'
        : '◌'
      const statusLine = `${statusIcon} ${theme.bold(state.name)} ${theme.dim(`(${state.status})`)}`
      this.chatContainer.addChild(new Text(statusLine, 1, 0))

      if (state.status === 'connected' && state.tools.length > 0) {
        const toolNames = state.tools.map(t => t.name).join(', ')
        this.chatContainer.addChild(
          new Text(`  ${theme.dim('Tools:')} ${toolNames}`, 1, 0),
        )
      }

      if (state.status === 'connected' && state.resources.length > 0) {
        const resourceNames = state.resources.map(r => r.name).join(', ')
        this.chatContainer.addChild(
          new Text(`  ${theme.dim('Resources:')} ${resourceNames}`, 1, 0),
        )
      }

      if (state.status === 'failed' && state.error) {
        this.chatContainer.addChild(
          new Text(`  ${chalk.hex('#cc6666')(state.error)}`, 1, 0),
        )
      }
    }

    for (const server of registry.servers) {
      const runtime = states.find((state) => state.name === server.name)
      this.chatContainer.addChild(new Text(`  ${theme.bold(server.name)} · ${server.scope}${server.packageName ? `/${server.packageName}` : ''} · ${runtime?.status ?? 'starting'}`, 1, 0))
      if (server.sourcePath) this.chatContainer.addChild(new Text(`    ${theme.dim(server.sourcePath)}`, 1, 0))
    }
    for (const { plugin, server } of pluginMcpServers) {
      const runtime = states.find((state) => state.name === server.qualifiedName)
      const runtimeStatus = !plugin.enabled ? 'plugin disabled' : runtime?.status ?? 'starting'
      this.chatContainer.addChild(new Text(`  ${theme.bold(server.qualifiedName)} · plugin ${plugin.name} · ${runtimeStatus}`, 1, 0))
      this.chatContainer.addChild(new Text(`    ${theme.dim(`${server.transport} · ${server.safeCommandSummary} · ${server.sourcePath}`)}`, 1, 0))
      if (runtime?.status === 'connected' && runtime.tools.length > 0) {
        this.chatContainer.addChild(new Text(`    ${theme.dim(`Tools: ${runtime.tools.map((tool) => tool.name).join(', ')}`)}`, 1, 0))
      }
    }
    for (const diagnostic of registry.diagnostics) {
      this.chatContainer.addChild(new Text(`  ${theme.dim(diagnostic)}`, 1, 0))
    }

    this.chatContainer.addChild(new Spacer(1))
    this.ui.requestRender()
  }

  private rebuildSystemPrompt(mcpServers?: McpServerState[]): void {
    this.agent.updateMcpServers(mcpServers)
  }

  updateMcpState(mcpClient: McpClientManager): void {
    this.mcpClient = mcpClient
    if (this.agent.isBusy()) {
      this.queuedMcpClient = mcpClient
      this.showStatus('MCP runtime updates are queued until the active turn ends.')
      return
    }
    this.applyMcpState(mcpClient)
  }

  private applyMcpState(mcpClient: McpClientManager): void {
    this.agent.configureMcpTools(mcpClient)
    this.rebuildSystemPrompt(mcpClient.getServerStates())
  }

  private applyQueuedMcpState(): void {
    if (this.agent.isBusy() || !this.queuedMcpClient) return
    const client = this.queuedMcpClient
    this.queuedMcpClient = undefined
    this.applyMcpState(client)
  }

  showMcpReady(states: McpServerState[]): void {
    const connected = states.filter(s => s.status === 'connected')
    const failed = states.filter(s => s.status === 'failed')

    const parts: string[] = []
    if (connected.length > 0) {
      parts.push(`${connected.length} server(s) connected`)
    }
    if (failed.length > 0) {
      parts.push(`${failed.length} failed`)
    }

    this.chatContainer.addChild(
      new Text(theme.dim(`MCP ready: ${parts.join(', ')}`), 1, 0),
    )
    this.chatContainer.addChild(new Spacer(1))
    this.ui.requestRender()
  }

  private static PERMISSION_DESCRIPTIONS: Record<PermissionMode, string> = {
    'interactive': 'Read: auto-allow | Write/Edit/Bash: prompt before execution',
    'auto-approve': 'All tools execute without confirmation (YOLO mode)',
    'plan': 'Read-only — all write/edit/bash operations are blocked',
  }

  private handlePermissionCommand(args: string): void {
    const mode = args.trim().toLowerCase() as PermissionMode

    if (!mode) {
      const current = this.agent.getPermissionMode()
      const items: SelectItem[] = PERMISSION_MODES.map((m) => ({
        value: m,
        label: m,
        description: `${App.PERMISSION_DESCRIPTIONS[m]}${m === current ? ' (current)' : ''}`,
      }))

      const selectList = new SelectList(items, items.length, {
        selectedPrefix: (text) => chalk.cyan(text),
        selectedText: (text) => chalk.cyan(text),
        description: (text) => theme.dim(text),
        scrollInfo: (text) => theme.dim(text),
        noMatch: (text) => theme.dim(text),
      })

      const label = theme.fg('accent', 'Select permission mode:')
      this.chatContainer.addChild(new Text(label, 1, 0))
      this.chatContainer.addChild(selectList)
      this.ui.setFocus(selectList)
      this.ui.requestRender()

      let finished = false
      const removeListener = this.ui.addInputListener((data) => {
        if (data === '\x03') {
          finished = true
          removeListener()
          this.chatContainer.removeChild(selectList)
          this.chatContainer.addChild(new Spacer(1))
          this.ui.setFocus(this.editor)
          this.ui.requestRender()
          return { consume: true }
        }
        return undefined
      })

      const finish = (selectedMode?: PermissionMode) => {
        if (finished) return
        finished = true
        removeListener()
        this.chatContainer.removeChild(selectList)

        if (selectedMode) {
          this.agent.setPermissionMode(selectedMode)
          this.showStatus(`Permission mode set to: ${selectedMode}`)
        }

        this.chatContainer.addChild(new Spacer(1))
        this.ui.setFocus(this.editor)
        this.ui.requestRender()
      }

      selectList.onSelect = (item) => {
        finish(item.value as PermissionMode)
      }

      selectList.onCancel = () => {
        finish()
      }

      return
    }

    if (!PERMISSION_MODES.includes(mode)) {
      this.showError(`Invalid permission mode: ${mode}. Valid modes: ${PERMISSION_MODES.join(', ')}`)
      return
    }

    this.agent.setPermissionMode(mode)
    this.showStatus(`Permission mode set to: ${mode}`)
  }

  private static THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  private static THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
    off: 'No reasoning',
    minimal: 'Very brief reasoning (~1k tokens)',
    low: 'Light reasoning (~2k tokens)',
    medium: 'Moderate reasoning (~8k tokens)',
    high: 'Deep reasoning (~16k tokens)',
    xhigh: 'Maximum reasoning (~32k tokens)',
    max: 'Maximum supported reasoning budget',
  }

  private handleThinkingCommand(args: string): void {
    const level = args.trim().toLowerCase() as ThinkingLevel

    if (!level) {
      const items: SelectItem[] = App.THINKING_LEVELS.map((l) => ({
        value: l,
        label: l,
        description: App.THINKING_DESCRIPTIONS[l],
      }))

      const selectList = new SelectList(items, items.length, {
        selectedPrefix: (text) => chalk.cyan(text),
        selectedText: (text) => chalk.cyan(text),
        description: (text) => theme.dim(text),
        scrollInfo: (text) => theme.dim(text),
        noMatch: (text) => theme.dim(text),
      })

      const thinkingLabel = theme.fg('accent', 'Select thinking level:')
      this.chatContainer.addChild(new Text(thinkingLabel, 1, 0))
      this.chatContainer.addChild(selectList)
      this.ui.setFocus(selectList)
      this.ui.requestRender()

      let finished = false
      const removeListener = this.ui.addInputListener((data) => {
        if (data === '\x03') {
          // Ctrl+C
          finished = true
          removeListener()
          this.chatContainer.removeChild(selectList)
          this.chatContainer.addChild(new Spacer(1))
          this.ui.setFocus(this.editor)
          this.ui.requestRender()
          return { consume: true }
        }
        return undefined
      })

      const finish = (selectedLevel?: ThinkingLevel) => {
        if (finished) return
        finished = true
        removeListener()
        this.chatContainer.removeChild(selectList)

        if (selectedLevel) {
          this.agent.setThinkingLevel(selectedLevel)
          this.footer.invalidate()
          this.showStatus(`Thinking level set to: ${selectedLevel}`)
        }

        this.chatContainer.addChild(new Spacer(1))
        this.ui.setFocus(this.editor)
        this.ui.requestRender()
      }

      selectList.onSelect = (item) => {
        finish(item.value as ThinkingLevel)
      }

      selectList.onCancel = () => {
        finish()
      }

      return
    }

    if (!App.THINKING_LEVELS.includes(level)) {
      this.showError(`Invalid thinking level: ${level}. Valid levels: ${App.THINKING_LEVELS.join(', ')}`)
      return
    }

    this.agent.setThinkingLevel(level)
    this.footer.invalidate()
    this.showStatus(`Thinking level set to: ${level}`)
  }

  private handleSkillsCommand(): void {
    const actions: SelectItem[] = [
      { value: 'list', label: 'List skills', description: 'Show available skills and their status' },
      { value: 'toggle', label: 'Enable/Disable Skills', description: 'Add or remove skill instructions from the Agent prompt' },
      { value: 'cancel', label: 'Cancel', description: 'Close this menu' },
    ]
    const selectList = new SelectList(actions, actions.length, {
      selectedPrefix: (text) => chalk.cyan(text),
      selectedText: (text) => chalk.cyan(text),
      description: (text) => theme.dim(text),
      scrollInfo: (text) => theme.dim(text),
      noMatch: (text) => theme.dim(text),
    })
    this.chatContainer.addChild(new Text(theme.fg('accent', 'Skills'), 1, 0))
    this.chatContainer.addChild(new Text(theme.dim('Choose an action'), 1, 0))
    this.chatContainer.addChild(selectList)
    this.ui.setFocus(selectList)
    this.ui.requestRender()
    const close = () => {
      this.chatContainer.removeChild(selectList)
      this.chatContainer.addChild(new Spacer(1))
      this.ui.setFocus(this.editor)
    }
    selectList.onSelect = (item) => {
      close()
      if (item.value === 'list') this.showSkillList()
      else if (item.value === 'toggle') this.showSkillEnableDisableMenu()
      else this.ui.requestRender()
    }
    selectList.onCancel = () => {
      close()
      this.ui.requestRender()
    }
  }

  private async handlePluginsCommand(): Promise<void> {
    if (!this.pluginManager) {
      this.showError('Plugin management is unavailable in this session.')
      return
    }
    try {
      await this.refreshPluginDiscovery(true)
    } catch (error) {
      this.showError(`Could not refresh plugins: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.showPluginActionMenu()
  }

  private async refreshPluginDiscovery(force = false, syncRuntime = true): Promise<PluginSnapshot | undefined> {
    const manager = this.pluginManager
    if (!manager) return undefined

    let snapshot: PluginSnapshot
    if (this.pluginDiscoveryRefresh) {
      snapshot = await this.pluginDiscoveryRefresh
    } else if (force || Date.now() - this.pluginDiscoveryRefreshedAt >= 1000) {
      const refresh = manager.refresh()
      this.pluginDiscoveryRefresh = refresh
      try {
        snapshot = await refresh
        this.pluginDiscoveryRefreshedAt = Date.now()
        this.pluginRuntimeRefreshPending = true
      } finally {
        if (this.pluginDiscoveryRefresh === refresh) this.pluginDiscoveryRefresh = undefined
      }
    } else {
      snapshot = manager.getSnapshot()
    }

    if (syncRuntime && this.pluginRuntimeRefreshPending && !this.agent.isBusy()) {
      this.pluginRuntimeRefreshPending = false
      try {
        await this.onPluginsChanged?.(snapshot)
      } catch (error) {
        this.pluginRuntimeRefreshPending = true
        throw error
      }
    }
    return snapshot
  }

  private showPluginActionMenu(): void {
    const actions: SelectItem[] = [
      { value: 'list', label: 'List plugins', description: 'Show package source, status, components, and health' },
      { value: 'bulk', label: 'Enable/disable plugins', description: 'Choose the desired enabled set for one scope' },
      { value: 'cancel', label: 'Cancel', description: 'Close this menu' },
    ]
    this.showPluginPicker('Plugins', 'Choose an action', actions, (value) => {
      if (value === 'list') this.showPluginList()
      else if (value === 'bulk') this.showPluginEnableDisableScopePicker()
    })
  }

  private showPluginEnableDisableScopePicker(): void {
    const plugins = this.pluginManager?.getPlugins() ?? []
    const scopes: PluginScope[] = ['user', 'project']
    const available = scopes.filter((scope) => plugins.some((plugin) => plugin.scope === scope))
    if (available.length === 0) {
      this.showStatus('No plugin packages are available to enable or disable.')
      return
    }
    this.showPluginPicker('Enable/Disable Plugins', 'Choose one preference scope', available.map((scope) => ({
      value: scope,
      label: `${scope} plugins`,
      description: `${plugins.filter((plugin) => plugin.scope === scope).length} discovered`,
    })), (value) => {
      if (value === 'user' || value === 'project') this.showPluginEnableDisableMenu(value)
    })
  }

  private showPluginEnableDisableMenu(scope: PluginScope): void {
    const plugins = (this.pluginManager?.getPlugins() ?? []).filter((plugin) => plugin.scope === scope)
    if (plugins.length === 0) {
      this.showStatus(`No ${scope} plugins are available.`)
      return
    }
    const items: MultiSelectItem[] = plugins.map((plugin) => ({
      value: plugin.name,
      label: `${plugin.name} · ${plugin.scope} · ${plugin.health}`,
      description: plugin.description,
      disabled: !plugin.valid || plugin.health === 'incompatible',
    }))
    const preSelected = plugins.flatMap((plugin, index) => plugin.enabled && plugin.valid && plugin.health !== 'incompatible' ? [index] : [])
    const list = new MultiSelectList(items, Math.min(items.length, 12), {
      selectedText: (text) => chalk.cyan(text),
      disabledText: (text) => theme.dim(text),
      description: (text) => theme.dim(text),
      scrollInfo: (text) => theme.dim(text),
    }, preSelected)
    this.chatContainer.addChild(new Text(theme.fg('accent', `${scope} Plugins`), 1, 0))
    this.chatContainer.addChild(new Text(theme.dim('Checked plugins will be enabled. Space toggles; Enter applies changes.'), 1, 0))
    this.chatContainer.addChild(list)
    this.ui.setFocus(list)
    this.ui.requestRender()
    const close = () => {
      this.chatContainer.removeChild(list)
      this.chatContainer.addChild(new Spacer(1))
      this.ui.setFocus(this.editor)
    }
    list.onConfirm = (selected) => {
      close()
      const selectedNames = new Set(selected.map((item) => item.value))
      const desiredStates = new Map(plugins.filter((plugin) => plugin.valid && plugin.health !== 'incompatible').map((plugin) => [plugin.name, selectedNames.has(plugin.name)]))
      void this.applyPluginEnablement(scope, desiredStates)
    }
    list.onCancel = () => {
      close()
      this.ui.requestRender()
    }
  }

  private async applyPluginEnablement(scope: PluginScope, desiredStates: ReadonlyMap<string, boolean>): Promise<void> {
    if (this.agent.isBusy()) {
      this.showStatus('Plugin settings were not changed: finish or interrupt the active turn, then choose the action again.')
      return
    }
    const changed = [...desiredStates].filter(([name, enabled]) => this.pluginManager?.findPlugin(name)?.enabled !== enabled)
    if (changed.length === 0) {
      this.showStatus('Plugin settings are already up to date.')
      return
    }
    try {
      const snapshot = await this.pluginManager?.setEnabledMany(scope, desiredStates)
      await this.onPluginsChanged?.(snapshot)
      const enabled = changed.filter(([, state]) => state).length
      const disabled = changed.length - enabled
      this.showStatus(`Updated ${scope} plugins: ${enabled} enabled, ${disabled} disabled.`)
    } catch (error) {
      this.showError(`Could not update plugins: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async handleGitCommand(input: string): Promise<void> {
    const command = parseGitCommand(input)
    if (command.action === 'unknown') {
      this.showError(command.usage)
      return
    }

    let repository: GitRepository
    try {
      repository = await GitRepository.open(process.cwd())
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error))
      return
    }

    if (command.action === 'menu') {
      await this.showGitActionMenu(repository)
      return
    }
    if (!canRunGitCommand(command, this.agent.isBusy())) {
      this.showStatus('Git changes are unavailable while the Agent is working. Finish or interrupt the current turn, then retry.')
      return
    }
    if (requiresGitConfirmation(command)) {
      const description = this.describeGitCommand(command)
      this.showGitConfirmation(description, () => {
        if (this.agent.isBusy()) {
          this.showStatus('Git operation cancelled because the Agent became busy.')
          return
        }
        void this.executeGitCommand(repository, command)
      })
      return
    }
    await this.executeGitCommand(repository, command)
  }

  private async showGitActionMenu(repository: GitRepository): Promise<void> {
    try {
      const status = await repository.status()
      const actions: SelectItem[] = [
        { value: 'status', label: 'Status', description: `${status.branch} · ${status.changes.length} changed paths` },
        { value: 'diff', label: 'Diff', description: 'Inspect working-tree changes' },
        { value: 'branches', label: 'Branch', description: 'View and switch local branches' },
        { value: 'stage', label: 'Add', description: 'Select files to stage for commit' },
        { value: 'commit', label: 'Commit', description: 'Commit staged changes' },
        { value: 'log', label: 'Log', description: 'View recent commits' },
        { value: 'pull', label: 'Pull', description: 'Fast-forward only · confirmation required' },
        { value: 'push', label: 'Push', description: 'Push the current branch · confirmation required' },
      ]
      this.showGitPicker('Git', `${repository.root} · ${status.branch}`, actions, (value) => {
        if (value === 'branches') {
          void this.showGitBranches(repository, true)
          return
        }
        if (value === 'branch create') {
          this.editor.setText('/git branch create ')
          this.ui.setFocus(this.editor)
          this.ui.requestRender()
          return
        }
        if (value === 'commit') {
          this.promptGitCommitMessage()
          return
        }
        void this.handleGitCommand(value)
      })
    } catch (error) {
      this.showError(`Could not inspect Git repository: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async executeGitCommand(repository: GitRepository, command: GitCommand): Promise<void> {
    if (this.gitOperationActive) {
      this.showStatus('A Git operation is already running. Wait for it to finish.')
      return
    }
    if (!canRunGitCommand(command, this.agent.isBusy())) {
      this.showStatus('Git changes are unavailable while the Agent is working.')
      return
    }
    this.gitOperationActive = true
    try {
      switch (command.action) {
        case 'status':
          this.showGitStatus(await repository.status())
          return
        case 'diff':
        case 'diff-staged':
          this.showGitOutput(command.action === 'diff-staged' ? 'Staged diff' : 'Working diff', await repository.diff(command.action === 'diff-staged'))
          return
        case 'branches':
          await this.showGitBranches(repository)
          return
        case 'branch-create':
          await repository.createBranch(command.name)
          await this.gitMutationSucceeded(`Created and switched to branch ${command.name}.`, repository)
          return
        case 'branch-switch':
          await repository.switchBranch(command.name)
          await this.gitMutationSucceeded(`Switched to branch ${command.name}.`, repository)
          return
        case 'branch-delete':
          await repository.deleteBranch(command.name)
          await this.gitMutationSucceeded(`Deleted merged branch ${command.name}.`, repository)
          return
        case 'stage':
          if (command.paths.length > 0) {
            await repository.stage(command.paths)
            await this.gitMutationSucceeded(`Staged ${command.paths.length} path${command.paths.length === 1 ? '' : 's'}.`, repository)
          } else {
            await this.showGitPathPicker(repository, 'stage')
          }
          return
        case 'unstage':
          if (command.paths.length > 0) {
            await repository.unstage(command.paths)
            await this.gitMutationSucceeded(`Unstaged ${command.paths.length} path${command.paths.length === 1 ? '' : 's'}.`, repository)
          } else {
            await this.showGitPathPicker(repository, 'unstage')
          }
          return
        case 'discard':
          if (command.paths.length > 0) {
            await this.runGitMutation(repository, () => repository.discard(command.paths), `Discarded ${command.paths.length} path${command.paths.length === 1 ? '' : 's'}.`)
          } else {
            await this.showGitPathPicker(repository, 'discard')
          }
          return
        case 'commit':
          if (!command.message.trim()) {
            this.editor.setText('/git commit ')
            this.ui.setFocus(this.editor)
            this.showStatus('Enter a commit message after `/git commit`. Only staged changes will be committed.')
            return
          }
          await this.runGitMutation(repository, async () => {
            const commit = await repository.commit(command.message)
            return `Created commit ${commit}: ${command.message}`
          })
          return
        case 'log':
          this.showGitOutput('Recent commits', (await repository.history()).join('\n'))
          return
        case 'fetch':
          await this.runGitMutation(repository, () => repository.fetch(), 'Fetched remote updates and pruned stale refs.')
          return
        case 'pull':
          await this.runGitMutation(repository, () => repository.pull(), 'Pulled updates using fast-forward only.')
          return
        case 'push':
          await this.runGitMutation(repository, () => repository.push(), 'Pushed the current branch.')
          return
        case 'stash-push':
          await this.runGitMutation(repository, () => repository.stashPush(command.message), 'Saved changes to a stash.')
          return
        case 'stash-list':
          await this.showGitStashes(repository)
          return
        case 'stash-apply':
        case 'stash-pop':
          if (command.ref) {
            const run = () => repository.stashApply(command.ref!, command.action === 'stash-pop')
            if (command.action === 'stash-pop') {
              await this.runGitMutation(repository, run, `Applied and removed ${command.ref}.`)
            } else {
              await this.runGitMutation(repository, run, `Applied ${command.ref}.`)
            }
          } else {
            await this.showGitStashes(repository, command.action === 'stash-pop' ? 'pop' : 'apply')
          }
          return
        case 'menu':
        case 'unknown':
          return
      }
    } catch (error) {
      this.showError(`Git operation failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.gitOperationActive = false
    }
  }

  private promptGitCommitMessage(): void {
    const previousSubmit = this.editor.onSubmit
    const previousEscape = this.editor.onEscape
    const prompt = new Text('Commit message · Enter to commit · Esc to cancel', 1, 0)
    this.chatContainer.addChild(prompt)
    this.editor.setText('')
    this.ui.setFocus(this.editor)
    this.ui.requestRender()

    let settled = false
    const cleanup = () => {
      if (settled) return
      settled = true
      this.editor.onSubmit = previousSubmit
      this.editor.onEscape = previousEscape
      this.chatContainer.removeChild(prompt)
      this.editor.setText('')
      this.ui.setFocus(this.editor)
      this.ui.requestRender()
    }

    this.editor.onSubmit = (value: string) => {
      const message = value.trim()
      if (!message) {
        prompt.setText('Commit message cannot be empty · Enter to commit · Esc to cancel')
        this.ui.requestRender()
        return
      }
      cleanup()
      const quotedMessage = `"${message.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
      void this.handleGitCommand(`commit ${quotedMessage}`)
    }
    this.editor.onEscape = () => {
      cleanup()
      this.lastSigintTime = 0
    }
  }

  private async runGitMutation(
    repository: GitRepository,
    operation: () => Promise<void | string>,
    success?: string,
  ): Promise<void> {
    if (this.agent.isBusy()) {
      this.showStatus('Git changes are unavailable while the Agent is working.')
      return
    }
    const ownsLock = !this.gitOperationActive
    if (ownsLock) this.gitOperationActive = true
    try {
      const detail = await operation()
      await this.gitMutationSucceeded(detail || success || 'Git operation completed.', repository)
    } catch (error) {
      this.showError(`Git operation failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (ownsLock) this.gitOperationActive = false
    }
  }

  private async gitMutationSucceeded(message: string, repository: GitRepository): Promise<void> {
    this.footer.invalidate()
    try {
      const status = await repository.status()
      this.showStatus(`${message}\n${status.branch}${status.upstream ? ` · ${status.ahead} ahead · ${status.behind} behind ${status.upstream}` : ''}`)
    } catch (error) {
      this.showStatus(`${message}\nCould not refresh Git status: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private showGitStatus(status: Awaited<ReturnType<GitRepository['status']>>): void {
    const lines = [
      `Repository: ${status.root}`,
      `Branch: ${status.branch}${status.upstream ? ` · ${status.upstream} · ${status.ahead} ahead / ${status.behind} behind` : ' · no upstream'}`,
    ]
    const staged = status.changes.filter((change) => change.staged)
    const unstaged = status.changes.filter((change) => change.unstaged && !change.untracked)
    const untracked = status.changes.filter((change) => change.untracked)
    const append = (label: string, changes: GitFileChange[]) => {
      lines.push('', `${label} (${changes.length})`)
      if (changes.length === 0) lines.push('  none')
      for (const change of changes.slice(0, 100)) {
        lines.push(`  ${change.indexStatus}${change.worktreeStatus} ${change.path}`)
      }
      if (changes.length > 100) lines.push(`  … ${changes.length - 100} more paths omitted`)
    }
    append('Staged', staged)
    append('Unstaged', unstaged)
    append('Untracked', untracked)
    this.showGitOutput('Git status', lines.join('\n'))
  }

  private async showGitBranches(repository: GitRepository, switchOnSelect = false): Promise<void> {
    try {
      const branches = await repository.branches()
      if (branches.length === 0) {
        this.showStatus('No local branches found.')
        return
      }
      const items: SelectItem[] = branches.map((branch) => ({
        value: branch.name,
        label: `${branch.current ? '● ' : '  '}${branch.name}`,
        description: branch.current ? 'current branch' : 'switch to this branch',
      }))
      this.showGitPicker(
        'Local branches',
        switchOnSelect ? 'Select a local branch to switch to' : 'Choose a branch to switch to or manage',
        items,
        (name) => {
          const selectedBranch = branches.find((branch) => branch.name === name)
          if (!selectedBranch) return
          const branchArg = `"${name.replaceAll('"', '\\"')}"`
          if (switchOnSelect) {
            if (selectedBranch.current) {
              this.showStatus(`Already on branch ${name}.`)
            } else {
              void this.handleGitCommand(`branch switch ${branchArg}`)
            }
            return
          }
          const actions: SelectItem[] = selectedBranch.current
            ? [{ value: 'cancel', label: 'Current branch', description: 'This branch is already checked out' }]
            : [
              { value: 'switch', label: 'Switch to branch' },
              { value: 'delete', label: 'Delete merged branch', description: 'Uses Git safe-delete rules · confirmation required' },
            ]
          this.showGitPicker(`Branch ${name}`, 'Choose a branch action', actions, (action) => {
            if (action === 'switch') void this.handleGitCommand(`branch switch ${branchArg}`)
            else if (action === 'delete') void this.handleGitCommand(`branch delete ${branchArg}`)
          })
        },
      )
    } catch (error) {
      this.showError(`Could not list local branches: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async showGitPathPicker(repository: GitRepository, operation: 'stage' | 'unstage' | 'discard'): Promise<void> {
    const status = await repository.status()
    let candidates: GitFileChange[]
    let title: string
    let subtitle: string
    let preSelected: number[] = []
    if (operation === 'stage') {
      candidates = status.changes.filter((change) => change.unstaged || change.untracked)
      title = 'Stage files'
      subtitle = 'Space selects paths to stage; existing staged paths are marked.'
      preSelected = candidates.flatMap((change, index) => change.staged ? [index] : [])
    } else if (operation === 'unstage') {
      candidates = status.changes.filter((change) => change.staged)
      title = 'Unstage files'
      subtitle = 'Checked paths are currently staged. Uncheck paths to unstage them.'
      preSelected = candidates.map((_change, index) => index)
    } else {
      candidates = status.changes.filter((change) => change.untracked || change.unstaged)
      title = 'Discard working changes'
      subtitle = 'Select paths to discard. You will confirm the exact paths next.'
    }
    if (candidates.length === 0) {
      this.showStatus(operation === 'stage' ? 'No unstaged or untracked paths to stage.' : operation === 'unstage' ? 'No staged paths to unstage.' : 'No working-tree changes to discard.')
      return
    }
    this.showGitMultiSelect(title, subtitle, candidates.map((change) => ({
      value: change.path,
      label: `${change.indexStatus}${change.worktreeStatus} ${change.path}`,
      description: change.untracked ? 'untracked' : change.staged && change.unstaged ? 'staged and unstaged edits' : change.staged ? 'staged' : 'unstaged',
    })), preSelected, async (selected) => {
      if (this.agent.isBusy()) {
        this.showStatus('Git changes were cancelled because the Agent became busy.')
        return
      }
      const selectedPaths = new Set(selected.map((item) => item.value))
      if (operation === 'stage') {
        if (selectedPaths.size === 0) return this.showStatus('No paths selected; nothing staged.')
        await this.runGitMutation(repository, () => repository.stage([...selectedPaths]), `Staged ${selectedPaths.size} path${selectedPaths.size === 1 ? '' : 's'}.`)
      } else if (operation === 'unstage') {
        const paths = candidates.filter((change) => !selectedPaths.has(change.path)).map((change) => change.path)
        if (paths.length === 0) return this.showStatus('All selected paths remain staged.')
        await this.runGitMutation(repository, () => repository.unstage(paths), `Unstaged ${paths.length} path${paths.length === 1 ? '' : 's'}.`)
      } else {
        const paths = [...selectedPaths]
        if (paths.length === 0) return this.showStatus('No paths selected; nothing discarded.')
        this.showGitConfirmation(`Discard changes in ${paths.map((path) => `“${path}”`).join(', ')}?`, () => {
          if (this.agent.isBusy()) return this.showStatus('Discard cancelled because the Agent became busy.')
          void this.runGitMutation(repository, () => repository.discard(paths), `Discarded ${paths.length} path${paths.length === 1 ? '' : 's'}.`)
        })
      }
    })
  }

  private async showGitStashes(repository: GitRepository, action?: 'apply' | 'pop'): Promise<void> {
    const stashes = await repository.stashList()
    if (stashes.length === 0) {
      this.showStatus('No saved stashes.')
      return
    }
    this.showGitPicker(action ? `Select stash to ${action}` : 'Stashes', action ? `Choose a stash to ${action}` : 'Choose a stash to apply or pop', stashes.map((entry) => {
      const [ref = entry, ...description] = entry.split('\t')
      return { value: ref, label: ref, description: description.join(' · ') }
    }), (ref) => {
      const chooseAction = (selectedAction: 'apply' | 'pop') => {
        if (selectedAction === 'pop') {
          this.showGitConfirmation(`Apply and remove ${ref}?`, () => {
            if (this.agent.isBusy()) return this.showStatus('Stash pop cancelled because the Agent became busy.')
            void this.runGitMutation(repository, () => repository.stashApply(ref, true), `Applied and removed ${ref}.`)
          })
        } else {
          void this.runGitMutation(repository, () => repository.stashApply(ref), `Applied ${ref}.`)
        }
      }
      if (action) {
        chooseAction(action)
      } else {
        this.showGitPicker('Stash action', `Choose what to do with ${ref}`, [
          { value: 'apply', label: 'Apply stash', description: 'Keep the stash entry' },
          { value: 'pop', label: 'Pop stash', description: 'Apply and remove the stash · confirmation required' },
        ], (value) => chooseAction(value === 'pop' ? 'pop' : 'apply'))
      }
    })
  }

  private describeGitCommand(command: GitCommand): string {
    switch (command.action) {
      case 'fetch': return 'Fetch all remotes and prune stale remote refs?'
      case 'pull': return 'Pull the current branch using fast-forward only?'
      case 'push': return 'Push the current branch to its configured remote?'
      case 'branch-delete': return `Delete merged branch ${command.name}?`
      case 'stash-pop': return `Apply and remove ${command.ref ?? 'the selected stash'}?`
      case 'discard': return `Discard working-tree changes in ${command.paths.map((path) => `“${path}”`).join(', ')}?`
      default: return `Run ${command.action}?`
    }
  }

  private showGitConfirmation(message: string, onConfirm: () => void): void {
    this.showGitPicker('Confirm Git operation', message, [
      { value: 'confirm', label: 'Continue', description: message },
      { value: 'cancel', label: 'Cancel' },
    ], (value) => {
      if (value === 'confirm') onConfirm()
      else this.showStatus('Git operation cancelled.')
    })
  }

  private showGitPicker(title: string, subtitle: string, items: SelectItem[], onSelect: (value: string) => void): void {
    const list = new SelectList(items, Math.min(items.length, 14), {
      selectedPrefix: (text) => chalk.cyan(text),
      selectedText: (text) => chalk.cyan(text),
      description: (text) => theme.dim(text),
      scrollInfo: (text) => theme.dim(text),
      noMatch: (text) => theme.dim(text),
    })
    this.chatContainer.addChild(new Text(theme.fg('accent', title), 1, 0))
    this.chatContainer.addChild(new Text(theme.dim(subtitle), 1, 0))
    this.chatContainer.addChild(list)
    this.ui.setFocus(list)
    this.ui.requestRender()
    const close = () => {
      this.chatContainer.removeChild(list)
      this.chatContainer.addChild(new Spacer(1))
      this.ui.setFocus(this.editor)
    }
    list.onSelect = (item) => {
      close()
      onSelect(item.value)
      this.ui.requestRender()
    }
    list.onCancel = () => {
      close()
      this.showStatus('Git menu closed.')
    }
  }

  private showGitMultiSelect(
    title: string,
    subtitle: string,
    items: MultiSelectItem[],
    preSelected: number[],
    onConfirm: (selected: MultiSelectItem[]) => void | Promise<void>,
  ): void {
    const list = new MultiSelectList(items, Math.min(items.length, 14), {
      selectedText: (text) => chalk.cyan(text),
      disabledText: (text) => theme.dim(text),
      description: (text) => theme.dim(text),
      scrollInfo: (text) => theme.dim(text),
    }, preSelected)
    this.chatContainer.addChild(new Text(theme.fg('accent', title), 1, 0))
    this.chatContainer.addChild(new Text(theme.dim(subtitle), 1, 0))
    this.chatContainer.addChild(list)
    this.ui.setFocus(list)
    this.ui.requestRender()
    const close = () => {
      this.chatContainer.removeChild(list)
      this.chatContainer.addChild(new Spacer(1))
      this.ui.setFocus(this.editor)
    }
    list.onConfirm = (selected) => {
      close()
      void onConfirm(selected)
      this.ui.requestRender()
    }
    list.onCancel = () => {
      close()
      this.showStatus('Git selection cancelled; no changes made.')
    }
  }

  private showGitOutput(title: string, output: string): void {
    const limit = 12000
    const clipped = output.length > limit ? `${output.slice(0, limit)}\n\n… output truncated; rerun with narrower paths to inspect the remainder.` : output
    this.chatContainer.addChild(new Text(theme.fg('accent', title), 1, 0))
    if (!clipped.trim()) {
      this.chatContainer.addChild(new Text(theme.dim('(no changes)'), 1, 0))
    } else {
      for (const line of clipped.split(/\r?\n/)) this.chatContainer.addChild(new Text(line, 1, 0))
    }
    this.chatContainer.addChild(new Spacer(1))
    this.ui.setFocus(this.editor)
    this.ui.requestRender()
  }

  private showPluginPicker(
    title: string,
    subtitle: string,
    items: SelectItem[],
    onSelect: (value: string) => void,
  ): void {
    const list = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (text) => chalk.cyan(text),
      selectedText: (text) => chalk.cyan(text),
      description: (text) => theme.dim(text),
      scrollInfo: (text) => theme.dim(text),
      noMatch: (text) => theme.dim(text),
    })
    this.chatContainer.addChild(new Text(theme.fg('accent', title), 1, 0))
    this.chatContainer.addChild(new Text(theme.dim(subtitle), 1, 0))
    this.chatContainer.addChild(list)
    this.ui.setFocus(list)
    this.ui.requestRender()
    const close = () => {
      this.chatContainer.removeChild(list)
      this.chatContainer.addChild(new Spacer(1))
      this.ui.setFocus(this.editor)
    }
    list.onSelect = (item) => {
      close()
      onSelect(item.value)
      this.ui.requestRender()
    }
    list.onCancel = () => {
      close()
      this.ui.requestRender()
    }
  }

  private showPluginList(): void {
    const snapshot = this.pluginManager?.getSnapshot()
    const plugins = snapshot?.plugins ?? []
    if (plugins.length === 0) {
      this.chatContainer.addChild(new Text(theme.dim('No plugins discovered.'), 1, 0))
    } else {
      this.chatContainer.addChild(new Text(theme.fg('accent', `Plugins (${plugins.length})`), 1, 0))
      this.chatContainer.addChild(new Spacer(1))
      for (const plugin of plugins) {
        const servers = plugin.servers.length
        const healthColor = plugin.health === 'ready' ? chalk.green : plugin.health === 'warning' ? chalk.yellow : chalk.red
        this.chatContainer.addChild(new Text(`${theme.bold(plugin.name)} ${theme.dim(`v${plugin.version}`)} · ${plugin.scope} · ${plugin.enabled ? chalk.green('enabled') : theme.dim('disabled')} · ${healthColor(plugin.health)}`, 1, 0))
        this.chatContainer.addChild(new Text(`  ${theme.dim(`skills ${plugin.skills.length} · MCP servers ${servers}`)}`, 1, 0))
      }
    }
    if (snapshot?.diagnostics.length) {
      this.chatContainer.addChild(new Spacer(1))
      this.chatContainer.addChild(new Text(theme.fg('yellow', 'Discovery warnings'), 1, 0))
      for (const diagnostic of snapshot.diagnostics) this.chatContainer.addChild(new Text(`  ${theme.dim(diagnostic)}`, 1, 0))
    }
    this.chatContainer.addChild(new Spacer(1))
    this.ui.setFocus(this.editor)
    this.ui.requestRender()
  }

  private showSkillList(): void {
    const skillSnapshot = this.agent.getSkillSnapshot()
    const skills = skillSnapshot.available
    const diagnostics = skillSnapshot.diagnostics

    if (skills.length === 0) {
      this.chatContainer.addChild(
        new Text(theme.dim('No skills available.'), 1, 0),
      )
      this.chatContainer.addChild(
        new Text(theme.dim('Create SKILL.md files under Microcode home/skills or the current project\'s .microcode/skills directory to add skills.'), 1, 0),
      )
    } else {
      this.chatContainer.addChild(
        new Text(theme.fg('accent', `Available skills (${skills.length}):`), 1, 0),
      )
      this.chatContainer.addChild(new Spacer(1))

      for (const skill of skills) {
        const disabled = skill.disableModelInvocation ? theme.dim(' (disabled for $ invocation)') : ''
        const loaded = this.agent.isSkillLoaded(skill.name) ? chalk.green(' (enabled)') : theme.dim(' (disabled)')
        this.chatContainer.addChild(
          new Text(`${theme.bold(skill.name)}${disabled}${loaded}`, 1, 0),
        )
        this.chatContainer.addChild(
          new Text(`  ${theme.dim(skill.description)}`, 1, 0),
        )
        this.chatContainer.addChild(
          new Text(`  ${theme.dim(`${skill.scope} · ${skill.filePath}`)}`, 1, 0),
        )
        this.chatContainer.addChild(new Spacer(1))
      }
    }

    if (diagnostics.length > 0) {
      this.chatContainer.addChild(
        new Text(theme.fg('yellow', 'Skill diagnostics:'), 1, 0),
      )
      for (const diagnostic of diagnostics) {
        this.chatContainer.addChild(
          new Text(`  ${theme.dim(diagnostic)}`, 1, 0),
        )
      }
      this.chatContainer.addChild(new Spacer(1))
    }

    this.chatContainer.addChild(new Spacer(1))
    this.ui.requestRender()
  }

  private showSkillEnableDisableMenu(): void {
    if (this.agent.isBusy()) {
      this.showStatus('Skill settings were not changed: finish or interrupt the active turn, then choose the action again.')
      return
    }
    const skills = this.agent.getSkills()
    if (skills.length === 0) {
      this.showStatus('No skills available to enable or disable.')
      return
    }
    const items: MultiSelectItem[] = skills.map((skill) => ({
      value: skill.name,
      label: `${skill.name} · ${skill.scope}`,
      description: skill.description,
    }))
    const preSelected = skills.flatMap((skill, index) => this.agent.isSkillLoaded(skill.name) ? [index] : [])
    const selectList = new MultiSelectList(items, Math.min(items.length, 12), {
      selectedText: (text) => chalk.cyan(text),
      disabledText: (text) => theme.dim(text),
      description: (text) => theme.dim(text),
      scrollInfo: (text) => theme.dim(text),
    }, preSelected)
    this.chatContainer.addChild(new Text(theme.fg('accent', 'Enable/Disable Skills'), 1, 0))
    this.chatContainer.addChild(new Text(theme.dim('Checked skills will be enabled. Space toggles; Enter applies changes.'), 1, 0))
    this.chatContainer.addChild(selectList)
    this.ui.setFocus(selectList)
    this.ui.requestRender()
    selectList.onConfirm = (selected) => {
      this.chatContainer.removeChild(selectList)
      this.chatContainer.addChild(new Spacer(1))
      this.ui.setFocus(this.editor)
      if (this.agent.isBusy()) {
        this.showStatus('Skill settings were not changed: the Agent became busy before confirmation.')
        return
      }
      const selectedNames = new Set(selected.map((item) => item.value))
      let enabled = 0
      let disabled = 0
      const errors: string[] = []
      for (const skill of skills) {
        const wasLoaded = this.agent.isSkillLoaded(skill.name)
        const shouldLoad = selectedNames.has(skill.name)
        if (wasLoaded === shouldLoad) continue
        try {
          if (!shouldLoad) {
            this.agent.unloadSkill(skill.name)
            disabled++
          } else {
            this.agent.loadSkill(skill.name)
            enabled++
          }
        } catch (error) {
          errors.push(`${skill.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (errors.length > 0) this.showError(`Some skill changes failed: ${errors.join('; ')}`)
      else if (enabled === 0 && disabled === 0) this.showStatus('Skill settings are already up to date.')
      else this.showStatus(`Updated skills: ${enabled} enabled, ${disabled} disabled.`)
      this.ui.requestRender()
    }
    selectList.onCancel = () => {
      this.chatContainer.removeChild(selectList)
      this.chatContainer.addChild(new Spacer(1))
      this.ui.setFocus(this.editor)
      this.ui.requestRender()
    }
  }

  /**
   * Interactively present questions from the ask_user_question tool and collect answers.
   * Each question is shown as a SelectList in the chat area.
   * Returns the collected answers, or { block: true } if cancelled.
   */
  async promptAskUserQuestion(
    _toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ answers?: Record<string, string>; block?: boolean }> {
    const questions = input.questions as Array<{
      question: string
      header: string
      options: Array<{ label: string; description: string }>
      multiSelect?: boolean
    }>

    if (!questions || questions.length === 0) {
      return { block: true }
    }

    const answers: Record<string, string> = {}

    for (const q of questions) {
      const answer = await this.promptSingleQuestion(q)
      if (answer === undefined) {
        // User cancelled
        return { block: true }
      }
      answers[q.question] = answer
    }

    return { answers }
  }

  /**
   * Present a single question with its options as a SelectList.
   * Returns the selected answer string, or undefined if cancelled.
   */
  private async promptSingleQuestion(q: {
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiSelect?: boolean
  }): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      this.hideWorking()
      this.permissionPromptActive = true

      // Build select items from options + "Other"
      const items: SelectItem[] = q.options.map((opt) => ({
        value: opt.label,
        label: opt.label,
        description: opt.description,
      }))
      items.push({
        value: '__other__',
        label: 'Other',
        description: 'Provide a custom answer',
      })

      const selectList = new SelectList(items, items.length, {
        selectedPrefix: (text) => chalk.cyan(text),
        selectedText: (text) => chalk.cyan(text),
        description: (text) => theme.dim(text),
        scrollInfo: (text) => theme.dim(text),
        noMatch: (text) => theme.dim(text),
      })

      // Keep the question at the end of the active turn so subsequent output
      // appears below it instead of inserting controls into the chat history.
      const headerLabel = theme.fg('accent', `${q.header}:`)
      const prompt = new InlineSelectPrompt(`${headerLabel} ${q.question}`, selectList)
      this.appendTurnEntry(prompt, 'status')
      this.ui.setFocus(prompt)
      this.ui.requestRender()

      let finished = false
      const removeListener = this.ui.addInputListener((data) => {
        if (data === '\x03') {
          // Ctrl+C — cancel
          finished = true
          removeListener()
          this.permissionPromptActive = false
          prompt.complete(theme.dim('Cancelled'))
          this.ui.setFocus(this.editor)
          this.ui.requestRender()
          this.flushPendingEventsWhilePermission()
          resolve(undefined)
          return { consume: true }
        }
        return undefined
      })

      const finish = (value?: string) => {
        if (finished) return
        finished = true
        removeListener()
        this.permissionPromptActive = false
        if (value === '__other__') {
          prompt.complete(theme.dim('Type your answer and press Enter:'))
        } else if (value === undefined) {
          prompt.complete(theme.dim('Cancelled'))
        } else {
          prompt.complete(`  ${chalk.cyan(value)}`)
        }
        this.flushPendingEventsWhilePermission()

        if (value === '__other__') {
          this.ui.setFocus(this.editor)
          this.ui.requestRender()

          // Wait for user to type in the editor
          void this.getUserInput().then((text) => {
            const trimmed = text.trim()
            prompt.complete(`  ${chalk.cyan(trimmed)}`)
            this.showWorking()
            this.ui.setFocus(this.editor)
            this.ui.requestRender()
            resolve(trimmed || undefined)
          })
          return
        }

        this.showWorking()
        this.ui.setFocus(this.editor)
        this.ui.requestRender()
        resolve(value)
      }

      selectList.onSelect = (item) => finish(item.value)
      selectList.onCancel = () => finish(undefined)
    })
  }

  /**
   * Prompt user for tool permission at the end of the active turn timeline.
   * Returns true if approved, false if denied.
   */
  private async prepareApprovalPresentation(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    const prepare = getToolDefinition(toolName)?.presentation.prepareApproval
    if (!prepare) return
    const serializedInput = JSON.stringify(input)
    const matchingCall = [...this.toolCallMetadata.entries()].reverse().find(([, call]) =>
      call.name === toolName && JSON.stringify(call.args) === serializedInput,
    )
    if (!matchingCall) return

    const [toolCallId] = matchingCall
    const component = this.pendingTools.get(toolCallId) ?? this.toolRows.get(toolCallId)
    if (!component?.updateDetails) return

    try {
      const details = await prepare(this.agent.getSnapshot().cwd, input)
      if (details) dispatchToolLifecycle(component, { phase: 'presentation', details })
    } catch (error) {
      dispatchToolLifecycle(component, {
        phase: 'presentation',
        details: { phase: 'approval', previewNotice: `Preview unavailable: ${error instanceof Error ? error.message : 'unknown error'}` },
      })
    }
    this.ui.requestRender()
  }

  async promptPermission(
    toolName: string,
    input: Record<string, unknown>,
    description: string,
  ): Promise<boolean> {
    this.pauseToolElapsedTimer()
    this.hideWorking()
    this.permissionPromptActive = true
    const matchingCall = [...this.toolCallMetadata.entries()].reverse().find(([, call]) =>
      call.name === toolName && JSON.stringify(call.args) === JSON.stringify(input),
    )
    const pendingComponent = matchingCall
      ? this.pendingTools.get(matchingCall[0]) ?? this.toolRows.get(matchingCall[0])
      : undefined
    if (pendingComponent) dispatchToolLifecycle(pendingComponent, { phase: 'awaiting-approval' })
    await this.prepareApprovalPresentation(toolName, input)

    return new Promise<boolean>((resolve) => {

      // Extract content for session rule matching
      const ruleContent = this.extractRuleContent(toolName, input)
      const sessionLabel = ruleContent ? `${toolName}(${ruleContent})` : toolName

      const items: SelectItem[] = [
        { value: 'allow', label: 'Allow', description: `Allow ${toolName} to execute` },
        { value: 'allow-session', label: `Allow for session`, description: `Don't ask again for ${sessionLabel}` },
        { value: 'deny', label: 'Deny', description: `Block ${toolName} execution` },
      ]

      const selectList = new SelectList(items, items.length, {
        selectedPrefix: (text) => chalk.cyan(text),
        selectedText: (text) => chalk.cyan(text),
        description: (text) => theme.dim(text),
        scrollInfo: (text) => theme.dim(text),
        noMatch: (text) => theme.dim(text),
      })

      const permLabel = theme.fg('accent', 'Permission requested:')
      const prompt = new InlineSelectPrompt(`${permLabel} ${description}`, selectList)
      this.appendTurnEntry(prompt, 'status')
      this.ui.setFocus(prompt)
      this.ui.requestRender()

      // Intercept Ctrl+C before it reaches SelectList — exit app instead of deny
      let finished = false
      const removeListener = this.ui.addInputListener((data) => {
        if (data === '\x03') { // Ctrl+C
          finished = true
          removeListener()
          this.permissionPromptActive = false
          prompt.complete(chalk.red('✗ Denied'))
          this.flushPendingEventsWhilePermission()
          this.exit()
          return { consume: true }
        }
        return undefined
      })

      const finish = (approved: boolean) => {
        if (finished) return
        finished = true
        removeListener()
        this.permissionPromptActive = false
        prompt.complete(approved ? chalk.green('✓ Approved') : chalk.red('✗ Denied'))
        this.flushPendingEventsWhilePermission()
        // Start timing from approval, when execution is allowed to continue.
        if (approved) {
          this.resumeToolElapsedTimer()
          this.showWorking()
        }
        else {
          this.clearPendingToolState()
          this.hideWorking()
        }
        // Restore focus to editor so user can type again
        this.ui.setFocus(this.editor)
        this.ui.requestRender()
        if (!approved) this.agent.abort()
        resolve(approved)
      }

      selectList.onSelect = (item) => {
        if (item.value === 'allow-session') {
          this.agent.addSessionPermission(toolName, ruleContent)
        }
        finish(item.value === 'allow' || item.value === 'allow-session')
      }
      selectList.onCancel = () => finish(false)
    })
  }

  private extractRuleContent(toolName: string, input: Record<string, unknown>): string | undefined {
    switch (toolName) {
      case BASH_TOOL_NAME:
        return typeof input.command === 'string' ? input.command : undefined
      case EDIT_TOOL_NAME:
      case WRITE_TOOL_NAME:
      case READ_TOOL_NAME:
        return typeof input.path === 'string' ? input.path : undefined
      default:
        return undefined
    }
  }

  private showHelp(): void {
    const helpText = [
      `${theme.fg('accent', 'Available Commands:')}`,
      '',
      `  ${theme.bold('/clear')}              Clear the conversation history`,
      `  ${theme.bold('/compact')} [instr.]    Compress conversation context`,
      `  ${theme.bold('/status')}             Show context usage, token statistics, and model details`,
      `  ${theme.bold('/model')} [model-id]   Show current model or switch to a different model`,
      `  ${theme.bold('/login')} [provider]   Sign in with provider and method pickers`,
      `  ${theme.bold('/logout')} [provider]  Sign out with a provider picker`,
      `  ${theme.bold('/auth')}             Show provider authentication status`,
      `  ${theme.bold('/gateway')} [HOST]    View or change the gateway listen address`,
      `  ${theme.bold('/thinking')} [level]   Show or set thinking depth`,
      `  ${theme.bold('/mcp')}              List MCP servers`,
      `  ${theme.bold('/session')}            Browse and load saved sessions`,
      `  ${theme.bold('/skills')}             List, enable, or disable skills`,
      `  ${theme.bold('/plugins')}            List and enable or disable plugins`,
      `  ${theme.bold('/git')}                Inspect status, diffs, branches, staging, commits, and remotes`,
      `  ${theme.bold('/tasks')}              Browse and prioritize tasks in the current session`,
      `  ${theme.bold('/instructions')}       Show loaded project instruction files`,
      `  ${theme.bold('/instructions reload')} Reload project instruction files`,
      `  ${theme.bold('/init')}               Analyze the project and create or update MICRO.md`,
      `  ${theme.bold('/export')}             Export the current conversation JSONL`,
      `  ${theme.bold('/new')}                Start a new conversation session`,
      `  ${theme.bold('/permission')} [mode]  Show or switch permission mode`,
      `  ${theme.bold('/exit')}               Exit Microcode`,
      `  ${theme.bold('/help')}               Show this help message`,
      '',
      `${theme.fg('accent', 'Keyboard Shortcuts:')}`,
      '',
      `  ${theme.bold('Escape')}              Interrupt current operation`,
      `  ${theme.bold('Ctrl+C')}              Interrupt (when busy) / Exit`,
      `  ${theme.bold('Ctrl+D')}              Exit (when input is empty)`,
      `  ${theme.bold('Enter')}               Submit message`,
      `  ${theme.bold('Shift+Enter')}         New line in editor`,
      `  ${theme.bold('Up/Down')}             Browse command history`,
      `  ${theme.bold('Tab')}                 Accept autocomplete suggestion`,
      `  ${theme.bold('@')}                   Search and attach workspace files`,
      `  ${theme.bold('$skill-name')}         Include a skill in this request`,
      `  ${theme.bold('#plugin-name')}       Include a plugin in this request`,
      `  ${theme.bold('Ctrl+V / Shift+Insert')} Paste clipboard image`,
      '',
      `${theme.fg('accent', 'Environment Variables:')}`,
      '',
      `  ANTHROPIC_API_KEY     Anthropic API key`,
      `  ANTHROPIC_BASE_URL    Anthropic API base URL`,
      `  ANTHROPIC_MODEL       Anthropic model ID`,
      `  OPENAI_API_KEY        OpenAI API key`,
      `  OPENAI_BASE_URL       OpenAI API base URL`,
      `  OPENAI_MODEL          OpenAI model ID`,
      `  API_KEY               Fallback API key`,
      `  BASE_URL              Fallback base URL`,
      `  MODEL                 Fallback model ID`,
    ]

    // Add available skills
    const skills = this.agent.getSkills()
    if (skills.length > 0) {
      helpText.push('')
      helpText.push(`${theme.fg('accent', 'Available Skills:')}`)
      helpText.push('')
      for (const skill of skills) {
        const disabled = skill.disableModelInvocation ? ' (disabled)' : ''
        helpText.push(`  ${theme.bold(`$${skill.name}`)}${disabled}    ${skill.description}`)
      }
    }

    for (const line of helpText) {
      this.chatContainer.addChild(new Text(line, 1, 0))
    }
    this.chatContainer.addChild(new Spacer(1))
    this.ui.requestRender()
  }

  private showStatus(message: string): void {
    this.chatContainer.addChild(new Spacer(1))
    this.chatContainer.addChild(new Text(theme.dim(message), 1, 0))
    this.chatContainer.addChild(new Spacer(1))
    this.ui.requestRender()
  }

  private showError(message: string): void {
    this.chatContainer.addChild(
      new Text(chalk.hex('#cc6666')(`Error: ${message}`), 1, 0),
    )
    this.chatContainer.addChild(new Spacer(1))
    this.ui.requestRender()
  }

  getPendingImageContents(): ImageContent[] {
    return this.pendingImages.map((img) => ({
      type: 'image' as const,
      data: img.base64Data,
      mimeType: img.mimeType,
    }))
  }

  clearPendingImages(): void {
    this.pendingImages = []
    this.suppressTrailingQuote = false
  }

  private handleEditorSubmit(text: string): void {
    this.appLayout.followLatest()
    this.editor.addToHistory(text)

    // Agent is busy — no one is listening for input yet. Handle slash commands
    // inline, or tell the user the agent is busy.
    if (!this._inputResolve && this.isAgentBusy()) {
      if (text.startsWith('/')) {
        this.handleSlashCommand(text.trim())
        this.ui.requestRender()
        return
      }
      if (text.startsWith('!')) {
        const bashInput = parseBashInput(text)
        if (!bashInput?.command) {
          this.showStatus('Enter a terminal command after !.')
          return
        }
        if (this.bashComponent || this.activeBashProcess) {
          this.showStatus('A terminal command is already running. Wait for it to finish before starting another.')
          return
        }
        this.isBashMode = false
        void this.handleBashCommand(bashInput.command, bashInput.excludeFromContext)
        return
      }
      this.showStatus(
        `Agent is busy — press Esc or Ctrl+C to cancel. Type /help for available commands.`,
      )
      return
    }

    this._pendingInput = text
    this._inputResolve?.()
  }

  private _pendingInput?: string
  private _inputResolve?: () => void

  async getUserInput(): Promise<string> {
    return new Promise<string>((resolve) => {
      this._inputResolve = () => {
        const text = this._pendingInput ?? ''
        this._pendingInput = undefined
        this._inputResolve = undefined
        resolve(text)
      }

      if (this._pendingInput !== undefined) {
        this._inputResolve()
      }
    })
  }

  private appendTurnEntry(component: Component, kind: 'user' | 'assistant' | 'tool' | 'status' = 'status'): void {
    if (this.activeTurnTimeline) {
      this.activeTurnTimeline.addEntry(component, kind)
    } else {
      this.chatContainer.addChild(component)
    }
  }

  private createToolRow(toolCallId: string, toolName: string, args: any): ToolUIComponent {
    const UIConstructor = getToolUIConstructor(toolName)
    const component: ToolUIComponent = UIConstructor
      ? new UIConstructor(toolCallId, args)
      : new ToolExecutionComponent(toolName, toolCallId, args)
    this.toolRows.set(toolCallId, component)
    return component
  }

  private finishTurn(): void {
    if (this.turnFinalized) return
    this.activeTurnTimeline?.setActivity(undefined)
    this.turnFinalized = true
    // A single visual gap belongs between user turns, not between every model
    // turn (tool handoffs can produce many turn_end events in one user turn).
    this.chatContainer.addChild(new Spacer(1))
  }

  private setupAgentSubscription(): void {
    this.agent.subscribe((event: MicrocodeAgentEvent) => {
      const process = () => {
        switch (event.type) {
        case 'compaction_changed':
          this.updateCompactionProgress(event.progress)
          break

        case 'state_changed':
          if (event.reason === 'compaction_completed') {
            this.appendContextCompactedEntry()
          }
          break

        case 'agent_start':
          this.setAgentActivity({ type: 'thinking' })
          break

        case 'message_start':
          if (event.message.role === 'assistant') {
            this.streamingComponent = new AssistantMessageComponent(getMarkdownTheme())
            this.streamingMessage = event.message
            this.appendTurnEntry(this.streamingComponent, 'assistant')
            this.setAgentActivity({ type: 'thinking' })
            this.streamingComponent.updateContent(this.streamingMessage)
            this.ui.requestRender()
          }
          break

        case 'message_update':
          if (this.streamingComponent && event.message.role === 'assistant') {
            this.streamingMessage = event.message
            this.streamingComponent.updateContent(this.streamingMessage)
            if (
              event.assistantMessageEvent.type === 'text_delta' &&
              this.activityState.phase !== 'responding'
            ) {
              this.setAgentActivity({ type: 'responding', pendingTools: this.pendingTools.size })
            }
            if (
              event.assistantMessageEvent.type === 'toolcall_start' ||
              event.assistantMessageEvent.type === 'toolcall_delta'
            ) {
              this.setAgentActivity({ type: 'preparing-tool' })
              this.updateStreamingToolCall(
                event.message,
                event.assistantMessageEvent.type === 'toolcall_start',
              )
            }
            this.ui.requestRender()
          }
          break

        case 'message_end':
          if (event.message.role === 'assistant') {
            if (this.streamingComponent && this.streamingMessage) {
              this.streamingComponent.updateContent(this.streamingMessage)
              this.streamingComponent = undefined
              this.streamingMessage = undefined
            }
            this.updateContextUsage()
            this.footer.invalidate()
          }
          this.ui.requestRender()
          break

        case 'tool_execution_start': {
          const existing = this.pendingTools.get(event.toolCallId)
          const alreadyVisible = this.toolRows.has(event.toolCallId)
          const component: ToolUIComponent = existing ?? this.toolRows.get(event.toolCallId)
            ?? this.createToolRow(event.toolCallId, event.toolName, event.args)
          dispatchToolLifecycle(component, { phase: 'created', input: event.args })
          dispatchToolLifecycle(component, { phase: 'running' })
          if (!alreadyVisible) {
            this.appendTurnEntry(component, 'tool')
          }
          this.pendingTools.set(event.toolCallId, component)
          this.pendingToolStartedAt.set(event.toolCallId, performance.now())
          this.startToolElapsedTimer()
          // Keep the global working indicator alive across the model -> tool handoff.
          this.setAgentActivity({ type: 'tool-started', toolName: event.toolName })
          this.commitToolFrame()
          break
        }

        case 'tool_execution_update': {
          const component = this.pendingTools.get(event.toolCallId)
          if (component) {
            dispatchToolLifecycle(component, {
              phase: 'partial',
              result: { ...event.partialResult, isError: false },
            })
            this.commitToolFrame()
          }
          break
        }

        case 'tool_execution_end': {
          const component = this.pendingTools.get(event.toolCallId)
          if (component) {
            const startedAt = this.pendingToolStartedAt.get(event.toolCallId)
            if (startedAt !== undefined) {
              component.updateElapsed?.(performance.now() - startedAt)
            }
            dispatchToolLifecycle(component, {
              phase: event.isError ? 'failed' : 'completed',
              result: { ...event.result, isError: event.isError },
            })
            this.updateContextUsage()
            this.footer.invalidate()
          }
          this.pendingTools.delete(event.toolCallId)
          this.toolCallMetadata.delete(event.toolCallId)
          this.pendingToolStartedAt.delete(event.toolCallId)
          this.streamingToolLastRenderAt.delete(event.toolCallId)
          this.stopToolElapsedTimerIfIdle()
          this.setAgentActivity({ type: 'tool-finished', pendingTools: this.pendingTools.size })
          this.ui.requestRender()
          break
        }

        case 'turn_end':
          if (
            event.message.role === 'assistant' &&
            (event.message.stopReason === 'aborted' || event.message.stopReason === 'error')
          ) {
            this.clearPendingToolState()
            this.activeTurnTimeline?.setActivity(undefined)
            this.activityState = { phase: 'idle' }
            const isInterrupted = event.message.stopReason === 'aborted'
            this.appendTurnEntry(new Text(
              theme.fg('error', isInterrupted
                ? 'Interrupted'
                : `Error: ${event.message.errorMessage || 'Unknown error'}`),
              1,
              0,
            ))
            this.finishTurn()
            this.hideWorking()
          // A streamed tool call may already be pending before tool_execution_start.
          // Do not hide Working during that model -> tool handoff.
          } else if (this.pendingTools.size > 0) {
            this.setAgentActivity({ type: 'work-finished', pendingTools: this.pendingTools.size })
          } else {
            this.setAgentActivity({ type: 'work-finished', pendingTools: 0 })
          }
          if (event.message.role === 'assistant' && event.message.stopReason === 'stop') {
            this.finishTurn()
          }
          // Generate session title from first user message
          if (!this.titleGenerated) {
            this.titleGenerated = true
            void this.generateSessionTitle(this.firstUserInputForTitle)
          }
          void this.agent.persistMessages()
          this.updateContextUsage()
          this.footer.invalidate()
          this.ui.requestRender()
          break

        case 'agent_end':
          if (!this.isAgentBusy()) {
            this.applyQueuedMcpState()
            this.clearPendingToolState()
            this.finishTurn()
            this.setAgentActivity({ type: 'work-finished', pendingTools: 0 })
            this.ui.requestRender()
            break
          }
          // Some agent implementations emit agent_end for the model turn before
          // executing its requested tools. Pending tools still mean real work remains.
          if (this.pendingTools.size === 0) {
            this.finishTurn()
            this.setAgentActivity({ type: 'work-finished', pendingTools: 0 })
          } else {
            this.setAgentActivity({ type: 'work-finished', pendingTools: this.pendingTools.size })
          }
          this.ui.requestRender()
          break
        }
      }
      if (this.permissionPromptActive) {
        this.pendingEventsWhilePermission.push(() => process())
      } else {
        process()
      }
    })
  }

  private flushPendingEventsWhilePermission(): void {
    const queue = this.pendingEventsWhilePermission
    this.pendingEventsWhilePermission = []
    for (const replay of queue) {
      replay()
    }
  }

  private updateWorkingIndicator(): void {
    if (this.agentWorking) {
      this.workingFrameIndex++
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
      const frame = frames[Math.floor(this.workingFrameIndex / 2) % frames.length]
      const elapsedSeconds = Math.floor((Date.now() - this.workingStartedAt) / 1000)
      const label = `${theme.fg('accent', frame)} ${this.agentActivityLabel} · ${elapsedSeconds}s`
      if (this.activeTurnTimeline) {
        // 工具卡片展示执行细节；活动行仍保留模型/工具交接状态，避免 OpenAI 等
        // 不提供可展示摘要的 Provider 在工具执行期间看起来像“没有进度”。
        this.activeTurnTimeline.setActivity(label)
        if (this.workingText) {
          this.workingContainer.removeChild(this.workingText)
          this.workingText = null
        }
      } else if (this.workingText) {
        this.workingText.setText(label)
      } else {
        this.workingText = new Text(label, 1, 0)
        this.workingContainer.addChild(this.workingText)
      }
      if (!this.workingTimer) {
        this.workingTimer = setInterval(() => {
          this.updateWorkingIndicator()
          this.ui.requestRender()
        }, 80)
      }
      return
    }
    if (this.workingTimer) {
      clearInterval(this.workingTimer)
      this.workingTimer = undefined
    }
    if (this.workingText) {
      this.workingContainer.removeChild(this.workingText)
      this.workingText = null
    }
    this.activeTurnTimeline?.setActivity(undefined)
    this.workingFrameIndex = 0
  }
  private updateStreamingToolCall(message: AgentMessage, forceRender: boolean): void {
    if (message.role !== 'assistant') return

    const toolCalls = message.content.filter((block) => block.type === 'toolCall')
    for (const toolCall of toolCalls) {
      const args = toolCall.arguments ?? {}
      this.toolCallMetadata.set(toolCall.id, { name: toolCall.name, args })
      let component = this.pendingTools.get(toolCall.id) ?? this.toolRows.get(toolCall.id)

      if (!component) {
        component = this.createToolRow(toolCall.id, toolCall.name, args)
        dispatchToolLifecycle(component, { phase: 'created', input: args })
        dispatchToolLifecycle(component, { phase: 'running' })
        this.appendTurnEntry(component, 'tool')
        this.pendingTools.set(toolCall.id, component)
        // The tool is pending as soon as its call starts streaming. Waiting for
        // tool_execution_start creates a visible gap where Working disappears.
        this.setAgentActivity({ type: 'preparing-tool' })
      } else {
        dispatchToolLifecycle(component, { phase: 'input', input: args })
      }

      const projectInput = getToolDefinition(toolCall.name)?.presentation.projectInput
      const projected = projectInput?.(this.agent.getSnapshot().cwd, args)
      if (projected) dispatchToolLifecycle(component, { phase: 'presentation', details: projected })

      const now = performance.now()
      const lastRenderAt = this.streamingToolLastRenderAt.get(toolCall.id) ?? 0
      if (forceRender || now - lastRenderAt >= 100) {
        this.streamingToolLastRenderAt.set(toolCall.id, now)
        this.commitToolFrame()
      }
    }
  }

  private commitToolFrame(): void {
    const immediateUi = this.ui as unknown as {
      stopped?: boolean
      renderRequested?: boolean
      renderTimer?: ReturnType<typeof setTimeout>
      lastRenderAt?: number
      doRender?: () => void
    }

    if (!immediateUi.stopped && typeof immediateUi.doRender === 'function') {
      if (immediateUi.renderTimer) {
        clearTimeout(immediateUi.renderTimer)
        immediateUi.renderTimer = undefined
      }
      immediateUi.renderRequested = false
      immediateUi.lastRenderAt = performance.now()
      immediateUi.doRender()
      return
    }

    // Fallback for future pi-tui versions that change their renderer internals.
    this.ui.requestRender()
  }

  private updateCompactionProgress(
    progress: Extract<
      MicrocodeAgentEvent,
      { type: 'compaction_changed' }
    >['progress'],
  ): void {
    if (progress.phase === 'done') {
      const label = getAgentActivityLabel(this.activityState)
      if (label) this.showWorking(label)
      else this.hideWorking()
      return
    }

    this.showWorking('Compacting context…')
  }

  private updateContextUsage(): void {
    this.footer.invalidate()
  }

  private startToolElapsedTimer(): void {
    if (this.toolElapsedTimer) return

    this.toolElapsedTimer = setInterval(() => {
      const now = performance.now()
      let updated = false

      for (const [toolCallId, startedAt] of this.pendingToolStartedAt) {
        const component = this.pendingTools.get(toolCallId)
        if (!component?.updateElapsed) continue
        component.updateElapsed(now - startedAt)
        updated = true
      }

      if (updated) {
        this.ui.requestRender()
      }
    }, 100)
  }

  private stopToolElapsedTimerIfIdle(): void {
    if (this.pendingToolStartedAt.size > 0 || !this.toolElapsedTimer) return
    clearInterval(this.toolElapsedTimer)
    this.toolElapsedTimer = undefined
  }

  private pauseToolElapsedTimer(): void {
    if (this.toolElapsedTimer) {
      clearInterval(this.toolElapsedTimer)
      this.toolElapsedTimer = undefined
    }

    this.pendingToolStartedAt.clear()
    for (const component of this.pendingTools.values()) {
      component.updateElapsed?.(0)
    }
    this.ui.requestRender()
  }

  private resumeToolElapsedTimer(): void {
    const startedAt = performance.now()
    for (const [toolCallId, component] of this.pendingTools) {
      if (!component.updateElapsed) continue
      component.updateElapsed(0)
      this.pendingToolStartedAt.set(toolCallId, startedAt)
    }
    if (this.pendingToolStartedAt.size > 0) {
      this.startToolElapsedTimer()
    }
  }

  private clearPendingToolState(): void {
    this.pendingTools.clear()
    this.toolCallMetadata.clear()
    this.pendingToolStartedAt.clear()
    this.streamingToolLastRenderAt.clear()
    if (this.toolElapsedTimer) {
      clearInterval(this.toolElapsedTimer)
      this.toolElapsedTimer = undefined
    }
  }

  private showWorking(label = 'Working…'): void {
    if (!this.agentWorking) this.workingStartedAt = Date.now()
    this.agentActivityLabel = label
    this.agentWorking = true
    this.updateWorkingIndicator()
    this.ui.requestRender()
  }

  private setAgentActivity(event: AgentActivityEvent): void {
    this.activityState = transitionAgentActivity(this.activityState, event)
    const label = getAgentActivityLabel(this.activityState)
    if (label) this.showWorking(label)
    else this.hideWorking()
  }

  private hideWorking(): void {
    if (!this.agentWorking) {
      this.activeTurnTimeline?.setActivity(undefined)
      return
    }
    this.agentWorking = false
    this.updateWorkingIndicator()
    this.workingStartedAt = 0
    this.ui.requestRender()
  }

  stop(): void {
    if (this.activeBashProcess) {
      this.cancelBashCommand()
    }
    if (this.toolElapsedTimer) {
      clearInterval(this.toolElapsedTimer)
      this.toolElapsedTimer = undefined
    }
    if (this.workingTimer) {
      clearInterval(this.workingTimer)
      this.workingTimer = undefined
    }
    if (this.workingText) {
      this.workingContainer.removeChild(this.workingText)
      this.workingText = null
    }
    if (this.mouseTrackingEnabled) {
      this.ui.terminal.write('\x1b[?1002l\x1b[?1006l')
      this.mouseTrackingEnabled = false
    }
    this.ui.stop()
  }

  private isAgentBusy(): boolean {
    return this.agent.isBusy()
  }

  private exit(): void {
    this.stop()
    if (this.onExit) {
      this.onExit()
    } else {
      process.exit(0)
    }
  }
}
