"""Qwen3-TTS VoiceDesign worker: design a voice from text instructions."""

import asyncio
import gc
import io
import os
import time
from pathlib import Path

RUNTIME_ROOT = Path(os.environ.get("TTS_RUNTIME_ROOT") or Path(__file__).resolve().parents[2] / "tts-runtime")
os.environ.setdefault("HF_HOME", str(RUNTIME_ROOT / "hf"))

from fastapi import FastAPI, Form, HTTPException
from fastapi.responses import Response

app = FastAPI(title="qwen-voice-design-worker")
_model = None
_busy = False
_compute_lock = asyncio.Lock()
MAX_TEXT_CHARS = int(os.environ.get("TTS_WORKER_MAX_TEXT_CHARS", "10000"))
MODEL_ID = os.environ.get("QWEN_DESIGN_MODEL", str(RUNTIME_ROOT / "models" / "Qwen3-TTS-12Hz-1.7B-VoiceDesign"))

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

        _model = Qwen3TTSModel.from_pretrained(
            MODEL_ID,
            device_map="cuda:0",
            dtype=torch.bfloat16,
            attn_implementation="sdpa",
        )
    return _model


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


@app.get("/health")
def health():
    return {"status": "busy" if _busy else "ok", "engine": "qwen_voice_design", "model_loaded": _model is not None, "busy": _busy}


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


def synthesize(text: str, language: str, instruction: str) -> bytes:
    import soundfile as sf

    model = get_model()
    prompt = instruction.strip() or "A clear, natural, expressive adult voice with studio-quality delivery."
    wavs, sample_rate = model.generate_voice_design(text=text, language=resolve_language(language), instruct=prompt)
    output = io.BytesIO()
    sf.write(output, wavs[0], sample_rate, format="WAV")
    return output.getvalue()


@app.post("/tts")
async def tts(text: str = Form(...), language: str = Form("auto"), style: str = Form(""), emotion: str = Form("")):
    global _busy
    text = text.strip()
    if not text:
        raise HTTPException(400, "text is empty")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(413, "text is too long")
    instruction = "；".join(item for item in (style.strip(), f"情绪：{emotion.strip()}" if emotion.strip() else "") if item)
    started = time.perf_counter()
    async with _compute_lock:
        _busy = True
        try:
            result = await asyncio.to_thread(synthesize, text, language, instruction)
        finally:
            _busy = False
    return Response(content=result, media_type="audio/wav", headers={"X-TTS-Worker-Ms": str(round((time.perf_counter() - started) * 1000))})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=7016)
