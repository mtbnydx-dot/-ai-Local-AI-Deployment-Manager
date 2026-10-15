# Tools and function calling

Models marked with the tools tag accept the standard `tools` parameter. The model replies with a `tool_calls` entry instead of text; your program runs the function and sends the result back.

```python
from openai import OpenAI

client = OpenAI(base_url="{{OPENAI_BASE}}", api_key="{{KEY}}")
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Current weather for a city",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}]
messages = [{"role": "user", "content": "What is the weather in Paris?"}]
reply = client.chat.completions.create(model="{{MODEL}}", messages=messages, tools=tools)
call = reply.choices[0].message.tool_calls[0]
print(call.function.name, call.function.arguments)
```

## Sending the result back

Append the assistant message and a `tool` message with the matching `tool_call_id`, then call the endpoint again.

## Notes

- Check a model's tools tag on the models page before relying on it.
- Anthropic-style tool use works on `{{ANTHROPIC_BASE}}` with the same models.
- Reasoning models can spend many tokens thinking before a tool call; leave room in `max_tokens`.
