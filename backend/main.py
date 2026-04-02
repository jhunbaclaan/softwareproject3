import os
from dotenv import load_dotenv

_backend_dir = os.path.dirname(os.path.abspath(__file__))
_project_root = os.path.dirname(_backend_dir)
load_dotenv(os.path.join(_project_root, ".env"))

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import json
import logging
from agents.mcp_client_new import MCPClient
from agents.graph import run_agent_graph
from models import TraceItem, AgentRequest, AgentResponse, GeneratedMusicAttachment
from routes.music import router as music_router

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Persistent MCP client state
# ---------------------------------------------------------------------------

_client: MCPClient | None = None
_client_project_url: str | None = None
_client_llm_provider: str = "gemini"
_client_llm_api_key: str | None = None
_client_lock = asyncio.Lock()


def _get_mcp_server_path() -> str:
    if path := os.getenv("MCP_SERVER_PATH"):
        return path
    backend_dir = os.path.dirname(__file__)
    return os.path.join(backend_dir, "..", "mcp-server", "dist", "server.js")


async def _ensure_client(request: AgentRequest) -> MCPClient:
    """Return a ready-to-use MCPClient, reusing it across requests.

    A new client is only created when:
    - No client exists yet (first request).
    - The project URL, LLM provider, or LLM API key changed.
    - The previous client's session has become unusable.
    """
    global _client, _client_project_url, _client_llm_provider, _client_llm_api_key

    project_url = request.projectUrl if (request.authTokens and request.projectUrl) else None
    llm_provider = request.llmProvider or "gemini"
    llm_api_key = request.llmApiKey if (request.llmApiKey and request.llmApiKey.strip()) else None

    async with _client_lock:
        need_new = (
            _client is None
            or _client.session is None
            or project_url != _client_project_url
            or llm_provider != _client_llm_provider
            or llm_api_key != _client_llm_api_key
        )

        if need_new:
            if _client is not None:
                try:
                    await asyncio.wait_for(_client.cleanup(), timeout=5.0)
                except Exception:
                    logger.warning("Old MCP client cleanup failed; proceeding")
                _client = None
                _client_project_url = None
                _client_llm_provider = "gemini"
                _client_llm_api_key = None

            client = MCPClient(llm_provider=llm_provider, llm_api_key=llm_api_key)
            await client.connect_to_server(_get_mcp_server_path())
            _client_llm_provider = llm_provider
            _client_llm_api_key = llm_api_key

            if request.authTokens and request.projectUrl:
                await client.initialize_session(
                    access_token=request.authTokens.accessToken,
                    expires_at=request.authTokens.expiresAt,
                    client_id=request.authTokens.clientId,
                    redirect_url=request.authTokens.redirectUrl,
                    scope=request.authTokens.scope,
                    project_url=request.projectUrl,
                    refresh_token=request.authTokens.refreshToken,
                )

            _client = client
            _client_project_url = project_url

        return _client


async def _shutdown_client():
    """Cleanly tear down the persistent MCP client."""
    global _client, _client_project_url, _client_llm_provider, _client_llm_api_key
    if _client is not None:
        try:
            await asyncio.wait_for(_client.cleanup(), timeout=5.0)
        except (TimeoutError, asyncio.CancelledError):
            logger.info("MCP client cleanup timed out on shutdown")
        except Exception as exc:
            logger.warning("MCP client cleanup error on shutdown: %s", exc)
        _client = None
        _client_project_url = None
        _client_llm_provider = "gemini"
        _client_llm_api_key = None


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    await _shutdown_client()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(music_router)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/agent/run")
async def run_agent(request: AgentRequest):
    """Process a user query and stream events (traces/reply) to the frontend."""
    try:
        client = await _ensure_client(request)
        client.set_elevenlabs_api_key(request.elevenlabsApiKey)
    except Exception as e:
        error_msg = str(e)
        async def error_early():
            yield f"data: {json.dumps({'type': 'error', 'data': {'error': error_msg}})}\n\n"
        return StreamingResponse(error_early(), media_type="text/event-stream")

    history = None
    if request.messages:
        history = [{"role": m.role, "content": m.content} for m in request.messages]

    daw_context = None
    if request.dawContext:
        daw_context = request.dawContext.model_dump(exclude_none=True) or None

    async def event_generator():
        queue = asyncio.Queue()

        async def stream_callback(event: dict):
            await queue.put(event)

        async def run_task():
            try:
                reply, raw_music = await run_agent_graph(
                    client, request.prompt, history=history, daw_context=daw_context, stream_callback=stream_callback
                )
                generated = (
                    GeneratedMusicAttachment(**raw_music).model_dump() if raw_music else None
                )
                await queue.put({"type": "reply", "data": {"reply": reply, "generated_music": generated}})
            except Exception as e:
                await queue.put({"type": "error", "data": {"error": f"Agent error: {str(e)}"}})
            finally:
                await queue.put(None)

        task = asyncio.create_task(run_task())

        while True:
            event = await queue.get()
            if event is None:
                break
            yield f"data: {json.dumps(event)}\n\n"

        await task

    return StreamingResponse(event_generator(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
