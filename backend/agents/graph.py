"""
LangGraph-based agent pipeline for the Audiotool MCP assistant.

The graph wraps the existing MCPClient tool-calling loop inside a stateful
LangGraph StateGraph so that:

 - Conversation history persists across nodes.
 - An optional "resolve synth intent" node can map vague style descriptions
   (e.g. "Daft Punk") to a concrete entity type before the main tool node.
 - Default-position logic is handled transparently (the MCP server fills in
   defaults when x/y are omitted).
"""

from __future__ import annotations

import re
from typing import Any, Optional, Sequence, TypedDict

from google.genai import types
from langgraph.graph import END, StateGraph

from .mcp_client_new import MCPClient, SYSTEM_INSTRUCTION


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

class AgentState(TypedDict, total=False):
    """Shared state flowing through the graph.

    LangGraph uses a *replace* strategy for plain TypedDict keys: each node
    should return a dict containing **only the keys it wants to update**.
    """
    messages: list[dict[str, str]]
    current_query: str
    resolved_intent: Optional[str]
    reply: str
    mcp_client: Any


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------

STYLE_PATTERNS = re.compile(
    r"\b(sound(?:s)? like|style of|genre|vibe|make it|inspired by)\b",
    re.IGNORECASE,
)


async def add_user_turn(state: AgentState) -> dict:
    """Append the latest user message to the conversation."""
    msgs = list(state.get("messages") or [])
    msgs.append({"role": "user", "content": state["current_query"]})
    return {"messages": msgs, "resolved_intent": None}


async def resolve_synth_intent(state: AgentState) -> dict:
    """If the query looks like a vague style request, call the MCP
    ``recommend-entity-for-style`` tool and store the recommendation so the
    main tool node can use it."""
    client: MCPClient = state["mcp_client"]
    query = state["current_query"]

    try:
        result = await client.session.call_tool(
            "recommend-entity-for-style", {"description": query}
        )
        result_str = MCPClient._extract_tool_result(result)
        return {"resolved_intent": result_str}
    except Exception as exc:
        print(f"[graph] resolve_synth_intent failed: {exc}")
        return {"resolved_intent": None}


async def run_gemini_tools(state: AgentState) -> dict:
    """Run the Gemini + MCP tool-calling loop with full conversation context."""
    client: MCPClient = state["mcp_client"]
    messages = list(state.get("messages") or [])

    tools = await client._get_gemini_tools()
    config = types.GenerateContentConfig(
        tools=tools,
        system_instruction=SYSTEM_INSTRUCTION,
    )

    contents: list = []
    for msg in messages:
        role = msg["role"] if msg["role"] in ("user", "model") else "user"
        contents.append(
            types.Content(parts=[types.Part.from_text(text=msg["content"])], role=role)
        )

    if state.get("resolved_intent"):
        hint = (
            f"[system hint] The recommend-entity-for-style tool returned: "
            f"{state['resolved_intent']}. Use this recommendation when deciding "
            f"which entity to add."
        )
        contents.append(
            types.Content(parts=[types.Part.from_text(text=hint)], role="user")
        )

    _, reply = await client.run_tool_loop(contents, config)

    messages.append({"role": "model", "content": reply})
    return {"messages": messages, "reply": reply}


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------

def should_resolve_intent(state: AgentState) -> str:
    """Decide whether to route through the intent-resolution node."""
    query = state.get("current_query", "")
    if STYLE_PATTERNS.search(query):
        return "resolve_synth_intent"
    return "run_gemini_tools"


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

def _build_agent_graph():
    """Build and compile the LangGraph agent pipeline (called once)."""
    graph = StateGraph(AgentState)

    graph.add_node("add_user_turn", add_user_turn)
    graph.add_node("resolve_synth_intent", resolve_synth_intent)
    graph.add_node("run_gemini_tools", run_gemini_tools)

    graph.set_entry_point("add_user_turn")

    graph.add_conditional_edges(
        "add_user_turn",
        should_resolve_intent,
        {
            "resolve_synth_intent": "resolve_synth_intent",
            "run_gemini_tools": "run_gemini_tools",
        },
    )
    graph.add_edge("resolve_synth_intent", "run_gemini_tools")
    graph.add_edge("run_gemini_tools", END)

    return graph.compile()


_COMPILED_GRAPH = _build_agent_graph()


# ---------------------------------------------------------------------------
# High-level runner
# ---------------------------------------------------------------------------

async def run_agent_graph(
    client: MCPClient,
    query: str,
    history: Optional[Sequence[dict[str, str]]] = None,
) -> str:
    """Run a single user turn through the LangGraph pipeline.

    Args:
        client: An already-connected MCPClient.
        query: The current user message.
        history: Prior conversation turns (list of ``{role, content}`` dicts).

    Returns:
        The agent's text reply.
    """
    initial_state: AgentState = {
        "messages": list(history) if history else [],
        "current_query": query,
        "resolved_intent": None,
        "reply": "",
        "mcp_client": client,
    }

    result = await _COMPILED_GRAPH.ainvoke(initial_state)
    return result.get("reply", "No response generated.")
