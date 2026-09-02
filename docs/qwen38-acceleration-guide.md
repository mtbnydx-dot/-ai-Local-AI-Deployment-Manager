# Qwen3.8-27B 本地加速与管理平台指南

更新时间：2026-08-15。硬件基线：单张 NVIDIA RTX PRO 6000 Blackwell 96GB，Windows + Docker Desktop/WSL，OpenAI 兼容服务端口 8000。

## 结论

- 综合生产默认：`Qwen3.8 vLLM 稳定加速`。使用 Qwen3.8 专用 vLLM 构建、FP8 主模型、原生 MTP-3、前缀缓存、自动 KV dtype、`--language-model-only`。它保留 vLLM 管理、指标和回滚链路，且 40/40 功能样本通过。
- 绝对吞吐最高：`Qwen3.8 SGLang + DSpark 极速`。使用 SGLang 0.5.17、RadixArk DSpark draft、block 7、FlashInfer 与 overlap 调度；40/40 功能样本通过，但运行时和 draft checkpoint 都比原生 MTP 更实验性。
- 容量优先：`Qwen3.8 NVFP4 容量档`。显存更省，短基准吞吐不差；不能用这组轻量正确性样本证明其质量等同 FP8，因此不作为质量优先默认。
- 不启用 vLLM-native DSpark：本机实测 V2 runner 因 WSL UVA 不可用失败，V1 runner 又将 draft 误解析为 DeepSeekV4 并触发 `hc_mult` 错误。管理器会明确阻止该组合并建议切到 SGLang。

## 实测结果

所有主表方案使用同一主模型、同一 4 类 workload（decode、coding、reasoning、tool）、C1/C4、每格 2 次，共 40 个请求；各方案最低正确率均为 100%。吞吐是 decode 场景 aggregate output tok/s。

| 方案 | C1 | C4 | C1 TTFT P50 | C4 TTFT P50 | 功能样本 |
| --- | ---: | ---: | ---: | ---: | ---: |
| vLLM FP8，无推测 | 48.300 | 177.174 | 94.759 ms | 98.291 ms | 40/40 |
| vLLM FP8，MTP-1 | 59.844 | 206.193 | 119.575 ms | 217.291 ms | 40/40 |
| vLLM FP8，MTP-3 + prefix + auto KV | 101.487 | 391.432 | 126.600 ms | 228.210 ms | 40/40 |
| vLLM FP8，MTP-3 + prefix + FP8 KV | 95.467 | 360.166 | 135.155 ms | 224.730 ms | 40/40 |
| vLLM NVFP4，MTP-3 | 108.663 | 391.891 | 137.823 ms | 334.784 ms | 40/40 |
| SGLang FP8，无推测 | 42.499 | 163.582 | 172.378 ms | 187.260 ms | 40/40 |
| SGLang FP8，DSpark + overlap | 191.966 | 739.215 | 338.287 ms | 129.598 ms | 40/40 |

相对 vLLM FP8 无推测，vLLM MTP-3 在 C1/C4 分别约快 110%/121%；SGLang DSpark 在 C1/C4 分别约快 297%/317%。相对生产默认的 vLLM MTP-3，SGLang DSpark 在 C1/C4 分别约快 89%/89%。

前缀缓存使用 16,292-token 相同长前缀连续请求单独验证：关闭缓存时 TTFT P50 为 1,925 ms；开启后为 323 ms；最终 FP8 + MTP-3 + auto KV 配置为 218 ms。该次最终配置的 token-level prefix hit rate 为 62.20%。

原始结果位于本机运行目录的 `<AI_ROOT>\artifacts\qwen38-accel-20260815`，关键文件：

- `vllm-qwen38-fp8-mtp3-textonly-prefix-auto-kv.json`
- `vllm-qwen38-fp8-mtp3-textonly-prefix-auto-kv-longprefix.json`
- `sglang-fp8-dspark-overlap.json`
- `sglang-fp8-dspark-overlap-longprefix.json`
- `restored-original-vllm-smoke-tool.json`

## 权重与运行时约束

- FP8 主模型：`<AI_ROOT>\models\Qwen-Qwen3.8-27B-FP8`。
- NVFP4 主模型：`<AI_ROOT>\models\unsloth-Qwen3.8-27B-NVFP4`。
- DSpark draft：`<AI_ROOT>\models\RadixArk-Qwen3.8-27B-DSpark`，约 2.71 GiB，配置架构必须是 `DSparkDraftModel`。
- vLLM 镜像固定到本机已验证的 Linux amd64 digest `sha256:2286e8533ca8b6bc777594bae30524f1426ba46ca21797524e06df6a94b06635`；镜像内 vLLM `0.28.0`、PyTorch 2.13.0、Transformers 5.15.1、CUDA 13.0.2。
- SGLang 镜像固定到 digest `sha256:3ea7c6d74312d964edbcf9b3819425ea42117eb967ef1cfec632a70c926027df`；镜像内 SGLang 0.5.17、PyTorch 2.11.0、Transformers 5.12.1、CUDA 13.0。
- 原生 MTP 不能只看 `config.json` 的 `mtp_num_hidden_layers`。管理器会读取 safetensors index/header，确认实际存在 `mtp.*` tensor 后才允许自动或显式 MTP。

## 管理平台用法

打开 vLLM 管理器后选择本地主模型，再选择以下内置启动配置之一：

1. 日常生产：`Qwen3.8 vLLM 稳定加速`。
2. 批处理或追求最高吞吐：`Qwen3.8 SGLang + DSpark 极速`。
3. 更重视显存余量：`Qwen3.8 NVFP4 容量档`。

启动前使用“模型检查”。报告会展示：实际 MTP tensor 数量与证据文件、运行引擎和镜像、DSpark draft 架构、推荐 parser，以及阻断项。

基准工具支持：1–64 个请求、1–16 并发、0–4 次 warmup、16–8192 output tokens、SSE streaming。结果包括 wall throughput、成功/失败数、TTFT P50/P95、E2E P50/P95、单请求 decode TPS 和样本错误。

指标页额外展示：

- token-level prefix cache queries/hits/hit rate，以及 hybrid Mamba/attention block 对齐要求；
- speculative draft cycles、draft tokens、accepted tokens、真实 acceptance rate、每轮接受 token 数；
- vLLM 与 SGLang 的统一引擎/版本字段和持久化历史样本。

## 启动 API 补全

`POST /api/start` 新增并持久化以下字段：

```json
{
  "engine": "vllm | sglang",
  "runtimeImage": "optional immutable Docker image reference",
  "speculativeMode": "off | auto | mtp | qwen3_next_mtp | ngram | dspark",
  "numSpeculativeTokens": 3,
  "draftModel": "D:\\AI\\models\\RadixArk-Qwen3.8-27B-DSpark",
  "dsparkBlockSize": 7
}
```

`runtimeImage` 经过安全字符校验；DSpark draft 必须位于模型根目录内且架构匹配。SGLang 当前只开放 `off` 和 `dspark`，vLLM 上的 `dspark` 会按本机验证结果阻断，不会静默降级。

`GET /api/config` 返回 `runtimeEngines` 及固定镜像信息；启动配置接口返回新增的三个 Qwen3.8 预设。原有 `/api/status`、`/api/stats`、`/api/metrics/history`、`POST /api/tools/benchmark` 继续兼容，并增加 engine、MTP/DSpark 与缓存字段。

## 上游参考

- Qwen3.8-27B 模型卡：<https://huggingface.co/Qwen/Qwen3.8-27B>
- vLLM Qwen3.8 recipe：<https://github.com/vllm-project/recipes/blob/main/models/Qwen/Qwen3.8-27B.yaml>
- vLLM DSpark 文档：<https://docs.vllm.ai/projects/speculators/en/latest/user_guide/algorithms/dspark/>
- RadixArk draft checkpoint：<https://huggingface.co/RadixArk/Qwen3.8-27B-DSpark>
- DSpark 论文：<https://arxiv.org/abs/2607.05147>
