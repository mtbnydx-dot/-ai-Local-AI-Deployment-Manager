# 05 — Public service: listeners, admin sessions, platform keys, public API, portal

Phase P5 (`-public`) for everything served by service-entry. The three admin console pages (§13.4–13.6) are requirements handed to 07, which builds them in CON-20/CON-21 under `service-entry/console/routes/access/*`. Binding inputs: `00-decisions-and-contracts.md` (D1, D2, D7, D8, D9, D10 and §3–§7). Diagnosis inputs: slices `public`, `competitor-research`, `stats`.

Ownership after the 2026-10-14 cross-check:
- 06 OPS-3 owns the `platform.json` schema, the env-to-key map and the only writer. 05 contributes schema leaves and calls `readSection`/`writeSection` (§3.4).
- 07 owns every path under `service-entry/console/`, the vendor tree `shared-public/vendor/<pkg>/<version>/` and `shared-public/styles/tokens.css`. 06 `getBuildId()` is the only build id.
- 05 owns the single entry→manager hop (v2, §7), `manager-core/internal-auth.js` and machine principals (§5.7), admin sessions, CSRF, the session and elevation cookies, the `console-session` principal (§5.8) and the viewer-access registry (§5.4).

Placeholders used throughout: `<AI_ROOT>` is the platform root; `api.example.com` stands for the owner's public host. No real host, user or address appears in tracked files (00 §7.8).

## 0. Goals and non-goals

Goals:
1. Make the internet path structural instead of heuristic. The PUBLIC listener has no admin routes, the ADMIN listener never honours forwarded headers, and admin needs a session even on loopback.
2. Provide one platform key store with scopes, quotas and expiry, and one base URL plus one key for every model on every engine. Migrate today's keys without reissuing them.
3. Ship a public portal: status page, model catalog, docs with copy-paste snippets, a My Key dashboard, a playground and announcements.
4. Give the owner a guided way to expose the platform (cloudflared recommended) and a factual report of what is actually reachable. This includes detecting, but never deleting, the legacy exposure tooling in the live root.

Non-goals: self-service sign-up, payment collection, magic-link accounts (open decision O6), OpenWebUI changes beyond its compose template, merging manager processes (D3).

## 1. Verified current state (deltas against the diagnosis)

I re-read the code; the diagnosis holds. These details matter for the design:

| # | Fact | Evidence |
|---|---|---|
| V1 | One listener mixes console, `/api/*`, `/internal/billing/*`, `/billing`, `/docs/*` and `/gateway/*`. The only separation is the "proxied ⇒ only /gateway" rule. | `service-entry/server.js:186-197` |
| V2 | A request counts as proxied when any of four headers is present. The client address is the **last** XFF entry from **any** socket, and that value is HMAC-vouched to managers. | `service-entry/lib/security.js:132-153, 328-333` |
| V3 | The Origin check compares **hostnames only**. A page at `http://127.0.0.1:5186` would pass the same-site check for `POST http://127.0.0.1:5176/...`, and cookies ignore ports. The session design must use exact origins. | `security.js:103-119`, `manager-core/network.js:57-65` |
| V4 | The entry forwards the client's `authorization`/`x-api-key` to managers, and the managers authenticate again from their own JSON files. | `server.js:2021-2051`; `manager-core/gateway-utils.js:1759-1771` |
| V5 | Billing binds credentials by (billing manager id, client id). Billing manager ids are `vllm-manager`/`llama-manager` (env-overridable), not `vllm`/`llama`. TTS owners are `${managerId}:${clientId}` with `vllm`/`llama`. Global keys bill as `global-<hash24>` and have an empty TTS owner. | `billing-store.js:584`, `vllm-manager/server.js:165`, `server.js:851`, `service-policy.js:63-66` |
| V6 | `/gateway/status` consumes from bucket `client.id` while traffic uses `${manager}:${client.id}`. | `server.js:1289` vs `:1078` |
| V7 | Client ids are name-derived (`normalizeServiceClientIdBase`), so the same id can exist in both managers. | `service-policy.js:68-87` |
| V8 | Manager CRUD routes take injected deps, so they can be re-pointed without touching route code. | `manager-core/service-policy-routes.js:1-45` |
| V9 | The manager forwards the forced `include_usage` SSE chunk to the caller, so the entry can tap usage from the stream. | `gateway-utils.js:913-965` |
| V10 | Entry CORS sends `allow-credentials: true` for listed origins; manager "open" CORS reflects any origin with credentials and Private-Network allow. | `security.js:180-200`, `gateway-utils.js:1476-1508` |

## 2. Threat model

Assets: GPU capacity, platform keys, admin control (start/stop/delete/keys/billing), conversation content (audit exports), the billing ledger, and the owner's LAN.

| Actor | Can reach | Main threats | Mitigations (section) |
|---|---|---|---|
| Anonymous internet client | PUBLIC through the tunnel | Key guessing, scraping, DoS, learning internals | Per-IP pre-auth limiter, persistent bans (§9); coarse status (§12.2); stable errors with no internals (§10); no admin routes on PUBLIC (§3) |
| Key holder (friend or customer) | PUBLIC `/v1/*`, `/v1/me` | Exceeding fair use, reaching non-granted surfaces, seeing other tenants | Scopes, model allowlist, `fleetAllow`, rpm/tpm/concurrency, daily/monthly caps, max output (§6, §9); MCP and TTS cloning structurally absent on PUBLIC; tenant-scoped TTS owner |
| Malicious website in the owner's browser | ADMIN through the browser (same-site cross-port included) | CSRF, DNS rebinding, reading admin data | Host allowlist; exact-origin check including port; SameSite=Strict HttpOnly cookie plus CSRF header; no CORS on ADMIN (§5) |
| LAN device | ADMIN only if `listeners.admin.lan`; PUBLIC only if `listeners.public.host` is a wildcard | Spoofed XFF, admin takeover, key sniffing over HTTP | Forwarded headers honoured only from trusted CIDRs (§4); LAN owner requires `admin.allowLanOwner` plus pairing (§5); docs warn that LAN is plain HTTP |
| Misconfigured forwarder (netsh portproxy, `ssh -R`, legacy `public-port-proxy.js`, cloudflared pointed at 5176) | ADMIN, looking like loopback | Internet traffic treated as local and therefore admin | Admin needs a session even on loopback; forwarded headers on ADMIN ⇒ admin routes rejected; the exposure scan flags forwarders (§13.2); auto-pair is disabled when the scan is red |
| Local process, other Windows user, or container via `host.docker.internal` (Docker Desktop delivers it as 127.0.0.1, verified in the diagnosis) | Both listeners as 127.0.0.1 | Reading status, driving admin, forging internal callers | Loopback viewer gets only registered, redacted GETs (§5.4). Writes need a session, a tool token or a machine-principal HMAC (§5.7) keyed by the ACL-restricted trust token. A bare header (for example `x-hub-shim`) never authenticates |
| Same Windows user (malware) | Everything | — | Out of scope: it can read browser cookies and the trust token file. Documented. |

Residual risks (documented in the portal privacy page and the admin security view): a key holder sees model names and aggregate load; Cloudflare terminates TLS and sees traffic; LAN admin over HTTP is sniffable.

## 3. Listener architecture

### 3.1 Listeners

| Listener | Default bind | Purpose | Forwarded headers | Cookies | Routes |
|---|---|---|---|---|---|
| ADMIN | `127.0.0.1:5176` | Console, `/api/*`, `/billing`, `/docs/*`, `/internal/*`, local and LAN `/gateway/*` | **Never honoured.** Their presence rejects non-`/gateway` routes (§3.3) | Admin session cookie | Today's routes plus §5 and §13 |
| ADMIN-LAN | `0.0.0.0:5176` when `listeners.admin.lan=true` or `SERVICE_ENTRY_HOST` is a wildcard (replaces `start-service-entry.cmd lan`) | Same server bound wider | Never honoured | Yes; a LAN session is owner only with `admin.allowLanOwner` | Same |
| PUBLIC | `127.0.0.1:5186` | Portal plus public API; the only target for cloudflared/Caddy | Honoured only from `trustedProxies.cidrs` (§4) | **Ignored and never set**; the `cookie` header is deleted on receipt, so neither sessions nor `console-session` exist here | §3.2 table only |
| PUBLIC-LAN | `0.0.0.0:5186` when `listeners.public.host` is `0.0.0.0` | LAN clients use `http://<lan-ip>:5186/v1` with keys | LAN sockets are untrusted, so headers are ignored | Ignored | Same |

There is one process with two `http.Server` objects. `service-entry/lib/listeners.js` exports `startListeners({ config, adminHandler, publicHandler }) -> Promise<{ admin, public, close() }>`. Each server wraps its handler as `(req,res) => handler(tagListener(req, kind), res)`, with `req.listener = { kind: "admin"|"public", lanBound: boolean }`. Trust decisions read `req.listener`, never headers. Each listener reports `EADDRINUSE` separately. If PUBLIC fails to bind, the entry keeps running ADMIN, logs `public_listener_unavailable` and the console shows it red; it does not crash.

`server.js` keeps `createServiceEntryServer()` for tests (an ADMIN handler) and adds `createPublicServer(deps)`. `startServiceEntry()` calls `startListeners`.

### 3.2 PUBLIC route table (exhaustive; `service-entry/lib/public-listener.js`)

| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/`, `/status`, `/models`, `/models/:id`, `/docs`, `/docs/:slug`, `/me`, `/playground`, `/announcements` | none | Portal shell (`portal/index.html`, build id and import map injected, §12.1) |
| GET | `/assets/<buildId>/…` | none | Snapshot of `service-entry/portal/**`, the `VENDOR.json`-listed files of 07's `shared-public/vendor/<pkg>/<version>/` (preact, htm, uplot, qrcode), and `shared-public/styles/tokens.css`. `<buildId>` is 06 `getBuildId().contentHash` |
| GET | `/portal-config.json`, `/status.json`, `/catalog.json`, `/announcements.json` | none | §12 |
| GET | `/healthz` | none | `200 text/plain ok`, not rate-limited (origin health for the tunnel) |
| GET | `/gateway/health` | none | Unchanged JSON |
| GET | `/robots.txt` | none | Disallows `/v1/`, `/anthropic/`, `/me`, `/playground` |
| * | `/v1/*`, `/anthropic/v1/*`, `/vllm/v1/*`, `/llama/v1/*`, `/gateway/{auto,vllm,llama,<engineId>,external/<id>}/{openai,claude,opencode}/*`, `/gateway/status`, `/gateway/me`, `/gateway/tts/openai/v1/audio/speech` | key | §8 |
| * | anything else | — | 404, content-negotiated (§10.3) |

The table structurally excludes `/api/*`, `/internal/*`, `/billing*`, `/classic*`, the admin `/docs/*.md`, `/gateway/tts/` UI and `/gateway/tts/api/*`, `/gateway/mcp*` and `/gateway/search/*`. Search can be enabled with `public.exposeSearch` plus scope `search`. A test enumerates the admin routes and asserts each one returns 404 on PUBLIC (§17).

### 3.3 Host and Origin rules

- ADMIN Host allowlist: `127.0.0.1`, `localhost`, `::1`, the LAN address when ADMIN is LAN-bound, and `admin.extraHosts[]`. **The public host is no longer admitted on ADMIN.** Today `security.js:93-94` admits it; that is removed, so a tunnel pointed at 5176 gets 403 `host_not_allowed`.
- ADMIN Origin check for non-GET requests: an exact match on `scheme://host:port` against the set `{http://127.0.0.1:5176, http://localhost:5176, http://[::1]:5176, http://<lan>:5176}`. This fixes V3.
- ADMIN with any header in `FORWARDING_HEADERS` (§4) on a non-`/gateway/*` path returns 404 `{code:"public_proxy_gateway_only"}`, as today, which keeps `gateway.test.js:252` green, and emits security event `admin_via_proxy`. On `/gateway/*` the outcome depends on `admin.legacyProxyGateway`:
  - `"serve"` (schema default): the request is served, but the client IP is the socket address, a key is required, and an event is emitted.
  - `"reject"`: 421 `use_public_listener`. The wizard's go-live step (§13.5) sets it together with `enforce`.
- PUBLIC Host allowlist: the host of `listeners.public.baseUrl`, `127.0.0.1`, `localhost`, `host.docker.internal` (OpenWebUI in Docker), the LAN address when LAN-bound, and `public.extraHosts[]`. Anything else returns 421. PUBLIC has no ambient credentials, so no Origin check is needed beyond CORS (§11).

### 3.4 Configuration (schema, env map and writer: 06 OPS-3; adapter: `service-entry/lib/public-config.js`)

05 has no config-file code. PUB-1 adds the leaves below to OPS-3's `manager-core/data/platform-config.schema.json`, each with bilingual `title`/`description`, `env`, `restartRequired` and `group: "access"`. Precedence (env > file > default), file I/O, etags and atomic writes are OPS-3's. 05 reads through `readSection(name)` and writes through `writeSection(name, patch, { etag })`, both exported by `manager-core/platform/config.js`. `platform.json` stores only non-default values; the defaults are:

```json
{
  "listeners": {
    "admin":  { "host": "127.0.0.1", "port": 5176, "lan": false },
    "public": { "enabled": true, "host": "127.0.0.1", "port": 5186, "baseUrl": "" }
  },
  "admin": { "firstRunAutoPair": true, "firstRunWindowMinutes": 30, "sessionDays": 180, "loopbackViewer": true,
             "lanAnonymousViewer": true, "allowLanOwner": false, "legacyProxyGateway": "serve", "gatewayRpm": 600, "extraHosts": [] },
  "trustedProxies": { "cidrs": ["127.0.0.1/32", "::1/128"], "clientIpHeader": "cf-connecting-ip", "countryHeader": "cf-ipcountry" },
  "exposure": { "requireApiKey": "auto", "allowedOrigins": [] },
  "public": {
    "extraHosts": [], "brand": { "zh-CN": "本地模型服务", "en-US": "Local Model Service" },
    "catalog": { "publish": ["*"], "showPrices": true, "allowColdStart": false },
    "defaults": { "rpm": 60, "tpm": 200000, "maxConcurrent": 2, "maxQueued": 4, "queueTimeoutSeconds": 30, "maxOutputTokens": 8192 },
    "share": { "maxConcurrent": 4, "maxQueued": 16, "queueTimeoutSeconds": 30, "ownerActiveMaxConcurrent": 2 },
    "preAuth": { "rpm": 120, "burst": 30 },
    "authFailure": { "limit": 20, "windowSeconds": 60, "banSeconds": 600, "maxBanSeconds": 86400 },
    "maxBodyBytes": 16777216, "exposeSearch": false, "exposeTts": true, "quotaTzOffsetMinutes": null, "managersGatewayOnly": "warn"
  }
}
```

- `exposure.requireApiKey` and `exposure.allowedOrigins` are 06 leaves that 05 consumes. 06's `entry.port/host`, `exposure.lan`, `exposure.allowLanAdmin` and `exposure.public.*` are deleted in favour of these keys.
- `listeners.admin.host` carries the OPS-3 `derives` rule `lan ? "0.0.0.0" : "127.0.0.1"` when neither env nor file sets it. ADMIN is LAN-bound when `lan` is true **or** `host` is a wildcard. PUBLIC is LAN-bound when `listeners.public.host` is a wildcard.
- `listeners.public.baseUrl` must be `https-url` or empty. Empty means LAN-only (portal URLs are derived from the allowed `Host`). Cross-field rule (OPS-3 validator): `exposure.requireApiKey = "off"` with a LAN-bound ADMIN is `insecure_combination`.
- `restartRequired`: `["entry"]` for `listeners.*` and `trustedProxies.*`; `false` (applied live) for everything else, because the adapter re-reads when the etag changes. `public.managersGatewayOnly` also reaches the managers, which re-read it at most every 10 s (PUB-23).
- `quotaTzOffsetMinutes: null` means "use the billing store's tz offset".

Env names (each maps to exactly one key, as OPS-3's schema test requires):

| Env | Key | Note |
|---|---|---|
| `SERVICE_ENTRY_HOST` | `listeners.admin.host` | A wildcard makes ADMIN LAN-bound |
| `SERVICE_ENTRY_PORT` | `listeners.admin.port` | |
| `SERVICE_ENTRY_PUBLIC_LISTENER` (`0`/`1`) | `listeners.public.enabled` | new |
| `SERVICE_ENTRY_PUBLIC_HOST`, `SERVICE_ENTRY_PUBLIC_PORT` | `listeners.public.host`, `.port` | new |
| `SERVICE_ENTRY_PUBLIC_BASE_URL` | `listeners.public.baseUrl` | |
| `SERVICE_ENTRY_ALLOW_LAN_ADMIN=1` | `admin.allowLanOwner` | LAN owner now also needs pairing (behaviour change, O9) |
| `SERVICE_ENTRY_RATE_LIMIT_RPM` | `admin.gatewayRpm` | rpm for keyless ADMIN `/gateway` callers; keeps `gateway.test.js:632` |
| `SERVICE_ENTRY_TRUSTED_PROXIES` | `trustedProxies.cidrs` | comma-separated (new) |
| `SERVICE_ENTRY_CLIENT_IP_HEADER` | `trustedProxies.clientIpHeader` | new |
| `SERVICE_ENTRY_ALLOWED_HOSTS` | `public.extraHosts` | Today it widened the single listener for the public host |
| `SERVICE_ENTRY_AUTH_FAIL_LIMIT`, `_AUTH_FAIL_WINDOW_SECONDS`, `_AUTH_BAN_SECONDS` | `public.authFailure.limit`, `.windowSeconds`, `.banSeconds` | |
| `SERVICE_ENTRY_ALLOWED_ORIGINS` | `exposure.allowedOrigins` (06 leaf) | CORS for keyless ADMIN `/gateway` only, without credentials |
| `SERVICE_ENTRY_REQUIRE_API_KEY` | `exposure.requireApiKey` (06 leaf) | ADMIN `/gateway` only. `auto` means a key is required for LAN sockets and optional on loopback. PUBLIC **always** requires a key on model routes |
| `MANAGER_GATEWAY_ONLY` | `public.managersGatewayOnly` | `off`, `warn` or `enforce` (§7.2) |

Adapter exports (`public-config.js`):
- `loadAccessConfig({ readSection }) -> AccessConfig`. It reads `listeners`, `admin`, `trustedProxies`, `exposure` and `public`, parses CIDRs, and derives `adminLanBound`, `publicLanBound` and `publicOrigin`. The result is frozen. Invalid values fall back to defaults and are reported through `issues[]` at `GET /api/public/settings` and `GET /api/knowledge/status` (00 §2).
- `createAccessConfigSource({ readSection, ttlMs = 2000 }) -> { get(): AccessConfig, refresh() }`. Live values are re-read when the OPS-3 etag changes.
- `updateAccessSection(section, patch, { etag, actor, actorIp, writeSection, store }) -> Promise<{ config, etag, restartRequired }>`. `section ∈ {listeners, admin, trustedProxies, public}`. It validates the 05 semantics (CIDRs, https base URL, enums), calls `writeSection(section, patch, { etag })` (409 `config_conflict` passes through), appends an `access_audit` row with the changed key names only, and emits `access.settings_changed`. It never touches the file system.
- `ACCESS_SCHEMA_LEAVES`, the schema fragment PUB-1 merges into OPS-3's schema file. A test asserts the two stay equal.

## 4. Trusted proxies and client identity (`service-entry/lib/trusted-proxy.js`)

```js
const FORWARDING_HEADERS = ["forwarded","x-forwarded-for","x-forwarded-host","x-forwarded-proto","x-real-ip",
  "cf-connecting-ip","true-client-ip","cf-ray","x-service-entry-gateway"]; // single shared list (billing-http.js imports it)
parseCidrList(list: string[]) -> { cidrs: Cidr[], issues: string[] }    // IPv4, IPv6, IPv4-mapped IPv6
ipInCidrs(ip: string, cidrs: Cidr[]) -> boolean
hasForwardingHeaders(headers) -> boolean
resolveClientIdentity(req, { listener, cidrs, clientIpHeader, countryHeader }) ->
  { ip, socketIp, viaProxy: boolean, headerUsed: ""|"cf-connecting-ip"|"x-forwarded-for"|"x-real-ip",
    country: ""|"CN"|…, missingHeader: boolean, forwardedOnUntrusted: boolean, proto: "http"|"https" }
```

Algorithm:
1. Let `socketIp = normalize(req.socket.remoteAddress)`.
2. If `listener.kind === "admin"`, return `{ ip: socketIp, viaProxy: false, forwardedOnUntrusted: hasForwardingHeaders }`. ADMIN never honours headers (D8).
3. If `socketIp ∉ cidrs`, return the socket IP and set `forwardedOnUntrusted` when headers are present. A spoof attempt is recorded as a counter, never trusted.
4. Otherwise apply the configured header:
   - `cf-connecting-ip`: a single valid IP.
   - `x-forwarded-for`: walk the list right to left, skip entries in `cidrs`, take the first valid non-trusted IP; if every entry is trusted, take the leftmost.
   - `x-real-ip`: a single valid IP.
   - Missing or invalid header: `ip = socketIp`, `missingHeader = true`. This is normal for local tools that call 5186 directly.
5. `country` comes from `countryHeader` only when step 4 applied, and must match `^[A-Z]{2}$`.
6. `proto` comes from `x-forwarded-proto`/`cf-visitor` only when step 4 applied.

`security.resolveClientAddress(req)` becomes `resolveClientIdentity(req, …).ip`. The address the entry vouches to managers (§7) is that ip, which closes the LAN-spoof hole (V2).

## 5. Admin authentication (`service-entry/lib/admin-session.js`, `machine-auth.js`, `viewer-allowlist.js`)

### 5.1 Principals and roles

| Credential | Principal → role | How obtained | Accepted on |
|---|---|---|---|
| Session cookie `lai_admin=<sessionId>.<secret>` (`HttpOnly; SameSite=Strict; Path=/; Max-Age=sessionDays·86400`, sliding renewal at most once per hour) | `session:<id8>` → `owner`. From a LAN socket: `owner` only with `admin.allowLanOwner`, otherwise `viewer` | Pairing (§5.2) | ADMIN `/api/*` and pages; ADMIN `/gateway/*` as `console-session` (§5.8) |
| `Authorization: Bearer pat_<base32 32>` admin tool token | `token:<id>` → `owner` or `viewer` (per token) | Minted from a paired console; stored as sha256 | ADMIN `/api/*` |
| Internal HMAC signature (§5.7) | `system:<component>` → `system` with a fixed route scope | The entry trust token file | ADMIN `/api/*`, loopback socket, no forwarding headers |
| Loopback socket, no credentials, no forwarding headers, `admin.loopbackViewer` | `viewer` | Implicit; keeps health checks and old scripts reading | Registered viewer routes only (§5.4) |
| LAN socket, no credentials, `admin.lanAnonymousViewer` | `viewer` (redacted) | Implicit; 00 §5 "LAN viewers get read-only access with redaction" | Same |
| Anything else | `none` | — | — |

Only `owner`, `system` within its scope, and tool tokens with role `owner` may write. Session writes also need CSRF (§5.6).

Exports:

```js
createAdminAuth({ store, config, now, randomBytes, scanState, machineAuth, viewerRegistry, aiRoot }) -> {
  authenticate(req) -> { role: "owner"|"system"|"viewer"|"none", principal, via: "session"|"token"|"hmac"|"loopback"|"lan"|"none",
                         sessionId?, tokenId?, redact: boolean },
  guard(req, res, url) -> Promise<boolean>,   // single pre-dispatch check: §5.4 deny-by-default, CSRF, machine scope; true = answered
  checkManagementAccess(req, { write }) -> { ok, role, principal, redact, status, code, message },  // compat name (00 §5, /api/m proxy)
  eventTypesFor(auth) -> "*" | Set<string>,   // SSE filtering for viewers and machine principals
  requireCsrf(req) -> boolean,                // non-GET with session: x-csrf-token === hmac(csrfKey, sessionId)
  pairWithCode(req, code) -> { ok, setCookie, csrfToken } | { ok:false, code },
  mintPairCode({ actor, ttlSeconds = 120, lan = false }) -> { code, url, expiresAt },  // 10 chars base32, single use, stored hashed
  maybeAutoPair(req) -> { setCookie } | null,
  issueToolToken({ name, role, actor }) -> { id, token },                              // token returned once
  issueElevation(req, res, { scope: "audit", ttlSeconds <= 3600 }) -> { expiresAt },   // §5.6, called by 04 /api/audit/login
  checkElevation(req, scope) -> boolean,  revokeElevation(req),
  listSessions(), revokeSession(id, { actor }), revokeToolToken(id, { actor }), logout(req)
}
```

### 5.2 Pairing flows (frictionless locally)

1. **Launcher pairing (the normal path).** 06 `platform open` and `platform start` sign `POST /api/session/pair-codes` as `system:cli` (§5.7); before P6, `node service-entry\scripts\admin-pair.js --open` does the same. They receive `{code, url}` and open `http://127.0.0.1:5176/#pair=<code>`. The console boot script reads the fragment, calls `POST /api/session/pair {code}` and then `history.replaceState` to strip the fragment. The code is single-use and valid for 120 s. It is never logged, and it travels in the fragment, so it never appears in a request line or Referer. 05 does not edit `start-service-entry.cmd` (OPS-8 turns it into a shim).
2. **First-run auto-pair.** This applies once per install, while `access_meta.firstStartAt + firstRunWindowMinutes > now` and nothing has been paired yet. `firstStartAt` is the first start of a P5 entry, so upgraded installs also get one window. A request auto-pairs only if all of these hold:
   - ADMIN listener, loopback socket, no forwarding headers;
   - Host `127.0.0.1:5176` or `localhost:5176`;
   - `GET /`;
   - `sec-fetch-site: none`, `sec-fetch-mode: navigate` and `sec-fetch-dest: document`;
   - the exposure scan is not red for `legacy_proxy` or `admin_bind` (if the scan is unavailable, for example on non-Windows, this condition passes).

   After the first auto-pair, `access_meta.autoPairConsumed=1` and the window is permanently closed.
3. **Pair another device or browser.** In the console, `/access/sessions` → "Pair a device" calls `mintPairCode` and shows a code plus a QR of `http://<host>:5176/#pair=<code>`. A LAN code needs `listeners.admin.lan` and `admin.allowLanOwner`; otherwise the answer is 403 `lan_owner_disabled`.
4. **CLI.** `service-entry/scripts/admin-pair.js` exports `requestPairCode({ aiRoot, port }) -> { code, url, expiresAt }`. Run directly, it prints the URL to the terminal only; `--open` opens it. 06 `platform admin pair [--open]` is a wrapper over it.

`GET /api/session` returns `pairCommand`: `platform admin pair` when `<AI_ROOT>/platform.cmd` exists, else `node service-entry\scripts\admin-pair.js --open`. The pairing screen appears when `role!=="owner"` and the user attempts a write or opens an owner-only page. Its copy, with `{cmd}` = `pairCommand`:
- zh: 「此浏览器尚未与本机控制台配对。请从平台启动器打开控制台（会自动配对），或在终端运行 {cmd}。」
- en: "This browser is not paired with the console yet. Open the console from the platform launcher (pairs automatically) or run {cmd} in a terminal."

### 5.3 Storage and secrets

- Tables `admin_sessions`, `admin_tokens`, `admin_pair_codes` and `admin_elevations` live in the access store (§6.1). Only `sha256(secret)` is stored.
- The CSRF key is 32 random bytes kept in `access_meta`; it is not a credential. Cookies, CSRF tokens and pair codes are never logged.
- Machine principals use the entry trust token `<AI_ROOT>/.gateway-trust.json`. The entry regenerates it at each boot, `secureLocalSecretFile` restricts its ACL, and it is already the billing HMAC key. It is the platform's single internal secret. There is no separate CLI credential file and no DPAPI blob.
- No plaintext token is persisted (00 §1 rule).

### 5.4 Viewer access registry (`service-entry/lib/viewer-allowlist.js`)

Viewers and `system:mcp` may call only routes that a route-owning package registered. Everything else is owner-only by default.

```js
createViewerRegistry() -> {
  registerRoute({ owner, method = "GET", path, redact = null }),   // path: "/api/fleet" | "/api/m/:managerId/status" | "/c/*"
  registerReadOnlyPost({ owner, path, redact }),                     // side-effect-free POST, e.g. route preview
  registerAdminOnly({ owner, method, path }),                        // explicit declaration for the inventory
  registerEventType({ owner, type, redact }),
  match(method, pathname) -> { access: "viewer"|"admin", entry, params } | null,
  viewerEventTypes() -> string[],  redactEvent(type, data, ctx) -> data | null,
  inventory() -> [{ owner, method, path, access }],
  freeze()                                                           // after startup; later registration throws
}
```

Rules:
- **Deny by default.** In `guard`, a viewer request with no matching viewer entry gets 401 `admin_session_required` before any route code runs. HEAD follows GET.
- **Central redaction.** `guard` sets `req.viewer = { redact, ctx }`, and the shared `sendJson` applies it through `res.req`, so no route can forget it. `ctx = { via: "loopback"|"lan", params }`. If `redact` throws, the answer is 500 `internal_error` and the unredacted body is never sent. `system:mcp` gets the body unredacted.
- **Streams.** Viewer SSE streams carry only registered event types, each passed through its `redact`.
- `/billing` and `/api/billing/*` require owner **and** keep `strictLocalBillingAdmin`, unchanged.

05 baseline registrations (PUB-25):

| Method and path | Access | Redaction |
|---|---|---|
| GET `/`, `/index.html`, `/shared-js/*`, `/docs/<allowlisted>.md` | viewer | static |
| GET `/api/session` | viewer | none (it returns the caller's own role) |
| GET `/api/status` | viewer | `redactStatusForRemote` |
| GET `/api/security` | viewer | `describePublic` |
| GET `/api/fleet`; POST `/api/fleet/route-preview` (read-only POST) | viewer | new `redactFleetForViewer`: drops paths, ports, container ids, env, argv and pids; keeps model ids, states and capabilities |
| GET `/api/keys`, `/api/access/*`, `/api/public/*`, `/api/security/*`, `/api/session/list`, `/api/admin-tokens` | admin | — |
| events `status`, `instances` | viewer | `redactStatusForRemote`, `redactInstancesForViewer` |

Every other route-owning spec lists its own registrations: 01 entry engine reads; 02 model and knowledge reads; 03 `/api/hub/*` reads with path redaction and events `downloads`, `library`; 04 `/api/gateway-access`, `/api/telemetry/{live,summary,timeseries}` and events `telemetry.live`, `alerts`; 06 `/api/platform/status` and event `platform`; 07 `/classic`, `/c/*`, the SPA prefixes, `/api/console/bootstrap`, `/api/events/recent` and the CON-0 proxied manager reads `/api/m/:managerId/{status,instances,running-models,models,stats,jobs,tools/health}`.

A route module that is already in the tree when PUB-25 lands, but that its owner has not registered yet, is registered admin-only under that owner's tag. This is the safe default.

`viewer-allowlist.test.js` fails when an entry GET route is neither registered nor admin-only. It scans `service-entry/server.js` and `service-entry/lib/**/*.js` for route literals (`url.pathname === "…"`, `pathname.startsWith("/…")`, `/^\/api\/…/` patterns, exported `ROUTES` tables). Each GET literal must appear in `inventory()` after all modules have registered; the test reports `file:line` for any that do not.

### 5.5 Classic pages

- `service-entry/index.html` and `billing.html`: their fetch helpers (`index.html:1427` plus the three direct `fetch` calls at :2325/:2356, and `billing.html:1305`) call `GET /api/session` once and send `x-csrf-token` on non-GET requests.
- On a 401 `admin_session_required` they show the pairing screen. On a 403 `csrf_invalid` they re-read `/api/session` once and retry once.
- `tests/billing-page.spec.cjs` and `tests/frontend-smoke.spec.cjs` stub `/api/session` (§17.4).

### 5.6 Session API (ADMIN)

| Method and path | Auth | Request → Response |
|---|---|---|
| `GET /api/session` | any | → `{ok, role, via, paired, csrfToken?, autoPairAvailable, pairCommand}` |
| `POST /api/session/pair` | none (rate-limited 10/min/socket) | `{code}` → `{ok, csrfToken}` plus `Set-Cookie`; on error 400 `pair_code_invalid` |
| `POST /api/session/pair-codes` | owner session, owner token or `system:cli` | `{ttlSeconds?≤600, lan?}` → `{ok, code, url, expiresAt}` |
| `POST /api/session/logout` | session | → `{ok}`; clears `lai_admin` and `lai_elev` |
| `GET /api/session/list` | owner | → `{items:[{id, createdAt, lastSeenAt, createdIp, userAgent, current}]}` |
| `DELETE /api/session/:id` | owner | → `{ok}`; also revokes its elevations |
| `GET/POST /api/admin-tokens`, `DELETE /api/admin-tokens/:id` | owner | POST `{name, role}` → `{ok, id, token}` (once) |

Error codes (00 §4.2 envelope): 401 `admin_session_required` (no owner credential; the console shows pairing); 403 `csrf_invalid` (a session non-GET with a missing or wrong `x-csrf-token`; `hint: "reload"`); 403 `origin_not_allowed` (§3.3); 403 `lan_owner_disabled`; 401 `internal_signature_invalid|internal_signature_expired` and 403 `principal_scope_denied` (§5.7).

**Elevation cookie (audit).** 04's `POST /api/audit/login {password}` verifies the audit password, then calls `issueElevation(req, res, { scope: "audit", ttlSeconds })`. This needs an owner **session** (tokens and machine principals cannot elevate). It writes an `admin_elevations` row and sets `lai_elev=<id>.<secret>; HttpOnly; SameSite=Strict; Path=/api; Max-Age=<ttl>`. 04's `/api/audit/*` and `/api/telemetry/requests*` content routes call `checkElevation(req, "audit")`, which requires the cookie, an unexpired and unrevoked row, and the **same** live session. `POST /api/audit/logout` calls `revokeElevation`; logout and session revocation revoke it too. No audit token reaches page JavaScript.

### 5.7 Machine principals and internal auth (`manager-core/internal-auth.js`, PUB-24; entry side `service-entry/lib/machine-auth.js`, PUB-25)

One module signs every call from a local process to the entry. Manager principals (billing ids such as `vllm-manager`) call `/internal/*`, and machine principals `system:<component>` call ADMIN `/api/*`.

- **Signature.** `HMAC_SHA256(token, METHOD + "\n" + path + "\n" + principal + "\n" + ts + "\n" + sha256hex(body))`, base64url. With a billing manager id and a `/internal/billing/` path, this is byte-identical to today's billing signature (`billing-client.js:43-54`), so billing tests stay unchanged.
- **Wire forms.** The manager form keeps the existing names `x-ai-billing-{manager,ts,signature,version}` and signs the pathname. The machine form uses `x-ai-internal-principal`, `x-ai-internal-ts`, `x-ai-internal-signature`, `x-ai-internal-body-sha256` and `x-ai-internal-version: 1`. It signs `pathname + search`, so the query (for example SSE event types) is bound.
- **Key.** `readInternalKey({ aiRoot })` wraps `createGatewayTrustReader`, which checks the mtime and does not cache. The entry verifies with its in-memory token.
- **Entry verification** runs in `guard`, before dispatch:
  - The socket is loopback and no `FORWARDING_HEADERS` are present.
  - The principal matches `^system:(hub-shim:(vllm|llama)|supervisor|cli|mcp)$`.
  - `|now − ts| ≤ 60 s` and the signature matches.
  - For non-GET/HEAD, the entry reads the body (≤ 1 MiB, else 413 `request_too_large`) and compares its sha256 with the signed digest **before** the route runs. The buffer becomes `req.rawBody`, which every entry body reader (`readJsonObjectBody`, the hub and telemetry readers) uses first.
  - Failures return 401 `internal_signature_invalid|internal_signature_expired` and emit `security.internal_auth_failed` (sampled 1/s).
  - A request with no signature is judged on its other credentials. A bare `x-hub-shim` or similar header grants nothing.

| Principal | Caller | Scope (ADMIN, loopback only) | SSE types |
|---|---|---|---|
| `system:hub-shim:vllm`, `system:hub-shim:llama` | manager hub shims (03 `model-hub/client.js`), replacing `x-hub-shim` | `ANY /api/hub/*`, `GET /api/events` | `downloads`, `library`, `jobs` |
| `system:supervisor` | 06 supervisor | `POST /api/shutdown`, `POST /api/manager/shutdown`, `GET /api/platform/busy`, `GET /api/status` (unredacted), `GET /api/events?client=supervisor` | `status`, `notification`, `platform`, `alerts` |
| `system:cli` | 06 `platformctl`, `service-entry/scripts/{admin-pair,entry-call}.js`, `stop-service-entry.cmd` | Owner-equivalent on `/api/*`, except `/api/billing/*` and `/billing*`, audit content (`/api/audit/*`, `/api/telemetry/requests*`), and `/api/session/*` other than `pair-codes` | all |
| `system:mcp` | platform-mcp (`platform-client.ts`) | Every viewer-registered route (GET and read-only POST), unredacted | none |

Out-of-scope calls get 403 `principal_scope_denied`. Machine principals are exempt from CSRF checks because they carry no ambient credential. They cannot elevate.

`manager-core/internal-auth.js` exports:

```js
INTERNAL_PATH_PREFIXES = ["/internal/billing/", "/internal/access/", "/internal/telemetry/", "/internal/models/"]
MACHINE_PRINCIPAL_RE
signInternal(token, { method, path, principal, ts, bodySha256 }) -> string
buildInternalRequestHeaders(token, method, path, managerId, body, now)          // manager form
verifyInternalRequest(req, rawBody, token, { allowedManagers, pathPrefixes = INTERNAL_PATH_PREFIXES, now, maxSkewMs = 60000 })
  -> { ok, managerId, code }                                                    // billing paths keep the billing_* codes
buildMachineHeaders(token, { method, pathWithQuery, principal, body, now }) -> headers
verifyMachineSignature(req, token, { now, maxSkewMs = 60000 }) -> { ok, principal, bodySha256, code }   // caller checks the body digest
readInternalKey({ aiRoot }) -> () => string
createInternalClient({ aiRoot, principal | managerId, baseUrl = "http://127.0.0.1:5176", fetchFn, timeoutMs = 10000 })
  -> { request(method, pathWithQuery, body?) -> Promise<{ status, json }>, sse(pathWithQuery, onEvent) -> { close() } }
     // re-reads the key and retries once on 401 (entry restarted, token rotated)
```

Related rules:
- `billing-client.js` keeps its exported names, now implemented over these functions. Its own `post` still sends only `/internal/billing/` paths; the prefix allowlist lives only in `internal-auth.js`.
- 04's telemetry ingest and 02's `/internal/models/` callers use `createInternalClient({ managerId })`.
- Each entry `/internal/*` handler passes its own prefix to `verifyInternalRequest`.
- `/internal/*` is served on ADMIN only. It requires a loopback socket even when ADMIN is LAN-bound, and it accepts manager principals only.

### 5.8 `console-session` principal on the ADMIN gateway

The console playground and voice pages call `/gateway/*` with the owner's session instead of a key; 07 sends no key.
- **Where.** ADMIN listener only, `/gateway/*` only, and only when no API-key header is present. The `lai_admin` cookie must be a valid owner session under the §5.1 LAN rule. Non-GET requests need `x-csrf-token`; without it the answer is 403 `csrf_invalid` in the route's protocol shape (§10).
- **Scopes.** The chat family (`models.read`, `chat`, `completions`, `responses`, `messages`), the TTS family (`audio.speech`, `audio.clone`) and `debug.route`, because the playground shows `x-local-ai-route`. It never gets `mcp` or `search`.
- **Hop v2 principal.** `{"k":"console","b":null,"c":"console","t":"","l":"admin","p":"console-session"}`.
  - `b:null` means not billed: this is owner traffic, as keyless loopback traffic is today.
  - The empty TTS owner means owner-wide, as on loopback today.
  - It counts as owner traffic for the share gate (§9.5), and its per-session rpm bucket uses `admin.gatewayRpm`.
- **Telemetry** records the request as client `console` (`keyId: null`, `principal: "console-session"`, context `src: "console"`).
- **Precedence.** A key header always wins over the cookie. An invalid or expired cookie falls back to the keyless rules (`exposure.requireApiKey`). PUBLIC deletes `cookie` on receipt, so this principal cannot exist there.

## 6. Platform key store (`service-entry/lib/keys-store.js`, `service-entry/data/platform-access.sqlite`)

The database is a separate `node:sqlite` file beside `platform-billing.sqlite`, opened with WAL, `foreign_keys=ON` and `synchronous=NORMAL`. The entry opens and migrates it **before** listening, as billing does today (`server.js:399-410`). A broken store fails closed: gateway routes return 503 `auth_unavailable` and ADMIN stays up.

### 6.1 Schema (schemaVersion 1)

```sql
CREATE TABLE access_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- schemaVersion, firstStartAt, csrfKey, autoPairConsumed, migration.report
CREATE TABLE api_keys (
  key_id TEXT PRIMARY KEY,                -- 'k_<20 base32>' | '<managerId>.<clientId>' | '<managerId>.global'
  name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_preview TEXT NOT NULL,
  prev_key_hash TEXT UNIQUE, prev_key_expires_at TEXT,                 -- rotation overlap
  status TEXT NOT NULL CHECK (status IN ('active','disabled','revoked')),
  class TEXT NOT NULL CHECK (class IN ('owner','internal','friend','trial','customer')),
  customer_id TEXT, holder TEXT,                                         -- billing customer uuid; free-text holder label
  scopes TEXT NOT NULL, models TEXT NOT NULL, fleet_allow TEXT NOT NULL DEFAULT '[]', listeners TEXT NOT NULL DEFAULT '["public","admin"]',
  rpm INTEGER, tpm INTEGER, max_concurrent INTEGER, max_queued INTEGER, queue_timeout_s INTEGER, request_timeout_s INTEGER,
  daily_tokens INTEGER, monthly_tokens INTEGER, daily_requests INTEGER, max_output_tokens INTEGER,
  allowed_origins TEXT NOT NULL DEFAULT '[]', allowed_ips TEXT NOT NULL DEFAULT '[]', labels TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT, notes TEXT,
  billing_scope TEXT NOT NULL, billing_client_id TEXT NOT NULL, tts_owner TEXT NOT NULL,   -- §6.4
  legacy TEXT,                                                           -- JSON {managerId, clientId, source, usage, lastUsedAt}
  created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT,
  last_used_at TEXT, last_used_ip TEXT, last_used_country TEXT,
  UNIQUE (billing_scope, billing_client_id)
);
CREATE TABLE key_usage_counters (key_id TEXT NOT NULL, period TEXT NOT NULL,   -- 'd:YYYY-MM-DD' | 'm:YYYY-MM' in quota tz
  requests INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (key_id, period));
CREATE TABLE security_bans (subject TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('ip','cidr','key')),
  reason TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('auto','admin')), strikes INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, expires_at TEXT, created_by TEXT NOT NULL);
CREATE TABLE access_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, actor_ip TEXT,
  action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, details TEXT NOT NULL DEFAULT '{}');
CREATE TRIGGER access_audit_no_update BEFORE UPDATE ON access_audit BEGIN SELECT RAISE(ABORT,'access_audit is append-only'); END;
CREATE TRIGGER access_audit_no_delete BEFORE DELETE ON access_audit BEGIN SELECT RAISE(ABORT,'access_audit is append-only'); END;
CREATE TABLE admin_sessions (session_id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, created_ip TEXT, user_agent TEXT, revoked_at TEXT);
CREATE TABLE admin_tokens (token_id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
CREATE TABLE admin_pair_codes (code_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT, created_by TEXT NOT NULL, lan INTEGER NOT NULL DEFAULT 0);
CREATE TABLE admin_elevations (elevation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES admin_sessions(session_id),
  scope TEXT NOT NULL CHECK (scope IN ('audit')), secret_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE announcements (id TEXT PRIMARY KEY, severity TEXT NOT NULL CHECK (severity IN ('info','maintenance','incident')),
  title_zh TEXT NOT NULL, title_en TEXT NOT NULL, body_zh TEXT NOT NULL DEFAULT '', body_en TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL, ends_at TEXT, audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','keys')),
  published INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL);
CREATE TABLE public_model_meta (model_id TEXT PRIMARY KEY, display_name_zh TEXT, display_name_en TEXT, description_zh TEXT,
  description_en TEXT, aliases TEXT NOT NULL DEFAULT '[]', hidden INTEGER NOT NULL DEFAULT 0, recommended INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE status_samples (minute TEXT PRIMARY KEY, overall TEXT NOT NULL, models TEXT NOT NULL);   -- retention 30 d
```

### 6.2 Key secrets and matching

- New secret: `sk-plat-` followed by base64url of 32 random bytes. Preview: `sk-plat-` plus the first char, `…`, and the last 4.
- Hash: sha256 hex. This is the same algorithm as `hashServiceApiKey`, so migrated hashes match unchanged.
- Lookup: `key_hash = ? OR (prev_key_hash = ? AND prev_key_expires_at > now)`.
- Accepted headers: those read by `core.extractServiceApiKey` (`authorization: Bearer`, `x-api-key`, `api-key`, `anthropic-api-key`). A key in the query string is **never** accepted.

### 6.3 Scopes and model patterns (`service-entry/lib/key-policy.js`, pure)

| Scope | Grants |
|---|---|
| `models.read` | `GET /v1/models[/:id]`, `/anthropic/v1/models` |
| `chat` | `/v1/chat/completions`, `/gateway/*/opencode/*` |
| `completions` / `responses` | `/v1/completions` / `/v1/responses` |
| `embeddings` | `/v1/embeddings`, plus `/v1/rerank` and `/v1/score` when a capable instance exists |
| `messages` | `/anthropic/v1/messages[/count_tokens]`, `/v1/messages[/count_tokens]`, `/gateway/*/claude/*` |
| `audio.speech` | `/v1/audio/speech`, `/gateway/tts/openai/v1/audio/speech` |
| `audio.clone` | `/gateway/tts/api/*` workbench APIs, **ADMIN listener only** |
| `search` | `/gateway/search/*` (ADMIN; PUBLIC only with `public.exposeSearch`) |
| `mcp` | `/gateway/mcp*`, **ADMIN listener only** |
| `self.read` / `self.rotate` / `self.origins` | `GET /v1/me*` / `POST /v1/me/rotate` / `PUT /v1/me/origins` |
| `debug.route` | Receives the `x-local-ai-route` header |

No admin scope exists. Class `owner` counts as owner traffic for the share cap (§9.5). The `console-session` principal (§5.8) carries a fixed scope set and is not a key.

Exports:

```js
evaluateKey(key, { now, listener, ip, origin, scope }) -> { ok: true } | { ok: false, code }   // status, expiry, listener, ip, scope, origin
modelAllowed(key, { id, root, aliases }) -> boolean
fleetAllowed(key, fleetId) -> boolean
matchPattern(pattern, value) -> boolean
```

`modelAllowed` evaluates patterns case-insensitively in order: exact id, root or alias; then `*` globs (for example `qwen3.8-*`); then `!pattern` excludes applied last. `[]` means none and `["*"]` means all. `fleetAllowed` uses glob patterns on `${managerId}:${instanceId}` or `external:<id>`, and `[]` means all.

### 6.4 Billing principal

Every key carries `(billing_scope, billing_client_id)` and `tts_owner`:

| Key kind | `billing_scope` | `billing_client_id` | `tts_owner` |
|---|---|---|---|
| Migrated client | manager billing id (`vllm-manager`, from `MANAGERS[].billingId = env VLLM_MANAGER_ID \|\| "vllm-manager"`) | legacy client id | `vllm:<clientId>` |
| Migrated global key | manager billing id | `global-<hash24>` | `vllm:global-<hash24>` (fixes the cross-tenant TTS access, V5) |
| New key | `platform` | `key_id` | `platform:<key_id>` |

Billing changes in `service-entry/lib/billing-store.js`; the immutable tables are untouched:
- `authorizeRequest`/`settleRequest` accept an optional `credentialManagerId`, defaulting to `managerId`. The binding lookup uses it. Price resolution still uses the serving `managerId`.
- `ALTER TABLE billing_request_reservations ADD COLUMN credential_manager_id TEXT` (nullable, idempotent). `assertReservationIdentity` compares `COALESCE(credential_manager_id, manager_id)`.
- The binding API accepts `managerId:"platform"`.
- New read-only `getCustomerSummary(customerId, { at }) -> { enforcementMode, balanceMicrocredits, periodSpendMicrocredits, period }` for `/v1/me`.

### 6.5 Store API (exports of `createKeysStore({ DatabaseSync, file, now, randomBytes })`)

```js
createKey(input, { actor, ip }) -> { key: KeyRecord, secret }        // validates via normalizeKeyInput; audit 'key.create'
getKey(keyId) -> KeyRecord|null;   findBySecret(secret, now) -> { key, matched: "current"|"previous" } | null
listKeys({ status, class, customerId, q, expiringWithinDays, cursor, limit<=200 }) -> { items, nextCursor }
updateKey(keyId, patch, { actor, ip }) -> KeyRecord                   // audit 'key.update' with changed field names only
rotateKey(keyId, { overlapSeconds = 0, actor, ip }) -> { key, secret }   // overlap ≤ 7 d
revokeKey(keyId, { actor, ip, reason }) -> KeyRecord                  // terminal; no hard delete API exists
touchKey(keyId, { at, ip, country })                                  // coalesced: ≤ 1 write / 5 s / key
addUsage(keyId, { at, requests, inputTokens, cachedInputTokens, outputTokens, errors })   // UPSERT d: and m: rows
getUsage(keyId, { at }) -> { day: Counters, month: Counters, dayResetsAt, monthResetsAt }
bans: upsertBan, removeBan, listBans, activeBanFor(subjectIp, now)
audit: appendAudit({ actor, actorIp, action, targetType, targetId, details }), listAudit({ cursor, limit, action, targetId })
announcements: list/create/update/remove;  modelMeta: list/upsert;  status: putSample, listSamples(fromMinute)
meta: getMeta, setMeta;  close()
```

`KeyRecord` is the redacted JSON form. It never contains `key_hash` or `prev_key_hash`.

```json
{ "id": "k_7f3m9q2x8v4c1n6t5r0w", "name": "Alice laptop", "preview": "sk-plat-Q…9xZk", "status": "active", "class": "friend",
  "customerId": null, "holder": "Alice", "scopes": ["models.read","chat","messages","self.read","self.rotate"],
  "models": ["qwen3.8-*"], "fleetAllow": [], "listeners": ["public"],
  "limits": { "rpm": 30, "tpm": 100000, "maxConcurrent": 2, "maxQueued": 4, "queueTimeoutSeconds": 30, "requestTimeoutSeconds": 600,
              "dailyTokens": 2000000, "monthlyTokens": null, "dailyRequests": null, "maxOutputTokens": 8192 },
  "allowedOrigins": [], "allowedIps": [], "labels": { "preset": "friend" }, "expiresAt": "2027-01-12T00:00:00.000Z",
  "billing": { "scope": "platform", "clientId": "k_7f3m9q2x8v4c1n6t5r0w" }, "legacy": null,
  "createdAt": "…", "createdBy": "session:3f2a", "lastUsedAt": null, "lastUsedCountry": null, "rotation": null }
```

A `null` limit means "use `public.defaults`". The exceptions are `dailyTokens`, `monthlyTokens` and `dailyRequests`, where `null` means unlimited.

### 6.6 Presets (`GET /api/access/presets`; bilingual field help in console i18n area `access`)

| Preset | Class | Scopes (plus `models.read`, `self.read`) | rpm | tpm | conc | daily tokens | maxOut | expiry |
|---|---|---|---|---|---|---|---|---|
| `friend` | friend | chat, completions, responses, messages, embeddings, self.rotate, self.origins | 30 | 100k | 2 | 2M | 8192 | 90 d |
| `trial-7d` | trial | chat, messages | 10 | 50k | 1 | 500k | 4096 | 7 d |
| `paid` | customer (customer required) | friend set + audio.speech | 60 | 400k | 4 | — (billing plan) | 16384 | 365 d |
| `internal-app` (OpenWebUI) | internal | chat, completions, embeddings, audio.speech | 600 | — | 16 | — | — | none |
| `owner-device` | owner | everything incl. mcp, search, audio.clone, debug.route | 600 | — | 16 | — | — | none |

Example field help, rpm: zh 「每分钟最多请求数。超出返回 429，客户端应按 Retry-After 等待后重试。」/ en "Maximum requests per minute. Beyond it the API returns 429; clients should wait for Retry-After." Every field gets this treatment (00 §7.6). The keys live in `service-entry/console/i18n/access/{zh-CN,en-US}.json`, the `access` area of 07's per-area loader (CON-2). That file is written inside 07 CON-20/CON-21; the portal keeps its own `service-entry/portal/i18n/`.

### 6.7 Migration of legacy keys (`service-entry/lib/key-migration.js`)

Function `planKeyMigration({ managers: [{ id, billingId, settings, clients }], bindings, existingKeyIds }) -> { inserts, skipped, warnings }` is pure, and its output is a golden test. `applyKeyMigration(store, plan, { actor: "migration" })` runs in one transaction. Both run automatically at entry start when `access_meta['migration.v1']` is absent. Re-running is a no-op because the step is idempotent by `key_id` and `key_hash`. The legacy files are **never modified**.

Rules per manager `m` and client `c`:
- `key_id = ${m.id}.${c.id}` when `c.id` matches `^[A-Za-z0-9._-]{1,80}$`; otherwise `${m.id}.m${sha256(c.id).slice(0,8)}`, with a warning. `key_hash = c.keyHash` must be 64 hex characters, otherwise the client is skipped with `unusable_hash`.
- `status`: `enabled` maps to active, else disabled. `expires_at = c.expiresAt`. `models` is `c.allowedModels`, or `["*"]` when empty. `fleet_allow = ["${m.id}:*"]`; this preserves the "key is scoped to its manager" behaviour (`gateway.test.js:317`).
- Limits come from rpm, concurrency, queue and timeouts. tpm and the token caps are null.
- Scopes are the legacy-equivalent set: models.read, chat, completions, responses, embeddings, messages, audio.speech, audio.clone, search, mcp, self.read. PUBLIC never routes `audio.clone` or `mcp`, so nothing new is exposed.
- `class`: `customer` if a billing binding `(m.billingId, c.id)` exists, else `friend`. `customer_id` comes from the binding.
- Principal per §6.4. `legacy = { managerId, clientId, source: "service-clients", usage, lastUsedAt }`. `created_at = c.createdAt`. `listeners = ["public","admin"]`.
- `allowed_origins`: copied from the manager's `allowedOrigins` when `corsMode==="restricted"`; otherwise `[]`, with warning `cors_open_not_migrated` (O10).
- Global key (`settings.apiKeyHash`): `key_id = ${m.id}.global`, class `owner`, models `["*"]`, legacy scope set, principal per §6.4. Warning `global_key_converted`.
- Same `key_hash` in both managers: one record, `fleet_allow` is the union, the principal comes from the first manager in `MANAGERS` order, and warning `duplicate_key_across_managers` names the second binding.

The report (`access_meta['migration.report']`, shown by `GET /api/access/migration`) contains counts, warnings and per-key `{keyId, name, source, warnings[]}`. It never contains hashes.

### 6.8 Legacy manager key routes (forwarders)

Managers keep `/api/service-clients*` and `/api/service-exposure` (V8). After P5:
- `vllm-manager/server.js` and `llama-manager/server.js` pass `createServiceClient/update/rotate/delete/getServiceClientsLedger` implementations from `manager-core/legacy-key-forwarder.js`. These call `ANY /internal/access/legacy-clients[/:clientId[/rotate]]?managerId=` on the entry, signed with `manager-core/internal-auth.js` in the manager form (§5.7).
- They return the **legacy shapes**: `{ok, apiKey, client}`, `{version, clients:[redacted]}` and `{ok, removed, id}`.
- `DELETE` maps to revoke. A created key gets `key_id = ${m}.${slug}` and the legacy principal.
- A global key set or cleared in `/api/service-exposure` is forwarded the same way to `${m}.global` (create/rotate or revoke). The other exposure fields stay in the manager file and govern only direct manager calls (§7.2).
- If the entry is down: 503 `{code:"key_store_unavailable"}`. Legacy UIs keep working until the P7 console pages ship, and then show the D1 legacy banner.

## 7. Entry → manager trust (hop v2, the only signed hop) and gateway-only managers

### 7.1 Hop v2 headers (`manager-core/gateway-trust.js`, additive; PUB-10)

This is the single signed entry→manager hop. 04's request context travels inside it; 04 adds no second signature, no `kid` and no edits to `gateway-trust.js`. The entry still sends v1 exactly as today, so older managers keep working, and it adds:

```
x-service-entry-gateway: 1                         (unchanged marker)
x-service-entry-client / -ts / -signature          (v1, unchanged; v2 reuses the same ts)
x-request-id: req_<20 base32>
x-service-entry-principal: <base64url(JSON)>       absent for keyless ADMIN callers
x-service-entry-context: v1.<base64url(JSON)>      ≤ 512 bytes; fields owned by 04 (rid, cid, src, cc, ing); no kid: the key id is principal.k
x-service-entry-signature-v2: base64url(HMAC_SHA256(token,
   "v2\n" + METHOD + "\n" + pathname + "\n" + clientIp + "\n" + ts + "\n" + requestId + "\n"
   + (principalB64 || "-") + "\n" + sha256hex(contextHeader || "")))
```

Principal JSON: `{"k":"vllm.egg","b":"vllm-manager","c":"egg","t":"vllm:egg","l":"public","p":"key","mo":8192,"mc":2}`: key id, billing scope (`null` = not billed), billing client id, TTS owner, listener, principal kind (`key` or `console-session`, §5.8), max output, max concurrency.

Exports (the only code that builds or verifies the hop):
- `buildEntryHeaders(token, { method, pathname, clientIp, requestId, principal, context }, now) -> headers`. This returns v1 plus v2; `context` is the 04 object, which this function serializes.
- `verifyEntryRequest(req, { token | readGatewayTrustToken, now, maxSkewMs = 60000 }) -> { ok, version: 0|1|2, clientAddress, requestId, principal, context, reason }`:
  - The marker counts only from a loopback socket.
  - For v2, the principal and context are returned only when the signature verifies and `requestId` matches `^req_[a-z2-7]{20}$`. A context that does not parse yields `context: null` and `reason: "context_invalid"`.
  - A v1-only hop gives `{ ok: true, version: 1, principal: null, context: null }`. No marker gives `version: 0` (direct ingress).
  - A bad or expired signature gives `{ ok: false }`, and the caller treats the request as untrusted.
- `resolveRequestOrigin` now calls `verifyEntryRequest`. v2 uses a 60 s window; v1 keeps its 5 min window.

`pathname` is the manager-side path, so a captured hop cannot be replayed to another route. The context hash prevents a context swap. The instance signature header is unchanged. 04 TEL-2 consumes `verifyEntryRequest` and `buildEntryHeaders({ context })`. The order is P0-OBS-3 → PUB-10 → TEL-2, because all three touch `gateway-utils.js`.

**Key stripping.** The entry removes `authorization`, `x-api-key`, `api-key` and `anthropic-api-key` from the hop only if the target manager advertises `gatewayTrust.version >= 2` in `GET /api/manager/health` (additive field, cached 30 s). Otherwise it forwards them as today: legacy keys keep working, and platform-only keys get 503 `service_unavailable` with log reason `manager_upgrade_required`. Before building the hop, the entry always strips client-supplied `x-service-entry-*`, `x-ai-internal-*`, `x-ai-billing-*` and `x-request-id` headers. A valid client request id survives only as `clientRequestId` inside the context.

### 7.2 Manager middleware modes (`createServiceGatewayMiddleware`)

`gatewayOnly` comes from OPS-3 key `public.managersGatewayOnly`. The managers read it through `readSection("public")` at most every 10 s, the env `MANAGER_GATEWAY_ONLY` maps to it, and the default is `warn`. It is surfaced in `/api/service-exposure` as `gatewayOnly` and in `/api/manager/health` as `gatewayTrust: { version: 2, mode }`.

| Incoming | `off` | `warn` (upgrade default) | `enforce` |
|---|---|---|---|
| Valid v2 hop | Trust the principal: skip key and rate checks; apply a backstop concurrency cap per manager (`MANAGER_GATEWAY_BACKSTOP_CONCURRENCY`, 64); billing `clientId = principal.c` with `credentialManagerId = principal.b`; access log uses the vouched IP and `x-request-id` | same | same |
| Valid v1 hop (old entry) | Legacy path | Legacy path | Legacy path |
| Unsigned direct call to `/serve/v1`, `/claude`, `/v1/messages`, `/opencode/v1` | Legacy: the key is checked through `POST /internal/access/verify`, falling back to the legacy file if the entry is down | Same, plus response header `deprecation: true`, `link: </docs/migrate-public>; rel="deprecation"`, and log event `direct_manager_gateway` | 403 `{error:{code:"gateway_only", message:"Use the platform endpoint (port 5176 locally, 5186 public)."}}` |
| Forged marker or bad signature | Untrusted (today's fail-closed behaviour) | same | same |

`POST /internal/access/verify` takes `{ keyHash }` (the manager hashes the presented key) and returns `{ ok, keyId, principal, models, fleetAllow, limits: { maxConcurrent, rpm, maxOutputTokens }, expiresAt }`, or `{ok:false, code}`. It is cached 5 s per hash. The plaintext key never crosses the hop.

### 7.3 Internal auth

Manager → entry calls (`/internal/billing/`, `/internal/access/`, `/internal/telemetry/`, `/internal/models/`) and machine principals use the one module defined in §5.7 (`manager-core/internal-auth.js`, PUB-24). No other module checks internal path prefixes or signs internal calls.

## 8. Unified public API

### 8.1 Route mapping (`service-entry/lib/public-api.js`)

| Public route | Scope | Pipeline target (`gateway-pipeline.js`) | Engine filter |
|---|---|---|---|
| `GET /v1/models`, `GET /v1/models/:id` | models.read | Enriched catalog (§8.3) | — |
| `POST /v1/chat/completions` · `/v1/completions` · `/v1/responses` · `/v1/embeddings` · `/v1/rerank` · `/v1/score` | per §6.3 | protocol `openai`, rest `v1/<x>` → manager `/serve/v1/<x>` | auto |
| `POST /v1/audio/speech` | audio.speech | TTS proxy `/v1/audio/speech`, owner `key.tts_owner`, TTS billing meter `(tts_owner split)` | — |
| `POST /anthropic/v1/messages`, `/anthropic/v1/messages/count_tokens`, `GET /anthropic/v1/models`; aliases `/v1/messages[/count_tokens]` | messages / models.read | protocol `claude` → manager `/claude/v1/messages[/count_tokens]` | auto |
| `/vllm/v1/*`, `/llama/v1/*` | as above | Same as `/v1/*` with engine filter | `vllm` / `llama` (today's direct-manager semantics) |
| `/gateway/{auto\|vllm\|llama\|<engineId>\|external/<id>}/{openai\|claude\|opencode}/*` | as above | Unchanged parser plus the 00 §5 engineId/external forms (unknown engineId ⇒ 400 `unknown_engine`) | per path |
| `GET /gateway/status` | models.read | Legacy JSON shape (`server.js:1319-1342`); the bucket is **peeked** (V6 fix); models filtered before listing; `managers[].models` filtered by allowlist | — |
| `GET /v1/me`, `/gateway/me` and §8.5 | self.* | `me-routes.js` | — |

`gateway-pipeline.js` is extracted from `proxyGatewayRequest` (`server.js:1045-1240`). Both ADMIN `/gateway/*` and PUBLIC use it. On ADMIN the caller is resolved in this order: an API-key header, then `console-session` (§5.8), then the keyless rules (`exposure.requireApiKey`, `admin.gatewayRpm`). PUBLIC accepts keys only.

```js
createGatewayPipeline({ getCatalogs, getFleetSettings, security, keysStore, limiter, usageTap, telemetry, billing, tts, config })
  -> { handle(req, res, { route, listener, identity }) : Promise<void> }
```

`selectFleetTarget` (`service-entry/lib/model-fleet.js`) gains an option `filterCandidate(candidate) -> boolean`, applied before matching, which implements `modelAllowed`/`fleetAllowed`. `public_model_meta.aliases` are resolved to a target id before routing and the body is rewritten with `rewriteRequestModelBody`. Generic ids (`auto`, `default`…) pick among allowed models only.

### 8.2 Request lifecycle on PUBLIC (in order; the first failure answers)

1. Assign `requestId = req_<20 base32>`. A valid client `x-request-id` (`^[A-Za-z0-9._:-]{8,128}$`) is kept as `clientRequestId` and is never trusted as the join key. Respond with `x-request-id` always.
2. Route match, then `resolveClientIdentity`.
3. Ban check (IP, CIDR) ⇒ 429 `auth_banned`.
4. Pre-auth IP bucket ⇒ 429 `ip_rate_limited`.
5. `OPTIONS` ⇒ CORS preflight (§11).
6. Key lookup. Missing or invalid ⇒ 401; the failure is recorded and may escalate to a ban.
7. `evaluateKey`: status, expiry, listener, allowed IPs, origin, scope ⇒ 401 `key_expired`, 403 `key_disabled|scope_denied|origin_not_allowed|ip_not_allowed`.
8. Body read (`public.maxBodyBytes`), JSON content type, model extraction.
9. Alias resolution, then fleet selection with key filters ⇒ 403 `model_not_allowed`, 404 `model_not_found`, 503 `model_unavailable`.
10. `max_tokens`/`max_completion_tokens`/`max_output_tokens`: if absent and the key has a cap, inject the cap (the body is rewritten). If explicitly above the cap ⇒ 400 `max_tokens_exceeded` with `param`.
11. rpm bucket, then tpm bucket, then daily/monthly caps (§9) ⇒ 429.
12. Key concurrency queue ⇒ 429 `concurrency_limit_exceeded`.
13. Public share queue ⇒ 503 `overloaded`.
14. Proxy with hop v2. Upstream billing denials (`billing_*` codes with 402 or 429) map to `insufficient_quota`.
15. Usage tap (§8.6): tpm refund or debit, counters, `touchKey`, telemetry record.

Response headers: `x-request-id`, rate-limit headers (§9.6), `cache-control: no-store`, CORS when allowed, and `x-local-ai-route` only with `debug.route`.

### 8.3 Enriched `/v1/models`

The OpenAI list shape is kept, so clients ignore the extra fields. The data is joined from:
- the fleet catalogs and 00 §4.1 `capabilities`/`maxContext`;
- the ModelCard (02) for family, parameters and quantization;
- `public_model_meta`;
- the billing price for the key's plan, or the default plan when unbound;
- the key limits.

Engine, manager, instance, port and path are never included.

```json
{ "object": "list", "data": [ {
  "id": "qwen3.8-35b-a3b", "object": "model", "created": 1760400000, "owned_by": "local",
  "display_name": "Qwen3.8 35B A3B", "aliases": ["qwen3.8"], "family": "qwen3.8", "parameters": "35B-A3B", "quantization": "fp8",
  "context_length": 262144, "max_output_tokens": 8192,
  "capabilities": { "chat": true, "completions": true, "responses": true, "messages": true, "embeddings": false,
                    "vision": true, "tools": true, "reasoning": true, "audio_speech": false },
  "controls": { "reasoning_toggle": { "on": { "chat_template_kwargs": { "enable_thinking": true } },
                                      "off": { "chat_template_kwargs": { "enable_thinking": false } } } },
  "state": "ready",
  "pricing": { "unit": "credits_per_million_tokens", "input": "0.50", "cached_input": "0.05", "output": "2.00" },
  "limits": { "rpm": 30, "tpm": 100000, "max_output_tokens": 8192 } } ] }
```

- `max_output_tokens = min(model maximum, key cap)`.
- `state` is `ready`, `starting` or `sleeping`; `cold` appears only with `catalog.allowColdStart`.
- `controls` is present only when the ModelCard declares the toggle (contract C8).
- `pricing` is omitted when `showPrices` is false or no price exists.
- TTS models are included for keys with `audio.speech`, with `capabilities.audio_speech: true`.

### 8.4 Aliases and compatibility notes

- Existing tunnel clients keep their base URL `https://api.example.com/vllm/v1` and their legacy keys once the tunnel is repointed at 5186 (§16).
- Claude Code: `ANTHROPIC_BASE_URL=https://api.example.com/anthropic` with `ANTHROPIC_AUTH_TOKEN=<key>`. A base without `/anthropic` also works through the `/v1/messages` alias.
- Errors on `/anthropic/*`, `/v1/messages*` and `/gateway/*/claude/*` use the Anthropic shape (§10.1).

### 8.5 `/v1/me` family (`service-entry/lib/me-routes.js`)

`/v1/me` and `/gateway/me` cost one token from a separate per-key meta bucket (30/min). They do not count against rpm/tpm.

`GET /v1/me` response:

```json
{ "object": "key", "id": "k_…", "name": "Alice laptop", "preview": "sk-plat-Q…9xZk", "class": "friend", "status": "active",
  "created_at": "…", "expires_at": "2027-01-12T00:00:00.000Z", "scopes": ["…"],
  "models": { "patterns": ["qwen3.8-*"], "available": ["qwen3.8-35b-a3b"] },
  "limits": { "rpm": 30, "tpm": 100000, "max_concurrent": 2, "max_output_tokens": 8192, "daily_tokens": 2000000, "monthly_tokens": null },
  "rate_limit": { "requests": { "limit": 30, "remaining": 28, "reset_seconds": 4 }, "tokens": { "limit": 100000, "remaining": 93000, "reset_seconds": 5 } },
  "usage": { "today": { "requests": 41, "input_tokens": 120345, "cached_input_tokens": 80000, "output_tokens": 30211, "resets_at": "…" },
             "month": { "requests": 812, "input_tokens": 2203345, "cached_input_tokens": 1500000, "output_tokens": 610211, "resets_at": "…" } },
  "quota": { "daily_tokens": { "limit": 2000000, "used": 150556, "remaining": 1849444, "pace": "ok", "projected_exhaustion_at": null },
             "monthly_tokens": null },
  "billing": { "bound": true, "mode": "shadow", "balance_credits": "12.500000", "period_spend_credits": "3.200000" },
  "allowed_origins": [], "self_service": { "rotate": true, "origins": true },
  "announcements": [ { "id": "an_…", "severity": "maintenance", "title": "…", "starts_at": "…", "ends_at": "…" } ],
  "request_id": "req_…" }
```

- `pace` compares used against `limit × elapsedFractionOfPeriod`: `ok` means ≤ 1.0, `ahead` means > 1.0, and `exhausted` means remaining 0. `projected_exhaustion_at` is a linear extrapolation within the period, or null.
- `billing` is null when the key has no customer binding.
- `title` follows `Accept-Language` (zh or en).

| Route | Scope | Request → Response |
|---|---|---|
| `GET /v1/me/usage?from=YYYY-MM-DD&to=…&group_by=day[,model]` (≤ 92 days) | self.read | → `{object:"list", granularity:"day", data:[{date, model?, requests, input_tokens, cached_input_tokens, output_tokens, errors, cost_credits?}], source:"telemetry"\|"counters"}`. Grouping by model needs telemetry (04); the counters fallback has day granularity only |
| `GET /v1/me/usage.csv` (same query) | self.read | BOM-prefixed, formula-escaped CSV (same rules as `access-log.js:376-473`) |
| `GET /v1/me/requests?limit≤100&cursor=` | self.read | → `{object:"list", data:[{request_id, at, model, endpoint, stream, status, error_code, input_tokens, cached_input_tokens, output_tokens, ttft_ms, duration_ms}], next_cursor}`. No IP, no content |
| `POST /v1/me/rotate` `{confirm:true}` | self.rotate; same-origin only (Origin absent or equal to the public origin); 3/hour | → `{key, preview, rotated_at, previous_valid_until:null}`. Audit `key.rotate.self` |
| `PUT /v1/me/origins` `{origins:[…≤10]}` | self.origins; same-origin only | → `{allowed_origins}`. Exact `https://host[:port]` only, plus `http://localhost[:port]` and `http://127.0.0.1[:port]`; `*` is rejected |

### 8.6 Usage tap (`service-entry/lib/usage-tap.js`)

```js
createUsageTap({ protocol: "openai"|"anthropic", endpoint, stream, estimatedInputTokens })
  -> { transform: Transform, result: Promise<{ inputTokens, cachedInputTokens, outputTokens, source: "upstream"|"estimate"|"none", terminal: "completed"|"client_abort"|"upstream_error"|"timeout" }> }
```

- OpenAI SSE uses `core.createOpenAiSseUsageParser`; the manager already forces `include_usage` (V9).
- Anthropic SSE reads `message_start.message.usage.input_tokens` and `message_delta.usage.output_tokens`.
- Non-stream JSON is read from a bounded copy of at most 4 MB, then `usage`.
- The tap never delays or alters bytes. It resolves on `finish` **or** `close`; an abort keeps the partial usage.
- If 04's `GatewayRecorder` exposes the same usage, this module becomes an adapter over it (contract C5).
- On resolve: the tpm bucket is refunded or debited by `actual − reserved`, `keysStore.addUsage`, `touchKey`, and `telemetry.record({... keyId, customerId, listener, clientIp, country, errorCode})`.

## 9. One limiter (`service-entry/lib/limiter.js`)

### 9.1 Token buckets

`createTokenBucketMap({ maxEntries = 50000 })` exposes:
- `take(key, { capacity, refillPerSec, cost, now }) -> { ok, remaining, resetSeconds, retryAfterSeconds }`
- `peek(...)`
- `adjust(key, delta)`, which may go negative and is capped at capacity.

Map entries are evicted LRU.

- **rpm**: capacity = rpm, refill = rpm/60 per second, cost 1.
- **tpm**: capacity = tpm, refill = tpm/60 per second. Admission cost = `estimateOpenAiRequestInputTokens(body)` (or the Anthropic equivalent) plus `reservedOutput`, where `reservedOutput = min(requested max ?? key cap ?? 4096, key cap ?? ∞)`. If the cost exceeds capacity: 400 `request_exceeds_tpm`, because the request can never succeed. After usage: `adjust(+(cost − actual))`.

### 9.2 Pre-auth limiter

A per-IP bucket (`public.preAuth`) applies to model and API routes, `/status.json`, `/catalog.json` and `/gateway/*`. Portal assets are exempt. A request with `missingHeader` from a trusted socket uses the bucket `proxy:<socketIp>`, which `authFailure` never bans.

### 9.3 Auth failures and bans

`createPersistentBanGuard({ store, config, now })` wraps `core.createAuthFailureGuard` semantics:
- 401s per IP inside the window reach the limit ⇒ an `auto` ban.
- Duration = `banSeconds × 4^(strikes−1)`, capped at `maxBanSeconds`. Strikes decay after 24 h without a failure.
- Bans are loaded at start and checked in O(1). CIDR bans are checked through a small sorted list.
- Admin can ban or unban IPs, CIDRs and keys (§13.3).
- Loopback, and the trusted-proxy socket address itself, are never banned.

### 9.4 Quotas

`daily_tokens`, `monthly_tokens` and `daily_requests` are checked against the counters (`getUsage`, with an in-memory 2 s cache) plus in-flight reservations. Overflow ⇒ 429 `insufficient_quota` with `param` set to `daily_tokens`, `monthly_tokens` or `daily_requests`, and `retry-after` set to the time until the period resets. Periods use the quota tz (§3.4).

### 9.5 Public share cap (owner is not starved)

`createShareGate({ config })` is a FIFO semaphore for PUBLIC requests from non-owner classes.
- Effective concurrency is `share.maxConcurrent`, reduced to `ownerActiveMaxConcurrent` while owner traffic is in flight. Owner traffic means ADMIN-listener model requests plus keys of class `owner`.
- Queue limit `maxQueued`; timeout ⇒ 503 `overloaded` with `retry-after: 5`. On Anthropic routes the status is 529 `overloaded_error`.
- The gate releases on `finish` or `close`.

### 9.6 Headers

Every key-authenticated response carries:

```
x-ratelimit-limit-requests: 30          x-ratelimit-remaining-requests: 28      x-ratelimit-reset-requests: 4s
x-ratelimit-limit-tokens: 100000        x-ratelimit-remaining-tokens: 93000     x-ratelimit-reset-tokens: 5s
x-quota-remaining-tokens-day: 1849444   x-quota-remaining-tokens-month: …       (only when a cap exists)
```

On Anthropic routes it also sends `anthropic-ratelimit-requests-{limit,remaining,reset}` and `anthropic-ratelimit-tokens-{limit,remaining,reset}`, where reset is RFC 3339. A 429 always carries `retry-after`, in seconds.

The ADMIN keyless `/gateway` keeps the per-IP rpm from `admin.gatewayRpm` (env `SERVICE_ENTRY_RATE_LIMIT_RPM`, default 600). It now also emits these headers. `console-session` uses the same rpm per session.

## 10. Errors (`service-entry/lib/public-errors.js`)

### 10.1 Shapes

- OpenAI routes: `{"error":{"message","type","code","param"},"request_id":"req_…"}` (00 §4.2).
- Anthropic routes: `{"type":"error","error":{"type","message"},"request_id":"req_…"}` (contract C2).
- Messages are stable English constants. The portal translates by `code`.
- Messages never contain paths, ports, manager names, env names or file names. This fixes `security.js:255-260, 278` and `server.js:1183`.

Exports: `publicError(code, { param, retryAfterSeconds, detail }) -> { status, headers, openai, anthropic }` and `sendPublicError(req, res, code, opts)`, which is protocol- and content-negotiated.

### 10.2 Taxonomy (golden-tested)

| code | HTTP | OpenAI type | Anthropic type | Meaning / fix (docs anchor `/docs/errors#<code>`) |
|---|---|---|---|---|
| `missing_api_key` | 401 | authentication_error | authentication_error | Send `Authorization: Bearer <key>` |
| `invalid_api_key` | 401 | authentication_error | authentication_error | The key is wrong or was rotated |
| `key_expired` | 401 | authentication_error | authentication_error | Ask the owner to renew |
| `key_disabled` | 403 | permission_error | permission_error | Disabled or revoked |
| `scope_denied` | 403 | permission_error | permission_error | The key lacks the scope for this endpoint (`param` = endpoint) |
| `model_not_allowed` | 403 | permission_error | permission_error | `param: "model"` |
| `origin_not_allowed` / `ip_not_allowed` | 403 | permission_error | permission_error | Add the origin under My Key |
| `csrf_invalid` | 403 | permission_error | permission_error | ADMIN `console-session` only (§5.8): reload the console |
| `model_not_found` | 404 | invalid_request_error | not_found_error | See `/v1/models` |
| `not_found` / `method_not_allowed` | 404 / 405 | invalid_request_error | not_found_error | — |
| `invalid_request` / `invalid_json` / `max_tokens_exceeded` / `request_exceeds_tpm` / `unknown_engine` | 400 | invalid_request_error | invalid_request_error | — |
| `request_too_large` / `unsupported_media_type` | 413 / 415 | invalid_request_error | request_too_large / invalid_request_error | — |
| `ip_rate_limited` / `auth_banned` | 429 | rate_limit_error | rate_limit_error | Wait for `retry-after` |
| `rate_limit_exceeded` (rpm) / `tokens_rate_limit_exceeded` (tpm) / `concurrency_limit_exceeded` | 429 | rate_limit_error | rate_limit_error | Back off |
| `insufficient_quota` | 429 | insufficient_quota | rate_limit_error | Daily, monthly or billing quota reached |
| `overloaded` | 503 (529 on Anthropic) | server_error | overloaded_error | Public capacity is full; retry |
| `model_unavailable` / `service_unavailable` / `auth_unavailable` / `billing_unavailable` | 503 | server_error | api_error | Check `/status` |
| `upstream_error` / `upstream_timeout` / `internal_error` | 502 / 504 / 500 | server_error | api_error | Quote the `request_id` |

### 10.3 Content negotiation

The rule is `wantsHtml(req) = method==="GET" && !hasApiKeyHeader && accepts(text/html) ranks above accepts(application/json)`.
- API path prefixes (`/v1`, `/anthropic`, `/vllm`, `/llama`, `/gateway`) answer JSON unless `wantsHtml`. In that case they render "This is an API endpoint" with a docs link.
- Portal paths answer HTML unless the client prefers JSON.

HTML error pages are rendered server-side from `service-entry/portal/error.html`, with every value escaped, no script, the portal CSS, and zh/en chosen by `Accept-Language`. Each page gives the status, a title, an explanation, next steps, the `request_id` and a link to `/status`.

## 11. CORS (deny by default, per key)

- **Preflight** carries no key. It is allowed when `Origin` is in the cached union of `allowed_origins` across active keys (refreshed on key change). The answer sets:
  - `access-control-allow-origin: <origin>`, `vary: Origin`;
  - `access-control-allow-methods: GET, POST, OPTIONS`;
  - `access-control-allow-headers: authorization, content-type, x-api-key, api-key, anthropic-api-key, anthropic-version, anthropic-beta, x-stainless-*`, which is expanded to the names actually requested when they match `^x-stainless-[a-z0-9-]+$`;
  - `access-control-max-age: 600`.

  Otherwise the answer is 204 without allow headers.
- **Actual request**: after auth, the request's `Origin` must be in that key's `allowed_origins`, otherwise 403 `origin_not_allowed`. The response then sets ACAO to the origin and exposes `x-request-id, x-ratelimit-*, retry-after, anthropic-ratelimit-*`.
- **Never** `access-control-allow-credentials`, and never `access-control-allow-private-network` (V10).
- Wildcard `*` is allowed only on keys whose scopes are a subset of `{models.read, chat, messages, completions, self.read}` and whose class is `friend` or `trial`. Admin APIs refuse it otherwise with 400 `wildcard_origin_requires_restricted_key`.
- The portal is same-origin and needs no CORS.

## 12. Public portal (PUBLIC listener; `service-entry/portal/`)

### 12.1 Technology and layout

- **Libraries.** Buildless ES modules with Preact, hooks and htm (D2), uPlot for charts and `qrcode-generator` for QR. All come from the one vendor tree that 07 CON-1 owns, `shared-public/vendor/<pkg>/<version>/`, listed in `VENDOR.json`. The portal never vendors, and the same tree is served at 5176 (console) and 5186 (portal).
- **Tokens.** Design tokens come from the single file `shared-public/styles/tokens.css`, owned by 07. Light and dark follow `prefers-color-scheme`.
- **Build id.** `%BUILD_ID%` is 06 `getBuildId().contentHash`, the only build id; the footer shows `commit`.
  - `public-listener.js` keeps an in-memory snapshot of the allowlisted files under that id. When an HTML request finds a changed mtime (throttled to 2 s), it asks `getBuildId()` again.
  - The previous id stays served; an older id returns 410 `{error:{code:"portal_stale"}}`, and the shell reloads.
- **Import map.** Preact hooks import the bare specifier `preact`, so relative specifiers alone are not enough. `%IMPORT_MAP%` is generated from `VENDOR.json.importMap` with the prefix `/assets/<id>/vendor/` and inlined. The CSP allows exactly that text by hash.
- Files:
  - `index.html` with `%BUILD_ID%`, `%IMPORT_MAP%` and `%LANG%`, plus `app.js` (router, i18n, key session, API client);
  - `pages/{status,models,model,docs,me,playground,announcements}.js`;
  - `components/{header,footer,status-badge,model-card,code-tabs,gauge,usage-chart,table,toast,lang-switch,copy-button}.js`;
  - `lib/{api,sse,md,format,snippets}.js`, `styles/portal.css`, `i18n/{zh-CN,en-US}.json` (the portal's own dictionaries, not a console i18n area);
  - `docs/<slug>.{zh-CN,en-US}.md`, `data/client-snippets.json`, `error.html`.
- `lib/md.js` is an escape-first renderer for headings, paragraphs, lists, fenced code and https links. It never emits raw HTML.
- **CSP:** `default-src 'none'; script-src 'self' 'sha256-<base64 sha256 of the import-map text>'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`. The hash is computed when the snapshot is built. Other headers: `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `cross-origin-opener-policy: same-origin`, `permissions-policy: camera=(), microphone=(), geolocation=()`.
- Versioned assets are cached immutable; the shell is `no-store`.
- **Language.** The order is `?lang=`, then `localStorage['portal.lang']` (in try/catch), then `navigator.language`. The header switch reads 中文 / English. `service-entry/test/portal-i18n.test.js` checks key parity and the absence of duplicate keys.
- **Mobile.** 16 px gutters, single column below 720 px, no horizontal overflow at 390 px. Keyboard reachable, focus rings visible, all icons labelled.

`GET /portal-config.json`:

```json
{ "baseUrl": "https://api.example.com", "openaiBase": "https://api.example.com/v1", "anthropicBase": "https://api.example.com/anthropic",
  "brand": { "zh-CN": "本地模型服务", "en-US": "Local Model Service" }, "buildId": "…",
  "features": { "playground": true, "showPrices": true, "tts": true } }
```

When `listeners.public.baseUrl` is empty (LAN-only), the base is derived from the allowed `Host` of the request.

### 12.2 Status page and `/status.json`

`service-entry/lib/status-sampler.js` runs `startStatusSampler({ getCatalogs, telemetry, store, config, intervalMs = 60000 })` and writes `status_samples`; 30-day retention is pruned daily. `/status.json` is cached for 15 s, and its numbers are bucketed and rounded:

```json
{ "schemaVersion": 1, "status": "operational", "updated_at": "…",
  "message": { "zh-CN": "服务正常", "en-US": "All systems operational" },
  "models": [ { "id": "qwen3.8-35b-a3b", "display_name": "Qwen3.8 35B A3B", "state": "ready", "queue": "idle", "ttft_p50_ms": 350, "tokens_per_second": 85 } ],
  "uptime": { "h24": 99.3, "d7": 97.1, "hours_7d": [ { "hour": "2026-10-13T10:00:00Z", "up": 1 } ] },
  "announcements": [ { "id": "an_…", "severity": "maintenance", "title": { "zh-CN": "…", "en-US": "…" }, "starts_at": "…", "ends_at": "…" } ] }
```

- Overall status:
  - `maintenance`: an active published maintenance announcement.
  - `offline`: no published model is ready.
  - `degraded`: some published model is not ready, or the 5xx rate is above 5 % over 5 min (telemetry), or the share queue is at least half full.
  - `operational`: otherwise.
- `queue` is `idle`, `light` or `busy`. `ttft_p50_ms` is rounded to 50 and `tokens_per_second` to 5, both from telemetry over 15 min; they are omitted without telemetry.
- Only models matching `catalog.publish` and not hidden are listed. No ports, paths, instance ids or engine names appear.

Page copy: the state label (zh 服务正常 / 部分降级 / 主机离线 / 维护中; en Operational / Degraded / Offline / Maintenance), per-model cards, a 7-day hourly uptime bar, an announcement banner, a "last updated" time and auto-refresh every 30 s.

### 12.3 Models catalog (`/models`, `/catalog.json`)

Without a key, the page shows `/catalog.json`: models in the publish list with their display name, family, parameters, quantization, modalities, tools and reasoning flags, context, max output, default-plan prices (if shown), default limits and state. With a key in sessionStorage, it uses `/v1/models` and marks "available to your key". Each card links to "Try in playground" and to docs.

### 12.4 Docs with copy-paste snippets (`/docs`)

Pages: `quickstart` (get key → set base URL → pick model), `api`, `streaming`, `tools`, `vision`, `tts`, `errors` (generated from the §10.2 table), `limits` (rate limits, quotas, headers, share cap), `privacy` and `clients`.

`privacy` covers what is logged (request metadata: time, key id, model, tokens, timings, IP and country) and what is not (API prompt and response content). It also covers the retention period (from telemetry config) and states that conversations in the OpenWebUI chat site may be audited.

`data/client-snippets.json` carries `schemaVersion`, `asOf`, `staleAfterDays: 90` (00 §7.5). Each client entry is `{id, name, versionTested, kind: "code"|"steps", code|steps_zh/steps_en, fields}`, with placeholders `{{OPENAI_BASE}}`, `{{ANTHROPIC_BASE}}`, `{{BASE}}`, `{{MODEL}}` and `{{KEY}}`. `{{KEY}}` renders as `$API_KEY` unless the user toggles "insert my key", which is off by default. Required clients:
- curl: chat, stream, embeddings, TTS;
- Python `openai` and Node `openai`;
- Anthropic Python SDK (`base_url={{ANTHROPIC_BASE}}`);
- Claude Code (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`);
- OpenWebUI (Connections → OpenAI API → `{{OPENAI_BASE}}`);
- Chatbox (custom OpenAI-compatible provider, API host `{{BASE}}`, path `/v1/chat/completions`);
- Cherry Studio (provider type OpenAI, API address `{{BASE}}`);
- NextChat (`BASE_URL={{BASE}}`) and LobeChat (`OPENAI_PROXY_URL={{OPENAI_BASE}}`), each with an "add your web origin in My Key" note;
- Cursor (override OpenAI base URL), Continue (`config.yaml` provider `openai`, `apiBase`), Cline (OpenAI Compatible);
- TTS via OpenAI `audio.speech`.

The snippet strings are verified against `versionTested` and re-checked when stale; the portal shows "checked on {asOf}". A note on long requests says: use `stream: true`, because edge proxies can cut non-streaming responses after about 100 s.

### 12.5 My Key (`/me`)

- **Sign-in.** Paste the key, store it in `sessionStorage['portal.key']` (in try/catch), and validate with `GET /v1/me`. The share link `https://api.example.com/me#key=sk-…` is read once and then removed with `history.replaceState`. "Sign out" clears the stored key.
- **Header.** Name, preview, class, a status chip, and expiry with a countdown (shown in red under 7 days).
- **Access.** Scopes in plain language (zh/en) and models: the patterns plus "available now".
- **Live limits.** Gauges for rpm and tpm remaining and concurrency, polled every 10 s while the tab is visible.
- **Quota pace.** Bars for today and this month with a pace marker and "at this pace, runs out ~14:20" (zh「按当前速度约 14:20 用完」), plus reset times.
- **Balance** (when billing is bound): balance, period spend, mode (shadow is labelled 「试运行，不扣费」/ "trial mode, not charged").
- **Charts** (uPlot): tokens per day for 30 days, stacked by model (telemetry) or totals (counters); requests and errors per day. Charts have a time axis, tooltips and gaps; the empty state explains why.
- **Recent requests.** A table of the last 50 requests (time, model, endpoint, tokens in/cached/out, TTFT, duration, status or error code, copyable request id). Content is never shown.
- **Actions.**
  - Rotate (with `self.rotate`): confirm dialog, then the new key is shown once and replaces the stored session key.
  - Allowed origins editor (with `self.origins`).
  - Download usage CSV.

### 12.6 Playground (`/playground`)

- The model picker lists only `/v1/models` entries for the key. Controls: system prompt, temperature, top_p, max_tokens (capped) and the reasoning toggle (only when `controls.reasoning_toggle` exists). Each control has a one-line zh/en explanation.
- Streaming uses `fetch` plus `lib/sse.js` and can be stopped (AbortController). Per message it shows tokens, TTFT, tok/s and cost (price × usage).
- "Copy as curl/Python/Node" reproduces the exact request, with the key replaced by `$API_KEY` unless toggled.
- Nothing is stored server-side beyond normal request metadata; the transcript lives in memory only, and the privacy note says so.

### 12.7 Announcements

`/announcements` lists active and upcoming announcements. A banner appears on every portal page (dismissal is remembered per id in localStorage, in try/catch). They are also returned in `/v1/me` and `/status.json`.

## 13. Admin side (ADMIN listener)

### 13.1 Access APIs (`service-entry/lib/access-routes.js`; owner for writes, CSRF, audited)

| Method and path | Request → Response |
|---|---|
| `GET /api/access/keys?status&class&customer&q&expiring&cursor&limit` | → `{ok, items: KeyRecord[], nextCursor, counts}` |
| `POST /api/access/keys` | `{preset?, name, class, customerId?, holder?, scopes, models, fleetAllow?, listeners?, limits?, allowedOrigins?, allowedIps?, labels?, expiresAt?, notes?}` → `{ok, key, secret, share}`, where `share = {openaiBase, anthropicBase, portalUrl, recommendedModel, snippetCurl}`; the secret is returned once and never logged |
| `GET /api/access/keys/:id` | → `{ok, key, usage: {day, month}}` |
| `PATCH /api/access/keys/:id` | Partial `KeyRecord` fields → `{ok, key}` (400 `invalid_field` with 00 §4.2 `errors[]`) |
| `POST /api/access/keys/:id/rotate` | `{overlapSeconds: 0\|3600\|86400\|604800}` → `{ok, key, secret}` |
| `POST /api/access/keys/:id/revoke` | `{confirmName}` (must equal the key name) → `{ok, key}` |
| `POST /api/access/keys/bulk-revoke` | `{keyIds[], confirm: "REVOKE <n>"}` → `{ok, revoked}` |
| `GET /api/access/presets` | → `{ok, presets}` (§6.6, with i18n keys) |
| `GET /api/access/migration` | → `{ok, report}` |
| `POST /api/access/migration/plan` | → `{ok, plan: {inserts:[{keyId, name, source}], skipped, warnings}}`. Side-effect free; `platform keys migrate --dry-run` |
| `POST /api/access/migration/apply` | `{confirm: true}` → `{ok, report}`. Idempotent; `platform keys migrate` |
| `GET /api/access/audit?cursor&action&target` | → `{ok, items, nextCursor}` |
| `GET /api/public/settings` | → `{ok, config, issues, etag}`, sections `listeners`, `admin`, `trustedProxies`, `public`, plus `exposure` read-only (06 edits it through `/api/platform/config`) |
| `PATCH /api/public/settings` | `{section, patch}` with `If-Match: <etag>` → `{ok, config, etag, restartRequired: [componentIds]}` through `updateAccessSection` → OPS-3 `writeSection`; 409 `config_conflict` on a stale etag |
| `GET/POST /api/public/announcements`, `PATCH/DELETE /api/public/announcements/:id` | CRUD |
| `GET/PUT /api/public/models/:modelId/meta` | `public_model_meta` |
| `GET /api/keys` (compat) | Same shape as today (`key-overview.js`), computed by passing virtual managers grouped by `legacy.managerId` or `platform` to `summarizeServiceKeys` |
| `GET /api/security` (compat) | Same fields. `publicChecklist` is mapped from §13.2 checks; the ids are kept (`api-key`, `lan-admin`, `cors`, `https`, `loopback-bind`, `rate-limit`), `caddy-paths` becomes `proxy-target`, and `firewall` becomes a real state |
| `/internal/access/verify`, `/internal/access/legacy-clients…` | §6.8, §7.2 (loopback plus HMAC) |

### 13.2 Exposure scan, checks and legacy detection (`service-entry/lib/exposure-scan.js`)

These are read-only probes with a 10 s timeout each, run one at a time, cached 60 s, and returning `unsupported` off Windows. The parsers are pure and golden-tested.

Each probe is run by `execFile` with fixed argument arrays:
- `powershell.exe -NoProfile -NonInteractive -Command "Get-NetTCPConnection -State Listen | Select LocalAddress,LocalPort,OwningProcess | ConvertTo-Json"`;
- `Get-CimInstance Win32_Process` for the owning PIDs only. Command lines are matched against signatures and then **discarded**, never returned, because they may contain secrets;
- `Get-NetFirewallProfile | Select Name,Enabled | ConvertTo-Json`;
- `netsh interface portproxy show all`;
- `docker ps --format "{{json .}}"`;
- HTTP `GET http://127.0.0.1:<cloudflaredMetricsPort>/ready`.

```js
runExposureScan({ aiRoot, config, exec, fetch, now }) -> Promise<ExposureReport>
parseListeners(json), parseFirewall(json), parsePortProxy(text), parseDockerPs(lines), classifyProcess(name, cmdline) -> signatureId|null
detectLegacyArtifacts(aiRoot, fs) -> Finding[]
```

`ExposureReport = { at, checks: Check[], legacy: Finding[], map: { nodes, edges }, probe }`. A `Check` is `{ id, state: "ok"|"warn"|"fail"|"unknown"|"manual", title: i18nKey, evidence, fix: i18nKey }`.

| Check id | Fail or warn when |
|---|---|
| `public_listener` | 5186 is not listening (fail); it is bound to a wildcard while `listeners.public.host` is loopback, which means another process holds it or a forwarder exists (fail) |
| `admin_bind` | 5176 is on a wildcard while ADMIN is not LAN-bound per §3.4 (fail) |
| `wildcard_listeners` | Any platform port (5177, 5178, 5180, 5190, 7000, engine ports) is on `0.0.0.0`/`::` while a firewall profile is off (fail); otherwise warn |
| `firewall_profiles` | Any profile is disabled (warn; fail combined with wildcard listeners) |
| `legacy_proxy` | A process signature matches `manager-public-proxy.js`, `public-port-proxy.js` or `upnp-port-map.js`; or port 55177 is listening; or a netsh portproxy targets 5176–5178 (fail) |
| `tunnel_running`, `tunnel_ready` | No cloudflared container (unknown for the Caddy and LAN topologies); `/ready` not 200 (fail) |
| `tunnel_target` | The generated config, or a parsed legacy `<AI_ROOT>/deploy/cloudflare/Caddyfile`, targets 5177 or 5178: `legacy_tunnel_bypasses_entry` (fail) |
| `external_probe` | The §13.3 probe failed or the nonce was not observed with a trusted forwarded header (fail); hairpin failure (unknown) |
| `tls`, `dns` | Certificate expires in under 14 days (warn); the host does not resolve (fail) |
| `trusted_proxy_match` | The probe arrived from a socket not in `cidrs` (fail, with a one-click "trust <ip>/32" offer) |
| `managers_gateway_only` | Mode `off` (fail), `warn` (warn, showing direct unsigned calls in 24 h) |
| `admin_via_proxy` | Any `admin_via_proxy` event in 24 h (fail) |
| `keys_hygiene` | Keys with wildcard origins, public keys without expiry, keys unused for 30 days (warn) |
| `plaintext_key_files` | `vllm-manager/logs/.last-public-service-key.txt` exists (fail) |
| `router_snapshots` | `<AI_ROOT>/router-*.html` exist (warn; evidence is the file count and the count of `stok=` occurrences, never their values) |
| `upnp` | — (always `manual`) |

Legacy findings (`legacy[]`) are reported only. **Nothing is deleted, moved or stopped.** Each finding is `{ id, relPath, kind: "script"|"config"|"log"|"snapshot"|"secret-file", risk: "high"|"medium", evidence, recommendation: i18nKey, suggestedCommand }`. `suggestedCommand` is a copyable PowerShell `Move-Item` to an archive folder outside the root, for the owner to run. Detected paths: `vllm-manager/{manager-public-proxy.js, public-port-proxy.js, upnp-port-map.js, start-manager-public-proxy.cmd, stop-manager-public-proxy.cmd}`, `vllm-manager/logs/manager-public-proxy-access.log` (counts only), `deploy/cloudflare/` when untracked (`secrets/` is never read), `router-*.html`, and `.last-public-service-key.txt`.

### 13.3 Probe and security APIs

| Method and path | Request → Response |
|---|---|
| `GET /api/public/exposure` | → `{ok, report}` (cached) |
| `POST /api/public/exposure/scan` | → `{ok, report}` (forces a re-scan; read-only) |
| `POST /api/public/probe` | → `{ok, probe: {url, status, latencyMs, observed: {viaProxy, headerUsed, socketIp, country}, tls: {validTo}}}`. Fetches `${baseUrl}/status.json?probe=<nonce>`; PUBLIC records the nonce arrival in memory for 60 s |
| `GET /api/public/templates?topology=cloudflared-token\|cloudflared-config\|caddy\|lan` | → `{ok, files: [{name, content}], commands: [...]}` |
| `POST /api/public/templates/write` | `{topology, overwrite?: false}` → `{ok, written: [relPath]}`. Writes only under `<AI_ROOT>/config/public/` and refuses to overwrite unless asked |
| `GET /api/security/overview?from&to` | → `{authFailures: {series, topIps: [{ip, country, count, banned}]}, bans, topKeys: [{keyId, name, requests, tokens}], anomalies: [...], adminEvents}` |
| `GET /api/security/events?type&cursor` | Telemetry events `security.*` (04) |
| `GET/POST /api/security/bans`, `DELETE /api/security/bans/:subject` | `{subject, kind, reason, expiresAt?}`; audited |

Anomaly rules (simple and explainable):
- `tpm_spike`: a key's tokens in the last hour exceed 5 × its 7-day hourly p95, and at least 50k.
- `new_country`: a country not seen for the key in 30 days.
- `auth_storm`: more than 100 401s in 10 min across IPs.
- `direct_manager_calls`: unsigned direct calls in `warn` mode.

### 13.4 Console page "Customers & Keys" (requirements for 07 CON-20: `console/routes/access/{index,keys,key-detail,clients}.js`, `components/share-card.js`)

07 owns every file under `service-entry/console/`, the page layout and the i18n loader. 05 supplies the APIs (§13.1) and the content below. If a 05 engineer builds these pages, the work is done inside the 07 package, using 07's layout and the `access` i18n area.

- **Tabs**: Keys | Customers (billing customers through `/api/billing/customers`) | Audit.
- **Keys table**: name, holder or customer, class chip, status, models, rpm/tpm, today's tokens, last used (relative, with country), expiry. Filters and search; an "attention" strip for expired, expiring and unused keys.
- **Create drawer**:
  1. Preset cards: Friend, Trial 7 days, Paid, Internal app, Owner device.
  2. Fields grouped as Identity, Access (scopes as plain-language checkboxes, model patterns with live "matches: N models"), Limits (each with help text and an "inherits default" placeholder), Browser access (origins), Expiry.
  3. Create.
- **Share card** (shown once, modal, cannot be reopened):
  - base URLs (OpenAI and Anthropic), the key with a copy button, the recommended model and limits summary, and the expiry;
  - a curl snippet, the portal link `https://…/me#key=…` and its QR (`qrcode` from the shared vendor tree);
  - "Copy invite text" with a zh/en message template;
  - a warning: zh「密钥只显示这一次，关闭后无法再次查看。」/ en "This key is shown only once."
- **Destructive actions**: revoke needs the key name typed back; rotate asks for the overlap; bulk revoke needs `REVOKE n`. All are audited.
- **Key detail**: limits editor, usage charts and recent requests (telemetry, filtered by key, including IP and country for the owner).

### 13.5 Console page "Public access" wizard (requirements for 07 CON-21: `console/routes/access/public.js`)

1. Topology cards with pros and cons:
   - Cloudflare Tunnel, recommended: 「只出站连接，无需开放端口，TLS 与防护在边缘」/ "outbound only, no open ports, TLS and protection at the edge";
   - Caddy plus your domain: needs 80/443 forwarded on the router;
   - LAN only.
2. Base URL: validated `https://` and saved to `listeners.public.baseUrl` through `PATCH /api/public/settings`.
3. Generated files from `/api/public/templates`, with "Write to config/public" and copyable commands. The owner runs them; the platform starts nothing.
4. Keys: ensure at least one active key with `public` listener access, with quick create.
5. Live checks list (§13.2), each with a fix hint, plus "Run external probe".
6. Exposure map: an SVG diagram from `report.map` (Internet → Cloudflare/Caddy → PUBLIC 5186 → engines; LAN → wildcard binds; loopback → ADMIN), with edges coloured by state and evidence on hover.
7. Go live: `public.managersGatewayOnly: enforce` and `admin.legacyProxyGateway: reject`. It lists the clients that called managers directly, or reached ADMIN through a proxy, in the last 7 days and warns that their URLs will stop working.

### 13.6 Console page "Security & audit" (requirements for 07 CON-21: `console/routes/access/security.js`; sessions page `access/sessions.js` per §5.2)

- Auth failures over time (uPlot); top IPs with country and ban state, plus ban and unban actions; active bans.
- Top keys by tokens and requests, with links to key detail.
- Anomalies list.
- Admin audit trail (`access_audit` plus billing admin audit), filterable.
- Legacy findings (§13.2) with "copy suggested command" and an explicit note: zh「平台不会自动删除或停用这些文件，请自行决定。」/ en "The platform never deletes or stops these; you decide."

### 13.7 Acceptance criteria handed to 07 (replacing the retired PUB-21 and PUB-22)

- **CON-20.**
  - Preset create ⇒ the share card shows once, with QR and invite text. Closing it leaves no key in the DOM.
  - Field help appears in zh and en from the `access` area.
  - Revoke needs the typed name, and bulk revoke needs `REVOKE n`.
  - Key detail shows usage and recent requests.
  - English mode has no Han text, and there is no overflow at 390 px.
- **CON-21.**
  - The wizard walks topology → base URL → templates → keys → checks → map → go-live from a stubbed report, and writes templates only on click with `overwrite:false`.
  - Go-live lists direct callers before enforcing.
  - The map renders nodes and edges with evidence.
  - The security view shows bans, top IPs and anomalies; its actions are audited, and bans need confirmation.
  - Legacy findings offer copy only, with no delete control.
  - Sessions: pair-a-device shows the code and QR and forgets them on close, and revoking the current session warns first.
- **Both.** Non-GET calls carry `x-csrf-token`. A 403 `csrf_invalid` re-reads `/api/session` once. The pages are owner-only routes (a viewer sees the PairingScreen).

## 14. Deploy templates (tracked, no secrets)

- **`deploy/cloudflare/`** (new). PUB-20 adds `deploy/cloudflare` to `release-manifest.json` `directories` (after 06 OPS-1) and does not edit `build-github-release.ps1`:
  - `README.md` (zh/en);
  - `compose.yaml`: service `cloudflared`, image `${CLOUDFLARED_IMAGE}` pinned by tag and digest at implementation time, `command: tunnel --no-autoupdate --metrics 0.0.0.0:2000 run`, `env_file: ${PUBLIC_CONFIG_DIR}/cloudflared.env` containing `TUNNEL_TOKEN` (owner-created; never generated), port `127.0.0.1:20241:2000`, `extra_hosts: host.docker.internal:host-gateway`, `restart: unless-stopped`;
  - `config.yml.template` for locally managed tunnels: ingress `- hostname: ${MODEL_API_DOMAIN}` → `service: http://host.docker.internal:5186`, `originRequest: { connectTimeout: 10s, keepAliveTimeout: 90s }`, then `- service: http_status:404`;
  - `cloudflared.env.example`.

  For token tunnels, the README says to set the public hostname service to `http://host.docker.internal:5186` in the dashboard.
- **`deploy/public/Caddyfile`** (rewritten): the model API site reverse-proxies **all paths** to `127.0.0.1:5186`, with `flush_interval -1`, 30 m timeouts and HSTS. The portal is included, and path policy is now enforced by the entry structurally. Caddy sets `X-Forwarded-For` from the real peer, so the matching `trustedProxies` is `clientIpHeader: "x-forwarded-for"`, `cidrs: ["127.0.0.1/32"]`. The WEBUI site is unchanged.
- **`deploy/public/openwebui.compose.yaml`** (fixed):
  - `OPENAI_API_BASE_URL=http://host.docker.internal:5186/v1` with a dedicated `internal-app` key in `MODEL_GATEWAY_API_KEY`;
  - `ENABLE_SIGNUP=false`, `DEFAULT_USER_ROLE=pending`;
  - `ENABLE_FORWARD_USER_INFO_HEADERS=true`. PUBLIC records `x-openwebui-user-id` as a sha256-truncated `endUser` only for keys labelled `app=openwebui`. Verify the variable names on the pinned OpenWebUI version.
- **`scripts/setup-public.ps1`** (rewritten by PUB-20, which owns its content; CRLF, no BOM). 06 OPS-16 only adds the `platform exposure setup` wrapper that invokes it, after PUB-20:
  - it no longer reads `.last-public-service-key.txt` and no longer writes keys to `.env` or prints `setx` lines;
  - it validates the domain and, with `-Apply`, runs `platform config set listeners.public.baseUrl <url>`, `trustedProxies.clientIpHeader` and `trustedProxies.cidrs` (the OPS-3 writer, the only one). Without `-Apply` it prints those commands;
  - it renders templates into `<AI_ROOT>/config/public/` (untracked) and validates Caddy if present.
- Renderer: `service-entry/lib/deploy-templates.js` with `renderTemplates({ topology, baseUrl, config }) -> [{ name, content }]`. It is pure and golden-tested. Placeholders are `${…}` with an allowlist, and domains are validated by the `setup-public.ps1` regex.

## 15. Telemetry and events integration (consumes 04)

- Each request record gains `keyId`, `customerId`, `listener`, `clientIp`, `country`, `endUser`, `clientRequestId`, `principal` (`key` or `console-session`, the latter recorded as client `console`) and `errorCode` (§10.2 code) (contract C5). Managers get these fields only through `verifyEntryRequest` (§7.1). UI polling routes are never recorded (stats finding). PUBLIC portal assets are not recorded.
- Events: `security.auth_failed` (sampled 1/s per IP), `security.ban`, `security.unban`, `security.admin_via_proxy`, `security.direct_manager_gateway`, `security.origin_rejected`, `security.internal_auth_failed`, `access.key_created|rotated|revoked|updated`, `access.settings_changed`. `notification` events go to the console for bans and for keys expiring within 3 days (00 §4.5; type list extension C3).
- `/v1/me/usage` and `/v1/me/requests` call 04 query functions with `filter: { keyId }` and a public-safe projection. Without telemetry they fall back to `key_usage_counters` (day granularity) and an empty requests list with `source: "counters"`.
- `/api/stats`, `/api/gateway-access` and the access-log APIs are unchanged in shape (04 owns them).

## 16. Compatibility and owner migration sequence

| Today | After P5 |
|---|---|
| `https://api.example.com/{vllm,llama}/v1` through the untracked tunnel straight to managers | Works unchanged until the owner repoints the tunnel; afterwards it is served by PUBLIC as aliases with the same keys (migrated hashes) |
| `http://127.0.0.1:5176/gateway/...` | Unchanged (ADMIN listener, same pipeline) |
| `http://<lan>:5176/gateway/...` (`start-service-entry.cmd lan`) | Unchanged (`listeners.admin.lan`); also `http://<lan>:5186/v1` when `listeners.public.host` is `0.0.0.0` |
| `http://127.0.0.1:5177/serve/v1` direct | `warn` mode: works and is logged; `enforce` (owner choice, O1): 403 `gateway_only` |
| Manager key pages | Work through the forwarders (§6.8) until the P7 pages replace them |
| `/gateway/status`, `/gateway/health` | Same shape; the bucket bug (V6) is fixed |
| `SERVICE_ENTRY_ALLOW_LAN_ADMIN=1` | Maps to `admin.allowLanOwner`: LAN reads stay redacted, and LAN writes need a paired session |
| Loopback scripts and tools with no credentials | Reads of registered routes keep working (redacted). `stop-service-entry.cmd` signs the entry shutdown as `system:cli` (PUB-25) until OPS-8 replaces it with `platform stop`. platform-mcp signs as `system:mcp`; an older unsigned build gets the redacted fleet |
| Manager hub shims with `x-hub-shim` (03) | Replaced by the `system:hub-shim:<managerId>` signature; the bare header grants nothing |

Owner steps, shown in the wizard and in `docs/client-setup-guide.md`:
1. Deploy P5. Keys migrate automatically; review the migration report.
2. Run the wizard: write the cloudflared files and repoint the existing tunnel's public hostname to `http://host.docker.internal:5186`. The owner does this step.
3. Run the external probe and confirm `viaProxy` and the observed header.
4. Watch `direct_manager_gateway` events drop to zero, then switch managers to `enforce`.
5. Act on the legacy findings (owner decides).

## 17. Tests

### 17.1 Unit (`node --test`; new files)

- **service-entry/test**:
  - `trusted-proxy.test.js` (extends P0-ENT-1's file): CIDR parsing (v4, v6, mapped), XFF right-to-left skipping, the cf header, a missing header, a **LAN socket with spoofed XFF ⇒ socket IP**, and ADMIN never honouring headers.
  - `public-config.test.js`: reads and writes only through stubbed `readSection`/`writeSection` (an fs spy proves no file I/O in 05 code); each §3.4 env name resolves to exactly its key; `ACCESS_SCHEMA_LEAVES` equals the fragment in OPS-3's schema; etag and 409 `config_conflict` pass through.
  - `admin-session.test.js`: pair codes (single use, TTL); auto-pair conditions (each negated ⇒ no pair; window consumed); CSRF on non-GET with 403 `csrf_invalid`; exact-origin rejection of `http://127.0.0.1:5186`; LAN owner only with `allowLanOwner`; tool-token roles; elevation bound to the session, `Path=/api`, HttpOnly, revoked on logout and session revoke, refused for tokens and machine principals; `pairCommand` selection.
  - `viewer-allowlist.test.js`: deny-by-default; central redaction through `sendJson` (a fixture returning `cwd`, `argv` and an absolute path is stripped); a throwing `redact` ⇒ 500 with no leak; SSE type filtering; the §5.4 inventory scan, which fails on a fixture module with an unregistered GET literal.
  - `machine-auth.test.js`: the principal × route scope matrix (403 `principal_scope_denied`); 61 s skew ⇒ `internal_signature_expired`; a forwarding header or LAN socket ⇒ rejected; body digest mismatch ⇒ 401 before the handler runs (spy); bare `x-hub-shim` ⇒ anonymous viewer; supervisor SSE gets only `status`, `notification`, `platform`, `alerts`.
  - `console-session.test.js`: ADMIN `/gateway/*` with cookie and CSRF ⇒ hop principal `console-session`, `b:null`, telemetry client `console`; missing CSRF on POST ⇒ 403 `csrf_invalid` (OpenAI shape); key header wins; `mcp`/`search` ⇒ `scope_denied`; PUBLIC with the same cookie ⇒ 401 `missing_api_key`.
  - `keys-store.test.js`: CRUD, rotation overlap, revoke is terminal, audit triggers reject UPDATE and DELETE, counters UPSERT across a day and month boundary in the tz offset, and bans with escalation.
  - `key-policy.test.js`: pattern matrix, excludes, fleetAllow, listener, IP and origin, and the wildcard-origin rule.
  - `key-migration.test.js` (golden).
  - `limiter.test.js`: bucket math with a fake clock, tpm reserve and refund, quota period resets, share gate with owner activity (including `console-session`), and header formatting.
  - `public-errors.test.js` (golden table; no message matches `/[A-Z]:\\|\\d{4,5}|SERVICE_ENTRY_|\\.json/`).
  - `usage-tap.test.js`: OpenAI SSE, Anthropic SSE, non-stream, abort keeps partial, bytes unchanged.
  - `public-api.test.js`: route mapping table, `max_tokens` injection and rejection, alias resolution, `/gateway/status` peek.
  - `me-routes.test.js`: the `/v1/me` contract, pace math, same-origin enforcement on writes.
  - `status-sampler.test.js` (golden `/status.json`).
  - `exposure-scan.test.js` (golden parsers from fixtures: listeners JSON, firewall JSON, portproxy text, docker ps lines, cmdline signatures, legacy Caddyfile).
  - `deploy-templates.test.js` (golden).
  - `portal-i18n.test.js`: key parity between the two portal dictionaries; no duplicate keys.
  - `listeners.test.js` (integration; ephemeral ports, fake managers).
- **manager-core/test**:
  - `internal-auth.test.js` (golden `golden/internal-auth.json`): billing-form signatures byte-identical to today's `signBillingRequest` for five fixtures; the four prefixes accepted, others `internal_path_not_allowed`; the machine form binds the query; tampered method, path, query, principal, ts or digest ⇒ reject; `createInternalClient` follows a rotated trust file and retries once.
  - `gateway-trust-v2.test.js`: sign and verify; tampered path, principal, context, ts or request id ⇒ reject; context swap ⇒ reject; `verifyEntryRequest` returns version 0, 1 or 2 with the right nulls; v1 keeps its 5 min window and v2 enforces 60 s.
  - `gateway-only-middleware.test.js`: off, warn and enforce matrices; billing `clientId`/`credentialManagerId` from the principal; `b:null` ⇒ no billing call; access log uses the vouched IP and request id.
  - `legacy-key-forwarder.test.js`: legacy shapes.
- **platform-mcp/test**: entry calls carry a valid `system:mcp` signature (fake entry verifies it), and an unsigned fallback path still parses the redacted fleet.
- **service-entry/test/billing-store.test.js** additions: `credentialManagerId` binding lookup, the reservation column migration, and `getCustomerSummary`.

### 17.2 Integration (`listeners.test.js`)

The test boots the entry with both listeners on port 0, a fake manager (express) that echoes headers, a temporary access store, and a temporary `AI_ROOT`. It asserts:
1. Every ADMIN route (`/api/status`, `/api/keys`, `/billing`, `/internal/billing/authorize`, `/docs/service-runbook.md`, `/gateway/mcp`, `/gateway/tts/`, `/classic`) returns 404 on PUBLIC.
2. A header-less loopback request to PUBLIC can reach only the portal and `/v1/*` (with a key).
3. ADMIN plus XFF on `/api/status` returns 404, and `/gateway/health` plus XFF returns 200.
4. A PUBLIC request with a key reaches the fake manager with a v2 principal, a context header covered by the v2 signature, and **without** the key header.
5. Rate-limit headers are present, and 429 codes are distinct for rpm, tpm, quota and concurrency.
6. CORS preflight and actual request behave per key; no credentials header appears.
7. A browser `Accept` on an unknown PUBLIC path gets an HTML 404; an API client gets JSON.
8. Signed `system:supervisor` `POST /api/manager/shutdown` is accepted (the shutdown hook is stubbed); the same call unsigned returns 401; signed as `system:hub-shim:vllm` it returns 403 `principal_scope_denied`.

### 17.3 Existing tests: kept, rewritten or migrated

| Test | Old assertion | New assertion (package) |
|---|---|---|
| `security.test.js:148` "resolveClientAddress … vouch the forwarded client" | Last XFF from any loopback socket | Rewritten: ADMIN ⇒ socket IP always; PUBLIC from a trusted CIDR ⇒ walked XFF or the cf header; LAN socket plus XFF ⇒ socket IP; `trustHeaders` vouch the resolved ip (PUB-1) |
| `security.test.js:91` LAN admin switch | Loopback is admin; LAN admin via env | Loopback without session is viewer and cannot write; with a session or token it is owner; the env maps to `admin.allowLanOwner` with pairing required (PUB-5) |
| `security.test.js:105` proxied never management | Forwarded ⇒ 403 `management_local_only` | Same outcome on ADMIN (code kept), plus the `admin_via_proxy` event (PUB-6) |
| `security.test.js:127,134` public base URL in Host allowlist / auto key | Public host admitted on 5176 | Public host is **not** admitted on ADMIN and is admitted on PUBLIC; PUBLIC always requires a key (PUB-6) |
| `security.test.js:166` Host and Origin | Hostname-only Origin | Adds exact-port cases: `http://127.0.0.1:5186` is rejected for POST on ADMIN (PUB-5) |
| `security.test.js:197` CORS | Listed origin echoed with credentials | Echo kept for ADMIN env origins; asserts **no** `allow-credentials` (PUB-11) |
| `security.test.js:214,268` gateway auth from manager files | Reads manager JSON | Reads the access store; a corrupt store fails closed with 503 `auth_unavailable` and no file paths in the message (PUB-8) |
| `security.test.js:383` shutdown and status gate | Loopback is allowed | Shutdown needs an owner session plus CSRF, an owner token, or a `system:cli`/`system:supervisor` signature; status stays readable and redacted (PUB-5) |
| `gateway.test.js:172` proxy headers keep auth fields | Key forwarded | Split: v2-capable manager ⇒ key stripped and principal present; legacy manager ⇒ key forwarded (PUB-10) |
| `gateway.test.js:252` docs, billing, forwarded | — | Unchanged except `/billing` now needs an owner session (the test pairs first) (PUB-5) |
| `gateway.test.js:317` keys scoped to manager | `matchedManager` filter | Migrated key `fleetAllow:["vllm:*"]` ⇒ llama route 403 `model_not_allowed`/`manager_forbidden` (code kept on the ADMIN gateway) (PUB-8) |
| `gateway.test.js:632` rate-limits model list | Env rpm=1 ⇒ second request 429 | Unchanged, plus `x-ratelimit-remaining-requests: 0` (PUB-9) |
| `entry-extras.test.js:22,40` public checklist | Env-derived items | Items computed from the config plus a scan fixture; ids kept; `caddy-paths` becomes `proxy-target` (PUB-18) |
| `manager-core/test/security-hardening.test.js:30,113` | v1 trust, XFF ignored for buckets | Unchanged (v1 is kept); v2 is covered in new files |
| `billing-http.test.js`, `billing-store.test.js`, `manager-core` billing-client tests | — | Unchanged; additions only. `billing-client.js` is reimplemented over `internal-auth.js` with byte-identical signatures (PUB-24) |

### 17.4 Playwright (registered per 00 §7.3; once 06 OPS-2 lands, discovered through `testDir`)

- `tests/public-portal.spec.cjs` (PUB-15/16/17). It serves the real `createPublicServer` with fake deps and checks:
  - the status page states operational, degraded and offline from a stubbed fleet;
  - the models page without a key (catalog) and with a key;
  - docs snippets contain the configured base URL and `$API_KEY`, never a real key, unless toggled;
  - My Key paste ⇒ `/v1/me` rendered, the `#key=` fragment is stripped from `location.href`, rotate shows the new key once, and the CSV downloads;
  - the playground streams from a fake SSE upstream and "copy as curl" matches the request;
  - an HTML 404 page;
  - English mode has no Han text outside `code`/`pre`;
  - no horizontal overflow at 390 px;
  - no console errors and no CSP violations (the inline import map passes only through its hash);
  - vendor files load from `/assets/<id>/vendor/<pkg>/<version>/`, and tokens from `shared-public/styles/tokens.css`.
- Existing `tests/billing-page.spec.cjs` and `tests/frontend-smoke.spec.cjs`: add a `/api/session` stub (`{ok:true, role:"owner", csrfToken:"t"}`) and assert that non-GET requests carry `x-csrf-token` (PUB-5).
- The access console pages are tested by 07's `tests/console-access.spec.cjs` (CON-20/CON-21) against the §13.7 criteria.

## 18. Failure modes

| Failure | Behaviour |
|---|---|
| Access store unreadable or corrupt | Entry starts ADMIN; gateway routes return 503 `auth_unavailable` (fail closed); the console shows red; nothing reverts to "no keys" |
| PUBLIC port in use | ADMIN runs; `public_listener` check fails; the event is logged |
| Telemetry store missing | `/v1/me/usage` falls back to counters; status numbers are omitted; enforcement is unaffected |
| Manager not v2-capable | Key forwarded (legacy); platform-only keys get 503 `service_unavailable` |
| Entry down | The tunnel returns the edge 502/530 page (cannot be helped: no status page). Direct manager calls in `warn` with the entry down: billing 503, and the key verify falls back to the legacy file (`off`) or denies (`warn`/`enforce`) |
| Clock skew > 60 s between processes | They share one machine; if the v2 verify fails, the manager treats the hop as untrusted and returns 403/401 (the log names `signature_expired`) |
| Long non-stream generations behind Cloudflare | The edge may answer 524 after about 100 s; docs advise `stream: true` |
| Trust token file unreadable, or stale during an entry restart | Machine principals get 401 `internal_signature_*`. `createInternalClient` re-reads the file and retries once. The supervisor falls back to its process-level stop. Launcher pairing is unavailable, but first-run auto-pair and "Pair a device" from a paired browser still work |
| A route module forgot to register a viewer route | Viewers get 401 on it (deny by default), and `viewer-allowlist.test.js` fails in CI |
| OPS-3 writer refuses a settings write (`config_invalid`, `config_conflict`) | `PATCH /api/public/settings` returns the same code and `errors[]`; nothing is half-written |
| Exposure scan command missing or times out | That check reports `unknown`, with the reason |
| Key migration warnings | The entry still starts; the warnings show in the console banner until acknowledged |

## 19. Contract changes requested

To **00**:
- **C1 §3 Identifiers.**
  - Add `keyId`: `k_<20 base32>` for new keys, `<managerId>.<clientId>` for migrated keys, `<managerId>.global` for converted global keys.
  - Add the billing principal `(billingScope, billingClientId)`, where `billingScope ∈ {<manager billing id>, "platform"}`, and `ttsOwner`.
  - Add machine principals `system:(hub-shim:<managerId>|supervisor|cli|mcp)` and the gateway principal `console-session`.
  - On PUBLIC, `requestId` is always generated by the entry; a client-supplied id is kept as `clientRequestId`. 00 §3 says "when absent".
- **C2 §4.2.** Public errors on Anthropic-protocol routes use the Anthropic shape, and browsers get HTML error pages (§10). The §10.2 taxonomy becomes the shared public code list. The admin codes `admin_session_required`, `csrf_invalid`, `principal_scope_denied` and `internal_signature_invalid|expired` are added.
- **C3 §4.5.** Add event types `security` and `access`. Viewer streams carry only types registered in the viewer registry (§5.4), and machine principals get their fixed type sets (§5.7).
- **C4 §5.**
  - Trust hop v2 is the only signed entry→manager hop. It carries `x-service-entry-principal` and `x-service-entry-context` (04's fields), both covered by `x-service-entry-signature-v2`. `GET /api/manager/health` adds `gatewayTrust: {version, mode}`, and managers get gateway-only modes `off|warn|enforce`.
  - Internal auth is one module (`manager-core/internal-auth.js`) with the prefixes `/internal/billing/`, `/internal/access/`, `/internal/telemetry/` and `/internal/models/` for manager principals, and the machine form on ADMIN `/api/*`. Its key is the entry trust token.
  - `checkManagementAccess` becomes session-based (`owner`/`viewer`/`system`). "LAN viewers get read-only access with redaction" is implemented by the viewer-access registry, and every route-owning spec lists its registrations.
- **C6 §2 layout.**
  - New `service-entry/lib/` modules: `listeners.js`, `public-config.js`, `trusted-proxy.js`, `admin-session.js`, `machine-auth.js`, `viewer-allowlist.js`, `key-policy.js`, `key-migration.js`, `limiter.js`, `public-errors.js`, `gateway-pipeline.js`, `usage-tap.js`, `me-routes.js`, `status-sampler.js`, `access-routes.js`, `exposure-scan.js`, `deploy-templates.js`.
  - `service-entry/scripts/{admin-pair,entry-call}.js`; `manager-core/internal-auth.js`; `manager-core/legacy-key-forwarder.js`.
  - The untracked `<AI_ROOT>/config/public/` and the runtime file `service-entry/data/platform-access.sqlite`. There is no `admin-cli-token.dpapi`.
  - `shared-public/styles/tokens.css` (07) replaces the `shared-public/js/tokens.css` reference.
- **C9 §6 must-keep.** Manager `/api/service-clients*` stay but become forwarders (§6.8). The legacy files stay readable and are never rewritten. `SERVICE_ENTRY_ALLOW_LAN_ADMIN` maps to `admin.allowLanOwner`, and LAN writes need pairing.

To **06** (resolutions 1, 2, 6 and 8):
- **C7a, config (OPS-3).**
  - OPS-3 is the sole owner of the schema, the env map and the writer. It exports `readSection(name) -> { value, sources, etag, errors }` and `writeSection(name, patch, { etag }) -> { ok, etag, changed, restartRequired, errors }` over `writePlatformConfig`.
  - Delete `entry.port/host`, `exposure.lan`, `exposure.allowLanAdmin` and `exposure.public.*`. Keep `exposure.requireApiKey` and `exposure.allowedOrigins` as 06 leaves. Merge 05's leaves and env names from §3.4, with each env name used once. The doctor and readiness `exposure` rules read `listeners.admin.lan`, `listeners.public.enabled` and `listeners.public.baseUrl`, and `platform start --lan` sets the runtime override `listeners.admin.lan`.
  - OPS-3 lands in wave 1, before PUB-1, PUB-23 and TEL-*.
  - The registry's `entry` ports reference `${config:listeners.admin.port}`, `${config:listeners.admin.host}`, `${config:listeners.public.port}` and `${config:listeners.public.host}`. `PLATFORM_MCP_SERVICE_ENTRY_URL` derives from `listeners.admin.port`.
  - `managers.bindHost` ends at default `127.0.0.1`. PUB-23 makes that one-line schema edit, and nobody edits `start-service-entry.cmd` for it.
  - Add `console.defaultUi` (07's request).
- **C7b, CLI and supervisor.**
  - `platform admin pair [--open]` wraps `service-entry/scripts/admin-pair.js`; `platform open` and `platform start` use it to pair the browser.
  - `platform keys migrate [--dry-run]` calls `POST /api/access/migration/{plan,apply}`.
  - `platform exposure scan` calls `POST /api/public/exposure/scan` and prints the checks. `platform exposure setup` wraps `scripts/setup-public.ps1` (OPS-16, after PUB-20).
  - The CLI signs as `system:cli`, and the supervisor signs its entry calls (`/api/manager/shutdown`, `/api/platform/busy`, `/api/events?client=supervisor`) as `system:supervisor`, both through `createInternalClient`. `/api/platform/busy` changes from "loopback-only" to "`system:supervisor` or owner".
  - The registry gains `service-entry-public`: kind `listener` of process `entry`, with no start or stop of its own, health `GET http://127.0.0.1:${config:listeners.public.port}/healthz`, and readiness layer `exposure`.
- **C7c, build id (OPS-10).** `getBuildId(aiRoot) -> { commit, contentHash }` is the single source. `contentHash` covers the static trees the entry serves (`service-entry/console`, `service-entry/portal`, `shared-public/vendor`, `shared-public/styles`) and is recomputed when an mtime changes (throttled to 2 s). 07 and the portal template it.
- **C7d, secret store.** `createPlatformSecretStore` lists the entry trust token (`<AI_ROOT>/.gateway-trust.json`) read-only as the platform's internal HMAC secret and never stores a second copy. Doctor checks its ACL.
- **C7e, release.** PUB-20 adds `deploy/cloudflare` to `release-manifest.json` `directories`.

To **03**: the hub client (`model-hub/client.js`, HUB-13a) signs with `createInternalClient({ principal: "system:hub-shim:<managerId>" })` and drops `x-hub-shim`. HUB routes register their GET reads in the viewer registry, with path redaction. Hub copy goes in the console i18n area `hub`.

To **04**:
- TEL-2 consumes `verifyEntryRequest` and `buildEntryHeaders({ context })` from PUB-10. It drops `x-service-entry-context-signature`, `kid` and its own skew window, and does not edit `gateway-trust.js`.
- TEL-6 uses `createInternalClient({ managerId })` for `/internal/telemetry/*` and does not touch `billing-client.js` path normalisation.
- `PUT /api/telemetry/settings` imports `writeSection` from OPS-3.
- Audit content routes use the 05 elevation cookie (`issueElevation`/`checkElevation`) instead of a page-held token.
- Telemetry and gateway-access reads register in the viewer registry.
- Request records carry the C5 fields plus `principal`.
- **C5.** Query functions accept `filter.keyId` and a `publicProjection`. The recorder exposes the parsed usage on finish (§8.6).

To **07** (resolutions 4, 5, 6, 7 and 9):
- CON-20/CON-21 build the §13.4–13.6 pages under `console/routes/access/*` and adopt the §13.7 acceptance criteria. PUB-21 and PUB-22 are retired.
- Access copy goes in `console/i18n/access/{zh-CN,en-US}.json`.
- The playground and voice pages send no key on ADMIN and rely on `console-session`. They handle 403 `csrf_invalid` with one retry, and show a key field only when the gateway answers 401.
- CON-1's vendor tree is served at 5186 too, and tokens live in `shared-public/styles/tokens.css`. The console snapshot templates `getBuildId().contentHash` instead of computing its own id.
- 07 registers its own viewer routes (§5.4), and the CON-0 proxy relies on `guard` for viewer denial and redaction.

To **01 and 02**: register their entry GET routes in the viewer registry, each with a redaction function. 02's `/internal/models/` callers use `createInternalClient`. **C8 (02):** the ModelCard exposes an optional `controls.reasoningToggle {on, off}` request patch, used by the playground and `/v1/models`.

To **08**: P0-ENT-1 precedes PUB-1 (same files: `security.js`, `billing-http.js`, `trusted-proxy.test.js`). P0-OBS-3 precedes PUB-10.

## 20. Open decisions for the owner

- **O1.** When to switch managers to `enforce`. Default `warn`. Enforcing breaks direct `:5177/:5178` clients, including the current tunnel until it is repointed.
- **O2.** Bind managers to `127.0.0.1` by default (PUB-23, the OPS-3 schema default `managers.bindHost`). This ends LAN access to the legacy manager UIs; LAN goes through 5176 instead. Containers keep reaching the managers, because Docker Desktop delivers `host.docker.internal` as loopback. Opt back in with `platform config set managers.bindHost 0.0.0.0`.
- **O3.** Whether the catalog and status list model names without a key. Default `publish: ["*"]`.
- **O4.** Whether public requests may wake or cold-start models. Default no.
- **O5.** Search, MCP and TTS cloning for public keys. Default: MCP and cloning are structurally ADMIN-only, and search is off.
- **O6.** Audience. The spec assumes owner-issued keys (friends and customers) and no self-signup or magic links.
- **O7.** Legacy files in the live root (the proxies, `router-*.html` with session tokens, the plaintext key file, the untracked `deploy/cloudflare`). The platform only reports them. Should they be archived, and should exposed keys be rotated as a precaution?
- **O8.** Session lifetime (180 days) and the first-run auto-pair window (30 min).
- **O9.** Accepting that LAN writes need pairing as well as `admin.allowLanOwner` (a behaviour change for `SERVICE_ENTRY_ALLOW_LAN_ADMIN=1`).
- **O14.** Machine principals and the launcher authenticate with the entry trust token (an ACL-restricted file) instead of a separate DPAPI-protected CLI token. This means one secret and fewer moving parts. The trade-off: DPAPI would additionally protect against offline disk reads.
- **O10.** Manager "open" CORS migrates to deny. Browser-based clients need their origins added to the key.
- **O11.** Public share defaults: 4 concurrent, dropping to 2 while the owner is active.
- **O12.** Retention of public IP metadata (telemetry raw 30 days) and the privacy-page wording, including the OpenWebUI audit export notice.
- **O13.** Converted global keys lose the cross-tenant TTS access that global keys have today.

## 21. Work packages

The packages are listed in landing order; ids are stable. Every package runs `npm test` in the packages it touched plus `test-all.cmd`. Each follows 00 §7: the release allowlist (`release-manifest.json` once OPS-1 lands), CRLF for `.cmd`/`.ps1`, the privacy scan, and zh/en copy.

Cross-spec prerequisites:
- OPS-3 lands in wave 1, before PUB-1, PUB-23 and every TEL-* package.
- PUB-24 has no prerequisites. It should land in wave 1 as well, because 03 HUB-13a and 04 TEL-6 consume it.
- PUB-21 and PUB-22 are retired; their acceptance criteria moved to 07 CON-20 and CON-21 (§13.7).

| id | title | files touched / created | depends_on | size | acceptance |
|---|---|---|---|---|---|
| PUB-24 | Internal auth: one signing scheme for local calls | new `manager-core/internal-auth.js`; `manager-core/billing-client.js` (names kept, implemented over it); `service-entry/lib/billing-http.js` (verify through it); new `manager-core/test/internal-auth.test.js` with `golden/internal-auth.json` | — | M | Billing-form signatures are byte-identical to today's for five fixtures, and every existing billing test passes unchanged. `verifyInternalRequest` accepts exactly the four prefixes and rejects others with `internal_path_not_allowed`. The machine form binds the query. Tampering with method, path, query, principal, ts or body digest is rejected, and skew above 60 s gives `internal_signature_expired`. `createInternalClient` follows a rotated trust file and retries once on 401. No token appears in any thrown message or log line. |
| PUB-1 | Access config adapter and trusted-proxy foundation | new `service-entry/lib/public-config.js`, `service-entry/lib/trusted-proxy.js`; `manager-core/data/platform-config.schema.json` (05 leaves only, §3.4); `service-entry/lib/security.js` (`resolveClientAddress` delegates); tests `trusted-proxy.test.js` (extends P0-ENT-1's), `public-config.test.js`; rewrite `security.test.js:148` | OPS-3, P0-ENT-1 | M | The §4 matrix passes, including a LAN socket with spoofed XFF ⇒ socket IP and ADMIN never honouring headers. `loadAccessConfig` reads only through `readSection`, and `updateAccessSection` writes only through `writeSection` with the etag (an fs spy proves no file I/O in 05 code). OPS-3's schema test passes with the 05 leaves: unique env names and bilingual titles. Every §3.4 env name resolves to its key. Invalid values become `issues[]`. The security and gateway suites stay green. |
| PUB-2 | Access store and key policy | new `service-entry/lib/keys-store.js`, `service-entry/lib/key-policy.js`; tests `keys-store.test.js`, `key-policy.test.js` | — | L | The §6.1 schema, including `admin_elevations`, is created idempotently. The audit table rejects UPDATE and DELETE. Hash lookup works for current and previous keys within the overlap. Counter period rollover works in the tz offset. Ban escalation and decay work. The pattern, exclude, fleetAllow, origin and IP matrix passes. No API returns a hash, as asserted over every exported read. |
| PUB-3 | Billing principal support | `service-entry/lib/billing-store.js` (`credentialManagerId`, column migration, `getCustomerSummary`); `service-entry/lib/billing-http.js` (accept `platform` bindings); `billing-store.test.js` additions | PUB-24 | S | Binding lookup uses `credentialManagerId` while price resolution uses the serving manager. The reservation identity check includes it. The ALTER is idempotent on an existing database fixture. All existing billing tests pass unchanged. |
| PUB-4 | Legacy key migration and compat summaries | new `service-entry/lib/key-migration.js`; `service-entry/server.js` (run at start; `/api/keys` from the store; `MANAGERS[].billingId`); `service-entry/test/key-migration.test.js` plus `golden/key-migration.json` | PUB-2, PUB-3 | M | The golden fixture covers two managers, duplicate ids across managers, a duplicate hash, an odd id, a disabled client, an expired client, a global key and a bound customer, and produces exactly the expected rows and warnings. The legacy files are byte-identical after the run, and a re-run is a no-op. `planKeyMigration` is callable without applying it. `/api/keys` keeps its shape (the entry-extras key-overview test passes). |
| PUB-25 | Viewer-access registry and machine principals on ADMIN | new `service-entry/lib/viewer-allowlist.js`, `service-entry/lib/machine-auth.js`, `service-entry/scripts/entry-call.js`; `service-entry/server.js` (pre-dispatch guard, body pre-read into `req.rawBody`, `sendJson` applies `res.req.viewer`, 05 baseline registrations, `redactFleetForViewer`; route modules already present are registered admin-only under their owner's tag); `stop-service-entry.cmd` (signs the 5176 shutdown through `entry-call.js`; CRLF); `platform-mcp/src/{entry-auth.ts, platform-client.ts}` plus a platform-mcp test; tests `viewer-allowlist.test.js`, `machine-auth.test.js` | PUB-24 | L | LAN viewers are denied by default, and registered routes are redacted centrally (a fixture with `cwd`, `argv` and an absolute path is stripped). The inventory scan fails on a fixture module with an unregistered GET literal and passes on the real tree. The machine-principal matrix of §5.7 passes, including: a bare `x-hub-shim` header grants nothing; a body digest mismatch returns 401 before the handler runs; out of scope returns 403 `principal_scope_denied`; supervisor SSE carries only its types. `stop-service-entry.cmd` stops a fixture entry that requires signatures. The fake entry sees `system:mcp` from platform-mcp, and the MCP tests pass. Loopback without credentials is still owner in this package; PUB-5 flips it. |
| PUB-5 | Admin sessions, pairing, CSRF, elevation; loopback becomes viewer | new `service-entry/lib/admin-session.js`, `service-entry/scripts/admin-pair.js`; `service-entry/server.js` (session routes; `checkManagementAccess` and `guard` compose machine auth and the registry); `security.js` `checkRequest` (exact origin); `service-entry/index.html`, `billing.html` (CSRF header, pairing overlay with `pairCommand`, `csrf_invalid` retry); tests `admin-session.test.js` plus rewrites of `security.test.js:91,166,383`, `gateway.test.js:252`; Playwright stubs in `billing-page.spec.cjs`, `frontend-smoke.spec.cjs` | PUB-1, PUB-2, PUB-25 | L | Every write without an owner credential returns 401 `admin_session_required`; a session write without a valid `x-csrf-token` returns 403 `csrf_invalid`; a POST with Origin `http://127.0.0.1:5186` returns 403. Auto-pair fires only under the §5.2 conditions and only once. Pair codes are single use with a TTL, and a LAN session is owner only with `allowLanOwner`. `admin-pair.js` prints only a `#pair=` URL. The elevation cookie is HttpOnly, SameSite=Strict, `Path=/api`, bound to its session and revoked on logout. After the flip, the `system:*` principals and platform-mcp GETs still work (integration), and the classic console and billing page work after pairing (Playwright). No cookie, CSRF token or pair code appears in logs (grep test over captured stdout). |
| PUB-6 | Listener split and PUBLIC router skeleton | new `service-entry/lib/listeners.js`, `service-entry/lib/public-listener.js`; `service-entry/server.js` (`createPublicServer`, `startListeners`, ADMIN forwarded-header policy, Host rules from `listeners.*` and `admin.extraHosts`); test `listeners.test.js` (structural part) plus rewrites of `security.test.js:105,127,134` | PUB-1, PUB-5 | M | The entry binds 127.0.0.1:5176 and 127.0.0.1:5186; `listeners.admin.lan` and a wildcard `listeners.public.host` bind wildcards. Every ADMIN route returns 404 on PUBLIC (§17.2 item 1). `/healthz` and `/gateway/health` work. A PUBLIC bind failure leaves ADMIN up. The public host is rejected on ADMIN with 403 `host_not_allowed`. ADMIN with XFF on non-gateway paths returns 404 and emits an event. `admin.legacyProxyGateway` serve and reject behave as specified. PUBLIC deletes `cookie`. |
| PUB-7 | Public error taxonomy and content negotiation | new `service-entry/lib/public-errors.js`, `service-entry/portal/error.html`; test `public-errors.test.js` plus `golden/public-errors.json` | — | S | Every code in §10.2, `csrf_invalid` included, renders the OpenAI and Anthropic shapes with the status and headers in the golden file. No message leaks a path, port or env name (regex test). HTML is chosen only under the `wantsHtml` rule, and the error page has no script and escapes all values. |
| PUB-8 | Shared gateway pipeline: platform keys and `console-session` | new `service-entry/lib/gateway-pipeline.js`; `service-entry/server.js` (`proxyGatewayRequest` delegates); `service-entry/lib/model-fleet.js` (`filterCandidate`); `security.js` (`authorizeGatewayRequest` from the store); test `console-session.test.js`; rewrites of `security.test.js:214,268`, `gateway.test.js:317` | PUB-2, PUB-5, PUB-6, PUB-7 | L | ADMIN `/gateway/*` behaviour is unchanged for keyless loopback and migrated keys, and all existing gateway tests pass (with the §17.3 rewrites). Scopes, model patterns and fleetAllow are enforced with the §10.2 codes. `console-session` works on ADMIN only, with the §5.8 scopes, CSRF on non-GET, key precedence and client `console`; PUBLIC ignores the cookie. A corrupt store returns 503 `auth_unavailable`. `x-request-id` is returned on every response. `x-local-ai-route` is sent only with `debug.route` or on ADMIN loopback. |
| PUB-9 | Unified limiter | new `service-entry/lib/limiter.js` (buckets, pre-auth, persistent bans, quotas, share gate, headers); `gateway-pipeline.js` wiring; `server.js` (replace `entryRateBuckets` and `authGuard` use); test `limiter.test.js`; `gateway.test.js:632` header assertion | PUB-8 | L | Fake-clock tests cover rpm and tpm refill, tpm reserve and refund, `request_exceeds_tpm`, and daily and monthly reset in the tz offset. They also cover the share gate dropping to `ownerActiveMaxConcurrent` while owner or `console-session` traffic is in flight, and bans persisting across a store reopen with escalation. Distinct codes and headers are present (§9.6). Trusted-proxy and loopback sockets are never banned. |
| PUB-10 | Trust hop v2 with the entry context, gateway-only managers, internal access | `manager-core/gateway-trust.js` (`buildEntryHeaders`, `verifyEntryRequest`; `resolveRequestOrigin` uses it); new `manager-core/legacy-key-forwarder.js`; `manager-core/gateway-utils.js` (middleware modes; vouched IP and request id in the access log); `vllm-manager/server.js`, `llama-manager/server.js` (health field, forwarders injected, `readSection("public")` for the mode); `service-entry/lib/access-routes.js` (internal endpoints only); tests `gateway-trust-v2`, `gateway-only-middleware`, `legacy-key-forwarder`; rewrite `gateway.test.js:172` | PUB-8, PUB-4, PUB-24, P0-OBS-3, OPS-3 | L | Tampering with the v2 path, principal, context, ts or request id is rejected, a context swap is rejected, and v1 still works. `verifyEntryRequest` returns version 0, 1 or 2 with principal and context only on a verified v2 hop. A fixture proves 04 can attach its context through `buildEntryHeaders({ context })` without editing the module. The §7.2 off/warn/enforce matrix passes. On a v2 hop, billing receives the principal's `clientId` and `credentialManagerId`, `b:null` skips billing, and the key header is absent upstream. Legacy manager UI CRUD returns the legacy shapes through the entry. Manager access-log rows carry the vouched IP and `x-request-id`. The golden argv tests of other workstreams are unaffected. |
| PUB-11 | Usage tap, counters, per-key CORS | new `service-entry/lib/usage-tap.js`; `gateway-pipeline.js` (tap, counters, `touchKey`, telemetry record with `principal`); CORS in `public-listener.js`/`security.js` (no credentials); tests `usage-tap.test.js`, CORS cases; `security.test.js:197` update | PUB-8, PUB-9 | M | The tap does not alter bytes (hash equality). Usage is parsed for OpenAI SSE, Anthropic SSE and JSON, and an abort keeps partial counts. The tpm refund is applied. Counters are updated once per request. Preflight and actual CORS follow §11, and `allow-credentials` and `allow-private-network` never appear. |
| PUB-12 | Public API surface | new `service-entry/lib/public-api.js`; `public-listener.js` routes (`/v1/*`, `/anthropic/v1/*`, `/v1/messages`, `/vllm/v1`, `/llama/v1`, `/gateway/*`, audio speech); `/gateway/status` fix; enriched models; test `public-api.test.js` plus `golden/v1-models.json`; `listeners.test.js` items 4–8 | PUB-9, PUB-10, PUB-11 | L | The route mapping table passes. Enriched `/v1/models` matches the golden output and has no engine, port or instance fields. `max_tokens` injection and rejection work. Aliases preserve the engine filter. Anthropic routes return Anthropic error shapes. The integration test proves the request reaches the fake manager with the principal and context and without the key. `/gateway/status` no longer consumes a token, and its models are filtered. |
| PUB-13 | `/v1/me` family | new `service-entry/lib/me-routes.js`; `public-api.js` wiring; `billing-store.getCustomerSummary` use; test `me-routes.test.js` | PUB-12, PUB-3 | M | The `/v1/me` JSON matches the §8.5 schema (schema test). Pace and projection math hold at period edges. `usage` comes from telemetry when present and from counters otherwise. Rotate and origins require their scope, same-origin and a rate limit, and are audited. The CSV is BOM-prefixed and formula-escaped. The meta bucket is separate from rpm. |
| PUB-14 | Status sampler, catalog and announcements backend | new `service-entry/lib/status-sampler.js`; store tables in use; `public-listener.js` (`/status.json`, `/catalog.json`, `/announcements.json`, `/portal-config.json`); test `status-sampler.test.js` plus `golden/status-json.json` | PUB-6, PUB-2 | M | The state rules (operational, degraded, offline, maintenance) are covered by fixtures. Numbers are bucketed. Publish and hidden filters apply. No internals appear (regex for ports, paths and manager ids). 30-day pruning works. 15 s caching works. |
| PUB-15 | Portal shell, status, models and announcements pages | `service-entry/portal/{index.html, app.js, pages/status.js, models.js, model.js, announcements.js, components/*, lib/{api,format}.js, styles/portal.css, i18n/*.json}`; `public-listener.js` (asset snapshot keyed by `getBuildId().contentHash`, import map from `VENDOR.json`, CSP hash, 410 for stale ids); `service-entry/test/portal-i18n.test.js`; new `tests/public-portal.spec.cjs` (status and models parts) | PUB-14, CON-1, CON-3, OPS-10 | L | The pages render from stubbed APIs in zh and en, use `shared-public/styles/tokens.css`, and handle light and dark. Vendor files come only from 07's versioned tree; nothing is vendored here. The CSP has no violations, and the import map passes only through its hash. English mode has no Han text. There is no overflow at 390 px. Static serving rejects traversal and anything not in the snapshot. The previous build id is served, and older ids get 410. |
| PUB-16 | Portal docs, snippets data and error pages | `service-entry/portal/{pages/docs.js, lib/md.js, lib/snippets.js, docs/*.md, data/client-snippets.json}`; error-page polish; Playwright docs cases | PUB-15, PUB-7 | M | Every required client in §12.4 has a snippet carrying `asOf` and `versionTested`. Snippets inject `portal-config` URLs and `$API_KEY` by default. The errors page is generated from the taxonomy. The markdown renderer escapes HTML (XSS sentinel test). The privacy page lists the logged fields. |
| PUB-17 | Portal My Key and playground | `service-entry/portal/{pages/me.js, pages/playground.js, lib/sse.js, components/{gauge,usage-chart}.js}`; Playwright cases | PUB-15, PUB-13 | L | Pasting a key stores it in sessionStorage only. The `#key=` fragment is stripped. The gauges, pace bars, charts and recent-requests table render from stubs. Rotate shows the key once. The origins editor validates. The playground streams and can be stopped, and it shows TTFT, tok/s and cost. "Copy as curl" equals the sent request, and the key is not included unless toggled. |
| PUB-18 | Admin access APIs and compat security view | `service-entry/lib/access-routes.js` (keys CRUD, presets, migration report, `migration/plan`, `migration/apply`, audit, settings through `updateAccessSection` with `If-Match`, announcements, model meta); `/api/security` compat mapping; `entry-extras.test.js` rewrite; new `access-routes.test.js` | PUB-4, PUB-5, PUB-14 | M | Every route enforces owner plus CSRF, or `system:cli` where §5.7 allows it, and is audited without secrets. Create returns the secret once and the share block. Revoke requires the typed name, and bulk revoke requires `REVOKE n`. `migration/plan` has no side effects, and `apply` is idempotent. Settings PATCH validates, passes `config_conflict` through on a stale etag, and reports `restartRequired`. The `/api/security` and `/api/keys` shapes are unchanged for the classic console. |
| PUB-19 | Exposure scan, probe and legacy detection | new `service-entry/lib/exposure-scan.js`; `access-routes.js` (`/api/public/exposure`, `scan`, `probe`, `/api/security/*`); PUBLIC nonce recorder; fixtures plus `golden/exposure-scan/*.json`; test `exposure-scan.test.js` | PUB-6, PUB-18 | L | The parsers match the goldens for every fixture. Command lines are never returned (test). Every check in §13.2 is produced, with `unknown` on timeout or an unsupported platform. Legacy findings list paths relative to `<AI_ROOT>` with no write operations (an fs spy asserts read-only). The probe records `viaProxy` and `headerUsed`. Running on non-Windows returns `unsupported` without throwing. |
| PUB-20 | Deploy templates and setup script | new `deploy/cloudflare/{README.md, compose.yaml, config.yml.template, cloudflared.env.example}`; rewritten `deploy/public/{Caddyfile, openwebui.compose.yaml, README.md, .env.example}`; new `service-entry/lib/deploy-templates.js`; rewritten `scripts/setup-public.ps1` (CRLF; content owned here); `release-manifest.json` (`directories` += `deploy/cloudflare`); `access-routes.js` (`/api/public/templates[/write]`); goldens; `docs/client-setup-guide.md`, `docs/billing-guide.md` | PUB-19, OPS-1, OPS-7a | M | The rendered templates match the goldens. Caddy and cloudflared target 5186 only. No secret or real domain appears in tracked files (privacy scan). `setup-public.ps1` no longer reads the plaintext key file or prints `setx`, writes settings only through `platform config set` with `-Apply`, and passes the `checkps1` syntax check. `build-github-release.ps1` is untouched, and the release manifest test passes. Template writes go only to `config/public/` and never overwrite without the flag. The docs describe the §16 owner sequence. |
| PUB-23 | Manager loopback bind default and enforce switch | `manager-core/data/platform-config.schema.json` (`managers.bindHost` default `127.0.0.1`, one line); `vllm-manager/server.js`, `llama-manager/server.js` (re-read `public.managersGatewayOnly` through `readSection` at most every 10 s); docs (O2) | PUB-10, PUB-19, OPS-3, OPS-8 | S | With an empty `platform.json`, `childEnv` gives both managers `*_MANAGER_HOST=127.0.0.1`, and a fixture start shows them on loopback only. `start-service-entry.cmd` is not edited by this package. Switching to `enforce` through `PATCH /api/public/settings` takes effect within 10 s without a restart. `platform config set managers.bindHost 0.0.0.0` restores LAN manager access. The scan fixture reports `wildcard_listeners` ok. |
