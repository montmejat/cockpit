import { execFile } from "node:child_process";

// Project search, for the page's Ctrl+Shift+F: ripgrep, at most ~500 hits.
export async function search(root: string, q: string, caseSensitive: boolean, regex: boolean) {
  if (!q) return [];
  const a = ["--json", "--max-count", "50", "--max-columns", "300", caseSensitive ? "--case-sensitive" : "--smart-case"];
  if (!regex) a.push("--fixed-strings");
  // exit 1 = no match: the output is used either way
  const out = await new Promise<string>((done) => { execFile("rg", [...a, "--", q, "."], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 }, (_e, o) => done(String(o ?? ""))).stdin?.end(); });
  const hits: { path: string; line: number; col: number; text: string }[] = [];
  for (const l of out.split("\n")) {
    if (hits.length >= 500) break;
    if (!l.startsWith('{"type":"match"')) continue;
    try {
      const d = JSON.parse(l).data, text: string = d.lines.text ?? "";
      const at = d.submatches?.[0]?.start ?? 0;
      hits.push({ path: String(d.path.text).replace(/^\.\//, ""), line: d.line_number, col: Buffer.from(text).subarray(0, at).toString().length + 1, text: text.replace(/\n$/, "") });
    } catch {}
  }
  return hits;
}

