export const SESSION_TITLE_MAX_CHARS = 60

/** Use only the user's opening sentence as the title-generation seed. */
export function firstSentence(input: string): string {
  const singleLine = input.replace(/\s+/g, ' ').trim()
  const sentence = singleLine.match(/^.*?[。！？]|^.*?[.!?](?=\s|$)/)
  return sentence?.[0] ?? singleLine
}

/** Keep titles on one line and bounded so they cannot distort the TUI layout. */
export function normalizeSessionTitle(title: string): string {
  const firstLine = title.split(/\r?\n/, 1)[0]?.replace(/\s+/g, ' ').trim() ?? ''
  const characters = Array.from(firstLine)
  return characters.length > SESSION_TITLE_MAX_CHARS
    ? `${characters.slice(0, SESSION_TITLE_MAX_CHARS - 3).join('')}...`
    : firstLine
}

export async function createSessionTitle(
  userInput: string,
  generate: (openingSentence: string) => Promise<string>,
): Promise<string> {
  const openingSentence = firstSentence(userInput)
  const fallback = normalizeSessionTitle(openingSentence)
  if (!openingSentence) return ''

  try {
    return normalizeSessionTitle(await generate(openingSentence)) || fallback
  } catch {
    return fallback
  }
}
