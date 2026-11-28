// The open merge requests of a project (src/mrs.ts, GET api/mrs), shared by the git panel's list
// and the Merge requests tab, and your order for them (kept per project in the page's storage).
// Asked for when first shown, then every two minutes while one of them is on screen.
import { api } from "./code";
import { store } from "./state.svelte";
import type { Tracker } from "./types";

export interface Mrs { t: Tracker | null; loading: boolean; order: string[] }
const all = new Map<string, Mrs>();
const key = (project: string) => "cockpit-mr-order-" + project;

export function mrsOf(base: string, project: string): Mrs {
  let x = all.get(base);
  if (!x) {
    let order: string[] = [];
    try { order = JSON.parse(store.get(key(project), "[]")); } catch {}
    const made: Mrs = $state({ t: null, loading: false, order });
    all.set(base, (x = made));
  }
  return x;
}

export async function loadMrs(base: string, project: string, fresh = false) {
  const x = mrsOf(base, project);
  if (x.loading) return;
  x.loading = true;
  try { x.t = await api.get<Tracker>(base + "api/mrs" + (fresh ? "?fresh=1" : "")); }
  catch (e) { x.t = { forge: null, me: null, list: x.t?.list ?? [], error: String(e), at: Date.now() }; }
  finally { x.loading = false; }
}

export function setOrder(base: string, project: string, order: string[]) {
  const x = mrsOf(base, project);
  x.order = order;
  store.set(key(project), JSON.stringify(order));
}
