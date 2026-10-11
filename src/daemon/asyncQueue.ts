/** Bounded async handoff used by the local auth RPC stream. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  constructor(private readonly maxBufferedItems = 64, private readonly maxItemBytes = 64 * 1024) {}

  push(value: T): void {
    if (this.closed) return
    const serialized = JSON.stringify(value)
    if (serialized && Buffer.byteLength(serialized, 'utf8') > this.maxItemBytes) {
      throw new Error('Async queue item exceeds its size limit.')
    }
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else {
      if (this.values.length >= this.maxBufferedItems) throw new Error('Async queue exceeded its buffered item limit.')
      this.values.push(value)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) this.waiters.shift()!({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve))
      },
      return: async () => {
        this.close()
        return { value: undefined, done: true }
      },
    }
  }
}
