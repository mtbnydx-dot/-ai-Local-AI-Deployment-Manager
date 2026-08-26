import asyncio
import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


TEST_DATA = tempfile.TemporaryDirectory()
os.environ["TTS_DATA_ROOT"] = TEST_DATA.name
GATEWAY_DIR = Path(__file__).resolve().parents[1] / "gateway"
sys.path.insert(0, str(GATEWAY_DIR))
gateway = importlib.import_module("main")


class GatewayHelpersTest(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        TEST_DATA.cleanup()

    def test_public_prefix_is_path_only(self):
        self.assertEqual(gateway.normalize_public_prefix("/gateway/tts/"), "/gateway/tts")
        self.assertEqual(gateway.normalize_public_prefix("https://example.test/tts"), "")
        self.assertEqual(gateway.normalize_public_prefix("/gateway/../secret"), "")

    def test_voice_id_validation_blocks_path_input(self):
        self.assertEqual(gateway._validate_voice_id("20260826123456_abcdef"), "20260826123456_abcdef")
        with self.assertRaises(gateway.HTTPException):
            gateway._validate_voice_id("../secret")

    def test_engine_health_probes_run_as_one_batch(self):
        probe = AsyncMock(return_value={"available": True, "detail": "ready"})
        with patch.object(gateway, "_probe", probe):
            result = asyncio.run(gateway.engines())
        self.assertEqual(probe.await_count, 4)
        self.assertEqual([item["id"] for item in result[:4]], list(gateway.LOCAL_WORKERS))
        self.assertTrue(all(item["available"] for item in result[:4]))

    def test_openai_audio_returns_wav_without_persisting_output(self):
        fake = AsyncMock(return_value=(b"RIFFtest", "fish", 12))
        with patch.object(gateway, "generate_tts", fake):
            response = asyncio.run(gateway.openai_audio_speech({
                "model": "tts-fish",
                "voice": "20260826123456_abcdef",
                "input": "hello",
                "response_format": "wav",
            }))
        self.assertEqual(response.media_type, "audio/wav")
        self.assertEqual(response.body, b"RIFFtest")
        self.assertEqual(response.headers["x-tts-engine"], "fish")


if __name__ == "__main__":
    unittest.main()
