// The commit graph, drawn like `git log --graph`: each lane waits for one commit, and no two lanes
// wait for the same one. A commit takes its lane and hands it to its first parent; when that
// parent already has a lane, this lane ends by joining it (git does the same), so lanes don't run
// side by side for the same commit. Other parents join their lane, or get a new one.

import type { Commit } from "./types";

export type GraphRow = { c: Commit; col: number; tip: boolean; before: (string | null)[]; after: (string | null)[]; merging: number[]; parentCols: number[] };

export function graphRows(commits: Commit[]): GraphRow[] {
  let lanes: (string | null)[] = [];
  const free = () => { const i = lanes.indexOf(null); return i < 0 ? lanes.length : i; };
  return commits.map((c) => {
    let col = lanes.indexOf(c.hash);
    const tip = col < 0; // nothing shown above leads here: a branch head
    if (tip) { col = free(); lanes[col] = c.hash; }
    const before = lanes.slice();
    // Lanes that were also waiting for this commit (only from older graphs; kept for safety).
    const merging = before.map((h, i) => (h === c.hash && i !== col ? i : -1)).filter((i) => i >= 0);
    for (const i of merging) lanes[i] = null;
    lanes[col] = null;
    const parentCols: number[] = [];
    for (const [k, p] of c.parents.entries()) {
      let j = lanes.indexOf(p);
      if (j < 0) { j = k === 0 ? col : free(); lanes[j] = p; }
      parentCols.push(j);
    }
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    return { c, col, tip, before, after: lanes.slice(), merging, parentCols };
  });
}

const LANE = ["#2f6fde", "#d9622b", "#2a9d6f", "#a35bd1", "#c79a1c", "#d1477a", "#3a9fb5"];
export function graphSvg(r: GraphRow, width: number) {
  const X = (i: number) => 9 + i * 12, H = 24, M = 12;
  let s = "";
  r.before.forEach((h, i) => {
    if (!h || h === r.c.hash) return;
    const j = r.after[i] === h ? i : r.after.indexOf(h);
    if (j >= 0) s += `<path d="M${X(i)} 0 C${X(i)} ${M} ${X(j)} ${M} ${X(j)} ${H}" stroke="${LANE[i % 7]}" fill="none" stroke-width="1.6"/>`;
  });
  if (!r.tip) s += `<line x1="${X(r.col)}" y1="0" x2="${X(r.col)}" y2="${M}" stroke="${LANE[r.col % 7]}" stroke-width="1.6"/>`;
  for (const i of r.merging) s += `<path d="M${X(i)} 0 C${X(i)} ${M / 2} ${X(r.col)} ${M / 2} ${X(r.col)} ${M}" stroke="${LANE[i % 7]}" fill="none" stroke-width="1.6"/>`;
  r.parentCols.forEach((j, k) => { if (r.c.parents[k]) s += `<path d="M${X(r.col)} ${M} C${X(r.col)} ${H} ${X(j)} ${M} ${X(j)} ${H}" stroke="${LANE[j % 7]}" fill="none" stroke-width="1.6"/>`; });
  s += `<circle cx="${X(r.col)}" cy="${M}" r="4" fill="${LANE[r.col % 7]}" stroke="var(--card)" stroke-width="1.5"/>`;
  return `<svg width="${width}" height="${H}">${s}</svg>`;
}
