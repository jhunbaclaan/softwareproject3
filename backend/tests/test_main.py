import pytest
from httpx import AsyncClient, ASGITransport
from main import app
from unittest.mock import patch, AsyncMock

@pytest.mark.asyncio
async def test_health_check():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}

@pytest.mark.asyncio
async def test_agent_run():
    with patch("main._ensure_client") as mock_ensure, \
         patch("main.run_agent_graph") as mock_run:
        
        mock_ensure.return_value = AsyncMock() 
        mock_run.return_value = "Agent reply"

        request_data = {"prompt": "add synth"}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            response = await ac.post("/agent/run", json=request_data)
        
        assert response.status_code == 200
        assert response.json() == {"reply": "Agent reply", "trace": None}

