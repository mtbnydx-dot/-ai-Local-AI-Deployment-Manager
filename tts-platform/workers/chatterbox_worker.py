"""Chatterbox Multilingual v3 worker.

Runs in the dedicated venv <TTS_RUNTIME_ROOT>\\envs\\chatterbox.
Protocol: GET /health, POST /tts (multipart: text, language, ref_audio, ref_text).
Returns audio/wav bytes.
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

app = FastAPI(title="chatterbox-worker")
_model = None
_busy = False
_compute_lock = asyncio.Lock()
MAX_TEXT_CHARS = int(os.environ.get("TTS_WORKER_MAX_TEXT_CHARS", "10000"))
MAX_REFERENCE_BYTES = int(os.environ.get("TTS_WORKER_MAX_REFERENCE_BYTES", str(16 * 1024 * 1024)))

# Chatterbox Multilingual V3 native language ids.
SUPPORTED_LANGUAGES = {
    "ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it",
    "ja", "ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh",
}
LANG_MAP = {
    "chinese": "zh", "中文": "zh", "mandarin": "zh", "english": "en", "英语": "en",
    "japanese": "ja", "日语": "ja", "korean": "ko", "韩语": "ko", "german": "de", "德语": "de",
    "french": "fr", "法语": "fr", "spanish": "es", "西班牙语": "es", "italian": "it", "意大利语": "it",
    "portuguese": "pt", "葡萄牙语": "pt", "russian": "ru", "俄语": "ru", "arabic": "ar", "阿拉伯语": "ar",
    "hindi": "hi", "印地语": "hi", "turkish": "tr", "土耳其语": "tr", "dutch": "nl", "荷兰语": "nl",
    "polish": "pl", "波兰语": "pl", "swedish": "sv", "瑞典语": "sv", "swahili": "sw", "斯瓦希里语": "sw",
}


def resolve_language(value: str, text: str) -> str:
    key = str(value or "auto").strip().lower().replace("_", "-")
    code = LANG_MAP.get(key, key.split("-", 1)[0])
    if code == "auto":
        if any("\u4e00" <= char <= "\u9fff" for char in text):
            return "zh"
        if any("\u3040" <= char <= "\u30ff" for char in text):
            return "ja"
        if any("\uac00" <= char <= "\ud7af" for char in text):
            return "ko"
        if any("\u0400" <= char <= "\u04ff" for char in text):
            return "ru"
        if any("\u0600" <= char <= "\u06ff" for char in text):
            return "ar"
        if any("\u0900" <= char <= "\u097f" for char in text):
            return "hi"
        return "en"
    if code not in SUPPORTED_LANGUAGES:
        raise ValueError(f"Chatterbox V3 does not support language '{value}'. Choose another engine or a supported language code.")
    return code


def get_model():
    global _model
    if _model is None:
        import torch
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        device = "cuda" if torch.cuda.is_available() else "cpu"
        try:
            _model = ChatterboxMultilingualTTS.from_pretrained(device=device, t3_model="v3")
        except TypeError:
            # older package without the t3_model kwarg
            _model = ChatterboxMultilingualTTS.from_pretrained(device=device)
    return _model


@app.get("/health")
def health():
    return {
        "status": "busy" if _busy else "ok",
        "engine": "chatterbox",
        "model_loaded": _model is not None,
        "busy": _busy,
    }


def unload_model() -> None:
    global _model
    old = _model
    _model = None
    del old
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
        await asyncio.to_thread(unload_model)
    return health()


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


def synthesize(text: str, language: str, audio: bytes, exaggeration: float) -> bytes:
    import torchaudio

    model = get_model()
    try:
        lang = resolve_language(language, text)
    except ValueError as exc:
        raise RuntimeError(str(exc)) from exc
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    try:
        tmp.write(audio)
        tmp.close()
        wav = model.generate(
            text,
            language_id=lang,
            audio_prompt_path=tmp.name,
            exaggeration=max(0.0, min(1.0, exaggeration)),
        )
        buf = io.BytesIO()
        torchaudio.save(buf, wav.cpu(), model.sr, format="wav")
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
    exaggeration: float = Form(0.5),
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
            try:
                result = await asyncio.to_thread(synthesize, text, language, audio, exaggeration)
            except RuntimeError as exc:
                if "does not support language" in str(exc):
                    raise HTTPException(422, str(exc)) from exc
                raise
        finally:
            _busy = False
    return Response(
        content=result,
        media_type="audio/wav",
        headers={"X-TTS-Worker-Ms": str(round((time.perf_counter() - started) * 1000))},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=7011)
