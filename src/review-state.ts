// Review mode's part of the live state: what the reviewed branch changes against its target
// (files, items, the modules it reaches), the diagrams' boxes it adds and removes, and the
// discussions on its merge request.

import { ARCH_DIR, loadArch } from "./arch.ts";
import type { Git, Status } from "./git.ts";
import type { createPrivate } from "./private.ts";
import type { createReview } from "./review.ts";
import type { Skeleton } from "./skeleton.ts";
import { itemsIn } from "./tests-of.ts";

export function createReviewState(root: string, git: Git, review: ReturnType<typeof createReview>, priv: ReturnType<typeof createPrivate>) {

  // Where the reviewed branch left its target: the merge request's diff starts there.
  const baseOf = async () => { const r = review.current(); return r ? (await git.read("merge-base", "HEAD", r.target)) || null : null; };

  // The diagrams as the target had them, by commit (they never change for a given commit).
  // null when the target has no .cockpit/ (not committed, or kept out of git): nothing to compare.
  const baseDiagrams = new Map<string, Map<string, { question: string; nodes: Map<string, string> }> | null>();
  async function diagramsAt(base: string) {
    // .cockpit/ kept private: the description saved at (or nearest before) the base, from the store.
    const kept = (await git.read("cat-file", "-t", `${base}:${ARCH_DIR}/project.json`)) === "blob" ? null : priv.at(base);
    const key = kept ? base + "@" + kept : base;
    if (!baseDiagrams.has(key)) {
      const arch = kept ? loadArch(root, kept, priv.store).arch : loadArch(root, base).arch;
      baseDiagrams.set(key, arch ? new Map(arch.diagrams.map((d) => [d.id, { question: d.question, nodes: new Map(d.nodes.map((n) => [n.id, n.label])) }])) : null);
    }
    return baseDiagrams.get(key)!;
  }

  // What the review changes: files and items (committed on the branch or not), and the diagrams'
  // own boxes added and removed.
  async function state(sk: Skeleton, status: Status[], diagrams: { id: string; question: string; nodes: { id: string; label: string }[] }[]) {
    const r = review.current();
    if (!r) return null;
    // The merge request's discussions; `older`: written against another commit than the one
    // checked out, so its line may have moved.
    const head = await git.read("rev-parse", "HEAD"), t = review.threads();
    const threads = t.list?.map((x) => ({ ...x, older: !!x.head && !!head && x.head !== head })) ?? null, threadsError = t.error;
    const base = await baseOf();
    if (!base) return { ...r, base: null, error: `${r.target} and this branch share no history`, files: [], changedFiles: [], changedItems: [], impacted: [], commits: 0, diagrams: {}, removedDiagrams: [], threads, threadsError };
    const [lines, nameStatus, short, commits] = await Promise.all([
      git.changedLines(status, base), git.read("diff", "--name-status", "--no-renames", base),
      git.read("rev-parse", "--short", base), git.read("rev-list", "--count", `${base}..HEAD`),
    ]);
    const files: { path: string; st: string }[] = nameStatus.split("\n").filter(Boolean)
      .map((l) => { const [st, path] = l.split("\t"); return { path, st: st[0] }; });
    for (const s of status) if (s.x === "?" && !files.some((f) => f.path === s.path)) files.push({ path: s.path, st: "A" });
    files.sort((a, b) => a.path.localeCompare(b.path));
    const before = await diagramsAt(base), diff: Record<string, { isNew: boolean; added: string[]; removed: { id: string; label: string }[] }> = {};
    if (before) for (const d of diagrams) {
      const b = before.get(d.id);
      const added = b ? d.nodes.filter((n) => !b.nodes.has(n.id)).map((n) => n.id) : d.nodes.map((n) => n.id);
      const removed = b ? [...b.nodes].filter(([id]) => !d.nodes.some((n) => n.id === id)).map(([id, label]) => ({ id, label })) : [];
      if (!b || added.length || removed.length) diff[d.id] = { isNew: !b, added, removed };
    }
    // What it impacts: the modules that use a changed one (one step out), not changed themselves.
    const changedFiles = new Set(Object.keys(lines));
    const changedMods = new Set(sk.modules.filter((m) => changedFiles.has(m.file)).map((m) => m.id));
    const impacted = [...new Set(sk.edges.filter((e) => changedMods.has(e.to) && !changedMods.has(e.from)).map((e) => e.from))];
    return {
      ...r, base: short, error: null,
      commits: Number(commits) || 0,
      files, changedFiles: [...changedFiles], changedItems: itemsIn(sk, lines), impacted,
      diagrams: diff, removedDiagrams: [...(before ?? [])].filter(([id]) => !diagrams.some((d) => d.id === id)).map(([id, b]) => ({ id, question: b.question })),
      threads, threadsError,
    };
  }
  return { base: baseOf, state };
}
