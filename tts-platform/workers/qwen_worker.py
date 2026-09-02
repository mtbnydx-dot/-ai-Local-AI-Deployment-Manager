"""Qwen3-TTS local worker (voice clone with Qwen/Qwen3-TTS-12Hz-1.7B-Base).

Runs in venv <TTS_RUNTIME_ROOT>\\envs\\qwen.
Protocol: GET /health, POST /tts (multipart: text, language, ref_audio, ref_text).
"""

import asyncio
import gc
import io
import os
import tempfile
import time
from pathlib import Path

RUNTIME_ROOT = Path(os.environ.get("TTS_RUNTIME_ROOT") or Path(__file__).resolve().parents[2] / "tts-runtime")
os.environ.setdefault("HF_HOME", str(RUNTIME_ROOT / "hf"))

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

app = FastAPI(title="qwen-tts-worker")
_model = None
_busy = False
_compute_lock = asyncio.Lock()
MAX_TEXT_CHARS = int(os.environ.get("TTS_WORKER_MAX_TEXT_CHARS", "10000"))
MAX_REFERENCE_BYTES = int(os.environ.get("TTS_WORKER_MAX_REFERENCE_BYTES", str(16 * 1024 * 1024)))

MODEL_ID = os.environ.get("QWEN_TTS_MODEL", str(RUNTIME_ROOT / "models" / "Qwen3-TTS-1.7B-Base"))
LANG_MAP = {
    "auto": "Auto", "zh": "Chinese", "chinese": "Chinese", "中文": "Chinese",
    "en": "English", "english": "English", "英语": "English",
    "ja": "Japanese", "japanese": "Japanese", "日语": "Japanese",
    "ko": "Korean", "korean": "Korean", "韩语": "Korean",
    "de": "German", "german": "German", "德语": "German",
    "fr": "French", "french": "French", "法语": "French",
    "ru": "Russian", "russian": "Russian", "俄语": "Russian",
    "pt": "Portuguese", "portuguese": "Portuguese", "葡萄牙语": "Portuguese",
    "es": "Spanish", "spanish": "Spanish", "西班牙语": "Spanish",
    "it": "Italian", "italian": "Italian", "意大利语": "Italian",
}


def resolve_language(value: str) -> str:
    key = str(value or "auto").strip().lower().replace("_", "-")
    return LANG_MAP.get(key, LANG_MAP.get(key.split("-", 1)[0], "Auto"))


def get_model():
    global _model
    if _model is None:
        import torch
        from qwen_tts import Qwen3TTSModel

        # no flash-attn on Windows -> sdpa
        _model = Qwen3TTSModel.from_pretrained(
            MODEL_ID,
            device_map="cuda:0",
            dtype=torch.bfloat16,
            attn_implementation="sdpa",
        )
    return _model


@app.get("/health")
def health():
    return {
        "status": "busy" if _busy else "ok",
        "engine": "qwen_local",
        "model_loaded": _model is not None,
        "busy": _busy,
    }


def unload_models() -> None:
    global _model, _trans
    model, translator = _model, _trans
    _model = None
    _trans = None
    del model, translator
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


@app.post("/admin/load")
async def admin_load():
    global _busy
    async with _compute_lock:
        _busy = True
        try:
            await asyncio.to_thread(get_model)
        finally:
            _busy = False
    return health()


@app.post("/admin/unload")
async def admin_unload():
    if _busy:
        raise HTTPException(409, "model is busy")
    async with _compute_lock:
        await asyncio.to_thread(unload_models)
    return health()


# ---------------- 本地翻译（Qwen3-4B-Instruct，无 API 时的兜底） ----------------
_trans = None
TRANS_MODEL_ID = os.environ.get("LOCAL_TRANSLATE_MODEL", "Qwen/Qwen3-4B-Instruct-2507")
def get_translator():
    global _trans
    if _trans is None:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        tok = AutoTokenizer.from_pretrained(TRANS_MODEL_ID)
        mdl = AutoModelForCausalLM.from_pretrained(
            TRANS_MODEL_ID, dtype=torch.bfloat16, device_map="cuda:0"
        )
        _trans = (tok, mdl)
    return _trans


def translate_sync(text: str, target_language: str) -> str:
    tok, mdl = get_translator()
    target = str(target_language or "English").strip()
    system = (
        f"You are a professional translator. Translate the user's text into {target}. "
        "Keep the meaning faithful and make it natural for spoken narration. "
        "Output only the translation, with no notes or explanation."
    )
    msgs = [{"role": "system", "content": system}, {"role": "user", "content": text}]
    inputs = tok.apply_chat_template(
        msgs, add_generation_prompt=True, return_tensors="pt"
    ).to(mdl.device)
    out = mdl.generate(inputs, max_new_tokens=2048, do_sample=False)
    return tok.decode(out[0][inputs.shape[1]:], skip_special_tokens=True).strip()


@app.post("/translate")
async def translate(payload: dict):
    global _busy
    text = str(payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text is empty")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(413, "text is too long")
    target_language = str(payload.get("target_language") or "English").strip()
    async with _compute_lock:
        _busy = True
        try:
            translated = await asyncio.to_thread(translate_sync, text, target_language)
        finally:
            _busy = False
    result = {"translation": translated, "target_language": target_language, "model": "Qwen3-4B-Instruct (本地)"}
    if target_language.lower().startswith(("en", "english")):
        result["english"] = translated
    return result


async def read_reference(upload: UploadFile) -> bytes:
    chunks = []
    total = 0
    while True:
        chunk = await upload.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_REFERENCE_BYTES:
            raise HTTPException(413, "reference audio is too large")
        chunks.append(chunk)
    if not chunks:
        raise HTTPException(400, "reference audio is empty")
    return b"".join(chunks)


def synthesize(text: str, language: str, ref_text: str, audio: bytes) -> bytes:
    import soundfile as sf

    model = get_model()
    lang = resolve_language(language)
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    try:
        tmp.write(audio)
        tmp.close()
        kwargs = dict(text=text, language=lang, ref_audio=tmp.name)
        if ref_text.strip():
            kwargs["ref_text"] = ref_text.strip()
        else:
            kwargs["x_vector_only_mode"] = True
        try:
            wavs, sr = model.generate_voice_clone(**kwargs)
        except TypeError:
            kwargs.pop("x_vector_only_mode", None)
            wavs, sr = model.generate_voice_clone(**kwargs)
        buf = io.BytesIO()
        sf.write(buf, wavs[0], sr, format="WAV")
        return buf.getvalue()
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


@app.post("/tts")
async def tts(
    text: str = Form(...),
    language: str = Form("auto"),
    ref_text: str = Form(""),
    ref_audio: UploadFile = File(...),
):
    global _busy
    text = text.strip()
    if not text:
        raise HTTPException(400, "text is empty")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(413, "text is too long")
    audio = await read_reference(ref_audio)
    started = time.perf_counter()
    async with _compute_lock:
        _busy = True
        try:
            result = await asyncio.to_thread(synthesize, text, language, ref_text, audio)
        finally:
            _busy = False
    return Response(
        content=result,
        media_type="audio/wav",
        headers={"X-TTS-Worker-Ms": str(round((time.perf_counter() - started) * 1000))},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=7012)
