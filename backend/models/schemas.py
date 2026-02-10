from pydantic import BaseModel
from typing import Optional, List


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
