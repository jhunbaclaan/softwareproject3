import { test, expect } from '@playwright/test';

test.describe('Nexus Agent Chat Interface', () => {
  // @ts-ignore
  test('should allow user to enter an agent prompt', async ({ page }) => {
    // Note: To successfully run this locally, backend and frontend must be running.
    // We are testing whether the DOM updates when we attempt to interact.
    
    // Catch fetch to prevent real API calls from breaking the test
    // @ts-ignore
    await page.route('**/agent/run', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ reply: 'I am a simulated agent response.' }),
      });
    });

    await page.goto('/');

    // Look for the main chat interface
    const chatInput = page.getByRole('textbox', { name: 'Chat message' });
    await expect(chatInput).toBeVisible();

    // Type a message
    await chatInput.fill('Please add a drum beat.');
    
    // Press Enter to submit
    await chatInput.press('Enter');

    // Wait for the mock response to appear in the DOM
    const responseBox = page.locator('text=I am a simulated agent response.');
    await expect(responseBox).toBeVisible({ timeout: 5000 });
  });
});
