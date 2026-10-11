const LOOPBACK_PROXY_BYPASS_HOSTS = ['localhost', '127.0.0.1', '::1'] as const

/** Ensure local Gateway requests bypass configured HTTP proxies in this process. */
export function configureLoopbackProxyBypass(env: Record<string, string | undefined> = process.env): void {
  for (const name of ['NO_PROXY', 'no_proxy']) {
    const entries = (env[name] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
    const knownEntries = new Set(entries.map((entry) => entry.toLowerCase()))

    for (const host of LOOPBACK_PROXY_BYPASS_HOSTS) {
      if (!knownEntries.has(host)) {
        entries.push(host)
        knownEntries.add(host)
      }
    }

    env[name] = entries.join(',')
  }
}
