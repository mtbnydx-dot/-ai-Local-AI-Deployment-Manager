# 06 — Operations: component registry, `platform` CLI, supervisor, doctor, config, deploy

Phase: **P6 (`-ops`)**, plus five **wave-1** packages (OPS-1, OPS-2, OPS-3a, OPS-3b, OPS-10) that land before P1 because every other workstream builds on them. Binding inputs: `00-decisions-and-contracts.md` (D1, D6, D8, D9, D10, §2 layout, §5 contracts, §6 compatibility, §7 rules, **§9 amendments**). Diagnosis inputs: slices `startup` and `frontend` (2026-10-14), re-verified against this worktree. The former OPS-0 launcher fixes are deleted (00 §9.17); they live in 08 P0-OPS-1 and P0-ENT-3.

This spec owns `manager-core/platform/**`, `manager-core/data/platform-components.json`, `manager-core/data/platform-config.schema.json` (plus the fragment loader for `platform-config.d/`), the env-to-key map and the only `platform.json` writer (00 §9.5), `manager-core/secret-store.js` and the `runtime-secret-store.js` facade (00 §9.4), `scripts/platformctl.js`, `platform.cmd`, `service-entry/lib/platform-routes.js`, `release-manifest.json`, the test discovery globs, the deploy post-steps and every legacy start/stop/status `.cmd` shim. It does **not** own anything under `service-entry/console/` (07, 00 §9.16) or `scripts/setup-public.ps1` content (05 PUB-20).

## 0. Decisions made here

1. **One registry, three consumers.** `platform-components.json` describes every process the platform runs or detects. The CLI, the supervisor and service-entry read it through `components.js`. No other file hard-codes a port list or a launch command after OPS-8.
2. **The supervisor is the parent of all components and is optional.** Children are spawned `detached`, so a supervisor crash or upgrade never kills them. A restarted supervisor adopts them through identity records. Without a supervisor, `platform start --no-supervisor` and the entry's legacy start buttons still work, without auto-restart.
3. **The control channel is a Windows named pipe, not a TCP port.** It uses `\\.\pipe\local-ai-platform-<hash12(AI_ROOT)>` plus a bearer token kept in the secret store. No browser can reach it, and no new port is added to the §6 list.
4. **Config is `<AI_ROOT>/config/platform.json` plus a schema dialect, with one owner.** `manager-core/platform/config.js` is the only module that parses, validates or writes the file. Other specs read and write through `readSection`/`writeSection` (§4.6) and never touch the file. Each env var maps to exactly one key. Components keep reading `process.env`. The supervisor and CLI inject config-derived env and list the injected names in `PLATFORM_CONFIG_ENV_KEYS`, so every reader can report the true source of a value (env, file, default, derived or runtime).
5. **Readiness is layered:** environment → runtime → components → serving → exposure. "Green" requires at least one serving model.
6. **Doctor is a library.** The CLI, the supervisor and the entry run it. Every check returns `{status, detail, fix}`. Fixes carry a risk class (`auto`, `confirm`, `manual`), and `manual` fixes are never executed by code.
7. **Long-running fixes and setup steps run in the supervisor.** The entry proxies them and never runs `npm`, `docker pull` or installers in its own process.
8. **Deploy becomes a runnable-system deploy.** It prunes stale files using the manifests, stages `npm ci` where the lockfile changed, rebuilds `platform-mcp/dist`, writes `<AI_ROOT>/version.json` and queues idle-gated restarts. Restarts default to `none`, so today's "deploy never restarts" behaviour is the default.
9. **The release allowlist moves to one `release-manifest.json`.** A test proves that every tracked file is included or excluded with a reason. test-all discovers JS/PS1/PY files by glob. Package tests are found by recursive `node --test` globs and Playwright specs through `testDir` plus `testMatch`, so no package registers a test by editing a hot file.
10. **Autostart is a per-user At-logon scheduled task, registered only by the owner** running `platform autostart enable`. If task registration is denied, it falls back to an HKCU Run value. No workstream, test or code path registers it.
11. **One secret store for the whole platform** (00 §9.4): `manager-core/secret-store.js`, one DPAPI-wrapped file per namespace under `<AI_ROOT>/.runtime/secrets/`. `platform-secrets.json` is never created, and the plaintext runtime-key files and the MCP `server.env` key are migrated once.
12. **The supervisor and CLI are machine principals** (`system:supervisor`, `system:cli`, 00 §9.7). Every call they make to the entry is signed with 05's `internal-auth.js`. No bare marker header is ever trusted.
13. **Automatic actions never replace a container** (00 §9.3). Restore uses `mode:"add"` and `onConflict:"skip"`, and a conflict becomes a notification with a manual action.

## 1. Verified current state

| # | Fact | Evidence (this worktree) |
|---|---|---|
| V1 | `llama-manager/start-manager.cmd` starts with a UTF-8 BOM (`EF BB BF`) before `@echo off`. | `od -c` on the file |
| V2 | Both manager launchers delete the previous crash logs and hard-set the port. | `vllm-manager/start-manager.cmd:7-10,32`; `llama-manager/start-manager.cmd:7-9,31` |
| V3 | `start-platform.cmd` always reports all 6 ports, passes neither `-GatewayOnly` nor `-NoBrowser` to TTS, never waits for Docker and never pauses. | `start-platform.cmd:27-28,45-48,57-66` |
| V4 | Entry readiness uses the heavy fan-out `/api/status`, and the launcher opens the browser even when health failed. | `start-service-entry.cmd:23,32,51` |
| V5 | The entry prints its startup `HINT` with `console.warn`, so `manager.err.log` is never empty (fixed by 08 P0-ENT-3). | `service-entry/server.js:428` |
| V6 | The console's start button spawns managers with append-only logs that are never rotated, and nothing restarts them. | `service-entry/server.js:2179-2214` |
| V7 | `summarizeComponents` covers only process liveness for manager/tts/mcp/search, and its command strings point at old scripts. | `service-entry/server.js:610-637` |
| V8 | Health checks already carry action ids (`start-docker`, `pull-image`). | `vllm-manager/server.js:1572,1575`; `manager-core/health.js:67` |
| V9 | Deploy copies files only: it never deletes, installs, builds or restarts, and it writes manifest `schemaVersion 1`. | `scripts/deploy-worktree.ps1:172-260` |
| V10 | The release excludes every `dist` directory, while the MCP launcher requires `dist/src/index.js`. | `build-github-release.ps1:79`; `scripts/start-platform-mcp.ps1:84-87` |
| V11 | `update-platform.ps1` requires a git work tree, so it fails in the live root. | `scripts/update-platform.ps1:32` |
| V12 | The allowlist (14 dirs, 29 root files, 11 extra files) and the test-all syntax lists are hand-maintained. | `build-github-release.ps1:141-223`; `test-all.cmd:16-74` |
| V13 | **New finding:** on Node 24.16, `node --check x.js` returns 0 for an ESM-syntax `.js` file **with a syntax error**, because module detection skips the check. `node --input-type=module --check < x.js` and `.mjs` do report it. Buildless ESM console files (D2) would pass the current syntax step unchecked. | Reproduced in the scratchpad |
| V14 | Nightly reports and deploy manifests are written by Windows PowerShell 5.1 `Set-Content -Encoding UTF8`, so they carry a BOM, and readers must strip it. | `scripts/nightly-e2e.ps1:116-117`; `deploy-worktree.ps1:258` |
| V15 | Node requirement: the strictest range is `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` (jsdom). The entry needs `node:sqlite`. README says "22.22.2 or newer" and nothing checks it. | `search-gateway/node_modules/jsdom/package.json`; `README.md:70` |
| V16 | Security policy env (`SERVICE_ENTRY_REQUIRE_API_KEY`, `…ALLOW_LAN_ADMIN`, `…ALLOWED_ORIGINS`, `…PUBLIC_BASE_URL`) is read from `process.env` per request, so injecting it at spawn is sufficient. | `service-entry/lib/security.js:22-31,56-77` |
| V17 | There are 131 distinct `process.env.*` names in entry, managers and manager-core. There is no env-file loader. | grep |
| V18 | `createDockerRuntime().ensureDockerDaemonRunning(timeoutMs)` can already start Docker Desktop or a WSL distro and wait for it. | `manager-core/docker-runtime.js:89-150` |
| V19 | Manager `POST /api/manager/shutdown` is local-only, exits gracefully and never touches model containers. On Windows `process.kill(pid, "SIGTERM")` is a hard kill, so graceful stop must go over HTTP. | `manager-core/manager-routes.js:53-65` |
| V20 | Runtime API keys are stored as plaintext `{secret, createdAt}` JSON at `<pkg>/logs/runtime-api-keys.json` behind an icacls ACL, and `get`/`values` are synchronous (`values()` feeds the managers' redactor). The daily backup copies every `<manager>\logs\*.json`, including this file, and `.runtime\platform-mcp\server.env`. | `manager-core/runtime-secret-store.js:13-86`; `vllm-manager/server.js:185,191,683`; `scripts/backup-platform.ps1:63-67,88-90` |
| V21 | The managers default to `127.0.0.1` in code, but both launchers inject `0.0.0.0`. | `vllm-manager/server.js:86`; `service-entry/server.js:102,113`; `start-service-entry.cmd:17-18` |
| V22 | The MCP API key is generated into `.runtime/platform-mcp/server.env` as plaintext with a private ACL. The search upstream key is read from `vllm-manager/logs/.last-public-service-key.txt`. | `scripts/start-platform-mcp.ps1:97,109-121`; `start-search-gateway.cmd:5,25-26` |
| V23 | The search container reaches models through `host.docker.internal`. The launcher picks the entry route only when 5176 is wildcard-bound, and otherwise falls back to the manager on 5177. | `start-search-gateway.cmd:12-24` |

## 2. Architecture

```
owner ── platform.cmd ── scripts/platformctl.js ──┐            (named pipe + bearer token)
Task Scheduler (At logon, owner-registered) ──────┼──> supervisor = `platformctl supervise` (plain Node)
console ── /api/platform/* ── entry ──────────────┘        │ spawns detached / adopts / probes
                                                            ├─ entry            :5176  └ service-entry-public :5186 (listener, same process)
                                                            ├─ vllm-manager     :5177   llama-manager :5178
                                                            ├─ platform-mcp     :5190 (loopback asserted)
                                                            ├─ tts-gateway      :7000   tts-workers 7011-7016 (on demand)
                                                            ├─ search-gateway   compose :5180/:8180
                                                            ├─ docker           external, ensured
                                                            └─ legacy-claude-proxy :8001 (detect only, deprecated)
```

### 2.1 Modules (all plain CommonJS, no npm dependencies)

| Path | Responsibility | Key exports |
|---|---|---|
| `manager-core/platform/components.js` | Load, validate, override and resolve the registry; build the dependency graph; map paths to components | `loadComponentRegistry`, `resolveComponent`, `selectProfile`, `startOrder`, `stopOrder`, `componentsForPaths`, `LEGACY_IDS` |
| `manager-core/platform/config.js` | Schema (core file plus fragments), `platform.json`, precedence, env map, child env, the only writer | `loadPlatformSchema`, `loadPlatformConfig`, `describeEffectiveConfig`, `writePlatformConfig`, `readSection`, `writeSection`, `setSecretLeaf`, `childEnv`, `envNameIndex` |
| `manager-core/secret-store.js` | The platform's only secret store (00 §9.4): DPAPI wrap, per-namespace files, ACL, legacy migration | `createSecretStore`, `createDpapi`, `listSecretNamespaces`, `allSecretValues`, `SECRET_NAMESPACES` |
| `manager-core/runtime-secret-store.js` | Facade over `secret-store.js` that keeps today's API (`get`/`values` sync, `set`/`remove` async) | `createRuntimeSecretStore`, `normalizeRuntimeSecretReference`, `secureLocalSecretFile` (unchanged names) |
| `manager-core/platform/doctor.js` + `checks/{env,runtime,storage,network,security,ops}.js` | Check catalogue, runner and fix runner | `runDoctor`, `runFix`, `createDefaultProbes`, `CHECK_IDS` |
| `manager-core/platform/version.js` | `version.json`, build id, drift, deployments, newer commits | `readVersion`, `getBuildId`, `computeLiveDrift`, `listDeployments`, `countNewerCommits`, `writeVersionFile` |
| `manager-core/platform/supervisor.js` | State machine, ordering, restart/backoff, adoption, pending restarts, restore | `createSupervisor` |
| `manager-core/platform/launcher.js` | Spawn, stop strategies, identity records | `createLauncher` |
| `manager-core/platform/winproc.js` | `netstat -ano`, `tasklist`, batched CIM query, `taskkill /T` | `listListeners`, `processInfo`, `killTree`, `imageNames` |
| `manager-core/platform/control.js` | Pipe server and client, token file | `controlEndpoint`, `startControlServer`, `createControlClient` |
| `manager-core/platform/logs.js` | Rotate-on-start, copy-truncate, tail, follow (redaction is delegated to `manager-core/secret-redactor.js`, 00 §9.4) | `rotateOnStart`, `maybeCopyTruncate`, `tailLog`, `followLog` |
| `manager-core/platform/entry-client.js` | Signed calls from the supervisor and CLI to the entry, as `system:supervisor` or `system:cli` (§5.16) | `createEntryClient` |
| `manager-core/platform/status.js` | Layered readiness and status object (supervised or probe-only) | `buildPlatformStatus`, `countServingInstances` |
| `manager-core/platform/idle.js` | Busy blockers from managers and entry | `collectBlockers` |
| `manager-core/platform/deploy-steps.js` | Post-deploy plan and execution | `planPostDeploy`, `executePostDeploy`, `computePruneCandidates` |
| `manager-core/platform/autostart.js`, `setup.js`, `messages.js`, `semver.js`, `hooks/{platform-mcp,search-gateway}.js` | Autostart; setup wizard steps; zh/en strings; range check; per-component env hooks | see §5, §8 |
| `scripts/platformctl.js` | CLI entry point (lazy-requires modules so `doctor` runs on an unsupported Node) | — |
| `platform.cmd` | Root shim | — |
| `service-entry/lib/platform-routes.js` | `/api/platform/*` handler | `createPlatformRoutes(deps) → handle(req,res,url): Promise<boolean>` |

Per 00 §9.17, these modules are exposed as **one namespace**, `core.platform`, through a lazy getter in `manager-core/index.js`, never as flat names. Callers may also `require("../manager-core/platform/<x>")` directly. `secret-store.js` is exposed as `core.secrets`. The facade keeps its existing flat names, because managers use them today.

### 2.2 Runtime files (none tracked, none released)

```
<AI_ROOT>/config/platform.json                      owner config (+ platform.json.bak, platform.json.lock while writing)
<AI_ROOT>/version.json                              written by post-deploy
<AI_ROOT>/logs/platform/config-changes.jsonl        {at, actor, changed:[keys]} per write; values never logged
<AI_ROOT>/logs/<id>/<id>.out.log|.err.log[.1..5]    uniform component logs
<AI_ROOT>/logs/platform/supervisor.log, events.jsonl
<AI_ROOT>/.runtime/platform/state/<id>.json         identity records
<AI_ROOT>/.runtime/platform/{desired,working-set,deps-state,pending-restarts,setup,doctor-last}.json
<AI_ROOT>/.runtime/platform/npm-stage/<pkg>/        staged npm ci
<AI_ROOT>/.runtime/secrets/<namespace>.json         secret store (§4.5): DPAPI blobs, owner-only ACL, never released or backed up
```

`.gitignore` gains `/config/` and `/version.json`. `logs/`, `.runtime/` and `*.jsonl` are already ignored and excluded from the release. `scripts/backup-platform.ps1` gains an explicit deny list (`.runtime\secrets\*`, `*\logs\runtime-api-keys.json`, `logs\runtime-secrets.json`, `.runtime\platform-mcp\server.env`) that wins over its include globs (V20).

## 3. Component registry

### 3.1 File

`manager-core/data/platform-components.json` carries `schemaVersion: 1`, `asOf` and `staleAfterDays: 365` (rule 7.5). There is no separate override file. Overrides live under `components.<id>` in `platform.json` (§3.6), which is already on the 00 override list.

### 3.2 Fields

| Field | Type | Meaning |
|---|---|---|
| `id` | `[a-z][a-z0-9-]{1,31}` | Registry id. `LEGACY_IDS` maps the old `/api/status` ids: `vllm→vllm-manager`, `llama→llama-manager`, `tts→tts-gateway`, `mcp→platform-mcp`, `search→search-gateway`. |
| `kind` | `node \| process \| group \| compose \| external \| listener` | `node` and `process` are long-running children. `group` has `members[]`, each a mini process spec. `compose` runs `docker compose` one-shots. `external` is probed and never spawned. `listener` is an extra socket of its `parent` process (05's PUBLIC listener): it is probed, its ports join the parent's conflict check, and it is never spawned or stopped on its own. Its states are `ready`, `unhealthy`, `disabled` (its `when` is false) and `stopped` (parent stopped). |
| `parent` | id | Only for `listener`. |
| `label`, `description` | `{ "zh-CN", "en-US" }` | Console and CLI copy. |
| `profile`, `autostart` | `core \| full \| none`, bool | Profile membership. `autostart:false` means on demand only. `full` includes `core`. |
| `cwd`, `command`, `args`, `env` | strings with placeholders | Static launch definition. Config-derived env is added by `childEnv` (§4.6). |
| `ports[]` | `{name, port, bind, when?}` | Used for conflict and orphan detection and URLs. |
| `readiness` | `{http \| tcp \| command, expectStatus?, expectJson?, timeoutSec, intervalMs}` | Used when starting. |
| `liveness` | `{http \| tcp \| command, intervalSec, timeoutMs, failureThreshold, onFailure: "report" \| "restart"}` | Used while running. The default `onFailure` is `report`. |
| `dependsOn`, `after` | id[] | `dependsOn`: wait until ready, and block if it fails. `after`: ordering only. |
| `requires` | `{files?, dockerImage?, doctor?}` | When unmet, the state is `blocked` or `not-installed` with a fix. |
| `logDir`, `extraLogs[]` | path | Uniform logs, plus logs the component writes itself. |
| `stop` | `{strategy, http?, auth?, script?, graceSec, tree?}` | Strategy is `http-then-kill \| kill \| script-then-kill \| compose \| never`. `auth: "system"` signs the HTTP call as `system:supervisor` (§5.16); the entry requires it, while the managers keep their loopback gate. |
| `restartPolicy` | `{mode: on-failure \| always \| never \| docker, maxRestarts, windowSec, backoffSec[], stableAfterSec}` | Defaults: `on-failure`, 5 restarts per 600 s, backoff `[1,2,5,15,30,60]`, stable after 600 s. |
| `busy` | `{http, parser, auth?}` | Idle probe (§5.11). `auth` works as it does for `stop`. |
| `hook` | name | `hooks/<name>.js` exports `prepare(ctx) → {env}` and `afterReady(ctx) → {ok, error}`. |
| `paths[]` | globs (with `!` negation) | Deploy restart mapping (§9.3). |
| `deprecated`, `detectOnly`, `detect` | — | For `legacy-claude-proxy`. |
| `docs` | URL path | Help link. |

### 3.3 Placeholders

The following placeholders are expanded by `resolveComponent`:

- `${AI_ROOT}`.
- `${NODE}`: the supervisor's `process.execPath`.
- `${PWSH}`: `pwsh.exe` if it is on PATH, otherwise `powershell.exe`.
- `${DOCKER}`: an array element that expands to `docker.exe`, or to `wsl.exe -d <distro> --exec docker` when `docker.wslDistro` is set. It mirrors `vllm-manager/server.js:108-128`.
- `${config:<key>}`, `${port:<name>}` and `${TTS_RUNTIME_ROOT}`.

Relative `cwd` and file paths resolve against `AI_ROOT`. An unknown placeholder is a validation error, and the component becomes `blocked`.

### 3.4 Bundled entries (abridged; commands reproduce today's launchers)

```json
{ "schemaVersion": 1, "asOf": "2026-10-14", "staleAfterDays": 365,
  "requirements": { "node": "^22.22.2 || ^24.15.0 || >=26.0.0", "builtinModules": ["node:sqlite"], "python": ">=3.10" },
  "packages": [
    { "dir": "vllm-manager", "live": true, "components": ["vllm-manager"] },
    { "dir": "llama-manager", "live": true, "components": ["llama-manager"] },
    { "dir": "platform-mcp", "live": true, "components": ["platform-mcp"],
      "build": { "script": "build", "inputs": ["src/**/*.ts", "package.json", "package-lock.json", "tsconfig.json"], "stamp": "dist/.build-stamp.json" } },
    { "dir": "search-gateway", "live": false, "reason": "runs in Docker; host deps are test-only" },
    { "dir": ".", "live": false, "reason": "Playwright, test-only" } ],
  "components": [
    { "id": "docker", "kind": "external", "profile": "core", "autostart": true,
      "label": { "zh-CN": "Docker 引擎", "en-US": "Docker engine" },
      "readiness": { "command": ["${DOCKER}", "info", "--format", "{{.ServerVersion}}"], "timeoutSec": 180 },
      "ensure": { "via": "docker-runtime", "mode": "${config:docker.ensureOnStart}" }, "stop": { "strategy": "never" } },
    { "id": "entry", "legacyId": "entry", "kind": "node", "profile": "core", "autostart": true, "after": ["docker"],
      "label": { "zh-CN": "统一入口", "en-US": "Service entry" },
      "cwd": "service-entry", "command": "${NODE}", "args": ["server.js"], "env": { "AI_ROOT": "${AI_ROOT}" },
      "ports": [ { "name": "admin", "port": "${config:listeners.admin.port}", "bind": "${config:listeners.admin.host}" } ],
      "readiness": { "http": "http://127.0.0.1:${port:admin}/gateway/health", "expectJson": { "service": "local-ai-gateway" }, "timeoutSec": 30 },
      "liveness": { "http": "http://127.0.0.1:${port:admin}/gateway/health", "intervalSec": 10, "failureThreshold": 6, "onFailure": "report" },
      "stop": { "strategy": "http-then-kill", "http": "http://127.0.0.1:${port:admin}/api/manager/shutdown", "auth": "system", "graceSec": 15 },
      "busy": { "http": "http://127.0.0.1:${port:admin}/api/platform/busy", "parser": "entry-busy", "auth": "system" },
      "logDir": "logs/entry", "paths": ["service-entry/**", "manager-core/**", "!manager-core/platform/**", "shared-public/**"] },
    { "id": "service-entry-public", "kind": "listener", "parent": "entry", "profile": "core", "autostart": true,
      "label": { "zh-CN": "公网入口监听", "en-US": "Public listener" },
      "ports": [ { "name": "public", "port": "${config:listeners.public.port}", "bind": "${config:listeners.public.host}", "when": "${config:listeners.public.enabled}" } ],
      "readiness": { "http": "http://127.0.0.1:${port:public}/healthz", "expectStatus": 200, "timeoutSec": 30 },
      "liveness": { "http": "http://127.0.0.1:${port:public}/healthz", "intervalSec": 15, "failureThreshold": 4, "onFailure": "report" },
      "stop": { "strategy": "never" }, "docs": "/docs/client-setup-guide.md#public" },
    { "id": "vllm-manager", "legacyId": "vllm", "kind": "node", "profile": "core", "autostart": true, "after": ["entry", "docker"],
      "label": { "zh-CN": "vLLM / SGLang 管理器", "en-US": "vLLM / SGLang manager" },
      "cwd": "vllm-manager", "command": "${NODE}", "args": ["server.js"],
      "env": { "AI_ROOT": "${AI_ROOT}", "VLLM_MANAGER_ALLOW_REMOTE": "0" },
      "ports": [ { "name": "api", "port": "${config:managers.vllm.port}", "bind": "${config:managers.vllm.host}" } ],
      "readiness": { "http": "http://127.0.0.1:${port:api}/api/manager/health", "expectJson": { "ok": true }, "timeoutSec": 30 },
      "liveness": { "http": "http://127.0.0.1:${port:api}/api/manager/health", "intervalSec": 10, "failureThreshold": 6, "onFailure": "report" },
      "stop": { "strategy": "http-then-kill", "http": "http://127.0.0.1:${port:api}/api/manager/shutdown", "graceSec": 15 },
      "busy": { "http": "http://127.0.0.1:${port:api}/api/jobs?fields=summary", "parser": "manager-jobs" },
      "logDir": "logs/vllm-manager", "paths": ["vllm-manager/**", "manager-core/**", "!manager-core/platform/**", "shared-public/**"] },
    { "id": "llama-manager", "legacyId": "llama", "...": "same shape as vllm-manager on managers.llama.{port,host} with LLAMA_MANAGER_ALLOW_REMOTE=0" },
    { "id": "platform-mcp", "legacyId": "mcp", "kind": "node", "profile": "full", "autostart": true, "after": ["entry", "vllm-manager", "llama-manager"],
      "cwd": "platform-mcp", "command": "${NODE}", "args": ["dist/src/index.js"], "hook": "platform-mcp",
      "requires": { "files": ["platform-mcp/dist/src/index.js"], "doctor": ["env.mcp-dist"] },
      "ports": [ { "name": "mcp", "port": "${config:platformMcp.port}", "bind": "127.0.0.1" } ],
      "readiness": { "http": "http://127.0.0.1:${port:mcp}/health", "expectJson": { "ok": true, "service": "local-ai-platform-mcp" }, "timeoutSec": 20 },
      "stop": { "strategy": "kill" }, "logDir": "logs/platform-mcp", "paths": ["platform-mcp/**"] },
    { "id": "tts-gateway", "legacyId": "tts", "kind": "process", "profile": "full", "autostart": true, "after": ["entry"],
      "command": "${PWSH}", "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "tts-platform/scripts/start_gateway.ps1"],
      "requires": { "files": ["${TTS_RUNTIME_ROOT}/envs/gateway/Scripts/python.exe"] },
      "ports": [ { "name": "http", "port": "${config:tts.gatewayPort}", "bind": "127.0.0.1" } ],
      "readiness": { "http": "http://127.0.0.1:${port:http}/health", "timeoutSec": 60 },
      "stop": { "strategy": "script-then-kill", "script": ["${PWSH}", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "tts-platform/scripts/stop_gateway.ps1"], "graceSec": 10, "tree": true },
      "extraLogs": ["${TTS_RUNTIME_ROOT}/state/gateway-stdout.log", "${TTS_RUNTIME_ROOT}/state/gateway-stderr.log"],
      "logDir": "logs/tts-gateway", "paths": ["tts-platform/gateway/**", "tts-platform/scripts/**"] },
    { "id": "tts-workers", "kind": "group", "profile": "full", "autostart": false, "dependsOn": ["tts-gateway"],
      "members": [
        { "name": "chatterbox", "command": "${PWSH}", "args": ["…", "-File", "tts-platform/scripts/start_chatterbox.ps1"], "readiness": { "tcp": 7011, "timeoutSec": 300 } },
        { "name": "qwen",  "args": ["…start_qwen.ps1"],  "readiness": { "tcp": 7012, "timeoutSec": 300 } },
        { "name": "fish",  "args": ["…start_fish.ps1"],  "readiness": { "tcp": 7013, "timeoutSec": 300 } },
        { "name": "step",  "args": ["…start_step_docker.ps1"], "dependsOn": ["docker"], "requires": { "dockerImage": "step-audio-editx" },
          "readiness": { "tcp": 7014 }, "stop": { "strategy": "compose", "container": "step-audio", "action": "stop" } },
        { "name": "voxcpm", "autostart": false, "args": ["…start_voxcpm.ps1"], "readiness": { "tcp": 7015 } },
        { "name": "qwen-design", "autostart": false, "args": ["…start_qwen_design.ps1"], "readiness": { "tcp": 7016 } } ],
      "stop": { "strategy": "script-then-kill", "script": ["${PWSH}", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "tts-platform/scripts/stop_workers.ps1"], "graceSec": 10, "tree": true },
      "logDir": "logs/tts-workers" },
    { "id": "search-gateway", "legacyId": "search", "kind": "compose", "profile": "full", "autostart": true, "dependsOn": ["docker"], "after": ["entry"],
      "compose": { "file": "search-gateway/docker-compose.yml", "project": "local-ai-search", "build": "if-changed" }, "hook": "search-gateway",
      "ports": [ { "name": "http", "port": "${config:search.port}", "bind": "127.0.0.1" }, { "name": "searxng", "port": 8180, "bind": "127.0.0.1" } ],
      "readiness": { "http": "http://127.0.0.1:${port:http}/health", "expectJson": { "service": "local-ai-search-gateway" }, "timeoutSec": 180 },
      "restartPolicy": { "mode": "docker" }, "stop": { "strategy": "compose", "action": "down" }, "paths": ["search-gateway/**"] },
    { "id": "legacy-claude-proxy", "kind": "external", "profile": "none", "deprecated": true, "detectOnly": true,
      "ports": [ { "name": "http", "port": 8001, "bind": "127.0.0.1" } ],
      "detect": { "commandLineIncludes": "claude-vllm-anthropic-proxy.py", "runValue": "ClaudeVllmProxy" },
      "stop": { "strategy": "never" }, "docs": "/docs/troubleshooting.md#legacy-claude-proxy" } ] }
```

Notes on the entries:

- The `step` member keeps `start_step_docker.ps1` semantics. Its container (`step-audio`) is stopped only by an explicit `platform stop tts-workers`. `stop_workers.ps1` (pid-file and command-line verified `taskkill /T`) is added by 08 P0-OPS-1, which also carries the `-GatewayOnly` and `TTS_START_WORKERS=1` launcher behaviour that used to be OPS-0.
- `service-entry-public` replaces the old `exposure.public` port on the entry (05 C7). `platform status` shows it as its own row, so a PUBLIC bind failure (05 §18) is visible while ADMIN stays `ready`.
- `hooks/platform-mcp.js` ports `start-platform-mcp.ps1:89-176`:
  - The MCP key lives in the secret store (`platform` namespace, name `platformMcp.apiKey`). On first run the hook imports `PLATFORM_MCP_API_KEY` from a legacy `.runtime/platform-mcp/server.env`, verifies the read-back and rewrites `server.env` without secret lines. When there is no key, it generates 32 random bytes. The key reaches the child only through env. `platform secrets copy platformMcp.apiKey` puts it on the clipboard for MCP client setup and never prints it.
  - It supplies the `PLATFORM_MCP_*` env with the same defaults.
  - It keeps writing `.runtime/platform-mcp/server.pid` for the legacy status and stop scripts.
  - `afterReady` asserts that the process only listens on loopback. If it binds elsewhere, the process is killed and the component is marked `failed`.
- `hooks/search-gateway.js` ports `start-search-gateway.cmd:12-24`. Keys come from the secret store (`search.apiKey`, `search.upstreamApiKey`), never from `.last-public-service-key.txt` (V22). The upstream is chosen in this order: `search.upstreamBaseUrl` if set; the PUBLIC listener `http://host.docker.internal:${listeners.public.port}/v1` when it is enabled and an upstream key is set; the entry admin route when `listeners.admin.lan` is on; the vLLM manager only when `managers.vllm.host` is a wildcard. If none applies, the component is `blocked{reason:"search-upstream-unreachable"}` with doctor check `net.search-upstream` (V23).
- `build: "if-changed"` passes `--build` only when the `search-gateway/**` hash differs from `.runtime/platform/state/search-gateway.json.buildHash`.

### 3.5 Profiles

`selectProfile(reg, "core")` returns `[docker, entry, service-entry-public, vllm-manager, llama-manager]`. `full` adds `platform-mcp, tts-gateway, search-gateway`. `tts-workers` is in `full` with `autostart:false`, so it starts only on `platform start tts-workers` or `components.tts-workers.autostart: true`. `PROFILE_ALIASES = { all: "full" }` keeps `start-platform.cmd all` working.

### 3.6 Overrides

`platform.json` `components.<id>` may set `autostart`, `profile`, `disabled`, `restartPolicy`, `liveness.onFailure`, `env` (additive) and `args` (replace). Rules:

- Overrides merge by id and are validated with the same validator.
- An override for an unknown id, or a forbidden field (`command`, `cwd`, `kind`), is reported in `registry.errors`. It never crashes startup, and the bundled entry is used.
- New component ids from overrides are accepted only for `kind: external | compose`, which is the extension slot for 05's tunnel (§16).

### 3.7 API

```js
loadComponentRegistry({ aiRoot, config, bundledFile }) → { schemaVersion, requirements, packages, components, errors: [{id, field, code, message}], overridden: [ids] }
resolveComponent(spec, { aiRoot, config, runtime }) → ResolvedComponent   // absolute cwd, argv, env, ports[], urls
selectProfile(registry, profile, { includeOnDemand = false }) → id[]      // throws E_UNKNOWN_PROFILE
startOrder(registry, ids) → id[]   // topological over dependsOn ∪ after; throws E_CYCLE with the cycle path
stopOrder(registry, ids) → id[]    // reverse start order; `docker`, `listener` and `detectOnly` entries are omitted
componentsForPaths(registry, relPaths) → Set<id>   // includes the pseudo id "supervisor" for scripts/platformctl.js, manager-core/platform/**, platform data files
```

## 4. Configuration

### 4.1 `platform.json`

Illustrative only. A real file holds just the values that differ from the defaults.

```json
{ "schemaVersion": 1,
  "listeners": { "admin":  { "port": 5176, "lan": false },
                 "public": { "enabled": true, "port": 5186, "baseUrl": "" } },
  "admin": { "sessionDays": 180 },
  "trustedProxies": { "cidrs": ["127.0.0.1/32", "::1/128"], "clientIpHeader": "cf-connecting-ip" },
  "exposure": { "requireApiKey": "auto", "allowedOrigins": [] },
  "managers": { "bindHost": "127.0.0.1", "vllm": { "port": 5177 }, "llama": { "port": 5178 } },
  "docker": { "ensureOnStart": "start", "waitTimeoutSec": 120 },
  "supervisor": { "autostartProfile": "core", "restoreModels": "offer" },
  "console": { "defaultUi": "classic" },
  "cli": { "openBrowser": true },
  "components": { "tts-workers": { "autostart": false } } }
```

A missing file means all defaults, which is valid. `platform config init` writes `{ "schemaVersion": 1 }`. There is no `entry.*` and no `exposure.lan` or `exposure.public.*` key (00 §9.5).

### 4.2 Schema: one core file plus owned fragments

- **Core file** `manager-core/data/platform-config.schema.json` (OPS-3a). It holds every key in §4.3, including all of 05 §3.4's `listeners`, `admin` and `trustedProxies` leaves with 05's defaults, so the namespaces that 05 and 06 used to define twice now live in one place.
- **Fragments** `manager-core/data/platform-config.d/<namespace>.schema.json`, one per owning spec, so other packages never edit the core file:

  ```json
  { "schemaVersion": 1, "namespace": "telemetry", "owner": "04-telemetry", "asOf": "2026-10-14", "staleAfterDays": 365,
    "properties": { "retention": { "type": "object", "properties": { "requestsDays": { "type": "integer", "minimum": 1, "default": 30, "…": "leaf fields as below" } } } } }
  ```

  The reserved fragment namespaces are `engines` (01), `models` (02), `hub` (03), `telemetry` and `audit` (04), `public` and `keys` (05), and `console` except `defaultUi` (07). 05's `public.baseUrl` moved to `listeners.public.baseUrl`, and a `public` fragment that declares `baseUrl` is rejected.
- `loadPlatformSchema()` merges the core file and the fragments. A fragment that declares a key outside its namespace, a namespace owned by the core file, or an env name already mapped is rejected as a whole with `fragment_conflict`. Its keys then load as `unknown_key` warnings, and startup never crashes. The schema test turns any `fragment_conflict` into a failure.

The dialect is a subset of JSON Schema plus platform keywords. The supported keywords are `type`, `enum`, `minimum`, `maximum`, `pattern`, `format` (`port`, `hostname`, `https-url`, `path`, `cidr`), `items`, `properties` and `additionalProperties:false`. A leaf looks like this:

```json
"lan": { "type": "boolean", "default": false,
  "title": { "zh-CN": "局域网管理访问", "en-US": "LAN admin access" },
  "description": { "zh-CN": "让局域网设备通过本机 IP 打开控制台。写操作仍需先配对设备，模型接口需要 API Key。", "en-US": "Let devices on your LAN open the console through this machine's IP. Changes still need a paired device, and model APIs need an API key." },
  "env": ["SERVICE_ENTRY_ALLOW_LAN_ADMIN"], "envParse": "flag01", "derives": ["listeners.admin.host"], "restartRequired": ["entry"],
  "secret": false, "group": "access", "docs": "/docs/getting-started.md#lan" }
```

- `restartRequired` is a list of component ids, `true` (every consumer) or `false`. `false` means the value is applied live: the supervisor re-reads it, or the consumer reads it through `readSection`, which is mtime-cached.
- `secret: { "namespace": "platform", "name": "search.apiKey" }` marks a secret leaf. Its value lives in the secret store (§4.5), never in `platform.json`, and is never returned.
- `envParse` is one of `string`, `int`, `flag01` (`1` means true), `csv` or `inverted-flag01`.

The validator lives in `config.js` (about 250 lines). It also runs cross-field rules:

| Code | Rule |
|---|---|
| `port_conflict` | All `*.port` values and registry fixed ports must be unique. |
| `insecure_combination` | `listeners.admin.lan` or `listeners.public.lan` together with `exposure.requireApiKey = "off"`. |
| `lan_implied_by_host` (warning) | `listeners.admin.host` is a wildcard while `lan` is false. The effective `lan` becomes `true` with source `derived`, matching 05's `SERVICE_ENTRY_HOST=0.0.0.0` rule. |
| `invalid_format` | `listeners.public.baseUrl` is non-empty and not `https-url`; a CIDR does not parse. |
| `fragment_conflict` | See above. |

### 4.3 Core keys and the env map (each env var maps to exactly one key)

A key may list several env names when consumers read different names for the same value. The supervisor injects all of them, and on read the first one set wins; differing values raise warning `env_alias_conflict`. The schema test enforces that no env name appears under two keys, across the core file and every fragment. `envNameIndex(schema)` returns this map, and every other spec's code must use it rather than its own env table.

| Key | Default | Env (consumers) | Restart |
|---|---|---|---|
| `listeners.admin.host` | derived: `lan ? "0.0.0.0" : "127.0.0.1"` | `SERVICE_ENTRY_HOST` | entry |
| `listeners.admin.port` | 5176 | `SERVICE_ENTRY_PORT`; derived `PLATFORM_MCP_SERVICE_ENTRY_URL` | entry, platform-mcp, search-gateway |
| `listeners.admin.lan` | false | `SERVICE_ENTRY_ALLOW_LAN_ADMIN` (`flag01`) | entry |
| `listeners.admin.legacyProxyGateway` (05) | `serve` | — | false |
| `listeners.public.enabled` | true | — | entry |
| `listeners.public.host` | derived: `listeners.public.lan ? "0.0.0.0" : "127.0.0.1"` | `SERVICE_ENTRY_PUBLIC_HOST` | entry |
| `listeners.public.port` | 5186 | `SERVICE_ENTRY_PUBLIC_PORT` | entry, search-gateway |
| `listeners.public.lan` (05) | false | — | entry |
| `listeners.public.baseUrl` | `""` | `SERVICE_ENTRY_PUBLIC_BASE_URL` | false |
| `admin.firstRunAutoPair`, `.firstRunWindowMinutes`, `.sessionDays`, `.loopbackViewer`, `.lanAnonymousViewer`, `.requireKeyOnLan` (05) | true, 30, 180, true, true, true | — | false |
| `trustedProxies.cidrs` | `["127.0.0.1/32","::1/128"]` | `SERVICE_ENTRY_TRUSTED_PROXIES` (`csv`) | false |
| `trustedProxies.clientIpHeader`, `.countryHeader` | `cf-connecting-ip`, `cf-ipcountry` | `SERVICE_ENTRY_CLIENT_IP_HEADER`, — | false |
| `exposure.requireApiKey` | `auto` | `SERVICE_ENTRY_REQUIRE_API_KEY` | false (read per request, V16) |
| `exposure.allowedOrigins` | `[]` | `SERVICE_ENTRY_ALLOWED_ORIGINS` (`csv`) | false |
| `managers.bindHost` | `127.0.0.1` (00 §9.5) | — | both managers |
| `managers.vllm.host`, `managers.llama.host` | derived from `managers.bindHost` | `VLLM_MANAGER_HOST`, `LLAMA_MANAGER_HOST` | that manager |
| `managers.vllm.port`, `managers.llama.port` | 5177, 5178 | `VLLM_MANAGER_PORT`, `LLAMA_MANAGER_PORT` (+ entry and MCP URLs) | managers, entry, platform-mcp |
| `console.defaultUi` (07 C10) | `classic` | `SERVICE_ENTRY_CONSOLE_DEFAULT` | false |
| `cli.openBrowser`, `cli.lang` | true, `auto` | `SERVICE_ENTRY_NO_BROWSER` (`inverted-flag01`), `PLATFORM_LANG` | — |
| `platformMcp.port`, `.toolProfile`, `.outputSchema`, `.searchRateLimitPerMinute`, `.localRateLimitPerMinute`, `.cacheTtlMs` | 5190, `all`, `compact`, 20, 120, 2000 | `PLATFORM_MCP_PORT`, `…_TOOL_PROFILE`, `…_OUTPUT_SCHEMA`, `…_SEARCH_RATE_LIMIT_PER_MINUTE`, `…_LOCAL_RATE_LIMIT_PER_MINUTE`, `…_CACHE_TTL_MS` | platform-mcp |
| `platformMcp.apiKey`ˢ | generated | `PLATFORM_MCP_API_KEY` | platform-mcp |
| `tts.gatewayPort`, `tts.upstreamApiKey`ˢ | 7000, — | `TTS_GATEWAY_PORT` (entry, tts), `TTS_UPSTREAM_API_KEY` (entry) | entry, tts-gateway |
| `search.port`, `search.upstreamBaseUrl` | 5180, auto (§3.4) | `SEARCH_GATEWAY_PORT`, `UPSTREAM_BASE_URL` | entry, search-gateway |
| `search.apiKey`ˢ | — | `SEARCH_GATEWAY_API_KEY` (search), `SERVICE_ENTRY_SEARCH_GATEWAY_KEY` (entry), `PLATFORM_MCP_SEARCH_GATEWAY_API_KEY` (mcp) | entry, search-gateway, platform-mcp |
| `search.upstreamApiKey`ˢ | — | `UPSTREAM_API_KEY` | search-gateway |
| `paths.hfHome`, `paths.ttsRuntimeRoot` | `<AI_ROOT>/cache/huggingface`, script default | `HF_HOME`, `TTS_RUNTIME_ROOT` | managers, entry, tts |
| `hf.token`ˢ (namespace `hf`, name `token`; stored only when the owner opts in, 00 §9.4) | — | `HF_TOKEN` | managers, entry |
| `docker.ensureOnStart`, `.desktopExe`, `.wslDistro`, `.waitTimeoutSec` | `start`, auto, `""`, 120 | —, `DOCKER_DESKTOP_EXE`, `DOCKER_WSL_DISTRO`, `PLATFORM_DOCKER_WAIT_SECONDS` (08 must-keep, 00 §9.13) | managers; supervisor live |
| `supervisor.autostartProfile`, `.restoreModels`, `.restart.maxRestarts`, `.restart.windowSec`, `.logs.maxBytes`, `.logs.keep`, `.notifications.toast` | `core`, `offer`, 5, 600, 20 MiB, 5, false | — | live |
| `doctor.minFreeGb.{aiRoot,modelRoots,dockerData}`, `doctor.wslMinMemoryGb` | 20, 50, 30, 48 | — | live |
| `updates.branch` | `main` | — | live |
| `components.<id>.*` | — | see §3.6 | that component |

ˢ marks a secret leaf. Secret leaves without an explicit namespace use namespace `platform` with the key as the name.

The `managers.bindHost` default of `127.0.0.1` takes effect wherever the supervisor, the CLI or the entry's fallback start (OPS-13) launches a manager. The legacy `start-service-entry.cmd` still injects `0.0.0.0` (V21) until OPS-8 turns it into a shim. 05 PUB-23 therefore edits neither that script nor this default. The LAN direct-manager opt-in is `managers.bindHost: "0.0.0.0"` in `platform.json`, and doctor reports it (`net.manager-bind`).

### 4.4 Precedence and sources

`loadPlatformConfig({ aiRoot, env = process.env, runtimeOverrides })` resolves each leaf in this order:

1. **`runtime`**: a CLI flag for this run only. For example, `--lan` sets `listeners.admin.lan=true`.
2. **`env`**: a mapped env var is set **and** its name is not listed in `env.PLATFORM_CONFIG_ENV_KEYS`.
3. **`file`**: the value is in `platform.json`.
4. **`derived`**: a `derives` rule applies. The rules are `listeners.admin.host` from `listeners.admin.lan`, `listeners.public.host` from `listeners.public.lan`, `managers.<id>.host` from `managers.bindHost`, and `lan_implied_by_host`.
5. **`default`**: the schema default.

When the supervisor or CLI spawns a child, `childEnv(loaded, componentId, registry)` returns `{ env, injectedKeys }`. It sets every mapped env var whose value did not come from the true environment, and whose consumer list includes the component. It also sets `PLATFORM_CONFIG_ENV_KEYS=<comma list>` and `PLATFORM_CONFIG_FILE=<path>`. Secret leaves are read from the secret store and injected only into their listed consumers. A child that calls `loadPlatformConfig()` (for example the entry, for the settings API) therefore reports `file` or `default` instead of `env` for injected values. Shell `set` and `setx` values still win, as D9 requires, and doctor flags them (`ops.config-shadowed`).

`loadPlatformConfig` returns:

```js
{ values: { "listeners.admin.port": 5176, … }, get(key), sources: { "listeners.admin.port": "default" | "file" | "env" | "derived" | "runtime" },
  envNames: { "listeners.admin.port": ["SERVICE_ENTRY_PORT"] }, file, etag, errors: [{field, code, message}], warnings: [] }
```

Failure handling:

- A corrupt or BOM-prefixed file never throws. A BOM is stripped. A parse error leaves `errors=[{field:"$file", code:"parse_error"}]` and the defaults in force.
- An invalid value falls back to the next source, with an error recorded.
- Unknown keys raise a warning (`unknown_key`), not an error, so an older build can read a newer file.

### 4.5 Secrets (`manager-core/secret-store.js`, 00 §9.4)

**Layout.** There is one file per namespace, `<AI_ROOT>/.runtime/secrets/<namespace>.json`, so writers in different processes never contend for one file:

```json
{ "schemaVersion": 1, "namespace": "runtime.vllm", "protection": "dpapi-user",
  "entries": { "3f0c…-uuid": { "blob": "AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA…", "createdAt": "…", "updatedAt": "…" } } }
```

- With `protection: "acl-only"`, an entry carries `value` instead of `blob`. This is the fallback when DPAPI is unavailable (00 §9.4). Doctor `sec.secret-store` then warns.
- Namespaces in use: `platform` (06 keys, §4.3), `platform-control` (the supervisor's control token, §5.14), `hf` (an HF token, only when the user ticks "remember"; 03 and 08), `webhooks` (04), `internal` (05's internal-auth HMAC key), `admin` (05 CLI and admin material), `runtime.vllm` and `runtime.llama` (manager runtime keys). The namespace regex is `^[a-z][a-z0-9.-]{1,63}$`, and the name regex is `^[A-Za-z0-9._:-]{1,160}$`.

**DPAPI.** `createDpapi({ exec, platform })` runs `powershell.exe -NoProfile -NonInteractive -Command <fixed script>`. The script loads `System.Security` and calls `[Security.Cryptography.ProtectedData]::Protect`/`Unprotect` with `DataProtectionScope.CurrentUser` and the entropy `local-ai-platform:<namespace>`. Requests and responses are JSON on stdin and stdout (`{op, items:[base64]}`), so no value ever appears in argv. One child process handles a whole batch: every unprotect on load, and one protect per write. A sync variant (`execFileSync`) serves the first synchronous `get`. On non-Windows hosts, and when the probe call fails, the store uses `acl-only`.

**API.**

```js
createSecretStore({ aiRoot, namespace, dpapi = createDpapi(), fsImpl, now }) → {
  namespace, file, protection: "dpapi-user" | "acl-only",
  load(): Promise<void>, loadSync(): void,          // decrypts into an in-memory cache
  has(name): boolean, get(name): string,            // sync; "" when absent; reloads when mtime or size changed
  list(): [{ name, createdAt, updatedAt }],         // never values
  values(): string[],                               // for createSecretRedactor({ getSecrets })
  set(name, value): Promise<void>, remove(name): Promise<boolean>,
  importLegacy({ file, map }): Promise<{ imported, skipped }>  // see migration
}
listSecretNamespaces(aiRoot) → string[]
allSecretValues(aiRoot, { namespaces }) → string[]   // a redactor feed for processes that read several namespaces
```

- **Writes.** A write serialises through an in-process queue plus `<namespace>.json.lock` (`wx`, stale after 10 s). It writes tmp + rename and then applies the owner-only ACL (today's `secureSecretFile`: `icacls /inheritance:r /grant:r <user>:(F) *S-1-5-18:(F)`). A failed ACL leaves the write in place and returns `secret_store_acl_failed`.
- **Fail closed.** A corrupt file, or a blob that fails to unprotect, raises `SECRET_STORE_UNAVAILABLE` (status 503). The file is left untouched and never overwritten. Error messages pass through `redactSecrets` from `manager-core/secret-redactor.js`, the only redactor (00 §9.4).
- **Redaction.** Every process that loads a namespace feeds `values()` to its `createSecretRedactor`, so a stored value that later appears in a log, an error or a job line becomes `<redacted>`.
- **Release and backup.** `.runtime/` is excluded from the release, and `backup-platform.ps1` gains a deny list (§2.2). DPAPI CurrentUser blobs would not restore on another account anyway.

**Facade (`runtime-secret-store.js`).** `createRuntimeSecretStore({ file, namespace, aiRoot, dpapi })` keeps its names and semantics: `set(secret)` returns a new UUID reference, `get`/`values` are synchronous, `remove` is async, and corruption throws `RUNTIME_SECRET_STORE_UNAVAILABLE` (503). The managers pass `namespace: "runtime.vllm"` or `"runtime.llama"`, `aiRoot`, and their old `file` as the legacy source. A two-line change to each `server.js` (V20) does this. When only `file` is given (tests), the namespace is `runtime.legacy-<sha256(file).slice(0,8)>`.

**Migration (once, on the first `load`).**

1. If the legacy file exists and parses, `importLegacy` copies each `{reference: {secret, createdAt}}` entry under the same reference. LaunchStore `apiKeyRef` values and container labels therefore stay valid.
2. The store reads back and compares every value.
3. Only then is the legacy file replaced with the stub `{"version":1,"secrets":{},"migratedTo":"secret-store:<namespace>"}` (still ACL'd). Old code reading the stub sees no secrets and fails closed exactly as it does today for a missing reference.
4. A corrupt legacy file aborts the migration with `RUNTIME_SECRET_STORE_UNAVAILABLE`, and that file is left byte-identical.

The same routine migrates `logs/runtime-secrets.json` (the default path, 00 §9.4) and the MCP `server.env` key (§3.4). For rollback, `platform secrets export-legacy --namespace runtime.vllm --yes` rewrites the plaintext file from the store. It is an explicit, TTY-confirmed owner action, documented in `docs/troubleshooting.md`, and never run by code.

The 06 configuration API returns secret leaves as `{ "set": true, "source": "store" | "env", "updatedAt": "…" }`. Values reach children only through env, never argv (D10).

### 4.6 Functions

```js
loadPlatformSchema({ coreFile, fragmentDir }) → Schema                 // §4.2 merge; fragment errors in schema.errors
loadPlatformConfig({ aiRoot, env, runtimeOverrides, schema }) → LoadedConfig
describeEffectiveConfig(loaded, { includeSecrets: false }) → { schemaVersion, etag, groups: [{ id, title, items: [{ key, type, enum?, value | secret:{set}, default, source, envNames, restartRequired, title, description, docs, owner, error? }] }], errors }
writePlatformConfig({ aiRoot, set: {key: value}, unset: [key], etag, actor }) → Promise<{ ok, etag, changed: [keys], restartRequired: [componentIds], errors }>
readSection(name, { aiRoot, env = process.env } = {}) → { values: { …nested effective values; secret leaves as {set} }, sources: { "<dotted key>": source }, etag, errors }
writeSection(name, patch, { aiRoot, etag, actor }) → Promise<{ ok, etag, changed, restartRequired, errors }>
childEnv(loaded, componentId, registry, { secrets }) → { env, injectedKeys }
setSecretLeaf(key, value, { aiRoot, actor }) → Promise<{ ok, updatedAt }>      // secret leaves only; value === null clears
envNameIndex(schema) → Map<envName, key>
```

- **`writePlatformConfig`** is the only code path that writes `platform.json`. It works in this order:
  1. Take `config/platform.json.lock` (`wx`, held for at most 2 s, stale after 10 s). If it is busy, return `config_locked` (409).
  2. Re-read the file and compare the etag (`sha256:<16 hex>` of the bytes, or `"none"` for a missing file). A mismatch returns `config_conflict` (409).
  3. Validate the merged result. Failures return `config_invalid` with `errors[]`.
  4. Copy the old file to `platform.json.bak`, write tmp + rename, and append `{at, actor, changed}` to `logs/platform/config-changes.jsonl`.
  5. Release the lock.

  Secret leaves in `set` are refused with `secret_via_store`. Secrets go through `setSecretLeaf(key, value)`, which calls `createSecretStore(...).set`.
- **`readSection`** is cached per `(aiRoot, file mtime and size, schema)`, so the entry may call it on every request. That is how live (`restartRequired:false`) keys take effect without a restart.
- **`writeSection`** flattens `patch` into `<name>.<path>` keys, where `null` means unset. Keys outside `name` are refused with `section_mismatch`. It then calls `writePlatformConfig`. 05 `public-config.js#updateAccessSection` and 04's settings PUTs are thin callers of `writeSection`; they never write the file themselves. Any extra audit row, such as 05's `access_audit`, stays with the caller.
- `aiRoot` defaults to `process.env.AI_ROOT`, then to the repo root resolved from `__dirname`.

### 4.7 Migration from `setx`

- `platform config import-env [--apply] [--remove-user-env]` reads `reg query HKCU\Environment` and the current process env for every name in `envNameIndex`, including the legacy `SERVICE_ENTRY_*` names that now map to `listeners.*` and `exposure.*`.
  - It prints the values, with secrets masked.
  - `--apply` writes non-secret values through `writePlatformConfig` and secret values to the secret store.
  - `--remove-user-env` runs `reg delete HKCU\Environment /v <NAME> /f` for each imported name after an interactive `y/N` confirmation. It never runs without a TTY.
- `scripts/setup-public.ps1` is 05 PUB-20's. It writes `listeners.public.baseUrl` and `trustedProxies` through `POST /api/public/settings`, which calls `writeSection`. This spec only wraps it (`platform exposure setup`, OPS-16).

## 5. Supervisor

### 5.1 Process model

- **Start.** `platform supervise [--profile core|full|none] [--restore-models] [--autostart]` runs in the foreground. It is started by the logon task, or detached by `platform start` with `windowsHide`, `detached:true` and stdio redirected to `logs/platform/supervisor.{out,err}.log`.
- **Single instance.** `listen()` on the pipe fails with `EADDRINUSE` when another supervisor owns the root, and the process then exits with code 0 and the message "already running".
- **Children.** Every child is spawned `detached:true, windowsHide:true, stdio:['ignore', outFd, errFd]` from files opened in append mode, so children never depend on the supervisor's pipes.

### 5.2 Component states

| State | Meaning |
|---|---|
| `stopped` | Not running. |
| `starting` | Spawned; readiness is pending. |
| `ready` | Readiness passed. |
| `unhealthy` | Liveness failed `failureThreshold` times. |
| `stopping` | Stop in progress. |
| `backoff` | Waiting before a restart. |
| `failed` | Gave up after `maxRestarts`. |
| `blocked` | A requirement, dependency or port is not available; `reason` gives the cause. |
| `not-installed` | Optional runtime missing (TTS env, Step image). |
| `external` | A detect-only component, or Docker managed outside. |
| `unknown` | The process on the port cannot be identified. |

Each component carries `desired: "running" | "stopped"`, persisted in `desired.json`, and `owner: "supervisor" | "adopted" | "none"`.

### 5.3 Start algorithm (`startComponents(ids, { wait })`)

1. Expand dependencies with `dependsOn` and `after` (only members that are in the profile or explicitly requested), then compute `startOrder`.
2. For each id in order:
   - Check `requires`. A missing file gives `blocked` with the doctor fix id. A missing optional runtime gives `not-installed`.
   - Check the ports through `winproc.listListeners()`. If a port is owned by a matching identity, the component is adopted (§5.8). If it is owned by anything else, the state is `blocked` with `reason:"port-conflict"` and the owner's PID and image name.
   - Rotate the logs (§5.9), resolve the env (`childEnv` plus the hook's `prepare`), spawn, and write the identity record.
   - Wait for readiness, polling every `intervalMs`. Dependents wait only on `dependsOn`. `after` dependencies start in sequence but do not block.
   - Run `afterReady`.
   - A `listener` component is never spawned. After its parent is ready it is probed: `disabled` when its `when` is false, `ready` or `unhealthy` otherwise. Its ports are checked for conflicts before the parent is spawned.
3. Docker (`kind: external` with `ensure`) runs in parallel with the first spawn and follows `docker.ensureOnStart`:
   - `start`: `ensureDockerDaemonRunning(waitTimeoutSec * 1000)`, using the same exe resolution as the managers.
   - `wait`: poll only.
   - `never`: skip.
   - Components that `dependsOn` Docker stay `blocked{reason:"docker-unavailable"}` until it is ready. They are retried when the 30 s Docker probe turns green.
4. Readiness timeout gives `failed{reason:"readiness-timeout"}` with the last 20 stderr lines. Restart policy applies.

### 5.4 Health

- Liveness runs every `intervalSec`.
- After `failureThreshold` consecutive failures, a component that is `ready` becomes `unhealthy` and emits a `platform` event.
- If `onFailure: "restart"` (opt-in per component), the component restarts through the idle gate (§5.11).
- The Docker probe runs every 30 s.
- A fast doctor (env and runtime groups) runs at supervisor start and every 30 min, and is cached in `doctor-last.json`.

### 5.5 Restarts

An exit with `code ≠ 0`, or any exit of a `mode: always` component that the supervisor did not request, triggers a restart after `backoffSec[n]`. In detail:

- If `maxRestarts` restarts happen within `windowSec`, the state becomes `failed`, and a `notification` (`kind:"component.failed"`, `severity:"error"`) is emitted with the last exit reason.
- The counter resets after `stableAfterSec` of `ready`.
- Code 0 with no supervisor request (for example someone POSTed `/api/manager/shutdown`) sets `desired=stopped` and does not restart.
- `EADDRINUSE` is detected (the port is owned by another PID after exit, or stderr matches `EADDRINUSE|端口 .* 已被占用`). It gives `blocked{port-conflict}` immediately and is not retried.

### 5.6 Stop strategies and identity

- **Identity record.** `state/<id>.json` holds `{schemaVersion:1, id, pid, processCreatedAt, exe, commandLine, spawnedBy, startedAt, configHash, buildCommit, logFiles}`. `processCreatedAt`, `exe` and `commandLine` come from one batched PowerShell CIM query: `Get-CimInstance Win32_Process -Filter "ProcessId=…"` with `CreationDate.ToUniversalTime().ToString('o')`.
- **`http-then-kill`.** POST the stop URL (2 s timeout), then wait up to `graceSec` for the PID to exit. If it is still running, verify identity and kill. With `auth: "system"` (the entry), the POST is signed as `system:supervisor` (§5.16). After 05 PUB-5, an unsigned loopback POST is a viewer write and gets 401, so the stop would fall through to the identity-checked kill and lose the graceful `hub.stop()` (03).
- **`script-then-kill`.** Run the script, wait for the identity-verified PID, then kill it, with `taskkill /PID <pid> /T /F` when `tree: true`.
- **`kill`.** Verify identity, then kill.
- **`compose`.** `docker compose -f <file> -p <project> stop|down`, or `docker stop <container>` for a member. These are explicit user actions only.
- **`never`.** Refuse with `detect_only_component`.
- **Identity verification.** The PID must be alive, `processCreatedAt` must match within 1 s, and the `exe` basename must match. A mismatch makes the component `unknown` with `reason:"identity-mismatch"`, and **nothing is killed**.
- **Model containers.** `platform stop` never touches model containers unless `--models` is given (§6.3).

### 5.7 Exit reasons

| Reason | When |
|---|---|
| `requested` | The supervisor or a user asked for the stop. |
| `exit-clean` | Code 0, unrequested. |
| `crash` | Non-zero code. |
| `killed-by-supervisor` | Kill after the grace timeout. |
| `port-conflict` | §5.5 detection. |
| `vanished` | The PID disappeared and no exit was observed (adopted process, reboot). |

Each lastExit records `{at, code, signal, reason, uptimeSec, stderrTail[≤20 redacted], exitLogLine}`. `exitLogLine` is the last line of `<pkg>/logs/process-exit.log` when it is newer than the start, which covers the entry and managers.

### 5.8 Adoption and reconcile

On supervisor start, and every 10 s, the supervisor checks each registry port:

- **State file match.** If a state file exists and its identity matches the port owner, the component is adopted with `owner:"supervisor"`.
- **Platform process without a record.** If there is no record, but the owner looks like a platform process (exe is node, the cmdline contains the expected script, and readiness `expectJson` matches), the component is adopted with `owner:"adopted"`. A new identity record is written from the CIM data, so later kills are identity-checked.
- **Stale records.** A record whose PID is dead is archived to `state/<id>.prev.json`.
- **Desired state.** Components with `desired=running` that are not running restart when the supervisor itself restarts.
- **Docker containers.** These are never adopted or reconciled. Managers own them.

### 5.9 Logs

- **Start.** `rotateOnStart(dir, base, keep=supervisor.logs.keep)` renames `.err.log → .err.1.log …` and **never deletes** the current run's files before rotation.
- **While running.** `maybeCopyTruncate(file, maxBytes)` runs every 60 s. It copies to `.1` and truncates in place, because the child holds an append handle. A few lines at the boundary may be lost, and this is documented.
- **Hints.** Startup hints belong on stdout. 08 P0-ENT-3 moves the entry `HINT` to stdout.
- **Redaction.** `tailLog(file, {lines, redactor})` and `followLog` pass every line through `createSecretRedactor({ getSecrets: () => allSecretValues(aiRoot) })` from `manager-core/secret-redactor.js`. That module's patterns and its `<redacted>` marker are the only ones used (00 §9.4); `logs.js` has no patterns of its own. `stderrTail` in `lastExit` and every `operation` log line use the same redactor.
- **Legacy logs.** The legacy `<pkg>/logs/manager.*.log` files are left untouched and are readable through `platform logs <id> --legacy`.

### 5.10 Events

The supervisor appends `logs/platform/events.jsonl` (10 MiB × 3) and serves SSE `/v1/events`. Event types:

| Type | Payload |
|---|---|
| `component` | `{id, state, prev, reason}` |
| `status` | `{full: true, status: PlatformStatus}`, debounced 1 s after any change in readiness or components |
| `operation` | `{opId, kind, state, progress, line}` (line redacted) |
| `notification` | The 00 §9.6 shape `{kind, severity, title{zh,en}, body{zh,en}, action?{label{zh,en}, href \| apiCall}}`, plus optional `dedupeKey` |

Notification kinds are `component.failed`, `component.recovered`, `nightly.failed` (from watching `artifacts/nightly/latest.json` mtime with `ok:false`), `backup.stale` (older than 36 h), `restart.executed`, `restart.overdue`, `deploy.finished`, `supervisor.reexec`, `restore.offer`, `restore.conflict` and `restore.blocked`. Copy comes from `platform/messages.js`.

**Bridge to the entry stream.** The entry (OPS-13) holds one pipe subscription to `/v1/events` and calls ENT-EV's `events.publish(type, payload)` only. It never owns or creates `events.js`. `component`, `status` and `operation` are published as type `platform` with `data: {kind:"component" | "status" | "operation", …}` and `source: "platform"`. `notification` is published as type `notification` with `source: "platform"`.

**Supervisor as a subscriber (toasts).** When `supervisor.notifications.toast` is set, the supervisor holds one SSE connection to the entry, `GET /api/events?client=supervisor&types=notification,platform`, signed as `system:supervisor` (§5.16). ENT-EV delivers `notification` and `platform` to that principal. Backoff runs from 1 s to 30 s.

- It raises a Windows toast through PowerShell WinRT (`Windows.UI.Notifications`, PowerShell AUMID, no dependencies) for `notification` with `severity ∈ {warn, error}`, or whose 04 `channels` includes `toast`.
- Loop guard: envelopes with `source: "platform"` are the supervisor's own. It toasts those locally when they are raised, and ignores them on the way back.
- `dedupeKey` suppresses repeats for 10 min.
- While the entry is down, only local notifications are toasted.

### 5.11 Idle gate and pending restarts

`collectBlockers()` returns `[{kind, source, id, title, since}]`:

| Kind | Source |
|---|---|
| `launch`, `download`, `migration`, `benchmark` | Manager jobs with `status ∈ {running, queued}` from `GET /api/jobs?fields=summary`, by `type`. |
| `download` | Entry hub transfers (03), from `GET /api/platform/busy`. |
| `requests` | Entry in-flight gateway streams, from `GET /api/platform/busy`. |
| `loading` | Instances with `lifecycle.state = loading` (01), from `GET /api/instances`. |

`GET /api/platform/busy` accepts only `system:supervisor` and owner principals. The supervisor signs it (§5.16). An unreachable busy probe, or one that answers 401 or 403, counts as a blocker of kind `unknown`, which fails closed.

`restart(ids, { when: "now" | "idle", force })`:

- `when: "idle"` queues the restart in `pending-restarts.json` (`{id, reason, queuedAt, deadline}`). The deadline defaults to 6 h, after which a warning notification is sent and the restart stays queued. The supervisor re-checks every 15 s.
- `when: "now"` with blockers fails with `409 component_busy {blockers}` unless `force`.
- Restarting a manager never stops its model containers. Managers re-adopt them, as today.

### 5.12 Restore models

Restore is an automatic action, so 00 §9.3 applies: it **never replaces or stops a running container**.

- **Working set.** Every 5 min while a manager has ready instances, and before any supervisor-requested manager stop, the supervisor writes `working-set.json`: `{at, managers:{vllm:[{launchId, instanceId, model, name}], llama:[…]}}`. `launchId` comes from the instance (00 §4.1). For containers without one, the entry is matched by `model + name` to the newest `/api/recent-launches` entry and kept with `legacy:true`.
- **`supervisor.restoreModels`.** `off`, `offer` (default) or `auto`.
  - `offer` emits `notification{kind:"restore.offer", action:{label:{zh:"启动上次的模型", en:"Start last used model"}, apiCall:{method:"POST", path:"/api/platform/restore-models", body:{}}}}`.
  - `auto` (or `--restore-models`) runs after the manager is ready, one entry at a time, waiting for each job. For each entry it does not find in `GET /api/instances`, it reads `GET /api/launches/:launchId` (01) and POSTs the manager's `POST /api/launch` (00 §9.3):

    ```json
    { "…": "record.spec (engineId, runtimeId, recipeId, model, values, extraArgs, extraEnv, secrets.apiKeyRef)",
      "instance": { "…": "record.spec.instance", "mode": "add" }, "onConflict": "skip", "source": "restore" }
    ```

    It **never** sends `mode:"replace"`, and it never calls the legacy `/api/start`.
  - **Conflict** means the answer is `{skipped:true, conflict:{…}}`, or 409 `instance_conflict` / `wake_would_replace_running`. The supervisor then emits `notification{kind:"restore.conflict", severity:"warn", title/body from the `restore.conflict` copy (§11), action:{label:{zh:"去部署页手动替换", en:"Replace manually"}, href:"/deployments?manager=<managerId>"}}` and continues with the next entry.
  - **Admission block** (`verdict:"block"` or 409 `admission_blocked`) emits `restore.blocked` and skips the remaining entries for that manager, because GPU admission stays the gate.
  - **Degrade.** If a manager has no `POST /api/launch` (it answers 404, as pre-01 managers do) or an entry is `legacy:true`, `auto` behaves like `offer` for that entry. A legacy replace-mode `config` is never re-posted.
- The console's "Start last used model" (`POST /api/platform/restore-models`) runs the same add-only plan. A user who wants to replace a running model does it in Deployments, behind 07's replace confirmation.
- `POST /v1/restore-models {dryRun:true}` returns the plan `[{managerId, launchId, model, action:"launch" | "skip-running" | "offer-only"}]` without side effects.

### 5.13 Re-exec

`POST /v1/reexec`, which deploy triggers when the `supervisor` pseudo-component changed:

1. Close the pipe.
2. Spawn a new `platformctl supervise --takeover --profile <current>`.
3. Wait 10 s for the new pipe.
4. Exit, without touching children.

If the new process fails to bind, the old one re-listens and reports `reexec_failed`.

### 5.14 Control API (pipe, HTTP/1.1, JSON)

Transport and authentication:

- The endpoint is `\\.\pipe\local-ai-platform-<sha256(lower(AI_ROOT)).slice(0,12)>`. On non-Windows test hosts it is `<os.tmpdir()>/local-ai-platform-<hash>.sock`.
- Every request needs `Authorization: Bearer <token>`. The token is 32 random bytes in base64url, regenerated at each supervisor start, and compared with `timingSafeEqual`. It is stored in the secret store (namespace `platform-control`, name `token`), not in a plain file (00 §9.4). The CLI unwraps it once per process (one PowerShell DPAPI call). The entry caches it and re-reads it after a 401, which happens after a supervisor restart.
- Requests that carry `Origin` or `Sec-Fetch-Site` are rejected with 403.
- Bodies are limited to 64 KiB.

| Method + path | Request | Response |
|---|---|---|
| `GET /v1/status` | — | `PlatformStatus` (§5.15) |
| `GET /v1/components[/:id]` | — | resolved spec (env values redacted) + live state |
| `POST /v1/components/:id/start` | `{wait?:bool}` | `202 {ok, opId}` or, with `wait`, `200 {ok, component}` |
| `POST /v1/components/:id/stop` | `{models?:false, confirm?:bool}` | as above; `--models` without `confirm` → `400 confirm_required {containers:[…]}` |
| `POST /v1/components/:id/restart` | `{when:"now" \| "idle", force?:false}` | `202`, or `409 component_busy {blockers}` |
| `POST /v1/profiles/:p/start` | `{runtimeOverrides?:{"listeners.admin.lan":true}, restoreModels?}` | `202 {opId}` |
| `POST /v1/stop` | `{scope:"all" \| "<profile>", models?, confirm?, exitSupervisor?:true}` | `202 {opId}` |
| `GET /v1/components/:id/logs` | `?stream=out \| err \| all&tail=200&legacy=0` | `{lines:[{stream, text}], files:[…]}` |
| `GET /v1/components/:id/logs/follow` | — | SSE `log` events |
| `GET /v1/idle` | — | `{idle, blockers:[…]}` |
| `GET /v1/pending-restarts`, `DELETE /v1/pending-restarts/:id` | — | list / `{ok}` |
| `POST /v1/restore-models` | `{managers?:["vllm"], dryRun?}` | `202 {opId, plan}` |
| `POST /v1/doctor/fix` | `{checkId, fixId, confirm:true}` | `202 {opId}`; `manual` fixes → `400 fix_manual_only` |
| `POST /v1/setup/:step` | step params | `202 {opId}` |
| `GET /v1/operations[/:opId]` | — | `{opId, kind, state:"running" \| "ok" \| "failed", progress, log:[…≤500], result}` |
| `GET /v1/events` | — | SSE (§5.10) |
| `POST /v1/reexec`, `POST /v1/shutdown` | `{leaveChildren:true}` | `202` |

### 5.15 `PlatformStatus` (also `platform status --json`, `GET /api/platform/status`)

```json
{ "schemaVersion": 1, "at": "2026-10-14T08:00:00Z", "build": { "commit": "c0146a7d2f1e", "contentHash": "3f9c2a1b7d0e" }, "mode": "supervised",
  "supervisor": { "running": true, "pid": 4242, "startedAt": "…", "profile": "core", "endpoint": "pipe" },
  "readiness": { "overall": "degraded",
    "layers": [ { "id": "environment", "status": "ok" },
                { "id": "runtime", "status": "ok", "detail": "Docker 28.4.0 · RTX PRO 6000 · driver 581.15" },
                { "id": "components", "status": "ok", "detail": "5/5 ready" },
                { "id": "serving", "status": "warn", "code": "no_model_serving", "action": { "id": "restore-models", "label": { "zh-CN": "启动上次的模型", "en-US": "Start last used model" } } },
                { "id": "exposure", "status": "ok", "mode": "local" } ] },
  "components": [ { "id": "entry", "legacyId": "entry", "kind": "node", "profile": "core", "desired": "running", "state": "ready", "owner": "supervisor",
                    "pid": 5120, "ports": [ { "name": "admin", "port": 5176, "bind": "127.0.0.1" } ], "uptimeSec": 7380,
                    "restarts": { "count": 0, "windowCount": 0 }, "lastExit": null, "health": { "live": true, "checkedAt": "…" },
                    "pendingRestart": null, "message": null } ],
  "models": { "serving": 0, "instances": [] },
  "ops": { "nightly": { "ok": false, "streak": 30, "since": "2026-09-14" }, "backup": { "ageHours": 4.5, "ok": true }, "pendingRestarts": [] } }
```

Layer rules:

- **overall.** `down` if the entry is not ready. Otherwise `degraded` if any layer is `warn` or `fail`. Otherwise `ok`.
- **serving.** Counts fleet instances that are ready and report at least one model (`countServingInstances`, mirroring the console predicate `isFleetRoutableInstance`, `service-entry/index.html:2143`).
- **exposure.** `mode` is `public` when `listeners.public.baseUrl` is set, `lan` when `listeners.admin.lan` or `listeners.public.lan` is on, and `local` otherwise. The layer is `fail` when LAN or public is on and no active key exists (05 key-store summary), and `warn` when `baseUrl` is set but `service-entry-public` is not `ready`.

When no supervisor is running, `buildPlatformStatus` uses probe-only mode (`mode:"probe"`): port listeners, readiness URLs and the last doctor run, with no desired state or restarts.

### 5.16 Calls to the entry as machine principals (`platform/entry-client.js`)

After 05 PUB-5, a loopback caller without credentials is only a viewer (00 §9.8). The supervisor and the CLI therefore sign every call they make to the entry with 05's `manager-core/internal-auth.js` (00 §9.7). The signature covers method, path, principal, timestamp and sha256(body), and the HMAC key is read from the secret store namespace `internal`, which 05 creates. They never send a bare marker header. The entry mints `x-request-id` (00 §9.9).

```js
createEntryClient({ aiRoot, principal /* "system:supervisor" | "system:cli" */, baseUrl, fetch, now })
  → { request(method, path, { body, timeoutMs = 5000 }) → Promise<{ status, json }>,
      events(types, onEnvelope, { client }) → { close() } }     // SSE with 1→30 s backoff
```

| Principal | Call | Used by | Entry rule (05 PUB-5 / ENT-EV) |
|---|---|---|---|
| `system:supervisor` | `POST /api/manager/shutdown` | entry `http-then-kill` (§5.6) | allowed |
| `system:supervisor` | `GET /api/platform/busy` | idle gate (§5.11) | only this principal and owner |
| `system:supervisor` | `GET /api/events?client=supervisor&types=notification,platform` | toasts (§5.10) | receives `notification` and `platform` |
| `system:cli` | `POST /api/session/pair-codes` `{ttlSeconds:120}` | `platform admin pair`, `open`, `start` (§6.2) | allowed; returns `{code, url, expiresAt}` |
| `system:cli` | `GET /api/access/migration-report` | `platform keys migrate --report` | read |

- **Fallback.** If the `internal` key is missing (a pre-PUB-5 entry, or the store is unavailable), GET probes go unsigned. An unsigned shutdown POST is tried once; it works on pre-PUB-5 entries. After PUB-5 it gets 401, the stop falls through to the identity-checked kill, and an `entry_shutdown_unsigned` line is logged. Pairing degrades to opening the plain URL and printing 05's pairing hint.
- **Calls to the managers** (`/api/manager/shutdown`, `/api/jobs?fields=summary`, `/api/instances`, `/api/launches/:id`, `/api/launch`, `/api/runtimes/:runtimeId/pull`) stay plain loopback. The managers keep `isLocalRequest` (00 §5).
- **Calls from the entry to the supervisor** use the pipe and bearer token (§5.14), unchanged.

## 6. CLI `platform` (`scripts/platformctl.js`)

### 6.1 Shim `platform.cmd` (CRLF, no BOM, ASCII)

```bat
@echo off
setlocal
set "PLATFORM_NODE=node"
if defined NODE_EXE set "PLATFORM_NODE=%NODE_EXE%"
where "%PLATFORM_NODE%" >nul 2>nul || (echo Node.js ^>=22.22.2 / 24.15+ is required. See docs\getting-started.md & exit /b 9009)
"%PLATFORM_NODE%" "%~dp0scripts\platformctl.js" %*
exit /b %ERRORLEVEL%
```

The legacy shims add `--pause-on-error` when `%CMDCMDLINE%` shows a double-click launch (`cmd /c ""…""`), so failures stay on screen.

### 6.2 Commands

| Command | Behaviour |
|---|---|
| `doctor [--fix[=<checkId>]] [--yes] [--deep] [--group g] [--json]` | Runs the checks (§7). `--fix` runs `auto` fixes and prompts for `confirm` fixes (`--yes` accepts them). `manual` fixes are printed. Exit code 0 when there is no `fail`. |
| `setup [--step id] [--yes] [--non-interactive]` | First-run wizard (§8). |
| `start [core\|full\|<id>…] [--lan] [--public] [--save] [--restore-models] [--no-supervisor] [--no-browser] [--open] [--timeout s]` | (1) Fast preflight: node, sqlite, deps, MCP dist if in scope, port conflicts, config errors. A failure exits 5 with one next action. (2) Ensure the supervisor (spawn detached, wait ≤10 s for the pipe). (3) Start the profile with runtime overrides (`--save` persists them). (4) Stream progress lines `[2/4] vLLM 管理器 vLLM manager … ready (2.1 s)`. (5) Summarise **only the selected components**, with URLs (local, plus LAN when on). (6) Open the browser only if the entry is ready and `cli.openBrowser` is set. The URL is the one-time pairing URL from `admin pair` (§5.16), so a browser the launcher opens is paired with the console without extra steps. `--lan` and `--public` are runtime overrides of `listeners.admin.lan` and `listeners.public.lan`. |
| `stop [<id>…\|core\|full\|all] [--models] [--yes]` | Stops in reverse order. `all` also exits the supervisor. `--models` lists every model container (`GET /api/instances` on each manager), requires a typed `stop` (or `--yes` when not a TTY), then POSTs `/api/instances/:id/stop` before stopping the managers. Without it, the CLI prints "Model containers keep running: …". |
| `restart <id…\|all> [--if-idle] [--when-idle] [--force]` | `--if-idle` exits 3 with the blockers when busy. `--when-idle` queues a pending restart. Without either flag, a busy TTY gets a confirmation prompt, and a non-TTY refuses (exit 3) unless `--force`. |
| `status [<id>…] [--json] [--watch]` | Table of components plus readiness layers. The JSON follows `PlatformStatus`. Exit code 0 when all desired components are ready, otherwise 1. |
| `logs <id> [-f] [--err\|--out] [--tail N] [--since 10m] [--legacy]` | Reads the files directly, so no supervisor is needed. `-f` handles rotation (detects shrink and reopens). Output is redacted. |
| `open [console\|billing\|vllm\|llama\|tts]` | `explorer.exe <url>`. Uses host-relative URLs from config. For `console` and `billing` it first mints a pairing code (`admin pair`) and opens `…/#pair=<code>`. If signing is unavailable, it opens the plain URL and prints 05's pairing hint. |
| `admin pair [--open] [--ttl s]` | Signs `POST /api/session/pair-codes` as `system:cli` and prints the one-time URL `http://127.0.0.1:<port>/#pair=<code>` to the terminal only; it is never logged (05 §5.2 flow 4). `--open` opens it instead. Exit 4 when the entry is down. |
| `keys migrate [--dry-run\|--report] [--json]` | `--dry-run` (default) runs 05's pure planner `planKeyMigration({aiRoot})` from `service-entry/lib/key-migration.js` in-process, read-only. It prints the planned rows and warnings with key previews only, never hashes or keys. `--report` reads `GET /api/access/migration-report` signed as `system:cli`. There is no apply mode: the entry migrates at start, idempotently (05 PUB-4). |
| `exposure scan [--json]` | Runs 05's `runExposureScan({aiRoot, config, exec, fetch, now})` from `service-entry/lib/exposure-scan.js` in-process (read-only probes), prints the checks, and exits 1 when any check is `fail`. |
| `exposure setup [args…]` | Thin wrapper (OPS-16) over 05 PUB-20's `scripts/setup-public.ps1`. It runs `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-public.ps1` and passes the arguments through. |
| `secrets list\|set <key>\|clear <key>\|copy <key>\|migrate\|export-legacy --namespace n` | Secret-store admin (§4.5). `set` reads the value from a hidden TTY prompt or stdin, never argv. `copy` pipes the value to `clip.exe` and never prints it. `list` shows names and dates only. `migrate` runs the one-time legacy imports. `export-legacy` is the TTY-confirmed rollback path. |
| `version [--json] [--fetch]` | Prints `version.json`, build id, Node, package versions, runtime-manifest `asOf`, newer commits and drift count. |
| `autostart enable [--profile p] \| disable \| status` | See §6.5. |
| `deploy [--restart none\|changed\|all] [--skip-tests] [--no-prune] [--allow-live-drift] [--yes] [--dry-run]` | Only from a worktree (it refuses in a live root). It wraps `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-worktree.ps1` and maps the flags (§9.3). |
| `post-deploy --manifest <path> [--restart …] [--no-prune] [--dry-run]` | Internal, called by `deploy-worktree.ps1`. |
| `update [--check]` | Live-root delegation (§9.4). |
| `config list\|get k\|set k v\|unset k\|validate\|path\|init\|import-env` | §4. `set` parses the value by schema type, writes through `writePlatformConfig` and prints the required restarts. Secret keys are refused here (`secret_via_store`) and go through `secrets set`. |
| `deps [--record] [--install <pkg>] [--json]` | Lockfile and dist state. `--record` writes the stamps, and `install-all.cmd` calls it at the end. |
| `supervise …`, `supervisor status\|stop\|reexec` | §5. |

### 6.3 Exit codes

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Failure, or a component not ready |
| 2 | Usage error |
| 3 | Refused because the platform is busy |
| 4 | Supervisor unavailable |
| 5 | Preflight blocked |
| 9009 | Node missing (shim) |

`--json` output is always one JSON document on stdout. Progress goes to stderr.

### 6.4 Language

`--lang zh|en`, then `PLATFORM_LANG`, then `Intl.DateTimeFormat().resolvedOptions().locale` (a `zh*` locale gives zh, anything else gives en). Strings live in `platform/messages.js` as `{ key: { "zh-CN", "en-US" } }`. Flag names never appear alone in user-facing labels.

### 6.5 Autostart

`enable` refuses when `AI_ROOT` is a worktree (a `.git` file is present) unless `--allow-worktree` is given. It registers the task `LocalAIPlatform` through `powershell -NoProfile -NonInteractive -Command -`, with the script on stdin and the parameters in env:

- Trigger `New-ScheduledTaskTrigger -AtLogOn -User <current>` with `Delay PT30S`.
- Principal `-LogonType Interactive -RunLevel Limited`.
- Settings: `-RestartCount 3 -RestartInterval 1m -ExecutionTimeLimit 0 -MultipleInstances IgnoreNew -AllowStartIfOnBatteries`.
- Action `conhost.exe --headless "<node>" "<AI_ROOT>\scripts\platformctl.js" supervise --profile <p> --autostart`. Windows 10 falls back to `powershell -WindowStyle Hidden -Command & '<node>' …`.

If registration is denied, it writes the HKCU Run value `LocalAIPlatform` with the same command line and reports `method:"run-key"`. `disable` removes both. `status` reports the method, the action path, whether the path matches the current `AI_ROOT`, and the last run result.

### 6.6 Legacy scripts become one-line shims (names, arguments and scheduled-task paths kept)

| Script | New body (after `@echo off`/`setlocal`) | Kept behaviour |
|---|---|---|
| `start-platform.cmd [core\|all] [lan]` | `call "%~dp0platform.cmd" start %1 %2 --legacy-args` | `all`→`full`, `lan`→`--lan`, non-zero exit on failure, pause on double-click |
| `start-service-entry.cmd [lan]`, `start-service-entry-lan.cmd` | `platform start core [--lan]` | Opens the paired browser unless `SERVICE_ENTRY_NO_BROWSER=1`; prints the same URL block. The managers now bind `managers.bindHost` (default `127.0.0.1`) instead of the `0.0.0.0` injected today (V21) |
| `stop-service-entry.cmd` | `platform stop entry vllm-manager llama-manager` | "Model containers are not stopped" line |
| `stop-platform.cmd [all]` | `platform stop core` / `platform stop all` | same |
| `status-platform.cmd`, `status-service-entry.cmd` | `platform status` / `platform status entry vllm-manager llama-manager` | Tail of the exit log for offline components |
| `start\|stop\|status-platform-mcp.cmd` (+ `.ps1` wrappers keep `-AiRoot -NodeExe -Port`) | `platform start\|stop\|status platform-mcp` | Loopback assertion, key file, pid file |
| `start\|stop-search-gateway.cmd` | `platform start\|stop search-gateway` | Compose project and upstream selection |
| `start-tts-platform.cmd [-GatewayOnly] [-NoBrowser]` | `platform start tts-gateway` (+ `tts-workers` unless `-GatewayOnly`) | The browser goes to the console, not a second tab |
| `vllm-manager\start-manager.cmd`, `llama-manager\start-manager.cmd`, `…\stop-manager.cmd` | `call "%~dp0..\platform.cmd" start\|stop <id> --open` | Opens the legacy manager UI after start |
| `update-platform.cmd`, `install-*.cmd`, `test-all.cmd`, `status-tts-platform.cmd`, `start-claude-vllm-proxy.ps1` | unchanged wrappers | — |

`scripts/backup-platform.ps1` and `scripts/nightly-e2e.ps1` keep their paths, because the scheduled tasks reference them.

## 7. Doctor

### 7.1 Result shape

This extends `healthCheck(id,label,status,detail,actions)`, keeping `actions` for compatibility:

```json
{ "id": "runtime.docker-daemon", "group": "runtime", "status": "fail", "title": { "zh-CN": "Docker 引擎", "en-US": "Docker engine" },
  "detail": "Docker Desktop is installed but the engine is not running.", "data": { "cli": "28.4.0" }, "durationMs": 412,
  "fix": { "id": "start-docker", "risk": "confirm", "label": { "zh-CN": "启动 Docker Desktop", "en-US": "Start Docker Desktop" },
           "command": "platform doctor --fix=runtime.docker-daemon", "docs": "/docs/troubleshooting.md#docker" },
  "actions": ["start-docker"] }
```

`runDoctor({ aiRoot, config, registry, groups, ids, deep, probes, now })` returns `{schemaVersion:1, at, durationMs, summary:{ok,warn,fail,info,skip}, checks:[…]}`. Windows facts (firewall, scheduled tasks, Run keys, CIM) are collected by **one** PowerShell invocation. The target is a non-deep run under 5 s.

### 7.2 Catalogue

| id | Probe | warn / fail | Fix (risk) |
|---|---|---|---|
| `env.node-version` | `process.version` against `requirements.node` (`semver.js`: `^`, `>=`, `\|\|`) | fail | docs: install Node 24 LTS (manual) |
| `env.node-sqlite` | `require("node:sqlite").DatabaseSync` | fail | manual |
| `env.deps.<pkg>` | `live` packages (all packages in a worktree): `node_modules` exists and the lock sha256 equals `deps-state.json`; fallback compares `node_modules/.package-lock.json` versions | fail | `npm-ci` staged (confirm) |
| `env.mcp-dist` | `dist/src/index.js` exists and `dist/.build-stamp.json.srcSha256` equals the hash of the build inputs | fail if missing, warn if stale | `mcp-build` (auto when MCP stopped, confirm when running) |
| `env.download-cli` | `HF_CLI` or `venvs/download-cli/Scripts/hf.exe` | warn | `install-download-cli` (confirm; needs Python ≥3.10) |
| `env.python`, `env.pwsh`, `env.git` | presence and version | info | manual |
| `runtime.docker-cli` / `runtime.docker-daemon` | resolved `${DOCKER}` `--version` / `info` | fail | `start-docker` (confirm) |
| `runtime.wsl` | `wsl.exe -l -v` (decode UTF-16LE): `docker-desktop` distro on version 2 | warn | manual |
| `runtime.wslconfig` | `%USERPROFILE%\.wslconfig` `[wsl2] memory`, `swap` against `doctor.wslMinMemoryGb` | warn | manual: suggested snippet + docs |
| `runtime.nvidia-driver` | `nvidia-smi --query-gpu=driver_version,name,compute_cap,memory.total` against the max `minimumDriverVersions.win32` and `minimumComputeCapability` of non-retired runtime-manifest entries | fail for a runtime below its minimum; the detail lists the affected runtimes | manual |
| `runtime.images` | `docker image inspect` for each non-retired runtime (pinned digest or tag); `localBuild` entries are reported separately | warn (needed only to launch that engine). Stable tier-1 images say they will auto-pull at launch; experimental ones say a pull is required (00 §9.2) | `pull-image:<runtimeId>` (confirm). This is a supervisor operation that POSTs the hosting manager's `POST /api/runtimes/:runtimeId/pull` (01 ENG-11) and mirrors that job's progress (`dl_` id, `jobs` events) into the operation. It is the same endpoint the console's Pull button uses. Doctor never runs `docker pull` itself. If the manager is stopped, the fix starts it first (same confirmation). Local builds give a manual rebuild script |
| `runtime.gpu-in-docker` (deep) | `docker run --rm --gpus all --entrypoint nvidia-smi <present pinned image>`; never pulls | fail | manual docs |
| `storage.ai-root`, `storage.model-roots`, `storage.hf-cache`, `storage.docker-data` | `fsp.statfs` on AI_ROOT, each `model-storage.json` root (read-only through `storageReadJson`), `paths.hfHome`, and the drive of `%LOCALAPPDATA%\Docker\wsl` | warn below `doctor.minFreeGb.*`; fail below 5 GB on AI_ROOT | manual |
| `storage.writable` | create and delete a temp file in `config/`, `logs/`, `.runtime/` | fail | `mkdirs` (auto) |
| `net.ports` | `netstat -ano -p TCP` (+TCPv6) LISTENING for every registry port, with the owner image from `tasklist /FO CSV /NH` | fail when owned by a foreign process | `stop-orphan:<port>` (confirm; only when the owner matches a platform identity pattern) else manual |
| `net.orphans` | node.exe / pwsh / python processes whose cmdline references `AI_ROOT` scripts but own no registry port; stale pid files | warn | `stop-orphan` (confirm) |
| `net.legacy-proxy` | `:8001` owner cmdline includes `claude-vllm-anthropic-proxy.py`; HKCU Run `ClaudeVllmProxy` | warn (deprecated; bypasses the gateway's auth) | manual: `reg delete …\Run /v ClaudeVllmProxy` printed, not run |
| `net.firewall` (when `listeners.admin.lan` or `listeners.public.lan`) | `Get-NetFirewallPortFilter` → enabled inbound allow on the entry port for Private, or a node.exe program rule | warn | manual: `New-NetFirewallRule …` (admin) |
| `net.manager-bind` | the owning address of 5177/5178 against `managers.<id>.host` | warn when a manager listens on a wildcard while its configured host is loopback (a stale process from an old launcher); info when the owner chose a wildcard `bindHost` | `restart:<id>` (confirm, idle-gated) |
| `net.search-upstream` | the search hook's upstream choice (§3.4) and a TCP probe of `host.docker.internal:<port>` from the search container (`docker exec … node -e`, deep only) | warn when no upstream is reachable | manual docs |
| `sec.lan-keys`, `sec.public` | LAN or public on (`listeners.*.lan`, `listeners.public.baseUrl`): effective key required and ≥1 active key (05 key store, or the `/api/keys` summary); `baseUrl` must be https | fail | link to keys page |
| `sec.secret-store` | each namespace file: `protection`, ACL (`icacls` owner-only), parse and unprotect of one entry | warn on `acl-only` (DPAPI unavailable); fail on a wide ACL or an unreadable store | `secure-secret-files` (auto: re-apply the ACL); manual docs for DPAPI |
| `sec.plaintext-secrets` | `vllm-manager/logs/.last-public-service-key.txt`, `*/logs/audit-admin-password.txt`, an unmigrated `*/logs/runtime-api-keys.json` or `logs/runtime-secrets.json` (no `migratedTo`), a `server.env` with a key line, or any `*-secrets.json` outside `.runtime/secrets/` | warn | `secrets migrate` (confirm) for the files §4.5 migrates; manual (08) for the rest |
| `ops.supervisor`, `ops.autostart` | pipe answers; task or Run value present and its path matches `AI_ROOT` | info / warn when stale | command shown; never auto-registered |
| `ops.nightly` | `artifacts/nightly/latest.json` (strip BOM) plus the last 30 reports → `{ok, passed, failed, streak, since, ageHours}`; `Get-ScheduledTaskInfo LocalAIPlatformNightlyE2E` | warn if failing or >36 h old; fail if streak ≥3 | docs |
| `ops.backup` | newest `backups/*/backup-manifest.json` age and `format`; task info `LocalAIPlatformBackup` | warn >36 h | docs |
| `ops.deploy-drift` | `computeLiveDrift` (live root only) | warn | manual: port the edits |
| `ops.version`, `ops.updates` | `version.json` present; `countNewerCommits` (local refs; `--fetch` to fetch) | info | `platform update` (manual) |
| `ops.config`, `ops.config-shadowed` | `platform.json` errors; env names set in HKCU\Environment or the process env that shadow file values | fail / warn | `config import-env` (confirm) |
| `ops.logs-size` | total size of `logs/` | warn >2 GB | `prune-rotated-logs` (auto, only `*.N.log` older than 14 days) |

### 7.3 Fix execution rules

- `auto` fixes run under `--fix` or the console's "Fix" button.
- `confirm` fixes need an interactive yes, `--yes`, or `confirm:true` in the API.
- `manual` fixes are never executed. Code returns the command and the docs link only.
- A fix that affects a running component (npm swap, MCP rebuild) is a supervisor operation. It stops the component, applies the fix and restarts it only if the component was running. It goes through the idle gate (§5.11). The swap is described in §9.3.
- Fix progress streams as `operation` events. A fix never touches model containers.

## 8. First-run setup (CLI and console)

The steps are stored in `.runtime/platform/setup.json` as `{steps:{<id>:{state:"done" | "skipped" | "failed", at}}, completedAt}`. `describeSetup()` derives each step's live status from doctor, so a step done by hand shows as done.

| # | Step id | Title (zh / en) | Action |
|---|---|---|---|
| 1 | `prereq` | 检查环境 / Check prerequisites | doctor `env` + `runtime`; blocking fails list the manual fixes |
| 2 | `deps` | 安装依赖 / Install dependencies | staged `npm ci` for `live` packages + MCP build |
| 3 | `download-cli` | 下载工具 / Download tool | `install-download-cli.ps1` (optional, recommended) |
| 4 | `storage` | 存储位置 / Storage locations | choose model roots (registered through `createModelStorage().registerRoot`) and `paths.hfHome`; shows free space |
| 5 | `images` | 预拉取运行时 / Pre-pull runtimes | choose engines (vLLM default, llama.cpp, SGLang optional). The step ensures the hosting manager is running, then calls `POST /api/runtimes/:runtimeId/pull` (01 ENG-11) per runtime and shows the job's byte progress |
| 6 | `tts` | 语音（可选） / Voice (optional) | `install-tts-gateway.cmd` |
| 7 | `exposure` | 访问范围 / Access | local (default) or LAN (`listeners.admin.lan`; requires a key; firewall command shown). Public go-live stays in 05's wizard |
| 8 | `ops` | 自动运行 / Automation | shows `platform autostart enable`, the backup and nightly `-Register` commands; the CLI asks `y/N` (default N) and runs them only on yes; the console only shows the commands |
| 9 | `start` | 启动平台 / Start the platform | `platform start core`; opens the console |
| 10 | `first-model` | 部署第一个模型 / Deploy a first model | hands off to the console Deploy wizard (07/02) with the VRAM-based recommendation |

The console's `/setup` page belongs to 07 (00 §9.16). It shows these steps from `GET /api/platform/setup` until `completedAt` is set or the owner clicks "Skip setup". Each step shows status, an explanation and a primary button. Long steps run as supervisor operations with live progress. §11 lists the requirements that 07's CON package must meet.

## 9. Build, test and deploy pipeline

### 9.1 `release-manifest.json` (repo root, single source)

```json
{ "schemaVersion": 1, "packageName": "local-model-service-platform",
  "directories": [ ".github", "tests", "manager-core", "platform-mcp", "search-gateway", "shared-public", "scripts", "service-entry", "tts-platform", "vllm-manager", "llama-manager", "model-capability-tests", "vllm", "deploy/public" ],
  "files": [ ".gitattributes", ".gitignore", "README.md", "package.json", "package-lock.json", "playwright.config.cjs", "SYNC_POLICY.md", "release-manifest.json", "platform.cmd", "install-all.cmd", "…every current $releaseFiles entry…" ],
  "extraFiles": [ "deploy/public/.env.example", "platform-mcp/.env.example", "search-gateway/.env.example", "tts-platform/.env.example",
                  "docs/client-setup-guide.md", "docs/git-worktree-workflow.md", "docs/mcp-platform-guide.md", "docs/qwen38-acceleration-guide.md",
                  "docs/service-runbook.md", "docs/model-storage-guide.md", "docs/update-guide.md", "docs/getting-started.md", "docs/troubleshooting.md" ],
  "runtimeDataDirectories": [ "service-entry/data", "vllm-manager/data", "llama-manager/data", "tts-platform/voices", "tts-platform/outputs", "tts-platform/logs" ],
  "robocopy": { "excludeDirs": [ "node_modules", "…as today…", "dist" ], "excludeFiles": [ ".env", "…as today…" ] },
  "forceInclude": [ "*/test/fixtures/**" ],
  "syntaxCheck": { "esmGlobs": [ "service-entry/console/**/*.js", "service-entry/portal/**/*.js", "shared-public/vendor/**/*.js" ], "skipGlobs": [ "shared-public/vendor/**", "**/*.min.js" ] },
  "excluded": [ { "glob": "docs/comprehensive-audit-*.md", "reason": "internal audit notes" },
                { "glob": "docs/overhaul/**", "reason": "internal design specs" },
                { "glob": "docs/design/**", "reason": "design concept images" },
                { "glob": "claude-vllm-anthropic-proxy.py", "reason": "…only if removed from files; see §17" } ] }
```

`build-github-release.ps1` reads it with `Get-Content -Raw | ConvertFrom-Json`. The robocopy logic, runtime-data removal, README doc-link check and privacy scan are unchanged. The `RELEASE-MANIFEST.md` text gains a line naming the manifest's `schemaVersion`.

- **`forceInclude`** is the negation rule that 00 §9.14 refers to. Tracked files matching it are copied after robocopy, even when a robocopy exclude (such as `*.jsonl` or `logs`) dropped them. Files that the privacy scan or the `.env` rule would reject are never force-included.
- After OPS-1, other packages edit only `release-manifest.json`, never `build-github-release.ps1` (00 §9.15). For example, 05 PUB-20 adds `deploy/cloudflare` to `directories`.

`scripts/test/release-manifest.test.js` uses `git ls-files -z`, and skips with a note when the tree is not a git checkout (an extracted release). It checks:

- Every tracked path is either included (in a `directory` and not excluded by robocopy or runtime-data rules, or in `files`/`extraFiles`) or matched by an `excluded` glob with a non-empty reason.
- Tracked files inside included directories that robocopy patterns would drop (for example tracked `*.jsonl` fixtures) must also appear in `excluded`.
- Every listed file and directory exists.
- No README-linked doc is missing from `extraFiles`.

### 9.2 Test discovery (OPS-2, wave 1; 00 §9.15)

The goal is that no later package edits a root `package.json`, a package `package.json` test script or `test-all.cmd` to register a test.


- **`scripts/check-syntax.js --lang js|ps1|py`.** It enumerates tracked files (falling back to a walk of the manifest directories, skipping `node_modules`, `dist` and `skipGlobs`).
  - **js.** `.cjs` is checked as CommonJS. `.mjs`, files under a nearest `package.json` with `"type":"module"`, files matched by `esmGlobs`, and any `.js` whose source contains a top-level `import`/`export` statement are checked as ESM through `node --input-type=module --check` with the source on stdin (V13). Everything else uses `node --check`. Checks run in parallel, 8 at a time.
  - **ps1.** One call to `scripts/check-powershell-syntax.ps1` with all paths.
  - **py.** One Python process running `ast.parse` over the `tts-platform/**/*.py` files. It exits 77 when Python is missing, and test-all maps that to `:skip`, preserving `REQUIRE_TTS_TESTS`.
- **`scripts/test/scripts-hygiene.test.js`.** This folds in 08 P0-OPS-1's `scripts/check-script-encoding.js`. That script keeps its CLI and gains an exported `checkScriptEncoding(files, {allowBom})`, which the test calls, so its allowlist for the existing TTS `.ps1` BOMs is the single source. Its standalone `test-all.cmd` step is removed, because `:testscripts` runs the test.
  - Every `*.cmd`/`*.bat` is CRLF with no BOM.
  - Every `*.ps1` is CRLF, and a BOM is allowed only if the file contains non-ASCII text (PowerShell 5.1 needs it) or is on the allowlist.
  - Every legacy shim name from §6.6 exists, has 8 lines or fewer, and calls `platform.cmd` (enabled by OPS-8).
  - README's Node requirement string equals `requirements.node`.
- **Package unit tests.** Each package's `test` script becomes a recursive glob that Node expands itself (verified on Node 24.16 with brace sets), so test files in new subfolders are found:
  - `manager-core`, `service-entry`, `vllm-manager`, `llama-manager`: `node --test "test/**/*.test.{js,mjs}"`.
  - `search-gateway`: the same, keeping `--test-isolation=none`.
  - `platform-mcp`: `npm run build && node --test "dist/test/**/*.test.js"`.
  - Root: `test:scripts` = `node --test "scripts/test/**/*.test.{js,mjs}"`.

  Fixture directories never contain `*.test.*` files, and a hygiene assertion checks this.
- **`test-all.cmd`.** Lines 16-74 are replaced by three `:syntax js|ps1|py` steps. Two steps are added: `:testscripts` (root `npm run test:scripts`) and the existing package tests. The summary format is unchanged.
- **Playwright.** `package.json` `test:frontend-smoke` becomes `playwright test --config=playwright.config.cjs`. `playwright.config.cjs` sets `testDir: "./tests"` and `testMatch: ["**/*.spec.cjs", "**/*.spec.js", "**/*.spec.mjs"]`. That covers the four existing root specs and 00 §9.15's `tests/frontend/**/*.spec.js`, so new specs (05, 07) are discovered by being placed under `tests/`. `tests/helpers/**` and `tests/fixtures/**` hold no `*.spec.*` files.
- **Root devDependencies.** The same OPS-2 edit of `package.json` and `package-lock.json` adds `axe-core@4.13.0` (07 CON-5, 00 §9.15). It is a root dev-only dependency, never in `manager-core` or `service-entry`. After OPS-2 no other package touches either file.

### 9.3 Deploy post-steps

`deploy-worktree.ps1` gains `-Restart none|changed|all` (default `none`), `-NoPrune` and `-SkipPostDeploy`. After writing `deployment-manifest.json`, which stays `schemaVersion 1` and keeps its shape, it runs:

```
& node "<LiveRoot>\scripts\platformctl.js" post-deploy --manifest "<backupRoot>\deployment-manifest.json" --restart <r> [--no-prune] [--dry-run when -WhatIf]
```

This uses the **newly deployed** CLI. The result is written to `<backupRoot>\post-deploy.json`, and a non-zero exit fails the deploy with "files are deployed; post-steps failed: <step>; run `platform post-deploy --manifest …`".

`planPostDeploy({ aiRoot, manifest, allManifests, registry, depsState })` produces these steps in order:

1. **Prune.** `computePruneCandidates`:
   - Take the latest record per path across all manifests, sorted by `deployedAt`, the same rule as `Get-LiveDrift`.
   - A path is a candidate when it is absent from the current manifest's `files`, its live sha256 equals the recorded `afterSha256` (an unmodified deploy artifact), and it is outside the protected prefixes: `config/ models/ cache/ logs/ .runtime/ backups/ artifacts/ venvs/ tts-runtime/ node_modules/ worktrees/ platform-repo.git/ */data/ */logs/ */dist/`.
   - Each candidate is copied to `<backupRoot>\pruned\<path>`, then deleted, and empty directories are removed.
   - Drifted or unrecorded files are never pruned. They are listed as `kept` with a reason.
2. **Dependencies.** For each `live` package whose `package-lock.json` sha256 differs from `deps-state.json` (or whose `node_modules` is missing):
   - Copy `package.json` and the lock to `.runtime/platform/npm-stage/<pkg>/` and run `npm ci` there.
   - On success, rename `<pkg>/node_modules` to `node_modules.prev-<stamp>` and move the staged one in. Both are on the same volume.
   - If the rename fails (`EBUSY`/`EPERM`), the swap is recorded as `pendingSwap` and the supervisor performs it at the component's next stop, before spawn.
   - On npm failure, the live `node_modules` is untouched, and the step is reported as failed.
   - `deps-state.json` records `{lockSha256, installedAt, node}`. `.prev-*` directories older than 7 days are deleted at the next post-deploy.
3. **MCP build.** If the build inputs changed or the stamp mismatches, run `npm run build` in `platform-mcp` and write `dist/.build-stamp.json` as `{srcSha256, builtAt, node, tsc}`.
4. **`version.json`.** Write `<AI_ROOT>/version.json`:

   ```json
   { "schemaVersion": 1, "commit": "c0146a7…", "shortCommit": "c0146a7d2f1e", "branch": "feature/…", "version": "0.2.0-git-c0146a7d2f1e",
     "deployedAt": "…", "archiveSha256": "…", "manifest": "artifacts/worktree-deploy-backups/<stamp>/deployment-manifest.json",
     "sourceWorktree": "<basename only>", "postDeploy": { "pruned": 3, "npm": ["vllm-manager"], "mcpBuild": true, "restart": "changed" } }
   ```

5. **Restart.**
   - The changed set is `componentsForPaths(created ∪ updated ∪ pruned paths)`, plus the components of packages whose deps were swapped or rebuilt.
   - `none` prints the list ("restart required: …").
   - `changed` and `all` need the supervisor. Without it, the step prints `platform restart <ids> --when-idle` and exits 0. With it, the step calls `POST /v1/reexec` first if `supervisor` is in the set, then `restart(ids, {when:"idle"})`, which restarts idle components immediately and queues the rest (§5.11).
   - Model containers are never restarted.

`platform deploy` maps flags to `deploy-worktree.ps1`. `--yes` becomes `-Confirm:$false`, and `--dry-run` becomes `-WhatIf`, which also makes the post-steps print their plan.

### 9.4 `update-platform` in the live root

When `git rev-parse --is-inside-work-tree` fails in `update-platform.ps1` and both `<root>\platform-repo.git` and `<root>\worktrees\main` exist:

- Without `-Delegate`, it prints (zh and en): "此目录是线上运行根目录，不是 Git 工作区。请运行：platform update / This is the live runtime root, not a Git checkout. Run: platform update". It also prints the two equivalent commands, then exits 2.
- With `-Delegate`, which `platform update` passes, it runs `git -C <root>\worktrees\main fetch --prune` and `merge --ff-only @{u}` (skipped when there is no upstream). It then runs `& <root>\worktrees\main\scripts\deploy-worktree.ps1 -LiveRoot <root>`, which includes tests and post-steps.
- `-CheckOnly` reports `countNewerCommits`.

In any other case, a non-git directory keeps today's error.

### 9.5 Version, drift and history

```js
readVersion(aiRoot) → { source: "version.json" | "git" | "unknown", commit, shortCommit, branch, version, deployedAt, … }
getBuildId({ aiRoot, roots = BUILD_ID_ROOTS } = {}) → { commit, contentHash }          // the single build-id source (00 §9.16)
computeLiveDrift(aiRoot) → [{ path, deployedSha256, liveSha256 }]   // Node port of Get-LiveDrift; strips BOM; cached 10 min by manifest set + mtimes
listDeployments(aiRoot, { limit = 20 }) → [{ stamp, commit, branch, deployedAt, counts: { created, updated, unchanged, pruned }, postDeploy }]
countNewerCommits(aiRoot, { branch = config.updates.branch, fetch = false }) → { available, behind, head, deployed, ref }  // git --git-dir <AI_ROOT>/platform-repo.git rev-list --count <deployed>..refs/heads/<branch>
```

**Build id (`getBuildId`).** This is the one source for 07's console and 05's portal, which both template it. Neither computes its own id.

- `commit` is `version.json.shortCommit`, else `git rev-parse --short=12 HEAD` in a worktree, else `null`. It is display-only.
- `contentHash` is the URL id (07 `/c/<contentHash>/…`, 05 `/assets/<contentHash>/…`). It equals `sha256(sorted(relPath + "\0" + sha256(bytes)).join("\n")).slice(0, 12)` over every file under `BUILD_ID_ROOTS = ["service-entry/console", "service-entry/portal", "shared-public/vendor", "shared-public/styles"]`.
- Deploys copy files without a restart, so the id must follow file content (07 C2). The function is synchronous. It re-stats the roots at most every 2 s, re-hashes only files whose `(size, mtimeMs)` changed, and returns the cached value in between.
- A missing root contributes nothing. An unreadable file throws `build_id_unavailable`, and the caller (07's snapshot) falls back as its spec says.

## 10. Entry API (`service-entry/lib/platform-routes.js`)

### 10.1 Rules

- Routes are mounted with **one line** in ENT-EV's route-mount table in `server.js` (00 §9.6): `{ prefix: "/api/platform/", handler: platformRoutes }`. Every other entry change in OPS-13 is a call into `platform-routes.js` exports from the existing handlers (§10.3).
- Every route goes through 05's `checkManagementAccess(req, {write})` (PUB-5). Writes need an owner session or token plus CSRF (`csrf_invalid` on failure), or the machine principal named in the table. Viewer access exists only for routes registered in `service-entry/lib/viewer-allowlist.js` (00 §9.8). `platform-routes.js` registers its viewer routes at load, each with a redaction function:

  | Viewer GET | Redaction (`platform-routes.js`) |
  |---|---|
  | `/api/platform/status` | `redactStatusForViewer`: keeps `readiness`, layer `status`/`code`, and component `id`/`label`/`state`/`desired`/`profile`/`uptimeSec`/`restarts.count`. It drops `pid`, `ports[].bind`, `owner`, `lastExit`, `message`, `supervisor.pid`, `ops.backup.files`, layer `detail` and every `action`. |
  | `/api/platform/components` | the same per-component projection, and no `spec` |
  | `/api/platform/version` | `{build:{commit, contentHash}, version, node}` only |

  The SSE type `platform` is registered for viewers with `redactPlatformEventForViewer`: `kind:"status"` goes through `redactStatusForViewer`, `kind:"component"` keeps `{id, state, prev}`, and `kind:"operation"` is dropped. Every other `/api/platform/*` GET is declared admin-only in the mount table, so 05's "registered or admin-only" test passes. `/api/platform/busy` is the exception: it is `system:supervisor` or owner only.
- Proxied requests are already refused for non-`/gateway/` paths (`server.js:195`). The PUBLIC listener (05) never mounts these routes.
- The entry calls the supervisor with `createControlClient({aiRoot})`. It never forwards client headers and adds `x-request-id`.
- Errors use the 00 §4.2 envelope:

| Code | When |
|---|---|
| `supervisor_unavailable` (503) | Supervisor not reachable; `hint` and `action: {id: "start-supervisor"}` included. |
| `component_unknown` (404) | — |
| `component_busy` (409) | Carries `blockers`. |
| `detect_only_component` (400) | — |
| `config_invalid` (400) | Carries `errors[]`. |
| `config_conflict` (409) | Etag mismatch. |
| `config_locked` (409) | Another writer holds `platform.json.lock` for more than 2 s. |
| `secret_via_store` (400) | A secret leaf was sent in `set`; use `secrets`. |
| `fix_manual_only` (400) | — |
| `confirm_required` (400) | — |

### 10.2 Endpoints

| Method + path | Request | Response | Notes |
|---|---|---|---|
| `GET /api/platform/status` | — | `PlatformStatus` | Probe-only fallback without the supervisor; cached 2 s |
| `GET /api/platform/components` / `…/:id` | — | `{components}` / `{component, spec}` | spec env values redacted |
| `POST /api/platform/components/:id/start\|stop\|restart` | `{wait?, models?, confirm?, when?, force?}` | `202 {ok, opId}` / `409 component_busy` | Without the supervisor, `vllm-manager` and `llama-manager` start falls back to `startDetachedManager` |
| `POST /api/platform/supervisor/start` | — | `202 {ok}` | Owner (session or token, 05 PUB-5) on a loopback socket only; spawns `platformctl supervise --profile none` detached |
| `GET /api/platform/components/:id/logs` / `…/logs/follow` | `?stream&tail&legacy` | `{lines}` / SSE | admin only |
| `GET /api/platform/doctor` | `?group=&deep=0&fresh=0` | doctor result | Runs in-process (read-only); single-flight; cached 30 s |
| `POST /api/platform/doctor/fix` | `{checkId, fixId, confirm:true}` | `202 {opId}` | Proxied to the supervisor |
| `GET /api/platform/operations/:opId` | — | operation | proxied |
| `GET /api/platform/config` | — | `describeEffectiveConfig()` + `etag` header | secrets as `{set}` |
| `PUT /api/platform/config` | `{set:{"listeners.admin.lan":true}, unset:[], secrets?:{"hf.token":"…" \| null}}` + `If-Match` | `{ok, etag, changed, restartRequired}` | `set` goes through `writePlatformConfig`; secret values go through `setSecretLeaf` and are never echoed. Errors are `config_invalid`, `config_conflict`, `config_locked` and `secret_via_store`. |
| `POST /api/platform/config/apply` | `{restart:["entry"], when:"idle" \| "now"}` | `202 {opId}` or `409` | Restarting the entry drops this connection; the console reconnects |
| `GET /api/platform/version` | — | `{version, build:{commit, contentHash}, node, packages, newerCommits, drift:{count, checkedAt}}` | drift from the doctor cache |
| `GET /api/platform/deploys` | `?limit=20` | `{deployments}` | |
| `GET /api/platform/schedules` | — | `{nightly:{latest, trend:[{at, ok, passed, failed}] (30), streak, since}, backup:{latest, ageHours, files}, tasks:{…}}` | |
| `GET /api/platform/pending-restarts`, `DELETE …/:id` | — | list / `{ok}` | |
| `POST /api/platform/restore-models` | `{managers?, dryRun?}` | `202 {opId, plan}` | |
| `GET /api/platform/setup` / `POST /api/platform/setup/:step` | step params | `{steps, completedAt}` / `202 {opId}` | `ops` step returns commands only |
| `GET /api/platform/busy` | — | `{blockers:[{kind:"download" \| "requests", …}]}` | `system:supervisor` or owner (§5.16) |

### 10.3 Changes to existing entry endpoints (additive only)

- **`/api/status`.** The shape and ids are unchanged, so nightly's `.ok` and `.components.offline` keep working. `components.items[].startCommand` becomes `platform start <registry id>`, and `allCommand` becomes `platform start full`. A new field `platform: { supervisor: {running}, readiness: {overall, layers} } | null` is read from the supervisor status cache and never blocks.
- **`/api/managers/:id/start|stop`.** These call `platformRoutes.delegateManager(id, action)`, which goes to the supervisor when it is reachable and otherwise falls back to the current code. The fallback `startDetachedManager` now takes host and port from `readSection("managers")`, so it binds `127.0.0.1` by default (V21). `/api/stop-all` delegates to `POST /v1/stop {scope:"core"}` when the supervisor is up, keeping today's semantics of stopping the entry and both managers.
- **`/api/events` (00 §9.6).** `platform-routes.js` starts the bridge of §5.10: one pipe subscription that calls ENT-EV's `events.publish("platform" | "notification", payload)`. It never creates, extends or replaces `events.js`, its ring buffer or its viewer filtering.

## 11. Console System pages: requirements handed to 07

Per 00 §9.16, 07 owns every path under `service-entry/console/`, including the page bodies and the `platform` i18n area (`console/i18n/platform/{zh-CN,en-US}.json`). This section is the content contract: the pages, their data and the copy. 07's CON packages adopt it as acceptance criteria, and OPS-15 is retired (§18).

| Route | Content | Data |
|---|---|---|
| Global status strip (every page) | Five layer chips, plus the overall state and its primary action | `/api/events` `platform` + `GET /api/platform/status` |
| `/system` | Component table: state, owner, port, uptime, restarts, last exit, pending restart. Row actions: Start / Stop / Restart / Restart when idle / Logs. A supervisor banner appears when it is not running. | status, components, logs |
| `/system/doctor` | Checks grouped by category, with Fix buttons. `confirm` uses ConfirmDialog; `manual` shows the command with Copy and Docs. | doctor, doctor/fix, operations |
| `/system/settings` | Schema-driven form with source badges, "Restart required", secret fields (Set/Replace/Clear), and Apply (idle-gated) | config GET/PUT/apply |
| `/system/updates` | Version, build id, newer commits, drift, deploy history, pending restarts | version, deploys, pending-restarts |
| `/system/ops` | Nightly trend (30 bars), backup age, scheduled-task status, autostart status with the command to copy | schedules, doctor `ops.*` |
| `/setup` | Wizard (§8) | setup |
| System → Danger zone | Stop platform, with type-to-confirm and the accurate copy below. Replaces the header "关闭管理界面" button. | `/api/stop-all` |

| Key | zh-CN | en-US |
|---|---|---|
| layer.environment / runtime / components / serving / exposure | 环境 / 运行时 / 组件 / 模型服务 / 访问范围 | Environment / Runtime / Components / Model serving / Exposure |
| state.ready / starting / unhealthy / stopped / failed / backoff / blocked / not-installed / external / unknown / disabled | 就绪 / 启动中 / 异常 / 已停止 / 失败 / 等待重试 / 被阻止 / 未安装 / 外部进程 / 无法识别 / 已关闭 | Ready / Starting / Unhealthy / Stopped / Failed / Retrying / Blocked / Not installed / External / Unidentified / Off |
| serving.none | 平台已启动，但还没有模型在提供服务。 | The platform is up, but no model is serving yet. |
| action.restoreModels | 启动上次的模型 | Start last used model |
| supervisor.missing | 守护进程未运行：组件崩溃后不会自动恢复。 | The supervisor is not running, so crashed components will not be restarted. |
| action.startSupervisor | 启动守护进程 | Start supervisor |
| busy.refuse | 有 {n} 个下载或启动任务正在进行，现在重启会中断它们。 | {n} downloads or launches are in progress. Restarting now would interrupt them. |
| action.restartWhenIdle | 空闲后重启 | Restart when idle |
| stopAll.confirm | 将停止统一入口和两个管理器。模型容器会继续运行并占用显存，但在入口重新启动前无法通过网关访问。输入 stop 确认。 | This stops the entry and both managers. Model containers keep running and keep their VRAM, but they cannot be reached through the gateway until the entry starts again. Type stop to confirm. |
| portConflict | 端口 {port} 被 {image}（PID {pid}）占用。 | Port {port} is in use by {image} (PID {pid}). |
| autostart.howto | 开机自启需在本机终端运行：platform autostart enable | To start the platform at logon, run this on this machine: platform autostart enable |
| pending.restart | 更新已部署，{component} 将在空闲后重启。 | Update deployed. {component} will restart when idle. |
| updates.newer | 有 {n} 个新提交尚未部署。 | {n} newer commits have not been deployed. |
| drift.found | 发现 {n} 个线上文件被手工修改，下次部署会被拒绝。 | {n} live files were edited by hand. The next deploy will refuse until they are ported. |
| nightly.failing | 夜间自检已连续 {n} 晚失败（自 {date} 起）。 | The nightly check has failed {n} nights in a row (since {date}). |
| source.env / file / default / derived / runtime | 环境变量 / 配置文件 / 默认值 / 推导 / 本次运行 | Environment / Config file / Default / Derived / This run |
| settings.restartRequired | 保存后需重启：{components} | Restart required after saving: {components} |
| fix.manual | 需要你在本机手动执行，复制下面的命令： | Run this yourself on this machine. Copy the command below: |
| legacyProxy | 检测到旧版 Claude 代理（端口 8001），它绕过网关鉴权，建议停用。 | Legacy Claude proxy detected on port 8001. It bypasses gateway authentication; consider retiring it. |
| restore.conflict | {model} 未恢复：目标实例正在运行其他模型。平台不会自动替换，请到部署页手动处理。 | {model} was not restored: its instance is running another model. The platform never replaces it automatically; replace it from Deployments if you want to. |
| restore.blocked | 显存不足，已停止恢复其余模型。 | Not enough GPU memory. Restoring the remaining models was stopped. |
| secrets.aclOnly | 本机无法使用 Windows 数据保护（DPAPI），密钥仅受文件权限保护。 | Windows data protection (DPAPI) is unavailable, so secrets are protected by file permissions only. |
| listener.publicDown | 公网入口监听（端口 {port}）未运行，隧道将无法访问模型。 | The public listener (port {port}) is not running, so the tunnel cannot reach any model. |
| pair.hint | 请在本机终端运行 platform admin pair 获取配对链接。 | Run platform admin pair in a terminal on this machine to get a pairing link. |

## 12. P0 launcher fixes (moved to 08)

OPS-0 is deleted (00 §9.17). 08 P0-OPS-1 owns the launcher fixes and also absorbs OPS-0's two unique items: `tts-platform/scripts/stop_workers.ps1`, and starting TTS with `-GatewayOnly -NoBrowser` with workers only under `TTS_START_WORKERS=1`. 08 P0-ENT-3 owns the stdout `HINT`. The encoding check is 08's `scripts/check-script-encoding.js`, and the Docker wait is `PLATFORM_DOCKER_WAIT_SECONDS` (default 90 in the P0 script). From OPS-3a that env var maps to `docker.waitTimeoutSec` (default 120), which the CLI and supervisor use once OPS-8 makes `start-platform.cmd` a shim. OPS-2 folds the encoding check into the hygiene test (§9.2).

## 13. Security notes

- **Control channel.** It is a named pipe with a bearer token from the secret store, and requests that carry `Origin` are refused. Other local users can neither unwrap the DPAPI blob nor read the owner-only file, so they cannot drive the supervisor.
- **Entry gating.** The entry is the only HTTP path to the supervisor. It enforces 05's session-based `checkManagementAccess`, routes viewer reads through the viewer-allowlist registry with the §10.1 redactions, and never forwards `x-forwarded-*` (00 §5). Logs, doctor output and config values are admin-only.
- **Machine principals.** The supervisor and CLI authenticate to the entry only through internal-auth HMAC signatures as `system:supervisor` or `system:cli` (§5.16). A forged bare header grants nothing. The HMAC key sits in the secret store, readable only by the owner account, so any process that can sign could already unwrap the control token. That makes the trust boundary the Windows user, as it is today.
- **Secrets.** Secrets never go in argv, logs, `platform.json`, backups or the release. There is one store (§4.5), DPAPI-wrapped with an owner-only ACL. `childEnv` passes secrets as env only, and `PLATFORM_CONFIG_ENV_KEYS` lists names, never values. Every log tail, `stderrTail` and operation line goes through `secret-redactor.js`, fed by the store's `values()`. Status and the CLI never print env values. `secrets copy` uses the clipboard rather than stdout. Legacy plaintext files are replaced only after a verified import.
- **Pairing codes.** `admin pair` prints the URL to the owner's terminal only. Codes are single-use and live for 120 s (05), and the CLI never writes them to a log or a file.
- **Kills.** Every kill is identity-checked (PID plus creation time plus exe). Port-owner kills are offered only when the identity matches a platform pattern, and always need confirmation.
- **Model containers.** They are stopped only by `stop --models` with typed confirmation, which satisfies the 00 hard rule. Automatic restore never sends `mode:"replace"` (§5.12, 00 §9.3).
- **Manual fixes.** Firewall rules, `.wslconfig`, Run-key removal, driver updates and task registration are never automated. Autostart is registered only when the owner runs `platform autostart enable`. It refuses worktree roots, so a dev tree cannot hijack logon.
- **Prune.** Pruning deletes only files that are recorded deploy artifacts and unmodified, backs them up first, and respects the protected prefixes.
- **Settings validation.** `PUT /api/platform/config` validates through the schema. `insecure_combination` rejects LAN without API keys. 05's exact-origin check and CSRF token block cross-site PUTs. Concurrent writers are serialised by the lock and the etag, so a stale console tab cannot overwrite a CLI change.

## 14. Tests

| Package | New test files | Must cover |
|---|---|---|
| manager-core | `test/platform-config.test.js` | The precedence table (runtime > env > file > derived > default). `PLATFORM_CONFIG_ENV_KEYS` demotes injected env. BOM and corrupt files never throw. The cross-field rules, including `lan_implied_by_host`. Etag conflict and `config_locked`. Two child processes writing concurrently through `writeSection` never lose an update. Atomic write plus `.bak`, and a `config-changes.jsonl` line with keys only. Secrets are never in the file or the description, and `secret_via_store` is enforced. A table-driven env map: every legacy name in §4.3 (`SERVICE_ENTRY_PORT`, `…_ALLOW_LAN_ADMIN`, `…_PUBLIC_BASE_URL`, `…_ALLOWED_ORIGINS`, `…_REQUIRE_API_KEY`, `PLATFORM_DOCKER_WAIT_SECONDS`, `SERVICE_ENTRY_CONSOLE_DEFAULT`, …) lands on exactly one key. **No env name appears under two keys across the core file and every fragment**, and a planted duplicate fragment fails with `fragment_conflict`. A fragment that declares `public.baseUrl` is rejected. `readSection`/`writeSection` round-trip for `listeners`, `exposure`, `console` and a fixture `telemetry` fragment, and `section_mismatch` is enforced. Defaults: `managers.bindHost = 127.0.0.1` and `console.defaultUi = classic`. Every leaf has a bilingual title and description. |
| manager-core | `test/secret-store.test.js` | With a fake DPAPI: set, get, list, remove, `values()`, and reload when the file changes in another process. With `dpapi-user` the file never contains a stored value (byte search). `acl-only` fallback. A corrupt file or a failed unprotect raises `SECRET_STORE_UNAVAILABLE`, and the file stays byte-identical. Name and namespace validation. The DPAPI exec spy shows no value in argv (stdin only). Windows only (skipped elsewhere): a real DPAPI round trip and an owner-only ACL. |
| manager-core | `test/runtime-secret-store.test.js` (**migrated**) | The facade keeps every current assertion except the plaintext one at line 19, which becomes "neither the legacy file nor the store file contains the value". New cases: legacy import keeps references; the stub is written only after verification; a corrupt legacy file fails closed with `RUNTIME_SECRET_STORE_UNAVAILABLE` (503) and stays untouched; the second load is a no-op; a stored value inside a log line is `<redacted>` through `createSecretRedactor({getSecrets: store.values})`. |
| manager-core | `test/platform-components.test.js` | The bundled file validates. Overrides merge by id (an unknown id or forbidden field goes to `errors`, and the bundled entry is kept). Placeholder expansion, including the `${DOCKER}` array and WSL distro. `startOrder` topology and `E_CYCLE`. Profiles (`all`→`full`, on-demand excluded, `service-entry-public` in `core`). `componentsForPaths` with negation. |
| manager-core | `test/platform-supervisor.test.js` | With a fake launcher, clock and probes: start order with `dependsOn` vs `after`; Docker-blocked dependants resume; the backoff schedule and `failed` after 5 restarts in 600 s; clean exit → `desired=stopped`; EADDRINUSE → `blocked`; adoption via record and via pattern; identity mismatch never kills; the listener component is never spawned and goes `disabled` when off; the idle gate and pending restart, with 401 on the busy probe → `unknown` blocker; the re-exec hand-off leaves children. **Restore:** it POSTs `/api/launch` with `instance.mode:"add"` and `onConflict:"skip"` (body asserted); no request ever contains `"replace"` (property test over fixture records, including replace-mode records); a conflict emits one `restore.conflict` notification and continues; an admission block stops that manager; a 404 on `/api/launch` degrades to `offer`. **Toasts:** a `source:"platform"` envelope from the entry stream is not toasted twice. |
| manager-core | `test/platform-entry-client.test.js` | Against a fake entry that uses 05's `verifyInternalRequest`: signed shutdown, busy and SSE calls verify as `system:supervisor`, and the pair-code call as `system:cli`. A tampered body is rejected. Without the `internal` key, it falls back as §5.16 says and logs `entry_shutdown_unsigned` without the key. |
| manager-core | `test/platform-launcher.test.js`, `platform-logs.test.js`, `platform-winproc.test.js` | The stop-strategy sequence (`auth:"system"` signs). Rotation keeps N and never deletes the current file before rename. Copy-truncate. Tails pass through `secret-redactor` (a planted `sk-…` and a store value both come out as `<redacted>`; `logs.js` exports no redaction function). Parsers for netstat, tasklist and CIM on recorded fixtures (en and zh locale output). |
| manager-core | `test/platform-doctor.test.js` | Every check with injected probes, including `sec.secret-store`, `net.manager-bind` and `net.search-upstream`. The `pull-image` fix calls a fake manager's `POST /api/runtimes/:runtimeId/pull` and follows its job; no `docker pull` is ever spawned (exec spy). Golden `test/fixtures/platform/doctor-golden.json` for a fixture world: Node 24.16, Docker down, driver 581.15, one image missing, a 30-night failing streak with BOM files, drift of 1 file, one unmigrated runtime-key file. |
| manager-core | `test/platform-version.test.js`, `platform-deploy-steps.test.js` | Drift on PS-5.1-shaped manifests. `getBuildId`: the `{commit, contentHash}` shape; the hash is stable across runs; it changes after a file edit within 2 s and without a restart; only changed files are re-hashed (fs spy); a missing root is tolerated. Prune candidates (protected prefixes, drifted kept, unrecorded kept, latest record wins). npm staging decision and `pendingSwap`. MCP stamp. Restart mapping, including the `supervisor` pseudo-id. |
| manager-core | golden `test/fixtures/platform/registry-resolved.json` | `resolveComponent` for the default config. It pins argv and env: managers `127.0.0.1` (00 §9.5) plus `*_ALLOW_REMOTE=0`, entry `127.0.0.1:5176`, the public listener `127.0.0.1:5186`, and MCP env defaults identical to `start-platform-mcp.ps1:144-176` with the key taken from the store. |
| service-entry | `test/platform-routes.test.js` | The access matrix with a stub 05 `authenticate`: owner session, loopback viewer (redacted via the registry), LAN viewer (redacted), proxied → 404, `system:supervisor` on `/api/platform/busy`, and viewer → 401 there. Every `/api/platform/*` GET is either registered with a redaction or declared admin-only. The viewer projection holds no `pid`, path, command line or `lastExit` (regex). Supervisor-unavailable fallback for status and manager start (`startDetachedManager` binds the `readSection("managers")` host). No header forwarding. Config GET/PUT (validation envelope, etag, `config_locked`, secrets via the store). Doctor fix refuses `manual`. `/api/status` keeps its keys and gains `platform`. The bridge calls `events.publish` only (spy), with no import of anything but ENT-EV's exported API. |
| root `scripts/test/` | `platformctl.test.js`, `release-manifest.test.js`, `scripts-hygiene.test.js`, `check-syntax.test.js` | CLI parsing and exit codes against a fake control server on a unique pipe. `status --json` validates against the golden. `admin pair` prints a URL and logs nothing (stdout and stderr captured; log dir empty). `secrets copy` never writes the value to stdout. A bad-ESM `.js` fixture fails `check-syntax` (V13). A planted BOM `.cmd` fails the encoding check. `forceInclude` keeps tracked fixtures in the release listing. |

There is **no Playwright spec in this spec**. The System and setup page specs move to 07 together with §11 (00 §9.16).

Existing tests:

- All current package tests stay green. The one rewrite is `manager-core/test/runtime-secret-store.test.js:19` (above). The `service-entry` tests do not assert `startCommand` strings today (grep).
- `tests/frontend-smoke.spec.cjs` is untouched by this spec.
- `test-all.cmd` keeps every check, now discovered. The step names in the summary change from per-file to per-language, and counts are printed. Package test counts after OPS-2 must be greater than or equal to before (reported in the PR).
- CI (`.github/workflows/ci.yml`) needs no change. `npm run test:scripts` runs from test-all.

## 15. Rollout and migration

1. **Wave 1, before P1** (cut from the post-P0 head): OPS-1 → OPS-2, then OPS-3a, OPS-3b and OPS-10. From here on, other specs write config through `writeSection`, store secrets in the store, register tests by placing files, and template `getBuildId()`. 05 PUB-23 and 04 TEL-* depend on OPS-3a.
2. **P6:** registry, primitives, supervisor and CLI land next. The shims (OPS-8) flip only after `platform start/stop/status` pass on a fixture root. Scheduled-task script paths never change.
3. **Data migration.**
   - `platform.json` is never rewritten by migration. The legacy `SERVICE_ENTRY_*` env names keep working through the env map, and `platform config import-env` is opt-in.
   - Secrets: on first load, each runtime-key file, `logs/runtime-secrets.json` and the MCP `server.env` key are imported into the store and replaced by stubs after verification (§4.5). This is the only rewrite of an existing file in this spec. It is idempotent, and `secrets export-legacy` is the explicit rollback.
   - `.runtime/platform-mcp/server.pid` and `server.env` keep their locations. Old logs stay where they are.
   - The first supervisor start adopts components started by legacy launchers.
4. **Behaviour changes the owner sees:** managers bind `127.0.0.1` once launched by the CLI, the supervisor or the entry fallback, and through `start-service-entry.cmd` after OPS-8 (00 §9.5). LAN direct manager access needs `managers.bindHost: "0.0.0.0"`. The browser opened by `platform start`/`open` arrives paired.
5. **Rollback.** Deploy backups restore the old `.cmd` files. A running supervisor can be stopped with `platform supervisor stop` (children keep running). `version.json` and `.runtime/platform/` are ignored by old code. Old manager code reads stub key files and fails closed for references it cannot resolve, so run `platform secrets export-legacy` before rolling a manager back past OPS-3b.

## 16. Contract changes requested (to 00)

Items that the 2026-10-14 amendments (00 §9) already settled have been removed: the event types, the notification shape, test discovery, the build id and OPS-0.

1. **§2 layout.** `manager-core/platform/` gains `supervisor.js`, `launcher.js`, `winproc.js`, `control.js`, `logs.js`, `status.js`, `idle.js`, `deploy-steps.js`, `entry-client.js`, `autostart.js`, `setup.js`, `messages.js`, `semver.js` and `hooks/`. `manager-core/` gains `secret-store.js` and `data/platform-config.d/`. The repo root gains `release-manifest.json`, and `scripts/` gains `check-syntax.js` and `test/`. All additive.
2. **§9.5 config ownership: fragments.** "OPS-3 solely owns the schema" is implemented as one core file that OPS-3a owns, holding every contested namespace, plus per-namespace fragment files owned by their specs (`engines`, `models`, `hub`, `telemetry`, `audit`, `public`, `keys`, and `console` except `defaultUi`). These are merged and validated by OPS-3a's loader and its env-uniqueness test. This avoids a hot file without a second definition of any key. Please state it in §9.5.
3. **§9.5 namespace list completeness.** 05 also needs `listeners.public.lan` and `listeners.admin.legacyProxyGateway`, which this spec places in the core file, and the `public.*` portal and limits namespace minus `baseUrl`, which moved to `listeners.public.baseUrl`, in a 05 fragment. Please list them, or 05 drops them.
4. **§9.5 per-manager host keys.** `managers.bindHost` has no env var. `VLLM_MANAGER_HOST` and `LLAMA_MANAGER_HOST` map to the derived `managers.vllm.host` and `managers.llama.host`, so each env var maps to exactly one key.
5. **§9.4 secret-store layout.** It is one file per namespace (`.runtime/secrets/<namespace>.json`) rather than one file, so that managers, the entry and the CLI never contend for one lock. Namespaces: `platform`, `platform-control`, `hf`, `webhooks`, `internal`, `admin`, `runtime.vllm`, `runtime.llama`. `.gateway-trust.json` (a §6 must-keep format that holds the v1 trust key) is the one remaining secret file outside the store. It needs an explicit 00 exception or a 05 migration into `internal`.
6. **§2 overrides.** Component overrides live inside `platform.json` (`components.<id>`). No new override path is added. Platform override errors are reported at `GET /api/platform/config` and the doctor `ops.config` check.
7. **§6 Entry APIs.** Add `/api/platform/*` (§10.2) as a new surface, with viewer registrations per §10.1. `/api/status` gains the additive `platform` field, and its command strings change.
8. **§6 ports.** No new TCP port. The supervisor control channel is a named pipe.
9. **§7 rule 3** still says `$releaseFiles` and `test:frontend-smoke`. §9.15 overrides it; the text should point there.
10. **05 extension slot.** The tunnel (`deploy/cloudflare`) can be added as a `compose` component with `profile: "none"` through `components.<id>` overrides. 05 defines its descriptor.

## 17. Open decisions for the owner

1. **Model restore.** `supervisor.restoreModels` defaults to `offer`. Should it be `auto` after a reboot? It is safe now (add-only, never replace), but it still competes for VRAM with other GPU users.
2. **Search upstream with loopback managers.** With the managers and ADMIN on loopback, the search container reaches models through the PUBLIC listener with an internal-app key. Is that acceptable, or should search keep a LAN-bound route (`net.search-upstream` warns until decided)?
3. **Legacy proxy.** Retire `legacy-claude-proxy` (`:8001`, Run key `ClaudeVllmProxy`)? Is any client (for example CC Switch) still pointed at it? Doctor only warns until then.
4. **Default Docker behaviour.** `docker.ensureOnStart: "start"` launches Docker Desktop on `platform start core`. Should it be `wait`?
5. **Autostart profile.** `core` (default) or `full` at logon?
6. **Headless launcher.** Is `conhost --headless` acceptable for the logon task, or should a hidden-window PowerShell launcher be used, which flashes briefly?
7. **Deploy restarts.** Should deploy default to `--restart changed` once the supervisor has run for two weeks without incident? This spec keeps `none`.
8. **DPAPI fallback.** If DPAPI is unavailable on the box (unexpected on Windows 11), is ACL-only acceptable (00 §9.4), or should secret writes be refused?

## 18. Work packages

Every package runs `npm test` in the touched packages, plus `test-all.cmd`, and reports exact pass and fail counts (rule 7.2). No package starts, stops or deploys to the live root, and none registers autostart.

**Order.** Wave 1, before P1: OPS-1 → OPS-2, then OPS-3a, OPS-3b and OPS-10 in parallel. P6: OPS-4 → OPS-5 → OPS-6 → OPS-7a → OPS-7b → OPS-7c → OPS-8, with OPS-9a/9b, OPS-11a/11b, OPS-12, OPS-13, OPS-14 and OPS-16 as their dependencies allow. OPS-0 and OPS-15 are retired, and their ids are kept for traceability. "OPS-3" in 00 §9 and in other specs means OPS-3a (config) plus OPS-3b (secret store). Both are wave 1 and land before 05 PUB-23, 04 TEL-*, 03's secret use and 05 PUB-5.

| id | Title | Files touched / created | depends_on | Size | Acceptance |
|---|---|---|---|---|---|
| OPS-0 | **Retired** (00 §9.17) | — (moved to 08 P0-OPS-1 and P0-ENT-3, §12) | — | — | — |
| OPS-1 | Release manifest single source (wave 1) | `release-manifest.json` (incl. `forceInclude`), `build-github-release.ps1`, `package.json` (`test:scripts`), `scripts/test/release-manifest.test.js`, `test-all.cmd` (`:testscripts`) | — | M | The built ZIP has a file list identical to the pre-change build (diff of listings in the PR). The test fails when a new tracked file is neither included nor excluded with a reason. A tracked fixture under a robocopy-excluded pattern ships through `forceInclude`. The privacy scan is unchanged. |
| OPS-2 | Test discovery, hygiene, root devDependencies (wave 1) | `scripts/check-syntax.js`, `scripts/test/{check-syntax,scripts-hygiene}.test.js`, `scripts/check-script-encoding.js` (adds an export only), `test-all.cmd`, root `package.json` + `package-lock.json` (`test:frontend-smoke`, `test:scripts`, `axe-core@4.13.0`), `playwright.config.cjs` (`testMatch`), the `test` script in `{manager-core,service-entry,vllm-manager,llama-manager,search-gateway,platform-mcp}/package.json` | OPS-1, P0-OPS-1 | M | Every JS, PS1 and PY file previously listed is still checked, and the count is printed. The bad-ESM `.js` fixture fails (V13). `playwright test --list` shows the 4 existing specs, plus a temporary `tests/frontend/probe.spec.js` with no config edit. A temporary `manager-core/test/sub/probe.test.js` runs under `npm test`. Package test counts are ≥ before. A planted BOM `.cmd` fails the hygiene test. `require("axe-core/package.json").version === "4.13.0"` from the root. CI is green. |
| OPS-3a | Platform config: schema, env map, sole writer, sections (wave 1) | `manager-core/data/platform-config.schema.json`, `manager-core/data/platform-config.d/` (empty dir with `.gitkeep`), `manager-core/platform/{config,semver}.js`, `manager-core/index.js` (`core.platform` lazy getter), `manager-core/test/platform-config.test.js`, `.gitignore` | — | L | Every `platform-config.test.js` case in §14 passes. 04 and 05 can call `readSection`/`writeSection` (example calls in the test). `managers.bindHost` defaults to `127.0.0.1` and `console.defaultUi` to `classic`. The env map is unique across the core file and fragments. A missing or corrupt file never throws. No secret leaf can be written to the file. |
| OPS-3b | Secret store and runtime-key migration (wave 1) | `manager-core/secret-store.js`, `manager-core/runtime-secret-store.js` (facade), `manager-core/index.js` (`core.secrets`), `vllm-manager/server.js` and `llama-manager/server.js` (store options, 2 lines each), `scripts/backup-platform.ps1` (deny list), `manager-core/test/{secret-store,runtime-secret-store}.test.js` | P0-OBS-1 | L | The secret-store and migrated facade cases in §14 pass. No stored value appears in any file under `<AI_ROOT>` except as a DPAPI blob (byte search on a fixture root after a full manager test run). The existing manager suites stay green with the facade. On a fixture root, the backup listing excludes every denied path. `platform-secrets.json` and `hub-secrets.json` are never created (grep over the tree and the fixture root). |
| OPS-10 | Version, drift, history, build id (wave 1) | `manager-core/platform/version.js`, `manager-core/test/platform-version.test.js` (the `platform version` command lands with OPS-7a) | OPS-3a | S | Drift equals `Get-LiveDrift` on fixture manifests with BOMs. `getBuildId()` returns `{commit, contentHash}` and passes the §14 cases, so 05 PUB-15 and 07 CON-1/CON-2 can template it. `countNewerCommits` works against a fixture bare repo created in the test. |
| OPS-4 | Component registry | `manager-core/data/platform-components.json` (incl. `service-entry-public`), `manager-core/platform/{components,messages}.js`, `manager-core/platform/hooks/{platform-mcp,search-gateway}.js`, tests and the `registry-resolved.json` golden | OPS-3a, OPS-3b | M | The golden pins argv and env for all components (managers on `127.0.0.1`). Override and validation cases pass. The MCP hook imports a fixture `server.env` key into the store and rewrites the file without it. The search hook picks the upstream per §3.4 and never reads `.last-public-service-key.txt`. The data file carries `schemaVersion`, `asOf` and `staleAfterDays`. |
| OPS-5 | Process primitives | `manager-core/platform/{winproc,logs,launcher}.js` + tests with recorded fixtures | OPS-4, P0-OBS-1 | M | The netstat, tasklist and CIM parsers pass on en and zh fixtures. Identity mismatch never kills (asserted through the fake `killTree`). Rotation passes. Every tail line goes through `secret-redactor.js`, and `logs.js` has no patterns of its own. |
| OPS-6 | Supervisor core, control API, entry client | `manager-core/platform/{supervisor,control,status,idle,entry-client}.js` + tests | OPS-5, PUB-5, PUB-10 | L | The §14 supervisor cases (except restore and toasts, which are OPS-12) and the entry-client cases pass with the fake clock. A pipe server and client round-trip with the token, and a request with `Origin` gets 403. `PlatformStatus` matches the golden in both supervised and probe modes, including the listener row. The entry stop and busy probe are signed. |
| OPS-7a | CLI framework and read commands | `scripts/platformctl.js`, `platform.cmd`, `release-manifest.json`, `scripts/test/platformctl.test.js` | OPS-6, OPS-10 | M | `status`, `status --json`, `logs` (`-f` with rotation), `version`, `open` (plain URL), `config *` (secret keys refused) and `deps` work against a temp root. `secrets list/set/clear/copy/migrate/export-legacy` work against a fake DPAPI, and `copy` never prints. Exit codes follow §6.3. `--help` is bilingual. The shim is CRLF with no BOM. |
| OPS-7b | CLI lifecycle commands | `scripts/platformctl.js` (`start`, `stop`, `restart`, `supervise`, `supervisor`), tests | OPS-7a | M | On a temp root with stub node components on random ports: `start core` spawns the supervisor, starts in order, summarises only the profile and returns 0. A killed stub restarts with backoff. `restart --if-idle` returns 3 with blockers. `stop --models` without `--yes` in a non-TTY refuses. `stop all` exits the supervisor and leaves no stub running. `--lan` sets the runtime override `listeners.admin.lan`. |
| OPS-7c | CLI access commands (05 C7) | `scripts/platformctl.js` (`admin pair`, `keys migrate`, `exposure scan`; pairing wired into `start` and `open`), tests | OPS-7b, PUB-4, PUB-5, PUB-19 | S | `admin pair` against a fake entry prints the `#pair=` URL, logs nothing, and signs as `system:cli`. `start`/`open` open the paired URL, and without the `internal` key they fall back to the plain URL with the hint. `keys migrate --dry-run` prints planner rows with previews only (regex: no hash, no key). `exposure scan --json` returns 05's report shape from fixture probes, and exit 1 on a `fail`. |
| OPS-8 | Legacy shims and docs | every `.cmd` in §6.6, `scripts/{start,stop,status}-platform-mcp.ps1` wrappers, `vllm-manager/*.cmd`, `llama-manager/*.cmd`, `README.md`, `docs/service-runbook.md`, `docs/getting-started.md` (new), `release-manifest.json` | OPS-7c, OPS-2 | M | The hygiene test confirms every shim name exists, has ≤8 lines and calls `platform.cmd`. `start-service-entry.cmd` no longer injects `0.0.0.0`, and its browser opens paired. The README quick start is `install-all`, `install-download-cli`, `platform setup`, `platform start`, with the Node range equal to `requirements.node`. The privacy scan passes. |
| OPS-9a | Doctor: env, runtime, storage | `manager-core/platform/doctor.js`, `checks/{env,runtime,storage}.js`, tests, golden part 1 | OPS-4, OPS-5 | M | Each check gives pass, warn and fail cases with injected probes. `runtime.images` distinguishes auto-pull from explicit-pull runtimes (00 §9.2). The Windows facts batch makes one PowerShell call (asserted). `platform doctor --json` matches the golden. |
| OPS-9b | Doctor: network, security, ops and fix runner | `checks/{network,security,ops}.js`, `runFix`, `doctor --fix`, tests, golden part 2 | OPS-9a, OPS-10, OPS-6, ENG-11 | M | The nightly streak computes 30 from the BOM fixtures. `sec.secret-store`, `sec.plaintext-secrets`, `net.manager-bind` and `net.search-upstream` pass their cases. `pull-image` goes only through the manager's `POST /api/runtimes/:runtimeId/pull` (no `docker pull` exec). `manual` fixes are never executed (spy). `confirm` fixes require `--yes` or a prompt. A fix on a running component goes through the supervisor idle gate. |
| OPS-11a | Post-deploy core | `manager-core/platform/deploy-steps.js`, `scripts/deploy-worktree.ps1` (`-Restart`, `-NoPrune`, `-SkipPostDeploy`), `platform post-deploy`, `platform deps --record`, `install-all.cmd` (record step), tests | OPS-10, OPS-7a, OPS-1 | L | On a fixture live root built from two manifests: stale unmodified files are pruned with a backup, and drifted ones are kept. A lock change triggers a staged install (fake npm) and swap, or `pendingSwap` on a simulated EBUSY. A stamp mismatch triggers an MCP build. `version.json` is written. `deployment-manifest.json` is byte-compatible (`Get-LiveDrift` still parses it). `-WhatIf` prints the plan only. |
| OPS-11b | Deploy restarts, `platform deploy`, live-root update | `deploy-steps.js` (restart), `platformctl.js` (`deploy`, `update`), `scripts/update-platform.ps1`, `docs/update-guide.md`, tests | OPS-11a, OPS-7b | M | `--restart changed` maps paths to components and queues busy ones. A `supervisor` change triggers re-exec first. Without the supervisor, it prints commands and exits 0. `update-platform.ps1` in a fake live root without `-Delegate` exits 2 with the bilingual message. `deploy` refuses in a live root. |
| OPS-12 | Autostart, re-exec, restore, notifications, toasts | `manager-core/platform/autostart.js`, `supervisor.js` (re-exec, working set, restore, nightly watch, toast subscriber), `platform autostart`, tests | OPS-6, OPS-7b, ENT-EV, ENG-8 | M | The autostart command builder is unit-tested (task XML/PS script text and the Run-key fallback) **without** registering anything. `enable` refuses a worktree root. Re-exec keeps fake children. The §14 restore cases pass: add/skip only, never `replace`, conflict notification, admission stop, legacy degrade to `offer`. A nightly `ok:false` emits one notification per report in the 00 §9.6 shape. The toast loop guard holds. |
| OPS-13 | Entry platform routes and integration | `service-entry/lib/platform-routes.js` (routes, viewer registrations, events bridge, `delegateManager`), `service-entry/server.js` (one mount line in ENT-EV's table; `/api/status` `platform` field; delegation calls in the existing manager start/stop and stop-all handlers; `startDetachedManager` host and port from `readSection`), `service-entry/test/platform-routes.test.js` | OPS-6, OPS-9b, OPS-10, OPS-3a, ENT-EV, PUB-5 | L | The access matrix and registry cases in §14 pass. Probe-only fallback works with no supervisor. `/api/status` keeps every legacy key (deep-equal on a fixture except `startCommand`, `allCommand` and `platform`). Config PUT validates, writes atomically through `writePlatformConfig` and returns `restartRequired`. No client header reaches the pipe (asserted on a fake server). `events.js` is not modified by this package (diff check). |
| OPS-14 | Setup wizard backend and CLI | `manager-core/platform/setup.js`, `platform setup`, `/api/platform/setup*`, `scripts/install-download-cli.ps1` (progress output only if needed), tests | OPS-9b, OPS-13, ENG-11 | M | Step states derive from doctor. Each step's action runs as a supervisor operation with streamed progress (fake runners). The `images` step uses the manager pull endpoint and never spawns `docker pull`. The `ops` step never registers tasks from the API. `--non-interactive --yes` completes on a fixture root with fakes. |
| OPS-15 | **Retired** → 07 (00 §9.16) | none in this spec. §11 (pages, data, copy, `platform` i18n area) and the old Playwright cases become acceptance criteria of 07's System and setup CON packages | — | — | — |
| OPS-16 | Nightly, setx migration, troubleshooting, `exposure setup` wrapper | `scripts/nightly-e2e.ps1` (adds a `platform status --json` step and a `serving` step; keeps the existing probes), `platform config import-env`, `platform exposure setup` (wrapper only), `docs/troubleshooting.md` (new; incl. secret rollback), `release-manifest.json` | OPS-7a, OPS-3a, PUB-20 | S | The nightly report gains `steps[].name = "platform status"` with readiness layers, and existing step names are unchanged. `import-env --apply` writes `platform.json` and the secret store in a temp root, and never calls `reg delete` without a TTY confirmation (spy). `exposure setup --DryRun` invokes `setup-public.ps1` with the arguments passed through (exec spy), and this package does not modify `setup-public.ps1`. README links resolve in the release build. |
