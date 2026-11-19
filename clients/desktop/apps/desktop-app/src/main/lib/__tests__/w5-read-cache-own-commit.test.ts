import type * as LegacyStorage from './fixtures/w5-legacy-storage';
// CAN-7155 (W5 readers S-9, PR 1): Electron's own commits through the
// daemon-backed store feed the read cache's projection before the store's
// decision queue releases, as of the commit id W5e publishes for them. A
// capture racing the commit never undoes it, an own conflict's log-wide
// abandonment reaches every cached file, and every settled answer equals a
// fresh capture's.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('@canopy/core-runtime/storage', () =>
  jest
    .requireActual<typeof LegacyStorage>('./fixtures/w5-legacy-storage')
    .createLegacyW5StorageMock(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: jest.fn(() => Promise.resolve()),
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../services/desktop-structure-signal', () => ({
  scheduleDesktopStructureChanged: jest.fn(),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';
import type { W5CaptureResult } from '@canopy/core-runtime/node/w5/commit-log/capture-contract';
import {
  classifyW5FileProvenance,
  classifyW5RevisionEligibility,
} from '@canopy/core-runtime/node/w5/commit-log/eligibility';
import {
  W5FileWriteRefusedError,
  type W5CommitLogFileStore,
} from '@canopy/core-runtime/node/w5/commit-log-file-store';
import {
  createW5CommittedProjection,
  type W5CommittedProjection,
} from '@canopy/core-runtime/node/w5/committed-projection';
import {
  startW5HostedMetadataHarness,
  type W5HostedMetadataHarness,
} from './fixtures/w5-hosted-metadata-harness';
import { __setDesktopW5FileStoreForTests } from '../w5-commit-log-file-store';
import {
  createW5DaemonRecordStore,
  installW5DaemonRecordStoreForTests,
  w5RecordPortTransport,
} from '../w5-daemon-record-store';
import { nodeW5FileStore } from '../w5-file-store';
import { writeWorkspaceConfig } from '../workspace-persistence';

jest.setTimeout(120_000);

const WORKER = join(__dirname, 'fixtures/w5-commit-log-source-worker.ts');
const MANIFEST = { kind: 'manifest', workspaceId: 'a' } as const;
const WORKSPACE = { kind: 'workspace', workspaceId: 'a' } as const;
const CONFIG: WorkspaceConfigFile = {
  version: 1,
  type: 'multi-repo',
  repos: [],
};

let dir: string;
let harness: W5HostedMetadataHarness;
let store: W5CommitLogFileStore;
let projection: W5CommittedProjection;
let restore: () => void;
let originalDataDir: string | undefined;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'w5-read-cache-')));
  mkdirSync(join(dir, 'workspaces', 'a'), { recursive: true });
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dir;
  harness = await startW5HostedMetadataHarness({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root: join(dir, 'workspaces'),
    workerEntry: WORKER,
    daemonOwned: ['workspace_index', 'workspace_manifest', 'worktree_list'],
  });
  projection = createW5CommittedProjection();
  store = createW5DaemonRecordStore({
    root: harness.root,
    transport: w5RecordPortTransport(
      await harness.connectRecords('electron-main'),
    ),
    projection,
  });
  restore = installW5DaemonRecordStoreForTests(store);
});

afterEach(async () => {
  await settleDetachedWork();
  restore();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await harness.close();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

async function capture(): Promise<W5CaptureResult> {
  if (!store.capture) throw new Error('The daemon-backed store captures');
  const { capture: result } = await store.capture({
    files: [{ kind: 'index' }, MANIFEST],
    discoverWorkspaces: false,
  });
  return result;
}

/** The commit id W5e published for the latest commit, and its origin. */
function lastPublished(): { commitId: number; publishedBy: unknown } {
  const last = harness.committedEvents().at(-1);
  const commit =
    typeof last === 'object' && last !== null && 'commit' in last
      ? last.commit
      : undefined;
  if (typeof commit !== 'string') throw new Error('No commit was published');
  return {
    commitId: Number(commit.replace(/^w5:/, '')),
    publishedBy:
      typeof last === 'object' && last !== null && 'publishedBy' in last
        ? last.publishedBy
        : undefined,
  };
}

function expectSameAsFresh(fresh: W5CaptureResult): void {
  expect(projection.provenance(MANIFEST)).toEqual(
    classifyW5FileProvenance(fresh, MANIFEST),
  );
  for (const completeness of ['complete', 'partial'] as const)
    expect(projection.eligibility(WORKSPACE, completeness)).toEqual(
      classifyW5RevisionEligibility(fresh, WORKSPACE, completeness),
    );
  for (const completeness of ['complete', 'partial'] as const)
    expect(
      projection.eligibility({ kind: 'workspaces' }, completeness),
    ).toEqual(
      classifyW5RevisionEligibility(
        fresh,
        { kind: 'workspaces' },
        completeness,
      ),
    );
}

describe('the read cache over Electron own commits (CAN-7155)', () => {
  test('an own commit lands as of its published commit id, then verifies to a fresh capture', async () => {
    await writeWorkspaceConfig('a', { ...CONFIG });
    const published = lastPublished();
    expect(published.publishedBy).toBe('electron-main');
    expect(projection.commitId(MANIFEST)).toBe(published.commitId);
    expect(projection.state(MANIFEST)).toBe('verifying');
    expect(projection.image(MANIFEST)).toEqual({
      ...MANIFEST,
      state: 'present',
      base64: readFileSync(join(harness.root, 'a', 'workspace.json')).toString(
        'base64',
      ),
    });
    // Its provenance waits on one capture; nothing is served from the outcome.
    expect(projection.eligibility(WORKSPACE, 'complete')).toBeUndefined();
    expect(projection.refillPlan()?.files).toEqual(
      expect.arrayContaining([MANIFEST]),
    );

    await projection.refill(async (request) => {
      if (!store.capture) throw new Error('The daemon-backed store captures');
      return (await store.capture(request)).capture;
    });
    expect(projection.state(MANIFEST)).toBe('current');
    const fresh = await capture();
    projection.installCapture(fresh, { ticket: projection.ticket() });
    expectSameAsFresh(fresh);
  });

  test('a capture racing an own commit at its commit id never undoes it', async () => {
    await writeWorkspaceConfig('a', { ...CONFIG });
    projection.installCapture(await capture(), {
      ticket: projection.ticket(),
    });
    let before: { capture: W5CaptureResult; ticket: number } | undefined;
    let during: { capture: W5CaptureResult; ticket: number } | undefined;
    harness.hooks.commit.before = async (): Promise<void> => {
      harness.hooks.commit.before = undefined;
      before = { ticket: projection.ticket(), capture: await capture() };
    };
    harness.hooks.commit.after = async (): Promise<void> => {
      harness.hooks.commit.after = undefined;
      during = { ticket: projection.ticket(), capture: await capture() };
    };
    await writeWorkspaceConfig('a', { ...CONFIG, alwaysShow: true });
    const { commitId } = lastPublished();
    if (!before || !during) throw new Error('The hooks did not capture');
    expect(before.capture.log.commitId).toBeLessThan(commitId);
    expect(during.capture.log.commitId).toBe(commitId);
    const written = projection.image(MANIFEST);

    // Delivered late, in either order: neither replaces the own bytes, and
    // the one requested before the decision's report settles nothing.
    for (const late of [during, before]) {
      projection.installCapture(late.capture, {
        ticket: late.ticket,
        authoritative: true,
      });
      expect(projection.image(MANIFEST)).toEqual(written);
      expect(projection.commitId(MANIFEST)).toBe(commitId);
      expect(projection.state(MANIFEST)).toBe('verifying');
    }
    const fresh = await capture();
    projection.installCapture(fresh, { ticket: projection.ticket() });
    expect(projection.state(MANIFEST)).toBe('current');
    expect(projection.image(MANIFEST)).toEqual(written);
    expectSameAsFresh(fresh);
  });

  test('a capture with unresolved commits is served pending, then upgraded', async () => {
    await writeWorkspaceConfig('a', { ...CONFIG });
    const fresh = await capture();
    const unresolved: W5CaptureResult = {
      ...fresh,
      log: { ...fresh.log, unresolvedCommits: 1 },
    };
    projection.installCapture(unresolved, { ticket: projection.ticket() });
    // Installed, as today's read serves it, never skipped.
    expect(projection.state(MANIFEST)).toBe('current');
    expect(projection.eligibility(WORKSPACE, 'complete')).toEqual(
      classifyW5RevisionEligibility(unresolved, WORKSPACE, 'complete'),
    );
    expect(projection.eligibility(WORKSPACE, 'complete')).toEqual({
      status: 'unverified',
      reason: 'pending',
    });
    expect(projection.refillPlan()?.files).toEqual(
      expect.arrayContaining([MANIFEST]),
    );
    projection.installCapture(fresh, {
      ticket: projection.ticket(),
      authoritative: true,
    });
    expectSameAsFresh(fresh);
  });

  test('an own conflict abandons history for files it never named', async () => {
    const OTHER = { kind: 'manifest', workspaceId: 'b' } as const;
    mkdirSync(join(harness.root, 'b'), { recursive: true });
    await writeWorkspaceConfig('a', { ...CONFIG });
    await writeWorkspaceConfig('b', { ...CONFIG });
    const both = async (): Promise<W5CaptureResult> => {
      if (!store.capture) throw new Error('The daemon-backed store captures');
      const { capture: result } = await store.capture({
        files: [{ kind: 'index' }, MANIFEST, OTHER],
        discoverWorkspaces: false,
      });
      return result;
    };
    const ticket = projection.ticket();
    const before = await both();
    projection.installCapture(before, { ticket });
    expect(projection.provenance(OTHER)).toMatchObject({ status: 'canonical' });
    // An edit outside the log between preflight and apply: the daemon records
    // the commit, abandons it on the clean conflict and refuses the write.
    harness.hooks.commit.before = (): Promise<void> => {
      harness.hooks.commit.before = undefined;
      writeFileSync(
        join(harness.root, 'a', 'workspace.json'),
        JSON.stringify({ ...CONFIG, alwaysShow: false }),
      );
      return Promise.resolve();
    };
    await expect(
      writeWorkspaceConfig('a', { ...CONFIG, alwaysShow: true }),
    ).rejects.toThrow(W5FileWriteRefusedError);

    // Abandonment is log-wide: nothing captured before it is served again.
    expect(projection.provenance(OTHER)).toBeUndefined();
    projection.installCapture(before, { ticket, authoritative: true });
    expect(projection.provenance(OTHER)).toBeUndefined();
    await projection.refill(async (request) => {
      if (!store.capture) throw new Error('The daemon-backed store captures');
      return (await store.capture(request)).capture;
    });
    const fresh = await both();
    expect(classifyW5FileProvenance(fresh, OTHER)).toEqual({
      status: 'unverified',
      reason: 'abandoned-history',
    });
    expect(projection.provenance(OTHER)).toEqual(
      classifyW5FileProvenance(fresh, OTHER),
    );
    expect(
      projection.eligibility(
        { kind: 'workspace', workspaceId: 'b' },
        'complete',
      ),
    ).toEqual(
      classifyW5RevisionEligibility(
        fresh,
        { kind: 'workspace', workspaceId: 'b' },
        'complete',
      ),
    );
  });
});
