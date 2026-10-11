export const PERMISSION_MODES = ['interactive', 'auto-approve', 'plan'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]
export type ApprovalMode = Exclude<PermissionMode, 'plan'>

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

export type PermissionRuleSource =
  | 'globalSettings'
  | 'projectSettings'
  | 'cliArg'
  | 'session'

export interface PermissionRule {
  toolName: string
  ruleContent?: string
  behavior: PermissionBehavior
  source: PermissionRuleSource
}

export interface PermissionRuleValue {
  toolName: string
  ruleContent?: string
}

export type PermissionDecision =
  | { allowed: true }
  | { allowed: false; reason: string }

export interface EffectivePolicy {
  approvalMode: ApprovalMode
  rules: readonly Readonly<PermissionRule>[]
}

export interface ToolPermissionContext {
  mode: PermissionMode
  allowRules: PermissionRule[]
  denyRules: PermissionRule[]
  askRules: PermissionRule[]
}

export interface PermissionSnapshot {
  readonly mode: PermissionMode
  readonly approvalMode: ApprovalMode
  readonly allowRules: readonly Readonly<PermissionRule>[]
  readonly denyRules: readonly Readonly<PermissionRule>[]
  readonly askRules: readonly Readonly<PermissionRule>[]
}
