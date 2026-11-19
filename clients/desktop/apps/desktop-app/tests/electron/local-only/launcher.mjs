// Self-contained headless launcher for the local-only smoke spec
// (local-only-smoke.spec.mjs, docs/local-only-build.md).
//
// It deliberately does not use launchCanopy.mjs, global-setup.mjs or
// anything under scripts/: the public client export carries this directory,
// and `check:public-export` requires every import to stay inside
// apps/desktop-app/tests/electron or node_modules.
//
// The app directory is `CANOPY_E2E_OUT_DIR` (relative to the repository
// root) when set, otherwise `out-e2e/`, the same default as launchCanopy.mjs.
// In this repository that is an E2E build (`pnpm run build:e2e`), where
// `CANOPY_E2E_LOCAL_ONLY=1` turns the local-only profile on, so the golden
// runs without extra configuration. The export's `smoke:local` sets
// `CANOPY_E2E_OUT_DIR=out`, a production `CANOPY_LOCAL_ONLY=true` build,
// which ignores that variable.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';
import electronPath from 'electron';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../..');

const CLOSE_TIMEOUT_MS = 20_000;

/** `<app dir>/main/index.js`, failing with the build command when missing. */
export function resolveMainEntry(env = process.env) {
  const outDir = env.CANOPY_E2E_OUT_DIR?.trim() || 'out-e2e';
  const mainEntry = path.resolve(REPO_ROOT, outDir, 'main', 'index.js');
  if (!existsSync(mainEntry)) {
    throw new Error(
      `No desktop build at ${path.relative(REPO_ROOT, mainEntry)}. Build a local-only app first (in this repository: pnpm run build:e2e; in the public export: pnpm run build:local, then pnpm run smoke:local).`,
    );
  }
  return mainEntry;
}

/** Extra Electron switches, space separated (CI passes `--no-sandbox` on Linux). */
export function extraElectronArgs(env = process.env) {
  return (env.CANOPY_LOCAL_SMOKE_ELECTRON_ARGS ?? '')
    .split(/\s+/)
    .filter((arg) => arg.length > 0);
}

/**
 * Temporary roots for one run, under one short directory: daemon socket
 * paths live inside the data root and must stay under the macOS 103-byte
 * limit.
 */
export function createTempRoots() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'clo-')));
  const roots = {
    root,
    data: path.join(root, 'd'),
    secure: path.join(root, 's'),
    claude: path.join(root, 'p', 'claude'),
    codex: path.join(root, 'p', 'codex'),
    providerHome: path.join(root, 'p', 'home'),
    fixtures: path.join(root, 'f'),
  };
  for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true });
  return roots;
}

export function removeTempRoots(roots) {
  if (!roots) return;
  rmSync(roots.root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}

/**
 * Seeds what every UI automation launch seeds, so the spec lands on the app
 * shell: first-run onboarding done, the legal terms accepted, the one-time
 * notices dismissed, and a random MCP proxy port so a running app's port is
 * never taken. Sign-in is not seeded: there is no account in this build.
 */
function seedFirstRunState(dataDir) {
  const at = '2026-01-01T00:00:00.000Z';
  writeFileSync(
    path.join(dataDir, 'preferences.json'),
    `${JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          initializedCuratedPluginDefaults: [],
          legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
          legalConsentTosVersion: '2026-07-06',
          mcpProxyPort: 20000 + Math.floor(Math.random() * 15000),
          approvalsUpgradeNoticeDismissed: true,
          onboardingTipsDismissed: {
            workflows: at,
            'worktree-chat': at,
            'workflows-schedule': at,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  // A fresh profile that gained a preferences file is not an upgrade.
  writeFileSync(
    path.join(dataDir, 'migrations.json'),
    `${JSON.stringify({ version: 1, approval_defaults_full_access: true }, null, 2)}\n`,
  );
}

/**
 * Inherited variables never passed to the app: every brand-prefixed
 * variable (data roots, cloud URLs, E2E switches, mock redirects, the
 * `<PREFIX>_<TOOL>_BINARY_PATH` overrides a packaged install exports, which
 * would repoint the bundled binary directory), provider credentials and
 * configuration roots, proxies, LaunchDarkly, GitHub tokens, and Electron
 * variables that would change how the process starts.
 */
const DROPPED_ENV = [
  /^CANOPY_/,
  /^ANTHROPIC_/,
  /^OPENAI_/,
  /^CLAUDE/,
  /^CODEX_/,
  /^LAUNCHDARKLY_/,
  /^GH_/,
  /^(?:GITHUB|GITHUB_ENTERPRISE)_TOKEN$/,
  /^(?:HTTPS?|ALL|NO)_PROXY$/i,
  // Runner instrumentation and shell hooks can issue their own requests in
  // every child. They are not part of the application under test.
  /^(?:BASH_ENV|ENV|LD_PRELOAD|DYLD_INSERT_LIBRARIES|NODE_OPTIONS)$/,
  /^(?:BLACKSMITH_|OTEL_|DD_|GIT_)/,
  /^ELECTRON_RUN_AS_NODE$/,
  /^CHROME_CRASHPAD_PIPE_NAME$/,
];

/**
 * Every `<PREFIX>_<TOOL>_BINARY_PATH` override, whatever the brand prefix
 * (a packaged install exports them for its own bundled binaries).
 */
const BINARY_PATH_OVERRIDE = /_BINARY_PATH$/;

export function buildLocalOnlyEnv({ roots, proxyUrl, noProxy, extraEnv = {} }) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (DROPPED_ENV.some((pattern) => pattern.test(key))) continue;
    if (BINARY_PATH_OVERRIDE.test(key)) continue;
    env[key] = value;
  }
  // A synthetic Codex home from a developer shell is never the app's HOME.
  if (
    env.HOME &&
    (env.HOME.includes('__codex-homes__') ||
      env.HOME.includes(`${path.sep}codex-home${path.sep}`))
  ) {
    env.HOME = os.userInfo().homedir;
  }
  return {
    ...env,
    TZ: 'UTC',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    GIT_AUTHOR_NAME: 'Local Smoke',
    GIT_AUTHOR_EMAIL: 'local-smoke@example.invalid',
    GIT_COMMITTER_NAME: 'Local Smoke',
    GIT_COMMITTER_EMAIL: 'local-smoke@example.invalid',
    // Isolated app data. Production builds honor these too.
    CANOPY_DATA_DIR: roots.data,
    CANOPY_SECURE_DATA_DIR: roots.secure,
    // Provider state stays inside the run.
    CLAUDE_CONFIG_DIR: roots.claude,
    CODEX_HOME: roots.codex,
    // This fixture installs Claude only. Source builds otherwise discover a
    // developer's Codex on PATH and start it for Settings account probes,
    // making the smoke depend on a runtime setup:local did not install.
    CODEX_EXECUTABLE: path.join(roots.providerHome, 'uninstalled-codex'),
    // No GitHub account: the GitHub CLI reads its login from here, never the
    // developer's own.
    GH_CONFIG_DIR: path.join(roots.providerHome, 'gh'),
    CANOPY_CURSOR_USER_HOME: roots.providerHome,
    CANOPY_CLAUDE_DESKTOP_DATA_DIR: path.join(roots.claude, 'desktop'),
    T3CODE_HOME: path.join(roots.providerHome, '.t3'),
    OPENCODE_DB: path.join(
      roots.providerHome,
      '.local',
      'share',
      'opencode',
      'opencode.db',
    ),
    // Child processes that honor proxy variables reach the recording proxy;
    // the egress guard covers Electron itself.
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    // Hidden window: an E2E build hides it unless this is 1, and an
    // unpackaged production build does the same with isolated logging.
    CANOPY_E2E_SHOW_WINDOW: '0',
    CANOPY_E2E_ISOLATED_LOGGING: '1',
    // The local-only seam of an E2E build. A production local-only build
    // ignores it, and a production normal build ignores it too, which the
    // spec's first assertion catches.
    CANOPY_E2E_LOCAL_ONLY: '1',
    ...extraEnv,
  };
}

function platformElectronArgs(dataDir) {
  const extra = extraElectronArgs();
  const ownProfile = extra.some((arg) => arg.startsWith('--user-data-dir='));
  const profile =
    process.platform === 'linux'
      ? path.join(dataDir, 'electron-profile')
      : dataDir;
  return [
    // macOS: never prompt for the login keychain from a test build.
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    ...(process.platform === 'linux' &&
    !extra.some((arg) => arg.startsWith('--ozone-platform'))
      ? ['--ozone-platform=x11']
      : []),
    ...(ownProfile ? [] : [`--user-data-dir=${profile}`]),
    ...extra,
  ];
}

/**
 * Launches the built app headless against the given temp roots. Returns the
 * Playwright app, its first window, and a `close()` that quits the app and
 * then stops anything left in its process group.
 */
export async function launchLocalOnlyApp({
  roots,
  proxyUrl,
  noProxy,
  extraEnv,
}) {
  const mainEntry = resolveMainEntry();
  seedFirstRunState(roots.data);
  const extra = extraElectronArgs();
  const electronApp = await electron.launch({
    executablePath: electronPath,
    cwd: REPO_ROOT,
    args: [...platformElectronArgs(roots.data), mainEntry],
    env: buildLocalOnlyEnv({ roots, proxyUrl, noProxy, extraEnv }),
    // Playwright adds --no-sandbox to Linux launches unless told otherwise;
    // only a caller's explicit switch turns the sandbox off.
    chromiumSandbox: !extra.includes('--no-sandbox'),
  });
  // Playwright disposes its process channel when the app closes. Retain the
  // child handle now so cleanup can still observe and stop it afterward.
  const child = electronApp.process();
  const pid = child.pid;
  let closed = false;
  return {
    electronApp,
    window: await electronApp.firstWindow(),
    async close() {
      if (closed) return;
      closed = true;
      // A process killed by a signal keeps `exitCode` null; `signalCode` is set.
      const hasExited = () =>
        child.exitCode !== null || child.signalCode !== null;
      const exited = new Promise((resolve) => {
        if (hasExited()) resolve();
        else child.once('exit', resolve);
      });
      await Promise.race([
        electronApp.close().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
      ]);
      if (!hasExited()) {
        child.kill('SIGKILL');
      }
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      // Playwright starts Electron in its own process group on POSIX; stop
      // anything the app left behind in it (agent CLIs, helpers).
      if (process.platform !== 'win32' && pid) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // The group is already gone.
        }
      }
    },
  };
}
