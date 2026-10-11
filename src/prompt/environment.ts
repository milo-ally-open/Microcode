import { execSync } from 'child_process'
import { homedir, release as osRelease, type as osType, version as osVersion } from 'os'
import { join } from 'path'

// Environment facts are generated at prompt-build time so model switches and
// resumed sessions see the current cwd, shell, OS, and model identity.
function getIsGit(cwd: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function getUnameSR(): string {
  if (process.platform === 'win32') {
    return `${osType()} ${osVersion()}`
  }
  try {
    return execSync('uname -sr', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return `${osType()} ${osRelease()}`
  }
}

function getShellInfoLine(): string {
  if (process.platform === 'win32') {
    const shell = process.env.PSModulePath ? 'PowerShell' : 'cmd.exe'
    return `Shell: ${shell}`
  }
  const shell = process.env.SHELL ?? '/bin/sh'
  return `Shell: ${shell}`
}

function getOperatingSystemName(): string {
  if (process.platform === 'win32') return 'Windows'
  if (process.platform === 'darwin') return 'macOS'
  if (process.platform === 'linux') return 'Linux'
  return osType()
}

/** Dynamic environment section shared by primary, resumed, and model-switched sessions. */
export function getEnvInfoSection(
  cwd: string,
  modelId: string,
): string {
  const isGit = getIsGit(cwd)
  const unameSR = getUnameSR()

  const modelDescription = `You are powered by the model ${modelId}. When asked what model you are, respond that you are ${modelId}. Do not claim to be any other model.`

  return `Here is useful information about the environment you are running in:
<env>
Working directory: ${cwd}
Microcode home: ${join(homedir(), '.microcode')}
Is directory a git repo: ${isGit ? 'Yes' : 'No'}
Operating system: ${getOperatingSystemName()}
Platform identifier: ${process.platform}
${getShellInfoLine()}
OS Version: ${unameSR}
</env>
${modelDescription}`
}
