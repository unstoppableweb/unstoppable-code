import { expect } from '@playwright/test';
import { STRESS_TRANSCRIPT } from './stress-transcript-fixture.mjs';

export async function openStressEntry(page) {
  const toggle = page.getByTestId(
    'sidebar-cowork-project-cowork-default-toggle',
  );
  // Default's header is omitted when it is the only workspace.
  if (await toggle.isVisible()) {
    if ((await toggle.getAttribute('aria-expanded')) !== 'true')
      await toggle.click();
  }
  await page
    .getByTestId(`sidebar-work-entry-${STRESS_TRANSCRIPT.entryId}`)
    .click();
  await expect(
    page.getByTestId(`panel-tab-panel-chat-${STRESS_TRANSCRIPT.leanId}`),
  ).toBeVisible({ timeout: 30_000 });
}

export async function openStressChat(page, turns = 25) {
  await page
    .getByTestId(`panel-tab-panel-chat-${STRESS_TRANSCRIPT.chatId}`)
    .click();
  await expect(
    page.getByRole('heading', {
      name: `Stress final report ${turns}`,
      exact: true,
    }),
  ).toBeAttached({ timeout: 30_000 });
  const prompt = page.locator(
    `[data-sticky-user-message-id="stress-${turns - 1}-prompt"]`,
  );
  await expect(prompt).toBeVisible();
  // Completed turns open collapsed and render their visible final answer
  // atomically. Progressive work begins only when history is explicitly
  // expanded and is awaited by `inspectStressHistory` below.
  const viewport = page.getByTestId('chat-message-list-scroll').last();
  await viewport.evaluate(
    (el) =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  return viewport;
}

export async function inspectStressHistory(page, { lastBatch = 159 } = {}) {
  const viewport = page.getByTestId('chat-message-list-scroll').last();
  const first = page.locator('[data-chat-turn-group="stress-0-prompt"]');
  // A turn heading its section renders its header in the pinned head,
  // outside its own wrapper; builds before that keep it in the wrapper.
  // Comparisons run this driver against both.
  const summary = page
    .locator(
      '[data-sticky-user-message-id="stress-0-prompt"], [data-chat-turn-group="stress-0-prompt"]',
    )
    .getByRole('button', { name: /^Agent steps:/ });
  await expect
    .poll(
      async () => {
        await viewport.hover();
        await page.mouse.wheel(0, -10_000_000);
        return summary.isVisible();
      },
      // A scrolling journey must not acquire exponential assertion think time.
      { timeout: 15_000, intervals: [100] },
    )
    .toBe(true);
  await expect(
    first.getByText('Stress progress 1/0:', { exact: false }),
  ).toHaveCount(0);
  const label = await summary.getAttribute('aria-label');
  await summary.click();
  await expect
    .poll(
      async () => {
        await viewport.hover();
        await page.mouse.wheel(0, -20_000);
        return first
          .getByText('Stress progress 1/0:', { exact: false })
          .count();
      },
      { timeout: 15_000, intervals: [100] },
    )
    .toBe(1);
  // The inspection milestone includes the complete loaded page, not merely
  // its first row. This keeps progressive rendering/windowing experiments
  // honest: deferred work must finish before the task is considered complete.
  // Watch the mounted row directly: assertion polling can add a full second
  // after attachment and contaminate the whole-journey liveness measurement.
  await first
    .getByText(`Stress progress 1/${lastBatch}:`, { exact: false })
    .waitFor({ state: 'attached', timeout: 15_000 });
  const progressiveMarkdown = first
    .locator('[data-progressive-markdown-complete]')
    .last();
  if ((await progressiveMarkdown.count()) > 0) {
    await expect
      .poll(
        () =>
          progressiveMarkdown.getAttribute(
            'data-progressive-markdown-complete',
          ),
        { timeout: 15_000, intervals: [100] },
      )
      .toBe('true');
  }
  await expect(summary).toHaveAttribute('aria-label', label);
  await expect(
    page.getByRole('button', { name: 'Load earlier messages' }),
  ).toHaveCount(0);
  await summary.click();
  await expect(
    first.getByText('Stress progress 1/0:', { exact: false }),
  ).toHaveCount(0);
}
