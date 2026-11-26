// CAN-4070 rule: captured on the unchanged `repo:get-remote-url` IPC handler
// and reference-repository health check before CAN-5135 routed their remote
// reads through `worker.git.remote.get`. Real data root, workspace records,
// Git checkouts, bare origins and repository shadows; only IPC registration
// is mocked. Results are recorded as JSON text, so key order is pinned too.
import { execFileSync } from 'node:child_process';
import {
  type PathLike,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  type WorkspaceReferenceRepoStatusEvent,
} from '@canopy/desktop-shared/types';

const mockHandlers = new Map<
  string,
  (event: unknown, request: unknown) => Promise<unknown>
>();
// Pass-through, so a test can hold the destination probe (stat).
let mockStat: ((path: PathLike) => Promise<unknown>) | undefined;
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  const stat = (...args: Parameters<typeof actual.stat>): Promise<unknown> =>
    mockStat && args.length === 1 ? mockStat(args[0]) : actual.stat(...args);
  return { ...actual, stat };
});
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, request: unknown) => Promise<unknown>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));

import { registerRepoHandlers } from '../ipc/repos';
import { getResolvedGitExecutableForSpawn } from '../lib/git-executable';
import { inspectReferenceRepo } from '../lib/workspace-reference-repo-health';
import {
  requestRefresh,
  startPolling,
  stopPolling,
} from '../lib/workspace-reference-repo-poller';
import type { SendableBrowserWindow } from '../lib/window-send';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';

jest.setTimeout(120_000);

let dir: string;
let dataDir: string;
let originalDataDir: string | undefined;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function workspaceDir(id: string): string {
  return join(dataDir, 'workspaces', id);
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-q', '-b', 'main']);
  git(path, ['config', 'user.email', 'golden@example.com']);
  git(path, ['config', 'user.name', 'Golden']);
  writeFileSync(join(path, 'README.md'), 'readme\n');
  git(path, ['add', '.']);
  git(path, ['commit', '-q', '-m', 'initial']);
}

/** A clone of a fresh bare origin whose HEAD names main. */
function cloneWithOrigin(name: string): string {
  const seed = join(dir, 'seeds', name);
  initRepo(seed);
  const origin = join(dir, 'origins', `${name}.git`);
  mkdirSync(join(origin, '..'), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', seed, origin], {
    stdio: 'pipe',
  });
  const clone = join(dir, 'clones', name);
  mkdirSync(join(clone, '..'), { recursive: true });
  execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'pipe' });
  return clone;
}

function localRepo(name: string): string {
  const path = join(dir, 'clones', name);
  initRepo(path);
  return path;
}

function workspaceEntry(id: string, type: string, order: number): object {
  return { id, name: id, type, color: '#38BDF8', collapsed: false, order };
}

function addWorkspace(id: string, config: Record<string, unknown>): void {
  writeJson(join(workspaceDir(id), 'workspace.json'), {
    version: 1,
    repos: [],
    ...config,
  });
}

// Single-repo workspaces, named for the repository each one records.
const SINGLE = 'single-ws';
const SINGLE_NO_ORIGIN = 'single-no-origin-ws';
const SINGLE_EMPTY_URL = 'single-empty-url-ws';
const SINGLE_BLANK_URL = 'single-blank-url-ws';
const SINGLE_NO_URL = 'single-no-url-ws';
const SINGLE_BROKEN = 'single-broken-ws';
const SINGLE_PLAIN_DIR = 'single-plain-dir-ws';
const SINGLE_MISSING = 'single-missing-ws';
const SINGLE_WITH_SOURCE = 'single-with-source-ws';
// Multi-repo workspaces with a source repository and members.
const MULTI = 'multi-ws';
const MULTI_LOCAL = 'multi-local-ws';
const MULTI_OFFLINE = 'multi-offline-ws';
const MULTI_WORKTREE = 'multi-worktree-ws';
const MULTI_EMPTY_URL = 'multi-empty-url-ws';
const MULTI_BLANK_URL = 'multi-blank-url-ws';
const MULTI_NO_URL = 'multi-no-url-ws';
const MULTI_BROKEN = 'multi-broken-ws';
const MULTI_PLAIN_DIR = 'multi-plain-dir-ws';
const MULTI_MISSING = 'multi-missing-ws';
const MULTI_NO_SOURCE = 'multi-no-source-ws';
const MULTI_FILE_URL = 'multi-file-url-ws';
const NETWORK_URL =
  'https://x-access-token:secret@example.invalid/org/network.git';
const COWORK = 'cowork-ws';

const repos: Record<string, string> = {};
let configsBefore: Record<string, string> = {};

/** Every recorded repository's `.git/config`, keyed by repository name. */
function repositoryConfigs(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(repos).flatMap(([name, path]): [string, string][] => {
      try {
        return [[name, readFileSync(join(path, '.git', 'config'), 'utf8')]];
      } catch {
        return [];
      }
    }),
  );
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'git-remote-golden-')));
  dataDir = join(dir, 'data');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;

  repos.single = cloneWithOrigin('single');
  mkdirSync(join(repos.single, 'sub'));
  repos.noOrigin = localRepo('no-origin');
  // Older Git (2.37) prints an empty URL; newer Git (2.55) reads it as
  // resetting the URL list and prints the remote's name. See 'an empty origin
  // URL' below.
  repos.emptyUrl = localRepo('empty-url');
  git(repos.emptyUrl, ['config', 'remote.origin.url', '']);
  // Every Git prints this URL, and it reads back empty once trimmed.
  repos.blankUrl = localRepo('blank-url');
  git(repos.blankUrl, ['config', 'remote.origin.url', ' ']);
  // An origin section without a URL: Git prints the remote's name.
  repos.noUrl = localRepo('no-url');
  git(repos.noUrl, [
    'config',
    'remote.origin.fetch',
    '+refs/heads/*:refs/remotes/origin/*',
  ]);
  // Every remote read fails while the directory stays a repository.
  repos.broken = cloneWithOrigin('broken');
  git(repos.broken, ['config', 'remote.origin.mirror', 'notabool']);
  repos.plainDir = join(dir, 'plain', 'not-a-repo');
  mkdirSync(repos.plainDir, { recursive: true });
  repos.missing = join(dir, 'missing', 'gone');
  repos.source = cloneWithOrigin('source');
  repos.member = cloneWithOrigin('member');
  repos.memberLocal = localRepo('member-local');
  repos.local = localRepo('local-source');
  repos.offline = cloneWithOrigin('offline');
  git(repos.offline, [
    'remote',
    'set-url',
    'origin',
    join(dir, 'origins', 'missing.git'),
  ]);
  // A source recorded as a linked worktree resolves to its main checkout.
  repos.worktreeMain = cloneWithOrigin('worktree-main');
  repos.linked = join(dir, 'linked', 'feature');
  git(repos.worktreeMain, [
    'worktree',
    'add',
    '-q',
    '-b',
    'feature',
    repos.linked,
  ]);
  repos.untracked = cloneWithOrigin('untracked');
  repos.untrackedLocal = localRepo('untracked-local');
  repos.untrackedPlain = join(dir, 'plain', 'untracked');
  mkdirSync(repos.untrackedPlain, { recursive: true });
  repos.sideSource = cloneWithOrigin('side-source');
  // Every other origin above is a plain path; this one is a `file://` URL.
  repos.fileUrl = cloneWithOrigin('file-url');
  git(repos.fileUrl, [
    'remote',
    'set-url',
    'origin',
    `file://${join(dir, 'origins', 'file-url.git')}`,
  ]);
  // A network origin whose userinfo carries a token; only Git's local
  // configuration is read, never the network.
  repos.network = localRepo('network');
  git(repos.network, ['remote', 'add', 'origin', NETWORK_URL]);

  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      ...[
        SINGLE,
        SINGLE_NO_ORIGIN,
        SINGLE_EMPTY_URL,
        SINGLE_BLANK_URL,
        SINGLE_NO_URL,
        SINGLE_BROKEN,
        SINGLE_PLAIN_DIR,
        SINGLE_MISSING,
        SINGLE_WITH_SOURCE,
      ].map((id, order) => workspaceEntry(id, 'single-repo', order)),
      ...[
        MULTI,
        MULTI_LOCAL,
        MULTI_OFFLINE,
        MULTI_WORKTREE,
        MULTI_EMPTY_URL,
        MULTI_BLANK_URL,
        MULTI_NO_URL,
        MULTI_BROKEN,
        MULTI_PLAIN_DIR,
        MULTI_MISSING,
        MULTI_NO_SOURCE,
      ].map((id, order) => workspaceEntry(id, 'multi-repo', 20 + order)),
      workspaceEntry(COWORK, 'cowork', 40),
      workspaceEntry(MULTI_FILE_URL, 'multi-repo', 41),
    ],
  });
  for (const [id, repo] of [
    [SINGLE, repos.single],
    [SINGLE_NO_ORIGIN, repos.noOrigin],
    [SINGLE_EMPTY_URL, repos.emptyUrl],
    [SINGLE_BLANK_URL, repos.blankUrl],
    [SINGLE_NO_URL, repos.noUrl],
    [SINGLE_BROKEN, repos.broken],
    [SINGLE_PLAIN_DIR, repos.plainDir],
    [SINGLE_MISSING, repos.missing],
  ] as const)
    addWorkspace(id, { type: 'single-repo', repoPath: repo });
  // A single-repo record that also carries a source path.
  addWorkspace(SINGLE_WITH_SOURCE, {
    type: 'single-repo',
    repoPath: repos.single,
    sourceRepoPath: repos.sideSource,
  });
  addWorkspace(MULTI, {
    type: 'multi-repo',
    sourceRepoPath: repos.source,
    repos: [
      { id: 'member', name: 'member', repoPath: repos.member },
      { id: 'member-local', name: 'member-local', repoPath: repos.memberLocal },
    ],
  });
  for (const [id, repo] of [
    [MULTI_LOCAL, repos.local],
    [MULTI_OFFLINE, repos.offline],
    [MULTI_WORKTREE, repos.linked],
    [MULTI_EMPTY_URL, repos.emptyUrl],
    [MULTI_BLANK_URL, repos.blankUrl],
    [MULTI_NO_URL, repos.noUrl],
    [MULTI_BROKEN, repos.broken],
    [MULTI_PLAIN_DIR, repos.plainDir],
    [MULTI_MISSING, repos.missing],
  ] as const)
    addWorkspace(id, { type: 'multi-repo', sourceRepoPath: repo });
  addWorkspace(MULTI_NO_SOURCE, {
    type: 'multi-repo',
    repos: [{ id: 'member', name: 'member', repoPath: repos.member }],
  });
  addWorkspace(COWORK, { type: 'cowork' });
  addWorkspace(MULTI_FILE_URL, {
    type: 'multi-repo',
    sourceRepoPath: repos.fileUrl,
    repos: [{ id: 'network', name: 'network', repoPath: repos.network }],
  });

  configsBefore = repositoryConfigs();
  registerHandlers();
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

let runtime: DesktopCanopyDispatcher;

function registerHandlers(): void {
  runtime = createDesktopRuntime();
  registerRepoHandlers({
    dispatcher: runtime,
    resolveCaller: (): CanopyCallerDescriptor => desktopCaller,
  });
}

afterAll(async () => {
  stopPolling();
  await runtime.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

function scrub(value: string): string {
  return value
    .split(dir)
    .join('<root>')
    .replace(ISO, '<time>')
    .replace(/repo-shadows([/\\])[0-9a-f]{16}/g, 'repo-shadows$1<key>')
    .replace(/spawn \S+ ENOENT/g, 'spawn <git> ENOENT')
    .replace(/Command failed: \S+ /g, 'Command failed: <git> ');
}

// Child-process errors come from another Jest realm, so read their fields
// instead of relying on `instanceof Error`.
function describeError(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null)
    return { thrown: String(error) };
  const code: unknown = Reflect.get(error, 'code');
  return {
    name: String(Reflect.get(error, 'name')),
    message: scrub(String(Reflect.get(error, 'message'))),
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
  };
}

type Outcome = { json: string } | { error: Record<string, unknown> };

async function settle(work: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { json: scrub(JSON.stringify(await work()) ?? 'undefined') };
  } catch (error) {
    return { error: describeError(error) };
  }
}

function remoteUrl(request: unknown): Promise<Outcome> {
  const handler = mockHandlers.get(IPC_CHANNELS.repoGetRemoteUrl);
  if (!handler) throw new Error('repo:get-remote-url was not registered');
  const event: Partial<IpcMainInvokeEvent> = {};
  return settle(() => handler(event, request));
}

function health(workspaceId: string): Promise<Outcome> {
  return settle(() => inspectReferenceRepo(runtime, workspaceId));
}

describe('repo:get-remote-url', () => {
  it('reads the origin of recorded workspace repositories', async () => {
    for (const [label, repoPath] of [
      ['single-repo repository', repos.single],
      ['multi-repo source repository', repos.source],
      ['multi-repo member', repos.member],
      ['multi-repo member without origin', repos.memberLocal],
      ['repository without origin', repos.noOrigin],
      ['blank origin URL', repos.blankUrl],
      ['origin without a URL', repos.noUrl],
      ['unreadable remote configuration', repos.broken],
      ['directory that is not a repository', repos.plainDir],
      ['missing directory', repos.missing],
      ['unreachable origin', repos.offline],
      ['source recorded as a linked worktree', repos.linked],
    ])
      expect(await remoteUrl({ repoPath })).toMatchSnapshot(label);
  });

  it('trims the requested path before reading it', async () => {
    expect(
      await remoteUrl({ repoPath: `  ${repos.single}\n` }),
    ).toMatchSnapshot();
  });

  it('reads paths no workspace records directly', async () => {
    for (const [label, repoPath] of [
      ['untracked repository', repos.untracked],
      ['untracked repository without origin', repos.untrackedLocal],
      ['untracked directory', repos.untrackedPlain],
      ['untracked missing directory', join(dir, 'missing', 'untracked')],
      ['subdirectory of a recorded repository', join(repos.single, 'sub')],
      ['recorded repository with a trailing separator', `${repos.single}/`],
      ['main checkout of a recorded linked worktree', repos.worktreeMain],
    ])
      expect(await remoteUrl({ repoPath })).toMatchSnapshot(label);
  });

  it('keeps request validation messages', async () => {
    for (const request of [
      { repoPath: '' },
      { repoPath: '   ' },
      { repoPath: 'relative/repo' },
      { repoPath: 42 },
      {},
      undefined,
    ])
      expect(await remoteUrl(request)).toMatchSnapshot(
        JSON.stringify(request) ?? 'undefined',
      );
  });
});

describe('reference repository health', () => {
  it('syncs the shadow of a source repository with an origin', async () => {
    expect(await health(MULTI)).toMatchSnapshot();
  });

  it('reports a source repository without origin as healthy without a shadow', async () => {
    expect(await health(MULTI_LOCAL)).toMatchSnapshot('no origin');
    expect(await health(MULTI_BLANK_URL)).toMatchSnapshot('blank origin URL');
  });

  it('reports a source whose origin has no URL as a failed shadow sync', async () => {
    expect(await health(MULTI_NO_URL)).toMatchSnapshot();
  });

  it('inspects a source recorded as a linked worktree at its main checkout', async () => {
    expect(await health(MULTI_WORKTREE)).toMatchSnapshot();
  });

  it('reports the shadow and origin of a source whose origin is unreachable', async () => {
    expect(await health(MULTI_OFFLINE)).toMatchSnapshot();
  });

  it('reports a source that is not a repository as a failed shadow sync', async () => {
    expect(await health(MULTI_PLAIN_DIR)).toMatchSnapshot('plain directory');
    expect(await health(MULTI_MISSING)).toMatchSnapshot('missing directory');
  });

  it('rethrows a remote read failure inside a repository', async () => {
    expect(await health(MULTI_BROKEN)).toMatchSnapshot();
  });

  it('inspects the recorded source path whatever the workspace type', async () => {
    expect(await health(SINGLE_WITH_SOURCE)).toMatchSnapshot(
      'single-repo with a source path',
    );
  });

  it('reports no status without a source repository', async () => {
    for (const workspaceId of [SINGLE, MULTI_NO_SOURCE, COWORK, 'ghost-ws'])
      expect(await health(workspaceId)).toMatchSnapshot(workspaceId);
  });

  it('keeps the failure of an invalid workspace id', async () => {
    for (const workspaceId of ['Bad', '', '../escape'])
      expect(await health(workspaceId)).toMatchSnapshot(
        JSON.stringify(workspaceId),
      );
  });

  it('publishes the status the poller reads', async () => {
    const events: WorkspaceReferenceRepoStatusEvent[] = [];
    let delivered: () => void = () => undefined;
    const received = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const window: SendableBrowserWindow = {
      isDestroyed: (): boolean => false,
      webContents: {
        send: (_channel: string, event: WorkspaceReferenceRepoStatusEvent) => {
          events.push(event);
          delivered();
        },
        isDestroyed: (): boolean => false,
        isCrashed: (): boolean => false,
        mainFrame: { isDestroyed: (): boolean => false, detached: false },
      },
    };
    startPolling(() => window, runtime);
    requestRefresh(MULTI_LOCAL, true);
    await received;
    stopPolling();
    expect(
      events.map((event) => scrub(JSON.stringify(event))),
    ).toMatchSnapshot();
  });
});

describe('an empty origin URL', () => {
  /** What the Git that production resolves prints as origin's URL. */
  async function printedOrigin(repoPath: string): Promise<string> {
    return execFileSync(
      await getResolvedGitExecutableForSpawn(),
      ['-C', repoPath, 'remote', 'get-url', 'origin'],
      { stdio: 'pipe', encoding: 'utf8' },
    ).replace(/\r?\n$/, '');
  }

  /** Both reads of a fixture, with its directory name masked. */
  async function reads(
    name: string,
    repoPath: string,
    workspaceId: string,
  ): Promise<string> {
    const outcomes = [await remoteUrl({ repoPath }), await health(workspaceId)];
    return JSON.stringify(outcomes)
      .split(`/clones/${name}`)
      .join('/clones/<repo>');
  }

  it('has a blank and a URL-less fixture that the running Git prints as such', async () => {
    // A failure here, not a snapshot diff, names a Git that reads them anew.
    expect(await printedOrigin(repos.blankUrl)).toBe(' ');
    expect(await printedOrigin(repos.noUrl)).toBe('origin');
  });

  it('reads like the blank or URL-less origin the running Git equates it with', async () => {
    // What the running Git prints decides the expectation, so the snapshotted
    // equivalents above pin both readings without depending on its version.
    const printed = await printedOrigin(repos.emptyUrl);
    expect(['', 'origin']).toContain(printed);
    const blank = await reads('blank-url', repos.blankUrl, MULTI_BLANK_URL);
    const unset = await reads('no-url', repos.noUrl, MULTI_NO_URL);
    expect(blank).not.toBe(unset);
    expect(await reads('empty-url', repos.emptyUrl, MULTI_EMPTY_URL)).toBe(
      printed === '' ? blank : unset,
    );
  });
});

// Added after the snapshot capture with explicit expectations, and proven
// against the unchanged handlers the same way.
describe('a network origin with userinfo', () => {
  it('answers repo:get-remote-url with the URL Git prints, userinfo included', async () => {
    expect(await remoteUrl({ repoPath: repos.network })).toEqual({
      json: JSON.stringify({ remoteUrl: NETWORK_URL }),
    });
  });
});

describe('a file URL origin', () => {
  const url = 'file://<root>/origins/file-url.git';

  it('answers repo:get-remote-url with the URL Git prints', async () => {
    expect(await remoteUrl({ repoPath: repos.fileUrl })).toEqual({
      json: JSON.stringify({ remoteUrl: url }),
    });
  });

  it('syncs the shadow and reports the URL Git prints', async () => {
    expect(await health(MULTI_FILE_URL)).toEqual({
      json: JSON.stringify({
        referenceRepoPath: '<root>/clones/file-url',
        shadowPath: '<root>/data/repo-shadows/<key>/checkout',
        healthy: true,
        warnings: [],
        lastCheckedAt: '<time>',
        remoteUrl: url,
        defaultBranch: 'main',
      }),
    });
  });
});

// CAN-4096 Capture (CAN-7937), explicit expectations on the unchanged
// handlers: both channels name a destination with a stat-only probe, so two
// calls that probe before either creates it share one path.
describe('repo:add-remote and repo:init-local', () => {
  const realStat =
    jest.requireActual<typeof FsPromises>('node:fs/promises').stat;
  afterEach(() => {
    mockStat = undefined;
  });

  function invoke(channel: string, request: unknown): Promise<Outcome> {
    const handler = mockHandlers.get(channel);
    if (!handler) throw new Error(`${channel} was not registered`);
    return settle(() => handler({}, request));
  }

  /**
   * Two calls whose probes of `path` both run before the first call creates
   * it; the second call goes on only once the first has settled.
   */
  async function overlapProbes(
    path: string,
    call: () => Promise<Outcome>,
  ): Promise<[Outcome, Outcome]> {
    const [reached, probed, settled] = [0, 1, 2].map(() =>
      Promise.withResolvers<void>(),
    );
    let calls = 0;
    mockStat = async (target): Promise<unknown> => {
      if (target !== path || calls === 2) return realStat(target);
      calls += 1;
      const isFirst = calls === 1;
      if (isFirst) reached.resolve();
      const result = await realStat(target).then(
        (stats) => ({ stats }),
        (error: unknown) => ({ error }),
      );
      if (!isFirst) probed.resolve();
      await (isFirst ? probed : settled).promise;
      if ('error' in result) throw result.error;
      return result.stats;
    };
    const first = call().finally(settled.resolve);
    await reached.promise;
    const second = call();
    return [await first, await second];
  }

  it('repo:add-remote clones into the next free name and removes a clone whose HEAD it refuses', async () => {
    const origin = join(dir, 'origins', 'single.git');
    const destinationDir = join(dir, 'add-remote');
    const add = (): Promise<Outcome> =>
      invoke(IPC_CHANNELS.repoAddRemote, { remoteUrl: origin, destinationDir });
    expect(await add()).toEqual({
      json: '{"name":"single","path":"<root>/add-remote/single"}',
    });
    expect(await add()).toEqual({
      json: '{"name":"single-2","path":"<root>/add-remote/single-2"}',
    });

    const hostile = join(dir, 'origins', 'hostile.git');
    execFileSync('git', ['clone', '-q', '--bare', origin, hostile]);
    git(hostile, ['update-ref', 'refs/heads/-a', 'refs/heads/main']);
    git(hostile, ['symbolic-ref', 'HEAD', 'refs/heads/-a']);
    expect(
      await invoke(IPC_CHANNELS.repoAddRemote, {
        remoteUrl: hostile,
        destinationDir,
      }),
    ).toMatchObject({
      error: {
        name: 'InvalidRemoteHeadCloneError',
        code: 'invalid-remote-default-branch',
      },
    });
    expect(readdirSync(destinationDir).sort()).toEqual(['single', 'single-2']);
  });

  it('repo:add-remote calls that probe one name together leave the second to fail in the first clone', async () => {
    const origin = join(dir, 'origins', 'single.git');
    const destinationDir = join(dir, 'add-remote-race');
    const add = (): Promise<Outcome> =>
      invoke(IPC_CHANNELS.repoAddRemote, { remoteUrl: origin, destinationDir });
    const [first, second] = await overlapProbes(
      join(destinationDir, 'single'),
      add,
    );
    expect(first).toEqual({
      json: '{"name":"single","path":"<root>/add-remote-race/single"}',
    });
    expect('error' in second && String(second.error.message)).toContain(
      "destination path '<root>/add-remote-race/single' already exists and is not an empty directory",
    );
    expect(readdirSync(destinationDir)).toEqual(['single']);
    expect(git(join(destinationDir, 'single'), ['log', '--format=%s'])).toBe(
      'initial',
    );
  });

  it('repo:init-local calls that probe one name together share its directory, and the second fails to commit; a later call takes the next name', async () => {
    const init = (name: string): Promise<Outcome> =>
      invoke(IPC_CHANNELS.repoInitLocal, { name });
    const [first, second] = await overlapProbes(
      join(dataDir, 'repos', 'scratch'),
      () => init('scratch'),
    );
    expect(first).toEqual({
      json: '{"name":"scratch","path":"<root>/data/repos/scratch"}',
    });
    // The second re-initializes the same checkout and finds nothing to commit.
    expect(second).toMatchObject({ error: { code: 1 } });
    expect('error' in second && String(second.error.message)).toContain(
      'commit -m',
    );
    expect(await init(' scratch ')).toEqual({
      json: '{"name":"scratch-2","path":"<root>/data/repos/scratch-2"}',
    });
    const created = join(dataDir, 'repos', 'scratch');
    expect(git(created, ['log', '--format=%s'])).toBe('Initial commit');
    expect(git(created, ['ls-files']).split('\n').sort()).toEqual([
      '.gitignore',
      'README.md',
      'canopy.json',
    ]);
    expect(readdirSync(join(dataDir, 'repos')).sort()).toEqual([
      'scratch',
      'scratch-2',
    ]);
  });
});

it('leaves every repository configuration unchanged', () => {
  expect(repositoryConfigs()).toEqual(configsBefore);
});
