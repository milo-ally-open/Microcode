import { beforeAll, describe, expect, test } from 'bun:test'
import { ensureBootstrapMacro } from '../../src/macro.ts'
import { getActionsSection, getIntroSection, getSystemSection } from '../../src/prompt/base.ts'
import { getEnvInfoSection } from '../../src/prompt/environment.ts'
import { prependBullets } from '../../src/prompt/format.ts'
import { getSystemPrompt } from '../../src/prompt/prompts.ts'
import { getAskUserQuestionSection } from '../../src/tools/AskUserQuestionTool/prompt.ts'
import { getTaskToolSection } from '../../src/tools/TaskTool/prompt.ts'
import { getDeferredToolsSection, getUsingYourToolsSection } from '../../src/tools/prompt.ts'

beforeAll(() => {
  ensureBootstrapMacro()
})

describe('prompt modules', () => {
  test('formats nested prompt bullets consistently', () => {
    expect(prependBullets(['a', ['b', 'c']])).toEqual([' - a', '  - b', '  - c'])
  })

  test('base prompt sections expose stable headings and product identity', () => {
    expect(getIntroSection()).toContain('You are Microcode')
    expect(getSystemSection()).toContain('# System')
    expect(getActionsSection()).toContain('# Executing actions with care')
  })

  test('tool prompt sections stay beside tool contracts', () => {
    expect(getUsingYourToolsSection()).toContain('# Using your tools')
    expect(getAskUserQuestionSection()).toContain('# Ask User Question Tool')
    expect(getTaskToolSection()).toContain('# Task Tool')
    expect(getDeferredToolsSection(['DeferredTool'])).toContain('DeferredTool')
    expect(getDeferredToolsSection([])).toBeNull()
  })

  test('environment prompt includes cwd and model identity', () => {
    const section = getEnvInfoSection('/tmp/project', 'test-model')
    expect(section).toContain('Working directory: /tmp/project')
    expect(section).toContain('test-model')
  })

  test('system prompt assembler preserves section order and filters empty dynamic sections', () => {
    const prompt = getSystemPrompt({ cwd: process.cwd(), modelId: 'test-model' })
    expect(prompt[0]).toContain('You are Microcode')
    expect(prompt.some((section) => section.includes('# MCP Tools'))).toBe(false)
    expect(prompt.at(-1)).toContain('test-model')
  })

  test('system prompt includes loaded project instruction files', () => {
    const prompt = getSystemPrompt({
      cwd: '/tmp/project',
      modelId: 'test-model',
      projectInstructions: {
        projectRoot: '/tmp/project',
        workingDirectory: '/tmp/project',
        files: [{ path: '/tmp/project/AGENTS.md', content: 'Use Bun.', bytes: 9, truncated: false }],
        diagnostics: [],
        totalBytes: 9,
      },
    })

    const sectionIndex = prompt.findIndex((section) => section === '# Project instructions'
      || section.startsWith('# Project instructions\n'))
    expect(sectionIndex).toBeGreaterThan(-1)
    expect(prompt[sectionIndex]).toContain('/tmp/project/AGENTS.md')
    expect(prompt[sectionIndex]).toContain('Use Bun.')
  })

})
