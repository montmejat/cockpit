// A screenshot of the page, so an agent can look at a UI change before calling it done.
//   npm run -s shot -- [project dir] [--query "file=src/ask.ts"] [--out /tmp/cockpit-shot.png] [--size 1400x900] [--dark]
//                      [--key Control+Backquote] [--click "css selector"] [--hover "css selector"]
//                      [--type "text"] [--wait 500] [--clip "css selector"] [--zoom 2]
//                      [--press "css selector"] [--move 60] [--release]
// The steps (--key, --click, --hover, --type, --wait, --press, --move, --release) run in the order given, after the page has
// settled. --clip crops the picture to one element (--zoom scales it, to see borders and shadows).
// It starts its own server (a free port, its own state and config folders, so the owner's server,
// history and settings are untouched) and drives a headless Firefox through puppeteer-core.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import puppeteer, { type KeyInput } from "puppeteer-core";

const args = process.argv.slice(2);
const flag = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const dir = resolve(args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? ".");
const out = resolve(flag("--out", join(tmpdir(), "cockpit-shot.png")));
const [w, h] = flag("--size", "1400x900").split("x").map(Number);
const zoom = +flag("--zoom", "1");
const firefox = process.env.COCKPIT_FIREFOX || "/usr/bin/firefox";

const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
const tmp = mkdtempSync(join(tmpdir(), "cockpit-shot-"));
const port = await freePort();
const root = resolve(import.meta.dirname, "..");
const server = spawn(process.execPath, ["--import", "tsx", join(root, "src/serve.ts"), dir, "--port", String(port)], {
  cwd: root, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, COCKPIT_STATE: join(tmp, "state"), XDG_CONFIG_HOME: join(tmp, "config"), XDG_DATA_HOME: join(tmp, "data"), COCKPIT_TOKEN: "" },
});
let log = "";
const link = await new Promise<string>((ok, no) => {
  const t = setTimeout(() => no(new Error("the server didn't start:\n" + log)), 60_000);
  const read = (b: Buffer) => { log += b; const m = log.match(/on (http:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1].replace(/\/\/[^:/]+:/, "//127.0.0.1:")); } };
  server.stdout.on("data", read); server.stderr.on("data", read);
  server.on("exit", () => no(new Error("the server stopped:\n" + log)));
});

const browser = await puppeteer.launch({ browser: "firefox", executablePath: firefox, headless: true, userDataDir: join(tmp, "profile"),
  extraPrefsFirefox: { "ui.systemUsesDarkTheme": args.includes("--dark") ? 1 : 0 } });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: zoom });
  await page.goto(link + (args.includes("--query") ? "&" + flag("--query", "") : ""), { waitUntil: "networkidle0", timeout: 60_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  let mouse = { x: 0, y: 0 };
  for (let i = 0; i < args.length; i++) {
    const v = args[i + 1];
    if (args[i] === "--key") {
      const keys = v.split("+") as KeyInput[];
      for (const k of keys.slice(0, -1)) await page.keyboard.down(k);
      await page.keyboard.press(keys.at(-1)!);
      for (const k of keys.slice(0, -1).reverse()) await page.keyboard.up(k);
    } else if (args[i] === "--click") await page.click(v);
    else if (args[i] === "--hover") await page.hover(v);
    else if (args[i] === "--type") await page.keyboard.type(v);
    else if (args[i] === "--wait") await new Promise((r) => setTimeout(r, +v));
    // a drag: --press holds the mouse down on an element's middle, --move drags it by that many
    // pixels down (up if negative) in small steps, --release lets go (leave it out to see mid-drag)
    else if (args[i] === "--press") {
      const b = await (await page.$(v))?.boundingBox();
      if (!b) throw new Error("no element " + v);
      mouse = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      await page.mouse.move(mouse.x, mouse.y); await page.mouse.down();
    } else if (args[i] === "--move") { mouse.y += +v; await page.mouse.move(mouse.x, mouse.y, { steps: 12 }); }
    else if (args[i] === "--release") await page.mouse.up();
    else continue;
    await new Promise((r) => setTimeout(r, 300));
  }
  const clip = args.includes("--clip") ? await page.$(flag("--clip", "")) : null;
  if (args.includes("--clip") && !clip) throw new Error("nothing matches " + flag("--clip", ""));
  await (clip ?? page).screenshot({ path: out as `${string}.png` });
  console.log(out);
} finally {
  await browser.close().catch(() => {});
  server.kill();
  rmSync(tmp, { recursive: true, force: true });
}
