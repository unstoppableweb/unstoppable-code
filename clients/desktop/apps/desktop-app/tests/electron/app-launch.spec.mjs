import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

async function getWindowViewportSize(window) {
  return window.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
}

test('launches the built Electron shell', async ({}, testInfo) => {
  const { require: tsRequire } = await import('tsx/cjs/api');
  const gates = tsRequire(
    '../../src/main/lib/w5-recovery-gates.ts',
    import.meta.url,
  );
  const { isW5DaemonFlipCompiled } = tsRequire(
    '../../src/main/lib/w5-flip-gate.ts',
    import.meta.url,
  );
  expect(gates.isW5RecoveryEntryEnabled()).toBe(true);
  expect(isW5DaemonFlipCompiled()).toBe(false);
  expect(gates.isW5RecoveryAvailable()).toBe(false);
  const { electronApp, userDataDir, productMainEntryPath } =
    await launchCanopy();
  const secureDir = `${userDataDir}-secure`;
  mkdirSync(secureDir, { recursive: true });

  try {
    const isPackaged = await electronApp.evaluate(({ app }) => app.isPackaged);
    expect(isPackaged).toBe(false);
    const mainWindowVisible = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((candidate) => candidate.isVisible()),
    );
    expect(mainWindowVisible).toBe(false);

    if (process.platform === 'linux') {
      const evidence = await electronApp.evaluate(({ app, safeStorage }) => {
        const available = safeStorage.isEncryptionAvailable();
        const synthetic = 'canopy-linux-synthetic-smoke';
        return {
          schemaVersion: 1,
          electron: process.versions.electron,
          platform: process.platform,
          architecture: process.arch,
          uid: process.getuid(),
          euid: process.geteuid(),
          gid: process.getgid(),
          home: process.env.HOME,
          config: process.env.XDG_CONFIG_HOME,
          data: process.env.XDG_DATA_HOME,
          cache: process.env.XDG_CACHE_HOME,
          state: process.env.XDG_STATE_HOME,
          runtime: process.env.XDG_RUNTIME_DIR,
          sessionRoot: process.env.CANOPY_LINUX_UI_SESSION_ROOT,
          profile: app.commandLine.getSwitchValue('user-data-dir'),
          display: process.env.DISPLAY,
          hasSessionBus: Boolean(process.env.DBUS_SESSION_BUS_ADDRESS),
          passwordStore: app.commandLine.getSwitchValue('password-store'),
          noSandbox: app.commandLine.hasSwitch('no-sandbox'),
          backend: safeStorage.getSelectedStorageBackend(),
          available,
          roundTrip:
            available &&
            safeStorage.decryptString(safeStorage.encryptString(synthetic)) ===
              synthetic,
        };
      });
      await testInfo.attach('linux-launch.json', {
        body: JSON.stringify(evidence, null, 2),
        contentType: 'application/json',
      });
      expect(evidence.platform).toBe('linux');
      if (process.env.CANOPY_LINUX_UI_HARNESS_ACCEPTANCE === '1')
        expect(evidence.architecture).toBe('x64');
      expect(evidence.uid).toBeGreaterThan(0);
      expect(evidence.euid).toBeGreaterThan(0);
      for (const [key, directory] of Object.entries({
        home: 'home',
        config: 'config',
        data: 'data',
        cache: 'cache',
        state: 'state',
        runtime: 'runtime',
      }))
        expect(evidence[key]).toBe(path.join(evidence.sessionRoot, directory));
      expect(evidence.profile).toBe(path.join(userDataDir, 'electron-profile'));
      expect(evidence.display).toMatch(/^:/);
      expect(evidence.hasSessionBus).toBe(true);
      expect(evidence.passwordStore).toBe('gnome-libsecret');
      expect(evidence.noSandbox).toBe(false);
      expect(evidence.backend).toBe('gnome_libsecret');
      expect(evidence.available).toBe(true);
      expect(evidence.roundTrip).toBe(true);
    }

    const window = await electronApp.firstWindow();
    // Electron 45 can expose the window before its first commit (blank URL).
    await expect
      .poll(() => window.url(), { timeout: 30_000 })
      .not.toMatch(/^(about:blank)?$/);
    await window.waitForLoadState('domcontentloaded');
    await expect
      .poll(() => getWindowViewportSize(window))
      .toEqual({
        width: 1400,
        height: 900,
      });
    await expect(window.getByTestId('app-sidebar')).toBeVisible();
    if (process.platform === 'darwin') {
      // Compatibility detection must be safe before the macOS-26-only helper
      // can load. Exercise the real preload/main path on an older host.
      await electronApp.evaluate(() => {
        const os = process.getBuiltinModule('os');
        const childProcess = process.getBuiltinModule('child_process');
        globalThis.__restoreVoiceHost = {
          release: os.release,
          execFile: childProcess.execFile,
          executable: process.env.DICTATE_EXECUTABLE,
        };
        os.release = () => '24.6.0';
        process.env.DICTATE_EXECUTABLE = process.execPath;
        const execFile = childProcess.execFile;
        childProcess.execFile = (file, ...args) => {
          if (file === process.execPath) {
            throw new Error('Unsupported macOS launched the dictation helper');
          }
          return execFile(file, ...args);
        };
      });
      try {
        const support = await window.evaluate(() =>
          window.api.voice.recheckSupported(),
        );
        expect(support.supported).toBe(false);
        expect(support.reason).toContain('macOS 26');
      } finally {
        await electronApp.evaluate(() => {
          const original = globalThis.__restoreVoiceHost;
          process.getBuiltinModule('os').release = original.release;
          process.getBuiltinModule('child_process').execFile =
            original.execFile;
          if (original.executable === undefined)
            delete process.env.DICTATE_EXECUTABLE;
          else process.env.DICTATE_EXECUTABLE = original.executable;
          delete globalThis.__restoreVoiceHost;
        });
        await window.evaluate(() => window.api.voice.recheckSupported());
      }
    }
    // Exercise w5-recovery:status and w5-recovery:prepare through the real
    // preload/main boundary. Exposure is compiled on after registration;
    // actual legacy W5 ownership must still hide entry and prevent intent.
    const recovery = await window.evaluate(async () => ({
      status: await window.api.w5Recovery.getStatus(),
      prepared: await window.api.w5Recovery.prepare(),
    }));
    const hiddenRecovery = { state: 'hidden', canRecover: false, entries: [] };
    expect(recovery).toEqual({
      status: hiddenRecovery,
      prepared: hiddenRecovery,
    });
    // getCanopyDataDir projects the harness-owned CANOPY_DATA_DIR here.
    expect(
      existsSync(path.join(userDataDir, 'runtime/w5-recovery-request.json')),
    ).toBe(false);
    // Main startup has called startCloudProjectBinding. Signed out,
    // cloud-projects:find-link and cloud-projects:link fail closed through
    // the real preload/main boundary without a Cloud request, and an invalid
    // workspace ID is refused before the binding reaches its transport.
    await electronApp.evaluate(() => {
      const original = globalThis.fetch;
      const requests = [];
      globalThis.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('/api/v1/projects')) requests.push(url);
        return original(input, init);
      };
      globalThis.__cloudProjectRequests = requests;
      globalThis.__restoreCloudProjectFetch = () => {
        globalThis.fetch = original;
      };
    });
    const cloudProjectRequests = () =>
      electronApp.evaluate(() => globalThis.__cloudProjectRequests.length);
    try {
      const invalid = await window.evaluate(() =>
        window.api.cloudProjects.findLink('../workspace').then(
          () => 'resolved',
          () => 'rejected',
        ),
      );
      expect(invalid).toBe('rejected');
      expect(await cloudProjectRequests()).toBe(0);
      const signedOut = await window.evaluate(async () => ({
        found: await window.api.cloudProjects.findLink('workspace-1'),
        linked: await window.api.cloudProjects.link({
          workspaceId: 'workspace-1',
          target: { kind: 'new' },
        }),
      }));
      expect(signedOut).toEqual({
        found: { status: 'unavailable', reason: 'signed-out' },
        linked: { ok: false, code: 'unavailable' },
      });
      expect(await cloudProjectRequests()).toBe(0);
      // Main startup has also called startCloudProjectSetupSweep. Signed out,
      // cloud-projects:setup-catalog, cloud-projects:setup-options and
      // cloud-projects:start-setup answer unavailable without a Cloud request
      // and nothing arrives on cloud-projects:setup-progress; an invalid
      // project ID is refused at the handler.
      const setup = await window.evaluate(
        async ({ projectId, destinationRoot }) => {
          const pushed = [];
          const stop = window.api.cloudProjects.onSetupProgress((progress) =>
            pushed.push(progress),
          );
          try {
            return {
              invalid: await window.api.cloudProjects
                .setupOptions('../project')
                .then(
                  () => 'resolved',
                  () => 'rejected',
                ),
              catalog: await window.api.cloudProjects.setupCatalog(),
              options: await window.api.cloudProjects.setupOptions(projectId),
              started: await window.api.cloudProjects.startSetup({
                projectId,
                repositoryIds: [projectId],
                destinationRoot,
              }),
              pushed: pushed.length,
            };
          } finally {
            stop();
          }
        },
        {
          projectId: '00000000-0000-4000-8000-000000000001',
          destinationRoot: userDataDir,
        },
      );
      expect(setup).toEqual({
        invalid: 'rejected',
        catalog: { status: 'unavailable', reason: 'signed-out' },
        options: { status: 'unavailable', reason: 'unavailable' },
        started: { ok: false, code: 'unavailable' },
        pushed: 0,
      });
      expect(await cloudProjectRequests()).toBe(0);
    } finally {
      await electronApp.evaluate(() => globalThis.__restoreCloudProjectFetch());
    }
    // A fresh launch (no lastActiveContext MRU, no legacy last-selected
    // worktree) lands on the standalone Home page — the chat-centric surface
    // that replaced the old welcome empty state.
    const homePage = window.getByTestId('page-home');
    await expect(homePage).toBeVisible();
    // The window drags from the shell's title-bar strip on macOS, Home's own
    // strip on Windows, and the native frame on Linux. Home starts 46px down,
    // so on macOS its own strip would only cover the top notification corner
    // (CAN-5711), and the corner stays no-drag for the Windows strip.
    const homeDragRegion = homePage.getByTestId('home-titlebar-drag-region');
    const shellDragRegion = window.getByTestId('app-main-titlebar-drag-region');
    if (process.platform === 'win32') {
      await expect(homeDragRegion).toBeVisible();
      await expect(homeDragRegion).toHaveCSS('-webkit-app-region', 'drag');
    } else {
      await expect(homeDragRegion).toHaveCount(0);
    }
    if (process.platform === 'darwin') {
      await expect(shellDragRegion).toBeVisible();
      await expect(shellDragRegion).toHaveCSS('-webkit-app-region', 'drag');
    } else {
      await expect(shellDragRegion).toHaveCount(0);
    }
    await expect(window.getByTestId('in-app-notification-corner')).toHaveCSS(
      '-webkit-app-region',
      'no-drag',
    );
    // Scope to page-home: the always-mounted (hidden) MainPage hosts a
    // second embedded HomeSurface.
    await expect(homePage.getByTestId('home-composer')).toBeVisible();
    // The heading is picked at random from a 50-phrase pool per mount
    // (see homeHeadings.ts) — assert the stable testid + non-empty text
    // rather than a specific phrase. Scope to page-home: the always-mounted
    // (hidden) MainPage hosts a second embedded HomeSurface heading.
    const heading = homePage.getByTestId('home-heading');
    await expect(heading).toBeVisible();
    await expect(heading).not.toHaveText('');
    // Main startup has called startMemorySync. Signed out, no account
    // carries memory-sync-v1, so no engine made a replica. The memory merge
    // runner's Worker entry, built beside main, merges disjoint edits in
    // Electron's runtime and answers a malformed request with a too_costly
    // conflict.
    expect(existsSync(path.join(userDataDir, 'memory-replicas'))).toBe(false);
    const memoryMerges = await electronApp.evaluate(
      async (_electron, workerPath) => {
        const { Worker } = process.getBuiltinModule('node:worker_threads');
        const merge = (workerData) =>
          new Promise((resolve, reject) => {
            const worker = new Worker(workerPath, { workerData });
            worker.once('message', resolve);
            worker.once('error', reject);
          });
        return {
          merged: await merge({
            base: 'a\nb\nc\n',
            ours: 'A\nb\nc\n',
            theirs: 'a\nb\nC\n',
          }),
          refused: await merge({ base: null, ours: 1, theirs: '' }),
        };
      },
      path.join(
        path.dirname(productMainEntryPath),
        'memory-sync-merge-worker.js',
      ),
    );
    expect(memoryMerges).toEqual({
      merged: { merge: { kind: 'merged', content: 'A\nb\nC\n' } },
      refused: { merge: { kind: 'conflict', reason: 'too_costly' } },
    });
    // The Memory settings read memory-sync:get-state; signed out it answers
    // signed_out with no project memory, and memory-sync:preview-merge and
    // memory-sync:set-project-memory refuse with no engine.
    const signedOutMemorySync = {
      availability: 'signed_out',
      connection: null,
      settings: null,
      user: null,
      projects: [],
      deviceLabel: null,
    };
    const memorySync = await window.evaluate(async () => ({
      state: await window.api.getMemorySyncState(),
      preview: await window.api.previewMemorySyncMerge(),
      project: await window.api.setMemorySyncProjectMemory({
        workspaceId: 'workspace-never-bound',
        keepOnThisComputer: true,
      }),
    }));
    expect(memorySync).toEqual({
      state: signedOutMemorySync,
      preview: { ok: false, code: 'not_running' },
      project: { ok: false, code: 'off', state: signedOutMemorySync },
    });
    // Hidden BrowserWindows still render and support visual evidence.
    await window.screenshot({ path: testInfo.outputPath('app-launch.png') });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
  expect(existsSync(userDataDir)).toBe(false);
  expect(existsSync(secureDir)).toBe(false);
});

test('can skip applying the default viewport size', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-viewport-'),
  );
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          windowBounds: { x: 100, y: 100, width: 900, height: 600 },
          windowMaximized: false,
          windowFullScreen: false,
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: null,
  });

  try {
    const window = await electronApp.firstWindow();
    // Electron 45 can expose the window before its first commit (blank URL).
    await expect
      .poll(() => window.url(), { timeout: 30_000 })
      .not.toMatch(/^(about:blank)?$/);
    await window.waitForLoadState('domcontentloaded');
    await expect
      .poll(() => getWindowViewportSize(window))
      .not.toEqual({
        width: 1400,
        height: 900,
      });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('rejects invalid viewport size options', async () => {
  await expect(launchCanopy({ viewportSize: {} })).rejects.toThrow(
    'viewportSize must be null or an object with positive integer width and height',
  );
  await expect(
    launchCanopy({ viewportSize: { width: '100%', height: 900 } }),
  ).rejects.toThrow(
    'viewportSize must be null or an object with positive integer width and height',
  );
  await expect(launchCanopy({ viewportSize: false })).rejects.toThrow(
    'viewportSize must be null or an object with positive integer width and height',
  );
});
