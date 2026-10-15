# 语音合成

`POST {{OPENAI_BASE}}/audio/speech` 遵循 OpenAI 的 `audio.speech` API。密钥需要语音权限，模型必须是语音模型（模型页用音频标签标出）。

```bash
curl {{OPENAI_BASE}}/audio/speech \
  -H "Authorization: Bearer {{KEY}}" \
  -H "Content-Type: application/json" \
  -d '{"model": "{{MODEL}}", "input": "你好，这里是本地模型服务。", "voice": "alloy"}' \
  --output speech.mp3
```

```python
from openai import OpenAI

client = OpenAI(base_url="{{OPENAI_BASE}}", api_key="{{KEY}}")
with client.audio.speech.with_streaming_response.create(
    model="{{MODEL}}", voice="alloy", input="你好，这里是本地模型服务。"
) as response:
    response.stream_to_file("speech.mp3")
```

## 注意

- 响应体是音频而不是 JSON，请保存为文件。
- 可用的声音和格式取决于模型，请向管理员确认已安装哪些。
- 没有语音权限的密钥会返回 `scope_denied`；如果服务关闭了语音功能，该接口返回 `not_found`。
