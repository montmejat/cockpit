// The page's state: what the server pushes (S), what you have open (ui), and the questions every
// part asks of them (what changed, where a diagram link points).

import type { DiagramNode, Live, Tab, TermMeta } from "./types";

declare global { interface Window { INIT: Live & { terminals: TermMeta[] }; __TAURI__?: any } }

const boot = window.INIT;
export const initialTerminals: TermMeta[] = boot.terminals ?? [];

// Live data. The server sends it whole once, then only the parts that changed (src/serve.ts).
export const S: Live = $state(boot);

export function connectLive() {
  const es = new EventSource("api/events");
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    const parts = e.type === "full" ? e.state : e.patch;
    for (const k of Object.keys(parts)) (S as any)[k] = parts[k];
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
const saved = (): Tab[] => {
  try { return (JSON.parse(store.get("cockpit-tabs-" + S.project, "[]")) as Tab[]).filter((t) => t && (t.kind === "file" || t.kind === "commit")); } catch { return []; }
};
const sideTab = store.get("cockpit-tab", "files");

export const ui = $state({
  side: (sideTab === "git" ? "git" : "files") as "files" | "git",
  tabs: [{ kind: "map", id: home(), code: null } as Tab, ...saved()],
  active: Math.max(0, +store.get("cockpit-active-" + S.project, "0") || 0),
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
  store.set("cockpit-tabs-" + S.project, JSON.stringify(ui.tabs.slice(1).map((t) => (t.kind === "file" ? { kind: "file", path: t.path } : t))));
  store.set("cockpit-active-" + S.project, String(ui.active));
}

const sameTab = (a: Tab, b: Tab) => a.kind === b.kind && (a.kind === "file" ? a.path === (b as any).path : a.kind === "commit" ? a.sha === (b as any).sha : true);
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
export const openCommit = (sha: string) => openTab({ kind: "commit", sha });
export function closeTab(i: number) {
  if (i === 0) return; // the map stays
  ui.tabs.splice(i, 1);
  if (i < ui.active || ui.active >= ui.tabs.length) ui.active = Math.max(0, ui.active - 1);
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
