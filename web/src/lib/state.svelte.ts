// The page's state: what the server pushes (S), what you have open (ui), and the questions every
// part asks of them (what changed, where a diagram link points).

import { SvelteSet } from "svelte/reactivity";
import type { DiagramNode, Live, Tab, TermMeta } from "./types";

type Boot = Live & { terminals: TermMeta[]; desktop?: Live["desktop"]; opened?: string; projects?: string[] };
declare global { interface Window { INIT: Boot; __TAURI__?: any } }

const boot = window.INIT;
export const initialTerminals: TermMeta[] = boot.terminals ?? [];
export const initialProject = boot.project; // the project the page first showed
// The server hosts the project it was opened on and the other projects of its workspace
// (src/serve.ts): the window shows one at a time (P.active) and switches between them, keeping
// every project's tabs, unsaved edits, terminals and chat.
export const opened = boot.opened ?? boot.project;
export const projectNames: string[] = boot.projects ?? [boot.project];
export const P = $state({ active: boot.project });
// A project's API, under /p/<name>/ (src/serve.ts), and its WebSockets.
export const apiUrl = (path: string, project = P.active) => "/p/" + encodeURIComponent(project) + "/" + path.replace(/^\//, "");
export const wsUrl = (path: string, project = P.active) => (location.protocol === "https:" ? "wss://" : "ws://") + location.host + apiUrl(path, project);
// A file of a project, as one key (unsaved edits, editor buffers).
export const fkey = (project: string, path: string) => project + "\u0000" + path;

// Live data. The server sends it whole once, then only the parts that changed (src/serve.ts).
// Each part is reactive as a whole and never deeply: parts are only ever replaced, and some are
// big (a large project's modules and tests are ~1 MB, sent again on every save as lines shift),
// so deep proxies made every push stall the page for ~170 ms.
function cell<T>(v: T) {
  let x = $state.raw(v);
  return { get: () => x, set: (n: T) => { x = n; } };
}
// Each project's parts, as cells; S reads the active project's.
const NOT_STATE = new Set(["terminals", "desktop", "opened", "projects"]);
const lives = new Map<string, Record<string, ReturnType<typeof cell<unknown>>>>();
function cellsOf(project: string, parts: Record<string, unknown>) {
  let c = lives.get(project);
  if (!c) lives.set(project, (c = {}));
  for (const [k, v] of Object.entries(parts)) if (!NOT_STATE.has(k)) { if (c[k]) c[k].set(v); else c[k] = cell(v); }
  return c;
}
cellsOf(boot.project, boot as unknown as Record<string, unknown>);
export const S: Live = (() => {
  const o = {} as Live;
  for (const k of Object.keys(boot).filter((k) => !NOT_STATE.has(k))) {
    Object.defineProperty(o, k, {
      get: () => lives.get(P.active)?.[k]?.get(),
      set: (v: unknown) => { const c = lives.get(P.active)!; if (c[k]) c[k].set(v); else c[k] = cell(v); },
      enumerable: true,
    });
  }
  return o;
})();
export const desktopInfo = boot.desktop;
// The projects whose state has arrived (the first one's came with the page).
export const loaded = new SvelteSet<string>([boot.project]);
// Any project's live state, read like S (for the files tree, which shows every project at once).
// Read it only once loaded.has(project); connectLive(project) gets it.
const views = new Map<string, Live>();
export function liveOf(project: string): Live {
  let v = views.get(project);
  if (!v) {
    v = {} as Live;
    for (const k of Object.keys(boot).filter((k) => !NOT_STATE.has(k)))
      Object.defineProperty(v, k, { get: () => (loaded.has(project) ? lives.get(project)?.[k]?.get() : undefined), enumerable: true });
    views.set(project, v);
  }
  return v;
}

// A list patched by key: changed and new entries replace or join, removed ones go; when the
// membership changed the server sends the new order of keys.
function merge<T>(list: T[], p: { set: T[]; del: string[]; keys?: string[] }, key: (x: T) => string): T[] {
  const by = new Map(list.map((x) => [key(x), x]));
  for (const k of p.del) by.delete(k);
  for (const x of p.set) by.set(key(x), x);
  return p.keys ? p.keys.map((k) => by.get(k)!).filter(Boolean) : list.filter((x) => by.has(key(x))).map((x) => by.get(key(x))!);
}

// Each project's live state, connected the first time it is wanted (the page's first project at
// once) and kept after that. All of them come on one event stream (src/serve.ts, /api/live), opened
// again when a project joins: a browser keeps only 6 connections to a server, and a stream per
// project would take them all. connectLive resolves once the project's state is in.
const wanted = new Map<string, { promise: Promise<void>; ready: () => void }>();
let stream: EventSource | null = null, reopen = false;
function openStream() {
  reopen = false;
  stream?.close();
  stream = new EventSource("/api/live?" + [...wanted.keys()].map((p) => "p=" + encodeURIComponent(p)).join("&"));
  stream.onmessage = (m) => { const e = JSON.parse(m.data); if (e.project) apply(e.project, e); };
  // EventSource reconnects by itself; the server starts again with each project's whole state.
}
export function connectLive(project = P.active): Promise<void> {
  let w = wanted.get(project);
  if (w) return w.promise;
  let ready!: () => void;
  wanted.set(project, (w = { promise: new Promise<void>((ok) => (ready = ok)), ready }));
  // Projects asked for together (the palette asks for all) join in one go.
  if (!reopen) { reopen = true; queueMicrotask(openStream); }
  return w.promise;
}
function apply(project: string, e: any) {
  const parts = e.type === "full" ? e.state : e.patch ?? {};
  const known = lives.get(project);
  // The whole state comes on (re)connecting, usually the same as the page's (it just loaded
  // with it): unchanged parts are left alone, so nothing is redrawn or fetched again for them.
  const fresh: Record<string, unknown> = {};
  for (const k of Object.keys(parts)) if (e.type !== "full" || !known?.[k] || JSON.stringify(known[k].get()) !== JSON.stringify(parts[k])) fresh[k] = parts[k];
  const cs = cellsOf(project, fresh);
  // Big lists come as their changed entries (src/project.ts, listPatch).
  const l = e.lists ?? {};
  const get = <T,>(k: string) => cs[k].get() as T;
  if (l.modules) cs.modules.set(merge(get<Live["modules"]>("modules"), l.modules, (m) => m.id));
  if (l["tests.unit"] || l["tests.integration"]) {
    const t = get<Live["tests"]>("tests");
    cs.tests.set({
      unit: l["tests.unit"] ? merge(t.unit, l["tests.unit"], (u) => u.module + "\0" + u.file) : t.unit,
      integration: l["tests.integration"] ? merge(t.integration, l["tests.integration"], (x) => x.file) : t.integration,
    });
  }
  if (e.type === "full") { loaded.add(project); wanted.get(project)?.ready(); }
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
export const byId = (id: string | null | undefined) => S.diagrams.find((d) => d.id === id);
export const home = () => (S.diagrams.find((d) => d.kind === "loop") ?? S.diagrams[0])?.id ?? null;
export const parentOfDiagram = (id: string) => S.diagrams.find((d) => d.nodes.some((n) => n.detail === id));

// ---- what is changing ----------------------------------------------------

class Changes {
  items = $derived(new Set(S.changedItems));
  files = $derived(new Set(S.changedFiles));
  touched = $derived(new Set(S.live?.touched ?? []));
  modules = $derived(new Map(S.modules.map((m) => [m.id, m])));
  // Review mode: what the branch changes against its target, committed or not.
  rItems = $derived(new Set(S.review?.changedItems ?? []));
  rFiles = $derived(new Set(S.review?.changedFiles ?? []));
}
export const C = new Changes();

export function statusOf(path: string, live: Live = S): "A" | "D" | "M" | null {
  const s = live.status?.find((x) => x.path === path);
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
// mode changed by the branch (rev) or new in the branch's diagrams (added).
export function nodeState(n: DiagramNode, diagram?: string) {
  const hit = (n.anchors ?? []).filter((a) => anchorChanged(a));
  const r = S.review, rd = r && diagram ? r.diagrams[diagram] : null;
  return {
    unc: hit.length > 0, live: !!S.live && hit.some((a) => C.touched.has(where(a)?.file ?? "")),
    rev: !!r && (n.anchors ?? []).some((a) => anchorChanged(a, C.rFiles, C.rItems)),
    added: !!rd && !rd.isNew && rd.added.includes(n.id),
  };
}
// How many boxes of a diagram the review changes (for the diagram list).
export function reviewCount(d: { id: string; nodes: DiagramNode[] }) {
  if (!S.review) return 0;
  return d.nodes.filter((n) => { const s = nodeState(n, d.id); return s.rev || s.added; }).length;
}
export const filesOfNode = (n: DiagramNode) => [...new Set((n.anchors ?? []).map(where).filter((w) => !!w).map((w) => w!.file))];

// ---- what is open ----------------------------------------------------------

type Insp = "features" | "tests" | "problems" | null;
// The window's tabs, of every project (kept under the project the server was opened on); a tab
// saved before tabs had a project is that one's.
const saved = (): Tab[] => {
  try {
    return (JSON.parse(store.get("cockpit-tabs-" + opened, "[]")) as Tab[])
      .filter((t) => t && (t.kind === "file" || t.kind === "commit" || t.kind === "diff") && projectNames.includes(t.project ?? opened))
      .map((t) => ({ ...t, project: (t as { project?: string }).project ?? opened }) as Tab);
  } catch { return []; }
};
const sideTab = store.get("cockpit-tab", "files");

export const ui = $state({
  side: (sideTab === "git" ? "git" : "files") as "files" | "git",
  tabs: [{ kind: "map", id: home(), code: null } as Tab, ...saved()],
  active: Math.max(0, +store.get("cockpit-active-" + opened, "0") || 0),
  picked: null as string | null, // the box clicked on the map
  insp: null as Insp, // the right panel shows features, tests or problems instead
  rtab: (store.get("cockpit-right", "chat") === "details" ? "details" : "chat") as "chat" | "details",
  right: store.get("cockpit-right-open", "1") === "1", // the right panel (chat, details) is shown: Ctrl+L
  zooming: false, // a zoom animation is running
  help: store.get("cockpit-help", "0") === "1", // F1: show the how-to hints (legend, breadcrumb, details)
});
export function toggleHelp() { ui.help = !ui.help; store.set("cockpit-help", ui.help ? "1" : "0"); }
ui.active = Math.min(ui.active, ui.tabs.length - 1);

export const cur = () => ui.tabs[ui.active];
export const mapTab = () => ui.tabs[0] as Extract<Tab, { kind: "map" }>;

export function saveTabs() {
  store.set("cockpit-tabs-" + opened, JSON.stringify(ui.tabs.slice(1).map((t) => (t.kind === "file" ? { kind: "file", project: t.project, path: t.path } : t))));
  store.set("cockpit-active-" + opened, String(ui.active));
}

// The project a tab belongs to: the map follows the window's project.
export const tabProject = (t: Tab | undefined) => (!t || t.kind === "map" ? P.active : t.project ?? opened);
// The tab to show first must be of the project shown first.
if (tabProject(ui.tabs[ui.active]) !== P.active) ui.active = 0;
const sameTab = (a: Tab, b: Tab) => a.kind === b.kind && tabProject(a) === tabProject(b) && (a.kind === "file" ? a.path === (b as any).path : a.kind === "commit" ? a.sha === (b as any).sha
  : a.kind === "diff" ? a.path === (b as any).path && a.staged === (b as any).staged : true);
// A tab's key and label, for the tab bar and the address.
export const tabKey = (t: Tab) => (t.kind === "map" ? "map" : tabProject(t) + ":" + (t.kind === "file" ? "f:" + t.path : t.kind === "commit" ? "c:" + t.sha : (t.staged ? "s:" : "d:") + t.path));
// Show a tab: the window switches to its project first.
export async function pickTab(i: number) {
  const t = ui.tabs[i];
  if (!t) return;
  await setActive(tabProject(t), t);
  ui.active = ui.tabs.indexOf(t); ui.picked = null;
  saveTabs();
}
// Open (or focus) a tab next to the current one, in the window's project unless it names
// another one: the tab goes in first, then the window switches to its project and shows it in one
// step (never the old tab under the new project). Old file tabs make room past 14.
export async function openTab(spec: Tab) {
  if (spec.kind !== "map") spec.project ??= P.active;
  let i = ui.tabs.findIndex((t) => sameTab(t, spec));
  if (i < 0) {
    i = Math.min(ui.active + 1, ui.tabs.length);
    ui.tabs.splice(i, 0, spec);
    if (ui.tabs.length > 14) { const drop = ui.tabs.findIndex((t, k) => k !== i && k !== ui.active && t.kind !== "map"); if (drop >= 0) { ui.tabs.splice(drop, 1); if (drop < i) i--; } }
  } else Object.assign(ui.tabs[i], spec);
  const t = ui.tabs[i];
  if (tabProject(t) !== P.active) await setActive(tabProject(t), t);
  ui.active = ui.tabs.indexOf(t);
  if (t.kind === "file") revealFile(tabProject(t), t.path);
  saveTabs();
}
// `at` makes a repeat request for the same line scroll there again.
export const openFile = (path: string, line?: number, end?: number) => openTab({ kind: "file", path, line, end, at: line ? Date.now() : undefined });
export const openCommit = (sha: string) => openTab({ kind: "commit", sha });
// A changed file's diff: staged (index against HEAD) or not (working tree against the index).
export const openDiff = (path: string, staged: boolean) => openTab({ kind: "diff", path, staged });
// Files with unsaved changes in the editor (FileEditor.svelte keeps the buffers), as fkey()s.
export const dirtyFiles = new SvelteSet<string>();

export function closeTab(i: number) {
  if (i === 0) return; // the map stays
  const t = ui.tabs[i];
  if (t?.kind === "file" && dirtyFiles.has(fkey(tabProject(t), t.path))) {
    if (!confirm(`${t.path} has unsaved changes. Close it and lose them?`)) return;
    dirtyFiles.delete(fkey(tabProject(t), t.path)); // the editor drops the buffer when it sees it's no longer dirty
  }
  ui.tabs.splice(i, 1);
  if (i < ui.active || ui.active >= ui.tabs.length) ui.active = Math.max(0, ui.active - 1);
  // The tab now shown may be another project's: the window follows it.
  if (tabProject(cur()) !== P.active) void pickTab(ui.active);
  saveTabs();
}
// Going to a diagram moves the map there.
export function openDiagram(id: string, node?: string) {
  const t = mapTab();
  t.id = id; t.code = null; ui.active = 0;
  ui.picked = node ?? null;
  saveTabs();
}
export function showRight(which: "chat" | "details") { ui.rtab = which; store.set("cockpit-right", which); setRight(true); }
export function setRight(open: boolean) { ui.right = open; store.set("cockpit-right-open", open ? "1" : "0"); }
// Ctrl+L, like Cursor: open the chat with the cursor in the message box, or close the panel.
export function toggleChat() {
  if (ui.right && ui.rtab === "chat") {
    if ((document.activeElement as HTMLElement | null)?.closest?.("#right")) (document.activeElement as HTMLElement).blur();
    setRight(false);
  } else {
    showRight("chat");
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#composer textarea")?.focus());
  }
}
export function toggleInsp(which: Exclude<Insp, null>) { ui.insp = ui.insp === which ? null : which; if (ui.insp) showRight("details"); }

// ---- the files tree: which folders are open -------------------------------------
// Folders with changes, and the folders of the file you open, open by themselves until you open
// or close them yourself; "collapse all" closes everything. Per project: in a workspace the tree
// shows every project, each under its own root, which you open and close too.

const savedFolders = (project: string): Record<string, boolean> => { try { return JSON.parse(store.get("cockpit-folders-" + project, "{}")); } catch { return {}; } };
// Each project's set is a reactive proxy, made the first time it is read (a plain Map: making
// one while the tree renders must not count as changing state).
const folderSets = new Map<string, Record<string, boolean>>();
const proxied = (o: Record<string, boolean>) => { const p = $state(o); return p; };
export function foldersOf(project: string): Record<string, boolean> {
  let f = folderSets.get(project);
  if (!f) folderSets.set(project, (f = proxied(savedFolders(project))));
  return f;
}
const saveFolders = (project: string) => store.set("cockpit-folders-" + project, JSON.stringify(foldersOf(project)));
export function setFolder(project: string, dir: string, open: boolean) { foldersOf(project)[dir] = open; saveFolders(project); }
export function revealFile(project: string, path: string) {
  const f = foldersOf(project), parts = path.split("/");
  for (let i = 1; i < parts.length; i++) f[parts.slice(0, i).join("/") + "/"] = true;
  saveFolders(project);
  if (!roots[project]) setRoot(project, true);
}
export function collapseAll(project: string, dirs: string[]) { const f = foldersOf(project); for (const d of dirs) f[d] = false; saveFolders(project); }
// Which projects' roots are open in the tree (the one the page opened on, at first).
const savedRoots = (): Record<string, boolean> => { try { return JSON.parse(store.get("cockpit-roots-" + opened, "null")) ?? { [boot.project]: true }; } catch { return { [boot.project]: true }; } };
export const roots: Record<string, boolean> = $state(savedRoots());
export function setRoot(project: string, open: boolean) {
  roots[project] = open;
  store.set("cockpit-roots-" + opened, JSON.stringify(roots));
  if (open) void connectLive(project);
}
for (const [p, open] of Object.entries(roots)) if (open && projectNames.includes(p) && p !== boot.project) void connectLive(p);

// ---- switching projects ------------------------------------------------------------
// The window shows another project of the workspace: its diagrams, files, git, chat and
// terminals. Tabs of every project stay open; the map goes back to where it was in that project.
const mapAt: Record<string, string | null> = {};
let switching: Promise<void> | null = null;
// `then`: the tab to show with it (picked, or about to be opened by the caller), so the window
// goes straight there instead of through the map.
export async function setActive(project: string, then?: Tab) {
  if (project === P.active || !projectNames.includes(project)) return;
  await (switching ?? Promise.resolve());
  await (switching = connectLive(project));
  switching = null;
  if (project === P.active) return;
  const m = mapTab();
  mapAt[P.active] = m.id;
  P.active = project;
  m.id = mapAt[project] ?? home(); m.code = null;
  ui.picked = null;
  if (then && ui.tabs.includes(then)) ui.active = ui.tabs.indexOf(then);
  else if (!then && tabProject(cur()) !== project) ui.active = 0;
  document.title = project + " · cockpit";
  saveTabs();
}
