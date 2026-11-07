// Analyzes one finished turn into layers: tsx src/analyze.ts <project> <turn id>
//   purpose  : what was asked and done, plus decisions (one Haiku call on the turn's transcript)
//   system   : components touched, dependencies between modules/components that changed
//   module   : per module, items (types, functions, methods) added, removed or changed
//   code     : the git diff
// Run by the Stop hook in the background. Also usable by hand to re-analyze.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { callClaude } from "./claude.ts";
import { applyOverrides, type Overlay, readOverrides } from "./overlay.ts";
import type { Skeleton } from "./skeleton.ts";
import { changedFiles, changedLines, patch, skeletonOf } from "./snapshot.ts";
import { eventsForPrompt, readTranscript } from "./transcript.ts";
import {
  type Analysis, COCKPIT, type DepChange, type ItemChange, loadTurn, type ModuleChange, outDir, PROTO, saveTurn,
  type TurnDecision,
} from "./turns.ts";

const MAX_PATCH = 300_000;

function placer(project: string, sk: Skeleton) {
  // Components come from the E2 map (agent proposal + your corrections), if one was built.
  const mapFile = join(outDir(project), "map.json");
  if (!existsSync(mapFile)) return { comp: (id: string) => id.split("/")[0], role: (_: string) => undefined };
  const overlay: Overlay = JSON.parse(readFileSync(mapFile, "utf8")).overlay;
  const model = applyOverrides(sk, overlay, readOverrides(join(COCKPIT, "data", project, "overrides.json")));
  const byModule = new Map<string, string>();
  for (const c of model.components) for (const m of c.modules) byModule.set(m, c.name);
  return { comp: (id: string) => byModule.get(id) ?? "Unplaced", role: (id: string) => model.roles[id]?.text };
}

function edgeMap(sk: Skeleton | null) {
  return new Map((sk?.edges ?? []).map((e) => [`${e.from}\u0000${e.to}`, e.refs]));
}

// Dependencies that appeared, disappeared, or changed a lot.
function depChanges(before: Map<string, number>, after: Map<string, number>): DepChange[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  const out: DepChange[] = [];
  for (const k of keys) {
    const b = before.get(k) ?? 0, a = after.get(k) ?? 0;
    const big = Math.abs(a - b) >= Math.max(3, 0.5 * Math.max(a, b));
    if ((b === 0) !== (a === 0) || big) {
      const [from, to] = k.split("\u0000");
      out.push({ from, to, before: b, after: a });
    }
  }
  return out.sort((x, y) => Math.abs(y.after - y.before) - Math.abs(x.after - x.before));
}

function moduleChanges(
  repo: string, before: string, after: string, skB: Skeleton, skA: Skeleton, changedPaths: Set<string>,
  comp: (id: string) => string, role: (id: string) => string | undefined,
): ModuleChange[] {
  const lines = changedLines(repo, before, after);
  const mB = new Map(skB.modules.map((m) => [m.id, m]));
  const mA = new Map(skA.modules.map((m) => [m.id, m]));
  const out: ModuleChange[] = [];
  for (const id of new Set([...mB.keys(), ...mA.keys()])) {
    const b = mB.get(id), a = mA.get(id);
    const file = (a ?? b)!.file;
    if (!changedPaths.has(file) && !(b && changedPaths.has(b.file))) continue;
    const key = (i: { owner?: string; name: string; kind: string }) => `${i.owner ? i.owner + "::" : ""}${i.name}|${i.kind}`;
    const iB = new Map((b?.items ?? []).map((i) => [key(i), i]));
    const iA = new Map((a?.items ?? []).map((i) => [key(i), i]));
    const ch = lines.get(file) ?? { old: [], new: [] };
    const hit = (ls: number[], s: number, e: number) => ls.some((l) => l >= s && l <= e);
    const items: ItemChange[] = [];
    for (const [k, i] of iA) {
      const name = k.split("|")[0];
      const old = iB.get(k);
      if (!old) items.push({ name, kind: i.kind, change: "added", line: i.line });
      else if (hit(ch.new, i.line, i.end) || hit(ch.old, old.line, old.end))
        items.push({ name, kind: i.kind, change: "changed", line: i.line });
    }
    for (const [k, i] of iB)
      if (!iA.has(k)) items.push({ name: k.split("|")[0], kind: i.kind, change: "removed", line: i.line });
    items.sort((x, y) => x.line - y.line);
    out.push({
      id,
      component: comp(id),
      file,
      status: !b ? "added" : !a ? "removed" : "changed",
      linesBefore: b?.lines ?? 0,
      linesAfter: a?.lines ?? 0,
      items,
      role: role(id),
    });
  }
  return out;
}

const str = { type: "string" };
const obj = (properties: Record<string, object>) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});
const schema = obj({
  summary: str,
  decisions: {
    type: "array",
    items: obj({
      title: str, chose: str, over: { type: "array", items: str }, because: str,
      level: { type: "string", enum: ["purpose", "system", "module", "code"] },
      area: str, decided_by: { type: "string", enum: ["user", "agent"] },
    }),
  },
});

const SYSTEM = `You summarize one turn of a coding session: the user's request and what the AI agent did until it stopped.

Output:
- summary: 1-3 sentences, plain words: what was asked, what was done, anything left open or failed.
- decisions: design or technical choices the agent or user made in this turn (libraries, data formats, algorithms, structure, scope, workarounds). Not routine steps, and not trivial edits (comments, formatting, placement, wording): those have no decisions. Often 0-5, and 0 is common. Only what the events show: never list an alternative the events don't mention; if none are visible, use [] and "not stated".
- level: purpose (scope), system (crates, boundaries, major dependencies), module (one module's design), code (local details).
- decided_by is "user" only if the user made or approved that specific choice.
Be terse.`;

function main() {
  const [project, id] = process.argv.slice(2);
  const t = loadTurn(project, id);
  try {
    if (!t.after) throw new Error("turn has no end snapshot");
    const files = changedFiles(t.repo, t.before, t.after);
    const changedPaths = new Set(files.flatMap((f) => [f.path, f.oldPath ?? f.path]));

    // Purpose and decisions, from this turn's slice of the transcript.
    const events = t.transcript ? readTranscript(t.transcript, t.transcriptFrom, t.transcriptTo) : [];
    const fileList = files.map((f) => `${f.status} ${f.path} (+${f.added} -${f.removed})`).join("\n") || "(no files changed)";
    const res = callClaude<{ summary: string; decisions: TurnDecision[] }>({
      system: SYSTEM,
      prompt: `User request:\n${t.prompt}\n\nFiles changed:\n${fileList}\n\nTurn events:\n\n${eventsForPrompt(events)}`,
      schema,
      cacheDir: join(COCKPIT, "out", ".cache"),
    });

    // Structure before and after, only if Rust code or manifests changed.
    let modules: ModuleChange[] = [], deps: DepChange[] = [], componentDeps: DepChange[] = [], components: string[] = [];
    if (files.some((f) => /\.rs$|Cargo\.toml$/.test(f.path))) {
      const cache = join(outDir(project), "skeletons");
      const skB = skeletonOf(t.repo, t.before, cache, PROTO);
      const skA = skeletonOf(t.repo, t.after, cache, PROTO);
      const { comp, role } = placer(project, skA);
      modules = moduleChanges(t.repo, t.before, t.after, skB, skA, changedPaths, comp, role);
      deps = depChanges(edgeMap(skB), edgeMap(skA));
      const agg = (sk: Skeleton) => {
        const m = new Map<string, number>();
        for (const e of sk.edges) {
          const a = comp(e.from), b = comp(e.to);
          if (a !== b) m.set(`${a}\u0000${b}`, (m.get(`${a}\u0000${b}`) ?? 0) + e.refs);
        }
        return m;
      };
      componentDeps = depChanges(agg(skB), agg(skA));
      components = [...new Set(modules.map((m) => m.component))];
    }

    const p = patch(t.repo, t.before, t.after);
    const analysis: Analysis = {
      files,
      summary: res.output.summary,
      decisions: res.output.decisions,
      components,
      modules,
      deps,
      componentDeps,
      patch: p.slice(0, MAX_PATCH),
      patchTruncated: p.length > MAX_PATCH,
      costUsd: res.costUsd,
    };
    Object.assign(t, { analysis, status: "done", error: undefined });
  } catch (e) {
    Object.assign(t, { status: "error", error: String(e).slice(0, 2000) });
  }
  saveTurn(t);
}

main();
