import { installRoutedW5GoldenStore } from '../../lib/__tests__/fixtures/w5-routed-golden-store';
import * as paths from 'node:path';
import {
  createFilesystemScopeResolver,
  readFilesystemScope,
  readNativeRootIdentity,
} from '@canopy/core-runtime/node';
import { CANOPY_IN_PROCESS_WORKER_TARGET_ID } from '@canopy/protocol/canopy-core';
import { getFileBrowserRoots } from '../../lib/file-browser-roots';
/**
 * CAN-5501 rule: captured on the unchanged Files route before its eligibility
 * check moved into the shared read-route guard. Live `file-tree:roots` and
 * `file-tree:directory` reads (`worker.filesystem.roots.list` and
 * `worker.filesystem.directory.list`) must stay byte-identical: legacy and canonical results, typed
 * failures, route counters and the evidence journal, for both backends and
 * both entry-name rule sets. Roots and directory are eligible on every
 * platform's table row, so the golden does not depend on the test host.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import type {
  CanopyCallerDescriptor,
  CanopyWorkspaceScope,
} from '@canopy/protocol/canopy-core';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/protocol/ui-labels';
import {
  evaluateReadRoute,
  READ_ROUTE_PREREQUISITES,
  READ_ROUTE_TABLE,
  type GitReadRouteOperation,
  type ReadRouteInput,
} from '../daemon-read-route-guard';
import {
  AUTHORITY,
  bridgeCaller,
  localCaller,
  createRouteHarness,
  FakeSender,
  type RouteHarness,
  type RouteHarnessOptions,
} from './daemon-files-route-harness';

const SINGLE = { workspaceId: 'single', worktreeId: 'task' };
const MULTI = { workspaceId: 'multi', worktreeId: 'task' };
const COWORK_HOME = { workspaceId: 'cowork', worktreeId: 'home' };

const DIRECTORIES: ReadonlyArray<
  readonly [CanopyWorkspaceScope, string, string]
> = [
  [SINGLE, 'single', ''],
  [SINGLE, 'single', 'src'],
  [SINGLE, 'single', './'],
  [SINGLE, 'attachments', ''],
  [SINGLE, 'missing', ''],
  [MULTI, WORKSPACE_ROOT_REPO_ID, ''],
  [MULTI, 'api', ''],
  [COWORK_HOME, 'workspace', ''],
];

const ROOTS: readonly CanopyWorkspaceScope[] = [
  SINGLE,
  MULTI,
  COWORK_HOME,
  { workspaceId: 'never-seen', worktreeId: 'task' },
  // Ineligible on every platform: a foreign selector and an excluded scope.
  { ...SINGLE, repoId: 'single' },
  { workspaceId: APP_ADVISOR_PROJECT_ID, worktreeId: 'task' },
];

let h: RouteHarness | undefined;
let closeW5Store: (() => Promise<void>) | undefined;

afterEach(async () => {
  try {
    await closeW5Store?.();
    closeW5Store = undefined;
    await h?.close();
  } finally {
    h = undefined;
    jest.restoreAllMocks();
  }
});

/**
 * One line of exact JSON per fact; random temp paths and the
 * data-root-derived revision become placeholders.
 */
function line(harness: RouteHarness, label: string, value: unknown): string {
  const json = JSON.stringify(value)
    .split(harness.base)
    .join('<base>')
    .replace(/"catalogRevision":"[0-9a-f]{64}"/g, '"catalogRevision":"<rev>"');
  return `${label} ${json}`;
}

async function outcome(read: Promise<unknown>): Promise<unknown> {
  try {
    return { ok: await read };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'payload' in error)
      return { failed: error.payload };
    return { threw: error instanceof Error ? error.message : String(error) };
  }
}

/** One serialized pass over every read, in a fixed order, with one sender. */
async function captureFilesRouteGolden(
  options: RouteHarnessOptions,
): Promise<string[]> {
  h = await createRouteHarness(options);
  const harness = h;
  resetWorkCounters();
  const sender = new FakeSender(1);
  const baseline = harness.route.observe().cursor;
  const golden: string[] = [];
  for (const scope of ROOTS)
    golden.push(
      line(
        harness,
        `roots ${JSON.stringify(scope)}`,
        await outcome(harness.roots(scope, sender)),
      ),
    );
  golden.push(
    line(
      harness,
      `roots-bridge ${JSON.stringify(SINGLE)}`,
      await outcome(
        harness.roots(SINGLE, sender, bridgeCaller(sender, 'controller-1')),
      ),
    ),
  );
  for (const [scope, rootId, relativePath] of DIRECTORIES)
    golden.push(
      line(
        harness,
        `directory ${JSON.stringify([scope, rootId, relativePath])}`,
        await outcome(harness.directory(scope, rootId, relativePath, sender)),
      ),
    );
  const { entries, ...evidence } = harness.route.observe(baseline);
  golden.push(
    line(harness, 'counters', snapshotWorkCounters().route),
    line(harness, 'evidence', { ...evidence, cursor: undefined }),
    ...entries.map((entry) => line(harness, 'event', entry)),
    line(harness, 'daemon', harness.daemon.names()),
    line(harness, 'direct', {
      roots: harness.direct.roots.mock.calls.length,
      directory: harness.direct.directory.mock.calls.length,
    }),
  );
  await harness.close();
  h = undefined;
  return golden;
}

// Each capture seeds a fresh harness and runs every read; one capture can
// exceed Jest's default 5 s on a loaded host.
const CAPTURE_TIMEOUT_MS = 30_000;

describe.each(['posix', 'win32'] as const)(
  'Files route golden (%s entry names)',
  (entryNamePlatform) => {
    it(
      'keeps roots and directory byte-identical on the eligible route',
      async () => {
        expect(
          await captureFilesRouteGolden({ entryNamePlatform }),
        ).toMatchSnapshot();
      },
      CAPTURE_TIMEOUT_MS,
    );
  },
);

// The golden above runs on the test host's own table row.
describe('Files route golden on an injected host', () => {
  let host: string[] = [];

  beforeAll(async () => {
    host = await captureFilesRouteGolden({});
  }, CAPTURE_TIMEOUT_MS);

  it.each(['darwin', 'win32', 'linux'] as const)(
    'keeps the golden on an injected %s host',
    async (platform) => {
      expect(host).not.toHaveLength(0);
      expect(await captureFilesRouteGolden({ platform })).toEqual(host);
    },
    CAPTURE_TIMEOUT_MS,
  );
});

it('worker.git.merge makes no daemon contact, even with Files routing available (CAN-5884)', async () => {
  h = await createRouteHarness({});
  await expect(
    h.runtime.instruction(
      'worker.git.merge',
      {
        scope: SINGLE,
        sourceBranch: 'task',
        baseBranch: 'main',
      },
      {
        caller: {
          principalId: 'local-desktop-user',
          clientInstanceId: 'electron-web-contents:1',
          authorityId: 'local-desktop',
          interfaceKind: 'desktop',
          grants: ['worker.git.write'],
        },
      },
    ),
  ).rejects.toBeDefined();
  expect(h.daemon.names()).toEqual([]);
  expect(h.connectionsFactory).not.toHaveBeenCalled();
  expect(h.hostContext).not.toHaveBeenCalled();
});

it.each([
  {
    principalId: 'local-desktop-renderer:1',
    interfaceKind: 'desktop' as const,
  },
  { principalId: 'local-desktop-user', interfaceKind: 'portal' as const },
])(
  'refuses non-IPC merge caller %o before any daemon contact',
  async (refused) => {
    h = await createRouteHarness({});
    await expect(
      h.runtime.instruction(
        'worker.git.merge',
        {
          scope: SINGLE,
          sourceBranch: 'task',
          baseBranch: 'main',
        },
        {
          caller: {
            ...refused,
            clientInstanceId: 'test',
            authorityId: 'local-desktop',
            grants: ['worker.git.write'],
          },
        },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.git.merge.callerRefused' },
    });
    expect(h.connectionsFactory).not.toHaveBeenCalled();
  },
);

it(
  'keeps explorer creates and text saves in process with zero daemon connection contact',
  async () => {
    h = await createRouteHarness();
    closeW5Store = await installRoutedW5GoldenStore();
    const as = localCaller(new FakeSender(1));
    const caller: CanopyCallerDescriptor = {
      ...as,
      grants: [...as.grants, 'worker.filesystem.write'],
    };
    for (const operation of ['create-directory', 'create-file'] as const) {
      await h.runtime.createFileTreeEntryForLegacyIpc(
        {
          operation,
          projectId: 'single',
          worktreeId: 'task',
          target: {
            repoId: 'single',
            relativePath:
              operation === 'create-directory'
                ? 'local-parent'
                : 'local-parent/created.txt',
          },
        },
        { caller },
      );
    }
    const realPath = join(
      h.dataRoot,
      'workspaces/single/worktrees/task/local-parent/created.txt',
    );
    const before = await stat(realPath);
    await expect(
      h.runtime.saveTextFileForLegacyIpc(
        {
          projectId: 'single',
          worktreeId: 'task',
          realPath,
          content: 'local save',
          expectedVersion: `${before.size}:${Math.round(before.mtimeMs)}`,
        },
        { caller },
      ),
    ).resolves.toBe('written');
    expect(await readFile(realPath, 'utf8')).toBe('local save');
    expect(h.hostContext).not.toHaveBeenCalled();
    expect(h.connectionsFactory).not.toHaveBeenCalled();
    expect(h.connections.gets).toEqual([]);
    expect(h.daemon.names()).toEqual([]);
  },
  CAPTURE_TIMEOUT_MS,
);

it('entry mutations stay in process with zero daemon contact, including ENOTDIR refusals', async () => {
  h = await createRouteHarness();
  const caller: CanopyCallerDescriptor = {
    ...localCaller(new FakeSender(1)),
    grants: ['worker.filesystem.read', 'worker.filesystem.write'],
  };
  const common = {
    scope: SINGLE,
    sourceFileRootId: 'single',
    destinationFileRootId: 'single',
    expectedSourceVersion: null,
    conflictPolicy: 'error' as const,
  };
  await h.runtime.instruction(
    'worker.filesystem.entry.copy',
    {
      ...common,
      sourceRelativePath: 'b.txt',
      destinationRelativePath: 'copied',
      _meta: { idempotencyKey: 'copy' },
    },
    { caller, metadata: { idempotencyKey: 'copy' } },
  );
  await h.runtime.instruction(
    'worker.filesystem.entry.move',
    {
      ...common,
      fromRelativePath: 'copied',
      toRelativePath: 'moved',
      expectedDestinationAbsent: true,
      _meta: { idempotencyKey: 'move' },
    },
    { caller, metadata: { idempotencyKey: 'move' } },
  );
  await h.runtime.instruction(
    'worker.filesystem.entry.delete',
    {
      scope: SINGLE,
      fileRootId: 'single',
      relativePath: 'moved',
      expectedVersion: null,
      recursive: true,
      disposition: 'permanent',
      _meta: { idempotencyKey: 'delete' },
    },
    { caller, metadata: { idempotencyKey: 'delete' } },
  );
  // The shared engine reads the invalid parent before its exclusion guards.
  await expect(
    h.runtime.instruction(
      'worker.filesystem.entry.copy',
      {
        ...common,
        sourceRelativePath: 'b.txt',
        destinationRelativePath: 'A.txt/target',
        _meta: { idempotencyKey: 'copy-enotdir' },
      },
      { caller, metadata: { idempotencyKey: 'copy-enotdir' } },
    ),
  ).rejects.toMatchObject({
    payload: { kind: 'internal', retry: { kind: 'never' } },
  });
  await expect(
    h.runtime.instruction(
      'worker.filesystem.entry.move',
      {
        ...common,
        fromRelativePath: 'b.txt',
        toRelativePath: 'A.txt/target',
        expectedDestinationAbsent: true,
        _meta: { idempotencyKey: 'move-enotdir' },
      },
      { caller, metadata: { idempotencyKey: 'move-enotdir' } },
    ),
  ).rejects.toMatchObject({
    payload: { kind: 'internal', retry: { kind: 'never' } },
  });
  expect(h.connectionsFactory).not.toHaveBeenCalled();
  expect(h.daemon.names()).toEqual([]);
});

it('record-based daemon roots have the desktop exclusion catalog for every workspace type', async () => {
  h = await createRouteHarness();
  const resolveScope = await createFilesystemScopeResolver({
    canonicalDataRoot: h.dataRoot,
    authorityId: AUTHORITY,
    targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
    coworkManagedDirName: '.canopy',
    paths,
    rootIdentity: readNativeRootIdentity,
  });
  for (const scope of [SINGLE, MULTI, COWORK_HOME]) {
    const desktop = await getFileBrowserRoots(
      scope.workspaceId,
      scope.worktreeId,
    );
    const daemon = await readFilesystemScope(
      scope,
      await resolveScope(scope, 'roots'),
    );
    const canonical = (path: string): string =>
      path.replace(h?.displayRoot ?? '', h?.dataRoot ?? '');
    expect(
      daemon.roots.map((root) => ({
        id: root.id,
        absolutePath: root.absolutePath,
        excluded: root.excludedDescendantRoots,
      })),
    ).toEqual(
      desktop.roots.map((root) => ({
        id: root.repoId,
        absolutePath: canonical(root.absolutePath),
        excluded: root.excludedDescendantRoots.map(canonical),
      })),
    );
  }
});

/** All five reads through the production dispatcher, not an injected selection. */
async function captureProductionBackends(
  platform: RouteHarnessOptions['platform'],
): Promise<Record<string, string>> {
  h = await createRouteHarness({ platform });
  const baseline = h.route.observe().cursor;
  const sender = new FakeSender(1);
  const caller = localCaller(sender);
  const request = { sender };
  const absolutePath = join(
    h.displayRoot,
    'workspaces/single/worktrees/task/README.md',
  );
  await h.roots(SINGLE, sender);
  await h.directory(SINGLE, 'single', '', sender);
  const file = await h.runtime.queryFileContentForLegacyIpc(
    { scope: SINGLE, absolutePath },
    { caller },
    request,
  );
  expect(file.canonicalResult).not.toBeNull();
  await h.runtime.queryFileIndexForLegacyIpc(
    { projectId: 'single', worktreeId: 'task' },
    { caller },
    request,
  );
  const link = await h.runtime.queryLinkResolveForLegacyIpc(
    {
      scope: SINGLE,
      mode: 'markdown',
      href: './A.txt',
      baseFilePath: absolutePath,
    },
    { caller },
    request,
  );
  expect(link.canonicalResult).not.toBeNull();
  const backends: Record<string, string> = {};
  const evidence = h.route.observe(baseline);
  expect(evidence.complete).toBe(true);
  expect(evidence.dropped).toBe(0);
  for (const event of evidence.entries) {
    expect(event.phase).not.toBe('failed');
    expect(event.phase).not.toBe('fallback');
    if (event.phase !== 'started') continue;
    expect(backends[event.operation] ?? event.backend).toBe(event.backend);
    backends[event.operation] = event.backend;
  }
  return backends;
}

function guardInput(
  operation: ReadRouteInput['operation'],
  platform: ReadRouteInput['platform'],
): ReadRouteInput {
  return {
    operation,
    platform,
    caller: localCaller({ id: 1 }),
    senderId: 1,
    scope: SINGLE,
    lookups: {
      resolveWorktreeTargetIds: (projectId, worktreeId) => ({
        projectId,
        worktreeId,
      }),
      workspaceType: () => 'single-repo',
      excludedWorkspaceIds: new Set(),
      routedWorkspaceTypes: new Set(['single-repo']),
    },
  };
}

describe('Files production selection is independent of platform qualification', () => {
  it.each(['darwin', 'win32', 'linux', null] as const)(
    'preserves all five production backends on %s',
    async (platform) => {
      const all = platform === 'darwin' || platform === 'linux';
      expect(await captureProductionBackends(platform)).toEqual({
        roots: platform === null ? 'direct' : 'daemon',
        directory: platform === null ? 'direct' : 'daemon',
        file: all ? 'daemon' : 'direct',
        search: all ? 'daemon' : 'direct',
        link: all ? 'daemon' : 'direct',
      });
    },
    CAPTURE_TIMEOUT_MS,
  );

  it(
    'keeps Windows file, search and link direct after their cells qualify',
    async () => {
      const operations = ['files.file', 'files.search', 'files.link'] as const;
      for (const operation of operations) {
        jest.replaceProperty(READ_ROUTE_TABLE, operation, {
          ...READ_ROUTE_TABLE[operation],
          win32: { kind: 'eligible' },
        });
        expect(
          evaluateReadRoute(guardInput(operation, 'win32')),
        ).not.toBeNull();
      }
      expect(await captureProductionBackends('win32')).toEqual({
        roots: 'daemon',
        directory: 'daemon',
        file: 'direct',
        search: 'direct',
        link: 'direct',
      });
      for (const operation of [
        'worker.filesystem.file.read',
        'worker.filesystem.search',
        'worker.filesystem.link.resolve',
      ]) {
        expect(h?.daemon.names()).not.toContain(operation);
      }
    },
    CAPTURE_TIMEOUT_MS,
  );
});

const RESERVED_GIT_READS: ReadonlyArray<
  readonly [GitReadRouteOperation, 'CAN-4729' | 'CAN-4103']
> = [
  ['git.remote.get', 'CAN-4729'],
  ['git.worktree.health.get', 'CAN-4729'],
  ['git.executable.get', 'CAN-4729'],
  ['git.status.get', 'CAN-4103'],
  ['git.diff.get', 'CAN-4103'],
];

describe('Reserved read routes require prerequisites as well as qualification', () => {
  it.each(RESERVED_GIT_READS)(
    'keeps %s blocked by %s even if every platform qualifies',
    (operation, until) => {
      expect(READ_ROUTE_PREREQUISITES[operation]).toMatchObject({
        kind: 'blocked',
        until,
      });
      jest.replaceProperty(READ_ROUTE_TABLE, operation, {
        darwin: { kind: 'eligible' },
        win32: { kind: 'eligible' },
        linux: { kind: 'eligible' },
      });
      for (const platform of ['darwin', 'win32', 'linux'] as const) {
        expect(evaluateReadRoute(guardInput(operation, platform))).toBeNull();
      }
      jest.replaceProperty(READ_ROUTE_PREREQUISITES, operation, {
        kind: 'eligible',
      });
      for (const platform of ['darwin', 'win32', 'linux'] as const) {
        expect(evaluateReadRoute(guardInput(operation, platform))).toEqual({
          shape: 'repository',
          ...SINGLE,
        });
      }
    },
  );

  it.each(RESERVED_GIT_READS)(
    'does not claim %s is qualified when its prerequisite is met',
    (operation, until) => {
      jest.replaceProperty(READ_ROUTE_PREREQUISITES, operation, {
        kind: 'eligible',
      });
      for (const platform of ['darwin', 'win32', 'linux'] as const) {
        const windowsGap = platform === 'win32' && until === 'CAN-4103';
        const disposition = READ_ROUTE_TABLE[operation][platform];
        expect(disposition).toMatchObject({
          kind: 'blocked',
          until: windowsGap ? 'CAN-4732' : until,
        });
        if (!windowsGap && disposition.kind === 'blocked') {
          expect(disposition.reason).toContain(
            'qualification has not been assessed',
          );
        }
        expect(evaluateReadRoute(guardInput(operation, platform))).toBeNull();
      }
    },
  );

  it.each(['git.status.get', 'git.diff.get'] as const)(
    'retains the Windows qualification gap for %s separately from CAN-4103',
    (operation) => {
      expect(READ_ROUTE_TABLE[operation].win32).toMatchObject({
        kind: 'blocked',
        until: 'CAN-4732',
      });
    },
  );
});
