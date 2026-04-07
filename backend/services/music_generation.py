"""ElevenLabs music generation (shared by HTTP route and agent tool)."""

from __future__ import annotations

import asyncio
import base64
import json
import os
from typing import Any, Optional, Tuple

# Matches backend.routes.music.MusicGenerateRequest.prompt max_length
MAX_MUSIC_PROMPT_LENGTH = 5000
_TRUNC_SUFFIX = " [truncated]"


def clamp_music_prompt(prompt: str) -> str:
    """Trim prompt to the same max length as the REST /music/generate route."""
    if len(prompt) <= MAX_MUSIC_PROMPT_LENGTH:
        return prompt
    budget = MAX_MUSIC_PROMPT_LENGTH - len(_TRUNC_SUFFIX)
    return prompt[: max(0, budget)] + _TRUNC_SUFFIX


def _shorten(text: str, limit: int = 800) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def _message_from_body(body: Any) -> str:
    if body is None:
        return ""
    if isinstance(body, str):
        s = body.strip()
        try:
            parsed = json.loads(s)
            if isinstance(parsed, dict):
                return _message_from_body(parsed)
        except json.JSONDecodeError:
            pass
        return _shorten(s)
    if isinstance(body, dict):
        detail = body.get("detail")
        if isinstance(detail, str):
            return _shorten(detail)
        if isinstance(detail, dict):
            for key in ("message", "msg", "error"):
                v = detail.get(key)
                if v:
                    return _shorten(str(v))
        for key in ("message", "error", "msg"):
            v = body.get(key)
            if v:
                return _shorten(str(v))
        return _shorten(str(body))
    return _shorten(str(body))


def _request_id_from_body(body: Any) -> Optional[str]:
    if isinstance(body, dict):
        rid = body.get("request_id")
        if rid:
            return str(rid)
        detail = body.get("detail")
        if isinstance(detail, dict) and detail.get("request_id"):
            return str(detail["request_id"])
    return None


def format_elevenlabs_exception(exc: BaseException) -> str:
    """Readable API error for logs and LLM tool results (avoids ApiError's header-heavy __str__)."""
    status = getattr(exc, "status_code", None)
    body = getattr(exc, "body", None)
    if status is None and body is None:
        return str(exc)
    parts: list[str] = []
    if status is not None:
        parts.append(f"HTTP {status}")
    msg = _message_from_body(body)
    if msg:
        parts.append(msg)
    rid = _request_id_from_body(body) if isinstance(body, dict) else None
    if not rid and isinstance(body, str):
        try:
            parsed = json.loads(body)
            rid = _request_id_from_body(parsed)
        except json.JSONDecodeError:
            pass
    if rid:
        parts.append(f"request_id={rid}")
    if parts:
        return "; ".join(parts)
    return str(exc)


def resolve_elevenlabs_api_key(request_key: Optional[str] = None) -> Optional[str]:
    key = (request_key or "").strip() or (os.getenv("ELEVENLABS_API_KEY") or "").strip()
    return key or None


async def generate_music_bytes(
    *,
    prompt: str,
    music_length_ms: Optional[int] = None,
    force_instrumental: bool = True,
    output_format: str = "mp3_44100_128",
    api_key: str,
) -> bytes:
    """Stream music from ElevenLabs and return raw audio bytes."""
    from elevenlabs.client import ElevenLabs

    client = ElevenLabs(api_key=api_key)
    kwargs = {
        "prompt": prompt,
        "force_instrumental": force_instrumental,
        "output_format": output_format,
    }
    if music_length_ms is not None:
        kwargs["music_length_ms"] = music_length_ms

    def _generate() -> bytes:
        chunks = []
        for chunk in client.music.stream(**kwargs):
            chunks.append(chunk)
        return b"".join(chunks)

    return await asyncio.to_thread(_generate)


async def generate_music_base64(
    *,
    prompt: str,
    music_length_ms: Optional[int] = None,
    force_instrumental: bool = True,
    output_format: str = "mp3_44100_128",
    api_key: Optional[str] = None,
) -> Tuple[str, str, str, Optional[int]]:
    """Returns (audio_base64, format, prompt_echo, music_length_ms_used)."""
    resolved = resolve_elevenlabs_api_key(api_key)
    if not resolved:
        raise ValueError(
            "No ElevenLabs API key found. Please open Settings and enter your "
            "ElevenLabs API key under \"ElevenLabs API Key\"."
        )
    prompt = clamp_music_prompt(prompt)
    audio = await generate_music_bytes(
        prompt=prompt,
        music_length_ms=music_length_ms,
        force_instrumental=force_instrumental,
        output_format=output_format,
        api_key=resolved,
    )
    if not audio:
        raise ValueError("ElevenLabs returned no audio data.")
    b64 = base64.b64encode(audio).decode("ascii")
    return b64, output_format, prompt, music_length_ms
