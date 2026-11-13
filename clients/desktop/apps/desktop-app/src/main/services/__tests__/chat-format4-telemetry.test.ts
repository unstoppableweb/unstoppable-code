/**
 * Format 4 promotion telemetry (CAN-6217): every outcome sends exactly the
 * declared, content-free fields, and the repository reports format 4 under its
 * own local kinds, never the format 3 `delta_journal_*` ones.
 */
const startDesktopOperation = jest.fn();
const succeedDesktopOperation = jest.fn();

jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  startDesktopOperation: (...args: unknown[]): unknown =>
    startDesktopOperation(...args),
  succeedDesktopOperation: (...args: unknown[]): unknown =>
    succeedDesktopOperation(...args),
}));

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESKTOP_OPERATIONS } from '@canopy/desktop-instrumentation/operations';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { ChatStorageV2 } from '../../lib/chat-storage-v2';
import { ChatDeltaJournalIntegrityError } from '../../lib/chat-delta-journal/format';
import { ChatDeltaJournalWriter } from '../../lib/chat-delta-journal/writer';
import { ChatStateV2Backend } from '../chat-state-v2-backend';
import { ChatStateV2Repository } from '../chat-state-v2-repository';
import type { ChatStateV2RepositoryOptions } from '../chat-state-v2-repository';
import type { ChatStateStorageDiagnostic } from '../chat-state-contracts';
import {
  CHAT_FORMAT4_DURATION_BUCKETS,
  CHAT_FORMAT4_EVENTS,
  CHAT_FORMAT4_REASONS,
  chatFormat4Labels,
  recordChatFormat4Outcome,
  type ChatFormat4Outcome,
} from '../chat-format4-telemetry';
import {
  message,
  scopeSource,
} from '../../__tests__/helpers/chat-delta-journal-harness';
import {
  drainAfterTest,
  drainOpenRepositories,
} from '../../__tests__/helpers/chat-delta-journal-scope';

const FIELDS = [
  'format4_event',
  'format4_reason',
  'format4_attempt',
  'format4_duration_bucket',
];

const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

function sentContexts(): unknown[] {
  return succeedDesktopOperation.mock.calls.map(
    ([, options]: [unknown, { context: unknown }]) => options.context,
  );
}

/** Every value is a declared code or a bounded number, and no other key exists. */
function expectOnlyDeclaredFields(context: unknown): void {
  if (typeof context !== 'object' || context === null)
    throw new Error('Expected a context object');
  expect(Object.keys(context).sort()).toEqual([...FIELDS].sort());
  const event: unknown = Reflect.get(context, 'format4_event');
  const reason: unknown = Reflect.get(context, 'format4_reason');
  const attempt: unknown = Reflect.get(context, 'format4_attempt');
  const bucket: unknown = Reflect.get(context, 'format4_duration_bucket');
  expect(CHAT_FORMAT4_EVENTS).toContain(event);
  expect(CHAT_FORMAT4_REASONS).toContain(reason);
  expect(CHAT_FORMAT4_DURATION_BUCKETS).toContain(bucket);
  expect(Number.isInteger(attempt)).toBe(true);
  expect(attempt).toBeGreaterThanOrEqual(0);
  expect(attempt).toBeLessThanOrEqual(6);
}

beforeEach(() => {
  startDesktopOperation.mockClear();
  succeedDesktopOperation.mockClear();
});

describe('format 4 telemetry payloads', () => {
  it('declares exactly the four content-free keys', () => {
    expect(DESKTOP_OPERATIONS['canopy.chat_storage_format4']).toEqual({
      kind: 'product',
      posthogEvent: 'chat:storage_format4_update',
      contextKeys: FIELDS,
    });
  });

  it('sends only the declared fields for every event, after the current task', async () => {
    const pathError = Object.assign(
      new Error(
        "ENOSPC: no space left on device, open '/Users/someone/.canopy/chat-storage-v2/project-scope/delta-journal-v2.log'",
      ),
      { code: 'ENOSPC' },
    );
    const outcomes: ChatFormat4Outcome[] = [
      { event: 'promoted', attempt: 1 },
      { event: 'promotion_failed', attempt: 2, error: pathError },
      { event: 'retries_exhausted', attempt: 6 },
      { event: 'newer_format_refused' },
      { event: 'slow_checkpoint', durationMs: 7_500 },
    ];
    for (const outcome of outcomes) recordChatFormat4Outcome(outcome);
    expect(succeedDesktopOperation).not.toHaveBeenCalled();
    await settle();
    expect(sentContexts()).toEqual([
      {
        format4_event: 'promoted',
        format4_reason: 'none',
        format4_attempt: 1,
        format4_duration_bucket: 'none',
      },
      {
        format4_event: 'promotion_failed',
        format4_reason: 'disk_full',
        format4_attempt: 2,
        format4_duration_bucket: 'none',
      },
      {
        format4_event: 'retries_exhausted',
        format4_reason: 'none',
        format4_attempt: 6,
        format4_duration_bucket: 'none',
      },
      {
        format4_event: 'newer_format_refused',
        format4_reason: 'none',
        format4_attempt: 0,
        format4_duration_bucket: 'none',
      },
      {
        format4_event: 'slow_checkpoint',
        format4_reason: 'none',
        format4_attempt: 0,
        format4_duration_bucket: '5s_30s',
      },
    ]);
    for (const context of sentContexts()) expectOnlyDeclaredFields(context);
    // Neither the path nor the message reaches any call.
    const sent = JSON.stringify([
      startDesktopOperation.mock.calls,
      succeedDesktopOperation.mock.calls,
    ]);
    expect(sent).not.toContain('someone');
    expect(sent).not.toContain('chat-storage-v2');
    expect(sent).not.toContain('no space left');
    for (const [name] of succeedDesktopOperation.mock.calls)
      expect(name).toBe('canopy.chat_storage_format4');
  });

  it('classifies a failure by its type and code alone', () => {
    const reason = (error: unknown): unknown =>
      chatFormat4Labels({ event: 'promotion_failed', attempt: 1, error })
        .format4_reason;
    const coded = (code: string): Error =>
      Object.assign(new Error(`${code} at /private/path`), { code });
    expect(reason(coded('ENOSPC'))).toBe('disk_full');
    expect(reason(coded('EDQUOT'))).toBe('disk_full');
    expect(reason(coded('EACCES'))).toBe('permission');
    expect(reason(coded('EPERM'))).toBe('permission');
    expect(reason(coded('EROFS'))).toBe('permission');
    expect(reason(coded('EIO'))).toBe('io');
    expect(reason(new ChatDeltaJournalIntegrityError('torn segment'))).toBe(
      'integrity',
    );
    expect(reason(new Error('/workspaces/project/worktree failed'))).toBe(
      'other',
    );
    expect(reason(Object.assign(new Error('x'), { code: 'not/a/code' }))).toBe(
      'other',
    );
    expect(reason('a string')).toBe('other');
  });

  it('bounds attempts and buckets checkpoint durations, sending none under a second', async () => {
    expect(
      chatFormat4Labels({ event: 'promoted', attempt: 0 }).format4_attempt,
    ).toBe(1);
    expect(
      chatFormat4Labels({ event: 'promoted', attempt: 99 }).format4_attempt,
    ).toBe(6);
    const bucket = (durationMs: number): unknown =>
      chatFormat4Labels({ event: 'slow_checkpoint', durationMs })
        .format4_duration_bucket;
    expect(bucket(1_000)).toBe('1s_5s');
    expect(bucket(4_999)).toBe('1s_5s');
    expect(bucket(5_000)).toBe('5s_30s');
    expect(bucket(30_000)).toBe('gte_30s');
    expect(bucket(Number.NaN)).toBe('none');

    recordChatFormat4Outcome({ event: 'slow_checkpoint', durationMs: 999 });
    recordChatFormat4Outcome({
      event: 'slow_checkpoint',
      durationMs: Number.NaN,
    });
    await settle();
    expect(succeedDesktopOperation).not.toHaveBeenCalled();
  });
});

describe('format 4 outcomes from the repository', () => {
  const scope = { projectId: 'project', worktreeId: 'scope' };
  let root: string;
  const previousDataDir = process.env.CANOPY_DATA_DIR;

  const pathsAt = (
    at: string,
  ): { tabs: string; archives: string; journal: string } => ({
    tabs: join(at, 'chats', 'scope.json'),
    archives: join(at, 'chat-archives', 'scope.json'),
    journal: join(at, 'chat-journals', 'scope.jsonl'),
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'format4-telemetry-'));
    process.env.CANOPY_DATA_DIR = root;
    resetResolvedCanopyDataDirForTests();
    const store = ChatStorageV2.fromLegacyPaths(pathsAt(root));
    await store.migrate(
      scopeSource([
        { id: 'chat', messages: [message('initial', 'Initial', 'user')] },
      ]),
    );
    const backend = new ChatStateV2Backend(store, {
      enableFormat4: true,
      deltaJournal: {},
    });
    await backend.promoteToDeltaJournal();
    backend.releaseJournal();
  });

  afterEach(async () => {
    await drainOpenRepositories();
    if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previousDataDir;
    resetResolvedCanopyDataDirForTests();
    await rm(root, { recursive: true, force: true });
  });

  function repository(options: ChatStateV2RepositoryOptions): {
    target: ChatStateV2Repository;
    outcomes: ChatFormat4Outcome[];
    kinds: Array<ChatStateStorageDiagnostic['kind']>;
  } {
    const outcomes: ChatFormat4Outcome[] = [];
    const kinds: Array<ChatStateStorageDiagnostic['kind']> = [];
    const target = drainAfterTest(
      new ChatStateV2Repository({
        resolvePaths: (): { tabs: string; archives: string; journal: string } =>
          pathsAt(root),
        enableFormat4: true,
        deltaJournalIdleCheckpointMs: 60_000,
        format4Telemetry: (outcome): void => {
          outcomes.push(outcome);
        },
        onStorageDiagnostic: (diagnostic): void => {
          kinds.push(diagnostic.kind);
        },
        ...options,
      }),
    );
    return { target, outcomes, kinds };
  }

  it('reports a promotion under the format 4 kind', async () => {
    const { target, outcomes, kinds } = repository({});
    await target.getState(scope);
    expect(outcomes).toContainEqual({ event: 'promoted', attempt: 1 });
    expect(kinds).toContain('format4_promoted');
    expect(kinds).not.toContain('delta_journal_promoted');
  });

  it('reports a published promotion even when the reload after it fails', async () => {
    let published = false;
    const open = ChatDeltaJournalWriter.open.bind(ChatDeltaJournalWriter);
    const reopen = jest
      .spyOn(ChatDeltaJournalWriter, 'open')
      .mockImplementation(async (...args) => {
        if (published)
          throw Object.assign(new Error('EIO: /private/path'), {
            code: 'EIO',
          });
        return open(...args);
      });
    try {
      const { target, outcomes } = repository({
        deltaJournalOnBoundary: (point) => {
          if (point === 'writer-reopened') published = true;
          return Promise.resolve();
        },
      });
      await expect(target.getState(scope)).rejects.toThrow();
      expect(outcomes).toContainEqual({ event: 'promoted', attempt: 1 });
      expect(
        outcomes.some((outcome) => outcome.event === 'promotion_failed'),
      ).toBe(false);
    } finally {
      reopen.mockRestore();
    }
  });

  it('reports a published promotion when its reopen and the recovery both fail', async () => {
    let published = false;
    const open = ChatDeltaJournalWriter.open.bind(ChatDeltaJournalWriter);
    const reopen = jest
      .spyOn(ChatDeltaJournalWriter, 'open')
      .mockImplementation(async (...args) => {
        if (published)
          throw Object.assign(new Error('EIO: /private/path'), {
            code: 'EIO',
          });
        return open(...args);
      });
    try {
      const { target, outcomes } = repository({
        deltaJournalOnBoundary: (point) => {
          if (point === 'manifest-published') published = true;
          return Promise.resolve();
        },
      });
      await expect(target.getState(scope)).rejects.toThrow();
      expect(outcomes).toContainEqual({ event: 'promoted', attempt: 1 });
      expect(
        outcomes.some((outcome) => outcome.event === 'promotion_failed'),
      ).toBe(false);
    } finally {
      reopen.mockRestore();
    }
  });

  it('reports a failed attempt even when its recovery fails too', async () => {
    let promotionFailed = false;
    const open = ChatDeltaJournalWriter.open.bind(ChatDeltaJournalWriter);
    const reopen = jest
      .spyOn(ChatDeltaJournalWriter, 'open')
      .mockImplementation(async (...args) => {
        if (promotionFailed)
          throw Object.assign(new Error('EIO: /private/path'), {
            code: 'EIO',
          });
        return open(...args);
      });
    try {
      const { target, outcomes } = repository({
        deltaJournalPromotionRetryLimit: 0,
        deltaJournalOnBoundary: (point) => {
          if (point !== 'catalog-temp-written') return Promise.resolve();
          promotionFailed = true;
          return Promise.reject(
            Object.assign(new Error('ENOSPC: /private/path'), {
              code: 'ENOSPC',
            }),
          );
        },
      });
      await expect(target.getState(scope)).rejects.toThrow();
      const failed = outcomes.find(
        (outcome) => outcome.event === 'promotion_failed',
      );
      if (!failed) throw new Error('Expected a failed promotion outcome');
      // The promotion's own error is the reason, not the recovery's.
      expect(chatFormat4Labels(failed).format4_reason).toBe('disk_full');
      expect(outcomes).toContainEqual({
        event: 'retries_exhausted',
        attempt: 1,
      });
    } finally {
      reopen.mockRestore();
    }
  });

  it('reports a failed attempt and spent retries, with a reason and no format 3 kind', async () => {
    const { target, outcomes, kinds } = repository({
      deltaJournalPromotionRetryLimit: 0,
      deltaJournalOnBoundary: (point) =>
        point === 'catalog-temp-written'
          ? Promise.reject(
              Object.assign(new Error('ENOSPC: /private/path'), {
                code: 'ENOSPC',
              }),
            )
          : Promise.resolve(),
    });
    await target.getState(scope);
    const failed = outcomes.find(
      (outcome) => outcome.event === 'promotion_failed',
    );
    if (!failed) throw new Error('Expected a failed promotion outcome');
    expect(chatFormat4Labels(failed)).toEqual({
      format4_event: 'promotion_failed',
      format4_reason: 'disk_full',
      format4_attempt: 1,
      format4_duration_bucket: 'none',
    });
    expect(outcomes).toContainEqual({ event: 'retries_exhausted', attempt: 1 });
    expect(kinds).toEqual(
      expect.arrayContaining([
        'format4_promotion_failed',
        'format4_promotion_exhausted',
      ]),
    );
    expect(kinds).not.toContain('delta_journal_promotion_failed');
  });

  it('reports format 4 checkpoint durations and none for format 3', async () => {
    const formatThree = repository({ enableFormat4: false });
    await formatThree.target.transact(
      scope,
      [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: message('three', 'Format 3 write'),
        },
      ],
      { source: 'provider', mutationId: 'three' },
    );
    await formatThree.target.flushScope(scope);
    await formatThree.target.drainAll();
    expect(formatThree.outcomes).toEqual([]);

    const formatFour = repository({});
    await formatFour.target.getState(scope);
    await formatFour.target.transact(
      scope,
      [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: message('four', 'Format 4 write'),
        },
      ],
      { source: 'provider', mutationId: 'four' },
    );
    await formatFour.target.flushScope(scope);
    const checkpoints = formatFour.outcomes.filter(
      (outcome) => outcome.event === 'slow_checkpoint',
    );
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const outcome of checkpoints)
      expect(chatFormat4Labels(outcome).format4_event).toBe('slow_checkpoint');
  });
});
