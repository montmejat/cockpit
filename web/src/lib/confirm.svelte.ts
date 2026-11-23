// Cockpit's own confirmation (ui/Confirm.svelte, shown once by App.svelte), only for what a click
// would lose for good, like unsaved edits. Everything else acts in one click (guardrail one-click),
// and the browser's confirm() is never used.
type Ask = { n: number; text: string; yes: string; done: (ok: boolean) => void };
// The question is matched by its number: deep state hands back a proxy of it, never the object itself.
export const asking = $state<{ q: Ask | null }>({ q: null });
let seq = 0;

export function confirmLoss(text: string, yes: string): Promise<boolean> {
  asking.q?.done(false); // a newer question replaces one still open
  const n = ++seq;
  return new Promise((res) => {
    asking.q = { n, text, yes, done: (ok) => { if (asking.q?.n === n) asking.q = null; res(ok); } };
  });
}
