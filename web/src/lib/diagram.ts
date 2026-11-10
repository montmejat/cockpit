// Drawing the agents' diagrams with Cytoscape. A diagram is built once per container and then
// updated in place: when only what's changing moves, boxes are restyled; when the diagram itself
// changes, boxes are added, removed or relabeled without tearing the view down.

import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import dagre from "cytoscape-dagre";
import type { Diagram } from "./types";
import { byId, nodeState } from "./state.svelte";

cytoscape.use(dagre);

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const PAL = ["#2b7bd6", "#d9622b", "#2a9d6f", "#a35bd1", "#c79a1c", "#d1477a", "#3a9fb5", "#7a8a2a"];

// Classes for what's changing right now: dashed amber when its code changed, glowing while the
// agent edits it.
const stateClasses = (d: Diagram, id: string) => {
  const n = d.nodes.find((x) => x.id === id);
  if (!n) return { unc: false, live: false };
  return nodeState(n);
};

export function elements(d: Diagram): ElementDefinition[] {
  const els: ElementDefinition[] = [];
  for (const n of d.nodes) {
    const ns = nodeState(n);
    const cls = [n.zone ? "zone" : n.outside ? "outside" : "part", n.focus && "focus", n.total && "total", n.carries && "carries",
      (n.start || n.end) && "terminal", n.detail && byId(n.detail) && "zoomable", ns.live && "live", ns.unc && "unc"].filter(Boolean).join(" ");
    els.push({ data: { id: n.id, label: n.label + (n.detail && byId(n.detail) ? "  ⤢" : ""), parent: n.in }, classes: cls });
  }
  // Labels where they can't collide: by the source if it's the only edge leaving it, else by
  // the target if it's the only one arriving, else in the middle. Dataflow arrows take the
  // color of the box they leave, so each can be followed by eye.
  const flows = d.edges.filter((e) => !e.next), outN = (id: string) => flows.filter((e) => e.from === id).length, inN = (id: string) => flows.filter((e) => e.to === id).length;
  const srcs = [...new Set(d.edges.map((e) => e.from))], df = d.kind === "dataflow";
  d.edges.forEach((e, i) => els.push({
    data: { id: "e" + i, source: e.from, target: e.to, label: e.next ? "↻ " + e.label : e.label,
      pos: df || e.next ? "mid" : outN(e.from) === 1 ? "src" : inN(e.to) === 1 ? "tgt" : "mid", c: df ? PAL[srcs.indexOf(e.from) % PAL.length] : "" },
    classes: (e.next ? "edge next" : "edge") + (df ? " colored" : ""),
  }));
  // Reads and writes of a carried state go to many boxes: faint until a box is hovered.
  const carried = new Set(d.nodes.filter((n) => n.carries).map((n) => n.id));
  if (d.kind === "loop") {
    const first = d.nodes.find((n) => !n.zone && !n.outside && !n.carries && !n.start && !n.end)?.id;
    for (const el of els) if (el.data.source && (carried.has(el.data.source) || carried.has(el.data.target!) || (el.classes!.includes("next") && el.data.target !== first))) el.classes += " aux";
  } else if (df) for (const el of els) if (el.data.source && carried.has(el.data.source) && !el.classes!.includes("next")) el.classes += " aux";
  // Loops and pipelines read in node order: invisible links keep that order top to bottom.
  if (d.kind === "pipeline" || d.kind === "loop") {
    const steps = d.nodes.filter((n) => !n.zone && !n.outside && !(d.kind === "loop" && n.carries));
    for (let i = 1; i < steps.length; i++)
      if (!d.edges.some((e) => !e.next && e.from === steps[i - 1].id && e.to === steps[i].id))
        els.push({ data: { id: "o" + i, source: steps[i - 1].id, target: steps[i].id }, classes: "order" });
  }
  if (d.kind === "pipeline" || d.kind === "loop") for (const el of els) if (el.data.source && !el.classes!.includes("next")) el.classes += " flow";
  return els;
}

export function style(): any[] {
  const ink = css("--fg"), soft = css("--muted"), panel = css("--card"), line = css("--line"), sig = css("--hot"), data = css("--accent"), warn = css("--warn");
  const font = "JetBrains Mono, monospace";
  return [
    { selector: "node", style: { shape: "round-rectangle", label: "data(label)", "font-family": font, "font-size": 13, color: ink,
      "text-wrap": "wrap", "text-max-width": 160, "text-valign": "center", "text-halign": "center", width: "label", height: "label", padding: 12,
      "background-color": panel, "border-width": 1.3, "border-color": ink, "transition-property": "border-color, border-width, background-color, underlay-opacity", "transition-duration": 250 } },
    { selector: "node.zone", style: { "text-valign": "top", "text-margin-y": -6, "font-weight": 700, "border-style": "dashed", "border-color": soft, "background-opacity": 0.35, "background-color": line, padding: 22 } },
    { selector: "node.outside", style: { "border-width": 0, "background-opacity": 0, color: soft, "font-style": "italic" } },
    { selector: "node.terminal", style: { shape: "ellipse", "background-color": ink, color: panel, "border-width": 0, padding: 14, "font-weight": 700 } },
    { selector: "node.carries", style: { shape: "cut-rectangle", "border-style": "dashed", "border-color": data, "border-width": 2, color: data, "background-color": data, "background-opacity": 0.06 } },
    { selector: "node.total", style: { shape: "barrel", "background-color": data, "background-opacity": 0.12, "border-color": data, "border-width": 2, "font-weight": 700 } },
    { selector: "node.zoomable", style: { "border-style": "double", "border-width": 5 } },
    { selector: "node.focus", style: { "border-color": sig, "border-width": 2.4, "background-color": sig, "background-opacity": 0.12, "font-weight": 700 } },
    { selector: "node.unc", style: { "border-style": "dashed", "border-color": warn, "border-width": 2.4 } },
    { selector: "node.live", style: { "border-color": sig, "border-width": 3, "underlay-color": sig, "underlay-opacity": 0.3, "underlay-padding": 9 } },
    { selector: "node.picked", style: { "border-color": data, "border-width": 3 } },
    { selector: "node.infile", style: { "border-color": data, "border-width": 2, "background-color": data, "background-opacity": 0.07 } },
    { selector: "node.inview", style: { "border-color": data, "border-width": 3.5, "background-opacity": 0.18, "underlay-color": data, "underlay-opacity": 0.22, "underlay-padding": 8 } },
    { selector: "edge", style: { width: 1.4, "line-color": soft, "target-arrow-color": soft, "target-arrow-shape": "triangle", "arrow-scale": 0.9,
      "curve-style": "bezier", label: "data(label)", "font-family": font, "font-size": 11.5, color: data,
      "text-background-color": panel, "text-background-opacity": 1, "text-background-padding": 2, "text-wrap": "wrap", "text-max-width": 130 } },
    { selector: "edge.flow", style: { "curve-style": "taxi", "taxi-direction": "downward", "taxi-turn": "70%", "taxi-turn-min-distance": 14 } },
    { selector: 'edge.flow[pos="src"]', style: { label: "", "source-label": "data(label)", "source-text-offset": 30 } },
    { selector: 'edge.flow[pos="tgt"]', style: { label: "", "target-label": "data(label)", "target-text-offset": 30 } },
    { selector: "edge.order", style: { visibility: "hidden" } },
    { selector: "edge.next", style: { "line-style": "dashed", "line-dash-pattern": [6, 4], "curve-style": "unbundled-bezier", "control-point-distances": [240], "control-point-weights": [0.5],
      color: data, "line-color": data, "target-arrow-color": data, "font-weight": 700 } },
    { selector: "edge.colored", style: { "line-color": "data(c)", "target-arrow-color": "data(c)", color: "data(c)", width: 1.8, "curve-style": "bezier", "control-point-step-size": 60 } },
    { selector: "edge.aux", style: { opacity: 0.12, label: "", "source-label": "", "target-label": "" } },
    { selector: "edge.aux.hl", style: { opacity: 1, label: "data(label)" } },
    { selector: "edge.hl", style: { "line-color": data, "target-arrow-color": data, width: 2.4 } },
    { selector: ".faded", style: { opacity: 0.2 } },
  ];
}

export function legend(cy: Core) {
  const has = (sel: string) => cy.$(sel).nonempty(), items: { cls: string; text: string }[] = [];
  const sw = (cls: string, text: string) => items.push({ cls, text });
  if (has("node.terminal")) sw("terminal", "start / end");
  if (has("node.focus")) sw("focus", "what this diagram is about");
  if (has("node.carries")) sw("carries", "kept for the next round");
  if (has("node.total")) sw("total", "shared total, many parts add in");
  if (has("node.zoomable")) sw("zoomable", "⤢ double-click to go in");
  if (has("edge.next")) sw("next", "↻ used in the next round");
  if (has("node.unc")) sw("unc", "its code changed, not committed");
  if (has("node.live")) sw("live", "the agent is changing it now");
  return items;
}

// Fit a diagram to its pane, but never bigger than life size: labels stay the size of the text
// around them, and a small diagram sits centered instead of blown up.
export function fitCapped(cy: Core, pad = 30) {
  cy.fit(undefined, pad);
  if (cy.zoom() > 1) { cy.zoom(1); cy.center(); }
}

function layout(cy: Core, d: Diagram, positions?: Record<string, { x: number; y: number }>) {
  const df = d.kind === "dataflow";
  cy.elements().not(".next").layout({ name: "dagre", rankDir: "TB", nodeSep: df ? 110 : 60, rankSep: df ? 130 : 50, edgeSep: df ? 40 : 20, padding: 24 } as any).run();
  if (d.kind === "loop") { // the carried state sits beside the loop, not in it
    const bb = cy.nodes().not(".carries").boundingBox({});
    cy.nodes(".carries").forEach((n, i) => { n.position({ x: bb.x2 + 140, y: bb.y1 + bb.h / 2 + i * 70 }); });
  }
  if (positions) cy.nodes().forEach((n) => { if (positions[n.id()] && !n.isParent()) n.position(positions[n.id()]); });
}

// A diagram in a container. Refits when the container changes size, until you zoom or pan it.
export function buildCy(container: HTMLElement, d: Diagram, positions?: Record<string, { x: number; y: number }>) {
  // Draw at 2x or more: the library caches boxes and labels as bitmaps at a few zoom levels and
  // scales them in between, which looks blurry at 1x (and on fractional desktop scaling, where
  // the reported ratio is often rounded down). Diagrams are small, so the extra pixels are cheap.
  const cy = cytoscape({ container, elements: elements(d), wheelSensitivity: 0.2, minZoom: 0.2, maxZoom: 2.5, style: style(),
    pixelRatio: Math.max(2, window.devicePixelRatio || 1) });
  cy.scratch("_shape", shapeKey(d)); cy.scratch("_id", d.id);
  layout(cy, d, positions);
  fitCapped(cy);
  cy.scratch("_manual", false);
  const mark = () => cy.scratch("_manual", true);
  container.addEventListener("wheel", mark, { passive: true });
  cy.on("dragpan pinchzoom", mark);
  let t: ReturnType<typeof setTimeout>;
  const ro = new ResizeObserver(() => {
    clearTimeout(t);
    t = setTimeout(() => { if (cy.destroyed()) return ro.disconnect(); cy.resize(); if (!cy.scratch("_manual") && !cy.scratch("_hold")) fitCapped(cy); }, 80);
  });
  ro.observe(container);
  // The library remembers where its box is on screen: measure again whenever the mouse comes in.
  container.addEventListener("mouseenter", () => { if (!cy.destroyed()) cy.resize(); });
  cy.on("destroy", () => { ro.disconnect(); container.removeEventListener("wheel", mark); });
  return cy;
}

// What decides the layout: the boxes, their nesting and the arrows. Labels can change in place.
const shapeKey = (d: Diagram) => JSON.stringify([d.kind, d.nodes.map((n) => [n.id, n.in ?? "", !!n.carries, !!n.zone]), d.edges.map((e) => [e.from, e.to, !!e.next])]);

// Bring a drawn diagram up to date without tearing it down.
//   same diagram, same shape: relabel and restyle boxes in place
//   new diagram or new shape: swap the elements and lay them out again, in the same view
export function syncCy(cy: Core, d: Diagram, positions?: Record<string, { x: number; y: number }>) {
  const key = shapeKey(d);
  const els = elements(d);
  if (cy.scratch("_shape") === key && cy.scratch("_id") === d.id) {
    cy.batch(() => {
      for (const el of els) {
        const x = cy.getElementById(el.data.id!);
        if (x.empty()) continue;
        if (x.data("label") !== el.data.label) x.data("label", el.data.label);
        if (el.data.c !== undefined && x.data("c") !== el.data.c) x.data("c", el.data.c);
        // Classes the page adds on top (picked, in this file, on screen) stay.
        const keep = ["picked", "infile", "inview"].filter((c) => x.hasClass(c)).map((c) => " " + c).join("");
        const cls = (el.classes ?? "") + keep;
        if ((x.classes() as unknown as string[]).join(" ") !== cls.trim()) x.classes(cls);
      }
    });
    return false;
  }
  const changedDiagram = cy.scratch("_id") !== d.id;
  cy.scratch("_shape", key); cy.scratch("_id", d.id);
  cy.batch(() => { cy.elements().remove(); cy.add(els); });
  layout(cy, d, positions);
  if (changedDiagram) cy.scratch("_manual", false);
  if (!cy.scratch("_manual")) fitCapped(cy);
  return true;
}

// Only what's changing moved: toggle the live and changed classes.
export function restyle(cy: Core, d: Diagram) {
  cy.batch(() => {
    for (const n of d.nodes) {
      const ns = stateClasses(d, n.id), x = cy.getElementById(n.id);
      if (x.empty()) continue;
      x.toggleClass("live", ns.live).toggleClass("unc", ns.unc);
    }
  });
}

export function positionsOf(cy: Core) {
  const pos: Record<string, { x: number; y: number }> = {};
  cy.nodes().forEach((n) => { if (!n.isParent()) pos[n.id()] = { x: Math.round(n.position("x")), y: Math.round(n.position("y")) }; });
  return pos;
}

// Lay the boxes out again (after "reset layout") and fit.
export function relayout(cy: Core, d: Diagram, positions?: Record<string, { x: number; y: number }>) {
  layout(cy, d, positions);
  fitCapped(cy);
}
