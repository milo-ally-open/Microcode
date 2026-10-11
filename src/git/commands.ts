export type GitCommand =
  | { action: 'menu' }
  | { action: 'status' | 'diff' | 'branches' | 'log' | 'fetch' | 'pull' | 'push' | 'stash-list' }
  | { action: 'diff-staged' }
  | { action: 'branch-create' | 'branch-switch' | 'branch-delete'; name: string }
  | { action: 'stage' | 'unstage' | 'discard'; paths: string[] }
  | { action: 'commit'; message: string }
  | { action: 'stash-push'; message?: string }
  | { action: 'stash-apply' | 'stash-pop'; ref?: string }
  | { action: 'unknown'; usage: string }

export const GIT_COMMAND_USAGE =
  'Usage: /git [status|diff [--staged]|branches|branch create|switch|delete <name>|add|stage|unstage|discard|commit <message>|log|fetch|pull|push|stash [message]|stash list|stash apply|pop [ref]]'

/** Splits a command tail while supporting quoted paths and preserving Windows path separators. */
export function splitGitCommandArgs(input: string): string[] {
  const args: string[] = []
  let token = ''
  let quote: '"' | "'" | undefined
  let tokenStarted = false

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!
    if (quote) {
      if (char === quote) {
        quote = undefined
      } else if (char === '\\' && quote === '"' && ['"', '\\'].includes(input[i + 1] ?? '')) {
        token += input[++i]!
      } else {
        token += char
      }
      tokenStarted = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      tokenStarted = true
      continue
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(token)
        token = ''
        tokenStarted = false
      }
      continue
    }
    token += char
    tokenStarted = true
  }
  if (quote) throw new Error('Unclosed quote in /git arguments.')
  if (tokenStarted) args.push(token)
  return args
}

export function parseGitCommand(input: string): GitCommand {
  let args: string[]
  try {
    args = splitGitCommandArgs(input.trim())
  } catch {
    return { action: 'unknown', usage: GIT_COMMAND_USAGE }
  }
  const [first, second, ...rest] = args
  if (!first) return { action: 'menu' }
  if (first === 'status' && args.length === 1) return { action: 'status' }
  if (first === 'diff') {
    if (args.length === 1) return { action: 'diff' }
    if (args.length === 2 && second === '--staged') return { action: 'diff-staged' }
  }
  if (first === 'branches' && args.length === 1) return { action: 'branches' }
  if (first === 'branch' && ['create', 'switch', 'delete'].includes(second ?? '') && rest.length === 1) {
    return {
      action: second === 'create' ? 'branch-create' : second === 'switch' ? 'branch-switch' : 'branch-delete',
      name: rest[0]!,
    }
  }
  if (first === 'add' || first === 'stage' || first === 'unstage' || first === 'discard') {
    return { action: first === 'add' ? 'stage' : first, paths: args.slice(1) }
  }
  if (first === 'commit') return { action: 'commit', message: args.slice(1).join(' ') }
  if (first === 'log' && args.length === 1) return { action: 'log' }
  if (['fetch', 'pull', 'push'].includes(first) && args.length === 1) {
    return { action: first as 'fetch' | 'pull' | 'push' }
  }
  if (first === 'stash') {
    if (args.length === 1) return { action: 'stash-push' }
    if (second === 'list' && args.length === 2) return { action: 'stash-list' }
    if ((second === 'apply' || second === 'pop') && args.length <= 3) {
      return { action: second === 'apply' ? 'stash-apply' : 'stash-pop', ref: rest[0] }
    }
    if (second !== 'apply' && second !== 'pop' && second !== 'list') {
      return { action: 'stash-push', message: args.slice(1).join(' ') }
    }
  }
  return { action: 'unknown', usage: GIT_COMMAND_USAGE }
}

export function isGitMutation(command: GitCommand): boolean {
  return ![
    'menu', 'status', 'diff', 'diff-staged', 'branches', 'log', 'stash-list', 'unknown',
  ].includes(command.action)
}

export function canRunGitCommand(command: GitCommand, agentBusy: boolean): boolean {
  return !agentBusy || !isGitMutation(command)
}

export function requiresGitConfirmation(command: GitCommand): boolean {
  if (['fetch', 'pull', 'push', 'branch-delete'].includes(command.action)) return true
  if (command.action === 'discard') return command.paths.length > 0
  if (command.action === 'stash-pop') return Boolean(command.ref)
  return false
}
