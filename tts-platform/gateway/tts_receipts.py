"""Durable completion receipts: entry restarts and disconnected callers do not lose usage."""
from __future__ import annotations

from tts_identity import identity, owner
from tts_storage import output_store, audio_info_bytes


class ReceiptStore:
    def __init__(self):
        with output_store._connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS synthesis_receipts (
                request_id TEXT NOT NULL, item_id TEXT NOT NULL, owner TEXT NOT NULL,
                engine TEXT NOT NULL, status TEXT NOT NULL, characters INTEGER NOT NULL DEFAULT 0,
                audio_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(request_id,item_id))""")
            # A worker cannot resume an in-memory task after a process restart.
            db.execute("UPDATE synthesis_receipts SET status='failed' WHERE status='pending'")

    def begin(self, items: list[tuple[str, str]]) -> None:
        request_id = identity.get().get("requestId")
        if not request_id:
            return
        with output_store._connect() as db:
            db.executemany("INSERT INTO synthesis_receipts(request_id,item_id,owner,engine,status) VALUES(?,?,?,?,'pending')",
                           [(request_id, item_id, owner() or "", engine) for item_id, engine in items])

    def finish(self, item_id: str = "sync", *, audio: bytes | None = None, text: str = "", engine: str = "unknown", request_id: str = "") -> None:
        request_id = request_id or identity.get().get("requestId")
        if not request_id:
            return
        info = audio_info_bytes(audio) if audio is not None else {}
        with output_store._connect() as db:
            db.execute("""UPDATE synthesis_receipts SET status=?,characters=?,audio_ms=?,engine=?
                WHERE request_id=? AND item_id=? AND status='pending'""",
                       ("succeeded" if audio is not None else "failed", len(text.strip()) if audio is not None else 0,
                        info.get("duration_ms") or 0, engine, request_id, item_id))

    def fail_pending(self) -> None:
        request_id = identity.get().get("requestId")
        if request_id:
            with output_store._connect() as db:
                db.execute("UPDATE synthesis_receipts SET status='failed' WHERE request_id=? AND status='pending'", (request_id,))

    def get(self, request_id: str) -> dict | None:
        with output_store._connect() as db:
            rows = db.execute("SELECT * FROM synthesis_receipts WHERE request_id=? AND owner=?", (request_id, owner() or "")).fetchall()
        if not rows:
            return None
        engines = sorted({row["engine"] for row in rows})
        return {"complete": all(row["status"] != "pending" for row in rows),
                "ok": any(row["status"] == "succeeded" for row in rows),
                "audioMs": sum(row["audio_ms"] for row in rows),
                "characters": sum(row["characters"] for row in rows),
                "engine": engines[0] if len(engines) == 1 else "batch",
                "durationSource": "measured"}


receipt_store = ReceiptStore()
