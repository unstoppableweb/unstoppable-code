import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEMORY_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type {
  LocalMemoryConsolidationStatus,
  LocalMemoryScopeRequest,
} from '@canopy/desktop-shared/types';
import type { LocalMemoryImportSource } from '../../memory/local/import/import-job';
import {
  listMemoryReplacementFiles,
  type MemoryReplacementFile,
} from '../../memory/local/rebuild';
import type { CoreMemoryMaintenanceHost } from '../core-memory-maintenance-adapter';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../desktop-runtime-identity';
import { INTERFACE_RELAY_ALLOWLIST } from '../renderer-relay/interface-allowlist.generated';
import {
  RENDERER_RELAY_SURFACES,
  relayAllows,
} from '../renderer-relay/surface-allowlist';

const caller = (
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor => ({
  principalId: 'local-desktop-user',
  clientInstanceId: 'agent-action:advisor-chat',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'mcp',
  grants,
});
const READ = caller([MEMORY_GRANTS.read]);
const WRITE = caller([MEMORY_GRANTS.write]);
const meta = (key: string): { idempotencyKey: string } => ({
  idempotencyKey: key,
});
const PROJECT = { scope: 'workspace' as const, workspaceId: 'ws' };

const STATUS: LocalMemoryConsolidationStatus = {
  pendingNotes: 2,
  running: false,
  rebuilding: false,
  lastRunAt: '2026-11-09T00:00:00.000Z',
  lastResult: 'success',
  lastReason: null,
  lastConsolidatedAt: '2026-11-09T00:00:00.000Z',
};

interface Calls {
  consolidated: LocalMemoryScopeRequest[];
  rebuilt: LocalMemoryScopeRequest[];
  restored: Array<{ scope: LocalMemoryScopeRequest; snapshotId: string }>;
  imported: Array<{
    workspaceId: string | undefined;
    sourcePaths: readonly string[];
  }>;
}

/** What runs once the fake takes the scope's write lock, before its check. */
interface Lock {
  onTaken: () => void;
}

function fakeHost(): {
  host: CoreMemoryMaintenanceHost;
  calls: Calls;
  files: MemoryReplacementFile[];
  sources: LocalMemoryImportSource[];
  lock: Lock;
} {
  const calls: Calls = {
    consolidated: [],
    rebuilt: [],
    restored: [],
    imported: [],
  };
  const files: MemoryReplacementFile[] = [
    {
      fileKey: 'MEMORY.md',
      modifiedAt: '2026-11-09T00:00:00.000Z',
      sizeBytes: 10,
    },
  ];
  const sources: LocalMemoryImportSource[] = [
    {
      tool: 'claude-code',
      label: 'canopy: MEMORY.md',
      sourcePath: '/Users/someone/.claude/projects/canopy/memory/MEMORY.md',
    },
  ];
  const lock: Lock = { onTaken: () => undefined };
  /** Runs `write` once the fake lock is taken, as the store's rebuild and restore do. */
  const underLock = <T>(write: () => Promise<T>): Promise<T> => {
    lock.onTaken();
    return write();
  };
  const host: CoreMemoryMaintenanceHost = {
    workspaceExists: (workspaceId) => Promise.resolve(workspaceId === 'ws'),
    replaceableFiles: () => Promise.resolve(files.map((file) => ({ ...file }))),
    listSnapshots: () =>
      Promise.resolve([
        {
          id: 'snap-1',
          createdAt: '2026-11-08T00:00:00.000Z',
          reason: 'consolidation',
          topicCount: 3,
        },
      ]),
    consolidateNow: (scope) => {
      calls.consolidated.push(scope);
      return Promise.resolve(STATUS);
    },
    rebuild: (scope, unchanged) =>
      underLock(async () => {
        if (!(await unchanged())) return 'stale';
        calls.rebuilt.push(scope);
        return {
          rebuild: {
            status: 'completed',
            snapshotId: 'snap-2',
            restoredInboxNotes: 4,
            restoredImports: 1,
            runs: 2,
          },
          status: STATUS,
        };
      }),
    restoreSnapshot: (scope, snapshotId, unchanged) =>
      underLock(async () => {
        if (!(await unchanged())) return 'stale';
        calls.restored.push({ scope, snapshotId });
        return { status: 'restored', previousSnapshotId: 'snap-3' };
      }),
    importSources: () =>
      Promise.resolve(sources.map((source) => ({ ...source }))),
    importExternal: (workspaceId, sourcePaths) => {
      calls.imported.push({ workspaceId, sourcePaths });
      const [first] = sourcePaths;
      return Promise.resolve({
        disabled: false,
        staged: 1,
        skipped: 0,
        deferred: 0,
        // The importer's messages carry host paths.
        errors: [
          `${first}: EACCES: permission denied, open '${first}'`,
          '/Users/someone/Library/Application Support/Canopy/memory/user: ENOSPC: no space left on device',
        ],
      });
    },
  };
  return { host, calls, files, sources, lock };
}

let root: string;
const runtimes: DesktopCanopyDispatcher[] = [];
function runtimeWith(host: CoreMemoryMaintenanceHost): DesktopCanopyDispatcher {
  const runtime = createDesktopRuntime({
    operationAdapter: createCoreOperationAdapter({
      ledgerPath: () => join(root, `ledger-${runtimes.length}.sqlite`),
    }),
    memoryMaintenanceHost: host,
    shutdownTimeoutMs: 25,
  });
  runtimes.push(runtime);
  return runtime;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'core-memory-maintenance-'));
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  rmSync(root, { recursive: true, force: true });
});

describe('core.memory maintenance on the desktop dispatcher (CAN-6005)', () => {
  it("lists a scope's snapshots with the revision of the files a restore replaces, and only for a listed project", async () => {
    const { host, files } = fakeHost();
    const runtime = runtimeWith(host);
    const first = await runtime.query(
      'core.memory.snapshot.list',
      { target: PROJECT },
      { caller: READ },
    );
    expect(first.snapshots).toEqual([
      {
        snapshotId: 'snap-1',
        createdAt: '2026-11-08T00:00:00.000Z',
        reason: 'consolidation',
        topicCount: 3,
      },
    ]);
    const second = await runtime.query(
      'core.memory.snapshot.list',
      { target: PROJECT },
      { caller: READ },
    );
    expect(second.revision).toBe(first.revision);
    const index = files[0];
    if (index) index.modifiedAt = '2026-11-10T00:00:00.000Z';
    const changed = await runtime.query(
      'core.memory.snapshot.list',
      { target: PROJECT },
      { caller: READ },
    );
    expect(changed.revision).not.toBe(first.revision);
    await expect(
      runtime.query(
        'core.memory.snapshot.list',
        { target: { scope: 'workspace', workspaceId: 'gone' } },
        { caller: READ },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found', code: 'core.memory.workspace.notFound' },
    });
  });

  it('rebuilds and restores only the memory the caller read, once per key', async () => {
    const { host, calls, files } = fakeHost();
    const runtime = runtimeWith(host);
    const { revision } = await runtime.query(
      'core.memory.snapshot.list',
      { target: PROJECT },
      { caller: READ },
    );
    await expect(
      runtime.instruction(
        'core.memory.consolidation.rebuild',
        { target: PROJECT, expectedRevision: 'stale', _meta: meta('r0') },
        { caller: WRITE, metadata: meta('r0') },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'conflict', code: 'core.memory.revisionConflict' },
    });
    const params = {
      target: PROJECT,
      expectedRevision: revision,
      _meta: meta('r1'),
    };
    const first = await runtime.instruction(
      'core.memory.consolidation.rebuild',
      params,
      { caller: WRITE, metadata: meta('r1') },
    );
    const replay = await runtime.instruction(
      'core.memory.consolidation.rebuild',
      params,
      { caller: WRITE, metadata: meta('r1') },
    );
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      status: 'completed',
      reason: null,
      snapshotId: 'snap-2',
      consolidation: { pendingNotes: 2, lastResult: 'success' },
    });
    expect(calls.rebuilt).toEqual([PROJECT]);

    const index = files[0];
    if (index) index.sizeBytes = 99;
    await expect(
      runtime.instruction(
        'core.memory.snapshot.restore',
        {
          target: PROJECT,
          snapshotId: 'snap-1',
          expectedRevision: revision,
          _meta: meta('s1'),
        },
        { caller: WRITE, metadata: meta('s1') },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'conflict', code: 'core.memory.revisionConflict' },
    });
    expect(calls.restored).toEqual([]);
    const fresh = await runtime.query(
      'core.memory.snapshot.list',
      { target: PROJECT },
      { caller: READ },
    );
    await expect(
      runtime.instruction(
        'core.memory.snapshot.restore',
        {
          target: PROJECT,
          snapshotId: 'snap-1',
          expectedRevision: fresh.revision,
          _meta: meta('s2'),
        },
        { caller: WRITE, metadata: meta('s2') },
      ),
    ).resolves.toEqual({
      status: 'restored',
      reason: null,
      previousSnapshotId: 'snap-3',
    });
    expect(calls.restored).toEqual([{ scope: PROJECT, snapshotId: 'snap-1' }]);
  });

  it('checks the revision under the write lock, so a change after the read replaces nothing', async () => {
    const { host, calls, files, lock } = fakeHost();
    const runtime = runtimeWith(host);
    const { revision } = await runtime.query(
      'core.memory.snapshot.list',
      { target: PROJECT },
      { caller: READ },
    );
    // A write lands between the caller's read and the lock.
    lock.onTaken = (): void => {
      const index = files[0];
      if (index) index.modifiedAt = '2026-11-10T00:00:00.000Z';
    };
    const conflict = {
      payload: { kind: 'conflict', code: 'core.memory.revisionConflict' },
    };
    await expect(
      runtime.instruction(
        'core.memory.consolidation.rebuild',
        { target: PROJECT, expectedRevision: revision, _meta: meta('l1') },
        { caller: WRITE, metadata: meta('l1') },
      ),
    ).rejects.toMatchObject(conflict);
    await expect(
      runtime.instruction(
        'core.memory.snapshot.restore',
        {
          target: PROJECT,
          snapshotId: 'snap-1',
          expectedRevision: revision,
          _meta: meta('l2'),
        },
        { caller: WRITE, metadata: meta('l2') },
      ),
    ).rejects.toMatchObject(conflict);
    expect(calls.rebuilt).toEqual([]);
    expect(calls.restored).toEqual([]);
  });

  it('covers every topic a restore replaces, whatever its name, in the revision checked under the lock', async () => {
    const scopeDir = join(root, 'scope');
    mkdirSync(join(scopeDir, 'topics'), { recursive: true });
    mkdirSync(join(scopeDir, 'inbox'), { recursive: true });
    writeFileSync(join(scopeDir, 'MEMORY.md'), '# Memory\n');
    // Names the memory explorer won't open, but a snapshot keeps.
    writeFileSync(join(scopeDir, 'topics', 'release notes.md'), 'v1\n');
    writeFileSync(join(scopeDir, 'topics', 'café.md'), 'v1\n');
    writeFileSync(join(scopeDir, 'inbox', 'note.md'), 'note\n');
    expect(
      (await listMemoryReplacementFiles(scopeDir)).map((file) => file.fileKey),
    ).toEqual([
      'MEMORY.md',
      'inbox/note.md',
      'topics/café.md',
      'topics/release notes.md',
    ]);
    const { host, calls, lock } = fakeHost();
    host.replaceableFiles = (): Promise<MemoryReplacementFile[]> =>
      listMemoryReplacementFiles(scopeDir);
    const runtime = runtimeWith(host);
    const conflict = {
      payload: { kind: 'conflict', code: 'core.memory.revisionConflict' },
    };
    let attempt = 0;
    for (const name of ['release notes.md', 'café.md'])
      for (const operation of ['rebuild', 'restore'] as const) {
        attempt += 1;
        const key = `u${attempt}`;
        const { revision } = await runtime.query(
          'core.memory.snapshot.list',
          { target: PROJECT },
          { caller: READ },
        );
        // The topic changes while the person is asked.
        lock.onTaken = (): void =>
          appendFileSync(join(scopeDir, 'topics', name), `edit ${attempt}\n`);
        await expect(
          operation === 'rebuild'
            ? runtime.instruction(
                'core.memory.consolidation.rebuild',
                {
                  target: PROJECT,
                  expectedRevision: revision,
                  _meta: meta(key),
                },
                { caller: WRITE, metadata: meta(key) },
              )
            : runtime.instruction(
                'core.memory.snapshot.restore',
                {
                  target: PROJECT,
                  snapshotId: 'snap-1',
                  expectedRevision: revision,
                  _meta: meta(key),
                },
                { caller: WRITE, metadata: meta(key) },
              ),
        ).rejects.toMatchObject(conflict);
      }
    expect(calls.rebuilt).toEqual([]);
    expect(calls.restored).toEqual([]);
  });

  it('lists import sources by label only, and imports only the listed set', async () => {
    const { host, calls, sources } = fakeHost();
    const runtime = runtimeWith(host);
    const listed = await runtime.query(
      'core.memory.import.sources.list',
      { workspaceId: 'ws' },
      { caller: READ },
    );
    expect(listed.sources).toEqual([
      { tool: 'claude-code', label: 'canopy: MEMORY.md' },
    ]);
    expect(JSON.stringify(listed)).not.toContain('/Users/');
    sources.push({
      tool: 'codex',
      label: 'Codex: notes.md',
      sourcePath: '/Users/someone/.codex/memories/notes.md',
    });
    await expect(
      runtime.instruction(
        'core.memory.import.external',
        {
          workspaceId: 'ws',
          expectedSourcesDigest: listed.digest,
          _meta: meta('i1'),
        },
        { caller: WRITE, metadata: meta('i1') },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.memory.import.sourcesChanged',
      },
    });
    expect(calls.imported).toEqual([]);
    const relisted = await runtime.query(
      'core.memory.import.sources.list',
      { workspaceId: 'ws' },
      { caller: READ },
    );
    const params = {
      workspaceId: 'ws',
      expectedSourcesDigest: relisted.digest,
      _meta: meta('i2'),
    };
    const first = await runtime.instruction(
      'core.memory.import.external',
      params,
      { caller: WRITE, metadata: meta('i2') },
    );
    await runtime.instruction('core.memory.import.external', params, {
      caller: WRITE,
      metadata: meta('i2'),
    });
    expect(first).toEqual({
      disabled: false,
      staged: 1,
      skipped: 0,
      deferred: 0,
      errors: [
        'canopy: MEMORY.md could not be imported (EACCES).',
        'A step of the import could not finish (ENOSPC).',
      ],
    });
    expect(JSON.stringify(first)).not.toMatch(/\/Users\/|Application Support/);
    // The import is bound to the files listed, not to whatever the job finds.
    expect(calls.imported).toEqual([
      {
        workspaceId: 'ws',
        sourcePaths: [
          '/Users/someone/.claude/projects/canopy/memory/MEMORY.md',
          '/Users/someone/.codex/memories/notes.md',
        ],
      },
    ]);
  });

  it("consolidates a scope, and refuses without the operation's grant before the store is touched", async () => {
    const { host, calls } = fakeHost();
    const runtime = runtimeWith(host);
    await expect(
      runtime.instruction(
        'core.memory.consolidation.run',
        { target: { scope: 'user' }, _meta: meta('c0') },
        { caller: READ, metadata: meta('c0') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    await expect(
      runtime.query(
        'core.memory.snapshot.list',
        { target: { scope: 'user' } },
        { caller: WRITE },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(calls.consolidated).toEqual([]);
    await expect(
      runtime.instruction(
        'core.memory.consolidation.run',
        { target: { scope: 'user' }, _meta: meta('c1') },
        { caller: WRITE, metadata: meta('c1') },
      ),
    ).resolves.toEqual({
      pendingNotes: 2,
      running: false,
      lastRunAt: '2026-11-09T00:00:00.000Z',
      lastResult: 'success',
      lastReason: null,
      lastConsolidatedAt: '2026-11-09T00:00:00.000Z',
    });
    expect(calls.consolidated).toEqual([{ scope: 'user' }]);
  });

  it('no renderer relay can rebuild, restore or import memory; the reads it exposed still reach it', () => {
    const writes = [
      'core.memory.consolidation.rebuild',
      'core.memory.snapshot.restore',
      'core.memory.import.external',
    ];
    for (const mode of Object.values(INTERFACE_RELAY_ALLOWLIST))
      for (const operations of Object.values(mode))
        for (const write of writes) expect(operations).not.toContain(write);
    for (const surface of RENDERER_RELAY_SURFACES)
      for (const write of writes)
        expect(relayAllows(surface, 'instruction', write)).toBe(false);
    for (const read of [
      'core.memory.snapshot.list',
      'core.memory.import.sources.list',
      'core.memory.search',
      'core.memory.entry.get',
    ])
      expect(relayAllows('main', 'query', read)).toBe(true);
  });
});
