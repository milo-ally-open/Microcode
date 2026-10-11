import type { ProjectInstructions } from '../instructions/projectInstructions.ts'

export function getProjectInstructionsSection(
  instructions: ProjectInstructions | undefined,
): string | null {
  if (!instructions || instructions.files.length === 0) return null

  const files = instructions.files.map(({ path, content }) => `## ${path}\n\n${content}`).join('\n\n')
  return [
    '# Project instructions',
    'The following project files contain user-provided guidance. Follow them within Microcode system instructions, tool permissions, and safety constraints.',
    files,
  ].join('\n\n')
}
