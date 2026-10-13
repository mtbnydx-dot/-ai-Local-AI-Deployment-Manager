# 02 — Models: inspection, knowledge, compatibility, fit, planning, qualification

Phase P2 (`feature/platform-overhaul-20261014-models`). Binding parent: `00-decisions-and-contracts.md` (D4, D5, D6, D7, §2 layout, §3 identifiers, §4.3 LaunchPlan, §4.4 ModelCard, §6 compatibility, §7 rules). This spec defines the canonical **ModelCard v1** (§4.4 delegates it here), the layered **model knowledge** (D5), the per-runtime **compatibility matrix**, the artifact-side **memory fit inputs and grading** (engine reservation semantics stay in 01 `engines/memory-models.js`), the single **calibration store**, the **launch planner**, the **dry probe**, the **qualification suite**, **root-cause extraction** into the 00 job error object, and "save working launch as recipe".

Revision 2026-10-14b applies the chief architect's cross-check (issues 1, 3, 4, 10, 14, 15, 17-21, 24, 26, 27, 32, 33). Items that need edits in other specs are collected in §23.2.

Placeholders used below: `<AI_ROOT>` (platform root), `<LIBRARY_ROOT>` (any root listed in `service-entry/data/model-storage.json`). No real machine paths appear in this document or in fixtures (rule §7.8).

---

## 1. Goals, non-goals, success criteria

Goals
1. Adding a model the engines already support needs **zero code changes**: paste a repo or pick a folder → evidence-backed card → engine matrix → 2-3 plans → probe → launch → qualify → save recipe.
2. Every launch-relevant fact carries evidence and one of the four confidences from §4.4: `declared`, `detected`, `name-heuristic`, `verified-on-host`. Unknown is never rendered as compatible.
3. One artifact-side input builder (`fit.artifactMemoryInputs`) feeds 01's per-engine `engines.memoryModels.estimate(engineId, inputs)`. The console, the legacy UIs, `/api/memory-estimate`, `LaunchPlan.memory` (and therefore admission), download precheck, the planner and platform-mcp all see the same numbers. 02 owns the bytes derived from the card (weights, KV per token and layer, recurrent state). 01 owns how an engine reserves memory and what admission requests.
4. Launch failures surface a root-cause line plus a data-driven explanation instead of "Engine core initialization failed. See root cause above".

Non-goals: engine adapters, the parameter catalog, the recipe schema and its validator, `POST /api/launch/plan`, engine memory semantics and gpu-admission (owned by 01 and 08 P0-RT-3; this spec consumes them). Also out of scope: downloads (P3 hub), telemetry storage (P4), every file under `service-entry/console/` (07), the platform.json schema and writer (06 OPS-3), the events bus and management proxy (07 ENT-EV). No model file is ever hashed or fully read. No new npm dependencies.

Success criteria (measured on the owner's library fixtures, §21.1)
- Qwen3.8 checkpoints (declared `model_type: qwen3_5`) resolve to the Qwen3.8 family and to the same parsers regardless of folder name.
- The DeepSeek-V4 GGUF (`general.architecture = deepseek4`) shows `unknown` on llama.cpp until probed, never "兼容".
- Weight bytes are exact from tensor tables: DeepSeek-V4 Q2_K = 90.89 GiB, of which routed experts = 82.69 GiB; Qwen3.8-27B-FP8 = 28.75 GiB.
- The KV estimate for DeepSeek-V4 at 1,048,576 tokens is in the GiB range (today it is 0.006 GiB).

## 2. Verified current state (inputs to the design)

Verified in this worktree and, read-only, against the model library:

| Fact | Evidence |
|---|---|
| The capability matrix is keyed on declared identity but `qwen3.8` matches `model_type` `qwen3_8`/`qwen3_8_moe`, which no real checkpoint declares. Real Qwen3.8 configs declare `qwen3_5` + `Qwen3_5ForConditionalGeneration`, so they match `qwen3.5-3.6`. | `manager-core/data/model-capabilities.json`; library `config.json` files; `manager-core/test/model-capability-matrix.test.js:27-33` uses the fictional type |
| Qwen3.8 chat templates are byte-identical across 27B FP8, Flash-Next NVFP4 and fine-tunes (sha256 prefix `c3cf9e34abf4f9e3`). Qwen3.6 differs (`e84f32a23fdda276`). Qwen3.8 adds a `reasoning_effort` kwarg (xhigh/medium/low). | library `chat_template.jinja` |
| The override loader replaces the bundled file wholesale. | `manager-core/reference-data.js:56-74` (`user.ok ? user.value : bundled.value`) |
| The GGUF capture whitelist drops `tokenizer.chat_template`, `compress_ratios`, `indexer.*`, `kv_lora_rank`, `ssm.*`, `nextn_predict_layers`, `expert_shared_count`, `general.sampling.*`. Tensor names and types are read and discarded (only element counts kept). | `manager-core/gguf-metadata.js:221-228`, `:259-272` |
| With `sliding_window` set and no pattern, every layer is treated as SWA. | `gguf-metadata.js:324-341`, `:548-568` |
| The DeepSeek-V4 GGUF declares `deepseek4`, 43 blocks, `head_count_kv` 1, `key_length` 512, `sliding_window` 128, `compress_ratios` (44 entries: `[0,0,4,128,4,128,…,4,0]`), indexer (64 heads, key 128, top_k 512), 256 experts (6 active, 1 shared), `nextn_predict_layers` 1, `general.sampling.temp/top_p`, a DSML tool-call template. Tensor bytes: experts 82.69 GiB, other blocks 6.69, `token_embd` 0.99, `output` 0.52. | library GGUF header (read-only dump) |
| An unknown GGUF architecture returns `{status:"not-required", supported:true}`; the UI maps `supported===true` to "兼容". | `llama-manager/server.js:378-387`; `llama-manager/public/js/gguf-model-ui.js:65-74` |
| Four estimators disagree; the llama `/api/memory-estimate` plan has no `weightsGb` (it has `totalWeightsGb`), but platform-mcp reads `plan.weightsGb`. | `manager-core/memory-estimator.js`; `llama-manager/lib/memory-estimate.js`; `platform-mcp/src/platform-client.ts:1675` |
| Pennyroyal admission is a constant branch inside the estimator wrapper. | `vllm-manager/lib/memory-estimate.js:53-66` |
| `logIssueHint`/`buildLogSuggestions` are Qwen3.6/DiffusionGemma-specific strings in code. | `vllm-manager/server.js:2071-2110` |
| Container exit keeps only `--tail 260` and records `firstIssue/lastIssue`; no root-cause field. | `manager-core/runtime-wait.js:172-188`, `:298-316` |
| Library layouts seen: indexed shards; `layers-N.safetensors` + `mtp.safetensors` + `outside.safetensors`; 418 per-expert-range shards with `.complete.json`; draft-only folder (`DSparkDraftModel`, `auto_map`); script-only folder with a custom `ples_int4/` layout; single 97.6 GB GGUF. | library listing |
| `models/`, `cache/`, `logs/`, `*.log`, `*.jsonl`, `jobs-ledger.json` and `*/data/` are gitignored, and `models` is excluded from the release robocopy (`/XD models`). Fixture directories must not be named `models`, `logs` or `cache`, and fixture files with an ignored extension take a `.fixture` suffix (00 §9.14). | `.gitignore`; `build-github-release.ps1:60-90` |
| `manager-core/index.js` flattens every module in `MODULES` into one export object and throws `MANAGER_CORE_EXPORT_COLLISION` on a duplicate name. | `manager-core/index.js:1-106` |
| llama admission takes an injectable `estimateParallelVram` (default `estimateLlamaParallelVram`) and sends `requestedMb`/`requestedMbByGpu`/`estimatePolicy`; vLLM sends `requestedFraction`; Pennyroyal is a constant branch. | `llama-manager/lib/launch-request.js:54,169-204,434-525`; `vllm-manager/lib/launch-request.js:177-186` |

## 3. Architecture

```
                 ┌──────────── service-entry (ADMIN 5176) ────────────┐
console / MCP ──►│ model-card-routes.js   knowledge-routes.js          │
                 │   inspect · card · compatibility · recommend ·      │
                 │   qualify · save-recipe · knowledge(status/import)  │
                 │   host-records store (data/model-host-records.json) │
                 └───────┬─────────────────────────────┬──────────────┘
                         │ require()                   │ /api/m/:managerId/*
                 ┌───────▼─────────────────────┐   ┌───▼──────────────────────────┐
                 │ core.models (model-inspector│   │ managers (vllm 5177, llama 5178)
                 │ inspect · detectors/* ·     │◄──┤ legacy: /api/model/config,     │
                 │ knowledge · template-sigs · │   │ /api/download/precheck,        │
                 │ roles · compatibility ·     │   │ /api/memory-estimate (fit),    │
                 │ fit (artifact inputs) ·     │   │ LaunchPlan.memory via 01       │
                 │ calibration · planner ·     │   │ memory-models + plan-facts,    │
                 │ probe · qualify · root-cause│   │ supervisor (job error, calib.) │
                 └──┬────────────────▲─────────┘   │ new: /api/models/probe,        │
                    │ inputs         │ estimate    │ /api/qualify, /api/knowledge/status
                 ┌──▼────────────────┴─────────┐   └──────────────────────────────┘
                 │ core.engines (01): memoryModels.estimate · runtimeFacts.get ·    │
                 │ paramsKey · recipe-schema · metrics · logFacts                   │
                 └─────────────────────────────────────────────────────────────────┘
           <AI_ROOT>/cache/{model-cards,model-probes}/                  (disposable)
           <AI_ROOT>/.runtime/engine-flags/<engineId>/<imageId16>.json  (01 runtime facts; 02 reads via engines.runtimeFacts)
           <AI_ROOT>/config/knowledge.d/**                              (user, merged by id)
           <manager>/data/memory-calibration.json                       (the only calibration store; per engine host)
```

Placement rules
- All logic is pure manager-core code; processes differ only in which routes they mount. Docker-touching work (probe) and instance-touching work (qualify, observations) run in the manager that hosts the engine (D3). Cross-engine views (compatibility across managers, recommend, fit-grid, host records, the auto-qualify trigger) run in the entry.
- Heavy parsing (hundreds of safetensors headers, multi-MB GGUF headers) runs in a `node:worker_threads` worker (`model-inspector/inspect-worker.js`), one at a time per process, single-flighted per cache key with the existing `single-flight-cache.js`.
- Manager-to-entry writes (host records) use `POST /internal/models/host-records`, signed with 05 `manager-core/internal-auth.js` on the `/internal/models/` prefix. Entry-to-manager calls go through the ENT-EV management proxy client (07); 02 adds no direct manager URLs.

### 3.1 Namespace and integration points with 01

`manager-core/model-inspector/index.js` builds one namespace, exposed as `core.models` by a single line in `manager-core/index.js` (`module.exports.models = require("./model-inspector")`, the same pattern as 01's `core.engines`, 00 §9.17). Nothing from `model-inspector/` is added to the flat `MODULES` spread, so `MANAGER_CORE_EXPORT_COLLISION` cannot fire.

```js
core.models = {
  inspectLocal, inspectRemote, getCard, projectCard, validateCard, INSPECTOR_VERSION,
  contentDigest: { forDir(dir) /* → "sha256:…" */ },
  knowledge: { load, status, matchFamily, errorSignatures(engineId), familyIdForCapabilityId(id) },
  parsers: { matchTemplate, resolveParsers },
  compatibility: { evaluateCompatibility },
  fit: { artifactMemoryInputs, estimateFit, fitGrid, legacyEstimate, FIT_CONSTANTS },
  calibration: { createCalibrationStore, calibrationFor },
  planFacts(model, { engineId, hostFacts }) /* → { card, familyId, contentDigest, artifactFor(values, gpuIds) } */,
  rootCause: { classifyFailure },
  observations: { observationFromFacts },
  managerHooks({ managerId, dataDir, gpuStatus }) /* → { modelFacts, calibrationFor, afterReady, classifyFailure } */,
  planner: { planLaunches }, probe: { buildProbeCommand, runProbe }, qualify: { runQualification },
  capabilities: { deriveCapabilities, capabilityTokens }, recipeDraft: { draftRecipeFromLaunch },
};
```

02 plugs into the integration points 01 defines; it adds none to 01. `managerHooks()` returns all four per-manager callbacks at once, and each one is a safe no-op (`null`) until its package lands, so each manager wires it once per construction site:

| 01 integration point | 02 function | Wired by |
|---|---|---|
| PlanCtx `modelFacts(model)` (01 §11 step 1; also prospective plans from `model.card`) | `planFacts` → `ctx.model.{card, familyId, contentDigest, artifactFor}`; the adapter's `estimateMemory` (step 9, after values are resolved) calls `ctx.model.artifactFor(plan.values, gpuIds)` for `MemoryInputs.artifact` | MOD-9b, one line in the PlanCtx each manager builds for `resolveLaunchPlan` (ENG-7) |
| PlanCtx `calibrationFor(card, engineId, runtimeId, paramsKey)` → `MemoryInputs.calibration` (01 §12) | `calibration.calibrationFor` | MOD-9b (same line); returns `null` until MOD-10 |
| `engines.memoryModels.estimate(engineId, MemoryInputs)` (01 §12) | called by `fit.estimateFit`; `MemoryInputs.artifact` from `fit.artifactMemoryInputs` | MOD-9 |
| Supervisor `hooks.afterReady({launchId, plan, paramsKey, runtimeId, contentDigest, logFacts, gpuUsedBeforeMb})` (01 §14) | `observationFromFacts` → calibration `record` | MOD-10, one spread line in each manager's `createRuntimeSupervisor({hooks})` |
| Supervisor `hooks.classifyFailure(logText, {engineId, phase})` → `job.failure` (01 §14) | `rootCause.classifyFailure` | MOD-10 wires it (returns `null`); MOD-12 implements it |
| `registry.errorSignatureAdditions()` (01 §16.3) | merged by `knowledge.errorSignatures` | MOD-5 |
| `engines.runtimeFacts.get(runtimeId)` / `.put(runtimeId, "registries", data)` (01 §17) | probe writes; parsers and compatibility read | MOD-13; MOD-7, MOD-11 |
| `engines.recipeSchema.validateRecipe`, `POST /api/recipes/reload` (01 §10) | save-as-recipe | MOD-17 |
| Recipe `match.capabilityIds` alias (01 §10.1, ENG-25) | `knowledge.familyIdForCapabilityId` | MOD-6 |
| `engines.paramsKey(plan)` (01 §12) | calibration key, fit-grid memo | MOD-9b, MOD-10 |

### 3.2 Interfaces consumed by 03 (hub)

03 is rewritten against these names (cross-check issue 19):

| 03 need | 02 function | Notes |
|---|---|---|
| Card for a remote repo before download | `inspectRemote({source, repo, revision, files?}, {fetchImpl, token, endpoint, signal, readRange?})` | `readRange` optional: the hub's mirror-aware reader replaces §6.1's default; header reads only |
| Card for a downloaded folder | `inspectLocal(path, {depth, refresh, signal})` | |
| Fit label | `estimateFit(FitInput)` → `status: ok\|warn\|fail`, `spill: boolean` | hub maps `ok` → fits, `warn` + `spill` → spills, `warn` without spill → tight, `fail` → wont-fit |
| Engine rows | `evaluateCompatibility(card, {runtimes, runtimeFacts, descriptors, host, knowledge, hostRecords, probes})` | verdict `ok\|warn\|block\|unknown` |
| Prospective plan | 01 `POST /api/launch/plan` with `{prospective:true, model:{card}}` | 01 §11 (00 §9.2) |

Module list (all under `manager-core/model-inspector/`, all CommonJS, reachable only through the `core.models` namespace):

| File | Exports (signatures) |
|---|---|
| `index.js` | the `core.models` namespace of §3.1 |
| `inspect.js` | `inspectLocal(path, {depth:'full'\|'quick', refresh, signal}) → Promise<ModelCard>`; `inspectRemote({source, repo, revision, files?}, {fetchImpl, token, endpoint, signal, readRange?}) → Promise<ModelCard>`; `getCard(cardId) → ModelCard\|null`; `INSPECTOR_VERSION` |
| `card-schema.js` | `MODEL_CARD_SCHEMA` (JSON Schema object), `validateCard(card) → {ok, errors[]}`, `projectCard(card, {view:'summary'\|'full', redactPaths}) → object` |
| `evidence.js` | `addEvidence(card, {fact, value, source, confidence, note})`, `confidenceOf(card, pointer) → 'verified-on-host'\|'declared'\|'detected'\|'name-heuristic'\|null`, `CONFIDENCE_RANK` |
| `content-digest.js` | `contentDigestForDir(dir, {file?}) → Promise<"sha256:…">` (§4.1; used by `cache.js` and `planFacts`) |
| `cache.js` | `fingerprintLocal(dir) → {key, contentDigest}` (uses `content-digest.js`), `readCachedFacts(key)`, `writeCachedFacts(key, facts)` (atomic tmp+rename), `cardIdFor(ref)` |
| `plan-facts.js` | `planFacts(model, {engineId, hostFacts}) → {card (summary), familyId, contentDigest, artifactFor(values, gpuIds) → MemoryInputs.artifact}` for 01's PlanCtx `modelFacts` (§3.1); `model` is LaunchRequestV2 `model:{ref?, card?}`; the card is cached per `cardId`, `artifactFor` results per `(cardId, engineId, paramsKey, gpuIds)` |
| `manager-hooks.js` | `managerHooks({managerId, dataDir, gpuStatus}) → {modelFacts, calibrationFor, afterReady, classifyFailure}` (§3.1) |
| `detectors/inventory.js` | `scanInventory(dir, {maxEntries:20000}) → Inventory` |
| `detectors/hf-config.js` | `detectConfig(inv) → Facts` (config.json incl. nested `text_config`/`llm_config`/`language_config`/`vision_config`/`audio_config`/`mtp`) |
| `detectors/generation-config.js` | `detectGenerationConfig(inv)` |
| `detectors/template.js` | `detectTemplate(inv \| ggufKv) → {text, source, sha256}` |
| `detectors/quant.js` | `detectQuant(config, hfQuantConfig, tensorTable, ggufKv)` |
| `detectors/safetensors.js` | `readSafetensorsHeader(file) → {tensors:[{name,dtype,shape,bytes}]}`; `buildTensorTable(inv) → TensorTable` |
| `detectors/gguf.js` | wraps `gguf-metadata.js` widened parser; `ggufFacts(file) → Facts` |
| `detectors/role.js` | `detectRole(facts, inv) → {role, runnable, evidence[]}`; `pairCompanions(cards[]) → Pairing[]` |
| `detectors/topology.js` | `buildTopology(facts) → Topology` (per-layer attention kinds) |
| `remote/hf.js`, `remote/modelscope.js`, `remote/range-reader.js` | §6 |
| `ggml-types.js` | `GGML_TYPES` table `{id:{name, blockElems, blockBytes}}`, `ggmlTensorBytes(type, dims)` |
| `knowledge.js` | `loadKnowledge({force}) → Knowledge`; `knowledgeStatus() → StatusDomain`; `matchFamily(card, knowledge) → {entry, matchedBy, confidence}`; `errorSignatures(engineId) → Signature[]` (the one loader: knowledge layers plus 01 `registry.errorSignatureAdditions()`, §8.4); `familyIdForCapabilityId(id) → string\|null`; `registerStatusProvider(domain, fn)` |
| `template-signatures.js` | `matchTemplate(templateText, knowledge) → {signatureId, exact, features, toolFormat, reasoningFormat, thinking, parsers}`; `resolveParsers(card, engineId, {runtimeFacts, descriptor, quantMethod, override}) → {tool:{value,source,reason}, reasoning:{…}, enableAutoToolChoice:{…}}` |
| `compatibility.js` | `evaluateCompatibility(card, {runtimes, runtimeFacts, descriptors, host, knowledge, hostRecords, probes}) → CompatibilityRow[]` |
| `fit.js` | `artifactMemoryInputs(card, {engineId, gpuIds, values}) → MemoryInputs.artifact` (01 §12 field names plus 02 additive fields, §10.2); `estimateFit(FitInput) → FitResult` (= artifact inputs + `engines.memoryModels.estimate` + grading); `fitGrid(FitInput, {kvDtypes, concurrency, contexts?}) → FitGrid`; `kvBytes(kvLayers, {contextTokens, sequences, engineId, values})`; `legacyEstimate(body, engine)` (bit-for-bit wrapper over the legacy estimator path); `FIT_CONSTANTS` |
| `calibration.js` | `createCalibrationStore({file, maxRecords:500}) → {lookup({contentDigest, runtimeId, paramsKey}), record(observation), recent({contentDigest, engineId}, n)}`; `calibrationFor(card, engineId, runtimeId, paramsKey) → {exact, measuredMb, samples} \| null` (01 PlanCtx shape). The only calibration store (§10.6) |
| `planner.js` | `planLaunches({card, host, goal, gpuSets, rows, catalogs, recipes, constraints}) → GpuSetPlans[]` |
| `probe.js` | `buildProbeCommand({engineId, runtime, modelDir, modelFile, allowRemoteCode}) → {argv, name, timeoutMs}`; `runProbe(cmd, {docker}) → ProbeResult`; image registry facts are written with `engines.runtimeFacts.put(runtimeId, "registries", facts)` (§12.3) |
| `probe-scripts/hf_probe.py` | stdlib-only Python probe executed inside the image (§12) |
| `qualify.js` | `runQualification({instance, card, launch, fetchImpl, metrics, benchmark, onProgress, checks}) → QualificationResult` |
| `root-cause.js` | `classifyFailure(logText, {engineId, phase}) → JobError\|null` (00 §9.11 job error object plus additive fields, §14; 01 stores it as `job.failure`) |
| `observations.js` | `observationFromFacts(afterReadyArgs, {gpuUsedNowMb, estimate}) → Observation` (consumes 01 `logFacts` from `hooks.afterReady`; never parses logs) |
| `capabilities.js` | `deriveCapabilities(card, launchValues, hostRecord) → {text,vision,audio,embedding,rerank,tools,reasoning,maxContext}`; `capabilityTokens(caps) → string[]` |
| `host-records.js` | entry-only store: `appendQualification(rec)`, `recordsFor(contentDigest)`; written from entry routes and `POST /internal/models/host-records` only |
| `migrate-v1.js` | `convertCapabilitiesV1(v1Json) → {families: v2Json, capabilityIdAliases, warnings[]}` |
| `recipe-draft.js` | `draftRecipeFromLaunch(launch, card, hostRecord, {recipeId, scope, locks, title}) → {recipe, errors[]}` (§15; validated with 01 `engines/recipe-schema.js`) |

Entry routes live in `service-entry/lib/model-card-routes.js` and `service-entry/lib/knowledge-routes.js`, each mounted by one line in the ENT-EV route-mount table of `service-entry/server.js` (see §23 contract change C2).

## 4. ModelCard v1

### 4.1 Identifiers and caching

- `cardId` = `mc_` + first 20 chars of lowercase RFC 4648 base32 (no padding) of `sha256(canonicalRef)`.
  - local: `canonicalRef = "local:" + realpath(dir).replaceAll("\\","/").toLowerCase()` (for a single GGUF file the containing directory plus `#file=<basename>`).
  - remote: `"hf:" + repo + "@" + revision` or `"modelscope:" + repo + "@" + revision` (revision name, not sha; the sha is in `fingerprint`).
- `contentDigest` = `sha256:` + hex of sha256 over: bytes of `config.json`, `generation_config.json`, `tokenizer_config.json`, `chat_template.jinja`, `hf_quant_config.json`, the safetensors index (if any), the GGUF KV block with tokenizer arrays replaced by their counts, plus the sorted `(relative name, size)` list of weight files. It survives renames and moves; host records and calibration key on it.
- Local fingerprint key (cache key) = sha256 of sorted `(relativePath, size, mtimeMs)` for every file up to depth 2, excluding dot-entries and `.cache/`. Only `stat` calls; cheap on 400+ shard folders.
- Cache: raw detector facts at `<AI_ROOT>/cache/model-cards/<cardId>.json` with `{key, inspectorVersion, facts}`; derived fields (family, parsers, support, compatibility) are recomputed on read from the current knowledge, so knowledge edits never require re-inspection. Bumping `INSPECTOR_VERSION` invalidates all cached facts. A missing/corrupt cache file is a miss, never an error.
- Remote cards cache by `(repo, revisionSha)` with a 24 h TTL for the HF API body; a changed sha is a miss.

### 4.2 Evidence model

```json
{ "fact": "/identity/modelType", "value": "qwen3_5",
  "source": { "kind": "file|http|gguf|tensor-table|knowledge|template|probe|qualification|observation|name",
              "ref": "config.json#/model_type" },
  "confidence": "declared|detected|name-heuristic|verified-on-host",
  "note": "optional human text" }
```
- `declared`: the checkpoint states it (config field, GGUF key, file present).
- `detected`: derived by rule from declared data (tensor-name patterns, template fingerprint, probe registry hit, arithmetic on shapes).
- `name-heuristic`: from a folder/repo name; always labelled "guessed / 推测" in UI; never sufficient for `ok` compatibility.
- `verified-on-host`: a qualification check passed on this host for this `contentDigest` and runtime.
- Rank: `verified-on-host` > `declared` > `detected` > `name-heuristic`. `confidenceOf(card, pointer)` returns the highest-ranked evidence for that pointer or `null` (absent ⇒ shown as "unknown / 未知").

### 4.3 Schema (normative; `card-schema.js` encodes it as JSON Schema draft 2020-12)

```jsonc
{
  "schema": "modelcard/v1",
  "cardId": "mc_…",                       // §4.1
  "contentDigest": "sha256:…",
  "inspectorVersion": "1.0.0",
  "knowledgeDigest": "sha256:…",           // digest of the merged knowledge used for derived fields
  "inspectedAt": "ISO",
  "ref": { "kind": "local", "path": "<abs>", "displayPath": "<root-relative>", "file": null }
       | { "kind": "hf|modelscope", "repo": "owner/name", "revision": "main", "sha": "…", "gated": false },
  "origin": { "source": "hf", "repo": "owner/name", "revisionSha": "…" } | null,   // for downloaded local copies
  "format": { "kind": "safetensors|gguf|pytorch-bin|exl3|none|mixed", "weightFiles": 7, "weightBytes": 30868000000,
              "complete": true, "missing": [], "layout": "indexed|unindexed-shards|single|gguf-split|custom" },
  "role": { "value": "main|draft|mtp-head|mmproj|adapter|embedding|reranker|tooling-only", "runnable": true },
  "identity": {
    "modelType": "qwen3_5", "textModelType": "qwen3_5_text", "architectures": ["Qwen3_5ForConditionalGeneration"],
    "ggufArchitecture": null, "transformersVersion": "5.8.0.dev0", "baseModel": null, "displayName": "…",
    "familyId": "qwen3.8", "familyLabel": {"zh":"Qwen3.8","en":"Qwen3.8"}, "matchedBy": "modelType+templateSignature"
  },
  "topology": {
    "paramsTotal": 27780000000, "paramsActive": null, "hiddenSize": 5120, "vocabSize": 248320,
    "layers": 64, "heads": 24, "kvHeads": 4, "headDim": 256,
    "attention": {
      "histogram": { "full": 16, "linear": 48 },
      "runs": [ { "kind": "linear", "count": 3 }, { "kind": "full", "count": 1 } ],   // run-length, repeated to "layers"
      "kinds": {
        "full":   { "kvHeads": 4, "kDim": 256, "vDim": 256 },
        "swa":    null,                               // { "window": 4096, "kvHeads": …, "kDim": …, "vDim": … }
        "linear": { "variant": "gated-deltanet|mamba2", "convKernel": 4, "kHeads": 16, "vHeads": 48, "kDim": 128, "vDim": 128, "ssmDtype": "float32" },
        "mla":    null,                               // { "kvLoraRank": 512, "ropeDim": 64 }
        "compressed": null,                           // { "window": 128, "latentDim": 512, "ratios": [0,0,4,128,…], "indexer": { "heads": 64, "kDim": 128, "topK": 512 } }
        "indexer": null                               // on full layers: { "compressRatio": 4, "kDim": 128, "kvHeads": 1 }
      }
    },
    "moe": null,                                      // { "experts": 256, "active": 8, "shared": 1, "expertBytes": …, "nonExpertBytes": …, "expertBytesPerLayer": [ … ] }
    "mtp": { "layers": 1, "tensorCount": 31, "bytes": 476000000 },
    "ple": null                                       // { "layers": [2], "bytes": 58750000000, "dtype": "float8_e4m3fn" }
  },
  "weights": {
    "exact": true, "totalBytes": 30868000000,
    "byDtype": { "F8_E4M3": 24700000000, "BF16": 6168000000 },
    "byClass": { "dense": 0, "experts": 0, "embedding": 0, "lmHead": 0, "vision": 0, "audio": 0, "mtp": 0, "ple": 0, "other": 0 },
    "expertsByLayer": null                            // GGUF/safetensors per-layer expert bytes for offload planning
  },
  "context": { "native": 262144, "ropeScaling": null, "slidingWindow": null },
  "quant": { "method": "fp8|modelopt|compressed-tensors|awq|gptq|gguf|exl3|bnb|none", "algo": "FP8|NVFP4|Q2_K|…",
             "weightBits": 8, "groupSize": null, "activation": "dynamic|static|none", "kvScheme": null,
             "excludedModules": 42, "ggufFileType": null, "ggufTensorTypes": null },
  "modalities": { "input": ["text","image","video"], "output": ["text"], "visionTower": true, "audioTower": false,
                  "projectorFiles": [] },
  "template": {
    "source": "chat_template.jinja|tokenizer_config.json|gguf|none", "sha256": "c3cf9e34…", "bytes": 8952,
    "signatureId": "qwen38-xml-effort", "exact": true,
    "toolFormat": "qwen-xml-function|hermes-json|mistral|deepseek-dsml|deepseek-v3|harmony|gemma|llama3-json|pythonic|unknown|none",
    "reasoningFormat": "think-tags|harmony-channels|none|unknown",
    "thinking": { "kwarg": "enable_thinking", "defaultOn": true, "effortKwarg": "reasoning_effort", "effortValues": ["xhigh","medium","low"] },
    "systemRole": true
  },
  "parsers": { "vllm": { "tool": "qwen3_coder", "reasoning": "qwen3" }, "sglang": { "tool": "qwen3_coder", "reasoning": "qwen3" },
               "llamacpp": { "tool": "auto", "reasoning": "auto" } },                 // derived, per §8
  "sampling": { "temperature": 1.0, "top_p": 0.95, "top_k": 20, "source": "generation_config.json" },
  "speculative": { "nativeMtp": true, "draftOf": null, "compatibleDrafts": ["mc_…"] },
  "compatibleWith": null,                       // for draft/mmproj/adapter: { "hiddenSize": 5120, "vocabSize": 248320, "targetLayers": 64, "baseModel": null }
  "customCode": { "autoMap": null, "files": [], "trustRemoteCodeRequired": false },
  "support": "known|unknown|blocked",           // "known" = a family entry matched by declared identity; never implies runnable
  "remote": null,                               // remote only: { "downloads": 0, "likes": 0, "lastModified": "ISO", "pipelineTag": "…", "libraryName": "…", "siblings": [{ "name": "…", "size": 0 }] }
  "evidence": [ /* §4.2 */ ],
  "warnings": [ { "code": "template_missing", "message": { "zh": "…", "en": "…" } } ],
  "errors":   [ { "code": "safetensors_header_invalid", "file": "<basename>", "message": { "zh": "…", "en": "…" } } ]
}
```
Rules: every non-null field under `identity`, `topology`, `weights`, `context`, `quant`, `modalities`, `template`, `sampling`, `speculative`, `customCode`, `role` has ≥1 evidence entry (enforced by `validateCard` in tests). Numbers in the example are illustrative except where §2 lists verified values; golden files (§21) hold exact values.

### 4.4 Projections

`projectCard(card, {view:'summary'})` returns `{cardId, displayName, role, familyId, familyLabel, format.kind, quant.method, quant.algo, weights.totalBytes, topology.paramsTotal, topology.paramsActive, context.native, modalities.input, template.toolFormat, template.reasoningFormat, support, confidence: {identity, template, weights}}`. `redactPaths:true` (LAN viewers) replaces `ref.path` with `displayPath` and drops `evidence[].source.ref` values that contain path separators beyond the model directory.

## 5. Local detectors

All reads are bounded: JSON files ≤ 8 MiB (larger → error `file_too_large`, fact unknown), safetensors header length ≤ 256 MiB (existing guard), GGUF header parse stops at the tensor-info table end. No weight payload is read.

| Detector | Reads | Produces |
|---|---|---|
| inventory | `readdir` depth ≤ 2, `stat` | files by class (`config`, `tokenizer`, `template`, `weights:{safetensors,gguf,bin,exl3}`, `index`, `adapter_config.json`, `modules.json`, `*.py`, `processor`), `.complete.json` markers, hidden/`.cache` excluded, `layout` |
| hf-config | `config.json` | identity from root and nested `text_config`/`llm_config`/`language_config`; vision/audio towers; `auto_map`; `quantization_config`; `mtp_num_hidden_layers` and `mtp{}`; `layer_types`/`full_attention_interval`; `sliding_window` + `max_window_layers`/`use_sliding_window`; `kv_lora_rank`/`qk_rope_head_dim` (MLA); `linear_*` (gated-deltanet); `ssm_*`/`mamba_*`; `indexer_*`; `ple_*`; `num_experts`/`n_routed_experts`/`num_experts_per_tok`/`n_shared_experts`/`shared_expert_intermediate_size`; `rope_scaling`/`rope_parameters`; `dflash_config`/`eagle_config`/`num_target_layers` (drafts); `transformers_version` |
| generation-config | `generation_config.json` | sampling defaults (`temperature`, `top_p`, `top_k`, `min_p`, `repetition_penalty`), eos ids |
| template | `chat_template.jinja` → `tokenizer_config.json#chat_template` (string or named list; `default` wins) → GGUF `tokenizer.chat_template` | text (kept in facts cache only, not in API output except `?include=template` for admins), `sha256` of the text with CRLF→LF, `bytes` |
| quant | `quantization_config`, `hf_quant_config.json` (`quantization.quant_algo`, `kv_cache_quant_algo`, `exclude_modules`), compressed-tensors `config_groups`, tensor dtypes, GGUF `general.file_type` + per-tensor types | §4.3 `quant`; `method` normalised: `modelopt` + algo `NVFP4`/`FP8`; `compressed-tensors` + scheme (`W4A16`, `W8A8`, `NVFP4`); `fp8`; `awq`; `gptq`; `auto-round`; `bitsandbytes`; `exl3`; `gguf` |
| safetensors | index `weight_map` names; every shard header (unindexed layouts and byte classes need headers) | TensorTable `{name, dtype, shape, bytes, file}`; `byDtype`, `byClass`, `expertsByLayer`, mtp/ple/vision evidence |
| gguf | widened header (§5.1) | identity, topology, context, sampling, template, quant, TensorTable with exact bytes |
| topology | the above | per-layer attention kinds (§4.3), MoE, MTP, PLE |

Tensor classes (data, in `data/knowledge/families.json` top-level `tensorClasses`, so new naming schemes need no code):
```json
[ { "class": "experts",  "patterns": ["\\.experts\\.\\d+\\.", "\\.mlp\\.experts\\.", "^blk\\.\\d+\\.ffn_(?:gate|up|down|gate_up)_exps\\."] , "layerGroup": 1 },
  { "class": "mtp",      "patterns": ["^(?:model\\.)?mtp\\.", "\\.nextn\\.", "^blk\\.\\d+\\.nextn\\."] },
  { "class": "ple",      "patterns": ["\\.ple\\.", "per_layer_embed"] },
  { "class": "vision",   "patterns": ["(?:^|\\.)visual\\.", "vision_tower", "^v\\.", "multi_modal_projector"] },
  { "class": "audio",    "patterns": ["audio_tower", "^a\\."] },
  { "class": "embedding","patterns": ["embed_tokens\\.weight$", "^token_embd\\."] },
  { "class": "lmHead",   "patterns": ["^lm_head\\.", "^output\\.weight$"] } ]
```
Unmatched tensors are `dense`. `layerGroup` names the capture group / numeric segment used to bucket per-layer expert bytes.

### 5.1 GGUF parser changes (`manager-core/gguf-metadata.js`)

- Capture additionally: `tokenizer.chat_template` (≤ 1 MiB), `general.sampling.*`, `general.type`, `general.base_model.*`, and any key under `<arch>.` except arrays longer than 4096 (stored as `{ "$array": <type>, "count": n }`). This covers `attention.compress_ratios`, `attention.indexer.*`, `attention.kv_lora_rank`, `attention.key_length_mla`, `ssm.*`, `full_attention_interval`, `nextn_predict_layers`, `expert_shared_count`, `rope.scaling.*`, `hyper_connection.*`.
- Tensor infos: keep `{name, type, dims}`; compute bytes with `ggml-types.js` (complete ggml type table incl. K-, IQ-, TQ-, MXFP4 and BF16 types; unknown type id ⇒ `weights.exact=false` and a warning, never a guess presented as exact).
- `slidingLayers`: if only `sliding_window` is present and no pattern, layers are **not** assumed SWA unless the family entry declares `ggufSwaAllLayers: true`; otherwise topology marks the kind as `unknown` and fit uses the conservative (full) bound.
- New `parseGgufHeaderBuffer(buffer, {partial:true})` shares the key/value decoder and throws `GgufNeedMoreBytes {requiredBytes}` so the remote Range reader can grow the window (§6). The sync file reader keeps working for local files.
- Existing exports and their outputs stay identical for keys they already returned (gguf-metadata tests pass unchanged).

## 6. Remote inspection

`inspectRemote` produces the same ModelCard so the pre-download check equals the post-download check.

Hugging Face (`remote/hf.js`)
1. `GET {endpoint}/api/models/{repo}/revision/{revision}?blobs=true` → `sha`, `siblings[{rfilename,size}]`, `safetensors.{parameters,total}`, `gguf.{architecture,context_length,total,chat_template}`, `config{architectures,model_type,quantization_config,tokenizer_config}`, `cardData.base_model`, `pipeline_tag`, `library_name`, `gated`. Every field becomes `declared` evidence with `source.kind:"http"`.
2. Small files via `GET {endpoint}/{repo}/resolve/{sha}/{file}` (≤ 8 MiB each, ≤ 6 files): `config.json`, `generation_config.json`, `tokenizer_config.json`, `chat_template.jinja`, `hf_quant_config.json`, `model.safetensors.index.json`.
3. GGUF: for the selected variant (or the largest complete one), Range-read the header of shard 1 (§6.1). `weights.totalBytes` = sum of sibling sizes (exact); expert/class bytes from the parsed tensor table.
4. Safetensors: tensor names from the index give mtp/experts/vision evidence; byte classes need headers, which are Range-read only when there is no index or ≤ 8 shards (`head` = 8 bytes, then `8..8+N`). Otherwise `weights.byClass` is apportioned from `safetensors.parameters` per dtype and marked `detected` (not exact).

ModelScope (`remote/modelscope.js`): `GET https://www.modelscope.cn/api/v1/models/{owner}/{name}/repo/files?Recursive=true&Revision={rev}` for sizes; raw files from `/models/{repo}/resolve/{rev}/{file}`. If Range is not honoured, header-derived facts stay unknown (never fabricated). `hasConfig` is a fact from the file list, not a constant.

### 6.1 Range reader (`remote/range-reader.js`)

`readRange(url, {start, length, maxBytes, fetchImpl, headers, signal}) → Buffer`
- Sends `Range: bytes=start-(start+length-1)`. A `206` is read fully (bounded by `length`). A `200` (Range ignored) is streamed and **cancelled after `maxBytes`**; the reader returns what it has and flags `rangeIgnored`. A body is never read beyond `maxBytes` (default 32 MiB; config `models.remoteHeaderMaxBytes`).
- GGUF growth: initial 2 MiB; on `GgufNeedMoreBytes` the next request covers up to `requiredBytes` rounded to 1 MiB, doubling, until parsed or `maxBytes`.
- Requests go through `fetchWithSystemProxyFallback`; when the P3 hub providers exist, endpoint/mirror selection is delegated to `model-hub/providers/*` (HF token sent only to the official HF endpoint or a mirror the owner configured).
- Total remote inspect budget 45 s; each request 12 s; single-flight per `(source, repo, revision)`.
- Remote inspection runs only on explicit inspect/precheck/variant actions, never for every search result row (see open decision O2).

## 7. Role detection and pairing (`detectors/role.js`)

Evaluated in order; the first match wins; every rule records evidence.

| Role | Rule (any) | Confidence |
|---|---|---|
| `tooling-only` | no `config.json` and no GGUF at the folder root, and no loadable weights (custom subfolder layouts such as `ples_int4/`, only `*.py`/`*.md`) | detected; `runnable:false` |
| `adapter` | `adapter_config.json` present; or GGUF `general.type == "adapter"` | declared |
| `mmproj` | GGUF `general.type` ∈ {mmproj, projector} or `clip.*` keys or arch `clip`; safetensors-only projector (architectures `*Projector*`) | declared |
| `draft` | architectures match `/(Draft\|Eagle\d?\|DFlash\|DSpark\|Medusa)(Model\|ForCausalLM)?$/i`; or `dflash_config`/`eagle_config`/`num_target_layers` present; GGUF `general.type` draft or arch `dflash*`; filename `dflash\|draft` (GGUF only) ⇒ name-heuristic | declared/detected |
| `mtp-head` | all tensors in `mtp.*`/`nextn` classes and no `embed`+`lmHead` of its own, or `model_type` ends with `_mtp` | detected |
| `embedding` | `modules.json` + `1_Pooling/config.json`; architectures `*EmbeddingModel`/`BertModel`/`XLMRobertaModel` with no LM head; GGUF `<arch>.pooling_type` ∈ {mean, cls, last} and not causal | declared/detected |
| `reranker` | `*ForSequenceClassification` with `num_labels == 1`; GGUF `<arch>.pooling_type == rank`; name `rerank` ⇒ name-heuristic only | declared/name-heuristic |
| `main` | weights present and an LM head (`lmHead` class or tied embeddings) | detected |

`compatibleWith` (draft/mtp-head/mmproj/adapter): `{hiddenSize, vocabSize, targetLayers, baseModel}`; for mmproj the projector output dim (`clip.vision.projection_dim` / `out_hidden_size`). `pairCompanions(cards)` pairs a companion with mains where `vocabSize` equal and (`hiddenSize` equal or projector dim equals main `hiddenSize`) and (`targetLayers` absent or equal to main `layers`); same-folder GGUF companions pair first. Verified case: the DSpark draft (hidden 5120, vocab 248320, `num_target_layers` 64) pairs with Qwen3.8-27B (text hidden 5120, 64 layers, vocab 248320). Pairing is `detected`; the UI offers it, never applies it silently.

Library behaviour: `runnable:false` cards are listed under "Artifacts / 附属文件" and hidden from the launch picker; drafts/mmproj appear only as companions of their paired mains.

## 8. Layered knowledge (D5)

### 8.1 Files and layers

Kinds: `families`, `template-signatures`, `error-signatures` (plus the `tensorClasses` list inside families). Each file carries `schemaVersion`, `kind`, `asOf`, `staleAfterDays`, `entries[]` (rule §7.5).

| Precedence (low → high) | Location | Written by |
|---|---|---|
| 1 bundled | `manager-core/data/knowledge/{families,template-signatures,error-signatures}.json` | git |
| 2 legacy user v1 | `<AI_ROOT>/config/model-capabilities.json` (if present) converted at load by `migrate-v1.js`; never rewritten | owner (old format) |
| 3 imported packs | `<AI_ROOT>/config/knowledge.d/packs/<packId>@<sha12>.json` | `POST /api/knowledge/import` after confirmation |
| 4 user | `<AI_ROOT>/config/knowledge.d/*.json` (any kind per file; `kind` field required) | owner / console editor |
| 5 per-model | `<AI_ROOT>/config/knowledge.d/models/<slug>.json` (`match: {contentDigest} \| {repo} \| {path}`), plus read-only `<modelDir>/.platform/model.json` | console "Override for this model" |

Imported packs sit **below** the owner's own files: third-party data can never override what the owner wrote (see contract change C4; the listed order in the brief is read as the set of layers).

Error signatures have one extra source: 01 engine descriptors carry engine-specific additions in `errorSignatures[]`, in the §8.4 schema (bundled descriptor or `<AI_ROOT>/config/engines/*.json`; 01 §16.3). `knowledge.errorSignatures(engineId)` reads them through `registry.errorSignatureAdditions()` and merges them into the bundled layer with `engines` defaulted to `[descriptor.id]`, so owner layers can override any entry by `id`. An addition whose `code` duplicates a bundled knowledge entry is dropped and reported as `duplicate_code` in `/api/knowledge/status`. This is the only loader for error hints (00 §9.11); `logIssueHint` and `buildLogSuggestions` retire onto it (cross-check issue 20).

Merge: entries merge by `id` (a later layer replaces the whole entry unless it sets `"$merge": "deep"`, which deep-merges objects and replaces arrays); `{"id": "x", "$delete": true}` hides a lower-layer entry. Order of evaluation for families = `priority` desc, then layer desc, then file order.

Validation: JSON Schema per kind (`manager-core/data/knowledge/schema/*.json` loaded by `knowledge.js`; draft 2020-12 subset validator already needed for card-schema, implemented in `model-inspector/json-schema-lite.js`, no dependency). Invalid entries are skipped and reported; an unparsable file is reported and skipped; startup never fails. Regex safety for every pattern from any layer: length ≤ 300, no backreferences, no nested quantifiers (`(…[+*])[+*{]`), compiled with flags from an allowlist (`i`, `m`, `s`); log lines are truncated to 2000 chars and at most the last 4000 lines are scanned.

Status (`knowledgeStatus()` and §17 `GET /api/knowledge/status`): per layer `{layer, path (display form), files:[{name, kind, entries, errors[], asOf, stale}], digest}`; heuristic-hit counters (persisted to `<AI_ROOT>/cache/knowledge-hits.json`, flushed every 60 s); entries with no fixture.

### 8.2 Families v2 schema (excerpt)

```jsonc
{ "schemaVersion": 2, "kind": "families", "asOf": "2026-10-14", "staleAfterDays": 120,
  "tensorClasses": [ /* §5 */ ],
  "capabilityIdAliases": { "qwen3.8-flash-next": "qwen3.8-flash-next", "qwen3.5-3.6": "qwen3.5-3.6", "muse-glimmer": "muse-glimmer" },  // v1 id → familyId, generated (§8.5)
  "entries": [ {
    "id": "qwen3.8", "label": { "zh": "Qwen3.8", "en": "Qwen3.8" }, "priority": 20,
    "confidence": "verified|documented|community",
    "match": {
      "modelTypes": ["qwen3_5", "qwen3_5_moe", "qwen3_8", "qwen3_8_moe"],
      "architectures": [], "architecturePatterns": [], "ggufArchitectures": ["qwen3_8", "qwen38"],
      "require": [ { "templateSignature": ["qwen38-xml-effort"] } ],   // all "require" clauses must hold
      "where": [ { "path": "/topology/hiddenSize", "op": "in", "value": [5120, 2560] } ],
      "namePatterns": ["qwen3[._]?8(?![0-9])"]                          // last resort, counted, name-heuristic
    },
    "contextMax": 262144,
    "sampling": null,                                                  // overrides generation_config only if set
    "speculative": { "native": "mtp", "auto": { "vllm": "mtp", "sglang": "dspark", "llamacpp": "dflash" },
                     "autoOffForQuant": "nvfp4|modelopt",
                     "reason": { "zh": "…", "en": "Qwen3.8 packages MTP tensors; auto MTP stays off on ModelOpt/NVFP4 until acceptance is validated." } },
    "engines": {
      "vllm":     { "support": "verified", "parsers": { "tool": "qwen3_coder", "reasoning": "qwen3" },
                    "parsersByQuant": { "nvfp4|modelopt": { "tool": "qwen3_xml" } },
                    "enableAutoToolChoice": true, "trustRemoteCode": false, "env": {}, "requiredPluginFile": null,
                    "minimumVersion": null },
      "sglang":   { "support": "verified", "parsers": { "tool": "qwen3_coder", "reasoning": "qwen3" } },
      "llamacpp": { "support": "documented", "minimumBuild": null }
    },
    "blocks": [],                                                      // { engines, when:{hostPlatform:"wsl"}, unlessEnv, code, reason }
    "download": { "level": "ok", "reason": null },
    "requires": { "minimumComputeCapability": null, "runtimeId": null },
    "notes": [], "fixtures": ["qwen38-27b-fp8", "qwen38-27b-fp8-indexed"], "sources": []
  } ] }
```
Matching (`matchFamily`): declared identity (`modelTypes`, `architectures`, `architecturePatterns`, `ggufArchitectures`) gates the entry; `require`/`where` clauses discriminate entries that share a `model_type`; the most specific passing entry wins (`priority`, then number of satisfied clauses). Name patterns are consulted only when the card has **no** declared identity. `matchedBy` lists the clauses that matched; family confidence on the card = `declared` if gated by declared identity (and `detected` if a template clause was needed), `name-heuristic` otherwise. The entry's own `confidence` is reported separately as `knowledgeConfidence` and never copied into fact confidence (fixes the precheck bug in newmodels finding 4).

Policy blocks expressed as data (all from today's code, behaviour unchanged):
- Muse Glimmer: `engines.vllm.support = "blocked"`, `engines.llamacpp.support = "blocked"`, `download.level = "block"`, `"bypass": false` (the legacy `VLLM_ALLOW_MUSE_GLIMMER` is ignored).
- DiffusionGemma: `blocks: [{engines:["vllm"], when:{hostPlatform:"wsl"}, unlessEnv:"VLLM_ALLOW_WINDOWS_DIFFUSION_GEMMA", code:"diffusion_gemma_windows"}]`.
- BNB on vLLM: not a family rule; it is a runtime-facts rule (§9 R6) driven by `plugins.bnb === false`.

### 8.3 Template signatures schema

```jsonc
{ "schemaVersion": 1, "kind": "template-signatures", "asOf": "2026-10-14", "staleAfterDays": 180,
  "entries": [
    { "id": "qwen38-xml-effort", "label": { "zh": "Qwen XML 函数调用 + 思考强度", "en": "Qwen XML function calls + reasoning effort" },
      "sha256": ["c3cf9e34abf4f9e3…"],                                   // exact hashes (full 64 hex in data)
      "features": { "all": ["<tool_call>", "<function=", "<parameter="], "any": [], "none": [], "regex": ["reasoning_effort"] },
      "toolFormat": "qwen-xml-function", "reasoningFormat": "think-tags",
      "thinking": { "kwarg": "enable_thinking", "defaultOn": true, "effortKwarg": "reasoning_effort", "effortValues": ["xhigh","medium","low"] },
      "parsers": { "vllm": { "tool": "qwen3_coder", "reasoning": "qwen3", "alternatives": ["qwen3_xml"] },
                   "sglang": { "tool": "qwen3_coder", "reasoning": "qwen3" },
                   "llamacpp": { "tool": "auto", "reasoning": "auto", "reasoningFormat": "deepseek" } } },
    { "id": "qwen-xml-function", "features": { "all": ["<tool_call>", "<function=", "<parameter="] }, … },
    { "id": "hermes-json", "features": { "all": ["<tool_call>"], "regex": ["tojson"], "none": ["<function="] },
      "toolFormat": "hermes-json", "parsers": { "vllm": { "tool": "hermes" }, "sglang": { "tool": "qwen25" }, "llamacpp": { "tool": "auto" } } },
    { "id": "deepseek-dsml", "features": { "all": ["DSML", "tool_calls", "invoke"] }, "toolFormat": "deepseek-dsml",
      "reasoningFormat": "think-tags", "thinking": { "kwarg": "thinking", "aliases": ["enable_thinking"], "defaultOn": false },
      "parsers": { "vllm": { "tool": null, "reasoning": null }, "sglang": { "tool": "deepseekv4", "reasoning": "deepseek-v4" },
                   "llamacpp": { "tool": "auto", "reasoning": "auto" } } },
    { "id": "deepseek-v3-markers", "features": { "any": ["tool▁calls▁begin", "tool▁call▁begin"] }, "toolFormat": "deepseek-v3", … },
    { "id": "mistral-tool-calls", "features": { "all": ["[TOOL_CALLS]"] }, "toolFormat": "mistral", … },
    { "id": "harmony", "features": { "all": ["<|channel|>"] }, "toolFormat": "harmony", "reasoningFormat": "harmony-channels", … },
    { "id": "llama3-json", "features": { "all": ["<|python_tag|>"] }, … },
    { "id": "gemma4", "features": { "any": ["<start_function_call>", "<|tool_call>"] }, … },
    { "id": "think-only", "features": { "all": ["<think>"], "none": ["<tool_call>", "[TOOL_CALLS]", "DSML"] }, "toolFormat": "none", … } ] }
```
Parser names for engines are data and are validated against the runtime facts (§12.3) before use; names in this excerpt for vLLM/SGLang/DeepSeek-V4 come from the engine-research slice and are `documented`, to be confirmed by the probe of the pinned images (open decision O7).

### 8.4 Error signatures schema (replaces `logIssueHint`/`buildLogSuggestions` and 01's hint seeds)

One schema for knowledge files and 01 descriptor `errorSignatures[]` additions. Fields: `id`, `code` (snake_case, becomes `JobError.code`), `engines` (`["*"]` = all), `phase` (00 §4.1 lifecycle phase), `rootCause` (bool), `severity` (`error|warn`), `regex`, `title{zh,en}`, `hint{zh,en}` (one-line next step, becomes `JobError.hint`), `explanation{zh,en}` (optional), `suggestions[]`.

```jsonc
{ "schemaVersion": 1, "kind": "error-signatures", "asOf": "2026-10-14", "staleAfterDays": 180,
  "entries": [
    { "id": "transformers-unknown-arch", "code": "transformers_unknown_arch", "engines": ["vllm", "sglang"], "phase": "weights", "rootCause": true, "severity": "error",
      "regex": "model type `([^`]+)` but Transformers does not recognize this architecture",
      "title": { "zh": "镜像中的 Transformers 不认识模型类型 {1}", "en": "Transformers in this image does not know model type {1}" },
      "hint": { "zh": "运行预检探针，或换用更新的运行时镜像。", "en": "Run the dry probe, or use a newer runtime image." },
      "explanation": { "zh": "检查点比运行时镜像新，或需要自定义建模代码。", "en": "The checkpoint is newer than the runtime image, or it needs custom modeling code." },
      "suggestions": [ { "kind": "probe" }, { "kind": "param", "param": "trustRemoteCode", "to": true, "security": true },
                       { "kind": "runtime", "action": "newer-image" } ] },
    { "id": "llama-unknown-arch", "code": "llama_unknown_arch", "engines": ["llamacpp"], "phase": "weights", "rootCause": true,
      "regex": "unknown model architecture: '([^']+)'", … },
    { "id": "cuda-buffer-alloc", "code": "cuda_buffer_alloc", "engines": ["llamacpp"], "phase": "weights", "rootCause": true,
      "regex": "failed to allocate (CUDA\\d+) buffer of size (\\d+)",
      "suggestions": [ { "kind": "param", "param": "llamacpp.nCpuMoe", "to": "planner" }, { "kind": "param", "param": "llamacpp.gpuLayers", "to": "planner" } ] },
    { "id": "vllm-kv-too-small", "code": "kv_too_small", "engines": ["vllm"], "phase": "kv", "rootCause": true,
      "regex": "(?:larger than the maximum number of tokens that can be stored in KV cache|No available memory for the cache blocks|larger than the available KV cache memory)",
      "suggestions": [ { "kind": "param", "param": "contextLength", "to": "planner" }, { "kind": "param", "param": "kvCacheDtype", "to": "fp8" } ] },
    { "id": "modelopt-layout-mismatch", "code": "modelopt_layout_mismatch", "engines": ["vllm"], "phase": "weights", "regex": "w2_input_scale|modelopt_mixed|exceeds dimension size", … },
    { "id": "deepgemm-sf-transform", "code": "deepgemm_sf_transform", "engines": ["vllm"], "phase": "weights", "regex": "Unknown SF transformation", … },
    { "id": "mamba-align-batched-tokens", "code": "mamba_align_batched_tokens", "engines": ["vllm"], "phase": "kv", "regex": "mamba cache align|block_size .*batched_tokens",
      "suggestions": [ { "kind": "param", "param": "vllm.maxNumBatchedTokens", "to": "planner" } ] },
    { "id": "flashinfer-prefill-crash", "code": "flashinfer_prefill_crash", "engines": ["vllm"], "phase": "api", "regex": "BatchPrefillWithPagedKVCache|illegal memory access", … },
    { "id": "wsl-uva-missing", "code": "wsl_uva_missing", "engines": ["vllm"], "phase": "weights", "regex": "UVA is not available", … },
    { "id": "port-in-use", "code": "port_in_use", "engines": ["*"], "phase": "container", "regex": "address already in use", … },
    { "id": "trust-remote-code", "code": "trust_remote_code_required", "engines": ["vllm", "sglang"], "phase": "weights", "regex": "trust_remote_code", … },
    { "id": "cuda-oom", "code": "cuda_oom", "engines": ["*"], "phase": "kv", "regex": "CUDA out of memory|out of memory",
      "suggestions": [ { "kind": "param", "param": "contextLength", "to": "planner" }, { "kind": "param", "param": "concurrency", "to": "planner" }, { "kind": "param", "param": "kvCacheDtype", "to": "fp8" } ] },
    { "id": "gated-token", "code": "hf_gated_token", "engines": ["*"], "phase": "weights", "regex": "gated repo|401 Client Error|Invalid token", … } ] }
```
`{n}` placeholders interpolate capture groups (escaped). `"param"` names are 01 parameter-catalog ids (01 §9.3/§9.4; a load-time check rejects ids absent from every engine catalog once ENG-3 has landed); `"to": "planner"` asks the planner (§11) for a concrete value given the current launch. Every existing `logIssueHint`/`buildLogSuggestions` branch maps to one entry (migration test in §21.2). Generic entries (`cuda_oom`, `port_in_use` for `address already in use`) and all model-related hints are 02 bundled data; 01 descriptors add only `flag_unknown` (vllm, sglang) and the llama.cpp `mmproj_missing` entry (01 §16.3). The loader accepts `stage` as a deprecated alias of `phase`.

### 8.5 Migration from model-capabilities.json v1 and code branches

`scripts/migrate-capabilities-v1.js` (also `migrate-v1.js` at load for user v1 files) maps each v1 entry to a v2 family: `match.*` copied; `vllm.reasoningParser/toolCallParser` → `engines.vllm.parsers`; `toolCallParserByQuant` → `parsersByQuant`; `speculative` → top-level `speculative` (`auto` per engine); `sglang.image` + `imageRequiresQuant` → **moved to a 01 recipe** reference (`notes` keeps the text; the family keeps no images); `llama.ggufArchitectures` → `match.ggufArchitectures`; `supported:false` → `support:"blocked"`; `download` copied; `requires.runtime` legacy key → `runtimeId` via the manifest alias table. The generated `families.json` is committed together with `capabilityIdAliases` (every v1 id → its family id; identity for the 14 current entries, because v2 keeps the v1 ids). `model-capabilities.json` stays in `manager-core/data/` and is no longer read by new code. MOD-21 deletes it only after 01 ENG-25 has moved every bundled recipe to `match.familyId` (01 recipe schema, 00 §9.10: `match: {familyId?, contentDigest?, runtimeId?, capabilityIds? (deprecated alias)}` plus its existing quant/compute/memory keys). After the deletion, a recipe that still says `capabilityIds` resolves through `knowledge.familyIdForCapabilityId`, and the 01 expression fact `model.capabilityId` returns the same alias.

`model-capability-matrix.js` becomes a shim over families v2 (same exports: `resolveModelCapabilityEntry`, `resolveEngineCapabilities`, `describeModelCapabilityMatrix`, …) so `/api/capability-data`, download precheck and the vLLM capability module keep working during migration. Equivalence test: for every v1 entry and engine, shim output equals v1 output except the documented Qwen3.8 rekey.

Code branch destinations:

| Today | Destination |
|---|---|
| `vllm-manager/lib/model-capabilities.js:141-188` `resolveSpeculativeConfig` (isQwen35 regex, name NVFP4 test), `:270-296` legacy name branches | family `speculative` + card `quant.method` + `topology.mtp` evidence |
| `vllm-manager/server.js:2034-2045` `inferReasoningParser`, `:3172-3187` `inferToolCallParser`, `:3128-3170` allow-lists | `resolveParsers` (§8.6) + runtime facts parser lists |
| `vllm-manager/server.js:1844-1860` quant-by-name | card `quant` (declared) |
| `vllm-manager/server.js:3306-3333` family predicates, `:3385-3643` `resolveVllmRuntimePreset` | images/flags/env → 01 recipes; parsers/speculative → families; caveats → family `notes` |
| `vllm-manager/server.js:2071-2110` hints | error signatures |
| `vllm-manager/public/app.js:3864-3886` hard-coded geometry, `:3492-3560` estimator, `:3944-3998` parser guessers | server card + fit (`/api/model/config`, `/api/memory-estimate`) |
| `llama-manager/server.js:1658-1666,1728-1733`, `public/app.js:3918-3923` name regexes (multimodal, reasoningFormat) | card `modalities`, template signature `parsers.llamacpp.reasoningFormat` |
| `llama-manager/lib/memory-estimate.js` Muse sampling branch | family `sampling` |
| `service-entry/lib/model-fleet.js:84-105` name inference | published capabilities (§16); regex kept as labelled last resort |

### 8.6 Parser resolution with engine `auto` pass-through

`resolveParsers(card, engineId, ctx)` returns `{value, source, reason}` for `tool`, `reasoning`, `enableAutoToolChoice` with precedence:
1. per-model override (layer 5) → `source:"model-override"`;
2. family `engines.<id>.parsersByQuant` (quant-scoped workaround) then `engines.<id>.parsers` → `source:"knowledge"`;
3. template signature `parsers.<id>` → `source:"template"`;
4. the 01 descriptor declares `capabilities.autoParsers.{tool,reasoning}` (each `string|null`; 01 §4.1, 00 §9.10) → `value` = that string (for example `"auto"`), `source:"engine-auto"`, reason "engine detects from the chat template / 由引擎按模板自动识别";
5. otherwise `""` (feature off) with a warning `parser_unknown` and the action "pick a parser / run probe".
A non-empty value not present in the runtime's parser lists is replaced by step 4 (or 5), and a warning `parser_not_in_image` names the image and the missing parser. The lists come from `engines.runtimeFacts.get(runtimeId)`: introspected `choices` of `toolCallParser`/`reasoningParser` first, then the probe `registries` section (§12.3). Values are never silently dropped. `enableAutoToolChoice` (catalog id `autoToolChoice`) is true iff a tool parser value is non-empty. The results map to catalog ids `toolCallParser`, `reasoningParser` and `autoToolChoice` (llama.cpp: `llamacpp.reasoningFormat`). A user value in the launch request always wins unless a recipe locks it (01 resolver).

## 9. Compatibility matrix (`compatibility.js`)

One row per `(engineId, runtimeId)` known to the platform (the entry's aggregated `GET /api/engines`, which reads each manager at `/api/m/:managerId/engines`; fallback: `runtime-manifest.json` keys mapped to runtimeIds) plus external endpoints (always `unknown`, external models are not inspected). Descriptor fields use 01's names: `artifactFormats`, `capabilities.roles`, `capabilities.autoParsers`. Runtime facts come from `engines.runtimeFacts.get(runtimeId)` → `{flags (introspection), registries (probe): {architectures, modelTypes, quantMethods, toolParsers, reasoningParsers, kvCacheDtypes, plugins, transformersVersion}} | null`.

Card role → descriptor `capabilities.roles` value: `main` → `chat`, `embedding` → `embedding`, `reranker` → `rerank`; `draft`, `mtp-head`, `mmproj`, `adapter` and `tooling-only` are never standalone-servable.

```jsonc
{ "engineId": "llamacpp", "runtimeId": "llamacpp@b10630", "verdict": "ok|warn|block|unknown",
  "supportEvidence": [ { "kind": "verified-on-host|probe|knowledge", "ref": "…", "confidence": "…" } ],
  "reasons": [ { "code": "arch_not_in_knowledge", "level": "unknown", "message": { "zh": "…", "en": "…" }, "evidence": "/identity/ggufArchitecture" } ],
  "actions": [ { "kind": "probe", "label": { "zh": "运行预检探针", "en": "Run dry probe" } } ],
  "fitPreview": { "minimalFits": true, "needsOffload": true, "status": "warn" } }
```

Rules (evaluated in order, all collected; verdict = worst level with `block > warn > unknown > ok`):

| # | Rule | Level |
|---|---|---|
| R1 | `format.kind` not in descriptor `artifactFormats` (e.g. safetensors on llama.cpp; GGUF on vLLM when `registries.plugins.gguf === false`) | block |
| R2 | Family `engines.<id>.support === "blocked"` or a matching family `blocks[]` (unless its `unlessEnv` is set) | block |
| R3 | Role not runnable or not servable by the engine (`tooling-only`; mapped role missing from descriptor `capabilities.roles`; `draft`/`mmproj` standalone) | block |
| R4 | GPU compute capability below family/runtime minimum | block |
| R5 | Quant method not in runtime facts `quantMethods` | block (facts known) / unknown (facts unknown) |
| R6 | `quant.method == bitsandbytes` and facts/manifest `plugins.bnb === false` | block |
| R7 | NVFP4 weights on SM < 10.0, FP8 on SM < 8.9 | warn ("emulated / 慢速回退") |
| R8 | Architecture not in runtime facts `architectures` and `customCode.autoMap` present | warn (`needs trust_remote_code`, security) |
| R9 | Architecture not in runtime facts and no `auto_map` | block when facts known; unknown otherwise |
| R10 | `identity.transformersVersion` newer (major.minor) than runtime `transformersVersion` and arch not confirmed by facts | warn |
| R11 | Fit preview (`estimateFit` with `contextLength` 4096, `concurrency` 1, maximum offload): `status:"fail"` on the selected GPUs + RAM | block; fits only with `spill:true` → warn |
| R12 | `contextMax`/native context vs requested goal | info in `reasons` only |
| R13 | Parser for the detected tool format unavailable in the image (§8.6) | warn |

`ok` requires at least one `supportEvidence` item: a `verified-on-host` record for `(contentDigest, runtimeId)`, a successful probe for `(contentDigest, runtimeId)`, a runtime-facts registry hit for the declared architecture, or a family entry matched by **declared** identity whose `engines.<id>.support` ∈ {verified, documented} and whose `minimumVersion`/`minimumBuild` is satisfied. Otherwise the best verdict is `unknown` with actions `[probe, override]`. Name-heuristic family matches never count. A property test asserts no row is `ok` without `supportEvidence` (§21.2).

Legacy adapters (behaviour fixes on top of 08 P0-14/P0-15, same shapes, 08 copy kept verbatim):
- `assessDownloadCompatibility` (download precheck) builds findings from the remote card + rows of the requested engine **for every engine runtime** (not only the vLLM image), all selected GPUs (not only `gpus[0]`), and passes the GGUF architecture for remote GGUF repos. Finding codes are unchanged (`identity_unlisted` keeps its code; its level becomes `warn`). `capability.confidence` reports the fact confidence, and name-only matches keep P0-14's "按名称推断（未验证）/ Inferred from the name (unverified)". The `trust_remote_code` finding keeps P0-14's text.
- `evaluateLlamaArchitectureRuntimeCompatibility` keeps P0-15's result `{status:"unknown", supported:null}` and message for unlisted architectures; MOD-11 only moves the lookup from the v1 matrix to families v2 (`match.ggufArchitectures`). `gguf-model-ui.js` keeps P0-15's label "未知（未验证）/ Unknown (unverified)"; 02 makes no UI change there.

## 10. Memory fit (`fit.js`): artifact inputs, engine estimate, grading

### 10.1 Split of responsibility (cross-check issue 1)

| Concern | Owner | Where |
|---|---|---|
| Bytes derived from the artifact: weight bytes by class and their GPU/RAM placement under the offload values, KV bytes per token and per layer kind, recurrent state per sequence, KV bytes for the requested context × sequences, draft and projector bytes | 02 | `fit.artifactMemoryInputs` (§10.3, §10.4) |
| How an engine reserves memory (device fraction, static fraction of free memory, GGUF compute buffers), activations, graphs and overheads, `kvPoolTokens`, `maxFullLengthRequests`, the `policy` value and the exact `admissionRequest` sent to gpu-admission | 01 | `engines.memoryModels.estimate(engineId, inputs)` in `manager-core/engines/memory-models.js` (ENG-12). It carries 08 P0-RT-3's admission fields unchanged |
| Grading (`status`, `spill`, budget, headroom, suggestions, range, assumptions), the calibration store, `/api/memory-estimate` card mode, fit-grid | 02 | `fit.estimateFit`, `fit.fitGrid`, `calibration.js` (§10.5-§10.8) |
| Admission verdict at launch | 01 + 08 | `LaunchPlan.admission` from `gpuAdmission.evaluate`; `FitResult.status` is advisory for planning |

`estimateFit` = `artifactMemoryInputs` → `engines.memoryModels.estimate` → grading. `LaunchPlan.memory` is the same `estimate` call, made by the 01 adapter with `MemoryInputs.artifact` from `planFacts` (PlanCtx `modelFacts`), so a plan and a fit for the same card and values report the same `perGpuMb`, `policy` and `admissionRequestMb` (equality test, §21.2). 02 edits neither `gpu-admission.js` nor either `lib/launch-request.js`. Without a card (legacy bodies), `legacyEstimate` keeps the legacy path.

### 10.2 FitInput, artifact inputs, FitResult

Launch values use 01 catalog param ids only (01 §9.3, §9.4); `gpuIds` is the LaunchRequest instance field.

```jsonc
// FitInput
{ "card": ModelCard | null,
  "legacy": { "paramsB": 27, "bytesPerParam": 1, "arch": { "layers": 64, "kvLayers": 16, "kvHeads": 4, "headDim": 256 } } | null,
  "engineId": "vllm", "runtimeId": "vllm@0.28.0", "gpuIds": ["0"],
  "values": { "contextLength": 262144, "concurrency": 1, "kvCacheDtype": "auto", "tensorParallel": 1, "pipelineParallel": 1,
              "vllm.gpuMemoryUtilization": 0.92, "vllm.maxNumBatchedTokens": 16384, "vllm.cpuOffloadGb": 0, "vllm.kvOffloadingSize": 0,
              "vllm.enforceEager": false, "vllm.languageModelOnly": false,
              "sglang.memFractionStatic": null, "sglang.maxTotalTokens": null, "sglang.chunkedPrefillSize": 8192,
              "sglang.pleOffloadEmbedding": false, "sglang.maxMambaCacheSize": null,
              "llamacpp.cacheTypeK": "f16", "llamacpp.cacheTypeV": "f16", "llamacpp.gpuLayers": "all", "llamacpp.nCpuMoe": 0,
              "llamacpp.overrideTensor": [], "llamacpp.tensorSplit": [], "llamacpp.swaFull": false, "llamacpp.kvUnified": false,
              "llamacpp.ubatchSize": 512, "llamacpp.batchSize": 2048, "llamacpp.mmproj": null, "llamacpp.textOnly": true,
              "speculative.method": "off", "speculative.numTokens": 3, "speculative.draftModel": null },
  "host": { "gpus": [ { "id": "0", "name": "…", "totalMb": 97887, "freeMb": 97000, "usedMb": 600, "computeCap": "12.0" } ],
            "ramBytes": 0, "ramFreeBytes": 0, "platform": "wsl" },
  "budgetBasis": "empty-gpu",      // "empty-gpu" (planning, remote cards; default) | "now" (current free memory), §10.5
  "instanceMode": "parallel" }     // passed to 01 as MemoryInputs.mode: replace | parallel | add
```
Absent ids take the catalog default (`platformDefault`, else `engineDefault`) from `GET /api/engines/:engineId/schema`; tests use a bundled catalog snapshot. Ids that do not apply to the engine are ignored with an `assumptions` entry.

```jsonc
// MemoryInputs.artifact: 01 §12 field names first (01 reads only these), then 02 additive fields
{ "weightsMb": 29437, "kvBytesPerToken": 65536, "kvBytesPerTokenHigh": 65536, "stateBytesPerSeq": 153944064,
  "draftMb": 0, "mmprojMb": 0, "hidden": 5120, "vocab": 248320,
  "confidence": "exact|config|heuristic",     // exact: tensor tables; config: config.json arithmetic; heuristic: legacy or name
  // 02 additive fields (schema "artifact-memory-inputs/v1")
  "schema": "artifact-memory-inputs/v1", "cardId": "mc_…", "contentDigest": "sha256:…", "layers": 64, "nativeContext": 262144,
  "weightsMbByGpu": { "0": 29437 }, "ramMb": { "weights": 0, "experts": 0, "kv": 0 },
  "byClassMb": { "dense": 0, "experts": 0, "embedding": 0, "lmHead": 0, "vision": 0, "audio": 0, "mtp": 0, "ple": 0, "other": 0 },
  "offload": { "expertLayersInRam": 0, "expertMbInRam": 0, "layersInRam": 0, "tensorsInRam": 0 },
  "kvMb": { "low": 16384, "high": 16384 },   // layout-adjusted KV for contextLength × concurrency (§10.3)
  "kvLayers": [ { "kind": "full", "count": 16, "bytesPerToken": 65536 },
                { "kind": "linear", "count": 48, "stateBytesPerSeq": 153944064 } ],
  "assumptions": [ { "zh": "…", "en": "…" } ] }
```

`estimateFit` builds the full 01 `MemoryInputs` `{values, artifact, gpus, mode, recipeMemory, calibration, legacy:null}` and calls `engines.memoryModels.estimate(engineId, inputs)`. `gpus` comes from `host.gpus` (`budgetBasis:"now"`) or from synthetic idle GPUs with `freeMb = totalMb − FIT_CONSTANTS.idleUsedMb` (`budgetBasis:"empty-gpu"`). `mode` is FitInput `instanceMode` (default `parallel`). `recipeMemory` is the matched recipe's `memory` block or `null`. `calibration` is `calibrationFor(card, engineId, runtimeId, engines.paramsKey(plan))` (§10.6). The result is 01's `MemoryEstimate` (00 §4.3 `memory` plus `{confidence, admissionRequest, notes[], warnings[]}`). llama.cpp's `gguf-estimate` should prefer `kvMb` and `weightsMbByGpu` when present, because SWA and unified-KV layouts make `kvBytesPerToken × tokens` wrong for it (request to 01, §23.2).

```jsonc
// FitResult = 00 §4.3 LaunchPlan.memory (as returned by memoryModels.estimate) + 02 grading fields
{ "policy": "device-fraction|free-fraction-after-weights|gguf-estimate|measured|server-reported|static-fraction-of-free|weights-plus-kv",  // 00 §4.3 enum as amended by 00 §9.1, passed through
  "perGpuMb": { "0": 90055 }, "admissionRequestMb": 90055, "kvPoolTokens": 899000, "maxFullLengthRequests": 3,
  "breakdown": { "weights": 29437, "kv": 16384, "activations": 2300, "draft": 0, "mmproj": 0, "overhead": 1024 },   // MiB on GPU
  "admissionRequest": { "requestedFraction": 0.92, "estimatePolicy": "vllm_gpu_memory_utilization" },              // 01/08 object, verbatim
  "ram": { "weights": 0, "experts": 0, "kv": 0 },                                                                    // MiB in host RAM
  "kv": { "bytesPerToken": 65536, "bytesPerTokenHigh": 65536, "stateBytesPerSeq": 153944064 },
  "layers": [ { "kind": "full", "count": 16, "bytesPerToken": 65536 }, { "kind": "linear", "count": 48, "stateBytesPerSeq": 153944064 } ],
  "range": { "lowMb": 90055, "highMb": 90055 }, "confidence": "exact|config|heuristic|measured",
  "status": "ok|warn|fail", "spill": false, "budgetMb": { "0": 94943 }, "headroomMb": 4888, "overflowMb": 0,
  "suggestions": [ { "code": "kv_fp8", "param": "kvCacheDtype", "to": "fp8", "deltaMb": -8192, "message": { "zh": "…", "en": "…" } } ],
  "calibration": { "applied": false, "samples": 0, "source": null, "driftRatio": null },
  "assumptions": [ { "zh": "…", "en": "…" } ] }
```
- `spill` is true iff any weight, expert or KV byte sits in host RAM (`ram.*` > 0): llama `llamacpp.nCpuMoe`, `llamacpp.gpuLayers`, `llamacpp.overrideTensor` to `CPU`; vLLM `vllm.cpuOffloadGb`, `vllm.kvOffloadingSize`; SGLang `sglang.pleOffloadEmbedding`. 03 derives its hub labels from `status` and `spill` (§3.2).
- The admission fields that 08 C1 makes must-keep (`requestedFractionOfFree`, `poolCappedTokens`, `minClampMb`, `clamped`, `verdict`) are never renamed or recomputed by 02. They appear only inside `admissionRequest` (or a plan's `admission`) exactly as 01 returns them.

### 10.3 KV bytes per attention kind (artifact side)

`Bk`, `Bv` = bytes per element of the chosen cache dtype (`f16`/`bf16` 2, `fp8*` 1, `q8_0` 34/32, `q5_1` 24/32, `q5_0` 22/32, `q4_1` 20/32, `q4_0`/`iq4_nl` 18/32, `nvfp4` 9/16; vLLM/SGLang `kvCacheDtype: auto` = model dtype unless `hf_quant_config.kv_cache_quant_algo` declares FP8; llama.cpp `llamacpp.cacheTypeK`/`llamacpp.cacheTypeV`). `C` = `contextLength`, `S` = `concurrency`.

| Kind | Per-layer bytes | Source fields |
|---|---|---|
| `full` | `C · Hkv · (Dk·Bk + Dv·Bv)` | `num_key_value_heads`, `head_dim` / GGUF `head_count_kv`, `key_length`, `value_length` |
| `swa(W)` | llama.cpp: `(min(C,W)·S + llamacpp.ubatchSize) · Hkv·(Dk·Bk+Dv·Bv)` total, or as `full` when `llamacpp.swaFull`; vLLM/SGLang: `min(C,W) · Hkv·(…)` per seq | `sliding_window`, `layer_types`/`sliding_window_pattern`/`max_window_layers` |
| `mla(r, dr)` | `C · (r + dr) · Bk` | `kv_lora_rank`, `qk_rope_head_dim` / GGUF `attention.kv_lora_rank`, `rope.dimension_count` |
| `linear` gated-deltanet | per seq, independent of C: conv `(2·Hk·Dk + Hv·Dv)·(K−1)·2` + ssm `Hv·Dk·Dv·Bssm` (`Bssm` 4 for float32) | `linear_*`, `linear_conv_kernel_dim`, `mamba_ssm_dtype` |
| `linear` mamba2 | per seq: conv `(dInner + 2·G·N)·(K−1)·2` + ssm `nHeads·headDim·N·4` | `ssm.*` / `mamba_*` |
| `compressed(r, W, L, idx)` | `(min(C,W) + ⌈C/r⌉)·L·Bk + ⌈C/r⌉·idx.kDim·2`; for `r = 0` low = `min(C,W)·L·Bk`, high = `C·L·Bk` | GGUF `attention.compress_ratios`, `sliding_window`, `key_length`, `indexer.key_length` |
| `indexer` on full layers | `+ ⌈C/ratio⌉ · kDim · kvHeads · 2` | `indexer_compress_ratio`, `indexer_head_dim`, `indexer_kv_heads` |
| `unknown` | as `full` with `Hkv = heads` for high, declared `Hkv` for low | — |

The layout rule per engine (llama.cpp's one pool of `C·S` cells plus ubatch for SWA, `llamacpp.kvUnified`; vLLM/SGLang per-sequence pages) is the only engine knowledge on the artifact side; it is a table keyed by engineId in `fit.js`, not a family branch. Expected values for golden tests: Qwen3.8-27B (16 full layers, Hkv 4, D 256, bf16) = 65,536 B/token and 153,944,064 B linear state per seq; DeepSeek-V4 GGUF at f16 and C = 1,048,576: low 6.76 GiB, high 8.76 GiB (43 blocks: 21 with ratio 4, 20 with ratio 128, 2 with ratio 0; the 44th `compress_ratios` entry belongs to the next-n/MTP layer and is counted only when MTP speculation is on).

### 10.4 Weights on GPU

`weights.byClass` (exact) minus offloads:
- llama.cpp: `token_embd` stays in host RAM; `llamacpp.nCpuMoe = N` moves `expertsByLayer[0..N-1]` to RAM; `llamacpp.gpuLayers < L` moves dense+expert bytes of layers `[0, L−gpuLayers)` to RAM; `llamacpp.overrideTensor` entries with buffer `CPU` move matching tensors; multi-GPU split by `llamacpp.tensorSplit` or free memory.
- vLLM/SGLang: minus `vllm.cpuOffloadGb` per GPU; minus `vision`/`audio` when `vllm.languageModelOnly`; minus `ple` when `sglang.pleOffloadEmbedding`; `mtp` counted only when `speculative.method` is `mtp`/`nextn`; divided by `tensorParallel` × `pipelineParallel`.
- Draft (`speculative.draftModel`): draft card weights + draft KV (`full` formula on the draft topology at `C`); mmproj: file bytes when `llamacpp.mmproj` is set and `llamacpp.textOnly` is false.

The engine formulas that consume these fields (vLLM KV pool, SGLang static fraction of free memory, llama.cpp compute buffers) moved to 01 §12 with `MEMORY_CONSTANTS`; 02 keeps none of them.

### 10.5 Grading

- `budgetMb` per GPU: `budgetBasis:"empty-gpu"` = `totalMb × maxUtil − reserveMb`; `budgetBasis:"now"` = `min(freeMb − reserveMb, totalMb × maxUtil − usedMb)`, the gpu-admission budget formula read without a lease. `maxUtil` and `reserveMb` default to the gpu-admission policy values, so a `now` grade matches admission when nothing else is pending.
- `status`: `fail` if any `perGpuMb > budgetMb`, if `maxFullLengthRequests === 0` when the memory model reports it (vLLM refuses to start), or if RAM use exceeds `ramFree − ramReserve`; `warn` if any GPU is above 90 % of its budget, `maxFullLengthRequests < concurrency`, `spill`, `confidence` is `heuristic`, or 01 returned `confidence:"fraction-only"`; otherwise `ok`. `range.highMb` grades whenever any input fact is below `declared` or any layer kind is `unknown`/`r=0` (today's `archUncertain`). When `artifact.kvMb.low ≠ artifact.kvMb.high` (or `kvBytesPerToken ≠ kvBytesPerTokenHigh`), `estimate` runs twice, once with the low and once with the high artifact values, giving `range`.
- Suggestions use catalog ids and are engine-correct. vLLM never advises lowering `vllm.gpuMemoryUtilization` to make a model fit (only for an admission conflict); otherwise it suggests `contextLength`, `kvCacheDtype` or offload. SGLang suggests `sglang.maxTotalTokens` before `sglang.memFractionStatic` (P0-RT-3 wording). llama.cpp suggests `llamacpp.nCpuMoe` before `llamacpp.gpuLayers` for MoE cards. Each `deltaMb` comes from re-running `estimate` with the changed value.
- `FIT_CONSTANTS` (artifact-side only: dtype byte table, ubatch padding, `idleUsedMb` 600, `ramReserveGb` 16; activation, graph and non-torch constants are 01 `MEMORY_CONSTANTS`) are named exports, overridable from `platform.json` `models.fitConstants` read through 06 OPS-3 `readSection("models")`. They are not family-specific (D5 holds).

### 10.6 Calibration (the only store; cross-check issue 10)

- Store: `<manager>/data/memory-calibration.json` (`schemaVersion 1`, ≤ 500 records, atomic tmp+rename), owned by `calibration.js` (00 §9.1). Key `(contentDigest, runtimeId, paramsKey)`. `paramsKey` is taken verbatim from 01 `engines.paramsKey(plan)` = `${contextLength}|${concurrency}|${kv}|${maxTotalTokens}`, where `kv` is `kvCacheDtype` (vllm, sglang) or `${llamacpp.cacheTypeK}/${llamacpp.cacheTypeV}`, and `maxTotalTokens` is `sglang.maxTotalTokens` or `-` (examples `262144|1|auto|262144`, `131072|1|f16/f16|-`). 02 never builds the key itself. 01's LaunchStore keeps no calibrations.
- Record: `{contentDigest, engineId, runtimeId, recipeId, paramsKey, launchId, estimated:{perGpuMb, breakdown, policy}, measured:{perGpuMb, gpuUsedDeltaMb, logFacts}, at}`. 02's `afterReady` hook (from `managerHooks`, wired on 01's supervisor) samples per-GPU used memory twice, 10 s apart, takes the larger value minus `gpuUsedBeforeMb`, builds the record with `observationFromFacts` from 01's `logFacts` (`weightsGiB`, `kvGiB`, `kvTokens`, `maxConcurrency`; llama.cpp `modelBufferMiB{dev}`, `kvBufferMiB{dev}`, `computeBufferMiB{dev}`; 01 §16.2), and appends it. Errors are logged once and never fail the job. 02 never parses logs. `job.meta.observed` stays raw evidence only and is never read for estimates.
- Lookup: `calibrationFor(card, engineId, runtimeId, paramsKey)` returns `{exact:true, measuredMb, samples}` for an exact key hit (median of the matching records' max per-GPU `measuredMb`) or `null`. 01 passes it as `MemoryInputs.calibration` and applies its `measured` policy with its own margins (01 §12: SGLang ×1.05 with `poolCappedTokens`, llama.cpp peak ×1.03). Non-exact records for `(contentDigest, engineId)` are never applied. When the median measured/estimated ratio of the last ≤ 5 lies outside [0.9, 1.15], FitResult gets `calibration.driftRatio` and the warning `estimate_drift`. Engine-reported weights differing by more than 5 % from `artifact.weightsMb` raise `weights_mismatch` (an inclusion assumption of §10.4 is wrong for this model).
- Recipe-measured reservations (Pennyroyal) reach 01 as `MemoryInputs.recipeMemory`; 02 writes no synthetic calibration records for them (a recipe matches a family, not a `contentDigest`).
- Corrupt file: renamed to `.corrupt-<ts>`, ignored, rewritten on the next record.

### 10.7 `/api/memory-estimate` (must-keep contract)

Body: every legacy field stays accepted (`paramsB, contextTokens|maxModelLen, bytesPerParam, kvBytes, arch|modelConfig|config, selectedGpus|gpus, gpuMemoryUtilization, cpuOffloadGb, kvOffloadGb|kvOffloadingSize, maxNumSeqs|parallelSlots, multiGpuMode, tensorParallelSize, pipelineParallelSize, speculativeMode, numSpeculativeTokens, gpuLayers, tensorSplitWeights, cacheTypeK/V, kvCacheDtype, textOnlyMode, mmproj, dflash|draft, variant, engine, runtimeImage`). New optional: `model` (local path or `owner/repo`), `cardId`, `engineId`, `runtimeId`, `gpuIds`, `values` (catalog ids; legacy fields are mapped through 01 `legacyBodyToRequest` when `values` is absent).
- No `model`/`cardId`/`variant` ⇒ `fit.legacyEstimate(body)`: the legacy path byte-for-byte as P0-RT-3 and ENG-12 leave it (golden test with the exact MCP body).
- With a card ⇒ `estimateFit`; the response still contains every legacy key: `plan.{weightsGb, kvGb, overheadPerGpuGb, perGpuGb, peakGpuGb, overflowPerGpuGb, recommendedCpuOffloadGb, recommendedKvOffloadGb, status, selectedGpus, memorySplitFactor}`, llama `plan.{totalWeightsGb, recommendedGpuLayers, totalLayers, allocations}`, `recommendations.{status, summary, suggestions, cpuOffloadGb, kvOffloadingSize, overflowPerGpuGb, recommendedGpuLayers}`, llama `metadata`, `recommendedConfig`, `components`; plus new `fit` (FitResult) and `card: {cardId, confidence}`.
- Fix: llama responses (both modes) now also set `plan.weightsGb` (= GPU-resident weights) so platform-mcp `weights_gb` is no longer `null`.

Consumers of the artifact inputs: both `/api/memory-estimate` wrappers (card mode), `gguf-variants.js fitFor`, download precheck R11, the planner, fit-grid, and, through `planFacts` and the 01 adapter's `estimateMemory`, `LaunchPlan.memory` and admission for every engine. The vLLM browser estimator (`app.js estimateMemoryUsage`) is deleted in MOD-19.

### 10.8 Fit grid (for 07's FitSolver; cross-check issue 26)

`fitGrid(FitInput, {kvDtypes, concurrency, contexts?})`, served as entry `POST /api/models/:id/fit-grid` (§17).
- For every `(kvDtype, concurrency)` cell, a binary search over the §11 context ladder (≤ native) finds the largest `contextLength` whose status is not `fail`. `limitedBy` is `native|vram|ram|engine` (`engine` = 01 returned a block, for example an SGLang fraction that cannot fit).
- With `contexts[]`, the response also carries `matrix[{contextLength, concurrency, kvDtype, status, spill, perGpuMb}]`.
- Bounds: ≤ 4 kv dtypes × ≤ 8 concurrency values, ≤ 12 evaluations per cell, 2 s budget (partial cells are marked `truncated:true`), side-effect free, memoized per `(cardId, engineId, runtimeId, paramsKey)`.

## 11. Launch planner (`planner.js`)

`planLaunches({card, host, goal, gpuSets, rows, catalogs, recipes, constraints})`
- `goal` ∈ `max-context | balanced | throughput | low-vram`. `gpuSets` default: each GPU alone, plus all GPUs when > 1. `constraints`: `{minContext, concurrency, allowCpuOffload (default true), ramReserveGb (default 16), includeUnverified (default false), engines[]}`.
- Candidates: rows with verdict `ok`/`warn` (plus `unknown` when `includeUnverified`, flagged `requiresProbe:true`). 01 recipes matching `(familyId, contentDigest, runtimeId, host)` (01 `recipes.matchRecipes`) are evaluated first and keep their locks.
- Search space per engine, using only parameter ids present in that engine's catalog (`GET /api/engines/:engineId/schema`); missing ids remove the strategy with a note:
  - `contextLength` ladder ∩ `≤ native`: native, 524288, 262144, 131072, 65536, 32768, 16384, 8192;
  - `concurrency` by goal: max-context 1; balanced 4; throughput 16/32; low-vram 1;
  - `kvCacheDtype` (llama.cpp `llamacpp.cacheTypeK`/`llamacpp.cacheTypeV`) by engine catalog choices, preferring higher precision (`auto/f16` > `fp8/q8_0` > `q4_0`);
  - offload: llama `llamacpp.nCpuMoe` 0..L (binary search for the minimum that fits), then `llamacpp.gpuLayers`; vLLM `vllm.cpuOffloadGb`; SGLang `sglang.pleOffloadEmbedding` when the card has PLE;
  - speculative: `speculative.method` from family `speculative.auto[engineId]` when not off for the quant.
- Feasibility: `estimateFit` (`budgetBasis:"empty-gpu"`) `status != "fail"`, headroom ≥ 5 % of the budget, RAM use ≤ `ramFree − ramReserve`.
- Score: max-context → context, then fewer offloaded bytes, then KV precision; balanced → context ≥ min(native, 65536) at 4 seqs, then less offload; throughput → `maxFullLengthRequests` at 32K, spec decoding bonus, no offload; low-vram → smallest `admissionRequestMb` with ctx ≥ 8192. Penalties: `warn` reasons, `unknown` support, name-heuristic facts.
- Output per GPU set: up to 3 plans, diversified (best per engine, then best alternative trade-off on the winning engine).

```jsonc
{ "planId": "pl_1", "rank": 1, "gpuIds": ["0"], "goal": "balanced", "engineId": "llamacpp", "runtimeId": "llamacpp@b10630", "recipeId": null,
  "title": { "zh": "llama.cpp · 128K 上下文 · 2 层专家放内存", "en": "llama.cpp · 128K context · experts of 2 layers in RAM" },
  "values": { "contextLength": { "value": 131072, "source": "planner", "reason": "…" }, "concurrency": { "value": 1, "source": "planner" },
              "llamacpp.cacheTypeK": { "value": "f16", "source": "planner" }, "llamacpp.cacheTypeV": { "value": "f16", "source": "planner" },
              "llamacpp.nCpuMoe": { "value": 2, "source": "planner", "reason": "moves 3.8 GiB of routed experts to RAM" },
              "llamacpp.gpuLayers": { "value": "all", "source": "planner" } },
  "fit": { /* FitResult summary */ }, "support": { "verdict": "unknown", "reasons": [ … ] }, "requiresProbe": true,
  "tradeoffs": [ { "zh": "…", "en": "…" } ], "validated": null }
```
Plan `values` use 01 catalog ids only, and `source:"planner"` is a 01 provenance value (01 adds it to its enum). Expected shape on fixtures (asserted with tolerances in tests): DeepSeek-V4 Q2_K on one 96 GB GPU, balanced → llama.cpp with `llamacpp.nCpuMoe` in [1, 6] and context ≥ 32768; Qwen3.8-27B FP8, max-context → vLLM 262144 × 1 seq fits without offload (KV pool ≥ 1 full-length request).

The entry's `POST /api/launch/recommend` then validates each plan through the hosting manager's side-effect-free `POST /api/m/:managerId/launch/plan` (00 §4.3) with `{engineId, runtimeId, recipeId, model:{ref}, instance:{gpuIds}, values}`; a card that is not on disk (remote, pre-download) is sent as `{prospective:true, model:{card}}` (01 §11, 00 §9.2). The plan attaches `validated: {ok, errors, warnings, admission, planHash, commandPreview}`; a manager timeout (5 s) or absence leaves `validated:null` with warning `plan_not_validated`.

## 12. Pre-launch dry probe (`probe.js`)

Runs in the manager hosting the engine as a job of type `model-probe` (jobs ledger; progress through the manager `jobs` events, which ENT-EV relays into the entry stream). It never touches GPUs, running containers, admission leases or the network, and it never pulls: a runtime image that is not present returns 409 `runtime_image_missing` with the action "Pull image / 拉取镜像", which calls 01's `POST /api/runtimes/:runtimeId/pull` (a `dl_` job, ENG-11) on explicit user action.

### 12.1 Container command (vLLM/SGLang/docker-template images with Python)

```
docker run --rm --name ai-probe-<8 base32> --pull never --network none --read-only
  --tmpfs /tmp:rw,size=256m --cap-drop ALL --security-opt no-new-privileges
  --memory 8g --pids-limit 256 --label ai.probe=model-inspector
  -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 -e PYTHONDONTWRITEBYTECODE=1
  -v <modelDir>:/probe/model:ro -v <manager-core>/model-inspector/probe-scripts:/probe/bin:ro
  --entrypoint python3 <image@digest> -I /probe/bin/hf_probe.py --model /probe/model --engine <engineId> [--trust-remote-code]
```
- No `--gpus`, no `ai.manager*` labels (instance discovery and stop-all never see it). Timeout 90 s, then `docker rm -f`. Paths go through `windowsPathToContainerPath`.
- `hf_probe.py` (stdlib + what the image already has) prints one line `@@PROBE@@ <json>`: `{engineVersion, transformersVersion, python, config:{ok, modelType, architectures, error}, archSupported, needsRemoteCode, registryArchitectures[], modelTypes[] (Transformers CONFIG_MAPPING keys), toolParsers[], reasoningParsers[], quantMethods[], kvCacheDtypes[], plugins:{gguf, bnb}, errors[]}`. Each registry lookup is wrapped in try/except so a moved internal module yields `null` (unknown), not a failure. vLLM: `vllm.model_executor.models.ModelRegistry.get_supported_archs()`, `ToolParserManager`, `ReasoningParserManager`, `QUANTIZATION_METHODS`; SGLang: its model registry and parser registries; `importlib.metadata` for plugin packages.
- `AutoConfig.from_pretrained(..., trust_remote_code=False)` first. Remote code runs only when the request has `allowRemoteCode:true` (admin, explicit confirmation listing the `auto_map` files) and still inside the sandbox above.

### 12.2 llama.cpp header load

```
docker run --rm --name ai-probe-… --pull never --network none --read-only --tmpfs /tmp:rw,size=64m
  --cap-drop ALL --security-opt no-new-privileges --memory 4g --label ai.probe=model-inspector
  -v <modelDir>:/probe/model:ro <llama image@digest>
  -m /probe/model/<file> --ctx-size 256 -ngl 0 --no-warmup --no-repack -t 2 --host 127.0.0.1 --port 18080
```
The manager streams logs and stops the container at the first terminal marker: success markers (`print_info: arch`, `load_tensors:`) ⇒ architecture and hyper-parameters accepted; failure signatures (`llama-unknown-arch`, `error loading model hyperparameters`) ⇒ failed. Timeout 30 s. The probe reads the header only; the weights are never loaded to a GPU.

### 12.3 Results and runtime facts

- Model probe result: `<AI_ROOT>/cache/model-probes/<contentDigest12>@<runtimeId>.json` `{ok, verdict:'supported|unsupported|needs-remote-code|inconclusive', facts, rootCause, at, durationMs}`; added to the card as `detected` evidence (`source.kind:"probe"`), never `verified-on-host`.
- Image facts (the registries above) are written with `engines.runtimeFacts.put(runtimeId, "registries", {capturedAt, engineVersion, transformersVersion, architectures, modelTypes, toolParsers, reasoningParsers, quantMethods, kvCacheDtypes, plugins})`. 01 stores them as the `registries` section of its runtime-facts file `<AI_ROOT>/.runtime/engine-flags/<engineId>/<imageId16>.json`, keyed by image id like the flag snapshot. That file is the only runtime-facts store; 02 reads it through `engines.runtimeFacts.get(runtimeId)` for §8.6 and §9 and writes no runtime-facts file of its own.
- Probe failures map through error signatures; `inconclusive` (timeout, Docker unavailable) is shown as such and never upgrades a verdict.

## 13. Qualification suite and host records

Manager `POST /api/qualify` runs job type `model-qualify` against one running instance, with the instance's own endpoint and runtime key (the manager already holds both). The entry orchestrates and stores results (`POST /api/models/:id/qualify`).

| Check id | Runs when | Request | Pass |
|---|---|---|---|
| `models` | always | `GET /v1/models` (+ llama `/props`) | served id present; reported context equals the launch value (warn if lower) |
| `chat` | always | "Reply with the single word: pong" (thinking off via the card's kwarg when known), `max_tokens 64` | non-empty content containing `pong` (case-insensitive) |
| `reasoning-split` | template `reasoningFormat != none` | thinking on, then off when a kwarg exists | `reasoning`/`reasoning_content` non-empty with thinking on; no `<think>` in `content`; empty reasoning with thinking off |
| `tool-call` | tool parser non-empty | `get_weather(city)` tool, `tool_choice:auto`, then the tool result | `finish_reason:"tool_calls"`, name matches, arguments parse as JSON with `city`; second turn returns text |
| `json-output` | always | `response_format:{type:"json_object"}` | `JSON.parse(content)` succeeds |
| `vision` | image modality and not `vllm.languageModelOnly`/`llamacpp.textOnly` | embedded 32×32 solid red PNG (base64 constant in `qualify.js`), "dominant colour, one word" | answer contains `red` |
| `needle` | opt-in only | passkey at 50 % and 90 % of `contextLength` | exact passkey; records TTFT |
| `speculative` | `speculative.method` not off | canonical `specDraftTokensTotal`/`specAcceptedTokensTotal` from 01 `engines/metrics.js` (the `metrics` part of `GET /api/instances/:id/metrics`) before/after `throughput` | acceptance = accepted/draft tokens recorded (no pass/fail threshold; warn if < 0.3) |
| `throughput` | always | `createBenchmarkRunner(...).runBenchmarkJob` with `{requests:3, concurrency:1, maxTokens:256, stream:true}` | ≥ 1 successful sample; records tok/s and TTFT |

Budget ≤ 120 s without `needle`. Requests use `temperature:0`, fixed prompts, no user data. Output previews are truncated to 240 chars and redacted with `manager-core/secret-redactor.js`.

Host record (`service-entry/data/model-host-records.json`, `schemaVersion 1`, atomic writes, ≤ 50 records per `contentDigest`):
```json
{ "id": "qr_…", "contentDigest": "sha256:…", "cardId": "mc_…", "engineId": "vllm", "runtimeId": "vllm@0.28.0",
  "recipeId": "qwen38-vllm-mtp3", "launchId": "lch_…", "fleetId": "vllm:primary",
  "host": { "gpu": "…", "computeCap": "12.0", "driver": "…" }, "at": "ISO", "durationMs": 61000,
  "results": [ { "check": "tool-call", "status": "pass|warn|fail|skip", "detail": { "zh": "…", "en": "…" }, "metrics": {} } ],
  "observed": { "peakMb": { "0": 0 }, "engineFacts": {} } }
```
Writes: the entry is the only writer. A qualification runs in the manager (it holds the instance endpoint and runtime key); at job end the manager sends the record with `POST /internal/models/host-records` (§17), signed by 05 `internal-auth.js` `createInternalClient({managerId})` on the `/internal/models/` prefix (loopback only, HMAC over method, path, managerId, timestamp and body hash). The entry validates the record against the job it started (`jobId`, `fleetId`, `contentDigest`), appends it, and publishes a `library` event `{kind:"qualification", cardId, contentDigest, recordId, summary}` through `events.publish`. If the push fails after 3 retries (1, 4, 16 s), the record stays in `job.result.hostRecord`, and `POST /api/models/:id/qualifications/import {managerId, jobId}` (admin) pulls it later.

Each `pass` adds `verified-on-host` evidence to the card for `(contentDigest, runtimeId)` (e.g. `/capabilities/tools`, `/template/reasoningFormat`, `/modalities/input`) and counts as `supportEvidence` in §9. `fail` results link the root cause / signature and do not remove declared facts.

Auto-qualify (cross-check issue 27): the entry decides, the manager runs, the manager reports. The entry watches the relayed `jobs` stream (ENT-EV) for a serve job reaching `ready`, reads the launch (`GET /api/m/:managerId/launches/:launchId`), resolves the card and `contentDigest` with `inspectLocal` (cached), and when no host record exists for `(contentDigest, runtimeId, recipeId|paramsKey)` it calls `POST /api/m/:managerId/qualify` with the light set (`models, chat, reasoning-split, tool-call, json-output, vision, throughput(1 request)`). `models.autoQualify` in `platform.json` (`"first-launch"` default, `"off"`, `"always"`; open decision O1; key registered in 06 OPS-3's schema) controls it. The manager refuses (409 `instance_busy`) while another qualification or benchmark job runs on the same instance, and the entry does not retry that launch.

## 14. Root-cause extraction (`root-cause.js`)

`classifyFailure(logText, {engineId, phase}) → JobError | null`, where `JobError` is the 00 §9.11 job error object plus additive fields:

```json
{ "code": "transformers_unknown_arch", "signatureId": "transformers-unknown-arch", "phase": "weights",
  "hint": { "zh": "运行预检探针，或换用更新的运行时镜像。", "en": "Run the dry probe, or use a newer runtime image." },
  "logExcerpt": "ValueError: The checkpoint you are trying to load has model type `qwen4_exp` but Transformers does not recognize this architecture.",
  "title": { "zh": "镜像中的 Transformers 不认识模型类型 qwen4_exp", "en": "Transformers in this image does not know model type qwen4_exp" },
  "explanation": { "zh": "…", "en": "…" }, "exceptionType": "ValueError",
  "suggestions": [ { "kind": "probe" }, { "kind": "param", "param": "trustRemoteCode", "to": true, "security": true } ] }
```
1. Normalise lines: strip ANSI, Docker timestamps, `(EngineCore_DP0 pid=N)`-style prefixes, `INFO/WARNING` level prefixes; keep the last 4000 lines.
2. Find the terminal marker (first of `Engine core initialization failed`, `exited with code`, `error loading model`, container exit) and search before it.
3. Signatures from `knowledge.errorSignatures(engineId)` (knowledge plus descriptor `errorSignatures[]`, §8.4), `rootCause:true` first; the last hit before the terminal marker wins; ties by signature order. `code`, `hint`, `title` and `phase` come from the signature (`phase` falls back to the caller's current lifecycle phase).
4. No signature: `code:"engine_start_failed"`, `signatureId:null`, the last Python traceback block and its final `^[\w.]+(?:Error|Exception|Interrupt)(?::\s.*)?$` line as `logExcerpt`; for llama.cpp the last line containing `error|failed` under `llama_model_load|load_tensors|ggml_backend|main:` prefixes.
5. Redact with `manager-core/secret-redactor.js` (marker `<redacted>`) and reduce host paths to basenames or container paths; `logExcerpt` stays within 01's bounds (≤ 40 lines, ≤ 4 KiB).

Integration: 01's supervisor calls `hooks.classifyFailure` on a stage failure (01 §14) and stores the object as the additive `job.failure`; `job.error` stays the legacy string with its prefix (`job-utils.js:158`), to which the supervisor appends ` — ${title.en}` when a signature matched. Before MOD-12 the hook returns `null` and 01 fills `code` with its stage code. `logExcerpt` respects 01's bounds (≤ 40 lines, ≤ 4 KiB): it is the matched line with up to 5 lines of context, not the raw tail. `manager-core/runtime-wait.js` fetches `--tail 2000` (instead of 260) on container exit for analysis only (the job log still receives the delta). Probe and qualification failures use the same function, so 07 renders one failure card.

## 15. Save working launch as recipe

Entry `POST /api/launches/:launchId/save-recipe`
- Reads the launch from the hosting manager's LaunchStore (`GET /api/m/:managerId/launches/:launchId`, 01 §21.1): effective values with provenance, runtime, recipe if any, argv (redacted).
- Builds a recipe in 01's schema (01 §10.1): `kind:"model"`, `status:"verified"`, `engineId`, `runtime:{ref}`; `match` = `{familyId, contentDigest (scope "this-model" only), runtimeId, quant:[…], minComputeCapability}` (01 match vocabulary; never `capabilityIds`); `values` = the launch values (catalog ids) whose source was `user|planner|model` (engine and platform defaults omitted); `locks` = the params the owner ticks; `evidence` = `{gpu, host, date, jobId, launchId, hostRecordId, measuredPeakMb}`. Saving requires a passing `chat` check (otherwise 409 `not_qualified` with hint "run qualification first").
- Validates with 01 `manager-core/engines/recipe-schema.js#validateRecipe` (never the descriptor validator), then writes `<AI_ROOT>/config/recipes/<recipeId>.json` (user layer from 00 §2) atomically; 409 `recipe_exists` unless `overwrite:true`. Secrets and absolute paths are never written (the model is referenced by `match`, not by path).
- Reload: the entry then calls `POST /api/m/:managerId/recipes/reload` (01) on both managers. A failed or timed-out reload (5 s) adds the warning `recipe_reload_failed`; 01's debounced `fs.watch` fallback picks the file up later.
- Response: `{ok, recipeId, path: "config/recipes/<id>.json", recipe, reloaded:{vllm:true, llama:true}, warnings:[]}`; the recipe appears in the planner and launch form as "validated on this host (date) / 本机已验证（日期）".

## 16. Published capabilities

`deriveCapabilities(card, launchValues, hostRecord)`:
- `text` for runnable `main` roles; `vision` iff image modality and not text-only (`vllm.languageModelOnly`, `llamacpp.textOnly`, or no `llamacpp.mmproj` loaded); `audio` likewise; `embedding`/`rerank` from role; `tools` iff resolved `toolCallParser` non-empty (llama: template tool format known or `auto`); `reasoning` iff reasoning format not `none`; `maxContext` = launch `contextLength`.
- Facts confirmed by a host record are marked verified; failed checks remove that capability from the published set (e.g. a failed `tool-call` unpublishes `tools`).
- Managers put the boolean object into Instance `capabilities` (00 §4.1) and `capabilityTokens()` (`text|vision|audio|embedding|rerank|tools`) into `/api/models` and fleet entries, so `model-fleet.js` routing uses them; its name regex stays only as the labelled last resort.

## 17. HTTP APIs

All entry endpoints: ADMIN listener 5176 only; error envelope 00 §4.2; JSON bodies ≤ 256 KiB; `x-request-id` propagated. Every non-GET needs an owner session plus CSRF or a tool token (05 PUB-5). GET routes are readable by viewers only when registered in the 05 viewer-allowlist registry (table below); all other GETs are owner-only.

| Method + path | Request | Response | Errors |
|---|---|---|---|
| `POST /api/models/inspect` | `{path}` or `{source:"huggingface"\|"modelscope", repo, revision?="main", files?}`; `{refresh?:false, depth?:"full"}` | `{ok, card, cached, durationMs}` | 400 `path_outside_storage`, 400 `invalid_repo`, 404 `not_found`, 403 `gated`, 422 `not_a_model`, 504 `inspect_timeout` |
| `GET /api/models/:id/card` | `?view=summary\|full&include=template` | `{ok, card}` | 404 `card_not_found` (hint: call inspect) |
| `GET /api/models/:id/compatibility` | `?gpus=0,1&engines=vllm,sglang,llamacpp` | `{ok, cardId, host:{gpus, ramBytes, platform}, rows:[Row]}` | 404 |
| `POST /api/models/:id/probe` | `{engineId, runtimeId, allowRemoteCode?:false}` | 202 `{ok, jobId, managerId}` | 400 `unknown_engine`, 409 `probe_running`, 409 `runtime_image_missing` (with the Pull action), 503 `docker_unavailable` |
| `POST /api/launch/recommend` | `{cardId \| path \| repo, goal, gpuSets?:[["0"]], constraints?}` | `{ok, cardId, goal, gpuSets:[{gpuIds, plans:[Plan]}], notes:[]}` | 400 `invalid_goal`, 404 |
| `POST /api/models/:id/fit-grid` | `{engineId, runtimeId?, recipeId?, gpuIds, kvDtypes?:["auto","fp8"], concurrency:[1,2,4,8], contexts?:[…], values?:{}}` | `{ok, cardId, engineId, runtimeId, native, cells:[{kvDtype, concurrency, maxContext, limitedBy, status, spill, truncated?}], matrix?:[…], durationMs}` (§10.8; side-effect free) | 400 `grid_too_large`, 400 `unknown_engine`, 404 |
| `POST /api/models/:id/qualify` | `{fleetId, checks?:[…], needle?:false}` | 202 `{ok, jobId, managerId}`; on completion the entry stores the host record | 404 `instance_not_found`, 409 `instance_busy` |
| `GET /api/models/:id/qualifications` | — | `{ok, records:[HostRecord]}` | — |
| `POST /api/models/:id/qualifications/import` | `{managerId, jobId}` | `{ok, record}` (pulls `job.result.hostRecord` when the push failed) | 404 `job_not_found`, 409 `already_recorded` |
| `POST /internal/models/host-records` | HostRecord + `{jobId}`; loopback socket and 05 internal HMAC (prefix `/internal/models/`, `allowedManagers:["vllm","llama"]`) | `{ok, id}` | 401 `internal_auth_failed`, 409 `job_mismatch`, 422 field errors |
| `POST /api/launches/:launchId/save-recipe` | `{recipeId, title:{zh,en}, scope:"family"\|"this-model", locks?:[], notes?, overwrite?:false}` | `{ok, recipeId, path, recipe, reloaded, warnings}` (§15) | 404, 409 `recipe_exists`/`not_qualified`, 422 `recipe_invalid` (field errors) |
| `GET /api/knowledge` | `?kind=families\|template-signatures\|error-signatures&q=&withMatches=1` | `{ok, kind, entries:[{…, layer, file, matches:[cardId], heuristicHits}]}` | 400 `unknown_kind` |
| `GET /api/knowledge/status` | — | `{ok:true, domains:[{domain:"models"\|"engines"\|"recipes"\|"launch-params"\|"platform", layers:[…], errors:[{file, entryId, code, message}]}], digest}` — always 200; manager domains fetched through the proxy with 2 s timeout, failures listed as `{domain, unavailable:true}` | — |
| `POST /api/knowledge/import` | `{url}` (https) or `{content}`; `{confirm:false}` | preview `{ok, packId, sha256, diff:{added, replaced, invalidEntries}}`; with `{confirm:true, sha256}` writes the pack | 400 `pack_invalid`, 413 `pack_too_large` (1 MiB), 409 `sha_mismatch` |
| `DELETE /api/knowledge/packs/:packId` | confirmation header `x-confirm: delete` | `{ok}` | 404 |
| `PUT /api/knowledge/overrides/models/:cardId` | override entry (match is set from the card's `contentDigest`) | `{ok, file}` | 422 field errors |
| `POST /api/knowledge/reload` | — | `{ok, digest}` | — |

Manager endpoints (local-only gate unchanged; reached by the entry via `/api/m/:managerId/*`; the new ones live in `manager-core/model-inspector-routes.js`, the changed ones stay in `model-routes.js`):

| Method + path | Notes |
|---|---|
| `GET /api/model/config?model=` | unchanged shape (`normalizeModelConfig` fields, `speculative`, `capabilityEntry`, `recommendedReasoningParser`, `recommendedToolCallParser`) computed from the card; adds `card` (summary) and `parsers` (§8.6 with sources) |
| `GET /api/download/precheck` | unchanged shape (`ok, level, engine, model, quantMethod, format, capability, findings`); adds `cardId`, `rows` |
| `POST /api/memory-estimate` | §10.7 |
| `GET /api/models/card?model=` | read-only card summary for legacy UIs |
| `POST /api/models/probe` | `{model, engineId, runtimeId, allowRemoteCode}` → 202 job |
| `POST /api/qualify` | `{instanceId, cardId, checks, needle}` → 202 job |
| `GET /api/knowledge/status` | this manager's loader domains (engines, recipes, launch-params, models) |

Viewer-allowlist registrations (05 `service-entry/lib/viewer-allowlist.js`; each route file registers its GETs next to the handler, and the 05 test fails on any entry GET that is neither registered nor owner-only):

| GET route | Redaction function (in `model-card-routes.js` / `knowledge-routes.js`) |
|---|---|
| `/api/models/:id/card` | `projectCard(card, {view:"summary", redactPaths:true})`; `include=template` and `view=full` are owner-only |
| `/api/models/:id/compatibility` | rows unchanged except `supportEvidence[].ref` and reason `evidence` values that contain paths, which are dropped |
| `/api/models/:id/qualifications` | records without `host.driver`, `launchId`, `detail` previews and `observed.engineFacts` |
| `/api/knowledge` | entries without `file` and `sources`; layer names only |
| `/api/knowledge/status` | `path` → layer name; error `message` kept, file names reduced to basenames |
| `/api/m/:managerId/models/card` | same as `/api/models/:id/card` |

Not registered (owner-only): `/api/m/:managerId/model/config` (it can include paths and templates), `/api/m/:managerId/download/precheck` (it fetches remote metadata), `/api/m/:managerId/knowledge/status` (the entry aggregate is the viewer path).

Example `POST /api/models/inspect` response (summary of the DSpark draft fixture):
```json
{ "ok": true, "cached": false, "durationMs": 140,
  "card": { "cardId": "mc_…", "role": { "value": "draft", "runnable": false },
    "identity": { "modelType": "qwen3", "architectures": ["DSparkDraftModel"], "familyId": null, "matchedBy": "" },
    "compatibleWith": { "hiddenSize": 5120, "vocabSize": 248320, "targetLayers": 64 },
    "customCode": { "autoMap": { "AutoModel": "dspark.DSparkDraftModel" }, "files": ["dspark.py", "dflash.py"], "trustRemoteCodeRequired": true },
    "support": "unknown" } }
```

## 18. Console requirements and copy (built by 07; zh/en)

07 owns every path under `service-entry/console/` (cross-check issue 14). 02 specifies no console files: the model pages live in 07's layout (`console/routes/models/*`, `console/routes/deploy-wizard/*`, `console/components/{model-card,compat-matrix,fit-solver}.js`) and are built inside 07 packages CON-11 (wizard steps 1-3), CON-14 (library, model detail, knowledge) and CON-15 (discover, plan sheet). If a 02 engineer builds them, it happens inside those packages. The requirements below are acceptance criteria for those packages. The strings live in the per-area i18n files `service-entry/console/i18n/models/{zh-CN,en-US}.json` (07 CON-2 loader, cross-check issue 15); every key starts with `models.`, so the cross-area duplicate check cannot collide.

Requirements handed to 07 (each one a test in 07's models or wizard Playwright spec):
- R-UI-1 Every card fact renders with an evidence chip showing one of the four confidences or "unknown"; `name-heuristic` facts are labelled "按名称推测 / Guessed from the name".
- R-UI-2 A compatibility row with verdict `unknown` is grey, never green, and offers "Run dry probe" (`POST /api/models/:id/probe`) and "Override"; `ok` is shown only when `supportEvidence` is non-empty.
- R-UI-3 The fit bar stacks weights, KV, activations, draft, projector and headroom from `FitResult.breakdown`, adds a RAM bar when `spill`, and the FitSolver reads `POST /api/models/:id/fit-grid`.
- R-UI-4 Plan cards come from `POST /api/launch/recommend`, show `validated` status and trade-offs, and hand `values` (catalog ids) to the wizard without renaming.
- R-UI-5 The qualification checklist follows the relayed `jobs` events of kind `model-qualify` and shows each check's status and detail.
- R-UI-6 A failed launch, probe or qualification shows one failure card from the 00 job error object (`title`, `hint`, `logExcerpt`, `suggestions`); applying a suggestion returns to Review and never relaunches.
- R-UI-7 "Save as recipe" is disabled until a passing `chat` check exists and shows `recipe_reload_failed` as a warning.
- R-UI-8 The knowledge page lists layers, files, invalid entries and stale files from `/api/knowledge/status`; import shows the diff and needs a second confirmation.
- R-UI-9 Remote code consent shows the `auto_map` files with the `models.remoteCode.confirm` text before a probe with `allowRemoteCode:true`.

Wizard order: ① Source (paste link / pick folder) → ② Card (identity, topology, modalities, template formats; each value with an evidence chip) → ③ Engines (matrix rows; grey `unknown` with "Run dry probe") → ④ Plans (per GPU set; fit bar and context slider bound to `fit`) → ⑤ Probe → ⑥ Launch (hands values to the 01 launch flow) → ⑦ Qualify (live checklist) → ⑧ Save as recipe.

| Key | zh-CN | en-US |
|---|---|---|
| `models.confidence.declared` | 模型声明 | Declared by the model |
| `models.confidence.detected` | 规则检测 | Detected |
| `models.confidence.name-heuristic` | 按名称推测 | Guessed from the name |
| `models.confidence.verified-on-host` | 本机已验证 | Verified on this host |
| `models.confidence.unknown` | 未知 | Unknown |
| `models.role.main` / `draft` / `mtp-head` / `mmproj` / `adapter` / `embedding` / `reranker` / `tooling-only` | 主模型 / 推测解码草稿 / MTP 头 / 多模态投影 / 适配器 (LoRA) / 向量模型 / 重排模型 / 工具文件（不可启动） | Main model / Speculative draft / MTP head / Vision projector / Adapter (LoRA) / Embedding model / Reranker / Tooling files (not runnable) |
| `models.verdict.ok` | 可运行 | Runs |
| `models.verdict.warn` | 可运行，需留意 | Runs with caveats |
| `models.verdict.block` | 无法运行 | Cannot run |
| `models.verdict.unknown` | 未验证 | Unverified |
| `models.verdict.unknownHint` | 没有证据表明此引擎支持该架构。运行预检探针（约 1 分钟，不占用显卡）即可确认。 | Nothing shows that this engine supports the architecture. Run the dry probe (about a minute, no GPU used) to find out. |
| `models.goal.max-context` / `balanced` / `throughput` / `low-vram` | 最长上下文 / 均衡 / 高吞吐 / 省显存 | Longest context / Balanced / High throughput / Low VRAM |
| `models.fit.weights` / `kv` / `activations` / `draft` / `mmproj` / `headroom` / `ram` | 权重 / KV 缓存 / 激活与图 / 草稿模型 / 视觉投影 / 余量 / 内存（CPU） | Weights / KV cache / Activations & graphs / Draft model / Vision projector / Headroom / System RAM |
| `models.fit.kvPool` | 预留 {reserve} GiB → KV 池约 {pool} GiB ≈ {tokens} tokens ≈ {n} 个满长请求 | Reserves {reserve} GiB → KV pool ≈ {pool} GiB ≈ {tokens} tokens ≈ {n} full-length requests |
| `models.fit.expertOffload` | 把前 {n} 层的专家权重放到内存，节省 {gib} GiB 显存 | Keep the experts of the first {n} layers in RAM to free {gib} GiB of VRAM |
| `models.parser.engineAuto` | 自动（由引擎按聊天模板识别） | Auto (the engine reads the chat template) |
| `models.parser.notInImage` | 当前镜像没有 {parser} 解析器 | This image has no {parser} parser |
| `models.qualify.check.tool-call` | 工具调用往返 | Tool-call round trip |
| `models.qualify.check.reasoning-split` | 思考内容分离 | Reasoning kept out of the answer |
| `models.qualify.check.vision` | 图片理解 | Image input |
| `models.qualify.check.throughput` | 速度测试 | Speed test |
| `models.rootCause.title` | 启动失败的根本原因 | Why the launch failed |
| `models.recipe.save` | 保存为配方（本机已验证） | Save as recipe (verified on this host) |
| `models.remoteCode.confirm` | 该模型需要运行自带的 Python 代码：{files}。只在你信任发布者时继续。 | This model runs its own Python code: {files}. Continue only if you trust the publisher. |
| `models.knowledge.layer.bundled` / `pack` / `user` / `model` | 内置 / 导入包 / 我的覆盖 / 单模型覆盖 | Built-in / Imported pack / My overrides / Per-model override |
| `models.knowledge.status.invalid` | {file} 中有 {n} 条无效条目，已跳过 | {n} invalid entries in {file} were skipped |
| `models.fit.spill` | 部分权重或 KV 放在内存，速度会下降 | Some weights or KV sit in system RAM; expect lower speed |
| `models.compat.unknownArch` | 未知（未验证） | Unknown (unverified) |

Raw flag names appear only as secondary monospace text (rule §7.6).

## 19. Security and privacy

- Path inputs: realpath must lie under a `<LIBRARY_ROOT>` (or alias) from `model-storage.json`; UNC paths, device paths and symlink/junction escapes are rejected; `readdir` capped at 20,000 entries.
- Remote fetches go only to the HF endpoint, configured HF mirrors and ModelScope (no arbitrary URL → no SSRF). Knowledge pack URLs: https only, admin only, DNS-resolved address must not be loopback/private/link-local, no redirects off-host, ≤ 1 MiB, JSON content type, pinned by sha256, never auto-applied.
- Templates and READMEs are untrusted text: never executed or rendered as HTML in Node or the console; only hashed and scanned for literal features. Pack regexes go through the safety check of §8.1.
- Probe sandbox per §12 (no network, read-only mounts, no GPU, dropped capabilities, memory/pid caps, timeout, `ai.probe` label only). Remote code needs explicit admin consent per request.
- Qualification uses fixed prompts; stored previews are truncated and redacted. No API keys or tokens appear in argv, logs, cards, probe results, host records, calibration records or recipes (D10). The only redactor is P0-OBS `manager-core/secret-redactor.js` (marker `<redacted>`); 02 adds no redact helper of its own and runs it on every probe/qualify log line and every `logExcerpt`.
- The HF token used by `inspectRemote` comes from the hub's token provider: memory-only by default (08), or the single secret store namespace `hf` when the owner ticked "remember" (cross-check issue 9). 02 never persists a token, never puts it in a card, cache file or error, and sends it only to the official HF endpoint or an owner-configured mirror.
- Viewers (LAN or loopback without a session) reach only the GET routes registered in the viewer-allowlist registry (§17), with the listed redaction; `include=template`, `view=full` and every POST are owner-only (session plus CSRF, or tool token; 05 PUB-5).
- `POST /internal/models/host-records` accepts only a loopback socket with a valid 05 internal HMAC on the `/internal/models/` prefix; the record must match a qualification job the entry started (`jobId`, `fleetId`, `contentDigest`), so a local process cannot inject `verified-on-host` evidence.
- Recipe drafts carry only catalog `values` and `locks`; a launch's `extraArgs`/`extraEnv` are never copied into `fixedArgs`/`env` (the draft lists them as a note for the owner). Recipes are validated with 01 `recipe-schema.js` and written by the entry only.
- Fixtures and docs contain no absolute paths, usernames or machine names; a fixture privacy test scans `manager-core/test/fixtures/{model-cards,root-cause-samples}/**` for drive-letter paths, `\\Users\\`, `/home/`, and the credential patterns used by the release scan.

## 20. Failure modes

| Failure | Behaviour |
|---|---|
| Corrupt/partial download (missing shard, `.complete.json` missing) | card `format.complete:false`, `missing[]`; verdict `block` with "re-download / 重新下载"; fit uses present bytes, marked inexact |
| Unreadable JSON / header | `errors[]` entry, fact unknown; inspection continues |
| Unknown ggml type id | `weights.exact:false`, warning; fit grades on the upper bound |
| HF API 401/403 | `ref.gated:true`, card from public files only; hint to log in |
| Range ignored by server | read stops at `maxBytes`; header facts unknown if incomplete |
| Knowledge file invalid | skipped, reported in `/api/knowledge/status`, last good digest kept |
| Runtime facts missing (never probed) | rules R5/R9/R13 yield `unknown`, never `ok` |
| Docker unavailable during probe | probe `inconclusive`, 503 `docker_unavailable` |
| Probe timeout | container force-removed, `inconclusive` |
| Qualification instance stops mid-run | remaining checks `skip`, record kept with `status:"partial"` |
| Calibration file corrupt | renamed to `.corrupt-<ts>`, ignored, rewritten on the next record |
| `engines.memoryModels` unavailable (01 not landed or threw) | `estimateFit` returns `status:"warn"`, `policy` absent, breakdown from artifact inputs only, warning `engine_model_unavailable`; card-mode `/api/memory-estimate` falls back to `legacyEstimate` |
| Runtime image missing for a probe | 409 `runtime_image_missing` with the Pull action (01 `POST /api/runtimes/:runtimeId/pull`); nothing is pulled implicitly |
| Host-record push fails (entry down) | 3 retries; record kept in `job.result.hostRecord`; console shows "not recorded" with an import action |
| Recipe reload fails after save | file written, warning `recipe_reload_failed`, 01 `fs.watch` fallback |
| Descriptor `errorSignatures[]` addition duplicates a knowledge `code` | descriptor entry dropped, `duplicate_code` in `/api/knowledge/status` |
| Card cache disk full | inspection result returned, cache write error logged once |
| Model moved/renamed | new `cardId`, same `contentDigest` → host records, calibration and per-model overrides keyed by digest still apply |

## 21. Tests

### 21.1 Fixtures (`manager-core/test/fixtures/model-cards/<id>/`)

Captured by `scripts/capture-model-fixture.js --from <dir> --id <id> [--gguf <file>]` (read-only on the source). Captures only: `config.json`, `generation_config.json`, `tokenizer_config.json` (with `chat_template`), `chat_template.jinja`, `hf_quant_config.json`, `preprocessor_config.json`, `adapter_config.json`, `modules.json`; a pattern-compressed `tensor-table.json` (`{format, files:[{name, bytes}], groups:[{pattern:"model.language_model.layers.{L}.mlp.experts.{E}.down_proj.weight", ranges:{L:[0,47],E:[0,511]}, dtype, shape, bytesEach}]}`) built from headers/index; `gguf-header.json` (KV with large arrays as `{"$array", "count", "head"}`, template text, tensor groups); a `manifest.json` `{id, license, synthetic:false, layout, capturedWith, notes}` and `expected-card.json` (stable projection: no `inspectedAt`, `ref`, `cardId`). The script refuses non-permissive licenses unless `--allow-license`, strips absolute paths, and never copies weights, tokenizer vocabularies or READMEs. Directory name `model-cards` (not `models`, which is gitignored and release-excluded). Log snippets for root-cause tests live in `manager-core/test/fixtures/root-cause-samples/<id>.log.fixture` (never `*.log`, never a `logs/` directory); recorded `/metrics` text for the `speculative` check reuses 01's metrics fixtures. OPS-2's tracked-fixture check covers both directories.

Real fixtures from the owner's library: `qwen38-27b-fp8` (hybrid linear/full, vision, MTP, FP8, `layers-N` + index), `qwen38-27b-fp8-indexed` (fine-tune, same template hash; rename-invariance), `qwen36-35b-a3b-fp8` (MoE hybrid, different template), `qwen38-flashnext-nvfp4` (`qwen4_exp`, ModelOpt NVFP4, PLE, indexer, 512 experts, MTP, per-expert-range shards), `qwen38-27b-dspark-draft` (draft, `auto_map`), `ple-quant-tooling` (tooling-only), `deepseek-v4-flash-q2k-gguf` (deepseek4, compressed attention, MoE, DSML template). Synthetic fixtures (`synthetic:true`) for families without a real checkpoint: gpt-oss (harmony), glm4.5, mistral, gemma4, llama3, kimi-k2, nemotron-3-nano, muse-glimmer (blocked), a mmproj GGUF, a LoRA adapter, a sentence-transformers embedding model, a sequence-classification reranker, a Mamba2 GGUF, an MLA config. Rule: every family entry lists ≥ 1 fixture; synthetic-only families cannot carry `confidence:"verified"` (schema check).

Test helpers (not test files): `manager-core/test/helpers/gguf-writer.js` (moved from `gguf-metadata.test.js`, extended for typed tensors and string arrays), `safetensors-writer.js`, `fixture-materialize.js` (expands a fixture into a temp directory with real tiny headers so the IO paths run; tensor payloads are zero-length sparse files sized by `truncate`).

### 21.2 Unit and golden (`manager-core/test/`, run by `node --test test/*.test.js`)

| File | Asserts |
|---|---|
| `model-inspector-cards.test.js` | each real fixture → `expected-card.json` (golden); `validateCard` ok; every non-null fact has evidence; Qwen3.8 fixtures → family `qwen3.8`, Qwen3.6 → `qwen3.5-3.6`; rename invariance (same derived card for two folder names); cache hit on second inspect, miss after a file mtime change |
| `model-inspector-gguf.test.js` | widened capture (chat template, compress ratios, indexer, sampling); exact bytes DeepSeek-V4 90.89 GiB / experts 82.69 GiB; unknown type id ⇒ `exact:false`; `parseGgufHeaderBuffer` partial throws `GgufNeedMoreBytes` |
| `model-inspector-roles.test.js` | role table §7 for all fixtures; DSpark pairs with Qwen3.8-27B; tooling-only not runnable |
| `model-inspector-remote.test.js` | mocked HF model-info + resolve + Range (206) responses → same derived card as local fixture; 200-ignoring-Range stops at cap (body never read past `maxBytes`); ModelScope without Range → header facts unknown; gated 403 |
| `knowledge-layers.test.js` | precedence bundled < v1-user < packs < user < per-model; `$merge`/`$delete`; invalid file reported, others loaded; unsafe regex rejected; status never throws; descriptor additions from a stub `registry.errorSignatureAdditions()` merged into the bundled layer with `engines` defaulted and overridable by id; `stage` accepted as an alias of `phase`; duplicate `code` dropped and reported; error-signature `param` ids exist in the bundled 01 catalogs |
| `knowledge-migration.test.js` | `convertCapabilitiesV1` round trip; shim equivalence for every v1 entry × engine (except documented Qwen3.8 rekey); `capabilityIdAliases` covers every v1 id and every `capabilityIds` value in bundled 01 recipes; every `logIssueHint` branch string matched by some error signature |
| `template-signatures.test.js` | fixture templates → signature ids (Qwen3.8 exact sha, Qwen3.6 features, DSML); `resolveParsers` precedence; `parsersByQuant` ModelOpt → `qwen3_xml`; parser absent from the runtime's lists (stub `engines.runtimeFacts.get`) → the descriptor `capabilities.autoParsers` value where set, `""`+warning otherwise; output keys are catalog ids `toolCallParser`/`reasoningParser`/`autoToolChoice` |
| `compatibility.test.js` | unknown arch → `unknown` (never `ok`); property test over all fixtures × synthetic runtimes: `ok ⇒ supportEvidence.length > 0` and no name-heuristic support; Muse blocked even with `VLLM_ALLOW_MUSE_GLIMMER=1`; BNB blocked when `registries.plugins.bnb=false`; DiffusionGemma WSL block and env bypass; safetensors on llama.cpp block (descriptor `artifactFormats`); embedding card on an engine whose `capabilities.roles` lacks `embedding` blocks; NVFP4 on SM 8.9 warn |
| `fit.test.js` | `artifactMemoryInputs`: per-kind KV formulas with hand-computed numbers (§10.3 golden values); DeepSeek-V4 1M-token KV low/high range; `llamacpp.nCpuMoe` reduces GPU weights by `Σ expertsByLayer`; FitInput accepts only catalog ids (an unknown id becomes an assumption). `estimateFit` against a recording stub of `engines.memoryModels.estimate`: inputs passed verbatim, `policy`/`perGpuMb`/`admissionRequest` passed through unchanged, range calls estimate twice only when low ≠ high, `spill` and `status` grading table, `estimate_drift` and `weights_mismatch` warnings, `engine_model_unavailable` fallback. Integration with the real 01 `memory-models.js` (after ENG-12): Qwen3.8-27B vLLM 262144 × 1 → `maxFullLengthRequests ≥ 1`; Flash-Next SGLang reports `policy:"static-fraction-of-free"` and P0-RT-3's admission fields unchanged. Legacy mode equals the post-ENG-12 legacy output for 20 recorded bodies |
| `memory-estimate-contract.test.js` | the platform-mcp body → every key read by `platform-client.ts:1651-1681` present for both managers (llama `plan.weightsGb` now set); legacy numbers unchanged |
| `plan-fit-equality.test.js` | for 3 fixtures × 3 engines, `estimateFit` and a 01 `POST /api/launch/plan` with the same card and values (fake host) report identical `perGpuMb`, `policy` and `admissionRequestMb` |
| `fit-grid.test.js` | cell search returns the largest passing ladder context; `limitedBy` cases (native, vram, ram, engine); bounds and `truncated`; memoization |
| `calibration.test.js` | store cap 500 and atomic write; key uses `engines.paramsKey` output verbatim; exact hit returned by `lookup`; non-exact records never returned as exact; corrupt file renamed; `observationFromFacts` maps 01 `logFacts` (vLLM, SGLang, llama per-device buffers) without reading logs |
| `planner.test.js` | DeepSeek-V4 balanced → llamacpp, `llamacpp.nCpuMoe ∈ [1,6]`, `contextLength` ≥ 32768; Qwen3.8-27B max-context → vLLM 262144; every `values` key exists in the engine's catalog snapshot and carries `source:"planner"`; ≤ 3 plans per GPU set |
| `root-cause.test.js` | ledger-derived log snippets (scrubbed, `*.log.fixture`): `exceeds dimension size`, `Unknown SF transformation`, `does not recognize this architecture`, `unknown model architecture: 'deepseek4'`, `failed to allocate CUDA0 buffer of size 88062733312`, `Multimodal mode requires an mmproj` (from a stubbed llama.cpp descriptor addition) → `{code, signatureId, phase, hint, logExcerpt}` (00 job error object); traceback fallback `engine_start_failed`; secrets redacted to `<redacted>` by `secret-redactor.js`; paths reduced |
| `probe.test.js` | argv builder: `--network none`, `:ro`, no `--gpus`, no `ai.manager` label, `--pull never`; remote-code flag only with consent; fake docker runner parses `@@PROBE@@` and calls a stub `engines.runtimeFacts.put(runtimeId, "registries", …)` once; missing image → 409 `runtime_image_missing` without a pull; timeout ⇒ `inconclusive` |
| `qualify.test.js` | mock OpenAI server (`node:http`) covering pass/fail for each check incl. `<think>` leakage, invalid tool JSON, vision answer; partial run when server dies; the host-record push is signed (stub internal client) and retried 3 times, then kept in `job.result.hostRecord` |
| `service-entry/test/model-card-routes.test.js` | §17 entry endpoints with the error envelope; every GET route is registered in the viewer allowlist with its redaction (or owner-only); `/internal/models/host-records` rejects a bad HMAC, a non-loopback socket and a record for an unknown job; save-recipe validates with 01 `recipe-schema.js` and calls the reload endpoint on both managers (fake proxy) |
| `capabilities.test.js` | vision only when not text-only; failed tool check unpublishes `tools`; tokens are the model-fleet vocabulary |
| `fixture-privacy.test.js` | §19 scan of fixtures |
| `manager-core/test/no-family-branches.test.js` (owned by 01 ENG-23; MOD-21 adds patterns only) | MOD-21 appends the model-family tokens (`qwen\d`, `deepseek`, `gemma`, `glm`, `kimi`, `mistral`, `llama3`, `gpt-oss`, `nemotron`, `muse`, `flash.?next`, `dspark`, `pennyroyal`, inside regex literals or string comparisons) and the scopes `service-entry/lib`, `shared-public/js` to ENG-23's pattern list. The one allowlist is `manager-core/test/fixtures/family-branch-allowlist.json` (ENG-23); 02 adds entries only with a reason and an expiry and must leave zero code entries |

Manager tests: `vllm-manager/test/model-capabilities.test.js` keeps its assertions through the shim until MOD-21, then moves to `compatibility.test.js`/`template-signatures.test.js` with the same expectations (auto MTP off for ModelOpt, packaged-tensor requirement, Muse not bypassable, BNB block). `manager-core/test/model-capability-matrix.test.js` replaces the fictional `qwen3_8` fixture with the real `qwen38-27b-fp8` config (expectation: family `qwen3.8`, `matchedBy` includes `templateSignature`). `download-precheck.test.js` keeps every assertion; new cases cover multi-engine rows and remote GGUF architecture. `gguf-metadata.test.js` unchanged except the helper import. `llama-manager/test/gguf-model-ui.test.js` keeps P0-15's case (`supported:null` → "未知（未验证）/ Unknown (unverified)"); 02 adds no UI case. Golden argv tests owned by 01 are untouched; 02 creates no goldens.

### 21.3 Playwright

Specs are discovered by the OPS-2 globs (00 §9.15: `tests/frontend/**/*.spec.js`, `*/test/**/*.test.js`); no 02 package edits root `package.json` or `test-all.cmd` (cross-check issue 33).
- `tests/frontend/models-legacy-ui.spec.js` (new, MOD-19; discovered by the 00 §9.15 glob; `tests/frontend-smoke.spec.cjs` is not edited): llama model list with a mocked `deepseek4` model shows "未知（未验证）", not "兼容"; vLLM launch form parser dropdowns are filled from `/api/model/config` `parsers` (no name guess) for a mocked card; memory panel shows a non-zero estimate for a model without a size token; existing DOM ids unchanged.
- Console coverage of §18 R-UI-1..9 lives in 07's models and wizard Playwright specs.

## 22. Rollout

1. Fixtures + parser widening + inspector + roles (no behaviour change for users).
2. Knowledge loader, migration and shim (legacy APIs now read families v2).
3. Template signatures + parser resolution feed `/api/model/config` and the 01 resolver.
4. Artifact memory inputs on top of 01 ENG-12's memory models: `/api/memory-estimate` card mode, `planFacts` for `LaunchPlan.memory` (and so admission), fit-grid. Order: 08 P0-RT-3 → 01 ENG-12 → MOD-9 → MOD-9b.
5. Compatibility (+ precheck/llama fixes), root cause, probe.
6. Entry APIs, planner, qualification, host records, save-as-recipe, capabilities.
7. Legacy UI adoption, then (after 01 ENG-23) family-branch removal and the extra grep patterns. Console pages ship in 07.
Feature flags in `<AI_ROOT>/config/platform.json` section `models` (keys registered in 06 OPS-3's schema, read with `readSection("models")`, no direct file reads): `cardEstimator` (default true after step 4), `autoQualify`, `remoteHeaderMaxBytes`, `fitConstants`. Every step keeps `test-all.cmd` green. 02 adds no root files; new files sit in directories already in the release manifest (`manager-core`, `service-entry`, `scripts`, `tests`), so neither `build-github-release.ps1` nor `release-manifest.json` changes.

## 23. Contract changes requested

### 23.1 Changes to 00-decisions-and-contracts.md

- **C1 §3 Identifiers**: add `cardId` = `mc_<20 base32>` (sha256 of the canonical reference, §4.1) and `contentDigest` = `sha256:<hex>` (rename-stable content identity). The P3 library registry stores `cardId` and `contentDigest` per item. Host records, calibration and per-model overrides key on `contentDigest`.
- **C2 §2 Layout**: add `manager-core/model-inspector-routes.js` (manager routes) and `model-inspector/{index,card-schema,evidence,content-digest,cache,plan-facts,manager-hooks,knowledge,fit,calibration,probe,qualify,root-cause,observations,capabilities,host-records,migrate-v1,ggml-types,json-schema-lite,inspect-worker,recipe-draft}.js`, `model-inspector/{detectors,remote,probe-scripts}/`, `manager-core/data/knowledge/schema/*.json`, `service-entry/lib/{model-card-routes,knowledge-routes}.js`; disposable caches `<AI_ROOT>/cache/{model-cards,model-probes}/`; durable `service-entry/data/model-host-records.json` and `<manager>/data/memory-calibration.json` (the only calibration store). Namespace `core.models` next to `core.engines`.
- **C3 §4.3 LaunchPlan.memory**: `policy` stays the 00 enum as amended by 00 §9.1 (`static-fraction-of-free`, `weights-plus-kv`); 02 adds no policy value. FitResult adds the optional fields `range{lowMb,highMb}`, `confidence`, `ram{weights,experts,kv}`, `kv{bytesPerToken,stateBytesPerSeq}`, `spill`, `budgetMb`, `calibration`, `suggestions` (§10.2). The 08 C1 admission fields stay must-keep and are passed through untouched.
- **C4 Knowledge precedence**: layers in increasing precedence: bundled (for error signatures: plus 01 descriptor `errorSignatures[]` additions) → legacy user v1 → imported packs → `config/knowledge.d` → per-model (`config/knowledge.d/models/*.json`, read-only `<modelDir>/.platform/model.json`). Imported packs never override owner-written files.
- **C5 Job error object**: 02 produces the 00 §9.11 job error object `{code, signatureId, phase, hint{zh,en}, logExcerpt}` with the additive fields `title`, `explanation`, `exceptionType`, `suggestions[]`; 01 stores it as `job.failure` through `hooks.classifyFailure`.
- **C6 §4.5 Events**: the `jobs` type also carries job kinds `model-probe` and `model-qualify` (relayed by ENT-EV; no new type). The entry publishes `library` events of kind `qualification`.
- **C7 `/api/knowledge/status`**: aggregates domains from the entry and from each manager's `GET /api/knowledge/status` (through `/api/m/:managerId/knowledge/status`); response shape §17.
- **C8 Internal hop**: `/internal/models/` is one of 05 `internal-auth.js`'s path prefixes (listed in cross-check issue 5); `POST /internal/models/host-records` is its only route in 02.

### 23.2 Requests to other specs (02 does not edit them)

01's revision of 2026-10-14 already provides most of what 02 consumes (§3.1): `memoryModels.estimate` with `MemoryInputs.artifact`, `paramsKey`, PlanCtx `modelFacts`/`calibrationFor`, supervisor `afterReady`/`classifyFailure`, `job.failure`, `runtimeFacts.get/put`, `recipeSchema.validateRecipe`, `POST /api/recipes/reload`, `prospective` plans, `autoParsers{tool,reasoning}`, provenance `planner`, recipe `match.familyId`, and LaunchStore without calibrations. Remaining requests:

| Spec | Request | Cross-check issue |
|---|---|---|
| 01 | §10.1 note after the recipe example says "02 seeds `memory.measuredMiB` as a synthetic exact calibration record"; drop it, because `MemoryInputs.recipeMemory` already carries it and a family recipe has no `contentDigest` to key a record on | 10 |
| 01 | §12 `gguf-estimate` prefers `artifact.kvMb` and `artifact.weightsMbByGpu` (02 additive fields) when present; SWA and unified-KV layouts make `kvBytesPerToken × tokens` wrong for llama.cpp | 1 |
| 01 | §29 ENG-12 row still lists `requestedMbCeiling`/`requestedMbFloor` and calibration; align it with §12 (P0-RT-3 fields only, calibration via 02) | 1, 10 |
| 01 | Name the place where each manager builds PlanCtx for `resolveLaunchPlan` (ENG-7), so MOD-9b's one wiring line has a fixed home; or default `modelFacts`/`calibrationFor` from `core.models.managerHooks()` when the namespace exists | 1, 10 |
| 01 | Adapters' `estimateMemory` takes `MemoryInputs.artifact` from `ctx.model.artifactFor?.(plan.values, gpuIds)` (values are only final at step 9, so `modelFacts` cannot return the artifact itself); `null` keeps today's path | 1 |
| 01 | §16.3 entry schema: `phase` (with `stage` accepted as an alias), `code` and `hint{zh,en}` are part of the 02 schema; when `classifyFailure` returns a `logExcerpt` (root-cause window within 01's 40-line/4 KiB bound), 01 stores it instead of the raw tail | 20 |
| 03 | Use `inspectRemote`/`inspectLocal`/`estimateFit`/`evaluateCompatibility` as in §3.2; hub labels from `status` + `spill`; prospective plans with `model:{card}`; the hub token provider feeds `inspectRemote({token})` without persisting | 19, 9 |
| 05 | Viewer-allowlist registry `register({method, path, redact})` (02 registrations in §17); `/internal/models/` prefix in `internal-auth.js` with `allowedManagers:["vllm","llama"]` | 3, 5 |
| 06 | `models` section (`cardEstimator`, `autoQualify`, `remoteHeaderMaxBytes`, `fitConstants`) in the OPS-3 platform.json schema, read with `readSection("models")` | 2 |
| 07 | ENT-EV provides `events.publish` (`library` type), the manager `jobs` relay used by auto-qualify, the manager client for entry-side calls, and the route-mount table; CON-11/14/15 take §18 R-UI-1..9 as acceptance criteria, and one of them hosts the knowledge page; i18n area `models` holds the §18 keys | 4, 14, 15, 26 |
| 00 | §9.9 says `contentDigest` is "sha256 hex"; 02 uses the prefixed form `sha256:<64 hex>` (same as `planHash`). State the prefix explicitly | — |

## 24. Open decisions for the owner

- O1 Auto-qualification after the first successful launch of a new model/runtime/recipe (default "first-launch", light checks, about a minute of model time) vs on demand only.
- O2 Remote Range header reads (a few MB per repo) only on explicit inspect/precheck (default) or also while browsing search results.
- O3 Per-model overrides stored centrally under `config/knowledge.d/models/` (default) vs written into the model folder (`.platform/model.json` is only read).
- O4 Knowledge sharing: manual import/export of packs only (default) vs a pinned community feed.
- O5 The dry probe may run model-supplied Python only with per-request consent (default) vs never.
- O6 The DeepSeek-V4 compressed-attention KV uses the conservative bound until a measured launch with the same `paramsKey` calibrates it (llama.cpp prints exact `KV buffer size` lines, and other params get an `estimate_drift` warning); confirm that a possibly too-high first estimate (8.76 GiB at 1M tokens, f16) is acceptable.
- O7 Parser names for DeepSeek-V4 (`deepseekv4`/`deepseek-v4` on SGLang, none on vLLM 0.28) and `qwen3_coder` vs `qwen3_xml` on vLLM are taken from upstream docs until the probe of the pinned images confirms them; shipping them as `documented` is the default.
- O8 Splitting Qwen3.8 from Qwen3.5/3.6 by chat-template signature (both declare `qwen3_5`) is the default; the alternative is one shared family with the template only deciding parsers.
- O9 The long-context needle check stays opt-in (default) because it costs minutes at 256K+.

## 25. Work packages

Ordered; each fits one engineer-agent session. Ids `MOD-n` (ids kept from the first revision; MOD-9b is new, MOD-20 is withdrawn). Cross-spec ids come from 01 (ENG-*), 05 (PUB-*), 06 (OPS-*), 07 (ENT-EV, CON-*) and 08 (P0-*) as named in 00 §9 and in those specs. Lanes: every edit to `vllm-manager/server.js` (MOD-5, MOD-7, MOD-10, MOD-12, MOD-21) runs in the vllm-manager lane after ENG-11; every edit to `llama-manager/server.js` (MOD-5, MOD-10, MOD-11, MOD-21) runs after ENG-10. No package edits root `package.json`, `test-all.cmd`, `build-github-release.ps1`, `gpu-admission.js`, either `lib/launch-request.js`, or anything under `service-entry/console/`.

| Id | Title | Files touched / created | Depends on | Size | Acceptance |
|---|---|---|---|---|---|
| MOD-1 | Fixture capture tool and library fixtures | +`scripts/capture-model-fixture.js`; +`manager-core/test/fixtures/model-cards/**` (7 real, 14 synthetic); +`manager-core/test/fixtures/root-cause-samples/*.log.fixture`; +`manager-core/test/helpers/{gguf-writer,safetensors-writer,fixture-materialize}.js`; +`manager-core/test/fixture-privacy.test.js`; `manager-core/test/gguf-metadata.test.js` (helper import only) | — | M | Privacy test passes on both fixture dirs (no drive paths, usernames, keys); manifests carry a license; `git check-ignore` reports no fixture file (no `models`/`logs`/`cache` dirs, no `*.log`/`*.jsonl`); `gguf-metadata.test.js` green with the shared writer |
| MOD-2 | Widened GGUF parser with exact tensor bytes | `manager-core/gguf-metadata.js`; +`manager-core/model-inspector/ggml-types.js`; +`manager-core/test/model-inspector-gguf.test.js` | MOD-1 | M | DeepSeek-V4 fixture: chat template, compress ratios, indexer, sampling captured; total 90.89 GiB and experts 82.69 GiB exact; unknown type ⇒ `exact:false`; `parseGgufHeaderBuffer` partial mode throws `GgufNeedMoreBytes`; existing gguf tests unchanged and green |
| MOD-3 | ModelCard v1, evidence, content digest, cache, local inspector, `core.models` | +`model-inspector/{index,inspect,card-schema,evidence,content-digest,cache,json-schema-lite,inspect-worker}.js`; +`detectors/{inventory,hf-config,generation-config,template,quant,safetensors,gguf,topology}.js`; `manager-core/index.js` (one line `module.exports.models`); +`model-inspector-cards.test.js`, +`content-digest.test.js` | MOD-1, MOD-2 | L | Golden cards for all real fixtures; every fact has evidence; rename invariance (same `contentDigest`, different `cardId`); digest reads only small files and `stat` (fs spy); cache hit/miss by fingerprint; Flash-Next (418 shards) cold inspect < 10 s, cached < 50 ms; event loop never blocked > 100 ms; `require("manager-core")` exposes `models` with no `MANAGER_CORE_EXPORT_COLLISION`; all manager-core tests green |
| MOD-4 | Role detection and companion pairing | +`detectors/role.js`; +`model-inspector-roles.test.js` | MOD-3 | S | §7 table holds for every fixture; DSpark ↔ Qwen3.8-27B pairing; tooling-only `runnable:false` |
| MOD-5 | Knowledge layer loader, schemas, status, manager route module | +`model-inspector/knowledge.js`; +`manager-core/data/knowledge/{families,template-signatures,error-signatures}.json` (skeleton); +`data/knowledge/schema/*.json`; +`manager-core/model-inspector-routes.js` (`registerModelInspectorRoutes(app, deps)` with `GET /api/knowledge/status`); one registration block in each `server.js` passing the deps MOD-13/MOD-16 need (`isLocalRequest`, jobs functions, docker exec, instance lookup, data dir); +`knowledge-layers.test.js` | MOD-3, ENG-2 | L | Precedence and `$merge`/`$delete` tests; invalid and unsafe entries skipped and reported; startup never throws on a corrupt `config/knowledge.d` file; `registry.errorSignatureAdditions?.()` merged when present (stub in test), duplicate `code` reported; `stage` alias accepted; heuristic hits persisted; manager `GET /api/knowledge/status` returns 200 on both managers |
| MOD-6 | Migrate capabilities v1 to families v2, alias table, matrix shim | +`scripts/migrate-capabilities-v1.js`; +`model-inspector/migrate-v1.js`; `data/knowledge/families.json` (generated, with `capabilityIdAliases`); `manager-core/model-capability-matrix.js` (shim); `model-capability-matrix.test.js` (real Qwen3.8 fixture); +`knowledge-migration.test.js` | MOD-5 | M | Shim equivalence for all 14 entries × engines; real Qwen3.8 config → `qwen3.8`; `familyIdForCapabilityId` covers every v1 id and every `capabilityIds` value in bundled 01 recipes; `/api/capability-data` and download precheck unchanged in shape; a user v1 file loads as layer 2 |
| MOD-7 | Template signatures and parser resolution | +`model-inspector/template-signatures.js`; `data/knowledge/template-signatures.json`; `vllm-manager/server.js` (`summarizeModelConfigCapabilities` uses `resolveParsers`; allow-lists replaced by runtime-facts lists with visible errors); +`template-signatures.test.js` | MOD-5, MOD-6, ENG-16 | M | Fixture templates map to the right signatures; precedence tests incl. descriptor `capabilities.autoParsers{tool,reasoning}`; parser lists read through a stub `engines.runtimeFacts.get`; unknown parser never silently dropped; `/api/model/config` returns `parsers` keyed `toolCallParser`/`reasoningParser`/`autoToolChoice` with sources; vllm-manager tests green |
| MOD-8 | Remote inspector (HF, ModelScope, Range reader) | +`model-inspector/remote/{hf,modelscope,range-reader}.js`; `manager-core/remote-model-config.js` (delegates); +`model-inspector-remote.test.js` | MOD-3 | L | Mocked-fetch tests incl. Range-ignored cap; remote card equals local card on shared fields for two fixtures; injected `readRange` is used when given; 45 s budget enforced; token sent only to HF or a configured mirror and absent from cards, cache files and errors (grep test) |
| MOD-9 | Artifact memory inputs and fit grading | +`model-inspector/fit.js` (`artifactMemoryInputs`, `kvBytes`, `estimateFit`, `legacyEstimate`, `FIT_CONSTANTS`); +`fit.test.js` | MOD-3, ENG-12 (after P0-RT-3) | L | `fit.test.js` passes against the recording stub and the real `engines/memory-models.js`; `MemoryInputs.artifact` carries 01's field names; `policy`, `perGpuMb` and `admissionRequest` pass through unchanged; FitResult `policy` only takes 00 §4.3/§9.1 values (schema test); P0-RT-3 fields never renamed; `gpu-admission.test.js`, both `launch-request.test.js`, `memory-estimate-sglang.test.js` and `engines-memory.test.js` unchanged and green |
| MOD-9b | Artifact inputs into plans, `/api/memory-estimate`, fit-grid | +`model-inspector/{plan-facts,manager-hooks}.js` (`modelFacts`, `calibrationFor` returning `null` until MOD-10); `fit.js` (`fitGrid`); `manager-core/memory-estimator.js` (facade to `legacyEstimate`); `vllm-manager/lib/memory-estimate.js`, `llama-manager/lib/memory-estimate.js` (card mode only); `manager-core/gguf-variants.js` (`fitFor` → `estimateFit`); one wiring line in each manager's PlanCtx (site named by ENG-7); +`memory-estimate-contract.test.js`, +`plan-fit-equality.test.js`, +`fit-grid.test.js` | MOD-9, ENG-7 | M | Legacy bodies byte-identical; card mode has every legacy key plus `fit` and `card`; llama `plan.weightsGb` set; plan-fit equality for 3 fixtures × 3 engines; prospective plan with `model:{card}` gets artifact inputs; fit-grid bounds, `limitedBy` and memoization; P0-RT-3/ENG-12 tests green |
| MOD-10 | Calibration store, observations, supervisor hooks | +`model-inspector/{calibration,observations}.js`; `manager-hooks.js` (`calibrationFor`, `afterReady`, `classifyFailure` returning `null`); one hooks spread in each manager's `createRuntimeSupervisor`; +`calibration.test.js`; `fit.test.js` (drift cases) | MOD-9b, ENG-10, ENG-11, ENG-24 | M | Store cap 500, atomic write, corrupt file renamed; key equals `engines.paramsKey` output verbatim; `afterReady` (fake supervisor) records once per ready launch from `logFacts` without reading logs; an exact hit reaches `memoryModels.estimate` and yields `measured`; `estimate_drift` and `weights_mismatch`; a failing hook never fails the job; Pennyroyal still 88000 MiB (`pennyroyal.test.js` green; 02 adds no Pennyroyal code) |
| MOD-11 | Compatibility matrix and legacy fixes | +`model-inspector/compatibility.js`; `manager-core/download-precheck.js`; `llama-manager/server.js` (`evaluateLlamaArchitectureRuntimeCompatibility` reads families v2); +`compatibility.test.js`; `download-precheck.test.js` (new cases) | MOD-6, MOD-7, MOD-9, P0-DL-3, P0-RT-5 | L | Property test: no `ok` without support evidence; deepseek4 → `unknown`; P0-14 and P0-15 strings and finding codes unchanged ("按名称推断（未验证）", "未知（未验证）"); no `gguf-model-ui.js` change; Muse/BNB/DiffusionGemma rules unchanged; precheck evaluates all engine runtimes and all selected GPUs; descriptor fields read as `artifactFormats`/`capabilities.roles` |
| MOD-12 | Error signatures and root-cause classification | +`model-inspector/root-cause.js`; `data/knowledge/error-signatures.json`; `manager-hooks.js` (`classifyFailure` implemented); `manager-core/runtime-wait.js` (`--tail 2000` analysis); `vllm-manager/server.js` (`logIssueHint`/`buildLogSuggestions` delegate to signatures); +`root-cause.test.js` | MOD-5, MOD-10, ENG-24 | M | Ledger-derived `*.log.fixture` snippets map to signature ids and to the 00 §9.11 object; a supervisor stage failure (fake) stores it as `job.failure` with the legacy `job.error` prefix intact; every old hint string covered; `<redacted>` from `secret-redactor.js`; `runtime-wait.test.js` green |
| MOD-13 | Dry probe (Python registry probe, llama header load) | +`model-inspector/probe.js`; +`model-inspector/probe-scripts/hf_probe.py`; `manager-core/model-inspector-routes.js` (`POST /api/models/probe`); +`probe.test.js` | MOD-11, MOD-12, ENG-16 | L | Argv sandbox assertions; fake-docker parsing; registries written once via `engines.runtimeFacts.put(…, "registries", …)` and no other runtime-facts file exists; missing image → 409 `runtime_image_missing` without a pull; timeout ⇒ `inconclusive` and container removed; a probe upgrades a row from `unknown` only via `supportEvidence`; no `ai.manager` label |
| MOD-14 | Launch planner | +`model-inspector/planner.js`; +`planner.test.js` | MOD-9, MOD-11, ENG-3 | L | §11 fixture expectations with tolerances; every `values` key is a catalog id of that engine with `source:"planner"`; ≤ 3 diversified plans per GPU set; RAM reserve respected |
| MOD-15 | Entry model-card, knowledge and fit-grid APIs | +`service-entry/lib/{model-card-routes,knowledge-routes}.js` (one mount line each in the ENT-EV route-mount table; viewer-allowlist registrations); +`service-entry/test/model-card-routes.test.js` | MOD-8, MOD-9b, MOD-11, MOD-13, MOD-14, ENT-EV, PUB-5 | L | All §17 entry endpoints with the error envelope; every GET registered with its redaction or owner-only (05 registry test green); POSTs need a session/CSRF or token; path-outside-storage 400; recommend validates via `/api/m/:managerId/launch/plan` (prospective for remote cards) or returns `validated:null`; `/api/knowledge/status` always 200 with manager domains |
| MOD-16 | Qualification suite, host records, auto-qualify | +`model-inspector/{qualify,host-records}.js`; `model-inspector-routes.js` (`POST /api/qualify`); `model-card-routes.js` (`/api/models/:id/qualify`, `/qualifications`, `/qualifications/import`, `POST /internal/models/host-records`, auto-qualify trigger on relayed `jobs`); +`qualify.test.js` | MOD-15, PUB-10, ENG-10 | L | Mock-server tests for every check (speculative via `engines/metrics.js`); manager push signed by `internal-auth.js` and retried; bad HMAC, non-loopback socket or unknown job rejected; host record written atomically by the entry only; `library` event published; passes add `verified-on-host` evidence; auto-qualify respects `models.autoQualify` and never overlaps a benchmark |
| MOD-17 | Save working launch as recipe | `model-card-routes.js` (`POST /api/launches/:launchId/save-recipe`); +`model-inspector/recipe-draft.js`; tests in `model-card-routes.test.js` | MOD-16, ENG-6, ENG-8 | M | Draft validates with `engines.recipeSchema.validateRecipe`; `match` uses `familyId` (+`contentDigest` for "this model"), never `capabilityIds`; refuses without a passing `chat` check; no secrets, paths, `extraArgs` or `extraEnv` in the file; both managers' `recipes/reload` called (fake proxy), failure → `recipe_reload_failed`; the saved recipe is matched by the planner |
| MOD-18 | Published capabilities | +`model-inspector/capabilities.js`; managers' `/api/models` and instance summaries; `service-entry/lib/model-fleet.js` (explicit first, regex labelled fallback); +`capabilities.test.js` | MOD-7, MOD-16, ENG-13 | M | Vision-capable Qwen3.8 publishes `vision` unless `vllm.languageModelOnly`/`llamacpp.textOnly`; a failed tool check unpublishes `tools`; fleet routing tests green |
| MOD-19 | Legacy UI adoption | `vllm-manager/public/app.js` (delete `estimateMemoryUsage`, geometry table, parser guessers; use `/api/model/config` parsers and `/api/memory-estimate` with `model`); `llama-manager/public/app.js` (reasoningFormat from the card); +`tests/frontend/models-legacy-ui.spec.js` | MOD-7, MOD-9b, MOD-11, P0-UI-3, OPS-2 | M | The new spec passes; `frontend-smoke.spec.cjs` and `p0-ui.spec.cjs` untouched and green; existing DOM ids and payload assertions unchanged; no name-regex parser inference left in either `app.js`; both files stay classic scripts |
| MOD-20 | Withdrawn | Console pages are built by 07 (CON-11, CON-14, CON-15) with §18 R-UI-1..9 as acceptance criteria and the `models` i18n area | — | — | — |
| MOD-21 | Remove family branches, delete the v1 matrix, extend the guard | `vllm-manager/lib/model-capabilities.js`; `vllm-manager/server.js` (name inference, predicates); `llama-manager/server.js`; `service-entry/lib/model-fleet.js`; `manager-core/data/model-capabilities.json` (removed); `manager-core/test/no-family-branches.test.js` (append patterns and scopes only); `manager-core/test/fixtures/family-branch-allowlist.json` (entries with reason and expiry only); migrate `vllm-manager/test/model-capabilities.test.js` | MOD-6 … MOD-19, ENG-23, ENG-25 | M | The guard passes with zero code entries from 02's patterns; bundled recipes match by `familyId` and old `capabilityIds` overrides still match through the alias table; 01 golden argv tests byte-identical; full `test-all.cmd` green with pass/fail counts reported |
