"""Static TTS engine catalog and language compatibility helpers.

The catalog is deliberately declarative.  Lifecycle code may only operate on
entries defined here, so a browser request can never turn into an arbitrary
command or filesystem path.
"""

from __future__ import annotations

import re
from typing import Any


COMMON_LANGUAGES = [
    {"code": "auto", "name": "自动识别"},
    {"code": "zh", "name": "中文"},
    {"code": "en", "name": "英语"},
    {"code": "ja", "name": "日语"},
    {"code": "ko", "name": "韩语"},
    {"code": "de", "name": "德语"},
    {"code": "fr", "name": "法语"},
    {"code": "es", "name": "西班牙语"},
    {"code": "it", "name": "意大利语"},
    {"code": "pt", "name": "葡萄牙语"},
    {"code": "ru", "name": "俄语"},
    {"code": "ar", "name": "阿拉伯语"},
    {"code": "hi", "name": "印地语"},
    {"code": "tr", "name": "土耳其语"},
    {"code": "nl", "name": "荷兰语"},
    {"code": "pl", "name": "波兰语"},
    {"code": "sv", "name": "瑞典语"},
    {"code": "sw", "name": "斯瓦希里语"},
]

QWEN_LANGUAGES = {
    "zh": "Chinese",
    "en": "English",
    "ja": "Japanese",
    "ko": "Korean",
    "de": "German",
    "fr": "French",
    "ru": "Russian",
    "pt": "Portuguese",
    "es": "Spanish",
    "it": "Italian",
}

CHATTERBOX_LANGUAGES = {
    "ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it",
    "ja", "ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh",
}

LANGUAGE_ALIASES = {
    "automatic": "auto", "detect": "auto", "自动": "auto", "自动识别": "auto",
    "chinese": "zh", "mandarin": "zh", "中文": "zh", "普通话": "zh",
    "english": "en", "英语": "en", "英文": "en",
    "japanese": "ja", "日语": "ja", "日文": "ja",
    "korean": "ko", "韩语": "ko", "韩文": "ko",
    "german": "de", "德语": "de",
    "french": "fr", "法语": "fr",
    "spanish": "es", "西班牙语": "es",
    "italian": "it", "意大利语": "it",
    "portuguese": "pt", "葡萄牙语": "pt",
    "russian": "ru", "俄语": "ru",
    "arabic": "ar", "阿拉伯语": "ar",
    "hindi": "hi", "印地语": "hi",
    "turkish": "tr", "土耳其语": "tr",
    "dutch": "nl", "荷兰语": "nl",
    "polish": "pl", "波兰语": "pl",
    "swedish": "sv", "瑞典语": "sv",
    "swahili": "sw", "斯瓦希里语": "sw",
    "danish": "da", "丹麦语": "da",
    "greek": "el", "希腊语": "el",
    "finnish": "fi", "芬兰语": "fi",
    "hebrew": "he", "希伯来语": "he",
    "malay": "ms", "马来语": "ms",
    "norwegian": "no", "挪威语": "no",
}


def normalize_language(value: str | None) -> str:
    """Return a safe free-form language value without imposing a fixed list."""

    text = re.sub(r"\s+", " ", str(value or "auto").strip())
    if not text:
        return "auto"
    lowered = text.casefold()
    alias = LANGUAGE_ALIASES.get(lowered)
    if alias:
        return alias
    # Preserve user-provided language names while normalising BCP-47 separators.
    if re.fullmatch(r"[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*", text):
        return text.replace("_", "-").lower()
    return text


def language_code(value: str | None) -> str:
    normalized = normalize_language(value)
    alias = LANGUAGE_ALIASES.get(normalized.casefold())
    if alias:
        return alias
    return normalized.split("-", 1)[0].casefold()


def qwen_language(value: str | None) -> str:
    code = language_code(value)
    return QWEN_LANGUAGES.get(code, "Auto")


def chatterbox_language(value: str | None) -> str | None:
    code = language_code(value)
    if code == "auto":
        return "auto"
    return code if code in CHATTERBOX_LANGUAGES else None


ENGINE_CATALOG: dict[str, dict[str, Any]] = {
    "chatterbox": {
        "name": "Chatterbox Multilingual V3",
        "type": "local",
        "port": 7011,
        "launcher": "chatterbox",
        "description": "轻量、快速的多语种音色克隆，支持情绪强度。",
        "license": "MIT",
        "source_url": "https://github.com/resemble-ai/chatterbox",
        "language_mode": "explicit",
        "languages": sorted(CHATTERBOX_LANGUAGES),
        "language_summary": "23 种原生语种",
        "capabilities": {"voice_clone": True, "voice_required": True, "emotion": True, "style": False, "requires_ref_text": False},
        "installable": False, "startable": True, "warmable": True, "unloadable": True, "stoppable": True,
    },
    "qwen_local": {
        "name": "Qwen3-TTS 1.7B Base",
        "type": "local",
        "port": 7012,
        "launcher": "qwen_local",
        "description": "高质量 3 秒音色克隆，可自动判断语种。",
        "license": "Apache-2.0",
        "source_url": "https://github.com/QwenLM/Qwen3-TTS",
        "language_mode": "auto",
        "languages": list(QWEN_LANGUAGES),
        "language_summary": "自动识别 · 10 种原生语种",
        "capabilities": {"voice_clone": True, "voice_required": True, "emotion": False, "style": False, "requires_ref_text": False},
        "installable": False, "startable": True, "warmable": True, "unloadable": True, "stoppable": True,
    },
    "fish": {
        "name": "Fish Speech S2 Pro",
        "type": "local",
        "port": 7013,
        "launcher": "fish",
        "description": "表现力强的本地音色克隆，适合成品对比。",
        "license": "Fish Audio Research License",
        "source_url": "https://github.com/fishaudio/fish-speech",
        "language_mode": "auto",
        "languages": ["auto"],
        "language_summary": "模型自动处理多语种",
        "capabilities": {"voice_clone": True, "voice_required": True, "emotion": True, "style": False, "requires_ref_text": False},
        "installable": False, "startable": True, "warmable": True, "unloadable": False, "stoppable": True,
    },
    "step_audio": {
        "name": "Step-Audio-EditX",
        "type": "docker",
        "port": 7014,
        "launcher": "step_audio",
        "description": "基于参考音频与准确文字稿的高保真克隆。",
        "license": "Apache-2.0",
        "source_url": "https://github.com/stepfun-ai/Step-Audio-EditX",
        "language_mode": "auto",
        "languages": ["zh", "en"],
        "language_summary": "中英为主 · 模型自动处理",
        "capabilities": {"voice_clone": True, "voice_required": True, "emotion": False, "style": False, "requires_ref_text": True},
        "installable": False, "startable": True, "warmable": True, "unloadable": False, "stoppable": True,
    },
    "voxcpm2": {
        "name": "VoxCPM 2",
        "type": "local",
        "port": 7015,
        "launcher": "voxcpm2",
        "featured": True,
        "description": "新增推荐：30 种语言、音色克隆和自然语言风格设计。",
        "license": "Apache-2.0",
        "source_url": "https://github.com/OpenBMB/VoxCPM",
        "model_size_bytes": 4_960_731_866,
        "language_mode": "auto",
        "languages": ["auto"],
        "language_summary": "自动识别 · 30 种语言",
        "capabilities": {"voice_clone": True, "voice_optional": True, "voice_required": False, "emotion": True, "style": True, "requires_ref_text": False},
        "installable": True, "startable": True, "warmable": True, "unloadable": True, "stoppable": True,
    },
    "qwen_voice_design": {
        "name": "Qwen3-TTS VoiceDesign 1.7B",
        "type": "local",
        "port": 7016,
        "launcher": "qwen_voice_design",
        "featured": True,
        "description": "新增推荐：不用参考音频，直接用文字描述想要的声音。",
        "license": "Apache-2.0",
        "source_url": "https://github.com/QwenLM/Qwen3-TTS",
        "model_size_bytes": 4_520_163_832,
        "language_mode": "auto",
        "languages": list(QWEN_LANGUAGES),
        "language_summary": "自动识别 · 10 种原生语种",
        "capabilities": {"voice_clone": False, "voice_required": False, "emotion": True, "style": True, "requires_ref_text": False},
        "installable": True, "startable": True, "warmable": True, "unloadable": True, "stoppable": True,
    },
    "mimo_api": {
        "name": "小米 MiMo TTS",
        "type": "api",
        "description": "云端音色克隆与自然语言风格控制。",
        "license": "Cloud API",
        "source_url": "https://platform.xiaomimimo.com",
        "language_mode": "auto", "languages": ["auto"], "language_summary": "由云端模型自动处理",
        "capabilities": {"voice_clone": True, "voice_required": True, "emotion": True, "style": True, "requires_ref_text": False},
        "installable": False, "startable": False, "warmable": False, "unloadable": False, "stoppable": False,
    },
    "qwen_api": {
        "name": "Qwen3-TTS API",
        "type": "api",
        "description": "云端预置音色，适合无需参考音频的快速生成。",
        "license": "Cloud API",
        "source_url": "https://help.aliyun.com/zh/model-studio/qwen-tts",
        "language_mode": "auto", "languages": list(QWEN_LANGUAGES), "language_summary": "自动识别 · 10 种原生语种",
        "capabilities": {"voice_clone": False, "voice_required": False, "emotion": False, "style": False, "requires_ref_text": False},
        "installable": False, "startable": False, "warmable": False, "unloadable": False, "stoppable": False,
    },
}


LOCAL_WORKERS = {
    engine_id: {"name": spec["name"], "url": f"http://127.0.0.1:{spec['port']}"}
    for engine_id, spec in ENGINE_CATALOG.items()
    if spec.get("port")
}

ENGINE_CAPABILITIES = {
    engine_id: dict(spec["capabilities"])
    for engine_id, spec in ENGINE_CATALOG.items()
}


def public_engine_metadata(engine_id: str) -> dict[str, Any]:
    spec = ENGINE_CATALOG[engine_id]
    return {
        "language_mode": spec["language_mode"],
        "languages": list(spec["languages"]),
        "language_summary": spec["language_summary"],
    }
