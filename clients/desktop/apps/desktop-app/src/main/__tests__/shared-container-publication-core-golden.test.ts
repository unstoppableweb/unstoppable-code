// CAN-6501 PR 6 golden: core.publication.fileScope.get, fileScope.update and
// preview.get on a real desktop dispatcher, over the real file-scope store and
// share preview on a data root the golden owns, with real git worktrees under
// a git config the golden owns. It pins the gate, the grants, desktop's path
// normalization, keyed replay, and that a preview's only network call is the
// GitHub commit probe through the user's existing credential lease.
// Replaced: the shared-containers flag value, observability diagnostics, the
// cloud base URL and HTTP (an in-test hosted service that must see no
// request, though a signed-in account could reach it), the GitHub credential
// port (an opaque lease with no token) and the GitHub client (an in-test
// commit probe). Only the clock is faked.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { WorkspaceType } from '@canopy/desktop-shared/types';
import type {
  CanopyCallerDescriptor,
  CanopyGrantName,
} from '@canopy/protocol/canopy-core';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type * as CloudConfig from '../canopy-cloud/config';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import type * as CredentialPort from '../lib/github-broker/credential-port';
import type * as GitHubClient from '../lib/github-client';
import type * as MainProcessLogging from '../lib/main-process-logging';
import type * as PanelPersistence from '../panels/persistence';
import type * as FileScopeStore from '../shared-containers/file-scope-store';
import type * as FileScopeUpdate from '../shared-containers/file-scope-update';
import type * as SharePreview from '../shared-containers/share-preview';
import {
  cloud,
  fakeCloud,
  FIXED_TIME,
  ownDataRoot,
  saveAccount,
  stable,
  type Json,
  type OwnedDataRoot,
} from './helpers/shared-containers-golden-harness';

jest.setTimeout(30_000);

jest.mock('../canopy-cloud/config', () => ({
  ...jest.requireActual<typeof CloudConfig>('../canopy-cloud/config'),
  getCanopyCloudBaseUrl: (): string => 'https://cloud.example.test',
}));
const flags = { sharedContainers: true };
jest.mock('../observability', () => ({
  getObservabilityService: (): Json => ({
    getRetentionDays: (): number => 30,
    recordSessionDiagnostic: (): void => undefined,
  }),
}));
// The user's GitHub credential, as an opaque lease the probe passes through.
const mockGitHub = { probes: [] as string[], failWith: 0, notFound: 0 };
type MockOctokit = {
  request: (route: string, params: Json) => Promise<unknown>;
};
jest.mock('../lib/github-broker/credential-port', () => ({
  ...jest.requireActual<typeof CredentialPort>(
    '../lib/github-broker/credential-port',
  ),
  getGitHubBrokerCredentialPort: (): Json => ({
    lease: (): Promise<Json> =>
      Promise.resolve({ lease: { golden: 'opaque-lease' } }),
  }),
}));
jest.mock('../lib/github-client', () => ({
  ...jest.requireActual<typeof GitHubClient>('../lib/github-client'),
  getGitHubClient: (): Json => ({
    enqueue: (run: (octokit: MockOctokit) => Promise<unknown>) =>
      run({
        request: (route, params): Promise<unknown> => {
          mockGitHub.probes.push(
            `${route} ${String(params.owner)}/${String(params.repo)}@${String(params.ref)}`,
          );
          if (mockGitHub.notFound > 0) {
            mockGitHub.notFound -= 1;
            return Promise.reject(
              Object.assign(new Error('Not Found'), { status: 404 }),
            );
          }
          return mockGitHub.failWith
            ? Promise.reject(
                Object.assign(new Error('GitHub is unavailable'), {
                  status: mockGitHub.failWith,
                }),
              )
            : Promise.resolve({ status: 200, data: {} });
        },
      }),
  }),
}));
// The save's candidate listing, real unless a case holds it at a gate.
const mockCandidates: {
  gate?: Promise<void>;
  entered?: () => void;
  failed?: boolean;
} = {};
jest.mock('../shared-containers/share-preview', () => {
  const actual = jest.requireActual<typeof SharePreview>(
    '../shared-containers/share-preview',
  );
  return {
    ...actual,
    listSharedContainerUntrackedCandidatePaths: async (
      ...args: Parameters<
        typeof actual.listSharedContainerUntrackedCandidatePaths
      >
    ): Promise<string[]> => {
      mockCandidates.entered?.();
      await mockCandidates.gate;
      // A failed git listing answers no candidates, as desktop's does.
      if (mockCandidates.failed) return [];
      return await actual.listSharedContainerUntrackedCandidatePaths(...args);
    },
  };
});
// The real scope read, which a case can hold once.
const mockScopeRead: { before?: () => void | Promise<void> } = {};
jest.mock('../shared-containers/file-scope-store', () => {
  const actual = jest.requireActual<typeof FileScopeStore>(
    '../shared-containers/file-scope-store',
  );
  return {
    ...actual,
    readSharedContainerFileScope: async (
      ...args: Parameters<typeof actual.readSharedContainerFileScope>
    ): ReturnType<typeof actual.readSharedContainerFileScope> => {
      const before = mockScopeRead.before;
      delete mockScopeRead.before;
      await before?.();
      return await actual.readSharedContainerFileScope(...args);
    },
  };
});

// The real warning log, which a case can hook once for one message: the
// store logs a malformed scope file after its lock-entry abort check and
// before its atomic write.
const mockWarn: { message?: string; before?: () => void } = {};
jest.mock('../lib/main-process-logging', () => {
  const actual = jest.requireActual<typeof MainProcessLogging>(
    '../lib/main-process-logging',
  );
  return {
    ...actual,
    logMainProcessWarn: (
      ...args: Parameters<typeof actual.logMainProcessWarn>
    ): void => {
      if (args[0] === mockWarn.message) {
        const before = mockWarn.before;
        delete mockWarn.message;
        delete mockWarn.before;
        before?.();
      }
      actual.logMainProcessWarn(...args);
    },
  };
});
// The real save, whose last run a case can await after its caller has
// already been answered.
const mockSave: { last?: Promise<unknown> } = {};
jest.mock('../shared-containers/file-scope-update', () => {
  const actual = jest.requireActual<typeof FileScopeUpdate>(
    '../shared-containers/file-scope-update',
  );
  return {
    ...actual,
    saveSharedContainerFileScope: (
      ...args: Parameters<typeof actual.saveSharedContainerFileScope>
    ): ReturnType<typeof actual.saveSharedContainerFileScope> => {
      const run = actual.saveSharedContainerFileScope(...args);
      mockSave.last = run;
      return run;
    },
  };
});

const PROJECT_ID = 'sc-publication-golden';
const WORKTREE_ID = 'golden-wt';
const COWORK_PROJECT_ID = 'sc-cowork-golden';
const COWORK_WORKTREE_ID = 'cowork-wt';
const ORG_ID = '00000000-0000-4000-8000-00000000a001';

const PUBLICATION_READ: CanopyGrantName = 'core.publication.read';
const PUBLICATION_WRITE: CanopyGrantName = 'core.publication.write';
const WORKSPACE_READ: CanopyGrantName = 'core.workspace.read';
const WORKSPACE_WRITE: CanopyGrantName = 'core.workspace.write';
const READS = [PUBLICATION_READ, WORKSPACE_READ];
const WRITES = [PUBLICATION_WRITE, WORKSPACE_WRITE];

let owned: OwnedDataRoot;
let fetchSpy: jest.SpyInstance;
let dispatcher: DesktopCanopyDispatcher | undefined;
let headSha = '';
let keyCounter = 0;
let registerWorkspaces: (types: Map<string, WorkspaceType>) => void;
const BOTH_WORKSPACES = (): Map<string, WorkspaceType> =>
  new Map([
    [PROJECT_ID, 'single-repo'],
    [COWORK_PROJECT_ID, 'cowork'],
  ]);
const caller = (grants: CanopyGrantName[]): CanopyCallerDescriptor => ({
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'desktop-local',
  interfaceKind: 'desktop',
  grants,
});
const dataPath = (...segments: string[]): string =>
  join(owned.dataDir, ...segments);
const scopeFile = (projectId: string, worktreeId: string): string =>
  dataPath(
    'workspaces',
    projectId,
    'worktree-data',
    worktreeId,
    'share-file-scope.json',
  );
const must = (): DesktopCanopyDispatcher => {
  if (!dispatcher) throw new Error('The dispatcher did not start');
  return dispatcher;
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=Golden', '-c', 'user.email=golden@example.test']
      .concat(['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'])
      .concat(args),
    {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: FIXED_TIME,
        GIT_COMMITTER_DATE: FIXED_TIME,
      },
      encoding: 'utf8',
    },
  ).trim();

/** A real git checkout with one commit, pushed as far as origin/main knows. */
function initRepository(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', `--template=${owned.gitTemplateDir}`);
  git(path, 'remote', 'add', 'origin', 'https://github.com/example/golden.git');
  writeFileSync(join(path, 'README.md'), '# Golden\n');
  git(path, 'add', 'README.md');
  git(path, 'commit', '-q', '-m', 'Initial commit');
  // Pushed as far as the local remote-tracking ref knows; nothing is fetched.
  git(path, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(join(path, 'notes.txt'), 'untracked\n');
  return git(path, 'rev-parse', 'HEAD');
}

/** A single-repo project whose worktree is a real git checkout. */
function createProject(projectId: string, worktreeId: string): string {
  const workspaceDir = dataPath('workspaces', projectId);
  const worktreePath = join(workspaceDir, 'worktrees', worktreeId);
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(workspaceDir, 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'single-repo',
      repoPath: worktreePath,
      repos: [],
    }),
  );
  return initRepository(worktreePath);
}

/** One operation's answer: its result, or the error payload a client sees. */
async function settle(answer: Promise<unknown>): Promise<unknown> {
  try {
    return { resolved: stable(await answer, owned.root) };
  } catch (error) {
    if (!(error instanceof CanopyOperationError)) throw error;
    expect(JSON.stringify(error.payload)).not.toContain(owned.root);
    const { kind, code, message, retry } = error.payload;
    return {
      rejected: stable(
        { kind, ...(code ? { code } : {}), message, retry: retry.kind },
        owned.root,
      ),
    };
  }
}

const fileScopeGet = (
  projectId = PROJECT_ID,
  worktreeId = WORKTREE_ID,
  grants = READS,
): Promise<unknown> =>
  settle(
    must().query(
      'core.publication.fileScope.get',
      { projectId, worktreeId },
      { caller: caller(grants) },
    ),
  );
const fileScopeUpdate = (
  params: Json,
  {
    grants = WRITES,
    key = `golden-key-${++keyCounter}`,
  }: { grants?: CanopyGrantName[]; key?: string } = {},
): Promise<unknown> =>
  settle(
    must().instruction(
      'core.publication.fileScope.update',
      {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        includedPaths: [],
        ...params,
      },
      { caller: caller(grants), metadata: { idempotencyKey: key } },
    ),
  );
const previewGet = (
  grants = READS,
  target: {
    projectId: string;
    worktreeId: string;
    containerType: 'CODE_WORKTREE' | 'COWORK_WORK_ENTRY';
  } = {
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    containerType: 'CODE_WORKTREE',
  },
): Promise<unknown> =>
  settle(
    must().query(
      'core.publication.preview.get',
      { ...target, organizationId: ORG_ID },
      { caller: caller(grants) },
    ),
  );

/** The layout store a pin captures from; a case spies on it. */
const panelLayouts = async (): Promise<
  typeof PanelPersistence.panelLayoutPersistenceStore
> => (await import('../panels/persistence')).panelLayoutPersistenceStore;
/** The smallest panel layout a pin captures. */
const PANEL_LAYOUT = {
  version: 1,
  grid: {
    root: {
      type: 'leaf',
      groupId: 'golden-group',
      panels: [],
      activePanelId: null,
      size: 1,
    },
    orientation: 0,
    width: 800,
    height: 600,
  },
  activeGroupId: 'golden-group',
  mostRecentActiveGroupIds: ['golden-group'],
};

beforeAll(async () => {
  // The golden owns its data roots before any code under test loads.
  owned = ownDataRoot('shared-container-publication-core-golden-');
  headSha = createProject(PROJECT_ID, WORKTREE_ID);
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(fakeCloud);
  // Signed in with shared containers, so a hosted call would reach fetch and
  // the empty request log below would catch it.
  cloud.capabilities = ['shared-containers-v1'];
  await saveAccount(['shared-containers-v1']);
  jest.useFakeTimers({
    now: new Date(FIXED_TIME),
    doNotFake: [
      'nextTick',
      'setImmediate',
      'queueMicrotask',
      'hrtime',
      'performance',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ],
  });
  // The real flag service, with the shared-containers flag under test control.
  const service = (await import('../feature-flags')).getFeatureFlagService();
  const isEnabled = service.isEnabled.bind(service);
  jest
    .spyOn(service, 'isEnabled')
    .mockImplementation((key) =>
      key === CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key
        ? flags.sharedContainers
        : isEnabled(key),
    );
  registerWorkspaces = (await import('../lib/workspace-registry'))
    .registerWorkspaceTypes;
  registerWorkspaces(BOTH_WORKSPACES());
  // A Cowork Work Entry's files live where desktop resolves its worktree.
  const { resolveWorktreeCwd } = await import('../lib/resolve-worktree');
  initRepository(resolveWorktreeCwd(COWORK_PROJECT_ID, COWORK_WORKTREE_ID));
  const { createDesktopRuntime } =
    await import('../canopy-runtime/desktop-runtime');
  dispatcher = createDesktopRuntime({ shutdownTimeoutMs: 25 });
});

afterAll(async () => {
  try {
    await dispatcher?.shutdown();
  } finally {
    jest.useRealTimers();
    fetchSpy?.mockRestore();
    // Released even when a setup step threw, so the env and fs are restored.
    owned?.release();
  }
});

// No operation reaches the hosted service or fetch at all, and nothing lands
// outside the owned root.
afterEach(() => {
  expect(cloud.requests).toEqual([]);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(owned.outsideWrites).toEqual([]);
});

// Every case starts from empty scopes and an available GitHub. A preview's
// sidebar read rebuilds the workspace registry, so both types are registered
// again, as desktop's sidebar would list them.
beforeEach(() => {
  registerWorkspaces(BOTH_WORKSPACES());
  flags.sharedContainers = true;
  mockGitHub.probes.length = 0;
  mockGitHub.failWith = 0;
  mockGitHub.notFound = 0;
  for (const projectId of [PROJECT_ID, COWORK_PROJECT_ID])
    rmSync(dataPath('workspaces', projectId, 'worktree-data'), {
      recursive: true,
      force: true,
    });
});

describe('core.publication shared-container scope and preview on desktop (CAN-6501 PR 6 golden)', () => {
  it('answers capability_unavailable for every operation while shared containers are off', async () => {
    flags.sharedContainers = false;
    const unavailable = {
      rejected: {
        kind: 'capability_unavailable',
        message: 'Shared containers are disabled.',
        retry: 'never',
      },
    };
    expect({
      fileScopeGet: await fileScopeGet(),
      fileScopeUpdate: await fileScopeUpdate({}),
      previewGet: await previewGet(),
    }).toEqual({
      fileScopeGet: unavailable,
      fileScopeUpdate: unavailable,
      previewGet: unavailable,
    });
    expect(existsSync(scopeFile(PROJECT_ID, WORKTREE_ID))).toBe(false);
  });

  it('refuses each operation without both of its grants', async () => {
    const answers = {
      fileScopeGetWithoutWorkspaceRead: await fileScopeGet(
        PROJECT_ID,
        WORKTREE_ID,
        [PUBLICATION_READ],
      ),
      fileScopeGetWithoutPublicationRead: await fileScopeGet(
        PROJECT_ID,
        WORKTREE_ID,
        [WORKSPACE_READ],
      ),
      previewWithoutWorkspaceRead: await previewGet([PUBLICATION_READ]),
      previewWithoutPublicationRead: await previewGet([WORKSPACE_READ]),
      updateWithoutWorkspaceWrite: await fileScopeUpdate(
        { excludedPaths: ['notes.txt'] },
        { grants: [PUBLICATION_WRITE] },
      ),
      updateWithoutPublicationWrite: await fileScopeUpdate(
        { excludedPaths: ['notes.txt'] },
        { grants: [WORKSPACE_WRITE] },
      ),
    };
    for (const answer of Object.values(answers))
      expect(answer).toMatchObject({
        rejected: { kind: 'permission_denied' },
      });
    expect(existsSync(scopeFile(PROJECT_ID, WORKTREE_ID))).toBe(false);
  });

  it('answers the default scope for a worktree with none stored, known or not', async () => {
    const empty = {
      resolved: {
        fileScope: {
          includedPaths: [],
          includedNoteIds: [],
          includedPromptIds: [],
          includedRunScripts: [],
          runSharingEnabled: false,
        },
      },
    };
    expect(await fileScopeGet()).toMatchObject(empty);
    // Desktop does not check that a project or worktree exists here.
    expect(
      await fileScopeGet('no-such-project', 'no-such-worktree'),
    ).toMatchObject(empty);
  });

  it('refuses a selected note or prompt id over 255 characters and saves one of 255', async () => {
    const longest = 'n'.repeat(255);
    for (const field of [
      'excludedNoteIds',
      'excludedPromptIds',
      'includedNoteIds',
      'includedPromptIds',
    ])
      expect(await fileScopeUpdate({ [field]: [`${longest}x`] })).toMatchObject(
        {
          rejected: { kind: 'invalid_argument' },
        },
      );
    expect(existsSync(scopeFile(PROJECT_ID, WORKTREE_ID))).toBe(false);
    expect(await fileScopeUpdate({ excludedNoteIds: [longest] })).toMatchObject(
      {
        resolved: { fileScope: { excludedNoteIds: [longest] } },
      },
    );
  });

  it('drops traversal paths from a saved scope', async () => {
    const answer = await fileScopeUpdate({
      excludedPaths: ['../escape.txt', 'a/../../up.txt', '..', 'notes.txt'],
    });
    expect(answer).toMatchObject({
      resolved: { fileScope: { excludedPaths: ['notes.txt'] } },
    });
    expect(await fileScopeGet()).toEqual(answer);
  });

  it('drops absolute and drive paths from a saved scope', async () => {
    const answer = await fileScopeUpdate({
      excludedPaths: ['/etc/hosts', 'C:\\Windows\\win.ini', 'D:/x', 'ok.txt'],
    });
    expect(answer).toMatchObject({
      resolved: { fileScope: { excludedPaths: ['ok.txt'] } },
    });
    expect(await fileScopeGet()).toEqual(answer);
  });

  it('refuses a forged Cowork allowlist path and writes nothing', async () => {
    const cowork = {
      projectId: COWORK_PROJECT_ID,
      worktreeId: COWORK_WORKTREE_ID,
    };
    // A current untracked candidate is accepted into the allowlist.
    expect(
      await fileScopeUpdate({
        ...cowork,
        legacyAllowlist: true,
        includedPaths: ['notes.txt'],
      }),
    ).toMatchObject({
      resolved: {
        fileScope: { legacyAllowlist: true, includedPaths: ['notes.txt'] },
      },
    });
    rmSync(scopeFile(COWORK_PROJECT_ID, COWORK_WORKTREE_ID));
    // A path that is neither a candidate nor already approved is forged.
    expect(
      await fileScopeUpdate({
        ...cowork,
        legacyAllowlist: true,
        includedPaths: ['notes.txt', 'secret/forged.txt'],
      }),
    ).toMatchObject({ rejected: { kind: 'invalid_argument' } });
    expect(existsSync(scopeFile(COWORK_PROJECT_ID, COWORK_WORKTREE_ID))).toBe(
      false,
    );
  });

  it('never lets a save its caller abandoned overwrite a newer one', async () => {
    const cowork = {
      projectId: COWORK_PROJECT_ID,
      worktreeId: COWORK_WORKTREE_ID,
    };
    const stale = {
      ...cowork,
      legacyAllowlist: true,
      includedPaths: ['notes.txt'],
    };
    let release: () => void = () => undefined;
    mockCandidates.gate = new Promise((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      mockCandidates.entered = resolve;
    });
    try {
      const controller = new AbortController();
      const abandoned = settle(
        must().instruction('core.publication.fileScope.update', stale, {
          caller: caller(WRITES),
          metadata: { idempotencyKey: 'golden-abandoned-key' },
          signal: controller.signal,
        }),
      );
      // The stale save is listing candidates, before the write lock.
      await entered;
      controller.abort();
      expect(await abandoned).toMatchObject({
        rejected: { kind: 'cancelled', retry: 'never' },
      });
      const newer = await fileScopeUpdate({
        ...cowork,
        excludedPaths: ['notes.txt'],
      });
      expect(newer).toMatchObject({
        resolved: { fileScope: { excludedPaths: ['notes.txt'] } },
      });
      // Join the stale save's pending outcome under its key, then let it run.
      const joined = fileScopeUpdate(stale, { key: 'golden-abandoned-key' });
      release();
      expect(await joined).toMatchObject({ rejected: {} });
    } finally {
      release();
      delete mockCandidates.gate;
      delete mockCandidates.entered;
    }
    const kept = await fileScopeGet(COWORK_PROJECT_ID, COWORK_WORKTREE_ID);
    expect(kept).toMatchObject({
      resolved: {
        fileScope: { includedPaths: [], excludedPaths: ['notes.txt'] },
      },
    });
    expect(kept).not.toHaveProperty('resolved.fileScope.legacyAllowlist');
  });

  it('runs an abandoned save again under its key even when its candidate listing failed', async () => {
    const save = {
      projectId: COWORK_PROJECT_ID,
      worktreeId: COWORK_WORKTREE_ID,
      legacyAllowlist: true,
      includedPaths: ['notes.txt'],
    };
    let release: () => void = () => undefined;
    mockCandidates.gate = new Promise((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      mockCandidates.entered = resolve;
    });
    mockCandidates.failed = true;
    try {
      const controller = new AbortController();
      const abandoned = settle(
        must().instruction('core.publication.fileScope.update', save, {
          caller: caller(WRITES),
          metadata: { idempotencyKey: 'golden-retried-key' },
          signal: controller.signal,
        }),
      );
      await entered;
      controller.abort();
      expect(await abandoned).toMatchObject({
        rejected: { kind: 'cancelled', retry: 'never' },
      });
      // Join the pending attempt, then let it see no candidates.
      const joined = fileScopeUpdate(save, { key: 'golden-retried-key' });
      release();
      expect(await joined).toMatchObject({
        rejected: { kind: 'cancelled', retry: 'same_idempotency_key' },
      });
    } finally {
      release();
      delete mockCandidates.gate;
      delete mockCandidates.entered;
      delete mockCandidates.failed;
    }
    // Nothing was written, so the same key runs again once git answers.
    expect(
      await fileScopeUpdate(save, { key: 'golden-retried-key' }),
    ).toMatchObject({
      resolved: {
        fileScope: { legacyAllowlist: true, includedPaths: ['notes.txt'] },
      },
    });
  });

  it('answers an abandoned bad save as abandoned, and its retry as the real refusal', async () => {
    const forged = {
      projectId: COWORK_PROJECT_ID,
      worktreeId: COWORK_WORKTREE_ID,
      legacyAllowlist: true,
      includedPaths: ['secret/forged.txt'],
    };
    let release: () => void = () => undefined;
    mockCandidates.gate = new Promise((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      mockCandidates.entered = resolve;
    });
    try {
      const controller = new AbortController();
      const abandoned = settle(
        must().instruction('core.publication.fileScope.update', forged, {
          caller: caller(WRITES),
          metadata: { idempotencyKey: 'golden-forged-key' },
          signal: controller.signal,
        }),
      );
      await entered;
      controller.abort();
      expect(await abandoned).toMatchObject({
        rejected: { kind: 'cancelled', retry: 'never' },
      });
      const joined = fileScopeUpdate(forged, { key: 'golden-forged-key' });
      release();
      expect(await joined).toMatchObject({
        rejected: { kind: 'cancelled', retry: 'same_idempotency_key' },
      });
    } finally {
      release();
      delete mockCandidates.gate;
      delete mockCandidates.entered;
    }
    expect(
      await fileScopeUpdate(forged, { key: 'golden-forged-key' }),
    ).toMatchObject({
      rejected: {
        kind: 'invalid_argument',
        message: 'includedPaths must be current untracked files',
      },
    });
    expect(existsSync(scopeFile(COWORK_PROJECT_ID, COWORK_WORKTREE_ID))).toBe(
      false,
    );
  });

  it('replays a save abandoned after its write committed instead of writing again', async () => {
    const save = {
      excludedPaths: ['notes.txt'],
      preferredLayout: 'pin-current' as const,
    };
    const controller = new AbortController();
    // The scope write has committed; the caller abandons it as the pin fails.
    const layouts = jest
      .spyOn(await panelLayouts(), 'loadWorktreeLayout')
      .mockImplementationOnce(() => {
        controller.abort();
        throw new Error('The layout pin failed.');
      });
    try {
      expect(
        await settle(
          must().instruction(
            'core.publication.fileScope.update',
            {
              projectId: PROJECT_ID,
              worktreeId: WORKTREE_ID,
              includedPaths: [],
              ...save,
            },
            {
              caller: caller(WRITES),
              metadata: { idempotencyKey: 'golden-committed-key' },
              signal: controller.signal,
            },
          ),
        ),
      ).toMatchObject({ rejected: { kind: 'cancelled' } });
    } finally {
      layouts.mockRestore();
    }
    expect(existsSync(scopeFile(PROJECT_ID, WORKTREE_ID))).toBe(true);
    rmSync(scopeFile(PROJECT_ID, WORKTREE_ID));
    // The committed attempt stays cached: its key replays and writes nothing.
    expect(
      await fileScopeUpdate(save, { key: 'golden-committed-key' }),
    ).toMatchObject({ rejected: { kind: 'internal' } });
    expect(existsSync(scopeFile(PROJECT_ID, WORKTREE_ID))).toBe(false);
  });

  it.each([
    ['written into place', { excludedPaths: ['notes.txt'] }],
    ['removed as the default', {}],
  ])(
    'never commits a save abandoned during its atomic write, scope %s',
    async (_label, save) => {
      const file = scopeFile(PROJECT_ID, WORKTREE_ID);
      mkdirSync(dirname(file), { recursive: true });
      // Unparseable, so the save logs it once its lock-entry check has passed.
      writeFileSync(file, '{malformed');
      const controller = new AbortController();
      mockWarn.message =
        '[shared-containers] replaced a malformed share file scope';
      mockWarn.before = (): void => controller.abort();
      const scheduler = (
        await import('../shared-containers/publish/scheduler')
      ).getSharedContainerPublishScheduler();
      const published = jest.spyOn(scheduler, 'scheduleKnown');
      const { SharedContainerScopeWriteAbandonedError } = jest.requireActual<
        typeof FileScopeStore
      >('../shared-containers/file-scope-store');
      const key = `golden-mid-write-key-${++keyCounter}`;
      try {
        expect(
          await settle(
            must().instruction(
              'core.publication.fileScope.update',
              {
                projectId: PROJECT_ID,
                worktreeId: WORKTREE_ID,
                includedPaths: [],
                ...save,
              },
              {
                caller: caller(WRITES),
                metadata: { idempotencyKey: key },
                signal: controller.signal,
              },
            ),
          ),
        ).toMatchObject({ rejected: { kind: 'cancelled', retry: 'never' } });
        await expect(mockSave.last).rejects.toBeInstanceOf(
          SharedContainerScopeWriteAbandonedError,
        );
        expect(readFileSync(file, 'utf8')).toBe('{malformed');
        expect(
          readdirSync(dirname(file)).filter((name) => name.endsWith('.tmp')),
        ).toEqual([]);
        expect(published).not.toHaveBeenCalled();
      } finally {
        delete mockWarn.message;
        delete mockWarn.before;
        published.mockRestore();
      }
      // Forgotten, so the same key runs fresh and replaces the file.
      const retried = await fileScopeUpdate(save, { key });
      expect(retried).toMatchObject({ resolved: { fileScope: {} } });
      expect(existsSync(file)).toBe('excludedPaths' in save);
      expect(await fileScopeGet()).toEqual(retried);
    },
  );

  it('answers a save past its deadline as deadline_exceeded, and runs it again under its key', async () => {
    const save = {
      projectId: COWORK_PROJECT_ID,
      worktreeId: COWORK_WORKTREE_ID,
      legacyAllowlist: true,
      includedPaths: ['notes.txt'],
    };
    let release: () => void = () => undefined;
    mockCandidates.gate = new Promise((resolve) => {
      release = resolve;
    });
    try {
      // The clock is fixed, so the deadline passes on a real 25 ms timer.
      expect(
        await settle(
          must().instruction('core.publication.fileScope.update', save, {
            caller: caller(WRITES),
            metadata: {
              idempotencyKey: 'golden-deadline-key',
              deadlineAt: new Date(Date.now() + 25).toISOString(),
            },
          }),
        ),
      ).toMatchObject({ rejected: { kind: 'deadline_exceeded' } });
      const joined = fileScopeUpdate(save, { key: 'golden-deadline-key' });
      release();
      expect(await joined).toMatchObject({
        rejected: { kind: 'cancelled', retry: 'same_idempotency_key' },
      });
    } finally {
      release();
      delete mockCandidates.gate;
    }
    expect(existsSync(scopeFile(COWORK_PROJECT_ID, COWORK_WORKTREE_ID))).toBe(
      false,
    );
    expect(
      await fileScopeUpdate(save, { key: 'golden-deadline-key' }),
    ).toMatchObject({
      resolved: { fileScope: { includedPaths: ['notes.txt'] } },
    });
  });

  it('drops a stored note or prompt id over 255 characters, so an unchanged scope saves', async () => {
    const long = 'n'.repeat(256);
    const kept = 'n'.repeat(255);
    mkdirSync(dirname(scopeFile(PROJECT_ID, WORKTREE_ID)), { recursive: true });
    writeFileSync(
      scopeFile(PROJECT_ID, WORKTREE_ID),
      JSON.stringify({
        version: 1,
        includedPaths: [],
        excludedNoteIds: [kept, long],
        excludedPromptIds: [long],
      }),
    );
    const read = await fileScopeGet();
    expect(read).toMatchObject({
      resolved: { fileScope: { excludedNoteIds: [kept] } },
    });
    // An empty excluded list is answered as absent.
    expect(read).not.toHaveProperty('resolved.fileScope.excludedPromptIds');
    // The share flow saves back what it read.
    const { fileScope } = (read as { resolved: { fileScope: Json } }).resolved;
    expect(await fileScopeUpdate(fileScope)).toMatchObject({
      resolved: { fileScope: { excludedNoteIds: [kept] } },
    });
  });

  it('answers each of two overlapping saves with its own scope, also on replay', async () => {
    const first = { excludedPaths: ['notes.txt'] };
    const second = { excludedPaths: ['README.md'] };
    let later: Promise<unknown> = Promise.resolve();
    // A readback outside the write lock would wait here for the later save.
    mockScopeRead.before = async (): Promise<void> => {
      await later;
    };
    let answers: unknown[];
    try {
      const earlier = fileScopeUpdate(first, { key: 'golden-earlier-key' });
      later = fileScopeUpdate(second, { key: 'golden-later-key' });
      answers = await Promise.all([earlier, later]);
    } finally {
      delete mockScopeRead.before;
    }
    expect(answers).toMatchObject([
      { resolved: { fileScope: first } },
      { resolved: { fileScope: second } },
    ]);
    expect(
      await fileScopeUpdate(first, { key: 'golden-earlier-key' }),
    ).toMatchObject({ resolved: { fileScope: first } });
    // The later save is the stored scope, answered exactly as fileScope.get
    // reads it.
    expect(await fileScopeGet()).toEqual(answers[1]);
  });

  it('answers a pinning save and a clearing save behind it each with its own scope, and leaves the layout cleared', async () => {
    const pin = {
      excludedPaths: ['notes.txt'],
      preferredLayout: 'pin-current' as const,
    };
    const clear = {
      excludedPaths: ['README.md'],
      preferredLayout: 'clear' as const,
    };
    const layouts = jest
      .spyOn(await panelLayouts(), 'loadWorktreeLayout')
      .mockReturnValue(PANEL_LAYOUT);
    let answers: unknown[];
    try {
      // The clearing save waits on the lock while the pinning save writes.
      answers = await Promise.all([
        fileScopeUpdate(pin, { key: 'golden-pin-key' }),
        fileScopeUpdate(clear, { key: 'golden-clear-key' }),
      ]);
    } finally {
      layouts.mockRestore();
    }
    expect(answers).toMatchObject([
      {
        resolved: {
          fileScope: {
            excludedPaths: ['notes.txt'],
            preferredLayout: { enabled: true, pinnedAt: FIXED_TIME },
          },
        },
      },
      {
        resolved: {
          fileScope: {
            excludedPaths: ['README.md'],
            preferredLayout: { enabled: false },
          },
        },
      },
    ]);
    expect(await fileScopeUpdate(pin, { key: 'golden-pin-key' })).toEqual(
      answers[0],
    );
    expect(await fileScopeUpdate(clear, { key: 'golden-clear-key' })).toEqual(
      answers[1],
    );
    // The pin cannot land after the clear that followed it.
    expect(await fileScopeGet()).toEqual(answers[1]);
  });

  it('replays a scope save under its key and refuses other params as a conflict', async () => {
    const key = 'golden-replay-key';
    const first = await fileScopeUpdate(
      { excludedPaths: ['notes.txt'] },
      { key },
    );
    expect(first).toMatchObject({
      resolved: { fileScope: { excludedPaths: ['notes.txt'] } },
    });
    rmSync(scopeFile(PROJECT_ID, WORKTREE_ID));
    // The replay answers the first outcome without writing again.
    expect(
      await fileScopeUpdate({ excludedPaths: ['notes.txt'] }, { key }),
    ).toEqual(first);
    expect(existsSync(scopeFile(PROJECT_ID, WORKTREE_ID))).toBe(false);
    expect(
      await fileScopeUpdate({ excludedPaths: ['README.md'] }, { key }),
    ).toMatchObject({ rejected: { kind: 'conflict' } });
    expect(existsSync(scopeFile(PROJECT_ID, WORKTREE_ID))).toBe(false);
  });

  it('keeps at most 16 keyed scope saves, so an evicted key runs again', async () => {
    const first = { excludedPaths: ['notes.txt'] };
    await fileScopeUpdate(first, { key: 'golden-evicted-key' });
    for (let index = 0; index < 16; index += 1)
      await fileScopeUpdate(first, { key: `golden-filler-key-${index}` });
    rmSync(scopeFile(PROJECT_ID, WORKTREE_ID));
    // The 17th distinct key evicted the oldest, so its replay writes again.
    expect(
      await fileScopeUpdate(first, { key: 'golden-evicted-key' }),
    ).toMatchObject({ resolved: { fileScope: first } });
    expect(existsSync(scopeFile(PROJECT_ID, WORKTREE_ID))).toBe(true);
  });

  it('answers git paths longer than a saved scope path, which a save still drops', async () => {
    const answer = await previewGet();
    expect(answer).toMatchObject({ resolved: {} });
    const long = `${'deep/'.repeat(220)}withheld.txt`;
    expect(long.length).toBeGreaterThan(1_024);
    // The desktop dispatcher validates preview.get's answer against this schema.
    const { DESKTOP_QUERY_DEFINITIONS } =
      await import('../canopy-runtime/desktop-query-definitions');
    const { result } =
      DESKTOP_QUERY_DEFINITIONS['core.publication.preview.get'];
    expect(
      result.safeParse({
        ...(answer as { resolved: Json }).resolved,
        untrackedCandidates: [long],
        defaultIncludedFilePaths: [long],
        withheldFilePaths: [long],
        withheldSymlinkPaths: [long],
      }).success,
    ).toBe(true);
    expect(
      await fileScopeUpdate({ excludedPaths: [long, 'notes.txt'] }),
    ).toMatchObject({
      resolved: { fileScope: { excludedPaths: ['notes.txt'] } },
    });
  });

  it('previews with one GitHub commit probe as its only network call', async () => {
    const answer = await previewGet();
    expect(answer).toMatchObject({
      resolved: {
        containerType: 'CODE_WORKTREE',
        repository: {
          remoteUrl: 'https://github.com/example/golden.git',
          // origin/main is HEAD, so the pushed base is HEAD.
          baseCommitSha: headSha,
        },
        untrackedCandidates: ['notes.txt'],
      },
    });
    expect(mockGitHub.probes).toEqual([
      `GET /repos/{owner}/{repo}/commits/{ref} example/golden@${headSha}`,
    ]);
  });

  it('falls back to the local remote-tracking ref when the probe fails', async () => {
    const verified = await previewGet();
    mockGitHub.probes.length = 0;
    mockGitHub.failWith = 503;
    expect(await previewGet()).toEqual(verified);
    expect(mockGitHub.probes).toHaveLength(1);
  });

  it('refuses a preview whose container type does not match the workspace', async () => {
    const mismatch = {
      rejected: {
        kind: 'invalid_argument',
        message: 'containerType does not match project type',
        retry: 'never',
      },
    };
    expect({
      codeAsCowork: await previewGet(READS, {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        containerType: 'COWORK_WORK_ENTRY',
      }),
      coworkAsCode: await previewGet(READS, {
        projectId: COWORK_PROJECT_ID,
        worktreeId: COWORK_WORKTREE_ID,
        containerType: 'CODE_WORKTREE',
      }),
    }).toEqual({ codeAsCowork: mismatch, coworkAsCode: mismatch });
    expect(mockGitHub.probes).toEqual([]);
  });

  it('asks GitHub about the next candidate when one is not found', async () => {
    const repoPath = dataPath(
      'workspaces',
      PROJECT_ID,
      'worktrees',
      WORKTREE_ID,
    );
    // A second local candidate: origin/HEAD, at the same commit as origin/main.
    git(repoPath, 'update-ref', 'refs/remotes/origin/HEAD', 'HEAD');
    try {
      mockGitHub.notFound = 1;
      expect(await previewGet()).toMatchObject({
        resolved: { repository: { baseCommitSha: headSha } },
      });
      const probe = `GET /repos/{owner}/{repo}/commits/{ref} example/golden@${headSha}`;
      expect(mockGitHub.probes).toEqual([probe, probe]);
    } finally {
      git(repoPath, 'update-ref', '-d', 'refs/remotes/origin/HEAD');
    }
  });

  it('keeps preview.get out of the read-only relay list', async () => {
    const { relayAllows } =
      await import('../canopy-runtime/renderer-relay/surface-allowlist');
    expect({
      fileScopeGetReadOnly: relayAllows(
        'main',
        'query',
        'core.publication.fileScope.get',
        'read-only',
      ),
      previewGetReadOnly: relayAllows(
        'main',
        'query',
        'core.publication.preview.get',
        'read-only',
      ),
      previewGetAuthority: relayAllows(
        'main',
        'query',
        'core.publication.preview.get',
      ),
      fileScopeUpdateAuthority: relayAllows(
        'main',
        'instruction',
        'core.publication.fileScope.update',
      ),
      // App Advisor stays narrowed.
      previewGetAppAdvisor: relayAllows(
        'app-advisor',
        'query',
        'core.publication.preview.get',
      ),
    }).toEqual({
      fileScopeGetReadOnly: true,
      previewGetReadOnly: false,
      previewGetAuthority: true,
      fileScopeUpdateAuthority: true,
      previewGetAppAdvisor: false,
    });
  });
});
