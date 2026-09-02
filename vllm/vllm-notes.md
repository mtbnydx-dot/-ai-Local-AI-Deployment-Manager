# vLLM Local Service

## One-step launch from Hugging Face

```powershell
.\vllm\serve-vllm.ps1 -Model Qwen/Qwen3-0.6B -Name qwen3-0.6b -MaxModelLen 2048
```

vLLM will download model files into `cache\huggingface` under the release root on first launch unless you pass `-HfCache`.

## Download model first

```powershell
.\vllm\download-model.ps1 -Model Qwen/Qwen3-0.6B
```

Then start from local disk:

```powershell
.\vllm\serve-vllm.ps1 -Model .\models\Qwen__Qwen3-0.6B -Name qwen3-0.6b
```

## Private or gated Hugging Face models

```powershell
$env:HF_TOKEN = "hf_your_token_here"
[Environment]::SetEnvironmentVariable("HF_TOKEN", $env:HF_TOKEN, "User")
```

Then run `download-model.ps1` or `serve-vllm.ps1`.

## Test

```powershell
.\vllm\test-vllm.ps1
```

## Stop

```powershell
.\vllm\stop-vllm.ps1
```
