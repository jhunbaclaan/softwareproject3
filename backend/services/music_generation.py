"""ElevenLabs music generation (shared by HTTP route and agent tool)."""

from __future__ import annotations

import asyncio
import base64
import os
from typing import Optional, Tuple


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
            "No ElevenLabs API key: set elevenlabsApiKey in Developer settings or "
            "ELEVENLABS_API_KEY on the server."
        )
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
