// Resource guards for every backend shape the console reads (07 §3.4).
//
// Each guard names only the fields a page relies on; everything else passes
// through. Other workstreams' route tests import this module and assert that
// their real responses pass (07 §13.4), so a field is required here only when
// its spec makes it required. Specs: 00 §4 and §9, 01 §21, 02 §4/§9/§10/§11,
// 03 §8.1/§9.2, 04 §11, 05 §5.6/§6, 06 §5.15/§7.1.

import { any, arr, bool, int, iso, nullable, num, obj, oneOf, opt, record, refine, str } from "./guards.js";
import { isApiPath, isSameOriginPath } from "./url.js";

const maybe = (guard) => opt(nullable(guard));
// The methods the entry bus accepts for a notification apiCall (service-entry/lib/events.js).
const API_CALL_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// ---------------------------------------------------------------------------
// Shared pieces

/** `{zh, en}` text from a backend (00 §9.6). */
export const ZhEnGuard = obj({ zh: str, en: str });

/** Display text in either backend form: `{zh, en}` or `{"zh-CN", "en-US"}` (06 uses the latter). */
export const LocalizedTextGuard = refine(record(str), (value) => (typeof value.zh === "string" || typeof value["zh-CN"] === "string")
  && (typeof value.en === "string" || typeof value["en-US"] === "string"), "localized text {zh,en}");

/** One 00 §4.2 field error. */
export const FieldErrorGuard = obj({ field: opt(str), code: str, message: opt(str), suggestion: maybe(any) });

const LifecycleGuard = obj({
  state: str,
  phase: maybe(str),
  percent: maybe(num),
  since: maybe(iso),
  phaseHistory: opt(arr(obj({ phase: str, at: maybe(iso) }))),
});

// ---------------------------------------------------------------------------
// 00: error envelope, instances, launch plans, job errors, events

export const ErrorEnvelopeGuard = obj({
  ok: oneOf(false),
  error: obj({ code: str, message: opt(str), hint: maybe(any), docs: maybe(str) }),
  errors: opt(arr(FieldErrorGuard)),
});

/** 00 §4.1 plus §9.17; legacy instances carry `instanceId`, newer ones `id`. */
export const InstanceGuard = refine(obj({
  id: opt(str),
  instanceId: opt(str),
  engineId: maybe(str),
  engineFamily: maybe(str),
  runtime: maybe(obj({ id: maybe(str), version: maybe(str), image: maybe(str), digest: maybe(str) })),
  recipeId: maybe(str),
  launchId: maybe(str),
  lifecycle: maybe(LifecycleGuard),
  capabilities: maybe(record(any)),
  apiSurface: maybe(record(any)),
  vramReservationMb: maybe(num),
  gpuIds: maybe(arr(str)),
  sleep: maybe(obj({ id: maybe(str) })),
  models: opt(arr(any)),
}), (value) => typeof (value.id ?? value.instanceId) === "string", "instance with id or instanceId");

/** 00 §9.12: the console reads `metrics` and `facts`; `unsupported` keys render "not reported", never 0. */
export const InstanceMetricsGuard = obj({
  instanceId: opt(str),
  engineId: maybe(str),
  scrapedAt: maybe(iso),
  metrics: nullable(record(any)),
  facts: maybe(record(any)),
  raw: opt(any),
  unsupported: opt(arr(str)),
});

const PlanValueGuard = obj({ value: any, source: str, reason: maybe(any) });

/** 00 §4.3 plus §9.2 (`planHash`, `steps[]`, `blockers[]`, `ok:false` for plan problems). */
export const LaunchPlanGuard = obj({
  ok: bool,
  engineId: opt(str),
  planHash: maybe(str),
  prospective: opt(bool),
  runtime: maybe(record(any)),
  recipe: maybe(obj({ id: str, status: opt(str), locks: opt(arr(obj({ param: str, reason: maybe(any) }))) })),
  values: opt(record(PlanValueGuard)),
  overrides: opt(arr(obj({ param: str, from: opt(any), to: opt(any), source: opt(str), reason: maybe(any) }))),
  errors: opt(arr(FieldErrorGuard)),
  warnings: opt(arr(any)),
  blockers: opt(arr(any)),
  steps: opt(arr(obj({ kind: str, image: maybe(str), required: opt(bool), policy: opt(oneOf("auto", "explicit")) }))),
  command: maybe(obj({ argv: arr(str, { dropInvalid: false }), env: opt(record(str)), labels: opt(record(str)) })),
  memory: maybe(obj({
    perGpuMb: opt(record(num)),
    breakdown: opt(record(num)),
    admissionRequestMb: maybe(num),
    kvPoolTokens: maybe(num),
    maxFullLengthRequests: maybe(num),
    policy: maybe(str),
  })),
  admission: maybe(obj({ verdict: oneOf("ok", "warn", "block"), message: maybe(str) })),
});

/** 00 §9.11; `logExcerpt` is shown exactly as the server redacted it. */
export const JobErrorGuard = obj({
  code: str,
  signatureId: maybe(str),
  phase: maybe(str),
  hint: maybe(LocalizedTextGuard),
  logExcerpt: maybe(str),
});

/** 00 §4.5 plus the §2.8 `id`. */
export const EventEnvelopeGuard = obj({
  id: opt(str),
  type: str,
  at: iso,
  source: str,
  data: record(any),
});

const NotificationActionGuard = refine(obj({
  label: ZhEnGuard,
  href: opt(refine(str, isSameOriginPath, "same-origin path")),
  apiCall: opt(obj({
    method: refine(str, (method) => API_CALL_METHODS.has(method.toUpperCase()), "HTTP method"),
    path: refine(str, isApiPath, "/api/ path"),
    body: opt(any),
  })),
}), (value) => (value.href === undefined) !== (value.apiCall === undefined), "action with exactly one of href and apiCall");

/** 00 §9.6; a cross-origin href or a non-`/api/` apiCall is rejected (§3.6, §10). */
export const NotificationGuard = obj({
  kind: str,
  severity: oneOf("info", "success", "warn", "error"),
  title: ZhEnGuard,
  body: opt(ZhEnGuard),
  action: opt(NotificationActionGuard),
  dedupeKey: opt(str),
});

// ---------------------------------------------------------------------------
// Entry: status, fleet, bootstrap

export const StatusGuard = obj({
  ok: bool,
  managers: opt(arr(obj({ id: str, ok: opt(bool) }))),
  components: obj({
    total: opt(int),
    online: opt(int),
    offline: arr(str),
    unhealthy: opt(arr(str)),
    items: opt(arr(obj({ id: str, online: opt(bool), healthy: opt(bool) }))),
  }),
  security: opt(record(any)),
});

export const FleetGuard = obj({
  updatedAt: maybe(iso),
  instances: arr(InstanceGuard),
  settings: opt(record(any)),
  gpuMemory: opt(any),
  slots: opt(arr(any)),
  routing: opt(record(any)),
});

/** 07 §2.5. */
export const BootstrapGuard = obj({
  ok: oneOf(true),
  buildId: nullable(str),
  role: oneOf("owner", "viewer", "none"),
  access: opt(obj({ local: opt(bool), lanViewer: opt(bool), allowLanAdmin: opt(bool) })),
  auth: obj({ mode: str, session: maybe(record(any)), csrf: maybe(str) }),
  defaults: opt(obj({ locale: opt(str), theme: opt(str), density: opt(str) })),
  platform: opt(record(any)),
  managers: arr(obj({ id: str, label: opt(LocalizedTextGuard), legacyUiPort: maybe(int) })),
  gateway: opt(record(any)),
  features: record(bool),
});

// ---------------------------------------------------------------------------
// 05: session and keys

/** 05 §5.6 `GET /api/session`. */
export const SessionGuard = obj({
  ok: opt(bool),
  role: oneOf("owner", "viewer", "none"),
  via: maybe(str),
  paired: opt(bool),
  csrfToken: maybe(str),
  autoPairAvailable: opt(bool),
  pairCommand: opt(str),
});

/** 05 §6.5 KeyRecord as the access APIs return it (never the secret). */
export const KeyGuard = obj({
  id: str,
  name: str,
  preview: opt(str),
  status: str,
  class: opt(str),
  customerId: maybe(str),
  holder: maybe(str),
  scopes: opt(arr(str)),
  models: opt(arr(str)),
  listeners: opt(arr(str)),
  limits: opt(record(any)),
  expiresAt: maybe(iso),
  createdAt: opt(iso),
  lastUsedAt: maybe(iso),
  lastUsedCountry: maybe(str),
});

/** 05 §13.1 GET /api/access/keys. */
export const KeyListGuard = obj({ ok: opt(bool), items: arr(KeyGuard), nextCursor: maybe(str), counts: opt(record(any)) });

/** 05 §6.6 / §13.1 one entry of GET /api/access/presets. */
export const PresetGuard = obj({
  id: str,
  class: str,
  scopes: arr(str),
  models: arr(str),
  listeners: arr(str),
  limits: record(any),
  expiresInDays: maybe(int),
  requiresCustomer: bool,
  labelKey: str,
  descriptionKey: str,
});

export const PresetListGuard = obj({ ok: opt(bool), presets: arr(PresetGuard) });

/** 05 §13.1 POST /api/access/keys: the secret and the invite block, returned once. */
export const KeyCreatedGuard = obj({
  ok: opt(bool),
  key: KeyGuard,
  secret: str,
  share: obj({ openaiBase: str, anthropicBase: str, portalUrl: str, recommendedModel: maybe(str), snippetCurl: str }),
});

// ---------------------------------------------------------------------------
// 06: platform status, components, doctor

export const ComponentGuard = obj({
  id: str,
  kind: opt(str),
  state: str,
  desired: opt(str),
  owner: opt(str),
  pid: maybe(int),
  ports: opt(arr(obj({ name: opt(str), port: int, bind: opt(str) }))),
  uptimeSec: maybe(num),
  restarts: maybe(record(any)),
  lastExit: maybe(any),
  pendingRestart: maybe(any),
  message: maybe(any),
});

/** 06 §5.15. */
export const PlatformStatusGuard = obj({
  schemaVersion: opt(int),
  at: opt(iso),
  build: maybe(obj({ commit: maybe(str), contentHash: maybe(str) })),
  mode: opt(str),
  supervisor: maybe(record(any)),
  readiness: obj({
    overall: oneOf("ok", "degraded", "down"),
    layers: arr(obj({
      id: str,
      status: str,
      detail: maybe(str),
      code: maybe(str),
      mode: maybe(str),
      action: maybe(obj({ id: str, label: opt(LocalizedTextGuard) })),
    })),
  }),
  components: opt(arr(ComponentGuard)),
  models: opt(record(any)),
  ops: opt(record(any)),
});

/** 06 §7.1. */
export const DoctorCheckGuard = obj({
  id: str,
  group: opt(str),
  status: str,
  title: opt(LocalizedTextGuard),
  detail: maybe(str),
  durationMs: maybe(num),
  fix: maybe(obj({ id: str, risk: oneOf("auto", "confirm", "manual"), label: opt(LocalizedTextGuard), command: maybe(str), docs: maybe(str) })),
  actions: opt(arr(any)),
});

// ---------------------------------------------------------------------------
// 01: engines, schema catalog, descriptors

export const EngineGuard = obj({
  engineId: str,
  label: maybe(any),
  family: maybe(str),
  adapter: maybe(str),
  tier: maybe(any),
  status: maybe(str),
  artifactFormats: opt(arr(str)),
  runtimes: arr(obj({
    runtimeId: str,
    image: maybe(str),
    default: opt(bool),
    present: maybe(bool),
    introspected: opt(bool),
    status: maybe(str),
  })),
  capabilities: maybe(record(any)),
  health: maybe(record(any)),
});

/** 01 §21.1 `GET /api/engines/:engineId/schema`. */
export const SchemaCatalogGuard = obj({
  engineId: str,
  catalogVersion: opt(str),
  runtime: maybe(record(any)),
  facts: opt(record(any)),
  groups: arr(obj({ id: str, label: maybe(any), order: maybe(num) })),
  params: arr(obj({ id: str, type: opt(str), group: maybe(str), label: maybe(any) })),
  recipes: opt(arr(obj({ id: str }))),
});

/** 01 §4.1. */
export const EngineDescriptorGuard = obj({
  id: str,
  label: maybe(any),
  adapter: str,
  family: maybe(str),
  tier: maybe(any),
  status: maybe(str),
  artifactFormats: opt(arr(str)),
  runtimes: opt(any),
  capabilities: maybe(record(any)),
});

/** 01 §21.2 `GET /api/engines`: both managers' engines, the managers that did not answer (`errors[]`) and the external endpoints. */
export const EnginesResponseGuard = obj({
  engines: arr(EngineGuard),
  errors: opt(arr(any)),
  managers: opt(arr(any)),
  external: maybe(obj({ endpoints: opt(arr(any)) })),
});

/** 01 §20, §21.3: an external endpoint as an owner or a viewer reads it. It never carries a key. */
export const ExternalEndpointGuard = obj({
  endpointId: str,
  label: opt(str),
  kind: opt(str),
  enabled: opt(bool),
  baseUrl: opt(str),
  hostClass: opt(str),
  health: maybe(record(any)),
});

/** 01 §21.2 `GET /api/engines/external/endpoints`. */
export const ExternalEndpointsGuard = obj({ endpoints: arr(ExternalEndpointGuard) });

/** 01 §17, §21.1 `GET …/flags[?against=]`: the snapshot (`flags`) and, with `against`, the diff. */
export const FlagsResponseGuard = obj({ diff: maybe(record(any)), flags: maybe(record(any)), snapshot: maybe(record(any)) });

/** 01 §4, §21.1 `POST /api/engines/descriptors/validate`. */
export const DescriptorValidationGuard = obj({
  ok: bool,
  kind: opt(str),
  errors: arr(obj({ path: opt(str), code: opt(str), message: opt(str) })),
});

// ---------------------------------------------------------------------------
// 02: model cards, compatibility, fit, plans

/** 02 §4.3; the card schema requires every top-level field, the console relies on these. */
export const ModelCardGuard = obj({
  schema: oneOf("modelcard/v1"),
  cardId: str,
  contentDigest: maybe(str),
  ref: obj({ kind: str }),
  format: obj({ kind: str }),
  role: obj({ value: str, runnable: opt(bool) }),
  identity: record(any),
  support: opt(any),
  evidence: opt(any),
  warnings: opt(arr(any)),
  errors: opt(arr(any)),
});

/** 02 §9. */
export const CompatRowGuard = obj({
  engineId: str,
  runtimeId: maybe(str),
  verdict: oneOf("ok", "warn", "block", "unknown"),
  reasons: opt(arr(obj({ code: str, level: opt(str), message: opt(LocalizedTextGuard) }))),
  actions: opt(arr(any)),
  fitPreview: maybe(record(any)),
});

/** 02 §10.2. */
export const FitResultGuard = obj({
  status: oneOf("ok", "warn", "fail"),
  spill: opt(bool),
  perGpuMb: opt(record(num)),
  budgetMb: opt(record(num)),
  headroomMb: maybe(num),
  overflowMb: maybe(num),
  confidence: maybe(str),
  suggestions: opt(arr(obj({ code: str, param: maybe(str) }))),
});

/** 02 §10.8 / §17 `POST /api/models/:id/fit-grid`. */
export const FitGridGuard = obj({
  cardId: opt(str),
  engineId: opt(str),
  cells: arr(obj({
    kvDtype: str,
    concurrency: int,
    maxContext: maybe(int),
    limitedBy: maybe(str),
    status: maybe(str),
    spill: opt(bool),
    truncated: opt(bool),
  })),
  matrix: opt(arr(obj({ contextLength: int, concurrency: int, kvDtype: str, status: str }))),
});

/** 02 §11 planner output. */
export const PlanCardGuard = obj({
  planId: str,
  rank: opt(int),
  gpuIds: opt(arr(str)),
  goal: opt(str),
  engineId: str,
  runtimeId: maybe(str),
  recipeId: maybe(str),
  title: opt(LocalizedTextGuard),
  values: record(PlanValueGuard),
  fit: maybe(record(any)),
  support: maybe(record(any)),
  requiresProbe: opt(bool),
  validated: maybe(record(any)),
});

// ---------------------------------------------------------------------------
// 03: jobs, downloads, library

/** A manager job summary (`/api/jobs?fields=summary`, relayed `jobs` events). */
export const JobGuard = obj({
  id: str,
  type: maybe(str),
  status: maybe(str),
  state: maybe(str),
  error: maybe(any),
});

/** 03 §8.1. */
export const DownloadJobGuard = obj({
  id: str,
  state: str,
  createdAt: maybe(iso),
  artifact: maybe(obj({ provider: maybe(str), repo: maybe(str), revision: maybe(str) })),
  progress: maybe(obj({ bytesDone: maybe(num), bytesTotal: maybe(num), percent: maybe(num), speedBps: maybe(num), etaSeconds: maybe(num) })),
  error: maybe(obj({ code: str, title: opt(LocalizedTextGuard), hint: opt(LocalizedTextGuard) })),
});

/** 03 §9.2. */
export const LibraryEntryGuard = obj({
  id: str,
  kind: str,
  path: maybe(str),
  displayName: maybe(str),
  format: maybe(str),
  bytes: maybe(num),
});

// ---------------------------------------------------------------------------
// 04: telemetry

const SeriesPointGuard = refine(arr(any, { dropInvalid: false }), (point) => point.length === 2
  && typeof point[0] === "number"
  && (point[1] === null || typeof point[1] === "number" || Array.isArray(point[1])), "[time, value|null]");

/** 04 §11.3; a null value is a gap and renders as a break. */
export const TimeseriesGuard = obj({
  from: maybe(iso),
  to: maybe(iso),
  step: maybe(num),
  source: maybe(str),
  series: arr(obj({ metric: str, unit: maybe(str), group: maybe(record(any)), points: arr(SeriesPointGuard) })),
  annotations: opt(arr(obj({ at: num, type: str, title: maybe(str) }))),
});

/** 04 §11.4. */
export const BreakdownGuard = obj({
  dim: str,
  rows: arr(obj({ key: nullable(any), label: maybe(any), requests: maybe(num), share: maybe(num) })),
  total: maybe(record(any)),
});

/** 04 §11.5. */
export const RequestRowGuard = obj({
  requestId: str,
  receivedAt: iso,
  durationMs: maybe(num),
  ttftMs: maybe(num),
  terminalState: maybe(str),
  errorClass: maybe(str),
});

/** 04 §12 alert rows. */
export const AlertGuard = obj({
  ruleId: str,
  scopeKey: str,
  state: str,
  severity: str,
  title: maybe(any),
  since: maybe(iso),
  firedAt: maybe(iso),
  ackedAt: maybe(iso),
  silencedUntil: maybe(iso),
});
