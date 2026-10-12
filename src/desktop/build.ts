import { mkdir, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dir, '../..')
const sourceDirectory = join(projectRoot, 'src', 'desktop')
const outputDirectory = join(projectRoot, 'dist', 'microcode-desktop')
const rendererOutput = join(outputDirectory, 'renderer.js')

await mkdir(outputDirectory, { recursive: true })

const builds = await Promise.all([
  Bun.build({
    entrypoints: [join(sourceDirectory, 'main.ts')],
    outdir: outputDirectory,
    naming: { entry: 'main.mjs' },
    target: 'node',
    format: 'esm',
    external: ['electron'],
    sourcemap: 'inline',
  }),
  Bun.build({
    entrypoints: [join(sourceDirectory, 'preload.ts')],
    outdir: outputDirectory,
    naming: { entry: 'preload.cjs' },
    target: 'node',
    format: 'cjs',
    external: ['electron'],
    sourcemap: 'inline',
  }),
  Bun.build({
    entrypoints: [join(sourceDirectory, 'renderer', 'main.tsx')],
    outdir: outputDirectory,
    naming: { entry: 'renderer.js' },
    target: 'browser',
    format: 'esm',
    jsx: { factory: 'h', fragment: 'Fragment', runtime: 'classic' },
    sourcemap: 'inline',
  }),
])

for (const result of builds) {
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error('Microcode Desktop build failed.')
  }
}

await Promise.all([
  copyFile(join(sourceDirectory, 'renderer', 'index.html'), join(outputDirectory, 'index.html')),
  copyFile(join(sourceDirectory, 'renderer', 'style.css'), join(outputDirectory, 'style.css')),
  copyFile(join(projectRoot, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), join(outputDirectory, 'xterm.css')),
])

console.log(`Desktop renderer: ${rendererOutput}`)

if (process.argv.slice(2).includes('--run')) {
  const electron = Bun.spawn(['electron', join(outputDirectory, 'main.mjs')], {
    cwd: projectRoot,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  process.exitCode = await electron.exited
}
