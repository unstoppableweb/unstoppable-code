// CAN-7051: the daemon's worktree terminal record authority. Import on the
// first write-authorized touch, at-most-once producer batches, generations and
// incarnations, lazy reconciliation after a daemon death, shutdown stamps,
// layout rebasing and byte-bounded history pages.
import { createHash } from 'node:crypto';
// The module itself, so a spy reaches the repository's reads.
import fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import {
  WORKER_TERMINAL_INSTRUCTION_DEFINITIONS,
  WORKER_TERMINAL_SESSION_INSTRUCTION_DEFINITIONS,
  WorkerTerminalCreateParamsSchema,
  WorkerTerminalRestoreParamsSchema,
  WorkerTerminalKillParamsSchema,
  WorkerTerminalReleaseParamsSchema,
  WorkerTerminalRecordRetireParamsSchema,
  WorkerTerminalRecordApplyParamsSchema,
  WorkerTerminalRecordHistoryReadParamsSchema,
  WorkerTerminalRecordHistoryReadResultSchema,
  WorkerTerminalRecordOpenResultSchema,
  WorkerTerminalRecordShutdownParamsSchema,
  type WorkerTerminalRecordClient,
} from '@canopy/protocol/canopy-core';
import type { TerminalSession } from '@canopy/protocol/terminal';
import {
  TerminalRecordAuthority as RecordAuthority,
  type TerminalRecordAttribution,
  type TerminalRecordRegistration,
} from '../authority';
import {
  isTerminalRecordEnvelope,
  TerminalRecordRepository,
  type TerminalRecordEnvelope,
} from '../repository';
import { legacyTerminalStatePath, terminalRecordDir } from '../paths';
import { createEmptyState } from '../codec';
import * as storage from '../../../../storage';
import { normalizeCustomNameMap, normalizePersistedState } from '../codec';

const authorities = new Set<RecordAuthority>();
class TerminalRecordAuthority extends RecordAuthority {
  // Existing scenes address the latest successful registration by name. Identity
  // scenes below retain the returned handle, as the integrating host must do.
  private readonly handles = new Map<string, TerminalRecordRegistration>();
  public override attribute(
    input: TerminalRecordAttribution,
  ): TerminalRecordRegistration | undefined {
    const handle = super.attribute(input);
    if (handle !== undefined) this.handles.set(input.terminalId, handle);
    return handle;
  }
  public override output(
    handle: string | TerminalRecordRegistration | undefined,
    data: Uint8Array,
  ): void {
    super.output(
      typeof handle === 'string' ? this.handles.get(handle) : handle,
      data,
    );
  }
  public override exited(
    handle: string | TerminalRecordRegistration | undefined,
    code: number | null,
    signal: string | null,
  ): void {
    super.exited(
      typeof handle === 'string' ? this.handles.get(handle) : handle,
      code,
      signal,
    );
  }
  public constructor(
    options: ConstructorParameters<typeof RecordAuthority>[0],
  ) {
    super(options);
    authorities.add(this);
  }
}

const client = {
  projectId: 'proj',
  worktreeId: 'wt',
  legacyLayout: 'workspaces' as const,
  incarnation: 'inc-1',
};

function session(
  id: string,
  extra: Partial<TerminalSession> = {},
): TerminalSession {
  return {
    id,
    projectId: 'proj',
    worktreeId: 'wt',
    shell: '/bin/zsh',
    shellBasename: 'zsh',
    cwd: '/tmp',
    createdAt: 1,
    ...extra,
  };
}

let root: string;

const make = (): TerminalRecordAuthority =>
  new TerminalRecordAuthority({
    repository: new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (): void => undefined,
    }),
    installDebounceMs: 1,
  });
const recordFile = (): string =>
  join(terminalRecordDir(root, 'proj', 'wt'), 'record.json');
const record = (): TerminalRecordEnvelope => {
  const value: unknown = JSON.parse(readFileSync(recordFile(), 'utf8'));
  if (!isTerminalRecordEnvelope(value)) throw new Error('Expected a record');
  return value;
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonObject(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isJsonObject(value)) throw new Error('Expected a JSON object');
  return value;
}

describe('R30 record ownership and observational query scope', () => {
  describe.each(['bound', 'held'] as const)('%s registrations', (timing) => {
    it.each([
      ['non-persisting', false, 'shell'],
      ['non-drawer', true, 'claude-code'],
    ] as const)(
      'keeps saved ownership with the persisted handle after a %s replacement',
      (_label, persist, kind) => {
        let blocked = timing === 'held';
        class DelayedRepository extends TerminalRecordRepository {
          public override load(
            ...args: Parameters<TerminalRecordRepository['load']>
          ): ReturnType<TerminalRecordRepository['load']> {
            if (blocked) throw new Error('record unavailable');
            return super.load(...args);
          }
        }
        const authority = new TerminalRecordAuthority({
          repository: new DelayedRepository({
            dataRoot: root,
            flushDirectorySync: (): void => undefined,
          }),
        });
        const original = authority.attribute({
          terminalId: 't',
          client,
          session: session('t', { title: 'saved' }),
          persist: true,
        });
        authority.output(original, Buffer.from('saved'));
        const replacement = authority.attribute({
          terminalId: 't',
          client,
          session: session('t', { kind, title: 'ignored' }),
          persist,
        });
        authority.output(replacement, Buffer.from('ignored'));
        blocked = false;
        authority.open(client);
        expect(authority.isAttributed('t')).toBe(true);
        authority.output(original, Buffer.from('-tail'));
        authority.exited(original, 23, null);
        // The public route remains the replacement, not the saved record owner.
        expect(authority.isAttributed('t')).toBe(true);
        authority.flushSync();
        expect(record().hostTerminals).toEqual([]);
        const reload = make();
        expect(reload.open(client).terminals[0]).toMatchObject({
          session: { title: 'saved' },
          exitCode: 23,
          signal: null,
        });
        expect(reload.historyRead({ client, terminalId: 't' }).text).toBe(
          'saved-tail',
        );
        authority.exited(replacement, 0, 'SIGTERM');
        expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
        expect(make().open(client).terminals[0].exitCode).toBe(23);
      },
    );
  });

  it('stamps the persisted owner even after the non-persisting public route exits', () => {
    const authority = make();
    const original = authority.attribute({
      terminalId: 't',
      client,
      session: session('t'),
      persist: true,
    });
    const replacement = authority.attribute({
      terminalId: 't',
      client,
      session: session('t'),
      persist: false,
    });
    authority.exited(replacement, 0, null);
    expect(authority.shutdown('app-quit')).toEqual({ stamped: 1 });
    authority.exited(original, 9, null);
    authority.flushSync();
    expect(make().open(client).terminals[0]).toMatchObject({
      exitCode: null,
      signal: 'app-quit',
    });
  });

  it('rejoins the persisted owner rather than a non-persisting public route', () => {
    const authority = make();
    const original = authority.attribute({
      terminalId: 't',
      client,
      session: session('t', { title: 'saved' }),
      persist: true,
    });
    authority.attribute({
      terminalId: 't',
      client,
      session: session('t', { title: 'ignored' }),
      persist: false,
    });
    authority.apply({
      client,
      producer: { id: 'main', runId: 'rejoin' },
      seq: 1,
      ops: [
        { op: 'forget', terminalId: 't' },
        {
          op: 'layout.save',
          servedIds: [],
          referencedIds: ['t'],
          bindings: [],
          terminalCustomNames: {},
        },
      ],
    });
    expect(record().hostTerminals).toEqual(['t']);
    expect(authority.open(client).terminals[0].session.title).toBe('saved');
    authority.output(original, Buffer.from('rejoined'));
    authority.exited(original, 23, null);
    authority.flushSync();
    expect(make().historyRead({ client, terminalId: 't' }).text).toBe(
      'rejoined',
    );
    expect(make().open(client).terminals[0].exitCode).toBe(23);
  });

  it.each(['historyRead', 'historyTail', 'open', 'apply'] as const)(
    '%s checks stale generations before replay and preserves current-entry replay scope',
    (query) => {
      const run = (withQuery: boolean): string[] => {
        const dataRoot = join(root, withQuery ? 'query' : 'control');
        let blocked = false;
        class DelayedRepository extends TerminalRecordRepository {
          public override load(
            ...args: Parameters<TerminalRecordRepository['load']>
          ): ReturnType<TerminalRecordRepository['load']> {
            if (blocked) throw new Error('record unavailable');
            return super.load(...args);
          }
        }
        const repository = new DelayedRepository({
          dataRoot,
          now: (): number => 100,
          flushDirectorySync: (): void => undefined,
        });
        const clients = ['wt', 'other'].map((worktreeId) => ({
          ...client,
          worktreeId,
          generation: 2,
        }));
        const files = clients.map((scope) =>
          join(
            terminalRecordDir(dataRoot, scope.projectId, scope.worktreeId),
            'record.json',
          ),
        );
        for (const scope of clients) {
          const envelope = repository.empty(scope, 'none');
          envelope.lineage = 'observational';
          envelope.startedAt = 100;
          repository.save(envelope);
        }
        const before = files.map((file) => readFileSync(file, 'utf8'));
        const authority = new TerminalRecordAuthority({ repository });
        blocked = true;
        for (const scope of clients) {
          const handle = authority.attribute({
            terminalId: scope.worktreeId,
            client: scope,
            session: session(scope.worktreeId, {
              worktreeId: scope.worktreeId,
            }),
            persist: true,
          });
          authority.output(handle, Buffer.from(`held-${scope.worktreeId}`));
          authority.exited(handle, 7, null);
        }
        blocked = false;
        const read = (generation: number): void => {
          const current = { ...clients[0], generation };
          if (query === 'historyRead')
            expect(
              authority.historyRead({ client: current, terminalId: 'wt' }).text,
            ).toBe(generation === 1 ? '' : 'held-wt');
          else if (query === 'historyTail')
            expect(authority.historyTail(current, 'wt', 100)).toBe(
              generation === 1 ? '' : 'held-wt',
            );
          else if (query === 'open')
            expect(authority.open(current).terminals).toHaveLength(
              generation === 1 ? 0 : 1,
            );
          else
            expect(
              authority.apply({
                client: current,
                producer: { id: 'reader', runId: 'one' },
                seq: 1,
                ops: [],
              }).outcome,
            ).toBe(generation === 1 ? 'dropped' : 'applied');
        };
        if (withQuery) read(1);
        authority.flushSync();
        const afterStale = files.map((file) => readFileSync(file, 'utf8'));
        expect(afterStale).toEqual(before);
        if (withQuery) {
          read(2);
          authority.flushSync();
          const isQuery = query === 'historyRead' || query === 'historyTail';
          if (isQuery) expect(readFileSync(files[1], 'utf8')).toBe(before[1]);
          const reload = new TerminalRecordAuthority({
            repository: new TerminalRecordRepository({
              dataRoot,
              flushDirectorySync: (): void => undefined,
            }),
          });
          expect(
            reload.historyRead({ client: clients[0], terminalId: 'wt' }).text,
          ).toBe('held-wt');
          expect(
            reload.historyRead({ client: clients[1], terminalId: 'other' })
              .text,
          ).toBe(isQuery ? '' : 'held-other');
        }
        return afterStale;
      };
      expect(run(true)).toEqual(run(false));
    },
  );
});

describe('R29 retirement evidence and registration ownership', () => {
  it('recovers names-only evidence without fencing unlisted legacy imports', () => {
    const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 2,
        lineage: 'recovery-legacy',
        bindings: [],
        terminalCustomNames: {},
        terminals: [
          {
            session: session('t'),
            scrollbackLines: ['legacy history'],
            exitCode: null,
            signal: null,
          },
        ],
      }),
    );
    const authority = make();
    authority.retire({
      projectId: 'proj',
      worktreeId: 'wt',
      lifetimeIds: ['old'],
    });
    const unlisted = { ...client, lifetimeId: 'unlisted' };
    expect(
      authority.historyRead({ client: unlisted, terminalId: 't' }).text,
    ).toBe('legacy history');
    authority.dispose();
    writeFileSync(
      recordFile(),
      JSON.stringify({
        scope: { projectId: 'proj', worktreeId: 'wt' },
        generation: 'damaged',
        retiredLifetimeIds: ['other'],
      }),
    );
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (): void => undefined,
    });
    const recovered = repository.load('proj', 'wt', 'recover');
    expect(recovered.kind).toBe('absent');
    if (recovered.kind !== 'absent')
      throw new Error('Expected recovered fence');
    expect(recovered.tombstone).toMatchObject({
      generation: 0,
      namedOnly: true,
      retiredLifetimeIds: ['old', 'other'],
    });
    const reload = make();
    expect(reload.open(unlisted).import.from).toBe('v2');
    expect(reload.historyRead({ client: unlisted, terminalId: 't' }).text).toBe(
      'legacy history',
    );
    expect(
      reload.historyRead({
        client: { ...client, lifetimeId: 'other' },
        terminalId: 't',
      }).text,
    ).toBe('');
  });

  it('retains qualified backup cleanup through damaged-record recovery and retry', () => {
    const authority = make();
    authority.open({ ...client, lifetimeId: 'old' });
    const backup = join(dirname(recordFile()), 'import-source.json');
    writeFileSync(backup, 'old backup');
    const intent = {
      projectId: 'proj',
      worktreeId: 'wt',
      lifetimeIds: ['old'],
    };
    const remove = fs.rmSync;
    const blocked = jest
      .spyOn(fs, 'rmSync')
      .mockImplementation((path, options) => {
        if (path === backup) throw new Error('cleanup blocked R29');
        remove(path, options);
      });
    try {
      expect(() => authority.retire(intent)).toThrow('cleanup blocked R29');
      const tombstone = join(dirname(recordFile()), 'tombstone.json');
      const identities = readJsonObject(tombstone).cleanupFiles;
      authority.dispose();
      const damaged = readJsonObject(recordFile());
      damaged.revision = 'damaged';
      writeFileSync(recordFile(), JSON.stringify(damaged));
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      repository.load('proj', 'wt', 'recover');
      expect(readJsonObject(tombstone).cleanupFiles).toEqual(identities);
      blocked.mockRestore();
      expect(make().retire(intent)).toEqual({ retired: 1 });
      expect(existsSync(backup)).toBe(false);
    } finally {
      blocked.mockRestore();
    }
  });

  it('releases an unpersisted registration exit without changing a reused saved ID', () => {
    const authority = make();
    authority.apply({
      client,
      producer: { id: 'saved', runId: 'one' },
      seq: 1,
      ops: [
        { op: 'session.upsert', session: session('t') },
        { op: 'output.append', terminalId: 't', text: 'saved history' },
        { op: 'exit', terminalId: 't', exitCode: 7, signal: null },
      ],
    });
    const before = readFileSync(recordFile(), 'utf8');
    const handle = authority.attribute({
      client,
      terminalId: 't',
      session: session('t'),
      persist: false,
    });
    authority.output(handle, Buffer.from('ignored'));
    authority.exited(handle, 0, 'SIGTERM');
    authority.flushSync();
    expect(readFileSync(recordFile(), 'utf8')).toBe(before);
    expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
    const reload = make();
    expect(reload.open(client).terminals[0]).toMatchObject({
      exitCode: 7,
      signal: null,
    });
    expect(reload.historyRead({ client, terminalId: 't' }).text).toBe(
      'saved history',
    );
  });
});

describe('R28 named coverage and qualified cleanup', () => {
  it('previews and imports unlisted legacy history after named-only retirement and reload', () => {
    const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
    mkdirSync(dirname(legacy), { recursive: true });
    const bytes = JSON.stringify({
      version: 2,
      lineage: 'unlisted-legacy',
      bindings: [],
      terminalCustomNames: {},
      terminals: [
        {
          session: session('t'),
          scrollbackLines: ['legacy history'],
          exitCode: null,
          signal: null,
        },
      ],
    });
    writeFileSync(legacy, bytes);
    const authority = make();
    expect(
      authority.retire({
        projectId: 'proj',
        worktreeId: 'wt',
        lifetimeIds: ['old'],
      }),
    ).toEqual({ retired: 1 });
    authority.dispose();
    const reload = make();
    const unlisted = { ...client, lifetimeId: 'unlisted' };
    expect(reload.historyRead({ client: unlisted, terminalId: 't' }).text).toBe(
      'legacy history',
    );
    expect(
      reload.historyRead({
        client: { ...client, lifetimeId: 'old' },
        terminalId: 't',
      }).text,
    ).toBe('');
    expect(reload.open(unlisted).import.from).toBe('v2');
    rmSync(legacy);
    reload.dispose();
    expect(make().historyRead({ client: unlisted, terminalId: 't' }).text).toBe(
      'legacy history',
    );
    expect(
      make().apply({
        client: { ...client, lifetimeId: 'old' },
        producer: { id: 'old', runId: 'one' },
        seq: 1,
        ops: [],
      }).outcome,
    ).toBe('dropped');
    const backupBytes = readJsonObject(
      join(dirname(recordFile()), 'import-source.json'),
    ).bytes;
    if (typeof backupBytes !== 'string')
      throw new Error('Expected backup bytes');
    expect(Buffer.from(backupBytes, 'base64').toString('utf8')).toBe(bytes);
  });

  it.each(['cached', 'reloaded'] as const)(
    'a stale open behind a %s names-only tombstone never settles the import an unlisted lifetime still previews (R40)',
    (state): void => {
      const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
      mkdirSync(dirname(legacy), { recursive: true });
      const bytes = JSON.stringify({
        version: 2,
        lineage: 'unlisted-legacy',
        bindings: [],
        terminalCustomNames: {},
        terminals: [
          {
            session: session('t'),
            scrollbackLines: ['legacy history'],
            exitCode: null,
            signal: null,
          },
        ],
      });
      writeFileSync(legacy, bytes);
      const retiring = make();
      expect(
        retiring.retire({
          projectId: 'proj',
          worktreeId: 'wt',
          lifetimeIds: ['old'],
        }),
      ).toEqual({ retired: 1 });
      if (state === 'reloaded') retiring.dispose();
      const authority = state === 'cached' ? retiring : make();
      const stale = authority.open({ ...client, lifetimeId: 'old' });
      expect(stale.terminals).toEqual([]);
      // Nothing was imported for this lifetime, so nothing may be fenced.
      expect(stale.import).toEqual({
        from: 'none',
        sourceSha256: null,
        pending: true,
      });
      expect(existsSync(recordFile())).toBe(false);
      expect(readFileSync(legacy, 'utf8')).toBe(bytes);
      const unlisted = { ...client, lifetimeId: 'unlisted' };
      expect(
        authority.historyRead({ client: unlisted, terminalId: 't' }).text,
      ).toBe('legacy history');
      const current = authority.open(unlisted);
      expect(current.import.from).toBe('v2');
      expect(current.import.pending).toBeUndefined();
      expect(
        authority.historyRead({ client: unlisted, terminalId: 't' }).text,
      ).toBe('legacy history');
    },
  );

  it.each(['same owner', 'reload', 'coverage extension'])(
    'retries qualified cleanup before acknowledging named-only %s',
    (mode) => {
      let authority = make();
      authority.apply({
        client: { ...client, lifetimeId: 'old' },
        producer: { id: 'old', runId: 'one' },
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('t') },
          { op: 'output.append', terminalId: 't', text: 'retiring history' },
        ],
      });
      const file = recordFile();
      const backup = join(dirname(file), 'import-source.json');
      writeFileSync(backup, 'retiring backup');
      const intent = {
        projectId: 'proj',
        worktreeId: 'wt',
        lifetimeIds: ['old'],
      };
      const remove = fs.rmSync;
      const spy = jest
        .spyOn(fs, 'rmSync')
        .mockImplementation((path, options) => {
          if (path === file || path === backup)
            throw new Error('cleanup blocked R28');
          remove(path, options);
        });
      try {
        expect(() => authority.retire(intent)).toThrow('cleanup blocked R28');
        const tombstone = join(dirname(file), 'tombstone.json');
        const saved = readJsonObject(tombstone).cleanupFiles;
        const identity: unknown = expect.any(String);
        expect(saved).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'record.json',
              identity,
            }),
          ]),
        );
        if (mode === 'reload') {
          authority.dispose();
          authority = make();
        }
        const retry =
          mode === 'coverage extension'
            ? { ...intent, lifetimeIds: ['other'] }
            : intent;
        expect(() => authority.retire(retry)).toThrow('cleanup blocked R28');
        expect(readJsonObject(tombstone).cleanupFiles).toEqual(saved);
        expect(existsSync(file)).toBe(true);
        spy.mockRestore();
        expect(authority.retire(retry)).toEqual({ retired: 1 });
        expect(existsSync(file)).toBe(false);
        expect(existsSync(backup)).toBe(false);
        authority.dispose();
        const reload = make();
        for (const lifetimeId of [
          'old',
          ...(mode === 'coverage extension' ? ['other'] : []),
        ])
          expect(
            reload.apply({
              client: { ...client, lifetimeId },
              producer: { id: 'late', runId: lifetimeId },
              seq: 1,
              ops: [],
            }).outcome,
          ).toBe('dropped');
      } finally {
        spy.mockRestore();
      }
    },
  );
});

describe('R26 destructive operations require target identity', (): void => {
  it.each([false, true])(
    'keeps records missing startedAt when only a cutoff is supplied (pending import=%s)',
    (pending): void => {
      const next = { ...client, lifetimeId: 'next' };
      const producer = { id: 'next', runId: 'one' };
      const authority = make();
      authority.apply({
        client: next,
        producer,
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('t') },
          {
            op: 'output.append',
            terminalId: 't',
            text: 'legacy record history',
          },
        ],
      });
      authority.dispose();
      const envelope = record();
      delete envelope.startedAt;
      if (pending) envelope.import.pending = true;
      writeFileSync(recordFile(), JSON.stringify(envelope));
      const reload = make();
      if (pending) reload.open(next);
      expect(
        reload.retire({
          projectId: 'proj',
          worktreeId: 'wt',
          requestedAt: Date.now() + 1000,
        }),
      ).toEqual({ retired: 0 });
      expect(reload.historyRead({ client: next, terminalId: 't' }).text).toBe(
        'legacy record history',
      );
      expect(
        reload.apply({
          client: next,
          producer,
          seq: 2,
          ops: [{ op: 'output.append', terminalId: 't', text: '-writable' }],
        }).outcome,
      ).toBe('applied');
      expect(make().historyRead({ client: next, terminalId: 't' }).text).toBe(
        'legacy record history-writable',
      );
      expect(
        reload.retire({
          projectId: 'proj',
          worktreeId: 'wt',
          lifetimeIds: ['next'],
        }),
      ).toEqual({ retired: 1 });
    },
  );

  it.each([50, 51])(
    'cutoff %s requires strict record timestamp order',
    (requestedAt): void => {
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        now: (): number => 50,
        flushDirectorySync: (): void => undefined,
      });
      const authority = new TerminalRecordAuthority({
        repository,
        now: (): number => 50,
      });
      const next = { ...client, lifetimeId: 'next' };
      authority.apply({
        client: next,
        producer: { id: 'next', runId: 'one' },
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('t') },
          { op: 'output.append', terminalId: 't', text: 'successor' },
        ],
      });
      expect(
        authority.retire({ projectId: 'proj', worktreeId: 'wt', requestedAt }),
      ).toEqual({ retired: requestedAt === 50 ? 0 : 1 });
      expect(make().historyRead({ client: next, terminalId: 't' }).text).toBe(
        requestedAt === 50 ? 'successor' : '',
      );
      if (requestedAt === 50) {
        expect(record().lifetimeIds).toEqual(['next']);
        expect(
          authority.retire({
            projectId: 'proj',
            worktreeId: 'wt',
            requestedAt,
            lifetimeIds: ['old'],
          }),
        ).toEqual({ retired: 0 });
        expect(record().retiredLifetimeIds).toEqual(['old']);
        expect(
          authority.apply({
            client: next,
            producer: { id: 'next', runId: 'one' },
            seq: 2,
            ops: [{ op: 'output.append', terminalId: 't', text: '-writable' }],
          }).outcome,
        ).toBe('applied');
      }
    },
  );

  it('empty named-only retirement leaves an unimported scope observational', (): void => {
    const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
    mkdirSync(dirname(legacy), { recursive: true });
    const bytes = JSON.stringify({
      version: 2,
      lineage: 'legacy',
      bindings: [],
      terminalCustomNames: {},
      terminals: [
        {
          session: session('t'),
          scrollbackLines: ['unimported history'],
          exitCode: null,
          signal: null,
        },
      ],
    });
    writeFileSync(legacy, bytes);
    expect(
      make().retire({ projectId: 'proj', worktreeId: 'wt', lifetimeIds: [] }),
    ).toEqual({ retired: 0 });
    expect(existsSync(dirname(recordFile()))).toBe(false);
    expect(make().historyRead({ client, terminalId: 't' }).text).toBe(
      'unimported history',
    );
    expect(readFileSync(legacy, 'utf8')).toBe(bytes);
  });

  it.each([{ ids: ['old'] }, { ids: [] }, { ids: ['old', 'other'] }])(
    'keeps successor history for unmatched named-only retirement %j',
    ({ ids }): void => {
      const next = { ...client, lifetimeId: 'next' };
      const authority = make();
      authority.apply({
        client: next,
        producer: { id: 'writer', runId: 'next' },
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('t') },
          { op: 'output.append', terminalId: 't', text: 'successor' },
        ],
      });
      for (let attempt = 0; attempt < 2; attempt += 1)
        expect(
          authority.retire({
            projectId: 'proj',
            worktreeId: 'wt',
            lifetimeIds: ids,
          }),
        ).toEqual({ retired: ids.length ? 1 : 0 });
      expect(existsSync(join(dirname(recordFile()), 'tombstone.json'))).toBe(
        false,
      );
      expect(record().lifetimeIds).toEqual(['next']);
      expect(record().retiredLifetimeIds ?? []).toEqual(ids);
      authority.dispose();
      const reload = make();
      expect(reload.historyRead({ client: next, terminalId: 't' }).text).toBe(
        'successor',
      );
      for (const lifetimeId of ids)
        expect(
          reload.apply({
            client: { ...client, lifetimeId },
            producer: { id: 'old', runId: lifetimeId },
            seq: 1,
            ops: [{ op: 'output.append', terminalId: 't', text: '-old' }],
          }).outcome,
        ).toBe('dropped');
      expect(
        reload.apply({
          client: next,
          producer: { id: 'writer', runId: 'next' },
          seq: 2,
          ops: [{ op: 'output.append', terminalId: 't', text: '-writable' }],
        }).outcome,
      ).toBe('applied');
      expect(make().historyRead({ client: next, terminalId: 't' }).text).toBe(
        'successor-writable',
      );
    },
  );

  it('retires a named-only current lifetime', (): void => {
    const authority = make();
    authority.open({ ...client, lifetimeId: 'current' });
    expect(
      authority.retire({
        projectId: 'proj',
        worktreeId: 'wt',
        lifetimeIds: ['current'],
      }),
    ).toEqual({ retired: 1 });
    expect(existsSync(recordFile())).toBe(false);
  });

  it.each(['absent', 'damaged'])(
    'retains unproven artifacts for named-only retirement of an %s scope',
    (state): void => {
      const directory = dirname(recordFile());
      mkdirSync(directory, { recursive: true });
      const artifact = join(directory, 'record.json.damaged-1');
      writeFileSync(artifact, 'unproven history');
      const backup = join(directory, 'import-source.json');
      writeFileSync(backup, 'unproven backup');
      if (state === 'damaged') writeFileSync(recordFile(), '{damaged');
      const authority = make();
      for (let attempt = 0; attempt < 2; attempt += 1)
        expect(
          authority.retire({
            projectId: 'proj',
            worktreeId: 'wt',
            lifetimeIds: ['old'],
          }),
        ).toEqual({ retired: 1 });
      expect(existsSync(artifact)).toBe(true);
      expect(readFileSync(artifact, 'utf8')).toBe('unproven history');
      expect(readFileSync(backup, 'utf8')).toBe('unproven backup');
      // Retirement is observational: the damaged record stays in place.
      if (state === 'damaged') {
        expect(existsSync(recordFile())).toBe(true);
        expect(readFileSync(recordFile(), 'utf8')).toBe('{damaged');
      }
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      const loaded = repository.load('proj', 'wt');
      expect(loaded.kind).toBe('absent');
      expect(loaded.tombstone).toMatchObject({
        cleanupFiles: [],
        retiredLifetimeIds: ['old'],
        damaged: true,
        retiredAt: 0,
      });
      repository.retryRetirement('proj', 'wt');
      expect(readFileSync(artifact, 'utf8')).toBe('unproven history');
      authority.dispose();
      const reload = make();
      expect(
        reload.apply({
          client: { ...client, lifetimeId: 'old' },
          producer: { id: 'old', runId: 'one' },
          seq: 1,
          ops: [],
        }).outcome,
      ).toBe('dropped');
      expect(
        reload.apply({
          client: { ...client, lifetimeId: 'next' },
          producer: { id: 'next', runId: 'one' },
          seq: 1,
          ops: [
            { op: 'session.upsert', session: session('t') },
            { op: 'output.append', terminalId: 't', text: 'successor' },
          ],
        }).outcome,
      ).toBe('applied');
      // The successor's write-authorized load sets the damaged record aside.
      if (state === 'damaged') {
        const quarantined = readdirSync(directory).filter(
          (name): boolean =>
            name.startsWith('record.json.damaged-') &&
            name !== 'record.json.damaged-1',
        );
        expect(quarantined).toHaveLength(1);
        expect(readFileSync(join(directory, quarantined[0]), 'utf8')).toBe(
          '{damaged',
        );
      }
      expect(
        make().historyRead({
          client: { ...client, lifetimeId: 'next' },
          terminalId: 't',
        }).text,
      ).toBe('successor');
      expect(readFileSync(artifact, 'utf8')).toBe('unproven history');
      expect(readFileSync(backup, 'utf8')).toBe('unproven backup');
    },
  );

  it.each([false, true])(
    'keeps successor history beside a predecessor backup (successor imported=%s)',
    (imported): void => {
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
      mkdirSync(dirname(legacy), { recursive: true });
      const legacyBytes = (text: string): string =>
        JSON.stringify({
          version: 2,
          lineage: text,
          bindings: [],
          terminalCustomNames: {},
          terminals: [
            {
              session: session('t'),
              scrollbackLines: [text],
              exitCode: null,
              signal: null,
            },
          ],
        });
      writeFileSync(legacy, legacyBytes('predecessor'));
      const predecessor = new TerminalRecordAuthority({ repository });
      predecessor.open({ ...client, lifetimeId: 'old' });
      const backup = join(dirname(recordFile()), 'import-source.json');
      const oldBackup = readFileSync(backup);
      predecessor.retire({
        projectId: 'proj',
        worktreeId: 'wt',
        lifetimeIds: ['old'],
      });
      predecessor.dispose();
      // No authority path invokes offline recovery today. Exercise authority
      // imports and reloads on both sides of the helper instead of inventing one.
      if (imported) {
        rmSync(join(dirname(recordFile()), 'tombstone.json'));
        writeFileSync(legacy, legacyBytes('successor'));
      }
      const next = { ...client, incarnation: 'inc-2', lifetimeId: 'next' };
      const successor = new TerminalRecordAuthority({ repository });
      successor.open(next);
      successor.apply({
        client: next,
        producer: { id: 'next', runId: 'one' },
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('t') },
          { op: 'output.replace', terminalId: 't', lines: ['successor'] },
        ],
      });
      successor.dispose();
      writeFileSync(backup, oldBackup);
      const before = readFileSync(recordFile());
      expect(repository.takeLegacyBackup('proj', 'wt')).toBeNull();
      expect(readFileSync(backup)).toEqual(oldBackup);
      expect(readFileSync(recordFile())).toEqual(before);
      const reload = make();
      expect(reload.historyRead({ client: next, terminalId: 't' }).text).toBe(
        'successor',
      );
      expect(
        reload.apply({
          client: next,
          producer: { id: 'next', runId: 'one' },
          seq: 2,
          ops: [{ op: 'output.append', terminalId: 't', text: '-writable' }],
        }).outcome,
      ).toBe('applied');
      expect(make().historyRead({ client: next, terminalId: 't' }).text).toBe(
        'successor-writable',
      );
    },
  );

  it('keeps replaced and unidentifiable artifacts during initial retirement cleanup', (): void => {
    let replace = false;
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (): void => {
        if (
          !replace ||
          !existsSync(join(dirname(recordFile()), 'tombstone.json'))
        )
          return;
        replace = false;
        writeFileSync(
          join(dirname(recordFile()), 'record.json.damaged-1'),
          'replacement',
        );
      },
    });
    const authority = new TerminalRecordAuthority({ repository });
    authority.open({ ...client, lifetimeId: 'current' });
    const artifact = join(dirname(recordFile()), 'record.json.damaged-1');
    writeFileSync(artifact, 'retired');
    const unknown = join(dirname(recordFile()), 'unidentified');
    mkdirSync(unknown);
    writeFileSync(join(unknown, 'history'), 'unidentified history');
    replace = true;
    authority.retire({
      projectId: 'proj',
      worktreeId: 'wt',
      lifetimeIds: ['current'],
    });
    expect(existsSync(artifact)).toBe(true);
    expect(readFileSync(artifact, 'utf8')).toBe('replacement');
    expect(existsSync(join(unknown, 'history'))).toBe(true);
    expect(readFileSync(join(unknown, 'history'), 'utf8')).toBe(
      'unidentified history',
    );
    repository.retryRetirement('proj', 'wt');
    expect(readFileSync(artifact, 'utf8')).toBe('replacement');
    expect(readFileSync(join(unknown, 'history'), 'utf8')).toBe(
      'unidentified history',
    );
    expect(existsSync(recordFile())).toBe(false);
  });

  it('preserves the previous backup when recovery imports a different source', (): void => {
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (): void => undefined,
    });
    const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
    mkdirSync(dirname(legacy), { recursive: true });
    const legacyBytes = (text: string): string =>
      JSON.stringify({
        version: 2,
        lineage: text,
        bindings: [],
        terminalCustomNames: {},
        terminals: [
          {
            session: session('t'),
            scrollbackLines: [text],
            exitCode: null,
            signal: null,
          },
        ],
      });
    writeFileSync(legacy, legacyBytes('predecessor'));
    const old = new TerminalRecordAuthority({ repository });
    old.open(client);
    old.dispose();
    const directory = dirname(recordFile());
    const backup = readFileSync(join(directory, 'import-source.json'));
    writeFileSync(recordFile(), '{damaged');
    writeFileSync(legacy, legacyBytes('successor'));
    const next = new TerminalRecordAuthority({ repository });
    expect(
      next.open(client).terminals.map((entry): string => entry.session.id),
    ).toEqual(['t']);
    expect(next.historyRead({ client, terminalId: 't' }).text).toBe(
      'successor',
    );
    const preserved = readdirSync(directory).filter((name): boolean =>
      name.startsWith('legacy-terminal-state.json.damaged-'),
    );
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(directory, preserved[0]))).toEqual(backup);
    next.dispose();
    expect(repository.takeLegacyBackup('proj', 'wt')?.toString()).toBe(
      legacyBytes('successor'),
    );
  });

  it('keeps every damaged legacy recovery copy when the clock repeats', (): void => {
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      now: (): number => 10,
      flushDirectorySync: (): void => undefined,
    });
    const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, '{first');
    new TerminalRecordAuthority({ repository }).open(client);
    rmSync(recordFile());
    writeFileSync(legacy, '{second');
    new TerminalRecordAuthority({ repository }).open(client);
    const directory = dirname(recordFile());
    const preserved = readdirSync(directory).filter((name): boolean =>
      name.startsWith('legacy-terminal-state.json.damaged-'),
    );
    expect(preserved).toHaveLength(2);
    expect(
      preserved
        .sort()
        .map((name): unknown =>
          JSON.parse(readFileSync(join(directory, name), 'utf8')),
        ),
    ).toEqual([
      { bytes: Buffer.from('{first').toString('base64') },
      { bytes: Buffer.from('{second').toString('base64') },
    ]);
  });
});

describe('R22 post-replay admission and coverage receipts', (): void => {
  function internalMethod(
    authority: TerminalRecordAuthority,
    name: 'pendingRegistrations' | 'retryAttributions' | 'replay',
  ): (...args: unknown[]) => unknown {
    const method: unknown = Reflect.get(authority, name);
    if (typeof method !== 'function')
      throw new Error(`Expected authority method ${name}`);
    return (...args: unknown[]): unknown => {
      const result: unknown = Reflect.apply(method, authority, args);
      return result;
    };
  }

  function controlled(): {
    authority: TerminalRecordAuthority;
    repository: TerminalRecordRepository;
    faults: { read: boolean; retire: boolean; sync: boolean };
  } {
    const faults = { read: false, retire: false, sync: false };
    class ControlledRepository extends TerminalRecordRepository {
      public override load(
        ...args: Parameters<TerminalRecordRepository['load']>
      ): ReturnType<TerminalRecordRepository['load']> {
        if (faults.read) throw new Error('read unavailable');
        return super.load(...args);
      }
      public override retire(
        ...args: Parameters<TerminalRecordRepository['retire']>
      ): ReturnType<TerminalRecordRepository['retire']> {
        if (faults.retire) throw new Error('retire unavailable');
        return super.retire(...args);
      }
    }
    const repository = new ControlledRepository({
      dataRoot: root,
      flushDirectorySync: (): void => {
        if (faults.sync) throw new Error('sync unavailable');
      },
    });
    return {
      faults,
      repository,
      authority: new TerminalRecordAuthority({
        repository,
        now: (): number => 50,
      }),
    };
  }

  function seedSuccessor(
    repository: TerminalRecordRepository,
    retiredIds: string[] = [],
  ): void {
    const envelope = repository.empty(
      {
        projectId: 'proj',
        worktreeId: 'wt',
        incarnation: 'inc-2',
        generation: 2,
      },
      'none',
    );
    envelope.startedAt = 200;
    envelope.lifetimeIds = ['new'];
    envelope.retiredLifetimeIds = retiredIds;
    envelope.record.terminals = [
      {
        session: session('t', { title: 'NEW' }),
        scrollbackLines: ['new bytes'],
        exitCode: null,
        signal: null,
      },
    ];
    repository.save(envelope);
  }

  it.each([false, true])(
    'rejects predecessor registration after successor replay (same-generation unconfirmed fence=%s)',
    (tombstone): void => {
      const { authority, faults } = controlled();
      const oldClient = { ...client, generation: 1, lifetimeId: 'old' };
      const nextClient = { ...client, incarnation: 'inc-2', lifetimeId: 'new' };
      authority.open(oldClient);
      faults.retire = true;
      const next = authority.attribute({
        terminalId: 't',
        client: nextClient,
        session: session('t', { title: 'NEW' }),
        persist: true,
      });
      authority.output(next, Buffer.from('new bytes'));
      faults.retire = false;
      faults.sync = tombstone;
      const old = authority.attribute({
        terminalId: 't',
        client: oldClient,
        session: session('t', { title: 'OLD' }),
        persist: true,
      });
      // isAttributed alone hides an incorrectly bound owner behind the tombstone.
      expect(old).toBeUndefined();
      authority.output(old, Buffer.from('-OLD'));
      authority.exited(old, 11, null);
      if (tombstone) expect(authority.isAttributed('t')).toBe(false);
      faults.sync = false;
      authority.open(nextClient);
      authority.output(next, Buffer.from('-suffix'));
      authority.exited(next, 9, null);
      authority.flushSync();
      const reload = make();
      expect(reload.open(nextClient)).toMatchObject({
        generation: 2,
        terminals: [
          {
            session: { title: 'NEW' },
            exitCode: 9,
            signal: null,
          },
        ],
      });
      expect(
        reload.historyRead({ client: nextClient, terminalId: 't' }).text,
      ).toBe('new bytes-suffix');
      expect(record().retiredLifetimeIds).toContain('old');
    },
  );

  it.each(['generation', 'cutoff', 'incarnation', 'covered-derived'])(
    'persists unseen named coverage when the %s guard preserves a successor',
    (guard): void => {
      const { authority, repository, faults } = controlled();
      if (guard === 'covered-derived') {
        faults.read = true;
        const old = authority.attribute({
          terminalId: 'old',
          client: { ...client, generation: 1, lifetimeId: 'old' },
          session: session('old'),
          persist: true,
        });
        authority.output(old, Buffer.from('old bytes'));
        authority.exited(old, 7, null);
        faults.read = false;
      }
      seedSuccessor(repository);
      const selectors =
        guard === 'generation'
          ? { generation: 1 }
          : guard === 'incarnation'
            ? { incarnation: 'inc-1' }
            : { requestedAt: 100 };
      expect(
        authority.retire({
          projectId: 'proj',
          worktreeId: 'wt',
          ...selectors,
          ...(guard === 'covered-derived' ? {} : { lifetimeIds: ['old'] }),
        }),
      ).toEqual({ retired: 0 });
      expect(record().retiredLifetimeIds).toContain('old');
      expect(record().generation).toBe(2);
      expect(record().record.terminals[0].scrollbackLines).toEqual([
        'new bytes',
      ]);
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      const reload = make();
      expect(
        reload.apply({
          client: { ...client, lifetimeId: 'old' },
          producer: { id: 'unseen', runId: 'first' },
          seq: 1,
          ops: [{ op: 'output.append', terminalId: 't', text: '-OLD' }],
        }).outcome,
      ).toBe('dropped');
      expect(reload.open({ ...client, incarnation: 'inc-2' }).generation).toBe(
        2,
      );
      expect(
        reload.historyRead({
          client: { ...client, incarnation: 'inc-2' },
          terminalId: 't',
        }).text,
      ).toBe('new bytes');
    },
  );

  it('unions covered-derived names into an inherited cleanup acknowledgement', (): void => {
    const seed = make();
    seed.open({ ...client, lifetimeId: 'first' });
    seed.retire({ projectId: 'proj', worktreeId: 'wt', generation: 1 });
    seed.dispose();
    const { authority, repository, faults } = controlled();
    faults.read = true;
    const held = authority.attribute({
      terminalId: 'held',
      client: { ...client, generation: 1, lifetimeId: 'unseen' },
      session: session('held'),
      persist: true,
    });
    authority.exited(held, 7, null);
    faults.read = false;
    seedSuccessor(repository, ['first']);
    // The newer successor is preserved: its coverage counts no fence.
    expect(
      authority.retire({ projectId: 'proj', worktreeId: 'wt', generation: 1 }),
    ).toEqual({ retired: 0 });
    expect(record().retiredLifetimeIds).toEqual(
      expect.arrayContaining(['first', 'unseen']),
    );
    expect(record().generation).toBe(2);
    expect(
      make().apply({
        client: { ...client, lifetimeId: 'unseen' },
        producer: { id: 'unseen', runId: 'r' },
        seq: 1,
        ops: [],
      }).outcome,
    ).toBe('dropped');
  });

  it.each(['before rename', 'after rename', 'confirmation'])(
    'qualifies named-coverage publication at %s without claiming cleanup',
    (stage): void => {
      const { authority, repository, faults } = controlled();
      faults.read = true;
      const old = authority.attribute({
        terminalId: 'old',
        client: { ...client, lifetimeId: 'old' },
        session: session('old'),
        persist: true,
      });
      authority.output(old, Buffer.from('old bytes'));
      authority.exited(old, 7, null);
      faults.read = false;
      seedSuccessor(repository);
      const before = readFileSync(recordFile());
      const rename = fs.renameSync;
      const blocked = jest
        .spyOn(fs, 'renameSync')
        .mockImplementation((from, to): void => {
          if (stage === 'before rename' && to === recordFile())
            throw new Error('rename unavailable');
          rename(from, to);
        });
      const confirm = repository.confirmDurability.bind(repository);
      const confirmation = jest
        .spyOn(repository, 'confirmDurability')
        .mockImplementation((...args): void => {
          if (stage === 'after rename') faults.sync = false;
          confirm(...args);
        });
      faults.sync = stage !== 'before rename';
      const retire = (): { retired: number } =>
        authority.retire({
          projectId: 'proj',
          worktreeId: 'wt',
          generation: 1,
          lifetimeIds: ['old'],
        });
      if (stage === 'after rename') expect(retire()).toEqual({ retired: 0 });
      else expect(retire).toThrow();
      if (stage === 'before rename') {
        expect(readFileSync(recordFile())).toEqual(before);
        expect(
          internalMethod(authority, 'pendingRegistrations')(),
        ).toHaveLength(1);
        expect((): unknown =>
          authority.apply({
            client: { ...client, lifetimeId: 'old' },
            producer: { id: 'old', runId: 'r' },
            seq: 1,
            ops: [],
          }),
        ).toThrow();
      } else {
        expect(record().retiredLifetimeIds).toContain('old');
        expect(
          internalMethod(authority, 'pendingRegistrations')(),
        ).toHaveLength(0);
        expect(confirmation).toHaveBeenCalledTimes(1);
        if (stage === 'confirmation')
          expect((): unknown => authority.shutdown('app-quit')).toThrow();
      }
      blocked.mockRestore();
      faults.sync = false;
      expect(retire).not.toThrow();
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      expect(record().generation).toBe(2);
      expect(
        make().apply({
          client: { ...client, lifetimeId: 'old' },
          producer: { id: 'old', runId: 'r' },
          seq: 1,
          ops: [],
        }).outcome,
      ).toBe('dropped');
      expect(
        make().historyRead({
          client: { ...client, incarnation: 'inc-2' },
          terminalId: 't',
        }).text,
      ).toBe('new bytes');
    },
  );

  it.each(['generation', 'named'])(
    'retains record-backed %s discharge confirmation debt until shutdown retry succeeds',
    (proof): void => {
      const { authority, repository, faults } = controlled();
      faults.read = true;
      const old = authority.attribute({
        terminalId: 'old',
        client: {
          ...client,
          lifetimeId: 'old',
          ...(proof === 'generation' ? { generation: 1 } : {}),
        },
        session: session('old'),
        persist: true,
      });
      authority.output(old, Buffer.from('old bytes'));
      authority.exited(old, 7, null);
      faults.read = false;
      seedSuccessor(repository, proof === 'named' ? ['old'] : []);
      const confirmation = jest.spyOn(repository, 'confirmDurability');
      faults.sync = true;
      expect((): unknown => authority.shutdown('app-quit')).toThrow(
        'sync unavailable',
      );
      expect(internalMethod(authority, 'pendingRegistrations')()).toHaveLength(
        0,
      );
      expect(confirmation).toHaveBeenCalledTimes(1);
      faults.sync = false;
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      expect(confirmation).toHaveBeenCalledTimes(2);
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      expect(confirmation).toHaveBeenCalledTimes(2);
      expect(record().record.terminals[0].scrollbackLines).toEqual([
        'new bytes',
      ]);
    },
  );

  it('salvages intact named IDs from a damaged tombstone across reload', (): void => {
    const directory = terminalRecordDir(root, 'proj', 'wt');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'tombstone.json');
    const bytes = JSON.stringify({
      generation: 1,
      incarnation: 'inc-1',
      retiredAt: 'bad',
      retiredLifetimeIds: ['old'],
    });
    writeFileSync(path, bytes);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        make().apply({
          client: { ...client, lifetimeId: 'old' },
          producer: { id: 'old', runId: 'first' },
          seq: 1,
          ops: [],
        }).outcome,
      ).toBe('dropped');
      expect(readFileSync(path, 'utf8')).toBe(bytes);
      expect(existsSync(recordFile())).toBe(false);
    }
  });

  it.each([{ ids: undefined }, { ids: ['old', 7] }, { ids: 'old' }])(
    'does not invent named coverage from malformed IDs %j',
    ({ ids }): void => {
      const directory = terminalRecordDir(root, 'proj', 'wt');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'tombstone.json'),
        JSON.stringify({
          generation: 1,
          retiredAt: 'bad',
          retiredLifetimeIds: ids,
        }),
      );
      const loaded = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      }).load('proj', 'wt');
      expect(loaded.kind).toBe('absent');
      expect(loaded.tombstone?.retiredLifetimeIds).toBeUndefined();
      expect(loaded.tombstone).toMatchObject({
        damaged: true,
        retiredAt: 0,
        incarnation: null,
      });
    },
  );

  it.each(['new coverage', 'interrupted replay'])(
    'qualifies inherited host coverage across %s',
    (transition): void => {
      make().open(client);
      const { authority, faults } = controlled();
      const requested = {
        ...client,
        incarnation: 'inc-2',
        generation: 9,
        lifetimeId: 'held',
      };
      faults.read = true;
      const original = authority.attribute({
        terminalId: 'held',
        client: requested,
        session: session('held'),
        persist: true,
      });
      authority.output(original, Buffer.from('prefix'));
      faults.read = false;
      const anchor = authority.attribute({
        terminalId: 'anchor',
        client: requested,
        session: session('anchor'),
        persist: true,
      });
      const method =
        transition === 'new coverage' ? 'retryAttributions' : 'replay';
      const resume = internalMethod(authority, method);
      let once = true;
      Reflect.set(authority, method, (...args: unknown[]): unknown => {
        if (once) {
          once = false;
          if (transition === 'interrupted replay')
            throw new Error('replay interrupted');
          authority.retire({
            projectId: 'proj',
            worktreeId: 'wt',
            generation: 1,
            lifetimeIds: ['late-fence'],
          });
        }
        return resume(...args);
      });
      const recreated = { ...requested, generation: undefined };
      const held = authority.attribute({
        terminalId: 'held',
        client: recreated,
        session: session('held'),
        persist: true,
      });
      Reflect.set(authority, method, resume);
      if (transition === 'new coverage') expect(held).toBeUndefined();
      else expect(held).toBeDefined();
      authority.output(held, Buffer.from('-suffix'));
      authority.exited(held, 0, null);
      authority.exited(anchor, 0, null);
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      expect(record().generation).toBe(2);
      expect(record().retiredLifetimeIds).toContain('held');
      const entry = record().record.terminals.find(
        (candidate): boolean => candidate.session.id === 'held',
      );
      if (transition === 'new coverage') expect(entry).toBeUndefined();
      else
        expect(entry).toMatchObject({
          scrollbackLines: ['-suffix'],
          exitCode: 0,
        });
      expect(
        make().historyRead({ client: recreated, terminalId: 'held' }).text,
      ).toBe('');
      expect(
        make().historyRead({
          client: { ...recreated, lifetimeId: undefined },
          terminalId: 'held',
        }).text,
      ).toBe(transition === 'new coverage' ? '' : '-suffix');
    },
  );

  it('surfaces incomplete exit replay, counts its debt and still replays healthy registrations', (): void => {
    const { authority, faults } = controlled();
    faults.read = true;
    const failed = authority.attribute({
      terminalId: 'failed',
      client,
      session: session('failed'),
      persist: true,
    });
    authority.output(failed, Buffer.from('once'));
    authority.exited(failed, 7, null);
    const healthy = authority.attribute({
      terminalId: 'healthy',
      client,
      session: session('healthy'),
      persist: true,
    });
    authority.output(healthy, Buffer.from('healthy bytes'));
    authority.exited(healthy, 9, null);
    faults.read = false;
    const exit = authority.exited.bind(authority);
    const failure = jest
      .spyOn(authority, 'exited')
      .mockImplementation((handle, code, signal): void => {
        if (handle === failed) throw new Error('exit replay failed');
        exit(handle, code, signal);
      });
    expect((): unknown =>
      internalMethod(authority, 'retryAttributions')(),
    ).toThrow('replay failed');
    expect(internalMethod(authority, 'pendingRegistrations')()).toHaveLength(1);
    authority.flushSync();
    const first = make();
    expect(
      first
        .open(client)
        .terminals.find((entry): boolean => entry.session.id === 'healthy')
        ?.exitCode,
    ).toBe(9);
    failure.mockRestore();
    internalMethod(authority, 'retryAttributions')();
    expect(internalMethod(authority, 'pendingRegistrations')()).toHaveLength(0);
    authority.flushSync();
    const reload = make();
    expect(reload.historyRead({ client, terminalId: 'failed' }).text).toBe(
      'once',
    );
    expect(
      reload
        .open(client)
        .terminals.find((entry): boolean => entry.session.id === 'failed')
        ?.exitCode,
    ).toBe(7);
  });
});

describe('R21 explicit registration and dictionary identities', () => {
  const reportAfterRelease = (
    authority: RecordAuthority,
    ...handles: (TerminalRecordRegistration | undefined)[]
  ): void => {
    for (const handle of handles) {
      authority.output(handle, Buffer.from('LATE-RELEASED'));
      authority.exited(handle, 97, 'SIGTERM');
    }
    authority.flushSync();
  };

  it.each(['held successor', 'bound successor'])(
    'retains cross-scope reused-ID obligations with a %s and retries without taking its route',
    (mode) => {
      let blocked = true;
      class DelayedRepository extends TerminalRecordRepository {
        public override load(
          ...args: Parameters<TerminalRecordRepository['load']>
        ): ReturnType<TerminalRecordRepository['load']> {
          if (blocked) throw new Error('EACCES');
          return super.load(...args);
        }
      }
      const authority = new TerminalRecordAuthority({
        repository: new DelayedRepository({
          dataRoot: root,
          flushDirectorySync: (): void => undefined,
        }),
      });
      const old = authority.attribute({
        terminalId: 't',
        client,
        session: session('t'),
        persist: true,
      });
      authority.output(old, Buffer.from('old'));
      authority.exited(old, 7, null);
      if (mode === 'bound successor') blocked = false;
      const other = { ...client, worktreeId: 'other' };
      const next = authority.attribute({
        terminalId: 't',
        client: other,
        session: session('t', { worktreeId: 'other' }),
        persist: true,
      });
      authority.output(next, Buffer.from('next'));
      blocked = false;
      authority.open(client);
      expect(authority.historyRead({ client, terminalId: 't' }).text).toBe(
        'old',
      );
      expect(authority.open(client).terminals[0].exitCode).toBe(7);
      expect(authority.isAttributed('t')).toBe(true);
      authority.output(next, Buffer.from('-suffix'));
      authority.exited(next, 9, null);
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      const reload = make();
      expect(reload.historyRead({ client, terminalId: 't' }).text).toBe('old');
      expect(reload.historyRead({ client: other, terminalId: 't' }).text).toBe(
        'next-suffix',
      );
      expect(reload.open(other).terminals[0].exitCode).toBe(9);
      reportAfterRelease(authority, old, next);
      expect(make().historyRead({ client, terminalId: 't' }).text).toBe('old');
      expect(make().historyRead({ client: other, terminalId: 't' }).text).toBe(
        'next-suffix',
      );
    },
  );

  it.each(['held', 'bound'])(
    'keeps same-scope distinct registrations with a %s successor and releases exited decoder resources before recovery',
    (mode) => {
      let blocked = true;
      class DelayedRepository extends TerminalRecordRepository {
        public override load(
          ...args: Parameters<TerminalRecordRepository['load']>
        ): ReturnType<TerminalRecordRepository['load']> {
          if (blocked) throw new Error('EACCES');
          return super.load(...args);
        }
      }
      const authority = new TerminalRecordAuthority({
        repository: new DelayedRepository({
          dataRoot: root,
          flushDirectorySync: (): void => undefined,
        }),
      });
      const old = authority.attribute({
        terminalId: 't',
        client: { ...client, lifetimeId: 'old' },
        session: session('t'),
        persist: true,
      });
      authority.output(old, Buffer.from('old'));
      authority.exited(old, 3, null);
      reportAfterRelease(authority, old);
      if (mode === 'bound') blocked = false;
      const next = authority.attribute({
        terminalId: 't',
        client: { ...client, lifetimeId: 'next' },
        session: session('t'),
        persist: true,
      });
      authority.output(next, Buffer.from('-next'));
      blocked = false;
      authority.open(client);
      authority.output(next, Buffer.from('-tail'));
      authority.exited(next, 4, null);
      authority.flushSync();
      expect(make().historyRead({ client, terminalId: 't' }).text).toBe(
        'old-next-tail',
      );
      expect(make().open(client).terminals[0].exitCode).toBe(4);
    },
  );

  it('addresses late unretired predecessor events to their own scope and keeps the successor route', () => {
    const authority = make();
    const other = { ...client, worktreeId: 'other' };
    const old = authority.attribute({
      terminalId: 't',
      client,
      session: session('t'),
      persist: true,
    });
    const next = authority.attribute({
      terminalId: 't',
      client: other,
      session: session('t', { worktreeId: 'other' }),
      persist: true,
    });
    authority.output(next, Buffer.from('next'));
    authority.output(old, Buffer.from('old-tail'));
    authority.exited(old, 8, null);
    expect(authority.isAttributed('t')).toBe(true);
    expect(authority.open(other).terminals[0].exitCode).toBeNull();
    authority.output(next, Buffer.from('-tail'));
    authority.exited(next, 9, null);
    authority.flushSync();
    const reload = make();
    expect(reload.historyRead({ client, terminalId: 't' }).text).toBe(
      'old-tail',
    );
    expect(reload.open(client).terminals[0].exitCode).toBe(8);
    expect(reload.historyRead({ client: other, terminalId: 't' }).text).toBe(
      'next-tail',
    );
  });

  it.each([false, true])(
    'retains successor status ownership after release (shutdown before predecessors exit=%s)',
    (shutdown) => {
      const authority = make();
      const register = (
        lifetimeId: string,
      ): TerminalRecordRegistration | undefined =>
        authority.attribute({
          terminalId: 't',
          client: { ...client, lifetimeId },
          session: session('t', { title: lifetimeId }),
          persist: true,
        });
      const old = register('old');
      const middle = register('middle');
      const next = register('next');
      authority.output(old, Buffer.from([0xe2, 0x82]));
      authority.output(next, Buffer.from('next'));
      authority.exited(next, 9, null);
      reportAfterRelease(authority, next);
      if (shutdown)
        expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      authority.exited(old, 3, null);
      authority.output(middle, Buffer.from('-middle'));
      authority.exited(middle, 4, null);
      reportAfterRelease(authority, old, middle, next);
      authority.flushSync();
      const reload = make();
      expect(reload.open(client).terminals[0]).toMatchObject({
        session: { title: 'next' },
        exitCode: 9,
        signal: null,
      });
      expect(reload.historyRead({ client, terminalId: 't' }).text).toBe(
        'next�-middle',
      );
    },
  );

  it('late predecessor events cannot target a successor and retirement releases only covered resources', () => {
    const authority = make();
    for (let cycle = 0; cycle < 3; cycle++) {
      const previous = { ...client, worktreeId: `old-${cycle}` };
      const old = authority.attribute({
        terminalId: 't',
        client: previous,
        session: session('t', { worktreeId: previous.worktreeId }),
        persist: true,
      });
      authority.output(old, Buffer.from([0xf0, 0x9f]));
      const next = authority.attribute({
        terminalId: 't',
        client,
        session: session('t'),
        persist: true,
      });
      authority.output(next, Buffer.from('next'));
      authority.retire({ projectId: 'proj', worktreeId: previous.worktreeId });
      authority.output(old, Buffer.from('wrong'));
      authority.exited(old, 8, null);
      reportAfterRelease(authority, old);
      expect(authority.isAttributed('t')).toBe(true);
      expect(authority.open(client).terminals[0].exitCode).toBeNull();
      authority.output(next, Buffer.from('-tail'));
      authority.exited(next, 9, null);
      reportAfterRelease(authority, old, next);
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      expect(
        make().historyRead({ client: previous, terminalId: 't' }).text,
      ).toBe('');
    }
    expect(make().historyRead({ client, terminalId: 't' }).text).toBe(
      'next-tail'.repeat(3),
    );
    expect(make().open(client).terminals[0].exitCode).toBe(9);
  });

  it('compatible recreation explicitly transfers pending bytes but never joins decoder streams', () => {
    const authority = make();
    const old = authority.attribute({
      terminalId: 't',
      client,
      session: session('t'),
      persist: true,
    });
    authority.output(old, Buffer.from([0xe2, 0x82]));
    const next = authority.attribute({
      terminalId: 't',
      client,
      session: session('t'),
      persist: true,
    });
    authority.output(old, Buffer.from('wrong'));
    authority.exited(old, 8, null);
    authority.output(next, Buffer.from([0xac]));
    authority.exited(next, 9, null);
    authority.flushSync();
    expect(make().historyRead({ client, terminalId: 't' }).text).toBe('��');
    expect(make().open(client).terminals[0].exitCode).toBe(9);
    reportAfterRelease(authority, old, next);
    expect(make().historyRead({ client, terminalId: 't' }).text).toBe('��');
    expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
  });

  it('seals the same escaped producer/run identity as the watermark through retry and reload', () => {
    const authority = make();
    const producers = [
      { id: 'p/1', runId: '__proto__' },
      { id: 'p%2F1', runId: '__proto__' },
      { id: '__proto__', runId: 'run/%' },
    ];
    for (const producer of producers)
      authority.apply({
        client,
        producer,
        seq: 1,
        ops: [],
        sealed: { reason: 'producer-exit' },
      });
    const before = record();
    expect(Object.keys(before.runs).sort()).toEqual(
      Object.keys(before.producerWatermarks).sort(),
    );
    expect(Object.keys(before.runs)).toHaveLength(3);
    for (const producer of producers)
      expect(
        make().apply({
          client,
          producer,
          seq: 1,
          ops: [],
          sealed: { reason: 'producer-exit' },
        }).outcome,
      ).toBe('duplicate');
    expect(record().runs).toEqual(before.runs);
  });

  it('preserves unseen member identity and deterministically rekeys a stale collision on retry and later saves', () => {
    const authority = make();
    authority.apply({
      client,
      producer: { id: 'p', runId: 'layout' },
      seq: 1,
      ops: [
        { op: 'session.upsert', session: session('unseen') },
        { op: 'session.upsert', session: session('seen') },
        {
          op: 'layout.save',
          servedIds: ['seen', 'unseen'],
          referencedIds: ['seen', 'unseen'],
          terminalCustomNames: { unseen: 'Unseen' },
          bindings: [
            {
              key: 'g',
              groupId: 'g',
              members: [{ key: 'm', terminalId: 'unseen' }],
            },
          ],
        },
      ],
    });
    const save = {
      client,
      producer: { id: 'p', runId: 'layout' },
      seq: 2,
      ops: [
        {
          op: 'layout.save' as const,
          servedIds: ['seen'],
          referencedIds: ['seen'],
          terminalCustomNames: {},
          bindings: [
            {
              key: 'g',
              groupId: 'g',
              members: [{ key: 'm', terminalId: 'seen' }],
            },
          ],
        },
      ],
    };
    authority.apply(save);
    const first = WorkerTerminalRecordOpenResultSchema.parse(
      authority.open(client),
    );
    expect(first.bindings[0].members).toHaveLength(2);
    expect(first.bindings[0].members).toContainEqual({
      key: 'm',
      terminalId: 'unseen',
    });
    expect(
      new Set(first.bindings[0].members.map((member): string => member.key))
        .size,
    ).toBe(2);
    expect(authority.apply(save).outcome).toBe('duplicate');
    authority.apply({ ...save, seq: 3 });
    expect(make().open(client).bindings).toEqual(first.bindings);
    expect(make().open(client).terminalCustomNames.unseen).toBe('Unseen');
    authority.apply({
      ...save,
      seq: 4,
      ops: [
        {
          ...save.ops[0],
          servedIds: ['seen', 'unseen'],
          referencedIds: ['seen', 'unseen'],
          bindings: first.bindings,
        },
      ],
    });
    expect(make().open(client).bindings).toEqual(first.bindings);
    expect(() =>
      authority.apply({
        ...save,
        seq: 5,
        ops: [
          {
            ...save.ops[0],
            bindings: [
              {
                key: 'g',
                groupId: 'g',
                members: [
                  { key: 'm', terminalId: 'seen' },
                  { key: 'm', terminalId: 'unseen' },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow('duplicate binding or member keys');
    expect(make().open(client).producerWatermarks?.['p/layout']).toBe(4);
  });

  it.each(['__proto__', 'constructor', 'toString'])(
    'keeps opaque name and ordinal keys (%s) through clone, schemas, codec, save and reload',
    (id) => {
      const authority = make();
      authority.apply({
        client,
        producer: { id: 'p', runId: 'names' },
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session(id) },
          { op: 'rename', terminalId: id, name: 'kept' },
        ],
      });
      const renamed = authority.open(client);
      expect(Object.hasOwn(renamed.terminalCustomNames, id)).toBe(true);
      const names = Object.fromEntries([[id, 'saved']]);
      const save = WorkerTerminalRecordApplyParamsSchema.parse({
        client,
        producer: { id: 'p', runId: 'names' },
        seq: 2,
        ops: [
          {
            op: 'layout.save',
            servedIds: [id],
            referencedIds: [id],
            bindings: renamed.bindings,
            terminalCustomNames: names,
          },
        ],
      });
      expect(save.ops[0]).toMatchObject({ terminalCustomNames: names });
      authority.apply(save);
      const result = WorkerTerminalRecordOpenResultSchema.parse(
        make().open(client),
      );
      expect(Object.hasOwn(result.terminalCustomNames, id)).toBe(true);
      expect(result.terminalCustomNames[id]).toBe('saved');
      expect(
        normalizeCustomNameMap(structuredClone(names), new Set([id])),
      ).toEqual(names);
      const legacy = normalizePersistedState(
        {
          ...createEmptyState(),
          terminals: [
            {
              session: session(id),
              scrollbackLines: [],
              exitCode: null,
              signal: null,
            },
          ],
          groups: [
            { id, terminalIds: [id], focusedTerminalId: id, splitSizes: [1] },
          ],
          groupOrdinals: Object.fromEntries([[id, 3]]),
          terminalCustomNames: names,
        },
        'proj',
        'wt',
      );
      expect(legacy.groupOrdinals[id]).toBe(3);
      expect(Object.hasOwn(legacy.groupOrdinals, id)).toBe(true);
      expect(legacy.terminalCustomNames).toEqual(names);
      expect(
        WorkerTerminalRecordApplyParamsSchema.safeParse({
          ...save,
          ops: [
            {
              ...save.ops[0],
              terminalCustomNames: Object.fromEntries([[id, 'x'.repeat(65)]]),
            },
          ],
        }).success,
      ).toBe(false);
    },
  );
});

describe('R20 successor ownership, counter exhaustion and inert bindings', () => {
  it('reconciles a dead registration independently of a reused ID in another scope', () => {
    const crashed = make();
    crashed.attribute({
      terminalId: 't',
      client,
      session: session('t'),
      persist: true,
    });
    crashed.flushSync();
    crashed.dispose();
    const authority = make();
    const other = { ...client, worktreeId: 'other' };
    authority.attribute({
      terminalId: 't',
      client: other,
      session: session('t', { worktreeId: 'other' }),
      persist: true,
    });
    expect(authority.open(client).terminals[0].signal).toBe('connection-lost');
    expect(authority.isAttributed('t')).toBe(true);
    authority.output('t', Buffer.from('other'));
    authority.exited('t', 9, null);
    authority.flushSync();
    expect(make().open(other).terminals[0].exitCode).toBe(9);
    expect(make().historyRead({ client: other, terminalId: 't' }).text).toBe(
      'other',
    );
  });
  it.each(['live', 'held', 'other scope'])(
    'stale attribution preserves the %s successor registration and decoder',
    (mode) => {
      const authority = make();
      const previous = { ...client, generation: 1, lifetimeId: 'old' };
      authority.attribute({
        terminalId: 't',
        client: previous,
        session: session('t'),
        persist: true,
      });
      authority.retire({ projectId: 'proj', worktreeId: 'wt', generation: 1 });
      const next =
        mode === 'other scope'
          ? { ...client, worktreeId: 'next', lifetimeId: 'next' }
          : {
              ...client,
              generation: authority.open(client).generation,
              lifetimeId: 'next',
            };
      let blocked = mode === 'held';
      const spy = jest.spyOn(TerminalRecordRepository.prototype, 'load');
      const load = spy.getMockImplementation();
      if (!load) throw new Error('Expected repository load implementation');
      spy.mockImplementation(function (
        this: TerminalRecordRepository,
        ...args
      ) {
        if (blocked && args[1] === 'wt') throw new Error('EACCES');
        return load.apply(this, args);
      });
      try {
        if (mode === 'held') {
          // A separate authority keeps the successor unresolved, but can still see the fence.
          const held = make();
          held.attribute({
            terminalId: 't',
            client: next,
            session: session('t'),
            persist: true,
          });
          held.output('t', Buffer.from([0xf0, 0x9f]));
          blocked = false;
          held.attribute({
            terminalId: 't',
            client: previous,
            session: session('t'),
            persist: true,
          });
          held.output('t', Buffer.from([0x98, 0x80]));
          held.exited('t', 7, null);
          held.flushSync();
          expect(held.historyRead({ client: next, terminalId: 't' }).text).toBe(
            '😀',
          );
          expect(held.open(next).terminals[0].exitCode).toBe(7);
        } else {
          authority.attribute({
            terminalId: 't',
            client: next,
            session: session('t', { worktreeId: next.worktreeId }),
            persist: true,
          });
          authority.output('t', Buffer.from([0xf0, 0x9f]));
          authority.attribute({
            terminalId: 't',
            client: previous,
            session: session('t'),
            persist: true,
          });
          expect(authority.isAttributed('t')).toBe(true);
          authority.output('t', Buffer.from([0x98, 0x80]));
          authority.exited('t', 7, null);
          authority.flushSync();
          const reloaded = make();
          expect(
            reloaded.historyRead({ client: next, terminalId: 't' }).text,
          ).toBe('😀');
          expect(reloaded.open(next).terminals[0].exitCode).toBe(7);
        }
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each(['client fence', 'stored generation', 'incarnation reuse'])(
    'rejects exhausted %s before fencing readable history',
    (mode) => {
      const authority = make();
      authority.apply({
        client,
        producer: { id: 'p', runId: 'r20' },
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('t') },
          { op: 'output.append', terminalId: 't', text: 'readable' },
        ],
      });
      authority.dispose();
      if (mode !== 'client fence') {
        const stored = record();
        stored.generation = Number.MAX_SAFE_INTEGER;
        writeFileSync(recordFile(), JSON.stringify(stored));
      }
      const before = readFileSync(recordFile());
      const reloaded = make();
      const attempt = (): unknown =>
        mode === 'incarnation reuse'
          ? reloaded.open({ ...client, incarnation: 'inc-2' })
          : reloaded.retire({
              projectId: 'proj',
              worktreeId: 'wt',
              ...(mode === 'client fence'
                ? { generation: Number.MAX_SAFE_INTEGER }
                : {}),
            });
      for (let retry = 0; retry < 2; retry += 1)
        expect(attempt).toThrow('counter is exhausted');
      expect(readFileSync(recordFile())).toEqual(before);
      expect(reloaded.historyRead({ client, terminalId: 't' }).text).toBe(
        'readable',
      );
      expect(
        WorkerTerminalRecordOpenResultSchema.safeParse(make().open(client))
          .success,
      ).toBe(true);
    },
  );

  it('allows the last representable successor but not another retirement', () => {
    const authority = make();
    authority.retire({
      projectId: 'proj',
      worktreeId: 'wt',
      generation: Number.MAX_SAFE_INTEGER - 1,
    });
    expect(
      WorkerTerminalRecordOpenResultSchema.parse(authority.open(client))
        .generation,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(make().open(client).generation).toBe(Number.MAX_SAFE_INTEGER);
    expect(() =>
      authority.retire({ projectId: 'proj', worktreeId: 'wt' }),
    ).toThrow('counter is exhausted');
    expect(make().open(client).generation).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects revision overflow without publishing the batch or losing its replay', () => {
    const authority = make();
    authority.open(client);
    authority.dispose();
    const stored = record();
    stored.revision = Number.MAX_SAFE_INTEGER - 1;
    writeFileSync(recordFile(), JSON.stringify(stored));
    const reloaded = make();
    const batch = {
      client,
      producer: { id: 'p', runId: 'r20' },
      seq: 1,
      ops: [],
    };
    expect(reloaded.apply(batch).revision).toBe(Number.MAX_SAFE_INTEGER);
    const before = readFileSync(recordFile());
    for (let retry = 0; retry < 2; retry += 1) {
      expect(() => reloaded.apply({ ...batch, seq: 2 })).toThrow(
        'counter is exhausted',
      );
      expect(reloaded.apply(batch).outcome).toBe('duplicate');
    }
    expect(readFileSync(recordFile())).toEqual(before);
    expect(
      WorkerTerminalRecordOpenResultSchema.safeParse(make().open(client))
        .success,
    ).toBe(true);
  });

  it.each([0, 1, 2])(
    'keeps exhausted held replay readable without partial publication (headroom=%s)',
    (headroom) => {
      const seed = make();
      seed.open(client);
      seed.dispose();
      const stored = record();
      stored.revision = Number.MAX_SAFE_INTEGER - headroom;
      writeFileSync(recordFile(), JSON.stringify(stored));
      const before = readFileSync(recordFile());
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      const load = repository.load.bind(repository);
      let blocked = true;
      jest.spyOn(repository, 'load').mockImplementation((...args) => {
        if (blocked) throw new Error('EACCES');
        return load(...args);
      });
      const authority = new TerminalRecordAuthority({ repository });
      expect(() =>
        authority.attribute({
          terminalId: 'held',
          client,
          session: session('held'),
          persist: true,
        }),
      ).not.toThrow();
      authority.output('held', Buffer.from('retained'));
      expect(() => authority.exited('held', 7, null)).not.toThrow();
      blocked = false;
      for (let retry = 0; retry < 2; retry += 1) {
        const opened = WorkerTerminalRecordOpenResultSchema.parse(
          authority.open(client),
        );
        expect(opened.revision).toBe(stored.revision);
        expect(opened.terminals).toEqual([]);
        expect(authority.isAttributed('held')).toBe(false);
      }
      expect(() => authority.shutdown('app-quit')).toThrow(
        'unresolved attributions',
      );
      authority.flushSync();
      expect(readFileSync(recordFile())).toEqual(before);
    },
  );

  it.each([false, true])(
    'records the last safe exit revision (decoder tail=%s)',
    (tail) => {
      const seed = make();
      seed.open(client);
      seed.dispose();
      const stored = record();
      stored.revision = Number.MAX_SAFE_INTEGER - 2;
      writeFileSync(recordFile(), JSON.stringify(stored));
      const authority = make();
      authority.attribute({
        terminalId: 't',
        client,
        session: session('t'),
        persist: true,
      });
      if (tail) authority.output('t', Buffer.from([0xf0]));
      authority.exited('t', 7, null);
      authority.flushSync();
      expect(record().revision).toBe(Number.MAX_SAFE_INTEGER);
      const reopened = WorkerTerminalRecordOpenResultSchema.parse(
        make().open(client),
      );
      expect(reopened.terminals[0].exitCode).toBe(7);
      expect(make().historyRead({ client, terminalId: 't' }).text).toBe(
        tail ? '�' : '',
      );
    },
  );

  it('serves an exhausted pending import without fencing or acknowledging it', () => {
    const seed = make();
    seed.apply({
      client,
      producer: { id: 'p', runId: 'pending' },
      seq: 1,
      ops: [
        { op: 'session.upsert', session: session('t') },
        { op: 'output.append', terminalId: 't', text: 'readable' },
      ],
    });
    seed.dispose();
    const stored = record();
    stored.revision = Number.MAX_SAFE_INTEGER;
    stored.import.pending = true;
    writeFileSync(recordFile(), JSON.stringify(stored));
    const before = readFileSync(recordFile());
    const authority = make();
    for (let retry = 0; retry < 2; retry += 1) {
      const opened = WorkerTerminalRecordOpenResultSchema.parse(
        authority.open(client),
      );
      expect(opened.import.pending).toBe(true);
      expect(opened.revision).toBe(Number.MAX_SAFE_INTEGER);
      expect(authority.historyRead({ client, terminalId: 't' }).text).toBe(
        'readable',
      );
      expect(() =>
        authority.apply({
          client,
          producer: { id: 'p', runId: 'pending' },
          seq: 2,
          ops: [],
        }),
      ).toThrow('waiting on its legacy import');
    }
    expect(readFileSync(recordFile())).toEqual(before);
  });

  it.each(['output then exit', 'exit with decoder tail'])(
    'holds exhausted host reports without interrupting %s',
    (mode) => {
      const seed = make();
      seed.open(client);
      seed.dispose();
      const stored = record();
      stored.revision = Number.MAX_SAFE_INTEGER - 1;
      writeFileSync(recordFile(), JSON.stringify(stored));
      const authority = make();
      authority.attribute({
        terminalId: 't',
        client,
        session: session('t'),
        persist: true,
      });
      expect(() =>
        authority.output(
          't',
          mode === 'output then exit'
            ? Buffer.from('retained')
            : Buffer.from([0xf0]),
        ),
      ).not.toThrow();
      expect(() => authority.exited('t', 7, null)).not.toThrow();
      const opened = WorkerTerminalRecordOpenResultSchema.parse(
        authority.open(client),
      );
      expect(opened.revision).toBe(Number.MAX_SAFE_INTEGER);
      expect(opened.terminals[0].exitCode).toBeNull();
      expect(authority.historyRead({ client, terminalId: 't' }).text).toBe('');
      expect(() => authority.shutdown('app-quit')).toThrow(
        'unresolved attributions',
      );
      authority.flushSync();
      expect(make().open(client).revision).toBe(Number.MAX_SAFE_INTEGER);
    },
  );

  it('keeps revision-2 fields out of existing production bindings until integrated', () => {
    const create = {
      scope: { workspaceId: 'proj', worktreeId: 'wt' },
      cwdRootId: 'root',
      cwdRelativePath: '',
      cols: 80,
      rows: 24,
      kind: 'interactive',
      _meta: { idempotencyKey: 'r20' },
    };
    const restore = {
      terminalId: 't',
      restoreMode: 'reattach_if_live',
      cols: 80,
      rows: 24,
      _meta: { idempotencyKey: 'r20' },
    };
    const cases = [
      {
        definition:
          WORKER_TERMINAL_INSTRUCTION_DEFINITIONS['worker.terminal.create'],
        schema: WorkerTerminalCreateParamsSchema,
        params: create,
        additions: {
          client,
          session: {
            shell: '/bin/zsh',
            shellBasename: 'zsh',
            cwd: '/tmp',
            createdAt: 1,
          },
        },
      },
      {
        definition:
          WORKER_TERMINAL_SESSION_INSTRUCTION_DEFINITIONS[
            'worker.terminal.restore'
          ],
        schema: WorkerTerminalRestoreParamsSchema,
        params: restore,
        additions: { client, historyFrom: 'record' },
      },
      {
        definition:
          WORKER_TERMINAL_INSTRUCTION_DEFINITIONS['worker.terminal.kill'],
        schema: WorkerTerminalKillParamsSchema,
        params: { terminalId: 't' },
        additions: { exitSignal: 'user-close' },
      },
      {
        definition:
          WORKER_TERMINAL_INSTRUCTION_DEFINITIONS['worker.terminal.release'],
        schema: WorkerTerminalReleaseParamsSchema,
        params: { terminalId: 't' },
        additions: { exitSignal: 'app-quit' },
      },
    ];
    for (const { definition, schema, params, additions } of cases) {
      expect(definition.params.safeParse(params).success).toBe(true);
      expect(
        schema.safeParse({ ...params, revision: 2, ...additions }).success,
      ).toBe(true);
      for (const unsupported of [
        { revision: 2 },
        additions,
        { revision: 2, ...additions },
      ])
        expect(
          definition.params.safeParse({ ...params, ...unsupported }).success,
        ).toBe(false);
    }
  });
});

describe('R19 delayed history and imported identity compatibility', () => {
  it.each(['append', 'replace', 'host'])(
    'keeps discontinuity metadata out of installed records: %s',
    (mode) => {
      const authority = make();
      authority.attribute({
        terminalId: 't',
        client,
        session: session('t'),
        persist: true,
      });
      const text = 'x'.repeat(1024 * 1024);
      if (mode === 'host') {
        authority.output('t', Buffer.from(text));
        authority.output('t', Buffer.from('y'));
      } else {
        authority.apply({
          client,
          producer: { id: 'p', runId: 'r19-installed' },
          seq: 1,
          ops:
            mode === 'append'
              ? [
                  { op: 'output.append', terminalId: 't', text },
                  { op: 'output.append', terminalId: 't', text: 'y' },
                ]
              : [
                  {
                    op: 'output.replace',
                    terminalId: 't',
                    lines: Array.from({ length: 5 }, () => text),
                  },
                ],
        });
      }
      authority.flushSync();
      expect(record().import.pending).toBeUndefined();
      expect(record().record.truncatedHistoryIds).toBeUndefined();
      expect(
        authority.historyRead({ client, terminalId: 't' }).text.length,
      ).toBeGreaterThan(0);
    },
  );

  it.each(['exit', 'recreate', 'pending reload'])(
    'preserves decoder-tail discontinuity through held %s',
    (mode) => {
      const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
      mkdirSync(dirname(legacy), { recursive: true });
      writeFileSync(
        legacy,
        JSON.stringify({
          version: 2,
          lineage: 'decoder-tail',
          bindings: [],
          terminalCustomNames: {},
          terminals: [
            {
              session: session('t'),
              scrollbackLines: ['old-partial'],
              exitCode: null,
              signal: null,
            },
          ],
        }),
      );
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      let authority = new TerminalRecordAuthority({ repository });
      const read = fs.readFileSync;
      let blockRecord = true;
      let blockLegacy = true;
      const spy = jest
        .spyOn(fs, 'readFileSync')
        .mockImplementation((path, options) => {
          if (
            (blockRecord && String(path) === recordFile()) ||
            (blockLegacy && String(path) === legacy)
          )
            throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
          return read(path, options);
        });
      try {
        const attribution = {
          terminalId: 't',
          client,
          session: session('t'),
          persist: true,
        };
        authority.attribute(attribution);
        authority.output('t', Buffer.from('x'.repeat(1024 * 1024)));
        authority.output('t', Buffer.from([0xf0]));
        // Decoder completion alone crosses retention; no earlier append was capped.
        if (mode !== 'recreate') authority.exited('t', 0, null);
        blockRecord = false;
        if (mode === 'pending reload') {
          authority.open(client);
          authority.flushSync();
          expect(record().record.truncatedHistoryIds).toEqual(['t']);
          authority.dispose();
          authority = make();
        }
        blockLegacy = false;
        if (mode === 'recreate') authority.attribute(attribution);
        expect(authority.open(client).import.pending).toBeUndefined();
        expect(
          authority.historyRead({
            client,
            terminalId: 't',
            maxBytes: 2 * 1024 * 1024,
          }).text,
        ).toBe('old-partial\n' + 'x'.repeat(1024 * 1024 - 3) + '\ufffd');
        authority.flushSync();
        expect(record().record.truncatedHistoryIds).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each(
    [
      'pending import',
      'pending reload',
      'held reports',
      'recreated reports',
    ].flatMap((mode) =>
      ['continuous', 'line boundary', 'line cap', 'byte cap', 'line bytes'].map(
        (limit) => ({ mode, limit }),
      ),
    ),
  )('preserves delayed output continuity: $mode, $limit', ({ mode, limit }) => {
    const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 2,
        lineage: 'delayed-lineage',
        bindings: [],
        terminals: [
          {
            session: session('t'),
            scrollbackLines: ['old-partial'],
            exitCode: null,
            signal: null,
          },
        ],
        terminalCustomNames: {},
      }),
    );
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (): void => undefined,
    });
    let authority = new TerminalRecordAuthority({ repository });
    const read = fs.readFileSync;
    let blocked = true;
    const hold = mode === 'held reports' || mode === 'recreated reports';
    const spy = jest
      .spyOn(fs, 'readFileSync')
      .mockImplementation((path, options) => {
        if (
          blocked &&
          (String(path) === legacy || (hold && String(path) === recordFile()))
        )
          throw Object.assign(new Error('temporarily unreadable'), {
            code: 'EACCES',
          });
        return read(path, options);
      });
    try {
      authority.attribute({
        terminalId: 't',
        client,
        session: session('t'),
        persist: true,
      });
      const text =
        limit === 'continuous'
          ? 'new-0\nnew-1'
          : limit === 'line boundary'
            ? Array.from({ length: 5000 }, (_, i) => `new-${i}`).join('\n')
            : limit === 'line cap'
              ? Array.from({ length: 5001 }, (_, i) => `new-${i}`).join('\n')
              : limit === 'byte cap'
                ? Array.from(
                    { length: 5 },
                    (_, i) => `${i}${'😀'.repeat(256 * 1024 - 1)}`,
                  ).join('\n')
                : 'x'.repeat(1024 * 1024 + 1);
      // Cross each cap both on a cold buffer and after incremental measurement.
      const bytes = Buffer.from(text);
      const middle =
        mode === 'pending import' ? bytes.length : Math.floor(bytes.length / 2);
      authority.output('t', bytes.subarray(0, middle));
      authority.output('t', bytes.subarray(middle));
      authority.output('t', Buffer.from('!'));
      const truncated = !['continuous', 'line boundary'].includes(limit);
      if (!hold) {
        authority.flushSync();
        expect(
          record().record.truncatedHistoryIds?.includes('t') ?? false,
        ).toBe(truncated);
      }
      if (mode === 'pending reload') {
        authority.dispose();
        authority = new TerminalRecordAuthority({
          repository: new TerminalRecordRepository({
            dataRoot: root,
            flushDirectorySync: (): void => undefined,
          }),
        });
      }
      blocked = false;
      if (mode === 'recreated reports')
        authority.attribute({
          terminalId: 't',
          client,
          session: session('t'),
          persist: true,
        });
      const opened = authority.open(client);
      expect(opened.lineage).toBe('delayed-lineage');
      expect(opened.import.pending).toBeUndefined();
      expect(record().record.truncatedHistoryIds).toBeUndefined();
      const output = authority.historyRead({
        client,
        terminalId: 't',
        maxBytes: 4 * 1024 * 1024,
      }).text;
      if (limit === 'continuous' || limit === 'line boundary')
        expect(output).toBe(`old-partial${text}!`);
      else if (limit === 'line bytes')
        expect(output).toBe(`old-partial\n${'x'.repeat(1024 * 1024 - 1)}!`);
      else {
        expect(output).not.toContain('old-partial');
        if (limit === 'line cap')
          expect(output).toBe(text.split('\n').slice(1).join('\n') + '!');
        expect(output.endsWith('!')).toBe(true);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it.each([{ legacyLines: [] }, { legacyLines: ['complete', ''] }])(
    'does not invent a boundary before a capped suffix after $legacyLines',
    ({ legacyLines }) => {
      const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
      mkdirSync(dirname(legacy), { recursive: true });
      writeFileSync(
        legacy,
        JSON.stringify({
          version: 2,
          lineage: 'completed-line',
          bindings: [],
          terminalCustomNames: {},
          terminals: [
            {
              session: session('t'),
              scrollbackLines: legacyLines,
              exitCode: null,
              signal: null,
            },
          ],
        }),
      );
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      const read = fs.readFileSync;
      let blocked = true;
      const spy = jest
        .spyOn(fs, 'readFileSync')
        .mockImplementation((path, options) => {
          if (blocked && String(path) === legacy)
            throw Object.assign(new Error('unreadable legacy'), {
              code: 'EACCES',
            });
          return read(path, options);
        });
      try {
        const authority = new TerminalRecordAuthority({ repository });
        authority.attribute({
          terminalId: 't',
          client,
          session: session('t'),
          persist: true,
        });
        authority.output('t', Buffer.from('x'.repeat(1024 * 1024 + 1)));
        blocked = false;
        authority.open(client);
        expect(
          authority.historyRead({
            client,
            terminalId: 't',
            maxBytes: 2 * 1024 * 1024,
          }).text,
        ).toBe(legacyLines.join('\n') + 'x'.repeat(1024 * 1024));
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each(
    [1, 2].flatMap((version) =>
      ['', 't'.repeat(512), 't'.repeat(513), '../' + '😀'.repeat(300)].map(
        (terminalId) => ({ version, terminalId }),
      ),
    ),
  )(
    'reads and operates on stored v$version terminal IDs ($terminalId)',
    ({ version, terminalId }) => {
      const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
      mkdirSync(dirname(legacy), { recursive: true });
      writeFileSync(
        legacy,
        JSON.stringify({
          ...createEmptyState(),
          version,
          lineage: 'stored-id',
          bindings: [],
          terminals: [
            {
              session: session(terminalId),
              scrollbackLines: ['a'.repeat(1024) + 'b'.repeat(1024)],
              exitCode: null,
              signal: null,
            },
          ],
        }),
      );
      const authority = make();
      const params = WorkerTerminalRecordHistoryReadParamsSchema.parse({
        client,
        terminalId,
        maxBytes: 1024,
      });
      expect(authority.historyRead(params).text).toBe('a'.repeat(1024));
      const opened = WorkerTerminalRecordOpenResultSchema.parse(
        authority.open(client),
      );
      expect(opened.terminals[0].session.id).toBe(terminalId);
      rmSync(legacy);
      const reloaded = make();
      expect(reloaded.open(client).lineage).toBe(opened.lineage);
      const page = reloaded.historyRead(params);
      expect(page.text).toBe('a'.repeat(1024));
      expect(page.nextCursor?.length).toBeLessThanOrEqual(64);
      expect(
        reloaded.historyRead(
          WorkerTerminalRecordHistoryReadParamsSchema.parse({
            ...params,
            cursor: page.nextCursor,
          }),
        ),
      ).toMatchObject({
        text: 'b'.repeat(1024),
        restarted: false,
        nextCursor: null,
      });
      const producer = { id: 'legacy-ids', runId: 'r19' };
      reloaded.apply(
        WorkerTerminalRecordApplyParamsSchema.parse({
          client,
          producer,
          seq: 1,
          ops: [
            { op: 'output.append', terminalId, text: '!' },
            { op: 'exit', terminalId, exitCode: 7, signal: null },
            { op: 'rename', terminalId, name: 'Name' },
          ],
        }),
      );
      expect(reloaded.historyTail(client, terminalId, 4096)).toBe(
        'a'.repeat(1024) + 'b'.repeat(1024) + '!',
      );
      expect(reloaded.open(client).terminalCustomNames[terminalId]).toBe(
        'Name',
      );
      const afterExit = make().open(client);
      expect(afterExit.terminals[0]).toMatchObject({
        exitCode: 7,
        signal: null,
      });
      expect(afterExit.terminalCustomNames[terminalId]).toBe('Name');
      const ops = [
        { op: 'output.replace', terminalId, lines: ['replaced'] },
        {
          op: 'layout.save',
          servedIds: [terminalId],
          referencedIds: [terminalId],
          bindings: [
            { key: 'b', groupId: 'g', members: [{ key: 'm', terminalId }] },
          ],
          terminalCustomNames: { [terminalId]: 'Name' },
        },
      ];
      reloaded.apply(
        WorkerTerminalRecordApplyParamsSchema.parse({
          client,
          producer,
          seq: 2,
          ops,
        }),
      );
      expect(reloaded.historyRead(params).text).toBe('replaced');
      expect(reloaded.open(client).terminalCustomNames[terminalId]).toBe(
        'Name',
      );
      reloaded.apply(
        WorkerTerminalRecordApplyParamsSchema.parse({
          client,
          producer,
          seq: 3,
          ops: [{ op: 'forget', terminalId }],
        }),
      );
      expect(reloaded.open(client).terminals).toEqual([]);
      if (terminalId.length === 0 || terminalId.length > 512)
        expect(
          WorkerTerminalRecordApplyParamsSchema.safeParse({
            client,
            producer,
            seq: 4,
            ops: [{ op: 'session.upsert', session: session(terminalId) }],
          }).success,
        ).toBe(false);
    },
  );
});

describe('R18 record ownership and stored evidence', () => {
  it.each([false, true])(
    'filters v2 foreign sessions, mixed=%s, preserving identities and backup',
    (mixed) => {
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      const local = {
        session: session('ours'),
        scrollbackLines: ['ours'],
        exitCode: null,
        signal: null,
      };
      const foreign = {
        session: session('foreign', { worktreeId: 'elsewhere' }),
        scrollbackLines: ['private'],
        exitCode: null,
        signal: null,
      };
      const binding = {
        key: 'stable',
        groupId: 'stable-group',
        members: [
          { key: 'foreign-pane', terminalId: 'foreign' },
          ...(mixed ? [{ key: 'stable-pane', terminalId: 'ours' }] : []),
        ],
      };
      const bytes = JSON.stringify({
        version: 2,
        lineage: 'legacy',
        bindings: [binding],
        terminals: [foreign, ...(mixed ? [local] : [])],
        terminalCustomNames: {
          foreign: 'private name',
          ...(mixed ? { ours: 'our name' } : {}),
        },
      });
      const path = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      const previewInput = {
        projectId: 'proj',
        worktreeId: 'wt',
        layout: 'workspaces' as const,
      };
      expect(repository.previewLegacy(previewInput).terminals).toEqual(
        mixed ? [local] : [],
      );
      const authority = new TerminalRecordAuthority({ repository });
      expect(
        authority.historyRead({ client, terminalId: 'foreign' }).text,
      ).toBe('');
      const opened = authority.open(client);
      expect(opened.terminals.map((entry) => entry.session.id)).toEqual(
        mixed ? ['ours'] : [],
      );
      expect(opened.bindings).toEqual(
        mixed
          ? [
              {
                ...binding,
                members: [{ key: 'stable-pane', terminalId: 'ours' }],
              },
            ]
          : [],
      );
      expect(opened.terminalCustomNames).toEqual(
        mixed ? { ours: 'our name' } : {},
      );
      authority.dispose();
      rmSync(path);
      const reopened = make();
      expect(reopened.open(client).lineage).toBe(opened.lineage);
      expect(reopened.open(client).bindings).toEqual(opened.bindings);
      expect(reopened.historyRead({ client, terminalId: 'foreign' }).text).toBe(
        '',
      );
      expect(reopened.historyRead({ client, terminalId: 'ours' }).text).toBe(
        mixed ? 'ours' : '',
      );
      expect(repository.takeLegacyBackup('proj', 'wt')?.toString()).toBe(bytes);
    },
  );

  const damage: {
    name: string;
    change: (value: TerminalRecordEnvelope) => unknown;
  }[] = [
    ...[null, {}, [1]].map((truncatedHistoryIds) => ({
      name: `invalid history discontinuity ${JSON.stringify(truncatedHistoryIds)}`,
      change: (value: TerminalRecordEnvelope) => ({
        ...value,
        record: { ...value.record, truncatedHistoryIds },
      }),
    })),
    {
      name: 'partial import',
      change: (value) => ({ ...value, import: { at: 1 } }),
    },
    {
      name: 'invalid import source',
      change: (value) => ({
        ...value,
        import: { ...value.import, from: 'unknown' },
      }),
    },
    {
      name: 'invalid import digest',
      change: (value) => ({
        ...value,
        import: { ...value.import, sourceSha256: 1 },
      }),
    },
    {
      name: 'invalid import time',
      change: (value) => ({
        ...value,
        import: { ...value.import, at: 'yesterday' },
      }),
    },
    {
      name: 'fractional generation',
      change: (value) => ({ ...value, generation: 1.5 }),
    },
    {
      name: 'unsafe generation',
      change: (value) => ({
        ...value,
        generation: Number.MAX_SAFE_INTEGER + 1,
      }),
    },
    {
      name: 'negative revision',
      change: (value) => ({ ...value, revision: -2 }),
    },
    {
      name: 'fractional watermark',
      change: (value) => ({ ...value, producerWatermarks: { 'p/r': -0.5 } }),
    },
    {
      name: 'empty watermark key',
      change: (value) => ({ ...value, producerWatermarks: { '': 0 } }),
    },
    { name: 'empty lineage', change: (value) => ({ ...value, lineage: '' }) },
    ...['projectId', 'worktreeId'].map((field) => ({
      name: `foreign session ${field}`,
      change: (value: TerminalRecordEnvelope) => ({
        ...value,
        record: {
          ...value.record,
          terminals: value.record.terminals.map((entry) => ({
            ...entry,
            session: { ...entry.session, [field]: 'foreign' },
          })),
        },
      }),
    })),
    {
      name: 'fractional exit',
      change: (value) => ({
        ...value,
        record: {
          ...value.record,
          terminals: value.record.terminals.map((entry) => ({
            ...entry,
            exitCode: 0.5,
          })),
        },
      }),
    },
    {
      name: 'oversized signal',
      change: (value) => ({
        ...value,
        record: {
          ...value.record,
          terminals: value.record.terminals.map((entry) => ({
            ...entry,
            signal: 's'.repeat(257),
          })),
        },
      }),
    },
  ];
  it.each(damage)(
    'quarantines $name before serving protocol results',
    ({ change }) => {
      const seed = make();
      seed.apply({
        client,
        producer: { id: 'p', runId: 'r' },
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('t') },
          { op: 'output.append', terminalId: 't', text: 'private' },
        ],
      });
      seed.dispose();
      const bytes = JSON.stringify(change(record()));
      writeFileSync(recordFile(), bytes);
      const authority = make();
      expect(authority.historyRead({ client, terminalId: 't' }).text).toBe('');
      expect(readFileSync(recordFile(), 'utf8')).toBe(bytes);
      const opened = authority.open(client);
      expect(
        WorkerTerminalRecordOpenResultSchema.safeParse(opened).success,
      ).toBe(true);
      expect(opened.terminals).toEqual([]);
      const copies = readdirSync(dirname(recordFile())).filter((name) =>
        name.startsWith('record.json.damaged-'),
      );
      expect(copies).toHaveLength(1);
      expect(readFileSync(join(dirname(recordFile()), copies[0]), 'utf8')).toBe(
        bytes,
      );
      expect(make().open(client).terminals).toEqual([]);
    },
  );

  it.each([undefined, 'invalid', null, 1.5])(
    'does not use malformed fence ordering evidence %s to admit held output',
    (retiredAt) => {
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      const load = jest.spyOn(repository, 'load').mockImplementation(() => {
        throw new Error('unreadable');
      });
      const authority = new TerminalRecordAuthority({
        repository,
        now: (): number => 100,
      });
      authority.attribute({
        terminalId: 't',
        client,
        session: session('t'),
        persist: true,
      });
      authority.output('t', Buffer.from('held'));
      authority.exited('t', 0, null);
      mkdirSync(dirname(recordFile()), { recursive: true });
      writeFileSync(
        join(dirname(recordFile()), 'tombstone.json'),
        JSON.stringify({ generation: 1, incarnation: 'inc-1', retiredAt }),
      );
      load.mockRestore();
      expect(repository.load('proj', 'wt')).toMatchObject({
        kind: 'absent',
        tombstone: { damaged: true },
      });
      expect(() => authority.shutdown('app-quit')).toThrow();
      expect(authority.historyRead({ client, terminalId: 't' }).text).toBe('');
      expect(existsSync(recordFile())).toBe(false);
    },
  );

  it.each(['apply', 'attribute'])(
    'rejects foreign %s scope before importing or retiring',
    (entrypoint) => {
      const authority = make();
      const local = authority.open(client);
      const before = readFileSync(recordFile(), 'utf8');
      const next = { ...client, incarnation: 'next' };
      const foreign = session('foreign', { worktreeId: 'other' });
      if (entrypoint === 'apply')
        expect(() =>
          authority.apply(
            WorkerTerminalRecordApplyParamsSchema.parse({
              client: next,
              producer: { id: 'p', runId: 'r' },
              seq: 1,
              ops: [{ op: 'session.upsert', session: foreign }],
            }),
          ),
        ).toThrow();
      else
        authority.attribute({
          terminalId: 'foreign',
          client: next,
          session: foreign,
          persist: true,
        });
      expect(readFileSync(recordFile(), 'utf8')).toBe(before);
      expect(authority.open(client).generation).toBe(local.generation);
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      expect(existsSync(join(dirname(recordFile()), 'tombstone.json'))).toBe(
        false,
      );
    },
  );

  it.each([undefined, 'invalid', null, 1.5])(
    'keeps a surviving predecessor retired with malformed fence time %s',
    (retiredAt) => {
      const seed = make();
      seed.apply({
        client,
        producer: { id: 'p', runId: 'r' },
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('old') },
          { op: 'output.append', terminalId: 'old', text: 'retired history' },
        ],
      });
      seed.dispose();
      const predecessor = record();
      const before = readFileSync(recordFile(), 'utf8');
      const fence = join(dirname(recordFile()), 'tombstone.json');
      const bytes = JSON.stringify({
        generation: predecessor.generation,
        incarnation: client.incarnation,
        retiredAt,
      });
      writeFileSync(fence, bytes);
      const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
      mkdirSync(dirname(legacy), { recursive: true });
      writeFileSync(
        legacy,
        JSON.stringify({ ...predecessor.record, version: 2, lineage: 'old' }),
      );
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      expect(repository.load('proj', 'wt')).toMatchObject({
        kind: 'absent',
        tombstone: { damaged: true },
      });
      expect(readFileSync(recordFile(), 'utf8')).toBe(before);
      expect(readFileSync(fence, 'utf8')).toBe(bytes);
      const authority = new TerminalRecordAuthority({ repository });
      expect(authority.historyRead({ client, terminalId: 'old' }).text).toBe(
        '',
      );
      const successor = authority.open(client);
      expect(successor.generation).toBeGreaterThan(predecessor.generation);
      expect(successor.terminals).toEqual([]);
      expect(successor.import).toMatchObject({ from: 'none' });
      expect(
        authority.apply({
          client,
          generation: predecessor.generation,
          producer: { id: 'p', runId: 'r' },
          seq: 2,
          ops: [{ op: 'session.upsert', session: session('late') }],
        }).outcome,
      ).toBe('dropped');
      expect(make().open(client).generation).toBe(successor.generation);
      expect(make().historyRead({ client, terminalId: 'old' }).text).toBe('');
    },
  );

  it('keeps a valid successor readable beside a malformed earlier fence', () => {
    const seed = make();
    seed.apply({
      client,
      producer: { id: 'p', runId: 'r' },
      seq: 1,
      ops: [
        { op: 'session.upsert', session: session('new') },
        { op: 'output.append', terminalId: 'new', text: 'successor history' },
      ],
    });
    seed.dispose();
    const successor = record();
    writeFileSync(
      join(dirname(recordFile()), 'tombstone.json'),
      JSON.stringify({ generation: successor.generation, incarnation: null }),
    );
    successor.generation += 1;
    writeFileSync(recordFile(), JSON.stringify(successor));
    expect(make().open(client).generation).toBe(successor.generation);
    expect(make().historyRead({ client, terminalId: 'new' }).text).toBe(
      'successor history',
    );
  });

  it('snapshots held attribution sessions before a delayed ownership transfer', () => {
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (): void => undefined,
    });
    const load = jest.spyOn(repository, 'load').mockImplementation(() => {
      throw new Error('unreadable');
    });
    const authority = new TerminalRecordAuthority({ repository });
    const supplied = session('held');
    authority.attribute({
      terminalId: 'held',
      client,
      session: supplied,
      persist: true,
    });
    authority.output('held', Buffer.from('held output'));
    supplied.worktreeId = 'foreign';
    supplied.cwd = '/injected';
    load.mockRestore();
    const opened = authority.open(client);
    expect(opened.terminals[0].session).toMatchObject({
      worktreeId: 'wt',
      cwd: '/tmp',
    });
    expect(authority.historyRead({ client, terminalId: 'held' }).text).toBe(
      'held output',
    );
    authority.flushSync();
    expect(make().open(client).terminals[0].session).toMatchObject({
      worktreeId: 'wt',
      cwd: '/tmp',
    });
  });

  it('detaches transferred sessions, nested layouts and returned bindings', () => {
    const authority = make();
    const attributed = session('t');
    authority.attribute({
      terminalId: 't',
      client,
      session: attributed,
      persist: true,
    });
    authority.flushSync();
    const original = structuredClone(authority.open(client));
    const disk = readFileSync(recordFile(), 'utf8');
    attributed.cwd = '/changed';
    attributed.worktreeId = 'foreign';
    const returned = authority.open(client);
    returned.bindings[0].members[0].terminalId = 'injected';
    expect(authority.open(client)).toEqual(original);
    expect(readFileSync(recordFile(), 'utf8')).toBe(disk);
    const supplied = session('producer');
    const bindings = [
      {
        key: 'b',
        groupId: 'g',
        members: [{ key: 'm', terminalId: 'producer' }],
      },
    ];
    authority.apply({
      client,
      producer: { id: 'p', runId: 'r' },
      seq: 1,
      ops: [
        { op: 'session.upsert', session: supplied },
        {
          op: 'layout.save',
          servedIds: [],
          referencedIds: ['producer'],
          bindings,
          terminalCustomNames: {},
        },
      ],
    });
    const applied = structuredClone(authority.open(client));
    supplied.title = 'injected';
    bindings[0].members[0].terminalId = 'injected';
    expect(authority.open(client)).toEqual(applied);
    authority.flushSync();
    expect(make().open(client).bindings).toEqual(applied.bindings);
  });

  it.each([0, 1.5, -1, Number.MAX_SAFE_INTEGER + 1])(
    'treats invalid fence generation %s as damaged',
    (generation) => {
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      mkdirSync(dirname(recordFile()), { recursive: true });
      writeFileSync(
        join(dirname(recordFile()), 'tombstone.json'),
        JSON.stringify({ generation, incarnation: 'inc-1', retiredAt: 1 }),
      );
      expect(repository.load('proj', 'wt')).toMatchObject({
        kind: 'absent',
        tombstone: { damaged: true },
      });
    },
  );

  it.each([1, 2])(
    'keeps wider v%s legacy data readable with valid projected exits',
    (version) => {
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      const path = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
      const terminal = {
        session: session('t', { title: 't'.repeat(70000) }),
        scrollbackLines: ['history'],
        exitCode: 0.5,
        signal: 's'.repeat(257),
      };
      const value =
        version === 1
          ? { ...createEmptyState(), terminals: [terminal] }
          : {
              version: 2,
              lineage: '',
              bindings: [
                {
                  key: 'k'.repeat(600),
                  groupId: 'g'.repeat(600),
                  members: [{ key: 'm'.repeat(600), terminalId: 't' }],
                },
              ],
              terminals: [terminal],
              terminalCustomNames: {},
            };
      const bytes = JSON.stringify(value);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      const authority = new TerminalRecordAuthority({ repository });
      const opened = authority.open(client);
      expect(
        WorkerTerminalRecordOpenResultSchema.safeParse(opened).success,
      ).toBe(true);
      expect(opened.terminals[0]).toMatchObject({
        exitCode: null,
        signal: null,
        session: terminal.session,
      });
      expect(authority.historyRead({ client, terminalId: 't' }).text).toBe(
        'history',
      );
      authority.dispose();
      rmSync(path);
      const reopened = make();
      expect(reopened.open(client)).toMatchObject({
        lineage: opened.lineage,
        terminals: opened.terminals,
        bindings: opened.bindings,
      });
      expect(reopened.historyRead({ client, terminalId: 't' }).text).toBe(
        'history',
      );
      expect(repository.takeLegacyBackup('proj', 'wt')?.toString()).toBe(bytes);
    },
  );

  it('detaches legacy preview entries on cache miss and hit', () => {
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (): void => undefined,
    });
    const path = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        ...createEmptyState(),
        terminals: [
          {
            session: session('t'),
            scrollbackLines: ['original'],
            exitCode: null,
            signal: null,
          },
        ],
      }),
    );
    const input = {
      projectId: 'proj',
      worktreeId: 'wt',
      layout: 'workspaces' as const,
    };
    for (const injected of ['miss', 'hit']) {
      const preview = repository.previewLegacy(input);
      expect(preview.terminals[0].scrollbackLines).toEqual(['original']);
      preview.terminals[0].scrollbackLines[0] = injected;
      preview.terminals[0].session.cwd = '/injected';
    }
    expect(repository.previewLegacy(input).terminals[0].session.cwd).toBe(
      '/tmp',
    );
    expect(
      repository.previewLegacy(input).terminals[0].scrollbackLines,
    ).toEqual(['original']);
  });

  it.each(['attribute', 'upsert', 'forget', 'layout'])(
    'discharges superseded shutdown instances only after durable %s replacement',
    (replacement) => {
      let blocked = false;
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => {
          if (blocked) throw new Error('flush failed');
        },
      });
      const authority = new TerminalRecordAuthority({ repository });
      authority.attribute({
        terminalId: 't',
        client,
        session: session('t'),
        persist: true,
      });
      authority.flushSync();
      blocked = true;
      expect(() => authority.shutdown('app-quit')).toThrow();
      authority.exited('t', null, null);
      if (replacement === 'attribute') {
        authority.attribute({
          terminalId: 't',
          client,
          session: session('t', { createdAt: 2 }),
          persist: true,
        });
        authority.exited('t', 0, null);
      } else {
        const ops =
          replacement === 'upsert'
            ? [
                {
                  op: 'session.upsert' as const,
                  session: session('t', { createdAt: 2 }),
                },
                {
                  op: 'exit' as const,
                  terminalId: 't',
                  exitCode: 0,
                  signal: null,
                },
              ]
            : replacement === 'forget'
              ? [{ op: 'forget' as const, terminalId: 't' }]
              : [
                  {
                    op: 'layout.save' as const,
                    servedIds: ['t'],
                    referencedIds: [],
                    bindings: [],
                    terminalCustomNames: {},
                  },
                ];
        expect(() =>
          authority.apply({
            client,
            producer: { id: 'p', runId: 'r' },
            seq: 1,
            ops,
          }),
        ).toThrow();
      }
      expect(() => authority.shutdown('app-quit')).toThrow();
      blocked = false;
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      const reopened = make().open(client);
      expect(reopened.terminals.map((entry) => entry.session.id)).toEqual(
        replacement === 'attribute' || replacement === 'upsert' ? ['t'] : [],
      );
      if (reopened.terminals[0]) {
        expect(reopened.terminals[0].signal).toBeNull();
        expect(reopened.terminals[0].exitCode).toBe(0);
      }
    },
  );

  it('accepts 255 byte path components and rejects impossible 256 byte components', () => {
    const id = 'a'.repeat(255);
    const authority = make();
    expect(
      authority.open({ ...client, projectId: id, worktreeId: id }).terminals,
    ).toEqual([]);
    expect(() => terminalRecordDir(root, `${id}a`, 'wt')).toThrow(
      'Invalid terminal record projectId',
    );
    expect(() => terminalRecordDir(root, 'proj', `${id}a`)).toThrow(
      'Invalid terminal record worktreeId',
    );
  });
});

describe('R17 stored scope, observational reads and layout identities', () => {
  it.each(
    [
      { projectId: 'other', worktreeId: 'wt' },
      { projectId: 'proj', worktreeId: 'other' },
      { projectId: 'other', worktreeId: 'other' },
    ].flatMap((scope) =>
      ['open', 'apply'].map((write) => ({ ...scope, write })),
    ),
  )(
    'rejects foreign $projectId/$worktreeId records before reads and $write',
    ({ projectId, worktreeId, write }) => {
      const foreign = { ...client, projectId, worktreeId };
      const source = make();
      source.apply({
        client: foreign,
        producer: { id: 'foreign', runId: 'r' },
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('foreign', foreign) },
          { op: 'output.append', terminalId: 'foreign', text: 'private' },
        ],
      });
      source.dispose();
      const foreignPath = join(
        terminalRecordDir(root, projectId, worktreeId),
        'record.json',
      );
      const bytes = readFileSync(foreignPath, 'utf8');
      mkdirSync(dirname(recordFile()), { recursive: true });
      writeFileSync(recordFile(), bytes);
      const authority = make();
      expect(
        authority.historyRead({ client, terminalId: 'foreign' }).text,
      ).toBe('');
      expect(authority.historyTail(client, 'foreign', 100)).toBe('');
      expect(readFileSync(recordFile(), 'utf8')).toBe(bytes);
      if (write === 'open')
        expect(authority.open(client).terminals).toEqual([]);
      expect(
        authority.apply({
          client,
          producer: { id: 'local', runId: 'r' },
          seq: 1,
          ops: [
            { op: 'session.upsert', session: session('local') },
            { op: 'output.append', terminalId: 'local', text: 'ours' },
          ],
        }).outcome,
      ).toBe('applied');
      expect(record().scope).toEqual({ projectId: 'proj', worktreeId: 'wt' });
      expect(readFileSync(foreignPath, 'utf8')).toBe(bytes);
      const copies = readdirSync(dirname(recordFile())).filter((name) =>
        name.startsWith('record.json.damaged-'),
      );
      expect(copies).toHaveLength(1);
      expect(readFileSync(join(dirname(recordFile()), copies[0]), 'utf8')).toBe(
        bytes,
      );
      const restarted = make();
      expect(
        restarted.open(client).terminals.map((entry) => entry.session.id),
      ).toEqual(['local']);
      expect(restarted.historyRead({ client, terminalId: 'local' }).text).toBe(
        'ours',
      );
      expect(
        restarted.historyRead({ client: foreign, terminalId: 'foreign' }).text,
      ).toBe('private');
    },
  );

  it.each(
    ['absent', 'valid', 'damaged'].flatMap((fence) =>
      ['{unreadable', '{}'].flatMap((bytes) =>
        ['open', 'apply'].map((write) => ({ fence, bytes, write })),
      ),
    ),
  )(
    'keeps damaged record reads observational ($fence fence, $bytes, then $write)',
    ({ fence, bytes, write }) => {
      const directory = dirname(recordFile());
      mkdirSync(directory, { recursive: true });
      writeFileSync(recordFile(), bytes);
      for (let stamp = 1; stamp <= 6; stamp++)
        writeFileSync(`${recordFile()}.damaged-${stamp}`, `recovery-${stamp}`);
      if (fence !== 'absent')
        writeFileSync(
          join(directory, 'tombstone.json'),
          fence === 'damaged'
            ? '{damaged fence'
            : JSON.stringify({
                generation: 1,
                incarnation: 'inc-1',
                retiredAt: 1,
              }),
        );
      const snapshot = (): Record<string, string> =>
        Object.fromEntries(
          readdirSync(directory)
            .sort()
            .map((name) => [name, readFileSync(join(directory, name), 'utf8')]),
        );
      const before = snapshot();
      const rename = jest.spyOn(fs, 'renameSync');
      const unlink = jest.spyOn(fs, 'unlinkSync');
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      expect(repository.load('proj', 'wt').kind).toBe('absent');
      const authority = new TerminalRecordAuthority({ repository });
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(
          authority.historyRead({ client, terminalId: 'missing' }).text,
        ).toBe('');
        expect(authority.historyTail(client, 'missing', 100)).toBe('');
      }
      expect(rename).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
      if (write === 'open')
        expect(authority.open(client).terminals).toEqual([]);
      else
        expect(
          authority.apply({
            client,
            producer: { id: 'local', runId: 'r' },
            seq: 1,
            ops: [],
          }).outcome,
        ).toBe('applied');
      const copies = readdirSync(directory).filter((name) =>
        name.startsWith('record.json.damaged-'),
      );
      expect(copies).toHaveLength(5);
      expect(
        copies.map((name) => readFileSync(join(directory, name), 'utf8')),
      ).toContain(bytes);
      expect(record().scope).toEqual({ projectId: 'proj', worktreeId: 'wt' });
    },
  );

  it.each(
    ['damaged', 'foreign'].flatMap((contents) =>
      ['open', 'apply'].map((write) => ({ contents, write })),
    ),
  )(
    'retains $contents bytes when quarantine fails before $write',
    ({ contents, write }) => {
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      const foreign = repository.empty(
        {
          projectId: 'other',
          worktreeId: 'wt',
          incarnation: 'inc-1',
          generation: 1,
        },
        'none',
      );
      foreign.record.terminals.push({
        session: session('foreign', { projectId: 'other' }),
        scrollbackLines: ['private'],
        exitCode: 0,
        signal: null,
      });
      const bytes =
        contents === 'foreign' ? JSON.stringify(foreign) : '{damaged';
      mkdirSync(dirname(recordFile()), { recursive: true });
      writeFileSync(recordFile(), bytes);
      const authority = new TerminalRecordAuthority({ repository });
      const batch = {
        client,
        producer: { id: 'local', runId: 'quarantine' },
        seq: 1,
        ops: [
          { op: 'session.upsert' as const, session: session('local') },
          { op: 'output.append' as const, terminalId: 'local', text: 'ours' },
        ],
      };
      const attempt = (): unknown =>
        write === 'open' ? authority.open(client) : authority.apply(batch);
      const rename = fs.renameSync;
      const fault = Object.assign(new Error('quarantine unavailable'), {
        code: 'EACCES',
      });
      let hits = 0;
      const failing = jest
        .spyOn(fs, 'renameSync')
        .mockImplementation((from, to) => {
          if (
            String(from) === recordFile() &&
            String(to).startsWith(`${recordFile()}.damaged-`)
          ) {
            hits += 1;
            throw fault;
          }
          rename(from, to);
        });
      try {
        for (let retry = 0; retry < 2; retry++) {
          expect(() => attempt()).toThrow(fault);
          expect(readFileSync(recordFile(), 'utf8')).toBe(bytes);
          expect(
            authority.historyRead({ client, terminalId: 'foreign' }).text,
          ).toBe('');
        }
        expect(hits).toBe(2);
        expect(readdirSync(dirname(recordFile()))).toEqual(['record.json']);
      } finally {
        failing.mockRestore();
      }
      attempt();
      expect(authority.apply(batch).outcome).toBe(
        write === 'open' ? 'applied' : 'duplicate',
      );
      expect(record().scope).toEqual({ projectId: 'proj', worktreeId: 'wt' });
      const copies = readdirSync(dirname(recordFile())).filter((name) =>
        name.startsWith('record.json.damaged-'),
      );
      expect(copies).toHaveLength(1);
      expect(readFileSync(join(dirname(recordFile()), copies[0]), 'utf8')).toBe(
        bytes,
      );
      expect(make().historyRead({ client, terminalId: 'local' }).text).toBe(
        'ours',
      );
    },
  );

  it.each([1, 502, 503, 507, 508, 512])(
    'round-trips generated layout identities for %i-character terminal IDs',
    (length) => {
      const authority = make();
      const ids = ['a'.repeat(length), `${'a'.repeat(length - 1)}b`];
      const producer = { id: 'layout', runId: 'r' };
      expect(
        authority.apply(
          WorkerTerminalRecordApplyParamsSchema.parse({
            client,
            producer,
            seq: 1,
            ops: ids.map((id) => ({
              op: 'session.upsert',
              session: session(id),
            })),
          }),
        ).outcome,
      ).toBe('applied');
      const opened = WorkerTerminalRecordOpenResultSchema.parse(
        authority.open(client),
      );
      expect(opened.bindings).toHaveLength(2);
      expect(new Set(opened.bindings.map((binding) => binding.key)).size).toBe(
        2,
      );
      expect(
        new Set(opened.bindings.map((binding) => binding.groupId)).size,
      ).toBe(2);
      expect(
        new Set(
          opened.bindings.flatMap((binding) =>
            binding.members.map((member) => member.key),
          ),
        ).size,
      ).toBe(2);
      for (const binding of opened.bindings)
        for (const key of [
          binding.key,
          binding.groupId,
          ...binding.members.map((member) => member.key),
        ]) {
          expect(key.length).toBeGreaterThan(0);
          expect(key.length).toBeLessThanOrEqual(512);
        }
      expect(
        authority.apply(
          WorkerTerminalRecordApplyParamsSchema.parse({
            client,
            producer,
            seq: 2,
            ops: [
              {
                op: 'layout.save',
                bindings: opened.bindings,
                servedIds: ids,
                referencedIds: ids,
                terminalCustomNames: {},
              },
            ],
          }),
        ).outcome,
      ).toBe('applied');
      expect(make().open(client).bindings).toEqual(opened.bindings);
      // Recreating the same terminal derives the same identities, not random keys.
      expect(
        authority.apply(
          WorkerTerminalRecordApplyParamsSchema.parse({
            client,
            producer,
            seq: 3,
            ops: [
              ...ids.map((terminalId) => ({ op: 'forget', terminalId })),
              ...ids.map((id) => ({
                op: 'session.upsert',
                session: session(id),
              })),
            ],
          }),
        ).outcome,
      ).toBe('applied');
      expect(authority.open(client).bindings).toEqual(opened.bindings);
      for (const id of ['', 'a'.repeat(513)])
        expect(
          WorkerTerminalRecordApplyParamsSchema.safeParse({
            client,
            producer,
            seq: 4,
            ops: [{ op: 'session.upsert', session: session(id) }],
          }).success,
        ).toBe(false);
    },
  );

  it('round-trips generated identities when a derived key is already occupied', () => {
    const authority = make();
    const terminalId = 'a'.repeat(512);
    const producer = { id: 'layout', runId: 'collision' };
    authority.apply({
      client,
      producer,
      seq: 1,
      ops: [{ op: 'session.upsert', session: session(terminalId) }],
    });
    const alias = authority.open(client).bindings[0].key.slice('live/'.length);
    authority.apply(
      WorkerTerminalRecordApplyParamsSchema.parse({
        client,
        producer,
        seq: 2,
        ops: [{ op: 'session.upsert', session: session(alias) }],
      }),
    );
    const opened = WorkerTerminalRecordOpenResultSchema.parse(
      authority.open(client),
    );
    expect(new Set(opened.bindings.map((binding) => binding.key)).size).toBe(2);
    expect(
      new Set(opened.bindings.map((binding) => binding.groupId)).size,
    ).toBe(2);
    expect(
      authority.apply(
        WorkerTerminalRecordApplyParamsSchema.parse({
          client,
          producer,
          seq: 3,
          ops: [
            {
              op: 'layout.save',
              bindings: opened.bindings,
              servedIds: [terminalId, alias],
              referencedIds: [terminalId, alias],
              terminalCustomNames: {},
            },
          ],
        }),
      ).outcome,
    ).toBe('applied');
    expect(make().open(client).bindings).toEqual(opened.bindings);
  });

  it('preserves imported legacy identities beyond the new-write key bounds', () => {
    const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
    const bindings = [
      {
        key: 'k'.repeat(513),
        groupId: 'g'.repeat(513),
        members: [{ key: 'p'.repeat(513), terminalId: 'legacy' }],
      },
    ];
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 2,
        lineage: 'L',
        bindings,
        terminals: [
          {
            session: session('legacy'),
            scrollbackLines: ['kept'],
            exitCode: 0,
            signal: null,
          },
        ],
        terminalCustomNames: {},
      }),
    );
    expect(
      WorkerTerminalRecordOpenResultSchema.parse(make().open(client)).bindings,
    ).toEqual(bindings);
  });
});

it.each(
  [
    { predecessor: 'inc-1', successor: 'inc-1' },
    { predecessor: 'inc-1', successor: null },
    { predecessor: null, successor: 'inc-1' },
  ].flatMap((incarnations) =>
    [undefined, 'new'].flatMap((lifetimeId) =>
      [undefined, 100, 200, 300].map((requestedAt) => ({
        ...incarnations,
        lifetimeId,
        requestedAt,
      })),
    ),
  ),
)(
  'R16 delayed retirement naming only old retains new held reports ($predecessor -> $successor, identity $lifetimeId, cutoff $requestedAt)',
  ({ predecessor, successor, lifetimeId, requestedAt }) => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(100);
      const old = { ...client, incarnation: predecessor, lifetimeId: 'old' };
      const next = { ...client, incarnation: successor, lifetimeId };
      const seed = make();
      expect(seed.open(old).generation).toBe(1);
      seed.dispose();
      jest.setSystemTime(200);
      const authority = make();
      const restore = failReads();
      try {
        for (const [terminalId, owner] of [
          ['old-terminal', old],
          ['new-terminal', next],
        ] as const) {
          authority.attribute({
            terminalId,
            client: owner,
            session: session(terminalId),
            persist: true,
          });
          authority.output(
            terminalId,
            Buffer.from(
              `${terminalId === 'old-terminal' ? 'old' : 'new'}-held\n`,
            ),
          );
        }
      } finally {
        restore();
      }
      expect(
        authority.retire({
          projectId: 'proj',
          worktreeId: 'wt',
          lifetimeIds: ['old'],
          requestedAt,
        }),
      ).toEqual({ retired: 1 });
      expect(authority.isAttributed('new-terminal')).toBe(false);
      authority.output('new-terminal', Buffer.from('still-held\n'));
      const opened = authority.open(next);
      expect(opened.generation).toBe(2);
      expect(opened.terminals.map((entry) => entry.session.id)).toEqual([
        'new-terminal',
      ]);
      expect(authority.isAttributed('new-terminal')).toBe(true);
      expect(authority.isAttributed('old-terminal')).toBe(false);
      expect(
        authority.historyRead({ client: next, terminalId: 'new-terminal' })
          .text,
      ).toBe('new-held\nstill-held\n');
      authority.output('new-terminal', Buffer.from('later'));
      authority.exited('new-terminal', 7, 'SIGTERM');
      authority.flushSync();
      const reloaded = make();
      expect(
        reloaded.historyRead({ client: next, terminalId: 'new-terminal' }).text,
      ).toBe('new-held\nstill-held\nlater');
      expect(reloaded.open(next).terminals[0]).toMatchObject({
        exitCode: 7,
        signal: 'SIGTERM',
      });
      expect(
        reloaded.apply({
          client: old,
          generation: 1,
          producer: { id: 'late-old', runId: 'run' },
          seq: 1,
          ops: [],
        }).outcome,
      ).toBe('dropped');
    } finally {
      jest.useRealTimers();
    }
  },
);

it.each([100, 200])(
  'R16 legacy retirement cutoff %s discharges covered reports without losing later anonymous reports',
  (requestedAt) => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(0);
      const seed = make();
      seed.open(client);
      seed.dispose();
      const authority = make();
      const restore = failReads();
      try {
        for (const [terminalId, capturedAt] of [
          ['old-terminal', 100],
          ['new-terminal', 300],
        ] as const) {
          jest.setSystemTime(capturedAt);
          authority.attribute({
            terminalId,
            client,
            session: session(terminalId),
            persist: true,
          });
          authority.output(terminalId, Buffer.from(`${terminalId}\n`));
        }
      } finally {
        restore();
      }
      expect(
        authority.retire({ projectId: 'proj', worktreeId: 'wt', requestedAt }),
      ).toEqual({ retired: 1 });
      expect(() => authority.shutdown('app-quit')).toThrow(
        'unresolved attributions',
      );
      const opened = authority.open(client);
      expect(opened.generation).toBe(2);
      expect(opened.terminals.map((entry) => entry.session.id)).toEqual([
        'new-terminal',
      ]);
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 1 });
      const reloaded = make();
      expect(
        reloaded.historyRead({ client, terminalId: 'new-terminal' }).text,
      ).toBe('new-terminal\n');
      expect(reloaded.open(client).terminals[0]?.signal).toBe('app-quit');
    } finally {
      jest.useRealTimers();
    }
  },
);

it.each([undefined, 100, 200])(
  'R16 legacy retirement cutoff %s releases covered anonymous reports for shutdown',
  (requestedAt) => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(100);
      const authority = make();
      const restore = failReads();
      try {
        authority.attribute({
          terminalId: 'old-terminal',
          client,
          session: session('old-terminal'),
          persist: true,
        });
        authority.output('old-terminal', Buffer.from('retired'));
        authority.exited('old-terminal', 7, 'SIGTERM');
      } finally {
        restore();
      }
      expect(
        authority.retire({ projectId: 'proj', worktreeId: 'wt', requestedAt }),
      ).toEqual({ retired: 1 });
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      expect(existsSync(recordFile())).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  },
);

describe('R14 stable admission and cursor identity', () => {
  function legacy(terminals: unknown[], worktreeId = 'wt'): void {
    const path = legacyTerminalStatePath(
      root,
      'workspaces',
      'proj',
      worktreeId,
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        lineage: 'legacy-lineage',
        bindings: [],
        terminals,
        terminalCustomNames: {},
      }),
    );
  }

  it.each(['legacy-v2', 'absent-source'])(
    'held reports survive a same-generation import lineage change (%s)',
    (source) => {
      jest.useFakeTimers();
      try {
        if (source === 'legacy-v2') legacy([]);
        const repository = new TerminalRecordRepository({
          dataRoot: root,
          flushDirectorySync: (): void => undefined,
        });
        const authority = new TerminalRecordAuthority({ repository });
        const release = failReads();
        for (const id of ['a', 'b', 'exited']) {
          authority.attribute({
            terminalId: id,
            client,
            session: session(id),
            persist: true,
          });
          authority.output(id, Buffer.from(`${id}-prefix`));
        }
        authority.exited('exited', 7, 'SIGTERM');
        release();
        const importing = jest.spyOn(repository, 'importLegacy');
        importing.mockImplementationOnce(() => {
          throw new Error('import blocked');
        });
        // This admits all compatible held reports without replaying any of them.
        authority.attribute({
          terminalId: 'anchor',
          client,
          session: session('anchor'),
          persist: true,
        });
        const pendingLineage = record().lineage;
        expect(record().import.pending).toBe(true);
        expect(authority.historyRead({ client, terminalId: 'b' }).text).toBe(
          'b-prefix',
        );
        expect(record().lineage).not.toBe(pendingLineage);
        expect(record().generation).toBe(1);
        authority.exited('a', 0, null);
        authority.exited('b', 3, 'SIGINT');
        authority.exited('anchor', 0, null);
        expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
        const fresh = make();
        for (const [id, exitCode, signal] of [
          ['a', 0, null],
          ['b', 3, 'SIGINT'],
          ['exited', 7, 'SIGTERM'],
        ] as const) {
          expect(fresh.historyRead({ client, terminalId: id }).text).toBe(
            `${id}-prefix`,
          );
          expect(
            fresh
              .open(client)
              .terminals.find((entry) => entry.session.id === id),
          ).toMatchObject({ exitCode, signal });
        }
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('recreation carries admitted output across import without sharing its decoder', () => {
    jest.useFakeTimers();
    try {
      legacy([]);
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      const authority = new TerminalRecordAuthority({ repository });
      const held = { ...client, lifetimeId: 'a' };
      const release = failReads();
      authority.attribute({
        terminalId: 'a',
        client: held,
        session: session('a'),
        persist: true,
      });
      authority.output('a', Buffer.from('prefix'));
      authority.output('a', Uint8Array.from([0xe2, 0x82]));
      release();
      jest.spyOn(repository, 'importLegacy').mockImplementationOnce(() => {
        throw new Error('import blocked');
      });
      authority.attribute({
        terminalId: 'anchor',
        client: held,
        session: session('anchor'),
        persist: true,
      });
      const pendingLineage = record().lineage;
      authority.attribute({
        terminalId: 'other',
        client: { ...client, lifetimeId: 'other' },
        session: session('other'),
        persist: true,
      });
      expect(record().lineage).not.toBe(pendingLineage);
      // No replaying read/open can repair the original admission before recreation.
      authority.attribute({
        terminalId: 'a',
        client: held,
        session: session('a'),
        persist: true,
      });
      authority.output('a', Uint8Array.from([0xac]));
      authority.exited('a', 0, null);
      authority.flushSync();
      expect(make().historyRead({ client, terminalId: 'a' }).text).toBe(
        'prefix\ufffd\ufffd',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['recreation', 'retirement'])(
    '%s uses the actual admitted generation, not the requested generation',
    (action) => {
      jest.useFakeTimers();
      try {
        const authority = make();
        const requested = { ...client, generation: 9, lifetimeId: 'held' };
        const release = failReads();
        authority.attribute({
          terminalId: 'held',
          client: requested,
          session: session('held'),
          persist: true,
        });
        authority.output('held', Buffer.from('prefix'));
        release();
        // The first record always starts at generation 1, even when requested higher.
        authority.attribute({
          terminalId: 'anchor',
          client: requested,
          session: session('anchor'),
          persist: true,
        });
        expect(record().generation).toBe(1);
        const admitted = { ...requested, generation: 1 };
        if (action === 'recreation') {
          authority.attribute({
            terminalId: 'held',
            client: admitted,
            session: session('held'),
            persist: true,
          });
          authority.output('held', Buffer.from('-suffix'));
          authority.exited('held', 0, null);
          authority.exited('anchor', 0, null);
          expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
          expect(
            make().historyRead({ client: admitted, terminalId: 'held' }).text,
          ).toBe('prefix-suffix');
        } else {
          expect(
            authority.retire({
              projectId: client.projectId,
              worktreeId: client.worktreeId,
              generation: 1,
            }),
          ).toEqual({ retired: 1 });
          expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
          expect(
            make().historyRead({ client: admitted, terminalId: 'held' }).text,
          ).toBe('');
        }
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each([
    ['same destination', undefined],
    ['successor', undefined],
    ['same destination', 'held'],
    ['successor', 'held'],
  ] as const)(
    'recreation compares the admitted destination, not the original incarnation (%s, lifetimeId=%s)',
    (destination, lifetimeId) => {
      jest.useFakeTimers();
      try {
        make().open(client);
        const authority = make();
        const requested = {
          ...client,
          incarnation: 'inc-2',
          generation: 9,
          lifetimeId,
        };
        const release = failReads();
        authority.attribute({
          terminalId: 'held',
          client: requested,
          session: session('held'),
          persist: true,
        });
        authority.output('held', Buffer.from('prefix'));
        release();
        authority.attribute({
          terminalId: 'anchor',
          client: requested,
          session: session('anchor'),
          persist: true,
        });
        expect(record()).toMatchObject({ generation: 1, incarnation: 'inc-1' });
        const recreated = {
          ...requested,
          incarnation: destination === 'successor' ? 'inc-2' : 'inc-1',
          generation: destination === 'successor' ? undefined : 1,
        };
        authority.attribute({
          terminalId: 'held',
          client: recreated,
          session: session('held'),
          persist: true,
        });
        authority.output('held', Buffer.from('-suffix'));
        authority.exited('held', 0, null);
        authority.exited('anchor', 0, null);
        expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
        expect(record().generation).toBe(destination === 'successor' ? 2 : 1);
        if (destination === 'successor' && lifetimeId !== undefined) {
          // Reusing a retired producer identity cannot read its successor.
          expect(record().retiredLifetimeIds).toContain(lifetimeId);
          expect(
            record()
              .record.terminals.find((entry) => entry.session.id === 'held')
              ?.scrollbackLines.join('\n'),
          ).toBe('-suffix');
          expect(
            make().historyRead({ client: recreated, terminalId: 'held' }).text,
          ).toBe('');
          expect(
            make().historyRead({
              client: { ...recreated, lifetimeId: undefined },
              terminalId: 'held',
            }).text,
          ).toBe('-suffix');
          for (const [readerId, expected] of [
            [lifetimeId, ''],
            ['fresh-successor', '-suffix'],
          ] as const) {
            expect(
              make().historyRead({
                client: { ...recreated, lifetimeId: readerId, generation: 2 },
                terminalId: 'held',
              }).text,
            ).toBe(expected);
          }
        } else
          expect(
            make().historyRead({ client: recreated, terminalId: 'held' }).text,
          ).toBe(destination === 'successor' ? '-suffix' : 'prefix-suffix');
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('cursors isolate terminals at equal revisions and continue without a revision parameter', () => {
    const authority = make();
    authority.apply({
      client,
      producer: { id: 'pages', runId: 'run' },
      seq: 1,
      ops: [
        { op: 'session.upsert', session: session('a') },
        { op: 'session.upsert', session: session('b') },
        {
          op: 'output.append',
          terminalId: 'a',
          text: 'a'.repeat(1024) + 'A'.repeat(1024),
        },
        {
          op: 'output.append',
          terminalId: 'b',
          text: 'b'.repeat(1024) + 'B'.repeat(1024),
        },
      ],
    });
    const first = authority.historyRead({
      client,
      terminalId: 'a',
      maxBytes: 1024,
    });
    expect(first.historyRevision).toBe(
      authority.historyRead({ client, terminalId: 'b' }).historyRevision,
    );
    expect(first.nextCursor).not.toBeNull();
    expect(first.nextCursor?.length).toBeLessThanOrEqual(64);
    const cursor = first.nextCursor ?? undefined;
    expect(
      WorkerTerminalRecordHistoryReadParamsSchema.safeParse({
        client,
        terminalId: 'a',
        cursor,
      }).success,
    ).toBe(true);
    expect(
      authority.historyRead({
        client,
        terminalId: 'a',
        occurrence: 0,
        cursor,
        maxBytes: 1024,
      }),
    ).toMatchObject({
      restarted: false,
      text: 'A'.repeat(1024),
      nextCursor: null,
    });
    expect(
      authority.historyRead({
        client,
        terminalId: 'b',
        cursor,
        maxBytes: 1024,
      }),
    ).toMatchObject({ restarted: true, text: 'b'.repeat(1024) });
  });

  it.each(['occurrence', 'worktree', 'project'])(
    'preview cursors isolate %s with identical-content sources',
    (dimension) => {
      const destination = {
        ...client,
        projectId: dimension === 'project' ? 'other' : 'proj',
        worktreeId: dimension === 'worktree' ? 'other' : 'wt',
      };
      const localTerminals = [
        {
          session: session('a'),
          scrollbackLines: ['x'.repeat(1024) + 'X'.repeat(1024)],
          exitCode: 0,
          signal: null,
        },
        {
          session: session('a'),
          scrollbackLines: ['y'.repeat(1024) + 'Y'.repeat(1024)],
          exitCode: 0,
          signal: null,
        },
      ];
      // Both files contain identical bytes, but each reader selects its scope.
      // A different source digest must not mask missing scope cursor identity.
      legacy([
        ...localTerminals,
        ...(dimension === 'occurrence'
          ? []
          : localTerminals.map((entry) => ({
              ...entry,
              session: {
                ...entry.session,
                projectId: destination.projectId,
                worktreeId: destination.worktreeId,
              },
            }))),
      ]);
      const original = legacyTerminalStatePath(
        root,
        'workspaces',
        'proj',
        'wt',
      );
      if (dimension !== 'occurrence') {
        const path = legacyTerminalStatePath(
          root,
          'workspaces',
          destination.projectId,
          destination.worktreeId,
        );
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, readFileSync(original));
      }
      const authority = make();
      const first = authority.historyRead({
        client,
        terminalId: 'a',
        maxBytes: 1024,
      });
      expect(first.nextCursor).not.toBeNull();
      expect(first.nextCursor?.length).toBeLessThanOrEqual(64);
      const cursor = first.nextCursor ?? undefined;
      expect(
        authority.historyRead({
          client,
          terminalId: 'a',
          occurrence: 0,
          cursor,
          maxBytes: 1024,
        }),
      ).toMatchObject({
        restarted: false,
        text: 'X'.repeat(1024),
        nextCursor: null,
      });
      expect(
        authority.historyRead({
          client: destination,
          terminalId: 'a',
          occurrence: dimension === 'occurrence' ? 1 : 0,
          cursor,
          maxBytes: 1024,
        }),
      ).toMatchObject({
        restarted: true,
        text: (dimension === 'occurrence' ? 'y' : 'x').repeat(1024),
      });
    },
  );

  it('installed cursors isolate imported occurrences of the same terminal', () => {
    legacy(
      ['x', 'y'].map((prefix) => ({
        session: session('a'),
        scrollbackLines: [
          prefix.repeat(1024) + prefix.toUpperCase().repeat(1024),
        ],
        exitCode: 0,
        signal: null,
      })),
    );
    const authority = make();
    authority.open(client);
    const first = authority.historyRead({
      client,
      terminalId: 'a',
      maxBytes: 1024,
    });
    expect(first.nextCursor).not.toBeNull();
    expect(first.nextCursor?.length).toBeLessThanOrEqual(64);
    expect(
      authority.historyRead({
        client,
        terminalId: 'a',
        cursor: first.nextCursor ?? undefined,
        maxBytes: 1024,
      }),
    ).toMatchObject({
      restarted: false,
      text: 'X'.repeat(1024),
      nextCursor: null,
    });
    expect(
      authority.historyRead({
        client,
        terminalId: 'a',
        occurrence: 1,
        cursor: first.nextCursor ?? undefined,
        maxBytes: 1024,
      }),
    ).toMatchObject({ restarted: true, text: 'y'.repeat(1024) });
  });
});

describe('R10 admission obligations', () => {
  it.each([undefined, 'held'])(
    'matching unversioned admission cannot rebind an explicit stale generation (%s)',
    (lifetimeId) => {
      const seed = make();
      seed.open(client);
      seed.retire({ projectId: 'proj', worktreeId: 'wt' });
      expect(seed.open(client).generation).toBe(2);
      seed.dispose();
      const authority = make();
      const restore = failReads();
      try {
        authority.attribute({
          terminalId: 't',
          client: { ...client, generation: 1, lifetimeId },
          session: session('t'),
          persist: true,
        });
        authority.output('t', Buffer.from('stale'));
      } finally {
        restore();
      }
      authority.open({ ...client, lifetimeId });
      expect(authority.isAttributed('t')).toBe(false);
      authority.output('t', Buffer.from('late'));
      authority.flushSync();
      expect(make().historyRead({ client, terminalId: 't' }).text).toBe('');
    },
  );

  it.each(['success', 'failure'])(
    'recreation finalizes the old byte stream before the %s handoff',
    (mode) => {
      make().open(client);
      const authority = make();
      const restore = failReads();
      try {
        authority.attribute({
          terminalId: 't',
          client,
          session: session('t'),
          persist: true,
        });
        authority.output('t', Uint8Array.from([0xe2, 0x82]));
        if (mode === 'success') restore();
        authority.attribute({
          terminalId: 't',
          client,
          session: session('t'),
          persist: true,
        });
      } finally {
        restore();
      }
      authority.output('t', Uint8Array.from([0xac]));
      authority.exited('t', 0, null);
      authority.open(client);
      authority.flushSync();
      expect(make().historyRead({ client, terminalId: 't' }).text).toBe(
        '\ufffd\ufffd',
      );
    },
  );

  it.each([100, 200])(
    'unknown reports wait when fence time %s does not prove predecessor order',
    (retiredAt) => {
      jest.useFakeTimers();
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      repository.retire('proj', 'wt', {
        generation: 1,
        incarnation: 'inc-1',
        retiredAt,
      });
      const authority = new TerminalRecordAuthority({
        repository,
        now: (): number => 100,
      });
      const next = { ...client, incarnation: 'inc-2' };
      const restore = failReads();
      try {
        authority.attribute({
          terminalId: 't',
          client: next,
          session: session('t'),
          persist: true,
        });
        authority.output('t', Buffer.from('held\n'));
      } finally {
        restore();
      }
      try {
        expect(
          authority.historyRead({ client: next, terminalId: 't' }).text,
        ).toBe('');
        jest.advanceTimersByTime(1_000);
        expect(authority.isAttributed('t')).toBe(false);
        expect(existsSync(recordFile())).toBe(false);
        authority.output('t', Buffer.from('still-held\n'));
        expect(authority.open(next).generation).toBe(2);
        authority.output('t', Buffer.from('later'));
        authority.flushSync();
        expect(make().historyRead({ client: next, terminalId: 't' }).text).toBe(
          'held\nstill-held\nlater',
        );
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('A matching open preserves an unknown successor prefix and later output', () => {
    const seed = make();
    seed.open(client);
    seed.dispose();
    const authority = make();
    const next = { ...client, incarnation: 'inc-2' };
    const restore = failReads();
    try {
      authority.attribute({
        terminalId: 't',
        client: next,
        session: session('t'),
        persist: true,
      });
      authority.output('t', Buffer.from('held\n'));
    } finally {
      restore();
    }
    expect(authority.open(next).generation).toBe(2);
    expect(authority.isAttributed('t')).toBe(true);
    authority.output('t', Buffer.from('later'));
    authority.flushSync();
    expect(make().historyRead({ client: next, terminalId: 't' }).text).toBe(
      'held\nlater',
    );
  });

  it.each(['success', 'retirement failure'])(
    'B replacement transfers held output after %s',
    (mode) => {
      const seed = make();
      seed.open(client);
      seed.dispose();
      const authority = make();
      const next = { ...client, incarnation: 'inc-2' };
      const restore = failReads();
      try {
        authority.attribute({
          terminalId: 't',
          client: next,
          session: session('t'),
          persist: true,
        });
        authority.output('t', Buffer.from('held\n'));
      } finally {
        restore();
      }
      const tombstone = join(
        terminalRecordDir(root, 'proj', 'wt'),
        'tombstone.json',
      );
      const rename = fs.renameSync;
      let blocked = mode === 'retirement failure';
      const renaming = jest
        .spyOn(fs, 'renameSync')
        .mockImplementation((from, to) => {
          if (blocked && String(to) === tombstone)
            throw Object.assign(new Error('retirement blocked'), {
              code: 'EIO',
            });
          rename(from, to);
        });
      try {
        authority.attribute({
          terminalId: 't',
          client: next,
          session: session('t'),
          persist: true,
        });
        blocked = false;
        expect(authority.open(next).generation).toBe(2);
        authority.output('t', Buffer.from('later'));
        authority.flushSync();
        expect(make().historyRead({ client: next, terminalId: 't' }).text).toBe(
          'held\nlater',
        );
      } finally {
        renaming.mockRestore();
      }
    },
  );

  it('C1 unavailable damaged metadata cannot synthesize a weak fence', () => {
    const directory = terminalRecordDir(root, 'proj', 'wt');
    const tombstone = join(directory, 'tombstone.json');
    mkdirSync(directory, { recursive: true });
    writeFileSync(tombstone, '{damaged');
    const authority = make();
    const batch = {
      client,
      producer: { id: 'delayed', runId: 'old' },
      seq: 1,
      generation: 4,
      ops: [{ op: 'session.upsert' as const, session: session('stale') }],
    };
    const metadata = jest.spyOn(fs, 'statSync').mockImplementation(() => {
      throw Object.assign(new Error('metadata unavailable'), { code: 'EIO' });
    });
    try {
      expect(() => authority.apply(batch)).toThrow();
      expect(() => authority.apply(batch)).toThrow();
      expect(existsSync(recordFile())).toBe(false);
    } finally {
      metadata.mockRestore();
    }
    expect(authority.apply(batch).outcome).toBe('dropped');
    expect(existsSync(recordFile())).toBe(false);
    expect(make().apply(batch).outcome).toBe('dropped');
  });

  it('C2 a valid record remains available without damaged-floor metadata', () => {
    const seed = make();
    seed.apply({
      client,
      producer: { id: 'seed', runId: 'valid' },
      seq: 1,
      ops: [
        { op: 'session.upsert', session: session('kept') },
        { op: 'output.append', terminalId: 'kept', text: 'valid history' },
      ],
    });
    seed.dispose();
    writeFileSync(
      join(terminalRecordDir(root, 'proj', 'wt'), 'tombstone.json'),
      '{damaged',
    );
    const metadata = jest.spyOn(fs, 'statSync').mockImplementation(() => {
      throw Object.assign(new Error('metadata unavailable'), { code: 'EIO' });
    });
    try {
      expect(make().historyRead({ client, terminalId: 'kept' }).text).toBe(
        'valid history',
      );
    } finally {
      metadata.mockRestore();
    }
  });
});

describe('R11 lifetime fencing', () => {
  it.each(
    ['open', 'apply client generation', 'apply batch generation'].flatMap(
      (request) =>
        [undefined, 'old'].flatMap((lifetimeId) =>
          [1, undefined, 99].map((generation) => ({
            request,
            lifetimeId,
            generation,
          })),
        ),
    ),
  )(
    'held successor replay fences an admitted predecessor $request (lifetimeId=$lifetimeId, generation=$generation)',
    ({ request, lifetimeId, generation }) => {
      const authority = make();
      const old = { ...client, generation, lifetimeId };
      authority.open(old);
      const tombstone = join(
        terminalRecordDir(root, 'proj', 'wt'),
        'tombstone.json',
      );
      const rename = fs.renameSync;
      let blocked = true;
      jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (blocked && to === tombstone) throw new Error('retire blocked');
        rename(from, to);
      });
      const successor = { ...client, incarnation: 'inc-2', lifetimeId: 'new' };
      authority.attribute({
        terminalId: 'successor',
        client: successor,
        session: session('successor'),
        persist: true,
      });
      authority.output('successor', Buffer.from('held successor history'));
      expect(authority.isAttributed('successor')).toBe(false);
      expect(record().generation).toBe(1);
      blocked = false;
      // Unversioned and future-generation retries may authorize another lifetime.
      for (
        let attempt = 0;
        attempt < (generation === 1 ? 2 : 1);
        attempt += 1
      ) {
        if (request === 'open')
          expect(authority.open(old)).toMatchObject({
            generation: generation ?? 1,
            revision: 0,
            terminals: [],
            producerWatermarks: {},
          });
        else
          expect(
            authority.apply({
              client:
                request === 'apply batch generation'
                  ? { ...old, generation: undefined }
                  : old,
              ...(request === 'apply batch generation' ? { generation } : {}),
              producer: { id: 'late', runId: 'old' },
              seq: 1,
              ops: [
                { op: 'session.upsert', session: session('contamination') },
                { op: 'output.append', terminalId: 'successor', text: 'stale' },
              ],
            }),
          ).toMatchObject({ outcome: 'dropped', generation: 2 });
      }
      authority.flushSync();
      const reloaded = make();
      const opened = reloaded.open(successor);
      expect(opened.generation).toBe(2);
      expect(opened.terminals.map((entry) => entry.session.id)).toEqual([
        'successor',
      ]);
      expect(opened.producerWatermarks).toEqual({});
      expect(
        reloaded.historyRead({ client: successor, terminalId: 'successor' })
          .text,
      ).toBe('held successor history');
    },
  );

  it.each(
    ['loaded', 'reloaded'].flatMap((mode) =>
      [
        'unqualified',
        'matching incarnation',
        'unknown predecessor incarnation',
        'successor incarnation',
        'other incarnation',
        'future generation',
        'empty lifetime ids',
      ].map((qualifier) => ({ mode, qualifier })),
    ),
  )(
    'generation-only cleanup retry preserves a $mode successor ($qualifier)',
    ({ mode, qualifier }) => {
      const authority = make();
      authority.open({
        ...client,
        incarnation:
          qualifier === 'unknown predecessor incarnation'
            ? null
            : client.incarnation,
      });
      const directory = terminalRecordDir(root, 'proj', 'wt');
      const backup = join(directory, 'import-source.json');
      writeFileSync(backup, 'predecessor history');
      const remove = fs.rmSync;
      const blocked = jest
        .spyOn(fs, 'rmSync')
        .mockImplementation((path, options) => {
          if (path === backup) throw new Error('cleanup blocked');
          remove(path, options);
        });
      const intent = { projectId: 'proj', worktreeId: 'wt', generation: 1 };
      expect(() => authority.retire(intent)).toThrow('cleanup blocked');
      const successor = { ...client, incarnation: 'inc-2' };
      authority.apply({
        client: successor,
        producer: { id: 'current', runId: 'new' },
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('new') },
          { op: 'output.append', terminalId: 'new', text: 'successor history' },
        ],
      });
      const successorBytes = readFileSync(recordFile(), 'utf8');
      const retrying = mode === 'loaded' ? authority : make();
      const eligible =
        qualifier === 'unqualified' ||
        qualifier === 'matching incarnation' ||
        qualifier === 'unknown predecessor incarnation';
      const params = {
        ...intent,
        ...(qualifier === 'matching incarnation' ||
        qualifier === 'unknown predecessor incarnation'
          ? { incarnation: 'inc-1' }
          : {}),
        ...(qualifier === 'other incarnation' ? { incarnation: 'inc-3' } : {}),
        ...(qualifier === 'successor incarnation'
          ? { incarnation: 'inc-2' }
          : {}),
        ...(qualifier === 'future generation'
          ? { generation: 2, incarnation: 'inc-1' }
          : {}),
        ...(qualifier === 'empty lifetime ids' ? { lifetimeIds: [] } : {}),
      };
      if (eligible)
        expect(() => retrying.retire(params)).toThrow('cleanup blocked');
      else expect(retrying.retire(params)).toEqual({ retired: 0 });
      expect(readFileSync(backup, 'utf8')).toBe('predecessor history');
      blocked.mockRestore();
      const newRecovery = join(directory, '.record.json.successor.tmp');
      writeFileSync(newRecovery, successorBytes);
      // A preserved successor counts no fence, even while its cleanup runs.
      expect(retrying.retire(params)).toEqual({ retired: 0 });
      expect(existsSync(backup)).toBe(!eligible);
      expect(readFileSync(newRecovery, 'utf8')).toBe(successorBytes);
      expect(readFileSync(recordFile(), 'utf8')).toBe(successorBytes);
      expect(retrying.retire(params)).toEqual({ retired: 0 });
      expect(
        make().historyRead({ client: successor, terminalId: 'new' }).text,
      ).toBe('successor history');
    },
  );
});

it.each(['loaded', 'reloaded'])(
  'retirement retries clean old artifacts without deleting a %s successor',
  (mode) => {
    const authority = make();
    const retiring = { ...client, lifetimeId: 'retiring' };
    authority.apply({
      client: retiring,
      producer: { id: 'electron_main', runId: 'old' },
      seq: 1,
      ops: [{ op: 'session.upsert', session: session('old') }],
    });
    const directory = terminalRecordDir(root, 'proj', 'wt');
    const backup = join(directory, 'import-source.json');
    const recovery = join(directory, '.record.json.interrupted.tmp');
    writeFileSync(backup, 'old backup');
    writeFileSync(recovery, 'old recovery');
    const remove = fs.rmSync;
    const blocked = jest
      .spyOn(fs, 'rmSync')
      .mockImplementation((path, options) => {
        if (path === backup)
          throw Object.assign(new Error('cleanup blocked'), { code: 'EBUSY' });
        remove(path, options);
      });
    const intent = {
      projectId: 'proj',
      worktreeId: 'wt',
      lifetimeIds: ['retiring'],
    };
    expect(() => authority.retire(intent)).toThrow('cleanup blocked');
    expect(existsSync(join(directory, 'tombstone.json'))).toBe(true);
    const successor = { ...client, lifetimeId: 'successor' };
    authority.apply({
      client: successor,
      producer: { id: 'electron_main', runId: 'new' },
      seq: 1,
      ops: [
        { op: 'session.upsert', session: session('new') },
        { op: 'output.append', terminalId: 'new', text: 'successor output' },
      ],
    });
    const retrying = mode === 'loaded' ? authority : make();
    // No successful acknowledgement while deletion still fails.
    expect(() => retrying.retire(intent)).toThrow('cleanup blocked');
    blocked.mockRestore();
    // A successor's own recovery copy must not join the old cleanup set.
    const newRecovery = join(directory, '.record.json.successor.tmp');
    writeFileSync(newRecovery, readFileSync(recordFile()));
    expect(retrying.retire(intent)).toEqual({ retired: 1 });
    expect(readdirSync(directory).sort()).toEqual([
      '.record.json.successor.tmp',
      'record.json',
      'tombstone.json',
    ]);
    expect(
      make().historyRead({ client: successor, terminalId: 'new' }).text,
    ).toBe('successor output');
  },
);

it.each(['snapshot', 'legacy', 'damaged'])(
  'retirement preserves recreated successor artifacts with a %s tombstone',
  (mode) => {
    const authority = make();
    const producer = { id: 'producer', runId: 'retire' };
    authority.apply({
      client: { ...client, lifetimeId: 'old' },
      producer,
      seq: 1,
      ops: [{ op: 'session.upsert', session: session('old') }],
    });
    const directory = terminalRecordDir(root, 'proj', 'wt');
    const backup = join(directory, 'import-source.json');
    const recovery = join(directory, 'record.json.damaged-reused');
    writeFileSync(backup, 'old backup');
    writeFileSync(recovery, 'old recovery');
    const remove = fs.rmSync;
    const blocked = jest
      .spyOn(fs, 'rmSync')
      .mockImplementation((path, options) => {
        if (path === backup) throw new Error('cleanup blocked');
        remove(path, options);
      });
    const intent = {
      projectId: 'proj',
      worktreeId: 'wt',
      lifetimeIds: ['old'],
    };
    expect(() => authority.retire(intent)).toThrow('cleanup blocked');
    blocked.mockRestore();
    const successor = { ...client, lifetimeId: 'successor' };
    authority.apply({
      client: successor,
      producer,
      seq: 1,
      ops: [
        { op: 'session.upsert', session: session('successor') },
        { op: 'output.append', terminalId: 'successor', text: 'new history' },
      ],
    });
    const tombstonePath = join(directory, 'tombstone.json');
    if (mode === 'legacy') {
      const tombstone: unknown = JSON.parse(
        readFileSync(tombstonePath, 'utf8'),
      );
      if (typeof tombstone !== 'object' || tombstone === null)
        throw new Error('Expected a tombstone');
      if ('cleanupFiles' in tombstone) delete tombstone.cleanupFiles;
      writeFileSync(tombstonePath, JSON.stringify(tombstone));
    } else if (mode === 'damaged') writeFileSync(tombstonePath, '{');
    writeFileSync(backup + '.next', 'successor backup');
    fs.renameSync(backup + '.next', backup);
    writeFileSync(recovery, readFileSync(recordFile()));
    expect(make().retire(intent)).toEqual({ retired: 1 });
    expect(readFileSync(backup, 'utf8')).toBe('successor backup');
    expect(readFileSync(recovery, 'utf8')).toContain('new history');
    expect(
      make().historyRead({ client: successor, terminalId: 'successor' }).text,
    ).toBe('new history');
  },
);

it.each(['binding', 'member'])(
  'rejects duplicate layout %s keys without acknowledging or damaging the record',
  (kind) => {
    const authority = make();
    const producer = { id: 'electron_main', runId: 'layout' };
    authority.apply({
      client,
      producer,
      seq: 1,
      ops: [
        { op: 'session.upsert', session: session('kept') },
        { op: 'output.append', terminalId: 'kept', text: 'kept output' },
      ],
    });
    const before = readFileSync(recordFile(), 'utf8');
    const page = authority.historyRead({ client, terminalId: 'kept' });
    const binding = {
      key: 'group',
      groupId: 'group',
      members: [{ key: 'pane', terminalId: 'kept' }],
    };
    expect(() =>
      authority.apply({
        client: { ...client, lifetimeId: 'rejected-lifetime' },
        producer,
        seq: 2,
        ops: [
          { op: 'output.replace', terminalId: 'kept', lines: ['discarded'] },
          {
            op: 'layout.save',
            servedIds: ['kept'],
            referencedIds: ['kept'],
            bindings:
              kind === 'binding'
                ? [binding, binding]
                : [
                    {
                      ...binding,
                      members: [...binding.members, ...binding.members],
                    },
                  ],
            terminalCustomNames: {},
          },
        ],
      }),
    ).toThrow('duplicate');
    expect(authority.historyRead({ client, terminalId: 'kept' })).toEqual(page);
    authority.flushSync();
    expect(readFileSync(recordFile(), 'utf8')).toBe(before);
    expect(authority.open(client).producerWatermarks).toEqual({
      'electron_main/layout': 1,
    });
    expect(make().historyRead({ client, terminalId: 'kept' }).text).toBe(
      'kept output',
    );
    expect(authority.apply({ client, producer, seq: 2, ops: [] }).outcome).toBe(
      'applied',
    );
  },
);

it.each([
  [511, 512],
  [512, 511],
  [512, 512],
])(
  'bounds encoded producer watermark keys for %i/%i character components',
  (idLength, runLength) => {
    const authority = make();
    authority.open(client);
    const before = readFileSync(recordFile(), 'utf8');
    const producer = { id: 'p'.repeat(idLength), runId: 'r'.repeat(runLength) };
    const batch = WorkerTerminalRecordApplyParamsSchema.parse({
      client,
      producer,
      seq: 1,
      ops: [{ op: 'session.upsert', session: session('boundary') }],
    });
    if (idLength + runLength + 1 > 1024) {
      expect(() => authority.apply(batch)).toThrow('watermark');
      expect(readFileSync(recordFile(), 'utf8')).toBe(before);
      expect(make().open(client).producerWatermarks).toEqual({});
      return;
    }
    expect(authority.apply(batch).outcome).toBe('applied');
    const restarted = make();
    const opened = WorkerTerminalRecordOpenResultSchema.parse(
      restarted.open(client),
    );
    expect(
      opened.producerWatermarks?.[`${producer.id}/${producer.runId}`],
    ).toBe(1);
    expect(
      WorkerTerminalRecordHistoryReadResultSchema.safeParse(
        restarted.historyRead({ client, terminalId: 'boundary' }),
      ).success,
    ).toBe(true);
  },
);

it('history cursors continue one snapshot and restart across reloads and lifetimes', () => {
  const producer = { id: 'producer', runId: 'pages' };
  const firstAuthority = make();
  firstAuthority.apply({
    client: { ...client, lifetimeId: 'old' },
    producer,
    seq: 1,
    ops: [
      { op: 'session.upsert', session: session('paged') },
      { op: 'output.replace', terminalId: 'paged', lines: ['a'.repeat(3000)] },
    ],
  });
  const reader = make();
  const first = reader.historyRead({
    client,
    terminalId: 'paged',
    maxBytes: 1024,
  });
  const continuation = {
    client,
    terminalId: 'paged',
    maxBytes: 1024,
    cursor: first.nextCursor ?? undefined,
    historyRevision: first.historyRevision,
  };
  expect(reader.historyRead(continuation).restarted).toBe(false);
  const epoch = first.nextCursor?.split(':')[0];
  for (const cursor of [
    '1024',
    `${epoch}:nope`,
    `${epoch}:1024:extra`,
    `${epoch}:-1`,
    `${epoch}:99999`,
  ])
    expect(reader.historyRead({ ...continuation, cursor })).toMatchObject({
      restarted: true,
      text: 'a'.repeat(1024),
    });
  const reloaded = make();
  expect(reloaded.historyRead(continuation).restarted).toBe(true);
  reloaded.apply({
    client,
    producer,
    seq: 2,
    ops: [
      { op: 'output.replace', terminalId: 'paged', lines: ['b'.repeat(3000)] },
    ],
  });
  expect(make().historyRead(continuation)).toMatchObject({
    restarted: true,
    text: 'b'.repeat(1024),
  });
  const beforeRetire = reloaded.historyRead({
    client,
    terminalId: 'paged',
    maxBytes: 1024,
  });
  reloaded.retire({
    projectId: 'proj',
    worktreeId: 'wt',
    lifetimeIds: ['old'],
  });
  const successor = { ...client, lifetimeId: 'new' };
  reloaded.apply({
    client: successor,
    producer,
    seq: 1,
    ops: [
      { op: 'session.upsert', session: session('paged') },
      { op: 'output.replace', terminalId: 'paged', lines: ['c'.repeat(3000)] },
    ],
  });
  expect(
    reloaded.historyRead({
      ...continuation,
      client: successor,
      cursor: beforeRetire.nextCursor ?? undefined,
      historyRevision: undefined,
    }),
  ).toMatchObject({ restarted: true, text: 'c'.repeat(1024) });
});

it('failed apply installs do not invalidate the acknowledged history snapshot', () => {
  const authority = make();
  const producer = { id: 'producer', runId: 'install' };
  authority.apply({
    client,
    producer,
    seq: 1,
    ops: [
      { op: 'session.upsert', session: session('paged') },
      { op: 'output.replace', terminalId: 'paged', lines: ['a'.repeat(3000)] },
    ],
  });
  const page = authority.historyRead({
    client,
    terminalId: 'paged',
    maxBytes: 1024,
  });
  const before = readFileSync(recordFile(), 'utf8');
  const saving = jest
    .spyOn(TerminalRecordRepository.prototype, 'save')
    .mockImplementationOnce(() => {
      throw new Error('install blocked');
    });
  const batch = {
    client,
    producer,
    seq: 2,
    ops: [
      {
        op: 'output.replace' as const,
        terminalId: 'paged',
        lines: ['b'.repeat(3000)],
      },
    ],
  };
  expect(() => authority.apply(batch)).toThrow('could not be installed');
  saving.mockRestore();
  expect(readFileSync(recordFile(), 'utf8')).toBe(before);
  const continuation = {
    client,
    terminalId: 'paged',
    maxBytes: 1024,
    cursor: page.nextCursor ?? undefined,
    historyRevision: page.historyRevision,
  };
  expect(authority.historyRead(continuation)).toMatchObject({
    restarted: false,
    text: 'a'.repeat(1024),
    historyRevision: page.historyRevision,
  });
  expect(authority.apply(batch).outcome).toBe('applied');
  expect(authority.historyRead(continuation)).toMatchObject({
    restarted: true,
    text: 'b'.repeat(1024),
  });
});

it('R11 import retries ancestor durability before acknowledging an import', () => {
  const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
  mkdirSync(join(legacy, '..'), { recursive: true });
  writeFileSync(
    legacy,
    JSON.stringify({
      version: 2,
      lineage: 'L',
      bindings: [],
      terminals: [],
      terminalCustomNames: {},
    }),
  );
  let blocked = true;
  const flushed: string[] = [];
  const authority = new TerminalRecordAuthority({
    repository: new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (directory): void => {
        flushed.push(directory);
        if (blocked && directory === root)
          throw new Error('parent sync failed');
      },
    }),
  });
  expect(authority.open(client).import.pending).toBe(true);
  blocked = false;
  const imported = authority.open(client).import;
  expect(imported.from).toBe('v2');
  expect(typeof imported.sourceSha256).toBe('string');
  expect(
    flushed.filter((directory) => directory === root).length,
  ).toBeGreaterThan(1);
  expect(make().open(client).import.from).toBe('v2');
});

it('R11 normalizes legacy names in the durable envelope, not just its open response', () => {
  const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
  mkdirSync(join(legacy, '..'), { recursive: true });
  writeFileSync(
    legacy,
    JSON.stringify({
      version: 2,
      lineage: 'L',
      bindings: [],
      terminals: [
        {
          session: session('legacy'),
          scrollbackLines: ['kept'],
          exitCode: 0,
          signal: null,
        },
      ],
      terminalCustomNames: { legacy: 'Name', bad: 42, alsoBad: null },
    }),
  );
  expect(make().open(client).terminalCustomNames).toEqual({ legacy: 'Name' });
  expect(record().record.terminalCustomNames).toEqual({ legacy: 'Name' });
  rmSync(legacy);
  const restarted = make();
  expect(restarted.open(client).terminalCustomNames).toEqual({
    legacy: 'Name',
  });
  expect(
    restarted.open(client).terminals.map((entry) => entry.session.id),
  ).toEqual(['legacy']);
  expect(restarted.historyRead({ client, terminalId: 'legacy' }).text).toBe(
    'kept',
  );
});

it('R11 retirement identity covers a delayed first write, including writes after restart', () => {
  const authority = make();
  const retiring = { ...client, incarnation: null, lifetimeId: 'retiring' };
  const requestedAt = Date.now() - 10_000;
  authority.attribute({
    terminalId: 'late',
    client: retiring,
    session: session('late'),
    persist: true,
  });
  authority.output('late', Buffer.from('private'));
  expect(
    authority.retire({
      projectId: 'proj',
      worktreeId: 'wt',
      lifetimeIds: ['retiring'],
      requestedAt,
    }).retired,
  ).toBe(1);
  expect(existsSync(recordFile())).toBe(false);
  const restarted = make();
  expect(
    restarted.apply({
      client: retiring,
      producer: { id: 'electron_main', runId: 'late' },
      seq: 1,
      ops: [{ op: 'session.upsert', session: session('late') }],
    }).outcome,
  ).toBe('dropped');
  const successor = { ...retiring, lifetimeId: 'successor' };
  const successorGeneration = restarted.open(successor).generation;
  expect(
    restarted.retire({
      projectId: 'proj',
      worktreeId: 'wt',
      lifetimeIds: ['retiring'],
      requestedAt: Date.now() + 10_000,
    }).retired,
  ).toBe(1);
  expect(
    restarted.apply({
      client: retiring,
      producer: { id: 'electron_main', runId: 'later' },
      seq: 1,
      ops: [{ op: 'session.upsert', session: session('late') }],
    }).outcome,
  ).toBe('dropped');
  expect(restarted.open(successor).terminals).toEqual([]);
  expect(restarted.open(successor).generation).toBe(successorGeneration);
});

it.each(['worktree', 'project'])(
  'R11 %s retirement fences a lifetime before its first admission',
  (kind) => {
    const authority = make();
    expect(
      authority.retire({
        projectId: 'proj',
        ...(kind === 'worktree'
          ? { worktreeId: 'wt' }
          : { worktreeIds: ['wt'] }),
        lifetimeIds: ['not-yet-admitted'],
      }).retired,
    ).toBe(1);
    const late = { ...client, lifetimeId: 'not-yet-admitted' };
    expect(
      make().apply({
        client: late,
        producer: { id: 'electron_main', runId: 'late' },
        seq: 1,
        ops: [{ op: 'session.upsert', session: session('late') }],
      }).outcome,
    ).toBe('dropped');
  },
);

it.each(['retired generation', 'other scope'])(
  'R11 layout rejoin rejects a live terminal from %s',
  (kind) => {
    const authority = make();
    authority.attribute({
      terminalId: 'old',
      client,
      session: session('old'),
      persist: true,
    });
    let destination = client;
    if (kind === 'retired generation')
      authority.retire({ projectId: 'proj', worktreeId: 'wt' });
    else destination = { ...client, worktreeId: 'elsewhere' };
    authority.apply({
      client: destination,
      producer: { id: 'electron_main', runId: 'layout' },
      seq: 1,
      ops: [
        {
          op: 'layout.save',
          servedIds: [],
          referencedIds: ['old'],
          bindings: [],
          terminalCustomNames: {},
        },
      ],
    });
    expect(authority.open(destination).terminals).toEqual([]);
  },
);

describe('R12 acknowledgement boundaries', () => {
  it.each([false, true])(
    'shutdown waits for the fence that released held reports (exited=%s)',
    (exited) => {
      make().open(client);
      let blocked = false;
      const authority = new TerminalRecordAuthority({
        repository: new TerminalRecordRepository({
          dataRoot: root,
          flushDirectorySync: (path): void => {
            if (blocked && path === terminalRecordDir(root, 'proj', 'wt'))
              throw new Error('retirement sync blocked');
          },
        }),
      });
      const release = failReads();
      authority.attribute({
        terminalId: 'retiring-held',
        client: { ...client, generation: 1 },
        session: session('retiring-held'),
        persist: true,
      });
      authority.output('retiring-held', Buffer.from('held output'));
      if (exited) authority.exited('retiring-held', 7, 'SIGTERM');
      release();
      blocked = true;
      expect(() =>
        authority.retire({
          projectId: 'proj',
          worktreeId: 'wt',
          generation: 1,
        }),
      ).toThrow('outcome unknown');
      expect(authority.isAttributed('retiring-held')).toBe(false);
      expect(record().record.terminals).toEqual([]);
      const retiredRecord = readFileSync(recordFile(), 'utf8');
      expect(() => authority.shutdown('app-quit')).toThrow(
        'retirement sync blocked',
      );
      blocked = false;
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      expect(readFileSync(recordFile(), 'utf8')).toBe(retiredRecord);
      blocked = true;
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      authority.dispose();
      expect(
        make().historyRead({ client, terminalId: 'retiring-held' }).text,
      ).toBe('');
    },
  );

  it.each([
    'known predecessor',
    'successor unreadable',
    'confirmation blocked',
    'unknown fence',
    'different fence',
    'equal capture time',
    'recurring incarnation after retirement',
    'malformed retirement time',
    'missing retirement time',
  ])(
    'exited unknown-generation reports require positive supersession evidence: %s',
    (evidence) => {
      make().open(client);
      let blocked = false;
      const authority = new TerminalRecordAuthority({
        now: (): number => 100,
        repository: new TerminalRecordRepository({
          dataRoot: root,
          flushDirectorySync: (): void => {
            if (blocked) throw new Error('supersession sync blocked');
          },
        }),
      });
      const release = failReads();
      authority.attribute({
        terminalId: 'predecessor',
        client,
        session: session('predecessor'),
        persist: true,
      });
      authority.output('predecessor', Buffer.from('predecessor output'));
      authority.exited('predecessor', 5, null);
      release();
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      repository.retire('proj', 'wt', {
        generation: 1,
        incarnation:
          evidence === 'unknown fence'
            ? null
            : evidence === 'different fence'
              ? 'other-incarnation'
              : client.incarnation,
        retiredAt:
          evidence === 'equal capture time'
            ? 100
            : evidence === 'recurring incarnation after retirement'
              ? 50
              : 200,
      });
      repository.save(
        repository.empty(
          { ...client, incarnation: 'inc-2', generation: 2 },
          'none',
        ),
      );
      if (
        evidence === 'malformed retirement time' ||
        evidence === 'missing retirement time'
      )
        writeFileSync(
          join(terminalRecordDir(root, 'proj', 'wt'), 'tombstone.json'),
          JSON.stringify({
            generation: 1,
            incarnation: client.incarnation,
            ...(evidence === 'malformed retirement time'
              ? { retiredAt: '200' }
              : {}),
            cleanupFiles: [],
          }),
        );
      const before = readFileSync(recordFile(), 'utf8');
      blocked = evidence === 'confirmation blocked';
      const restore =
        evidence === 'successor unreadable'
          ? failReads()
          : (): void => undefined;
      try {
        if (evidence === 'known predecessor')
          expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
        else
          expect(() => authority.shutdown('app-quit')).toThrow(
            'unresolved attributions',
          );
      } finally {
        restore();
        blocked = false;
      }
      if (
        evidence === 'successor unreadable' ||
        evidence === 'confirmation blocked'
      )
        expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      expect(readFileSync(recordFile(), 'utf8')).toBe(before);
      expect(authority.isAttributed('predecessor')).toBe(false);
    },
  );

  it.each([true, false])(
    'shutdown waits for exited held history only when persist is %s',
    (persist) => {
      const authority = make();
      const release = failReads();
      authority.attribute({
        terminalId: 'exited-held',
        client,
        session: session('exited-held'),
        persist,
      });
      authority.output('exited-held', Buffer.from('held output'));
      authority.exited('exited-held', 7, 'SIGTERM');
      try {
        if (persist)
          expect(() => authority.shutdown('app-quit')).toThrow(
            'unresolved attributions',
          );
        else expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
        expect(existsSync(recordFile())).toBe(false);
      } finally {
        release();
      }
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      authority.dispose();
      const restarted = make();
      expect(
        restarted.historyRead({ client, terminalId: 'exited-held' }).text,
      ).toBe(persist ? 'held output' : '');
      if (persist)
        expect(restarted.open(client).terminals[0]).toMatchObject({
          exitCode: 7,
          signal: 'SIGTERM',
        });
    },
  );

  it.each(['before rename', 'after rename'])(
    'damaged import remains pending when its recovery copy fails %s',
    (stage) => {
      const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
      mkdirSync(dirname(legacy), { recursive: true });
      const bytes = '{damaged legacy';
      writeFileSync(legacy, bytes);
      let blocked = true;
      let damagedCopy = false;
      const rename = fs.renameSync;
      jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        damagedCopy = basename(String(to)).startsWith(
          'legacy-terminal-state.json.damaged-',
        );
        if (blocked && damagedCopy && stage === 'before rename')
          throw new Error('damaged copy rename blocked');
        rename(from, to);
      });
      const directory = terminalRecordDir(root, 'proj', 'wt');
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (path): void => {
          if (
            blocked &&
            damagedCopy &&
            stage === 'after rename' &&
            path === directory
          )
            throw new Error('damaged copy sync blocked');
        },
      });
      let authority = new TerminalRecordAuthority({ repository });
      expect(authority.open(client).import.pending).toBe(true);
      expect(record().import.pending).toBe(true);
      authority.dispose();
      authority = new TerminalRecordAuthority({ repository });
      expect(authority.open(client).import.pending).toBe(true);
      expect(readFileSync(legacy, 'utf8')).toBe(bytes);
      blocked = false;
      expect(authority.open(client).import).toMatchObject({ from: 'damaged' });
      expect(authority.open(client).import.pending).toBeUndefined();
      const copies = readdirSync(directory).filter((name) =>
        name.startsWith('legacy-terminal-state.json.damaged-'),
      );
      expect(copies.length).toBeGreaterThan(0);
      for (const copy of copies)
        expect(JSON.parse(readFileSync(join(directory, copy), 'utf8'))).toEqual(
          {
            bytes: Buffer.from(bytes).toString('base64'),
          },
        );
      authority.dispose();
      expect(make().open(client).import.pending).toBeUndefined();
    },
  );

  it('history cursors bind the revision even without an explicit historyRevision', () => {
    const authority = make();
    const producer = { id: 'pages', runId: 'r12' };
    authority.apply({
      client,
      producer,
      seq: 1,
      ops: [
        { op: 'session.upsert', session: session('paged') },
        {
          op: 'output.replace',
          terminalId: 'paged',
          lines: ['a'.repeat(3000)],
        },
      ],
    });
    const first = authority.historyRead({
      client,
      terminalId: 'paged',
      maxBytes: 1024,
    });
    const continuation = WorkerTerminalRecordHistoryReadParamsSchema.parse({
      client,
      terminalId: 'paged',
      maxBytes: 1024,
      cursor: first.nextCursor ?? undefined,
    });
    expect(authority.historyRead(continuation)).toMatchObject({
      restarted: false,
      text: 'a'.repeat(1024),
    });
    authority.apply({
      client,
      producer,
      seq: 2,
      ops: [
        {
          op: 'output.replace',
          terminalId: 'paged',
          lines: [`${'b'.repeat(1023)}😀Z`],
        },
      ],
    });
    const current = authority.historyRead({
      client,
      terminalId: 'paged',
      maxBytes: 1024,
    });
    expect(current.text).toMatch(/^b+$/);
    expect(current.text.length).toBeLessThanOrEqual(1023);
    for (const historyRevision of [undefined, first.historyRevision])
      expect(
        authority.historyRead({ ...continuation, historyRevision }),
      ).toMatchObject({
        restarted: true,
        text: current.text,
      });
    const epoch = current.nextCursor?.split(':')[0];
    expect(
      authority.historyRead({
        ...continuation,
        cursor: `${epoch}:1024`,
        historyRevision: current.historyRevision,
      }),
    ).toMatchObject({
      restarted: true,
      text: current.text,
    });
    expect(
      authority.historyRead({
        ...continuation,
        cursor: current.nextCursor ?? undefined,
      }),
    ).toMatchObject({
      restarted: false,
      text: `${'b'.repeat(1023)}😀Z`.slice(current.text.length),
      nextCursor: null,
    });
    expect(
      authority.historyRead({ ...continuation, cursor: `${epoch}:0` })
        .restarted,
    ).toBe(false);
    expect(
      authority.historyRead({ ...continuation, cursor: `${epoch}:1026` }),
    ).toMatchObject({ restarted: false, text: '', nextCursor: null });
    authority.apply({
      client,
      producer,
      seq: 3,
      ops: [
        {
          op: 'output.replace',
          terminalId: 'paged',
          lines: ['c'.repeat(3000)],
        },
      ],
    });
    expect(
      authority.historyRead({
        ...continuation,
        cursor: current.nextCursor ?? undefined,
      }),
    ).toMatchObject({ restarted: true, text: 'c'.repeat(1024) });
    authority.apply({
      client,
      producer,
      seq: 4,
      ops: [{ op: 'output.replace', terminalId: 'paged', lines: [] }],
    });
    expect(authority.historyRead(continuation)).toMatchObject({
      restarted: true,
      text: '',
      nextCursor: null,
    });
  });
});

it('R11 shutdown of held attribution keeps recording until the actual PTY exit', () => {
  make().open(client);
  const authority = make();
  const release = failReads('EACCES');
  authority.attribute({
    terminalId: 'quitting',
    client,
    session: session('quitting'),
    persist: true,
  });
  authority.output('quitting', Buffer.from('before\n'));
  expect(() => authority.shutdown('app-quit')).toThrow(
    'unresolved attributions',
  );
  release();
  authority.open(client);
  expect(authority.isAttributed('quitting')).toBe(true);
  authority.output('quitting', Buffer.from('after\n'));
  authority.exited('quitting', 9, null);
  authority.flushSync();
  expect(authority.historyRead({ client, terminalId: 'quitting' }).text).toBe(
    'before\nafter\n',
  );
  expect(record().record.terminals[0]).toMatchObject({
    exitCode: null,
    signal: 'app-quit',
  });
  expect(authority.isAttributed('quitting')).toBe(false);
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trec-'));
});
afterEach(() => {
  for (const authority of authorities) authority.dispose();
  authorities.clear();
  jest.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it('syncs imported backups, record payloads and retirement tombstones before acknowledging', () => {
  const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
  mkdirSync(join(legacy, '..'), { recursive: true });
  writeFileSync(
    legacy,
    JSON.stringify({
      version: 2,
      lineage: 'durable',
      bindings: [],
      terminals: [],
      terminalCustomNames: {},
    }),
  );
  const order: string[] = [];
  const parents: string[] = [];
  const sync = fs.fsyncSync;
  jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    sync(fd);
    order.push('file');
  });
  const repository = new TerminalRecordRepository({
    dataRoot: root,
    flushDirectorySync: (directory): void => {
      if (directory === terminalRecordDir(root, 'proj', 'wt'))
        order.push('directory');
      else parents.push(directory);
    },
  });
  const envelope = repository.importLegacy({
    ...client,
    layout: 'workspaces',
    generation: 1,
  });
  expect(order).toEqual(['file', 'directory']);
  expect(parents).toEqual([
    join(root, 'terminal-records', 'proj'),
    join(root, 'terminal-records'),
    root,
    dirname(root),
  ]);
  repository.save(envelope);
  expect(order).toEqual(['file', 'directory', 'file', 'directory']);
  repository.retire('proj', 'wt', {
    generation: 1,
    incarnation: 'inc-1',
    retiredAt: 1,
  });
  expect(order).toEqual([
    'file',
    'directory',
    'file',
    'directory',
    'file',
    'directory',
    // Retirement syncs content deletion after installing the tombstone.
    'directory',
  ]);
});

it.each([1, 2])(
  'R8 F2 preserves oversized v%s legacy history through import and restart',
  (version) => {
    const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
    mkdirSync(dirname(legacy), { recursive: true });
    const text = `leading bytes:${'x'.repeat(1024 * 1024)}:end`;
    writeFileSync(
      legacy,
      JSON.stringify({
        ...createEmptyState(),
        version,
        lineage: 'legacy',
        bindings: [],
        terminals: [
          {
            session: session('old'),
            scrollbackLines: [text],
            exitCode: 0,
            signal: null,
          },
        ],
      }),
    );
    const authority = make();
    expect(authority.open(client).import.from).toBe(`v${version}`);
    expect(record().record.terminals[0].scrollbackLines).toEqual([text]);
    rmSync(legacy);
    for (const reader of [authority, make()]) {
      expect(
        reader.historyRead({
          client,
          terminalId: 'old',
          maxBytes: 2 * 1024 * 1024,
        }).text,
      ).toBe(text);
    }
    // New output, unlike importing existing history, uses byte retention.
    authority.apply({
      client,
      producer: { id: 'electron_main', runId: 'after-import' },
      seq: 1,
      ops: [{ op: 'output.append', terminalId: 'old', text: '!' }],
    });
    const retained = record().record.terminals[0].scrollbackLines[0];
    expect(Buffer.byteLength(retained)).toBe(1024 * 1024);
    expect(retained.endsWith(':end!')).toBe(true);
  },
);

it('R8 F2 retains the legacy v1 line-count ceiling during import', () => {
  const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
  mkdirSync(dirname(legacy), { recursive: true });
  const lines = Array.from({ length: 5001 }, (_, index) => String(index));
  writeFileSync(
    legacy,
    JSON.stringify({
      ...createEmptyState(),
      terminals: [
        {
          session: session('old'),
          scrollbackLines: lines,
          exitCode: null,
          signal: null,
        },
      ],
    }),
  );
  expect(make().open(client).import.from).toBe('v1');
  expect(record().record.terminals[0].scrollbackLines).toEqual(lines.slice(1));
});

it('R8 F1 retirement releases retained history but keeps its lifetime fence', () => {
  const authority = make();
  const retiring = { ...client, lifetimeId: 'retiring' };
  authority.attribute({
    terminalId: 't',
    client: retiring,
    session: session('t'),
    persist: true,
  });
  authority.output('t', Buffer.from('x'.repeat(1024 * 1024)));
  authority.flushSync();
  expect(authority.shutdown('app-quit')).toEqual({ stamped: 1 });
  expect(authority.isAttributed('t')).toBe(true);
  expect(
    authority.historyRead({ client: retiring, terminalId: 't' }).text,
  ).toBe('x'.repeat(1024 * 1024));
  expect(
    authority.retire({
      projectId: 'proj',
      worktreeId: 'wt',
      lifetimeIds: ['retiring'],
    }),
  ).toEqual({ retired: 1 });
  expect(
    authority.historyRead({ client: retiring, terminalId: 't' }).text,
  ).toBe('');
  expect(authority.open(retiring).terminals).toEqual([]);
  authority.output('t', Buffer.from('late'));
  authority.flushSync();
  expect(existsSync(recordFile())).toBe(false);
});

it('imports v2 legacy history on the first write-authorized touch and keeps a backup', () => {
  const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
  mkdirSync(join(legacy, '..'), { recursive: true });
  writeFileSync(
    legacy,
    JSON.stringify({
      version: 2,
      lineage: 'L',
      bindings: [
        { key: 'b', groupId: 'g', members: [{ key: 'm', terminalId: 'old' }] },
      ],
      terminals: [
        {
          session: session('old'),
          scrollbackLines: ['hello'],
          exitCode: 0,
          signal: null,
        },
      ],
      terminalCustomNames: {},
    }),
  );
  const authority = make();
  // A daemon terminal created before any open.
  authority.attribute({
    terminalId: 'new',
    client,
    session: session('new'),
    persist: true,
  });
  const opened = authority.open(client);
  expect(opened.lineage).toBe('L');
  expect(opened.import.from).toBe('v2');
  expect(opened.terminals.map((t) => t.session.id).sort()).toEqual([
    'new',
    'old',
  ]);
  expect(
    existsSync(
      join(terminalRecordDir(root, 'proj', 'wt'), 'import-source.json'),
    ),
  ).toBe(true);
  // main's file is untouched
  const untouched: unknown = JSON.parse(readFileSync(legacy, 'utf8'));
  expect(untouched).toMatchObject({ version: 2 });
});

it.each([
  ['historyRead', 'workspaces'],
  ['historyTail', 'workspaces'],
  ['historyRead', 'app-workspaces'],
  ['historyTail', 'app-workspaces'],
] as const)(
  '%s before open never imports from the wrong legacy layout (%s)',
  (read, layout) => {
    const correct = { ...client, legacyLayout: layout };
    const legacy = legacyTerminalStatePath(root, layout, 'proj', 'wt');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 2,
        lineage: 'legacy',
        bindings: [],
        terminalCustomNames: {},
        terminals: [
          {
            session: session('old'),
            scrollbackLines: ['legacy history'],
            exitCode: 0,
            signal: null,
          },
        ],
      }),
    );
    const authority = make();
    const other = {
      ...client,
      legacyLayout:
        layout === 'workspaces'
          ? ('app-workspaces' as const)
          : ('workspaces' as const),
    };
    expect(
      read === 'historyRead'
        ? authority.historyRead({ client: other, terminalId: 'old' }).text
        : authority.historyTail(other, 'old', 1024),
    ).toBe('');
    expect(existsSync(terminalRecordDir(root, 'proj', 'wt'))).toBe(false);
    const opened = authority.open(correct);
    expect(opened.import.from).toBe('v2');
    expect(opened.terminals.map(({ session }) => session.id)).toEqual(['old']);
    expect(
      authority.historyRead({ client: correct, terminalId: 'old' }).text,
    ).toBe('legacy history');
    expect(readFileSync(legacy, 'utf8')).toContain('legacy history');
  },
);

it.each([1, 2])(
  'history before open previews v%i legacy output without importing',
  (version) => {
    const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
    mkdirSync(dirname(legacy), { recursive: true });
    const text = 'x'.repeat(1023) + '€' + 'tail';
    const source = {
      version,
      lineage: 'preview',
      bindings: [],
      terminalCustomNames: {},
      terminals: [
        {
          session: session('old'),
          scrollbackLines: [text],
          exitCode: 0,
          signal: null,
        },
      ],
      drawerCollapsed: true,
      groups: [],
      activeGroupId: null,
      groupOrdinals: {},
      nextGroupOrdinal: 1,
      groupCustomNames: {},
    };
    writeFileSync(legacy, JSON.stringify(source));
    const before = readFileSync(legacy, 'utf8');
    const reads = jest.spyOn(fs, 'readFileSync');
    const authority = make();
    const first = WorkerTerminalRecordHistoryReadResultSchema.parse(
      authority.historyRead({ client, terminalId: 'old', maxBytes: 1024 }),
    );
    expect(first.text.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(first.text, 'utf8')).toBeLessThanOrEqual(1024);
    expect(first.text).not.toContain('€');
    expect(first.nextCursor).not.toBeNull();
    if (first.nextCursor === null)
      throw new Error('Expected a preview continuation');
    const continuation = {
      client,
      terminalId: 'old',
      cursor: first.nextCursor,
      historyRevision: first.historyRevision,
      maxBytes: 1024,
    };
    const last = authority.historyRead(continuation);
    expect(last).toMatchObject({ nextCursor: null, restarted: false });
    expect(first.text + last.text).toBe(text);
    expect(last.producerWatermarks).toBeUndefined();
    expect(authority.historyTail(client, 'old', 4)).toBe('tail');
    expect(reads.mock.calls.filter(([path]) => path === legacy)).toHaveLength(
      1,
    );
    expect(existsSync(terminalRecordDir(root, 'proj', 'wt'))).toBe(false);
    expect(readFileSync(legacy, 'utf8')).toBe(before);
    writeFileSync(
      legacy,
      JSON.stringify({
        ...source,
        terminals: [{ ...source.terminals[0], scrollbackLines: ['updated'] }],
      }),
    );
    expect(authority.historyRead(continuation)).toMatchObject({
      text: 'updated',
      restarted: true,
    });
    expect(existsSync(terminalRecordDir(root, 'proj', 'wt'))).toBe(false);
    expect(authority.open(client).import.from).toBe(
      version === 1 ? 'v1' : 'v2',
    );
    expect(authority.historyRead(continuation)).toMatchObject({
      text: 'updated',
      restarted: true,
    });
  },
);

it.each(['absent', 'damaged', 'newer', 'fenced', 'unreadable'])(
  'an unimported %s source is previewed without writing an import decision',
  (kind) => {
    const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
    mkdirSync(dirname(legacy), { recursive: true });
    if (kind === 'unreadable') mkdirSync(legacy);
    else if (kind !== 'absent')
      writeFileSync(
        legacy,
        kind === 'damaged'
          ? '{'
          : JSON.stringify({
              version: kind === 'newer' ? 999 : 3,
              movedTo: 'terminal-record-authority',
              lineage: 'fenced',
            }),
      );
    const authority = make();
    expect(authority.historyRead({ client, terminalId: 'old' }).text).toBe('');
    expect(authority.historyTail(client, 'old', 100)).toBe('');
    expect(existsSync(terminalRecordDir(root, 'proj', 'wt'))).toBe(false);
    if (kind === 'unreadable') {
      rmSync(legacy, { recursive: true });
      writeFileSync(
        legacy,
        JSON.stringify({
          version: 2,
          lineage: 'readable-again',
          bindings: [],
          terminalCustomNames: {},
          terminals: [
            {
              session: session('old'),
              scrollbackLines: ['recovered'],
              exitCode: 0,
              signal: null,
            },
          ],
        }),
      );
      expect(authority.historyRead({ client, terminalId: 'old' }).text).toBe(
        'recovered',
      );
      expect(existsSync(terminalRecordDir(root, 'proj', 'wt'))).toBe(false);
    }
  },
);

it.each(['entry limit', 'byte limit'])(
  'legacy preview cache evicts by %s without installing a record',
  (limit) => {
    const count = limit === 'entry limit' ? 5 : 3;
    const output = 'x'.repeat(limit === 'entry limit' ? 10 : 3 * 1024 * 1024);
    const clients = Array.from({ length: count }, (_, index) => ({
      ...client,
      worktreeId: `wt${index}`,
    }));
    const paths = clients.map((item) =>
      legacyTerminalStatePath(
        root,
        item.legacyLayout,
        item.projectId,
        item.worktreeId,
      ),
    );
    for (const [index, item] of clients.entries()) {
      const path = paths[index];
      if (path === undefined) throw new Error('Expected a legacy path');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          version: 2,
          lineage: `cached-${index}`,
          bindings: [],
          terminalCustomNames: {},
          terminals: [
            {
              session: session('cached', { worktreeId: item.worktreeId }),
              scrollbackLines: [output],
              exitCode: 0,
              signal: null,
            },
          ],
        }),
      );
    }
    const reads = jest.spyOn(fs, 'readFileSync');
    const authority = make();
    for (const item of clients)
      expect(authority.historyTail(item, 'cached', 1)).toBe('x');
    const first = clients[0];
    const last = clients.at(-1);
    if (!first || !last) throw new Error('Expected preview clients');
    expect(authority.historyTail(last, 'cached', 1)).toBe('x');
    expect(
      reads.mock.calls.filter(([path]) => path === paths.at(-1)),
    ).toHaveLength(1);
    expect(authority.historyTail(first, 'cached', 1)).toBe('x');
    expect(reads.mock.calls.filter(([path]) => path === paths[0])).toHaveLength(
      2,
    );
    expect(
      existsSync(terminalRecordDir(root, first.projectId, first.worktreeId)),
    ).toBe(false);
  },
);

it('a read does not finish a pending legacy import from another layout', () => {
  const authority = make();
  const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
  mkdirSync(dirname(legacy), { recursive: true });
  mkdirSync(legacy);
  expect(authority.open(client).import.pending).toBe(true);
  const before = readFileSync(recordFile(), 'utf8');
  expect(
    authority.historyRead({
      client: { ...client, legacyLayout: 'app-workspaces' },
      terminalId: 'old',
    }).text,
  ).toBe('');
  expect(readFileSync(recordFile(), 'utf8')).toBe(before);
  rmSync(legacy, { recursive: true });
  writeFileSync(
    legacy,
    JSON.stringify({
      version: 2,
      lineage: 'legacy',
      bindings: [],
      terminalCustomNames: {},
      terminals: [
        {
          session: session('old'),
          scrollbackLines: ['recovered'],
          exitCode: 0,
          signal: null,
        },
      ],
    }),
  );
  expect(authority.open(client).import.from).toBe('v2');
  expect(authority.historyRead({ client, terminalId: 'old' }).text).toBe(
    'recovered',
  );
});

describe('R9 owner evidence across failed transitions', () => {
  it.each(
    (['workspaces', 'app-workspaces'] as const).flatMap((legacyLayout) =>
      ['listing', 'rename', 'directory sync'].map((stage) => ({
        legacyLayout,
        stage,
      })),
    ),
  )(
    'R9 F1 an absent owner preserves $legacyLayout legacy import obligations after failed retirement at $stage',
    ({ legacyLayout, stage }) => {
      const importingClient = { ...client, legacyLayout };
      const legacy = legacyTerminalStatePath(
        root,
        legacyLayout,
        client.projectId,
        client.worktreeId,
      );
      mkdirSync(dirname(legacy), { recursive: true });
      writeFileSync(
        legacy,
        JSON.stringify({
          version: 2,
          lineage: 'unimported',
          bindings: [],
          terminals: [
            {
              session: session('legacy'),
              scrollbackLines: ['legacy history'],
              exitCode: null,
              signal: null,
            },
          ],
          terminalCustomNames: {},
        }),
      );
      const directory = terminalRecordDir(root, 'proj', 'wt');
      const tombstone = join(directory, 'tombstone.json');
      let blocked = true;
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (path): void => {
          if (blocked && stage === 'directory sync' && path === directory)
            throw new Error('retirement blocked');
        },
      });
      const list = fs.readdirSync;
      jest.spyOn(fs, 'readdirSync').mockImplementation((path, options) => {
        if (blocked && stage === 'listing' && path === directory)
          throw new Error('retirement blocked');
        return list(path, options);
      });
      const rename = fs.renameSync;
      jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (blocked && stage === 'rename' && to === tombstone)
          throw new Error('retirement blocked');
        rename(from, to);
      });
      const importer = jest.spyOn(repository, 'importLegacy');
      const authority = new TerminalRecordAuthority({ repository });
      expect(() =>
        authority.retire({ projectId: 'proj', worktreeId: 'wt' }),
      ).toThrow(
        stage === 'directory sync' ? 'outcome unknown' : 'retirement blocked',
      );
      if (stage !== 'directory sync')
        expect(() =>
          authority.retire({ projectId: 'proj', worktreeId: 'wt' }),
        ).toThrow('retirement blocked');
      blocked = false;
      const published = stage === 'directory sync';
      expect(existsSync(tombstone)).toBe(published);
      const opened = authority.open(importingClient);
      expect(importer).toHaveBeenCalledTimes(published ? 0 : 1);
      expect(opened.import).toMatchObject({ from: published ? 'none' : 'v2' });
      expect(opened.import.pending).toBeUndefined();
      expect(
        authority.historyRead({ client: importingClient, terminalId: 'legacy' })
          .text,
      ).toBe(published ? '' : 'legacy history');
      expect(readFileSync(legacy, 'utf8')).toContain('legacy history');
    },
  );

  it.each(['cached', 'recovered'])(
    'R9 F2 a %s predecessor fence must cover the requested generation',
    (mode) => {
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      let authority = new TerminalRecordAuthority({ repository });
      repository.retire('proj', 'wt', {
        generation: 4,
        incarnation: client.incarnation,
        retiredAt: 1,
      });
      if (mode === 'cached') authority.historyRead({ client, terminalId: 't' });
      else authority = new TerminalRecordAuthority({ repository });
      expect(
        authority.retire({
          projectId: 'proj',
          worktreeId: 'wt',
          generation: 5,
        }),
      ).toEqual({ retired: 1 });
      expect(repository.load('proj', 'wt')).toMatchObject({
        kind: 'absent',
        tombstone: { generation: 5 },
      });
      const delayed = {
        client: { ...client, generation: 5 },
        producer: { id: 'producer', runId: 'delayed' },
        seq: 1,
        ops: [{ op: 'session.upsert' as const, session: session('t') }],
      };
      expect(authority.apply(delayed).outcome).toBe('dropped');
      expect(
        new TerminalRecordAuthority({ repository }).apply(delayed).outcome,
      ).toBe('dropped');
      expect(existsSync(recordFile())).toBe(false);
    },
  );

  it.each(['open', 'attribution'])(
    'R9 F2 a predecessor fence cannot complete a failed incarnation transition through %s',
    (trigger) => {
      const directory = terminalRecordDir(root, 'proj', 'wt');
      const tombstone = join(directory, 'tombstone.json');
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      const authority = new TerminalRecordAuthority({ repository });
      authority.open(client);
      authority.retire({ projectId: 'proj', worktreeId: 'wt', generation: 1 });
      expect(authority.open(client).generation).toBe(2);
      authority.apply({
        client,
        producer: { id: 'producer', runId: 'live' },
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('t') },
          { op: 'output.append', terminalId: 't', text: 'keep live' },
        ],
      });
      let blocked = true;
      const rename = fs.renameSync;
      jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (blocked && to === tombstone) throw new Error('retirement blocked');
        rename(from, to);
      });
      const successor = { ...client, incarnation: 'inc-2' };
      if (trigger === 'open')
        expect(() => authority.open(successor)).toThrow('retirement blocked');
      else {
        authority.attribute({
          terminalId: 'successor',
          client: successor,
          session: session('successor'),
          persist: true,
        });
        authority.output('successor', Buffer.from('held output'));
        expect(authority.isAttributed('successor')).toBe(false);
      }
      expect(authority.historyRead({ client, terminalId: 't' }).text).toBe(
        'keep live',
      );
      expect(record().generation).toBe(2);
      blocked = false;
      expect(authority.open(successor).generation).toBe(3);
      if (trigger === 'open')
        expect(authority.open(successor).terminals).toEqual([]);
      else
        expect(
          authority.historyRead({ client: successor, terminalId: 'successor' })
            .text,
        ).toBe('held output');
    },
  );

  it.each(['rename', 'directory sync'])(
    'R9 F2 extending a predecessor fence retains its pending generation at %s failure',
    (stage) => {
      const directory = terminalRecordDir(root, 'proj', 'wt');
      let blocked = false;
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (path): void => {
          if (blocked && stage === 'directory sync' && path === directory)
            throw new Error('fence blocked');
        },
      });
      repository.retire('proj', 'wt', {
        generation: 4,
        incarnation: null,
        retiredAt: 1,
      });
      const rename = fs.renameSync;
      jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (
          blocked &&
          stage === 'rename' &&
          to === join(directory, 'tombstone.json')
        )
          throw new Error('fence blocked');
        rename(from, to);
      });
      const authority = new TerminalRecordAuthority({ repository });
      const intent = { projectId: 'proj', worktreeId: 'wt', generation: 5 };
      blocked = true;
      expect(() => authority.retire(intent)).toThrow(
        stage === 'rename' ? 'fence blocked' : 'outcome unknown',
      );
      expect(repository.load('proj', 'wt')).toMatchObject({
        kind: 'absent',
        tombstone: { generation: stage === 'rename' ? 4 : 5 },
      });
      blocked = false;
      expect(authority.retire(intent)).toEqual({ retired: 1 });
      const delayed = {
        client: { ...client, generation: 5 },
        producer: { id: 'producer', runId: 'failed-fence' },
        seq: 1,
        ops: [],
      };
      expect(authority.apply(delayed).outcome).toBe('dropped');
      expect(
        new TerminalRecordAuthority({ repository }).apply(delayed).outcome,
      ).toBe('dropped');
    },
  );

  it('R9 F2 an inherited lifetime identity cannot acknowledge a lower generation fence', () => {
    const authority = make();
    const old = { ...client, lifetimeId: 'old' };
    authority.apply({
      client: old,
      producer: { id: 'p', runId: 'old' },
      seq: 1,
      ops: [],
    });
    authority.retire({
      projectId: 'proj',
      worktreeId: 'wt',
      generation: 1,
      lifetimeIds: ['old'],
    });
    authority.open(client);
    expect(
      authority.retire({
        projectId: 'proj',
        worktreeId: 'wt',
        generation: 2,
        lifetimeIds: ['old'],
      }),
    ).toEqual({ retired: 1 });
    expect(
      make().apply({
        client: { ...client, generation: 2 },
        producer: { id: 'p', runId: 'late' },
        seq: 1,
        ops: [],
      }).outcome,
    ).toBe('dropped');
  });

  it('R9 F2 retirement still preserves a newer live generation', () => {
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (): void => undefined,
    });
    repository.retire('proj', 'wt', {
      generation: 4,
      incarnation: null,
      retiredAt: 1,
    });
    const authority = new TerminalRecordAuthority({ repository });
    expect(authority.open(client).generation).toBe(5);
    expect(
      authority.retire({ projectId: 'proj', worktreeId: 'wt', generation: 4 }),
    ).toEqual({ retired: 0 });
    expect(record().generation).toBe(5);
  });

  it('R9 F3 unpublished appends stay outside snapshot watermarks until replay', () => {
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (): void => undefined,
    });
    const authority = new TerminalRecordAuthority({ repository });
    const producer = { id: 'producer', runId: 'unpublished' };
    authority.apply({
      client,
      producer,
      seq: 1,
      ops: [{ op: 'session.upsert', session: session('t') }],
    });
    const retained = {
      client,
      producer,
      seq: 2,
      ops: [{ op: 'output.append' as const, terminalId: 't', text: 'once' }],
    };
    jest.spyOn(repository, 'save').mockImplementationOnce(() => {
      throw new Error('not published');
    });
    expect(() => authority.apply(retained)).toThrow('could not be installed');
    const page = authority.historyRead({ client, terminalId: 't' });
    expect(page).toMatchObject({
      text: '',
      snapshotProducerWatermarks: { 'producer/unpublished': 1 },
    });
    const overlaySeq =
      page.snapshotProducerWatermarks?.['producer/unpublished'] ?? 0;
    expect(
      page.text + (retained.seq > overlaySeq ? retained.ops[0].text : ''),
    ).toBe('once');
    expect(authority.apply(retained).outcome).toBe('applied');
    expect(authority.historyRead({ client, terminalId: 't' })).toMatchObject({
      text: 'once',
      snapshotProducerWatermarks: { 'producer/unpublished': 2 },
    });
    expect(
      authority.historyRead({ client, terminalId: 'missing' }),
    ).toMatchObject({
      text: '',
      snapshotProducerWatermarks: { 'producer/unpublished': 2 },
    });
    expect(
      authority.historyRead({
        client: { ...client, worktreeId: 'absent' },
        terminalId: 't',
      }),
    ).not.toHaveProperty('snapshotProducerWatermarks');
  });

  it.each(['published here', 'recovered'])(
    'R9 F3 %s paginated history identifies unconfirmed effects after a concurrent append',
    (mode) => {
      const directory = terminalRecordDir(root, 'proj', 'wt');
      let blocked = false;
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (path): void => {
          if (blocked && path === directory) throw new Error('sync blocked');
        },
      });
      let authority = new TerminalRecordAuthority({ repository });
      const producer = { id: 'producer', runId: 'pages' };
      const prefix = '😀'.repeat(256);
      authority.apply({
        client,
        producer,
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('t') },
          { op: 'output.append', terminalId: 't', text: prefix },
        ],
      });
      const retained = {
        client,
        producer,
        seq: 2,
        ops: [{ op: 'output.append' as const, terminalId: 't', text: 'once' }],
      };
      blocked = true;
      expect(() => authority.apply(retained)).toThrow('could not be installed');
      if (mode === 'recovered') {
        authority.dispose();
        authority = new TerminalRecordAuthority({ repository });
      }
      const request = { client, terminalId: 't', maxBytes: 1024 };
      const first = authority.historyRead(request);
      expect(first.text).toBe(prefix);
      expect(first.snapshotProducerWatermarks).toEqual({ 'producer/pages': 2 });
      expect(first).not.toHaveProperty('producerWatermarks');
      if (first.nextCursor === null) throw new Error('Expected another page');
      const later = {
        ...retained,
        seq: 3,
        ops: [
          { op: 'output.append' as const, terminalId: 't', text: ' later' },
        ],
      };
      expect(() => authority.apply(later)).toThrow('could not be installed');
      const restarted = authority.historyRead({
        ...request,
        cursor: first.nextCursor,
        historyRevision: first.historyRevision,
      });
      expect(restarted).toMatchObject({
        text: prefix,
        restarted: true,
        snapshotProducerWatermarks: { 'producer/pages': 3 },
      });
      if (restarted.nextCursor === null)
        throw new Error('Expected another page');
      const last = authority.historyRead({
        ...request,
        cursor: restarted.nextCursor,
        historyRevision: restarted.historyRevision,
      });
      expect(last).toMatchObject({
        text: 'once later',
        restarted: false,
        nextCursor: null,
        snapshotProducerWatermarks: { 'producer/pages': 3 },
      });
      expect(last).not.toHaveProperty('producerWatermarks');
      expect(first.snapshotProducerWatermarks).toEqual({ 'producer/pages': 2 });
      blocked = false;
      expect(authority.apply(retained).outcome).toBe('duplicate');
      expect(authority.apply(later).outcome).toBe('duplicate');
      expect(authority.historyRead({ client, terminalId: 't' }).text).toBe(
        prefix + 'once later',
      );
    },
  );

  it.each(['published here', 'recovered'])(
    'R9 F3 %s history identifies visible effects without releasing retained batches',
    (mode) => {
      const directory = terminalRecordDir(root, 'proj', 'wt');
      let blocked = false;
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (path): void => {
          if (blocked && path === directory) throw new Error('sync blocked');
        },
      });
      let authority = new TerminalRecordAuthority({ repository });
      const producer = { id: 'producer', runId: 'overlay' };
      authority.apply({
        client,
        producer,
        seq: 1,
        ops: [{ op: 'session.upsert', session: session('t') }],
      });
      const retained = {
        client,
        producer,
        seq: 2,
        ops: [{ op: 'output.append' as const, terminalId: 't', text: 'once' }],
      };
      blocked = true;
      expect(() => authority.apply(retained)).toThrow('could not be installed');
      if (mode === 'recovered') {
        authority.dispose();
        authority = new TerminalRecordAuthority({ repository });
      }
      const page = authority.historyRead({ client, terminalId: 't' });
      const opened = authority.open(client);
      expect(
        WorkerTerminalRecordHistoryReadResultSchema.parse(page),
      ).toMatchObject({
        text: 'once',
        snapshotProducerWatermarks: { 'producer/overlay': 2 },
      });
      expect(WorkerTerminalRecordOpenResultSchema.parse(opened)).toMatchObject({
        snapshotProducerWatermarks: { 'producer/overlay': 2 },
        producerWatermarks: {},
        import: { pending: true },
      });
      expect(page).not.toHaveProperty('producerWatermarks');
      // Overlay suppression does not release the retained replay copy.
      const overlaySeq =
        page.snapshotProducerWatermarks?.['producer/overlay'] ?? 0;
      expect(
        page.text + (retained.seq > overlaySeq ? retained.ops[0].text : ''),
      ).toBe('once');
      expect(() => authority.apply(retained)).toThrow('sync blocked');
      blocked = false;
      expect(authority.apply(retained).outcome).toBe('duplicate');
      authority.apply({
        client,
        producer,
        seq: 3,
        ops: [{ op: 'output.append', terminalId: 't', text: ' later' }],
      });
      expect(page.snapshotProducerWatermarks).toEqual({
        'producer/overlay': 2,
      });
      expect(opened.snapshotProducerWatermarks).toEqual({
        'producer/overlay': 2,
      });
      expect(authority.historyRead({ client, terminalId: 't' })).toMatchObject({
        text: 'once later',
        producerWatermarks: { 'producer/overlay': 3 },
        snapshotProducerWatermarks: { 'producer/overlay': 3 },
      });
    },
  );
});

it('recovered watermarks require a successful directory sync before duplicate acknowledgement', () => {
  jest.useFakeTimers();
  try {
    const directory = terminalRecordDir(root, 'proj', 'wt');
    let blocked = false;
    const flush = jest.fn((path: string) => {
      if (path === directory && blocked)
        throw new Error('directory sync blocked');
    });
    const create = (): TerminalRecordAuthority =>
      new TerminalRecordAuthority({
        repository: new TerminalRecordRepository({
          dataRoot: root,
          flushDirectorySync: flush,
        }),
      });
    const authority = create();
    authority.open(client);
    const batch = {
      client,
      producer: { id: 'electron_main', runId: 'recovered' },
      seq: 1,
      ops: [
        { op: 'session.upsert' as const, session: session('t') },
        { op: 'output.append' as const, terminalId: 't', text: 'exactly once' },
      ],
    };
    blocked = true;
    expect(() => authority.apply(batch)).toThrow('could not be installed');
    // Rename landed, but neither this process nor its successor may ack it yet.
    expect(record().producerWatermarks).toEqual({
      'electron_main/recovered': 1,
    });
    const restarted = create();
    const attempts = flush.mock.calls.length;
    // Visible bytes stay usable while durable acknowledgements remain withheld.
    const result = restarted.historyRead({ client, terminalId: 't' });
    expect(result.text).toBe('exactly once');
    expect(result).not.toHaveProperty('producerWatermarks');
    const afterRead = flush.mock.calls.length;
    restarted.historyRead({ client, terminalId: 't' });
    expect(restarted.historyTail(client, 't', 100)).toBe('exactly once');
    expect(flush.mock.calls.length).toBe(afterRead);
    expect(restarted.open(client)).toMatchObject({
      producerWatermarks: {},
      import: { pending: true },
      terminals: [{ session: { id: 't' } }],
    });
    expect(() => restarted.apply(batch)).toThrow('directory sync blocked');
    expect(flush.mock.calls.length).toBeGreaterThan(attempts);
    expect(() => restarted.apply(batch)).toThrow('directory sync blocked');
    blocked = false;
    expect(restarted.apply(batch).outcome).toBe('duplicate');
    const confirmed = flush.mock.calls.length;
    for (let read = 0; read < 3; read += 1) {
      expect(restarted.historyRead({ client, terminalId: 't' })).toMatchObject({
        text: 'exactly once',
        producerWatermarks: { 'electron_main/recovered': 1 },
      });
      expect(restarted.open(client).import.pending).toBeUndefined();
      expect(restarted.apply(batch).outcome).toBe('duplicate');
    }
    // Confirmation is cached for this loaded scope, not per page.
    expect(flush.mock.calls.length).toBe(confirmed);
  } finally {
    jest.useRealTimers();
  }
});

it.each(
  ['listing', 'rename', 'directory sync', 'cleanup'].flatMap((stage) =>
    ['loaded', 'reloaded'].map((mode) => ({ stage, mode })),
  ),
)(
  'retirement failure at $stage preserves either live reports or the published fence ($mode)',
  ({ stage, mode }) => {
    const directory = terminalRecordDir(root, 'proj', 'wt');
    const tombstone = join(directory, 'tombstone.json');
    let blocked = false;
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (path): void => {
        if (blocked && stage === 'directory sync' && path === directory)
          throw new Error('retirement blocked');
      },
    });
    let authority = new TerminalRecordAuthority({ repository });
    authority.attribute({
      terminalId: 't',
      client,
      session: session('t'),
      persist: true,
    });
    authority.attribute({
      terminalId: 'live',
      client,
      session: session('live'),
      persist: true,
    });
    authority.flushSync();
    authority.output('t', Buffer.from('buffered output'));
    authority.exited('t', 7, null);
    authority.output('live', Buffer.from('still live'));
    if (mode === 'reloaded') {
      authority.flushSync();
      authority = new TerminalRecordAuthority({ repository });
      authority.attribute({
        terminalId: 'live',
        client,
        session: session('live'),
        persist: true,
      });
    }
    expect(authority.isAttributed('live')).toBe(true);
    const list = fs.readdirSync;
    jest.spyOn(fs, 'readdirSync').mockImplementation((path, options) => {
      if (blocked && stage === 'listing' && path === directory)
        throw new Error('retirement blocked');
      return list(path, options);
    });
    const rename = fs.renameSync;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (blocked && stage === 'rename' && to === tombstone)
        throw new Error('retirement blocked');
      rename(from, to);
    });
    const remove = fs.rmSync;
    jest.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (blocked && stage === 'cleanup' && path === recordFile())
        throw new Error('retirement blocked');
      remove(path, options);
    });
    blocked = true;
    const intent = { projectId: 'proj', worktreeId: 'wt', generation: 1 };
    expect(() => authority.retire(intent)).toThrow(
      stage === 'directory sync' ? 'outcome unknown' : 'retirement blocked',
    );
    const published = stage === 'directory sync' || stage === 'cleanup';
    expect(existsSync(tombstone)).toBe(published);
    if (!published) {
      expect(authority.isAttributed('live')).toBe(true);
      authority.output('live', Buffer.from(' after refusal'));
      expect(authority.historyRead({ client, terminalId: 'live' }).text).toBe(
        'still live after refusal',
      );
      expect(authority.historyRead({ client, terminalId: 't' }).text).toBe(
        'buffered output',
      );
      authority.flushSync();
      expect(record().record.terminals[0]).toMatchObject({
        scrollbackLines: ['buffered output'],
        exitCode: 7,
      });
    } else {
      // The host map still contains this terminal; only the lifetime fence
      // may stop its reports after a post-publication retirement failure.
      authority.output('live', Buffer.from('late output'));
      authority.flushSync();
      expect(authority.isAttributed('live')).toBe(false);
      expect(authority.historyRead({ client, terminalId: 'live' }).text).toBe(
        '',
      );
    }
    blocked = false;
    expect(authority.retire(intent)).toEqual({ retired: 1 });
    expect(make().historyRead({ client, terminalId: 't' }).text).toBe('');
    expect(existsSync(recordFile())).toBe(false);
  },
);

it('producer pairs containing separators have distinct bounded watermark keys', () => {
  const authority = make();
  const producers = [
    { id: 'a/b', runId: 'c' },
    { id: 'a', runId: 'b/c' },
    { id: 'a%2Fb', runId: 'c' },
    { id: 'a', runId: 'b%2Fc' },
  ];
  for (const [index, producer] of producers.entries()) {
    const batch = WorkerTerminalRecordApplyParamsSchema.parse({
      client,
      producer,
      seq: 1,
      ops: [
        { op: 'session.upsert', session: session(`t${index}`) },
        {
          op: 'output.append',
          terminalId: `t${index}`,
          text: `output ${index}`,
        },
      ],
    });
    expect(authority.apply(batch).outcome).toBe('applied');
    expect(authority.apply(batch).outcome).toBe('duplicate');
  }
  const restarted = make();
  const opened = WorkerTerminalRecordOpenResultSchema.parse(
    restarted.open(client),
  );
  expect(Object.keys(opened.producerWatermarks ?? {})).toHaveLength(4);
  for (const index of producers.keys())
    expect(
      restarted.historyRead({ client, terminalId: `t${index}` }).text,
    ).toBe(`output ${index}`);
  const oversized = WorkerTerminalRecordApplyParamsSchema.parse({
    client,
    producer: { id: '/'.repeat(512), runId: 'r' },
    seq: 1,
    ops: [],
  });
  expect(() => authority.apply(oversized)).toThrow('watermark key is too long');
});

it.each([
  [171, 510],
  [172, 508],
])(
  'bounds escaped watermark keys with %i separators and a %i-character run',
  (slashes, runLength) => {
    const authority = make();
    const batch = WorkerTerminalRecordApplyParamsSchema.parse({
      client,
      producer: { id: '/'.repeat(slashes), runId: 'r'.repeat(runLength) },
      seq: 1,
      ops: [],
    });
    if (slashes * 3 + runLength + 1 > 1024) {
      expect(() => authority.apply(batch)).toThrow('watermark key is too long');
      expect(existsSync(recordFile())).toBe(false);
    } else {
      expect(authority.apply(batch).outcome).toBe('applied');
      const opened = WorkerTerminalRecordOpenResultSchema.parse(
        make().open(client),
      );
      expect(Object.keys(opened.producerWatermarks ?? {})).toEqual([
        `${'%2F'.repeat(slashes)}/${batch.producer.runId}`,
      ]);
    }
  },
);

it('persisted daemon output reaches history before the exit; non-persisted kinds write nothing', () => {
  const authority = make();
  authority.attribute({
    terminalId: 'a',
    client,
    session: session('a'),
    persist: true,
  });
  authority.attribute({
    terminalId: 'c',
    client,
    session: session('c', { kind: 'claude-code' }),
    persist: false,
  });
  authority.output('a', Buffer.from('one\ntwo\xe2', 'latin1'));
  authority.output('a', Buffer.from([0x82, 0xac]));
  authority.output('c', Buffer.from('secret'));
  authority.exited('a', 0, null);
  authority.flushSync();
  const page = authority.historyRead({ client, terminalId: 'a' });
  expect(page.text).toBe('one\ntwo€');
  const ids = record().record.terminals.map((t) => t.session.id);
  expect(ids).toEqual(['a']);
  expect(record().record.terminals[0].exitCode).toBe(0);
});

it('apply is at most once under the watermark and drops older generations', () => {
  const authority = make();
  const producer = { id: 'electron_main', runId: 'r1' };
  const ops = [
    { op: 'session.upsert' as const, session: session('p') },
    { op: 'output.append' as const, terminalId: 'p', text: 'x' },
  ];
  expect(authority.apply({ client, producer, seq: 1, ops }).outcome).toBe(
    'applied',
  );
  expect(authority.apply({ client, producer, seq: 1, ops }).outcome).toBe(
    'duplicate',
  );
  const page = authority.historyRead({ client, terminalId: 'p' });
  expect(page).toMatchObject({
    text: 'x',
    producerWatermarks: { 'electron_main/r1': 1 },
  });
  authority.apply({
    client,
    producer,
    seq: 2,
    ops: [{ op: 'output.append', terminalId: 'p', text: 'y' }],
  });
  expect(authority.historyRead({ client, terminalId: 'p' })).toMatchObject({
    text: 'xy',
    producerWatermarks: { 'electron_main/r1': 2 },
  });
  // A delayed page retains the watermark of its own output snapshot.
  expect(page.producerWatermarks).toEqual({ 'electron_main/r1': 1 });
  expect(
    authority.historyRead({ client, terminalId: 'missing' }).producerWatermarks,
  ).toEqual({ 'electron_main/r1': 2 });
  // A fresh authority (daemon restart) still sees the watermark.
  const next = make();
  expect(next.apply({ client, producer, seq: 1, ops }).outcome).toBe(
    'duplicate',
  );
  next.retire({ projectId: 'proj', worktreeId: 'wt' });
  expect(
    next.apply({ client, producer, seq: 2, generation: 1, ops }).outcome,
  ).toBe('dropped');
  expect(next.open(client).generation).toBe(2);
  expect(next.open(client).terminals).toEqual([]);
});

it('layout.save forgets only served terminals the client no longer references', () => {
  const authority = make();
  const producer = { id: 'electron_main', runId: 'r1' };
  authority.apply({
    client,
    producer,
    seq: 1,
    ops: [
      { op: 'session.upsert', session: session('seen') },
      { op: 'session.upsert', session: session('gone') },
      { op: 'session.upsert', session: session('unseen') },
      { op: 'rename', terminalId: 'unseen', name: 'keep me' },
    ],
  });
  authority.apply({
    client,
    producer,
    seq: 2,
    ops: [
      {
        op: 'layout.save',
        servedIds: ['seen', 'gone'],
        referencedIds: ['seen'],
        bindings: [
          {
            key: 'k',
            groupId: 'g',
            members: [{ key: 'mk', terminalId: 'seen' }],
          },
        ],
        terminalCustomNames: { seen: 'S' },
      },
    ],
  });
  const opened = authority.open(client);
  expect(opened.terminals.map((t) => t.session.id).sort()).toEqual([
    'seen',
    'unseen',
  ]);
  expect(opened.terminalCustomNames).toEqual({ seen: 'S', unseen: 'keep me' });
  expect(
    opened.bindings.some((b) =>
      b.members.some((m) => m.terminalId === 'unseen'),
    ),
  ).toBe(true);
});

it('reconciles daemon terminals of a dead daemon lazily; shutdown stamps are kept', () => {
  const first = make();
  first.attribute({
    terminalId: 'd',
    client,
    session: session('d'),
    persist: true,
  });
  first.attribute({
    terminalId: 'q',
    client,
    session: session('q'),
    persist: true,
  });
  expect(first.shutdown('app-quit').stamped).toBe(2);
  first.exited('q', null, 'connection-lost');
  first.flushSync();
  const second = make();
  const opened = second.open(client);
  const byId = Object.fromEntries(
    opened.terminals.map((t) => [t.session.id, t]),
  );
  expect(byId.d.signal).toBe('app-quit');
  expect(byId.q.signal).toBe('app-quit');

  const third = make();
  third.attribute({
    terminalId: 'z',
    client,
    session: session('z'),
    persist: true,
  });
  third.flushSync();
  // daemon death: no exit reported
  const fourth = make();
  const z = fourth.open(client).terminals.find((t) => t.session.id === 'z');
  expect(z?.signal).toBe('connection-lost');
});

it('a late batch of an older generation and incarnation leaves the newer record as it is', () => {
  const producer = { id: 'electron_main', runId: 'r1' };
  const first = make();
  first.apply({
    client,
    producer,
    seq: 1,
    ops: [{ op: 'session.upsert', session: session('old') }],
  });
  first.flushSync();
  // The worktree id is reused: a newer incarnation's record, generation 2.
  const reused = { ...client, incarnation: 'inc-2' };
  const authority = make();
  expect(
    authority.apply({
      client: reused,
      producer: { id: 'electron_main', runId: 'r2' },
      seq: 1,
      ops: [
        { op: 'session.upsert', session: session('new') },
        { op: 'output.append', terminalId: 'new', text: 'kept' },
      ],
    }).outcome,
  ).toBe('applied');
  const before = authority.open(reused);
  expect(before.generation).toBe(2);
  // The first incarnation's slow drain delivers its generation 1 batch.
  const late = authority.apply({
    client,
    producer,
    seq: 2,
    generation: 1,
    ops: [{ op: 'forget', terminalId: 'new' }],
  });
  expect(late).toMatchObject({ outcome: 'dropped', generation: 2 });
  const after = authority.open(reused);
  expect(after.generation).toBe(2);
  expect(after.lineage).toBe(before.lineage);
  expect(after.terminals.map((t) => t.session.id)).toEqual(['new']);
  expect(
    authority.historyRead({ client: reused, terminalId: 'new' }).text,
  ).toBe('kept');
  expect(record().generation).toBe(2);
  expect(record().incarnation).toBe('inc-2');
});

it('a legacy read that fails other than absent is retried, never imported empty', () => {
  const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
  mkdirSync(join(legacy, '..'), { recursive: true });
  const legacyBytes = JSON.stringify({
    version: 2,
    lineage: 'L',
    bindings: [
      { key: 'b', groupId: 'g', members: [{ key: 'm', terminalId: 'old' }] },
    ],
    terminals: [
      {
        session: session('old'),
        scrollbackLines: ['hello'],
        exitCode: 0,
        signal: null,
      },
    ],
    terminalCustomNames: {},
  });
  writeFileSync(legacy, legacyBytes);
  // One read of the legacy state fails, as an EACCES does.
  const original = fs.readFileSync;
  let failures = 1;
  jest.spyOn(fs, 'readFileSync').mockImplementation((path, options) => {
    if (path === legacy && failures > 0) {
      failures -= 1;
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }
    return original(path, options);
  });
  const authority = make();
  // A daemon terminal starts while the legacy state cannot be read.
  authority.attribute({
    terminalId: 'new',
    client,
    session: session('new'),
    persist: true,
  });
  authority.output('new', Buffer.from('meanwhile'));
  authority.flushSync();
  // Installed as pending, never as imported; the legacy state is untouched.
  expect(record().import).toMatchObject({ from: 'none', pending: true });
  expect(readFileSync(legacy, 'utf8')).toBe(legacyBytes);
  // The next touch imports it, with the daemon terminal's report on top.
  const opened = authority.open(client);
  expect(opened.import.from).toBe('v2');
  expect(opened.lineage).toBe('L');
  expect(opened.terminals.map((t) => t.session.id).sort()).toEqual([
    'new',
    'old',
  ]);
  expect(authority.historyRead({ client, terminalId: 'old' }).text).toBe(
    'hello',
  );
  expect(authority.historyRead({ client, terminalId: 'new' }).text).toBe(
    'meanwhile',
  );
  expect(
    existsSync(
      join(terminalRecordDir(root, 'proj', 'wt'), 'import-source.json'),
    ),
  ).toBe(true);
  expect(record().import.from).toBe('v2');
});

it('writes wait while the legacy state cannot be read; a load sees the record as pending', () => {
  const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
  mkdirSync(join(legacy, '..'), { recursive: true });
  writeFileSync(
    legacy,
    JSON.stringify({
      version: 2,
      lineage: 'L',
      bindings: [],
      terminals: [],
      terminalCustomNames: {},
    }),
  );
  const original = fs.readFileSync;
  const spy = jest
    .spyOn(fs, 'readFileSync')
    .mockImplementation((path, options) => {
      if (path === legacy)
        throw Object.assign(new Error('io'), { code: 'EIO' });
      return original(path, options);
    });
  const authority = make();
  const producer = { id: 'electron_main', runId: 'r1' };
  const ops = [{ op: 'session.upsert' as const, session: session('p') }];
  // The producer keeps the batch and retries it; nothing is installed.
  expect(() => authority.apply({ client, producer, seq: 1, ops })).toThrow();
  const pending = authority.open(client);
  expect(pending.import).toMatchObject({ from: 'none', pending: true });
  expect(pending.terminals).toEqual([]);
  expect(record().import).toMatchObject({ pending: true });
  expect(record().record.terminals).toEqual([]);
  spy.mockRestore();
  expect(authority.apply({ client, producer, seq: 1, ops }).outcome).toBe(
    'applied',
  );
  const opened = authority.open(client);
  expect(opened.import.from).toBe('v2');
  expect(opened.import.pending).toBeUndefined();
  expect(opened.terminals.map((t) => t.session.id)).toEqual(['p']);
});

const legacyWithOld = (): { path: string; bytes: string } => {
  const path = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
  mkdirSync(join(path, '..'), { recursive: true });
  const bytes = JSON.stringify({
    version: 2,
    lineage: 'L',
    bindings: [
      { key: 'b', groupId: 'g', members: [{ key: 'm', terminalId: 'old' }] },
    ],
    terminals: [
      {
        session: session('old'),
        scrollbackLines: ['hello'],
        exitCode: 0,
        signal: null,
      },
    ],
    terminalCustomNames: {},
  });
  writeFileSync(path, bytes);
  return { path, bytes };
};

const failReadsOf = (path: string): jest.SpyInstance => {
  const original = fs.readFileSync;
  return jest.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
    if (file === path)
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original(file, options);
  });
};

it('what daemon terminals report while the legacy import waits survives a daemon restart', () => {
  const legacy = legacyWithOld();
  const spy = failReadsOf(legacy.path);
  const first = make();
  first.attribute({
    terminalId: 'new',
    client,
    session: session('new'),
    persist: true,
  });
  first.output('new', Buffer.from('meanwhile'));
  first.exited('new', 0, null);
  // The daemon stops before the legacy state could be read.
  first.shutdown('app-quit');
  spy.mockRestore();
  expect(readFileSync(legacy.path, 'utf8')).toBe(legacy.bytes);
  const restarted = make();
  const opened = restarted.open(client);
  expect(opened.import.from).toBe('v2');
  expect(opened.import.pending).toBeUndefined();
  expect(opened.lineage).toBe('L');
  expect(opened.terminals.map((t) => t.session.id).sort()).toEqual([
    'new',
    'old',
  ]);
  expect(restarted.historyRead({ client, terminalId: 'new' }).text).toBe(
    'meanwhile',
  );
  expect(restarted.historyRead({ client, terminalId: 'old' }).text).toBe(
    'hello',
  );
  expect(record().import.pending).toBeUndefined();
});

it('a pending import composes as the import would have: legacy output, then what came meanwhile', () => {
  const events = (authority: TerminalRecordAuthority): void => {
    // A legacy terminal restored on the daemon, and a new one.
    authority.attribute({
      terminalId: 'old',
      client,
      session: session('old'),
      persist: true,
    });
    authority.output('old', Buffer.from('x\nagain'));
    authority.attribute({
      terminalId: 'new',
      client,
      session: session('new'),
      persist: true,
    });
  };
  const read = (
    authority: TerminalRecordAuthority,
  ): Record<string, unknown> => {
    const opened = authority.open(client);
    return {
      bindings: opened.bindings,
      terminals: opened.terminals.map((t) => ({
        id: t.session.id,
        exitCode: t.exitCode,
        signal: t.signal,
        text: authority.historyRead({ client, terminalId: t.session.id }).text,
      })),
    };
  };
  legacyWithOld();
  const direct = make();
  events(direct);
  const expected = read(direct);
  expect(direct.historyRead({ client, terminalId: 'old' }).text).toBe(
    'hellox\nagain',
  );
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const legacy = legacyWithOld();
  const spy = failReadsOf(legacy.path);
  const waiting = make();
  events(waiting);
  spy.mockRestore();
  expect(read(waiting)).toEqual(expected);
});

it('a reused worktree id with another incarnation starts a fresh record', () => {
  const authority = make();
  authority.attribute({
    terminalId: 'a',
    client,
    session: session('a'),
    persist: true,
  });
  authority.flushSync();
  const next = make();
  const opened = next.open({ ...client, incarnation: 'inc-2' });
  expect(opened.terminals).toEqual([]);
  expect(opened.generation).toBe(2);
  // unknown incarnation never wipes
  const third = make();
  expect(third.open({ ...client, incarnation: null }).generation).toBe(2);
});

it('imports damaged, newer and fenced legacy state empty without touching it', () => {
  const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
  mkdirSync(join(legacy, '..'), { recursive: true });
  writeFileSync(legacy, '{not json');
  expect(make().open(client).import.from).toBe('damaged');
  expect(readFileSync(legacy, 'utf8')).toBe('{not json');
  rmSync(terminalRecordDir(root, 'proj', 'wt'), { recursive: true });
  writeFileSync(
    legacy,
    JSON.stringify({
      version: 3,
      movedTo: 'terminal-record-authority',
      lineage: 'x',
      sourceSha256: null,
    }),
  );
  expect(make().open(client).import.from).toBe('fenced');
  rmSync(terminalRecordDir(root, 'proj', 'wt'), { recursive: true });
  writeFileSync(legacy, JSON.stringify({ version: 9 }));
  expect(make().open(client).import.from).toBe('newer');
});

it('v1 import uses the deterministic lineage and history pages by bytes', () => {
  const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
  mkdirSync(join(legacy, '..'), { recursive: true });
  const big = 'é'.repeat(3000);
  writeFileSync(
    legacy,
    JSON.stringify({
      version: 1,
      terminals: [
        {
          session: session('v'),
          scrollbackLines: [big, big],
          exitCode: null,
          signal: null,
        },
      ],
      groups: [
        {
          id: 'g',
          terminalIds: ['v'],
          focusedTerminalId: 'v',
          splitSizes: [1],
        },
      ],
    }),
  );
  const a = make().open(client);
  rmSync(terminalRecordDir(root, 'proj', 'wt'), { recursive: true });
  const b = make();
  expect(b.open(client).lineage).toBe(a.lineage);
  expect(a.lineage.startsWith('legacy/')).toBe(true);
  let text = '';
  let cursor: string | undefined;
  do {
    const page = b.historyRead({
      client,
      terminalId: 'v',
      maxBytes: 1024,
      ...(cursor && { cursor }),
    });
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(1024);
    text += page.text;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(text).toBe(`${big}\n${big}`);
});

it('a terminal whose record could not be read attributes once it can, with what it reported meanwhile', () => {
  make().open(client);
  const authority = make();
  const original = fs.readFileSync;
  const spy = jest
    .spyOn(fs, 'readFileSync')
    .mockImplementation((path, options) => {
      if (path === recordFile())
        throw Object.assign(new Error('io'), { code: 'EIO' });
      return original(path, options);
    });
  // Creation still succeeds; the reports wait on the record.
  expect(() =>
    authority.attribute({
      terminalId: 't',
      client,
      session: session('t'),
      persist: true,
    }),
  ).not.toThrow();
  authority.attribute({
    terminalId: 'u',
    client,
    session: session('u'),
    persist: true,
  });
  authority.output('t', Buffer.from('during outage\n'));
  authority.output('u', Buffer.from('short-lived'));
  authority.exited('u', 3, null);
  spy.mockRestore();
  authority.output('t', Buffer.from('after'));
  // The next read of the scope attributes them first.
  expect(authority.historyRead({ client, terminalId: 't' }).text).toBe(
    'during outage\nafter',
  );
  authority.output('t', Buffer.from('!'));
  authority.exited('t', 0, null);
  authority.flushSync();
  const terminals = record().record.terminals;
  expect(
    terminals.map((t) => [t.session.id, t.scrollbackLines, t.exitCode]),
  ).toEqual([
    ['t', ['during outage', 'after!'], 0],
    ['u', ['short-lived'], 3],
  ]);
});

it('a record its retirement could not remove stays retired', () => {
  const authority = make();
  authority.attribute({
    terminalId: 'old',
    client,
    session: session('old'),
    persist: true,
  });
  authority.flushSync();
  const original = fs.rmSync;
  const spy = jest.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
    if (path === recordFile())
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    original(path, options);
  });
  expect(() =>
    authority.retire({ projectId: 'proj', worktreeId: 'wt' }),
  ).toThrow();
  spy.mockRestore();
  expect(existsSync(recordFile())).toBe(true);
  const opened = make().open(client);
  expect(opened.generation).toBe(2);
  expect(opened.terminals).toEqual([]);
});

it('session commands as long as a terminal accepts persist, and every legacy session reads', () => {
  const command = 'x'.repeat(64 * 1024);
  expect(
    WorkerTerminalRecordApplyParamsSchema.safeParse({
      client,
      producer: { id: 'electron_main', runId: 'r' },
      seq: 1,
      ops: [
        {
          op: 'session.upsert',
          session: session('long', { initialCommand: command }),
        },
      ],
    }).success,
  ).toBe(true);
  // Main's legacy state holds longer values, and fields the schema does
  // not know.
  const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
  mkdirSync(join(legacy, '..'), { recursive: true });
  writeFileSync(
    legacy,
    JSON.stringify({
      version: 2,
      lineage: 'L',
      bindings: [],
      terminals: [
        {
          session: {
            ...session('legacy'),
            initialCommand: `${command}more`,
            title: 't'.repeat(70_000),
            kind: 'retired-kind',
            pid: 42,
          },
          scrollbackLines: ['kept'],
          exitCode: null,
          signal: null,
        },
      ],
      terminalCustomNames: { legacy: 'n'.repeat(80) },
    }),
  );
  const opened = make().open(client);
  const parsed = WorkerTerminalRecordOpenResultSchema.safeParse(opened);
  expect(parsed.success).toBe(true);
  expect(opened.terminals[0].session).toMatchObject({
    id: 'legacy',
    initialCommand: `${command}more`,
  });
  expect(opened.terminals[0].session).not.toHaveProperty('kind');
  expect(opened.terminals[0].session).not.toHaveProperty('pid');
});

function failReads(code = 'EIO'): () => void {
  const original = fs.readFileSync;
  const spy = jest
    .spyOn(fs, 'readFileSync')
    .mockImplementation((path, options) => {
      if (path === recordFile()) throw Object.assign(new Error('io'), { code });
      return original(path, options);
    });
  return () => spy.mockRestore();
}

describe('held host reports never announce a successor lifetime', () => {
  afterEach(() => jest.useRealTimers());

  it.each(['read', 'exit', 'shutdown', 'timer'])(
    '%s replay persists eligible held output without reviving the retired lifetime',
    (trigger) => {
      jest.useFakeTimers();
      make().open(client);
      const authority = make();
      const restore = failReads('EACCES');
      authority.attribute({
        terminalId: 'held',
        client,
        session: session('held'),
        persist: true,
      });
      authority.output('held', Buffer.from('stale output'));
      const next = { ...client, incarnation: 'inc-2', generation: 2 };
      authority.attribute({
        terminalId: 'eligible',
        client: next,
        session: session('eligible'),
        persist: true,
      });
      authority.output('eligible', Buffer.from('eligible output'));
      // The exit is buffered too, since its immediate replay still cannot read.
      authority.exited('held', 1, null);
      restore();
      jest.setSystemTime(Date.now() + 1);
      const successor = make();
      successor.attribute({
        terminalId: 'new',
        client: { ...client, incarnation: 'inc-2' },
        session: session('new'),
        persist: true,
      });
      successor.output('new', Buffer.from('kept'));
      successor.exited('new', 0, null);
      successor.flushSync();
      const before = record();
      expect(before).toMatchObject({ generation: 2, incarnation: 'inc-2' });
      if (trigger === 'exit') authority.exited('held', 2, null);
      else if (trigger === 'shutdown') authority.shutdown('app-quit');
      else if (trigger === 'timer') jest.advanceTimersByTime(1_000);
      else authority.historyRead({ client: next, terminalId: 'new' });
      // No history/open call may mask a broken exit, shutdown or timer trigger.
      authority.flushSync();
      const replayed = record();
      expect(
        replayed.record.terminals.map((entry) => entry.session.id),
      ).toEqual(['new', 'eligible']);
      expect(replayed.record.terminals[1]).toMatchObject({
        scrollbackLines: ['eligible output'],
        signal: trigger === 'shutdown' ? 'app-quit' : null,
      });
      expect(authority.isAttributed('held')).toBe(false);
      expect(
        authority.historyRead({ client: next, terminalId: 'new' }).text,
      ).toBe('kept');
      authority.output('held', Buffer.from('late output'));
      authority.exited('held', 3, null);
      authority.flushSync();
      expect(authority.isAttributed('held')).toBe(false);
      expect(record()).toEqual(replayed);
    },
  );

  it.each(['inc-1', null])(
    'an unreadable generation cannot rejoin a later lifetime with incarnation %s',
    (incarnation) => {
      make().open(client);
      const authority = make();
      const restore = failReads();
      const heldClient = { ...client, incarnation };
      authority.attribute({
        terminalId: 'held',
        client: heldClient,
        session: session('held'),
        persist: true,
      });
      authority.output('held', Buffer.from('stale'));
      restore();
      authority.attribute({
        terminalId: 'middle',
        client: { ...client, incarnation: 'inc-2' },
        session: session('middle'),
        persist: true,
      });
      // Split/join can reuse the original incarnation; null is not an identity either.
      authority.attribute({
        terminalId: 'new',
        client,
        session: session('new'),
        persist: true,
      });
      authority.output('new', Buffer.from('kept'));
      authority.flushSync();
      expect(record().generation).toBe(3);
      expect(authority.historyRead({ client, terminalId: 'new' }).text).toBe(
        'kept',
      );
      expect(authority.isAttributed('held')).toBe(false);
      expect(
        authority.open(client).terminals.map((entry) => entry.session.id),
      ).toEqual(['new']);
      authority.flushSync();
    },
  );

  it('retiring an earlier generation keeps a newer held attribution of the same incarnation', () => {
    make().open(client);
    const authority = make();
    const restore = failReads();
    const next = { ...client, generation: 2 };
    authority.attribute({
      terminalId: 't',
      client: next,
      session: session('t'),
      persist: true,
    });
    authority.output('t', Buffer.from('kept'));
    restore();
    authority.retire({ projectId: 'proj', worktreeId: 'wt', generation: 1 });
    expect(authority.historyRead({ client: next, terminalId: 't' }).text).toBe(
      'kept',
    );
    authority.flushSync();
    expect(record().generation).toBe(2);
  });

  it('a partially successful retirement cannot resurrect its held reports behind the tombstone', () => {
    make().open(client);
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (): void => undefined,
    });
    const authority = new TerminalRecordAuthority({ repository });
    const restore = failReads();
    authority.attribute({
      terminalId: 'old',
      client,
      session: session('old'),
      persist: true,
    });
    authority.output('old', Buffer.from('stale'));
    restore();
    const retire = repository.retire.bind(repository);
    const retiring = jest
      .spyOn(repository, 'retire')
      .mockImplementationOnce((...args) => {
        retire.call(repository, ...args);
        throw Object.assign(new Error('interrupted'), { code: 'EIO' });
      });
    const next = { ...client, incarnation: 'inc-2' };
    authority.attribute({
      terminalId: 'new',
      client: next,
      session: session('new'),
      persist: true,
    });
    authority.output('new', Buffer.from('kept'));
    retiring.mockRestore();
    expect(
      authority.historyRead({ client: next, terminalId: 'new' }).text,
    ).toBe('kept');
    authority.flushSync();
    expect(record()).toMatchObject({ generation: 2, incarnation: 'inc-2' });
    expect(record().record.terminals.map((entry) => entry.session.id)).toEqual([
      'new',
    ]);
  });

  it.each(['completed', 'before tombstone', 'after tombstone'])(
    'a %s retirement cannot revive reports superseded by a different local lifetime',
    (outcome) => {
      const previous = make();
      previous.open(client);
      previous.open({ ...client, incarnation: 'inc-2' });
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      const authority = new TerminalRecordAuthority({ repository });
      const restore = failReads('EACCES');
      authority.attribute({
        terminalId: 'held',
        client,
        session: session('held'),
        persist: true,
      });
      authority.output('held', Buffer.from('stale'));
      restore();
      const next = { ...client, incarnation: 'inc-3' };
      authority.attribute({
        terminalId: 'new',
        client: next,
        session: session('new'),
        persist: true,
      });
      authority.output('new', Buffer.from('kept'));
      authority.flushSync();
      expect(record()).toMatchObject({ generation: 3, incarnation: 'inc-3' });
      const retire = repository.retire.bind(repository);
      const retiring = jest
        .spyOn(repository, 'retire')
        .mockImplementation((...args) => {
          if (outcome === 'before tombstone') throw new Error('interrupted');
          retire.call(repository, ...args);
          if (outcome === 'after tombstone') throw new Error('interrupted');
        });
      const params = {
        projectId: 'proj',
        worktreeId: 'wt',
        incarnation: next.incarnation,
      };
      if (outcome === 'completed')
        expect(authority.retire(params)).toEqual({ retired: 1 });
      else expect(() => authority.retire(params)).toThrow('interrupted');
      retiring.mockRestore();
      expect(
        authority.historyRead({ client: next, terminalId: 'held' }).text,
      ).toBe('');
      expect(authority.isAttributed('held')).toBe(false);
      authority.flushSync();
      if (outcome === 'before tombstone') {
        expect(record()).toMatchObject({ generation: 3, incarnation: 'inc-3' });
        expect(
          record().record.terminals.map((entry) => entry.session.id),
        ).toEqual(['new']);
        expect(
          authority.historyRead({ client: next, terminalId: 'new' }).text,
        ).toBe('kept');
      } else
        expect(repository.load('proj', 'wt')).toMatchObject({
          kind: 'absent',
          tombstone: { generation: 3 },
        });
    },
  );

  it('recreating the same terminal id never carries output from a superseded lifetime', () => {
    make().open(client);
    const authority = make();
    const restore = failReads();
    authority.attribute({
      terminalId: 't',
      client,
      session: session('t'),
      persist: true,
    });
    authority.output('t', Buffer.from('stale'));
    restore();
    const next = { ...client, incarnation: 'inc-2' };
    authority.attribute({
      terminalId: 't',
      client: next,
      session: session('t'),
      persist: true,
    });
    authority.output('t', Buffer.from('kept'));
    expect(authority.historyRead({ client: next, terminalId: 't' }).text).toBe(
      'kept',
    );
    authority.flushSync();
  });

  it('a transient read failure still replays into an unchanged later generation', () => {
    const previous = make();
    previous.open(client);
    const next = { ...client, incarnation: 'inc-2' };
    previous.open(next);
    const authority = make();
    const restore = failReads();
    authority.attribute({
      terminalId: 't',
      client: next,
      session: session('t'),
      persist: true,
    });
    authority.output('t', Buffer.from('kept'));
    authority.exited('t', 7, null);
    restore();
    expect(authority.historyRead({ client: next, terminalId: 't' }).text).toBe(
      'kept',
    );
    expect(authority.open(next).terminals[0].exitCode).toBe(7);
    authority.flushSync();
    expect(record().generation).toBe(2);
  });

  it.each([1, 3])(
    'a held explicit generation %s retains non-older admission without retagging',
    (generation) => {
      make().open(client);
      const authority = make();
      const restore = failReads();
      authority.attribute({
        terminalId: 't',
        client: { ...client, incarnation: 'inc-2', generation },
        session: session('t'),
        persist: true,
      });
      authority.output('t', Buffer.from('kept'));
      restore();
      expect(authority.historyRead({ client, terminalId: 't' }).text).toBe(
        'kept',
      );
      authority.flushSync();
      expect(record()).toMatchObject({ generation: 1, incarnation: 'inc-1' });
    },
  );

  it('a held attribution snapshots the client rather than following later mutation', () => {
    make().open(client);
    const authority = make();
    const mutable = { ...client };
    const restore = failReads();
    authority.attribute({
      terminalId: 'held',
      client: mutable,
      session: session('held'),
      persist: true,
    });
    restore();
    mutable.incarnation = 'inc-2';
    authority.attribute({
      terminalId: 'new',
      client: mutable,
      session: session('new'),
      persist: true,
    });
    authority.output('new', Buffer.from('kept'));
    expect(
      authority.historyRead({ client: mutable, terminalId: 'new' }).text,
    ).toBe('kept');
    expect(authority.isAttributed('held')).toBe(false);
    authority.flushSync();
  });

  it.each(['inc-1', null])(
    'a read failure after retirement still starts the intended lifetime (%s)',
    (incarnation) => {
      jest.useFakeTimers();
      jest.setSystemTime(1_800_000_000_000);
      const previous = make();
      previous.open(client);
      previous.retire({ projectId: 'proj', worktreeId: 'wt' });
      jest.setSystemTime(Date.now() + 1);
      const authority = make();
      const restore = failReads();
      const next = { ...client, incarnation };
      authority.attribute({
        terminalId: 't',
        client: next,
        session: session('t'),
        persist: true,
      });
      authority.output('t', Buffer.from('kept'));
      restore();
      expect(
        authority.historyRead({ client: next, terminalId: 't' }).text,
      ).toBe('kept');
      authority.flushSync();
      expect(record().generation).toBe(2);
    },
  );

  it('pending imports, install retries and late host reports remain bound to the retired scope', () => {
    jest.useFakeTimers();
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (): void => undefined,
    });
    const importing = jest
      .spyOn(repository, 'importLegacy')
      .mockImplementation(() => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      });
    const saving = jest.spyOn(repository, 'save').mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    const authority = new TerminalRecordAuthority({ repository });
    authority.attribute({
      terminalId: 'old',
      client,
      session: session('old'),
      persist: true,
    });
    authority.output('old', Buffer.from('stale'));
    expect(importing).toHaveBeenCalledTimes(1);
    saving.mockRestore();
    const next = { ...client, incarnation: 'inc-2' };
    authority.attribute({
      terminalId: 'new',
      client: next,
      session: session('new'),
      persist: true,
    });
    authority.output('new', Buffer.from('kept'));
    authority.flushSync();
    const before = record();
    expect(authority.open({ ...client, generation: 1 }).terminals).toEqual([]);
    authority.output('old', Buffer.from('late output'));
    authority.exited('old', 1, null);
    jest.advanceTimersByTime(1_000);
    authority.flushSync();
    expect(record()).toEqual(before);
    expect(importing).toHaveBeenCalledTimes(1);
    expect(
      authority.historyRead({ client: next, terminalId: 'new' }).text,
    ).toBe('kept');
  });
});

it('a restore recreating a waiting terminal keeps its earlier output', () => {
  make().open(client);
  const authority = make();
  const restore = failReads();
  authority.attribute({
    terminalId: 't',
    client,
    session: session('t'),
    persist: true,
  });
  authority.output('t', Buffer.from('first life\n'));
  authority.exited('t', 1, null);
  // Recreated while its record still cannot be read.
  authority.attribute({
    terminalId: 't',
    client,
    session: session('t'),
    persist: true,
  });
  authority.output('t', Buffer.from('second'));
  restore();
  const history = authority.historyRead({ client, terminalId: 't' });
  authority.flushSync();
  expect(history.text).toBe('first life\nsecond');
});

it('retiring the old incarnation keeps a newer incarnation waiting', () => {
  const old = make();
  old.attribute({
    terminalId: 'o',
    client,
    session: session('o'),
    persist: true,
  });
  old.flushSync();
  const authority = make();
  const restore = failReads();
  const next = { ...client, incarnation: 'inc-2' };
  authority.attribute({
    terminalId: 'n',
    client: next,
    session: session('n'),
    persist: true,
  });
  authority.output('n', Buffer.from('newer'));
  restore();
  authority.retire({
    projectId: 'proj',
    worktreeId: 'wt',
    incarnation: 'inc-1',
  });
  expect(authority.historyRead({ client: next, terminalId: 'n' }).text).toBe(
    'newer',
  );
  authority.flushSync();
  expect(record().record.terminals.map((t) => t.session.id)).toEqual(['n']);
});

describe('lifetimes are ordered by generation; stale requests change nothing', () => {
  const reused = { ...client, incarnation: 'inc-2' };
  const producer = { id: 'electron_main', runId: 'r1' };
  // The first incarnation's record, then the id reused: generation 2.
  const reuse = (): TerminalRecordAuthority => {
    const first = make();
    first.attribute({
      terminalId: 'old',
      client,
      session: session('old'),
      persist: true,
    });
    first.flushSync();
    const authority = make();
    authority.attribute({
      terminalId: 'new',
      client: reused,
      session: session('new'),
      persist: true,
    });
    authority.output('new', Buffer.from('kept'));
    authority.flushSync();
    expect(record()).toMatchObject({ generation: 2, incarnation: 'inc-2' });
    return authority;
  };
  const unchanged = (authority: TerminalRecordAuthority): void => {
    authority.flushSync();
    expect(record()).toMatchObject({ generation: 2, incarnation: 'inc-2' });
    expect(record().record.terminals.map((t) => t.session.id)).toEqual(['new']);
    expect(authority.isAttributed('new')).toBe(true);
    expect(
      authority.historyRead({ client: reused, terminalId: 'new' }).text,
    ).toBe('kept');
  };

  it('a stale open sees an empty record of its own generation', () => {
    const authority = reuse();
    const stale = authority.open({ ...client, generation: 1 });
    expect(stale.generation).toBe(1);
    expect(stale.terminals).toEqual([]);
    unchanged(authority);
  });

  it('a stale-generation open confirms no import; the current open does (R40)', () => {
    const authority = reuse();
    expect(authority.open({ ...client, generation: 1 }).import).toEqual({
      from: 'none',
      sourceSha256: null,
      pending: true,
    });
    const current = authority.open(reused);
    expect(current.generation).toBe(2);
    expect(current.import.pending).toBeUndefined();
    unchanged(authority);
  });

  it.each(['cached', 'reloaded'] as const)(
    'stale opens behind a %s generation fence confirm no import (R40)',
    (state): void => {
      const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
      mkdirSync(dirname(legacy), { recursive: true });
      writeFileSync(
        legacy,
        JSON.stringify({
          version: 2,
          lineage: 'fenced-legacy',
          bindings: [],
          terminalCustomNames: {},
          terminals: [
            {
              session: session('t'),
              scrollbackLines: ['legacy history'],
              exitCode: null,
              signal: null,
            },
          ],
        }),
      );
      const retiring = make();
      const imported = retiring.open({ ...client, lifetimeId: 'a' });
      expect(imported.import.from).toBe('v2');
      expect(imported.import.pending).toBeUndefined();
      expect(
        retiring.retire({
          projectId: 'proj',
          worktreeId: 'wt',
          generation: 1,
          lifetimeIds: ['a'],
        }),
      ).toEqual({ retired: 1 });
      if (state === 'reloaded') retiring.dispose();
      const authority = state === 'cached' ? retiring : make();
      const stale = { from: 'none', sourceSha256: null, pending: true };
      // The fenced generation itself, and a retired lifetime that omits it.
      expect(authority.open({ ...client, generation: 1 }).import).toEqual(
        stale,
      );
      expect(authority.open({ ...client, lifetimeId: 'a' }).import).toEqual(
        stale,
      );
      // Behind a tombstone the successor never imports, so its decision settles.
      const successor = authority.open({ ...client, lifetimeId: 'b' });
      expect(successor.generation).toBe(2);
      expect(successor.import).toEqual({ from: 'none', sourceSha256: null });
    },
  );

  it('a delayed history read of an older incarnation never retires the newer record (R4-F1)', () => {
    const authority = reuse();
    expect(authority.historyRead({ client, terminalId: 'new' }).text).toBe('');
    expect(
      authority.historyRead({
        client: { ...client, generation: 1 },
        terminalId: 'new',
      }).text,
    ).toBe('');
    unchanged(authority);
    // Nor does it after a daemon restart, with the record read from disk.
    const restarted = make();
    expect(restarted.historyRead({ client, terminalId: 'new' }).text).toBe('');
    expect(record()).toMatchObject({ generation: 2, incarnation: 'inc-2' });
  });

  it('a history tail of an older incarnation is empty and changes nothing', () => {
    const authority = reuse();
    expect(authority.historyTail(client, 'new', 100)).toBe('');
    unchanged(authority);
  });

  it('an older lifetime terminal runs unattributed, now or held for a retry', () => {
    const authority = reuse();
    authority.attribute({
      terminalId: 'late',
      client: { ...client, generation: 1 },
      session: session('late'),
      persist: true,
    });
    authority.output('late', Buffer.from('stale'));
    expect(authority.isAttributed('late')).toBe(false);
    unchanged(authority);
    // Held while the record cannot be read, then dropped on its retry.
    const restore = failReads();
    const held = make();
    held.attribute({
      terminalId: 'held',
      client: { ...client, generation: 1 },
      session: session('held'),
      persist: true,
    });
    held.output('held', Buffer.from('stale'));
    restore();
    expect(held.historyRead({ client: reused, terminalId: 'new' }).text).toBe(
      'kept',
    );
    expect(held.isAttributed('held')).toBe(false);
    held.flushSync();
    expect(record().record.terminals.map((t) => t.session.id)).toEqual(['new']);
  });

  it('a stale apply after a retirement is dropped and creates no record', () => {
    const authority = make();
    authority.apply({
      client,
      producer,
      seq: 1,
      ops: [{ op: 'session.upsert', session: session('p') }],
    });
    authority.retire({ projectId: 'proj', worktreeId: 'wt' });
    expect(
      authority.apply({
        client,
        producer,
        seq: 2,
        generation: 1,
        ops: [{ op: 'session.upsert', session: session('q') }],
      }),
    ).toMatchObject({ outcome: 'dropped', generation: 1 });
    expect(authority.historyRead({ client, terminalId: 'p' }).text).toBe('');
    expect(existsSync(recordFile())).toBe(false);
  });

  it('the same incarnation after a retirement starts a record that keeps its writes', () => {
    // A split or join copies the creation time: the incarnation recurs.
    const authority = make();
    authority.apply({
      client,
      producer,
      seq: 1,
      ops: [{ op: 'session.upsert', session: session('p') }],
    });
    authority.retire({
      projectId: 'proj',
      worktreeId: 'wt',
      incarnation: 'inc-1',
    });
    expect(authority.open(client).generation).toBe(2);
    expect(
      authority.apply({
        client,
        producer: { id: 'electron_main', runId: 'r2' },
        seq: 1,
        ops: [{ op: 'session.upsert', session: session('q') }],
      }).outcome,
    ).toBe('applied');
    expect(
      make()
        .open(client)
        .terminals.map((t) => t.session.id),
    ).toEqual(['q']);
  });

  it('another incarnation at the current generation is applied, never retired or retagged', () => {
    const authority = make();
    authority.apply({
      client,
      producer,
      seq: 1,
      ops: [{ op: 'session.upsert', session: session('p') }],
    });
    expect(
      authority.apply({
        client: reused,
        producer,
        seq: 2,
        generation: 1,
        ops: [{ op: 'session.upsert', session: session('q') }],
      }).outcome,
    ).toBe('applied');
    expect(record()).toMatchObject({ generation: 1, incarnation: 'inc-1' });
    expect(record().record.terminals.map((t) => t.session.id)).toEqual([
      'p',
      'q',
    ]);
  });

  it('a retirement asked for before a newer record started leaves it', () => {
    const before = Date.now() - 1_000;
    const authority = make();
    authority.attribute({
      terminalId: 'n',
      client: { ...client, incarnation: null },
      session: session('n'),
      persist: true,
    });
    authority.flushSync();
    expect(
      authority.retire({
        projectId: 'proj',
        worktreeId: 'wt',
        requestedAt: before,
      }).retired,
    ).toBe(0);
    expect(
      authority.retire({ projectId: 'proj', requestedAt: before }).retired,
    ).toBe(0);
    expect(authority.isAttributed('n')).toBe(true);
    expect(record().record.terminals.map((t) => t.session.id)).toEqual(['n']);
    // One asked for since retires it.
    expect(
      authority.retire({
        projectId: 'proj',
        worktreeId: 'wt',
        requestedAt: Date.now() + 1_000,
      }).retired,
    ).toBe(1);
    expect(existsSync(recordFile())).toBe(false);
  });

  it('a damaged tombstone keeps late writers stale and never hides a record', () => {
    const dir = terminalRecordDir(root, 'proj', 'wt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tombstone.json'), '{damaged');
    const authority = make();
    const opened = authority.open(client);
    expect(opened.generation).toBeGreaterThan(4);
    expect(
      authority.apply({
        client,
        producer,
        seq: 1,
        generation: 4,
        ops: [{ op: 'session.upsert', session: session('stale') }],
      }).outcome,
    ).toBe('dropped');
    // Every load agrees on the floor.
    expect(make().open(client).generation).toBe(opened.generation);
    // A record that parses beats the damaged tombstone beside it.
    rmSync(dir, { recursive: true, force: true });
    const live = make();
    live.apply({
      client,
      producer,
      seq: 1,
      ops: [{ op: 'session.upsert', session: session('kept') }],
    });
    writeFileSync(join(dir, 'tombstone.json'), '{damaged');
    expect(
      make()
        .open(client)
        .terminals.map((t) => t.session.id),
    ).toEqual(['kept']);
  });
});

it.each(['x', '🙂'])(
  'bounds host output by per-line and total UTF-8 bytes (%s)',
  (character) => {
    const authority = make();
    authority.attribute({
      terminalId: 'bounded',
      client,
      session: session('bounded'),
      persist: true,
    });
    const chunk = Buffer.from(character.repeat(16384));
    for (let line = 0; line < 6; line += 1) {
      for (let part = 0; part < 70; part += 1)
        authority.output('bounded', chunk);
      authority.output('bounded', Buffer.from('\n'));
    }
    authority.flushSync();
    const lines = record().record.terminals[0]?.scrollbackLines ?? [];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => Buffer.byteLength(line) <= 1024 * 1024)).toBe(
      true,
    );
    expect(Buffer.byteLength(lines.join('\n'))).toBeLessThanOrEqual(
      4 * 1024 * 1024,
    );
    expect(lines.join('\n')).not.toContain('�');
    expect(lines.join('\n')).toContain(character);
  },
);

it('replacement writes share host byte retention, including empty history', () => {
  const authority = make();
  authority.apply({
    client,
    producer: { id: 'electron_main', runId: 'bounded' },
    seq: 1,
    ops: [
      { op: 'session.upsert', session: session('bounded') },
      {
        op: 'output.replace',
        terminalId: 'bounded',
        lines: Array.from({ length: 6 }, () => '🙂'.repeat(262144)),
      },
    ],
  });
  const lines = record().record.terminals[0]?.scrollbackLines ?? [];
  expect(Buffer.byteLength(lines.join('\n'))).toBeLessThanOrEqual(
    4 * 1024 * 1024,
  );
  expect(lines.join('\n')).not.toContain('�');
  authority.apply({
    client,
    producer: { id: 'electron_main', runId: 'bounded' },
    seq: 2,
    ops: [
      { op: 'output.replace', terminalId: 'bounded', lines: [] },
      { op: 'output.append', terminalId: 'bounded', text: '' },
    ],
  });
  expect(record().record.terminals[0]?.scrollbackLines).toEqual([]);
});

it('open makes new host content durable before a reader can fence it', () => {
  const authority = make();
  authority.open(client);
  authority.attribute({
    terminalId: 'before-fence',
    client,
    session: session('before-fence'),
    persist: true,
  });
  // The debounce has not fired, and an empty record was already installed.
  expect(record().record.terminals).toEqual([]);
  const opened = authority.open(client);
  expect(opened.terminals.map((entry) => entry.session.id)).toEqual([
    'before-fence',
  ]);
  expect(record().record.terminals.map((entry) => entry.session.id)).toEqual([
    'before-fence',
  ]);
});

it('a later failed install does not hide already durable terminal history', () => {
  const authority = make();
  authority.attribute({
    terminalId: 'retained',
    client,
    session: session('retained'),
    persist: true,
  });
  authority.output('retained', Buffer.from('durable history'));
  authority.flushSync();
  const saving = jest
    .spyOn(TerminalRecordRepository.prototype, 'save')
    .mockImplementation(() => {
      throw new Error('install blocked');
    });
  authority.output('retained', Buffer.from(' and pending'));
  expect(
    authority.open(client).terminals.map((entry) => entry.session.id),
  ).toEqual(['retained']);
  expect(authority.historyRead({ client, terminalId: 'retained' }).text).toBe(
    'durable history and pending',
  );
  saving.mockRestore();
  authority.flushSync();
});

it('an empty durable record cannot authorize fencing failed first host content', () => {
  const authority = make();
  authority.open(client);
  const saving = jest
    .spyOn(TerminalRecordRepository.prototype, 'save')
    .mockImplementation(() => {
      throw new Error('install blocked');
    });
  authority.attribute({
    terminalId: 'first',
    client,
    session: session('first'),
    persist: true,
  });
  expect(() => authority.open(client)).toThrow('could not be installed');
  expect(record().record.terminals).toEqual([]);
  saving.mockRestore();
  expect(
    authority.open(client).terminals.map((entry) => entry.session.id),
  ).toEqual(['first']);
});

it('retirement erases damaged recovery content and leaves only the tombstone', () => {
  const authority = make();
  const source = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
  mkdirSync(join(source, '..'), { recursive: true });
  writeFileSync(source, 'damaged legacy secret');
  authority.open(client);
  authority.flushSync();
  const directory = terminalRecordDir(root, 'proj', 'wt');
  writeFileSync(recordFile(), 'damaged record secret');
  const recovered = make();
  recovered.open(client);
  recovered.flushSync();
  expect(
    fs.readdirSync(directory).some((name) => name.includes('.damaged-')),
  ).toBe(true);
  recovered.retire({ projectId: 'proj', worktreeId: 'wt' });
  expect(fs.readdirSync(directory)).toEqual(['tombstone.json']);
});

it('worker.terminal.record.apply keeps acknowledged history through setTimeout install retries', () => {
  jest.useFakeTimers();
  try {
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (): void => undefined,
    });
    const authority = new TerminalRecordAuthority({
      repository,
      installDebounceMs: 1,
    });
    const batch = WorkerTerminalRecordApplyParamsSchema.parse({
      client,
      producer: { id: 'electron_main', runId: 'timers' },
      seq: 1,
      ops: [
        { op: 'session.upsert', session: session('timed') },
        { op: 'output.append', terminalId: 'timed', text: 'acknowledged' },
      ],
    });
    expect(authority.apply(batch).outcome).toBe('applied');
    authority.attribute({
      terminalId: 'timed',
      client,
      session: session('timed'),
      persist: true,
    });
    authority.output('timed', Buffer.from(' and deferred'));
    const saving = jest.spyOn(repository, 'save').mockImplementationOnce(() => {
      throw new Error('install blocked');
    });
    jest.advanceTimersByTime(1);
    expect(saving).toHaveBeenCalledTimes(1);
    expect(record().record.terminals[0]?.scrollbackLines).toEqual([
      'acknowledged',
    ]);
    expect(record().producerWatermarks).toEqual({ 'electron_main/timers': 1 });
    jest.advanceTimersByTime(1_000);
    expect(saving).toHaveBeenCalledTimes(2);
    expect(record().record.terminals[0]?.scrollbackLines).toEqual([
      'acknowledged and deferred',
    ]);
    const restarted = make();
    expect(restarted.apply(batch).outcome).toBe('duplicate');
    expect(restarted.historyRead({ client, terminalId: 'timed' }).text).toBe(
      'acknowledged and deferred',
    );
  } finally {
    jest.useRealTimers();
  }
});

describe('R7 publication and lifetime fault matrix', () => {
  it('R7 invariant host chunks neither clone publication snapshots nor sync, and working changes leave receipts isolated', () => {
    jest.useFakeTimers();
    try {
      const sync = jest.fn();
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: sync,
      });
      const save = repository.save.bind(repository);
      const images: TerminalRecordEnvelope[] = [];
      jest.spyOn(repository, 'save').mockImplementation((image) => {
        images.push(image);
        save(image);
      });
      const authority = new TerminalRecordAuthority({ repository });
      authority.attribute({
        terminalId: 'hot-output',
        client,
        session: session('hot-output'),
        persist: true,
      });
      authority.flushSync();
      const committed = images.at(-1);
      if (!committed) throw new Error('Expected a published record');
      const cloning = jest.spyOn(globalThis, 'structuredClone');
      const confirmed = sync.mock.calls.length;
      for (let chunk = 0; chunk < 32; chunk += 1)
        authority.output('hot-output', Buffer.from('x'));
      authority.exited('hot-output', 0, 'user-close');
      expect(cloning).not.toHaveBeenCalled();
      expect(sync).toHaveBeenCalledTimes(confirmed);
      expect(committed.record.terminals[0]).toMatchObject({
        scrollbackLines: [],
        exitCode: null,
        signal: null,
      });
      authority.flushSync();
      expect(cloning).toHaveBeenCalledTimes(1);
      expect(record().record.terminals[0]).toMatchObject({
        scrollbackLines: ['x'.repeat(32)],
        exitCode: 0,
        signal: 'user-close',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('R7 F4 empty shutdown and flush claim no stamps and create no storage', () => {
    const authority = make();
    expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
    expect(() => authority.flushSync()).not.toThrow();
    expect(existsSync(recordFile())).toBe(false);
  });
  it('R7 F4 a durable forget cancels an unsaved shutdown obligation without claiming a stamp', () => {
    const authority = make();
    authority.attribute({
      terminalId: 'forgotten-quit',
      client,
      session: session('forgotten-quit'),
      persist: true,
    });
    authority.flushSync();
    const saving = jest
      .spyOn(TerminalRecordRepository.prototype, 'save')
      .mockImplementationOnce(() => {
        throw new Error('stamp blocked');
      });
    expect(() => authority.shutdown('app-quit')).toThrow('flush failed');
    saving.mockRestore();
    authority.apply({
      client,
      producer: { id: 'forget', runId: 'quit' },
      seq: 1,
      ops: [{ op: 'forget', terminalId: 'forgotten-quit' }],
    });
    expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
    expect(record().record.terminals).toEqual([]);
  });
  it.each(['same owner', 'fresh owner'])(
    'R7 F1 F2 a same-incarnation successor resumes its retired intent (%s)',
    (recovery) => {
      const directory = terminalRecordDir(root, 'proj', 'wt');
      let blocked = false;
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (path): void => {
          if (blocked && path === directory)
            throw new Error('fence sync blocked');
        },
      });
      let authority = new TerminalRecordAuthority({ repository });
      authority.open(client);
      blocked = true;
      expect(() =>
        authority.retire({
          projectId: 'proj',
          worktreeId: 'wt',
          generation: 1,
        }),
      ).toThrow('outcome unknown');
      if (recovery === 'fresh owner')
        authority = new TerminalRecordAuthority({ repository });
      authority.attribute({
        terminalId: 'reused',
        client,
        session: session('reused'),
        persist: true,
      });
      authority.output('reused', Buffer.from('same incarnation, new lifetime'));
      expect(() =>
        authority.apply({
          client,
          generation: 1,
          producer: { id: 'late', runId: 'same-inc' },
          seq: 1,
          ops: [],
        }),
      ).toThrow('fence sync blocked');
      blocked = false;
      expect(
        authority.retire({
          projectId: 'proj',
          worktreeId: 'wt',
          generation: 1,
        }),
      ).toEqual({ retired: 1 });
      expect(authority.open(client).generation).toBe(2);
      authority.flushSync();
      expect(make().historyRead({ client, terminalId: 'reused' }).text).toBe(
        'same incarnation, new lifetime',
      );
    },
  );

  it.each(
    ['before rename', 'after rename', 'cleanup'].flatMap((stage) =>
      ['attribution', 'explicit retirement'].flatMap((trigger) =>
        ['same owner', 'fresh owner'].map((recovery) => ({
          stage,
          trigger,
          recovery,
        })),
      ),
    ),
  )(
    'R7 F1 F2 successor survives $stage via $trigger and $recovery',
    ({ stage, trigger, recovery }) => {
      const directory = terminalRecordDir(root, 'proj', 'wt');
      const tombstone = join(directory, 'tombstone.json');
      let blocked = false;
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (path): void => {
          if (blocked && stage === 'after rename' && path === directory)
            throw new Error('fence sync blocked');
        },
      });
      const authority = new TerminalRecordAuthority({ repository });
      const old = { ...client, lifetimeId: 'old-lifetime' };
      const next = {
        ...client,
        incarnation: 'inc-2',
        lifetimeId: 'new-lifetime',
      };
      authority.open(old);
      const rename = fs.renameSync;
      jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (blocked && stage === 'before rename' && to === tombstone)
          throw new Error('fence rename blocked');
        rename(from, to);
      });
      const remove = fs.rmSync;
      jest.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
        if (blocked && stage === 'cleanup' && path === recordFile())
          throw new Error('cleanup blocked');
        remove(path, options);
      });
      blocked = true;
      if (trigger === 'explicit retirement')
        expect(() =>
          authority.retire({
            projectId: 'proj',
            worktreeId: 'wt',
            generation: 1,
          }),
        ).toThrow();
      authority.attribute({
        terminalId: 'successor',
        client: next,
        session: session('successor'),
        persist: true,
      });
      authority.output('successor', Buffer.from('held successor history'));
      const reader =
        recovery === 'fresh owner'
          ? new TerminalRecordAuthority({ repository })
          : authority;
      const late = {
        client: old,
        generation: 1,
        producer: { id: 'late', runId: 'run' },
        seq: 1,
        ops: [],
      };
      if (stage === 'after rename') {
        // Neither a same-process fence nor its recovered visibility releases replay.
        expect(() => reader.apply(late)).toThrow('fence sync blocked');
        expect(existsSync(recordFile())).toBe(true);
        expect(
          reader.historyRead({ client: old, terminalId: 'successor' }).text,
        ).toBe('');
      } else if (stage === 'cleanup')
        expect(reader.apply(late).outcome).toBe('dropped');
      else expect(reader.apply(late).outcome).toBe('applied');
      authority.output('successor', Buffer.from('\nafter late batch'));
      if (stage === 'cleanup')
        expect(authority.shutdown('app-quit')).toEqual({ stamped: 1 });
      else
        expect(() => authority.shutdown('app-quit')).toThrow(
          'unresolved attributions',
        );
      // An ordinary exit while the fence is unavailable must not erase the
      // pending shutdown intent or route its tail into the predecessor.
      authority.exited('successor', 0, null);
      blocked = false;
      const expectedHistory = 'held successor history\nafter late batch';
      const history = authority.historyRead({
        client: next,
        terminalId: 'successor',
      });
      authority.flushSync();
      expect(history.text).toBe(expectedHistory);
      expect(authority.shutdown('app-quit')).toEqual({
        stamped: stage === 'cleanup' ? 0 : 1,
      });
      expect(authority.open(next)).toMatchObject({
        generation: 2,
        import: { from: 'none' },
      });
      expect(
        authority.historyRead({ client: next, terminalId: 'successor' }).text,
      ).toBe(expectedHistory);
      const reloaded = make();
      expect(reloaded.open(next).generation).toBe(2);
      expect(reloaded.open(next).terminals[0]?.signal).toBe('app-quit');
      expect(
        reloaded.historyRead({ client: next, terminalId: 'successor' }).text,
      ).toBe(expectedHistory);
      expect(reloaded.apply(late).outcome).toBe('dropped');
      expect(
        authority.retire({
          projectId: 'proj',
          worktreeId: 'wt',
          lifetimeIds: ['old-lifetime'],
        }),
      ).toEqual({ retired: 1 });
      expect(
        make().historyRead({ client: next, terminalId: 'successor' }).text,
      ).toBe(expectedHistory);
    },
  );

  it.each(['forget', 'retire', 'reload', 'replacement'])(
    'R7 F3 %s invalidates a continuation including empty results',
    (change) => {
      let authority = make();
      const batch = {
        client,
        producer: { id: 'pages', runId: 'run' },
        seq: 1,
        ops: [
          { op: 'session.upsert' as const, session: session('paged') },
          { op: 'output.append' as const, terminalId: 'paged', text: 'abcdef' },
        ],
      };
      authority.apply(batch);
      const page = authority.historyRead({
        client,
        terminalId: 'paged',
        maxBytes: 2,
      });
      expect(page.nextCursor).not.toBeNull();
      if (page.nextCursor === null) throw new Error('Expected continuation');
      if (change === 'forget')
        authority.apply({
          ...batch,
          seq: 2,
          ops: [{ op: 'forget', terminalId: 'paged' }],
        });
      else if (change === 'retire')
        authority.retire({ projectId: 'proj', worktreeId: 'wt' });
      else if (change === 'replacement')
        authority.open({ ...client, incarnation: 'inc-2' });
      else authority = make();
      const continued = authority.historyRead({
        client,
        terminalId: 'paged',
        cursor: page.nextCursor,
        historyRevision: page.historyRevision,
        maxBytes: 2,
      });
      expect(continued.restarted).toBe(true);
      expect(continued.text).toBe(change === 'reload' ? 'ab' : '');
    },
  );

  it.each(['before rename', 'after rename'])(
    'R7 F4 shutdown reports %s failure and retries exact stamps',
    (stage) => {
      let blocked = false;
      const directory = terminalRecordDir(root, 'proj', 'wt');
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (path): void => {
          if (blocked && stage === 'after rename' && path === directory)
            throw new Error('sync blocked');
        },
      });
      const authority = new TerminalRecordAuthority({ repository });
      const other = { ...client, worktreeId: 'wt-other' };
      for (const [terminalId, scope] of [
        ['first', client],
        ['second', other],
      ] as const)
        authority.attribute({
          terminalId,
          client: scope,
          session: session(terminalId, { worktreeId: scope.worktreeId }),
          persist: true,
        });
      authority.flushSync();
      const save = repository.save.bind(repository);
      jest.spyOn(repository, 'save').mockImplementation((image) => {
        if (
          blocked &&
          stage === 'before rename' &&
          image.scope.worktreeId === 'wt'
        )
          throw new Error('save blocked');
        save(image);
      });
      blocked = true;
      expect(() => authority.shutdown('app-quit')).toThrow('flush failed');
      // A failing owner cannot prevent the other owner's stamp from landing.
      const otherImage = repository.load('proj', 'wt-other');
      expect(
        otherImage.kind === 'record' &&
          otherImage.envelope.record.terminals[0]?.signal,
      ).toBe('app-quit');
      if (stage === 'before rename')
        expect(record().record.terminals[0]?.signal).toBeNull();
      blocked = false;
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 2 });
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      authority.exited('first', 0, null);
      authority.flushSync();
      expect(make().open(client).terminals[0]?.signal).toBe('app-quit');
    },
  );

  it.each(['user-close', 'APP_SHUTDOWN', '', 'connection-lost'])(
    'R7 F5 rejects non-shutdown reason %s at both boundaries',
    (signal) => {
      expect(
        WorkerTerminalRecordShutdownParamsSchema.safeParse({ signal }).success,
      ).toBe(false);
      expect(() => make().shutdown(signal)).toThrow();
      expect(existsSync(recordFile())).toBe(false);
    },
  );
  it.each(['app-quit', 'fatal-exit'])(
    'R7 F5 preserves accepted shutdown reason %s through ordinary exit',
    (signal) => {
      const authority = make();
      expect(
        WorkerTerminalRecordShutdownParamsSchema.safeParse({ signal }).success,
      ).toBe(true);
      authority.attribute({
        terminalId: 'quit',
        client,
        session: session('quit'),
        persist: true,
      });
      expect(authority.shutdown(signal)).toEqual({ stamped: 1 });
      authority.exited('quit', 0, 'user-close');
      authority.flushSync();
      expect(record().record.terminals[0]?.signal).toBe(signal);
    },
  );

  it('R7 F6 disposal cancels installs scheduled by held history replay before teardown', () => {
    jest.useFakeTimers();
    try {
      make().open(client);
      const authority = make();
      const restore = failReads();
      authority.attribute({
        terminalId: 'held-cleanup',
        client,
        session: session('held-cleanup'),
        persist: true,
      });
      authority.output('held-cleanup', Buffer.from('held'));
      restore();
      expect(
        authority.historyRead({ client, terminalId: 'held-cleanup' }).text,
      ).toBe('held');
      for (const instance of authorities) instance.dispose();
      rmSync(root, { recursive: true, force: true });
      jest.advanceTimersByTime(2_000);
      expect(existsSync(root)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['same owner', 'fresh owner'])(
    'R7 invariant uncertain apply never releases replay without exact durable evidence (%s)',
    (recovery) => {
      const directory = terminalRecordDir(root, 'proj', 'wt');
      let blocked = false;
      let syncs = 0;
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (path): void => {
          if (path === directory) {
            syncs += 1;
            if (blocked) throw new Error('receipt sync blocked');
          }
        },
      });
      let authority = new TerminalRecordAuthority({ repository });
      authority.open(client);
      const batch = WorkerTerminalRecordApplyParamsSchema.parse({
        client,
        producer: { id: 'receipt', runId: 'run' },
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('once') },
          { op: 'output.append', terminalId: 'once', text: 'once' },
        ],
      });
      blocked = true;
      expect(() => authority.apply(batch)).toThrow('could not be installed');
      if (recovery === 'fresh owner')
        authority = new TerminalRecordAuthority({ repository });
      expect(() => authority.apply(batch)).toThrow('receipt sync blocked');
      const page = authority.historyRead({ client, terminalId: 'once' });
      expect(page.text).toBe('once');
      expect(page.producerWatermarks).toBeUndefined();
      expect(authority.open(client).import.pending).toBe(true);
      blocked = false;
      expect(authority.apply(batch).outcome).toBe('duplicate');
      const confirmed = syncs;
      expect(authority.apply(batch).outcome).toBe('duplicate');
      expect(
        authority.historyRead({ client, terminalId: 'once' })
          .producerWatermarks,
      ).toEqual({ 'receipt/run': 1 });
      expect(syncs).toBe(confirmed);
      authority.flushSync();
      expect(make().historyRead({ client, terminalId: 'once' }).text).toBe(
        'once',
      );
    },
  );
});

describe('R23 independent retirement fence recovery', (): void => {
  it('retains a persisted damaged fence generation against a valid predecessor', (): void => {
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (): void => undefined,
    });
    const predecessor = repository.empty({ ...client, generation: 7 }, 'none');
    repository.save(predecessor);
    writeFileSync(
      join(dirname(recordFile()), 'tombstone.json'),
      JSON.stringify({
        generation: 9,
        incarnation: null,
        retiredAt: 0,
        damaged: true,
        retiredLifetimeIds: ['old'],
      }),
    );
    const loaded = repository.load('proj', 'wt');
    expect(loaded.kind).toBe('absent');
    expect(loaded.tombstone).toMatchObject({
      generation: 9,
      damaged: true,
      retiredLifetimeIds: ['old'],
    });
    expect(
      make().apply({
        client: { ...client, lifetimeId: 'new' },
        generation: 7,
        producer: { id: 'p', runId: 'one' },
        seq: 1,
        ops: [],
      }).outcome,
    ).toBe('dropped');
    expect(readFileSync(recordFile(), 'utf8')).toBe(
      JSON.stringify(predecessor),
    );
  });

  it.each([
    { generation: 9, ids: ['old'], version: 3 },
    { generation: 'damaged', ids: ['old'], version: 3 },
    { generation: 9, ids: ['old', 7], version: 3 },
    { generation: 9, ids: ['old'], version: 'damaged' },
  ])(
    'persists damaged-record fencing fields before quarantine (%j)',
    ({ generation, ids, version }): void => {
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      const envelope = repository.empty({ ...client, generation: 9 }, 'none');
      envelope.revision = 17;
      envelope.producerWatermarks = { 'stale/run': 55 };
      const bytes = JSON.stringify({
        ...envelope,
        version,
        generation,
        retiredLifetimeIds: ids,
        record: 'damaged',
      });
      const directory = dirname(recordFile());
      mkdirSync(directory, { recursive: true });
      writeFileSync(recordFile(), bytes);
      expect(repository.load('proj', 'wt').kind).toBe('absent');
      expect(readFileSync(recordFile(), 'utf8')).toBe(bytes);
      expect(readdirSync(directory)).toEqual(['record.json']);
      const loaded = repository.load('proj', 'wt', 'recover');
      expect(loaded.tombstone).toMatchObject({
        generation: typeof generation === 'number' ? generation : 1,
        incarnation: null,
        retiredAt: 0,
        damaged: true,
      });
      expect(loaded.tombstone?.retiredLifetimeIds).toEqual(
        ids.every((id): boolean => typeof id === 'string') ? ids : [],
      );
      expect(loaded.tombstone?.cleanupFiles).toBeUndefined();
      expect(existsSync(recordFile())).toBe(false);
      const reloaded = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      }).load('proj', 'wt');
      expect(reloaded.tombstone).toEqual(loaded.tombstone);
      expect(
        readFileSync(
          join(
            directory,
            readdirSync(directory).find((name): boolean =>
              name.startsWith('record.json.damaged-'),
            ) ?? '',
          ),
          'utf8',
        ),
      ).toBe(bytes);
      if (typeof generation === 'number')
        expect(
          make().apply({
            client: { ...client, lifetimeId: 'new' },
            generation,
            producer: { id: 'p', runId: 'one' },
            seq: 1,
            ops: [],
          }).outcome,
        ).toBe('dropped');
      if (ids.every((id): boolean => typeof id === 'string'))
        expect(
          make().apply({
            client: { ...client, lifetimeId: 'old' },
            producer: { id: 'p', runId: 'one' },
            seq: 1,
            ops: [],
          }).outcome,
        ).toBe('dropped');
      expect(
        make().apply({
          client: { ...client, lifetimeId: 'new' },
          producer: { id: 'p', runId: 'one' },
          seq: 1,
          ops: [],
        }).outcome,
      ).toBe('applied');
      expect(record().record.terminals).toEqual([]);
      expect(record().producerWatermarks).toEqual({ 'p/one': 1 });
      expect(record().lineage).not.toBe(envelope.lineage);
      expect(record().revision).not.toBe(17);
    },
  );

  it.each(['valid', 'damaged'])(
    'merges damaged-record fences with the %s tombstone before a failed quarantine',
    (kind): void => {
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      const envelope = repository.empty({ ...client, generation: 9 }, 'none');
      envelope.retiredLifetimeIds = ['old'];
      const bytes = JSON.stringify({ ...envelope, record: 'damaged' });
      const directory = dirname(recordFile());
      mkdirSync(directory, { recursive: true });
      writeFileSync(recordFile(), bytes);
      writeFileSync(
        join(directory, 'tombstone.json'),
        JSON.stringify({
          generation: 9_000_000_000_000,
          incarnation: 'inc-1',
          retiredAt: kind === 'valid' ? 123 : 'damaged',
          retiredLifetimeIds: ['earlier'],
          cleanupFiles: [{ name: 'unqualified', identity: null }],
        }),
      );
      writeFileSync(join(directory, 'unqualified'), 'keep');
      const rename = fs.renameSync;
      const spy = jest
        .spyOn(fs, 'renameSync')
        .mockImplementation((from, to): void => {
          if (from === recordFile()) throw new Error('quarantine blocked');
          rename(from, to);
        });
      try {
        expect(() => repository.load('proj', 'wt', 'recover')).toThrow(
          'quarantine blocked',
        );
        expect(readFileSync(recordFile(), 'utf8')).toBe(bytes);
      } finally {
        spy.mockRestore();
      }
      const reloaded = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      expect(reloaded.load('proj', 'wt').tombstone).toEqual({
        generation: 9_000_000_000_000,
        incarnation: null,
        retiredAt: 0,
        damaged: true,
        retiredLifetimeIds: ['earlier', 'old'],
      });
      expect(
        reloaded.load('proj', 'wt', 'recover').tombstone?.retiredLifetimeIds,
      ).toEqual(['earlier', 'old']);
      reloaded.retryRetirement('proj', 'wt');
      expect(readFileSync(join(directory, 'unqualified'), 'utf8')).toBe('keep');
      expect(
        make().apply({
          client: { ...client, lifetimeId: 'old' },
          producer: { id: 'p', runId: 'one' },
          seq: 1,
          ops: [],
        }).outcome,
      ).toBe('dropped');
    },
  );

  it.each(['write', 'fsync', 'directory flush'])(
    'does not quarantine damaged-record fences until %s succeeds',
    (fault): void => {
      let blocked = false;
      const directory = dirname(recordFile());
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (path): void => {
          if (blocked && fault === 'directory flush' && path === directory)
            throw new Error('fence flush blocked');
        },
      });
      repository.save(repository.empty({ ...client, generation: 9 }, 'none'));
      const envelope = record();
      envelope.retiredLifetimeIds = ['old'];
      const bytes = JSON.stringify({ ...envelope, record: 'damaged' });
      writeFileSync(recordFile(), bytes);
      blocked = true;
      const spy =
        fault === 'directory flush'
          ? undefined
          : fault === 'write'
            ? jest.spyOn(fs, 'writeFileSync').mockImplementation((): never => {
                throw new Error('fence write blocked');
              })
            : jest.spyOn(fs, 'fsyncSync').mockImplementation((): never => {
                throw new Error('fence fsync blocked');
              });
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          expect(() => repository.load('proj', 'wt', 'recover')).toThrow();
          expect(existsSync(recordFile())).toBe(true);
          expect(readFileSync(recordFile(), 'utf8')).toBe(bytes);
          expect(
            readdirSync(directory).filter((name): boolean =>
              name.startsWith('record.json.damaged-'),
            ),
          ).toEqual([]);
        }
      } finally {
        spy?.mockRestore();
        blocked = false;
      }
      expect(
        repository.load('proj', 'wt', 'recover').tombstone?.retiredLifetimeIds,
      ).toEqual(['old']);
      expect(
        make().apply({
          client: { ...client, lifetimeId: 'old' },
          producer: { id: 'p', runId: 'one' },
          seq: 1,
          ops: [],
        }).outcome,
      ).toBe('dropped');
    },
  );

  it.each([
    { ids: [] },
    { ids: ['old'] },
    { ids: ['x'.repeat(513)] },
    { ids: ['old', 7] },
  ])(
    'keeps independently valid fence fields for stored IDs %j',
    ({ ids }): void => {
      const directory = terminalRecordDir(root, 'proj', 'wt');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'tombstone.json'),
        JSON.stringify({
          generation: 9_000_000_000_000,
          incarnation: 'inc-1',
          retiredAt: 123,
          cleanupFiles: 'damaged',
          retiredLifetimeIds: ids,
        }),
      );
      const loaded = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      }).load('proj', 'wt');
      expect(loaded.kind).toBe('absent');
      expect(loaded.tombstone).toMatchObject({
        generation: 9_000_000_000_000,
        incarnation: null,
        retiredAt: 0,
        damaged: true,
      });
      expect(loaded.tombstone?.cleanupFiles).toBeUndefined();
      expect(loaded.tombstone?.retiredLifetimeIds).toEqual(
        ids.every((id): boolean => typeof id === 'string') ? ids : undefined,
      );
      expect(
        make().apply({
          client,
          generation: 2,
          producer: { id: 'old', runId: 'one' },
          seq: 1,
          ops: [],
        }).outcome,
      ).toBe('dropped');
    },
  );

  it.each(['generation', 'incarnation', 'retiredAt'])(
    'keeps other fence fields when only %s is damaged',
    (field): void => {
      const directory = terminalRecordDir(root, 'proj', 'wt');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'tombstone.json'),
        JSON.stringify({
          generation: 9_000_000_000_000,
          incarnation: 'inc-1',
          retiredAt: 123,
          retiredLifetimeIds: ['old'],
          [field]: field === 'incarnation' ? 7 : 'damaged',
        }),
      );
      const loaded = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      }).load('proj', 'wt');
      expect(loaded.kind).toBe('absent');
      expect(loaded.tombstone).toMatchObject({
        incarnation: null,
        retiredAt: 0,
        retiredLifetimeIds: ['old'],
        damaged: true,
      });
      if (field !== 'generation')
        expect(loaded.tombstone?.generation).toBe(9_000_000_000_000);
      else expect(loaded.tombstone?.generation).toBeGreaterThan(1);
    },
  );

  it.each(['generation', 'retiredAt', 'cleanupFiles'])(
    'unions damaged tombstone IDs into a valid successor (%s)',
    (field): void => {
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      const successor = repository.empty({ ...client, generation: 7 }, 'none');
      successor.retiredLifetimeIds = ['earlier'];
      repository.save(successor);
      const path = join(dirname(recordFile()), 'tombstone.json');
      const bytes = JSON.stringify({
        generation: 1,
        incarnation: 'inc-1',
        retiredAt: 1,
        retiredLifetimeIds: ['old'],
        [field]: 'damaged',
      });
      writeFileSync(path, bytes);
      const before = readFileSync(recordFile());
      const a = make();
      expect(a.open(client).generation).toBe(7);
      expect(readFileSync(recordFile())).toEqual(before);
      expect(
        a.apply({
          client: { ...client, lifetimeId: 'old' },
          producer: { id: 'old', runId: 'one' },
          seq: 1,
          ops: [],
        }).outcome,
      ).toBe('dropped');
      expect(
        a.apply({
          client: { ...client, lifetimeId: 'new' },
          producer: { id: 'new', runId: 'one' },
          seq: 1,
          ops: [],
        }).outcome,
      ).toBe('applied');
      expect(record().retiredLifetimeIds).toEqual(['earlier', 'old']);
      expect(readFileSync(path, 'utf8')).toBe(bytes);
    },
  );

  it.each([
    { generation: 'damaged', retiredAt: 1 },
    { generation: undefined, retiredAt: 1 },
    { generation: 1, retiredAt: 'damaged' },
    { generation: 'damaged', retiredAt: 'damaged' },
  ])('retains named coverage independently of %j', (damage): void => {
    const directory = terminalRecordDir(root, 'proj', 'wt');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'tombstone.json');
    const bytes = JSON.stringify({
      ...damage,
      incarnation: 'inc-1',
      retiredLifetimeIds: ['old'],
    });
    writeFileSync(path, bytes);
    const batch = {
      client: { ...client, lifetimeId: 'old' },
      producer: { id: 'old', runId: 'one' },
      seq: 1,
      ops: [],
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(make().apply(batch).outcome).toBe('dropped');
      expect(readFileSync(path, 'utf8')).toBe(bytes);
      expect(existsSync(recordFile())).toBe(false);
    }
    expect(
      make().apply({ ...batch, client: { ...client, lifetimeId: 'new' } })
        .outcome,
    ).toBe('applied');
    expect(record().retiredLifetimeIds).toContain('old');
    expect(make().apply(batch).outcome).toBe('dropped');
  });
});

type FaultEvent = {
  operation: string;
  artifact: string;
  phase: string;
  occurrence: number;
};

/** Trace first, then inject only events reached by that public flow. */
class RecordFaults {
  readonly events: FaultEvent[] = [];
  private readonly counts = new Map<string, number>();
  private readonly descriptors = new Map<number, string>();
  private readonly spies: jest.SpyInstance[] = [];
  private phase = 'observation';
  private artifact = 'directory';
  latchedDirectory?: string;
  target?: FaultEvent;
  active = false;
  persistent = false;
  code = 'EIO';
  hits = 0;

  constructor(private readonly dataRoot: string) {}

  private name(path: fs.PathLike | number): string {
    if (typeof path === 'number')
      return this.descriptors.get(path) ?? 'descriptor';
    const name = basename(String(path));
    if (name.startsWith('record.json.damaged-')) return 'record.json.damaged';
    for (const artifact of [
      'record.json',
      'tombstone.json',
      'import-source.json',
      'terminal-state.json',
    ])
      if (name === artifact || name.startsWith(`.${artifact}.`))
        return artifact;
    return relative(this.dataRoot, String(path)) || 'root';
  }

  private event(operation: string, artifact: string): void {
    if (!this.active) return;
    const key = `${operation}:${artifact}:${this.phase}`;
    const occurrence = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, occurrence);
    const event = { operation, artifact, phase: this.phase, occurrence };
    this.events.push(event);
    // Retries can skip completed work, changing this syscall's phase/ordinal.
    if (
      this.target &&
      event.operation === this.target.operation &&
      event.artifact === this.target.artifact &&
      ((this.persistent && this.hits > 0) ||
        (event.phase === this.target.phase &&
          event.occurrence === this.target.occurrence)) &&
      (this.persistent || this.hits === 0)
    ) {
      this.hits += 1;
      throw Object.assign(new Error(`injected ${key} #${occurrence}`), {
        code: this.code,
      });
    }
  }

  flush = (path: string): void => {
    if (this.active && this.target && this.latchedDirectory === path) {
      this.hits += 1;
      throw Object.assign(new Error('injected persistent directory flush'), {
        code: this.code,
      });
    }
    try {
      this.event('directory.flush', `${this.artifact}@${this.name(path)}`);
    } catch (error) {
      if (this.persistent && this.target?.operation === 'directory.flush')
        this.latchedDirectory = path;
      throw error;
    }
  };

  run(action: () => unknown): { result?: unknown; error?: unknown } {
    this.counts.clear();
    this.events.length = 0;
    this.phase = 'observation';
    this.artifact = 'directory';
    this.active = true;
    try {
      return { result: action() };
    } catch (error) {
      return { error };
    } finally {
      this.active = false;
    }
  }

  install(): void {
    const read = fs.readFileSync;
    this.spies.push(
      jest.spyOn(fs, 'readFileSync').mockImplementation((path, options) => {
        this.event('read', this.name(path));
        return read(path, options);
      }),
    );
    const stat = fs.statSync;
    this.spies.push(
      jest.spyOn(fs, 'statSync').mockImplementation((path, options) => {
        this.event('stat', this.name(path));
        return stat(path, options);
      }),
    );
    const lstat = fs.lstatSync;
    this.spies.push(
      jest.spyOn(fs, 'lstatSync').mockImplementation((path, options) => {
        this.event('identity', this.name(path));
        return lstat(path, options);
      }),
    );
    const list = fs.readdirSync;
    this.spies.push(
      jest.spyOn(fs, 'readdirSync').mockImplementation((path, options) => {
        this.event('list', this.name(path));
        return list(path, options);
      }),
    );
    const mkdir = fs.mkdirSync;
    this.spies.push(
      jest.spyOn(fs, 'mkdirSync').mockImplementation((path, options) => {
        this.phase = 'hierarchy';
        this.event('mkdir', this.name(path));
        return mkdir(path, options);
      }),
    );
    const admit = storage.assertAdmittedWriter;
    this.spies.push(
      jest
        .spyOn(storage, 'assertAdmittedWriter')
        .mockImplementation((...args) => {
          this.event('admission', args[0]);
          return admit(...args);
        }),
    );
    const open = fs.openSync;
    this.spies.push(
      jest.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
        this.phase = 'temporary';
        this.artifact = this.name(path);
        this.event('open', this.artifact);
        const fd = open(path, flags, mode);
        this.descriptors.set(fd, this.artifact);
        return fd;
      }),
    );
    const write = fs.writeFileSync;
    this.spies.push(
      jest
        .spyOn(fs, 'writeFileSync')
        .mockImplementation((path, data, options) => {
          this.event('write', this.name(path));
          return write(path, data, options);
        }),
    );
    const chmod = fs.fchmodSync;
    this.spies.push(
      jest.spyOn(fs, 'fchmodSync').mockImplementation((fd, mode) => {
        this.event('chmod', this.name(fd));
        return chmod(fd, mode);
      }),
    );
    const sync = fs.fsyncSync;
    this.spies.push(
      jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        this.event('file.sync', this.name(fd));
        return sync(fd);
      }),
    );
    const close = fs.closeSync;
    this.spies.push(
      jest.spyOn(fs, 'closeSync').mockImplementation((fd) => {
        // Close the real descriptor even when simulating a close failure.
        close(fd);
        this.event('close', this.name(fd));
        this.descriptors.delete(fd);
      }),
    );
    const rename = fs.renameSync;
    this.spies.push(
      jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        this.event('rename', this.name(to));
        rename(from, to);
        this.artifact = this.name(to);
        this.phase = 'publication';
      }),
    );
    const remove = fs.rmSync;
    this.spies.push(
      jest.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
        this.phase = 'cleanup';
        this.event('remove', this.name(path));
        return remove(path, options);
      }),
    );
    const unlink = fs.unlinkSync;
    this.spies.push(
      jest.spyOn(fs, 'unlinkSync').mockImplementation((path) => {
        this.event('unlink', this.name(path));
        return unlink(path);
      }),
    );
  }

  restore(): void {
    for (const spy of this.spies.reverse()) spy.mockRestore();
  }
}

interface FaultScene {
  confirmDuplicate?: () => void;
  verifyUnpublished?: () => void;
  verifyUnconfirmed?: () => void;
  attempt: () => unknown;
  recover: () => void;
  verify: () => void;
}

// Reachability manifest: each scene traces its own public path and targets every
// reached event/phase/occurrence. No Cartesian product with unreachable syscalls.
const recordFaultScenes = [
  'cold import',
  'pending import and host reports',
  'preview',
  'recovered record',
  'dirty live record',
  'producer publication',
  'known predecessor',
  'unknown predecessor',
  'terminal recreation',
  'retirement cleanup',
  'lower fence',
  'damaged record',
  'damaged tombstone',
  'valid record and damaged tombstone',
  'project retirement',
  'shutdown with held reports',
] as const;

function faultRows(
  scene: (typeof recordFaultScenes)[number],
  reached: readonly FaultEvent[],
): FaultEvent[] {
  // Full shared-install coverage belongs to producer, backup and tombstone
  // scenes; the other scenes qualify their distinct admission/recovery edges.
  return reached.filter((event) => {
    if (scene === 'producer publication' || scene === 'retirement cleanup')
      return true;
    if (scene === 'cold import')
      return (
        event.artifact === 'import-source.json' ||
        event.operation === 'read' ||
        event.phase === 'hierarchy'
      );
    if (
      scene === 'preview' ||
      scene === 'recovered record' ||
      scene.startsWith('damaged') ||
      scene === 'valid record and damaged tombstone'
    )
      return true;
    return (
      ['read', 'list', 'identity', 'rename', 'directory.flush'].includes(
        event.operation,
      ) &&
      (event.operation !== 'directory.flush' || event.phase !== 'hierarchy')
    );
  });
}

function recordFaultScene(
  name: (typeof recordFaultScenes)[number],
  dataRoot: string,
  faults: RecordFaults,
): FaultScene {
  const makeHere = (): TerminalRecordAuthority =>
    new TerminalRecordAuthority({
      repository: new TerminalRecordRepository({
        dataRoot,
        flushDirectorySync: faults.flush,
      }),
    });
  const recordPath = (worktreeId = 'wt'): string =>
    join(terminalRecordDir(dataRoot, 'proj', worktreeId), 'record.json');
  const history = (
    authority: TerminalRecordAuthority,
    id = 't',
    c: WorkerTerminalRecordClient = client,
  ): string => authority.historyRead({ client: c, terminalId: id }).text;
  const producer = { id: 'matrix', runId: 'one' };
  const seedBatch = {
    client,
    producer,
    seq: 1,
    ops: [
      { op: 'session.upsert' as const, session: session('t') },
      { op: 'output.append' as const, terminalId: 't', text: 'before\n' },
    ],
  };
  const nextBatch = {
    client,
    producer,
    seq: 2,
    ops: [{ op: 'output.append' as const, terminalId: 't', text: 'while\n' }],
  };
  const legacy = legacyTerminalStatePath(dataRoot, 'workspaces', 'proj', 'wt');
  const writeLegacy = (): void => {
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(
      legacy,
      JSON.stringify({
        ...createEmptyState(),
        terminals: [
          {
            session: session('legacy'),
            scrollbackLines: ['before'],
            exitCode: null,
            signal: null,
          },
        ],
      }),
    );
  };
  const seed = (): void => {
    const authority = makeHere();
    authority.apply(seedBatch);
    authority.dispose();
  };
  const attribute = (
    authority: TerminalRecordAuthority,
    id = 't',
    c: WorkerTerminalRecordClient = client,
  ): void => {
    authority.attribute({
      terminalId: id,
      client: c,
      session: session(id, { worktreeId: c.worktreeId }),
      persist: true,
    });
  };
  const hold = (
    authority: TerminalRecordAuthority,
    id = 't',
    c: WorkerTerminalRecordClient = client,
  ): void => {
    const reading = failReadsOf(recordPath(c.worktreeId));
    try {
      attribute(authority, id, c);
      expect(
        reading.mock.calls.some(([path]) => path === recordPath(c.worktreeId)),
      ).toBe(true);
      expect(authority.isAttributed(id)).toBe(false);
      authority.output(id, Buffer.from('while\n'));
    } finally {
      reading.mockRestore();
    }
  };

  if (
    name === 'cold import' ||
    name === 'pending import and host reports' ||
    name === 'preview'
  ) {
    writeLegacy();
    const legacyBytes = readFileSync(legacy);
    const authority = makeHere();
    if (name === 'pending import and host reports') {
      const reading = failReadsOf(legacy);
      try {
        attribute(authority);
        authority.output('t', Buffer.from('while\n'));
      } finally {
        reading.mockRestore();
      }
    }
    return {
      attempt: () =>
        name === 'preview'
          ? history(authority, 'legacy')
          : authority.open(client),
      recover: () => {
        expect(authority.open(client).import.pending).toBeUndefined();
        authority.flushSync();
      },
      verify: () => {
        expect(readFileSync(legacy)).toEqual(legacyBytes);
        rmSync(legacy);
        expect(history(makeHere(), 'legacy')).toBe('before');
        if (name === 'pending import and host reports')
          expect(history(makeHere())).toBe('while\n');
      },
    };
  }
  if (
    name === 'recovered record' ||
    name === 'producer publication' ||
    name === 'dirty live record'
  ) {
    seed();
    const before = readFileSync(recordPath());
    const authority = makeHere();
    if (name !== 'recovered record') authority.open(client);
    if (name === 'dirty live record') {
      attribute(authority);
      authority.output('t', Buffer.from('while\n'));
    }
    return {
      attempt: () =>
        name === 'dirty live record'
          ? authority.flushSync()
          : name === 'recovered record'
            ? authority.historyTail(client, 't', 128)
            : authority.apply(nextBatch),
      ...(name === 'producer publication'
        ? {
            verifyUnpublished: (): void => {
              expect(readFileSync(recordPath())).toEqual(before);
              const loaded = new TerminalRecordRepository({
                dataRoot,
                flushDirectorySync: faults.flush,
              }).load('proj', 'wt');
              expect(loaded.kind).toBe('record');
              if (loaded.kind !== 'record')
                throw new Error('producer seed disappeared');
              expect(loaded.envelope.producerWatermarks).toEqual({
                'matrix/one': 1,
              });
            },
            verifyUnconfirmed: (): void => {
              expect(
                faults.run((): void => {
                  expect(
                    authority.historyRead({ client, terminalId: 't' })
                      .producerWatermarks,
                  ).toBeUndefined();
                }).error,
              ).toBeUndefined();
            },
            confirmDuplicate: (): void => {
              expect(authority.apply(nextBatch).outcome).toBe('duplicate');
            },
          }
        : {}),
      recover: () => {
        if (name === 'producer publication')
          expect(['applied', 'duplicate']).toContain(
            authority.apply(nextBatch).outcome,
          );
        authority.open(client);
        authority.flushSync();
      },
      verify: () => {
        expect(history(makeHere())).toBe(
          name === 'recovered record' ? 'before\n' : 'before\nwhile\n',
        );
        if (name === 'producer publication') {
          expect(makeHere().apply(nextBatch).outcome).toBe('duplicate');
          expect(history(authority)).toBe('before\nwhile\n');
        }
      },
    };
  }
  if (
    name === 'known predecessor' ||
    name === 'unknown predecessor' ||
    name === 'terminal recreation'
  ) {
    seed();
    const authority = makeHere();
    const next = { ...client, incarnation: 'inc-2' };
    if (name === 'known predecessor') authority.open(client);
    if (name === 'terminal recreation') hold(authority, 't', next);
    let reported = false;
    return {
      attempt: () => {
        attribute(authority, 't', next);
        if (!reported) {
          authority.output(
            't',
            Buffer.from(
              name === 'terminal recreation' ? 'recreated\n' : 'while\n',
            ),
          );
          reported = true;
        }
        return authority.open(next);
      },
      recover: () => {
        authority.open(next);
        authority.output('t', Buffer.from('after'));
        authority.flushSync();
      },
      verify: () => {
        expect(history(makeHere(), 't', next)).toBe(
          name === 'terminal recreation'
            ? 'while\nrecreated\nafter'
            : 'while\nafter',
        );
        expect(history(makeHere(), 't')).toBe('');
      },
    };
  }
  if (
    name === 'retirement cleanup' ||
    name === 'lower fence' ||
    name === 'project retirement'
  ) {
    const authority = makeHere();
    const retiring = { ...client, lifetimeId: 'retired' };
    attribute(authority, 't', retiring);
    authority.output('t', Buffer.from('before\n'));
    authority.flushSync();
    expect(authority.isAttributed('t')).toBe(true);
    const directory = terminalRecordDir(dataRoot, 'proj', 'wt');
    writeFileSync(join(directory, 'import-source.json'), 'old');
    writeFileSync(join(directory, '.record.json.interrupted.tmp'), 'old');
    if (name === 'lower fence')
      authority.retire({ projectId: 'proj', worktreeId: 'wt', generation: 1 });
    if (name === 'project retirement') {
      // An unloaded worktree on disk: the project request names no worktree.
      const disk = makeHere();
      attribute(disk, 'disk', { ...client, worktreeId: 'disk' });
      disk.flushSync();
      disk.dispose();
    }
    const params =
      name === 'project retirement'
        ? // After every record this scene starts, in every fault run.
          { projectId: 'proj', requestedAt: 4_102_444_800_000 }
        : {
            projectId: 'proj',
            worktreeId: 'wt',
            generation: name === 'lower fence' ? 4 : 1,
          };
    return {
      attempt: () => authority.retire(params),
      recover: () => {
        expect(authority.retire(params)).toEqual({
          retired: name === 'project retirement' ? 2 : 1,
        });
        authority.output('t', Buffer.from('after'));
        authority.flushSync();
      },
      verify: () => {
        expect(history(makeHere(), 't', retiring)).toBe('');
        expect(existsSync(recordPath())).toBe(false);
        expect(authority.isAttributed('t')).toBe(false);
        if (name === 'project retirement')
          expect(existsSync(recordPath('disk'))).toBe(false);
        expect(
          makeHere().apply({
            ...seedBatch,
            client: retiring,
            generation: name === 'lower fence' ? 4 : 1,
          }).outcome,
        ).toBe('dropped');
      },
    };
  }
  if (
    name === 'damaged record' ||
    name === 'damaged tombstone' ||
    name === 'valid record and damaged tombstone'
  ) {
    if (name === 'valid record and damaged tombstone') seed();
    const directory = terminalRecordDir(dataRoot, 'proj', 'wt');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(
        directory,
        name === 'damaged record' ? 'record.json' : 'tombstone.json',
      ),
      '{damaged',
    );
    const authority = makeHere();
    const stale = { ...seedBatch, generation: 4 };
    const attempt = (): unknown =>
      name === 'damaged tombstone'
        ? authority.apply(stale)
        : authority.open(client);
    return {
      attempt,
      recover: () => {
        if (name === 'damaged tombstone')
          expect(authority.apply(stale).outcome).toBe('dropped');
        else authority.open(client);
      },
      verify: () => {
        expect(history(makeHere())).toBe(
          name === 'valid record and damaged tombstone' ? 'before\n' : '',
        );
        if (name === 'damaged tombstone')
          expect(existsSync(recordPath())).toBe(false);
      },
    };
  }
  const authority = makeHere();
  attribute(authority);
  authority.output('t', Buffer.from('before\n'));
  hold(authority, 'held', { ...client, worktreeId: 'held' });
  return {
    attempt: () => authority.shutdown('app-quit'),
    recover: () => {
      authority.shutdown('app-quit');
      authority.output('t', Buffer.from('after'));
      authority.flushSync();
    },
    verify: () => {
      expect(history(makeHere())).toBe('before\nafter');
      expect(
        history(makeHere(), 'held', { ...client, worktreeId: 'held' }),
      ).toBe('while\n');
      expect(makeHere().open(client).terminals[0].signal).toBe('app-quit');
      expect(
        makeHere().open({ ...client, worktreeId: 'held' }).terminals[0].signal,
      ).toBe('app-quit');
    },
  };
}

describe('R10 reachable storage phase matrix', () => {
  it.each([
    'sharing exhaustion',
    'failed temporary unlink',
    'damaged-copy pruning',
    'backup read',
    'backup removal',
    'backup validation',
  ])(
    '%s qualifies exceptional paths absent from successful traces',
    (failure) => {
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      const authority = new TerminalRecordAuthority({ repository });
      const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
      mkdirSync(dirname(legacy), { recursive: true });
      writeFileSync(
        legacy,
        JSON.stringify({
          ...createEmptyState(),
          terminals: [
            {
              session: session('t'),
              scrollbackLines: ['before'],
              exitCode: null,
              signal: null,
            },
          ],
        }),
      );
      authority.open(client);
      const before = readFileSync(recordFile(), 'utf8');
      const directory = terminalRecordDir(root, 'proj', 'wt');
      const backup = join(directory, 'import-source.json');
      const batch = {
        client,
        producer: { id: 'exception', runId: 'one' },
        seq: 1,
        ops: [
          { op: 'output.append' as const, terminalId: 't', text: '\nafter' },
        ],
      };
      let hits = 0;
      const spies: jest.SpyInstance[] = [];
      const unavailable = (): never => {
        hits += 1;
        throw Object.assign(new Error('exceptional fault'), { code: 'EIO' });
      };
      if (failure === 'sharing exhaustion') {
        const rename = fs.renameSync;
        spies.push(
          jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
            if (String(to) === recordFile()) {
              hits += 1;
              throw Object.assign(new Error('sharing violation'), {
                code: 'EBUSY',
              });
            }
            rename(from, to);
          }),
        );
      } else if (failure === 'failed temporary unlink') {
        spies.push(jest.spyOn(fs, 'fsyncSync').mockImplementation(unavailable));
        spies.push(
          jest.spyOn(fs, 'unlinkSync').mockImplementation(unavailable),
        );
      } else if (failure === 'damaged-copy pruning') {
        authority.dispose();
        for (let index = 0; index < 6; index += 1)
          writeFileSync(`${recordFile()}.damaged-${index}`, 'old');
        writeFileSync(recordFile(), '{damaged');
        spies.push(
          jest.spyOn(fs, 'unlinkSync').mockImplementation(unavailable),
        );
      } else if (failure === 'backup read') {
        const read = fs.readFileSync;
        spies.push(
          jest.spyOn(fs, 'readFileSync').mockImplementation((path, options) => {
            if (String(path) === backup) return unavailable();
            return read(path, options);
          }),
        );
      } else if (failure === 'backup removal') {
        const remove = fs.rmSync;
        spies.push(
          jest.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
            if (String(path) === recordFile()) return unavailable();
            return remove(path, options);
          }),
        );
      } else
        writeFileSync(
          backup,
          JSON.stringify({
            bytes: Buffer.from('wrong').toString('base64'),
            sha256: 'wrong',
          }),
        );
      try {
        if (
          failure === 'sharing exhaustion' ||
          failure === 'failed temporary unlink'
        ) {
          expect(() => authority.apply(batch)).toThrow();
          expect(() => authority.apply(batch)).toThrow();
          expect(readFileSync(recordFile(), 'utf8')).toBe(before);
          expect(hits).toBe(failure === 'sharing exhaustion' ? 10 : 4);
        } else if (failure === 'damaged-copy pruning') {
          expect(repository.load('proj', 'wt', 'recover').kind).toBe('absent');
          expect(hits).toBeGreaterThan(0);
        } else {
          authority.dispose(); // The helper is qualified only as offline recovery.
          expect(() => repository.takeLegacyBackup('proj', 'wt')).toThrow();
          expect(() => repository.takeLegacyBackup('proj', 'wt')).toThrow();
          expect(readFileSync(recordFile(), 'utf8')).toBe(before);
          if (failure !== 'backup validation') expect(hits).toBe(2);
        }
      } finally {
        for (const spy of spies.reverse()) spy.mockRestore();
      }
      if (
        failure === 'sharing exhaustion' ||
        failure === 'failed temporary unlink'
      ) {
        expect(authority.apply(batch).outcome).toBe('applied');
        expect(make().apply(batch).outcome).toBe('duplicate');
        expect(make().historyRead({ client, terminalId: 't' }).text).toBe(
          'before\nafter',
        );
      } else if (failure === 'damaged-copy pruning') {
        expect(
          make()
            .open(client)
            .terminals.map((entry) => entry.session.id),
        ).toEqual(['t']);
      } else if (failure !== 'backup validation') {
        expect(repository.takeLegacyBackup('proj', 'wt')).toEqual(
          readFileSync(legacy),
        );
        expect(existsSync(recordFile())).toBe(false);
      }
    },
  );

  it.each(recordFaultScenes)(
    '%s recovers each reached fault without private-state inspection',
    (name) => {
      const trace = new RecordFaults(join(root, 'trace'));
      let reached: FaultEvent[];
      try {
        const scene = recordFaultScene(name, join(root, 'trace'), trace);
        trace.install();
        expect(trace.run(scene.attempt).error).toBeUndefined();
        reached = faultRows(name, trace.events);
        scene.recover();
        scene.verify();
      } finally {
        trace.restore();
      }
      expect(reached.length).toBeGreaterThan(0);
      for (const [index, target] of reached.entries()) {
        for (const persistent of name === 'producer publication' ||
        name === 'retirement cleanup'
          ? [false, true]
          : [true]) {
          const directory = join(root, `${index}-${persistent}`);
          const faults = new RecordFaults(directory);
          faults.target = target;
          faults.persistent = persistent;
          try {
            const scene = recordFaultScene(name, directory, faults);
            faults.install();
            const persistentDirectoryFlush =
              (name === 'producer publication' ||
                name === 'retirement cleanup') &&
              persistent &&
              target.operation === 'directory.flush';
            const hardProducerFault =
              name === 'producer publication' &&
              ([
                'admission',
                'mkdir',
                'open',
                'write',
                'file.sync',
                'close',
                'rename',
              ].includes(target.operation) ||
                target.operation === 'directory.flush');
            const verifyProducerFailure = (result: {
              result?: unknown;
              error?: unknown;
            }): void => {
              expect(result.error).toBeDefined();
              expect(result.result).toBeUndefined();
              if (target.phase === 'publication') {
                if (persistent) {
                  expect(scene.verifyUnconfirmed).toBeDefined();
                  scene.verifyUnconfirmed?.();
                }
              } else {
                expect(scene.verifyUnpublished).toBeDefined();
                scene.verifyUnpublished?.();
              }
            };
            const first = faults.run(scene.attempt);
            expect(faults.hits).toBeGreaterThan(0);
            if (hardProducerFault) verifyProducerFailure(first);
            const firstHits = faults.hits;
            const second = faults.run(scene.attempt);
            if (hardProducerFault && persistent) verifyProducerFailure(second);
            if (persistentDirectoryFlush) {
              expect(first.error).toBeDefined();
              expect(first.result).toBeUndefined();
              expect(second.error).toBeDefined();
              expect(second.result).toBeUndefined();
              expect(faults.hits).toBeGreaterThan(firstHits);
            }
            faults.target = undefined;
            faults.latchedDirectory = undefined;
            if (
              persistentDirectoryFlush &&
              target.phase === 'publication' &&
              name === 'producer publication'
            ) {
              expect(scene.confirmDuplicate).toBeDefined();
              scene.confirmDuplicate?.();
            }
            scene.recover();
            scene.verify();
          } catch (error) {
            throw new Error(
              `${name} ${JSON.stringify(target)} persistent=${persistent}`,
              { cause: error },
            );
          } finally {
            faults.restore();
          }
        }
      }
    },
  );
});

describe('R31 retry identity and cold admission', () => {
  it.each([
    {},
    { incarnation: 'inc-1' },
    { incarnation: null },
    { lifetimeIds: [] },
    { worktreeIds: ['wt'] },
  ])('rejects retirement without immutable selection %j', (selector) => {
    expect(
      WorkerTerminalRecordRetireParamsSchema.safeParse({
        projectId: 'proj',
        ...selector,
      }).success,
    ).toBe(false);
  });
  it.each(
    [
      { generation: 1 },
      { lifetimeIds: ['old'] },
      { lifetimeIds: ['old'], incarnation: 'inc-1' },
      { lifetimeIds: ['old'], incarnation: null },
      { requestedAt: 20 },
      { requestedAt: 20, incarnation: 'inc-1' },
      { requestedAt: 20, lifetimeIds: ['old'] },
      {
        requestedAt: 20,
        lifetimeIds: ['old'],
        incarnation: 'inc-1',
        generation: 1,
      },
    ].flatMap((selector) => [
      { ...selector, worktreeId: 'wt' },
      { ...selector, worktreeIds: ['wt', 'pending'] },
    ]),
  )('keeps successor history after a lost retirement reply %j', (selector) => {
    let now = 10;
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (): void => undefined,
      now: (): number => now,
    });
    const authority = new TerminalRecordAuthority({
      repository,
      now: (): number => now,
    });
    authority.open({ ...client, lifetimeId: 'old' });
    const intent = WorkerTerminalRecordRetireParamsSchema.parse({
      projectId: 'proj',
      ...selector,
    });
    expect(authority.retire(intent).retired).toBeGreaterThan(0);
    now = 30;
    const next = { ...client, lifetimeId: 'next' };
    authority.open(next);
    authority.apply({
      client: next,
      producer: { id: 'p', runId: 'r' },
      seq: 1,
      ops: [
        { op: 'session.upsert', session: session('t') },
        { op: 'output.append', terminalId: 't', text: 'successor' },
      ],
    });
    authority.dispose();
    const reload = make();
    reload.retire(intent);
    expect(reload.historyRead({ client: next, terminalId: 't' }).text).toBe(
      'successor',
    );
    expect(make().historyRead({ client: next, terminalId: 't' }).text).toBe(
      'successor',
    );
  });
  it.each(['open', 'apply', 'attribute'] as const)(
    'checks fences before cold %s recovery even if quarantine would fail',
    (operation) => {
      const directory = dirname(recordFile());
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'tombstone.json'),
        JSON.stringify({
          generation: 2,
          incarnation: 'inc-1',
          retiredAt: 10,
          retiredLifetimeIds: ['old'],
        }),
      );
      writeFileSync(recordFile(), '{malformed');
      writeFileSync(join(directory, 'record.json.damaged-old'), 'recovery');
      const before = readdirSync(directory)
        .sort()
        .map((name) => [
          name,
          readFileSync(join(directory, name)).toString('hex'),
        ]);
      const rename = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('quarantine unavailable R31');
      });
      const stale = { ...client, generation: 1, lifetimeId: 'old' };
      const authority = make();
      if (operation === 'open')
        expect(authority.open(stale).generation).toBe(1);
      else if (operation === 'apply')
        expect(
          authority.apply({
            client: stale,
            producer: { id: 'p', runId: 'r' },
            seq: 1,
            ops: [],
          }).outcome,
        ).toBe('dropped');
      else
        authority.attribute({
          terminalId: 't',
          client: stale,
          session: session('t'),
          persist: true,
        });
      expect(rename).not.toHaveBeenCalled();
      expect(
        readdirSync(directory)
          .sort()
          .map((name) => [
            name,
            readFileSync(join(directory, name)).toString('hex'),
          ]),
      ).toEqual(before);
    },
  );
  it.each([false, true])(
    'reloads qualified cleanup debt beside a successor (recovered=%s)',
    (recovered) => {
      const authority = make();
      authority.open({ ...client, lifetimeId: 'old' });
      const backup = join(dirname(recordFile()), 'import-source.json');
      writeFileSync(backup, 'predecessor backup');
      const remove = fs.rmSync;
      const blocked = jest
        .spyOn(fs, 'rmSync')
        .mockImplementation((path, options) => {
          if (path === backup) throw new Error('cleanup blocked R31');
          remove(path, options);
        });
      expect(() =>
        authority.retire({
          projectId: 'proj',
          worktreeId: 'wt',
          generation: 1,
        }),
      ).toThrow('cleanup blocked R31');
      authority.dispose();
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      if (recovered) {
        const damaged = readJsonObject(recordFile());
        damaged.revision = 'damaged';
        writeFileSync(recordFile(), JSON.stringify(damaged));
        repository.load('proj', 'wt', 'recover');
      }
      blocked.mockRestore();
      const next = { ...client, generation: 2, lifetimeId: 'next' };
      const successor = new TerminalRecordAuthority({ repository });
      successor.open(next);
      successor.apply({
        client: next,
        producer: { id: 'p', runId: 'r' },
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('t') },
          { op: 'output.append', terminalId: 't', text: 'successor' },
        ],
      });
      successor.dispose();
      expect(existsSync(backup)).toBe(true);
      const retry = make();
      expect(
        retry.retire({ projectId: 'proj', worktreeId: 'wt', generation: 1 }),
      ).toEqual({ retired: 0 });
      expect(existsSync(backup)).toBe(false);
      expect(retry.historyRead({ client: next, terminalId: 't' }).text).toBe(
        'successor',
      );
    },
  );
  it.each([
    { generation: 1 },
    { generation: 3, lifetimeId: 'old' },
    { lifetimeId: 'old' },
  ])('projects damaged-record fences before stale admission %j', (selector) => {
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (): void => undefined,
    });
    const envelope = repository.empty({ ...client, generation: 2 }, 'none');
    envelope.retiredLifetimeIds = ['old'];
    repository.save(envelope);
    writeFileSync(
      recordFile(),
      JSON.stringify({ ...envelope, revision: 'damaged' }),
    );
    const before = readFileSync(recordFile());
    const rename = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('quarantine unavailable R31');
    });
    const stale = { ...client, ...selector };
    for (const operation of ['open', 'apply', 'attribute']) {
      const authority = make();
      if (operation === 'open')
        expect(authority.open(stale).terminals).toEqual([]);
      else if (operation === 'apply')
        expect(
          authority.apply({
            client: stale,
            producer: { id: 'p', runId: 'r' },
            seq: 1,
            ops: [],
          }).outcome,
        ).toBe('dropped');
      else
        authority.attribute({
          terminalId: 't',
          client: stale,
          session: session('t'),
          persist: true,
        });
    }
    expect(rename).not.toHaveBeenCalled();
    expect(readdirSync(dirname(recordFile()))).toEqual(['record.json']);
    expect(readFileSync(recordFile())).toEqual(before);
  });
});

describe('R35 an incarnation filter only narrows a retirement', () => {
  const current = { ...client, lifetimeId: 'current' };
  const intent = WorkerTerminalRecordRetireParamsSchema.parse({
    projectId: 'proj',
    worktreeId: 'wt',
    lifetimeIds: ['old'],
    incarnation: client.incarnation,
  });
  // The repository destroys unless its fifth argument is false.
  const destroying = (
    spy: jest.SpiedFunction<TerminalRecordRepository['retire']>,
  ): Parameters<TerminalRecordRepository['retire']>[] =>
    // Only a tombstone without its own cleanup set snapshots artifacts to delete.
    spy.mock.calls.filter((call) => call[2].cleanupFiles === undefined);

  it.each(['cached', 'cold'] as const)(
    "a delayed %s retirement of an old lifetime keeps another lifetime's history",
    (mode) => {
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      const writer = new TerminalRecordAuthority({ repository });
      writer.open(current);
      writer.apply({
        client: current,
        producer: { id: 'p', runId: 'r' },
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('t') },
          { op: 'output.append', terminalId: 't', text: 'current history' },
        ],
      });
      writer.flushSync();
      if (mode === 'cold') writer.dispose();
      const authority =
        mode === 'cached'
          ? writer
          : new TerminalRecordAuthority({ repository });
      const retiring = jest.spyOn(repository, 'retire');
      expect(authority.retire(intent)).toEqual({ retired: 1 });
      expect(destroying(retiring)).toEqual([]);
      expect(
        authority.historyRead({ client: current, terminalId: 't' }).text,
      ).toBe('current history');
      authority.flushSync();
      authority.dispose();
      const reload = new TerminalRecordAuthority({ repository });
      expect(reload.retire(intent)).toEqual({ retired: 1 });
      expect(destroying(retiring)).toEqual([]);
      expect(
        reload.historyRead({ client: current, terminalId: 't' }).text,
      ).toBe('current history');
      expect(
        make().historyRead({ client: current, terminalId: 't' }).text,
      ).toBe('current history');
      expect(record()).toMatchObject({
        generation: 1,
        incarnation: client.incarnation,
        retiredLifetimeIds: ['old'],
      });
      expect(
        make().apply({
          client: { ...client, lifetimeId: 'old' },
          producer: { id: 'old', runId: 'late' },
          seq: 1,
          ops: [{ op: 'output.append', terminalId: 't', text: '-old' }],
        }).outcome,
      ).toBe('dropped');
    },
  );

  it('retains unproven artifacts of an absent scope', (): void => {
    const directory = dirname(recordFile());
    mkdirSync(directory, { recursive: true });
    const artifact = join(directory, 'record.json.damaged-1');
    writeFileSync(artifact, 'unproven history');
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (): void => undefined,
    });
    const retiring = jest.spyOn(repository, 'retire');
    for (let attempt = 0; attempt < 2; attempt += 1)
      expect(
        new TerminalRecordAuthority({ repository }).retire(intent),
      ).toEqual({ retired: 1 });
    expect(destroying(retiring)).toEqual([]);
    expect(readFileSync(artifact, 'utf8')).toBe('unproven history');
    expect(repository.load('proj', 'wt')).toMatchObject({
      kind: 'absent',
      tombstone: {
        generation: 0,
        namedOnly: true,
        retiredLifetimeIds: ['old'],
      },
    });
    // Names-only coverage fences no generation: a new lifetime starts at one.
    expect(make().open(current).generation).toBe(1);
  });

  it("does not make the preserved record a waiting successor's predecessor", (): void => {
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (): void => undefined,
    });
    const writer = new TerminalRecordAuthority({ repository });
    writer.open(current);
    writer.apply({
      client: current,
      producer: { id: 'p', runId: 'r' },
      seq: 1,
      ops: [
        { op: 'session.upsert', session: session('t') },
        { op: 'output.append', terminalId: 't', text: 'current history' },
      ],
    });
    writer.flushSync();
    writer.dispose();
    const authority = new TerminalRecordAuthority({ repository });
    const next = { ...client, incarnation: 'inc-2' };
    const restore = failReads();
    try {
      authority.attribute({
        terminalId: 'held',
        client: next,
        session: session('held'),
        persist: true,
      });
      authority.output('held', Buffer.from('held'));
    } finally {
      restore();
    }
    const retiring = jest.spyOn(repository, 'retire');
    expect(authority.retire(intent)).toEqual({ retired: 1 });
    authority.open(current);
    authority.flushSync();
    expect(destroying(retiring)).toEqual([]);
    expect(record()).toMatchObject({
      generation: 1,
      incarnation: client.incarnation,
    });
    expect(make().historyRead({ client: current, terminalId: 't' }).text).toBe(
      'current history',
    );
  });

  it.each([
    ['is newer than the named generation', { generation: 1 }, 2],
    ['started after the request', { requestedAt: 0 }, 1],
    [
      'belongs to another incarnation',
      { generation: 1, incarnation: 'inc-9' },
      1,
    ],
  ] as const)(
    "a record that %s is not a waiting successor's predecessor",
    (_, selector, generation): void => {
      const repository = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      });
      const writer = new TerminalRecordAuthority({ repository });
      if (generation === 2) {
        writer.open({ ...client, lifetimeId: 'first' });
        writer.retire({ projectId: 'proj', worktreeId: 'wt', generation: 1 });
      }
      writer.open(current);
      writer.apply({
        client: current,
        producer: { id: 'p', runId: 'r' },
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('t') },
          { op: 'output.append', terminalId: 't', text: 'current history' },
        ],
      });
      writer.flushSync();
      writer.dispose();
      expect(record()).toMatchObject({
        generation,
        incarnation: client.incarnation,
      });
      const authority = new TerminalRecordAuthority({ repository });
      const restore = failReads();
      try {
        authority.attribute({
          terminalId: 'held',
          client: { ...client, incarnation: 'inc-2' },
          session: session('held'),
          persist: true,
        });
        authority.output('held', Buffer.from('held'));
      } finally {
        restore();
      }
      const retiring = jest.spyOn(repository, 'retire');
      expect(
        authority.retire(
          WorkerTerminalRecordRetireParamsSchema.parse({
            projectId: 'proj',
            worktreeId: 'wt',
            incarnation: client.incarnation,
            ...selector,
          }),
        ),
      ).toEqual({ retired: 0 });
      authority.open(current);
      authority.flushSync();
      expect(destroying(retiring)).toEqual([]);
      expect(record()).toMatchObject({
        generation,
        incarnation: client.incarnation,
      });
      expect(
        make().historyRead({ client: current, terminalId: 't' }).text,
      ).toBe('current history');
    },
  );
});

describe('R36 retirement publication, retry scope and directory durability', () => {
  afterEach(() => jest.useRealTimers());

  const heldEntry = ():
    | TerminalRecordEnvelope['record']['terminals'][number]
    | undefined =>
    record().record.terminals.find((entry) => entry.session.id === 'held');

  it.each(['the same coverage', 'another lifetime'] as const)(
    'an old-generation retirement retry naming %s keeps the inherited successor handle',
    (retry) => {
      jest.useFakeTimers();
      make().open(client);
      const authority = make();
      const requested = {
        ...client,
        incarnation: 'inc-2',
        generation: 9,
        lifetimeId: 'held',
      };
      const release = failReads();
      try {
        authority.attribute({
          terminalId: 'held',
          client: requested,
          session: session('held'),
          persist: true,
        });
        authority.output('held', Buffer.from('prefix'));
      } finally {
        release();
      }
      authority.attribute({
        terminalId: 'anchor',
        client: requested,
        session: session('anchor'),
        persist: true,
      });
      // The recreated host terminal inherits its own retired name in generation 2.
      authority.attribute({
        terminalId: 'held',
        client: { ...requested, generation: undefined },
        session: session('held'),
        persist: true,
      });
      authority.output('held', Buffer.from('-suffix'));
      authority.flushSync();
      expect(record()).toMatchObject({ generation: 2 });
      expect(record().retiredLifetimeIds).toContain('held');
      expect(
        authority.retire({
          projectId: 'proj',
          worktreeId: 'wt',
          generation: 1,
          lifetimeIds:
            retry === 'the same coverage' ? ['held'] : ['held', 'other'],
        }),
      ).toEqual({ retired: retry === 'the same coverage' ? 1 : 0 });
      expect(authority.isAttributed('held')).toBe(true);
      authority.output('held', Buffer.from('-after'));
      authority.exited('held', 5, null);
      authority.exited('anchor', 0, null);
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      expect(record().generation).toBe(2);
      expect(heldEntry()).toMatchObject({
        scrollbackLines: ['-suffix-after'],
        exitCode: 5,
        signal: null,
      });
      if (retry === 'another lifetime')
        expect(record().retiredLifetimeIds).toContain('other');
    },
  );

  it('a cutoff retirement retry leaves a worktree it discovers later importable', () => {
    const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 2,
        lineage: 'discovered-later',
        bindings: [],
        terminalCustomNames: {},
        terminals: [
          {
            session: session('legacy'),
            scrollbackLines: ['legacy history'],
            exitCode: 0,
            signal: null,
          },
        ],
      }),
    );
    let now = 100;
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      now: (): number => now,
      flushDirectorySync: (): void => undefined,
    });
    const authority = new TerminalRecordAuthority({
      repository,
      now: (): number => now,
    });
    const intent = { projectId: 'proj', requestedAt: 100 };
    expect(authority.retire(intent)).toEqual({ retired: 0 });
    now = 200;
    const release = failReads();
    try {
      const held = authority.attribute({
        terminalId: 'held',
        client,
        session: session('held'),
        persist: true,
      });
      authority.output(held, Buffer.from('held after the request'));
      authority.exited(held, 7, null);
    } finally {
      release();
    }
    now = 300;
    // The retry names no worktree, so it reaches neither the held reports nor
    // the legacy history.
    authority.retire(intent);
    // Held reports resolve on their own, without waiting for an open.
    expect(() => authority.shutdown('app-quit')).not.toThrow();
    expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
    const reload = make();
    const opened = reload.open(client);
    expect(opened.generation).toBe(1);
    expect(opened.import.from).toBe('v2');
    expect(opened.terminals.map((entry) => entry.session.id).sort()).toEqual([
      'held',
      'legacy',
    ]);
    expect(reload.historyRead({ client, terminalId: 'legacy' }).text).toBe(
      'legacy history',
    );
    expect(reload.historyRead({ client, terminalId: 'held' }).text).toBe(
      'held after the request',
    );
    expect(
      opened.terminals.find((entry) => entry.session.id === 'held'),
    ).toMatchObject({ exitCode: 7, signal: null });
  });

  it('a generation retirement retry keeps a held successor requested after its fence', () => {
    let now = 100;
    const repository = (): TerminalRecordRepository =>
      new TerminalRecordRepository({
        dataRoot: root,
        now: (): number => now,
        flushDirectorySync: (): void => undefined,
      });
    const first = new TerminalRecordAuthority({
      repository: repository(),
      now: (): number => now,
    });
    first.open({ ...client, lifetimeId: 'first' });
    const intent = { projectId: 'proj', worktreeId: 'wt', generation: 1 };
    expect(first.retire(intent)).toEqual({ retired: 1 });
    first.dispose();
    now = 200;
    const authority = new TerminalRecordAuthority({
      repository: repository(),
      now: (): number => now,
    });
    const next = { ...client, lifetimeId: 'next' };
    const release = failReads();
    try {
      const held = authority.attribute({
        terminalId: 'next',
        client: next,
        session: session('next'),
        persist: true,
      });
      authority.output(held, Buffer.from('successor output'));
      authority.exited(held, 3, null);
    } finally {
      release();
    }
    now = 300;
    expect(authority.retire(intent)).toEqual({ retired: 1 });
    expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
    const reload = make();
    expect(reload.open(next).generation).toBe(2);
    expect(reload.historyRead({ client: next, terminalId: 'next' }).text).toBe(
      'successor output',
    );
    expect(record().retiredLifetimeIds ?? []).not.toContain('next');
  });

  it.each(['flush', 'timer'] as const)(
    'named coverage published by a %s after a failure before rename retires the live handle',
    (publisher) => {
      jest.useFakeTimers();
      const authority = make();
      authority.open({ ...client, lifetimeId: 'first' });
      authority.retire({ projectId: 'proj', worktreeId: 'wt', generation: 1 });
      const live = { ...client, lifetimeId: 'live' };
      authority.open(live);
      authority.attribute({
        terminalId: 'held',
        client: live,
        session: session('held'),
        persist: true,
      });
      authority.output('held', Buffer.from('before'));
      authority.flushSync();
      expect(record().generation).toBe(2);
      const rename = fs.renameSync;
      let blocked = true;
      jest.spyOn(fs, 'renameSync').mockImplementation((from, to): void => {
        if (blocked && to === recordFile()) {
          blocked = false;
          throw Object.assign(new Error('rename unavailable'), { code: 'EIO' });
        }
        rename(from, to);
      });
      expect(() =>
        authority.retire({
          projectId: 'proj',
          worktreeId: 'wt',
          generation: 1,
          lifetimeIds: ['live'],
        }),
      ).toThrow();
      expect(record().retiredLifetimeIds ?? []).not.toContain('live');
      // Unpublished coverage leaves the handle writable rather than dropping output.
      expect(authority.isAttributed('held')).toBe(true);
      authority.output('held', Buffer.from('-meanwhile'));
      if (publisher === 'flush') authority.flushSync();
      else jest.advanceTimersByTime(1_000);
      expect(record().retiredLifetimeIds).toContain('live');
      expect(authority.isAttributed('held')).toBe(false);
      authority.output('held', Buffer.from('-retired'));
      authority.exited('held', 9, null);
      authority.flushSync();
      expect(record().generation).toBe(2);
      expect(heldEntry()).toMatchObject({
        scrollbackLines: ['before-meanwhile'],
        exitCode: null,
        signal: null,
      });
      expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
    },
  );

  it('direct named coverage retires the live handle after its rename', () => {
    const authority = make();
    authority.open({ ...client, lifetimeId: 'first' });
    authority.retire({ projectId: 'proj', worktreeId: 'wt', generation: 1 });
    const live = { ...client, lifetimeId: 'live' };
    authority.open(live);
    authority.attribute({
      terminalId: 'held',
      client: live,
      session: session('held'),
      persist: true,
    });
    authority.output('held', Buffer.from('before'));
    expect(
      authority.retire({
        projectId: 'proj',
        worktreeId: 'wt',
        generation: 1,
        lifetimeIds: ['live'],
      }),
    ).toEqual({ retired: 0 });
    expect(authority.isAttributed('held')).toBe(false);
    authority.output('held', Buffer.from('-retired'));
    authority.exited('held', 9, null);
    authority.flushSync();
    expect(heldEntry()).toMatchObject({
      scrollbackLines: ['before'],
      exitCode: null,
    });
  });
});

describe('R36 a recreated record directory', () => {
  it('syncs its ancestors again after a failed ancestor sync before acknowledging', () => {
    const directory = terminalRecordDir(root, 'proj', 'wt');
    const flushed: string[] = [];
    let failAncestor = false;
    const repository = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (path): void => {
        if (failAncestor && path === dirname(directory)) {
          failAncestor = false;
          throw Object.assign(new Error('ancestor sync failed'), {
            code: 'EIO',
          });
        }
        flushed.push(path);
      },
    });
    const authority = new TerminalRecordAuthority({ repository });
    const producer = { id: 'p', runId: 'recreated' };
    authority.apply({
      client,
      producer,
      seq: 1,
      ops: [{ op: 'session.upsert', session: session('t') }],
    });
    rmSync(directory, { recursive: true, force: true });
    failAncestor = true;
    const batch = {
      client,
      producer,
      seq: 2,
      ops: [{ op: 'output.append' as const, terminalId: 't', text: 'kept' }],
    };
    expect(() => authority.apply(batch)).toThrow();
    expect(failAncestor).toBe(false);
    flushed.length = 0;
    expect(authority.apply(batch).outcome).toBe('applied');
    const ancestor = flushed.indexOf(dirname(directory));
    expect(ancestor).toBeGreaterThanOrEqual(0);
    expect(flushed.lastIndexOf(directory)).toBeGreaterThan(ancestor);
    expect(make().historyRead({ client, terminalId: 't' }).text).toBe('kept');
  });
});

describe('R36 retry scope with a generation and resumed discharge', () => {
  afterEach(() => jest.useRealTimers());

  const clocked = (clock: { now: number }): TerminalRecordAuthority =>
    new TerminalRecordAuthority({
      repository: new TerminalRecordRepository({
        dataRoot: root,
        now: (): number => clock.now,
        flushDirectorySync: (): void => undefined,
      }),
      now: (): number => clock.now,
    });

  /** Fails every discharge pass while `failing` is set. */
  const failDischarges = (
    authority: TerminalRecordAuthority,
  ): { failing: boolean } => {
    const control = { failing: true };
    const discharge: unknown = Reflect.get(authority, 'discharge');
    if (typeof discharge !== 'function')
      throw new Error('Expected authority method discharge');
    Reflect.set(authority, 'discharge', (...args: unknown[]): unknown => {
      if (control.failing) throw new Error('discharge failed');
      const result: unknown = Reflect.apply(discharge, authority, args);
      return result;
    });
    return control;
  };

  it('a generation and cutoff retry leaves a worktree it discovers through held reports importable', () => {
    const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 2,
        lineage: 'discovered-later',
        bindings: [],
        terminalCustomNames: {},
        terminals: [
          {
            session: session('legacy'),
            scrollbackLines: ['legacy history'],
            exitCode: 0,
            signal: null,
          },
        ],
      }),
    );
    const clock = { now: 100 };
    const authority = clocked(clock);
    const intent = {
      projectId: 'proj',
      generation: 1,
      requestedAt: 100,
      lifetimeIds: ['gone'],
    };
    expect(authority.retire(intent)).toEqual({ retired: 0 });
    clock.now = 200;
    const next = { ...client, lifetimeId: 'next' };
    const release = failReads();
    try {
      const held = authority.attribute({
        terminalId: 'held',
        client: next,
        session: session('held'),
        persist: true,
      });
      authority.output(held, Buffer.from('held after the request'));
      authority.exited(held, 7, null);
    } finally {
      release();
    }
    clock.now = 300;
    // The retry names no worktree, so it reaches neither the held reports nor
    // the legacy history.
    authority.retire(intent);
    // Held reports resolve on their own, without waiting for an open.
    expect(() => authority.shutdown('app-quit')).not.toThrow();
    expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
    const reload = make();
    const opened = reload.open(next);
    expect(opened.generation).toBe(1);
    expect(opened.import.from).toBe('v2');
    expect(reload.historyRead({ client: next, terminalId: 'held' }).text).toBe(
      'held after the request',
    );
    expect(
      reload.historyRead({ client: next, terminalId: 'legacy' }).text,
    ).toBe('legacy history');
  });

  it('a named retirement retry resumes a discharge that failed after its rename', () => {
    jest.useFakeTimers();
    const authority = make();
    authority.open({ ...client, lifetimeId: 'first' });
    authority.retire({ projectId: 'proj', worktreeId: 'wt', generation: 1 });
    const live = { ...client, lifetimeId: 'live' };
    authority.open(live);
    authority.attribute({
      terminalId: 'held',
      client: live,
      session: session('held'),
      persist: true,
    });
    authority.output('held', Buffer.from('before'));
    authority.flushSync();
    const control = failDischarges(authority);
    const intent = {
      projectId: 'proj',
      worktreeId: 'wt',
      generation: 1,
      lifetimeIds: ['live'],
    };
    authority.retire(intent);
    expect(record().retiredLifetimeIds).toContain('live');
    // A failed discharge leaves the handle writable rather than refusing it.
    expect(authority.isAttributed('held')).toBe(true);
    control.failing = false;
    expect(authority.retire(intent)).toEqual({ retired: 1 });
    expect(authority.isAttributed('held')).toBe(false);
    authority.output('held', Buffer.from('-retired'));
    authority.flushSync();
    expect(
      record().record.terminals.find((entry) => entry.session.id === 'held'),
    ).toMatchObject({ scrollbackLines: ['before'] });
  });

  it('a fence retirement retry resumes the covered discharge that failed at publication', () => {
    const clock = { now: 50 };
    const authority = clocked(clock);
    const release = failReads();
    try {
      const held = authority.attribute({
        terminalId: 'early',
        client,
        session: session('early'),
        persist: true,
      });
      authority.output(held, Buffer.from('early output'));
      authority.exited(held, 0, null);
    } finally {
      release();
    }
    clock.now = 100;
    const control = failDischarges(authority);
    const intent = { projectId: 'proj', worktreeId: 'wt', requestedAt: 100 };
    expect(() => authority.retire(intent)).toThrow('discharge failed');
    control.failing = false;
    clock.now = 300;
    expect(authority.retire(intent)).toEqual({ retired: 1 });
    expect(() => authority.shutdown('app-quit')).not.toThrow();
    expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
    expect(existsSync(recordFile())).toBe(false);
  });
});

describe('R37 retirement reaches only named worktrees and observes before it publishes', () => {
  const seed = (
    worktreeId: string,
    lifetimeId: string,
    text: string,
  ): WorkerTerminalRecordClient => {
    const seeded = { ...client, worktreeId, lifetimeId };
    const writer = make();
    expect(
      writer.apply({
        client: seeded,
        producer: { id: lifetimeId, runId: 'one' },
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('t', { worktreeId }) },
          { op: 'output.append', terminalId: 't', text },
        ],
      }).outcome,
    ).toBe('applied');
    writer.flushSync();
    writer.dispose();
    return seeded;
  };
  // Strictly after every record started so far (CAN-7953: never a tie).
  const cutoff = (): number => {
    const written = Date.now();
    while (Date.now() <= written) {
      // Spin to the next millisecond.
    }
    return Date.now();
  };

  it.each([
    ['project', 'first attempt'],
    ['project', 'retry'],
    ['named', 'first attempt'],
    ['named', 'retry'],
  ] as const)(
    'a %s generation retirement on its %s leaves a later worktree at the same generation readable',
    (selection, timing): void => {
      const authority = make();
      const first = seed('wt', 'first', 'first history');
      expect(
        authority.historyRead({ client: first, terminalId: 't' }).text,
      ).toBe('first history');
      const intent = {
        projectId: 'proj',
        ...(selection === 'named' ? { worktreeIds: ['wt'] } : {}),
        generation: 1,
        // A project request's cutoff is its only bound, so it is captured
        // before the later worktree exists, as the producer captures it.
        requestedAt: selection === 'named' ? Date.now() + 60_000 : cutoff(),
        lifetimeIds: ['gone'],
      };
      const retired = 1;
      const later = (): WorkerTerminalRecordClient => {
        const created = seed('wt-later', 'later', 'later history');
        // A loaded scope is no more a target than one on disk.
        expect(
          authority.historyRead({ client: created, terminalId: 't' }).text,
        ).toBe('later history');
        return created;
      };
      const created = timing === 'first attempt' ? later() : undefined;
      expect(authority.retire(intent)).toEqual({ retired });
      const next = created ?? later();
      if (timing === 'retry')
        expect(authority.retire(intent)).toEqual({ retired });
      for (const reader of [authority, make()]) {
        expect(reader.historyRead({ client: next, terminalId: 't' }).text).toBe(
          'later history',
        );
        expect(
          reader.historyRead({ client: first, terminalId: 't' }).text,
        ).toBe('');
      }
      expect(
        existsSync(
          join(terminalRecordDir(root, 'proj', 'wt-later'), 'tombstone.json'),
        ),
      ).toBe(false);
      expect(make().open(next).generation).toBe(1);
    },
  );

  it('a project retirement reaches every worktree on disk, unloaded ones included, but no later record or bare directory (CAN-7704)', (): void => {
    const first = seed('wt', 'first', 'first history');
    const unloaded = seed('wt-unloaded', 'unloaded', 'unloaded history');
    mkdirSync(terminalRecordDir(root, 'proj', 'wt-bare'), { recursive: true });
    const requestedAt = Date.now() + 60_000;
    const later = seed('wt-later', 'later', 'later history');
    const laterFile = join(
      terminalRecordDir(root, 'proj', 'wt-later'),
      'record.json',
    );
    const envelope: unknown = JSON.parse(readFileSync(laterFile, 'utf8'));
    if (!isTerminalRecordEnvelope(envelope))
      throw new Error('Expected a record');
    // Started after the cutoff: a discovered record the request cannot reach.
    writeFileSync(
      laterFile,
      JSON.stringify({ ...envelope, startedAt: requestedAt + 1 }),
    );
    expect(
      make().retire({ projectId: 'proj', generation: 1, requestedAt }),
    ).toEqual({ retired: 2 });
    const reader = make();
    for (const retired of [first, unloaded])
      expect(
        reader.historyRead({ client: retired, terminalId: 't' }).text,
      ).toBe('');
    expect(reader.historyRead({ client: later, terminalId: 't' }).text).toBe(
      'later history',
    );
    for (const untouched of ['wt-later', 'wt-bare'])
      expect(
        existsSync(
          join(terminalRecordDir(root, 'proj', untouched), 'tombstone.json'),
        ),
      ).toBe(false);
  });

  it.each(['same authority', 'restarted authority'] as const)(
    'a project retirement retry by a %s finishes its first attempt and never fences a worktree created after it (CAN-7704)',
    (retrier): void => {
      const first = seed('wt', 'first', 'first history');
      const second = seed('wt-second', 'second', 'second history');
      const intent = {
        projectId: 'proj',
        generation: 1,
        requestedAt: cutoff(),
        lifetimeIds: ['gone'],
      };
      const authority = make();
      const rename = fs.renameSync;
      const secondTombstone = join(
        terminalRecordDir(root, 'proj', 'wt-second'),
        'tombstone.json',
      );
      const blocked = jest
        .spyOn(fs, 'renameSync')
        .mockImplementation((from, to): void => {
          if (to === secondTombstone) throw new Error('retirement blocked');
          rename(from, to);
        });
      try {
        expect(() => authority.retire(intent)).toThrow('retirement blocked');
      } finally {
        blocked.mockRestore();
      }
      expect(existsSync(secondTombstone)).toBe(false);
      // Same generation and a named lifetime: only the cutoff keeps it out.
      const later = seed('wt-later', 'gone', 'later history');
      const retrying = retrier === 'same authority' ? authority : make();
      expect(retrying.retire(intent)).toEqual({ retired: 2 });
      expect(retrying.retire(intent)).toEqual({ retired: 2 });
      const reader = make();
      for (const retired of [first, second])
        expect(
          reader.historyRead({ client: retired, terminalId: 't' }).text,
        ).toBe('');
      expect(reader.historyRead({ client: later, terminalId: 't' }).text).toBe(
        'later history',
      );
      expect(
        existsSync(
          join(terminalRecordDir(root, 'proj', 'wt-later'), 'tombstone.json'),
        ),
      ).toBe(false);
      expect(make().open(later).generation).toBe(1);
      // A retry re-lists the project; it persists no selection of its own.
      expect(
        readdirSync(dirname(terminalRecordDir(root, 'proj', 'wt'))).sort(),
      ).toEqual(['wt', 'wt-later', 'wt-second']);
    },
  );

  it.each(['same authority', 'restarted authority'] as const)(
    'a projectWide retry by a %s retires its named and discovered worktrees but never a later one (CAN-7704)',
    (retrier): void => {
      const unloaded = seed('wt-unloaded', 'unloaded', 'unloaded history');
      const intent = {
        projectId: 'proj',
        worktreeIds: ['wt', 'wt-pending'],
        projectWide: true as const,
        lifetimeIds: ['first'],
        requestedAt: cutoff(),
      };
      // Named, so its lifetime retires it although it started after the cutoff.
      const named = seed('wt', 'first', 'first history');
      const authority = make();
      const rename = fs.renameSync;
      const unloadedTombstone = join(
        terminalRecordDir(root, 'proj', 'wt-unloaded'),
        'tombstone.json',
      );
      const blocked = jest
        .spyOn(fs, 'renameSync')
        .mockImplementation((from, to): void => {
          if (to === unloadedTombstone) throw new Error('retirement blocked');
          rename(from, to);
        });
      try {
        expect(() => authority.retire(intent)).toThrow('retirement blocked');
      } finally {
        blocked.mockRestore();
      }
      // A named lifetime and generation: only the cutoff keeps it out.
      const later = seed('wt-later', 'first', 'later history');
      const retrying = retrier === 'same authority' ? authority : make();
      // wt, wt-unloaded and the recordless named wt-pending.
      expect(retrying.retire(intent)).toEqual({ retired: 3 });
      expect(retrying.retire(intent)).toEqual({ retired: 3 });
      const reader = make();
      for (const retired of [named, unloaded])
        expect(
          reader.historyRead({ client: retired, terminalId: 't' }).text,
        ).toBe('');
      expect(reader.historyRead({ client: later, terminalId: 't' }).text).toBe(
        'later history',
      );
      for (const [worktreeId, fenced] of [
        ['wt-unloaded', true],
        ['wt-pending', true],
        ['wt-later', false],
      ] as const)
        expect(
          existsSync(
            join(terminalRecordDir(root, 'proj', worktreeId), 'tombstone.json'),
          ),
        ).toBe(fenced);
    },
  );

  it.each([
    { generation: 1 },
    { generation: 1, lifetimeIds: ['first'] },
    { lifetimeIds: ['first'] },
  ])(
    'a retirement naming no worktree and no cutoff reaches no unnamed worktree (%j)',
    (selectors): void => {
      const first = seed('wt', 'first', 'first history');
      // Without a cutoff, nothing bounds a retry to the worktrees it first saw.
      expect(make().retire({ projectId: 'proj', ...selectors })).toEqual({
        retired: 0,
      });
      expect(
        existsSync(
          join(terminalRecordDir(root, 'proj', 'wt'), 'tombstone.json'),
        ),
      ).toBe(false);
      expect(make().historyRead({ client: first, terminalId: 't' }).text).toBe(
        'first history',
      );
    },
  );

  it('a retirement naming worktreeId and worktreeIds retires every named worktree', (): void => {
    const first = seed('wt', 'first', 'first history');
    const second = seed('wt-second', 'second', 'second history');
    const unnamed = seed('wt-unnamed', 'unnamed', 'unnamed history');
    expect(
      make().retire({
        projectId: 'proj',
        worktreeId: 'wt',
        worktreeIds: ['wt-second', 'wt'],
        generation: 1,
        requestedAt: Date.now() + 60_000,
      }),
    ).toEqual({ retired: 2 });
    const reader = make();
    expect(reader.historyRead({ client: first, terminalId: 't' }).text).toBe(
      '',
    );
    expect(reader.historyRead({ client: second, terminalId: 't' }).text).toBe(
      '',
    );
    expect(reader.historyRead({ client: unnamed, terminalId: 't' }).text).toBe(
      'unnamed history',
    );
  });

  it('a cutoff retirement of a named worktree with no record leaves its legacy history importable', (): void => {
    const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 2,
        lineage: 'named-cutoff',
        bindings: [],
        terminalCustomNames: {},
        terminals: [
          {
            session: session('legacy'),
            scrollbackLines: ['legacy history'],
            exitCode: 0,
            signal: null,
          },
        ],
      }),
    );
    const authority = make();
    const intent = { projectId: 'proj', worktreeId: 'wt', requestedAt: 100 };
    // Names-only coverage: the cutoff proves no lifetime of this scope.
    expect(authority.retire(intent)).toEqual({ retired: 1 });
    expect(authority.retire(intent)).toEqual({ retired: 1 });
    const opened = make().open(client);
    expect(opened.generation).toBe(1);
    expect(opened.import.from).toBe('v2');
    expect(make().historyRead({ client, terminalId: 'legacy' }).text).toBe(
      'legacy history',
    );
  });

  it('a failed named-only retirement over a damaged record keeps every recovery copy', (): void => {
    const directory = dirname(recordFile());
    mkdirSync(directory, { recursive: true });
    writeFileSync(recordFile(), '{malformed');
    const copies = [1, 2, 3, 4, 5].map((stamp): [string, string] => [
      join(directory, `record.json.damaged-${stamp}`),
      `recovery copy ${stamp}`,
    ]);
    for (const [path, text] of copies) writeFileSync(path, text);
    const tombstone = join(directory, 'tombstone.json');
    const untouched = (): void => {
      expect(readdirSync(directory).sort()).toEqual(
        [
          'record.json',
          ...copies.map(([path]): string => basename(path)),
          ...(existsSync(tombstone) ? ['tombstone.json'] : []),
        ].sort(),
      );
      expect(readFileSync(recordFile(), 'utf8')).toBe('{malformed');
      for (const [path, text] of copies)
        expect(readFileSync(path, 'utf8')).toBe(text);
    };
    const rename = fs.renameSync;
    let blocked = true;
    const renaming = jest
      .spyOn(fs, 'renameSync')
      .mockImplementation((from, to) => {
        if (blocked && String(to) === tombstone)
          throw Object.assign(new Error('tombstone blocked'), { code: 'EIO' });
        rename(from, to);
      });
    const authority = make();
    const intent = {
      projectId: 'proj',
      worktreeId: 'wt',
      lifetimeIds: ['old'],
    };
    try {
      expect(() => authority.retire(intent)).toThrow('tombstone blocked');
      expect(existsSync(tombstone)).toBe(false);
      untouched();
      blocked = false;
      expect(authority.retire(intent)).toEqual({ retired: 1 });
    } finally {
      renaming.mockRestore();
    }
    // Names-only coverage deletes nothing, even once it is published.
    expect(existsSync(tombstone)).toBe(true);
    untouched();
    expect(
      authority.apply({
        client: { ...client, lifetimeId: 'old' },
        producer: { id: 'old', runId: 'one' },
        seq: 1,
        ops: [{ op: 'session.upsert', session: session('old') }],
      }).outcome,
    ).toBe('dropped');
    // The successor's own write-authorized load sets the damaged record aside.
    expect(
      authority.apply({
        client: { ...client, lifetimeId: 'next' },
        producer: { id: 'next', runId: 'one' },
        seq: 1,
        ops: [
          { op: 'session.upsert', session: session('t') },
          { op: 'output.append', terminalId: 't', text: 'successor' },
        ],
      }).outcome,
    ).toBe('applied');
    expect(
      readdirSync(directory)
        .filter((name): boolean => name.startsWith('record.json.damaged-'))
        .map((name): string => readFileSync(join(directory, name), 'utf8')),
    ).toContain('{malformed');
    expect(
      make().historyRead({
        client: { ...client, lifetimeId: 'next' },
        terminalId: 't',
      }).text,
    ).toBe('successor');
  });
});

describe('R39 shutdown confirms every unconfirmed retirement fence', () => {
  const directory = (): string => terminalRecordDir(root, 'proj', 'wt');
  const intent = { projectId: 'proj', worktreeId: 'wt', lifetimeIds: ['gone'] };
  const blockable = (): {
    authority: TerminalRecordAuthority;
    block: (value: boolean) => void;
    syncs: () => number;
  } => {
    let blocked = false;
    let syncs = 0;
    const authority = new TerminalRecordAuthority({
      repository: new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (path): void => {
          if (path !== directory()) return;
          syncs += 1;
          if (blocked) throw new Error('fence sync blocked');
        },
      }),
    });
    return {
      authority,
      block: (value): void => {
        blocked = value;
      },
      syncs: (): number => syncs,
    };
  };

  it.each([
    ['an absent', 'shutdown'],
    ['an absent', 'retry'],
    ['a cold retired', 'shutdown'],
    ['a cold retired', 'retry'],
    ['a cached retired', 'shutdown'],
    ['a cached retired', 'retry'],
  ] as const)(
    'a names-only retirement of %s worktree whose sync fails is confirmed by a later %s',
    (state, confirmer): void => {
      if (state === 'a cold retired') {
        const earlier = make();
        earlier.open({ ...client, lifetimeId: 'first' });
        expect(
          earlier.retire({
            projectId: 'proj',
            worktreeId: 'wt',
            generation: 1,
          }),
        ).toEqual({ retired: 1 });
        earlier.dispose();
      }
      const { authority, block, syncs } = blockable();
      if (state === 'a cached retired') {
        authority.open({ ...client, lifetimeId: 'first' });
        expect(
          authority.retire({
            projectId: 'proj',
            worktreeId: 'wt',
            generation: 1,
          }),
        ).toEqual({ retired: 1 });
      }
      block(true);
      expect(() => authority.retire(intent)).toThrow('outcome unknown');
      // The fence is visible, so it already fences the named lifetime.
      expect(
        readJsonObject(join(directory(), 'tombstone.json')).retiredLifetimeIds,
      ).toContain('gone');
      const published = syncs();
      expect(() => authority.shutdown('app-quit')).toThrow(
        'fence sync blocked',
      );
      expect(syncs()).toBe(published + 1);
      block(false);
      if (confirmer === 'retry')
        expect(authority.retire(intent)).toEqual({ retired: 1 });
      else expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
      const confirmed = syncs();
      expect(confirmed).toBe(published + 2);
      // A confirmed fence leaves shutdown nothing to retry.
      block(true);
      expect(() => authority.shutdown('app-quit')).not.toThrow();
      expect(syncs()).toBe(confirmed);
    },
  );

  it('an already-covered retirement that releases held reports leaves a failed confirmation to shutdown', () => {
    const earlier = make();
    earlier.open({ ...client, lifetimeId: 'gone' });
    expect(
      earlier.retire({ projectId: 'proj', worktreeId: 'wt', generation: 1 }),
    ).toEqual({ retired: 1 });
    earlier.dispose();
    expect(
      readJsonObject(join(directory(), 'tombstone.json')).retiredLifetimeIds,
    ).toContain('gone');
    const { authority, block, syncs } = blockable();
    const spy = failReadsOf(join(directory(), 'tombstone.json'));
    authority.attribute({
      terminalId: 'held',
      client: { ...client, lifetimeId: 'gone' },
      session: session('held'),
      persist: true,
    });
    authority.output('held', Buffer.from('late output'));
    authority.exited('held', 0, null);
    spy.mockRestore();
    block(true);
    expect(() => authority.retire(intent)).toThrow('fence sync blocked');
    // The cold fence released the held reports before its confirmation failed.
    expect(() => authority.shutdown('app-quit')).toThrow('fence sync blocked');
    const failed = syncs();
    block(false);
    expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
    expect(syncs()).toBe(failed + 1);
    block(true);
    expect(() => authority.shutdown('app-quit')).not.toThrow();
    expect(syncs()).toBe(failed + 1);
    expect(existsSync(recordFile())).toBe(false);
  });

  it('a cached fence loaded from disk that releases held reports is confirmed at shutdown', () => {
    const earlier = make();
    earlier.open({ ...client, lifetimeId: 'gone' });
    expect(
      earlier.retire({ projectId: 'proj', worktreeId: 'wt', generation: 1 }),
    ).toEqual({ retired: 1 });
    expect(earlier.open({ ...client, lifetimeId: 'next' }).generation).toBe(2);
    earlier.dispose();
    const { authority, block, syncs } = blockable();
    const release = failReads();
    try {
      authority.attribute({
        terminalId: 'held',
        client: { ...client, lifetimeId: 'gone' },
        session: session('held'),
        persist: true,
      });
      authority.output('held', Buffer.from('late output'));
      authority.exited('held', 0, null);
    } finally {
      release();
    }
    const successor = readFileSync(recordFile(), 'utf8');
    block(true);
    // Shutdown's retry loads the successor beside its fence, which releases
    // the held reports; the fence's sync is still owed.
    expect(() => authority.shutdown('app-quit')).toThrow('fence sync blocked');
    expect(authority.isAttributed('held')).toBe(false);
    const failed = syncs();
    block(false);
    expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
    expect(syncs()).toBe(failed + 1);
    block(true);
    expect(() => authority.shutdown('app-quit')).not.toThrow();
    expect(readFileSync(recordFile(), 'utf8')).toBe(successor);
  });

  it('a cached fence loaded from disk that released nothing is still confirmed at shutdown', () => {
    const earlier = make();
    earlier.open({ ...client, lifetimeId: 'gone' });
    expect(
      earlier.retire({ projectId: 'proj', worktreeId: 'wt', generation: 1 }),
    ).toEqual({ retired: 1 });
    expect(earlier.open({ ...client, lifetimeId: 'next' }).generation).toBe(2);
    earlier.dispose();
    const { authority, block, syncs } = blockable();
    expect(authority.open({ ...client, lifetimeId: 'next' }).generation).toBe(
      2,
    );
    block(true);
    expect(() => authority.shutdown('app-quit')).toThrow('fence sync blocked');
    const failed = syncs();
    block(false);
    expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
    expect(syncs()).toBe(failed + 1);
    block(true);
    expect(() => authority.shutdown('app-quit')).not.toThrow();
    expect(syncs()).toBe(failed + 1);
  });

  it('an attribution retry that releases held reports against an uncached fence leaves its confirmation to shutdown', () => {
    const earlier = make();
    earlier.open({ ...client, lifetimeId: 'gone' });
    expect(
      earlier.retire({ projectId: 'proj', worktreeId: 'wt', generation: 1 }),
    ).toEqual({ retired: 1 });
    earlier.dispose();
    const { authority, block, syncs } = blockable();
    const spy = failReadsOf(join(directory(), 'tombstone.json'));
    authority.attribute({
      terminalId: 'held',
      client: { ...client, lifetimeId: 'gone' },
      session: session('held'),
      persist: true,
    });
    authority.output('held', Buffer.from('late output'));
    authority.exited('held', 0, null);
    spy.mockRestore();
    block(true);
    // Shutdown's retry reads the fence without caching its scope, and that
    // fence releases the held reports before its sync is confirmed.
    expect(() => authority.shutdown('app-quit')).toThrow('fence sync blocked');
    expect(authority.isAttributed('held')).toBe(false);
    const failed = syncs();
    block(false);
    expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
    expect(syncs()).toBe(failed + 1);
    block(true);
    expect(() => authority.shutdown('app-quit')).not.toThrow();
    expect(syncs()).toBe(failed + 1);
    expect(existsSync(recordFile())).toBe(false);
  });

  it('an attribution an uncached fence declares stale leaves that fence confirmation to shutdown', () => {
    const earlier = make();
    earlier.open({ ...client, lifetimeId: 'gone' });
    expect(
      earlier.retire({ projectId: 'proj', worktreeId: 'wt', generation: 1 }),
    ).toEqual({ retired: 1 });
    earlier.dispose();
    const { authority, block, syncs } = blockable();
    block(true);
    // The observed fence drops this terminal's reports without caching its scope.
    expect(
      authority.attribute({
        terminalId: 'held',
        client: { ...client, lifetimeId: 'gone' },
        session: session('held'),
        persist: true,
      }),
    ).toBeUndefined();
    expect(() => authority.shutdown('app-quit')).toThrow('fence sync blocked');
    const failed = syncs();
    block(false);
    expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
    expect(syncs()).toBe(failed + 1);
    block(true);
    expect(() => authority.shutdown('app-quit')).not.toThrow();
    expect(syncs()).toBe(failed + 1);
    expect(existsSync(recordFile())).toBe(false);
  });

  it('a durable fence publication confirms an earlier unconfirmed one without another sync', () => {
    let syncs = 0;
    const authority = new TerminalRecordAuthority({
      repository: new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (path): void => {
          if (path !== directory()) return;
          syncs += 1;
          // Only the second publication's own sync succeeds.
          if (syncs !== 2) throw new Error('fence sync blocked');
        },
      }),
    });
    expect(() => authority.retire(intent)).toThrow('outcome unknown');
    let later: { retired: number } | undefined;
    expect(() => {
      later = authority.retire({ ...intent, lifetimeIds: ['later'] });
    }).not.toThrow();
    expect(later).toEqual({ retired: 1 });
    expect(
      readJsonObject(join(directory(), 'tombstone.json')).retiredLifetimeIds,
    ).toEqual(['gone', 'later']);
    expect(syncs).toBe(2);
    expect(authority.shutdown('app-quit')).toEqual({ stamped: 0 });
    expect(syncs).toBe(2);
  });
});

describe('R41 decoder transfer, history joins and recovery copies', () => {
  it('a stale attribution leaves the held registration a split code point intact (R41)', () => {
    const retiring = make();
    retiring.open(client);
    retiring.retire({ projectId: 'proj', worktreeId: 'wt', generation: 1 });
    const generation = retiring.open(client).generation;
    retiring.flushSync();
    retiring.dispose();
    const authority = make();
    let blocked = true;
    const spy = jest.spyOn(TerminalRecordRepository.prototype, 'load');
    const load = spy.getMockImplementation();
    if (!load) throw new Error('Expected repository load implementation');
    spy.mockImplementation(function (this: TerminalRecordRepository, ...args) {
      if (blocked && args[1] === 'wt') throw new Error('EACCES');
      return load.apply(this, args);
    });
    // Held without a generation, so the stale attribution below is compatible.
    const handle = authority.attribute({
      terminalId: 't',
      client,
      session: session('t'),
      persist: true,
    });
    expect(handle).toBeDefined();
    authority.output(handle, Buffer.from('a'));
    authority.output(handle, Buffer.from([0xf0, 0x9f]));
    blocked = false;
    expect(
      authority.attribute({
        terminalId: 't',
        client: { ...client, generation: 1 },
        session: session('t'),
        persist: true,
      }),
    ).toBeUndefined();
    authority.output(handle, Buffer.from([0x98, 0x80]));
    authority.exited(handle, 0, null);
    authority.flushSync();
    expect(
      make().historyRead({
        client: { ...client, generation },
        terminalId: 't',
      }).text,
    ).toBe('a😀');
  });

  it.each(
    ['immediate', 'delayed'].flatMap((mode) =>
      ['split', 'whole'].map((chunks) => ({ mode, chunks })),
    ),
  )(
    'a clipped later line keeps the history join: $mode import, $chunks output (R41)',
    ({ mode, chunks }) => {
      const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
      mkdirSync(dirname(legacy), { recursive: true });
      writeFileSync(
        legacy,
        JSON.stringify({
          version: 2,
          lineage: 'join-lineage',
          bindings: [],
          terminalCustomNames: {},
          terminals: [
            {
              session: session('t'),
              scrollbackLines: ['old-prefix'],
              exitCode: null,
              signal: null,
            },
          ],
        }),
      );
      let blocked = mode === 'delayed';
      const read = fs.readFileSync;
      jest.spyOn(fs, 'readFileSync').mockImplementation((path, options) => {
        if (blocked && String(path) === legacy)
          throw Object.assign(new Error('temporarily unreadable'), {
            code: 'EACCES',
          });
        return read(path, options);
      });
      const authority = make();
      authority.attribute({
        terminalId: 't',
        client,
        session: session('t'),
        persist: true,
      });
      // One byte past the line cap clips the second line, not the first:
      // measured incrementally (split) and in one retention pass (whole).
      if (chunks === 'split') {
        authority.output('t', Buffer.from('-tail\n'));
        authority.output('t', Buffer.from('x'.repeat(1024 * 1024)));
        authority.output('t', Buffer.from('x'));
      } else
        authority.output(
          't',
          Buffer.from(`-tail\n${'x'.repeat(1024 * 1024 + 1)}`),
        );
      authority.flushSync();
      if (mode === 'delayed') expect(record().import.pending).toBe(true);
      else expect(record().import.pending).toBeUndefined();
      expect(record().record.truncatedHistoryIds).toBeUndefined();
      blocked = false;
      expect(authority.open(client).import.pending).toBeUndefined();
      expect(
        authority.historyRead({
          client,
          terminalId: 't',
          maxBytes: 4 * 1024 * 1024,
        }).text,
      ).toBe(`old-prefix-tail\n${'x'.repeat(1024 * 1024)}`);
    },
  );

  it.each(['damaged', 'v2'])(
    'import retries after post-rename sync failures keep one %s recovery image (R41)',
    (kind) => {
      const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
      mkdirSync(dirname(legacy), { recursive: true });
      const bytes =
        kind === 'damaged'
          ? '{damaged legacy'
          : JSON.stringify({
              version: 2,
              lineage: 'copies-lineage',
              bindings: [],
              terminalCustomNames: {},
              terminals: [
                {
                  session: session('t'),
                  scrollbackLines: ['legacy history'],
                  exitCode: null,
                  signal: null,
                },
              ],
            });
      writeFileSync(legacy, bytes);
      const directory = terminalRecordDir(root, 'proj', 'wt');
      let failures = 0;
      let recoveryRenamed = false;
      const rename = fs.renameSync;
      jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        const name = basename(String(to));
        recoveryRenamed =
          kind === 'damaged'
            ? name.startsWith('legacy-terminal-state.json.damaged-')
            : name === 'import-source.json';
        rename(from, to);
      });
      const authority = new TerminalRecordAuthority({
        repository: new TerminalRecordRepository({
          dataRoot: root,
          flushDirectorySync: (path): void => {
            if (recoveryRenamed && path === directory && failures < 12) {
              failures += 1;
              throw new Error('recovery copy sync blocked');
            }
          },
        }),
      });
      const recoveryCopies = (): string[] =>
        readdirSync(directory).filter((name): boolean =>
          name.startsWith('legacy-terminal-state.json.damaged-'),
        );
      for (let attempt = 0; attempt < 12; attempt += 1)
        expect(authority.open(client).import.pending).toBe(true);
      expect(failures).toBe(12);
      // Each retry reinstalls its own image; none adds a copy.
      expect(recoveryCopies()).toHaveLength(kind === 'damaged' ? 1 : 0);
      expect(authority.open(client).import).toMatchObject({ from: kind });
      expect(authority.open(client).import.pending).toBeUndefined();
      authority.dispose();
      const copies = recoveryCopies();
      if (kind === 'damaged') {
        expect(copies).toHaveLength(1);
        expect(readJsonObject(join(directory, copies[0]))).toEqual({
          bytes: Buffer.from(bytes).toString('base64'),
        });
      } else {
        expect(copies).toEqual([]);
        expect(
          new TerminalRecordRepository({
            dataRoot: root,
            flushDirectorySync: (): void => undefined,
          })
            .takeLegacyBackup('proj', 'wt')
            ?.toString(),
        ).toBe(bytes);
      }
      expect(readFileSync(legacy, 'utf8')).toBe(bytes);
    },
  );

  it.each(['damaged', 'v2'])(
    'a %s import removes byte-identical recovery copies only once its own image is durable (R41)',
    (kind) => {
      const legacy = legacyTerminalStatePath(root, 'workspaces', 'proj', 'wt');
      mkdirSync(dirname(legacy), { recursive: true });
      const bytes =
        kind === 'damaged'
          ? '{damaged legacy'
          : JSON.stringify({
              version: 2,
              lineage: 'duplicates-lineage',
              bindings: [],
              terminalCustomNames: {},
              terminals: [],
            });
      writeFileSync(legacy, bytes);
      const base64 = Buffer.from(bytes).toString('base64');
      const image = JSON.stringify(
        kind === 'damaged'
          ? { bytes: base64 }
          : {
              sha256: createHash('sha256').update(bytes).digest('hex'),
              bytes: base64,
              from: 'v2',
            },
      );
      const directory = terminalRecordDir(root, 'proj', 'wt');
      mkdirSync(directory, { recursive: true });
      const copy = (stamp: number): string =>
        `legacy-terminal-state.json.damaged-${stamp}`;
      // Duplicates an earlier build left, and one distinct recovery image.
      writeFileSync(join(directory, copy(1)), image);
      writeFileSync(join(directory, copy(2)), image);
      writeFileSync(join(directory, copy(3)), 'distinct recovery image');
      let blocked = true;
      const authority = new TerminalRecordAuthority({
        repository: new TerminalRecordRepository({
          dataRoot: root,
          flushDirectorySync: (path): void => {
            if (blocked && path === directory)
              throw new Error('recovery copy sync blocked');
          },
        }),
      });
      const recoveryCopies = (): string[] =>
        readdirSync(directory)
          .filter((name): boolean =>
            name.startsWith('legacy-terminal-state.json.damaged-'),
          )
          .sort();
      expect(authority.open(client).import.pending).toBe(true);
      expect(recoveryCopies()).toEqual([copy(1), copy(2), copy(3)]);
      blocked = false;
      expect(authority.open(client).import.pending).toBeUndefined();
      // A damaged import keeps the first identical copy as its own image.
      expect(recoveryCopies()).toEqual(
        kind === 'damaged' ? [copy(1), copy(3)] : [copy(3)],
      );
      if (kind === 'damaged')
        expect(readFileSync(join(directory, copy(1)), 'utf8')).toBe(image);
      else
        expect(
          readFileSync(join(directory, 'import-source.json'), 'utf8'),
        ).toBe(image);
      expect(readFileSync(join(directory, copy(3)), 'utf8')).toBe(
        'distinct recovery image',
      );
      expect(readFileSync(legacy, 'utf8')).toBe(bytes);
    },
  );
});
