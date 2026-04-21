import asyncio
import json
from typing import Any, Dict, Optional, List, Literal, Tuple, Callable
from contextlib import AsyncExitStack

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
try:
    from mcp.client.streamable_http import streamablehttp_client
except Exception:
    streamablehttp_client = None

from google import genai
from google.genai import types
from anthropic import AsyncAnthropic
from openai import AsyncOpenAI
from dotenv import load_dotenv
import os

from .schema_converter import (
    convert_mcp_schema_to_gemini,
    convert_mcp_schema_to_anthropic,
    convert_mcp_schema_to_openai,
)
from services.music_generation import format_elevenlabs_exception, generate_music_base64

load_dotenv()

_EXCLUDED_TOOLS = {"initialize-session", "open-document"}

GENERATE_MUSIC_TOOL_NAME = "generate-music-elevenlabs"
GENERATE_MUSIC_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "prompt": {
            "type": "string",
            "description": "Description of the music to generate (genre, mood, instruments, tempo, length feel).",
        },
        "music_length_ms": {
            "type": "integer",
            "description": "Length in milliseconds (3000–600000). Default 15000.",
        },
        "force_instrumental": {
            "type": "boolean",
            "description": (
                "If true (default), output is instrumental only—user lyrics are not sung. "
                "Set to false when the user wants vocals or specific lyrics performed in the audio."
            ),
        },
    },
    "required": ["prompt"],
}


def _normalize_music_prompt(raw: Any) -> str:
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw.strip()
    if isinstance(raw, (list, tuple)):
        return " ".join(str(x) for x in raw).strip()
    return str(raw).strip()


def _normalize_music_length_ms(raw: Any) -> int:
    if raw is None:
        return 15000
    if isinstance(raw, bool):
        return 15000
    try:
        if isinstance(raw, str):
            s = raw.strip()
            if not s:
                return 15000
            n = float(s)
        else:
            n = float(raw)
        length = int(round(n))
    except (TypeError, ValueError):
        return 15000
    return max(3000, min(600_000, length))


def load_system_instruction() -> str:
    base_instruction = (
        "# Role\n"
        "You are Nexus, an Audiotool music-production assistant. You help users build and "
        "edit their projects by calling the available production tools.\n\n"

        "# Private vs user-facing language\n"
        "- NEVER mention the internal names or identifiers of your tools in replies to the user "
        "(e.g. do not say 'I used update-entity-values', 'via get-project-summary', etc.).\n"
        "- Describe what you did in natural musical language: 'I updated the synth parameters', "
        "'I added a wide pad', 'I inspected the current project to find the tempo'.\n"
        "- Do not expose JSON, schema names, or entity UUIDs unless the user explicitly asks.\n\n"

        "# Entity tracking\n"
        "When a tool returns an entity id, remember it internally. When the user refers to an "
        "entity by name or says 'it', re-use the most recent relevant id when you next modify "
        "that entity. Never paste raw ids into the user-facing reply.\n\n"

        "# Melody / MIDI vs audio generation (IMPORTANT)\n"
        "- When the user asks you to 'generate a melody', 'write a bassline', 'write a riff', "
        "'create notes', 'make a chord progression', or otherwise asks for played notes on a "
        "synthesizer or instrument, default to the ABC notation / MIDI track tool. Produce valid "
        "ABC and insert it as a note track.\n"
        "- Before generating a melody/bassline/chord progression yourself via the ABC "
        "notation tool (i.e. when the melody subagent was not invoked), you MUST "
        "first call the project-inspection tool to fetch the current tempo and, if "
        "possible, the key/chord context. Use those values in the ABC so it lines "
        "up with the user's project. If the inspection fails, pick sensible defaults "
        "and briefly note them in your reply.\n"
        "- Only use the ElevenLabs audio-generation tool when the user explicitly asks for an "
        "audio sample, an audio loop, a bed/beat, vocals, or a rendered audio clip. Phrases like "
        "'make me a 15s lo-fi sample', 'render vocals', or 'generate audio of ...' belong here. "
        "When the user wants vocals or specific lyrics performed, pass force_instrumental=false.\n"
        "- If the user is ambiguous and the project already has instruments loaded, prefer ABC "
        "(it slots into their existing tracks).\n"
        "- Timeline placement for generated audio is done by the Nexus web app only when an "
        "Audiotool project is connected in the sidebar; do not claim the clip is already on "
        "their timeline unless that connection exists.\n\n"

        "# General behavior\n"
        "Call tools immediately when you have enough information. Do not ask for parameters the "
        "user has not mentioned unless genuinely ambiguous. When the user asks to change tempo "
        "or time signature, update the project configuration right away. "
        "Many synths and effects support presets; when the user asks for a tone "
        "change, consider browsing presets for the relevant device rather than "
        "guessing parameters.\n\n"

        "# Mastering / mixing safety\n"
        "Before rewiring for mastering, first inspect the project and identify every audible "
        "source (note-track players AND audio-track players, including audioDevice entities from "
        "imported samples). If you disconnect a source cable, reconnect that same source in the "
        "replacement chain immediately. Prefer targeted value/connection updates over bulk removal "
        "when replacing a working effect chain.\n\n"

        "# ABC notation formatting\n"
        "When you provide ABC, each information field goes on its own line (X:, T:, M:, K:, L:, "
        "then the tune body). Never put the full header on one line - that breaks parsing.\n\n"

        "# Response style\n"
        "Use markdown when it genuinely helps readability: bold for key parameter "
        "names, short bullet lists for multi-step actions, inline code for entity "
        "names or parameter keys. Do not wrap your whole reply in a code block, "
        "do not use level-1 or level-2 headings, and do not use emojis. Keep "
        "replies concise and conversational - a couple of sentences plus a short "
        "result summary is usually enough.\n\n"

        "# Routing marker (internal)\n"
        "If the user's request is clearly about generating played notes (melody/bassline/riff/"
        "chord progression) but you have not been routed to the melody subagent, silently "
        "proceed with the ABC notation tool yourself. Do not mention this marker to the user.\n\n"
    )
    
    skills_dir = os.path.join(os.path.dirname(__file__), "skills")
    skills_content = ""
    if os.path.isdir(skills_dir):
        for filename in sorted(os.listdir(skills_dir)):
            if filename.endswith(".md"):
                filepath = os.path.join(skills_dir, filename)
                try:
                    with open(filepath, "r", encoding="utf-8") as f:
                        skills_content += f"--- {filename} ---\n{f.read().strip()}\n\n"
                except Exception as e:
                    print(f"[MCP Client] Error loading skill {filename}: {e}")
                    
    return base_instruction + "SKILLS AND KNOWLEDGE:\n" + skills_content if skills_content else base_instruction

SYSTEM_INSTRUCTION = load_system_instruction()


_PROVIDER_LABELS = {"gemini": "Gemini", "anthropic": "Anthropic", "openai": "OpenAI"}
_ENV_KEYS = {"gemini": "GEMINI_API_KEY", "anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY"}


def _resolve_llm_api_key(
    provider: Literal["gemini", "anthropic", "openai"], api_key: Optional[str]
) -> str:
    if api_key and api_key.strip():
        return api_key.strip()
    key = os.getenv(_ENV_KEYS[provider])
    if key:
        return key
    label = _PROVIDER_LABELS[provider]
    raise ValueError(
        f"No {label} API key found. Please open Settings and enter your "
        f"Gemini, OpenAI, or Anthropic API key under \"LLM API Key\"."
    )


class MCPClient:
    def __init__(
        self,
        llm_provider: Literal["gemini", "anthropic", "openai"] = "gemini",
        llm_api_key: Optional[str] = None,
    ):
        self.session: Optional[ClientSession] = None
        self.exit_stack = AsyncExitStack()
        self._cached_tools: Optional[list] = None
        self._cached_anthropic_tools: Optional[list] = None
        self._cached_openai_tools: Optional[list] = None
        self._llm_provider = llm_provider
        self._llm_api_key = _resolve_llm_api_key(llm_provider, llm_api_key)

        if llm_provider == "gemini":
            self._gemini_client = genai.Client(api_key=self._llm_api_key)
            self._gemini_model = "gemini-2.5-flash"
            self._anthropic_client = None
            self._anthropic_model = None
            self._openai_client = None
            self._openai_model = None
        elif llm_provider == "anthropic":
            self._gemini_client = None
            self._gemini_model = None
            self._anthropic_client = AsyncAnthropic(api_key=self._llm_api_key)
            self._anthropic_model = "claude-sonnet-4-20250514"
            self._openai_client = None
            self._openai_model = None
        else:
            self._gemini_client = None
            self._gemini_model = None
            self._anthropic_client = None
            self._anthropic_model = None
            self._openai_client = AsyncOpenAI(api_key=self._llm_api_key)
            self._openai_model = "gpt-4o"

        self._elevenlabs_api_key: Optional[str] = None

    def set_elevenlabs_api_key(self, key: Optional[str]) -> None:
        """Per-request key from the client; falls back to ELEVENLABS_API_KEY in the tool."""
        self._elevenlabs_api_key = key.strip() if key and key.strip() else None

    async def _dispatch_tool(
        self, tool_name: str, tool_args: dict
    ) -> Tuple[str, Optional[Dict[str, Any]]]:
        """Call MCP or a built-in tool. Returns (text_for_model, optional generated_music dict)."""
        if tool_name == GENERATE_MUSIC_TOOL_NAME:
            return await self._execute_generate_music(tool_args)
        if self.session is None:
            raise RuntimeError("Not connected – call connect_to_server() first")
        result = await self.session.call_tool(tool_name, tool_args)
        result_text = self._extract_tool_result(result)
        if getattr(result, "isError", False):
            raise RuntimeError(result_text)
        return result_text, None

    async def _execute_generate_music(
        self, tool_args: dict
    ) -> Tuple[str, Optional[Dict[str, Any]]]:
        prompt = _normalize_music_prompt(tool_args.get("prompt"))
        if not prompt:
            return "Error: prompt is required for music generation.", None

        length = _normalize_music_length_ms(tool_args.get("music_length_ms"))

        raw_inst = tool_args.get("force_instrumental")
        if raw_inst is None:
            instrumental = True
        elif isinstance(raw_inst, str):
            instrumental = raw_inst.lower() in ("true", "1", "yes")
        else:
            instrumental = bool(raw_inst)

        try:
            b64, fmt, echo, ms = await generate_music_base64(
                prompt=prompt,
                music_length_ms=length,
                force_instrumental=instrumental,
                api_key=self._elevenlabs_api_key,
            )
        except Exception as e:
            return (
                f"ElevenLabs music generation failed: {format_elevenlabs_exception(e)}",
                None,
            )
        print(
            "[MCP Client] generate-music-elevenlabs payload stats: "
            f"base64_chars={len(b64)} approx_decoded_bytes={(len(b64) * 3) // 4} "
            f"music_length_ms={ms} format={fmt}"
        )

        inst_note = (
            " Instrumental-only (force_instrumental true): lyrics in the prompt are not sung; "
            "use force_instrumental false if the user wanted vocals."
            if instrumental
            else ""
        )
        summary = (
            f"Success: generated about {length // 1000}s of "
            f"{'instrumental ' if instrumental else ''}audio ({fmt}).{inst_note} "
            "The Nexus web app receives the audio and shows a preview player. "
            "The clip is added to the Audiotool project timeline only when this Nexus session has a "
            "connected Audiotool project (sidebar); otherwise the user must connect a project first or import manually. "
            "Tell the user to check the preview and the sidebar connection status—do not claim the clip is already "
            "on their Audiotool timeline unless you know their project was connected here."
        )
        return summary, {
            "audio_base64": b64,
            "format": fmt,
            "prompt": echo,
            "music_length_ms": ms,
        }

    async def connect_to_server(self, server_script_path: str):
        """Connect to an MCP server

        Args:
            server_script_path: Path to the server script (.py, .js, or .ts), or HTTP(S) MCP URL
        """
        if server_script_path.startswith(("http://", "https://")):
            if streamablehttp_client is None:
                raise RuntimeError(
                    "Remote MCP transport requested but mcp.client.streamable_http is unavailable."
                )

            http_transport = await self.exit_stack.enter_async_context(
                streamablehttp_client(server_script_path)
            )
            self.stdio, self.write = http_transport[0], http_transport[1]
            self.session = await self.exit_stack.enter_async_context(ClientSession(self.stdio, self.write))
            await self.session.initialize()

            response = await self.session.list_tools()
            tools = response.tools
            print("\nConnected to remote MCP server with tools:", [tool.name for tool in tools])
            return

        is_python = server_script_path.endswith('.py')
        is_js = server_script_path.endswith('.js') or server_script_path.endswith('.ts')
        if not (is_python or is_js):
            raise ValueError("Server target must be an HTTP(S) URL or a .py/.js/.ts file")

        command = "python" if is_python else "node"
        server_params = StdioServerParameters(
            command=command,
            args=[server_script_path],
            env=None
        )

        stdio_transport = await self.exit_stack.enter_async_context(stdio_client(server_params))
        self.stdio, self.write = stdio_transport
        self.session = await self.exit_stack.enter_async_context(ClientSession(self.stdio, self.write))

        await self.session.initialize()

        # List available tools
        response = await self.session.list_tools()
        tools = response.tools
        print("\nConnected to server with tools:", [tool.name for tool in tools])

    async def initialize_session(
        self,
        access_token: str,
        expires_at: int,
        client_id: str,
        project_url: str,
        refresh_token: str,
    ) -> str:
        """Initialize authenticated session with auth tokens and project URL"""
        print("[MCP Client] Initializing session...")
        tool_args = {
            "accessToken": access_token,
            "expiresAt": expires_at,
            "clientId": client_id,
            "projectUrl": project_url,
            "refreshToken": refresh_token,
        }

        print(f"[MCP Client] Calling initialize-session tool with project: {project_url}")

        if self.session is None:
            raise RuntimeError("Not connected – call connect_to_server() first")

        try:
            result = await asyncio.wait_for(
                self.session.call_tool("initialize-session", tool_args),
                timeout=30.0  # 30 second timeout
            )
            if getattr(result, "isError", False):
                msg = self._extract_tool_result(result)
                print(f"[MCP Client] ERROR initializing session: {msg}")
                raise Exception(msg)
            print("[MCP Client] Session initialized successfully!")
            return self._extract_tool_result(result)
        except asyncio.TimeoutError:
            error_msg = "Session initialization timed out after 30 seconds. Check MCP server logs for details."
            print(f"[MCP Client] ERROR: {error_msg}")
            raise Exception(error_msg)
        except Exception as e:
            print(f"[MCP Client] ERROR initializing session: {str(e)}")
            raise

    # ------------------------------------------------------------------
    # Core tool-calling loop (reusable by LangGraph nodes or standalone)
    # ------------------------------------------------------------------
    async def _get_gemini_tools(self):
        """Fetch MCP tools and convert to Gemini FunctionDeclarations.

        The result is cached after the first call because the tool list
        does not change for the lifetime of the MCP session.
        """
        if self._cached_tools is not None:
            return self._cached_tools

        if self.session is None:
            raise RuntimeError("Not connected – call connect_to_server() first")

        mcp_tools_response = await self.session.list_tools()
        function_declarations = []
        for tool in mcp_tools_response.tools:
            if tool.name in _EXCLUDED_TOOLS:
                continue
            cleaned_schema = convert_mcp_schema_to_gemini(
                dict(tool.inputSchema) if tool.inputSchema else {}
            )
            func_decl = types.FunctionDeclaration(
                name=tool.name,
                description=tool.description or "",
                parameters=cleaned_schema,
            )
            function_declarations.append(func_decl)

        gm_music_schema = convert_mcp_schema_to_gemini(GENERATE_MUSIC_SCHEMA)
        function_declarations.append(
            types.FunctionDeclaration(
                name=GENERATE_MUSIC_TOOL_NAME,
                description=(
                    "Generate original music audio from a text prompt using ElevenLabs. "
                    "Use when the user asks for AI-generated music, beds, beats, or jingles—not for ABC notation "
                    "(use add-abc-track for ABC). "
                    "Use force_instrumental=false for sung vocals or user-specified lyrics. "
                    "Nexus adds the clip to the Audiotool timeline only when a project is connected in the sidebar."
                ),
                parameters=gm_music_schema,
            )
        )

        self._cached_tools = [types.Tool(function_declarations=function_declarations)]
        return self._cached_tools

    async def _get_anthropic_tools(self) -> list:
        """Fetch MCP tools and convert to Anthropic tool definitions (list of dicts)."""
        if self._cached_anthropic_tools is not None:
            return self._cached_anthropic_tools

        if self.session is None:
            raise RuntimeError("Not connected – call connect_to_server() first")

        mcp_tools_response = await self.session.list_tools()
        tools = []
        for tool in mcp_tools_response.tools:
            if tool.name in _EXCLUDED_TOOLS:
                continue
            cleaned_schema = convert_mcp_schema_to_anthropic(
                dict(tool.inputSchema) if tool.inputSchema else {}
            )
            tools.append({
                "name": tool.name,
                "description": tool.description or "",
                "input_schema": cleaned_schema,
            })
        tools.append({
            "name": GENERATE_MUSIC_TOOL_NAME,
            "description": (
                "Generate original music audio from a text prompt (ElevenLabs). "
                "For AI-generated music requests—not ABC notation (add-abc-track). "
                "force_instrumental=false for vocals/lyrics; timeline import requires a connected Audiotool project in Nexus."
            ),
            "input_schema": convert_mcp_schema_to_anthropic(GENERATE_MUSIC_SCHEMA),
        })
        self._cached_anthropic_tools = tools
        return self._cached_anthropic_tools

    async def _get_openai_tools(self) -> list:
        """Fetch MCP tools and convert to OpenAI function-calling tools (list of dicts)."""
        if self._cached_openai_tools is not None:
            return self._cached_openai_tools

        if self.session is None:
            raise RuntimeError("Not connected – call connect_to_server() first")

        mcp_tools_response = await self.session.list_tools()
        tools = []
        for tool in mcp_tools_response.tools:
            if tool.name in _EXCLUDED_TOOLS:
                continue
            cleaned_schema = convert_mcp_schema_to_openai(
                dict(tool.inputSchema) if tool.inputSchema else {}
            )
            tools.append({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description or "",
                    "parameters": cleaned_schema,
                },
            })
        tools.append({
            "type": "function",
            "function": {
                "name": GENERATE_MUSIC_TOOL_NAME,
                "description": (
                    "Generate original music audio from a text prompt (ElevenLabs). "
                    "Not for ABC notation. force_instrumental=false for vocals/lyrics; "
                    "timeline import needs a connected Audiotool project in Nexus."
                ),
                "parameters": convert_mcp_schema_to_openai(GENERATE_MUSIC_SCHEMA),
            },
        })
        self._cached_openai_tools = tools
        return self._cached_openai_tools

    @staticmethod
    def _extract_tool_result(result) -> str:
        """Extract plain text from an MCP CallToolResult."""
        if hasattr(result, "content") and result.content:
            parts = [b.text for b in result.content if hasattr(b, "text") and b.text]
            return "\n".join(parts) if parts else str(result.content)
        return str(result)

    async def run_tool_loop(
        self,
        contents: list,
        config: types.GenerateContentConfig,
        max_iterations: int = 25,
        stream_callback: Optional[Any] = None,
    ) -> tuple[list, str, Optional[Dict[str, Any]]]:
        """Run the Gemini <-> MCP tool-calling loop.

        Returns (updated_contents, final_text_reply, optional generated_music dict).
        """
        response = await self._gemini_client.aio.models.generate_content(
            model=self._gemini_model,
            contents=contents,
            config=config,
        )

        final_text: list[str] = []
        last_tool_result: Optional[str] = None
        music_attachment: Optional[Dict[str, Any]] = None
        consecutive_failures = 0
        _MAX_CONSECUTIVE_FAILURES = 3

        for _ in range(max_iterations):
            has_function_call = False
            abort = False

            if response.candidates and response.candidates[0].content and response.candidates[0].content.parts:
                candidate = response.candidates[0]

                function_call_parts = [
                    p for p in candidate.content.parts
                    if hasattr(p, "function_call") and p.function_call
                ]

                if function_call_parts:
                    has_function_call = True
                    fn_response_parts: list = []

                    for part in function_call_parts:
                        fc = part.function_call
                        tool_name = fc.name
                        tool_args = dict(fc.args) if fc.args else {}

                        print(f"[MCP Client] Calling tool: {tool_name} with args: {tool_args}")
                        trace_id = None
                        if stream_callback:
                            import uuid
                            trace_id = str(uuid.uuid4())
                            await stream_callback({"type": "trace", "data": {"id": trace_id, "label": f"{tool_name}", "detail": str(tool_args), "status": "running"}})

                        try:
                            result_str, attach = await self._dispatch_tool(tool_name, tool_args)
                            if attach is not None:
                                music_attachment = attach
                            if stream_callback:
                                await stream_callback({"type": "trace_update", "data": {"id": trace_id, "status": "done", "detail": "Completed"}})
                            consecutive_failures = 0
                        except asyncio.CancelledError:
                            if stream_callback and trace_id:
                                await stream_callback({"type": "trace_update", "data": {"id": trace_id, "status": "error", "detail": "Cancelled"}})
                            raise
                        except Exception as e:
                            consecutive_failures += 1
                            result_str = f"Error calling tool {tool_name}: {str(e)}"
                            print(f"[MCP Client] Tool call FAILED: {result_str}")
                            if stream_callback:
                                await stream_callback({"type": "trace_update", "data": {"id": trace_id, "status": "error", "detail": str(e)}})
                        last_tool_result = result_str
                        print(f"[MCP Client] Tool result: {result_str[:200]}...")

                        fn_response_parts.append(
                            types.Part.from_function_response(
                                name=tool_name,
                                response={"result": result_str},
                            )
                        )

                        if consecutive_failures >= _MAX_CONSECUTIVE_FAILURES:
                            abort = True
                            break

                    if abort:
                        final_text = [f"Aborted: {_MAX_CONSECUTIVE_FAILURES} consecutive tool failures."]
                        break

                    contents.append(candidate.content)
                    contents.append(types.Content(parts=fn_response_parts, role="user"))

                    response = await self._gemini_client.aio.models.generate_content(
                        model=self._gemini_model,
                        contents=contents,
                        config=config,
                    )
                else:
                    for part in candidate.content.parts:
                        if hasattr(part, "text") and part.text:
                            final_text.append(part.text)

            if not has_function_call:
                break

        text = "\n".join(final_text) if final_text else ""
        if not text and last_tool_result:
            text = f"Operation completed. Result: {last_tool_result}"
        if not text:
            text = "No response generated."
        return contents, text, music_attachment

    async def run_tool_loop_anthropic(
        self,
        messages: list,
        system: str = SYSTEM_INSTRUCTION,
        max_iterations: int = 25,
        stream_callback: Optional[Any] = None,
        tools: Optional[list] = None,
    ) -> tuple[list, str, Optional[Dict[str, Any]]]:
        """Run the Anthropic Claude <-> MCP tool-calling loop.

        messages: list of {"role": "user"|"assistant", "content": ...} in API format.
        tools: optional explicit tool list (defaults to the full cached set).
        Returns (updated_messages, final_text_reply, optional generated_music dict).
        """
        if self._anthropic_client is None:
            raise RuntimeError("Anthropic client not configured or not connected")

        if tools is None:
            tools = await self._get_anthropic_tools()
        if not tools:
            raise RuntimeError("No tools available for Anthropic")

        final_text = ""
        music_attachment: Optional[Dict[str, Any]] = None
        consecutive_failures = 0
        _MAX_CONSECUTIVE_FAILURES = 3
        for _ in range(max_iterations):
            response = await self._anthropic_client.messages.create(
                model=self._anthropic_model,
                max_tokens=4096,
                system=system,
                tools=tools,
                messages=messages,
            )

            text_parts = []
            tool_use_blocks = []

            for block in response.content:
                if block.type == "text":
                    text_parts.append(block.text)
                elif block.type == "tool_use":
                    tool_use_blocks.append(block)

            if text_parts:
                final_text = "\n".join(text_parts)

            if not tool_use_blocks:
                break

            # Append assistant message (with tool_use blocks)
            assistant_content = [
                {"type": "tool_use", "id": b.id, "name": b.name, "input": b.input}
                for b in tool_use_blocks
            ]
            messages.append({"role": "assistant", "content": assistant_content})

            # Call MCP tools and build tool_result blocks
            tool_results = []
            abort = False
            for block in tool_use_blocks:
                tool_name = block.name
                tool_args = block.input if isinstance(block.input, dict) else {}
                print(f"[MCP Client] Calling tool: {tool_name} with args: {tool_args}")
                trace_id = None
                if stream_callback:
                    import uuid
                    trace_id = str(uuid.uuid4())
                    await stream_callback({"type": "trace", "data": {"id": trace_id, "label": f"{tool_name}", "detail": str(tool_args), "status": "running"}})

                try:
                    result_str, attach = await self._dispatch_tool(tool_name, tool_args)
                    if attach is not None:
                        music_attachment = attach
                    if stream_callback:
                        await stream_callback({"type": "trace_update", "data": {"id": trace_id, "status": "done", "detail": "Completed"}})
                    consecutive_failures = 0
                except asyncio.CancelledError:
                    if stream_callback and trace_id:
                        await stream_callback({"type": "trace_update", "data": {"id": trace_id, "status": "error", "detail": "Cancelled"}})
                    raise
                except Exception as e:
                    consecutive_failures += 1
                    result_str = f"Error calling tool {tool_name}: {str(e)}"
                    print(f"[MCP Client] Tool call FAILED: {result_str}")
                    if stream_callback:
                        await stream_callback({"type": "trace_update", "data": {"id": trace_id, "status": "error", "detail": str(e)}})
                print(f"[MCP Client] Tool result: {result_str[:200]}...")
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result_str,
                })

                if consecutive_failures >= _MAX_CONSECUTIVE_FAILURES:
                    abort = True
                    break

            messages.append({"role": "user", "content": tool_results})

            if abort:
                final_text = f"Aborted: {_MAX_CONSECUTIVE_FAILURES} consecutive tool failures."
                break

        if not final_text and messages and isinstance(messages[-1].get("content"), list):
            for c in messages[-1]["content"]:
                if isinstance(c, dict) and c.get("type") == "tool_result":
                    final_text = c.get("content", "")
                    break
        if not final_text:
            final_text = "No response generated."
        return messages, final_text, music_attachment

    async def run_tool_loop_openai(
        self,
        messages: list[dict],
        system: str = SYSTEM_INSTRUCTION,
        max_iterations: int = 25,
        stream_callback: Optional[Any] = None,
        tools: Optional[list] = None,
    ) -> tuple[list[dict], str, Optional[Dict[str, Any]]]:
        """Run the OpenAI chat completions <-> MCP tool-calling loop.

        messages: list of {"role": "user"|"assistant"|"system", "content": str} in API format.
        tools: optional explicit tool list (defaults to the full cached set).
        Returns (updated_messages, final_text_reply, optional generated_music dict).
        """
        if self._openai_client is None:
            raise RuntimeError("OpenAI client not configured or not connected")

        if tools is None:
            tools = await self._get_openai_tools()
        if not tools:
            raise RuntimeError("No tools available for OpenAI")

        # Build request messages with system first
        request_messages = [{"role": "system", "content": system}]
        request_messages.extend(messages)

        final_text = ""
        music_attachment: Optional[Dict[str, Any]] = None
        consecutive_failures = 0
        _MAX_CONSECUTIVE_FAILURES = 3
        for _ in range(max_iterations):
            response = await self._openai_client.chat.completions.create(
                model=self._openai_model,
                messages=request_messages,
                tools=tools,
                temperature=0.2,
            )
            choice = response.choices[0] if response.choices else None
            if not choice or not choice.message:
                break

            msg = choice.message
            if msg.content:
                final_text = (msg.content or "").strip()

            if not (getattr(msg, "tool_calls", None)):
                break

            # Append assistant message (with tool_calls)
            assistant_msg = {"role": "assistant", "content": msg.content or ""}
            assistant_msg["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                }
                for tc in msg.tool_calls
            ]
            request_messages.append(assistant_msg)

            # Call MCP tools and append tool result messages
            abort = False
            for tc in msg.tool_calls:
                tool_name = tc.function.name
                raw_args = tc.function.arguments or "{}"
                try:
                    tool_args = json.loads(raw_args)
                except json.JSONDecodeError as e:
                    print(
                        f"[MCP Client] JSON decode failed for {tool_name}: {e!s}; raw_args={raw_args!r}"
                    )
                    err_msg = (
                        "Error: could not parse tool arguments as JSON. "
                        f"Parser error: {e!s}. Return valid JSON object arguments for this tool."
                    )
                    request_messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": err_msg,
                    })
                    continue
                print(f"[MCP Client] Calling tool: {tool_name} with args: {tool_args}")
                trace_id = None
                if stream_callback:
                    import uuid
                    trace_id = str(uuid.uuid4())
                    await stream_callback({"type": "trace", "data": {"id": trace_id, "label": f"{tool_name}", "detail": str(tool_args), "status": "running"}})

                try:
                    result_str, attach = await self._dispatch_tool(tool_name, tool_args)
                    if attach is not None:
                        music_attachment = attach
                    if stream_callback:
                        await stream_callback({"type": "trace_update", "data": {"id": trace_id, "status": "done", "detail": "Completed"}})
                    consecutive_failures = 0
                except asyncio.CancelledError:
                    if stream_callback and trace_id:
                        await stream_callback({"type": "trace_update", "data": {"id": trace_id, "status": "error", "detail": "Cancelled"}})
                    raise
                except Exception as e:
                    consecutive_failures += 1
                    result_str = f"Error calling tool {tool_name}: {str(e)}"
                    print(f"[MCP Client] Tool call FAILED: {result_str}")
                    if stream_callback:
                        await stream_callback({"type": "trace_update", "data": {"id": trace_id, "status": "error", "detail": str(e)}})
                print(f"[MCP Client] Tool result: {result_str[:200]}...")
                request_messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result_str,
                })

                if consecutive_failures >= _MAX_CONSECUTIVE_FAILURES:
                    abort = True
                    break

            if abort:
                final_text = f"Aborted: {_MAX_CONSECUTIVE_FAILURES} consecutive tool failures."
                break

        if not final_text:
            final_text = "No response generated."
        return request_messages, final_text, music_attachment

    @staticmethod
    def _build_daw_context_hint(daw_context: Optional[Dict[str, Any]]) -> Optional[str]:
        """Format DAW context into a hint string for the LLM, or None if empty."""
        if not daw_context:
            return None
        parts = []
        if "tempoBpm" in daw_context:
            parts.append(f"Tempo: {daw_context['tempoBpm']} BPM")
        if "timeSignature" in daw_context:
            parts.append(f"Time signature: {daw_context['timeSignature']}")
        if daw_context.get("instruments"):
            parts.append(f"Instruments: {', '.join(daw_context['instruments'])}")
        if daw_context.get("trackCount") is not None:
            parts.append(f"Track count: {daw_context['trackCount']}")
        if not parts:
            return None
        return (
            "[DAW project context] The user's current project has the following settings: "
            + ", ".join(parts) + ". "
            "If the user asks to change the tempo or time signature, you MUST call the "
            "project-configuration tool with the new values. Do not claim the change was made "
            "without calling the tool. When the user wants something that fits their project, "
            "use the project-summary and ABC-export tools to gather deeper context (key, chord "
            "progression, note ranges) before generating. If the user just asks for a general "
            "sample without mentioning matching the project, ignore this context and use only "
            "their description."
        )

    async def run_llm_tool_loop(
        self,
        messages: list[dict],
        resolved_intent_hint: Optional[str] = None,
        daw_context: Optional[Dict[str, Any]] = None,
        stream_callback: Optional[Any] = None,
        project_config_precall: Optional[str] = None,
        melody_subagent_result: Optional[str] = None,
    ) -> tuple[str, Optional[Dict[str, Any]]]:
        """Provider-agnostic: run the appropriate LLM + MCP tool loop.

        messages: list of {"role": "user"|"model", "content": str} (conversation history).
        resolved_intent_hint: optional hint from recommend-entity-for-style to prepend.
        daw_context: optional dict with DAW project settings (tempoBpm, timeSignature).
        project_config_precall: optional result text from deterministic update-project-config precall.
        melody_subagent_result: optional result text from the melody/MIDI subagent node.

        Returns (reply_text, generated_music dict or None).
        """
        daw_hint = self._build_daw_context_hint(daw_context)

        precall_hint = None
        if project_config_precall:
            precall_hint = (
                "[System result] The project-configuration tool already ran: "
                f"{project_config_precall}. Answer the user based on this; "
                "do not claim changes that failed."
            )

        melody_hint = None
        if melody_subagent_result:
            melody_hint = (
                "[System result] The melody/MIDI subagent ran and reported: "
                f"{melody_subagent_result}. The notes are already inserted into the project. "
                "Compose a short natural reply to the user describing what was added "
                "(do not re-insert the track, and do not mention tool names)."
            )

        if self._llm_provider == "anthropic":
            # Convert to Anthropic format: "model" -> "assistant", content as list of text blocks
            api_messages = []
            for m in messages:
                role = "assistant" if m["role"] == "model" else "user"
                content = m["content"]
                api_messages.append({"role": role, "content": content})
            if precall_hint:
                api_messages.append({"role": "user", "content": precall_hint})
            if melody_hint:
                api_messages.append({"role": "user", "content": melody_hint})
            if resolved_intent_hint:
                api_messages.append({
                    "role": "user",
                    "content": (
                        f"[system hint] A style recommender suggested this entity type for the "
                        f"user's request: {resolved_intent_hint}. Only use it if you conclude a "
                        f"NEW device should be added. If the user is asking to change the "
                        f"character of existing sounds (more bass, brighter, wider, punchier, "
                        f"etc.), prefer the audio-shaping skill: apply a preset with "
                        f"list-presets/apply-preset, or insert/tweak a parametric EQ / stompbox "
                        f"on the relevant mixer channel instead."
                    ),
                })
            if daw_hint:
                api_messages.append({"role": "user", "content": daw_hint})
            _, reply, music = await self.run_tool_loop_anthropic(
                api_messages, system=SYSTEM_INSTRUCTION, stream_callback=stream_callback
            )
            return reply, music

        if self._llm_provider == "openai":
            # Convert to OpenAI format: "model" -> "assistant"
            api_messages = []
            for m in messages:
                role = "assistant" if m["role"] == "model" else "user"
                api_messages.append({"role": role, "content": m["content"]})
            if precall_hint:
                api_messages.append({"role": "user", "content": precall_hint})
            if melody_hint:
                api_messages.append({"role": "user", "content": melody_hint})
            if resolved_intent_hint:
                api_messages.append({
                    "role": "user",
                    "content": (
                        f"[system hint] A style recommender suggested this entity type for the "
                        f"user's request: {resolved_intent_hint}. Only use it if you conclude a "
                        f"NEW device should be added. If the user is asking to change the "
                        f"character of existing sounds (more bass, brighter, wider, punchier, "
                        f"etc.), prefer the audio-shaping skill: apply a preset with "
                        f"list-presets/apply-preset, or insert/tweak a parametric EQ / stompbox "
                        f"on the relevant mixer channel instead."
                    ),
                })
            if daw_hint:
                api_messages.append({"role": "user", "content": daw_hint})
            _, reply, music = await self.run_tool_loop_openai(
                api_messages, system=SYSTEM_INSTRUCTION, stream_callback=stream_callback
            )
            return reply, music

        # Gemini path
        tools = await self._get_gemini_tools()
        config = types.GenerateContentConfig(
            tools=tools,
            system_instruction=SYSTEM_INSTRUCTION,
        )
        contents = []
        for msg in messages:
            role = msg["role"] if msg["role"] in ("user", "model") else "user"
            contents.append(
                types.Content(parts=[types.Part.from_text(text=msg["content"])], role=role)
            )
        if precall_hint:
            contents.append(
                types.Content(
                    parts=[types.Part.from_text(text=precall_hint)],
                    role="user",
                )
            )
        if melody_hint:
            contents.append(
                types.Content(
                    parts=[types.Part.from_text(text=melody_hint)],
                    role="user",
                )
            )
        if resolved_intent_hint:
            contents.append(
                types.Content(
                    parts=[types.Part.from_text(
                        text=(
                            f"[system hint] A style recommender suggested this entity type for "
                            f"the user's request: {resolved_intent_hint}. Only use it if you "
                            f"conclude a NEW device should be added. If the user is asking to "
                            f"change the character of existing sounds (more bass, brighter, "
                            f"wider, punchier, etc.), prefer the audio-shaping skill: apply a "
                            f"preset with list-presets/apply-preset, or insert/tweak a "
                            f"parametric EQ / stompbox on the relevant mixer channel instead."
                        )
                    )],
                    role="user",
                )
            )
        if daw_hint:
            contents.append(
                types.Content(
                    parts=[types.Part.from_text(text=daw_hint)],
                    role="user",
                )
            )
        _, reply, music = await self.run_tool_loop(contents, config, stream_callback=stream_callback)
        return reply, music

    async def run_scoped_tool_loop(
        self,
        user_message: str,
        system_instruction: str,
        tool_allowlist: set,
        stream_callback: Optional[Any] = None,
    ) -> str:
        """Run a provider-agnostic one-shot tool-calling loop with a custom system
        prompt and a restricted tool set. Used by subagent nodes.

        The subagent runs with a fresh minimal context (only `user_message`);
        it does not see the full chat history.

        Returns the final text reply from the scoped loop.
        """
        if self._llm_provider == "anthropic":
            all_tools = await self._get_anthropic_tools()
            filtered = [t for t in all_tools if t.get("name") in tool_allowlist]
            if not filtered:
                raise RuntimeError(
                    f"No tools in allowlist {tool_allowlist} are available for Anthropic."
                )
            messages = [{"role": "user", "content": user_message}]
            _, reply, _ = await self.run_tool_loop_anthropic(
                messages,
                system=system_instruction,
                stream_callback=stream_callback,
                tools=filtered,
            )
            return reply

        if self._llm_provider == "openai":
            all_tools = await self._get_openai_tools()
            filtered = [
                t for t in all_tools
                if t.get("function", {}).get("name") in tool_allowlist
            ]
            if not filtered:
                raise RuntimeError(
                    f"No tools in allowlist {tool_allowlist} are available for OpenAI."
                )
            messages = [{"role": "user", "content": user_message}]
            _, reply, _ = await self.run_tool_loop_openai(
                messages,
                system=system_instruction,
                stream_callback=stream_callback,
                tools=filtered,
            )
            return reply

        # Gemini path
        all_tools_list = await self._get_gemini_tools()
        all_decls = []
        for tool in all_tools_list:
            decls = getattr(tool, "function_declarations", None) or []
            all_decls.extend(decls)
        filtered_decls = [fd for fd in all_decls if fd.name in tool_allowlist]
        if not filtered_decls:
            raise RuntimeError(
                f"No tools in allowlist {tool_allowlist} are available for Gemini."
            )
        filtered_tools = [types.Tool(function_declarations=filtered_decls)]
        config = types.GenerateContentConfig(
            tools=filtered_tools,
            system_instruction=system_instruction,
        )
        contents = [
            types.Content(
                parts=[types.Part.from_text(text=user_message)],
                role="user",
            )
        ]
        _, reply, _ = await self.run_tool_loop(
            contents, config, stream_callback=stream_callback
        )
        return reply

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    async def process_query(
        self,
        query: str,
        history: Optional[List[dict]] = None,
    ) -> str:
        """Process a user query with optional conversation history.

        Args:
            query: The current user message.
            history: Prior turns as dicts with ``role`` ("user"|"model") and ``content``.
        """
        messages = list(history) if history else []
        messages.append({"role": "user", "content": query})
        reply, _ = await self.run_llm_tool_loop(messages)
        return reply

    async def chat_loop(self):
        """Run an interactive chat loop (keeps conversation across turns)."""
        print("\nMCP Client Started!")
        print("Type your queries or 'quit' to exit.")
        messages: list = []

        while True:
            try:
                query = input("\nQuery: ").strip()
                if query.lower() == "quit":
                    break

                messages.append({"role": "user", "content": query})
                reply, _ = await self.run_llm_tool_loop(messages)
                messages.append({"role": "model", "content": reply})
                print("\n" + reply)
            except Exception as e:
                print(f"\nError: {str(e)}")

    async def cleanup(self):
        """Clean up resources"""
        await self.exit_stack.aclose()


async def main():
    if len(sys.argv) < 2:
        print("Usage: python client.py <path_to_server_script>")
        sys.exit(1)

    client = MCPClient()
    try:
        await client.connect_to_server(sys.argv[1])
        await client.chat_loop()
    finally:
        await client.cleanup()


if __name__ == "__main__":
    import sys
    asyncio.run(main())
