import { expect, test } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSupervisionServices } from '../../../../packages/core-platform/src/supervision/index.ts';
import { loadBrand } from '../../../../scripts/brand/load-brand.mjs';
import {
  preflightDaemonDataRoot,
  stageProductDaemonBridge,
} from '../../../../scripts/lib/e2e-daemon-product-bridge.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  closeCanopy,
  launchCanopy,
  removeTestDataDir,
} from './launchCanopy.mjs';
import { initRepo, seedSingleRepoProject } from './parity/w5-fixtures.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const UNSUPPORTED_VM_WARNING =
  "The vm module of Node.js is unsupported in Electron's renderer process";

test('desktop preload avoids renderer vm and still exposes the IPC bridge', async () => {
  // The launcher seeds flags from their fail-closed defaults; the device AI
  // gateway contract below needs its flag on, as unconfigured builds have it.
  const { electronApp, userDataDir } = await launchCanopy({
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-ai-gateway-settings-enabled': true,
      }),
    },
  });

  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const rendererWarnings = await electronApp.evaluate(
      async ({ BrowserWindow }) => {
        const mainWindow = BrowserWindow.getAllWindows().find(
          (candidate) => !candidate.isDestroyed(),
        );
        if (!mainWindow) {
          throw new Error('Expected the desktop window to exist');
        }

        return await new Promise((resolve, reject) => {
          const messages = [];
          const webContents = mainWindow.webContents;
          const timeout = setTimeout(() => {
            cleanup();
            reject(
              new Error('Timed out waiting for the desktop window reload'),
            );
          }, 15_000);
          const onConsoleMessage = (details) => {
            if (details.level === 'warning' || details.level === 'error') {
              messages.push(details.message);
            }
          };
          const cleanup = () => {
            clearTimeout(timeout);
            webContents.off('console-message', onConsoleMessage);
            webContents.off('did-finish-load', onDidFinishLoad);
          };
          const onDidFinishLoad = () => {
            setTimeout(() => {
              cleanup();
              resolve(messages);
            }, 250);
          };

          webContents.on('console-message', onConsoleMessage);
          webContents.once('did-finish-load', onDidFinishLoad);
          webContents.reload();
        });
      },
    );

    await expect
      .poll(() => window.evaluate(() => typeof window.api))
      .toBe('object');
    // The model-gateway:load-credential wire contract keeps both call forms.
    // Existing callers omit the endpoint; configured, disabled gateways qualify
    // it so their staged key can be read without reusing another destination's.
    const credentials = await window.evaluate(async () => {
      const { api } = window;
      const organizationId = '11111111-1111-4111-8111-111111111111';
      return Promise.all([
        api.loadModelGatewayCredential(organizationId),
        api.loadModelGatewayCredential(
          organizationId,
          'https://gateway.example.test',
        ),
      ]);
    });
    expect(credentials).toHaveLength(2);
    for (const credential of credentials) {
      expect(credential).toMatchObject({
        apiKey: '',
        organizationId: '11111111-1111-4111-8111-111111111111',
      });
    }
    await expect(
      window.evaluate(() =>
        window.api.loadModelGatewayCredential(
          '11111111-1111-4111-8111-111111111111',
          'https://user:password@gateway.example.test',
        ),
      ),
    ).rejects.toThrow('Invalid AI gateway endpoint.');
    // Signed out, the device AI gateway's local-model-gateway:read,
    // local-model-gateway:update and local-model-gateway:connect contract
    // crosses the real preload and main, with its
    // local-model-gateway:changed push (api.localModelGateway.onChanged) and
    // the api.localModelGateway.onMigrationConflict subscription. Its key reads
    // through model-gateway:load-credential with the device gateway id. The
    // sign-in choice (local-model-gateway:migration-choice-read and
    // local-model-gateway:migration-choose) has nothing to decide signed out
    // and refuses an unknown decision.
    const device = await window.evaluate(async () => {
      const { api } = window;
      const changed = new Promise((resolve) => {
        const stop = api.localModelGateway.onChanged(() => {
          stop();
          resolve(true);
        });
      });
      api.localModelGateway.onMigrationConflict(() => undefined)();
      const before = await api.localModelGateway.read();
      const saved = await api.localModelGateway.update({
        expectedOrganizationId: before.organizationId,
        expectedRevision: 'absent',
        baseUrl: 'https://gateway.example.test',
        models: [
          {
            id: 'device-model',
            gatewayId: 'anthropic/claude-sonnet-5.5',
            label: 'Device model',
            harness: 'claude',
            contextWindow: 200000,
            supportedThinkingLevels: [],
            toolSchemaProfile: 'standard',
          },
        ],
        enabled: true,
      });
      const stale = await api.localModelGateway.update({
        expectedOrganizationId: before.organizationId,
        expectedRevision: 'absent',
        enabled: false,
      });
      const connect = await api.localModelGateway.connect({
        expectedOrganizationId: before.organizationId,
        baseUrl: 'https://gateway.example.test',
      });
      const key = await api.loadModelGatewayCredential(
        before.organizationId,
        'https://gateway.example.test',
      );
      const after = await api.localModelGateway.read();
      const choice = await api.localModelGateway.readMigrationChoice();
      const chooseSignedOut = await api.localModelGateway.chooseMigration(
        'device',
        'absent',
      );
      const chooseInvalid = await api.localModelGateway.chooseMigration(
        'neither',
        'absent',
      );
      const notified = await Promise.race([
        changed,
        new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
      ]);
      return {
        before,
        saved,
        stale,
        connect,
        key,
        after,
        choice,
        chooseSignedOut,
        chooseInvalid,
        notified,
      };
    });
    expect(device.before.gateway).toBeNull();
    expect(device.saved).toMatchObject({
      ok: true,
      value: {
        organizationId: device.before.organizationId,
        baseUrl: 'https://gateway.example.test',
        enabled: true,
      },
    });
    expect(device.stale).toMatchObject({
      ok: false,
      error: { serverCode: 'stale_revision' },
    });
    expect(device.connect).toEqual({
      ok: true,
      value: { status: 'key_required' },
    });
    expect(device.key).toMatchObject({
      apiKey: '',
      organizationId: device.before.organizationId,
    });
    expect(device.after.gateway?.revision).toBe(device.saved.value.revision);
    expect(device.choice).toEqual({ ok: true, value: null });
    expect(device.chooseSignedOut).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(device.chooseInvalid).toMatchObject({
      ok: false,
      error: { status: 400 },
    });
    expect(device.notified).toBe(true);
    // "Use on this computer" (CAN-7644): model-gateway-device-use:read and
    // :set cross the real preload and main, with the
    // model-gateway-device-use:changed push (api.modelGatewayDeviceUse.onChanged).
    const deviceUse = await window.evaluate(async () => {
      const { api } = window;
      const organizationId = '22222222-2222-4222-8222-222222222222';
      const changed = new Promise((resolve) => {
        const stop = api.modelGatewayDeviceUse.onChanged(() => {
          stop();
          resolve(true);
        });
      });
      const before = await api.modelGatewayDeviceUse.read();
      await api.modelGatewayDeviceUse.set({ organizationId, used: false });
      const off = await api.modelGatewayDeviceUse.read();
      const notified = await Promise.race([
        changed,
        new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
      ]);
      await api.modelGatewayDeviceUse.set({ organizationId, used: true });
      const on = await api.modelGatewayDeviceUse.read();
      let refused = false;
      try {
        await api.modelGatewayDeviceUse.set({
          organizationId: 'nope',
          used: false,
        });
      } catch {
        refused = true;
      }
      return { before, off, on, notified, refused };
    });
    expect(deviceUse.before).toEqual([]);
    expect(deviceUse.off).toEqual(['22222222-2222-4222-8222-222222222222']);
    expect(deviceUse.on).toEqual([]);
    expect(deviceUse.notified).toBe(true);
    expect(deviceUse.refused).toBe(true);
    expect(
      rendererWarnings.filter((message) =>
        message.includes(UNSUPPORTED_VM_WARNING),
      ),
    ).toEqual([]);
    // Feedback diagnostics must cross the real preload/main boundary without
    // exposing a host path or rebuilding an archive between preview and read.
    const diagnostics = await window.evaluate(async () => {
      const capability = await window.api.feedbackDiagnosticsCapabilities();
      const error = {
        referenceId: 'ERR-01234567',
        code: 'future.feedback_test',
        kind: 'defect',
        occurredAt: 123,
        copy: { title: 'An error' },
        detail: { message: 'Unicode trace café', stack: 'original trace\n```' },
      };
      const snapshot = await window.api.prepareFeedbackDiagnostics({
        context: {},
        error,
      });
      const manifest = await window.api.readFeedbackDiagnosticsEntry(
        snapshot.id,
        'feedback.json',
      );
      await window.api.releaseFeedbackDiagnostics(snapshot.id);
      let released = false;
      try {
        await window.api.readFeedbackDiagnosticsEntry(
          snapshot.id,
          'feedback.json',
        );
      } catch {
        released = true;
      }
      return { capability, snapshot, manifest, released };
    });
    expect(diagnostics.capability).toEqual({
      snapshots: true,
      version: 1,
      errorSource: true,
    });
    expect(diagnostics.snapshot).not.toHaveProperty('absolutePath');
    expect(diagnostics.manifest).toEqual({
      kind: 'text',
      text: diagnostics.snapshot.manifest,
    });
    expect(JSON.parse(diagnostics.snapshot.manifest).error.detail.stack).toBe(
      'original trace\n```',
    );
    expect(
      diagnostics.snapshot.entries.some(
        (entry) => entry.path === 'feedback.json',
      ),
    ).toBe(true);
    expect(diagnostics.released).toBe(true);
    const legacyRejections = await window.evaluate(async () => {
      const refused = [];
      try {
        await window.api.prepareFeedback({ area: 'overview', description: '' });
      } catch {
        refused.push('feedback:prepare');
      }
      try {
        await window.api.submitFeedback({
          type: 'bug',
          description: '',
          context: {},
          includeDiagnostics: false,
        });
      } catch {
        refused.push('feedback:submit');
      }
      return refused;
    });
    expect(legacyRejections).toEqual(['feedback:prepare', 'feedback:submit']);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

const RECOVERY_PROJECT_ID = 'recovery-proof';
const RECOVERY_WORKTREE_ID = 'recovery-task';
const RECOVERY_TARGET = {
  projectId: RECOVERY_PROJECT_ID,
  worktreeId: RECOVERY_WORKTREE_ID,
};

/** One project with one worktree, so a Files read reaches the daemon. */
function seedRecoveryProject({ owner, userDataDir }) {
  const projectId = RECOVERY_PROJECT_ID;
  const worktreeId = RECOVERY_WORKTREE_ID;
  const repoPath = initRepo(path.join(owner, 'repo'));
  initRepo(
    path.join(userDataDir, 'workspaces', projectId, 'worktrees', worktreeId),
  );
  seedSingleRepoProject(userDataDir, {
    id: projectId,
    name: 'Recovery proof',
    repoPath,
    worktrees: [
      {
        id: worktreeId,
        branchName: 'main',
        label: 'Recovery task',
        createdAt: '2026-05-01T12:00:00.000Z',
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    tabs: [{ id: 'empty', title: 'Recovery proof' }],
  });
}

/**
 * A private app root with the checkout's e2e build and its own copy of the
 * pinned daemon, so a test can remove or restage only its own executable.
 */
function stageRecoveryRuntime({
  repoRoot,
  runtimeRoot,
  userDataDir,
  sourceSha,
}) {
  mkdirSync(userDataDir, { mode: 0o700 });
  mkdirSync(path.join(runtimeRoot, '.cache'), { recursive: true });
  const outDir = process.env.CANOPY_E2E_OUT_DIR ?? 'out-e2e';
  // A symlink makes Electron load the checkout's real renderer URL,
  // which correctly fails the launcher's private-root window identity.
  cpSync(path.join(repoRoot, outDir), path.join(runtimeRoot, outDir), {
    recursive: true,
  });
  for (const member of ['node_modules', 'resources']) {
    symlinkSync(
      path.join(repoRoot, member),
      path.join(runtimeRoot, member),
      'junction',
    );
  }
  cpSync(
    path.join(repoRoot, 'package.json'),
    path.join(runtimeRoot, 'package.json'),
  );
  // A private copy lets this test remove only its own executable, never a
  // shared build. Verification pins the complete artifact to checkout HEAD.
  cpSync(
    path.join(repoRoot, '.cache/e2e-core-daemon'),
    path.join(runtimeRoot, '.cache/e2e-core-daemon'),
    { recursive: true },
  );
  preflightDaemonDataRoot(userDataDir);
  return stageProductDaemonBridge({
    runtimeRoot,
    sourceSha,
    platform: process.platform,
    arch: process.arch,
    brand: loadBrand(process.env.CANOPY_BRAND ?? 'canopy'),
  });
}

/** Closes the app, stops only this fixture's daemon, and removes the root. */
async function cleanUpRecoveryFixture({
  launched,
  userDataDir,
  supervision,
  bridge,
  owner,
}) {
  try {
    if (launched)
      await closeCanopy(launched.electronApp, userDataDir, {
        keepUserData: true,
      });
  } finally {
    const descriptorPath = path.join(userDataDir, 'runtime/core.json');
    if (existsSync(descriptorPath)) {
      const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
      const state = await supervision.inspectProcess({
        pid: descriptor.pid,
      });
      if (state.state !== 'absent') {
        // Never signal a PID that no longer belongs to this fixture.
        assert.deepEqual(state, {
          state: 'running',
          startIdentity: descriptor.startIdentity,
        });
        await supervision.killProcessTree({
          pid: descriptor.pid,
          mode: 'force',
        });
        await expect
          .poll(() => supervision.inspectProcess({ pid: descriptor.pid }))
          .toEqual({ state: 'absent' });
      }
    }
    if (bridge)
      expect(
        bridge
          .cleanup()
          .every((entry) =>
            ['removed', 'already-removed', 'absent'].includes(entry.outcome),
          ),
      ).toBe(true);
    await removeTestDataDir(owner);
  }
}

test.describe('native background service recovery', () => {
  test.describe.configure({ retries: 0 });

  async function exerciseRecovery(degradedStartup) {
    // Allow startup, the lease's 30 s failure-delivery bound, and recovery waits.
    test.setTimeout(150_000);
    test.skip(
      process.env.CANOPY_E2E_DAEMON_FILES_DRY_RUN === '1',
      'Intentional daemon outage cannot run in the zero-fallback Files dry-run lane',
    );
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    const owner = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cn8-')));
    const runtimeRoot = path.join(owner, 'app');
    const userDataDir = path.join(owner, 'data');
    const descriptorPath = path.join(userDataDir, 'runtime/core.json');
    const projectId = RECOVERY_PROJECT_ID;
    const worktreeId = RECOVERY_TARGET.worktreeId;
    const target = { projectId, worktreeId };
    const supervision = createSupervisionServices(process.platform);
    let bridge;
    let launched;

    try {
      bridge = stageRecoveryRuntime({
        repoRoot,
        runtimeRoot,
        userDataDir,
        sourceSha,
      });
      assert(bridge.entries.every((entry) => entry.owned));

      seedRecoveryProject({ owner, userDataDir });
      if (degradedStartup)
        expect(bridge.remove('packaged daemon')).toBe('removed');
      launched = await launchCanopy({
        rootPath: runtimeRoot,
        userDataDir,
      });
      const window = await launched.electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      await expect(
        window.getByTestId(`sidebar-project-header-${RECOVERY_PROJECT_ID}`),
      ).toBeVisible();
      const sidebarRow = window
        .locator(
          `[data-testid="worktree-row"][data-worktree-id="${worktreeId}"]`,
        )
        .first();
      let lastGoodRowText;
      if (!degradedStartup) {
        await expect(sidebarRow).toBeVisible();
        lastGoodRowText = await sidebarRow.textContent();
      }
      const snapshotFailures = [];
      window.on('console', (message) => {
        if (message.text().includes('Shared sidebar snapshot refresh failed'))
          snapshotFailures.push(message.text());
      });
      const readRoots = () =>
        window.evaluate(
          (request) => window.api.getFileTreeRoots(request),
          target,
        );
      if (degradedStartup) {
        // A failed handoff closes its W5 lease before it requires a restart.
        // The notice shows anyway, before Files is opened (CAN-7061).
        const notice = window.getByTestId('background-service-notice');
        await expect(notice).toBeVisible({ timeout: 45_000 });
        await expect(
          window.getByTestId('background-service-notice-copy-diagnostics'),
        ).toBeVisible();
        expect((await readRoots()).roots.length).toBeGreaterThan(0);
        await expect
          .poll(() =>
            window.evaluate(() => window.api.backgroundService.getStatus()),
          )
          .toMatchObject({
            state: 'unavailable',
            reason: 'start_failed',
            recovery: 'restart_app',
          });
        const mainLogPath = path.join(userDataDir, 'logs/main.log');
        await expect
          .poll(() =>
            existsSync(mainLogPath) ? readFileSync(mainLogPath, 'utf8') : '',
          )
          .toContain(
            'W5 startup handoff failed; workspace records are read-only',
          );
        await test.info().attach('degraded-handoff-main-log', {
          path: mainLogPath,
          contentType: 'text/plain',
        });
        await expect(notice).toContainText('Restart the app');
        await expect(
          window.getByTestId('background-service-notice-retry'),
        ).toHaveCount(0);
        const restart = window.getByTestId('background-service-notice-restart');
        await expect(restart).toHaveText('Restart app');
        expect((await readRoots()).roots.length).toBeGreaterThan(0);
        expect(bridge.restage('packaged daemon')).toBe('restaged');
        // Restaging cannot repair the one-shot startup handoff in this process.
        expect((await readRoots()).roots.length).toBeGreaterThan(0);
        expect(existsSync(descriptorPath)).toBe(false);
        // The unpackaged app refuses automatic restart through the real IPC.
        await restart.click();
        await expect(notice).toContainText('Quit and reopen the app');
        await expect(notice).toContainText('Save any unsaved changes first.');
        return;
      }
      expect((await readRoots()).roots.length).toBeGreaterThan(0);
      await expect
        .poll(
          () => window.evaluate(() => window.api.backgroundService.getStatus()),
          { timeout: 15_000 },
        )
        .toMatchObject({ state: 'ok', retry: 'idle' });
      await expect
        .poll(() => existsSync(descriptorPath), { timeout: 15_000 })
        .toBe(true);
      // Observe the outage transition too, before any read can briefly toast.
      await window.evaluate(() => {
        window.recoveryCrashToasts = [];
        window.recoveryHomeErrors = [];
        window.recoveryRefreshWarnings = [];
        const recordIn = (root) => {
          const toasts = [...root.querySelectorAll('[data-toast-id]')];
          if (root.matches?.('[data-toast-id]')) toasts.push(root);
          for (const toast of toasts) {
            if (toast.textContent?.includes('Something went wrong'))
              window.recoveryCrashToasts.push(toast.textContent);
            if (toast.textContent?.includes('Could not refresh project'))
              window.recoveryRefreshWarnings.push(toast.textContent);
          }
          const banners = [
            ...root.querySelectorAll('[data-testid="home-composer-error"]'),
          ];
          if (root.matches?.('[data-testid="home-composer-error"]'))
            banners.push(root);
          for (const banner of banners) {
            if (banner.textContent?.includes('Something went wrong'))
              window.recoveryHomeErrors.push(banner.textContent);
          }
        };
        recordIn(document);
        // A toast that appears then disappears during an awaited read is still
        // a duplicate failure, even if an end-of-step count would miss it.
        new MutationObserver((mutations) => {
          recordIn(document);
          // Also catch a node inserted and removed before observer delivery.
          for (const mutation of mutations) {
            for (const node of [
              ...mutation.addedNodes,
              ...mutation.removedNodes,
            ]) {
              if (node instanceof Element) recordIn(node);
            }
          }
        }).observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      });
      const initialDescriptor = JSON.parse(
        readFileSync(descriptorPath, 'utf8'),
      );
      await expect
        .poll(
          () => supervision.inspectProcess({ pid: initialDescriptor.pid }),
          { timeout: 15_000 },
        )
        .toEqual({
          state: 'running',
          startIdentity: initialDescriptor.startIdentity,
        });
      await window.evaluate(() => {
        window.recoveryInvalidations = [];
        window.api.onWorktreesFileChanged((event) => {
          if ('scope' in event && event.scope === 'all')
            window.recoveryInvalidations.push(event);
        });
      });
      // A pre-launch outage degrades W5 and intentionally refuses respawn.
      expect(bridge.remove('packaged daemon')).toBe('removed');
      assert.deepEqual(
        await supervision.inspectProcess({ pid: initialDescriptor.pid }),
        { state: 'running', startIdentity: initialDescriptor.startIdentity },
      );
      await supervision.killProcessTree({
        pid: initialDescriptor.pid,
        mode: 'force',
      });
      await expect
        .poll(
          () => supervision.inspectProcess({ pid: initialDescriptor.pid }),
          { timeout: 15_000 },
        )
        .toEqual({ state: 'absent' });
      await expect(window.getByTestId('background-service-notice')).toBeVisible(
        { timeout: 45_000 },
      );
      const unavailable = await window.evaluate(() =>
        window.api.backgroundService.getStatus(),
      );
      expect(unavailable).toMatchObject({
        state: 'unavailable',
        reason: 'reconnect_failed',
      });

      await test.step('unreachable reads keep the last sidebar and the single recovery notice', async () => {
        // Exercise the renderer's real subscriber, not just an IPC rejection
        // caught inside page.evaluate where it could never raise a toast.
        const failuresBeforeRefresh = snapshotFailures.length;
        await window.evaluate(() =>
          window.api.invalidateDesktopSessionSnapshot(),
        );
        await expect
          .poll(() => snapshotFailures.length)
          .toBeGreaterThan(failuresBeforeRefresh);
        await expect
          .poll(() =>
            window.evaluate(
              () => typeof window.__canopyProjectsTestApi?.loadProjects,
            ),
          )
          .toBe('function');
        // projects:load resolves with a stale disk projection during an outage.
        await launched.electronApp.evaluate(({ ipcMain }) => {
          const load = ipcMain._invokeHandlers.get('projects:load');
          if (!load) throw new Error('Missing projects:load handler');
          globalThis.recoveryProjectsLoadHandler = load;
          const outcomes = [];
          globalThis.recoveryProjectsLoads = outcomes;
          ipcMain.removeHandler('projects:load');
          ipcMain.handle('projects:load', async (...args) => {
            try {
              const result = await load(...args);
              outcomes.push({ ok: true, result });
              return result;
            } catch (error) {
              outcomes.push({
                ok: false,
                error: String(error),
              });
              throw error;
            }
          });
        });
        let projectLoads;
        try {
          await window.evaluate(() =>
            window.__canopyProjectsTestApi.loadProjects({
              requireSuccess: true,
            }),
          );
          projectLoads = await launched.electronApp.evaluate(
            () => globalThis.recoveryProjectsLoads,
          );
        } finally {
          await launched.electronApp.evaluate(({ ipcMain }) => {
            ipcMain.removeHandler('projects:load');
            ipcMain.handle(
              'projects:load',
              globalThis.recoveryProjectsLoadHandler,
            );
            delete globalThis.recoveryProjectsLoadHandler;
            delete globalThis.recoveryProjectsLoads;
          });
        }
        expect(projectLoads.length).toBeGreaterThan(0);
        for (const outcome of projectLoads) {
          expect(outcome).toMatchObject({
            ok: true,
            result: {
              stale: true,
              items: expect.arrayContaining([
                expect.objectContaining({
                  id: projectId,
                  worktrees: expect.arrayContaining([
                    expect.objectContaining({ id: worktreeId }),
                  ]),
                }),
              ]),
            },
          });
        }
        await expect(sidebarRow).toBeVisible();
        await expect(sidebarRow).toHaveText(lastGoodRowText);
        await expect(
          window.getByTestId('background-service-notice'),
        ).toHaveCount(1);
        await expect(
          window.getByTestId('background-service-notice-retry'),
        ).toBeVisible();
        await expect(
          window
            .locator('[data-toast-id]')
            .filter({ hasText: 'Something went wrong' }),
        ).toHaveCount(0);
        expect(await window.evaluate(() => window.recoveryCrashToasts)).toEqual(
          [],
        );
        const mainLogPath = path.join(userDataDir, 'logs/main.log');
        await expect
          .poll(() =>
            existsSync(mainLogPath) ? readFileSync(mainLogPath, 'utf8') : '',
          )
          .toContain('Shared sidebar snapshot refresh failed');
        await test.info().attach('unavailable-snapshot-main-log', {
          path: mainLogPath,
          contentType: 'text/plain',
        });
        await test.info().attach('unavailable-project-refresh-warnings', {
          body: JSON.stringify(
            await window.evaluate(() => window.recoveryRefreshWarnings),
          ),
          contentType: 'application/json',
        });
        expect(
          await window.evaluate(() => window.recoveryRefreshWarnings),
        ).toEqual([]);
        expect(
          await window.evaluate(() => window.api.backgroundService.getStatus()),
        ).toEqual(unavailable);
      });

      await test.step('a new chat opens while the service is down without a duplicate crash toast', async () => {
        // Keep the recovery fixture's original consumer set until it latches.
        // Selecting a worktree mounts additional daemon consumers.
        await new CanopyAppDriver(window).selectWorktree(worktreeId, {
          expandDefaultActivityRail: false,
        });
        const tabs = window.locator('[data-testid^="panel-tab-panel-chat-"]');
        const before = new Set(
          await tabs.evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute('data-testid')),
          ),
        );
        await window.getByTestId('panel-add-tab-group-chat').click();
        await window.getByTestId('panel-add-menu-item-new-chat').click();
        await expect(tabs).toHaveCount(before.size + 1);
        const created = (
          await tabs.evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute('data-testid')),
          )
        ).find((id) => id !== null && !before.has(id));
        expect(created).toBeTruthy();
        await expect(window.getByTestId(created)).toHaveAttribute(
          'aria-selected',
          'true',
        );
        const chatId = created.slice('panel-tab-panel-chat-'.length);
        await expect
          .poll(() =>
            window.evaluate(
              async ({ target, chatId }) => {
                const state = await window.api.chat.getState(target);
                return state.tabsFile.tabs.some((tab) => tab.id === chatId);
              },
              { target, chatId },
            ),
          )
          .toBe(true);
        const createdPanel = window.locator(
          `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
        );
        await expect(createdPanel).toBeVisible();
        await expect(createdPanel.getByRole('textbox').first()).toBeEditable();
        const failuresBeforeRefresh = snapshotFailures.length;
        await window.evaluate(() =>
          window.api.invalidateDesktopSessionSnapshot(),
        );
        await expect
          .poll(() => snapshotFailures.length)
          .toBeGreaterThan(failuresBeforeRefresh);
        await expect(
          window.getByTestId('background-service-notice'),
        ).toHaveCount(1);
        await expect(
          window.getByTestId('background-service-notice-retry'),
        ).toBeVisible();
        await expect(
          window
            .locator('[data-toast-id]')
            .filter({ hasText: 'Something went wrong' }),
        ).toHaveCount(0);
        expect(await window.evaluate(() => window.recoveryCrashToasts)).toEqual(
          [],
        );
        await expect(sidebarRow).toBeVisible();
        expect(
          await window.evaluate(() => window.api.backgroundService.getStatus()),
        ).toEqual(unavailable);
      });

      await test.step('Home creates a canonical task while the service is down', async () => {
        // Observe the real write; never replace or suppress a failed write.
        await launched.electronApp.evaluate(({ ipcMain }) => {
          const create = ipcMain._invokeHandlers.get('work-entries:create');
          if (!create) throw new Error('Missing work-entries:create handler');
          globalThis.recoveryHomeCreate = null;
          ipcMain.removeHandler('work-entries:create');
          ipcMain.handle('work-entries:create', async (...args) => {
            try {
              const result = await create(...args);
              globalThis.recoveryHomeCreate = { ok: true, result };
              return result;
            } catch (error) {
              globalThis.recoveryHomeCreate = {
                ok: false,
                error: String(error),
              };
              throw error;
            }
          });
        });
        const home = await new CanopyAppDriver(window).openHomeForProject(
          'cowork-default',
        );
        const prompt = 'Keep these recovery notes in a new task.';
        await home.getByTestId('home-composer-editor').fill(prompt);
        await home.getByTestId('home-send-button').click();
        await expect
          .poll(() =>
            launched.electronApp.evaluate(() => globalThis.recoveryHomeCreate),
          )
          .not.toBeNull();
        const outcome = await launched.electronApp.evaluate(
          () => globalThis.recoveryHomeCreate,
        );
        await test.info().attach('unavailable-home-create-outcome', {
          body: JSON.stringify(outcome),
          contentType: 'application/json',
        });
        expect(
          outcome,
          'Home write failed; do not hide this failure',
        ).toMatchObject({ ok: true });
        const entryId = outcome.result.entry.id;
        await expect
          .poll(() =>
            window.evaluate(async (entryId) => {
              const { entries } = await window.api.workEntries.list({
                projectId: 'cowork-default',
              });
              return entries.some((entry) => entry.id === entryId);
            }, entryId),
          )
          .toBe(true);
        await expect(home.getByTestId('home-composer-error')).toHaveCount(0);
        await expect(
          window.getByTestId('panel-content-chat').getByText(prompt).first(),
        ).toBeVisible();
        await expect
          .poll(() =>
            window.evaluate(
              async ({ entryId, prompt }) => {
                const state = await window.api.chat.getState({
                  projectId: 'cowork-default',
                  worktreeId: entryId,
                });
                return state.tabsFile.tabs.some((tab) =>
                  tab.messages.some(
                    (message) =>
                      message.role === 'user' &&
                      JSON.stringify(message).includes(prompt),
                  ),
                );
              },
              { entryId, prompt },
            ),
          )
          .toBe(true);
        expect(await window.evaluate(() => window.recoveryHomeErrors)).toEqual(
          [],
        );
        expect(await window.evaluate(() => window.recoveryCrashToasts)).toEqual(
          [],
        );
        await expect(
          window
            .locator('[data-toast-id]')
            .filter({ hasText: 'Something went wrong' }),
        ).toHaveCount(0);
        await expect(
          window.getByTestId('background-service-notice'),
        ).toHaveCount(1);
        await expect(
          window.getByTestId('background-service-notice-retry'),
        ).toBeVisible();
        await test.info().attach('unavailable-project-refresh-warnings', {
          body: JSON.stringify(
            await window.evaluate(() => window.recoveryRefreshWarnings),
          ),
          contentType: 'application/json',
        });
        expect(
          await window.evaluate(() => window.recoveryRefreshWarnings),
        ).toEqual([]);
        expect(
          await window.evaluate(() => window.api.backgroundService.getStatus()),
        ).toEqual(unavailable);
      });

      expect(bridge.restage('packaged daemon')).toBe('restaged');
      // Restoring availability alone cannot bypass the latch or start a daemon.
      expect((await readRoots()).roots.length).toBeGreaterThan(0);
      expect(
        await window.evaluate(() => window.api.backgroundService.getStatus()),
      ).toEqual(unavailable);
      // SIGKILL can leave the old descriptor behind; it must not name a new daemon.
      if (existsSync(descriptorPath)) {
        const staleDescriptor = JSON.parse(
          readFileSync(descriptorPath, 'utf8'),
        );
        expect(staleDescriptor.pid).toBe(initialDescriptor.pid);
        expect(
          await supervision.inspectProcess({ pid: staleDescriptor.pid }),
        ).toEqual({ state: 'absent' });
      }
      expect(await window.evaluate(() => window.recoveryInvalidations)).toEqual(
        [],
      );

      // UI -> background-service:retry -> real attach -> worktrees:file-changed
      // {scope: 'all'} -> production preload -> renderer subscriber.
      await window.getByTestId('background-service-notice-retry').click();
      await expect(
        window.getByTestId('background-service-notice'),
      ).toBeHidden();
      await expect
        .poll(() =>
          window.evaluate(() => window.api.backgroundService.getStatus()),
        )
        .toMatchObject({ state: 'ok', retry: 'idle' });
      await expect
        .poll(() => window.evaluate(() => window.recoveryInvalidations))
        .toEqual([{ scope: 'all' }]);
      const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
      expect(descriptor.pid).not.toBe(initialDescriptor.pid);
      expect(await supervision.inspectProcess({ pid: descriptor.pid })).toEqual(
        { state: 'running', startIdentity: descriptor.startIdentity },
      );
      expect((await readRoots()).roots.length).toBeGreaterThan(0);
    } finally {
      await cleanUpRecoveryFixture({
        launched,
        userDataDir,
        supervision,
        bridge,
        owner,
      });
    }
  }

  test('a refused earlier-run endpoint names the repair command until the CLI moves its files', async () => {
    // Two launches, each allowing the handoff's failure-delivery bound.
    test.setTimeout(150_000);
    test.skip(
      process.platform === 'win32',
      'Named pipes never leave a socket file behind',
    );
    test.skip(
      process.env.CANOPY_E2E_DAEMON_FILES_DRY_RUN === '1',
      'Intentional daemon outage cannot run in the zero-fallback Files dry-run lane',
    );
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    const owner = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cn8-')));
    const runtimeRoot = path.join(owner, 'app');
    const userDataDir = path.join(owner, 'data');
    const runtimeDir = path.join(userDataDir, 'runtime');
    const socketPath = path.join(runtimeDir, 'core.sock');
    const descriptorPath = path.join(runtimeDir, 'core.json');
    const supervision = createSupervisionServices(process.platform);
    let bridge;
    let launched;

    try {
      bridge = stageRecoveryRuntime({
        repoRoot,
        runtimeRoot,
        userDataDir,
        sourceSha,
      });
      assert(bridge.entries.every((entry) => entry.owned));

      // An earlier run that died holding core.sock: the socket file stays and
      // refuses connections, and its owner has departed.
      mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
      const earlier = spawn(
        process.execPath,
        [
          '-e',
          "require('node:net').createServer().listen(process.argv[1], () => console.log('listening'))",
          socketPath,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      await new Promise((resolve, reject) => {
        earlier.once('error', reject);
        earlier.stdout.once('data', resolve);
      });
      const earlierIdentity = await supervision.inspectProcess({
        pid: earlier.pid,
      });
      assert.equal(earlierIdentity.state, 'running');
      const exited = new Promise((resolve) => earlier.once('exit', resolve));
      earlier.kill('SIGKILL');
      await exited;
      expect(existsSync(socketPath)).toBe(true);
      // The receipt names this socket's inode on another device, and the
      // earlier run started after this boot: no boot evidence authorizes
      // automatic recovery, so only explicit repair can move it.
      const socketStat = lstatSync(socketPath, { bigint: true });
      writeFileSync(
        descriptorPath,
        JSON.stringify({
          version: 1,
          pid: earlier.pid,
          startIdentity: earlierIdentity.startIdentity,
          endpoint: { kind: 'socket', path: socketPath },
          protocolRange: { min: 1, max: 1 },
          buildVersion: 'earlier',
          tokenRef: path.join(
            runtimeDir,
            'core-00000000-0000-4000-8000-000000000000.token',
          ),
          socketIdentity: {
            device: String(socketStat.dev + 1n),
            inode: String(socketStat.ino),
          },
        }),
        { mode: 0o600 },
      );

      seedRecoveryProject({ owner, userDataDir });
      launched = await launchCanopy({ rootPath: runtimeRoot, userDataDir });
      const window = await launched.electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      const readRoots = () =>
        window.evaluate(
          (request) => window.api.getFileTreeRoots(request),
          RECOVERY_TARGET,
        );
      // The startup handoff's spawn refuses the endpoint before it spawns,
      // then closes its W5 lease. The reason survives that close, and the
      // notice shows before Files is opened (CAN-7061).
      const notice = window.getByTestId('background-service-notice');
      await expect(notice).toBeVisible({ timeout: 45_000 });
      const repairRefused = {
        state: 'unavailable',
        reason: 'endpoint_repair_required',
        recovery: 'restart_app',
        handoff: 'endpoint_repair_required',
      };
      await expect
        .poll(() =>
          window.evaluate(() => window.api.backgroundService.getStatus()),
        )
        .toMatchObject(repairRefused);
      const brand = loadBrand(process.env.CANOPY_BRAND ?? 'canopy');
      await expect(notice).toContainText(
        `${brand.cliName} daemon repair-endpoint`,
      );
      await expect(notice).toContainText('then restart the app');
      // The settled handoff can only recover on a new launch.
      await expect(
        window.getByTestId('background-service-notice-retry'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('background-service-notice-restart'),
      ).toHaveText('Restart app');
      await expect(
        window.getByTestId('background-service-notice-copy-diagnostics'),
      ).toBeVisible();
      // Files reads stay in-process; opening Files keeps the repair reason.
      expect((await readRoots()).roots.length).toBeGreaterThan(0);
      expect(
        await window.evaluate(() => window.api.backgroundService.getStatus()),
      ).toMatchObject(repairRefused);
      // The refusal left the earlier run's files exactly where they were.
      expect(existsSync(socketPath)).toBe(true);
      expect(JSON.parse(readFileSync(descriptorPath, 'utf8')).pid).toBe(
        earlier.pid,
      );

      // The staged CLI from the same E2E archive, run as the user would.
      const repair = execFileSync(
        path.join(runtimeRoot, '.cache/e2e-core-daemon/cli'),
        ['daemon', 'repair-endpoint'],
        {
          encoding: 'utf8',
          env: { ...process.env, CANOPY_DATA_DIR: userDataDir },
        },
      );
      const moved =
        /^Moved the earlier run's connection files to (endpoint-repair-\d{8}T\d{6}Z)\.$/m.exec(
          repair,
        );
      assert(moved, repair);
      const backup = path.join(runtimeDir, moved[1]);
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(path.join(backup, 'core.sock'))).toBe(true);
      expect(
        JSON.parse(readFileSync(path.join(backup, 'core.json'), 'utf8')).pid,
      ).toBe(earlier.pid);

      // The repair alone cannot reopen this launch's settled handoff.
      expect(
        await window.evaluate(() => window.api.backgroundService.getStatus()),
      ).toMatchObject(repairRefused);

      // main.old.log holds the lines a size rotation moved.
      const mainLogPaths = ['main.old.log', 'main.log'].map((name) =>
        path.join(userDataDir, 'logs', name),
      );
      const failedHandoffs = () =>
        mainLogPaths
          .map((logPath) =>
            existsSync(logPath) ? readFileSync(logPath, 'utf8') : '',
          )
          .join('\n')
          .split('\n')
          .filter((line) =>
            line.includes(
              'W5 startup handoff failed; workspace records are read-only',
            ),
          ).length;
      await expect.poll(failedHandoffs).toBe(1);

      // Restart, as the notice says: the next launch's handoff starts the
      // service over the moved files.
      await closeCanopy(launched.electronApp, userDataDir, {
        keepUserData: true,
      });
      launched = undefined;
      launched = await launchCanopy({ rootPath: runtimeRoot, userDataDir });
      const restarted = await launched.electronApp.firstWindow();
      await new CanopyAppDriver(restarted).waitForShell({ timeout: 30_000 });
      await expect
        .poll(() => existsSync(descriptorPath), { timeout: 45_000 })
        .toBe(true);
      const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
      expect(descriptor.pid).not.toBe(earlier.pid);
      await expect
        .poll(() => supervision.inspectProcess({ pid: descriptor.pid }), {
          timeout: 15_000,
        })
        .toEqual({ state: 'running', startIdentity: descriptor.startIdentity });
      await expect
        .poll(
          () =>
            restarted.evaluate(() => window.api.backgroundService.getStatus()),
          { timeout: 45_000 },
        )
        .toMatchObject({ state: 'ok', retry: 'idle' });
      const status = await restarted.evaluate(() =>
        window.api.backgroundService.getStatus(),
      );
      expect(status.recovery).toBeUndefined();
      expect(status.handoff).toBeUndefined();
      await expect(
        restarted.getByTestId('background-service-notice'),
      ).toBeHidden();
      // This launch's handoff did not degrade.
      expect(failedHandoffs()).toBe(1);
      expect(
        (
          await restarted.evaluate(
            (request) => window.api.getFileTreeRoots(request),
            RECOVERY_TARGET,
          )
        ).roots.length,
      ).toBeGreaterThan(0);
    } finally {
      await cleanUpRecoveryFixture({
        launched,
        userDataDir,
        supervision,
        bridge,
        owner,
      });
    }
  });

  test('Try again recovers the service and delivers the sidebar invalidation through preload', async () => {
    await exerciseRecovery(false);
  });

  test('degraded startup offers Restart app and preserves in-process Files reads', async () => {
    await exerciseRecovery(true);
  });
});
