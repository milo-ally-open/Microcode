import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginManager, validatePluginDirectory } from '../../src/plugins/PluginManager.ts'

async function createPlugin(root: string): Promise<void> {
  await mkdir(join(root, 'skills', 'reviewer'), { recursive: true })
  await writeFile(join(root, 'plugin.json'), JSON.stringify({
    name: 'sample-plugin',
    version: '1.2.0',
    description: 'A test plugin',
    author: { name: 'Test Author' },
  }))
  await writeFile(join(root, 'skills', 'reviewer', 'SKILL.md'), [
    '---',
    'name: reviewer',
    'description: Review code carefully',
    '---',
    'Use a focused review checklist.',
  ].join('\n'))
  await writeFile(join(root, 'mcp.json'), JSON.stringify({
    mcpServers: {
      helper: {
        type: 'stdio',
        command: 'node',
        args: ['server.js', '--api-key', 'command-secret-token'],
        env: { API_TOKEN: 'never-display-this-secret' },
      },
    },
  }))
}

describe('plugin packages', () => {
  test('validates namespaced skills and reports MCP metadata without secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'microcode-plugin-validate-'))
    try {
      const pluginRoot = join(dir, 'sample-plugin')
      await createPlugin(pluginRoot)
      const result = await validatePluginDirectory(pluginRoot, 'user', 'sample-plugin')
      expect(result.valid).toBe(true)
      expect(result.author).toBe('Test Author')
      expect(result.skills.map((skill) => skill.name)).toEqual(['sample-plugin:reviewer'])
      expect(result.servers.map((server) => server.qualifiedName)).toEqual(['sample-plugin--helper'])
      expect(result.servers[0]?.safeCommandSummary).toContain('server.js')
      expect(result.servers[0]?.safeCommandSummary).not.toContain('never-display-this-secret')
      expect(result.servers[0]?.safeCommandSummary).not.toContain('command-secret-token')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('defaults packages to disabled and connects package MCP when enabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'microcode-plugin-settings-'))
    try {
      const cwd = join(dir, 'project')
      const userRoot = join(dir, 'user-plugins')
      const projectRoot = join(cwd, '.microcode', 'plugins', 'sample-plugin')
      const userConfig = join(dir, 'user-config.json')
      const projectConfig = join(cwd, '.microcode', 'config.json')
      await mkdir(projectRoot, { recursive: true })
      await mkdir(userRoot, { recursive: true })
      await createPlugin(projectRoot)
      await mkdir(join(cwd, '.microcode'), { recursive: true })
      await writeFile(projectConfig, JSON.stringify({ mcpServers: { existing: { command: 'existing' } } }))

      const manager = await PluginManager.create(cwd, '0.1.0', {
        userPluginsDir: userRoot,
        userConfigPath: userConfig,
        projectConfigPath: projectConfig,
      })
      expect(manager.findPlugin('sample-plugin')?.enabled).toBe(false)
      expect(manager.getSnapshot().skills).toHaveLength(0)
      expect(manager.getSnapshot().mcpServers).toEqual({})

      await manager.setEnabled('sample-plugin', true)
      expect(manager.getSnapshot().skills.map((skill) => skill.name)).toEqual(['sample-plugin:reviewer'])
      expect(Object.keys(manager.getSnapshot().mcpServers)).toEqual(['sample-plugin--helper'])
      const persisted = JSON.parse(await readFile(projectConfig, 'utf8'))
      expect(persisted.mcpServers.existing.command).toBe('existing')
      expect(persisted.plugins['sample-plugin']).toEqual({ enabled: true })
      expect(await Bun.file(userConfig).exists()).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects manifest directory mismatches and symlinked skill trees', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'microcode-plugin-invalid-'))
    try {
      const pluginRoot = join(dir, 'wrong-directory')
      await createPlugin(pluginRoot)
      const mismatch = await validatePluginDirectory(pluginRoot, 'user', 'wrong-directory')
      expect(mismatch.valid).toBe(false)
      expect(mismatch.diagnostics.join('\n')).toContain('must match directory')

      const linkedRoot = join(dir, 'sample-plugin')
      await createPlugin(linkedRoot)
      await rm(join(linkedRoot, 'skills'), { recursive: true, force: true })
      const outsideSkills = join(dir, 'outside')
      await mkdir(outsideSkills)
      await symlink(outsideSkills, join(linkedRoot, 'skills'), process.platform === 'win32' ? 'junction' : 'dir')
      const linked = await validatePluginDirectory(linkedRoot, 'user', 'sample-plugin')
      expect(linked.diagnostics.join('\n')).toContain('skills must be a directory, not a symlink')
      expect(linked.skills).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('does not overwrite a malformed existing config while changing plugin settings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'microcode-plugin-bad-config-'))
    try {
      const cwd = join(dir, 'project')
      const userRoot = join(dir, 'user-plugins')
      const pluginRoot = join(userRoot, 'sample-plugin')
      const userConfig = join(dir, 'user-config.json')
      const projectConfig = join(cwd, '.microcode', 'config.json')
      await mkdir(pluginRoot, { recursive: true })
      await createPlugin(pluginRoot)
      await writeFile(userConfig, '{\n  "mcpServers": {\n')
      const original = await readFile(userConfig, 'utf8')

      const manager = await PluginManager.create(cwd, '0.1.0', {
        userPluginsDir: userRoot,
        userConfigPath: userConfig,
        projectConfigPath: projectConfig,
      })
      expect(manager.getSnapshot().diagnostics.join('\n')).toContain('will be refused until it is valid JSON')
      await expect(manager.setEnabled('sample-plugin', true)).rejects.toThrow('existing config is invalid and was left unchanged')
      expect(await readFile(userConfig, 'utf8')).toBe(original)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
