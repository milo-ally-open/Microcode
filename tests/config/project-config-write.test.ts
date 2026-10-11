import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { mergeProjectMcpServers, mergeProjectModels } from '../../src/mcp/configWrite.ts'

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'microcode-config-'))
}

describe('project config writes', () => {
  test('merges pasted MCP servers without dropping existing config keys', async () => {
    const cwd = await tempProject()
    try {
      const configPath = join(cwd, '.microcode', 'config.json')
      await mkdir(join(cwd, '.microcode'), { recursive: true })
      await writeFile(configPath, JSON.stringify({
        models: [{ id: 'keep', name: 'Keep', api: 'openai-completions', baseUrl: 'https://keep.test', contextWindow: 1000, maxTokens: 100 }],
        mcpServers: { old: { command: 'old' } },
      }))

      const result = await mergeProjectMcpServers(cwd, JSON.stringify({
        mcpServers: { next: { command: 'node', args: ['server.js'] } },
      }))
      const saved = JSON.parse(await readFile(configPath, 'utf-8'))

      expect(result.names).toEqual(['next'])
      expect(saved.mcpServers.old.command).toBe('old')
      expect(saved.mcpServers.next.command).toBe('node')
      expect(saved.models[0].id).toBe('keep')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('merges pasted custom models by id', async () => {
    const cwd = await tempProject()
    try {
      const result = await mergeProjectModels(cwd, JSON.stringify({
        models: [
          { id: 'local', name: 'Local', api: 'openai-completions', baseUrl: 'https://local.test/v1', contextWindow: 128000, maxTokens: 4096 },
        ],
      }))
      const saved = JSON.parse(await readFile(join(cwd, '.microcode', 'config.json'), 'utf-8'))

      expect(result.count).toBe(1)
      expect(saved.models[0].id).toBe('local')
      expect(saved.models[0].baseUrl).toBe('https://local.test/v1')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
