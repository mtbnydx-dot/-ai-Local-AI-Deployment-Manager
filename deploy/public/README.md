# Public deployment

This deployment keeps OpenWebUI, the managers, and model containers on loopback/private networking. Native Caddy is the only public listener and terminates TLS automatically.

1. Point `WEBUI_DOMAIN` and `MODEL_API_DOMAIN` DNS records at this host.
2. Copy `.env.example` to `.env` and set the domains and the manager gateway API key.
3. Configure the manager service exposure to require the same API key.
4. Run OpenWebUI with `docker compose --env-file .env -f openwebui.compose.yaml up -d`.
5. Start native Caddy from this directory with `caddy run --envfile .env --config Caddyfile`.

Keep ports `3000`, `5176`, `5177`, `5178`, `8000`, and `8080` closed at the router/firewall. Caddy owns public ports 80/443. The proxy preserves WebSockets and disables response buffering for SSE through `flush_interval -1`; upstream timeouts are 30 minutes.

Set `SERVICE_ENTRY_PUBLIC_BASE_URL=https://models.example.com` and `SERVICE_ENTRY_ALLOWED_ORIGINS=https://chat.example.com` before starting service-entry. Model containers should use local network mode; clients use the manager/service-entry gateway instead of a direct model port.
