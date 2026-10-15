# 视觉（图片输入）

带「视觉」标签的模型可以在文字之外接收图片。图片可以用 `data:` URL，或服务能访问到的 https 地址。

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
            {"type": "text", "text": "这张图里有什么？"},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{encoded}"}},
        ],
    }],
)
print(reply.choices[0].message.content)
```

## 小贴士

- 大图上传慢、占用 token 多，请按任务需要缩小。
- 请求超出大小限制会返回 `request_too_large`，请缩小图片。
- 请在模型页确认视觉标签；其它模型会返回 `invalid_request`。
