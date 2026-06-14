let queue: Promise<unknown> = Promise.resolve();

export async function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.then(() => undefined, () => undefined);
  return next;
}
