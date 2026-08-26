"""Step-Audio-EditX worker — runs INSIDE the Linux Docker container (vLLM required).

Mounted into /app of the Step-Audio-EditX image next to tts.py/tokenizer.py.
Model dirs are mounted at /model (Step-Audio-EditX) and /tokenizer (Step-Audio-Tokenizer).
Protocol: GET /health, POST /tts (multipart: text, language, ref_audio, ref_text).
"""

import os
import tempfile

os.environ["VLLM_ATTENTION_BACKEND"] = "TRITON_ATTN"

import torchaudio
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import Response

app = FastAPI(title="step-audio-worker")
_tts = None

MODEL_PATH = os.environ.get("STEP_MODEL_PATH", "/model")
TOKENIZER_PATH = os.environ.get("STEP_TOKENIZER_PATH", "/tokenizer")
GPU_MEM_UTIL = float(os.environ.get("STEP_GPU_MEM_UTIL", "0.25"))


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
    return {"status": "ok", "engine": "step_audio", "model_loaded": _tts is not None}


@app.post("/tts")
async def tts_endpoint(
    text: str = Form(...),
    language: str = Form("en"),
    ref_text: str = Form(""),
    ref_audio: UploadFile = File(...),
):
    tts = get_tts()
    if not ref_text.strip():
        return Response(
            content=b'{"error": "Step-Audio-EditX requires ref_text (transcript of the reference audio)"}',
            media_type="application/json",
            status_code=400,
        )
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    try:
        tmp.write(await ref_audio.read())
        tmp.close()
        wav, sr = tts.clone(tmp.name, ref_text.strip(), text)
        out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        out.close()
        torchaudio.save(out.name, wav, sr)
        with open(out.name, "rb") as f:
            data = f.read()
        os.unlink(out.name)
        return Response(content=data, media_type="audio/wav")
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=7014)
