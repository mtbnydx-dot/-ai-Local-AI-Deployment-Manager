# Cloudflare Tunnel / Cloudflare 隧道

## 中文

隧道只向外建立连接，不需要在路由器上开放端口；TLS 与防护由 Cloudflare 边缘负责。隧道的目标只有一个：本机的 PUBLIC 监听 `http://host.docker.internal:5186`。管理端口（5176）、各 manager 端口永远不要放进隧道。

1. 在 Cloudflare Zero Trust 创建隧道，选择一种方式：
   - **令牌隧道（推荐）**：在 Public Hostname 中填写你的域名，Service 设为 `http://host.docker.internal:5186`。
   - **本地配置隧道**：用 `cloudflared tunnel create` 创建，把凭据文件放到 `config/public/credentials.json`。
2. 渲染模板（不会启动任何东西，也不会覆盖已有文件）：
   - 控制台“公网访问”向导，或
   - `scripts\setup-public.ps1 -ModelApiDomain <你的域名> -Topology cloudflared-token`（加 `-Apply` 才会写入平台设置）。
3. 令牌隧道：把 `config/public/cloudflared.env.example` 复制为 `cloudflared.env`，自己填入 `TUNNEL_TOKEN`。平台不会生成或保存令牌。
4. 自行运行：`docker compose -f config/public/cloudflared.compose.yaml up -d`。
5. 在向导里运行“外部探测”，确认 `viaProxy` 与读取到的头（`cf-connecting-ip`）。

`CLOUDFLARED_IMAGE` 默认使用带标签的镜像；上线前请按你的环境把它固定到 digest（`docker buildx imagetools inspect <image>`）。

## English

The tunnel only makes outbound connections: no router ports, TLS and protection at the Cloudflare edge. It has exactly one target, the PUBLIC listener at `http://host.docker.internal:5186`. Never route the admin port (5176) or any manager port through it.

1. Create a tunnel in Cloudflare Zero Trust:
   - **Token tunnel (recommended)**: set the public hostname to your domain and its service to `http://host.docker.internal:5186` in the dashboard.
   - **Locally managed tunnel**: create it with `cloudflared tunnel create` and put the credentials file at `config/public/credentials.json`.
2. Render the templates (nothing is started and nothing is overwritten):
   - the console "Public access" wizard, or
   - `scripts\setup-public.ps1 -ModelApiDomain <your domain> -Topology cloudflared-token` (settings are written only with `-Apply`).
3. Token tunnel: copy `config/public/cloudflared.env.example` to `cloudflared.env` and paste `TUNNEL_TOKEN` yourself. The platform never generates or stores it.
4. Start it yourself: `docker compose -f config/public/cloudflared.compose.yaml up -d`.
5. Run the external probe in the wizard and confirm `viaProxy` and the observed header (`cf-connecting-ip`).

`CLOUDFLARED_IMAGE` defaults to a tagged image; pin it to a digest for your environment before going live (`docker buildx imagetools inspect <image>`).
