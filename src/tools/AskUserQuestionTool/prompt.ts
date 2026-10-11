/** Model-facing usage guide for the Ask tool. Keep it beside the tool contract. */
export function getAskUserQuestionSection(): string {
  return `# Ask User Question Tool

Use the \`Ask\` tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label
- Keep questions concise and specific (max 12 chars for header, 2-4 options per question)`
}
