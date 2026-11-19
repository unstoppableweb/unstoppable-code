import {
  GitRepositoryReadError,
  type GitRepositoryRead,
} from '@canopy/core-runtime/node/git';
import type { GitReadCommand } from '../git-read/commands';
import type { GitReadOutput } from '../git-read/runner';
import { createChildServices } from '../supervision/child';
import {
  createWorld,
  fakeHost,
  type FakeHost,
  output,
  type World,
  worldRunner,
} from './git-read-host-fakes';

// CAN-5138: the host's worker.git repository reads and executable selection
// share check-ignore's selection, runner, deadline and stop.
const version = (value: string) =>
  ({ kind: 'executable', stdout: `git version ${value}\n` }) as const;
const MAC_GIT = '/opt/homebrew/bin/git';
const LINUX_GIT = '/usr/bin/git';
const neverAborted = (): AbortSignal => new AbortController().signal;
const kinds = (world: World): GitReadCommand['kind'][] =>
  world.probes.map(({ command }) => command.kind);

function read(
  { host }: FakeHost,
  repositoryRead: unknown,
  options: {
    saved?: string;
    signal?: AbortSignal;
    cwd?: string;
    environment?: unknown;
  } = {},
): Promise<string> {
  return host.repository.readRepository({
    cwd: options.cwd ?? '/repo',
    // Untyped callers reach the host too; it validates the read itself.
    read: repositoryRead as GitRepositoryRead,
    readSavedExecutablePath: () => Promise.resolve(options.saved ?? ''),
    signal: options.signal ?? neverAborted(),
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment as Record<string, string> }),
  });
}

const failure = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => new Error('unexpectedly resolved'),
    (error: unknown) => error,
  );

function macWorld(overrides: Partial<World> = {}): World {
  return createWorld('darwin', {
    filesystem: { [MAC_GIT]: version('2.47.1') },
    ...overrides,
  });
}

describe('repository reads', () => {
  it('selects Git, then runs the fixed command in the trusted directory', async () => {
    const world = macWorld({
      repository: { 'git-branch-refs': output('refs/heads/main\tmain*\n') },
    });
    const target = fakeHost(world);
    await expect(read(target, { kind: 'branch-refs' })).resolves.toBe(
      'refs/heads/main\tmain*\n',
    );
    const [run] = world.probes.filter(
      ({ command }) => command.kind === 'git-branch-refs',
    );
    expect(run).toMatchObject({
      command: { kind: 'git-branch-refs', executable: MAC_GIT },
      cwd: '/repo',
    });
    // The host's own startup snapshot; the plan adds the switches (D8).
    expect(run?.environment).toEqual(expect.objectContaining({ PATH: '/usr/bin:/bin' })); // prettier-ignore
  });

  // CAN-5496: a forwarded environment replaces the snapshot for that command.
  it('runs with the request environment for that read only, selecting under the snapshot', async () => {
    const world = macWorld({
      repository: { 'git-dir': output('.git\n') },
    });
    const target = fakeHost(world);
    const forwarded = { PATH: '/forwarded/bin:/usr/bin', SSH_AUTH_SOCK: '/s' };
    await read(target, { kind: 'git-dir' }, { environment: forwarded });
    await read(target, { kind: 'git-dir' });
    const runs = world.probes.filter(
      ({ command }) => command.kind === 'git-dir',
    );
    expect(runs.map(({ environment }) => environment)).toEqual([
      forwarded,
      expect.objectContaining({ PATH: '/usr/bin:/bin' }),
    ]);
    expect(runs[1]?.environment).not.toHaveProperty('SSH_AUTH_SOCK');
    // Selection's probes never see the forwarded environment.
    for (const probe of world.probes.filter(
      ({ command }) => command.kind !== 'git-dir',
    ))
      expect(probe.environment).not.toHaveProperty('SSH_AUTH_SOCK');
  });

  it.each<[string, unknown]>([
    ['a NUL in a value', { PATH: '/usr/bin\0x' }],
    ['a NUL in a key', { 'PA\0TH': '/usr/bin' }],
    ['an empty key', { '': 'x' }],
    ['a non-string value', { PATH: 1 }],
    ['a non-object', 'PATH=/usr/bin'],
    ['null', null],
  ])(
    'refuses %s in the request environment before selection runs',
    async (_, environment) => {
      const world = macWorld();
      const error = await failure(
        read(fakeHost(world), { kind: 'git-dir' }, { environment }),
      );
      expect(error).toBeInstanceOf(GitRepositoryReadError);
      expect(error).toMatchObject({ code: 'invalid_request' });
      // Fixed text: the message never repeats a value.
      expect(String(error)).not.toContain('/usr/bin');
      expect(world.probes).toEqual([]);
    },
  );

  it('carries the enum branch through to the command', async () => {
    const world = macWorld({
      repository: { 'git-origin-branch': output('abc\n') },
    });
    await read(fakeHost(world), { kind: 'origin-branch', branch: 'master' });
    expect(world.probes.at(-1)?.command).toEqual({
      kind: 'git-origin-branch',
      executable: MAC_GIT,
      branch: 'master',
    });
  });

  it('rejects a non-zero exit with exit_status', async () => {
    const world = macWorld({ repository: { 'git-dir': output('', 128) } });
    const error = await failure(read(fakeHost(world), { kind: 'git-dir' }));
    expect(error).toBeInstanceOf(GitRepositoryReadError);
    expect(error).toMatchObject({ code: 'exit_status', exitCode: 128 });
  });

  it("keeps an absent object's exit code 1 and nothing else of Git's output", async () => {
    const world = macWorld({
      repository: { 'git-object-exists': { ...output('', 1), stderr: 'fatal: x' } }, // prettier-ignore
    });
    const object = 'c'.repeat(40);
    const error = await failure(
      read(fakeHost(world), { kind: 'object-exists', object }),
    );
    expect(error).toBeInstanceOf(GitRepositoryReadError);
    expect(error).toMatchObject({ code: 'exit_status', exitCode: 1 });
    expect(String(error)).not.toContain('fatal');
    expect(world.probes.at(-1)?.command).toEqual({
      kind: 'git-object-exists',
      executable: MAC_GIT,
      object,
    });
  });

  it('carries a validated change-set range through to the command', async () => {
    const world = macWorld({
      repository: { 'git-diff-numstat': output('1\t0\ta\0') },
    });
    const range = { kind: 'objects', base: 'd'.repeat(40), head: 'HEAD' };
    await expect(
      read(fakeHost(world), { kind: 'diff-numstat', range }),
    ).resolves.toBe('1\t0\ta\0');
    expect(world.probes.at(-1)?.command).toEqual({
      kind: 'git-diff-numstat',
      executable: MAC_GIT,
      range,
    });
  });

  it('selects and runs repository reads on win32 instead of refusing D10', async () => {
    const world = createWorld('win32', {
      filesystem: { 'C:\\Git\\cmd\\git.exe': version('2.47.1.windows.1') },
      whereExe: { git: 'C:\\Git\\cmd\\git.exe\r\n' },
    });
    const target = fakeHost(world);
    for (const repositoryRead of [
      { kind: 'branch-refs' },
      { kind: 'remote-head' },
      { kind: 'origin-branch', branch: 'main' },
      { kind: 'inside-work-tree' },
      { kind: 'diff-name-status', range: { kind: 'worktree', base: 'HEAD' } },
      { kind: 'untracked-files' },
      { kind: 'unmerged-files' },
      { kind: 'object-exists', object: 'HEAD' },
    ])
      await expect(
        failure(read(target, repositoryRead, { cwd: 'C:\\repo' })),
      ).resolves.toMatchObject({ code: 'exit_status', exitCode: 128 });
    expect(
      world.probes.some(
        ({ command }) => command.kind === 'git-diff-name-status',
      ),
    ).toBe(true);
    expect(world.attempts.length).toBeGreaterThan(0);
  });

  it.each<[string, unknown]>([
    ['an unknown read', { kind: 'remote-set-head' }],
    ['a branch outside the enum', { kind: 'origin-branch', branch: 'topic' }],
    ['a branch base', { kind: 'diff-name-status', range: { kind: 'worktree', base: 'main' } }], // prettier-ignore
    ['an option as an object', { kind: 'object-exists', object: '--all' }],
    ['no read', null],
  ])('refuses %s before selection runs', async (_, repositoryRead) => {
    const world = macWorld();
    await expect(
      failure(read(fakeHost(world), repositoryRead)),
    ).resolves.toMatchObject({ code: 'invalid_request' });
    expect(world.probes).toEqual([]);
  });

  it('rejects a failed saved-preference read with git_unavailable, as check-ignore', async () => {
    const world = macWorld();
    const error = await failure(
      fakeHost(world).host.repository.readRepository({
        cwd: '/repo',
        read: { kind: 'git-dir' },
        readSavedExecutablePath: () =>
          Promise.reject(new Error('EACCES preferences.json')),
        signal: neverAborted(),
      }),
    );
    expect(error).toBeInstanceOf(GitRepositoryReadError);
    expect(error).toMatchObject({ code: 'git_unavailable' });
    expect(kinds(world)).not.toContain('git-dir');
  });

  it('rejects a relative directory with invalid_request', async () => {
    const world = macWorld();
    await expect(
      failure(read(fakeHost(world), { kind: 'git-dir' }, { cwd: 'repo' })),
    ).resolves.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects with the abort reason before and during selection', async () => {
    const reason = new Error('cancelled');
    const before = new AbortController();
    before.abort(reason);
    const world = macWorld();
    await expect(
      failure(read(fakeHost(world), { kind: 'git-dir' }, { signal: before.signal })), // prettier-ignore
    ).resolves.toBe(reason);
    expect(world.probes).toEqual([]);

    let release = (): void => undefined;
    const held = macWorld();
    held.gates.set(
      'git-version',
      new Promise((resolve) => (release = resolve)),
    );
    const during = new AbortController();
    const pending = failure(
      read(fakeHost(held), { kind: 'git-dir' }, { signal: during.signal }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    during.abort(reason);
    await expect(pending).resolves.toBe(reason);
    release();
    expect(kinds(held)).not.toContain('git-dir');
  });

  it('ends a selection still waiting at the request deadline', async () => {
    const world = macWorld();
    world.gates.set('git-version', new Promise(() => undefined));
    const target = fakeHost(world, {}, { timing: { requestDeadlineMs: 100 } });
    const started = performance.now();
    await expect(
      failure(read(target, { kind: 'git-dir' })),
    ).resolves.toMatchObject({ code: 'deadline_exceeded' });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(kinds(world)).not.toContain('git-dir');
  });

  it('refuses reads once the host stopped', async () => {
    const world = macWorld();
    const target = fakeHost(world);
    await target.host.stop(neverAborted());
    await expect(
      failure(read(target, { kind: 'git-dir' })),
    ).resolves.toMatchObject({ code: 'stopped' });
  });
});

describe('executable selection facts', () => {
  const select = (
    { host }: FakeHost,
    saved = '',
    recheck = false,
  ): ReturnType<FakeHost['host']['repository']['selectExecutable']> =>
    host.repository.selectExecutable({
      readSavedExecutablePath: () => Promise.resolve(saved),
      recheck,
      signal: neverAborted(),
    });

  it('reports a discovered macOS Git with its version and no path', async () => {
    const facts = await select(fakeHost(macWorld()));
    expect(facts).toEqual({
      ready: true,
      version: 'git version 2.47.1',
      origin: 'discovered',
      override: false,
    });
  });

  it('reports the saved choice and the override as their origins', async () => {
    const saved = '/opt/git/bin/git';
    const world = macWorld({
      filesystem: { [MAC_GIT]: version('2.47.1'), [saved]: version('2.48.0') },
    });
    await expect(select(fakeHost(world), saved)).resolves.toMatchObject({
      ready: true,
      origin: 'saved',
      version: 'git version 2.48.0',
    });
    const overridden = fakeHost(world, {
      environment: { PATH: '/usr/bin:/bin', CANOPY_GIT_EXECUTABLE: saved },
    });
    await expect(select(overridden)).resolves.toMatchObject({
      origin: 'override',
      override: true,
    });
  });

  it('keeps an unchanged selection without probing, unless rechecked', async () => {
    const world = macWorld();
    const target = fakeHost(world);
    await select(target);
    const probes = (): number =>
      kinds(world).filter((kind) => kind === 'git-version').length;
    const first = probes();
    await select(target);
    expect(probes()).toBe(first);
    await select(target, '', true);
    expect(probes()).toBe(first + 1);
  });

  it('blames the kept selection, not the saved choice, when it cannot be looked up', async () => {
    const saved = '/opt/git/bin/git';
    // The saved choice is missing, so discovery's Git is kept.
    const world = macWorld();
    const target = fakeHost(world);
    await expect(select(target, saved)).resolves.toMatchObject({
      ready: true,
      origin: 'discovered',
    });
    world.filesystem[MAC_GIT] = { kind: 'eacces' };
    await expect(select(target, saved)).resolves.toEqual({
      ready: false,
      code: 'selection_rejected',
      explicit: false,
    });

    // The saved choice itself kept, then unreadable: the choice's failure.
    const kept = macWorld({
      filesystem: { [MAC_GIT]: version('2.47.1'), [saved]: version('2.48.0') },
    });
    const keeping = fakeHost(kept);
    await expect(select(keeping, saved)).resolves.toMatchObject({
      origin: 'saved',
    });
    kept.filesystem[saved] = { kind: 'eacces' };
    await expect(select(keeping, saved)).resolves.toEqual({
      ready: false,
      code: 'selection_rejected',
      explicit: true,
    });
  });

  it.each(['x64', 'arm64'])(
    'reports Linux %s discovery sources and a broken explicit choice',
    async (arch) => {
      const world = createWorld('linux', {
        loginPath: '/opt/none',
        filesystem: { [LINUX_GIT]: version('2.43.0') },
      });
      await expect(
        select(fakeHost(world, {}, { arch })),
      ).resolves.toMatchObject({
        ready: true,
        origin: 'system',
      });
      await expect(
        select(fakeHost(world, {}, { arch }), '/missing/git'),
      ).resolves.toEqual({
        ready: false,
        code: 'git_unavailable',
        explicit: true,
      });
      const empty = createWorld('linux', { loginPath: '/opt/none' });
      await expect(select(fakeHost(empty, {}, { arch }))).resolves.toEqual({
        ready: false,
        code: 'git_unavailable',
        explicit: false,
      });
    },
  );

  it('reports an unvalidated Git where Git is not required', async () => {
    const world = createWorld('linux');
    await expect(
      select(fakeHost(world, {}, { arch: 's390x' })),
    ).resolves.toEqual({
      ready: true,
      version: null,
      origin: 'unvalidated',
      override: false,
    });
    expect(world.probes).toEqual([]);
  });

  it('reports Windows precedence, winget and existing unusable candidates without changing preferences', async () => {
    const saved = 'C:\\Saved Git\\git.exe';
    const override = 'C:\\Override Git\\git.exe';
    const discovered = 'C:\\Discovered Git\\git.exe';
    const world = createWorld('win32', {
      whereExe: {
        git: `${discovered}\r\n${discovered.toUpperCase()}\r\n`,
        winget: 'C:\\winget.exe\r\n',
      },
      filesystem: {
        [saved]: version('2.48.0.windows.1'),
        [override]: version('2.49.0.windows.1'),
        [discovered]: version('2.50.0.windows.1'),
      },
    });
    const localAppData = 'C:\\Users\\Test User\\AppData\\Local';
    const windowsApps = `${localAppData}\\Microsoft\\WindowsApps`;
    const environment: Record<string, string> = {
      ...createChildServices('win32').childEnvironment({
        source: {
          SystemRoot: 'C:\\Windows',
          USERPROFILE: 'C:\\Users\\Test User',
          APPDATA: 'C:\\Users\\Test User\\AppData\\Roaming',
          LOCALAPPDATA: localAppData,
          Path: `${windowsApps};C:\\User Git`,
        },
      }),
      canopy_git_executable: override,
    };
    expect(environment.PATH).not.toContain(windowsApps);
    const target = fakeHost(
      world,
      { environment },
      {
        createRunner: (options) => {
          const runner = worldRunner(world)(options);
          return {
            ...runner,
            async run(command, request): Promise<GitReadOutput> {
              const result = await runner.run(command, request);
              if (
                command.kind === 'where-winget' &&
                !request.environment.PATH?.split(';').includes(windowsApps)
              )
                return output('', 1);
              return result;
            },
          };
        },
      },
    );
    await expect(select(target, saved)).resolves.toMatchObject({
      origin: 'saved',
      wingetAvailable: true,
    });
    delete world.filesystem[saved];
    await expect(select(target, saved)).resolves.toMatchObject({
      origin: 'override',
      wingetAvailable: true,
    });
    world.filesystem[override] = { kind: 'directory' };
    await expect(select(target, saved, true)).resolves.toMatchObject({
      origin: 'discovered',
    });
    world.filesystem[discovered] = {
      kind: 'executable',
      stdout: 'usage: not-git\n',
    };
    await expect(select(target, saved, true)).resolves.toEqual({
      ready: false,
      code: 'selection_rejected',
      explicit: false,
      wingetAvailable: true,
    });
    delete world.filesystem[override];
    delete world.filesystem[discovered];
    delete world.whereExe.winget;
    await expect(select(target, saved)).resolves.toEqual({
      ready: false,
      code: 'git_unavailable',
      explicit: false,
      wingetAvailable: false,
    });
    expect(
      world.ran.filter((candidate) => candidate === discovered.toUpperCase()),
    ).toEqual([]);
    for (const { command, environment: observed } of world.probes)
      if (command.kind !== 'where-winget')
        expect(observed).toEqual(environment);
  });

  it.each(['relative/git.exe', 'C:\\Git\\not-git.exe'])(
    'reports invalid Windows explicit candidate %s as unusable, not absent',
    async (saved) => {
      await expect(
        select(fakeHost(createWorld('win32')), saved, true),
      ).resolves.toMatchObject({
        ready: false,
        code: 'selection_rejected',
        explicit: false,
        wingetAvailable: false,
      });
    },
  );

  it('reports Windows stat failures as missing during detection, not selected-unusable', async () => {
    const saved = 'C:\\Saved Git\\git.exe';
    const world = createWorld('win32', {
      filesystem: { [saved]: version('2.48.0') },
    });
    const target = fakeHost(world);
    await expect(select(target, saved)).resolves.toMatchObject({ ready: true });
    world.filesystem[saved] = { kind: 'eacces' };
    await expect(select(target, saved)).resolves.toEqual({
      ready: false,
      code: 'git_unavailable',
      explicit: false,
      wingetAvailable: false,
    });
  });

  it('reports a Windows candidate removed after successful stat as unusable', async () => {
    const saved = 'C:\\Saved Git\\git.exe';
    const world = createWorld('win32', {
      filesystem: { [saved]: version('2.48.0.windows.1') },
    });
    let release = (): void => undefined;
    let reached = (): void => undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const spawning = new Promise<void>((done) => {
      reached = done;
    });
    const target = fakeHost(
      world,
      {},
      {
        createRunner: (options) => {
          const runner = worldRunner(world)(options);
          return {
            ...runner,
            run: async (command, request): Promise<GitReadOutput> => {
              if (command.kind === 'git-version') {
                reached();
                await held;
              }
              return runner.run(command, request);
            },
          };
        },
      },
    );
    const pending = select(target, saved, true);
    await spawning;
    delete world.filesystem[saved];
    release();
    await expect(pending).resolves.toMatchObject({
      ready: false,
      code: 'selection_rejected',
      explicit: false,
    });
  });

  it('revalidates Windows facts without a rejection TTL and does not join a forced recheck', async () => {
    const saved = 'C:\\Saved Git\\git.exe';
    const world = createWorld('win32', {
      filesystem: { [saved]: version('2.48.0.windows.1') },
    });
    const target = fakeHost(world);
    const facts = (): ReturnType<typeof select> => select(target, saved);
    await facts();
    const first = world.ran.length;
    await facts();
    expect(world.ran.length).toBe(first + 1);
    world.filesystem[saved] = {
      kind: 'executable',
      stdout: 'git version 2.48.0.windows.1\n',
      transient: 'timeout',
    };
    await expect(select(target, saved, true)).resolves.toMatchObject({
      ready: false,
      code: 'selection_rejected',
    });
    world.filesystem[saved] = version('2.48.0.windows.1');
    await expect(select(target, saved, true)).resolves.toMatchObject({
      ready: true,
    });

    let release = (): void => undefined;
    let firstStarted = (): void => undefined;
    let secondStarted = (): void => undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const firstProbe = new Promise<void>((done) => {
      firstStarted = done;
    });
    const secondProbe = new Promise<void>((done) => {
      secondStarted = done;
    });
    let probes = 0;
    const concurrent = fakeHost(
      world,
      {},
      {
        createRunner: (options) => {
          const runner = worldRunner(world)(options);
          return {
            ...runner,
            run: async (command, request): Promise<GitReadOutput> => {
              if (command.kind === 'git-version') {
                probes += 1;
                if (probes === 1) firstStarted();
                if (probes === 2) secondStarted();
                await held;
              }
              return runner.run(command, request);
            },
          };
        },
      },
    );
    const pending = select(concurrent, saved);
    await firstProbe;
    const joined = select(concurrent, saved);
    const forced = select(concurrent, saved, true);
    await secondProbe;
    release();
    await expect(pending).resolves.toMatchObject({ ready: true });
    await expect(joined).resolves.toMatchObject({ ready: true });
    await expect(forced).resolves.toMatchObject({ ready: true });
    expect(probes).toBe(2);
  });

  it('keeps the newer forced Windows detection after the older finishes last', async () => {
    const saved = 'C:\\Saved Git\\git.exe';
    const world = createWorld('win32', {
      filesystem: { [saved]: version('2.48.0.windows.1') },
    });
    let release = (): void => {};
    let started = (): void => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    const reached = new Promise<void>((done) => {
      started = done;
    });
    let versions = 0;
    const target = fakeHost(
      world,
      {},
      {
        createRunner: (options) => {
          const runner = worldRunner(world)(options);
          return {
            ...runner,
            run: async (command, request): Promise<GitReadOutput> => {
              if (command.kind !== 'git-version')
                return runner.run(command, request);
              versions += 1;
              if (versions === 1) {
                started();
                await held;
                return output('git version 2.40.0.windows.1');
              }
              return output('git version 2.50.0.windows.1');
            },
          };
        },
      },
    );
    const facts = (): ReturnType<typeof select> =>
      target.host.repository.selectExecutable({
        readSavedExecutablePath: () => Promise.resolve(saved),
        signal: neverAborted(),
        recheck: true,
      });
    const older = facts();
    await reached;
    await expect(facts()).resolves.toMatchObject({
      version: 'git version 2.50.0.windows.1',
    });
    release();
    await expect(older).resolves.toMatchObject({
      version: 'git version 2.40.0.windows.1',
    });
    await target.resolve(saved);
    expect(world.checks.at(-1)?.version).toBe('git version 2.50.0.windows.1');
    expect(versions).toBe(2);
  });

  it('reports a stopped host as a failure, writing nothing', async () => {
    const target = fakeHost(macWorld());
    await target.host.stop(neverAborted());
    await expect(select(target)).resolves.toEqual({
      ready: false,
      code: 'stopped',
      explicit: false,
    });
  });
});
