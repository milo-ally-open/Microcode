/*
 * AskUserQuestionTool Registration
 * Provides structured user questioning and answer collection functionality.
 * Uses permission-integrated architecture where the PermissionManager handles
 * user interaction and injects answers into tool arguments.
 *
 */
// @ts-nocheck

import { registerTool } from '../registry.ts'
import { createAskUserQuestionTool, TOOL_DEFAULT_PERMISSION, ASK_USER_QUESTION_TOOL_NAME } from './AskUserQuestionTool.ts'
import { AskUserQuestionToolUI } from './UI.tsx'
import { count, joinSummaryParts, statusPrefix } from '../summary.ts'

registerTool({
  name: ASK_USER_QUESTION_TOOL_NAME,
  policy: { defaultPermission: TOOL_DEFAULT_PERMISSION },
  agent: {
    create: createAskUserQuestionTool,
    description:
      'Asks the user multiple choice questions to gather information, clarify ambiguity, understand preferences, make decisions or offer them choices.',
    summarizeResult: (context) => {
      const details = context.details ?? {}
      const questions = Array.isArray(details.questions) ? details.questions : []
      const answers = details.answers && typeof details.answers === 'object'
        ? Object.keys(details.answers as Record<string, unknown>).length
        : undefined
      return `[ask_user_question] ${statusPrefix(context)}${joinSummaryParts([
        count(questions.length, 'questions'),
        count(answers, 'answers'),
      ])}`
    },
    formatDescription: (input) => {
      if (Array.isArray(input.questions)) {
        const count = input.questions.length
        const first = input.questions[0]
        if (first && typeof first.question === 'string') {
          const preview =
            first.question.length > 60
              ? first.question.slice(0, 60) + '...'
              : first.question
          return `ask ${count} question${count > 1 ? 's' : ''}: "${preview}"`
        }
        return `ask ${count} question${count > 1 ? 's' : ''}`
      }
      return '(ask user question)'
    },
    extractMatchContent: (input) => {
      if (Array.isArray(input.questions)) {
        return input.questions
          .map((q: any) => (typeof q.question === 'string' ? q.question : ''))
          .filter(Boolean)
          .join(' ')
      }
      return undefined
    },
  },
  presentation: { View: AskUserQuestionToolUI },
})
