// The page's state: what the server pushes (S), what you have open (ui), and the questions every
// part asks of them (what changed, where a diagram link points).

import { SvelteSet } from "svelte/reactivity";
import { api } from "./code";
import { merge } from "./listmerge";
import type { DiagramNode, Live, Tab, TermMeta } from "./types";

// The desktop app's window (desktop/src/main.rs, BRIDGE), absent in a browser tab.
export interface Desktop {
  openProject(path: string | null): Promise<boolean | { error: string }>;
  newWindow(): Promise<boolean | { error: string }>; // another window, asking for its project
  pickFolder(): Promise<string | null>; // a folder chosen in the system dialog, or null
  state(): Promise<{ maximized: boolean; fullscreen: boolean }>;
  startDragging(): Promise<boolean>;
  minimize(): Promise<boolean>;
  toggleMaximize(): Promise<boolean>;
  close(): Promise<boolean>;
}
declare global { interface Window { INIT: Live & { terminals: TermMeta[] }; cockpitDesktop?: Desktop } }

const boot = window.INIT;
export const initialTerminals: TermMeta[] = boot.terminals ?? [];

// Live data. The server sends it whole once, then only the parts that changed (src/project-server.ts).
// Each part is reactive as a whole and never deeply: parts are only ever replaced, and some are
// big (a large project's modules and tests are ~1 MB, sent again on every save as lines shift),
// so deep proxies made every push stall the page for ~170 ms.
function cell<T>(v: T) {
  let x = $state.raw(v);
  return { get: () => x, set: (n: T) => { x = n; } };
}
export const S: Live = (() => {
  const o = {} as Live;
  for (const k of Object.keys(boot) as (keyof Live)[]) {
    const c = cell(boot[k]);
    Object.defineProperty(o, k, { get: c.get, set: c.set as (v: unknown) => void, enumerable: true });
  }
  return o;
})();

export function connectLive() {
  const es = new EventSource("api/events");
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    const parts = e.type === "full" ? e.state : e.patch;
    // The whole state comes on (re)connecting, usually the same as the page's (it just loaded
    // with it): unchanged parts are left alone, so nothing is redrawn or fetched again for them.
    for (const k of Object.keys(parts)) if (e.type !== "full" || JSON.stringify((S as any)[k]) !== JSON.stringify(parts[k])) (S as any)[k] = parts[k];
    // Big lists come as their changed entries (src/project-server.ts, listPatch).
    const l = e.lists ?? {};
    if (l.modules) S.modules = merge(S.modules, l.modules, (m) => m.id);
    if (l["tests.unit"] || l["tests.integration"]) S.tests = {
      unit: l["tests.unit"] ? merge(S.tests.unit, l["tests.unit"], (u) => u.module + "\0" + u.file) : S.tests.unit,
      integration: l["tests.integration"] ? merge(S.tests.integration, l["tests.integration"], (t) => t.file) : S.tests.integration,
    };
  };
  // EventSource reconnects by itself; the server starts again with the whole state.
}

// ---- small helpers -------------------------------------------------------

export const store = {
  get: (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
};
export const plural = (n: number, w: string) => n + " " + w + (n === 1 ? "" : "s");
export const nameOf = (d: { id: string } | undefined | null) => (d ? d.id.replace(/-/g, " ") : "");
// The agents write a short "tldr"; until they do, the first sentence stands in.
export const tldr = (x: { tldr?: string }, long?: string) => x.tldr || (long ?? "").split(/(?<=[.!?])\s/)[0];

// ---- the map's project -------------------------------------------------------
// In a workspace the map shows any of its projects' diagrams (the map tab's `project`, none for
// this page's own), without leaving the page: M is that project's live state, as S is this
// one's. projects.svelte.ts says where each project is (setMapSource); alone, it is S.
export type MapSource = { name: string; base: string; prefix: string; L: Live; set(k: keyof Live, v: unknown): void };
let mapSource = (_name?: string): MapSource => ({ name: S.project, base: "", prefix: "", L: S, set: (k, v) => { (S as any)[k] = v; } });
export const setMapSource = (f: typeof mapSource) => { mapSource = f; };
export const mp = () => mapSource(mapTab().project);
export const M: Live = new Proxy({} as Live, {
  get: (_, k) => (mp().L as any)[k],
  set: (_, k, v) => { mp().set(k as keyof Live, v); return true; },
});
// A file of the map's project as the page names it ("@name/path" for another project's), and back
// (null: not one of its files).
export const mapFile = (f: string) => mp().prefix + f;
export const fromMapFile = (p: string) => { const pre = mp().prefix; return pre ? (p.startsWith(pre) ? p.slice(pre.length) : null) : p.startsWith("@") ? null : p; };

export const byId = (id: string | null | undefined) => M.diagrams.find((d) => d.id === id);
export const homeOf = (L: Pick<Live, "diagrams">) => (L.diagrams.find((d) => d.kind === "loop") ?? L.diagrams[0])?.id ?? null;
export const home = () => homeOf(M);
export const parentOfDiagram = (id: string) => M.diagrams.find((d) => d.nodes.some((n) => n.detail === id));

// ---- what is changing ----------------------------------------------------

class Changes {
  items = $derived(new Set(M.changedItems));
  files = $derived(new Set(M.changedFiles));
  touched = $derived(new Set(M.live?.touched ?? []));
  modules = $derived(new Map(M.modules.map((m) => [m.id, m])));
  // Review mode: what the branch changes against its target, committed or not.
  rItems = $derived(new Set(M.review?.changedItems ?? []));
  rFiles = $derived(new Set(M.review?.changedFiles ?? []));
  rImpacted = $derived(new Set(M.review?.impacted ?? []));
}
export const C = new Changes();

export function statusOf(path: string): "A" | "D" | "M" | null {
  const s = S.status.find((x) => x.path === path);
  if (!s) return null;
  return s.x === "?" || s.x === "A" ? "A" : s.x === "D" || s.y === "D" ? "D" : "M";
}
// Where a diagram link points: a module ("crate/mod") or an item in it ("crate/mod::Type::fn").
export function where(a: string) {
  const [mod] = a.split("::"), m = C.modules.get(mod);
  if (!m) return null;
  const it = a.includes("::") ? m.items.find((i) => i.key === a) : null;
  return { file: m.file, line: it?.line, end: it?.end };
}
// A link changed if its own lines did: a whole module when the file changed, an item (or any
// method of a type) when lines inside it changed.
export function anchorChanged(a: string, files = C.files, items = C.items) {
  const w = where(a);
  if (!w) return false;
  if (!a.includes("::")) return files.has(w.file);
  if (items.has(a)) return true;
  for (const k of items) if (k.startsWith(a + "::")) return true;
  return false;
}
// What's changing on a box: uncommitted (unc), being edited by the agent (live), and in review
// mode changed by the branch (rev), new in the branch's diagrams (added), or using code the
// branch changed (imp: what the change impacts).
export function nodeState(n: DiagramNode, diagram?: string) {
  const hit = (n.anchors ?? []).filter((a) => anchorChanged(a));
  const r = M.review, rd = r && diagram ? r.diagrams[diagram] : null;
  return {
    unc: hit.length > 0, live: !!M.live && hit.some((a) => C.touched.has(where(a)?.file ?? "")),
    rev: !!r && (n.anchors ?? []).some((a) => anchorChanged(a, C.rFiles, C.rItems)),
    added: !!rd && !rd.isNew && rd.added.includes(n.id),
    imp: !!r && (n.anchors ?? []).some((a) => C.rImpacted.has(a.split("::")[0])),
  };
}
// What changes touch in a diagram, outside a review: boxes whose code is uncommitted, and whether
// the agent is editing one now (for the diagram list and its button).
export function diagramChanges(d: { id: string; nodes: DiagramNode[] }) {
  let n = 0, live = false;
  for (const x of d.nodes) { const s = nodeState(x, d.id); if (s.unc) n++; if (s.live) live = true; }
  return { n, live };
}
// How many boxes of a diagram the review changes (for the diagram list).
export function reviewCount(d: { id: string; nodes: DiagramNode[] }) {
  if (!M.review) return 0;
  return d.nodes.filter((n) => { const s = nodeState(n, d.id); return s.rev || s.added; }).length;
}
// "Explain the changes": asks the chat's agent what the review (or, outside one, the uncommitted
// edits) changes in a box's code, with where that code is and the git command that shows it.
export function explainChanges(n: DiagramNode, diagram?: string) {
  const r = M.review, parts = (n.anchors ?? []).map((a) => { const w = where(a); return w ? `- ${a} (${w.file}${w.line ? ":" + w.line + (w.end ? "-" + w.end : "") : ""})` : `- ${a}`; });
  const files = filesOfNode(n).join(" "), git = mp().prefix ? `git -C ${M.root}` : "git";
  const what = r?.base
    ? `I'm reviewing ${r.mr ? `merge request ${r.mr.ref} "${r.mr.title}" (${r.branch})` : r.branch} against ${r.target}. The diff starts at ${r.base}: \`${git} diff ${r.base} -- ${files}\` (uncommitted edits included).`
    : `These are uncommitted changes: \`${git} diff HEAD -- ${files}\`.`;
  const proj = mp().prefix ? ` of the project ${mp().name} (${M.root})` : "";
  const text = `${what}\n\nIn the diagram "${nameOf(byId(diagram))}"${proj}, the box "${n.label}" (${n.explain}) is this code:\n${parts.join("\n")}\n\n` +
    `Explain what changed in that code only: what it did before, what it does now, why it likely changed, and anything that looks wrong, risky or worth a second look. Point to the lines. Don't change the code.`;
  api.post("api/chat/send", { text });
  showChat();
}
export const filesOfNode = (n: DiagramNode) => [...new Set((n.anchors ?? []).map(where).filter((w) => !!w).map((w) => w!.file))];

// ---- what is open ----------------------------------------------------------

type Insp = "about" | "features" | "tests" | "problems" | null;
export type Side = "files" | "git" | "project";
const saved = (): Tab[] => {
  try { return (JSON.parse(store.get("cockpit-tabs-" + S.project, "[]")) as Tab[]).filter((t) => t && (t.kind === "file" || t.kind === "commit" || t.kind === "diff" || t.kind === "guardrails")); } catch { return []; }
};
const sideTab = store.get("cockpit-tab", "files");

export const ui = $state({
  side: (sideTab === "git" || sideTab === "project" ? sideTab : "files") as Side,
  tabs: [{ kind: "map", id: homeOf(S), code: null } as Tab, ...saved()],
  active: Math.max(0, +store.get("cockpit-active-" + S.project, "0") || 0),
  picked: null as string | null, // the box clicked on the map
  insp: null as Insp, // the section open in the sidebar's project tab
  right: store.get("cockpit-right-open", "1") === "1", // the chat panel is shown: Ctrl+L
  zooming: false, // a zoom animation is running
  help: store.get("cockpit-help", "0") === "1", // F1: show the how-to hints (legend, breadcrumb, details)
});
export function toggleHelp() { ui.help = !ui.help; store.set("cockpit-help", ui.help ? "1" : "0"); }
ui.active = Math.min(ui.active, ui.tabs.length - 1);

export const cur = () => ui.tabs[ui.active];
export const mapTab = () => ui.tabs[0] as Extract<Tab, { kind: "map" }>;

export function saveTabs() {
  store.set("cockpit-tabs-" + S.project, JSON.stringify(ui.tabs.slice(1).map((t) => (t.kind === "file" ? { kind: "file", path: t.path } : t))));
  store.set("cockpit-active-" + S.project, String(ui.active));
}

const sameTab = (a: Tab, b: Tab) => a.kind === b.kind && (a.kind === "file" ? a.path === (b as any).path : a.kind === "commit" ? a.sha === (b as any).sha && a.project === (b as any).project
  : a.kind === "diff" ? a.path === (b as any).path && a.staged === (b as any).staged : true);
// A tab's key and label, for the tab bar and the address.
export const tabKey = (t: Tab) => (t.kind === "map" ? "map" : t.kind === "guardrails" ? "guardrails" : t.kind === "file" ? "f:" + t.path : t.kind === "commit" ? "c:" + (t.project ? t.project + ":" : "") + t.sha : (t.staged ? "s:" : "d:") + t.path);
// Open (or focus) a tab next to the current one. Old file tabs make room past 14.
export function openTab(spec: Tab) {
  let i = ui.tabs.findIndex((t) => sameTab(t, spec));
  if (i < 0) {
    i = Math.min(ui.active + 1, ui.tabs.length);
    ui.tabs.splice(i, 0, spec);
    if (ui.tabs.length > 14) { const drop = ui.tabs.findIndex((t, k) => k !== i && t.kind !== "map"); if (drop >= 0) { ui.tabs.splice(drop, 1); if (drop < i) i--; } }
  } else Object.assign(ui.tabs[i], spec);
  ui.active = i;
  if (spec.kind === "file") revealFile(spec.path);
  saveTabs();
}
// `at` makes a repeat request for the same line scroll there again.
export const openFile = (path: string, line?: number, end?: number) => openTab({ kind: "file", path, line, end, at: line ? Date.now() : undefined });
// `project`: a commit of another project of the workspace (projects.svelte.ts).
export const openCommit = (sha: string, project?: string) => openTab({ kind: "commit", sha, ...(project ? { project } : {}) });
export const openGuardrails = () => openTab({ kind: "guardrails" });
// A changed file's diff: staged (index against HEAD) or not (working tree against the index).
export const openDiff = (path: string, staged: boolean) => openTab({ kind: "diff", path, staged });
// Files with unsaved changes in the editor (FileEditor.svelte keeps the buffers).
export const dirtyFiles = new SvelteSet<string>();

export function closeTab(i: number) {
  if (i === 0) return; // the map stays
  const t = ui.tabs[i];
  if (t?.kind === "file" && dirtyFiles.has(t.path)) {
    if (!confirm(`${t.path} has unsaved changes. Close it and lose them?`)) return;
    dirtyFiles.delete(t.path); // the editor drops the buffer when it sees it's no longer dirty
  }
  ui.tabs.splice(i, 1);
  if (i < ui.active || ui.active >= ui.tabs.length) ui.active = Math.max(0, ui.active - 1);
  saveTabs();
}
// Going to a diagram moves the map there; `project` names the workspace's project it is in (by
// default the one the map shows now).
export function openDiagram(id: string, node?: string, project?: string) {
  const t = mapTab();
  if (project !== undefined) t.project = project === S.project ? undefined : project;
  t.id = id; t.code = null; ui.active = 0;
  ui.picked = node ?? null;
  saveTabs();
}
export function showChat() { setRight(true); }
export function setRight(open: boolean) { ui.right = open; store.set("cockpit-right-open", open ? "1" : "0"); }
// Ctrl+L, like Cursor: open the chat with the cursor in the message box, or close the panel.
// Ctrl+L: open the chat and go to it; when it's open but you're elsewhere (the terminal, the
// editor), go to it; close it only when you're in it already. A button (`plain`) just shows or hides it.
export function toggleChat(plain = false) {
  const inside = (document.activeElement as HTMLElement | null)?.closest?.("#right");
  if (ui.right && (plain || inside)) {
    if (inside) (document.activeElement as HTMLElement).blur();
    setRight(false);
  } else {
    showChat();
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#composer textarea")?.focus());
  }
}
// The sidebar's project tab, with one of its sections open (features, tests, problems).
export function showProject(which: Insp = null) { ui.side = "project"; if (which) ui.insp = which; }

// ---- the files tree: which folders are open -------------------------------------
// Folders with changes, and the folders of the file you open, open by themselves until you open
// or close them yourself; "collapse all" closes everything.

let folderSaved: Record<string, boolean> = {};
try { folderSaved = JSON.parse(store.get("cockpit-folders-" + S.project, "{}")); } catch {}
export const folders: Record<string, boolean> = $state(folderSaved);
const saveFolders = () => store.set("cockpit-folders-" + S.project, JSON.stringify(folders));
export function setFolder(dir: string, open: boolean) { folders[dir] = open; saveFolders(); }
export function revealFile(path: string) {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) folders[parts.slice(0, i).join("/") + "/"] = true;
  saveFolders();
}
export function collapseAll(dirs: string[]) { for (const d of dirs) folders[d] = false; saveFolders(); }
