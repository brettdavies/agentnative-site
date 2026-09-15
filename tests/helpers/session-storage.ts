// An in-memory sessionStorage stand-in for tests that exercise the
// per-tab stash modules under bun, where no window exists.

export function makeSessionStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

/** Swap the global sessionStorage for a fresh fake; returns a restore function. */
export function installSessionStorage(): () => void {
  const holder = globalThis as { sessionStorage?: Storage };
  const real = holder.sessionStorage;
  holder.sessionStorage = makeSessionStorage();
  return () => {
    holder.sessionStorage = real;
  };
}
