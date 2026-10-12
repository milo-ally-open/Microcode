import { spawn } from 'node:child_process'
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai'

const RESPONSE_PREFIX = '@@MICROCODE_AUTH@@'
const MAX_NATIVE_RESPONSE = 32 * 1024
const NATIVE_PROMPT_TIMEOUT_MS = 30 * 60 * 1000

interface NativeDialogResult {
  readonly accepted: boolean
  readonly value?: string
}

export type ProviderAuthPrompt = (prompt: AuthPrompt, signal: AbortSignal) => Promise<string>

function windowsDialogScript(): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$line = [Console]::In.ReadLine()
$request = ConvertFrom-Json -InputObject $line
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Microcode sign-in'
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MinimizeBox = $false
$form.MaximizeBox = $false
$form.ShowInTaskbar = $true
$form.TopMost = $true
$form.ClientSize = New-Object System.Drawing.Size(480, 170)
$label = New-Object System.Windows.Forms.Label
$label.Location = New-Object System.Drawing.Point(18, 16)
$label.Size = New-Object System.Drawing.Size(444, 52)
$label.Text = [string]$request.message
$form.Controls.Add($label)
$control = $null
if ($request.type -eq 'select') {
  $control = New-Object System.Windows.Forms.ComboBox
  $control.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
  foreach ($option in $request.options) { [void]$control.Items.Add([string]$option.label) }
  if ($control.Items.Count -gt 0) { $control.SelectedIndex = 0 }
} else {
  $control = New-Object System.Windows.Forms.TextBox
  $control.Size = New-Object System.Drawing.Size(444, 24)
  $control.Location = New-Object System.Drawing.Point(18, 78)
  if ($request.secret -eq $true) { $control.UseSystemPasswordChar = $true }
}
if ($request.type -eq 'select') {
  $control.Location = New-Object System.Drawing.Point(18, 78)
  $control.Size = New-Object System.Drawing.Size(444, 28)
}
$form.Controls.Add($control)
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Continue'
$ok.Location = New-Object System.Drawing.Point(280, 122)
$ok.Size = New-Object System.Drawing.Size(86, 28)
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Location = New-Object System.Drawing.Point(376, 122)
$cancel.Size = New-Object System.Drawing.Size(86, 28)
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.AcceptButton = $ok
$form.CancelButton = $cancel
$form.Controls.Add($ok)
$form.Controls.Add($cancel)
$result = $form.ShowDialog()
$value = ''
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  if ($request.type -eq 'select') {
    if ($control.SelectedIndex -ge 0) { $value = [string]$request.options[$control.SelectedIndex].id }
  } else {
    $value = [string]$control.Text
  }
}
$response = [pscustomobject]@{ accepted = ($result -eq [System.Windows.Forms.DialogResult]::OK); value = $value }
[Console]::Out.WriteLine('@@MICROCODE_AUTH@@' + (ConvertTo-Json -InputObject $response -Compress))
`
}

function windowsNoticeScript(): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$line = [Console]::In.ReadLine()
$request = ConvertFrom-Json -InputObject $line
[void][System.Windows.Forms.MessageBox]::Show([string]$request.message, 'Microcode sign-in', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
[Console]::Out.WriteLine('@@MICROCODE_AUTH@@{"accepted":true}')
`
}

function runWindowsDialog(script: string, payload: unknown, signal?: AbortSignal): Promise<NativeDialogResult> {
  if (signal?.aborted) return Promise.reject(new Error('Authentication cancelled.'))
  return new Promise((resolve, reject) => {
    let output = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let child: ReturnType<typeof spawn>
    const finish = (error?: Error, result?: NativeDialogResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(result ?? { accepted: false })
    }
    const onAbort = () => {
      child.kill()
      finish(new Error('Authentication cancelled.'))
    }
    try {
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    } catch {
      finish(new Error('The native sign-in prompt could not be opened.'))
      return
    }
    const stdout = child.stdout
    const stdin = child.stdin
    if (!stdout || !stdin) {
      child.kill()
      finish(new Error('The native sign-in prompt could not be opened.'))
      return
    }
    timer = setTimeout(() => {
      child.kill()
      finish(new Error('The native sign-in prompt timed out.'))
    }, NATIVE_PROMPT_TIMEOUT_MS)
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => {
      output += chunk
      if (Buffer.byteLength(output, 'utf8') > MAX_NATIVE_RESPONSE) {
        child.kill()
        finish(new Error('The native sign-in prompt returned an invalid response.'))
      }
    })
    child.on('error', () => finish(new Error('The native sign-in prompt could not be opened.')))
    child.on('close', (code) => {
      const line = output.split(/\r?\n/).find((entry) => entry.startsWith(RESPONSE_PREFIX))
      if (!line || code !== 0) {
        finish(new Error('The native sign-in prompt could not be completed.'))
        return
      }
      try {
        const result = JSON.parse(line.slice(RESPONSE_PREFIX.length)) as NativeDialogResult
        finish(undefined, result && typeof result.accepted === 'boolean' && typeof result.value === 'string' ? result : { accepted: result?.accepted === true })
      } catch {
        finish(new Error('The native sign-in prompt returned an invalid response.'))
      }
    })
    stdin.on('error', () => undefined)
    stdin.end(JSON.stringify(payload))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

/** Keeps all credential entry inside a native OS dialog and the trusted Bun sidecar. */
export const promptForProviderAuth: ProviderAuthPrompt = async (prompt, signal) => {
  if (process.platform !== 'win32') throw new Error('Secure provider sign-in prompts are currently available on Windows desktop.')
  const secret = prompt.type === 'secret' || prompt.type === 'manual_code'
  const result = await runWindowsDialog(windowsDialogScript(), {
    type: prompt.type,
    message: prompt.message,
    secret,
    ...(prompt.type === 'select' ? { options: prompt.options } : {}),
  }, signal)
  if (!result.accepted) throw new Error('Authentication cancelled.')
  if (secret && !result.value?.trim()) throw new Error('Authentication cancelled.')
  return result.value ?? ''
}

export async function showDeviceCode(event: Extract<AuthEvent, { type: 'device_code' }>): Promise<void> {
  if (process.platform !== 'win32') return
  const lines = [
    `Sign-in code: ${event.userCode}`,
    `Open ${event.verificationUri} to continue.`,
    event.expiresInSeconds ? `The code expires in ${Math.ceil(event.expiresInSeconds / 60)} minutes.` : '',
  ].filter(Boolean)
  await runWindowsDialog(windowsNoticeScript(), { message: lines.join('\r\n\r\n') })
}

/** Validates auth callback URLs before handing them to the system browser. */
export async function openProviderAuthUrl(value: string): Promise<void> {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Provider returned an invalid sign-in URL.') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Provider returned an invalid sign-in URL.')
  }
  const command = process.platform === 'win32'
    ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url.toString()]
    : process.platform === 'darwin' ? ['open', url.toString()] : ['xdg-open', url.toString()]
  try {
    const child = spawn(command[0]!, command.slice(1), { stdio: 'ignore', windowsHide: true, detached: true })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    throw new Error('Could not open the system browser for provider sign-in.')
  }
}
