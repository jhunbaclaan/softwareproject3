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


# ==================== MUSIC LENGTH VALIDATION TESTS ====================

@pytest.mark.asyncio
async def test_generate_music_minimum_length(mock_elevenlabs):
    """Test with minimum length (3 seconds = 3000ms)."""
    client_instance = MagicMock()
    client_instance.music.stream.return_value = [b"short", b"_audio"]
    mock_elevenlabs.return_value = client_instance

    request_data = {
        "prompt": "Short clip",
        "music_length_ms": 3000,  # Minimum allowed
        "force_instrumental": True
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/music/generate", json=request_data)

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_generate_music_maximum_length(mock_elevenlabs):
    """Test with maximum length (600 seconds = 600000ms)."""
    client_instance = MagicMock()
    client_instance.music.stream.return_value = [b"long", b"_audio"]
    mock_elevenlabs.return_value = client_instance

    request_data = {
        "prompt": "Long track",
        "music_length_ms": 600000,  # Maximum allowed
        "force_instrumental": True
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/music/generate", json=request_data)

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_generate_music_invalid_length_too_short():
    """Test validation for length < 3 seconds."""
    request_data = {
        "prompt": "Too short",
        "music_length_ms": 2000,  # Below minimum
        "force_instrumental": True
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/music/generate", json=request_data)

    assert response.status_code == 422  # Validation error


@pytest.mark.asyncio
async def test_generate_music_invalid_length_too_long():
    """Test validation for length > 600 seconds."""
    request_data = {
        "prompt": "Too long",
        "music_length_ms": 700000,  # Above maximum
        "force_instrumental": True
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/music/generate", json=request_data)

    assert response.status_code == 422  # Validation error


# ==================== OUTPUT FORMAT TESTS ====================

@pytest.mark.asyncio
async def test_generate_music_different_formats(mock_elevenlabs):
    """Test various output formats."""
    formats_to_test = ["mp3_22050_32", "mp3_44100_128", "mp3_44100_192"]

    for fmt in formats_to_test:
        client_instance = MagicMock()
        client_instance.music.stream.return_value = [b"audio"]
        mock_elevenlabs.return_value = client_instance

        request_data = {
            "prompt": f"Test {fmt}",
            "output_format": fmt,
            "force_instrumental": True
        }

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            response = await ac.post("/music/generate", json=request_data)

        assert response.status_code == 200
        assert response.json()["format"] == fmt


@pytest.mark.asyncio
async def test_generate_music_with_vocals(mock_elevenlabs):
    """Test with force_instrumental set to False."""
    client_instance = MagicMock()
    client_instance.music.stream.return_value = [b"vocal", b"_audio"]
    mock_elevenlabs.return_value = client_instance

    request_data = {
        "prompt": "Song with vocals",
        "force_instrumental": False,  # Allow vocals
        "music_length_ms": 10000
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/music/generate", json=request_data)

    assert response.status_code == 200
    # Verify that the stream was called with force_instrumental=False
    call_kwargs = client_instance.music.stream.call_args[1]
    assert call_kwargs["force_instrumental"] == False


# ==================== ERROR HANDLING TESTS ====================

@pytest.mark.asyncio
async def test_generate_music_empty_response(mock_elevenlabs):
    """Test when ElevenLabs returns no audio data."""
    client_instance = MagicMock()
    client_instance.music.stream.return_value = []  # Empty response
    mock_elevenlabs.return_value = client_instance

    request_data = {
        "prompt": "Empty test",
        "force_instrumental": True
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/music/generate", json=request_data)

    assert response.status_code == 502
    assert "no audio data" in response.json()["detail"].lower()


@pytest.mark.asyncio
async def test_generate_music_api_exception(mock_elevenlabs):
    """Test handling of ElevenLabs API exceptions."""
    mock_elevenlabs.side_effect = Exception("ElevenLabs API error")

    request_data = {
        "prompt": "Error test",
        "force_instrumental": True
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/music/generate", json=request_data)

    assert response.status_code == 503


@pytest.mark.asyncio
async def test_generate_music_with_client_api_key(mock_elevenlabs):
    """Test using API key from request payload."""
    client_instance = MagicMock()
    client_instance.music.stream.return_value = [b"test"]
    mock_elevenlabs.return_value = client_instance

    request_data = {
        "prompt": "Test with custom key",
        "elevenlabs_api_key": "custom_key_12345",
        "force_instrumental": True
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/music/generate", json=request_data)

    assert response.status_code == 200
    # Verify the custom key was passed to _get_elevenlabs_client
    mock_elevenlabs.assert_called_with("custom_key_12345")
