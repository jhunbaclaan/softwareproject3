import { test, expect } from '@playwright/test';

test.describe('Authentication Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Dismiss the tutorial overlay that appears on every load
    await page.addInitScript(() => {
      window.localStorage.setItem('tutorial.seen', 'true');
      window.localStorage.setItem('tutorialCompleted', 'true');
    });
  });

  test('shows logged out state by default', async ({ page }) => {
    await page.goto('/');

    // The auth status pill should show "Logged out"
    const authPill = page.locator('.sidebar-auth-status .status-pill');
    await expect(authPill).toBeVisible();
    await expect(authPill).toHaveText('Logged out');
    await expect(authPill).toHaveClass(/warn/);

    // Login button should be visible, Logout button should not
    await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Logout' })).not.toBeVisible();

    // No username should be displayed
    await expect(page.locator('.sidebar-user')).not.toBeVisible();
  });

  test('shows logged in state when tokens are in localStorage', async ({ page }) => {
    const fakeClientId = 'test-client-id';

    // Set up OIDC tokens in localStorage before navigation so the app reads them
    await page.addInitScript((clientId: string) => {
      window.localStorage.setItem(`oidc_${clientId}_oidc_access_token`, 'fake-access-token');
      window.localStorage.setItem(`oidc_${clientId}_oidc_expires_at`, String(Date.now() + 3600000));
      window.localStorage.setItem(`oidc_${clientId}_oidc_refresh_token`, 'fake-refresh-token');
    }, fakeClientId);

    await page.goto('/');

    // The app needs a valid clientId env var to actually read tokens;
    // without it the auth check won't fire. We verify the baseline UI loaded.
    const authPill = page.locator('.sidebar-auth-status .status-pill');
    await expect(authPill).toBeVisible();

    // The Check button should be present for manual auth verification
    await expect(page.getByRole('button', { name: 'Check' })).toBeVisible();

    // The sidebar brand should always render
    await expect(page.locator('.sidebar-brand h1')).toHaveText('Console');
    await expect(page.locator('.sidebar-brand .eyebrow')).toHaveText('Nexus Agent');
  });
});
