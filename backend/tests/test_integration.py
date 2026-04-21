"""Integration tests for the backend API."""

import base64

import pytest
from httpx import AsyncClient, ASGITransport
from unittest.mock import patch, AsyncMock, MagicMock

import main
from main import app

import json as _json

def _parse_sse_reply(response):
    """Parse SSE response text and extract the reply."""
    for line in response.text.splitlines():
        if line.startswith("data: "):
            event = _json.loads(line[6:])
            if event.get("type") == "reply":
                return event["data"]
            if event.get("type") == "error":
                return event["data"]
    return {}

from tests.fixtures import mock_mcp_client, mock_elevenlabs_client, sample_auth_tokens


# ---------------------------------------------------------------------------
# Helper: reset global client state between tests
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def reset_client_state():
    """Reset the global MCP client state before each test."""
    main._client = None
    main._client_project_url = None
    main._client_llm_provider = "gemini"
    main._client_llm_api_key = None
    yield
    main._client = None
    main._client_project_url = None
    main._client_llm_provider = "gemini"
    main._client_llm_api_key = None


# ==================== INTEGRATION TEST 1: Full Agent Flow ====================

@pytest.mark.asyncio
async def test_full_agent_flow_with_mcp(mock_mcp_client):
    """Tests the complete /agent/run flow with MCPClient mocked end-to-end."""
    with patch("main.MCPClient") as MockClientClass, \
         patch("main._get_mcp_server_path", return_value="server.js"):

        MockClientClass.return_value = mock_mcp_client

        # Patch run_agent_graph to simulate the full LLM+tool loop
        with patch("main.run_agent_graph", new_callable=AsyncMock) as mock_run:
            mock_run.return_value = ("Added a heisenberg synth to track 1", None)

            request_data = {
                "prompt": "Add a heisenberg synth",
                "keywords": ["synth", "heisenberg"],
                "loop": 1,
                "projectUrl": "https://beta.audiotool.com/studio?project=test-project",
                "llmProvider": "gemini",
                "authTokens": {
                    "accessToken": "test_access_token",
                    "expiresAt": 9999999999999,
                    "refreshToken": "test_refresh_token",
                    "clientId": "test_client_id",
                },
            }

            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as ac:
                response = await ac.post("/agent/run", json=request_data)

            assert response.status_code == 200
            body = _parse_sse_reply(response)
            assert body.get("reply") == "Added a heisenberg synth to track 1"

            # Verify the MCPClient was wired up correctly
            mock_mcp_client.connect_to_server.assert_awaited_once_with("server.js")
            mock_mcp_client.initialize_session.assert_awaited_once()

            # Verify run_agent_graph received the client and prompt
            mock_run.assert_awaited_once()
            call_kwargs = mock_run.call_args
            assert call_kwargs[0][1] == "Add a heisenberg synth"


# ==================== INTEGRATION TEST 2: Music Generation ====================

@pytest.mark.asyncio
async def test_music_generation_integration(mock_elevenlabs_client):
    """Tests /music/generate end-to-end with a mocked ElevenLabs client."""
    with patch(
        "routes.music._get_elevenlabs_client", return_value=mock_elevenlabs_client
    ):
        request_data = {
            "prompt": "upbeat electronic dance track",
            "music_length_ms": 30000,
            "force_instrumental": True,
            "output_format": "mp3_44100_128",
        }

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            response = await ac.post("/music/generate", json=request_data)

        assert response.status_code == 200
        body = response.json()
        assert "audio_base64" in body

        # Decode and verify the audio bytes match what the mock produced
        decoded = base64.b64decode(body["audio_base64"])
        assert decoded == b"audio_data_chunk"

        assert body["format"] == "mp3_44100_128"
        assert body["prompt"] == "upbeat electronic dance track"


# ==================== INTEGRATION TEST 3: Session Persistence ====================

@pytest.mark.asyncio
async def test_session_persistence_client_reuse(mock_mcp_client):
    """Tests that calling /agent/run twice with the same config reuses the MCPClient."""
    with patch("main.MCPClient") as MockClientClass, \
         patch("main._get_mcp_server_path", return_value="server.js"), \
         patch("main.run_agent_graph", new_callable=AsyncMock) as mock_run:

        MockClientClass.return_value = mock_mcp_client
        mock_run.return_value = ("Agent reply", None)

        request_data = {
            "prompt": "test prompt",
            "projectUrl": "https://beta.audiotool.com/studio?project=my-project",
            "llmProvider": "gemini",
            "authTokens": {
                "accessToken": "tok",
                "expiresAt": 9999999999999,
                "refreshToken": "ref",
                "clientId": "cid",
            },
        }

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            # First request -- should create a new client
            resp1 = await ac.post("/agent/run", json=request_data)
            assert resp1.status_code == 200

            # Second request with same projectUrl and llmProvider -- should reuse
            resp2 = await ac.post("/agent/run", json=request_data)
            assert resp2.status_code == 200

        # connect_to_server should have been called exactly once (client reused)
        mock_mcp_client.connect_to_server.assert_awaited_once()
        assert MockClientClass.call_count == 1
