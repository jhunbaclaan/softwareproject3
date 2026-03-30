from pydantic import BaseModel
from typing import Optional, List, Dict, Any, Literal


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


class ConversationMessage(BaseModel):
    role: str  # "user" | "model"
    content: str


class AgentRequest(BaseModel):
    prompt: str
    keywords: List[str] = []
    loop: int = 1
    authTokens: Optional[AuthTokens] = None
    projectUrl: Optional[str] = None
    messages: Optional[List[ConversationMessage]] = None
    llmProvider: Literal["gemini", "anthropic", "openai"] = "gemini"
    llmApiKey: Optional[str] = None
    elevenlabsApiKey: Optional[str] = None


class GeneratedMusicAttachment(BaseModel):
    """Populated when the agent used ElevenLabs music generation in this turn."""

    audio_base64: str
    format: str
    prompt: str
    music_length_ms: Optional[int] = None


class AgentResponse(BaseModel):
    reply: str
    trace: Optional[List[TraceItem]] = None
    generated_music: Optional[GeneratedMusicAttachment] = None
