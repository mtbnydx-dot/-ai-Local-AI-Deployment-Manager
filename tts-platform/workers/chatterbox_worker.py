"""Chatterbox Multilingual v3 worker.

Runs in the dedicated venv E:\\tts_runtime\\envs\\chatterbox.
Protocol: GET /health, POST /tts (multipart: text, language, ref_audio, ref_text).
Returns audio/wav bytes.
"""

import io
import os
import tempfile
from pathlib import Path

RUNTIME_ROOT = Path(os.environ.get("TTS_RUNTIME_ROOT", r"E:\tts_runtime"))
os.environ.setdefault("HF_HOME", str(RUNTIME_ROOT / "hf"))

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import Response

app = FastAPI(title="chatterbox-worker")
_model = None

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
    return {"status": "ok", "engine": "chatterbox", "model_loaded": _model is not None}


@app.post("/tts")
async def tts(
    text: str = Form(...),
    language: str = Form("en"),
    ref_text: str = Form(""),
    exaggeration: float = Form(0.5),
    ref_audio: UploadFile = File(...),
):
    import torchaudio

    model = get_model()
    lang = LANG_MAP.get(language.lower(), "en")

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    try:
        tmp.write(await ref_audio.read())
        tmp.close()
        wav = model.generate(
            text, language_id=lang, audio_prompt_path=tmp.name,
            exaggeration=max(0.0, min(1.0, exaggeration)),
        )
        buf = io.BytesIO()
        torchaudio.save(buf, wav.cpu(), model.sr, format="wav")
        return Response(content=buf.getvalue(), media_type="audio/wav")
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=7011)
