# cockpit

A control center for software written with AI agents. The agents keep a description of the
project in its repo (`.cockpit/`: features and a few diagrams of how the code works); cockpit
shows it live, with what is changing right now projected onto it, next to the files, git,
terminals and the agent chat. You lead at whatever depth you choose and can always go one level
deeper: diagram → detail diagram → the code of one box.

## Run it

```sh
npm install
npm run build                               # the page (web/ → web/dist)
npm run serve -- ~/Projects/slipangle       # http://127.0.0.1:4173
npm run serve -- ~/Projects/slipangle --host 0.0.0.0   # reachable from your network, no login
```

Desktop app (Linux), a Tauri 2 window around the same server:

```sh
desktop/install.sh            # once: needs webkit2gtk4.1-devel libsoup3-devel gtk3-devel librsvg2-devel
cockpit ~/Projects/slipangle  # or open "cockpit" from the app menu (reopens the last project)
cockpit --pick                # choose another project ("Open project…" on the launcher icon)
```

It starts the server on a free port, shows the page, and stops the server when the window
closes. Everything is bundled, so it works offline. The plan is to move the server to Rust piece
by piece, and the UI later once it stops changing.

Working on the page: `npm run dev:web` rebuilds it on every change; reload to see it.

## What's on the page

- **Map** (first tab): the agents' diagrams. Hover a box for what it is, click it for details,
  double-click (or scroll in) to go into its detail diagram or its code; Esc, scrolling out or the
  breadcrumb comes back up. Drag boxes to arrange them; the arrangement is saved in
  `.cockpit/layout.json`. Boxes whose code changed (not committed) are dashed amber; boxes the
  agent is editing glow.
- **Files**: open a file and its uncommitted changes show in place, like an editor: a green bar
  by added lines, blue by changed ones, a red mark where lines were removed (click it to see
  them, or tick "show removed"). ↑ ↓ jump between changes. A small diagram floats over the code
  and lights up the boxes whose code is on screen.
- **Git**: branch, what isn't committed, and the history of all branches as a graph; a commit
  opens as its patch.
- **Header**: lines, tests and features at a glance; each opens what's behind it on the right.
- **Terminals** (Ctrl+`): real shells in the project. The agent can read them. Ctrl+K asks for a
  command in words and puts it on the prompt, never runs it.
- **Chat**: an agent cockpit runs itself (below).

Links: `?file=path&line=n`, `?commit=sha`, `?tab=git`, `?panel=features|tests`, `?at=diagram&box=node`.

## Agent chat

Cockpit runs Claude Code through the Claude Agent SDK, on your Claude Code login (no API key),
with your user and project settings. Auto mode decides what it may do; when it wants you, an
Allow/Deny card shows in the chat. Model picker (haiku/sonnet/opus) and a stop button.

- **Conversations** are Claude Code sessions: the title at the top lists this project's sessions,
  including ones started in a terminal, and reopens any of them. "new" starts another; the old one
  stays in the list. Cockpit keeps its own view of each in `out/<project>/chats/`.
- **Meters** under the message box: how full this conversation's context is, and how much of your
  plan's 5-hour and weekly limits you've used (the numbers behind `/usage`; it reads them through
  an experimental SDK call, and hides them if that stops working).
- While the agent works, turns are recorded (`out/<project>/turns/`) so its files light up live.
- When it stops, the `.cockpit/` check runs against the live code index; if the description no
  longer matches the code, the agent is sent back to fix it (up to 3 times), with the likely
  right link for each wrong one. On a project without `.cockpit/`, "Describe this project" starts
  it from `templates/cockpit-README.md`.

A Claude Code session outside cockpit can be recorded too, with hooks in the project's
`.claude/settings.local.json` that call `src/hook.ts start|tool|stop`.

## The project's description (`.cockpit/`)

Written and kept true by the agents, never by hand (the brief they follow is
`.cockpit/README.md`, copied from `templates/cockpit-README.md`):

- `project.json`: a summary and the features, each with a status (working, partial, broken,
  planned), the modules it lives in, and a note on what's missing.
- `diagrams/<id>.json`: at most 5 diagrams, each answering one question where a picture beats two
  sentences. Kinds: loop, pipeline, dataflow, zones. Every box links to code ("crate/module" or
  "crate/module::Type::fn"), and has a short tldr.
- `layout.json`: where you placed the boxes (written by cockpit).

`npm run check-arch -- <project dir>` checks it against the code by hand.

## How it works

- `src/serve.ts`: the server. It watches the project's folders and git, works out the page's state
  (diagrams, features, tests, git, what changed down to the function), and pushes only the parts
  that changed over server-sent events.
- `src/codeindex.ts`: rust-analyzer's SCIP index of the working copy, read into crates, modules
  and items (`src/skeleton.ts`); rebuilt in the background when Rust files change.
- `src/arch.ts`: reads and checks `.cockpit/`.
- `src/chat.ts`, `src/term.ts`, `src/ask.ts`: the agent, the terminals, the ask line.
- `web/`: the page, in Svelte 5 + TypeScript, built with Vite. Diagrams are drawn with Cytoscape
  and updated in place, never torn down, so the view doesn't jump while things change.

## History

Earlier experiments (decision recaps, a generated module map, layered turn reviews, a generated
description, a feature board) shaped this and were removed once the one view replaced them; they
are in the git history before November 10, 2026.
