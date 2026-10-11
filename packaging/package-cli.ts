#!/usr/bin/env bun
import { join } from 'path'
import {
  archiveDirectory,
  assertExists,
  copyFileExecutable,
  formatDone,
  outRoot,
  platformTag,
  projectRoot,
  readPackageMeta,
  resetDir,
  stagingRoot,
  writeExecutable,
} from './lib.ts'

function runCommand(binaryName: string): string {
  return process.platform === 'win32'
    ? `.\\bin\\${binaryName} --help`
    : `./bin/${binaryName} --help`
}

async function main(): Promise<void> {
  const meta = await readPackageMeta()
  const tag = platformTag()
  const binaryName = process.platform === 'win32' ? 'microcode.exe' : 'microcode'
  const packageName = `microcode-cli-v${meta.version}-${tag}`
  let packageDir = join(stagingRoot, packageName)

  await Bun.$`bun run build.ts --no-install`.cwd(projectRoot)
  packageDir = await resetDir(packageDir)

  await copyFileExecutable(
    join(projectRoot, 'dist', binaryName),
    join(packageDir, 'bin', binaryName),
  )

  await writeExecutable(join(packageDir, 'install.sh'), [
    '#!/usr/bin/env sh',
    'set -eu',
    'install_dir="${HOME}/.local/bin"',
    'mkdir -p "$install_dir"',
    'cp "$(dirname "$0")/bin/microcode" "$install_dir/microcode"',
    'chmod +x "$install_dir/microcode"',
    'echo "Installed microcode to $install_dir/microcode"',
    '',
  ].join('\n'))

  if (process.platform === 'win32') {
    await Bun.write(join(packageDir, 'install.cmd'), [
      '@echo off',
      'setlocal',
      'set "install_dir=%LOCALAPPDATA%\\microcode\\bin"',
      'mkdir "%install_dir%" 2>nul',
      'copy /Y "%~dp0bin\\microcode.exe" "%install_dir%\\microcode.exe" >nul',
      'echo Installed microcode to %install_dir%\\microcode.exe',
      'echo Add %install_dir% to PATH if it is not already present.',
      '',
    ].join('\r\n'))
  }

  await Bun.write(join(packageDir, 'README.md'), [
    '# Microcode CLI',
    '',
    'Portable TUI command-line build.',
    '',
    'Run directly:',
    '',
    '```',
    runCommand(binaryName),
    '```',
    '',
    process.platform === 'win32'
      ? 'Install to `%LOCALAPPDATA%\\microcode\\bin`:'
      : 'Install to `~/.local/bin`:',
    '',
    '```',
    process.platform === 'win32' ? '.\\install.cmd' : './install.sh',
    '```',
    '',
    'Configuration and sessions are stored under `~/.microcode/`.',
    '',
  ].join('\n'))

  await assertExists(join(packageDir, 'bin', binaryName))
  const archive = await archiveDirectory(packageDir, join(outRoot, packageName))
  formatDone('CLI package', packageDir)
  formatDone('CLI archive', archive)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
