// Cockpit's own confirmation (ui/Confirm.svelte, shown once by App.svelte), only for what a click
// would lose for good, like unsaved edits. Everything else acts in one click (guardrail one-click),
// and the browser's confirm() is never used.
type Ask = { text: string; yes: string; done: (ok: boolean) => void };
export const asking = $state<{ q: Ask | null }>({ q: null });

export function confirmLoss(text: string, yes: string): Promise<boolean> {
  asking.q?.done(false); // a newer question replaces one still open
  return new Promise((res) => {
    const q: Ask = { text, yes, done: (ok) => { if (asking.q === q) asking.q = null; res(ok); } };
    asking.q = q;
  });
}
