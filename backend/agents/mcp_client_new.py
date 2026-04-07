import asyncio
import json
from typing import Any, Dict, Optional, List, Literal, Tuple, Callable
from contextlib import AsyncExitStack

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

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
            "description": "If true (default), no vocals.",
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
        "You are an Audiotool music production assistant. You help users add instruments and "
        "effects to their projects by calling the available tools.\n\n"
        "ENTITY TRACKING:\n"
        "When a tool returns an entity ID (e.g. 'Entity ID: abc-123'), remember it. "
        "When the user refers to an entity by name or says 'it', use the entity ID from "
        "the most recent relevant tool result. You MUST always use the correct entity ID "
        "when calling update-entity-position or other entity tools.\n\n"
        "GENERAL:\n"
        "Always call the tool immediately when you have enough information; "
        "do not ask for parameters the user has not mentioned unless truly ambiguous. "
        "When the user asks to change the tempo/BPM or time signature, call `update-project-config` immediately.\n\n"
        "ELEVENLABS MUSIC:\n"
        "When the user wants AI-generated audio from a text description (e.g. 'make a 15s lo-fi beat'), "
        f"call the `{GENERATE_MUSIC_TOOL_NAME}` tool with their prompt. Do not use this for ABC notation "
        "(use add-abc-track instead). Describe style and mood; if generation fails, retry with a generic "
        "style description and avoid naming specific tunes or copyrighted titles.\n\n"
        "MASTERING SAFETY:\n"
        "Before rewiring for mastering, call get-project-summary and identify all currently audible sources. "
        "This includes note-track players AND audio-track players (for example audioDevice entities created by imported samples). "
        "If you disconnect a source cable, reconnect that same source in the replacement chain immediately. "
        "Do not remove cables unless their replacement routing is planned in the same mastering step.\n\n"
        "MIXING AND FX SAFETY:\n"
        "The same source-preservation rules apply when adding or changing mix effects: keep every note-track and audio-track "
        "player (including audioDevice for samples) routed to the mixer. Prefer update-entity-values and targeted connection "
        "changes over bulk remove-entity to replace a working effect chain.\n\n"
        "ABC NOTATION:\n"
        "When calling add-abc-track, pass abcNotation with standard ABC layout: each information field "
        "on its own line (newlines between X:, T:, M:, K:, L:, etc.), then the tune body. "
        "Do not put the entire header on one line with spaces—that breaks parsing.\n\n"
        "RESPONSE FORMAT:\n"
        "Always respond in plain text. Do not use any markdown formatting such as "
        "bold (**), italic (*), headers (#), bullet points (-), numbered lists, "
        "or code blocks. Do not use emojis. Keep responses concise and conversational.\n\n"
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
        return self._extract_tool_result(result), None

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

        summary = (
            f"Success: generated about {length // 1000}s of "
            f"{'instrumental ' if instrumental else ''}audio ({fmt}). "
            "The sample has been automatically added to the project timeline. "
            "The user can play it below or in the DAW. "
            "Do not tell the user to import it — it is already imported."
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
            server_script_path: Path to the server script (.py, .js, or .ts)
        """
        is_python = server_script_path.endswith('.py')
        is_js = server_script_path.endswith('.js') or server_script_path.endswith('.ts')
        if not (is_python or is_js):
            raise ValueError("Server script must be a .py, .js, or .ts file")

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
        redirect_url: str,
        scope: str,
        project_url: str,
        refresh_token: Optional[str] = None
    ) -> str:
        """Initialize authenticated session with auth tokens and project URL"""
        print("[MCP Client] Initializing session...")
        tool_args = {
            "accessToken": access_token,
            "expiresAt": expires_at,
            "clientId": client_id,
            "redirectUrl": redirect_url,
            "scope": scope,
            "projectUrl": project_url,
        }

        if refresh_token:
            tool_args["refreshToken"] = refresh_token

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
                    "(use add-abc-track for ABC)."
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
                "For AI-generated music requests—not ABC notation (add-abc-track)."
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
                    "Not for ABC notation."
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
        max_iterations: int = 40,
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

        for _ in range(max_iterations):
            has_function_call = False

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
                        except Exception as e:
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
        max_iterations: int = 40,
        stream_callback: Optional[Any] = None,
    ) -> tuple[list, str, Optional[Dict[str, Any]]]:
        """Run the Anthropic Claude <-> MCP tool-calling loop.

        messages: list of {"role": "user"|"assistant", "content": ...} in API format.
        Returns (updated_messages, final_text_reply, optional generated_music dict).
        """
        if self._anthropic_client is None:
            raise RuntimeError("Anthropic client not configured or not connected")

        tools = await self._get_anthropic_tools()
        if not tools:
            raise RuntimeError("No tools available for Anthropic")

        final_text = ""
        music_attachment: Optional[Dict[str, Any]] = None
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
                except Exception as e:
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

            messages.append({"role": "user", "content": tool_results})

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
        max_iterations: int = 40,
        stream_callback: Optional[Any] = None,
    ) -> tuple[list[dict], str, Optional[Dict[str, Any]]]:
        """Run the OpenAI chat completions <-> MCP tool-calling loop.

        messages: list of {"role": "user"|"assistant"|"system", "content": str} in API format.
        Returns (updated_messages, final_text_reply, optional generated_music dict).
        """
        if self._openai_client is None:
            raise RuntimeError("OpenAI client not configured or not connected")

        tools = await self._get_openai_tools()
        if not tools:
            raise RuntimeError("No tools available for OpenAI")

        # Build request messages with system first
        request_messages = [{"role": "system", "content": system}]
        request_messages.extend(messages)

        final_text = ""
        music_attachment: Optional[Dict[str, Any]] = None
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
                except Exception as e:
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
            "If the user asks to change the tempo or time signature, you MUST call `update-project-config` "
            "with the new values. Do not claim the change was made without calling the tool. "
            "When the user wants something that fits their project, use get-project-summary "
            "and export-tracks-abc to gather deeper context (key, chord progression, note ranges) "
            "before generating. If the user just asks for a general sample without mentioning "
            "matching the project, ignore this context and use only their description."
        )

    async def run_llm_tool_loop(
        self,
        messages: list[dict],
        resolved_intent_hint: Optional[str] = None,
        daw_context: Optional[Dict[str, Any]] = None,
        stream_callback: Optional[Any] = None,
        project_config_precall: Optional[str] = None,
    ) -> tuple[str, Optional[Dict[str, Any]]]:
        """Provider-agnostic: run the appropriate LLM + MCP tool loop.

        messages: list of {"role": "user"|"model", "content": str} (conversation history).
        resolved_intent_hint: optional hint from recommend-entity-for-style to prepend.
        daw_context: optional dict with DAW project settings (tempoBpm, timeSignature).
        project_config_precall: optional result text from deterministic update-project-config precall.

        Returns (reply_text, generated_music dict or None).
        """
        daw_hint = self._build_daw_context_hint(daw_context)

        precall_hint = None
        if project_config_precall:
            precall_hint = (
                "[System result] update-project-config already ran: "
                f"{project_config_precall}. Answer the user based on this; "
                "do not claim changes that failed."
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
            if resolved_intent_hint:
                api_messages.append({
                    "role": "user",
                    "content": (
                        f"[system hint] The recommend-entity-for-style tool returned: "
                        f"{resolved_intent_hint}. Use this recommendation when deciding which entity to add."
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
            if resolved_intent_hint:
                api_messages.append({
                    "role": "user",
                    "content": (
                        f"[system hint] The recommend-entity-for-style tool returned: "
                        f"{resolved_intent_hint}. Use this recommendation when deciding which entity to add."
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
        if resolved_intent_hint:
            contents.append(
                types.Content(
                    parts=[types.Part.from_text(
                        text=f"[system hint] The recommend-entity-for-style tool returned: "
                        f"{resolved_intent_hint}. Use this recommendation when deciding which entity to add."
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
