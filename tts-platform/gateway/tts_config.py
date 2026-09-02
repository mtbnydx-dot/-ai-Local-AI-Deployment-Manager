"""Configuration and filesystem boundaries for the TTS gateway."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values


ROOT = Path(__file__).resolve().parent.parent
_ENV_FILE = Path(os.environ.get("TTS_ENV_FILE") or ROOT / ".env").expanduser()
if not _ENV_FILE.is_absolute():
    _ENV_FILE = ROOT / _ENV_FILE
_DOTENV = {**dotenv_values(_ENV_FILE.resolve())}


def cfg(key: str, default: str = "") -> str:
    value = os.environ.get(key)
    if value is None or not str(value).strip():
        value = _DOTENV.get(key, default)
    return str(value or default).strip()


def default_runtime_root() -> Path:
    ai_root = cfg("AI_ROOT")
    base = Path(ai_root).expanduser() if ai_root else ROOT.parent
    return (base / "tts-runtime").resolve()


def cfg_int(key: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(cfg(key, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def cfg_float(key: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(cfg(key, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


@dataclass(frozen=True, slots=True)
class Settings:
    version: str
    data_root: Path
    voices_dir: Path
    outputs_dir: Path
    temp_dir: Path
    logs_dir: Path
    history_db: Path
    max_upload_bytes: int
    max_text_chars: int
    max_translate_chars: int
    max_style_chars: int
    max_batch_engines: int
    max_concurrent_jobs: int
    job_retention: int
    ffmpeg_timeout_seconds: int
    engine_probe_timeout_seconds: float
    engine_probe_ttl_seconds: float


def _build_settings() -> Settings:
    data_root = Path(cfg("TTS_DATA_ROOT", str(ROOT))).expanduser().resolve()
    settings = Settings(
        version="0.3.0",
        data_root=data_root,
        voices_dir=data_root / "voices",
        outputs_dir=data_root / "outputs",
        temp_dir=data_root / ".tmp",
        logs_dir=data_root / "logs",
        history_db=data_root / "tts-history.sqlite3",
        max_upload_bytes=cfg_int("TTS_MAX_UPLOAD_BYTES", 10 * 1024 * 1024, 1024, 64 * 1024 * 1024),
        max_text_chars=cfg_int("TTS_MAX_TEXT_CHARS", 10_000, 1, 100_000),
        max_translate_chars=cfg_int("TTS_MAX_TRANSLATE_CHARS", 12_000, 1, 100_000),
        max_style_chars=cfg_int("TTS_MAX_STYLE_CHARS", 500, 1, 4_000),
        max_batch_engines=cfg_int("TTS_MAX_BATCH_ENGINES", 3, 1, 8),
        max_concurrent_jobs=cfg_int("TTS_MAX_CONCURRENT_JOBS", 2, 1, 6),
        job_retention=cfg_int("TTS_JOB_RETENTION", 200, 20, 2_000),
        ffmpeg_timeout_seconds=cfg_int("TTS_FFMPEG_TIMEOUT_SECONDS", 90, 10, 600),
        engine_probe_timeout_seconds=cfg_float("TTS_ENGINE_PROBE_TIMEOUT_SECONDS", 2.0, 0.25, 10.0),
        engine_probe_ttl_seconds=cfg_float("TTS_ENGINE_PROBE_TTL_SECONDS", 8.0, 1.0, 120.0),
    )
    for path in (settings.data_root, settings.voices_dir, settings.outputs_dir, settings.temp_dir, settings.logs_dir):
        path.mkdir(parents=True, exist_ok=True)
    return settings


settings = _build_settings()
