import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import {
  configuredGatewayPort,
  configuredGatewayHost,
  createGatewayToken,
  ensureGatewayDirectory,
  getGatewayLockPath,
  getGatewayMetadataPath,
  getOrCreateGatewayRpcToken,
  getGatewayTokenPath,
  getOrCreateGatewayToken,
  readGatewayMetadata,
  readGatewayToken,
  resolveGatewayHost,
  resolveGatewayPort,
  removeGatewayMetadata,
} from './config.ts'
import { GATEWAY_PROTOCOL_VERSION } from './server.ts'

export interface GatewayConnection {
  host: string
  port: number
  token: string
  rpcToken: string
  baseUrl: string
}

export interface GatewayStatus {
  running: boolean
  host: string
  port: number
  version?: string
  protocolVersion?: number
}

function urlFor(host: string, port: number): string {
  const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${displayHost}:${port}`
}

/** Wildcard addresses are bind targets, not usable client destinations. */
function connectionHost(bindHost: string): string {
  if (bindHost === '0.0.0.0') return '127.0.0.1'
  if (bindHost === '::') return '::1'
  return bindHost
}

async function probe(host: string, port: number, token?: string): Promise<GatewayStatus> {
  const baseUrl = urlFor(connectionHost(host), port)
  try {
    const health = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(700) })
    if (!health.ok) return { running: false, host, port }
    const data = await health.json() as { version?: unknown; protocol_version?: unknown }
    if (token) {
      const authorized = await fetch(`${baseUrl}/v1/models`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1000),
      })
      if (authorized.status === 401) throw new Error('A gateway is already listening at the configured address, but its token does not match this installation.')
      if (!authorized.ok) return { running: false, host, port }
    }
    return {
      running: true,
      host,
      port,
      version: typeof data.version === 'string' ? data.version : undefined,
      protocolVersion: typeof data.protocol_version === 'number' ? data.protocol_version : undefined,
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('token does not match')) throw error
    return { running: false, host, port }
  }
}

function hasTcpListener(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    let settled = false
    const finish = (connected: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(connected)
    }
    socket.setTimeout(500, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export async function getGatewayStatus(portOverride?: string, hostOverride?: string): Promise<GatewayStatus> {
  const metadata = await readGatewayMetadata()
  const token = await readGatewayToken()
  const port = portOverride === undefined ? metadata?.port ?? configuredGatewayPort() : configuredGatewayPort(portOverride)
  const host = hostOverride !== undefined
    ? configuredGatewayHost(hostOverride)
    : portOverride === undefined && metadata
      ? metadata.host
      : configuredGatewayHost()
  return probe(host, port, token)
}

async function acquireStartupLock(): Promise<() => Promise<void>> {
  await ensureGatewayDirectory()
  const target = getGatewayLockPath()
  const handle = await open(target, 'a', 0o600)
  await handle.close()
  return lockfile.lock(target, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 40, minTimeout: 25, maxTimeout: 50, factor: 1 },
  })
}

function spawnGateway(port: number, host: string): void {
  const entry = process.argv[1]
  const args = entry && /\.(?:[cm]?js|tsx?)$/i.test(entry) ? [entry] : []
  const child = spawn(process.execPath, args, {
    cwd: homedir(),
    env: {
      ...process.env,
      MICROCODE_GATEWAY_CHILD: '1',
      MICROCODE_GATEWAY_PORT: String(port),
      MICROCODE_GATEWAY_HOST: host,
    },
    detached: true,
    stdio: 'ignore',
  })
  child.on('error', () => undefined)
  child.unref()
}

async function waitForGateway(token: string, port: number, host: string, timeoutMs = 12_000): Promise<GatewayStatus> {
  const deadline = Date.now() + timeoutMs
  let lastStatus: GatewayStatus = { running: false, host, port }
  while (Date.now() < deadline) {
    lastStatus = await probe(host, port, token)
    if (lastStatus.running) {
      if (lastStatus.protocolVersion !== GATEWAY_PROTOCOL_VERSION) {
        throw new Error(`Model Gateway protocol mismatch (expected ${GATEWAY_PROTOCOL_VERSION}, received ${lastStatus.protocolVersion ?? 'unknown'}). Stop and restart the daemon.`)
      }
      return lastStatus
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Model Gateway did not become ready at ${host}:${port}. Use 'microcode gateway status' for diagnostics.`)
}

export async function ensureGatewayDaemon(portOverride?: string, hostOverride?: string): Promise<GatewayConnection> {
  const port = configuredGatewayPort(portOverride)
  const host = configuredGatewayHost(hostOverride)
  let token = await getOrCreateGatewayToken()
  let rpcToken = await getOrCreateGatewayRpcToken()
  const metadata = await readGatewayMetadata()
  if (metadata && (metadata.port !== port || metadata.host !== host)) {
    const oldStatus = await probe(metadata.host, metadata.port, token)
    if (oldStatus.running) {
      throw new Error(`A Model Gateway is already running at ${metadata.host}:${metadata.port}, but this invocation requested ${host}:${port}. Stop it with 'microcode gateway stop' or use the existing address.`)
    }
    await removeGatewayMetadata(metadata.pid)
  }
  let status = await probe(host, port, token)
  if (status.running && status.protocolVersion !== GATEWAY_PROTOCOL_VERSION) {
    throw new Error(`Model Gateway protocol mismatch (expected ${GATEWAY_PROTOCOL_VERSION}, received ${status.protocolVersion ?? 'unknown'}). Stop and restart the daemon.`)
  }
  if (!status.running) {
    let release: (() => Promise<void>) | undefined
    try {
      release = await acquireStartupLock()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error
      status = await waitForGateway(token, port, host)
    }
    if (release) {
      try {
        // A token rotation can finish after this caller's optimistic probe but
        // before it acquires the startup lock. Refresh credentials while holding
        // the lock so a newly spawned daemon and its readiness probe agree.
        token = await getOrCreateGatewayToken()
        rpcToken = await getOrCreateGatewayRpcToken()
        status = await probe(host, port, token)
        if (!status.running) {
          if (await hasTcpListener(connectionHost(host), port)) {
            throw new Error(`Port ${port} is already in use by a service that is not this Microcode Gateway.`)
          }
          await removeGatewayMetadata()
          spawnGateway(port, host)
          status = await waitForGateway(token, port, host)
        }
      } finally {
        await release()
      }
    }
  }
  return { host: status.host, port: status.port, token, rpcToken, baseUrl: urlFor(connectionHost(status.host), status.port) }
}

/** Rotate the public client token only while every known gateway endpoint is stopped. */
export async function rotateGatewayToken(portOverride?: string, hostOverride?: string): Promise<string> {
  let release: (() => Promise<void>)
  try {
    release = await acquireStartupLock()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new Error('Gateway startup or maintenance is already in progress. Retry token rotation after it finishes.')
    }
    throw error
  }

  try {
    const [metadata, token] = await Promise.all([readGatewayMetadata(), readGatewayToken()])
    const endpoints = new Map<string, { host: string; port: number }>()
    if (metadata) endpoints.set(`${metadata.host}:${metadata.port}`, { host: metadata.host, port: metadata.port })
    const candidatePorts = new Set<number>([
      configuredGatewayPort(portOverride),
      configuredGatewayPort(),
      resolveGatewayPort({ envPort: '' }),
    ])
    const configuredHost = hostOverride === undefined ? resolveGatewayHost() : configuredGatewayHost(hostOverride)
    for (const port of candidatePorts) endpoints.set(`${configuredHost}:${port}`, { host: configuredHost, port })
    for (const port of candidatePorts) endpoints.set(`127.0.0.1:${port}`, { host: '127.0.0.1', port })

    for (const endpoint of endpoints.values()) {
      const status = await probe(endpoint.host, endpoint.port, token)
      if (status.running) {
        throw new Error("The Model Gateway is running. Run 'microcode gateway stop' before rotating its client token.")
      }
    }
    return await createGatewayToken()
  } finally {
    await release()
  }
}

export async function stopGatewayDaemon(): Promise<boolean> {
  const metadata = await readGatewayMetadata()
  const token = await readGatewayToken()
  if (!metadata || !token) return false
  const baseUrl = urlFor(connectionHost(metadata.host), metadata.port)
  const status = await probe(metadata.host, metadata.port, token)
  if (!status.running) {
    await removeGatewayMetadata(metadata.pid)
    return false
  }
  const response = await fetch(`${baseUrl}/gateway/stop`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(2000),
  })
  if (!response.ok) throw new Error(`Gateway stop request failed (${response.status}).`)
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const current = await probe(metadata.host, metadata.port)
    if (!current.running) {
      await removeGatewayMetadata(metadata.pid)
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('The gateway accepted the stop request but is still responding.')
}

export async function showGatewayToken(): Promise<string> {
  const token = await getOrCreateGatewayToken()
  return token
}

export function getGatewayTokenFile(): string {
  return getGatewayTokenPath()
}

export function getGatewayMetadataFile(): string {
  return getGatewayMetadataPath()
}
