import type * as LegacyStorage from './fixtures/w5-legacy-storage';
// W5d1 (CAN-5522) temp-root equivalence: each metadata command runs in
// Electron main in-process on root A and hosted by the daemon over the wire on
// root B, from twin roots Electron's writers seeded. Bytes, revisions, commit
// labels, replays and refusals must agree; each declared difference has its
// own test.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));
jest.mock('../../services/script-actions-lifecycle', () => ({
  notifyScriptActionsRepositoryAdd: jest.fn(),
}));

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { DEFAULT_ACTIVITY_SECTION_ORDER } from '@canopy/desktop-shared/constants/activity';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { W5_SHARED_CONTAINER_VIEWER_WORKSPACE_ID } from '@canopy/core-runtime/node/w5/workspace-metadata/daemon-binding';
import { projectW5ReorderOutcome } from '@canopy/core-runtime/node/w5/stored-outcome-projection';
import { CORE_WORKSPACE_ACTIVITY_SECTION_IDS } from '@canopy/protocol/canopy-core';
import { readDecidedCoreWorkspace } from '../../canopy-runtime/core-workspace-adapter';
import { recordWorkspaceCrudTelemetry } from '../desktop-telemetry';
import { notifyScriptActionsRepositoryAdd } from '../../services/script-actions-lifecycle';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  callHostedMetadata,
  pickerSelection,
  startW5HostedMetadataHarness,
  type W5HostedMetadataClient,
  type W5HostedMetadataHarness,
  type W5HostedMetadataRequest,
} from './fixtures/w5-hosted-metadata-harness';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  __setDesktopW5FileStoreForTests,
  createW5CommitLogFileStore,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import {
  reorderWorkspaces,
  updateWorkspaceMetadata,
} from '../workspace-metadata';
import { updateWorkspacePrivateMemory } from '../workspace-private-memory';
import {
  addWorkspaceRepository,
  removeWorkspaceRepository,
} from '../workspace-repositories';
import {
  updateWorkspacePlanDetection,
  updateWorkspaceScripts,
} from '../workspace-script-hook-settings';
import { writeWorkspaceConfig } from '../workspace-persistence';

jest.setTimeout(120_000);

const W5_NAMESPACES = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
];
const WORKER = join(__dirname, 'fixtures/w5-commit-log-source-worker.ts');
const RESOURCES = [
  { kind: 'workspaces' },
  ...['a', 'b', 'c', 'd'].map((workspaceId) => ({
    kind: 'workspace' as const,
    workspaceId,
  })),
] as const;

let dir: string;
let rootA: string;
let rootB: string;
let repo: string;
let other: string;
let plain: string;
let hostA: W5CommitLogHost;
let desktopCommits: string[];
let desktopReceiptCallers: string[];
let hostedReceiptCallers: string[];
let harness: W5HostedMetadataHarness;
let selections: Map<string, string>;
let client: W5HostedMetadataClient;
let originalDataDir: string | undefined;

function gitRepo(path: string): void {
  mkdirSync(path);
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
}

function isRepository(path: string): Promise<boolean> {
  try {
    execFileSync('git', ['-C', path, 'rev-parse', '--git-dir'], {
      stdio: 'ignore',
    });
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

/** The W5 files under `root`, by relative path. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of ['index.json', 'index.json.bak']) {
    try {
      files[name] = readFileSync(join(root, name), 'utf8');
    } catch {
      // Absent on both sides is equal.
    }
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      files[`${entry.name}/workspace.json`] = readFileSync(
        join(root, entry.name, 'workspace.json'),
        'utf8',
      );
    } catch {
      // No manifest.
    }
  }
  return files;
}

async function revisions(
  read: (resource: (typeof RESOURCES)[number]) => Promise<number>,
): Promise<number[]> {
  return Promise.all(RESOURCES.map((resource) => read(resource)));
}

/** Seeds root A with Electron's own writers; root B is its byte copy. */
async function seedTwinRoots(): Promise<void> {
  mkdirSync(rootA, { recursive: true });
  writeFileSync(
    join(rootA, 'index.json'),
    JSON.stringify(
      {
        version: 1,
        workspaces: [
          {
            id: 'a',
            name: 'A',
            type: 'multi-repo',
            color: '#7C3AED',
            order: 0,
          },
          {
            id: 'b',
            name: 'B',
            type: 'single-repo',
            color: '#7C3AED',
            order: 1,
          },
          { id: 'c', name: 'C', type: 'cowork', color: '#7C3AED', order: 2 },
          {
            id: 'd',
            name: 'D',
            type: 'multi-repo',
            color: '#7C3AED',
            order: 3,
          },
        ],
      },
      null,
      2,
    ),
  );
  for (const id of ['a', 'b', 'c', 'd']) mkdirSync(join(rootA, id));
  await writeWorkspaceConfig('a', {
    version: 1,
    type: 'multi-repo',
    repos: [{ id: 'web', name: 'web', repoPath: repo }],
    alwaysShow: true,
    defaultPluginSelections: {
      collectionIds: ['collection-1'],
      skillRefs: [],
      pluginRefs: [],
    },
  });
  await writeWorkspaceConfig('b', {
    version: 1,
    type: 'single-repo',
    repoPath: repo,
    repos: [],
    alwaysShow: true,
  });
  await writeWorkspaceConfig('c', {
    version: 1,
    type: 'cowork',
    repos: [],
    alwaysShow: true,
  });
  // An organization's memory policy; only its own writer records it.
  writeFileSync(
    join(rootA, 'd', 'workspace.json'),
    JSON.stringify(
      {
        privateMemory: false,
        privateMemoryManagedBy: 'organization',
        version: 1,
        type: 'multi-repo',
        repos: [],
        alwaysShow: true,
      },
      null,
      2,
    ),
  );
  cpSync(rootA, rootB, { recursive: true });
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'w5d1-equivalence-')));
  rootA = join(dir, 'a', 'workspaces');
  rootB = join(dir, 'b', 'workspaces');
  repo = join(dir, 'repo');
  other = join(dir, 'other');
  plain = join(dir, 'plain');
  gitRepo(repo);
  gitRepo(other);
  mkdirSync(plain);
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'a');
  __resetSidebarItemsStateForTests();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await seedTwinRoots();

  hostA = new W5CommitLogHost({
    dbPath: join(dir, 'a', 'w5', 'commit-log.sqlite'),
    root: rootA,
    workerEntry: WORKER,
  });
  desktopCommits = [];
  desktopReceiptCallers = [];
  const commit = hostA.commit.bind(hostA);
  jest.spyOn(hostA, 'commit').mockImplementation(async (request) => {
    if (request.receipt) desktopReceiptCallers.push(request.receipt.caller);
    const outcome = await commit(request);
    desktopCommits.push(request.operation);
    return outcome;
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => hostA));

  selections = new Map([
    ['pick-other', other],
    ['pick-web', repo],
    ['pick-plain', plain],
  ]);
  harness = await startW5HostedMetadataHarness({
    dbPath: join(dir, 'b', 'w5', 'commit-log.sqlite'),
    root: rootB,
    workerEntry: WORKER,
    repositorySelections: selections,
    isRepository,
  });
  hostedReceiptCallers = [];
  harness.hooks.commit.before = (request): Promise<void> => {
    if (request.receipt) hostedReceiptCallers.push(request.receipt.caller);
    return Promise.resolve();
  };
  client = await harness.connectMetadata();
});
afterEach(async () => {
  await settleDetachedWork();
  await harness.close();
  await hostA.shutdown();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.clearAllMocks();
});

interface Case {
  readonly name: string;
  readonly desktop: () => Promise<unknown>;
  readonly hosted: W5HostedMetadataRequest;
  /** The desktop outcome as the wire returns it; absent, both refuse. */
  readonly project?: (outcome: unknown) => unknown;
  /** The refusal reason both report, or a records code the wire reports. */
  readonly refusal?: { reason?: string; code?: string };
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? Reflect.get(value, key)
    : undefined;
}

/** The repository as the wire projects it, without its host path. */
function projectRepository(repository: unknown): unknown {
  const source = field(repository, 'source');
  return {
    id: field(repository, 'id'),
    name: field(repository, 'name'),
    ...(source !== undefined && { source }),
  };
}

/*
 * #3's result is the desktop's own `core.workspace.get` projection of the
 * workspace the decision left (DM-2): the daemon's projection over its root
 * must equal the desktop's over the twin root.
 */
const projectUpdate = (outcome: unknown): Promise<unknown> =>
  readDecidedCoreWorkspace(String(field(outcome, 'workspaceId')));
// A17(a): the desktop outcome's acknowledgement.
const projectReorder = (outcome: unknown): unknown =>
  projectW5ReorderOutcome('core.workspace.reorder', outcome);
const projectVoid = (): unknown => ({});

/*
 * Both registries read one ownership table: Electron's in-process writers run
 * under the legacy rows, the daemon's under daemon-owned rows.
 */
async function desktopOutcome(
  run: () => Promise<unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  harness.setDaemonOwned([]);
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

async function hostedOutcome(
  params: W5HostedMetadataRequest,
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  harness.setDaemonOwned(W5_NAMESPACES);
  try {
    return { ok: true, value: await callHostedMetadata(client, params) };
  } catch (error) {
    return { ok: false, error: field(error, 'payload') };
  }
}

/** Runs one case on both roots and checks every observable agrees. */
async function runBoth(testCase: Case): Promise<void> {
  const commitsA = desktopCommits.length;
  const commitsB = harness.commits.length;
  const before = snapshot(rootA);
  const desktop = await desktopOutcome(testCase.desktop);
  const hosted = await hostedOutcome(testCase.hosted);
  expect({ case: testCase.name, files: snapshot(rootB) }).toEqual({
    case: testCase.name,
    files: snapshot(rootA),
  });
  expect(await revisions((resource) => harness.revision(resource))).toEqual(
    await revisions((resource) => hostA.revision(resource)),
  );
  expect({
    case: testCase.name,
    commits: harness.commits.slice(commitsB),
    hosted: hosted.ok || hosted.error,
  }).toEqual({
    case: testCase.name,
    commits: desktopCommits.slice(commitsA),
    hosted: hosted.ok || hosted.error,
  });
  if (testCase.project) {
    expect({
      case: testCase.name,
      desktop: desktop.ok,
      hosted: hosted.ok,
    }).toEqual({ case: testCase.name, desktop: true, hosted: true });
    if (desktop.ok && hosted.ok)
      expect(hosted.value).toEqual(await testCase.project(desktop.value));
    return;
  }
  expect({
    case: testCase.name,
    desktop: desktop.ok,
    hosted: hosted.ok,
  }).toEqual({ case: testCase.name, desktop: false, hosted: false });
  expect(snapshot(rootA)).toEqual(before);
  if (desktop.ok || hosted.ok) return;
  if (testCase.refusal?.reason !== undefined) {
    expect(field(desktop.error, 'reason')).toBe(testCase.refusal.reason);
    expect(field(hosted.error, 'details')).toEqual({
      reason: testCase.refusal.reason,
    });
  }
  if (testCase.refusal?.code !== undefined)
    expect(field(hosted.error, 'code')).toBe(testCase.refusal.code);
}

const CASES: readonly Case[] = [
  {
    name: 'update: rename, recolor and pin',
    desktop: () =>
      updateWorkspaceMetadata({
        workspaceId: 'a',
        source: 'portal',
        patch: { name: 'Renamed', color: '#0EA5E9', pinned: true },
      }),
    hosted: {
      operation: 'core.workspace.update',
      workspaceId: 'a',
      patch: { name: 'Renamed', color: '#0EA5E9', pinned: true },
    },
    project: projectUpdate,
  },
  {
    name: 'update: manifest fields, keyed, at the current revision',
    desktop: () =>
      updateWorkspaceMetadata({
        workspaceId: 'a',
        source: 'desktop_set_start_page',
        patch: {
          itemSortMode: 'last-updated',
          alwaysShow: false,
          startPage: {
            kind: 'set',
            startPage: { kind: 'url', url: 'https://example.com/' },
          },
        },
        expectedRevision: 1,
        idempotencyKey: 'u2',
      }),
    hosted: {
      operation: 'core.workspace.update',
      workspaceId: 'a',
      patch: {
        itemSortMode: 'last-updated',
        alwaysShow: false,
        startPage: { kind: 'url', url: 'https://example.com/' },
      },
      expectedRevision: 1,
      idempotencyKey: 'u2',
    },
    project: projectUpdate,
  },
  {
    name: 'update: inherit the start page, manual order, sections and collapse',
    desktop: () =>
      updateWorkspaceMetadata({
        workspaceId: 'a',
        source: 'desktop_canopy_client',
        patch: {
          startPage: { kind: 'inherit' },
          itemSortMode: 'manual',
          activitySectionOrder: ['plans', 'summary'],
          collapsed: true,
        },
      }),
    hosted: {
      operation: 'core.workspace.update',
      workspaceId: 'a',
      patch: {
        startPage: { kind: 'inherit' },
        itemSortMode: 'manual',
        activitySectionOrder: ['plans', 'summary'],
        collapsed: true,
      },
    },
    project: projectUpdate,
  },
  {
    // The wire refuses an empty patch, so no receipt-only #3 crosses it.
    name: 'update: one index field of another workspace, keyed',
    desktop: () =>
      updateWorkspaceMetadata({
        workspaceId: 'b',
        source: 'portal',
        patch: { collapsed: true },
        idempotencyKey: 'u4',
      }),
    hosted: {
      operation: 'core.workspace.update',
      workspaceId: 'b',
      patch: { collapsed: true },
      idempotencyKey: 'u4',
    },
    project: projectUpdate,
  },
  {
    name: 'reorder: a drag move',
    desktop: () =>
      reorderWorkspaces({
        visibleWorkspaceIds: ['a', 'b', 'c'],
        activeWorkspaceId: 'c',
        overWorkspaceId: 'a',
        idempotencyKey: 'r1',
      }),
    hosted: {
      operation: 'core.workspace.reorder',
      visibleWorkspaceIds: ['a', 'b', 'c'],
      activeWorkspaceId: 'c',
      overWorkspaceId: 'a',
      idempotencyKey: 'r1',
    },
    project: projectReorder,
  },
  {
    // The wire has no projects save; its drag move writes the same bytes.
    name: 'reorder: the projects save, as the wire drag move',
    desktop: () =>
      reorderWorkspaces({
        source: 'projects_save',
        workspaceOrder: ['d', 'b'],
      }),
    hosted: {
      operation: 'core.workspace.reorder',
      visibleWorkspaceIds: ['b', 'd'],
      activeWorkspaceId: 'd',
      overWorkspaceId: 'b',
    },
    project: projectReorder,
  },
  {
    name: 'scripts: replace',
    desktop: () =>
      updateWorkspaceScripts({
        workspaceId: 'a',
        source: 'desktop',
        change: { kind: 'replace', scripts: { setup: 'pnpm install' } },
      }),
    hosted: {
      operation: 'core.workspace.scripts.update',
      workspaceId: 'a',
      change: { kind: 'replace', scripts: { setup: 'pnpm install' } },
    },
    project: projectVoid,
  },
  {
    name: 'scripts: merge commands, keyed',
    desktop: () =>
      updateWorkspaceScripts({
        workspaceId: 'a',
        source: 'portal',
        change: {
          kind: 'merge-commands',
          commands: { launch: 'pnpm dev', setup: '' },
        },
        idempotencyKey: 's2',
      }),
    hosted: {
      operation: 'core.workspace.scripts.update',
      workspaceId: 'a',
      change: {
        kind: 'merge-commands',
        commands: { launch: 'pnpm dev', setup: '' },
      },
      idempotencyKey: 's2',
    },
    project: projectVoid,
  },
  {
    name: 'scripts: a member repository',
    desktop: () =>
      updateWorkspaceScripts({
        workspaceId: 'a',
        source: 'desktop',
        change: {
          kind: 'repositories',
          repos: [{ repoId: 'web', scripts: { test: 'pnpm test' } }],
        },
      }),
    hosted: {
      operation: 'core.workspace.scripts.update',
      workspaceId: 'a',
      change: {
        kind: 'repositories',
        repos: [{ repoId: 'web', scripts: { test: 'pnpm test' } }],
      },
    },
    project: projectVoid,
  },
  {
    name: 'scripts: one definition of a repository',
    desktop: () =>
      updateWorkspaceScripts({
        workspaceId: 'a',
        source: 'app_advisor',
        change: {
          kind: 'definition',
          repoId: 'web',
          name: 'lint',
          value: { command: 'pnpm lint', timeoutSeconds: 60 },
        },
      }),
    hosted: {
      operation: 'core.workspace.scripts.update',
      workspaceId: 'a',
      change: {
        kind: 'definition',
        repoId: 'web',
        name: 'lint',
        value: { command: 'pnpm lint', timeoutSeconds: 60 },
      },
    },
    project: projectVoid,
  },
  {
    name: 'scripts: remove that definition',
    desktop: () =>
      updateWorkspaceScripts({
        workspaceId: 'a',
        source: 'app_advisor',
        change: { kind: 'remove-definition', repoId: 'web', name: 'lint' },
      }),
    hosted: {
      operation: 'core.workspace.scripts.update',
      workspaceId: 'a',
      change: { kind: 'remove-definition', repoId: 'web', name: 'lint' },
    },
    project: projectVoid,
  },
  {
    name: 'plan detection',
    desktop: () =>
      updateWorkspacePlanDetection({
        workspaceId: 'b',
        source: 'desktop',
        planDetection: {
          disabledRuleIds: ['plans-dir'],
          customRules: [
            {
              id: 'r1',
              label: 'Docs',
              kind: 'include',
              pattern: 'docs/**/*.md',
              enabled: true,
            },
          ],
        },
      }),
    hosted: {
      operation: 'core.workspace.planDetection.update',
      workspaceId: 'b',
      planDetection: {
        disabledRuleIds: ['plans-dir'],
        customRules: [
          {
            id: 'r1',
            label: 'Docs',
            kind: 'include',
            pattern: 'docs/**/*.md',
            enabled: true,
          },
        ],
      },
    },
    project: projectVoid,
  },
  {
    name: 'private memory, keyed',
    desktop: () =>
      updateWorkspacePrivateMemory({
        workspaceId: 'a',
        source: 'workspace_settings',
        privateMemory: true,
        idempotencyKey: 'm1',
      }),
    hosted: {
      operation: 'core.workspace.privateMemory.update',
      workspaceId: 'a',
      privateMemory: true,
      idempotencyKey: 'm1',
    },
    project: (outcome) => ({
      workspaceId: field(outcome, 'workspaceId'),
      privateMemory: field(outcome, 'privateMemory'),
    }),
  },
  {
    name: 'repository add, keyed',
    desktop: () =>
      addWorkspaceRepository({
        workspaceId: 'a',
        source: 'workspace_settings',
        repository: { repoPath: other, name: 'Other' },
        idempotencyKey: 'a1',
      }),
    hosted: {
      operation: 'core.workspace.repository.add',
      workspaceId: 'a',
      repository: { selection: pickerSelection('pick-other'), name: 'Other' },
      idempotencyKey: 'a1',
    },
    project: (outcome) => ({ repository: projectRepository(outcome) }),
  },
  {
    name: 'repository remove',
    desktop: () =>
      removeWorkspaceRepository({
        workspaceId: 'a',
        source: 'workspace_settings',
        repoId: 'other',
      }),
    hosted: {
      operation: 'core.workspace.repository.remove',
      workspaceId: 'a',
      repoId: 'other',
    },
    project: (outcome) => {
      const removed = field(outcome, 'removed');
      return { removed: removed === null ? null : projectRepository(removed) };
    },
  },
  {
    // Keyed, as every wire call is: a keyed removal saves its outcome even
    // when nothing is removed.
    name: 'repository remove of a repository it does not have, keyed (no file write)',
    desktop: () =>
      removeWorkspaceRepository({
        workspaceId: 'a',
        source: 'workspace_settings',
        repoId: 'missing',
        idempotencyKey: 'remove-missing',
      }),
    hosted: {
      operation: 'core.workspace.repository.remove',
      workspaceId: 'a',
      repoId: 'missing',
      idempotencyKey: 'remove-missing',
    },
    // Desktop's `removed: null`.
    project: (outcome) => {
      const removed = field(outcome, 'removed');
      return { removed: removed === null ? null : projectRepository(removed) };
    },
  },
  // Refusals: the same reason, and nothing written on either side.
  {
    name: 'refused: an unknown workspace',
    desktop: () =>
      updateWorkspaceMetadata({
        workspaceId: 'zz',
        source: 'portal',
        patch: { name: 'X' },
      }),
    hosted: {
      operation: 'core.workspace.update',
      workspaceId: 'zz',
      patch: { name: 'X' },
    },
    refusal: { reason: 'not-found' },
  },
  {
    name: 'refused: a Cowork start page',
    desktop: () =>
      updateWorkspaceMetadata({
        workspaceId: 'c',
        source: 'portal',
        patch: { startPage: { kind: 'inherit' } },
      }),
    hosted: {
      operation: 'core.workspace.update',
      workspaceId: 'c',
      patch: { startPage: { kind: 'inherit' } },
    },
    refusal: {
      reason: 'unsupported-for-cowork',
      code: 'core.workspace.invalidState',
    },
  },
  {
    name: 'refused: private memory an organization manages',
    desktop: () =>
      updateWorkspacePrivateMemory({
        workspaceId: 'd',
        source: 'workspace_settings',
        privateMemory: true,
      }),
    hosted: {
      operation: 'core.workspace.privateMemory.update',
      workspaceId: 'd',
      privateMemory: true,
    },
    refusal: {
      reason: 'managed-by-organization',
      code: 'core.workspace.invalidState',
    },
  },
  {
    name: 'refused: a repository for a single-repo workspace',
    desktop: () =>
      addWorkspaceRepository({
        workspaceId: 'b',
        source: 'workspace_settings',
        repository: { repoPath: other },
      }),
    hosted: {
      operation: 'core.workspace.repository.add',
      workspaceId: 'b',
      repository: { selection: pickerSelection('pick-other') },
    },
    refusal: { reason: 'not-multi-repo' },
  },
  {
    name: 'refused: a repository already added',
    desktop: () =>
      addWorkspaceRepository({
        workspaceId: 'a',
        source: 'workspace_settings',
        repository: { repoPath: repo },
      }),
    hosted: {
      operation: 'core.workspace.repository.add',
      workspaceId: 'a',
      repository: { selection: pickerSelection('pick-web') },
    },
    refusal: { reason: 'duplicate' },
  },
  {
    name: 'refused: a folder that is not a Git repository',
    desktop: () =>
      addWorkspaceRepository({
        workspaceId: 'a',
        source: 'workspace_settings',
        repository: { repoPath: plain },
      }),
    hosted: {
      operation: 'core.workspace.repository.add',
      workspaceId: 'a',
      repository: { selection: pickerSelection('pick-plain') },
    },
    refusal: { reason: 'not-a-repository' },
  },
  {
    name: 'refused: the shared-container viewer scope',
    desktop: () =>
      updateWorkspaceScripts({
        workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        source: 'desktop',
        change: { kind: 'replace', scripts: undefined },
      }),
    hosted: {
      operation: 'core.workspace.scripts.update',
      workspaceId: W5_SHARED_CONTAINER_VIEWER_WORKSPACE_ID,
      change: { kind: 'replace' },
    },
    refusal: { reason: 'read-only-scope' },
  },
  {
    name: 'refused: a color outside the project palette',
    desktop: () =>
      updateWorkspaceMetadata({
        workspaceId: 'a',
        source: 'portal',
        patch: { color: '#123456' },
      }),
    hosted: {
      operation: 'core.workspace.update',
      workspaceId: 'a',
      patch: { color: '#123456' },
    },
    refusal: { reason: 'invalid-patch' },
  },
  {
    name: 'refused: a stale workspace revision',
    desktop: () =>
      updateWorkspaceScripts({
        workspaceId: 'b',
        source: 'desktop',
        change: { kind: 'replace', scripts: { setup: 'make' } },
        expectedRevision: 0,
        idempotencyKey: 'stale',
      }),
    hosted: {
      operation: 'core.workspace.scripts.update',
      workspaceId: 'b',
      change: { kind: 'replace', scripts: { setup: 'make' } },
      expectedRevision: 0,
      idempotencyKey: 'stale',
    },
    refusal: { code: 'core.workspace.revisionConflict' },
  },
];

describe('temp-root equivalence of the hosted metadata commands', () => {
  it('checks the same activity sections and read-only scope as Electron', () => {
    expect([...CORE_WORKSPACE_ACTIVITY_SECTION_IDS].sort()).toEqual(
      [...DEFAULT_ACTIVITY_SECTION_ORDER].sort(),
    );
    expect(W5_SHARED_CONTAINER_VIEWER_WORKSPACE_ID).toBe(
      SHARED_CONTAINER_VIEWER_PROJECT_ID,
    );
  });

  it('writes the same bytes, revisions and labels, and replays and refuses alike', async () => {
    expect(snapshot(rootB)).toEqual(snapshot(rootA));
    for (const testCase of CASES) {
      await runBoth(testCase);
      // A keyed case's replay: the same result, and no decision on either side.
      if ('idempotencyKey' in testCase.hosted && testCase.project) {
        const commitsA = desktopCommits.length;
        const commitsB = harness.commits.length;
        const desktop = await desktopOutcome(testCase.desktop);
        const hosted = await hostedOutcome(testCase.hosted);
        expect(desktop.ok && hosted.ok).toBe(true);
        if (desktop.ok && hosted.ok)
          expect(hosted.value).toEqual(await testCase.project(desktop.value));
        expect(desktopCommits).toHaveLength(commitsA);
        expect(harness.commits).toHaveLength(commitsB);
      }
    }
    expect(snapshot(rootB)).toEqual(snapshot(rootA));
  });

  it("projects #3 from stored values the update would refuse, and from a manifest whose type the index does not name, as the desktop's own projection does", async () => {
    const index: unknown = JSON.parse(
      readFileSync(join(rootA, 'index.json'), 'utf8'),
    );
    const entries = field(index, 'workspaces');
    if (!Array.isArray(entries)) throw new Error('index shape');
    const stored = {
      version: 1,
      workspaces: entries.map((entry: unknown) =>
        field(entry, 'id') === 'a' && typeof entry === 'object' && entry
          ? {
              ...entry,
              // Outside the palette, and an order with an unknown section.
              color: '#123456',
              activitySectionOrder: ['plans', 'not-a-section'],
            }
          : entry,
      ),
    };
    const manifests = {
      a: {
        version: 1,
        type: 'multi-repo',
        repos: [
          {
            id: 'web',
            name: 'web',
            repoPath: repo,
            manifestUrl: 'ssh://git@github.com/acme/web.git',
          },
          {
            id: 'api',
            name: 'api',
            repoPath: other,
            manifestUrl: 'deploy@github.com:acme/api.git',
          },
        ],
        itemSortMode: 'bogus',
        alwaysShow: 'yes',
        startPage: { kind: 'url', url: 'ftp://example.com/' },
      },
      // The index names `b` single-repo; its manifest is a temporary
      // combination without Always show.
      b: {
        version: 1,
        type: 'multi-repo',
        temporary: true,
        repos: [{ id: 'web', name: 'web', repoPath: repo }],
      },
    };
    for (const root of [rootA, rootB]) {
      writeFileSync(join(root, 'index.json'), JSON.stringify(stored, null, 2));
      for (const [id, manifest] of Object.entries(manifests))
        writeFileSync(
          join(root, id, 'workspace.json'),
          JSON.stringify(manifest, null, 2),
        );
    }
    for (const workspaceId of ['a', 'b'])
      await runBoth({
        name: `update: stored edge values of ${workspaceId}`,
        desktop: () =>
          updateWorkspaceMetadata({
            workspaceId,
            source: 'portal',
            patch: { pinned: true },
          }),
        hosted: {
          operation: 'core.workspace.update',
          workspaceId,
          patch: { pinned: true },
        },
        project: projectUpdate,
      });
  });

  it("replays a keyed duplicate whose reserve follows the first call's commit, resolving its one-time selection once", async () => {
    const resolve = selections.get.bind(selections);
    const resolved: string[] = [];
    jest.spyOn(selections, 'get').mockImplementation((selectionId) => {
      const repoPath = resolve(selectionId);
      resolved.push(selectionId);
      selections.delete(selectionId);
      return repoPath;
    });
    const params: W5HostedMetadataRequest = {
      operation: 'core.workspace.repository.add',
      workspaceId: 'a',
      repository: { selection: pickerSelection('pick-other') },
      idempotencyKey: 'add-duplicate',
    };
    let duplicateLookedUp = (): void => {};
    const duplicateLookup = new Promise<void>((resolveLookup) => {
      duplicateLookedUp = resolveLookup;
    });
    let firstCommitted = (): void => {};
    const committed = new Promise<void>((resolveCommit) => {
      firstCommitted = resolveCommit;
    });
    harness.hooks.commit.after = (): Promise<void> => {
      firstCommitted();
      return Promise.resolve();
    };
    // The duplicate finds no receipt before the first call reserves, and
    // reserves only after the first call committed.
    let lookups = 0;
    let duplicate: Promise<unknown> | undefined;
    harness.hooks.afterLookup = async (): Promise<void> => {
      lookups += 1;
      if (lookups === 1) {
        duplicate = callHostedMetadata(client, params);
        await duplicateLookup;
      } else if (lookups === 2) {
        duplicateLookedUp();
        await committed;
      }
    };
    harness.setDaemonOwned(W5_NAMESPACES);
    const commits = harness.commits.length;
    const added = { repository: { id: 'other', name: 'other' } };
    await expect(callHostedMetadata(client, params)).resolves.toEqual(added);
    await expect(duplicate).resolves.toEqual(added);
    // The duplicate's reserve was refused, and its next lookup replayed.
    expect(lookups).toBe(3);
    expect(resolved).toEqual(['pick-other']);
    expect(harness.commits.slice(commits)).toEqual([
      'core.workspace.repository.add',
    ]);
    harness.hooks.afterLookup = undefined;
    harness.hooks.commit.after = undefined;
    const files = snapshot(rootB);
    await expect(callHostedMetadata(client, params)).resolves.toEqual(added);
    expect(resolved).toEqual(['pick-other']);
    expect(harness.commits.slice(commits)).toEqual([
      'core.workspace.repository.add',
    ]);
    expect(snapshot(rootB)).toEqual(files);
  });

  it('declared: keyed receipts name the principal, not the desktop host', async () => {
    const [, keyed] = CASES;
    if (!keyed) throw new Error('missing case');
    await runBoth(CASES[0] ?? keyed);
    await runBoth(keyed);
    expect(desktopReceiptCallers).toEqual(['desktop-host:workspace-metadata']);
    // Every wire call is keyed (A13): each names the principal.
    expect(hostedReceiptCallers).toEqual([
      'daemon:local-user:workspace-metadata',
      'daemon:local-user:workspace-metadata',
    ]);
  });

  it('declared: the hosted path runs no telemetry or script-actions notify', async () => {
    const rename = CASES[0];
    const add = CASES.find(({ name }) => name === 'repository add, keyed');
    if (!rename || !add) throw new Error('missing case');
    await desktopOutcome(rename.desktop);
    await desktopOutcome(add.desktop);
    expect(recordWorkspaceCrudTelemetry).toHaveBeenCalledTimes(1);
    expect(notifyScriptActionsRepositoryAdd).toHaveBeenCalledTimes(1);
    await hostedOutcome(rename.hosted);
    await hostedOutcome(add.hosted);
    expect(recordWorkspaceCrudTelemetry).toHaveBeenCalledTimes(1);
    expect(notifyScriptActionsRepositoryAdd).toHaveBeenCalledTimes(1);
  });

  it("declared: a refusal message names no host path, as Electron's may", async () => {
    const notRepository = CASES.find(({ name }) =>
      name.includes('not a Git repository'),
    );
    if (!notRepository) throw new Error('missing case');
    const desktop = await desktopOutcome(notRepository.desktop);
    const hosted = await hostedOutcome(notRepository.hosted);
    expect(desktop.ok || hosted.ok).toBe(false);
    if (desktop.ok || hosted.ok) return;
    expect(String(field(desktop.error, 'message'))).toContain(plain);
    expect(String(field(hosted.error, 'message'))).not.toContain(plain);
  });

  it('declared: stored spellings Electron would canonicalize stay as stored, and plugin defaults never change', async () => {
    const stored = {
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'web', name: 'web', repoPath: repo }],
      alwaysShow: true,
      defaultPluginSelections: {
        collectionIds: [],
        mcpServerRefs: ['account:legacy-connection'],
      },
      disabledGlobalPluginSelections: { skillRefs: ['x'] },
      hooks: { 'before-run': { kind: 'unknown-hook', extra: true } },
      future: { kept: true },
    };
    const text = JSON.stringify(stored, null, 2);
    writeFileSync(join(rootB, 'a', 'workspace.json'), text);
    await hostedOutcome({
      operation: 'core.workspace.scripts.update',
      workspaceId: 'a',
      change: { kind: 'replace', scripts: { setup: 'pnpm i' } },
    });
    const written: unknown = JSON.parse(
      readFileSync(join(rootB, 'a', 'workspace.json'), 'utf8'),
    );
    expect(written).toEqual({ ...stored, scripts: { setup: 'pnpm i' } });
    // The plugin-default fields' bytes, exactly as stored.
    const after = readFileSync(join(rootB, 'a', 'workspace.json'), 'utf8');
    for (const key of [
      'defaultPluginSelections',
      'disabledGlobalPluginSelections',
    ])
      expect(after).toContain(
        JSON.stringify({ [key]: field(stored, key) }, null, 2)
          .slice(1, -1)
          .trim()
          .replace(/\n {2}/g, '\n  '),
      );
  });
});
