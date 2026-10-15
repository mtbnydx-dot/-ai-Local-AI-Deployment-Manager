# 流式输出

设置 `"stream": true` 后，回答会以服务器推送事件（SSE）的方式一段一段到达，你很快就能看到最初的文字，而不必等整个回答生成完。

## 为什么长请求要用流式

本服务前面的边缘代理可能在约 100 秒后切断非流式响应。大模型的长回答可能超过这个时间，即使模型仍在工作，连接也会超时失败。任何可能耗时较长的请求都应使用 `stream: true`。

```bash
curl -N {{OPENAI_BASE}}/chat/completions \
  -H "Authorization: Bearer {{KEY}}" \
  -H "Content-Type: application/json" \
  -d '{"model": "{{MODEL}}", "stream": true, "messages": [{"role": "user", "content": "写一个长故事。"}]}'
```

## 读取数据流

每个事件是一行以 `data:` 开头的 JSON 片段，流以 `data: [DONE]` 结束。官方 SDK 会替你解析：

```python
from openai import OpenAI

client = OpenAI(base_url="{{OPENAI_BASE}}", api_key="{{KEY}}")
stream = client.chat.completions.create(
    model="{{MODEL}}",
    messages=[{"role": "user", "content": "写一个长故事。"}],
    stream=True,
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

## 提前停止

关闭连接，模型就会停止生成。此前已生成的 token 仍会计入额度。

## 小贴士

- 有缓冲的代理和部分 HTTP 客户端会压住事件，curl 请加 `-N`。
- 第一个字节之前的错误以普通错误响应返回；开始流式之后的错误会让流结束，请检查最后一个片段。
