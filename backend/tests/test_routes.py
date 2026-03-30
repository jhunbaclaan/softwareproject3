import pytest
from httpx import AsyncClient, ASGITransport
from main import app
from unittest.mock import AsyncMock, patch

@pytest.mark.asyncio
async def test_generate_music_success():
    request_data = {
        "prompt": "Make a cool beat",
        "music_length_ms": 5000,
        "force_instrumental": True,
        "output_format": "mp3_44100_128",
    }

    with patch("routes.music.resolve_elevenlabs_api_key", return_value="sk-test"), patch(
        "routes.music.generate_music_base64", new_callable=AsyncMock
    ) as mock_gen:
        mock_gen.return_value = (
            "YXVkaW9fdGVzdA==",
            "mp3_44100_128",
            "Make a cool beat",
            5000,
        )
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            response = await ac.post("/music/generate", json=request_data)

    assert response.status_code == 200
    data = response.json()
    assert data["format"] == "mp3_44100_128"
    assert data["prompt"] == "Make a cool beat"
    assert data["audio_base64"] == "YXVkaW9fdGVzdA=="

@pytest.mark.asyncio
async def test_generate_music_no_api_key():
    with patch("os.getenv", return_value=None):
        request_data = {"prompt": "test"}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            response = await ac.post("/music/generate", json=request_data)
        
        assert response.status_code == 503
        assert "No ElevenLabs API key" in response.json()["detail"]
