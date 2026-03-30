export type HealthStatus = { status: string };

export type AuthTokens = {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  clientId: string;
  redirectUrl: string;
  scope: string;
};

export type ConversationMessage = {
  role: 'user' | 'model';
  content: string;
};

export type LLMProvider = 'gemini' | 'anthropic' | 'openai';

export type AgentRequest = {
  prompt: string;
  keywords: string[];
  loop: number;
  authTokens?: AuthTokens;
  projectUrl?: string;
  messages?: ConversationMessage[];
  llmProvider?: LLMProvider;
  llmApiKey?: string;
  /** Used when the agent calls ElevenLabs music generation */
  elevenlabsApiKey?: string;
};

export type GeneratedMusicPayload = {
  audio_base64: string;
  format: string;
  prompt: string;
  music_length_ms?: number;
};

export type AgentResponse = {
  reply: string;
  trace?: Array<{ id: string; label: string; detail: string; status: 'pending' | 'running' | 'done' | 'error' }>;
  generated_music?: GeneratedMusicPayload | null;
};

const defaultBaseUrl = 'http://127.0.0.1:8000';

export async function healthCheck(baseUrl = defaultBaseUrl): Promise<HealthStatus> {
  const res = await fetch(`${baseUrl}/health`);
  if (!res.ok) {
    throw new Error(`Health check failed (${res.status})`);
  }
  return res.json();
}

export async function runAgent(baseUrl: string, payload: AgentRequest): Promise<AgentResponse> {
  const res = await fetch(`${baseUrl}/agent/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Agent run failed (${res.status})`);
  }

  return res.json();
}

