from pydantic import BaseModel
from typing import Optional, List, Dict, Any


class TraceItem(BaseModel):
    id: str
    label: str
    detail: str
    status: str  # 'pending' | 'running' | 'done' | 'error'


class AuthTokens(BaseModel):
    accessToken: str
    expiresAt: int
    refreshToken: Optional[str] = None
    clientId: str
    redirectUrl: str
    scope: str


class AgentRequest(BaseModel):
    prompt: str
    keywords: List[str] = []
    loop: int = 1
    authTokens: Optional[AuthTokens] = None
    projectUrl: Optional[str] = None


class AgentResponse(BaseModel):
    reply: str
    trace: Optional[List[TraceItem]] = None
