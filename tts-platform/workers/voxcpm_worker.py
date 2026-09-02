"""VoxCPM 2 worker with optional voice prompt and text-based voice design."""

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

app = FastAPI(title="voxcpm2-worker")
_model = None
_busy = False
_compute_lock = asyncio.Lock()
MAX_TEXT_CHARS = int(os.environ.get("TTS_WORKER_MAX_TEXT_CHARS", "10000"))
MAX_REFERENCE_BYTES = int(os.environ.get("TTS_WORKER_MAX_REFERENCE_BYTES", str(16 * 1024 * 1024)))
MODEL_ID = os.environ.get("VOXCPM_MODEL", str(RUNTIME_ROOT / "models" / "VoxCPM2"))


def get_model():
    global _model
    if _model is None:
        from voxcpm import VoxCPM
        _model = VoxCPM.from_pretrained(MODEL_ID, load_denoiser=False)
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
    return {"status": "busy" if _busy else "ok", "engine": "voxcpm2", "model_loaded": _model is not None, "busy": _busy}


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


async def read_optional_reference(upload: UploadFile | None) -> bytes:
    if upload is None:
        return b""
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
    return b"".join(chunks)


def synthesize(text: str, style: str, audio: bytes, ref_text: str) -> bytes:
    import numpy as np
    import soundfile as sf

    model = get_model()
    prompt_text = f"({style.strip()}){text}" if style.strip() else text
    reference_name = ""
    try:
        kwargs = {"text": prompt_text}
        if audio:
            reference = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            reference.write(audio)
            reference.close()
            reference_name = reference.name
            kwargs["reference_wav_path"] = reference_name
            if ref_text.strip():
                kwargs["prompt_wav_path"] = reference_name
                kwargs["prompt_text"] = ref_text.strip()
        waveform = model.generate(**kwargs)
        if isinstance(waveform, tuple):
            waveform, sample_rate = waveform[0], int(waveform[1])
        else:
            sample_rate = int(getattr(getattr(model, "tts_model", None), "sample_rate", 44_100))
        if hasattr(waveform, "detach"):
            waveform = waveform.detach().float().cpu().numpy()
        waveform = np.asarray(waveform).squeeze()
        output = io.BytesIO()
        sf.write(output, waveform, sample_rate, format="WAV")
        return output.getvalue()
    finally:
        if reference_name:
            try:
                os.unlink(reference_name)
            except OSError:
                pass


@app.post("/tts")
async def tts(
    text: str = Form(...),
    language: str = Form("auto"),
    style: str = Form(""),
    emotion: str = Form(""),
    ref_text: str = Form(""),
    ref_audio: UploadFile | None = File(None),
):
    global _busy
    text = text.strip()
    if not text:
        raise HTTPException(400, "text is empty")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(413, "text is too long")
    audio = await read_optional_reference(ref_audio)
    instructions = "；".join(item for item in (style.strip(), f"情绪：{emotion.strip()}" if emotion.strip() else "") if item)
    started = time.perf_counter()
    async with _compute_lock:
        _busy = True
        try:
            result = await asyncio.to_thread(synthesize, text, instructions, audio, ref_text)
        finally:
            _busy = False
    return Response(content=result, media_type="audio/wav", headers={"X-TTS-Worker-Ms": str(round((time.perf_counter() - started) * 1000))})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=7015)
