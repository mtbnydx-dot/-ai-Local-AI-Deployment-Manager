# 工具与函数调用

带「工具」标签的模型支持标准的 `tools` 参数。模型不直接回复文字，而是返回 `tool_calls`；由你的程序执行函数，再把结果发回去。

```python
from openai import OpenAI

client = OpenAI(base_url="{{OPENAI_BASE}}", api_key="{{KEY}}")
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "查询城市当前天气",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}]
messages = [{"role": "user", "content": "巴黎现在天气如何？"}]
reply = client.chat.completions.create(model="{{MODEL}}", messages=messages, tools=tools)
call = reply.choices[0].message.tool_calls[0]
print(call.function.name, call.function.arguments)
```

## 回传结果

追加助手消息，再追加一条带对应 `tool_call_id` 的 `tool` 消息，然后再次调用接口。

## 注意

- 使用前请在模型页确认该模型带有工具标签。
- Anthropic 风格的工具调用可在 `{{ANTHROPIC_BASE}}` 上使用，模型相同。
- 推理模型在调用工具前可能先思考很多 token，请给 `max_tokens` 留足余量。
