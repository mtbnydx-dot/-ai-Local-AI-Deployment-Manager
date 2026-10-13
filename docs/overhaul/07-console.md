# 07 — Unified console and design system (P7)

Status: design spec, binding for the `-console` workstream and for the wave-1 entry package **ENT-EV**. It conforms to `00-decisions-and-contracts.md` (D1, D2, D8, §2 layout, §4 objects, §5 proxy, §7 rules) **including the §9 cross-check amendments**. What it still needs from 00 or 01–06 is listed in §15.

This spec was aligned with 01–06 as written on 2026-10-14 and with 00 §9. Endpoint names below are theirs. Ownership:
- 07 owns **every path under `service-entry/console/`** (00 §9.16). Page requirements from 01 (§23 copy), 02 (§18), 05 (§13.4–13.7; PUB-21/22 retired) and 06 (§11; OPS-15 retired) are acceptance criteria of the CON packages; engineers from those specs may build them inside the CON package, in 07's layout.
- 07 owns **ENT-EV** (00 §9.6): `service-entry/lib/events.js`, the manager event relay, the management proxy `/api/m/:managerId/*` and the route-mount table in `server.js` (§2.7–§2.11). It is scheduled first in the entry `server.js` lane (wave 1, P1 timeframe), because 01, 02, 03, 04 and 06 build on it.
- 05 owns admin sessions, CSRF, the elevation cookie, the `console-session` principal and `lib/viewer-allowlist.js`. 06 owns `/api/platform/*` and `getBuildId()`; the System and `/setup` pages are 07's (CON-24, CON-24b, CON-25).

Diagnosis inputs: the frontend, startup, downloads, stats, public, params, newmodels and engines slices. These facts were re-checked in the worktree:

- `service-entry/server.js:207` serves the 2.9k-line `index.html` at `/`.
- `/shared-js/tokens.css` is the only shared asset the entry serves (`:211`).
- `serveFile` always sends `no-store` and `x-frame-options: DENY` (`:456-467`).
- Billing and TTS send `frame-ancestors 'none'` (`:51,204`).
- The theme bug is real: `tokens.css` loads at `index.html:995` after the inline `:root`, and `button:hover{background:var(--surface-3)}` is at `:138`.
- The branch playground is `index.html:2680-2891`.
- `checkRequest` enforces the Host allowlist and same-site Origin, and `checkManagementAccess` allows loopback or `SERVICE_ENTRY_ALLOW_LAN_ADMIN` (`lib/security.js`).
- The release privacy scan does a case-insensitive substring search for USERNAME, COMPUTERNAME and the project root in every staged `.js`/`.json`/`.html`/`.md` (`build-github-release.ps1:266-300`).
- Robocopy excludes `dist`, `cache`, `logs` and `models` directories (`:53-107`).

## 0. Scope

**In scope**
- The one console at `http://<host>:5176/`.
- Its serving layer: shell, build id, CSP, snapshot, bootstrap, i18n merge.
- Client architecture: router, store, events, API client, guards, i18n, preferences.
- The design system: tokens and components.
- Every page and the first-run wizard.
- Mobile and accessibility.
- Migration of `/`, `/billing` and the manager UIs.
- Tests and delivery order.

**Also in scope (ENT-EV, wave 1)**: the entry event bus `GET /api/events` and `GET /api/events/recent` (`lib/events.js`), the relay of manager `jobs` and `instances` events (`lib/manager-event-relay.js`), the management proxy (`lib/mgmt-proxy.js`), the request-auth seam (`lib/request-auth.js`) and the route-mount table in `server.js`.

**Out of scope** (consumed): the manager APIs behind the proxy, and the entry backends `/api/engines*` (01), `/api/models/*`, `/api/launch/*`, `/api/launches/*` and `/api/knowledge*` (02), `/api/hub/*` (03), `/api/telemetry/*` and `/api/audit/*` (04), and `/api/session*`, `/api/access/*`, `/api/public/*` and `/api/security/*` (05). Also out of scope: `/api/platform/*` (06), the public portal (05), and TTS workbench internals.

**Inherited rules**: no bundler and no CDN; no new npm dependency in `service-entry` or `manager-core`; no implicit container stop (every destructive action goes through a ConfirmDialog); no plaintext key persisted, including browser storage; no absolute user paths or domains in tracked files. After OPS-2, packages never edit the root `package.json` or `test-all.cmd` to register tests (00 §9.15); after OPS-1, release inclusion is edited only in `release-manifest.json`.

## 1. Decisions made in this spec

| # | Decision | Why |
|---|---|---|
| C1 | **Preact 10.29.8** (not 11.0.1), **htm 3.1.1**, **uPlot 1.6.32**, **qrcode-generator 2.0.4** and a generated **lucide 0.454.0** ESM subset, in the one vendor tree `shared-public/vendor/<pkg>/<version>/` (00 §9.16), shared with the 05 portal. Console code avoids APIs that Preact 11 changes: no `defaultProps` on function components, no `this.base`, no string refs, no `options` hooks, no `preact/compat`. htm is bound locally (`html = htm.bind(h)`). | 11.0.0 shipped 2026-09-30 and 11.0.1 on 2026-10-08, so a fresh major has had no soak on an offline box. 10.29.8 (2026-08-01) is the mature line, with hooks and htm long proven. With the API rules above, a later upgrade is a directory swap plus a test run. uPlot 1.6.32 (2025-03) is the latest and is stable. |
| C1b | **No import map; relative module specifiers.** Vendor paths appear only in `console/ui/vendor.js` (static re-exports) and `console/ui/vendor-lazy.js` (dynamic `import()` for uPlot and qrcode). Vendoring rewrites the one bare import in the tree (`hooks.module.js` imports `"preact"`) to `"./preact.module.js"`. The console CSP is then plain `script-src 'self'`. | 00 §9.16 allows either option. With no inline executable script there is no CSP hash to compute. The 05 portal may keep its hashed import map (05 §12.1): its mapped `preact` and the hooks file's relative import resolve to the same URL, so one module instance loads either way. |
| C2 | **Content-hash build id with an in-memory snapshot.** `console/**`, `vendor/**` and `shared-public/styles/**` are served under `/c/<buildId>/…` with `immutable`. `buildId` is the `contentHash` from 06 `getBuildId({ aiRoot })` (00 §9.16, the single source; OPS-10 hashes `service-entry/console`, `service-entry/portal`, `shared-public/vendor` and `shared-public/styles`, re-stats at most every 2 s and re-hashes only changed files). The snapshot is rebuilt when an HTML request sees a new `contentHash`. The previous id stays served; any older id returns 410. | Deploys copy files without a restart (startup slice), so a startup-only id would serve new bytes under an old immutable URL. |
| C3 | **History-API routes with clean paths.** The server falls back to the shell for a fixed list of prefixes. Old hash bookmarks redirect client-side. | Deep links and shareable observability views. |
| C4 | **Framework-free `console/lib/`.** Pure ESM, run under `node --test` with no DOM. Only `ui/`, `components/` and `routes/` import Preact. | Real unit and golden tests for store, guards, i18n, router, the wizard model and the schema-form model. |
| C5 | **Key-based catalogs split per area** (00 §9.16): `console/i18n/<area>/{zh-CN,en-US}.json` for areas `shell`, `models`, `hub`, `telemetry`, `access`, `platform` and `engines`. The snapshot merges them into one catalog per locale. A strict test checks locale parity and that no key is defined in two areas. Data text from backends uses `{zh,en}` objects. | Replaces the MutationObserver translator; English becomes first-class. Per-area files keep the catalogs from becoming a hot file shared by six workstreams. |
| C6 | **Preferences** live in `localStorage` `console.prefs.v1`, mirrored to a `console_prefs` cookie. The server injects `lang`, `data-theme` and `data-density` into the HTML. | One origin; no flash of the wrong theme; nothing server-side to migrate. |
| C7 | **Server-decided role**, using 05's vocabulary: bootstrap returns `role: owner\|viewer\|none`. Before 05's PUB-5, owner means `checkManagementAccess(req).ok`. After it, a loopback caller without a session is a **viewer** (00 §9.8); owner needs 05's admin session (pairing, HttpOnly cookie, `x-csrf-token` on every non-GET), kept frictionless by first-run auto-pair and the long-lived loopback session. A viewer sees only pages backed by 05's viewer allowlist (§5) and gets no write controls. The server stays authoritative: 401 `admin_session_required`, 403 `csrf_invalid` or 403 `management_local_only`. | 00 §5, §9.8; 05 §5. |
| C8 | **Billing embedded first.** The legacy page moves to `/billing/classic` (must-keep, 00 §9.13), framable only same-origin. `/billing` becomes the console route and embeds it. The native port comes in C4. | 744 lines of billing Playwright pins and immutable-ledger confirmations stay green while the shell ships. |
| C9 | **Voice links out** to the TTS workbench and shows engine status and lifecycle natively. Its actions use the `console-session` principal (§10). | TTS keeps `frame-ancestors 'none'` and its own release cadence. |
| C10 | **Default-UI flag.** `/` serves classic until CON-26 sets `console.defaultUi = "new"` (06 OPS-3 owns the key, 00 §9.5). Env `SERVICE_ENTRY_CONSOLE_DEFAULT` overrides it. `/classic` lives until CON-28. | Incremental shipping without breaking the daily path. |
| C11 | **No manager-port URLs.** Every manager call goes through `/api/m/:managerId/*` (ENT-EV2), and every cross-app link is relative or built from `location.hostname`. | Removes the hard-coded loopback-link bug class (frontend finding 7). |
| C12 | **axe-core 4.13.0** (2026-08-05), a root `devDependency` added by **06 OPS-2** (00 §9.15) and injected with `page.addScriptTag`. No `@axe-core/playwright`. | 00 forbids new dependencies only in `manager-core` and `service-entry`. 4.14.0 is 9 days old. One owner of the root `package.json` and lockfile. |
| C13 | **The console never sends an API key to the gateway** on the ADMIN listener. Playground and Voice calls carry the admin session cookie plus `x-csrf-token`, and 05 maps them to the `console-session` principal (05 §5.8: the chat and TTS scope families plus `debug.route`, telemetry client `console`; 00 §9.8). | A key in browser storage would break the 00 no-plaintext rule; a paired owner already holds a stronger credential. |

## 2. Serving (server side)

### 2.1 Files

```
service-entry/
  index.html  billing.html        unchanged content (classic console at /classic; billing at /billing/classic, + embed mode)
  server.js                       ENT-EV1: ROUTE_MODULES mount table (§2.7); later packages add one line each
  lib/events.js                   ENT-EV1: event bus, ring, ids, replay, /api/events, /api/events/recent (§2.8)
  lib/request-auth.js             ENT-EV1: principal + viewer-registry seam; 05 PUB-25/PUB-5 plug in (§2.9)
  lib/mgmt-proxy.js               ENT-EV2: /api/m/:managerId/* (§2.10)
  lib/manager-event-relay.js      ENT-EV3: manager jobs/instances → bus (§2.11)
  lib/console-routes.js           CON-2: shell, snapshot, /c/*, SPA fallback, /classic, bootstrap, i18n merge
  console/                        07 owns every path below (00 §9.16)
    package.json                  {"private":true,"type":"module"}  (module-type marker only, no deps)
    index.html app.js routes.js
    lib/*.js  ui/{html,hooks,context,vendor,vendor-lazy}.js  components/*.js  routes/**/*.js
    data/{nav,client-guides,metric-ids}.js
    i18n/<area>/{zh-CN,en-US}.json [+ dynamic-keys.json]   areas: shell models hub telemetry access platform engines
    styles/{base,components,charts}.css  assets/{favicon,logo}.svg
  test/console/package.json       {"type":"module"} marker, so test/console/*.test.js are ESM (OPS-2 glob */test/**/*.test.js)
shared-public/
  styles/tokens.css               the one token file (00 §9.16), used by the console and the 05 portal
  vendor/VENDOR.json
  vendor/preact/10.29.8/{preact.module.js,hooks.module.js,LICENSE}   vendor/htm/3.1.1/{htm.module.js,LICENSE}
  vendor/uplot/1.6.32/{uPlot.esm.js,uPlot.min.css,LICENSE}           vendor/qrcode/2.0.4/{qrcode.mjs,LICENSE}
  vendor/lucide/0.454.0/{icons.js,LICENSE}                           (generated, listed in VENDOR.json)
scripts/vendor-browser-libs.mjs   NEW, dev-only; never run by install or test
scripts/build-lucide-subset.cjs   EXTENDED: also emits vendor/lucide/0.454.0/icons.js (ESM)
tests/frontend/console/*.spec.js  Playwright (OPS-2 glob tests/frontend/**/*.spec.js); helpers in tests/frontend/helpers/
```

`shared-public/js/tokens.css` (served at `/shared-js/tokens.css`) stays frozen for the classic console and the manager UIs and is deleted with them; no new UI reads it. `service-entry`, `shared-public` and `scripts` are already release directories, and no robocopy exclude matches `console`, `vendor` or `styles`. After OPS-1, CON-1 adds `shared-public/vendor/**` and `shared-public/styles/**`, and CON-2 adds `service-entry/console/**`, to `release-manifest.json` as included globs, once; later CON packages never touch it.

### 2.2 Vendored libraries

| Package | Version | Files (tarball source) | License | Raw size |
|---|---|---|---|---|
| preact | 10.29.8 | `dist/preact.module.js`; `hooks/dist/hooks.module.js` (imports bare `preact`) | MIT | about 12 KB + 4 KB |
| htm | 3.1.1 | `dist/htm.module.js` | Apache-2.0 | about 1.5 KB |
| uplot | 1.6.32 | `dist/uPlot.esm.js`, `dist/uPlot.min.css` | MIT | about 140 KB, lazy only |
| lucide | 0.454.0 | `icons.js`, generated from `scripts/vendor/lucide.full.min.js` | ISC | about 20 KB |
| qrcode-generator | 2.0.4 | `dist/qrcode.mjs` (default export `qrcode(typeNumber, ecl)`) | MIT | about 20 KB, lazy only (Access key reveal, pairing QR) |

`VENDOR.json` (schemaVersion 1, `asOf`, `staleAfterDays: 180`) is the single source for the integrity test and for both UIs' entry points. CON-1 owns the tree; 05 PUB-15 reuses it and never vendors a second copy.

```json
{ "schemaVersion": 1, "asOf": "2026-10-14", "staleAfterDays": 180,
  "packages": [ { "name": "preact", "version": "10.29.8", "license": "MIT", "source": "npm:preact@10.29.8", "dir": "preact/10.29.8",
      "entries": { "preact": "preact.module.js", "preact/hooks": "hooks.module.js" },
      "files": [ { "path": "preact.module.js", "from": "dist/preact.module.js", "sha256": "…", "bytes": 11000 },
                 { "path": "hooks.module.js", "from": "hooks/dist/hooks.module.js", "sha256": "…", "bytes": 3900,
                   "rewrites": [ { "from": "\"preact\"", "to": "\"./preact.module.js\"" } ] },
                 { "path": "LICENSE", "from": "LICENSE", "sha256": "…", "bytes": 1080 } ] },
    { "name": "lucide", "version": "0.454.0", "license": "ISC", "generated": "scripts/build-lucide-subset.cjs", "dir": "lucide/0.454.0", "…": "…" } ],
  "styles": { "uplot": "uplot/1.6.32/uPlot.min.css" } }
```

**Vendoring** (an engineer with network access): `node scripts/vendor-browser-libs.mjs preact@10.29.8 htm@3.1.1 uplot@1.6.32 qrcode-generator@2.0.4`. For each spec the script:
1. runs `npm pack` into a new empty temp directory;
2. extracts with `tar -xzf`, never running package code;
3. copies the listed files and `LICENSE*`;
4. strips `//# sourceMappingURL=` lines and applies the listed `rewrites` (exact-match, each must hit exactly once);
5. writes the post-processing sha256 and byte counts into `VENDOR.json`.

Lucide comes from `build-lucide-subset.cjs`, which now also scans `service-entry/console/**/*.js` for `icon("…")` and `<Icon name="…">`. Its missing ISC `LICENSE` is added once by hand.

**Integrity test** `service-entry/test/console/vendor.test.js` asserts:
- every listed file exists with its sha256 and size;
- each package has a non-empty `LICENSE` containing its SPDX keyword;
- every `entries` and `styles` target exists, and `console/ui/vendor.js` and `vendor-lazy.js` reference exactly those paths;
- no vendored file contains a bare import specifier (`/\bfrom\s*["'][^./]/`, `import\(["'][^./]`), `sourceMappingURL`, `//unpkg`, `cdn.`, or `http(s)://` import specifiers;
- no vendored file contains `os.userInfo().username` or `os.hostname()` (case-insensitive). This catches early what the release privacy scan would reject; if it fires, pick another patch version.

### 2.3 Shell template, CSP, build id

```html
<!doctype html>
<html lang="%LANG%" %THEME_ATTR% data-density="%DENSITY%">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark"><meta name="console-build" content="%BUILD_ID%">
  <title>%TITLE%</title>
  <link rel="icon" type="image/svg+xml" href="/c/%BUILD_ID%/assets/favicon.svg">
  <link rel="stylesheet" href="/c/%BUILD_ID%/shared/styles/tokens.css">
  <link rel="stylesheet" href="/c/%BUILD_ID%/styles/base.css">
  <link rel="stylesheet" href="/c/%BUILD_ID%/styles/components.css">
  <link rel="modulepreload" href="/c/%BUILD_ID%/app.js">
  <script type="application/json" id="console-bootstrap">%BOOTSTRAP_JSON%</script>
  <script type="module" src="/c/%BUILD_ID%/app.js"></script>
</head>
<body><div id="app" aria-busy="true"><p class="boot-splash">%BOOT_TEXT%</p><noscript>%NOSCRIPT_TEXT%</noscript></div></body>
</html>
```

**Placeholders**
- `%BUILD_ID%` is the snapshot's `contentHash`.
- `%BOOTSTRAP_JSON%` is the §2.5 object with `<` escaped as `<`; it is a non-executable data block, which `script-src` does not govern.
- `%BOOT_TEXT%` is `正在加载控制台… / Loading console…` and `%NOSCRIPT_TEXT%` is `需要启用 JavaScript / JavaScript is required`; one language is injected.
- `%THEME_ATTR%` is `data-theme="dark|light"`, or empty for auto.

**Shell response headers**

```
content-security-policy: default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; media-src 'self' blob:;
  base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; worker-src 'none'
x-frame-options: DENY  referrer-policy: no-referrer  x-content-type-options: nosniff
permissions-policy: camera=(), microphone=(), geolocation=()  cache-control: no-store
```

Preact writes styles through CSSOM, which `style-src 'self'` allows. Components never call `setAttribute("style",…)`.

**Snapshot** (`computeSnapshot()`)
- Walks `console/` (as `/`), `shared-public/vendor/` (as `vendor/`) and `shared-public/styles/` (as `shared/styles/`), taking only `.js .mjs .css .json .svg .woff2` and `LICENSE`, and skipping `console/package.json` and the raw `console/i18n/**` files.
- Adds two virtual files, `i18n/zh-CN.json` and `i18n/en-US.json`, from `mergeI18nAreas()` (§3.7).
- `{ commit, contentHash } = core.platform.getBuildId({ aiRoot })` (06 OPS-10, wave 1; CON-2 depends on it and computes no id of its own). The snapshot reads its files, then calls `getBuildId` again; if the hash moved during the read (a deploy in progress), it rebuilds, at most 3 times, and otherwise keeps the previous snapshot. `commit` feeds bootstrap `platform.commit`.
- Each entry stores raw, gzip and brotli (quality 5) bodies plus the MIME type.
- Two snapshots are kept, about 4 MB.

### 2.4 Routes (`lib/console-routes.js`)

`console-routes.js` is a route module (§2.7): `mount(ctx)` calls `createConsoleRoutes({ rootDir, vendorDir, stylesDir, classicHtml, billingHtml, auth: ctx.auth, getDefaultUi, features: ctx.features, getBuildId, now })`, which returns `{ handle(req, res, url): Promise<boolean>, snapshot(), bootstrap(req) }`. It is one line in `ROUTE_MODULES`, so it runs after `checkRequest` and the proxied-request guard and before the inline `/`, `/billing` and `/docs/` handlers; when it declines a path (classic default) the inline handler answers as today. It registers its viewer-readable paths (`/classic`, the SPA prefixes, `/c/*`, `/api/console/bootstrap`) through `ctx.auth.viewerRegistry.registerRoute()` (§2.9).

| Method + path | Behaviour |
|---|---|
| `GET /` | Shell when the default UI is `new`, otherwise the classic console. `?ui=new\|classic` overrides per request. |
| `GET /{overview,deployments,models,engines,playground,observability,audit,alerts,access,billing,voice,system,setup}[/**]` | Shell, only when `Accept` contains `text/html`; otherwise 404 JSON as today. |
| `GET /classic` | Old `index.html`, byte-for-byte, with current headers. |
| `GET /billing/classic` | Legacy billing page (must-keep, 00 §9.13), local-only (`isStrictLocalBillingPageRequest`) and owner-gated like `/billing` once PUB-5 lands. Today's billing CSP except `frame-ancestors 'self'` and `x-frame-options: SAMEORIGIN`. `?embed=1` hides the copied sidebar and theme select and honours `?theme=`. |
| `GET /c/:buildId/{vendor,shared/styles}/**`, `GET /c/:buildId/**` | Served from the snapshot. Current or previous id: 200, `cache-control: public, max-age=31536000, immutable`, `etag:"<id>"`, `vary: accept-encoding`, br or gzip. Unknown id: **410** `{ok:false,error:{code:"console_stale",message,hint:"reload"}}`. Path not in the snapshot: 404. Lookups are map-key hits, so path traversal is impossible. |
| `GET /api/console/bootstrap` | §2.5 with a fresh role and the current buildId. |
| `GET /shared-js/tokens.css` | Unchanged (classic page, managers). |

`SERVICE_ENTRY_CONSOLE_DEV=1` rescans on every request and sends `no-store`.

### 2.5 Bootstrap (`GET /api/console/bootstrap`, also embedded in the shell)

```json
{ "ok": true, "buildId": "3f9c2a1b7d0e", "role": "owner",
  "access": { "local": true, "lanViewer": false, "allowLanAdmin": false },
  "auth": { "mode": "loopback-trust", "session": null, "csrf": null },
  "defaults": { "locale": "zh-CN", "theme": "auto", "density": "comfortable" },
  "platform": { "version": "0.2.0", "commit": null, "contentHash": "3f9c2a1b7d0e", "deployedAt": null },
  "managers": [ { "id": "vllm", "label": { "zh": "vLLM / SGLang 管理器", "en": "vLLM / SGLang manager" }, "legacyUiPort": 5177 },
                { "id": "llama", "label": { "zh": "llama.cpp 管理器", "en": "llama.cpp manager" }, "legacyUiPort": 5178 } ],
  "gateway": { "autoOpenAi": "/gateway/auto/openai/v1", "autoClaude": "/gateway/auto/claude", "consoleSession": false },
  "features": { "events": true, "mgmtProxy": true, "engines": false, "models": false, "hub": false, "telemetry": false,
                "alerts": false, "audit": false, "session": false, "access": false, "public": false, "platform": false, "setup": false } }
```

- **`role`** is `owner` iff `security.checkManagementAccess(req).ok` (until 05 PUB-5), otherwise `viewer`. After PUB-5 it is `ctx.auth.principal(req).role` (§2.9): loopback without a session is `viewer`. Proxied requests never reach the console.
- **`auth.mode: "session"`** once 05's sessions are mounted. `auth.session` is then the 05 §5.6 `GET /api/session` body minus the token (`{role, via, paired, autoPairAvailable}`), and `auth.csrf` is its `csrfToken`, which the API client sends as `x-csrf-token` on every non-GET. It lives in memory only. The bootstrap is `no-store` and same-origin, so embedding it adds no exposure beyond what `/api/session` already returns. With no session the role is `viewer` (or `none`, which renders only the PairingScreen), `auth.session.paired` is false, and owner-only routes show the PairingScreen (§6.15).
- **`gateway.consoleSession`** is true once 05 accepts the `console-session` principal on ADMIN gateway paths (C13). While false, Playground falls back to an in-memory key field (§6.6) and Voice actions keep today's gateway rules.
- **`features`** is filled by the route-mount table (§2.7): each mounted module with a `feature` name turns it on, and a module that failed to mount leaves it off. A page whose feature is off renders its degrade path (§6) or an EmptyState `该功能需要后端组件 {phase} / Requires backend component {phase}`.
- **`platform`** comes from 06 `readVersion()` (`<AI_ROOT>/version.json`, written by deploy) and the snapshot's `getBuildId()` result; fields are null when absent.

### 2.6 Server failure modes

| Failure | Behaviour |
|---|---|
| Vendor file missing or `VENDOR.json` invalid | Snapshot fails, `/` falls back to classic, and one log line is written. The unit test catches it first. |
| Read error mid-deploy (file locked) | Keep the previous snapshot and retry on the next HTML request. Never serve a partial snapshot. |
| Old tab lazy-loads a route after a deploy | The previous snapshot still serves it. Older ids get 410, the router catches it, and the update banner appears. |
| No brotli | Serve gzip or raw. |
| Tampered `console_prefs` cookie | Values are allowlisted; anything else is ignored. |
| An i18n area file is invalid JSON, or defines a key another area already defines | That area file is left out of the merged catalog and one log line names it; the pages show key names for its keys. The `i18n.test.js` gate fails first in CI. |
| 06 `getBuildId()` throws `build_id_unavailable` (unreadable file) | Keep serving the previous snapshot and retry on the next HTML request; with no snapshot yet, `/` serves classic and one log line is written. |

### 2.7 Route-mount table (ENT-EV1, `service-entry/server.js`)

Every new entry backend is a route module, and `server.js` lists them once:

```js
// service-entry/server.js — order matters (first module that returns true wins). One line per package.
const ROUTE_MODULES = [
  "./lib/events",            // ENT-EV1  /api/events, /api/events/recent
  "./lib/mgmt-proxy",        // ENT-EV2  /api/m/:managerId/*
  "./lib/manager-event-relay", // ENT-EV3  no routes; starts the relay and sets ctx.relay
  // "./lib/engine-routes",  // 01 ENG-19     "./lib/hub-routes",       // 03 HUB-7
  // "./lib/telemetry-routes", // 04 TEL-*    "./lib/admin-session",    // 05 PUB-5
  // "./lib/platform-routes",  // 06 OPS-13   "./lib/console-routes",   // 07 CON-2
];
// route module contract (CommonJS)
module.exports = { name: "hub", feature: "hub" /* optional; turns on bootstrap features.hub */,
  mount(ctx) { return { handle: async (req, res, url) => false /* true = handled */, close() {} }; } };
// ctx = { rootDir, aiRoot, managers: [{ id, port }], security, auth /* §2.9 */, bus /* §2.8 */, relay /* §2.11; null until mounted */,
//         features, sendJson, readJsonObjectBody, logger, now }  — one shared object; modules read ctx.relay at call time
```

- `startServiceEntry()` creates `bus` and `auth`, then mounts each module in order inside try/catch. A module that throws is skipped, its feature stays off, and one log line names it; the entry keeps serving.
- `handleRequest` runs `checkRequest`, the proxied-request guard, 05's pre-dispatch `guard` (once PUB-25 lands) and `handleBillingHttpRequest`, then the mounted modules, then today's inline routes unchanged. A module must never claim `/gateway/*` (the test sends `/gateway/x` to every mounted module) and never mounts on the PUBLIC listener, which has its own router (05 PUB-6).
- Server `close` calls each `close()` (timers, relay sockets, SSE clients).
- Tests (`service-entry/test/route-mount.test.js`): order and first-match; a throwing module is skipped and others work; feature flags follow mounting; no module answers `/gateway/*`; legacy routes (`/api/status`, `/api/fleet`, `/billing`) are byte-identical with all modules mounted.

### 2.8 Event bus (ENT-EV1, `service-entry/lib/events.js`)

```js
const EVENT_TYPES = { status, instances, jobs, downloads, library, alerts, "telemetry.live", notification, platform, security, access }; // 00 §9.6
function createEventBus({ now = Date.now, ringSize = 500, ringBytes = 4 << 20, storeCapBytes = 64 << 10, heartbeatMs = 15000,
                          maxClients = 64, maxClientsPerIp = 8, auth, logger })
// → { publish(type, data, { source } = {}) → envelope | null,
//     subscribe(fn, { types } = {}) → off,            // in-process consumers (04 collectors, OPS-13 bridge)
//     subscriberCount({ types, client, principal } = {}) → number, // SSE + in-process subscribers that would receive any of `types` (04 skips idle work)
//     recent({ since, types, limit = 100, role }) → { events, lastId, gap },
//     handleSse(req, res, { role, types, lastEventId }), stats(), close() }
module.exports = { createEventBus, EVENT_TYPES, name: "events", feature: "events", mount }; // mount serves the two routes below
```

**Envelope** (00 §4.5, plus `id`): `{ "id": "k3f9a2-1042", "type": "jobs", "at": "ISO", "source": "vllm", "data": {…} }`. `id` is `<bootId>-<seq>`: `bootId` is 6 base36 characters fixed per process start, and `seq` increases by one per published event.

**publish**
- `type` must be in `EVENT_TYPES`; `source` defaults per type and must be one of `entry|vllm|llama|hub|telemetry|platform`. `data` must be a JSON-serialisable object.
- Payload checks per type (§3.6 lists the shapes). `notification` is validated strictly against 00 §9.6: `{kind, severity: info|success|warn|error, title{zh,en}, body?{zh,en}, action?{label{zh,en}, href | apiCall{method, path, body?}}}`; `href` and `apiCall.path` must be same-origin relative (`/…`, not `//…`), and `apiCall.path` must start with `/api/`. Extra keys (04's `dedupeKey`) pass through.
- A rejected event returns `null`, increments `stats().rejected[type]` and logs once per type and reason. `publish` never throws into the caller's path.
- The envelope goes to in-process subscribers (errors caught), then to SSE clients, then into the ring.

**Ring and replay**
- The ring keeps the last 500 envelopes and at most 4 MiB. An envelope larger than 64 KiB is delivered live but stored as `{…, "data": { "truncated": true }}`, so a replaying client refetches instead.
- `GET /api/events?types=a,b&client=<label>` (types optional; unknown names are ignored; types the principal may not receive are removed; `client` is a free label such as `supervisor` or `console`, kept for `subscriberCount({client})` and logs). `Last-Event-ID` comes from the request header (sent by `EventSource` on auto-reconnect) or `?lastEventId=` (used by the console when it opens a new `EventSource` after polling).
- If `bootId` matches and `seq` is still in the ring, the matching envelopes after it are written first, then live events. Otherwise the stream starts with the control event `{type:"resync", data:{reason:"restart"|"gap"}}`, and the client invalidates every evented key.
- `GET /api/events/recent?since=<id>&types=&limit=100` (limit ≤ 500) → `{ ok: true, bootId, events: [envelope], lastId, gap }`. `gap` is true when `since` is from another boot or older than the ring. No `since` returns the last `limit` events.

**Wire format**
```
retry: 3000

id: k3f9a2-1042
event: jobs
data: {"id":"k3f9a2-1042","type":"jobs","at":"2026-10-14T08:00:00.000Z","source":"vllm","data":{"managerId":"vllm","jobs":[…],"removed":[]}}

: ping 1760428800000
```
- A heartbeat comment is sent every 15 s.
- Response headers: `content-type: text/event-stream; charset=utf-8`, `cache-control: no-store`, `x-accel-buffering: no`.
- Back-pressure: when a client's buffered bytes exceed 1 MiB, it is dropped and reconnects with `Last-Event-ID`.
- Above 64 clients, or 8 per remote IP, the response is 503 `too_many_streams`.

**Access**: the principal comes from `auth.principal(req)` (§2.9). The allowed types are `auth.eventTypesFor(principal)`: `"*"` for owners, the registered viewer types for viewers (baseline `status`, `instances`; 03, 04 and 06 register theirs), and 05's fixed sets for machine principals (`system:supervisor`, `system:hub-shim:*`). When `principal.redact` is true, each event passes through `viewerRegistry.redactEvent(type, data, ctx)`, and a `null` result drops it. `/api/events/recent` applies the same filter. Neither route mutates anything, so neither needs CSRF.

**Tests** (`service-entry/test/events.test.js`): type and notification validation; rejected events never throw; `id` monotonic; ring limits by count and by bytes; oversize stored truncated; replay after `Last-Event-ID` (header and query) is gap-free and type-filtered; another boot or an evicted id gives `resync`; `/recent` with and without `since`; viewer filtering and redaction for SSE and `/recent`; heartbeat; slow-client drop; client caps; `subscriberCount({types})` counts only matching clients; `close()` ends every stream.

### 2.9 Request-auth seam (ENT-EV1, `service-entry/lib/request-auth.js`)

ENT-EV lands before 05's PUB-25 (viewer registry) and PUB-5 (sessions). The seam gives every entry module 05's API names from day one, so nothing changes in the modules when 05 lands.

```js
function createRequestAuth({ security, adminAuth = null /* 05 createAdminAuth */, viewerRegistry = null /* 05 createViewerRegistry */ })
// → { principal(req) → { role: "owner"|"system"|"viewer"|"none", via, redact: boolean },        // = adminAuth.authenticate(req) when present
//     checkWrite(req) → { ok: true } | { ok: false, status, code, message },                   // = adminAuth.checkManagementAccess(req, { write: true })
//     eventTypesFor(principal) → "*" | Set<string>,                                             // = adminAuth.eventTypesFor
//     viewerRegistry,   // 05's registry, or the built-in subset below with the same method names:
//                       // registerRoute({ owner, method, path, redact }), registerAdminOnly({ owner, method, path }),
//                       // registerEventType({ owner, type, redact }), match(method, pathname), viewerEventTypes(), redactEvent(type, data, ctx)
//     redactFor(req, pathname, body) → body }   // applies the matched entry's redact when principal.redact; used where sendJson is bypassed
```

- **Before PUB-25/PUB-5** the seam reproduces today: `principal` is owner iff `security.checkManagementAccess(req).ok`, otherwise viewer with `redact:true`; `checkWrite` is that same check; `eventTypesFor` is `"*"` for owners and the registered viewer types otherwise. The built-in registry is preloaded with 05 §5.4's baseline that ENT-EV needs: events `status` (`redactStatusForRemote`) and `instances` (ids and states only).
- **When 05 lands**, `startServiceEntry()` passes `adminAuth` and the real `viewer-allowlist.js` registry, and the seam only delegates. Registrations made through the built-in subset are replayed into 05's registry before `freeze()`. 05's pre-dispatch `guard` runs right after the proxied-request guard, before every mounted module, so unregistered viewer requests never reach a module.
- Every module (events, proxy, console routes, later `*-routes.js`) asks this seam and never calls `security.checkManagementAccess` directly.
- **07's registrations** (owner `"07"`): viewer GET `/classic`, `/c/*`, the SPA prefixes of §2.4, `/api/console/bootstrap` and `/api/events/recent` (both filtered per principal), and the proxied manager reads `/api/m/:managerId/{status,instances,running-models,models,stats,jobs,tools/health}` with a redaction that strips host paths, PIDs, client details and key-shaped fields (`apiKey`, `*Token`, `authorization`). Other specs register their own proxied reads (01: `engines`, `engines/:id/schema`, `runtimes/:rid/flags`); every unregistered `/api/m/*` path stays admin-only by 05's deny-by-default.
- Tests (`service-entry/test/request-auth.test.js`): the legacy matrix (loopback owner, LAN viewer, LAN with `SERVICE_ENTRY_ALLOW_LAN_ADMIN` owner); the built-in registry's `match`, event types and redaction; registrations replayed into a stub 05 registry; with stub `adminAuth`, role, CSRF result and event types come from it and loopback without a session is a viewer.

### 2.10 Management proxy (ENT-EV2, `service-entry/lib/mgmt-proxy.js`, implements 00 §5)

`createMgmtProxy({ managers: [{ id, port }], auth, relay, requestTimeoutMs = 30000, now })` → `{ handle(req, res, url): Promise<boolean> }`, mounted as `{ name: "mgmt", feature: "mgmtProxy" }`.

- **Mapping**: `/api/m/<managerId>/<rest>` → `http://127.0.0.1:<port>/api/<rest>`, query string kept. So `/api/m/vllm/engines` is the manager's `/api/engines`. An unknown id returns 404 `unknown_manager`. `<rest>` is normalised and checked: `..`, empty segments, `%2f`, `%5c` or `\` give 400 `invalid_path`.
- **Access**: `GET`/`HEAD` need an owner principal or a viewer match in `auth.viewerRegistry.match("GET", pathname)` (after PUB-25, 05's `guard` already denied unregistered viewer requests). Any other method needs `auth.checkWrite(req)` (owner plus CSRF after PUB-5). Failures return the auth result's status and code; nothing is sent upstream.
- **Request headers forwarded**: `accept`, `content-type`, `content-length` and `last-event-id`, plus `x-request-id`. The proxy always mints `req_<20 base32>` (00 §9.9) and ignores a client-supplied value. Everything else is dropped, including `cookie`, `authorization`, `origin`, `x-csrf-token` and every `x-forwarded-*`. The managers' `isLocalRequest` gate still sees loopback.
- **Responses** stream through unchanged for owners. `text/event-stream` is piped with no buffering or timeout, and the upstream is closed when the client disconnects. Piped responses bypass 05's central `sendJson` redaction, so a JSON response for a principal with `redact:true` is buffered (≤ 4 MiB, otherwise 502 `response_too_large`) and passed through `auth.redactFor(req, pathname, body)`; viewers never get SSE from a manager. Hop-by-hop and `set-cookie` headers are dropped. `x-request-id` is set on every response.
- After a 2xx response to a non-GET, the proxy calls `relay.poke(managerId)`, so `instances` events follow a start or stop within one poll.
- **Errors** use the 00 §4.2 envelope: connect failure 502 `manager_unreachable` (`{managerId, hint}`), timeout 504 `manager_timeout`, request body over 2 MiB 413 `body_too_large`. There are no retries.
- **Tests** (`service-entry/test/mgmt-proxy.test.js`, fake manager on a free port): path mapping (`/api/m/vllm/engines` → `/api/engines`) and query pass-through; traversal and encoded-slash 400; unknown manager 404; header allowlist (no `cookie`, `authorization`, `x-csrf-token` or `x-forwarded-*` upstream); a fresh `x-request-id` even when the client sent one; viewer GET allowlist and redaction; non-GET without owner gives 401/403 with no upstream call; SSE streamed chunk by chunk and the upstream closed on client abort; 502, 504, 413; `poke` called after a 2xx POST only.

### 2.11 Manager event relay (ENT-EV3, `service-entry/lib/manager-event-relay.js`)

Managers today broadcast only `event: jobs` with the full summarised job list, throttled to 700 ms (`vllm-manager/server.js:1073`, `llama-manager/server.js:1184`, `manager-core/sse-hub.js`), and no `instances` event.

```js
function createManagerEventRelay({ bus, managers, httpGet, fetchJson, now, minBackoffMs = 1000, maxBackoffMs = 30000, instancesPollMs = 10000 })
// → { start(), stop(), poke(managerId), status() → [{ managerId, state: "connecting"|"connected"|"down", since, lastEventAt, reconnects, nativeInstances }] }
```

- **Connection**: one `GET http://127.0.0.1:<port>/api/events` per manager. Backoff runs from 1 s doubling to 30 s with ±20 % jitter and resets after 60 s connected. Each state change publishes `status` `{reason:"manager_up"|"manager_down", managerId}` and logs one line, never one line per retry.
- **jobs**: the relay keeps the last summary per job id and publishes only changes: `bus.publish("jobs", { managerId, jobs: [changed JobSummary], removed: [jobId] }, { source: managerId })`. The first message after a (re)connect is diffed against the previous map, so it never floods. Pull jobs (`dl_…`, 01 ENG-11) and probe or qualify jobs ride the same event.
- **instances**: 01 ENG-10/ENG-13 make managers emit `event: instances`. The relay treats it as a trigger: it fingerprints the event's instance list when the payload carries one, otherwise it re-reads `GET /api/instances` once, and publishes the normalised `{ managerId, changed, removed, native: true }`; after the first native event it stops synthesising for that manager. Until then it synthesises: while `bus.subscriberCount({types:["instances"]})` > 0, it polls `GET /api/instances` every 10 s per connected manager, and at once on `poke(managerId)` or when a job changes `state`. It fingerprints each instance as `id|lifecycle.state|lifecycle.phase|running|port|model` and publishes `{ managerId, changed: [instanceId], removed: [instanceId], native: false }` only on a difference.
- The relay only issues GETs and never writes to a manager. Unknown manager event names are ignored.
- **Tests** (`service-entry/test/manager-event-relay.test.js`, fake SSE manager): job diffing (changed, unchanged, removed); reconnect backoff with a fake clock; `status` published once per state change; synthesised `instances` only with subscribers and only on change; `poke` triggers an immediate poll; a native `instances` event disables synthesis; a malformed frame is skipped.

## 3. Client architecture

### 3.1 Module rules (`test/console/lint.test.js`)

1. `lib/**` imports nothing from `ui/`, `vendor/` or the DOM. Vendor paths (`../vendor/<pkg>/<version>/…`) appear only in `ui/vendor.js` and `ui/vendor-lazy.js`; everything else imports `h`, `render`, hooks and `html` from `ui/`. No module touches `document`, `window` or storage at top level; the import-graph test imports every module in Node.
2. Forbidden under `console/`:
   - DOM injection: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `dangerouslySetInnerHTML`, `document.write`, `setAttribute("style"`;
   - code evaluation: `eval(`, `new Function`;
   - hard-coded hosts and ports: `127.0.0.1`, `localhost:`, `:5177`, `:5178`;
   - `http://` outside `data/client-guides.js`.
3. Other placement rules:
   - `fetch(` appears only in `lib/api.js` and `routes/playground.js`.
   - `localStorage`, `sessionStorage` and `document.cookie` appear only in `lib/storage.js`, which wraps every call in try/catch.
   - Han characters appear only in comments; all copy lives in the catalogs.
   - uPlot and qrcode load only through `ui/vendor-lazy.js` (`loadUplot()`, `loadQrcode()`), called only from `components/time-series-chart.js` and `components/qr-code.js`.

### 3.2 Boot (`app.js`)

1. **Pairing first** (05 §5.2). If `location.hash` starts with `#pair=`, take the code, `history.replaceState` the URL without the fragment *before anything else runs*, call `POST /api/session/pair {code}`, and then re-read `GET /api/console/bootstrap`. A 400 `pair_code_invalid` shows the PairingScreen with `pair.invalid` (access area). The code never enters logs, the store or an error report.
2. Read `#console-bootstrap` (or the refreshed copy) and `readPrefs()`.
3. Resolve the locale and fetch `/c/<id>/i18n/<locale>.json`, the snapshot's merge of every area (≤ 120 KB raw).
4. Create the services: api (with the CSRF token from `auth.csrf`), cache, events, router, i18n, toasts.
5. Apply `legacyRedirect` with `history.replaceState`. It ignores `#pair=` and `#key=` fragments.
6. `render()` the App, then clear `aria-busy`. Role `none` renders only the PairingScreen.
7. Open the event stream.
8. If the role is owner, `features.setup` is on, and setup is not dismissed, read `GET /api/platform/setup` (06). If it has no `completedAt` and some step is not `done` or `skipped`, route to `/setup`. Before 06 lands, use the shell's own first-run checks (§6.14).

### 3.3 Router (`lib/router.js`, pure)

```js
export function matchRoute(routes, pathname)            // → { route, params } | null
export function buildHref(routes, name, params, query)  // encodes ids such as "vllm:primary"
export function legacyRedirect(href)                    // → string | null
export function createRouter({ routes, history, location, onChange, guards })
// → { start(), navigate(to, { replace, state }), current, href, addGuard(fn) → off }
// route = { name, path: "/deployments/:fleetId", load: () => import("./routes/deployment-detail.js"),
//           titleKey, section, ownerOnly, viewerReadable, feature, spec: "07"|"06"|"05"|"02" /* whose requirements the page meets */ }
```

**On navigation**
- Set `document.title = t(titleKey) + " · " + t("shell.product")`.
- Focus the `<h1 tabindex=-1>` and announce the title in the polite region.
- Restore scroll on back/forward; otherwise go to the top.

**Guards**
- A guard returns `false` or a Promise to block; the wizard uses this for its unsaved draft.
- A dynamic-import failure or 410 shows the update banner instead of the error boundary.

**Legacy redirects** (unit-tested). Old console hashes: `/#overview`→`/overview`, `/#models`→`/deployments`, `/#tasks`→`/models/downloads`, `/#playground`→`/playground`, `/#voice`→`/voice`, `/#clients`→`/access`, `/#operations`→`/system`. Manager hashes arriving with `?from=<mgr>`: `#service`→`/deployments?manager=<mgr>`, `#download`/`#online-models`→`/models/discover`, `#models`→`/models`, `#stats`→`/observability`, `#external-access`→`/observability/traffic`, `#audit`→`/audit`, `#logs`→`/deployments?manager=<mgr>&tab=logs`, `#exposure`→`/access`, `#tools`→`/system`.

### 3.4 API client, error envelope, runtime guards

```js
// lib/api.js
export class ApiError extends Error {} // { status, code, message, hint, docs, fieldErrors:[{field,code,message,suggestion}], requestId, managerId, details }
export function normalizeError({ status, body, headers, url })  // → ApiError
export function createApiClient({ fetchImpl, timeoutMs = 15000, csrfToken, onReadOnly, onUnpaired, onStale })
// → { request(path, { method, query, body, headers, signal, timeoutMs, guard }), get, post, put, patch, del,
//     manager(managerId) /* same API rooted at /api/m/<id> */, csrfHeaders() }
```

**Request handling**
- JSON in and out.
- The caller's signal and the timeout are combined.
- `x-request-id` is attached to data (non-enumerable `__requestId`) and to errors.
- Every non-GET sends `x-csrf-token` from bootstrap `auth.csrf` (05 §5.1). The token is held in a closure, never stored, and never put into an error, a log or a toast. `csrfHeaders()` returns `{ "x-csrf-token": … }` for the two direct `fetch` callers (Playground streams, §6.6). A 403 `csrf_invalid` (00 §9.8) re-reads `/api/session` once and retries once.
- A failing `guard` throws `invalid_response` with `details` and never renders garbage.

**Error normalization**

| Response | `ApiError.code` |
|---|---|
| fetch rejects | `network_error` |
| timeout | `timeout` |
| 00 §4.2 envelope `{ok:false,error:{code,…},errors:[…]}` | `error.code`, with `errors` mapped to `fieldErrors` |
| legacy `{ok:false,error:"text",code}` or `{error:"text"}` | `code`, otherwise `http_<status>` |
| entry 404 `{error:"Not found"}` on a known endpoint | `endpoint_unavailable` (the page renders its degrade path) |
| 401 `admin_session_required` | `onUnpaired()` sets role viewer and opens the PairingScreen (§6.15) over the current page; the action is not retried |
| 403 `management_local_only` | same code; `onReadOnly()` refreshes the role; toast `此操作只能在本机执行 / This action is only available on this machine` |
| 502/503 `manager_unreachable` | inline `{manager} 未运行 [启动] / {manager} is not running [Start]`, which calls `POST /api/managers/:id/start` (owner only; 06 delegates it to the supervisor) |
| 409 `plan_changed`, `wake_would_replace_running`, `wake_api_key_missing` | code and `details` (or the new `plan`) kept; the calling page decides (§6.2, §6.3); never a generic toast |
| 410 `console_stale` | `onStale()`, which shows the update banner |
| non-JSON body on a JSON route | `bad_response` |

**Guards** (`lib/guards.js`) are a lenient DSL: extra keys are allowed, and invalid array items are dropped and counted, so one bad instance never blanks the list.

```js
export const str, num, int, bool, iso, any;
export function opt(g), nullable(g), oneOf(...values), arr(g, { dropInvalid = true }), obj(shape), record(g);
export function check(guard, value) // → { ok, value, errors: [{ path, expected, got }], dropped }
```

`lib/schemas.js` exports every resource guard: `StatusGuard`, `FleetGuard`, `InstanceGuard` (00 §4.1 plus §9.17 `lifecycle.phaseHistory`, `sleep.id`), `InstanceMetricsGuard` (00 §9.12), `LaunchPlanGuard` (§4.3 plus §9.2 `planHash`, `steps[]`, `blockers[]`, `ok:false`), `JobErrorGuard` (00 §9.11), `ErrorEnvelopeGuard` (§4.2), `EventEnvelopeGuard` and `NotificationGuard` (§4.5, §9.6), `SessionGuard` (05), `PlatformStatusGuard` (06 §5.15), `ModelCardGuard`, `FitResultGuard`, `FitGridGuard`, `PlanCardGuard` (02), `CompatRowGuard`, `EngineGuard`, `SchemaCatalogGuard`, `EngineDescriptorGuard` (01), `JobGuard`, `DownloadJobGuard`, `LibraryEntryGuard` (03), `TimeseriesGuard`, `BreakdownGuard`, `RequestRowGuard`, `AlertGuard` (04), `KeyGuard` (05), `ComponentGuard`, `DoctorCheckGuard` (06) and `BootstrapGuard`. Other packages' tests `await import()` it (§13.4).

### 3.5 Query cache (`lib/store.js`) and hooks (`ui/hooks.js`)

```js
export function stableKey(parts)   // JSON with sorted object keys
export function createQueryCache({ now }) // → { fetch(key, fn, { ttlMs = 5000, force }) /* in-flight dedupe */,
//   get(key) → { data, error, status: "idle"|"loading"|"success"|"error", updatedAt, stale, fetching },
//   set(key, dataOrUpdater), invalidate(keyOrPrefix), subscribe(key, fn) → off, gc(maxIdleMs = 300000) }
// hooks
useQuery(key, fn, { ttlMs, refetchMs, enabled = true, keepPrevious = true }) // → { data, error, status, updatedAt, fetching, refetch }
useMutation(fn, { invalidates: [], toast: { success, error } })              // → { run, status, error }
useEvent(type, handler); usePref(name); useT(); useRole(); useMediaQuery(q); useDebounced(v, ms)
```

**Rules**
- `refetchMs` applies only while events are in `polling` mode and `/api/events/recent` is failing too (§3.6), or for keys with no event type.
- Polling pauses while `document.hidden`.
- Mutations invalidate the prefixes they declare.
- The UI never optimistically rewrites server state; rows only show `pending`.

| Key | Endpoint | TTL | Poll when SSE is down | Event |
|---|---|---|---|---|
| `["status"]` | `GET /api/status` | 10 s | 15 s | `status` |
| `["platform"]` | `GET /api/platform/status` (06 §5.15) | 5 s | 15 s | `platform` |
| `["session"]` | `GET /api/session` (05) | 60 s | none | none |
| `["fleet"]` | `GET /api/fleet` | 5 s | 10 s | `instances` |
| `["m",id,"instances"]` | `GET /api/m/:id/instances` | 5 s | 10 s | `instances` |
| `["m",id,"jobs"]` | `GET /api/m/:id/jobs?fields=summary` | 2 s | 3 s while active, otherwise 30 s | `jobs` |
| `["hub","downloads",q]` | `GET /api/hub/downloads` | 2 s | 2 s while active, otherwise 30 s | `downloads` |
| `["hub","library",q]` | `GET /api/hub/library` | 30 s | 60 s | `library` |
| `["telemetry","live"]` | `GET /api/telemetry/live` | 5 s | 5 s (04 §11) | `telemetry.live` |
| `["alerts","firing"]` | `GET /api/telemetry/alerts?state=firing` (04) | 10 s | 30 s | `alerts` |

### 3.6 Events (`lib/events.js`)

```js
export function createEventStream({ url = "/api/events", types, EventSourceImpl, now, onState })
// → { on(type, handler) → off, close(), reconnect(), state: "connecting"|"open"|"polling"|"offline" }
export function applyEvent(cache, envelope) // pure: envelope → cache.set/invalidate
```

**Connection** (server side: §2.8)
- One `EventSource` per tab at `/api/events?types=status,instances,jobs,downloads,library,alerts,telemetry.live,notification,platform,security,access`. A viewer asks only for the types its bootstrap allows (default `status`, `instances`).
- The browser sends `Last-Event-ID` on auto-reconnect. When the client itself opens a new `EventSource` (after polling, or after a hidden-tab close) it passes `?lastEventId=<last id>`. Replayed events are applied in order; a `resync` event invalidates every evented key once.
- The data is the §2.8 envelope; `envelope.type` is read, so the `event:` line is optional. The last `id` is remembered per tab, in memory.
- After more than 3 errors in 60 s, or a 4xx/5xx on open (503 `too_many_streams` included), switch to `polling` and retry SSE every 60 s. In `polling` the client reads `GET /api/events/recent?since=<last id>` every 5 s and applies the events (`gap:true` invalidates every evented key); the per-key `refetchMs` timers of §3.5 run only if `/recent` also fails.
- If the tab is hidden for more than 5 min, close the stream; reopen it on `visibilitychange` with `?lastEventId=`.

| Event (payload) | Effect |
|---|---|
| `status` `{reason, managerId?, ok?, offline?}` | invalidate `["status"]` and `["platform"]` |
| `platform` (06 §5.10 bridge) | `{kind:"status", full:true, status}` → `set(["platform"], status)` (drives the StatusStrip); `{kind:"component", id, state, prev, reason}` → invalidate `["platform"]` and the component list; `{kind:"operation", opId, opKind, state, progress, line}` → `set(["platform","op",opId])` for setup, doctor-fix and restart progress |
| `instances` `{managerId, changed, removed, native}` | invalidate `["fleet"]` and `["m",managerId,"instances"]` |
| `jobs` `{managerId, jobs, removed}` | merge by id into `["m",managerId,"jobs"]` and drop `removed`; drives the launch Stepper and pull progress with no refetch |
| `downloads` (03 `{kind, jobs, aggregate}`) | merge `data.jobs[]` into the downloads entries; `truncated` → invalidate |
| `library` | invalidate the library |
| `alerts` (04, with `ruleId`, `scopeKey`) | invalidate alerts |
| `telemetry.live` | `set(["telemetry","live"])` |
| `security`, `access` (05) | invalidate `["security"]` or `["access"]` prefixes |
| `notification` (00 §9.6) | push to the NotificationCenter: `title`/`body` through `pick()`, `severity` as the icon and tone, `action.href` as a link. `action.apiCall` renders a button that runs only on click, after a ConfirmDialog naming `method` and `path`; anything not `/api/…` is dropped by the guard. A `dedupeKey` (04), or else `kind`+`href`, within 10 min updates one entry. `warn` and `error` also raise a transient toast. |
| `resync` | invalidate every evented key once |
| unknown type | ignored |

### 3.7 i18n and formatting

**Catalogs** are per area (00 §9.16): `console/i18n/<area>/zh-CN.json` and `en-US.json`, plus an optional `dynamic-keys.json`. Each file is flat JSON with dotted keys.
- Values are strings with `{var}` placeholders, or plural objects `{"one","other"}` resolved through `Intl.PluralRules` (zh uses `other` only).
- `"$locale"` is required. `"$prefixes"` (in both locale files, identical) declares the key prefixes the area owns. Prefix sets are disjoint across areas, and every key must start with one of its area's prefixes. Keys are sorted, so concurrent additions merge cleanly in git.
- `dynamic-keys.json` lists the area's allowed computed prefixes (for example `status.*` and `error.code.*` in `shell`, `engines.phase.*` in `engines`) and the keys allowed to look unused.
- Copy tables with bare keys (01 §23 `group.*`, `phase.*`, `source.*`, `err.*`, `plan.*`; 06 §11 `layer.*`, `state.*`, `source.*`, `action.*`, …) are written under their area name (`engines.phase.pull`, `platform.layer.environment`), because bare segments such as `source.` collide across areas. The 02, 04 and 05 tables already carry their prefixes.

| Area | Copy specified by | Written by | Prefixes (initial) |
|---|---|---|---|
| `shell` | 07 | CON-4 and the CON page packages | `shell. common. status. error. overview. deploy. playground. billing. voice. prefs. uikit. notify.` |
| `engines` | 01 §23 | CON-10, CON-12, CON-16 | `engines.` |
| `models` | 02 §18 | CON-11, CON-11b, CON-12, CON-14, CON-29, CON-31 | `models.` |
| `hub` | 03 §19 | 03 HUB-15 creates it; CON-14/15 add missing keys | `hub.` |
| `telemetry` | 04 §19.1 | 04 TEL-19 creates it; CON-17/18/19 add missing keys | `obs. audit.` (alert copy lives under `obs.`) |
| `access` | 05 §5.2, §13 | CON-6 (`pair.*`), CON-20, CON-21 | `access. pair. public. security. sessions.` |
| `platform` | 06 §11 | CON-6 (strip keys), CON-24, CON-24b, CON-25 | `platform.` |

An area is created by the package named above. A CON package that needs a key in an area another package created adds it there, citing that spec's table; keys are sorted, so such additions merge cleanly. `mergeI18nAreas(i18nDir) → { catalogs: { "zh-CN", "en-US" }, dynamicKeys, problems: [{ area, file, code, key? }] }` lives in `console-routes.js` (CommonJS) and feeds the snapshot (§2.3); the i18n test loads it with `createRequire`. A new area is a new directory, never an edit to a shared file.

```js
// lib/i18n.js
export const LOCALES = ["zh-CN", "en-US"];
export function resolveLocale({ pref, navigatorLanguages }) // zh* → zh-CN, else en-US; default zh-CN
export function createI18n({ locale, catalog, fallbackCatalog }) // → { locale, t(key, vars), has(key), pick(textObj) }
// pick accepts {zh,en} or {"zh-CN","en-US"}; a missing locale falls back with a dev warning and data-i18n-fallback.

// lib/format.js
export function createFormatters(locale) // → { number, integer, percent(ratio, digits = 1),
//   bytes(n, { unit: "auto"|"MiB"|"GiB" }) /* binary, GiB/MiB labels in both locales */, mib,
//   tokens(n) /* "262,144 (256K)" */, duration(ms, { style }), rate(n, unit) /* "38.6 tok/s" */,
//   dateTime(iso, { style }), time, relative(iso, now), range(from, to) }
```

**Seed keys** (area `shell`, zh-CN / en-US)

| Key | zh-CN | en-US |
|---|---|---|
| `shell.product` | 本地 AI 平台 | Local AI Platform |
| `shell.skip` | 跳到主要内容 | Skip to main content |
| `shell.nav.*` (12 keys) | 总览, 部署, 模型, 引擎, 试一试, 观测, 审计, 告警, 接入与密钥, 计费, 语音, 系统 | Overview, Deployments, Models, Engines, Playground, Observability, Audit, Alerts, Access & keys, Billing, Voice, System |
| `shell.readonly` | 只读模式：配对此浏览器后才能修改 | Read-only: pair this browser to make changes |
| `shell.update` | 控制台已更新，刷新以加载新版本 | The console was updated. Reload to use the new version. |
| `shell.conn.polling` | 实时推送中断，已改为定时刷新 | Live updates interrupted; refreshing on a timer |
| `shell.conn.offline` | 无法连接统一入口（上次更新 {time}） | Cannot reach the entry service (last update {time}) |
| `common.window.1h` | 过去 1 小时 | last 1 h |
| `deploy.list.count` | `{other:"{count} 个部署"}` | `{one:"{count} deployment",other:"{count} deployments"}` |

### 3.8 Preferences and theming (`lib/prefs.js`)

```js
export const PREFS = { theme: ["auto","light","dark"], locale: ["auto","zh-CN","en-US"], density: ["comfortable","compact"],
  sidebar: ["expanded","collapsed"], notifyBrowser: [false, true], tableColumns: "object", dismissedSetup: [false, true],
  notificationsReadAt: "iso" };
export function readPrefs(storage)        // validated; unknown values fall back to defaults
export function writePref(storage, name, value) // localStorage "console.prefs.v1" + cookie
//   console_prefs=theme:dark|locale:en-US|density:compact; Path=/; SameSite=Strict; Max-Age=31536000
export function migrateLegacyPrefs(storage, query) // once: billingThemeMode → theme; ?theme=&lang= from the legacy banner
export function applyTheme(doc, pref)     // set or remove html[data-theme]; auto = no attribute
```

**Theme CSS**
- Light tokens live on `:root`.
- Dark tokens live under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }` and again under `:root[data-theme="dark"]`.
- Charts re-read CSS variables when `matchMedia` changes or `html[data-theme]` mutates.
- The billing iframe reloads with `?theme=` when the theme changes.

### 3.9 Management proxy usage (00 §5, server side §2.10)

- `api.manager("vllm").get("/instances")` calls `GET /api/m/vllm/instances`, which the proxy maps to the manager's `/api/instances` (so 01's engine list is `/api/m/:managerId/engines`). All manager traffic goes through the proxy. The only manager-port URL is the "Open legacy UI" link `${location.protocol}//${location.hostname}:${legacyUiPort}/`.
- **Manager resolution.** `engineId → managerId` comes from 01's entry `GET /api/engines`. Before 01 lands, it comes from bootstrap: `vllm` hosts `vllm` and `sglang`; `llama` hosts `llamacpp`.
- **Streams.** Instance logs poll 01's `GET /api/m/:id/instances/:instanceId/logs?tail=500&since=<cursor>` every 2 s while the tab is visible (01 defines no follow stream). Job updates come from the entry `/api/events` (`jobs` relayed with `managerId`, §2.11). `/api/m/:id/events` is used only when `features.events=false`.
- **Instance metrics.** `GET /api/m/:id/instances/:iid/metrics` (01, 00 §9.12) returns `{metrics, raw, facts, scrapedAt, unsupported[]}`. The console reads only `metrics` (camelCase canonical keys; histograms summarised as `{avg, p50, p95, count}`) and `facts`; `raw` (cumulative buckets) is for 04's collector. A key in `unsupported[]` renders `本引擎不提供 / Not reported by this engine`, never 0.
- **Viewers.** Only the 05 §5.4 proxied GETs (`status, instances, running-models, models, stats, jobs, tools/health`) are called; other manager reads show `access.ownerOnly`. Mutations are never offered, and a 401 or 403 refreshes the role.

## 4. Design system

### 4.1 Tokens (`shared-public/styles/tokens.css`, shared with the 05 portal): primitive → semantic → component

Only primitives and semantic tokens live in the shared file; component tokens and density rules live in `console/styles/base.css`, so the portal can adopt the palette without console layout.

**Primitives**
- Neutral ramp `--n-0…--n-1000`.
- Teal 500/700/800: `#14b8a6`, `#0f766e`, `#115e59`.
- Blue 600/700: `#2563eb`, `#1d4ed8`.
- `--green-800 #166534`, `--amber-700 #a15207`, `--red-700 #b42318`, plus dark variants.

Components reference semantic tokens only. The contrast test resolves `var()` chains.

| Semantic | Light | Dark | Verified contrast |
|---|---|---|---|
| `--bg` | `#f5f7fa` | `#0b1118` | n/a |
| `--surface-1/-2/-3` | `#ffffff` / `#eef2f6` / `#e3e9ef` | `#121a24` / `#1a2532` / `#223144` | n/a |
| `--text` | `#16202b` | `#e6edf3` | ≥ 11.1 on every surface |
| `--text-muted` | `#4f5d6b` | `#a3b1bf` | ≥ 5.5 light, ≥ 6.0 dark |
| `--border` (decorative), `--border-strong` (inputs) | `#d5dde5`, `#6b7785` | `#2a3a4c`, `#6b7c8f` | strong ≥ 3.7 light, ≥ 3.08 dark |
| `--accent` / `--accent-ink` | `#1d4ed8` / `#ffffff` | `#7cb0ff` / `#0b1118` | text ≥ 5.48; ink on accent 6.70 / 8.59 |
| `--success` / `--warn` / `--danger` (as text) | `#166534` / `#a15207` / `#b42318` | `#4ade80` / `#fbbf24` / `#f87171` | ≥ 4.61 light, ≥ 4.77 dark, on every surface |
| `--{success,warn,danger}-soft` / `-ink` | `#dcfce7`/`#14532d`, `#fef3c7`/`#78350f`, `#fee2e2`/`#7f1d1d` | `#12301f`/`#bbf7d0`, `#33270a`/`#fde68a`, `#3a1416`/`#fecaca` | ≥ 8.15 / ≥ 11.2 |
| `--brand-ink` | `#115e59` | `#2dd4bf` | ≥ 6.2 / ≥ 7.0 |
| `--focus-ring` (2 px outline + 2 px offset) | `#2563eb` | `#7cb0ff` | ≥ 4.2 / ≥ 5.9 |

**Chart palette** `--chart-1…8`, every color ≥ 3.68:1 on surface-1:
- light: `#2563eb #0d9488 #c2410c #7c3aed #db2777 #4d7c0f #0891b2 #64748b`
- dark: `#60a5fa #2dd4bf #fbbf24 #fb923c #a78bfa #f472b6 #a3e635 #22d3ee`

**Memory segments**: weights = chart-1, kv = chart-2, activations = chart-3, draft = chart-4, mmproj = chart-5, overhead = chart-8, other tenants = chart-8 with a 45° stripe, headroom = `--surface-3`, over-budget = `--danger` hatched.

**Component tokens**: `--btn-h`, `--input-h`, `--row-h`, `--pad-card`, `--radius-control`, `--radius-card`, `--shadow-pop`.

**Contrast test** (`test/console/tokens-contrast.test.js`) parses both themes of `shared-public/styles/tokens.css` and checks the pairs in `shared-public/styles/contrast-pairs.json`: text ≥ 4.5; large text, icons and borders ≥ 3; focus ring ≥ 3 against every surface; categorical colors ≥ 3 on surface-1.

### 4.2 Typography, spacing, density, motion

- **Fonts**: `system-ui, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", sans-serif`. Mono: `"Cascadia Mono", Consolas, ui-monospace, monospace`. No webfonts.
- **Type scale**: 12/16, 13/18, 14/20 (body), 16/24, 20/28, 24/32, 32/40. Metrics use `tabular-nums`.
- **Spacing and shape**: 4 px grid `--sp-1…--sp-12`. Radii 4/6/10/14. Three shadows.
- **Z-index**: dropdown 20, sticky 30, drawer 40, dialog 50, toast 60.
- **Density**: `html[data-density=compact]` sets `--row-h` 32 (instead of 40), `--input-h` 30 (instead of 36), `--pad-card` 12 (instead of 20) and body 13 px.
- **Motion**: 120 and 200 ms. `prefers-reduced-motion` disables transitions and the stepper pulse.
- **Breakpoints**: sm < 640, md < 1024, lg ≥ 1024, xl ≥ 1440. Tested at 390, 768 and 1440.

### 4.3 Content rules

- Every number shows its unit, and every aggregate shows its window (`过去 24 小时 / last 24 h`). Lifetime values are never labelled "current".
- Every empty state names its next action. Help goes in popovers, not walls of notes.
- Labels use human words first, with the raw flag as secondary monospace text (00 rule 6).
- Status pairs an icon with text.
- Destructive copy says exactly what stops and what keeps running.

### 4.4 Components (`console/components/*.js`)

All components are function components returning `html` templates. All are keyboard-operable and carry `data-testid="<component>.<part>"` hooks.

| Component | Props | Behaviour and a11y |
|---|---|---|
| **AppShell** | `{ nav, children }` | Skip link to `#main`, `<nav aria-label>`, topbar, `<main id="main">`, connection and update banners, toast and dialog hosts. The sidebar becomes an off-canvas Drawer at md and below. |
| **Sidebar** | `{ items, collapsed, onToggle }` | Links carry `aria-current="page"` under section headings. Collapsed mode shows icons with tooltips but keeps the accessible name. Owner-only items show a lock for viewers. |
| **StatusStrip** (topbar) | `{ platform, live, fleet, status }` | The five 06 readiness layers as chip buttons (`platform.layer.environment … platform.layer.exposure` from 06 §11; for example `模型服务 2 / Model serving 2`, `访问范围 本机 / Exposure Local`), then a GPU chip from `telemetry.live` (`GPU 61% · 58.2/95.6 GiB`) and a version chip (with a dot when `/api/platform/version` reports newer commits). Each chip opens a popover with the layer `detail` and its `action` (for example `platform.action.restoreModels`). Overall color comes from `readiness.overall`. Before 06 lands, `lib/readiness.js` derives the same five layers from `/api/status` and `/api/fleet` (serving uses the `isFleetRoutableInstance` rule), so overall green still needs at least one serving model. Below sm it collapses to one chip. |
| **PairingScreen** | `{ reason: "unpaired"\|"invalid"\|"expired", autoPairAvailable, pairCommand }` | 05 §5.2 copy (`pair.body` with `{cmd}`), the `pairCommand` from `GET /api/session` (`platform admin pair` or the `admin-pair.js` fallback) in a CodeBlock, and Retry, which re-reads `/api/session`. It never asks for a password or code input. A code arrives only through `#pair=`. |
| **NotificationCenter** | `{ items, onRead }` | Bell `aria-label="通知，{n} 条未读 / Notifications, {n} unread"` opening a Drawer of 50 items. Read state is kept in `notificationsReadAt`. Browser notifications are opt-in and work only in a secure context (localhost). |
| **CommandPalette** | `{ commands }` | `Ctrl/⌘+K` opens a dialog combobox with a listbox (`aria-activedescendant`). Sources: routes; actions (New deployment, Download model, Copy gateway URL, Toggle theme/language/density, Run doctor); entities (deployments, library models, engines); parameters on wizard pages. Matching is fuzzy over zh, en and aliases (`lib/fuzzy.js`). |
| **ConnectionBanner** | `{ state, lastOkAt }` | `polling` (info) or `offline` (error, with retry). Ports the connection-status behaviour. |
| **ErrorBoundary** | per route | `页面出错 / This page crashed`, with the code, request id, copy-diagnostics and reload. |
| **PageHeader** | `{ title, subtitle, breadcrumbs, actions, meta }` | `<h1 tabindex=-1>`; at most one primary action. |
| **Card** | `{ title, actions, tone, children }` | `<section aria-labelledby>`. |
| **StatTile** | `{ label, value, unit, window, denominator: { value, label }, delta: { value, goodWhen: "up"\|"down" }, sparkline, status, href }` | `window` is required (dev warning otherwise) and renders as `[data-window]`; the value sits in `<data>`. |
| **StatusBadge** | `{ status: ok\|warn\|error\|info\|neutral\|unknown\|loading, label }` | Icon plus text. `unknown` is grey, never green. |
| **Tabs** | `{ tabs: [{ id, label, badge, disabled }], value, onChange, urlParam = "tab", activation: "auto"\|"manual" }` | WAI-ARIA tablist with roving tabindex; ←/→/Home/End; panels are `role=tabpanel tabindex=0`. |
| **Drawer** | `{ open, title, width: 480\|640\|840, onClose, footer, children }` | Modal `<dialog>`; Esc closes; a full-screen sheet below sm; optionally addressable through `?drawer=`. |
| **Dialog / ConfirmDialog** | `{ title, body, details: [string], confirmLabel, tone: "default"\|"danger", typeToConfirm, onConfirm: async }` | Native `showModal()`. Initial focus goes to Cancel (danger) or to the type field. The backdrop never closes a danger dialog. Confirm stays disabled until the typed text matches exactly; it is busy while running and the dialog stays open on error. Focus is restored on close. |
| **Toast** | `{ level, title, body, requestId, action }` | At most 3. Success and info auto-dismiss after 5 s (paused on hover or focus). Errors persist and offer "Copy details". `role=status`; errors use `role=alert`. |
| **FormField** | `{ id, label, unit, help, required, error, warning, changed, onReset, provenance, locked: { reason }, hint, children }` | `<label for>`. Help button with `aria-expanded`. `aria-invalid` and `aria-describedby` cover the error and unit. Changed dot `aria-label="已修改 / Modified"`. Reset `重置为默认 / Reset to default`. |
| **HelpPopover** | `{ what, whenToChange, tradeoffs, flag, docs }` | Non-modal; Esc closes; a bottom sheet below sm. |
| **SchemaForm** | §4.5 | n/a |
| **DataTable** | `{ id, columns: [{ id, header, cell, sort, align, width, hideable, defaultHidden, csv }], rows \| source: { cursor, loadMore }, rowKey, onRowClick, filters, pageSize = 50, exportName, exportHref, empty, responsive: "scroll"\|"cards" }` | Semantic `<table>` with a hidden `<caption>`. Sort buttons set `aria-sort`. The column chooser is persisted per `id`. Client CSV of loaded rows uses a UTF-8 BOM and formula-escapes `= + - @ \t \r`; `exportHref` exports server-side. Windowed above 500 rows; card mode below sm. |
| **TimeRangePicker** | `{ value: { range: 15m\|1h\|6h\|24h\|7d\|30d } \| { from, to }, compare, onChange, maxRangeDays }` | Synced to `?range=` or `?from=&to=`. Custom ranges use two `datetime-local` inputs. Label `过去 24 小时 / Last 24 h`. |
| **TimeSeriesChart** | `{ series: [{ id, label, unit, values }], x: unixSeconds[], stacked, annotations: [{ at, kind: launch\|restart\|config\|alert, label }], onBrush(from, to), height = 220, yUnits }` | Lazy `uplot`. Null gaps render as breaks. Crosshair tooltip, legend toggles, drag-to-zoom (calls `onBrush`). `role=img` with a summary label, plus a `表格视图 / Table view` toggle. |
| **GpuMemoryBar** | `{ gpu: { id, name, totalMb }, segments: [{ kind, mb, label }], budgetMb, admissionMb, otherTenantsMb }` | One stacked bar per GPU with a budget marker, over-budget hatching and a patterned legend. `role=img` plus an sr-only breakdown table. |
| **StackedBar** | `{ total, parts, unit }` | Storage and capacity. |
| **LogViewer** | `{ source: { kind: job\|instance\|component, managerId, id }, follow = true, initialTail = 500 }` | `role=log aria-live=off`. A 5000-line ring buffer, search highlight, and a level filter (ERROR/WARN/INFO by regex). Follow toggle with `aria-pressed`; it pauses when the user scrolls up and offers "jump to latest". Copy and `.txt` download. |
| **MarkdownViewer** | `{ source, baseHref, allowImages = "same-origin" }` | `lib/markdown.js` builds a token tree rendered as VNodes, and raw HTML is escaped. Links are allowed only for `http(s):`, relative and `#`; external links get `rel="noopener noreferrer" target=_blank`. Remote images become a placeholder. |
| **CodeBlock** | `{ code, language, wrap, copyLabel }` | `navigator.clipboard` in a secure context; otherwise a hidden-textarea `execCommand("copy")` for LAN over http. `已复制 / Copied`. |
| **EmptyState** | `{ icon, title, body, action: { label, href \| onClick } }` | `action` is required. |
| **Skeleton** | `{ shape: line\|tile\|table, rows }` | The parent sets `aria-busy`. |
| **ProgressRow** | `{ label, percent \| null, bytesDone, bytesTotal, speedBps, etaSec, phase, actions }` | `role=progressbar` with `aria-valuetext="42% · 1.2 GiB/s · 剩余约 3 分钟 / about 3 min left"`; indeterminate when `null`. |
| **Stepper** | `{ steps: [{ id, label, state: pending\|active\|done\|error\|skipped, detail, durationMs }], orientation }` | `<ol>` with `aria-current="step"`; the state is also given as text. |
| **ModelCardView** (`model-card.js`) | `{ card, view: "summary"\|"full" }` (00 §4.4, 02 §4) | Identity, topology, modalities, template formats, role (02 `models.role.*`); every value carries an **EvidenceChip** (`evidence-chip.js`) with 02's four confidences `models.confidence.{declared,detected,name-heuristic,verified-on-host}` (name-heuristic amber, verified green). An unknown architecture shows `models.compat.unknownArch` (`未知（未验证）/ Unknown (unverified)`, must-keep, 00 §9.13) in the neutral tone, never green, with `运行预检探针 / Run the dry probe` (R-UI-1). |
| **CompatMatrix** | `{ rows: CompatRow[], value, onSelect, onProbe }` | Engine × runtime rows with 02's verdicts `models.verdict.{ok,warn,block,unknown}`, reasons, recipe chips (`已验证 Verified` / `实验 Experimental` / `已阻止 Blocked`, with dates) and a recommended star. `unknown` rows are grey and carry `Run dry probe` and `Override` (opens the per-model override editor, §6.4 Knowledge) with `models.verdict.unknownHint`. An `ok` row without `supportEvidence` is rendered as `unknown` (R-UI-2). |
| **FitBar** (`fit-bar.js`) | `{ fit, ram }` | 02's stacked fit bar: weights, KV, activations, draft, projector, headroom (`models.fit.*`), plus a system-RAM bar when experts are offloaded. Shares segment colours with GpuMemoryBar. |
| **PlanCards** (`plan-cards.js`) | `{ gpuSets: [{ gpuIds, plans }], value, onPick }` | 02 planner output (≤ 3 plans per GPU set): engine@runtime, key values, a FitBar, notes, `validated` state. Picking a plan never applies it; it opens a DiffTable first. |
| **FitSolver** | `{ grid \| null, fit, onApply }` | With a grid from 02 `POST /api/models/:id/fit-grid` (02 MOD-9b, MOD-15; R-UI-3): KV dtype × concurrency giving the max context, shown in color plus text; a cell opens a DiffTable, then Apply. Without one: 02 FitResult `suggestions[]` as Apply chips with `deltaMb` (`fp8 KV 可省 8 GiB / fp8 KV saves 8 GiB`). |
| **RootCausePanel** (`root-cause-panel.js`) | `{ error /* 00 §9.11 job error */, signature }` | One failure card for launch, probe and qualification failures (R-UI-6). `title` and `suggestions` come from the error when present, else from the looked-up signature; `hint` through `pick()`, the failed `phase`, `logExcerpt` in a CodeBlock (already redacted), `signatureId` as secondary mono text, and the signature's `suggestions[]` (02 §8.4) as actions: `param` → `应用建议并返回确认 / Apply suggestion and review`, `probe` → Run probe, `runtime` → the engine's Runtimes tab. A `security:true` suggestion needs its own ConfirmDialog. |
| **QualifyChecklist** (`qualify-checklist.js`) | `{ jobId, managerId, checks }` | Live 02 qualification checks (`models.qualify.check.*`) from `jobs` events: pending, pass, fail or skip with the reason; a passing `chat` check enables Save as recipe. |
| **CommandPreview** | `{ command }` | One argv token per line with `<redacted>` kept. Custom extra args are highlighted. Copy button and an env table. |
| **DiffTable** | `{ rows: [{ label, from, to, source }] }` | Used for profile apply, recipe changes and comparison with the last launch. |
| **ShareCard** | `{ key, baseUrls, model, snippets }` | One-time key display with QR and invite text (05 §13.4). Closing requires ticking `我已保存密钥 / I have saved the key`. The key is cleared on close. |
| **QrCode** (`qr-code.js`) | `{ text, label }` | Lazy `loadQrcode()`; renders SVG paths as VNodes; `role=img` with `label`. Used by ShareCard and Pair-a-device. |
| **KeyForm**, **ExposureMap**, **ChecksList** | 05 §13.4–13.5 | Key create/edit with presets and zh/en field help; the exposure map SVG from `report.map` (nodes, edges, evidence); the live-check list with fix hints. Built in CON-20/21 to 05's requirements. |

### 4.5 SchemaForm (renders the 01 parameter catalog)

```js
// lib/schema-form-model.js (pure)
export function buildFormModel({ catalog, plan, values, engineId, locale, level = "basic", query = "", groups })
// → { groups: [{ id, label, fields: FieldModel[], hiddenCount }], counts: { visible, hidden, notApplicable, changed, errors } }
// FieldModel = { id, domId, widget, type, label, unit, summary, help, flag, userValue, effective: { value, source, reason },
//   ghost, changed, locked: { reason } | null, error, warnings, suggestion: { value, why } | null, applicable, visible, level, secret, choices }
// lib/expr.js — browser port of 01 §10.2 (same JSON AST, limits: depth ≤ 32, ≤ 512 nodes, regex ≤ 200 chars)
export function validateExpr(ast)                       // → { ok, errors: [{ path, code }] }; unknown operator → error
export function evaluate(ast, { param, user, fact, env }) // leaves: param/user/fact/env/const; ops: eq ne in notIn gt gte lt lte
//   and or not isSet coalesce if min max add sub mul floorDiv matches versionGte json
// An unresolved fact or env returns the sentinel UNKNOWN. appliesWhen = UNKNOWN keeps the field visible (fail-open);
// a rule = UNKNOWN shows nothing. resolveLaunchPlan on the manager stays the authority.
// components/schema-form.js:
// <SchemaForm catalog plan values onChange onReset onApplySuggestion level onLevelChange groups readOnly mode="launch"|"config"|"catalog"/>
```

**Behaviour**
- **Level switch**: `基础 / 进阶 / 专家 · Basic / Advanced / Expert`. Search box `查找参数… / Find a parameter…` matches label, summary and flag. Groups follow catalog order.
- **Not applicable to the engine**: hidden, with the footer `已隐藏 {n} 个不适用于 {engine} 的参数 / {n} parameters hidden (not applicable to {engine})`.
- **Provenance chips**: `你 You`, `配方 Recipe` (🔒 when locked), `规划器 Planner` (00 §9.10), `模型 Model`, `知识库 Knowledge`, `引擎默认 Engine default`, `平台默认 Platform default`.
- **`appliesWhen` facts** come from the schema response's `facts` (01 ENG-2: `host.*`, `model.*`, `runtime.*`, `instance.mode`). Before ENG-2 ships them, every fact is UNKNOWN, so `appliesWhen` fails open (fields stay visible) and the plan's `errors[]` remain the authority.
- **Locked fields** are disabled, with the reason shown.
- **Ghost text** shows the engine default. A changed dot appears when `userValue` is set.
- **Errors** from `plan.errors` and `fieldErrors` show inline. A suggestion renders as an `应用 {value} / Apply {value}` chip; **values change only on click**.

**Widgets by type**

| Type | Widget |
|---|---|
| `int` / `float` | number input with unit suffix and human hint `262,144 = 256K` |
| `enum` | segmented control (≤ 5 choices) or select |
| `bool` | switch |
| `string` | text |
| `path` | text plus storage folder picker |
| `json` | textarea with a parse check |
| `list` | token editor; also used for `extraArgs` argv, one token per row |
| `tristate` | segmented `默认 / 开 / 关 · Default / On / Off`; Default sends `null` |
| `kv` | key/value rows |
| any type with `secret: true` | write-only: `已设置 / Set`, `未更改 / Unchanged`, `清除 / Clear`; the value is sent once and never echoed |

**DOM hooks**: `id=domId` keeps old selectors working; `data-field="<paramId>"` and `data-source`.

**Modes**
- `config` (06 settings): provenance `env | file | default | derived | runtime` (`platform.source.*` copy), plus a `platform.settings.restartRequired` badge.
- `catalog`: read-only, every level shown.

## 5. Information architecture

| Nav (zh / en) | Path and sub-routes | Viewer (05 §5.4) | Feature | Phase |
|---|---|---|---|---|
| 总览 / Overview | `/overview` | read (status, fleet tiles only) | n/a | C1 |
| 部署 / Deployments | `/deployments`, `/new`, `/:fleetId`, `/routing` | list and detail overview; no logs, config or writes | engines | C1 |
| 模型 / Models | `/models`, `/discover`, `/downloads`, `/storage`, `/knowledge`, `/library/:entryId`, `/hub/:provider/:owner/:name` | owner only | hub, models | C2 |
| 引擎 / Engines | `/engines`, `/:engineId`, `/new`, `/external` | owner only | engines | C2 |
| 试一试 / Playground | `/playground` | yes, with a pasted key (the `console-session` principal needs an owner session) | n/a | C1 |
| 观测 / Observability | `/observability`, `/performance`, `/traffic`, `/errors`, `/gpu`, `/models`, `/requests[/:requestId]`, `/settings` | owner only unless 04 registers redacted telemetry reads (§16 item 4) | telemetry | C3 |
| 审计 / Audit | `/audit`, `/conversations`, `/exports`, `/access-log`, `/settings` | owner only | audit | C3 |
| 告警 / Alerts | `/alerts?tab=firing\|history\|rules\|channels` | owner only | alerts | C3 |
| 接入与密钥 / Access & keys | `/access`, `/keys`, `/public`, `/security`, `/portal`, `/clients`, `/sessions` | `/clients` only | access, public, session | C3 |
| 计费 / Billing | `/billing` (C4: `/overview…/audit`) | owner, local only | n/a | C1 embed, C4 native |
| 语音 / Voice | `/voice` | read | n/a | C1 |
| 系统 / System | `/system`, `/doctor`, `/settings`, `/updates`, `/ops` (06 §11 content); `/preferences`, `/ui-kit` | `/system` redacted (06 registrations), `/preferences` | platform | C2 with degrade paths; full data with P6 |
| 首次设置 / First-run (no nav entry) | `/setup` (06 §8 steps) | owner only | setup | C2; full data with P6 |

An owner-only route shows the PairingScreen to a viewer instead of rendering and failing. Sidebar items a viewer cannot open show a lock.

**Sidebar groups**
- 运行 / Operate: Overview, Deployments, Models, Engines, Playground.
- 洞察 / Insight: Observability, Audit, Alerts.
- 服务 / Serve: Access, Billing, Voice.
- 平台 / Platform: System.

Each capability has one home and other pages deep-link to it: keys live only in Access, usage in Observability and Billing, and model management in Models.

## 6. Pages

**(E)** marks an endpoint that exists today. **(N:xx)** marks a new endpoint owned by spec xx.

### 6.1 Overview `/overview`

**Layout**
- **Readiness banner** (only when `readiness.overall` is not `ok`). It shows the first non-ok layer of environment → runtime → components → serving → exposure with that layer's `action`, for example `platform.serving.none` + `platform.action.restoreModels` (06 §11 copy).
- **Four StatTiles**, each with a window and denominator:
  1. 请求 / Requests (24 h), with `错误 {n}（{pct}）/ errors {n} ({pct})`.
  2. 输出 tokens / Output tokens (24 h), with current tok/s.
  3. p95 首字延迟 / p95 TTFT (1 h), with `{n} 个请求 / {n} requests`.
  4. 显存 / GPU memory (now), used and total GiB plus util %.
- **Needs attention**: firing alerts, failed jobs and downloads in the last 24 h, failing doctor checks, and keys expiring within 7 days. Each item has an action link.
- **Running deployments**: compact table (state, model, engine@version, port, context, tok/s) with Playground and Stop.
- **Quick actions**: `新建部署 New deployment`, `启动上次使用 Start last used` (per manager, goes to wizard Review), `下载模型 Download model`, `复制网关地址 Copy gateway URL`.
- **Recent activity**: the last 20 events.

**Endpoints**
- (E) `GET /api/status`, `GET /api/fleet`, `GET /api/m/:id/jobs?fields=summary`, `GET /api/m/:id/recent-launches`.
- (N:06) `GET /api/platform/status` (readiness layers, `models.serving`, `ops`); the banner's action runs `POST /api/platform/restore-models {dryRun:true}` first and shows the plan before the real call.
- (N:04) `GET /api/telemetry/live`, `GET /api/telemetry/summary?from&to&compare=previous`, `GET /api/telemetry/alerts?state=firing`, `GET /api/telemetry/events?limit=20` (recent activity).
- (N:03) `GET /api/hub/downloads?state=failed` (needs attention). (N:05) `GET /api/access/keys?expiring`.

**Degrade path (before 04)**: tiles 1–2 use (E) `GET /api/gateway-access` with the honest window `最近 2,000 行网关日志 / last 2,000 gateway log lines`. Tile 3 shows `—` with `需要遥测后端 / Needs the telemetry backend`. Recent activity reads (ENT-EV1) `GET /api/events/recent?types=jobs,instances,notification&limit=20`, labelled `自本次服务启动 / since the entry started`.

### 6.2 Deployments `/deployments`, `/deployments/:fleetId`, `/deployments/routing`

**List** (DataTable)
- `data-render-key=<fleetId>` keeps keyed identity and focus across refreshes.
- Columns: state (lifecycle phase + %), model, engine (`sglang@0.5.17`), recipe, port, context, VRAM reservation, GPUs, live tok/s, requests in the last hour, uptime.
- Row actions: Playground, Logs, Stop. Stop asks first (ConfirmDialog, danger): `停止 {instance}？正在处理的请求会中断，客户端将收到 503。/ Stop {instance}? In-flight requests are cut and clients get 503.`
- Filters: engine, manager, state. `?manager=` pre-filters.
- Section `最近启动与配置档 / Recent launches & profiles`, per manager. These always open wizard Review and never start directly.

**Detail tabs** (`?tab=`)

| Tab | Content |
|---|---|
| 概览 Overview | Lifecycle Stepper with per-phase durations from `lifecycle.phaseHistory` (00 §9.17), endpoints (local, LAN, gateway; copy), capability chips, image@digest, recipe, GpuMemoryBar, key facts from instance `metrics`/`facts` (§3.9). |
| 指标 Metrics | Live tiles from instance `metrics` (KV usage, running/waiting requests, TTFT p50/p95 since start, with `unsupported[]` shown as such), then telemetry charts filtered to this `fleetId`. |
| 日志 Logs | LogViewer for this instance. |
| 配置 Config | Read-only SchemaForm from the LaunchStore record, CommandPreview, `克隆为新部署 Clone as new`, `保存为配置档 Save as profile`, and the qualification block below. |
| 请求 Requests | Requests explorer filtered to this instance. |
| 事件 Events | Lifecycle timeline. |

**Qualification** (02 §13 and §15, CON-31; Config tab and the wizard's success step): `验证此部署 / Qualify this deployment` starts `POST /api/models/:id/qualify {fleetId}` (202 job) and shows a QualifyChecklist; past runs come from `GET /api/models/:id/qualifications`. After a passing `chat` check, `保存为配方（本机已验证）/ Save as recipe (verified on this host)` opens a Drawer (recipe id, zh/en title, scope `family|this-model`, locks to tick) and sends `POST /api/launches/:launchId/save-recipe`; 409 `recipe_exists` offers overwrite behind a ConfirmDialog, and 422 field errors render inline.

**Header actions**: Stop, Relaunch (through Review), Wake, `打开旧版界面 Open legacy UI`.
- **Wake** is offered when the instance has `sleep.id` (00 §9.17). It sends `POST /api/m/:id/idle-unload/:sleepId/wake {}` with the sleep record id (`slp_…`), never the instance id. A 409 `wake_would_replace_running` opens a danger ConfirmDialog with 08's copy (`唤醒会停止并替换正在运行的「{model}」。确定继续？/ Waking will stop and replace the running model "{model}". Continue?`), and only OK re-sends `{confirmReplace:true}`. A 409 `wake_api_key_missing` shows 08's copy and links to Relaunch. Sleeping records are listed in the Deployments list under `已休眠 / Sleeping` from (N:01 ENG-13) `GET /api/m/:id/instances?include=sleeping`, or (E) `GET /api/m/:id/idle-unload` before it.

**Routing** (keeps the old fleet behaviour and request bodies exactly)
- Mode buttons (`aria-pressed`) send `POST /api/fleet/settings {mode}`.
- VRAM policy saves send `{maxUtilizationPct, reserveMb}`.
- Route preview sends `POST /api/fleet/route-preview {capability, engine, protocol, model?}`, never message content.
- Gateway URLs can be copied.

**Endpoints**
- (E) `GET /api/fleet`, `POST /api/fleet/settings`, `POST /api/fleet/route-preview`.
- (E) `GET /api/m/:id/{instances,idle-unload}`, `POST /api/m/:id/instances/:iid/stop`, `POST /api/m/:id/idle-unload/:sleepId/wake {confirmReplace?}` (08 P0-RT-2), `GET /api/m/:id/{recent-launches,tools/profiles}`.
- (N:01) `GET /api/m/:id/instances/:iid/{logs?tail=500&since=,metrics,launch}`, `POST /api/m/:id/instances/:iid/relaunch {confirm:true, overrides?}` (Relaunch goes through Review first), `GET /api/m/:id/launches?limit=50&status=`, `GET /api/m/:id/launches/:launchId`.
- (N:02) `POST /api/models/:id/qualify {fleetId}`, `GET /api/models/:id/qualifications`, `POST /api/launches/:launchId/save-recipe`.
- (N:04) `GET /api/telemetry/timeseries?…&fleet_id=`, `GET /api/telemetry/events?fleet_id=` (Events tab), `GET /api/telemetry/requests?fleet_id=` (Requests tab).

### 6.3 New deployment wizard `/deployments/new`

```js
// lib/wizard-state.js (pure)
// Draft = { v: 1, id: "wd_…", step, modelRef: null | { kind: "local", entryId, path } | { kind: "remote", source, repo, revision },
//   engineId, managerId, runtimeId, recipeId, goal: null | "max-context" | "balanced" | "throughput" | "low-vram" (02),
//   instance: { mode: "replace"|"parallel", targetInstanceId, instanceId, servedName, port }, gpus: ["0"], values: {}, extraArgs: [], extraEnv: {},
//   access: { networkAccess: "local"|"lan", apiKey: "auto"|"none" }, acknowledge: [] }
// planRequest(draft) → 01 LaunchRequestV2 { engineId, runtimeId, recipeId, model:{ref, servedName}, instance:{mode, id, port, networkAccess, gpuIds},
//   values, extraArgs, extraEnv, acknowledge }; a remote modelRef adds prospective:true and model:{card: cardId} (00 §9.2), so a plan
//   exists before the download; apiKey is never in the draft ("auto" = the manager's secret store generates it)
// launchRequest(draft, plan) → planRequest(draft) + { expectedPlanHash: plan.planHash }
export function createDraft(seed); export function planRequest(draft) /* only explicit user values */;
export function requestKey(body) /* stable JSON, for dedupe only; the server's planHash is the identity */; export function applySuggestion(draft, { param, value }); export function resetParam(draft, id);
export function stepStatus(draft, plan, catalog) /* → { model, engine, resources, capabilities, access, review }: ok|warn|error */;
export function fromLaunchRecord(record); export function fromLegacyProfile(profile, catalog) /* flat camelCase/sglang* via catalog aliases */;
export function diffValues(a, b, catalog) /* → DiffTable rows */
```

**Plan loop** (`usePlan(draft)`)
- Debounce 250 ms, dedupe by `requestKey`, abort the previous request, then send `POST /api/m/:managerId/launch/plan` (N:01). The response is HTTP 200 even when `ok:false` (00 §9.2); its `errors[]` render as field errors and its `blockers[]` as blocker cards with a fix action. Only a 400 (malformed body) or a transport failure is a banner.
- The last good plan stays visible with `更新中… / Updating…`. A failure shows a banner and keeps the last plan. `plan.planHash` is remembered for Launch.
- The plan drives provenance, errors, blockers, `steps[]`, memory, admission and the command preview.
- The draft is saved to `sessionStorage` `console.wizard.draft` on every change, minus every `secret` param value and every `extraEnv` value (only their names are kept, so they must be retyped after a reload). Leaving asks `放弃本次部署配置？/ Discard this deployment draft?`.

**Catalog groups by step** (01 group ids): `model` → 1; `capacity`, `memory`, `parallelism`, `runtime-expert` → 3; `reasoning-tools`, `speculative`, `multimodal`, `sampling` → 4; `network-security` → 5. An unknown group lands on step 3 under `其他 / Other` (a unit test fails if a seeded group is unmapped).

**1 选择模型 / Model** (02 §18 steps ① Source and ② Card)
- Tabs: Library (N:03 `GET /api/hub/library`; degrade: merged (E) `GET /api/m/:id/models`), Running (clone), Online search (a Drawer showing Models → Discover), and `粘贴链接或选择文件夹 / Paste a link or pick a folder` (N:03 `POST /api/hub/resolve-link {url}`; a folder under a registered storage root goes to inspect as `{path}`).
- The ModelCardView comes from (N:02) `POST /api/models/inspect {path}` or `{source, repo, revision}` (cached by 02), then `GET /api/models/:id/card?view=full`. A 404 `card_not_found` re-runs inspect.
- Draft heads, projectors and tooling-only folders can't be chosen as the main model: `这是草稿模型/投影器，需与主模型配合 / This is a draft/projector and pairs with a main model`.
- Each GPU gets a fit badge. An unknown architecture shows `models.compat.unknownArch` (`未知（未验证）/ Unknown (unverified)`, must-keep per 00 §9.13), with `运行预检探针 / Run the dry probe` → (N:02) `POST /api/models/:id/probe {engineId, runtimeId, allowRemoteCode:false}` (202 job followed through `jobs` events; `allowRemoteCode:true` needs its own ConfirmDialog that lists the card's `auto_map` files with `models.remoteCode.confirm`, R-UI-9).
- A remote model offers `先下载 / Download first`. This opens the 03 plan sheet (`POST /api/hub/plan`); the console remembers `jobId → draftId` in `sessionStorage`, and when that job's `downloads` event reaches `ready` it adds a notification linking to `/deployments/new?draft=<id>`. 03's Download & Run (`POST /api/hub/downloads/:id/run {confirmReplace}`) is offered only for the plain case and always shows the replace confirmation.

**2 推理引擎 / Engine** (02 steps ③ Engines and ⑤ Probe)
- CompatMatrix from (N:02) `GET /api/models/:id/compatibility?gpus=0&engines=`. Each 02 Row gives engine, runtime, verdict, reasons, recipes and a recommendation.
- Selecting a row sets `engineId`, `runtimeId`, `recipeId` and `managerId`.
- Blocked rows are disabled and show their reason. Unknown rows are grey, carry the probe action, and can be chosen after a warning; when a probe job finishes, the matrix is refetched.
- `为什么推荐 / Why this engine` explains the choice. Runtime metadata comes from (N:01) `GET /api/engines`.

**3 资源 / Resources** (form plus a sticky resource panel; below md the panel is a chip that opens a Drawer)
- **Instance**: replace or parallel (replace needs a target instance), name, and port checked live via (E) `GET /api/m/:id/port-check`.
- **GPU picker cards** show free/total and other tenants, from (E) `GET /api/m/:id/resources` or (N:04) `telemetry.live`.
- **Goal chips** (02 step ④ Plans; `models.goal.*` copy): `最长上下文 Longest context`, `均衡 Balanced`, `高吞吐 High throughput`, `省显存 Low VRAM`. A chip calls (N:02) `POST /api/launch/recommend {cardId, goal, gpuSets:[draft.gpus]}` and shows PlanCards (≤ 3 per GPU set). Picking a card whose engine differs from the draft first confirms the engine change; the picked plan is then shown as a DiffTable against the current values, and Apply copies its values in (provenance `planner`). Nothing applies without a click.
- **SchemaForm** for this step's groups. The `contextLength` field shows a FitBar under it that follows the debounced plan, so the context control is bound to the fit.
- **Resource panel**:
  - a GpuMemoryBar per GPU (`plan.memory.breakdown`, `perGpuMb`);
  - the admission verdict `可启动 Fits` / `余量紧张 Tight` / `显存不足 Does not fit`, with `admission.message`;
  - `预留 {x} GiB → KV 池约 {tokens} tokens ≈ {n} 个满长度请求 / Reserves {x} GiB → KV pool ≈ {tokens} tokens ≈ {n} full-length requests`;
  - a policy label for `memory.policy` (00 §4.3, §9.1): `device-fraction 整卡比例`, `static-fraction-of-free 空闲显存比例`, `free-fraction-after-weights 权重后剩余比例`, `weights-plus-kv 权重加 KV`, `gguf-estimate GGUF 估算`, `measured 本机实测`, `server-reported 引擎上报`; an unknown policy shows its raw name in mono;
  - a FitSolver over (N:02 MOD-9b/MOD-15) `POST /api/models/:id/fit-grid {engineId, runtimeId, recipeId, gpuIds, kvDtypes, concurrency[]}`; until it lands (404 → `endpoint_unavailable`), FitResult `suggestions[]` render as Apply chips. A FitResult with `spill` adds the RAM bar and `models.fit.spill`.

**4 能力 / Capabilities**
- SchemaForm for reasoning and tool parsers, speculative decoding (draft or projector pairing from the ModelCard `compatibleWith`), multimodal and sampling defaults.
- A `检测到的模板格式 / Detected template format` card with its evidence.

**5 访问 / Access**
- Network: Local or LAN.
- The direct-port API key is auto-generated into the secret store; the console never shows or persists the plaintext. LAN without a key raises a red warning.
- Gateway routability, served-name aliases, and the instance's idle-unload policy.

**6 确认 / Review**
- Effective values with provenance (read-only SchemaForm).
- `plan.overrides[]` as a DiffTable with reasons: `配方将 X 从 A 改为 B，因为… / Recipe changed X from A to B because…`.
- Errors, blockers and warnings, each linked to its field or fix.
- **Image step** from `plan.steps[]` `{kind:"pull", image, required, policy}` (00 §9.2):
  - `required:false`: `镜像已就绪 / Image present`.
  - `policy:"auto"` (stable tier-1 images): `启动时将先拉取镜像 {image}（在替换任何模型之前）/ The image {image} is pulled first, before any model is replaced`. No action needed; this keeps today's behaviour.
  - `policy:"explicit"` (experimental images) comes with the blocker `image_pull_required`. Its card shows `拉取镜像 / Pull image`, which opens a ConfirmDialog (`拉取 {image}？只下载镜像，不会停止任何正在运行的模型。/ Pull {image}? This only downloads the image; no running model is stopped.`) and then sends (N:01 ENG-11) `POST /api/m/:managerId/runtimes/:runtimeId/pull {confirm:true}` → 202 `{ok, job:{id:"dl_…", type:"image-pull"}}` (`existing:true` when a pull is already running). Progress comes from `jobs` events as a ProgressRow, and on success the plan is re-requested. 422 `runtime_local_build` shows 01's rebuild hint instead of a Pull button. Step and blocker copy are 01 §23 `engines.plan.step.pull` and `engines.err.image_pull_required`; the copyable `docker pull` command stays as a secondary option.
- CommandPreview.
- `与上次成功启动对比 / Diff vs last successful launch` (N:01 launches → `diffValues`).
- `保存为配置档 / Save as profile`: (E) `POST /api/m/:id/tools/profiles` with sparse values and `catalogVersion`.
- `启动 / Launch` is disabled while `plan.errors` or `plan.blockers` is non-empty or `admission.verdict==="block"`.
- Replace mode asks first (ConfirmDialog, danger): `替换 {instance}（{model}）？正在处理的请求会中断。/ Replace {instance} ({model})? In-flight requests are cut.`, with `替换并启动 / Replace and launch`.

**7 启动 / Launch**
- (E, extended by N:01) `POST /api/m/:id/start` with `launchRequest(draft, plan)` (it carries `expectedPlanHash`) returns `{job, launchId, plan:{planHash, verdict, warnings, overrides}}`. A 409 `plan_changed` (01 ENG-2) returns to Review with the new plan and a DiffTable `启动前配置已变化，请重新确认 / The plan changed before launch; review it again`; nothing started. Degrade path (before ENG-2): if the returned `planHash` differs, the Stepper shows a non-blocking `启动时配置已变化，查看差异 / The plan changed at launch; view the difference`.
- A Stepper follows the job (`jobs` events or `GET /api/m/:id/jobs/:jobId`) through the 00 §4.1 phases `pull → admission → container → weights → kv → graphs → api → probe → ready`.
- Each phase shows its duration (from `lifecycle.phaseHistory` when present), with a live job LogViewer tail. `pull` is active with progress when the plan's pull step was `auto` and required, and `skipped` when the image was present.
- Phase labels are 01 §23's `engines.phase.*`. The live detail line comes from 01's `job.progress.{phase, stageKey, stageText}`: a known `stageKey` maps to `engines.phase.*`; unknown keys show the server's bilingual `stageText`.
- **Failure**: the job error object (00 §9.11 `{code, signatureId, phase, hint{zh,en}, logExcerpt}`) renders in a RootCausePanel; the Stepper marks `phase` as failed. The signature's `suggestions[]` come from (N:02) `GET /api/knowledge?kind=error-signatures` (fetched once, cached for the session) matched by `signatureId`. Admission failures keep `details.knobs` as Apply chips. Every suggestion returns to Review with the change shown as a DiffTable; nothing relaunches automatically.
- **Success**: `在试一试中打开 Open in Playground`, `复制端点 Copy endpoint`, `查看部署 View deployment`, and `验证此部署 / Qualify this deployment` (02 steps ⑦ Qualify and ⑧ Save as recipe, §6.2 Qualification).

**Quick paths**
- `?model=<ref>&engine=<id>&recipe=<id>`, `?clone=<launchId>&manager=<id>`, `?draft=<id>`, `?profile=<id>&manager=<id>`.
- Start-last-used and profiles land on Review. Applying a profile always shows a DiffTable first.
- Test hooks: `wizard.step.<id>`, `data-field`, `wizard.plan-status`, `wizard.launch`, `wizard.phase.<phase>`.

### 6.4 Models `/models`

**Library**
- StackedBar per storage root and the HF-cache drive: used, models, residue, pending.
- Table columns: name, role, format/quant, size, root, engine chips, verification, provenance `repo@rev`, update, last used.
- Facets: root, format, runnable-on-engine, role, has-update.
- Actions: Deploy, Verify, Check update, Move, Probe, and Delete. Delete asks first (ConfirmDialog, danger) with type-to-confirm on the folder name and shows the bytes freed; a root can never be targeted.

**Discover**
- A debounced (300 ms) search with source `Hugging Face` / `HF 镜像 HF mirror` / `ModelScope`.
- Facets: `本机可运行 Fits this GPU`, engine, format, size class, vision, reasoning, MoE, gated, `更新于 Updated within`.
- Family cards with variant chips (`FP8 31 GB ✓`) and `已在库中 In library` / `有更新 Update available` badges. Cursor-based "load more".

**Model detail** (`/models/library/:entryId`, `/models/hub/:source/:repo*`)
- Tabs: 概览 Overview (ModelCardView); 兼容性 Compatibility (CompatMatrix); 量化版本 Quantizations (remote only: quant, files, size, est. VRAM at 8K and 32K, fit, engines, recommended star); 文件 Files; 说明 README (MarkdownViewer); 来源 Provenance (local only: provenance and history).
- Actions: Download, `下载并部署 Download & deploy`, Deploy, Probe, Copy id, `在源站打开 Open on hub`.

**Download plan sheet** (Drawer)
- Artifact summary and a quant radio table.
- Target root with a before/after free-space bar and an "already have it" warning.
- Companions (mmproj, draft).
- Source `自动 Auto` with measured latency, or a manual override.
- Auth status with `登录 Hugging Face / Log in` (opens the local CLI window) and `打开申请页 / Open approval page`.
- ETA. Blockers come with fix buttons and never as a silently disabled button. One CTA.

**Downloads** (tabs 进行中 Active / 排队 Queued / 历史 History)
- Active: ProgressRow plus a phase Stepper `排队 queued → 解析 resolving → 下载 downloading → 物化 materializing → 校验 verifying → 就绪 ready`, per-file rows, and an aggregate throughput sparkline.
- Queued: reorder by drag or by ↑/↓ keyboard buttons, priority, `立即开始 Start now`, `全部暂停 Pause all`.
- History: search.
- Failure card: classified cause plus `登录 Log in`, `打开申请页 Open approval page`, `切换来源 Switch source`, `更换目录 Change root`, `释放空间 Free space`, `重试 Retry`.
- Actions: Pause, `取消（保留文件）Cancel (keep files)`, and `取消并删除已下载部分 Cancel and delete partial files` (asks first, showing reclaimable bytes).
- Settings Drawer (global): sources and mirror, Xet, SHA256, retry per error class, concurrency, idle-only, notifications.

**Storage**
- Roots with capacity, `注册目录 Register folder` (folder dialog), `设为默认 Set default`, `移除 Unregister`.
- Migrations: plan → start → progress → rollback / cleanup, at parity with `model-storage.spec`.

**Knowledge** `/models/knowledge` (02 `routes/knowledge.js` requirement, built in 07's layout as `console/routes/models/knowledge.js`)
- Tabs `模型家族 Families`, `模板签名 Template signatures`, `错误签名 Error signatures` from (N:02) `GET /api/knowledge?kind=&q=&withMatches=1`; each entry shows its layer (`models.knowledge.layer.*`), file, matched cards and heuristic hits.
- Status panel from `GET /api/knowledge/status`: domains, layers, files, invalid entries (`models.knowledge.status.invalid`) and stale files (`asOf` past `staleAfterDays`), including the manager domains (engines, recipes, launch-params).
- `导入知识包 / Import a pack`: `POST /api/knowledge/import {url|content}` previews the diff, and only `确认导入 / Confirm import` sends `{confirm:true, sha256}`. `删除 Delete` on a pack sends `DELETE /api/knowledge/packs/:packId` with `x-confirm: delete` after a ConfirmDialog. `重新加载 Reload` → `POST /api/knowledge/reload`.
- Per-model overrides: from a model's detail page, `编辑覆盖 / Edit override` → `PUT /api/knowledge/overrides/models/:cardId` with inline 422 field errors.

**Endpoints**
- (N:03) Library: `GET /api/hub/library[?q&rootId&format&provenance&duplicates=1&cursor]`, `GET /api/hub/library/:id`, `POST /api/hub/library/rescan`, `POST /api/hub/library/:id/{verify,check-update,update,identify,import,cleanup-residue}`, `DELETE /api/hub/library/:id {confirm}`, `GET /api/hub/tasks/:id`. Move deep-links to the Storage migration planner (03 keeps it in the managers).
- (N:03) Discover: `GET /api/hub/search?q&provider&sort&limit&cursor&facet&context`, `GET /api/hub/repos/:provider/:owner/:name[/readme|/files]`, `POST /api/hub/resolve-link {url}` (paste box), `POST /api/hub/plan`, `POST /api/hub/sources/probe`, `GET /api/hub/auth/huggingface[/access?repo=]`, `POST /api/hub/auth/huggingface/login`.
- (N:03) Downloads: `POST|GET /api/hub/downloads`, `GET /api/hub/downloads/history`, `GET /api/hub/downloads/:id[/logs|/resume-check]`, `POST /api/hub/downloads/:id/{pause,resume,retry,start-now,cancel,priority,run}`, `POST /api/hub/downloads/{reorder,pause-all,resume-all}`, `DELETE /api/hub/downloads/:id`, `GET|PUT /api/hub/settings`, `GET /api/hub/status`. Cancel sends `{deletePartial, confirm: outputName}`.
- (N:03) Storage: `GET /api/hub/storage/usage`, `POST /api/hub/storage/cleanup {targets, confirm:true}`; (E) `/api/m/vllm/model-storage*` for roots and migrations.
- (N:02) `POST /api/models/inspect`, `GET /api/models/:id/{card,compatibility}`, `POST /api/models/:id/probe`, `GET /api/knowledge[/status]`, `POST /api/knowledge/{import,reload}`, `DELETE /api/knowledge/packs/:packId`, `PUT /api/knowledge/overrides/models/:cardId`.

**Degrade path (before 03)**: Library merges (E) `/api/m/{vllm,llama}/models`. Storage uses (E) `/api/m/vllm/model-storage*`. Downloads are read-only (E) `/api/m/:id/jobs`, with the banner `下载中心需要模型中心后端 / The downloads center needs the model hub backend`.

### 6.5 Engines `/engines`

- **Engine cards**: label, tier (`内置 Built-in` / `实验 Experimental` / `自定义 Custom` / `外部 External`), host manager, health, runtimes (`present` false = image not pulled), capability chips. An offline manager from `errors[]` shows a grey card with `{manager} 未运行 / {manager} is not running`.
- **Engine detail tabs**:
  - Runtimes: `runtimeId`, image (copy), present, introspected and when, features, `localBuild`. Action `探测参数 Introspect` (job, ConfirmDialog because it runs a short-lived container). A runtime with `present:false` offers `拉取镜像 / Pull image` → ConfirmDialog → (N:01 ENG-11) `POST /api/m/:id/runtimes/:runtimeId/pull {confirm:true}` → `dl_` job (`type:"image-pull"`) with progress from `jobs` events (the same endpoint 06's doctor fix calls); the `docker pull` command stays copyable. Stable images are also pulled automatically by a launch (§6.3).
  - Parameters: SchemaForm `catalog`, with ParamView `availability` badges (`本版本不支持 Not in this runtime`, `未验证 Unverified`).
  - Flag diff: pick runtime A, then `GET …/flags?against=<B>` lists added, removed and changed flags and choices.
  - Recipes: from the schema response `recipes[]` (status, eligible, score, reasons, locks).
  - Descriptor: read-only JSON.
- **`/engines/new` Custom Docker engine** (a descriptor builder, because 01 makes custom engines descriptor files only): 基本信息 Basics (id `[a-z][a-z0-9-]{1,31}`, label zh/en, image, port, health path) → 启动映射 Launch mapping → 显存模型 Memory model → 确认 Review. Review validates in the browser against `lib/schemas.js` `EngineDescriptorGuard`, then server-side through (N:01 ENG-2) `POST /api/m/vllm/engines/descriptors/validate {descriptor}` → `{ok, errors[]}` (side-effect free; on 404 only the browser check is shown). It shows the JSON and offers `复制 Copy` and `下载 .json Download` plus the target folder and reload instructions; writing stays manual.
- **External endpoints** table: name, base URL, models, latency, health, routable. The add dialog takes the API key as a write-only secret. Actions: `测试 Test`, `编辑 Edit`, `移除 Remove` (asks first).
- **Knowledge status** panel: (N:02) `GET /api/knowledge/status` domains and their errors, linking to `/models/knowledge`.

**Endpoints**
- (N:01) entry `GET /api/engines`; manager (via proxy) `GET /api/m/:id/engines`, `GET /api/m/:id/engines/:engineId/schema?model=&runtime=&recipe=` (with `facts`), `POST /api/m/:id/engines/descriptors/validate`, `POST /api/m/:id/engines/:engineId/runtimes/:runtimeId/introspect {confirm:true}`, `GET /api/m/:id/engines/:engineId/runtimes/:runtimeId/flags?against=`, `POST /api/m/:id/runtimes/:runtimeId/pull {confirm:true}`.
- (N:01) `GET|POST /api/engines/external/endpoints`, `PATCH /api/engines/external/endpoints/:endpointId`, `DELETE /api/engines/external/endpoints/:endpointId?confirm=1`, `POST /api/engines/external/endpoints/:endpointId/test`.
- (N:02) `GET /api/knowledge/status`.

### 6.6 Playground `/playground` (replaces `index.html:2680-2891`)

**Ported logic**: `lib/sse-parse.js` (`parseSseChunk(buffer) → {events, rest}`, the existing frame splitter) and `lib/route-header.js` (`describeRoute`).

**Config panel** (a Drawer below md)
- Target: `自动路由 Auto route`, a specific engine `/gateway/<engineId>`, or an external endpoint.
- Model (from `{base}/models`) and system prompt.
- temperature, top_p and max_tokens, each with a one-line explanation.
- `显示思考 Show reasoning`: when the ModelCard has `controls.reasoningToggle {on, off}` (05 C8 to 02), the matching request patch is merged into the body; otherwise the switch only shows or hides `reasoning_content`.
- **Credentials** (C13, 05 §5.8): an owner sends no key. Requests go with the session cookie (same-origin `fetch`) plus `api.csrfHeaders()`, and 05 attributes them to the `console-session` principal and the telemetry client `console`. A 403 `csrf_invalid` re-reads `/api/session` and retries once. A key field appears only when the gateway answers 401 (a viewer, or before `gateway.consoleSession`), or when the owner opens `用指定密钥测试 / Test with a specific key`; its value lives only in component state, is sent as `Authorization: Bearer`, is never stored, logged or shown again, and is cleared on navigation.

**Transcript**
- Streamed content with collapsible `reasoning_content`, and tool calls as JSON CodeBlocks.
- Per message: TTFT, total time, tok/s from `usage` (`stream_options:{include_usage:true}`), the route (`x-local-ai-route`) and the request id, which links to `/observability/requests/<id>` when telemetry is on.

**Presets and exports**
- Presets: `测试工具调用 Test tool calling` and `测试图像理解 Test vision` (when the model reports vision).
- `复制为 curl / Copy as curl` and Python, always with `$API_KEY`.
- C3 adds a two-pane compare mode.

**Privacy**: the transcript and any typed key live in memory only; no storage is ever written by this page.

**Endpoints**: (E) `/gateway/auto/openai/v1/{models,chat/completions}`; (N:01) `/gateway/<engineId>/…` and `/gateway/external/<id>/…`; all on the ADMIN origin, accepted for the `console-session` principal by 05.

### 6.7 Observability `/observability/*` (04 §19 is the binding data contract)

**Header**
- TimeRangePicker (15 m, 1 h, 6 h, 24 h, 7 d, 30 d, custom) plus 04's common filters `manager_id, fleet_id, engine_id, model, key_id, source_program, protocol`. All state lives in the URL.
- Auto-refresh and `复制视图链接 / Copy view link`.
- Metric ids are 04's `METRICS` names (`req.count`, `lat.ttft_p95`, `rt.kv_usage`, …), listed in `data/metric-ids.js`. Labels come from the catalogs as `obs.metric.<id>`, next to 04 §19.1 `obs.*` keys. The i18n test fails if an id has no label.

| Sub-page | Panels (calls exactly as in 04 §19) |
|---|---|
| 总览 Overview `/observability` | Live strip (`telemetry.live`), KPI tiles from `summary?compare=previous` with the window on every tile, sparklines, firing-alerts banner, requests by status class. |
| 性能 Performance `/performance` | TTFT p50/p95/p99 by model with launch, config, benchmark and container annotations; engine metrics by fleet with the `latency_source` badge (`obs.latencyFromGateway`); the TTFT heatmap. |
| 流量 Traffic `/traffic` | By key, source and protocol; breakdown rows with sparklines; auth failures by IP (owner only). |
| 错误 Errors `/errors` | Rate by `error_class`; a class table whose rows open Requests pre-filtered. |
| GPU 与能耗 GPU & energy `/gpu` | Util, VRAM, temperature, power and clocks with throttle reasons; VRAM by instance labelled `obs.reservation`; energy by day and by model, with `obs.noPrice` when no tariff is set. |
| 模型与实例 Models & instances `/models` | Lifecycle Gantt, launch reliability with top failures, truncation share, and imported lifetime totals (`obs.importedLifetime`, never charted over time). |
| 请求 Requests `/requests[/:requestId]` | Cursor DataTable with facets; owner export through `exportHref`. Detail: timeline waterfall, billing, instance and launch link, events, and the audit link. `x-audit-session` is sent only while audit is unlocked. |
| 遥测设置 Settings `/settings` (owner) | Retention, sampling, energy tariff; collector status; import with a dry run first. |

Every 04 §19 edge state has a test: metric unsupported, idle instance, collection gap (`null` renders as a break), no price, audit index building, read-only viewer.

**Endpoints** (N:04): `GET /api/telemetry/{live,summary,timeseries,breakdown,requests,requests/:requestId,events,energy,lifecycle,launches,baseline,export,status,settings}`, `PUT /api/telemetry/settings`, `POST /api/telemetry/import`, `GET /api/telemetry/import/:runId`.

**Viewer**: 05 §5.4 does not allow `/api/telemetry/*`, which leaves 04's `obs.lanReadOnly` state unreachable. If the owner chooses redacted viewer telemetry (§16 item 4), 04 registers redacted `live`, `summary` and `timeseries` in `viewer-allowlist.js` and this page renders `obs.lanReadOnly`; otherwise a viewer gets the PairingScreen hint here.

**Degrade path (before 04)**: one card, `旧版统计 / Legacy statistics`, from (E) `/api/m/:id/stats` and `/api/gateway-access`, with an explicit window. No charts are drawn from lifetime averages.

### 6.8 Audit `/audit/*` (owner, local)

- **Unlock**: `POST /api/audit/login {password}`. With 05 PUB-5's elevation cookie (`lai_elev`, HttpOnly, `Path=/api`, bound to the session; 05 §5.6) the response is `{ok, expiresAt}` plus `Set-Cookie`; the console holds only `expiresAt`, never a token, and the cookie rides on `/api/audit/*` and telemetry request detail. Degrade path (a response that still carries `token`): `lib/audit-session.js` keeps it in a closure only (never storage) and sends it as `x-audit-session` on `/api/audit/*` content routes and telemetry request detail (04 R8). Either way the unlock ends at `expiresAt`, on `锁定 Lock` (`POST /api/audit/logout`, which clears the cookie) or on tab close.
- **Conversations**: `GET /api/audit/chats?q&user&model&from&to&archived&cursor&limit`. The thread is `GET /api/audit/chats/:chatId?auditId`, with versions from `…/versions`. Content renders through MarkdownViewer and never as raw HTML.
- **Export chain**: `GET /api/audit/status` (chains, retention plan, index state), `GET /api/audit/exports`, `GET /api/audit/exports/:auditId/markdown`, `立即导出 Export now` → `POST /api/audit/export {mode, note}`.
- **Access log**: `GET /api/audit/access-log?from&to&cursor`, `GET /api/audit/access-log/verify`.
- **Settings**: `GET|PUT /api/audit/settings`.
- **Timeline**: (N:04) `GET /api/telemetry/events?type=launch.,alert.,access.,security.`.

**Degrade path**: (E) `/api/m/:id/audit/*`, with the bearer kept in memory only, never in localStorage (fixes frontend finding 13).

### 6.9 Alerts `/alerts`

- **Tabs**: `触发中 Firing`, `历史 History`, `规则 Rules`, `通知渠道 Channels`.
- **Firing**: `GET /api/telemetry/alerts?state=firing`. `确认 Ack` → `POST /api/telemetry/alerts/:ruleId/ack {scopeKey}`; `静默 Silence` → `…/silence {scopeKey, until}` (1 h, 8 h, 24 h, custom).
- **History**: `GET /api/telemetry/alerts?state=all&limit` plus `GET /api/telemetry/events?type=alert.`.
- **Rules**: `GET /api/telemetry/alert-rules` returns rules plus `metrics` (`ALERT_METRICS`, with zh/en labels and units). The rule Drawer covers metric, scope, op, threshold and clear threshold with unit, window, for-duration, severity, channels and enabled. `POST` creates a custom rule; `PUT /:ruleId` edits; `DELETE /:ruleId` is offered for custom rules only (a builtin rule returns `409 builtin_rule`, and the UI offers Disable instead).
- **Channels**: webhooks (masked URLs) from `GET|PUT /api/telemetry/settings` `alerts.webhooks`; `发送测试 Send test` → `POST /api/telemetry/alerts/test {channel, webhookId?}`. The Windows-toast channel shows `toastChannel` (`available` / `no_subscriber`).

### 6.10 Access & keys `/access/*` (content per 05 §13.4–13.6; files `console/routes/access/{index,keys,key-detail,clients,public,security,portal,sessions}.js`)

05 PUB-21/22's console requirements are built here, in this layout (00 §9.16); 05's `tests/access-console.spec.cjs` becomes `tests/frontend/console/console-access.spec.js`.

- **`/access`** (`access/index.js`): cards for Keys, Public access, Security, Clients and Sessions. When `GET /api/access/migration` has findings, a banner links to them.
- **`/access/keys`** (`access/keys.js`, `access/key-detail.js`, components KeyForm and ShareCard):
  - Tabs: 密钥 Keys, 客户 Customers (billing customers through (E) `/api/billing/customers`), 审计 Audit (`GET /api/access/audit`).
  - The table, filters, attention strip, create drawer with presets from `GET /api/access/presets` (field help in zh and en), and key detail all follow 05 §13.4.
  - **ShareCard**: built from the create or rotate response `{key, secret, share}`, with QR and invite text. The secret lives only in that component's state and is cleared on close. Closing needs `我已保存密钥 / I have saved the key`, and the card cannot be reopened.
  - **Revoke** needs `confirmName` typed back. **Rotate** asks for the overlap (`0 / 1 h / 24 h / 7 d`). **Bulk revoke** needs `REVOKE n`. All three use ConfirmDialog `typeToConfirm`.
  - Key detail: limits editor (`PATCH`), usage day/month, 04 `timeseries?key_id=`, and recent requests (`requests?key_id=`).
- **`/access/public`** (`access/public.js`, components ExposureMap and ChecksList): the 05 §13.5 seven-step wizard: topology → base URL → generated files (`GET /api/public/templates?topology=`, `写入 config/public Write` → `POST /api/public/templates/write {topology, overwrite:false}`) → keys → live checks (`GET /api/public/exposure`, `重新扫描 Rescan` → `POST /api/public/exposure/scan`, `外部探测 External probe` → `POST /api/public/probe`) → exposure map (SVG from `report.map`, nodes and edges with evidence) → go live, which first lists the direct callers that enforcing will cut off. Settings go through `GET|PATCH /api/public/settings`, and `restartRequired` is shown. The platform starts nothing.
- **`/access/security`** (`access/security.js`): `GET /api/security/overview?from&to` (bans, top IPs, anomalies), `GET /api/security/events`, bans through `GET|POST /api/security/bans` and `DELETE /api/security/bans/:subject` (each behind a ConfirmDialog; 05 audits them). Legacy findings show only a copy button for the suggested command and the 05 note that nothing is deleted or stopped automatically; there is no delete control.
- **`/access/portal`** (`access/portal.js`, owner): announcements (`GET|POST /api/public/announcements`, `PATCH|DELETE …/:id`) and public model metadata (`GET|PUT /api/public/models/:modelId/meta`).
- **`/access/clients`** (`access/clients.js`, viewer allowed): guides for OpenWebUI, Claude Code, OpenCode, Chatbox, Cherry Studio, curl and Python. Templates live in `data/client-guides.js` with `{baseUrl}`, `{model}` and `$API_KEY`. A base-URL selector offers `本机 Local` / `局域网 LAN` / `公网 Public` (Public only when `public.baseUrl` is set).

**Endpoints** (N:05): `GET|POST /api/access/keys`, `GET|PATCH /api/access/keys/:id`, `POST /api/access/keys/:id/{rotate,revoke}`, `POST /api/access/keys/bulk-revoke`, `GET /api/access/{presets,migration,audit}`, `GET|PATCH /api/public/settings`, `GET /api/public/{exposure,templates}`, `POST /api/public/{exposure/scan,probe,templates/write}`, announcements, model meta, `GET /api/security/{overview,events,bans}`, `POST /api/security/bans`, `DELETE /api/security/bans/:subject`.

**Degrade path (before 05)**: (E) `GET /api/keys`, `GET /api/security` and `/api/m/:id/service-clients[/:id[/rotate]]`, under the banner `旧版按引擎密钥 / Legacy per-engine keys`.

### 6.11 Billing `/billing`

- **C1**: `<iframe src="/billing/classic?embed=1&theme=<t>&manager=<m>" title="计费中心 / Billing center">` fills the content area and reloads on theme change. It needs an owner session and keeps `strictLocalBillingAdmin` (05 §5.4); others see the EmptyState `计费管理仅限本机 / Billing administration is local-only`.
- **C4 native routes** (`overview customers plans prices credentials usage ledger audit`) use (E) `/api/billing/*` and (N:04) `GET /api/billing/usage/summary?groupBy=customer,model,day&from&to`, with cursor pagination and real aggregates that drill down to raw rows. The debit confirmation is type-to-confirm and keeps the wording `不可逆的扣款记录 / irreversible debit record`.

### 6.12 Voice `/voice`

- One card per engine from (E) `GET /api/status` `.tts.engines`.
- Owner actions `安装 Install` / `启动 Start` / `唤醒 Wake` / `卸载 Unload` / `停止 Stop` → (E) `POST /gateway/tts/api/models/:id/actions/:action` through the API client: session cookie plus `x-csrf-token`, no API key (C13; 05 grants the `console-session` principal `tts:*`). `卸载 Unload` and `停止 Stop` ask first. Before `gateway.consoleSession` is true, a 401 shows `需要配对或 API 密钥 / Needs pairing or an API key` and links to the workbench.
- `打开语音工作台 / Open voice workbench` opens `/gateway/tts/` in a new tab.
- The page never polls `/gateway/tts/api/jobs` (stats finding 5).

### 6.13 System `/system/*` (06 §11 is the content contract; OPS-15 is retired into CON-24/24b)

Files: `console/routes/system/{index,doctor,settings,updates,ops,preferences,ui-kit}.js`; copy in the `platform` area (06 §11 keys, written under the `platform.` prefix, §3.7). Every `/api/platform/*` error uses 06 §10.1's codes; `supervisor_unavailable` renders `platform.supervisor.missing` with `platform.action.startSupervisor`.

| Route | Content | Calls |
|---|---|---|
| `/system` (CON-24) | Supervisor banner when it is not running (`POST /api/platform/supervisor/start`, owner on loopback). Component table: state (`platform.state.*`), owner, port, uptime, restarts, last exit, pending restart. Row actions Start, Stop, Restart, `空闲后重启 Restart when idle` (`{when:"idle"}`) and Logs (LogViewer, `kind: component`). A 409 `component_busy` lists its `blockers` with `platform.busy.refuse` and offers Restart when idle. **Danger zone**: `停止平台 / Stop platform` → ConfirmDialog `typeToConfirm: "stop"` with `platform.stopAll.confirm` → (E) `POST /api/stop-all`; it replaces the classic header button. | `GET /api/platform/{status,components}`, `POST /api/platform/components/:id/{start,stop,restart}`, `GET /api/platform/components/:id/logs?tail=` (follow via `…/logs/follow` SSE), operations via `GET /api/platform/operations/:opId` or `platform` events `kind:"operation"` |
| `/system/doctor` (CON-24b) | Checks grouped by category with status and detail. Fix kinds: `auto` runs at once; `confirm` opens a ConfirmDialog first; `manual` shows `platform.fix.manual` with the command in a CodeBlock, Copy and Docs, and **sends no request**. The `pull-image` fix goes through 06's backend, which calls 01's pull endpoint. | `GET /api/platform/doctor?group=&fresh=`, `POST /api/platform/doctor/fix {checkId, fixId, confirm:true}` → 202 `{opId}` |
| `/system/settings` (CON-24b) | SchemaForm `config` mode over `describeEffectiveConfig()`: source badges `platform.source.{env,file,default,derived,runtime}`, `platform.settings.restartRequired`, secret leaves as write-only Set/Replace/Clear (sent in `secrets`, never echoed). Save sends `PUT` with `If-Match: <etag>`; 400 `config_invalid` maps `errors[]` to fields; 409 `config_conflict` reloads and shows a DiffTable; 409 `config_locked` retries after 2 s once. `应用 Apply` → `POST /api/platform/config/apply {restart, when:"idle"}` (a `now` option asks first; restarting the entry drops the connection and the shell reconnects). | `GET /api/platform/config`, `PUT /api/platform/config`, `POST /api/platform/config/apply` |
| `/system/updates` (CON-24b) | Version, build (`commit`, `contentHash`), `platform.updates.newer`, `platform.drift.found`, deploy history, pending restarts with cancel (ConfirmDialog). | `GET /api/platform/{version,deploys,pending-restarts}`, `DELETE /api/platform/pending-restarts/:id` |
| `/system/ops` (CON-24b) | Nightly trend (30 bars, `platform.nightly.failing` when streaking), backup age, scheduled-task status, autostart status with `platform.autostart.howto` and the command to copy; nothing is registered from the console. | `GET /api/platform/schedules`, doctor `ops.*` |
| `/system/preferences` (CON-24, 07) | Theme, language, density, browser notifications, reset. Viewer allowed. | none |
| `/system/ui-kit` (CON-5, hidden) | Every component in every state for the axe and visual specs. | fixtures |

**Viewers** see `/system` through 06's registered redactions (state, layer status, no pids, ports, commands or actions) and no write controls; the other System routes are owner-only.

**Degrade path (before P6, `features.platform=false`)**: `/system` lists components from (E) `/api/status` with (E) `POST /api/managers/:id/start|stop` and copyable commands for TTS, MCP and search; `/system/doctor` renders (E) `/api/m/:id/tools/health` with its actions; settings, updates and ops show EmptyState `该功能需要后端组件 P6 / Requires backend component P6`.

### 6.14 First-run `/setup` (CON-25; 06 §8 and §11)

- **Auto-route**: boot step 8 (§3.2). `稍后 Skip for now` sets the `dismissedSetup` preference. Re-entry is through the palette or the StatusStrip popover.
- **Body**: the ten 06 §8 steps from `GET /api/platform/setup` as a Stepper, each with status, explanation and one primary button. `POST /api/platform/setup/:step` returns 202 `{opId}`; progress comes from `platform` events `kind:"operation"` or `GET /api/platform/operations/:opId`, shown as a ProgressRow (the `images` step shows the pull jobs' byte progress). The `ops` step only shows commands to copy. The `exposure` step links to `/access/public` for public go-live. The page ends when `completedAt` is set or the owner clicks `跳过设置 / Skip setup`.
- **Composition**: steps that need console pages (`storage`, `first-model`, connect a client) deep-link with `?from=setup`, which adds a `返回首次设置 / Back to setup` bar. `first-model` opens `/deployments/new` seeded from (N:02) `POST /api/launch/recommend {goal:"balanced"}` over the library, or from (N:03) search with `context=`.
- **Before 06**: a five-item checklist derived from `/api/status`, `/api/fleet` and `/api/hub/library` (Docker, GPU, a model in the library, a serving instance, a key), each with a link to its page.

### 6.15 Pairing and sessions (05 §5)

- **PairingScreen** (component in §4.4): shown for role `none`, for a 401 `admin_session_required`, and on owner-only routes for a viewer. Copy keys: `pair.title`, `pair.body` (05's text: 「此浏览器尚未与本机控制台配对……」 / "This browser is not paired with the console yet…"), `pair.invalid`, `pair.cmd`. A viewer on a viewer-readable page sees the `shell.readonly` banner instead.
- **`/access/sessions`** (owner): `GET /api/session/list` (created, last seen, IP, user agent, current), `撤销 Revoke` → `DELETE /api/session/:id` (ConfirmDialog; revoking the current session warns that this tab must pair again), and `配对新设备 Pair a device` → `POST /api/session/pair-codes {ttlSeconds:120, lan?}`. That shows the code, a QR of the returned `url` (lazy `qrcode`) and a countdown; a LAN code without `admin.allowLanOwner` answers 403 `lan_owner_disabled`, shown inline. The code is never logged or kept after the dialog closes. `退出 Sign out` → `POST /api/session/logout`.
- The palette also maps "Settings → Sessions" to `/access/sessions`.

## 7. Endpoint matrix

**Provided (07)**
- ENT-EV: `GET /api/events`, `GET /api/events/recent` (§2.8), `ANY /api/m/:managerId/*` (§2.10), and the in-process `bus` API for 03, 04 and 06 (`publish`, `subscribe`, `subscriberCount`).
- CON-2: everything in §2.4 and §2.5.

**Consumed**

| Owner | Endpoints | Guard |
|---|---|---|
| existing entry | `/api/status`, `/api/fleet`, `/api/fleet/settings`, `/api/fleet/route-preview`, `/api/security`, `/api/keys` (GET), `/api/gateway-access`, `/api/managers/:id/start\|stop`, `/api/stop-all`, `/api/billing/*`, `/gateway/*` | StatusGuard, FleetGuard |
| existing managers (via ENT-EV2) | `instances`, `instances/:id/stop`, `idle-unload`, `idle-unload/:sleepId/wake`, `jobs`, `models`, `stats`, `resources`, `port-check`, `recent-launches`, `tools/{profiles,health}`, `model-storage*`, `service-clients*`, `audit/*` | per resource |
| 01 engines | entry `GET /api/engines`, `/api/engines/external/endpoints*`; manager `engines`, `engines/:id/schema` (with `facts`), `engines/descriptors/validate`, `launch/plan` (`planHash`, `steps[]`, `blockers[]`), `start` (`expectedPlanHash`, 409 `plan_changed`), `instances/:id/{logs,metrics,launch,relaunch}`, `launches[/:launchId]`, `runtimes/:rid/{introspect,flags,pull}`, `config` (`entryPort`) | EngineGuard, SchemaCatalogGuard, EngineDescriptorGuard, LaunchPlanGuard, InstanceMetricsGuard, JobGuard, JobErrorGuard |
| 02 models | `POST /api/models/inspect`, `GET /api/models/:id/{card,compatibility,qualifications}`, `POST /api/models/:id/{probe,qualify,fit-grid}`, `POST /api/launch/recommend`, `POST /api/launches/:launchId/save-recipe`, `/api/knowledge*` | ModelCardGuard, FitResultGuard, FitGridGuard, PlanCardGuard, CompatRowGuard |
| 03 hub | `/api/hub/{status,search,repos/*,resolve-link,plan,downloads*,library*,tasks/:id,storage/*,settings,auth/huggingface*,sources/probe}` | DownloadJobGuard, LibraryEntryGuard |
| 04 telemetry | `/api/telemetry/*` (§6.7, §6.9), `/api/audit/*` (§6.8), `/api/billing/usage/summary` | TimeseriesGuard, BreakdownGuard, RequestRowGuard, AlertGuard |
| 05 public | `/api/session*`, `/api/access/*`, `/api/public/*`, `/api/security/*`; `console-session` on ADMIN `/gateway/*`; `viewer-allowlist.js` registration | SessionGuard, KeyGuard |
| 06 ops | `/api/platform/*` (§6.13, §6.14: status, components, logs, supervisor/start, doctor, doctor/fix, operations, config, config/apply, version, deploys, schedules, pending-restarts, restore-models, setup); `getBuildId()`; `console.defaultUi` | PlatformStatusGuard, ComponentGuard, DoctorCheckGuard |

## 8. Mobile (390 px)

**Global rules**: no page-level horizontal overflow on any route (tested); 16 px gutter; tap targets ≥ 40 px; wide tables scroll inside their own container or switch to card mode; toasts at the bottom. **Shell**: the sidebar becomes a hamburger Drawer; the topbar keeps the overall status chip, the bell and the palette button.

**Priority pages**
- **Overview**: tiles in 2 columns, then lists.
- **Deployments**: cards with the state badge first and a row action menu.
- **Wizard**:
  - header `第 3 步，共 7 步 · 资源 / Step 3 of 7 · Resources`;
  - sticky Back/Next bar;
  - the resource panel becomes a chip `显存 82/95 GiB · 可启动 / VRAM 82/95 GiB · Fits` that opens a Drawer;
  - help popovers become bottom sheets.
- **Playground**: config in a Drawer, sticky input.

**Other pages**: charts stack at full width (height 180); the Requests explorer uses card mode; the billing iframe scrolls internally.

## 9. Accessibility (WCAG 2.2 AA)

**Structure**
- Skip link, landmarks, and one `h1` per route that receives focus. Ordered headings.
- One polite live region plus `role=alert` for errors. Never put `aria-live` on data panels; this keeps the existing fleet-test rule.

**Interaction**
- Everything is keyboard-operable:
  - Tabs use roving tabindex.
  - Dialogs trap focus and restore it on close.
  - The palette uses `aria-activedescendant`.
  - Drag reorder has keyboard alternatives.
  - Charts offer a table view.
- Visible `:focus-visible` ring of 2 px. Reduced motion is respected.
- Target size ≥ 24×24 (2.2 SC 2.5.8); controls default to 36–40 px.
- Status uses an icon plus text, never color alone.
- `<label for>` on every field, with errors and units in `aria-describedby`.

**axe gate**: every page spec runs axe-core in light and dark at 1440 and 390. `serious`/`critical` fail; `moderate` fails unless listed with a justification in `tests/frontend/helpers/axe-allowlist.json` (initially empty).

## 10. Security

**Page integrity**
- Strict CSP (§2.3) with `script-src 'self'` and no inline executable script (C1b). No `eval`, and the lint test bans `innerHTML` and its relatives.
- Markdown renders as VNodes. URLs pass `lib/url.js safeUrl()` (`http:`, `https:`, relative, `#`).
- Notification actions (§3.6) accept only same-origin relative `href` and `/api/…` `apiCall` paths, run only on click, and always confirm first.

**Secrets**
- No key, token or secret is ever written to localStorage, sessionStorage, cookies, URLs, logs or error reports (00 hard rule).
- Generated keys exist only in ShareCard state. The Playground sends no key on ADMIN (C13); a key typed for "Test with a specific key" lives only in component state.
- The admin session and the audit unlock are 05's HttpOnly `SameSite=Strict` cookies; the console never reads them. The CSRF token (and, on the audit degrade path only, the audit token) live in closures.
- A `#pair=` code is stripped from the URL before any other code runs and is sent only in the pair POST body.
- Commands and job `logExcerpt`s are shown exactly as the server redacted them.
- `secret` params are sent only when the user types them.

**Authorization and request safety**
- The server decides authorization; the UI only hides controls. Every entry module asks the one seam `request-auth.js` (§2.9).
- Every mutation is a POST, PUT, PATCH or DELETE from the same origin with `x-csrf-token`, so 05's exact-origin and CSRF checks apply. No GET mutates. Container stops, replaces, wakes that replace, deletes, revokes and image pulls always go through ConfirmDialog.
- `console-session` gateway calls exist only on the ADMIN listener; the PUBLIC listener never accepts session cookies (05).
- The management proxy forwards an allowlist of headers only, mints `x-request-id`, and never forwards cookies, CSRF tokens or `x-forwarded-*` (§2.10). The event bus redacts per type for viewers and never streams to the PUBLIC listener (§2.8).
- Only `/billing/classic` relaxes `frame-ancestors`, to `'self'`, and it is local-only.

**Privacy**: transcripts stay in memory; request drill-down shows metadata only; conversations need an audit unlock; no console-usage telemetry; external links use `rel="noopener noreferrer"`; remote README images are blocked.

## 11. Performance budgets (tested)

- **Static import closure of `app.js`**: ≤ 160 KB raw of console code plus ≤ 30 KB raw of vendor code. uPlot and qrcode are loaded dynamically only. The merged catalog is ≤ 120 KB raw per locale.
- **Entry side**: the event ring stays ≤ 4 MiB; with 8 open tabs and no publishers, the bus costs one heartbeat write per client per 15 s; the relay polls `/api/instances` only while someone subscribes.
- **Each route module**: ≤ 60 KB raw of its own static imports.
- **Network with SSE healthy**: ≤ 1 request per 5 s per visible page, excluding streams.
- **Data volume**: chart series ≤ 600 points (the console sends `step`). Tables window above 500 rows. LogViewer keeps ≤ 5000 lines.
- **First render**: `/overview` with mocks completes in < 1.5 s on CI (`performance.mark("console:first-render")`).

## 12. Migration

**Old console**
- `/classic` serves the unchanged `index.html`, plus a banner `新版控制台 → / Try the new console →`.
- `/` flips to the new console in CON-26. `SERVICE_ENTRY_CONSOLE_DEFAULT=classic` reverts it.
- `/classic` is removed in CON-28, after at least 14 days on the new default and parity for every classic pane.

**Manager UIs (5177/5178)**
- A classic script `shared-public/js/legacy-banner.js` in both manager `index.html` shows a dismissible banner: `新的统一控制台已上线：在那里部署、下载和观测模型。[打开] / The unified console is live: deploy, download and observe models there. [Open]`.
- The link is `${location.protocol}//${location.hostname}:${entryPort}/deployments?from=<mgr>&theme=<t>&lang=<l>${hash}`. `entryPort` comes from manager `GET /api/config` (added by 01, 00 §9.17); the banner uses 5176 when the field is absent.
- The manager UIs keep working until the owner decides (§16).

**Billing**: `/billing?manager=vllm` lands on the console route, which passes `manager` to the iframe.

**Preferences**: the same-origin `billingThemeMode` and banner query params are migrated once. Other per-origin keys (`llmManager.themeMode`, `languageMode`, `auditToken`) are unreachable and intentionally dropped.

**Bookmarks**: §3.3. **Docs**: README "Getting started" points at `http://127.0.0.1:5176/`, and mentions `/classic` only as rollback.

## 13. Test plan

### 13.1 Node unit tests

**Entry tests** (CommonJS, `service-entry/test/*.test.js`, already matched by today's `npm test`): `route-mount`, `events`, `request-auth` (§2.7–§2.9, ENT-EV1), `mgmt-proxy` (§2.10, ENT-EV2), `manager-event-relay` (§2.11, ENT-EV3) and `console-routes` (below, CON-2).

**Console tests** (`service-entry/test/console/*.test.js`, ESM through the `test/console/package.json` type marker, discovered by OPS-2's `*/test/**/*.test.js` glob). `test/console/loader.mjs` (`module.registerHooks`, Node ≥ 22.15) maps the console's relative `../vendor/…` and `../shared/…` paths to `shared-public/vendor/` and `shared-public/styles/`, exactly as the snapshot serves them.

| File | Asserts |
|---|---|
| `vendor.test.js` | §2.2 integrity, including no bare specifiers and the `ui/vendor*.js` paths |
| `import-graph.test.js` | Every console module imports in Node through the loader (no missing paths or exports, no top-level DOM); §11 budgets |
| `lint.test.js` | §3.1 rules |
| `i18n.test.js` | Per area: equal key sets in zh-CN and en-US, identical `$prefixes`, sorted keys, every key under its area's prefixes. Across areas: disjoint prefixes and **no key defined twice**. On the merged catalog: equal placeholder sets per key; plurals have `other`; no Han in en-US (allowlist `shell.lang.zh`); every literal `t("…")` exists; every `tk()` matches some area's `dynamic-keys.json`; no unused keys outside the allowlists; zh-CN values non-empty; `mergeI18nAreas` reports a duplicate and an invalid file as `problems` |
| `format.test.js` | `golden/format.json` for both locales: bytes, tokens, durations, relative times, percents |
| `store.test.js` | Dedupe, TTL, prefix invalidation, subscribe and gc; `applyEvent` per type, including `resync`, `security`, `access` and delta `jobs` with `removed` |
| `events-client.test.js` | `createEventStream` with a fake `EventSource`: `?lastEventId=` on self-reopen, polling via `/recent` every 5 s, `gap:true` invalidates all, per-key timers only when `/recent` fails |
| `api.test.js` | Every §3.4 normalization row; timeout; abort; `requestId`; guard failure → `invalid_response`; `x-csrf-token` on every non-GET and never on GET; `csrf_invalid` → one re-read and one retry; 401 → `onUnpaired`; the CSRF and audit tokens never appear in an `ApiError` |
| `guards.test.js` | DSL semantics, `dropInvalid` counting, error paths; `NotificationGuard` rejects cross-origin `href` and non-`/api/` `apiCall` |
| `router.test.js` | `matchRoute`, `buildHref` encoding (`vllm:primary`), every legacy redirect; `#pair=` and `#key=` are never redirected |
| `boot-pair.test.js` | `extractPairCode(location)` and the strip-before-anything order (fake history), and an invalid code → PairingScreen state |
| `expr.test.js` | Every 01 §10.2 operator and limit. **Conformance**: when `manager-core/engines/expr.js` exists, `createRequire` loads it and both evaluators run on the same 01 test cases plus 2,000 seeded random ASTs over `param/user/const` leaves; the results must be identical. `fact`/`env` leaves without a value give UNKNOWN. |
| `schema-form.golden.test.js` | Catalog + plan + values fixtures → `buildFormModel` snapshots for vllm, sglang (Flash-Next recipe locks) and llamacpp, with and without schema `facts`. Once 01 lands, a second case runs over the real `manager-core/data/launch-params/*.json`: every param has `label.zh`/`label.en`, a known group, a widget for its type, and an `appliesWhen` that `validateExpr` accepts. |
| `wizard-state.golden.test.js` | Draft → `planRequest` and `launchRequest` goldens (local and prospective remote). `fromLegacyProfile` over a sanitized fixture of the live profile shape (45 fields, 13 `sglang*`) loses nothing. `diffValues`. |
| `markdown.golden.test.js` | Hostile input (`<script>`, `javascript:`, nested HTML, giant tables) → token trees with no raw HTML node |
| `csv.test.js`, `sse-parse.test.js` | BOM, formula escape, quoting; split frames, `[DONE]`, comments, CRLF |
| `tokens-contrast.test.js` | §4.1 on `shared-public/styles/tokens.css` |
| `fixtures.test.js` | Every `tests/fixtures/console/*.json` passes its guard, so mocks can't drift |

**Server tests** (`service-entry/test/console-routes.test.js`, CommonJS like its siblings):
- **Shell and snapshot**: placeholders are replaced; the CSP is exactly §2.3 and the shell has no inline executable script; `buildId` equals 06 `getBuildId().contentHash` and changes after a file edit without a restart; a hash that moves during the read triggers a rebuild; `build_id_unavailable` keeps the previous snapshot; the previous id is still served and an unknown id returns 410; br/gzip negotiation works; `/c/<id>/i18n/<locale>.json` is the merged catalog, and a duplicate-key area is left out and logged.
- **Routing**: SPA fallback only for the prefix list and only with `Accept: text/html`; `/classic` returns the old bytes; `/billing/classic` is local-only with `frame-ancestors 'self'`; a proxied `/` still returns 404 `public_proxy_gateway_only`; with the classic default the module declines `/` and `/billing` and the inline handlers answer byte-identically.
- **Role and config**: before 05, loopback → owner, LAN → viewer, LAN with `ALLOW_LAN_ADMIN` → owner. With a stub `request-auth` (§2.9), the role and `auth.session` come from it, loopback without a session is viewer, and the bootstrap never contains a cookie value. A bad `console_prefs` cookie is ignored. `SERVICE_ENTRY_CONSOLE_DEFAULT` beats `console.defaultUi`. The console's viewer paths are registered.

### 13.2 Playwright (mocked APIs)

**Harness** (`tests/frontend/helpers/console-harness.js`, CommonJS)
- `startEntry()` spawns `service-entry/server.js` on a free port with `AI_FRONTEND_SMOKE=1` and `SERVICE_ENTRY_CONSOLE_DEFAULT=new`. The spawn and kill helpers move here from `frontend-smoke.spec.cjs`.
- `mockConsoleApi(page, overrides)` routes `/api/**`, `/gateway/**` and `/api/events`. The events route returns a `text/event-stream` body with `id:` lines, or 503 to force polling; `/api/events/recent` is mocked alongside. `/api/session` defaults to `{ok:true, role:"owner", paired:true, csrfToken:"t", pairCommand:"platform admin pair"}` (the same stub 05 PUB-5 adds to the classic specs), and every mocked non-GET asserts `x-csrf-token: t`.
- Fixtures come from `tests/fixtures/console/*.json`, plus 04's `tests/fixtures/telemetry/*.json` (TEL-19, validated by 04's contract test) for the telemetry pages.
- `expectNoA11yViolations(page)` runs axe-core 4.13.0 (root devDependency from OPS-2) via `addScriptTag`.
- `expectNoOverflow(page)`, `collectFailures(page)` (page errors, console errors, CSP violations, 4xx/5xx on documents, scripts and styles), `expectEmptyStorage(page)` and `setPrefs(context, prefs)`.

**Spec conventions**: specs live in `tests/frontend/console/<name>.spec.js` and are discovered by OPS-2's glob; no package edits `package.json` or `test-all.cmd` to register them. Every spec runs light and dark plus 390×844 on its primary route.

| New spec | Covers |
|---|---|
| `console-shell` | Nav and `aria-current`; deep-link reload; legacy hash redirects; `#pair=` stripped and paired; 401 → PairingScreen; `x-csrf-token` on writes; StatusStrip layers from a PlatformStatus fixture and from the pre-06 derivation; theme/locale/density persistence and no-flash server injection; palette; notifications from SSE (title/body `{zh,en}`, an `apiCall` action runs only after confirm); SSE 503 → polling via `/recent` → recovery with `?lastEventId=`; `resync` refetches; 410 update banner; viewer hides writes; English pass (no Han outside `[data-user-content]`). |
| `console-overview` | `[data-window]` on every tile; attention actions; degrade-path labels. |
| `console-deployments` | List; keyed identity and focus kept across refresh (ported fleet test); stop confirmation; detail tabs; instance `metrics` tiles with an `unsupported` key; Wake sends the `slp_` id, and a 409 `wake_would_replace_running` asks and re-sends `{confirmReplace:true}` only on OK; qualification checklist from `jobs` events and Save as recipe after a passing `chat`; Routing with exact `/api/fleet/settings` and `route-preview` bodies and no content fields. |
| `console-wizard` | Happy path for vllm, sglang and llamacpp fixtures: debounced and deduped plan requests (request count asserted), `ok:false` plan rendered as field errors and blockers, provenance chips (incl. `planner`), locked recipe field, inline error → Apply, goal preset → PlanCards → diff → Apply, FitSolver grid and its suggestion fallback, Review overrides, auto pull step shown, `image_pull_required` → confirm → pull POST `{confirm:true}` → progress → re-plan, `<redacted>` command with no key text anywhere in the DOM, diff vs the last launch, replace confirm, `expectedPlanHash` sent and 409 `plan_changed` back to Review, every phase via SSE `jobs`, RootCausePanel from a 00 §9.11 error → suggestion → Review, prospective plan for a remote model, draft survives reload. 02 §21.3 cases: evidence chips show the four confidences; the unknown row is grey with the probe action; plan cards and fit bar render. |
| `console-models` | Library facets; delete type-to-confirm; discover; detail tabs; plan sheet; downloads tabs and failure card; storage register and migrate (parity with `model-storage.spec`); knowledge page lists an invalid file and imports only after confirm; every `models.*` key used renders in zh and en. |
| `console-engines` | Introspect job with confirmation; flags `?against=` diff; a `present:false` runtime → Pull → confirm → `POST …/pull {confirm:true}` → progress; descriptor builder validation (browser, then server errors from a mocked `descriptors/validate`) and copy; external endpoint add, test and delete. |
| `console-playground` | Mocked stream; reasoning; tool preset; stats; route header; curl uses `$API_KEY`; owner requests carry `x-csrf-token` and no `authorization`; a key typed for testing is sent and both storages stay empty. |
| `console-observability` | Each 04 §19 panel's endpoint and query asserted; range-picker URL sync; chart table view; brush → requests filter; request detail; every §19 edge state. |
| `console-audit` | Cookie mode: no token in JS-visible state and both storages empty; degrade mode: the token is only ever a request header; Lock and expiry end the unlock; hostile conversation markdown is inert. |
| `console-alerts` | Ack and silence bodies carry `scopeKey`; builtin rules have no Delete; rule validation errors; channel test. |
| `console-access` | 05 PUB-21/22 criteria: preset create → ShareCard once with QR and invite text, checkbox gate, key gone from the DOM after close; zh/en field help; revoke `confirmName`, bulk `REVOKE n`; key detail usage and requests; public-access wizard from a stubbed report, go-live lists direct callers first, map nodes and edges with evidence; security bans, top IPs and anomalies; legacy findings copy-only; sessions list, revoke and pair-a-device QR; guide placeholders; 390 px and English checks. |
| `console-billing` | Embed of `/billing/classic?embed=1`; theme reload; viewer EmptyState. |
| `console-voice` | Cards from `/api/status`; actions POST with `x-csrf-token` and no key; Unload and Stop ask first; `/gateway/tts/api/jobs` is never requested. |
| `console-system` | 06's former OPS-15 cases against stubbed `/api/platform/*`: status strip states; component restart sends `{when:"idle"}` and shows `component_busy` blockers; Danger zone needs `stop` typed; doctor `manual` fix shows the command and sends no request; settings PUT body with `If-Match`, source badges and `restartRequired`; zh and en with no Han in en; no overflow at 390. Plus the pre-P6 degrade data, `/system/preferences` and `/system/ui-kit`. |
| `console-setup` | Auto-route only for an owner with incomplete `GET /api/platform/setup`; the skip preference; the `?from=setup` back bar; the pre-06 checklist. |
| `console-a11y` | axe on every route plus `/system/ui-kit`, both themes, 1440 and 390; keyboard-only wizard walk-through. |

### 13.3 Existing Playwright specs (paths as OPS-2 leaves them)

| Spec | Action |
|---|---|
| `frontend-smoke` "vLLM and llama pages load" | **Keep** while the manager UIs exist. CON-26 adds legacy-banner assertions (link host-relative). |
| `frontend-smoke` "service-entry dashboard loads" | **Retarget** to `baseUrl + "classic"` in CON-2, unchanged otherwise. **Delete** in CON-28; its fleet assertions live in `console-deployments`. |
| `frontend-smoke` "billing uses the current LAN hostname…" | **Retarget** to `/billing/classic` in CON-2. **Rewrite** into `console-billing` in CON-27. |
| `billing-page.spec` | **Retarget** the base path in CON-2. CON-22 replaces the colour pins (`:557-563`) with contrast assertions. The manager-href pin (`:540-548`) follows the P0 host-relative fix. **Rewrite** in CON-27. |
| `connection-status.spec` | **Keep** for the legacy managers (its shell equivalent is in `console-shell`). **Delete** with the manager UIs. |
| `model-storage.spec` | **Keep** until CON-14 reaches parity and 03 retires `/model-storage`. |
| 02's planned `models-console.spec.cjs`, 05's planned `access-console.spec.cjs` | **Not created.** Their cases live in `console-wizard`, `console-models` and `console-access` above. |
| `scripts/check-i18n.js` | **Keep** for the legacy UIs; the console uses `i18n.test.js`. |

### 13.4 Cross-spec contract tests

Other workstreams' route tests `await import("service-entry/console/lib/schemas.js")` and assert that real responses pass the console guards: 01 `LaunchPlanGuard`, `SchemaCatalogGuard`, `EngineGuard`, `InstanceMetricsGuard`, `JobErrorGuard`; 02 `ModelCardGuard`, `FitResultGuard`, `FitGridGuard`; 03 `DownloadJobGuard`, `LibraryEntryGuard`; 04 `TimeseriesGuard`, `AlertGuard`; 05 `SessionGuard`, `KeyGuard`; 06 `PlatformStatusGuard`. Publishers on the bus (03 HUB-7, 04 TEL-9, 06 OPS-13) assert that `bus.publish` returns non-null for each payload they emit, which runs the §2.8 validation. Console fixtures are refreshed from the outputs those tests record. `expr.test.js` is the second cross-spec check (with 01).

## 14. Phased delivery

| Phase | Packages | Outcome |
|---|---|---|
| W1 (wave 1, P1 timeframe; first in the entry `server.js` lane) | ENT-EV1, ENT-EV2, ENT-EV3 | Route-mount table, event bus with replay, request-auth seam, management proxy and manager relay. 01 ENG-19, 02 MOD-15/17, 03 HUB-7, 04 TEL-9 and 06 OPS-13 build on them. |
| C0 Foundation | CON-1 … CON-7b | Vendor, serving, tokens, libs, components, shell, data components. The console is reachable at its routes; `/` is still classic. |
| C1 First ship | CON-8 Overview, CON-9 Deployments, CON-10 SchemaForm, CON-11/11b/12 wizard, CON-13 Playground, CON-22 Billing embed, CON-23 Voice, CON-26 flip | The daily path (status → deploy → try) lives in the new console. |
| C2 | CON-14/15 Models, CON-29 Knowledge, CON-31 Qualification, CON-16 Engines, CON-24/24b System, CON-25 setup | Downloads, model onboarding, engines and operations in one place; System and setup show full data once P6 lands. |
| C3 | CON-17/18 Observability and Audit, CON-19 Alerts, CON-20/21 Access, public access, security and sessions | Insight and serving. |
| C4 | CON-27 Billing native, CON-28 sweep and retire classic | One shell. |

Every console package can start against fixtures. A backend phase is a dependency only where the package cannot ship without it; the §6 degrade paths let C1 and C2 ship before P3, P4 and P5, and every new field consumed from 01, 02, 05 and 06 (`facts`, `planHash`/409, `steps[]`, `fit-grid`, `descriptors/validate`, `phaseHistory`, `sleep.id`, `console-session`, the audit cookie, `console.defaultUi`, `entryPort`) has a fallback that the Playwright specs exercise with and without the field.

## 15. Contract changes requested

**Resolved by 00 §9 and no longer requested here**: the owner of `events.js`, its types, `id:` lines, replay and `/recent` (§9.6, now ENT-EV); the proxy in wave 1 (§9.6); `csrf_invalid`, `console-session` and the viewer-allowlist registry (§9.8); the job error object (§9.11); the single metrics route (§9.12); `/billing/classic` (§9.13); the pull policy, `planHash`, `expectedPlanHash` and 409 `plan_changed` (§9.2); `console.defaultUi` (§9.5); vendor tree, token file, per-area i18n and build id (§9.16); glob test discovery and axe-core (§9.15); `entryPort`, `lifecycle.phaseHistory` and `sleep.id` (§9.17).

**Still requested**
1. **00 §2 layout (additive)**: `service-entry/lib/{request-auth,manager-event-relay,console-routes}.js`; `service-entry/console/{package.json (module-type marker), lib/, ui/, data/, styles/, assets/, i18n/<area>/}` and route sub-folders; `service-entry/test/console/package.json` (type marker); `shared-public/styles/{tokens.css,contrast-pairs.json}`; `scripts/vendor-browser-libs.mjs`. `VENDOR.json` also lists the generated lucide subset.
2. **00 §4.5 / §9.6 event details (additive)**: the envelope gains `id` (`<bootId>-<seq>`); control type `resync`; `source` adds `platform`. Payloads: `status` `{reason, managerId?, ok?, offline?}` is an invalidation hint, never a full snapshot; `instances` `{managerId, changed, removed, native}`; `jobs` `{managerId, jobs, removed}` as deltas. `notification.severity` is `info|success|warn|error`; `action.apiCall` is `{method, path, body?}` with `path` under `/api/`; `dedupeKey` is optional.
3. **00 §5 proxy**: the forwarded-header allowlist, the always-minted `x-request-id`, and the codes 400 `invalid_path`, 404 `unknown_manager`, 413 `body_too_large`, 502 `manager_unreachable`, 504 `manager_timeout` (§2.10).
4. **05**: `lib/request-auth.js` (§2.9) adapts `createAdminAuth` and `createViewerRegistry` for modules that land before PUB-25/PUB-5; 05 passes them in and replays the built-in registrations. Piped proxy responses bypass the central `sendJson` redaction, so ENT-EV2 applies the matched entry's `redact` itself (05 §5.4 says the proxy "relies on guard"; it relies on `guard` for denial only). `/billing/classic` gets the same owner plus `strictLocalBillingAdmin` gate as `/billing`. 04 reads the audit second factor from `x-audit-session` while 05 §5.6 defines the `lai_elev` cookie; 04 and 05 must pick one (the console supports both, §6.8).
5. **01**: specify the manager `instances` event payload (`{managerId, instances:[Instance]}` preferred; the relay copes with a bare trigger); the schema `facts` keys are `host.*`, `model.*`, `runtime.*` and `instance.mode`.
6. **02**: `GET /api/knowledge?kind=error-signatures&id=<signatureId>` (exact id) so the RootCausePanel need not fetch the full list; R-UI-6 names `title` and `suggestions` on the job error, which 00 §9.11 does not carry, so either 00 adds them as optional or the console keeps the signature lookup (§6.3); the ModelCard's optional `controls.reasoningToggle {on, off}` (05 C8) drives the Playground's reasoning switch; 02 §18's package mapping should read CON-11/11b (wizard), CON-12 (failure card), CON-14 (library, detail), CON-15 (discover, plan sheet), CON-29 (knowledge) and CON-31 (qualify, save as recipe).
7. **06**: inside the bridged `platform` event, the operation's own kind must not reuse `kind` (the wrapper's discriminator); this spec reads it as `opKind`.
8. **00 §9.16**: state that copy tables with bare keys are written under their area name (§3.7), so `source.*` (01 and 06) cannot collide.
9. **00 §4.2 error envelope**: a top-level `requestId`.

## 16. Open decisions for the owner

1. Preact 10.29.8 now. Re-evaluate 11.x after 2026-12-15 with a vendor swap and the full test suite.
2. Flip `/` at CON-26 (end of C1)? Retire `/classic` 14 days after C4?
3. After parity, keep the manager UIs as an emergency fallback when the entry is down (recommended), or make them redirect-only?
4. Should viewers (LAN, or loopback without a session) see redacted Observability? If yes, 04 registers redacted `/api/telemetry/{live,summary,timeseries}` in `viewer-allowlist.js`; otherwise Observability stays owner-only (default).
5. Billing embed first (chosen) versus porting it before C1.
6. Strict English gating (chosen): every PR that adds zh copy must add en.
7. Browser notifications work only on localhost (not over LAN http); 06's Windows toast covers the rest. Is that enough?
8. Should the wizard offer "unlock (unverified)" for recipe locks? This follows 01's decision; the console supports both.
9. Custom Docker engines: is copy-and-place of a descriptor file acceptable, or should 01 add a write endpoint?
10. Sessions page placement: `/access/sessions` (chosen) or under System.
11. Playground "Test with a specific key": keep it (chosen; in-memory only) or drop it once `console-session` lands?

## 17. Work packages

Sizes: S ≤ ½ day, M ≈ 1 day, L ≈ 2 days, each in one engineer-agent session. Every package keeps `test-all.cmd` green. After OPS-2, no package edits the root `package.json` or `test-all.cmd`: unit tests are found by `*/test/**/*.test.js` and Playwright specs by `tests/frontend/**/*.spec.js` (00 §9.15). `console/` means `service-entry/console/`, `test/console/` means `service-entry/test/console/`, and `e2e/` means `tests/frontend/console/`. Every package that adds copy writes only the area files named in its row (§3.7).

**ENT-EV** (00 §9.6) is delivered as ENT-EV1–3 in wave 1, first in the entry `server.js` lane. Another spec's `depends_on: ENT-EV` resolves to ENT-EV1 for the bus (03 HUB-7, 04 TEL-9, 06 OPS-13), ENT-EV2 for the proxy (01 ENG-19, 02 MOD-15 and MOD-17), and ENT-EV3 for relayed `jobs`/`instances` (04 TEL-9's event collector). Those packages then call `ctx.bus.publish` and add one `ROUTE_MODULES` line; they never create `events.js` or a relay.

| Id | Title | Size | Depends on | Files | Acceptance |
|---|---|---|---|---|---|
| ENT-EV1 | Route-mount table, event bus, request-auth seam | L | — (after the P0 merge) | `service-entry/server.js` (`ROUTE_MODULES`, `ctx`, bus and auth creation, close hooks), `service-entry/lib/{events,request-auth}.js`, `service-entry/test/{route-mount,events,request-auth}.test.js` | All §2.7–§2.9 tests pass. `/api/events` writes `id:` lines and replays gap-free after `Last-Event-ID` (header and `?lastEventId=`); an evicted or foreign id starts with `resync`. `/api/events/recent` filters by type and role. A viewer stream carries only `status` and `instances`. `publish` rejects an invalid `notification` (cross-origin `href`, missing `title.en`) and never throws. `request-auth` exposes 05's method names and replays its registrations into a stub 05 registry. Legacy routes are byte-identical with every module mounted; `security`, `gateway`, `entry-extras` and `model-fleet` tests stay green. |
| ENT-EV2 | Management proxy | M | ENT-EV1 | `service-entry/lib/mgmt-proxy.js`, `server.js` (one mount line), `service-entry/test/mgmt-proxy.test.js` | Every §2.10 test passes against a fake manager, including `/api/m/vllm/engines` → `/api/engines`. No header outside the allowlist reaches upstream; every response carries a freshly minted `req_` id; SSE streams chunk by chunk; viewer GETs are redacted; a non-GET without owner never reaches upstream; `relay.poke` follows a 2xx POST when ENT-EV3 is present and is skipped when it is not. |
| ENT-EV3 | Manager event relay (`jobs`, `instances`) | M | ENT-EV1 | `service-entry/lib/manager-event-relay.js`, `server.js` (one mount line), `service-entry/test/manager-event-relay.test.js` | Every §2.11 test passes. With two fake managers, a job state change reaches an `/api/events` client as a `jobs` delta within 1 s; `instances` is synthesised only while someone subscribes and only on change; a native manager `instances` event switches synthesis off; backoff reaches 30 s with one log line per state change; no non-GET request ever reaches a manager. |
| CON-0 | *(retired)* | — | — | — | Scope moved to ENT-EV2 (00 §9.6). |
| CON-1 | Vendor browser libraries | S | OPS-2 | `shared-public/vendor/**`, `VENDOR.json`, `scripts/vendor-browser-libs.mjs`, `scripts/build-lucide-subset.cjs`, `test/console/{package.json,vendor.test.js}`, `release-manifest.json` (vendor and styles globs, if OPS-1 has landed) | All §2.2 checks pass for preact, htm, uplot, qrcode and lucide. The hooks rewrite is applied exactly once and recorded. No vendored file has a bare specifier. Re-running `build-lucide-subset.cjs` produces identical bytes. The release privacy scan passes on the vendor files. |
| CON-2 | Console serving layer, i18n merge, bootstrap | M | CON-1, ENT-EV1, OPS-10 | `service-entry/lib/console-routes.js`, `server.js` (one mount line), `console/{package.json,index.html,app.js}`, `console/i18n/shell/{zh-CN,en-US}.json` (boot keys), `service-entry/test/console-routes.test.js`, `tests/frontend-smoke.spec.cjs` (entry → `/classic`, billing → `/billing/classic`), `tests/billing-page.spec.cjs` (base path), `billing.html` (embed mode), `release-manifest.json` (console glob) | Every §13.1 server assertion passes, including the role from `request-auth`, the URL id equal to `getBuildId().contentHash`, the moved-hash rebuild and a duplicate-key i18n fixture. `/` stays classic by default. The retargeted specs pass otherwise unchanged. `/c/<old>` returns 410. The smoke run reports no CSP violation. |
| CON-3 | Tokens and base CSS | M | CON-2 | `shared-public/styles/{tokens.css,contrast-pairs.json}`, `console/styles/{base,components,charts}.css`, `test/console/tokens-contrast.test.js` | Contrast passes for both themes. `[data-theme=dark]` and OS dark produce the same computed `--bg` (Playwright, no JS). Compact density gives `--row-h` = 32 px. `tokens.css` contains no console selectors, so the portal can link it alone. |
| CON-4 | Core libraries | L | CON-2 | `console/lib/{api,guards,schemas,store,events,router,i18n,format,prefs,storage,url,csv,fuzzy,sse-parse,route-header,legacy-redirects,readiness,audit-session,boot-pair}.js`, `console/ui/{html,hooks,context,vendor,vendor-lazy}.js`, `console/i18n/shell/*` (seed keys), `test/console/{api,guards,store,events-client,router,boot-pair,i18n,format,csv,sse-parse,lint,import-graph}.test.js`, `loader.mjs`, `golden/format.json` | All listed tests pass. The import graph covers every module. Lint is green. Removing one en key, or copying a key into a second area, makes the i18n test fail (gate proven). |
| CON-5 | Primitive components and UI kit | L | CON-3, CON-4, OPS-2 | `console/components/{button,icon,card,page-header,stat-tile,status-badge,tabs,drawer,dialog,confirm-dialog,toast,form-field,help-popover,code-block,empty-state,skeleton,progress-row,stepper,stacked-bar,diff-table,error-boundary,qr-code}.js`, `console/routes/system/ui-kit.js`, `tests/frontend/helpers/{console-harness.js,axe.js,axe-allowlist.json}`, `e2e/console-a11y.spec.js` (ui-kit) | The UI kit has zero serious or critical axe findings in both themes. Tabs keyboard test passes. Type-to-confirm blocks a wrong string and restores focus. The CodeBlock copy fallback works with clipboard permission denied. QrCode loads qrcode lazily. |
| CON-6 | AppShell, StatusStrip, pairing, notifications | L | CON-5, ENT-EV1 | `console/components/{app-shell,sidebar,topbar,status-strip,notification-center,command-palette,connection-banner,pairing-screen}.js`, `console/data/nav.js`, `console/routes.js`, `routes/{not-found,forbidden}.js`, `console/i18n/access/*` (`pair.*` only), `console/i18n/platform/*` (creates the area with the strip keys `platform.layer.*`, `platform.state.*`, `platform.serving.none`, `platform.action.*`), `e2e/console-shell.spec.js`, `tests/fixtures/console/{bootstrap,session,platform-status,status,fleet,events}.json`, `test/console/fixtures.test.js` | Every `console-shell` row in §13.2 passes: SSE 503 → polling via `/recent` → recovery, `resync`, the 410 banner, viewer locks, `#pair=` stripped, 401 → PairingScreen, a notification `apiCall` runs only after confirm, no overflow at 390. The strip shows 06's `platform.serving.none` state with 0 routable instances, both from a PlatformStatus fixture and from the pre-06 derivation. |
| CON-7a | Data components | M | CON-5 | `console/components/{data-table,log-viewer,markdown-viewer}.js`, `console/lib/markdown.js`, `test/console/{markdown.golden,csv}.test.js` | Markdown goldens have no raw HTML node, and `javascript:` links are dropped. DataTable sort, chooser persistence, CSV BOM and escaping, and windowing (> 500 rows keeps ≤ 120 DOM rows) are verified in the ui-kit spec. LogViewer pauses on scroll-up. |
| CON-7b | Chart components | M | CON-5 | `console/components/{time-series-chart,time-range-picker,gpu-memory-bar}.js`, `console/lib/time-range.js`, `console/data/metric-ids.js`, ui-kit entries | uPlot is requested only on chart routes (network log). Gaps render as breaks. Table view exposes the data. The range round-trips through the URL. GpuMemoryBar table totals equal its segments. |
| CON-8 | Overview | M | CON-6, CON-7a, CON-7b | `console/routes/overview.js`, `e2e/console-overview.spec.js`, fixtures | Every tile has `[data-window]`. The readiness banner uses the layer `action`, and restore-models shows its dry-run plan first. The degrade path shows the honest window. axe is clean at 1440 and 390 in both themes. |
| CON-9 | Deployments list, detail, routing | L | CON-8, ENT-EV2 | `console/routes/{deployments,deployment-detail,deployments-routing}.js`, `e2e/console-deployments.spec.js`, fixtures | Ported fleet assertions pass: exact settings and preview bodies, no content fields, keyed row and focus kept across refresh, `aria-pressed`. Stop requires confirmation. Logs poll with `since` and append without duplicates. Relaunch goes through Review. Wake sends `sleep.id` (`slp_…`), and 409 `wake_would_replace_running` re-sends `{confirmReplace:true}` only after OK. Metrics tiles read `metrics` and render `unsupported[]` as such. Phase durations come from `phaseHistory` when present. |
| CON-10 | SchemaForm and expression port | L | CON-5, P1 (01 ENG-3; ENG-2 `facts` optional) | `console/lib/{schema-form-model,expr}.js`, `console/components/schema-form.js`, `console/i18n/engines/*` (form chrome only), `test/console/{schema-form.golden,expr}.test.js`, `tests/fixtures/console/{schema,plan}-{vllm,sglang,llamacpp}.json` | Goldens match with and without schema `facts`. The expr conformance test is identical to 01's evaluator. Locked fields are disabled with their reason. Not-applicable fields are counted and hidden. `tristate`, `kv` and secret params render. The `planner` provenance chip renders. A suggestion applies only on click. Every param in 01's real catalogs renders. |
| CON-11 | Wizard steps 1–2 (model, engine) | L | CON-9, CON-10, P2 (02 MOD-15) | `console/lib/wizard-state.js`, `console/routes/deploy-wizard/{index,step-model,step-engine}.js`, `console/components/{model-card,evidence-chip,compat-matrix}.js`, `console/i18n/models/*` (`models.role.*`, `models.confidence.*`, `models.verdict.*`, `models.remoteCode.*`), `test/console/wizard-state.golden.test.js`, `e2e/console-wizard.spec.js` (part 1) | `planRequest` and `launchRequest` match 01 LaunchRequestV2 goldens, including the prospective remote case. Plan requests are debounced and deduped (request count asserted). An `ok:false` plan renders field errors and blockers. 02 R-UI-1, R-UI-2 and R-UI-9: evidence chips show the four confidences or unknown; an unknown row is grey with probe and override actions and the must-keep `models.compat.unknownArch` label; `ok` never shows without `supportEvidence`; remote-code consent lists the `auto_map` files; every `models.*` key used exists in zh and en; no raw flag name is a primary label. The draft survives reload, and sessionStorage never holds a `secret` or `extraEnv` value. `fromLegacyProfile` is lossless. |
| CON-11b | Wizard step 3 (resources, plans, fit) | L | CON-11, P2 (02 MOD-14, MOD-15; MOD-9b `fit-grid` optional) | `console/routes/deploy-wizard/step-resources.js`, `console/components/{fit-bar,plan-cards,fit-solver}.js`, `console/i18n/models/*` (`models.goal.*`, `models.fit.*`), `e2e/console-wizard.spec.js` (part 2) | Goal chips call `launch/recommend` and show PlanCards; a pick shows a diff first and Apply sets `planner` provenance. The FitBar under `contextLength` follows the plan. FitSolver renders a mocked `fit-grid` and falls back to suggestion chips on 404. Every `memory.policy` value, including `static-fraction-of-free` and `weights-plus-kv`, has a label. 02 R-UI-3/R-UI-4: the fit bar stacks the six segments plus a RAM bar on `spill`; plan cards show `validated` and trade-offs and hand catalog ids over unchanged; both render in zh and en. |
| CON-12 | Wizard steps 4–7 and quick paths | L | CON-11b, P1 (01 ENG-7; ENG-2 `planHash`/409 and ENG-11 pull optional) | `console/routes/deploy-wizard/{step-capabilities,step-access,step-review,step-launch}.js`, `console/components/{command-preview,root-cause-panel}.js`, `console/i18n/engines/*` (01 §23 copy), `e2e/console-wizard.spec.js` (part 3) | Review shows overrides with reasons, blockers, the image step, the redacted command and the diff vs the last launch. Launch is blocked on errors, blockers or a `block` verdict. `image_pull_required` → confirm → `POST …/pull {confirm:true}` → progress → re-plan. Launch sends `expectedPlanHash`; a 409 `plan_changed` returns to Review with a diff; without ENG-2 the non-blocking notice appears. Replace mode asks first. All phases run from SSE `jobs` with `stageKey` labels. The RootCausePanel (02 R-UI-6) renders a 00 §9.11 error for launch, probe and qualification failures, uses `title`/`suggestions` from the error or its looked-up signature, and applies a suggestion by returning to Review without relaunching. Start-last-used reaches Review in one click. |
| CON-13 | Playground | M | CON-6 (05 PUB-8 for `console-session`) | `console/routes/playground.js`, `e2e/console-playground.spec.js` | Streaming, reasoning, tool preset, per-message stats and route header work. Owner requests carry `x-csrf-token` and no `authorization`. A test key is sent only when typed, never stored (both storages empty) and cleared on navigation. curl output shows `$API_KEY` only. A 401 shows the key field; a 403 `csrf_invalid` retries once; `reasoningToggle` is merged only when the card has it. |
| CON-14 | Models library, storage and detail | L | CON-7a, CON-11, P3 (03 HUB-15 area) | `console/routes/models/{library,storage,model-detail}.js`, `console/i18n/hub/*` (additions only), `e2e/console-models.spec.js` (part 1) | Per-root capacity bars from `storage/usage`. Delete is type-to-confirm with bytes freed. Storage flows match `model-storage.spec`. Model detail shows ModelCardView with evidence and the CompatMatrix tab (02 R-UI-1, R-UI-2). The degrade path works with only the legacy `/api/m/*/models` mocked. |
| CON-15 | Discover, plan sheet, downloads | L | CON-14 | `console/routes/models/{discover,download-plan,downloads}.js`, `console/i18n/hub/*` (additions only), `e2e/console-models.spec.js` (part 2) | Cursor load-more. Plan blockers show fixes. Keyboard reorder sends `downloads/reorder`. Classified failure card. Cancel-and-delete sends `{deletePartial, confirm}` and shows reclaimable bytes. SSE `downloads` updates progress without a refetch, and a `truncated` replay refetches. |
| CON-16 | Engines | L | CON-10, ENT-EV2, P1 (01 ENG-19; ENG-2 validate and ENG-11 pull optional) | `console/routes/engines/{index,engine-detail,engine-new,external}.js`, `console/i18n/engines/*`, `e2e/console-engines.spec.js` | Introspect asks first and follows its job. The flags diff shows added, removed and changed rows. A `present:false` runtime pulls only after confirm, with `{confirm:true}`, and shows progress. The descriptor builder validates in the browser, then shows server errors from `descriptors/validate` (browser-only on 404), and copies. The external key is never echoed. |
| CON-17 | Observability charts | L | CON-7b, P4 (04 TEL-19 area and fixtures) | `console/routes/observability/{overview,performance,traffic,errors,gpu,models,settings}.js`, `console/i18n/telemetry/*` (additions only), `e2e/console-observability.spec.js` (part 1) | Every 04 §19 panel calls its listed endpoint and parameters. URL state round-trips. Every metric id has zh and en labels. Every number shows a window. Annotations render. Every §19 edge state has copy. |
| CON-18 | Requests explorer and Audit | L | CON-17 | `console/routes/observability/{requests,request-detail}.js`, `console/routes/audit/{timeline,conversations,exports,access-log,settings}.js`, `console/i18n/telemetry/*` (additions only), `e2e/console-{observability,audit}.spec.js` | Brushing filters requests. The detail waterfall renders. In cookie mode no audit token is visible to JS; in the degrade mode the token is only a header. Both storages stay empty. Hostile markdown is inert. The chain view shows baseline and incrementals. |
| CON-19 | Alerts | M | CON-17 | `console/routes/alerts.js`, `console/i18n/telemetry/*` (additions only), `e2e/console-alerts.spec.js` | Ack and silence send `scopeKey`. Builtin rules offer Disable, not Delete. Rule validation errors show inline. `alerts` events refresh the list and notifications appear. The channel test reports its result. |
| CON-20 | Keys, customers, clients | L | CON-7a, P5 (05 PUB-18) | `console/routes/access/{index,keys,key-detail,clients}.js`, `console/components/{share-card,key-form}.js`, `console/data/client-guides.js`, `console/i18n/access/*`, `e2e/console-access.spec.js` (part 1) | 05 §13.7 CON-20 criteria: a preset create shows the ShareCard once with QR and invite text, and closing it leaves the secret unrecoverable in the DOM; field help in zh and en; revoke needs `confirmName` and bulk revoke `REVOKE n`; key detail shows usage and requests; no Han in English; no overflow at 390. 05 §13.7 "Both": every non-GET carries `x-csrf-token`, a 403 `csrf_invalid` re-reads `/api/session` once, and a viewer sees the PairingScreen. The legacy degrade path works. |
| CON-21 | Public access, security, portal, sessions | L | CON-20, P5 (05 PUB-5, PUB-19, PUB-20) | `console/routes/access/{public,security,portal,sessions}.js`, `console/components/{exposure-map,checks-list}.js`, `console/i18n/access/*`, `e2e/console-access.spec.js` (part 2) | 05 §13.7 CON-21 criteria: the wizard walks topology → base URL → templates → keys → checks → map → go-live from a stubbed report, writes templates only on click with `overwrite:false`, and lists direct callers before enforcing; the map renders nodes and edges with evidence; the security view shows bans, top IPs and anomalies, and ban actions confirm first; legacy findings offer copy only. Pair-a-device shows the code and QR and forgets them on close. Revoking the current session warns first. |
| CON-22 | Billing embed | S | CON-6 | `console/routes/billing.js`, `billing.html` (embed polish), `e2e/console-billing.spec.js`, `tests/billing-page.spec.cjs` (colour pins → contrast) | The iframe is owner and local only. A theme change reloads it with `?theme=`. Others see the EmptyState. `billing-page.spec` stays green. |
| CON-23 | Voice | S | CON-6 | `console/routes/voice.js`, `e2e/console-voice.spec.js` | Cards come from `/api/status`. Actions POST with `x-csrf-token` and no key; Unload and Stop ask first. Before `console-session`, a 401 shows the pairing-or-key hint. The network log never shows `/gateway/tts/api/jobs`. |
| CON-24 | System: components, Danger zone, preferences | L | CON-6, CON-7a (P6 OPS-13 for full data) | `console/routes/system/{index,preferences}.js`, `console/i18n/platform/*` (06 §11 keys under `platform.`), `e2e/console-system.spec.js` (part 1) | 06 §11 criteria for `/system`: supervisor banner and start; the component table with every 06 state label; Restart sends `{when:"idle"}` and a 409 `component_busy` lists its blockers; Logs open the component LogViewer; the Danger zone needs `stop` typed and shows `platform.stopAll.confirm`; viewers see the redacted table with no actions. The pre-P6 degrade data renders from `/api/status`. Preferences persist and apply without reload. zh and en with no Han in en; no overflow at 390. |
| CON-24b | System: doctor, settings, updates, ops | L | CON-24, CON-10 (P6 OPS-9b, OPS-13 for full data) | `console/routes/system/{doctor,settings,updates,ops}.js`, `console/i18n/platform/*`, `e2e/console-system.spec.js` (part 2) | 06 §11 criteria: doctor `confirm` fixes ask first and follow the operation; a `manual` fix shows the command with Copy and Docs and sends no request; settings render source badges and `restartRequired`, PUT carries `If-Match` and only changed leaves, secrets go in `secrets` and are never echoed, `config_conflict` shows a diff; Apply defaults to `when:"idle"`; updates show `commit`, `contentHash`, newer commits, drift and pending restarts; ops shows 30 nightly bars and the autostart command to copy, and registers nothing. Pre-P6 pages show the P6 EmptyState. |
| CON-25 | First-run setup | M | CON-12, CON-15, CON-24 (P6 OPS-14 for full data) | `console/app.js` (boot step 8), `console/routes/setup.js`, `console/components/setup-return-bar.js`, `console/i18n/platform/*` (`platform.setup.*`), `e2e/console-setup.spec.js` | Auto-routes only an owner with incomplete `GET /api/platform/setup`. The ten 06 §8 steps render with status and one primary action; a step POST shows operation progress from `platform` events (`opKind`) or polling; the `ops` step only shows commands. Skip persists. `?from=setup` shows the back bar on every linked page. The pre-06 checklist works with P6 absent. |
| CON-26 | Flip default and legacy banners | M | CON-8, CON-9, CON-12, CON-13, CON-22, CON-23 | `console-routes.js` (default `new`), `service-entry/index.html` (classic banner), `shared-public/js/legacy-banner.js`, `{vllm,llama}-manager/public/index.html` (script tag), `tests/frontend-smoke.spec.cjs`, README | `/` serves the new console. `SERVICE_ENTRY_CONSOLE_DEFAULT=classic` and `console.defaultUi` (OPS-3) revert it. Banner links are host-relative, carry theme and lang, and use `entryPort` from manager `/api/config` (5176 when absent). Legacy hashes land correctly. Full `test-all.cmd` is green. |
| CON-27 | Billing native port | L | CON-22, CON-7a, P4 | `console/routes/billing/*.js`, `console/i18n/shell/*` (`billing.*`), `e2e/console-billing.spec.js` (rewrite), `tests/billing-page.spec.cjs` (reduced to `/billing/classic`) | All five-tab, hostile-text XSS and immutable-debit assertions from `billing-page.spec` are ported and pass. Usage shows `usage/summary` aggregates. |
| CON-28 | Sweep and retire classic | M | CON-14, CON-15, CON-16, CON-17, CON-18, CON-19, CON-20, CON-21, CON-24, CON-24b, CON-25, CON-27, CON-29, CON-31 | `e2e/console-a11y.spec.js` (all routes), `import-graph.test.js` (final budgets), `console-routes.js` (`/classic` → redirect after the owner's go-ahead), `tests/frontend-smoke.spec.cjs` (remove entry smoke) | axe is clean on every route, both themes, 1440 and 390. No overflow at 390. §11 budgets hold. `/classic` redirects to `/overview`. Final `test-all.cmd` pass/fail counts are reported. |
| CON-29 | Knowledge page | M | CON-14, P2 (02 MOD-5, MOD-15) | `console/routes/models/knowledge.js`, `console/i18n/models/*` (`models.knowledge.*`), `e2e/console-models.spec.js` (part 3) | 02 R-UI-8: the status panel lists layers, files, an invalid file with `models.knowledge.status.invalid` and a stale file; entries show their layer; import previews the diff and writes only after a second confirmation with `sha256`; pack delete sends `x-confirm: delete` after a ConfirmDialog; a per-model override PUT renders 422 field errors inline. |
| CON-31 | Qualification and save as recipe | M | CON-9, CON-12, P2 (02 MOD-16, MOD-17) | `console/components/qualify-checklist.js`, `console/routes/deployment-detail.js` (qualification block), `console/routes/deploy-wizard/step-launch.js` (success action), `console/i18n/models/*` (`models.qualify.*`, `models.recipe.*`), `e2e/console-deployments.spec.js` (qualification part) | 02 steps ⑦–⑧, R-UI-5 and R-UI-7: the checklist follows the relayed `jobs` events of kind `model-qualify` with each check's status and detail; Save as recipe is enabled only after a passing `chat` check, and `recipe_reload_failed` shows as a warning; 409 `recipe_exists` offers overwrite behind a ConfirmDialog; 422 field errors render inline; the saved recipe id links to the engine's Recipes tab. Without MOD-16, the block is hidden (404 → `endpoint_unavailable`). |
