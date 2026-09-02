"""Engine health, translation, audio conversion, and synthesis services."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
import ormsgpack

from tts_catalog import (
    ENGINE_CAPABILITIES,
    ENGINE_CATALOG,
    LOCAL_WORKERS,
    chatterbox_language,
    normalize_language,
    public_engine_metadata,
    qwen_language,
)
from tts_config import cfg, settings
from tts_schemas import SynthesisRequest, TranslateRequest
from tts_storage import audio_info_bytes, voice_store


FISH_EMOTION = {
    "开心": "(joyful)",
    "悲伤": "(sad)",
    "生气": "(angry)",
    "兴奋": "(excited)",
    "平静": "(relaxed)",
    "耳语": "(whispering)",
}
CHATTERBOX_EXAG = {
    "开心": 0.65,
    "悲伤": 0.45,
    "生气": 0.8,
    "兴奋": 0.85,
    "平静": 0.3,
    "耳语": 0.35,
}


class TtsError(Exception):
    def __init__(self, status_code: int, detail: str, code: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.code = code


def _safe_upstream_message(response: httpx.Response) -> str:
    message = ""
    try:
        payload = response.json()
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict):
                message = str(error.get("message") or error.get("code") or "")
            message = message or str(payload.get("detail") or payload.get("message") or "")
    except (ValueError, json.JSONDecodeError):
        message = ""
    return message.replace("\r", " ").replace("\n", " ")[:240]


class EngineRegistry:
    def __init__(self):
        self._cache: list[dict[str, Any]] = []
        self._cached_at = 0.0
        self._lock = asyncio.Lock()
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(settings.engine_probe_timeout_seconds))

    async def close(self) -> None:
        await self._client.aclose()

    async def _probe(self, engine_id: str, info: dict[str, str]) -> dict[str, Any]:
        path = "/v1/health" if engine_id == "fish" else "/health"
        started = time.perf_counter()
        try:
            response = await self._client.get(info["url"] + path)
            latency_ms = round((time.perf_counter() - started) * 1000)
            if response.status_code != 200:
                return {
                    "available": False,
                    "status": "offline",
                    "detail": f"HTTP {response.status_code}",
                    "latency_ms": latency_ms,
                    "model_loaded": False,
                }
            payload = response.json() if response.content else {}
            model_loaded = bool(payload.get("model_loaded")) if isinstance(payload, dict) else False
            busy = bool(payload.get("busy")) if isinstance(payload, dict) else False
            return {
                "available": True,
                "status": "busy" if busy else "online",
                "detail": "模型已加载" if model_loaded else "服务在线，模型按需加载",
                "latency_ms": latency_ms,
                "model_loaded": model_loaded,
                "busy": busy,
            }
        except httpx.TimeoutException:
            return {"available": False, "status": "offline", "detail": "连接超时", "latency_ms": None, "model_loaded": False}
        except (httpx.HTTPError, ValueError):
            return {"available": False, "status": "offline", "detail": "无法连接", "latency_ms": None, "model_loaded": False}

    async def list(self, *, refresh: bool = False) -> list[dict[str, Any]]:
        now = time.monotonic()
        if not refresh and self._cache and now - self._cached_at < settings.engine_probe_ttl_seconds:
            return [dict(item) for item in self._cache]
        async with self._lock:
            now = time.monotonic()
            if not refresh and self._cache and now - self._cached_at < settings.engine_probe_ttl_seconds:
                return [dict(item) for item in self._cache]
            local_items = list(LOCAL_WORKERS.items())
            states = await asyncio.gather(*(self._probe(engine_id, info) for engine_id, info in local_items))
            checked_at = time.time()
            result: list[dict[str, Any]] = []
            for (engine_id, info), state in zip(local_items, states):
                result.append({
                    "id": engine_id,
                    "name": info["name"],
                    "type": ENGINE_CATALOG[engine_id]["type"],
                    "checked_at": checked_at,
                    "capabilities": ENGINE_CAPABILITIES[engine_id],
                    **public_engine_metadata(engine_id),
                    **state,
                })
            api_engines = (("mimo_api", "MIMO_API_KEY"), ("qwen_api", "DASHSCOPE_API_KEY"))
            for engine_id, key_name in api_engines:
                configured = bool(cfg(key_name))
                result.append({
                    "id": engine_id,
                    "name": ENGINE_CATALOG[engine_id]["name"],
                    "type": "api",
                    "available": configured,
                    "status": "online" if configured else "unconfigured",
                    "detail": "API 已配置" if configured else "尚未配置 API Key",
                    "latency_ms": None,
                    "model_loaded": None,
                    "busy": False,
                    "checked_at": checked_at,
                    "capabilities": ENGINE_CAPABILITIES[engine_id],
                    **public_engine_metadata(engine_id),
                })
            self._cache = result
            self._cached_at = time.monotonic()
            return [dict(item) for item in result]

    def invalidate(self) -> None:
        self._cached_at = 0.0


def _run_subprocess(command: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=flags,
        check=False,
    )


async def normalize_reference_audio(data: bytes, filename: str = "reference.audio") -> bytes:
    if not data:
        raise TtsError(400, "参考音频为空", "empty_audio")
    if len(data) > settings.max_upload_bytes:
        raise TtsError(413, f"参考音频不能超过 {settings.max_upload_bytes // (1024 * 1024)}MB", "audio_too_large")
    suffix = Path(filename or "").suffix.lower()
    if suffix not in {".wav", ".mp3", ".m4a", ".ogg", ".opus", ".webm", ".flac", ".aac"}:
        suffix = ".audio"
    source = settings.temp_dir / f"voice-{uuid.uuid4().hex}{suffix}"
    target = settings.temp_dir / f"voice-{uuid.uuid4().hex}.wav"
    try:
        source.write_bytes(data)
        try:
            process = await asyncio.to_thread(
                _run_subprocess,
                ["ffmpeg", "-nostdin", "-y", "-i", str(source), "-vn", "-ac", "1", "-ar", "24000", "-sample_fmt", "s16", str(target)],
                settings.ffmpeg_timeout_seconds,
            )
        except FileNotFoundError as exc:
            raise TtsError(503, "未找到 ffmpeg，无法处理参考音频", "ffmpeg_missing") from exc
        except subprocess.TimeoutExpired as exc:
            raise TtsError(408, "参考音频转换超时", "ffmpeg_timeout") from exc
        if process.returncode != 0 or not target.exists():
            raise TtsError(400, "音频无法解码，请换用 WAV、MP3、M4A 或浏览器录音", "audio_decode_failed")
        wav = target.read_bytes()
        info = audio_info_bytes(wav)
        duration = info.get("duration_ms")
        if duration is None:
            raise TtsError(400, "转换结果不是有效 WAV", "invalid_wav")
        if duration < 500:
            raise TtsError(400, "参考音频至少需要 0.5 秒", "audio_too_short")
        if duration > 120_000:
            raise TtsError(400, "参考音频不能超过 120 秒", "audio_too_long")
        return wav
    finally:
        source.unlink(missing_ok=True)
        target.unlink(missing_ok=True)


async def change_speed(audio: bytes, speed: float) -> tuple[bytes, str]:
    if abs(speed - 1.0) < 0.01:
        return audio, ""
    source = settings.temp_dir / f"speed-in-{uuid.uuid4().hex}.wav"
    target = settings.temp_dir / f"speed-out-{uuid.uuid4().hex}.wav"
    try:
        source.write_bytes(audio)
        try:
            process = await asyncio.to_thread(
                _run_subprocess,
                ["ffmpeg", "-nostdin", "-y", "-i", str(source), "-filter:a", f"atempo={max(0.5, min(2.0, speed))}", str(target)],
                settings.ffmpeg_timeout_seconds,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return audio, "语速处理不可用，已保留原始语速"
        if process.returncode != 0 or not target.exists():
            return audio, "语速处理失败，已保留原始语速"
        return target.read_bytes(), ""
    finally:
        source.unlink(missing_ok=True)
        target.unlink(missing_ok=True)


class TranslationService:
    @staticmethod
    def _result(translated: str, *, target_language: str, provider: str, model: str, started: float) -> dict[str, Any]:
        result: dict[str, Any] = {
            "translation": translated,
            "target_language": normalize_language(target_language),
            "provider": provider,
            "model": model,
            "elapsed_ms": round((time.perf_counter() - started) * 1000),
        }
        if normalize_language(target_language).casefold().startswith("en"):
            result["english"] = translated
        return result

    async def _openai_compatible(self, *, base: str, key: str, model: str, text: str, target_language: str) -> str:
        target = "natural, fluent spoken English" if target_language.lower().startswith("en") else target_language
        system = (
            f"Translate the user's text into {target}. Keep the meaning faithful and make it suitable for spoken narration. "
            "Output only the translation, with no explanation."
        )
        timeout = httpx.Timeout(90, connect=8)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{base.rstrip('/')}/chat/completions",
                headers={"Authorization": f"Bearer {key or 'none'}"},
                json={"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": text}]},
            )
        if response.status_code != 200:
            raise RuntimeError(f"HTTP {response.status_code} {_safe_upstream_message(response)}".strip())
        try:
            return str(response.json()["choices"][0]["message"]["content"]).strip()
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise RuntimeError("翻译服务返回格式无效") from exc

    async def translate(self, request: TranslateRequest) -> dict[str, Any]:
        started = time.perf_counter()
        errors: list[str] = []
        local_base = cfg("LOCAL_LLM_BASE", "http://127.0.0.1:5176/gateway/auto/openai/v1")
        local_key = cfg("LOCAL_LLM_API_KEY", "none")
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(8, connect=3)) as client:
                response = await client.get(
                    f"{local_base.rstrip('/')}/models",
                    headers={"Authorization": f"Bearer {local_key}"},
                )
            models = [item.get("id") for item in response.json().get("data", []) if item.get("id")] if response.status_code == 200 else []
            if models:
                model = cfg("LOCAL_LLM_MODEL") or models[0]
                translated = await self._openai_compatible(
                    base=local_base,
                    key=local_key,
                    model=model,
                    text=request.text,
                    target_language=request.target_language,
                )
                return self._result(translated, target_language=request.target_language, provider="local", model=model, started=started)
            errors.append("本地平台没有已加载模型")
        except (httpx.HTTPError, RuntimeError, ValueError) as exc:
            errors.append(f"本地平台: {str(exc)[:120] or exc.__class__.__name__}")

        providers = (
            ("dashscope", cfg("DASHSCOPE_API_KEY"), cfg("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"), cfg("TRANSLATE_MODEL", "qwen-plus")),
            ("mimo", cfg("MIMO_API_KEY"), cfg("MIMO_BASE_URL", "https://api.xiaomimimo.com/v1"), cfg("MIMO_CHAT_MODEL", "mimo-v2.5")),
        )
        for provider, key, base, model in providers:
            if not key:
                continue
            try:
                translated = await self._openai_compatible(base=base, key=key, model=model, text=request.text, target_language=request.target_language)
                return self._result(translated, target_language=request.target_language, provider=provider, model=model, started=started)
            except (httpx.HTTPError, RuntimeError, ValueError) as exc:
                errors.append(f"{provider}: {str(exc)[:120] or exc.__class__.__name__}")

        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(600, connect=3)) as client:
                response = await client.post(
                    LOCAL_WORKERS["qwen_local"]["url"] + "/translate",
                    json={"text": request.text, "target_language": request.target_language},
                )
            payload = response.json()
            translated = payload.get("translation") or payload.get("english")
            if response.status_code == 200 and translated:
                return self._result(
                    str(translated),
                    target_language=request.target_language,
                    provider="qwen_local",
                    model=payload.get("model", "Qwen3 local"),
                    started=started,
                )
            errors.append(f"qwen_local: HTTP {response.status_code}")
        except (httpx.HTTPError, ValueError):
            errors.append("qwen_local: 无法连接")
        raise TtsError(502, "所有翻译途径均不可用：" + "；".join(errors)[:420], "translation_unavailable")


class SynthesisService:
    def __init__(self):
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=8))

    async def close(self) -> None:
        await self._client.aclose()

    async def _local_worker(self, engine: str, text: str, language: str, wav: bytes, ref_text: str, extra: dict[str, str]) -> bytes:
        files = {"ref_audio": ("reference.wav", wav, "audio/wav")} if wav else None
        response = await self._client.post(
            LOCAL_WORKERS[engine]["url"] + "/tts",
            data={"text": text, "language": language, "ref_text": ref_text, **extra},
            files=files,
        )
        if response.status_code != 200:
            raise TtsError(502, f"{LOCAL_WORKERS[engine]['name']} 返回 HTTP {response.status_code}：{_safe_upstream_message(response) or '生成失败'}", "worker_error")
        return response.content

    async def _fish(self, text: str, wav: bytes, ref_text: str) -> bytes:
        request = {"text": text, "format": "wav", "references": [{"audio": wav, "text": ref_text or ""}], "normalize": True}
        response = await self._client.post(
            LOCAL_WORKERS["fish"]["url"] + "/v1/tts",
            headers={"Content-Type": "application/msgpack"},
            content=ormsgpack.packb(request),
        )
        if response.status_code != 200:
            raise TtsError(502, f"Fish S2 Pro 返回 HTTP {response.status_code}", "worker_error")
        return response.content

    async def _mimo(self, text: str, wav: bytes, instructions: str) -> bytes:
        key = cfg("MIMO_API_KEY")
        if not key:
            raise TtsError(409, "小米 MiMo API 尚未配置", "engine_unconfigured")
        body = {
            "model": cfg("MIMO_TTS_CLONE_MODEL", "mimo-v2.5-tts-voiceclone"),
            "messages": [{"role": "user", "content": instructions}, {"role": "assistant", "content": text}],
            "audio": {"format": "wav", "voice": "data:audio/wav;base64," + base64.b64encode(wav).decode("ascii")},
            "stream": False,
        }
        response = await self._client.post(
            cfg("MIMO_BASE_URL", "https://api.xiaomimimo.com/v1").rstrip("/") + "/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json=body,
        )
        if response.status_code != 200:
            raise TtsError(502, f"小米 MiMo 返回 HTTP {response.status_code}：{_safe_upstream_message(response) or '生成失败'}", "provider_error")
        try:
            encoded = response.json()["choices"][0]["message"]["audio"]["data"]
            return base64.b64decode(encoded, validate=True)
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise TtsError(502, "小米 MiMo 未返回有效音频", "provider_invalid_response") from exc

    async def _qwen_api(self, text: str, language: str) -> bytes:
        key = cfg("DASHSCOPE_API_KEY")
        if not key:
            raise TtsError(409, "Qwen3-TTS API 尚未配置", "engine_unconfigured")
        language_name = qwen_language(language)
        body = {
            "model": cfg("QWEN_TTS_API_MODEL", "qwen3-tts-flash"),
            "input": {"text": text, "voice": cfg("QWEN_TTS_API_VOICE", "Cherry"), "language_type": language_name},
        }
        response = await self._client.post(
            "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
            headers={"Authorization": f"Bearer {key}"},
            json=body,
        )
        if response.status_code != 200:
            raise TtsError(502, f"Qwen3-TTS API 返回 HTTP {response.status_code}：{_safe_upstream_message(response) or '生成失败'}", "provider_error")
        payload = response.json()
        audio = (payload.get("output") or {}).get("audio") or {}
        if audio.get("url"):
            download = await self._client.get(audio["url"])
            if download.status_code == 200:
                return download.content
        if audio.get("data"):
            try:
                return base64.b64decode(audio["data"], validate=True)
            except ValueError:
                pass
        raise TtsError(502, "Qwen3-TTS API 未返回有效音频", "provider_invalid_response")

    async def generate(self, request: SynthesisRequest) -> tuple[bytes, str, int, str]:
        engine = request.engine
        if engine not in ENGINE_CATALOG:
            raise TtsError(400, f"未知引擎：{engine}", "unknown_engine")
        language = normalize_language(request.language)
        if engine == "chatterbox" and language != "auto" and chatterbox_language(language) is None:
            raise TtsError(
                422,
                f"Chatterbox V3 不原生支持“{language}”；请换用 VoxCPM 2、Qwen 自动模式或输入该模型支持的语种代码",
                "engine_language_unsupported",
            )
        text = request.text.replace("⏸", " (break) " if engine == "fish" else "... ")
        if engine == "fish" and request.emotion in FISH_EMOTION:
            text = FISH_EMOTION[request.emotion] + " " + text

        wav = b""
        ref_text = ""
        capabilities = ENGINE_CAPABILITIES[engine]
        if capabilities.get("voice_required") or request.voice_id:
            if not request.voice_id:
                raise TtsError(400, "请选择参考音色", "voice_required")
            voice = voice_store.get(request.voice_id)
            if voice is None:
                raise TtsError(404, "参考音色不存在", "voice_not_found")
            if capabilities.get("requires_ref_text") and not str(voice.get("ref_text") or "").strip():
                raise TtsError(400, "Step-Audio-EditX 需要参考音频文字", "reference_text_required")
            wav = await asyncio.to_thread(voice_store.audio_path(request.voice_id).read_bytes)
            ref_text = str(voice.get("ref_text") or "")

        started = time.perf_counter()
        try:
            if engine in LOCAL_WORKERS and engine != "fish":
                extra: dict[str, str] = {}
                if engine == "chatterbox" and request.emotion in CHATTERBOX_EXAG:
                    base = CHATTERBOX_EXAG[request.emotion]
                    exaggeration = max(0.0, min(1.0, 0.5 + (base - 0.5) * (0.5 + request.emotion_intensity)))
                    extra["exaggeration"] = f"{exaggeration:.3f}"
                if engine in {"voxcpm2", "qwen_voice_design"}:
                    extra["style"] = request.style
                    extra["emotion"] = request.emotion
                audio = await self._local_worker(engine, text, language, wav, ref_text, extra)
            elif engine == "fish":
                audio = await self._fish(text, wav, ref_text)
            elif engine == "mimo_api":
                instructions = [request.style] if request.style else []
                if request.emotion:
                    instructions.append(f"用{request.emotion}的语气朗读，表达强度约 {round(request.emotion_intensity * 100)}%")
                audio = await self._mimo(text, wav, "；".join(instructions))
            else:
                audio = await self._qwen_api(text, language)
        except httpx.TimeoutException as exc:
            raise TtsError(504, f"{engine} 生成超时", "engine_timeout") from exc
        except httpx.HTTPError as exc:
            raise TtsError(503, f"无法连接 {engine}", "engine_unavailable") from exc

        audio, warning = await change_speed(audio, request.speed)
        info = audio_info_bytes(audio)
        if not audio.startswith(b"RIFF") or info["duration_ms"] is None:
            raise TtsError(502, f"{engine} 返回的不是有效 WAV", "invalid_audio_response")
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        return audio, engine, elapsed_ms, warning


engine_registry = EngineRegistry()
translation_service = TranslationService()
synthesis_service = SynthesisService()
