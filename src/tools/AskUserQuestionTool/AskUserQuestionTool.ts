import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type, type Static } from 'typebox'
import type { PermissionBehavior } from '../../permissions/types.ts'

// 'ask' forces execution through PermissionManager.checkPermissionWithPrompt(),
// where onAskUserQuestion() interactively collects answers before execute() runs.
// Changing to 'allow' would skip the permission flow entirely — execute() would
// receive no answers and the tool would be useless.
export const TOOL_DEFAULT_PERMISSION: PermissionBehavior = 'ask' // ★ Elegant: this tool's permission check IS its functionality.

export const ASK_USER_QUESTION_TOOL_NAME = 'Ask'

// ============================================================================
// Schema
// ============================================================================

const questionOptionSchema = Type.Object({
  label: Type.String({
    description: 'The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.',
  }),
  description: Type.String({
    description: 'Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.',
  }),
})

const questionSchema = Type.Object({
  question: Type.String({
    description: 'The complete question to ask the user. Should be clear, specific, and end with a question mark.',
  }),
  header: Type.String({
    description: 'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".',
  }),
  options: Type.Array(questionOptionSchema, {
    description: 'The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled).',
    minItems: 2,
    maxItems: 4,
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      description: 'Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.',
      default: false,
    }),
  ),
})

const askUserQuestionSchema = Type.Object({
  questions: Type.Array(questionSchema, {
    description: 'Questions to ask the user (1-4 questions)',
    minItems: 1,
    maxItems: 4,
  }),
  answers: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: 'User answers collected by the permission component (question text -> answer string; multi-select answers are comma-separated)',
    }),
  ),
})

export type AskUserQuestionInput = Static<typeof askUserQuestionSchema>
export type Question = Static<typeof questionSchema>
export type QuestionOption = Static<typeof questionOptionSchema>

// ============================================================================
// Tool
// ============================================================================

export interface AskUserQuestionDetails {
  questions: Question[]
  answers: Record<string, string>
}

/**
 * Extended tool interface that supports pre-collected answers
 * from the permission flow.
 */
export interface AskUserQuestionTool extends AgentTool<typeof askUserQuestionSchema, AskUserQuestionDetails> {
  /** Store answers collected during the permission flow. */
  setAnswers(answers: Record<string, string>): void
  /** Retrieve and clear stored answers (consumed on execute). */
  getAndClearAnswers(): Record<string, string> | undefined
}

export function createAskUserQuestionTool(_cwd: string): AskUserQuestionTool {
  // Shared state: answers collected during the permission flow
  let pendingAnswers: Record<string, string> | undefined

  const tool: AskUserQuestionTool = {
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: 'Ask User Question',
    description:
      'Asks the user multiple choice questions to gather information, clarify ambiguity, understand preferences, make decisions or offer them choices.',
    parameters: askUserQuestionSchema,

    setAnswers(answers: Record<string, string>): void {
      pendingAnswers = answers
    },

    getAndClearAnswers(): Record<string, string> | undefined {
      const answers = pendingAnswers
      pendingAnswers = undefined
      return answers
    },

    async execute(
      _toolCallId: string,
      params: AskUserQuestionInput,
      _signal?: AbortSignal,
      _onUpdate?: (partial: AgentToolResult<AskUserQuestionDetails>) => void,
    ): Promise<AgentToolResult<AskUserQuestionDetails>> {
      const { questions } = params

      // Answers may come from:
      // 1. Pre-collected via permission flow (setAnswers)
      // 2. Passed directly in params (fallback)
      const answers = tool.getAndClearAnswers() ?? params.answers ?? {}

      return {
        content: [
          {
            type: 'text',
            text: formatAnswersForModel(questions, answers),
          },
        ],
        details: {
          questions,
          answers,
        },
      }
    },
  }

  return tool
}

// ============================================================================
// Helpers
// ============================================================================

function formatAnswersForModel(
  questions: Question[],
  answers: Record<string, string>,
): string {
  const parts = questions.map((q) => {
    const answer = answers[q.question]
    if (answer) {
      return `"${q.question}" = "${answer}"`
    }
    return `"${q.question}" = (no answer)`
  })
  return `User has answered your questions: ${parts.join(', ')}. You can now continue with the user's answers in mind.`
}
