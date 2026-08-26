r"""语音克隆聚合网关 (TTS Aggregation Gateway)

统一入口，聚合多个 TTS 引擎：
  本地: chatterbox (7011) / qwen_local (7012) / fish (7013, msgpack 协议) / step_audio (7014, Docker)
  API : mimo_api (小米 MiMo v2.5 TTS) / qwen_api (阿里 DashScope qwen3-tts)
另提供 中文→英文 翻译接口（走 DashScope 或 MiMo 的 chat 模型）。

运行: E:\tts_runtime\envs\gateway\Scripts\python.exe -m uvicorn main:app --port 7000
"""

import asyncio
import base64
import json
import os
import re
import secrets
import subprocess
import time
import uuid
from pathlib import Path

import httpx
import ormsgpack
from dotenv import dotenv_values
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent  # 项目根目录 tts/
DATA_ROOT = Path(os.environ.get("TTS_DATA_ROOT", str(ROOT))).resolve()
VOICES_DIR = DATA_ROOT / "voices"
OUTPUTS_DIR = DATA_ROOT / "outputs"
VOICES_DIR.mkdir(exist_ok=True)
OUTPUTS_DIR.mkdir(exist_ok=True)

CFG = {**dotenv_values(ROOT / ".env")}


def cfg(key, default=""):
    return str(os.environ.get(key) or CFG.get(key) or default).strip()


def cfg_int(key: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(cfg(key, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


MAX_UPLOAD_BYTES = cfg_int("TTS_MAX_UPLOAD_BYTES", 10 * 1024 * 1024, 1024, 64 * 1024 * 1024)
MAX_TEXT_CHARS = cfg_int("TTS_MAX_TEXT_CHARS", 10_000, 1, 100_000)
VOICE_ID_RE = re.compile(r"^\d{14}_[0-9a-f]{6}$")


LOCAL_WORKERS = {
    "chatterbox": {"name": "Chatterbox V3 (本地)", "url": "http://127.0.0.1:7011"},
    "qwen_local": {"name": "Qwen3-TTS 1.7B (本地)", "url": "http://127.0.0.1:7012"},
    "fish": {"name": "Fish S2 Pro (本地)", "url": "http://127.0.0.1:7013"},
    "step_audio": {"name": "Step-Audio-EditX (Docker)", "url": "http://127.0.0.1:7014"},
}

app = FastAPI(title="TTS 聚合平台")


def _presented_api_key(request: Request) -> str:
    authorization = request.headers.get("authorization", "").strip()
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return request.headers.get("x-api-key", "").strip()


@app.middleware("http")
async def require_optional_api_key(request: Request, call_next):
    """Protect data/API routes when TTS_API_KEY is configured.

    The HTML shell remains readable so a browser routed through service-entry can
    ask for a gateway key after receiving a 401 from its first API request.
    """
    expected = cfg("TTS_API_KEY")
    protected = request.url.path.startswith(("/api/", "/v1/", "/outputs/"))
    if expected and protected:
        presented = _presented_api_key(request)
        if not presented or not secrets.compare_digest(presented.encode("utf-8"), expected.encode("utf-8")):
            return JSONResponse(
                {"detail": "Missing or invalid TTS API key."},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
    return await call_next(request)


# ---------------------------------------------------------------- voices

def _voice_meta_path(vid: str) -> Path:
    return VOICES_DIR / f"{_validate_voice_id(vid)}.json"


def _voice_wav_path(vid: str) -> Path:
    return VOICES_DIR / f"{_validate_voice_id(vid)}.wav"


def _validate_voice_id(vid: str) -> str:
    value = str(vid or "").strip()
    if not VOICE_ID_RE.fullmatch(value):
        raise HTTPException(400, "voice_id 格式无效")
    return value


async def _read_upload_limited(file: UploadFile) -> bytes:
    chunks = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"参考音频不能超过 {MAX_UPLOAD_BYTES // (1024 * 1024)}MB")
        chunks.append(chunk)
    return b"".join(chunks)


@app.post("/api/voices")
async def add_voice(
    file: UploadFile = File(...),
    name: str = Form("我的音色"),
    ref_text: str = Form(""),
):
    vid = time.strftime("%Y%m%d%H%M%S") + "_" + uuid.uuid4().hex[:6]
    raw = VOICES_DIR / f"{vid}.orig"
    raw.write_bytes(await _read_upload_limited(file))
    # 统一转成 24kHz 单声道 16bit wav（浏览器录音是 webm/opus，各引擎都吃 wav）
    proc = subprocess.run(
        ["ffmpeg", "-y", "-i", str(raw), "-ac", "1", "-ar", "24000",
         "-sample_fmt", "s16", str(_voice_wav_path(vid))],
        capture_output=True, text=True,
    )
    raw.unlink(missing_ok=True)
    if proc.returncode != 0:
        raise HTTPException(400, f"音频转换失败: {proc.stderr[-500:]}")
    meta = {
        "id": vid,
        "name": str(name or "我的音色").strip()[:120] or "我的音色",
        "ref_text": str(ref_text or "").strip()[:4000],
        "created": time.time(),
    }
    _voice_meta_path(vid).write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return meta


@app.get("/api/voices")
def list_voices():
    out = []
    for p in sorted(VOICES_DIR.glob("*.json"), reverse=True):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except Exception:
            pass
    return out


@app.delete("/api/voices/{vid}")
def delete_voice(vid: str):
    _voice_meta_path(vid).unlink(missing_ok=True)
    _voice_wav_path(vid).unlink(missing_ok=True)
    return {"ok": True}


@app.get("/api/voices/{vid}/audio")
def voice_audio(vid: str):
    p = _voice_wav_path(vid)
    if not p.exists():
        raise HTTPException(404, "voice not found")
    return FileResponse(p, media_type="audio/wav")


# ---------------------------------------------------------------- engines

async def _probe(url: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=2.0) as c:
            r = await c.get(url + "/health")
            if r.status_code == 200:
                return {"available": True, "detail": r.json()}
    except Exception as e:
        return {"available": False, "detail": str(e.__class__.__name__)}
    return {"available": False, "detail": f"HTTP {r.status_code}"}


@app.get("/api/engines")
async def engines():
    result = []
    local_items = list(LOCAL_WORKERS.items())
    states = await asyncio.gather(*[
        _probe(info["url"] + ("/v1" if eid == "fish" else ""))
        for eid, info in local_items
    ])
    for (eid, info), st in zip(local_items, states):
        result.append({"id": eid, "name": info["name"], "type": "local", **st})
    result.append({
        "id": "mimo_api", "name": "小米 MiMo v2.5 TTS (API)", "type": "api",
        "available": bool(cfg("MIMO_API_KEY")),
        "detail": "已配置 API Key" if cfg("MIMO_API_KEY") else "未配置 MIMO_API_KEY",
    })
    result.append({
        "id": "qwen_api", "name": "Qwen3-TTS (DashScope API, 预置音色)", "type": "api",
        "available": bool(cfg("DASHSCOPE_API_KEY")),
        "detail": "已配置 API Key" if cfg("DASHSCOPE_API_KEY") else "未配置 DASHSCOPE_API_KEY",
    })
    return result


# ---------------------------------------------------------------- translate

TRANSLATE_SYS = (
    "You are a professional translator. Translate the user's Chinese text into "
    "natural, fluent spoken English suitable for reading aloud in a class presentation. "
    "Keep the meaning faithful, use simple clear sentences. "
    "Output ONLY the English translation, nothing else."
)


async def _translate_openai_compat(base: str, key: str, model: str, text: str) -> str:
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(
            f"{base}/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": TRANSLATE_SYS},
                    {"role": "user", "content": text},
                ],
            },
        )
    if r.status_code != 200:
        raise RuntimeError(f"{model} ({r.status_code}): {r.text[:200]}")
    return r.json()["choices"][0]["message"]["content"].strip()


@app.post("/api/translate")
async def translate(payload: dict):
    """级联：D:\\AI 本地大模型平台 → DashScope → 小米 MiMo → 本地 Qwen3-4B（qwen worker /translate）。"""
    text = str(payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text 为空")

    errors = []
    # 用户在 D:\AI 的模型服务平台（service-entry 统一网关，OpenAI 兼容，本机免鉴权）
    llm_base = cfg("LOCAL_LLM_BASE", "http://127.0.0.1:5176/gateway/auto/openai/v1")
    try:
        async with httpx.AsyncClient(timeout=8) as c:
            r = await c.get(f"{llm_base}/models")
        models = [m["id"] for m in r.json().get("data", [])] if r.status_code == 200 else []
        if models:
            model = cfg("LOCAL_LLM_MODEL") or models[0]
            english = await _translate_openai_compat(llm_base, cfg("LOCAL_LLM_API_KEY", "none"), model, text)
            return {"english": english, "model": f"{model} (D:\\AI 本地平台)"}
        errors.append("本地平台无已加载模型")
    except Exception as e:
        errors.append(f"本地平台: {e.__class__.__name__}")
    if cfg("DASHSCOPE_API_KEY"):
        try:
            model = cfg("TRANSLATE_MODEL", "qwen-plus")
            english = await _translate_openai_compat(
                cfg("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
                cfg("DASHSCOPE_API_KEY"), model, text)
            return {"english": english, "model": model}
        except Exception as e:
            errors.append(str(e))
    if cfg("MIMO_API_KEY"):
        try:
            model = cfg("MIMO_CHAT_MODEL", "mimo-v2.5")
            english = await _translate_openai_compat(
                cfg("MIMO_BASE_URL", "https://api.xiaomimimo.com/v1"),
                cfg("MIMO_API_KEY"), model, text)
            return {"english": english, "model": model}
        except Exception as e:
            errors.append(str(e))
    # 本地兜底：qwen worker 里的 Qwen3-4B-Instruct
    try:
        async with httpx.AsyncClient(timeout=600) as c:
            r = await c.post(LOCAL_WORKERS["qwen_local"]["url"] + "/translate", json={"text": text})
        if r.status_code == 200 and r.json().get("english"):
            return r.json()
        errors.append(f"本地翻译: HTTP {r.status_code} {r.text[:200]}")
    except Exception as e:
        errors.append(f"本地翻译: {e}")
    raise HTTPException(502, "所有翻译途径都失败了: " + " | ".join(errors)[:500])


# ---------------------------------------------------------------- tts dispatch

async def tts_local_worker(url: str, text: str, language: str, wav_bytes: bytes, ref_text: str, extra: dict | None = None) -> bytes:
    async with httpx.AsyncClient(timeout=600) as c:
        r = await c.post(
            url + "/tts",
            data={"text": text, "language": language, "ref_text": ref_text, **(extra or {})},
            files={"ref_audio": ("ref.wav", wav_bytes, "audio/wav")},
        )
    if r.status_code != 200:
        raise HTTPException(502, f"worker 出错 ({r.status_code}): {r.text[:300]}")
    return r.content


async def tts_fish(text: str, wav_bytes: bytes, ref_text: str) -> bytes:
    req = {
        "text": text,
        "format": "wav",
        "references": [{"audio": wav_bytes, "text": ref_text or ""}],
        "normalize": True,
    }
    async with httpx.AsyncClient(timeout=600) as c:
        r = await c.post(
            LOCAL_WORKERS["fish"]["url"] + "/v1/tts",
            headers={"Content-Type": "application/msgpack"},
            content=ormsgpack.packb(req),
        )
    if r.status_code != 200:
        raise HTTPException(502, f"fish worker 出错 ({r.status_code}): {r.text[:300]}")
    return r.content


async def tts_mimo(text: str, wav_bytes: bytes, instructions: str = "") -> bytes:
    b64 = base64.b64encode(wav_bytes).decode()
    body = {
        # 音色克隆必须用 voiceclone 模型；预置音色才是 mimo-v2.5-tts
        "model": cfg("MIMO_TTS_CLONE_MODEL", "mimo-v2.5-tts-voiceclone"),
        "messages": [
            {"role": "user", "content": instructions},
            {"role": "assistant", "content": text},
        ],
        "audio": {"format": "wav", "voice": f"data:audio/wav;base64,{b64}"},
        "stream": False,
    }
    async with httpx.AsyncClient(timeout=300) as c:
        r = await c.post(
            cfg("MIMO_BASE_URL", "https://api.xiaomimimo.com/v1") + "/chat/completions",
            headers={"Authorization": f"Bearer {cfg('MIMO_API_KEY')}"},
            json=body,
        )
    if r.status_code != 200:
        raise HTTPException(502, f"MiMo API 出错 ({r.status_code}): {r.text[:300]}")
    data = r.json()
    audio_b64 = data["choices"][0]["message"].get("audio", {}).get("data")
    if not audio_b64:
        raise HTTPException(502, f"MiMo API 未返回音频: {json.dumps(data)[:300]}")
    return base64.b64decode(audio_b64)


async def tts_qwen_api(text: str) -> bytes:
    """DashScope qwen3-tts，预置音色（API 音色克隆需要公网可访问的音频 URL，此处用预置音色）。"""
    body = {
        "model": cfg("QWEN_TTS_API_MODEL", "qwen3-tts-flash"),
        "input": {"text": text, "voice": cfg("QWEN_TTS_API_VOICE", "Cherry"),
                  "language_type": "English"},
    }
    async with httpx.AsyncClient(timeout=300) as c:
        r = await c.post(
            "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
            headers={"Authorization": f"Bearer {cfg('DASHSCOPE_API_KEY')}"},
            json=body,
        )
        if r.status_code != 200:
            raise HTTPException(502, f"DashScope 出错 ({r.status_code}): {r.text[:300]}")
        data = r.json()
        audio = (data.get("output") or {}).get("audio") or {}
        if audio.get("url"):
            a = await c.get(audio["url"])
            return a.content
        if audio.get("data"):
            return base64.b64decode(audio["data"])
    raise HTTPException(502, f"DashScope 未返回音频: {json.dumps(data, ensure_ascii=False)[:300]}")


# ---- 语气 / 停顿 / 语速 ----

# Fish S2 支持文本内情感标记；⏸ 转成 (break)
FISH_EMOTION = {
    "开心": "(joyful)", "悲伤": "(sad)", "生气": "(angry)",
    "兴奋": "(excited)", "平静": "(relaxed)", "耳语": "(whispering)",
}
# Chatterbox 用 exaggeration（情感强度 0~1，默认 0.5）近似表达语气
CHATTERBOX_EXAG = {
    "开心": 0.65, "悲伤": 0.45, "生气": 0.8,
    "兴奋": 0.85, "平静": 0.3, "耳语": 0.35,
}


def change_speed(wav: bytes, speed: float) -> bytes:
    """ffmpeg atempo 变速不变调，适用于所有引擎的统一语速控制。"""
    if abs(speed - 1.0) < 0.01:
        return wav
    speed = max(0.5, min(2.0, speed))
    tmp_in = OUTPUTS_DIR / f"_spd_in_{uuid.uuid4().hex}.wav"
    tmp_out = OUTPUTS_DIR / f"_spd_out_{uuid.uuid4().hex}.wav"
    try:
        tmp_in.write_bytes(wav)
        proc = subprocess.run(
            ["ffmpeg", "-y", "-i", str(tmp_in), "-filter:a", f"atempo={speed}", str(tmp_out)],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            return wav  # 变速失败就返回原音频，不让整次生成失败
        return tmp_out.read_bytes()
    finally:
        tmp_in.unlink(missing_ok=True)
        tmp_out.unlink(missing_ok=True)


async def generate_tts(payload: dict) -> tuple[bytes, str, int]:
    engine = str(payload.get("engine") or "").strip()
    text = (payload.get("text") or "").strip()
    vid = payload.get("voice_id")
    language = str(payload.get("language") or "en")
    try:
        speed = float(payload.get("speed") or 1.0)
    except (TypeError, ValueError):
        speed = 1.0
    emotion = str(payload.get("emotion") or "").strip()
    style = str(payload.get("style") or "").strip()
    if not text:
        raise HTTPException(400, "text 为空")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(413, f"text 不能超过 {MAX_TEXT_CHARS} 个字符")
    if engine not in {*LOCAL_WORKERS, "mimo_api", "qwen_api"}:
        raise HTTPException(400, f"未知引擎: {engine}")

    # 停顿标记 ⏸ + 语气，按引擎转换
    if engine == "fish":
        text = text.replace("⏸", " (break) ")
        if emotion in FISH_EMOTION:
            text = FISH_EMOTION[emotion] + " " + text
    else:
        text = text.replace("⏸", "... ")

    wav_bytes, ref_text = b"", ""
    if engine != "qwen_api":  # qwen_api 用预置音色，不需要参考音频
        if not vid or not _voice_wav_path(vid).exists():
            raise HTTPException(400, "请先在页面上添加/选择一个参考音色")
        wav_bytes = _voice_wav_path(vid).read_bytes()
        try:
            ref_text = json.loads(_voice_meta_path(vid).read_text(encoding="utf-8")).get("ref_text", "")
        except Exception:
            ref_text = ""

    t0 = time.time()
    if engine in ("chatterbox", "qwen_local", "step_audio"):
        extra = {}
        if engine == "chatterbox" and emotion in CHATTERBOX_EXAG:
            extra["exaggeration"] = str(CHATTERBOX_EXAG[emotion])
        audio = await tts_local_worker(LOCAL_WORKERS[engine]["url"], text, language, wav_bytes, ref_text, extra)
    elif engine == "fish":
        audio = await tts_fish(text, wav_bytes, ref_text)
    elif engine == "mimo_api":
        # 小米支持自然语言风格描述：自定义描述 + 语气拼在一起
        parts = []
        if style:
            parts.append(style)
        if emotion:
            parts.append(f"用{emotion}的语气朗读")
        audio = await tts_mimo(text, wav_bytes, "，".join(parts))
    elif engine == "qwen_api":
        audio = await tts_qwen_api(text)
    audio = change_speed(audio, speed)
    return audio, engine, int((time.time() - t0) * 1000)


def normalize_public_prefix(value: str) -> str:
    value = str(value or "").strip()
    if not value or "://" in value or "\\" in value:
        return ""
    parts = [part for part in value.split("/") if part]
    if any(part in {".", ".."} for part in parts):
        return ""
    return "/" + "/".join(parts) if parts else ""


def public_prefix(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-prefix", "").split(",", 1)[0]
    return normalize_public_prefix(forwarded or cfg("PUBLIC_PREFIX"))


def save_output(audio: bytes, engine: str) -> str:
    fname = f"{time.strftime('%Y%m%d_%H%M%S')}_{engine}_{uuid.uuid4().hex[:6]}.wav"
    (OUTPUTS_DIR / fname).write_bytes(audio)
    return fname


@app.post("/api/tts")
async def tts(request: Request, payload: dict):
    audio, engine, elapsed_ms = await generate_tts(payload)
    fname = save_output(audio, engine)
    prefix = public_prefix(request)
    return {
        "ok": True,
        "engine": engine,
        "url": f"{prefix}/outputs/{fname}",
        "elapsed_ms": elapsed_ms,
    }


@app.get("/v1/models")
async def openai_models():
    available = await engines()
    now = int(time.time())
    return {
        "object": "list",
        "data": [
            {
                "id": f"tts-{item['id']}",
                "object": "model",
                "created": now,
                "owned_by": "local-tts-platform",
                "available": bool(item.get("available")),
            }
            for item in available
        ],
    }


@app.post("/v1/audio/speech")
async def openai_audio_speech(payload: dict):
    model = str(payload.get("model") or "tts-qwen_local").strip()
    engine = model[4:] if model.startswith("tts-") else model
    response_format = str(payload.get("response_format") or "wav").lower()
    if response_format not in {"wav", "wave"}:
        raise HTTPException(400, "response_format 目前仅支持 wav")
    audio, engine, elapsed_ms = await generate_tts({
        "engine": engine,
        "text": payload.get("input"),
        "voice_id": payload.get("voice"),
        "language": payload.get("language", "en"),
        "speed": payload.get("speed", 1.0),
        "emotion": payload.get("emotion", ""),
        "style": payload.get("instructions", payload.get("style", "")),
    })
    return Response(
        content=audio,
        media_type="audio/wav",
        headers={
            "Content-Disposition": "inline; filename=speech.wav",
            "X-TTS-Engine": engine,
            "X-TTS-Elapsed-Ms": str(elapsed_ms),
        },
    )


app.mount("/outputs", StaticFiles(directory=str(OUTPUTS_DIR)), name="outputs")
app.mount("/", StaticFiles(directory=str(Path(__file__).parent / "static"), html=True), name="static")
