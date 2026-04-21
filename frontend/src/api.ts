export type HealthStatus = { status: string };

export type AuthTokens = {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
  clientId: string;
};

export type ConversationMessage = {
  role: 'user' | 'model';
  content: string;
};

export type LLMProvider = 'gemini' | 'anthropic' | 'openai';

export type DawContext = {
  tempoBpm?: number;
  timeSignature?: string;
  instruments?: string[];
  trackCount?: number;
};

export type AgentRequest = {
  prompt: string;
  keywords: string[];
  loop: number;
  authTokens?: AuthTokens;
  projectUrl?: string;
  messages?: ConversationMessage[];
  llmProvider?: LLMProvider;
  llmApiKey?: string;
  elevenlabsApiKey?: string;
  dawContext?: DawContext;
};

export type GeneratedMusicPayload = {
  audio_base64: string;
  format: string;
  prompt: string;
  music_length_ms?: number;
};

export type TraceItem = {
  id: string;
  label: string;
  detail: string;
  status: 'pending' | 'running' | 'done' | 'error';
};

export type AgentResponse = {
  reply: string;
  trace?: TraceItem[];
  generated_music?: GeneratedMusicPayload | null;
};

const readEnv = (value: string | undefined) => (value && value.trim() ? value.trim() : undefined);

const envBaseUrl = readEnv(import.meta.env.VITE_API_BASE_URL);

const inferBaseUrlFromWindow = () => {
  if (typeof window === 'undefined') {
    return 'http://127.0.0.1:8000';
  }

  const host = window.location.hostname;
  if (host === '127.0.0.1' || host === 'localhost') {
    return 'http://127.0.0.1:8000';
  }

  return window.location.origin;
};

const defaultBaseUrl = envBaseUrl ?? inferBaseUrlFromWindow();

export const getApiBaseUrl = () => defaultBaseUrl;

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

export type RunAgentStreamOptions = {
  signal?: AbortSignal;
};

export async function cancelAgentRun(baseUrl: string): Promise<void> {
  await fetch(`${baseUrl}/agent/cancel`, { method: 'POST' });
}

export async function runAgentStream(
  baseUrl: string,
  payload: AgentRequest,
  onEvent: (event: any) => void | Promise<void>,
  options?: RunAgentStreamOptions,
): Promise<void> {
  const res = await fetch(`${baseUrl}/agent/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: options?.signal,
  });

  if (!res.ok) {
    throw new Error(`Agent run failed (${res.status})`);
  }

  if (!res.body) throw new Error('No response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const dataStr = line.slice(6);
        try {
          const event = JSON.parse(dataStr);
          await onEvent(event);
        } catch (e) {
          if (e instanceof SyntaxError) {
            console.error('Failed to parse SSE JSON:', dataStr);
          } else {
            console.error('Error in SSE event handler:', e);
          }
        }
      }
    }
  }
}
