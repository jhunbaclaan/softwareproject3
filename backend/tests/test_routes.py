import pytest
from httpx import AsyncClient, ASGITransport
from main import app
from unittest.mock import MagicMock, patch

@pytest.fixture
def mock_elevenlabs():
    with patch("routes.music._get_elevenlabs_client") as mock:
        yield mock

@pytest.mark.asyncio
async def test_generate_music_success(mock_elevenlabs):
    # Setup mock client returning fake chunks
    client_instance = MagicMock()
    client_instance.music.stream.return_value = [b"audio", b"_test"]
    mock_elevenlabs.return_value = client_instance
    
    request_data = {
        "prompt": "Make a cool beat",
        "music_length_ms": 5000,
        "force_instrumental": True,
        "output_format": "mp3_44100_128"
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/music/generate", json=request_data)
        
    assert response.status_code == 200
    data = response.json()
    assert data["format"] == "mp3_44100_128"
    assert data["prompt"] == "Make a cool beat"
    # base64.b64encode(b"audio_test").decode("ascii") == "YXVkaW9fdGVzdA=="
    assert data["audio_base64"] == "YXVkaW9fdGVzdA=="

@pytest.mark.asyncio
async def test_generate_music_no_api_key():
    # If API key is missing, _get_elevenlabs_client raises HTTPException(503)
    # We can fake that by not mocking it and removing the env var
    with patch("os.getenv", return_value=None):
        request_data = {"prompt": "test"}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            response = await ac.post("/music/generate", json=request_data)
        
        assert response.status_code == 503
        assert "No ElevenLabs API key" in response.json()["detail"]
