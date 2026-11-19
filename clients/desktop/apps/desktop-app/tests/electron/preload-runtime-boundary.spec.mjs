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
    // Signed out, the device AI gateway's local-model-gateway:read, :update
    // and :connect contract crosses the real preload and main, with its
    // local-model-gateway:changed push (api.localModelGateway.onChanged) and
    // the api.localModelGateway.onMigrationConflict subscription. Its key reads
    // through model-gateway:load-credential with the device gateway id.
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
      const notified = await Promise.race([
        changed,
        new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
      ]);
      return { before, saved, stale, connect, key, after, notified };
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
    expect(device.notified).toBe(true);
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
