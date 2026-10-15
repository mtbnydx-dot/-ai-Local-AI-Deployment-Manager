// /engines/:engineId (07 §6.5): one engine, in tabs.
//
//   Runtimes   image, presence, introspection, Introspect and Pull image (runtimes-tab.js)
//   Parameters SchemaForm in catalog mode with availability badges (schema-tabs.js, loaded on demand)
//   Flag diff  added, removed and changed flags between two runtimes (flag-diff-tab.js)
//   Recipes    the schema's recipes (schema-tabs.js)
//   Descriptor the engine record, read-only
//
// The engine and its manager come from the entry aggregate GET /api/engines;
// every other call goes through the management proxy to that manager.

import { defaultRuntime, summarizeEngines } from "../../lib/engines-model.js";
import { EnginesResponseGuard } from "../../lib/schemas.js";
import { CodeBlock } from "../../components/code-block.js";
import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { Skeleton } from "../../components/skeleton.js";
import { Tabs, readQueryParam, replaceQueryParam } from "../../components/tabs.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useRole, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useMemo, useState } from "../../ui/vendor.js";
import { CapabilityChips, HealthBadge, TierBadge, managerName } from "./engine-parts.js";
import { FlagDiffTab } from "./flag-diff-tab.js";
import { RuntimesTab } from "./runtimes-tab.js";

const TAB_IDS = Object.freeze(["runtimes", "parameters", "flags", "recipes", "descriptor"]);

/** Loads a route-only module the first time `enabled` turns on (SchemaForm is 25 KB; most visits never open Parameters). */
function useLazyModule(load, enabled) {
  const [module, setModule] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled || module || failed) return undefined;
    let alive = true;
    load().then((loaded) => alive && setModule(loaded), () => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [enabled]);
  return { module, failed };
}

function PanelBody({ engine, tab, owner, runtimeId, onRuntimeChange, onShowRuntimes, label }) {
  const { t } = useT();
  const needsSchema = tab === "parameters" || tab === "recipes";
  const { module, failed } = useLazyModule(() => import("./schema-tabs.js"), needsSchema);
  if (tab === "runtimes") return html`<${RuntimesTab} engine=${engine} owner=${owner} />`;
  if (tab === "flags") return html`<${FlagDiffTab} engine=${engine} onShowRuntimes=${onShowRuntimes} />`;
  if (tab === "descriptor") {
    return html`<div class="stack" data-testid="engine-descriptor">
      <p class="muted">${t("engines.page.descriptor.note")}</p>
      <${CodeBlock} code=${JSON.stringify(engine, null, 2)} language="json" testid="engine-descriptor.json" />
    </div>`;
  }
  if (failed) return html`<div class="notice notice-danger" role="alert">${t("engines.page.schema.failed")}</div>`;
  if (!module) return html`<div aria-busy="true"><${Skeleton} shape="table" rows=${5} /></div>`;
  const Tab = tab === "parameters" ? module.ParametersTab : module.RecipesTab;
  return html`<${Tab} engine=${engine} runtimeId=${runtimeId} onRuntimeChange=${onRuntimeChange} label=${label} />`;
}

// Every panel opens with its own h2, so SchemaForm's group headings (h3) sit under a heading of the page.
function Panel(props) {
  const { t, tk } = useT();
  return html`<h2 class="sr-only">${t(tk("engines.page.tab.", props.tab))}</h2><${PanelBody} ...${props} />`;
}

export default function EngineDetailPage({ params }) {
  const { api } = useServices();
  const { t, has, tk, pick } = useT();
  const owner = useRole() === "owner";
  const engineId = params?.engineId || "";
  const query = useQuery(["engines"], () => api.get("/api/engines", { guard: EnginesResponseGuard }), { ttlMs: 10000, refetchMs: 30000 });
  const summary = useMemo(() => (query.data ? summarizeEngines(query.data) : null), [query.data]);
  const engine = summary?.engines.find((item) => item.engineId === engineId) || null;

  const [tab, setTab] = useState(() => {
    const fromUrl = readQueryParam("tab");
    return TAB_IDS.includes(fromUrl) ? fromUrl : "runtimes";
  });
  const [runtimeId, setRuntimeId] = useState(() => readQueryParam("runtime") || "");
  const known = engine?.runtimes?.some((runtime) => runtime.runtimeId === runtimeId);
  const activeRuntime = known ? runtimeId : defaultRuntime(engine)?.runtimeId || "";
  const label = engine ? pick(engine.label) || engine.engineId : engineId;

  function chooseRuntime(next) {
    setRuntimeId(next);
    replaceQueryParam("runtime", next);
  }

  const crumbs = [{ label: t("shell.nav.engines"), href: "/engines" }, { label }];
  if (!engine) {
    const offline = summary?.offline.length > 0;
    return html`<div class="stack" data-testid="engine-detail">
      <${PageHeader} title=${label} breadcrumbs=${crumbs} />
      ${query.error && !summary
        ? html`<${EmptyState} title=${t("engines.page.unavailable")} body=${t("engines.page.unavailableBody")} action=${{ label: t("engines.page.retry"), onClick: () => query.refetch() }} />`
        : !summary
          ? html`<div aria-busy="true"><${Skeleton} shape="line" rows=${5} /></div>`
          : html`<${EmptyState} testid="engine-detail.missing" title=${t("engines.page.notFound", { engine: engineId })}
            body=${offline ? t("engines.page.notFoundOffline") : t("engines.page.notFoundBody")} action=${{ label: t("engines.page.backToList"), href: "/engines" }} />`}
    </div>`;
  }

  const tabs = [
    { id: "runtimes", label: t("engines.page.tab.runtimes"), badge: engine.runtimes?.length ?? 0 },
    { id: "parameters", label: t("engines.page.tab.parameters") },
    { id: "flags", label: t("engines.page.tab.flags") },
    { id: "recipes", label: t("engines.page.tab.recipes") },
    { id: "descriptor", label: t("engines.page.tab.descriptor") },
  ];
  return html`<div class="stack" data-testid="engine-detail" data-engine=${engine.engineId}>
    <${PageHeader} title=${label} breadcrumbs=${crumbs} testid="engine-detail.header"
      subtitle=${engine.description ? pick(engine.description) : undefined}
      meta=${html`<${TierBadge} engine=${engine} /><span class="muted">${t("engines.page.host", { manager: managerName(t, has, tk, engine.managerId) })}</span><${HealthBadge} engine=${engine} />`} />
    <${CapabilityChips} engine=${engine} />
    <${Tabs} tabs=${tabs} value=${tab} onChange=${setTab} label=${t("engines.page.tabs")} testid="engine-detail.tabs">
      <${Panel} engine=${engine} tab=${tab} owner=${owner} runtimeId=${activeRuntime} onRuntimeChange=${chooseRuntime}
        onShowRuntimes=${() => {
          setTab("runtimes");
          replaceQueryParam("tab", "runtimes");
        }} label=${label} />
    <//>
  </div>`;
}
