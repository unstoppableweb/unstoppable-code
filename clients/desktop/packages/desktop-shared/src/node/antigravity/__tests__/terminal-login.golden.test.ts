/**
 * A sign-in started from another computer runs the pinned runtime's
 * paste-code login (`antigravity acp --login`), which prints a Google link any
 * computer can open and reads the code from stdin (CAN-6718). It launches
 * only after the same checks as every native launch, and without display
 * variables, so the runtime cannot open a browser on the unattended screen.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type * as CorePlatform from '@canopy/core-platform';
import type * as Resolution from '../runtime-resolution';
import { ANTIGRAVITY_RUNTIME_VERSION } from '../runtime-metadata';
import type {
  ProviderProcess,
  ProviderProcessRequest,
} from '../../provider-process/spawn';

const mockSteps: string[] = [];
// Runs while the last file check before the `--login` spawn is pending.
let mockDuringUnchanged: (() => void) | null = null;
jest.mock('../workspace-configuration', () => ({
  assertAntigravityWorkspaceConfigurationIsolated: (): Promise<void> => {
    mockSteps.push('isolation');
    return Promise.resolve();
  },
}));
// The file's identity on disk, and the verdict the shared, path-keyed cache
// holds for it, which any launch's verification can replace.
let mockDiskIdentity = 'agy-1';
let mockCachedIdentity: string | undefined;
const changed = (): Error =>
  new Error('The Antigravity CLI changed during launch.');
jest.mock('../runtime-integrity', () => ({
  verifyAntigravityExecutable: (file: string): Promise<string> => {
    mockSteps.push(`verify:${file}`);
    mockCachedIdentity = mockDiskIdentity;
    return Promise.resolve('/real/antigravity');
  },
  assertAntigravityExecutableUnchanged: (file: string): Promise<void> => {
    mockSteps.push(`unchanged:${file}`);
    mockDuringUnchanged?.();
    return mockCachedIdentity === mockDiskIdentity
      ? Promise.resolve()
      : Promise.reject(changed());
  },
  antigravityExecutableIdentityForLaunch: (file: string): Promise<string> => {
    mockSteps.push(`unchanged:${file}`);
    return mockCachedIdentity === mockDiskIdentity
      ? Promise.resolve(mockDiskIdentity)
      : Promise.reject(changed());
  },
  assertAntigravityExecutableIdentity: (
    file: string,
    identity: string,
  ): Promise<void> => {
    mockSteps.push(`identity:${file}`);
    mockDuringUnchanged?.();
    return identity === mockDiskIdentity
      ? Promise.resolve()
      : Promise.reject(changed());
  },
}));
// The host the launch runs on; macOS accepts any Google-signed CLI, so only
// the runtime's own version answer holds it to the pinned release.
let mockPlatform = 'darwin';
jest.mock('@canopy/core-platform', () => ({
  ...jest.requireActual<typeof CorePlatform>('@canopy/core-platform'),
  hostPlatformOperatingSystem: (): string => mockPlatform,
}));
// The version the runtime reports in its ACP handshake; set per case.
let mockVersion = '';
// Runs while the version-check runtime is closing.
let mockDuringClose: (() => void) | null = null;
jest.mock('@canopy/desktop-shared/node/acp', () => ({
  connectAcp: (): Promise<object> => {
    mockSteps.push(`acp:${mockVersion}`);
    return Promise.resolve({
      getInitialization: () => ({ agentInfo: { version: mockVersion } }),
      close: (): void => {
        mockSteps.push('acp-close');
        mockDuringClose?.();
      },
    });
  },
}));
jest.mock('../runtime-resolution', () => ({
  ...jest.requireActual<typeof Resolution>('../runtime-resolution'),
  resolveAntigravityExecutable: (): Promise<string> => {
    mockSteps.push('resolve');
    return Promise.resolve('/managed/antigravity');
  },
}));

import {
  antigravitySignInLink,
  antigravityTerminalLoginArguments,
  openAntigravityTerminalLogin,
} from '../terminal-login';

function fakeProcess(): ProviderProcess {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    pid: 1,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stop: (): Promise<void> => Promise.resolve(),
  });
}

const OUTPUT = [
  'Open this link in a browser to log in with Google:',
  '',
  '  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=x&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=s',
  '',
  'Then paste the authorization code, or the full URL of the page you land on, and press Enter:',
].join('\n');

// A desktop session's ways of reaching a browser: the display, the session
// bus (`gio open`, portals), the desktop's opener and `$BROWSER`.
const DESKTOP_ENV = {
  DISPLAY: ':0',
  WAYLAND_DISPLAY: 'wayland-1',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  XDG_CURRENT_DESKTOP: 'GNOME',
  BROWSER: 'firefox',
} as const;
const saved = Object.fromEntries(
  Object.keys(DESKTOP_ENV).map((key) => [key, process.env[key]]),
);

let profile = '';
beforeEach(() => {
  mockSteps.length = 0;
  mockPlatform = 'darwin';
  mockVersion = ANTIGRAVITY_RUNTIME_VERSION;
  profile = mkdtempSync(join(tmpdir(), 'agy-terminal-login-'));
  mockDuringUnchanged = null;
  mockDuringClose = null;
  mockDiskIdentity = 'agy-1';
  mockCachedIdentity = undefined;
  Object.assign(process.env, DESKTOP_ENV);
});
afterEach(() => {
  rmSync(profile, { recursive: true, force: true });
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('Antigravity paste-code sign-in', () => {
  it('runs the login subcommand on the profile, with telemetry off', () => {
    expect(antigravityTerminalLoginArguments('/profile')).toEqual([
      'acp',
      '--login',
      '--gemini-dir',
      '/profile',
      '--disable-telemetry',
    ]);
  });

  it('finds the Google link in the printed output, and nothing else', () => {
    expect(antigravitySignInLink(OUTPUT)).toBe(
      'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=x&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=s',
    );
    expect(
      antigravitySignInLink('Visit https://example.com/o/oauth2/auth'),
    ).toBe(undefined);
  });

  it('spawns the verified real file only after every launch check, without a display', async () => {
    const requests: ProviderProcessRequest[] = [];
    await openAntigravityTerminalLogin({
      cwd: '/profile/sign-in',
      profile,
      spawnProcess: (request) => {
        mockSteps.push('spawn');
        requests.push(request);
        return fakeProcess();
      },
      assertEnabled: () => {
        mockSteps.push('enabled');
      },
      owner: { kind: 'discovery', id: 'sign-in-1' },
    });
    // The runtime launch first, with every check and the pinned-version
    // handshake, then the sign-in from the same file, re-checked unchanged.
    expect(mockSteps).toEqual([
      'enabled',
      'isolation',
      'resolve',
      'verify:/managed/antigravity',
      'enabled',
      'enabled',
      'unchanged:/real/antigravity',
      'spawn',
      `acp:${ANTIGRAVITY_RUNTIME_VERSION}`,
      'acp-close',
      'enabled',
      'identity:/real/antigravity',
      'spawn',
    ]);
    const request = requests.at(-1);
    expect(request?.command).toBe('/real/antigravity');
    expect(request?.args).toEqual(antigravityTerminalLoginArguments(profile));
    expect(request?.env.DISPLAY).toBeUndefined();
    expect(request?.env.WAYLAND_DISPLAY).toBeUndefined();
    // Nor any other way to open a browser on this unattended screen.
    expect(request?.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
    expect(request?.env.XDG_CURRENT_DESKTOP).toBeUndefined();
    expect(request?.env.BROWSER).toBe('true');
    expect(request?.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true');
  });

  it('refuses before any check once cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = jest.fn();
    await expect(
      openAntigravityTerminalLogin({
        cwd: '/profile/sign-in',
        profile,
        spawnProcess: spawn,
        assertEnabled: () => undefined,
        owner: { kind: 'discovery', id: 'sign-in-2' },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    expect(mockSteps).toEqual([]);
  });

  // CAN-6718 review round 7: the remote window can go away while the last
  // file check runs; the sign-in must not launch after it.
  it('refuses to spawn when cancelled during the last file check', async () => {
    const controller = new AbortController();
    mockDuringUnchanged = (): void => controller.abort();
    const spawned: ProviderProcessRequest[] = [];
    const spawn = (request: ProviderProcessRequest): ProviderProcess => {
      spawned.push(request);
      return fakeProcess();
    };
    await expect(
      openAntigravityTerminalLogin({
        cwd: '/profile/sign-in',
        profile,
        spawnProcess: spawn,
        assertEnabled: () => undefined,
        owner: { kind: 'discovery', id: 'sign-in-4' },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(mockSteps.at(-1)).toBe('identity:/real/antigravity');
    expect(spawned.some((request) => request.args.includes('--login'))).toBe(
      false,
    );
  });

  // CAN-6718 review round 10: macOS accepts any Google-signed CLI, so the
  // sign-in runs the pinned-version check every native launch does (the
  // runtime's own ACP handshake) before `acp --login`.
  it('refuses a Google-signed CLI that is not the pinned version on macOS', async () => {
    mockVersion = '1.6.0';
    const spawned: (readonly string[])[] = [];
    await expect(
      openAntigravityTerminalLogin({
        cwd: '/profile/sign-in',
        profile,
        spawnProcess: (request) => {
          spawned.push(request.args);
          return fakeProcess();
        },
        assertEnabled: () => undefined,
        owner: { kind: 'discovery', id: 'sign-in-5' },
      }),
    ).rejects.toThrow('This version of Antigravity has not been verified.');
    expect(spawned.some((args) => args.includes('--login'))).toBe(false);
  });

  // CAN-6718 review round 11: the verdict cache is shared and keyed by path,
  // so another launch can re-verify a different Google-signed file there
  // while the version check closes. `--login` must run only the exact file
  // that reported the pinned version.
  it('refuses to spawn when another launch re-verified a different file at that path', async () => {
    mockDuringClose = (): void => {
      // Another file now sits at the path, and another launch's
      // verification replaced the cached verdict with it.
      mockDiskIdentity = 'agy-2';
      mockCachedIdentity = 'agy-2';
    };
    const spawned: (readonly string[])[] = [];
    await expect(
      openAntigravityTerminalLogin({
        cwd: '/profile/sign-in',
        profile,
        spawnProcess: (request) => {
          spawned.push(request.args);
          return fakeProcess();
        },
        assertEnabled: () => undefined,
        owner: { kind: 'discovery', id: 'sign-in-6' },
      }),
    ).rejects.toThrow('changed during launch');
    expect(spawned.some((args) => args.includes('--login'))).toBe(false);
  });

  it('refuses when the harness is turned off', async () => {
    const spawn = jest.fn();
    await expect(
      openAntigravityTerminalLogin({
        cwd: '/profile/sign-in',
        profile,
        spawnProcess: spawn,
        assertEnabled: () => {
          throw new Error('Antigravity is unavailable.');
        },
        owner: { kind: 'discovery', id: 'sign-in-3' },
      }),
    ).rejects.toThrow('Antigravity is unavailable.');
    expect(spawn).not.toHaveBeenCalled();
  });
});
