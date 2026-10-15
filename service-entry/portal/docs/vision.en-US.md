# Vision (image input)

Models with the vision tag accept images next to text. Send the image as a `data:` URL or an https URL that the service can reach.

```python
import base64
from openai import OpenAI

client = OpenAI(base_url="{{OPENAI_BASE}}", api_key="{{KEY}}")
with open("photo.jpg", "rb") as handle:
    encoded = base64.b64encode(handle.read()).decode()

reply = client.chat.completions.create(
    model="{{MODEL}}",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "What is in this picture?"},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{encoded}"}},
        ],
    }],
)
print(reply.choices[0].message.content)
```

## Tips

- Large images are slow to upload and use many tokens. Resize them to what the task needs.
- A request over the size limit answers `request_too_large`; shrink the image.
- Check the vision tag on the models page; other models answer `invalid_request`.
