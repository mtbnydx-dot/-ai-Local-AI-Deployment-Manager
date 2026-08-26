"""Step-Audio-EditX worker — runs INSIDE the Linux Docker container (vLLM required).

Mounted into /app of the Step-Audio-EditX image next to tts.py/tokenizer.py.
Model dirs are mounted at /model (Step-Audio-EditX) and /tokenizer (Step-Audio-Tokenizer).
Protocol: GET /health, POST /tts (multipart: text, language, ref_audio, ref_text).
"""

import asyncio
import os
import tempfile
import time

os.environ["VLLM_ATTENTION_BACKEND"] = "TRITON_ATTN"

import torchaudio
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

app = FastAPI(title="step-audio-worker")
_tts = None
_busy = False
_compute_lock = asyncio.Lock()

MODEL_PATH = os.environ.get("STEP_MODEL_PATH", "/model")
TOKENIZER_PATH = os.environ.get("STEP_TOKENIZER_PATH", "/tokenizer")
GPU_MEM_UTIL = float(os.environ.get("STEP_GPU_MEM_UTIL", "0.25"))
MAX_TEXT_CHARS = int(os.environ.get("TTS_WORKER_MAX_TEXT_CHARS", "10000"))
MAX_REFERENCE_BYTES = int(os.environ.get("TTS_WORKER_MAX_REFERENCE_BYTES", str(16 * 1024 * 1024)))


def get_tts():
    global _tts
    if _tts is None:
        from tokenizer import StepAudioTokenizer
        from tts import StepAudioTTS

        audio_tokenizer = StepAudioTokenizer(TOKENIZER_PATH, model_source="local")
        _tts = StepAudioTTS(
            MODEL_PATH,
            audio_tokenizer,
            model_source="local",
            gpu_memory_utilization=GPU_MEM_UTIL,
            max_model_len=3072,
            max_num_seqs=1,
        )
    return _tts


@app.get("/health")
def health():
    return {
        "status": "busy" if _busy else "ok",
        "engine": "step_audio",
        "model_loaded": _tts is not None,
        "busy": _busy,
    }


@app.post("/admin/load")
async def admin_load():
    global _busy
    async with _compute_lock:
        _busy = True
        try:
            await asyncio.to_thread(get_tts)
        finally:
            _busy = False
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


def synthesize(text: str, ref_text: str, audio: bytes) -> bytes:
    tts = get_tts()
    source = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    output_name = ""
    try:
        source.write(audio)
        source.close()
        wav, sample_rate = tts.clone(source.name, ref_text, text)
        output = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        output_name = output.name
        output.close()
        torchaudio.save(output_name, wav, sample_rate)
        with open(output_name, "rb") as handle:
            return handle.read()
    finally:
        try:
            os.unlink(source.name)
        except OSError:
            pass
        if output_name:
            try:
                os.unlink(output_name)
            except OSError:
                pass


@app.post("/tts")
async def tts_endpoint(
    text: str = Form(...),
    language: str = Form("auto"),
    ref_text: str = Form(""),
    ref_audio: UploadFile = File(...),
):
    global _busy
    text = text.strip()
    ref_text = ref_text.strip()
    if not text:
        raise HTTPException(400, "text is empty")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(413, "text is too long")
    if not ref_text:
        raise HTTPException(400, "Step-Audio-EditX requires ref_text")
    audio = await read_reference(ref_audio)
    started = time.perf_counter()
    async with _compute_lock:
        _busy = True
        try:
            result = await asyncio.to_thread(synthesize, text, ref_text, audio)
        finally:
            _busy = False
    return Response(
        content=result,
        media_type="audio/wav",
        headers={"X-TTS-Worker-Ms": str(round((time.perf_counter() - started) * 1000))},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=7014)
