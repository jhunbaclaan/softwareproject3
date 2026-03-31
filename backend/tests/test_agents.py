import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from agents.graph import run_agent_graph, should_resolve_intent
from agents.mcp_client_new import MCPClient

def test_should_resolve_intent():
    # Style queries should route to intent resolver
    assert should_resolve_intent({"current_query": "make a beat in the style of Daft Punk"}) == "resolve_synth_intent"
    assert should_resolve_intent({"current_query": "sounds like a classic 808"}) == "resolve_synth_intent"

    # Generic queries go straight to LLM tools
    assert should_resolve_intent({"current_query": "add a beatbox8"}) == "run_llm_tools"
    assert should_resolve_intent({"current_query": "remove the delay effect"}) == "run_llm_tools"

@pytest.mark.asyncio
async def test_run_agent_graph_no_intent_resolution():
    mock_client = AsyncMock(spec=MCPClient)
    mock_client.run_llm_tool_loop.return_value = ("Added beatbox8", None)

    reply, music = await run_agent_graph(mock_client, query="add a beatbox8", history=[])

    assert reply == "Added beatbox8"
    mock_client.run_llm_tool_loop.assert_called_once_with([{"role": "user", "content": "add a beatbox8"}, {"role": "model", "content": "Added beatbox8"}], resolved_intent_hint=None, daw_context=None, stream_callback=None)

@pytest.mark.asyncio
async def test_run_agent_graph_with_intent_resolution():
    mock_client = AsyncMock(spec=MCPClient)
    # Mock intent resolution call
    mock_session = AsyncMock()
    mock_client.session = mock_session
    mock_session.call_tool.return_value = "Mocked Result: Use machiniste"
    mock_client._extract_tool_result = lambda x: x # pass through fake result string

    mock_client.run_llm_tool_loop.return_value = ("Created machiniste", None)

    reply, music = await run_agent_graph(mock_client, query="make a drum beat in the style of Daft Punk", history=[])

    assert reply == "Created machiniste"
    mock_session.call_tool.assert_called_once_with("recommend-entity-for-style", {"description": "make a drum beat in the style of Daft Punk"})
    mock_client.run_llm_tool_loop.assert_called_once_with(
        [{"role": "user", "content": "make a drum beat in the style of Daft Punk"}, {"role": "model", "content": "Created machiniste"}],
        resolved_intent_hint="Mocked Result: Use machiniste",
        daw_context=None,
        stream_callback=None
    )


# ==================== ADDITIONAL AGENT TESTS ====================

@pytest.mark.asyncio
async def test_intent_resolution_fails_gracefully():
    """Test when recommend-entity-for-style tool fails."""
    mock_client = AsyncMock(spec=MCPClient)
    mock_session = AsyncMock()
    mock_client.session = mock_session

    # Mock tool call failure
    mock_session.call_tool.side_effect = Exception("Tool call failed")

    # Even if intent resolution fails, the agent should still attempt to process
    mock_client.run_llm_tool_loop.return_value = ("Processed anyway", None)

    reply, music = await run_agent_graph(mock_client, query="style of Aphex Twin", history=[])

    # Should still get a response (fallback behavior)
    assert "Processed anyway" in reply or reply is not None


@pytest.mark.asyncio
async def test_multiple_user_turns():
    """Test agent with multiple back-and-forth exchanges."""
    mock_client = AsyncMock(spec=MCPClient)
    mock_client.run_llm_tool_loop.return_value = ("Continuing conversation", None)

    # History with multiple turns
    history = [
        {"role": "user", "content": "Add a synth"},
        {"role": "model", "content": "Added heisenberg"},
        {"role": "user", "content": "Now add a delay"},
        {"role": "model", "content": "Added stompboxDelay"}
    ]

    reply, music = await run_agent_graph(mock_client, query="Connect them together", history=history)

    assert reply == "Continuing conversation"
    # Verify history was passed
    call_args = mock_client.run_llm_tool_loop.call_args
    passed_messages = call_args[0][0]
    # Should have all history plus new query
    assert len(passed_messages) >= len(history) + 1


@pytest.mark.asyncio
async def test_style_pattern_matching():
    """Test various style keywords."""
    test_cases = [
        ("make it sound like Daft Punk", "resolve_synth_intent"),
        ("classic 808 drum sound", "resolve_synth_intent"),
        ("warm analog bass", "resolve_synth_intent"),
        ("add heisenberg synth", "run_llm_tools"),  # Specific entity = no resolution
        ("list entities", "run_llm_tools"),  # Tool call = no resolution
    ]

    for query, expected_route in test_cases:
        result = should_resolve_intent({"current_query": query})
        assert result == expected_route, f"Failed for query: {query}"


@pytest.mark.asyncio
async def test_agent_with_conversation_context():
    """Test that conversation history is properly maintained."""
    mock_client = AsyncMock(spec=MCPClient)
    mock_client.run_llm_tool_loop.return_value = ("Updated synth", None)

    history = [
        {"role": "user", "content": "Add a heisenberg synth"},
        {"role": "model", "content": "Added heisenberg with ID xyz"}
    ]

    reply, music = await run_agent_graph(
        mock_client,
        query="Now change its gain to 0.8",
        history=history
    )

    # Verify the agent received the history
    call_args = mock_client.run_llm_tool_loop.call_args[0][0]
    # Should include previous context
    assert any("heisenberg" in str(msg.get("content", "")).lower() for msg in call_args)
