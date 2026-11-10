// The commit graph, drawn like `git log --graph`: each lane waits for a commit; a commit takes its
// lane and hands it to its first parent; other parents get lanes of their own.

import type { Commit } from "./types";

export type GraphRow = { c: Commit; col: number; before: (string | null)[]; after: (string | null)[]; merging: number[]; parentCols: number[] };

export function graphRows(commits: Commit[]): GraphRow[] {
  let lanes: (string | null)[] = [];
  return commits.map((c) => {
    let col = lanes.indexOf(c.hash);
    if (col < 0) { col = lanes.indexOf(null); if (col < 0) col = lanes.length; lanes[col] = c.hash; }
    const before = lanes.slice();
    const merging = before.map((h, i) => (h === c.hash && i !== col ? i : -1)).filter((i) => i >= 0);
    lanes = lanes.map((h, i) => (merging.includes(i) ? null : h));
    lanes[col] = c.parents[0] ?? null;
    const parentCols = [col];
    for (const p of c.parents.slice(1)) {
      let j = lanes.indexOf(p);
      if (j < 0) { j = lanes.indexOf(null); if (j < 0) j = lanes.length; lanes[j] = p; }
      parentCols.push(j);
    }
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    return { c, col, before, after: lanes.slice(), merging, parentCols };
  });
}

const LANE = ["#2f6fde", "#d9622b", "#2a9d6f", "#a35bd1", "#c79a1c", "#d1477a", "#3a9fb5"];
export function graphSvg(r: GraphRow, width: number) {
  const X = (i: number) => 9 + i * 12, H = 24, M = 12;
  let s = "";
  r.before.forEach((h, i) => {
    if (!h || h === r.c.hash) return;
    const j = r.after.indexOf(h);
    if (j >= 0) s += `<path d="M${X(i)} 0 C${X(i)} ${M} ${X(j)} ${M} ${X(j)} ${H}" stroke="${LANE[i % 7]}" fill="none" stroke-width="1.6"/>`;
  });
  if (r.before[r.col] === r.c.hash) s += `<line x1="${X(r.col)}" y1="0" x2="${X(r.col)}" y2="${M}" stroke="${LANE[r.col % 7]}" stroke-width="1.6"/>`;
  for (const i of r.merging) s += `<path d="M${X(i)} 0 C${X(i)} ${M / 2} ${X(r.col)} ${M / 2} ${X(r.col)} ${M}" stroke="${LANE[i % 7]}" fill="none" stroke-width="1.6"/>`;
  r.parentCols.forEach((j, k) => { if (r.c.parents[k]) s += `<path d="M${X(r.col)} ${M} C${X(r.col)} ${H} ${X(j)} ${M} ${X(j)} ${H}" stroke="${LANE[j % 7]}" fill="none" stroke-width="1.6"/>`; });
  s += `<circle cx="${X(r.col)}" cy="${M}" r="4" fill="${LANE[r.col % 7]}" stroke="var(--card)" stroke-width="1.5"/>`;
  return `<svg width="${width}" height="${H}">${s}</svg>`;
}
