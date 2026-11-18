# Guardrails

`.cockpit/guardrails.json` holds what keeps work on this project right without someone re-reading
every line: **checks** (commands that pass or fail) and **rules** (decisions about how the code is
written, each with why and where it is enforced). Cockpit shows them to the owner as layers, runs
the checks when you finish a turn that edited files, and sends you back if your turn broke a check
that passed before it.

```json
{
  "checks": [
    { "id": "types", "name": "Types", "run": "npm run -s check" },
    { "id": "boundaries", "name": "Module boundaries", "run": "node .cockpit/checks/boundaries.mjs", "timeout": 60 }
  ],
  "rules": [
    { "id": "ui-not-server", "rule": "web/ never imports from src/", "why": "the page is bundled for the browser; server code there pulls in node and breaks the build",
      "layer": "static", "checks": ["boundaries"], "since": "2026-11-18" }
  ]
}
```

## Layers, strongest first

- `design`: the code makes the wrong thing impossible: an API without the dangerous option, a
  type that can't hold a bad value, a module boundary. Name the check that proves it (usually the
  type check or the build).
- `static`: a check finds it without running the program: types, lint, tests, a small script.
- `verification`: a check runs the program and looks: drives the UI, takes screenshots,
  model-checks a flow.
- `prose`: only written down. An agent may not follow it. Every prose rule is a candidate to move up.

## When the owner corrects you

When the owner corrects how code is written (not a one-off choice), don't stop at fixing it:
1. Ask yourself whether it can be a check, or better, made impossible by design.
2. Propose the rule in `.cockpit/guardrails.json` with its `why`, at the strongest layer you can
   enforce, and the check if it needs a new one. Prefer the project's existing tools (its type
   checker, its linter, its test runner) run with the project's own config.
3. Say what you added in one line.

## Don't change the project's setup

Guardrails live in `.cockpit/` only. Don't add lint configs, scripts, dependencies, hooks or
instruction files to the project for them unless the owner asks for exactly that. A check that
needs its own script keeps it in `.cockpit/checks/`, using only what the project already has.
A check's error output should say what to do instead, so whoever hits it fixes the cause.

A check that already fails on code you didn't touch is shown to the owner, not blamed on you:
don't "fix" a check by weakening it. If a check is wrong, say so.
