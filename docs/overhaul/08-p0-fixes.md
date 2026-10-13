# 08 — P0 correctness and security fixes

Status: spec for phase P0 (branch suffix `-p0-*`). This spec conforms to `00-decisions-and-contracts.md`. Where it needs a contract change, the change is listed in section 9 and is not applied silently.

P0 is a set of small fixes that each ship on their own. None of them waits for the engine, model, hub, telemetry, public, ops or console redesigns (01–07). Every fix states which later spec supersedes it, so no work is done twice. When a later spec replaces the code, it must keep the behaviour P0 introduces (for example, secrets out of argv, deny-by-default CORS and the wake replace guard) unless that spec says otherwise.

Paths are worktree-relative. Live data is referenced as `<AI_ROOT>/…` and never by absolute path. Line numbers refer to the integration branch at the time of writing (2026-10-14). Implementers re-anchor on the symbol names given next to each line number.

---

## 1. Ground rules for P0

1. **No live-root edits and no service restarts.** Mutating endpoints of running services are never called. Fixes that need live data cleaned up (rotating keys, scrubbing ledgers) ship as owner-run tools or owner-only actions (section 8).
2. **Additive API changes only.** Every must-keep API in 00 §6 keeps its fields. New fields are optional. Existing admin endpoints keep their current error shape (`{ok:false, error:"text"}` or `{error, code, details}` from `runtime-routes.js` `sendJsonError`) and gain a stable `code`. The 00 §4.2 envelope applies to endpoints that P1+ creates or rewrites.
3. **No new npm dependencies.** New modules in `manager-core` are added to the `MODULES` barrel in `manager-core/index.js` (it warns on export-name collisions). The exception is `manager-core/model-hub/errors.js`: it is created at its final 00 §2 path and is required directly.
4. **Secrets.** No code path added by P0 may print, log or persist a plaintext API key or token.
   - **One redactor.** `manager-core/secret-redactor.js` (section 3) is the platform's only redactor, and its marker `<redacted>` is the only marker. P0-RT-1 converts the two legacy `***` helpers to it. Later specs import it; their own redact helpers are one-line re-exports or do not exist.
   - **At rest.** P0 adds no new secret file. Wake keys reuse the existing runtime secret store through its `set/get/remove/values` API (P0-1). HF download tokens are memory-only (P0-9). The single at-rest policy is 06 OPS-3: `manager-core/secret-store.js` under `<AI_ROOT>/.runtime/secrets/`, DPAPI-wrapped, with `runtime-secret-store.js` reduced to a facade over it. P0 code calls only the facade, so OPS-3 needs no P0 code change.
5. **No implicit container stops.** P0 adds one path that can replace a running container: waking a sleeping instance into the primary slot. It is guarded by an explicit confirm (P0-1).
6. **Files.** All new files sit in allowlisted release directories (`manager-core`, `scripts`, `tests`, `service-entry`, `shared-public`, `tts-platform`), so `build-github-release.ps1` does not change. `.cmd` and `.ps1` files are CRLF without a BOM. Browser files loaded through `node:vm` stay classic scripts.
7. **Copy.** All user-facing strings are bilingual. They go through `shared-public/js/i18n-common.js` (zh source string → en), and `scripts/check-i18n.js` must stay green. Server-generated messages that P0 adds (admission, wake, download errors) are single `"<zh> / <en>"` strings, because the legacy UIs render them as they are.
8. **Fixtures and goldens.** P0 creates **no golden files**; the engine goldens are captured once, by 01 ENG-1, from the post-P0 merge head (C3). No P0 test checks in a file that `.gitignore` or the release robocopy excludes. That rules out directories named `logs/`, `models/`, `cache/`, `output/`, `artifacts/` or `projects/`, and the names `*.log`, `*.jsonl`, `*.sqlite*`, `*.db`, `jobs-ledger.json` and `stats-ledger.json`.
   - Ledgers, log trees and storage roots are built under `fs.mkdtemp(os.tmpdir())` at test time.
   - Text corpora are inline arrays in the test file.
   - If a checked-in file is unavoidable, it lives under `<pkg>/test/fixtures/p0/` with a `.fixture` suffix (`jobs-ledger.fixture.json`, `hf-403.log.fixture`). The test copies it to a temp directory under its real name.

### 1.1 Later packages that build on P0

The cross-check of 2026-10-14 found later packages that re-implemented P0 fixes. In each case the P0 package below is the only implementation, and the later package is a delta on the code P0 lands.

| Later package | Relation to P0 |
|---|---|
| 01 ENG-1 | Captures goldens once, from the post-P0 merge head, into `manager-core/test/fixtures/engines/goldens/`. P0 creates none. |
| 01 ENG-8 | Ports P0-RT-2: `findWakePlan` matching order, 409 `wake_would_replace_running` with the `confirmReplace` bypass, 409 `wake_api_key_missing`, and wake-secret retention through the secret-store facade. P0-RT-2's tests run unchanged in the ENG-8 suite. |
| 01 ENG-12 | Moves the P0-RT-3 logic behind the descriptor `memoryModel` (`manager-core/engines/memory-models.js#staticFractionOfFree`) with no field renamed. Runs after P0-RT-3 and before 02 MOD-9's admission wiring. |
| 01 ENG-15 | Imports `secret-redactor.js` (it creates no `engines/redact.js`). It extends `scripts/scrub-job-ledgers.js`, which stays dry-run by default with `--apply` to write and no `--write`. The argv change is already done by P0-RT-1. |
| 02 MOD-9 | `fit.js` computes only artifact-side inputs and calls `engines.memoryModels.estimate(engineId, inputs)`. It is not an estimator of its own. |
| 02 MOD-11 | Moves the P0-14/P0-15 data into the knowledge layer and keeps the 08 strings and the `gguf-model-ui.js` change. |
| 03 HUB-P0a–e | Deleted. They are satisfied by P0-DL-1/2/3, P0-RT-6 and P0-UI-3. HUB-1 and HUB-5 depend on P0-DL-1. |
| 04 TEL-1 | Keeps `speed.windowSeconds` and both `outputSource` values (P0-7), including the gauge fallback. `speed.window{}` and `averageSource` are added alongside them. |
| 04 TEL-2 / TEL-14 / TEL-15 | Deltas on P0-OBS-3, P0-UI-1 (P0-17) and P0-OBS-6 respectively. |
| 06 OPS-0 | Deleted. Its items are in P0-OPS-1 and P0-OPS-3; the unique ones are `stop_workers.ps1` and TTS `-GatewayOnly` with `TTS_START_WORKERS`. |
| 06 OPS-2 | Folds `scripts/check-script-encoding.js` into its hygiene test. |
| 06 OPS-3 | `secret-store.js` becomes the backing store of the `runtime-secret-store.js` facade that P0 uses, and migrates the existing file once. |

---

## 2. Fix index

The severity scale is: S1 is a security issue or data exposure, S2 is broken core functionality, and S3 is misleading or degraded behaviour.

| Id | Title | Sev | Batch | Superseded by |
|---|---|---|---|---|
| P0-1 | Idle-unload wake never works; woken instance would lose its API key and could replace a running model | S2 | RT (+UI) | 01 ENG-8 (ports it; LaunchStore) |
| P0-2 | SGLang VRAM admission uses whole-device semantics; Flash-Next 262K can never start | S2 | RT | 01 ENG-12 (moves it behind `memoryModel`), then 02 MOD-9 |
| P0-3 | `/api/logs` and runtime facts read the primary container only | S3 | RT (+OBS route, UI link) | 01 ENG-13 (per-instance logs), 04-telemetry |
| P0-4 | Runtime API key and HF token passed in `docker run` argv | S1 | RT | 01-engines adapters (must keep env delivery) |
| P0-5 | Plaintext keys in job ledgers and log surfaces; no redaction choke point | S1 | OBS (+RT wiring) | none (redactor is permanent) |
| P0-6 | Recent-rate sampling is driven by UI polls; history records zero with no UI open | S3 | OBS | 04-telemetry (facade keeps the window) |
| P0-7 | SGLang "current speed" is a sticky gauge; llama "current speed" is a lifetime average | S3 | RT (+UI labels) | 01 metrics-map, 04 TEL-1 (keeps the fields) |
| P0-8 | Every download failure is retried; failures have no reason code or hint | S2 | DL (+UI card) | 03-hub (extends `errors.js`; codes kept) |
| P0-9 | Resume and retry drop mirror, token and transfer settings; the mirror receives HF tokens | S1 | DL (+RT wiring) | 03-hub transfer.js/providers |
| P0-10 | An include filter that matches nothing starts a "successful" empty download; estimate outage blocks every download | S2 | RT | 03-hub queue |
| P0-11 | Disk usage, cleanup, upstream check and resume disk check only see the default root | S2 | DL + RT | 03-hub library.js (`roots[]`) |
| P0-12 | llama download presets point to safetensors repos | S3 | UI | 02-models / 07-console catalog |
| P0-13 | Mirror probe silently persists the mirror setting; vLLM UI drops queue priority | S3 | UI | 07-console downloads center |
| P0-14 | Pre-download check overstates confidence and promises automatic trust-remote-code | S3 | DL | 02 MOD-11 (keeps the copy) |
| P0-15 | Unknown GGUF architecture is shown as "compatible" | S2 | RT + UI | 02 MOD-11 (keeps the copy) |
| P0-16 | Audit export retention breaks incremental chains; cursor race; stream crash | S2 | OBS | 04 TEL-15 (delta) |
| P0-17 | Billing overview labels raw recent rows as a monthly per-customer aggregate | S3 | UI | 04 TEL-14 (delta), 07 |
| P0-18 | Entry access log is 99.8 % TTS job polling | S3 | ENT | 04-telemetry gateway recorder |
| P0-19 | Access logs miss aborted requests, carry no requestId, log the proxy address | S3 | OBS + ENT | 04 TEL-2 (delta), TEL-5 |
| P0-20 | `X-Forwarded-For` honoured from any socket; the forwarded-header lists disagree | S1 | ENT | 05-public (listener split) |
| P0-21 | Manager CORS defaults to open, reflects any origin with credentials and PNA | S1 | OBS (+UI copy) | 05-public (kept) |
| P0-22 | Console dark mode: hover turns header buttons light-on-light | S3 | UI | 07-console |
| P0-23 | Health checks compute remediation actions that the UI never renders | S3 | RT + UI | 06-ops doctor, 07-console |
| P0-24 | Start/stop scripts: BOM, hard-coded ports, deleted logs, unbounded waits, wrong readiness, TTS workers always started | S2 | OPS | 06-ops (OPS-0 folded here; scripts become shims) |
| P0-25 | README contradicts code (Node range, loopback claim, MCP version, quick start) | S3 | OPS | 06-ops, P8 docs |
| P0-26 | Gateway error responses leak paths, ports and env names | S1 | ENT | 05-public public-api error mapping |

### 2.1 Dropped or deferred candidates

| Candidate | Decision | Why |
|---|---|---|
| vLLM GGUF `--load-format gguf` handling | Deferred to 01 | Not reproduced; needs a running engine to verify. |
| `qwen3_coder` tool-parser validity on the pinned images | Deferred to 01 | Not verified against the pinned image's parser list. |
| `/gateway/status` shares the gateway rate bucket | Deferred to 05 | Fixed by the listener split. |
| Global key acting as a TTS superuser | Deferred to 05 | Current behaviour is by design; scopes arrive with the key store. |
| Managers bind `0.0.0.0` | Deferred to 05/06 | Guarded today by `*_ALLOW_REMOTE=0` plus `isLocalRequest`. Changing the bind affects LAN users. P0-25 only fixes the README claim. |
| Console manager link hrefs | Deferred to 07 | Cosmetic; the console is replaced. |
| Persistence of queued download specs, ModelScope metadata through the mirror | Deferred to 03 | Needs the hub queue. |
| Billing per-customer monthly summary endpoint | Deferred to 04 | Needs new SQL; P0-17 only relabels. |
| Per-instance `/api/stats` | Deferred to 04 | P0-3 fixes logs and facts only. |
| Manager lifecycle EADDRINUSE handling | Deferred to 06 | Supervisor territory. |

---

## 3. Shared building block: `manager-core/secret-redactor.js` (OBS)

Used by P0-4, P0-5, P0-9 and P0-26. It is a pure module with no I/O. It is the platform's **only** redactor (rule 1.4). 01, 03, 04 and 06 import it, and `<redacted>` is the only marker.

```js
// manager-core/secret-redactor.js
const REDACTED = "<redacted>";
const SECRET_PATTERNS = [ /* see table */ ];
/** Redact known secret values and secret-shaped substrings. Non-strings are returned unchanged.
 *  patterns:false = exact secrets only (API responses, where patterns could hit model ids). */
function redactSecrets(text, { secrets = [], placeholder = REDACTED, patterns = true, minSecretLength = 8 } = {}) → string
/** Deep-redacts strings inside plain objects and arrays (for job.meta, error.details). Never mutates. */
function redactValue(value, options) → value
/** Bound redactor; getSecrets() is called on every redact so rotated keys are covered. */
function createSecretRedactor({ getSecrets = () => [], placeholder = REDACTED, patterns = true } = {}) → { redact(text), redactValue(value) }
module.exports = { REDACTED, SECRET_PATTERNS, redactSecrets, redactValue, createSecretRedactor };
```

Exact secrets are redacted first, longest first. The minimum length defaults to 8, so short values like `1` never cause collateral damage. The legacy API helper keeps its own floor of 6 through `minSecretLength`. Then, unless `patterns:false`, the patterns run in this order:

| # | Pattern (JS, `gi`) | Replacement keeps |
|---|---|---|
| 1 | `(--(?:api-key\|hf-token\|token\|admin-api-key)(?:=\|\s+))("[^"]*"\|'[^']*'\|\S+)` | the flag |
| 2 | `(["']?(?:api[_-]?key\|hf[_-]?token\|access[_-]?token\|authorization\|x-api-key)["']?\s*[:=]\s*["']?)([^"'\s,}]+)` | the key name |
| 3 | `(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}` | `Bearer ` |
| 4 | `(\b[A-Z][A-Z0-9_]*(?:_API_KEY\|_TOKEN\|_SECRET)=)(\S+)` | the variable name |
| 5 | `\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}` | nothing |
| 6 | `\bhf_[A-Za-z0-9]{20,}` | nothing |

Pattern 4 does not match the name-only `-e VLLM_API_KEY` form, because there is no `=`. That form carries no secret and stays readable.

**Tests.** The new file `manager-core/test/secret-redactor.test.js` covers:
- one case per pattern;
- exact-secret redaction inside a docker `Command failed:` text;
- that `hf_` and `sk-` appearing inside ordinary words is not redacted (`sk-learn`, `hf_hub_download` stay);
- idempotence (`redact(redact(x)) === redact(x)`);
- that `redactValue` does not mutate its input;
- that `patterns:false` leaves `sk-…` model ids alone but still removes exact secrets.

**Legacy helpers converge.** Two existing helpers use the marker `***`: `redactDockerArgs` (`vllm-manager/lib/runtime-command.js:28-34`, `llama-manager/lib/runtime-command.js:24-30`) and `redactManagerSecretsValue` (`manager-core/manager-routes.js:313-331`). Both now replace strings through `redactSecrets(text, { secrets, patterns:false, minSecretLength: 6 })`, so they emit `<redacted>`. The manager-routes helper keeps its key-name field removal unchanged. P0-RT-1 does this and flips the three `***` assertions (section 6).

---

## 4. Fix details

Each fix uses the same layout: evidence, change, risk, tests, and superseded by.

### P0-1 Idle-unload wake (RT; UI confirm)

**Evidence**

- `vllm-manager/server.js:1426` `startRuntime: (config) => startRuntimeRequest(config)`. However, `vllm-manager/lib/launch-request.js:41` takes `({ body = {} } = {})`, so the config lands in an ignored parameter and the start fails with "model is required". The same bug is at `llama-manager/server.js:1444` and `llama-manager/lib/launch-request.js:64`.
- `vllm-manager/server.js:1420-1424` `findLaunchConfig` compares `instance.model`, which is the served id `models[0].id`, with `recentLaunches[].model`, which is the model path. These match only when no served name is set. Otherwise `manager-core/idle-unload.js:194-201` skips sleep with `launch_config_unavailable`. The same bug is at `llama-manager/server.js:1438-1442`.
- `recordRecentLaunch` (`vllm-manager/server.js:1525-1540`) stores `normalizeLaunchConfig(…)` (`:1661-1715`). That function drops `instanceMode`, `instanceId` and `apiKey`. A wake would therefore start in replace mode on the primary slot and without the key.
- Stopping removes the container's key from the runtime secret store (`vllm-manager/server.js:3758-3768`, `:4052-4053`). The key is unrecoverable once the instance sleeps.
- `manager-core/idle-unload.js:275` calls `startRuntime({...record.config, ...overrides})` with no placement and no guard. `findSleepingForModel` (`:318`) has no callers, so waking only ever happens from the explicit UI or API action.
- The route `manager-core/manager-routes.js:269` drops `req.body` and returns only `{ok:false, error}` on failure.

**Change**

1. Both servers: `startRuntime: (body) => startRuntimeRequest({ body })`.
2. `recordRecentLaunch` (both servers) adds entry-level fields `containerName`, `instanceMode` (`replace|parallel`) and `instanceId` next to `model` and `config`. `normalizeLaunchConfig` is unchanged, which keeps the `recent-launches.json` config shape. Old entries without these fields stay valid.
3. New optional controller hook `findWakePlan(instance) → { config, placement: { instanceMode, instanceId, containerName } } | null`. The servers implement it by matching, in order:
   1. `entry.containerName === instance.containerName`;
   2. `entry.model` (path) equal to `instance.name` (the `models[0].root`, the path), case-insensitive;
   3. `entry.config.name` (served name) equal to `instance.model`.

   If `findWakePlan` is absent, the controller falls back to the legacy `findLaunchConfig`.
4. Secrets across sleep. These are new optional hooks. The servers wire them to `runtimeApiKeyStore` (`createRuntimeSecretStore`), using only its existing `set/get/remove/values` API, which is the facade that 06 OPS-3 later backs with the DPAPI `secret-store.js`.
   - `prepareWakeSecrets(instance) → { secretRef } | null`. It runs **before** `stopInstance`. It reads the container's `ai.manager.api-key-ref` label (the legacy `ai.manager.api-key` label is also read, as in `getVllmApiKey` `:3774-3787`). It then calls `runtimeApiKeyStore.set(key)`; the returned ref is the record's `secretRef`. If the label exists but the value cannot be read, the hook throws `code:"api_key_unavailable"`. Sleep is then skipped with that reason, the same way `launch_config_unavailable` is handled, and the container keeps running.
   - `resolveWakeSecrets(record) → { apiKey }`. It returns `runtimeApiKeyStore.get(record.secretRef)`. If `record.hasApiKey` is true and the key is missing, wake fails with 409 `wake_api_key_missing`.
   - `releaseWakeSecrets(record)`. It calls `runtimeApiKeyStore.remove(record.secretRef)` after a successful wake or a `forget`.
5. Replace guard. The new hook `canWake(record) → { ok: true } | { ok: false, code, message, details }` is checked before `startRuntime`. If the record's placement is `replace` or unknown (legacy record) and a managed primary container is running, the hook returns 409 `wake_would_replace_running` with `details: { runningModel, runningContainer }`. The same 409 applies to parallel placement when `containerName` is taken by a running container. `wakeOptions.confirmReplace === true` bypasses the guard; only the explicit UI confirm sends it.
6. `wake` builds `{ ...record.config, instanceMode, instanceId, apiKey, ...overrides }`. The ledger record gains the additive fields `placement`, `secretRef` (ref id only) and `hasApiKey`.
7. Route: `POST /api/idle-unload/:id/wake` reads `{ confirmReplace?: boolean }` from the body. Errors return `{ok:false, error, code, details}`.

**HTTP**

```http
POST /api/idle-unload/slp_1/wake        {}            → 409
{ "ok": false, "code": "wake_would_replace_running",
  "error": "唤醒会替换正在运行的 Qwen3.8-27B。/ Waking would replace the running model Qwen3.8-27B.",
  "details": { "runningModel": "Qwen3.8-27B", "runningContainer": "vllm-manager-runtime" } }
POST /api/idle-unload/slp_1/wake        { "confirmReplace": true }  → 200 { "ok": true, "id": "slp_1", "model": "…", "job": { "id": "…" } }
```

**UI (UI batch, `shared-public/js/idle-unload-renderer.js`).** On a 409 with `wake_would_replace_running`, the UI shows a confirm dialog:
- zh: "唤醒会停止并替换正在运行的「{model}」。确定继续？"
- en: "Waking will stop and replace the running model "{model}". Continue?"

Only on OK does it re-POST with `{confirmReplace:true}`. For `wake_api_key_missing` it shows:
- zh: "原 API Key 已不可用，请从启动页重新启动该模型。"
- en: "The original API key is no longer available. Start the model again from the launch page."

**Risk.** Medium. Wake now really starts containers, so the guard is essential, and the integration test below is mandatory.

The wake refs live in the existing owner-only-ACL runtime secret store (`<manager>/logs/runtime-api-keys.json`), which already holds the keys of running containers. The only change is that a sleeping instance's key stays there until wake or forget, instead of being deleted at stop. This is still plaintext at rest until 06 OPS-3 moves the store behind DPAPI and out of `logs/`. P0 adds no new secret file, and the scrub tool never touches the store (P0-5).

**Tests**

- Change `manager-core/test/idle-unload.test.js`. Keep the existing mocks at `:19` and add cases for:
  - `findWakePlan` placement passthrough;
  - `canWake` 409 and the confirm bypass;
  - secret prepare, resolve and release order;
  - sleep skipped on `api_key_unavailable`;
  - a legacy record without placement treated as replace.
- New `vllm-manager/test/idle-wake-integration.test.js` and `llama-manager/test/idle-wake-integration.test.js`. Each runs the controller wired to the **real** `createVllmStartRuntimeRequest` / `createLlamaStartRuntimeRequest` with a fake docker and fake admission, and asserts that the start body contains `model`, `instanceMode`, `instanceId` and `apiKey`. This test would have caught the original bug.
- Portability. These tests assert only through the controller hook interface (`findWakePlan`, `canWake`, `prepare/resolve/releaseWakeSecrets`), the route `POST /api/idle-unload/:id/wake`, and the start body that reaches the launch handler. They never assert on server internals, so 01 ENG-8 runs them unchanged.

**Superseded by.** 01 ENG-8. The LaunchStore records launches by `launchId`, and wake moves onto it. ENG-8's acceptance ports this fix:
- the `findWakePlan` semantics (containerName, then path, then served name);
- 409 `wake_would_replace_running` with `details` and the `confirmReplace` bypass;
- 409 `wake_api_key_missing`;
- wake-secret retention through the secret-store facade.

P0-RT-2's tests move unchanged into the ENG-8 suite.

### P0-2 SGLang VRAM admission (RT)

**Evidence**

- `vllm-manager/lib/launch-request.js:168-187` sends `requestedFraction: gpuMemoryUtilization` with `estimatePolicy:"vllm_gpu_memory_utilization"` for both engines.
- `manager-core/gpu-admission.js:325-347` `requestedMbForGpu` takes the max of `requestedMb` and `fraction × totalMb`. The decisions at `:517-545` use `available = min(free − reserve − pending, total × maxUtil − used − pending − margin)`, with maxUtil capped at 0.99 (`:43-47`).
- `vllm-manager/lib/default-profiles.js:14-52` profile `qwen38-flash-next-sglang-262k` uses `gpuMemoryUtilization 0.995` and `sglangMaxTotalTokens 262144`.
- `pennyroyal.js:7` notes that `mem-fraction-static` is not a device fraction.
- A simulation with the real module (97887 MiB, 600 used, reserve 2048, maxUtil 99 %) gives "needs 97398 MiB … budget is 95239 MiB". Live policy uses maxUtil 95 %, which is stricter still.
- The rejection text says "Parallel launch" even in replace mode (`:544`).

**Semantics used.** SGLang sizes its static pool as `total × mf − (memory used by others at start)`. In other words, the pool covers weights plus KV inside the memory that is free at start, minus `total × (1 − mf)`. The value `mf × freeMb` is a conservative upper bound for that footprint. When `--max-total-tokens` is set, the KV pool is capped and the real footprint can be much smaller. Without a weights estimate, the admission module cannot know how much smaller.

**Change (`manager-core/gpu-admission.js`).** The fields below are additive and form the canonical SGLang admission API (C1). 01 ENG-12 and 02 MOD-9 emit exactly these names.

| Where | Field | Type / values | Meaning |
|---|---|---|---|
| request | `requestedFractionOfFree` | number in (0, 1] | `--mem-fraction-static`. The base is `gpu.freeMb − pendingMb`, read after `prepare` in replace mode |
| request | `poolCappedTokens` | integer ≥ 0 | > 0 means the engine caps its KV pool (`--max-total-tokens`), which enables clamp-and-warn |
| request | `minClampMb` | integer, default 4096 | Below this budget, no clamp is attempted |
| request | `estimatePolicy` | `"sglang_mem_fraction_static_of_free"` | Lease or diagnostic label, in the style of `vllm_gpu_memory_utilization` |
| decision (`details.gpus[]`, lease) | `requestedMb`, `availableMb`, `reservedMb`, `clamped`, `verdict` | MiB, MiB, MiB, bool, `ok\|warn\|block` | `reservedMb = clamped ? availableMb : requestedMb` |
| 409 `insufficient_vram` details | `mode`, `maxFraction` | `replace\|parallel`, number\|null | The largest passing fraction for the knob in use |
| lease summary | `verdict`, `clamped`, `warning`; `reservations[].estimateMb` | `ok\|warn`, bool, `"<zh> / <en>"`; MiB | `reservations[].requestedMb` stays the **reserved** amount, so `activeReservedMb` (`:285-296`) is unchanged |
| `job.meta.admission` | `{ verdict, requestedMb, reservedMb, availableMb, clamped, policy }` | `policy: "static-fraction-of-free"` | The 00 §4.3 `memory.policy` value (C1) |

- The new pure export is `decideGpuReservation(request, gpu, { pendingMb, reserveMb, maxUtilization, startupMarginMb }) → { requestedMb, availableMb, freeBudgetMb, thresholdBudgetMb, reservedMb, clamped, verdict, maxFraction }`.
  - `acquireUnlocked` (`:510-546`) calls it per selected GPU instead of its inline arithmetic, and rejects when any verdict is `block`.
  - `/api/memory-estimate` calls it for its preview (below), so the preview and the admission cannot disagree.
- `requestedMbForGpu` adds the candidate `ceil((gpu.freeMb − pendingMb) × requestedFractionOfFree)`. It is still a max over trustworthy candidates. SGLang no longer sends `requestedFraction`, so the device fraction stops dominating.
- In a decision where `requestedMb > availableMb`:
  - If `poolCappedTokens > 0` and `availableMb ≥ minClampMb`, the request is clamped. The lease reserves `availableMb`, the decision gets `clamped:true` and `verdict:"warn"`, and the lease gets the `warning`.
  - Otherwise the verdict is `block` and the request is rejected as today (409 `insufficient_vram`, code unchanged). The message is mode-aware and names the knob and `maxFraction = floor(availableMb / (free − pending) × 1000) / 1000`.
- Messages (each sent as `"<zh> / <en>"`):
  - Replace, zh: "替换启动需要 {req} MiB，安全预算只有 {avail} MiB。请把「静态显存比例（mem-fraction-static）」降到 {maxFraction} 以下，或设置 KV 池上限（max-total-tokens）。现有模型容器未改动。"
  - Replace, en: "Replacement launch needs {req} MiB but the safe budget is {avail} MiB. Lower the static memory fraction (mem-fraction-static) to {maxFraction} or below, or cap the KV pool (max-total-tokens). Existing model containers were not changed."
  - Parallel: the same text with "并行启动 / Parallel launch". vLLM wording: "显存预留比例（gpu-memory-utilization）/ GPU memory reservation (gpu-memory-utilization)".
  - Clamp warning, zh: "SGLang 静态显存比例按空闲显存折算需要 {req} MiB，超过安全预算 {avail} MiB；因 KV 池已限制为 {tokens} tokens，按 {avail} MiB 预留并继续启动。"
  - Clamp warning, en: "SGLang's static memory fraction of free memory would take {req} MiB, above the safe budget of {avail} MiB. The KV pool is capped at {tokens} tokens, so the launch continues with a {avail} MiB reservation."
- `vllm-manager/lib/launch-request.js` handles SGLang without the Pennyroyal image as follows:
  - `requestedFraction` is `undefined`;
  - `requestedFractionOfFree` is `gpuMemoryUtilization` (the form value that maps to `--mem-fraction-static`);
  - `poolCappedTokens` is `sglangMaxTotalTokens || 0`;
  - the warning is appended to the job log, and `job.meta.admission` is stored as in the table above.

  Pennyroyal is unchanged: it uses a measured `requestedMb` of 88000. vLLM is unchanged. The llama admission request (`gguf-estimate`, `llama-manager/lib/launch-request.js:204-221`) is not touched.

**Change (`vllm-manager/lib/memory-estimate.js`, `/api/memory-estimate` preview).** Today an SGLang request without Pennyroyal falls through to the vLLM branch. It reports `engine:"vllm"` and judges by device fraction (`:63-120`). The SGLang branch keeps the vLLM estimator math and the full response shape (00 §6), and changes the following:
- `engine` is `"sglang"`, a deliberate value correction. A request without `engine` still reports `"vllm"` (`pennyroyal.test.js:16`).
- It adds `plan.policy:"static-fraction-of-free"`, `plan.estimatePolicy:"sglang_mem_fraction_static_of_free"` and `plan.admissionPreview: { verdict, requestedMb, availableMb, reservedMb, clamped, maxFraction, poolCappedTokens, basis:"policy-snapshot" }`. The preview is computed by `decideGpuReservation` over the `selectedGpus` the caller passes (the minimum-free GPU), with `pendingMb: 0`. Without GPU data, `admissionPreview` is `null` and the status stays the estimator's (`warn`, as today).
- `plan.status` and `recommendations.status` map `block` to `"fail"` and `warn` to `"warn"`. For `ok` they keep the estimator status. The admission or clamp message is prepended to `suggestions`.
- The policy comes from the server, never from the body: `buildMemoryEstimate: (body) => buildVllmMemoryEstimate({ ...body, admissionPolicy: { reserveMb, maxUtilizationPct, startupMarginMb } })`, read from `gpuAdmissionController` (`server.js:252`). Without a policy (unit calls), the module defaults match `gpu-admission.js` (8192 MiB, 85 %, 1024 MiB).

**Worked example.** Flash-Next 262K in replace mode, total 97887 MiB, used 600 after the old container stopped, policy reserve 8192, maxUtil 95 %:
- requested = ⌈0.995 × 97287⌉ = 96801;
- available = min(97287 − 8192, ⌊97887 × 0.95⌋ − 600 − 1024) = min(89095, 91368) = 89095;
- the pool is capped at 262144 tokens, so the request is clamped to 89095 and the verdict is `warn`. The launch is admitted, and the preview shows the same `warn`.

The same profile with `sglangMaxTotalTokens` empty is rejected with `maxFraction` 0.915.

**Risk.** Medium. Clamping trusts the capped pool to fit. That is the documented intent of the validated recipe, and the reserve still protects the desktop. Strict mode is open decision O2. Leases and the acquire-after-prepare ordering are unchanged.

**Tests**

- `manager-core/test/gpu-admission.test.js` gets new cases for:
  - `decideGpuReservation` as a pure table test;
  - the fraction-of-free base after pending;
  - clamped warn, where the lease `reservations[].requestedMb` equals `reservedMb` and a second acquire sees it as pending;
  - uncapped reject with `maxFraction`;
  - mode-aware message text;
  - that existing `requestedFraction` behaviour is unchanged.
- `vllm-manager/test/launch-request.test.js`: the Flash-Next default profile is admitted with `verdict:"warn"` against a fake 97887 MiB GPU. The Pennyroyal assertions at `:172-173` stay unchanged.
- New `vllm-manager/test/memory-estimate-sglang.test.js`: with the policy `{reserveMb: 8192, maxUtilizationPct: 95, startupMarginMb: 1024}` and one GPU of 97887/600/97287 MiB, the same profile previews `engine:"sglang"` with `admissionPreview.verdict:"warn"`, and the uncapped one previews `"fail"` with `maxFraction` 0.915. A body-supplied `admissionPolicy` is ignored by the server wiring. `pennyroyal.test.js` and `vllm-manager/test/core.test.js:663-664` pass unmodified.

**Superseded by.** P0-RT-3 is the only P0 change to `gpu-admission.js` and `memory-estimate.js`. The next steps are:
- **01 ENG-12** runs after P0-RT-3. It moves this logic behind the descriptor `memoryModel` (`manager-core/engines/memory-models.js#staticFractionOfFree`) and renames no field. Ceiling or floor terms are at most derived read-only views: ceiling = `requestedFractionOfFree × (free − pending)`, floor = `minClampMb`. When the weights are known, it may send `requestedMb` instead of the fraction; the policy stays `static-fraction-of-free`.
- **02 MOD-9** comes after ENG-12. `fit.js` supplies only artifact-side inputs (weight bytes, KV bytes per token per layer) through `engines.memoryModels.estimate(engineId, inputs)`.

### P0-3 Per-instance logs and facts (RT; OBS route redaction; UI link)

**Evidence**

- `manager-core/runtime-request-utils.js:182-190` `readRuntimeLogsRequest` always uses `options.containerName`. The route is `runtime-routes.js:83-91`.
- `vllm-manager/server.js:4612-4635` `getLatestRuntimeFacts` runs `docker logs … CONFIG.containerName` and scans job text from all serve jobs. It is called from `collectVllmMetricsSummary` (`:4279-4283`), which is otherwise per-container.
- llama: `server.js:3197-3215`, called at `:3028`, uses the latest serve meta regardless of container.
- UI log fetches: `vllm-manager/public/app.js:2186`, `llama-manager/public/app.js:2356`.

**Change**

- `GET /api/logs?instance=<id|containerName>&tail=N` is an additive query parameter. Without `instance`, the endpoint behaves as today (primary).
- `createRuntimeRequestUtils` takes a new option `resolveLogContainer(instance) → containerName | null`. The servers implement it against their own instance list (`vllm-manager/server.js:3955-4030` and the llama equivalent). Only containers labelled as owned by this manager are accepted. Anything else returns 404 `{ error, code: "unknown_instance" }` and never shells out with a caller-provided name.
- `getLatestRuntimeFacts(hints, { containerName })`. Docker logs are read from that container, and job text is filtered to serve jobs whose `meta.containerName` matches. llama does the same with its latest serve meta per container.
- OBS: the `/api/logs` route passes its output through the server-provided redactor before sending (P0-5).
- UI: each row in the runtime-instances table gets a "日志 / Logs" link that opens the existing logs panel with `?instance=`. This lives in `shared-public/js/runtime-instances.js` and both `app.js` files.

**Risk.** Low. The parameter is validated against the owned-instance list.

**Tests.** `manager-core/test/runtime-request-utils.test.js` is a new file. It asserts that:
- an unknown instance gives 404 without a docker call;
- a known instance gets its containerName passed to the docker args;
- the default path is unchanged.

vLLM facts get one test with two fake containers, which checks that the facts come from the right container.

**Superseded by.** 01 ENG-13 (`/api/instances/:id/logs`; `?instance=` and `unknown_instance` stay) and 04-telemetry (per-instance stats).

### P0-4 Secrets out of `docker run` argv (RT)

**Evidence**

- `vllm-manager/lib/runtime-command.js:214` `runArgs.push("-e", \`HF_TOKEN=${process.env.HF_TOKEN}\`)`, `:304` vLLM `--api-key <key>`, `:387` SGLang `--api-key <key>`.
- llama: `lib/runtime-command.js:139` (HF_TOKEN) and `:207` (`--api-key`).
- `vllm-manager/server.js:5173-5199` runs `docker(runArgs)`, so the key is in the host process command line, which any local user can see through process listings. Failure text `Command failed: docker run …` carries the full argv into `failJob`, so the live `jobs-ledger.json` holds plaintext keys (P0-5).
- `redactDockerArgs` (`vllm-manager/lib/runtime-command.js:28-34`, llama `:24-30`) only protects the stored `launchCommand`, and it uses the marker `***`.

**Change**

- vLLM: the command builder no longer emits `--api-key`. It emits `-e VLLM_API_KEY` (name only) and returns `secretEnv: { VLLM_API_KEY: key }`. vLLM reads `VLLM_API_KEY` when `--api-key` is absent.
- llama.cpp: the builder emits `-e LLAMA_API_KEY` and returns `secretEnv: { LLAMA_API_KEY }`. Before merging, the implementer confirms that `LLAMA_API_KEY` is the env binding of `--api-key` by reading `common/arg.cpp` at the pinned llama.cpp build tag. If it is not, llama falls back to the SGLang treatment below.
- HF token (both builders): `-e HF_TOKEN` (name only) when `process.env.HF_TOKEN` is set, and `secretEnv.HF_TOKEN`.
- SGLang keeps `--api-key`, because env support is not verified for the pinned images. The Pennyroyal golden (`pennyroyal.test.js:64`) must stay byte-identical. Its exposure is limited by P0-5 redaction (open decision O1).
- New `manager-core/docker-runtime.js` export `buildDockerChildEnv(secretEnv, { viaWsl }) → env`. It returns `{ ...process.env, ...secretEnv }`. When docker runs through the WSL prefix, it also appends `NAME/u` for each secret name to `WSLENV`, keeping existing entries and avoiding duplicates. `docker()` already forwards `dockerOptions.env` to `execFile`.
- Both servers pass `{ env: buildDockerChildEnv(command.secretEnv, { viaWsl }) }` to **every** `docker run` attempt, including the name-conflict and LAN-bind retries (`server.js:5173-5199`).
- `redactDockerArgs` stays for the SGLang path and the legacy path. It delegates to `redactSecrets` and emits `<redacted>` (section 3).
- The container labels `ai.manager.api-key-ref` and `ai.manager.port` are unchanged. Adoption of old containers is unaffected.

**Security notes.** `docker inspect` still shows `Config.Env`, which is the same trust boundary as the docker socket. The goal of this fix is the host process list, job logs and ledgers. The env object is never logged; only the names appear in argv.

**Risk.** Medium. This changes validated recipe argv for vLLM and llama (D10 overrides byte-identity for the key flag only), so P1 golden baselines must be captured on the P0-merged branch (contract change C3). A mis-set `WSLENV` would start a container without a key; the test below covers it.

**Tests**

- `vllm-manager/test/runtime-command.test.js:109` currently asserts `--api-key` is present. It flips to assert:
  - no `--api-key` in the vLLM argv;
  - `-e VLLM_API_KEY` is present;
  - `secretEnv.VLLM_API_KEY === key`;
  - no argv element contains the key value.
- The `:110-118` label assertions and `:120` (the redacted argv does not contain the key) stay.
- `:119` (`includes("***")`) is replaced. The vLLM argv no longer holds a key to redact, so the presence check becomes `includes("<redacted>")` on an SGLang argv, which still carries `--api-key`.
- `llama-manager/test/runtime-command.test.js` gets the same changes. Its `:151` check runs `redactDockerArgs` on a synthetic argv that contains the key and expects `<redacted>`. `pennyroyal.test.js:64` is unchanged.
- The full-argv check is an inline assertion in `runtime-command.test.js`. It is not a golden file (rule 1.8).
- New `manager-core/test/docker-runtime-env.test.js` covers `WSLENV` merge, dedupe and no-WSL behaviour.
- A server-level fake-docker test asserts that every retry attempt receives the env.

**Superseded by.** 01-engines adapters, which keep env delivery. The `command.env` with `<redacted>` in 00 §4.3 already matches this design. ENG-15 skips its own argv change, because P0-RT-1 lands it. ENG-1 captures the goldens after this change (C3).

### P0-5 Redaction at every log sink, self-healing ledgers, scrub tool (OBS; RT wiring)

**Evidence**

- `manager-core/jobs-ledger-store.js:85-94` `appendLog` is the single choke point but does not redact. `:106-113` `failJob` appends `error.stdout`, `error.stderr` and `Error: ${job.error}` raw.
- `manager-core/job-utils.js:69-84` `appendJobLog` / `sanitizeJobLogText` only normalise text.
- The live `<AI_ROOT>/vllm-manager/logs/jobs-ledger.json` contains 6 plaintext runtime keys. vLLM echoes `--api-key` in its startup log, and the docker failure text carries argv.
- `scripts/backup-platform.ps1:64-66` copies `logs/*.json` into dated, private-ACL backups that are kept 14 days.
- The runtime key store is itself `<manager>/logs/runtime-api-keys.json` (`vllm-manager/server.js:185`, `llama-manager/server.js:148`), stored as `{version, secrets:{ref:{secret, createdAt}}}`. A naive `*/logs/*.json` scrub would therefore redact live keys.

**Change**

- `jobs-ledger-store` options gain `redact` (default: patterns-only `redactSecrets`). `appendLog` redacts every line. `failJob` redacts `job.error`, stdout and stderr. `loadJobsLedgerIntoMemory` (`:33-48`) redacts `logs[]`, `error` and string values in `meta`. If anything changed on load, it marks the ledger dirty, saves it through the existing atomic writer, and logs one line with counts only: `jobs-ledger: redacted N secret-like strings on load`.
- `job-utils.sanitizeJobLogText` applies `redactSecrets` with patterns, which covers callers outside the store.
- `runtime-routes.js` `/api/logs` applies `options.redactLogs` (default: patterns-only) to the text.
- RT wiring (both servers): `createSecretRedactor({ getSecrets })` is passed as `redact` / `redactLogs`. `getSecrets` returns `[...runtimeApiKeyStore.values(), process.env.HF_TOKEN, ...downloadTokens.values()]` from an in-process cache, because `values()` re-reads the store file on every call. The cache is invalidated on every `runtimeApiKeyStore.set/remove` and every download-token map change, and otherwise refreshed at most once per second. Wake refs (P0-1) are store entries, so they are covered.
- New `manager-core/ledger-scrub.js`:
  - `isSecretStoreFile(file, parsed) → boolean`. It is true for the names `runtime-api-keys.json` and `runtime-secrets.json`, or for any JSON whose top level is the store shape `{ version, secrets: {…} }`.
  - `scanLedgerFile(file, { secrets }) → { file, matches, skipped? }`
  - `scrubLedgerFile(file, { secrets, apply }) → { file, matches, written, skipped? }`. A secret store is returned as `skipped: "secret_store"` and is **never** rewritten. Redacting it would destroy the keys of running containers.

  The new CLI `scripts/scrub-job-ledgers.js` wraps it. Its flags and exit codes are a contract: 01 ENG-15 extends the scan set (for example LaunchStore files) but adds no `--write` and changes no default.
  - It defaults to a dry run. `--apply` rewrites, `--force` overrides the port guard, `--root <AI_ROOT>` sets the root, and `--include <glob>` adds globs.
  - It scans `*/logs/*.json` minus secret stores, which it lists as skipped. It reports `<AI_ROOT>/backups/*` without changing them, because the manifest hashes would break.
  - `--apply` refuses a manager whose port (5177/5178, env-overridable) accepts TCP connections unless `--force` is given.
  - Rewrites are atomic (temp file + rename) and keep no plaintext backup.
  - Output is counts and relative file names only.
  - Exit codes: 0 means clean, 2 means matches were found (dry run) or remain in backups, 1 means an error. Skipped secret stores do not affect the exit code.
  - It prints key-rotation advice. Rotating the keys is owner action A1.

**Risk.** Low. The redaction patterns can over-redact a few legitimate tokens such as `sk-` model ids of 16+ characters. That is acceptable in logs; API responses use `patterns:false`.

**Tests.** New test files. All of them build their trees under `os.tmpdir()` (rule 1.8).
- `manager-core/test/jobs-ledger-redaction.test.js`: appendLog, failJob with docker error text, redact-on-load marking dirty, and no change for clean ledgers.
- `manager-core/test/ledger-scrub.test.js`: dry-run counts, apply rewrite, backups never written, and refusal while the port is open (uses a stub probe). A `runtime-api-keys.json` that holds the fixture key is byte-identical after `--apply` and is reported as skipped.

Existing job-utils tests stay as they are.

**Superseded by.** Nothing. The redactor is permanent and is the only one (rule 1.4). P1, P3, P4, P5 and P6 import it. ENG-15 extends `scrub-job-ledgers.js` and does not recreate it.

### P0-6 Recent-rate sampling window (OBS)

**Evidence**

- `manager-core/stats-utils.js:125-148` keeps a single previous sample, updated only when `updateSamples` is true.
- `vllm-manager/server.js:4189` collectStats passes `updateSamples:true` on every UI poll, which happens every 5 s per open tab (`app.js:1212-1214`). The 60 s history sampler (`:2165-2184`) passes `false`.
- The effect: rates span 0–5 s, differ between tabs and fall to zero between polls. With no UI open, the history sampler records zero forever.

**Change.** `calculateRecentRates(samples, key, nowSeconds, counters, _updateSamples, options)` keeps its signature and its first three output fields. The `updateSamples` argument is accepted and ignored.
- The store value becomes a ring buffer (an in-memory `Map`, so there is no migration). Every call records a sample unless the newest is under 2 s old; samples older than 150 s are dropped, with at most 40 kept.
- Counter-reset detection: if any counter is below the newest sample, the buffer is cleared and the call returns zeros.
- Baseline: among samples aged 10–150 s, the one whose age is closest to `options.windowSeconds` (default 60). If none qualifies, the call returns zeros.
- Output adds `windowSeconds`, the actual baseline age rounded to whole seconds.

**Risk.** Low. The UI value becomes a 60 s average, which is labelled in P0-7.

**Tests.** The existing assertion at `manager-core/test/core.test.js:492-509` (samples at t=10 and t=20 → 6/3/18) holds unchanged. New `manager-core/test/recent-rates.test.js` covers:
- that the history caller alone (`false`) still produces rates;
- the window choice;
- the 2 s spacing;
- counter reset;
- per-key isolation.

**Superseded by.** 04-telemetry (§17.1 sampler, TEL-1). The `/api/stats` facade keeps this window and `windowSeconds`.

### P0-7 Speed sources and labels (RT servers; UI labels)

**Evidence**

- vLLM `server.js:4516-4534` `resolveSglangGenerationThroughput` returns a sticky gauge (`sglang_recent_gauge`) even when idle, so the last burst's speed is shown forever. Today's per-model `outputSource` values are `counter_delta` (vLLM, `:4471`), `sglang_live_gauge`, `sglang_recent_gauge`, `sglang_active_average` and `unavailable`. llama sets none.
- llama `server.js:3137-3141` reports `llamacpp:predicted_tokens_seconds` as `recentOutputTokensPerSecond`. That metric is a lifetime average.
- Labels: `shared-public/js/stats-summary-renderer.js:26-28,88` show "当前输出速度" and "平均延迟". `:88` appends suffixes for the two legacy SGLang source values.

**Change.** Per model, `speed.outputSource` becomes the closed set `counter_window | sglang_gen_throughput_gauge`, and `speed.windowSeconds` is added. The aggregate in `stats-utils.js:25-50` is unchanged: one source gives that value, several give `mixed`, none gives `unavailable`. These names are must-keep (C2).
- **SGLang**, checked in order:
  1. If `num_running_reqs > 0` and `sglang:gen_throughput > 0`, the value is the gauge with `outputSource:"sglang_gen_throughput_gauge"` and `outputObservedAt = now`.
  2. Otherwise, if the build exports a generation counter (`sglang:generation_tokens_total` is present in the scrape), the value is the P0-6 window with `outputSource:"counter_window"` and `windowSeconds`.
  3. Otherwise, on a build without token counters, the value is `0` with `outputSource:"sglang_gen_throughput_gauge"`. This is the gauge fallback: the live gauge is still used while requests run (step 1), and an idle engine reports 0, never the last burst.
- **vLLM**: `counter_delta` becomes `counter_window`. The value is the window.
- **llama**: `predicted_tokens_seconds` feeds only `averageOutputTokensPerSecond`. The recent value comes from `tokens_predicted_total` through the window, with `outputSource:"counter_window"`.
- `averageOutputTokensPerSecond` keeps its sources (the SGLang active average, the vLLM histogram).
- The renderer picks the label by source:
  - gauge: "输出速度（实时）/ Output speed (live)";
  - window with `windowSeconds > 0`: "输出速度（近 {n} 秒平均）/ Output speed ({n} s average)";
  - window with `windowSeconds` 0, or an unknown or legacy value: "输出速度（采样中）/ Output speed (sampling)".

  "平均延迟" becomes "平均延迟（启动以来）/ Average latency (since start)". All strings are added to `i18n-common.js`. The old entries at `:397-398` and the `:88` legacy suffixes are replaced.

**Tests**
- `vllm-manager/test/stats-speed.test.js` (new):
  - with the gauge > 0 and running = 0, the result is `counter_window`;
  - with running > 0, the result is the gauge;
  - with no `generation_tokens_total` series and running = 0, the result is `0` with `sglang_gen_throughput_gauge`;
  - vLLM reports `counter_window`.
- `vllm-manager/test/core.test.js:575-618` ("SGLang speed keeps the last real gauge…") asserts the removed sticky behaviour. It is rewritten in place to the order above.
- `manager-core/test/core.test.js:438-457` passes `sglang_recent_gauge` only as an opaque aggregation input, so it stays green unmodified.
- `llama-manager/test/stats-speed.test.js` (new): the lifetime average never appears as recent.
- `tests/p0-ui.spec.cjs` checks the label by source, including the sampling label.

**Superseded by.** 01 `metrics-map.js` and 04 TEL-1. TEL-1 keeps `speed.windowSeconds`, both `outputSource` values and the gauge fallback exactly as defined here. Its `speed.window{seconds, source, idle}` and `speed.averageSource` are additional fields only.

### P0-8 Download failure taxonomy and retry policy (DL)

**Evidence**
- `manager-core/download-job-controller.js:367-407` `scheduleFailedDownloadRetries` retries every failure up to `maxRetries`, including gated (403), not-found and disk-full failures.
- `process-job-runner.js:106` sets `job.error = "Process exited with code N"`. The UI shows only that.

**Change.** New `manager-core/model-hub/errors.js` at its final 00 §2 path:

```js
/** @returns {{ code, baseCode, retryable, retryDelayFactor, title:{zh,en}, hint:{zh,en} }}
 *  baseCode === code for every P0 code; 03 adds derived codes whose baseCode is a P0 code. */
function classifyDownloadFailure({ text = "", exitCode = null, error = null, meta = {} } = {})
const DOWNLOAD_ERROR_CODES = Object.freeze([...]);   // the 14 codes below, in table order
```

These codes are the platform's download-failure vocabulary (C5). `classifyTransferFailure`, `stall_no_progress`, `hf_token_invalid` and `unknown_error` are not introduced anywhere.

The table is checked in order; the first match wins. `text` is the last 60 log lines plus `job.error`.

| code | match | retryable | hint (zh / en) |
|---|---|---|---|
| `stall` | `meta.stalled === true` | yes | 下载长时间无进度，已自动重试。/ No progress for a long time; retrying automatically. |
| `verify_failed` / `checksum_mismatch` | `meta.verifyFailed` / `/sha256 mismatch\|checksum/i` | yes | 文件校验失败，将重新下载受影响的文件。/ File verification failed; affected files will be downloaded again. |
| `cli_missing` | `error.code==="ENOENT"`, `/is not recognized as an internal or external command\|command not found/i` | no | 未找到下载工具，请运行 install-download-cli.cmd。/ Download tool not found. Run install-download-cli.cmd. |
| `disk_full` | `/No space left on device\|ENOSPC\|not enough space on the disk/i` | no | 目标磁盘空间不足，请清理或换一个模型存储位置。/ The target disk is full. Free space or choose another model storage location. |
| `hf_approval_required` | `/GatedRepoError\|awaiting a review\|is restricted\|Cannot access gated repo\|403 Client Error/i` | no | 需要先在 Hugging Face 模型页申请访问权限并等待批准。/ Request access on the Hugging Face model page and wait for approval. |
| `hf_auth_invalid` | `/401 Client Error\|Invalid (user )?token\|invalid credentials/i` | no | Hugging Face Token 无效，请重新登录 hf 或填写新的 Token。/ The Hugging Face token is invalid. Log in to hf again or enter a new token. |
| `hf_token_expired` | `meta.transfer.tokenRef` set but token not available (P0-9) | no | 下载所需的 Token 已失效（管理器重启后不保留），请重新发起下载并填写 Token。/ The token for this download is gone (it is not kept across manager restarts). Start the download again and enter the token. |
| `repo_not_found` | `/RepositoryNotFoundError\|Repository Not Found\|404 Client Error/i` | no | 仓库不存在或无权查看，请检查模型 ID。/ Repository not found or not visible. Check the model id. |
| `revision_not_found` | `/RevisionNotFoundError/i` | no | 指定的版本不存在。/ The requested revision does not exist. |
| `filter_no_match` | `meta.errorCode === "filter_no_match"` (set at request time, P0-10) | no | 所选精度没有匹配的文件，请换一个精度或选择“原始仓库”。/ No files match the selected precision. Pick another precision or "original repository". |
| `rate_limited` | `/429\|Too Many Requests\|rate limit/i` | yes, delay ×4 (min 120 s) | 请求过于频繁，稍后自动重试。/ Rate limited; retrying later. |
| `network_unreachable` | `/ConnectionError\|ConnectTimeout\|Max retries exceeded\|getaddrinfo\|ECONNRESET\|ECONNREFUSED\|ETIMEDOUT\|EAI_AGAIN\|SSLError\|ReadTimeout\|name resolution/i` | yes | 网络连接失败，将自动重试；若持续失败可开启/关闭镜像。/ Network error; retrying. If it keeps failing, toggle the mirror. |
| `unknown` | fallback | yes (keeps today's behaviour) | 下载失败，查看日志了解详情。/ Download failed. See the log for details. |

**Controller.**
- `scheduleFailedDownloadRetries` classifies a failed download job once, the first time it sees it. It stores `meta.errorCode`, `meta.errorRetryable` and `meta.errorHint` (`{zh,en}`), sets `job.error` to `"<title.zh> / <title.en>"`, and appends the original error text to the log through the redacting `appendLog`.
- Non-retryable jobs are skipped with one log line:
  - zh: "此错误不会自动重试：{title}"
  - en: "Not retried automatically: {title}"
- `rate_limited` multiplies the delay.
- Manual resume is always allowed.
- `/api/jobs?fields=summary` passes `meta` through (`job-routes.js:10-20`), so the API itself does not change.

**Risk.** Low. Unknown failures still retry, so the existing tests at `manager-core/test/platform-improvements.test.js:415-462` and `core.test.js:4412+` stay green unmodified.

**Tests.** New `manager-core/test/download-errors.test.js` uses a fixture line per code, taken from real hf CLI / huggingface_hub messages with no tokens or paths. It checks the order precedence (403 text containing "ConnectionError" → approval) and that the controller skips retry for each non-retryable code.

**Superseded by.** 03-hub, which extends `errors.js` and does not replace it. 03's HUB-P0b is deleted. `data/hub-transfer-errors.json` stays keyed by these names and may add only derived codes, each with a `baseCode` (C5).

### P0-9 Transfer settings survive resume; tokens never reach the mirror (DL; RT wiring)

**Evidence**
- `manager-core/download-utils.js:213-243` `buildDownloadSpecFromJob` rebuilds env with `buildDownloadEnv(hfCache, env, { source })`. That drops `hfMirror`, `hfTransfer` and the token. A gated download that is resumed or auto-retried loses its token, and a mirror download silently switches to huggingface.co.
- `buildDownloadEnv` (`:154-186`) sets `HF_ENDPOINT` to the mirror but keeps `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` from `process.env`, and the implicit login token under `HF_HOME` is still sent.
- `manager-core/mirror-probe.js:37` sends `Authorization` to every non-ModelScope source, including hf-mirror.
- The servers set `env.HF_TOKEN = body.hfToken` (vLLM `server.js:1173`, llama `:1243`) only for the first spawn.

**Change**
- Job meta gains `transfer: { hfMirror: bool, hfEndpoint: string|null, hfTransfer: bool, tokenRef: string|null, gated: bool }`, recorded at enqueue. It never holds a token.
- `buildDownloadSpecFromJob(job, { settings, resolveSecret })`:
  - It uses `job.meta.transfer` when present.
  - Legacy jobs without `transfer` use the current `settings` (today's behaviour plus mirror).
  - When `tokenRef` is set it calls `resolveSecret(tokenRef)`. If that returns null, it throws `Object.assign(new Error(…), { code: "hf_token_expired" })`, which the controller classifies.
- `buildDownloadEnv(hfCache, env, { source, hfMirror, hfTransfer, token })`:
  - With the mirror on, it deletes `HF_TOKEN` and `HUGGING_FACE_HUB_TOKEN` and sets `HF_HUB_DISABLE_IMPLICIT_TOKEN=1`.
  - With the mirror off, an explicit `token` sets `HF_TOKEN`.
  - Gated downloads and downloads with a token always force the official endpoint (unchanged rule).
- Controller options: `resolveDownloadSecret(ref)` and `releaseDownloadSecret(ref)`. Release is called on success, cancel and remove.
- RT wiring: each server keeps an **in-memory** `Map` of download tokens keyed `dlt_<random>`. Tokens are never persisted by P0: not in the runtime secret store, not in job meta and not in a hub file. After a restart, a gated resume fails cleanly with `hf_token_expired` and its hint. Persisting a token is an explicit opt-in that arrives later: a "remember" box writes the namespace `hf` of 06 OPS-3's `secret-store.js`. Memory-only stays the default.
- `mirror-probe.js` sends `Authorization` only to the official huggingface.co endpoint.

**Risk.** Low to medium. Legacy queued jobs resume with current settings, which is better than today's silent official fallback.

**Tests**
- New `manager-core/test/download-transfer.test.js` covers:
  - resume keeps mirror and transfer;
  - the token is resolved via the ref;
  - a missing token leads to `hf_token_expired`;
  - mirror env has no token and has `HF_HUB_DISABLE_IMPLICIT_TOKEN=1`;
  - a legacy job uses settings.
- The existing assertions at `core.test.js:3690-3729` (legacy meta, no transfer) and `platform-improvements.test.js:462-470` stay green unmodified.
- `manager-core/test/download-sources.test.js` gets an assertion that the mirror probe sends no `Authorization` to hf-mirror.

**Superseded by.** 03-hub `transfer.js` and providers (03 HUB-P0a and HUB-P0e are deleted). They keep `meta.transfer`, the mirror token isolation and the memory-only default.

### P0-10 Zero-match filter and estimate outage (RT)

**Evidence**
- `startDownloadRequest` (vLLM `server.js:1144-1213`, llama `:1218-1282`) awaits `getHuggingFaceDownloadEstimate` without a catch. That function throws on any huggingface.co API failure (`vllm-manager/lib/remote-models.js:314-352`, which fetches the official API even when the mirror is on). An unreachable huggingface.co therefore blocks downloads that would succeed through the mirror.
- The estimate returns `filtered` and `matchedFiles`, but no guard uses them. An include filter that matches nothing makes the CLI exit 0 having downloaded only small files, and `expectedFiles: expected?.fileCount || null` turns 0 into null.

**Change**
- Both servers wrap the estimate as `.catch((error) => ({ error: redact(error.message) }))`. The vLLM `/api/download/estimate` path already does this at `:910`. When the estimate fails:
  - the gated check is skipped; a gated repo then fails with a classified `hf_approval_required`;
  - the log line "Download size estimate unavailable" stays.
- When `repository.filtered && repository.matchedFiles === 0`, the request is rejected with 422 `{ error, code: "filter_no_match", details: { precision, totalFiles } }` and the bilingual text from the P0-8 table. No directory is prepared.
- `expectedFiles` keeps 0 as 0. Null now means unknown only.

**Risk.** Low.

**Tests.** The new `vllm-manager/test/download-request.test.js` and `llama-manager/test/download-request.test.js` use fake remote services to check:
- estimate rejection → job still enqueued with a log line;
- zero match → 422 and no `prepareDownload` call;
- gated + estimate failure → enqueued.

**Superseded by.** 03-hub queue / precheck (03 HUB-P0c is deleted). 03 adds the post-transfer `transfer_empty` check as a derived code (C5).

### P0-11 Root-aware disk usage, cleanup, upstream check and resume check (DL + RT)

**Evidence**
- `manager-core/model-filesystem-store.js:153-190` `getDiskUsage` scans `modelsRoot` only. The configured default storage root (`model-storage.js:27-31` `roots()`) is elsewhere on the live box, and the legacy root is empty, so the panel shows nothing.
- llama `server.js:1084-1101` cleans up by `name` under `modelsRoot` only. `:1103-1136` checks upstream only if a ledger entry exists. `:1074-1081` checks resume disk space with `getModelsDiskFreeBytes()` on the default `modelsRoot`. vLLM has the same code (`getModelsDiskFreeBytes` `:2905`).
- `download-resume-check.js:42,75-77` takes `diskFreeBytes` as a parameter.

**Change (DL)**
- `createModelFilesystemStore({ …, listRoots })` takes `listRoots() → [{ id, path, label, default, legacy }]`. `getDiskUsage()` returns today's top-level fields, computed for the default root, plus:

```json
{ "roots": [ { "id": "main", "label": "模型库", "default": true, "legacy": false,
               "freeBytes": 0, "totalBytes": 0, "usedByModelsBytes": 0, "modelCount": 9 } ],
  "models": [ { "name": "…", "path": "…", "rootId": "main", "sizeBytes": 0, "incomplete": false } ] }
```

- `inspectDownloadResume({ …, diskFreeBytes })`: when `diskFreeBytes` is omitted it measures `statfs` on `meta.localDir`'s parent. Callers that pass it explicitly are unchanged.

**Change (RT)**
- `POST /api/models/cleanup-incomplete` accepts `{ path }` alongside `{ name }`. The path must pass `modelStorage.resolvePath(path, { allowRoot: false })`, which means inside a configured root and not the root itself. Otherwise the request returns 400 `{ code: "path_outside_roots" }`.
- `GET /api/models/upstream-status` accepts `?path=`. When no ledger entry exists it falls back to the `.platform-download.json` marker (`model-storage.js:189-205`, fields `model`, `source`).
- Both servers wire `listRoots` from `modelStorage.roots()`.
- The resume check passes no `diskFreeBytes`, so the job's own disk is measured.

**UI.** The disk panel lists roots, with the default first:
- column labels: "存储位置 / Storage location", "可用 / Free", "模型占用 / Used by models";
- each model shows its root label.

**Risk.** Low. Path validation reuses the existing resolver.

**Tests**
- New `manager-core/test/disk-usage-roots.test.js` uses temp dirs with two roots and checks the aggregation, `rootId`, and that a legacy empty root is still listed.
- The resume check omitting `diskFreeBytes` measures the job dir.
- The server tests check that `path_outside_roots` is rejected for `..` and for root equality.

**Superseded by.** 03-hub `library.js` (03 HUB-P0d is deleted). The shim, the hub storage API and the console use `roots[]` and `rootId`, and no `volumes[]` is introduced.

### P0-12 llama download presets (UI)

**Evidence.** `llama-manager/public/js/catalog.js:25-37` `MODEL_PRESETS` lists safetensors repos such as `Qwen/Qwen3-8B` for a GGUF-only engine. `index.html:102` defaults to `Qwen/Qwen3-0.6B`. A download either pulls nothing useful or fails P0-10's zero-match guard.

**Change.** Repoint the presets to GGUF repos and pre-select precision `q4_k_m`:
- `Qwen/Qwen3-{0.6B,4B,8B,14B,32B}-GGUF`;
- `unsloth/DeepSeek-R1-Distill-Qwen-{7B,14B,32B}-GGUF`;
- `bartowski/Meta-Llama-3.1-8B-Instruct-GGUF`;
- `unsloth/gemma-3-4b-it-GGUF`;
- `unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF`.

The default input becomes `Qwen/Qwen3-0.6B-GGUF`. The implementer confirms that each repo exists and contains a `Q4_K_M` file with a read-only `GET https://huggingface.co/api/models/<repo>`, and substitutes the official publisher's repo where one exists (open decision O10). Notes that said "可能需要授权 token" are removed for non-gated repos.

**Tests.** A static vm test (`llama-manager/test/catalog-presets.test.js`, new) checks that every preset repo matches `/gguf/i`.

**Superseded by.** 02-models / 07-console catalog. 03 HUB-P0c's preset part is deleted.

### P0-13 Mirror probe persistence and vLLM priority (UI)

**Evidence**
- `llama-manager/public/app.js:2164-2177` sets `#downloadHfMirror.checked` from the probe result and persists it through `saveDownloadQueueMode`. vLLM does the same at about `app.js:4259-4261`. A probe click silently changes a global setting.
- vLLM `index.html:747` renders a priority select, but `app.js:5254-5290` does not send `priority`. llama sends it (`app.js:5168,5191`).

**Change**
- The probe only displays its result:
  - zh: "镜像可用，建议开启" / "镜像不可用"
  - en: "Mirror reachable, recommended" / "Mirror unreachable"

  It also shows a "应用建议 / Apply suggestion" button. Only that button changes and saves the setting.
- The vLLM payload adds `priority`.

**Tests.** `tests/p0-ui.spec.cjs` (new) stubs `/api/download/mirror-probe` and asserts that no `POST` to the download settings happens until "Apply" is clicked. A vLLM download request body contains `priority`.

**Superseded by.** 07-console downloads center. 03 HUB-P0e's UI part is deleted.

### P0-14 Pre-download check copy (DL)

**Evidence**
- `manager-core/download-precheck.js:97-101` prints the capability-matrix confidence even when the match is by name only.
- `:139-141` promises that trust-remote-code "会自动开启". Launch only uses the checkbox or preset (`vllm-manager/lib/runtime-command.js:275,360`).

**Change**
- For name-only matches, confidence reads:
  - zh: "按名称推断（未验证）"
  - en: "Inferred from the name (unverified)"
- The trust-remote-code finding reads:
  - zh: "需要在启动参数中勾选 trust-remote-code（会执行仓库内的 Python 代码）。"
  - en: "Enable trust-remote-code in the launch options (this runs Python code from the repository)."
- The finding codes are unchanged.

**Tests.** `manager-core/test/download-precheck.test.js:78` keeps the `trust_remote_code` code assertion and gains message assertions plus a name-match confidence case.

**Superseded by.** 02 MOD-11, which moves this data into the knowledge layer and keeps these strings and finding codes.

### P0-15 Unknown GGUF architecture (RT + UI)

**Evidence**
- `llama-manager/server.js:375-387` `evaluateLlamaArchitectureRuntimeCompatibility` returns `status:"not-required", supported:true` when an architecture has no capability-matrix entry (message "未为 X 配置额外的最低 llama.cpp 版本限制").
- `public/js/gguf-model-ui.js:50-80` maps `supported` to "兼容". 00 §4.4 forbids showing unknown as compatible.

**Change**
- When `normalized && !capability.entry` (server), the function returns `status:"unknown", supported:null` with this message:
  - zh: "{arch} 不在已验证的架构列表中，能否运行取决于当前 llama.cpp 版本。"
  - en: "{arch} is not in the verified architecture list. Whether it runs depends on the current llama.cpp build."
- The compat report already maps `unknown` to warn (`:1811-1818`).
- Launch is still allowed, because `llama-manager/lib/launch-request.js:69` blocks only `supported === false`. When `supported === null`, the same file appends the message to the start job log and to `job.meta.runtimeCompatibility`.
- UI: `null` is shown as "未知（未验证）/ Unknown (unverified)" with the warn style.
- A known architecture without a minimum build keeps `not-required`.

**Tests**
- `llama-manager/test/core.test.js:382` (known arch `llama` → `not-required`) is unchanged. A new case checks that an unmatched arch gives `unknown` and `null`.
- The existing vm test `llama-manager/test/gguf-model-ui.test.js` (UI-owned) gains a case for the null label.

**Superseded by.** 02 MOD-11 (`support:"unknown"`). It keeps the server message, the `gguf-model-ui.js` change and the label "未知（未验证）/ Unknown (unverified)". It does not introduce "待核验".

### P0-16 Audit export retention, cursor race, stream errors (OBS)

**Evidence**
- `manager-core/audit-store.js:280-305` `pruneAuditExports` prunes by count and age (`:12-13`, 30 exports / 90 days) and ignores `mode`, so it can delete the full export that later incrementals depend on.
- Empty incrementals are written every run (`:215-268`).
- `openwebui-audit-exporter.js:80-110` reads rows, then runs a separate `select max(updated_at)`. Rows written between the two queries are skipped forever.
- `audit-routes.js:5-8` pipes `createReadStream` with no `error` handler. A file deleted mid-download crashes the request handler.

**Change**
- Chain-aware retention. Keep the newest full export and every export newer than it. Older exports are pruned by count and age as today. An empty incremental (`chatCount === 0`) is always prunable except the newest. If no full export exists, incrementals are never pruned.
- An incremental run with zero rows writes no directory and records `lastHeartbeatAt` in the cursor (additive field).
- A new full export is taken when the newest full is older than `AI_AUDIT_REBASELINE_DAYS` (default 7, `0` disables).
- The exporter computes the cursor `max_updated_at` from the fetched rows, or keeps `SINCE` when there are none. The second query is removed.
- Stream handler: `stream.on("error", …)` → 404/500 JSON if headers are not yet sent, otherwise `res.destroy()`.

**Tests.** `manager-core/test/security-hardening.test.js:276-345`:
- The `maxExports 2 → remaining[0] newest` expectation is re-stated under chain rules (newest full kept).
- New cases: a full plus incrementals beyond the count, the no-full case, an empty incremental skipped, and the rebaseline trigger.
- An exporter unit test with an injected row source checks the cursor from rows.
- A route test checks that a missing file returns 404 without throwing.

**Superseded by.** 04 TEL-15, as a delta on the landed code. TEL-15 keeps all of the following:
- chain-aware retention;
- `AI_AUDIT_REBASELINE_DAYS` (default 7, `0` disables);
- `AI_AUDIT_MAX_EXPORTS` (30) and `AI_AUDIT_MAX_AGE_DAYS` (90) for pre-chain exports;
- the empty-incremental skip and `lastHeartbeatAt`.

It adds only `maxChains`, a retention lock and the weekly scheduler. This is the one audit retention policy (C8).

### P0-17 Billing overview labels (UI)

**Evidence**
- `service-entry/billing.html:895` says "按「客户 × 管理器/模型 × 月」聚合" and `:1092` says "本期用量".
- The data is `/api/billing/usage?window=month&limit=100` (`:1344`): raw rows, where `normalizeUsage` (`:1553-1570`) defaults requests to "1" and `period` to `at`.

**Change**
- The heading becomes "最近请求（原始记录，最多 100 条）/ Recent requests (raw records, latest 100)".
- The columns become time / customer / manager / model / tokens / status. The period and requests columns are removed.
- The explanation now says that the aggregate view arrives with the telemetry store.
- No API change.

**Tests.** `tests/billing-page.spec.cjs:89,250` keeps its usage stubs and gains a heading assertion.

**Superseded by.** 04 TEL-14, which builds on this relabelled page, keeps it reachable at `/billing/classic`, and adds the summary endpoint. Then the 07 console.

### P0-18 Entry access-log noise (ENT)

**Evidence**
- `service-entry/server.js:1020-1022` logs every TTS proxy response on finish. The live entry access log is 99.8 % `GET /gateway/tts/api/jobs`, at about 48 lines a minute.
- The model gateway (`:1224-1226`) and aux (`:1454-1456`) log through `appendEntryGatewayAccessLog` (`:1678-1680`).

**Change.** The TTS proxy logs a request only when one of these holds:
- the method is not GET, HEAD or OPTIONS;
- the status is 400 or higher;
- the path matches `/gateway/tts/openai/v1/*` (billable synthesis).

Successful control and static GETs are skipped. Stats at `:1686-1724` are unaffected, because they are computed from the logged entries, which are the billable ones.

**Tests.** New `service-entry/test/access-log-filter.test.js` exercises the exported predicate `shouldLogTtsAccess(req, res)`.

**Superseded by.** 04-telemetry gateway recorder.

### P0-19 Access log on abort, requestId, vouched address (OBS + ENT)

**Evidence**
- `manager-core/gateway-utils.js:1621-1628` `attachServiceGatewayAccessLog` listens to `res.once("finish")` only, so client aborts during streaming never log.
- `:1587-1619` `buildServiceGatewayAccessLogEntry` uses `req.socket.remoteAddress`, which is the entry (127.0.0.1) for proxied traffic, and has no requestId.
- `access-log.js:28-56` `normalizeAccessEvent` drops `resolvedInstance`.

**Change (OBS)**
- New export `onResponseDone(res, callback)` calls `callback({ terminalState })` exactly once on `finish` (`completed`) or `close` before finish (`client_abort`).
- The entry builder adds `requestId` (from `x-request-id`, using the helpers at `:318-354`), `terminalState`, `status: 499` when no headers were sent, `socketAddress`, and `remoteAddress` set to the vouched origin from `resolveGatewayRequestOrigin` (`:1540-1557`) when the request came through the trusted entry, otherwise the socket address.
- `normalizeAccessEvent` keeps `requestId`, `terminalState` and `resolvedInstance`.

**Change (ENT).** The entry TTS, gateway and aux handlers use `onResponseDone`.

**Tests**
- `platform-improvements.test.js:305` (`resolvedInstance`) stays green.
- New `manager-core/test/access-log-terminal.test.js` checks that a fake res emitting `close` gives one entry with `client_abort`/499, and that finish then close gives one entry.
- The entry test checks that the abort path logs.

**Superseded by.** 04 TEL-2 starts from the landed `onResponseDone`, `requestId` propagation and vouched `remoteAddress`, and does not re-implement them. The TEL-5 recorder keys on requestId.

### P0-20 Trusted proxies and one forwarded-header list (ENT)

**Evidence**
- `service-entry/lib/security.js:142-153` `resolveClientAddress` takes the last `X-Forwarded-For` hop from **any** socket, so a LAN client can spoof its address for logs, rate limits and billing attribution.
- `:126-136` `PROXY_FORWARD_HEADERS` lacks `cf-connecting-ip`, `true-client-ip` and `x-forwarded-proto`, which `lib/billing-http.js:11-20` lists. A proxy that sends only `cf-connecting-ip` is therefore not demoted from management access (`checkManagementAccess` `:157-174`).

**Change**
- Env `SERVICE_ENTRY_TRUSTED_PROXIES` takes comma-separated IPs or CIDRs. The default is `127.0.0.1/32,::1/128,::ffff:127.0.0.1/128`.
- Forwarded client addresses are honoured only when the socket peer is trusted. Order: last XFF hop, then `x-real-ip`, then `cf-connecting-ip`, then `true-client-ip`. From an untrusted peer the socket address is used and the headers are ignored for identity.
- **Any** forwarded header still demotes management access, from any peer, as today.
- `security.js` exports `FORWARDED_HEADERS`, the union of both lists plus `x-service-entry-gateway`, and `isTrustedProxy(address)`. `billing-http.js` imports the list instead of its own copy.
- `trustHeaders` (`:328-333`) signs the resolved address as today.

**Tests**
- `service-entry/test/security.test.js:104-125` (demotion) and `:148-164` (loopback XFF vouching) stay.
- New `service-entry/test/trusted-proxy.test.js` covers:
  - a LAN peer with XFF resolves to the peer;
  - a loopback peer with XFF resolves to the hop;
  - `cf-connecting-ip` only → demoted;
  - CIDR parsing (IPv4, IPv6, mapped);
  - an invalid env entry is ignored with one warning.

**Superseded by.** 05-public. The PUBLIC/ADMIN listener split arrives there; the ADMIN listener ignores forwarded headers, and the env becomes an override of `public.trustedProxies` (contract change C4).

### P0-21 Manager CORS deny-by-default (OBS; UI copy)

**Evidence**
- `manager-core/service-policy.js:32-35` `normalizeCorsMode` falls back to `"open"`, and `:117-122` infers `open` when no origins are configured.
- `gateway-utils.js:1476-1508` `applyServiceCorsHeaders` in open mode reflects any `Origin`, sends `Access-Control-Allow-Credentials: true` and `Access-Control-Expose-Headers: *`, and grants Private Network Access on request. Any website can therefore drive a LAN manager from a visitor's browser.
- UI defaults are `"open"` (`vllm-manager/public/app.js:4364,4393`; `llama-manager/public/app.js:4010,4039`) with the label "全部开放（临时）" (`shared-public/js/ui-architecture.js:391-396`).
- Live settings are already `restricted`, so the live box is unaffected; fresh installs are not.

**Change**
- The default and fallback mode is `restricted`. With no configured origins, only same-origin requests (no `Origin` header, or `Origin` equal to the host) succeed.
- An explicit `open` is honoured only when `requireApiKey` is true. Otherwise it behaves as `restricted`, and `GET /api/service-exposure` returns `warnings: [{ code: "cors_open_requires_api_key", message }]`.
- Credentials are never allowed.
- `Access-Control-Expose-Headers` becomes the explicit list `x-request-id, x-local-ai-route, retry-after`.
- PNA is granted only when the new settings field `allowPrivateNetwork` (default false) is true **and** the origin is allowed.
- UI:
  - The option label becomes "任意来源（需 API Key）/ Any origin (API key required)". It is disabled unless "require API key" is checked.
  - The default is restricted.
  - A new checkbox reads "允许公网网页访问本机/局域网地址（Private Network Access）/ Allow public websites to reach this private address (Private Network Access)".

**Data migration.** `service-exposure-settings.json` gets the additive field `allowPrivateNetwork`. Records without `corsMode` now read as `restricted`.

**Tests.** `manager-core/test/core.test.js`:
- `:1020-1056` (open-mode preflight from `capacitor://localhost` expecting credentials + PNA) is rewritten: open + requireApiKey reflects the origin without credentials, and grants PNA only with `allowPrivateNetwork`.
- `:1855-1885` (normalization; llama default `open`) is changed to expect `restricted`.
- New cases cover open without a key → restricted plus warning, and the expose list.

**Superseded by.** 05-public, which keeps these semantics.

### P0-22 Console dark-mode hover contrast (UI)

**Evidence**
- `service-entry/index.html:8-42` defines light tokens, with dark tokens only under `@media (prefers-color-scheme: dark)`.
- `:138` sets `button:hover { background: var(--surface-3) }`.
- `shared-public/js/tokens.css` is loaded later (`:995`). Its `:root` light block overrides the inline dark values, because `<html>` has no `data-theme` and the tokens file's auto-dark only applies to `[data-theme="auto"]`. In dark OS mode, buttons hover to a light surface with light text.

**Change.** Set `<html lang="zh-CN" data-theme="auto">` so that the tokens.css auto-dark block wins. Remove the duplicated inline token values that conflict, and keep the inline-only tokens (`--surface-3`, `--primary-bg`) defined for both themes in tokens.css.

**Tests.** `tests/p0-ui.spec.cjs` uses `emulateMedia({ colorScheme: "dark" | "light" })`, hovers `#refreshBtn`, and asserts a computed contrast ratio of at least 4.5. The `data-theme` pins in `tests/billing-page.spec.cjs` stay.

**Superseded by.** The 07-console design system.

### P0-23 Health remediation actions (RT + UI)

**Evidence**
- `manager-core/health.js:66-68` `healthCheck(id, label, status, detail, actions = [])`.
- The servers attach actions `["start-docker"]` (vLLM `server.js:1572`, llama `:1571`) and `["pull-image"]` (`:1575`, `:1583`). `shared-public/js/tool-panel-renderer.js:35-60` renders only label and detail.
- `POST /api/docker/start` exists (`runtime-routes.js:52-55`). There is no pull-image endpoint.

**Change**
- RT: `/api/tools/health` checks gain an additive `actionDetails` array, while the string `actions` array stays as it is (must-keep):
  - `{ id: "start-docker", kind: "api", method: "POST", path: "/api/docker/start", label: { zh: "启动 Docker", en: "Start Docker" } }`
  - `{ id: "pull-image", kind: "command", command: "docker pull <image>", label: { zh: "复制拉取命令", en: "Copy pull command" } }`
  - `{ id: "install-download-cli", kind: "command", command: "install-download-cli.cmd", label: { zh: "安装下载工具：运行 install-download-cli.cmd", en: "Install the download tool: run install-download-cli.cmd" } }`, on the `hf-cli` check (`:1587`).
- `commandHealth` (`:81-93`) accepts `actionDetails`.
- UI: the renderer shows buttons only for `kind:"api"` actions whose `method + path` is in the allowlist `POST /api/docker/start`. `kind:"command"` actions get a copy-to-clipboard button. Unknown kinds are ignored.

**Tests**
- New `manager-core/test/health-actions.test.js` checks the shapes.
- `tests/p0-ui.spec.cjs` checks that a disallowed path renders no button and that a command action renders a copy button.

**Superseded by.** 06-ops doctor and 07-console.

### P0-24 Start and stop scripts (OPS)

This fix absorbs 06 OPS-0, which is deleted. OPS-0's unique items, `stop_workers.ps1` and TTS `-GatewayOnly` with `TTS_START_WORKERS`, are folded in here.

**Evidence**
- `llama-manager/start-manager.cmd` starts with a UTF-8 BOM. It is the only tracked `.cmd` file with one, and `cmd.exe` mis-parses its first line.
- Both manager scripts hard-code `URL`, `PORT` and `*_MANAGER_PORT` (`:6-9`). Their message tells the user to edit the port. `:31-32` `Remove-Item` the logs.
- `start-platform.cmd:27-28` calls `start-tts-platform.cmd` with no arguments. `tts-platform/scripts/start_all.ps1:3-6,45-50` therefore starts all four TTS workers and opens a browser, although it already supports `-GatewayOnly` and `-NoBrowser`. `:45-48` runs one `docker info` check with no wait. `:57-60` probes all six ports even for the core profile. There is no pause when the script is double-clicked.
- `stop-platform.cmd all` stops only the TTS gateway (`stop_gateway.ps1`). Worker PIDs written by `start_all.ps1:40` to `tts-platform\.runtime\start_<x>.pid` are never stopped.
- `start-service-entry.cmd` checks readiness through the heavy `/api/status`, opens the browser even on failure, and does not propagate the PowerShell exit code.
- `stop-service-entry.cmd` only POSTs `/api/manager/shutdown`, with no fallback.

**Change**
- Remove the BOM.
- Manager scripts honour existing `VLLM_MANAGER_PORT` / `LLAMA_MANAGER_PORT` (set only when undefined) and derive the URL from them. They rotate logs to `.1`–`.3` (the `Rotate-Log` routine of `start-service-entry.cmd:22`) instead of deleting them.
- `start-platform.cmd`:
  - calls TTS with `-GatewayOnly -NoBrowser`. With `TTS_START_WORKERS=1` it passes only `-NoBrowser`, so the workers start too;
  - waits for Docker before the search gateway. When `docker info` fails and a `Docker Desktop.exe` process is running, it polls every 3 s for up to `PLATFORM_DOCKER_WAIT_SECONDS` (default 90; 06 may later set 120 through `platform.json`). Otherwise it prints the existing hint at once;
  - probes only the ports of the selected profile (core: 5176-5178);
  - prints a per-component summary (`OK` / `FAILED` / `SKIPPED`);
  - pauses only when launched by double-click (`%CMDCMDLINE%` contains `/c`), unless `PLATFORM_NO_PAUSE=1`.
- `start-service-entry.cmd`:
  - runs a Node version preflight (`^22.22.2 || ^24.15.0 || >=26`);
  - checks readiness via `GET /gateway/health`;
  - exits 1 and opens no browser on failure.
- `stop-service-entry.cmd`: after the shutdown POST and a 10 s timeout, it force-stops the PID from the entry PID file, but only if CIM shows that process is `node` with `server.js` in its command line. Otherwise it reports and exits 1.
- New `tts-platform/scripts/stop_workers.ps1 [-CheckOnly] [-StateRoot <dir>]` (default `tts-platform\.runtime`):
  - for each `start_*.pid` except `start_gateway.pid`, it verifies with CIM that the process is `pwsh` with `-File` and the matching `start_<x>.ps1` in its command line;
  - then it runs `taskkill /PID <pid> /T /F` and removes the pid file;
  - a stale pid file (no process) is removed. A mismatched identity is reported and left alone;
  - `-CheckOnly` reports and changes nothing.
  - `stop-platform.cmd all` calls it after `stop_gateway.ps1`. It is CRLF without a BOM and is added to the `test-all.cmd` `checkps1` list.
- New `scripts/check-script-encoding.js` fails on a BOM or LF-only endings in tracked `*.cmd`/`*.ps1`, using an allowlist for the existing TTS `.ps1` BOMs (for example `start_all.ps1`). It is wired into `test-all.cmd`. There is no separate `check-cmd-hygiene.js`; 06 OPS-2 later folds this script into its hygiene test.

**Tests.** `node scripts/check-script-encoding.js` runs inside `test-all.cmd`. Script behaviour is verified manually in the worktree, with ports and `-StateRoot` overridden so that live services are never touched. The steps are in the package acceptance.

**Superseded by.** 06-ops. The scripts become `platform` CLI shims that keep these behaviours, `PLATFORM_DOCKER_WAIT_SECONDS` included.

### P0-25 README drift (OPS)

**Evidence**
- `README.md:65,392` say "MCP 0.5.0 … 16 tools", but `platform-mcp/package.json` is 0.6.0.
- `:70,325` say "Node 22.22.2 or newer", but jsdom requires `^22.22.2 || ^24.15.0 || >=26`.
- The quick start (`:77-88,337-339`) includes `test-all.cmd` and omits `install-download-cli.cmd`.
- `:158,415` claim that local mode listens on 127.0.0.1, but the managers bind 0.0.0.0 guarded by `*_ALLOW_REMOTE=0`.
- `service-entry/package.json` engines is `>=22.5.0`, while `node:sqlite` needs ≥ 22.13.

**Change**
- Correct each statement.
- Move `test-all.cmd` to the developer section and add `install-download-cli.cmd` to the quick start.
- The MCP version reads "see platform-mcp/package.json"; tool counts are removed.
- Add a short note about `scripts/scrub-job-ledgers.js` and key rotation. No new linked document, so the release link check is unaffected.
- Set `service-entry/package.json` engines to `^22.22.2 || ^24.15.0 || >=26`.

**Tests.** The release build's README link check. `test-all.cmd` is unchanged apart from P0-24.

**Superseded by.** 06-ops and P8 docs.

### P0-26 Gateway error leakage (ENT)

**Evidence**
- `service-entry/lib/security.js:255-260` `key_store_unreadable` puts absolute key-store paths in the response.
- `:278` tells the caller to set `SERVICE_ENTRY_REQUIRE_API_KEY=0`.
- `server.js:1183-1184` returns "<manager> is not listening on port 5177". `:952` (TTS) and `:1422` (aux) return ports.
- `server.js:428` prints the startup hint with `console.warn`, which goes to stderr and is classified as an error by log tooling.

**Change**
- Responses on `/gateway/*` use generic messages:
  - `key_store_unreadable` → "服务暂时不可用 / Service temporarily unavailable", code unchanged, HTTP 503;
  - no env hint;
  - upstream down → "上游服务未运行 / Upstream service is not running", code `service_unavailable`.
- Details go to the server log, through the redactor.
- `/api/status` admin texts (`:589,655`) are unchanged.
- The startup hint uses `console.log`.

**Tests.** `service-entry/test/security.test.js:278,439` assert codes, which are unchanged. They gain assertions that the message contains no `:\`, no `/` path and no `5177`. A new server test checks the upstream-down body.

**Superseded by.** 05-public public-api error mapping (OpenAI shape, `request_id`).

---

## 5. Data and persisted-format changes

| File | Change | Compatibility |
|---|---|---|
| `jobs-ledger.json` (both managers) | Secrets redacted on load and at write; download job `meta.transfer`, `meta.errorCode`, `meta.errorRetryable`, `meta.errorHint`; serve job `meta.admission` (P0-2) | Additive. Old readers ignore the new fields. Redaction is in place and idempotent. |
| `recent-launches.json` | Entry-level `containerName`, `instanceMode`, `instanceId` | Additive. `config` shape unchanged. |
| idle-unload sleeping ledger | Record `placement`, `secretRef` (store ref id only), `hasApiKey` | Additive. Legacy records are treated as replace placement. |
| runtime secret store (`<manager>/logs/runtime-api-keys.json`) | Extra entries for sleeping instances, created by `set()` with the existing UUID refs | Same file, shape and ACL; no API change. Released on wake or forget. 06 OPS-3 migrates the file into `secret-store.js` once. |
| `service-exposure-settings.json` | `allowPrivateNetwork` (default false); missing `corsMode` reads as `restricted` | Additive. The live box already stores `restricted`. |
| audit export cursor | `lastHeartbeatAt` | Additive. |
| GPU admission leases | Lease `verdict`, `clamped`, `warning`; `reservations[].estimateMb` | Additive. `reservations[].requestedMb` keeps its meaning (the reserved MiB). Leases from old code are still released normally and read as `verdict:"ok"`. |
| stored `launchCommand` and API redaction | Marker `***` becomes `<redacted>` for new entries | Display-only text. Old entries keep `***`, and no parser reads it. |

There is no schema-version bump and no backfill job.

---

## 6. Test plan summary

- **Unit (node:test).** These are the new files named per fix above. Every package's `npm test` picks them up through `test/*.test.js`.
- **Fixtures.** Rule 1.8 applies to every P0 test. Each package's acceptance includes `git ls-files --error-unmatch` for any checked-in fixture it references, and `git status --porcelain --ignored` over the touched `test/` directories showing nothing new.
- **Golden.** P0 creates no golden files and no golden directory. P0-4 deliberately changes the vLLM and llama argv (no `--api-key`, name-only `-e` for secrets). 01 ENG-1 therefore captures the engine goldens once, from the post-P0 merge head, into `manager-core/test/fixtures/engines/goldens/` (C3). P0's own coverage is an inline full-argv assertion in `vllm-manager/test/runtime-command.test.js` for one vLLM profile without a key and with a key, where the key value is absent.
- **Playwright.** The new `tests/p0-ui.spec.cjs` is added to the root `package.json` `test:frontend-smoke`. It reuses the `startManager` harness from `tests/frontend-smoke.spec.cjs` (`AI_FRONTEND_SMOKE=1`) and the route-stubbing pattern of `tests/billing-page.spec.cjs`. It covers theme contrast (P0-22), health action buttons (P0-23), the mirror probe and vLLM priority (P0-13), the download failure card (P0-8), wake confirm (P0-1), the billing heading (P0-17), the per-instance "Logs" link (P0-3), the speed label by source (P0-7) and the CORS option gating (P0-21).
- **Portability.** The P0-RT-2 wake tests and the P0-RT-3 admission tests assert only through public hooks, routes and pure exports. 01 ENG-8 and ENG-12 run them unchanged.
- **Existing tests changed in place.** Everything not listed here must pass unmodified, and every package's existing suite stays green.

| Test | Change |
|---|---|
| `vllm-manager/test/runtime-command.test.js:109,119` | Flip `--api-key` presence to env assertions; the `***` check becomes `<redacted>` on an SGLang argv (P0-4) |
| `llama-manager/test/runtime-command.test.js` (api-key assertions, `:151`) | Same as above |
| `manager-core/test/runtime-secret-store.test.js:63` | `HF_TOKEN=***` → `HF_TOKEN=<redacted>` (section 3) |
| `vllm-manager/test/core.test.js:575-618` | Sticky SGLang gauge test rewritten to the P0-7 order |
| `manager-core/test/core.test.js:1020-1056, 1855-1885` | CORS expectations (P0-21) |
| `manager-core/test/security-hardening.test.js:276-345` | Retention under chain rules (P0-16) |
| `manager-core/test/idle-unload.test.js` | Extended mocks (P0-1) |
| `manager-core/test/download-precheck.test.js:78` | Message assertions added (P0-14) |
| Must stay green unmodified | `core.test.js:438-457` (aggregated source), `:492` (rates), `:3690-3729` and `:4412+` (downloads); `platform-improvements.test.js:305,415-470`; `pennyroyal.test.js` (all, including `:16` and `:64`); `vllm core.test.js:663-664`; `launch-request.test.js:172-173`; `llama core.test.js:382`; `service-entry security.test.js:104-164` |

- **i18n.** Every new zh string has an en entry in `i18n-common.js`, and `scripts/check-i18n.js` passes. The English audit exemptions (`code`, `pre`, `.logs-box`, `[data-no-i18n]`) are not used to hide new copy.

---

## 7. Batches, file ownership and merge order

Each batch is one worktree and one branch, `feature/platform-overhaul-20261014-p0-<batch>`, cut from the integration branch. File sets are disjoint. A file not listed for a batch must not be edited by it. Packages inside a batch run serially in that worktree.

| Batch | Branch | Owns (edits or creates) |
|---|---|---|
| **OPS** | `-p0-ops` | `start-platform.cmd`, `stop-platform.cmd`, `start-service-entry.cmd`, `stop-service-entry.cmd`, `vllm-manager/start-manager.cmd`, `llama-manager/start-manager.cmd`, `test-all.cmd`, `scripts/check-script-encoding.js` (new), `tts-platform/scripts/stop_workers.ps1` (new), `README.md`, `service-entry/package.json` |
| **OBS** | `-p0-obs` | `manager-core/{secret-redactor.js (new), ledger-scrub.js (new), job-utils.js, jobs-ledger-store.js, runtime-routes.js, index.js, gateway-utils.js, access-log.js, service-policy.js, stats-utils.js, audit-store.js, audit-routes.js, openwebui-audit-exporter.js}`, `scripts/scrub-job-ledgers.js` (new), `manager-core/test/{core.test.js, security-hardening.test.js}`, new `manager-core/test/{secret-redactor, jobs-ledger-redaction, ledger-scrub, recent-rates, access-log-terminal, audit-retention}.test.js` |
| **DL** | `-p0-dl` | `manager-core/model-hub/errors.js` (new), `manager-core/{download-utils.js, download-job-controller.js, mirror-probe.js, model-filesystem-store.js, download-resume-check.js, download-precheck.js}`, `manager-core/test/{download-precheck, download-sources, download-stall}.test.js`, new `manager-core/test/{download-errors, download-transfer, disk-usage-roots}.test.js` |
| **ENT** | `-p0-ent` | `service-entry/lib/security.js`, `service-entry/lib/billing-http.js`, `service-entry/server.js`, `service-entry/test/*` |
| **RT** | `-p0-rt` | `vllm-manager/server.js`, `llama-manager/server.js`, `vllm-manager/lib/{launch-request,runtime-command,memory-estimate}.js`, `llama-manager/lib/{launch-request,runtime-command}.js`, `manager-core/{idle-unload, gpu-admission, runtime-request-utils, docker-runtime, health, manager-routes}.js`, `vllm-manager/test/*`, `llama-manager/test/*` (except the two UI-owned files), `manager-core/test/{idle-unload, gpu-admission, runtime-secret-store}.test.js`, new `manager-core/test/{docker-runtime-env, health-actions, runtime-request-utils}.test.js` |
| **UI** | `-p0-ui` | `service-entry/index.html`, `service-entry/billing.html`, `shared-public/js/{tool-panel-renderer, job-renderer, stats-summary-renderer, runtime-instances, ui-architecture, idle-unload-renderer, i18n-common, service-exposure-renderer}.js`, `vllm-manager/public/{app.js, index.html}`, `llama-manager/public/{app.js, index.html, js/catalog.js, js/gguf-model-ui.js}`, `llama-manager/test/gguf-model-ui.test.js`, `llama-manager/test/catalog-presets.test.js` (new), `tests/p0-ui.spec.cjs` (new), `tests/billing-page.spec.cjs`, root `package.json` |

Nobody edits `manager-core/test/platform-improvements.test.js`. Its assertions are compatibility gates for OBS and DL. No P0 batch edits `manager-core/runtime-secret-store.js`, `.gitignore` or `build-github-release.ps1`. The llama `launch-request.js` admission (`gguf-estimate`) is not touched; that file changes only for the P0-15 log line.

**Merge order: OPS → OBS → DL → ENT → RT → UI.**
- OPS, OBS, DL and ENT have no cross-dependencies on content and can be developed in parallel from the integration branch.
- ENT's P0-19 part uses OBS's `onResponseDone`, so ENT merges after OBS. ENT-2 can be developed against the merged OBS, or rebased onto it.
- RT wires the OBS redactor (P0-5) and the DL transfer, secret and roots options (P0-9, P0-11), so it is cut, or rebased, after OBS and DL merge.
- UI consumes fields from RT, DL and OBS (`actionDetails`, `errorCode`/`errorHint`, `roots[]`, `windowSeconds`, `outputSource`, the wake 409, `allowPrivateNetwork`). It can be built in parallel against stubs and merges last.
- The UI merge is the **post-P0 merge head**. 01 ENG-1 captures goldens there, and P1 branches are cut from it.

After each merge, run `test-all.cmd` on the integration branch and record the exact pass and fail counts in the merge commit body.

---

## 8. Owner-only actions (not done by any workstream)

- **A1. Rotate exposed runtime keys.** Six plaintext occurrences are in the live vLLM job ledger. Copies of that ledger and of `runtime-api-keys.json` are in the private-ACL `<AI_ROOT>/backups/*` for up to 14 days.
  - Restart the affected models with new keys, then update clients.
  - After deploy, run `node scripts/scrub-job-ledgers.js` (dry run), then `--apply` with the managers stopped, if redact-on-load has not already cleaned the files. The tool never touches the key store.
  - Old snapshots may be deleted whole once the keys are rotated. Partial edits would break their manifests.
- **A2. Remove legacy public-proxy leftovers from the live root.** These are untracked: `manager-public-proxy.js`, `public-port-proxy.js`, `upnp-port-map.js`, and the `start/stop-manager-public-proxy.cmd` pair in the vLLM manager folder. Also move router HTML snapshots out of the tree.
- **A3. Review Windows firewall rules** for 5177/5178 given the 0.0.0.0 bind (P0-25 corrects the docs only).
- **A4. Deploy.** Use `deploy-worktree.ps1` from the integration branch. A deploy restarts managers, which interrupts downloads, so pick an idle window.

---

## 9. Contract changes requested

These are listed for 00. They are not applied here.

- **C1. 00 §4.3 `memory.policy` enum and admission fields.**
  - Add `static-fraction-of-free` to the enum. It means a fraction of the device memory free at engine start that covers weights plus KV (SGLang `mem-fraction-static`). It is distinct from `device-fraction` (vLLM) and from `free-fraction-after-weights` (TensorRT-LLM, LMDeploy). There is no `free-fraction` value.
  - Allow `admission.verdict:"warn"` with `admission.clamped`, `admission.requestedMb` and `admission.reservedMb`.
  - Add the P0-2 gpu-admission fields to the 00 §6 must-keep list **verbatim**: request `requestedFractionOfFree`, `poolCappedTokens`, `minClampMb`, `estimatePolicy:"sglang_mem_fraction_static_of_free"`; decision `requestedMb`, `availableMb`, `reservedMb`, `clamped`, `verdict`; 409 details `mode`, `maxFraction`; lease `verdict`, `clamped`, `warning`, `reservations[].estimateMb`; `job.meta.admission`.
  - Ownership: P0-RT-3 is the only P0 change to `gpu-admission.js` and `memory-estimate.js`. 01 ENG-12 moves it behind `memoryModel` without renaming anything; `requestedMbCeiling`, `requestedMbFloor` and `sglang_bounded_up_to_budget` exist at most as derived read-only fields. 02 MOD-9 supplies inputs through `engines.memoryModels.estimate` and is not a second estimator. Order: P0-RT-3 → ENG-12 → MOD-9 admission wiring.
- **C2. 00 §6 must-keep additive fields.** Record the API fields P0 introduces, so that later specs can add next to them but never rename them:
  - `GET /api/logs?instance=`;
  - the wake body `{confirmReplace}` and 409 `wake_would_replace_running` / `wake_api_key_missing`;
  - `/api/tools/health` `actionDetails`;
  - download job `meta.transfer` / `meta.errorCode` / `meta.errorRetryable` / `meta.errorHint`;
  - `/api/models/disk-usage` `roots[]` and `models[].rootId` (no `volumes[]`);
  - `/api/service-exposure` `allowPrivateNetwork` and `warnings`;
  - `/api/stats` `speed.windowSeconds`, and per-model `speed.outputSource ∈ {counter_window, sglang_gen_throughput_gauge}` with the gauge fallback of P0-7 (aggregate also `mixed`/`unavailable`);
  - `/api/memory-estimate` `plan.policy` and `plan.admissionPreview`.
- **C3. 00 §6 golden rule.** "Validated recipes must render byte-identical argv" is satisfied against baselines captured **once, from the post-P0 merge head** (section 7), into `manager-core/test/fixtures/engines/goldens/` by 01 ENG-1. P0 creates no golden files. P0-4 intentionally removes `--api-key <value>` and `HF_TOKEN=<value>` from vLLM and llama argv, which D10 requires. SGLang/Pennyroyal argv is unchanged. Add the fixture rule 1.8 to 00 §7: no fixture under an ignored name; use the `.fixture` suffix.
- **C4. 05-public.** Adopt `SERVICE_ENTRY_TRUSTED_PROXIES` as the env override of `public.trustedProxies` in `<AI_ROOT>/config/platform.json` (env > file > default, D9).
- **C5. 03-hub download-error vocabulary.**
  - `manager-core/model-hub/errors.js` is created by P0-DL-1 with `classifyDownloadFailure` and the 14 codes of P0-8. 03 extends it and does not redefine it.
  - `data/hub-transfer-errors.json` stays keyed by these names and may add only derived codes, each with a `baseCode`: `network_timeout → network_unreachable`, `hf_login_required → hf_auth_invalid`, `transfer_empty → filter_no_match`. The retry policy and UI key on `baseCode`.
  - Hub job ledgers keep `errorCode`/`errorHint`. 03 HUB-P0a–e are replaced by P0-DL-1/2/3, P0-RT-6 and P0-UI-3, and HUB-1/HUB-5 depend on P0-DL-1.
- **C6. 00 §1 secret policy.**
  - There is one secret store: 06 OPS-3 `manager-core/secret-store.js` at `<AI_ROOT>/.runtime/secrets/`, DPAPI CurrentUser through a PowerShell `ProtectedData` child process, owner-only ACL, excluded from release and backup. If DPAPI is unavailable it falls back to ACL-only, and doctor warns.
  - `runtime-secret-store.js` becomes a facade over it and migrates the old file once.
  - P0 conforms: the wake refs use the facade, HF tokens are memory-only (namespace `hf` only on an explicit "remember"), and the scrub tool skips secret stores.
- **C7. One redactor.** `manager-core/secret-redactor.js` and the marker `<redacted>` are platform-wide, and 00's hard rule should name them. `scripts/scrub-job-ledgers.js` belongs to P0-OBS-2: dry run by default, `--apply` to write, no `--write`.
- **C8. One audit retention policy.** 00 records it: P0-16 chain-aware retention with `AI_AUDIT_REBASELINE_DAYS` (7), `AI_AUDIT_MAX_EXPORTS` (30) and `AI_AUDIT_MAX_AGE_DAYS` (90), plus 04 TEL-15's `maxChains`, lock and weekly scheduler as additions.

---

## 10. Open decisions for the owner

- **O1. SGLang API key.** Keep `--api-key` in argv (current, redacted in logs, visible in the host process list while docker starts), or wrap the SGLang command in `sh -c` with an env reference? The wrapper changes the Pennyroyal golden. Default: keep, and revisit in 01.
- **O2. SGLang admission for capped pools.** Clamp-and-warn (default), or strict reject until 01 ENG-12 provides a weights + KV estimate? Either way the field names of C1 stay.
- **O3. Key rotation** (A1). Rotate all keys that were ever in the ledger, or only those still in use? Default: all.
- **O4. Waking into a busy primary slot.** Confirm-and-replace (default), or always refuse and require a manual stop?
- **O5. CORS `open` mode.** Keep it as "any origin with API key" (default), or remove it entirely in favour of explicit origin lists?
- **O6. Trusted proxy default.** Loopback only (default), or also the Docker Desktop gateway range if cloudflared runs in a container?
- **O7. TTS access-log scope.** Billable and error requests only (default), or also a 1-in-N sample of control polls?
- **O8. Audit exports.** Rebaseline every 7 days and skip empty incrementals (defaults)?
- **O9. Live-root cleanup** (A2/A3). Timing and whether to keep the router snapshots elsewhere.
- **O10. llama presets.** Official publisher GGUF repos only, or allow community quantizers (unsloth, bartowski) where no official GGUF exists (default)?

---

## 11. Work packages

Sizes: S is under half a day, M is about a day, and L is one full agent session. `depends_on` lists only P0 package ids (00 defines none). Every package ends with green `npm test` in each touched package. Each batch's last package also runs the full `test-all.cmd`. Every package's acceptance includes rule 1.8: no checked-in fixture under an ignored name, and every referenced fixture is tracked.

### OPS batch

**P0-OPS-1 — Manager and entry scripts; encoding check** (M)
- Files: `start-service-entry.cmd`, `stop-service-entry.cmd`, `vllm-manager/start-manager.cmd`, `llama-manager/start-manager.cmd`, `test-all.cmd`, `scripts/check-script-encoding.js` (new).
- depends_on: none.
- Acceptance:
  - No tracked `.cmd` has a BOM, and every one is CRLF. `check-script-encoding.js` exits 1 on a planted BOM in a temp dir and 0 on the tree, where the existing TTS `.ps1` BOMs are allowlisted. `test-all.cmd` runs it. No `check-cmd-hygiene.js` exists.
  - With `LLAMA_MANAGER_PORT=15178` the llama script targets 15178. Old logs survive as `.1`.
  - `start-service-entry.cmd` exits 1 and opens no browser when `/gateway/health` fails; this is tested with a port override in the worktree.
  - `stop-service-entry.cmd` never kills a PID whose command line lacks `server.js`.

**P0-OPS-3 — Platform launcher, TTS workers, Docker wait (folds 06 OPS-0)** (M)
- Files: `start-platform.cmd`, `stop-platform.cmd`, `tts-platform/scripts/stop_workers.ps1` (new), `test-all.cmd` (one `checkps1` line).
- depends_on: P0-OPS-1 (`test-all.cmd`, serial).
- Acceptance:
  - `start-platform.cmd all` calls `start-tts-platform.cmd -GatewayOnly -NoBrowser`. With `TTS_START_WORKERS=1` it passes only `-NoBrowser`. Both call lines are asserted with `findstr`. `start-platform.cmd` is never run from the worktree on default ports, because `all` would touch the live services, MCP and search containers. Its branches are reviewed, not executed.
  - By review: with Docker Desktop not running, the search-gateway step reports the hint immediately. With the `Docker Desktop.exe` process present and `docker info` failing, it waits at most `PLATFORM_DOCKER_WAIT_SECONDS` (default 90), polling every 3 s.
  - The core summary lists only 5176-5178. The script prints `OK`/`FAILED`/`SKIPPED` per component and does not pause when run from an open console.
  - `stop_workers.ps1 -StateRoot <tmp>` with a pid file holding the current shell's PID reports an identity mismatch and stops nothing, while a pid file for a dead PID is removed. With `-CheckOnly`, both files are left untouched. `stop-platform.cmd all` calls the script after `stop_gateway.ps1`.
  - The new `.ps1` is CRLF without a BOM and passes `checkps1` and `check-script-encoding.js`.

**P0-OPS-2 — README and engines range** (S)
- Files: `README.md`, `service-entry/package.json`.
- depends_on: P0-OPS-1, P0-OPS-3 (documents its env vars).
- Acceptance:
  - The README states the Node range `^22.22.2 || ^24.15.0 || >=26` in both languages, the corrected loopback text, and the MCP version reference without tool counts.
  - The quick start includes `install-download-cli.cmd`, and `test-all.cmd` is under the developer section.
  - The README notes `TTS_START_WORKERS` and `PLATFORM_DOCKER_WAIT_SECONDS`.
  - `build-github-release.ps1` README link check passes in dry-run mode.
  - The engines field is updated.

### OBS batch

**P0-OBS-1 — Secret redactor and ledger redaction** (M)
- Files: `manager-core/secret-redactor.js` (new), `job-utils.js`, `jobs-ledger-store.js`, `runtime-routes.js`, `index.js`, tests `secret-redactor.test.js` and `jobs-ledger-redaction.test.js`.
- depends_on: none.
- Acceptance:
  - All six pattern cases pass, plus the exact-secret case and the non-secret words that must stay.
  - `patterns:false` and `minSecretLength` behave as in section 3. The only marker produced is `<redacted>`.
  - `appendLog`/`failJob` never store a fixture key.
  - Loading a temp-dir ledger with keys rewrites it once (dirty flag), and the second load is a no-op.
  - `/api/logs` output is redacted.
  - The barrel exports the new functions without collision warnings.

**P0-OBS-2 — Ledger scrub tool** (S)
- Files: `manager-core/ledger-scrub.js` (new), `scripts/scrub-job-ledgers.js` (new), `manager-core/test/ledger-scrub.test.js`.
- depends_on: P0-OBS-1.
- Acceptance:
  - A dry run is the default. It reports counts and relative names only (asserted: no fixture key and no absolute path in stdout) and exits 2 when matches exist.
  - `--apply` rewrites atomically and refuses when the stub port probe is open, unless `--force`. There is no `--write` flag; an unknown flag exits 1.
  - A `runtime-api-keys.json` (by name) and any `{version, secrets}`-shaped file (by shape) are reported as skipped and stay byte-identical after `--apply`.
  - Backup directories are reported and never written.

**P0-OBS-3 — Access log terminal state, requestId, vouched address** (M)
- Files: `manager-core/gateway-utils.js`, `manager-core/access-log.js`, `manager-core/test/access-log-terminal.test.js`.
- depends_on: none.
- Acceptance:
  - `onResponseDone` fires exactly once for finish, for close-before-finish (499, `client_abort`) and for finish-then-close.
  - Entries carry `requestId`, `terminalState` and `socketAddress`.
  - `normalizeAccessEvent` keeps `resolvedInstance`.
  - `platform-improvements.test.js:305` passes unmodified.

**P0-OBS-4 — CORS deny-by-default** (M)
- Files: `manager-core/service-policy.js`, `manager-core/gateway-utils.js`, `manager-core/test/core.test.js`.
- depends_on: P0-OBS-3 (same file `gateway-utils.js`, serial).
- Acceptance:
  - The default and fallback mode is `restricted`.
  - `open` without `requireApiKey` behaves as restricted and yields a `cors_open_requires_api_key` warning.
  - No response ever carries `Access-Control-Allow-Credentials`.
  - The expose list is explicit.
  - PNA appears only with `allowPrivateNetwork:true` and an allowed origin.
  - The rewritten `core.test.js:1020-1056, 1855-1885` cases pass.

**P0-OBS-5 — Recent-rate window** (S)
- Files: `manager-core/stats-utils.js`, `manager-core/test/recent-rates.test.js`.
- depends_on: none.
- Acceptance:
  - `core.test.js:492-509` and `:438-457` pass unmodified.
  - A caller passing `updateSamples=false` gets non-zero rates after 10 s of samples.
  - The output includes `windowSeconds`.
  - A counter reset returns zeros and restarts.
  - The buffer is bounded at 40 samples or 150 s.

**P0-OBS-6 — Audit retention, cursor and stream errors** (M)
- Files: `manager-core/audit-store.js`, `manager-core/audit-routes.js`, `manager-core/openwebui-audit-exporter.js`, `manager-core/test/security-hardening.test.js`, `manager-core/test/audit-retention.test.js` (new).
- depends_on: none.
- Acceptance:
  - Pruning never removes the newest full export or any newer export.
  - Empty incrementals are not written, and the cursor records `lastHeartbeatAt`.
  - Rebaseline triggers after `AI_AUDIT_REBASELINE_DAYS` (default 7, `0` disables). `AI_AUDIT_MAX_EXPORTS`/`AI_AUDIT_MAX_AGE_DAYS` keep their names.
  - The exporter cursor equals the max `updated_at` of the fetched rows.
  - A missing export file returns 404 JSON and the process does not throw.
  - Export trees are built under `os.tmpdir()` (rule 1.8).

### DL batch

**P0-DL-1 — Download error taxonomy and retry policy** (M)
- Files: `manager-core/model-hub/errors.js` (new), `manager-core/download-job-controller.js`, `manager-core/test/download-errors.test.js` (new).
- depends_on: none.
- Acceptance:
  - Each code in the table is produced by its inline corpus line. `DOWNLOAD_ERROR_CODES` equals the 14 table codes in order, and every result has `baseCode === code`.
  - Precedence holds: a 403 text that mentions a connection error classifies as approval.
  - Non-retryable codes are not auto-retried and log the bilingual line. `rate_limited` waits at least 120 s.
  - `job.error` becomes the bilingual title, and the raw text stays in the logs.
  - `platform-improvements.test.js:415-462` and `core.test.js:4412+` pass unmodified.

**P0-DL-2 — Transfer settings persistence and mirror token isolation** (M)
- Files: `manager-core/download-utils.js`, `manager-core/download-job-controller.js`, `manager-core/mirror-probe.js`, `manager-core/test/download-transfer.test.js` (new), `manager-core/test/download-sources.test.js`.
- depends_on: P0-DL-1.
- Acceptance:
  - A resumed job reuses its `meta.transfer`.
  - The token is resolved only via `resolveDownloadSecret`. A missing token fails with `hf_token_expired`.
  - No token appears in job meta, the ledger JSON or any file the test tree contains.
  - Mirror env has no `HF_TOKEN`/`HUGGING_FACE_HUB_TOKEN` and has `HF_HUB_DISABLE_IMPLICIT_TOKEN=1`.
  - The mirror probe sends no `Authorization` to hf-mirror.
  - `core.test.js:3690-3729` and `platform-improvements.test.js:462-470` pass unmodified.

**P0-DL-3 — Root-aware disk usage and resume disk check; precheck copy** (M)
- Files: `manager-core/model-filesystem-store.js`, `manager-core/download-resume-check.js`, `manager-core/download-precheck.js`, `manager-core/test/disk-usage-roots.test.js` (new), `manager-core/test/download-precheck.test.js`, `manager-core/test/download-stall.test.js` (only if a fixture needs `roots`).
- depends_on: none.
- Acceptance:
  - `getDiskUsage` with two temp roots returns `roots[]` (default first) and `models[].rootId`, and keeps the legacy top-level fields equal to the default root's values. The roots are temp dirs whose names avoid `models/` (rule 1.8).
  - `inspectDownloadResume` without `diskFreeBytes` measures the job directory.
  - Precheck copy matches the P0-14 strings, and finding codes are unchanged.

### ENT batch

**P0-ENT-1 — Trusted proxies and unified forwarded headers** (M)
- Files: `service-entry/lib/security.js`, `service-entry/lib/billing-http.js`, `service-entry/test/security.test.js`, `service-entry/test/trusted-proxy.test.js` (new).
- depends_on: none.
- Acceptance:
  - A LAN peer's XFF is ignored for identity.
  - A loopback peer's XFF is honoured.
  - A `cf-connecting-ip`-only request is demoted from management.
  - `billing-http.js` uses the exported list.
  - The existing `security.test.js:104-164` cases pass.

**P0-ENT-2 — Entry access-log filter and abort logging** (S)
- Files: `service-entry/server.js`, `service-entry/test/access-log-filter.test.js` (new).
- depends_on: P0-OBS-3.
- Acceptance:
  - A successful TTS `GET /gateway/tts/api/jobs` is not logged. TTS POST, errors and `/gateway/tts/openai/v1/*` are logged.
  - Aborted gateway requests produce one entry with `client_abort`.

**P0-ENT-3 — Generic public errors and stdout hint** (S)
- Files: `service-entry/lib/security.js`, `service-entry/server.js`, `service-entry/test/security.test.js`.
- depends_on: P0-ENT-1, P0-ENT-2 (same files, serial).
- Acceptance:
  - `/gateway/*` error bodies contain no filesystem path, port number or env-var name (regex-asserted), and the codes are unchanged.
  - The details appear in the server log redacted.
  - The startup `HINT` goes to stdout, and the `WARNING` stays on stderr.

### RT batch

**P0-RT-1 — Secrets via env in docker run; redactor wiring; marker convergence** (L)
- Files: `vllm-manager/lib/runtime-command.js`, `llama-manager/lib/runtime-command.js`, `manager-core/docker-runtime.js`, `manager-core/manager-routes.js` (redaction helper only), `vllm-manager/server.js`, `llama-manager/server.js`, `vllm-manager/test/runtime-command.test.js`, `llama-manager/test/runtime-command.test.js`, `manager-core/test/runtime-secret-store.test.js`, `manager-core/test/docker-runtime-env.test.js` (new).
- depends_on: P0-OBS-1.
- Acceptance:
  - No vLLM or llama argv element contains the key or the HF token value. The inline full-argv assertion passes, and no golden file is created.
  - `-e VLLM_API_KEY` / `-e LLAMA_API_KEY` / `-e HF_TOKEN` appear name-only.
  - Every docker run attempt, including retries, receives the env, and `WSLENV` contains `NAME/u` under the WSL prefix.
  - Pennyroyal and SGLang argv are byte-identical to before.
  - `redactDockerArgs` and `redactManagerSecrets` emit `<redacted>`. The three `***` assertions are flipped as in section 6, and a grep finds no `"***"` replacement left in `manager-core`, `vllm-manager/lib` or `llama-manager/lib`.
  - Both servers pass a `createSecretRedactor` to the ledger store and `/api/logs`. Its `getSecrets` cache is invalidated by `runtimeApiKeyStore.set/remove` (unit-tested with a counting stub).
  - `LLAMA_API_KEY` binding verified (or the fallback applied) and noted in the commit body.

**P0-RT-2 — Idle wake end to end** (L)
- Files: `manager-core/idle-unload.js`, `manager-core/manager-routes.js`, `vllm-manager/server.js`, `llama-manager/server.js`, `manager-core/test/idle-unload.test.js`, `vllm-manager/test/idle-wake-integration.test.js` (new), `llama-manager/test/idle-wake-integration.test.js` (new).
- depends_on: P0-RT-1.
- Acceptance:
  - The integration tests drive sleep → wake through the real launch-request factories, and the start body carries `model`, `instanceMode`, `instanceId` and `apiKey`.
  - Matching works by containerName, then path, then served name.
  - A running primary yields 409 `wake_would_replace_running` with `details` unless `confirmReplace:true`. A missing key yields 409 `wake_api_key_missing`.
  - A key that cannot be captured skips sleep, and the container is not stopped.
  - Wake keys are stored with `runtimeApiKeyStore.set` before stop and removed with `remove` after a successful wake or a forget. The store file holds no other new key, and `runtime-secret-store.js` is unchanged.
  - Legacy ledger records still wake under the guard.
  - The tests use only hooks, the route and the start body (section 6, portability), so ENG-8 can adopt them unchanged.

**P0-RT-3 — SGLang admission semantics and memory-estimate preview** (L)
- Files: `manager-core/gpu-admission.js`, `vllm-manager/lib/launch-request.js`, `vllm-manager/lib/memory-estimate.js`, `vllm-manager/server.js` (`buildMemoryEstimate` wiring only), `manager-core/test/gpu-admission.test.js`, `vllm-manager/test/launch-request.test.js`, `vllm-manager/test/memory-estimate-sglang.test.js` (new).
- depends_on: P0-RT-2 (serial on shared RT files).
- Acceptance:
  - The Flash-Next 262K default profile is admitted with `verdict:"warn"`, `clamped:true` and `reservedMb` 89095 on a fake 97887 MiB GPU at maxUtil 95 % (reserve 8192, used 600). Its lease `reservations[].requestedMb` is 89095 and `estimateMb` is 96801.
  - The same profile without `sglangMaxTotalTokens` is rejected (409 `insufficient_vram`) with a replace-mode message that names mem-fraction-static and `maxFraction` 0.915.
  - `job.meta.admission.policy === "static-fraction-of-free"`. The request uses exactly the C1 field names, and none of `free-fraction`, `requestedMbCeiling`, `requestedMbFloor` or `sglang_bounded_up_to_budget` appears.
  - `/api/memory-estimate` for the same two bodies returns `engine:"sglang"`, `plan.policy:"static-fraction-of-free"` and `plan.admissionPreview.verdict` `warn` / `block` (`plan.status` `warn` / `fail`), with every legacy response key present. A body-supplied `admissionPolicy` is ignored.
  - vLLM and Pennyroyal admission requests and estimates are unchanged: `pennyroyal.test.js`, `vllm core.test.js:663-664` and `launch-request.test.js:172-173` pass unmodified.
  - No message says "Parallel" in replace mode.

**P0-RT-4 — Per-instance logs and facts** (M)
- Files: `manager-core/runtime-request-utils.js`, `vllm-manager/server.js`, `llama-manager/server.js`, `manager-core/test/runtime-request-utils.test.js` (new), `vllm-manager/test/runtime-facts.test.js` (new).
- depends_on: P0-RT-3, P0-OBS-1.
- Acceptance:
  - `GET /api/logs?instance=x` for an unowned or unknown instance returns 404 `unknown_instance` without invoking docker.
  - A known instance reads its own container.
  - Facts for a parallel instance come from its container and its serve jobs only.
  - The no-parameter behaviour is unchanged.

**P0-RT-5 — Speed sources and unknown GGUF architecture** (M)
- Files: `vllm-manager/server.js`, `llama-manager/server.js`, `llama-manager/lib/launch-request.js` (P0-15 log line only), `vllm-manager/test/stats-speed.test.js` (new), `vllm-manager/test/core.test.js` (`:575-618` only), `llama-manager/test/stats-speed.test.js` (new), `llama-manager/test/core.test.js`.
- depends_on: P0-RT-4, P0-OBS-5.
- Acceptance:
  - An idle SGLang with a generation counter reports `counter_window`, not the stale gauge. A running one reports `sglang_gen_throughput_gauge`. A build without `generation_tokens_total` reports the gauge while running and `0` with `sglang_gen_throughput_gauge` when idle.
  - vLLM and llama report `counter_window`. No `counter_delta`, `sglang_live_gauge`, `sglang_recent_gauge` or `sglang_active_average` is emitted.
  - llama `recentOutputTokensPerSecond` never equals `predicted_tokens_seconds` by construction (test with diverging fixtures).
  - `speed.windowSeconds` is present.
  - An unmatched GGUF arch yields `status:"unknown", supported:null`. The launch is still allowed, and the start job log carries the message.
  - `llama core.test.js:382` is unchanged.

**P0-RT-6 — Download wiring: estimate, zero-match, transfer, roots, endpoints** (L)
- Files: `vllm-manager/server.js`, `llama-manager/server.js`, `vllm-manager/test/download-request.test.js` (new), `llama-manager/test/download-request.test.js` (new).
- depends_on: P0-RT-5, P0-DL-1, P0-DL-2, P0-DL-3.
- Acceptance:
  - An estimate failure no longer blocks a download.
  - A zero-match filter returns 422 `filter_no_match` and prepares no directory.
  - Tokens live only in the in-memory map and are referenced by `meta.transfer.tokenRef`. Nothing writes them to the runtime secret store or to disk.
  - `cleanup-incomplete` and `upstream-status` accept `path` inside roots and reject `path_outside_roots`.
  - The upstream check falls back to `.platform-download.json`.
  - `getDiskUsage` is wired with `listRoots`.
  - The resume check measures the job's own disk.

**P0-RT-7 — Health action details** (S)
- Files: `manager-core/health.js`, `vllm-manager/server.js`, `llama-manager/server.js`, `manager-core/test/health-actions.test.js` (new).
- depends_on: P0-RT-6.
- Acceptance:
  - `/api/tools/health` keeps the string `actions` and adds `actionDetails` for Docker, image and hf-cli checks with bilingual labels.
  - No `api` action points to a path other than `POST /api/docker/start`.

### UI batch

**P0-UI-1 — Console theme, billing labels, Playwright scaffold** (M)
- Files: `service-entry/index.html`, `service-entry/billing.html`, `tests/p0-ui.spec.cjs` (new), `tests/billing-page.spec.cjs`, root `package.json`.
- depends_on: none.
- Acceptance:
  - `#refreshBtn` hover contrast is at least 4.5 in light and dark emulation.
  - The billing overview shows the new heading and columns.
  - `npm run test:frontend-smoke` includes and passes `p0-ui.spec.cjs`.

**P0-UI-2 — Stats labels, instance logs link, CORS settings, wake confirm** (M)
- Files: `shared-public/js/{stats-summary-renderer, runtime-instances, ui-architecture, service-exposure-renderer, idle-unload-renderer, i18n-common}.js`, `vllm-manager/public/{app.js, index.html}`, `llama-manager/public/{app.js, index.html}`, `tests/p0-ui.spec.cjs`.
- depends_on: P0-UI-1, P0-RT-2, P0-RT-4, P0-RT-5, P0-OBS-4.
- Acceptance:
  - The speed label follows `outputSource`/`windowSeconds`. `windowSeconds` 0 or an unknown source shows "输出速度（采样中）/ Output speed (sampling)". The legacy `:88` suffixes are gone.
  - Each instance row opens its own logs.
  - The CORS "any origin" option is disabled until "require API key" is checked. The default is restricted, and the PNA checkbox saves `allowPrivateNetwork`.
  - A wake 409 shows the confirm, and only OK re-posts with `confirmReplace:true`.
  - `check-i18n.js` passes.

**P0-UI-3 — Downloads UI: failure card, priority, mirror probe, presets, disk roots, GGUF unknown** (M)
- Files: `shared-public/js/job-renderer.js`, `vllm-manager/public/app.js`, `llama-manager/public/{app.js, js/catalog.js, js/gguf-model-ui.js, index.html}`, `llama-manager/test/catalog-presets.test.js` (new), `llama-manager/test/gguf-model-ui.test.js`, `tests/p0-ui.spec.cjs`.
- depends_on: P0-UI-2, P0-RT-6, P0-DL-1.
- Acceptance:
  - A failed download card shows the bilingual title and hint from `meta.errorHint`, and "not retried automatically" for non-retryable codes. It renders from meta only, so derived codes added later by 03 need no UI change.
  - The vLLM request body contains `priority`.
  - The mirror probe never saves settings until "Apply suggestion" is clicked.
  - All llama presets match `/gguf/i` and default to `q4_k_m`, verified via the read-only HF API.
  - The disk panel lists `roots[]` with each model's root label.
  - A GGUF `supported:null` shows "未知（未验证）/ Unknown (unverified)".

**P0-UI-4 — Health action buttons** (S)
- Files: `shared-public/js/tool-panel-renderer.js`, `shared-public/js/i18n-common.js`, `tests/p0-ui.spec.cjs`.
- depends_on: P0-UI-3, P0-RT-7.
- Acceptance:
  - "启动 Docker / Start Docker" posts to `/api/docker/start` (stubbed).
  - Command actions copy text and make no request.
  - A stubbed `actionDetails` with a non-allowlisted path renders no button.
  - Final `test-all.cmd` on the UI branch is green, with counts recorded. This merge is the post-P0 head that 01 ENG-1 captures goldens from.
