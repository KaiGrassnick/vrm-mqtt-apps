/**
 * Race a promise against a timeout. Rejects with an Error(message) if `promise`
 * hasn't settled within `ms` — the original promise is left running (it isn't
 * cancellable), but the caller can stop waiting on it.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  // The Promise executor below runs synchronously, so `timer` is always
  // assigned before the `finally` block reads it.
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
