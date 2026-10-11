import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const GATEWAY_DEFAULT_HOST = '127.0.0.1'
export const GATEWAY_DEFAULT_PORT = 43127

export interface GatewayMetadata {
  pid: number
  host: string
  port: number
  protocolVersion: number
  startedAt: number
}

export function getGatewayDirectory(): string {
  return join(homedir(), '.microcode', 'daemon')
}

export function getGatewayTokenPath(): string {
  return join(getGatewayDirectory(), 'token')
}

export function getGatewayRpcTokenPath(): string {
  return join(getGatewayDirectory(), 'rpc-token')
}

export function getGatewayMetadataPath(): string {
  return join(getGatewayDirectory(), 'daemon.json')
}

export function getGatewayLockPath(): string {
  return join(getGatewayDirectory(), 'startup.lock-target')
}

export interface GatewayPortSources {
  cliPort?: string
  envPort?: string
  userConfigPath?: string
  defaultPort?: number
}

export interface GatewayHostSources {
  cliHost?: string
  envHost?: string
  userConfigPath?: string
  defaultHost?: string
}

function parseGatewayHost(value: unknown, source: string): string {
  if (typeof value !== 'string') throw new Error(`${source} must be an IP address or hostname.`)
  const host = value.trim()
  const hostname = host.toLowerCase()
  const validHostname = hostname.length <= 253 && hostname.split('.').every((label) =>
    label.length > 0 && label.length <= 63 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))
  if (!host || /[\s/\\?#@]/.test(host) || (isIP(host) === 0 && !validHostname)) {
    throw new Error(`${source} must be an IP address or hostname (without a scheme or port).`)
  }
  return host
}

/** Resolve the listener address in CLI > environment > user config > loopback order. */
export function resolveGatewayHost(sources: GatewayHostSources = {}): string {
  if (sources.cliHost !== undefined) return parseGatewayHost(sources.cliHost, '--gateway-host')

  const envHost = sources.envHost ?? process.env.MICROCODE_GATEWAY_HOST
  if (envHost !== undefined && envHost !== '') return parseGatewayHost(envHost, 'MICROCODE_GATEWAY_HOST')

  const configPath = sources.userConfigPath ?? join(homedir(), '.microcode', 'config.json')
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return sources.defaultHost ?? GATEWAY_DEFAULT_HOST
    throw new Error('Could not read the Microcode user config while resolving gateway.host.')
  }

  let config: unknown
  try {
    config = JSON.parse(raw)
  } catch {
    throw new Error('Could not parse the Microcode user config while resolving gateway.host.')
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('The Microcode user config must contain a JSON object.')
  }
  const gateway = (config as Record<string, unknown>).gateway
  if (gateway === undefined) return sources.defaultHost ?? GATEWAY_DEFAULT_HOST
  if (gateway === null || typeof gateway !== 'object' || Array.isArray(gateway)) {
    throw new Error('gateway in the Microcode user config must be an object.')
  }
  const host = (gateway as Record<string, unknown>).host
  if (host === undefined) return sources.defaultHost ?? GATEWAY_DEFAULT_HOST
  return parseGatewayHost(host, 'gateway.host in the Microcode user config')
}

export function configuredGatewayHost(cliHost?: string): string {
  return resolveGatewayHost({ cliHost })
}

/** Persist the TUI-selected bind host without discarding other Microcode settings. */
export async function setConfiguredGatewayHost(value: string, configPath = join(homedir(), '.microcode', 'config.json')): Promise<string> {
  const host = parseGatewayHost(value, 'Gateway bind address')
  const directory = dirname(configPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })

  let config: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('The Microcode user config must contain a JSON object.')
    }
    config = parsed as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const existingGateway = config.gateway
  if (existingGateway !== undefined && (existingGateway === null || typeof existingGateway !== 'object' || Array.isArray(existingGateway))) {
    throw new Error('gateway in the Microcode user config must be an object.')
  }
  config.gateway = { ...(existingGateway as Record<string, unknown> | undefined), host }

  const temporaryPath = `${configPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporaryPath, configPath)
    if (process.platform !== 'win32') await chmod(configPath, 0o600)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
  return host
}

function parseGatewayPort(value: unknown, source: string): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) {
    throw new Error(`${source} must be a decimal integer from 1 to 65535.`)
  }
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${source} must be a decimal integer from 1 to 65535.`)
  }
  return port
}

/** Resolve the listener port in CLI > environment > user config > default order. */
export function resolveGatewayPort(sources: GatewayPortSources = {}): number {
  if (sources.cliPort !== undefined) return parseGatewayPort(sources.cliPort, '--gateway-port')

  const envPort = sources.envPort ?? process.env.MICROCODE_GATEWAY_PORT
  if (envPort !== undefined && envPort !== '') return parseGatewayPort(envPort, 'MICROCODE_GATEWAY_PORT')

  const configPath = sources.userConfigPath ?? join(homedir(), '.microcode', 'config.json')
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return sources.defaultPort ?? GATEWAY_DEFAULT_PORT
    throw new Error('Could not read the Microcode user config while resolving gateway.port.')
  }

  let config: unknown
  try {
    config = JSON.parse(raw)
  } catch {
    throw new Error('Could not parse the Microcode user config while resolving gateway.port.')
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('The Microcode user config must contain a JSON object.')
  }
  const gateway = (config as Record<string, unknown>).gateway
  if (gateway === undefined) return sources.defaultPort ?? GATEWAY_DEFAULT_PORT
  if (gateway === null || typeof gateway !== 'object' || Array.isArray(gateway)) {
    throw new Error('gateway in the Microcode user config must be an object.')
  }
  const port = (gateway as Record<string, unknown>).port
  if (port === undefined) return sources.defaultPort ?? GATEWAY_DEFAULT_PORT
  return parseGatewayPort(port, 'gateway.port in the Microcode user config')
}

export function configuredGatewayPort(cliPort?: string): number {
  return resolveGatewayPort({ cliPort })
}

export async function ensureGatewayDirectory(): Promise<void> {
  await mkdir(getGatewayDirectory(), { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(getGatewayDirectory(), 0o700)
}

async function ensureOwnerOnlyFile(path: string): Promise<void> {
  if (process.platform !== 'win32') await chmod(path, 0o600)
}

export async function readGatewayToken(): Promise<string | undefined> {
  try {
    const token = (await readFile(getGatewayTokenPath(), 'utf8')).trim()
    return token || undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function createGatewayToken(): Promise<string> {
  await ensureGatewayDirectory()
  const token = randomBytes(32).toString('hex')
  const path = getGatewayTokenPath()
  const tempPath = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const handle = await open(tempPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${token}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tempPath, path)
    await ensureOwnerOnlyFile(path)
  } finally {
    await unlink(tempPath).catch(() => undefined)
  }
  return token
}

export async function getOrCreateGatewayToken(): Promise<string> {
  await ensureGatewayDirectory()
  const token = await readGatewayToken()
  if (token) {
    await ensureOwnerOnlyFile(getGatewayTokenPath())
    return token
  }
  // Exclusive creation makes concurrent first runs converge on one token.
  await ensureGatewayDirectory()
  const candidate = randomBytes(32).toString('hex')
  try {
    const handle = await open(getGatewayTokenPath(), 'wx', 0o600)
    try { await handle.writeFile(`${candidate}\n`, 'utf8'); await handle.sync() } finally { await handle.close() }
    await ensureOwnerOnlyFile(getGatewayTokenPath())
    return candidate
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const raced = await readGatewayToken()
    if (raced) return raced
    throw error
  }
}

export async function getOrCreateGatewayRpcToken(): Promise<string> {
  await ensureGatewayDirectory()
  const path = getGatewayRpcTokenPath()
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (existing) {
      await ensureOwnerOnlyFile(path)
      return existing
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const candidate = randomBytes(32).toString('hex')
  try {
    const handle = await open(path, 'wx', 0o600)
    try { await handle.writeFile(`${candidate}\n`, 'utf8'); await handle.sync() } finally { await handle.close() }
    await ensureOwnerOnlyFile(path)
    return candidate
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const raced = (await readFile(path, 'utf8')).trim()
    if (raced) return raced
    throw error
  }
}

export async function readGatewayMetadata(): Promise<GatewayMetadata | undefined> {
  try {
    const parsed = JSON.parse(await readFile(getGatewayMetadataPath(), 'utf8')) as Partial<GatewayMetadata>
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number' || typeof parsed.host !== 'string' || typeof parsed.protocolVersion !== 'number' || typeof parsed.startedAt !== 'number') return undefined
    return parsed as GatewayMetadata
  } catch {
    return undefined
  }
}

export async function writeGatewayMetadata(metadata: GatewayMetadata): Promise<void> {
  await ensureGatewayDirectory()
  const path = getGatewayMetadataPath()
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600 })
  await rename(temp, path)
  await ensureOwnerOnlyFile(path)
}

export async function removeGatewayMetadata(pid?: number): Promise<void> {
  if (pid !== undefined) {
    const current = await readGatewayMetadata()
    if (current && current.pid !== pid) return
  }
  await unlink(getGatewayMetadataPath()).catch(() => undefined)
}
