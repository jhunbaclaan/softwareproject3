import os
from pathlib import Path
from dotenv import load_dotenv

_backend_dir = os.path.dirname(os.path.abspath(__file__))
_project_root = os.path.dirname(_backend_dir)
load_dotenv(os.path.join(_project_root, ".env"))

from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import asyncio
import json
import logging
import time
from agents.mcp_client_new import MCPClient
from agents.graph import run_agent_graph
from models import TraceItem, AgentRequest, AgentResponse, GeneratedMusicAttachment
from routes.music import router as music_router

logger = logging.getLogger(__name__)
AGENT_RUN_TIMEOUT_SECONDS = 300
MCP_CLIENT_CLEANUP_TIMEOUT_SECONDS = 5.0

# ---------------------------------------------------------------------------
# Persistent MCP client state
# ---------------------------------------------------------------------------

_client: MCPClient | None = None
_client_project_url: str | None = None
_client_llm_provider: str = "gemini"
_client_llm_api_key: str | None = None
_client_lock = asyncio.Lock()
_current_run_task: asyncio.Task | None = None
_last_agent_completed_monotonic: float | None = None
_mcp_idle_task: asyncio.Task | None = None


def _format_exception_detail(exc: BaseException) -> str:
    message = str(exc).strip()
    if message:
        return f"{type(exc).__name__}: {message}"
    return type(exc).__name__


async def _cleanup_client_with_timeout(
    client: MCPClient,
    label: str,
    timeout_seconds: float = MCP_CLIENT_CLEANUP_TIMEOUT_SECONDS,
) -> None:
    """Attempt client cleanup with a timeout in the current task."""
    try:
        async with asyncio.timeout(timeout_seconds):
            await client.cleanup()
    except TimeoutError:
        logger.warning(
            "%s cleanup exceeded %.1fs; continuing",
            label,
            timeout_seconds,
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.warning("%s cleanup failed: %s", label, _format_exception_detail(exc))


def _mcp_idle_teardown_seconds() -> float:
    """Seconds with no finished agent run before dropping the persistent MCP client.

    When ``MCP_CLIENT_PERSIST`` is enabled, this closes the Python MCP session so the
    MCP server transport closes and Audiotool ``SyncedDocument`` sync can stop.

    ``0`` or negative disables idle teardown.
    """
    raw = os.getenv("MCP_IDLE_TEARDOWN_SECONDS", "600").strip()
    try:
        return max(0.0, float(raw))
    except ValueError:
        return 600.0


def _mark_agent_run_finished() -> None:
    """Record that an agent run ended (success, error, or cancel). Used for MCP idle teardown."""
    global _last_agent_completed_monotonic
    _last_agent_completed_monotonic = time.monotonic()


async def _mcp_idle_watcher() -> None:
    """Periodically drop the persistent MCP client after idle timeout (see ``_mcp_idle_teardown_seconds``)."""
    while True:
        idle_sec = _mcp_idle_teardown_seconds()
        if idle_sec <= 0:
            await asyncio.sleep(60.0)
            continue
        poll = min(60.0, max(5.0, idle_sec / 4.0))
        await asyncio.sleep(poll)

        if not _persist_mcp_client():
            continue
        t = _current_run_task
        if t is not None and not t.done():
            continue

        async with _client_lock:
            if _client is None:
                continue
            last = _last_agent_completed_monotonic
            if last is None:
                continue
            if time.monotonic() - last < idle_sec:
                continue
            logger.info(
                "MCP idle teardown: no agent activity for %.0fs (limit %.0fs); closing persistent client",
                time.monotonic() - last,
                idle_sec,
            )
            await _shutdown_client()


async def _cancel_current_run():
    """Cancel the in-flight agent run task, if any."""
    global _current_run_task
    if _current_run_task is not None and not _current_run_task.done():
        _current_run_task.cancel()
        try:
            await asyncio.wait_for(_current_run_task, timeout=5.0)
        except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
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
    persist_enabled = os.getenv("MCP_CLIENT_PERSIST", "1").strip().lower() not in {"0", "false", "no"}
    if not persist_enabled:
        return False

    # Remote streamable-http sessions are task-affine; make persistence opt-in
    # for remote MCP targets.
    if _uses_remote_mcp():
        return os.getenv("MCP_REMOTE_CLIENT_PERSIST", "0").strip().lower() in {"1", "true", "yes"}

    return True


def _is_remote_mcp_target(target: str) -> bool:
    return target.startswith(("http://", "https://"))


def _uses_remote_mcp() -> bool:
    return _is_remote_mcp_target(_get_mcp_server_path())


def _is_retryable_mcp_runtime_error(exc: Exception) -> bool:
    """Best-effort classifier for transient MCP transport/server failures."""
    message = f"{type(exc).__name__}: {exc}".lower()
    return (
        ("httpstatuserror" in message and "500" in message and "/mcp" in message)
        or ("connecterror" in message)
        or ("all connection attempts failed" in message)
        or ("post_writer" in message and "/mcp" in message)
    )


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

    server_target = _get_mcp_server_path()

    # For remote MCP, create a per-request client/session only when persistence
    # is explicitly disabled. With persistence enabled, treat remote and local
    # targets the same so we avoid re-initializing heavyweight MCP sessions.
    if _is_remote_mcp_target(server_target) and not _persist_mcp_client():
        retries_raw = os.getenv("MCP_CONNECT_RETRIES", "3")
        try:
            retries = max(1, int(retries_raw))
        except ValueError:
            retries = 3

        last_exc: Exception | None = None
        for attempt in range(1, retries + 1):
            client = MCPClient(llm_provider=llm_provider, llm_api_key=llm_api_key)
            try:
                await client.connect_to_server(server_target)
                if request.authTokens and request.projectUrl:
                    await client.initialize_session(
                        access_token=request.authTokens.accessToken,
                        expires_at=request.authTokens.expiresAt,
                        client_id=request.authTokens.clientId,
                        project_url=request.projectUrl,
                        refresh_token=request.authTokens.refreshToken,
                    )
                return client
            except Exception as exc:
                last_exc = exc
                await _cleanup_client_with_timeout(
                    client,
                    "Remote MCP client cleanup during retry",
                )

                if attempt < retries:
                    backoff_s = min(2.0, 0.5 * attempt)
                    logger.warning(
                        "Remote MCP connect attempt %s/%s failed (%s); retrying in %.1fs",
                        attempt,
                        retries,
                        exc,
                        backoff_s,
                    )
                    await asyncio.sleep(backoff_s)

        assert last_exc is not None
        raise last_exc

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
                await _cleanup_client_with_timeout(_client, "Old MCP client")
                _client = None
                _client_project_url = None
                _client_llm_provider = "gemini"
                _client_llm_api_key = None

            client = MCPClient(llm_provider=llm_provider, llm_api_key=llm_api_key)
            await client.connect_to_server(server_target)
            _client_llm_provider = llm_provider
            _client_llm_api_key = llm_api_key

            if request.authTokens and request.projectUrl:
                await client.initialize_session(
                    access_token=request.authTokens.accessToken,
                    expires_at=request.authTokens.expiresAt,
                    client_id=request.authTokens.clientId,
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
        await _cleanup_client_with_timeout(_client, "MCP client cleanup on shutdown")
        _client = None
        _client_project_url = None
        _client_llm_provider = "gemini"
        _client_llm_api_key = None


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _mcp_idle_task
    if _mcp_idle_teardown_seconds() > 0 and _persist_mcp_client():
        _mcp_idle_task = asyncio.create_task(_mcp_idle_watcher(), name="mcp-idle-watcher")
    try:
        yield
    finally:
        if _mcp_idle_task is not None:
            _mcp_idle_task.cancel()
            try:
                await _mcp_idle_task
            except asyncio.CancelledError:
                pass
            _mcp_idle_task = None
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
async def run_agent(request: AgentRequest, http_request: Request):
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
            max_attempts = 2 if _uses_remote_mcp() else 1
            attempt = 0

            try:
                while attempt < max_attempts:
                    attempt += 1
                    client: MCPClient | None = None
                    saw_successful_tool = False

                    async def attempt_stream_callback(event: dict):
                        nonlocal saw_successful_tool
                        if (
                            event.get("type") == "trace_update"
                            and isinstance(event.get("data"), dict)
                            and event["data"].get("status") == "done"
                        ):
                            saw_successful_tool = True
                        await stream_callback(event)

                    try:
                        client = await _ensure_client(request)
                        client.set_elevenlabs_api_key(request.elevenlabsApiKey)
                        reply, raw_music = await asyncio.wait_for(
                            run_agent_graph(
                                client,
                                request.prompt,
                                history=history,
                                daw_context=daw_context,
                                stream_callback=attempt_stream_callback,
                            ),
                            timeout=AGENT_RUN_TIMEOUT_SECONDS,
                        )
                        generated = (
                            GeneratedMusicAttachment(**raw_music).model_dump() if raw_music else None
                        )
                        if generated and isinstance(generated.get("audio_base64"), str):
                            b64_len = len(generated["audio_base64"])
                            logger.info(
                                "[agent-diag] generated_music ready base64_chars=%s approx_decoded_bytes=%s",
                                b64_len,
                                (b64_len * 3) // 4,
                            )
                        await queue.put({"type": "reply", "data": {"reply": reply, "generated_music": generated}})
                        return
                    except Exception as e:
                        is_retryable = (
                            _uses_remote_mcp()
                            and attempt < max_attempts
                            and _is_retryable_mcp_runtime_error(e)
                            and not saw_successful_tool
                        )
                        if is_retryable:
                            # Drop cached client before retry so the next attempt
                            # performs a clean reconnect.
                            await _shutdown_client()
                            logger.warning(
                                "Retrying run after transient MCP error (%s/%s): %s",
                                attempt,
                                max_attempts,
                                e,
                            )
                            continue
                        raise
                    finally:
                        if client is not None and _uses_remote_mcp() and not _persist_mcp_client():
                            await _cleanup_client_with_timeout(
                                client,
                                "Remote MCP client cleanup",
                            )
                        elif not _persist_mcp_client():
                            await _shutdown_client()
            except asyncio.CancelledError:
                await queue.put({"type": "error", "data": {"error": "Request cancelled."}})
            except asyncio.TimeoutError:
                await queue.put(
                    {
                        "type": "error",
                        "data": {
                            "error": (
                                f"Agent timed out after {AGENT_RUN_TIMEOUT_SECONDS} seconds. "
                                "Try a narrower request and rerun."
                            )
                        },
                    }
                )
            except Exception as e:
                error_detail = str(e).strip() or type(e).__name__
                await queue.put({"type": "error", "data": {"error": f"Agent error: {error_detail}"}})
            finally:
                _mark_agent_run_finished()
                await queue.put(None)

        async def keepalive():
            MAX_KEEPALIVE_DURATION = AGENT_RUN_TIMEOUT_SECONDS + 30
            elapsed = 0
            while elapsed < MAX_KEEPALIVE_DURATION:
                await asyncio.sleep(10)
                elapsed += 10
                await queue.put({"__keepalive__": True})

        async def watch_client_disconnect(
            run_task: asyncio.Task,
            keepalive: asyncio.Task,
        ) -> None:
            """If the client closes the SSE connection, cancel the agent run (avoids orphaned work)."""
            try:
                while True:
                    await asyncio.sleep(1.5)
                    try:
                        if await http_request.is_disconnected():
                            logger.info("SSE client disconnected; cancelling agent run")
                            break
                    except Exception:
                        logger.info("SSE disconnect watcher exiting (request channel closed)")
                        break
            except asyncio.CancelledError:
                return

            if not keepalive.done():
                keepalive.cancel()
            if not run_task.done():
                run_task.cancel()
            try:
                queue.put_nowait(None)
            except Exception:
                pass

        global _current_run_task
        task = asyncio.create_task(run_task())
        _current_run_task = task
        keepalive_task = asyncio.create_task(keepalive())
        disconnect_task = asyncio.create_task(watch_client_disconnect(task, keepalive_task))

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
        except (asyncio.CancelledError, GeneratorExit, ConnectionError, BrokenPipeError):
            logger.info("SSE client disconnected")
        except Exception as exc:
            logger.warning("Unexpected error in SSE generator: %s", exc)
        finally:
            disconnect_task.cancel()
            try:
                await disconnect_task
            except (asyncio.CancelledError, Exception):
                pass
            keepalive_task.cancel()
            if not task.done():
                task.cancel()
            try:
                await asyncio.wait_for(task, timeout=5.0)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
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
