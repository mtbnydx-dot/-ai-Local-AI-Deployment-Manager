# 快速开始

三步就能让任何兼容 OpenAI 或 Anthropic 的工具连上本服务。

## 1. 获取密钥

向服务管理员申请 API 密钥，它以 `sk-` 开头。请妥善保管：拿到密钥的人都能消耗你的额度。在「[我的密钥](/me)」里可以看到密钥的权限和剩余额度。

## 2. 设置 Base URL

- 兼容 OpenAI 的工具：`{{OPENAI_BASE}}`
- 兼容 Anthropic 的工具（Claude Code、Anthropic SDK）：`{{ANTHROPIC_BASE}}`
- 只要主机地址、会自己补路径的工具：`{{BASE}}`

## 3. 选择模型

模型页列出了所有模型，「[我的密钥](/me)」显示你的密钥能用哪些。同样的列表也可以通过 API 获取：

```bash
curl {{OPENAI_BASE}}/models -H "Authorization: Bearer {{KEY}}"
```

然后发送第一个请求：

```bash
curl {{OPENAI_BASE}}/chat/completions \
  -H "Authorization: Bearer {{KEY}}" \
  -H "Content-Type: application/json" \
  -d '{"model": "{{MODEL}}", "messages": [{"role": "user", "content": "你好"}]}'
```

## 下一步

- 常见工具的可复制配置见[客户端](/docs/clients)页。
- 回答较长时请使用[流式输出](/docs/streaming)。
- 请求失败了？查看[错误码](/docs/errors)。
