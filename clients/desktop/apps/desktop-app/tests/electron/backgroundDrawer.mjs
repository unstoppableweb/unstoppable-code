import { expect } from '@playwright/test';

/**
 * Opens the Running card of the composer's work pills in `panel` and returns
 * the pills block. The card lists the chat's background agents, tasks and
 * live runs, with their Stop and Stop all (background drawer D2).
 */
export async function openBackgroundDrawer(panel, { timeout = 30_000 } = {}) {
  const tray = panel.getByTestId('composer-work-drawer');
  await expect(tray).toBeVisible({ timeout });
  const pill = tray.locator(
    '[data-testid="composer-work-pill"][data-work-kind="running"]',
  );
  if ((await pill.getAttribute('aria-expanded')) !== 'true') await pill.click();
  await expect(pill).toHaveAttribute('aria-expanded', 'true');
  return tray;
}

/** Running job indicators move, and remain still under reduced motion. */
export async function expectDrawerSpinnerMotion(page, scope) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const spinner = scope
    .getByTestId('dag-progress-dots')
    .locator('[data-spinner="comet"]')
    .first();
  await spinner.scrollIntoViewIfNeeded();
  const currentTime = () =>
    spinner.evaluate((element) => {
      const animation = element
        .getAnimations({ subtree: true })
        .find((entry) => entry.playState === 'running');
      return typeof animation?.currentTime === 'number'
        ? animation.currentTime
        : 0;
    });
  const start = await currentTime();
  await expect.poll(currentTime).toBeGreaterThan(start + 20);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(() =>
      spinner.evaluate((element) =>
        element
          .getAnimations({ subtree: true })
          .some((entry) => entry.playState === 'running'),
      ),
    )
    .toBe(false);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}
