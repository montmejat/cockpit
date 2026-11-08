# cockpit

Experiments in how a human and AI agents work on software together. The human
leads at whatever depth they choose (purpose, system, module, code) and can
always go one level deeper.

## E1: decision recap

Turns a Claude Code session transcript into a recap you read top-down:
overview, then themes, then groups, then individual decisions, then the
transcript events behind each one.

```sh
npm install
npm run recap -- ~/.claude/projects/<project>/<session>.jsonl --title "..."
# writes out/<session>/recap.html (+ events/decisions/recap .json)
```

How it works:

1. `src/transcript.ts` condenses the JSONL into numbered events (prompts,
   agent messages, tool calls, failed tool results).
2. `src/recap.ts` makes two model calls: **extract** (events to decisions, in
   Y-statement form, each citing event ids) and **merge** (decisions to themes
   and groups). Code then checks that every decision appears exactly once.
3. `src/render.ts` writes one self-contained HTML page with a depth control and
   flag buttons (wrong / missing detail / useful) for judging the recap.

Model calls go through `claude -p` (your Claude Code login), use Haiku by
default, and are cached in `out/.cache/`, so a rerun with the same input is
free.

Levels follow the C4 model: purpose = context, system = containers,
module = components, code = code.

## E2: project map

A map of a Rust project. The structure comes from tools, the names and groups
come from the agent, and your corrections override both.

```sh
npm run map -- ~/Projects/slipangle            # writes out/slipangle/map.html (read-only)
npm run map -- ~/Projects/slipangle --serve    # http://127.0.0.1:4173, editable
npm run map -- ~/Projects/slipangle --serve --host 0.0.0.0   # reachable from your network, no login
```

- **Skeleton** (`src/skeleton.ts`): `cargo metadata` gives crates and their
  dependencies. A SCIP index from `rust-analyzer scip` gives modules, items,
  doc comments, libraries used, and reference counts between modules. It is
  rebuilt whenever a source file is newer than the index.
- **Agent layer** (`src/overlay.ts`): one Haiku call groups modules into
  components and writes a one-line role for each module.
- **Your corrections**: move a module, rename a component, or rewrite a
  description or role from the page. They are saved to
  `data/<project>/overrides.json` (versioned) and always beat the agent's
  proposal, including on future runs. Corrections that point to deleted
  modules show up as warnings.
- **Page** (`src/maprender.ts`): two zoom levels (System, Modules) with the
  same positions at both. Components that use others are placed higher.
  Click anything for details down to items and line numbers.

## E7: architecture.json, kept by the agents

The project repo holds `architecture.json`: groups of modules (never crossing
crates), a map layout, entry points, flows and data, each linked to code. The
agents working on the code keep it true (instructions in the project's
CLAUDE.md); cockpit only checks it:

- the Stop hook sends the agent back once if the file doesn't match the code;
- each turn shows "the agent's account" of what it changed in the file, next
  to what the code index says changed;
- `npm run check-arch -- <project dir>` runs the same check by hand.

In the work view, the "flows" tab lists entry points with the flows they
start, and the data. Selecting a flow draws it on the map as a numbered path
across the modules, with its entry points (▶) and data (◆) marked.

## E6: description from four angles

```sh
npm run describe -- ~/Projects/slipangle   # needs the map built first; writes out/<name>/description.json
```

One model call (Haiku by default, `--model sonnet` to compare) describes the
project from four angles that apply to any software, after the 4+1 views and
arc42: **capabilities** (what it does), **entry points** (how it's driven),
**flows** (what happens at run time, step by step) and **data** (what it holds,
what is saved). The fifth angle, structure, is the map. Every item and step
links to real symbols from the code index; code checks each link, repairs
near-misses, drops the rest, and reports how much of the code is reached.

In the work view, "description" shows it. A selected turn outlines what it
changed (solid = its code changed, dashed = through something it uses).
Clicking an item shows related items, and its code links open the source or
the diff.

On slipangle: 7 capabilities, 7 entry points, 5 flows, 9 data, 88 links all
real, 18/20 modules reached, $0.026.

## E5: work view (map + turns)

`npm run serve -- <project>` now opens on one page that merges the map and the
turns: turns on the left, the map in the middle, details on the right.

- Pick a turn: what it changed lights up on the map (green = new, amber =
  changed, blue = being edited right now); untouched parts fade. The map
  has one level: modules inside their groups. New or
  changed dependencies show as colored arrows.
- Click a component, then a module: the panel goes one level deeper each time,
  ending with that module's items and its own diff. Breadcrumbs go back up.
- "Just the map" shows the plain map. The old pages stay at `/turns` and `/map`.
- The URL keeps the turn and what you clicked (`?turn=…#m:game/sim`), so a
  view can be linked or reloaded.

## E4: agent turns, reviewed by layer

Use Claude Code as usual in a project; cockpit records each request ("turn")
and shows what changed at every layer.

```sh
npm run serve -- ~/Projects/slipangle                   # http://127.0.0.1:4173: work view at /, turns at /turns, map at /map
npm run serve -- ~/Projects/slipangle --host 0.0.0.0    # reachable from your network, no login
```

Setup: hooks in the project's `.claude/settings.local.json` (not committed)
call `src/hook.ts`:

- **UserPromptSubmit** (`start`): snapshots the working copy and opens a turn.
- **PostToolUse** on file edits (`tool`): records the file, for the live view.
- **Stop** (`stop`): snapshots again and starts `src/analyze.ts` in the background.

Snapshots (`src/snapshot.ts`) are commits built with a temporary index,
kept under `refs/cockpit/snap/*`. They include untracked files and never touch
your branch, index or files. Delete them anytime with
`git for-each-ref --format='%(refname)' refs/cockpit | xargs -n1 git update-ref -d`.

Each turn is shown in four layers:

| Layer | Shows | From |
|---|---|---|
| Purpose | your request, a short summary, decisions made | one Haiku call on the turn's transcript |
| System | components touched, dependencies that appeared/disappeared | code index before vs after, map components |
| Module | per module: functions, types, methods added / removed / changed | SCIP definition ranges vs diff lines |
| Code | the diff | git, rendered with diff2html |

The code index of each snapshot is built in a temporary worktree (sharing
`target/`), so it never races with the agent, and cached by tree hash.
Turns live in `out/<project>/turns/`.

## E8: the board (home page)

`/` is now a board of what the project does, feature by feature. Features come from a
`features` list in the repo's `architecture.json`, kept by the agents like the rest of the file
(status `working` / `partial` / `broken` / `planned`, the modules that make each one, its flows).

- Tiles are features, sized by their lines of code; big tiles show their modules inside.
  Color by status, by recent activity, or by tests per line.
- The timeline below has one column per commit (◆ = left exactly as an agent turn finished)
  and one lane per feature: dots are lines changed. Hover a column to see what it touched,
  click it (or use ← →) to see the board as of that commit, ▶ replays how the project grew.
- While an agent works, the features it is editing glow, live.
- Everything links into the work view (`/work`): modules, flows on the map, commits.

## E9: diagrams drawn by the agents

`/diagrams` shows the pictures the agents keep in the repo's `architecture.json` (`diagrams`).
Each one answers one question about how the code works. Kinds: `dataflow` (placed by what
depends on what), `pipeline` (a strict sequence), `zones` (what owns what, what crosses each
boundary). Nodes link to code and explain themselves on hover; `total` nodes are shared sums
several parts add into; `next` edges carry values into the next round (step, frame, request).

- `checkArch` checks kinds, links, edges and zones; the Stop hook sends the agent back if they're wrong.
- Turn analysis flags a diagram whose code changed while the diagram didn't.
- Boxes glow while an agent edits their code.
- The brief that tells agents what earns a diagram lives in the project's CLAUDE.md (see
  slipangle's "### diagrams"): one question per diagram, only where a picture beats two
  sentences, edges are what the code reads and writes, at most 5.

## One view (cleanup, 2026-11-08)

`npm run serve -- <project dir>` now serves a single page at `/`: the agents' diagrams in the
middle (a box with ⤢ opens its detail diagram beside it), files and git (with a commit graph) on
the left, the selected box on the right, and code or diffs in a drawer. Uncommitted changes and a
running agent are projected onto the diagram boxes down to the function: a box is marked only
when lines inside the code it links to changed. The board, work, map, turns and description
pages are gone from the UI (see git history); hooks still record turns in the background.
Links: `?tab=git`, `?file=path&line=n`, `?diff=path`, `?commit=sha`, `#diagram[,detail]`.
