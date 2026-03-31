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

  it('should deduplicate simultaneous refresh requests', async () => {
    const expiredTime = Date.now() - 10000;
    const manager = new TokenManager({
      accessToken: 'old-token',
      expiresAt: expiredTime,
      refreshToken: 'refresh-token',
      clientId: 'test-client',
    });

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-token',
        expires_in: 3600,
      })
    } as Response);

    // Launch two concurrent getToken calls
    const [token1, token2] = await Promise.all([
      manager.getToken(),
      manager.getToken(),
    ]);

    expect(token1).toBe('new-token');
    expect(token2).toBe('new-token');
    // fetch should only be called ONCE due to dedup
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should handle OAuth error response from refresh', async () => {
    const manager = new TokenManager({
      accessToken: 'old-token',
      expiresAt: Date.now() - 10000,
      refreshToken: 'bad-refresh',
      clientId: 'test-client',
    });

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        error: 'invalid_grant',
        error_description: 'Refresh token has been revoked',
      })
    } as Response);

    await expect(manager.getToken()).rejects.toThrow('OAuth error: Refresh token has been revoked');
  });

  it('should trigger refresh at the expiry buffer boundary (60s)', async () => {
    // Token expires in exactly 60 seconds (the buffer), so it should refresh
    const manager = new TokenManager({
      accessToken: 'edge-token',
      expiresAt: Date.now() + 60000, // exactly at buffer
      refreshToken: 'refresh-token',
      clientId: 'test-client',
    });

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'refreshed-token',
        expires_in: 7200,
      })
    } as Response);

    const token = await manager.getToken();
    // Should have refreshed because Date.now() >= expiresAt - 60000
    expect(token).toBe('refreshed-token');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should update expiresAt correctly after refresh', async () => {
    const manager = new TokenManager({
      accessToken: 'old-token',
      expiresAt: Date.now() - 10000,
      refreshToken: 'refresh-token',
      clientId: 'test-client',
    });

    const beforeRefresh = Date.now();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-token',
        expires_in: 7200, // 2 hours
      })
    } as Response);

    await manager.getToken();
    const afterRefresh = Date.now();

    // expiresAt should be approximately now + 7200 seconds
    const expiresAt = manager.getExpiresAt();
    expect(expiresAt).toBeGreaterThanOrEqual(beforeRefresh + 7200 * 1000 - 100);
    expect(expiresAt).toBeLessThanOrEqual(afterRefresh + 7200 * 1000 + 100);
  });

  it('should use rotated refresh token for subsequent refreshes', async () => {
    const manager = new TokenManager({
      accessToken: 'old-token',
      expiresAt: Date.now() - 10000,
      refreshToken: 'original-refresh',
      clientId: 'test-client',
    });

    // First refresh returns a rotated refresh_token
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token-1',
          expires_in: 1, // expires almost immediately (1 second)
          refresh_token: 'rotated-refresh',
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'token-2',
          expires_in: 7200,
        })
      } as Response);

    // First call uses original-refresh
    await manager.getToken();

    // Wait a tiny bit for the token to "expire" (expiresAt = now + 1000, buffer = 60000, so already expired)
    const token2 = await manager.getToken();
    expect(token2).toBe('token-2');

    // Second fetch should have used rotated-refresh
    const secondCallBody = vi.mocked(fetch).mock.calls[1][1]?.body as URLSearchParams;
    expect(secondCallBody.get('refresh_token')).toBe('rotated-refresh');
  });

  it('should throw on HTTP error from token endpoint', async () => {
    const manager = new TokenManager({
      accessToken: 'old-token',
      expiresAt: Date.now() - 10000,
      refreshToken: 'refresh-token',
      clientId: 'test-client',
    });

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as Response);

    await expect(manager.getToken()).rejects.toThrow('Token refresh request failed: 500 Internal Server Error');
  });

  it('isValid returns true when token is not expired', () => {
    const manager = new TokenManager({
      accessToken: 'valid-token',
      expiresAt: Date.now() + 200000,
      clientId: 'test-client',
    });
    expect(manager.isValid()).toBe(true);
  });

  it('isValid returns false when token is within expiry buffer', () => {
    const manager = new TokenManager({
      accessToken: 'valid-token',
      expiresAt: Date.now() + 30000, // 30s left, but buffer is 60s
      clientId: 'test-client',
    });
    expect(manager.isValid()).toBe(false);
  });
});
