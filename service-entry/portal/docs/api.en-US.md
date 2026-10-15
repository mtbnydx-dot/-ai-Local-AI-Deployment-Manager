# API reference

The service speaks the OpenAI API and the Anthropic Messages API. Authentication is the same everywhere: `Authorization: Bearer <key>`. Anthropic clients may send the key in `x-api-key` instead.

## OpenAI-compatible endpoints

Base URL: `{{OPENAI_BASE}}`

- `GET /models` lists the models your key may use, with context length, capabilities, limits and prices.
- `POST /chat/completions` is the chat endpoint.
- `POST /completions` is the legacy text completion endpoint.
- `POST /responses` is the Responses API.
- `POST /embeddings` returns vectors for embedding models.
- `POST /audio/speech` turns text into speech (see [text to speech](/docs/tts)).

## Anthropic-compatible endpoints

Base URL: `{{ANTHROPIC_BASE}}`

- `POST /v1/messages` is the Messages API. SDKs add the path themselves.

## Which model name to use

Use the `id` from `GET /models`. A model may also have aliases, which are listed next to it. A model your key may not use answers `model_not_allowed`; one that does not exist answers `model_not_found`.

## Request ids

Every response carries `x-request-id`, and every error body repeats it as `request_id`. Quote it when you ask the owner for help.

## Who can call what

A key has scopes, such as chat, embeddings and speech. Calling an endpoint outside the key's scopes answers `scope_denied`. [My Key](/me) shows the scopes in plain words.
