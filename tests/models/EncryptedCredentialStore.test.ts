import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EncryptedCredentialStore } from '../../src/models/EncryptedCredentialStore.ts'

function fakeKeyring() {
  let key: Uint8Array | undefined
  return () => ({
    // Mirrors @napi-rs/keyring 2.1 on Windows, which returns number[] at runtime.
    async getSecret() { return key ? Array.from(key) : undefined },
    async setSecret(value: Uint8Array) { key = Uint8Array.from(value) },
  })
}

describe('EncryptedCredentialStore', () => {
  test('encrypts credentials at rest and supports CRUD', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'microcode-credentials-'))
    const file = join(dir, 'credentials.enc')
    const createEntry = fakeKeyring()
    const store = new EncryptedCredentialStore(file, createEntry)
    try {
      await store.modify('anthropic', async () => ({ type: 'api_key', key: 'private-api-key' }))
      expect(await store.read('anthropic')).toEqual({ type: 'api_key', key: 'private-api-key' })
      expect(await store.list()).toEqual([{ providerId: 'anthropic', type: 'api_key' }])
      expect(await readFile(file, 'utf8')).not.toContain('private-api-key')

      await store.delete('anthropic')
      expect(await store.read('anthropic')).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('serializes concurrent provider modifications across store instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'microcode-credentials-lock-'))
    const file = join(dir, 'credentials.enc')
    const createEntry = fakeKeyring()
    const left = new EncryptedCredentialStore(file, createEntry)
    const right = new EncryptedCredentialStore(file, createEntry)
    try {
      await Promise.all(Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? left : right).modify('openai-codex', async (current) => {
          const count = Number((current as any)?.count ?? 0)
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 8))
          return { type: 'oauth', refresh: `refresh-${count + 1}`, access: `access-${count + 1}`, expires: count + 1, count: count + 1 }
        }),
      ))
      const stored = await left.read('openai-codex') as any
      expect(stored.count).toBe(12)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('reports corrupt credential data without replacing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'microcode-credentials-corrupt-'))
    const file = join(dir, 'credentials.enc')
    const store = new EncryptedCredentialStore(file, fakeKeyring())
    try {
      await writeFile(file, '{broken', 'utf8')
      await expect(store.read('anthropic')).rejects.toThrow('corrupted')
      expect(await readFile(file, 'utf8')).toBe('{broken')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('refuses plaintext fallback when the OS credential vault is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'microcode-credentials-no-vault-'))
    const file = join(dir, 'credentials.enc')
    const store = new EncryptedCredentialStore(file, () => ({
      async getSecret() { throw new Error('secret service unavailable') },
      async setSecret() { throw new Error('secret service unavailable') },
    }))
    try {
      await expect(store.modify('anthropic', async () => ({ type: 'api_key', key: 'must-not-fallback' })))
        .rejects.toThrow('Enable Secret Service')
      await expect(readFile(file, 'utf8')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
