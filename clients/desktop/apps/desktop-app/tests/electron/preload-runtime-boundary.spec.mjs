import { expect, test } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
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
  const { electronApp, userDataDir } = await launchCanopy();

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
    expect(diagnostics.capability).toEqual({ snapshots: true, version: 1 });
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

test.describe('native background service recovery', () => {
  test.describe.configure({ retries: 0 });

  test('Try again recovers the service and delivers the sidebar invalidation through preload', async () => {
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
    const projectId = 'recovery-proof';
    const worktreeId = 'recovery-task';
    const target = { projectId, worktreeId };
    const supervision = createSupervisionServices(process.platform);
    let bridge;
    let launched;

    try {
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
      bridge = stageProductDaemonBridge({
        runtimeRoot,
        sourceSha,
        platform: process.platform,
        arch: process.arch,
        brand: loadBrand(process.env.CANOPY_BRAND ?? 'canopy'),
      });
      assert(bridge.entries.every((entry) => entry.owned));
      expect(bridge.remove('packaged daemon')).toBe('removed');

      const repoPath = initRepo(path.join(owner, 'repo'));
      initRepo(
        path.join(
          userDataDir,
          'workspaces',
          projectId,
          'worktrees',
          worktreeId,
        ),
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
      launched = await launchCanopy({
        rootPath: runtimeRoot,
        userDataDir,
      });
      const window = await launched.electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      await expect(
        window.getByTestId(`sidebar-project-header-${projectId}`),
      ).toBeVisible();
      await window.evaluate(() => {
        window.recoveryInvalidations = [];
        window.api.onWorktreesFileChanged((event) => {
          if ('scope' in event && event.scope === 'all')
            window.recoveryInvalidations.push(event);
        });
      });
      const readRoots = () =>
        window.evaluate(
          (request) => window.api.getFileTreeRoots(request),
          target,
        );
      expect((await readRoots()).roots.length).toBeGreaterThan(0);
      const unavailable = await window.evaluate(() =>
        window.api.backgroundService.getStatus(),
      );
      expect(unavailable).toMatchObject({
        state: 'unavailable',
        reason: 'start_failed',
      });
      await expect(
        window.getByTestId('background-service-notice'),
      ).toBeVisible();

      expect(bridge.restage('packaged daemon')).toBe('restaged');
      // Restoring availability alone cannot bypass the latch or start a daemon.
      expect((await readRoots()).roots.length).toBeGreaterThan(0);
      expect(
        await window.evaluate(() => window.api.backgroundService.getStatus()),
      ).toEqual(unavailable);
      expect(existsSync(path.join(userDataDir, 'runtime/core.json'))).toBe(
        false,
      );
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
      const descriptor = JSON.parse(
        readFileSync(path.join(userDataDir, 'runtime/core.json'), 'utf8'),
      );
      expect(await supervision.inspectProcess({ pid: descriptor.pid })).toEqual(
        { state: 'running', startIdentity: descriptor.startIdentity },
      );
      expect((await readRoots()).roots.length).toBeGreaterThan(0);
    } finally {
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
                ['removed', 'already-removed', 'absent'].includes(
                  entry.outcome,
                ),
              ),
          ).toBe(true);
        await removeTestDataDir(owner);
      }
    }
  });
});
