// CAN-6501 PR 7 golden: core.sharedContainer.acceptance.list,
// forkProvenance.get and run.get on a real desktop dispatcher, over the real
// acceptance, fork-provenance, replica, run-environment and run-copy stores on
// a data root the golden owns. It pins the gate, the grants, the typed
// refusals and that a run-environment value never crosses as plaintext.
// Replaced: the shared-containers flag value, observability diagnostics, the
// cloud base URL and HTTP (an in-test hosted service that must see no request,
// though a signed-in account could reach it), and one provenance read fault.
// Electron's safeStorage is the repo's pass-through Jest mock, so the run
// environment is checked for wire redaction, not native encryption at rest.
// Re-record deliberately with `pnpm test <this file> -u` and review the diff.
import {
  mkdirSync,
  promises as fsPromises,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { CanopyOperationError } from '@canopy/core-runtime';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  CanopyCallerDescriptor,
  CanopyGrantName,
} from '@canopy/protocol/canopy-core';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type * as CloudConfig from '../canopy-cloud/config';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import {
  cloud,
  fakeCloud,
  FIXED_TIME,
  handlers,
  invoke as invokeChannel,
  ownDataRoot,
  saveAccount,
  stable,
  type Json,
  type OwnedDataRoot,
} from './helpers/shared-containers-golden-harness';

jest.setTimeout(30_000);

// The IPC projections register here, so a case can check what the renderer
// still reads.
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
jest.mock('../observability', () => ({
  getObservabilityService: (): Json => ({
    getRetentionDays: (): number => 30,
    recordSessionDiagnostic: (): void => undefined,
  }),
}));

const PROJECT_ID = 'sc-reads-golden';
const WORKTREE_ID = 'golden-wt';
const OTHER_WORKTREE_ID = 'other-wt';
const UNKNOWN_PROJECT_ID = 'no-such-project';
const CONTAINER_ID = '00000000-0000-4000-8000-00000000c001';
const OTHER_CONTAINER_ID = '00000000-0000-4000-8000-00000000c002';
const UNKNOWN_CONTAINER_ID = '00000000-0000-4000-8000-00000000c003';
const REVISION_ID = '00000000-0000-4000-8000-00000000e001';
const STALE_REVISION_ID = '00000000-0000-4000-8000-00000000e002';
const OTHER_REVISION_ID = '00000000-0000-4000-8000-00000000e003';
const ORG_ID = '00000000-0000-4000-8000-00000000a001';
const PUBLISHER_ID = '00000000-0000-4000-8000-00000000b001';
// Obviously fake values: run.get must never answer with them.
const FAKE_RUN_SECRET = 'fake-run-env-value-must-not-leak';
const FAKE_OTHER_RUN_SECRET = 'fake-other-run-env-value-must-not-leak';

const PUBLICATION_READ: CanopyGrantName = 'core.publication.read';
const WORKSPACE_READ: CanopyGrantName = 'core.workspace.read';
const ALL_READS = [PUBLICATION_READ, WORKSPACE_READ];

let owned: OwnedDataRoot;
let fetchSpy: jest.SpyInstance;
let dispatcher: DesktopCanopyDispatcher | undefined;
const caller = (grants: CanopyGrantName[]): CanopyCallerDescriptor => ({
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'desktop-local',
  interfaceKind: 'desktop',
  grants,
});
const dataPath = (...segments: string[]): string =>
  join(owned.dataDir, ...segments);
const at = (): Date => new Date(FIXED_TIME);

const must = (): DesktopCanopyDispatcher => {
  if (!dispatcher) throw new Error('The dispatcher did not start');
  return dispatcher;
};

/** One query's answer: its result, or the error payload a client sees. */
async function settle(answer: Promise<unknown>): Promise<unknown> {
  try {
    return { resolved: stable(await answer, owned.root) };
  } catch (error) {
    if (!(error instanceof CanopyOperationError)) throw error;
    // The raw payload a client receives, details included, before any masking.
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

const acceptanceList = (grants = ALL_READS): Promise<unknown> =>
  settle(
    must().query(
      'core.sharedContainer.acceptance.list',
      {},
      { caller: caller(grants) },
    ),
  );
const forkProvenance = (
  projectId: string,
  worktreeId: string,
  grants = ALL_READS,
): Promise<unknown> =>
  settle(
    must().query(
      'core.sharedContainer.forkProvenance.get',
      { projectId, worktreeId },
      { caller: caller(grants) },
    ),
  );
const runGet = (
  containerId: string,
  revisionId: string,
  grants = ALL_READS,
  signal?: AbortSignal,
): Promise<unknown> =>
  settle(
    must().query(
      'core.sharedContainer.run.get',
      { containerId, revisionId },
      { caller: caller(grants), ...(signal ? { signal } : {}) },
    ),
  );

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
  owned = ownDataRoot('shared-container-reads-core-golden-');
  mkdirSync(join(owned.dataDir, 'workspaces', PROJECT_ID), {
    recursive: true,
  });
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(fakeCloud);
  // Signed in with shared containers, so a hosted call would reach fetch and
  // the empty request log below would catch it.
  cloud.capabilities = ['shared-containers-v1'];
  await saveAccount(['shared-containers-v1']);
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
  const { createDesktopRuntime } =
    await import('../canopy-runtime/desktop-runtime');
  dispatcher = createDesktopRuntime({ shutdownTimeoutMs: 25 });
  const { registerSharedContainerHandlers } =
    await import('../ipc/shared-containers');
  registerSharedContainerHandlers({
    dispatcher,
    resolveCaller: () => caller([]),
  });
});

afterAll(async () => {
  try {
    await dispatcher?.shutdown();
  } finally {
    fetchSpy?.mockRestore();
    // Released even when a setup step threw, so the env and fs are restored.
    owned?.release();
  }
});

// None of these reads reaches the hosted service, and nothing lands outside
// the owned root.
afterEach(() => {
  expect(cloud.requests).toEqual([]);
  expect(owned.outsideWrites).toEqual([]);
});

// Every case starts from empty stores.
beforeEach(() => {
  flags.sharedContainers = true;
  for (const path of [
    'shared-container-acceptance.json',
    'shared-container-run-env.json',
    'shared-containers',
    join('workspaces', PROJECT_ID, 'worktree-data'),
  ]) {
    rmSync(dataPath(path), { recursive: true, force: true });
  }
});

describe('core.sharedContainer reads on desktop (CAN-6501 PR 7 golden)', () => {
  it('stops the run-copy walk when run.get is cancelled', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    writeReplicas({ [CONTAINER_ID]: { revisionId: REVISION_ID } });
    const acceptance = await import('../shared-containers/acceptance-store');
    await acceptance.acceptSharedContainer(
      CONTAINER_ID,
      ORG_ID,
      at,
      'organization',
    );
    const { getSharedContainerRunRootDir } = await import('../lib/paths');
    const runRoot = getSharedContainerRunRootDir(CONTAINER_ID);
    mkdirSync(join(runRoot, 'app'), { recursive: true });
    writeFileSync(join(runRoot, 'app', 'package.json'), '{}');
    try {
      // The handler under a cancelled call: the walk refuses its first entry
      // instead of measuring the copy.
      const { createCoreSharedContainerAdapter } =
        await import('../canopy-runtime/core-shared-container-adapter');
      const handler =
        createCoreSharedContainerAdapter().queries[
          'core.sharedContainer.run.get'
        ];
      const walk = handler(
        { containerId: CONTAINER_ID, revisionId: REVISION_ID },
        {
          requestId: 'golden-cancelled',
          caller: caller(ALL_READS),
          metadata: {},
          signal: AbortSignal.abort('cancel'),
        },
      );
      await expect(walk).rejects.toBe('cancel');
      // The dispatcher answers the caller's cancel as its own outcome.
      expect(
        await runGet(
          CONTAINER_ID,
          REVISION_ID,
          ALL_READS,
          AbortSignal.abort('cancel'),
        ),
      ).toMatchSnapshot();
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });

  it('answers capability_unavailable for every read while shared containers are off', async () => {
    flags.sharedContainers = false;
    expect({
      acceptanceList: await acceptanceList(),
      forkProvenanceGet: await forkProvenance(PROJECT_ID, WORKTREE_ID),
      runGet: await runGet(CONTAINER_ID, REVISION_ID),
    }).toMatchSnapshot();
  });

  it('refuses each read without its grants', async () => {
    expect({
      acceptanceListWithoutPublicationRead: await acceptanceList([
        WORKSPACE_READ,
      ]),
      // Local worktree detail needs both grants.
      forkProvenanceWithoutPublicationRead: await forkProvenance(
        PROJECT_ID,
        WORKTREE_ID,
        [WORKSPACE_READ],
      ),
      forkProvenanceWithoutWorkspaceRead: await forkProvenance(
        PROJECT_ID,
        WORKTREE_ID,
        [PUBLICATION_READ],
      ),
      // Local run detail needs both grants.
      runGetWithoutWorkspaceRead: await runGet(CONTAINER_ID, REVISION_ID, [
        PUBLICATION_READ,
      ]),
      runGetWithoutPublicationRead: await runGet(CONTAINER_ID, REVISION_ID, [
        WORKSPACE_READ,
      ]),
    }).toMatchSnapshot();
  });

  it('lists accepted containers with their identity and no run consent', async () => {
    const empty = await acceptanceList();
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
    const listed = await acceptanceList();
    // Desktop's accept path caps no id length; a record past the contract's
    // 512-character ids is skipped, and the others still list.
    await acceptance.acceptSharedContainer(
      'c'.repeat(513),
      ORG_ID,
      at,
      'organization',
    );
    await acceptance.acceptSharedContainer(
      UNKNOWN_CONTAINER_ID,
      'o'.repeat(513),
      at,
      'organization',
    );
    expect(await acceptanceList()).toEqual(listed);
    expect(JSON.stringify(listed)).not.toContain('runAllowed');
    expect(JSON.stringify(listed)).not.toContain(PUBLISHER_ID);
    expect({ empty, listed }).toMatchSnapshot();
  });

  it('reads fork provenance only from the requested worktree', async () => {
    const absent = await forkProvenance(PROJECT_ID, WORKTREE_ID);
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
    const present = await forkProvenance(PROJECT_ID, WORKTREE_ID);
    const otherWorktree = await forkProvenance(PROJECT_ID, OTHER_WORKTREE_ID);
    // Desktop does not check that a project exists, so neither does the core.
    const unknownProject = await forkProvenance(
      UNKNOWN_PROJECT_ID,
      WORKTREE_ID,
    );
    const invalidPath = dataPath(
      'workspaces',
      PROJECT_ID,
      'worktree-data',
      OTHER_WORKTREE_ID,
      'shared-container-fork.json',
    );
    mkdirSync(join(invalidPath, '..'), { recursive: true });
    writeFileSync(
      invalidPath,
      JSON.stringify({ sourceContainerId: CONTAINER_ID }),
    );
    const invalidRecord = await forkProvenance(PROJECT_ID, OTHER_WORKTREE_ID);
    // An unreadable record: its EACCES error names the host path, which must
    // not cross (settle checks the raw payload). The fault is injected rather
    // than made with chmod, which root ignores, and the record is valid, so a
    // read that got through would answer it and fail the snapshot.
    writeFileSync(
      invalidPath,
      JSON.stringify({
        sourceContainerId: CONTAINER_ID,
        sourceRevisionId: REVISION_ID,
        sourceOwnerDisplayName: 'Example Publisher',
        forkedAt: FIXED_TIME,
      }),
    );
    const denied = Object.assign(
      new Error(`EACCES: permission denied, open '${invalidPath}'`),
      { code: 'EACCES', errno: -13, syscall: 'open', path: invalidPath },
    );
    const readFile = jest
      .spyOn(fsPromises, 'readFile')
      .mockRejectedValueOnce(denied);
    let unreadableRecord: unknown;
    try {
      unreadableRecord = await forkProvenance(PROJECT_ID, OTHER_WORKTREE_ID);
      // The fault reached the provenance read, not some other file.
      expect(readFile.mock.calls[0]?.[0]).toBe(invalidPath);
    } finally {
      readFile.mockRestore();
    }
    // A redacted internal: no host path crosses.
    expect(JSON.stringify(invalidRecord)).not.toContain(owned.root);
    expect({
      absent,
      present,
      otherWorktree,
      unknownProject,
      invalidRecord,
      unreadableRecord,
    }).toMatchSnapshot();
  });

  it('answers run.get with stored-secret references, never a run-environment value', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const setPlatform = (value: string): void => {
      Object.defineProperty(process, 'platform', { value });
    };
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
      { key: 'API_TOKEN', value: FAKE_RUN_SECRET, secret: true },
      // A value the publisher did not mark secret is still never plaintext.
      { key: 'REGION', value: FAKE_OTHER_RUN_SECRET },
      { key: 'UNDECLARED', value: FAKE_RUN_SECRET },
    ]);
    try {
      setPlatform('linux');
      const offMac = await runGet(CONTAINER_ID, REVISION_ID);
      setPlatform('darwin');
      const result = {
        offMac,
        notAccepted: await runGet(UNKNOWN_CONTAINER_ID, REVISION_ID),
        staleRevision: await runGet(CONTAINER_ID, STALE_REVISION_ID),
        crossRevision: await runGet(CONTAINER_ID, OTHER_REVISION_ID),
        allowed: await runGet(CONTAINER_ID, REVISION_ID),
        // Accepted without run consent, with no stored value.
        other: await runGet(OTHER_CONTAINER_ID, OTHER_REVISION_ID),
      };
      // The stored plaintext stays in the core; only stored-secret refs cross.
      const wire = JSON.stringify(result);
      expect(wire).not.toContain(FAKE_RUN_SECRET);
      expect(wire).not.toContain(FAKE_OTHER_RUN_SECRET);
      expect(wire).not.toContain('UNDECLARED');
      expect(result).toMatchSnapshot();
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });

  it('answers revisionUnavailable when the revision is pruned mid-read', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const acceptance = await import('../shared-containers/acceptance-store');
    const { SharedContainerReplicaStore } =
      await import('../shared-containers/replica/store');
    const run: Json = {
      commands: [{ name: 'dev', command: 'pnpm dev', repoId: 'app' }],
      requiredEnv: [],
    };
    const pruned = dataPath(
      'shared-containers',
      CONTAINER_ID,
      'revisions',
      REVISION_ID,
    );
    // Runs `change` after the reader's index check and before its root and
    // layout reads, as a reconciliation or purge landing in between would.
    const between = (change: () => void): void => {
      const spy = jest
        .spyOn(
          SharedContainerReplicaStore.prototype,
          'resolveRevisionRootForRead',
        )
        .mockImplementationOnce(async function (
          this: InstanceType<typeof SharedContainerReplicaStore>,
          containerId: string,
          revisionId: string,
        ) {
          change();
          spy.mockRestore();
          return this.resolveRevisionRootForRead(containerId, revisionId);
        });
    };
    try {
      writeReplicas({ [CONTAINER_ID]: { revisionId: REVISION_ID, run } });
      await acceptance.acceptSharedContainer(
        CONTAINER_ID,
        ORG_ID,
        at,
        'organization',
      );
      between(() => {
        // The index moves to the next revision and the old one is pruned.
        writeReplicas({
          [CONTAINER_ID]: { revisionId: OTHER_REVISION_ID, run },
        });
        rmSync(pruned, { recursive: true, force: true });
      });
      expect(await runGet(CONTAINER_ID, REVISION_ID)).toEqual({
        rejected: {
          kind: 'failed_precondition',
          code: 'core.sharedContainer.revisionUnavailable',
          message: 'Shared-container revision is not available',
          retry: 'after_refresh',
        },
      });

      // Still indexed but unreadable: not a rollover, so a redacted internal.
      writeReplicas({ [CONTAINER_ID]: { revisionId: REVISION_ID, run } });
      between(() => rmSync(pruned, { recursive: true, force: true }));
      expect(await runGet(CONTAINER_ID, REVISION_ID)).toMatchObject({
        rejected: { kind: 'internal' },
      });
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });

  it('answers run consent past the contract bounds as not given', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const run: Json = {
      commands: [{ name: 'dev', command: 'pnpm dev', repoId: 'app' }],
      requiredEnv: [],
    };
    const request = { containerId: CONTAINER_ID, revisionId: REVISION_ID };
    const acceptancePath = dataPath('shared-container-acceptance.json');
    // Desktop's consent write checks an id's characters, not its length.
    const storeConsent = (consent: Json): void => {
      const store = JSON.parse(readFileSync(acceptancePath, 'utf8')) as Json;
      const accepted = store.accepted as Record<string, Json>;
      accepted[CONTAINER_ID] = { ...accepted[CONTAINER_ID], ...consent };
      writeFileSync(acceptancePath, JSON.stringify(store));
    };
    try {
      writeReplicas({ [CONTAINER_ID]: { revisionId: REVISION_ID, run } });
      const acceptance = await import('../shared-containers/acceptance-store');
      await acceptance.acceptSharedContainer(
        CONTAINER_ID,
        ORG_ID,
        at,
        'organization',
      );
      await acceptance.allowSharedContainerRun(CONTAINER_ID, PUBLISHER_ID, at);
      const answers = async (): Promise<unknown> => ({
        core: await runGet(CONTAINER_ID, REVISION_ID),
        ipc: await invokeChannel(
          IPC_CHANNELS.sharedContainersRunStatus,
          request,
        ),
      });
      storeConsent({ runAllowedPublisherUserId: 'p'.repeat(513) });
      const longPublisher = await answers();
      storeConsent({
        runAllowedPublisherUserId: PUBLISHER_ID,
        runAllowedAt: 't'.repeat(513),
      });
      const longAllowedAt = await answers();
      // Consent that names no publisher would read as matching any publisher,
      // so the whole consent answers as not given; the run record still does.
      for (const answer of [longPublisher, longAllowedAt]) {
        expect(answer).toMatchObject({
          core: { resolved: { allowed: false, run } },
          ipc: { resolved: { allowed: false, run } },
        });
        expect(JSON.stringify(answer)).not.toMatch(/allowedAt|publisherUserId/);
      }
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });

  it('answers fork provenance past the contract bounds as none', async () => {
    const path = dataPath(
      'workspaces',
      PROJECT_ID,
      'worktree-data',
      WORKTREE_ID,
      'shared-container-fork.json',
    );
    const provenance: Json = {
      sourceContainerId: CONTAINER_ID,
      sourceRevisionId: REVISION_ID,
      sourceRevisionCreatedAt: FIXED_TIME,
      sourceOwnerDisplayName: 'Example Publisher',
      organizationId: ORG_ID,
      forkedAt: FIXED_TIME,
    };
    mkdirSync(join(path, '..'), { recursive: true });
    // Desktop's provenance check requires each field but caps none of them.
    for (const field of Object.keys(provenance)) {
      // A time must still parse: Date.parse skips a parenthesized comment.
      const long =
        field === 'sourceRevisionCreatedAt' || field === 'forkedAt'
          ? `Nov 20 2026 (${'x'.repeat(512)})`
          : 'x'.repeat(513);
      writeFileSync(path, JSON.stringify({ ...provenance, [field]: long }));
      expect({
        field,
        core: await forkProvenance(PROJECT_ID, WORKTREE_ID),
        ipc: await invokeChannel(
          IPC_CHANNELS.sharedContainersReadForkProvenance,
          {
            projectId: PROJECT_ID,
            worktreeId: WORKTREE_ID,
          },
        ),
      }).toEqual({
        field,
        core: { resolved: { provenance: null } },
        ipc: { resolved: null },
      });
    }
  });
});
