// What you have open in cockpit, said to the agent with your message, so "this", "here" or "that
// function" need no path: the file (the lines on screen, the selection), the diff, the commit, or
// the diagram (and the box picked on it). The chat shows it as a chip over the message box and
// sends it when it changed since the last message (Chat.svelte).

import { byId, cur, looking, mp, ui } from "./state.svelte";
import { projectNamed, split } from "./projects.svelte";

export type Viewing = { key: string; label: string; text: string };

const INTRO = "What the user has open in cockpit as they write this message. It is context, not a request: it says what words like \"this\", \"here\" or \"that function\" refer to.\n";
const base = (p: string) => p.split("/").pop() ?? p;
// A page path ("@name/path" for another project's file) as the agent can open it.
function fileOf(pagePath: string) {
  const at = split(pagePath);
  return { file: at.p.path ? at.p.path.replace(/\/$/, "") + "/" + at.path : at.path, project: at.p.name, rel: at.path };
}

export function viewing(): Viewing | null {
  const t = cur();
  if (!t) return null;
  if (t.kind === "file") {
    const f = fileOf(t.path), mine = looking.path === t.path;
    const sel = mine ? looking.sel : null, lo = mine ? looking.lo : 0, hi = mine ? looking.hi : 0;
    const span = (a: number, b: number) => (a === b ? `${a}` : `${a}-${b}`);
    const label = sel ? `selection in ${base(f.rel)}:${span(sel.from, sel.to)}` : `${base(f.rel)}${hi ? ":" + span(lo, hi) : ""}`;
    let text = `${INTRO}The file ${f.file} (project ${f.project})${hi ? `, lines ${lo}-${hi} on screen` : ""}`;
    text += sel ? `, with ${sel.from === sel.to ? `line ${sel.from}` : `lines ${sel.from}-${sel.to}`} selected:\n\`\`\`\n${sel.text}\n\`\`\`` : ".";
    return { key: "f:" + label, label, text };
  }
  if (t.kind === "diff") {
    const f = fileOf(t.path);
    return { key: `d:${t.staged}:${t.path}`, label: `changes of ${base(f.rel)}`, text: `${INTRO}The ${t.staged ? "staged" : "unstaged"} changes of ${f.file} (project ${f.project}).` };
  }
  if (t.kind === "commit") {
    const p = projectNamed(t.project);
    return { key: `c:${p.name}:${t.sha}`, label: `commit ${t.sha.slice(0, 8)}`, text: `${INTRO}Commit ${t.sha} of project ${p.name} (${p.path}).` };
  }
  if (t.kind === "guardrails") return { key: "g", label: "guardrails", text: `${INTRO}cockpit's guardrails page (.cockpit/guardrails.json).` };
  // the map: the diagram shown, and the box picked or zoomed into
  const d = byId(t.id);
  if (!d) return null;
  const p = mp(), root = projectNamed(t.project).path.replace(/\/$/, "");
  const boxId = t.code ?? ui.picked, n = boxId ? d.nodes.find((x) => x.id === boxId) : undefined;
  let text = `${INTRO}The diagram "${d.id}" of project ${p.name} (${root}/.cockpit/diagrams/${d.id}.json): ${d.tldr || d.question}`;
  if (n) text += `\nThe box "${n.label}" (id ${n.id}) is ${t.code ? "zoomed into, its code shown" : "picked"}: ${n.tldr || n.explain}${n.anchors?.length ? `\nIts code: ${n.anchors.join(", ")}` : ""}`;
  const label = `diagram ${d.id}${n ? " › " + n.label : ""}`;
  return { key: `m:${p.name}:${label}`, label, text };
}
