from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import asyncio
import os
from agents.mcp_client_new import MCPClient

app = FastAPI()

# Define request/response models matching frontend expectations
class TraceItem(BaseModel):
    id: str
    label: str
    detail: str
    status: str  # 'pending' | 'running' | 'done' | 'error'

class AgentRequest(BaseModel):
    prompt: str
    keywords: List[str] = []
    loop: int = 1

class AgentResponse(BaseModel):
    reply: str
    trace: Optional[List[TraceItem]] = None

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
        request: AgentRequest with prompt, keywords, and loop count
        
    Returns:
        AgentResponse with the agent's reply and optional trace data
    """
    try:
        # Get the MCP server script path from environment or use default
        # Resolves to ../mcp-server/server.ts relative to this file's location
        if mcp_server_path := os.getenv("MCP_SERVER_PATH"):
            pass  # Use environment variable if set
        else:
            # Default path: go up from backend folder to root, then into mcp-server
            backend_dir = os.path.dirname(__file__)
            mcp_server_path = os.path.join(backend_dir, "..", "mcp-server", "server.ts")
        
        # Create and initialize the MCP client
        client = MCPClient()
        await client.connect_to_server(mcp_server_path)
        
        # Process the user's query through Gemini with MCP tools
        reply = await client.process_query(request.prompt)
        
        # Clean up MCP client resources
        await client.cleanup()
        
        # Return the response in the format the frontend expects
        return AgentResponse(reply=reply, trace=None)
        
    except Exception as e:
        # Return error message if something goes wrong
        error_msg = f"Agent error: {str(e)}"
        return AgentResponse(reply=error_msg, trace=None)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
