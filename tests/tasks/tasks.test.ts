import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { TaskSystem } from '../../src/tasks/TaskSystem.ts'

describe('tasks module', () => {
  test('creates, lists, claims, reminds, and marks task lists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'microcode-tasks-'))
    try {
      const system = new TaskSystem(root)
      const list = await system.createList('session-1', 'Plan', ['Read', 'Write'])
      expect(list.stats).toMatchObject({ total: 2, completed: 0 })

      await system.remindTask('session-1', list.id, 'task-1')
      expect(await system.getReminder('session-1')).toContain('User-selected priority tasks')

      await system.markTask('session-1', list.id, 'task-1', true)
      const claimed = await system.claimTaskList('session-1', list.id)
      expect(claimed.tasks.map((task) => task.id)).toEqual(['task-2'])
      expect((await system.listTaskLists('session-1'))[0].stats?.completed).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects invalid sessions and empty task data without corrupting state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'microcode-tasks-'))
    try {
      const system = new TaskSystem(root)
      await expect(system.createList('../bad', 'Plan', ['Read'])).rejects.toThrow('Invalid session ID')
      await expect(system.createList('session-2', '', ['Read'])).rejects.toThrow('title cannot be empty')
      expect(await system.listTaskLists('session-2')).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
