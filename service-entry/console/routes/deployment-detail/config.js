// The Config tab of a deployment (07 §6.2): the LaunchStore record as a
// read-only SchemaForm, the redacted command, Clone as new and Save as profile
// (both open the wizard, which owns launching and saving), and the qualification
// block (CON-31, qualify.js) with Save as recipe.

import { cloneHref } from "../../lib/deployments-model.js";
import { describeError } from "../../lib/api.js";
import { SchemaCatalogGuard } from "../../lib/schemas.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { CodeBlock } from "../../components/code-block.js";
import { EmptyState } from "../../components/empty-state.js";
import { SchemaForm } from "../../components/schema-form.js";
import { modelRefOf } from "../../lib/qualify-model.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { LazyView } from "./lazy.js";

const enc = encodeURIComponent;
const loadQualify = () => import("./qualify.js");

export function ConfigTab({ row, owner }) {
  const services = useServices();
  const { api } = services;
  const i18n = useT();
  const { t } = i18n;
  const sleeping = row.state === "sleeping";
  const launchPath = sleeping ? `/launches/${enc(row.launchId || "")}` : `/instances/${enc(row.instanceId)}/launch`;
  const launch = useQuery(["m", row.managerId, "launch", row.instanceId, row.launchId || ""], () => api.manager(row.managerId).get(launchPath), {
    ttlMs: 15000, enabled: owner && (!sleeping || Boolean(row.launchId)),
  });
  const record = launch.data?.launch || launch.data || null;
  const engineId = record?.spec?.engineId || row.engineId;
  const runtimeId = record?.spec?.runtimeId || "";
  const schema = useQuery(["m", row.managerId, "schema", engineId, runtimeId], () => api.manager(row.managerId).get(`/engines/${enc(engineId)}/schema`, {
    query: { runtime: runtimeId || undefined }, guard: SchemaCatalogGuard,
  }), { ttlMs: 60000, enabled: owner && Boolean(record) && Boolean(engineId) });
  const values = record?.spec?.values || {};
  const plan = record?.resolved?.values ? { values: record.resolved.values } : null;
  const argv = launch.data?.command?.argv || record?.resolved?.argvRedacted || [];
  if (!owner) return html`<p class="muted" data-testid="deploy.config.owner">${t("shell.ownerOnly")}</p>`;
  if (launch.error && !record) {
    return html`<${EmptyState} icon="file-question" title=${t("deploy.config.unavailable")} body=${describeError(launch.error, i18n)}
      action=${{ label: t("deploy.config.openWizard"), href: cloneHref({ managerId: row.managerId, launchId: row.launchId }) }} testid="deploy.config.error" />`;
  }
  if (!record) return html`<p class="muted" aria-busy="true">…</p>`;
  return html`<div class="stack" data-testid="deploy.tab.config">
    <div class="row">
      <${Button} icon="copy" href=${cloneHref({ managerId: row.managerId, launchId: record.launchId || row.launchId })} testid="deploy.config.clone">${t("deploy.action.clone")}<//>
      <${Button} icon="save" href=${`${cloneHref({ managerId: row.managerId, launchId: record.launchId || row.launchId })}&step=review&intent=profile`} testid="deploy.config.profile">${t("deploy.action.saveProfile")}<//>
    </div>
    <${Card} title=${t("deploy.config.values")} testid="deploy.config.values">
      ${schema.data
        ? html`<${SchemaForm} catalog=${schema.data} plan=${plan} values=${values} mode="config" readOnly=${true} />`
        : html`<p class="muted small">${schema.error ? t("deploy.config.noSchema") : "…"}</p>
          <dl class="kv">${Object.entries(values).map(([id, value]) => html`<dt key=${`${id}-t`}>${id}</dt><dd key=${`${id}-d`}>${typeof value === "string" ? value : JSON.stringify(value)}</dd>`)}</dl>`}
    <//>
    <${Card} title=${t("deploy.config.command")} testid="deploy.config.command">
      ${argv.length ? html`<${CodeBlock} code=${argv.join("\n")} language="docker" />` : html`<p class="muted">${t("deploy.config.noCommand")}</p>`}
    <//>
    <${LazyView} load=${loadQualify} name="QualifyBlock" framed=${true} managerId=${row.managerId} fleetId=${row.fleetId || row.key} launchId=${record.launchId || row.launchId || ""}
      modelRef=${modelRefOf(record)} engineId=${engineId} values=${record.resolved?.values || null} modelName=${record.spec?.model?.servedName || ""} canStart=${row.state === "ready"} />
  </div>`;
}
