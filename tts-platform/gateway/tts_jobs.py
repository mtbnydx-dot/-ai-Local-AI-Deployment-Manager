"""In-memory synthesis queue with bounded and per-engine concurrency."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections import OrderedDict, defaultdict
from dataclasses import dataclass, field
from typing import Any

from tts_config import settings
from tts_schemas import BatchSynthesisRequest, SynthesisRequest
from tts_services import TtsError, synthesis_service
from tts_storage import output_store, utc_now


logger = logging.getLogger("tts.jobs")
TERMINAL_STATES = {"succeeded", "failed", "cancelled"}


@dataclass(slots=True)
class Job:
    id: str
    request: SynthesisRequest
    status: str = "queued"
    progress: int = 5
    created_at: str = field(default_factory=utc_now)
    created_monotonic: float = field(default_factory=time.monotonic)
    started_at: str | None = None
    completed_at: str | None = None
    queue_ms: int = 0
    elapsed_ms: int = 0
    output: dict[str, Any] | None = None
    error: str = ""
    error_code: str = ""
    attempt: int = 1
    task: asyncio.Task[None] | None = field(default=None, repr=False)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "progress": self.progress,
            "engine": self.request.engine,
            "request": self.request.model_dump(),
            "created_at": self.created_at,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "queue_ms": self.queue_ms,
            "elapsed_ms": self.elapsed_ms,
            "output": self.output,
            "error": self.error,
            "error_code": self.error_code,
            "attempt": self.attempt,
            "cancellable": self.status in {"queued", "running"},
            "retryable": self.status in {"failed", "cancelled"},
        }


class JobManager:
    def __init__(self):
        self._jobs: OrderedDict[str, Job] = OrderedDict()
        self._global_limit = asyncio.Semaphore(settings.max_concurrent_jobs)
        self._engine_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    def _trim(self) -> None:
        terminal = [job_id for job_id, job in self._jobs.items() if job.status in TERMINAL_STATES]
        overflow = max(0, len(self._jobs) - settings.job_retention)
        for job_id in terminal[:overflow]:
            self._jobs.pop(job_id, None)

    def create(self, request: SynthesisRequest, *, attempt: int = 1) -> Job:
        job = Job(id=uuid.uuid4().hex, request=request, attempt=attempt)
        self._jobs[job.id] = job
        job.task = asyncio.create_task(self._run(job), name=f"tts-job-{job.id[:8]}")
        self._trim()
        return job

    def create_batch(self, request: BatchSynthesisRequest) -> list[Job]:
        return [self.create(single) for single in request.singles()]

    async def _run(self, job: Job) -> None:
        try:
            async with self._global_limit:
                async with self._engine_locks[job.request.engine]:
                    if job.status == "cancelled":
                        return
                    job.status = "running"
                    job.progress = 20
                    job.started_at = utc_now()
                    job.queue_ms = round((time.monotonic() - job.created_monotonic) * 1000)
                    audio, engine, elapsed_ms, warning = await synthesis_service.generate(job.request)
                    job.progress = 90
                    output = await asyncio.to_thread(
                        output_store.create,
                        audio,
                        payload=job.request.model_dump(),
                        engine=engine,
                        elapsed_ms=elapsed_ms,
                        warning=warning,
                    )
                    job.output = output
                    job.elapsed_ms = elapsed_ms
                    job.status = "succeeded"
                    job.progress = 100
                    job.completed_at = utc_now()
        except asyncio.CancelledError:
            job.status = "cancelled"
            job.progress = 0
            job.error = "任务已取消"
            job.error_code = "job_cancelled"
            job.completed_at = utc_now()
            raise
        except TtsError as exc:
            job.status = "failed"
            job.progress = 0
            job.error = exc.detail
            job.error_code = exc.code
            job.completed_at = utc_now()
        except Exception:
            logger.exception("Unexpected synthesis failure for job %s", job.id)
            job.status = "failed"
            job.progress = 0
            job.error = "生成失败，请查看网关日志"
            job.error_code = "internal_error"
            job.completed_at = utc_now()

    def list(self, *, limit: int = 50, status: str = "") -> list[dict[str, Any]]:
        jobs = list(reversed(self._jobs.values()))
        if status:
            jobs = [job for job in jobs if job.status == status]
        return [job.public() for job in jobs[: max(1, min(200, limit))]]

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(str(job_id))

    def cancel(self, job_id: str) -> Job | None:
        job = self.get(job_id)
        if job is None:
            return None
        if job.status in {"queued", "running"}:
            job.status = "cancelled"
            job.progress = 0
            job.error = "任务已取消"
            job.error_code = "job_cancelled"
            job.completed_at = utc_now()
            if job.task and not job.task.done():
                job.task.cancel()
        return job

    def retry(self, job_id: str) -> Job | None:
        job = self.get(job_id)
        if job is None or job.status not in {"failed", "cancelled"}:
            return None
        return self.create(job.request.model_copy(deep=True), attempt=job.attempt + 1)

    def snapshot(self) -> dict[str, int]:
        counts = {"queued": 0, "running": 0, "succeeded": 0, "failed": 0, "cancelled": 0}
        for job in self._jobs.values():
            counts[job.status] = counts.get(job.status, 0) + 1
        counts["active"] = counts["queued"] + counts["running"]
        counts["total"] = len(self._jobs)
        return counts

    async def shutdown(self) -> None:
        tasks = [job.task for job in self._jobs.values() if job.task and not job.task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


job_manager = JobManager()
