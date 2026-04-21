"""Reusable test fixtures for backend tests."""

import pytest
from unittest.mock import AsyncMock, MagicMock
from models.schemas import AuthTokens, AgentRequest, ConversationMessage


@pytest.fixture
def sample_auth_tokens() -> AuthTokens:
    """Sample auth token payload for testing."""
    return AuthTokens(
        accessToken="test_access_token_12345",
        expiresAt=9999999999999,  # Far future
        refreshToken="test_refresh_token_67890",
        clientId="test_client_id",
    )


@pytest.fixture
def sample_agent_request(sample_auth_tokens) -> AgentRequest:
    """Sample agent request with all fields populated."""
    return AgentRequest(
        prompt="Add a heisenberg synth",
        keywords=["synth", "heisenberg"],
        loop=1,
        authTokens=sample_auth_tokens,
        projectUrl="https://beta.audiotool.com/studio?project=test-project",
        messages=[
            ConversationMessage(role="user", content="Hello"),
            ConversationMessage(role="model", content="Hi there!")
        ],
        llmProvider="gemini",
        llmApiKey=None
    )


@pytest.fixture
def sample_agent_request_no_auth() -> AgentRequest:
    """Sample agent request without authentication."""
    return AgentRequest(
        prompt="Add a drum beat",
        keywords=[],
        loop=1,
        authTokens=None,
        projectUrl=None,
        messages=None,
        llmProvider="gemini",
        llmApiKey=None
    )


@pytest.fixture
def mock_mcp_client():
    """Reusable mock MCP client."""
    client = AsyncMock()
    client.set_elevenlabs_api_key = MagicMock()
    client.session = AsyncMock()
    client.run_llm_tool_loop = AsyncMock(return_value="Agent response")
    client.cleanup = AsyncMock()
    client._extract_tool_result = lambda x: str(x)
    return client


@pytest.fixture
def mock_elevenlabs_client():
    """Reusable mock ElevenLabs client."""
    client = MagicMock()
    client.music.stream.return_value = [b"audio", b"_data", b"_chunk"]
    return client
