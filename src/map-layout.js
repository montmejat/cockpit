// Map positions, shared by the map page and the work page (plain browser JS, inlined).
// Layered layout: components that use others on top, foundations at the bottom.
// The same positions are used at every zoom level, so the map keeps its shape.
function mapLayout(SK, MODEL) {
  const compOf = (id) => MODEL.components.find((c) => c.modules.includes(id));
  const names = MODEL.components.map((c) => c.name);
  const w = new Map();
  for (const e of SK.edges) {
    const a = compOf(e.from)?.name, b = compOf(e.to)?.name;
    if (a && b && a !== b) w.set(a + "\u0000" + b, (w.get(a + "\u0000" + b) || 0) + e.refs);
  }
  // Drop the weaker direction of each mutual pair, then break leftover cycles with a DFS.
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
  const rows = [];
  for (const n of names) (rows[rank.get(n)] ??= []).push(n);
  // Module grid inside each component; rows sized to their tallest component.
  const CW = 190, CH = 62, GAP = 70, pos = {};
  let y = 0;
  for (const row of rows.filter(Boolean)) {
    const dims = row.map((n) => {
      const k = MODEL.components.find((c) => c.name === n).modules.length;
      const cols = Math.min(k, k > 4 ? 3 : 2) || 1;
      return { n, cols, rws: Math.ceil(k / cols) || 1 };
    });
    const h = Math.max(...dims.map((d) => d.rws)) * CH;
    let x = 0;
    for (const d of dims) {
      const wd = d.cols * CW;
      pos["c:" + d.n] = { x: x + wd / 2, y: y + h / 2 };
      MODEL.components.find((c) => c.name === d.n).modules.forEach((m, i) =>
        (pos["m:" + m] = { x: x + (i % d.cols) * CW + CW / 2, y: y + Math.floor(i / d.cols) * CH + CH / 2 }));
      x += wd + GAP;
    }
    y += h + GAP + 30;
  }
  return pos;
}
