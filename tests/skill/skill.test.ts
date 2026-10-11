import { describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'fs/promises'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { formatSkillsForPrompt, loadSkills, readSkillBody } from '../../src/skill.ts'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'microcode-skill-'))
}

describe('skill module', () => {
  test('loads markdown skills, strips frontmatter body, and formats visible skills', async () => {
    const cwd = tempRoot()
    try {
      const skillDir = join(cwd, 'skills', 'alpha')
      await mkdir(skillDir, { recursive: true })
      const file = join(skillDir, 'SKILL.md')
      await writeFile(file, `---\nname: alpha\ndescription: Alpha <special> skill\n---\nSkill body\n`)

      const result = loadSkills({ cwd, skillPaths: [join(cwd, 'skills')], includeDefaults: false })
      expect(result.diagnostics).toEqual([])
      expect(result.skills[0]).toMatchObject({ name: 'alpha', description: 'Alpha <special> skill' })
      expect(readSkillBody(result.skills[0])).toBe('Skill body\n')
      expect(formatSkillsForPrompt(result.skills)).toContain('&lt;special&gt;')
      expect(formatSkillsForPrompt(result.skills)).toContain('$skill-name')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('reports invalid skills and hides disabled skills from model prompt', async () => {
    const cwd = tempRoot()
    try {
      await mkdir(join(cwd, 'bad'), { recursive: true })
      await writeFile(join(cwd, 'bad', 'SKILL.md'), `---\nname: Bad_Name\ndescription: \n---\n`)
      await mkdir(join(cwd, 'hidden'), { recursive: true })
      await writeFile(join(cwd, 'hidden', 'SKILL.md'), `---\nname: hidden\ndescription: Hidden skill\ndisable-model-invocation: true\n---\n`)

      const result = loadSkills({ cwd, skillPaths: [join(cwd, 'bad'), join(cwd, 'hidden')], includeDefaults: false })
      expect(result.diagnostics.join('\n')).toContain('description is required')
      expect(result.diagnostics.join('\n')).toContain('invalid characters')
      expect(formatSkillsForPrompt(result.skills)).toBe('')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
