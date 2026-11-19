// The local-only build smoke (docs/local-only-build.md), on its own.
//
// Self-contained on purpose: the public client export runs it against `out/`
// (`smoke:local`, which sets CANOPY_E2E_OUT_DIR=out), so it does not import
// playwright.config.mjs, whose reporters and global setup live under scripts/
// and need the shared mock server. The spec starts its own mock provider and
// recording proxy. In this repository the launcher defaults to out-e2e/:
// pnpm exec playwright test -c playwright.local-smoke.config.mjs, after
// pnpm run build:e2e.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './apps/desktop-app/tests/electron',
  testMatch: ['**/local-only-smoke.spec.mjs'],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: [
    ['list'],
    [
      'html',
      { open: 'never', outputFolder: 'playwright-report/local-only-smoke' },
    ],
  ],
  outputDir: 'test-results/local-only-smoke',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
