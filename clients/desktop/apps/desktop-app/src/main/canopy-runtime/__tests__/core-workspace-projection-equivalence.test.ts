// CAN-7239 (CAN-7153 PR 1a) migration equivalence: the host-neutral
// projection in core-runtime, over W5 record images alone, answers every
// `core.workspace.*` and `core.worktree.*` list/get as Electron main's adapter
// does over its own reads of the same fixture root and the same capture:
// items, refusals, provenance filters, publishable revisions and continuation.
// It lives here because it compares against the desktop adapter, which
// core-runtime cannot import. Divergences only Electron main can decide are
// declared in the last block, each with a test where the fixture root can
// produce it.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CORE_WORKSPACE_ACTIVITY_SECTION_IDS,
  type CanopyCallerDescriptor,
  type CanopyQueryParams,
} from '@canopy/protocol/canopy-core';
import { DEFAULT_ACTIVITY_SECTION_ORDER } from '@canopy/desktop-shared/constants/activity';
import type {
  W5CaptureFile,
  W5CaptureResult,
  W5FileImage,
} from '@canopy/core-runtime/node/w5/commit-log/capture-contract';
import { classifyW5RevisionEligibility } from '@canopy/core-runtime/node/w5/commit-log/eligibility';
import { readNodeW5File } from '@canopy/core-runtime/node/w5/file-store';
import { createW5RecordImageReaders } from '@canopy/core-runtime/node/w5/record-image-repositories';
import { createCoreReadSnapshotStore } from '@canopy/core-runtime/node/workspace/core-workspace-read-snapshots';
import { setLoginShellProbe } from '@canopy/execution-engine/node/pipelines/config-paths';
import {
  checkCoreWorkspaceGetParams,
  checkCoreWorkspaceListParams,
  checkCoreWorktreeGetParams,
  checkCoreWorktreeListParams,
  coreWorkspaceResourceKey,
  differentListing,
  listBinding,
  listPage,
  projectCoreWorkspaceGet,
  projectCoreWorkspaceList,
  projectCoreWorktreeGet,
  projectCoreWorktreeList,
  publishCoreWorkspaceItem,
  publishCoreWorkspaceList,
  type CoreWorkspaceFilters,
  type CoreWorkspaceProjected,
  type CoreWorkspaceProjectedList,
  type CoreWorkspaceReadFilter as SharedReadFilter,
  type CoreWorkspaceResourceProjection,
} from '@canopy/core-runtime/node/workspace/core-workspace-projection';
import { createW5CoreWorkspaceProjectionReads } from '@canopy/core-runtime/node/workspace/core-workspace-w5-reads';
import { getPrimaryProjectConfigFilePath } from '../../lib/canopy-json';
import { getWorkspacesRootDir } from '../../lib/paths';
import {
  __resetSidebarItemsStateForTests,
  readAllSidebarItems,
  readAllSidebarItemsSnapshot,
  readWorkspaceIndexEntry,
  readWorkspaceIndexEntryDetailed,
} from '../../lib/sidebar-items';
import {
  markWorkspaceWorktreeRecentlyRemoved,
  readWorkspaceConfig,
  readWorkspaceConfigDetailed,
  readWorkspaceWorktrees,
  readWorkspaceWorktreesDetailed,
} from '../../lib/workspace-persistence';
import { readEffectiveWorkspaceConfig } from '../../lib/workspace-source';
import {
  createCoreWorkspaceAdapter,
  createCoreWorkspaceReadSnapshots,
  type CoreWorkspaceReadDetail,
  type CoreWorkspaceReadServices,
} from '../core-workspace-adapter';
import {
  publishableRevisions,
  type CoreWorkspaceReadFilter as DesktopReadFilter,
} from '../core-workspace-read-provenance';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../desktop-runtime-identity';

jest.setTimeout(60_000);

// The filter vocabularies stay one until the provenance module moves (1b).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const FILTERS_AGREE: Same<SharedReadFilter, DesktopReadFilter> = true;

const ORG = '0b6f3c1e-8a4d-4c55-9f0e-2d3b1a7c9e11';
const OTHER_ORG = '7d2a9f4b-1c3e-4b8a-a6d5-5e9c0f1b2a33';
const caller: CanopyCallerDescriptor = {
  principalId: 'test-user',
  clientInstanceId: 'test-client',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'test',
  grants: ['core.workspace.read', 'core.worktree.read'],
};

function owner(organizationId: string): Record<string, unknown> {
  return {
    type: 'organization',
    organizationId,
    projectId: '3e1d2c4b-5a6f-4b7c-8d9e-0f1a2b3c4d5e',
    instanceId: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d',
    bindingGeneration: 0,
  };
}

// --- The fixture root and its capture ----------------------------------------

/** A file's stored text; `null` writes nothing. */
type Contents = string | null;

interface RootSpec {
  index: Contents | readonly Record<string, unknown>[];
  manifests?: Record<string, Contents | Record<string, unknown>>;
  worktrees?: Record<string, Contents | readonly Record<string, unknown>[]>;
  /** Resource keys the log holds no counter row for. */
  withoutRevision?: readonly string[];
  /** Files edited outside the log after its last decision. */
  diverged?: readonly string[];
}

const UNREADABLE = '{"version": 1,';

function text(
  value: Contents | Record<string, unknown> | readonly unknown[],
  wrap?: (value: readonly unknown[]) => Record<string, unknown>,
): Contents {
  if (value === null || typeof value === 'string') return value;
  return JSON.stringify(
    Array.isArray(value) && wrap ? wrap(value) : value,
    null,
    2,
  );
}

const sha = (contents: string): string =>
  createHash('sha256').update(contents, 'utf8').digest('hex');

function fileKey(file: W5CaptureFile): string {
  return 'workspaceId' in file ? `${file.kind}:${file.workspaceId}` : file.kind;
}

/** Writes `spec` under the workspaces root and captures it at commit 9. */
function writeRoot(spec: RootSpec): W5CaptureResult {
  const root = getWorkspacesRootDir();
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const files: { file: W5CaptureFile; path: string; contents: Contents }[] = [];
  const write = (
    file: W5CaptureFile,
    path: string,
    contents: Contents,
  ): void => {
    files.push({ file, path, contents });
    if (contents !== null) writeFileSync(path, contents);
  };
  write(
    { kind: 'index' },
    join(root, 'index.json'),
    text(spec.index, (workspaces) => ({ version: 1, workspaces })),
  );
  const ids = new Set([
    ...Object.keys(spec.manifests ?? {}),
    ...Object.keys(spec.worktrees ?? {}),
  ]);
  for (const workspaceId of ids) {
    mkdirSync(join(root, workspaceId), { recursive: true });
    write(
      { kind: 'manifest', workspaceId },
      join(root, workspaceId, 'workspace.json'),
      text(spec.manifests?.[workspaceId] ?? null),
    );
    write(
      { kind: 'worktrees', workspaceId },
      join(root, workspaceId, 'worktrees.json'),
      text(spec.worktrees?.[workspaceId] ?? null, (worktrees) => ({
        version: 1,
        worktrees,
      })),
    );
  }
  const revisions: Record<string, number> = { workspaces: 5 };
  const rowIds = (contents: Contents, key: string): string[] => {
    try {
      const parsed: unknown = JSON.parse(contents ?? 'null');
      const rows: unknown =
        parsed && typeof parsed === 'object' ? Reflect.get(parsed, key) : null;
      return Array.isArray(rows)
        ? rows.flatMap((row: unknown) => {
            const id: unknown =
              row && typeof row === 'object' ? Reflect.get(row, 'id') : null;
            return typeof id === 'string' ? [id] : [];
          })
        : [];
    } catch {
      return [];
    }
  };
  rowIds(files[0]?.contents ?? null, 'workspaces').forEach((id, at) => {
    revisions[`workspace:${id}`] = at + 1;
  });
  for (const { file, contents } of files)
    if (file.kind === 'worktrees') {
      revisions[`worktrees:${file.workspaceId}`] = 3;
      for (const id of rowIds(contents, 'worktrees'))
        revisions[`worktree:${file.workspaceId}/${id}`] = 1;
    }
  for (const key of spec.withoutRevision ?? []) delete revisions[key];
  const present = files.filter(
    (entry): entry is typeof entry & { contents: string } =>
      entry.contents !== null,
  );
  return {
    files: files.map(
      ({ file, contents }): W5FileImage =>
        contents === null
          ? { ...file, state: 'absent' }
          : {
              ...file,
              state: 'present',
              base64: Buffer.from(contents, 'utf8').toString('base64'),
            },
    ),
    discovery: 'complete',
    log: {
      logId: '00000000-0000-4000-8000-000000000001',
      commitId: 9,
      retainedCommits: 9,
      unresolvedCommits: 0,
      schemaVersion: 2,
      revisions,
      files: present.map(({ file, contents }) => ({
        file,
        commitId: 9,
        state: 'applied' as const,
        previousFingerprint: null,
        newFingerprint: (spec.diverged ?? []).includes(fileKey(file))
          ? sha(`${contents} `)
          : sha(contents),
      })),
      chains: files.map(({ file, contents }) => ({
        file,
        decisions: contents === null ? 0 : 1,
        startsAbsent: contents !== null,
        discontinuities: 0,
      })),
      resourceRevisionEligibility: 'unproven',
    },
  };
}

// --- One query on each side ----------------------------------------------------

type Query =
  | {
      operation: 'core.workspace.list';
      params: CanopyQueryParams<'core.workspace.list'>;
    }
  | {
      operation: 'core.workspace.get';
      params: CanopyQueryParams<'core.workspace.get'>;
    }
  | {
      operation: 'core.worktree.list';
      params: CanopyQueryParams<'core.worktree.list'>;
    }
  | {
      operation: 'core.worktree.get';
      params: CanopyQueryParams<'core.worktree.get'>;
    };

interface ResourceLabel {
  resource: unknown;
  completeness: 'complete' | 'partial';
  filters: readonly string[];
  external: readonly string[];
  eligibility: unknown;
}

/** Everything a query answered that the projection decides. */
type Answer =
  | {
      ok: true;
      /** Every page, a cursor replaced by whether it continues. */
      pages: unknown[];
      filters: readonly string[];
      resources: readonly ResourceLabel[];
      revisions: ReadonlyMap<string, number>;
    }
  | { ok: false; error: unknown };

function payloadOf(error: unknown): unknown {
  return error && typeof error === 'object' && 'payload' in error
    ? error.payload
    : error;
}

function present(filters: CoreWorkspaceFilters = []): SharedReadFilter[] {
  return Array.from(
    new Set(
      filters.filter(
        (filter): filter is SharedReadFilter => typeof filter === 'string',
      ),
    ),
  );
}

function nextCursor(page: unknown): string | null {
  const cursor: unknown =
    page && typeof page === 'object' ? Reflect.get(page, 'nextCursor') : null;
  return typeof cursor === 'string' ? cursor : null;
}

function withoutCursor(page: unknown): unknown {
  if (!page || typeof page !== 'object' || !('nextCursor' in page)) return page;
  return { ...page, nextCursor: page.nextCursor !== null };
}

async function allPages(
  first: unknown,
  next: (cursor: string) => Promise<unknown>,
): Promise<unknown[]> {
  const pages = [first];
  for (let cursor = nextCursor(first); cursor; ) {
    const page = await next(cursor);
    pages.push(page);
    cursor = nextCursor(page);
  }
  return pages.map(withoutCursor);
}

function desktopServices(capture: W5CaptureResult): CoreWorkspaceReadServices {
  return {
    readAllSidebarItems: () =>
      readAllSidebarItems({ persistRemovalCleanup: false }),
    readWorkspaceIndexEntry,
    readWorkspaceIndexEntryDetailed,
    readWorkspaceConfig,
    readWorkspaceConfigDetailed,
    readWorkspaceWorktrees: (workspaceId) =>
      readWorkspaceWorktrees(workspaceId, { persistRemovalCleanup: false }),
    readWorkspaceWorktreesDetailed: (workspaceId) =>
      readWorkspaceWorktreesDetailed(workspaceId, {
        persistRemovalCleanup: false,
      }),
    readEffectiveWorkspaceConfig,
    readAllSidebarItemsSnapshot: () =>
      readAllSidebarItemsSnapshot({ persistRemovalCleanup: false }),
    readView: (_request, work) =>
      work({ status: 'captured', capture, uncapturedReads: [] }),
  };
}

async function desktopAnswer(
  capture: W5CaptureResult,
  query: Query,
): Promise<Answer> {
  let detail: CoreWorkspaceReadDetail | undefined;
  const record = (_result: unknown, read?: CoreWorkspaceReadDetail): void => {
    detail ??= read;
  };
  const adapter = createCoreWorkspaceAdapter(
    desktopServices(capture),
    {
      captureSidebar: record,
      captureConfig: record,
      captureWorktrees: record,
      captureWorktree: record,
    },
    createCoreWorkspaceReadSnapshots(),
  );
  const context = { caller };
  const run = async (cursor?: string): Promise<unknown> => {
    switch (query.operation) {
      case 'core.workspace.list':
        return await adapter[query.operation](
          { ...query.params, cursor: cursor ?? query.params.cursor },
          context,
        );
      case 'core.worktree.list':
        return await adapter[query.operation](
          { ...query.params, cursor: cursor ?? query.params.cursor },
          context,
        );
      case 'core.workspace.get':
        return await adapter[query.operation](query.params, context);
      case 'core.worktree.get':
        return await adapter[query.operation](query.params, context);
    }
  };
  try {
    const pages = await allPages(await run(), run);
    const provenance = detail?.provenance;
    if (!provenance) throw new Error('The desktop read recorded no provenance');
    return {
      ok: true,
      pages,
      filters: provenance.result.filters,
      resources: provenance.resources,
      revisions: publishableRevisions(provenance),
    };
  } catch (error) {
    return { ok: false, error: payloadOf(error) };
  }
}

/** The shared projection's labels, classified against the same capture. */
function sharedLabels(
  capture: W5CaptureResult,
  projected: CoreWorkspaceProjected<unknown>,
): Pick<Extract<Answer, { ok: true }>, 'filters' | 'resources' | 'revisions'> {
  const resources = projected.resources.map(
    (projection: CoreWorkspaceResourceProjection): ResourceLabel => {
      const filters = present(projection.filters);
      const completeness = filters.length ? 'partial' : 'complete';
      return {
        resource: projection.resource,
        completeness,
        filters,
        external: projection.external ?? [],
        eligibility: classifyW5RevisionEligibility(
          capture,
          projection.resource,
          completeness,
        ),
      };
    },
  );
  const revisions = new Map<string, number>();
  for (const { resource, eligibility } of projected.resources.map(
    (projection, at) => ({
      resource: projection.resource,
      eligibility: classifyW5RevisionEligibility(
        capture,
        projection.resource,
        resources[at]?.completeness ?? 'partial',
      ),
    }),
  ))
    if (eligibility.status === 'eligible')
      revisions.set(coreWorkspaceResourceKey(resource), eligibility.revision);
  return { filters: present(projected.filters), resources, revisions };
}

type PinnedList = {
  operation: string;
  items: object[];
  collectionRevision?: number;
};

async function sharedAnswer(
  capture: W5CaptureResult,
  query: Query,
): Promise<Answer> {
  const reads = createW5CoreWorkspaceProjectionReads(
    createW5RecordImageReaders({
      root: getWorkspacesRootDir,
      store: { read: readNodeW5File },
    }),
  );
  const snapshots = createCoreReadSnapshotStore<PinnedList>();
  let labels: ReturnType<typeof sharedLabels> | undefined;
  const list = async (
    operation: 'core.workspace.list' | 'core.worktree.list',
    params: {
      scope?: CanopyQueryParams<'core.worktree.list'>['scope'];
      pageSize?: number;
    },
    cursor: string | undefined,
    project: (
      pageSize: number,
    ) => Promise<CoreWorkspaceProjected<CoreWorkspaceProjectedList<object>>>,
  ): Promise<unknown> => {
    const binding = listBinding(operation, params, caller);
    if (cursor !== undefined) {
      const page = snapshots.resume(cursor, binding);
      if (page.pinned.operation !== operation) throw differentListing();
      return listPage(
        page.pinned,
        page.offset,
        binding.pageSize,
        page.nextCursor,
      );
    }
    const projected = await project(binding.pageSize);
    labels = sharedLabels(capture, projected);
    const pinned: PinnedList = {
      operation,
      ...publishCoreWorkspaceList(projected.result, labels.revisions),
    };
    return listPage(
      pinned,
      0,
      binding.pageSize,
      snapshots.open(binding, pinned, pinned.items.length),
    );
  };
  const run = async (cursor?: string): Promise<unknown> => {
    switch (query.operation) {
      case 'core.workspace.list': {
        const { params } = query;
        checkCoreWorkspaceListParams(params, LOCAL_DESKTOP_AUTHORITY_ID);
        return list(query.operation, params, cursor ?? params.cursor, (size) =>
          projectCoreWorkspaceList(reads, params.scope, size),
        );
      }
      case 'core.worktree.list': {
        const { params } = query;
        checkCoreWorktreeListParams(params, LOCAL_DESKTOP_AUTHORITY_ID);
        return list(query.operation, params, cursor ?? params.cursor, (size) =>
          projectCoreWorktreeList(reads, params.scope, size),
        );
      }
      case 'core.workspace.get': {
        const { params } = query;
        checkCoreWorkspaceGetParams(params, LOCAL_DESKTOP_AUTHORITY_ID);
        const projected = await projectCoreWorkspaceGet(
          reads,
          params.workspaceId,
          params.scope,
        );
        labels = sharedLabels(capture, projected);
        return publishCoreWorkspaceItem(projected.result, labels.revisions);
      }
      case 'core.worktree.get': {
        const { params } = query;
        checkCoreWorktreeGetParams(params, LOCAL_DESKTOP_AUTHORITY_ID);
        const projected = await projectCoreWorktreeGet(
          reads,
          params.worktreeId,
          params.scope,
        );
        labels = sharedLabels(capture, projected);
        return publishCoreWorkspaceItem(projected.result, labels.revisions);
      }
    }
  };
  try {
    const pages = await allPages(await run(), run);
    if (!labels) throw new Error('The shared read recorded no labels');
    return { ok: true, pages, ...labels };
  } catch (error) {
    return { ok: false, error: payloadOf(error) };
  }
}

async function expectSameAnswers(
  capture: W5CaptureResult,
  queries: readonly Query[],
): Promise<Answer[]> {
  const answers: Answer[] = [];
  for (const query of queries) {
    const desktop = await desktopAnswer(capture, query);
    const shared = await sharedAnswer(capture, query);
    expect({ query, answer: shared }).toEqual({ query, answer: desktop });
    answers.push(shared);
  }
  return answers;
}

/** Every query the fixture's ids reach, scoped and unscoped. */
function queriesFor(spec: {
  workspaceIds: readonly string[];
  worktrees: readonly { workspaceId: string; worktreeId: string }[];
}): Query[] {
  const { workspaceIds, worktrees } = spec;
  return [
    { operation: 'core.workspace.list', params: {} },
    { operation: 'core.workspace.list', params: { pageSize: 2 } },
    {
      operation: 'core.workspace.list',
      params: { scope: { organizationId: ORG } },
    },
    ...workspaceIds.map(
      (workspaceId): Query => ({
        operation: 'core.workspace.list',
        params: { scope: { workspaceId } },
      }),
    ),
    ...[...workspaceIds, 'missing'].flatMap((workspaceId): Query[] => [
      { operation: 'core.workspace.get', params: { workspaceId } },
      {
        operation: 'core.workspace.get',
        params: { workspaceId, scope: { organizationId: ORG } },
      },
      { operation: 'core.worktree.list', params: { scope: { workspaceId } } },
      {
        operation: 'core.worktree.list',
        params: { scope: { workspaceId, organizationId: ORG }, pageSize: 1 },
      },
    ]),
    { operation: 'core.worktree.list', params: {} },
    { operation: 'core.worktree.list', params: { pageSize: 1 } },
    {
      operation: 'core.worktree.list',
      params: { scope: { organizationId: ORG } },
    },
    ...[
      ...worktrees,
      { workspaceId: workspaceIds[0] ?? 'x', worktreeId: 'missing' },
    ].flatMap(({ workspaceId, worktreeId }): Query[] => [
      { operation: 'core.worktree.get', params: { worktreeId } },
      {
        operation: 'core.worktree.get',
        params: { worktreeId, scope: { workspaceId } },
      },
      {
        operation: 'core.worktree.get',
        params: { worktreeId, scope: { workspaceId, organizationId: ORG } },
      },
      {
        operation: 'core.worktree.list',
        params: { scope: { workspaceId, worktreeId } },
      },
    ]),
  ];
}

const row = (
  id: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> & { createdAt: string } => ({
  id,
  branchName: `branch-${id}`,
  createdAt: '2026-09-01T00:00:00Z',
  ...extra,
});

const entry = (
  id: string,
  type: 'single-repo' | 'multi-repo' | 'cowork',
  order: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  name: `Project ${id}`,
  type,
  color: '#7C3AED',
  order,
  ...extra,
});

beforeAll(() => {
  // The desktop source read resolves git, which starts a login-shell PATH
  // probe whose stdio pipes outlive the suite; don't run the user's shell.
  setLoginShellProbe(() => Promise.resolve(undefined));
});

beforeEach(() => {
  __resetSidebarItemsStateForTests();
});

afterAll(() => {
  setLoginShellProbe(undefined);
  rmSync(getWorkspacesRootDir(), { recursive: true, force: true });
});

// --- Equivalence ---------------------------------------------------------------

describe('the shared projection answers as the desktop adapter (CAN-7239)', () => {
  test('both hosts read one activity section vocabulary', () => {
    expect(FILTERS_AGREE).toBe(true);
    expect([...CORE_WORKSPACE_ACTIVITY_SECTION_IDS].sort()).toEqual(
      [...DEFAULT_ACTIVITY_SECTION_ORDER].sort(),
    );
  });

  test.each([
    ['absent', null],
    ['unreadable', UNREADABLE],
    ['the wrong version', JSON.stringify({ version: 2, workspaces: [] })],
  ] as const)('an index that is %s', async (_name, index) => {
    const capture = writeRoot({
      index,
      manifests: { a: { version: 1, type: 'multi-repo', repos: [] } },
      worktrees: { a: [row('wt-1')] },
    });
    await expectSameAnswers(
      capture,
      queriesFor({
        workspaceIds: ['a'],
        worktrees: [{ workspaceId: 'a', worktreeId: 'wt-1' }],
      }),
    );
  });

  test('a partial index, a duplicate id and every workspace kind', async () => {
    const capture = writeRoot({
      index: [
        entry('multi', 'multi-repo', 4, {
          pinned: true,
          collapsed: true,
          activitySectionOrder: ['plans', 'summary', 'plans'],
        }),
        entry('single', 'single-repo', 1, { color: '#3B82F6' }),
        entry('relative', 'single-repo', 2),
        entry('no-path', 'single-repo', 3),
        entry('cowork', 'cowork', 0, { activitySectionOrder: ['notes'] }),
        entry('cowork-broken', 'cowork', 5),
        entry('code-broken', 'multi-repo', 6),
        entry('dup', 'multi-repo', 7, { color: 'not-a-color' }),
        entry('dup', 'multi-repo', 8, { collapsed: true }),
        entry('no-manifest', 'multi-repo', 9),
        // Unreadable entries: no color, and an unknown type.
        { id: 'colorless', name: 'Colorless', type: 'multi-repo', order: 10 },
        { id: 'unknown', name: 'Unknown', type: 'mystery', color: '#7C3AED' },
      ],
      manifests: {
        multi: {
          version: 1,
          type: 'multi-repo',
          itemSortMode: 'last-updated',
          alwaysShow: false,
          startPage: { kind: 'file', path: 'docs/start.md' },
          owner: owner(ORG),
          repos: [
            {
              id: 'web',
              name: 'web',
              repoPath: '/nonexistent/web',
              manifestUrl: 'https://user:secret@example.com/web.git?x=1#y',
            },
            {
              id: 'api',
              name: 'api',
              repoPath: '/nonexistent/api',
              manifestUrl: 'git@example.com:team/api.git',
            },
            {
              id: 'local',
              name: 'local',
              repoPath: '/nonexistent/local',
              manifestUrl: '/Users/alice/local',
            },
            { id: 'no-name', repoPath: '/nonexistent/no-name' },
          ],
        },
        single: {
          version: 1,
          type: 'single-repo',
          repoPath: '/nonexistent/single',
          startPage: null,
          owner: owner(OTHER_ORG),
          repos: [
            {
              id: 'single-repo',
              name: 'single',
              repoPath: '/nonexistent/single',
              manifestUrl: 'https://example.com/single.git',
            },
          ],
        },
        relative: {
          version: 1,
          type: 'single-repo',
          repoPath: 'relative/path',
        },
        'no-path': { version: 1, type: 'single-repo' },
        cowork: {
          version: 1,
          type: 'cowork',
          alwaysShow: true,
          owner: owner(ORG),
        },
        'cowork-broken': UNREADABLE,
        'code-broken': UNREADABLE,
        dup: {
          version: 1,
          type: 'multi-repo',
          temporary: true,
          itemSortMode: 'sideways',
          startPage: { kind: 'file', path: '/etc/passwd' },
          owner: { type: 'organization', organizationId: 'not-a-uuid' },
        },
      },
      worktrees: {
        multi: [
          row('wt-1', { label: 'Feature one', trackedBaseBranch: 'main' }),
          row('wt-2', { setupPhase: 'git-pending' }),
          row('wt-3', { healthIssue: { status: 'broken' } }),
          { id: 'half-row', branchName: 'x' },
        ],
        single: [row('wt-1'), row('wt-4', { label: '' })],
        'code-broken': [row('wt-5')],
        dup: [row('wt-6')],
        'no-manifest': UNREADABLE,
      },
      withoutRevision: ['workspace:single'],
      diverged: ['manifest:cowork'],
    });
    const answers = await expectSameAnswers(
      capture,
      queriesFor({
        workspaceIds: [
          'multi',
          'single',
          'relative',
          'no-path',
          'cowork',
          'cowork-broken',
          'code-broken',
          'dup',
          'no-manifest',
          'colorless',
        ],
        worktrees: [
          { workspaceId: 'multi', worktreeId: 'wt-1' },
          { workspaceId: 'multi', worktreeId: 'wt-2' },
          { workspaceId: 'multi', worktreeId: 'wt-3' },
          { workspaceId: 'multi', worktreeId: 'half-row' },
          { workspaceId: 'single', worktreeId: 'wt-1' },
          { workspaceId: 'single', worktreeId: 'wt-4' },
          { workspaceId: 'code-broken', worktreeId: 'wt-5' },
          { workspaceId: 'dup', worktreeId: 'wt-6' },
        ],
      }),
    );
    // The fixture reaches the rules it is for, not only refusals.
    const filters = new Set(
      answers.flatMap((answer) => (answer.ok ? answer.filters : [])),
    );
    expect([...filters].sort()).toEqual(
      [
        'fallback',
        'organization',
        'page',
        'unprojected',
        'unreadable-entries',
        'workspace-scope',
        'worktree-scope',
      ].sort(),
    );
    const eligibility = new Set(
      answers.flatMap((answer) =>
        answer.ok
          ? answer.resources.map(({ eligibility }) =>
              JSON.stringify(eligibility),
            )
          : [],
      ),
    );
    expect([...eligibility].some((label) => label.includes('eligible'))).toBe(
      true,
    );
    expect(
      [...eligibility].filter((label) => label.includes('"reason"')).length,
    ).toBeGreaterThan(2);
  });

  test('a multi-repo source overlay is the external field only', async () => {
    const capture = writeRoot({
      index: [
        entry('overlay', 'multi-repo', 0),
        entry('plain', 'multi-repo', 1),
      ],
      manifests: {
        overlay: {
          version: 1,
          type: 'multi-repo',
          sourceRepoPath: join(getWorkspacesRootDir(), '..', 'no-source'),
          repos: [
            {
              id: 'web',
              name: 'web',
              repoPath: '/nonexistent/web',
              manifestUrl: 'https://example.com/web.git',
            },
          ],
        },
        plain: { version: 1, type: 'multi-repo', sourceRepoPath: '' },
      },
    });
    const [listed] = await expectSameAnswers(capture, [
      { operation: 'core.workspace.list', params: {} },
      { operation: 'core.workspace.get', params: { workspaceId: 'overlay' } },
      { operation: 'core.workspace.get', params: { workspaceId: 'plain' } },
    ]);
    expect(
      listed?.ok && listed.resources.map(({ external }) => external),
    ).toEqual([[], ['repositorySources'], []]);
  });

  // List and get decide repositories, external fields and owner from
  // different reads: the index entry's type for a listing, the manifest's
  // own type for a get.
  test('index and manifest types that disagree, repeated ids and edge values', async () => {
    const repo = (
      id: string,
      manifestUrl: unknown,
    ): Record<string, unknown> => ({
      id,
      name: id,
      repoPath: `/nonexistent/${id}`,
      manifestUrl,
    });
    const capture = writeRoot({
      index: [
        entry('cowork-multi', 'cowork', 0),
        entry('single-multi', 'single-repo', 1),
        entry('multi-single', 'multi-repo', 2),
        entry('untyped', 'single-repo', 3),
        entry('twice', 'single-repo', 4),
        entry('twice', 'multi-repo', 5, { pinned: true }),
        entry('edge', 'multi-repo', 6, {
          activitySectionOrder: ['plans', 'bogus'],
          pinned: 'yes',
        }),
        entry('cowork-edge', 'cowork', 7),
      ],
      manifests: {
        'cowork-multi': {
          version: 1,
          type: 'multi-repo',
          sourceRepoPath: '/nonexistent/source',
          temporary: true,
          startPage: { kind: 'file', path: 'docs/start.md' },
          owner: owner(ORG),
          repos: [repo('r1', 'https://example.com/r1.git')],
        },
        'single-multi': {
          version: 1,
          type: 'multi-repo',
          repoPath: '/nonexistent/single-multi',
          sourceRepoPath: '/nonexistent/source',
          temporary: true,
          owner: owner(ORG),
          repos: [repo('r2', 'https://example.com/r2.git')],
        },
        'multi-single': {
          version: 1,
          type: 'single-repo',
          repoPath: '/nonexistent/multi-single',
          sourceRepoPath: '/nonexistent/source',
          temporary: true,
          repos: [repo('r3', 'https://example.com/r3.git')],
        },
        untyped: { version: 1, repoPath: '/nonexistent/untyped' },
        // An upper-case owner reads lower-cased, so it matches ORG.
        twice: {
          version: 1,
          type: 'multi-repo',
          owner: { ...owner(ORG), organizationId: ORG.toUpperCase() },
        },
        edge: {
          version: 1,
          type: 'multi-repo',
          temporary: 'yes',
          alwaysShow: 'true',
          itemSortMode: null,
          startPage: 'docs/start.md',
          repos: [
            repo('padded', '  https://example.com/padded.git  '),
            repo('ssh', 'ssh://git@example.com/ssh.git'),
            repo('file', 'file:///nonexistent/file'),
            repo('not-git-user', 'bob@example.com:team/x.git'),
            repo('numeric', 7),
            {
              id: 'nameless',
              repoPath: '/x',
              manifestUrl: 'https://a.example',
            },
            'not-a-repository',
          ],
        },
        'cowork-edge': {
          version: 1,
          type: 'cowork',
          temporary: true,
          alwaysShow: false,
          itemSortMode: 'last-updated',
          startPage: { kind: 'file', path: 'docs/start.md' },
          owner: 'not-an-owner',
        },
      },
      worktrees: {
        'cowork-multi': [row('wt-cowork')],
        'single-multi': [row('wt-single')],
        'multi-single': [row('wt-multi')],
        twice: [row('wt-twice'), row('wt-twice', { label: 'repeated row' })],
        edge: [
          row('label-empty', { label: '' }),
          row('label-null', { label: null }),
          row('label-zero', { label: 0 }),
          row('phase-ready', { setupPhase: 'git-ready' }),
          row('phase-other', { setupPhase: 'other' }),
          row('health-null', { healthIssue: null }),
          row('health-empty', { healthIssue: {} }),
          row('pending-and-unhealthy', {
            setupPhase: 'git-pending',
            healthIssue: { status: 'broken' },
          }),
          row('base-empty', { trackedBaseBranch: '' }),
        ],
      },
    });
    await expectSameAnswers(
      capture,
      queriesFor({
        workspaceIds: [
          'cowork-multi',
          'single-multi',
          'multi-single',
          'untyped',
          'twice',
          'edge',
          'cowork-edge',
        ],
        worktrees: [
          { workspaceId: 'cowork-multi', worktreeId: 'wt-cowork' },
          { workspaceId: 'single-multi', worktreeId: 'wt-single' },
          { workspaceId: 'multi-single', worktreeId: 'wt-multi' },
          { workspaceId: 'twice', worktreeId: 'wt-twice' },
          ...[
            'label-empty',
            'label-null',
            'label-zero',
            'phase-ready',
            'phase-other',
            'health-null',
            'health-empty',
            'pending-and-unhealthy',
            'base-empty',
          ].map((worktreeId) => ({ workspaceId: 'edge', worktreeId })),
        ],
      }),
    );
  });

  test.each([99, 100, 101, 107])(
    '%i rows: every page, filter and revision agrees',
    async (rows) => {
      const ids = Array.from({ length: rows }, (_, at) => `ws-${at + 1}`);
      const capture = writeRoot({
        index: ids.map((id, at) => entry(id, 'multi-repo', at)),
        manifests: Object.fromEntries(
          ids.map((id, at) => [
            id,
            {
              version: 1,
              type: 'multi-repo',
              ...(at % 3 === 0 && { owner: owner(ORG) }),
              repos: [
                {
                  id: `${id}-repo`,
                  name: id,
                  repoPath: '/nonexistent/repo',
                  manifestUrl: `https://example.com/${id}.git`,
                },
              ],
            },
          ]),
        ),
        worktrees: {
          'ws-1': ids.map((_, at) => row(`wt-${at + 1}`)),
          'ws-4': [row('wt-1')],
        },
        withoutRevision: ['workspace:ws-2'],
        diverged: ids
          .filter((_, at) => at % 7 === 6)
          .map((id) => `manifest:${id}`),
      });
      await expectSameAnswers(capture, [
        { operation: 'core.workspace.list', params: {} },
        { operation: 'core.workspace.list', params: { pageSize: 7 } },
        {
          operation: 'core.workspace.list',
          params: { scope: { organizationId: ORG } },
        },
        { operation: 'core.worktree.list', params: {} },
        { operation: 'core.worktree.list', params: { pageSize: 13 } },
        {
          operation: 'core.worktree.list',
          params: { scope: { workspaceId: 'ws-1' } },
        },
        {
          operation: 'core.worktree.list',
          params: { scope: { organizationId: ORG }, pageSize: 50 },
        },
        { operation: 'core.worktree.get', params: { worktreeId: 'wt-1' } },
        {
          operation: 'core.worktree.get',
          params: { worktreeId: `wt-${rows}` },
        },
        { operation: 'core.workspace.get', params: { workspaceId: 'ws-2' } },
        { operation: 'core.workspace.get', params: { workspaceId: 'ws-7' } },
        {
          operation: 'core.workspace.get',
          params: { workspaceId: `ws-${rows}` },
        },
      ]);
    },
  );

  test('scope checks and cursor refusals agree before any read', async () => {
    const capture = writeRoot({
      index: [entry('a', 'multi-repo', 0)],
      manifests: { a: { version: 1, type: 'multi-repo' } },
      worktrees: { a: [row('wt-1'), row('wt-2')] },
    });
    await expectSameAnswers(capture, [
      {
        operation: 'core.workspace.list',
        params: { scope: { authorityId: 'elsewhere' } },
      },
      {
        operation: 'core.workspace.list',
        params: { scope: { targetId: 'remote' } },
      },
      {
        operation: 'core.workspace.list',
        params: { scope: { worktreeId: 'wt-1' } },
      },
      {
        operation: 'core.workspace.list',
        params: { scope: { workspaceId: '/abs/a' } },
      },
      { operation: 'core.workspace.list', params: { cursor: 'A'.repeat(32) } },
      { operation: 'core.workspace.get', params: { workspaceId: 'C:\\a' } },
      {
        operation: 'core.workspace.get',
        params: { workspaceId: 'a', scope: { workspaceId: 'b' } },
      },
      {
        operation: 'core.workspace.get',
        params: { workspaceId: 'a', scope: { repoId: 'r' } },
      },
      {
        operation: 'core.worktree.list',
        params: { scope: { workspaceId: '..' } },
      },
      { operation: 'core.worktree.list', params: { scope: { chatId: 'c' } } },
      { operation: 'core.worktree.list', params: { cursor: 'not-a-cursor' } },
      {
        operation: 'core.worktree.get',
        params: { worktreeId: 'wt-1', scope: { workspaceId: 'a/b' } },
      },
      {
        operation: 'core.worktree.get',
        params: { worktreeId: 'wt-1', scope: { worktreeId: 'wt-2' } },
      },
      {
        operation: 'core.worktree.get',
        params: { worktreeId: 'wt-1', scope: { operationId: 'o' } },
      },
    ]);
  });
});

// --- Declared divergences ------------------------------------------------------

/*
 * What only Electron main decides, so the W5-only projection cannot match:
 * - RR1 tombstones: rows this process removed (`recently-removed`);
 * - the source overlay: repositories a source checkout's config contributes
 *   (`external`), and an overlay read that fails, which leaves the workspace
 *   out of a listing (`unprojected`) and fails its get;
 * - workspaces whose checkout script or hook resolution fails, which the
 *   desktop leaves out of a listing (`unprojected`);
 * - worktree row fields of the wrong JSON type, which the desktop projects
 *   raw for its dispatcher to refuse, and the W5 read leaves unset;
 * - manifests the desktop config normalizers reject (`unprojected`, or
 *   `fallback` for Cowork), and a failed Cowork work-entry read. These need
 *   host failures the fixture root cannot produce (the work-entry read
 *   already falls back to no entries), so they have no test here.
 * The tests below pin the first four, so a change to either side is seen.
 */
describe('declared desktop-only divergences', () => {
  async function both(
    capture: W5CaptureResult,
    query: Query,
  ): Promise<{ desktop: Answer; shared: Answer }> {
    return {
      desktop: await desktopAnswer(capture, query),
      shared: await sharedAnswer(capture, query),
    };
  }

  function field(value: unknown, key: string): unknown {
    const found: unknown =
      value && typeof value === 'object' ? Reflect.get(value, key) : undefined;
    return found;
  }

  function pageItems(answer: Answer): unknown[] {
    const items = answer.ok ? field(answer.pages[0], 'items') : undefined;
    return Array.isArray(items) ? items.map((item: unknown) => item) : [];
  }

  test('a tombstoned row is filtered on desktop only', async () => {
    const capture = writeRoot({
      index: [entry('tombstoned', 'multi-repo', 0)],
      manifests: { tombstoned: { version: 1, type: 'multi-repo' } },
      worktrees: { tombstoned: [row('wt-1'), row('wt-gone')] },
    });
    markWorkspaceWorktreeRecentlyRemoved(
      'tombstoned',
      'wt-gone',
      row('wt-gone').createdAt,
    );
    const { desktop, shared } = await both(capture, {
      operation: 'core.worktree.list',
      params: { scope: { workspaceId: 'tombstoned' } },
    });
    expect(desktop.ok && desktop.filters).toEqual(['recently-removed']);
    expect(shared.ok && shared.filters).toEqual([]);
    expect(pageItems(desktop)).toHaveLength(1);
    expect(pageItems(shared)).toEqual([
      ...pageItems(desktop),
      expect.objectContaining({ worktreeId: 'wt-gone' }),
    ]);
  });

  test('a source overlay contributes repositories, or leaves a workspace out, on desktop only', async () => {
    const source = join(getWorkspacesRootDir(), '..', 'overlay-source');
    const capture = writeRoot({
      index: [entry('overlay', 'multi-repo', 0)],
      manifests: {
        overlay: {
          version: 1,
          type: 'multi-repo',
          sourceRepoPath: source,
          repos: [
            {
              id: 'web',
              name: 'web',
              repoPath: '/nonexistent/web',
              manifestUrl: 'https://example.com/stored.git',
            },
          ],
        },
      },
    });
    rmSync(source, { recursive: true, force: true });
    mkdirSync(source, { recursive: true });
    const config = getPrimaryProjectConfigFilePath(source);
    writeFileSync(
      config,
      JSON.stringify({
        version: 1,
        repos: [
          { id: 'web', name: 'web', url: 'https://example.com/overlay.git' },
        ],
      }),
    );
    const get: Query = {
      operation: 'core.workspace.get',
      params: { workspaceId: 'overlay' },
    };
    const overlaid = await both(capture, get);
    const sources = (answer: Answer): unknown =>
      answer.ok ? field(answer.pages[0], 'repositorySources') : undefined;
    expect(sources(overlaid.desktop)).toEqual([
      { repoId: 'web', remoteUrl: 'https://example.com/overlay.git' },
    ]);
    expect(sources(overlaid.shared)).toEqual([
      { repoId: 'web', remoteUrl: 'https://example.com/stored.git' },
    ]);
    // The external field keeps the revision either way (decision B1).
    expect(overlaid.shared.ok && overlaid.shared.resources).toEqual(
      overlaid.desktop.ok && overlaid.desktop.resources,
    );

    writeFileSync(config, '{ not json');
    const listed = await both(capture, {
      operation: 'core.workspace.list',
      params: {},
    });
    expect(listed.desktop.ok && listed.desktop.filters).toEqual([
      'unprojected',
    ]);
    expect(pageItems(listed.desktop)).toEqual([]);
    expect(listed.shared.ok && listed.shared.filters).toEqual([]);
    expect(pageItems(listed.shared)).toEqual([
      expect.objectContaining({ workspaceId: 'overlay' }),
    ]);
    // The desktop get surfaces the overlay's own read failure.
    const failed = await both(capture, get);
    expect(failed.desktop).toMatchObject({
      ok: false,
      error: { name: 'InvalidCanopyJsonError' },
    });
    expect(failed.shared).toEqual(overlaid.shared);
    rmSync(source, { recursive: true, force: true });
  });

  test('a checkout whose scripts and hooks cannot resolve leaves its workspace out on desktop only', async () => {
    const checkout = join(getWorkspacesRootDir(), '..', 'broken-checkout');
    rmSync(checkout, { recursive: true, force: true });
    mkdirSync(checkout, { recursive: true });
    writeFileSync(getPrimaryProjectConfigFilePath(checkout), '{ not json');
    // The single-repo resolves its project scripts and hooks from the
    // checkout, the multi-repo its repository's hooks.
    const capture = writeRoot({
      index: [
        entry('single', 'single-repo', 0),
        entry('multi', 'multi-repo', 1),
      ],
      manifests: {
        single: { version: 1, type: 'single-repo', repoPath: checkout },
        multi: {
          version: 1,
          type: 'multi-repo',
          repos: [{ id: 'web', name: 'web', repoPath: checkout }],
        },
      },
      worktrees: { single: [row('wt-1')], multi: [row('wt-2')] },
    });
    for (const operation of [
      'core.workspace.list',
      'core.worktree.list',
    ] as const) {
      const { desktop, shared } = await both(capture, {
        operation,
        params: {},
      });
      expect(desktop.ok && desktop.filters).toEqual(['unprojected']);
      expect(pageItems(desktop)).toEqual([]);
      expect(shared.ok && shared.filters).toEqual([]);
      expect(pageItems(shared)).toHaveLength(2);
    }
    // A get resolves neither, so both hosts answer it alike.
    for (const workspaceId of ['single', 'multi']) {
      const { desktop, shared } = await both(capture, {
        operation: 'core.workspace.get',
        params: { workspaceId },
      });
      expect(desktop.ok).toBe(true);
      expect(shared).toEqual(desktop);
    }
    rmSync(checkout, { recursive: true, force: true });
  });

  test('a row field of the wrong JSON type is projected raw on desktop only', async () => {
    const capture = writeRoot({
      index: [entry('typed', 'multi-repo', 0)],
      manifests: { typed: { version: 1, type: 'multi-repo' } },
      worktrees: { typed: [row('wt-1', { label: 7, trackedBaseBranch: 3 })] },
    });
    const { desktop, shared } = await both(capture, {
      operation: 'core.worktree.get',
      params: { worktreeId: 'wt-1' },
    });
    expect(desktop.ok && desktop.pages[0]).toMatchObject({
      name: 7,
      baseBranch: 3,
    });
    expect(shared.ok && shared.pages[0]).toMatchObject({
      name: 'branch-wt-1',
      baseBranch: null,
    });
  });
});
