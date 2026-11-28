// The git pane's staged and changes lists, held still while you work in them: a file you stage
// or unstage stays in its row (shown moved, its button undoing it) instead of jumping to the other
// list and sliding the next file's button under the pointer. Taken when a row's button is clicked,
// let go when the pointer or focus leaves the lists. A file that appears in the meantime (an agent's
// edit) joins at the end of its list; one that is gone (reverted, committed) leaves.
export type Held = { staged: string[]; unstaged: string[] };
export type Shown = { path: string; moved: boolean };

export function heldView(staged: string[], unstaged: string[], held: Held | null): { staged: Shown[]; unstaged: Shown[] } {
  if (!held) return { staged: staged.map((path) => ({ path, moved: false })), unstaged: unstaged.map((path) => ({ path, moved: false })) };
  const inS = new Set(staged), inU = new Set(unstaged), was = new Set([...held.staged, ...held.unstaged]);
  // A held row keeps its place while the file still has changes on either side.
  const keep = (snap: string[], here: Set<string>) =>
    snap.filter((p) => inS.has(p) || inU.has(p)).map((path) => ({ path, moved: !here.has(path) }));
  const fresh = (now: string[]) => now.filter((p) => !was.has(p)).map((path) => ({ path, moved: false }));
  return { staged: [...keep(held.staged, inS), ...fresh(staged)], unstaged: [...keep(held.unstaged, inU), ...fresh(unstaged)] };
}
