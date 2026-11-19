import { createChildServices } from '../supervision/child';
import { createWindowsClosureWitness } from '../supervision/windows-closure';
import { GitIgnoreHostError } from '@canopy/core-runtime/node';
import { GitReadError, type GitReadCommand } from '../git-read/commands';
import {
  createGitReadHost,
  createGitReadHostWith,
  GIT_READ_SELECTION_LIMITS,
  type GitReadHostCleanupReport,
  type GitReadHostOptions,
} from '../git-read/host';
import type {
  GitReadOutput,
  GitReadRunner,
  GitReadRunnerOptions,
} from '../git-read/runner';
import * as packageIndex from '../index';
import {
  createWorld,
  DIVERGENCES,
  errno,
  fakeHost,
  type FakeHost,
  flush,
  LOGIN_SHELL,
  POSIX_PROBE_DIRECTORY,
  settle,
  snapshotFor,
  type World,
  WINDOWS_PROBE_DIRECTORY,
  worldIo,
  worldRunner,
} from './git-read-host-fakes';

const version = (value: string) =>
  ({ kind: 'executable', stdout: `git version ${value}\n` }) as const;
const SHIM = { kind: 'shim' } as const;
const neverAborted = (): AbortSignal => new AbortController().signal;
const kinds = (world: World): GitReadCommand['kind'][] =>
  world.probes.map(({ command }) => command.kind);
const ranCount = (world: World, executable: string): number =>
  world.ran.filter((ran) => ran === executable).length;
/** Probes started for `executable`, including any still held. */
const started = (world: World, executable: string): number =>
  world.probes.filter(
    ({ command }) =>
      'executable' in command && command.executable === executable,
  ).length;

/** Settles `'still pending'` after `ms`: the losing side of a bounded race. */
const pendingAfter = (ms: number): Promise<string> =>
  new Promise((done) => setTimeout(() => done('still pending'), ms));

function gate(): { readonly wait: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** A runner whose check-ignore settles as `outcome` says. */
function scriptedRunner(
  outcome: () => Promise<Set<string>>,
  idle: 'idle' | 'pending' = 'idle',
): {
  create: (options: GitReadRunnerOptions) => GitReadRunner;
  options?: GitReadRunnerOptions;
} {
  // prettier-ignore
  const holder: {
    create: (options: GitReadRunnerOptions) => GitReadRunner;
    options?: GitReadRunnerOptions;
  } = {
    create: (options) => {
      holder.options = options;
      return {
        run: () => Promise.reject(new Error('unused')),
        checkIgnoredPathsWith: () => Promise.reject(new Error('unused')),
        checkIgnoredPathsSelected: () => outcome(),
        listIgnoredPathsSelected: () => Promise.reject(new Error('unused')),
        whenIdle: () => Promise.resolve(idle),
      };
    },
  };
  return holder;
}

function request(
  saved: string | ((signal: AbortSignal) => Promise<string>),
  overrides: Record<string, unknown> = {},
): Parameters<
  ReturnType<typeof createGitReadHost>['port']['checkIgnoredPaths']
>[0] {
  // prettier-ignore
  return {
    root: '/repo',
    relativePaths: ['x'],
    readSavedExecutablePath:
      typeof saved === 'string' ? (): Promise<string> => Promise.resolve(saved) : saved,
    signal: neverAborted(),
    ...overrides,
  };
}

describe('createGitReadHost construction (R6 §2.5)', () => {
  it('is exported from the package index', () => {
    expect(packageIndex.createGitReadHost).toBe(createGitReadHost);
  });

  // CAN-7113: an unusable environment has its own code.
  it.each<[string, Record<string, unknown>, string]>([
    ['an unsupported OS', { os: 'aix' }, 'invalid_request'],
    ['a null environment', { environment: null }, 'environment_invalid'],
    ['a non-string environment value', { environment: { PATH: 1 } }, 'environment_invalid'], // prettier-ignore
    ['a relative probe directory', { probeDirectory: 'relative' }, 'invalid_request'], // prettier-ignore
    [
      'an environment that throws when read',
      {
        environment: new Proxy(
          {},
          {
            ownKeys(): never {
              throw new Error('unreadable');
            },
          },
        ),
      },
      'environment_invalid',
    ],
  ])(
    'never throws and does no I/O for %s; requests reject with its code',
    async (_, overrides, code) => {
      const touched: string[] = [];
      const touch = (name: string) => (): never => {
        touched.push(name);
        throw new Error(name);
      };
      const options: GitReadHostOptions = {
        os: 'linux',
        environment: { PATH: '/usr/bin' },
        probeDirectory: '/data',
      };
      // Untyped callers: the overrides break the declared types.
      Object.assign(options, overrides);
      const host = createGitReadHostWith(options, {
        io: { stat: touch('stat'), realpath: touch('realpath'), access: touch('access') }, // prettier-ignore
        userInfo: touch('userInfo'),
        uid: touch('uid'),
        createRunner: touch('createRunner'),
        now: touch('now'),
      });
      expect(touched).toEqual([]);
      const reads: string[] = [];
      const outcome = await settle(
        host.port.checkIgnoredPaths(
          request(() => {
            reads.push('saved');
            return Promise.resolve('');
          }),
        ),
      );
      expect(outcome).toMatchObject({ error: { code } });
      expect(reads).toEqual([]);
      expect(() => host.prewarm()).not.toThrow();
      expect(host.lastFailure()).toBe(code);
      await expect(host.stop(neverAborted())).resolves.toEqual({ state: 'stopped' }); // prettier-ignore
      expect(touched).toEqual([]);
    },
  );

  it('never throws for options whose getters throw, and reads each once', async () => {
    const reads: string[] = [];
    const options: GitReadHostOptions = {
      os: 'linux',
      environment: {},
      probeDirectory: '/data',
    };
    // Untyped callers: every option becomes a throwing getter.
    for (const key of ['os', 'environment', 'probeDirectory', 'onCleanupReport']) // prettier-ignore
      Object.defineProperty(options, key, {
        get: (): never => {
          reads.push(key);
          throw new Error(key);
        },
      });
    const host = createGitReadHost(options);
    expect(reads.sort()).toEqual(['environment', 'onCleanupReport', 'os', 'probeDirectory']); // prettier-ignore
    const outcome = await settle(host.port.checkIgnoredPaths(request('')));
    expect(outcome).toEqual({ error: new GitIgnoreHostError('invalid_request') }); // prettier-ignore
    expect(reads).toHaveLength(4);
  });

  it('copies the snapshot once and drops undefined values', async () => {
    const environment: Record<string, string | undefined> = {
      ...snapshotFor('linux'),
      CANOPY_GIT_EXECUTABLE: '/env/git',
      DROPPED: undefined,
    };
    const world = createWorld('linux', { filesystem: { '/env/git': version('2.44.0') } }); // prettier-ignore
    const { resolve } = fakeHost(world, { environment });
    environment.CANOPY_GIT_EXECUTABLE = '/changed/git';
    await expect(resolve('')).resolves.toEqual({ resolved: '/env/git' });
    expect(world.probes.every(({ environment: env }) => !('DROPPED' in env))).toBe(true); // prettier-ignore
  });
});

describe('createGitReadHost requests', () => {
  it('returns an empty set for no paths without reading the saved value or probing', async () => {
    const world = createWorld('linux');
    const { host } = fakeHost(world);
    const reads: string[] = [];
    const result = await host.port.checkIgnoredPaths(
      request(
        () => {
          reads.push('read');
          return Promise.resolve('/git');
        },
        { relativePaths: [] },
      ),
    );
    expect(result).toEqual(new Set());
    expect(reads).toEqual([]);
    expect(world.probes).toEqual([]);
  });

  it('rejects a pre-aborted request with its reason, before anything else', async () => {
    const world = createWorld('linux');
    const { host } = fakeHost(world);
    const reason = { aborted: 'early' };
    const reads: string[] = [];
    const outcome = await settle(
      host.port.checkIgnoredPaths(
        request(
          () => {
            reads.push('read');
            return Promise.resolve('');
          },
          { signal: AbortSignal.abort(reason) },
        ),
      ),
    );
    expect(outcome).toEqual({ error: reason });
    expect(reads).toEqual([]);
    expect(host.lastFailure()).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ['a missing signal', { signal: undefined }],
    ['non-array paths', { relativePaths: 'x' }],
    ['a missing saved reader', { readSavedExecutablePath: undefined }],
    ['a non-string root', { root: 1 }],
  ])('rejects %s with invalid_request', async (_, overrides) => {
    const { host } = fakeHost(createWorld('linux'));
    const outcome = await settle(
      Promise.resolve<unknown>(
        Reflect.apply(host.port.checkIgnoredPaths, undefined, [
          request('', overrides),
        ]),
      ),
    );
    expect(outcome).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('reads each request field once, so a throwing or changing getter never surfaces', async () => {
    const world = createWorld('linux', { filesystem: { '/usr/bin/git': version('2.43.0') } }); // prettier-ignore
    const { host } = fakeHost(world);
    const reads: string[] = [];
    const fields: Record<string, unknown> = {
      root: '/repo',
      relativePaths: ['x'],
      readSavedExecutablePath: (): Promise<string> => Promise.resolve(''),
      signal: neverAborted(),
    };
    const counted = {};
    for (const [key, value] of Object.entries(fields))
      Object.defineProperty(counted, key, {
        get: (): unknown => {
          reads.push(key);
          if (reads.filter((read) => read === key).length > 1)
            throw new Error(`${key} read twice`);
          return value;
        },
      });
    const outcome = await settle(
      Promise.resolve<unknown>(
        Reflect.apply(host.port.checkIgnoredPaths, undefined, [counted]),
      ),
    );
    expect(outcome).toEqual({ value: new Set(['/usr/bin/git']) });
    expect(reads.sort()).toEqual(['readSavedExecutablePath', 'relativePaths', 'root', 'signal']); // prettier-ignore
    const throwing = {};
    Object.defineProperty(throwing, 'signal', {
      get: (): never => {
        throw new Error('/secret/signal');
      },
    });
    await expect(
      Promise.resolve<unknown>(
        Reflect.apply(host.port.checkIgnoredPaths, undefined, [throwing]),
      ),
    ).rejects.toEqual(new GitIgnoreHostError('invalid_request'));
  });

  it('rejects a saved value that is not a string with invalid_request', async () => {
    const { host } = fakeHost(createWorld('linux'));
    // An untyped caller: the reader resolves a number.
    const untyped = Object.assign(request(''), {
      readSavedExecutablePath: (): Promise<number> => Promise.resolve(1),
    });
    const outcome = await settle(host.port.checkIgnoredPaths(untyped));
    expect(outcome).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('maps a failing saved read to git_unavailable, never the raw error', async () => {
    const { host } = fakeHost(createWorld('linux'));
    const outcome = await settle(
      host.port.checkIgnoredPaths(
        request(() => Promise.reject(new Error('/secret/preferences.json'))),
      ),
    );
    expect(outcome).toEqual({ error: new GitIgnoreHostError('git_unavailable') }); // prettier-ignore
  });

  it.each<[string, () => unknown, string]>([
    ['command_not_found', (): unknown => new GitReadError('command_not_found'), 'git_unavailable'], // prettier-ignore
    ['a spawn error with no pid', (): unknown => errno('ENOENT', 'spawn /git'), 'git_unavailable'], // prettier-ignore
    ['a stdin EPIPE', (): unknown => errno('EPIPE', 'write'), 'exit_status'],
    ['timeout', (): unknown => new GitReadError('timeout'), 'timeout'],
    ['deadline_exceeded', (): unknown => new GitReadError('deadline_exceeded'), 'deadline_exceeded'], // prettier-ignore
    [
      'output_limit',
      (): unknown => new GitReadError('output_limit'),
      'output_limit',
    ],
    [
      'exit_status',
      (): unknown => new GitReadError('exit_status'),
      'exit_status',
    ],
    ['cleanup_unconfirmed', (): unknown => new GitReadError('cleanup_unconfirmed'), 'cleanup_unconfirmed'], // prettier-ignore
    ['invalid_request', (): unknown => new GitReadError('invalid_request'), 'invalid_request'], // prettier-ignore
    ['unsupported_command', (): unknown => new GitReadError('unsupported_command'), 'unsupported_command'], // prettier-ignore
    ['a host error', (): unknown => new GitIgnoreHostError('selection_rejected'), 'selection_rejected'], // prettier-ignore
  ])('maps a runner %s to its host code', async (_, failure, code) => {
    const runner = scriptedRunner(() =>
      Promise.resolve().then((): never => {
        throw failure();
      }),
    );
    const { host } = fakeHost(createWorld('linux'), {}, { createRunner: runner.create }); // prettier-ignore
    const outcome = await settle(host.port.checkIgnoredPaths(request('')));
    expect(outcome).toEqual({ error: new GitIgnoreHostError(code as never) });
    expect(Reflect.get(Object(Reflect.get(Object(outcome), 'error')), 'message')).not.toMatch(/git|spawn/); // prettier-ignore
    expect(host.lastFailure()).toBe(code);
  });

  it.each(['abort', 'stop'] as const)(
    'settles at a %s while the saved value is still being read, through the production runner',
    async (ending) => {
      const os = process.platform === 'win32' ? 'win32' : 'linux';
      const world = createWorld(os);
      const { host } = fakeHost(world, {}, { createRunner: undefined });
      const controller = new AbortController();
      const reason = new Error('client gone');
      const seen: AbortSignal[] = [];
      const pending = settle(
        host.port.checkIgnoredPaths(
          request(
            (signal: AbortSignal) => {
              seen.push(signal);
              return new Promise<string>(() => undefined);
            },
            {
              root: os === 'win32' ? 'C:\\repo' : '/repo',
              signal: controller.signal,
            },
          ),
        ),
      );
      await flush();
      expect(seen).toHaveLength(1);
      if (ending === 'abort') controller.abort(reason);
      else void host.stop(neverAborted());
      expect(await pending).toEqual({
        error: ending === 'abort' ? reason : new GitIgnoreHostError('stopped'),
      });
      expect(seen[0]?.aborted).toBe(true);
      expect(host.lastFailure()).toBe(ending === 'abort' ? null : 'stopped');
    },
  );

  it('rejects with the request abort reason even when the runner failed first', async () => {
    const controller = new AbortController();
    const reason = new Error('client gone');
    const runner = scriptedRunner(() => {
      controller.abort(reason);
      return Promise.reject(new GitReadError('cleanup_unconfirmed'));
    });
    const { host } = fakeHost(createWorld('linux'), {}, { createRunner: runner.create }); // prettier-ignore
    const outcome = await settle(
      host.port.checkIgnoredPaths(request('', { signal: controller.signal })),
    );
    expect(outcome).toEqual({ error: reason });
    expect(host.lastFailure()).toBeNull();
  });

  it('records the last failure and clears it on success', async () => {
    const world = createWorld('linux', { filesystem: {} });
    const { host, resolve } = fakeHost(world);
    expect(host.lastFailure()).toBeNull();
    await expect(resolve('')).resolves.toMatchObject({ failure: 'git_unavailable' }); // prettier-ignore
    expect(host.lastFailure()).toBe('git_unavailable');
    world.filesystem['/usr/bin/git'] = version('2.43.0');
    await expect(resolve('')).resolves.toEqual({ resolved: '/usr/bin/git' });
    expect(host.lastFailure()).toBeNull();
  });

  it('gives the runner one 30 s request deadline and the snapshot environment', async () => {
    const world = createWorld('linux', { filesystem: { '/usr/bin/git': version('2.43.0') } }); // prettier-ignore
    const seen: { deadlineAt: number; environment: unknown; cwd: string }[] =
      [];
    const base = worldRunner(world);
    const { host } = fakeHost(
      world,
      {},
      {
        createRunner: (options) => {
          const runner = base(options);
          return {
            ...runner,
            checkIgnoredPathsSelected: (selection): Promise<Set<string>> => {
              seen.push(selection);
              return runner.checkIgnoredPathsSelected(selection);
            },
          };
        },
      },
    );
    const before = performance.now();
    await host.port.checkIgnoredPaths(request(''));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cwd).toBe('/repo');
    expect(seen[0]?.environment).toEqual(snapshotFor('linux'));
    expect(seen[0]?.deadlineAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(seen[0]?.deadlineAt).toBeLessThan(performance.now() + 30_000 + 1);
  });

  it('reads the saved value before each chunk and selects with it', async () => {
    const world = createWorld('linux', {
      filesystem: { '/a/git': version('2.45.0'), '/b/git': version('2.46.0') },
    });
    const { host } = fakeHost(world);
    const values = ['/a/git', '/b/git', '/b/git'];
    const reads: string[] = [];
    const result = await host.port.checkIgnoredPaths(
      request(
        () => {
          const value = values[reads.length] ?? '';
          reads.push(value);
          return Promise.resolve(value);
        },
        { relativePaths: Array.from({ length: 10_001 }, (_, i) => `p${i}`) },
      ),
    );
    expect(reads).toEqual(['/a/git', '/b/git', '/b/git']);
    expect(world.checks.map(({ executable }) => executable)).toEqual(['/a/git', '/b/git', '/b/git']); // prettier-ignore
    expect(result).toEqual(new Set(['/a/git', '/b/git']));
  });

  it('keeps a validated selection on its fast path without new probes', async () => {
    const world = createWorld('darwin', {
      filesystem: {
        '/usr/bin/git': SHIM,
        '/opt/git/bin/git': version('2.51.0'),
      },
    });
    const { resolve } = fakeHost(world);
    await expect(resolve('/opt/git/bin/git')).resolves.toEqual({ resolved: '/opt/git/bin/git' }); // prettier-ignore
    const probes = world.probes.length;
    await expect(resolve('/opt/git/bin/git')).resolves.toEqual({ resolved: '/opt/git/bin/git' }); // prettier-ignore
    expect(world.probes.length).toBe(probes);
  });

  it.each(['ENOENT', 'ENOTDIR'])(
    'reselects when the fast path finds %s',
    async (code) => {
      const world = createWorld('linux', {
        loginPath: '/a/bin:/usr/bin',
        filesystem: { '/a/bin/git': version('2.47.1'), '/usr/bin/git': version('2.43.0') }, // prettier-ignore
      });
      const { resolve } = fakeHost(
        world,
        {},
        {
          io: {
            stat: (target) =>
            target === '/a/bin/git' && world.checks.length > 0
              ? Promise.reject(errno(code))
              : Promise.resolve({ dev: 1, ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1, isFile: () => true }), // prettier-ignore
            realpath: (target) => Promise.resolve(target),
            access: () => Promise.resolve(),
          },
        },
      );
      await expect(resolve('')).resolves.toEqual({ resolved: '/a/bin/git' });
      await expect(resolve('')).resolves.toEqual({ resolved: '/usr/bin/git' });
    },
  );

  it.each(['linux', 'win32'] as const)(
    'surfaces any other fast-path lookup error as selection_rejected (%s)',
    async (os) => {
      const selected = os === 'win32' ? 'C:\\Git\\cmd\\git.exe' : '/opt/git';
      const world = createWorld(os, { filesystem: { [selected]: version('2.45.0') } }); // prettier-ignore
      const { resolve } = fakeHost(world);
      await expect(resolve(selected)).resolves.toEqual({ resolved: selected });
      world.filesystem[selected] = { kind: 'eacces' };
      await expect(resolve(selected)).resolves.toEqual({
        resolved: null,
        failure: 'selection_rejected',
      });
    },
  );

  it('preserves an inaccessible saved Windows selection instead of spawning a fallback', async () => {
    const saved = 'C:\\Saved Git\\git.exe';
    const fallback = 'C:\\Found Git\\git.exe';
    const world = createWorld('win32', {
      filesystem: { [saved]: version('2.48.0'), [fallback]: version('2.49.0') },
      whereExe: { git: `${fallback}\r\n` },
    });
    const { resolve } = fakeHost(world);
    await expect(resolve(saved)).resolves.toEqual({ resolved: saved });
    const probes = world.probes.length;
    world.filesystem[saved] = { kind: 'eacces' };
    await expect(resolve(saved)).resolves.toEqual({
      resolved: null,
      failure: 'selection_rejected',
    });
    expect(world.probes).toHaveLength(probes);
    expect(world.chosen).toEqual([saved]);
  });

  // The Win32 fsmonitor discharge is planned from this version.
  it('gives each chunk the version validation parsed, only while the file is unchanged', async () => {
    const saved = 'C:\\Git\\cmd\\git.exe';
    const discovered = 'C:\\Found\\cmd\\git.exe';
    const world = createWorld('win32', {
      filesystem: {
        [saved]: version('2.35.1.windows.1'),
        [discovered]: version('2.47.1.windows.2'),
      },
      whereExe: { git: `${discovered}\r\n` },
    });
    const { resolve } = fakeHost(world);
    await resolve(saved);
    await resolve('');
    await resolve('');
    // Replaced in place: the fast path keeps the path, as desktop, but no
    // longer knows its version.
    world.filesystem[discovered] = version('2.57.0.windows.1');
    await resolve('');
    // A saved value's identity is part of its key, so it is validated again.
    world.filesystem[saved] = version('2.47.1.windows.2');
    await resolve(saved);
    expect(
      world.checks.map((check) => [check.executable, check.version]),
    ).toEqual([
      // prettier-ignore
      [saved, 'git version 2.35.1.windows.1'],
      [discovered, 'git version 2.47.1.windows.2'],
      [discovered, 'git version 2.47.1.windows.2'],
      [discovered, undefined],
      [saved, 'git version 2.47.1.windows.2'],
    ]);
    expect(ranCount(world, discovered)).toBe(1);
  });

  it('keeps an override-selected Linux Git on its fast path and surfaces EACCES there', async () => {
    const world = createWorld('linux', { filesystem: { '/env/git': version('2.44.0') } }); // prettier-ignore
    const { resolve } = fakeHost(world, {
      environment: snapshotFor('linux', { CANOPY_GIT_EXECUTABLE: '/env/git' }),
    });
    await expect(resolve('')).resolves.toEqual({ resolved: '/env/git' });
    world.filesystem['/env/git'] = { kind: 'noexec' };
    await expect(resolve('')).resolves.toEqual({
      resolved: null,
      failure: 'selection_rejected',
    });
  });

  it('validates the macOS bare-init smoke under the snapshot TMPDIR, else /tmp', async () => {
    const roots: string[] = [];
    for (const TMPDIR of ['/var/tmp/daemon', 'relative', undefined]) {
      const world = createWorld('darwin', { filesystem: { '/opt/git': version('2.51.0') } }); // prettier-ignore
      const { resolve } = fakeHost(world, {
        environment: snapshotFor('darwin', { TMPDIR }),
      });
      await resolve('/opt/git');
      for (const { command } of world.probes)
        if (command.kind === 'git-bare-init-smoke')
          roots.push(command.temporaryRoot);
    }
    expect(roots).toEqual(['/var/tmp/daemon', '/tmp', '/tmp']);
  });
});

describe('createGitReadHost selections (Git receipt)', () => {
  const NONE = { selections: [], overflow: false };
  const pairs = (host: FakeHost['host']): [string, string | null][] =>
    host.selections().selections.map(({ executable, version }) => [executable, version]); // prettier-ignore

  it('reports each distinct Git handed to check-ignore, in first-use order, as each chunk ran it', async () => {
    const saved = 'C:\\Git\\cmd\\git.exe';
    const discovered = 'C:\\Found\\cmd\\git.exe';
    const world = createWorld('win32', {
      filesystem: {
        [saved]: version('2.35.1.windows.1'),
        [discovered]: version('2.47.1.windows.2'),
      },
      whereExe: { git: `${discovered}\r\n` },
    });
    const { host, resolve } = fakeHost(world);
    expect(host.selections()).toEqual(NONE);
    await resolve(saved);
    await resolve('');
    await resolve('');
    // Replaced in place: the chunk ran it without a validated version.
    world.filesystem[discovered] = version('2.57.0.windows.1');
    await resolve('');
    expect(pairs(host)).toEqual([
      [saved, 'git version 2.35.1.windows.1'],
      [discovered, 'git version 2.47.1.windows.2'],
      [discovered, null],
    ]);
    expect(
      world.checks.map(({ executable, version: v }) => [executable, v ?? null]),
    ).toEqual(
      // prettier-ignore
      [
        [saved, 'git version 2.35.1.windows.1'],
        [discovered, 'git version 2.47.1.windows.2'],
        [discovered, 'git version 2.47.1.windows.2'],
        [discovered, null],
      ],
    );
    expect(host.selections().overflow).toBe(false);
  });

  it('reports a silent fallback from a saved Git production refuses (macOS shim)', async () => {
    const world = createWorld('darwin', {
      loginPath: '/opt/homebrew/bin:/usr/bin',
      filesystem: {
        '/usr/bin/git': SHIM,
        '/opt/homebrew/bin/git': version('2.51.0'),
      },
    });
    const { host, resolve } = fakeHost(world);
    await expect(resolve('/usr/bin/git')).resolves.toEqual({ resolved: '/opt/homebrew/bin/git' }); // prettier-ignore
    expect(pairs(host)).toEqual([['/opt/homebrew/bin/git', 'git version 2.51.0']]); // prettier-ignore
  });

  it('reports the unvalidated Linux snapshot Git on an unsupported architecture with no version', async () => {
    const { host, resolve } = fakeHost(createWorld('linux'), {}, { arch: 'ppc64' }); // prettier-ignore
    await expect(resolve('/saved/git')).resolves.toEqual({ resolved: 'git' });
    expect(pairs(host)).toEqual([['git', null]]);
  });

  it('records nothing for a failed selection, an empty request or a host that never got ready', async () => {
    const world = createWorld('linux');
    const { host, resolve } = fakeHost(world);
    await expect(resolve('/missing/git')).resolves.toEqual({
      resolved: null,
      failure: 'git_unavailable',
    });
    await host.port.checkIgnoredPaths(request('/missing/git', { relativePaths: [] })); // prettier-ignore
    expect(host.selections()).toEqual(NONE);
    const unready = createGitReadHost({ os: 'linux', environment: {}, probeDirectory: 'relative' }); // prettier-ignore
    await settle(unready.port.checkIgnoredPaths(request('')));
    expect(unready.selections()).toEqual(NONE);
  });

  it('keeps at most the limit of distinct Gits and over-long fields out, marking overflow', async () => {
    const { selections: limit, executableLength, versionLength } = GIT_READ_SELECTION_LIMITS; // prettier-ignore
    const paths = Array.from({ length: limit + 1 }, (_, i) => `/g${i}/git`);
    const long = `/${'x'.repeat(executableLength)}/git`;
    const world = createWorld('linux', {
      filesystem: {
        ...Object.fromEntries(paths.map((path) => [path, version('2.47.1')])),
        [long]: version('2.47.1'),
        '/long-version/git': version(`2.47.1.${'9'.repeat(versionLength)}`),
      },
    });
    const { host, resolve } = fakeHost(world);
    await resolve(long);
    await resolve('/long-version/git');
    expect(host.selections()).toEqual({ selections: [], overflow: true });
    for (const path of paths) await resolve(path);
    // Repeats of a kept Git neither grow the report nor count against it.
    await resolve(paths[0] ?? '');
    const report = host.selections();
    expect(report.selections.map(({ executable }) => executable)).toEqual(paths.slice(0, limit)); // prettier-ignore
    expect(report.overflow).toBe(true);
    // Each check-ignore still ran its own selection.
    expect(world.checks.map(({ executable }) => executable)).toEqual([long, '/long-version/git', ...paths, paths[0]]); // prettier-ignore
  });

  it('records no Git a chunk chose after its runner stopped waiting', async () => {
    const world = createWorld('linux', { filesystem: { '/a/git': version('2.45.0') } }); // prettier-ignore
    const held = gate();
    world.gates.set('/a/git', held.wait);
    const { host, resolve } = fakeHost(world);
    const abandoned = new AbortController();
    const pending = settle(
      host.port.checkIgnoredPaths(
        request('/a/git', { signal: abandoned.signal }),
      ),
    );
    while (started(world, '/a/git') === 0) await flush(1);
    const reason = new Error('gone');
    abandoned.abort(reason);
    await expect(pending).resolves.toEqual({ error: reason });
    // The shared detection still validates and hands the chunk its Git.
    held.open();
    while (ranCount(world, '/a/git') === 0) await flush(1);
    await flush();
    expect(host.selections()).toEqual(NONE);
    expect(world.checks).toEqual([]);
    // A later chunk that runs it is recorded.
    await expect(resolve('/a/git')).resolves.toEqual({ resolved: '/a/git' });
    expect(pairs(host)).toEqual([['/a/git', 'git version 2.45.0']]);
  });

  it('records no Git whose check-ignore was aborted or failed to spawn after selection', async () => {
    const world = createWorld('linux', { filesystem: { '/a/git': version('2.45.0') } }); // prettier-ignore
    const { host, resolve } = fakeHost(world);
    // Aborted between selection and start.
    const held = gate();
    world.gates.set('git-check-ignore', held.wait);
    const abandoned = new AbortController();
    const pending = settle(
      host.port.checkIgnoredPaths(
        request('/a/git', { signal: abandoned.signal }),
      ),
    );
    while (world.chosen.length === 0) await flush(1);
    const reason = new Error('gone');
    abandoned.abort(reason);
    held.open();
    await expect(pending).resolves.toEqual({ error: reason });
    world.gates.delete('git-check-ignore');
    // Selected, then refused at spawn.
    world.unspawnable.add('/a/git');
    await expect(resolve('/a/git')).resolves.toEqual({
      resolved: null,
      failure: 'git_unavailable',
    });
    expect(world.chosen).toEqual(['/a/git', '/a/git']);
    expect(world.checks).toEqual([]);
    expect(host.selections()).toEqual(NONE);
    // Once its check-ignore starts, it is recorded.
    world.unspawnable.clear();
    await expect(resolve('/a/git')).resolves.toEqual({ resolved: '/a/git' });
    expect(pairs(host)).toEqual([['/a/git', 'git version 2.45.0']]);
  });

  it('returns a frozen snapshot that later selections and callers cannot change', async () => {
    const world = createWorld('linux', { filesystem: { '/a/git': version('2.45.0'), '/b/git': version('2.46.0') } }); // prettier-ignore
    const { host, resolve } = fakeHost(world);
    await resolve('/a/git');
    const first = host.selections();
    await resolve('/b/git');
    expect(first.selections).toHaveLength(1);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.selections)).toBe(true);
    expect(Object.isFrozen(first.selections[0])).toBe(true);
    expect(pairs(host)).toEqual([
      ['/a/git', 'git version 2.45.0'],
      ['/b/git', 'git version 2.46.0'],
    ]);
  });

  it('is exported from the package index with its limits', () => {
    expect(packageIndex.GIT_READ_SELECTION_LIMITS).toBe(
      GIT_READ_SELECTION_LIMITS,
    );
    expect(GIT_READ_SELECTION_LIMITS).toEqual({ selections: 4, executableLength: 4096, versionLength: 256 }); // prettier-ignore
  });
});

describe('createGitReadHost login PATH', () => {
  it('macOS: a cold detection uses the snapshot PATH and refreshes in the background', async () => {
    const world = createWorld('darwin', {
      loginPath: '/login/bin',
      filesystem: { '/login/bin/git': version('2.50.0'), '/snap/bin/git': version('2.49.0') }, // prettier-ignore
    });
    const { resolve } = fakeHost(world, {
      environment: snapshotFor('darwin', { PATH: '/snap/bin' }),
    });
    await expect(resolve('')).resolves.toEqual({ resolved: '/snap/bin/git' });
    expect(kinds(world)).toContain('macos-login-shell-path');
    await flush();
    world.filesystem['/snap/bin/git'] = { kind: 'missing' };
    await expect(resolve('')).resolves.toEqual({ resolved: '/login/bin/git' });
  });

  it('macOS: refreshes a login PATH older than five minutes while using it', async () => {
    const world = createWorld('darwin', { filesystem: {} });
    const { host, clock, resolve } = fakeHost(world);
    host.prewarm();
    await flush();
    host.prewarm();
    await flush();
    const refreshes = (): number =>
      kinds(world).filter((kind) => kind === 'macos-login-shell-path').length;
    expect(refreshes()).toBe(1);
    clock.now += 5 * 60_000;
    await resolve('');
    expect(refreshes()).toBe(2);
  });

  it.each(['x64', 'arm64'])(
    'Linux %s: detection awaits the login refresh before any candidate',
    async (arch) => {
      const world = createWorld('linux', {
        loginPath: '/login/bin',
        filesystem: { '/login/bin/git': version('2.47.0') },
      });
      const held = gate();
      world.gates.set('linux-login-shell-path', held.wait);
      const { resolve } = fakeHost(world, {}, { arch });
      const pending = resolve('');
      await flush();
      expect(world.ran).toEqual([]);
      held.open();
      await expect(pending).resolves.toEqual({ resolved: '/login/bin/git' });
    },
  );

  it.each(['x64', 'arm64'])(
    'Linux %s: the snapshot SHELL, then the getent shell, then /bin/bash',
    async (arch) => {
      const shellsFor = async (
        environment: Record<string, string | undefined>,
        getent: string | undefined,
        executable: string[],
      ): Promise<string[]> => {
        const world = createWorld('linux', { getent });
        for (const shell of executable) world.filesystem[shell] = version('0');
        const { host } = fakeHost(world, { environment: snapshotFor('linux', environment) }, { arch }); // prettier-ignore
        host.prewarm();
        await flush();
        return world.probes.flatMap(({ command }) =>
          command.kind === 'linux-login-shell-path' ? [command.shell] : [],
        );
      };
      // The login marker parses, so the first executable shell answers.
      expect(await shellsFor({ SHELL: ` ${LOGIN_SHELL} ` }, undefined, [])).toEqual([LOGIN_SHELL]); // prettier-ignore
      expect(
        await shellsFor({ SHELL: undefined }, 'me:x:501:20::/home/me:/usr/bin/fish\n', ['/usr/bin/fish']), // prettier-ignore
      ).toEqual(['/usr/bin/fish']);
      expect(
        await shellsFor({ SHELL: undefined }, 'me:x:502:20::/home/me:/usr/bin/fish\n', ['/usr/bin/fish', '/bin/bash']), // prettier-ignore
      ).toEqual(['/bin/bash']);
      expect(await shellsFor({ SHELL: '/missing/sh' }, undefined, ['/bin/bash'])).toEqual(['/bin/bash']); // prettier-ignore
    },
  );

  it.each([
    ['linux', 'ppc64', []],
    ['linux', 'arm64', ['linux-login-shell-path']],
    ['win32', 'x64', []],
    ['darwin', 'arm64', ['macos-login-shell-path']],
    ['linux', 'x64', ['linux-login-shell-path']],
  ] as const)('prewarm on %s %s starts %j', async (os, arch, expected) => {
    const world = createWorld(os);
    const { host } = fakeHost(world, {}, { arch });
    host.prewarm();
    await flush();
    expect(kinds(world).filter((kind) => kind.endsWith('login-shell-path'))).toEqual(expected); // prettier-ignore
  });

  it('prewarm never throws, even when the runner does', () => {
    const { host } = fakeHost(
      createWorld('darwin'),
      {},
      {
        createRunner: () => {
          throw new Error('broken runner');
        },
      },
    );
    expect(() => host.prewarm()).not.toThrow();
  });
});

describe('createGitReadHost shared detection', () => {
  it('is single-flight per saved value and identity, and a superseded detection never records', async () => {
    const world = createWorld('linux', {
      filesystem: { '/s1/git': { kind: 'executable', stdout: 'not git\n' }, '/s2/git': version('2.45.0') }, // prettier-ignore
    });
    const held = gate();
    world.gates.set('/s1/git', held.wait);
    const { resolve } = fakeHost(world);
    const first = resolve('/s1/git');
    const joined = resolve('/s1/git');
    await flush();
    expect(started(world, '/s1/git')).toBe(1);
    // A newer key supersedes the held detection.
    await expect(resolve('/s2/git')).resolves.toEqual({ resolved: '/s2/git' });
    held.open();
    await expect(first).resolves.toEqual({ resolved: null, failure: 'git_unavailable' }); // prettier-ignore
    await expect(joined).resolves.toEqual({ resolved: null, failure: 'git_unavailable' }); // prettier-ignore
    expect(started(world, '/s1/git')).toBe(1);
    // Superseded: the newer selection stands and keeps its fast path.
    const s2Runs = started(world, '/s2/git');
    await expect(resolve('/s2/git')).resolves.toEqual({ resolved: '/s2/git' });
    expect(started(world, '/s2/git')).toBe(s2Runs);
    // Superseded: no rejection was recorded, so /s1/git is validated again.
    await resolve('/s1/git');
    expect(started(world, '/s1/git')).toBe(2);
    // A current detection does record it.
    await resolve('/s1/git');
    expect(started(world, '/s1/git')).toBe(2);
  });

  it('joins a pending detection after another key started (A, B, A), and only the detection serving the latest request records', async () => {
    const world = createWorld('linux', {
      filesystem: { '/s1/git': version('2.45.0'), '/s2/git': version('2.46.0') }, // prettier-ignore
    });
    const heldA = gate();
    const heldB = gate();
    world.gates.set('/s1/git', heldA.wait);
    world.gates.set('/s2/git', heldB.wait);
    const { resolve } = fakeHost(world);
    const first = resolve('/s1/git');
    await flush();
    const second = resolve('/s2/git');
    await flush();
    const third = resolve('/s1/git');
    await flush();
    expect(started(world, '/s1/git')).toBe(1);
    expect(started(world, '/s2/git')).toBe(1);
    heldB.open();
    await expect(second).resolves.toEqual({ resolved: '/s2/git' });
    heldA.open();
    await expect(first).resolves.toEqual({ resolved: '/s1/git' });
    await expect(third).resolves.toEqual({ resolved: '/s1/git' });
    expect(started(world, '/s1/git')).toBe(1);
    // The rejoined detection serves the latest request: it records, and its
    // selection keeps the fast path.
    await expect(resolve('/s1/git')).resolves.toEqual({ resolved: '/s1/git' });
    expect(started(world, '/s1/git')).toBe(1);
    // The rejoin superseded B, which recorded nothing.
    await expect(resolve('/s2/git')).resolves.toEqual({ resolved: '/s2/git' });
    expect(started(world, '/s2/git')).toBe(2);
  });

  it('a request kept by the fast path (A accepted, B pending, A) supersedes B: its failure leaves the selection and the overlay unchanged', async () => {
    const world = createWorld('linux', {
      filesystem: { '/s1/git': version('2.45.0'), '/s2/git': { kind: 'executable', stdout: 'not git\n' } }, // prettier-ignore
    });
    const heldB = gate();
    world.gates.set('/s2/git', heldB.wait);
    const { resolve } = fakeHost(world);
    await expect(resolve('/s1/git')).resolves.toEqual({ resolved: '/s1/git' });
    const second = resolve('/s2/git');
    await flush();
    expect(started(world, '/s2/git')).toBe(1);
    await expect(resolve('/s1/git')).resolves.toEqual({ resolved: '/s1/git' });
    heldB.open();
    await expect(second).resolves.toEqual({ resolved: null, failure: 'git_unavailable' }); // prettier-ignore
    // A's selection stands and keeps its fast path.
    await expect(resolve('/s1/git')).resolves.toEqual({ resolved: '/s1/git' });
    expect(started(world, '/s1/git')).toBe(1);
    // No rejection was recorded, so /s2/git is validated again.
    await resolve('/s2/git');
    expect(started(world, '/s2/git')).toBe(2);
  });

  it('Linux x64: a request kept by the fast path supersedes a pending discovery: it neither selects nor caches its result', async () => {
    const world = createWorld('linux', {
      loginPath: '/login/bin',
      filesystem: { '/s1/git': version('2.45.0'), '/login/bin/git': version('2.46.0') }, // prettier-ignore
    });
    const heldB = gate();
    world.gates.set('/login/bin/git', heldB.wait);
    const { clock, resolve } = fakeHost(world);
    await expect(resolve('/s1/git')).resolves.toEqual({ resolved: '/s1/git' });
    const second = resolve('');
    await flush();
    expect(started(world, '/login/bin/git')).toBe(1);
    await expect(resolve('/s1/git')).resolves.toEqual({ resolved: '/s1/git' });
    heldB.open();
    await expect(second).resolves.toEqual({ resolved: '/login/bin/git' });
    // A's selection stands and keeps its fast path.
    await expect(resolve('/s1/git')).resolves.toEqual({ resolved: '/s1/git' });
    expect(started(world, '/s1/git')).toBe(1);
    // Nothing was cached: discovery uses the refreshed login PATH rather than
    // re-validating the superseded discovery first.
    world.loginPath = '/other/bin';
    world.filesystem['/other/bin/git'] = version('2.47.0');
    clock.now += 5 * 60_000 + 1;
    await expect(resolve('')).resolves.toEqual({ resolved: '/other/bin/git' });
    expect(started(world, '/login/bin/git')).toBe(1);
  });

  it('a detection started by an older request after a newer request established its key records nothing', async () => {
    const world = createWorld('linux', {
      filesystem: { '/s1/git': version('2.45.0'), '/s2/git': version('2.46.0') }, // prettier-ignore
    });
    const held = gate();
    const base = worldIo(world);
    let holdNext = false;
    const { resolve } = fakeHost(
      world,
      {},
      {
        io: {
          ...base,
          access: async (target) => {
            if (holdNext && target === '/s1/git') {
              holdNext = false;
              await held.wait;
            }
            return base.access(target);
          },
        },
      },
    );
    await expect(resolve('/s1/git')).resolves.toEqual({ resolved: '/s1/git' });
    // The older request stalls in its fast path; the newer one selects B.
    holdNext = true;
    const older = resolve('/s1/git');
    await flush();
    await expect(resolve('/s2/git')).resolves.toEqual({ resolved: '/s2/git' });
    // The older request's fast path then fails and it detects A, which fails.
    world.filesystem['/s1/git'] = { kind: 'missing' };
    held.open();
    await expect(older).resolves.toEqual({ resolved: null, failure: 'git_unavailable' }); // prettier-ignore
    // That detection did not serve the latest request: B stands.
    const s2Runs = started(world, '/s2/git');
    await expect(resolve('/s2/git')).resolves.toEqual({ resolved: '/s2/git' });
    expect(started(world, '/s2/git')).toBe(s2Runs);
  });

  it.each([
    ['darwin', '/s1/git', '/s2/git'],
    ['win32', 'C:\\s1\\git.exe', 'C:\\s2\\git.exe'],
  ] as const)(
    '%s: a request kept by the fast path supersedes a pending detection for another key',
    async (os, first, second) => {
      const world = createWorld(os, {
        filesystem: { [first]: version('2.45.0'), [second]: { kind: 'executable', stdout: 'not git\n' } }, // prettier-ignore
      });
      const heldB = gate();
      world.gates.set(second, heldB.wait);
      const { resolve } = fakeHost(world);
      await expect(resolve(first)).resolves.toEqual({ resolved: first });
      const pending = resolve(second);
      await flush();
      expect(started(world, second)).toBe(1);
      await expect(resolve(first)).resolves.toEqual({ resolved: first });
      heldB.open();
      await expect(pending).resolves.toEqual({ resolved: null, failure: os === 'win32' ? 'selection_rejected' : 'git_unavailable' }); // prettier-ignore
      const firstRuns = started(world, first);
      await expect(resolve(first)).resolves.toEqual({ resolved: first });
      expect(started(world, first)).toBe(firstRuns);
      // No rejection was recorded, so the second value is validated again.
      await resolve(second);
      expect(started(world, second)).toBe(2);
    },
  );

  it.each([
    ['darwin', '/s1/git', '/custom/git', '/usr/local/bin/git', '/s2/git'],
    ['win32', 'C:\\s1\\git.exe', 'C:\\custom\\git.exe', 'C:\\found\\git.exe', 'C:\\s2\\git.exe'], // prettier-ignore
  ] as const)(
    '%s: a detection superseded after a transient saved-value rejection keeps that entry and records nothing after',
    async (os, saved, override, discovered, newer) => {
      const world = createWorld(os, {
        filesystem: {
          [saved]: { kind: 'executable', stdout: 'git version 2.45.0\n', transient: 'timeout' }, // prettier-ignore
          [override]: { kind: 'executable', stdout: 'not git\n' },
          [discovered]: version('2.46.0'),
          [newer]: version('2.47.0'),
        },
        whereExe: { git: `${discovered}\r\n` },
      });
      const heldOverride = gate();
      world.gates.set(override, heldOverride.wait);
      const { resolve } = fakeHost(world, {
        environment: snapshotFor(os, { CANOPY_GIT_EXECUTABLE: override }),
      });
      // The saved value times out while its detection is current; the
      // override's check is then held.
      const superseded = resolve(saved);
      await flush();
      expect(started(world, saved)).toBe(1);
      expect(started(world, override)).toBe(1);
      await expect(resolve(newer)).resolves.toEqual({ resolved: newer });
      heldOverride.open();
      // The superseded detection still answers its own request.
      await expect(superseded).resolves.toEqual({ resolved: discovered });
      // No `accepted` after supersession: the newer selection keeps its
      // fast path.
      const newerRuns = started(world, newer);
      await expect(resolve(newer)).resolves.toEqual({ resolved: newer });
      expect(started(world, newer)).toBe(newerRuns);
      // macOS keeps the rejection; Windows retries on every detection.
      // The override, rejected after supersession, is retried on both.
      await expect(resolve(saved)).resolves.toEqual({ resolved: discovered });
      expect(started(world, saved)).toBe(os === 'win32' ? 2 : 1);
      expect(started(world, override)).toBe(2);
    },
  );

  it.each([
    ['darwin', '/custom/git', '/s2/git', '/usr/local/bin/git'],
    ['win32', 'C:\\custom\\git.exe', 'C:\\s2\\git.exe', 'C:\\found\\git.exe'],
  ] as const)(
    '%s: a superseded detection that then validates a rejected override does not clear the rejection',
    async (os, override, newer, discovered) => {
      const world = createWorld(os, {
        filesystem: {
          [override]: version('2.45.0'),
          [newer]: { kind: 'executable', stdout: 'not git\n' },
          [discovered]: version('2.46.0'),
        },
        whereExe: { git: `${discovered}\r\n` },
      });
      const held = gate();
      world.gates.set(override, held.wait);
      const { resolve } = fakeHost(world, {
        environment: snapshotFor(os, { CANOPY_GIT_EXECUTABLE: override }),
      });
      const superseded = resolve('');
      await flush();
      expect(started(world, override)).toBe(1);
      // The newer detection, current, sees the override time out (same
      // identity) and records its rejection.
      world.gates.delete(override);
      world.filesystem[override] = { kind: 'executable', stdout: 'git version 2.45.0\n', transient: 'timeout' }; // prettier-ignore
      await expect(resolve(newer)).resolves.toEqual({ resolved: discovered });
      expect(started(world, override)).toBe(2);
      // The superseded detection's held check then passes.
      world.filesystem[override] = version('2.45.0');
      held.open();
      await expect(superseded).resolves.toEqual({ resolved: override });
      // Supersession never clears a newer rejection. macOS keeps its TTL;
      // Windows detection retries and selects the now-usable override.
      const overrideRuns = started(world, override);
      await expect(resolve('')).resolves.toEqual({
        resolved: os === 'win32' ? override : discovered,
      });
      expect(started(world, override)).toBe(
        overrideRuns + (os === 'win32' ? 1 : 0),
      );
    },
  );

  it('Linux x64: a discovery superseded by an explicit choice caches nothing after', async () => {
    const world = createWorld('linux', {
      loginPath: '/login/bin',
      filesystem: { '/login/bin/git': version('2.45.0'), '/s2/git': version('2.46.0') }, // prettier-ignore
    });
    const held = gate();
    world.gates.set('/login/bin/git', held.wait);
    const { clock, resolve } = fakeHost(world);
    const superseded = resolve('');
    await flush();
    expect(started(world, '/login/bin/git')).toBe(1);
    // An explicit choice supersedes the pending discovery.
    await expect(resolve('/s2/git')).resolves.toEqual({ resolved: '/s2/git' });
    held.open();
    await expect(superseded).resolves.toEqual({ resolved: '/login/bin/git' });
    // No `accepted` after supersession.
    await expect(resolve('/s2/git')).resolves.toEqual({ resolved: '/s2/git' });
    expect(started(world, '/s2/git')).toBe(1);
    // No cache write after supersession: discovery uses the refreshed login
    // PATH rather than re-validating the superseded discovery first.
    world.loginPath = '/other/bin';
    world.filesystem['/other/bin/git'] = version('2.47.0');
    clock.now += 5 * 60_000 + 1;
    await expect(resolve('')).resolves.toEqual({ resolved: '/other/bin/git' });
    expect(started(world, '/login/bin/git')).toBe(1);
  });

  it('Linux x64: a discovery superseded by an explicit choice caches nothing, even with no newer explicit request to forget it', async () => {
    const world = createWorld('linux', {
      loginPath: '/login/bin',
      filesystem: { '/login/bin/git': version('2.45.0'), '/s2/git': version('2.46.0') }, // prettier-ignore
    });
    const held = gate();
    world.gates.set('/login/bin/git', held.wait);
    const { clock, resolve } = fakeHost(world);
    const superseded = resolve('');
    await flush();
    expect(started(world, '/login/bin/git')).toBe(1);
    await expect(resolve('/s2/git')).resolves.toEqual({ resolved: '/s2/git' });
    held.open();
    await expect(superseded).resolves.toEqual({ resolved: '/login/bin/git' });
    // The choice is cleared next; no request in between drops a stale write.
    world.loginPath = '/other/bin';
    world.filesystem['/other/bin/git'] = version('2.47.0');
    clock.now += 5 * 60_000 + 1;
    await expect(resolve('')).resolves.toEqual({ resolved: '/other/bin/git' });
    expect(started(world, '/login/bin/git')).toBe(1);
  });

  it('a request that read its saved value earlier but established its key later does not supersede the newer read', async () => {
    const world = createWorld('linux', {
      filesystem: { '/s1/git': version('2.45.0'), '/s2/git': version('2.46.0') }, // prettier-ignore
    });
    const heldStat = gate();
    const heldB = gate();
    const base = worldIo(world);
    let holdNext = false;
    const { resolve } = fakeHost(
      world,
      {},
      {
        io: {
          ...base,
          stat: async (target) => {
            if (holdNext && target === '/s1/git') {
              holdNext = false;
              await heldStat.wait;
            }
            return base.stat(target);
          },
        },
      },
    );
    await expect(resolve('/s1/git')).resolves.toEqual({ resolved: '/s1/git' });
    // The older request read /s1/git; its identity lookup stalls.
    holdNext = true;
    const older = resolve('/s1/git');
    await flush();
    // The newer request read /s2/git and starts its detection.
    world.gates.set('/s2/git', heldB.wait);
    const newer = resolve('/s2/git');
    await flush();
    expect(started(world, '/s2/git')).toBe(1);
    // The older key arrives late; its fast path keeps /s1/git.
    heldStat.open();
    await expect(older).resolves.toEqual({ resolved: '/s1/git' });
    heldB.open();
    await expect(newer).resolves.toEqual({ resolved: '/s2/git' });
    // The detection serving the newest read recorded: /s2/git keeps its fast path.
    await expect(resolve('/s2/git')).resolves.toEqual({ resolved: '/s2/git' });
    expect(started(world, '/s2/git')).toBe(1);
  });

  it('an older request that rejoins a pending detection for its key does not take it back from a newer request', async () => {
    const world = createWorld('linux', {
      loginPath: '/login/bin',
      filesystem: { '/login/bin/git': version('2.45.0'), '/usr/bin/git': version('2.44.0'), '/s2/git': version('2.46.0') }, // prettier-ignore
    });
    const heldAccess = gate();
    const heldDiscovery = gate();
    const heldB = gate();
    const base = worldIo(world);
    let holdNext = false;
    const { resolve } = fakeHost(
      world,
      {},
      {
        io: {
          ...base,
          access: async (target) => {
            if (holdNext && target === '/login/bin/git') {
              holdNext = false;
              await heldAccess.wait;
            }
            return base.access(target);
          },
        },
      },
    );
    await expect(resolve('')).resolves.toEqual({ resolved: '/login/bin/git' });
    // The oldest request stalls in its fast path.
    holdNext = true;
    const oldest = resolve('');
    await flush();
    // The discovered Git goes: the next request's fast path fails and it
    // starts a discovery, held.
    world.filesystem['/login/bin/git'] = { kind: 'missing' };
    world.gates.set('/usr/bin/git', heldDiscovery.wait);
    const middle = resolve('');
    await flush();
    expect(started(world, '/usr/bin/git')).toBe(1);
    // The newest request starts B.
    world.gates.set('/s2/git', heldB.wait);
    const newest = resolve('/s2/git');
    await flush();
    expect(started(world, '/s2/git')).toBe(1);
    // The oldest request's fast path now fails: it joins the discovery.
    heldAccess.open();
    await flush();
    expect(started(world, '/usr/bin/git')).toBe(1);
    heldB.open();
    await expect(newest).resolves.toEqual({ resolved: '/s2/git' });
    heldDiscovery.open();
    await expect(oldest).resolves.toEqual({ resolved: '/usr/bin/git' });
    await expect(middle).resolves.toEqual({ resolved: '/usr/bin/git' });
    // B served the latest request and recorded: /s2/git keeps its fast path.
    await expect(resolve('/s2/git')).resolves.toEqual({ resolved: '/s2/git' });
    expect(started(world, '/s2/git')).toBe(1);
  });

  it('ends a detection at its own deadline while a filesystem lookup stalls, and the late lookup continues nothing', async () => {
    const world = createWorld('linux', {
      filesystem: { '/opt/git': { kind: 'executable', stdout: 'not git\n' } },
    });
    const held = gate();
    const base = worldIo(world);
    let accesses = 0;
    const { resolve } = fakeHost(
      world,
      {},
      {
        timing: { requestDeadlineMs: 10_000, detectionDeadlineMs: 30 },
        io: {
          ...base,
          access: async (target) => {
            accesses += 1;
            if (accesses === 1) await held.wait;
            return base.access(target);
          },
        },
      },
    );
    await expect(
      Promise.race([resolve('/opt/git'), pendingAfter(1_000)]),
    ).resolves.toEqual({ resolved: null, failure: 'deadline_exceeded' });
    // No longer in flight: the next request runs its own detection.
    await expect(resolve('/opt/git')).resolves.toEqual({ resolved: null, failure: 'git_unavailable' }); // prettier-ignore
    expect(accesses).toBe(2);
    expect(started(world, '/opt/git')).toBe(1);
    held.open();
    await flush(20);
    // The ended detection probes nothing once its lookup answers.
    expect(started(world, '/opt/git')).toBe(1);
  });

  it("starts no detection after a request gave up while its saved value's lookup stalled", async () => {
    const world = createWorld('linux', { filesystem: { '/opt/git': version('2.45.0') } }); // prettier-ignore
    const held = gate();
    const base = worldIo(world);
    let stats = 0;
    const { resolve } = fakeHost(
      world,
      {},
      {
        timing: { requestDeadlineMs: 30 },
        io: {
          ...base,
          stat: async (target) => {
            stats += 1;
            if (stats === 1) await held.wait;
            return base.stat(target);
          },
        },
      },
    );
    await expect(resolve('/opt/git')).resolves.toEqual({ resolved: null, failure: 'deadline_exceeded' }); // prettier-ignore
    held.open();
    await flush(20);
    expect(stats).toBe(1);
    expect(world.probes).toEqual([]);
  });

  it.each<[string, string, number]>([
    // The refresh starts after the cached validation used part of the
    // detection's budget, so the refresh's own deadline falls later: the
    // detection stops waiting at its own, before the refresh scope ends.
    ['started by the detection', 'deadline_exceeded', 60],
    // A refresh scope started earlier ends first, at its own deadline; discovery
    // then uses the previous login PATH. A regression pin: a joined refresh
    // cannot outlive the detection.
    ['joined from a prewarm', 'git_unavailable', 40],
  ])(
    'Linux x64: a hung login-PATH refresh %s after a stale cached discovery stays within the detection deadline',
    async (how, failure, remainingMs) => {
      jest.useFakeTimers();
      const heldRefresh = gate();
      try {
        const world = createWorld('linux', {
          loginPath: '/usr/bin',
          filesystem: { '/usr/bin/git': version('2.43.0') },
        });
        const base = worldRunner(world);
        const io = worldIo(world);
        let hung = false;
        let hungRefreshes = 0;
        let vanishing = false;
        const { clock, host, resolve } = fakeHost(
          world,
          {},
          {
            timing: { requestDeadlineMs: 10_000, detectionDeadlineMs: 60 },
            io: {
              ...io,
              stat: (target) => {
                if (!vanishing || target !== '/usr/bin/git')
                  return io.stat(target);
                vanishing = false;
                return Promise.reject(errno('ENOENT'));
              },
            },
            // Keep the runner pending so only the host scopes can end the wait.
            createRunner: (options) => {
              const runner = base(options);
              return {
                ...runner,
                run: async (command, request): Promise<GitReadOutput> => {
                  if (!hung || command.kind !== 'linux-login-shell-path')
                    return runner.run(command, request);
                  hungRefreshes += 1;
                  await heldRefresh.wait;
                  throw new GitReadError('deadline_exceeded');
                },
              };
            },
          },
        );
        await expect(resolve('')).resolves.toEqual({
          resolved: '/usr/bin/git',
        });
        // An upgrade replaces the cached discovery: the fast path misses it,
        // and it is no longer Git after a slow check. The stale login PATH hangs.
        hung = true;
        vanishing = true;
        world.filesystem['/usr/bin/git'] = { kind: 'executable', stdout: 'not git\n' }; // prettier-ignore
        world.gates.set(
          '/usr/bin/git',
          new Promise((done) => setTimeout(done, 30)),
        );
        clock.now += 5 * 60_000;
        if (how === 'joined from a prewarm') {
          host.prewarm();
          // Leaves the rediscovery's version check time after the refresh ends.
          await jest.advanceTimersByTimeAsync(20);
        }
        let ended = false;
        const result = resolve('').then((value) => {
          ended = true;
          return value;
        });
        await jest.advanceTimersByTimeAsync(remainingMs - 1);
        expect(ended).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        expect(hungRefreshes).toBe(1);
        expect(ended).toBe(true);
        await expect(result).resolves.toEqual({ resolved: null, failure });
      } finally {
        heldRefresh.open();
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    },
  );

  it('Linux x64: an explicit choice forgets the discovery cache, as desktop saving or clearing one does', async () => {
    const world = createWorld('linux', {
      loginPath: '/usr/bin',
      filesystem: { '/usr/bin/git': version('2.43.0'), '/opt/git': version('2.45.0') }, // prettier-ignore
    });
    const { clock, resolve } = fakeHost(world);
    await expect(resolve('')).resolves.toEqual({ resolved: '/usr/bin/git' });
    await expect(resolve('/opt/git')).resolves.toEqual({
      resolved: '/opt/git',
    });
    // The login PATH gains a Git; the cached discovery is still valid.
    world.loginPath = '/home/me/bin:/usr/bin';
    world.filesystem['/home/me/bin/git'] = version('2.47.0');
    clock.now += 5 * 60_000;
    // desktop clearCachedGitExecutablePath → forgetLinuxDiscoveredPath.
    await expect(resolve('')).resolves.toEqual({ resolved: '/home/me/bin/git' }); // prettier-ignore
  });

  it('Linux x64: a cached discovery that fails is forgotten, so a later discovery uses the refreshed login PATH', async () => {
    const world = createWorld('linux', {
      loginPath: '/login/bin',
      filesystem: { '/login/bin/git': version('2.45.0') },
    });
    const { clock, resolve } = fakeHost(world);
    await expect(resolve('')).resolves.toEqual({ resolved: '/login/bin/git' });
    // The cached discovery goes, and no candidate is usable.
    world.filesystem['/login/bin/git'] = { kind: 'missing' };
    await expect(resolve('')).resolves.toEqual({ resolved: null, failure: 'git_unavailable' }); // prettier-ignore
    // It comes back, and the login PATH gains an earlier Git.
    world.filesystem['/login/bin/git'] = version('2.45.0');
    world.loginPath = '/home/me/bin:/login/bin';
    world.filesystem['/home/me/bin/git'] = version('2.47.0');
    clock.now += 5 * 60_000;
    // desktop: the failed cache validation ran forgetLinuxDiscoveredPath.
    await expect(resolve('')).resolves.toEqual({ resolved: '/home/me/bin/git' }); // prettier-ignore
  });

  interface StaleExplicit {
    readonly clock: { now: number };
    readonly resolve: (saved: string) => Promise<unknown>;
    /** The next `stat` of `target` fails with ENOENT. */
    readonly vanishOnce: (target: string) => void;
  }

  /**
   * A discovery of `/login/bin/git` is cached. The request reading `/opt/git`
   * stalls in its identity lookup while a newer request reads `''` and keeps
   * the discovery on its fast path, so the explicit detection starts while
   * not current. `joinedBy`, read after, joins it while its version check is
   * held; `whileHeld` then runs before that check passes.
   */
  async function explicitAfterNewerClear(
    world: World,
    joinedBy: string | null,
    whileHeld?: (host: StaleExplicit) => Promise<void>,
  ): Promise<StaleExplicit> {
    const heldStat = gate();
    const heldVersion = gate();
    const base = worldIo(world);
    let holdNext = false;
    let vanishing: string | null = null;
    const { clock, resolve } = fakeHost(
      world,
      {},
      {
        io: {
          ...base,
          stat: async (target) => {
            if (holdNext && target === '/opt/git') {
              holdNext = false;
              await heldStat.wait;
            }
            if (vanishing === target) {
              vanishing = null;
              throw errno('ENOENT');
            }
            return base.stat(target);
          },
        },
      },
    );
    await expect(resolve('')).resolves.toEqual({ resolved: '/login/bin/git' });
    holdNext = true;
    const older = resolve('/opt/git');
    await flush();
    await expect(resolve('')).resolves.toEqual({ resolved: '/login/bin/git' });
    world.gates.set('/opt/git', heldVersion.wait);
    heldStat.open();
    await flush();
    expect(started(world, '/opt/git')).toBe(1);
    const joined = joinedBy === null ? null : resolve(joinedBy);
    await flush();
    const host: StaleExplicit = {
      clock,
      resolve,
      vanishOnce: (target): void => {
        vanishing = target;
      },
    };
    await whileHeld?.(host);
    heldVersion.open();
    await expect(older).resolves.toEqual({ resolved: '/opt/git' });
    if (joined) await expect(joined).resolves.toEqual({ resolved: '/opt/git' }); // prettier-ignore
    expect(started(world, '/opt/git')).toBe(1);
    world.gates.delete('/opt/git');
    return host;
  }

  it('Linux x64: a newer request joining an older explicit detection forgets the discovery cache even when a newer clear supersedes it before its check ends', async () => {
    const world = createWorld('linux', {
      loginPath: '/login/bin',
      filesystem: { '/login/bin/git': version('2.45.0'), '/opt/git': version('2.46.0') }, // prettier-ignore
    });
    await explicitAfterNewerClear(
      world,
      '/opt/git',
      async ({ clock, resolve, vanishOnce }) => {
        // desktop forgot its discovery when the choice was saved, and the
        // choice is now cleared after the login PATH's TTL.
        world.loginPath = '/home/me/bin:/login/bin';
        world.filesystem['/home/me/bin/git'] = version('2.47.0');
        clock.now += 5 * 60_000;
        const before = started(world, '/login/bin/git');
        // The fast path misses once; detection does not try the old discovery.
        vanishOnce('/login/bin/git');
        await expect(resolve('')).resolves.toEqual({ resolved: '/home/me/bin/git' }); // prettier-ignore
        expect(started(world, '/login/bin/git')).toBe(before);
      },
    );
  });

  it('Linux x64: an explicit choice read before a newer clear does not forget the discovery the clear kept', async () => {
    const world = createWorld('linux', {
      loginPath: '/login/bin',
      filesystem: { '/login/bin/git': version('2.45.0'), '/opt/git': version('2.46.0') }, // prettier-ignore
    });
    const { clock, resolve, vanishOnce } = await explicitAfterNewerClear(
      world,
      null,
    );
    // The newest read is still the clear: desktop, having saved and then
    // cleared, rediscovered and cached /login/bin/git.
    world.loginPath = '/home/me/bin:/login/bin';
    world.filesystem['/home/me/bin/git'] = version('2.47.0');
    clock.now += 5 * 60_000;
    // The fast path misses once; detection re-validates the kept discovery.
    vanishOnce('/login/bin/git');
    await expect(resolve('')).resolves.toEqual({ resolved: '/login/bin/git' });
    expect(started(world, '/home/me/bin/git')).toBe(0);
  });

  it('Linux x64: an explicit choice in the latest request forgets the discovery cache before a newer clear discovers', async () => {
    const world = createWorld('linux', {
      loginPath: '/login/bin',
      filesystem: { '/login/bin/git': version('2.45.0'), '/opt/git': version('2.46.0') }, // prettier-ignore
    });
    const base = worldIo(world);
    let vanishing = false;
    const { clock, resolve } = fakeHost(
      world,
      {},
      {
        io: {
          ...base,
          stat: (target) => {
            if (!vanishing || target !== '/login/bin/git')
              return base.stat(target);
            vanishing = false;
            return Promise.reject(errno('ENOENT'));
          },
        },
      },
    );
    await expect(resolve('')).resolves.toEqual({ resolved: '/login/bin/git' });
    world.loginPath = '/home/me/bin:/login/bin';
    world.filesystem['/home/me/bin/git'] = version('2.47.0');
    clock.now += 5 * 60_000;
    // The choice's detection starts current and is held at its version check.
    const held = gate();
    world.gates.set('/opt/git', held.wait);
    const chosen = resolve('/opt/git');
    await flush();
    expect(started(world, '/opt/git')).toBe(1);
    // The choice is cleared; that request's fast path misses once, and its
    // discovery runs while the choice's detection is still pending.
    vanishing = true;
    // desktop forgot the discovery when the choice was saved and cleared.
    await expect(resolve('')).resolves.toEqual({ resolved: '/home/me/bin/git' }); // prettier-ignore
    held.open();
    await expect(chosen).resolves.toEqual({ resolved: '/opt/git' });
  });

  it.each([
    [
      'still valid, and the login PATH gains an earlier Git',
      version('2.45.0'),
      '/home/me/bin:/login/bin',
      ['/home/me/bin/git'],
    ],
    [
      'no longer Git',
      { kind: 'executable', stdout: 'not git\n' },
      '/login/bin',
      ['/login/bin/git', '/usr/bin/git'],
    ],
  ] as const)(
    'Linux x64: a newer request joining an older explicit detection forgets the discovery cache, as desktop saving the choice does (old discovery %s)',
    async (_case, oldDiscovery, loginPath, validatedAfter) => {
      const world = createWorld('linux', {
        loginPath: '/login/bin',
        filesystem: { '/login/bin/git': version('2.45.0'), '/usr/bin/git': version('2.44.0'), '/opt/git': version('2.46.0') }, // prettier-ignore
      });
      const { clock, resolve } = await explicitAfterNewerClear(world, '/opt/git'); // prettier-ignore
      // The joiner made the detection current: its selection was recorded and
      // keeps the fast path.
      const marker = world.probes.length;
      await expect(resolve('/opt/git')).resolves.toEqual({ resolved: '/opt/git' }); // prettier-ignore
      expect(world.probes.length).toBe(marker);
      expect(started(world, '/login/bin/git')).toBe(1);
      // The choice is cleared after the login PATH's TTL.
      world.filesystem['/login/bin/git'] = oldDiscovery;
      world.filesystem['/home/me/bin/git'] = version('2.47.0');
      world.loginPath = loginPath;
      clock.now += 5 * 60_000;
      const cleared = world.probes.length;
      const selected = validatedAfter[validatedAfter.length - 1];
      await expect(resolve('')).resolves.toEqual({ resolved: selected });
      // As the non-rejoin control above: no cached discovery is checked
      // first; discovery refreshes the login PATH and walks its candidates.
      expect(kinds(world).slice(cleared)[0]).toBe('linux-login-shell-path');
      const validated = world.probes
        .slice(cleared)
        .flatMap(({ command }) => (command.kind === 'git-version' ? [command.executable] : [])); // prettier-ignore
      expect(validated).toEqual(validatedAfter);
      expect(world.checks[world.checks.length - 1]?.executable).toBe(selected);
    },
  );

  it('keeps a rejected override rejected for its unchanged identity even when it was rejected before its stat', async () => {
    const world = createWorld('darwin', {
      filesystem: {
        '/usr/bin/git': SHIM,
        '/custom/git': { kind: 'symlink', target: '/usr/bin/git' },
        '/usr/local/bin/git': version('2.50.1'),
      },
    });
    const { resolve } = fakeHost(world, {
      environment: snapshotFor('darwin', { CANOPY_GIT_EXECUTABLE: '/custom/git' }), // prettier-ignore
    });
    await expect(resolve('')).resolves.toEqual({ resolved: '/usr/local/bin/git' }); // prettier-ignore
    // A new saved value re-runs detection within the TTL.
    await expect(resolve('/removed/git')).resolves.toEqual({ resolved: '/usr/local/bin/git' }); // prettier-ignore
    expect(world.attempts.filter((attempt) => attempt === '/custom/git')).toHaveLength(1); // prettier-ignore
  });

  it('a request waits for detection only within its own deadline and never cancels it', async () => {
    const world = createWorld('linux', { filesystem: { '/usr/bin/git': version('2.43.0') } }); // prettier-ignore
    const held = gate();
    world.gates.set('/usr/bin/git', held.wait);
    const { host, resolve } = fakeHost(world, {}, { timing: { requestDeadlineMs: 50 } }); // prettier-ignore
    await expect(resolve('')).resolves.toEqual({ resolved: null, failure: 'deadline_exceeded' }); // prettier-ignore
    expect(host.lastFailure()).toBe('deadline_exceeded');
    held.open();
    await flush();
    await expect(resolve('')).resolves.toEqual({ resolved: '/usr/bin/git' });
    expect(ranCount(world, '/usr/bin/git')).toBe(1);
  });

  it('ends a detection at its own deadline without recording the rejection', async () => {
    const world = createWorld('linux', { filesystem: { '/opt/git': version('2.45.0') } }); // prettier-ignore
    const held = gate();
    world.gates.set('/opt/git', held.wait);
    const { resolve } = fakeHost(
      world,
      {},
      {
        timing: { requestDeadlineMs: 2_000, detectionDeadlineMs: 20 },
      },
    );
    const pending = resolve('/opt/git');
    await new Promise((done) => setTimeout(done, 40));
    held.open();
    await expect(pending).resolves.toEqual({ resolved: null, failure: 'deadline_exceeded' }); // prettier-ignore
    world.gates.delete('/opt/git');
    await expect(resolve('/opt/git')).resolves.toEqual({
      resolved: '/opt/git',
    });
  });
});

describe('createGitReadHost lifetime', () => {
  it('stops idle, then rejects later stops, requests and prewarms', async () => {
    const world = createWorld('linux', { filesystem: { '/usr/bin/git': version('2.43.0') } }); // prettier-ignore
    const { host, captured, resolve } = fakeHost(world);
    await resolve('');
    await expect(host.stop(neverAborted())).resolves.toEqual({
      state: 'stopped',
    });
    expect(captured.options?.hostSignal?.aborted).toBe(true);
    await expect(host.stop(neverAborted())).rejects.toEqual(new GitIgnoreHostError('stopped')); // prettier-ignore
    await expect(resolve('')).resolves.toEqual({ resolved: null, failure: 'stopped' }); // prettier-ignore
    const probes = world.probes.length;
    host.prewarm();
    await flush();
    expect(world.probes.length).toBe(probes);
  });

  it('rejects an in-flight request with stopped and reports pending detection work as cleanup_unconfirmed', async () => {
    const world = createWorld('linux', { filesystem: { '/usr/bin/git': version('2.43.0') } }); // prettier-ignore
    const held = gate();
    world.gates.set('/usr/bin/git', held.wait);
    const { host, resolve } = fakeHost(world);
    const pending = resolve('');
    await flush();
    await expect(host.stop(AbortSignal.abort())).resolves.toEqual({ state: 'cleanup_unconfirmed' }); // prettier-ignore
    await expect(pending).resolves.toEqual({
      resolved: null,
      failure: 'stopped',
    });
    expect(host.lastFailure()).toBe('stopped');
    held.open();
  });

  it('waits for detection to end after the stop and then reports stopped', async () => {
    const world = createWorld('linux', { filesystem: { '/usr/bin/git': version('2.43.0') } }); // prettier-ignore
    const held = gate();
    world.gates.set('/usr/bin/git', held.wait);
    const { host, resolve } = fakeHost(world);
    const pending = resolve('');
    await flush();
    const stopping = host.stop(neverAborted());
    await flush();
    held.open();
    await expect(stopping).resolves.toEqual({ state: 'stopped' });
    await expect(pending).resolves.toMatchObject({ failure: 'stopped' });
  });

  it('reports the runner still busy at the stop signal as cleanup_unconfirmed', async () => {
    const runner = scriptedRunner(() => Promise.resolve(new Set<string>()), 'pending'); // prettier-ignore
    const { host } = fakeHost(createWorld('linux'), {}, { createRunner: runner.create }); // prettier-ignore
    await host.port.checkIgnoredPaths(request(''));
    await expect(host.stop(AbortSignal.abort())).resolves.toEqual({ state: 'cleanup_unconfirmed' }); // prettier-ignore
  });

  it('starts no detection or login refresh once stopped, even for a selection mid-lookup', async () => {
    const world = createWorld('linux', { filesystem: { '/opt/git': version('2.45.0') } }); // prettier-ignore
    const held = gate();
    const base = worldIo(world);
    let lookups = 0;
    const { host, resolve } = fakeHost(
      world,
      {},
      {
        io: {
          ...base,
          stat: async (target) => {
            lookups += 1;
            if (lookups === 1) await held.wait;
            return base.stat(target);
          },
        },
      },
    );
    const pending = resolve('/opt/git');
    await flush();
    expect(lookups).toBe(1);
    await expect(host.stop(neverAborted())).resolves.toEqual({ state: 'stopped' }); // prettier-ignore
    await expect(pending).resolves.toEqual({ resolved: null, failure: 'stopped' }); // prettier-ignore
    held.open();
    await flush(20);
    // Only the held identity lookup ran: no validation, refresh or probe.
    expect(lookups).toBe(1);
    expect(world.attempts).toEqual(['/opt/git']);
    expect(world.probes).toEqual([]);
  });

  it('stops without waiting for a stalled filesystem lookup in detection', async () => {
    const world = createWorld('linux', { filesystem: { '/opt/git': version('2.45.0') } }); // prettier-ignore
    const base = worldIo(world);
    let accesses = 0;
    const { host, resolve } = fakeHost(
      world,
      {},
      {
        io: {
          ...base,
          access: async (target) => {
            accesses += 1;
            await new Promise(() => undefined);
            return base.access(target);
          },
        },
      },
    );
    const pending = resolve('/opt/git');
    await flush();
    expect(accesses).toBe(1);
    await expect(
      Promise.race([host.stop(neverAborted()), pendingAfter(1_000)]),
    ).resolves.toEqual({ state: 'stopped' });
    await expect(pending).resolves.toEqual({ resolved: null, failure: 'stopped' }); // prettier-ignore
  });

  it('rejects a stop without an AbortSignal', async () => {
    const { host } = fakeHost(createWorld('linux'));
    await expect(
      Promise.resolve<unknown>(Reflect.apply(host.stop, undefined, [{}])),
    ).rejects.toEqual(new GitIgnoreHostError('invalid_request'));
  });

  it('forwards kill and scratch cleanup reports after settlement, and survives a throwing reporter', async () => {
    const reports: GitReadHostCleanupReport[] = [];
    const runner = scriptedRunner(() => Promise.resolve(new Set<string>()));
    const { host } = fakeHost(
      createWorld('darwin'),
      { onCleanupReport: (report) => void reports.push(report) },
      { createRunner: runner.create },
    );
    await host.port.checkIgnoredPaths(request(''));
    const options = runner.options;
    options?.onKillCleanup?.('cleanup_unconfirmed');
    options?.onKillCleanup?.('failed');
    options?.onScratchCleanupFailure?.(new GitReadError('cleanup_unconfirmed'));
    options?.onScratchCleanupFailure?.(errno('EBUSY'));
    expect(reports).toEqual([
      { kind: 'kill', outcome: 'cleanup_unconfirmed' },
      { kind: 'kill', outcome: 'failed' },
      { kind: 'scratch_removal', outcome: 'cleanup_unconfirmed' },
      { kind: 'scratch_removal', outcome: 'failed' },
    ]);
    const throwing = scriptedRunner(() => Promise.resolve(new Set<string>()));
    const second = fakeHost(
      createWorld('darwin'),
      { onCleanupReport: () => { throw new Error('reporter'); } }, // prettier-ignore
      { createRunner: throwing.create },
    );
    await second.host.port.checkIgnoredPaths(request(''));
    expect(() => throwing.options?.onKillCleanup?.('failed')).not.toThrow();
  });
});

describe('deliberate divergences (R6 §2.7), each named', () => {
  const named = new Set<string>();
  const divergence = (
    name: keyof typeof DIVERGENCES,
    title: string,
    body: () => Promise<void>,
  ): void => {
    named.add(name);
    it(`${name}: ${title}`, body);
  };

  divergence(
    'no-writes',
    'discovery saves, clears and publishes nothing',
    async () => {
      const published = process.env.CANOPY_GIT_EXECUTABLE;
      const world = createWorld('darwin', {
        filesystem: {
          '/usr/bin/git': SHIM,
          '/usr/local/bin/git': version('2.50.1'),
        },
      });
      const environment = snapshotFor('darwin');
      const { resolve } = fakeHost(world, { environment });
      // A broken saved value is replaced for this request only.
      await expect(resolve('/removed/git')).resolves.toEqual({ resolved: '/usr/local/bin/git' }); // prettier-ignore
      expect(environment).toEqual(snapshotFor('darwin'));
      expect(process.env.CANOPY_GIT_EXECUTABLE).toBe(published);
      // The only writing probe is the bare-init smoke.
      expect(new Set(kinds(world))).toEqual(
        new Set(['macos-login-shell-path', 'xcode-select-print-path', 'git-version', 'git-bare-init-smoke']), // prettier-ignore
      );
    },
  );

  divergence(
    'account-facts',
    'macOS probes carry the account SHELL, USER and LOGNAME',
    async () => {
      const probeEnvironments = async (
        environment: Record<string, string | undefined>,
        userInfo: () => { username: string; shell: string | null },
      ): Promise<Readonly<Record<string, string>>[]> => {
        const world = createWorld('darwin', { filesystem: { '/opt/git': version('2.51.0') } }); // prettier-ignore
        const { resolve } = fakeHost(world, { environment: snapshotFor('darwin', environment) }, { userInfo }); // prettier-ignore
        await resolve('/opt/git');
        return world.probes.map((probe) => probe.environment);
      };
      const account = (): { username: string; shell: string } => ({ username: 'me', shell: '/opt/bin/fish' }); // prettier-ignore
      const fromAccount = await probeEnvironments({ SHELL: undefined, USER: 'stale' }, account); // prettier-ignore
      expect(fromAccount.length).toBeGreaterThan(0);
      for (const env of fromAccount)
      expect(env).toMatchObject({ SHELL: '/opt/bin/fish', USER: 'me', LOGNAME: 'me' }); // prettier-ignore
      const snapshotShell = await probeEnvironments(
        { SHELL: '/bin/bash' },
        account,
      );
      for (const env of snapshotShell) expect(env.SHELL).toBe('/bin/bash');
      const relative = await probeEnvironments({ SHELL: '' }, () => ({ username: 'me', shell: 'fish' })); // prettier-ignore
      for (const env of relative) expect(env.SHELL).toBe('/bin/zsh');
      // C10: userInfo throws for an account without a passwd entry.
      let calls = 0;
      const missingAccount = await probeEnvironments(
        { SHELL: undefined, USER: undefined },
        () => {
          // prettier-ignore
          calls += 1;
          throw new Error('ENOENT: no passwd entry');
        },
      );
      expect(calls).toBe(1);
      for (const env of missingAccount) {
        expect(env.SHELL).toBe('/bin/zsh');
        expect(env).not.toHaveProperty('USER');
        expect(env).not.toHaveProperty('LOGNAME');
      }
      // Linux probes get the snapshot unchanged; U1 sanitizes them.
      const world = createWorld('linux', { filesystem: { '/opt/git': version('2.45.0') } }); // prettier-ignore
      const { resolve } = fakeHost(world, {}, { userInfo: account });
      await resolve('/opt/git');
      for (const { environment } of world.probes) expect(environment).toEqual(snapshotFor('linux')); // prettier-ignore
    },
  );

  divergence(
    'probe-directory-cwd',
    'probes run in the probe directory; check-ignore in the root',
    async () => {
      for (const os of ['darwin', 'linux', 'win32'] as const) {
        const world = createWorld(os, { whereExe: { git: 'C:\\Git\\cmd\\git.exe\r\n' } }); // prettier-ignore
        world.filesystem = { '/usr/local/bin/git': version('2.50.1'), '/usr/bin/git': version('2.43.0'), 'C:\\Git\\cmd\\git.exe': version('2.51.0') }; // prettier-ignore
        const { resolve } = fakeHost(world);
        await resolve('');
        expect(world.probes.length).toBeGreaterThan(0);
        const expected = os === 'win32' ? WINDOWS_PROBE_DIRECTORY : POSIX_PROBE_DIRECTORY; // prettier-ignore
        expect(new Set(world.probes.map(({ cwd }) => cwd))).toEqual(new Set([expected])); // prettier-ignore
        expect(world.checks.map(({ cwd }) => cwd)).toEqual([os === 'win32' ? 'C:\\repo' : '/repo']); // prettier-ignore
      }
    },
  );

  it.each([
    'git',
    'git.exe',
    '.\\git.exe',
    'C:git.exe',
    '\\git.exe',
    '/git.exe',
    '\\\\?\\C:\\git.exe',
    '\\\\.\\C:\\git.exe',
    '//?/C:/git.exe',
    '  git.exe  ',
    '  C:git.exe  ',
    'git;other',
    ' ',
    '\u00a0\ufeff',
  ])(
    'Windows launch preserves override %j but never probes or selects it',
    async (override) => {
      const discovered = 'C:\\Program Files\\Git\\cmd\\git.exe';
      const environment = createChildServices('win32').childEnvironment({
        source: snapshotFor('win32', {
          APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
          ProgramFiles: 'C:\\Program Files',
          canopy_git_executable: override,
        }),
      });
      expect(environment.CANOPY_GIT_EXECUTABLE).toBe(override);
      for (const available of [true, false]) {
        const world = createWorld('win32', {
          filesystem: available
            ? { [discovered]: version('2.50.0.windows.1') }
            : {},
        });
        // A runnable decoy must not turn a rejected hint into a selection.
        if (override.trim())
          world.filesystem[override.trim()] = version('2.99.0.windows.1');
        const { host } = fakeHost(world, { environment });
        try {
          await expect(
            host.repository.selectExecutable({
              readSavedExecutablePath: () => Promise.resolve(''),
              signal: neverAborted(),
              recheck: false,
            }),
          ).resolves.toMatchObject(
            available
              ? {
                  ready: true,
                  origin: 'discovered',
                  override: Boolean(override.trim()),
                }
              : {
                  ready: false,
                  code: override.trim()
                    ? 'selection_rejected'
                    : 'git_unavailable',
                  explicit: false,
                  wingetAvailable: false,
                },
          );
          const selected = host.selectWriteExecutable(
            () => Promise.resolve(''),
            neverAborted(),
          );
          if (available) await expect(selected).resolves.toBe(discovered);
          else
            await expect(selected).rejects.toMatchObject({
              code: override.trim() ? 'selection_rejected' : 'git_unavailable',
            });
          expect(world.attempts).not.toContain(override);
          expect(world.attempts).not.toContain(override.trim());
          expect(world.ran).not.toContain(override);
          expect(world.ran).not.toContain(override.trim());
          const probes = world.probes.filter(
            ({ command }) => command.kind === 'git-version',
          );
          if (available) expect(probes.length).toBeGreaterThan(0);
          else expect(probes).toEqual([]);
          for (const { command } of probes)
            expect(command).toEqual({
              kind: 'git-version',
              executable: discovered,
            });
        } finally {
          await expect(host.stop(neverAborted())).resolves.toEqual({
            state: 'stopped',
          });
        }
      }
    },
  );

  it('Windows discovery probes winget before Git and validates the standard fallback', async () => {
    const world = createWorld('win32', {
      whereExe: {
        git: 'C:\\Missing\\git.exe\r\n',
        winget: 'C:\\winget.exe\r\n',
      },
      filesystem: {
        'C:\\Program Files\\Git\\cmd\\git.exe': version('2.50.0.windows.1'),
      },
    });
    const { host, resolve } = fakeHost(world, {
      environment: snapshotFor('win32', { ProgramFiles: 'C:\\Program Files' }),
    });
    await expect(resolve('')).resolves.toEqual({
      resolved: 'C:\\Program Files\\Git\\cmd\\git.exe',
    });
    expect(kinds(world)).toEqual(['where-winget', 'where-git', 'git-version']);
    await expect(
      host.repository.selectExecutable({
        readSavedExecutablePath: () => Promise.resolve(''),
        signal: neverAborted(),
        recheck: false,
      }),
    ).resolves.toMatchObject({ ready: true, wingetAvailable: true });
  });

  divergence(
    'detection-deadline',
    'a cold first listing may fail at the 30 s request deadline (C9)',
    async () => {
      // Cold macOS detection: probes outlast the request; detection runs on.
      const world = createWorld('darwin', {
        filesystem: {
          '/usr/bin/git': SHIM,
          '/usr/local/bin/git': version('2.50.1'),
        },
      });
      const held = gate();
      world.gates.set('xcode-select-print-path', held.wait);
      const { host, resolve } = fakeHost(world, {}, { timing: { requestDeadlineMs: 50 } }); // prettier-ignore
      await expect(resolve('')).resolves.toEqual({ resolved: null, failure: 'deadline_exceeded' }); // prettier-ignore
      expect(host.lastFailure()).toBe('deadline_exceeded');
      held.open();
      await flush(20);
      await expect(resolve('')).resolves.toEqual({
        resolved: '/usr/local/bin/git',
      });
      expect(kinds(world).filter((kind) => kind === 'xcode-select-print-path')).toHaveLength(1); // prettier-ignore
    },
  );

  divergence(
    'overlay-keying-and-ttl',
    'a rejected value stays rejected for its identity until the TTL',
    async () => {
      const world = createWorld('linux', { filesystem: { '/opt/git': { kind: 'executable', stdout: 'not git\n' } } }); // prettier-ignore
      const { clock, resolve } = fakeHost(world);
      await expect(resolve('/opt/git')).resolves.toMatchObject({ failure: 'git_unavailable' }); // prettier-ignore
      expect(ranCount(world, '/opt/git')).toBe(1);
      // Unchanged file: no new validation within five minutes.
      clock.now += 5 * 60_000 - 1;
      await expect(resolve('/opt/git')).resolves.toMatchObject({ failure: 'git_unavailable' }); // prettier-ignore
      expect(ranCount(world, '/opt/git')).toBe(1);
      // At the TTL it is validated again.
      clock.now += 1;
      await resolve('/opt/git');
      expect(ranCount(world, '/opt/git')).toBe(2);
      // A changed stat identity revalidates at once.
      world.filesystem['/opt/git'] = version('2.45.0');
      await expect(resolve('/opt/git')).resolves.toEqual({
        resolved: '/opt/git',
      });
      // stat, not lstat: retargeting a saved symlink re-selects at once.
      world.filesystem['/link/git'] = { kind: 'symlink', target: '/opt/git' };
      world.filesystem['/opt/other'] = version('2.46.0');
      await expect(resolve('/link/git')).resolves.toEqual({
        resolved: '/link/git',
      });
      world.filesystem['/link/git'] = { kind: 'symlink', target: '/opt/other' };
      const runs = world.ran.length;
      await resolve('/link/git');
      expect(world.ran.length).toBe(runs + 1);
    },
  );

  for (const [os, saved, override, discovered] of [
    ['darwin', '/s1/git', '/custom/git', '/usr/local/bin/git'],
    ['win32', 'C:\\s1\\git.exe', 'C:\\custom\\git.exe', 'C:\\found\\git.exe'],
  ] as const)
    divergence(
      'overlay-keying-and-ttl',
      `${os}: a repaired override waits behind the fallback until detection re-runs`,
      async () => {
        const broken = { kind: 'executable', stdout: 'not git\n' } as const;
        // The saved value and the override fail; discovery is selected.
        const rejectBoth = async (): Promise<FakeHost> => {
          const world = createWorld(os, {
            filesystem: {
              '/usr/bin/git': SHIM,
              [saved]: broken,
              [override]: broken,
              [discovered]: version('2.46.0'),
            },
            whereExe: { git: `${discovered}\r\n` },
          });
          const fake = fakeHost(world, {
            environment: snapshotFor(os, { CANOPY_GIT_EXECUTABLE: override }),
          });
          await expect(fake.resolve(saved)).resolves.toEqual({ resolved: discovered }); // prettier-ignore
          expect(started(world, override)).toBe(1);
          world.filesystem[override] = version('2.45.0');
          return fake;
        };

        // The selection is keyed by the saved value's identity only: until the
        // TTL, the repaired override is not looked at again.
        const ttl = await rejectBoth();
        ttl.clock.now += 5 * 60_000 - 1;
        await expect(ttl.resolve(saved)).resolves.toEqual({ resolved: discovered }); // prettier-ignore
        expect(started(ttl.world, override)).toBe(1);
        expect(started(ttl.world, saved)).toBe(1);
        // At the TTL detection re-runs and selects the override.
        ttl.clock.now += 1;
        await expect(ttl.resolve(saved)).resolves.toEqual({ resolved: override }); // prettier-ignore
        expect(started(ttl.world, saved)).toBe(2);

        // A changed saved-value identity starts a new detection at once.
        const identity = await rejectBoth();
        identity.clock.now += 60_000;
        identity.world.filesystem[saved] = { kind: 'executable', stdout: 'still not git\n' }; // prettier-ignore
        await expect(identity.resolve(saved)).resolves.toEqual({ resolved: override }); // prettier-ignore
        expect(started(identity.world, saved)).toBe(2);

        // So does a fallback that fails the spawn fast path.
        const gone = await rejectBoth();
        gone.clock.now += 60_000;
        delete gone.world.filesystem[discovered];
        await expect(gone.resolve(saved)).resolves.toEqual({ resolved: override }); // prettier-ignore
        expect(started(gone.world, saved)).toBe(os === 'win32' ? 2 : 1);
      },
    );

  divergence(
    'windows-absolute-path',
    'relative saved values and candidates are never looked up',
    async () => {
      const world = createWorld('win32', {
        whereExe: { git: 'C:\\Tools\\git.exe\r\n' },
        filesystem: { 'git.exe': version('2.51.0'), 'Program Files\\Git\\cmd\\git.exe': version('2.51.0'), 'C:\\Tools\\git.exe': version('2.50.0') }, // prettier-ignore
      });
      const { resolve } = fakeHost(world, {
        environment: snapshotFor('win32', { ProgramFiles: 'Program Files' }),
      });
      await expect(resolve('git.exe')).resolves.toEqual({ resolved: 'C:\\Tools\\git.exe' }); // prettier-ignore
      expect(world.attempts).toEqual(['C:\\Tools\\git.exe']);
      world.whereExe = {};
      world.filesystem['C:\\Tools\\git.exe'] = { kind: 'missing' };
      await expect(resolve('git.exe')).resolves.toMatchObject({ failure: 'selection_rejected' }); // prettier-ignore
      expect(world.attempts.every((attempt) => /^[A-Za-z]:\\/.test(attempt))).toBe(true); // prettier-ignore
    },
  );

  divergence(
    'other-linux-snapshot-path',
    'Unsupported Linux architecture without discovery spawns the override or git unvalidated',
    async () => {
      const reads: string[] = [];
      const readSaved = (): Promise<string> => {
        reads.push('read');
        return Promise.resolve('/opt/saved/git');
      };
      const plain = createWorld('linux');
      const { host } = fakeHost(plain, {}, { arch: 'ppc64' });
      await expect(host.port.checkIgnoredPaths(request(readSaved))).resolves.toEqual(new Set(['git'])); // prettier-ignore
      const overridden = createWorld('linux');
      const second = fakeHost(
        overridden,
        { environment: snapshotFor('linux', { CANOPY_GIT_EXECUTABLE: ' /env/git ' }) }, // prettier-ignore
        { arch: 'ppc64' },
      );
      await expect(second.host.port.checkIgnoredPaths(request(readSaved))).resolves.toEqual(new Set(['/env/git'])); // prettier-ignore
      expect(reads).toEqual([]);
      expect([...plain.probes, ...overridden.probes]).toEqual([]);
      expect([...plain.attempts, ...overridden.attempts]).toEqual([]);
    },
  );

  divergence(
    'linux-override-explicit',
    'an inherited desktop discovery is never replaced (C2)',
    async () => {
      // A desktop discovered /a/bin/git and published it (git-executable.ts
      // publishGitExecutablePath); a daemon started from that environment
      // inherits it. Desktop excludes its own publication from the explicit
      // choice (getLinuxExplicitChoice) and replaces it once it vanishes.
      const world = createWorld('linux', {
        loginPath: '/a/bin:/usr/bin',
        filesystem: { '/a/bin/git': version('2.47.1'), '/usr/bin/git': version('2.43.0') }, // prettier-ignore
      });
      const { resolve } = fakeHost(world, {
        environment: snapshotFor('linux', {
          CANOPY_GIT_EXECUTABLE: '/a/bin/git',
        }),
      });
      await expect(resolve('')).resolves.toEqual({ resolved: '/a/bin/git' });
      world.filesystem['/a/bin/git'] = { kind: 'missing' };
      await expect(resolve('')).resolves.toEqual({ resolved: null, failure: 'git_unavailable' }); // prettier-ignore
      expect(world.ran).not.toContain('/usr/bin/git');
    },
  );

  it('names every listed divergence in a test', () => {
    expect(Array.from(named).sort()).toEqual(Object.keys(DIVERGENCES).sort());
  });
});

it.each([true, false])(
  'closure requires the Windows Git host creation barrier (stop=%s)',
  async (stop) => {
    const witness = createWindowsClosureWitness();
    await witness.run(async () => {
      const host = createGitReadHost({
        os: 'win32',
        environment: {},
        probeDirectory: 'C:\\data',
      });
      if (stop)
        await expect(host.stop(neverAborted())).resolves.toEqual({
          state: 'stopped',
        });
    });
    const report = witness.finalize();
    expect(report.started).toBe(1);
    expect(witness.accepts(report)).toBe(stop);
  },
);

const closureHost = (): ReturnType<typeof createGitReadHost> =>
  createGitReadHost({
    os: 'win32',
    environment: {},
    probeDirectory: 'C:\\data',
  });

it('refuses a host closed outside its owning closure context', async () => {
  const witness = createWindowsClosureWitness();
  const host = await witness.run(closureHost);
  await host.stop(neverAborted());
  expect(witness.accepts(witness.finalize())).toBe(false);
});

it('refuses preexisting hosts even when a current host closes successfully', async () => {
  const host = closureHost();
  const witness = createWindowsClosureWitness();
  await witness.run(async () => {
    await host.stop(neverAborted());
    const current = closureHost();
    await current.stop(neverAborted());
  });
  expect(witness.accepts(witness.finalize())).toBe(false);
});

it('invalidates both contexts when a host crosses qualification runs', async () => {
  const first = createWindowsClosureWitness();
  const host = await first.run(closureHost);
  const second = createWindowsClosureWitness();
  await second.run(async () => {
    await host.stop(neverAborted());
    const current = closureHost();
    await current.stop(neverAborted());
  });
  expect(first.accepts(first.finalize())).toBe(false);
  expect(second.accepts(second.finalize())).toBe(false);
});
