# 错误码

每个错误都有稳定的 `code`。错误消息是固定的英文文本；本页列出每个错误码的含义和解决办法。下表由服务自身的错误清单生成，因此始终与 API 返回的内容一致。

## 错误格式

OpenAI 风格的路由返回 `{"error": {"message", "type", "code", "param"}, "request_id": "req_..."}`。Anthropic 风格的路由（`/anthropic`、`/v1/messages`）返回 `{"type": "error", "error": {"type", "message"}, "request_id": "req_..."}`。

向管理员求助时请附上 `request_id`。429 或 503 响应可能带有以秒计的 `retry-after` 响应头。
