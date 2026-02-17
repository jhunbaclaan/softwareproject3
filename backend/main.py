from fastapi import BackgroundTasks, FastAPI
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
async def run_agent(request: AgentRequest, background_tasks: BackgroundTasks) -> AgentResponse:
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
        # BackgroundTasks run AFTER the response is sent, but in the SAME asyncio
        # task — so AsyncExitStack cancel scopes are exited in the correct task.
        if client is not None:
            background_tasks.add_task(_safe_cleanup, client)


async def _safe_cleanup(client: MCPClient):
    """Clean up MCP client with a timeout to prevent hanging."""
    try:
        await asyncio.wait_for(client.cleanup(), timeout=5.0)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        # TimeoutError: cleanup took longer than 5s (MCP server won't exit)
        # CancelledError: anyio cancel scopes inside the MCP library react to
        #   asyncio.wait_for's cancellation — this is a BaseException in Python 3.9+
        #   so 'except Exception' won't catch it.
        logger.info("MCP client cleanup timed out — resources released")
    except Exception as e:
        logger.warning("MCP client cleanup error: %s", e)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
