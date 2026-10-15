# Error codes

Every error has a stable `code`. Messages are fixed English text, and this page lists each code with what it means and how to fix it. The table below is generated from the service's own list of errors, so it always matches what the API returns.

## Error shapes

OpenAI-style routes answer `{"error": {"message", "type", "code", "param"}, "request_id": "req_..."}`. Anthropic-style routes (`/anthropic`, `/v1/messages`) answer `{"type": "error", "error": {"type", "message"}, "request_id": "req_..."}`.

Quote the `request_id` when you ask the owner for help. A 429 or a 503 may carry a `retry-after` header in seconds.
