from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import os
import logging
from agents.mcp_client_new import MCPClient
from models import TraceItem, AgentRequest, AgentResponse

logger = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/agent/run")
async def run_agent(request: AgentRequest) -> AgentResponse:
    """
    Process a user query through the Gemini + MCP agent.

    Args:
        request: AgentRequest with prompt, keywords, loop count, and optional auth tokens/project URL

    Returns:
        AgentResponse with the agent's reply and optional trace data
    """
    client = None
    try:
        # Get the MCP server script path from environment or use default
        # Resolves to ../mcp-server/dist/server.js relative to this file's location
        if mcp_server_path := os.getenv("MCP_SERVER_PATH"):
            pass  # Use environment variable if set
        else:
            # Default path: go up from backend folder to root, then into mcp-server/dist
            backend_dir = os.path.dirname(__file__)
            mcp_server_path = os.path.join(backend_dir, "..", "mcp-server", "dist", "server.js")

        # Create and initialize the MCP client
        client = MCPClient()
        await client.connect_to_server(mcp_server_path)

        # Initialize session if auth tokens and project URL are provided
        if request.authTokens and request.projectUrl:
            await client.initialize_session(
                access_token=request.authTokens.accessToken,
                expires_at=request.authTokens.expiresAt,
                client_id=request.authTokens.clientId,
                redirect_url=request.authTokens.redirectUrl,
                scope=request.authTokens.scope,
                project_url=request.projectUrl,
                refresh_token=request.authTokens.refreshToken
            )

        # Process the user's query through Gemini with MCP tools
        reply = await client.process_query(request.prompt)

        return AgentResponse(reply=reply, trace=None)

    except Exception as e:
        error_msg = f"Agent error: {str(e)}"
        return AgentResponse(reply=error_msg, trace=None)

    finally:
        # Cleanup MUST happen in the same asyncio Task that called
        # connect_to_server(), because the MCP library uses anyio cancel
        # scopes that are bound to the Task they were entered in.
        # Using BackgroundTasks or asyncio.wait_for would run cleanup in a
        # different Task, causing "Attempted to exit cancel scope in a
        # different task" RuntimeError.
        if client is not None:
            try:
                async with asyncio.timeout(5.0):
                    await client.cleanup()
            except (TimeoutError, asyncio.CancelledError):
                logger.info("MCP client cleanup timed out — resources released")
            except Exception as e:
                logger.warning("MCP client cleanup error: %s", e)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
