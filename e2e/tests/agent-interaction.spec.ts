import { test, expect } from '@playwright/test';

/**
 * Helper: build an SSE response body for mocking /agent/run.
 * The backend now returns Server-Sent Events (text/event-stream).
 */
function sseReply(reply: string): string {
  return `data: ${JSON.stringify({ type: 'reply', data: { reply } })}\n\n`;
}

function sseError(error: string): string {
  return `data: ${JSON.stringify({ type: 'error', data: { error } })}\n\n`;
}

test.describe('Agent Interaction', () => {
  test.beforeEach(async ({ page }) => {
    // Dismiss tutorial
    await page.addInitScript(() => {
      window.localStorage.setItem('tutorial.seen', 'true');
      window.localStorage.setItem('tutorialCompleted', 'true');
    });
  });

  test('sends a message and displays the agent response', async ({ page }) => {
    // Mock the /agent/run endpoint to return an SSE stream
    await page.route('**/agent/run', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseReply('Hello! I am the agent. How can I help you today?'),
      });
    });

    await page.goto('/');

    // Initially the chat area should show the empty state
    await expect(page.locator('.empty')).toBeVisible();
    await expect(page.locator('.empty')).toContainText('Start the conversation by sending a message.');

    // Type a message and send it
    const chatInput = page.getByLabel('Chat message');
    await chatInput.fill('Hello agent');
    await page.getByRole('button', { name: 'Send' }).click();

    // The user message should appear
    const userMessage = page.locator('.message.user').first();
    await expect(userMessage).toBeVisible();
    await expect(userMessage.locator('p')).toHaveText('Hello agent');

    // The agent response should appear
    const assistantMessage = page.locator('.message.assistant').first();
    await expect(assistantMessage).toBeVisible({ timeout: 10000 });
    await expect(assistantMessage.locator('p')).toHaveText(
      'Hello! I am the agent. How can I help you today?'
    );
  });

  test('displays error message when agent call fails', async ({ page }) => {
    // Mock the /agent/run endpoint to return a server error
    await page.route('**/agent/run', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Internal Server Error' }),
      });
    });

    await page.goto('/');

    const chatInput = page.getByLabel('Chat message');
    await chatInput.fill('Trigger an error');
    await page.getByRole('button', { name: 'Send' }).click();

    // The error should appear as an assistant message prefixed with "Error:"
    const assistantMessage = page.locator('.message.assistant').first();
    await expect(assistantMessage).toBeVisible({ timeout: 10000 });
    await expect(assistantMessage.locator('p')).toContainText('Error');
  });

  test('clears chat messages when "Clear chat" is clicked', async ({ page }) => {
    // Mock the /agent/run endpoint
    await page.route('**/agent/run', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseReply('Response from agent.'),
      });
    });

    await page.goto('/');

    // Send a message first
    const chatInput = page.getByLabel('Chat message');
    await chatInput.fill('Test message');
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for the assistant reply to appear
    await expect(page.locator('.message.assistant').first()).toBeVisible({ timeout: 10000 });

    // There should be 2 messages (user + assistant)
    await expect(page.locator('.message')).toHaveCount(2);

    // Click "Clear chat"
    await page.getByRole('button', { name: 'Clear chat' }).click();

    // Messages should be gone, empty state should return
    await expect(page.locator('.message')).toHaveCount(0);
    await expect(page.locator('.empty')).toBeVisible();
  });
});
