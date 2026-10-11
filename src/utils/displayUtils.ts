/** Return the final path segment for compact UI labels. */
export function basename(path: string): string {
  const name = path.split('/').pop() ?? path
  return name || path
}

/** Truncate long user-provided text for one-line status displays. */
export function preview(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}

/** Format byte counts for dense terminal status text. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** Show a readable host/path URL summary without query noise. */
export function shortUrl(value: string, maxLength = 42): string {
  try {
    const url = new URL(value)
    const display = `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`
    return display.length > maxLength ? `...${display.slice(-(maxLength - 3))}` : display
  } catch {
    return value.length > maxLength ? `...${value.slice(-(maxLength - 3))}` : value
  }
}
