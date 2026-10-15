# Public deployment / 公网部署

Templates for exposing the PUBLIC listener (port 5186). Nothing here starts by itself; the platform only renders files, you run them. Keys, tunnel tokens and domains never live in tracked files.

模板用于把 PUBLIC 监听（5186）暴露到公网。平台只渲染文件，由你自己运行；密钥、隧道令牌和域名不会写入受版本控制的文件。

## Owner sequence / 上线顺序

1. Deploy the platform and review the key migration report. / 部署平台，查看密钥迁移报告。
2. Render the files (`scripts\setup-public.ps1 -ModelApiDomain <domain> -Topology caddy|cloudflared-token|cloudflared-config|lan`, or the console "Public access" wizard). They land in `<AI_ROOT>/config/public/` and existing files are never overwritten unless you pass `-Overwrite`. Settings (`listeners.public.baseUrl`, `trustedProxies.*`) change only with `-Apply`, through `platform config set`. / 渲染文件，写入 `config/public/`；不加 `-Overwrite` 不会覆盖。只有 `-Apply` 才会通过 `platform config set` 修改设置。
3. Cloudflare Tunnel (recommended): see `deploy/cloudflare/README.md` and repoint the existing public hostname to `http://host.docker.internal:5186`. Caddy: forward 80/443 on the router and run `caddy run --config Caddyfile` from `config/public/`. / 推荐 Cloudflare 隧道；或 Caddy。
4. Run the external probe in the wizard and confirm `viaProxy` and the observed header. / 运行外部探测。
5. Watch `direct_manager_gateway` events drop to zero, then switch managers to `enforce`. / 观察直连事件降为零后再切换为 enforce。
6. Act on the legacy findings yourself; the platform never deletes or stops anything. / 遗留项由你自己决定。

## Trusted proxy settings / 受信代理设置

| Topology | `trustedProxies.clientIpHeader` | `trustedProxies.cidrs` |
|---|---|---|
| Caddy | `x-forwarded-for` | `["127.0.0.1/32"]` |
| Cloudflare Tunnel | `cf-connecting-ip` | the peer address the probe reports / 探测报告的对端地址 |

## OpenWebUI (optional / 可选)

`openwebui.compose.yaml` talks to `http://host.docker.internal:5186/v1` with a dedicated `internal-app` key in `MODEL_GATEWAY_API_KEY` (put it in a `.env` next to the compose file). Signup is off and new users are `pending`. User-info headers are forwarded so PUBLIC can record a hashed end user for keys labelled `app=openwebui`; check the variable names against the pinned OpenWebUI version.

Keep ports 3000, 5176, 5177, 5178, 5180, 5190, 7000, 8000 and 8080 closed at the router and firewall.
