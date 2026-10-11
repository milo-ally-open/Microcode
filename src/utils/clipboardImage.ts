import { spawn } from 'node:child_process'

const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024

export interface ClipboardImage {
  data: string
  mimeType: string
}

export function identifyClipboardImage(bytes: Uint8Array): string | undefined {
  if (bytes.length < 4 || bytes.length > MAX_CLIPBOARD_IMAGE_BYTES) return undefined
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (String.fromCharCode(...bytes.subarray(0, 6)).startsWith('GIF8')) return 'image/gif'
  if (
    bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) return 'image/webp'
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  return undefined
}

function runClipboardCommand(command: string, args: string[]): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (result?: Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish()
    }, 1500)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_CLIPBOARD_IMAGE_BYTES) {
        child.kill()
        finish()
        return
      }
      chunks.push(chunk)
    })
    child.on('error', () => finish())
    child.on('close', (code) => finish(code === 0 ? Buffer.concat(chunks) : undefined))
  })
}

export async function readClipboardImage(): Promise<ClipboardImage | undefined> {
  const commands: Array<[string, string[]]> = process.platform === 'win32'
    ? [['powershell.exe', [
      '-NoProfile', '-STA', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $i=[Windows.Forms.Clipboard]::GetImage(); if($i){$m=[IO.MemoryStream]::new(); $i.Save($m,[Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($m.ToArray()); $m.Dispose(); $i.Dispose()}',
    ]]]
    : process.platform === 'linux'
      ? [
        ['wl-paste', ['--no-newline', '--type', 'image/png']],
        ['wl-paste', ['--no-newline', '--type', 'image/jpeg']],
        ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
        ['xclip', ['-selection', 'clipboard', '-t', 'image/jpeg', '-o']],
      ]
      : [['pngpaste', []]]

  for (const [command, args] of commands) {
    const output = await runClipboardCommand(command, args)
    if (!output?.length) continue
    const bytes = command === 'powershell.exe'
      ? Buffer.from(output.toString('utf8').trim(), 'base64')
      : output
    const mimeType = identifyClipboardImage(bytes)
    if (mimeType) return { data: bytes.toString('base64'), mimeType }
  }
  return undefined
}
