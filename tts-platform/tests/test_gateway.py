import asyncio
import importlib
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from pydantic import ValidationError


TEST_DATA = tempfile.TemporaryDirectory()
os.environ["TTS_DATA_ROOT"] = TEST_DATA.name
GATEWAY_DIR = Path(__file__).resolve().parents[1] / "gateway"
STATIC_DIR = GATEWAY_DIR / "static"
sys.path.insert(0, str(GATEWAY_DIR))

config = importlib.import_module("tts_config")
schemas = importlib.import_module("tts_schemas")
storage = importlib.import_module("tts_storage")
services = importlib.import_module("tts_services")
jobs_module = importlib.import_module("tts_jobs")
lifecycle_module = importlib.import_module("tts_lifecycle")
gateway = importlib.import_module("main")


def wav_bytes(duration_ms=500, sample_rate=24000):
    frames = round(sample_rate * duration_ms / 1000)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(b"\x00\x00" * frames)
    return buffer.getvalue()


class StorageAndSchemaTest(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        for handler in list(gateway.logger.handlers):
            handler.close()
            gateway.logger.removeHandler(handler)
        TEST_DATA.cleanup()

    def setUp(self):
        for directory in (config.settings.voices_dir, config.settings.outputs_dir):
            for path in directory.glob("*"):
                if path.is_file():
                    path.unlink()
        with storage.output_store._connect() as connection:
            connection.execute("DELETE FROM outputs")

    def test_public_prefix_accepts_paths_only(self):
        self.assertEqual(gateway.normalize_public_prefix("/gateway/tts/"), "/gateway/tts")
        self.assertEqual(gateway.normalize_public_prefix("https://example.test/tts"), "")
        self.assertEqual(gateway.normalize_public_prefix("/gateway/../secret"), "")

    def test_synthesis_schema_bounds_speed_and_text(self):
        request = schemas.SynthesisRequest(engine="fish", text=" hello ", speed=1.25)
        self.assertEqual(request.text, "hello")
        self.assertEqual(request.speed, 1.25)
        with self.assertRaises(ValidationError):
            schemas.SynthesisRequest(engine="fish", text="hello", speed=3)
        with self.assertRaises(ValidationError):
            schemas.SynthesisRequest(engine="fish", text="")

    def test_language_fields_are_free_form_and_normalized(self):
        self.assertEqual(schemas.SynthesisRequest(engine="fish", text="hello", language="fr_CA").language, "fr-ca")
        self.assertEqual(schemas.SynthesisRequest(engine="fish", text="hello", language="粤语").language, "粤语")
        self.assertEqual(schemas.SynthesisRequest(engine="fish", text="hello").language, "auto")
        self.assertEqual(schemas.TranslateRequest(text="hello", target_language="日语").target_language, "ja")
        with self.assertRaises(ValidationError):
            schemas.TranslateRequest(text="hello", target_language="auto")

    def test_batch_schema_deduplicates_and_limits_engines(self):
        request = schemas.BatchSynthesisRequest(engines=["fish", "fish", "mimo_api"], text="hello")
        self.assertEqual(request.engines, ["fish", "mimo_api"])
        self.assertEqual([item.engine for item in request.singles()], ["fish", "mimo_api"])
        with self.assertRaises(ValidationError):
            schemas.BatchSynthesisRequest(engines=["a", "b", "c", "d"], text="hello")

    def test_voice_store_create_update_list_and_delete(self):
        created = storage.voice_store.create(" Test voice ", " transcript ", wav_bytes(800))
        self.assertRegex(created["id"], storage.VOICE_ID_RE)
        self.assertEqual(created["name"], "Test voice")
        self.assertEqual(created["duration_ms"], 800)
        self.assertEqual(len(storage.voice_store.list()), 1)
        updated = storage.voice_store.update(created["id"], name="Renamed", ref_text="new text")
        self.assertEqual(updated["name"], "Renamed")
        self.assertEqual(updated["ref_text"], "new text")
        self.assertTrue(storage.voice_store.delete(created["id"]))
        self.assertFalse(storage.voice_store.delete(created["id"]))

    def test_voice_store_rejects_path_input(self):
        with self.assertRaises(ValueError):
            storage.voice_store.audio_path("../secret")

    def test_output_store_persists_metadata_and_filters(self):
        first = storage.output_store.create(
            wav_bytes(1000),
            payload={"voice_id": None, "text": "hello world", "language": "en", "speed": 1, "emotion": "", "style": ""},
            engine="qwen_api",
            elapsed_ms=42,
        )
        storage.output_store.create(
            wav_bytes(600),
            payload={"voice_id": "x", "text": "another result", "language": "en", "speed": 1, "emotion": "开心", "style": "warm"},
            engine="fish",
            elapsed_ms=99,
        )
        self.assertEqual(first["duration_ms"], 1000)
        self.assertEqual(storage.output_store.list(engine="fish")["total"], 1)
        self.assertEqual(storage.output_store.list(query="hello")["items"][0]["id"], first["id"])
        self.assertTrue(storage.output_store.audio_path(first["id"]).exists())
        self.assertTrue(storage.output_store.delete(first["id"]))
        self.assertIsNone(storage.output_store.get(first["id"]))

    def test_existing_wav_files_are_indexed_idempotently(self):
        path = config.settings.outputs_dir / "20260826_010000_step_audio.wav"
        path.write_bytes(wav_bytes(700))
        self.assertEqual(storage.output_store.index_existing_outputs(), 1)
        self.assertEqual(storage.output_store.index_existing_outputs(), 0)
        item = storage.output_store.list()["items"][0]
        self.assertEqual(item["engine"], "step_audio")
        self.assertEqual(item["duration_ms"], 700)

    def test_audio_info_rejects_non_wav(self):
        info = storage.audio_info_bytes(b"not audio")
        self.assertIsNone(info["duration_ms"])

    def test_frontend_is_split_and_has_no_inline_handlers(self):
        html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
        css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")
        self.assertIn('src="app.js"', html)
        self.assertIn('href="app.css"', html)
        self.assertNotIn("onclick=", html.lower())
        self.assertIn("api/jobs", script)
        self.assertIn("api/outputs", script)
        self.assertIn("@media (max-width: 900px)", css)
        for label in ("创建", "音色库", "任务", "历史", "模型", "API", "生成语音", "合成语种"):
            self.assertIn(label, html)
        self.assertIn("api/models", script)
        self.assertIn("data-model-action", script)


class EngineAndJobTest(unittest.IsolatedAsyncioTestCase):
    async def test_engine_registry_caches_probe_batch(self):
        registry = services.EngineRegistry()
        probe = AsyncMock(return_value={
            "available": True,
            "status": "online",
            "detail": "ready",
            "latency_ms": 1,
            "model_loaded": False,
            "busy": False,
        })
        try:
            with patch.object(registry, "_probe", probe):
                first = await registry.list(refresh=True)
                second = await registry.list()
            self.assertEqual(probe.await_count, len(services.LOCAL_WORKERS))
            self.assertEqual(len(first), len(services.ENGINE_CAPABILITIES))
            self.assertEqual(first, second)
            self.assertEqual([item["id"] for item in first[:len(services.LOCAL_WORKERS)]], list(services.LOCAL_WORKERS))
        finally:
            await registry.close()

    async def test_job_batch_serializes_same_engine(self):
        manager = jobs_module.JobManager()
        active = 0
        maximum = 0
        active_by_engine = {}
        maximum_by_engine = {}

        async def fake_generate(request):
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            active_by_engine[request.engine] = active_by_engine.get(request.engine, 0) + 1
            maximum_by_engine[request.engine] = max(maximum_by_engine.get(request.engine, 0), active_by_engine[request.engine])
            await asyncio.sleep(0.02)
            active -= 1
            active_by_engine[request.engine] -= 1
            return wav_bytes(500), request.engine, 20, ""

        fake_output = {"id": "out", "audio_url": "api/outputs/out/audio"}
        fish = schemas.SynthesisRequest(engine="fish", text="hello", voice_id="20260826123456_abcdef")
        mimo = schemas.SynthesisRequest(engine="mimo_api", text="hello", voice_id="20260826123456_abcdef")
        with patch.object(jobs_module.synthesis_service, "generate", side_effect=fake_generate), patch.object(jobs_module.output_store, "create", return_value=fake_output):
            created = [manager.create(fish), manager.create(fish.model_copy()), manager.create(mimo)]
            await asyncio.gather(*(job.task for job in created))
        self.assertEqual(maximum, 2)
        self.assertEqual(maximum_by_engine["fish"], 1)
        self.assertTrue(all(job.status == "succeeded" for job in created))
        self.assertEqual(manager.snapshot()["active"], 0)

    async def test_job_can_be_cancelled(self):
        manager = jobs_module.JobManager()

        async def slow_generate(_):
            await asyncio.sleep(5)
            return wav_bytes(), "fish", 1, ""

        request = schemas.SynthesisRequest(engine="fish", text="hello", voice_id="20260826123456_abcdef")
        with patch.object(jobs_module.synthesis_service, "generate", side_effect=slow_generate):
            job = manager.create(request)
            await asyncio.sleep(0)
            manager.cancel(job.id)
            await asyncio.gather(job.task, return_exceptions=True)
        self.assertEqual(job.status, "cancelled")
        self.assertEqual(job.error_code, "job_cancelled")

    async def test_failed_job_can_retry(self):
        manager = jobs_module.JobManager()
        request = schemas.SynthesisRequest(engine="fish", text="hello", voice_id="20260826123456_abcdef")
        with patch.object(jobs_module.synthesis_service, "generate", side_effect=services.TtsError(503, "offline", "engine_unavailable")):
            job = manager.create(request)
            await asyncio.gather(job.task)
        self.assertEqual(job.status, "failed")
        with patch.object(jobs_module.synthesis_service, "generate", return_value=(wav_bytes(), "fish", 1, "")), patch.object(jobs_module.output_store, "create", return_value={"id": "retry"}):
            retry = manager.retry(job.id)
            await asyncio.gather(retry.task)
        self.assertEqual(retry.attempt, 2)
        self.assertEqual(retry.status, "succeeded")

    async def test_openai_response_is_wav_and_not_persisted(self):
        request = schemas.OpenAISpeechRequest(model="tts-fish", voice="20260826123456_abcdef", input="hello")
        fake = AsyncMock(return_value=(wav_bytes(), "fish", 12, ""))
        scope = {"type": "http", "method": "POST", "path": "/v1/audio/speech", "headers": []}
        starlette_request = gateway.Request(scope)
        starlette_request.state.request_id = "request-123"
        with patch.object(gateway.synthesis_service, "generate", fake):
            response = await gateway.openai_audio_speech(starlette_request, request)
        self.assertEqual(response.media_type, "audio/wav")
        self.assertTrue(response.body.startswith(b"RIFF"))
        self.assertEqual(response.headers["x-tts-engine"], "fish")

    async def test_voice_design_does_not_require_reference_voice(self):
        request = schemas.SynthesisRequest(engine="qwen_voice_design", text="Bonjour", language="fr", style="warm")
        with patch.object(services.synthesis_service, "_local_worker", AsyncMock(return_value=wav_bytes())) as worker:
            audio, engine, _, _ = await services.synthesis_service.generate(request)
        self.assertTrue(audio.startswith(b"RIFF"))
        self.assertEqual(engine, "qwen_voice_design")
        self.assertEqual(worker.await_args.args[2], "fr")

    async def test_chatterbox_reports_unsupported_explicit_language(self):
        request = schemas.SynthesisRequest(engine="chatterbox", text="xin chao", language="vi", voice_id="20260826123456_abcdef")
        with self.assertRaises(services.TtsError) as context:
            await services.synthesis_service.generate(request)
        self.assertEqual(context.exception.code, "engine_language_unsupported")


class ModelLifecycleTest(unittest.TestCase):
    def test_catalog_includes_new_allowlisted_models(self):
        manager = lifecycle_module.ModelLifecycleManager()
        items = manager.catalog([])
        indexed = {item["id"]: item for item in items}
        self.assertTrue(indexed["voxcpm2"]["featured"])
        self.assertTrue(indexed["qwen_voice_design"]["actions"]["install"] or indexed["qwen_voice_design"]["installed"])
        self.assertEqual(indexed["voxcpm2"]["language_summary"], "自动识别 · 30 种语言")

    def test_process_matcher_fails_closed(self):
        matcher = lifecycle_module.ModelLifecycleManager._matches_engine_process
        self.assertTrue(matcher("qwen_local", r"python.exe D:\AI\tts-platform\workers\qwen_worker.py"))
        self.assertFalse(matcher("qwen_local", r"python.exe unrelated_server.py"))
        self.assertFalse(matcher("qwen_local", ""))


class ApiSurfaceTest(unittest.IsolatedAsyncioTestCase):
    async def request(self, method, path, **kwargs):
        transport = httpx.ASGITransport(app=gateway.app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, **kwargs)

    async def test_health_is_lightweight_and_has_security_headers(self):
        response = await self.request("GET", "/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["service"], "tts-gateway")
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertIn("default-src 'self'", response.headers["content-security-policy"])
        self.assertTrue(response.headers["x-request-id"])

    async def test_system_has_no_secret_values(self):
        response = await self.request("GET", "/api/system")
        self.assertEqual(response.status_code, 200)
        text = response.text
        self.assertNotIn("MIMO_API_KEY", text)
        self.assertNotIn("DASHSCOPE_API_KEY", text)
        self.assertIn("limits", response.json())

    async def test_static_shell_and_assets_are_served(self):
        shell = await self.request("GET", "/")
        script = await self.request("GET", "/app.js")
        style = await self.request("GET", "/app.css")
        self.assertEqual(shell.status_code, 200)
        self.assertEqual(script.status_code, 200)
        self.assertEqual(style.status_code, 200)
        self.assertIn("语音工作台", shell.text)

    async def test_validation_errors_are_structured(self):
        response = await self.request("POST", "/api/jobs", json={"engines": [], "text": ""})
        self.assertEqual(response.status_code, 422)
        payload = response.json()
        self.assertEqual(payload["code"], "validation_error")
        self.assertTrue(payload["request_id"])
        self.assertTrue(payload["errors"])

    async def test_api_key_protects_data_routes_but_not_shell(self):
        original = os.environ.get("TTS_API_KEY")
        os.environ["TTS_API_KEY"] = "test-secret"
        try:
            denied = await self.request("GET", "/api/system")
            allowed = await self.request("GET", "/api/system", headers={"Authorization": "Bearer test-secret"})
            shell = await self.request("GET", "/")
        finally:
            if original is None:
                os.environ.pop("TTS_API_KEY", None)
            else:
                os.environ["TTS_API_KEY"] = original
        self.assertEqual(denied.status_code, 401)
        self.assertEqual(denied.json()["code"], "unauthorized")
        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(shell.status_code, 200)

    async def test_models_return_capabilities(self):
        engines = [
            {"id": engine_id, "available": engine_id == "step_audio"}
            for engine_id in services.ENGINE_CAPABILITIES
        ]
        with patch.object(gateway.engine_registry, "list", AsyncMock(return_value=engines)):
            response = await self.request("GET", "/v1/models")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload["data"]), len(services.ENGINE_CAPABILITIES))
        self.assertIn("capabilities", payload["data"][0])

    async def test_languages_endpoint_is_free_form(self):
        response = await self.request("GET", "/api/languages")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["free_form"])
        self.assertIn("auto", [item["code"] for item in response.json()["items"]])

    async def test_model_catalog_and_action_endpoint(self):
        engine_states = [{"id": engine_id, "available": False, "status": "offline"} for engine_id in services.ENGINE_CAPABILITIES]
        with patch.object(gateway.engine_registry, "list", AsyncMock(return_value=engine_states)):
            response = await self.request("GET", "/api/models")
        self.assertEqual(response.status_code, 200)
        self.assertIn("voxcpm2", [item["id"] for item in response.json()["items"]])

        operation = {"action": "wake", "status": "queued", "message": "queued"}
        with patch.object(gateway.model_lifecycle, "begin", return_value=operation) as begin:
            action = await self.request("POST", "/api/models/qwen_local/actions/wake")
        self.assertEqual(action.status_code, 202)
        self.assertTrue(action.json()["accepted"])
        begin.assert_called_once_with("qwen_local", "wake")

    async def test_missing_output_is_404(self):
        response = await self.request("GET", "/api/outputs/not-found/audio")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["code"], "output_not_found")


if __name__ == "__main__":
    unittest.main()
