// File icons for the files tree: a small glyph per kind of file, in a color per family (the
// colors are theme tokens, --fi-*, in app.css). A glyph is a short label ("TS", "{}") or one of a
// few drawn shapes (a page, a gear, a lock, a picture, git's diamond).

export type FileIcon = { label?: string; shape?: "doc" | "gear" | "lock" | "image" | "git"; color: string };

const L = (label: string, color: string): FileIcon => ({ label, color });
const S = (shape: FileIcon["shape"], color: string): FileIcon => ({ shape, color });

const BY_EXT: Record<string, FileIcon> = {
  ts: L("TS", "blue"), tsx: L("TS", "blue"), mts: L("TS", "blue"), cts: L("TS", "blue"),
  js: L("JS", "yellow"), mjs: L("JS", "yellow"), cjs: L("JS", "yellow"), jsx: L("JS", "yellow"),
  rs: L("RS", "orange"), zig: L("Z", "orange"), go: L("GO", "teal"), py: L("PY", "blue"),
  c: L("C", "blue"), h: L("H", "purple"), hh: L("H", "purple"), hpp: L("H", "purple"), hxx: L("H", "purple"),
  cc: L("C+", "blue"), cpp: L("C+", "blue"), cxx: L("C+", "blue"), ipp: L("C+", "blue"), tpp: L("C+", "blue"),
  m: L("OC", "blue"), mm: L("OC", "blue"), swift: L("SW", "orange"), java: L("J", "red"), kt: L("K", "purple"),
  lua: L("LU", "blue"), rb: L("RB", "red"), php: L("PH", "purple"), cs: L("C#", "green"),
  sh: L("$", "green"), bash: L("$", "green"), zsh: L("$", "green"), fish: L("$", "green"), ps1: L("$", "blue"),
  json: L("{}", "yellow"), jsonc: L("{}", "yellow"), json5: L("{}", "yellow"), jsonl: L("{}", "yellow"),
  yml: L("Y", "purple"), yaml: L("Y", "purple"), toml: S("gear", "gray"), ini: S("gear", "gray"), cfg: S("gear", "gray"), conf: S("gear", "gray"), env: S("gear", "yellow"),
  md: L("M", "blue"), mdx: L("M", "blue"), rst: L("R", "blue"), txt: S("doc", "gray"), log: S("doc", "gray"),
  html: L("<>", "orange"), htm: L("<>", "orange"), xml: L("<>", "orange"), svelte: L("S", "red"), vue: L("V", "green"),
  css: L("#", "blue"), scss: L("#", "red"), less: L("#", "blue"),
  proto: L("P", "teal"), glsl: L("GL", "teal"), vert: L("GL", "teal"), frag: L("GL", "teal"), wgsl: L("GL", "teal"),
  nix: L("NX", "blue"), cmake: L("▲", "green"), mk: S("gear", "orange"), sql: L("DB", "yellow"),
  png: S("image", "purple"), jpg: S("image", "purple"), jpeg: S("image", "purple"), gif: S("image", "purple"), webp: S("image", "purple"), ico: S("image", "purple"), svg: S("image", "orange"),
  lock: S("lock", "gray"), patch: S("git", "orange"), diff: S("git", "orange"),
  pdf: S("doc", "red"), csv: S("doc", "green"), tsv: S("doc", "green"),
};
const BY_NAME: Record<string, FileIcon> = {
  "cmakelists.txt": L("▲", "green"), makefile: S("gear", "orange"), "cargo.toml": L("RS", "orange"), "cargo.lock": S("lock", "orange"),
  "package.json": L("{}", "green"), "package-lock.json": S("lock", "green"), "tsconfig.json": L("TS", "blue"),
  ".gitignore": S("git", "orange"), ".gitattributes": S("git", "orange"), ".gitmodules": S("git", "orange"), ".gitlab-ci.yml": S("git", "orange"),
  ".dockerignore": L("D", "gray"), ".editorconfig": S("gear", "gray"), ".clang-format": S("gear", "gray"), ".clang-tidy": S("gear", "gray"),
  ".clangd": S("gear", "gray"), ".env": S("gear", "yellow"), ".npmrc": S("gear", "gray"), ".prettierrc": S("gear", "gray"),
  license: S("doc", "yellow"), "license.md": S("doc", "yellow"), "license.txt": S("doc", "yellow"),
  "compile_commands.json": L("{}", "gray"), "build.zig": L("Z", "orange"), "build.zig.zon": L("Z", "orange"),
};

export function fileIcon(name: string): FileIcon {
  const n = name.toLowerCase();
  if (BY_NAME[n]) return BY_NAME[n];
  if (n === "dockerfile" || n.startsWith("dockerfile.") || n.endsWith(".dockerfile")) return L("D", "blue");
  if (n.startsWith(".env.")) return S("gear", "yellow");
  if (n.startsWith("readme")) return L("i", "blue");
  const dot = n.lastIndexOf(".");
  return (dot > 0 && BY_EXT[n.slice(dot + 1)]) || S("doc", "gray");
}

// The drawn shapes, on a 16×16 grid, stroked in the icon's color.
export const SHAPES: Record<NonNullable<FileIcon["shape"]>, string> = {
  doc: '<path d="M4 1.5h5.5L12.5 4.5v10h-8.5z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M6 7.5h4.5M6 10h4.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>',
  gear: '<circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  lock: '<rect x="3.5" y="7" width="9" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="6" cy="6.5" r="1.2" fill="currentColor"/><path d="M3 12l3.5-3.5 2.5 2.5 1.5-1.5L13 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
  git: '<path d="M8 1.6 14.4 8 8 14.4 1.6 8z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="5.6" r="1.1" fill="currentColor"/><circle cx="8" cy="10.4" r="1.1" fill="currentColor"/><path d="M8 5.6v4.8" stroke="currentColor" stroke-width="1.1"/>',
};
