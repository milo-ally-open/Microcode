import { configuredGatewayHost, configuredGatewayPort, getOrCreateGatewayRpcToken, getOrCreateGatewayToken, removeGatewayMetadata, writeGatewayMetadata, type GatewayMetadata } from './config.ts'
import { createGatewayServer, GATEWAY_PROTOCOL_VERSION } from './server.ts'
import { createPiGatewayRuntime } from './runtime.ts'
import type { GatewayServerHandle } from './types.ts'

export async function writeGatewayMetadataOrStopServer(
  server: GatewayServerHandle,
  metadata: GatewayMetadata,
  writeMetadata: (metadata: GatewayMetadata) => Promise<void> = writeGatewayMetadata,
): Promise<void> {
  try {
    await writeMetadata(metadata)
  } catch (error) {
    try { await server.stop() } catch { /* Preserve the metadata error as the startup failure. */ }
    throw error
  }
}

export async function runGatewayDaemon(): Promise<void> {
  process.title = 'microcode-gateway'
  const token = await getOrCreateGatewayToken()
  const rpcToken = await getOrCreateGatewayRpcToken()
  const host = configuredGatewayHost()
  const server = createGatewayServer({ token, rpcToken, runtime: createPiGatewayRuntime(), hostname: host, port: configuredGatewayPort() })
  const pid = process.pid
  await writeGatewayMetadataOrStopServer(server, {
    pid,
    host: server.hostname,
    port: server.port,
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    startedAt: Date.now(),
  })

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await server.stop()
    await removeGatewayMetadata(pid)
  }
  process.once('SIGINT', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
  process.once('beforeExit', () => { void removeGatewayMetadata(pid) })
}
