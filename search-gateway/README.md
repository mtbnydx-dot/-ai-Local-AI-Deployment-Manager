# Local AI Search Gateway

This module adds web search to the existing local model platform without changing the running vLLM or llama.cpp containers.

It starts two Docker services:

- `searxng`: private metasearch backend, published only on `127.0.0.1:8180`.
- `search-gateway`: OpenAI-compatible gateway on `:5180` that can search first, then forward the augmented request to the local model endpoint.

## Start

```cmd
start-search-gateway.cmd
```

Default OpenAI base URL for clients:

```text
http://127.0.0.1:5180/v1
```

LAN clients can use:

```text
http://<this-machine-lan-ip>:5180/v1
```

The default upstream model endpoint inside Docker is:

```text
http://host.docker.internal:18080/v1
```

That makes the search gateway a drop-in replacement for clients already using the public/local vLLM endpoint on `18080`: keep the same `Authorization` header and change only the Base URL to `:5180/v1`. If you prefer the manager gateway, set `UPSTREAM_BASE_URL=http://host.docker.internal:5177/serve/v1` in `.env`.

## Search Controls

Default mode is `auto`. The gateway searches when the user asks for current, latest, web, news, price, weather, release, ranking, or similar time-sensitive information.

Force search for one request:

```http
x-web-search: always
```

Disable search for one request:

```http
x-web-search: off
```

The JSON body can also include:

```json
{
  "web_search": true,
  "search_options": {
    "query": "Qwen latest release",
    "max_results": 5,
    "language": "zh-CN",
    "time_range": "month"
  }
}
```

The gateway strips these fields before forwarding to the upstream model.
