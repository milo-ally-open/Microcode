const RENDERER_FAILURE_REASONS = new Set([
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
  'memory-eviction',
])

/** Records only Electron's bounded renderer failure reason and numeric exit code. */
export function formatRendererFailureDiagnostic(reason: string, exitCode: number): string {
  const safeReason = RENDERER_FAILURE_REASONS.has(reason) ? reason : 'unknown'
  const safeExitCode = Number.isSafeInteger(exitCode) ? String(exitCode) : 'unknown'
  return `Microcode renderer process stopped (reason=${safeReason}, exitCode=${safeExitCode}).`
}
