// /voice (07 §6.12, C9, C13): one card per TTS engine from /api/status
// (`.tts.engines`), with the owner lifecycle actions. The actions POST to the
// TTS gateway with the session cookie and x-csrf-token, never an API key (the
// API client adds the header). Unload and Stop ask first. Until 05 accepts the
// console-session principal (`gateway.consoleSession`), a 401 shows the
// pairing-or-key hint with a link to the workbench. The page never reads the
// workbench's job list (stats finding 5): status is the only poll.

import { Button } from "../components/button.js";
import { Card } from "../components/card.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { EmptyState } from "../components/empty-state.js";
import { PageHeader } from "../components/page-header.js";
import { Skeleton } from "../components/skeleton.js";
import { StatusBadge } from "../components/status-badge.js";
import { describeError } from "../lib/api.js";
import { tk } from "../lib/i18n.js";
import { StatusGuard } from "../lib/schemas.js";
import { useServices } from "../ui/context.js";
import { useQuery, useRole, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useEffect, useRef, useState } from "../ui/vendor.js";

const WORKBENCH = "/gateway/tts/";
const CONFIRMED = new Set(["unload", "stop"]);
const RECHECK_MS = 3000;

/** The actions an engine card offers: Wake always, install and start while it is down, unload and stop while it is up. */
export function actionsFor(engine) {
  if (engine.type === "api") return [];
  return engine.available ? ["wake", "unload", "stop"] : ["install", "start", "wake"];
}

function engineList(status) {
  const list = status?.tts?.engines;
  return Array.isArray(list) ? list.filter((item) => item && typeof item.id === "string" && item.id) : [];
}

function Workbench({ variant = "default" }) {
  const { t } = useT();
  return html`<${Button} variant=${variant} href=${WORKBENCH} target="_blank" rel="noopener noreferrer" icon="external-link" testid="voice.workbench">${t("voice.openWorkbench")}<//>`;
}

function EngineCard({ engine, owner, busy, onAction }) {
  const i18n = useT();
  const { t } = i18n;
  const typeKey = engine.type === "api" || engine.type === "docker" ? engine.type : "local";
  return html`<${Card} title=${engine.name || engine.id} level=${3} testid=${`voice.engine.${engine.id}`}>
    <div class="stack-sm">
      <div class="row">
        <${StatusBadge} status=${engine.available ? "ok" : "neutral"} label=${engine.available ? t("voice.state.online") : t("voice.state.offline")} testid="voice.state" />
        <span class="muted">${t(tk("voice.type.", typeKey))}</span>
      </div>
      ${engine.detail ? html`<p class="muted" data-testid="voice.detail">${engine.detail}</p>` : null}
      <div class="row">
        ${actionsFor(engine).map((action) => html`<${Button} key=${action} size="sm" variant=${action === "wake" || action === "install" ? "primary" : "default"}
          disabled=${!owner} busy=${busy === `${engine.id}:${action}`} onClick=${() => onAction(engine, action)} testid=${`voice.action.${action}`}>${t(tk("voice.action.", action))}<//>`)}
      </div>
    </div>
  <//>`;
}

export default function Voice() {
  const services = useServices();
  const { api, cache, toasts, bootstrap } = services;
  const i18n = useT();
  const { t } = i18n;
  const role = useRole();
  const status = useQuery(["status"], () => api.get("/api/status", { guard: StatusGuard }), { ttlMs: 10000, refetchMs: 15000 });
  const [asking, setAsking] = useState(null);
  const [busy, setBusy] = useState("");
  const [needsAuth, setNeedsAuth] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => globalThis.clearTimeout(timer.current), []);

  async function run(engine, action) {
    setBusy(`${engine.id}:${action}`);
    try {
      await api.post(`/gateway/tts/api/models/${encodeURIComponent(engine.id)}/actions/${encodeURIComponent(action)}`);
      setNeedsAuth(false);
      toasts?.push?.({ level: "success", title: engine.name || engine.id, body: t("voice.started") });
      cache.invalidate(["status"]);
      // The engine changes state a moment later; look once more without polling faster.
      globalThis.clearTimeout(timer.current);
      timer.current = globalThis.setTimeout(() => cache.invalidate(["status"]), RECHECK_MS);
    } catch (error) {
      if (error?.status === 401 && bootstrap?.gateway?.consoleSession !== true) {
        setNeedsAuth(true);
      } else {
        throw error;
      }
    } finally {
      setBusy("");
    }
  }

  function request(engine, action) {
    if (CONFIRMED.has(action)) setAsking({ engine, action });
    else {
      run(engine, action).catch((error) => {
        toasts?.push?.({ level: "error", title: engine.name || engine.id, body: describeError(error, i18n), requestId: error?.requestId || null });
      });
    }
  }

  const header = html`<${PageHeader} title=${t("voice.title")} subtitle=${t("voice.subtitle")} actions=${html`<${Workbench} />`} />`;
  if (status.data === undefined && status.status !== "error") {
    return html`<div class="stack" data-testid="voice.root" aria-busy="true">${header}<${Skeleton} shape="tile" /></div>`;
  }
  if (status.data === undefined) {
    return html`<div class="stack" data-testid="voice.root">${header}
      <${EmptyState} icon="circle-x" level=${2} title=${t("voice.error.title")} body=${describeError(status.error, i18n)} action=${{ label: t("shell.conn.retry"), onClick: () => status.refetch() }} />
    </div>`;
  }

  const engines = engineList(status.data);
  const tts = status.data?.tts;
  const owner = role === "owner";
  const confirm = asking ? asking : { engine: null, action: "" };
  return html`<div class="stack" data-testid="voice.root">
    ${header}
    ${needsAuth ? html`<div class="notice notice-warn" role="alert" data-testid="voice.needs-auth">
      <div class="stack-sm grow">
        <strong>${t("voice.needsAuth.title")}</strong>
        <p>${t("voice.needsAuth.body")}</p>
        <div><${Workbench} /></div>
      </div>
    </div>` : null}
    ${!owner ? html`<p class="muted" data-testid="voice.viewer-note">${t("voice.viewerNote")}</p>` : null}
    ${engines.length
      ? html`<div class="grid-auto" role="group" aria-label=${t("voice.engines.label")}>
        ${engines.map((engine) => html`<${EngineCard} key=${engine.id} engine=${engine} owner=${owner} busy=${busy} onAction=${request} />`)}
      </div>`
      : html`<${EmptyState} icon="mic" level=${2} title=${tts && tts.listening === false ? t("voice.offline.title") : t("voice.none.title")}
        body=${tts?.error || t("voice.none.body")} action=${{ label: t("voice.openWorkbench"), href: WORKBENCH }} />`}
    <${ConfirmDialog} open=${Boolean(asking)} tone="danger" title=${asking ? t(tk("voice.confirm.", confirm.action, "title")) : ""}
      body=${asking ? t(tk("voice.confirm.", confirm.action, "body"), { name: confirm.engine.name || confirm.engine.id }) : ""}
      confirmLabel=${asking ? t(tk("voice.action.", confirm.action)) : ""}
      onConfirm=${() => run(confirm.engine, confirm.action)} onClose=${() => setAsking(null)} testid="voice.confirm" />
  </div>`;
}
