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
import uuid
from typing import Any, Dict, Optional, Sequence, TypedDict

from langgraph.graph import END, StateGraph

from .mcp_client_new import MCPClient
from .project_config_intent import parse_update_project_config_args


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
    generated_music: Optional[Dict[str, Any]]
    mcp_client: Any
    daw_context: Optional[Dict[str, Any]]
    stream_callback: Optional[Any]
    project_config_precall: Optional[str]
    melody_intent: Optional[bool]
    melody_subagent_result: Optional[str]


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------

STYLE_PATTERNS = re.compile(
    r"\b(sounds?\s+like|style\s+of|genre|vibe|inspired\s+by|like\s+(?:a|an)\s+(?:classic|vintage)\s+\w+)\b",
    re.IGNORECASE,
)

AUDIO_SHAPING_PATTERNS = re.compile(
    r"\b("
    r"bass(?:y|ier|ey)|more\s+bass|boost\s+the\s+low|thicker\s+low|sub\s+bass|"
    r"bright(?:er|en)?|sparklier|treble|"
    r"dark(?:er)?|warm(?:er|th)|muddy|fatter|thinner|harsh(?:er)?|smoother|"
    r"wider|narrower|stereo(?:ize)?|open it up|"
    r"punch(?:ier|y)?|tighter|snappier|louder|quieter|"
    r"(?:more|less|add|remove|reduce)\s+(?:reverb|delay|distortion|drive|compression|chorus|flanger|phaser|saturation|space|air)"
    r")\b",
    re.IGNORECASE,
)

MELODY_PATTERNS = re.compile(
    r"\b("
    r"melody|melodies|bass[\s-]?line|riff|lead line|"
    r"chord progression|chord changes|"
    r"write (?:some )?(?:notes|notes for|a part|a line|a hook)|"
    r"generate (?:a |some )?(?:melody|notes|midi|bassline|chords?)|"
    r"midi (?:part|pattern|sequence)|abc notation"
    r")\b",
    re.IGNORECASE,
)

AUDIO_INTENT_PATTERNS = re.compile(
    r"\b("
    r"elevenlabs|audio sample|audio loop|audio clip|vocal(?:s)?|sung|lyrics|"
    r"render(?:ed)? audio|beat(?:s)? bed|lo-?fi bed|jingle|wav|mp3"
    r")\b",
    re.IGNORECASE,
)


MELODY_SUBAGENT_SYSTEM = (
    "# Role\n"
    "You are the Nexus Melody/MIDI subagent. Your single job is to generate and insert a "
    "musically strong MIDI part expressed as ABC notation.\n\n"

    "# Musicianship principles\n"
    "- Do not default to plain C major or stepwise eighth notes. Choose a mode/scale that "
    "matches the requested genre: Dorian/Mixolydian for funk, altered/bebop scales for jazz, "
    "minor pentatonic/blues for rock, Phrygian/harmonic minor for darker textures.\n"
    "- Use syncopation, rests, and rhythmic variation. Mix durations (e.g. dotted eighths, "
    "sixteenth pickups, tied notes). Avoid four-on-the-floor quarter-note filler unless the "
    "user explicitly asks for it.\n"
    "- For basslines: outline the chord roots on strong beats, then add passing tones, "
    "octave jumps, and ghost notes. Think Jamerson/Flea, not root-only quarter notes.\n"
    "- For melodies: define a clear motif in the first 2 bars and develop it (sequence, "
    "inversion, rhythmic displacement) across the remaining bars.\n"
    "- For chord progressions: prefer functional harmony with at least one non-tonic "
    "resolution (ii-V-I, I-vi-IV-V, or modal equivalents).\n\n"

    "# Output contract\n"
    "- Write valid ABC with each header field on its own line (X:, T:, M:, L:, Q:, K:, then "
    "the tune body).\n"
    "- Keep the piece to 4-16 bars unless the user asks for more.\n"
    "- Then call the ABC-notation track-insertion tool exactly once with that ABC and the "
    "appropriate instrument/voice so the notes land in the project.\n"
    "- After the tool returns, reply with ONE short sentence describing what you wrote "
    "(genre, mode, bar count). Do not include raw ABC or tool names in your reply.\n\n"

    "# Context\n"
    "{context_block}\n"
)


_MISSING_CONTEXT_BLOCK = (
    "No DAW context was provided by the frontend. Before writing any ABC, "
    "call the project-summary tool to fetch the current tempo and, if available, "
    "existing instruments/key. If that still does not give you a key, pick one "
    "that matches the user's stated genre or mood, and explain the choice in your "
    "one-sentence reply. Never skip the inspection step when context is missing."
)


def _build_melody_context_block(daw_context: Optional[Dict[str, Any]]) -> str:
    """Build the Context block for the melody subagent system prompt.

    If DAW context is missing, instructs the subagent to fetch it via the
    project-summary tool before generating any notes. Otherwise, surfaces
    tempo/meter/instruments so the generated ABC lines up.
    """
    if not daw_context:
        return _MISSING_CONTEXT_BLOCK
    parts = []
    if daw_context.get("tempoBpm"):
        parts.append(f"Tempo: {daw_context['tempoBpm']} BPM")
    if daw_context.get("timeSignature"):
        parts.append(f"Meter: {daw_context['timeSignature']}")
    if daw_context.get("instruments"):
        parts.append(f"Existing instruments: {', '.join(daw_context['instruments'])}")
    if not parts:
        return _MISSING_CONTEXT_BLOCK
    return (
        "You are writing MIDI for a project with the following settings: "
        + "; ".join(parts) + ". "
        "Your ABC notation MUST align with this tempo and meter. If the user has not "
        "specified a key, pick one that complements the existing instruments."
    )


MELODY_TOOL_ALLOWLIST = {"add-abc-track", "export-tracks-abc", "get-project-summary"}


async def add_user_turn(state: AgentState) -> dict:
    """Append the latest user message to the conversation."""
    msgs = list(state.get("messages") or [])
    msgs.append({"role": "user", "content": state["current_query"]})
    return {"messages": msgs, "resolved_intent": None}


async def apply_project_config_precall(state: AgentState) -> dict:
    """If the user message requests tempo/signature changes, call MCP directly."""
    query = state.get("current_query", "")
    args = parse_update_project_config_args(query)
    if not args:
        return {}

    client: MCPClient = state["mcp_client"]
    stream_callback = state.get("stream_callback")

    trace_id = str(uuid.uuid4())
    tool_name = "update-project-config"
    if stream_callback:
        await stream_callback({
            "type": "trace",
            "data": {
                "id": trace_id,
                "label": tool_name,
                "detail": str(args),
                "status": "running",
            },
        })

    if client.session is None:
        msg = "MCP session not connected."
        if stream_callback:
            await stream_callback({
                "type": "trace_update",
                "data": {"id": trace_id, "status": "error", "detail": msg},
            })
        return {"project_config_precall": f"Failed: {msg}"}

    try:
        result = await client.session.call_tool(tool_name, args)
        text = MCPClient._extract_tool_result(result)
        if getattr(result, "isError", False):
            if stream_callback:
                await stream_callback({
                    "type": "trace_update",
                    "data": {"id": trace_id, "status": "error", "detail": text},
                })
            return {"project_config_precall": f"Failed: {text}"}
        if stream_callback:
            await stream_callback({
                "type": "trace_update",
                "data": {"id": trace_id, "status": "done", "detail": "Completed"},
            })
        return {"project_config_precall": f"Success: {text}"}
    except Exception as exc:
        err = str(exc)
        if stream_callback:
            await stream_callback({
                "type": "trace_update",
                "data": {"id": trace_id, "status": "error", "detail": err},
            })
        return {"project_config_precall": f"Failed: {err}"}


async def generate_midi_melody(state: AgentState) -> dict:
    """Scoped subagent that writes musically-opinionated ABC and inserts it.

    Runs a fresh LLM tool-calling loop with a music-theory-focused system prompt
    and a restricted tool allowlist (ABC insertion + project inspection only).
    The resulting summary is stored in ``melody_subagent_result`` so the main
    agent can compose the user-facing reply on hand-back.
    """
    client: MCPClient = state["mcp_client"]
    daw_context = state.get("daw_context")
    stream_callback = state.get("stream_callback")
    query = state.get("current_query", "")

    system_prompt = MELODY_SUBAGENT_SYSTEM.format(
        context_block=_build_melody_context_block(daw_context)
    )

    try:
        summary = await client.run_scoped_tool_loop(
            user_message=query,
            system_instruction=system_prompt,
            tool_allowlist=MELODY_TOOL_ALLOWLIST,
            stream_callback=stream_callback,
        )
        return {
            "melody_intent": True,
            "melody_subagent_result": f"Success: {summary}",
        }
    except Exception as exc:
        print(f"[graph] generate_midi_melody failed: {exc}")
        return {
            "melody_intent": True,
            "melody_subagent_result": f"Failed: {exc}",
        }


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


async def run_llm_tools(state: AgentState) -> dict:
    """Run the LLM (Gemini or Anthropic) + MCP tool-calling loop with full conversation context."""
    client: MCPClient = state["mcp_client"]
    messages = list(state.get("messages") or [])
    resolved_intent = state.get("resolved_intent")
    daw_context = state.get("daw_context")
    stream_callback = state.get("stream_callback")
    project_config_precall = state.get("project_config_precall")
    melody_subagent_result = state.get("melody_subagent_result")

    # Pass a copy so the LLM loop does not share the same list we append to below
    # (avoids mutating call_args captured by mocks in tests).
    reply, generated_music = await client.run_llm_tool_loop(
        list(messages),
        resolved_intent_hint=resolved_intent,
        daw_context=daw_context,
        stream_callback=stream_callback,
        project_config_precall=project_config_precall,
        melody_subagent_result=melody_subagent_result,
    )
    messages.append({"role": "model", "content": reply})
    return {"messages": messages, "reply": reply, "generated_music": generated_music}


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------

def should_resolve_intent(state: AgentState) -> str:
    """Decide whether to route through the intent-resolution node.

    Retained for backwards compatibility with tests that call it directly.
    The compiled graph now uses :func:`route_after_precall`.
    """
    query = state.get("current_query", "")
    if AUDIO_SHAPING_PATTERNS.search(query):
        return "run_llm_tools"
    if STYLE_PATTERNS.search(query):
        return "resolve_synth_intent"
    return "run_llm_tools"


def route_after_precall(state: AgentState) -> str:
    """Router after the deterministic config precall.

    Precedence:
    1. Explicit audio-generation intent (ElevenLabs, vocals, audio sample) wins,
       even if the prompt also mentions melody words. This keeps user-facing
       phrases like "generate a bassline with ElevenLabs" on the audio path.
    2. Audio-shaping verbs ("more bassy", "warmer", "wider") short-circuit to
       the main tool loop so the ``07_audio_macros`` skill handles them
       (presets / EQ / stompbox on existing channels) instead of the synth
       recommender adding a new device.
    3. Melody/MIDI intent routes to the ``generate_midi_melody`` subagent.
    4. Style/vibe intent routes to the existing synth recommender.
    5. Otherwise fall through to the main tool-calling loop.
    """
    query = state.get("current_query", "")
    if AUDIO_INTENT_PATTERNS.search(query):
        if STYLE_PATTERNS.search(query):
            return "resolve_synth_intent"
        return "run_llm_tools"
    if AUDIO_SHAPING_PATTERNS.search(query):
        return "run_llm_tools"
    if MELODY_PATTERNS.search(query):
        return "generate_midi_melody"
    if STYLE_PATTERNS.search(query):
        return "resolve_synth_intent"
    return "run_llm_tools"


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

def _build_agent_graph():
    """Build and compile the LangGraph agent pipeline (called once)."""
    graph = StateGraph(AgentState)

    graph.add_node("add_user_turn", add_user_turn)
    graph.add_node("apply_project_config_precall", apply_project_config_precall)
    graph.add_node("generate_midi_melody", generate_midi_melody)
    graph.add_node("resolve_synth_intent", resolve_synth_intent)
    graph.add_node("run_llm_tools", run_llm_tools)

    graph.set_entry_point("add_user_turn")
    graph.add_edge("add_user_turn", "apply_project_config_precall")

    graph.add_conditional_edges(
        "apply_project_config_precall",
        route_after_precall,
        {
            "generate_midi_melody": "generate_midi_melody",
            "resolve_synth_intent": "resolve_synth_intent",
            "run_llm_tools": "run_llm_tools",
        },
    )
    graph.add_edge("generate_midi_melody", "run_llm_tools")
    graph.add_edge("resolve_synth_intent", "run_llm_tools")
    graph.add_edge("run_llm_tools", END)

    return graph.compile()


_COMPILED_GRAPH = _build_agent_graph()


# ---------------------------------------------------------------------------
# High-level runner
# ---------------------------------------------------------------------------

async def run_agent_graph(
    client: MCPClient,
    query: str,
    history: Optional[Sequence[dict[str, str]]] = None,
    daw_context: Optional[Dict[str, Any]] = None,
    stream_callback: Optional[Any] = None,
) -> tuple[str, Optional[Dict[str, Any]]]:
    """Run a single user turn through the LangGraph pipeline.

    Args:
        client: An already-connected MCPClient.
        query: The current user message.
        history: Prior conversation turns (list of ``{role, content}`` dicts).
        daw_context: Optional dict with DAW project settings (tempoBpm, timeSignature).
        stream_callback: Optional callback for streaming trace events.

    Returns:
        ``(reply_text, generated_music_dict_or_none)`` — the latter is set when
        the ElevenLabs agent tool produced audio in this turn.
    """
    initial_state: AgentState = {
        "messages": list(history) if history else [],
        "current_query": query,
        "resolved_intent": None,
        "project_config_precall": None,
        "melody_intent": None,
        "melody_subagent_result": None,
        "reply": "",
        "generated_music": None,
        "mcp_client": client,
        "daw_context": daw_context,
        "stream_callback": stream_callback,
    }

    result = await _COMPILED_GRAPH.ainvoke(initial_state)
    return (
        result.get("reply", "No response generated."),
        result.get("generated_music"),
    )
