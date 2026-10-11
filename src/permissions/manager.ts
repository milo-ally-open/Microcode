import type { AgentTool, BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core'
import { getToolDefinition } from '../tools/registry.ts'
import { matchRule, parseRuleString, ruleValueToString } from './rules.ts'
import type {
  EffectivePolicy,
  PermissionBehavior,
  PermissionDecision,
  PermissionMode,
  PermissionSnapshot,
  PermissionRule,
  PermissionRuleValue,
  ToolPermissionContext,
} from './types.ts'
import { TOOL_DEFAULT_PERMISSIONS, ASK_USER_QUESTION_TOOL_NAME } from '../tools/index.ts'

export interface PermissionManagerOptions {
  mode?: PermissionMode
  allowedTools?: string[]
  deniedTools?: string[]
  askTools?: string[]
  onPermissionRequest?: (
    toolName: string,
    input: Record<string, unknown>,
    description: string,
  ) => Promise<boolean>
  onAskUserQuestion?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<{ answers?: Record<string, string>; block?: boolean }>
  getTool?: (name: string) => AgentTool<any, any> | undefined
}

export class PermissionManager {
  private context: ToolPermissionContext
  private onPermissionRequest?: (
    toolName: string,
    input: Record<string, unknown>,
    description: string,
  ) => Promise<boolean>
  private onAskUserQuestion?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<{ answers?: Record<string, string>; block?: boolean }>
  private getTool?: (name: string) => AgentTool<any, any> | undefined

  constructor(options: PermissionManagerOptions = {}) {
    const allowRules: PermissionRule[] = []
    const denyRules: PermissionRule[] = []
    const askRules: PermissionRule[] = []

    for (const spec of options.allowedTools ?? []) {
      const value = parseRuleString(spec)
      allowRules.push({ ...value, behavior: 'allow', source: 'cliArg' })
    }
    for (const spec of options.deniedTools ?? []) {
      const value = parseRuleString(spec)
      denyRules.push({ ...value, behavior: 'deny', source: 'cliArg' })
    }
    for (const spec of options.askTools ?? []) {
      const value = parseRuleString(spec)
      askRules.push({ ...value, behavior: 'ask', source: 'cliArg' })
    }

    this.context = {
      mode: options.mode ?? 'interactive',
      allowRules,
      denyRules,
      askRules,
    }
    this.onPermissionRequest = options.onPermissionRequest
    this.onAskUserQuestion = options.onAskUserQuestion
    this.getTool = options.getTool
  }

  setOnPermissionRequest(
    handler: (
      toolName: string,
      input: Record<string, unknown>,
      description: string,
    ) => Promise<boolean>,
  ): void {
    this.onPermissionRequest = handler
  }

  setOnAskUserQuestion(
    handler: (
      toolName: string,
      input: Record<string, unknown>,
    ) => Promise<{ answers?: Record<string, string>; block?: boolean }>,
  ): void {
    this.onAskUserQuestion = handler
  }

  setGetTool(
    resolver: (name: string) => AgentTool<any, any> | undefined,
  ): void {
    this.getTool = resolver
  }

  getMode(): PermissionMode {
    return this.context.mode
  }

  setMode(mode: PermissionMode): void {
    this.context.mode = mode
  }

  getEffectivePolicy(): Readonly<EffectivePolicy> {
    return Object.freeze({
      approvalMode: this.context.mode === 'auto-approve' ? 'auto-approve' : 'interactive',
      rules: Object.freeze([
        ...this.context.denyRules,
        ...this.context.askRules,
        ...this.context.allowRules,
      ].map((rule) => Object.freeze({ ...rule }))),
    })
  }

  addRule(rule: PermissionRule): void {
    const list = this.getRuleList(rule.behavior)
    list.push({ ...rule })
  }

  removeRule(ruleValue: PermissionRuleValue, behavior: PermissionBehavior): void {
    const list = this.getRuleList(behavior)
    const idx = list.findIndex(
      (r) =>
        r.toolName.toLowerCase() === ruleValue.toolName.toLowerCase() &&
        r.ruleContent === ruleValue.ruleContent,
    )
    if (idx !== -1) list.splice(idx, 1)
  }

  addSessionRule(toolName: string, ruleContent?: string): void {
    this.context.allowRules.push({
      toolName,
      ruleContent,
      behavior: 'allow',
      source: 'session',
    })
  }

  getContext(): ToolPermissionContext {
    return {
      mode: this.context.mode,
      allowRules: this.context.allowRules.map((rule) => ({ ...rule })),
      denyRules: this.context.denyRules.map((rule) => ({ ...rule })),
      askRules: this.context.askRules.map((rule) => ({ ...rule })),
    }
  }

  getSnapshot(): Readonly<PermissionSnapshot> {
    const freezeRules = (rules: PermissionRule[]): readonly Readonly<PermissionRule>[] =>
      Object.freeze(rules.map((rule) => Object.freeze({ ...rule })))

    return Object.freeze({
      mode: this.context.mode,
      approvalMode: this.context.mode === 'auto-approve' ? 'auto-approve' : 'interactive',
      allowRules: freezeRules(this.context.allowRules),
      denyRules: freezeRules(this.context.denyRules),
      askRules: freezeRules(this.context.askRules),
    })
  }

  checkPermission(
    toolName: string,
    _input: Record<string, unknown>,
  ): PermissionDecision {
    const { mode } = this.context

    const denyMatch = matchRule(toolName, _input, this.context.denyRules)
    if (denyMatch) {
      return { allowed: false, reason: `Tool "${toolName}" denied by rule: ${ruleValueToString(denyMatch)}` }
    }

    const askMatch = matchRule(toolName, _input, this.context.askRules)
    if (askMatch) {
      return { allowed: false, reason: 'ask' }
    }

    const allowMatch = matchRule(toolName, _input, this.context.allowRules)
    if (allowMatch) {
      return { allowed: true }
    }

    if (mode === 'auto-approve' && toolName !== ASK_USER_QUESTION_TOOL_NAME) {
      return { allowed: true }
    }

    const defaultBehavior = TOOL_DEFAULT_PERMISSIONS[toolName]
    if (defaultBehavior === 'allow') {
      return { allowed: true }
    }

    return { allowed: false, reason: 'ask' }
  }

  async checkPermissionWithPrompt(
    ctx: BeforeToolCallContext,
  ): Promise<BeforeToolCallResult | undefined> {
    const toolName = ctx.toolCall.name
    const input = (ctx.args ?? ctx.toolCall.arguments) as Record<string, unknown>
    const decision = this.checkPermission(toolName, input)

    if (decision.allowed) return undefined

    if (decision.reason !== 'ask') {
      return { block: true, reason: decision.reason }
    }

    // AskUserQuestion — permission flow IS the tool's functionality
    if (toolName === ASK_USER_QUESTION_TOOL_NAME && this.onAskUserQuestion) {
      const result = await this.onAskUserQuestion(toolName, input)
      if (result.block) {
        return { block: true, reason: `User cancelled question for "${toolName}"` }
      }
      if (result.answers && this.getTool) {
        const tool = this.getTool(toolName) as any
        if (tool?.setAnswers) {
          tool.setAnswers(result.answers)
        }
      }
      return undefined
    }

    if (!this.onPermissionRequest) {
      return { block: true, reason: `Permission required for "${toolName}" (non-interactive mode)` }
    }

    const description = this.formatToolDescription(toolName, input)
    const approved = await this.onPermissionRequest(toolName, input, description)
    if (approved) return undefined

    return { block: true, reason: `Permission denied by user for "${toolName}"` }
  }

  private getRuleList(behavior: PermissionBehavior): PermissionRule[] {
    switch (behavior) {
      case 'allow': return this.context.allowRules
      case 'deny': return this.context.denyRules
      case 'ask': return this.context.askRules
    }
  }

  private formatToolDescription(
    toolName: string,
    input: Record<string, unknown>,
  ): string {
    const def = getToolDefinition(toolName)
    if (def?.agent.formatDescription) {
      return def.agent.formatDescription(input)
    }
    return `${toolName}(${JSON.stringify(input).slice(0, 100)})`
  }
}
