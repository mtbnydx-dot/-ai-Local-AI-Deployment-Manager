# Local AI Search Gateway

This module adds web search to the existing local model platform without changing the running vLLM or llama.cpp containers.

It starts two Docker services:

- `searxng`: private metasearch backend, published only on `127.0.0.1:8180`.
- `search-gateway`: OpenAI-compatible gateway on `:5180` that can search first, then forward the augmented request to the local model endpoint. It also provides bounded search/research/read workflows for `platform-mcp`.

The gateway coordinates engines instead of blindly repeating the SearXNG default request. Repeated Chinese and English availability/relevance probes select SearchToday + PrivacyWall for the normal pool; Yandex + Brave + Bing form one fallback request only when the primary result set is empty, weak, or sparse. DuckDuckGo, Startpage and Baidu currently produce repeated CAPTCHA/access failures, Google returns no usable JSON results on this host, and 360 Search became intermittently empty without reporting an error. Reported engine failures open temporary per-engine cooldowns; identical requests are cached and coalesced; backend concurrency defaults to two. Very low-relevance candidates and `ai.so.com` search-loop pages are withheld rather than padded into the result count.

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
    "max_results": 8,
    "language": "zh-CN",
    "time_range": "month",
    "preferred_domains": ["stats.gov.cn"],
    "exclude_domains": ["example.invalid"],
    "max_per_domain": 3
  }
}
```

The gateway strips these fields before forwarding to the upstream model.

## MCP Search Workflows

The authenticated gateway routes used by `platform-mcp` are:

- `GET /search`: one query, up to 20 canonicalized/ranked results; returns `searchId` and per-result `resultId` values.
- `POST /research`: one through six focused queries, merged into up to 30 deduplicated and domain-diverse sources with per-query coverage.
- `POST /read`: extracts bounded text from one through three result IDs belonging to a recent search ID. Arbitrary URLs are not accepted.
- `GET /health`: includes cache, queue, cooldown, recent-quality, and workflow counters under `searchState`.

Result-page reading resolves and pins every hostname and redirect to public addresses, permits only standard HTTP(S) ports and HTML/plain text, and enforces timeout, redirect, compressed/decompressed byte, and character limits. Returned page text remains untrusted external content.

Search responses include `quality=good|mixed|weak|empty`, `partial`, warnings, engine status, corrections, suggestions, source domains, candidate counts, and cache/coalescing flags. A larger result count therefore does not silently hide weak relevance or failed engines. `quality` describes retrieval relevance and coverage; it is not a factual-verification or source-credibility score.
