import asyncio
from typing import Optional
from contextlib import AsyncExitStack

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from google import genai
from google.genai import types
from dotenv import load_dotenv
import os

from .schema_converter import convert_mcp_schema_to_gemini

load_dotenv()  # load environment variables from .env

class MCPClient:
    def __init__(self):
        # Initialize session and client objects
        self.session: Optional[ClientSession] = None
        self.exit_stack = AsyncExitStack()
        # Create the new google.genai Client
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise ValueError("GEMINI_API_KEY environment variable is required")
        self.client = genai.Client(api_key=api_key)
        self.model_name = "gemini-2.5-flash-lite"

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

        try:
            # Add timeout to prevent infinite hanging
            result = await asyncio.wait_for(
                self.session.call_tool("initialize-session", tool_args),
                timeout=30.0  # 30 second timeout
            )
            print("[MCP Client] Session initialized successfully!")
            return str(result.content)
        except asyncio.TimeoutError:
            error_msg = "Session initialization timed out after 30 seconds. Check MCP server logs for details."
            print(f"[MCP Client] ERROR: {error_msg}")
            raise Exception(error_msg)
        except Exception as e:
            print(f"[MCP Client] ERROR initializing session: {str(e)}")
            raise

    async def process_query(self, query: str) -> str:
        """Process a query using Gemini and available tools"""
        # Get available MCP tools and convert them to google.genai format
        mcp_tools_response = await self.session.list_tools()

        # Convert MCP tools to google.genai FunctionDeclaration format
        function_declarations = []
        for tool in mcp_tools_response.tools:
            # Convert MCP schema to Gemini-compatible format
            # This removes unsupported fields like $schema and additionalProperties
            cleaned_schema = convert_mcp_schema_to_gemini(
                dict(tool.inputSchema) if tool.inputSchema else {}
            )

            func_decl = types.FunctionDeclaration(
                name=tool.name,
                description=tool.description or "",
                parameters=cleaned_schema
            )
            function_declarations.append(func_decl)

        # Create a Tool object with all function declarations
        tools = [types.Tool(function_declarations=function_declarations)] if function_declarations else None

        # Build conversation history
        contents = [query]

        # Initial Gemini API call (async to avoid blocking the event loop)
        config = types.GenerateContentConfig(tools=tools) if tools else None
        response = await self.client.aio.models.generate_content(
            model=self.model_name,
            contents=contents,
            config=config
        )

        final_text = []
        last_tool_result = None  # Track the last tool result for fallback
        max_iterations = 10  # Prevent infinite loops
        iteration = 0

        while iteration < max_iterations:
            iteration += 1

            # Check if response has function calls
            has_function_call = False

            if response.candidates and len(response.candidates) > 0:
                candidate = response.candidates[0]
                if candidate.content and candidate.content.parts:
                    for part in candidate.content.parts:
                        # Check if this part is a function call
                        if hasattr(part, 'function_call') and part.function_call:
                            has_function_call = True
                            function_call = part.function_call

                            # Execute the MCP tool
                            tool_name = function_call.name
                            tool_args = dict(function_call.args) if function_call.args else {}

                            print(f"[MCP Client] Calling tool: {tool_name} with args: {tool_args}")

                            # Call the MCP tool
                            result = await self.session.call_tool(tool_name, tool_args)

                            print(f"[MCP Client] Tool result received. Type: {type(result)}")
                            print(f"[MCP Client] Tool result content type: {type(result.content)}")
                            print(f"[MCP Client] Tool result content: {result.content}")

                            # Extract actual text from MCP content blocks
                            # result.content is a list of TextContent objects; str() gives the repr,
                            # not the text, which confuses Gemini and causes empty replies.
                            if hasattr(result, 'content') and result.content:
                                text_parts = []
                                for block in result.content:
                                    if hasattr(block, 'text') and block.text:
                                        text_parts.append(block.text)
                                result_str = "\n".join(text_parts) if text_parts else str(result.content)
                            else:
                                result_str = str(result)

                            # Keep track of the last tool result for fallback
                            last_tool_result = result_str
                            print(f"[MCP Client] Building function response with result: {result_str[:200]}...")

                            function_response = types.Part.from_function_response(
                                name=tool_name,
                                response={"result": result_str}
                            )

                            print(f"[MCP Client] Function response created successfully")

                            # Continue the conversation with the function result
                            contents = [
                                query,
                                candidate.content,  # Include the assistant's function call
                                types.Content(parts=[function_response], role="user")
                            ]

                            print(f"[MCP Client] Calling Gemini with tool result...")

                            # Get next response from Gemini
                            try:
                                response = await self.client.aio.models.generate_content(
                                    model=self.model_name,
                                    contents=contents,
                                    config=config
                                )
                                print(f"[MCP Client] Gemini response received")
                            except Exception as e:
                                print(f"[MCP Client] ERROR calling Gemini after tool execution: {str(e)}")
                                raise

                            # Break out of the for loop to process the new response in the next iteration
                            print(f"[MCP Client] Breaking to process new response in next iteration")
                            break

                        # Collect text responses
                        elif hasattr(part, 'text') and part.text:
                            final_text.append(part.text)

            # If no function calls were made, we're done
            if not has_function_call:
                break

        if final_text:
            return "\n".join(final_text)
        if last_tool_result:
            return f"Operation completed. Result: {last_tool_result}"
        return "No response generated."

    async def chat_loop(self):
        """Run an interactive chat loop"""
        print("\nMCP Client Started!")
        print("Type your queries or 'quit' to exit.")

        while True:
            try:
                query = input("\nQuery: ").strip()

                if query.lower() == 'quit':
                    break

                response = await self.process_query(query)
                print("\n" + response)

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
