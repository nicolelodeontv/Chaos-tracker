import { expect, test } from '@playwright/test';

const mode = process.env.MOCK_DATA_MODE === 'populated' ? 'populated' : 'empty';

async function openHome(page) {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const response = await page.goto('/', { waitUntil: 'networkidle' });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: '24-hour forecast accuracy' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Forecast trends & reliability' })).toBeVisible();
  return pageErrors;
}

test('desktop dashboard renders the expected fixture state', async ({ page }) => {
  const pageErrors = await openHome(page);
  const accuracy = page.locator('section[aria-label="Forecast accuracy tracker"]');
  const reliability = page.locator('section[aria-label="Forecast trend and clan reliability"]');

  const desktopColumns = await accuracy.locator('.forecast-metrics').evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns.split(/\s+/).length,
  );
  expect(desktopColumns).toBe(3);

  if (mode === 'empty') {
    await expect(accuracy).toContainText('Accuracy results will appear after the first 24-hour forecasts reach their target time.');
    await expect(accuracy).toContainText('No clan has enough same-season history for a forecast yet.');
    await expect(reliability).toContainText('Daily accuracy history will appear after forecasts have been scored on at least one day.');
    await expect(reliability).toContainText('No clan has five scored forecasts yet.');
    await expect(page.locator('.forecast-table-wrap')).toHaveCount(0);
  } else {
    await expect(accuracy).toContainText('38.5 rep');
    await expect(accuracy).toContainText('81.8%');
    await expect(accuracy).toContainText('11');
    await expect(accuracy.locator('table tbody tr')).toHaveCount(2);
    await expect(reliability.locator('svg[role="img"]')).toBeVisible();
    await expect(reliability.locator('.forecast-trend-table tbody tr')).toHaveCount(2);
    const leaderboard = reliability.locator('.forecast-reliability-table');
    await expect(leaderboard).toContainText('Alpha');
    await expect(leaderboard).toContainText('Beta');
    await expect(leaderboard).not.toContainText('Zero Wing');
    await expect(reliability).toContainText('1 clan(s) are still building the minimum five-forecast sample.');
    await expect(page.locator('.forecast-table-wrap')).toHaveCount(3);
  }

  expect(pageErrors).toEqual([]);
});

test('mobile dashboard fits the viewport and keeps tables scrollable', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  const pageErrors = await openHome(page);
  const accuracy = page.locator('section[aria-label="Forecast accuracy tracker"]');

  const mobileColumns = await accuracy.locator('.forecast-metrics').evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns.split(/\s+/).length,
  );
  expect(mobileColumns).toBe(2);

  const pageWidth = await page.locator('html').evaluate((element) => element.scrollWidth);
  expect(pageWidth).toBeLessThanOrEqual(360);

  if (mode === 'empty') {
    await expect(page.locator('.forecast-table-wrap')).toHaveCount(0);
  } else {
    const wrappers = page.locator('.forecast-table-wrap');
    await expect(wrappers).toHaveCount(3);
    const firstWrapper = wrappers.first();
    const dimensions = await firstWrapper.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);

    const scrollLeft = await firstWrapper.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      return element.scrollLeft;
    });
    expect(scrollLeft).toBeGreaterThan(0);
  }

  expect(pageErrors).toEqual([]);
});

test('ranking disclosure and Rep/sec popup work with populated data', async ({ page }) => {
  test.skip(mode !== 'populated', 'Requires the populated isolated fixture.');

  const pageErrors = await openHome(page);
  const disclosure = page.locator('details').filter({ hasText: 'No reputation yet' });
  await expect(disclosure).toHaveCount(1);
  await disclosure.locator('summary').click();
  await expect(disclosure).toHaveAttribute('open', '');
  await expect(disclosure).toContainText('Zero Wing');
  await disclosure.locator('summary').click();
  await expect(disclosure).not.toHaveAttribute('open');

  const trigger = page.getByRole('button', { name: 'Rep/sec' }).first();
  await expect(trigger).toBeVisible();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Reputation gain rate for Alpha' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Recent interval');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  expect(pageErrors).toEqual([]);
});
