"""Persistent voice metadata and generated-audio history."""

from __future__ import annotations

import io
import json
import os
import re
import sqlite3
import time
import uuid
import wave
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

from tts_config import settings


VOICE_ID_RE = re.compile(r"^\d{14}_[0-9a-f]{6}$")
ENGINE_IDS = ("chatterbox", "qwen_local", "fish", "step_audio", "mimo_api", "qwen_api")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def audio_info_bytes(data: bytes) -> dict[str, int | None]:
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            frames = wav.getnframes()
            sample_rate = wav.getframerate()
            duration_ms = round(frames * 1000 / sample_rate) if sample_rate else None
            return {
                "duration_ms": duration_ms,
                "sample_rate": sample_rate or None,
                "channels": wav.getnchannels() or None,
                "sample_width": wav.getsampwidth() or None,
            }
    except (EOFError, wave.Error):
        return {"duration_ms": None, "sample_rate": None, "channels": None, "sample_width": None}


def audio_info_path(path: Path) -> dict[str, int | None]:
    try:
        return audio_info_bytes(path.read_bytes())
    except OSError:
        return {"duration_ms": None, "sample_rate": None, "channels": None, "sample_width": None}


def _atomic_write(path: Path, data: bytes) -> None:
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temp.write_bytes(data)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    _atomic_write(path, encoded)


class VoiceStore:
    def validate_id(self, voice_id: str) -> str:
        value = str(voice_id or "").strip()
        if not VOICE_ID_RE.fullmatch(value):
            raise ValueError("voice_id 格式无效")
        return value

    def metadata_path(self, voice_id: str) -> Path:
        return settings.voices_dir / f"{self.validate_id(voice_id)}.json"

    def audio_path(self, voice_id: str) -> Path:
        return settings.voices_dir / f"{self.validate_id(voice_id)}.wav"

    def _decorate(self, meta: dict[str, Any]) -> dict[str, Any]:
        voice_id = self.validate_id(meta.get("id", ""))
        audio = self.audio_path(voice_id)
        info = audio_info_path(audio) if audio.exists() else {}
        return {
            "id": voice_id,
            "name": str(meta.get("name") or "我的音色"),
            "ref_text": str(meta.get("ref_text") or ""),
            "created": float(meta.get("created") or 0),
            "updated": float(meta.get("updated") or meta.get("created") or 0),
            "audio_url": f"api/voices/{voice_id}/audio",
            "bytes": audio.stat().st_size if audio.exists() else 0,
            **info,
        }

    def list(self) -> list[dict[str, Any]]:
        voices: list[dict[str, Any]] = []
        for path in sorted(settings.voices_dir.glob("*.json"), reverse=True):
            try:
                meta = json.loads(path.read_text(encoding="utf-8"))
                voices.append(self._decorate(meta))
            except (OSError, ValueError, json.JSONDecodeError):
                continue
        return voices

    def get(self, voice_id: str) -> dict[str, Any] | None:
        path = self.metadata_path(voice_id)
        audio = self.audio_path(voice_id)
        if not path.exists() or not audio.exists():
            return None
        try:
            return self._decorate(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError, json.JSONDecodeError):
            return None

    def create(self, name: str, ref_text: str, wav_bytes: bytes) -> dict[str, Any]:
        voice_id = time.strftime("%Y%m%d%H%M%S") + "_" + uuid.uuid4().hex[:6]
        now = time.time()
        meta = {
            "id": voice_id,
            "name": str(name or "我的音色").strip()[:120] or "我的音色",
            "ref_text": str(ref_text or "").strip()[:4_000],
            "created": now,
            "updated": now,
        }
        _atomic_write(self.audio_path(voice_id), wav_bytes)
        try:
            _atomic_write_json(self.metadata_path(voice_id), meta)
        except Exception:
            self.audio_path(voice_id).unlink(missing_ok=True)
            raise
        return self._decorate(meta)

    def update(self, voice_id: str, *, name: str | None, ref_text: str | None) -> dict[str, Any] | None:
        current = self.get(voice_id)
        if current is None:
            return None
        meta = {
            "id": current["id"],
            "name": (str(name).strip()[:120] or "我的音色") if name is not None else current["name"],
            "ref_text": str(ref_text).strip()[:4_000] if ref_text is not None else current["ref_text"],
            "created": current["created"],
            "updated": time.time(),
        }
        _atomic_write_json(self.metadata_path(voice_id), meta)
        return self._decorate(meta)

    def delete(self, voice_id: str) -> bool:
        meta = self.metadata_path(voice_id)
        audio = self.audio_path(voice_id)
        existed = meta.exists() or audio.exists()
        meta.unlink(missing_ok=True)
        audio.unlink(missing_ok=True)
        return existed


class OutputStore:
    def __init__(self, database: Path | None = None):
        self.database = database or settings.history_db
        self.database.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.database, timeout=10, isolation_level=None)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA busy_timeout=10000")
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=NORMAL")
            yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS outputs (
                    id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL UNIQUE,
                    engine TEXT NOT NULL,
                    voice_id TEXT,
                    text TEXT NOT NULL DEFAULT '',
                    language TEXT NOT NULL DEFAULT 'en',
                    speed REAL NOT NULL DEFAULT 1.0,
                    emotion TEXT NOT NULL DEFAULT '',
                    emotion_intensity REAL NOT NULL DEFAULT 0.5,
                    style TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    elapsed_ms INTEGER NOT NULL DEFAULT 0,
                    bytes INTEGER NOT NULL DEFAULT 0,
                    duration_ms INTEGER,
                    sample_rate INTEGER,
                    channels INTEGER,
                    warning TEXT NOT NULL DEFAULT ''
                )
                """
            )
            connection.execute("CREATE INDEX IF NOT EXISTS outputs_created_idx ON outputs(created_at DESC)")
            connection.execute("CREATE INDEX IF NOT EXISTS outputs_engine_idx ON outputs(engine, created_at DESC)")

    @staticmethod
    def _engine_from_filename(path: Path) -> str:
        stem = path.stem.lower()
        for engine in ENGINE_IDS:
            if stem.endswith("_" + engine) or f"_{engine}_" in stem:
                return engine
        return "unknown"

    def index_existing_outputs(self) -> int:
        indexed = 0
        with self._connect() as connection:
            known = {row[0] for row in connection.execute("SELECT filename FROM outputs")}
            for path in sorted(settings.outputs_dir.glob("*.wav")):
                if path.name in known:
                    continue
                info = audio_info_path(path)
                created = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
                output_id = uuid.uuid5(uuid.NAMESPACE_URL, f"local-tts-output:{path.name}").hex
                connection.execute(
                    """
                    INSERT OR IGNORE INTO outputs
                    (id, filename, engine, created_at, bytes, duration_ms, sample_rate, channels)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        output_id,
                        path.name,
                        self._engine_from_filename(path),
                        created,
                        path.stat().st_size,
                        info["duration_ms"],
                        info["sample_rate"],
                        info["channels"],
                    ),
                )
                indexed += 1
        return indexed

    @staticmethod
    def _public(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        record = dict(row)
        output_id = record["id"]
        record["audio_url"] = f"api/outputs/{output_id}/audio"
        record["download_url"] = f"api/outputs/{output_id}/audio?download=1"
        return record

    def create(self, audio: bytes, *, payload: dict[str, Any], engine: str, elapsed_ms: int, warning: str = "") -> dict[str, Any]:
        info = audio_info_bytes(audio)
        output_id = uuid.uuid4().hex
        filename = f"{time.strftime('%Y%m%d_%H%M%S')}_{engine}_{output_id[:6]}.wav"
        destination = settings.outputs_dir / filename
        _atomic_write(destination, audio)
        created_at = utc_now()
        values = (
            output_id,
            filename,
            engine,
            payload.get("voice_id"),
            str(payload.get("text") or "")[: settings.max_text_chars],
            str(payload.get("language") or "en")[:32],
            float(payload.get("speed") or 1.0),
            str(payload.get("emotion") or "")[:40],
            float(payload.get("emotion_intensity") or 0.5),
            str(payload.get("style") or "")[: settings.max_style_chars],
            created_at,
            int(elapsed_ms),
            len(audio),
            info["duration_ms"],
            info["sample_rate"],
            info["channels"],
            str(warning or "")[:500],
        )
        try:
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO outputs
                    (id, filename, engine, voice_id, text, language, speed, emotion,
                     emotion_intensity, style, created_at, elapsed_ms, bytes, duration_ms,
                     sample_rate, channels, warning)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    values,
                )
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        return self.get(output_id) or {}

    def get(self, output_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM outputs WHERE id = ?", (str(output_id),)).fetchone()
        return self._public(row) if row else None

    def list(self, *, limit: int = 30, offset: int = 0, engine: str = "", query: str = "") -> dict[str, Any]:
        clauses: list[str] = []
        values: list[Any] = []
        if engine:
            clauses.append("engine = ?")
            values.append(engine)
        if query:
            clauses.append("(text LIKE ? OR filename LIKE ?)")
            like = f"%{query[:120]}%"
            values.extend([like, like])
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        limit = max(1, min(100, int(limit)))
        offset = max(0, int(offset))
        with self._connect() as connection:
            total = connection.execute(f"SELECT COUNT(*) FROM outputs{where}", values).fetchone()[0]
            rows = connection.execute(
                f"SELECT * FROM outputs{where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
                [*values, limit, offset],
            ).fetchall()
        return {"items": [self._public(row) for row in rows], "total": total, "limit": limit, "offset": offset}

    def audio_path(self, output_id: str) -> Path | None:
        record = self.get(output_id)
        if not record:
            return None
        path = (settings.outputs_dir / record["filename"]).resolve()
        try:
            path.relative_to(settings.outputs_dir.resolve())
        except ValueError:
            return None
        return path

    def delete(self, output_id: str) -> bool:
        record = self.get(output_id)
        if record is None:
            return False
        path = self.audio_path(output_id)
        with self._connect() as connection:
            connection.execute("DELETE FROM outputs WHERE id = ?", (str(output_id),))
        if path:
            path.unlink(missing_ok=True)
        return True

    def stats(self) -> dict[str, int]:
        with self._connect() as connection:
            row = connection.execute("SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM outputs").fetchone()
        return {"outputs": int(row[0]), "bytes": int(row[1])}


voice_store = VoiceStore()
output_store = OutputStore()
