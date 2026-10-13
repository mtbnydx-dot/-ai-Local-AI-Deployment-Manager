# Platform overhaul 2026-10: decisions and shared contracts

This file is binding for every overhaul workstream. Subsystem specs (`01-*.md` … `07-*.md`) refine it and must not contradict it. If a spec needs to change a contract here, change this file in the same commit and say why.

Diagnosis inputs: the ten-slice investigation of 2026-10-14 (engines, startup, params, new models, downloads, stats/audit, public service, frontend, engine landscape, comparable products).

## 1. Decisions

These are defaults chosen for the owner. Each is reversible, and the owner may override any of them.

| # | Decision | Why |
|---|---|---|
| D1 | **One console**, served by service-entry at `http://<host>:5176/`. It has one shell, one navigation and same-origin routes. The old console moves to `/classic`. The manager UIs on 5177/5178 stay reachable as "legacy" until parity, with a banner linking to the new console. | 5–6 UI shells on 3 origins is the root of "startup not intuitive" and "frontend dated". |
| D2 | **Buildless frontend.** Native ES modules plus vendored Preact + hooks + htm (ESM, no CDN, LICENSE files kept) and vendored uPlot for time series, all under `shared-public/vendor/`. There is no bundler, and `?v=` stamps are replaced by a single build id injected by the server. | The deploy copies files only, the release excludes `dist`, and the box must work offline. A component model is still needed for schema-driven forms. |
| D3 | **Two manager processes remain** as headless engine hosts: `vllm` on 5177 hosts engines `vllm`, `sglang` and data-only Docker engines; `llama` on 5178 hosts `llamacpp`. All lifecycle logic moves into a shared runtime core in `manager-core`. Merging the processes is deferred. | Merging gives the lowest risk-to-value ratio last. A shared core removes the fork without breaking ports, labels or contracts. |
| D4 | **Engines are data plus a small adapter.** There are three tiers. Tier 1 adapters (`vllm`, `sglang`, `llamacpp`) must reproduce today's argv byte for byte. The generic `docker-template` adapter lets a new Docker engine be added as a JSON descriptor only, with experimental descriptors shipped for LMDeploy, TensorRT-LLM and TabbyAPI. The `external` adapter registers any OpenAI-compatible endpoint (Ollama, LM Studio, remote servers) as a routable fleet member. KTransformers and MLC are out of scope. | This answers "cannot adapt to new engines" without a third forked manager. |
| D5 | **Model knowledge is layered data.** Data covers model families, template signatures, recipes, runtime flag catalogs and error signatures. Code keeps no model-family branches; a grep test enforces this after migration. | "No solution for new models." |
| D6 | **Downloads are owned by service-entry** through a `manager-core/model-hub` service. There is one queue, one ledger and one library registry. The managers keep their old download routes as forwarding shims. | Engine restarts and deploys no longer kill transfers, and the queue is no longer duplicated. |
| D7 | **Telemetry is owned by service-entry** in one `node:sqlite` store (`service-entry/data/telemetry.sqlite`). It is fed by a gateway request recorder, a runtime collector and a GPU collector. Each manager's `/api/stats` stays as a compatibility facade, with its sampling fixed. | Cross-engine views, request_id drill-down and alerting need a single store. |
| D8 | **Public traffic gets its own listener.** The PUBLIC listener on `127.0.0.1:5186` is the only target for cloudflared or Caddy. The ADMIN listener stays on 5176 and never honours forwarded headers. A platform-wide key store adds scopes, quotas and expiry. Existing per-manager keys migrate by `id` and `keyHash`, and the `/vllm/v1` and `/llama/v1` public paths stay as aliases. | The real public path bypasses the entry today, and admin is inferred from heuristics. |
| D9 | **Operations use one component registry, one `platform` CLI and an optional supervisor.** The registry is `manager-core/platform/components.js` with data at `manager-core/data/platform-components.json`. The CLI is `scripts/platformctl.js` with a root `platform.cmd` shim. The supervisor is `platform supervise`; autostart is registered by the owner running `platform autostart enable`, which no workstream runs. The old `.cmd` scripts become thin shims. Configuration lives in `<AI_ROOT>/config/platform.json`, with env > file > default precedence. | There are 19 scripts, 5 launchers and 138 env vars, nothing supervises the platform, and a month of failed nightly checks went unseen. |
| D10 | **Security fixes ship first (P0)** and never wait for a redesign: secrets out of argv and logs, trusted-proxy handling, manager CORS deny-by-default, idle-wake and admission bugs. | |

### Non-goals and hard rules

- Never modify the live root `<AI_ROOT>`, never restart services and never call mutating endpoints on running services. All work happens in worktrees under `<AI_ROOT>\worktrees\`.
- No new npm dependencies in `manager-core` or `service-entry`. The managers keep `express` only. Browser libraries are vendored files with licenses.
- No model container may be stopped or removed implicitly by new code paths. Destructive actions need an explicit user action with confirmation.
- Never print, log or persist plaintext API keys or tokens. Redact before `appendLog`.

## 2. Repository layout (new code goes here)

```
manager-core/
  engines/            registry.js, descriptor-schema.js, resolve-launch-plan.js, param-catalog.js,
                      runtime-supervisor.js, hosts/{docker,native,external}.js,
                      adapters/{vllm,sglang,llamacpp,docker-template,external}.js, metrics-map.js, log-phases.js
  model-inspector/    inspect.js (ModelCard), detectors/*.js, template-signatures.js, planner.js, compatibility.js
  model-hub/          providers/{huggingface,hf-mirror,modelscope}.js, queue.js, library.js, transfer.js, errors.js
  telemetry/          store.js, recorder.js, collectors/{runtime,gpu,events}.js, rollups.js, query.js, alerts.js
  platform/           components.js, config.js, doctor.js, version.js
  data/
    engines/*.json            engine descriptors (bundled)
    launch-params/*.json      parameter catalogs per engine
    recipes/*.json            validated launch recipes
    knowledge/{families,template-signatures,error-signatures}.json
    platform-components.json, platform-config.schema.json
service-entry/
  console/            new SPA: index.html, app.js, routes/*.js, components/*.js, i18n/{zh-CN,en-US}.json
  lib/                mgmt-proxy.js, events.js, hub-routes.js, telemetry-routes.js, keys-store.js,
                      public-listener.js, public-api.js, portal-routes.js, platform-routes.js
  portal/             public portal static pages (served only by the PUBLIC listener)
shared-public/vendor/ preact, hooks, htm, uplot (+ LICENSE files)
scripts/platformctl.js, platform.cmd (root shim)
deploy/cloudflare/    tunnel template (no secrets) targeting the PUBLIC listener
```

Overrides (none of these are in git):
- `<AI_ROOT>/config/engines/*.json`
- `<AI_ROOT>/config/recipes/*.json`
- `<AI_ROOT>/config/knowledge.d/*.json`
- `<AI_ROOT>/config/launch-params/*.json`
- `<AI_ROOT>/config/platform.json`

Overrides merge by `id`, are validated, and report errors at `GET /api/knowledge/status`. They never crash startup.

## 3. Identifiers

- **managerId**: `vllm` (5177) or `llama` (5178). This is the id used by the existing key scoping, billing HMAC allowlist, `/gateway/{vllm|llama}` and MCP. It is unchanged.
- **engineId**: `[a-z][a-z0-9-]{1,31}`. Built-ins are `vllm`, `sglang` and `llamacpp`. Shipped experimental descriptors are `lmdeploy`, `trtllm` and `tabbyapi`. `external` covers registered endpoints.
  - Legacy `engine` fields keep their current values (`vllm`/`sglang` inside vllm-manager, `vllm`/`llama` elsewhere).
  - New fields are named `engineId`. Unknown values are rejected with 400 `unknown_engine`; they are never coerced.
- **fleetId**: `${managerId}:${instanceId}`. External endpoints use `external:<endpointId>`.
- **runtimeId**: `${engineId}@${version}` (for example `sglang@0.5.17`, `sglang@flashnext-sm120-dac5523d`, `llamacpp@b10630`). This replaces the `sglangFlashNext` and `llamaMuse` manifest keys as identity. The old keys stay readable.
- **recipeId**: a kebab-case id, for example `pennyroyal-v251`, `qwen38-flashnext-262k`, `qwen38-vllm-mtp3`, `qwen38-dspark-sglang`, `qwen36-nvfp4-vllm`, `diffusiongemma-windows`, `llama-muse-glimmer`.
- **launchId**: `lch_<base32>`. It is persisted in the LaunchStore and stamped on the container as the label `ai.manager.launch-id`.
- **requestId**: `req_<20 base32 chars>`. The entry sets it on every gateway request when absent, propagates it as `x-request-id` to managers and engines, and returns it on every gateway response.
- **jobId**: unchanged for serve jobs. Hub download jobs use `dl_<base32>`.

## 4. Canonical objects

### 4.1 Instance (manager `GET /api/instances`, additive)

All legacy fields stay. The following fields are added:

```json
{
  "engineId": "sglang",
  "engineFamily": "sglang",
  "runtime": { "id": "sglang@0.5.17", "version": "0.5.17", "image": "…", "digest": "sha256:…" },
  "recipeId": "qwen38-flashnext-262k",
  "launchId": "lch_…",
  "lifecycle": { "state": "loading|ready|sleeping|stopped|crashed", "phase": "pull|admission|container|weights|kv|graphs|api|probe|ready", "percent": 0, "since": "ISO" },
  "capabilities": { "text": true, "vision": false, "audio": false, "embedding": false, "rerank": false, "tools": true, "reasoning": true, "maxContext": 262144 },
  "apiSurface": { "chat": true, "completions": true, "responses": false, "messages": false, "embeddings": false, "rerank": false },
  "vramReservationMb": 88000,
  "gpuIds": ["0"]
}
```

`capabilities` is declared from the ModelCard plus the launch options. The name regex in `model-fleet.js` stays only as a labelled fallback.

### 4.2 Error envelope (admin JSON APIs, new endpoints)

```json
{ "ok": false, "error": { "code": "snake_case", "message": "human text", "hint": "next step", "docs": "/docs/…" },
  "errors": [ { "field": "contextLength", "code": "out_of_range", "message": "…", "suggestion": { "value": 131072, "why": "…" } } ] }
```

Public API errors use the OpenAI shape (`{error:{message,type,code,param}}`) plus `request_id`. They never carry paths, ports or internals.

### 4.3 LaunchPlan (`POST /api/launch/plan` on a manager, side-effect free)

```json
{ "ok": true, "engineId": "vllm", "runtime": {}, "recipe": { "id": "…", "status": "verified|experimental|blocked", "locks": [{ "param": "…", "reason": "…" }] },
  "values": { "<paramId>": { "value": 0, "source": "user|recipe|model|knowledge|engine-default|platform-default", "reason": "…" } },
  "overrides": [ { "param": "…", "from": 0, "to": 0, "source": "recipe", "reason": "…" } ],
  "errors": [], "warnings": [],
  "command": { "argv": ["docker", "run", "…<redacted>…"], "env": { "VLLM_API_KEY": "<redacted>" }, "labels": {} },
  "memory": { "perGpuMb": { "0": 0 }, "breakdown": { "weights": 0, "kv": 0, "activations": 0, "draft": 0, "mmproj": 0, "overhead": 0 },
              "admissionRequestMb": 0, "kvPoolTokens": 0, "maxFullLengthRequests": 0, "policy": "device-fraction|free-fraction-after-weights|gguf-estimate|measured|server-reported" },
  "admission": { "verdict": "ok|warn|block", "message": "…" } }
```

`POST /api/start` must call the same resolver, so a plan always equals the execution. The old `/api/start` body fields stay accepted through an alias table.

### 4.4 ModelCard

The canonical shape is defined in `02-models.md`. It is cached by `(path, size, mtime)` or `(repo, revisionSha)`. Every fact carries an `evidence` entry with one of the confidences `declared`, `detected`, `name-heuristic` or `verified-on-host`. An unknown architecture yields `support: "unknown"` and is never shown as compatible.

### 4.5 Event stream (entry `GET /api/events`, SSE)

The envelope is `{ "type": "…", "at": "ISO", "source": "entry|vllm|llama|hub|telemetry", "data": {} }`. The types are:

- `status`, a coarse platform snapshot.
- `instances`, sent on change.
- `jobs`, for serve, benchmark and migration jobs from the managers.
- `downloads` and `library`.
- `alerts`, for firing and resolved alerts.
- `telemetry.live`, a KPI strip every 5 s.
- `notification`, which carries `{level, title, body, link}`.

Clients fall back to polling when SSE fails. Manager `/api/events` hubs keep working for the legacy UIs.

## 5. Cross-process contracts

- **Management proxy**: entry `ANY /api/m/:managerId/*` maps to `http://127.0.0.1:<managerPort>/api/*`, with SSE pass-through.
  - The entry enforces `checkManagementAccess`. Writes are admin-only, and LAN viewers get read-only access with redaction.
  - The proxy never forwards client `x-forwarded-*` headers. It adds `x-request-id`.
  - Managers keep their `isLocalRequest` gate.
- **Engine registry**: each manager serves `GET /api/engines` (its hosted engines, runtimes, health and capabilities) and `GET /api/engines/:engineId/schema?model=&runtime=` (the parameter catalog plus introspected choices plus matching recipes). The entry serves an aggregated `GET /api/engines` plus external endpoints.
- **Gateway**: `/gateway/{auto|vllm|llama}/{openai|claude|opencode}/…` is unchanged. `/gateway/<engineId>/…` and `/gateway/external/<endpointId>/…` are added. The `x-local-ai-route` header is kept for admin and debug keys only once D8 lands.
- **Docker labels**: keep every `ai.manager.*`, `ai.sglang.*` and `ai.runtime.*` label emitted today, and add `ai.manager.launch-id`, `ai.manager.engine-id` and `ai.manager.recipe`. Containers started by old code must be adopted without a restart.
- **MCP**: platform-mcp output enums keep accepting `vllm` and `llama`. `engine` widens to a validated string.

## 6. Must-keep compatibility (summary; details live in the slice specs)

- **External URLs**:
  - `/gateway/auto/openai/v1`, `/gateway/auto/claude[/v1/messages]`, `/gateway/auto/opencode/v1`, `/gateway/{vllm,llama}/…`, `/gateway/tts/*`, `/gateway/search/*`, `/gateway/mcp`, `/gateway/health`, `/gateway/status`.
  - The manager routes `/serve/v1`, `/claude`, `/v1/messages`, `/opencode/v1`.
  - MCP on `127.0.0.1:5190/mcp`.
- **Ports**: 5176, 5177, 5178, 5180 and 5190 are unchanged; 5186 is new.
- **Manager APIs** read by service-entry, platform-mcp and scripts:
  - `/api/status`, `/api/instances`, `/api/running-models`, `/api/models`, `/api/stats`, `/api/jobs?fields=summary`, `/api/tools/health`.
  - `/api/service-exposure`, `/api/memory-estimate` (body and response shape), `/api/idle-unload`, `/api/benchmarks[/compare]`.
  - `/api/manager/health`, `/api/manager/shutdown`, `/api/config`, `/api/start`, `/api/stop`, `/api/recent-launches`, `/api/tools/profiles`.
- **Entry APIs**: `/api/status` (`.ok`, `.components.offline`), `/api/fleet`, `/api/fleet/route-preview`, `/api/security`, `/api/keys`, `/api/managers/:id/start|stop`, `/api/stop-all`, `/api/shutdown`.
- **Persisted formats**: migrate them, never drop them.
  - `launch-profiles.json`, `recent-launches.json`, `jobs-ledger.json`, `stats-ledger.json`, `metrics-history.json`, `benchmark-history.json`.
  - The idle-unload ledgers, `service-clients.json`, `service-exposure-settings.json`, the billing SQLite (immutable tables), `model-storage.json` and `.gateway-trust.json`.
- **Validated recipes** must render byte-identical argv/env/labels: Pennyroyal v2.5.1, Flash-Next 262K, Qwen3.8 vLLM MTP, DSpark on SGLang, Qwen3.6 NVFP4, DiffusionGemma, and llama mmproj/DFlash/MTP/Muse. Golden tests come first, refactor second.

## 7. Engineering rules for every workstream

1. Work in your own worktree, created with `powershell -ExecutionPolicy Bypass -File scripts\new-worktree.ps1 -Branch <branch> -StartPoint <base>`, then run `install-all.cmd` there. Never edit `<AI_ROOT>` itself.
2. Run the package tests you touched (`npm test` in each), then the full `test-all.cmd` before your final commit. Report exact pass and fail counts.
3. New files outside the already-allowlisted directories must be added to `build-github-release.ps1`.
   - New root files go in `$releaseFiles`, and new Playwright specs go in the root `package.json` `test:frontend-smoke` script.
   - Files that `test-all.cmd` `node --check`s are listed explicitly there.
   - `.cmd` and `.ps1` files are CRLF without a BOM.
4. Browser files loaded by unit tests through `node:vm` must stay classic scripts, or the tests must change in the same commit.
5. Data files carry `schemaVersion`, `asOf` and `staleAfterDays`, and load through the `reference-data.js` override pattern.
6. Keep comment density and idiom consistent with the surrounding code. Write human-readable zh/en copy; never put raw flag names alone in user-facing labels.
7. Commit messages are conventional (`feat(engines): …`) and end with the attribution trailer given by the orchestrator.
8. Privacy: no usernames, machine names, absolute user paths, domains or keys in tracked files, tests or docs. The release build's privacy scan enforces this.

## 8. Phases and branches

Every branch is cut from the previous integration point. `feature/platform-overhaul-20261014` is the integration branch.

| Phase | Branch suffix | Scope |
|---|---|---|
| P0 | `-p0-*` | Correctness and security quick fixes (listed in `08-p0-fixes.md`) |
| P1 | `-engines` | Engine registry, adapters, catalog, recipes, resolver, plan API, supervisor core |
| P2 | `-models` | ModelInspector, knowledge layers, compatibility, planner, probe |
| P3 | `-hub` | Model hub, downloads center backend |
| P4 | `-telemetry` | Telemetry store, collectors, query APIs, alerts, audit browser API |
| P5 | `-public` | Listeners, trusted proxies, key store, public API, portal |
| P6 | `-ops` | Component registry, CLI, supervisor, doctor, config, deploy post-steps |
| P7 | `-console` | Unified console and design system |
| P8 | — | Adversarial review, fixes, docs, release dry-run |

## 9. Amendments from the cross-check (2026-10-14)

These amendments override anything above that they contradict.

1. **Memory policy.**
   - `LaunchPlan.memory.policy` gains `static-fraction-of-free` and `weights-plus-kv`. `static-fraction-of-free` is the SGLang/vLLM fraction of free memory, bounded by the budget. 08's `free-fraction` is renamed to `static-fraction-of-free`.
   - The 08 C1 gpu-admission fields are must-keep: `requestedFractionOfFree`, `poolCappedTokens`, `minClampMb`, `clamped` and `verdict`.
   - The estimator lives in 01 `manager-core/engines/memory-models.js`. 02 `fit.js` only supplies artifact inputs: weight bytes, KV bytes per token per layer kind, and extras.
   - There is one calibration store, owned by 02 (`manager-core/model-inspector/calibration.js`), at `<manager>/data/memory-calibration.json`. It is keyed by `(contentDigest, runtimeId, paramsKey)`, where `paramsKey = engines.paramsKey(plan)` = `ctx|conc|kv|maxTotalTokens`.
2. **Plan and launch.**
   - LaunchPlan gains `planHash`. Launch accepts `expectedPlanHash` and answers 409 `plan_changed` when it no longer matches.
   - Plans accept `prospective:true` with `model:{ref?|card?}`, so a plan can be made without the artifact on disk.
   - `steps[]` carries `{kind:'pull', image, required, policy:'auto'|'explicit'}`. Stable tier-1 images auto-pull before the checkpoint; this is today's behaviour and is must-keep. Experimental images block with `image_pull_required` until `POST /api/runtimes/:runtimeId/pull` runs; the pull is a job that reports progress through `jobs` events.
   - Plan problems return HTTP 200 with `ok:false` and `blockers[]`. 4xx is reserved for malformed requests.
3. **No implicit container stop.** This rule explicitly covers automatic actions: restore-models, wake and schedulers.
   - They use `mode:'add'` and `onConflict:'skip'`, and never replace a running container. A conflict produces a `notification` with a manual action.
   - Wake keeps the P0-RT-2 semantics, including 409 `wake_would_replace_running`, which is must-keep.
4. **Secrets at rest.**
   - There is one store: `manager-core/secret-store.js` at `<AI_ROOT>/.runtime/secrets/`.
     - Values are wrapped with Windows DPAPI CurrentUser through a PowerShell child process, so no npm dependency is needed.
     - The store has an owner-only ACL and is excluded from release and backup.
     - If DPAPI is unavailable, it falls back to ACL-only and doctor shows a warning.
   - No other file may hold secrets. hub-secrets.json and platform-secrets.json are not created, and the plaintext `logs/runtime-secrets.json` is migrated into the store.
   - HF tokens are memory-only unless the user opts in to storing them.
   - **Redaction:** `manager-core/secret-redactor.js` is the only redactor, and its marker is `<redacted>`. `scripts/scrub-job-ledgers.js` (P0-OBS-2) runs dry by default and writes only with `--apply`.
5. **Config ownership.** 06 OPS-3 solely owns three things: the `platform.json` schema, the env-to-key map (each env var maps to exactly one key), and the writer (`writePlatformConfig`, `readSection`, `writeSection`). The namespaces are:
   - `listeners.admin.{host,port,lan}`
   - `listeners.public.{enabled,host,port,baseUrl}`
   - `admin.*`
   - `trustedProxies.*`
   - `exposure.{requireApiKey,allowedOrigins}`
   - `managers.bindHost` (default `127.0.0.1`)
   - `console.defaultUi`
6. **Events.** `service-entry/lib/events.js` is owned by the wave-1 entry package **ENT-EV**, which is split out of 07 CON-0.
   - Event types: `status`, `instances`, `jobs`, `downloads`, `library`, `alerts`, `telemetry.live`, `notification`, `platform`, `security` and `access`.
   - Events carry `id:` lines and support `Last-Event-ID` replay and `GET /api/events/recent`.
   - The `notification` payload is `{kind, severity, title{zh,en}, body{zh,en}, action?{label{zh,en}, href|apiCall}}`.
   - The entry relays manager `jobs` and `instances` events.
   - **The management proxy `/api/m/:managerId/*` ships in ENT-EV (P1), not P7.**
   - ENT-EV also adds a route-mount table to `service-entry/server.js`. Later packages add `lib/<x>-routes.js` plus one mount line.
7. **Entry-to-manager trust.**
   - There is one signed hop, 05 PUB-10 v2. The signature covers method, path, ip, ts, requestId, principal, and the sha256 of `x-service-entry-context`, which carries 04's context JSON (rid, kid, cid, src, cc).
   - The verifier is `verifyEntryRequest(req) -> {principal, context}`.
   - **Internal auth:** one HMAC module, 05 `internal-auth.js`, covers the prefixes `/internal/billing/`, `/internal/access/`, `/internal/telemetry/` and `/internal/models/`.
   - Machine principals are `system:<component>`: hub-shim, supervisor and cli.
   - Unauthenticated marker headers such as `x-hub-shim` are forbidden.
8. **Admin access.**
   - A loopback caller is a viewer by default. Writes need an admin session, a token or a machine principal.
   - Viewer reads go through `service-entry/lib/viewer-allowlist.js`, and each route owner registers its routes there.
   - A `console-session` principal may call gateway paths on the ADMIN listener only. It gets scopes `chat:*` and `tts:*`, and telemetry records it as client `console`. The PUBLIC listener never accepts session cookies.
   - New error code: `csrf_invalid`.
   - Local single-user use must stay frictionless, through first-run pairing and a long-lived loopback session.
9. **Ids.**
   - requestId is `req_<20 base32>` and is always minted by the entry. Manager-direct requests use `mgr_`.
   - New ids: cardId `mc_`, `contentDigest` (sha256 hex), keyId `k_`, sleep record id `slp_`, and launchId `lch_<20 base32>`.
   - New Docker label: `ai.manager.runtime-id`.
   - Adopted unknown containers use `engineId:'unknown'`.
   - Corrected runtimeId example: `sglang@qwen38flashnext-sm120-dac5523d`. `sglangFlashNextNvme` maps to `sglang@flashnext-nvme-ple-20260831`, which is experimental and has no recipe.
10. **Vocabulary.**
    - 01's catalog param ids (`contextLength`, `concurrency`, `llamacpp.*`, and so on) are canonical for the planner, recipes, error signatures and UI. The provenance enum gains `planner`.
    - Descriptor fields are as 01 defines them: `artifactFormats`, `capabilities.roles`, and `capabilities.autoParsers{tool: string|null, reasoning: string|null}`.
    - Recipe `match` is `{familyId?, contentDigest?, runtimeId?, capabilityIds?}`, where `capabilityIds` is a deprecated alias. Recipes are validated by 01 `engines/recipe-schema.js`.
11. **Job error object.** Its shape is `{code, signatureId, phase, hint{zh,en}, logExcerpt}`, with the log excerpt redacted.
    - Hint data lives only in 02 `knowledge/error-signatures.json`. 01 descriptors may add engine-specific entries in the same schema, and one loader merges them.
    - There is one family-branch guard test, `manager-core/test/no-family-branches.test.js`, with one allowlist.
12. **Metrics.**
    - There is one parser module, `manager-core/engines/metrics.js` (01, ENG-10). It exports `parsePrometheus(text)`, `mapPrometheus(engineId, parsed)` (cumulative, used by the 04 collector) and `summarize(mapped)`.
    - There is one route, `GET /api/instances/:id/metrics` in `engines/routes.js`. It returns `{metrics, raw, facts, scrapedAt, unsupported[]}` with camelCase canonical keys.
    - The metricsMap kind is `histogram`.
13. **Stats compatibility.** These are must-keep:
    - 08 C2: `speed.windowSeconds` and `outputSource: counter_window | sglang_gen_throughput_gauge`, including the gauge fallback. TEL-1 only adds fields.
    - From 08 as well: disk-usage `roots[]`/`rootId`, `AI_AUDIT_REBASELINE_DAYS`, `PLATFORM_DOCKER_WAIT_SECONDS`, `/billing/classic`, and the unknown-architecture label `未知（未验证）`.
14. **Goldens.**
    - Goldens are captured once, from the post-P0 merge head after P0-RT-1. P0 creates no goldens.
    - Path: `manager-core/test/fixtures/engines/goldens/`.
    - Fixture files must not match `.gitignore` or robocopy excludes. Use a `.fixture` suffix or OPS-1's negation rule.
15. **Release and tests.**
    - After OPS-1, `release-manifest.json` is the release allowlist authority. Edit it, never `build-github-release.ps1`.
    - After OPS-2, test discovery is glob-based (`tests/frontend/**/*.spec.js`, `*/test/**/*.test.js`). Packages therefore do not edit `package.json` or `test-all.cmd` to register tests.
    - OPS-2 also adds the root devDependency `axe-core`.
16. **Frontend assets.**
    - There is one vendor tree, `shared-public/vendor/<pkg>/<version>/`, with a `VENDOR.json` covering preact, htm, uplot and qrcode. It is served on both 5176 and 5186.
    - There is one token file: `shared-public/styles/tokens.css`.
    - Console i18n is split per area into `console/i18n/<area>/{zh-CN,en-US}.json`. The areas are shell, models, hub, telemetry, access, platform and engines. A test checks that every key exists in both locales and that no key is duplicated across areas.
    - 07 owns every path under `service-entry/console/`. Page requirements from other specs become acceptance criteria of the CON packages.
    - Build id: 06 `getBuildId() -> {commit, contentHash}` is the single source.
17. **Misc.**
    - Manager `GET /api/config` adds `entryPort`.
    - Instance gains `lifecycle.phaseHistory` and `sleep.id`.
    - New manager-core subsystems export a namespace (`core.engines`, `core.models`, `core.platform`), never flat names.
    - Managers report observations to the entry through `POST /internal/models/host-records`, authenticated by internal-auth.
    - 03 uses 02's real APIs: `estimateFit` results map to the hub labels fits, spills and wont-fit, using a `spill` flag. 03 also uses 08's download error codes; the hub may add new codes as long as each maps from an 08 base code.
    - OPS-0 and HUB-P0a–e are deleted in favour of 08.
