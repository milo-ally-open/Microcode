import type { AgentMessage } from '@earendil-works/pi-agent-core'

export function replaceImageBlocksForPersistence(msg: AgentMessage): AgentMessage {
  if (msg.role !== 'user' && msg.role !== 'toolResult') return msg

  const content = msg.content
  if (typeof content === 'string') return msg

  let changed = false
  const newContent = content.map(block => {
    if (block.type === 'image') {
      changed = true
      return {
        type: 'text' as const,
        text: `[Image: ${(block as any).mimeType ?? 'unknown'}]`,
      }
    }
    return block
  })

  if (!changed) return msg
  return { ...msg, content: newContent }
}
