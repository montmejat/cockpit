import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { outDir, turnsDir, type Turn } from "./turns.ts";

// The running agent turn, if any, and the files it touched so far. Only the turns sessions point
// to as current are read, not the whole history. A turn can stay open after its agent is gone
// (the server stopped mid-reply, a terminal closed), so one whose session hasn't written to its
// transcript for a while doesn't count. `chat`: it is cockpit's own chat, not a Claude Code
// session in a terminal.
const STALE_MS = 10 * 60_000;
export function liveTurn(root: string, name: string) {
  const d = turnsDir(name);
  if (!existsSync(d)) return null;
  let live: (Turn & { last: number }) | null = null;
  for (const f of readdirSync(d).filter((x) => x.startsWith(".current-"))) {
    try {
      const id = readFileSync(join(d, f), "utf8").trim();
      const t: Turn = JSON.parse(readFileSync(join(d, `${id}.json`), "utf8"));
      if (t.status !== "running") continue;
      let last = Date.parse(t.startedAt);
      try { last = Math.max(last, statSync(t.transcript).mtimeMs); } catch {}
      for (const x of t.touched) last = Math.max(last, Date.parse(x.at));
      if (Date.now() - last > STALE_MS) continue;
      if (!live || t.startedAt > live.startedAt) live = { ...t, last };
    } catch {}
  }
  if (!live) return null;
  return {
    id: live.id, prompt: live.prompt, startedAt: live.startedAt,
    chat: existsSync(join(outDir(name), "chats", `${live.session}.json`)),
    touched: [...new Set(live.touched.map((x) => (x.file.startsWith(root) ? x.file.slice(root.length + 1) : x.file)))],
  };
}
