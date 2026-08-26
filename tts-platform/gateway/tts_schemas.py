"""Validated request models shared by the TTS APIs and job queue."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from tts_catalog import normalize_language
from tts_config import settings


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)


class TranslateRequest(ApiModel):
    text: str = Field(min_length=1, max_length=settings.max_translate_chars)
    target_language: str = Field(default="en", min_length=2, max_length=64)

    @field_validator("target_language")
    @classmethod
    def validate_target_language(cls, value: str) -> str:
        language = normalize_language(value)
        if language == "auto":
            raise ValueError("翻译目标语种不能是 auto")
        if any(ord(character) < 32 for character in language):
            raise ValueError("目标语种包含无效控制字符")
        return language


class SynthesisRequest(ApiModel):
    engine: str = Field(min_length=1, max_length=64)
    text: str = Field(min_length=1, max_length=settings.max_text_chars)
    voice_id: str | None = Field(default=None, max_length=64)
    language: str = Field(default="auto", min_length=2, max_length=64)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    emotion: str = Field(default="", max_length=40)
    emotion_intensity: float = Field(default=0.5, ge=0.0, le=1.0)
    style: str = Field(default="", max_length=settings.max_style_chars)

    @field_validator("voice_id", mode="before")
    @classmethod
    def blank_voice_is_none(cls, value: Any) -> Any:
        return None if value is None or not str(value).strip() else value

    @field_validator("language")
    @classmethod
    def validate_language(cls, value: str) -> str:
        language = normalize_language(value)
        if any(ord(character) < 32 for character in language):
            raise ValueError("语种包含无效控制字符")
        return language


class BatchSynthesisRequest(ApiModel):
    engines: list[str] = Field(min_length=1, max_length=settings.max_batch_engines)
    text: str = Field(min_length=1, max_length=settings.max_text_chars)
    voice_id: str | None = Field(default=None, max_length=64)
    language: str = Field(default="auto", min_length=2, max_length=64)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    emotion: str = Field(default="", max_length=40)
    emotion_intensity: float = Field(default=0.5, ge=0.0, le=1.0)
    style: str = Field(default="", max_length=settings.max_style_chars)

    @field_validator("engines")
    @classmethod
    def unique_engines(cls, value: list[str]) -> list[str]:
        result: list[str] = []
        for item in value:
            engine = str(item or "").strip()
            if engine and engine not in result:
                result.append(engine)
        if not result:
            raise ValueError("至少选择一个引擎")
        if len(result) > settings.max_batch_engines:
            raise ValueError(f"一次最多选择 {settings.max_batch_engines} 个引擎")
        return result

    def singles(self) -> list[SynthesisRequest]:
        common = self.model_dump(exclude={"engines"})
        return [SynthesisRequest(engine=engine, **common) for engine in self.engines]


class OpenAISpeechRequest(ApiModel):
    model: str = Field(default="tts-qwen_local", min_length=1, max_length=128)
    input: str = Field(min_length=1, max_length=settings.max_text_chars)
    voice: str | None = Field(default=None, max_length=128)
    response_format: str = Field(default="wav", max_length=16)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    instructions: str = Field(default="", max_length=settings.max_style_chars)
    language: str = Field(default="auto", min_length=2, max_length=64)
    emotion: str = Field(default="", max_length=40)


class VoiceUpdate(ApiModel):
    name: str | None = Field(default=None, max_length=120)
    ref_text: str | None = Field(default=None, max_length=4_000)

    @model_validator(mode="after")
    def require_change(self) -> "VoiceUpdate":
        if self.name is None and self.ref_text is None:
            raise ValueError("至少提供一个需要修改的字段")
        return self
