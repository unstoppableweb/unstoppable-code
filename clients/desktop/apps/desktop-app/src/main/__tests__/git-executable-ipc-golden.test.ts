// CAN-4070 rule: captured on the unchanged `git-executable:status` and
// `git-executable:redetect` IPC handlers before CAN-5137 routed them through
// `worker.git.executable.get`. Processes, the filesystem and the preference
// file are virtual; detection, its effects and its in-flight sharing are the
// real module's. Only `register` below changes with the implementation.
import type * as ChildProcessModule from 'node:child_process';
import { ChildProcess } from 'node:child_process';
import type * as FsPromisesModule from 'node:fs/promises';
import {
  IPC_CHANNELS,
  type GitExecutableStatus,
} from '@canopy/desktop-shared/types';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type * as GitExecutableModule from '../lib/git-executable';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';

// Each case re-evaluates the isolated dispatcher graph, even with warm transforms.
jest.setTimeout(20_000);

// The dispatcher imports terminal support, but Git detection never uses a PTY.
// Platform simulations must not load a native binary for the simulated host.
jest.mock('node-pty', () => ({
  spawn: (): never => {
    throw new Error('Git executable tests must not spawn a PTY');
  },
}));

type ExecCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

const mockHandlers = new Map<string, (event: unknown) => Promise<unknown>>();
jest.mock('node-pty', () => {
  throw new Error('Git executable tests must not load native node-pty');
});
jest.mock('../terminal/worker-terminal', () => ({}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown) => Promise<unknown>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));

const mockExecFile = jest.fn<
  ChildProcess,
  [string, string[], unknown, ExecCallback]
>();
jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof ChildProcessModule>('node:child_process'),
  execFile: (
    file: string,
    args: string[],
    options: unknown,
    callback: ExecCallback,
  ): ChildProcess => mockExecFile(file, args, options, callback),
}));

const mockStat = jest.fn<Promise<{ isFile(): boolean }>, [string]>();
const mockRealpath = jest.fn<Promise<string>, [string]>();
const mockAccess = jest.fn<Promise<void>, [string]>();
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof FsPromisesModule>('node:fs/promises'),
  stat: (path: string): Promise<{ isFile(): boolean }> => mockStat(path),
  realpath: (path: string): Promise<string> => mockRealpath(path),
  access: (path: string): Promise<void> => mockAccess(path),
  mkdtemp: (): Promise<string> => Promise.resolve('/tmp/git-validation-golden'),
  rm: (): Promise<void> => Promise.resolve(),
}));

const mockShowOpenDialog = jest.fn<
  Promise<{ canceled: boolean; filePaths: string[] }>,
  []
>();
jest.mock('electron', () => ({
  dialog: {
    showOpenDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> =>
      mockShowOpenDialog(),
  },
}));

const mockLoginPath = jest.fn<string, []>();
const mockPrewarmLoginPath = jest.fn<Promise<void>, [{ force?: boolean }?]>();
jest.mock('@canopy/execution-engine/pipelines/config-paths', () => ({
  getLinuxProbeEnv: (): Record<string, string> => ({ PATH: '/probe/bin' }),
  getLoginShellPath: (): string => mockLoginPath(),
  prewarmLoginShellPath: (options?: { force?: boolean }): Promise<void> =>
    mockPrewarmLoginPath(options),
}));

let preferences: { gitExecutablePath: string };
const mockReadPreferences = jest.fn<
  Promise<{ gitExecutablePath: string }>,
  []
>();
const mockWritePreferences = jest.fn<
  Promise<void>,
  [{ gitExecutablePath?: string }]
>();
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<{ gitExecutablePath: string }> =>
    mockReadPreferences(),
  writePreferencesFile: (patch: {
    gitExecutablePath?: string;
  }): Promise<void> => mockWritePreferences(patch),
}));

type Entry =
  | { kind: 'git'; version: string }
  | { kind: 'not-git' }
  | { kind: 'directory' }
  | { kind: 'noexec' }
  | { kind: 'eacces' };

interface Gate {
  promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

let files: Record<string, Entry>;
let links: Record<string, string>;
let whereResults: Record<string, string[]>;
let developerDir: string | null;
let loginPath: string;
let commands: string[];
/** `--version` probes held until the test opens them, by executable. */
let probeGates: Map<string, Gate>;
let probeStarts: Map<string, Gate>;

const originalPlatform = process.platform;
const originalArch = process.arch;
const originalEnv = { ...process.env };
const ipcEvent = { sender: { id: 1 } };

function setPlatform(platform: NodeJS.Platform, arch = 'x64'): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function git(version = '2.47.1'): Entry {
  return { kind: 'git', version };
}

beforeEach(() => {
  mockHandlers.clear();
  jest.clearAllMocks();
  process.env = { ...originalEnv };
  for (const name of [
    'CANOPY_GIT_EXECUTABLE',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'LOCALAPPDATA',
  ])
    delete process.env[name];
  preferences = { gitExecutablePath: '' };
  files = {};
  links = {};
  whereResults = {};
  developerDir = null;
  loginPath = '/usr/bin:/bin';
  commands = [];
  probeGates = new Map();
  probeStarts = new Map();
  mockReadPreferences.mockImplementation(() =>
    Promise.resolve({ ...preferences }),
  );
  mockWritePreferences.mockImplementation((patch) => {
    if (typeof patch.gitExecutablePath === 'string')
      preferences.gitExecutablePath = patch.gitExecutablePath;
    return Promise.resolve();
  });
  mockLoginPath.mockImplementation(() => loginPath);
  mockPrewarmLoginPath.mockImplementation(() => Promise.resolve());
  mockStat.mockImplementation((path) => {
    const entry = files[path];
    if (!entry)
      return Promise.reject(
        errno('ENOENT', `ENOENT: no such file or directory, stat '${path}'`),
      );
    if (entry.kind === 'eacces')
      return Promise.reject(
        errno('EACCES', `EACCES: permission denied, stat '${path}'`),
      );
    return Promise.resolve({ isFile: () => entry.kind !== 'directory' });
  });
  mockRealpath.mockImplementation((path) => {
    if (links[path]) return Promise.resolve(links[path]);
    if (files[path]) return Promise.resolve(path);
    return Promise.reject(
      errno('ENOENT', `ENOENT: no such file or directory, realpath '${path}'`),
    );
  });
  mockAccess.mockImplementation((path) => {
    const kind = files[path]?.kind;
    return kind === 'git' || kind === 'not-git'
      ? Promise.resolve()
      : Promise.reject(errno('EACCES', `EACCES: permission denied, '${path}'`));
  });
  mockExecFile.mockImplementation((file, args, _options, callback) => {
    commands.push([file, ...args].join(' '));
    void (async (): Promise<void> => {
      if (args[0] === '--version') {
        probeStarts.get(file)?.open();
        await probeGates.get(file)?.promise;
      }
      if (file === 'where.exe') {
        const lines = whereResults[args[0]];
        if (lines) callback(null, `${lines.join('\r\n')}\r\n`, '');
        else
          callback(
            new Error('INFO: Could not find files for the given pattern(s).'),
            '',
            '',
          );
        return;
      }
      if (file === '/usr/bin/xcode-select') {
        if (developerDir) callback(null, `${developerDir}\n`, '');
        else
          callback(
            new Error('xcode-select: error: no developer tools'),
            '',
            '',
          );
        return;
      }
      if (args.includes('init')) {
        callback(null, '', '');
        return;
      }
      const entry = files[file];
      if (args[0] === '--version' && entry?.kind === 'git')
        callback(null, `git version ${entry.version}\n`, '');
      else if (args[0] === '--version' && entry?.kind === 'not-git')
        callback(null, 'usage: not-git\n', '');
      else callback(errno('ENOENT', `spawn ${file} ENOENT`), '', '');
    })();
    return new ChildProcess();
  });
});

afterAll(() => {
  setPlatform(originalPlatform, originalArch);
  process.env = originalEnv;
});

// The grants every desktop IPC caller carries (desktop-ipc-caller.ts).
const desktopCaller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [
    'worker.filesystem.read',
    'core.workspace.read',
    'core.chat.read',
    'core.chat.write',
    'core.worktree.read',
  ],
};

let runtime: DesktopCanopyDispatcher | undefined;

// A cold transform cache takes longer than a test's timeout to compile the
// desktop runtime graph, so compile it once up front.
beforeAll(async () => {
  await jest.isolateModulesAsync(async () => {
    await import('../ipc/git-executable');
    await import('../canopy-runtime/desktop-runtime');
  });
}, 60_000);

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
});

/**
 * Loads a fresh detection module and registers the IPC handlers over it,
 * through the desktop dispatcher of the same module graph. The registration
 * is the only harness change since the capture.
 */
async function register(): Promise<typeof GitExecutableModule> {
  let loaded: typeof GitExecutableModule | undefined;
  await jest.isolateModulesAsync(async () => {
    loaded = await import('../lib/git-executable');
    const { registerGitExecutableHandlers } =
      await import('../ipc/git-executable');
    const { createDesktopRuntime } =
      await import('../canopy-runtime/desktop-runtime');
    runtime = createDesktopRuntime();
    registerGitExecutableHandlers(() => null, {
      dispatcher: runtime,
      resolveCaller: (): CanopyCallerDescriptor => desktopCaller,
    });
  });
  if (!loaded) throw new Error('git-executable did not load');
  return loaded;
}

function invoke(
  channel: 'status' | 'redetect' | 'browse',
): Promise<GitExecutableStatus> {
  const name =
    channel === 'status'
      ? IPC_CHANNELS.gitExecutableStatus
      : channel === 'redetect'
        ? IPC_CHANNELS.gitExecutableRedetect
        : IPC_CHANNELS.gitExecutableBrowse;
  const handler = mockHandlers.get(name);
  if (!handler) throw new Error(`${name} was not registered`);
  return handler(ipcEvent) as Promise<GitExecutableStatus>;
}

const ISO_TIMESTAMP = /"checkedAt":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z"/;

/** The response as the renderer receives it, key order included. */
function wire(status: GitExecutableStatus): string {
  const json = JSON.stringify(status);
  expect(json).toMatch(ISO_TIMESTAMP);
  return json.replace(ISO_TIMESTAMP, '"checkedAt":"<checkedAt>"');
}

function record(
  responses: Record<string, GitExecutableStatus | string>,
): Record<string, unknown> {
  return {
    responses: Object.fromEntries(
      Object.entries(responses).map(([name, value]) => [
        name,
        typeof value === 'string' ? value : wire(value),
      ]),
    ),
    savedPreference: preferences.gitExecutablePath,
    preferenceWrites: mockWritePreferences.mock.calls.map(([patch]) => patch),
    publishedEnvironment: process.env.CANOPY_GIT_EXECUTABLE ?? null,
    commands,
  };
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 20; index++)
    await new Promise((resolve) => setImmediate(resolve));
};

/** Every write to the published environment variable from here on. */
function recordPublications(): string[] {
  const writes: string[] = [];
  process.env = new Proxy(process.env, {
    set(target, key, value: string): boolean {
      if (key === 'CANOPY_GIT_EXECUTABLE') writes.push(`set ${value}`);
      return Reflect.set(target, key, value);
    },
    deleteProperty(target, key): boolean {
      if (key === 'CANOPY_GIT_EXECUTABLE') writes.push('delete');
      return Reflect.deleteProperty(target, key);
    },
  });
  return writes;
}

// Spawn-time resolution, direct detection as the terminal service, Browse
// cancel and the installers call it, and the status channel.
const SAME_TURN_FOLLOWERS = [
  'spawn resolution',
  'direct detection',
  'status',
] as const;

/**
 * Invokes `git-executable:redetect` and, in the same synchronous turn, a
 * direct caller, while the `--version` probe of `gatedPath` is held.
 */
async function redetectThenFollow(
  follower: (typeof SAME_TURN_FOLLOWERS)[number],
  gatedPath: string,
): Promise<{
  redetect: GitExecutableStatus;
  followed: unknown;
  publications: string[];
}> {
  const held = gate();
  const started = gate();
  probeGates.set(gatedPath, held);
  probeStarts.set(gatedPath, started);
  const lib = await register();
  const publications = recordPublications();

  const redetect = invoke('redetect');
  const followed =
    follower === 'spawn resolution'
      ? lib.getResolvedGitExecutableForSpawn()
      : follower === 'status'
        ? invoke('status')
        : lib.detectGitExecutable();
  const completion = Promise.all([redetect, followed]);
  try {
    await Promise.race([
      started.promise,
      completion.then(() => {
        throw new Error(`Git detection settled without probing ${gatedPath}`);
      }),
    ]);
  } finally {
    held.open();
  }
  const settled = await completion;
  return { redetect: settled[0], followed: settled[1], publications };
}

/**
 * The effects of one interleaving, compared whole so a regression reports
 * every count at once. On Linux each detection refreshes the login PATH once
 * when nothing is saved or discovered, so the refreshes count its detections
 * and generation bumps.
 */
function sameTurnEffects(publications: string[]): {
  probes: string[];
  preferenceSaves: number;
  publications: string[];
  loginPathRefreshes: unknown[][];
} {
  return {
    probes: versionProbes(),
    preferenceSaves: mockWritePreferences.mock.calls.length,
    publications,
    loginPathRefreshes: mockPrewarmLoginPath.mock.calls,
  };
}

function versionProbes(): string[] {
  return commands.filter((command) => command.endsWith('--version'));
}

describe('Windows', () => {
  beforeEach(() => setPlatform('win32'));

  it('publishes a valid saved preference', async () => {
    preferences.gitExecutablePath = 'C:\\Git\\cmd\\git.exe';
    files['C:\\Git\\cmd\\git.exe'] = git('2.47.1.windows.1');
    whereResults.winget = ['C:\\Users\\golden\\winget.exe'];
    await register();

    expect(record({ status: await invoke('status') })).toMatchSnapshot();
  });

  it('clears a missing saved preference and saves the where.exe Git on redetect', async () => {
    preferences.gitExecutablePath = 'C:\\Old\\git.exe';
    process.env.CANOPY_GIT_EXECUTABLE = 'C:\\Old\\git.exe';
    whereResults.git = ['C:\\Tools\\Git\\cmd\\git.exe', 'C:\\Other\\git.exe'];
    files['C:\\Tools\\Git\\cmd\\git.exe'] = git('2.46.0.windows.1');
    await register();

    expect(record({ redetect: await invoke('redetect') })).toMatchSnapshot();
  });

  it('saves a valid inherited override when nothing is saved', async () => {
    process.env.CANOPY_GIT_EXECUTABLE = '  C:\\Portable\\git.exe ';
    files['C:\\Portable\\git.exe'] = git('2.45.2.windows.1');
    await register();

    expect(record({ status: await invoke('status') })).toMatchSnapshot();
  });

  it('unpublishes an unusable override and keeps looking', async () => {
    process.env.CANOPY_GIT_EXECUTABLE = 'C:\\Broken\\git.exe';
    files['C:\\Broken\\git.exe'] = { kind: 'not-git' };
    whereResults.git = ['c:\\tools\\GIT.EXE', 'C:\\TOOLS\\git.exe'];
    files['c:\\tools\\GIT.EXE'] = { kind: 'not-git' };
    await register();

    expect(record({ status: await invoke('status') })).toMatchSnapshot();
  });

  it('reports not-found with winget and without a reason when nothing exists', async () => {
    whereResults.winget = ['C:\\Users\\golden\\winget.exe'];
    await register();

    expect(record({ status: await invoke('status') })).toMatchSnapshot();
  });

  it('rejects a non-git.exe candidate with its reason', async () => {
    whereResults.git = ['C:\\Tools\\git.cmd'];
    files['C:\\Tools\\git.cmd'] = git();
    await register();

    expect(record({ status: await invoke('status') })).toMatchSnapshot();
  });

  it('starts a new probe for a forced recheck while status runs', async () => {
    whereResults.git = ['C:\\Git\\git.exe'];
    files['C:\\Git\\git.exe'] = git('2.47.1.windows.1');
    const held = gate();
    probeGates.set('C:\\Git\\git.exe', held);
    await register();

    const status = invoke('status');
    await flush();
    const redetect = invoke('redetect');
    await flush();
    held.open();
    const [first, second] = await Promise.all([status, redetect]);

    expect(second).not.toBe(first);
    expect(record({ status: first, redetect: second })).toMatchSnapshot();
  });

  it.each(['status-first', 'spawn-first'] as const)(
    'shares one probe and one save across status, spawn resolution and direct detection (%s)',
    async (order) => {
      whereResults.git = ['C:\\Git\\git.exe'];
      files['C:\\Git\\git.exe'] = git('2.47.1.windows.1');
      const held = gate();
      probeGates.set('C:\\Git\\git.exe', held);
      const lib = await register();

      const calls: Array<Promise<unknown>> = [];
      if (order === 'status-first') {
        calls.push(invoke('status'));
        await flush();
        calls.push(lib.getResolvedGitExecutableForSpawn());
      } else {
        calls.push(lib.getResolvedGitExecutableForSpawn());
        await flush();
        calls.push(invoke('status'));
      }
      await flush();
      calls.push(lib.detectGitExecutable());
      await flush();
      held.open();
      const settled = await Promise.all(calls);
      const status = settled[order === 'status-first' ? 0 : 1];
      const spawn = settled[order === 'status-first' ? 1 : 0];

      expect(settled[2]).toBe(status);
      expect(
        commands.filter((command) => command.endsWith('--version')),
      ).toEqual(['C:\\Git\\git.exe --version']);
      expect(mockWritePreferences).toHaveBeenCalledTimes(1);
      expect(
        record({
          status: status as GitExecutableStatus,
          spawn: String(spawn),
        }),
      ).toMatchSnapshot();
    },
  );

  it.each(SAME_TURN_FOLLOWERS)(
    'shares a redetect probe with %s started in the same turn',
    async (follower) => {
      whereResults.git = ['C:\\Git\\git.exe'];
      files['C:\\Git\\git.exe'] = git('2.47.1.windows.1');

      const { redetect, followed, publications } = await redetectThenFollow(
        follower,
        'C:\\Git\\git.exe',
      );

      expect(sameTurnEffects(publications)).toEqual({
        probes: ['C:\\Git\\git.exe --version'],
        preferenceSaves: 1,
        publications: ['set C:\\Git\\git.exe'],
        loginPathRefreshes: [],
      });
      if (follower !== 'spawn resolution') expect(followed).toBe(redetect);
      else expect(followed).toBe('C:\\Git\\git.exe');
      expect(record({ redetect })).toMatchSnapshot();
    },
  );
});

describe('macOS', () => {
  beforeEach(() => {
    setPlatform('darwin', 'arm64');
    loginPath = '/usr/bin:/opt/homebrew/bin:relative/bin';
  });

  it('skips the Apple shim and saves the login-PATH Git', async () => {
    files['/usr/bin/git'] = git('2.39.5 (Apple Git-154)');
    files['/opt/homebrew/bin/git'] = git('2.47.1');
    links['/opt/homebrew/bin/git'] = '/opt/homebrew/Cellar/git/2.47.1/bin/git';
    files['/opt/homebrew/Cellar/git/2.47.1/bin/git'] = git('2.47.1');
    await register();

    expect(record({ status: await invoke('status') })).toMatchSnapshot();
  });

  it('clears a saved shim and reports the last candidate failure', async () => {
    preferences.gitExecutablePath = '/usr/bin/git';
    process.env.CANOPY_GIT_EXECUTABLE = '/usr/bin/git';
    developerDir = '/Applications/Xcode.app/Contents/Developer';
    links['/opt/homebrew/bin/git'] = '/opt/homebrew/Library/Homebrew/shims/git';
    files['/opt/homebrew/Library/Homebrew/shims/git'] = git();
    await register();

    expect(record({ status: await invoke('status') })).toMatchSnapshot();
  });

  it('lets a forced recheck share the running probe', async () => {
    files['/opt/homebrew/bin/git'] = git('2.47.1');
    const held = gate();
    probeGates.set('/opt/homebrew/bin/git', held);
    await register();

    const status = invoke('status');
    await flush();
    const redetect = invoke('redetect');
    await flush();
    held.open();
    const [first, second] = await Promise.all([status, redetect]);

    expect(second).toBe(first);
    expect(mockWritePreferences).toHaveBeenCalledTimes(1);
    expect(record({ status: first, redetect: second })).toMatchSnapshot();
  });

  it.each(SAME_TURN_FOLLOWERS)(
    'shares a redetect probe with %s started in the same turn',
    async (follower) => {
      files['/opt/homebrew/bin/git'] = git('2.47.1');

      const { redetect, followed, publications } = await redetectThenFollow(
        follower,
        '/opt/homebrew/bin/git',
      );

      expect(sameTurnEffects(publications)).toEqual({
        probes: ['/opt/homebrew/bin/git --version'],
        preferenceSaves: 1,
        publications: ['set /opt/homebrew/bin/git'],
        loginPathRefreshes: [],
      });
      if (follower !== 'spawn resolution') expect(followed).toBe(redetect);
      else expect(followed).toBe('/opt/homebrew/bin/git');
      expect(record({ redetect })).toMatchSnapshot();
    },
  );
});

describe('Linux x64', () => {
  beforeEach(() => {
    setPlatform('linux', 'x64');
    loginPath = '/home/golden/.local/bin:relative:/usr/local/bin:/usr/bin';
  });

  it('publishes login-PATH discovery without saving it, then reports it from cache', async () => {
    files['/usr/local/bin/git'] = git('2.43.0');
    await register();

    const first = await invoke('status');
    const second = await invoke('status');
    expect(record({ first, second })).toMatchSnapshot();
    expect(mockPrewarmLoginPath.mock.calls).toEqual([[undefined]]);
  });

  it('forces the login-PATH refresh on redetect and falls back to the system Git', async () => {
    loginPath = '/home/golden/bin';
    files['/usr/bin/git'] = git('2.43.0');
    await register();

    expect(record({ redetect: await invoke('redetect') })).toMatchSnapshot();
    expect(mockPrewarmLoginPath.mock.calls).toEqual([[{ force: true }]]);
  });

  it('reports a broken saved choice without replacing or clearing it', async () => {
    preferences.gitExecutablePath = '/opt/git/bin/git';
    files['/opt/git/bin/git'] = { kind: 'noexec' };
    files['/usr/bin/git'] = git('2.43.0');
    await register();

    expect(record({ status: await invoke('status') })).toMatchSnapshot();
  });

  it('treats an inherited override as the explicit choice', async () => {
    process.env.CANOPY_GIT_EXECUTABLE = '/srv/git/bin/git';
    files['/srv/git/bin/git'] = git('2.44.1');
    files['/usr/bin/git'] = git('2.43.0');
    await register();

    expect(record({ status: await invoke('status') })).toMatchSnapshot();
  });

  it('explains candidates that exist but cannot be used', async () => {
    files['/usr/local/bin/git'] = { kind: 'eacces' };
    files['/usr/bin/git'] = { kind: 'directory' };
    files['/home/golden/.local/bin/git'] = { kind: 'not-git' };
    await register();

    expect(record({ status: await invoke('status') })).toMatchSnapshot();
  });

  it('reports a stock image without Git', async () => {
    await register();

    expect(record({ status: await invoke('status') })).toMatchSnapshot();
  });

  it.each(['status-first', 'spawn-first'] as const)(
    'shares one probe and one generation across status and spawn resolution (%s)',
    async (order) => {
      files['/usr/local/bin/git'] = git('2.43.0');
      const held = gate();
      probeGates.set('/usr/local/bin/git', held);
      const lib = await register();

      const calls: Array<Promise<unknown>> = [];
      if (order === 'status-first') {
        calls.push(invoke('status'));
        await flush();
        calls.push(lib.getResolvedGitExecutableForSpawn());
      } else {
        calls.push(lib.getResolvedGitExecutableForSpawn());
        await flush();
        calls.push(invoke('status'));
      }
      await flush();
      held.open();
      const settled = await Promise.all(calls);
      const status = settled[order === 'status-first' ? 0 : 1];
      const spawn = settled[order === 'status-first' ? 1 : 0];

      // An extra generation bump would supersede the probe and send spawn
      // resolution round to probe again.
      expect(
        commands.filter((command) => command.endsWith('--version')),
      ).toEqual(['/usr/local/bin/git --version']);
      expect(mockPrewarmLoginPath).toHaveBeenCalledTimes(1);
      expect(
        record({
          status: status as GitExecutableStatus,
          spawn: String(spawn),
        }),
      ).toMatchSnapshot();
    },
  );

  it.each(SAME_TURN_FOLLOWERS)(
    'shares a redetect probe and its generation with %s started in the same turn',
    async (follower) => {
      files['/usr/local/bin/git'] = git('2.43.0');

      const { redetect, followed, publications } = await redetectThenFollow(
        follower,
        '/usr/local/bin/git',
      );

      // One forced refresh: one detection and one generation bump. Linux
      // discovery publishes without saving.
      expect(sameTurnEffects(publications)).toEqual({
        probes: ['/usr/local/bin/git --version'],
        preferenceSaves: 0,
        publications: ['set /usr/local/bin/git'],
        loginPathRefreshes: [[{ force: true }]],
      });
      if (follower !== 'spawn resolution') expect(followed).toBe(redetect);
      else expect(followed).toBe('/usr/local/bin/git');
      expect(record({ redetect })).toMatchSnapshot();
    },
  );

  it('never publishes a detection superseded by a saved choice', async () => {
    files['/usr/local/bin/git'] = git('2.43.0');
    files['/opt/chosen/git'] = git('2.45.0');
    const held = gate();
    mockPrewarmLoginPath.mockImplementationOnce(() => held.promise);
    mockShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/opt/chosen/git'],
    });
    const lib = await register();

    const stale = invoke('status');
    await flush();
    const browse = await invoke('browse');
    const spawn = lib.getResolvedGitExecutableForSpawn();
    await flush();
    held.open();
    const superseded = await stale;
    const after = await invoke('status');

    expect(await spawn).toBe('/opt/chosen/git');
    expect(mockWritePreferences).toHaveBeenCalledTimes(1);
    expect(
      record({ superseded, browse, after, spawn: await spawn }),
    ).toMatchSnapshot();
  });

  it.each(['old-first', 'new-first'] as const)(
    'keeps the newer detection published when the older finishes %s',
    async (order) => {
      files['/old/bin/git'] = git('2.40.0');
      files['/new/bin/git'] = git('2.43.0');
      const releases: Gate[] = [];
      mockPrewarmLoginPath.mockImplementation(() => {
        const held = gate();
        releases.push(held);
        return held.promise;
      });
      await register();

      loginPath = '/old/bin';
      const stale = invoke('status');
      await flush();
      loginPath = '/new/bin';
      const latest = invoke('redetect');
      await flush();
      expect(releases).toHaveLength(2);
      const release = async (index: number, path: string): Promise<void> => {
        loginPath = path;
        releases[index].open();
        await flush();
      };
      if (order === 'old-first') {
        await release(0, '/old/bin');
        await release(1, '/new/bin');
      } else {
        await release(1, '/new/bin');
        await release(0, '/old/bin');
      }
      const [older, newer] = await Promise.all([stale, latest]);
      mockPrewarmLoginPath.mockImplementation(() => Promise.resolve());
      const after = await invoke('status');

      expect(record({ older, newer, after })).toMatchSnapshot();
    },
  );
});

describe('platforms that do not require Git', () => {
  beforeEach(() => setPlatform('linux', 'ppc64'));

  it('reports ready without probing', async () => {
    await register();

    expect(record({ status: await invoke('status') })).toMatchSnapshot();
  });

  it('validates and publishes an override', async () => {
    process.env.CANOPY_GIT_EXECUTABLE = '/opt/git/git';
    files['/opt/git/git'] = git('2.43.0');
    await register();

    expect(record({ status: await invoke('status') })).toMatchSnapshot();
  });

  it('reports an unusable override with its reason', async () => {
    process.env.CANOPY_GIT_EXECUTABLE = '/opt/git/git';
    await register();

    expect(record({ redetect: await invoke('redetect') })).toMatchSnapshot();
  });
});

describe('host failures', () => {
  it.each(['status', 'redetect'] as const)(
    '%s rejects with the preference read error itself',
    async (channel) => {
      setPlatform('win32');
      const failure = errno('EIO', 'EIO: i/o error, read');
      mockReadPreferences.mockRejectedValue(failure);
      await register();

      await expect(invoke(channel)).rejects.toBe(failure);
      expect(record({})).toMatchSnapshot();
    },
  );
});
