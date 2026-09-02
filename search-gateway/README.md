# Local AI Search Gateway

This module adds web search to the existing local model platform without changing the running vLLM or llama.cpp containers.

It starts two Docker services:

- `searxng`: private metasearch backend, published only on `127.0.0.1:8180`.
- `search-gateway`: OpenAI-compatible gateway on `:5180` that can search first, then forward the augmented request to the local model endpoint. It also provides bounded search/research/open/read workflows for `platform-mcp`.

The gateway coordinates engines instead of blindly repeating the SearXNG default request. Repeated Chinese and English availability/relevance probes select SearchToday for the normal pool; Yandex supplies one fallback request only when the primary result set is empty, weak, or sparse. This keeps normal searches accurate and fast without repeatedly consuming a fragile second engine. PrivacyWall was accurate but entered rate limits after bursts, Brave was repeatedly rate-limited, Bing returned severe off-topic noise, DuckDuckGo/Startpage/Baidu produced CAPTCHA or access failures, Google returned no usable JSON results on this host, and 360 Search became intermittently empty without reporting an error. Those engines remain available only when an operator selects them explicitly. Reported engine failures open temporary per-engine cooldowns; identical requests are cached and coalesced; backend concurrency defaults to two. Very low-relevance candidates and `ai.so.com` search-loop pages are withheld rather than padded into the result count. Use the multi-query research workflow for broader coverage instead of forcing every engine into every request.

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
- `POST /research`: one through eight focused queries, merged into up to 40 deduplicated sources with domain/source-type coverage and gap reporting.
- `POST /open`: recognizes and extracts bounded content from one through three explicit public HTTP(S) URLs. It accepts no credentials, cookies, custom headers, local/private destinations, or non-standard ports.
- `POST /read`: recognizes and extracts bounded HTML article, plain/Markdown/CSV, JSON, XML/RSS, and PDF content from one through three result IDs belonging to a recent search ID. Arbitrary URLs are not accepted.
- `POST /find`: finds a literal phrase or all requested terms inside one safely extracted result page, reusing the bounded page cache when possible.
- `GET /health`: includes cache, queue, cooldown, recent-quality, and workflow counters under `searchState`.

Both explicit-page and search-result reading resolve and pin every hostname and redirect to public addresses, permit only standard HTTP(S) ports, and enforce timeout, redirect, compressed/decompressed byte, PDF-page, cache-lifetime, and character limits. HTML uses Mozilla Readability with DOM fallback; JSON-LD, canonical URL, author, site, language, dates, headings, extraction method, word/character counts, and PDF page counts are returned when detectable. Returned page text remains untrusted external content. JavaScript-only pages, login/CAPTCHA/paywalls, and image-only PDFs are intentionally outside this bounded reader; it executes no page script, sends no browser cookies, and performs no OCR.

Search responses include `quality=good|mixed|weak|empty`, `partial`, warnings, engine status, corrections, suggestions, source domains/types, candidate counts, and cache/coalescing flags. Research supports `source_strategy=balanced|relevance|primary`; source classifications and primary-source likelihood are routing hints, not credibility verdicts. A larger result count therefore does not silently hide weak relevance or failed engines. Quoted phrases are treated as precision constraints even when an upstream engine ignores the quotes, and `good`/`mixed` require multiple convincingly relevant results rather than one high-scoring outlier. `quality` describes retrieval relevance and coverage; it is not a factual-verification or source-credibility score.
