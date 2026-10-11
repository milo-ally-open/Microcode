import { prependBullets } from '../prompt/format.ts'

/** Prompt rules for using Microcode's tool system as a whole. */
export function getUsingYourToolsSection(): string {
  const items = [
    `Do NOT use the bash tool to run commands when a relevant dedicated tool is provided. Using dedicated tools allows the user to better understand and review your work. This is CRITICAL to assisting the user:`,
    [`To read files use the read tool instead of cat, head, tail, or sed`, `To edit files use the edit tool instead of sed or awk`, `To create files use the write tool instead of cat with heredoc or echo redirection`, `Reserve using the bash tool exclusively for system commands and terminal operations that require shell execution. If you are unsure and there is a relevant dedicated tool, default to using the dedicated tool and only fallback on using the bash tool for these if it is absolutely necessary.`],
    `You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel. Maximize use of parallel tool calls where possible to increase efficiency. However, if some tool calls depend on previous calls to inform dependent values, do NOT call these tools in parallel and instead call them sequentially. For instance, if one operation must complete before another starts, run these operations sequentially instead.`,
  ]

  return [`# Using your tools`, ...prependBullets(items)].join(`\n`)
}

/** Lightweight index of deferred tools; full schemas are loaded via the search tool. */
export function getDeferredToolsSection(deferredToolNames: string[] | undefined): string | null {
  if (!deferredToolNames || deferredToolNames.length === 0) return null

  const toolList = deferredToolNames.map(name => `- ${name}`).join('\n')

  return `<available-deferred-tools>
The following tools are available but not loaded. Use the \`search\` tool to fetch the full schema for a specific tool before calling it:
${toolList}
</available-deferred-tools>`
}
