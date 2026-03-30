"""ElevenLabs music generation API routes."""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.music_generation import generate_music_base64, resolve_elevenlabs_api_key

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
    force_instrumental: bool = Field(
        default=True,
        description="When true, generated music has no vocals.",
    )
    output_format: str = Field(
        default="mp3_44100_128",
        description="Format: mp3_22050_32, mp3_44100_128, etc.",
    )
    elevenlabs_api_key: Optional[str] = Field(
        default=None,
        description="Optional key from client; falls back to ELEVENLABS_API_KEY when unset.",
    )


class MusicGenerateResponse(BaseModel):
    """Response with generated audio as base64."""

    audio_base64: str
    format: str
    prompt: str


@router.post("/generate", response_model=MusicGenerateResponse)
async def generate_music(request: MusicGenerateRequest) -> MusicGenerateResponse:
    """Generate music from a text prompt using ElevenLabs Music API."""
    if not resolve_elevenlabs_api_key(request.elevenlabs_api_key):
        raise HTTPException(
            status_code=503,
            detail="No ElevenLabs API key: set it in Developer settings or set "
            "ELEVENLABS_API_KEY on the server.",
        )

    try:
        audio_base64, fmt, prompt_echo, _ = await generate_music_base64(
            prompt=request.prompt,
            music_length_ms=request.music_length_ms,
            force_instrumental=request.force_instrumental,
            output_format=request.output_format,
            api_key=request.elevenlabs_api_key,
        )
        return MusicGenerateResponse(
            audio_base64=audio_base64,
            format=fmt,
            prompt=prompt_echo,
        )
    except ValueError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        logger.exception("ElevenLabs music generation failed")
        raise HTTPException(
            status_code=502,
            detail=f"Music generation failed: {str(e)}",
        ) from e
