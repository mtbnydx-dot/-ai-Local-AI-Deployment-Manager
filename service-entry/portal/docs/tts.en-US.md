# Text to speech

`POST {{OPENAI_BASE}}/audio/speech` follows the OpenAI `audio.speech` API. The key needs the speech scope, and the model must be a speech model (the models page marks it with the audio tag).

```bash
curl {{OPENAI_BASE}}/audio/speech \
  -H "Authorization: Bearer {{KEY}}" \
  -H "Content-Type: application/json" \
  -d '{"model": "{{MODEL}}", "input": "Hello from the local model service.", "voice": "alloy"}' \
  --output speech.mp3
```

```python
from openai import OpenAI

client = OpenAI(base_url="{{OPENAI_BASE}}", api_key="{{KEY}}")
with client.audio.speech.with_streaming_response.create(
    model="{{MODEL}}", voice="alloy", input="Hello from the local model service."
) as response:
    response.stream_to_file("speech.mp3")
```

## Notes

- The response body is audio, not JSON. Save it to a file.
- Voices and formats depend on the model; ask the owner which are installed.
- A key without the speech scope answers `scope_denied`. If the service has speech turned off, the endpoint answers `not_found`.
