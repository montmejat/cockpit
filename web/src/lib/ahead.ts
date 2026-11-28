// Answers asked for ahead of time, by URL: the git pane asks for a commit or a diff when the pointer
// reaches its row, so by the click it is here and CodeView shows it at once instead of "loading…".
// Also keeps the last few, so going back to one is instant too. `tag` says which version an
// answer is for (a diff changes with the file, the index and HEAD; a commit never does): one with
// another tag is asked for again.
import { api } from "./code";

type Kept = { tag: string; at: Promise<unknown>; data?: unknown };
const kept = new Map<string, Kept>();
const MAX = 40;

export function ahead<T>(url: string, tag = ""): Promise<T> {
  const k = kept.get(url);
  if (k && k.tag === tag) { kept.delete(url); kept.set(url, k); return k.at as Promise<T>; }
  const e: Kept = { tag, at: api.get<T>(url).then((d) => ((e.data = d), d)) };
  e.at.catch(() => { if (kept.get(url) === e) kept.delete(url); });
  kept.set(url, e);
  if (kept.size > MAX) kept.delete(kept.keys().next().value!);
  return e.at as Promise<T>;
}

// The answer if it has already come, for this tag.
export function have<T>(url: string, tag = ""): T | undefined {
  const k = kept.get(url);
  return k && k.tag === tag ? (k.data as T | undefined) : undefined;
}

// Where a file's diff and a commit are asked for, and which version of a diff is current.
export const diffUrl = (base: string, path: string, staged: boolean) => `${base}api/git/diff?path=${encodeURIComponent(path)}&staged=${staged ? 1 : 0}`;
export const commitUrl = (base: string, sha: string) => `${base}api/git/commit?sha=${encodeURIComponent(sha)}`;
type Live = { fileRevs: Record<string, number>; git: { head: string }; status: { path: string }[] };
export const diffTag = (L: Live, path: string) => (L.fileRevs[path] ?? 0) + "@" + L.git.head + "@" + JSON.stringify(L.status.find((x) => x.path === path) ?? null);
