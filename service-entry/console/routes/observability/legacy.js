// Before 04 exists: the Legacy statistics card (07 §6.7 degrade path). Its own
// module so the pages do not carry it; ObsPage loads it only when the entry
// has no telemetry.

import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useBootstrap } from "../../ui/shell.js";
import { Card } from "../../components/card.js";
import { StatTile } from "../../components/stat-tile.js";

const LEGACY_LINES = 2000;

/** One card from (E) `/api/gateway-access` and `/api/m/:id/stats`, each with the window it covers; no charts. */
export function LegacyStats() {
  const { api } = useServices();
  const { t } = useT();
  const fmt = useFormat();
  const managers = (Array.isArray(useBootstrap().managers) ? useBootstrap().managers : []).map((item) => item.id).filter(Boolean);
  const gateway = useQuery(["obs", "legacy", "gateway"], () => api.get("/api/gateway-access", { query: { maxLines: LEGACY_LINES, limit: 5 } }), { ttlMs: 20_000, refetchMs: 30_000 });
  const stats = useQuery(["obs", "legacy", "stats", managers.join(",")], async () => {
    const answers = await Promise.allSettled(managers.map((id) => api.get(`/api/m/${encodeURIComponent(id)}/stats`)));
    return answers.flatMap((answer, index) => (answer.status === "fulfilled" ? [{ managerId: managers[index], data: answer.value }] : []));
  }, { ttlMs: 20_000, refetchMs: 30_000, enabled: managers.length > 0 });
  const totals = gateway.data?.totals?.requests;
  const lines = t("obs.legacy.lines", { count: fmt.integer(LEGACY_LINES) });
  return html`<${Card} title=${t("obs.legacy.title")} testid="obs.legacy">
    <p class="muted small" data-testid="obs.legacy.note">${t("obs.legacy.note")}</p>
    <div class="obs-tiles">
      <${StatTile} label=${t("obs.kpi.requests")} value=${totals ? fmt.integer(totals.total) : null} window=${lines} testid="obs.legacy.requests" />
      <${StatTile} label=${t("obs.kpi.errorRate")} value=${totals && Number.isFinite(totals.errorRate) ? fmt.percent(totals.errorRate, 1) : null} window=${lines} testid="obs.legacy.errorRate" />
      ${(stats.data || []).map((entry) => {
        const speed = entry.data?.speed || {};
        const seconds = Number(speed.windowSeconds);
        const window = Number.isFinite(seconds) && seconds > 0 ? t("obs.live.lastSeconds", { seconds: fmt.integer(seconds) }) : t("obs.legacy.sinceStart");
        const value = Number(speed.recentOutputTokensPerSecond);
        return html`<${StatTile} key=${entry.managerId} label=${`${t("obs.live.tps")} · ${entry.managerId}`} value=${Number.isFinite(value) ? fmt.number(value, 1) : null}
          unit="tokens/s" window=${window} testid=${`obs.legacy.tps.${entry.managerId}`} />`;
      })}
    </div>
  <//>`;
}
