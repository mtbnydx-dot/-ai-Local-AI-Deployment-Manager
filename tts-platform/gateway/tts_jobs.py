"""In-memory synthesis queue with bounded and per-engine concurrency."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager, AsyncExitStack
from collections import OrderedDict, defaultdict
from dataclasses import dataclass, field
from typing import Any

from tts_config import settings
from tts_schemas import BatchSynthesisRequest, SynthesisRequest
from tts_services import TtsError, synthesis_service
from tts_storage import output_store, utc_now
from tts_identity import owner, can_access, identity
from tts_receipts import receipt_store


logger = logging.getLogger("tts.jobs")
TERMINAL_STATES = {"succeeded", "failed", "cancelled"}


@dataclass(slots=True)
class Job:
    id: str
    request: SynthesisRequest
    owner: str = ""
    receipt_id: str = ""
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
        self._client_limits: dict[str, asyncio.Semaphore] = {}
        self._client_users: defaultdict[str, int] = defaultdict(int)
        self._sync_active: defaultdict[str, int] = defaultdict(int)

    def _check_capacity(self, count: int = 1) -> None:
        policy = identity.get().get("policy", {})
        active = [job for job in self._jobs.values() if job.status in {"queued", "running"}]
        client_active = sum(job.owner == (owner() or "") for job in active) + self._sync_active.get(owner() or "", 0)
        capacity = int(policy.get("maxConcurrentRequests") or settings.max_concurrent_jobs) + int(policy.get("maxQueuedRequests", 128))
        if client_active + count > capacity or len(active) + sum(self._sync_active.values()) + count > max(200, settings.job_retention):
            raise TtsError(429, "任务队列已满，请等待当前任务完成", "concurrency_queue_full")

    @asynccontextmanager
    async def _admission(self, job: Job):
        policy = identity.get().get("policy", {})
        limit = max(1, min(256, int(policy.get("maxConcurrentRequests") or settings.max_concurrent_jobs)))
        semaphore = self._client_limits.setdefault(job.owner, asyncio.Semaphore(limit))
        self._client_users[job.owner] += 1
        try:
            async with AsyncExitStack() as stack:
                async def acquire():
                    for resource in (semaphore, self._global_limit, self._engine_locks[job.request.engine]):
                        await stack.enter_async_context(resource)
                try:
                    await asyncio.wait_for(acquire(), timeout=max(1, min(7200, int(policy.get("queueTimeoutSeconds") or 600))))
                except asyncio.TimeoutError as exc:
                    raise TtsError(429, "等待生成超时，请稍后重试", "concurrency_queue_timeout") from exc
                yield
        finally:
            self._client_users[job.owner] -= 1
            if not self._client_users[job.owner]:
                self._client_users.pop(job.owner, None)
                self._client_limits.pop(job.owner, None)

    @asynccontextmanager
    async def synthesis_slot(self, request: SynthesisRequest):
        self._check_capacity()
        current = owner() or ""
        self._sync_active[current] += 1
        try:
            async with self._admission(Job(id="sync", request=request, owner=current)):
                yield
        finally:
            self._sync_active[current] -= 1
            if not self._sync_active[current]:
                self._sync_active.pop(current, None)

    async def generate(self, request: SynthesisRequest):
        timeout = max(1, min(7200, int(identity.get().get("policy", {}).get("requestTimeoutSeconds") or 600)))
        try:
            return await asyncio.wait_for(synthesis_service.generate(request), timeout=timeout)
        except asyncio.TimeoutError as exc:
            raise TtsError(504, "语音生成超时", "synthesis_timeout") from exc

    def _trim(self) -> None:
        terminal = [job_id for job_id, job in self._jobs.items() if job.status in TERMINAL_STATES]
        overflow = max(0, len(self._jobs) - settings.job_retention)
        for job_id in terminal[:overflow]:
            self._jobs.pop(job_id, None)

    def create(self, request: SynthesisRequest, *, attempt: int = 1) -> Job:
        self._check_capacity()
        job = Job(id=uuid.uuid4().hex, request=request, attempt=attempt, owner=owner() or "", receipt_id=identity.get().get("requestId", ""))
        receipt_store.begin([(job.id, request.engine)])
        self._jobs[job.id] = job
        job.task = asyncio.create_task(self._run(job), name=f"tts-job-{job.id[:8]}")
        self._trim()
        return job

    def create_batch(self, request: BatchSynthesisRequest) -> list[Job]:
        self._check_capacity(len(request.singles()))
        return [self.create(single) for single in request.singles()]

    async def _run(self, job: Job) -> None:
        try:
            async with self._admission(job):
                if job.status == "cancelled":
                    return
                job.status = "running"
                job.progress = 20
                job.started_at = utc_now()
                job.queue_ms = round((time.monotonic() - job.created_monotonic) * 1000)
                audio, engine, elapsed_ms, warning = await self.generate(job.request)
                receipt_store.finish(job.id, audio=audio, text=job.request.text, engine=engine)
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
        finally:
            receipt_store.finish(job.id)

    def list(self, *, limit: int = 50, status: str = "") -> list[dict[str, Any]]:
        jobs = [job for job in reversed(self._jobs.values()) if can_access(job.owner)]
        if status:
            jobs = [job for job in jobs if job.status == status]
        return [job.public() for job in jobs[: max(1, min(200, limit))]]

    def get(self, job_id: str) -> Job | None:
        job = self._jobs.get(str(job_id))
        return job if job and can_access(job.owner) else None

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
            receipt_store.finish(job.id, request_id=job.receipt_id)
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
            if not can_access(job.owner):
                continue
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
