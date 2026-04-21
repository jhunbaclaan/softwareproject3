import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from agents.graph import run_agent_graph, should_resolve_intent, route_after_precall
from agents.mcp_client_new import MCPClient


@pytest.mark.asyncio
async def test_run_agent_graph_project_config_precall():
    """Deterministic precall invokes update-project-config and passes result to the LLM loop."""
    mock_client = AsyncMock(spec=MCPClient)
    mock_session = AsyncMock()
    mock_client.session = mock_session
    mock_result = MagicMock()
    mock_result.isError = False
    mock_result.content = [MagicMock(text='Updated project config: {"tempoBpm":140}')]
    mock_session.call_tool.return_value = mock_result
    mock_client.run_llm_tool_loop.return_value = ("Acknowledged.", None)

    reply, music = await run_agent_graph(
        mock_client,
        query="set bpm to 140 and time signature to 1/4",
        history=[],
    )

    assert reply == "Acknowledged."
    update_calls = [
        c for c in mock_session.call_tool.call_args_list if c[0][0] == "update-project-config"
    ]
    assert len(update_calls) == 1
    assert update_calls[0][0][1] == {
        "tempoBpm": 140,
        "timeSignatureNumerator": 1,
        "timeSignatureDenominator": 4,
    }
    mock_client.run_llm_tool_loop.assert_called_once()
    precall = mock_client.run_llm_tool_loop.call_args.kwargs.get("project_config_precall")
    assert precall is not None
    assert "Success" in precall

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
    mock_client.run_llm_tool_loop.assert_called_once_with(
        [{"role": "user", "content": "add a beatbox8"}],
        resolved_intent_hint=None,
        daw_context=None,
        stream_callback=None,
        project_config_precall=None,
        melody_subagent_result=None,
    )

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
        [{"role": "user", "content": "make a drum beat in the style of Daft Punk"}],
        resolved_intent_hint="Mocked Result: Use machiniste",
        daw_context=None,
        stream_callback=None,
        project_config_precall=None,
        melody_subagent_result=None,
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
    """Test various style keywords and audio-shaping verbs.

    Style-identity phrases ("sounds like", "style of", "inspired by") still
    route through the synth recommender. Bare adjectives like ``warm`` or
    ``classic`` no longer count as style on their own — they either go
    straight to the main tool loop (so the LLM + audio-macros skill can
    decide) or, if the tightened AUDIO_SHAPING_PATTERNS matches, are
    short-circuited to ``run_llm_tools`` so no NEW device is added.
    """
    test_cases = [
        # Style-identity phrases → recommender
        ("make it sound like Daft Punk", "resolve_synth_intent"),
        ("make a beat in the style of Daft Punk", "resolve_synth_intent"),
        ("inspired by Aphex Twin", "resolve_synth_intent"),
        # Audio-shaping verbs → main tool loop (audio-macros skill)
        ("make this sound more bassy", "run_llm_tools"),
        ("can you make it warmer", "run_llm_tools"),
        ("make the lead wider", "run_llm_tools"),
        ("tighter and punchier please", "run_llm_tools"),
        ("add more reverb to the pad", "run_llm_tools"),
        # Bare adjectives are no longer style — fall through to LLM
        ("warm analog bass", "run_llm_tools"),
        ("classic 808 drum sound", "run_llm_tools"),
        # Specific entity / tool call → main tool loop
        ("add heisenberg synth", "run_llm_tools"),
        ("list entities", "run_llm_tools"),
    ]

    for query, expected_route in test_cases:
        result = should_resolve_intent({"current_query": query})
        assert result == expected_route, f"Failed for query: {query}"


def test_route_after_precall_precedence():
    """Audio intent beats melody; melody beats style fallback."""
    assert (
        route_after_precall({"current_query": "generate a bassline with elevenlabs vocals"})
        == "run_llm_tools"
    )
    assert (
        route_after_precall({"current_query": "write a funky bassline in abc notation"})
        == "generate_midi_melody"
    )
    assert (
        route_after_precall({"current_query": "inspired by Daft Punk"})
        == "resolve_synth_intent"
    )


@pytest.mark.asyncio
async def test_run_agent_graph_melody_query_runs_subagent_then_llm():
    """Melody queries should run the scoped melody loop before final response loop."""
    mock_client = AsyncMock(spec=MCPClient)
    mock_client.run_scoped_tool_loop.return_value = "Wrote a 8-bar Dorian bassline."
    mock_client.run_llm_tool_loop.return_value = ("Added an 8-bar Dorian bassline.", None)

    reply, music = await run_agent_graph(
        mock_client,
        query="write a funky bassline",
        history=[],
    )

    assert reply == "Added an 8-bar Dorian bassline."
    mock_client.run_scoped_tool_loop.assert_called_once()
    mock_client.run_llm_tool_loop.assert_called_once()
    kwargs = mock_client.run_llm_tool_loop.call_args.kwargs
    assert kwargs["melody_subagent_result"].startswith("Success:")


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
