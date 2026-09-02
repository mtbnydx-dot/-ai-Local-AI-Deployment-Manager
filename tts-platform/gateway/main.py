r"""TTS aggregation gateway and local voice workstation API.

Run from this directory with::

    <TTS_RUNTIME_ROOT>\envs\gateway\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 7000
"""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from tts_catalog import COMMON_LANGUAGES
from tts_config import cfg, settings
from tts_jobs import job_manager
from tts_schemas import BatchSynthesisRequest, OpenAISpeechRequest, SynthesisRequest, TranslateRequest, VoiceUpdate
from tts_services import (
    ENGINE_CAPABILITIES,
    TtsError,
    engine_registry,
    normalize_reference_audio,
    synthesis_service,
    translation_service,
)
from tts_storage import output_store, voice_store
from tts_lifecycle import LifecycleError, model_lifecycle


STARTED_AT = time.time()
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._-]{8,80}$")


def _configure_logging() -> logging.Logger:
    gateway_logger = logging.getLogger("tts.gateway")
    gateway_logger.setLevel(logging.INFO)
    if not any(isinstance(handler, RotatingFileHandler) for handler in gateway_logger.handlers):
        handler = RotatingFileHandler(
            settings.logs_dir / "gateway.log",
            maxBytes=5 * 1024 * 1024,
            backupCount=4,
            encoding="utf-8",
        )
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        gateway_logger.addHandler(handler)
    return gateway_logger


logger = _configure_logging()


@asynccontextmanager
async def lifespan(_: FastAPI):
    indexed = await asyncio.to_thread(output_store.index_existing_outputs)
    if indexed:
        logger.info("indexed_existing_outputs count=%s", indexed)
    yield
    await job_manager.shutdown()
    await engine_registry.close()
    await synthesis_service.close()


app = FastAPI(
    title="TTS 语音工作台",
    version=settings.version,
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)


def _request_id(request: Request) -> str:
    return str(getattr(request.state, "request_id", "") or "")


def _error_payload(request: Request, detail: str, code: str, **extra: Any) -> dict[str, Any]:
    return {"detail": detail, "code": code, "request_id": _request_id(request), **extra}


def _presented_api_key(request: Request) -> str:
    authorization = request.headers.get("authorization", "").strip()
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return request.headers.get("x-api-key", "").strip()


@app.middleware("http")
async def security_and_observability(request: Request, call_next):
    started = time.perf_counter()
    incoming_id = request.headers.get("x-request-id", "").strip()
    request.state.request_id = incoming_id if REQUEST_ID_RE.fullmatch(incoming_id) else uuid.uuid4().hex

    expected = cfg("TTS_API_KEY")
    protected = request.url.path.startswith(("/api/", "/v1/", "/outputs/"))
    if expected and protected:
        presented = _presented_api_key(request)
        if not presented or not secrets.compare_digest(presented.encode("utf-8"), expected.encode("utf-8")):
            response: Response = JSONResponse(
                _error_payload(request, "Missing or invalid TTS API key.", "unauthorized"),
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
        else:
            response = await call_next(request)
    else:
        response = await call_next(request)

    response.headers["X-Request-ID"] = request.state.request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(self), geolocation=()"
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; "
        "frame-ancestors 'none'; form-action 'self'"
    )
    if request.url.path.startswith(("/api/", "/v1/")):
        response.headers["Cache-Control"] = "no-store"
    duration_ms = round((time.perf_counter() - started) * 1000)
    logger.info(
        "request id=%s method=%s path=%s status=%s duration_ms=%s",
        request.state.request_id,
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
    )
    return response


@app.exception_handler(TtsError)
async def handle_tts_error(request: Request, exc: TtsError):
    return JSONResponse(_error_payload(request, exc.detail, exc.code), status_code=exc.status_code)


@app.exception_handler(LifecycleError)
async def handle_lifecycle_error(request: Request, exc: LifecycleError):
    return JSONResponse(_error_payload(request, exc.detail, exc.code), status_code=exc.status_code)


@app.exception_handler(StarletteHTTPException)
async def handle_http_error(request: Request, exc: StarletteHTTPException):
    detail = str(exc.detail or "Request failed")
    code = "not_found" if exc.status_code == 404 else "http_error"
    return JSONResponse(_error_payload(request, detail, code), status_code=exc.status_code, headers=exc.headers)


@app.exception_handler(RequestValidationError)
async def handle_validation_error(request: Request, exc: RequestValidationError):
    errors = [
        {"field": ".".join(str(part) for part in item.get("loc", [])[1:]), "message": item.get("msg", "参数无效"), "type": item.get("type", "")}
        for item in exc.errors()[:12]
    ]
    return JSONResponse(
        _error_payload(request, "请求参数无效", "validation_error", errors=errors),
        status_code=422,
    )


@app.exception_handler(Exception)
async def handle_unexpected_error(request: Request, exc: Exception):
    logger.exception("unhandled_error id=%s path=%s", _request_id(request), request.url.path, exc_info=exc)
    return JSONResponse(_error_payload(request, "服务内部错误，请查看网关日志", "internal_error"), status_code=500)


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


async def _read_upload_limited(upload: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > settings.max_upload_bytes:
            raise TtsError(413, f"参考音频不能超过 {settings.max_upload_bytes // (1024 * 1024)}MB", "audio_too_large")
        chunks.append(chunk)
    return b"".join(chunks)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "tts-gateway",
        "version": settings.version,
        "uptime_seconds": round(time.time() - STARTED_AT, 1),
        "jobs": job_manager.snapshot(),
    }


@app.get("/api/system")
async def system_info():
    storage = await asyncio.to_thread(output_store.stats)
    return {
        "version": settings.version,
        "uptime_seconds": round(time.time() - STARTED_AT, 1),
        "authenticated": bool(cfg("TTS_API_KEY")),
        "ffmpeg_available": bool(shutil.which("ffmpeg")),
        "limits": {
            "upload_bytes": settings.max_upload_bytes,
            "text_chars": settings.max_text_chars,
            "translate_chars": settings.max_translate_chars,
            "style_chars": settings.max_style_chars,
            "batch_engines": settings.max_batch_engines,
            "concurrent_jobs": settings.max_concurrent_jobs,
        },
        "storage": storage,
        "jobs": job_manager.snapshot(),
        "model_management": {"local_only": True, "actions": ["install", "start", "wake", "unload", "stop"]},
        "endpoints": {
            "openai": "openai/v1",
            "speech": "openai/v1/audio/speech",
            "models": "openai/v1/models",
        },
    }


@app.get("/api/engines")
async def engines(refresh: bool = Query(default=False)):
    return await engine_registry.list(refresh=refresh)


@app.get("/api/languages")
async def languages():
    return {
        "items": COMMON_LANGUAGES,
        "free_form": True,
        "hint": "可输入任意 BCP-47 代码或语种名称；最终原生支持范围由所选模型决定。",
    }


@app.get("/api/models")
async def model_catalog(refresh: bool = Query(default=False)):
    engine_states = await engine_registry.list(refresh=refresh)
    resources = await asyncio.to_thread(model_lifecycle.resources)
    return {"items": model_lifecycle.catalog(engine_states), "resources": resources, "local_actions_only": True}


@app.post("/api/models/{model_id}/actions/{action}", status_code=202)
async def model_action(model_id: str, action: str):
    operation = model_lifecycle.begin(model_id, action)
    engine_registry.invalidate()
    return {"accepted": True, "model_id": model_id, "operation": operation}


@app.post("/api/voices", status_code=201)
async def add_voice(
    file: UploadFile = File(...),
    name: str = Form("我的音色", max_length=120),
    ref_text: str = Form("", max_length=4_000),
):
    uploaded = await _read_upload_limited(file)
    wav = await normalize_reference_audio(uploaded, file.filename or "reference.audio")
    return await asyncio.to_thread(voice_store.create, name, ref_text, wav)


@app.get("/api/voices")
async def list_voices():
    return await asyncio.to_thread(voice_store.list)


@app.patch("/api/voices/{voice_id}")
async def update_voice(voice_id: str, payload: VoiceUpdate):
    try:
        updated = await asyncio.to_thread(voice_store.update, voice_id, name=payload.name, ref_text=payload.ref_text)
    except ValueError as exc:
        raise TtsError(400, str(exc), "invalid_voice_id") from exc
    if updated is None:
        raise TtsError(404, "音色不存在", "voice_not_found")
    return updated


@app.delete("/api/voices/{voice_id}")
async def delete_voice(voice_id: str):
    try:
        deleted = await asyncio.to_thread(voice_store.delete, voice_id)
    except ValueError as exc:
        raise TtsError(400, str(exc), "invalid_voice_id") from exc
    if not deleted:
        raise TtsError(404, "音色不存在", "voice_not_found")
    return {"ok": True, "id": voice_id}


@app.get("/api/voices/{voice_id}/audio")
async def voice_audio(voice_id: str):
    try:
        path = voice_store.audio_path(voice_id)
    except ValueError as exc:
        raise TtsError(400, str(exc), "invalid_voice_id") from exc
    if not path.exists():
        raise TtsError(404, "音色不存在", "voice_not_found")
    return FileResponse(path, media_type="audio/wav", filename=f"voice-{voice_id}.wav", content_disposition_type="inline")


@app.post("/api/translate")
async def translate(payload: TranslateRequest):
    return await translation_service.translate(payload)


async def generate_tts(payload: dict[str, Any]) -> tuple[bytes, str, int]:
    synthesis = SynthesisRequest.model_validate(payload)
    audio, engine, elapsed_ms, _ = await synthesis_service.generate(synthesis)
    return audio, engine, elapsed_ms


@app.post("/api/tts")
async def legacy_tts(request: Request, payload: SynthesisRequest):
    audio, engine, elapsed_ms, warning = await synthesis_service.generate(payload)
    output = await asyncio.to_thread(
        output_store.create,
        audio,
        payload=payload.model_dump(),
        engine=engine,
        elapsed_ms=elapsed_ms,
        warning=warning,
    )
    prefix = public_prefix(request)
    return {
        "ok": True,
        "engine": engine,
        "url": f"{prefix}/api/outputs/{output['id']}/audio",
        "elapsed_ms": elapsed_ms,
        "warning": warning,
        "output": output,
    }


@app.post("/api/jobs", status_code=202)
async def create_jobs(payload: BatchSynthesisRequest):
    jobs = job_manager.create_batch(payload)
    return {"items": [job.public() for job in jobs], "counts": job_manager.snapshot()}


@app.get("/api/jobs")
async def list_jobs(limit: int = Query(default=50, ge=1, le=200), status: str = Query(default="", max_length=24)):
    return {"items": job_manager.list(limit=limit, status=status), "counts": job_manager.snapshot()}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job = job_manager.get(job_id)
    if job is None:
        raise TtsError(404, "任务不存在", "job_not_found")
    return job.public()


@app.delete("/api/jobs/{job_id}")
async def cancel_job(job_id: str):
    job = job_manager.cancel(job_id)
    if job is None:
        raise TtsError(404, "任务不存在", "job_not_found")
    return job.public()


@app.post("/api/jobs/{job_id}/retry", status_code=202)
async def retry_job(job_id: str):
    job = job_manager.retry(job_id)
    if job is None:
        raise TtsError(409, "只有失败或已取消的任务可以重试", "job_not_retryable")
    return job.public()


@app.get("/api/outputs")
async def list_outputs(
    limit: int = Query(default=30, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    engine: str = Query(default="", max_length=64),
    query: str = Query(default="", max_length=120),
):
    return await asyncio.to_thread(output_store.list, limit=limit, offset=offset, engine=engine, query=query)


@app.get("/api/outputs/{output_id}")
async def output_metadata(output_id: str):
    output = await asyncio.to_thread(output_store.get, output_id)
    if output is None:
        raise TtsError(404, "生成记录不存在", "output_not_found")
    return output


@app.get("/api/outputs/{output_id}/audio")
async def output_audio(output_id: str, download: bool = Query(default=False)):
    output = await asyncio.to_thread(output_store.get, output_id)
    path = await asyncio.to_thread(output_store.audio_path, output_id)
    if output is None or path is None or not path.exists():
        raise TtsError(404, "音频文件不存在", "output_not_found")
    return FileResponse(
        path,
        media_type="audio/wav",
        filename=output["filename"],
        content_disposition_type="attachment" if download else "inline",
    )


@app.delete("/api/outputs/{output_id}")
async def delete_output(output_id: str):
    deleted = await asyncio.to_thread(output_store.delete, output_id)
    if not deleted:
        raise TtsError(404, "生成记录不存在", "output_not_found")
    return {"ok": True, "id": output_id}


@app.get("/v1/models")
async def openai_models():
    available = await engine_registry.list()
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
                "capabilities": ENGINE_CAPABILITIES[item["id"]],
            }
            for item in available
        ],
    }


@app.post("/v1/audio/speech")
async def openai_audio_speech(request: Request, payload: OpenAISpeechRequest):
    response_format = payload.response_format.lower()
    if response_format not in {"wav", "wave"}:
        raise TtsError(400, "response_format 目前仅支持 wav", "unsupported_audio_format")
    engine = payload.model[4:] if payload.model.startswith("tts-") else payload.model
    synthesis = SynthesisRequest(
        engine=engine,
        text=payload.input,
        voice_id=payload.voice,
        language=payload.language,
        speed=payload.speed,
        emotion=payload.emotion,
        style=payload.instructions,
    )
    audio, engine, elapsed_ms, warning = await synthesis_service.generate(synthesis)
    headers = {
        "Content-Disposition": "inline; filename=speech.wav",
        "X-TTS-Engine": engine,
        "X-TTS-Elapsed-Ms": str(elapsed_ms),
        "X-TTS-Warning": warning.encode("ascii", "ignore").decode("ascii")[:200] if warning else "",
        "X-Request-ID": _request_id(request),
    }
    return Response(content=audio, media_type="audio/wav", headers=headers)


# Compatibility path for previously generated URLs. New clients use /api/outputs/{id}/audio.
app.mount("/outputs", StaticFiles(directory=str(settings.outputs_dir)), name="outputs")
app.mount("/", StaticFiles(directory=str(Path(__file__).parent / "static"), html=True), name="static")
