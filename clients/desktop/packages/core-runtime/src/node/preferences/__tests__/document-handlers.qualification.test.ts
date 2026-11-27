import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  CORE_CONFIG_COMMITTED_EVENT,
  ConfigDocumentOwnerUpdateParamsSchema,
  ConfigDocumentUpdateParamsSchema,
  type ConfigDocumentGetResult,
  type ConfigDocumentUpdateResult,
} from '@canopy/protocol/canopy-core/core';
import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyHandlerContext } from '../../../runtime/types';
import { StorageWriteRefusedError } from '../../../storage';
import { StorageRowOwnerError } from '../../../storage/owner-records';
import { STORAGE_OWNERSHIP } from '../../../storage/storage-ownership.generated';
import type { StorageOwnershipRow } from '../../../storage/writer-authority';
import { ownerFlipRecordFile } from '../../storage-records';
import type { PreferencesCodec } from '../codec';
import {
  configDocumentRevision,
  createConfigCommitEvents,
} from '../commit-events';
import { createDaemonPreferences } from '../daemon-document';
import {
  createCoreConfigDocumentHandlers,
  type CoreConfigDocumentHandlers,
} from '../document-handlers';

const USAGE = ['productAnalytics', 'errorReports'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalize(payload: Record<string, unknown>): Record<string, unknown> {
  const usage = isObject(payload.usageData) ? payload.usageData : {};
  return {
    ...payload,
    fileAutoSave: payload.fileAutoSave === true,
    usageData: Object.fromEntries(
      USAGE.map((key) => [key, usage[key] !== false]),
    ),
  };
}

const codec: PreferencesCodec<Record<string, unknown>> = {
  defaults: normalize({}),
  normalize,
  project: (value) => normalize(value),
  inspect: () => null,
  merge: (existing, patch) => normalize({ ...existing, ...patch }),
};

const FLIPPED = STORAGE_OWNERSHIP.map((row) =>
  row.id === 'preferences'
    ? { ...row, transitionOwner: 'daemon' as const }
    : row,
);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'daemon-preference-handlers-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Daemon = CoreConfigDocumentHandlers & { committed(): unknown[] };

/** One daemon lifetime over `root`: its module, handlers and event journal. */
function start(ownership: readonly StorageOwnershipRow[] = FLIPPED): Daemon {
  const events = createConfigCommitEvents({ epoch: 'daemon-epoch' });
  const preferences = createDaemonPreferences({
    dataRoot: root,
    codec,
    usageDataKeys: USAGE,
    syncDirectory: () => Promise.resolve('flushed'),
    ownership,
    hooks: events.hooks,
    log: { error: jest.fn() },
  });
  const handlers = createCoreConfigDocumentHandlers({ preferences, events });
  const committed = (): unknown[] => {
    const history = events.journal.resume(null);
    return history.kind === 'replay'
      ? history.entries.map(({ event }) => event)
      : [];
  };
  return { ...handlers, committed };
}

const context = (
  key: string,
  principalId = 'principal-1',
): CanopyHandlerContext => ({
  requestId: `request-${key}`,
  caller: {
    principalId,
    clientInstanceId: `client-of-${principalId}`,
    authorityId: 'authority-1',
    interfaceKind: 'test',
    grants: ['core.config.document.write', 'core.config.document.own'],
  },
  metadata: { idempotencyKey: key },
  signal: new AbortController().signal,
});

const update = (
  daemon: Daemon,
  key: string,
  patch: Record<string, unknown>,
  expectedRevision?: string,
): Promise<ConfigDocumentUpdateResult> =>
  daemon.instructions['core.config.document.update'](
    ConfigDocumentUpdateParamsSchema.parse({
      patch,
      ...(expectedRevision !== undefined && { expectedRevision }),
      _meta: { idempotencyKey: key },
    }),
    context(key),
  );

const ownerUpdate = (
  daemon: Daemon,
  key: string,
  patch: Record<string, unknown>,
): Promise<ConfigDocumentGetResult> =>
  daemon.instructions['core.config.document.ownerUpdate'](
    ConfigDocumentOwnerUpdateParamsSchema.parse({
      patch,
      _meta: { idempotencyKey: key },
    }),
    context(key),
  );

const stored = (): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(
    readFileSync(join(root, 'preferences.json'), 'utf8'),
  );
  if (!isObject(parsed) || !isObject(parsed.preferences))
    throw new Error('no stored record');
  return parsed.preferences;
};
const generation = (): string =>
  readFileSync(join(root, 'preferences.generation.json'), 'utf8');

async function refusalOf(call: Promise<unknown>): Promise<unknown> {
  const error: unknown = await call.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  if (!(error instanceof CanopyOperationError)) throw error;
  return error.payload;
}

async function causeOf(call: Promise<unknown>): Promise<unknown> {
  const error: unknown = await call.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  if (!(error instanceof CanopyOperationError)) throw error;
  return error.runtimeCause;
}

describe('core.config.document on the daemon module (CAN-7956)', () => {
  it('the open path runs the save rules on the raw patch, then the codec', async () => {
    writeFileSync(
      join(root, 'preferences.json'),
      JSON.stringify({
        version: 1,
        preferences: { windowBounds: { stored: true }, suggestions: 'main' },
      }),
    );
    const daemon = start();
    await expect(
      refusalOf(
        update(daemon, 'refused', { approvalDefaults: {}, fileAutoSave: true }),
      ),
    ).resolves.toMatchObject({
      kind: 'invalid_argument',
      code: 'core.config.protectedKey',
    });
    expect(stored()).not.toHaveProperty('fileAutoSave');

    const result = await update(daemon, 'open', {
      fileAutoSave: true,
      suggestions: 'stale',
      windowBounds: { changed: true },
      repeatTaskAutomationSuggestionsEnabled: false,
    });
    // Client-local keys are not rule drops: the codec keeps the stored copy.
    expect(result.dropped).toEqual([
      'suggestions',
      'repeatTaskAutomationSuggestionsEnabled',
    ]);
    expect(stored()).toMatchObject({
      fileAutoSave: true,
      suggestions: 'main',
      windowBounds: { stored: true },
    });
    expect(stored()).not.toHaveProperty(
      'repeatTaskAutomationSuggestionsEnabled',
    );
    expect(result.revision).toBe(configDocumentRevision(stored()));
    expect(result.loadError).toBeNull();
  });

  it('the owner path writes protected keys as sent, through the codec only', async () => {
    const daemon = start();
    const result = await ownerUpdate(daemon, 'owner', {
      approvalDefaults: { mode: 'ask' },
      suggestions: 'owned',
      windowBounds: { changed: true },
    });
    expect(stored()).toMatchObject({
      approvalDefaults: { mode: 'ask' },
      suggestions: 'owned',
    });
    expect(stored()).not.toHaveProperty('windowBounds');
    expect(result.value).toMatchObject({ suggestions: 'owned' });
  });

  it('merges usageData per key with the stored switches on both paths', async () => {
    const daemon = start();
    await update(daemon, 'deny-errors', { usageData: { errorReports: false } });
    await ownerUpdate(daemon, 'deny-analytics', {
      usageData: { productAnalytics: false },
    });
    expect(stored().usageData).toEqual({
      productAnalytics: false,
      errorReports: false,
    });
  });

  it('refuses a stale expectedRevision without writing', async () => {
    const daemon = start();
    const first = await update(daemon, 'first', { fileAutoSave: true });
    const stale = configDocumentRevision(codec.defaults);
    await expect(
      refusalOf(update(daemon, 'stale', { fileAutoSave: false }, stale)),
    ).resolves.toMatchObject({
      kind: 'conflict',
      code: 'core.config.revisionConflict',
    });
    expect(stored().fileAutoSave).toBe(true);
    await expect(
      update(daemon, 'current', { fileAutoSave: false }, first.revision),
    ).resolves.toMatchObject({ value: { fileAutoSave: false } });
  });

  it('the event source itself skips a commit that left the revision unchanged', () => {
    const events = createConfigCommitEvents({ epoch: 'daemon-epoch' });
    events.committed({ previous: { a: 1, b: 2 }, next: { b: 2, a: 1 } });
    expect(events.journal.size).toBe(0);
    events.committed({ previous: { a: 1 }, next: { a: 2 } }, 'client');
    expect(events.journal.size).toBe(1);
  });

  it('publishes one committed event per changed revision and none for an unchanged one', async () => {
    const daemon = start();
    const first = await update(daemon, 'change', { fileAutoSave: true });
    const before = generation();
    const same = await update(daemon, 'same', { fileAutoSave: true });
    expect(same.revision).toBe(first.revision);
    expect(generation()).toBe(before);

    // The same key and params replay the outcome; other params are refused.
    await expect(
      update(daemon, 'change', { fileAutoSave: true }),
    ).resolves.toEqual(first);
    await expect(
      refusalOf(update(daemon, 'change', { fileAutoSave: false })),
    ).resolves.toMatchObject({ kind: 'conflict' });

    expect(daemon.committed()).toEqual([
      expect.objectContaining({
        name: CORE_CONFIG_COMMITTED_EVENT,
        scope: {},
        payload: {
          commit: 'config:1',
          previousRevision: configDocumentRevision(codec.defaults),
          revision: first.revision,
          keys: ['fileAutoSave'],
          publishedBy: 'client-of-principal-1',
        },
      }),
    ]);
  });

  it('a reply lost across a daemon restart replays without a second write or conflicts', async () => {
    const before = start();
    const read = await before.queries['core.config.document.get'](
      {},
      context('read'),
    );
    const lost = await update(
      before,
      'cas',
      { fileAutoSave: true },
      read.revision,
    );
    const blind = await update(before, 'blind', { mcpProxyPort: 4100 });
    const written = generation();

    // KeyedOutcomes is in memory: the restarted daemon runs the key again.
    const after = start();
    await expect(
      refusalOf(update(after, 'cas', { fileAutoSave: true }, read.revision)),
    ).resolves.toMatchObject({
      kind: 'conflict',
      code: 'core.config.revisionConflict',
    });
    await expect(
      update(after, 'blind', { mcpProxyPort: 4100 }),
    ).resolves.toEqual(blind);
    expect(lost.revision).not.toBe(blind.revision);
    expect(generation()).toBe(written);
    expect(after.committed()).toEqual([]);
  });

  it('is inert under the compiled rows: reads answer, writes refuse capability_unavailable', async () => {
    const daemon = start(STORAGE_OWNERSHIP);
    await expect(
      daemon.queries['core.config.document.get']({}, context('get')),
    ).resolves.toMatchObject({
      revision: configDocumentRevision(codec.defaults),
      enforcedPaths: [],
      loadError: null,
    });
    const notKept = {
      kind: 'capability_unavailable',
      message: 'This core does not keep preferences.',
      retry: { kind: 'never' },
    };
    await expect(
      refusalOf(update(daemon, 'refused', { fileAutoSave: true })),
    ).resolves.toEqual(notKept);
    await expect(
      refusalOf(ownerUpdate(daemon, 'refused-owner', { fileAutoSave: true })),
    ).resolves.toEqual(notKept);
    await expect(
      causeOf(update(daemon, 'refused-cause', { fileAutoSave: true })),
    ).resolves.toBeInstanceOf(StorageWriteRefusedError);
    expect(daemon.committed()).toEqual([]);
  });

  it('refuses capability_unavailable while the owner record names the app, then writes once it names the daemon', async () => {
    const record = (toOwner: 'daemon' | 'legacy'): void => {
      const path = ownerFlipRecordFile(root, 'preferences');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          namespaceId: 'preferences',
          fromOwner: toOwner === 'daemon' ? 'legacy' : 'daemon',
          toOwner,
          workPackage: 'W6',
          backupRecord: `storage-records/preferences/namespace-backup.json#sha256:${'a'.repeat(64)}`,
          flippedAt: '2026-11-25T10:00:00.000Z',
        }),
      );
    };
    record('legacy');
    const daemon = start();
    const ownedByApp = {
      kind: 'capability_unavailable',
      message:
        'The app keeps this data again, so the background service didn’t change it. Nothing was saved.',
      retry: { kind: 'never' },
    };
    await expect(
      refusalOf(update(daemon, 'flip', { fileAutoSave: true })),
    ).resolves.toEqual(ownedByApp);
    await expect(
      refusalOf(ownerUpdate(daemon, 'flip-owner', { fileAutoSave: true })),
    ).resolves.toEqual(ownedByApp);
    await expect(
      causeOf(update(daemon, 'flip-cause', { fileAutoSave: true })),
    ).resolves.toBeInstanceOf(StorageRowOwnerError);
    expect(daemon.committed()).toEqual([]);

    // The refusal is not kept for the key: the same key runs again.
    record('daemon');
    await expect(
      update(daemon, 'flip', { fileAutoSave: true }),
    ).resolves.toMatchObject({ value: { fileAutoSave: true } });
    expect(stored().fileAutoSave).toBe(true);
  });
});

describe('core.config.legacyClientLocal.get and loadError.acknowledge (CAN-7956)', () => {
  it('answers missing, read, then pending under a latched recovery', async () => {
    const legacy = (): Promise<unknown> =>
      start().queries['core.config.legacyClientLocal.get'](
        {},
        context('legacy'),
      );
    await expect(legacy()).resolves.toEqual({ kind: 'missing' });
    writeFileSync(
      join(root, 'preferences.json'),
      JSON.stringify({
        version: 1,
        preferences: { theme: 'dusk', fileAutoSave: true },
      }),
    );
    await expect(legacy()).resolves.toEqual({
      kind: 'read',
      values: { theme: 'dusk' },
    });
    // An unsupported version with no last-good latches recovery.
    writeFileSync(
      join(root, 'preferences.json'),
      JSON.stringify({ version: 99, preferences: { theme: 'later' } }),
    );
    await expect(legacy()).resolves.toEqual({ kind: 'pending', served: {} });
  });

  it('acknowledges only the load error the person saw', async () => {
    writeFileSync(
      join(root, 'preferences.json'),
      JSON.stringify({ version: 99, preferences: {} }),
    );
    const daemon = start();
    const document = await daemon.queries['core.config.document.get'](
      {},
      context('get'),
    );
    const loadError = document.loadError;
    expect(loadError).toMatchObject({
      reason: 'version',
      backedUp: false,
      restored: false,
      expectedVersion: 1,
      actualVersion: 99,
    });
    expect(JSON.stringify(loadError)).not.toContain(root);
    const acknowledge =
      daemon.instructions['core.config.loadError.acknowledge'];
    await expect(
      acknowledge({ timestamp: '2000-01-01T00:00:00.000Z' }, context('old')),
    ).resolves.toEqual({ acknowledged: false, loadError });
    await expect(
      acknowledge({ timestamp: loadError?.timestamp ?? '' }, context('seen')),
    ).resolves.toEqual({ acknowledged: true, loadError: null });
    // Latched: writes refuse with the document's invalid state.
    await expect(
      refusalOf(update(daemon, 'latched', { fileAutoSave: true })),
    ).resolves.toMatchObject({
      kind: 'failed_precondition',
      code: 'core.config.invalidState',
    });
  });
});
