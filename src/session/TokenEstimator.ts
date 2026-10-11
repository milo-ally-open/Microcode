import type { AgentMessage } from '@earendil-works/pi-agent-core'

const IMAGE_TOKEN_ESTIMATE = 2000

/**
 * Estimate token count for messages using a character-based heuristic.
 * Matches pi-agent-core's estimateTokens logic: chars / 4.
 */
export function estimateTokens(message: AgentMessage): number {
  let chars = 0

  switch (message.role) {
    case 'user': {
      const content = message.content
      if (typeof content === 'string') {
        chars = content.length
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            chars += block.text.length
          }
          if (block.type === 'image') {
            chars += IMAGE_TOKEN_ESTIMATE * 4
          }
        }
      }
      return Math.ceil(chars / 4)
    }
    case 'assistant': {
      for (const block of message.content) {
        if (block.type === 'text') {
          chars += block.text.length
        } else if (block.type === 'thinking') {
          chars += block.thinking.length
        } else if (block.type === 'toolCall') {
          chars += block.name.length + JSON.stringify(block.arguments).length
        }
      }
      return Math.ceil(chars / 4)
    }
    case 'toolResult': {
      for (const block of message.content) {
        if (block.type === 'text' && block.text) {
          chars += block.text.length
        }
        if (block.type === 'image') {
          chars += IMAGE_TOKEN_ESTIMATE * 4
        }
      }
      return Math.ceil(chars / 4)
    }
    case 'bashExecution': {
      chars = message.command.length + message.output.length
      return Math.ceil(chars / 4)
    }
    case 'compactionSummary':
    case 'branchSummary': {
      chars = message.summary.length
      return Math.ceil(chars / 4)
    }
    case 'custom': {
      if (typeof message.content === 'string') {
        chars = message.content.length
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            chars += block.text.length
          }
        }
      }
      return Math.ceil(chars / 4)
    }
  }
  return 0
}

/**
 * Estimate total tokens for a message array.
 */
export function estimateMessagesTokens(messages: AgentMessage[]): number {
  let total = 0
  for (const message of messages) {
    total += estimateTokens(message)
  }
  return total
}
