# API 参考

本服务同时支持 OpenAI API 和 Anthropic Messages API。认证方式统一为 `Authorization: Bearer <密钥>`；Anthropic 客户端也可以改用 `x-api-key` 请求头。

## 兼容 OpenAI 的接口

Base URL：`{{OPENAI_BASE}}`

- `GET /models` 列出你的密钥可用的模型，含上下文长度、能力、限额和价格。
- `POST /chat/completions` 对话接口。
- `POST /completions` 旧版文本补全接口。
- `POST /responses` Responses API。
- `POST /embeddings` 向量模型返回向量。
- `POST /audio/speech` 文字转语音（见[语音合成](/docs/tts)）。

## 兼容 Anthropic 的接口

Base URL：`{{ANTHROPIC_BASE}}`

- `POST /v1/messages` 即 Messages API，SDK 会自行补全路径。

## 该用哪个模型名

使用 `GET /models` 返回的 `id`。模型可能带有别名，会列在旁边。密钥无权使用的模型返回 `model_not_allowed`，不存在的模型返回 `model_not_found`。

## 请求 ID

每个响应都带有 `x-request-id`，每个错误响应体也会以 `request_id` 重复它。向管理员求助时请附上它。

## 谁能调用什么

密钥有各自的权限范围（scope），例如对话、向量和语音。调用范围之外的接口会返回 `scope_denied`。「[我的密钥](/me)」会用通俗的话列出这些权限。
