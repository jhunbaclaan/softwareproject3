import os
from pathlib import Path
from dotenv import load_dotenv

_backend_dir = os.path.dirname(os.path.abspath(__file__))
_project_root = os.path.dirname(_backend_dir)
load_dotenv(os.path.join(_project_root, ".env"))

from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
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
_current_run_task: asyncio.Task | None = None


async def _cancel_current_run():
    """Cancel the in-flight agent run task, if any."""
    global _current_run_task
    if _current_run_task is not None and not _current_run_task.done():
        _current_run_task.cancel()
        try:
            await _current_run_task
        except (asyncio.CancelledError, Exception):
            pass
    _current_run_task = None


def _get_mcp_server_path() -> str:
    if url := os.getenv("MCP_SERVER_URL"):
        return url
    if path := os.getenv("MCP_SERVER_PATH"):
        return path
    backend_dir = os.path.dirname(__file__)
    return os.path.join(backend_dir, "..", "mcp-server", "dist", "server.js")


def _get_cors_allow_origins() -> list[str]:
    raw = os.getenv("CORS_ALLOW_ORIGINS", "")
    if raw.strip():
        return [origin.strip() for origin in raw.split(",") if origin.strip()]
    return ["http://127.0.0.1:5173", "http://localhost:5173"]


def _get_frontend_dist_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "frontend" / "dist"


def _persist_mcp_client() -> bool:
    return os.getenv("MCP_CLIENT_PERSIST", "1").strip().lower() not in {"0", "false", "no"}


def _uses_remote_mcp() -> bool:
    return _get_mcp_server_path().startswith(("http://", "https://"))


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
            not _persist_mcp_client()
            or
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
    allow_origins=_get_cors_allow_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(music_router)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/agent/cancel")
async def cancel_agent():
    """Explicitly cancel the in-flight agent run."""
    await _cancel_current_run()
    return {"status": "cancelled"}


@app.post("/agent/run")
async def run_agent(request: AgentRequest):
    """Process a user query and stream events (traces/reply) to the frontend."""
    if _current_run_task is not None and not _current_run_task.done():
        raise HTTPException(status_code=409, detail="An agent run is already in progress.")

    history = None
    if request.messages:
        history = [{"role": m.role, "content": m.content} for m in request.messages]

    daw_context = None
    if request.dawContext:
        daw_context = request.dawContext.model_dump(exclude_none=True) or None

    async def event_generator():
        queue: asyncio.Queue = asyncio.Queue()

        async def stream_callback(event: dict):
            await queue.put(event)

        async def run_task():
            try:
                client = await _ensure_client(request)
                client.set_elevenlabs_api_key(request.elevenlabsApiKey)
                reply, raw_music = await asyncio.wait_for(
                    run_agent_graph(
                        client, request.prompt, history=history, daw_context=daw_context, stream_callback=stream_callback
                    ),
                    timeout=300,
                )
                generated = (
                    GeneratedMusicAttachment(**raw_music).model_dump() if raw_music else None
                )
                await queue.put({"type": "reply", "data": {"reply": reply, "generated_music": generated}})
            except asyncio.CancelledError:
                await queue.put({"type": "error", "data": {"error": "Request cancelled."}})
            except Exception as e:
                await queue.put({"type": "error", "data": {"error": f"Agent error: {str(e)}"}})
            finally:
                await queue.put(None)
                if not _persist_mcp_client() and not _uses_remote_mcp():
                    await _shutdown_client()

        async def keepalive():
            while True:
                await asyncio.sleep(10)
                await queue.put({"__keepalive__": True})

        global _current_run_task
        task = asyncio.create_task(run_task())
        _current_run_task = task
        keepalive_task = asyncio.create_task(keepalive())

        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                if event.get("__keepalive__"):
                    yield f"data: {json.dumps({'type': 'keepalive'})}\n\n"
                    continue
                try:
                    yield f"data: {json.dumps(event)}\n\n"
                except (TypeError, ValueError) as exc:
                    logger.warning("Skipping non-serializable SSE event (%s): %s", exc, event)
        except asyncio.CancelledError:
            pass
        finally:
            keepalive_task.cancel()
            if not task.done():
                task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
            if _current_run_task is task:
                _current_run_task = None

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


_frontend_dist_dir = _get_frontend_dist_dir()
if _frontend_dist_dir.exists():
    assets_dir = _frontend_dist_dir / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="frontend-assets")

    @app.get("/", include_in_schema=False)
    async def serve_frontend_index():
        return FileResponse(_frontend_dist_dir / "index.html")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_frontend_spa(full_path: str):
        # Keep API and docs routes owned by FastAPI handlers.
        if full_path in {"health", "docs", "redoc", "openapi.json"} or full_path.startswith(("agent/", "music/")):
            raise HTTPException(status_code=404)

        requested_file = _frontend_dist_dir / full_path
        if requested_file.is_file():
            return FileResponse(requested_file)

        return FileResponse(_frontend_dist_dir / "index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
