import type * as ArchiveFilesystem from 'node:fs/promises';
import * as archiveDurability from '@canopy/execution-engine/node/lib/atomic-file';
import { execFileSync } from 'node:child_process';
import canopy from '../../../../../brands/canopy/brand.json';
import { migrateInternalRoot } from '@canopy/core-runtime/node/internal-root-migration';
import { createInternalRootMigrationWorker } from '../internal-root-migration';
import { internalRootIdentity } from '../internal-root-migration/filesystem';
import { createInternalRootRelocationRepairs } from '../internal-root-migration/repairs';
import { desktopW5Durability } from '../w5-commit-log/durability';

import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  rm,
  symlink,
  realpath,
  readdir,
  lstat,
  link,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  type ArchiveRecoveryPreparation,
  ArchiveRecoveryStore,
  ArchiveRecoveryRefusedError,
  inventoryArchiveRecoveryTree,
  archiveRecoveryDigest,
} from '../archive-recovery-store';

describe('core.worktree.recovery.resolve persistence contract', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'archive-hold-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const preparation = (): ArchiveRecoveryPreparation => ({
    workspaceId: 'ws',
    worktreeId: 'tree',
    operationId: randomUUID(),
    action: 'release' as const,
    revision: 'a'.repeat(64),
    createdAt: '2026-11-01T00:00:00.000Z',
    copies: [],
    repositories: [],
    sourceRecord: {},
    capture: 'none' as const,
  });
  test.each(['empty', 'partial', 'full', 'published-link', 'stage-temp'])(
    'exclusive publication normalization settles %s twice without promoting temps',
    async (shape) => {
      const store = new ArchiveRecoveryStore(root);
      const input = preparation();
      const directory = store.directory(input);
      await mkdir(directory, { recursive: true });
      const temporary = join(
        directory,
        `.receipt.json.123.${randomUUID()}.tmp`,
      );
      if (shape === 'published-link' || shape === 'stage-temp') {
        const receipt = await store.prepare(input);
        if (shape === 'published-link')
          await link(join(directory, 'receipt.json'), temporary);
        else
          await writeFile(
            temporary,
            JSON.stringify({ ...receipt, stage: 'retained' }),
            { mode: 0o600 },
          );
      } else if (shape !== 'empty') {
        await writeFile(
          temporary,
          shape === 'partial'
            ? '{"version":'
            : JSON.stringify({ ...input, stage: 'completed' }),
          { mode: 0o600 },
        );
      }
      // Ordinary reads never normalize, and unpublished bytes never become authority.
      if (shape !== 'published-link' && shape !== 'stage-temp')
        expect(await store.read('ws', input.operationId)).toBeNull();
      await store.normalize('ws', input.operationId);
      await store.normalize('ws', input.operationId);
      const receipt = await store.prepare(input);
      expect(receipt.stage).toBe('prepared');
      expect(await readdir(directory)).toEqual(['receipt.json']);
    },
  );
  test.each(['external-link', 'symlink', 'unknown'])(
    'normalization preserves unverifiable %s artifacts',
    async (shape) => {
      const store = new ArchiveRecoveryStore(root);
      const receipt = await store.prepare(preparation());
      const directory = store.directory(receipt);
      if (shape === 'external-link')
        await link(join(directory, 'receipt.json'), join(root, 'outside'));
      if (shape === 'symlink')
        await symlink(
          join(directory, 'receipt.json'),
          join(directory, `.receipt.json.123.${randomUUID()}.tmp`),
        );
      if (shape === 'unknown')
        await writeFile(join(directory, 'unknown'), 'not disposable');
      await expect(
        store.normalize('ws', receipt.operationId),
      ).rejects.toBeInstanceOf(ArchiveRecoveryRefusedError);
      expect(await readFile(join(directory, 'receipt.json'), 'utf8')).toContain(
        receipt.operationId,
      );
    },
  );
  test.each([
    'archive',
    'delete',
    'successor',
    'successor-chain',
    'finish-v2',
    'finish-v3',
    'project-child',
    'discard',
    'missing-proof',
    'pending-discard',
    'changed-incarnation',
    'original-copy',
    'conflicting-proof',
    'conflicting-source',
    'operation-switch',
    'project-lineage',
    'not-cancelled',
    'unexpected-payload',
    'unlink-before',
    'unlink-after',
    'rmdir-after',
  ])(
    'cancelled intent settlement requires durable supersession: %s',
    async (shape) => {
      const store = new ArchiveRecoveryStore(root);
      const input = preparation();
      const record = {
        version: 1,
        operationId: input.operationId,
        operation: 'worktree-archive',
        state: 'recovery-required',
        workspaceId: 'ws',
        worktreeId: 'tree',
        createdAt: input.createdAt,
        directoryIdentity: 'project-incarnation',
        steps: [{ phase: 'git-capture', state: 'failed' }],
        ownedPaths: [],
        ...(shape === 'project-child'
          ? { parentOperation: 'workspace-delete' }
          : {}),
      };
      const contents = JSON.stringify(record);
      const name = `${input.operationId}.json`;
      const directory = join(root, 'w5/destructive-lifecycles');
      const source = join(directory, name);
      await mkdir(directory, { recursive: true });
      await writeFile(source, contents);
      let receipt = await store.prepare({
        ...input,
        sourceRecord: record,
        copies: [{ name, contents, digest: archiveRecoveryDigest(contents) }],
      });
      if (shape !== 'not-cancelled') receipt = await store.cancel(receipt);
      await rm(source);
      const discard = [
        'discard',
        'pending-discard',
        'changed-incarnation',
        'original-copy',
        'conflicting-proof',
      ].includes(shape);
      const completed = {
        ...record,
        operationId:
          discard ||
          shape === 'delete' ||
          shape === 'project-lineage' ||
          shape === 'conflicting-source' ||
          shape.startsWith('successor')
            ? randomUUID()
            : input.operationId,
        ...(['delete', 'project-lineage', 'conflicting-source'].includes(
          shape,
        ) || shape.startsWith('successor')
          ? {
              supersedesArchives:
                shape === 'successor-chain'
                  ? [input.operationId, randomUUID()]
                  : [input.operationId],
            }
          : {}),
        operation:
          shape === 'project-lineage'
            ? 'workspace-delete'
            : discard || shape === 'delete' || shape === 'operation-switch'
              ? 'worktree-delete'
              : 'worktree-archive',
        state: shape === 'pending-discard' ? 'recovery-required' : 'completed',
        directoryIdentity:
          shape === 'changed-incarnation'
            ? 'replacement'
            : record.directoryIdentity,
        steps: discard
          ? [
              {
                phase: `discard:supersede:${input.operationId}`,
                state: 'done',
              },
              { phase: 'discard:retire-superseded', state: 'done' },
            ]
          : [
              {
                phase: shape.startsWith('finish-')
                  ? 'canonical-row-removal'
                  : 'git-capture',
                state: 'done',
              },
            ],
      };
      if (shape !== 'missing-proof')
        await writeFile(
          join(directory, `${completed.operationId}.json`),
          JSON.stringify(completed),
        );
      if (shape === 'original-copy') await writeFile(source, contents);
      if (shape === 'conflicting-proof') {
        const slot = `${archiveRecoveryDigest(JSON.stringify(['ws', 'tree']))}.json`;
        await writeFile(
          join(directory, slot),
          JSON.stringify({ ...completed, state: 'recovery-required' }),
        );
      }
      if (shape === 'conflicting-source') {
        const completedSource = { ...record, state: 'completed' };
        await writeFile(source, JSON.stringify(completedSource));
        const slot = `${archiveRecoveryDigest(JSON.stringify(['ws', 'tree']))}.json`;
        await writeFile(
          join(directory, slot),
          JSON.stringify({
            ...completedSource,
            steps: [{ phase: 'canonical-row-removal', state: 'pending' }],
          }),
        );
      }
      if (shape === 'unexpected-payload')
        await mkdir(store.payloadPath(receipt));
      expect(await store.read('ws', input.operationId)).toEqual(receipt);
      if (shape.startsWith('unlink-') || shape === 'rmdir-after') {
        const archiveFilesystem =
          jest.requireActual<typeof ArchiveFilesystem>('node:fs/promises');
        const method = shape === 'rmdir-after' ? 'rmdir' : 'unlink';
        const original = archiveFilesystem[method];
        const fault = jest
          .spyOn(archiveFilesystem, method)
          .mockImplementation(async (...args) => {
            const [path] = args;
            const target =
              method === 'rmdir'
                ? store.directory(receipt)
                : join(store.directory(receipt), 'receipt.json');
            if (path === target) {
              if (shape !== 'unlink-before') await original(path);
              throw new Error('interrupted cancellation settlement');
            }
            return original(path);
          });
        try {
          await expect(store.normalizeWorkspace('ws')).rejects.toThrow(
            'interrupted cancellation settlement',
          );
        } finally {
          fault.mockRestore();
        }
      }
      await store.normalizeWorkspace('ws');
      await store.normalizeWorkspace('ws');
      const settled = [
        'archive',
        'delete',
        'successor',
        'successor-chain',
        'finish-v2',
        'finish-v3',
        'project-child',
        'discard',
        'unlink-before',
        'unlink-after',
        'rmdir-after',
      ].includes(shape);
      expect(await store.read('ws', input.operationId)).toEqual(
        settled ? null : receipt,
      );
      if (settled)
        expect(await readdir(dirname(store.directory(receipt)))).toEqual([]);
      else if (shape !== 'original-copy') {
        const { freezeInternalRootArchiveRecovery } =
          await import('../internal-root-migration/archive-recovery');
        await expect(
          freezeInternalRootArchiveRecovery(root),
        ).rejects.toMatchObject({
          name: 'InternalRootMigrationRefused',
          reason: 'repair-refused',
        });
      }
    },
  );

  test('cancellation needs exact original copies and untouched staging; a moved payload is forward-only', async () => {
    const store = new ArchiveRecoveryStore(root);
    const input = preparation();
    const record = {
      version: 1,
      operationId: input.operationId,
      operation: 'worktree-archive',
      state: 'recovery-required',
      workspaceId: 'ws',
      worktreeId: 'tree',
      createdAt: input.createdAt,
      directoryIdentity: null,
      steps: [],
      ownedPaths: [],
    };
    const contents = JSON.stringify(record);
    const copy = {
      name: `${input.operationId}.json`,
      contents,
      digest: archiveRecoveryDigest(contents),
    };
    const source = join(root, 'w5/destructive-lifecycles', copy.name);
    await mkdir(join(root, 'w5/destructive-lifecycles'), { recursive: true });
    await writeFile(source, contents);
    await mkdir(store.stagingPath(input), { recursive: true });
    await writeFile(join(store.stagingPath(input), 'unique'), 'original');
    let receipt = await store.prepare({
      ...input,
      sourceRecord: record,
      copies: [copy],
    });
    await rm(source);
    await expect(store.cancel(receipt)).rejects.toThrow();
    await writeFile(source, contents);
    receipt = await store.cancel(receipt);
    expect(receipt.cancelled).toBe(true);
    expect(await readFile(source, 'utf8')).toBe(contents);
    expect(
      await readFile(join(store.stagingPath(input), 'unique'), 'utf8'),
    ).toBe('original');
    receipt = await store.restartCancelled(receipt);
    receipt = await store.publishRetention(receipt);
    receipt = await store.writeStage(receipt, 'reset-intent');
    await rename(store.stagingPath(receipt), store.payloadPath(receipt));
    expect((await store.inspect(receipt)).reset).toBe('performed');
    await expect(store.cancel(receipt)).rejects.toThrow();
    receipt = await store.resetStaging(receipt);
    receipt = await store.writeStage(receipt, 'withdrawal-intent');
    const retired = join(store.directory(receipt), 'journals');
    await mkdir(retired);
    await rename(source, join(retired, copy.name));
    const replacement = JSON.stringify({
      ...record,
      operationId: randomUUID(),
    });
    await writeFile(source, replacement);
    receipt = await store.withdrawJournals(receipt);
    expect(receipt.stage).toBe('withdrawn');
    expect(await readFile(source, 'utf8')).toBe(replacement);
    await rm(store.payloadPath(receipt), { recursive: true });
    expect((await store.writeStage(receipt, 'completed')).stage).toBe(
      'completed',
    );
  });
  test.each([
    [0, 'before'],
    [0, 'after'],
    [1, 'before'],
    [1, 'after'],
  ] as const)(
    'reset replay re-flushes parent %s after %s flush interruption',
    async (parent, timing) => {
      const store = new ArchiveRecoveryStore(root);
      const input = preparation();
      await mkdir(store.stagingPath(input), { recursive: true });
      await writeFile(join(store.stagingPath(input), 'only-copy'), 'unique');
      let receipt = await store.prepare(input);
      receipt = await store.publishRetention(receipt);
      const selectedParent =
        parent === 0
          ? dirname(store.stagingPath(receipt))
          : dirname(store.payloadPath(receipt));
      const original = archiveDurability.syncDirectory;
      let injected = false;
      const fault = jest
        .spyOn(archiveDurability, 'syncDirectory')
        .mockImplementation(async (path) => {
          if (path === selectedParent && !injected && timing === 'before') {
            injected = true;
            throw new Error('before parent flush');
          }
          await original(path);
          if (path === selectedParent && !injected && timing === 'after') {
            injected = true;
            throw new Error('after parent flush');
          }
        });
      try {
        await expect(store.resetStaging(receipt)).rejects.toThrow(
          'parent flush',
        );
      } finally {
        fault.mockRestore();
      }
      const saved = await store.read('ws', receipt.operationId);
      if (!saved) throw new Error('Missing reset intent');
      expect(saved.stage).toBe('reset-intent');
      expect((await store.inspect(saved)).reset).toBe('performed');
      const replayed = await store.resetStaging(saved);
      expect(replayed.stage).toBe('staging-reset');
      expect(
        await readFile(join(store.payloadPath(replayed), 'only-copy'), 'utf8'),
      ).toBe('unique');
    },
  );
  test('moves all staged evidence out of the reusable slot and resumes after a lost rename acknowledgement', async () => {
    const source = join(
      root,
      'workspaces',
      'ws',
      'archived-containers',
      'tree',
    );
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'unique.txt'), 'sole surviving files');
    const store = new ArchiveRecoveryStore(root);
    const id = randomUUID();
    const receipt = await store.prepare({
      workspaceId: 'ws',
      worktreeId: 'tree',
      operationId: id,
      action: 'keep-worktree',
      revision: 'a'.repeat(64),
      createdAt: '2026-11-01T00:00:00.000Z',
      copies: [],
      repositories: [],
      sourceRecord: {},
      capture: 'partial',
    });
    expect(receipt.stage).toBe('prepared');
    await store.publishRetention(receipt);
    const intent = await store.writeStage(receipt, 'reset-intent');
    await rename(source, store.payloadPath(receipt));
    await store.resetStaging(intent);
    expect(
      await readFile(join(store.payloadPath(receipt), 'unique.txt'), 'utf8'),
    ).toBe('sole surviving files');
    expect((await store.list('ws'))[0]?.stage).toBe('staging-reset');
    await expect(readFile(join(source, 'unique.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  test('a missing source is not a completed move; replaced evidence is never reset', async () => {
    const source = join(
      root,
      'workspaces',
      'ws',
      'archived-containers',
      'tree',
    );
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'data'), 'unique');
    const store = new ArchiveRecoveryStore(root);
    const receipt = await store.prepare({
      workspaceId: 'ws',
      worktreeId: 'tree',
      operationId: randomUUID(),
      action: 'release',
      revision: 'a'.repeat(64),
      createdAt: '2026-11-01T00:00:00.000Z',
      copies: [],
      repositories: [],
      sourceRecord: {},
      capture: 'partial',
    });
    await store.publishRetention(receipt);
    await rm(source, { recursive: true });
    await expect(store.resetStaging(receipt)).rejects.toThrow();
    await mkdir(source);
    await writeFile(join(source, 'data'), 'replacement');
    await expect(store.resetStaging(receipt)).rejects.toThrow();
    expect(await readFile(join(source, 'data'), 'utf8')).toBe('replacement');
  });
  test('does not follow payload symlinks and rejects corrupt receipts instead of hiding them', async () => {
    const payload = join(root, 'payload');
    await mkdir(payload);
    await symlink(join(root, 'missing-target'), join(payload, 'evidence-link'));
    expect((await inventoryArchiveRecoveryTree(payload))?.entries).toEqual([
      expect.objectContaining({ path: 'evidence-link', kind: 'symlink' }),
    ]);
    await expect(
      inventoryArchiveRecoveryTree(join(payload, 'evidence-link')),
    ).rejects.toThrow();
    const store = new ArchiveRecoveryStore(root);
    expect(await store.list('ws')).toEqual([]);
    const id = randomUUID();
    await mkdir(join(root, 'w5', 'archive-recovery', 'ws', id), {
      recursive: true,
    });
    await writeFile(
      join(root, 'w5', 'archive-recovery', 'ws', id, 'receipt.json'),
      '{}',
    );
    await expect(store.list('ws')).rejects.toThrow();
    await expect(
      inventoryArchiveRecoveryTree(join(root, 'missing')),
    ).resolves.toBeNull();
  });
  test.each([false, true])(
    'exact withdrawal with replaced slot = %s preserves the right operation',
    async (replaced) => {
      const { createHash } = await import('node:crypto');
      const store = new ArchiveRecoveryStore(root);
      const operationId = randomUUID();
      const slot = `${createHash('sha256')
        .update(JSON.stringify(['ws', 'tree']))
        .digest('hex')}.json`;
      const record = {
        version: 1,
        operationId,
        operation: 'worktree-archive',
        state: 'recovery-required',
        workspaceId: 'ws',
        worktreeId: 'tree',
        createdAt: '2026-11-01T00:00:00.000Z',
        directoryIdentity: null,
        steps: [],
        ownedPaths: [],
      };
      const contents = JSON.stringify(record);
      const copies = [slot, `${operationId}.json`].map((name) => ({
        name,
        contents,
        digest: createHash('sha256').update(contents).digest('hex'),
      }));
      const journals = join(root, 'w5', 'destructive-lifecycles');
      await mkdir(journals, { recursive: true });
      for (const copy of copies)
        await writeFile(join(journals, copy.name), contents);
      let receipt = await store.prepare({
        workspaceId: 'ws',
        worktreeId: 'tree',
        operationId,
        action: 'release',
        revision: 'a'.repeat(64),
        createdAt: record.createdAt,
        copies,
        sourceRecord: record,
        repositories: [],
        capture: 'none',
      });
      receipt = await store.publishRetention(receipt);
      receipt = await store.resetStaging(receipt);
      receipt = await store.writeStage(receipt, 'withdrawal-intent');
      const replacement = JSON.stringify({
        ...record,
        operationId: randomUUID(),
      });
      if (replaced) {
        await writeFile(join(journals, slot), replacement);
        await expect(store.withdrawJournals(receipt)).rejects.toThrow();
        expect(
          await readFile(join(journals, `${operationId}.json`), 'utf8'),
        ).toBe(contents);
      } else {
        // Interruption after one copy moved: only the exact retained preimage proves progress.
        await mkdir(join(store.directory(receipt), 'journals'));
        await rename(
          join(journals, slot),
          join(store.directory(receipt), 'journals', slot),
        );
        const restarted = new ArchiveRecoveryStore(root);
        receipt = await restarted.withdrawJournals(receipt);
        expect(receipt.stage).toBe('withdrawn');
        expect(
          await readFile(
            join(store.directory(receipt), 'journals', slot),
            'utf8',
          ),
        ).toBe(contents);
        await expect(
          readFile(join(journals, `${operationId}.json`)),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        receipt = await restarted.writeStage(receipt, 'completed');
        await writeFile(join(journals, slot), replacement);
        expect((await restarted.withdrawJournals(receipt)).stage).toBe(
          'completed',
        );
      }
      expect(await readFile(join(journals, slot), 'utf8')).toBe(replacement);
    },
  );
});

test('explicit deletion has durable intent and is resumable after partial payload removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'delete-hold-'));
  try {
    const store = new ArchiveRecoveryStore(root);
    const input = {
      workspaceId: 'ws',
      worktreeId: 'tree',
      operationId: randomUUID(),
      action: 'release' as const,
      revision: 'a'.repeat(64),
      createdAt: '2026-11-01T00:00:00.000Z',
      copies: [],
      sourceRecord: {},
      repositories: [],
      capture: 'partial' as const,
    };
    const path = store.stagingPath(input);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'a'), 'one');
    await writeFile(join(path, 'b'), 'two');
    let receipt = await store.prepare(input);
    receipt = await store.publishRetention(receipt);
    receipt = await store.resetStaging(receipt);
    // This primitive-only fixture has no source copies; install a completed receipt to test retained-data deletion.
    receipt = { ...receipt, stage: 'completed' };
    await writeFile(
      join(store.directory(receipt), 'receipt.json'),
      JSON.stringify(receipt),
    );
    await writeFile(join(store.payloadPath(receipt), 'a'), 'changed');
    await expect(store.beginDeletion(receipt)).rejects.toBeInstanceOf(
      ArchiveRecoveryRefusedError,
    );
    expect(
      (await store.read('ws', input.operationId))?.retention,
    ).toBeUndefined();
    await writeFile(join(store.payloadPath(receipt), 'a'), 'one');
    receipt = await store.beginDeletion(receipt);
    await rm(join(store.payloadPath(receipt), 'a'));
    receipt = await new ArchiveRecoveryStore(root).deletePayload(receipt);
    expect(receipt.retention).toBe('deleted');
    await expect(
      readFile(join(store.payloadPath(receipt), 'b')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.read('ws', input.operationId))?.retention).toBe(
      'deleted',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exclusive initial receipt publication survives a crash with its temporary hardlink still installed', async () => {
  const { link } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'publish-receipt-'));
  try {
    const store = new ArchiveRecoveryStore(root);
    const input = {
      workspaceId: 'ws',
      worktreeId: 'tree',
      operationId: randomUUID(),
      action: 'release' as const,
      revision: 'a'.repeat(64),
      createdAt: '2026-11-01T00:00:00.000Z',
      copies: [],
      sourceRecord: {},
      repositories: [],
      capture: 'none' as const,
    };
    const directory = store.directory(input);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.receipt.json.123.${randomUUID()}.tmp`);
    await writeFile(temporary, 'partial');
    expect(await store.list('ws')).toEqual([]);
    await rm(temporary);
    const receipt = await store.prepare(input);
    await link(join(directory, 'receipt.json'), temporary);
    expect(await store.read('ws', input.operationId)).toEqual(receipt);
    await link(join(directory, 'receipt.json'), join(root, 'external-alias'));
    await expect(store.read('ws', input.operationId)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

let nativeBuild: string | undefined;
let ownedChildPath: string | undefined;
beforeAll(async () => {
  if (process.platform !== 'linux') return;
  // Match the migration goldens: Linux publication needs the no-replace addon.
  nativeBuild = await mkdtemp(join(tmpdir(), 'migration-native-'));
  ownedChildPath = join(nativeBuild, 'core-owned-child.node');
  execFileSync(
    process.execPath,
    [resolve('scripts/build-owned-child.mjs'), '--out', ownedChildPath],
    { stdio: 'pipe' },
  );
}, 60_000);
afterAll(async () => {
  if (nativeBuild) await rm(nativeBuild, { recursive: true, force: true });
});

test.each([
  'matching',
  'conflicting',
  'publication-link',
  'missing-checkout',
  'replaced-after-freeze',
  'partial-deletion',
  'deleted',
  'cancelled-keep',
  'cancelled-release',
  'cancelled-discard',
  'cancelled-zero-refs',
  'cancelled-absent-staging',
  'cancelled-staging-tampered',
  'cancelled-journal-tampered',
  'unfinished-prepared',
  'unfinished-retention-intent',
  'unfinished-retained',
  'unfinished-reset-intent',
  'unfinished-staging-reset',
  'unfinished-withdrawal-intent',
  'unfinished-withdrawn',
] as const)(
  'offline migration preserves or refuses retained repository ownership (%s binding)',
  async (binding) => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), 'recovery-root-flow-')),
    );
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    const identity = internalRootIdentity(home, canopy);
    const source = identity.source;
    try {
      await mkdir(source, { recursive: true, mode: 0o700 });
      const repo = join(source, 'repository');
      await mkdir(repo);
      const git = (...args: string[]): string =>
        execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
      git('init', '-q', '-b', 'main');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'seed',
      );
      const oid = git('rev-parse', 'HEAD');
      const ref = 'refs/app/archived-containers/ws/tree/repo';
      if (binding !== 'cancelled-zero-refs') git('update-ref', ref, oid);
      const commonDir = join(repo, '.git');
      const stat = await lstat(commonDir);
      const store = new ArchiveRecoveryStore(source);
      const staged = store.stagingPath({
        workspaceId: 'ws',
        worktreeId: 'tree',
      });
      await mkdir(staged, { recursive: true });
      await writeFile(join(staged, 'only-copy'), 'unique retained content');
      const operationId = randomUUID();
      const workspace = join(source, 'workspaces/ws');
      await mkdir(workspace, { recursive: true });
      const workspaceInfo = await lstat(workspace);
      const checkout = join(workspace, 'worktrees/tree');
      if (binding === 'cancelled-keep')
        await mkdir(checkout, { recursive: true });
      const checkoutInfo =
        binding === 'cancelled-keep' ? await lstat(checkout) : null;
      const record = {
        version: 1,
        operationId,
        operation: 'worktree-archive',
        state: 'recovery-required',
        workspaceId: 'ws',
        worktreeId: 'tree',
        createdAt: '2026-11-01T00:00:00.000Z',
        directoryIdentity: `${workspaceInfo.dev}:${workspaceInfo.ino}:${workspaceInfo.birthtimeMs}`,
        steps: [],
        ownedPaths: checkoutInfo
          ? [
              {
                path: checkout,
                identity: `${checkoutInfo.dev}:${checkoutInfo.ino}:${checkoutInfo.birthtimeMs}`,
              },
            ]
          : [],
      };
      const contents = JSON.stringify(record);
      await mkdir(join(source, 'w5/destructive-lifecycles'), {
        recursive: true,
      });
      const sourceNames = [
        `${operationId}.json`,
        ...(binding.startsWith('cancelled-')
          ? [`${archiveRecoveryDigest(JSON.stringify(['ws', 'tree']))}.json`]
          : []),
      ].sort();
      for (const name of sourceNames)
        await writeFile(
          join(source, 'w5/destructive-lifecycles', name),
          contents,
        );
      if (binding === 'cancelled-absent-staging')
        await rm(staged, { recursive: true });
      let receipt = await store.prepare({
        workspaceId: 'ws',
        worktreeId: 'tree',
        operationId,
        action: binding === 'cancelled-keep' ? 'keep-worktree' : 'release',
        revision: 'a'.repeat(64),
        createdAt: '2026-11-01T00:00:00.000Z',
        copies: sourceNames.map((name) => ({
          name,
          contents,
          digest: archiveRecoveryDigest(contents),
        })),
        sourceRecord: record,
        capture: 'partial',
        repositories: [
          {
            repoId: 'repo',
            referenceRepoPath: repo,
            commonDir,
            identity: `${commonDir}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
            refs:
              binding === 'cancelled-zero-refs'
                ? []
                : [{ name: ref, objectId: oid }],
          },
        ],
      });
      const cancelled = binding.startsWith('cancelled-');
      if (cancelled) {
        if (binding === 'cancelled-release')
          receipt = await store.writeStage(receipt, 'retention-intent');
        else if (binding !== 'cancelled-keep')
          receipt = await store.publishRetention(receipt);
        if (binding === 'cancelled-zero-refs')
          receipt = await store.writeStage(receipt, 'reset-intent');
        receipt = await store.cancel(receipt);
      } else if (!binding.startsWith('unfinished-')) {
        receipt = await store.publishRetention(receipt);
        receipt = await store.resetStaging(receipt);
        receipt = await store.withdrawJournals(receipt);
        receipt = await store.writeStage(receipt, 'completed');
        expect(
          await readdir(join(store.directory(receipt), 'journals')),
        ).toEqual(receipt.copies.map((copy) => copy.name));
      }
      if (binding === 'cancelled-discard') {
        for (const copy of receipt.copies)
          await rm(join(source, 'w5/destructive-lifecycles', copy.name));
        await rm(staged, { recursive: true });
        const discardId = randomUUID();
        await writeFile(
          join(source, 'w5/destructive-lifecycles', `${discardId}.json`),
          JSON.stringify({
            ...receipt.sourceRecord,
            operationId: discardId,
            operation: 'worktree-delete',
            state: 'completed',
            steps: [
              { phase: `discard:supersede:${operationId}`, state: 'done' },
              { phase: 'discard:retire-superseded', state: 'done' },
            ],
          }),
        );
      }
      if (binding === 'publication-link') {
        await link(
          join(store.directory(receipt), 'receipt.json'),
          join(
            store.directory(receipt),
            `.receipt.json.123.${randomUUID()}.tmp`,
          ),
        );
      }
      if (
        binding === 'missing-checkout' ||
        binding === 'replaced-after-freeze'
      ) {
        receipt = {
          ...receipt,
          repositories: receipt.repositories.map((repository) => ({
            ...repository,
            referenceRepoPath: join(home, 'absent-linked-checkout'),
          })),
        };
        await writeFile(
          join(store.directory(receipt), 'receipt.json'),
          JSON.stringify(receipt),
        );
      }
      if (binding === 'partial-deletion' || binding === 'deleted') {
        receipt = await store.beginDeletion(receipt);
        git('update-ref', '-d', ref, oid);
        await rm(join(store.payloadPath(receipt), 'only-copy'));
        if (binding === 'deleted') receipt = await store.deletePayload(receipt);
      }
      const worker = createInternalRootMigrationWorker({
        ownedChildPath,
        recoverW5: () => Promise.resolve(),
        proveCold: () => Promise.resolve(),
      });
      const repairs = createInternalRootRelocationRepairs({
        durability: desktopW5Durability,
      });
      if (binding.startsWith('unfinished-')) {
        await writeFile(
          join(store.directory(receipt), 'receipt.json'),
          JSON.stringify({
            ...receipt,
            stage: binding.slice('unfinished-'.length),
          }),
        );
        await expect(
          migrateInternalRoot(
            worker,
            identity,
            { apply: true, declareInternal: true },
            repairs,
          ),
        ).rejects.toThrow('unfinished receipt');
        return;
      }
      if (binding === 'conflicting' || binding === 'replaced-after-freeze') {
        const replacedReference = join(
          home,
          binding === 'replaced-after-freeze'
            ? 'absent-linked-checkout'
            : 'replaced-reference',
        );
        const replaceReference = async (): Promise<void> => {
          await mkdir(replacedReference);
          execFileSync('git', [
            '-C',
            replacedReference,
            'init',
            '-q',
            '-b',
            'main',
          ]);
          execFileSync('git', [
            '-C',
            replacedReference,
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.invalid',
            'commit',
            '--allow-empty',
            '-m',
            'seed',
          ]);
        };
        const stale = {
          ...receipt,
          repositories: receipt.repositories.map((repository) => ({
            ...repository,
            referenceRepoPath: replacedReference,
          })),
        };
        const path = join(store.directory(receipt), 'receipt.json');
        const raw = JSON.stringify(stale);
        const guardedRepairs =
          binding === 'replaced-after-freeze'
            ? {
                ...repairs,
                prepare: async (
                  context: Parameters<typeof repairs.prepare>[0],
                ): ReturnType<typeof repairs.prepare> => {
                  const plan = await repairs.prepare(context);
                  await replaceReference();
                  return plan;
                },
              }
            : repairs;
        if (binding === 'conflicting') {
          await replaceReference();
          await writeFile(path, raw);
        }
        const original = await readFile(path, 'utf8');
        await expect(
          migrateInternalRoot(
            worker,
            identity,
            { apply: true, declareInternal: true },
            guardedRepairs,
          ),
        ).rejects.toThrow(
          'Internal root migration refused (repair-refused): Archive recovery reference repository common directory mismatch',
        );
        await expect(lstat(identity.destination)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(await readFile(path, 'utf8')).toBe(original);
        expect(
          await readFile(join(store.payloadPath(receipt), 'only-copy'), 'utf8'),
        ).toBe('unique retained content');
        expect(git('rev-parse', ref)).toBe(oid);
        return;
      }
      if (
        binding === 'cancelled-staging-tampered' ||
        binding === 'cancelled-journal-tampered'
      ) {
        let injected = false;
        await expect(
          migrateInternalRoot(
            worker,
            identity,
            { apply: true, declareInternal: true },
            {
              ...repairs,
              repair: async (context) => {
                const result = await repairs.repair(context);
                const copied = new ArchiveRecoveryStore(context.workingRoot);
                const path =
                  binding === 'cancelled-staging-tampered'
                    ? join(copied.stagingPath(receipt), 'only-copy')
                    : join(
                        context.workingRoot,
                        'w5/destructive-lifecycles',
                        `${operationId}.json`,
                      );
                await writeFile(path, `${await readFile(path, 'utf8')}\n`);
                injected = true;
                return result;
              },
            },
          ),
        ).rejects.toThrow(
          binding === 'cancelled-staging-tampered'
            ? 'changed cancelled staging'
            : 'changed copied cancelled journal',
        );
        expect(injected).toBe(true);
        await expect(lstat(identity.destination)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(await store.read('ws', operationId)).toEqual(receipt);
        expect((await store.inspect(receipt)).effectFree).toBe(true);
        expect(await readFile(join(staged, 'only-copy'), 'utf8')).toBe(
          'unique retained content',
        );
        expect(git('rev-parse', ref)).toBe(oid);
        return;
      }
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { apply: true, declareInternal: true },
          {
            ...repairs,
            qualifyPublished: async (context) => {
              await repairs.qualifyPublished(context);
              throw new Error('interrupted after publication');
            },
          },
        ),
      ).rejects.toThrow('interrupted after publication');
      expect(
        await migrateInternalRoot(
          worker,
          identity,
          { apply: true, declareInternal: true },
          repairs,
        ),
      ).toMatchObject({ kind: 'complete' });
      const copied = new ArchiveRecoveryStore(identity.destination);
      if (binding === 'cancelled-discard') {
        expect(await store.read('ws', operationId)).toBeNull();
        expect(await copied.read('ws', operationId)).toBeNull();
        return;
      }
      let hold = await copied.read('ws', receipt.operationId);
      if (!hold) throw new Error('Missing migrated hold');
      if (cancelled) {
        const live = await inventoryArchiveRecoveryTree(
          copied.stagingPath(hold),
        );
        expect(hold.staging).toEqual(live);
        if (receipt.staging)
          expect(hold.staging?.identity).not.toBe(receipt.staging.identity);
        const repoInfo = await lstat(
          join(identity.destination, 'repository/.git'),
        );
        expect(hold.repositories[0]?.identity).toBe(
          `${join(identity.destination, 'repository/.git')}:${repoInfo.dev}:${repoInfo.ino}:${repoInfo.birthtimeMs}`,
        );
        const journal = await readFile(
          join(
            identity.destination,
            'w5/destructive-lifecycles',
            `${operationId}.json`,
          ),
          'utf8',
        );
        const review = createHash('sha256');
        for (const copy of hold.copies) {
          expect(copy.contents).toBe(journal);
          expect(copy.digest).toBe(archiveRecoveryDigest(journal));
          review.update(copy.name).update('\0').update(journal).update('\0');
        }
        expect(hold.revision).toBe(review.digest('hex'));
        expect(hold.sourceRecord).toEqual(JSON.parse(journal));
        if (binding === 'cancelled-keep') {
          const movedCheckout = join(
            identity.destination,
            'workspaces/ws/worktrees/tree',
          );
          const info = await lstat(movedCheckout);
          expect(hold.sourceRecord.ownedPaths).toEqual([
            {
              path: movedCheckout,
              identity: `${info.dev}:${info.ino}:${info.birthtimeMs}`,
            },
          ]);
        }
        expect((await copied.inspect(hold)).effectFree).toBe(true);
        hold = await copied.restartCancelled(hold);
        hold = await copied.publishRetention(hold);
        hold = await copied.resetStaging(hold);
        hold = await copied.withdrawJournals(hold);
        hold = await copied.writeStage(hold, 'completed');
        if (receipt.staging) {
          expect(
            await readFile(join(copied.payloadPath(hold), 'only-copy'), 'utf8'),
          ).toBe('unique retained content');
          expect(
            await readFile(
              join(store.stagingPath(receipt), 'only-copy'),
              'utf8',
            ),
          ).toBe('unique retained content');
        } else
          expect(
            await inventoryArchiveRecoveryTree(copied.payloadPath(hold)),
          ).toBeNull();
        return;
      }
      expect(hold.repositories[0]?.commonDir).toBe(
        join(
          binding === 'deleted' ? source : identity.destination,
          'repository/.git',
        ),
      );
      expect(hold.repositories[0]?.refs).toEqual(receipt.repositories[0]?.refs);
      if (binding === 'partial-deletion' || binding === 'deleted') {
        await expect(
          readFile(join(copied.payloadPath(hold), 'only-copy')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(
          execFileSync(
            'git',
            [
              '-C',
              join(identity.destination, 'repository'),
              'for-each-ref',
              '--format=%(refname)',
              ref,
            ],
            { encoding: 'utf8' },
          ).trim(),
        ).toBe('');
      } else {
        expect(
          await readFile(join(copied.payloadPath(hold), 'only-copy'), 'utf8'),
        ).toBe('unique retained content');
        expect(
          execFileSync(
            'git',
            ['-C', join(identity.destination, 'repository'), 'rev-parse', ref],
            { encoding: 'utf8' },
          ).trim(),
        ).toBe(oid);
      }
      expect(
        (await worker.readJournal(identity))?.repairPlan?.archiveRecovery,
      ).toBeDefined();
      expect(
        await readFile(
          join(copied.directory(hold), 'journals', `${operationId}.json`),
          'utf8',
        ),
      ).toBe(contents);
      hold = await copied.beginDeletion(hold);
      hold = await copied.deletePayload(hold);
      expect(hold.retention).toBe('deleted');
      if (binding !== 'partial-deletion' && binding !== 'deleted') {
        expect(
          await readFile(join(store.payloadPath(receipt), 'only-copy'), 'utf8'),
        ).toBe('unique retained content');
        expect(git('rev-parse', ref)).toBe(oid);
      }
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      await rm(home, { recursive: true, force: true });
    }
  },
  30_000,
);
