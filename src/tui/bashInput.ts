export interface BashInput {
  command: string
  excludeFromContext: boolean
}

export function parseBashInput(input: string): BashInput | null {
  if (!input.startsWith('!')) return null

  const excludeFromContext = input.startsWith('!!')
  const command = (excludeFromContext ? input.slice(2) : input.slice(1)).trim()
  return { command, excludeFromContext }
}
