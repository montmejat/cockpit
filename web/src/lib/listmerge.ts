// A list patched by key (src/listpatch.ts makes the patch): changed and new entries replace or
// join, removed ones go; when the membership changed the server sends the new order of keys.
export function merge<T>(list: T[], p: { set: T[]; del: string[]; keys?: string[] }, key: (x: T) => string): T[] {
  const by = new Map(list.map((x) => [key(x), x]));
  for (const k of p.del) by.delete(k);
  for (const x of p.set) by.set(key(x), x);
  return p.keys ? p.keys.map((k) => by.get(k)!).filter(Boolean) : list.filter((x) => by.has(key(x))).map((x) => by.get(key(x))!);
}
