// Shared UI pieces stay shared. Tabs are made with web/src/components/ui/Tab.svelte, and the
// "raised" look (the picked tab or row: a card with a 1px ring and a small shadow) is written once in
// web/src/app.css, in the `.raised,.seg.on` rule. Copies drift: the terminal's own tabs once had their
// ring clipped by their scroller and a focus outline on click, which the shared piece already handled.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const web = join(root, "web/src");
const files = readdirSync(web, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && /\.(css|svelte)$/.test(e.name)).map((e) => join(e.parentPath, e.name));
const ui = join(web, "components/ui") + "/";

const bad = [];
for (const f of files) {
  const src = readFileSync(f, "utf8"), at = (i) => `${relative(root, f)}:${src.slice(0, i).split("\n").length}`;
  if (f.endsWith(".svelte") && !f.startsWith(ui))
    for (const m of src.matchAll(/role="tab"/g)) bad.push(`${at(m.index)}: a hand-made tab. Use <Tab> from components/ui/Tab.svelte inside a .segs strip.`);
  // every rule that uses the raised shadow; only the shared one may
  for (const m of src.matchAll(/([^{}]*)\{([^{}]*var\(--shadow-raise\)[^{}]*)\}/g)) {
    const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (sel.startsWith(":root") || sel === ".raised,.seg.on") continue;
    bad.push(`${at(m.index + m[0].indexOf("{"))}: "${sel}" draws its own raised look. Add the class "raised" to the element (or use <Tab>) instead.`);
  }
}
if (bad.length) { console.log(bad.join("\n")); console.log(`\n${bad.length} copy(ies) of a shared piece: use components/ui/`); process.exit(1); }
console.log("tabs and the raised look come from components/ui and the one .raised rule");
