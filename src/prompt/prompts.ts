import type { McpServerState } from '../mcp/types.ts'
import type { Skill } from '../skill.ts'
import { formatSkillsForPrompt } from '../skill.ts'
import { getMcpInstructionsSection } from '../mcp/prompt.ts'
import { getAskUserQuestionSection } from '../tools/AskUserQuestionTool/prompt.ts'
import { getTaskToolSection } from '../tools/TaskTool/prompt.ts'
import { getDeferredToolsSection, getUsingYourToolsSection } from '../tools/prompt.ts'
import {
  getActionsSection,
  getDoingTasksSection,
  getIntroSection,
  getOutputEfficiencySection,
  getSystemSection,
  getToneAndStyleSection,
} from './base.ts'
import { getEnvInfoSection } from './environment.ts'
import { getProjectInstructionsSection } from './projectInstructions.ts'
import type { ProjectInstructions } from '../instructions/projectInstructions.ts'

/**
 * Central prompt assembler.
 *
 * Keep prompt text in the domain module that owns the behavior. This file should
 * only define ordering and cross-module composition for the final system prompt.
 */
export interface GetSystemPromptOptions {
  cwd: string
  modelId: string
  mcpServers?: McpServerState[]
  skills?: Skill[]
  /** Names of tools that are deferred (discovered via ToolSearchTool). */
  deferredToolNames?: string[]
  projectInstructions?: ProjectInstructions
}

function getSkillsInstructionsSection(skills: Skill[] | undefined): string | null {
  if (!skills || skills.length === 0) return null

  return formatSkillsForPrompt(skills)
}

/** Compose the model-facing system prompt in the order expected by the agent runtime. */
export function getSystemPrompt(options: GetSystemPromptOptions): string[] {
  const { cwd, modelId, mcpServers, skills, deferredToolNames, projectInstructions } = options

  return [
    getIntroSection(),
    getSystemSection(),
    getDoingTasksSection(),
    getActionsSection(),
    getUsingYourToolsSection(),
    getToneAndStyleSection(),
    getOutputEfficiencySection(),
    getAskUserQuestionSection(),
    getTaskToolSection(),
    getEnvInfoSection(cwd, modelId),
    getProjectInstructionsSection(projectInstructions),
    getMcpInstructionsSection(mcpServers),
    getSkillsInstructionsSection(skills),
    getDeferredToolsSection(deferredToolNames),
  ].filter((s): s is string => s !== null)
}
