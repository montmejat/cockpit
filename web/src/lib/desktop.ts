// Matching the desktop (GNOME): its accent color, and its window buttons (which, on which side).
// The server reads them from gsettings (src/serve.ts, desktopLook).

import { desktopInfo } from "./state.svelte";

// libadwaita's accent colors.
const ACCENTS: Record<string, string> = {
  blue: "#3584e4", teal: "#2190a4", green: "#3a944a", yellow: "#c88800", orange: "#ed5b00",
  red: "#e62d42", pink: "#d56199", purple: "#9141ac", slate: "#6f8396",
};
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c: number[]) => "#" + c.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
const mix = (a: string, b: string, t: number) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };

// The accent as text and lines (darker on light, lighter on dark) and as the selection; plain hex,
// since the diagrams and the terminal read them too. Blue is app.css's own.
export function applyAccent() {
  const name = desktopInfo?.accent ?? "blue", base = ACCENTS[name];
  if (!base || name === "blue") return;
  const light = `--accent:${mix(base, "#000000", 0.2)};--sel:${mix(base, "#ffffff", 0.84)}`;
  const dark = `--accent:${mix(base, "#ffffff", 0.4)};--sel:${mix(base, "#1d1d20", 0.72)}`;
  const st = document.createElement("style");
  st.textContent = `:root{${light}}@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${dark}}}:root[data-theme="dark"]{${dark}}`;
  document.head.append(st);
}

// The window buttons, from GNOME's button-layout ("appmenu:close", "close,minimize:" ...):
// those left of the colon go on the left, the others on the right. Not GNOME: all three, right.
export type WinButton = "minimize" | "maximize" | "close";
export function windowButtons(): { left: WinButton[]; right: WinButton[] } {
  const layout = desktopInfo?.buttons ?? ":minimize,maximize,close";
  const [l = "", r = ""] = layout.split(":");
  const pick = (s: string) => s.split(",").filter((b): b is WinButton => b === "minimize" || b === "maximize" || b === "close");
  return { left: pick(l), right: pick(r) };
}
