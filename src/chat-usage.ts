// What the chat asks Claude Code besides conversations: a model's context window, and the plan's
// usage (the numbers behind /usage). Both are asked of a running session, or of a short-lived idle
// one: no message is sent, so they cost nothing.

import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

async function* never(): AsyncGenerator<SDKUserMessage> { await new Promise(() => {}); }

// `running`: a session already running, if any. `model`: the one picked.
export function createUsage(root: string, model: () => string, running: () => Query | null) {
  const idle = (m: string) => query({ prompt: never(), options: { cwd: root, model: m, settingSources: [] } });

  // Context windows by model, asked once each.
  const windows: Record<string, number> = {};
  async function windowOf(m: string) {
    if (windows[m]) return windows[m];
    const probe = idle(m);
    try { const c = await probe.getContextUsage({ detail: "summary" }); return (windows[m] = c.maxTokens); }
    catch { return 0; } finally { probe.close(); }
  }

  // Plan usage, cached for a minute (forget(): it changed, read it fresh next time).
  let last: { at: number; data: unknown } | null = null;
  async function usage() {
    if (last && Date.now() - last.at < 60_000) return last.data;
    let probe: Query | null = null;
    try {
      const src = running() ?? (probe = idle(model()));
      const u = await src.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      const w = (x: any) => (x && x.utilization != null ? { pct: x.utilization, resets: x.resets_at } : null);
      const r = u.rate_limits;
      const data = u.rate_limits_available && r ? {
        plan: u.subscription_type,
        windows: [
          { name: "5 hours", ...w(r.five_hour) },
          { name: "week", ...w(r.seven_day) },
          ...(r.seven_day_opus ? [{ name: "week · opus", ...w(r.seven_day_opus) }] : []),
          ...(r.seven_day_sonnet ? [{ name: "week · sonnet", ...w(r.seven_day_sonnet) }] : []),
          ...(r.model_scoped ?? []).filter((m) => m.utilization).map((m) => ({ name: "week · " + m.display_name.toLowerCase(), ...w(m) })),
        ].filter((x: any) => x.pct != null),
      } : { plan: u.subscription_type, windows: [] };
      last = { at: Date.now(), data };
      return data;
    } catch (e: any) {
      return { error: String(e?.message ?? e), windows: [] };
    } finally {
      probe?.close();
    }
  }

  return { windowOf, usage, forget() { last = null; } };
}
