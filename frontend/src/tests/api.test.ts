import { describe, it, expect, vi, beforeEach } from 'vitest';
import { healthCheck, runAgent } from '../api';

const MOCK_BASE_URL = 'http://test-server';

describe('Frontend API wrapper tests', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('healthCheck success', async () => {
    const mockJson = { status: 'ok' };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockJson,
    } as Response);

    const result = await healthCheck(MOCK_BASE_URL);
    expect(result).toEqual(mockJson);
    expect(fetch).toHaveBeenCalledWith(`${MOCK_BASE_URL}/health`);
  });

  it('runAgent success', async () => {
    const mockJson = { reply: 'Hello from agent' };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockJson,
    } as Response);

    const payload = { prompt: 'hi', keywords: [], loop: 1 };
    const result = await runAgent(MOCK_BASE_URL, payload);

    expect(result).toEqual(mockJson);
    expect(fetch).toHaveBeenCalledWith(`${MOCK_BASE_URL}/agent/run`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(payload)
    }));
  });



  it('runAgent includes auth tokens in payload', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ reply: 'ok' }),
    } as Response);

    const payload = {
      prompt: 'test',
      keywords: [],
      loop: 1,
      authTokens: {
        accessToken: 'tok-123',
        expiresAt: 9999999999,
        refreshToken: 'refresh-123',
        clientId: 'client-1',
      },
      projectUrl: 'projects/abc',
    };

    await runAgent(MOCK_BASE_URL, payload);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.authTokens.accessToken).toBe('tok-123');
    expect(body.projectUrl).toBe('projects/abc');
  });

  it('runAgent sends correct LLM provider', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ reply: 'ok' }),
    } as Response);

    const payload = {
      prompt: 'test',
      keywords: [],
      loop: 1,
      llmProvider: 'anthropic' as const,
      llmApiKey: 'sk-ant-123',
    };

    await runAgent(MOCK_BASE_URL, payload);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.llmProvider).toBe('anthropic');
    expect(body.llmApiKey).toBe('sk-ant-123');
  });
  it('runAgent throws on non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 503,
    } as Response);

    await expect(
      runAgent(MOCK_BASE_URL, { prompt: 'test', keywords: [], loop: 1 })
    ).rejects.toThrow('Agent run failed (503)');
  });
});
