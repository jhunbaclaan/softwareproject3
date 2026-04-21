"""Tests for MCP client functionality."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from elevenlabs.core.api_error import ApiError

from agents.mcp_client_new import (
    MCPClient,
    SYSTEM_INSTRUCTION,
    _normalize_music_length_ms,
    _normalize_music_prompt,
)
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
        project_url="http://test-project",
        refresh_token="test_refresh",
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
async def test_dispatch_tool_raises_when_mcp_returns_is_error():
    """MCP tool-level errors should count as failures in loop logic."""
    client = MCPClient(llm_provider="gemini")
    client.session = AsyncMock()

    mock_result = MagicMock()
    mock_result.isError = True
    mock_result.content = [MagicMock(text="validation failed")]
    client.session.call_tool = AsyncMock(return_value=mock_result)

    with pytest.raises(RuntimeError, match="validation failed"):
        await client._dispatch_tool("connect-entities", {"connections": []})


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


def test_normalize_music_prompt_list_and_string():
    assert _normalize_music_prompt(["a", "b", "c"]) == "a b c"
    assert _normalize_music_prompt("  x  ") == "x"
    assert _normalize_music_prompt(42) == "42"


def test_normalize_music_length_ms_types():
    assert _normalize_music_length_ms(None) == 15000
    assert _normalize_music_length_ms(True) == 15000
    assert _normalize_music_length_ms(5000.7) == 5001
    assert _normalize_music_length_ms("5000") == 5000
    assert _normalize_music_length_ms("  12000.2 ") == 12000
    assert _normalize_music_length_ms(700_000) == 600_000


@pytest.mark.asyncio
async def test_execute_generate_music_coerces_and_formats_errors():
    client = MCPClient(llm_provider="gemini")
    with patch(
        "agents.mcp_client_new.generate_music_base64", new_callable=AsyncMock
    ) as mock_gm:
        mock_gm.return_value = ("Ym9n", "mp3_44100_128", "echo", 5000)
        text, attach = await client._execute_generate_music(
            {
                "prompt": ["lo", "fi"],
                "music_length_ms": "8000",
                "force_instrumental": "yes",
            }
        )
        assert "Success" in text
        assert "Instrumental-only" in text
        assert "Nexus web app" in text
        assert attach["audio_base64"] == "Ym9n"
        assert mock_gm.call_count == 1
        assert mock_gm.call_args.kwargs["prompt"] == "lo fi"
        assert mock_gm.call_args.kwargs["music_length_ms"] == 8000
        assert mock_gm.call_args.kwargs["force_instrumental"] is True

        mock_gm.return_value = ("Ym9n", "mp3_44100_128", "echo", 5000)
        text_v, _ = await client._execute_generate_music(
            {"prompt": "sing these lyrics", "force_instrumental": False}
        )
        assert "Success" in text_v
        assert "Instrumental-only" not in text_v
        assert mock_gm.call_count == 2
        mock_gm.assert_called_with(
            prompt="sing these lyrics",
            music_length_ms=15000,
            force_instrumental=False,
            api_key=None,
        )

    with patch(
        "agents.mcp_client_new.generate_music_base64",
        new_callable=AsyncMock,
        side_effect=ApiError(
            status_code=400, headers={}, body={"detail": "bad prompt"}
        ),
    ):
        text, attach = await client._execute_generate_music({"prompt": "x"})
        assert attach is None
        assert "HTTP 400" in text
        assert "bad prompt" in text


@pytest.mark.asyncio
async def test_run_scoped_tool_loop_anthropic_filters_allowlist():
    client = MCPClient(llm_provider="anthropic")
    client._get_anthropic_tools = AsyncMock(
        return_value=[
            {"name": "add-abc-track"},
            {"name": "get-project-summary"},
        ]
    )
    client.run_tool_loop_anthropic = AsyncMock(return_value=([], "anthropic-ok", None))

    reply = await client.run_scoped_tool_loop(
        user_message="write a melody",
        system_instruction="scoped-system",
        tool_allowlist={"add-abc-track"},
    )

    assert reply == "anthropic-ok"
    client.run_tool_loop_anthropic.assert_awaited_once()
    call = client.run_tool_loop_anthropic.await_args
    assert call.args[0] == [{"role": "user", "content": "write a melody"}]
    assert call.kwargs["system"] == "scoped-system"
    assert call.kwargs["tools"] == [{"name": "add-abc-track"}]


@pytest.mark.asyncio
async def test_run_scoped_tool_loop_anthropic_raises_when_no_allowlisted_tool():
    client = MCPClient(llm_provider="anthropic")
    client._get_anthropic_tools = AsyncMock(return_value=[{"name": "inspect-entity"}])

    with pytest.raises(RuntimeError, match="No tools in allowlist"):
        await client.run_scoped_tool_loop(
            user_message="write a melody",
            system_instruction="scoped-system",
            tool_allowlist={"add-abc-track"},
        )


@pytest.mark.asyncio
async def test_run_scoped_tool_loop_openai_filters_allowlist():
    client = MCPClient(llm_provider="openai")
    client._get_openai_tools = AsyncMock(
        return_value=[
            {"type": "function", "function": {"name": "add-abc-track"}},
            {"type": "function", "function": {"name": "get-project-summary"}},
        ]
    )
    client.run_tool_loop_openai = AsyncMock(return_value=([], "openai-ok", None))

    reply = await client.run_scoped_tool_loop(
        user_message="write bassline",
        system_instruction="scoped-system",
        tool_allowlist={"get-project-summary"},
    )

    assert reply == "openai-ok"
    client.run_tool_loop_openai.assert_awaited_once()
    call = client.run_tool_loop_openai.await_args
    assert call.args[0] == [{"role": "user", "content": "write bassline"}]
    assert call.kwargs["system"] == "scoped-system"
    assert call.kwargs["tools"] == [
        {"type": "function", "function": {"name": "get-project-summary"}}
    ]


@pytest.mark.asyncio
async def test_run_scoped_tool_loop_openai_raises_when_no_allowlisted_tool():
    client = MCPClient(llm_provider="openai")
    client._get_openai_tools = AsyncMock(
        return_value=[{"type": "function", "function": {"name": "inspect-entity"}}]
    )

    with pytest.raises(RuntimeError, match="No tools in allowlist"):
        await client.run_scoped_tool_loop(
            user_message="x",
            system_instruction="y",
            tool_allowlist={"add-abc-track"},
        )


@pytest.mark.asyncio
async def test_run_scoped_tool_loop_gemini_filters_allowlist():
    client = MCPClient(llm_provider="gemini")
    decl_a = types.FunctionDeclaration(name="add-abc-track", description="a", parameters={})
    decl_b = types.FunctionDeclaration(name="inspect-entity", description="b", parameters={})
    client._get_gemini_tools = AsyncMock(
        return_value=[types.Tool(function_declarations=[decl_a, decl_b])]
    )
    client.run_tool_loop = AsyncMock(return_value=([], "gemini-ok", None))

    reply = await client.run_scoped_tool_loop(
        user_message="make notes",
        system_instruction="scoped-system",
        tool_allowlist={"add-abc-track"},
    )

    assert reply == "gemini-ok"
    client.run_tool_loop.assert_awaited_once()
    call = client.run_tool_loop.await_args
    assert len(call.args[0]) == 1
    assert call.args[0][0].role == "user"
    assert call.args[0][0].parts[0].text == "make notes"
    filtered_decl_names = [d.name for d in call.args[1].tools[0].function_declarations]
    assert filtered_decl_names == ["add-abc-track"]


@pytest.mark.asyncio
async def test_run_scoped_tool_loop_gemini_raises_when_no_allowlisted_tool():
    client = MCPClient(llm_provider="gemini")
    decl = types.FunctionDeclaration(name="inspect-entity", description="x", parameters={})
    client._get_gemini_tools = AsyncMock(
        return_value=[types.Tool(function_declarations=[decl])]
    )

    with pytest.raises(RuntimeError, match="No tools in allowlist"):
        await client.run_scoped_tool_loop(
            user_message="x",
            system_instruction="y",
            tool_allowlist={"add-abc-track"},
        )


def test_system_instruction_includes_mastering_safety_for_audio_tracks():
    """Instruction should prevent muting imported sample/audio tracks during mastering."""
    lowered = SYSTEM_INSTRUCTION.lower()
    assert "mastering / mixing safety" in lowered
    assert "inspect the project" in lowered
    assert "audio-track players" in lowered
    assert "audioDevice".lower() in lowered
    assert "disconnect a source cable" in lowered
    assert "reconnect that same source" in lowered


def test_system_instruction_includes_mixing_fx_safety():
    """Mixing/FX edits should preserve all audible sources like mastering."""
    lowered = SYSTEM_INSTRUCTION.lower()
    assert "mastering / mixing safety" in lowered
    assert "audio-track" in lowered or "audio-track players" in lowered
    assert "targeted value/connection updates" in lowered
    assert "bulk removal" in lowered


def test_mixing_skill_markdown_includes_source_preservation():
    """04_mixing_and_fx.md should document audio tracks and non-destructive edits."""
    from pathlib import Path

    path = Path(__file__).resolve().parent.parent / "agents" / "skills" / "04_mixing_and_fx.md"
    text = path.read_text(encoding="utf-8").lower()
    assert "source safety" in text
    assert "audiodevice" in text
    assert "get-project-summary" in text
    assert "post-check" in text
