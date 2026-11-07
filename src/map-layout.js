// Map positions, shared by the map page and the work page (plain browser JS, inlined).
// Components sit on a grid; the same positions are used at every zoom level.
//  - If the model has rows (written by the agent in architecture.json), they set the grid:
//    one row per entry, left to right. Components left out go in a last row.
//  - Otherwise: one column per crate, and inside a column, components that use others on top.
function mapLayout(SK, MODEL) {
  const comps = MODEL.components, names = comps.map((c) => c.name);
  const byName = new Map(comps.map((c) => [c.name, c]));
  let grid; // grid[row][col] = component name or undefined

  if (MODEL.rows?.length) {
    grid = MODEL.rows.map((r) => r.filter((n) => byName.has(n))).filter((r) => r.length);
    const placed = new Set(grid.flat()), rest = names.filter((n) => !placed.has(n));
    if (rest.length) grid.push(rest);
  } else {
    const rank = dependencyRank(SK, MODEL);
    const crateOfMod = new Map(SK.modules.map((m) => [m.id, m.crate]));
    const crateOf = (c) => {
      const n = {};
      for (const m of c.modules) n[crateOfMod.get(m)] = (n[crateOfMod.get(m)] || 0) + 1;
      return Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    };
    const cols = new Map();
    for (const c of comps) { const k = crateOf(c); if (!cols.has(k)) cols.set(k, []); cols.get(k).push(c.name); }
    // Crates whose components sit higher (use more) go left, bigger crates first on ties;
    // crates with no links to other crates go last.
    const linked = new Set();
    for (const e of SK.edges) { const a = crateOfMod.get(e.from), b = crateOfMod.get(e.to); if (a !== b) linked.add(a).add(b); }
    const order = [...cols].sort((a, b) => (linked.has(b[0]) - linked.has(a[0])) ||
      Math.min(...a[1].map((n) => rank.get(n))) - Math.min(...b[1].map((n) => rank.get(n))) || b[1].length - a[1].length || a[0].localeCompare(b[0]));
    const columns = order.map(([, ns]) => ns.sort((a, b) => rank.get(a) - rank.get(b) || a.localeCompare(b)));
    const h = Math.max(...columns.map((c) => c.length));
    grid = Array.from({ length: h }, (_, r) => columns.map((c) => c[r]));
  }

  // Each component is a small grid of its modules; rows and columns sized to their largest cell.
  const CW = 190, CH = 62, GAP = 70, pos = {};
  const dims = new Map(names.map((n) => {
    const k = byName.get(n).modules.length;
    const cols = Math.min(k, k > 4 ? 3 : 2) || 1;
    return [n, { cols, rws: Math.ceil(k / cols) || 1 }];
  }));
  const nCols = Math.max(...grid.map((r) => r.length));
  const colW = Array.from({ length: nCols }, (_, c) => Math.max(1, ...grid.map((r) => (r[c] ? dims.get(r[c]).cols : 0))) * CW);
  const rowH = grid.map((r) => Math.max(1, ...r.map((n) => (n ? dims.get(n).rws : 0))) * CH);
  let y = 0;
  grid.forEach((row, ri) => {
    let x = 0;
    for (let ci = 0; ci < nCols; ci++) {
      const n = row[ci];
      if (n) {
        const d = dims.get(n), w = d.cols * CW, hh = d.rws * CH;
        const x0 = x + (colW[ci] - w) / 2, y0 = y + (rowH[ri] - hh) / 2;
        pos["c:" + n] = { x: x0 + w / 2, y: y0 + hh / 2 };
        byName.get(n).modules.forEach((m, i) =>
          (pos["m:" + m] = { x: x0 + (i % d.cols) * CW + CW / 2, y: y0 + Math.floor(i / d.cols) * CH + CH / 2 }));
      }
      x += colW[ci] + GAP;
    }
    y += rowH[ri] + GAP + 30;
  });
  return pos;
}

// 0 for components nothing uses, growing toward the foundations. Mutual pairs keep their
// stronger direction; leftover cycles are broken by a DFS.
function dependencyRank(SK, MODEL) {
  const compOf = (id) => MODEL.components.find((c) => c.modules.includes(id));
  const names = MODEL.components.map((c) => c.name);
  const w = new Map();
  for (const e of SK.edges) {
    const a = compOf(e.from)?.name, b = compOf(e.to)?.name;
    if (a && b && a !== b) w.set(a + "\u0000" + b, (w.get(a + "\u0000" + b) || 0) + e.refs);
  }
  const out = new Map(names.map((n) => [n, []]));
  for (const [k, refs] of w) {
    const [a, b] = k.split("\u0000");
    if ((w.get(b + "\u0000" + a) || 0) <= refs) out.get(a).push(b);
  }
  const state = new Map(), dag = new Map(names.map((n) => [n, []]));
  const visit = (n) => {
    state.set(n, 1);
    for (const m of out.get(n)) { if (state.get(m) === 1) continue; dag.get(n).push(m); if (!state.get(m)) visit(m); }
    state.set(n, 2);
  };
  const net = (n) => [...w].reduce((s, [k, r]) => s + (k.startsWith(n + "\u0000") ? r : 0) - (k.endsWith("\u0000" + n) ? r : 0), 0);
  [...names].sort((a, b) => net(b) - net(a)).forEach((n) => { if (!state.get(n)) visit(n); });
  const rank = new Map(names.map((n) => [n, 0]));
  for (let i = 0; i < names.length; i++)
    for (const [a, bs] of dag) for (const b of bs) rank.set(b, Math.max(rank.get(b), rank.get(a) + 1));
  return rank;
}
