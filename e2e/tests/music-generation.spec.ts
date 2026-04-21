import { test, expect } from '@playwright/test';

function sseReplyWithMusic(reply: string, music: { audio_base64: string; prompt: string; format?: string; music_length_ms?: number }): string {
  return `data: ${JSON.stringify({
    type: 'reply',
    data: { reply, generated_music: { format: 'mp3', music_length_ms: 15000, ...music } },
  })}\n\n`;
}

function sseError(error: string): string {
  return `data: ${JSON.stringify({ type: 'error', data: { error } })}\n\n`;
}

const FAKE_AUDIO_BASE64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

test.describe('Music Generation', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('tutorial.seen', 'true');
      window.localStorage.setItem('tutorialCompleted', 'true');
    });
  });

  test('generates music and shows audio player on success', async ({ page }) => {
    await page.route('**/agent/run', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseReplyWithMusic('Here is the music you requested!', {
          audio_base64: FAKE_AUDIO_BASE64,
          prompt: 'Upbeat jazz with piano',
        }),
      });
    });

    await page.goto('/');

    const chatInput = page.getByLabel('Chat message');
    await chatInput.fill('Generate upbeat jazz with piano');
    await page.getByRole('button', { name: 'Send' }).click();

    const audioElement = page.locator('.music-player audio');
    await expect(audioElement).toBeVisible({ timeout: 15000 });

    const src = await audioElement.getAttribute('src');
    expect(src).toBeTruthy();
    expect(src).toContain('blob:');

    await expect(page.locator('.music-daw-status')).toBeVisible();
    await expect(page.locator('.music-daw-status')).toContainText('Connect an Audiotool project');
  });

  test('displays error when agent returns an error event', async ({ page }) => {
    await page.route('**/agent/run', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseError('Music generation failed: Invalid prompt'),
      });
    });

    await page.goto('/');

    const chatInput = page.getByLabel('Chat message');
    await chatInput.fill('Generate some music');
    await page.getByRole('button', { name: 'Send' }).click();

    const assistantMessage = page.locator('.message.assistant').first();
    await expect(assistantMessage).toBeVisible({ timeout: 10000 });
    await expect(assistantMessage.locator('p')).toContainText('Music generation failed');
  });

  test('audio preview element has controls attribute', async ({ page }) => {
    await page.route('**/agent/run', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseReplyWithMusic('Here are some chill lo-fi beats!', {
          audio_base64: FAKE_AUDIO_BASE64,
          prompt: 'Chill lo-fi beats',
        }),
      });
    });

    await page.goto('/');

    const chatInput = page.getByLabel('Chat message');
    await chatInput.fill('Chill lo-fi beats');
    await page.getByRole('button', { name: 'Send' }).click();

    const audioElement = page.locator('.music-player audio');
    await expect(audioElement).toBeVisible({ timeout: 15000 });

    await expect(audioElement).toHaveAttribute('controls', '');
  });
});
