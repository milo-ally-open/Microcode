import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureLoopbackProxyBypass } from '../../src/daemon/proxy.ts'

configureLoopbackProxyBypass()
// These tests start several Bun CLI processes; Windows startup can exceed Bun's 5s default.
setDefaultTimeout(60_000)

const entry = join(process.cwd(), 'src/entry.ts')
const testHomePromise = mkdtemp(join(tmpdir(), 'microcode-gateway-lifecycle-'))
const portPromise = new Promise<number>((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return reject(new Error('Could not allocate a test gateway port.'))
    const { port } = address
    server.close((error) => error ? reject(error) : resolve(port))
  })
})

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 45_000)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`Timed out running microcode ${args.join(' ')}.`))
      else resolve({ code, stdout, stderr })
    })
  })
}

describe('Model Gateway daemon lifecycle', () => {
  const cleanup = async () => {
    const home = await testHomePromise
    try {
      const env = { ...process.env, HOME: home, USERPROFILE: home }
      const metadataPath = join(home, '.microcode', 'daemon', 'daemon.json')
      try {
        const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { port: number }
        env.MICROCODE_GATEWAY_PORT = String(metadata.port)
        await runCli(['gateway', 'stop'], env)
      } catch {
        // The daemon may not have started if an earlier assertion failed.
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }

  afterAll(cleanup)

  test('concurrent gateway starts converge on one daemon, handshake, report status, and stop', async () => {
    const [home, port] = await Promise.all([testHomePromise, portPromise])
    const env = { ...process.env, HOME: home, USERPROFILE: home, MICROCODE_GATEWAY_PORT: String(port + 1) }
    delete env.MICROCODE_GATEWAY_CHILD
    await mkdir(join(home, '.microcode'), { recursive: true })
    await writeFile(join(home, '.microcode', 'config.json'), JSON.stringify({ gateway: { port: port + 2 } }), 'utf8')

    const [first, second] = await Promise.all([
      runCli(['gateway', 'start', '--gateway-port', String(port)], env),
      runCli(['gateway', 'start', `--gateway-port=${port}`], env),
    ])
    expect(first.code).toBe(0)
    expect(second.code).toBe(0)
    expect(first.stdout).toContain('Model Gateway handshake successful')
    expect(second.stdout).toContain('Model Gateway handshake successful')
    expect(first.stdout).toContain(`127.0.0.1:${port}`)
    expect(second.stdout).toContain(`127.0.0.1:${port}`)

    const metadataPath = join(home, '.microcode', 'daemon', 'daemon.json')
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { pid: number; port: number; protocolVersion: number }
    expect(metadata).toMatchObject({ port, protocolVersion: 1 })

    const status = await runCli(['gateway', 'status'], env)
    expect(status.code).toBe(0)
    expect(status.stdout).toContain('Model Gateway running')

    const tokenBeforeRotation = await runCli(['gateway', 'token'], env)
    expect(tokenBeforeRotation.code).toBe(0)
    expect(tokenBeforeRotation.stdout.trim()).toMatch(/^[a-f0-9]{64}$/)
    const rotationWhileRunning = await runCli(['gateway', 'token', '--rotate', '--gateway-port', String(port)], env)
    expect(rotationWhileRunning.code).toBe(1)
    expect(rotationWhileRunning.stderr).toContain("Run 'microcode gateway stop' before rotating")
    const tokenAfterRejectedRotation = await runCli(['gateway', 'token'], env)
    expect(tokenAfterRejectedRotation.stdout.trim()).toBe(tokenBeforeRotation.stdout.trim())

    const stopped = await runCli(['gateway', 'stop'], env)
    expect(stopped.code).toBe(0)
    expect(stopped.stdout).toContain('Model Gateway stopped.')

    const rotation = await runCli(['gateway', 'token', '--rotate', '--gateway-port', String(port)], env)
    expect(rotation.code).toBe(0)
    const rotatedToken = rotation.stdout.match(/Gateway token rotated[^\n]*\n([a-f0-9]{64})/)?.[1]
    expect(rotatedToken).toMatch(/^[a-f0-9]{64}$/)
    expect(rotatedToken).not.toBe(tokenBeforeRotation.stdout.trim())
    if (process.platform !== 'win32') {
      const tokenFile = await stat(join(home, '.microcode', 'daemon', 'token'))
      expect(tokenFile.mode & 0o777).toBe(0o600)
    }

    const restarted = await runCli(['gateway', 'start', '--gateway-port', String(port)], env)
    expect(restarted.code).toBe(0)
    expect(restarted.stdout).toContain('Model Gateway handshake successful')
    const stoppedAfterRotation = await runCli(['gateway', 'stop'], env)
    expect(stoppedAfterRotation.code).toBe(0)
  })

  test('starts, reports, and stops a daemon configured for all IPv4 interfaces', async () => {
    const home = await mkdtemp(join(tmpdir(), 'microcode-gateway-host-'))
    const portServer = createServer()
    await new Promise<void>((resolve, reject) => {
      portServer.once('error', reject)
      portServer.listen(0, '127.0.0.1', () => resolve())
    })
    const address = portServer.address()
    if (!address || typeof address === 'string') throw new Error('Could not allocate a gateway host test port.')
    const port = address.port
    await new Promise<void>((resolve) => portServer.close(() => resolve()))
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      MICROCODE_GATEWAY_PORT: String(port),
    }
    delete env.MICROCODE_GATEWAY_CHILD

    try {
      const started = await runCli(['gateway', 'start', '--gateway-host', '0.0.0.0'], env)
      expect(started.code).toBe(0)
      expect(started.stdout).toContain(`http://0.0.0.0:${port}`)

      const metadataPath = join(home, '.microcode', 'daemon', 'daemon.json')
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { host: string; port: number }
      expect(metadata).toMatchObject({ host: '0.0.0.0', port })
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200)

      const status = await runCli(['gateway', 'status'], env)
      expect(status.stdout).toContain(`http://0.0.0.0:${port}`)
      const stopped = await runCli(['gateway', 'stop'], env)
      expect(stopped.code).toBe(0)
      expect(stopped.stdout).toContain('Model Gateway stopped.')
    } finally {
      await runCli(['gateway', 'stop'], env).catch(() => undefined)
      await rm(home, { recursive: true, force: true })
    }
  })

  test('reports an occupied loopback port without waiting for the daemon startup timeout', async () => {
    const home = await mkdtemp(join(tmpdir(), 'microcode-gateway-port-conflict-'))
    const server = createServer((socket) => {
      socket.on('data', () => socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Could not allocate an occupied test port.')
    const env = { ...process.env, HOME: home, USERPROFILE: home, MICROCODE_GATEWAY_PORT: String(address.port) }
    delete env.MICROCODE_GATEWAY_CHILD

    try {
      const startedAt = Date.now()
      const result = await runCli(['gateway', 'start'], env)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(`Port ${address.port} is already in use`)
      expect(Date.now() - startedAt).toBeLessThan(5000)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(home, { recursive: true, force: true })
    }
  })
})
