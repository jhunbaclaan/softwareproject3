"""ElevenLabs music generation API routes."""

import asyncio
import base64
import logging
import os
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/music", tags=["music"])


class MusicGenerateRequest(BaseModel):
    """Request body for music generation."""

    prompt: str = Field(..., min_length=1, max_length=5000)
    music_length_ms: Optional[int] = Field(
        default=None,
        ge=3000,
        le=600000,
        description="Length in milliseconds (3-600 seconds)",
    )
    force_instrumental: bool = Field(default=False)
    output_format: str = Field(
        default="mp3_44100_128",
        description="Format: mp3_22050_32, mp3_44100_128, etc.",
    )


class MusicGenerateResponse(BaseModel):
    """Response with generated audio as base64."""

    audio_base64: str
    format: str
    prompt: str


def _get_elevenlabs_client():
    """Get ElevenLabs client with API key from env."""
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not api_key or not api_key.strip():
        raise HTTPException(
            status_code=503,
            detail="ELEVENLABS_API_KEY environment variable is not set. "
            "Add your ElevenLabs API key to enable music generation.",
        )
    from elevenlabs.client import ElevenLabs

    return ElevenLabs(api_key=api_key.strip())


@router.post("/generate", response_model=MusicGenerateResponse)
async def generate_music(request: MusicGenerateRequest) -> MusicGenerateResponse:
    """Generate music from a text prompt using ElevenLabs Music API."""
    try:
        client = _get_elevenlabs_client()
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to create ElevenLabs client")
        raise HTTPException(status_code=503, detail=str(e))

    try:
        kwargs = {
            "prompt": request.prompt,
            "force_instrumental": request.force_instrumental,
            "output_format": request.output_format,
        }
        if request.music_length_ms is not None:
            kwargs["music_length_ms"] = request.music_length_ms

        # Run blocking ElevenLabs call in thread pool
        def _generate() -> bytes:
            audio_chunks = []
            for chunk in client.music.stream(**kwargs):
                audio_chunks.append(chunk)
            return b"".join(audio_chunks)

        audio_bytes = await asyncio.to_thread(_generate)
        if not audio_bytes:
            raise HTTPException(
                status_code=502,
                detail="ElevenLabs returned no audio data.",
            )

        audio_base64 = base64.b64encode(audio_bytes).decode("ascii")
        return MusicGenerateResponse(
            audio_base64=audio_base64,
            format=request.output_format,
            prompt=request.prompt,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("ElevenLabs music generation failed")
        raise HTTPException(
            status_code=502,
            detail=f"Music generation failed: {str(e)}",
        )
