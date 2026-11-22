// Big lists go to the page as the entries that changed, by key: a large project's modules and
// tests are ~1 MB and an edit shifts the lines of one file only. Sending them whole on every save
// stalled the page (WebKit reads the event stream on its main thread) for 100-180 ms.
// `keys` (the new order) only comes along when entries were added or removed. The page merges
// them back with web/src/lib/listmerge.ts.

export type ListPatch = { set: unknown[]; del: string[]; keys?: string[] };

export function listPatch<T>(before: T[], after: T[], key: (x: T) => string): ListPatch {
  const old = new Map(before.map((x) => [key(x), JSON.stringify(x)]));
  const set = after.filter((x) => old.get(key(x)) !== JSON.stringify(x));
  const now = new Set(after.map(key)), del = [...old.keys()].filter((k) => !now.has(k));
  const same = !del.length && !set.some((x) => !old.has(key(x)));
  return same ? { set, del } : { set, del, keys: after.map(key) };
}

