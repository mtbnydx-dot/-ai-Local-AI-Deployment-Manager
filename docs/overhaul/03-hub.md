# 03 — Model hub and downloads center (phase P3, branch suffix `-hub`)

Status: design spec, binding for P3 work packages `HUB-*`. Conforms to `00-decisions-and-contracts.md` (D6 in particular). Requested contract changes are listed in section 21; nothing here silently diverges from 00.

Revision 2 (2026-10-14) applies the chief architect's cross-check:
- the shims call the hub as the signed machine principal `system:hub-shim` (§13.1, §15);
- events, the management proxy and route mounting come from 07 ENT-EV (§13);
- 08's download error codes are adopted (§6.3), and the former HUB-P0a–e are satisfied by 08 (§18);
- there is one secret policy: HF tokens are memory-only unless the user ticks "remember" (§12, §17);
- §10 uses 02's real API and §11 uses 01's `model:{card}` prospective plan;
- disk usage reports 08's `roots[]`/`rootId` (§13.5, §15);
- there is one redactor (§17) and one per-area i18n file (§19).

Inputs: diagnosis slices `downloads`, `newmodels`, `competitor-research` (2026-10-14), re-verified against the worktree code (references below are `file:line` in this worktree).

## 1. Goals and non-goals

Goals
- One engine-agnostic hub, `manager-core/model-hub/`, hosted by service-entry (5176). Search, plan, queue, transfer, verify, library, storage and settings live here, with one copy of each.
- Downloads survive manager and entry restarts. Queued jobs never expire, and interrupted jobs resume automatically.
- A selection is always an explicit, non-empty file set taken from the repository manifest, so a zero-match download cannot be built.
- Every failure carries a classified `errorCode` (08's taxonomy plus three refinements) with a bilingual title, a hint and fix actions. Only retryable codes retry.
- The library spans all registered roots, the HF cache and the ModelScope cache. It records provenance (provider, repo, revision SHA, files with sha256, quant, root), finds duplicates and checks for updates by SHA.
- Manager download routes become forwarding shims. platform-mcp shapes (`/api/models`, `/api/jobs?fields=summary`) are unchanged.

Non-goals (P3)
- A native HTTP Range downloader (transfer phase 2). Section 6 defines the engine interface it will plug into.
- The console UI, which is P7 (`07-*`). This spec defines the APIs, payloads and copy the console's Models area needs.
- Moving `/model-storage` root registration and migration out of the managers. The hub links to them and reuses `model-storage.js`.
- ModelScope authentication. Public ModelScope repos only; a gated or private one fails with `repo_not_found` (08 code, via a §6.3 pattern) and a ModelScope-specific `detail`.

## 2. Verified current-state facts that drive the design

| # | Fact | Evidence |
|---|---|---|
| F1 | Resume and auto-retry rebuild the env with `{ source }` only, which drops the mirror, Xet and the temporary token | `manager-core/download-utils.js:228`; first start passes `hfMirror/hfTransfer` and `env.HF_TOKEN` at `llama-manager/server.js:1237-1243`, `vllm-manager/server.js:1166-1173` |
| F2 | There is no zero-match guard; the filter is a precision→glob guess | `llama-manager/server.js:1218-1282` (no `matchedFiles===0` check); `download-utils.js:67-93` |
| F3 | Metadata calls are hardcoded to huggingface.co and awaited without a catch, so the mirror cannot rescue an unreachable HF API | `llama-manager/lib/remote-models.js:304,312,351`; `server.js:1229-1231` |
| F4 | The mirror probe sends `Authorization: Bearer` to hf-mirror.com, and the CLI env inherits `process.env` tokens while `HF_ENDPOINT` points at the mirror | `manager-core/mirror-probe.js:37`; `download-utils.js:154-186` (spreads `env`) |
| F5 | A failed CLI becomes `"Process exited with code N"`, and every failure auto-retries regardless of cause | `process-job-runner.js:106`; `download-job-controller.js:367-407` |
| F6 | Queued specs live in an in-memory Map, so a restart fails queued jobs ("队列状态已过期") and does not auto-resume interrupted ones | `download-job-controller.js:50,331-339,373-378` |
| F7 | Disk usage, cleanup, upstream check and resume-check free space resolve against the legacy `modelsRoot` only | `model-filesystem-store.js:153-190`; `llama-manager/server.js:1074-1105` |
| F8 | `hf download --local-dir` writes `<dir>/.cache/huggingface/download/<path>.metadata` = `commitSha\netag\ntimestamp`, and for LFS files the etag is the 64-hex sha256. None of the 9 live library folders has a `.platform-download.json` marker | verified read-only on the live library (all 9 folders have `.metadata`, 0 have markers) |
| F9 | platform-mcp reads `/api/jobs?fields=summary` (`id,type,title,status,createdAt,updatedAt,finishedAt,progress.percent,error`; status enum `queued,running,paused,success,failed,cancelled`) and `/api/models` (`{local,cached}[]`: `id,label,size,modified,modelFormat,runnable,verificationStatus,verificationIssues[{title,detail}]`) | `platform-mcp/src/platform-client.ts:820-870,1498-1540`; `src/schemas.ts:203-216` |
| F10 | The storage lock is a pid-based operation record shared across processes; migration's busy probe reads both managers' `jobs-ledger.json` | `model-storage.js` `acquireOperation/activeOperations`; `model-storage-routes.js:9-44` |
| F11 | service-entry is the gateway hot path (raw `node:http`, single process), so CPU-heavy hashing there would add latency to inference traffic | `service-entry/server.js:173-357` |
| F12 | manager-core tests run as `node --test test/*.test.js`, so tests in sub-directories are not collected | `manager-core/package.json` |
| F13 | The entry has no `/api/events` route today, and `checkManagementAccess` treats every loopback socket as admin. Any local process can therefore write today; after 05 PUB-5 a loopback caller is only a viewer | `service-entry/lib/security.js:157-172`; `service-entry/server.js` (no events route) |
| F14 | `createRuntimeSecretStore` writes `{ secret, createdAt }` as plaintext JSON under `logs/runtime-secrets.json` by default | `manager-core/runtime-secret-store.js:14,49-56` |
| F15 | The internal HMAC scheme already exists for billing: method, path, manager id, timestamp (±60 s) and sha256(body), with a loopback-socket check. The key is the gateway trust token | `manager-core/billing-client.js:8-13,44-66`; `service-entry/lib/billing-http.js:286` |

Several of these get P0 fixes in 08: F1/F4 (P0-DL-2), F2 (P0-RT-6), F5 (P0-DL-1) and F7 (P0-DL-3, P0-RT-6). The hub builds on those fixes and does not repeat them (§18).

## 3. Architecture

```
browser (console /, legacy manager UIs)            platform-mcp (read-only)
      │ same-origin /api/hub/*                      │ /api/jobs?fields=summary, /api/models (managers)
      ▼                                             ▼
service-entry :5176 ◄──── HMAC-signed ───────── vllm :5177 / llama :5178
  lib/hub-routes.js ──► manager-core/model-hub     model-hub/shim.js + client.js (principal system:hub-shim)
  lib/events.js (07 ENT-EV)  ├ providers/{index,http,huggingface,hf-mirror,modelscope}.js
  lib/viewer-allowlist.js    ├ selection.js, fnmatch.js
  (05)                       ├ queue.js ── transfer.js (CLI engine) ── hf.exe / modelscope.exe
                             ├ progress.js, verify.js ── hash-worker.js (worker_threads)
                             ├ library.js, disk.js, auth.js (hf-auth.js), tokens.js, run-after.js, fit.js
                             ├ store.js, settings.js, migrate.js, errors.js (extends 08 P0-DL-1)
                             └ compat.js, client.js, shim.js (used by the manager shims)
```

- **Process placement.** The hub runs inside service-entry, because engine deploys restart the managers and every manager restart kills downloads today. The entry instantiates it once (`createModelHub`) after `listen`, and `shutdownSoon` calls `hub.stop()` before `process.exit`. Its routes are one line in ENT-EV's route-mount table (`["/api/hub/", hubRoutes.handle]`), and the mount calls `consoleFeatures.enable("hub")` (07).
- **Data directory.** `<AI_ROOT>/service-entry/data/hub/` (already excluded from releases through `service-entry\data`). It holds:
  - `downloads.json`, the queue and active ledger.
  - `downloads-history.jsonl`, terminal jobs in compact form.
  - `library.json`.
  - `settings.json`.
  - `migrations.json`.
  - `logs/<jobId>.log`, rotated at 2 MB.
  - `migration/` snapshots.

  Nothing under `data/hub/` is a secret. Temporary HF tokens live in memory, and a token the user asks to remember goes to `manager-core/secret-store.js` namespace `hf` (§12).
- **Shared stores reused unchanged.** `model-storage.json` and the `model-operations/*.json` locks are reused through `createModelStorage({ modelsRoot: <AI_ROOT>/models, file: <AI_ROOT>/service-entry/data/model-storage.json })`. Path resolution, verification and cleanup reuse `createModelFilesystemStore`, and checksums reuse `download-checksums.js`.
- **Hashing never runs on the entry main thread.** `verify.js` posts work to `hash-worker.js` (one `worker_threads` worker, sequential files, 4 MB chunks, progress every 256 MB). Directory scans use async fs with concurrency 4.
- **Config.** `hub.downloadsOwner: "hub" | "manager"` in `<AI_ROOT>/config/platform.json`, with env override `AI_HUB_DOWNLOADS_OWNER`. Precedence is env > file > default `"hub"`. Until `platform/config.js` (P6) exists, `model-hub/config.js#readHubConfig(aiRoot, env)` reads it directly. Both managers and the entry read the same value. `"manager"` is the rollback mode: managers use their legacy controllers, and the hub serves the library and search read-only, with `POST /api/hub/downloads` returning 409 `hub_disabled`.
- **No new npm dependencies.** Everything uses `node:` modules plus existing manager-core code.

### 3.1 Factory and module signatures

```js
// manager-core/model-hub/index.js
createModelHub({
  aiRoot, dataDir, hfHome, hfCli, modelScopeCli,      // CLI discovery order unchanged: download-cli → ai312 → ai311 → PATH
  modelStorage, fsStore,                               // shared manager-core instances
  secretStore = null,                                  // 06 OPS-3 manager-core/secret-store.js; null → "remember token" unavailable
  fetchImpl,                                           // wraps core.fetchWithSystemProxyFallback
  events,                                              // 07 ENT-EV service-entry/lib/events.js: { publish(type, payload) }
  getRuntimeLoad,                                      // async () => { busy: bool, known: bool, detail: [...] }
  getGpus,                                             // async () => [{ id, name, totalMb, freeMb, computeCap }]
  managers,                                            // [{ id: "vllm"|"llama", port }]
  models = null,                                       // 02 namespace core.models: { inspectRemote, inspectLocal, estimateFit, evaluateCompatibility } or null
  getCompatibilityContext = null,                      // 02 entry wiring: async () => { runtimes, runtimeFacts, adapters, host, knowledge, hostRecords, probes }
  clock = Date, spawnImpl, platform = process.platform, logger = console,
}) => Hub

Hub = {
  start(): Promise<void>, stop({ reason }): Promise<void>, status(): HubStatus,
  search(query, ctx), getRepo(ref, opts), getReadme(ref), listFiles(ref, { cursor }), resolveLink(url),
  plan(input, ctx): Promise<PlanResult>, enqueue(input, ctx): Promise<DownloadJob>,
  jobs: { list, get, logs, pause, resume, cancel, retry, setPriority, reorder, startNow, pauseAll, resumeAll, remove, resumeCheck, confirmRun },
  library: { list, get, rescan, verify, checkUpdate, update, identify, importCache, remove, cleanupResidue, findByPath },
  storage: { usage, cleanup }, settings: { get, update }, auth: { status, login, access }, sources: { probe }, migration: { status },
  busy(): { downloads: number, verifying: number },   // read by 06 OPS-13 GET /api/platform/busy (blocker kind "download")
}
```

| Module | Main exports |
|---|---|
| `providers/index.js` | `createProviders({ settings, fetchImpl, getHfToken, cache }) → { get(id), forNamespace(ns, policy) }` |
| `providers/http.js` | `authorizedFetch(url, { token, ...init })` (host-guarded credentials, manual redirects without credentials, §17), `cappedJson(res, maxBytes)` |
| `providers/huggingface.js` | `createHuggingFaceProvider({ endpoint, fetchImpl, getToken, cache }) → HubProvider` |
| `providers/hf-mirror.js` | `createHfMirrorProvider({ endpoint, fetchImpl, cache })`: the HF implementation with `getToken: () => ""` and `sendsCredentials: false` |
| `providers/modelscope.js` | `createModelScopeProvider({ endpoint, fetchImpl, cache })` |
| `selection.js` | `listArtifacts(manifest, { card })`, `resolveSelection(manifest, selection)`, `selectionFromLegacy({ precision, includeExtras, repo }, manifest)`, `compileIncludePatterns(selected, all, { argvBudget })`, `assertSafeRepoPath(p)` |
| `fnmatch.js` | `fnmatchToRegExp(pattern)` (Python `fnmatch.translate` semantics: `*` crosses `/`), `escapeFnmatch(name)` |
| `transfer.js` | `createCliTransferEngine({ hfCli, modelScopeCli, hfHome, dataDir, spawnImpl, platform, tokens, redactor }) → { id: "cli", supports(job), buildCommand(job), buildEnv(job), start(job, hooks) → handle, findOrphans(jobs) }` |
| `errors.js` | Created by 08 P0-DL-1 with `classifyDownloadFailure` and `DOWNLOAD_ERROR_CODES`, both kept unchanged. The hub adds `class HubError`, `classifyTransferFailure(input)`, `retryDecision(error, job, settings)`, `toEnvelope(err)` and `HUB_ERROR_CODES` (08 codes plus refinements). No redaction helper lives here (§17) |
| `tokens.js` | `createTokenVault({ secretStore, clock }) → { put(token, { remember }) → tokenRef, resolve(tokenRef) → string\|null, release(tokenRef), values() → string[], sweep(jobs) }` (§12) |
| `fit.js` | `createFitService({ models, getGpus, getCompatibilityContext }) → { fitFor(input), compatibilityFor(card), labelOf(fitResult) }`, with the bytes-only fallback used while `models` is null (§10) |
| `progress.js` | `createTransferMonitor(job, { fs, clock, hfHome, settings, onUpdate, onStall })` |
| `verify.js`, `hash-worker.js` | `verifyArtifact(job, { onProgress, signal }) → { ok, mismatched[], missing[], verifiedFiles[] }` |
| `queue.js` | `createDownloadQueue({ store, engine, monitorFactory, verifier, library, settings, busySignal, disk, events, runAfter, clock })` |
| `store.js` | `createHubStore({ dataDir })`: atomic temp+rename JSON writes, `appendHistory`, and a `writerPid`/`heartbeatAt` stamp |
| `library.js` | `createLibrary({ store, modelStorage, fsStore, hfHome, fit, models, providers, events })` |
| `disk.js` | `volumeOf(p)`, `computeUsage({ modelStorage, library, queue, hfHome })`, `reserveBytes(free, settings)` |
| `auth.js` | wraps `hf-auth.js#createHfAuthService({ hfCli, hfHome })` |
| `run-after.js` | `createRunAfter({ managers, fetchImpl, events, getEngines })` |
| `migrate.js` | `runHubMigration({ aiRoot, store, settings, modelStorage, library, logger })` |
| `compat.js` | pure legacy mappers (section 15) |
| `client.js`, `shim.js` | `createHubClient({ baseUrl, managerId, internalAuth, timeoutMs })` (every request signed, §15), `registerHubShimRoutes(app, { managerId, client, isLocalRequest })` |
| `settings.js` | `HUB_SETTINGS_SCHEMA`, `defaultSettings()`, `validateSettings(patch)`, `fromLegacy(obj)`, `toLegacy(settings)` |

## 4. Providers

### 4.1 Interface

Repository *namespaces* are `huggingface` and `modelscope`. A *source* (transport) is `huggingface`, `hf-mirror` or `modelscope`. Provenance records both: `provider` is the namespace, and `transport` is the source that actually served the bytes.

```js
/** @typedef HubProvider
 *  id: "huggingface"|"hf-mirror"|"modelscope"; namespace: "huggingface"|"modelscope";
 *  apiBase: string; fileBase: string; sendsCredentials: boolean;
 *  search(q: SearchQuery) → Promise<{ items: RawRepo[], nextCursor: string|null }>
 *  getRepo(repo, { revision }) → Promise<RepoManifest>
 *  getReadme(repo, { revision, maxBytes = 524288 }) → Promise<{ markdown, truncated }>
 *  fetchImpl: (url, init) → Promise<Response>   // authorizedFetch bound to this provider; handed to 02 inspectRemote (§10)
 *  fileUrl(repo, path, revision) → string
 */
// RepoManifest
{ "namespace": "huggingface", "repo": "unsloth/Qwen3-8B-GGUF", "revision": "main", "revisionSha": "40-hex|null",
  "gated": false, "private": false, "lastModified": "ISO", "tags": [], "pipelineTag": "text-generation", "library": "gguf",
  "baseModel": "Qwen/Qwen3-8B", "license": "apache-2.0",
  "structured": { "safetensors": { "total": 8190735360, "parameters": { "BF16": 8190735360 } }, "gguf": { "architecture": "qwen3", "context_length": 40960, "total": 8190735360 }, "config": {} },
  "files": [ { "path": "Qwen3-8B-Q4_K_M.gguf", "size": 5027783488, "sha256": "64-hex|null", "gitOid": "40-hex|null", "lfs": true } ],
  "filesTruncated": false, "fetchedAt": "ISO", "fetchedFrom": "https://huggingface.co" }
```

### 4.2 Implementations and credential policy

| Provider | Search | Manifest | Credentials |
|---|---|---|---|
| `huggingface` | `GET {api}/api/models?search=&author=&filter=&pipeline_tag=&sort=&direction=-1&limit=&expand[]=…`. The next cursor is the `rel="next"` URL of the `Link` header. | `GET {api}/api/models/{repo}/revision/{rev}?blobs=true` gives `sha`, `siblings[].size`, `lfs.sha256`, `gated`, `cardData`, `config`, `gguf`, `safetensors`. Repos with more than 20k files fall back to `/tree/{rev}?recursive=true&expand=true` (paged). | Bearer token (env `HF_TOKEN`, or the `HF_HOME/token` file read by the CLI) only for `huggingface.co` hosts |
| `hf-mirror` | same API at `settings.sources.mirrorEndpoint` | same | **never**. The fetch wrapper refuses to attach `authorization` (section 17). Gated repos report `access.status = "official_required"`. |
| `modelscope` | `PUT {api}/api/v1/dolphin/models` (current body shape, `remote-models.js:219-227`); page cursor = `PageNumber` | `GET {api}/api/v1/models/{owner}/{name}/repo/files?Revision={rev}&Recursive=true` gives `Files[]{Path,Size,Sha256,Type,Revision}`; `revisionSha` comes from `Files[].Revision` and is `null` when absent | none (public only, phase 1) |

- `expand[]` fields: `downloads, likes, lastModified, pipeline_tag, library_name, tags, gated, safetensors, gguf, cardData, usedStorage`. The provider tolerates missing fields, and HUB-2 records a fixture from the live API.
- Metadata for the `huggingface` namespace goes to the official API unless `sources.policy` is `hf-mirror`. When the official API fails with a network-class error, the request is retried once against the mirror (without credentials) and the response carries `fetchedFrom` plus a warning. This fixes F3.
- All provider responses are cached in a `createSingleFlightCache`: search 90 s, manifest 5 min (keyed by `revisionSha` when known), readme 30 min. The cache key includes `credentialed: bool`, never the token.
- ModelScope fetches keep the existing proxy-strip/direct-DNS behaviour (`download-utils.js:170-176`) for the CLI, and `fetchWithSystemProxyFallback` for metadata.

## 5. Artifacts and selection (zero match is impossible by construction)

`listArtifacts(manifest)` returns the downloadable choices. An artifact is always a concrete file list taken from the manifest.

| Kind | Key | Rule |
|---|---|---|
| `gguf-quant` | `gguf:<directory>\|<QUANT>` | One per quant group from `gguf-variants.js#listGgufVariants` (shards grouped, directory part of the identity). Emitted only when `complete` is true or the user accepts an incomplete shard set. |
| `safetensors-full` | `st:<directory>` | Every weight file (`*.safetensors`, `*.bin`, `*.pt`) under one weight directory that has a `config.json` or index; `""` = root. A repo with several weight directories yields one artifact per directory. |
| `custom` | `custom:<sha8 of sorted paths>` | An explicit `files[]` chosen in the file tree. |

- **Companions.** `mmproj*`, draft, DFlash, EAGLE and MTP GGUFs are listed under `artifact.companions` and added only on request (`selection.companions[]`, exact paths).
- **Sidecars added to every artifact.** These files from the artifact directory and the repo root: `config*.json`, `generation_config.json`, `tokenizer*`, `special_tokens_map.json`, `*.jinja`, `chat_template*`, `preprocessor*`, `processor*`, `*.model`, `*.tiktoken`, `*.py` (only when `config.auto_map` exists; flagged in the plan for security review), `README*`, `LICENSE*`, `*.safetensors.index.json`.
- **`resolveSelection` rejects**:
  - an unknown `artifactKey` → 422 `artifact_not_found`;
  - any `files[]` path missing from the manifest → 422 `file_not_in_manifest`;
  - an unsafe path → 422 `unsafe_path` (rules in section 17);
  - a result with zero weight files → 422 `filter_no_match`, with `details.available` = artifact keys.
  A non-empty manifest-backed selection is therefore the only thing that reaches the queue.
- **Legacy precision.** `selectionFromLegacy` (used by shims) maps the old `precision` and `includeExtras`:
  - a GGUF quant label → the matching `gguf-quant` artifact (via `quantTagOf`);
  - a safetensors precision → `safetensors-full` when `modelReferenceDeclaresPrecision(repo, p)`, otherwise only files whose names carry the precision plus sidecars;
  - `includeExtras` globs → matched companions;
  - `""` → the whole repo.
  Zero weight files → 422 `filter_no_match`, carrying `suggestions` (quant labels with sizes).
- **Compiling to CLI arguments** (`compileIncludePatterns(selected, all, { argvBudget = 24000 })`):
  1. `selected == all` → `{ mode: "all" }` (no `--include`).
  2. Otherwise build patterns greedily: `dir/*` when every file under `dir` is selected; `*<QUANT>*.gguf` when it matches exactly that group's files; otherwise exact names escaped with `escapeFnmatch` (`[`→`[[]`, `*`→`[*]`, `?`→`[?]`).
  3. Check that the patterns, applied with `fnmatchToRegExp` to `all`, yield exactly `selected`. If not, fall back to exact names. A mismatch after fallback is an internal error (`selection_compile_error`), never a silent download.
  4. If the argv would exceed `argvBudget` characters, split into `batches` that run sequentially within one job (`transfer.batchIndex`). The Windows `--include=PAT` form is kept (constraint from `download-utils.js:274-276`).

## 6. Transfer engine, phase 1 (CLI adapter)

### 6.1 Engine interface (phase 2 plugs in here)

```js
engine.start(job, { onLine(stream, text), onExit({ code, signal }), onSpawn({ pid, startedAt }) })
  → { pid, stop(reason /* "pause"|"cancel"|"stall"|"shutdown" */): Promise<void> }
engine.findOrphans(jobs) → Promise<[{ jobId, pid, alive: true, matches: bool }]>
```

### 6.2 Command and environment

- **hf command.** `[hfCli, "download", repo, "--revision", revisionSha ?? revision, ...includeArgs, "--local-dir", localDir]`. The revision is pinned to the planned SHA, so a resume never mixes commits.
- **ModelScope command.** `[modelScopeCli, "download", "--model", repo, "--revision", rev, "--local_dir", localDir, ...("--include", pat)]`.

`buildEnv(job)` is derived only from `job.transfer.options`, which is persisted at enqueue. Resume and retry reuse it verbatim, which fixes F1.

| Option | Env effect |
|---|---|
| base | `process.env` minus `HF_TOKEN`, `HUGGING_FACE_HUB_TOKEN`, `HF_ENDPOINT` and `HF_HUB_DISABLE_IMPLICIT_TOKEN` (never inherited), plus the existing `HF_HOME`, `HUGGINGFACE_HUB_CACHE`, `MODELSCOPE_CACHE`, UTF-8, no-colour and no-progress-bar vars (`download-utils.js:155-169`) |
| `source: "huggingface"` | `HF_ENDPOINT=https://huggingface.co`. `credentialMode: "temp-token"` → `HF_TOKEN=tokens.resolve(tokenRef)` (null → the job is not spawned, §12); `"cached-login"` → no var, and the CLI reads `HF_HOME/token`; `"none"` → `HF_HUB_DISABLE_IMPLICIT_TOKEN=1` |
| `source: "hf-mirror"` | `HF_ENDPOINT=<mirrorEndpoint>`, `HF_HUB_DISABLE_IMPLICIT_TOKEN=1`, `HF_TOKEN_PATH=<dataDir>/no-token` (a path that never exists). `tokenRef` is forbidden: 422 `token_not_allowed_on_mirror` |
| `source: "modelscope"` | the existing proxy strip, `NO_PROXY=*`, `MODELSCOPE_DIRECT_DNS=1`, `PYTHONPATH=python-direct-dns` |
| `xet: "high-performance"` | `HF_XET_HIGH_PERFORMANCE=1` |
| `xet: "default"` | no Xet vars |
| `xet: "off"` | `HF_HUB_DISABLE_XET=1` |

- A gated repo with `sources.gatedUsesOfficial` (default true) plans `source: "huggingface"` even when the policy is the mirror, and the plan states this.
- `transfer.optionsHistory[]` records every automatic change with its reason (for example the §6.3 Xet remedy on `unknown` → `xet: "off"`). A settings change never rewrites a queued or paused job; the user opts in with `resume { refreshTransferOptions: true }` or the failure card's "switch source" action.
- **Process supervision.**
  - spawn with `windowsHide: true`; record `pid` and `pidStartedAt`; acquire the `model-storage` lock with `acquireOperation([localDir], "download")` before spawn, call `trackChild` after, and release on exit (unchanged lock semantics, F10);
  - stop = `taskkill /PID <pid> /T /F` (`terminateProcessTree`);
  - stdout/stderr pass through `createUtf8LogForwarder`, then the hub redactor (`createSecretRedactor({ getSecrets: tokens.values })` from `manager-core/secret-redactor.js`, §17), then the job log (ring of 400 lines persisted, full log in `logs/<id>.log`);
  - a separate stderr ring of 200 lines feeds the classifier.
- **Orphans.** At hub start, for every job whose state was in-process (`resolving…verifying`) with a recorded pid, `findOrphans` runs one `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=<pid>' | Select ProcessId,CreationDate,CommandLine | ConvertTo-Json"`. The process is killed only when its `CommandLine` contains both `download` and the job's `localDir`. Pid reuse can never kill an unrelated process.

### 6.3 Error taxonomy and retry (`errors.js` from 08 P0-DL-1; data `manager-core/data/hub-transfer-errors.json`)

The base taxonomy is 08's `classifyDownloadFailure` (08 §P0-8), used unchanged. It supplies the code, retryability, `retryDelayFactor` and the bilingual title and hint. The hub data file adds four things, all keyed by 08 code names:
- `classes`: a class per code, for `retry.perClass`;
- `maxAttempts`: a per-code retry cap;
- `patterns`: extra matchers that run only when 08 returns `unknown`;
- `remedies`: automatic option changes, for example Xet off.

The file also defines exactly three **refinements**: `network_timeout`, `hf_login_required` and `transfer_empty`. Each is a narrower case of one 08 base code. The set is fixed in code as `HUB_REFINEMENT_CODES`. An override may change matchers and copy, but it cannot add codes.

`classifyTransferFailure({ exitCode, stderrTail, phase, source, spawnError, job, signals })`:
1. Call `base = classifyDownloadFailure({ text, exitCode, error: spawnError, meta })`.
   - `text` is the last 60 stderr lines.
   - `meta` is `{ stalled: signals.stalled, verifyFailed: signals.verifyFailed, transfer: { tokenRef }, errorCode: signals.errorCode }`.
2. If `base.code === "unknown"`, try `patterns` in order. The first match replaces the code with that pattern's 08 code.
3. Apply the first refinement whose `base` equals the code and whose `when` holds.
4. Return `{ code, baseCode, class, retryable, retryDelayFactor, title:{zh,en}, hint:{zh,en}, actions[], detail, retry: { auto, maxAttempts } }`. `detail` is the last matching line, redacted.

| code | base (08) | class | produced by | hub auto-retry | actions |
|---|---|---|---|---|---|
| `stall` | — | watchdog | §7.3 watchdog sets `signals.stalled` | yes, 3, files kept | resume, switch-source |
| `verify_failed` | — | integrity | structure or size check fails, or `.incomplete` files remain after exit 0 | yes, 2 | retry |
| `checksum_mismatch` | — | integrity | sha256 mismatch in verify. Only the bad files are deleted first. The same file failing twice sets `retryable: false` | yes, 2 | retry |
| `cli_missing` | — | tooling | spawn `ENOENT` | no | install-cli |
| `disk_full` | — | storage | `ENOSPC` and similar | no | free-space, choose-root |
| `hf_approval_required` | — | auth | gated 403 | no | open-approval |
| `hf_auth_invalid` | — | auth | 401 with a token | no | sign-in |
| `hf_token_expired` | — | auth | `tokenRef` set but `tokens.resolve` returns null, after an entry restart without "remember". Detected before spawn, so it is handled as `waiting/auth` (§8) and never as a failure | no | enter-token |
| `repo_not_found` | — | not_found | 08 matchers. A `patterns` entry also maps ModelScope 401/403 here (public repos only in phase 1) | no | check-id |
| `revision_not_found` | — | not_found | 08 matchers | no | check-id |
| `filter_no_match` | — | selection | plan time (422). It is never emitted by a transfer | no | pick-artifact |
| `rate_limited` | — | server | 08 matchers. The delay is ×4 (at least 120 s) or `Retry-After`, whichever is larger | yes, 3 | — |
| `network_unreachable` | — | network | 08 matchers. A `patterns` entry adds `ProxyError` and 407 | yes, 3 | switch-source |
| `unknown` | — | unknown | fallback, including 5xx, `Traceback` and `PermissionError` | yes, 1 | view-log |
| `network_timeout` | `network_unreachable` | network | `when.text: ReadTimeout\|timed out\|ETIMEDOUT`, or the 60 s resolving-step timeout | yes, 3 | switch-source |
| `hf_login_required` | `hf_auth_invalid` | auth | `when: { credentialMode: ["none","cached-login"], cachedToken: false }` | no | sign-in |
| `transfer_empty` | `filter_no_match` | selection | completion check: exit 0, but a selected weight file is missing or 0 bytes. The check passes `signals.errorCode: "filter_no_match"` (so 08 returns the base) and `signals.emptySelection` | no | view-log, pick-artifact |

```json
{ "schemaVersion": 1, "asOf": "2026-10-14", "staleAfterDays": 180,
  "classes": { "stall": "watchdog", "verify_failed": "integrity", "checksum_mismatch": "integrity", "network_unreachable": "network", "rate_limited": "server", "unknown": "unknown" },
  "maxAttempts": { "stall": 3, "network_unreachable": 3, "rate_limited": 3, "verify_failed": 2, "checksum_mismatch": 2, "unknown": 1 },
  "patterns": [ { "code": "repo_not_found", "match": "modelscope.*\\b(?:401|403)\\b|NotExistError" },
                { "code": "network_unreachable", "match": "ProxyError|407 Proxy Authentication" } ],
  "refinements": [
    { "code": "network_timeout", "base": "network_unreachable", "when": { "text": "ReadTimeout|timed out|ETIMEDOUT" }, "retryable": true,
      "title": { "zh": "连接下载源超时", "en": "The download source timed out" },
      "hint": { "zh": "将自动重试；若持续超时，可切换下载源。", "en": "Retrying automatically. If it keeps timing out, switch the source." } },
    { "code": "hf_login_required", "base": "hf_auth_invalid", "when": { "credentialMode": ["none", "cached-login"], "cachedToken": false }, "retryable": false,
      "title": { "zh": "需要登录 Hugging Face", "en": "Hugging Face sign-in required" },
      "hint": { "zh": "点击「登录」，在本机窗口完成登录后重试。", "en": "Click Sign in, finish in the local window, then retry." } },
    { "code": "transfer_empty", "base": "filter_no_match", "when": { "signal": "emptySelection" }, "retryable": false,
      "title": { "zh": "下载结束但所选文件为空", "en": "The download finished but the selected files are empty" },
      "hint": { "zh": "查看日志；仓库可能在下载期间被修改，请重新选择规格。", "en": "Check the log. The repository may have changed during the download; pick the artifact again." } } ],
  "remedies": [ { "code": "unknown", "when": { "text": "hf_xet|xet[ _-]?(?:error|panic)" }, "set": { "xet": "off" }, "maxTimes": 1 } ] }
```

- **Validation.** Loading uses `reference-data.js`, with the override `<AI_ROOT>/config/hub-transfer-errors.json` merged by `code`. Every `classes`/`maxAttempts` key, every `patterns[].code` and `remedies[].code`, and every `refinements[].base` must be in `DOWNLOAD_ERROR_CODES`. Every `refinements[].code` must be in `HUB_REFINEMENT_CODES`. Invalid entries are dropped and reported in `GET /api/hub/status` `dataErrors[]`, and through 02's `registerStatusProvider("hub-transfer-errors", …)` when present. Startup never fails because of them.
- **Backoff.** `min(maxDelay, base · 2^(attempt-1)) · retryDelayFactor` with ±20 % jitter. Defaults are base 10 s and max 600 s. `Retry-After` wins when it is larger.
- **Retry state.** `job.retry = { count, max, nextAt, history[{ at, code }] }`. While waiting, the job is in state `retrying`. When the code is non-retryable or the retries are exhausted, the state becomes `failed` and `error` is filled.
- **Remedies.** A remedy is applied before its retry and recorded in `transfer.optionsHistory`, for example `{ at, reason: "unknown/xet", set: { xet: "off" } }`.
- **Per-class switches.** `retry.perClass` in settings can disable auto-retry for a class. It can never enable auto-retry for a code that 08 or a refinement marks non-retryable.
- **Legacy surface.** The shim and the migrated ledger records carry 08's controller fields: `meta.errorCode`, `meta.errorRetryable`, `meta.errorHint {zh,en}` and `job.error = "<title.zh> / <title.en>"`. They also carry the additive `meta.errorBaseCode`. P0-UI-3's failure card therefore renders hub failures unchanged, and an unknown refinement code falls back to its base.

## 7. Phases, progress and watchdog

### 7.1 States

| state | meaning | legacy status (section 15) |
|---|---|---|
| `queued` | waiting for its turn | `queued` |
| `waiting` | at the head but held: `waitReason` ∈ `runtime-busy`, `disk`, `concurrency`, `auth` (`auth` = a temporary token is no longer in memory, §12) | `queued` |
| `resolving` | manifest refresh, access check, disk check, lock | `running` |
| `downloading` | CLI running, bytes arriving | `running` |
| `materializing` | Xet reconstruction: chunks fetched, files being assembled | `running` |
| `verifying` | structure, size and sha256 checks in the worker; marker v2; library registration | `running` |
| `ready` | verified, in the library (terminal) | `success` |
| `retrying` | backoff timer pending | `queued` |
| `paused` | stopped by the user or by migration; files kept | `paused` |
| `interrupted` | hub stopped mid-transfer; `autoResume: true` | `interrupted` |
| `failed` | non-retryable or retries exhausted (terminal until a user retry) | `failed` |
| `cancelled` | user cancel, files kept or deleted (terminal) | `cancelled` |

Each transition appends `{ phase, at }` to `phaseHistory` (cap 32), persists `downloads.json` and emits `downloads`.

### 7.2 Progress monitor (`progress.js`)

- **Tick.** Every 2 s for the first 30 s, then every 5 s. Each tick does not walk the tree. For each manifest file it `stat`s `<localDir>/<path>` and reads the sizes of `.cache/huggingface/download/<path>.*.incomplete` (one `readdir` per distinct directory).
- **File states.** `pending | partial | done | verified | bad`. `bytesDone = Σ min(size, done ? size : partialBytes)`.
- **Xet signal.** The size of `<HF_HOME>/xet` is sampled only when local bytes are flat, at most every 30 s.
- **Speed.** `speedBps` is computed per tick, and `speedEmaBps` uses α = 0.2. `samples` keeps 60 `[epochMs, bytesDone]` pairs for the sparkline. ETA = remaining / `speedEmaBps`.
- **Percent** is capped at 99 until `ready`; it is 100 only when ready.
- **Phase inference while the CLI runs.**
  - `downloading` by default.
  - `materializing` when Xet is in use and the Xet cache grew earlier in this attempt, and the cache has now been flat for 2 samples while local bytes grow or the process is alive. Exit code 0 → `verifying`.

### 7.3 Stall watchdog (phase-aware)

| phase | stall condition | action |
|---|---|---|
| `resolving` | an HTTP step exceeds 60 s | abort → `network_timeout` |
| `downloading` | none of local bytes, Xet bytes or CLI output lines grew for `transfer.stallMinutes` (default 10, previously 5) | stop("stall") with `signals.stalled` → `stall` (retryable, files kept) |
| `materializing` | no local growth and no output for `transfer.materializeStallMinutes` (default 20) | as above |
| `verifying` | the hash worker sends no heartbeat for 5 min | terminate the worker, retry verifying once, then `verify_failed` |

The one-time slow-source hint (`download-throughput.js`) is kept as a log line plus `job.advice = { code: "slow_source", suggest: "hf-mirror"|"modelscope" }`. It never changes settings.

### 7.4 Completion pipeline

1. `verifyDownloadedModel({ localDir }, { strictIncomplete: true })` (existing).
2. Per-file size against the manifest. Exit code 0 with a selected weight file missing or 0 bytes → `transfer_empty` (§6.3), non-retryable.
3. sha256 for manifest files with `sha256` when `verify.sha256`. Hashing runs in the worker. Files already `verified` with the same size and mtime are skipped (resume). Only mismatched files are deleted, which keeps `createDownloadChecksumRunner` semantics.
4. Write marker v2, `.platform-download.json`. It is a superset of v1 (`prepareDownload` still reads `model/source/precision`):
   ```json
   { "schemaVersion": 2, "model": "unsloth/Qwen3-8B-GGUF", "source": "huggingface", "precision": "Q4_K_M", "createdAt": "ISO",
     "provider": "huggingface", "transport": "huggingface", "revision": "main", "revisionSha": "40-hex", "artifactKey": "gguf:|Q4_K_M",
     "jobId": "dl_…", "completedAt": "ISO", "files": [ { "path": "Qwen3-8B-Q4_K_M.gguf", "size": 5027783488, "sha256": "64-hex" } ] }
   ```
5. `library.registerFromJob(job)` → `result.libraryEntryId`.
6. One fit line from `fit.fitFor` on the local card (section 10). This replaces the two disagreeing "显存粗评" lines.
7. State becomes `ready`; release the job's `tokenRef` (§12); emit `notification` (when `notifications.onReady`) and start `runAfter` if present.

## 8. Queue and scheduler (`queue.js`)

- **Global and persistent.** One queue for all engines.
  - `downloads.json` = `{ schemaVersion: 1, writerPid, heartbeatAt, jobs: [DownloadJob (non-terminal + last history.keepRecords terminal)] }`.
  - Writes are atomic: on every state transition, and at most every 5 s for progress.
  - Terminal jobs beyond `keepRecords` are compacted (no logs, no per-file progress) and appended to `downloads-history.jsonl`. Records older than `retentionDays` are pruned on start. Library provenance is independent of history.
- **Order.** `priority` (high > normal > low), then `queueOrder` ascending. `reorder(ids)` rewrites `queueOrder`. `startNow(id)` sets `priority: "high"`, the minimum `queueOrder` and `bypassIdleOnce`. With `force: true` it may also exceed `maxConcurrent` by one.
- **Concurrency.** `transfer.maxConcurrent` (1–4, default 1). Jobs in `resolving`, `downloading`, `materializing` and `verifying` count toward it.
- **Idle-only, aggregated across engines.**
  - The busy signal is `getRuntimeLoad()` from the entry. It is busy when:
    - any fleet catalog model has `runningRequests + waitingRequests > 0` (`service-entry/lib/model-fleet.js:298-303`);
    - or any instance lifecycle is `loading` (disk contention with weight loading);
    - or the gateway has in-flight requests.
  - Unreachable managers count as not busy (`known: false`, logged once).
  - The head job waits in `waiting/runtime-busy` until two consecutive idle polls `idleGraceSeconds` apart (default 30 s). Re-checks run every 30 s.
- **Disk reservation per volume.**
  - `volumeOf(realpath(root))` is the drive.
  - Available = `statfs.free − Σ remaining bytes of active jobs on the volume − reserve`, where reserve = `max(5 % of free, storage.reserveGb)`.
  - Not enough at dequeue → `waiting/disk` plus a `notification`.
  - At enqueue it is a warning (`queuedOnVolumeBytes` in the plan); it blocks only when the job alone cannot fit (`disk_full`, fixing F7 for the resume check too).
- **Dedupe at enqueue.**
  - an active job on the same `localDir` → 409 `already_downloading` with `existingJobId` (current semantics);
  - a verified library entry with the same identity (section 9.3) on any root → 409 `already_in_library` with `entryId`, unless `allowDuplicate: true`;
  - a non-empty target without a matching marker → 409 `target_occupied` (`prepareDownload`);
  - a matching marker → resume into it.
- **Restart semantics.**
  - `hub.stop()` (graceful) stops every in-process job with reason `shutdown` → `interrupted` (`autoResume: true`), releases locks and flushes synchronously.
  - `hub.start()` loads `downloads.json`. Jobs found in-process (crash) are orphan-checked (section 6.2) and set to `interrupted`.
  - After `queue.resumeDelaySeconds` (default 20, so the managers and the network come up first), `interrupted` jobs re-enter the queue in their original order. `queued`, `waiting` and `retrying` jobs keep their state, and timers are re-armed from `retry.nextAt`. `paused` jobs stay paused.
  - A job with `credentialMode: "temp-token"` whose `tokenRef` no longer resolves goes to `waiting/auth`. This happens after a restart when the token was not remembered (§12). The job is not failed and not spawned. It emits one `notification` ("需要重新输入 Hugging Face 令牌 / Re-enter the Hugging Face token") linking to `POST /api/hub/downloads/:id/resume { credential: { hfToken } }`.
  - This replaces "queue expired" and "no auto-resume after restart" (F6).
- **Pause / resume / cancel.**
  - Pause stops the process and keeps the files.
  - Resume re-enters the queue at the head of its priority band.
  - Cancel keeps files by default. `cancel { deletePartial: true, confirm: <outputName> }` deletes the target dir through `modelStorage.resolvePath(localDir, { allowRoot: false })` and `deletePartialDownload` rules: refused when another job, a migration lock or a running container mount uses the path (`getBusyPaths`). The response carries `reclaimedBytes`.
- **Busy-path visibility for migration.** `createStorageBusyPathProbe` (`model-storage-routes.js`) also reads `<AI_ROOT>/service-entry/data/hub/downloads.json` when its `writerPid` is alive and `heartbeatAt` is under 2 min old. Active states contribute `target.localDir`.

### 8.1 DownloadJob (persisted shape; the API returns the same minus `logs`)

```json
{ "schemaVersion": 1, "id": "dl_7k2m4q9x3c5vb8np", "legacyIds": [],
  "createdAt": "ISO", "updatedAt": "ISO", "startedAt": "ISO", "finishedAt": null,
  "origin": { "kind": "console|manager-shim|mcp|migration|library-update", "managerId": "llama", "requestId": "req_…" },
  "ownerManagerId": "llama",
  "state": "downloading", "waitReason": null, "phaseHistory": [ { "phase": "queued", "at": "ISO" } ],
  "priority": "normal", "queueOrder": 1792000000123, "pausedBy": null, "autoResume": true,
  "artifact": { "provider": "huggingface", "repo": "unsloth/Qwen3-8B-GGUF", "revision": "main", "revisionSha": "40-hex",
    "artifactKey": "gguf:|Q4_K_M", "kind": "gguf-quant", "format": "gguf", "quant": "Q4_K_M", "companions": ["mmproj-F16.gguf"],
    "files": [ { "path": "Qwen3-8B-Q4_K_M.gguf", "size": 5027783488, "sha256": "64-hex", "role": "weight" },
               { "path": "README.md", "size": 21043, "sha256": null, "gitOid": "40-hex", "role": "sidecar" } ],
    "totalBytes": 5028640000 },
  "target": { "rootId": "4f1c…", "rootLabel": "Library F", "outputName": "unsloth-Qwen3-8B-GGUF", "localDir": "X:\\models\\unsloth-Qwen3-8B-GGUF", "volume": "X:" },
  "transfer": { "engine": "cli", "cli": "hf", "attempt": 2, "batches": 1, "batchIndex": 0, "pid": 12345, "pidStartedAt": "ISO",
    "options": { "source": "huggingface", "endpoint": "https://huggingface.co", "xet": "high-performance", "credentialMode": "cached-login", "tokenRef": null, "remember": false },
    "optionsHistory": [] },
  "progress": { "bytesDone": 2071000000, "bytesTotal": 5028640000, "percent": 41.2, "speedBps": 131000000, "speedEmaBps": 126000000, "etaSeconds": 23,
    "filesDone": 1, "filesTotal": 3, "files": [ { "path": "Qwen3-8B-Q4_K_M.gguf", "bytes": 2070000000, "size": 5027783488, "state": "partial" } ],
    "verify": { "filesDone": 0, "filesTotal": 1, "bytesDone": 0 }, "samples": [[1792000000000, 0]], "lastGrowthAt": "ISO", "updatedAt": "ISO" },
  "retry": { "count": 1, "max": 3, "nextAt": null, "history": [ { "at": "ISO", "code": "stall" } ] },
  "error": null, "advice": null,
  "runAfter": null, "result": null, "logs": ["…"] }
```

A failed job's `error` is the §6.3 result: `{ "code": "hf_login_required", "baseCode": "hf_auth_invalid", "class": "auth", "retryable": false, "title": { "zh": "…", "en": "…" }, "hint": { "zh": "…", "en": "…" }, "actions": ["sign-in"], "detail": "401 Client Error … <redacted>", "at": "ISO" }`.


- `ownerManagerId` decides which manager's legacy `/api/jobs` lists the job, so platform-mcp counts it exactly once. It is the shim's `managerId`, or for other origins the engine hint (`gguf` → `llama`, anything else → `vllm`).
- Ids are `dl_` plus 16 base32 characters (00 §3).

## 9. Library registry (`library.js`)

### 9.1 Sources scanned

- Every `modelStorage.roots()` entry. A `library` root contributes one candidate per child directory (not dot-prefixed, not retired by an alias); a `model` root contributes itself.
- The HF cache: `hub/models--{org}--{name}`. One entry per repo with `snapshots[] { sha, files, bytes }` and `refs`.
- The ModelScope cache: `<HF_HOME>/modelscope/models/{org}/{name}`.
- A candidate qualifies when it has weights (`.gguf`, `.safetensors`, `.bin`) or `config.json`. Script-only folders are listed with `card.role = "tooling-only"` (from 02) and `runnable: false`.
- Scans are incremental, keyed by `(path, dir mtime, cachedDirSize)`. Triggers:
  - hub start (`library.rescanOnStart`);
  - job ready;
  - `POST /library/rescan`;
  - a root registered or a migration completed (detected by `model-storage.json` mtime change, polled every 60 s);
  - a library action.

### 9.2 LibraryEntry

```json
{ "id": "lib_9d1e6c0a5b2f4e17", "kind": "folder|hf-cache-repo|modelscope-cache|single-file",
  "path": "X:\\models\\Qwen-Qwen3.8-27B-FP8", "rootId": "4f1c…", "rootLabel": "Library F", "volume": "X:", "aliases": ["<AI_ROOT>\\models\\Qwen-Qwen3.8-27B-FP8"],
  "displayName": "Qwen3.8-27B-FP8", "format": "safetensors", "quant": "FP8", "bytes": 30012000000, "fileCount": 81, "mtime": "ISO",
  "provenance": { "provider": "huggingface", "transport": "huggingface", "repo": "Qwen/Qwen3.8-27B-FP8", "revision": "main",
    "revisionSha": "40-hex", "artifactKey": "st:", "downloadedAt": "ISO", "downloadJobId": "dl_…|null",
    "source": "hub-job|platform-marker|hf-local-metadata|legacy-ledger|migration-record|hf-cache-refs|user", "confidence": "declared|detected|unverified|unknown" },
  "files": [ { "path": "model-00001-of-00011.safetensors", "size": 2900000000, "sha256": "64-hex|null", "gitOid": null, "verifiedAt": "ISO|null" } ],
  "filesetHash": "64-hex", "identityKey": "hf:qwen/qwen3.8-27b-fp8@<sha>#<filesetHash>",
  "verification": { "status": "ok|warn|fail|unchecked", "checksum": "verified|partial|none", "checkedAt": "ISO", "issues": [] },
  "residue": { "incompleteFiles": 0, "incompleteBytes": 0 },
  "update": { "status": "unknown|current|available|unsupported|error", "remoteSha": null, "changedFiles": 0, "bytesToDownload": 0, "checkedAt": null },
  "card": { "cardId": "mc_…", "role": "main", "familyId": "qwen3.5-3.6", "compatibility": [ { "engineId": "vllm", "runtimeId": "vllm@0.28.0", "verdict": "ok" } ] },
  "duplicates": [], "lastLaunchedAt": null, "lastFailure": null, "previousIds": [] }
```

- `files[]` is capped at 5000 per entry. `id` is random at creation and kept across rescans: entries match by path first, then by `modelStorage.followAliases(oldPath) === newPath`, so a D:→F: migration keeps the id and the provenance.

### 9.3 Provenance backfill (precedence, first wins per field)

1. A hub job result (`hub-job`, `declared`).
2. Marker v2, then marker v1 (`{ model, source, precision, createdAt }`) → repo, provider, quant (`platform-marker`, `declared`).
3. Legacy manager ledgers: `<AI_ROOT>/{vllm,llama}-manager/logs/jobs-ledger.json` download jobs. `meta.localDir` is mapped through `followAliases`, and `service-entry/data/model-migrations/*.json` source→target is consulted for paths retired by migration. Source `legacy-ledger`, `declared`.
4. `<dir>/.cache/huggingface/download/*.metadata`:
   - line 1 (the majority value) → `revisionSha`;
   - line 2: 64-hex → `files[].sha256`, 40-hex → `gitOid` (`hf-local-metadata`).
   These files carry no repo id. When steps 1–3 found none, the candidates are `owner-name` and `owner__name` derived from the folder name. They are confirmed only on demand (`POST /library/:id/identify`, or in the background when `library.identifyOnline` is set) by `GET /api/models/{candidate}/revision/{sha}` returning 200 → `detected`. Unconfirmed → `unverified`.
5. HF cache: `models--org--name` → repo; snapshot dir = sha; `refs/main` → current (`hf-cache-refs`, `declared`).

- **Fileset hash.** `filesetHash = sha256(sorted lines "path\tsize\tsha256|gitOid|-")`. Identity: `identityKey = "<hf|ms>:<repo lowercased>@<revisionSha>#<filesetHash>"`; `huggingface` and `hf-mirror` share `hf`.
- **Duplicates.** Entries sharing an `identityKey`, or sharing a `filesetHash` whose weight files all have a sha256, are linked in `duplicates[]`. Nothing is ever deleted automatically.

### 9.4 Update check by SHA

- `checkUpdate(id)` calls `provider.getRepo(repo, { revision: provenance.revision || "main" })`. It compares `revisionSha` and diffs the entry's selection by path and sha256/gitOid, producing `{ status: "available"|"current", remoteSha, changedFiles, bytesToDownload }`.
- Entries with no repo → `unsupported` (with an "identify" action). The legacy timestamp comparison (`server.js:1103-1136`) is retired.
- `update(id)` enqueues a job into the same folder at the new SHA with `origin.kind = "library-update"`. The CLI skips files whose local etag matches, so only the changed files transfer.
- Background checks follow `library.updateCheck` (`manual` default, or `weekly`).

### 9.5 Library actions

| action | behaviour | guards |
|---|---|---|
| verify | structure + size; sha256 when `checksums: true` (worker task) | owner (it starts a task); viewers read results only |
| identify | set or confirm repo/provider (user input, or a candidate checked against the hub) | owner |
| check-update / update | section 9.4 | owner for update |
| cleanup-residue | `cleanupIncompleteFiles(entry.path)` | 409 when a job is active, paused or retrying on the path (existing rule) |
| import (HF cache → root) | copy the snapshot's real blob files into `<root>/<outputName>`, hashing as it copies; write marker v2 with provenance; keep the cache copy | `downloadTarget` validation; target-occupied rule |
| delete | folder: remove the directory; HF cache repo: remove `models--…` | `confirm` must equal `displayName`; `resolvePath(..., { allowRoot: false })`; refused when busy (`getBusyPaths`: active jobs, migration locks, mounted containers); never stops a container |
| move | deep-link to the existing migration planner (`/model-storage`); the id persists through the alias | (existing) |

Long actions (verify with checksums, import, rescan, delete) are hub *tasks*: in memory, `{ id: "tsk_…", kind, entryId, state, progress, error }`, progress sent through the `library` SSE event, and idempotent if repeated after a restart.

## 10. Fit and compatibility (02's API, adapted by `fit.js`)

The hub contains no estimator. `fit.js` adapts 02's API, which is exposed as the namespace `core.models` (like 01's `core.engines`, not flat-exported):

```js
// manager-core/model-hub/fit.js; `models` is core.models, injected by the entry (null before 02 lands)
models.inspectRemote({ source, repo, revision: revisionSha, files }, { fetchImpl: provider.fetchImpl, endpoint: provider.apiBase, signal }) → ModelCard
models.inspectLocal(localDir, { depth: "quick" })                                                                                    → ModelCard
models.estimateFit({ card, legacy, engineId, launch: { maxModelLen, gpuIds, kvCacheDtype: "auto" }, host: { gpus } })              → FitResult  (02 §10.1, with `spill`)
models.evaluateCompatibility(card, await getCompatibilityContext())                                                                 → CompatibilityRow[]  (02 §9)
```

- **Credentials.** `source` is the namespace (`huggingface` or `modelscope`). The mirror is a transport, so `endpoint` is the chosen provider's `apiBase` and `fetchImpl` is that provider's `authorizedFetch`. The hub never passes `token`. `fetchImpl` attaches credentials only for `huggingface.co` hosts and strips them on redirects (§17), which keeps 02's Range reads under the same guard. `files` limits header reads to the artifact's files.
- **Context.** `getCompatibilityContext` is built by the entry from 02's wiring: the aggregated `/api/engines`, runtime facts, knowledge and host records. Host records are owned by the entry (02 §13). The hub reads them only through this context and never writes them.

**Hub fit label** (`fit.labelOf(fitResult)`). This is the only mapping from 02's status.

| 02 `FitResult` | hub `fit.label` | zh / en |
|---|---|---|
| no card and no `legacy` input | `unknown` | 未知 / Unknown |
| `status: "ok"` | `fits` | 可放下 / Fits |
| `status: "warn"`, `spill: false` | `tight` | 偏紧 / Tight |
| `status: "warn"`, `spill: true` | `spills` | 需卸载到内存 / Spills to RAM |
| `status: "fail"` | `wont-fit` | 放不下 / Won't fit |

The hub `fit` object is `{ label, status, spill, neededMb, perGpuMb, range, policy, confidence, headroomMb, overflowMb, suggestions, basis }`.
- `neededMb` is 02's `admissionRequestMb`.
- `basis` is `card` (from a remote or local card), `params` (from params and bytes only) or `bytes` (the fallback).

| Call site | Inputs | basis |
|---|---|---|
| search item `fitHint` | No remote inspection (02 O2). `estimateFit({ card: null, legacy: { paramsB, bytesPerParam } })`. For GGUF, `bytesPerParam` is 0.5625 (Q4 class); for safetensors it comes from `usedStorage / params` | `params` |
| repo detail, the recommended candidate | One `inspectRemote` per `(repo, revisionSha)`, with the files of the largest complete artifact; `contextTokens` from the query (default 32768); all GPUs | `card` |
| repo detail, every other artifact | `legacy: { paramsB, bytesPerParam: artifact.bytes / params }` | `params` |
| plan sheet | `inspectRemote` with the selected artifact's files, plus the selected `engineId`, `gpuIds` and context | `card` |
| completion line, library row | `inspectLocal(localDir)`, cached by 02 on `(path, size, mtime)` | `card` |

- **Compatibility rows** pass through in 02's shape: `verdict`, `supportEvidence`, `reasons[{ code, level, message{zh,en} }]` and `actions`. The hub's own engine badges (§13.2) are only a format hint, labelled `basis: "format"`.
- **Fallback until 02 merges.** When `models === null`, `fit.js` calls `gguf-variants.js#fitFor` on bytes. `exceeds` maps to `wont-fit` and everything else to `fits`; the fallback never produces `tight` or `spills`. It reports `policy: "bytes-heuristic"`, `confidence: "name-heuristic"` and `basis: "bytes"`. Compatibility rows are `unknown`, with reason `inspector_unavailable`. HUB-10 deletes the fallback when 02 is in the integration branch.

## 11. Download & Run

`plan.runAfter` (request):

```json
{ "engineId": "llamacpp", "managerId": null, "recipeId": null, "values": { "contextLength": 32768 }, "acceptWarnings": false, "allowReplace": false }
```

**Plan time (advisory)**
- The hub resolves `managerId` from the entry's aggregated `GET /api/engines` (01 ENG-19). Until that lands, `gguf` maps to `llama` and anything else to `vllm`.
- It calls that manager's `POST /api/launch/plan` (01 §11, 00 §4.3) directly on loopback with `x-request-id`. The body is a LaunchRequestV2 in 01's prospective form, so the plan needs no artifact on disk:
  ```json
  { "engineId": "llamacpp", "recipeId": null, "prospective": true, "model": { "card": { "…": "remote ModelCard from §10" } },
    "instance": { "mode": "replace" }, "values": { "contextLength": 32768 } }
  ```
- The plan sheet shows the plan's `admission.verdict`, `errors` and `planHash`. A `block` verdict makes Download & Run unavailable and gives the reason. Download alone stays available.

**Completion (authoritative)**
- `runAfter.state: planning` sends a real `POST /api/launch/plan` with `model: { ref: <localDir> }` and no `prospective` flag.
- A `block` verdict, or `warn` without `acceptWarnings`, sets `failed` with the plan errors.
- `needs-confirmation` is set, with a `notification` linking to `POST /api/hub/downloads/:id/run { confirmReplace: true }`, in two cases:
  - the plan would replace a running instance and `allowReplace` is false;
  - the plan names a different instance than the one confirmed.
- Otherwise the hub sends `POST /api/start` with the same LaunchRequestV2 (the same resolver, per 00) and sets `started`, recording `launchJobId`, `launchId` and `planHash`.

**Hard rules**
- The hub never calls stop endpoints and never removes containers.
- Requests carry `x-request-id`.
- Failures stay in `runAfter` and do not change the download's `ready` state.

**Prerequisite.** Until 01's plan API with `prospective` is in the integration branch, `runAfter` returns 422 `run_after_unavailable` at plan time. The hub detects this once per manager: a 404 on the route or a 400 naming `prospective`.

## 12. Hugging Face authentication and tokens (one shared flow)

- **Login.** The vLLM-only login card and gated recheck (`vllm-manager/server.js:1246-1280`) move behind hub routes for both engines. `auth.js` uses `createHfAuthService({ hfCli, hfHome })` unchanged. The login runs in a local PowerShell window, so the token never passes through the web UI.
- **Access check.** It probes the first weight file of the selected artifact, not `config.json`. This fixes the llama/vLLM probe drift and works for GGUF repos.
- **Temporary token** (`tokens.js`). The policy is 08 P0-9: memory-only by default.
  - **Where it is accepted.** Only as `credential.hfToken` on `POST /api/hub/plan`, `POST /api/hub/downloads` and `POST /api/hub/downloads/:id/resume`. The caller must be one of:
    - an owner on a loopback, non-proxied socket;
    - `system:hub-shim` with a signed `origin.clientLocal: true` (§15).

    Anything else gets 403 `token_requires_local`.
  - **Storage.** `tokens.put(token, { remember })` returns `tokenRef = "dlt_<16 base32>"`.
    - Without `credential.remember`, the token exists only in the vault's in-memory `Map`.
    - With `credential.remember: true`, it is also written to `secretStore.set("hf", tokenRef, token)` (06 OPS-3 `manager-core/secret-store.js`: DPAPI CurrentUser, owner-only ACL, `<AI_ROOT>/.runtime/secrets/`, excluded from release and backup).
    - With no `secretStore`, `remember` gives 422 `remember_unavailable`.
  - **Release.** `tokens.release(tokenRef)` runs on `ready`, on `cancelled`, on job removal, and 7 days after `failed`. `sweep(jobs)` runs at start and then hourly. Releasing a remembered token deletes it from the secret store.
  - **After a restart.** Tokens that were not remembered are gone. The job waits in `waiting/auth` (§8), and a `resume` with a new `credential.hfToken` re-arms it.
  - **Never echoed.** APIs expose only `credentialMode: "temp-token"` and `remember`. `tokens.values()` feeds the redactor (§17).
- **Mirrors.** Mirror sources never use tokens (section 6.2). Gated repos plan the official endpoint with a visible note.
- **No legacy store.** The hub never reads or writes `runtime-secret-store.js` or `logs/runtime-secrets.json`.

## 13. Entry HTTP API (`service-entry/lib/hub-routes.js`)

**Routing**
- `createHubRoutes({ hub, auth, internalAuth, viewerAllowlist }) → { handle(req, res, url) → Promise<boolean> }`.
- It is mounted for the prefix `/api/hub/` by one line in ENT-EV's route-mount table in `service-entry/server.js`. The mount sits after the proxied-request guard and before the final 404.
- JSON bodies are capped at 64 KiB.
- Errors use the 00 §4.2 envelope, with `error.code` from the taxonomy and `error.details` for structured data.
- The hub publishes only through `events.publish("downloads" | "library" | "notification", payload)`. It never touches the SSE transport, the ring buffer or the manager relay, which all belong to ENT-EV.

### 13.1 Access, principals and viewer registrations

Principal resolution runs in this order.

1. **Proxied request** (forwarded headers, or the PUBLIC listener) → 404, from the existing guard. Public traffic never reaches hub routes.
2. **Signed internal request** (05 `internal-auth.js` headers). The check is `verifyInternalRequest(req, rawBody, key, { principals: ["system:hub-shim"], allowedManagers: ["vllm", "llama"], pathPrefixes: ["/api/hub/"] })`.
   - It requires a loopback socket, a timestamp within ±60 s and a matching sha256 body hash (F15).
   - Success yields principal `system:hub-shim`, with `managerId` taken from the signed header.
   - If signature headers are present but invalid, the result is 401 `internal_auth_failed`. It is never downgraded to viewer.
   - Until PUB-5 centralizes this in `authenticate(req)`, hub-routes calls `verifyInternalRequest` itself. After that, it reads PUB-5's result.
3. **Everything else** goes through `auth.checkManagementAccess(req, { write })`. Once 05 PUB-5 lands, this returns `owner`, or `viewer` with `redact`. Before PUB-5 it is today's loopback-admin rule (F13).

| principal | allowed |
|---|---|
| `owner` (session plus CSRF, or a tool token) | Every route. `auth/huggingface/login` and `credential.hfToken` are allowed only from a loopback socket. |
| `system:hub-shim` | Exactly the hub routes named in the §15 table, kept as the explicit list `SHIM_ROUTES` in `hub-routes.js`. `origin.kind` is forced to `manager-shim`, and `origin.managerId` comes from the signature. `credential.hfToken` and `login` are allowed only when the signed body has `origin.clientLocal: true`. Any other route gives 403 `principal_route_forbidden`. |
| `viewer` (loopback, or LAN anonymous) | The GET registrations below, through their redactors. Every write gives 401 `admin_session_required` (PUB-5), or 403 before PUB-5. |

**Viewer registrations.**
- These go into 05's `service-entry/lib/viewer-allowlist.js` registry. `hub-routes.js` exports them as data (`HUB_VIEWER_ROUTES`) and registers them at mount time.
- 05's test fails for any entry GET route that is neither registered nor admin-only.
- The call names follow 05 (assumed `register({ owner, method, path, redact })`, `adminOnly(…)`, `registerEvent({ owner, type, redact })`). This table is authoritative.

| GET route or event type | viewer | redaction |
|---|---|---|
| `/api/hub/status` | yes | drop `cli.*.path`, `dataDir` and `dataErrors[].file` |
| `/api/hub/search`, `/repos/:p/:o/:n`, `/readme`, `/files` | yes | public metadata; `fetchedFrom` kept, `warnings[].detail` dropped |
| `/api/hub/downloads`, `/downloads/history`, `/downloads/:id` | yes | `target.localDir` → `rootLabel/outputName`; drop `transfer.pid`, `transfer.options.tokenRef`, `error.detail` and `logs` |
| `/api/hub/downloads/:id/resume-check` | yes | paths → root-relative |
| `/api/hub/library`, `/library/:id` | yes | `path` and `aliases[]` → `rootLabel/relative` |
| `/api/hub/tasks/:id` | yes | drop `error.detail` |
| `/api/hub/storage/usage` | yes | drop `roots[].path`, `hfCache.path` and `orphanPartials[].path`; `models[].path` → `rootLabel/relative` |
| `/api/hub/settings` | yes | none (settings hold no secrets) |
| `/api/hub/auth/huggingface` | yes | `{ connected }` only |
| `/api/hub/auth/huggingface/access` | yes | `{ granted, status }` only |
| `/api/hub/migration` | yes | counts only |
| `/api/hub/downloads/:id/logs` | admin-only (owner) | — |
| event `downloads` | yes | the downloads redactor, applied to each job |
| event `library` | yes | entry ids and task progress only |

**Routes.**

| Method + path | Purpose | Request → response (abridged) |
|---|---|---|
| GET `/api/hub/status` | health, counts, CLI versions, owner mode | `{ ok, owner: "hub", active, queued, waiting, speedBps, cli: { hf: { path, version }, modelscope: {…} }, dataDir, dataErrors: [], migration: { done }, features: { runAfter, rememberToken, models } }` |
| GET `/api/hub/search` | search with cursor and facets | query `q, provider=huggingface\|modelscope, sort=trending\|downloads\|likes\|updated, limit≤60 (24), cursor, facet=key:value (repeatable), context=32768` → section 13.2 |
| GET `/api/hub/repos/:provider/:owner/:name` | repo detail with quant table and fit | `?revision=main&context=&gpuIds=&engineId=` → section 13.3 |
| GET `/api/hub/repos/:provider/:owner/:name/readme` | rendered by the client | `{ markdown, truncated, revisionSha }` |
| GET `/api/hub/repos/:provider/:owner/:name/files` | file tree, paged | `?cursor=&limit≤2000` → `{ files[], nextCursor }` |
| POST `/api/hub/resolve-link` | paste an HF/ModelScope URL | `{ url }` → `{ provider, repo, revision, file? }` (replaces `/api/resolve-model-link` logic) |
| POST `/api/hub/plan` | plan sheet (no side effects) | section 13.4 |
| POST `/api/hub/downloads` | enqueue | `{ planId }` or the full plan body (+ `allowDuplicate`) → `201 { ok, job }`; 422 when `blocking` is non-empty |
| GET `/api/hub/downloads` | active, queued and recent | `?state=a,b&owner=llama&include=terminal&limit≤200&cursor` → `{ jobs[], aggregate: { activeCount, queuedCount, speedBps, etaSeconds }, nextCursor }` |
| GET `/api/hub/downloads/history` | compacted history | `?q=&provider=&state=&cursor` → `{ records[], nextCursor }` |
| GET `/api/hub/downloads/:id` | detail | `{ job }` (`:id` also matches `legacyIds`) |
| GET `/api/hub/downloads/:id/logs` | log tail | `?tail≤2000` → `{ lines[], total }` (owner only; lines already redacted) |
| POST `/api/hub/downloads/:id/pause` / `resume` / `retry` / `start-now` | queue ops | resume: `{ refreshTransferOptions?: bool, source?: "hf-mirror"\|…, credential?: { hfToken, remember } }` → `{ ok, job }`; a `waiting/auth` job needs `credential` (§12) |
| POST `/api/hub/downloads/:id/cancel` | cancel | `{ deletePartial?: bool, confirm?: outputName }` → `{ ok, job, reclaimedBytes }` |
| POST `/api/hub/downloads/:id/priority` | priority | `{ priority }` |
| POST `/api/hub/downloads/reorder` | drag reorder | `{ ids: [...] }` (queued and waiting only) |
| POST `/api/hub/downloads/pause-all` / `resume-all` | bulk | `{ ok, affected }` |
| DELETE `/api/hub/downloads/:id` | drop a terminal record to history | `{ ok }` |
| GET `/api/hub/downloads/:id/resume-check` | per-file health before resume | `inspectDownloadResume` result, with disk free from the job's volume |
| POST `/api/hub/downloads/:id/run` | confirm Download & Run | `{ confirmReplace: true }` → `{ ok, runAfter }` |
| GET `/api/hub/library` | library list | `?q=&rootId=&format=&provenance=&duplicates=1&cursor` → `{ entries[], roots[], nextCursor }` |
| GET `/api/hub/library/:id` | entry detail | `{ entry }` |
| POST `/api/hub/library/rescan` | rescan | `{ rootIds? }` → `{ taskId }` |
| POST `/api/hub/library/:id/verify` | verify | `{ checksums: bool }` → `{ taskId }` |
| POST `/api/hub/library/:id/check-update` | update check | → `{ update }` |
| POST `/api/hub/library/:id/update` | enqueue an update | → `{ job }` |
| POST `/api/hub/library/:id/identify` | set provenance | `{ provider, repo }` → `{ entry }` |
| POST `/api/hub/library/:id/import` | HF cache → library | `{ rootId, outputName }` → `{ taskId }` |
| POST `/api/hub/library/:id/cleanup-residue` | remove `.incomplete` files | → `{ removed[], removedBytes }` |
| DELETE `/api/hub/library/:id` | delete | `{ confirm }` → `{ taskId }` |
| GET `/api/hub/tasks/:id` | task progress | `{ task }` |
| GET `/api/hub/storage/usage` | root-aware usage | section 13.5 |
| POST `/api/hub/storage/cleanup` | residues and orphan partials | `{ targets: [{ kind: "incomplete", entryId } \| { kind: "partial-download", jobId }], confirm: true }` → `{ reclaimedBytes, results[] }` |
| GET/PUT `/api/hub/settings` | global settings | section 14 |
| GET `/api/hub/auth/huggingface` | login status | `{ connected, username, orgs, source }` |
| POST `/api/hub/auth/huggingface/login` | open the local login window | `{ launched, tokenUrl }` (loopback only) |
| GET `/api/hub/auth/huggingface/access` | gated access | `?repo=&artifactKey=` → `{ granted, status, authorizationUrl }` |
| POST `/api/hub/sources/probe` | informational speed probe | `{ repo?, artifactKey? }` → `{ sources: [{ source, ok, ms, bytesPerSec, error }], recommended, at }` (cached 10 min; never persists settings) |
| GET `/api/hub/migration` | import status | `{ steps: [{ id, done, at, counts }] }` |

### 13.2 Search response

```json
{ "ok": true, "provider": "huggingface", "fetchedFrom": "https://huggingface.co",
  "items": [ { "provider": "huggingface", "repo": "unsloth/Qwen3-8B-GGUF", "author": "unsloth", "task": "text-generation",
      "formats": ["gguf"], "quants": ["Q4_K_M", "Q8_0"], "paramsB": 8.19, "downloads": 120000, "likes": 300, "lastModified": "ISO",
      "gated": false, "tags": ["gguf"], "baseModel": "Qwen/Qwen3-8B", "familyKey": "qwen/qwen3-8b",
      "fitHint": { "label": "fits", "status": "ok", "neededMb": 6100, "basis": "params" }, "engines": ["llamacpp"],
      "library": { "state": "absent|present|partial|update-available", "entryId": null } } ],
  "families": [ { "familyKey": "qwen/qwen3-8b", "repos": ["Qwen/Qwen3-8B", "unsloth/Qwen3-8B-GGUF"] } ],
  "facets": { "format": [ { "value": "gguf", "count": 18 } ], "engine": [], "fit": [], "task": [], "updated": [], "size": [] },
  "nextCursor": "opaque", "partial": false, "warnings": [] }
```

- **Facet keys.** `format` (gguf, safetensors, fp8, nvfp4, mxfp4, awq, gptq, bnb), `engine` (an engineId), `fit` (fits, tight), `task`, `size` (lt8b, 8-16b, 16-40b, 40-80b, gt80b), `updated` (7d, 30d, 90d, 365d; relative, replacing the year literals), `gated`, `modality` (vision, audio), `moe`.
- **Provider-native vs post-filtered.** HF native: `format=gguf` → `filter=gguf`, `task` → `pipeline_tag`, `sort` → `trendingScore|downloads|likes|lastModified`. Everything else is filtered server-side; the hub fetches up to 3 provider pages to fill `limit` (`partial: true` when short).
- **Facet counts** cover the returned items ("in these results").
- **Cursor.** `base64url(JSON { v: 1, p, c: providerCursor, o: offsetInPage, h: sha1(normalized query) })`. A changed query → 400 `cursor_mismatch`.
- **Engine badges.** Format → engines comes from data (02 knowledge when present; otherwise gguf → llamacpp, safetensors-family → vllm and sglang, labelled `basis: "format"`). The llama shim's " GGUF" suffix (`remote-models.js:494`) becomes `facet=format:gguf`.

### 13.3 Repo detail response

```json
{ "ok": true, "provider": "huggingface", "repo": "unsloth/Qwen3-8B-GGUF", "revision": "main", "revisionSha": "40-hex", "fetchedFrom": "…",
  "summary": { "task": "text-generation", "license": "apache-2.0", "baseModel": "Qwen/Qwen3-8B", "paramsB": 8.19, "contextLength": 40960, "lastModified": "ISO" },
  "access": { "gated": false, "status": "not_required|granted|login_required|approval_required|official_required|unknown", "authorizationUrl": null },
  "files": { "count": 37, "totalBytes": 175000000000, "truncated": false },
  "artifacts": [ { "artifactKey": "gguf:|Q4_K_M", "kind": "gguf-quant", "label": "Q4_K_M", "format": "gguf", "quant": "Q4_K_M",
      "bytes": 5027783488, "fileCount": 1, "multiPart": false, "complete": true,
      "companions": { "mmproj": [ { "path": "mmproj-F16.gguf", "size": 1100000000 } ], "draft": [] },
      "fit": { "label": "fits", "status": "ok", "spill": false, "neededMb": 7400, "confidence": "exact", "policy": "gguf-estimate", "basis": "card" },
      "engines": [ { "engineId": "llamacpp", "basis": "format" } ],
      "recommended": true, "library": { "state": "absent", "entryId": null } } ],
  "card": { "cardId": "mc_…", "identity": {}, "role": "main", "evidence": [] },
  "compatibility": [ { "engineId": "llamacpp", "runtimeId": "llamacpp@b10630", "verdict": "unknown", "supportEvidence": [],
      "reasons": [ { "code": "arch_not_in_knowledge", "level": "unknown", "message": { "zh": "…", "en": "…" } } ], "actions": [ { "kind": "probe" } ] } ],
  "siblingRepos": [ { "repo": "Qwen/Qwen3-8B-FP8", "precision": "FP8" } ], "warnings": [] }
```

- **Recommended.** At most one artifact gets `recommended: true`: the largest artifact whose `fit.label` is `fits` for the selected GPUs and context, with ties going to the higher quant. Only the recommended candidate has `basis: "card"` in the detail response; the others use `basis: "params"` until the plan sheet inspects them (§10).
- **Sibling repos.** `siblingRepos` reuses `precision-variants.js#groupPrecisionVariants` over a mirror-aware search.

### 13.4 Plan

Request:

```json
{ "provider": "huggingface", "repo": "unsloth/Qwen3-8B-GGUF", "revision": "main",
  "selection": { "artifactKey": "gguf:|Q4_K_M", "companions": ["mmproj-F16.gguf"], "files": null },
  "target": { "rootId": null, "outputName": null },
  "source": "auto|huggingface|hf-mirror|modelscope", "transfer": { "xet": null },
  "credential": { "mode": "auto|cached-login|temp-token|none", "hfToken": null, "remember": false },
  "fit": { "contextTokens": 32768, "gpuIds": null, "engineId": null },
  "runAfter": null, "priority": "normal" }
```

Response:

```json
{ "ok": true, "planId": "pln_…", "expiresAt": "ISO",
  "artifact": { "artifactKey": "gguf:|Q4_K_M", "files": [], "totalBytes": 6127783488, "bytesToDownload": 6127783488, "revisionSha": "40-hex" },
  "target": { "rootId": "4f1c…", "rootLabel": "Library F", "localDir": "X:\\models\\unsloth-Qwen3-8B-GGUF", "volume": "X:",
              "freeBytes": 1300000000000, "reserveBytes": 65000000000, "queuedOnVolumeBytes": 0, "freeAfterBytes": 1293872216512 },
  "existing": { "state": "absent|present|partial|update-available|duplicate-elsewhere", "entryId": null, "message": "" },
  "source": { "chosen": "huggingface", "endpoint": "https://huggingface.co", "reason": "policy", "probe": null },
  "access": { "gated": false, "status": "not_required", "credentialMode": "cached-login", "authorizationUrl": null },
  "fit": {}, "compatibility": [],
  "eta": { "seconds": 47, "basisBps": 130000000, "basis": "recent-average|probe|unknown" },
  "runAfter": null,
  "blocking": [ { "code": "disk_full", "message": "…", "hint": "…", "actions": ["choose-root", "open-storage"] } ],
  "warnings": [ { "code": "custom_code", "message": "This repository ships Python files that run with trust_remote_code", "files": ["modeling_x.py"] } ] }
```

- `outputName` defaults to `owner-name`, matching the live library folders. `rootId` defaults to `model-storage.json` `defaultRootId`.
- `eta.basisBps` is the median `speedEmaBps` of the last 5 completed jobs from the same source.
- Plans are cached for 10 minutes (LRU 64). `downloads` re-validates the target, disk and manifest SHA when enqueuing from a `planId`.

### 13.5 Storage usage

The shape extends 08 P0-DL-3's `getDiskUsage` (`roots[]` with `id`, and `models[].rootId`), which the console and the shims share. There is no `volumes[]`. The drive is the per-root field `volume`, and the console groups by it.

```json
{ "ok": true,
  "roots": [ { "id": "4f1c…", "label": "Library F", "path": "X:\\models", "default": true, "legacy": false, "volume": "X:",
               "freeBytes": 1300000000000, "totalBytes": 4000000000000, "usedByModelsBytes": 2400000000000, "modelCount": 9,
               "incompleteBytes": 0, "pendingBytes": 0, "reserveBytes": 65000000000, "projectedFreeBytes": 1300000000000 } ],
  "models": [ { "name": "Qwen-Qwen3.8-27B-FP8", "path": "X:\\models\\Qwen-Qwen3.8-27B-FP8", "rootId": "4f1c…", "sizeBytes": 30012000000, "incomplete": false, "entryId": "lib_…" } ],
  "hfCache": { "path": "<AI_ROOT>\\cache\\huggingface", "volume": "D:", "freeBytes": 675000000000, "hubBytes": 21000000000, "xetBytes": 0, "modelscopeBytes": 0 },
  "residues": [ { "entryId": "lib_…", "rootId": "4f1c…", "incompleteFiles": 2, "incompleteBytes": 4000000000, "busy": false } ],
  "orphanPartials": [ { "jobId": "dl_…", "rootId": "4f1c…", "path": "…", "bytes": 12000000000, "reason": "failed|cancelled" } ],
  "duplicates": [ { "entryIds": ["lib_a", "lib_b"], "reclaimableBytes": 30000000000 } ], "updatedAt": "ISO" }
```

- The 08 fields keep 08's meaning. The hub adds `volume`, `incompleteBytes`, `pendingBytes` (the remaining bytes of active jobs targeting the root), `reserveBytes` and `projectedFreeBytes`, plus the top-level `hfCache`, `residues`, `orphanPartials` and `duplicates`.
- Two roots on the same drive report the same `freeBytes`. `pendingBytes` and `reserveBytes` are computed per drive (§8) and repeated on each root of that drive.
- `roots[]` lists every registered root with the default first, as 08 does. An empty, non-default legacy root carries `hidden: true` unless `storage.showLegacyRootWhenEmpty` is set, and the console omits hidden roots. Its container mount (`/models`) is untouched.

## 14. Settings (`settings.json`; GET/PUT `/api/hub/settings`)

```json
{ "schemaVersion": 1,
  "sources": { "policy": "huggingface", "hfEndpoint": "https://huggingface.co", "mirrorEndpoint": "https://hf-mirror.com", "modelScopeEndpoint": "https://www.modelscope.cn", "gatedUsesOfficial": true },
  "transfer": { "xet": "high-performance", "maxConcurrent": 1, "stallMinutes": 10, "materializeStallMinutes": 20 },
  "verify": { "sha256": true },
  "retry": { "maxAttempts": 3, "baseDelaySeconds": 10, "maxDelaySeconds": 600, "perClass": { "network": true, "server": true, "watchdog": true, "integrity": true, "tooling": "once" } },
  "queue": { "idleOnly": false, "idleGraceSeconds": 30, "resumeOnStart": true, "resumeDelaySeconds": 20 },
  "storage": { "reserveGb": 10, "showLegacyRootWhenEmpty": false },
  "history": { "keepRecords": 200, "retentionDays": 365 },
  "library": { "rescanOnStart": true, "updateCheck": "manual", "identifyOnline": false },
  "notifications": { "onReady": true, "onFailure": true } }
```

- **PUT** takes a partial patch and returns the full settings or 400 with per-field `errors[]` (00 §4.2).
- **Validation.** Endpoints must be `https:`, with no userinfo, query or fragment. Loopback `http:` is allowed only when `NODE_ENV=test`.
- **Legacy mapping** (`settings.fromLegacy`/`toLegacy`, used by migration and by the `/api/download/settings` shim):

| legacy key | hub |
|---|---|
| `queueMode: true/false` | `transfer.maxConcurrent: 1 / 3` (legacy "off" was unlimited; capped at 3) |
| `autoRetryCount` (0–10) | `retry.maxAttempts`; 0 disables all classes |
| `autoRetryDelaySeconds` | `retry.baseDelaySeconds` |
| `hfMirror: true/false` | `sources.policy: "hf-mirror" / "huggingface"` |
| `hfTransfer: true/false` | `transfer.xet: "high-performance" / "default"` |
| `verifyChecksums` | `verify.sha256` |
| `idleOnlyQueue` | `queue.idleOnly` |

## 15. Compatibility shims (managers, `model-hub/shim.js`)

- **Gate.** In hub mode each manager calls `registerHubShimRoutes(app, { managerId, client, isLocalRequest })` *instead of* the download parts of `registerModelRoutes`/`registerJobRoutes`. The manager's own `managerSecurityGuard` has already authorized the request (00 §5: managers keep their `isLocalRequest` gate).
- **Client** (`createHubClient({ baseUrl: "http://127.0.0.1:5176", managerId, internalAuth, timeoutMs })`).
  - Every call is signed as machine principal `system:hub-shim`. The headers come from `internalAuth.buildInternalRequestHeaders(key, method, path, managerId, body, { principal: "system:hub-shim" })`, covering method, path, manager id, timestamp and sha256(body) (05 `manager-core/internal-auth.js`, F15).
  - The key is read through internal-auth from the single secret store (06 OPS-3). Before that lands, it is today's gateway trust token.
  - There is no unauthenticated header. The former `x-hub-shim` is gone, so a local process cannot claim to be a shim without the key.
  - Each call also carries `x-request-id` (propagated or generated) and a 10 s timeout (1.5 s for job lists).
- **Origin.** The signed JSON body carries `origin: { kind: "manager-shim", managerId, clientLocal: isLocalRequest(req) }`. `clientLocal` is the manager's verdict on its own caller, so a LAN user of a manager with `*_ALLOW_REMOTE=1` cannot pass an HF token or open the login window (§12).
- **Scope.** The entry accepts the shim principal only on `SHIM_ROUTES` (§13.1). These are the hub calls in the table below, which managers could already perform locally before the hub existed. Destructive calls still need their `confirm` values.
- **Hub down.** If the entry is unreachable, the shim returns 503 `{ error, code: "hub_unavailable" }` (the legacy `{ error, code }` shape), with copy "service-entry is not running" / "统一入口未运行". There is no silent fallback to the legacy queue, which would bring back two queues.
- **Signature rejected.** 401 `internal_auth_failed` maps to 503 `{ code: "hub_auth_failed" }`, with copy "统一入口拒绝了管理器的签名，请重启平台 / service-entry rejected the manager's signature; restart the platform". It is logged once per minute.

| legacy route | hub call | legacy response kept |
|---|---|---|
| POST `/api/download` | `selectionFromLegacy` → `POST /downloads` (`origin.managerId`; `hfToken` → `credential.hfToken` only when `clientLocal`) | `{ job: toLegacyJob(job) }`; errors `{ error, code, existingJobId?, authorizationUrl?, accessStatus?, suggestions? }`; zero match → 422 `filter_no_match` (the P0-RT-6 shape) |
| GET `/api/download/estimate` | `POST /plan` | `{ source, model, precision, bytes, fileCount, includePatterns, filtered, matchedFiles, totalFiles, supported: true, diskFreeBytes }` (ModelScope becomes `supported: true`) |
| GET `/api/download/precheck` | stays local (`assessDownloadCompatibility`), but siblings and config come from `GET /repos/...` (mirror-aware) | unchanged until 02 replaces the assessment |
| GET `/api/remote-models` | `GET /search` (+`facet=format:gguf` for `llama`) | `{ models: [legacy summary], limit, source, sort }`, mapped by `toLegacyRemoteModel` (`id, author, downloads, likes, tags, pipelineTag, paramsB, fileSizeBytes, quantFormats, gated, url, runnable`) |
| GET `/api/remote-models/gguf-variants` | `GET /repos/...` artifacts of kind `gguf-quant` | `{ model, source, supported, gated, selected, variants[{ quant, directory, files≤12, bytes, fileCount, multiPart, complete, fit, vllmLoadable }], mmproj, drafts, other, totalFiles }`; `fit` is the legacy `fitFor` value derived from `fit.label` (`wont-fit` → `exceeds`) |
| GET `/api/remote-models/precision-variants` | `GET /repos/...siblingRepos` | the existing `groupPrecisionVariants` shape |
| GET/POST `/api/download/settings` | `GET/PUT /settings` + `toLegacy`/`fromLegacy` | the legacy 7-key object |
| POST `/api/download/mirror-probe` | `POST /sources/probe` | `{ ok, repo, file, official, mirror, modelscope, sources, recommended, recommendedLabel, at }`; never persists settings (as after P0-UI-3) |
| POST `/api/resolve-model-link` | `POST /resolve-link` | the existing shape |
| GET `/api/models/disk-usage` | `GET /storage/usage` | 08 P0-DL-3's shape: the legacy top-level fields for the default root, plus `roots[]` (`id, label, default, legacy, freeBytes, totalBytes, usedByModelsBytes, modelCount`) and `models[].rootId`. Hub-only fields are stripped |
| POST `/api/models/cleanup-incomplete` `{ name }` or `{ path }` | `library.findByPath` (absolute, or a child of any root) → `cleanup-residue` | `{ ok, path, removed, removedBytes }`; a path outside the roots → 400 `path_outside_roots` (P0-RT-6) |
| GET `/api/models/upstream-status` `?name=` or `?path=` | `findByPath` → `check-update` | `{ ok, name, repo, url, lastModified, downloadedAt, updateAvailable, message }` + `remoteSha`, `localSha` |
| POST `/api/models/delete-local` (vLLM) | `DELETE /library/:id` with `confirm = name` | `{ ok, name, path }` |
| GET `/api/jobs[?fields=summary]` | local non-download jobs + `GET /downloads?owner=<managerId>&include=terminal&limit=60` | one array, newest first; hub unreachable → local jobs only, with header `x-hub-unavailable: 1` |
| GET/POST `/api/jobs/:id[/logs\|/pause\|/resume\|/cancel\|/resume-check]` | ids `dl_*`, or found in `legacyIds` → hub; otherwise local | the existing shapes |
| SSE `/api/events` event `jobs` | The manager keeps one signed upstream SSE to the entry `GET /api/events?types=downloads` (ENT-EV; backoff 1–30 s). Each `downloads` event is a trigger: the shim re-reads `GET /downloads?owner=<managerId>&include=terminal&limit=60` (signed) and re-broadcasts the merged snapshot, throttled to 700 ms. It therefore never depends on the event payload's redaction | unchanged event name and payload |
| `/api/huggingface/auth/status\|login`, `/api/huggingface/access` | `/api/hub/auth/huggingface*` (`login` only when `clientLocal`) | the vLLM shapes; llama gains them |
| GET `/api/models` | unchanged local listing (F9) | additive per item `libraryEntryId` and `provenance { provider, repo, revisionSha, confidence }` from `library.findByPath`, best effort with a 1 s timeout |

`toLegacyJob(job, { summary })` is pure and golden-tested. Its `meta` matches the fields 08 adds to legacy download jobs (08 C2), so P0-UI-3's failure card and platform-mcp read hub jobs unchanged.

```js
{ id, type: "download", title: `Download ${repo} (${transport === "modelscope" ? "ModelScope" : "Hugging Face"})`,
  status: LEGACY_STATUS[state],                                   // table in section 7.1
  createdAt, updatedAt, finishedAt, exitCode,
  error: error ? `${error.title.zh} / ${error.title.en}` : null,  // 08 controller convention
  meta: { model: repo, source: provider, precision: quant ?? "", outputName, localDir, priority, expectedBytes: totalBytes,
          expectedFiles: files.length, retryCount, maxRetries, retryScheduledAt: retry.nextAt, hubJobId: id, phase: state, includeExtras: companions,
          errorCode: error?.code, errorBaseCode: error?.baseCode, errorRetryable: error?.retryable, errorHint: error?.hint,   // 08 C2 (+ errorBaseCode)
          transfer: { hfMirror: source === "hf-mirror", hfEndpoint: endpoint, hfTransfer: xet === "high-performance", tokenRef: null, gated } },
  progress: { kind: "download", downloadedBytes, totalBytes, percent, speedBytesPerSec: speedEmaBps, etaSeconds,
              finalizedBytes, partialBytes, incompleteFiles, stage: <phase label>, updatedAt },
  logs: summary ? last 8 : last 200, logCount, logsTruncated }
```

- `meta.transfer.tokenRef` is always `null` in the legacy view. The hub's vault ref never leaves the hub.
- **Legacy UI touch** (no new views). P0-UI-3 already renders the failure card from `meta.errorCode` and `meta.errorHint`. HUB-13b adds only `progress.stage` to `shared-public/js/job-renderer.js`. The manager pages keep working through the shims, and their Playwright smoke mocks the same routes.

## 16. Migration (`migrate.js`, idempotent; steps recorded in `migrations.json`)

| step | action |
|---|---|
| `settings-v1` | When hub settings are absent: `fromLegacy(vllm download-settings.json ⊕ llama download-settings.json)`, vLLM winning on conflicts (the only live file). The source files are never modified. |
| `ledgers-v1` | Read both `jobs-ledger.json` files (read-only, `{ version: 1, jobs }`). Every `type: "download"` job not yet imported (by `legacyIds`) becomes a hub job (mapping below). |
| `snapshot-v1` | Copy both ledgers and settings files to `data/hub/migration/<manager>-<file>.<ISO>.json`. |
| `library-v1` | Full rescan with the section 9.3 backfill (uses ledgers and migration records). Imported `success` jobs are linked to entries by `localDir` via aliases. |
| `notify-v1` | `notification`: "Imported N downloads from the managers (M paused)" / "已从管理器导入 N 个下载任务（M 个已暂停）" |

- **Legacy job mapping.**
  - `success` → `ready`; `cancelled` → `cancelled`.
  - `failed` → `failed`. The `error` keeps `meta.errorCode` when 08 P0-DL-1 already classified the job. Otherwise it is `classifyDownloadFailure({ text: logs })`, which is `unknown` when nothing matches. Title and hint come from the 08 table.
  - `running`, `interrupted`, `queued` and `paused` → `paused` with `pausedBy: "migration"`. There is no automatic restart after an upgrade; this is open decision O2.
  - `artifact`: `repo = meta.model`, `provider = meta.source`, files from `meta.fileManifest` when present, otherwise reconstructed with `selectionFromLegacy` on a fresh manifest at resume time.
  - `transfer.options` come from `meta.transfer` (08 P0-DL-2) when present, otherwise from the manager's settings: `{ source: hfMirror && !gated ? "hf-mirror" : "huggingface", xet: hfTransfer ? "high-performance" : "default", credentialMode: "cached-login" }`. A legacy `meta.transfer.tokenRef` points into a manager's in-memory map and cannot be recovered. Such jobs import with `credentialMode: "temp-token"`, `tokenRef: null` and `waitReason: "auth"` on resume (§12).
  - Logs: the last 50 lines.
- **Manager ledgers are not edited.** In hub mode the managers hide local download records whose id appears in hub `legacyIds`. The 60-record cap evicts them naturally, so nothing is dropped.
- **Rollback.** With `downloadsOwner: "manager"`, the managers use their legacy controllers and the original settings files again. Jobs created in the hub are not exported back (documented in the release notes). The library stays readable.

## 17. Security

- **Tokens and secrets.**
  - HF tokens appear only in child-process env, never in argv. The command log line (`> hf download …`) therefore contains no secret.
  - Temporary tokens are memory-only by default (§12, 08 P0-9). A remembered token is stored only through `manager-core/secret-store.js` namespace `hf` (06 OPS-3: DPAPI CurrentUser, owner-only ACL, `<AI_ROOT>/.runtime/secrets/`, excluded from release and backup). The hub keeps no secret file of its own, writes nothing under `logs/` and does not use `runtime-secret-store.js`. `data/hub/` holds no secret, so `manager-backup.js` needs no hub exclusion.
  - No API returns a token. Responses carry only `credentialMode` and `remember`.
- **One redactor.**
  - The hub uses `manager-core/secret-redactor.js` from 08 P0-OBS-1 and nothing else. The marker is `<redacted>`.
  - `createSecretRedactor({ getSecrets: tokens.values })` redacts the exact in-memory tokens first, then 08's patterns (`hf_…`, `Bearer …`, `*_TOKEN=…`, `--token …`).
  - It runs on every log line, `error.detail`, stderr sample, task error and notification body before storage or emission.
  - `errors.js` has no redaction helper. A grep test asserts that `model-hub/` defines no `redact` function.
- **No HF credential to third parties.**
  - `providers/http.js#authorizedFetch(url, { token })` attaches `authorization` only when `new URL(url).hostname` is `huggingface.co` or ends with `.huggingface.co`. Otherwise it throws `credential_host_violation`, which is unit-tested.
  - Redirects are followed manually (`redirect: "manual"`, at most 5), and every hop off `huggingface.co` is re-issued without credentials. This also covers 02's Range reads, which use the provider's `fetchImpl` (§10).
  - Mirror and ModelScope CLI env: section 6.2.
- **Paths.**
  - Manifest paths must be relative POSIX paths with:
    - no `..`, no leading `/` and no drive letter;
    - no `:` (Windows alternate data streams);
    - no control characters and no reserved device names (`con`, `nul`, …);
    - no segment ending in a dot or space.

    The local path must be ≤ 240 characters from the root. Violations give `unsafe_path`.
  - Targets come only from `modelStorage.downloadTarget`. Deletes use `resolvePath(..., { allowRoot: false })` (audit H4) and never delete a root.
- **Access** (§13.1).
  - Proxied (public) requests never reach hub routes.
  - Writes need an owner (PUB-5) or the signed `system:hub-shim` principal, and the latter only on `SHIM_ROUTES`.
  - The shim credential is an HMAC over method, path, manager id, timestamp (±60 s) and the body hash, from a loopback socket. No bare header is trusted. A replayed request outside the window or with a modified body fails.
  - Login and tokens need a loopback owner, or a shim call whose signed `origin.clientLocal` is true.
  - Viewers get only the registered GETs and event types, through the redactors.
  - CSRF: the entry's `checkRequest` already rejects cross-origin mutating requests, and PUB-5 adds `x-csrf-token` for sessions.
- **SSRF.** Only an owner can configure endpoints, and only `https:` endpoints. Provider fetches have 15 s timeouts and response caps (manifest 32 MiB, README 512 KiB, search 4 MiB).
- **Custom code.** A repo containing `*.py` with `config.auto_map` gets a plan warning listing the files. The hub never sets `trust_remote_code`; 01/02 decide that at launch time.
- **Destructive actions.** Every destructive action needs an explicit `confirm` value. No hub code path stops or removes containers.
- **Resources.** Hashing runs in a worker. At most 4 provider fetches run concurrently per request. There is one upstream SSE per manager.

## 18. P0 prerequisites (owned by 08)

The former HUB-P0a–e packages are removed. They are **satisfied by 08 P0-DL-1, P0-DL-2, P0-DL-3, P0-RT-6 and P0-UI-3**, and the hub builds on those fixes.

| former | now satisfied by | what the hub takes over from it |
|---|---|---|
| HUB-P0a transfer options across resume | P0-DL-2, P0-RT-6 (`meta.transfer`, in-memory `dlt_` tokens, `hf_token_expired`) | the memory-only token policy (§12) and `meta.transfer` as the migration source (§16) |
| HUB-P0b error taxonomy | P0-DL-1 (`model-hub/errors.js#classifyDownloadFailure`) | 08's codes and copy (§6.3). The hub adds only the data file, three refinements and retry classes |
| HUB-P0c zero-match guard, llama presets | P0-RT-6 (P0-10), P0-UI-3 (P0-12) | `filter_no_match` at plan time; `transfer_empty` as a refinement |
| HUB-P0d root-aware disk | P0-DL-3, P0-RT-6 (P0-11) | `roots[]`/`rootId` (§13.5, §15) and `path`-based cleanup/upstream in the shims |
| HUB-P0e mirror token isolation, probe, no auto-persist | P0-DL-2 (P0-9), P0-UI-3 (P0-13) | the mirror env rules (§6.2) and the probe semantics |

The hub's structural fixes remain: persisted queued specs, one fit line on completion, and ModelScope manifests. The vLLM priority field is P0-13 (08).

## 19. Console copy (zh-CN / en-US; area file `service-entry/console/i18n/hub/{zh-CN,en-US}.json`)

The hub owns the i18n area `hub`. 07's loader merges the per-area files, and every key in this area starts with `hub.`. No hub package edits a shared catalog.

**Error copy has one source.** The classifier result (08's table plus the §6.3 refinements) reaches the console as the API's `error.title{zh,en}` and `error.hint{zh,en}`. The console renders those and keeps no per-code keys, so the hub and 08 cannot drift. `hub.error.fallback` covers an error without a title.

| key | zh-CN | en-US |
|---|---|---|
| `hub.state.queued` / `waiting` | 排队中 / 等待中 | Queued / Waiting |
| `hub.wait.runtime-busy` / `disk` | 模型服务正忙，空闲后自动开始 / 磁盘空间不足，腾出空间后自动开始 | Models are busy; starts when idle / Not enough disk space; starts when space is freed |
| `hub.wait.concurrency` / `auth` | 等待其他下载完成 / 需要重新输入 Hugging Face 令牌（重启后未保留） | Waiting for other downloads / Re-enter the Hugging Face token (it was not kept across the restart) |
| `hub.state.resolving` | 正在解析文件清单 | Resolving files |
| `hub.state.downloading` | 下载中 | Downloading |
| `hub.state.materializing` | 正在组装文件（Xet） | Assembling files (Xet) |
| `hub.state.verifying` | 正在校验（{done}/{total} 个文件） | Verifying ({done}/{total} files) |
| `hub.state.ready` | 已就绪，已加入模型库 | Ready, added to library |
| `hub.state.retrying` | {seconds} 秒后自动重试（第 {n}/{max} 次） | Retrying in {seconds}s (attempt {n}/{max}) |
| `hub.state.paused` / `interrupted` | 已暂停 / 已中断，将自动继续 | Paused / Interrupted, will resume automatically |
| `hub.state.failed` / `cancelled` | 失败 / 已取消 | Failed / Cancelled |
| `hub.error.fallback` | 下载失败，详见日志 | Download failed; see the log |
| `hub.error.notRetried` | 此错误不会自动重试 | Not retried automatically |
| `hub.fit.fits` / `tight` / `spills` / `wont-fit` / `unknown` | 可放下 / 偏紧 / 需卸载到内存 / 放不下 / 未知 | Fits / Tight / Spills to RAM / Won't fit / Unknown |
| `hub.fit.basis.params` | 按参数量估算；下载计划会给出精确结果 | Estimated from the parameter count; the download plan gives the exact result |
| `hub.token.label` | Hugging Face 访问令牌（仅用于本次下载） | Hugging Face access token (used for this download only) |
| `hub.token.remember` | 记住此令牌直到下载完成（在本机加密保存） | Remember this token until the download finishes (encrypted on this PC) |
| `hub.token.localOnly` | 只能在本机的浏览器中输入令牌 | Tokens can only be entered in a browser on this PC |
| `hub.action.sign-in` / `open-approval` / `enter-token` | 登录 / 打开申请页 / 输入令牌 | Sign in / Open approval page / Enter token |
| `hub.action.switch-source` / `choose-root` / `free-space` | 切换下载源 / 换模型库 / 清理空间 | Switch source / Change library / Free space |
| `hub.action.retry` / `pause` / `resume` / `start-now` | 重试 / 暂停 / 继续 / 立即开始 | Retry / Pause / Resume / Start now |
| `hub.action.cancel-keep` / `cancel-delete` | 取消（保留文件）/ 取消并删除未完成文件 | Cancel (keep files) / Cancel and delete partial files |
| `hub.action.install-cli` / `check-id` / `pick-artifact` / `view-log` / `download-run` | 安装下载工具 / 检查仓库 ID / 重新选择规格 / 查看日志 / 下载并运行 | Install download tool / Check repository ID / Pick an artifact / View log / Download & Run |
| `hub.library.provenance.declared` / `detected` / `unverified` / `unknown` | 来源已确认 / 来源已检测 / 来源未确认 / 来源未知 | Source declared / Source detected / Source unconfirmed / Source unknown |
| `hub.library.update.available` | 有更新：{files} 个文件，{size} | Update available: {files} files, {size} |
| `hub.library.duplicate` | 与 {name} 重复，可释放 {size} | Duplicate of {name}; {size} reclaimable |
| `hub.storage.root.hidden` | 已隐藏空的旧版模型目录 | The empty legacy model folder is hidden |
| `hub.unavailable` | 统一入口未运行，下载功能暂不可用 | service-entry is not running; downloads are unavailable |

The backend also returns an English `message`. 07's loader test checks key parity between locales and finds no duplicate keys across areas. `service-entry/test/hub-i18n.test.js` additionally checks coverage: every §7.1 state has `hub.state.*`, every wait reason has `hub.wait.*`, every fit label has `hub.fit.*`, and every action id in §6.3 has `hub.action.*`.

## 20. Tests

All new manager-core tests are top-level `manager-core/test/hub-*.test.js` (F12).
- **Fixtures** live in `manager-core/test/fixtures/hub/`:
  - recorded, trimmed API JSON for an HF GGUF multi-quant repo with shards in subdirectories, an HF FP8 repo with generic shard names, an HF mixed repo and a ModelScope repo;
  - a stderr corpus;
  - legacy ledgers and settings, including 08-era jobs with `meta.transfer` and `meta.errorCode`.

  Fixtures contain no private paths or tokens.
- **Goldens** are `*.golden.json`, regenerated only with `UPDATE_GOLDEN=1`.

| file | asserts |
|---|---|
| `hub-providers.test.js` | The `Link`-header cursor round-trip; `revisionSha` and sha256 parsing; mirror retry on a network error, with `fetchedFrom`; the fetch spy sees `authorization` only for `huggingface.co`, including after a redirect to a CDN host; ModelScope `Files[]` normalisation |
| `hub-selection.test.js` | The artifact goldens per fixture; no artifact without a weight file; `filter_no_match` with suggestions; a seeded property test (500 random manifests) that `compileIncludePatterns` matches exactly the selection; argv batching at 24k; fnmatch parity cases (`[`, `*`, `?`, `/`) |
| `hub-transfer-env.test.js` | The env matrix (official+cached, official+temp token, `none`, mirror, ModelScope, three Xet modes); resume uses persisted options after a settings change; `token_not_allowed_on_mirror`; an unresolvable `tokenRef` is never spawned |
| `hub-errors.test.js` | **Corpus.** The stderr corpus maps to 08 codes through `classifyDownloadFailure`, including the live "Access denied. This repository requires approval." tail followed by noise lines. **Refinements.** Each refinement fires only on its base and keeps its base in `baseCode`. **Data validation.** Every data-file key is in `DOWNLOAD_ERROR_CODES`; an override that adds a code is dropped and reported in `dataErrors`. **Copy.** Every code in `HUB_ERROR_CODES` has `title` and `hint` in zh and en. **Retry.** Per-class decisions; backoff bounds including `retryDelayFactor`; the `xet-off` remedy is applied once. 08's `download-errors.test.js` fixtures give the same codes through the wrapper |
| `hub-tokens.test.js` | `put`, `resolve` and `release`. `remember` writes to a fake `secretStore` namespace `hf`, and release deletes it. With no store, `remember_unavailable`. A new vault after a restart loses unremembered tokens, and the job goes to `waiting/auth`. A grep over the temp data dir finds no token in `downloads.json`, history, `logs/` or task files |
| `hub-fit.test.js` | The five label mappings with a stub `models`. `inspectRemote` receives the provider's `fetchImpl` and `endpoint` and no `token`. A recommended candidate uses `basis: "card"` and the others `params`. The fallback applies when `models` is null and never yields `tight` or `spills` |
| `hub-queue.test.js` | Priority, reorder, start-now; concurrency; idle-only with a fake busy signal and grace; disk waiting per volume; persistence round-trip; restart (in-process → interrupted → auto-resume after the delay, paused stays paused, retry timers re-armed, temp-token without vault entry → `waiting/auth`); orphan kill only on a command-line match; dedupe 409s; `events.publish` called with `downloads` (stub ENT-EV module) |
| `hub-progress.test.js` | Per-file bytes from a fake fs; Xet → materializing inference; watchdog per phase with a fake clock (no kill in materializing before 20 min, kill in downloading at 10 min, code `stall`); percent capped at 99 |
| `hub-verify.test.js` | Worker hashing; only bad files deleted; skip-if-verified; heartbeat timeout → `verify_failed`; exit 0 with an empty selected weight → `transfer_empty` |
| `hub-library.test.js` | A scan of two temp roots plus a fake HF cache; provenance precedence (marker v1/v2, `.metadata`, ledger via aliases, cache refs); the id stays stable across an alias migration; duplicates; update diff; delete refused on a root path or a busy path; `storage/usage` has `roots[]` (default first, `id`) and `models[].rootId`, with no `volumes` key |
| `hub-migrate.test.js` | Legacy fixtures → hub state golden; 08 `meta.errorCode` and `meta.transfer` are carried over; a second run is a no-op; snapshots are written; manager ledgers are unchanged byte for byte |
| `hub-compat.test.js` | The `toLegacyJob` summary golden. Its key set equals what platform-mcp reads (F9) plus 08 C2's `meta.errorCode/errorRetryable/errorHint/transfer`, and `meta.transfer.tokenRef` is always null. Also: the status table; the settings `fromLegacy(toLegacy(x))` round-trip; the `/api/remote-models` and `gguf-variants` legacy goldens; the disk-usage legacy shape deep-equals 08's `disk-usage-roots` fixture keys |
| `hub-run-after.test.js` | A fake manager server. The prospective plan body has `prospective: true` and `model.card`, with no `model.ref`. The authoritative plan has `model.ref`. `needs-confirmation` on replace; start is called once; no stop or remove endpoint is ever called (request-log assertion); a 400 naming `prospective` → `run_after_unavailable` |
| `service-entry/test/hub-routes.test.js` | Proxied → 404. Viewer GETs are redacted exactly per `HUB_VIEWER_ROUTES`, and `HUB_VIEWER_ROUTES` covers every GET in the route table (completeness). A viewer write is refused. An owner on LAN gets 403 `token_requires_local` for login and token. A signed shim gets 200 on `SHIM_ROUTES` and 403 `principal_route_forbidden` elsewhere. A request carrying only an unsigned `x-hub-shim` header is treated as a viewer and cannot write. A bad signature, a timestamp older than 60 s, a modified body or a non-loopback socket → 401 `internal_auth_failed`. `clientLocal: false` with `hfToken` → 403. Error envelope checks |
| `service-entry/test/hub-i18n.test.js` | §19 coverage, plus identical key sets in both area files |
| `llama-manager/test/hub-shim.test.js`, `vllm-manager/test/hub-shim.test.js` | Against a fake hub that verifies signatures with `internal-auth.js`: every request is signed; every legacy route forwards and keeps its shape; `/api/jobs` merges and filters by owner; the `x-hub-unavailable` fallback; `dl_` and `legacyIds` routing; a LAN caller's `hfToken` is not forwarded; a `downloads` SSE event triggers one signed re-read |
| `platform-mcp/test` (new case) | `listJobs` parses `toLegacyJob` output from a fake manager with no warnings |
| `tests/hub-shim.spec.cjs` (Playwright) | The llama UI with a mocked `/api/download` 422 `filter_no_match` shows suggestions. A failed hub job renders P0-UI-3's failure card from `meta.errorHint`, plus `progress.stage`. English mode has no Han text. No overflow at 390 px |

Grep guards (in `hub-errors.test.js`):
- no `x-hub-shim` header name in any non-test `.js` file under `manager-core`, `service-entry`, `vllm-manager` or `llama-manager`;
- no `function redact` and no `hub-secrets` under `manager-core/model-hub/`.

**Existing tests kept**
- `core.test.js:3698-3729`, `download-stall.test.js`, and 08's `download-errors`, `download-transfer` and `disk-usage-roots` tests stay unchanged. The legacy path remains for rollback, and the hub never edits 08's classifier table.
- `download-checksums.test.js` stays; the hub reuses `verifyDownloadChecksums` inside the worker.
- `model-storage.test.js` stays, plus a hub-lock case.
- Both `remote-models.test.js` files stay until HUB-13b. Then the HF fetch assertions move to `hub-providers.test.js`, and the files keep the mapping goldens through `compat.js`.
- `tests/frontend-smoke.spec.cjs:370-465` and `tests/p0-ui.spec.cjs` (08) stay green unchanged, because the routes and shapes are the same.

New Playwright specs are added to the root `package.json` `test:frontend-smoke` script. `service-entry/lib/hub-routes.js` and `manager-core/model-hub/index.js` are added to `test-all.cmd` `:check`.

## 21. Contract changes requested

1. **00 §2 layout.** These additions are additive.
   - `model-hub/` gains `selection.js`, `fnmatch.js`, `progress.js`, `verify.js`, `hash-worker.js`, `store.js`, `settings.js`, `disk.js`, `auth.js`, `tokens.js`, `fit.js`, `run-after.js`, `migrate.js`, `compat.js`, `client.js`, `shim.js`, `config.js`, `providers/index.js` and `providers/http.js`.
   - New data file `manager-core/data/hub-transfer-errors.json` (override `<AI_ROOT>/config/hub-transfer-errors.json`).
   - New area files `service-entry/console/i18n/hub/{zh-CN,en-US}.json`.
2. **00 §5 cross-process contracts.** Add "manager → entry hub calls".
   - Managers call `http://127.0.0.1:5176/api/hub/*` signed with 05 `internal-auth.js` as principal `system:hub-shim`, and they carry `x-request-id`. They hold one signed SSE subscription to `/api/events?types=downloads`.
   - There is no unauthenticated marker header.
   - This needs 05 to support three things in `internal-auth.js`: a `principal` option, the path prefixes `/api/hub/` and `/api/events`, and `system:hub-shim` in PUB-5's machine principals. The module must also land before HUB-13a (§23).
3. **00 §4.5 events** (`service-entry/lib/events.js` is 07 ENT-EV's).
   - Payloads: `downloads` = `{ kind: "snapshot"|"job", jobs: [DownloadJob without logs, with ownerManagerId], aggregate }`; `library` = `{ kind: "changed", entryIds } | { kind: "task", task }`.
   - ENT-EV's typed registry stamps `source: "hub"` on both.
   - The hub only calls `events.publish(type, payload)` and registers viewer redactors for both types (§13.1).
4. **00 §6 persisted formats.** Add:
   - `<manager>/logs/download-settings.json`, migrated to hub settings and never deleted;
   - hub `downloads.json`, `library.json` and `settings.json`;
   - `.platform-download.json` v2 (a superset of v1).

   The hub adds no secret file.
5. **01 plan API (agreed in the cross-check).** `LaunchRequestV2` gains `prospective: true` and `model: { ref?, card? }`. A prospective plan skips filesystem checks and uses the supplied ModelCard. The hub sends `model: { card }` (§11).
6. **02 (agreed in the cross-check).**
   - `FitResult` gains `spill: boolean`.
   - The modules are exposed as `core.models`, not flat-exported.
   - The hub consumes `inspectRemote` / `inspectLocal` / `estimateFit` / `evaluateCompatibility` exactly as 02 defines them (§10).
   - Requested as well: 02 §6.1 should say the HF token is sent only to `huggingface.co` hosts, dropping "or a mirror the owner configured". This matches §17 here and 08 P0-9.
7. **00 §3 identifiers.** Hub download jobs also carry `legacyIds[]`, and legacy job routes resolve either id form. Hub token refs are `dlt_<16 base32>` (the same prefix as 08's manager refs) and are never persisted outside the secret store.
8. **00 §1 hard rule on secrets.** The hub follows the single policy: memory-only, or `secret-store.js` namespace `hf` when the user ticks "remember".

## 22. Open decisions for the owner

- **O1.** Hub mode on by default at the P3 merge (default: yes), with `hub.downloadsOwner: "manager"` as rollback.
- **O2.** Downloads that were in flight when migration ran are imported as `paused` (default) rather than auto-resumed.
- **O3.** Default source policy: official Hugging Face (default, matching the live 100–150 MB/s) or `auto` with background probing.
- **O4.** `maxConcurrent` default 1 (default) or 2.
- **O5.** Library update checks are on-demand (default) or weekly in the background. `identifyOnline` (confirming folder-derived repo ids against HF) defaults to off.
- **O6.** Hide the empty legacy root in usage views (default: hide, via `hidden: true`; the API still lists it as 08 does, and its `/models` mount stays).
- **O7.** LAN owners (paired sessions on a LAN-bound ADMIN listener, 05 PUB-5) may queue, cancel and delete (default yes). Login and temporary tokens stay loopback-only.
- **O8.** History retention: 200 records in the ledger and 365 days in the history file.
- **O9.** In P7, replace vLLM "launch a remote repo id", which downloads into the HF cache outside any job, with Download & Run (default yes).
- **O10.** Allow deleting HF cache repos from the library (default yes, with confirmation).
- **O11.** Stall timeout default 10 min, up from 5.
- **O12.** Uncensored/NSFW tags appear as ordinary tag facets and are not featured (default).
- **O13.** The "remember this token until the download finishes" checkbox is unticked by default. When unticked, the token is memory-only and a restart asks for it again.

## 23. Work packages

**Prerequisites from other specs**
- 08 P0-OBS-1, P0-DL-1/2/3, P0-RT-6 and P0-UI-3 are merged before P3. They replace the former HUB-P0a–e (§18).
- 07 ENT-EV (wave 1) provides `events.js`, `mgmt-proxy.js`, the manager relay and the route-mount table.
- 05 PUB-10's `manager-core/internal-auth.js` is needed before HUB-13a (§21 item 2).
- 01 ENG-7, plus the `prospective` change, is needed for HUB-14.
- Soft prerequisites (the hub has a fallback or the feature stays off until they land):
  - 02 MOD-8, MOD-9 and MOD-11 for HUB-10;
  - 06 OPS-3 `secret-store.js` for "remember";
  - 05 PUB-5 for owner/viewer roles.

**Rules for every package**
- Run `npm test` in the touched packages, then `test-all.cmd`, and report pass and fail counts.
- `service-entry/server.js` edits are limited to hub construction, one mount line in ENT-EV's table, `hub.stop()` in `shutdownSoon`, and the `getRuntimeLoad`/`getGpus` providers.

| id | title | files touched / created | depends_on | size | acceptance |
|---|---|---|---|---|---|
| HUB-1 | Hub skeleton: store, settings, config flag, entry mount, access resolution | `manager-core/model-hub/{index,store,settings,config}.js`; `service-entry/lib/hub-routes.js` (status, settings, principal resolution, `HUB_VIEWER_ROUTES` registration); `service-entry/server.js` (construction, mount line, `hub.stop()`); `manager-core/test/hub-store.test.js`; `service-entry/test/hub-routes.test.js`; `test-all.cmd` | P0-DL-1, ENT-EV | M | `GET /api/hub/status` and `GET/PUT /api/hub/settings` follow the §13.1 matrix and the 00 envelope. The viewer status is redacted, and both routes are registered in the viewer allowlist (or a stub registry before 05). Atomic writes survive a simulated crash: a leftover temp file is ignored. `readHubConfig` precedence test passes. `shutdownSoon` calls `hub.stop()`. `consoleFeatures.enable("hub")` is called at mount |
| HUB-16 | Error wrapper, refinements and retry policy | `manager-core/model-hub/errors.js` (extend; 08's exports untouched); `manager-core/data/hub-transfer-errors.json`; `manager-core/test/hub-errors.test.js`; `manager-core/test/fixtures/hub/stderr/*` | P0-DL-1, HUB-1 | M | `hub-errors.test.js` passes in full (§20), including the grep guards. 08's `download-errors.test.js` is unchanged and green. An override that adds a code is dropped and appears in `/api/hub/status` `dataErrors`. Every code has zh and en title and hint |
| HUB-2 | HF and hf-mirror providers with a credential guard | `model-hub/providers/{index,http,huggingface,hf-mirror}.js`, `test/hub-providers.test.js`, `test/fixtures/hub/hf-*.json` | HUB-1 | L | Fixture-based search with a Link cursor; a manifest with sha256 and `revisionSha`; the readme cap. `authorizedFetch` strips credentials across a redirect to a CDN host. `credential_host_violation` test passes. Mirror fallback reports a warning |
| HUB-3 | ModelScope provider | `model-hub/providers/modelscope.js`, fixtures, `hub-providers.test.js` | HUB-2 | M | Search and file listing, with sizes and sha256 normalised from fixtures. A missing `Revision` gives `revisionSha: null`. The proxy/DNS env helper is reused for the CLI |
| HUB-4 | Artifacts, selection, fnmatch and include compilation | `model-hub/{selection,fnmatch}.js`, `test/hub-selection.test.js` | HUB-2 | M | Artifact goldens for the 4 fixtures; the property test (500 seeds) is exact; `filter_no_match`, `unsafe_path` and `file_not_in_manifest`. Legacy precision mapping matches the intent of the current `buildDownloadIncludePatterns` on the `core.test.js` cases |
| HUB-5 | CLI transfer engine and token vault | `model-hub/{transfer,tokens}.js`, `test/hub-transfer-env.test.js`, `test/hub-tokens.test.js` | HUB-1, HUB-4, HUB-16, P0-DL-1, P0-DL-2, P0-OBS-1 | L | Env matrix golden. Argv uses `--include=PAT` and `--revision <sha>`. Batching works. The `secret-redactor` with the vault's values redacts log and file output to `<redacted>`. Orphan detection kills only on a command-line match (stubbed CIM output). The lock is acquired, tracked and released around spawn. The vault is memory-only without `remember`; with a fake secret store it uses namespace `hf`. A grep over the temp data dir finds no token |
| HUB-6 | Progress monitor, phases, watchdog, verification worker | `model-hub/{progress,verify,hash-worker}.js`, `test/hub-progress.test.js`, `test/hub-verify.test.js` | HUB-5, HUB-16 | L | Phase inference and per-phase watchdog thresholds hold under a fake clock (`stall`, `verify_failed`, `transfer_empty`). Hashing runs in the worker: main-thread event-loop delay stays < 50 ms while hashing 1 GiB in a test. Only bad files are deleted. Marker v2 is written and readable by `prepareDownload` |
| HUB-7 | Persistent global queue, idle policy, restart resume, download APIs and events | `model-hub/{queue,disk}.js`; `service-entry/lib/hub-routes.js` (download routes, viewer registrations, `downloads` event redactor); `service-entry/server.js` (`getRuntimeLoad`, `getGpus` providers); `manager-core/model-storage-routes.js`; `test/hub-queue.test.js` | HUB-5, HUB-6, HUB-16, ENT-EV | L | `hub-queue.test.js` passes, including restart, `waiting/auth` and `events.publish("downloads", …)`. Nothing in the hub writes SSE directly. The busy-path probe sees hub jobs: migration refuses a downloading path. `hub.busy()` reports active transfers. Every download endpoint in §13 is covered by `hub-routes.test.js`, with viewer redaction |
| HUB-8 | Library registry, scan and provenance backfill | `model-hub/library.js`, `test/hub-library.test.js`, fixtures (fake roots, HF cache, ledgers) | HUB-1 | L | Scans of roots, the HF cache and the ModelScope cache. Provenance precedence golden. Ids stay stable across aliases. Duplicates are linked. `library` events go through `events.publish`. List, detail, rescan, verify and identify endpoints work, with viewer path redaction |
| HUB-9 | Library actions and root-aware storage | `model-hub/{library,disk}.js`, `hub-routes.js`, `test/hub-library.test.js` | HUB-7, HUB-8, P0-DL-3 | L | Update diff by SHA and enqueue of an update job. Delete guards: root, busy, confirm. Residue cleanup returns 409 when a job is active. HF-cache import copies, hashes and writes marker v2. `storage/usage` matches §13.5: `roots[]` with `id`, `models[].rootId`, no `volumes`, and `hidden` on an empty legacy root. `storage/cleanup` works |
| HUB-10 | Search, repo detail, plan API and fit integration | `model-hub/{index,fit}.js`, `hub-routes.js`, `test/hub-plan.test.js`, `test/hub-fit.test.js` | HUB-2, HUB-4, HUB-8; soft MOD-8, MOD-9, MOD-11 | L | Cursor and facets work, including `cursor_mismatch`. Detail artifacts carry fit label and basis, engines, the recommended flag and library state. Plan blocking and warnings cover disk, gated, custom code and duplicate. `hub-fit.test.js` passes: `core.models` is used when injected, with no token passed, and the fallback otherwise. Once 02 is merged, the fallback branch is deleted in the same package or in a follow-up S package |
| HUB-11 | Shared HF auth, temporary tokens on routes, source probe | `model-hub/auth.js`, `hub-routes.js` (credential handling), tests | HUB-1, HUB-2, HUB-5 | M | Login and `hfToken` are loopback-owner only (403 `token_requires_local` otherwise). The access probe uses the first weight file. The tokenRef lifecycle works: release on ready, on cancel and after the 7-day expiry. `remember` without a secret store gives 422 `remember_unavailable`. No token appears in any API response or hub file (grep test over the data dir) |
| HUB-12 | Migration from manager settings and ledgers | `model-hub/migrate.js`, `test/hub-migrate.test.js`, legacy fixtures (including 08-era `meta.transfer` and `meta.errorCode`) | HUB-7, HUB-8, HUB-16 | M | Golden import. A rerun is idempotent. Snapshots are written. Manager files are unchanged. 08 error codes and transfer options carry over, and an unrecoverable tokenRef gives `waiting/auth` on resume. The notification is emitted. The rollback flag makes `POST /downloads` return 409 `hub_disabled` |
| HUB-13a | Shim core: signed client, compat mappers, jobs and SSE relay | `model-hub/{client,compat,shim}.js`; `service-entry/lib/hub-routes.js` (`SHIM_ROUTES`, `verifyInternalRequest` until PUB-5); `llama-manager/server.js`, `vllm-manager/server.js`; `{llama,vllm}-manager/test/hub-shim.test.js`; `test/hub-compat.test.js`; `platform-mcp/test` case | HUB-7, HUB-12, PUB-10 (`internal-auth.js`) | L | Every shim request is signed. The fake hub rejects unsigned requests. A request with only an unsigned `x-hub-shim` header cannot write (`hub-routes.test.js`). `/api/jobs[?fields=summary]` is merged per owner with the exact legacy keys plus 08 C2 `meta` fields. `/api/jobs/:id*` routing works for `dl_` ids and legacyIds. The SSE `jobs` relay re-reads on trigger. The `x-hub-unavailable` fallback works. The MCP contract test is green |
| HUB-13b | Shim routes: download, remote models, settings, auth, storage | `model-hub/shim.js`; both `server.js`; shim tests; `shared-public/js/job-renderer.js` (`progress.stage` only); `tests/hub-shim.spec.cjs`; root `package.json` | HUB-13a, HUB-9, HUB-10, HUB-11 | L | Every row of the §15 table has a forwarding test with a legacy-shape golden. The disk-usage shim equals 08's shape. `clientLocal: false` never forwards a token or opens the login. Frontend smoke and `p0-ui.spec.cjs` stay unchanged and green. The new Playwright spec passes (English mode, 390 px) |
| HUB-14 | Download & Run | `model-hub/run-after.js`, `queue.js` hook, `hub-routes.js` (`/run`), `test/hub-run-after.test.js` | HUB-7, HUB-10, ENG-7 (+ 01 `prospective`/`model.card`); soft ENG-19 | M | The prospective plan sends `model: { card }` and `prospective: true`, and the authoritative plan sends `model: { ref }`. Without 01 support the result is `run_after_unavailable`. The needs-confirmation flow works. Stop and remove are never called (asserted). The `runAfter` result is visible in the job and a notification |
| HUB-15 | Release wiring, i18n area, docs | `build-github-release.ps1` or `release-manifest.json` (whichever OPS-1 state is current); `test-all.cmd` (`:check` hub files); `service-entry/console/i18n/hub/{zh-CN,en-US}.json`; `service-entry/test/hub-i18n.test.js`; `docs/model-storage-guide.md` (hub section); `docs/overhaul/03-hub.md` (as-built notes) | HUB-13b, HUB-14 | M | The release dry-run includes the hub files and excludes `service-entry/data/hub`. The privacy scan is clean. `hub-i18n.test.js` and 07's area parity test pass, with no key outside `hub.*`. The full `test-all.cmd` is green, with counts reported |

Execution order: HUB-1 → HUB-16 → HUB-2 → HUB-3 / HUB-4 → HUB-5 → HUB-6 → HUB-7 → HUB-8 → HUB-9 → HUB-10 → HUB-11 → HUB-12 → HUB-13a → HUB-13b → HUB-14 → HUB-15. HUB-3 and HUB-8 can run in parallel with the transfer chain.
