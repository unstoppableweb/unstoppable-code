// Core protocol activation through the built Electron app: cold argv waits
// for consent; warm second-instance/open-url adapters route to the existing
// renderer. No live account, workspace, or agent is required.
//
// Limits: E2E bypasses single-instance lock acquisition and OS protocol
// registration. Warm events are emitted into main, not transported by a
// second native process. The hidden-window gate suppresses native raises:
// this does NOT qualify native activation-token transport, compositor focus,
// or minimized-window restoration on Wayland (or any other desktop).
import { expect, test } from '@playwright/test';
import { loadBrand } from '../../../../scripts/brand/load-brand.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const BRAND_SCHEME = loadBrand(
  process.env.CANOPY_BRAND || 'canopy',
).internalName;
const UUID = '2f0c9a1e-4b3d-4f6a-8c2e-1d5b7a9e0c4f';

function emitOpenUrl(electronApp, url) {
  return electronApp.evaluate(({ app }, targetUrl) => {
    let prevented = false;
    app.emit(
      'open-url',
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      targetUrl,
    );
    return prevented;
  }, url);
}

test('cold argv waits for startup consent before opening its destination', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    freshOnboarding: true,
    applicationArgs: [`${BRAND_SCHEME}://settings/privacy`],
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await expect(window.getByTestId('legal-consent-gate')).toBeVisible();
    await expect(window.getByTestId('settings-overlay')).toBeHidden();
    await app.acceptLegalConsent();
    await app.waitForShell();
    await expect(window.getByTestId('settings-tab-privacy')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('warm second-instance routes with modeled minimized state while the real window stays hidden', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  let model;
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    const nativeWindow = await electronApp.browserWindow(window);
    expect(await nativeWindow.evaluate((target) => target.isVisible())).toBe(
      false,
    );

    // Do NOT call minimize(): on macOS minimizing a hidden BrowserWindow can
    // show an OS window. Model only the minimized predicate on the existing
    // real window. The headless gate must leave it hidden and still deliver
    // the destination; no native restore is expected or claimed here.
    model = await nativeWindow.evaluateHandle((target) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, 'isMinimized');
      let shows = 0;
      let restores = 0;
      const onShow = () => {
        shows += 1;
      };
      const onRestore = () => {
        restores += 1;
      };
      target.on('show', onShow);
      target.on('restore', onRestore);
      Object.defineProperty(target, 'isMinimized', {
        configurable: true,
        value: () => true,
      });
      return {
        snapshot: () => ({
          id: target.id,
          visible: target.isVisible(),
          minimized: target.isMinimized(),
          shows,
          restores,
        }),
        cleanup: () => {
          target.removeListener('show', onShow);
          target.removeListener('restore', onRestore);
          if (descriptor)
            Object.defineProperty(target, 'isMinimized', descriptor);
          else delete target.isMinimized;
        },
      };
    });
    const before = await model.evaluate((state) => state.snapshot());
    expect(before).toMatchObject({
      visible: false,
      minimized: true,
      shows: 0,
      restores: 0,
    });
    await electronApp.evaluate(({ app }, url) => {
      app.emit('second-instance', {}, ['app', '--flag', url], process.cwd());
    }, `${BRAND_SCHEME}://remote-control`);
    await expect(window.getByTestId('canopy-portal-modal')).toBeVisible();
    expect(await model.evaluate((state) => state.snapshot())).toEqual(before);
    expect(electronApp.windows()).toHaveLength(1);
  } finally {
    try {
      if (model) {
        await model.evaluate((state) => state.cleanup());
        await model.dispose();
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  }
});

test('warm open-url delivers share and settings destinations to the existing renderer', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    expect(
      await emitOpenUrl(electronApp, `${BRAND_SCHEME}://share/skills/${UUID}`),
    ).toBe(true);
    // Assert the parsed destination at the existing navigation-store probe;
    // resolving/installing a public share over the network is outside scope.
    await expect
      .poll(() =>
        window.evaluate(
          () =>
            window.__canopyNavigationTestApi?.getPendingShareInstall() ?? null,
        ),
      )
      .toEqual({ entity: 'skill', externalId: UUID, intent: 'install' });
    expect(
      await emitOpenUrl(electronApp, `${BRAND_SCHEME}://settings/privacy`),
    ).toBe(true);
    await expect(window.getByTestId('settings-tab-privacy')).toBeVisible();
    const nativeWindow = await electronApp.browserWindow(window);
    expect(await nativeWindow.evaluate((target) => target.isVisible())).toBe(
      false,
    );
    expect(electronApp.windows()).toHaveLength(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
