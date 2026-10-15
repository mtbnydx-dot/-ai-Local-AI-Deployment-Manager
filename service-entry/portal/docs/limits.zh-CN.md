# 限额与配额

每个密钥有各自的限额，显示在「[我的密钥](/me)」和模型页的每个模型旁。限额分为四类。

## 速率限制

- **每分钟请求数（rpm）**和**每分钟 token 数（tpm）**会持续补充。超出时返回 `rate_limit_exceeded` 或 `tokens_rate_limit_exceeded`。
- **并发请求数**限制同时进行的请求数，超出时返回 `concurrency_limit_exceeded`。
- 单个请求大于每分钟 token 上限时永远无法成功，返回 `request_exceeds_tpm`。
- 同一网络地址的请求也有限制（`ip_rate_limited`）；多次使用错误密钥会被临时封禁（`auth_banned`）。

## 配额

可能设有每日、每月 token 上限和每日请求上限。用完时返回 `insufficient_quota`，`retry-after` 说明何时重置。周期按服务所在时区计算。

## 响应头

带密钥的请求，每个响应都带有以下响应头：

- `x-ratelimit-limit-requests`、`x-ratelimit-remaining-requests`、`x-ratelimit-reset-requests`
- `x-ratelimit-limit-tokens`、`x-ratelimit-remaining-tokens`、`x-ratelimit-reset-tokens`
- `x-quota-remaining-tokens-day` 和 `x-quota-remaining-tokens-month`，仅当密钥设有相应上限时出现

Anthropic 接口还会发送 `anthropic-ratelimit-requests-*` 和 `anthropic-ratelimit-tokens-*` 响应头。429 总是带有以秒计的 `retry-after`，请等待这么久再重试。

## 共享容量

容量与服务所有者共享。服务满载时请求会在队列里短暂等待；等待超时则返回 `overloaded`（503，Anthropic 接口为 529），并带 `retry-after: 5`。稍等片刻再重试即可。

## 输出长度与长请求

每个模型的单次最大输出长度会显示在模型页。长回答请使用[流式输出](/docs/streaming)，避免代理切断连接。
