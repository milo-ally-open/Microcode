import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { addMcpServer, getScopeDescription, listMcpServers, parseEnvVars, parseHeaders, removeMcpServer } from '../../src/mcp/configWrite.ts'
import { isMcpConfigEmpty, loadMcpConfig } from '../../src/mcp/config.ts'
import { getMcpInstructionsSection } from '../../src/mcp/prompt.ts'
import type { McpServerState } from '../../src/mcp/types.ts'

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'microcode-mcp-'))
}

describe('mcp modules', () => {
  test('adds, lists, loads, and removes project-scoped MCP servers', async () => {
    const cwd = await tempProject()
    try {
      const configPath = await addMcpServer('browser', { command: 'node', args: ['server.js'] }, 'project', cwd)
      expect(configPath).toBe(join(cwd, '.microcode', 'config.json'))
      expect(JSON.parse(await readFile(configPath, 'utf-8')).mcpServers.browser.command).toBe('node')

      expect(await listMcpServers('project', cwd)).toMatchObject([
        { scope: 'project', name: 'browser' },
      ])
      expect((await loadMcpConfig(cwd)).browser.command).toBe('node')
      expect(isMcpConfigEmpty(await loadMcpConfig(cwd))).toBe(false)

      await removeMcpServer('browser', 'project', cwd)
      expect(await listMcpServers('project', cwd)).toEqual([])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('project MCP config overrides same-named user-like entries when loading', async () => {
    const cwd = await tempProject()
    try {
      await writeFile(join(cwd, '.microcode-placeholder'), 'unused')
      await addMcpServer('shared', { command: 'project-cmd' }, 'project', cwd)
      expect((await loadMcpConfig(cwd)).shared.command).toBe('project-cmd')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('parses env vars and headers with validation', () => {
    expect(parseEnvVars(['A=1', 'B=two=three'])).toEqual({ A: '1', B: 'two=three' })
    expect(parseHeaders(['Authorization: Bearer token'])).toEqual({ Authorization: 'Bearer token' })
    expect(() => parseEnvVars(['missing-equals'])).toThrow('Expected KEY=value')
    expect(() => parseEnvVars(['=value'])).toThrow('Empty key')
    expect(() => parseHeaders(['missing-colon'])).toThrow('Expected "Header-Name: value"')
    expect(() => parseHeaders([': value'])).toThrow('Empty key')
    expect(getScopeDescription('project')).toBe('project .microcode/config.json')
  })

  test('rejects invalid, duplicate, and missing MCP server mutations', async () => {
    const cwd = await tempProject()
    try {
      await expect(addMcpServer('', { command: 'node' }, 'project', cwd)).rejects.toThrow('required')
      await expect(addMcpServer('bad name', { command: 'node' }, 'project', cwd)).rejects.toThrow('Invalid server name')

      await addMcpServer('dup', { command: 'node' }, 'project', cwd)
      await expect(addMcpServer('dup', { command: 'bun' }, 'project', cwd)).rejects.toThrow('already exists')
      await expect(removeMcpServer('missing', 'project', cwd)).rejects.toThrow('not found')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('MCP prompt lists lightweight tool names while deferring schemas', () => {
    const state: McpServerState = {
      name: 'chrome-devtools',
      config: { command: 'chrome' },
      status: 'connected',
      tools: [{
        name: 'evaluate_script',
        serverName: 'chrome-devtools',
        description: 'Run JavaScript',
        inputSchema: { type: 'object', required: ['filePath'] },
      }],
      resources: [{ uri: 'file://a', name: 'a', serverName: 'chrome-devtools' }],
    }

    const prompt = getMcpInstructionsSection([state])!
    expect(prompt).toContain('mcp__chrome-devtools__evaluate_script')
    expect(prompt).toContain('select:<exact_tool_name>')
    expect(prompt).toContain('file://a')
    expect(prompt).not.toContain('"required"')
  })
})
