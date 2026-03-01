import asyncio
from typing import Optional, List, Literal
from contextlib import AsyncExitStack

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from google import genai
from google.genai import types
from anthropic import AsyncAnthropic
from dotenv import load_dotenv
import os

from .schema_converter import convert_mcp_schema_to_gemini, convert_mcp_schema_to_anthropic

load_dotenv()

_EXCLUDED_TOOLS = {"initialize-session", "open-document"}

SYSTEM_INSTRUCTION = (
    "You are an Audiotool music production assistant. You help users add instruments and "
    "effects to their projects by calling the available tools.\n\n"

    "ENTITY TYPES:\n"
    "When the user asks for a synth or sound 'like X' (an artist, genre, or adjective), "
    "choose the most appropriate entity type:\n"
    "  - heisenberg: polyphonic synth — pads, keys, chords, leads, atmospheric textures\n"
    "  - bassline: monophonic bass synth — bass lines, acid sounds, sub-bass\n"
    "  - machiniste: drum machine — beats, percussion, rhythmic patterns\n"
    "  - tonematrix: step sequencer — melodic loops, arpeggios, generative patterns\n"
    "  - stompboxDelay: delay effect — echo, reverb-like delay, spatial effects\n\n"

    "ENTITY FIELDS REFERENCE (use these exact field names with update-entity-value):\n"
    "  heisenberg:\n"
    "    gain [0..1] (volume, default 0.708)\n"
    "    glideMs [0..5000] (portamento in ms, default 0)\n"
    "    tuneSemitones [-12..12] (global tuning, default 0)\n"
    "    playModeIndex [1..3] (1=Mono, 2=Legato, 3=Poly, default 3)\n"
    "    unisonoCount [1..4] (voices per note, default 1)\n"
    "    unisonoDetuneSemitones [0..1] (unison detune, default 0.001)\n"
    "    unisonoStereoSpreadFactor [-1..1] (stereo spread, default 0.5)\n"
    "    velocityFactor [0..1] (velocity sensitivity, default 1)\n"
    "    operatorDetuneModeIndex [1..2] (detune mode, default 1)\n"
    "    isActive (bool, default true)\n"
    "  bassline:\n"
    "    cutoffFrequencyHz [220..12000] (filter cutoff, default 220)\n"
    "    filterDecay [0..1] (filter envelope decay, default 0)\n"
    "    filterEnvelopeModulationDepth [0..1] (filter env depth, default 0.1)\n"
    "    filterResonance [0..1] (resonance, default 1)\n"
    "    accent [0..1] (accent strength, default 1)\n"
    "    gain [0..1] (volume, default 0.708)\n"
    "    tuneSemitones [-12..12] (tuning, default 0)\n"
    "    waveformIndex [1..2] (1=sawtooth, 2=square, default 1)\n"
    "    patternIndex [0..27] (active pattern, default 0)\n"
    "    isActive (bool, default true)\n"
    "  machiniste:\n"
    "    globalModulationDepth [-1..1] (mod depth, default 1)\n"
    "    mainOutputGain [0..1] (volume, default 0.708)\n"
    "    patternIndex [0..31] (active pattern, default 0)\n"
    "    isActive (bool, default true)\n"
    "  tonematrix:\n"
    "    patternIndex [0..7] (active pattern, default 0)\n"
    "    isActive (bool, default true)\n"
    "  stompboxDelay:\n"
    "    feedbackFactor [0..1] (feedback amount, default 0.4)\n"
    "    mix [0..1] (dry/wet mix, default 0.2)\n"
    "    stepCount [1..7] (number of delay taps, default 3)\n"
    "    stepLengthIndex [1..3] (1=1/16, 2=1/8T, 3=1/8 bars, default 1)\n"
    "    isActive (bool, default true)\n"
    "IMPORTANT: Only use the field names listed above. Do NOT invent field names "
    "like 'delayTime', 'volume', 'frequency', etc. — they do not exist.\n\n"

    "ENTITY TRACKING:\n"
    "When a tool returns an entity ID (e.g. 'Entity ID: abc-123'), remember it. "
    "When the user refers to an entity by name or says 'it', use the entity ID from "
    "the most recent relevant tool result. You MUST always use the correct entity ID "
    "when calling update-entity-position or other entity tools.\n\n"

    "POSITIONING & MOVEMENT:\n"
    "If the user does not specify a position when adding, omit x and y so the server auto-places.\n"
    "When the user asks to move an entity using directions (left, right, up, down), follow these steps:\n"
    "  1. Call list-entities to get the entity's current position.\n"
    "  2. Calculate the new position: left = x - 120, right = x + 120, up = y - 120, down = y + 120.\n"
    "     If the user specifies a distance (e.g. 'move it far left'), scale accordingly.\n"
    "  3. Call update-entity-position with the calculated coordinates.\n"
    "You MUST call update-entity-position to move entities. Never just describe the move in text.\n\n"

    "ORGANIZE / LAYOUT:\n"
    "When the user asks to organize, arrange, sort, or clean up entities:\n"
    "  1. Call list-entities to get all entities and their positions.\n"
    "  2. Group them by type into rows:\n"
    "     Row 0 (y=0): synths — heisenberg, bassline\n"
    "     Row 1 (y=250): drum machines — machiniste\n"
    "     Row 2 (y=500): sequencers — tonematrix\n"
    "     Row 3 (y=750): effects — stompboxDelay\n"
    "  3. Within each row, space entities horizontally 300px apart starting at x=0.\n"
    "     Example: first entity at (0, rowY), second at (300, rowY), third at (600, rowY).\n"
    "  4. Call update-entity-position for EVERY entity. Do not skip any.\n"
    "  5. Summarize the new layout to the user.\n\n"

    "GENERAL:\n"
    "Always call the tool immediately when you have enough information; "
    "do not ask for parameters the user has not mentioned unless truly ambiguous."
)


def _resolve_llm_api_key(provider: Literal["gemini", "anthropic"], api_key: Optional[str]) -> str:
    if api_key and api_key.strip():
        return api_key.strip()
    if provider == "gemini":
        key = os.getenv("GEMINI_API_KEY")
        if not key:
            raise ValueError("GEMINI_API_KEY environment variable is required (or set llmApiKey in the request)")
        return key
    else:
        key = os.getenv("ANTHROPIC_API_KEY")
        if not key:
            raise ValueError("ANTHROPIC_API_KEY environment variable is required (or set llmApiKey in the request)")
        return key


class MCPClient:
    def __init__(
        self,
        llm_provider: Literal["gemini", "anthropic"] = "gemini",
        llm_api_key: Optional[str] = None,
    ):
        self.session: Optional[ClientSession] = None
        self.exit_stack = AsyncExitStack()
        self._cached_tools: Optional[list] = None
        self._cached_anthropic_tools: Optional[list] = None
        self._llm_provider = llm_provider
        self._llm_api_key = _resolve_llm_api_key(llm_provider, llm_api_key)

        if llm_provider == "gemini":
            self._gemini_client = genai.Client(api_key=self._llm_api_key)
            self._gemini_model = "gemini-2.5-flash"
            self._anthropic_client = None
            self._anthropic_model = None
        else:
            self._gemini_client = None
            self._gemini_model = None
            self._anthropic_client = AsyncAnthropic(api_key=self._llm_api_key)
            self._anthropic_model = "claude-sonnet-4-20250514"

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

        self._cached_tools = [types.Tool(function_declarations=function_declarations)] if function_declarations else None
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
        self._cached_anthropic_tools = tools
        return self._cached_anthropic_tools

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
        max_iterations: int = 10,
    ) -> tuple[list, str]:
        """Run the Gemini <-> MCP tool-calling loop.

        Returns (updated_contents, final_text_reply).
        """
        response = await self._gemini_client.aio.models.generate_content(
            model=self._gemini_model,
            contents=contents,
            config=config,
        )

        if self.session is None:
            raise RuntimeError("Not connected – call connect_to_server() first")

        final_text: list[str] = []
        last_tool_result: Optional[str] = None

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
                        try:
                            result = await self.session.call_tool(tool_name, tool_args)
                            result_str = self._extract_tool_result(result)
                        except Exception as e:
                            result_str = f"Error calling tool {tool_name}: {str(e)}"
                            print(f"[MCP Client] Tool call FAILED: {result_str}")
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
        return contents, text

    async def run_tool_loop_anthropic(
        self,
        messages: list,
        system: str = SYSTEM_INSTRUCTION,
        max_iterations: int = 10,
    ) -> tuple[list, str]:
        """Run the Anthropic Claude <-> MCP tool-calling loop.

        messages: list of {"role": "user"|"assistant", "content": ...} in API format.
        Returns (updated_messages, final_text_reply).
        """
        if self._anthropic_client is None or self.session is None:
            raise RuntimeError("Anthropic client not configured or not connected")

        tools = await self._get_anthropic_tools()
        if not tools:
            raise RuntimeError("No tools available for Anthropic")

        final_text = ""
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
                try:
                    result = await self.session.call_tool(tool_name, tool_args)
                    result_str = self._extract_tool_result(result)
                except Exception as e:
                    result_str = f"Error calling tool {tool_name}: {str(e)}"
                    print(f"[MCP Client] Tool call FAILED: {result_str}")
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
        return messages, final_text

    async def run_llm_tool_loop(
        self,
        messages: list[dict],
        resolved_intent_hint: Optional[str] = None,
    ) -> str:
        """Provider-agnostic: run the appropriate LLM + MCP tool loop and return the reply.

        messages: list of {"role": "user"|"model", "content": str} (conversation history).
        resolved_intent_hint: optional hint from recommend-entity-for-style to prepend.
        """
        if self._llm_provider == "anthropic":
            # Convert to Anthropic format: "model" -> "assistant", content as list of text blocks
            api_messages = []
            for m in messages:
                role = "assistant" if m["role"] == "model" else "user"
                content = m["content"]
                api_messages.append({"role": role, "content": content})
            if resolved_intent_hint:
                api_messages.append({
                    "role": "user",
                    "content": (
                        f"[system hint] The recommend-entity-for-style tool returned: "
                        f"{resolved_intent_hint}. Use this recommendation when deciding which entity to add."
                    ),
                })
            _, reply = await self.run_tool_loop_anthropic(api_messages, system=SYSTEM_INSTRUCTION)
            return reply

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
        _, reply = await self.run_tool_loop(contents, config)
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
        return await self.run_llm_tool_loop(messages)

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
                reply = await self.run_llm_tool_loop(messages)
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
