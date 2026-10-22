import { expect, test } from '@playwright/test';

test.describe('renderer shell in Chromium', () => {
  test.describe('dark system preference', () => {
    test.use({ colorScheme: 'dark' });

    test('loads the shell on the dark theme', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Telecomway' })).toBeVisible();
      await expect(page.getByTestId('call-screen-placeholder')).toContainText('Sin llamada activa');
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(11, 18, 32)');
    });
  });

  test.describe('light system preference', () => {
    test.use({ colorScheme: 'light' });

    test('follows prefers-color-scheme', async ({ page }) => {
      await page.goto('/');
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(244, 246, 251)');
    });
  });

  test('has no horizontal scroll at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto('/');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
