/**
 * Permission rule matching engine.
 *
 * Rules follow microcode-ts's pattern format:
 * - "bash" or "bash(*)" — matches all bash commands
 * - "bash(rm:*)" — matches bash commands whose content starts with "rm"
 * - "file_edit" — matches all edit operations
 *
 * Matching is case-insensitive for tool names.
 */

import type { PermissionRule, PermissionRuleValue } from './types.ts'
import { getToolDefinition } from '../tools/registry.ts'

/**
 * Extract the content string from tool input for pattern matching.
 * Uses the tool registry's extractMatchContent if available,
 * otherwise falls back to scanning common fields.
 */
export function extractContentForMatching(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  const def = getToolDefinition(toolName)
  if (def?.agent.extractMatchContent) {
    return def.agent.extractMatchContent(input)
  }
  // For MCP and unknown tools, try common fields
  for (const key of ['command', 'path', 'input', 'query', 'content']) {
    if (typeof input[key] === 'string') return input[key]
  }
  return undefined
}

/**
 * Check if a rule's content pattern matches the actual tool input content.
 *
 * Pattern syntax:
 * - No ruleContent or ruleContent === "*" → matches everything
 * - "prefix:*" → matches content starting with "prefix"
 * - "suffix*" → matches content starting with "suffix"
 * - exact string → matches content containing that string
 */
function matchesContentPattern(
  ruleContent: string | undefined,
  actualContent: string | undefined,
): boolean {
  if (!ruleContent || ruleContent === '*') return true
  if (!actualContent) return false

  const lowerPattern = ruleContent.toLowerCase()
  const lowerContent = actualContent.toLowerCase()

  // Prefix pattern: "rm:*" matches "rm -rf /tmp"
  if (lowerPattern.endsWith(':*')) {
    const prefix = lowerPattern.slice(0, -2)
    return lowerContent.startsWith(prefix)
  }

  // Wildcard suffix pattern: "rm*" matches "rm", "rm -rf"
  if (lowerPattern.endsWith('*')) {
    const prefix = lowerPattern.slice(0, -1)
    return lowerContent.startsWith(prefix)
  }

  // Exact match or contains
  return lowerContent.includes(lowerPattern)
}

/**
 * Parse a rule string like "bash(rm:*)" into a PermissionRuleValue.
 */
export function parseRuleString(ruleString: string): PermissionRuleValue {
  const match = ruleString.match(/^([^(]+)(?:\(([^)]*)\))?$/)
  if (!match) {
    return { toolName: ruleString.trim() }
  }
  return {
    toolName: match[1].trim(),
    ruleContent: match[2]?.trim() || undefined,
  }
}

/**
 * Serialize a PermissionRuleValue back to string form.
 */
export function ruleValueToString(rule: PermissionRuleValue): string {
  if (rule.ruleContent) {
    return `${rule.toolName}(${rule.ruleContent})`
  }
  return rule.toolName
}

/**
 * Find the first matching rule for a given tool call.
 * Returns the matching rule, or undefined if no rule matches.
 */
export function matchRule(
  toolName: string,
  input: Record<string, unknown>,
  rules: PermissionRule[],
): PermissionRule | undefined {
  const content = extractContentForMatching(toolName, input)

  for (const rule of rules) {
    if (rule.toolName.toLowerCase() !== toolName.toLowerCase()) continue
    if (matchesContentPattern(rule.ruleContent, content)) {
      return rule
    }
  }

  return undefined
}
