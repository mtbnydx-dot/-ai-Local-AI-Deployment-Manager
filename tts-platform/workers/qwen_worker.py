"""Qwen3-TTS local worker (voice clone with Qwen/Qwen3-TTS-12Hz-1.7B-Base).

Runs in venv E:\\tts_runtime\\envs\\qwen.
Protocol: GET /health, POST /tts (multipart: text, language, ref_audio, ref_text).
"""

import io
import os
import tempfile
from pathlib import Path

RUNTIME_ROOT = Path(os.environ.get("TTS_RUNTIME_ROOT", r"E:\tts_runtime"))
os.environ.setdefault("HF_HOME", str(RUNTIME_ROOT / "hf"))

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import Response

app = FastAPI(title="qwen-tts-worker")
_model = None

MODEL_ID = os.environ.get("QWEN_TTS_MODEL", str(RUNTIME_ROOT / "models" / "Qwen3-TTS-1.7B-Base"))
LANG_MAP = {"en": "English", "zh": "Chinese", "english": "English", "chinese": "Chinese"}


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
    return {"status": "ok", "engine": "qwen_local", "model_loaded": _model is not None}


# ---------------- 本地翻译（Qwen3-4B-Instruct，无 API 时的兜底） ----------------
_trans = None
TRANS_MODEL_ID = os.environ.get("LOCAL_TRANSLATE_MODEL", "Qwen/Qwen3-4B-Instruct-2507")
TRANS_SYS = (
    "You are a professional translator. Translate the user's Chinese text into "
    "natural, fluent spoken English suitable for reading aloud in a class presentation. "
    "Keep the meaning faithful, use simple clear sentences. "
    "Output ONLY the English translation, nothing else."
)


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


@app.post("/translate")
def translate(payload: dict):
    text = (payload.get("text") or "").strip()
    if not text:
        return {"error": "empty text"}
    tok, mdl = get_translator()
    msgs = [{"role": "system", "content": TRANS_SYS}, {"role": "user", "content": text}]
    inputs = tok.apply_chat_template(
        msgs, add_generation_prompt=True, return_tensors="pt"
    ).to(mdl.device)
    out = mdl.generate(inputs, max_new_tokens=2048, do_sample=False)
    english = tok.decode(out[0][inputs.shape[1]:], skip_special_tokens=True).strip()
    return {"english": english, "model": "Qwen3-4B-Instruct (本地)"}


@app.post("/tts")
async def tts(
    text: str = Form(...),
    language: str = Form("en"),
    ref_text: str = Form(""),
    ref_audio: UploadFile = File(...),
):
    import soundfile as sf

    model = get_model()
    lang = LANG_MAP.get(language.lower(), "English")

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    try:
        tmp.write(await ref_audio.read())
        tmp.close()
        kwargs = dict(text=text, language=lang, ref_audio=tmp.name)
        if ref_text.strip():
            kwargs["ref_text"] = ref_text.strip()
        else:
            # Base model can run x-vector-only cloning without a transcript
            kwargs["x_vector_only_mode"] = True
        try:
            wavs, sr = model.generate_voice_clone(**kwargs)
        except TypeError:
            kwargs.pop("x_vector_only_mode", None)
            wavs, sr = model.generate_voice_clone(**kwargs)
        buf = io.BytesIO()
        sf.write(buf, wavs[0], sr, format="WAV")
        return Response(content=buf.getvalue(), media_type="audio/wav")
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=7012)
