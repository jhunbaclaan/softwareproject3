import pytest
from unittest.mock import AsyncMock, patch
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
    mock_client.run_llm_tool_loop.return_value = "Added beatbox8"

    reply = await run_agent_graph(mock_client, query="add a beatbox8", history=[])
    
    assert reply == "Added beatbox8"
    mock_client.run_llm_tool_loop.assert_called_once_with([{"role": "user", "content": "add a beatbox8"}, {"role": "model", "content": "Added beatbox8"}], resolved_intent_hint=None)

@pytest.mark.asyncio
async def test_run_agent_graph_with_intent_resolution():
    mock_client = AsyncMock(spec=MCPClient)
    # Mock intent resolution call
    mock_session = AsyncMock()
    mock_client.session = mock_session
    mock_session.call_tool.return_value = "Mocked Result: Use machiniste"
    mock_client._extract_tool_result = lambda x: x # pass through fake result string
    
    mock_client.run_llm_tool_loop.return_value = "Created machiniste"

    reply = await run_agent_graph(mock_client, query="make a drum beat in the style of Daft Punk", history=[])
    
    assert reply == "Created machiniste"
    mock_session.call_tool.assert_called_once_with("recommend-entity-for-style", {"description": "make a drum beat in the style of Daft Punk"})
    mock_client.run_llm_tool_loop.assert_called_once_with(
        [{"role": "user", "content": "make a drum beat in the style of Daft Punk"}, {"role": "model", "content": "Created machiniste"}],
        resolved_intent_hint="Mocked Result: Use machiniste"
    )
