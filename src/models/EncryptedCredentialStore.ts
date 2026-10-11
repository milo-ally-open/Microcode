import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { access, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { AsyncEntry } from '@napi-rs/keyring'
import lockfile from 'proper-lockfile'
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'

const KEYRING_SERVICE = 'microcode'
const KEYRING_ACCOUNT = 'credential-store-v1'
const ENVELOPE_VERSION = 1
type VaultSecret = Uint8Array | readonly number[]
type KeyringEntry = {
  getSecret(): Promise<VaultSecret | undefined>
  setSecret(secret: Uint8Array): Promise<void>
}
type KeyringEntryFactory = (service: string, account: string) => KeyringEntry

interface EncryptedEnvelope {
  version: 1
  iv: string
  tag: string
  data: string
}

type Credentials = Record<string, Credential>

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * User-scoped pi-ai credential storage. OAuth tokens and API keys are AES-256-GCM
 * encrypted at rest; the random encryption key lives only in the OS credential
 * store. A proper-lockfile lock serializes read/modify/write across processes.
 */
export class EncryptedCredentialStore implements CredentialStore {
  private readonly lockTarget: string
  private readonly keyLockTarget: string
  private keyringEntry?: KeyringEntry

  constructor(
    private readonly filePath = join(homedir(), '.microcode', 'credentials.enc'),
    private readonly createEntry: KeyringEntryFactory = (service, account) => new AsyncEntry(service, account, {
      linux: { store: 'secret-service' },
    }),
  ) {
    this.lockTarget = `${filePath}.lock-target`
    this.keyLockTarget = `${filePath}.key-lock-target`
  }

  async read(providerId: string, options?: { signal?: AbortSignal }): Promise<Credential | undefined> {
    throwIfAborted(options?.signal)
    if (!(await exists(this.filePath))) return undefined
    const credentials = await this.readAll()
    throwIfAborted(options?.signal)
    return credentials[providerId]
  }

  async list(options?: { signal?: AbortSignal }): Promise<readonly CredentialInfo[]> {
    throwIfAborted(options?.signal)
    if (!(await exists(this.filePath))) return []
    const credentials = await this.readAll()
    throwIfAborted(options?.signal)
    return Object.entries(credentials).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }))
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: { signal?: AbortSignal },
  ): Promise<Credential | undefined> {
    throwIfAborted(options?.signal)
    return this.withFileLock(async () => {
      throwIfAborted(options?.signal)
      const credentials = await this.readAll()
      const next = await fn(credentials[providerId])
      throwIfAborted(options?.signal)
      if (next === undefined) return credentials[providerId]
      credentials[providerId] = next
      await this.writeAll(credentials)
      return credentials[providerId]
    }, options?.signal)
  }

  async delete(providerId: string, options?: { signal?: AbortSignal }): Promise<void> {
    throwIfAborted(options?.signal)
    await this.withFileLock(async () => {
      throwIfAborted(options?.signal)
      const credentials = await this.readAll()
      if (credentials[providerId] === undefined) return
      delete credentials[providerId]
      await this.writeAll(credentials)
    }, options?.signal)
  }

  private async withFileLock<T>(callback: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal)
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    await this.ensureLockTargets()
    const release = await lockfile.lock(this.lockTarget, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 50, minTimeout: 100, maxTimeout: 500 },
    })
    try {
      throwIfAborted(signal)
      return await callback()
    } finally {
      await release()
    }
  }

  private async ensureLockTargets(): Promise<void> {
    for (const target of [this.lockTarget, this.keyLockTarget]) {
      try {
        const handle = await open(target, 'wx', 0o600)
        await handle.close()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
  }

  private async readAll(): Promise<Credentials> {
    if (!(await exists(this.filePath))) return {}
    const raw = await readFile(this.filePath, 'utf8')
    let envelope: EncryptedEnvelope
    try {
      envelope = JSON.parse(raw) as EncryptedEnvelope
      if (envelope.version !== ENVELOPE_VERSION || !envelope.iv || !envelope.tag || !envelope.data) {
        throw new Error('Invalid credential envelope')
      }
    } catch {
      throw new Error('Credential store is corrupted or has an unsupported format. It was left unchanged.')
    }

    try {
      const key = await this.getOrCreateKey(false)
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64')),
        decipher.final(),
      ]).toString('utf8')
      const parsed = JSON.parse(plaintext) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid credential data')
      return parsed as Credentials
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Credential store')) throw error
      throw new Error(`Unable to decrypt credential store. Check that the system credential vault is available. ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async writeAll(credentials: Credentials): Promise<void> {
    const key = await this.getOrCreateKey(true)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const plaintext = Buffer.from(JSON.stringify(credentials), 'utf8')
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const envelope: EncryptedEnvelope = {
      version: ENVELOPE_VERSION,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    }
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temporary, this.filePath)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }

  private async getOrCreateKey(create: boolean): Promise<Buffer> {
    const entry = this.getKeyringEntry()
    const existing = await this.readVaultSecret(entry)
    if (existing) {
      return this.validateEncryptionKey(existing)
    }
    if (!create) throw new Error('Credential encryption key is missing from the system credential vault.')

    const release = await lockfile.lock(this.keyLockTarget, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 50, minTimeout: 100, maxTimeout: 500 },
    })
    try {
      const raced = await this.readVaultSecret(entry)
      if (raced) {
        return this.validateEncryptionKey(raced)
      }
      const key = randomBytes(32)
      try {
        await entry.setSecret(key)
      } catch (error) {
        throw this.vaultError(error)
      }
      return key
    } finally {
      await release()
    }
  }

  private validateEncryptionKey(secret: VaultSecret): Buffer {
    // @napi-rs/keyring 2.1 returns a plain number[] at runtime on Windows,
    // despite its TypeScript declaration promising Uint8Array.
    const key = Buffer.from(secret)
    if (key.length !== 32) throw new Error('Credential encryption key in system vault has an invalid size.')
    return key
  }

  private async readVaultSecret(entry: KeyringEntry): Promise<VaultSecret | undefined> {
    try {
      return await entry.getSecret()
    } catch (error) {
      throw this.vaultError(error)
    }
  }

  private vaultError(error: unknown): Error {
    return new Error(`System credential vault is unavailable. Enable Secret Service on Linux or unlock the OS credential store. ${error instanceof Error ? error.message : String(error)}`)
  }

  private getKeyringEntry(): KeyringEntry {
    if (this.keyringEntry) return this.keyringEntry
    try {
      this.keyringEntry = this.createEntry(KEYRING_SERVICE, KEYRING_ACCOUNT)
      return this.keyringEntry
    } catch (error) {
      throw new Error(`System credential vault is unavailable. Enable Secret Service to save provider credentials. ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
