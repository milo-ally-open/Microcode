import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { installBinaryAtomically } from './build-install.ts'

/** Compile away from the existing executable and publish only a complete build. */
export async function compileBinaryAtomically<T>(
  destination: string,
  compile: (outputPath: string) => Promise<T>,
  publish: (source: string, destination: string) => Promise<void> = installBinaryAtomically,
): Promise<T> {
  await mkdir(dirname(destination), { recursive: true })
  const stagingDirectory = await mkdtemp(join(dirname(destination), '.microcode-build-'))
  try {
    const outputPath = join(stagingDirectory, basename(destination))
    const result = await compile(outputPath)
    await publish(outputPath, destination)
    return result
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
