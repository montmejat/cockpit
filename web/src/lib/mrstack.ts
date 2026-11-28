// The merge request tracker's logic (MrList.svelte), kept apart to be tested:
//   stacks: an MR whose target is another open MR's source sits on it, and merges after it.
//   order: yours, by hand (a list of refs, kept per project); a stack moves as one, and the MRs
//   on one MR keep their own order among themselves. MRs you haven't placed yet come last, newest first.
//   need: what an MR asks of you (to review it, or it's yours to move on), from the forge's state.
import type { TrackedMr } from "./types";

export interface Row { mr: TrackedMr; depth: number; parent: TrackedMr | null; children: number; dim: boolean }

export function parentOf(m: TrackedMr, list: TrackedMr[]): TrackedMr | null {
  return list.find((x) => x !== m && x.source === m.target && !m.fork && !x.fork) ?? null;
}

// The MRs as rows: each stack from its base down, depth for the indent. `keep` filters: an MR that
// doesn't match still shows (dimmed) when one on top of it does, so a stack is never cut.
export function rows(list: TrackedMr[], order: string[], keep: (m: TrackedMr) => boolean = () => true): Row[] {
  const rank = new Map(order.map((r, i) => [r, i]));
  const byRank = (a: TrackedMr, b: TrackedMr) =>
    (rank.get(a.ref) ?? Infinity) - (rank.get(b.ref) ?? Infinity) || b.updated.localeCompare(a.updated);
  const parent = new Map(list.map((m) => [m, parentOf(m, list)]));
  const kids = new Map<TrackedMr | null, TrackedMr[]>();
  for (const m of list) {
    let p = parent.get(m) ?? null;
    // a cycle (a → b → a) would hide both: cut it at m
    for (let x = p, n = 0; x && n <= list.length; x = parent.get(x) ?? null, n++) if (x === m) { p = null; break; }
    kids.set(p, [...(kids.get(p) ?? []), m]);
  }
  const wanted = new Map<TrackedMr, boolean>();
  const want = (m: TrackedMr): boolean => {
    if (!wanted.has(m)) wanted.set(m, keep(m) || (kids.get(m) ?? []).some(want));
    return wanted.get(m)!;
  };
  const out: Row[] = [];
  const walk = (p: TrackedMr | null, depth: number) => {
    for (const m of [...(kids.get(p) ?? [])].sort(byRank)) {
      if (!want(m)) continue;
      out.push({ mr: m, depth, parent: p, children: (kids.get(m) ?? []).length, dim: !keep(m) });
      walk(m, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

// Your order after moving `ref` before or after `to` among its siblings (MRs with the same parent);
// a move onto an MR of another parent doesn't change anything.
export function moved(order: string[], all: Row[], ref: string, to: string, after: boolean): string[] {
  const at = all.find((r) => r.mr.ref === ref), there = all.find((r) => r.mr.ref === to);
  if (!at || !there || at.parent !== there.parent || ref === to) return order;
  const sibs = all.filter((r) => r.parent === at.parent).map((r) => r.mr.ref).filter((r) => r !== ref);
  sibs.splice(sibs.indexOf(to) + (after ? 1 : 0), 0, ref);
  // the siblings first, in their new order, then everything else as it was
  return [...sibs, ...order.filter((r) => !sibs.includes(r))];
}
// One step up or down among its siblings (Alt+↑ / Alt+↓).
export function stepped(order: string[], all: Row[], ref: string, by: -1 | 1): string[] {
  const at = all.find((r) => r.mr.ref === ref);
  if (!at) return order;
  const sibs = all.filter((r) => r.parent === at.parent), i = sibs.findIndex((r) => r.mr.ref === ref), j = i + by;
  return j < 0 || j >= sibs.length ? order : moved(order, all, ref, sibs[j].mr.ref, by > 0);
}

// Dragging: the MR's siblings as blocks of rows (each MR with everything stacked on it, which
// moves with it), as [first, last] indexes into the rows; `at` is the dragged one's block.
export function blocks(all: Row[], ref: string): { refs: string[]; spans: [number, number][]; at: number } | null {
  const i = all.findIndex((r) => r.mr.ref === ref);
  if (i < 0) return null;
  const parent = all[i].parent, refs: string[] = [], spans: [number, number][] = [];
  all.forEach((r, k) => {
    if (r.parent !== parent) return;
    let end = k;
    while (end + 1 < all.length && all[end + 1].depth > r.depth) end++;
    refs.push(r.mr.ref); spans.push([k, end]);
  });
  return { refs, spans, at: refs.indexOf(ref) };
}
// Where a dragged block lands: the slot the pointer is at, among the other blocks' middles.
export function landing(middles: number[], at: number, y: number): number {
  let to = 0;
  middles.forEach((m, k) => { if (k !== at && m < y) to++; });
  return to;
}
// How far block k moves aside while block `at` is dragged to `to`, `h` being the dragged block's height.
export const aside = (k: number, at: number, to: number, h: number) =>
  at < to && k > at && k <= to ? -h : to < at && k >= to && k < at ? h : 0;
// How far the dragged block moves to sit in slot `to`: past the heights of the blocks it jumps.
export function slot(heights: number[], at: number, to: number): number {
  let d = 0;
  for (let k = Math.min(at, to); k <= Math.max(at, to); k++) if (k !== at) d += heights[k];
  return to > at ? d : to < at ? -d : 0;
}

// What it asks of you: "review" (you're a reviewer and haven't approved or asked for changes),
// "yours" (you opened it), or null.
export type Need = "review" | "yours" | null;
export function need(m: TrackedMr, me: string | null): Need {
  if (!me) return null;
  if (m.author === me) return "yours";
  const r = m.reviewers.find((x) => x.name === me);
  return r && (r.state === "waiting" || r.state === "reviewed") && !m.draft ? "review" : null;
}

// Where it stands, in one word and a colour class: ready to merge, waiting on something, or stuck.
export function standing(m: TrackedMr): { word: string; tone: "ok" | "warn" | "bad" | "muted" } {
  if (m.ready) return { word: "ready", tone: "ok" };
  if (m.draft) return { word: "draft", tone: "muted" };
  if (m.blocker === "conflict" || m.blocker === "needs rebase" || m.ci === "fail" || m.blocker === "changes requested") return { word: m.ci === "fail" && m.blocker !== "conflict" ? "CI failing" : m.blocker!, tone: "bad" };
  if (m.blocker) return { word: m.blocker, tone: "warn" };
  return { word: "—", tone: "muted" }; // the forge hasn't worked it out yet (GitLab does when someone opens the MR)
}

// The title without the forge's "Draft:" / "[WIP]" prefix: the row already says it's a draft.
export const bare = (t: string) => t.replace(/^\s*(?:draft:|\[draft\]|\(draft\)|wip:|\[wip\])\s*/i, "");
// 26871 → "26.9k"
export const short = (n: number) => (n < 1000 ? String(n) : (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "") + "k");
// "3 min", "5 h", "2 d", "4 w" ago
export function ago(iso: string, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  return s < 3600 ? Math.max(1, Math.round(s / 60)) + " min" : s < 86400 ? Math.round(s / 3600) + " h" : s < 86400 * 14 ? Math.round(s / 86400) + " d" : Math.round(s / 604800) + " w";
}
