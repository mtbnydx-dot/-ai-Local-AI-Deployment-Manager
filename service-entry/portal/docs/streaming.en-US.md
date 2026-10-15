# Streaming

Set `"stream": true` and the answer arrives piece by piece as server-sent events, so you see the first words within moments instead of waiting for the whole reply.

## Why you should stream long requests

Edge proxies in front of this service can cut a non-streaming response after about 100 seconds. A long answer from a large model can take longer than that, and the connection then fails with a timeout even though the model was still working. Use `stream: true` for anything that may run long.

```bash
curl -N {{OPENAI_BASE}}/chat/completions \
  -H "Authorization: Bearer {{KEY}}" \
  -H "Content-Type: application/json" \
  -d '{"model": "{{MODEL}}", "stream": true, "messages": [{"role": "user", "content": "Write a long story."}]}'
```

## Reading the stream

Each event is a line starting with `data:` that holds a JSON chunk. The stream ends with `data: [DONE]`. The official SDKs parse this for you:

```python
from openai import OpenAI

client = OpenAI(base_url="{{OPENAI_BASE}}", api_key="{{KEY}}")
stream = client.chat.completions.create(
    model="{{MODEL}}",
    messages=[{"role": "user", "content": "Write a long story."}],
    stream=True,
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

## Stopping early

Close the connection and the model stops generating. Tokens produced until then still count against your quota.

## Tips

- Buffering proxies and some HTTP clients hold events back; pass `-N` to curl.
- Errors before the first byte arrive as a normal error response. Errors after streaming has begun end the stream; check the last chunk.
