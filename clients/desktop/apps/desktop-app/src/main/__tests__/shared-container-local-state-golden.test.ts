// CAN-6501 golden: the local-state shared-container IPC as desktop serves it
// before core.publication / core.sharedContainer take ownership. Real
// save-file-scope, preview, read-fork-provenance, list-accepted and run-status
// handlers with their file-scope, capability-package cache, fork-provenance,
// acceptance, replica, run-environment and run-copy stores, on a data root the
// golden owns, with a real git worktree under a git config the golden owns.
// Replaced: IPC registration, the shared-containers flag value, observability
// diagnostics, the cloud base URL and HTTP (an in-test hosted service that must
// see no request, though a signed-in account could reach it).
// Electron's safeStorage is the repo's pass-through Jest mock, so the run
// environment is checked for IPC redaction, not native encryption at rest.
// Only the clock is faked. Each case resets the stores and caches and seeds
// what it reads, so any case runs alone. Re-record deliberately with
// `pnpm test <this file> -u` and review the diff.
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type * as CloudConfig from '../canopy-cloud/config';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import {
  cloud,
  fakeCloud,
  FIXED_TIME,
  handlers,
  invoke as invokeChannel,
  isRecord,
  ownDataRoot,
  recordPushes,
  saveAccount,
  stable,
  type Json,
  type OwnedDataRoot,
} from './helpers/shared-containers-golden-harness';

jest.setTimeout(30_000);

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown,
  ): void => {
    handlers.set(channel, handler);
  },
}));
jest.mock('../canopy-cloud/config', () => ({
  ...jest.requireActual<typeof CloudConfig>('../canopy-cloud/config'),
  getCanopyCloudBaseUrl: (): string => 'https://cloud.example.test',
}));
const flags = { sharedContainers: true };
const diagnostics: Json[] = [];
jest.mock('../observability', () => ({
  getObservabilityService: (): Json => ({
    getRetentionDays: (): number => 30,
    recordSessionDiagnostic: (diagnostic: Json): void => {
      diagnostics.push(diagnostic);
    },
  }),
}));

const PROJECT_ID = 'sc-golden';
const WORKTREE_ID = 'golden-wt';
const OTHER_WORKTREE_ID = 'other-wt';
// Hosted ids are UUIDs.
const CONTAINER_ID = '00000000-0000-4000-8000-00000000c001';
const OTHER_CONTAINER_ID = '00000000-0000-4000-8000-00000000c002';
const UNKNOWN_CONTAINER_ID = '00000000-0000-4000-8000-00000000c003';
const REVISION_ID = '00000000-0000-4000-8000-00000000e001';
const STALE_REVISION_ID = '00000000-0000-4000-8000-00000000e002';
// Hosted revision ids are globally unique, so each container has its own.
const OTHER_REVISION_ID = '00000000-0000-4000-8000-00000000e003';
const ORG_ID = '00000000-0000-4000-8000-00000000a001';
const PUBLISHER_ID = '00000000-0000-4000-8000-00000000b001';
// Obviously fake values: run-status must never answer with them.
const FAKE_RUN_SECRET = 'fake-run-env-value-must-not-leak';
const FAKE_OTHER_RUN_SECRET = 'fake-other-run-env-value-must-not-leak';
// A file in a run copy committed for an older revision.
const RUN_COPY_FILE = '{"name":"golden","scripts":{"dev":"vite"}}\n';
const target = {
  projectId: PROJECT_ID,
  worktreeId: WORKTREE_ID,
  containerType: 'CODE_WORKTREE',
  organizationId: ORG_ID,
};
const SCOPE_REQUEST = {
  // A worktree is opt-out: a forged allowlist is dropped, not stored.
  includedPaths: ['notes.txt'],
  // Exclusion applies to untracked candidates; the preview leaves it out.
  excludedPaths: ['draft.txt'],
  excludedNoteIds: ['note-1'],
  runSharingDisabled: true,
  preferredLayout: 'clear',
};

let owned: OwnedDataRoot;
let worktreePath: string;
let fetchSpy: jest.SpyInstance;
let pushes: ReturnType<typeof recordPushes>;
let dispatcher: DesktopCanopyDispatcher | undefined;
// The caller the IPC handlers resolve: the main window's renderer.
const RENDERER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'desktop-local',
  interfaceKind: 'desktop',
  grants: [],
};

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> =>
  stable(await invokeChannel(channel, ...args), owned.root);
const readJson = (path: string): unknown =>
  stable(JSON.parse(readFileSync(path, 'utf8')), owned.root);
const dataPath = (...segments: string[]): string =>
  join(owned.dataDir, ...segments);
const worktreeDataPath = (worktreeId: string, file: string): string =>
  dataPath('workspaces', PROJECT_ID, 'worktree-data', worktreeId, file);
const saveScope = (request: Json): Promise<unknown> =>
  invoke(IPC_CHANNELS.sharedContainersSaveFileScope, {
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    includedPaths: [],
    ...request,
  });
const at = (): Date => new Date(FIXED_TIME);
const git = (...args: string[]): void => {
  execFileSync(
    'git',
    ['-c', 'user.name=Golden', '-c', 'user.email=golden@example.test']
      .concat(['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'])
      .concat(args),
    {
      cwd: worktreePath,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: FIXED_TIME,
        GIT_COMMITTER_DATE: FIXED_TIME,
      },
      stdio: 'ignore',
    },
  );
};

/** Promoted replicas, as materialization leaves them, with their run records. */
function writeReplicas(
  replicas: Record<string, { revisionId: string; run?: Json }>,
): void {
  const root = dataPath('shared-containers');
  const containers: Json = {};
  for (const [containerId, { revisionId, run }] of Object.entries(replicas)) {
    const artifacts = join(root, containerId, 'revisions', revisionId);
    mkdirSync(join(artifacts, 'artifacts'), { recursive: true });
    writeFileSync(
      join(artifacts, 'artifacts', 'container.json'),
      JSON.stringify({
        schemaVersion: 1,
        containerType: 'CODE_WORKTREE',
        title: 'Golden container',
        repositories: [
          {
            repoId: 'app',
            repoName: 'app',
            remoteUrl: 'https://github.com/example/golden.git',
            owner: 'example',
            repository: 'golden',
            baseCommitSha: 'a'.repeat(40),
            files: [],
          },
        ],
        files: [],
        notes: [],
        prompts: [],
        attachmentPaths: {},
        ...(run ? { run } : {}),
      }),
    );
    containers[containerId] = {
      containerId,
      organizationId: ORG_ID,
      access: 'organization',
      containerType: 'CODE_WORKTREE',
      updatedAt: FIXED_TIME,
      status: 'available',
      revisionId,
      revision: 1,
      revisionCreatedAt: FIXED_TIME,
    };
  }
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      version: 1,
      containers,
      artifacts: {},
      promotionCommits: {},
    }),
  );
}

beforeAll(async () => {
  // The golden owns its data roots before any code under test loads.
  owned = ownDataRoot('shared-container-local-state-golden-');
  const workspaceDir = join(owned.dataDir, 'workspaces', PROJECT_ID);
  worktreePath = join(workspaceDir, 'worktrees', WORKTREE_ID);
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(
    join(workspaceDir, 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'single-repo',
      repoPath: worktreePath,
      repos: [],
    }),
  );
  git('init', '-q', `--template=${owned.gitTemplateDir}`);
  git('remote', 'add', 'origin', 'https://github.com/example/golden.git');
  writeFileSync(join(worktreePath, 'README.md'), '# Golden\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'Initial commit');
  // Pushed as far as the local remote-tracking ref knows; nothing is fetched.
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(join(worktreePath, 'README.md'), '# Golden, edited\n');
  writeFileSync(join(worktreePath, 'notes.txt'), 'untracked\n');
  writeFileSync(join(worktreePath, 'draft.txt'), 'untracked, excluded\n');

  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(fakeCloud);
  // Signed in with shared containers, so a hosted call would reach fetch and
  // the empty request log below would catch it.
  cloud.capabilities = ['shared-containers-v1'];
  await saveAccount(['shared-containers-v1']);
  pushes = recordPushes();
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
  const registry = await import('../lib/workspace-registry');
  registry.registerWorkspaceTypes(new Map([[PROJECT_ID, 'single-repo']]));
  const { createDesktopRuntime } =
    await import('../canopy-runtime/desktop-runtime');
  dispatcher = createDesktopRuntime({ shutdownTimeoutMs: 25 });
  const { registerSharedContainerHandlers } =
    await import('../ipc/shared-containers');
  registerSharedContainerHandlers({
    dispatcher,
    resolveCaller: () => RENDERER,
  });
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

// None of these channels reaches the hosted service, and nothing lands
// outside the owned root.
afterEach(() => {
  expect(cloud.requests).toEqual([]);
  expect(owned.outsideWrites).toEqual([]);
});

// Every case starts from empty stores and a cold package cache.
beforeEach(async () => {
  for (const path of [
    'shared-container-acceptance.json',
    'shared-container-run-env.json',
    'shared-containers',
    join('workspaces', PROJECT_ID, 'worktree-data'),
  ]) {
    rmSync(dataPath(path), { recursive: true, force: true });
  }
  const { getSharedContainerCapabilityPackageAnalysisCache } =
    await import('../shared-containers/capability-package/analysis-cache');
  getSharedContainerCapabilityPackageAnalysisCache().clear();
  const { getSharedContainerRunRootDir } = await import('../lib/paths');
  for (const containerId of [CONTAINER_ID, OTHER_CONTAINER_ID]) {
    rmSync(getSharedContainerRunRootDir(containerId), {
      recursive: true,
      force: true,
    });
  }
  owned.insideWrites.length = 0;
  pushes.clear();
});

describe('shared-container local state (CAN-6501 golden)', () => {
  it('refuses every local-state channel while shared containers are disabled', async () => {
    flags.sharedContainers = false;
    const refusals = {
      preview: await invoke(IPC_CHANNELS.sharedContainersPreview, target),
      saveFileScope: await invoke(IPC_CHANNELS.sharedContainersSaveFileScope, {
        ...target,
        includedPaths: [],
      }),
      readForkProvenance: await invoke(
        IPC_CHANNELS.sharedContainersReadForkProvenance,
        target,
      ),
      listAccepted: await invoke(IPC_CHANNELS.sharedContainersListAccepted),
      runStatus: await invoke(IPC_CHANNELS.sharedContainersRunStatus, {
        containerId: CONTAINER_ID,
        revisionId: REVISION_ID,
      }),
    };
    flags.sharedContainers = true;
    expect(refusals).toMatchSnapshot();
  });

  it('validates and persists save-file-scope, idempotently', async () => {
    const save = saveScope;
    const refusals = {
      invalidProject: await save({ projectId: '../escape' }),
      missingIncludedPaths: await save({ includedPaths: undefined }),
      invalidExcludedPaths: await save({ excludedPaths: 'README.md' }),
      invalidLegacyAllowlist: await save({ legacyAllowlist: 'yes' }),
      invalidNotes: await save({ includedNoteIds: 'note-1' }),
      invalidRunSharing: await save({ runSharingEnabled: 'true' }),
      invalidPreferredLayout: await save({ preferredLayout: 'pin' }),
      tooManyIncludedPaths: await save({
        includedPaths: Array.from({ length: 201 }, (_, i) => `f${i}`),
      }),
    };
    const saved = await save(SCOPE_REQUEST);
    const scopePath = worktreeDataPath(WORKTREE_ID, 'share-file-scope.json');
    expect(owned.insideWrites).toContain(scopePath);
    const file = readJson(scopePath);
    const repeated = await save(SCOPE_REQUEST);
    expect(repeated).toEqual(saved);
    expect(readJson(scopePath)).toEqual(file);
    expect({
      refusals,
      saved,
      file,
      pushes: pushes.list(),
    }).toMatchSnapshot();
  });

  it('answers preview from the worktree and the capability-package cache', async () => {
    const refusals = {
      invalidWorktree: await invoke(IPC_CHANNELS.sharedContainersPreview, {
        ...target,
        worktreeId: '../escape',
      }),
      unknownType: await invoke(IPC_CHANNELS.sharedContainersPreview, {
        ...target,
        containerType: 'NOT_A_CONTAINER_TYPE',
      }),
      cloudChatType: await invoke(IPC_CHANNELS.sharedContainersPreview, {
        ...target,
        containerType: 'CLOUD_CHAT',
      }),
      coworkType: await invoke(IPC_CHANNELS.sharedContainersPreview, {
        ...target,
        containerType: 'COWORK_WORK_ENTRY',
      }),
      invalidAudience: await invoke(IPC_CHANNELS.sharedContainersPreview, {
        ...target,
        audience: 'everyone',
      }),
    };
    await saveScope(SCOPE_REQUEST);
    const { getSharedContainerCapabilityPackageAnalysisCache } =
      await import('../shared-containers/capability-package/analysis-cache');
    const cacheEntry = (): unknown => {
      const entry = getSharedContainerCapabilityPackageAnalysisCache().get({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        containerType: 'CODE_WORKTREE',
      });
      return entry ? { analysis: entry.analysis.state } : null;
    };
    // A cold cache answers without package counts and refreshes behind it.
    const cacheBeforeCold = cacheEntry();
    const cold = await invoke(IPC_CHANNELS.sharedContainersPreview, target);
    const { getSharedContainerCapabilityPackagePreviewRefresher } =
      await import('../shared-containers/capability-package/preview');
    await getSharedContainerCapabilityPackagePreviewRefresher().whenIdle();
    // The refresh cached a completed (empty) analysis for the warm preview to
    // read; an empty package adds no counts line either way.
    const cacheBeforeWarm = cacheEntry();
    const warm = await invoke(IPC_CHANNELS.sharedContainersPreview, target);
    // Chat storage records its own diagnostics on first read; only the
    // preview's are pinned here.
    const previewFailures = diagnostics.filter(
      (entry) => entry.kind === 'shared_container_preview_failure',
    );
    expect({
      refusals,
      cacheBeforeCold,
      cold,
      cacheBeforeWarm,
      warm,
      previewFailures,
      pushes: pushes.list(),
    }).toMatchSnapshot();
  });

  it('reads fork provenance only from the requested worktree', async () => {
    const read = (worktreeId: string): Promise<unknown> =>
      invoke(IPC_CHANNELS.sharedContainersReadForkProvenance, {
        projectId: PROJECT_ID,
        worktreeId,
      });
    const absent = await read(WORKTREE_ID);
    const { writeForkProvenanceForDestination } =
      await import('../shared-containers/fork/provenance');
    await writeForkProvenanceForDestination(PROJECT_ID, WORKTREE_ID, {
      sourceContainerId: CONTAINER_ID,
      sourceRevisionId: REVISION_ID,
      sourceRevisionCreatedAt: FIXED_TIME,
      sourceOwnerDisplayName: 'Example Publisher',
      organizationId: ORG_ID,
      forkedAt: FIXED_TIME,
    });
    expect(owned.insideWrites).toContain(
      worktreeDataPath(WORKTREE_ID, 'shared-container-fork.json'),
    );
    const present = await read(WORKTREE_ID);
    const repeated = await read(WORKTREE_ID);
    const otherWorktree = await read(OTHER_WORKTREE_ID);
    const invalidPath = worktreeDataPath(
      OTHER_WORKTREE_ID,
      'shared-container-fork.json',
    );
    mkdirSync(join(invalidPath, '..'), { recursive: true });
    writeFileSync(
      invalidPath,
      JSON.stringify({ sourceContainerId: CONTAINER_ID }),
    );
    const invalidFile = await read(OTHER_WORKTREE_ID);
    const invalidId = await read('../escape');
    expect(repeated).toEqual(present);
    expect({
      absent,
      present,
      otherWorktree,
      invalidFile,
      invalidId,
    }).toMatchSnapshot();
  });

  it('lists accepted containers with their identity and no run consent', async () => {
    const empty = await invoke(IPC_CHANNELS.sharedContainersListAccepted);
    const acceptance = await import('../shared-containers/acceptance-store');
    await acceptance.acceptSharedContainer(
      CONTAINER_ID,
      ORG_ID,
      at,
      'organization',
    );
    await acceptance.acceptSharedContainer(
      OTHER_CONTAINER_ID,
      undefined,
      at,
      'direct',
    );
    await acceptance.allowSharedContainerRun(CONTAINER_ID, PUBLISHER_ID, at);
    const acceptancePath = dataPath('shared-container-acceptance.json');
    expect(owned.insideWrites).toContain(acceptancePath);
    const listed = await invoke(IPC_CHANNELS.sharedContainersListAccepted);
    const repeated = await invoke(IPC_CHANNELS.sharedContainersListAccepted);
    expect(repeated).toEqual(listed);
    const file = readJson(acceptancePath);
    expect({ empty, listed, file }).toMatchSnapshot();
  });

  it('answers run-status from the run record without the run environment', async () => {
    const status = (
      containerId: string,
      revisionId = REVISION_ID,
    ): Promise<unknown> =>
      invoke(IPC_CHANNELS.sharedContainersRunStatus, {
        containerId,
        revisionId,
      });
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const setPlatform = (value: string): void => {
      Object.defineProperty(process, 'platform', { value });
    };
    // Both containers declare the same names and store a different one each,
    // and run different commands, so an answer drawn from the wrong
    // container's record or values changes.
    const run = (command: string): Json => ({
      commands: [{ name: 'dev', command, repoId: 'app' }],
      requiredEnv: ['API_TOKEN', 'REGION'],
    });
    writeReplicas({
      [CONTAINER_ID]: { revisionId: REVISION_ID, run: run('pnpm dev') },
      [OTHER_CONTAINER_ID]: {
        revisionId: OTHER_REVISION_ID,
        run: run('pnpm start'),
      },
    });
    const acceptance = await import('../shared-containers/acceptance-store');
    await acceptance.acceptSharedContainer(
      CONTAINER_ID,
      ORG_ID,
      at,
      'organization',
    );
    await acceptance.allowSharedContainerRun(CONTAINER_ID, PUBLISHER_ID, at);
    await acceptance.acceptSharedContainer(
      OTHER_CONTAINER_ID,
      ORG_ID,
      at,
      'organization',
    );
    const { writeSharedContainerRunEnvironment } =
      await import('../shared-containers/run-env-store');
    await writeSharedContainerRunEnvironment(CONTAINER_ID, [
      { key: 'API_TOKEN', value: FAKE_RUN_SECRET },
      { key: 'UNDECLARED', value: FAKE_RUN_SECRET },
    ]);
    await writeSharedContainerRunEnvironment(OTHER_CONTAINER_ID, [
      { key: 'REGION', value: FAKE_OTHER_RUN_SECRET },
    ]);
    expect(owned.insideWrites).toContain(
      dataPath('shared-container-run-env.json'),
    );
    // The first container keeps a run copy committed for an older revision;
    // the other has none.
    const { getSharedContainerRunRootDir } = await import('../lib/paths');
    const runRoot = getSharedContainerRunRootDir(CONTAINER_ID);
    mkdirSync(join(runRoot, 'app'), { recursive: true });
    writeFileSync(join(runRoot, 'app', 'package.json'), RUN_COPY_FILE);
    writeFileSync(
      join(runRoot, '.canopy-run-manifest.json'),
      JSON.stringify({
        version: 1,
        state: 'committed',
        revisionId: STALE_REVISION_ID,
        repositories: { app: ['package.json'] },
      }),
    );
    // The size counts every entry of the copy, directories included, whose
    // sizes vary by filesystem: assert the exact sum here and keep only a
    // placeholder in the snapshot.
    const runCopyBytes = [
      runRoot,
      join(runRoot, 'app'),
      join(runRoot, 'app', 'package.json'),
      join(runRoot, '.canopy-run-manifest.json'),
    ].reduce(
      (total, path) => total + lstatSync(path, { bigint: true }).size,
      BigInt(0),
    );
    const measured = (answer: unknown): Json => {
      const resolved =
        isRecord(answer) && isRecord(answer.resolved) ? answer.resolved : {};
      expect(BigInt(String(resolved.runCopySizeBytes))).toBe(runCopyBytes);
      return {
        resolved: { ...resolved, runCopySizeBytes: '<the copy, every entry>' },
      };
    };
    try {
      setPlatform('linux');
      const offMac = await status(CONTAINER_ID);
      setPlatform('darwin');
      const result = {
        offMac,
        invalidId: await status('../escape'),
        invalidRevision: await status(CONTAINER_ID, '../escape'),
        notAccepted: await status(UNKNOWN_CONTAINER_ID),
        staleRevision: await status(CONTAINER_ID, STALE_REVISION_ID),
        // A container paired with the other container's revision.
        crossRevision: await status(CONTAINER_ID, OTHER_REVISION_ID),
        otherCrossRevision: await status(OTHER_CONTAINER_ID, REVISION_ID),
        allowed: await status(CONTAINER_ID),
        // Accepted without run consent, with only its own stored value.
        other: await status(OTHER_CONTAINER_ID, OTHER_REVISION_ID),
      };
      expect(await status(CONTAINER_ID)).toEqual(result.allowed);
      result.allowed = measured(result.allowed);
      // The stored plaintext stays in main; only stored-secret refs answer.
      expect(JSON.stringify(result)).not.toContain(FAKE_RUN_SECRET);
      expect(JSON.stringify(result)).not.toContain(FAKE_OTHER_RUN_SECRET);
      expect(result).toMatchSnapshot();
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});
