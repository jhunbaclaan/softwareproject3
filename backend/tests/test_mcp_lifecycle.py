import asyncio

import pytest

import main


@pytest.mark.asyncio
async def test_cleanup_runs_in_calling_task():
    """Cleanup should execute on the caller task (needed by anyio cancel scopes)."""

    caller_task = asyncio.current_task()

    class TaskAffinedClient:
        async def cleanup(self):
            assert asyncio.current_task() is caller_task

    await main._cleanup_client_with_timeout(
        TaskAffinedClient(),
        "Task-affined cleanup",
        timeout_seconds=1.0,
    )


def test_remote_persistence_is_opt_in(monkeypatch):
    monkeypatch.setenv("MCP_CLIENT_PERSIST", "1")
    monkeypatch.setenv("MCP_SERVER_URL", "https://example.com/mcp")
    monkeypatch.delenv("MCP_REMOTE_CLIENT_PERSIST", raising=False)

    assert main._persist_mcp_client() is False


def test_remote_persistence_can_be_enabled(monkeypatch):
    monkeypatch.setenv("MCP_CLIENT_PERSIST", "1")
    monkeypatch.setenv("MCP_SERVER_URL", "https://example.com/mcp")
    monkeypatch.setenv("MCP_REMOTE_CLIENT_PERSIST", "1")

    assert main._persist_mcp_client() is True


def test_local_persistence_stays_enabled(monkeypatch):
    monkeypatch.setenv("MCP_CLIENT_PERSIST", "1")
    monkeypatch.delenv("MCP_SERVER_URL", raising=False)
    monkeypatch.setenv("MCP_SERVER_PATH", "mcp-server/dist/server.js")

    assert main._persist_mcp_client() is True
