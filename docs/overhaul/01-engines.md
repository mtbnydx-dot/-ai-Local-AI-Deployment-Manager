# 01 — Engines: registry, adapters, parameter catalog, recipes, launch plan, runtime supervisor

Phase P1 (`-engines`). Binding parent: `00-decisions-and-contracts.md` (D3, D4, D5, D10, §3–§6, and the §9 cross-check amendments of 2026-10-14). This spec refines it and lists every requested contract change in §27.

P0 lands first (`08-p0-fixes.md`). Where P0 already fixed a defect (secrets out of argv, idle wake, SGLang admission, per-instance logs, the redactor), this spec **ports** the P0 behaviour and its tests onto the new structures; it never re-implements or renames P0 fields.

Scope: engine identity, EngineDescriptor data, EngineAdapter code, tier-1 adapters (`vllm`, `sglang`, `llamacpp`), the generic `docker-template` adapter with experimental descriptors (`lmdeploy`, `trtllm`, `tabbyapi`), the `external` adapter, RuntimeHost, the shared runtime-supervisor, LaunchStore, parameter catalogs, recipes, `resolveLaunchPlan`, memory models, flag introspection, extraArgs/extraEnv, secrets, metrics/log data, and the manager APIs listed in §21.

Out of scope (owned elsewhere, consumed here): the ModelCard and knowledge layers (02-models), downloads (P3), the telemetry store (P4), gateway routes and key scopes (P5), the platform CLI (P6), and the new console form (P7). The console renders the schema defined here.

---

## 1. Verified current state (corrections to the diagnosis)

These facts were re-read in the worktree. Line numbers are at the current HEAD.

| Fact | Evidence | Consequence for this spec |
|---|---|---|
| The engine is coerced to two values | `vllm-manager/lib/runtime-command.js:402-404`, `launch-request.js:25` | Registry validation replaces every coercion (§3) |
| Presets beat user values through `a \|\| b` | `runtime-command.js:43-52` | Recipes need *derived* values that can reference the user value (§10.3) |
| Pennyroyal is switched on only by an exact image string | `pennyroyal.js:3,37-39`; `resolveVllmRuntimePreset` at `server.js:3390` | Becomes recipe `pennyroyal-v251` plus manifest runtime `sglangPennyroyal` |
| Preset logic reads host and env facts | `server.js:3367-3383` (`VLLM_QWEN_MOE_BACKEND`, SM12x detection), `3627-3643` (`process.platform`, `VLLM_GEMMA_*`, `VLLM_ALLOW_WINDOWS_DIFFUSION_GEMMA`) | Recipes need a fact/env-aware expression language with an env allowlist (§10.2) |
| The idle wake call shape is wrong | `server.js:1426` passes the config, while `launch-request.js:41` destructures `{body}`; `findLaunchConfig` compares a served name with a path (`server.js:1421-1425`) | Fixed in P0-RT-2 (`findWakePlan`, `canWake` 409, wake-secret hooks). ENG-8 ports it onto LaunchStore (§15.3) |
| SGLang admission uses the vLLM fraction | `launch-request.js:168-187` (`requestedFraction = gmu`, policy `vllm_gpu_memory_utilization`) | Fixed in P0-RT-3 (`requestedFractionOfFree`, `poolCappedTokens`, clamp-and-warn). ENG-12 moves it behind descriptor `memoryModel` (§12) |
| SGLang semantics, verified in SGLang `model_runner` | `total = free memory at init`; `KV pool = avail_after_weights − total·(1−f)`, capped by `--max-total-tokens` | Policy `static-fraction-of-free` (00 §9.1) |
| Image pull is implicit, before the checkpoint | `server.js:5085-5096` (`getImageStatusFresh`, then `pullImageWithRetry`, "Pulling before current model is stopped"); llama `server.js:3610-3617` | Kept for stable tier-1 images; plan `steps[]` makes it visible; experimental images need an explicit pull (§11, §14, 00 §9.2) |
| The llama runtime gate is string equality | `llama-manager/lib/runtime-command.js:38` | Becomes runtime `features` (§5) |
| HF_TOKEN and the API key are in argv | `runtime-command.js:214,304,387`; llama `:139,207` | Removed by P0-RT-1 (`-e NAME`, `secretEnv`). Adapters reproduce the post-P0 argv (§8, §18) |
| Error payload of `/api/start` | `manager-core/runtime-routes.js:1-6`: `{error:string, code, details}` | `/api/start` keeps this shape plus an additive `errors[]` (§21) |
| Existing tests assert argv fragments only | `vllm-manager/test/runtime-command.test.js`, `pennyroyal.test.js`, llama `runtime-command.test.js` | Full-argv goldens must be captured first (§8) |
| `node --test test/*.test.js` does not recurse | all `package.json` test scripts | New tests are top-level `test/engines-*.test.js` files, which both today's scripts and the OPS-2 glob (`*/test/**/*.test.js`) find. Fixtures go under `test/fixtures/` |
| `.gitignore` and the release robocopy exclude `logs/`, `models/`, `cache/`, `*.log`, `*.jsonl`, `jobs-ledger.json` | `.gitignore:22-45`, `build-github-release.ps1:64-100` | Fixture directories avoid those names, and fixture files with ignored extensions take a `.fixture` suffix (§25, 00 §9.14) |
| manager-core, scripts and tests are release-allowlisted directories | `build-github-release.ps1:141-157` | No release-list edits. After OPS-1/OPS-2 (00 §9.15), `release-manifest.json` is the authority and test discovery is glob-based, so no package edits `package.json`, `test-all.cmd` or `build-github-release.ps1` |
| The `ai.manager` label value is `vllm-manager`/`llama-manager` | `server.js:165`, `llama-manager/server.js` CONFIG | The label value is unchanged. API `managerId` stays `vllm`/`llama` (00 §3) |

---

## 2. Architecture

```
            HTTP (manager 5177 / 5178)                         entry 5176
 /api/engines  /api/engines/:id/schema  /api/launch/plan  /api/start  /api/instances...   /api/engines (aggregate, external)
        │                 │                     │             │             │                       │
        ▼                 ▼                     ▼             ▼             ▼                       ▼
   registry.js ──► param-catalog.js ──► resolve-launch-plan.js ──► runtime-supervisor.js      engine-routes.js
        │            legacy-aliases.js       │   │   │                  │   │                     │
        │  recipes.js + recipe-schema.js     │   │   └─► memory-models.js ◄── 02 fit.js (artifact inputs)
        │            + expr.js ◄─────────────┘   │       (estimate, paramsKey)  │             hosts/external.js
        ▼                                         ▼                          ▼
 data/engines/*.json                       adapters/{vllm,sglang,llamacpp,   hosts/{docker,native}.js
 data/launch-params/*.json                 docker-template,external}.js      launch-store.js
 data/recipes/*.json                       (buildLaunch, estimateMemory,     gpu-admission.js (P0-RT-3 fields)
 data/runtime-manifest.json (extended)      validate, declaredCapabilities)  container-replacement.js (existing)
                                           metrics.js · log-phases.js · runtime-facts.js · manager-core/secret-redactor.js (P0)
```

New modules live in `manager-core/engines/`:

- From 00 §2/§9: `registry.js`, `descriptor-schema.js`, `resolve-launch-plan.js`, `param-catalog.js`, `runtime-supervisor.js`, `hosts/{docker,native,external}.js`, `adapters/{vllm,sglang,llamacpp,docker-template,external}.js`, `metrics.js` (00 §9.12; replaces the `metrics-map.js` name), `log-phases.js`, `memory-models.js` (00 §9.1), `recipe-schema.js` (00 §9.10).
- Added (C2): `index.js`, `expr.js`, `legacy-aliases.js`, `recipes.js`, `launch-store.js`, `introspect.js`, `runtime-facts.js`, `extra-args.js`, `routes.js`, `adapters/_docker-segments.js`.
- There is no `engines/redact.js`. Every redaction calls `manager-core/secret-redactor.js` (P0-OBS-1, marker `<redacted>`, 00 §9.4).

`manager-core/index.js` exposes them as one namespace, `core.engines` (00 §9.17), so the flat export spread does not collide. Cross-spec entry points on that namespace: `engines.memoryModels.estimate(engineId, inputs)` and `engines.paramsKey(plan)` (02 fit and calibration), `engines.runtimeFacts.get(runtimeId)` (02 compatibility and probe), `engines.metrics.{parsePrometheus, mapPrometheus, summarize}` (04 collector), `engines.recipeSchema.validateRecipe(obj)` (02 save-as-recipe), and the supervisor hook `afterReady({…, logFacts})`, which delivers the parsed log facts of each launch to 02 observations (§14).

Process placement (D3):

- vllm-manager hosts the engines `vllm`, `sglang`, and every `docker-template` engine whose descriptor sets `hostManager:"vllm"`.
- llama-manager hosts `llamacpp`.
- service-entry hosts `external`.

---

## 3. Identity rules (refines 00 §3)

- `engineId` must match `^[a-z][a-z0-9-]{1,31}$`. `registry.require(engineId)` throws `{status:400, code:"unknown_engine"}`. There is no coercion.
- Legacy engine values map in both directions through `registry.fromLegacy(value, managerId)` and `registry.toLegacy(engineId)`. The legacy values are the `engine` body field, the `ai.manager.engine` label and the instance `engine` field.

| Legacy value | Context | engineId |
|---|---|---|
| `vllm` | vllm-manager | `vllm` |
| `sglang` | vllm-manager | `sglang` |
| `llama` | llama-manager label/body | `llamacpp` |
| *other* | label on a container | the engineId if registered, else the instance is reported with `engineId:"unknown"` and is still listed and stoppable (it is never hidden) |

- A legacy body with a missing or empty `engine` defaults to the manager's default engine (`vllm` or `llamacpp`), as today. A legacy body with an unknown non-empty `engine` returns 400 `unknown_engine` (today it is coerced to vllm). This is a deliberate D10 change. Today's UI never sends other values.
- `runtimeId` is `${engineId}@${version}`. A leading `v` before a digit is stripped, so `v0.28.0` gives `vllm@0.28.0`. Local builds use the manifest `version` verbatim (`sglang@qwen38flashnext-sm120-dac5523d`).
- `launchId` is `lch_` followed by 20 Crockford base32 characters (100 random bits). An *adopted* legacy container gets `lch_` + the first 20 chars of base32(sha256(`adopt:` + containerId)). That id is deterministic, so a restart re-derives the same id.

---

## 4. EngineDescriptor

The bundled descriptors are `manager-core/data/engines/<engineId>.json`. Override files are `<AI_ROOT>/config/engines/*.json`; they merge by `id` with deep merge for objects and replacement for arrays.

Override restrictions:

- An override may change `status`, `label`, `runtimes.allowed`, `runtimes.default`, `metricsMap`, `logPhases`, `logFacts` and `errorSignatures`.
- An override may add a new engine only with `adapter` ∈ {`docker-template`, `external`}. Tier-1 ids are reserved.

The validator is `descriptor-schema.js` and is hand-written (no dependencies). Its signature is `validateDescriptor(obj, { mode: "bundled"|"override"|"draft" }) → {ok, errors:[{path, code, message}]}`. Invalid overrides are dropped. The bundled descriptor is kept. The error is listed in `GET /api/engines` `errors[]` and fed to `/api/knowledge/status` (00 §2). The same function backs the side-effect-free `POST /api/engines/descriptors/validate` used by the console's custom-engine builder (§21); `mode:"draft"` applies the override restrictions below but never writes anything.

### 4.1 Fields

| Field | Type | Notes |
|---|---|---|
| `schemaVersion`, `asOf`, `staleAfterDays` | int, date, int | Rule 7.5 |
| `id`, `label{zh,en}`, `description{zh,en}` | | |
| `family` | `vllm`\|`sglang`\|`llamacpp`\|`openai-server`\|`multi-model-server` | Feeds `engineFamily` in instances |
| `adapter` | `vllm`\|`sglang`\|`llamacpp`\|`docker-template`\|`external` | Code module |
| `tier` | 1\|2\|3 | 1 means byte-identical argv is required |
| `status` | `stable`\|`experimental`\|`disabled` | Launching an experimental engine needs `acknowledge:["experimental-engine"]` |
| `hostManager` | `vllm`\|`llama`\|`entry` | |
| `legacy` | `{engineLabel, managerEngineField}` | e.g. `{ "engineLabel":"sglang" }` |
| `artifactFormats` | list | `safetensors`,`gguf`,`exl3`,`awq`,`gptq`,`fp8`,`nvfp4` |
| `runtimes` | `{default, allowed[], envOverride{manifestKey:ENV}, allowCustomImage}` | Manifest keys; env override keeps today's `VLLM_IMAGE`, `SGLANG_IMAGE`, `LLAMA_IMAGE`… precedence |
| `host` | `{kinds[], default, containerPort, ipc, init, ulimits[], restart, gpus:"required\|optional\|none", allowLan, healthcheck, cacheMounts[]}` | Docker run defaults |
| `api` | `{openaiBase, models, health, version[], ready{kind}, probe{kind,maxTokens}}` | `ready.kind`: `models-list`\|`health-200`\|`health-503-loading` |
| `apiSurface`, `apiQuirks` | 00 §4.1 shape; `{reasoningField}` | |
| `catalog` | `"launch-params/<id>.json"` | §9 |
| `memoryModel` | `{kind, fractionParam?, poolTokensParam?}` | §12 |
| `capabilities` | `{parallelInstances, tensorParallel, pipelineParallel, dataParallel, expertParallel, speculative[], autoParsers:{tool, reasoning}, lora, multiModel, hotLoad, sleepWake, roles[]}` | `autoParsers.tool` / `.reasoning` is the parser name the engine applies on its own when the param is unset (`"auto"` when it detects from the chat template), or `null` when it applies none (00 §9.10). Introspection may refine it (§17) |
| `knowledgeKeys` | list | The capability-matrix keys the resolver may consume (§11) |
| `secrets` | `{apiKey:{mode:"env"\|"flag"\|"file"\|"unsupported", env?, flag?, fallbackFlag?}}` | §18 |
| `managedFlags` | list | Never accepted in extraArgs |
| `extraEnvAllow` | list of prefixes | §18 |
| `introspection` | `{entrypoint, argv[], parser:"argparse"\|"llama-help"\|"click"}` | §17 |
| `metricsMap`, `logPhases`, `logFacts`, `errorSignatures` | | §16. `errorSignatures[]` uses the 02 `knowledge/error-signatures.json` entry schema and holds engine-specific additions only |
| `template` | | `docker-template` only (§19) |
| `external` | | `external` only (§20) |

### 4.2 Example (`data/engines/sglang.json`, abridged)

```json
{
  "schemaVersion": 1, "asOf": "2026-10-14", "staleAfterDays": 120,
  "id": "sglang", "label": { "zh": "SGLang", "en": "SGLang" },
  "description": { "zh": "长上下文与 Flash-Next 路径；Linux/Docker。", "en": "Long-context and Flash-Next path; Linux/Docker only." },
  "family": "sglang", "adapter": "sglang", "tier": 1, "status": "stable", "hostManager": "vllm",
  "legacy": { "engineLabel": "sglang", "managerEngineField": "sglang" },
  "artifactFormats": ["safetensors", "fp8", "nvfp4", "awq", "gptq"],
  "runtimes": { "default": "sglang", "allowed": ["sglang", "sglangFlashNext", "sglangPennyroyal", "sglangFlashNextNvme"],
                "envOverride": { "sglang": "SGLANG_IMAGE", "sglangFlashNext": "SGLANG_FLASH_NEXT_IMAGE" }, "allowCustomImage": true },
  "host": { "kinds": ["docker"], "default": "docker", "containerPort": 8000, "ipc": "host", "init": false, "ulimits": [],
            "restart": "on-failure:3", "gpus": "required", "allowLan": true,
            "healthcheck": { "cmd": "curl -fsS http://127.0.0.1:8000/health || exit 1", "interval": "30s", "timeout": "5s", "retries": 3 },
            "cacheMounts": [{ "configKey": "sglangCache", "target": "/root/.cache" }] },
  "api": { "openaiBase": "/v1", "models": "/v1/models", "health": "/health", "version": ["/get_server_info", "/server_info"],
           "ready": { "kind": "models-list" }, "probe": { "kind": "chat-generation", "maxTokens": 32 } },
  "apiSurface": { "chat": true, "completions": true, "responses": true, "messages": true, "embeddings": false, "rerank": false },
  "apiQuirks": { "reasoningField": "reasoning_content" },
  "catalog": "launch-params/sglang.json",
  "memoryModel": { "kind": "static-fraction-of-free", "fractionParam": "sglang.memFractionStatic", "poolTokensParam": "sglang.maxTotalTokens" },
  "capabilities": { "parallelInstances": true, "tensorParallel": true, "pipelineParallel": true, "dataParallel": true, "expertParallel": true,
                    "speculative": ["DSPARK", "NEXTN", "EAGLE", "EAGLE3", "STANDALONE", "NGRAM"], "autoParsers": { "tool": null, "reasoning": null },
                    "lora": true, "multiModel": false, "hotLoad": false, "sleepWake": false, "roles": ["chat", "embedding"] },
  "knowledgeKeys": [],
  "secrets": { "apiKey": { "mode": "flag", "flag": "--api-key" } },
  "managedFlags": ["--model-path", "--served-model-name", "--host", "--port", "--api-key", "--enable-metrics"],
  "extraEnvAllow": ["SGLANG_", "NCCL_", "PYTORCH_", "TORCH_", "TRITON_", "FLASHINFER_"],
  "introspection": { "entrypoint": "python3", "argv": ["-m", "sglang.launch_server", "--help"], "parser": "argparse" },
  "metricsMap": { "path": "/metrics", "format": "prometheus", "map": { "kvUsageRatio": [{ "name": "sglang:token_usage", "kind": "gauge" }],
                  "ttftSeconds": [{ "name": "sglang:time_to_first_token_seconds", "kind": "histogram" }] } },
  "logPhases": [], "logFacts": [], "errorSignatures": []
}
```

The llamacpp descriptor ships `autoParsers: {"tool": "auto", "reasoning": "auto"}` (llama-server detects both from the chat template); vllm and sglang ship `null` for both.

`knowledgeKeys` for sglang stays `[]` in P1. The capability-matrix `sglang` section (`model-capabilities.json`, entry `qwen3.8-flash-next`) contradicts the validated recipe (`maxNumSeqs:1`, `speculative.auto:"nextn"` against the recipe's "speculative off"). 02-models reconciles that data before the key is enabled. The vllm descriptor sets `knowledgeKeys: ["reasoningParser","toolCallParser","enableAutoToolChoice","forceTrustRemoteCode","env","requiredPluginFile","speculative"]`, which is exactly what `lib/model-capabilities.js:249-266` consumes today.

---

## 5. Runtime manifest extension

`manager-core/data/runtime-manifest.json` stays at `schemaVersion: 1` with additive fields. `runtime-manifest.js` keeps `getRuntimeRelease(key)` and `runtimeImageReference(key)` and adds the following:

```js
listRuntimes() → [{ manifestKey, runtimeId, engineId, image, version, compatVersion, features, status, localBuild }]
resolveRuntime(engineId, { runtimeId?, manifestKey?, image? }) → RuntimeRef | throws { code:"unknown_runtime" }
runtimeForImage(imageRef) → RuntimeRef | null   // replaces knownRuntimeImageMetadata (server.js:1602)
```

New per-entry fields:

- `engineId`.
- `compatVersion`: the upstream version used for `since`/`until` comparisons, for example `"0.5.17"` for local SGLang builds.
- `features{}`.
- `status`: `pinned`|`experimental`|`retired`|`unpinned`.
- `envOverride`.

New entries cover the image literals that live in code today:

| manifestKey | runtimeId | Source today | features |
|---|---|---|---|
| `vllm` | `vllm@0.28.0` | manifest | `{ "bitsAndBytesPlugin": false }` |
| `vllmQwenMoe` | `vllm@nightly-a16dbd5b` | `server.js:93,1625-1633` | same; `transformersVersion 5.12.1` |
| `vllmGemma` | `vllm@v74b5964f` | `server.js:92,1634-1641` | `transformersVersion 5.10.2` |
| `sglang` | `sglang@0.5.17` | manifest | `{}` (unknown means no gating) |
| `sglangFlashNext` | `sglang@qwen38flashnext-sm120-dac5523d` | manifest | `{ "pleOffload": true, "linearAttnBackends": true, "mambaControls": true }` |
| `sglangPennyroyal` | `sglang@pennyroyal-v2.5.1` | `pennyroyal.js:3` | `{ "pleOffload": true, "nextnFrSpec": true }` |
| `sglangFlashNextNvme` | `sglang@flashnext-nvme-ple-20260831` | manifest (`experimental`, `localBuild`, "not wired into the manager yet") | `{}` until introspected. Status `experimental`; no recipe, no golden, never auto-selected |
| `llama` | `llamacpp@b10630` | manifest | `{ "reasoningEffort": true, "mmprojDevice": true }` |
| `llamaMuse` | `llamacpp@muse-62bf73d` | manifest (`retired`) | `{ "reasoningEffort": false, "mmprojDevice": false }` |
| `lmdeploy`, `trtllm`, `tabbyapi` | `…@<tag>` | new, `status:"unpinned"` | `{}` |

Feature gating rule: an adapter reads `runtime.features.X`. An image that does not resolve to a manifest entry (a custom override) gets `features:{}` and treats every gated control as unsupported. That matches `supportsB10630Controls` today, which is true only when the image equals `CONFIG.image`.

The env > manifest precedence for images is kept per `runtimes.envOverride`. `FALLBACK_RUNTIMES` gains the new entries. The test `runtime-manifest.test.js` "bundled manifest validates" is extended, and `engines-registry.test.js` iterates **every key** of the bundled JSON manifest and asserts that it maps to exactly one `runtimeId` and `engineId` (a new key without a mapping fails the test).

Pull policy per runtime (feeds plan `steps[]`, §11): `auto` when the engine is tier 1 and stable (today's implicit pull, including env image overrides), `explicit` otherwise (experimental engines, `unpinned` or `experimental` runtimes). `localBuild` runtimes cannot be pulled; a missing local build gives blocker `runtime_local_build_missing` with the rebuild hint.

---

## 6. EngineAdapter interface

`manager-core/engines/adapters/<id>.js` exports one object. Every method is **pure and synchronous** except where noted. All I/O facts arrive through `ctx`.

```js
/**
 * @typedef {object} AdapterCtx
 * @property {object} descriptor           validated EngineDescriptor
 * @property {RuntimeRef} runtime          { runtimeId, manifestKey, image, features, compatVersion }
 * @property {object} host                 { kind, containerPort, config: { modelsRoot, hfCache, vllmCache, sglangCache, imagePlatform, containerName, managerLabelValue } }
 * @property {object} model                { ref, localPath, containerPath, modelArg, effectiveLoadFormat, ggufFiles, mmprojFiles, draftFiles,
 *                                           selectedModel, config, quantMethod, capabilityId, familyId, contentDigest, nativeMtp,
 *                                           card, prospective }   // legacy resolveLaunchModel + facts; ModelCard after 02; prospective = no files on disk (§11)
 * @property {object} hostFacts            { platform, gpus:[{id,index,name,computeCap,totalMb,usedMb}], env:{allowlisted only} }
 * @property {string} launchId
 * @property {(path)=>string} toContainerPath
 * @property {(ids)=>string} dockerGpuArg
 * @property {(port,access,host)=>string[]} dockerPublishArgs
 */
module.exports = {
  id: "sglang",
  /** Effective values → ordered launch command (no I/O). Throws {code:"blocked"} with findings when a recipe blocks. */
  buildLaunch(plan, ctx) /* → LaunchCommand */,
  /** Builds MemoryInputs from plan + ctx and returns memoryModels.estimate(descriptor.id, inputs) (§12). No policy logic in adapters. */
  estimateMemory(plan, ctx),
  /** → Finding[] {severity:"fail"|"warn"|"ok", code, title{zh,en}, detail{zh,en}, field?} */
  validate(plan, ctx),
  /** optional; only for non-Prometheus payloads (TRT-LLM JSON). Default: metrics.mapPrometheus(engineId, metrics.parsePrometheus(text)) */
  mapMetrics(payload, ctx),
  /** Declared capabilities of the launched instance (00 §4.1 capabilities + apiSurface) */
  declaredCapabilities(plan, ctx),
  /** async; optional. GET version endpoint → { version, raw } */
  async probeVersion(endpoint, fetchImpl),
  /** optional multi-model hooks (external/ollama, tabby): async listModels/loadModel/unloadModel */
};
```

`LaunchCommand` is consumed by RuntimeHost (§13) and by goldens. It is ordered and never re-sorted:

```js
{
  host: "docker",
  docker: {
    flags: ["--pull", "never", "--name", "vllm-local", "--restart", "on-failure:3", "--label", "ai.manager=vllm-manager", "…"],  // everything between "run -d" and the image, in emission order
    entrypoint: "sglang" | null,   // emitted as "--entrypoint", value immediately before the image (legacy position)
    image: "local/sglang:qwen38flashnext-sm120-dac5523d",
    args: ["serve", "--model-path", "/models/…", "…"]
  },
  publish: ["127.0.0.1:8000:8000"],
  secretEnv: { "VLLM_API_KEY": "…" },      // P0-RT-1 shape: docker CLI process env via buildDockerChildEnv (§18), never in flags
  files: [],                                // generated files (docker-template)
  labels: { "ai.manager.launch-id": "lch_…" },   // read-only mirror of the label pairs in flags, used by inspect/plan
  metaPatch: { runtimePreset: "…", engine: "sglang", "…": "…" },  // legacy job.meta fields written today by the builder
  logs: ["Runtime preset: …"],              // legacy appendLog lines, replayed by the supervisor
  redactions: ["…secret values…"]           // passed as `secrets` to secret-redactor.redactSecrets
}
```

### 6.1 Tier rules

- **Tier 1 (legacy-ordered core plus appended extensions).** `adapters/vllm.js`, `sglang.js` and `llamacpp.js` hold the extracted builder code from `vllm-manager/lib/runtime-command.js` and `llama-manager/lib/runtime-command.js`, changed only to read `plan.values` instead of `opts`. Docker flags and engine args are emitted in exactly today's order. Catalog parameters that did not exist before P1 (§9.4) are emitted **after** the legacy engine args and **before** `--api-key` (when that flag is still used), in catalog `order`, and only when set. The new labels (§15.2) are inserted as the last docker flags before `--entrypoint`/image. Goldens therefore change only by those label pairs, once (ENG-8).
- **Tier 2/3.** `docker-template` and `external` are fully data-driven (§19, §20).
- No adapter may contain a model-family branch. Model-dependent behaviour comes from recipe data (D5, ENG-23 grep test).

---

## 7. Tier-1 adapters: what moves where

| Today | Becomes |
|---|---|
| `createVllmRuntimeCommandBuilder` vLLM branch (`runtime-command.js:36-307`) | `adapters/vllm.js buildLaunch` |
| `appendSglangServeArgs` plus the sglang docker branch (`:171-233, 309-388`) | `adapters/sglang.js buildLaunch` |
| Pennyroyal flags, labels, env, cache volume, `--init`, `--ulimit`, `:ro` mounts and `--restart no` (`:145,168-169,180-199,375-386`) | Recipe `pennyroyal-v251` data (`dockerFlags`, `fixedArgs`, `env`, `labels`, `mounts`, `restart`) consumed through named **slots** in the sglang adapter: `restart`, `hfCacheMount`, `modelMountReadOnly`, `variantDockerFlags` (after `ai.sglang.*` labels), `cacheMount`, `fixedArgsTail` (after DSPARK, before `--api-key`) |
| `buildLlamaRuntimeCommand` (`llama runtime-command.js:32-214`) | `adapters/llamacpp.js buildLaunch`; `supportsB10630Controls` becomes `runtime.features.reasoningEffort` and `runtime.features.mmprojDevice`; the Muse image choice becomes recipe `llama-muse-glimmer` (status `blocked`, runtime `llamacpp@muse-62bf73d`, sampling values temp 1 / top-p 0.95 / top-k 64) |
| `redactDockerArgs` (both) | A one-line wrapper over `manager-core/secret-redactor.js#redactSecrets` (P0-OBS-1). The wrappers keep exporting the name; its marker becomes `<redacted>` in ENG-15 (§18) |
| `normalizeRuntimeEngine` | `registry.fromLegacy` |
| `normalizeLlamaSpeculativeMode`, `clampSpeculativeTokens`, `optionalSamplingNumber` | Exported from `adapters/llamacpp.js`; the llama lib re-exports them |
| `vllm-manager/lib/runtime-command.js`, `llama-manager/lib/runtime-command.js` | Thin wrappers. `createVllmRuntimeCommandBuilder(deps)` maps legacy `opts` to a plan via `legacy-aliases.js` and dispatches to the adapter by engineId. It returns the legacy `{runArgs, activePublishArgs, runtimeImage, runtimePreset, runtimeEngine}`, applies `metaPatch` to `job.meta`, replays `logs` through `appendLog`, and calls `scheduleJobsSave` when the legacy code did |

`runArgs` is rendered by the shared helper `adapters/_docker-segments.js#renderRunArgs(cmd)` = `["run","-d", ...flags, ...(entrypoint ? ["--entrypoint", entrypoint] : []), image, ...args]`. DockerHost uses the same function (§13), so goldens and execution share one renderer.

---

## 8. Golden fixtures (captured before any refactor)

Goldens are captured **once**, by ENG-1, from the post-P0 merge head of the integration branch (after P0-RT-1, P0-RT-2 and P0-RT-3 have changed argv and admission requests; 00 §9.14, 08 C3). P0 creates and updates no goldens.

### 8.1 Format

`manager-core/test/fixtures/engines/goldens/<id>.json` (the only golden path):

```json
{
  "schemaVersion": 1,
  "id": "G-S2-sglang-flashnext-262k",
  "kind": "builder|preset|profile|request",
  "source": "vllm-manager/test/runtime-command.test.js › SGLang runtime command emits the validated Flash-Next SM120 long-context contract",
  "stubs": "vllm-test-v1",
  "env": { "HF_TOKEN": null, "VLLM_START_TIMEOUT_MS": null, "platform": "win32" },
  "input": { "config": {}, "launch": {}, "quantization": {}, "preset": {}, "opts": {}, "modelFixture": null },
  "expect": { "runArgs": [], "activePublishArgs": [], "secretEnvNames": ["VLLM_API_KEY"], "runtimeImage": "", "runtimeEngine": "", "jobMeta": {}, "logs": [] },
  "history": [{ "at": "2026-10-15", "reason": "initial capture from the post-P0 merge head <short sha>" }]
}
```

`secretEnvNames` records the names (never values) of P0-RT-1's `secretEnv`, so the secret channel is pinned too.

- `stubs` names a deterministic stub set in `manager-core/test/helpers/engine-golden-stubs.js`. These are the `dockerGpuArg`, `dockerPublishArgs` and `windowsPathToContainerPath` lambdas copied from the existing tests.
- `modelFixture` names a description under `manager-core/test/fixtures/engines/model-samples/` (never a directory called `models/`, which `.gitignore` and the release robocopy drop): its `config.json`, `tokenizer.json` bytes, safetensors index with MTP keys, and GGUF header. The harness materialises it under `os.tmpdir()`.
- `process.platform` is stubbed with `Object.defineProperty` for the DiffusionGemma cases.
- Paths use the existing test conventions (`D:/AI/models`, `F:/llm/model`). New fixtures use `C:/fixture/models`. No user paths (rule 7.8).

### 8.2 Enumeration (capture list)

| Id | Kind | Source of inputs |
|---|---|---|
| G-V1 vllm-gguf-preset-lan-tp2 | builder | vllm `runtime-command.test.js:5` |
| G-V2 vllm-preset-autodetect | builder | `:124` |
| G-V3a/G-V3b prefix-cache default/disabled | builder | `:193` |
| G-V4 vllm-qwen38-positional | builder | `:395` |
| G-S1 sglang-qwen38-dspark | builder | `:234` |
| G-S2 sglang-flashnext-262k | builder | `:307` |
| G-S3 sglang-pennyroyal-v251 | builder | `pennyroyal.test.js:30` |
| G-L1 llama-remote-hf-hetero-fit | builder | llama `runtime-command.test.js:5` |
| G-L2 llama-mmproj-mtp-apikey | builder | `:93` |
| G-L3 llama-muse-mmproj-dflash | builder | `:157` |
| PRE-01..02 Pennyroyal on a Flash-Next model, and on a non-Flash-Next model (unsupportedReason) | preset | `server.resolveVllmRuntimePreset` + model fixtures |
| PRE-03..04 SGLang Flash-Next NVFP4 with speculative off, and with mtp (blocked) | preset | core.test.js:758 inputs |
| PRE-05 SGLang Qwen3.8 FP8 + DSpark (draft fixture with `DSparkDraftModel`) | preset | |
| PRE-06 SGLang generic (Llama-3 config) | preset | |
| PRE-07 vLLM with dspark (unsupported) | preset | |
| PRE-08..09 vLLM Qwen3.8 FP8 / NVFP4 | preset | |
| PRE-10..12 Qwen3.6 MoE NVFP4 with hostGpus SM120, the same without SM12, and Qwen3.6 Dense NVFP4 | preset | core.test.js:673 configs |
| PRE-13..14 DiffusionGemma on win32 (blocked) and linux | preset | core.test.js:823 |
| PRE-15 gpt-oss (matrix parsers), PRE-16a/b Nemotron-3-Nano with and without the plugin file, PRE-17 BNB checkpoint, PRE-18 Muse, PRE-19 unknown model | preset | model-capabilities tests |
| P-V01..P-V10 | profile | each `createVllmDefaultLaunchProfiles` entry → `normalizeLaunchConfig` → `startRuntimeRequest` normalisation → preset → builder, with a fixture model per profile (Flash-Next dir for the Pennyroyal and Flash-Next profiles; Qwen3.8-27B-FP8 with an MTP index for the mtp3, dspark and nvfp4 profiles; generic Llama-3 for the rest) |
| P-L01..P-L05 | profile | each llama builtin profile plus a synthetic GGUF fixture (llama `launch-request.test.js` helper) |
| R-V1..R-V3 | request | vllm `launch-request.test.js:5,206,245`: `job.meta`, `runOptions`, `gpuAdmissionRequest`, call order |
| R-L1..R-L2 | request | llama `launch-request.test.js:71,200` |

That is 49 fixtures. `sglangFlashNextNvme` gets none (experimental, no recipe).

### 8.3 Harness and update rules

- Running `node scripts/capture-engine-goldens.js --write all --reason "<text>"` writes the fixtures. `--check` (the default) exits 1 on any diff and prints a unified diff of `runArgs`. A write without `--reason` is refused. Each write appends to `history`.
- `vllm-manager/test/engines-golden-legacy.test.js` and `llama-manager/test/engines-golden-legacy.test.js` assert that the **current** builders reproduce every fixture. They are deleted only in ENG-23.
- `manager-core/test/engines-golden.test.js` asserts that the **adapters** reproduce every fixture. `runArgs`, `activePublishArgs`, `runtimeImage` and `runtimeEngine` must match exactly. `jobMeta` must be deep-equal. `logs` must match exactly in P1.
- Capturing twice yields byte-identical files (deterministic ordering and no timestamps in `expect`).
- The only planned golden rewrites after capture are ENG-8 (the four label pairs, `--reason "launch-id labels"`) and ENG-15 (none expected, because P0-RT-1 already removed secrets from argv; a non-empty diff there is a defect).

---

## 9. Parameter catalog

### 9.1 Files and loader

- `manager-core/data/launch-params/common.json` defines canonical concepts (labels, help, units, groups).
- `manager-core/data/launch-params/<engineId>.json` defines bindings plus engine-specific params.
- Overrides live in `<AI_ROOT>/config/launch-params/*.json`.
- `param-catalog.js`:

```js
loadCatalog(engineId, { runtime, introspected }) → { catalogVersion, groups[], params[], byId, byLegacyField }
paramAvailability(param, runtime, introspected) → { state: "available"|"unavailable"|"unverified", reason }
validateValues(values, catalog, ctx) → { errors: FieldError[], warnings: FieldError[] }   // ranges, choices, rules
```

`catalogVersion` is the `asOf` of the engine file joined with the common file, for example `"2026-10-14+2026-10-14"`.

### 9.2 Param schema

```json
{
  "id": "sglang.maxTotalTokens",
  "group": "memory", "level": "advanced", "order": 220,
  "type": "int", "unit": "tokens",
  "label": { "zh": "KV 池容量上限", "en": "KV pool size limit" },
  "summary": { "zh": "SGLang 共享 KV 池最多容纳的 token 数；所有并发请求共用。", "en": "Maximum tokens in SGLang's shared KV pool; all concurrent requests share it." },
  "help": {
    "what": { "zh": "对应 --max-total-tokens。不设置时 SGLang 用 mem-fraction-static 能放下的全部容量。", "en": "Maps to --max-total-tokens. Unset, SGLang fills whatever mem-fraction-static leaves after weights." },
    "whenToChange": { "zh": "需要限制显存占用或让准入预算可预测时。", "en": "To bound VRAM use and make admission predictable." },
    "tradeoffs": { "zh": "越小越省显存，但长上下文并发会排队。", "en": "Smaller saves VRAM; long concurrent requests queue." }
  },
  "docs": "https://docs.sglang.io/advanced_features/server_arguments.html",
  "range": { "min": 1, "max": 4194304, "step": 1 },
  "choices": null, "choicesFrom": null,
  "engineDefault": null, "platformDefault": null,
  "emit": { "mode": "adapter", "kind": "flag-value", "flag": "--max-total-tokens", "omitWhen": [0, null] },
  "vramEffect": "kv-linear",
  "rules": [],
  "managed": false, "secret": false,
  "legacy": { "field": "sglangMaxTotalTokens", "domId": "sglangMaxTotalTokens" },
  "appliesWhen": null
}
```

- `type` is one of `int|float|bool|tristate|enum|string|path|json|list|kv`.
- `emit.mode` is `adapter` (a legacy flag emitted by tier-1 code in legacy order; the catalog entry is descriptive) or `catalog` (generic emission, appended).
- `emit.kind` is one of `flag-value|flag-bool|bool-pair|json|repeat|csv|env|none`.
- `transform` is one of `containerPath|ctxTimesConcurrency|jsonStringify`.
- A param may give `flags:[{flag, since?, until?}]` instead of `emit.flag`, for renamed flags. Selection order: introspected presence first, then `compatVersion`.
- `rules[]` entries are `{kind:"errorIf"|"warnIf"|"requires"|"conflicts", when:<expr>, code, message{zh,en}}` (§10.2).
- A **null** value means "unset" (the flag is omitted and the engine default applies). `platformDefault` reproduces today's server defaults, so goldens hold.

### 9.3 Seed: every existing UI field

The columns are: param id, legacy field(s), then the flag for vLLM | SGLang | llama.cpp. "—" means the engine does not support it: the param is hidden, and a legacy value produces warning `param_not_applicable`. A v2 value produces error `param_not_applicable`. "(new)" means the flag is not emitted today.

| param id | legacy field | vLLM | SGLang | llama.cpp | type/unit · group/level | label zh / en |
|---|---|---|---|---|---|---|
| `contextLength` | maxModelLen | `--max-model-len` | `--context-length` | `--ctx-size` (×concurrency) | int tokens · capacity/basic | 上下文长度（每请求）/ Context length (per request) |
| `concurrency` | maxNumSeqs | `--max-num-seqs` | `--max-running-requests` | `--parallel` | int requests · capacity/basic | 最大并发请求 / Max concurrent requests |
| `servedName` | name | `--served-model-name` | `--served-model-name` | `--alias` | string · model/basic | 服务名 / Served model name |
| `dtype` | dtype | `--dtype` (always) | `--dtype` (non-auto) | — | enum · model/advanced | 计算精度 / Compute dtype |
| `quantization` | quantization | `--quantization` | `--quantization` | — | enum · model/advanced | 权重量化方式 / Weight quantization |
| `tokenizer` | tokenizer | `--tokenizer` | `--tokenizer-path` (new) | — | path · model/expert | 分词器路径 / Tokenizer path |
| `trustRemoteCode` | trustRemoteCode | `--trust-remote-code` | same | — | bool · model/advanced | 信任模型仓库代码 / Trust model repository code |
| `kvCacheDtype` | kvCacheDtype | `--kv-cache-dtype` | same | alias → `llamacpp.cacheTypeK/V` | enum (introspect) · memory/basic | KV 缓存精度 / KV cache precision |
| `prefixCaching` | enablePrefixCaching, disablePrefixCaching | `--enable-prefix-caching` / `--no-enable-prefix-caching` | off → `--disable-radix-cache` | — | tristate · memory/advanced | 前缀缓存 / Prefix caching |
| `tensorParallel` | tensorParallelSize | `--tensor-parallel-size` | `--tp-size` | — | int GPUs · parallelism/advanced | 张量并行卡数 / Tensor-parallel GPUs |
| `pipelineParallel` | pipelineParallelSize | `--pipeline-parallel-size` | `--pp-size` (new) | — | int · parallelism/expert | 流水线并行段数 / Pipeline stages |
| `dataParallel` | dataParallelSize | `--data-parallel-size` | `--dp-size` (new) | — | int · parallelism/expert | 数据并行副本 / Data-parallel replicas |
| `expertParallel` | enableExpertParallel | `--enable-expert-parallel` | `--ep-size` = TP (new) | — | bool · parallelism/expert | MoE 专家并行 / MoE expert parallel |
| `reasoningParser` | reasoningParser | `--reasoning-parser` | same | — | enum (introspect) · reasoning-tools/basic | 思考内容解析器 / Reasoning parser |
| `toolCallParser` | toolCallParser | `--tool-call-parser` | same | — | enum (introspect) · reasoning-tools/basic | 工具调用解析器 / Tool-call parser |
| `autoToolChoice` | enableAutoToolChoice | `--enable-auto-tool-choice` | implied by parser | — | bool · reasoning-tools/advanced | 自动工具调用 / Automatic tool choice |
| `reasoning.defaultEnabled` | sglangDisableThinkingByDefault (inverted) | via `chatTemplateKwargs` | `--default-chat-template-kwargs` | — | tristate · reasoning-tools/advanced | 默认开启思考 / Thinking on by default |
| `speculative.method` | speculativeMode | `--speculative-config.method` | `--speculative-algorithm` | `--spec-type` | enum · speculative/basic | 推测解码方式 / Speculative decoding method |
| `speculative.numTokens` | numSpeculativeTokens | `num_speculative_tokens` | (new) `--speculative-num-draft-tokens` | `--spec-draft-n-max` | int · speculative/advanced | 每步草稿 token 数 / Draft tokens per step |
| `speculative.draftModel` | draftModel, dflash, specDraftModel | `speculative-config.model` | `--speculative-draft-model-path` | `--model-draft` | path · speculative/advanced | 草稿模型 / Draft model |
| `clientPreset` | clientPreset | none (UI hint) | none | none | enum · reasoning-tools/advanced | 客户端预设 / Client preset |
| `apiKey` | apiKey | env `VLLM_API_KEY` | `--api-key` | env `LLAMA_API_KEY` | secret · network-security/basic | 模型直连 API Key / Direct model API key |
| `vllm.gpuMemoryUtilization` | gpuMemoryUtilization | `--gpu-memory-utilization` | — | — | float fraction · memory/basic | 显存预留比例（整卡）/ VRAM reservation (whole GPU) |
| `sglang.memFractionStatic` | gpuMemoryUtilization | — | `--mem-fraction-static` | — | float fraction · memory/basic | 静态显存比例（启动时空闲显存）/ Static memory fraction (of free VRAM at start) |
| `llamacpp.planningUtilization` | gpuMemoryUtilization | — | — | none (planning only) | float · memory/expert | 规划安全余量 / Planning headroom |
| `vllm.maxNumBatchedTokens` | maxNumBatchedTokens | `--max-num-batched-tokens` | — | — | int tokens · capacity/advanced | 每步调度 token 上限 / Tokens scheduled per step |
| `vllm.cpuOffloadGb` | cpuOffloadGb | `--cpu-offload-gb` | — | — | float GiB · memory/expert | 权重卸载到内存（每卡）/ Weight offload to RAM (per GPU) |
| `vllm.kvOffloadingSize` | kvOffloadingSize | `--kv-offloading-size` | — | — | float GiB · memory/expert | KV 卸载到内存（总量）/ KV offload to RAM (total) |
| `vllm.mmProcessorCacheGb` | mmProcessorCacheGb | `--mm-processor-cache-gb` | — | — | float GiB · multimodal/expert | 多模态预处理缓存 / Multimodal preprocessor cache |
| `vllm.loadFormat` | loadFormat | `--load-format` | `--load-format` (recipe) | — (no-op today; warning) | enum · model/expert | 权重加载格式 / Weight load format |
| `vllm.hfConfigPath` | hfConfigPath | `--hf-config-path` | — | — | path · model/expert | HF 配置路径 / HF config path |
| `vllm.languageModelOnly` | languageModelOnly | `--language-model-only` | — | alias → `llamacpp.textOnly` | bool · multimodal/advanced | 仅语言模型 / Language model only |
| `vllm.distributedExecutorBackend` | distributedExecutorBackend | `--distributed-executor-backend` | — | — | enum · parallelism/expert | 分布式执行后端 / Distributed executor |
| `sglang.maxTotalTokens` | sglangMaxTotalTokens | — | `--max-total-tokens` | — | int tokens · memory/advanced | KV 池容量上限 / KV pool size limit |
| `sglang.pageSize` | sglangPageSize | — | `--page-size` | — | int · memory/expert | KV 页大小 / KV page size |
| `sglang.chunkedPrefillSize` | sglangChunkedPrefillSize | — | `--chunked-prefill-size` (platformDefault 8192) | — | int tokens · capacity/advanced | 分块预填充大小 / Chunked prefill size |
| `sglang.attentionBackend` | sglangAttentionBackend | — | `--attention-backend` | — | enum (introspect) · runtime-expert/expert | 注意力后端 / Attention backend |
| `sglang.fp4GemmBackend` | sglangFp4GemmBackend | — | `--fp4-gemm-backend` | — | enum · runtime-expert/expert | NVFP4 GEMM 后端 / NVFP4 GEMM backend |
| `sglang.pleOffloadEmbedding` | sglangPleOffloadEmbedding | — | `--ple-offload-embedding` (feature `pleOffload`) | — | bool · memory/expert | PLE 嵌入放内存 / PLE embeddings in RAM |
| `sglang.linearAttnPrefillBackend`, `…DecodeBackend` | sglangLinearAttn* | — | `--linear-attn-{prefill,decode}-backend` | — | enum · runtime-expert/expert | 线性注意力预填充/解码后端 / Linear-attention prefill/decode backend |
| `sglang.mambaSsmDtype`, `sglang.mambaRadixCacheStrategy`, `sglang.mambaTrackInterval`, `sglang.maxMambaCacheSize` | sglangMamba*, sglangMaxMambaCacheSize | — | `--mamba-ssm-dtype`, `--mamba-radix-cache-strategy`, `--mamba-track-interval`, `--max-mamba-cache-size` | — | enum/int · memory/expert | Mamba 状态精度/缓存策略/跟踪间隔/缓存槽数 / Mamba state dtype / cache strategy / track interval / cache slots |
| `sglang.dsparkBlockSize` | dsparkBlockSize | — | `--speculative-dspark-block-size` | — | int · speculative/expert | DSpark 块大小 / DSpark block size |
| `llamacpp.gpuLayers` | gpuLayers | — | — | `--n-gpu-layers` (+`--fit on` for auto) | enum/int layers · memory/basic | GPU 层数 / Layers on GPU |
| `llamacpp.fitTargetMb`, `llamacpp.fitCtx` | fitTargetMb/fitTargetMib, fitCtx | — | — | `--fit on --fit-target`, `--fit-ctx` | int MiB/tokens · memory/expert | 自动适配余量 / Auto-fit headroom; 自动适配上下文 / Auto-fit context |
| `llamacpp.batchSize`, `llamacpp.ubatchSize` | batchSize, ubatchSize | — | — | `--batch-size`, `--ubatch-size` | int · capacity/advanced | 逻辑批大小 / Logical batch; 物理批大小 / Physical batch |
| `llamacpp.cacheTypeK`, `llamacpp.cacheTypeV` | cacheTypeK/V (kvCacheDtype alias) | — | — | `--cache-type-k/-v` | enum (introspect) · memory/basic | K/V 缓存精度 / K/V cache type |
| `llamacpp.flashAttention` | flashAttention | — | — | `--flash-attn` | enum on/off/auto · memory/advanced | Flash Attention |
| `llamacpp.cacheReuse` | cacheReuse | — | — | `--cache-reuse` (platformDefault 512) | int tokens · memory/expert | KV 平移复用块 / KV shift-reuse chunk |
| `llamacpp.splitMode`, `llamacpp.tensorSplit`, `llamacpp.mainGpu` | multiGpuMode/splitMode, tensorSplit, mainGpu | — | — | `--split-mode`, `--tensor-split`, `--main-gpu` | enum/csv/int · parallelism/advanced | 多卡切分方式/比例/主卡 / Split mode / ratios / main GPU |
| `llamacpp.noMmap`, `llamacpp.noRepack` | noMmap, noRepack | — | — | `--no-mmap`, `--no-repack` | bool · runtime-expert/expert | 禁用 mmap / Disable mmap; 禁用权重重排 / Disable repack |
| `llamacpp.reasoning`, `.reasoningFormat`, `.reasoningEffort`, `.reasoningBudget` | reasoning, reasoningFormat (reasoningParser alias), reasoningEffort, reasoningBudget | — | — | `--reasoning`, `--reasoning-format`, `--reasoning-effort` (feature), `--reasoning-budget` | enum/int · reasoning-tools | 思考执行策略/输出格式/强度/预算 / Reasoning mode / format / effort / budget |
| `llamacpp.textOnly` | textOnlyMode, languageModelOnly | — | — | omit `--mmproj` / `--no-mmproj` | bool (platformDefault true) · multimodal/basic | 仅文本模式 / Text-only mode |
| `llamacpp.mmproj`, `llamacpp.mmprojDevice` | mmproj, mmprojDevice | — | — | `--mmproj`, `--mmproj-device` (feature) | path/enum · multimodal/advanced | 视觉投影器 / Vision projector; 投影器设备 / Projector device |
| `temperature`, `topP`, `topK` | temperature, topP/top_p, topK/top_k | via `vllm.overrideGenerationConfig` | via `chatTemplateKwargs`/none | `--temp`, `--top-p`, `--top-k` | float/int · sampling/advanced | 默认温度 / Default temperature … |

Fields of the forms that are not launch params, and are excluded explicitly in the coverage test:

- Download, search and filter fields: `from`, `to`, `kind`, `keyword`, `source`, `status`, `priority`, `precision`, `modelVersion`, `outputName`, `storageId`, `spec`, `developer`, `external`, `hfToken`, `viewport`.
- Fields that are LaunchRequest top-level rather than params: `model`, `port`, `instanceMode`, `instanceId`, `networkAccess`, `engine`, `runtimeImage`, `gpuDeviceIds`.

The llama `loadFormat` control (`index.html:178-184`) never reached argv. It is accepted with warning `param_ignored` and the console (P7) drops it.

Recipe-only flags become params at level `expert`, emit mode `adapter`, and are settable by users: `vllm.enforceEager`, `vllm.asyncScheduling`, `vllm.attentionBackend`, `vllm.moeBackend`, `vllm.linearBackend`, `generationConfig` (`--generation-config`), `vllm.overrideGenerationConfig`, `chatTemplateKwargs` (vLLM/SGLang `--default-chat-template-kwargs`), `vllm.safetensorsLoadStrategy`, `vllm.reasoningParserPlugin`, `sglang.mambaSchedulerStrategy`, `sglang.disablePrefillCudaGraph`, `sglang.mmFeatureTransport`, `sglang.draftModelQuantization`, `sglang.sleepOnIdle` (platformDefault true, the legacy always-on flag), and `sglang.enableMetrics` (managed, always on).

### 9.4 P0 flag additions (emit mode `catalog`, appended, omitted when unset)

**llama.cpp**

| id | Flag(s) | Validation |
|---|---|---|
| `llamacpp.nCpuMoe` | `--n-cpu-moe N` | int 0–512; conflicts with `llamacpp.cpuMoe` |
| `llamacpp.cpuMoe` | `--cpu-moe` | bool |
| `llamacpp.overrideTensor` | `-ot <regex>=<buffer>` (repeat) | list of `{pattern, buffer}`; pattern ≤ 200 chars; `buffer` ∈ {`CPU`,`CUDA0`…} |
| `llamacpp.threads` / `llamacpp.threadsBatch` | `-t`, `-tb` | int 1–256 |
| `chatTemplate` | `--chat-template-file` | path under storage roots |
| `llamacpp.chatTemplateName` | `--chat-template NAME` | introspected choices |
| `llamacpp.kvUnified` | `--kv-unified` | bool. The help text explains that the pool becomes shared, so ctx-size equals the pool |
| `llamacpp.swaFull` | `--swa-full` | bool |
| `lora.adapters` | `--lora path` or `--lora-scaled path scale` (repeat) | list of `{path, scale?}` ≤ 8 |
| `rope.scaling`, `rope.scale`, `rope.freqBase`, `rope.yarnOrigCtx` | `--rope-scaling`, `--rope-scale`, `--rope-freq-base`, `--yarn-orig-ctx` | enum `none\|linear\|yarn`, floats, int |
| `speculative.method` | `--spec-type` | Choices extended to all values the code accepts: `draft-simple`, `ngram-map-k`, `ngram-map-k4v`, `ngram-mod`, `ngram-cache` |

**vLLM**

| id | Flag(s) | Validation |
|---|---|---|
| `vllm.enforceEager` | `--enforce-eager` | Now user-settable |
| `hfOverrides` | `--hf-overrides <json>` | json ≤ 8 KiB. A helper UI builds `{rope_scaling:{rope_type:"yarn",factor,original_max_position_embeddings}}` |
| `chatTemplate` | `--chat-template` | path |
| `chatTemplateKwargs` | `--default-chat-template-kwargs` | json object |
| `generationConfig` | `--generation-config auto\|vllm\|<path>` | |
| `lora.adapters` | `--enable-lora --lora-modules name=path …` | |
| `vllm.lora.maxLoras`, `vllm.lora.maxRank` | `--max-loras`, `--max-lora-rank` | rank 1–512 |
| `speculative.method` | `--speculative-config` | Adds `eagle3` and `draft_model`, both of which require `speculative.draftModel`. The JSON is `{method, model, num_speculative_tokens}` |
| `role` | `--runner pooling --convert embed\|classify` | `chat\|embedding\|rerank`; `chat` emits nothing |

**SGLang**

| id | Flag(s) | Notes |
|---|---|---|
| `dataParallel` | `--dp-size` | |
| `pipelineParallel` | `--pp-size` | |
| `sglang.epSize` | `--ep-size` | |
| `sglang.maxPrefillTokens` | `--max-prefill-tokens` | |
| `sglang.cudaGraphMaxBs` | `flags:[{flag:"--cuda-graph-max-bs", until:"0.5.20"}, {flag:"--cuda-graph-max-bs-decode", since:"0.5.21"}]` | |
| `speculative.method` | `--speculative-algorithm EAGLE\|EAGLE3\|NEXTN\|STANDALONE\|NGRAM` | Plus `sglang.speculativeNumSteps`, `sglang.speculativeEagleTopk`, `speculative.numTokens` → `--speculative-num-draft-tokens`, `speculative.draftModel` → `--speculative-draft-model-path` |
| `sglang.hicache.enable`, `sglang.hicache.ratio` | `--enable-hierarchical-cache`, `--hicache-ratio` | `warnIf` platform win32: "CPU HiCache 在 WSL 下未验证 / CPU HiCache is unverified under WSL" |
| `role` | `--is-embedding` | |
| `hfOverrides` | `--json-model-override-args` | |

Emission order for the appended block follows catalog `order` and is unit-tested per engine. The legacy builders handle DSPARK through a recipe and Pennyroyal NEXTN through `fixedArgs`. The generic `speculative.method` emission is skipped when a recipe supplies speculative `fixedArgs` or `derived` speculative values, so goldens are unaffected.

### 9.5 Legacy alias table

`legacy-aliases.js` exports:

```js
legacyBodyToRequest(body, { managerId, registry }) → { request: LaunchRequestV2, warnings: FieldError[] }
requestToLegacyRunOptions(plan) → object   // exactly the runOptions shape of today's launch-request.js (R-* goldens)
legacyConfigToValues(config, engineId) → values  // profiles, recent launches, sleep ledger
valuesToLegacyConfig(values, engineId) → config  // GET /api/tools/profiles, /api/recent-launches
```

Rules:

- Empty strings and `"auto"` for parsers map to *unset*. `"none"` (v2 only) means explicitly off.
- `gpuMemoryUtilization` maps by engine (§9.3).
- `kvCacheDtype` on llama maps to both cache types when `cacheTypeK/V` are absent (today's behaviour, `launch-request.js:122-123`).
- Snake-case aliases `top_p`/`top_k`, `fitTargetMib`, `specDraftModel` and `splitMode` are kept.
- A legacy `runtimeImage` equal to a manifest image sets `runtimeId`. The Pennyroyal image additionally sets `recipeId:"pennyroyal-v251"`. Other images become `runtime.imageOverride` (validated by today's `normalizeRuntimeImage`).

---

## 10. Recipes as data

### 10.1 Schema

Files are `manager-core/data/recipes/<recipeId>.json`. Overrides are `<AI_ROOT>/config/recipes/*.json` (owner files and 02's save-as-recipe output). `kind` is `model` or `scenario` (scenario = the non-model builtin profiles of today).

The validator is `engines/recipe-schema.js` (00 §9.10), hand-written like `descriptor-schema.js`:

```js
validateRecipe(obj, { catalogs?, registry?, mode: "bundled"|"override" }) → { ok, errors:[{ path, code, message }] }
// checks: required fields, id pattern, engineId registered, runtime.ref resolvable, every param id in values/derived/locks
// present in the engine catalog (when catalogs are given), expr ASTs valid (expr.js limits), match shape, inputs.env allowlist
```

Recipe loading, 02's save-as-recipe (MOD-17) and the console all use this one function. 02 never validates recipes with `descriptor-schema.js`.

`match` (00 §9.10) is `{ familyId?, contentDigest?, runtimeId?, capabilityIds?, quant?, minComputeCapability?, minGpuMemoryGb? }`:

- `familyId` is a 02 family id; `contentDigest` pins one exact model (02 "this exact model" recipes).
- `runtimeId` is a filter: the recipe is eligible only when the effective runtime has that id. If it is set, `runtime.ref` must resolve to the same runtimeId (load-time check `match_runtime_mismatch`).
- `capabilityIds` is a **deprecated alias** (v1 capability-matrix ids). Bundled recipes use it until ENG-25 migrates them to `familyId`; afterwards it is resolved through 02's capabilityId → familyId alias table in knowledge data, and the loader warns `recipe_match_deprecated`.

```json
{
  "schemaVersion": 1, "asOf": "2026-10-14", "staleAfterDays": 180,
  "id": "qwen38-flashnext-262k", "kind": "model", "status": "verified",
  "label": { "zh": "Qwen3.8 Flash-Next · SGLang · 262K 稳定档", "en": "Qwen3.8 Flash-Next · SGLang · 262K stable" },
  "engineId": "sglang",
  "runtime": { "ref": "sglangFlashNext", "allowOverride": true },
  "match": { "familyId": "qwen3.8-flash-next", "quant": ["modelopt_fp4", "nvfp4", "fp4"], "minComputeCapability": "12.0", "minGpuMemoryGb": 80 },
  "priority": 100,
  "values": {
    "quantization": "modelopt_fp4",
    "sglang.maxTotalTokens": { "expr": { "coalesce": [{ "user": "contextLength" }, 262144] } },
    "sglang.pageSize": 64, "sglang.chunkedPrefillSize": 4096, "sglang.fp4GemmBackend": "flashinfer_cutlass",
    "sglang.attentionBackend": "triton", "sglang.linearAttnPrefillBackend": "triton", "sglang.linearAttnDecodeBackend": "flashinfer",
    "sglang.mambaSsmDtype": "bfloat16", "sglang.mambaRadixCacheStrategy": "extra_buffer", "sglang.mambaTrackInterval": 64,
    "sglang.maxMambaCacheSize": 8
  },
  "derived": {
    "sglang.pleOffloadEmbedding": { "or": [{ "user": "sglang.pleOffloadEmbedding" }, true] },
    "sglang.maxRunningRequests": { "min": [{ "coalesce": [{ "user": "concurrency" }, 1] }, { "max": [1, { "floorDiv": [{ "param": "sglang.maxMambaCacheSize" }, 5] }] }] }
  },
  "locks": [
    { "param": "trustRemoteCode", "value": true, "reason": { "zh": "Qwen3.8 架构需要仓库代码", "en": "Qwen3.8 needs repository code" } },
    { "param": "reasoningParser", "value": "qwen3", "reason": { "zh": "Qwen3.8 已验证解析器", "en": "Validated parser for Qwen3.8" } },
    { "param": "toolCallParser", "value": "qwen3_coder", "reason": { "zh": "Qwen3.8 已验证解析器", "en": "Validated parser for Qwen3.8" } },
    { "param": "autoToolChoice", "value": true, "reason": { "zh": "随解析器开启", "en": "Enabled with the parser" } }
  ],
  "blockIf": [
    { "when": { "notIn": [{ "param": "speculative.method" }, ["off", null]] }, "code": "recipe_requires_speculative_off",
      "message": { "zh": "Qwen3.8 Flash-Next 的已验证 262K SGLang 档当前要求关闭 MTP/DSpark。", "en": "The validated Flash-Next 262K SGLang recipe requires speculative decoding off." } }
  ],
  "validation": [ { "kind": "kvCacheDtypeIn", "values": ["auto"], "severity": "fail", "code": "flashnext_fp8_kv_blocked" } ],
  "fixedArgs": [], "env": {}, "labels": [], "dockerFlags": [], "slots": {},
  "memory": { "policy": "static-fraction-of-free", "calibrate": true, "measuredMiB": null },
  "notes": [ { "zh": "使用 Qwen3.8 Flash-Next day-0 镜像与 SM120 QSA 修复 dac5523d", "en": "uses the Qwen3.8 Flash-Next day-0 image plus full SM120 QSA fix dac5523d" } ],
  "legacy": { "presetId": "qwen3.8-flash-next-sglang-sm120", "presetLabel": "Qwen3.8 Flash-Next / SGLang / SM120", "notesEn": ["…verbatim legacy note strings…"] },
  "profile": {
    "id": "qwen38-flash-next-sglang-262k", "name": "Qwen3.8 Flash-Next SGLang 262K 稳定档", "description": "…verbatim…",
    "requirements": { "minGpuCount": 1, "minSingleGpuMemoryGb": 80 }, "modelDir": "RadixArk-Qwen3.8-Flash-Next-NVFP4",
    "values": { "servedName": "qwen3.8-flash-next", "contextLength": 262144, "concurrency": 1, "sglang.memFractionStatic": 0.995,
                "reasoning.defaultEnabled": false, "clientPreset": "claude-code", "speculative.method": "off", "prefixCaching": true }
  },
  "evidence": { "gpu": "RTX PRO 6000 Blackwell 96 GB", "host": "Windows 11 + Docker Desktop/WSL2", "date": "2026-09", "jobId": null }
}
```

The example shows the post-ENG-25 form; the ENG-6 file carries `"capabilityIds": ["qwen3.8-flash-next"]` instead of `familyId`. `memory.measuredMiB` is a number or an expr; when set, the memory model uses policy `measured` (§12) and 02 seeds it as a synthetic exact calibration record. `legacy.notesEn` keeps today's exact `runtimeNotes` strings so the `metaPatch` goldens hold. `profile.modelDir` is joined to the configured `modelsRoot` at load time. Absolute paths never appear in data, which replaces `default-profiles.js:20`.

### 10.2 Expression language (`expr.js`)

The language is a JSON AST, evaluated purely. Limits: depth ≤ 32, ≤ 512 nodes, and regex patterns ≤ 200 characters (compiled once at load).

Leaf nodes:

- `{"param": id}` reads the effective value at that point of the resolution.
- `{"user": id}` reads the explicit user value or `null`.
- `{"fact": "host.platform"|"host.anySm12x"|"host.maxComputeCap"|"model.capabilityId"|"model.familyId"|"model.quantMethod"|"model.architectures"|"model.nativeMtp.supported"|"runtime.id"|"runtime.compatVersion"|"runtime.features.<k>"|"instance.mode"}`. The schema endpoint returns the evaluated set as `facts` (§21), so the console can evaluate `appliesWhen` itself.
- `{"env": "NAME"}`: NAME must appear in the recipe's `inputs.env` allowlist and match `^(VLLM|SGLANG|LLAMA)_[A-Z0-9_]{1,48}$`.
- `{"const": v}`.

Operators:

- Comparison: `eq`, `ne`, `in`, `notIn`, `gt`, `gte`, `lt`, `lte`.
- Logic: `and`, `or`, `not`, `isSet`, `coalesce`, `if:[c,a,b]`.
- Arithmetic: `min`, `max`, `add`, `sub`, `mul`, `floorDiv`.
- Other: `matches:[s,re]`, `versionGte:[a,b]`, `json:{…}` (builds an object for json params).

Unknown operators fail validation at load. This one language serves recipe values, locks, blocks, catalog rules and `appliesWhen`.

### 10.3 Shipped recipes (legacy preset branch → data)

| recipeId | kind / engine | From | Key content (must reproduce PRE/P goldens) |
|---|---|---|---|
| `pennyroyal-v251` | model / sglang, runtime `sglangPennyroyal` | `pennyroyal.js`, `runtime-command.js:145,168-199,375-386` | `values` = `PENNYROYAL_DEFAULTS`. `locks` = every `pennyroyalOptionErrors` constraint, expressed as `blockIf`. `fixedArgs` = the 25-token NEXTN/FR-Spec tail. `env` = 25 vars. `labels` = 17 `ai.runtime.*` labels, including the `{if:…}` thinking label. `dockerFlags` = `["--init","--ulimit","memlock=-1:-1"]`. `slots`: restart `no`, `hfCacheMount:false`, `modelMountReadOnly:true`, `cacheMount: type=volume,source=pennyroyal-orcarouter-v251-compiler,target=/cache`. `memory.measuredMiB` = the measured formula as an expr (§12). `validation`: tokenizer.json sha256 `0997f4…b9f3` (`server.js:1888-1895`) |
| `qwen38-flashnext-262k` | model / sglang | `server.js:3432-3498` (Flash-Next branch) | As shown in §10.1 |
| `qwen38-sglang` | model / sglang | the non-Flash-Next qwen38 SGLang branch | attention flashinfer, `mambaSchedulerStrategy extra_buffer`, `disablePrefillCudaGraph`, `mmFeatureTransport cpu`, chunked 8192, parser locks, trustRemoteCode |
| `qwen38-dspark-sglang` | model / sglang, `extends: qwen38-sglang` | DSpark branch | speculative DSPARK, draft model resolution (`resolveDsparkDraftModel` becomes the validation rule `draftArchitecture: DSparkDraftModel`, default dir `RadixArk-Qwen3.8-27B-DSpark`), block size `min(32,max(1,…7))` |
| `qwen38-dspark-vllm` | model / vllm, status `blocked` | `server.js:3499-3508` | `blockIf: true` with the verbatim zh reason |
| `qwen38-vllm-mtp3` | model / vllm | the FP8 branch `3509-3530` plus profile `qwen38-vllm-mtp3-quality` | `modelArgStyle: positional`, parser locks |
| `qwen38-vllm-nvfp4` | model / vllm | the NVFP4 sub-branch plus profile `qwen38-nvfp4-capacity` | `disableQuantizationArg`, `disableKvCacheDtypeArg`, `safetensorsLoadStrategy prefetch` |
| `qwen36-nvfp4-vllm` | model / vllm, runtime `vllmQwenMoe` | `3531-3561` | `derived.kvCacheDtype = if(user∉{null,auto}, user, "fp8")`; `vllm.moeBackend = coalesce(env VLLM_QWEN_MOE_BACKEND ∈ allowed, if(host.anySm12x,"flashinfer_b12x","marlin"))`; dtype `bfloat16` only when the backend is b12x; `maxNumBatchedTokens = max(user, 8192)` |
| `qwen36-dense-nvfp4-vllm` | model / vllm, runtime `vllmQwenMoe` | `3562-3586` | `TRITON_ATTN`, disable quant/kv args |
| `diffusiongemma-windows` | model / vllm, runtime `vllmGemma` | `3587-3618` | `blockIf: and(eq(host.platform,"win32"), not(env VLLM_ALLOW_WINDOWS_DIFFUSION_GEMMA truthy))`; `VLLM_USE_V2_MODEL_RUNNER` from env with a platform default; `overrideGenerationConfig` max_new_tokens |
| `llama-muse-glimmer` | model / llamacpp, status `blocked` (retired) | `llama runtime-command.js:36-37,79-81` | Kept so G-L3 holds; the plan returns `ok:false` with blocker `recipe_blocked`, and `/api/start` returns 422 `recipe_blocked` |
| `scenario-*` (vLLM: `blackwell-96gb-256k`, `claude-long-context-64k`, `claude-maximum-context`, `openwebui-chat`, `low-vram-safe`; llama: 5 ids) | scenario / none | `default-profiles.js` | `profile` only, no match and no locks |

`recipes.js`:

```js
loadRecipes() → { recipes[], errors[] }                 // bundled + config/recipes, each through validateRecipe
reloadRecipes() → { ok, count, errors[], digest }        // re-reads config/recipes; atomic swap; in-flight plans keep their snapshot
matchRecipes({ engineId, model, hostFacts, runtime }) → [{ recipe, eligible, score, reasons[] }]
  // score: contentDigest +80, familyId +50 (capabilityIds via alias +50), quant +20, SM ok +10, memory ok +10,
  //        runtime present +5, verified +5; match.runtimeId mismatch → eligible:false
applyRecipe(recipe, userValues, ctx) → { values, provenance, overrides[], blocks[], fixed: {args, env, labels, dockerFlags, slots}, memory, notes }
presetFromRecipe(recipeId, legacyOpts, launch, ctx) → legacy preset object   // shim for resolveVllmRuntimePreset; PRE-* goldens
builtinProfiles(managerId, { modelsRoot }) → legacy profile list          // default-profiles.js shim; same ids/order/configs
```

Recipe selection:

1. An explicit `recipeId` wins.
2. With `recipeId:"none"`, no recipe applies. The plan is labelled `unverified` (custom).
3. Otherwise the top eligible model recipe for the engine is applied automatically, which is today's behaviour (presets are implicit). Applying it is reported in `plan.recipe`.

Scenario recipes never auto-apply.

**Reload.** Managers load recipes at start. After the entry writes `<AI_ROOT>/config/recipes/*.json` (02 MOD-17, console edits), it calls `POST /api/m/:managerId/recipes/reload` for both managers. As a fallback for hand edits, each manager runs `fs.watch` on `config/recipes/` with a 1 s debounce that calls `reloadRecipes()`; a watch error only logs one line. A reload that yields an invalid file keeps the previous good version of that recipe and reports the error in `GET /api/engines` `errors[]`.

---

## 11. `resolveLaunchPlan`

```js
/**
 * @param {LaunchRequestV2} request
 *   { engineId, runtimeId?, runtime?:{imageOverride}, recipeId?,
 *     model:{ ref?, card?, servedName? },        // ref = path; card = 02 ModelCard (required when prospective)
 *     prospective?: boolean,                      // plan without the artifact on disk (00 §9.2)
 *     instance:{ mode:"replace"|"parallel"|"add", id?, port?, networkAccess, gpuIds? },
 *     onConflict?: "fail"|"skip",                 // only with mode "add"; default "fail"
 *     values:{ <paramId>: value | { value, source:"planner" } },
 *     extraArgs?:[], extraEnv?:{}, apiKey?:string, acknowledge?:string[],
 *     expectedPlanHash?: "sha256:…",              // launch only (00 §9.2)
 *     fromLaunchId?: "lch_…", source?: string }   // launch only: start from a stored LaunchStore spec (restore, relaunch)
 * @param {PlanCtx} ctx  { registry, catalogLoader, recipes, adapters, hostFacts, admissionPreview, modelFacts(model),
 *                         imagePresence(image), introspection, memoryModels, calibrationFor, instances, config, launchId? }
 * @returns {LaunchPlan}  00 §4.3 + §9.2: { ok, …, planHash, steps[], blockers[], prospective, catalogVersion, launchId?, legacy:{runOptions, preset} }
 */
function resolveLaunchPlan(request, ctx) {}
```

**Instance modes.** `replace` and `parallel` are today's modes and are explicit user actions. `add` (00 §9.3) is the only mode automatic callers use (restore-models, scheduled or automatic wake): it starts on `instance.id` (default `primary`) only when no running managed container holds that slot, container name or port, and it never stops anything. On a conflict, the plan carries blocker `instance_conflict`; a launch with `onConflict:"skip"` returns 200 `{ok:true, skipped:true, reason:"instance_running", conflict:{instanceId, containerName, model}}` and creates no job, while `"fail"` returns 409 `instance_conflict`.

Algorithm (each step records provenance; `overrides[]` lists every final value that differs from an explicit user or planner value):

1. Resolve and validate the `engineId`, runtime (`runtimeId` / image override) and model facts. Model facts come from the legacy `resolveLaunchModel` plus capability identity until 02 lands, then from the ModelCard (`familyId`, `contentDigest`). With `prospective:true`, `model.card` is required; filesystem checks (existence, GGUF listing, tokenizer hash, draft directory) are skipped and facts come from the card. `model.ref` (the future path) is optional; without it argv uses the placeholder `/models/<pending>`. The plan sets `prospective:true` and warning `plan_prospective`. A launch with `prospective:true` returns 400 `prospective_not_launchable`.
2. Load the catalog (with introspected choices and availability). Validate the shape of `values`. A `{value, source:"planner"}` entry (02 planner output) has user precedence and provenance `planner` (00 §9.10).
3. Select the recipe (§10.3). Evaluate `blockIf` first; a hit is blocker `recipe_blocked`.
4. Merge in precedence order, from highest to lowest:
   - recipe **lock** and recipe **derived**;
   - **model** facts for params flagged `fromModel` (`quantization` from `config.json quant_method`, `server.js:3650-3658`);
   - **user** and **planner**;
   - recipe **values**;
   - **knowledge** (capability-matrix keys allowed by `descriptor.knowledgeKeys`);
   - **platform-default**;
   - **engine-default** (omit).

   Two compatibility notes on this order:
   - **Legacy precedence kept:** today knowledge beats a user parser (`runtime-command.js:46-47`). The new order puts the user first. Because the legacy UI sends `""` (which maps to unset) for "auto/关闭", goldens are unaffected. The change is listed in the commit and in §28.
   - **Lock conflicts:** a v2 user value that contradicts a lock is field error `recipe_locked`. A planner value or a legacy body gets an override with warning `recipe_locked_override` (compat).
5. Evaluate catalog `rules`. Validate `extraArgs`/`extraEnv` (§18). Check availability: a param set on a runtime whose introspection lacks its flag returns `flag_not_in_runtime` (an error for v2, a warning for legacy). Without introspection the state is `unverified` and the flag is allowed.
6. Call `adapter.validate` (generic model checks; recipe `validation` rules run here). Severity `fail` produces errors.
7. Call `adapter.buildLaunch` with `launchId` (the placeholder `lch_pending` in plan-only mode) to produce the command. Secrets are redacted to `<redacted>`. `planHash` = `sha256:` + hex sha256 of the canonical JSON (sorted keys) of `{image, argvRedacted, secretEnvNames, envNames, labels}`, excluding the launch-id and job labels. Identical inputs and host facts give an identical hash.
8. Build `steps[]` (00 §9.2), in execution order:
   - `{kind:"pull", runtimeId, image, required, policy:"auto"|"explicit"}` is always first. `required` is `!present`, or `null` when Docker is unavailable. `policy` follows §5. `required && policy==="explicit"` adds blocker `image_pull_required` with action `{label{zh,en}, apiCall:{method:"POST", path:"/api/runtimes/<runtimeId>/pull", body:{confirm:true}}}`. A missing `localBuild` image adds blocker `runtime_local_build_missing`.
   - `{kind:"replace", containerName, model}` when mode is `replace` and a managed container runs in the slot. Callers (console, 03 Download & Run) confirm against this step; nothing is stopped before the supervisor's checkpoint.
   - `{kind:"start", containerName, port, gpuIds}`.
9. Call `adapter.estimateMemory` (§12), then `admissionPreview(admissionRequest, {mode})`. That is a new side-effect-free `gpuAdmission.evaluate(request)` that reads leases and telemetry, holds no lock, and returns the P0-RT-3 decision fields. It produces `admission {verdict, message, clamped?, requestedMb?, reservedMb?}`; `verdict:"block"` adds blocker `insufficient_vram`.
10. Call `declaredCapabilities`.

`ok` is true when there are no `errors[]` and no `blockers[]`. A blocker is `{code, message{zh,en}, action?}`; a field problem stays in `errors[]` (00 §4.2 shape). **HTTP:** `POST /api/launch/plan` answers 200 for every plan problem and 400 only for a malformed body (not JSON, wrong top-level types, > 1 MiB) (00 §9.2).

`/api/start`, `/api/launch` and `/api/launch/plan` call the same function, which makes the plan equal to the execution:

- `expectedPlanHash`, when present and different from the recomputed hash, returns 409 `{ok:false, code:"plan_changed", error, plan}` before any job, lease or container action.
- Launch maps blockers to the legacy status codes: `recipe_blocked` 422, `image_pull_required` and `runtime_local_build_missing` 409, `experimental_ack_required` 400, `instance_conflict` 409 (or the skip result), field errors 400 with `errors[]`. `insufficient_vram` stays the 409 from `acquire`, as today.
- The supervisor re-runs step 7 after admission when the admitted GPU set differs from the requested one (implicit selection, `launch-request.js:200-206`). That is not a `plan_changed` case: it logs `Plan changed after admission: gpuIds [] → [0]` / `计划在准入后变化：…` and stores both hashes in `job.meta.planHash` and `job.meta.executedPlanHash`.

---

## 12. Memory models (per engine)

`memory-models.js` is the one engine-side estimator (00 §9.1). It owns each engine's memory semantics and the exact gpu-admission request each policy produces. It reads no files: artifact inputs come from the legacy model facts in P1, and from 02 `fit.js` once MOD-9 lands. `fit.js` computes only artifact-side inputs and calls `estimate`.

```js
estimate(engineId, inputs: MemoryInputs) → MemoryEstimate        // dispatches on descriptor.memoryModel.kind
paramsKey(plan) → "262144|1|auto|262144"                            // also exported as engines.paramsKey
MEMORY_CONSTANTS                                                     // activation/graph/non-torch constants (moved from 02 §10.4)
// per-policy functions, exported for tests:
deviceFraction, staticFractionOfFree, ggufEstimate, freeFractionAfterWeights, weightsPlusKv, measured, serverReported
```

```jsonc
// MemoryInputs
{ "values": { "contextLength": 262144, "concurrency": 1, "kvCacheDtype": "auto", "sglang.memFractionStatic": 0.995,
              "sglang.maxTotalTokens": 262144, "sglang.chunkedPrefillSize": 4096 },   // effective plan values, catalog ids
  "artifact": { "weightsMb": 41230, "kvBytesPerToken": 65536, "kvBytesPerTokenHigh": 65536, "stateBytesPerSeq": 153944064,
                "draftMb": 0, "mmprojMb": 0, "hidden": 5120, "vocab": 248320, "confidence": "exact|config|heuristic" },  // 02 fit.js; null if unknown
  "gpus": [ { "id": "0", "totalMb": 97887, "freeMb": 97287, "usedMb": 600 } ],
  "mode": "replace|parallel|add",
  "recipeMemory": { "policy": "measured", "measuredMiB": 88000, "estimatePolicy": "pennyroyal_v251_sm120_tp1_524k_measured" },  // or null
  "calibration": { "exact": true, "measuredMb": 71234, "samples": 2 },   // 02 calibrationFor(); null until MOD-10
  "legacy": { "estimateParallelVram": {} } }                             // llama.cpp until MOD-9
```

`MemoryEstimate` is the 00 §4.3 `memory` block plus `{confidence:"measured"|"estimated"|"fraction-only", admissionRequest, notes[{zh,en}], warnings[]}`. `admissionRequest` is passed verbatim to `gpu-admission.acquire*`, and its field names are gpu-admission's own (P0-RT-3, must-keep per 00 §9.1): `requestedMb`, `requestedFraction`, `requestedFractionOfFree`, `poolCappedTokens`, `estimatePolicy`. Admission's outputs `clamped`, `verdict`, `requestedMb`, `reservedMb` and the `minClampMb` default flow back into plan `admission` unrenamed.

| Engine (`memoryModel.kind`) | Policy | admissionRequest | Breakdown and verdict |
|---|---|---|---|
| vllm (`device-fraction`) | `device-fraction` | `{requestedFraction: gmu, estimatePolicy:"vllm_gpu_memory_utilization"}`, identical to today (R-V goldens) | `R = gmu·total`; `kvPool = R − W − A − G − N` with `MEMORY_CONSTANTS` (A = maxNumBatchedTokens·hidden·24 B + vocab·4·min(concurrency, 256); G = 512 MiB, 0 with enforceEager; N = 768 MiB); `maxFullLengthRequests = ⌊kvPool / perSeq(contextLength)⌋`; error `kv_pool_too_small` if < 1, warning `kv_pool_below_concurrency` if < concurrency. Without artifact inputs the breakdown is today's `core.estimateVllmMemoryPlan` output |
| sglang with recipe `memory.measuredMiB` | `measured` | `{requestedMb: measuredMiB, estimatePolicy: recipe string}`. Pennyroyal: `88000 − floor((524288 − clamp(maxTotalTokens‖contextLength, 262144, 524288)) / 524288 × 6656)`, policy `pennyroyal_v251_sm120_tp1_524k_measured`, unchanged (`pennyroyal.js:9-14`) | `confidence:"measured"` |
| sglang with an exact calibration and `poolCappedTokens > 0` | `measured` | `{requestedMb: ⌈measuredMb × 1.05⌉, poolCappedTokens, estimatePolicy:"sglang_calibrated"}`. No `requestedFractionOfFree`, so the fraction candidate does not dominate | Fits → `ok` instead of P0's clamp `warn`; P0-RT-3 clamp-and-warn still applies when it does not fit |
| sglang otherwise (`static-fraction-of-free`) | `static-fraction-of-free` | `{requestedFractionOfFree: f, poolCappedTokens: sglang.maxTotalTokens ‖ 0, estimatePolicy:"sglang_mem_fraction_static_of_free"}`, byte-equal to what P0-RT-3's `launch-request.js` sends | gpu-admission (P0-RT-3) requests `⌈(free − pending)·f⌉` and admits, clamps (`clamped:true`, `verdict:"warn"`, when `poolCappedTokens > 0` and available ≥ `minClampMb` 4096) or rejects 409 `insufficient_vram` naming `maxFraction`. With artifact inputs the estimate adds an informational breakdown: W + KV(min(maxTotalTokens, pool left by f)) + stateBytesPerSeq × maxMambaCacheSize + activations (chunkedPrefill·hidden·24 B) + 1024 MiB, and warning `sglang_pool_shrinks` when W + KV(maxTotalTokens) > f·free |
| llamacpp (`gguf-estimate`) | `gguf-estimate`; `measured` (peak × 1.03) on an exact calibration | today's `estimateParallelVram` request and fail-closed fallback, unchanged (`llama launch-request.js:204-221`) | After MOD-9: `W_gpu + KV + compute(ubatch·(hidden·24 + vocab·4) + 256 MiB) + mmproj + draft + 512 MiB` (moved from 02 §10.4) gives `requestedMb` |
| lmdeploy, trtllm (`free-fraction-after-weights`) | same | `{requestedMb: ⌈W + f·(free − W)⌉, estimatePolicy:"free_fraction_after_weights"}`; W = artifact weights, else the model directory size | warning `engine_memory_estimate_coarse` |
| tabbyapi (`weights-plus-kv`) | `weights-plus-kv` | `{requestedMb: W + cacheSize·bytesPerToken + 1024, estimatePolicy:"weights_plus_kv"}` | |
| external | `server-reported` | none (no lease) | VRAM from Ollama `/api/ps`, display only |

Notes on the table:

- **Semantics.** SGLang's static region (weights + KV pool) is `f × free-at-start`; activations and CUDA graphs use the rest, and `--max-total-tokens` caps the pool. In replace mode `free` is read after prepare (P0-RT-3).
- **Admission messages** are P0-RT-3's (mode-aware, bilingual, naming the knob and `maxFraction`). ENG-12 only adds `details.knobs:[{param:"sglang.memFractionStatic", suggestion:0.915}, {param:"sglang.maxTotalTokens", suggestion:131072}]` (catalog ids, so the console can focus the field). The `insufficient_vram` code and every P0 field are unchanged.
- **Calibration** (00 §9.1). There is one store, 02's `model-inspector/calibration.js` at `<manager>/data/memory-calibration.json`, keyed by `(contentDigest, runtimeId, paramsKey)`. `paramsKey(plan)` = `${contextLength}|${concurrency}|${kv}|${maxTotalTokens}` over effective values, where `kv` is `kvCacheDtype` (vllm, sglang; `auto` when unset) or `${cacheTypeK}/${cacheTypeV}` (llamacpp; `f16/f16` when unset), and `maxTotalTokens` is `sglang.maxTotalTokens` or `-`. The resolver passes `ctx.calibrationFor(card, engineId, runtimeId, paramsKey)` (02 API; `() => null` until MOD-10) as `inputs.calibration`. LaunchStore holds no calibrations and the supervisor samples nothing: 02 records observations from the `afterReady` hook (§14). `job.meta.observed` is raw evidence only.
- `/api/memory-estimate` keeps its body and response shape (00 §6). ENG-12 routes `engine:"sglang"` bodies through `estimate("sglang", …)` and reports `engine:"sglang"` (today `"vllm"`, `memory-estimate.js:107-109`), unless P0-RT-3 already corrected the label. MOD-9 later puts `fit.js` in front of both wrappers; `FitResult.policy` uses the 00 §4.3 enum.
- **Order:** P0-RT-3 → ENG-12 → MOD-9 admission wiring.

---

## 13. RuntimeHost

```js
/** @interface RuntimeHost */
{
  kind: "docker" | "native" | "external",
  id: "docker-desktop" | "docker-wsl:<distro>" | "native" | "external",
  async ready({ autoStart }) /* → { ok, version, detail, started } */,
  async imagePresent(ref) /* → true | false | null (Docker down); fresh, no snapshot cache */,
  async ensureImage(ref, { platform, policy, onAttempt, onFailure }) /* → { ok, pulled }; --pull never at run time.
        policy "auto": pull when missing (today's pullImageWithRetry); "explicit": never pulls, throws image_pull_required */,
  async pull(ref, { platform, onProgress }) /* → { ok, digest }; used only by the pull job (§21) */,
  renderCommand(cmd) /* pure → { argv, redactedArgv } using _docker-segments.renderRunArgs */,
  async create(cmd, { secretEnv, onRetry }) /* → { name, id }; retries name conflict once; LAN bind fallback to 0.0.0.0 (server.js:5185-5201) */,
  async inspect(name, { fresh }) /* → { exists, running, status, labels, image, imageId, ports, startedAt, exitCode } */,
  async list({ ownerLabelValue }) /* → InstanceState[] (all containers with ai.manager=<value>) */,
  async checkpoint(name, { onEvent }) /* → { commit(), rollback(err) } wraps container-replacement.beginContainerReplacement */,
  async logs(name, { tail, sinceIso }) /* → string (caller redacts) */,
  async stop(name, { reason }) /* docker rm -f, same as today */,
}
```

- **DockerHost** (`hosts/docker.js`) wraps `docker-runtime.js`, `container-replacement.js` and `docker-utils.js`. Docker Desktop and the WSL distro are one implementation with a different `dockerArgsPrefix` and start command.
- Configuration comes from `createDockerHostConfig(env, platformConfig)`. Precedence: `DOCKER_WSL_DISTRO` env > `platform.json docker.wslDistro` (read through OPS-3 `readSection("docker")`; 01 never writes `platform.json`) > Docker Desktop. Validation is `^[A-Za-z0-9._-]+$` (`server.js:103`).
- Both managers use this config. llama-manager gains WSL support. That is a behaviour change only when the variable is set (§28).
- `secretEnv` is passed with P0-RT-1's `buildDockerChildEnv(secretEnv, {viaWsl})` (including the `WSLENV` `NAME/u` entries) to every `docker run` attempt, with `-e NAME` (no value) in argv. Values never reach argv, logs or job meta.
- **NativeProcessHost** (`hosts/native.js`, ENG-22, disabled unless `platform.json engines.native.enabled=true`, read through `readSection("engines")`):
  - It spawns a binary registered in the manifest (`native:{path relative to AI_ROOT, sha256}`, verified before every spawn) with `detached:true` and `windowsHide:true`, and an env allowlist plus secrets.
  - stdout and stderr go to `<manager>/logs/native/<instance>.log`, rotated at 20 MB.
  - The state file is `.runtime/native/<managerId>/<instanceId>.json`: `{pid, startedAt, binarySha256, port, labels{…same keys as docker…}, launchId}`.
  - Adoption on manager start: `process.kill(pid,0)` plus a health GET. Stop uses `terminateProcessTree` (`process-job-runner.js:5`).
  - There is no rename checkpoint. Replace mode stops the old instance, starts the new one, and on failure relaunches the old LaunchSpec. The plan warns `native_no_hot_rollback`.
  - Models survive manager restarts, as containers do.
- **ExternalHost** (`hosts/external.js`): `ready` = GET `{base}/models` (3 s timeout). There is no create. `stop` returns 405 `external_not_managed`.

`runtime-wait.js` gains two optional options. Defaults keep the current behaviour and its test:

- `inferProgress(logText, elapsed, timeout)`, default `inferStartupProgress`;
- `readLogs(containerName, {tail})`, default `docker logs`.

---

## 14. runtime-supervisor (single pipeline shared by both managers)

```js
const supervisor = core.engines.createRuntimeSupervisor({
  managerId: "vllm", ownerLabelValue: CONFIG.managerId, containerBaseName: CONFIG.containerName,
  registry, resolvePlan, adapters, hosts: { docker: dockerHost }, admission: gpuAdmissionController,
  secrets: runtimeApiKeyStore,            // runtime-secret-store.js facade over the single secret store (00 §9.4)
  launchStore, events: managerEventHub,   // the manager's existing /api/events hub; ENT-EV relays jobs + instances
  jobs: { createJob, appendLog, setJobProgress, scheduleJobsSave, finishJob, failJob, assertActive },
  probes: { gpuStatus: getGpuStatus, nvidiaCompatibility: probeNvidiaRuntimeCompatibility, portStatus: checkPortAvailability },
  hooks: { beforeStart: snapshotCurrentStats, afterChange: () => { clearGatewayRuntimeCache(); clearRuntimeInstancesCache(); },
           recordRecentLaunch,
           afterReady: async ({ launchId, plan, paramsKey, runtimeId, contentDigest, logFacts, gpuUsedBeforeMb }) => {},  // 02 MOD-10 wires observations
           classifyFailure: (logText, { engineId, phase }) => null },  // 02 MOD-12 root-cause; default null
  timeouts: { startMs, stallMs: (plan) => plan.recipe?.stallMs ?? 600000, readyProbeMs, probeRequestMs },
});
// → { start({ request|spec, source, job? }), stop(instanceRef, {reason}), relaunch(launchId, {source, mode?, onConflict?}), list(),
//     logs(instanceRef, opts), launchFor(instanceRef), adoptAll(), pullRuntime(runtimeId, {source}) }
```

The pipeline runs serially per queue key: `replace` shares one key, and `parallel` and `add` key on the container name (today's `serializeServeJob`). `assertActive(job)` is checked between all stages.

| # | Stage → lifecycle phase | % | Work | Failure handling |
|---|---|---|---|---|
| 1 | preflight → `pull` | 2–8 | `host.ready({autoStart:true})`; GPU probe; runtime gate generalised from `assessVllmRuntimeCompatibility` (manifest `minimumComputeCapability`, `minimumDriverVersions`, platform), with policy `enforce` for vllm/sglang and `warn` for llamacpp (today llama has no gate, so a hard gate would be a regression risk); port check (both managers' checks unified); recipe `blockIf` and validation; mode `add`: slot, name and port must be free (else skip/fail, §11) | Fail the job. Nothing has been changed |
| 2 | plan → `pull` | 8 | `resolveLaunchPlan` (already done by `/api/start` for the sync 4xx; reused when the spec is unchanged) | 400-class findings are attached |
| 3 | image → `pull` | 8–18 | The plan's `pull` step: `host.ensureImage(image, {policy})` **before** the old model is touched (`server.js:5085-5096`). `auto` pulls a missing image exactly as today; `explicit` never pulls | Fail with `image_pull_required` (explicit) or the pull error; the old model keeps running |
| 4 | admission (+checkpoint in replace) → `admission` | 18–30 | Parallel/add: `admission.acquire` (already done synchronously in `/api/start`, as today). Replace: `admission.acquireAfterPrepare(request, () => host.checkpoint(name))`, keeping the stop-under-lock ordering and `retireLeaseIds` from the old container labels (`server.js:5106-5128`) | Release the lease, delete the new API-key ref, restore the checkpoint |
| 5 | re-plan → `admission` | 30 | When the admitted GPUs differ: re-run the gate in hard mode and rebuild the command (`server.js:5131-5167`) | Rollback |
| 6 | create → `container` | 30–45 | `host.create(cmd)`. `job.meta.launchCommand` = the redacted argv string (`docker …`, `<redacted>`). `runtimeLaunchStarted`/`runtimeContainerCreated` are kept | Rollback |
| 7 | waitReady → `weights`/`kv`/`graphs`/`api` | 45–94 | `runtime-wait` with `inferProgress` built from descriptor `logPhases`; `logFacts` collected. `getContainerStatus` and `fetchServedModels` are always **fresh** (the vLLM fix at `server.js:5228-5232` now also applies to llama, whose cached getters are at `llama server.js:3707-3708`). `stallMs` comes from the recipe (Pennyroyal: 30 min) | Rollback. The job error object is attached (below) |
| 8 | probe → `probe` | 94–99 | `core.probeOpenAiGeneration`, 32 tokens | Rollback |
| 9 | commit → `ready` | 100 | `checkpoint.commit()`; `lease.commit({jobId, containerName})`; remove the previous API-key ref when it differs; LaunchStore status `running` with `logFacts`; `hooks.afterReady(…)` (errors logged, never fatal); `recordRecentLaunch` (legacy view); cache clear; emit an `instances` event | Commit errors are logged and do not fail the job (today's behaviour) |

**Progress and phases.** Job progress gains the additive fields `phase`, `stageKey` and `stageText{zh,en}`, and jobs gain `lifecycle:{phase, phaseHistory:[{phase, at, durationMs}]}` (00 §9.17). The existing zh `stage` strings are kept byte-for-byte where tests or UIs read them. Every progress change and the final state are emitted on the manager event hub as `jobs` events carrying `managerId`; ENT-EV relays them to the entry stream (00 §9.6).

**Job error object** (00 §9.11). A failed serve or pull job keeps its legacy `job.error` string (prefix intact) and gains the additive `job.failure = {code, signatureId, phase, hint:{zh,en}, logExcerpt}`. `phase` is the stage's lifecycle phase. `signatureId`/`hint` come from `hooks.classifyFailure`, which 02 MOD-12 wires to its error-signature matcher over the merged signatures (02 bundled + descriptor `errorSignatures`, §16); until then they are `null` and `code` is the stage code (`image_pull_failed`, `container_create_failed`, `ready_timeout`, `stalled`, `probe_failed`). `logExcerpt` is at most the last 40 lines, at most 4 KiB, passed through `secret-redactor` before storage.

**Pull jobs.** `pullRuntime(runtimeId)` runs job type `image-pull` with id `dl_<base32>` (00 §9.2): stage `pull` only, `host.pull(image, {onProgress})` with layer progress parsed from `docker pull` output into `percent`, progress on `jobs` events. It touches no container and no lease, and a second request for the same image returns the running job.

---

## 15. LaunchStore and launch-id

### 15.1 Store

The store file is `<manager>/logs/launch-store.json`, written atomically with `atomicWriteJsonFile`. It holds at most 300 records. Records referenced by a live container label or a sleep-ledger record are never evicted. The store holds no calibrations (00 §9.1: 02 owns the only calibration store).

```json
{ "schemaVersion": 1, "launches": [ {
  "launchId": "lch_7Q2M4K9XWB3D5F6G8H1J", "managerId": "vllm", "createdAt": "2026-10-20T09:12:03.120Z",
  "source": "ui|api|profile|wake|relaunch|restore|migration|adopted", "status": "planned|starting|running|failed|stopped|sleeping",
  "spec": { "engineId": "sglang", "runtimeId": "sglang@qwen38flashnext-sm120-dac5523d", "recipeId": "qwen38-flashnext-262k",
            "model": { "ref": "C:/fixture/models/RadixArk-Qwen3.8-Flash-Next-NVFP4", "servedName": "qwen3.8-flash-next", "contentDigest": null },
            "instance": { "mode": "replace", "id": "primary", "port": 8000, "networkAccess": "local", "gpuIds": ["0"] },
            "values": { "contextLength": 262144, "concurrency": 1, "sglang.memFractionStatic": 0.995 },
            "extraArgs": [], "extraEnv": {}, "secrets": { "apiKeyRef": "" } },
  "resolved": { "catalogVersion": "2026-10-14+2026-10-14", "planHash": "sha256:…", "imageId": "sha256:…", "paramsKey": "262144|1|auto|-",
                "argvRedacted": ["run", "-d", "…"], "values": { "contextLength": { "value": 262144, "source": "user" } },
                "memory": { "policy": "static-fraction-of-free", "admissionRequestMb": 89321 }, "generationDefaults": {}, "logFacts": {} },
  "jobId": "job_…", "containerName": "vllm-local",
  "history": [ { "at": "…", "event": "started|ready|failed|stopped|slept|woken|adopted", "detail": "" } ]
} ] }
```

The example path above is an example only. Records store whatever path the user chose, and never in tracked files.

Plaintext secrets are never stored; only `apiKeyRef` is: a reference into the single secret store (00 §9.4) through the `runtime-secret-store.js` facade.

API (`launch-store.js`):

```js
createLaunchStore({ file, maxRecords = 300, clock = Date.now, random = crypto.randomBytes })
  .create(spec, { source, jobId }) → record
  .get(launchId) / .list({ limit, status }) / .update(launchId, patch) / .appendEvent(launchId, event)
  .resolveForInstance(instanceState, { jobsLedgerLookup, recentLaunches }) → record | null
  .findWakePlan(instanceState, { jobsLedgerLookup, recentLaunches }) → { config, spec, placement } | null   // §15.3
  .adopt(instanceState, { jobsLedgerLookup, recentLaunches }) → record            // deterministic id, source "adopted"
  .toRecentLaunches(limit) → legacy [{ model, name, launchedAt, config, containerName, instanceMode, instanceId }]
```

**Adoption order** (containers started by old code, which 00 §5 requires to be adopted without restart). Steps 2–4 are P0-RT-2's `findWakePlan` order, unchanged:

1. Use the `ai.manager.launch-id` label.
2. Otherwise match a recent launch whose `containerName` equals the container's name (P0-RT-2 entry field).
3. Otherwise match `entry.model` (the path) against `instance.name` (`models[0].root`), case-insensitively.
4. Otherwise match `entry.config.name` (the served name) against `instance.model`.
5. Otherwise read the `ai.manager.job` label, look up `job.meta` in the jobs ledger (it holds the full normalised config) and convert it with `legacyConfigToValues`.
6. Otherwise rebuild from labels only (`ai.manager.model`, port, gpu-ids, max-model-len, max-num-seqs, engine) and mark it `partial:true`. A partial record is not wakeable: `launch_config_partial` / "该实例缺少完整启动配置，无法自动唤醒 / Instance lacks a complete launch config; cannot auto-wake".

### 15.2 Labels

These labels are added and emitted by every adapter as the last docker flags before `--entrypoint`/image:

- `ai.manager.launch-id`
- `ai.manager.engine-id`
- `ai.manager.recipe` (empty when there is none)
- `ai.manager.runtime-id` (00 §9.9)

Every existing label is unchanged, including P0-RT-1's `ai.manager.api-key-ref`.

### 15.3 Idle unload and wake (ports P0-RT-2 unchanged)

P0-RT-2 fixed wake on the legacy path. ENG-8 moves the same semantics onto LaunchStore without changing them. P0-RT-2's tests (`manager-core/test/idle-unload.test.js` cases, `vllm-manager/test/idle-wake-integration.test.js`, `llama-manager/test/idle-wake-integration.test.js`) stay byte-identical and are part of ENG-8's acceptance.

| P0-RT-2 hook and behaviour | ENG-8 wiring (both managers) |
|---|---|
| `startRuntime: (body) => startRuntimeRequest({ body })` | Unchanged entry point. The body is built from `spec` (v2) plus `instanceMode`, `instanceId`, `apiKey` and overrides, so wake runs the same `/api/start` handler, plan, admission and job flow as a normal start |
| `findWakePlan(instance) → {config, placement:{instanceMode, instanceId, containerName}}` | `launchStore.findWakePlan(instance)`: the launch-id label first, then exactly P0's order (§15.1 steps 2–4), then the jobs-ledger label (step 5). It returns P0's `{config, placement}` (config via `valuesToLegacyConfig`) plus `spec`; partial records return `null` (`launch_config_partial`) |
| `canWake(record)`: 409 `wake_would_replace_running` with `details:{runningModel, runningContainer}` when the placement is replace or unknown and a managed primary runs, or a parallel `containerName` is taken; `wakeOptions.confirmReplace === true` bypasses | Unchanged and must-keep (00 §9.3). Only the explicit UI confirm sends `confirmReplace`. Any automatic wake (scheduler, auto-wake on request) sends `instance.mode:"add"`, `onConflict:"skip"` and never `confirmReplace` |
| `prepareWakeSecrets` (copies the key to ref `wake-<sleepId>` before stop; `api_key_unavailable` skips sleep and keeps the container), `resolveWakeSecrets` (409 `wake_api_key_missing`), `releaseWakeSecrets` (deletes `wake-*` after a successful wake or a forget) | Unchanged. The refs live in the single secret store through the `runtime-secret-store.js` facade (00 §9.4). While sleeping, the LaunchStore record's `spec.secrets.apiKeyRef` is the `wake-<sleepId>` ref id |
| Ledger record fields `placement`, `secretRef`, `hasApiKey`, flat `config` | Kept. ENG-8 adds `launchId` and `spec`; old controllers still read `config` |
| `POST /api/idle-unload/:id/wake {confirmReplace?}`; error `{ok:false, error, code, details}` | Unchanged. The id is the sleep record id `slp_…`, which instances expose as `sleep.id` (§16) |

`listInstances` returns `launchConfig: launchStore.resolveForInstance(instance)?.spec ?? null`, so sleeping keeps working for containers without the new labels (adoption via §15.1).

---

## 16. Observability data and per-instance views

### 16.1 Metrics (`engines/metrics.js`, the only parser; 00 §9.12)

```js
parsePrometheus(text) → { samples:[{ name, labels, value }], types:{ <family>: "counter"|"gauge"|"histogram"|"untyped" } }  // text format 0.0.4, ≤ 4 MiB, tolerant
mapPrometheus(engineId, parsed) → { models:[CanonicalModelMetrics], unsupported:[path] }   // cumulative; used by the 04 collector
summarize(mapped, { previous? }) → CanonicalMetrics                                        // per instance; histograms → {avg, p50, p95, count}
deltaCumulative(prevHistogram, curHistogram) / quantile(histogram, q)                       // helpers shared with 04
```

`CanonicalModelMetrics` is cumulative and uses the canonical camelCase keys in both outputs:

```jsonc
{ "model": "qwen3.8-flash",
  "counters": { "promptTokensTotal": 1203345, "generationTokensTotal": 402211, "cachedPromptTokensTotal": 803000, "requestsTotal": 912,
                "requestsByFinishReason": { "stop": 880, "length": 21, "abort": 9, "error": 2 },
                "prefixQueriesTotal": 1203345, "prefixHitsTotal": 803000, "preemptionsTotal": 0,
                "specDraftTokensTotal": 0, "specAcceptedTokensTotal": 0, "specDraftsTotal": 0 },
  "gauges": { "requestsRunning": 1, "requestsWaiting": 0, "kvUsageRatio": 0.31, "kvCapacityTokens": 262144, "specAcceptRate": null, "genThroughputTps": null },
  "histograms": { "ttftSeconds": { "le": [0.001, 0.005, "…", "+Inf"], "counts": [0, 0, "…", 912], "sum": 402.1, "count": 912 },
                  "itlSeconds": {}, "tpotSeconds": {}, "e2eSeconds": {}, "queueSeconds": {} } }
```

- `CanonicalMetrics` (from `summarize`) is the flat per-instance view: counters and gauges summed over models, histograms as `{avg, p50, p95, count}`. With `previous`, percentiles come from `deltaCumulative`; otherwise they are since process start.
- Descriptor `metricsMap.map` gives ordered sources per canonical key: `[{name, kind:"counter"|"gauge"|"histogram", scale?, label?}]`. The first present source wins. `kind` is `histogram` everywhere; the descriptor validator rejects any other spelling. Labels other than `model_name` and `le` are summed. A canonical key with no present source is listed in `unsupported` as `counters.<k>`, `gauges.<k>` or `histograms.<k>`.
- The seed maps are taken from the names the managers use today (`vllm-manager/server.js:4347-4515`, `llama-manager/server.js:3053-3163`). For example `kvUsageRatio`: vllm `vllm:kv_cache_usage_perc`; sglang `sglang:token_usage` then `sglang:full_token_usage`; llamacpp `llamacpp:kv_cache_usage_ratio`, with the fallback `derive:"busySlots/nSlots"` from `/slots`. llama.cpp `cachedPromptTokensTotal` comes from the cumulative totals of `cache-hit-tracker`.
- `format:"json"` engines (TRT-LLM) implement `adapter.mapMetrics` with `{pick:"last.kvCacheStats.usedNumBlocks"}` and `{ratio:[a,b]}` sources and return the same shape.
- `buildModelStats` stays the `/api/stats` facade (D7), including P0-RT-5's speed fields. A cross-check test asserts that canonical values equal `buildModelStats` values on the recorded fixtures.

**Route** `GET /api/instances/:id/metrics` in `engines/routes.js` is the only metrics route (04 removes its `runtime-routes.js` variant). 07 reads `metrics`; the 04 collector reads `raw` and `runtimeKey`.

```json
{ "ok": true, "fleetId": "vllm:primary", "managerId": "vllm", "instanceId": "primary", "engineId": "sglang",
  "runtimeId": "sglang@0.5.17", "launchId": "lch_…", "runtimeKey": "sglang:3f2a9c:1760400000", "processStartSeconds": 1760400000,
  "scrapedAt": "2026-10-14T08:00:10.004Z", "scrapeOk": true, "errorCode": null,
  "metrics": { "promptTokensTotal": 1203345, "kvUsageRatio": 0.31, "ttftSeconds": { "avg": 0.44, "p50": 0.31, "p95": 1.2, "count": 912 } },
  "raw": { "models": [ { "model": "qwen3.8-flash", "counters": {}, "gauges": {}, "histograms": {} } ] },
  "facts": { "kvTokens": 262144, "maxConcurrency": 1.0, "weightsGiB": 38.2 },
  "unsupported": ["histograms.queueSeconds"] }
```

- The route never scrapes on the request path. It returns the latest snapshot from a per-manager sampler (`createInstanceMetricsSampler`: every 10 s per `ready` instance, 3 s timeout, at most 4 scrapes in parallel). 04 §17.1 may retune the cadence. Before the first sample: `scrapeOk:false, errorCode:"no_sample"`. Other `errorCode` values: `timeout`, `http_<status>`, `unsupported_endpoint`, `parse_error`.
- `runtimeKey` = `${engineId}:${containerId first 6}:${processStartSeconds}`. It changes when the container restarts, so collectors reset their deltas.
- The instance id resolves through P0-RT-4's `resolveLogContainer`; an unowned or unknown id is 404 `unknown_instance` without calling Docker.

### 16.2 Log phases and log facts (`log-phases.js`)

`createProgressInferer(descriptor)` and `extractLogFacts(descriptor, logText)`:

- Phase entries are `{match, phase, percent, stageText{zh,en}}`.
- vllm/sglang initially encode **exactly** today's three regexes and stage strings from `runtime-wait.js:277-296`, so `runtime-wait.test.js` passes unchanged. Engine-specific refinements are added after that and are covered by fixture logs:
  - **vLLM.** `Model loading took ([\d.]+) GiB` → weights, fact `weightsGiB`. `Available KV cache memory: ([\d.]+) GiB` → kv, fact `kvGiB`. `GPU KV cache size: ([\d,]+) tokens` → fact `kvTokens`. `Maximum concurrency for ([\d,]+) tokens per request: ([\d.]+)x` → fact `maxConcurrency`. Graph capture → graphs. `Application startup complete` → api.
  - **SGLang.** `Load weight (begin|end)` → weights. `max_total_num_tokens=(\d+)` → kv, fact `kvTokens`. `Capture cuda graph (begin|end)` → graphs. `fired up and ready to roll` → api. Lines containing `server_args=` are filtered out, as today.
  - **llama.cpp.** `load_tensors:` / `offloaded (\d+)/(\d+) layers to GPU` → weights, facts `layersOnGpu`/`layersTotal`. `(CUDA\d+) model buffer size = ([\d.]+) MiB`, `(CUDA\d+) KV buffer size = ([\d.]+) MiB` and `(CUDA\d+) compute buffer size = ([\d.]+) MiB` → facts `modelBufferMiB{dev}`, `kvBufferMiB{dev}`, `computeBufferMiB{dev}`. `server is listening on` → api. HTTP 503 `Loading model` counts as loading (`ready.kind: health-503-loading`).
- `logFacts` cover every regex 02 §10.5 lists, so 02 `observations.js` consumes them and never re-parses logs. Facts are stored in LaunchStore `resolved.logFacts`, delivered through `hooks.afterReady`, and returned as `facts` by the metrics route. The llama facts path (`llama server.js:3197`) stops reading vLLM regexes.

### 16.3 Error signatures (00 §9.11)

- Hint data lives in 02 `manager-core/data/knowledge/error-signatures.json`. Descriptors carry only engine-specific additions in `errorSignatures[]`, in exactly the 02 entry schema (`id`, `stage`, `rootCause`, `regex`, `title`, `explanation`, `suggestions` with catalog param ids); `engines` is implied as `[descriptor.id]`.
- One loader merges both: 02 `model-inspector/knowledge.js` takes `registry.errorSignatureAdditions() → entries[]` as part of the bundled layer, so owner layers can override any entry by id.
- Seed placement: generic entries (CUDA OOM, `address already in use`) are 02 bundled data. Descriptors add `unrecognized arguments: (--\S+)` → `flag_unknown` (vllm, sglang; suggestion kind `introspect`) and the llama.cpp mmproj-missing entry. Today's `logIssueHint`/`buildLogSuggestions` (`server.js:2071`) move to 02 data in MOD-12, not into descriptors.
- The supervisor fills the job error object (§14) through `hooks.classifyFailure`.

### 16.4 Typed `/api/instances` (00 §4.1 and §9.17, additive)

| Field | Source |
|---|---|
| `engineId` | label `engine-id`, else `registry.fromLegacy(label engine)` |
| `engineFamily` | descriptor |
| `runtime` | LaunchStore `resolved` + `runtimeForImage(image)` + `imageId` |
| `recipeId`, `launchId` | labels, else LaunchStore |
| `lifecycle` | container state + in-flight supervisor job (`phase`, `percent`) + `phaseHistory:[{phase, at, durationMs}]` of the launch job + idle-unload sleeping |
| `sleep` | only on sleeping records: `{id:"slp_…", since, wakeable, reason?}` from the idle-unload ledger. Sleeping records appear only with `GET /api/instances?include=sleeping`; without it the list is exactly today's set of containers |
| `capabilities`, `apiSurface` | `declaredCapabilities` stored at plan time. The model-fleet regex stays a labelled fallback (00 §4.1) |
| `vramReservationMb`, `gpuIds` | labels |

Instance discovery uses `registry.hostedBy(managerId)` instead of `["vllm","sglang"].includes(...)` (`server.js:3960,4042`; llama `2807,2887`). Containers with an unknown engine are listed with `engineId:"unknown"` and remain stoppable. Instance changes are emitted as `instances` events on the manager hub (relayed by ENT-EV).

---

## 17. Flag introspection

Introspection runs only on explicit admin action:

- `POST /api/engines/:engineId/runtimes/:runtimeId/introspect`, which creates job type `introspect`;
- or `node scripts/introspect-engine-flags.js <engineId> <runtimeId>`.

Execution:

```
docker run --rm --pull never --network none --memory 4g --cpus 2 --name ai-introspect-<rand8>
  --entrypoint <descriptor.introspection.entrypoint> <image> <descriptor.introspection.argv...>
```

- No GPU, no mounts and no `ai.manager` label, so instance discovery ignores the container. The timeout is 180 s, after which the container is removed with `docker rm -f` by name.
- The image must be present locally; otherwise the error is `runtime_image_missing` with hint "请先拉取镜像 / Pull the image first".
- Parsers (`introspect.js`):
  - `argparse` (vLLM `vllm serve --help=all`, SGLang, LMDeploy, TabbyAPI): `  --flag-a, --alias {c1,c2} …`, `(default: x)`, `--x, --no-x` pairs.
  - `llama-help`: `-c,    --ctx-size N   … (default: 4096)` followed by `(env: LLAMA_ARG_CTX_SIZE)`. The env names feed the secret channel, for example confirming that `LLAMA_API_KEY` is read.
  - `click` (TRT-LLM): `--tp_size INTEGER … [default: 1]`.
- Output goes to the **only** runtime-facts cache (00 §9.11), `engines/runtime-facts.js`, keyed by **image ID** (`docker image inspect --format {{.Id}}`) at `<AI_ROOT>/.runtime/engine-flags/<engineId>/<imageId16>.json`:

  `{schemaVersion:1, engineId, runtimeId, imageId, flags:{capturedAt, argv, rawSha256, flags:[{flag, aliases[], takesValue, valueHint, choices[], default, env, help, group}]} | null, registries:{capturedAt, …02 probe output…} | null}`

  ```js
  runtimeFacts.get(runtimeId) → { engineId, runtimeId, imageId, flags, registries } | null   // exported as engines.runtimeFacts.get
  runtimeFacts.put(runtimeId, section /* "flags" | "registries" */, data) → void          // atomic write; merges by section
  ```

  `get` resolves runtimeId → image → imageId (cached 60 s); when the tag now points at a different image ID, it returns `null`, so stale facts never apply. 02's dry probe (MOD-13) writes the `registries` section through `put` and reads both sections through `get`; there is no `<AI_ROOT>/cache/runtime-facts/` path. Bundled snapshots may be committed to `manager-core/data/launch-params/introspected/<runtimeId>.json` (flags section shape).
- Diff report (`diffFlagSets(a, b, catalog)`):

  `{added[], removed[], renamed:[{from,to,evidence}], choicesChanged:[{flag, added[], removed[]}], defaultsChanged[], catalogMissing[], catalogUnmapped[]}`

  `renamed` is inferred from aliases or help text such as "deprecated, use X". The report is served by `GET /api/engines/:engineId/runtimes/:runtimeId/flags?against=<runtimeId|catalog>`.
- Effects: introspected `choices` populate `choicesFrom:"introspect:<flag>"` enums (parsers, KV dtypes, quantization), replacing the allowlists at `server.js:3128-3192` and `common-utils.js:131-139` for v2 requests. Availability gating applies (§11 step 5). When the introspected tool or reasoning parser flag has `auto` among its choices and as its default, `GET /api/engines` reports `capabilities.autoParsers.tool` (or `.reasoning`) as `"auto"`; otherwise the descriptor value stands.

---

## 18. Secrets, redaction, extraArgs, extraEnv

**Secret channel.** P0-RT-1 already moved the vLLM and llama.cpp API keys and `HF_TOKEN` out of argv (`-e NAME` plus `secretEnv`, passed through `buildDockerChildEnv`). The adapters reproduce that post-P0 shape exactly, and the goldens pin it (`secretEnvNames`, §8).

| Engine | API key | Notes |
|---|---|---|
| vLLM | env `VLLM_API_KEY` via `-e VLLM_API_KEY` | P0-RT-1 |
| llama.cpp | env `LLAMA_API_KEY` | P0-RT-1 (binding verified there); introspected `env:` lines re-confirm it |
| SGLang | `mode:"flag"` | No env support is confirmed. The value stays in argv (P0 open decision O1), but argv is redacted everywhere and log lines are redacted (SGLang dumps `server_args` with `api_key`). Switching to env/file waits for introspection evidence (§28) |
| docker-template engines | per descriptor | `unsupported` forces `host.allowLan=false`, which means a loopback bind and gateway-only access |

Residual exposure: `docker inspect` shows env values to local Docker users. This is documented in the plan's `security` notes. Stored keys (runtime refs, wake refs, external endpoint keys) live only in the single secret store (00 §9.4): runtime and wake refs through the `runtime-secret-store.js` facade, external endpoint keys in namespace `engines.external`.

**Redaction** (00 §9.4). `manager-core/secret-redactor.js` (P0-OBS-1) is the only redactor and `<redacted>` the only marker; there is no `engines/redact.js`.

- The supervisor builds one `createSecretRedactor({ getSecrets })` per manager (the same instance P0-RT-1 passes to the ledger store and `/api/logs`), extended with `LaunchCommand.redactions`.
- It applies to `appendLog`, `job.meta.launchCommand`, `/api/logs`, `/api/instances/:id/logs`, plan `command`, LaunchStore `argvRedacted`, `job.failure.logExcerpt` and error messages.
- The legacy `redactDockerArgs` exports become one-line wrappers over `redactSecrets` with the `<redacted>` marker. The two assertions that check for `***` (`vllm-manager/test/runtime-command.test.js:119`, `llama-manager/test/runtime-command.test.js:151`) flip to `<redacted>` in ENG-15; no other existing assertion changes.
- `scripts/scrub-job-ledgers.js` belongs to P0-OBS-2 (dry run by default, `--apply` to write). ENG-15 only extends its scan set with `<manager>/logs/launch-store.json` and `<AI_ROOT>/.runtime/launch-files/*/` (secret template files must already be gone; a hit is reported). It adds no `--write` or `--dry-run` flag.

**extraArgs** (`extra-args.js#validateExtraArgs(tokens, {catalog, introspected, descriptor, storage})`):

- An argv array with no shell, ≤ 64 tokens, each ≤ 4096 characters, with no NUL or newline.
- `--flag=value` is split for checks and re-emitted as given.
- Each flag must exist in the introspected set. Without introspection only catalog-known flags are allowed (otherwise `extra_arg_unverified`).
- Flags in `descriptor.managedFlags`, and flags owned by a set param (duplicates), are denied with `extra_arg_denied`.
- Values for path-typed flags (`valueHint` contains PATH/FILE, or a catalog param of type path) must resolve under the model storage roots (`modelStorage.resolvePath`) and are rewritten through `toContainerPath`.
- extraArgs are appended last and are visible as `custom` in the plan.

**extraEnv:**

- Names must match `^[A-Z_][A-Z0-9_]{0,63}$` and a prefix in `descriptor.extraEnvAllow`.
- Always denied: `*_API_KEY`, `*TOKEN*`, `HF_*`, `CUDA_VISIBLE_DEVICES`, `NVIDIA_*`, `LD_PRELOAD`, `PYTHONPATH`, `PATH`, `HOME`, `*_PROXY`, and `LLAMA_ARG_{HOST,PORT,API_KEY,ALIAS,MODEL}`.
- Values ≤ 4096 characters with no NUL.
- Recipe env is trusted data and is not subject to this list. Pennyroyal sets `PYTHONPATH`.

Both extraArgs and extraEnv are recorded in LaunchStore and in job meta.

---

## 19. `docker-template` adapter and experimental descriptors

### 19.1 Template grammar (descriptor `template`)

```json
{
  "entrypoint": "lmdeploy",
  "args": [
    "serve", "api_server", "{{model.containerPath}}",
    { "flag": "--server-name", "value": "0.0.0.0" },
    { "flag": "--server-port", "value": "{{host.containerPort}}" },
    { "flag": "--model-name", "value": "{{servedName}}" },
    { "flag": "--session-len", "value": "{{contextLength}}" },
    { "flag": "--max-batch-size", "value": "{{concurrency}}" },
    { "flag": "--tp", "value": "{{tensorParallel}}" },
    { "flag": "--cache-max-entry-count", "value": "{{lmdeploy.cacheMaxEntryCount}}" },
    { "flag": "--backend", "value": "{{lmdeploy.backend}}" },
    { "args": ["--enable-metrics"], "when": { "const": true } },
    { "repeat": "{{lora.adapters}}", "args": ["--adapters", "{{item.name}}={{item.path}}"] }
  ],
  "env": {}, "files": [], "flagFormat": "space"
}
```

- A string item is a literal token, or exactly one `{{name}}` placeholder.
- `{flag, value}` is emitted only when the value is set. `format:"equals"` produces `--flag=value`.
- `{args, when}` is a conditional group (expr). `repeat` iterates a list param.
- Placeholders available:
  - `model.containerPath`, `model.ref`, `servedName`, `host.containerPort`, `gpu.ids`, `gpu.count`, `instance.id`, `file.<id>`, and any catalog param id.
  - GPUStack aliases: `{{model_path}}`, `{{model_name}}`, `{{port}}`, `{{gpu_ids}}`, `{{gpu_count}}`.
- **Security.** A value is always exactly one argv token and is never split or shell-parsed.
  - A string value starting with `-` in a value position is rejected (`template_value_flag_injection`).
  - Path values must be under the storage roots.
  - Unknown placeholders fail descriptor validation at load.
- `files[]`: `{id, target, format:"yaml"|"json"|"text", content:<object with placeholders>, secret:false}`.
  - Files are written to `<AI_ROOT>/.runtime/launch-files/<launchId>/` and mounted read-only.
  - YAML is emitted by a minimal in-house emitter (maps, lists and scalars only, every string quoted).
  - `secret:true` files (TabbyAPI `api_tokens.yml`) get a restrictive ACL via `icacls` on Windows and are deleted on instance stop.

The docker flag segment is generic and follows the legacy vLLM order: `--pull never`, `--name`, `--restart`, labels, `--gpus`, `--ipc`, healthcheck, publish, mounts, env, then the new labels, `--entrypoint` and the image.

### 19.2 Shipped descriptors (status `experimental`, runtimes `unpinned` until the owner pins a digest)

| id | Runtime image (manifest key) | Port | Memory model | Secrets | Notes |
|---|---|---|---|---|---|
| `lmdeploy` | `openmmlab/lmdeploy:v0.18.0` (`lmdeploy`) | 23333 | `free-fraction-after-weights` (`lmdeploy.cacheMaxEntryCount`, default 0.8) | `flag --api-keys` | Prometheus with `--enable-metrics` (names unverified, so the map is empty until a fixture is recorded); SM120 is unverified, so the plan warns `engine_sm120_unverified` |
| `trtllm` | `nvcr.io/nvidia/tensorrt-llm/release:1.3.0rc29` (`trtllm`) | 8000 | `free-fraction-after-weights` (`trtllm.kvCacheFreeGpuMemoryFraction`, default 0.9) | `unsupported`, so loopback only | Args `trtllm-serve {{model}} --host 0.0.0.0 --port … --backend pytorch --tp_size --max_batch_size --max_seq_len --kv_cache_free_gpu_memory_fraction --reasoning_parser --tool_parser --extra_llm_api_options {{file.extra}}`. File `extra.yaml`: `{enable_iter_perf_stats: true, kv_cache_config:{dtype, enable_block_reuse:true}}`. Metrics `format:"json"` |
| `tabbyapi` | `ghcr.io/theroyallab/tabbyapi:cu13` (`tabbyapi`) | 5000 | `weights-plus-kv` (EXL3 dir size + `cache_size` × bytes/token) | `file` (`api_tokens.yml`, secret) | `config.yml` is generated: `network{host,port,disable_auth:false}`, `model{model_dir, model_name, max_seq_len, cache_mode, cache_size, tensor_parallel, gpu_split_auto}`, `draft_model{…}`. Artifact format `exl3`. Readiness via `/health` + `/v1/models`. No metrics, so gateway-side metrics apply (P4) |

All three are `hostManager:"vllm"`. Container names are `${CONFIG.containerName}-${instanceId}`. Parallel instances need an explicit port, as today. A launch requires `acknowledge:["experimental-engine"]`; without it the error is 400 `experimental_ack_required`. These images are never pulled implicitly: their plan `pull` step has policy `explicit`, a missing image is blocker `image_pull_required`, and the pull runs only through `POST /api/runtimes/:runtimeId/pull` with `confirm:true` (§21), behind a confirm in the UI.

---

## 20. `external` adapter (OpenAI-compatible endpoints)

The registry is owned by service-entry: `service-entry/data/external-endpoints.json`. That is runtime state and is excluded from the release.

```json
{ "schemaVersion": 1, "endpoints": [ {
  "endpointId": "ollama-local", "label": "Ollama (this PC)", "kind": "ollama|openai|lmstudio|generic",
  "baseUrl": "http://127.0.0.1:11434/v1", "apiKeyRef": "", "enabled": true,
  "models": { "discover": true, "allow": [], "aliases": { "qwen3": "qwen3:32b" } },
  "capabilities": { "text": true, "vision": false, "tools": true, "reasoning": false, "embedding": false, "rerank": false, "maxContext": null },
  "apiSurface": { "chat": true, "completions": true, "responses": false, "messages": true, "embeddings": true, "rerank": false },
  "routing": { "includeInAuto": false }, "localGpu": true, "createdAt": "2026-10-20T10:00:00.000Z" } ] }
```

- `hosts/external.js` provides:
  - `health(endpoint)`: GET `{base}/models` with a 3 s timeout, every 30 s. For `kind:"ollama"` it also GETs `/api/ps` (size_vram, expires_at).
  - `listModels`, which applies the allow and alias rules.
  - `resolveUpstream(endpoint, path) → {url, headers}`. The header allowlist is `content-type`, `accept` and `x-request-id`. The stored key (secret store namespace `engines.external`, id = `endpointId`; the record keeps only `apiKeyRef`) is added as `authorization: Bearer`. Client auth headers are **never** forwarded.
- Validation:
  - `endpointId` must match `^[a-z][a-z0-9-]{1,31}$`.
  - `baseUrl` must be `http(s)://` with no credentials in the URL.
  - Link-local and metadata ranges (169.254.0.0/16, fe80::/10) and `0.0.0.0` are rejected.
  - Remote `http://` (non-loopback, non-RFC1918) is allowed only with `acknowledge:["plaintext-remote"]`.
  - Registration is admin-only on the ADMIN listener (D8): an owner session or token after 05 PUB-5. LAN and loopback viewers get the redacted read (§21.3).
- Instances use `fleetId external:<endpointId>`, `engineId:"external"`, `runtime.id external@<kind>`, and `lifecycle.state` from health. There is no admission lease and no stop (405).
- Gateway routing for `/gateway/external/<endpointId>/…`, and inclusion in `auto`, are implemented by the gateway owner (P5) on top of `resolveUpstream`.

---

## 21. HTTP APIs

New JSON endpoints use the 00 §4.2 envelope. Writes are admin-only: on the entry through 05's session/token check (today `checkManagementAccess`) behind the management proxy, on the managers through `isLocalRequest`. Every manager route below is reachable from the entry as `/api/m/:managerId/<path without /api>` (00 §5, proxy shipped by ENT-EV, 00 §9.6).

### 21.1 Managers (5177, 5178)

| Method + path | Request | Response |
|---|---|---|
| `GET /api/engines` | — | `{ok, managerId, generatedAt, engines:[{engineId, label, family, adapter, tier, status, hostKinds, artifactFormats, runtimes:[{runtimeId, manifestKey, image, default, present, introspected, features, status, localBuild, pullPolicy}], capabilities (incl. autoParsers{tool,reasoning}), apiSurface, memoryModel:{kind}, health:{host, hostReady, instances}}], errors:[]}`. `present` comes from a cached `docker images` (60 s TTL) and is `null` when Docker is down |
| `POST /api/engines/descriptors/validate` | `{descriptor}` (≤ 256 KiB) | `{ok, errors:[{path, code, message}]}` from `validateDescriptor(obj, {mode:"draft"})`. Side-effect free; writes nothing |
| `GET /api/engines/:engineId/schema?model=&runtime=&recipe=` | — | `{ok, engineId, catalogVersion, runtime:{runtimeId, introspected, introspectedAt, flagCount}, facts:{"host.platform", "host.anySm12x", "host.maxComputeCap", "model.*", "runtime.id", "runtime.compatVersion", "runtime.features.*", "instance.mode"}, groups:[{id,label,order}], params:[ParamView…], recipes:[{id,label,status,eligible,score,reasons,locks,values,profile}], scenarios:[…]}`. ParamView = the §9.2 param + `availability` + effective `choices`. `facts` are the values `appliesWhen` and rules read (§10.2) |
| `POST /api/launch/plan` | LaunchRequestV2 (incl. `prospective`, `model.card`) **or** a legacy `/api/start` body | 200 `LaunchPlan` (00 §4.3 + §9.2: `planHash`, `steps[]`, `blockers[]`, `catalogVersion`, `warnings[]`), `ok:false` with `errors[]`/`blockers[]` for every plan problem; 400 only for a malformed body |
| `POST /api/start` | legacy body or LaunchRequestV2 (+ `expectedPlanHash`, `onConflict`) | 200 `{job, launchId, plan:{planHash, verdict, warnings, overrides}}`, or the `add`/`skip` result `{ok:true, skipped:true, reason, conflict}`. 409 `plan_changed` `{ok:false, code, error, plan}`. Other errors keep the legacy `{error:string, code, details}` and add `ok:false`, `errors[]` and `hint` (status mapping §11) |
| `POST /api/launch` | LaunchRequestV2, or `{fromLaunchId, instance?:{mode, id?}, onConflict?, expectedPlanHash?, source?}` | Same handler and responses as `/api/start`, v2 only (a legacy body → 400 `v2_body_required`). `fromLaunchId` replays the stored spec with the given mode; restore-models uses `{fromLaunchId, instance:{mode:"add"}, onConflict:"skip", source:"restore"}` (00 §9.3) |
| `POST /api/runtimes/:runtimeId/pull` | `{confirm:true}` | 202 `{ok, job:{id:"dl_…", type:"image-pull"}}`; a pull already running for that image returns the same job with `existing:true`. 400 `confirm_required`, 404 `unknown_runtime`, 422 `runtime_local_build` (with the rebuild hint). Never touches containers or leases (§14) |
| `POST /api/recipes/reload` | — | `{ok, count, errors[], digest}` (§10.3) |
| `GET /api/instances[?include=sleeping]` | — | Legacy fields plus the 00 §4.1 / §9.17 fields (§16.4) |
| `GET /api/instances/:id/logs?tail=200&since=ISO` | — | `{ok, instanceId, containerName, text, truncated, redacted:true}` (tail ≤ 5000), built on P0-RT-4's `resolveLogContainer` |
| `GET /api/instances/:id/metrics` | — | §16.1: `{ok, fleetId, managerId, instanceId, engineId, runtimeId, launchId, runtimeKey, processStartSeconds, scrapedAt, scrapeOk, errorCode, metrics, raw, facts, unsupported[]}` |
| `GET /api/instances/:id/launch` | — | `{ok, launch: LaunchStoreRecord (redacted), command:{argv (redacted), docker:"docker run …"}}` |
| `POST /api/instances/:id/relaunch` | `{confirm:true, overrides?:{values}, expectedPlanHash?}` | `{job, launchId}` (new launchId, `source:"relaunch"`, the instance's own mode) |
| `GET /api/logs?instance=<id>&tail=` | — | Unchanged (P0-RT-4) |
| `GET /api/launches?limit=50&status=` / `GET /api/launches/:launchId` | — | LaunchStore records (redacted; effective values with provenance, runtime, recipeId, `resolved.paramsKey`) |
| `POST /api/engines/:engineId/runtimes/:runtimeId/introspect` | `{confirm:true}` | `{job}` |
| `GET /api/engines/:engineId/runtimes/:runtimeId/flags?against=` | — | `{ok, snapshot, diff}` |
| `GET /api/config` | — | Unchanged plus `entryPort` (env `SERVICE_ENTRY_PORT`, else OPS-3 `readSection("listeners").admin.port`, else 5176) (00 §9.17) |
| `GET/POST/DELETE /api/tools/profiles`, `GET /api/recent-launches`, `POST /api/memory-estimate`, `POST /api/idle-unload/:id/wake` | unchanged | Unchanged shapes. Served from recipes/LaunchStore via the alias table (§22); wake per §15.3 |

Example `POST /api/launch/plan` request (v2):

```json
{ "engineId": "sglang", "recipeId": "qwen38-flashnext-262k",
  "model": { "ref": "C:/fixture/models/RadixArk-Qwen3.8-Flash-Next-NVFP4", "servedName": "qwen3.8-flash-next" },
  "instance": { "mode": "replace", "port": 8000, "networkAccess": "local", "gpuIds": ["0"] },
  "values": { "contextLength": 262144, "concurrency": 4, "sglang.memFractionStatic": 0.995, "reasoning.defaultEnabled": false },
  "extraArgs": ["--schedule-policy", "lpm"] }
```

Response excerpt (97887 MiB GPU, 600 MiB used after prepare, maxUtil 0.95, the P0-RT-3 worked example):

```json
{ "ok": true, "engineId": "sglang", "catalogVersion": "2026-10-14+2026-10-14", "planHash": "sha256:9f…", "prospective": false,
  "runtime": { "id": "sglang@qwen38flashnext-sm120-dac5523d", "image": "local/sglang:qwen38flashnext-sm120-dac5523d" },
  "recipe": { "id": "qwen38-flashnext-262k", "status": "verified", "locks": [{ "param": "reasoningParser", "reason": "Validated parser for Qwen3.8" }] },
  "values": { "concurrency": { "value": 4, "source": "user" },
              "sglang.maxRunningRequests": { "value": 1, "source": "recipe", "reason": "Mamba cache 8 → floor(8/5)=1 effective concurrent request" } },
  "overrides": [{ "param": "concurrency", "from": 4, "to": 1, "source": "recipe", "reason": "有效并发受 Mamba cache 限制 / Effective concurrency is limited by the Mamba cache" }],
  "errors": [], "blockers": [], "warnings": [{ "field": "extraArgs", "code": "extra_arg_unverified", "message": "…" }],
  "steps": [ { "kind": "pull", "runtimeId": "sglang@qwen38flashnext-sm120-dac5523d", "image": "local/sglang:qwen38flashnext-sm120-dac5523d", "required": false, "policy": "auto" },
             { "kind": "replace", "containerName": "vllm-local", "model": "qwen3.8-27b" },
             { "kind": "start", "containerName": "vllm-local", "port": 8000, "gpuIds": ["0"] } ],
  "command": { "argv": ["docker", "run", "-d", "--pull", "never", "…", "--entrypoint", "sglang", "local/sglang:qwen38flashnext-sm120-dac5523d", "serve", "…"],
               "env": {}, "labels": { "ai.manager.recipe": "qwen38-flashnext-262k" } },
  "memory": { "perGpuMb": { "0": 96801 }, "breakdown": { "weights": 0, "kv": 0, "activations": 0, "draft": 0, "mmproj": 0, "overhead": 0 },
              "admissionRequestMb": 96801, "kvPoolTokens": 262144, "maxFullLengthRequests": 1, "policy": "static-fraction-of-free", "confidence": "fraction-only",
              "admissionRequest": { "requestedFractionOfFree": 0.995, "poolCappedTokens": 262144, "estimatePolicy": "sglang_mem_fraction_static_of_free" } },
  "admission": { "verdict": "warn", "clamped": true, "requestedMb": 96801, "reservedMb": 89095,
                 "message": "SGLang 静态显存比例按空闲显存折算需要 96801 MiB，超过安全预算 89095 MiB；因 KV 池已限制为 262144 tokens，按 89095 MiB 预留并继续启动。/ SGLang's static memory fraction of free memory would take 96801 MiB, above the safe budget of 89095 MiB. The KV pool is capped at 262144 tokens, so the launch continues with a 89095 MiB reservation." } }
```

### 21.2 Entry (5176)

| Method + path | Behaviour |
|---|---|
| `GET /api/engines` | Aggregates `GET /api/m/:managerId/engines` (manager `/api/engines`) for both managers through ENT-EV's manager client (2 s timeout each; an offline manager is listed in `errors[]`) plus `external:{engineId:"external", endpoints:[…redacted…]}` |
| `GET /api/engines/external/endpoints` | Redacted read for viewers (§21.3), full read (still without key values) for owners |
| `POST /api/engines/external/endpoints` | Body §20 + `apiKey?` (write-only, stored in the secret store) → 201 `{ok, endpoint}` |
| `PATCH /api/engines/external/endpoints/:endpointId` | Partial update |
| `DELETE /api/engines/external/endpoints/:endpointId?confirm=1` | Removes the record and its secret-store entry |
| `POST /api/engines/external/endpoints/:endpointId/test` | GET-only probe → `{ok, latencyMs, models[]}` |

Implemented in `service-entry/lib/engine-routes.js` (C2), mounted with one line in ENT-EV's route-mount table in `service-entry/server.js`.

### 21.3 Viewer-allowlist registrations (00 §9.8)

`engine-routes.js` exports `viewerRoutes` and registers them with `service-entry/lib/viewer-allowlist.js` (05 PUB-5). If ENG-19 lands before PUB-5, PUB-5 registers the exported list; 05's coverage test then fails for any 01 GET route that is neither listed here nor admin-only. Redaction functions are exported from `engine-routes.js` and unit-tested.

| GET route (entry) | Viewer | Redaction |
|---|---|---|
| `/api/engines` | yes | `redactEnginesForViewer`: drop `errors[].file`; external endpoints reduced to `{endpointId, label, kind, enabled, hostClass:"loopback"\|"lan"\|"remote", health}` (no `baseUrl`, no `apiKeyRef`) |
| `/api/engines/external/endpoints` | yes | the same endpoint reduction |
| `/api/m/:managerId/engines` | yes | drop `errors[].file` |
| `/api/m/:managerId/engines/:engineId/schema` | yes | drop `recipes[].profile.modelDir` and path-valued `facts.model.*` |
| `/api/m/:managerId/engines/:engineId/runtimes/:runtimeId/flags` | yes | none |
| `/api/m/:managerId/instances` (incl. `?include=sleeping`) | yes | the existing fleet redaction (model paths → display names) applied to the new fields too |
| `/api/m/:managerId/instances/:id/metrics` | yes | drop path-valued `facts` |
| `/api/m/:managerId/instances/:id/logs`, `/api/m/:managerId/instances/:id/launch`, `/api/m/:managerId/launches`, `/api/m/:managerId/launches/:launchId` | **admin-only** | — (logs, argv and launch records carry paths and prompts) |

Every non-GET route in §21.1 and §21.2 is admin-only (owner session, token, or a `system:*` machine principal after PUB-5; CSRF on browser writes).

---

## 22. Data migrations

| Data | Migration | Rollback safety |
|---|---|---|
| `<manager>/logs/launch-profiles.json` (v1 `{id,name,description,source,updatedAt,config:{flat}}`) | Lazy on read. Entries gain `{schemaVersion:2, engineId, recipeId?, values (sparse, via legacyConfigToValues), catalogVersion}`, and `config` is **kept** and recomputed by `valuesToLegacyConfig` on write. The first write saves `launch-profiles.v1.bak.json` | Old code reads `config` unchanged |
| Builtin profiles (`default-profiles.js` in both managers) | Become `recipes.builtinProfiles(managerId, {modelsRoot})`. Ids, order, names, descriptions, requirements and normalised configs are identical (`default-profiles.test.js` both) | Pure code |
| `<manager>/logs/recent-launches.json` | On first start after upgrade, each entry is imported into LaunchStore as `source:"migration"`. The file keeps being written from `launchStore.toRecentLaunches()` | The file keeps its format |
| Idle-unload sleep ledger | Flat `config` and P0-RT-2's `placement`, `secretRef`, `hasApiKey` are accepted. New records store `{launchId, spec}` and **also** `config` (legacy flat) | The old controller still reads `config` |
| Running containers without new labels | Adopted (§15.1). No relabel and no restart | Labels are untouched |
| `runtime-manifest.json` (bundled and `<AI_ROOT>/config` override) | Additive fields. An override without `engineId` gets it inferred from `baseRuntime` or the key prefix (`sglang*` → sglang, `llama*` → llamacpp, `vllm*` → vllm) | The schema version is unchanged |
| Jobs ledger plaintext keys | Redact-on-load (P0-OBS-1) and the owner-run `scrub-job-ledgers.js` (P0-OBS-2, `--apply`), extended by ENG-15 to `launch-store.json` | Atomic rewrite; no plaintext backup (P0-OBS-2) |
| Runtime key refs in `logs/runtime-secrets.json` | Migrated once into the single secret store by OPS-3; `runtime-secret-store.js` becomes a facade (00 §9.4). 01 code keeps calling the facade, so LaunchStore `apiKeyRef` and the `wake-*` refs stay valid | Owned by OPS-3 |
| Bundled recipes `match.capabilityIds` | ENG-25 rewrites them to `match.familyId` using 02's alias table; `capabilityIds` stays accepted (deprecated) for override files | Old overrides keep matching through the alias |

---

## 23. Console copy (zh / en), the canonical strings used by the APIs above

These strings are the content of the `engines` i18n area, `service-entry/console/i18n/engines/{zh-CN,en-US}.json` (00 §9.16). 07 owns every file under `console/`, so the CON package that renders engine pages creates that area file from this table verbatim; no ENG package edits `console/`. Server-side messages (plan blockers, job `stageText`, `job.failure.hint`) carry the same zh/en pairs inline.

| Key | zh | en |
|---|---|---|
| group.model | 模型与模板 | Model & template |
| group.capacity | 容量与并发 | Capacity & concurrency |
| group.memory | 显存与 KV 缓存 | Memory & KV cache |
| group.parallelism | 多卡与并行 | Multi-GPU & parallelism |
| group.speculative | 推测解码 | Speculative decoding |
| group.reasoning-tools | 思考与工具调用 | Reasoning & tools |
| group.multimodal | 多模态 | Multimodal |
| group.lora | LoRA 适配器 | LoRA adapters |
| group.sampling | 默认采样 | Default sampling |
| group.network-security | 网络与安全 | Network & security |
| group.runtime-expert | 运行时与专家选项 | Runtime & expert |
| phase.pull / admission / container | 拉取镜像 / 显存准入 / 创建容器 | Pulling image / VRAM admission / Creating container |
| phase.weights / kv / graphs | 加载权重 / 分配 KV 缓存 / 捕获 CUDA graphs | Loading weights / Allocating KV cache / Capturing CUDA graphs |
| phase.api / probe / ready | 启动 API 服务 / 生成自检 / 就绪 | Starting API server / Generation self-test / Ready |
| source.user / planner / recipe / model / knowledge / platform-default / engine-default | 你设置 / 规划建议 / 已验证方案 / 模型文件 / 知识库 / 平台默认 / 引擎默认 | You / Planner suggestion / Validated recipe / Model files / Knowledge base / Platform default / Engine default |
| err.unknown_engine | 未知推理引擎：{id} | Unknown inference engine: {id} |
| err.recipe_locked | “{param}” 由已验证方案锁定为 {value}：{reason} | "{param}" is locked to {value} by a validated recipe: {reason} |
| err.recipe_blocked | 该方案在当前环境被阻止：{reason} | This recipe is blocked here: {reason} |
| err.param_not_applicable | {engine} 不使用“{param}”，已忽略 | {engine} does not use "{param}"; ignored |
| err.flag_not_in_runtime | 当前运行时 {runtime} 不支持 {flag} | Runtime {runtime} does not support {flag} |
| err.extra_arg_denied | {flag} 由管理器控制，不能写在额外参数里 | {flag} is managed by the platform and cannot be passed as an extra argument |
| err.path_outside_storage | 路径不在模型存储目录内：{path} | Path is outside the model storage roots: {path} |
| adm.* | (server text) | Admission messages are P0-RT-3's mode-aware bilingual strings from `gpu-admission.js`; the console shows `admission.message` verbatim and turns `details.knobs` into links to the named fields |
| plan.step.pull | 拉取镜像 {image}（{size}） | Pull image {image} ({size}) |
| plan.step.replace | 将停止并替换正在运行的「{model}」 | Will stop and replace the running model "{model}" |
| plan.step.start | 启动 {container}，端口 {port}，GPU {gpus} | Start {container} on port {port}, GPU {gpus} |
| err.image_pull_required | 运行时镜像尚未下载。实验性镜像不会自动拉取，请先点击“拉取镜像”。 | The runtime image is not downloaded. Experimental images are never pulled automatically; choose "Pull image" first. |
| err.runtime_local_build_missing | 本地构建的镜像 {image} 不存在，无法拉取；请按说明重新构建。 | The locally built image {image} is missing and cannot be pulled; rebuild it as described. |
| err.plan_changed | 启动配置在你确认后发生了变化，请重新检查后再启动。 | The launch plan changed after you reviewed it; review it again before starting. |
| err.instance_conflict | 实例 {instance} 正在运行「{model}」，未做任何改动。 | Instance {instance} is already running "{model}"; nothing was changed. |
| launch.skipped | 已跳过：{instance} 已有模型在运行（自动操作从不替换运行中的模型）。 | Skipped: {instance} already runs a model (automatic actions never replace a running model). |
| err.prospective_not_launchable | 模型文件尚未就绪，只能预览计划，不能启动。 | The model files are not in place yet; the plan is a preview and cannot be launched. |
| plan.prospective | 计划基于模型卡生成；文件下载完成后会重新计算。 | Planned from the model card; it is recomputed once the files exist. |
| job.pull.stage | 正在拉取镜像 {image}：{percent}% | Pulling image {image}: {percent}% |
| job.failure.ready_timeout | 模型在规定时间内没有就绪 | The model did not become ready in time |
| job.failure.stalled | 启动日志长时间没有进展 | Startup logs stopped making progress |
| plan.experimental | 实验性引擎：未在本机验证，启动前请确认。 | Experimental engine: not verified on this machine; confirm before starting. |

Param labels and help text live in the catalogs (§9). Rule 7.6 applies: a raw flag is never the label; the flag is shown as secondary monospace text.

---

## 24. Security summary

1. No secrets in argv for vLLM/llama/HF_TOKEN (P0-RT-1, pinned by goldens). One redactor (`secret-redactor.js`, `<redacted>`) covers every log and display path, including `job.failure.logExcerpt`. SGLang's residual risk is documented and redacted.
2. Introspection containers have no network, GPU or mounts, run only on explicit admin action, and never touch running containers or leases.
3. extraArgs and extraEnv go through allowlist/denylist validation, path confinement and duplicate-of-managed denial. There is no shell anywhere: `execFile` plus docker exec form.
4. Template placeholders are token-atomic, values cannot start with `-`, and descriptors are validated at load and by the draft validator.
5. External endpoints: admin-only registration, an SSRF guard, no client-header forwarding, and keys only in the single secret store (`engines.external`).
6. No implicit container stop or removal (00 §9.3). Replace is an explicit user action shown as a plan step; automatic callers use `add` + `skip`; wake keeps 409 `wake_would_replace_running`. Relaunch, introspect and pull need `confirm:true`. Experimental images are never pulled implicitly. Idle unload remains user-enabled policy.
7. Data overrides cannot add tier-1 engines, recipe env is allowlisted through `inputs.env` for reads, and expressions are bounded. Recipes reloaded at runtime pass the same validator; an invalid file never replaces a valid one.
8. Viewer reads go through the 05 viewer allowlist with 01's redaction functions (§21.3); logs, argv and launch records are admin-only.

---

## 25. Testing

All new manager-core tests are top-level `manager-core/test/engines-*.test.js`. Fixtures are under `manager-core/test/fixtures/engines/{goldens,help,metrics,log-samples,model-samples}/` and contain no user paths. No fixture directory is named `logs`, `models` or `cache`, and a fixture whose extension is ignored takes a `.fixture` suffix (`vllm-startup.log.fixture`, `jobs-ledger.fixture.json`) (00 §9.14). ENG-1 runs `git check-ignore` over the fixture tree as part of its acceptance; OPS-2's tracked-fixture check covers later packages.

| Test file | Asserts |
|---|---|
| `engines-golden.test.js` | Adapters reproduce all 49 goldens (§8), including `secretEnvNames` |
| `engines-descriptor-schema.test.js` | Bundled descriptors are valid; override merge by id; an invalid override keeps the bundled one and is reported; tier-1 ids cannot be added by override; metricsMap `kind` other than `counter`/`gauge`/`histogram` rejected; `autoParsers` must be `{tool, reasoning}`; `mode:"draft"` writes nothing |
| `engines-registry.test.js` | `unknown_engine` 400; legacy mapping table §3; `hostedBy`; every key of the bundled JSON manifest maps to exactly one runtimeId (incl. `sglangFlashNextNvme` → `sglang@flashnext-nvme-ple-20260831`); `runtimeForImage` covers every former `knownRuntimeImageMetadata` case (core.test.js:162 parity); pull policy per runtime |
| `engines-param-catalog.test.js` | Every `name="…"` in both manager `index.html` files is mapped or explicitly excluded; zh/en present for every label, summary and help; domIds unique; rules and `appliesWhen` parse; P0 params present with emit mode `catalog`; schema `facts` cover every fact `appliesWhen` reads |
| `engines-expr.test.js` | Operators, limits, env allowlist, regex bound |
| `engines-recipe-schema.test.js` | Every bundled recipe validates; unknown param id, bad expr, `match.runtimeId` vs `runtime.ref` mismatch and unknown `match` keys are rejected; `capabilityIds` accepted with a deprecation warning |
| `engines-recipes.test.js` | `presetFromRecipe` equals PRE-* goldens; `builtinProfiles` equals today's lists; matching scores (contentDigest > familyId > quant); `blockIf`; `reloadRecipes` keeps the last good version of an invalid file |
| `engines-resolve-plan.test.js` | Provenance and precedence (user beats knowledge; planner values carry source `planner`; v2 lock conflict is a field error, planner/legacy conflict an override); alias round trip; `requestToLegacyRunOptions` equals R-*; plan-equals-execution with a fake host; `planHash` stability; `expectedPlanHash` mismatch → 409 `plan_changed` with no job; `prospective` plan without files, and launch refused; `add` + `skip` on an occupied slot → skipped, no job, no stop call; plan problems → HTTP 200 `ok:false`; `steps[]` order and `image_pull_required` blocker for an experimental missing image |
| `engines-memory.test.js` | vLLM admission requests equal the legacy ones; the SGLang `admissionRequest` is byte-equal to P0-RT-3's `launch-request.js` output for the Flash-Next 262K profile; with the real gpu-admission module (temp lease dir) on 97887 MiB / 600 used / maxUtil 0.95: `verdict:"warn"`, `clamped:true`, `requestedMb` 96801, `reservedMb` 89095; without `maxTotalTokens` → 409 `insufficient_vram` with `maxFraction` 0.915 and the replace-mode text; Pennyroyal 88000 (524288 tokens) and 84672 (262144 tokens); an exact calibration gives `measured` and verdict `ok`; `paramsKey` strings for all three engines; `/api/memory-estimate` shape unchanged and `engine:"sglang"` |
| `engines-launch-store.test.js` | Create/get/retention; adoption order (label → containerName → path → served name → ledger meta → partial); deterministic adopted ids; no `calibrations` key; no plaintext secret ever written (grep the file for the fixture key) |
| `engines-supervisor.test.js` | Fake host/admission/jobs: stage order (image before checkpoint; replace acquires after prepare; parallel before); `auto` pulls a missing tier-1 image before the checkpoint, `explicit` fails with `image_pull_required` and never pulls; `add` never calls stop; rollback on create, wait or probe failure releases the lease and deletes the key ref; cancellation; fresh getters; `phaseHistory`; `job.failure` shape with a redacted excerpt; `afterReady` called once and its error ignored; `jobs`/`instances` events emitted; pull job id `dl_…`, no container or lease calls |
| `engines-idle-wake.test.js` | **Integration:** the real idle-unload controller + manager `startRuntimeRequest` + supervisor with fake host. Sleep records the LaunchSpec; wake starts a job with identical plan argv; a legacy flat sleep record wakes; a labelled container resolves by launch-id before P0's matching order. P0-RT-2's own tests run unchanged next to it |
| `engines-docker-host.test.js` | `renderRunArgs`; WSL prefix; `-e NAME` secret env passing through `buildDockerChildEnv` on every attempt; name-conflict retry; LAN fallback; `imagePresent` fresh |
| `engines-introspect.test.js` | Parsers on recorded help fixtures (vLLM argparse, SGLang argparse, llama-server help with `(env: …)`, click); diff report incl. renamed detection |
| `engines-runtime-facts.test.js` | `get`/`put` by section; a changed imageId for the same tag returns `null`; atomic write; 02-shaped `registries` section round-trips |
| `engines-extra-args.test.js` | Managed flag denial, unknown flag, unverified flag, path confinement, env denylist incl. `LLAMA_ARG_PORT` |
| `engines-redaction.test.js` | `server_args=… api_key='sk-…'` redacted to `<redacted>`; launchCommand has no secret; appendLog wrapper redacts; `redactDockerArgs` is the secret-redactor wrapper |
| `engines-template.test.js` | lmdeploy/trtllm/tabbyapi render; injection attempts (`--x` values, unknown placeholder, NUL); YAML emitter; secret file lifecycle |
| `engines-external.test.js` | Validation and SSRF guard; header allowlist; health parsing incl. Ollama `/api/ps`; the key goes to the secret store and never into the endpoints file |
| `engines-metrics.test.js` | `parsePrometheus` on recorded `/metrics` fixtures per engine; `mapPrometheus` cumulative histograms and label summing; `summarize` percentiles; `unsupported` paths; cross-check with `buildModelStats`; the route serves the sampler snapshot without scraping, `runtimeKey` changes on restart, 404 `unknown_instance` |
| `engines-log-phases.test.js` | Phases and facts from recorded log fixtures; legacy three-stage parity; every 02 §10.5 fact present |
| `service-entry/test/engine-routes.test.js` | Aggregation with an offline manager; CRUD admin-only; every `viewerRoutes` entry redacts as §21.3 says; logs/launch routes are not viewer-readable |
| `manager-core/test/no-family-branches.test.js` (ENG-23) | The single D5 grep guard (§26) |

**Existing tests and what happens to them**

- `vllm-manager/test/{runtime-command,pennyroyal,launch-request,default-profiles,model-capabilities,runtime-compatibility}.test.js` and `llama-manager/test/{runtime-command,launch-request,default-profiles,gpu-plan}.test.js` stay green throughout and exercise the thin wrappers and shims. The only edits are the two `***` → `<redacted>` assertions in ENG-15 (§18).
- P0-RT-2's tests (`idle-unload.test.js` cases, both `idle-wake-integration.test.js`) and P0-RT-3's (`gpu-admission.test.js`, `launch-request.test.js` cases) stay byte-identical and are named in the ENG-8 and ENG-12 acceptance.
- `vllm-manager/test/core.test.js` keeps importing `isQwen*`, `resolveVllmRuntimePreset`, `knownRuntimeImageMetadata` and `checkModelCompatibility`. These remain as deprecated wrappers over recipes and the manifest until ENG-23, which moves those assertions to `engines-recipes.test.js` truth tables.
- `manager-core/test/{idle-unload,runtime-wait,gpu-admission,runtime-manifest}.test.js` stay green, with additive cases only.

**Playwright**

- `tests/frontend-smoke.spec.cjs` stays unchanged. The legacy UI keeps every DOM id, and `/api/start` still accepts `{engine, maxNumBatchedTokens}` for sglang (warning only).
- ENG-21 adds `tests/frontend/launch-plan.spec.js`, which OPS-2's glob discovers (00 §9.15); no package edits `package.json` or `test-all.cmd`. It mocks `/api/launch/plan` and asserts:
  - the review dialog shows the steps (pull, replace), command, overrides and memory verdict;
  - a blocker or a `block` verdict disables `#launchConfirmSubmit`; `image_pull_required` shows the pull action;
  - a 409 `plan_changed` returns to the review;
  - the zh/en toggle swaps the copy.

Every package runs `npm test` in the packages it touched, then `test-all.cmd`, and reports exact pass and fail counts (rule 7.2).

---

## 26. Strangler order (every step deployable, all tests green)

| Step | Package | Production behaviour change | Guard |
|---|---|---|---|
| 1 | ENG-1 | none (goldens from the post-P0 head) | 49 goldens on legacy code |
| 2 | ENG-2 | +`GET /api/engines`, +descriptor validate | registry, manifest tests |
| 3 | ENG-3 | +`GET /api/engines/:id/schema` (with `facts`) | catalog coverage |
| 4 | ENG-14 | +`GET /api/instances/:id/metrics`, metrics sampler (early, for 04) | metrics fixtures, `buildModelStats` cross-check |
| 5 | ENG-4 | llama builder → adapter | G-L*, P-L*, llama tests |
| 6 | ENG-5 | vllm/sglang builder → adapters | G-V*, G-S*, P-V*, vllm tests |
| 7 | ENG-6 | presets and builtin profiles from recipe data; recipe validator and reload | PRE-*, P-*, core.test |
| 8 | ENG-7 | `/api/start` via the resolver; +`/api/launch/plan` with steps, blockers and `planHash`; unknown engine → 400 | R-*, all goldens, plan = execution |
| 9 | ENG-8 | +4 labels (golden delta is labels only); LaunchStore; P0-RT-2 wake ported | goldens v2, P0-RT-2 tests, idle integration |
| 10 | ENG-9 | DockerHost behind the existing calls | host tests |
| 11 | ENG-10 | llama `runStartJobOnce` → supervisor (fresh getters fix, phases, job error object) | llama tests, supervisor tests |
| 12 | ENG-26 | +`POST /api/launch`; `add`/`skip`; `expectedPlanHash` → 409 `plan_changed`; prospective plans | resolve-plan and launch tests |
| 13 | ENG-11 | vllm `runStartJobOnce` → supervisor; pull policy and pull job | vllm tests |
| 14 | ENG-12 | P0-RT-3 semantics behind `memoryModel`; calibration read hook; `details.knobs` | memory tests, P0-RT-3 tests |
| 15 | ENG-13 | typed instances, sleeping records, per-instance logs/launch, `entryPort` | instance contract tests |
| 16 | ENG-24 | log phases/facts, descriptor error-signature additions | log fixtures, runtime-wait test |
| 17 | ENG-15 | redaction via secret-redactor, extraArgs/Env, scrub extension | redaction tests (goldens unchanged) |
| 18 | ENG-16 | introspection and runtime facts (admin action) | parser tests |
| 19 | ENG-17 | P0 flags (unset means no argv change) | goldens unchanged + new emission tests |
| 20 | ENG-18 | docker-template engines (experimental) | template tests |
| 21 | ENG-19 | external endpoints and aggregate at the entry | external and entry route tests |
| 22 | ENG-20 | profile/recent migration | migration tests |
| 23 | ENG-21 | legacy UI review shows the plan | Playwright |
| 24 | ENG-22 | native host (off by default) | native tests |
| 25 | ENG-25 | recipe `match` → `familyId` | recipe tests |
| 26 | ENG-23 | delete branches; grep guard | all |

Grep guard (ENG-23): the single test `manager-core/test/no-family-branches.test.js` with the single allowlist `manager-core/test/fixtures/family-branch-allowlist.json` (00 §9.11); each entry carries a reason and an expiry. ENG-23 owns both files. Its patterns are `isQwen3`, `isPennyroyal`, `isDiffusionGemma`, `flashNext`, `museGlimmer`, `=== "sglang"`, `=== "vllm"`, `=== "llama"`, `supportsB10630`. The scope is `manager-core/**/*.js` (excluding `engines/legacy-aliases.js` and `engines/registry.js`), `vllm-manager/{server.js,lib/*.js}` and `llama-manager/{server.js,lib/*.js}`. 02 MOD-21 only appends its name-inference patterns to the same test; its `server.js` deletions run after ENG-23 in the vllm-manager lane.

---

## 27. Contract changes requested

Accepted by 00 §9 (no further action): C1 policy enum (§9.1), C3 `ai.manager.runtime-id` (§9.9), C4 runtimeId/launchId refinements (§9.9), C5 `engineId:"unknown"` (§9.9), C6 plan HTTP 200 (§9.2). Still open:

| # | Change to 00 | Why |
|---|---|---|
| C1b | §4.3 `memory`: add the optional fields `confidence`, `admissionRequest` (gpu-admission field names, §12) and `warnings[]`; `admission` may carry `clamped`, `requestedMb`, `reservedMb` (P0-RT-3). Drop the earlier `ceilingMb` request | The plan must show the exact admission request and P0-RT-3's clamp result without renaming them |
| C2 | §2 layout. `manager-core/engines/`: rename `metrics-map.js` to `metrics.js` (as §9.12 already says); add `index.js`, `expr.js`, `legacy-aliases.js`, `recipes.js`, `recipe-schema.js`, `memory-models.js`, `launch-store.js`, `introspect.js`, `runtime-facts.js`, `extra-args.js`, `routes.js`, `adapters/_docker-segments.js`. Also `service-entry/lib/engine-routes.js`, the runtime state `service-entry/data/external-endpoints.json`, `scripts/capture-engine-goldens.js` and `scripts/introspect-engine-flags.js`. (`engines/redact.js` and an 01-owned `scrub-job-ledgers.js` are withdrawn) | The layout list is incomplete for this scope; all additions are inside listed directories |
| C7 | §9.12 says `metrics.js` is built in "ENG-10". In this spec it is **ENG-14** (ENG-10 is the supervisor and llama cut-over); ENG-14 depends only on ENG-2, so it lands early for 04 | Keeps 01's package ids stable; the dependency 04 needs is ENG-14 |
| C8 | §4.3 / §9.2 / §9.3: LaunchRequestV2 `instance.mode` gains `add`, with top-level `onConflict:"fail"\|"skip"`; the manager gains `POST /api/launch` (v2 only, also `{fromLaunchId, …}`) next to `/api/start`. A skip answers 200 `{ok:true, skipped:true, reason, conflict}` | 00 §9.3 names `mode:'add'`/`onConflict:'skip'` but no endpoint or request field; restore and automatic wake need one |
| C9 | §4.3: add `blockers[]` item shape `{code, message{zh,en}, action?{label{zh,en}, apiCall{method, path, body}}}` and the `steps[]` kinds `replace` and `start` next to `pull` | One shape for the console and 03's confirm flow |
| C10 | §9.11 job error object: name its location `job.failure` (additive; the legacy `job.error` string stays) | The legacy string is read by existing UIs and tests and cannot become an object |
| C11 | §4.1 / §9.17: sleeping records (with `sleep.id`) appear in `GET /api/instances` only with `?include=sleeping` | Adding them unconditionally would change the instance set that service-entry fleet and platform-mcp read today |
| C12 | §7 rule 3 (release lists, `test:frontend-smoke`, explicit `node --check` lists) is superseded by §9.15; mark it so | 01 follows §9.15 and no longer edits those files |

---

## 28. Open decisions for the owner (defaults chosen)

1. **User versus knowledge precedence.** The default is that an explicit user parser beats the capability matrix. Today the matrix wins silently.
2. **Recipe lock strictness.** The default is hard locks for `verified` recipes. "No recipe (custom)" is the escape hatch and is labelled unverified. The alternative is an "unlock with warning" mode.
3. **Native process host** (llama-server.exe, TabbyAPI venv). It ships disabled (ENG-22). Enable it?
4. **Shared Docker daemon.** Should llama-manager follow `DOCKER_WSL_DISTRO` as well? The default is yes, so both managers see the same containers.
5. **SGLang API key.** The default keeps `--api-key` in argv with redaction until introspection proves an env or file path. The alternative is a wrapper entrypoint that reads a mounted secret file, which changes argv.
6. **Experimental engines.** They ship visible with an acknowledgement required and images pulled only on user action. The alternative is shipping them `disabled` until the owner pins digests.
7. **Re-pinning** to vLLM 0.31 / SGLang 0.5.21 / llama b11588 is not part of P1. Once ENG-16 lands it becomes a data change plus an introspection diff. The owner chooses the cadence.
8. **Always-on SGLang flags** (`--sleep-on-idle`, `--chunked-prefill-size 8192`). They are kept for byte identity and shown as platform defaults. Should they be dropped once introspection confirms support on new pins?
9. **llama `--fit-ctx` default.** It is per-slot while `--ctx-size` is the total (`launch-request.js:110-115`). The default keeps it, since G-L1 pins it. Should it be fixed in a deliberate golden update?
10. **Muse Glimmer.** The default keeps the blocked recipe for rollback provenance. Should it be deleted entirely?
11. **Auto-pull for tier-1 image overrides.** Today an env image override (`VLLM_IMAGE`, `SGLANG_IMAGE`, …) is pulled implicitly before the checkpoint, and the default keeps that (`policy:"auto"`). The alternative is `explicit` for any image that is not a pinned manifest entry.

---

## 29. Work packages

Each package is one engineer-agent session in its own worktree off the integration branch. "Tests green" always means the touched packages' `npm test` plus `test-all.cmd`, with exact counts reported. Rows are in implementation order (§26). Cross-spec ids: P0-* (08), OPS-2/OPS-3 (06), ENT-EV (07, 00 §9.6), MOD-* (02). Order constraints owed to other specs: ENG-14 before 04 TEL-7; ENG-12 before 02 MOD-9's admission wiring; ENG-25 before 02 MOD-21; ENG-16 before 02 MOD-13.

| ID | Title | Files touched / created | Depends on | Size | Acceptance |
|---|---|---|---|---|---|
| ENG-1 | Golden fixtures and capture harness | +`scripts/capture-engine-goldens.js`; +`manager-core/test/helpers/engine-golden-stubs.js`; +`manager-core/test/fixtures/engines/goldens/*.json` (49); +`manager-core/test/fixtures/engines/model-samples/*`; +`vllm-manager/test/engines-golden-legacy.test.js`; +`llama-manager/test/engines-golden-legacy.test.js` | P0-RT-1, P0-RT-2, P0-RT-3 (post-P0 merge head) | M | Captured once on the post-P0 merge head (`history[0]` names its short sha); all 49 fixtures pass against the unmodified builders; `secretEnvNames` present for the key cases and no key value in any fixture; `--check` is clean; two captures are byte-identical; a write without `--reason` is refused; `git check-ignore` reports nothing under `fixtures/engines/`; no production file changed; privacy scan passes |
| ENG-2 | Engine registry, descriptor schema and validate route, manifest runtimeIds, `GET /api/engines` | +`manager-core/engines/{index,registry,descriptor-schema,routes}.js`; +`manager-core/data/engines/{vllm,sglang,llamacpp}.json`; `manager-core/data/runtime-manifest.json` (+engineId, compatVersion, features, status; +`vllmQwenMoe`, `vllmGemma`, `sglangPennyroyal`; `sglangFlashNextNvme` annotated); `manager-core/runtime-manifest.js`; `manager-core/index.js` (`core.engines` namespace); route registration in both `server.js` | — | M | `engines-descriptor-schema` and `engines-registry` pass; every key of the bundled JSON manifest maps to one runtimeId; `GET /api/engines` returns 3 engines with runtimeIds `vllm@0.28.0`, `sglang@0.5.17`, `sglang@qwen38flashnext-sm120-dac5523d`, `sglang@pennyroyal-v2.5.1`, `sglang@flashnext-nvme-ple-20260831` (experimental), `llamacpp@b10630`; `capabilities.autoParsers` is `{tool, reasoning}`; `POST /api/engines/descriptors/validate` reports errors for a bad draft and writes nothing; a bad override is reported, not fatal; all existing tests green |
| ENG-3 | Parameter catalog, legacy alias table, schema endpoint with facts | +`manager-core/engines/{param-catalog,legacy-aliases,expr}.js`; +`manager-core/data/launch-params/{common,vllm,sglang,llamacpp}.json`; `engines/routes.js` | ENG-2 | L | Catalog coverage test passes (every UI field mapped or excluded); all labels, summaries and help are zh+en; `engines-expr` passes; `GET /api/engines/sglang/schema` returns groups, params with legacy domIds, availability `unverified` and `facts` covering every fact `appliesWhen` reads; alias round trip `legacyConfig → values → legacyConfig` is identity for every builtin profile config |
| ENG-14 | Metrics module and per-instance metrics route | +`manager-core/engines/metrics.js` (`parsePrometheus`, `mapPrometheus`, `summarize`, `deltaCumulative`, `quantile`, `createInstanceMetricsSampler`); descriptor `metricsMap` seed data (kind `histogram`); `engines/routes.js` (`GET /api/instances/:id/metrics`); both `server.js` (start the sampler); +`manager-core/test/fixtures/engines/metrics/*.prom` | ENG-2, P0-RT-4 | M | `engines-metrics` passes; the three functions are on `core.engines.metrics`; the route returns §16.1 with `metrics` (summarized) and `raw` (cumulative), both with camelCase keys, plus `runtimeKey`, `scrapedAt`, `unsupported[]`; a spy proves no scrape on the request path; an unknown id gives 404 `unknown_instance` without Docker; `/api/stats` is unchanged (P0-RT-5 fields included); the `buildModelStats` cross-check passes |
| ENG-4 | llamacpp adapter | +`manager-core/engines/adapters/{llamacpp,_docker-segments}.js`; `llama-manager/lib/runtime-command.js` → wrapper | ENG-1, ENG-2 | M | G-L1..3 and P-L01..05 pass through the adapter (`engines-golden`) **and** the legacy golden test, including `secretEnvNames`; `supportsB10630Controls` is replaced by `runtime.features`; the llama test suite is green |
| ENG-5 | vllm and sglang adapters | +`manager-core/engines/adapters/{vllm,sglang}.js`; `vllm-manager/lib/runtime-command.js` → wrapper (Pennyroyal still from `pennyroyal.js` via a preset passthrough) | ENG-1, ENG-2 | L | G-V*, G-S*, P-V* pass through the adapters and the legacy golden test; `runtime-command.test.js` and `pennyroyal.test.js` are unchanged and green; `normalizeRuntimeEngine` delegates to the registry with legacy fallback |
| ENG-6 | Recipes as data, recipe validator, reload | +`manager-core/engines/{recipes,recipe-schema}.js`; +`manager-core/data/recipes/*.json` (11 model + 10 scenario, `match.capabilityIds`); `engines/routes.js` (`POST /api/recipes/reload`) and the debounced `fs.watch` fallback; `vllm-manager/server.js` (`resolveVllmRuntimePreset` → `presetFromRecipe`, `knownRuntimeImageMetadata` → manifest); `vllm-manager/lib/{pennyroyal,default-profiles}.js` and `llama-manager/lib/default-profiles.js` → loaders; `checkModelCompatibility` Pennyroyal/Flash-Next branches → recipe validation | ENG-3, ENG-5 | L | PRE-01..19 and P-V/P-L goldens pass; `default-profiles.test.js` (both) and `core.test.js` pass unchanged; every bundled recipe passes `validateRecipe`; `engines-recipe-schema` and `engines-recipes` pass (reload keeps the last good version of an invalid file; watcher debounce with a fake watcher); no absolute paths in recipe data; the env/host-fact inputs (`VLLM_QWEN_MOE_BACKEND`, `VLLM_GEMMA_*`, SM12x, platform) reproduce today's outputs; `core.engines.recipeSchema.validateRecipe` is exported |
| ENG-7 | `resolveLaunchPlan`, `POST /api/launch/plan`, `/api/start` via the resolver | +`manager-core/engines/resolve-launch-plan.js`; `gpu-admission.js` (+`evaluate()` side-effect free; no field renames); both `lib/launch-request.js` (alias → resolver → `requestToLegacyRunOptions`); `engines/routes.js` | ENG-3, ENG-4, ENG-6 | L | R-V1..3 and R-L1..2 pass (job meta, runOptions, admission request and call order identical); plan = execution; unknown `engine` → 400 `unknown_engine`; every plan problem answers HTTP 200 `ok:false` (lock conflict as field error, `recipe_blocked` as blocker); `/api/start`: v2 lock conflict → 400 `recipe_locked`, legacy conflict → override + warning, error shape legacy plus `errors[]`; `steps[]` order and `image_pull_required` for an explicit-policy missing image (fake presence); `planHash` stable; all goldens unchanged |
| ENG-8 | LaunchStore, new labels, P0-RT-2 wake ported | +`manager-core/engines/launch-store.js`; adapters (+4 labels); both `server.js` (idle-unload wiring: `findWakePlan`, `canWake`, wake-secret hooks over LaunchStore; `recordRecentLaunch`); goldens regenerated with `--reason "launch-id labels"` | ENG-7, P0-RT-2 | M | The golden diff contains only the four label pairs; P0-RT-2's tests (`idle-unload.test.js` P0 cases, both `idle-wake-integration.test.js`) pass byte-identical; 409 `wake_would_replace_running` with `details{runningModel, runningContainer}` and the `confirmReplace` bypass are unchanged; `wake-*` refs are created before stop, resolved on wake and released after success or forget, through the `runtime-secret-store.js` facade; `api_key_unavailable` skips sleep without stopping; `engines-launch-store` and `engines-idle-wake` pass; adoption follows §15.1; `/api/recent-launches` output is unchanged for existing data; no plaintext key and no `calibrations` key in the store |
| ENG-9 | DockerHost (Desktop + WSL) and host-neutral wait hooks | +`manager-core/engines/hosts/docker.js` (`imagePresent`, `ensureImage({policy})`, `pull`, `buildDockerChildEnv` reuse); `runtime-wait.js` (+`inferProgress`, `readLogs` options); `createDockerHostConfig` used by both managers (reads `readSection("docker")`) | ENG-2, OPS-3 | M | `engines-docker-host` passes (incl. env on every retry and `WSLENV`); `runtime-wait.test.js` unchanged and green; llama honours `DOCKER_WSL_DISTRO` (unit test with fake execFile); no behaviour change without the env |
| ENG-10 | runtime-supervisor and llama-manager cut-over | +`manager-core/engines/runtime-supervisor.js` (stages, `phaseHistory`, `job.failure`, hooks `afterReady`/`classifyFailure`, `jobs`/`instances` events on the manager hub); `llama-manager/server.js` (`runStartJob`/`runStartJobOnce` → supervisor; fresh getters) | ENG-8, ENG-9 | L | `engines-supervisor` passes (stage order, rollback, cancellation, `add` never stops, job error object with a redacted excerpt, `afterReady` once with errors ignored, events carry `managerId`); the llama test suite is green; the llama start uses fresh container and served-model getters; the runtime gate runs in `warn` mode for llama |
| ENG-26 | Launch API extensions: `/api/launch`, `add`/`skip`, `expectedPlanHash`, prospective plans, planner provenance | `engines/resolve-launch-plan.js`; `engines/routes.js` (`POST /api/launch`); both `lib/launch-request.js` (`expectedPlanHash`, `onConflict`, `fromLaunchId`); supervisor preflight for `add` | ENG-8, ENG-10 | M | `expectedPlanHash` mismatch → 409 `plan_changed` with the new plan and no job, lease or Docker call; `add` + `skip` on an occupied slot → 200 `skipped:true`, no job, no stop (call-log assertion); `add` + `fail` → 409 `instance_conflict`; `{fromLaunchId, instance:{mode:"add"}, onConflict:"skip"}` replays a stored spec; a `prospective` plan with a card and no files returns `prospective:true` and launching it is 400 `prospective_not_launchable`; `{value, source:"planner"}` yields provenance `planner`; a legacy body to `/api/launch` → 400 `v2_body_required` |
| ENG-11 | vllm-manager cut-over; pull policy and pull job | `vllm-manager/server.js` (lines 4929-5267 replaced by supervisor calls; the runtime gate generalised from `runtime-compatibility.js`); supervisor `pullRuntime`; `engines/routes.js` (`POST /api/runtimes/:runtimeId/pull`, both managers) | ENG-10 | L | The vllm test suite is green (incl. `runtime-compatibility.test.js`, `launch-request.test.js`); a missing tier-1 image is pulled before the checkpoint exactly as today (log line kept); an explicit-policy image fails with `image_pull_required` and is never pulled; the pull route enforces `confirm`, returns a `dl_` job, reports progress on `jobs` events, returns `existing:true` for a concurrent request, 422 for a local build, and makes no container or lease call; replace admission happens after prepare; Pennyroyal stall timeout is 30 min from the recipe; `server.js` shrinks by ≥ 300 lines |
| ENG-12 | Memory models: P0-RT-3 behind `memoryModel`, calibration read hook, knob details | +`manager-core/engines/memory-models.js` (`estimate`, `paramsKey`, `MEMORY_CONSTANTS`); adapters `estimateMemory`; `resolve-launch-plan.js` (`calibrationFor`, default `() => null`); `gpu-admission.js` (additive `details.knobs` only); `vllm-manager/lib/launch-request.js` (SGLang request from the memory model); `vllm-manager/lib/memory-estimate.js` (sglang through `estimate`, engine label) | ENG-7, P0-RT-3 | M | `engines-memory` passes (all §25 cases); P0-RT-3's tests in `gpu-admission.test.js` and `launch-request.test.js` are unchanged and green; the SGLang admission request is byte-equal to P0-RT-3's; a grep finds no `requestedMbCeiling`, `requestedMbFloor` or `sglang_bounded_up_to_budget`; `core.engines.memoryModels.estimate` and `core.engines.paramsKey` are exported for 02; `/api/memory-estimate` shape unchanged |
| ENG-13 | Typed instances, sleeping records, per-instance logs/launch/relaunch, `entryPort` | Both `server.js` (instance lists via `registry.hostedBy`; `?include=sleeping`; new routes); `engines/routes.js`; `manager-core/manager-routes.js` (`/api/config` `entryPort`) | ENG-8, ENG-10, OPS-3 | M | Instance contract test: 00 §4.1/§9.17 fields present, legacy fields unchanged, `lifecycle.phaseHistory` present; without `include=sleeping` the list deep-equals today's for a fixture, with it sleeping records carry `sleep.id` `slp_…`; an unknown-engine container is listed and stoppable; `/api/instances/:id/logs` uses P0-RT-4's resolver and is redacted; `relaunch` requires `confirm` and honours `expectedPlanHash`; `/api/config.entryPort` follows env > config > 5176; service-entry `model-fleet.test.js` green |
| ENG-24 | Log phases, log facts, engine error-signature additions | +`manager-core/engines/log-phases.js` (`createProgressInferer`, `extractLogFacts`); descriptor `logPhases`/`logFacts`/`errorSignatures` data; `registry.errorSignatureAdditions()`; supervisor `logFacts` capture; `llama-manager/server.js` facts path; +`manager-core/test/fixtures/engines/log-samples/*.log.fixture` | ENG-9, ENG-10 | M | `engines-log-phases` passes; `runtime-wait.test.js` unchanged; llama facts no longer use vLLM regexes; every 02 §10.5 fact is extracted; `resolved.logFacts` is stored and passed to `afterReady` (spy); descriptor `errorSignatures` entries match the 02 entry schema (same fields) and contain no generic entries |
| ENG-15 | Redaction via secret-redactor, validated extraArgs/extraEnv, scrub extension | +`manager-core/engines/extra-args.js`; both `lib/runtime-command.js` (`redactDockerArgs` → `secret-redactor` wrapper); `vllm-manager/test/runtime-command.test.js:119` and `llama-manager/test/runtime-command.test.js:151` (`***` → `<redacted>`); `manager-core/ledger-scrub.js` and `scripts/scrub-job-ledgers.js` (scan set only) | ENG-7, P0-OBS-1, P0-OBS-2 | M | `engines-redaction` and `engines-extra-args` pass; no `engines/redact.js` and no other secret-replacing helper exists (grep); with a fixture key, no job log, ledger, launchCommand, plan, failure excerpt or LaunchStore contains it; goldens unchanged; the scrub script is dry-run by default, writes only with `--apply`, scans `launch-store.json`, and has no `--write` flag; SGLang keeps `--api-key` with redaction |
| ENG-16 | Flag introspection and the runtime-facts cache | +`manager-core/engines/{introspect,runtime-facts}.js`; +`scripts/introspect-engine-flags.js`; routes; help fixtures; `param-catalog.js` availability | ENG-3, ENG-9 | M | `engines-introspect` and `engines-runtime-facts` pass; the cache is keyed by image id and a re-pointed tag returns `null`; `core.engines.runtimeFacts.get` is exported and a `registries` section round-trips; the diff report detects added, removed, renamed and choicesChanged; introspection containers use `--network none`, no GPU, no `ai.manager` label (command-render test); v2 enum validation uses introspected choices when present; `autoParsers` is refined from introspected parser choices |
| ENG-17 | P0 flag additions | `manager-core/data/launch-params/{vllm,sglang,llamacpp}.json`; adapters (appended catalog emission and rules) | ENG-7 | L | All §9.4 params present with zh/en help; emission-order unit tests per engine; rules (`nCpuMoe`⊕`cpuMoe`, eagle3/draft_model need a draft, quantised V needs FA, ubatch ≤ batch) return field errors; all goldens unchanged (new params unset) |
| ENG-18 | docker-template adapter and lmdeploy/trtllm/tabbyapi descriptors | +`manager-core/engines/adapters/docker-template.js`; +`data/engines/{lmdeploy,trtllm,tabbyapi}.json`; +`data/launch-params/{lmdeploy,trtllm,tabbyapi}.json`; manifest entries (`unpinned`); YAML emitter | ENG-11, ENG-15, ENG-16 | L | `engines-template` passes (render, injection rejection, files, secret file lifecycle); vllm-manager lists the three engines as experimental; a launch without the acknowledgement → 400 `experimental_ack_required`; a missing image is blocker `image_pull_required` and is never pulled implicitly; `unsupported`-auth engines are forced to a loopback publish; instances of a template engine appear in `/api/instances` and stop correctly (fake host) |
| ENG-19 | External adapter, entry registry, aggregated `/api/engines`, viewer registrations | +`manager-core/engines/{adapters/external,hosts/external}.js`; +`service-entry/lib/engine-routes.js` (routes, `viewerRoutes`, redaction functions); `service-entry/server.js` (one line in ENT-EV's mount table); +`data/engines/external.json`; +`service-entry/test/engine-routes.test.js` | ENG-2, ENG-15, ENT-EV, OPS-3 | M | `engines-external` and `engine-routes` pass (SSRF guard, header allowlist, Ollama `/api/ps`); the aggregate calls `/api/m/:managerId/engines` and lists an offline manager in `errors[]`; CRUD is admin-only; every §21.3 viewer redaction holds and logs/launch routes are not viewer-readable; the key lives only in the secret store namespace `engines.external`; service-entry tests green |
| ENG-20 | Profiles and recent-launches migration | `manager-core/engines/{legacy-aliases,launch-store}.js`; both `server.js` profile store (lazy v2 + `.bak`) | ENG-6, ENG-8 | M | A v1 profile file reads correctly, writes v2 keeping `config`, and the backup is created once; recent launches (incl. P0-RT-2 entry fields) are imported into LaunchStore exactly once; `/api/tools/profiles` and `/api/recent-launches` responses are byte-identical for fixture data; a sleep ledger record with flat config wakes |
| ENG-21 | Legacy manager UIs: launch-plan review | `vllm-manager/public/app.js`, `llama-manager/public/app.js` (review dialog calls `/api/launch/plan`; shows steps, command, overrides, memory verdict; zh/en); +`tests/frontend/launch-plan.spec.js` | ENG-7, ENG-12, ENG-26, OPS-2 | M | The new Playwright spec passes through OPS-2's discovery with no `package.json` or `test-all.cmd` edit; `frontend-smoke.spec.cjs` is unchanged and green; a blocker or a `block` verdict disables `#launchConfirmSubmit`; `image_pull_required` shows the pull action; `plan_changed` returns to the review; no new DOM id collisions; the files stay classic scripts (rule 7.4) |
| ENG-22 | Native process host (flag-gated) | +`manager-core/engines/hosts/native.js`; manifest `native` fields; `engines.native.enabled` read through `readSection("engines")` | ENG-10, OPS-3 | M | Unit tests with a fake spawn: sha256 verification refuses a mismatched binary; state file adoption; stop via `terminateProcessTree`; disabled by default (registry hides the native kind); relaunch-based rollback path tested |
| ENG-25 | Recipe `match` migration to `familyId` | `manager-core/data/recipes/*.json` (`capabilityIds` → `familyId`); `manager-core/engines/recipes.js` (alias resolution through 02's capabilityId → familyId table, `recipe_match_deprecated`) | ENG-6, MOD-6 | S | All PRE-* and P-* goldens unchanged; no bundled recipe uses `capabilityIds`; an override file with `capabilityIds` still matches and warns; 02 MOD-21 may delete `model-capabilities.json` afterwards |
| ENG-23 | Remove model-family branches; the single D5 grep guard | `vllm-manager/server.js` (delete `isQwen*`/`isDiffusionGemma`/preset branches and `knownRuntimeImageMetadata` literals), `vllm-manager/test/core.test.js` (assertions → recipe truth tables), `vllm-manager/lib/pennyroyal.js` (data re-export only), delete the `engines-golden-legacy` tests; +`manager-core/test/no-family-branches.test.js`; +`manager-core/test/fixtures/family-branch-allowlist.json` | ENG-6, ENG-11, ENG-20, ENG-25 | M | The guard passes with an empty or justified allowlist; it is the only guard test and allowlist in the repo; every golden still passes through the adapters; the core.test coverage is preserved (same truth tables); `test-all.cmd` green |
