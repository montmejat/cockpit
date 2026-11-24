// The page's look comes from the tokens in web/src/app.css :root (colours, corners, shadows, font
// sizes, control heights), so it stays one system instead of drifting a pixel at a time. Outside :root, CSS uses
// var(--…) for these. Fails with what to use instead.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const files = readdirSync(join(root, "web/src"), { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && /\.(css|svelte)$/.test(e.name)).map((e) => join(e.parentPath, e.name));

// Drop the token blocks (:root{…} and the theme overrides) and comments: only what uses tokens is checked.
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
  .replace(/:root[^{]*\{[^}]*\}/g, (b) => b.replace(/[^\n]/g, " "));

const bad = [];
for (const f of files) {
  let src = readFileSync(f, "utf8");
  if (f.endsWith(".svelte")) src = (src.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? "") + "\n" + [...src.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).join("\n");
  strip(src).split("\n").forEach((line, i) => {
    const at = `${relative(root, f)}:${i + 1}`;
    for (const m of line.matchAll(/border-radius:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      if (!v.split(/\s+/).every((p) => /^(0|50%|var\(--r-[a-z]+\))$/.test(p))) bad.push(`${at}: border-radius:${v}. Use var(--r-xs|s|m|l|pill), 0 or 50%.`);
    }
    for (const m of line.matchAll(/box-shadow:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      if (/#[0-9a-f]{3,8}\b|rgba?\(/i.test(v)) bad.push(`${at}: box-shadow:${v}. Use var(--shadow-raise|pop|modal), or a var(--…) colour for indicator lines.`);
    }
    for (const m of line.matchAll(/font-size:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      if (!/^(var\(--fs-[a-z0-9]+\)|inherit|1em|100%)$/.test(v)) bad.push(`${at}: font-size:${v}. Use var(--fs-2xs|xs|s|m|l|xl|code), or inherit.`);
    }
    for (const m of line.matchAll(/(?<![\w-])#[0-9a-fA-F]{3,8}\b/g)) bad.push(`${at}: colour ${m[0]}. Use a colour token from :root (var(--fg), var(--accent)…), or add one there for both themes.`);
  });
}
// Controls (buttons, tabs) take their size from --ctl (26px: in bars), --ctl-s (22px: in rows) or
// --ctl-xs (18px: a × inside a tab or a thumbnail), so the controls of one bar line up.
// The window buttons follow GNOME's own size.
const css = strip(readFileSync(join(root, "web/src/app.css"), "utf8"));
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const sel = m[1].trim(), body = m[2];
  if (!/(^|[\s,>+~])(button|\.seg|\.ibtn|\.mtrig|\.gact|\.cdel|\.csend|\.ctitle)\b/.test(sel) || /\.winctl/.test(sel)) continue;
  for (const d of body.matchAll(/(?<![\w-])(height|width):\s*(\d+(?:\.\d+)?)px/g))
    if (+d[2] >= 16 && +d[2] <= 34) bad.push(`web/src/app.css:${css.slice(0, m.index).split("\n").length}: ${sel} ${d[1]}:${d[2]}px. Size controls with var(--ctl) (26px, in bars), var(--ctl-s) (22px, in rows) or var(--ctl-xs) (18px).`);
}
if (bad.length) { console.log(bad.join("\n")); console.log(`\n${bad.length} raw style value(s): use the tokens in web/src/app.css :root`); process.exit(1); }
console.log("styles use the tokens");
