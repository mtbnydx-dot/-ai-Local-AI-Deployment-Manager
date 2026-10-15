// /models/storage (07 §6.4 "Storage"): where models live and how to move them.
//
// Capacity per root (GET /api/hub/storage/usage), the registered roots with
// Register folder / Set default / Unregister, and the migration planner at
// parity with the legacy /model-storage page (tests/model-storage.spec.cjs):
// pick a source and a target folder (typed, from a registered library, or from
// the folder browser), Preview (nothing is created or registered by a
// preview), Start after a confirmation, follow the progress, then Pause,
// Switch back or Clean up the source (type its full path). The roots and the
// jobs stay with the managers (03 keeps the planner there); the leftovers card
// is the hub's `storage/cleanup`.
//
// `?move=<path>` (the library's Move action) preselects the source.

import { describeError } from "../../lib/api.js";
import { cleanupTargets, duplicateBytes } from "../../lib/library-model.js";
import { anyActive, cleanPath, defaultTarget, destinationText, libraryRoots, planBody } from "../../lib/storage-model.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { Skeleton } from "../../components/skeleton.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useId, useMemo, useState } from "../../ui/vendor.js";
import { LazyView } from "../deployment-detail/lazy.js";
import { CapacityBars } from "./capacity.js";
import { firstManager, useLibraryQuery, useUsageQuery } from "./data.js";
import { RegisterDrawer, RootsCard } from "./storage-roots.js";
import { ModelsNav } from "./subnav.js";

function PreviewPanel({ preview, onStart }) {
  const { t } = useT();
  const fmt = useFormat();
  const [asking, setAsking] = useState(false);
  const { cache } = useServices();
  return html`<div class="stack-sm notice" data-testid="storage.preview">
    <div class="stack-sm grow">
      <h3 class="card-title">${t("hub.storage.preview.title")}</h3>
      <p class="mono small" data-user-content="" data-testid="storage.preview.paths">${preview.source}<br />→ ${preview.target}</p>
      <p data-testid="storage.preview.size">${t("hub.storage.preview.size", { count: preview.fileCount, size: fmt.bytes(preview.totalBytes), free: fmt.bytes(preview.freeBytes) })}</p>
      ${preview.needsRegistration ? html`<p class="small" data-testid="storage.preview.registers">${t(preview.needsCreation ? "hub.storage.preview.createsAndRegisters" : "hub.storage.preview.registers", { path: preview.targetDirectory })}</p>` : null}
      <p class="small muted">${t("hub.storage.preview.how")}</p>
      <details>
        <summary>${t(preview.truncated ? "hub.storage.preview.filesTruncated" : "hub.storage.preview.files")}</summary>
        <ul class="small mono">${(preview.files || []).map((file) => html`<li key=${file.path} data-user-content="">${file.path} · ${fmt.bytes(file.size)}</li>`)}</ul>
      </details>
      <div><${Button} variant="primary" onClick=${() => setAsking(true)} testid="storage.preview.start">${t("hub.storage.preview.start")}<//></div>
    </div>
    <${ConfirmDialog} open=${asking} testid="storage.start-confirm" title=${t("hub.storage.migration.startTitle")}
      body=${html`<div class="stack-sm"><p>${t("hub.storage.migration.startBody")}</p><p class="mono small" data-user-content="">${preview.source}<br />→ ${preview.target}</p></div>`}
      confirmLabel=${t("hub.storage.migration.start")}
      onConfirm=${async () => {
        await onStart(preview);
        cache.invalidate(["hub", "storage"]);
      }} onClose=${() => setAsking(false)} />
  </div>`;
}

function MigrationPlanner({ snapshot, managerApi, models, initialSource, picked, onBrowse }) {
  const { i18n, cache } = useServices();
  const { t } = useT();
  const fmt = useFormat();
  const id = useId();
  const libraries = libraryRoots(snapshot);
  const [form, setForm] = useState({ source: initialSource || "", targetDirectory: "", outputName: "" });
  const [touched, setTouched] = useState(false);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const source = form.source || models[0]?.path || "";
  const target = touched ? form.targetDirectory : defaultTarget(snapshot);
  const key = JSON.stringify([source, cleanPath(target), form.outputName.trim()]);
  const shown = preview && preview.key === key ? preview.plan : null;

  useEffect(() => {
    if (picked) {
      setTouched(true);
      setForm((current) => ({ ...current, targetDirectory: picked.path }));
    }
  }, [picked]);
  useEffect(() => {
    if (initialSource) setForm((current) => ({ ...current, source: initialSource }));
  }, [initialSource]);

  const set = (patch) => setForm((current) => ({ ...current, ...patch }));
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const plan = await managerApi.post("/model-storage/migrations/plan", planBody({ source, targetDirectory: target, outputName: form.outputName }));
      setPreview({ key, plan });
      cache.invalidate(["hub", "storage", "migrations"]);
    } catch (failure) {
      setError(describeError(failure, i18n));
    } finally {
      setBusy(false);
    }
  }
  async function start(plan) {
    await managerApi.post(`/model-storage/migrations/${encodeURIComponent(plan.id)}/start`, {});
    setPreview(null);
  }
  const destination = destinationText(target, form.outputName, source);
  return html`<${Card} title=${t("hub.storage.planner.title")} testid="storage.planner">
    <form class="stack" onSubmit=${submit} data-testid="storage.planner.form">
      <p class="small muted">${t("hub.storage.planner.lead")}</p>
      <div class="field">
        <label class="field-label" for=${`${id}-source`}>${t("hub.storage.planner.source")}</label>
        <select id=${`${id}-source`} class="select" value=${source} onChange=${(event) => set({ source: event.currentTarget.value })} data-testid="storage.planner.source">
          ${models.map((model) => html`<option key=${model.path} value=${model.path} selected=${model.path === source}>${model.name} · ${fmt.bytes(model.bytes)}</option>`)}
        </select>
        ${source ? html`<code class="code-inline mono xsmall" data-user-content="" data-testid="storage.planner.source-path">${source}</code>` : null}
      </div>
      <div class="field">
        <label class="field-label" for=${`${id}-target`}>${t("hub.storage.planner.target")}</label>
        <div class="row-nowrap">
          <input id=${`${id}-target`} class="input mono grow" value=${target} required autocomplete="off" spellcheck="false" placeholder=${t("hub.storage.planner.targetHint")}
            onInput=${(event) => {
              setTouched(true);
              set({ targetDirectory: event.currentTarget.value });
            }} data-testid="storage.planner.target" />
          <${Button} onClick=${() => onBrowse(target)} testid="storage.planner.browse">${t("hub.storage.folder.browse")}<//>
        </div>
        <p class="small muted">${t("hub.storage.planner.targetNote")}</p>
        ${libraries.length ? html`<div class="row" role="group" aria-label=${t("hub.storage.planner.shortcuts")} data-testid="storage.planner.shortcuts">
          ${libraries.map((root) => html`<${Button} key=${root.id} size="sm" aria-pressed=${cleanPath(target).toLowerCase() === root.path.toLowerCase() ? "true" : "false"}
            onClick=${() => {
              setTouched(true);
              set({ targetDirectory: root.path });
            }} testid="storage.planner.shortcut">${root.label}${root.id === snapshot.defaultRootId ? ` · ${t("hub.storage.badge.default")}` : ""}<//>`)}
        </div>` : null}
      </div>
      <div class="field">
        <label class="field-label" for=${`${id}-name`}>${t("hub.storage.planner.name")}</label>
        <input id=${`${id}-name`} class="input" value=${form.outputName} autocomplete="off" spellcheck="false" placeholder=${t("hub.storage.planner.nameHint")}
          onInput=${(event) => set({ outputName: event.currentTarget.value })} data-testid="storage.planner.name" />
      </div>
      <div class="field">
        <span class="field-label">${t("hub.storage.planner.destination")}</span>
        <output class="mono small" aria-live="polite" data-user-content="" data-testid="storage.planner.destination">${destination || t("hub.storage.planner.destinationNone")}</output>
      </div>
      ${error ? html`<p class="field-error" role="alert" data-testid="storage.planner.error" data-user-content="">${error}</p>` : null}
      <div class="row">
        <${Button} variant="primary" type="submit" busy=${busy} disabled=${!source || !target.trim()} testid="storage.planner.preview">${t("hub.storage.planner.preview")}<//>
        <span class="small muted">${t("hub.storage.planner.previewNote")}</span>
      </div>
    </form>
    ${shown ? html`<${PreviewPanel} preview=${shown} onStart=${start} />` : null}
  <//>`;
}

function Leftovers({ usage }) {
  const { api, cache, toasts, i18n } = useServices();
  const { t } = useT();
  const fmt = useFormat();
  const [asking, setAsking] = useState(false);
  const targets = cleanupTargets(usage);
  const duplicates = duplicateBytes(usage);
  if (!targets.length && !duplicates) return null;
  const bytes = targets.reduce((sum, item) => sum + item.bytes, 0);
  async function clean() {
    const body = await api.post("/api/hub/storage/cleanup", { targets: targets.map(({ bytes: _bytes, ...target }) => target), confirm: true });
    cache.invalidate(["hub", "library"]);
    toasts?.push?.({ level: "success", title: t("hub.storage.leftovers.done", { size: fmt.bytes(body?.reclaimedBytes) }) });
  }
  return html`<${Card} title=${t("hub.storage.leftovers.title")} testid="storage.leftovers">
    ${targets.length ? html`<div class="stack-sm">
      <p>${t("hub.storage.leftovers.body", { count: targets.length, size: fmt.bytes(bytes) })}</p>
      <div><${Button} onClick=${() => setAsking(true)} testid="storage.leftovers.clean">${t("hub.storage.leftovers.clean")}<//></div>
    </div>` : null}
    ${duplicates ? html`<p class="small muted" data-testid="storage.leftovers.duplicates">${t("hub.storage.leftovers.duplicates", { size: fmt.bytes(duplicates) })}</p>` : null}
    <${ConfirmDialog} open=${asking} tone="danger" testid="storage.leftovers.confirm" title=${t("hub.storage.leftovers.title")}
      body=${t("hub.storage.leftovers.confirm", { size: fmt.bytes(bytes) })} confirmLabel=${t("hub.storage.leftovers.clean")} onConfirm=${clean} onClose=${() => setAsking(false)} />
  <//>`;
}

export default function StoragePage({ query = {} }) {
  const { api, i18n } = useServices();
  const { t } = useT();
  const usage = useUsageQuery();
  const library = useLibraryQuery();
  const snapshot = useQuery(["hub", "storage", "snapshot"], () => firstManager(api, (manager) => manager.get("/model-storage")), { ttlMs: 5000 });
  const managerId = snapshot.data?.managerId || "";
  const managerApi = useMemo(() => (managerId ? api.manager(managerId) : null), [api, managerId]);
  // The managers publish no event for a migration, so the list polls: quickly while one copies.
  const [pollMs, setPollMs] = useState(8000);
  const migrations = useQuery(["hub", "storage", "migrations", managerId], () => managerApi.get("/model-storage/migrations"), { ttlMs: 2000, refetchMs: pollMs, enabled: Boolean(managerId) });
  const active = anyActive(migrations.data?.migrations);
  useEffect(() => {
    setPollMs(active ? 2500 : 8000);
  }, [active]);
  const [registering, setRegistering] = useState(false);
  const [folder, setFolder] = useState(null);
  const [pickedRegister, setPickedRegister] = useState(null);
  const [pickedTarget, setPickedTarget] = useState(null);

  const models = useMemo(() => (library.data?.views || []).filter((view) => !view.cache && view.path && view.runnable !== false), [library.data]);
  const move = typeof query.move === "string" ? query.move : "";
  const moveSource = models.some((model) => model.path === move) ? move : "";

  function choose(path) {
    if (folder?.purpose === "register") setPickedRegister({ path });
    else setPickedTarget({ path });
    setFolder(null);
  }

  let body;
  if (snapshot.error && !snapshot.data) {
    body = html`<${EmptyState} testid="storage.unavailable" icon="triangle-alert" title=${t("hub.storage.unavailable")} body=${describeError(snapshot.error, i18n)}
      action=${{ label: t("hub.library.retry"), onClick: () => snapshot.refetch() }} />`;
  } else if (!snapshot.data) {
    body = html`<div aria-busy="true"><${Skeleton} shape="tile" /><${Skeleton} shape="line" rows=${4} /></div>`;
  } else {
    body = html`<div class="stack">
      <${RootsCard} snapshot=${snapshot.data.body} managerApi=${managerApi} onRegister=${() => setRegistering(true)} />
      <${MigrationPlanner} snapshot=${snapshot.data.body} managerApi=${managerApi} models=${models} initialSource=${moveSource} picked=${pickedTarget}
        onBrowse=${(start) => setFolder({ purpose: "target", start })} />
      <${LazyView} load=${() => import("./storage-migrations.js")} name="MigrationsCard" migrations=${migrations.data?.migrations} managerApi=${managerApi} />
      ${usage.data?.source === "hub" ? html`<${Leftovers} usage=${usage.data.usage} />` : null}
      <${RegisterDrawer} open=${registering} managerApi=${managerApi} picked=${pickedRegister} onClose=${() => setRegistering(false)}
        onBrowse=${(start) => setFolder({ purpose: "register", start })} />
      ${folder ? html`<${LazyView} load=${() => import("./folder-dialog.js")} name="FolderDialog" open=${true} start=${folder.start || ""} managerApi=${managerApi} onChoose=${choose} onClose=${() => setFolder(null)} />` : null}
    </div>`;
  }
  return html`<div class="stack" data-testid="storage" data-manager=${managerId}>
    <${PageHeader} title=${t("shell.nav.models")} subtitle=${t("hub.storage.subtitle")} />
    <${ModelsNav} current="storage" />
    <${CapacityBars} query=${usage} />
    ${body}
  </div>`;
}
