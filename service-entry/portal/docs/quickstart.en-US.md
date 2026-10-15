# Quick start

Three steps get any OpenAI-compatible or Anthropic-compatible tool talking to this service.

## 1. Get a key

Ask the service owner for an API key. It starts with `sk-`. Keep it private: anyone who has it can use your quota. Under [My Key](/me) you can see what it allows and how much is left.

## 2. Set the base URL

- OpenAI-compatible tools: `{{OPENAI_BASE}}`
- Anthropic-compatible tools (Claude Code, the Anthropic SDKs): `{{ANTHROPIC_BASE}}`
- Tools that ask for a bare host and add the path themselves: `{{BASE}}`

## 3. Pick a model

The model list shows what exists, and [My Key](/me) shows what your key may use. The same list is available from the API:

```bash
curl {{OPENAI_BASE}}/models -H "Authorization: Bearer {{KEY}}"
```

Then send a first request:

```bash
curl {{OPENAI_BASE}}/chat/completions \
  -H "Authorization: Bearer {{KEY}}" \
  -H "Content-Type: application/json" \
  -d '{"model": "{{MODEL}}", "messages": [{"role": "user", "content": "Hello"}]}'
```

## Next

- Copy-paste setups for common tools are on the [clients](/docs/clients) page.
- Long answers: use [streaming](/docs/streaming).
- Something failed? See the [error codes](/docs/errors).
