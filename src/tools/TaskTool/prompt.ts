/** Model-facing usage guide for the task tool's flat action schema. */
export function getTaskToolSection(): string {
  return `# Task Tool

Use the \`task\` tool for multi-step work and keep its status synchronized with actual progress. Tool arguments are always a single top-level object.

Valid calls:
- Create: \`{"action":"write","title":"Implement feature","tasks":["Inspect existing code","Implement the change","Run tests"]}\`
- Load unfinished tasks: \`{"action":"claim","list_id":"list-abc"}\`
- Mark complete: \`{"action":"mark","list_id":"list-abc","task_id":"task-1","checked":true}\`
- Mark complete when the list ID is unavailable: \`{"action":"mark","task_id":"task-1","checked":true}\`
- Reopen: \`{"action":"mark","list_id":"list-abc","task_id":"task-1","checked":false}\`

Rules:
- Pass \`action\`, \`tasks\`, \`list_id\`, and \`task_id\` directly. Never wrap them under another key.
- For \`write\`, \`tasks\` may be strings or objects with a required \`content\` field.
- Do not invent task IDs after creating a list; use the IDs returned by the tool.
- Mark a task immediately after it is actually completed. Do not merely state that it is complete.
- If a \`<reminder>\` contains user-selected priority tasks, work on those first.`
}
