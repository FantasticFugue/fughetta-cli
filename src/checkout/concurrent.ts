// Bound both outstanding reads and completed values waiting for their ordered consumer.
export async function* prefetch<T, R>(items: readonly T[], read: (item: T) => Promise<R>, concurrency = 8) {
  const pending = new Map<number, Promise<{ value: R } | { error: unknown }>>();
  let next = 0;
  const fill = () => {
    while (next < items.length && pending.size < concurrency) {
      const index = next++;
      pending.set(index, Promise.resolve().then(() => read(items[index]!)).then(
        value => ({ value }), error => ({ error }),
      ));
    }
  };
  fill();
  try {
    for (let index = 0; index < items.length; index++) {
      const result = await pending.get(index)!;
      pending.delete(index);
      if ('error' in result) throw result.error;
      yield { item: items[index]!, value: result.value };
      fill();
    }
  } finally {
    await Promise.all(pending.values());
  }
}
