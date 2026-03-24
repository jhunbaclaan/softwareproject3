import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenManager } from '../token-manager';

describe('TokenManager', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('getToken returns accessToken if not expired', async () => {
    const manager = new TokenManager({
      accessToken: 'valid-token',
      expiresAt: Date.now() + 100000,
      clientId: 'test-client',
    });

    const token = await manager.getToken();
    expect(token).toBe('valid-token');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('getToken refreshes token if expired', async () => {
    const expiredTime = Date.now() - 10000;
    const manager = new TokenManager({
      accessToken: 'old-token',
      expiresAt: expiredTime,
      refreshToken: 'valid-refresh-token',
      clientId: 'test-client',
    });

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-token',
        expires_in: 3600,
        refresh_token: 'new-refresh-token'
      })
    } as Response);

    const token = await manager.getToken();
    expect(token).toBe('new-token');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(manager.getExpiresAt()).toBeGreaterThan(Date.now());
  });

  it('getToken throws error if expired and no refresh token', async () => {
    const expiredTime = Date.now() - 10000;
    const manager = new TokenManager({
      accessToken: 'old-token',
      expiresAt: expiredTime,
      clientId: 'test-client',
    }); // no refresh_token

    await expect(manager.getToken()).rejects.toThrow('Token expired and no refresh token available');
  });
});
