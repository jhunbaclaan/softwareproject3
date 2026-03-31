"""Tests for MCP client functionality."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from agents.mcp_client_new import MCPClient
from google.genai import types


@pytest.mark.asyncio
async def test_connect_to_server():
    """Test connection to MCP server."""
    client = MCPClient(llm_provider="gemini")

    with patch("agents.mcp_client_new.stdio_client") as mock_stdio, \
         patch("agents.mcp_client_new.ClientSession") as mock_session:

        mock_stdio.return_value.__aenter__ = AsyncMock(return_value=(MagicMock(), MagicMock()))
        mock_session_instance = AsyncMock()
        mock_session_instance.initialize = AsyncMock()
        mock_session_instance.list_tools = AsyncMock(return_value=MagicMock(tools=[]))
        mock_session.return_value.__aenter__ = AsyncMock(return_value=mock_session_instance)

        await client.connect_to_server("test_server.js")

        assert client.session is not None
        mock_session_instance.initialize.assert_called_once()


@pytest.mark.asyncio
async def test_initialize_session_with_tokens():
    """Test session initialization with auth tokens."""
    client = MCPClient(llm_provider="gemini")
    client.session = AsyncMock()

    mock_result = MagicMock()
    mock_result.isError = False
    mock_result.content = [MagicMock(text="Session initialized")]
    client.session.call_tool = AsyncMock(return_value=mock_result)

    result = await client.initialize_session(
        access_token="test_token",
        expires_at=9999999999,
        client_id="test_client",
        redirect_url="http://localhost",
        scope="project:write",
        project_url="http://test-project"
    )

    assert "Session initialized" in result
    client.session.call_tool.assert_called_once()
    call_args = client.session.call_tool.call_args
    assert call_args[0][0] == "initialize-session"
    assert call_args[0][1]["projectUrl"] == "http://test-project"


@pytest.mark.asyncio
async def test_tool_schema_conversion_gemini():
    """Test MCP → Gemini schema conversion."""
    from agents.schema_converter import convert_mcp_schema_to_gemini

    mcp_schema = {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "count": {"type": "integer"}
        },
        "required": ["name"]
    }

    result = convert_mcp_schema_to_gemini(mcp_schema)

    assert "properties" in result
    assert "name" in result["properties"]


@pytest.mark.asyncio
async def test_tool_schema_conversion_anthropic():
    """Test MCP → Anthropic schema conversion."""
    from agents.schema_converter import convert_mcp_schema_to_anthropic

    mcp_schema = {
        "type": "object",
        "properties": {
            "entityType": {"type": "string"}
        }
    }

    result = convert_mcp_schema_to_anthropic(mcp_schema)

    assert result["type"] == "object"
    assert "properties" in result


@pytest.mark.asyncio
async def test_tool_loop_max_iterations():
    """Test that tool loop stops after max iterations."""
    client = MCPClient(llm_provider="gemini")
    client.session = AsyncMock()
    client._gemini_client = MagicMock()

    # Mock infinite tool calls
    mock_response = MagicMock()
    mock_response.candidates = [MagicMock()]
    mock_response.candidates[0].content = MagicMock()
    mock_part = MagicMock()
    mock_part.function_call = MagicMock()
    mock_part.function_call.name = "test_tool"
    mock_part.function_call.args = {}
    mock_response.candidates[0].content.parts = [mock_part]

    client._gemini_client.aio.models.generate_content = AsyncMock(return_value=mock_response)
    client.session.call_tool = AsyncMock(return_value=MagicMock(content=[MagicMock(text="result")]))

    config = types.GenerateContentConfig(tools=[])
    contents = [types.Content(parts=[types.Part.from_text(text="test")], role="user")]

    # Should stop after max_iterations even if tool calls continue
    result_contents, reply, music = await client.run_tool_loop(contents, config, max_iterations=3)

    # Should have called generate_content at most 4 times (initial + 3 iterations)
    assert client._gemini_client.aio.models.generate_content.call_count <= 4


@pytest.mark.asyncio
async def test_tool_call_error_recovery():
    """Test handling of tool call failures."""
    client = MCPClient(llm_provider="gemini")
    client.session = AsyncMock()
    client._gemini_client = MagicMock()

    # Mock tool call that fails
    client.session.call_tool = AsyncMock(side_effect=Exception("Tool failed"))

    # Mock response with function call
    mock_response = MagicMock()
    mock_response.candidates = [MagicMock()]
    mock_response.candidates[0].content = MagicMock()
    mock_part = MagicMock()
    mock_part.function_call = MagicMock()
    mock_part.function_call.name = "failing_tool"
    mock_part.function_call.args = {}
    mock_response.candidates[0].content.parts = [mock_part]

    # Second response with text (no more function calls)
    mock_final_response = MagicMock()
    mock_final_response.candidates = [MagicMock()]
    mock_final_response.candidates[0].content = MagicMock()
    mock_final_response.candidates[0].content.parts = [MagicMock(text="Error handled", function_call=None)]

    client._gemini_client.aio.models.generate_content = AsyncMock(side_effect=[mock_response, mock_final_response])

    config = types.GenerateContentConfig(tools=[])
    contents = [types.Content(parts=[types.Part.from_text(text="test")], role="user")]

    result_contents, reply, music = await client.run_tool_loop(contents, config, max_iterations=5)

    # Should recover from error and continue
    assert "Error handled" in reply or "Error calling tool" in str(result_contents)


@pytest.mark.asyncio
async def test_extract_tool_result():
    """Test extraction of text from MCP CallToolResult."""
    mock_result = MagicMock()
    mock_result.content = [
        MagicMock(text="Line 1"),
        MagicMock(text="Line 2")
    ]

    result = MCPClient._extract_tool_result(mock_result)

    assert result == "Line 1\nLine 2"


@pytest.mark.asyncio
async def test_cleanup():
    """Test client cleanup."""
    client = MCPClient(llm_provider="gemini")
    client.exit_stack = AsyncMock()
    client.exit_stack.aclose = AsyncMock()

    await client.cleanup()

    client.exit_stack.aclose.assert_called_once()
