// Cockpit's HTTP servers are made by gatedServer() (src/http.ts) only, so no route or WebSocket
// can be served before the token gate. Fails on any other HTTP server or upgrade handler in src/.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const files = readdirSync(join(root, "src"), { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && e.name.endsWith(".ts")).map((e) => relative(root, join(e.parentPath, e.name)));

const bad = [];
for (const f of files) {
  if (f === "src/http.ts") continue;
  readFileSync(join(root, f), "utf8").split("\n").forEach((line, i) => {
    const at = `${f}:${i + 1}`;
    if (/from\s+["']node:https?["']/.test(line) && /\bcreateServer\b/.test(line)) bad.push(`${at}: imports createServer from node:http. Make the server with gatedServer() from src/http.ts: it puts the token gate before every request and WebSocket.`);
    if (/\.on\(\s*["']upgrade["']/.test(line)) bad.push(`${at}: handles "upgrade" itself. Pass the WebSocket handler to gatedServer() (src/http.ts), which checks the token and origin first.`);
  });
}
if (bad.length) { console.log(bad.join("\n")); process.exit(1); }
console.log("every server is gated");
