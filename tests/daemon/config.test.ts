import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { GATEWAY_DEFAULT_HOST, GATEWAY_DEFAULT_PORT, resolveGatewayHost, resolveGatewayPort, setConfiguredGatewayHost } from '../../src/daemon/config.ts'

const temporaryDirectories: string[] = []

async function configPath(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'microcode-gateway-config-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'config.json')
  await writeFile(path, contents, 'utf8')
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('gateway port configuration', () => {
  test('uses CLI, environment, user config, then the documented default precedence', async () => {
    const path = await configPath(JSON.stringify({ gateway: { port: 43129 } }))
    expect(resolveGatewayPort({ cliPort: '43130', envPort: '43128', userConfigPath: path })).toBe(43130)
    expect(resolveGatewayPort({ envPort: '43128', userConfigPath: path })).toBe(43128)
    expect(resolveGatewayPort({ envPort: '', userConfigPath: path })).toBe(43129)
    expect(resolveGatewayPort({ envPort: '', userConfigPath: join(dirname(path), 'missing.json') })).toBe(GATEWAY_DEFAULT_PORT)
  })

  test('rejects malformed selected sources without leaking config contents', async () => {
    const path = await configPath(JSON.stringify({ gateway: { port: 'private-value' } }))
    expect(() => resolveGatewayPort({ userConfigPath: path, envPort: '' })).toThrow('gateway.port in the Microcode user config must be a decimal integer')
    expect(() => resolveGatewayPort({ envPort: '70000', userConfigPath: path })).toThrow('MICROCODE_GATEWAY_PORT must be a decimal integer')
    expect(() => resolveGatewayPort({ cliPort: '', envPort: '43128', userConfigPath: path })).toThrow('--gateway-port must be a decimal integer')
  })

  test('does not parse lower-priority sources when CLI or environment wins', async () => {
    const path = await configPath('{ invalid json')
    expect(resolveGatewayPort({ cliPort: '43131', envPort: 'bad', userConfigPath: path })).toBe(43131)
    expect(resolveGatewayPort({ envPort: '43132', userConfigPath: path })).toBe(43132)
  })

  test('rejects malformed user configuration when it is the selected source', async () => {
    const path = await configPath('{ invalid json')
    expect(() => resolveGatewayPort({ envPort: '', userConfigPath: path })).toThrow('Could not parse the Microcode user config while resolving gateway.port.')
  })
})

describe('gateway bind host configuration', () => {
  test('uses CLI, environment, user config, then the loopback default precedence', async () => {
    const path = await configPath(JSON.stringify({ gateway: { host: '192.168.1.22' } }))
    expect(resolveGatewayHost({ cliHost: '0.0.0.0', envHost: '10.0.0.4', userConfigPath: path })).toBe('0.0.0.0')
    expect(resolveGatewayHost({ envHost: '10.0.0.4', userConfigPath: path })).toBe('10.0.0.4')
    expect(resolveGatewayHost({ envHost: '', userConfigPath: path })).toBe('192.168.1.22')
    expect(resolveGatewayHost({ envHost: '', userConfigPath: join(dirname(path), 'missing.json') })).toBe(GATEWAY_DEFAULT_HOST)
  })

  test('rejects malformed addresses and preserves other config when persisting a host', async () => {
    const path = await configPath(JSON.stringify({ gateway: { port: 43210 }, mcpServers: { example: {} } }))
    expect(() => resolveGatewayHost({ cliHost: 'http://0.0.0.0:43127' })).toThrow('--gateway-host must be an IP address or hostname')
    expect(() => resolveGatewayHost({ cliHost: '192.168.1.1:43127' })).toThrow('--gateway-host must be an IP address or hostname')

    await setConfiguredGatewayHost('0.0.0.0', path)
    const saved = JSON.parse(await readFile(path, 'utf8'))
    expect(saved).toEqual({ gateway: { port: 43210, host: '0.0.0.0' }, mcpServers: { example: {} } })
    expect(resolveGatewayHost({ envHost: '', userConfigPath: path })).toBe('0.0.0.0')
  })
})
