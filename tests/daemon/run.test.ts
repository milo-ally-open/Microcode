import { describe, expect, test } from 'bun:test'
import type { GatewayMetadata } from '../../src/daemon/config.ts'
import { writeGatewayMetadataOrStopServer } from '../../src/daemon/run.ts'
import type { GatewayServerHandle } from '../../src/daemon/types.ts'

const metadata: GatewayMetadata = {
  pid: 42,
  host: '127.0.0.1',
  port: 43127,
  protocolVersion: 1,
  startedAt: 1,
}

describe('gateway startup metadata', () => {
  test('closes the listener when daemon metadata cannot be persisted', async () => {
    let stopped = false
    const server: GatewayServerHandle = {
      hostname: '127.0.0.1',
      port: 43127,
      stop() { stopped = true },
    }

    await expect(writeGatewayMetadataOrStopServer(server, metadata, async () => {
      throw new Error('metadata write failed')
    })).rejects.toThrow('metadata write failed')
    expect(stopped).toBe(true)
  })

  test('preserves the metadata failure if listener shutdown also fails', async () => {
    const server: GatewayServerHandle = {
      hostname: '127.0.0.1',
      port: 43127,
      stop() { throw new Error('shutdown failed') },
    }

    await expect(writeGatewayMetadataOrStopServer(server, metadata, async () => {
      throw new Error('metadata write failed')
    })).rejects.toThrow('metadata write failed')
  })
})
