# 04 — Telemetry, alerting, billing summaries and audit

Status: design spec for phase P4 (`-telemetry`). It refines decision D7 in `00-decisions-and-contracts.md` and is binding for P4 work packages. Section 25 lists the contract changes this spec needs in `00` and in sibling specs. Revised after the architect's cross-check of 2026-10-14 (issues 1–11). This spec now builds on the landed P0 code and on shared modules owned elsewhere, and no longer creates its own copies of them.

Scope: one telemetry store in service-entry; the gateway request recorder; runtime, GPU and event collectors; rollups and retention; query APIs; the compatibility facades (`/api/stats`, `/api/gateway-access`); the alert engine and its channels; the billing usage summary; audit additions (chain cap, export lock, scheduled exports, conversation browser API, audit-of-audit log); energy cost; importers from the existing ledgers; and the exact data contract for the console Observability and Audit pages (the pages themselves are built in P7).

Out of scope, consumed from their owners:
- console rendering and components (07);
- `service-entry/lib/events.js`, the management proxy, the manager SSE relay and the server.js route-mount table (07 **ENT-EV**, wave 1);
- the Prometheus parser `manager-core/engines/metrics.js` and the single `GET /api/instances/:id/metrics` route (01 **ENG-10**);
- admin sessions, machine principals, the viewer-allowlist registry, trust hop v2 (`verifyEntryRequest`) and `manager-core/internal-auth.js` (05 **PUB-5**, **PUB-10**);
- the `platform.json` schema, env map and writer (`readSection`/`writeSection`) and `manager-core/secret-store.js` (06 **OPS-3**);
- the secret redactor `manager-core/secret-redactor.js` (08 **P0-OBS-1**, marker `<redacted>`);
- supervisor toast delivery (06; this spec only emits the notification event).

## 1. Verified diagnosis (what this spec fixes)

Every item below was re-checked in the worktree code, not only taken from the diagnosis slice. The "P0 status" column says what 08 already fixes; this spec only adds the remainder on top of the landed P0 code.

| # | Defect | Evidence | P0 status → remainder here |
|---|---|---|---|
| F1 | "Current" tok/s and RPM measure UI polling, and every UI poll re-scrapes the engine (`updateSamples:true` forces `collectVllmMetricsSummaryFresh`). | `manager-core/stats-utils.js:125-148`; `vllm-manager/server.js:4189`, `:4242`; `llama-manager/server.js:2945`, `:2998` | P0-OBS-5 adds a 60 s ring window → TEL-1 adds a 10 s background sampler so `/api/stats` never scrapes |
| F2 | llama "recent" output speed is the lifetime gauge `llamacpp:predicted_tokens_seconds`; SGLang keeps the last positive `gen_throughput`. | `llama-manager/server.js:3138-3140`; `vllm-manager/server.js:4416-4425` | Fixed by P0-RT-5 (`outputSource`) → kept verbatim |
| F3 | Latency is `sum/count` since process start. `_bucket` series are parsed but never used. | `manager-core/prometheus-utils.js:49-53`; `vllm-manager/server.js:4409-4414` | Open → TEL-1 (`latency.window`), TEL-7 |
| F4 | Entry access rows carry `inputTokens: 0`, no request id, no TTFT. | `service-entry/server.js:1576-1608`, `:1224-1226` | Aborts and TTS noise fixed by P0-ENT-2 → TEL-5 recorder |
| F5 | Manager access rows use the socket address, have no request id, and are written on `finish` only. | `manager-core/gateway-utils.js:1587-1628` | Fixed by P0-OBS-3 (`onResponseDone`, `requestId`, vouched address) → TEL-2 adds key id, source and error class |
| F7 | Client-supplied `x-request-id` is trusted, and `service_usage_events` dedupes on `(manager, client_id, request_id)`. A client that reuses an id suppresses its own usage rows. | `manager-core/gateway-utils.js:331-341`; `manager-core/service-usage-store.js` (`idx_service_usage_request_idempotency`) | Open → the entry mints `req_…` (C1); manager-direct fallback becomes `mgr_…` |
| F8 | Both managers write the same audit root and cursor without a lock; nothing caps the number of chains. | `vllm-manager/server.js:186`, `llama-manager/server.js:149`; `manager-core/audit-store.js:282-304` | Chain-aware prune, empty skip, cursor race and stream errors fixed by P0-OBS-6 → TEL-15 adds the lock and `maxChains` |
| F9 | Billing "usage" is a raw-row list with no GROUP BY. | `service-entry/lib/billing-store.js:827-855` | P0-17 relabels only → TEL-14 adds the summary |
| F10 | Per-process VRAM is unavailable on this host (Windows WDDM). `nvidia-smi --query-compute-apps` returns `[N/A]` for `used_memory`. | read-only `nvidia-smi` run on the host, 2026-10-14 | Constraint → §8 |
| F11 | `node:sqlite` (Node 24.16, SQLite 3.53) supports WAL, FTS5 and the `trigram` tokenizer, which handles CJK substring search for queries of 3 or more characters. | probe in scratchpad | Capability → §4, §16.5 |

F6 is withdrawn. The manager normaliser `/^[a-zA-Z0-9._:/-]+$/` (`gateway-utils.js:325-329`) does accept `_`, and `req_k3m9q2x7p4a8c5d1h6j0` passes it. The real gap is the manager-direct fallback `crypto.randomUUID()` at `gateway-utils.js:335`, which TEL-2 switches to `mgr_…` (§5.1).

## 2. Architecture

```
                         service-entry process (5176 admin, 5186 public after D8)
 client ──► gateway handler ──► GatewayRecorder.begin() ─────────────┐
              │  req_ id + context JSON on 05 hop v2 ──► manager ──► engine
              │  tap(stream) → ResponseSniffer (usage, finish, first token, timings)
              └─ finalize via onResponseDone (P0-OBS-3) ──► row buffer (1 s) ──┐
 RuntimeCollector (10 s) ── GET manager /api/instances/:id/metrics (01 route, `raw`) ┤
 GpuCollector (10 s) ── nvidia-smi ─────────────────────────────────────┤──► TelemetryStore (worker_thread)
 EventCollector ── events.subscribe (ENT-EV), docker events, exit tails ┤      node:sqlite WAL
 /internal/telemetry/* ◄── managers, signed by 05 internal-auth.js ──────┘      service-entry/data/telemetry.sqlite
 RollupJob (30 s) · RetentionJob (1 h) · AlertEngine (15 s) · AuditScheduler (1 min)
 Query API /api/telemetry/* · /api/audit/* · /api/billing/usage/summary ──► console (07), MCP, scripts
 events.publish (ENT-EV) ──► /api/events: telemetry.live (5 s), alerts, notification ──► console bell; system:supervisor toast (06)
```

Placement rules:
- All SQL runs inside a `worker_threads` worker that owns the `DatabaseSync` handle. The gateway event loop never runs a synchronous SQLite call. The only exception is unit tests, which use `inProcess: true`.
- Managers never open `telemetry.sqlite`. They report through loopback calls signed by 05 `internal-auth.js` and spool to disk when the entry is down.
- Managers stay usable stand-alone: `/api/stats`, `/api/external-access` and `/api/access-logs/*` keep working from manager-local data.
- Telemetry is never on the request's critical path. A recorder or store failure must not change the response status, the headers or the bytes.

## 3. Modules and exported signatures

All new modules are CommonJS and add no npm dependencies (00 §1, hard rules).

`manager-core/telemetry/`

| File | Exports |
|---|---|
| `ids.js` | `newRequestId(): string` (returns `req_` plus 20 chars from RFC 4648 lowercase base32 `a-z2-7`, 100 random bits); `newDirectRequestId()` (same with prefix `mgr_`); `isTelemetryRequestId(s)`; `normalizeClientRequestId(s)`, which returns ≤128 chars matching `[A-Za-z0-9._:/-]`, or `""`. This is the reference minter for the 00 §3 format. PUB-8 and ENT-EV may import it or mint the same format themselves; the format, not the call site, is the contract, so no ordering constraint exists. |
| `schema.js` | `SCHEMA_VERSION`; `MIGRATIONS: Array<{version:number, up(db):void}>`; `TTL_DEFAULTS`. |
| `store.js` | `openTelemetryStore({file, inProcess=false, logger}) → Promise<TelemetryStore>`. TelemetryStore: `insertRequests(rows)`, `insertRuntimeSamples(rows)`, `insertGpuSamples(rows)`, `insertEvents(events)`, `appendAuditAccess(entry) → {seq, hash}`, `call(queryName, params)`, `runRollups(now)`, `runRetention(now, ttl)`, `getState(name)`, `setState(name, value)`, `stats()`, `close({flushMs=2000})`. Every method returns a Promise. |
| `store-worker.js` | Worker entry. It opens the DB, applies PRAGMAs and migrations, then dispatches `{id, method, args}` messages. |
| `route-class.js` | `classifyGatewayRoute(method, pathname) → {kind:'traffic'|'control'|'static', protocol, op, route}`. |
| `error-class.js` | `ERROR_CLASSES`, `TERMINAL_STATES`, `classifyOutcome({phase, status, code, upstreamErrorText, aborted, timedOut, streamError}) → {terminalState, errorClass, errorCode}`. |
| `source-program.js` | `inferSourceProgram({userAgent, origin, referer, protocol, path, xTitle}) → slug`, and `SOURCE_PROGRAM_LABELS` (zh/en). `access-log.js#inferAccessSourceProgram` becomes `labelFor(inferSourceProgram(...), 'zh')`, so its output is unchanged. |
| `histogram.js` | `GATEWAY_MS_BUCKETS`, `DECODE_TPS_BUCKETS`, `newHist(le)`, `observe(hist, v)`, `mergeHist(a, b)`, `deltaCumulative(prev, cur)`, which returns null on a reset, and `quantile(hist, q)`, which uses Prometheus `histogram_quantile` linear interpolation. |
| `sniffer.js` | `createResponseSniffer({protocol, stream, contentType, estimatedInputTokens}) → {push(chunk, tMs), finish() → {usage, finishReason, firstTokenAt, engineTimings, upstreamError}}`. |
| `recorder.js` | `createGatewayRecorder({store, now, monotonic, lookupCustomer, onRow, bufferMax=10000, flushMs=1000})`. Returns `{begin(req, res, init) → RecordHandle, inflight(), stats(), flush()}`. |
| `collectors/manager-stats-sampler.js` | Runs inside the managers. `createStatsSampler({intervalMs, listInstances, scrapeInstance, now, onTick}) → {start(), stop(), latest(instanceId), window(instanceId, seconds), lastScrape(instanceId) → {text, scrapedAt}|null}`. `lastScrape` lets 01's metrics route reuse a fresh scrape (§7.1). |
| `collectors/runtime.js` | `createRuntimeCollector({store, listFleetInstances, fetchInstanceMetrics, requestLatency, intervalMs=10000, now, events})`. It reads the `raw` part of 01's route; it never parses Prometheus text itself. |
| `collectors/gpu.js` | `createGpuCollector({store, execFile, intervalMs=10000, now, events})`, `parseNvidiaSmiTelemetry(stdout, fields)`, `decodeThrottle(mask)`. |
| `collectors/events.js` | `createEventCollector({store, events, managers, dockerEvents, tailFiles, now})`. `events` is the ENT-EV module; the collector only calls `events.subscribe`. |
| `rollups.js` | `rollupRequests(db, grain, fromBucket, toBucket)`, `rollupSamples(db, kind, grain, …)`, `markDirty(db, atMs)`, `runRetention(db, ttl, now)`. These run inside the worker. |
| `query.js` | `METRICS` catalog, `DIMENSIONS`, `timeseries(db, q)`, `summary(db, q)`, `breakdown(db, q)`, `listRequests(db, q)`, `getRequest(db, id)`, `listEvents(db, q)`, `exportRows(db, q, sink)`, `energy(db, q)`, `lifecycle(db, q)`, `launches(db, q)`, `live(db, mem)`. These run inside the worker. |
| `alerts.js` | `DEFAULT_ALERT_RULES`, `ALERT_METRICS`, `createAlertEngine({store, notify, now, intervalMs=15000})`. |
| `notify.js` | `createNotifier({events, webhooks, secretStore, fetch, now})`, `formatWebhook(format, alert)`, `assertSafeWebhookUrl(url)`. `secretStore` is OPS-3 `manager-core/secret-store.js`, namespace `webhooks`. |
| `energy.js` | `integrateEnergyWh(prev, cur)`, `priceAt(atMs, energyConfig)`, `costOf(whByHour, energyConfig)`. |
| `importers.js` | `IMPORT_SOURCES`, `runImport({sources, aiRoot, store, dryRun, onProgress}) → report`. |
| `ingest-client.js` | Runs in the managers. `createTelemetryIngestClient({managerId, internalClient, spoolFile, maxSpoolBytes=20MiB}) → {report(kind, rows), flush(), stats()}`. `internalClient` is `createInternalClient({managerId, root})` from 05 `manager-core/internal-auth.js`; this module never signs anything itself. |
| `audit-chain.js` | `groupAuditChains(exports)` and `planAuditRetention(exports, policy, now) → {keep, remove:[{auditId, reason}], warnings, needsRebaseline}`. Both are pure functions. `policy = {maxExports, maxAgeDays, rebaselineDays, maxChains}`; the first three are P0-OBS-6's rules moved here unchanged (§16.2). |
| `audit-index.js` | `openAuditIndex({file})`, `indexExport(auditDir, manifest)`, `removeExport(auditId)`, `searchChats(q)`, `getChat(chatId, {auditId})`, `chatVersions(chatId)`. |
| `audit-scheduler.js` | `createAuditScheduler({auditStore, index, store, config, now, events})`. |
| `audit-access-log.js` | `canonicalAuditRow(entry)`, `chainHash(prevHash, row)`, `verifyChain(rows)`. |
| `schemas.js` | Lightweight response validators for the fixtures used by the 07 Playwright tests (TEL-19). |

Files this spec does **not** edit, and what it consumes from them:
- `manager-core/gateway-trust.js` and the trust parts of `gateway-utils.js` (05 PUB-10): `verifyEntryRequest(req) → {principal, context, requestId, clientAddress} | null` and `buildGatewayTrustHeadersV2(token, {method, pathname, clientIp, requestId, principal, context}, now)`. 04 defines only the content of `context` (§5.2).
- `manager-core/internal-auth.js` (05 PUB-10): `buildInternalRequestHeaders`, `verifyInternalRequest(req, rawBody, token, {allowedManagers, pathPrefixes})` and `createInternalClient`. Its prefix list includes `/internal/telemetry/`. `billing-client.js` is untouched by TEL.
- `manager-core/engines/metrics.js` and `engines/routes.js` (01 ENG-10): `parsePrometheus(text)`, `mapPrometheus(engineId, parsed)`, `summarize(mapped)` and the single metrics route (§7.1).
- `service-entry/lib/events.js`, `mgmt-proxy.js` and the route-mount table in `server.js` (07 ENT-EV): `publish(type, payload)`, `subscribe(fn, {types}) → unsubscribe`, `subscriberCount({types?, principal?})`.
- `manager-core/platform/config.js` (06 OPS-3): `readSection(name) → {value, etag}` and `writeSection(name, patch, {etag}) → {ok, etag, changed, restartRequired, errors}`; `manager-core/secret-store.js` (06 OPS-3): `get(ns, key)`, `set(ns, key, value)`, `has(ns, key)`, `clear(ns, key)`.
- `manager-core/secret-redactor.js` (08 P0-OBS-1): `redactSecrets`, `redactValue`. Every redaction in this spec uses it, with the marker `<redacted>`. TEL defines no redact helper of its own.
- `service-entry/lib/viewer-allowlist.js` (05 PUB-5): the registry that 04's GET routes and event types register with (§11.8).

`service-entry/lib/`
- `telemetry-runtime.js`: `createTelemetryRuntime({aiRoot, dataDir, managers, auth, getBillingStore, events, getFleetCatalogs, docker, execFile, config, secretStore}) → {start(), stop(), recorder, handleHttp(req,res,url) → bool, handleInternal(req,res,url) → bool, status()}`.
- `telemetry-routes.js`: handles `/api/telemetry/*`. It is mounted with one line in ENT-EV's route-mount table.
- `telemetry-viewer.js`: the viewer redaction functions and `registerTelemetryViewerRoutes(allowlist)` (§11.8).
- `audit-http.js`: handles `/api/audit/*` on the entry, also mounted through the table.
- `billing-http.js` and `billing-store.js`: summary additions (§15).

## 4. Storage

### 4.1 File, PRAGMAs, process

- The file is `service-entry/data/telemetry.sqlite`, overridable with `telemetry.dbPath` (env `AI_TELEMETRY_DB`, §20). `service-entry/data` is already excluded from the release.
- PRAGMAs: `auto_vacuum=INCREMENTAL` (set before the first table exists), `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`, `temp_store=MEMORY`, `cache_size=-16000`, `journal_size_limit=67108864`.
- Writes are batched: one transaction per flush, at 1 s or 500 rows.
- Migrations run in a transaction at open and record `schema_meta.schemaVersion`. A migration never drops a column or table that holds data. If the open fails, telemetry runs in a degraded mode: the live snapshot works from memory, writes are discarded with a counter, `/api/telemetry/status` reports `store: "unavailable"`, and the `telemetry_store` alert fires. The file is never deleted or recreated automatically.
- Backup: `scripts/backup-platform.ps1` adds `service-entry\data\telemetry.sqlite` through `sqlite-snapshot.js` (VACUUM INTO). The audit-of-audit log lives in this file.

### 4.2 Tables (DDL, schemaVersion 1)

Times are epoch milliseconds (INTEGER, UTC). The APIs render them as ISO 8601.

```sql
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE collector_state (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE coverage_1m (bucket INTEGER NOT NULL, component TEXT NOT NULL, PRIMARY KEY (bucket, component)) WITHOUT ROWID;

CREATE TABLE requests (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,         -- req_… (entry) | mgr_… (manager-direct) | imp_… (import)
  client_request_id TEXT,                  -- inbound x-request-id, normalised
  manager_request_id TEXT,                 -- the id the manager used upstream and for billing (= request_id when via entry)
  ingress TEXT NOT NULL,                   -- entry | public | direct | import:entry | import:manager
  received_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
  manager_id TEXT, fleet_id TEXT, engine_id TEXT, runtime_id TEXT, launch_id TEXT,
  protocol TEXT NOT NULL,                  -- openai | claude | opencode | tts | search | mcp | external
  op TEXT NOT NULL,                        -- chat | completions | responses | messages | count_tokens | embeddings | rerank | speech | tts_batch | search | tool | models | other
  route TEXT,                              -- auto | vllm | llama | <engineId> | external:<id>
  method TEXT NOT NULL, path TEXT NOT NULL,  -- path without query string, ≤ 200 chars
  model_requested TEXT, model_resolved TEXT, stream INTEGER NOT NULL DEFAULT 0,
  key_id TEXT, customer_id TEXT, auth_source TEXT,
  client_ip TEXT, client_country TEXT, user_agent TEXT, origin_host TEXT,
  source_program TEXT NOT NULL DEFAULT 'unknown',
  owui_user_id TEXT, owui_chat_id TEXT,    -- untrusted hints from OpenWebUI forwarded headers
  status INTEGER NOT NULL,                 -- status sent to the client; 499 when the client left before headers
  terminal_state TEXT NOT NULL CHECK (terminal_state IN ('completed','failed','client_abort','timeout','rejected')),
  error_class TEXT NOT NULL,               -- §5.4; 'none' on success
  error_code TEXT,                         -- machine code only, never a free-text message
  queue_ms INTEGER, upstream_headers_ms INTEGER, ttft_ms INTEGER, duration_ms INTEGER NOT NULL,
  decode_tps REAL,
  prompt_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
  usage_source TEXT CHECK (usage_source IN ('reported','estimated','missing')),
  finish_reason TEXT,                      -- stop | length | tool_calls | content_filter | abort | error | other
  bytes_out INTEGER,
  engine_prompt_ms REAL, engine_decode_tps REAL, engine_cached_tokens INTEGER,
  extra TEXT                               -- JSON ≤ 2 KiB: {toolSchemaCount, toolUseCount, ttsCharacters, audioMs, routeReason, dupOf}
);
CREATE INDEX requests_received ON requests(received_at);
CREATE INDEX requests_key ON requests(key_id, received_at);
CREATE INDEX requests_fleet ON requests(fleet_id, received_at);
CREATE INDEX requests_model ON requests(model_resolved, received_at);
CREATE INDEX requests_err ON requests(error_class, received_at) WHERE error_class <> 'none';
CREATE INDEX requests_ip ON requests(client_ip, received_at) WHERE client_ip IS NOT NULL;
CREATE INDEX requests_mgr_rid ON requests(manager_request_id) WHERE manager_request_id IS NOT NULL;
CREATE INDEX requests_owui ON requests(owui_chat_id) WHERE owui_chat_id IS NOT NULL;

-- Request rollups: one schema for three grains.
CREATE TABLE rollup_1m (
  bucket INTEGER NOT NULL,
  manager_id TEXT NOT NULL DEFAULT '', fleet_id TEXT NOT NULL DEFAULT '', engine_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '', key_id TEXT NOT NULL DEFAULT '', customer_id TEXT NOT NULL DEFAULT '',
  source_program TEXT NOT NULL DEFAULT '', protocol TEXT NOT NULL DEFAULT '',
  status_class TEXT NOT NULL DEFAULT '', error_class TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL, completed INTEGER NOT NULL, client_aborts INTEGER NOT NULL, streams INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, estimated_usage INTEGER NOT NULL,
  finish_length INTEGER NOT NULL, finish_tool INTEGER NOT NULL,
  duration_ms_sum INTEGER NOT NULL, ttft_ms_sum INTEGER NOT NULL, ttft_n INTEGER NOT NULL,
  decode_tps_sum REAL NOT NULL, decode_tps_n INTEGER NOT NULL,
  ttft_hist TEXT, duration_hist TEXT, decode_hist TEXT,   -- JSON int arrays over GATEWAY_MS_BUCKETS / DECODE_TPS_BUCKETS
  source TEXT NOT NULL DEFAULT 'live',                      -- live | import
  PRIMARY KEY (bucket, manager_id, fleet_id, engine_id, model, key_id, customer_id, source_program, protocol, status_class, error_class, source)
) WITHOUT ROWID;
-- rollup_1h and rollup_1d: the migration repeats the rollup_1m DDL verbatim (same columns, PK, WITHOUT ROWID).
-- Do not use CREATE TABLE … AS SELECT, which drops the PK. For rollup_1d, bucket = local-midnight epoch ms (§10).
CREATE TABLE control_counts_1m (bucket INTEGER NOT NULL, route TEXT NOT NULL, status_class TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (bucket, route, status_class)) WITHOUT ROWID;
CREATE TABLE rollup_dirty (grain TEXT NOT NULL, bucket INTEGER NOT NULL, PRIMARY KEY (grain, bucket)) WITHOUT ROWID;

CREATE TABLE runtime_samples (
  at INTEGER NOT NULL, fleet_id TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
  manager_id TEXT NOT NULL, engine_id TEXT, runtime_id TEXT, launch_id TEXT, runtime_key TEXT NOT NULL,
  interval_ms INTEGER, scrape_ok INTEGER NOT NULL, error_code TEXT, reset INTEGER NOT NULL DEFAULT 0, idle INTEGER NOT NULL DEFAULT 0,
  d_prompt_tokens INTEGER, d_cached_tokens INTEGER, d_output_tokens INTEGER, d_requests INTEGER,
  d_errors INTEGER, d_aborts INTEGER, d_finish_length INTEGER,
  prompt_tps REAL, output_tps REAL, rpm REAL,
  running REAL, waiting REAL, kv_usage REAL, kv_capacity_tokens INTEGER,
  prefix_hit_rate REAL,                      -- d_cached_tokens / d_prompt_tokens; rollups recompute it from the sums
  d_spec_draft_tokens INTEGER, d_spec_accepted_tokens INTEGER, spec_accept_rate REAL,
  ttft_p50_ms REAL, ttft_p95_ms REAL, ttft_p99_ms REAL, e2e_p50_ms REAL, e2e_p95_ms REAL,
  itl_p50_ms REAL, itl_p95_ms REAL, tpot_p50_ms REAL, queue_p95_ms REAL,
  latency_source TEXT,                       -- engine_histogram | gateway | none
  hist TEXT,                                 -- JSON {ttft:{le:[…],d:[…]}, e2e, itl, tpot, queue}: interval deltas
  energy_wh REAL,                            -- attributed share (§14)
  PRIMARY KEY (fleet_id, model, at)
) WITHOUT ROWID;
CREATE INDEX runtime_samples_at ON runtime_samples(at);
-- runtime_rollup_1m / _1h / _1d: (bucket, fleet_id, model) PK; sums of d_*; avg and max of running, waiting, kv_usage;
-- idle_seconds, sample_count, scrape_failures, energy_wh, merged hist JSON, and p50/p95/p99 columns recomputed from merged hist.

CREATE TABLE gpu_samples (
  at INTEGER NOT NULL, gpu_index INTEGER NOT NULL, gpu_uuid TEXT, name TEXT,
  util_pct REAL, mem_util_pct REAL, mem_used_mb REAL, mem_total_mb REAL, temp_c REAL, mem_temp_c REAL,
  power_w REAL, power_limit_w REAL, fan_pct REAL, sm_clock_mhz REAL, mem_clock_mhz REAL, sm_clock_max_mhz REAL, pstate TEXT,
  throttle_mask INTEGER, throttle TEXT,      -- decoded reason slugs, comma-separated
  energy_wh REAL,
  procs TEXT,                                -- JSON [{pid, name, usedMb}] only when nvidia-smi reports numbers; NULL on WDDM
  PRIMARY KEY (gpu_index, at)
) WITHOUT ROWID;
-- gpu_rollup_1m / _1h / _1d: (bucket, gpu_index) PK; util avg and max, mem_used max, temp avg and max, power avg and max,
-- energy_wh sum, idle_energy_wh, throttle_seconds JSON {reason: seconds}, sample_count.

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
  type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  source TEXT NOT NULL, manager_id TEXT, fleet_id TEXT, launch_id TEXT, request_id TEXT,
  title TEXT NOT NULL, data TEXT, dedupe_key TEXT UNIQUE
);
CREATE INDEX events_at ON events(at);
CREATE INDEX events_type ON events(type, at);
CREATE INDEX events_fleet ON events(fleet_id, at);

CREATE TABLE alert_rules (
  rule_id TEXT PRIMARY KEY, builtin INTEGER NOT NULL, enabled INTEGER NOT NULL,
  metric TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '{}',
  op TEXT NOT NULL CHECK (op IN ('>','>=','<','<=')), threshold REAL NOT NULL, clear_threshold REAL,
  window_s INTEGER NOT NULL, for_s INTEGER NOT NULL, min_samples INTEGER NOT NULL DEFAULT 0,
  severity TEXT NOT NULL, channels TEXT NOT NULL, cooldown_s INTEGER NOT NULL DEFAULT 1800,
  title_zh TEXT NOT NULL, title_en TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT
);
CREATE TABLE alert_state (
  rule_id TEXT NOT NULL, scope_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ok','pending','firing')),
  since INTEGER NOT NULL, last_eval_at INTEGER NOT NULL, last_value REAL,
  fired_at INTEGER, resolved_at INTEGER, last_notified_at INTEGER, fire_count INTEGER NOT NULL DEFAULT 0,
  acked_at INTEGER, acked_by TEXT, silenced_until INTEGER,
  PRIMARY KEY (rule_id, scope_key)
) WITHOUT ROWID;

CREATE TABLE audit_access_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
  source TEXT NOT NULL,                  -- entry | vllm | llama
  actor TEXT NOT NULL,                   -- 05 principal: 'session:<id prefix>', 'token:<id>', 'system:<component>' or 'legacy-local'
  session TEXT,                          -- sha256(audit token)[0..12]
  client_ip TEXT, user_agent TEXT,
  action TEXT NOT NULL,                  -- §16.4
  target TEXT, outcome TEXT NOT NULL CHECK (outcome IN ('ok','denied','error')),
  detail TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE
);
CREATE TRIGGER audit_access_log_no_update BEFORE UPDATE ON audit_access_log BEGIN SELECT RAISE(ABORT, 'audit_access_log is append-only'); END;
CREATE TRIGGER audit_access_log_no_delete BEFORE DELETE ON audit_access_log BEGIN SELECT RAISE(ABORT, 'audit_access_log is append-only'); END;

CREATE TABLE lifetime_baseline (manager_id TEXT NOT NULL, model TEXT NOT NULL, engine TEXT, first_seen INTEGER, last_seen INTEGER,
  prompt_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER, requests INTEGER, errors INTEGER,
  source TEXT NOT NULL, imported_at INTEGER NOT NULL, PRIMARY KEY (manager_id, model, source)) WITHOUT ROWID;
CREATE TABLE import_runs (id INTEGER PRIMARY KEY, source TEXT NOT NULL, file_key TEXT NOT NULL, started_at INTEGER NOT NULL,
  finished_at INTEGER, rows_in INTEGER, rows_written INTEGER, rows_skipped INTEGER, status TEXT NOT NULL, detail TEXT,
  UNIQUE (source, file_key));
```

### 4.3 Retention (TTL)

| Table | Grain | Default TTL | Config key (`platform.json` → `telemetry.retention.*`) |
|---|---|---|---|
| `requests` | per request | 30 days | `requestsDays` (7–365) |
| `requests.client_ip`, `user_agent` | — | masked after 30 days (equal to the row TTL) | `ipDays` (1 ≤ ipDays ≤ requestsDays). Masking is an UPDATE to `a.b.c.x` / `xxxx:xxxx:…` with UA set to NULL. |
| `runtime_samples`, `gpu_samples` | 10 s | 48 hours | `samplesHours` (12–336) |
| `rollup_1m`, `runtime_rollup_1m`, `gpu_rollup_1m`, `control_counts_1m`, `coverage_1m` | 1 min | 14 days | `minuteDays` |
| `rollup_1h`, `runtime_rollup_1h`, `gpu_rollup_1h` | 1 h | 400 days | `hourDays` |
| `*_1d` | 1 day | forever | — |
| `events` | — | 400 days. Types `launch.*`, `instance.*`, `container.*`, `manager.*`, `audit.*`, `config.*`, `security.ban`: forever. `mcp.tool_call`: 90 days. | `eventsDays` |
| `alert_state` | current state only | — | history lives in `events` (`alert.*`) |
| `audit_access_log` | — | forever, append-only, hash-chained | — |
| `lifetime_baseline`, `import_runs` | — | forever | — |

The retention job runs hourly. It deletes in batches of 5000 rows by rowid or PK range, yields 20 ms between batches, then runs `PRAGMA incremental_vacuum(2000)` and, once a day, `PRAGMA optimize`. Size guard: when `page_count*page_size` exceeds `telemetry.maxDbMb` (default 2048), raw `requests` older than 7 days and samples older than 12 hours are deleted first, and the event `telemetry.retention.pressure` is recorded (warning).

## 5. Identity, propagation and classification

### 5.1 Request id

- Any entry component that receives a gateway request first mints `request_id` in the 00 §3 format: TEL-5's `recorder.begin` today, and PUB-8's pipeline step 1 once it lands, which passes its id to `recorder.begin({requestId})`. There is one id per request. A client-sent `x-request-id` is normalised into `client_request_id`, removed from the upstream headers, and replaced by the minted id. This is contract change C1: the inbound value is never trusted as a key (F7).
- The entry returns `x-request-id: req_…` on every gateway response, including rejections. It returns `x-client-request-id` when the client sent one.
- Managers: the normaliser is **unchanged**; it already accepts `req_…` (F6 withdrawn). `ensureOpenAiGatewayRequestId` (P0-OBS-3 already propagates it into the access log) gains one delta in TEL-2: on a verified v2 hop it uses `hop.requestId`, and the manager-direct fallback changes from `crypto.randomUUID()` to `newDirectRequestId()` (`mgr_…`). A valid client `x-request-id` on a direct call is still honoured as today. The billing-internal id at `gateway-utils.js:1197` stays a UUID.
- Telemetry rows for direct ingress get `request_id = <the manager id when it starts with mgr_, else newDirectRequestId()>` and `manager_request_id = <the id the manager used>`.
- Billing join: `billing_usage_events.external_request_id IN (requests.request_id, requests.manager_request_id)`.

### 5.2 Entry context on trust hop v2 (05 PUB-10)

There is one signed entry→manager hop, owned by 05 PUB-10. 04 adds no header signature, no key id and no gateway-trust code. The entry puts 04's context JSON into `x-service-entry-context`. PUB-10's v2 signature input is `method, path, ip, ts, requestId, principal, sha256(x-service-entry-context)`, so the context is covered by the same signature and the same 60 s replay window.

```
x-request-id: req_k3m9q2x7p4a8c5d1h6j0
x-service-entry-principal: …                     (05)
x-service-entry-context: eyJ2IjoxLCJzcmMiOiJvcGVud2VidWkiLCJjYyI6IkNOIn0
x-service-entry-signature-v2: …                  (05; covers sha256 of the context header value)
```

The context is base64url JSON of at most 256 bytes. It holds only what neither the principal nor the request id carries:
```json
{ "v": 1, "src": "openwebui", "cc": "CN" }
```
`src` is the source-program slug (§5.3) and `cc` the trusted-proxy country (or omitted). The key id comes from `principal.k` and the listener from `principal.l`.

- The entry passes `context` to `buildGatewayTrustHeadersV2` in PUB-8's `service-entry/lib/gateway-pipeline.js`, where PUB-10 builds the v2 headers (PUB-10 depends on PUB-8).
- Managers call `verifyEntryRequest(req)`. A `null` result means no valid v2 hop (no hop, a v1 hop or a bad signature): the request is direct ingress. A context that fails to parse, or has an unknown `v`, gives `context = null` without rejecting the hop.
- Managers use a verified hop for these purposes:
  - the request id (`hop.requestId`);
  - the access-log `keyId` (`principal.k`) and `sourceProgram` (`context.src`);
  - `viaEntry: true`, with `remoteAddress = hop.clientAddress`;
  - suppressing direct-ingress telemetry reports, because the entry already records the request.
- The context never carries the API key, the customer name or the user agent.

### 5.3 Client identity

| Field | Source |
|---|---|
| `client_ip` | `security.resolveClientIdentity(req).ip` from 05. Until that lands, `security.resolveClientAddress(req)`. Never a raw XFF header from an untrusted socket. |
| `client_country` | `CF-IPCountry`, only when 05 marks the hop as a trusted Cloudflare proxy; otherwise NULL. |
| `key_id` | `auth.keyId` (05 key store) or the legacy `auth.client.id`. A global key is `global-<hash24>`, the same id billing uses (`service-policy.js:63-66`). |
| `customer_id` | `auth.customerId` (05). Fallback: `billingStore.lookupCustomerForCredential(managerId, clientId)`, a new read-only export cached for 60 s. |
| `source_program` | Slug from `inferSourceProgram`. Order: `X-Title` or `x-ai-client` header (normalised to `[a-z0-9-]{1,40}`), then UA rules (the same rules as `access-log.js:215-241`), then origin host, then protocol. Slugs: `openwebui, chatbox, lobechat, workbuddy, claude-code, claude-compat, opencode, openai-python, openai-node, python, curl, powershell, node, go, java, cherry-studio, cursor, browser, unknown`. Labels for these slugs are i18n entries. |
| `owui_user_id`, `owui_chat_id` | `x-openwebui-user-id` and `x-openwebui-chat-id` headers when present. They are untrusted hints, used only for audit-link candidates behind the audit unlock. Email and name headers are ignored. |

### 5.4 Terminal state and error taxonomy (`error-class.js`)

`phase` is `pre_upstream`, `upstream` or `stream`. The first matching row wins.

| Condition | terminal_state | error_class |
|---|---|---|
| Finished, status < 400, no stream error | completed | none |
| `close` before `finish`, not a timeout | client_abort | client_abort |
| Entry or manager timeout; 504; `request_timeout`; `timed_out` | timeout | upstream_timeout |
| 401; code `unauthorized` or `invalid_api_key` | rejected | auth_failed |
| 429 `auth_banned` | rejected | auth_banned |
| 403 `manager_forbidden`, `model_forbidden`, `origin_not_allowed`, `local_only`, `scope_forbidden`, `tts_model_management_local_only` | rejected | forbidden |
| 429 `rate_limit_exceeded`, `concurrency_queue_timeout`, `concurrency_queue_full`, `tpm_limit_exceeded` | rejected | rate_limited |
| 402 or 429 `billing_quota_exhausted`, `billing_insufficient_balance`, `insufficient_quota`, TTS allowance codes | rejected | quota_denied |
| 503 `billing_unavailable` | rejected | billing_unavailable |
| 503 `manager_offline`, `tts_gateway_offline`, `no_matching_model`, `model_not_loaded`, `fleet_settings_unavailable`, or a fleet selection error | rejected | no_runtime |
| 503 `api_key_not_configured`, `key_store_unreadable` | rejected | config_error |
| 400 with upstream text matching `/maximum context|context length|too many tokens|prompt is too long|exceeds .*context/i` | failed | context_overflow |
| Other 400/404/405/413/415/422 | rejected (pre_upstream) or failed (upstream) | bad_request |
| Fetch failure, `gateway_proxy_error`, ECONNREFUSED | failed | upstream_unreachable |
| Status ≥ 500 received from upstream | failed | upstream_5xx |
| Stream threw after 2xx headers | failed | stream_error |
| Entry exception (500) | failed | internal |

`upstreamErrorText` is read from at most 4 KiB of a non-2xx upstream body. It is used only for classification and is never stored. `error_code` stores the JSON `error.code` or `type` when it matches `^[a-z0-9_.-]{1,64}$`, otherwise the class.

`status_class` for rollups is `2xx`, `3xx`, `4xx`, `5xx`, or `none` (0).

### 5.5 Route classification (`route-class.js`)

| Pattern | kind | protocol / op |
|---|---|---|
| `POST /gateway/{auto,vllm,llama,<engineId>,external/<id>}/{openai,opencode}/**/{chat/completions,completions,responses,embeddings,rerank}` | traffic | openai or opencode / matching op |
| `POST /gateway/*/claude/**/messages[/count_tokens]` | traffic | claude / messages or count_tokens |
| `GET /gateway/*/{openai,opencode}/**/models` | control | models |
| `POST /gateway/tts/openai/v1/audio/speech`, TTS synthesis and batch routes (`ttsSynthesisRoute`) | traffic | tts / speech or tts_batch |
| `GET /gateway/tts/api/jobs*`, `GET /gateway/tts/` UI shell and assets, `api/engines`, `api/voices` | control or static | tts |
| `POST /gateway/search/v1/*` | traffic | search |
| `POST /gateway/mcp` | traffic | mcp / tool |
| `/gateway/health`, `/gateway/status`, any `OPTIONS` | control | — |
| Public listener aliases (05): `/v1/*`, `/anthropic/v1/*`, `/vllm/v1/*`, `/llama/v1/*` | same as the canonical route | ingress `public` |

Control requests produce no `requests` row. The exception is a status in {401, 403, 429} or ≥ 500, which is recorded so that auth storms remain visible. Every control request increments `control_counts_1m(route, status_class)`. This removes the TTS-poll flood (about 48 requests per minute) from request analytics while still counting it.

## 6. GatewayRecorder (entry)

### 6.1 Hot-path API

```js
const rec = telemetry.recorder.begin(req, res, {
  requestId,                               // optional: an id already minted by PUB-8's pipeline; otherwise minted here
  ingress: "entry", protocol, op, route: route.engine, method: req.method, path: url.pathname,
  clientRequestId, clientIp, clientCountry, keyId, customerId, authSource, sourceProgram,
  userAgent, originHost, owui: { userId, chatId },
});
// rec.requestId is final here. The caller sets the res header x-request-id immediately.
// rec.done: Promise<RequestRow>, resolved once at finalisation and never rejected (05 PUB-11 usage tap reads usage from it, 05 C5).
rec.setRouting({ managerId, fleetId, engineId, runtimeId, launchId, modelRequested, modelResolved, stream, routeReason });
rec.reject({ status, code });              // pre-upstream refusal; replaces each appendEntryGatewayAccessLog(...) early return
rec.dispatched();                          // just before fetch(target)
rec.headers(upstream.status, upstream.headers);   // reads x-local-llm-queued-ms into queue_ms
forwardUpstreamBody(upstream, res, upstreamControl, rec.tap());   // pass-through Transform that never alters bytes
rec.fail({ status, code, phase });         // catch blocks
```

Finalisation is automatic and happens exactly once. It is driven by P0-OBS-3's `onResponseDone(res, cb)` (from `manager-core/gateway-utils.js`), not by a second set of listeners:
- `terminalState: "completed"` (the `finish` path): the request completed or was rejected.
- `terminalState: "client_abort"` (`close` before `finish`): it is `client_abort`, or `timeout` when `upstreamControl` aborted for a timeout. If headers were not yet sent, `status = 499`.
- A safety timer (request timeout + 60 s) finalises stuck records as `failed/internal`.

Timing uses `performance.now()` deltas anchored to the wall clock at `begin`:
- `upstream_headers_ms` = dispatched → headers.
- `ttft_ms` = dispatched → first content token. It applies to streams only and is NULL for non-stream responses.
- `duration_ms` = begin → finalize.
- `queue_ms` = entry queue wait + manager `x-local-llm-queued-ms`.
- `decode_tps = (output_tokens - 1) / ((end - firstToken) / 1000)` when the response streams, `output_tokens ≥ 2` and `end - firstToken ≥ 100 ms`; otherwise NULL.

### 6.2 ResponseSniffer (`sniffer.js`)

- OpenAI and OpenCode SSE: before the first token, each event is parsed until one carries `choices[*].delta` with non-empty `content`, `reasoning_content`, `reasoning` or `tool_calls`; that sets `firstTokenAt`. After that, only events containing `"usage"`, `"finish_reason"` or `"timings"` are parsed. Usage goes through `normalizeOpenAiUsage` (cached tokens from `prompt_tokens_details.cached_tokens` and `input_tokens_details`). `finish_reason` comes from the last non-null value. `timings` comes from llama.cpp (`prompt_ms`, `predicted_per_second`, `cache_n`) and fills the `engine_*` columns.
- Anthropic SSE (claude protocol): `message_start.message.usage` gives input and cache-read tokens. The first `content_block_delta` sets the first token. `message_delta.usage.output_tokens` and `message_delta.delta.stop_reason` are mapped with `end_turn→stop`, `max_tokens→length`, `tool_use→tool_calls`.
- Non-stream JSON: the body is buffered up to 2 MiB for parsing. Past that, parsing stops and `usage_source` is `missing`. It reads `usage` and `choices[0].finish_reason`, or `stop_reason`.
- Without reported usage, the sniffer falls back to the existing stream output estimator (`createOpenAiSseUsageParser` semantics, `usage_source = 'estimated'`).
- Budgets: 64 KiB per SSE event, beyond which it is skipped. Bytes are only counted. Content is never retained after the event is parsed. No prompt or completion text is ever stored.

### 6.3 Batching and back-pressure

Finalised rows go to an in-memory ring buffer (`bufferMax` 10 000) that is flushed every 1 s to the worker in one transaction. On overflow the oldest rows are dropped, `recorder.dropped` is incremented, and the `telemetry_stale` alert covers it. On shutdown, `stop()` flushes with a 2 s cap.

### 6.4 Coverage

While the recorder is alive it upserts `coverage_1m(bucket, 'recorder')` once a minute. The query layer renders request-count buckets without coverage as `null` (a gap), not 0.

### 6.5 Entry wiring (`service-entry/server.js`)

This section starts from the landed P0 code: P0-ENT-2 already finalises entry access entries through `onResponseDone` and filters TTS control GETs with `shouldLogTtsAccess`.
- `proxyGatewayRequest`, `proxyTtsGatewayRequest` and `proxyAuxGatewayRequest` call `recorder.begin` at the top, after route parsing and before auth, so 401s are recorded. When PUB-8 extracts `service-entry/lib/gateway-pipeline.js`, the `begin` call moves into the pipeline's step 1 unchanged, and `telemetry-gateway.test.js` must stay green across that move.
- `buildProxyHeaders` drops the inbound `x-request-id` and adds `x-request-id` (TEL-5). The context header is added in TEL-2 through PUB-10's builder (§5.2).
- `buildEntryGatewayAccessEntry` and `appendEntryGatewayAccessLog` remain for one release as a rollback aid. They are fed from the finalised row (real tokens, request id, terminal state). They keep P0-ENT-2's `shouldLogTtsAccess` filter, and they are switched off by `telemetry.keepJsonlAccessLog=false`, which becomes the default in P8.
- The aggregated `/v1/models` path is control.

### 6.6 Manager-side delta (`manager-core/gateway-utils.js`, `access-log.js`)

P0-OBS-3 already provides `onResponseDone`, `requestId`, `terminalState`, `status: 499` before headers, `socketAddress`, the vouched `remoteAddress`, and `normalizeAccessEvent` keeping `requestId`, `terminalState` and `resolvedInstance`. PUB-10 switches the vouched address and request id to the v2 hop. TEL-2 adds only the following:
- Access-log row fields `clientRequestId`, `viaEntry`, `keyId` (`principal.k`, else the legacy `clientId`), `sourceProgram` (`context.src`, else `inferSourceProgram`), `errorClass` (`classifyOutcome`) and `firstByteMs`. `firstByteMs` is captured by wrapping the first `res.write` or `res.end`.
- `normalizeAccessEvent` keeps these fields, and they are appended to the end of `ACCESS_LOG_EXPORT_FIELDS` after P0-OBS-3's additions, which keeps the CSV column order stable for existing readers.
- The manager-direct request-id fallback becomes `mgr_…` (§5.1).
- Direct-ingress rows (`verifyEntryRequest(req) === null`) are also sent to the entry through `ingest-client.report("requests", [row])` (§6.7, TEL-6).

### 6.7 Manager → entry ingest (`/internal/telemetry/*`)

- `POST /internal/telemetry/requests`, `POST /internal/telemetry/events` and `POST /internal/telemetry/audit-access`.
  - These are signed and verified only by 05's `manager-core/internal-auth.js`. Managers use `createInternalClient`, and the entry calls `verifyInternalRequest(req, rawBody, token, {allowedManagers, pathPrefixes: ["/internal/telemetry/"]})`. The signature covers method, path, managerId, ts and sha256(body), and the module's prefix list includes `/internal/telemetry/`. TEL adds no prefix check of its own.
  - The socket must be loopback, and the allowed managers are those of internal-auth (`vllm-manager`, `llama-manager`). `/internal/*` is mounted on the ADMIN listener only (05).
  - The body is `{ "rows": [ … ≤ 200 ] }` and is at most 1 MiB.
- Responses: `200 {ok:true, accepted:n, duplicates:m}`, `401 telemetry_unauthorized`, `413 payload_too_large`, `400 invalid_rows` (with per-row errors; valid rows are still accepted).
- The entry validates and clamps each field. A row with an `ingress` other than `direct`, or with a `request_id` lacking the `mgr_` prefix, is rejected. Inserts use `INSERT OR IGNORE` on `request_id`, which makes replay idempotent.
- Spool: on network failure, 5xx or 401, the manager appends to `<manager>/logs/telemetry-spool.jsonl` (rotating at 20 MiB, oldest dropped with a counter). It replays on the next success in batches of 200. These endpoints are never mounted on the PUBLIC listener (05).

## 7. RuntimeCollector

### 7.1 The 01 metrics route (consumed; not built here)

There is one parser and one route, both owned by 01 ENG-10. TEL builds neither, and `runtime-routes.js` gets no metrics route from TEL.
- Parser: `manager-core/engines/metrics.js` exports `parsePrometheus(text)`, `mapPrometheus(engineId, parsed)` (cumulative, used here) and `summarize(mapped)` (01's summaries, used by 07). The descriptor `metricsMap` kind is `histogram` everywhere.
- Route: `GET http://127.0.0.1:<managerPort>/api/instances/:instanceId/metrics` lives in `manager-core/engines/routes.js` behind the manager's `isLocalRequest`. It returns `{ok, instanceId, engineId, metrics, raw, facts, scrapedAt, unsupported[]}`. `metrics` is `summarize(raw)` and is what 07 reads. `raw` is `mapPrometheus` output and is what the RuntimeCollector reads. Both use 01's camelCase canonical keys.

The part of the response this spec depends on (keys defined by 01; the two keys marked † are requested additions, §25 R2):
```json
{ "ok": true, "instanceId": "primary", "engineId": "sglang", "scrapedAt": "2026-10-14T08:00:10.004Z",
  "unsupported": ["queueSeconds"],
  "raw": { "processStartSeconds": 1760400000,
    "models": [ { "model": "qwen3.8-flash",
      "counters": { "promptTokensTotal": 1203345, "generationTokensTotal": 402211, "cachedPromptTokensTotal": 803000,
                    "requestsTotal": 912, "preemptionsTotal": 0, "specDraftTokensTotal": 0, "specAcceptedTokensTotal": 0,
                    "requestsByFinishReasonTotal": { "stop": 880, "length": 21, "abort": 9, "error": 2 } },
      "gauges": { "requestsRunning": 1, "requestsWaiting": 0, "kvUsageRatio": 0.31, "kvCapacityTokens": 262144, "specAcceptRate": null },
      "histograms": {
        "ttftSeconds": { "le": [0.001,0.005,0.01,0.02,0.04,0.06,0.08,0.1,0.25,0.5,0.75,1,2.5,5,7.5,10,"+Inf"], "counts": [0,0,0,3,…,912], "sum": 402.1, "count": 912 },
        "e2eSeconds": { "…": "…" }, "itlSeconds": { "…": "…" }, "tpotSeconds": { "…": "…" }, "queueSeconds": { "…": "…" } } } ] },
  "metrics": { "…": "01 summaries" }, "facts": { "…": "01" } }
```
- † `processStartSeconds` (from `process_start_time_seconds` when the engine exposes it) and † `requestsByFinishReasonTotal` (a counter split by its `finished_reason` label). Both are optional. Without them, resets are detected by counter decrease and launch change only, and `d_errors`, `d_aborts` and `d_finish_length` are NULL (gateway rows still carry terminal states).
- Histogram `counts` are cumulative, as Prometheus exposes them. Labels other than `model_name` and `le` are summed by `mapPrometheus`. For llama.cpp, `cachedPromptTokensTotal` comes from the cumulative totals of `cache-hit-tracker` (01's mapping).
- A non-2xx response or `ok:false` (00 §4.2 envelope) is a scrape failure with `error_code = error.code`.
- Scrape load: TEL-1's sampler exposes `lastScrape(instanceId) → {text, scrapedAt}`. 01's route is asked to serve from it when it is at most 5 s old (§25 R2), so the entry's 10 s poll adds no engine scrapes. Without that injection the route scrapes itself, and the collector stays correct because it aligns on `scrapedAt`.

### 7.2 Collection loop (entry)

Every `telemetry.sampleIntervalMs` (default 10 000, minimum 5000):
1. List fleet instances from the entry's cached `/api/instances` catalogs (00 §4.1). External endpoints are skipped: they are gateway-only.
2. For each instance with `lifecycle.state ∈ {ready, sleeping}`, fetch the §7.1 route with a 3 s timeout and at most 8 in parallel, and read `raw`.
3. Skip the instance if `scrapedAt` equals the previous `scrapedAt` (no new snapshot).
4. Delta against the previous snapshot for the same `(fleetId, model)`. The entry computes `runtime_key = <instance launchId or container id> + ":" + (raw.processStartSeconds ?? "")`.
   - If `runtime_key` changed or any counter decreased, emit a row with `reset=1` and NULL deltas, and store the new baseline.
   - Otherwise `interval = Δ scrapedAt`, `d_* = Δcounters` (`promptTokensTotal → d_prompt_tokens`, `generationTokensTotal → d_output_tokens`, `cachedPromptTokensTotal → d_cached_tokens`, `requestsTotal → d_requests`, `specDraftTokensTotal`, `specAcceptedTokensTotal`, and `requestsByFinishReasonTotal.{error, abort, length}` → `d_errors`, `d_aborts`, `d_finish_length`), `*_tps = d / interval`, `rpm = d_requests / interval * 60`. Gauges map `requestsRunning → running`, `requestsWaiting → waiting`, `kvUsageRatio → kv_usage`.
   - `prefix_hit_rate = d_cached_tokens / d_prompt_tokens` (NULL if the denominator is 0); `spec_accept_rate = d_spec_accepted / d_spec_draft`.
   - Percentiles come from `deltaCumulative(prevBuckets, curBuckets)` with `quantile()`.
5. `idle = (d_requests == 0 && running == 0 && waiting == 0)`. Idle rows have rates of exactly 0 and NULL percentiles. They are never carried forward.
6. Engines with no latency histograms (llama.cpp, external, or any engine with an empty `histograms`) use `latency_source = 'gateway'`. TTFT and e2e percentiles are computed from `requests` rows with `fleet_id = ? AND received_at` inside the interval, through the fixed gateway buckets. `hist` stores these as `{ttft:{le:GATEWAY_MS_BUCKETS, d:[…]}}`.
7. Scrape failure: a row with `scrape_ok=0` and `error_code ∈ {timeout, http_<status>, unsupported_endpoint, parse_error}`. After 3 consecutive failures while the instance is `ready`, the event `runtime.scrape_failed` is recorded and the `instance_down` rule is fed.
8. Fallback for a manager without the route (404, for example during a partial deploy): the collector computes counter deltas from `/api/stats` `models[].tokens` and `requests` at most every 30 s, sets `latency_source = 'none'`, and records the `telemetry.degraded` event once.

Time alignment uses `scrapedAt` from the manager, not the entry's clock, so poll jitter cannot alias rates.

## 8. GpuCollector

- Every 10 s it runs `nvidia-smi --query-gpu=<fields> --format=csv,noheader,nounits` with a 5 s timeout through `execFile` (no shell). Fields, with the same fallback chain idea as `gpu-runtime.js:66-71`:
  `index,uuid,name,memory.total,memory.used,utilization.gpu,utilization.memory,temperature.gpu,temperature.memory,power.draw,power.limit,enforced.power.limit,fan.speed,clocks.sm,clocks.mem,clocks.max.sm,pstate,clocks_event_reasons.active`
  - If a query fails, it retries with `clocks_throttle_reasons.active`, then without `temperature.memory`/`utilization.memory`, and finally with the legacy `gpu-runtime.js` query. The working query is cached for 1 hour.
- `N/A` or `[N/A]` parse to NULL. `power_limit_w` prefers `enforced.power.limit`.
- `decodeThrottle(mask)` uses a data table:
  - `0x1 gpu_idle`, `0x2 app_clocks`, `0x4 sw_power_cap`, `0x8 hw_slowdown`, `0x10 sync_boost`;
  - `0x20 sw_thermal`, `0x40 hw_thermal`, `0x80 hw_power_brake`, `0x100 display_clocks`;
  - unknown bits become `bit_0x…`. The host currently reports `0x400`, which therefore stays visible as `bit_0x400`.
- Per-process VRAM: one `--query-compute-apps=pid,process_name,used_memory` call per minute. If every `used_memory` is `[N/A]`, which is the case on this WDDM host (F10), `procs` is NULL and the per-process query is disabled for 1 hour. Per-instance VRAM in the UI comes from the instance `vramReservationMb` (00 §4.1) and `launch.ready` events (`gpuUsedBeforeMb/AfterMb`). It is labelled as a reservation, not a measurement.
- `energy_wh = power_w × min(Δt, 2 × interval) / 3600`. Gaps longer than 2 × interval are not integrated, so downtime is never filled in.
- Failure: when nvidia-smi is missing or fails three times, the interval backs off to 60 s, the `gpu` collector status becomes `degraded`, and the `telemetry_stale` alert covers it.
- The managers keep their own `getGpuStatus()` for admission. The entry does not share its sampler with them in P4.

## 9. EventCollector

Sources:
1. The in-process stream `service-entry/lib/events.js` (07 ENT-EV, 00 §4.5). ENT-EV owns the module, the typed registry, the ring buffer and the manager SSE relay that brings manager `jobs` and `instances` events in. TEL-9 never edits it. It calls `events.subscribe(fn, {types: ["jobs", "instances", "status", "downloads", "security", "access", "platform"]})` and records what it needs into the `events` table.
2. Job diffs to launch events. Serve and start jobs map as follows:
   - first seen: `launch.started`;
   - each `meta.stageHistory` entry: `launch.phase` with `{phase, prevPhase, prevDurationMs}`;
   - success: `launch.ready` with `{durationMs, phases, gpuUsedBeforeMb, gpuUsedAfterMb}`;
   - failure: `launch.failed` with `{phase, errorSignature, message}`. The message is passed through `redactSecrets` (`manager-core/secret-redactor.js`) and cut to 300 chars.
   - With 01, phases come from `instances[].lifecycle.phase` and the `launchId` comes from the instance. `dedupe_key = job:<managerId>:<jobId>:<stage|final>`.
3. Docker events: `docker events --filter label=ai.manager --format "{{json .}}"` as a long-lived child process through `docker-runtime.js`, which honours `DOCKER_WSL_DISTRO`.
   - `die` produces `container.exit {exitCode, oomKilled}`, `oom` produces `container.oom` (critical), and `health_status` produces `container.health`.
   - The fleet id comes from the labels `ai.manager`, `ai.manager.instance` and `ai.manager.launch-id`.
   - On failure it reconnects with backoff from 5 s to 5 min. It **never starts Docker Desktop or a WSL distro.**
4. Process exit logs: incremental tails of `<root>/logs/process-exit.log` for the entry and each manager, with offsets kept in `collector_state`. Lines map to `manager.start`, `manager.exit`, `manager.signal` and `manager.crash`. A `start` with no preceding `exit` produces `manager.hard_kill_suspected` (warning).
5. Manager health: the entry's existing manager status polls drive `manager.unreachable` and `manager.reachable` on edge transitions.
6. Security: the `security` events published by 05 (`security.ban`, `security.auth_failed`, …) are recorded as they arrive. Before 05's limiter lands, `createAuthFailureGuard({onBan})`, a new option, produces `security.ban {ip, ipMasked, until, failures}`.
7. Config changes:
   - `POST /api/fleet/settings` produces `config.fleet` with changed key names only.
   - Key and exposure changes (05 `access` events, or legacy manager routes through `/internal/telemetry/events`) produce `config.keys` and `config.exposure`.
   - Telemetry and alert settings produce `config.telemetry` and `config.alerts`.
   - A `writeSection` result (06 OPS-3 returns `changed`) or a change of `platform.json` mtime produces `config.platform` with the changed keys only. Values are never recorded.
8. Audit and alerts: `audit.export`, `audit.export.skipped_empty`, `audit.export.failed`, `audit.prune`, `alert.firing`, `alert.resolved`, `alert.acked`, `alert.notify_failed`.
9. MCP: an incremental tail of `PLATFORM_MCP_AUDIT_LOG` (default `<AI_ROOT>/audit-logs/platform-mcp.jsonl`) produces `mcp.tool_call {tool, ok, durationMs, errorCode}`.
10. Benchmarks: `benchmark.run` from the managers' `/api/benchmarks` on change, polled every 5 min, with `dedupe_key = bench:<managerId>:<id>`.

Event JSON is redacted with `redactValue` from `manager-core/secret-redactor.js` and capped at 16 KiB. Titles are English. `data.i18nKey` lets the console localise them.

## 10. Rollups

- **Bucketing time:** `received_at` for requests and `at` for samples.
- **Live roll:** every 30 s the job closes `rollup_1m` buckets older than `now - 90 s` that are past the watermark (`collector_state.rollup.1m`). It computes each bucket by `DELETE` plus a recompute from the raw rows. Aggregation happens in JS inside the worker; histograms are merged arrays.
- **Late data:**
  - Any insert whose bucket is at or before the watermark adds `(grain, bucket)` to `rollup_dirty`. Typical causes are a stream finalised after its minute was rolled, or manager spool replays.
  - The same pass recomputes dirty buckets and their parent hour and day.
  - Dirty buckets older than raw retention are dropped with a counter.
- **Higher grains:** hourly at minute 2, `rollup_1h` is built from `rollup_1m` by summing counters and merging histograms. Daily at 00:10 local time, `rollup_1d` is built from `rollup_1h`.
  - The local day uses `telemetry.timezoneOffsetMinutes`, which defaults to the host offset. Whole-hour offsets are supported; other offsets are rejected at config validation with a clear error.
- **Samples:** `runtime_rollup_*` and `gpu_rollup_*` follow the same cadence. Gauges are averaged per sample and maxima taken.
- **Idempotency:** recomputing any bucket gives identical rows. This is covered by tests.

## 11. Query API (entry, ADMIN listener)

Common rules:
- Access is gated by 05 PUB-5's `checkManagementAccess(req, {write})`.
  - The `owner` role (session or tool token) gets everything. Writes also need CSRF (PUB-5).
  - The `viewer` role (loopback without a session, or a LAN viewer) reaches only the GET routes registered in §11.8, and each response passes through that route's redaction function. Every other `/api/telemetry/*`, `/api/audit/*` and `/api/billing/*` route answers 401 `admin_session_required` to a viewer.
  - Before PUB-5 lands, today's `security.checkManagementAccess(req)` applies: local admin gets everything, and a LAN viewer gets the §11.8 redactions.
- Time parameters: `from` and `to` accept ISO 8601 or epoch ms, default to the last hour, and are capped at a 400-day range.
- Common filters, all whitelisted (an unknown parameter returns `400 unknown_parameter`): `manager_id`, `fleet_id`, `engine_id`, `model`, `key_id`, `customer_id`, `source_program`, `protocol`, `status_class`, `error_class` (comma lists), `ingress`, `stream`.
- Errors use the 00 §4.2 envelope. All SQL is prepared and lives in the worker. Dimension, metric and sort names map to fixed column expressions and never to interpolated input.

### 11.1 `GET /api/telemetry/live`

This is the snapshot used for the first paint and the polling fallback. The same object is pushed as `telemetry.live` on `/api/events` every 5 s, but only while at least one subscriber is connected.

```json
{ "ok": true, "at": "2026-10-14T08:00:05Z", "windowSeconds": 60,
  "gateway": { "inflight": 2, "requestsPerMin": 14, "outputTokensPerSec": 85.2, "errorRate5m": 0.02, "ttftP95Ms5m": 640, "clientAborts5m": 1 },
  "instances": [ { "fleetId": "vllm:primary", "engineId": "sglang", "model": "qwen3.8-flash", "state": "ready", "idle": false,
                   "running": 1, "waiting": 0, "kvUsage": 0.31, "outputTps": 92.4, "vramReservationMb": 88000, "sampleAt": "2026-10-14T08:00:00Z" } ],
  "gpus": [ { "index": 0, "util": 87, "memUsedMb": 90112, "memTotalMb": 97887, "tempC": 71, "powerW": 412, "powerLimitW": 600, "throttle": [] } ],
  "alerts": { "firing": 1, "critical": 0 },
  "collectors": { "recorder": "ok", "runtime": "ok", "gpu": "ok", "events": "ok", "store": "ok" } }
```

### 11.2 `GET /api/telemetry/summary?from&to&compare=previous&<filters>`

KPI tiles with deltas against the previous period of equal length.

```json
{ "ok": true, "from": "…", "to": "…", "current": { "requests": 1240, "errorRate": 0.031, "clientAbortRate": 0.004, "ttftP95Ms": 812,
  "durationP95Ms": 14100, "decodeTpsP50": 61.2, "promptTokens": 2.1e6, "cachedTokens": 1.3e6, "outputTokens": 4.4e5,
  "activeKeys": 6, "gpuUtilAvg": 41.5, "vramPeakMb": 91002, "energyKwh": 3.92, "energyCost": 2.35, "currency": "CNY",
  "billedMicrocredits": "1234000" }, "previous": { "…": "…" }, "coverage": 0.98, "source": "rollup_1h" }
```

`billedMicrocredits` is owner-only. It is computed by `billingStore.summarizeUsage` (§15) for the same window. `energyCost` is null when no price is configured.

### 11.3 `GET /api/telemetry/timeseries`

Parameters: `metrics=a,b` (≤ 6), `from`, `to`, `step` (seconds, optional), `groupBy` (one dimension), `top=8`, `annotate=launch,instance,container,manager,config,benchmark,alert`, plus the filters.

Metric catalog (`query.js METRICS`; the unit and family are fixed):

| Family / source | Metrics | groupBy allowed |
|---|---|---|
| req (requests and `rollup_*`) | `req.count`, `req.rate_per_min`, `req.error_rate`, `req.errors`, `req.client_abort_rate`, `tok.prompt`, `tok.cached`, `tok.output`, `tok.output_per_s`, `tok.cached_share`, `lat.ttft_p50/p95/p99`, `lat.duration_p50/p95/p99`, `lat.decode_tps_p50`, `lat.decode_tps_p10`, `req.length_share`, `usage.estimated_share`, `lat.ttft_hist` (heatmap) | manager, fleet, engine, model, key, customer, source, protocol, status_class, error_class |
| rt (`runtime_samples` and `runtime_rollup_*`) | `rt.prompt_tps`, `rt.output_tps`, `rt.rpm`, `rt.running`, `rt.running_max`, `rt.waiting`, `rt.waiting_max`, `rt.kv_usage`, `rt.kv_usage_max`, `rt.prefix_hit`, `rt.spec_accept`, `rt.ttft_p50/p95/p99`, `rt.e2e_p50/p95`, `rt.itl_p50/p95`, `rt.tpot_p50`, `rt.queue_p95`, `rt.idle_share` | fleet, model |
| gpu (`gpu_samples` and `gpu_rollup_*`) | `gpu.util`, `gpu.util_max`, `gpu.mem_used_mb`, `gpu.mem_used_pct`, `gpu.temp_c`, `gpu.temp_max`, `gpu.power_w`, `gpu.power_ratio`, `gpu.sm_clock_mhz`, `gpu.throttle_seconds` (group by reason), `gpu.energy_wh`, `energy.cost` | gpu, reason |

Downsampling and source selection:
1. `step` defaults to the smallest nice step (10 s, 30 s, 1 m, 5 m, 15 m, 30 m, 1 h, 3 h, 6 h, 12 h, 1 d, 7 d) that keeps the result at ≤ 600 points.
2. Source:
   - raw rows if step < 60 s and the range is ≤ 2 h for requests or ≤ 48 h for samples;
   - otherwise `*_1m` if the range is ≤ 14 d and step < 3600;
   - otherwise `*_1h` if the range is ≤ 400 d and step < 86400;
   - otherwise `*_1d`.
3. Aggregation per step:
   - Counters are summed.
   - Rates are sums divided by the step.
   - Gauges are averaged; `_max` metrics take the maximum.
   - Ratios are computed from summed numerators and denominators, never as an average of ratios.
   - Percentiles come from merged histograms.
4. Gaps: buckets with no samples, or with no `coverage_1m` for request metrics, are `null`. Request counts are 0 only when coverage exists.
5. More than `top` groups: the largest by total are kept and the rest fold into `{"other": true}`.

Response:

```json
{ "ok": true, "from": "2026-10-13T08:00:00Z", "to": "2026-10-14T08:00:00Z", "step": 300, "source": "rollup_1m", "tzOffsetMinutes": 480,
  "series": [ { "metric": "lat.ttft_p95", "unit": "ms", "group": { "model": "qwen3.8-flash" },
                "points": [[1760342400000, 812.5], [1760342700000, null]] } ],
  "annotations": [ { "at": 1760380000000, "type": "launch.ready", "fleetId": "vllm:primary", "title": "Launch ready in 545 s", "eventId": 991 } ],
  "otherGroups": 2 }
```

For `lat.ttft_hist`, `points` are `[t, [count per bucket]]` and the response carries `le: GATEWAY_MS_BUCKETS`.

### 11.4 `GET /api/telemetry/breakdown`

Parameters: `dim` (one dimension, or `client_ip`, which is owner-only), `metrics` (default `requests,errorRate,promptTokens,cachedTokens,outputTokens,ttftP95Ms,durationP95Ms,decodeTpsP50`), `sort` (one of those, with an optional `-` prefix), `limit` (≤ 200), `spark=1` (adds 24 points), plus the filters.

```json
{ "ok": true, "dim": "error_class", "rows": [ { "key": "auth_failed", "label": { "zh": "鉴权失败", "en": "Authentication failed" },
  "requests": 90, "share": 0.24, "firstSeen": "…", "lastSeen": "…", "sampleRequestIds": ["req_…","req_…","req_…"], "spark": [0,3,9] } ],
  "total": { "requests": 372 } }
```

### 11.5 `GET /api/telemetry/requests`

Parameters: the filters plus `terminal_state`, `client_ip` (admin), `min_duration_ms`, `min_ttft_ms`, `min_output_tokens`, `q` (a `request_id` or `manager_request_id` prefix of at least 6 chars, or an exact `client_request_id`), `limit` (default 100, ≤ 500), `cursor`, `facets=1`.

- Order: `received_at DESC, id DESC`. The keyset cursor is `base64url(JSON {t, id})` and the next page uses `WHERE (received_at, id) < (?, ?)`.
- Response: `{ok, rows:[RequestRow], nextCursor|null, facets?:{status_class:{…}, error_class:{…}, model:{…}, source_program:{…}}}`. Facets are computed over at most 50 000 rows and return `facetsTruncated` when capped.
- `RequestRow` is the public projection of the `requests` table in camelCase. `extra` is parsed into an object.

### 11.6 `GET /api/telemetry/requests/:requestId`

```json
{ "ok": true,
  "request": { "requestId": "req_…", "receivedAt": "…", "durationMs": 18234, "ttftMs": 512, "decodeTps": 58.1, "terminalState": "completed", "errorClass": "none", "…": "…" },
  "timeline": [ { "at": "…", "mark": "received" }, { "mark": "dispatched", "offsetMs": 3 }, { "mark": "headers", "offsetMs": 140 },
                { "mark": "first_token", "offsetMs": 515 }, { "mark": "done", "offsetMs": 18234 } ],
  "billing": { "usage": { "usageId": "…", "chargedMicrocredits": "0", "projectedMicrocredits": "1834", "usageSource": "reported", "terminalState": "completed", "decisionCode": "billing_shadow_allowed" },
               "reservation": { "enforcementMode": "shadow", "decisionCode": "…", "reservationMicrocredits": "4096" } },
  "instance": { "fleetId": "vllm:primary", "engineId": "sglang", "runtimeId": "sglang@0.5.17", "launchId": "lch_…", "recipeId": "qwen38-flashnext-262k",
                "launch": { "readyAt": "…", "summary": { "contextLength": 262144, "kvCacheDtype": "fp8_e4m3", "maxNumSeqs": 1 } },
                "nearestSample": { "at": "…", "running": 1, "waiting": 0, "kvUsage": 0.33 } },
  "events": [ { "id": 1201, "type": "container.health", "at": "…" } ],
  "audit": { "unlocked": false, "linkable": true, "chatId": null, "candidates": [] } }
```

- Billing comes from `billingStore.getUsageByExternalRequestId(requestId|managerRequestId)`, a new read-only export. It is owner-only (the route itself is owner-only, §11.8).
- `instance.launch` comes from the `launch.ready` event with the same `launchId`. The summary is the redacted launch values only; argv is never included.
- `events` are those with the same `request_id`, or the same `fleet_id` within ±60 s.
- `audit` is resolved only when the caller sends a valid audit session (`x-audit-session`). `chatId` comes from `owui_chat_id`. Candidates come from the audit index: chats whose user message timestamp is within ±120 s and whose model equals `model_resolved`. Every candidate lookup is logged (`action: link_lookup`).

### 11.7 Other read endpoints

| Method and path | Purpose and response |
|---|---|
| `GET /api/telemetry/events?from&to&type=launch.,alert.&severity&fleet_id&limit&cursor` | `{rows:[{id, at, type, severity, source, managerId, fleetId, launchId, requestId, title, data}], nextCursor}`. `type` takes prefixes. |
| `GET /api/telemetry/energy?from&to&groupBy=hour\|day\|fleet\|model\|gpu` | `{rows:[{key, energyWh, idleWh, cost, outputTokens, costPerMOutputTokens}], currency, tariffApplied:"current", priceConfigured}` |
| `GET /api/telemetry/lifecycle?from&to` | Gantt data: `{instances:[{fleetId, model, engineId, intervals:[{from, to, state:"loading\|ready\|sleeping\|crashed", launchId}]}]}`, derived from launch, instance and container events |
| `GET /api/telemetry/launches?from&to&groupBy=model\|recipe\|engine` | `{rows:[{key, started, ready, failed, readyP50Seconds, readyP95Seconds, topFailures:[{signature, count}]}]}` |
| `GET /api/telemetry/baseline` | Imported lifetime counters: `{rows:[{managerId, model, firstSeen, lastSeen, promptTokens, outputTokens, requests, source}]}` |
| `GET /api/telemetry/export?kind=requests\|rollup\|events&grain=1m\|1h\|1d&format=csv\|jsonl&<filters>` | Owner only. Streamed in pages of 1000 rows, ≤ 200 000 rows (`telemetry.exportMaxRows`). Headers `x-telemetry-total` and `content-disposition: attachment; filename="telemetry-<kind>-<UTC>.csv"`. CSV is UTF-8 with a BOM and formula-escaped (`accessLogCsvCell`). JSONL ends with `{"_truncated":true}` when capped. |
| `GET /api/telemetry/status` | `{schemaVersion, dbBytes, walBytes, rows:{requests, runtimeSamples, gpuSamples, events, …}, collectors:{name:{state, lastOkAt, lastError, intervalMs}}, recorder:{inflight, buffered, dropped}, rollup:{watermark1m, dirty}, retention:{lastRunAt, deleted}, imports:[…], degraded:[…]}` |
| `GET /api/telemetry/settings` / `PUT` | Owner only. GET returns `readSection("telemetry")` as `{energy, retention, sampleIntervalMs, keepJsonlAccessLog, alerts:{webhooks:[{id, format, url (masked), minSeverity, secret:{set}}]}}` with an `etag` header. PUT takes a partial patch with `If-Match` and calls `writeSection("telemetry", patch, {etag})` from 06 OPS-3 (`manager-core/platform/config.js`). It returns `{ok, etag, changed, restartRequired}`, or `409 etag_mismatch` / `400` with `errors[]` from the writer. A write-only `webhooks[].secret` goes to `secretStore.set("webhooks", id, value)` and is never echoed, logged or written to `platform.json`. TEL never writes `platform.json` itself. |
| `POST /api/telemetry/import` `{sources:[…], dryRun:true}` | Owner only. Returns `{ok, runId}`. `GET /api/telemetry/import/:runId` returns progress and the final report; the console polls it every 2 s while the run is active. Completion publishes one `notification`. There is no import event type. |

### 11.8 Viewer registrations (`service-entry/lib/telemetry-viewer.js` → 05 `viewer-allowlist.js`)

04 owns these entries in 05's viewer-allowlist registry. `registerTelemetryViewerRoutes(allowlist)` runs at mount time. Each entry names its redaction function, exported from `telemetry-viewer.js` and unit-tested there. Any 04 GET route that is not listed below is owner-only, and 05's coverage test fails if a new 04 GET route is neither registered nor marked owner-only.

| GET route or event type | Redaction function | What a viewer gets |
|---|---|---|
| `/api/telemetry/live`; event `telemetry.live` | `redactLive` | Unchanged aggregates, model names and GPU numbers. `collectors` is reduced to `ok`/`degraded` states. |
| `/api/telemetry/summary` | `redactSummary` | Drops `billedMicrocredits` and `activeKeys`. Adds `"viewer": true`. |
| `/api/telemetry/timeseries` | `redactSeriesQuery` (pre-check) + `redactSeries` | `groupBy=key\|customer` and the `key_id`/`customer_id` filters return 403 `owner_required`. Annotations keep `type`, `at` and `title` only. |
| `/api/telemetry/breakdown` | `redactBreakdownQuery` + `redactBreakdown` | `dim=client_ip\|customer\|key` returns 403 `owner_required`. `sampleRequestIds` are removed. |
| `/api/telemetry/events` | `redactEvents` | Keeps `id, at, type, severity, source, managerId, title`. `data` is dropped, except `ipMasked` on `security.ban`. `requestId` is removed. |
| `/api/telemetry/alerts`, `/api/telemetry/alert-rules`; event `alerts` | `redactAlerts` | Unchanged except that rule `channels` and webhook ids are removed. |
| `/api/telemetry/energy`, `/lifecycle`, `/launches`, `/baseline` | `identity` | Unchanged. These carry no personal data. |
| `/api/telemetry/status` | `redactStatus` | `collectors` states, `schemaVersion` and `degraded` only. No sizes, paths, import reports or errors. |
| `/api/gateway-access` (TEL-12 facade) | `redactAccessForRemote` (existing) | Today's remote redaction, unchanged. |

Owner-only (never registered): `/api/telemetry/requests[/:id]`, `/export`, `/settings`, `/import[/:runId]`; every `/api/audit/*` route (including `status`); `/api/billing/usage/summary`; the event type `notification`.

## 12. Live updates and the event stream

04 publishes only through `events.publish(type, payload)` from ENT-EV, and only the registered types `telemetry.live`, `alerts` and `notification`. It adds no types. ENT-EV provides the `id:` lines, Last-Event-ID replay, `GET /api/events/recent` and viewer filtering (through §11.8).
- `telemetry.live` is the §11.1 object, published every 5 s while `events.subscriberCount({types: ["telemetry.live"]}) > 0`. It is built from memory (recorder windows, latest samples) with no SQL.
- `alerts` is `{action:"firing"|"resolved"|"acked", alert:{ruleId, scopeKey, severity, title:{zh,en}, value, threshold, since, link}}`.
- `notification` uses the 00 §4.5 envelope `{level, title, body, link}`. This spec adds `channels: ["inapp"|"toast"]` and `dedupeKey` (contract change C3). It is owner-only (§11.8).
- Toasts: the 06 supervisor holds an SSE connection to `/api/events` as the machine principal `system:supervisor` (05 PUB-5). It signs the request with the internal HMAC of 05 `internal-auth.js`, never with a bare header or a query parameter, and it receives `notification` and `platform`. It shows a Windows toast for notifications whose `channels` include `toast`. The alert status reports `toastChannel: "available" | "no_subscriber"` from `events.subscriberCount({principal: "system:supervisor"})`. An unauthenticated client can therefore not fake the toast subscriber.
- When SSE fails, clients poll `GET /api/telemetry/live` every 5 s and `GET /api/telemetry/alerts?state=firing` every 30 s.

## 13. Alert engine

### 13.1 Rule model and evaluation

- The engine evaluates every 15 s. Each rule names a metric from `ALERT_METRICS`; there is no user SQL. The value is computed over `window_s` for each scope key:

| Metric | Value | Scope keys |
|---|---|---|
| `instance.down` | 1 if the instance is expected ready and either has ≥ 3 consecutive scrape failures or is in lifecycle `crashed` | `fleet:<fleetId>` |
| `manager.down` | 1 if the manager health poll failed ≥ 3 consecutive times | `manager:<id>` |
| `req.upstream_error_rate` | (upstream_5xx + upstream_timeout + upstream_unreachable + stream_error) / requests | `*`, `fleet:*` |
| `req.error_count` | count of `scope.errorClasses` in the window | `*` |
| `req.auth_failures` | count of `auth_failed` rows; payload carries the top 5 masked IPs | `*` |
| `rt.waiting` / `rt.kv_usage` | average | `fleet:*` |
| `gpu.temp_c` / `gpu.power_ratio` | maximum / average | `gpu:<i>` |
| `gpu.hw_throttle_share` | share of samples with `hw_slowdown`, `hw_thermal` or `hw_power_brake` | `gpu:<i>` |
| `disk.free_ratio` | `fs.statfsSync` free/total for `<AI_ROOT>` and each model storage root (`model-storage.json`), every 60 s | `disk:<root-label>` |
| `audit.export_failed` | 1 if the last scheduled export failed | `*` |
| `audit.chain_risk` | 1 if `planAuditRetention().needsRebaseline`, or no full export exists | `*` |
| `billing.unavailable` | count of `billing_unavailable` | `*` |
| `telemetry.stale_seconds` | seconds since a collector's last ok, or `recorder.dropped > 0` | `collector:<name>` |
| `security.bans` | count of `security.ban` events | `*` |

- State machine per `(rule, scopeKey)`:
  - `ok → pending` when the condition holds, and `pending → firing` once it has held for ≥ `for_s`. If `min_samples` is not met, the rule stays `ok`.
  - `firing → ok` (resolved) when the value crosses `clear_threshold` (defaulting to `threshold`) for one evaluation.
  - Every transition to `firing` or back to `ok` writes an `alert.*` event and calls `notify`.
  - While firing, the alert re-notifies after each `cooldown_s`.
  - `acked` suppresses re-notifications but not resolution. `silenced_until` suppresses notifications without changing state.

### 13.2 Default rules (seeded, `builtin=1`; thresholds and channels are editable; rules can be disabled but not deleted)

| rule_id | Metric and condition | for / window | Severity | Channels |
|---|---|---|---|---|
| `instance_down` | `instance.down >= 1` | 30 s / 30 s | critical | inapp, toast, webhook |
| `manager_down` | `manager.down >= 1` | 60 s / 30 s | critical | inapp, toast, webhook |
| `upstream_errors` | `req.upstream_error_rate > 0.05`, min 20 requests | 5 m / 5 m | warning | inapp, webhook |
| `auth_storm` | `req.auth_failures > 30` | 0 / 5 m | warning | inapp, toast |
| `billing_unavailable` | `billing.unavailable > 0` | 0 / 5 m | critical | inapp, toast, webhook |
| `queue_saturation` | `rt.waiting > 0` | 2 m / 2 m | warning | inapp |
| `kv_saturation` | `rt.kv_usage > 0.95` | 5 m / 5 m | warning | inapp |
| `gpu_temp_high` / `gpu_temp_critical` | `gpu.temp_c > 85` / `> 90` | 2 m / 1 m | warning / critical | inapp, toast |
| `gpu_power_cap` | `gpu.power_ratio > 0.98` | 5 m / 5 m | info | inapp |
| `gpu_hw_throttle` | `gpu.hw_throttle_share > 0.5` | 1 m / 1 m | warning | inapp |
| `disk_low` | `disk.free_ratio < 0.10` (clear at 0.12) | 10 m / 60 s | warning | inapp, toast, webhook |
| `audit_export_failed` | `audit.export_failed >= 1` | 0 | warning | inapp, webhook |
| `audit_chain_risk` | `audit.chain_risk >= 1` | 0 | critical | inapp, toast |
| `telemetry_stale` | `telemetry.stale_seconds > 60` | 0 | warning | inapp |
| `ban_issued` | `security.bans > 0` | 0 / 5 m | info | inapp |

Migration: when the existing per-manager automation settings enable the GPU temperature or power guards (`gpu-guard.js`), their thresholds seed `gpu_temp_high` and `gpu_power_cap` once. The manager guards keep running in warn-only mode, so the legacy UIs stay unchanged.

### 13.3 Channels (`notify.js`)

- **inapp:** `events.publish("alerts", …)` plus `events.publish("notification", {level, title, body, link, channels, dedupeKey})`.
- **toast:** the same notification with `channels` including `"toast"`. Delivery belongs to the supervisor (06, §12).
- **webhook:** `telemetry.alerts.webhooks[]`, each `{id, url, format: generic|feishu|dingtalk|wecom|slack, minSeverity}`. Whether a webhook has a signing secret is `secretStore.has("webhooks", id)`.
  - Requests are POSTed with a 5 s timeout, `redirect: "manual"` and 3 retries (1 s, 5 s, 30 s). The failure event is `alert.notify_failed`.
  - The generic body is shown below, followed by its signature header:
    ```json
    { "version": 1, "event": "alert.firing", "ruleId": "gpu_temp_high", "severity": "warning", "scope": "gpu:0",
      "title": "GPU 0 温度过高 / GPU 0 temperature high", "value": 87, "threshold": 85, "since": "…", "at": "…",
      "link": "http://127.0.0.1:5176/#/observability/alerts?rule=gpu_temp_high" }
    ```
    `x-ai-signature: sha256=<hex HMAC(secret, body)>`
  - The Feishu, DingTalk and WeCom formats send text messages, with their native timestamp-signing when a secret is set.
  - Signing secrets live only in the single secret store `manager-core/secret-store.js` (06 OPS-3; DPAPI CurrentUser per value, owner-only ACL, outside `logs/`), namespace `webhooks`, key `<webhookId>`. The value is never in `platform.json`, events, logs or API responses. Deleting a webhook calls `secretStore.clear("webhooks", id)`.
  - `assertSafeWebhookUrl` allows only http or https URLs. It rejects userinfo, link-local `169.254.0.0/16` and `fe80::/10`, and loopback unless `allowLoopback: true`.
  - Webhook payloads never include IPs, key ids or request bodies.
- **Rate limits:** at most 20 notifications per hour per channel. Excess notifications are coalesced into one summary notification.

### 13.4 Alert API (owner writes; viewers read the two registered GETs, §11.8)

| Method and path | Body / response |
|---|---|
| `GET /api/telemetry/alerts?state=firing\|all&limit` | `{rows:[{ruleId, scopeKey, state, severity, title, value, threshold, since, firedAt, ackedAt, silencedUntil}]}` |
| `GET /api/telemetry/alert-rules` | `{rules:[rule…], metrics: ALERT_METRICS (id, unit, scopes, label zh/en)}` |
| `POST /api/telemetry/alert-rules` | Custom rule `{metric, scope, op, threshold, clearThreshold?, windowS, forS, minSamples?, severity, channels, titleZh, titleEn}`. Returns 201 `{rule}`; a bad value returns 400 with `errors[]`. |
| `PUT /api/telemetry/alert-rules/:ruleId` | Partial update. Builtin rules accept `enabled`, `threshold`, `clearThreshold`, `forS`, `windowS`, `severity`, `channels` and `cooldownS`. Writes `config.alerts`. |
| `DELETE /api/telemetry/alert-rules/:ruleId` | Custom rules only. Builtin rules return `409 builtin_rule`. |
| `POST /api/telemetry/alerts/:ruleId/ack` `{scopeKey}` and `/silence` `{scopeKey, until}` | Return `{ok, state}`. |
| `POST /api/telemetry/alerts/test` `{channel:"inapp"\|"toast"\|"webhook", webhookId?}` | Sends a test notification and returns `{ok, delivered, error?}`. |

## 14. Energy cost

- Configuration in `telemetry.energy`:
  ```json
  { "pricePerKwh": null, "currency": "CNY", "tariffs": [{ "from": "23:00", "to": "07:00", "pricePerKwh": 0.31 }], "hostBaselineWatts": 0 }
  ```
  - `pricePerKwh: null` means no price is configured. The UI then shows kWh only and offers to set a price (open decision O2). The tariff time windows are local time and may cross midnight.
  - `hostBaselineWatts` is added to the GPU energy only in `/energy` totals, labelled "host baseline (configured)".
- Integration: `gpu_samples.energy_wh` (§8).
- Attribution: per sample interval, each GPU's `energy_wh` is split across the instances whose `gpuIds` include it.
  - The split is proportional to `output_tps + prompt_tps/8`, with prefill weighted lower.
  - If all instances are idle, the energy is split evenly and counted as idle.
  - With no instance, it goes to `unassigned` idle.
  - The result is stored in `runtime_samples.energy_wh` and rolled up.
- Cost is computed at query time per hour bucket with the tariff in force for that hour (`priceAt`), using the **current** configuration. The UI label says "按当前电价计算 / at current tariff". `costPerMOutputTokens = cost / (outputTokens / 1e6)`.

## 15. Billing usage summary (read-only on immutable tables)

`service-entry/lib/billing-store.js` additions. These are read-only; schema changes add indexes only, and `CREATE INDEX` on the immutable tables is allowed because the triggers block only UPDATE and DELETE.

```sql
CREATE INDEX IF NOT EXISTS idx_billing_usage_at ON billing_usage_events(at);
CREATE INDEX IF NOT EXISTS idx_billing_usage_external ON billing_usage_events(external_request_id);
CREATE INDEX IF NOT EXISTS idx_billing_tts_usage_at ON billing_tts_usage_events(at);
```

Additions:
- `summarizeUsage({kind:"llm"|"tts", groupBy:[…], from, to, customerId?, managerId?, tzOffsetMinutes?, limit≤1000})`.
  - The groupBy whitelist is `customer, model, manager, endpoint, day, hour, month, terminal_state, usage_source, decision_code, enforcement_mode`.
  - Time keys come from `strftime('%Y-%m-%d', at, '+<offset> minutes')` with the offset validated as an integer.
  - Microcredits are summed as BigInt and returned as decimal strings.
- `getUsageByExternalRequestId(id)` and `lookupCustomerForCredential(managerId, clientId)`.
- `listUsage` gains `cursor` (keyset on `(at, usage_id)`) while keeping `offset`.

`GET /api/billing/usage/summary?kind=llm&groupBy=customer,model,day&from&to&customerId&managerId&tzOffsetMinutes&limit` needs the `owner` role (05 PUB-5) and stays localhost-only like the other admin billing routes (`strictLocalBillingAdmin`).

```json
{ "ok": true, "kind": "llm", "groupBy": ["customer","model","day"], "from": "2026-10-01T00:00:00.000Z", "to": "2026-10-15T00:00:00.000Z", "tzOffsetMinutes": 480,
  "rows": [ { "customerId": "1a2b…", "customerName": "test", "model": "qwen3.8-flash", "day": "2026-10-13", "requests": 42, "ok": 40,
              "inputTokens": 123456, "cachedInputTokens": 1000, "outputTokens": 45678, "totalTokens": 169134,
              "projectedMicrocredits": "123400", "chargedMicrocredits": "0", "estimatedUsageRequests": 2, "shadowRequests": 42 } ],
  "totals": { "requests": 42, "chargedMicrocredits": "0", "…": "…" }, "truncated": false }
```

`GET /api/billing/usage?cursor=…` adds `nextCursor` to the response. Existing fields and behaviour are unchanged, and `tests/billing-page.spec.cjs` stubs keep working.

`billing.html` (CSP stays `script-src 'unsafe-inline'`). This is a delta on P0-17 (in P0-UI-1), which already relabelled the raw table "最近请求（原始记录，最多 100 条）/ Recent requests (raw records, latest 100)" with the columns time / customer / manager / model / tokens / status. TEL-14 keeps that heading, those columns and P0-17's assertions unchanged, and adds:
- a new "本期用量（按客户 × 模型 × 月汇总）/ Usage this period (by customer × model × month)" table above it, fed by `summary?groupBy=customer,model,month`. P0-17's explanatory sentence "the aggregate view arrives with the telemetry store" is replaced by this table;
- a daily bar chart drawn as inline SVG (no library) from `summary?groupBy=day`.

The page keeps working wherever it is served: at `/billing` today, and at `/billing/classic` after 07 CON-2 retargets it. TEL-14 edits only `billing.html` and the spec assertions, never the base path in `tests/billing-page.spec.cjs`. After PUB-5 the page needs an owner session, and the spec's `/api/session` stub covers that.

## 16. Audit additions (on top of P0-OBS-6)

### 16.0 What P0-OBS-6 already does (kept unchanged; not re-specified here)

- Chain-aware pruning: it keeps the newest full export and every newer export. Older exports are pruned by count (`AI_AUDIT_MAX_EXPORTS`) and age (`AI_AUDIT_MAX_AGE_DAYS`, 90). An empty incremental is prunable except the newest one. Without any full export, incrementals are never pruned.
- An empty incremental writes no directory and records `lastHeartbeatAt` in the cursor.
- Rebaseline: a full export is due when the newest full is older than `AI_AUDIT_REBASELINE_DAYS` (default 7; `0` disables).
- The exporter cursor comes from the fetched rows, and the Markdown stream has an error handler.

This is the one audit retention policy (§25 C7). TEL adds only the three things below: `maxChains`, the export lock and the entry scheduler.

### 16.1 Export lock

- The audit root stays at `AI_AUDIT_ROOT` (default `<AI_ROOT>/audit-logs`).
- `audit-store.js#exportOpenWebuiAudit` and `pruneAuditExports` take an exclusive lock file `<auditRoot>/.audit-export.lock`. The lock file holds `{pid, at, owner}` and is created with `wx`. A lock older than 30 min, or held by a dead pid, is broken and logged. A held lock returns `{ok:false, skipped:true, reason:"export_in_progress"}`. This fixes the two managers sharing one root and cursor (F8).
- Manager stop and unload triggers stay in place and use the same lock and rules.

### 16.2 Chain cap (`audit-chain.js`)

- `planAuditRetention(exports, policy, now)` is P0-OBS-6's rules moved into a pure function, with identical results for every P0-OBS-6 test case. `pruneAuditExports` calls it.
- The one addition is `policy.maxChains` (default 8, `audit.retention.maxChains`). A chain is one `full` export plus every `incremental` after it, up to the next full; legacy exports without a `mode` count as full (the `listAuditExports` fallback). Whole chains older than the newest `maxChains` are removed. The active chain is never removed, and a full export is never removed while a kept incremental depends on it.
- `needsRebaseline` is exactly P0-OBS-6's trigger (`rebaselineDays` from `AI_AUDIT_REBASELINE_DAYS`). There is no second rebaseline rule.
- Golden fixture: the live layout (30 exports, 22 empty, the only full export with counts at position 26). The expected result keeps that full export plus the non-empty incrementals after it.

### 16.3 Scheduled exports (`audit-scheduler.js`, entry)

- Config `audit.schedule = { enabled: true, incrementalEveryMinutes: 60, fullAtLocal: "04:00" }`. The scheduler ticks every minute. It runs a full export at the first `fullAtLocal` slot after `needsRebaseline` becomes true, so the full cadence is P0-OBS-6's `rebaselineDays` and no separate "full every N days" setting exists.
- It skips with the event `audit.export.skipped` (reason `openwebui_missing`) when the OpenWebUI container does not exist. It never starts Docker or containers.
- Each run records `audit.export` or `audit.export.failed`, updates `collector_state.audit` (`{lastRunAt, lastOkAt, lastError, nextIncrementalAt, nextFullAt}`), runs the retention plan after a success and indexes the new export (§16.5).

### 16.4 Audit-of-audit log

Every audit action through the entry or the managers appends an `audit_access_log` row:

```
hash = sha256(prev_hash + "\n" + canonical JSON {at, source, actor, session, client_ip, user_agent, action, target, outcome, detail})
```

- `prev_hash` is `"0"*64` for the first row.
- Actions: `login_ok`, `login_failed`, `logout`, `list_exports`, `view_markdown`, `list_chats`, `search`, `view_chat`, `chat_versions`, `link_lookup`, `export_manual`, `export_scheduled`, `export_failed`, `export_skipped`, `prune`, `settings_change`, `verify`.
- Search terms are stored as `{querySha256, queryLength}` unless `audit.logQueryText=true`.
- The managers' legacy `/api/audit/*` routes (registerAuditRoutes) gain an `onAccess(entry)` dependency that posts to `/internal/telemetry/audit-access`. The post is spooled like §6.7, and spooled entries are appended in arrival order with their original `at`.
- `GET /api/audit/access-log/verify` recomputes the chain and returns `{ok, rows, firstBrokenSeq|null}`.
- Login throttle: 5 failures per minute per IP gives `429 audit_login_throttled`, and each failure is logged.

### 16.5 Conversation index and browser API

- The index is `<auditRoot>/.index/audit-index.sqlite`. It is kept apart from `telemetry.sqlite` because it holds conversation content and shares the audit folder's protection.
- Tables:
  - `chats(chat_id, audit_id, user_id, user_name, user_email, user_role, title, models JSON, created_at, updated_at, message_count, archived, is_latest)`, PK `(chat_id, audit_id)`;
  - `messages(chat_id, audit_id, msg_id, parent_id, role, model, ts, content_sha256, content)`;
  - `fts USING fts5(title, content, tokenize='trigram')`, linked by rowid.
  - `is_latest` marks the newest export containing the chat.
- Indexing runs in a short-lived worker per export (`openwebui-chats-full.json`, up to about 10 MB). Existing exports are back-filled on first start, newest first. Pruned exports are removed from the index.
- Queries shorter than 3 characters fall back to `LIKE` on titles only.

Endpoints:
- These live on the entry, in `service-entry/lib/audit-http.js`.
- All require the ADMIN listener and the `owner` role (05 PUB-5, CSRF on writes). Content routes (`chats*`, `exports/:id/markdown`, `access-log*`) also need the audit session, a second factor on top of the admin session. It is read from `x-audit-session` (preferred), or from `Authorization: Bearer <token>` when that bearer is not a 05 `pat_` tool token (what 07's `audit-session.js` sends today).
- Audit sessions are kept in memory as sha256 hashes, last 12 h with a sliding window, and are created by `audit-store.js#verifyAuditPassword` against the existing password sources. The entry never copies, logs or returns the password. That password file is pre-existing plaintext (06 doctor `sec.plaintext-secrets`); its migration is not owned here (§25 R7).

| Method and path | Response |
|---|---|
| `GET /api/audit/status` | `{passwordFile:"<redacted path>", openWebuiContainer:{exists, running}, schedule, lastRuns, chains:[{fullAuditId, createdAt, incrementals, chats, messages, bytes, active}], retention:{policy, plan:{remove:[…], warnings, needsRebaseline}}, index:{chats, messages, lastIndexedAt}}`. Owner; no audit session needed; no content. |
| `POST /api/audit/login` `{password}` → `{ok, token, expiresAt}` / `POST /api/audit/logout` | — |
| `GET /api/audit/exports` | Same shape as the manager route, plus `chainId` and `skippedEmpty`. |
| `GET /api/audit/exports/:auditId/markdown` | Reuses P0-OBS-6's stream error handling: `404 audit_file_missing`, or `500` without crashing. |
| `POST /api/audit/export` `{mode:"full"\|"incremental", note}` | `{ok, auditId?, skipped?, reason?}` |
| `GET /api/audit/chats?q&user&model&from&to&archived&cursor&limit≤100` | `{rows:[{chatId, title, userName, userEmail, models, createdAt, updatedAt, messageCount, auditId, versions}], nextCursor}` |
| `GET /api/audit/chats/:chatId?auditId` | `{chat:{…}, messages:[{id, parentId, role, model, timestamp, content, contentType:"markdown"}], auditId, isLatest}`. The console renders `content` as sanitised Markdown and never as raw HTML. |
| `GET /api/audit/chats/:chatId/versions` | `{versions:[{auditId, createdAt, messageCount, updatedAt}]}` |
| `GET /api/audit/access-log?from&to&cursor` / `GET /api/audit/access-log/verify` | Rows, or the verification result. |
| `GET /api/audit/settings` / `PUT` | `{schedule, retention, logQueryText}` with an `etag`. PUT calls `writeSection("audit", patch, {etag})` (06 OPS-3) and logs `settings_change`. |

## 17. Compatibility facades

### 17.1 Manager `/api/stats` (both managers; shape unchanged, sampling fixed)

TEL-1 is a delta on P0-OBS-5 (the 60 s ring window in `calculateRecentRates`, `windowSeconds`) and P0-RT-5 (speed sources). Everything those packages ship stays byte-for-byte: P0 C2 makes them must-keep (§25 C8).

What TEL-1 adds (`collectors/manager-stats-sampler.js`, wired in `vllm-manager/server.js` and `llama-manager/server.js`):
- One background timer runs every `STATS_SAMPLE_INTERVAL_MS` (default 10 000, minimum 5000), independent of the UI.
  - Per running instance it scrapes `/metrics` once per tick through the existing summary function, which feeds P0-OBS-5's ring as today. It keeps the last 31 cumulative snapshots (5 min) for `latency.window`, and keeps the last scrape text for `lastScrape()` (§7.1).
- `collectStats()` no longer scrapes. It reads `sampler.latest()` and the windowed values, so a UI poll costs no engine scrape. `updateStatsLedger` runs from the sampler at most every 60 s, plus at the existing `snapshotCurrentStats` points. `metricsHistoryStore.recordMetricsHistory` runs from the sampler every 60 s.

Field semantics:
- **Kept exactly as P0 ships them:**
  - `speed.recentOutputTokensPerSecond`, `recentPromptTokensPerSecond`, `recentRequestsPerMinute` (P0-OBS-5 window);
  - `speed.windowSeconds` (the actual baseline age);
  - `speed.outputSource ∈ {"counter_window", "sglang_gen_throughput_gauge"}`, including P0-RT-5's SGLang gauge fallback while `num_running_reqs > 0`, which builds without token counters need;
  - llama's `averageOutputTokensPerSecond` from `llamacpp:predicted_tokens_seconds`;
  - `latency.avg*`.
- **Added, purely additive:**
  - `speed.window = {seconds, source, idle}`, where `seconds` equals `speed.windowSeconds`, `source` equals `speed.outputSource` (no second vocabulary), and `idle` is true when no counter moved and `running == 0`;
  - `speed.averageSource = "engine_lifetime_gauge"` whenever an `average*` value comes from a lifetime gauge;
  - `latency.scope = "since_process_start"` and `latency.window = {seconds: 300, ttftP50Seconds, ttftP95Seconds, e2eP95Seconds, itlP50Seconds, queueP95Seconds, requests}` from bucket deltas (null when there are no histograms).
- `trends` keeps `{hours, samples}`, downsampled server-side to ≤ 288 points. For the vLLM manager it is filtered to the current engine as today.
- A grep test asserts that no `updateSamples: true` remains in either `server.js`. MCP `get_performance` reads `totals.*` and `models[]` unchanged.

### 17.2 Entry facades

- `GET /api/gateway-access?limit&maxLines&window=1h` and `GET /api/status` `.entry.gatewayAccess` are computed from the store over an explicit time window (default 1 h), not from "last N lines". The shape is unchanged: `{ok, updatedAt, logPath, privacy, totals, external, local, clients, paths, models, authSources, kinds, statuses, timeline, recent}`.
  - `maxLines` is accepted and ignored.
  - `logPath` points to the store file label `telemetry.sqlite`.
  - `external` uses `ingress ∈ {public}`, or a `client_ip` that is not local.
  - Redaction for remote viewers (`redactAccessForRemote`) stays.
- Manager `/api/external-access` and `/api/access-logs/{search,export}` keep reading the manager JSONL files. These carry vouched addresses and request ids since P0-OBS-3 and PUB-10, plus TEL-2's fields (§6.6). The legacy pages get a "moved to the console" banner in 07.

## 18. Importers (`importers.js`)

- Importers are read-only on their sources and idempotent: `import_runs (source, file_key = path label + size + mtime + offset)` and `dedupe_key` on events.
- `dryRun` returns counts only.
- Rows older than the raw TTL go straight into `rollup_1h`/`rollup_1d` with `source='import'`. They are never inserted raw.

| Source | Mapping | Not imported (why) |
|---|---|---|
| `metrics-history` (`<manager>/logs/metrics-history.json`) | GPU fields go to `gpu_rollup_1m` (if within 14 d) and to `_1h`/`_1d` (`gpu_index` 0; −1 when the sample aggregated several GPUs). `requests.total` deltas per `(engine, container, model)`, with resets on decrease or a container change, go to `runtime_rollup_1h.d_requests`. | Throughput, latency and speculative fields: these are polling artefacts (F1) and lifetime averages (F3). |
| `stats-ledger` | One `lifetime_baseline` row per `(manager, model)`, shown only as "imported lifetime totals". | Mixing into time series, because there is no time axis. |
| `access-logs` (manager `service-gateway-access.log*`, entry `gateway-access.log*`, up to 5 rotations) | `requests` with `ingress = import:manager` or `import:entry`, `request_id = imp_ + sha256(fileLabel + lineNo + at)[0..20]`, classification per §5. An entry row matching a manager row within 2 s with the same model and status gets `extra.dupOf`, and rollups skip it (best effort). | Control routes (the TTS poll flood): counted into `control_counts_1m` only within 14 d. |
| `service-usage` (`service-usage.sqlite`) | Backfills tokens and `usage_source` onto imported manager rows matched by `(client_id, model, status, abs Δat ≤ 2 s)`. | Unmatched events are reported, not inserted, to avoid double counting. |
| `jobs-ledger` | `launch.*` events with durations from `stageHistory`; automation jobs become `gpu.guard`. | Download jobs (owned by the hub, 03). |
| `process-exit` | `manager.*` events, including `hard_kill_suspected`. | — |
| `audit-manifests` | `audit.export` events. | — |
| `benchmarks` | `benchmark.run` events. | — |
| `mcp-audit` | `mcp.tool_call` events (90 d TTL). | — |

The import report is `{source, files, rowsIn, rowsWritten, rowsSkipped:{reason:count}, rangeFrom, rangeTo, warnings}`. The console shows it once with "导入完成 / Import finished".

## 19. Console data contract (rendered by 07)

All pages share a header with a time range (15 m, 1 h, 6 h, 24 h, 7 d, 30 d, custom), filters (manager, instance, model, key, source, protocol) and an auto-refresh toggle. The state lives in the URL query.

| Page › panel | Endpoint and parameters | Fields rendered |
|---|---|---|
| Observability › Overview › live strip | `/api/events` `telemetry.live`; fallback `GET /api/telemetry/live` | `gateway.*`, `instances[].{model, state, idle, running, waiting, kvUsage, outputTps}`, `gpus[]` |
| Overview › KPI tiles | `GET /api/telemetry/summary?compare=previous` | `current.*` vs `previous.*` deltas; the window label on every tile |
| Overview › tile sparklines | `timeseries?metrics=req.count,req.error_rate,lat.ttft_p95,tok.output_per_s` | `points` |
| Overview › alert banner | `GET /api/telemetry/alerts?state=firing` plus `alerts` events | `title`, `severity`, `since`, `link` |
| Overview › requests by status | `timeseries?metrics=req.count&groupBy=status_class` (stacked) | — |
| Performance › latency | `timeseries?metrics=lat.ttft_p50,lat.ttft_p95,lat.ttft_p99&groupBy=model&annotate=launch,config,benchmark,container` | series and annotations |
| Performance › engine | `timeseries?metrics=rt.output_tps,rt.running,rt.waiting,rt.kv_usage,rt.prefix_hit,rt.spec_accept&groupBy=fleet` | `latency_source` badge from `/live` |
| Performance › TTFT heatmap | `timeseries?metrics=lat.ttft_hist` | `le`, matrix |
| Traffic › by key / source / protocol | `timeseries?metrics=req.count&groupBy=key\|source\|protocol`; `breakdown?dim=key&spark=1` | rows: requests, errorRate, tokens, ttftP95Ms |
| Traffic › auth failures by IP (admin) | `breakdown?dim=client_ip&error_class=auth_failed,auth_banned`; `events?type=security.ban` | — |
| Errors › rate by class | `timeseries?metrics=req.errors&groupBy=error_class` | — |
| Errors › class table | `breakdown?dim=error_class` | `firstSeen`, `lastSeen`, `sampleRequestIds`; a click opens Requests prefiltered |
| GPU & Energy › charts | `timeseries?metrics=gpu.util,gpu.mem_used_mb,gpu.temp_c,gpu.power_w,gpu.sm_clock_mhz&groupBy=gpu`; `gpu.throttle_seconds&groupBy=reason` | — |
| GPU & Energy › VRAM by instance | `/live instances[].vramReservationMb` (labelled as a reservation) | — |
| GPU & Energy › energy | `energy?groupBy=day` and `energy?groupBy=model` | kWh, cost, costPerMOutputTokens, `priceConfigured` |
| Models & Instances › lifecycle Gantt | `GET /api/telemetry/lifecycle` | intervals |
| Models & Instances › launch reliability | `GET /api/telemetry/launches?groupBy=model` | started, ready, failed, readyP50Seconds, topFailures |
| Models & Instances › truncation | `breakdown?dim=model&metrics=requests,lengthShare` | — |
| Models & Instances › imported lifetime | `GET /api/telemetry/baseline` | — |
| Requests › table | `GET /api/telemetry/requests?facets=1&cursor` | columns as chosen; facets sidebar |
| Requests › detail drawer | `GET /api/telemetry/requests/:id` (with `x-audit-session` if unlocked) | timeline waterfall, billing, instance, events, audit link |
| Requests › export | `GET /api/telemetry/export?kind=requests&format=csv` | download |
| Alerts | `alerts`, `alert-rules`, ack, silence, test; webhooks from `GET /api/telemetry/settings` | — |
| Billing (console view) | `GET /api/billing/usage/summary?groupBy=customer,model,day`; raw drill-down `GET /api/billing/usage?cursor` | — |
| Audit › Conversations | `GET /api/audit/chats`, `/chats/:id`, `/chats/:id/versions` | — |
| Audit › Export chain | `GET /api/audit/status`, `POST /api/audit/export` | — |
| Audit › Access log | `GET /api/audit/access-log`, `/verify` | — |
| Settings › Telemetry | `GET` / `PUT /api/telemetry/settings`, `GET /api/telemetry/status`, `POST /api/telemetry/import` | — |

Empty and edge states the console must show, with copy keys from §19.1:
- an engine without the metric (`latency_source` is `none`, or the metric appears in `unsupported`);
- an idle instance;
- a collection gap (`null` points);
- no price configured;
- the audit index still building;
- a read-only viewer (05 `viewer` role, loopback or LAN).

### 19.1 Copy keys (zh / en), area file `service-entry/console/i18n/telemetry/{zh-CN,en-US}.json`

04 owns the `telemetry` area of 07 CON-2's per-area i18n loader and creates the two files in TEL-19. The area owns the key prefixes `obs.*` and `audit.*` only; error classes, terminal states and alert states live under `obs.` so they cannot collide with 01's `err.*` keys. The alert-rule titles (`title_zh`/`title_en`) stay in the rule rows, not in the catalog. 04 writes no keys into the shared catalogs or any other area.

| Key | zh | en |
|---|---|---|
| obs.title | 可观测性 | Observability |
| obs.window | 过去 {window} | Last {window} |
| obs.kpi.requests | 请求数 | Requests |
| obs.kpi.errorRate | 错误率 | Error rate |
| obs.kpi.ttftP95 | 首字延迟 p95 | Time to first token (p95) |
| obs.kpi.decodeTps | 生成速度（中位数） | Generation speed (median) |
| obs.kpi.tokensOut | 输出 tokens | Output tokens |
| obs.kpi.cachedShare | 提示缓存命中占比 | Cached prompt share |
| obs.kpi.gpuUtil | GPU 平均利用率 | Average GPU utilization |
| obs.kpi.energy | 能耗 | Energy used |
| obs.kpi.cost | 电费（按当前电价） | Electricity cost (current tariff) |
| obs.idle | 空闲：此时段没有请求 | Idle: no requests in this interval |
| obs.gap | 采集中断（服务未运行） | Collection gap (service was not running) |
| obs.noMetric | 该引擎不提供此指标 | This engine does not report this metric |
| obs.latencyFromGateway | 由网关测得（引擎无直方图） | Measured at the gateway (engine has no histograms) |
| obs.reservation | 显存预留（非实测） | VRAM reservation (not measured) |
| obs.noPrice | 尚未设置电价，仅显示用电量 | No electricity price set; showing energy only |
| obs.importedLifetime | 导入的历史累计（无时间分布） | Imported lifetime totals (no time breakdown) |
| obs.lanReadOnly | 只读视图：已隐藏 IP、密钥与请求明细 | Read-only view: IPs, keys and request details are hidden |
| obs.err.none / client_abort / upstream_timeout | 成功 / 客户端中断 / 上游超时 | Succeeded / Client cancelled / Upstream timed out |
| obs.err.auth_failed / auth_banned / forbidden | 鉴权失败 / 鉴权封禁 / 无权限 | Authentication failed / Temporarily banned / Not permitted |
| obs.err.rate_limited / quota_denied / billing_unavailable | 触发限流 / 额度不足 / 计费服务不可用 | Rate limited / Quota exhausted / Billing unavailable |
| obs.err.no_runtime / config_error / context_overflow | 无可用模型 / 配置错误 / 超出上下文长度 | No model available / Configuration error / Context too long |
| obs.err.bad_request / upstream_unreachable / upstream_5xx | 请求无效 / 上游不可达 / 上游错误 | Invalid request / Upstream unreachable / Upstream error |
| obs.err.stream_error / internal | 流式中断 / 入口内部错误 | Stream interrupted / Gateway internal error |
| obs.term.completed / failed / client_abort / timeout / rejected | 完成 / 失败 / 客户端中断 / 超时 / 已拒绝 | Completed / Failed / Cancelled by client / Timed out / Rejected |
| audit.title | 会话审计 | Conversation audit |
| audit.unlock | 输入审计密码以查看会话内容 | Enter the audit password to view conversations |
| audit.chain | 导出链：1 个完整基线 + {n} 个增量 | Export chain: 1 full baseline + {n} incrementals |
| audit.rebaseline | 需要重新做完整导出，避免历史无法恢复 | A new full export is needed so history stays recoverable |
| audit.accessLog | 审计访问记录（不可修改） | Audit access log (append-only) |
| audit.chainBroken | 访问记录校验失败：第 {seq} 条之后被改动 | Access log verification failed after entry {seq} |
| obs.alert.firing / resolved | 告警中 / 已恢复 | Firing / Resolved |

Every alert rule carries `title_zh` and `title_en` in its row. Labels show the meaning first, and the raw metric id only appears as secondary text (00 §7.6).

## 20. Configuration

`<AI_ROOT>/config/platform.json` sections `telemetry` and `audit`. 06 OPS-3 is the sole owner of `platform-config.schema.json`, the env-to-key map and the writer. The table below is 04's input to that schema, and TEL packages never edit the schema file or write `platform.json` directly. They read with `readSection("telemetry" | "audit")` and write with `writeSection(name, patch, {etag})`. Precedence is env > file > default (D9). Each env var maps to exactly one key.

```json
{ "telemetry": { "enabled": true, "dbPath": "", "sampleIntervalMs": 10000, "managerSampleIntervalMs": 10000, "timezoneOffsetMinutes": 480,
    "keepJsonlAccessLog": true, "maxDbMb": 2048, "exportMaxRows": 200000,
    "retention": { "requestsDays": 30, "ipDays": 30, "samplesHours": 48, "minuteDays": 14, "hourDays": 400, "eventsDays": 400 },
    "energy": { "pricePerKwh": null, "currency": "CNY", "tariffs": [], "hostBaselineWatts": 0 },
    "alerts": { "webhooks": [] } },
  "audit": { "root": "", "schedule": { "enabled": true, "incrementalEveryMinutes": 60, "fullAtLocal": "04:00" },
    "retention": { "maxExports": 30, "maxAgeDays": 90, "rebaselineDays": 7, "maxChains": 8 }, "logQueryText": false } }
```

| Key | Type, range | Env (sole mapping) | Applies | Title zh / en |
|---|---|---|---|---|
| `telemetry.enabled` | bool | `TELEMETRY_ENABLED` | restart entry | 启用遥测 / Enable telemetry |
| `telemetry.dbPath` | path; `""` = `service-entry/data/telemetry.sqlite` | `AI_TELEMETRY_DB` | restart entry | 遥测数据库位置 / Telemetry database location |
| `telemetry.sampleIntervalMs` | int 5000–60000 | `TELEMETRY_SAMPLE_INTERVAL_MS` | live | 入口采样间隔 / Entry sampling interval |
| `telemetry.managerSampleIntervalMs` | int 5000–60000 | `STATS_SAMPLE_INTERVAL_MS` | restart vllm-manager, llama-manager | 管理器统计采样间隔 / Manager stats sampling interval |
| `telemetry.timezoneOffsetMinutes` | int, whole hours, −720–840; default host offset | — | live | 按天汇总所用时区 / Time zone for daily totals |
| `telemetry.keepJsonlAccessLog` | bool | — | live | 保留旧版访问日志文件 / Keep the legacy access-log file |
| `telemetry.maxDbMb` | int 256–65536 | — | live | 数据库大小上限 / Database size limit |
| `telemetry.exportMaxRows` | int 1000–1000000 | — | live | 单次导出行数上限 / Rows per export |
| `telemetry.retention.requestsDays` / `.ipDays` / `.samplesHours` / `.minuteDays` / `.hourDays` / `.eventsDays` | ints per §4.3; `ipDays ≤ requestsDays` | — | live | 请求明细 / IP 与客户端信息 / 原始采样 / 分钟汇总 / 小时汇总 / 事件 保留时长; Keep request rows / IP and client info / raw samples / minute totals / hourly totals / events for |
| `telemetry.energy.pricePerKwh`, `.currency`, `.tariffs[]`, `.hostBaselineWatts` | number\|null; ISO 4217; `[{from:"HH:MM", to:"HH:MM", pricePerKwh}]`; int 0–2000 | — | live | 电价 / 币种 / 分时电价 / 主机基础功耗; Electricity price / Currency / Time-of-use tariffs / Host baseline power |
| `telemetry.alerts.webhooks[]` | `[{id, url (^https?://), format, minSeverity}]`; secrets in the secret store | — | live | 告警推送地址 / Alert webhooks |
| `audit.root` | path; `""` = `<AI_ROOT>/audit-logs` | `AI_AUDIT_ROOT` | restart entry, vllm-manager, llama-manager | 审计导出目录 / Audit export folder |
| `audit.schedule.enabled`, `.incrementalEveryMinutes`, `.fullAtLocal` | bool; int 15–1440; `HH:MM` | — | live | 定时导出 / 增量间隔 / 完整导出时刻; Scheduled exports / Incremental interval / Full export time |
| `audit.retention.maxExports` | int 1–10000 (soft cap, P0-OBS-6) | `AI_AUDIT_MAX_EXPORTS` | live | 导出数量上限 / Export count limit |
| `audit.retention.maxAgeDays` | int 1–3650 | `AI_AUDIT_MAX_AGE_DAYS` | live | 导出保留天数 / Keep exports for (days) |
| `audit.retention.rebaselineDays` | int 0–365; 0 disables (P0-OBS-6) | `AI_AUDIT_REBASELINE_DAYS` | live | 完整基线间隔 / Full baseline every (days) |
| `audit.retention.maxChains` | int 2–100 | — | live | 保留的导出链数量 / Export chains to keep |
| `audit.logQueryText` | bool | — | live | 记录审计搜索原文 / Log audit search text |

Each leaf's bilingual description is the matching row of §4.3, §14 or §16, condensed to one sentence by OPS-3's schema author. Cross-field rules for OPS-3's validator: `ipDays ≤ requestsDays`, `timezoneOffsetMinutes % 60 == 0`, and tariff windows may cross midnight but may not overlap. `/api/telemetry/settings` also runs `assertSafeWebhookUrl` before calling `writeSection`. `PLATFORM_MCP_AUDIT_LOG` is read the way platform-mcp reads it and is not mapped by 04. `TELEMETRY_ENABLED=0` disables the recorder and collectors; the gateway is unaffected.

## 21. Security and privacy

- **No content in telemetry:**
  - The sniffer discards event text after parsing.
  - `error_code` is an enum-like code; free-text error messages are never stored.
  - Request bodies, prompts, completions and API keys are never written to `telemetry.sqlite`, events or exports.
  - A test scans a recorded DB after the fixtures run for marker strings planted in the prompts and completions.
- **Personal data:**
  - The IP, user agent and OpenWebUI ids are kept for at most `ipDays`.
  - Rollups contain no IP or user agent.
  - The console privacy text states what is kept and for how long (open decision O1).
- **Request id trust:** client ids are never keys (C1). The context rides on 05's single v2 hop and is covered by its signature and 60 s replay window. A failed verification means direct ingress (fail closed, §5.2). There is no second signature scheme.
- **Internal ingest:** loopback, 05 `internal-auth.js` HMAC (the only internal signing module), its manager allowlist, size caps, per-row validation and idempotent inserts.
- **Access:** owner sessions, tool tokens and CSRF come from 05 PUB-5. Viewers see only the §11.8 registrations, and machine callers (`system:supervisor`) authenticate with the internal HMAC, never with a forgeable header.
- **Query surface:**
  - Whitelisted dimensions, metrics and sorts, with prepared statements only.
  - A global per-request time cap: worker queries over 2 s are interrupted with `500 query_timeout`. This uses a statement step budget, so a long range reads rollups and never scans raw tables.
- **Exports:** formula-escaped CSV, row caps, and owner only.
- **Audit:**
  - Content stays under the audit root.
  - Every access is logged in a hash chain.
  - Login is throttled.
  - Audit sessions are hashed in memory and are a second factor on top of the owner session.
  - Markdown is rendered sanitised by the console.
- **Secrets:** 04 persists exactly one kind of secret, webhook signing secrets, and only in 06 OPS-3's `manager-core/secret-store.js` (namespace `webhooks`; DPAPI CurrentUser per value, owner-only ACL, under `<AI_ROOT>/.runtime/secrets/`, excluded from release and backup; ACL-only fallback with a doctor warning). 04 creates no secret file, and nothing goes to `runtime-secret-store.js`, `platform.json` or `logs/`.
- **Webhooks:** owner-configured, SSRF guard (§13.3) and minimal payloads.
- **Public listener (05):** no `/api/telemetry`, `/api/audit` or `/internal/telemetry` routes exist there. The portal's own usage view (`/v1/me`, owned by 05) may call `query.summary` and `listRequests` restricted to the caller's `key_id`, without IP, user agent or OpenWebUI fields.
- **Logging:** collector errors, event payloads and launch messages pass through `manager-core/secret-redactor.js` (`redactSecrets`/`redactValue`, marker `<redacted>`) before `appendLog`, the store or the console (00 hard rule). 04 has no redact helper of its own.

## 22. Failure modes

| Failure | Behaviour |
|---|---|
| Entry down | Managers spool direct rows and audit-access events. Entry-routed traffic does not exist while the entry is down. Charts show `null` gaps (coverage). |
| Store worker crash | Restart with backoff (1 s → 60 s). The recorder buffer keeps up to 10 000 rows. `telemetry_stale` fires and the gateway is unaffected. |
| DB open or migration failure | Degraded mode (§4.1), status `store: "unavailable"`, critical event. The file is never auto-deleted. |
| Disk full (`SQLITE_FULL`) | Raw inserts are dropped and counted, rollups continue if possible, and `disk_low` and `telemetry_stale` fire. |
| Manager lacks the 01 metrics route (partial deploy) | `/api/stats` delta fallback (§7.2 step 8), `latency_source = none`. |
| Secret store unavailable (DPAPI child fails, ACL error) | Webhooks that need a secret are skipped with `alert.notify_failed {reason:"secret_unavailable"}`; unsigned webhooks and in-app alerts keep working. Settings PUT with a secret returns `503 secret_store_unavailable`. |
| ENT-EV stream has no subscribers | `telemetry.live` is not built; alerts and notifications are still published (ENT-EV's ring buffer keeps them for replay). |
| Counter reset, container replace or new launch | `reset=1` row, no negative deltas. |
| Wall clock jumps backwards more than 5 s | The sample delta is skipped. Durations always use the monotonic clock. |
| nvidia-smi missing or hanging | 5 s timeout, backoff to 60 s, GPU charts show gaps. |
| Docker not running | The docker events stream reconnects with backoff. Docker is never started. |
| Two exporters at once (scheduler and a manager stop) | The lock makes the second one return `export_in_progress`. |
| An 8 MB export to index | Indexed in a separate worker; the API answers `index: {building:true}` meanwhile. |
| Huge breakdown cardinality (many keys) | `top`, `limit` caps and `otherGroups`. Rollup PKs bound rows per bucket. |
| Spool overflow (> 20 MiB) | The oldest lines are dropped and the event `telemetry.spool_dropped` is sent once the entry is reachable. |

## 23. Tests

New node:test files. Fixtures live in `manager-core/test/fixtures/telemetry/`. They use documentation IP ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) and no real names, paths or domains, so the release privacy scan passes.

| File | Covers |
|---|---|
| `manager-core/test/telemetry-ids.test.js` (TEL-4) | `req_`/`mgr_` format and entropy; `normalizeClientRequestId`; the existing manager normaliser accepts a `req_` id (pins the F6 withdrawal) |
| `manager-core/test/telemetry-hop.test.js` (TEL-2) | Context JSON build and parse (≤ 256 bytes; an unknown `v` gives `context:null`). With 05's `verifyEntryRequest`: a tampered context fails the v2 signature; a valid hop puts `hop.requestId`, `principal.k` and `context.src` into the access row; no hop gives a `mgr_` fallback and a direct report |
| `telemetry-classify.test.js` | Golden table: every row of §5.4 and §5.5, plus UA fixtures for source programs |
| `telemetry-histogram.test.js` | Quantile matches Prometheus semantics on known buckets; `deltaCumulative` reset returns null; merge is associative |
| `telemetry-sniffer.test.js` | Golden: OpenAI stream with usage; stream without usage (estimated); llama `timings`; Anthropic stream; non-stream JSON; oversized event; truncated stream; first-token time; the content-retention check |
| `telemetry-store.test.js` | Migrations from empty and from v0; PRAGMAs; worker round trip; batch insert; append-only trigger rejects UPDATE and DELETE; retention batches; degraded mode |
| `telemetry-recorder.test.js` | Fake req and res through P0-OBS-3's `onResponseDone`: finish; close mid-stream (`client_abort`, status sent); close before headers (499); timeout; reject paths; exactly-once finalisation; an adopted `init.requestId`; `rec.done` resolves once; buffer overflow counter |
| `telemetry-runtime-collector.test.js` | Fixture pairs of 01 route responses give golden `runtime_samples` rows. The fixtures are generated by running 01's `parsePrometheus` + `mapPrometheus` over recorded vLLM, SGLang and llama.cpp `/metrics` text. Also: idle gives zero rates; reset on a `runtime_key` change or counter decrease; unchanged `scrapedAt` skipped; missing † keys give NULL `d_errors`; gateway-derived latency for llama; a 404 falls back to `/api/stats` |
| `telemetry-gpu.test.js` | nvidia-smi fixtures including `N/A`, `[N/A]` procs, the throttle mask `0x400` as `bit_0x400`, and the query fallback chain; energy gap capping |
| `telemetry-rollups.test.js` | Late row marks dirty and recompute matches a from-scratch rollup; idempotent recompute; coverage null vs 0; +08:00 day boundary; percentile merge |
| `telemetry-query.test.js` | Source and step selection; whitelist rejects unknown dimensions (400); keyset pagination stable with equal timestamps; top-N plus other; CSV escaping |
| `service-entry/test/telemetry-viewer.test.js` | Each §11.8 redaction function on a full fixture (no IP, key id, customer, request id or billing field survives); forbidden viewer dimensions give 403; every 04 GET route is either registered or in the owner-only list (mirrors 05's coverage test) |
| `telemetry-alerts.test.js` | pending → firing after `for`; clear threshold; cooldown; ack and silence; builtin delete gives 409; webhook formats and HMAC with the secret read from a fake secret store (`webhooks` namespace); the secret never appears in the payload, a log or the settings response; SSRF guard; rate cap; `toastChannel` counts only a `system:supervisor` subscriber |
| `telemetry-importers.test.js` | Each source fixture; second run writes 0 rows; old rows go to rollups only; control routes skipped |
| `audit-chain.test.js` | Every P0-OBS-6 retention case re-run through `planAuditRetention` with identical results; `maxChains` golden fixtures, including the live layout (30 exports, 22 empty, baseline at 26); never removes the active chain or a depended-on full export; `needsRebaseline` equals the `AI_AUDIT_REBASELINE_DAYS` rule; lock contention gives `export_in_progress`; a stale or dead-pid lock is broken |
| `audit-index.test.js` | Index fixture export; CJK trigram search; LIKE fallback for queries under 3 chars; `is_latest` across versions; removal on prune |
| `audit-access-log.test.js` | Hash chain; verify detects a tampered copy; query text hashed |
| `manager-core/test/stats-sampler.test.js` | Rates independent of `/api/stats` call frequency (calling 0×, 1× and 50× gives the same output); a UI poll triggers no scrape; `speed.windowSeconds` and both `outputSource` values exactly as P0 ships them (gauge while running > 0, counter window otherwise); `speed.window.source === speed.outputSource`; `averageSource` on llama; `latency.window` from buckets |
| `service-entry/test/telemetry-gateway.test.js` | Entry handler plus a fake manager SSE server: one row per request with every §4.2 field; `x-request-id` minted and returned; client id preserved as `client_request_id`; (after TEL-2) the context header is present and covered by the v2 signature; control route gives no row; 401 gives a row; abort gives `client_abort`; the content-retention scan |
| `service-entry/test/telemetry-routes.test.js` | Each endpoint's shape against `schemas.js`; owner vs viewer access; settings GET/PUT through a fake `readSection`/`writeSection` (an etag conflict gives 409; no direct file write); export streaming; `/api/gateway-access` facade shape equal to the current shape |
| `service-entry/test/telemetry-ingest.test.js` | Requests signed with 05 `internal-auth.js` accepted; a wrong prefix, manager or signature rejected; non-loopback rejected; idempotent replay; spool replay order |
| `service-entry/test/billing-summary.test.js` | groupBy whitelist; BigInt sums; tz day keys; no writes (row counts and triggers intact); cursor pagination |
| `service-entry/test/audit-http.test.js` | A viewer gets 401 on every route; an owner without an audit session gets 401 on content routes; `x-audit-session` and a non-`pat_` bearer are both accepted; login throttle; session expiry; markdown stream error path; every action logged |

Existing tests (P0 tests are compatibility gates for TEL and must pass unmodified):
- From P0: `manager-core/test/core.test.js:492-509` (rates), `recent-rates.test.js` (P0-OBS-5), `access-log-terminal.test.js` (P0-OBS-3), `audit-retention.test.js` and `security-hardening.test.js:276-345` as P0-OBS-6 left them, `vllm-manager/test/stats-speed.test.js` and `llama-manager/test/stats-speed.test.js` (P0-RT-5), `service-entry/test/access-log-filter.test.js` (P0-ENT-2), `secret-redactor.test.js` (P0-OBS-1), and `tests/p0-ui.spec.cjs` (billing heading, speed label by source).
- `manager-core/test/core.test.js` (access-log search and export): unchanged. The export column test is extended for the appended fields only.
- `manager-core/test/platform-improvements.test.js` (metrics-history coalescing and engine filter): unchanged. It calls the store directly.
- `manager-core/test/gateway-usage.test.js`: one assertion changes in TEL-2. Line 230 (`/^[0-9a-f-]{36}$/i` for the manager-direct fallback) becomes `/^mgr_[a-z2-7]{20}$/`. Line 454 (the billing-internal UUID) and the client-id cases at :145-175 and :439-462 stay unchanged. One test is added for a verified-hop `requestId`.
- `service-usage-migration.test.js`: unchanged.
- `service-entry/test/gateway.test.js`: assertions on the forwarded `x-request-id` are updated to `^req_[a-z2-7]{20}$`, and a test is added for `x-client-request-id`. The `:172` hop assertions belong to PUB-10.
- `entry-extras.test.js`: gateway-access fixtures now seed the store instead of a log file.
- `security.test.js`: untouched by TEL (05 owns access and XFF semantics).
- The vllm and llama `core.test.js` imports of `buildModelStats` keep working. `buildModelStats` loses only the `updateSamples`-driven branches.
- Playwright: `tests/frontend-smoke.spec.cjs` is unchanged. The `/api/stats` stub shape is still valid, the new fields are optional, and the cache-hit assertions are untouched. `tests/billing-page.spec.cjs` keeps P0-17's assertions and its base path. It gains a `/api/billing/usage/summary` stub and asserts the aggregated table above the P0-17 raw table, in zh and en, with no overflow at 390 px.
- 07's console specs use `tests/fixtures/telemetry/*.json` (TEL-19). The node contract test `manager-core/test/telemetry-fixtures.test.js` validates those fixtures against `schemas.js`, so the stubs cannot drift from the API. The same test checks zh/en key parity of the `telemetry` i18n area; CON-2's loader test checks for duplicates across areas.
- Run `npm test` in `manager-core`, `service-entry`, `vllm-manager` and `llama-manager`, then `test-all.cmd`. New `.test.js` files are picked up by the existing `test/*.test.js` globs. No new root files are needed, and new Playwright specs from 07 go into `test:frontend-smoke`.

## 24. Rollout and deploy safety

- Every package is independently deployable and keeps today's behaviour when `TELEMETRY_ENABLED=0`.
- Prerequisites that land before any TEL package: wave 1 (06 OPS-3 config and secret store; 07 ENT-EV events, proxy, relay and mount table) and the P0 batches (OBS, ENT, RT, UI).
- Order (§27 lists the packages in this order): TEL-3, TEL-4, TEL-14, TEL-15 (no TEL prerequisites) → TEL-1, TEL-5, TEL-8, TEL-10 → TEL-7, TEL-9 → TEL-11 → TEL-12, TEL-13, TEL-16 → TEL-17, TEL-18, TEL-19. TEL-2 and TEL-6 wait for 05 PUB-10 (P0-OBS-3 → PUB-10 → TEL-2 → TEL-6), and TEL-20 waits for PUB-5. Until TEL-2 the entry forwards `x-request-id` on the v1 hop, which today's normaliser already accepts. Until TEL-6, direct-to-manager traffic is visible only in the manager access logs.
- Deploys restart processes (memory note). Runtime state is persisted through `collector_state`, so restarts lose at most one sample interval and the in-flight requests, which are finalised as `client_abort`/`internal` by the shutdown flush.
- No code path in this spec stops, starts or removes containers, starts Docker, or calls mutating manager endpoints.
- Importers are explicit owner actions, and the first run is a dry run.

## 25. Contract changes requested

### 25.1 Changes to `00` (made in the same commit as the named package)

- **C1 — §3 requestId (TEL-5).** The entry **always** mints `req_…` for recorded gateway requests, not only "when absent". An inbound client `x-request-id` is preserved as `client_request_id`, echoed as `x-client-request-id`, and never forwarded as the id. The manager normaliser is unchanged (it accepts `req_…`). The manager-direct fallback becomes `mgr_…` (TEL-2).
  - Why: the inbound value feeds idempotency keys (F7). 05 §19 asks for the same rule on PUBLIC.
- **C2 — §5 contracts.**
  - (a) Record the single metrics route `GET /api/instances/:id/metrics` → `{metrics, raw, facts, scrapedAt, unsupported[]}`, owned by 01 ENG-10 (`engines/metrics.js`, kind `histogram`). 04 consumes `raw`.
  - (b) Record that 05's v2 hop signature covers `sha256(x-service-entry-context)` and that the context JSON is `{v, src, cc}` (§5.2). There is no separate context signature.
  - (c) Record the internal loopback endpoints `/internal/telemetry/{requests,events,audit-access}`, signed with 05 `internal-auth.js`, whose prefix list includes `/internal/telemetry/`.
- **C3 — §4.5 event stream (TEL-13).** `notification.data` gains `channels` and `dedupeKey`. The `telemetry.live` payload is the §11.1 object. Toast delivery is subscribed by the machine principal `system:supervisor` (05 PUB-5), not by a `client=` query parameter.
- **C4 — §2 layout (TEL-19).** `manager-core/telemetry/` gains `ids.js`, `schema.js`, `store-worker.js`, `route-class.js`, `error-class.js`, `source-program.js`, `histogram.js`, `sniffer.js`, `notify.js`, `energy.js`, `importers.js`, `ingest-client.js`, `audit-chain.js`, `audit-index.js`, `audit-scheduler.js`, `audit-access-log.js`, `schemas.js` and `collectors/manager-stats-sampler.js`. `service-entry/lib/` gains `telemetry-runtime.js`, `telemetry-viewer.js` and `audit-http.js`. `service-entry/console/i18n/telemetry/` is 04's i18n area.
- **C5 — §6 compatibility note (TEL-12).** `/api/gateway-access` and `/api/status.entry.gatewayAccess` keep their shapes but are computed over a time window from the telemetry store. `maxLines` is ignored.
- **C6 — D9 config.** The §20 keys and env mappings are part of OPS-3's schema. 04 never edits the schema or `platform.json` directly.
- **C7 — one audit retention policy (TEL-15).** P0-OBS-6's rules (newest full plus newer kept; count and age prune of older exports; empty incrementals; `AI_AUDIT_REBASELINE_DAYS`, default 7) plus 04's `maxChains` (default 8) and the export lock. There is no other rebaseline rule and no "full every N days" setting.
- **C8 — §6 must-keep (TEL-1).** `/api/stats` `speed.windowSeconds` and `speed.outputSource ∈ {"counter_window", "sglang_gen_throughput_gauge"}` (08 C2) are must-keep. `speed.window`, `speed.averageSource`, `latency.scope` and `latency.window` are additive.

### 25.2 What 04 needs from sibling specs (not edited here)

- **R1 — 05 PUB-10.** `buildGatewayTrustHeadersV2` accepts `context` and signs `sha256(context header value)` (the hash of `""` when absent). `verifyEntryRequest(req) → {principal, context, requestId, clientAddress} | null`. The `internal-auth.js` prefix list includes `/internal/telemetry/`.
- **R2 — 01 ENG-10.** `metrics.js` and the route as in §7.1, with kind `histogram` and camelCase keys in both parts. Optional additive canonical keys `raw.processStartSeconds` and `requestsByFinishReasonTotal`. The route serves `sampler.lastScrape(instanceId)` when it is at most 5 s old. (01's package table currently puts the metrics map in ENG-14; the cross-check names ENG-10, and TEL-7 depends on whichever package ships `metrics.js` and the route.)
- **R3 — 07 ENT-EV.** `events.js` exports `subscribe(fn, {types}) → unsubscribe` and `subscriberCount({types?, principal?})` next to `publish(type, payload)`. Viewer filtering uses the §11.8 event registrations. The route-mount table gets lines for `telemetry-routes.js`, `audit-http.js` and `/internal/telemetry/*` (ADMIN only, before the `/api` guards).
- **R4 — 05 PUB-5.** The viewer-allowlist registry accepts event-type entries (`telemetry.live`, `alerts`) as well as GET routes. The `system:supervisor` principal is distinguishable in `checkManagementAccess` and in ENT-EV's subscriber metadata.
- **R5 — 06 OPS-3.** `readSection(name) → {value, etag}` and `writeSection(name, patch, {etag}) → {ok, etag, changed, restartRequired, errors}`. The secret store exposes `get/set/has/clear(namespace, key)` and reserves the namespace `webhooks` for 04. The supervisor's SSE client signs as `system:supervisor`.
- **R6 — 05 PUB-8 / PUB-11.** Pipeline step 1 calls `recorder.begin(req, res, {requestId, …})`, so there is one id per request. The usage tap adapts over `rec.done` (05 C5) instead of a separate `telemetry.record(...)` call.
- **R7 — 00 / 06 / 08.** The pre-existing plaintext audit admin password file (`audit-store.js` `auditPasswordFile`, flagged by 06 doctor `sec.plaintext-secrets`, which says 08 owns it) has no migration package in 08. 04 only verifies against it. Either 06 OPS-3 adds an `audit` secret-store namespace with `platform audit password show|reset`, or 00 records it as an accepted exception.
- **R8 — 07 CON-2 and CON-4.** The `telemetry` i18n area owns `obs.*` and `audit.*` (§19.1). `audit-session.js` should send `x-audit-session`; a non-`pat_` bearer stays accepted.

## 26. Open decisions for the owner

- **O1:** Raw request retention (30 d) and IP/UA retention (30 d). Should IPs be masked sooner, for example after 7 d, given the public service?
- **O2:** Electricity price, currency and time-of-use tariffs. No default price is assumed.
- **O3:** Webhook targets (Feishu, DingTalk, WeCom or generic). Alerts stay warn-only, with no automatic actions such as unloading on KV saturation. Confirm that this is wanted.
- **O4:** The audit schedule (hourly incremental; a full baseline every `AI_AUDIT_REBASELINE_DAYS` = 7 days, from P0) and retention (8 chains or 90 days). Is any longer retention needed for compliance?
- **O5:** Should OpenWebUI forward user and chat headers (`ENABLE_FORWARD_USER_INFO_HEADERS`) so that requests link to conversations? This requires a user-facing privacy notice.
- **O6:** Should the audit-of-audit log store search text, or only its hash (the default)?
- **O7:** Importing historical access logs is best-effort and flagged as imported. Import them, or start fresh?
- **O8:** TTS workbench polling is only excluded from analytics here. Should the TTS UI also move to SSE or backoff, which is outside this spec?
- **O9:** Should read-only viewers (loopback without a session, or LAN) see telemetry at all? The default is yes, through the §11.8 registrations: redacted, with no request detail, billing, export or audit.
- **O10:** When should the legacy manager "统计" (stats) and "外来访问" (external access) tabs be retired? The default is at console parity, with a banner until then.

## 27. Work packages

Packages are listed in execution order (ids are kept from the first version, so the order is not numeric). Each one fits a single engineer-agent session. "Tests pass" always includes `npm test` in every touched package plus `test-all.cmd`. Cross-spec ids: P0-* (08), ENG-10 (01), PUB-5, PUB-8, PUB-10 (05), OPS-3 (06, wave 1), ENT-EV (07, wave 1). No TEL package edits `gateway-trust.js`, `billing-client.js`, `internal-auth.js`, `runtime-routes.js`, `engines/metrics.js`, `service-entry/lib/events.js`, `mgmt-proxy.js`, `secret-redactor.js`, `secret-store.js`, `runtime-secret-store.js`, `platform-config.schema.json` or `platform/config.js`. Each package's acceptance includes "no diff in those files".

- **TEL-3 — Telemetry store, schema and worker** (L; depends on: none)
  - Files: `manager-core/telemetry/{store.js, store-worker.js, schema.js}` (new), `telemetry-store.test.js` (new), `scripts/backup-platform.ps1` (add the DB, CRLF without BOM).
  - Acceptance:
    - The §4.2 DDL is created, and the PRAGMAs are verified through `stats()`.
    - Worker round trip and batch insert of 10k rows complete in under 1 s on the test machine.
    - The append-only triggers reject UPDATE and DELETE.
    - Retention deletes in batches, and degraded mode works when the file path is not writable.
    - Synchronous SQLite never runs on the main thread except with `inProcess` (asserted).
- **TEL-4 — Ids, classification, histogram and sniffer libraries** (M; depends on: none)
  - Files: `manager-core/telemetry/{ids.js, route-class.js, error-class.js, source-program.js, histogram.js, sniffer.js}` (new); `access-log.js` (`inferAccessSourceProgram` delegates; output unchanged); tests `telemetry-ids`, `telemetry-classify`, `telemetry-histogram` and `telemetry-sniffer` (new) with fixtures.
  - Acceptance: `req_`/`mgr_` format tests pass, and the unchanged manager normaliser accepts a `req_` id. Every §5.4 and §5.5 golden row passes. Quantiles match the Prometheus reference values. The sniffer golden fixtures pass, including the content-retention check. The existing access-log tests are unchanged.
- **TEL-1 — Manager stats sampler on top of P0's rate window** (M; depends on: P0-OBS-5, P0-RT-5, TEL-4)
  - Files: `manager-core/telemetry/collectors/manager-stats-sampler.js` (new), `manager-core/index.js` (export), `vllm-manager/server.js`, `llama-manager/server.js`, `manager-core/test/stats-sampler.test.js` (new), vllm and llama `test/core.test.js` (only for removed `updateSamples` branches).
  - Acceptance:
    - The sampler test proves identical rates whether `/api/stats` is called 0, 1 or 50 times, and a UI poll causes zero engine scrapes (scrape counter).
    - `speed.windowSeconds` and `speed.outputSource` are deep-equal to P0's output on the P0-RT-5 fixtures, including the SGLang gauge while running > 0. `speed.window`, `speed.averageSource` and `latency.window` are present and additive.
    - `core.test.js:492-509`, `recent-rates.test.js` and both `stats-speed.test.js` files pass unmodified. `stats-utils.js` is not edited.
    - A grep test finds no `updateSamples: true` in either server. `lastScrape()` returns the last scrape text and time.
    - `tests/frontend-smoke.spec.cjs` and `tests/p0-ui.spec.cjs` pass unchanged. The MCP `get_performance` tests pass.
    - The stats ledger is written at most once per 60 s, verified with a fake clock.
- **TEL-5 — GatewayRecorder in service-entry** (L; depends on: TEL-3, TEL-4, P0-ENT-2, OPS-3, ENT-EV)
  - Files: `manager-core/telemetry/recorder.js` (new), `service-entry/lib/telemetry-runtime.js` (new; config through `readSection("telemetry")`), `service-entry/server.js` (LLM, TTS and aux gateway wiring; `x-request-id` minting and `x-client-request-id`; the JSONL log fed from rows; control exclusion; `start`/`stop`), `manager-core/auth-failure-guard.js` (`onBan`), `service-entry/test/telemetry-gateway.test.js` (new), `service-entry/test/gateway.test.js` (`x-request-id` format assertions).
  - Acceptance:
    - The integration test shows one row per request with all §4.2 fields populated, real tokens, TTFT and `decode_tps` for streams, `client_abort` on mid-stream close, 499 before headers, and 401 and 429 rows.
    - Finalisation goes through P0-OBS-3's `onResponseDone` (no second `finish`/`close` listener pair; asserted with listener counts). `access-log-filter.test.js` (P0-ENT-2) passes unmodified.
    - `init.requestId` is adopted when given. `rec.done` resolves exactly once.
    - The TTS jobs poll produces no row and increments `control_counts_1m`.
    - With the store unavailable, responses are byte-identical (test compares bodies). `TELEMETRY_ENABLED=0` restores the current behaviour.
- **TEL-8 — GpuCollector and energy** (M; depends on: TEL-3)
  - Files: `manager-core/telemetry/collectors/gpu.js`, `manager-core/telemetry/energy.js` (new), `telemetry-gpu.test.js` (new) with nvidia-smi fixtures.
  - Acceptance: N/A and `[N/A]` handled; throttle decode including unknown bits; fallback chain; procs disabled on WDDM fixtures; energy integration caps gaps; tariff windows that cross midnight priced correctly.
- **TEL-10 — Rollups and retention** (M; depends on: TEL-3, TEL-4)
  - Files: `manager-core/telemetry/rollups.js` (new), the worker scheduling in `store-worker.js`, `telemetry-rollups.test.js` (new).
  - Acceptance: recomputing any bucket equals a from-scratch rollup; a late row marks dirty and propagates to 1h and 1d; coverage gives null vs 0; the +08:00 day boundary is correct; TTLs from §4.3 are enforced; the size guard triggers.
- **TEL-7 — RuntimeCollector over the 01 metrics route** (M; depends on: TEL-3, TEL-4, ENG-10)
  - Files: `manager-core/telemetry/collectors/runtime.js` (new), `service-entry/lib/telemetry-runtime.js`, `manager-core/test/telemetry-runtime-collector.test.js` (new), fixtures generated with 01's `parsePrometheus`/`mapPrometheus` from recorded vLLM, SGLang and llama.cpp `/metrics` text.
  - Acceptance:
    - Golden `runtime_samples` rows for each engine, read from the route's `raw` part.
    - `runtime-routes.js` and `engines/metrics.js` show no diff, and no Prometheus text parser exists under `manager-core/telemetry/` (grep).
    - A reset (launch change, counter decrease) produces no negative deltas. Missing optional keys give NULL columns, not errors.
    - llama latency is derived from gateway rows.
    - A manager without the route degrades to `/api/stats` deltas with `latency_source='none'`.
- **TEL-9 — EventCollector** (L; depends on: TEL-3, ENT-EV)
  - Files: `manager-core/telemetry/collectors/events.js` (new), `service-entry/lib/telemetry-runtime.js` (subscribe through `events.subscribe`), `service-entry/server.js` (config-change hook calls only), `telemetry-events.test.js` (new) with job-diff, docker-event, process-exit and MCP-tail fixtures.
  - Acceptance:
    - `service-entry/lib/events.js` shows no diff. Manager `jobs` and `instances` arrive through ENT-EV's relay (fake relay in the test).
    - Launch started, phase, ready and failed with durations and `dedupe_key` idempotence. Failure messages are redacted by `secret-redactor.js` (fixture key absent).
    - `container.oom` is critical, and `hard_kill_suspected` is detected.
    - Docker unavailable means backoff, with no attempt to start Docker (asserted: no `Docker Desktop` or `wsl` start call).
    - Offsets survive restart.
- **TEL-14 — Billing usage summary on top of P0-17** (M; depends on: P0-UI-1, P0-ENT-1)
  - Files: `service-entry/lib/billing-store.js` (`summarizeUsage`, `getUsageByExternalRequestId`, `lookupCustomerForCredential`, indexes, cursor), `service-entry/lib/billing-http.js` (route), `service-entry/billing.html` (aggregated table and SVG chart above P0-17's raw table), `service-entry/test/billing-summary.test.js` (new), `tests/billing-page.spec.cjs` (new assertions only).
  - Acceptance:
    - GROUP BY results match hand-computed fixtures with BigInt-safe strings.
    - Immutable triggers are still present, and no write statements are executed (spy on `prepare`).
    - P0-17's heading, columns and `p0-ui.spec.cjs` billing assertions pass unmodified. The aggregated table renders in zh and en with no overflow at 390 px.
    - The Playwright billing spec passes with its existing base path (`/billing`, or `/billing/classic` once CON-2 retargets it).
- **TEL-15 — Audit export lock and chain cap on top of P0-OBS-6** (M; depends on: P0-OBS-6)
  - Files: `manager-core/telemetry/audit-chain.js` (new; P0-OBS-6's rules moved into a pure function, plus `maxChains`), `manager-core/audit-store.js` (lock; `pruneAuditExports` calls the planner), `manager-core/test/audit-chain.test.js` (new).
  - Acceptance:
    - `audit-retention.test.js` and `security-hardening.test.js:276-345` pass unmodified, and every P0-OBS-6 case gives the same result through `planAuditRetention`.
    - The live-layout fixture with `maxChains` keeps the baseline and its non-empty incrementals. `needsRebaseline` follows `AI_AUDIT_REBASELINE_DAYS` only.
    - Concurrent exports give one `export_in_progress`. A stale or dead-pid lock is broken and logged.
    - `openwebui-audit-exporter.js` and `audit-routes.js` show no diff.
- **TEL-11 — Query layer, `/api/telemetry/*` routes and viewer redaction** (L; depends on: TEL-5, TEL-7, TEL-8, TEL-9, TEL-10, TEL-14, OPS-3, ENT-EV)
  - Files: `manager-core/telemetry/query.js` (new), `service-entry/lib/telemetry-routes.js` (new), `service-entry/lib/telemetry-viewer.js` (new; redaction functions and the §11.8 tables), `service-entry/server.js` (one mount line), `service-entry/test/{telemetry-routes, telemetry-viewer}.test.js`, `manager-core/test/telemetry-query.test.js` (new).
  - Acceptance:
    - The endpoints in §11.1–11.7 match the documented shapes, validated by `schemas.js`.
    - Unknown parameters return 400. Keyset pagination is stable. Every series has ≤ 600 points.
    - Settings GET/PUT go through `readSection`/`writeSection` (fake in tests, an etag conflict gives 409). Webhook secrets go only to the secret store (fake) and never appear in the response, `platform.json` or logs.
    - Every redaction function passes its fixture. Until TEL-20, a LAN viewer under today's `checkManagementAccess` gets the same redacted output.
    - The billing join in request detail works. Export streams 200k rows without holding them in memory (heap delta assert).
- **TEL-12 — Entry compatibility facades** (S; depends on: TEL-11)
  - Files: `service-entry/server.js` (`collectEntryGatewayAccessStats` from the store), `service-entry/test/entry-extras.test.js`.
  - Acceptance: the `/api/gateway-access` and `/api/status` `.entry.gatewayAccess` shapes are unchanged (deep key comparison with the current fixture). They are computed over a 1 h window, and TTS polling no longer appears in `paths` or `recent`.
- **TEL-13 — Alert engine, notifier and alert API** (L; depends on: TEL-11, OPS-3, ENT-EV)
  - Files: `manager-core/telemetry/{alerts.js, notify.js}` (new), `service-entry/lib/telemetry-routes.js`, `telemetry-alerts.test.js` (new).
  - Acceptance:
    - The default rules are seeded once, and the GPU guard thresholds are migrated.
    - The state machine tests pass.
    - Webhook generic HMAC and the Feishu, DingTalk and WeCom formats match golden bodies, with secrets read from the `webhooks` namespace of a fake secret store. The SSRF guard is enforced.
    - Publishing uses only `events.publish("alerts" | "notification", …)`. `notification` carries `channels` and `dedupeKey`. `toastChannel` reports `available` only for an authenticated `system:supervisor` subscriber.
- **TEL-16 — Entry audit API, scheduler and audit-of-audit log** (L; depends on: TEL-3, TEL-15, OPS-3, ENT-EV)
  - Files: `manager-core/telemetry/{audit-scheduler.js, audit-access-log.js}` (new), `service-entry/lib/audit-http.js` (new), `service-entry/server.js` (one mount line), tests `audit-access-log.test.js` and `audit-http.test.js` (new). The managers' `onAccess` wiring is in TEL-6.
  - Acceptance:
    - Under a fake clock, the scheduler runs incrementals per `incrementalEveryMinutes`, and a full export at the first `fullAtLocal` after `needsRebaseline`.
    - A missing OpenWebUI container produces a skip event only.
    - Every endpoint action appends a hash-chained row, and `verify` detects tampering.
    - Viewer gets 401 everywhere; content routes need the audit session (`x-audit-session` or a non-`pat_` bearer).
    - Login throttling works. Settings PUT goes through `writeSection("audit", …)`.
- **TEL-17 — Conversation index and browser API** (M; depends on: TEL-16)
  - Files: `manager-core/telemetry/audit-index.js` (new), `service-entry/lib/audit-http.js` (chats endpoints), `audit-index.test.js` (new) with a fixture export JSON containing CJK.
  - Acceptance:
    - Back-fill indexes the fixture exports.
    - Trigram search finds CJK and English.
    - `versions` lists every export of a chat.
    - Pruning removes index rows.
    - Content is returned only with a valid audit session, and each view is logged.
- **TEL-18 — Importers** (L; depends on: TEL-9, TEL-10)
  - Files: `manager-core/telemetry/importers.js` (new), `service-entry/lib/telemetry-routes.js` (import endpoints), `telemetry-importers.test.js` (new) with sanitised fixtures for every §18 source.
  - Acceptance:
    - A dry run writes nothing; a second run writes 0 rows.
    - Rows older than the raw TTL land only in rollups.
    - Throughput and latency from metrics-history are not imported.
    - The report lists skipped reasons, and completion publishes one `notification` (no import event type).
    - Source files are unchanged (hash before and after).
- **TEL-19 — Live stream, console fixtures and the telemetry i18n area** (M; depends on: TEL-11, TEL-13, ENT-EV)
  - Files: `service-entry/lib/telemetry-runtime.js` (`telemetry.live` publisher through `events.publish`), `manager-core/telemetry/schemas.js` (new), `tests/fixtures/telemetry/*.json` (new: live, summary, timeseries, breakdown, requests, request-detail, alerts, audit-status, audit-chats), `service-entry/console/i18n/telemetry/{zh-CN,en-US}.json` (new; the §19.1 keys), `manager-core/test/telemetry-fixtures.test.js` (new), `docs/overhaul/00-decisions-and-contracts.md` (C1–C8 if not yet applied).
  - Acceptance:
    - `telemetry.live` is published every 5 s only while `subscriberCount({types:["telemetry.live"]}) > 0` (fake clock).
    - The fixtures validate against `schemas.js` and match real query output for a seeded DB.
    - The `telemetry` area has zh/en key parity, uses only the `obs.*` and `audit.*` prefixes, and keeps the keys 07 references (`obs.reservation`, `obs.noPrice`, `obs.lanReadOnly`). No key is added to any other catalog.
    - The fixture and i18n files pass the release privacy scan.
- **TEL-2 — Manager request identity on hop v2** (M; depends on: P0-OBS-3, PUB-10, TEL-4, TEL-5)
  - Files: `manager-core/gateway-utils.js` (fallback `mgr_`; consume `verifyEntryRequest` for the request id, `keyId`, `sourceProgram` and `viaEntry`; add `clientRequestId`, `errorClass` and `firstByteMs`), `manager-core/access-log.js` (export fields appended), `service-entry/lib/gateway-pipeline.js` (pass `context` to `buildGatewayTrustHeadersV2`), `manager-core/test/telemetry-hop.test.js` (new), `manager-core/test/gateway-usage.test.js` (line 230 only), `manager-core/test/core.test.js` (export columns).
  - Acceptance:
    - `gateway-trust.js` and `billing-client.js` show no diff. The context is covered by the v2 signature: a tampered context fails PUB-10's verification.
    - A verified hop yields `requestId = hop.requestId`, `keyId = principal.k` and `sourceProgram = context.src` in the access row. With no hop, the fallback id matches `^mgr_[a-z2-7]{20}$`.
    - `gateway-usage.test.js` passes with only line 230 changed. `access-log-terminal.test.js` and `platform-improvements.test.js:305` pass unmodified.
    - The normaliser regex is unchanged (asserted against the P0 source).
- **TEL-6 — Manager direct-ingress reporting, audit-access forwarding and the internal ingest API** (M; depends on: TEL-2, TEL-3, TEL-5, TEL-16, PUB-10, ENT-EV)
  - Files: `manager-core/telemetry/ingest-client.js` (new), `manager-core/gateway-utils.js` (report direct rows), `manager-core/audit-routes.js` (`onAccess` dependency only), `vllm-manager/server.js` and `llama-manager/server.js` (construct the client with `createInternalClient`; wire `onAccess` to it), `service-entry/lib/telemetry-runtime.js` (`handleInternal`), `service-entry/server.js` (one mount line in ENT-EV's table, ADMIN only, before the `/api` guards), `service-entry/test/telemetry-ingest.test.js` (new).
  - Acceptance:
    - Requests are signed and verified only through 05 `internal-auth.js` with the `/internal/telemetry/` prefix. `billing-client.js` has no diff. A wrong signature, prefix or manager id gives 401, and a non-loopback socket is rejected.
    - Replay is idempotent. Spool and replay preserve order. The spool cap drops the oldest lines.
    - An entry-routed request (valid v2 hop) is never also reported by the manager (no double row).
    - A manager audit action (legacy `/api/audit/*`) appends one hash-chained `audit_access_log` row on the entry, in arrival order with its original `at`, also after a spool replay.
- **TEL-20 — Register telemetry routes with the viewer allowlist** (S; depends on: PUB-5, TEL-11, TEL-12, TEL-13, TEL-16)
  - Files: `service-entry/lib/telemetry-viewer.js` (`registerTelemetryViewerRoutes(allowlist)` called at mount), `service-entry/test/telemetry-viewer.test.js` (registry cases).
  - Acceptance:
    - 05's coverage test passes: every 04 GET route is registered with its §11.8 function or is owner-only.
    - A loopback viewer and a LAN viewer both get the redacted `live`, `summary` and `timeseries` (unblocking 07's `obs.lanReadOnly` state), and 401 `admin_session_required` on `requests`, `export`, `settings` and every `/api/audit/*` route.
    - The event types `telemetry.live` and `alerts` reach viewer streams redacted. `notification` never does.
