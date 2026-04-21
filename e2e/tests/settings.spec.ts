import { test, expect } from '@playwright/test';

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    // Dismiss tutorial
    await page.addInitScript(() => {
      window.localStorage.setItem('tutorial.seen', 'true');
      window.localStorage.setItem('tutorialCompleted', 'true');
    });
  });

  /**
   * Helper to open the settings sidebar.
   */
  async function openSettings(page: import('@playwright/test').Page) {
    await page.goto('/');
    const cogwheel = page.getByRole('button', { name: 'Toggle settings' });
    await cogwheel.click();
    // Wait for the settings sidebar to appear
    await expect(page.locator('.settings-sidebar')).toBeVisible();
  }

  test('dark mode toggle sets data-theme attribute on document', async ({ page }) => {
    await openSettings(page);

    // Find the Dark Mode toggle switch
    const darkModeSwitch = page.locator('.setting-item').filter({ hasText: 'Dark Mode' }).getByRole('switch');
    await expect(darkModeSwitch).toBeVisible();

    // Initially dark mode should be off
    await expect(darkModeSwitch).toHaveAttribute('aria-checked', 'false');

    // The document root should NOT have data-theme="dark"
    const htmlElement = page.locator('html');
    await expect(htmlElement).not.toHaveAttribute('data-theme', 'dark');

    // Toggle dark mode ON
    await darkModeSwitch.click();

    // Now the document root should have data-theme="dark"
    await expect(htmlElement).toHaveAttribute('data-theme', 'dark');
    await expect(darkModeSwitch).toHaveAttribute('aria-checked', 'true');

    // Toggle dark mode OFF
    await darkModeSwitch.click();
    await expect(htmlElement).not.toHaveAttribute('data-theme', 'dark');
    await expect(darkModeSwitch).toHaveAttribute('aria-checked', 'false');
  });

  test('LLM provider can be changed via dropdown', async ({ page }) => {
    await openSettings(page);

    // Find the LLM provider dropdown
    const providerSelect = page.getByLabel('LLM provider', { exact: true });
    await expect(providerSelect).toBeVisible();

    // Default should be "gemini"
    await expect(providerSelect).toHaveValue('gemini');

    // Change to Anthropic
    await providerSelect.selectOption('anthropic');
    await expect(providerSelect).toHaveValue('anthropic');

    // Verify the value was saved to localStorage
    const storedProvider = await page.evaluate(() =>
      window.localStorage.getItem('llm.provider')
    );
    expect(storedProvider).toBe('anthropic');

    // Change to OpenAI
    await providerSelect.selectOption('openai');
    await expect(providerSelect).toHaveValue('openai');

    const storedProvider2 = await page.evaluate(() =>
      window.localStorage.getItem('llm.provider')
    );
    expect(storedProvider2).toBe('openai');
  });

  test('settings persist across page reload', async ({ page }) => {
    await openSettings(page);

    // Enable dark mode
    const darkModeSwitch = page.locator('.setting-item').filter({ hasText: 'Dark Mode' }).getByRole('switch');
    await darkModeSwitch.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // Change LLM provider to anthropic
    const providerSelect = page.getByLabel('LLM provider', { exact: true });
    await providerSelect.selectOption('anthropic');

    // Verify localStorage was updated
    const darkModeStored = await page.evaluate(() =>
      window.localStorage.getItem('darkMode')
    );
    expect(darkModeStored).toBe('true');

    const providerStored = await page.evaluate(() =>
      window.localStorage.getItem('llm.provider')
    );
    expect(providerStored).toBe('anthropic');

    // Reload the page
    await page.reload();

    // Dark mode should still be active after reload
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // Open settings again to verify provider persisted
    const cogwheel = page.getByRole('button', { name: 'Toggle settings' });
    await cogwheel.click();
    await expect(page.locator('.settings-sidebar')).toBeVisible();

    const providerAfterReload = page.getByLabel('LLM provider', { exact: true });
    await expect(providerAfterReload).toHaveValue('anthropic');
  });
});
