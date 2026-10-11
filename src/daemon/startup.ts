import type { GatewayConnection } from './lifecycle.ts'
import { GatewayClient } from './client.ts'

export type TuiModelTransport =
  | { mode: 'gateway'; client: GatewayClient; protocolVersion: number; modelCount: number }
  | { mode: 'direct'; reason: string }

export async function initializeTuiModelTransport(
  connect: () => Promise<GatewayConnection>,
  fetchFn: typeof fetch = fetch,
  projectCwd = process.cwd(),
  modelId?: string,
): Promise<TuiModelTransport> {
  try {
    const client = new GatewayClient(await connect(), fetchFn, projectCwd)
    const handshake = await client.handshake()
    const catalog = await client.loadProjectModelCatalog()
    // Treat an unusable project/default model as a gateway startup failure too;
    // otherwise the TUI can crash after reporting a successful handshake.
    client.getProjectDefaultModelConfig(modelId)
    return { mode: 'gateway', client, ...handshake, modelCount: catalog.models.length }
  } catch (error) {
    return { mode: 'direct', reason: error instanceof Error ? error.message : String(error) }
  }
}
