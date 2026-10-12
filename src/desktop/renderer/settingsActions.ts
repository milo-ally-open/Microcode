/** Commits returned settings and any success notice only after the backend operation resolves. */
export async function applySettingsAction<T>(
  operation: () => Promise<T>,
  onApplied: (value: T) => void,
  onFailed: (error: unknown) => void,
): Promise<boolean> {
  try {
    const value = await operation()
    onApplied(value)
    return true
  } catch (error) {
    onFailed(error)
    return false
  }
}
