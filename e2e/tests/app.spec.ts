import { test, expect } from '@playwright/test';

test.describe('Nexus Agent App', () => {
  test.beforeEach(async ({ page }) => {
    // Dismiss tutorial via localStorage before page loads
    await page.addInitScript(() => {
      window.localStorage.setItem('tutorial.seen', 'true');
      window.localStorage.setItem('tutorialCompleted', 'true');
    });
    await page.goto('/');
  });

  test('loads the app and displays the console sidebar', async ({ page }) => {
    await expect(page.locator('.sidebar-brand .eyebrow')).toHaveText('Nexus Agent');
    await expect(page.locator('.sidebar-brand h1')).toHaveText('Console');
  });

  test('shows login status as "Logged out" by default', async ({ page }) => {
    await expect(page.locator('.status-pill:has-text("Logged out")')).toBeVisible();
  });

  test('displays the chat input with correct placeholder', async ({ page }) => {
    const chatInput = page.getByPlaceholder('Type your message...');
    await expect(chatInput).toBeVisible();
  });

  test('disables the Send button when input is empty', async ({ page }) => {
    const sendBtn = page.getByRole('button', { name: 'Send' });
    await expect(sendBtn).toBeDisabled();
  });

  test('enables the Send button when input has text', async ({ page }) => {
    const chatInput = page.getByPlaceholder('Type your message...');
    await chatInput.fill('Hello');
    const sendBtn = page.getByRole('button', { name: 'Send' });
    await expect(sendBtn).toBeEnabled();
  });

  test('opens settings sidebar when cogwheel is clicked', async ({ page }) => {
    const cogwheel = page.getByRole('button', { name: 'Toggle settings' });
    await cogwheel.click();
    await expect(page.locator('.settings-sidebar')).toBeVisible();
    await expect(page.locator('text=Appearance')).toBeVisible();
  });

  test('shows the New Project button', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'New Project' })).toBeVisible();
  });
});
