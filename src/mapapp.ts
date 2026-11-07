// The E2 map as a reusable piece: build it for a project, render it, save corrections.
// Generated files go to out/<name>/; corrections to data/<name>/overrides.json.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildSkeleton } from "./skeleton.ts";
import { applyOverrides, type Overrides, proposeOverlay, readOverrides } from "./overlay.ts";
import { renderMap } from "./maprender.ts";
import { COCKPIT, PROTO } from "./turns.ts";
import { archOverlay, readArch } from "./arch.ts";

// Reindex when any Rust source is newer than the index, so the skeleton never goes stale.
function newestSource(root: string): number {
  let newest = 0;
  for (const f of readdirSync(root, { recursive: true }) as string[]) {
    if (f.startsWith("target") || f.includes("/target/") || !(f.endsWith(".rs") || f.endsWith("Cargo.toml"))) continue;
    newest = Math.max(newest, statSync(join(root, f)).mtimeMs);
  }
  return newest;
}

export function createMapApp(root: string, name: string, log = console.log) {
  const outDir = join(COCKPIT, "out", name);
  const dataDir = join(COCKPIT, "data", name);
  const scip = join(outDir, "index.scip");
  const overridesPath = join(dataDir, "overrides.json");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const build = () => {
    if (!existsSync(scip) || statSync(scip).mtimeMs < newestSource(root)) {
      log("indexing with rust-analyzer…");
      execFileSync("rust-analyzer", ["scip", ".", "--output", resolve(scip)], { cwd: root, stdio: "ignore" });
    }
    const skeleton = buildSkeleton(root, scip, PROTO);
    log(`skeleton: ${skeleton.crates.length} crates, ${skeleton.modules.length} modules, ${skeleton.edges.length} edges`);
    // E7: the repo's own architecture.json wins over a summarizer's guess.
    const arch = readArch(root);
    if (arch) {
      log(`groups: ${arch.groups.length} from ${root}/architecture.json`);
      return { skeleton, overlay: archOverlay(arch), costUsd: 0, source: "repo" as const };
    }
    const ov = readOverrides(overridesPath);
    // The last grouping anchors the next one, so names don't drift between runs.
    const mapFile = join(outDir, "map.json");
    const previous = existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, "utf8")).overlay : undefined;
    const { overlay, costUsd, cached } = proposeOverlay(skeleton, ov, join(COCKPIT, "out", ".cache"), previous);
    log(`agent: ${overlay.components.length} components, $${costUsd.toFixed(4)}${cached ? " (cached)" : ""}`);
    return { skeleton, overlay, costUsd, source: "haiku" as const };
  };

  let state = build();
  let overrides = readOverrides(overridesPath);

  const render = () => {
    const model = applyOverrides(state.skeleton, state.overlay, overrides);
    const html = renderMap({ name, skeleton: state.skeleton, model, overrides, costUsd: state.costUsd });
    writeFileSync(join(outDir, "map.json"), JSON.stringify({ skeleton: state.skeleton, overlay: state.overlay, model }, null, 2));
    writeFileSync(join(outDir, "map.html"), html);
    return { model, html };
  };

  return {
    outDir,
    render,
    // Skeleton and grouping (with your corrections), for pages that draw the map themselves.
    data() {
      return { skeleton: state.skeleton, model: applyOverrides(state.skeleton, state.overlay, overrides), source: state.source };
    },
    rebuild() {
      state = build();
      return render();
    },
    save(next: Overrides) {
      if (typeof next !== "object" || next === null || Array.isArray(next)) throw new Error("expected an object");
      overrides = next;
      writeFileSync(overridesPath, JSON.stringify(overrides, null, 2) + "\n");
      return { model: render().model, overrides };
    },
  };
}
