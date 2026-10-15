// Steps 3 to 6 of the Public access wizard (05 §13.5): the generated files, the
// keys that may use the public address, the live checks with the external
// probe, and the exposure map. Everything here reads or writes through the
// 05 APIs; nothing starts or stops a service.

import { publicKeys, templateTopology, trustPatch } from "../../lib/exposure-model.js";
import { Button } from "../../components/button.js";
import { ChecksList } from "../../components/checks-list.js";
import { CodeBlock } from "../../components/code-block.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { EmptyState } from "../../components/empty-state.js";
import { ExposureMap } from "../../components/exposure-map.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";
import { accessError } from "./errors.js";
import { LazyView } from "./lazy.js";

// ---- step 3: generated files --------------------------------------------------

export function TemplatesStep({ topology, mode, baseUrl, needsBaseUrl, onWritten }) {
  const { api, i18n } = useServices();
  const { t } = useT();
  const kind = templateTopology(topology, mode);
  const blocked = needsBaseUrl && !baseUrl;
  const plan = useQuery(["access", "templates", kind, baseUrl], () => api.get("/api/public/templates", { query: { topology: kind } }), { ttlMs: 30_000, enabled: !blocked });
  const [state, setState] = useState({ busy: false, written: null, existing: null, error: null });
  const [overwriting, setOverwriting] = useState(false);
  const files = Array.isArray(plan.data?.files) ? plan.data.files : [];
  const commands = Array.isArray(plan.data?.commands) ? plan.data.commands : [];

  async function write(overwrite) {
    setState({ busy: true, written: null, existing: null, error: null });
    try {
      const answer = await api.post("/api/public/templates/write", { topology: kind, overwrite });
      setState({ busy: false, written: Array.isArray(answer?.written) ? answer.written : [], existing: null, error: null });
      onWritten?.();
    } catch (error) {
      const existing = error?.code === "template_exists" && Array.isArray(error.details?.existing) ? error.details.existing : null;
      setState({ busy: false, written: null, existing, error: existing ? null : accessError(error, i18n) });
    }
  }

  if (blocked) return html`<p class="notice notice-warn" data-testid="public.templates.blocked">${t("public.templates.needBase")}</p>`;
  return html`<div class="stack" data-testid="public.templates">
    <p>${t("public.intro.templates")}</p>
    ${plan.status === "error" && !plan.data ? html`<${EmptyState} icon="triangle-alert" title=${t("public.templates.failed")} body=${plan.error?.message || ""} action=${{ label: t("access.retry"), onClick: plan.refetch }} />` : html`
      ${files.length ? html`<section class="stack-sm"><h3 class="card-title">${t("public.templates.files")}</h3>
        ${files.map((file) => html`<details key=${file.name} class="pw-file" data-testid="public.templates.file">
          <summary class="mono">${file.name}</summary>
          <${CodeBlock} code=${file.content} language="text" testid="public.templates.content" />
        </details>`)}
      </section>` : plan.data ? html`<p class="muted" data-testid="public.templates.none">${t("public.templates.none")}</p>` : null}
      ${commands.length ? html`<section class="stack-sm"><h3 class="card-title">${t("public.templates.commands")}</h3>
        <${CodeBlock} code=${commands.join("\n")} language="powershell" testid="public.templates.commands" />
      </section>` : null}
      ${files.length ? html`<div class="row">
        <${Button} variant="primary" busy=${state.busy} onClick=${() => write(false)} testid="public.templates.write">${t("public.templates.write")}<//>
        <span class="small muted">${t("public.templates.where")}</span>
      </div>` : null}`}
    ${state.written ? html`<p class="notice notice-success" role="status" data-testid="public.templates.written">${t("public.templates.written", { files: state.written.join(", ") || "-" })}</p>` : null}
    ${state.existing ? html`<div class="notice notice-warn stack-sm" role="alert" data-testid="public.templates.exists">
      <span>${t("public.templates.exists", { files: state.existing.join(", ") })}</span>
      <div><${Button} size="sm" onClick=${() => setOverwriting(true)} testid="public.templates.overwrite">${t("public.templates.overwrite")}<//></div>
    </div>` : null}
    ${state.error ? html`<p class="notice notice-danger" role="alert" data-testid="public.templates.error">${state.error}</p>` : null}
    ${overwriting ? html`<${ConfirmDialog} open tone="danger" title=${t("public.templates.overwriteTitle")} body=${t("public.templates.overwriteBody")}
      details=${(state.existing || []).map(String)} confirmLabel=${t("public.templates.overwrite")} testid="public.templates.overwrite-dialog"
      onConfirm=${() => write(true)} onClose=${() => setOverwriting(false)} />` : null}
  </div>`;
}

// ---- step 4: keys -------------------------------------------------------------

export function KeysStep({ keys, loading, failed }) {
  const { cache } = useServices();
  const { t } = useT();
  const [drawer, setDrawer] = useState(false);
  const [share, setShare] = useState(null);
  const usable = publicKeys(keys);
  return html`<div class="stack" data-testid="public.keys">
    <p>${t("public.intro.keys")}</p>
    ${loading ? html`<p class="muted" aria-busy="true">${t("public.keys.loading")}</p>` : failed ? html`<p class="notice notice-danger" role="alert">${t("public.keys.failed")}</p>` : usable.length
      ? html`<div class="stack-sm" data-testid="public.keys.ok">
        <p class="notice notice-success" role="status">${t("public.keys.ok", { count: usable.length })}</p>
        <ul class="small">${usable.slice(0, 5).map((key) => html`<li key=${key.id} data-user-content>${key.name}</li>`)}</ul>
      </div>`
      : html`<p class="notice notice-warn" role="status" data-testid="public.keys.none">${t("public.keys.none")}</p>`}
    <div class="row">
      <${Button} variant=${usable.length ? "default" : "primary"} icon="key-round" onClick=${() => setDrawer(true)} testid="public.keys.create">${t("public.keys.create")}<//>
      <a href="/access/keys" data-testid="public.keys.manage">${t("public.keys.manage")}</a>
    </div>
    ${drawer ? html`<${LazyView} load=${() => import("./key-drawer.js")} name="KeyDrawer" mode="create" initial=${{ preset: "friend" }} onClose=${() => setDrawer(false)}
      onSaved=${(result) => {
        setDrawer(false);
        cache.invalidate(["access"]);
        if (result.kind === "create") setShare(result);
      }} />` : null}
    ${share ? html`<${LazyView} load=${() => import("../../components/share-card.js")} name="ShareCard" data=${share} onClose=${() => setShare(null)} />` : null}
  </div>`;
}

// ---- step 5: live checks --------------------------------------------------------

function ProbeResult({ probe }) {
  const { t } = useT();
  const fmt = useFormat();
  const seen = probe.nonceObserved === true;
  return html`<section class="card-flat stack-sm" aria-labelledby="public-probe-title" data-testid="public.probe">
    <h3 id="public-probe-title" class="card-title">${t("public.probe.title")}</h3>
    <${StatusBadge} status=${probe.error ? "error" : seen ? "ok" : "warn"} label=${probe.error ? t("public.probe.failed") : seen ? t("public.probe.seen") : t("public.probe.notSeen")} />
    <dl class="kv">
      <dt>${t("public.probe.url")}</dt><dd class="mono" data-user-content>${probe.url}</dd>
      <dt>${t("public.probe.status")}</dt><dd>${probe.status ?? "-"}${typeof probe.latencyMs === "number" ? ` · ${fmt.duration(probe.latencyMs)}` : ""}</dd>
      <dt>${t("public.probe.proxy")}</dt><dd>${probe.observed?.viaProxy ? t("public.probe.yes") : t("public.probe.no")}${probe.observed?.headerUsed ? ` (${probe.observed.headerUsed})` : ""}</dd>
      <dt>${t("public.probe.socket")}</dt><dd class="mono" data-testid="public.probe.socket">${probe.observed?.socketIp || "-"}${probe.observed?.country ? ` · ${probe.observed.country}` : ""}</dd>
      ${probe.tls?.validTo ? html`<dt>${t("public.probe.tls")}</dt><dd>${fmt.dateTime(probe.tls.validTo, { style: "date" })}</dd>` : null}
      ${probe.error ? html`<dt>${t("public.probe.error")}</dt><dd class="mono" data-user-content>${probe.error.code || probe.error.message || ""}</dd>` : null}
    </dl>
  </section>`;
}

export function ChecksStep({ query, settings }) {
  const { api, cache, i18n } = useServices();
  const { t } = useT();
  const [scanning, setScanning] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState(null);
  const [failure, setFailure] = useState(null);
  const [trust, setTrust] = useState(null);
  const report = query.data?.report || null;
  const fmt = useFormat();
  const unavailable = query.error?.code === "exposure_unavailable" || query.error?.status === 503;

  async function rescan() {
    setScanning(true);
    setFailure(null);
    try {
      cache.set(["access", "exposure"], await api.post("/api/public/exposure/scan", {}));
    } catch (error) {
      setFailure(accessError(error, i18n));
    } finally {
      setScanning(false);
    }
  }

  async function runProbe() {
    setProbing(true);
    setFailure(null);
    try {
      const answer = await api.post("/api/public/probe", {});
      setProbe(answer?.probe || null);
      cache.invalidate(["access", "exposure"]);
    } catch (error) {
      setFailure(accessError(error, i18n));
    } finally {
      setProbing(false);
    }
  }

  const socketIp = probe?.observed?.socketIp || report?.probe?.observed?.socketIp || "";
  const offer = socketIp ? trustPatch(settings.cidrs, socketIp) : null;
  const action = (check) => (check.id === "trusted_proxy_match" && check.state === "fail" && offer
    ? html`<${Button} size="sm" onClick=${() => setTrust(offer)} testid="public.checks.trust">${t("public.checks.trust", { cidr: offer.cidr })}<//>` : null);

  return html`<div class="stack" data-testid="public.checks">
    <p>${t("public.intro.checks")}</p>
    <div class="row">
      <${Button} icon="refresh-cw" busy=${scanning} onClick=${rescan} disabled=${unavailable} testid="public.checks.rescan">${t("public.checks.rescan")}<//>
      <${Button} icon="external-link" busy=${probing} onClick=${runProbe} disabled=${unavailable} testid="public.checks.probe">${t("public.checks.probe")}<//>
      ${report?.at ? html`<span class="small muted" data-testid="public.checks.at">${t("public.checks.at", { time: fmt.dateTime(report.at, { style: "short" }) })}</span>` : null}
    </div>
    ${failure ? html`<p class="notice notice-danger" role="alert" data-testid="public.checks.error">${failure}</p>` : null}
    ${unavailable ? html`<p class="notice notice-warn" data-testid="public.checks.unavailable">${t("public.checks.unavailable")}</p>`
      : query.status === "error" && !report ? html`<${EmptyState} icon="triangle-alert" title=${t("public.checks.failed")} body=${query.error?.message || ""} action=${{ label: t("access.retry"), onClick: query.refetch }} />`
      : report ? html`<${ChecksList} checks=${report.checks} renderAction=${action} />` : html`<p class="muted" aria-busy="true">${t("public.checks.loading")}</p>`}
    ${probe ? html`<${ProbeResult} probe=${probe} />` : null}
    ${trust ? html`<${ConfirmDialog} open title=${t("public.trust.title", { cidr: trust.cidr })} body=${t("public.trust.body")} confirmLabel=${t("public.trust.confirm")} testid="public.trust-dialog"
      onConfirm=${async () => {
        await api.patch("/api/public/settings", { section: trust.section, patch: trust.patch }, { headers: { "if-match": settings.etag } });
        cache.invalidate(["access"]);
      }} onClose=${() => setTrust(null)} />` : null}
  </div>`;
}

// ---- step 6: exposure map ------------------------------------------------------------

export function MapStep({ query }) {
  const { t } = useT();
  const report = query.data?.report || null;
  return html`<div class="stack" data-testid="public.map">
    <p>${t("public.intro.map")}</p>
    ${report?.map ? html`<${ExposureMap} map=${report.map} />` : query.status === "error" ? html`<p class="notice notice-danger" role="alert">${t("public.checks.failed")}</p>` : html`<p class="muted" aria-busy="true">${t("public.checks.loading")}</p>`}
  </div>`;
}
