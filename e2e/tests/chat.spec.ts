import { test, expect } from '@playwright/test';

test.describe('Nexus Agent Chat Interface', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('tutorial.seen', 'true');
      window.localStorage.setItem('tutorialCompleted', 'true');
    });
  });

  test('should allow user to enter an agent prompt', async ({ page }) => {
    // Mock the /agent/run SSE endpoint
    await page.route('**/agent/run', async route => {
      const sseBody = `data: ${JSON.stringify({ type: 'reply', data: { reply: 'I am a simulated agent response.' } })}\n\n`;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseBody,
      });
    });

    await page.goto('/');

    // Look for the main chat interface
    const chatInput = page.getByLabel('Chat message');
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
