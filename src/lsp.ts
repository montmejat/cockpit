import { spawn } from "node:child_process";
import type { WebSocket } from "ws";

// Language servers for the editor (web/src/lib/lsp.svelte.ts): one process per page connection,
// in the project folder, killed when the page goes. LSP frames (Content-Length headers) on the
// process side, one JSON message per WebSocket message on the page side. A missing server closes
// with 4404 and the editor carries on without it.
const LSP: Record<string, string[]> = {
  rust: ["rust-analyzer"],
  typescript: ["typescript-language-server", "--stdio"],
  python: ["pyright-langserver", "--stdio"],
  zig: ["zls"],
  c: ["clangd"],
};
export function createLsp(root: string) {
  const lspProcs = new Set<ReturnType<typeof spawn>>();
  function attach(ws: WebSocket, lang: string) {
    const cmd = LSP[lang];
    if (!cmd) { ws.close(4404, "no language server for " + lang); return; }
    const p = spawn(cmd[0], cmd.slice(1), { cwd: root, stdio: ["pipe", "pipe", "ignore"] });
    lspProcs.add(p);
    let buf = Buffer.alloc(0);
    p.stdout!.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const m = /content-length:\s*(\d+)/i.exec(buf.subarray(0, end).toString());
        if (!m) { buf = buf.subarray(end + 4); continue; }
        const len = +m[1];
        if (buf.length < end + 4 + len) return;
        const body = buf.subarray(end + 4, end + 4 + len).toString("utf8");
        buf = buf.subarray(end + 4 + len);
        if (ws.readyState === ws.OPEN) ws.send(body);
      }
    });
    p.on("error", () => { lspProcs.delete(p); ws.close(4404, cmd[0] + " not found"); });
    p.on("exit", () => { lspProcs.delete(p); if (ws.readyState === ws.OPEN) ws.close(4000, cmd[0] + " exited"); });
    p.stdin!.on("error", () => {});
    ws.on("message", (raw) => {
      const body = Buffer.from(String(raw), "utf8");
      if (p.stdin!.writable) p.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`), p.stdin!.write(body);
    });
    ws.on("close", () => { p.kill(); });
  }
  return { attach, killAll() { for (const p of lspProcs) p.kill(); } };
}
