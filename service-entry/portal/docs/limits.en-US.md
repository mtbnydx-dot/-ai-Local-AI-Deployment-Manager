# Limits and quotas

Every key has its own limits, shown under [My Key](/me) and next to each model on the models page. They fall into four groups.

## Rate limits

- **Requests per minute (rpm)** and **tokens per minute (tpm)** refill continuously. Going over answers `rate_limit_exceeded` or `tokens_rate_limit_exceeded`.
- **Concurrent requests** caps how many requests run at once. Going over answers `concurrency_limit_exceeded`.
- A single request larger than the per-minute token limit can never succeed and answers `request_exceeds_tpm`.
- Requests from one network address are limited as well (`ip_rate_limited`). Repeated wrong keys cause a temporary ban (`auth_banned`).

## Quotas

Daily and monthly token caps and a daily request cap may apply. When one is used up the answer is `insufficient_quota`, and `retry-after` says when the period resets. Periods follow the service's time zone.

## Response headers

Every response to a keyed request carries these headers:

- `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests`
- `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-tokens`
- `x-quota-remaining-tokens-day` and `x-quota-remaining-tokens-month`, only when the key has such a cap

Anthropic endpoints also send the `anthropic-ratelimit-requests-*` and `anthropic-ratelimit-tokens-*` headers. A 429 always carries `retry-after`, in seconds. Wait that long before you retry.

## Shared capacity

Capacity is shared with the owner. When the service is full, a request waits briefly in a queue; if the wait runs out the answer is `overloaded` (503, or 529 on Anthropic endpoints) with `retry-after: 5`. Retrying with a short delay is the right response.

## Output length and long requests

The maximum output length per request is shown per model. Use [streaming](/docs/streaming) for long answers so proxies do not cut the connection.
