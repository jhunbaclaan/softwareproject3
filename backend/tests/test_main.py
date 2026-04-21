import pytest
import asyncio
from httpx import AsyncClient, ASGITransport
from main import app, _ensure_client, _client, _client_project_url, _client_llm_provider
from unittest.mock import patch, AsyncMock, MagicMock
from tests.fixtures import sample_agent_request, sample_agent_request_no_auth, sample_auth_tokens, mock_mcp_client

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


@pytest.mark.asyncio
async def test_health_check():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}

@pytest.mark.asyncio
async def test_agent_run():
    with patch("main._ensure_client", new_callable=AsyncMock) as mock_ensure, \
         patch("main.run_agent_graph") as mock_run:

        mock_client = AsyncMock()
        mock_client.set_elevenlabs_api_key = MagicMock()
        mock_ensure.return_value = mock_client
        mock_run.return_value = ("Agent reply", None)

        request_data = {"prompt": "add synth"}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            response = await ac.post("/agent/run", json=request_data)

        assert response.status_code == 200
        data = _parse_sse_reply(response)
        assert data.get("reply") == "Agent reply"


# ==================== CLIENT LIFECYCLE TESTS ====================

@pytest.mark.asyncio
async def test_client_reused_when_config_unchanged(sample_agent_request, mock_mcp_client):
    """Ensure client is not recreated when config is the same."""
    with patch("main.MCPClient") as MockClient, \
         patch("main._get_mcp_server_path", return_value="server.js"):

        MockClient.return_value = mock_mcp_client

        # First call
        client1 = await _ensure_client(sample_agent_request)
        call_count_1 = MockClient.call_count

        # Second call with same config
        client2 = await _ensure_client(sample_agent_request)
        call_count_2 = MockClient.call_count

        # Client should be reused (no new instance created)
        assert client1 is client2
        assert call_count_1 == call_count_2


@pytest.mark.asyncio
async def test_client_recreated_when_project_changes(sample_agent_request, mock_mcp_client):
    """Ensure new client is created when projectUrl changes."""
    import main

    with patch("main.MCPClient") as MockClient, \
         patch("main._get_mcp_server_path", return_value="server.js"):

        MockClient.return_value = mock_mcp_client
        main._client = None

        # First call
        await _ensure_client(sample_agent_request)
        call_count_1 = MockClient.call_count

        # Change project URL
        request2 = sample_agent_request.model_copy()
        request2.projectUrl = "https://beta.audiotool.com/studio?project=different-project"

        await _ensure_client(request2)
        call_count_2 = MockClient.call_count

        # New client should be created
        assert call_count_2 > call_count_1


@pytest.mark.asyncio
async def test_client_recreated_when_llm_provider_changes(sample_agent_request, mock_mcp_client):
    """Ensure new client is created when llmProvider changes."""
    import main

    with patch("main.MCPClient") as MockClient, \
         patch("main._get_mcp_server_path", return_value="server.js"):

        MockClient.return_value = mock_mcp_client
        main._client = None

        await _ensure_client(sample_agent_request)
        initial_count = MockClient.call_count

        # Change LLM provider
        request2 = sample_agent_request.model_copy()
        request2.llmProvider = "anthropic"

        await _ensure_client(request2)
        new_count = MockClient.call_count

        assert new_count > initial_count


# ==================== LLM PROVIDER TESTS ====================

@pytest.mark.asyncio
async def test_agent_run_with_gemini():
    """Test agent execution with Gemini provider."""
    with patch("main._ensure_client", new_callable=AsyncMock) as mock_ensure, \
         patch("main.run_agent_graph") as mock_run:

        mock_client = AsyncMock()
        mock_client.set_elevenlabs_api_key = MagicMock()
        mock_ensure.return_value = mock_client
        mock_run.return_value = ("Gemini response", None)

        request_data = {
            "prompt": "test",
            "llmProvider": "gemini"
        }

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            response = await ac.post("/agent/run", json=request_data)

        assert response.status_code == 200
        data = _parse_sse_reply(response)
        assert "Gemini response" in data.get("reply", "")


@pytest.mark.asyncio
async def test_agent_run_with_anthropic():
    """Test agent execution with Anthropic provider."""
    with patch("main._ensure_client", new_callable=AsyncMock) as mock_ensure, \
         patch("main.run_agent_graph") as mock_run:

        mock_client = AsyncMock()
        mock_client.set_elevenlabs_api_key = MagicMock()
        mock_ensure.return_value = mock_client
        mock_run.return_value = ("Anthropic response", None)

        request_data = {
            "prompt": "test",
            "llmProvider": "anthropic"
        }

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            response = await ac.post("/agent/run", json=request_data)

        assert response.status_code == 200
        data = _parse_sse_reply(response)
        assert "Anthropic response" in data.get("reply", "")


@pytest.mark.asyncio
async def test_agent_run_with_openai():
    """Test agent execution with OpenAI provider."""
    with patch("main._ensure_client", new_callable=AsyncMock) as mock_ensure, \
         patch("main.run_agent_graph") as mock_run:

        mock_client = AsyncMock()
        mock_client.set_elevenlabs_api_key = MagicMock()
        mock_ensure.return_value = mock_client
        mock_run.return_value = ("OpenAI response", None)

        request_data = {
            "prompt": "test",
            "llmProvider": "openai"
        }

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            response = await ac.post("/agent/run", json=request_data)

        assert response.status_code == 200
        data = _parse_sse_reply(response)
        assert "OpenAI response" in data.get("reply", "")


# ==================== AUTH TOKEN TESTS ====================

@pytest.mark.asyncio
async def test_agent_run_with_auth_tokens(sample_auth_tokens):
    """Test agent with valid auth tokens."""
    with patch("main._ensure_client", new_callable=AsyncMock) as mock_ensure, \
         patch("main.run_agent_graph") as mock_run:

        mock_client = AsyncMock()
        mock_client.set_elevenlabs_api_key = MagicMock()
        mock_ensure.return_value = mock_client
        mock_run.return_value = ("Success with auth", None)

        request_data = {
            "prompt": "add synth",
            "authTokens": sample_auth_tokens.model_dump(),
            "projectUrl": "https://beta.audiotool.com/studio?project=test"
        }

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            response = await ac.post("/agent/run", json=request_data)

        assert response.status_code == 200
        data = _parse_sse_reply(response)
        assert data.get("reply") == "Success with auth"


@pytest.mark.asyncio
async def test_agent_run_rejects_auth_tokens_missing_refresh_token():
    """Auth token payload now requires refreshToken."""
    request_data = {
        "prompt": "add synth",
        "authTokens": {
            "accessToken": "tok",
            "expiresAt": 9999999999999,
            "clientId": "cid",
        },
        "projectUrl": "https://beta.audiotool.com/studio?project=test",
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/agent/run", json=request_data)

    assert response.status_code == 422
    detail = response.json().get("detail", [])
    assert any(
        err.get("loc") == ["body", "authTokens", "refreshToken"]
        for err in detail
    )


@pytest.mark.asyncio
async def test_agent_run_accepts_legacy_auth_fields_but_ignores_them():
    """Legacy redirectUrl/scope fields should not break request parsing."""
    with patch("main._ensure_client", new_callable=AsyncMock) as mock_ensure, \
         patch("main.run_agent_graph") as mock_run:

        mock_client = AsyncMock()
        mock_client.set_elevenlabs_api_key = MagicMock()
        mock_ensure.return_value = mock_client
        mock_run.return_value = ("Success with legacy extras", None)

        request_data = {
            "prompt": "add synth",
            "authTokens": {
                "accessToken": "tok",
                "expiresAt": 9999999999999,
                "refreshToken": "ref",
                "clientId": "cid",
                "redirectUrl": "http://localhost/callback",
                "scope": "project:write sample:write",
            },
            "projectUrl": "https://beta.audiotool.com/studio?project=test",
        }

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            response = await ac.post("/agent/run", json=request_data)

        assert response.status_code == 200
        parsed_request = mock_ensure.await_args.args[0]
        auth = parsed_request.authTokens
        assert auth is not None
        assert auth.model_dump() == {
            "accessToken": "tok",
            "expiresAt": 9999999999999,
            "refreshToken": "ref",
            "clientId": "cid",
        }


@pytest.mark.asyncio
async def test_ensure_client_passes_refresh_token_to_initialize_session(sample_agent_request, mock_mcp_client):
    """Client bootstrap must forward refresh_token to initialize-session."""
    import main

    with patch("main.MCPClient") as MockClient, \
         patch("main._get_mcp_server_path", return_value="server.js"):

        MockClient.return_value = mock_mcp_client
        main._client = None

        await _ensure_client(sample_agent_request)

        mock_mcp_client.initialize_session.assert_awaited_once()
        assert (
            mock_mcp_client.initialize_session.await_args.kwargs["refresh_token"]
            == sample_agent_request.authTokens.refreshToken
        )
        main._client = None
        main._client_project_url = None
        main._client_llm_provider = "gemini"
        main._client_llm_api_key = None


@pytest.mark.asyncio
async def test_agent_run_without_auth_tokens():
    """Test agent without auth tokens (should still work)."""
    with patch("main._ensure_client", new_callable=AsyncMock) as mock_ensure, \
         patch("main.run_agent_graph") as mock_run:

        mock_client = AsyncMock()
        mock_client.set_elevenlabs_api_key = MagicMock()
        mock_ensure.return_value = mock_client
        mock_run.return_value = ("Success without auth", None)

        request_data = {"prompt": "test"}

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            response = await ac.post("/agent/run", json=request_data)

        assert response.status_code == 200
        data = _parse_sse_reply(response)
        assert data.get("reply") == "Success without auth"


# ==================== CONVERSATION HISTORY TESTS ====================

@pytest.mark.asyncio
async def test_agent_run_with_conversation_history():
    """Test agent with prior conversation messages."""
    with patch("main._ensure_client", new_callable=AsyncMock) as mock_ensure, \
         patch("main.run_agent_graph") as mock_run:

        mock_client = AsyncMock()
        mock_client.set_elevenlabs_api_key = MagicMock()
        mock_ensure.return_value = mock_client
        mock_run.return_value = ("Contextual response", None)

        request_data = {
            "prompt": "continue",
            "messages": [
                {"role": "user", "content": "Hello"},
                {"role": "model", "content": "Hi!"}
            ]
        }

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            response = await ac.post("/agent/run", json=request_data)

        assert response.status_code == 200
        mock_run.assert_called_once()


@pytest.mark.asyncio
async def test_agent_run_with_empty_history():
    """Test agent with no prior conversation."""
    with patch("main._ensure_client", new_callable=AsyncMock) as mock_ensure, \
         patch("main.run_agent_graph") as mock_run:

        mock_client = AsyncMock()
        mock_client.set_elevenlabs_api_key = MagicMock()
        mock_ensure.return_value = mock_client
        mock_run.return_value = ("Fresh start", None)

        request_data = {"prompt": "hello"}

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            response = await ac.post("/agent/run", json=request_data)

        assert response.status_code == 200
        mock_run.assert_called_once()


# ==================== ERROR SCENARIO TESTS ====================

@pytest.mark.asyncio
async def test_agent_run_with_exception():
    """Test error handling when agent raises exception."""
    with patch("main._ensure_client") as mock_ensure:
        mock_ensure.side_effect = Exception("Connection failed")

        request_data = {"prompt": "test"}

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            response = await ac.post("/agent/run", json=request_data)

        assert response.status_code == 200  # FastAPI returns 200 with error in SSE
        data = _parse_sse_reply(response)
        assert "Connection failed" in data.get("error", "")


@pytest.mark.asyncio
async def test_agent_run_timeout_returns_explicit_timeout_message():
    """Timeouts should surface a clear user-facing error message."""
    with patch("main._ensure_client", new_callable=AsyncMock) as mock_ensure, \
         patch("main.run_agent_graph", new_callable=AsyncMock) as mock_run:

        mock_client = AsyncMock()
        mock_client.set_elevenlabs_api_key = MagicMock()
        mock_ensure.return_value = mock_client
        mock_run.side_effect = asyncio.TimeoutError()

        request_data = {"prompt": "mix and master this track"}

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            response = await ac.post("/agent/run", json=request_data)

        assert response.status_code == 200
        data = _parse_sse_reply(response)
        assert "timed out after 300 seconds" in data.get("error", "")

