# 模型管理平台审计与整改记录（2026-07-10）

## 范围

本次覆盖模型切换、vLLM/llama.cpp 兼容、MTP、thinking、OpenWebUI、统一网关、状态探测、日志与账本、公网 TLS 部署。按要求未展开安全模块审计；公网传输加密和管理面隔离作为部署功能处理。

## 已确认根因

1. OpenWebUI 数据库保存了 5 个 OpenAI 连接，包含容器内无效的 `127.0.0.1`、旧局域网 IP 和重复入口，模型发现结果会随连接超时而波动。
2. 统一入口一次状态刷新会同时请求管理器状态和服务暴露；两条路径各自执行 Docker、GPU、容器、镜像、日志和指标探测。请求超时后探测仍继续，形成 Docker CLI 子进程风暴。
3. 旧模型切换流程先停止现有容器，再验证新模型、镜像、端口和命令。任何新模型兼容问题都会把原本正常的服务一起带停。
4. Qwen3.5/3.6 ModelOpt NVFP4 虽包含 MTP 层，但 vLLM/NVFP4 组合存在启动失败和低接受率案例；不能因为 checkpoint 声明 MTP 就全局自动开启。
5. Qwen thinking 模式在贪心解码下容易长时间重复。客户端未提供采样参数时，通用 vLLM 默认值没有完整保留 checkpoint 的 `top_k` 等建议值。
6. 新增 MTP 控件未纳入前端动态布局重组，控件被移出 DOM 后触发空节点事件绑定，阻断了页面初始化。
7. API Key 启用后，聊天代理会带 Key，但后台模型探测、指标读取和 llama 内置压测遗漏了 Key，造成“服务可用但管理器检测不到模型”。

## 整改

- 模型替换改为预检、旧容器改名保留、候选容器启动验证、成功提交；失败时恢复旧容器原始命令、挂载、端口和参数。
- 运行时镜像在停止旧模型前确认并拉取；候选模型必须通过 `/v1/models` 健康检查才提交。
- 管理器状态使用单飞请求、10 秒短快照和 stale-while-revalidate；Docker 只读命令有硬超时。
- 统一入口使用 `/api/running-models` 聚合 vLLM 与 llama.cpp 模型，并按请求模型精确路由；客户端断开会中止上游请求。
- OpenWebUI 归并为 `http://host.docker.internal:5176/gateway/auto/openai/v1` 单一连接，变更前自动备份数据库。
- `host.docker.internal` 只允许访问 `/serve/*` 推理网关，管理接口继续拒绝。
- thinking 开关不由桥接层强制设置，保留客户端 `chat_template_kwargs.enable_thinking`。
- Qwen3.5/3.6 客户端未给采样值时补齐 checkpoint 默认 `temperature=1.0`、`top_p=0.95`、`top_k=20`；显式客户端值不覆盖。
- Qwen ModelOpt/NVFP4 的自动 MTP 默认关闭，显式 MTP 保留；FP8/兼容 checkpoint 的自动 MTP 使用稳定 `method=mtp`，默认 1 个 speculative token。
- reasoning/tool parser、Nemotron 插件、NVFP4/FP8 镜像和后端按模型配置选择，不再使用全局 parser/MTP 参数。
- llama.cpp 上下文按“每槽”展示并换算总 KV，上线 mmproj 自动发现、分片 GGUF 首片选择、MTP/N-gram 和直接 API Key。
- 日志增加有界轮转和尾部读取；任务/客户端账本改为去抖批量落盘；模型目录扫描增加缓存。
- 增加 Caddy 自动 TLS 与 OpenWebUI 公网 compose 模板，SSE 不缓冲、WebSocket 保留、长请求超时 30 分钟。

## 运行验证

- `test-all.cmd`：92 个 manager-core、8 个 service-entry、43 个 vLLM、33 个 llama.cpp 单测和 2 个 Playwright 浏览器用例全部通过。
- OpenWebUI：单连接，容器健康；统一模型列表返回当前模型。
- 容器内直连：推理网关 200，管理接口 403，统一入口 200。
- thinking：关闭时返回 `OK`；开启且未指定采样参数时正常完成 reasoning 并返回最终答案。
- 当前 `vllm-local` 容器 ID 和启动时间未变化；`--max-model-len 262144`、`--max-num-seqs 2` 等运行参数未修改。
- 当前模型容器仅增加 `on-failure:3` 重启策略，没有重建或重启。

## 公网启用条件

模板位于 `deploy/public/`，compose 与 Caddy 配置均已通过语法校验。实际签发证书前仍需提供两个域名、DNS 解析和对应模型网关 API Key；未满足这些外部条件时不应直接开放模型或管理端口。
