# Public deployment

This deployment keeps OpenWebUI, the managers, and model containers on loopback/private networking. Native Caddy is the only public listener and terminates TLS automatically.

1. Point `WEBUI_DOMAIN` and `MODEL_API_DOMAIN` DNS records at this host.
2. Run `scripts\setup-public.ps1 -ModelApiDomain models.example.com -WebUiDomain chat.example.com` from the platform root. It writes `deploy\public\.env`, validates the Caddyfile when `caddy` is on PATH, and prints the environment the entry needs. Add `-ApiKey <key>` to seed the key (otherwise the last public service key file is used), `-DryRun` to only print.
3. Configure the manager service exposure to require the same API key (the manager "对外服务" page).
4. Run OpenWebUI with `docker compose --env-file .env -f openwebui.compose.yaml up -d`.
5. Start native Caddy from this directory with `caddy run --envfile .env --config Caddyfile`.
6. Start the entry with `SERVICE_ENTRY_REQUIRE_API_KEY=1`, `SERVICE_ENTRY_PUBLIC_BASE_URL=https://models.example.com` and `SERVICE_ENTRY_ALLOWED_ORIGINS=https://chat.example.com` set, then open the entry page: the "公网模式" banner lists the go-live checklist and stays red until every automatic item passes.

Only `/gateway/*` is proxied on the model API domain; every other path answers 404 at Caddy, and the entry independently refuses non-gateway paths on proxied requests. Clients get one surface for everything: `/gateway/auto/openai/v1` (models), `/gateway/tts/openai/v1` (speech), `/gateway/search/v1` (search-augmented chat), `/gateway/mcp` (MCP, read-only) and `/gateway/status` (per-key status: models, rate-limit remaining, quotas).

Keep ports `3000`, `5176`, `5177`, `5178`, `5180`, `5190`, `7000`, `8000`, and `8080` closed at the router/firewall. Caddy owns public ports 80/443. The proxy preserves WebSockets and disables response buffering for SSE through `flush_interval -1`; upstream timeouts are 30 minutes.

Abuse controls at the entry: per-client rate limit (`SERVICE_ENTRY_RATE_LIMIT_RPM`, default 600/min), and an authentication-failure guard that bans a source address after `SERVICE_ENTRY_AUTH_FAIL_LIMIT` (default 20) failed attempts within `SERVICE_ENTRY_AUTH_FAIL_WINDOW_SECONDS` (60) for `SERVICE_ENTRY_AUTH_BAN_SECONDS` (600). Banned sources receive 429 with `Retry-After`; local, non-proxied callers are never banned.
