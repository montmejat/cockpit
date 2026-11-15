// Language servers for the editor: definitions, references, rename, format, hover, completion and
// diagnostics. One client per language, over a WebSocket to the cockpit server, which runs the
// server in the project folder (src/serve.ts). Started the first time a file of that language
// opens; a server that isn't installed leaves the editor as it is.
//   Keys: F12 / gd definition, Shift+F12 / gr references, F2 / <Space>rn rename,
//   Shift+Alt+F / <Space>f format.

import type { Extension, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { LSPClient, LSPPlugin, Workspace, languageServerExtensions, type Transport, type WorkspaceFile } from "@codemirror/lsp-client";

const ext = (path: string) => path.split(".").pop()?.toLowerCase() ?? "";
// Which language server, and the LSP language id, for a file.
export function serverOf(path: string): { server: string; id: string } | null {
  switch (ext(path)) {
    case "rs": return { server: "rust", id: "rust" };
    case "ts": case "mts": case "cts": return { server: "typescript", id: "typescript" };
    case "tsx": return { server: "typescript", id: "typescriptreact" };
    case "js": case "mjs": case "cjs": return { server: "typescript", id: "javascript" };
    case "jsx": return { server: "typescript", id: "javascriptreact" };
    case "py": return { server: "python", id: "python" };
    case "zig": return { server: "zig", id: "zig" };
    case "c": case "h": return { server: "c", id: "c" };
    case "cc": case "cpp": case "cxx": case "hh": case "hpp": case "hxx": return { server: "c", id: "cpp" };
    default: return null;
  }
}

export const fileUri = (root: string, path: string) => "file://" + encodeURI(root + "/" + path);
export const pathOfUri = (root: string, uri: string) => { const p = decodeURI(uri.replace(/^file:\/\//, "")); return p.startsWith(root + "/") ? p.slice(root.length + 1) : null; };

class File implements WorkspaceFile {
  constructor(public uri: string, public languageId: string, public version: number, public doc: Text, public view: EditorView) {}
  getView() { return this.view; }
}
// The default workspace's logic (one view per file), plus opening a cockpit tab when a jump goes
// to another file of the project. The page has one editor view: a file is open on the server
// while it's the one shown.
class CockpitWorkspace extends Workspace {
  files: File[] = [];
  private versions: Record<string, number> = Object.create(null);
  private next(uri: string) { return (this.versions[uri] = (this.versions[uri] ?? -1) + 1); }
  syncFiles() {
    const out = [];
    for (const file of this.files) {
      const plugin = LSPPlugin.get(file.view);
      if (!plugin) continue;
      const changes = plugin.unsyncedChanges;
      if (!changes.empty) {
        out.push({ changes, file, prevDoc: file.doc });
        file.doc = file.view.state.doc;
        file.version = this.next(file.uri);
        plugin.clear();
      }
    }
    return out;
  }
  openFile(uri: string, languageId: string, view: EditorView) {
    const old = this.getFile(uri);
    if (old) { this.files = this.files.filter((f) => f !== old); this.client.didClose(uri); }
    const file = new File(uri, languageId, this.next(uri), view.state.doc, view);
    this.files.push(file);
    this.client.didOpen(file);
  }
  closeFile(uri: string, view: EditorView) {
    const file = this.getFile(uri) as File | null;
    if (file && file.view === view) { this.files = this.files.filter((f) => f !== file); this.client.didClose(uri); }
  }
  displayFile(uri: string) { return display(uri); }
}
let display: (uri: string) => Promise<EditorView | null> = async () => null;
// How a jump to another file opens it (FileEditor sets this).
export const setDisplayFile = (fn: typeof display) => { display = fn; };

type Server = { client: LSPClient; ready: boolean; plugins: Map<string, Extension> };
const servers = new Map<string, Server>();
// Each language server's state, for the editor's header.
export const lspStatus: Record<string, "starting" | "ready" | "missing" | "down"> = $state({});
let onReady: (server: string) => void = () => {};
// Called when a server comes up or goes away: the file on screen reconnects.
export const onLsp = (fn: (server: string) => void) => { onReady = fn; };

function connect(name: string, s: Server) {
  const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/lsp?lang=" + name);
  const handlers = new Set<(v: string) => void>();
  const transport: Transport = {
    send(m) { if (ws.readyState !== WebSocket.OPEN) throw new Error("language server connection closed"); ws.send(m); },
    subscribe(h) { handlers.add(h); },
    unsubscribe(h) { handlers.delete(h); },
  };
  ws.onmessage = (e) => { for (const h of handlers) h(String(e.data)); };
  ws.onopen = () => {
    s.client.connect(transport);
    s.client.initializing.then(() => { s.ready = true; lspStatus[name] = "ready"; onReady(name); }, () => {});
  };
  ws.onclose = (e) => {
    const was = s.ready;
    s.ready = false;
    s.plugins.clear();
    if (s.client.connected) s.client.disconnect();
    if (e.code === 4404) { lspStatus[name] = "missing"; return; }
    lspStatus[name] = "down";
    if (was) onReady(name);
    setTimeout(() => connect(name, s), 5000);
  };
}

// The extension that connects a file's editor to its language server: [] until the server is up.
// The same extension object for the same file, so reconfiguring with it is a no-op.
export function lspFor(root: string | undefined, path: string): Extension {
  const which = serverOf(path);
  if (!which || !root) return [];
  let s = servers.get(which.server);
  if (!s) {
    const client = new LSPClient({ rootUri: "file://" + encodeURI(root), timeout: 10_000, extensions: languageServerExtensions(), workspace: (c) => new CockpitWorkspace(c) });
    s = { client, ready: false, plugins: new Map() };
    servers.set(which.server, s);
    lspStatus[which.server] = "starting";
    connect(which.server, s);
  }
  if (!s.ready) return [];
  const uri = fileUri(root, path);
  let p = s.plugins.get(uri);
  if (!p) s.plugins.set(uri, (p = s.client.plugin(uri, which.id)));
  return p;
}
