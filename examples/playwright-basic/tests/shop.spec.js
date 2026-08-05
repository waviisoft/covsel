import { expect, test } from './fixtures.js';

test('adds an item to the cart', async ({ page }) => {
  await page.goto('/');
  await page.click('#cart');
  await expect(page.locator('#out')).toHaveText('[cart] added');
});

test('shows the profile', async ({ page }) => {
  await page.goto('/');
  await page.click('#profile');
  await expect(page.locator('#out')).toHaveText('[profile] shown');
});
