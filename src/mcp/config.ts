import { join } from 'path'
import { homedir } from 'os'
import type { McpServerConfig } from './types.ts'

export function getUserConfigPath(): string {
  return join(homedir(), '.microcode', 'config.json')
}

export function getProjectConfigPath(cwd: string): string {
  return join(cwd, '.microcode', 'config.json')
}

export async function loadMcpConfig(
  cwd: string,
): Promise<Record<string, McpServerConfig>> {
  const { discoverMcpCapabilities } = await import('./capabilities.ts')
  return (await discoverMcpCapabilities(cwd)).configs
}

export function isMcpConfigEmpty(configs: Record<string, McpServerConfig>): boolean {
  return Object.keys(configs).length === 0
}
