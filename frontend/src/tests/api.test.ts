import { describe, it, expect, vi, beforeEach } from 'vitest';
import { healthCheck, runAgent, generateMusic } from '../api';

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

  it('generateMusic error handling', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ detail: 'API Error text' })
    } as Response);

    await expect(generateMusic(MOCK_BASE_URL, { prompt: 'abc' })).rejects.toThrow('API Error text');
  });
});
