"""Chatterbox Multilingual v3 worker.

Runs in the dedicated venv E:\\tts_runtime\\envs\\chatterbox.
Protocol: GET /health, POST /tts (multipart: text, language, ref_audio, ref_text).
Returns audio/wav bytes.
"""

import asyncio
import io
import os
import tempfile
import time
from pathlib import Path

RUNTIME_ROOT = Path(os.environ.get("TTS_RUNTIME_ROOT", r"E:\tts_runtime"))
os.environ.setdefault("HF_HOME", str(RUNTIME_ROOT / "hf"))

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

app = FastAPI(title="chatterbox-worker")
_model = None
_busy = False
_compute_lock = asyncio.Lock()
MAX_TEXT_CHARS = int(os.environ.get("TTS_WORKER_MAX_TEXT_CHARS", "10000"))
MAX_REFERENCE_BYTES = int(os.environ.get("TTS_WORKER_MAX_REFERENCE_BYTES", str(16 * 1024 * 1024)))

# gateway sends short codes; chatterbox uses its own ids
LANG_MAP = {"en": "en", "zh": "zh", "english": "en", "chinese": "zh"}


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
    lang = LANG_MAP.get(language.lower(), "en")
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
    language: str = Form("en"),
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
            result = await asyncio.to_thread(synthesize, text, language, audio, exaggeration)
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
