// Golden for the daemon preferences client (CAN-7986): the client over the
// daemon's real document handlers and repository (CAN-7956) on a temporary
// data root, against the same repository updated in process. A route stands
// in for the connection only, so a reply can be lost on the way back.
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { z } from 'zod';

import {
  CanopyClientError,
  toCanopyClientError,
  type CanopyClientInstructionOptions,
  type CanopyClientStreamOptions,
  type CanopyEventFrame,
  type CanopyEventHandle,
} from '@canopy/core-client';
import { CanopyOutcomeUnknownError } from '@canopy/core-client/outcome';
import {
  CLIENT_LOCAL_PREFERENCE_KEYS,
  createPreferencesRepository,
  preserveStoredKeys,
  type PreferencesChange,
  type PreferencesCodec,
  type PreferencesDocument,
  type PreferencesUpdater,
} from '@canopy/core-runtime/node/preferences';
import { DESKTOP_PREFERENCES_CODEC } from '@canopy/desktop-shared/node/preferences/desktop-preferences-codec';
import type { StoredDomainPreferences } from '@canopy/desktop-shared/node/preferences/client-local-preferences';
import {
  CoreEventsAckParamsSchema,
  CoreEventsSubscribeParamsSchema,
  isUnknownKeyedWriteOutcome,
  type CanopySchemaInput,
} from '@canopy/protocol/canopy-core';
import {
  ConfigDocumentOwnerUpdateParamsSchema,
  ConfigLoadErrorAcknowledgeParamsSchema,
  ConfigLoadErrorAcknowledgeResultSchema,
  type ConfigDocumentGetResult,
  type ConfigDocumentOwnerUpdateParams,
  type ConfigDocumentUpdateParams,
  type ConfigDocumentUpdateResult,
  type ConfigLegacyClientLocalGetResult,
} from '@canopy/protocol/canopy-core/core';
import type * as PreferencesStoreModule from '../../lib/preferences-store';
import { getUsageDataPolicy } from '../../lib/usage-data-policy';
import {
  selectDomainPreferences,
  type InProcessDomainPreferencesSources,
} from '../../lib/preferences-domain-port';
import {
  DAEMON_PREFERENCES_UNAVAILABLE_CODE,
  createDaemonPreferencesRoute,
  type DaemonPreferencesRoute,
  type PreferencesDocumentOwnerClient,
  type PreferencesDocumentSessionClient,
} from '../daemon-preferences-route';
import { createConfigCommitEvents } from '@canopy/core-runtime/node/preferences/commit-events';
import {
  createDaemonPreferences,
  type DaemonPreferences,
  type DaemonStoredPreferences,
} from '@canopy/core-runtime/node/preferences/daemon-document';
import {
  createCoreConfigDocumentHandlers,
  type CoreConfigDocumentHandlers,
} from '@canopy/core-runtime/node/preferences/document-handlers';
import { STORAGE_OWNERSHIP } from '@canopy/core-runtime/storage/storage-ownership.generated';
import type { CanopyHandlerContext } from '@canopy/core-runtime/runtime/types';
import {
  ConfigDocumentUpdateParamsSchema,
  CoreConfigCommittedPayloadSchema,
  CoreConfigInvalidatedPayloadSchema,
} from '@canopy/protocol/canopy-core/core';
import { createDefaultApprovalDefaults } from '@canopy/protocol/approval-policy';
import {
  isGlobalApprovalRulesSettled,
  markPreferencesAuthorityConfirmed,
  markPreferencesAuthorityUnconfirmed,
  readPreferencesApprovalAuthority,
  trackPreferencesAuthoritySave,
} from '../../approvals/rule-revisions';
import {
  createDaemonPreferencesClient,
  type DaemonForeignCommit,
  type DaemonPreferencesClient,
  type DaemonPreferencesHooks,
  type PreferencesDocumentEvent,
  type PreferencesDocumentRoute,
} from '../preferences-daemon-client';

type Stored = DaemonStoredPreferences;

// The store's own paths, for the daemon port it composes (CAN-7991).
let mockPreferencesFilePath = '';
jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<Record<string, unknown>>('../../lib/paths'),
  getPreferencesFilePath: (): string => mockPreferencesFilePath,
  getClientPreferencesFilePath: (): string =>
    `${mockPreferencesFilePath}.client.json`,
}));

const USAGE = ['productAnalytics', 'errorReports'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalize(payload: Record<string, unknown>): Record<string, unknown> {
  const usage = isObject(payload.usageData) ? payload.usageData : {};
  return {
    ...payload,
    fileAutoSave: payload.fileAutoSave === true,
    language: typeof payload.language === 'string' ? payload.language : 'en',
    globalApprovalRules: Array.isArray(payload.globalApprovalRules)
      ? payload.globalApprovalRules
      : [],
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

const DESKTOP = 'electron-main-preferences';

let roots: string[] = [];
const freshRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-preference-client-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
  markPreferencesAuthorityConfirmed();
});

function openPreferences(root: string): {
  preferences: DaemonPreferences;
  events: ReturnType<typeof createConfigCommitEvents>;
} {
  const events = createConfigCommitEvents({ epoch: randomUUID() });
  const preferences = createDaemonPreferences({
    dataRoot: root,
    codec,
    usageDataKeys: USAGE,
    syncDirectory: () => Promise.resolve('flushed'),
    ownership: FLIPPED,
    hooks: events.hooks,
    log: { error: jest.fn() },
  });
  return { preferences, events };
}

const context = (
  clientInstanceId: string,
  key: string = randomUUID(),
): CanopyHandlerContext => ({
  requestId: `request-${key}`,
  caller: {
    principalId: `principal-${clientInstanceId}`,
    clientInstanceId,
    authorityId: 'authority-1',
    interfaceKind: 'test',
    grants: ['core.config.document.write', 'core.config.document.own'],
  },
  metadata: { idempotencyKey: key },
  signal: new AbortController().signal,
});

/** One daemon lifetime over a data root. */
interface Daemon {
  handlers: CoreConfigDocumentHandlers;
  events: ReturnType<typeof createConfigCommitEvents>;
  preferences: DaemonPreferences;
  root: string;
}

function startDaemon(root = freshRoot()): Daemon {
  const { preferences, events } = openPreferences(root);
  return {
    handlers: createCoreConfigDocumentHandlers({ preferences, events }),
    events,
    preferences,
    root,
  };
}

/** Every event the daemon journaled, from its first. */
function journalOf(
  daemon: Daemon,
): ReturnType<Daemon['events']['journal']['resume']> {
  const { journal } = daemon.events;
  return journal.resume({ daemonEpoch: journal.epoch, sequence: 0 });
}

/** Another client (the CLI, an agent) writing through the daemon. */
async function foreignWrite(
  daemon: Daemon,
  patch: Record<string, unknown>,
): Promise<void> {
  const key = randomUUID();
  await daemon.handlers.instructions['core.config.document.update'](
    ConfigDocumentUpdateParamsSchema.parse({
      patch,
      _meta: { idempotencyKey: key },
    }),
    context('client-of-cli', key),
  );
}

type Loss = 'resend' | 'never' | 'restart';

/**
 * The connection to `daemon.current`. `lose` drops the next write reply
 * after the daemon applied it; `resend` resolves on the next attempt.
 * Events reach the client only when the test calls `deliver`.
 */
interface Connection {
  readonly route: PreferencesDocumentRoute;
  readonly calls: string[];
  lose(kind: Loss, resend?: () => Promise<void>): void;
  failLegacy(): void;
  deliver(): void;
}

function connect(daemon: { current: Daemon }): Connection {
  const calls: string[] = [];
  let listener: ((event: PreferencesDocumentEvent) => void) | null = null;
  let delivered = 0;
  let loss: Loss | null = null;
  let onResend: (() => Promise<void>) | null = null;
  let legacyUnavailable = false;
  const asClientError = async <R>(work: () => Promise<R>): Promise<R> => {
    try {
      return await work();
    } catch (error) {
      throw toCanopyClientError(error);
    }
  };
  const write = async <R>(
    name: 'update' | 'ownerUpdate',
    run: () => Promise<R>,
  ): Promise<R> => {
    calls.push(name);
    if (loss === null && onResend !== null) {
      const resend = onResend;
      onResend = null;
      await resend();
    }
    const result = await asClientError(run);
    const lost = loss;
    if (lost === null) return result;
    if (lost === 'restart') daemon.current = startDaemon(daemon.current.root);
    if (lost !== 'never') loss = null;
    throw new CanopyClientError({
      kind: 'unavailable',
      message: 'The connection closed before the reply.',
      retry: { kind: lost === 'never' ? 'never' : 'same_idempotency_key' },
    });
  };
  const route: PreferencesDocumentRoute = {
    clientInstanceId: DESKTOP,
    get: () => {
      calls.push('get');
      return asClientError(() =>
        daemon.current.handlers.queries['core.config.document.get'](
          {},
          context(DESKTOP),
        ),
      );
    },
    legacyClientLocal: () => {
      calls.push('legacyClientLocal');
      if (legacyUnavailable)
        return Promise.reject(
          new CanopyClientError({
            kind: 'unavailable',
            message: 'The daemon is not running.',
            retry: { kind: 'never' },
          }),
        );
      return asClientError(() =>
        daemon.current.handlers.queries['core.config.legacyClientLocal.get'](
          {},
          context(DESKTOP),
        ),
      );
    },
    update: (params, options) =>
      write('update', () =>
        daemon.current.handlers.instructions['core.config.document.update'](
          params,
          context(DESKTOP, options.metadata?.idempotencyKey),
        ),
      ),
    ownerUpdate: (params, options) =>
      write('ownerUpdate', () =>
        daemon.current.handlers.instructions[
          'core.config.document.ownerUpdate'
        ](params, context(DESKTOP, options.metadata?.idempotencyKey)),
      ),
    acknowledgeLoadError: (params) =>
      daemon.current.handlers.instructions['core.config.loadError.acknowledge'](
        params,
        context(DESKTOP),
      ),
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  return {
    route,
    calls,
    lose(kind: Loss, resend?: () => Promise<void>): void {
      loss = kind;
      onResend = resend ?? null;
    },
    failLegacy(): void {
      legacyUnavailable = true;
    },
    /** Delivers every journaled event not yet delivered, in order. */
    deliver(): void {
      const history = journalOf(daemon.current);
      if (history.kind !== 'replay') throw new Error('journal expired');
      for (const { event } of history.entries.slice(delivered)) {
        if (event.name === 'core.config.committed')
          listener?.({
            name: event.name,
            payload: CoreConfigCommittedPayloadSchema.parse(event.payload),
          });
        else
          listener?.({
            name: 'core.config.invalidated',
            payload: CoreConfigInvalidatedPayloadSchema.parse(event.payload),
          });
      }
      delivered = history.entries.length;
    },
  };
}

/**
 * What the store wires around a save that changes approval authority. Every
 * case here starts from no global rules.
 */
const CONFIRMED = {
  globalApprovalRules: [],
  approvalDefaults: createDefaultApprovalDefaults(),
};
function approvalHooks(): DaemonPreferencesHooks<Stored> & {
  unknown: jest.Mock;
} {
  const changed = ({ previous, next }: PreferencesChange<Stored>): boolean =>
    JSON.stringify(previous.globalApprovalRules) !==
    JSON.stringify(next.globalApprovalRules);
  const unknown = jest.fn((change: PreferencesChange<Stored>) => {
    if (changed(change)) markPreferencesAuthorityUnconfirmed(CONFIRMED);
  });
  return {
    unknown,
    trackSave: (save, change) =>
      changed(change)
        ? trackPreferencesAuthoritySave(save, { narrowsFileWrites: false })
        : save,
    onSaveOutcomeUnknown: unknown,
    onSaveDurable: () => markPreferencesAuthorityConfirmed(),
  };
}

function createClient(
  connection: Connection,
  extra: {
    hooks?: DaemonPreferencesHooks<Stored>;
    applyForeignCommit?: (commit: DaemonForeignCommit<Stored>) => Promise<void>;
    log?: jest.Mock;
  } = {},
): DaemonPreferencesClient<Stored> {
  const { preferences } = openPreferences(freshRoot());
  return createDaemonPreferencesClient<Stored>({
    route: connection.route,
    codec: preferences.codec,
    hooks: extra.hooks,
    applyForeignCommit: extra.applyForeignCommit,
    paths: { document: '/data/preferences.json', lastGood: '/data/last-good' },
    log: { error: extra.log ?? jest.fn() },
  });
}

/** The repository engine updated in process, for the same commits. */
interface InProcess {
  foreign(patch: Record<string, unknown>): Promise<PreferencesChange<Stored>>;
  update(
    updater: PreferencesUpdater<Stored>,
  ): Promise<PreferencesChange<Stored>>;
}

function inProcess(): InProcess {
  const { preferences } = openPreferences(freshRoot());
  const { repository } = preferences;
  return {
    foreign: (patch) => repository.update(() => patch),
    update: (updater) => repository.update(updater),
  };
}

const INTERNAL = { route: 'internal' } as const;
const CALLER = { route: 'caller' } as const;

describe('the daemon preferences client against the daemon module (CAN-7986)', () => {
  it('gives in-process {previous, next} for a disjoint write on a stale cache', async () => {
    const daemon = { current: startDaemon() };
    const connection = connect(daemon);
    const client = createClient(connection);
    await client.read('persisted');
    // Another client commits; its event has not reached this client yet.
    await foreignWrite(daemon.current, { language: 'fr' });
    const runs = jest.fn();
    const change = await client.update(
      (latest) => {
        runs(latest.language);
        return { fileAutoSave: true };
      },
      undefined,
      INTERNAL,
    );

    const local = inProcess();
    await local.foreign({ language: 'fr' });
    expect(change).toEqual(await local.update(() => ({ fileAutoSave: true })));
    // Ran on the stale cache, refused, re-read and ran again.
    expect(runs.mock.calls).toEqual([['en'], ['fr']]);
    expect(await client.read('runtime')).toEqual(change.next);
  });

  it('gives in-process {previous, next} for a conflicting write, re-running the updater', async () => {
    const daemon = { current: startDaemon() };
    const connection = connect(daemon);
    const client = createClient(connection);
    await client.read('persisted');
    await foreignWrite(daemon.current, { fileAutoSave: true });
    const toggle: PreferencesUpdater<Stored> = (latest) => ({
      fileAutoSave: latest.fileAutoSave !== true,
    });
    const change = await client.update(toggle, undefined, INTERNAL);

    const local = inProcess();
    await local.foreign({ fileAutoSave: true });
    expect(change).toEqual(await local.update(toggle));
    expect(change.next.fileAutoSave).toBe(false);
  });

  it('gives in-process {previous, next} for a blind patch that matched only the stale cache', async () => {
    const daemon = { current: startDaemon() };
    const connection = connect(daemon);
    const client = createClient(connection);
    await client.read('persisted');
    await foreignWrite(daemon.current, { fileAutoSave: true });
    // Equal to the stale cache, so it diffs to nothing; that decision stands
    // only on the stored document, so it is checked and run again.
    const blind = (): Partial<Stored> => ({ fileAutoSave: false });
    const change = await client.update(blind, undefined, INTERNAL);

    const local = inProcess();
    await local.foreign({ fileAutoSave: true });
    expect(change).toEqual(await local.update(blind));
    expect(change.next.fileAutoSave).toBe(false);
  });

  it('gives in-process {previous, next} for a key an updater clears with undefined', async () => {
    const daemon = { current: startDaemon() };
    const client = createClient(connect(daemon));
    await client.update(() => ({ language: 'fr' }), undefined, INTERNAL);
    // As Copilot's sign-out clears its account.
    const clear = (): Partial<Stored> => ({ language: undefined });
    const change = await client.update(clear, undefined, INTERNAL);

    const local = inProcess();
    await local.update(() => ({ language: 'fr' }));
    expect(change).toEqual(await local.update(clear));
    expect(change.next.language).toBe('en');
  });

  it('answers {} as a no-op with previous equal to next and its observers run', async () => {
    const daemon = { current: startDaemon() };
    const connection = connect(daemon);
    const afterSave = jest.fn(() => Promise.resolve());
    const onCommitted = jest.fn();
    const client = createClient(connection, {
      hooks: { afterSave, onCommitted },
    });
    await client.update(() => ({ fileAutoSave: true }), undefined, INTERNAL);
    afterSave.mockClear();
    onCommitted.mockClear();
    const committed = jest.fn();

    const change = await client.update(() => ({}), committed, INTERNAL);

    const local = inProcess();
    await local.foreign({ fileAutoSave: true });
    const expected = await local.update(() => ({}));
    expect(change.previous).toEqual(expected.previous);
    expect(change.next).toEqual(expected.next);
    expect(change.next).toBe(change.previous);
    expect(connection.calls).not.toContain('ownerUpdate');
    expect(connection.calls.filter((call) => call === 'update')).toHaveLength(
      1,
    );
    expect(afterSave).toHaveBeenCalledTimes(1);
    expect(onCommitted).toHaveBeenCalledWith(change.next);
    expect(committed).toHaveBeenCalledWith(change.next);
  });

  it('answers a client-only save without daemon I/O and ignores client-local keys', async () => {
    const daemon = { current: startDaemon() };
    const connection = connect(daemon);
    const client = createClient(connection);
    await client.read('persisted');
    connection.calls.length = 0;

    const clientOnly = await client.update(() => null, undefined, {
      route: 'caller',
      isClientOnly: () => true,
    });
    expect(clientOnly.next).toBe(clientOnly.previous);
    expect(connection.calls).toEqual([]);

    // An updater's own null is a decision on the document: one read checks it.
    await client.update(() => null, undefined, INTERNAL);
    expect(connection.calls).toEqual(['get', 'legacyClientLocal']);

    // A client-local key never reaches the daemon.
    connection.calls.length = 0;
    const change = await client.update(
      () => ({ windowBounds: { width: 1 }, language: 'fr' }),
      undefined,
      CALLER,
    );
    expect(connection.calls).toEqual(['update']);
    expect(change.next).not.toHaveProperty('windowBounds');
    expect(change.next.language).toBe('fr');
    // Reads come from the cache.
    connection.calls.length = 0;
    await client.read('runtime');
    await client.readAuthority();
    expect(connection.calls).toEqual([]);
  });

  it('sends caller patches on the open path and internal ones by the exact patch sent', async () => {
    const daemon = { current: startDaemon() };
    const connection = connect(daemon);
    const client = createClient(connection);
    await client.update(
      () => ({ suggestions: 'main', fileAutoSave: true }),
      undefined,
      INTERNAL,
    );
    expect(connection.calls).toContain('ownerUpdate');
    await client.update(
      () => ({ suggestions: 'stale', language: 'fr' }),
      undefined,
      CALLER,
    );
    expect(await client.read('persisted')).toMatchObject({
      suggestions: 'main',
      language: 'fr',
    });
    // Diffed first: an unchanged protected key no longer needs the owner path.
    connection.calls.length = 0;
    await client.update(
      (latest) => ({ ...latest, fileAutoSave: false }),
      undefined,
      INTERNAL,
    );
    expect(connection.calls).toEqual(['update']);
  });

  it('resends a lost reply under its key, with approval authority unconfirmed until it settles', async () => {
    const daemon = { current: startDaemon() };
    const connection = connect(daemon);
    const hooks = approvalHooks();
    const client = createClient(connection, { hooks });
    await client.read('persisted');
    const rule = { tool: 'Bash', decision: 'allow' };
    let during: { settled: boolean; unknown: number } | undefined;
    connection.lose('resend', () => {
      during = {
        settled: isGlobalApprovalRulesSettled(),
        unknown: hooks.unknown.mock.calls.length,
      };
      return Promise.resolve();
    });

    const change = await client.update(
      () => ({ globalApprovalRules: [rule] }),
      undefined,
      INTERNAL,
    );

    expect(during).toEqual({ settled: false, unknown: 1 });
    const local = inProcess();
    expect(change).toEqual(
      await local.update(() => ({ globalApprovalRules: [rule] })),
    );
    // One commit: the resend replayed the first outcome.
    const history = journalOf(daemon.current);
    expect(history.kind === 'replay' && history.entries.length).toBe(1);
    const authority = await readPreferencesApprovalAuthority(() =>
      Promise.resolve(true),
    );
    expect(authority.confirmed).toBeUndefined();
  }, 10_000);

  it('keeps authority unconfirmed and never re-runs the updater when the outcome stays unknown', async () => {
    const daemon = { current: startDaemon() };
    const connection = connect(daemon);
    const hooks = approvalHooks();
    const client = createClient(connection, { hooks });
    await client.read('persisted');
    // A value the protocol refuses is this save's own error, sent nowhere.
    const refused = client.update(
      () => ({ mcpProxyPort: Number.NaN }),
      undefined,
      INTERNAL,
    );
    await expect(refused).rejects.toThrow();
    await expect(refused).rejects.not.toBeInstanceOf(CanopyOutcomeUnknownError);
    expect(hooks.unknown).not.toHaveBeenCalled();
    const runs = jest.fn(() => ({
      globalApprovalRules: [{ tool: 'Bash', decision: 'allow' }],
    }));
    connection.lose('never');
    await expect(client.update(runs, undefined, INTERNAL)).rejects.toThrow(
      CanopyOutcomeUnknownError,
    );
    expect(runs).toHaveBeenCalledTimes(1);
    const authority = await readPreferencesApprovalAuthority(() =>
      Promise.resolve(true),
    );
    expect(authority.confirmed).toEqual(CONFIRMED);

    // Lost across a restart, the resend meets the first write's revision:
    // still unknown, and the updater does not run on top of its own commit.
    const restarted = connect(daemon);
    const second = createClient(restarted, { hooks: approvalHooks() });
    await second.read('persisted');
    const rerun = jest.fn(() => ({ language: 'de' }));
    restarted.lose('restart');
    await expect(second.update(rerun, undefined, INTERNAL)).rejects.toThrow(
      CanopyOutcomeUnknownError,
    );
    expect(rerun).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('feeds other clients’ commits to the consumer once each, skips its own echo and reports a failed apply', async () => {
    const daemon = { current: startDaemon() };
    const connection = connect(daemon);
    const applied: DaemonForeignCommit<Stored>[] = [];
    const log = jest.fn();
    let fail = false;
    const client = createClient(connection, {
      log,
      applyForeignCommit: (commit) => {
        applied.push(commit);
        return fail ? Promise.reject(new Error('effects')) : Promise.resolve();
      },
    });
    await client.read('persisted');
    // Event handling and writes share one order: a null save after the
    // deliveries settles once they are handled.
    const handled = async (): Promise<void> => {
      await client.update(() => null, undefined, INTERNAL);
      await new Promise((resolve) => setImmediate(resolve));
    };

    await client.update(() => ({ fileAutoSave: true }), undefined, INTERNAL);
    await client.update(() => ({ mcpProxyPort: 4000 }), undefined, INTERNAL);
    await foreignWrite(daemon.current, { language: 'fr' });
    connection.calls.length = 0;
    // Two own echoes, the first behind the cache, then the foreign commit.
    connection.deliver();
    await handled();
    // One re-read for the foreign commit, one for the null save; none for an echo.
    expect(connection.calls.filter((call) => call === 'get')).toHaveLength(2);
    expect(applied).toHaveLength(1);
    expect([...applied[0].changedKeys]).toEqual(['language']);
    expect(applied[0].previous.language).toBe('en');
    expect(applied[0].next).toMatchObject({
      language: 'fr',
      fileAutoSave: true,
    });
    expect(await client.read('runtime')).toEqual(applied[0].next);

    // Found during a save, a foreign commit applies after it, on the latest.
    fail = true;
    await foreignWrite(daemon.current, { language: 'de' });
    await client.update(() => ({ fileAutoSave: false }), undefined, INTERNAL);
    await new Promise((resolve) => setImmediate(resolve));
    expect(applied).toHaveLength(2);
    expect(applied[1].revision).toBeGreaterThan(applied[0].revision);
    expect(applied[1].next).toMatchObject({
      language: 'de',
      fileAutoSave: false,
    });
    // The save settled fileAutoSave itself; the foreign commit changes only language.
    expect(applied[1].previous).toEqual({ ...applied[1].next, language: 'fr' });
    expect(log).toHaveBeenCalledWith(
      'A preferences change from another client could not be applied.',
      expect.any(Error),
    );
    // Its events and the own echoes, delivered late, apply nothing again.
    connection.deliver();
    await handled();
    expect(applied).toHaveLength(2);
  });

  it('serves the client-local seed by the daemon’s verdict and maps an unavailable daemon to pending', async () => {
    const daemon = { current: startDaemon() };
    const fresh = createClient(connect(daemon));
    await expect(fresh.readLegacyClientLocal()).resolves.toEqual({
      kind: 'missing',
    });
    await expect(fresh.hasPersistedState()).resolves.toBe(false);
    await expect(fresh.readAuthority()).resolves.toMatchObject({
      authority: 'absent',
    });
    await fresh.update(() => ({ language: 'fr' }), undefined, INTERNAL);
    await expect(fresh.hasPersistedState()).resolves.toBe(true);
    expect(fresh.isRecoveryLatched()).toBe(false);
    // The daemon proves the choice (CAN-7991): an absent one is the default.
    await expect(fresh.readStoredProductAnalyticsChoice()).resolves.toBe(
      'allowed',
    );

    const down = connect(daemon);
    down.failLegacy();
    const offline = createClient(down);
    await expect(offline.readLegacyClientLocal()).resolves.toEqual({
      kind: 'pending',
      served: {},
    });
    expect(offline.isRecoveryLatched()).toBe(true);
    await expect(offline.readAuthority()).resolves.toMatchObject({
      authority: 'unreadable',
    });
  });
});

/** A route whose reads, and so every load, fail as an unreachable daemon's do. */
function unreachable(
  route: PreferencesDocumentRoute,
): PreferencesDocumentRoute {
  const down = (): Promise<never> =>
    Promise.reject(
      new CanopyClientError({
        kind: 'unavailable',
        message: 'The daemon is not running.',
        retry: { kind: 'same_request' },
      }),
    );
  return { ...route, get: down, legacyClientLocal: down };
}

/** The daemon document's saved record, edited in place as another writer would. */
function editStored(
  root: string,
  edit: (preferences: Record<string, unknown>) => void,
): void {
  const path = join(root, 'preferences.json');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isObject(parsed) || !isObject(parsed.preferences))
    throw new Error('not a preferences envelope');
  edit(parsed.preferences);
  writeFileSync(path, JSON.stringify(parsed));
}

/** An in-memory document for an in-process repository nothing reads here. */
function memoryDocument(): PreferencesDocument {
  const slots = new Map<string, string>();
  const missing = (): Error =>
    Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    key: 'memory',
    readText: (slot) => {
      const text = slots.get(slot);
      return text === undefined
        ? Promise.reject(missing())
        : Promise.resolve(text);
    },
    exists: (slot) => Promise.resolve(slots.has(slot)),
    install: (slot, content) => {
      slots.set(slot, content);
      return Promise.resolve();
    },
    ensureFolder: () => Promise.resolve(),
    slotPath: (slot) => slot,
    backupLocation: (stamp) => `backup-${stamp}`,
    installBackup: () => Promise.resolve(),
    pruneBackups: () => Promise.resolve(),
  };
}

type AckParams = CanopySchemaInput<typeof CoreEventsAckParamsSchema>;
type AcknowledgeParams = z.input<typeof ConfigLoadErrorAcknowledgeParamsSchema>;
type AcknowledgeResult = z.output<
  typeof ConfigLoadErrorAcknowledgeResultSchema
>;
type SubscribeParams = CanopySchemaInput<
  typeof CoreEventsSubscribeParamsSchema
>;

/**
 * An interface session as the route sees `ElectronDaemonClient`: its calls
 * reach the daemon module's handlers, and `core.events.subscribe` serves its
 * event journal as the core events module does. `end()` drops the stream.
 */
interface Session {
  readonly client: PreferencesDocumentSessionClient;
  readonly calls: string[];
  readonly acks: number[];
  end(): void;
}

function session(
  daemon: { current: Daemon },
  clientInstanceId: string,
): Session {
  const calls: string[] = [];
  const acks: number[] = [];
  const connection = new AbortController();
  let stop: (() => void) | null = null;
  const call = (): CanopyHandlerContext => context(clientInstanceId);

  function query(
    name: 'core.config.document.get',
    params: object,
  ): Promise<ConfigDocumentGetResult>;
  function query(
    name: 'core.config.legacyClientLocal.get',
    params: object,
  ): Promise<ConfigLegacyClientLocalGetResult>;
  function query(
    name: string,
    params: object,
  ): Promise<ConfigDocumentGetResult | ConfigLegacyClientLocalGetResult> {
    calls.push(name);
    const { queries } = daemon.current.handlers;
    return name === 'core.config.document.get'
      ? queries['core.config.document.get'](params, call())
      : queries['core.config.legacyClientLocal.get'](params, call());
  }
  function instruction(
    name: 'core.config.document.update',
    params: ConfigDocumentUpdateParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<ConfigDocumentUpdateResult>;
  function instruction(
    name: 'core.events.ack',
    params: AckParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<{ acknowledgedCursor: AckParams['cursor'] }>;
  async function instruction(
    name: string,
    params: ConfigDocumentUpdateParams | AckParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<
    ConfigDocumentUpdateResult | { acknowledgedCursor: AckParams['cursor'] }
  > {
    calls.push(name);
    if (name === 'core.events.ack') {
      const { cursor } = CoreEventsAckParamsSchema.parse(params);
      acks.push(cursor.sequence);
      return { acknowledgedCursor: cursor };
    }
    return daemon.current.handlers.instructions['core.config.document.update'](
      ConfigDocumentUpdateParamsSchema.parse(params),
      context(clientInstanceId, options?.metadata?.idempotencyKey),
    );
  }
  const openStream = (
    name: 'core.events.subscribe',
    params: SubscribeParams,
    options?: CanopyClientStreamOptions<CanopyEventFrame>,
  ): Promise<CanopyEventHandle> => {
    calls.push(name);
    const { journal } = daemon.current.events;
    const cursor = CoreEventsSubscribeParamsSchema.parse(params).cursor ?? null;
    const subscribed = journal.subscribe(cursor, (entry) =>
      options?.onFrame?.({
        kind: 'item',
        cursor: entry.cursor,
        item: {
          ...entry.event,
          scope: { ...entry.event.scope },
          payload: { ...entry.event.payload },
          cursor: entry.cursor,
          eventId: `${entry.cursor.daemonEpoch}#${entry.cursor.sequence}`,
        },
      }),
    );
    if (subscribed.kind !== 'subscribed')
      return Promise.reject(new Error(subscribed.reason));
    stop = (): void => {
      subscribed.unsubscribe();
      options?.onFrame?.({
        kind: 'end',
        cursor: journal.head() ?? { daemonEpoch: journal.epoch, sequence: 0 },
        outcome: 'error',
        error: {
          kind: 'unavailable',
          message: 'The stream ended.',
          retry: { kind: 'never' },
        },
      });
    };
    return Promise.resolve({
      requestId: randomUUID(),
      openResult: { subscriptionId: randomUUID(), acceptedCursor: cursor },
      frames: (async function* () {})(),
      onFrame: () => () => undefined,
      close: () => subscribed.unsubscribe(),
    });
  };
  const epoch = daemon.current.events.journal.epoch;
  const client: PreferencesDocumentSessionClient = {
    identity: {
      connectionId: randomUUID(),
      authorityId: 'authority-1',
      runtimeId: 'runtime-1',
      hostId: 'host-1',
      daemonEpoch: epoch,
      profile: 'core',
      buildVersion: 'test',
      protocolVersion: 1,
    },
    manifest: {
      operations: new Set(['core.events.ack']),
      events: new Set(),
      streams: new Set(['core.events.subscribe']),
      has: (kind, operation) =>
        kind === 'operations'
          ? operation === 'core.events.ack'
          : kind === 'streams' && operation === 'core.events.subscribe',
    },
    signal: connection.signal,
    query,
    instruction,
    openStream,
  };
  return {
    client,
    calls,
    acks,
    end: () => stop?.(),
  };
}

/** The owner session: owner writes and the notice, as `ElectronDaemonOwnerClient`. */
function ownerSession(
  daemon: { current: Daemon },
  clientInstanceId: string,
  calls: string[],
): PreferencesDocumentOwnerClient {
  function instruction(
    name: 'core.config.document.ownerUpdate',
    params: ConfigDocumentOwnerUpdateParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<ConfigDocumentGetResult>;
  function instruction(
    name: 'core.config.loadError.acknowledge',
    params: AcknowledgeParams,
  ): Promise<AcknowledgeResult>;
  function instruction(
    name: string,
    params: ConfigDocumentOwnerUpdateParams | AcknowledgeParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<ConfigDocumentGetResult | AcknowledgeResult> {
    calls.push(name);
    const { instructions } = daemon.current.handlers;
    if (name === 'core.config.loadError.acknowledge')
      return instructions['core.config.loadError.acknowledge'](
        ConfigLoadErrorAcknowledgeParamsSchema.parse(params),
        context(clientInstanceId),
      ).then((result) => ConfigLoadErrorAcknowledgeResultSchema.parse(result));
    return instructions['core.config.document.ownerUpdate'](
      ConfigDocumentOwnerUpdateParamsSchema.parse(params),
      context(clientInstanceId, options?.metadata?.idempotencyKey),
    );
  }
  return { instruction };
}

/** Lets queued serial tasks and the subscription's pump settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

/** Resolves once `ready` holds, after file reads too; fails after a bound. */
async function until(ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !ready(); turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  if (!ready()) throw new Error('timed out');
}

describe('the daemon preferences client before it is selected (CAN-7991)', () => {
  it('answers the stored analytics choice one daemon read proved, as the in-process read judges it', async () => {
    const daemon = { current: startDaemon() };
    const connection = connect(daemon);
    const client = createClient(connection);
    // A fresh profile: the default.
    await expect(client.readStoredProductAnalyticsChoice()).resolves.toBe(
      'allowed',
    );
    await client.update(
      () => ({ usageData: { productAnalytics: false } }),
      undefined,
      CALLER,
    );
    await expect(client.readStoredProductAnalyticsChoice()).resolves.toBe(
      'denied',
    );
    // Every tracked flow, from the read itself, never the cache.
    connection.calls.length = 0;
    const read = await daemon.current.handlers.queries[
      'core.config.document.get'
    ]({}, context(DESKTOP));
    expect(read.storedUsageData).toEqual({
      productAnalytics: 'denied',
      errorReports: 'allowed',
    });
    await client.readStoredProductAnalyticsChoice();
    expect(connection.calls).toEqual(['get']);

    await client.update(
      () => ({ usageData: { productAnalytics: true } }),
      undefined,
      CALLER,
    );
    await expect(client.readStoredProductAnalyticsChoice()).resolves.toBe(
      'allowed',
    );
    // An unreadable journal denies every flow and proves no choice.
    const journal = join(
      daemon.current.root,
      'preferences.json.usage-data-denied.json',
    );
    writeFileSync(journal, 'not json');
    await expect(client.readStoredProductAnalyticsChoice()).resolves.toBe(
      'denial-journal-unreadable',
    );
    unlinkSync(journal);
    // A saved value the codec would replace with the default proves nothing,
    // judged on the saved text.
    editStored(daemon.current.root, (preferences) => {
      preferences.usageData = { productAnalytics: 'yes', errorReports: true };
    });
    await expect(client.readStoredProductAnalyticsChoice()).resolves.toBe(
      'unconfirmed',
    );
    editStored(daemon.current.root, (preferences) => {
      preferences.usageData = 'off';
    });
    await expect(client.readStoredProductAnalyticsChoice()).resolves.toBe(
      'unconfirmed',
    );
    // A journal denial over a well-formed saved allow reads as denied.
    editStored(daemon.current.root, (preferences) => {
      preferences.usageData = { productAnalytics: true };
    });
    writeFileSync(journal, JSON.stringify(['productAnalytics']));
    await expect(client.readStoredProductAnalyticsChoice()).resolves.toBe(
      'denied',
    );
    // An unreachable daemon proves nothing.
    const offline = createClient({
      ...connection,
      route: unreachable(connection.route),
    });
    await expect(offline.readStoredProductAnalyticsChoice()).resolves.toBe(
      'unconfirmed',
    );
    // A stored-choice read that fails leaves the document read whole and
    // proves nothing.
    const failing = startDaemon(daemon.current.root);
    const handlers = createCoreConfigDocumentHandlers({
      preferences: {
        ...failing.preferences,
        readStoredUsageData: () => Promise.reject(new Error('EIO')),
      },
      events: failing.events,
    });
    const whole = await handlers.queries['core.config.document.get'](
      {},
      context(DESKTOP),
    );
    expect(whole.storedUsageData).toBeUndefined();
    expect(whole.value).toMatchObject({ language: 'en' });
    const unproven = createClient({
      ...connection,
      route: {
        ...connection.route,
        get: () =>
          handlers.queries['core.config.document.get']({}, context(DESKTOP)),
      },
    });
    await expect(unproven.readStoredProductAnalyticsChoice()).resolves.toBe(
      'unconfirmed',
    );
  });

  it('runs the client pre-commit hook before each send, on the predicted change, and sends nothing when it refuses', async () => {
    const daemon = { current: startDaemon() };
    const connection = connect(daemon);
    const storedAtHook: unknown[] = [];
    const beforeSave = jest.fn(
      async (change: PreferencesChange<Stored>): Promise<void> => {
        const stored =
          await daemon.current.preferences.repository.read('persisted');
        storedAtHook.push(stored.language);
        if (change.next.language === 'refused') throw new Error('refused');
      },
    );
    const client = createClient(connection, { hooks: { beforeSave } });
    await client.update(() => ({ language: 'fr' }), undefined, INTERNAL);
    expect(beforeSave).toHaveBeenCalledTimes(1);
    expect(beforeSave.mock.calls[0][0].previous.language).toBe('en');
    expect(beforeSave.mock.calls[0][0].next.language).toBe('fr');
    // Before the send: the daemon still held the old value.
    expect(storedAtHook).toEqual(['en']);

    // usageData merged per key, as the daemon merges it.
    beforeSave.mockClear();
    await client.update(
      () => ({ usageData: { productAnalytics: false } }),
      undefined,
      CALLER,
    );
    expect(beforeSave.mock.calls[0][0].next.usageData).toEqual({
      productAnalytics: false,
      errorReports: true,
    });

    // Each attempt: a conflict re-runs the updater and the hook.
    beforeSave.mockClear();
    await foreignWrite(daemon.current, { fileAutoSave: true });
    await client.update(
      (latest) => ({ fileAutoSave: latest.fileAutoSave !== true }),
      undefined,
      INTERNAL,
    );
    expect(beforeSave).toHaveBeenCalledTimes(2);

    // A refusal fails the save with nothing sent.
    beforeSave.mockClear();
    connection.calls.length = 0;
    await expect(
      client.update(() => ({ language: 'refused' }), undefined, INTERNAL),
    ).rejects.toThrow('refused');
    expect(connection.calls).not.toContain('update');
    expect(connection.calls).not.toContain('ownerUpdate');
    expect(
      (await daemon.current.preferences.repository.read('persisted')).language,
    ).toBe('fr');

    // A client-only save commits nothing, so it runs no hook.
    beforeSave.mockClear();
    await client.update(() => null, undefined, {
      route: 'caller',
      isClientOnly: () => true,
    });
    expect(beforeSave).not.toHaveBeenCalled();
  });

  it('runs the store’s Copilot notice and usage-data denial before the daemon write', async () => {
    const daemon = { current: startDaemon() };
    const connection = connect(daemon);
    mockPreferencesFilePath = join(freshRoot(), 'preferences.json');
    const store = jest.requireActual<typeof PreferencesStoreModule>(
      '../../lib/preferences-store',
    );
    const policy = getUsageDataPolicy();
    const atWrite: unknown[] = [];
    const route: PreferencesDocumentRoute = {
      ...connection.route,
      update: (params, options) => {
        atWrite.push(policy.getUsageDataPolicySnapshot().preferences);
        return connection.route.update(params, options);
      },
    };
    const client = store.createDaemonDomainPreferences(route);
    const notices: Array<{ kind: string; written: string[] }> = [];
    const stop = store.observeCopilotSelectionAuthority((change) =>
      notices.push({ kind: change.kind, written: [...connection.calls] }),
    );
    try {
      await client.read('persisted');
      connection.calls.length = 0;
      await client.update(
        () => ({ copilotVaultSelection: null }),
        undefined,
        INTERNAL,
      );
      // Notified before the owner write left.
      expect(notices).toEqual([{ kind: 'changing', written: [] }]);
      expect(connection.calls).toContain('ownerUpdate');

      policy.setPreferences({
        ...policy.getUsageDataPolicySnapshot().preferences,
        productAnalytics: true,
      });
      await client.update(
        (latest) => ({
          usageData: { ...latest.usageData, productAnalytics: false },
        }),
        undefined,
        CALLER,
      );
      // The revoked flow was already off in main when the save was sent.
      expect(atWrite).toEqual([
        expect.objectContaining({ productAnalytics: false }),
      ]);
    } finally {
      stop();
      client.close();
    }
  });

  it('answers a client-only save on a cold cache without daemon I/O, even with the daemon down', async () => {
    const daemon = { current: startDaemon() };
    const connection = connect(daemon);
    const { preferences } = openPreferences(freshRoot());
    for (const route of [connection.route, unreachable(connection.route)]) {
      connection.calls.length = 0;
      const client = createClient({ ...connection, route });
      let clientOnly = false;
      const change = await client.update(
        () => {
          clientOnly = true;
          return null;
        },
        undefined,
        { route: 'caller', isClientOnly: () => clientOnly },
      );
      expect(connection.calls).toEqual([]);
      // The defaults stand in for the unread document, latched as unproven
      // and marked on the save's own answer.
      expect(change.next).toBe(change.previous);
      expect(change.previous).toEqual(preferences.codec.defaults);
      expect(change.unread).toBe(true);
      expect(client.isRecoveryLatched()).toBe(true);
    }

    // A domain patch loads the document and runs the updater again on it.
    await foreignWrite(daemon.current, { language: 'fr' });
    const cold = createClient(connection);
    connection.calls.length = 0;
    const seen: unknown[] = [];
    const change = await cold.update(
      (latest) => {
        seen.push(latest.language);
        return { fileAutoSave: true };
      },
      undefined,
      { route: 'internal', isClientOnly: () => false },
    );
    expect(seen).toEqual(['en', 'fr']);
    expect(connection.calls).toEqual(['get', 'legacyClientLocal', 'update']);
    expect(change.unread).toBeUndefined();
    const local = inProcess();
    await local.foreign({ language: 'fr' });
    expect(change).toEqual(await local.update(() => ({ fileAutoSave: true })));

    // A refusal on the stand-in decides nothing: the stored document does.
    const strict = createClient(connection);
    let strictClientOnly = false;
    const strictChange = await strict.update(
      (latest) => {
        strictClientOnly = false;
        if (latest.language !== 'fr') throw new Error('needs the document');
        strictClientOnly = true;
        return null;
      },
      undefined,
      { route: 'caller', isClientOnly: () => strictClientOnly },
    );
    expect(strictChange.next.language).toBe('fr');
  });

  it('routes over the interface and owner sessions, follows commit events and refuses definitely with no session', async () => {
    const daemon = { current: startDaemon() };
    let live: Session | null = null;
    const ownerCalls: string[] = [];
    let owner: PreferencesDocumentOwnerClient | null = null;
    const warn = jest.fn();
    const route: DaemonPreferencesRoute = createDaemonPreferencesRoute({
      clientInstanceId: DESKTOP,
      ownerClientInstanceId: 'electron-main:owner',
      client: () => live?.client ?? null,
      ownerClient: () =>
        owner === null
          ? Promise.reject(new Error('no owner session'))
          : Promise.resolve(owner),
      log: { warn },
    });
    const applied: DaemonForeignCommit<Stored>[] = [];
    const clientErrors = jest.fn();
    const { preferences } = openPreferences(freshRoot());
    const client = createDaemonPreferencesClient<Stored>({
      route,
      codec: preferences.codec,
      applyForeignCommit: (commit) => {
        applied.push(commit);
        return Promise.resolve();
      },
      paths: { document: '/data/preferences.json', lastGood: '/data/lg' },
      log: { error: clientErrors },
    });
    try {
      // No session: a definite refusal, never an unknown outcome, and the
      // client-local seed is pending.
      const refusal = await route.get().catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(CanopyClientError);
      const payload = toCanopyClientError(refusal).payload;
      expect(payload).toMatchObject({
        kind: 'unavailable',
        code: DAEMON_PREFERENCES_UNAVAILABLE_CODE,
      });
      expect(isUnknownKeyedWriteOutcome(payload)).toBe(false);
      await expect(client.readLegacyClientLocal()).resolves.toEqual({
        kind: 'pending',
        served: {},
      });
      const offlineSave = client.update(
        () => ({ language: 'de' }),
        undefined,
        INTERNAL,
      );
      await expect(offlineSave).rejects.toMatchObject({
        payload: { code: DAEMON_PREFERENCES_UNAVAILABLE_CODE },
      });
      await expect(offlineSave).rejects.not.toBeInstanceOf(
        CanopyOutcomeUnknownError,
      );

      // A session opens: the stream follows it, and the first open re-reads.
      live = session(daemon, DESKTOP);
      owner = ownerSession(daemon, 'electron-main:owner', ownerCalls);
      await client.read('persisted');
      await settle();
      expect(live.calls).toContain('core.events.subscribe');

      // Owner writes go over the owner session; their echo is skipped.
      await client.update(
        () => ({ suggestions: 'main', language: 'fr' }),
        undefined,
        INTERNAL,
      );
      expect(ownerCalls).toEqual(['core.config.document.ownerUpdate']);
      await client.update(() => ({ fileAutoSave: true }), undefined, CALLER);
      expect(live.calls).toContain('core.config.document.update');
      await settle();
      expect(applied).toHaveLength(0);

      // Another client's commit arrives over the stream and applies once.
      await foreignWrite(daemon.current, { language: 'de' });
      await until(() => applied.length > 0);
      expect(applied).toHaveLength(1);
      expect([...applied[0].changedKeys]).toEqual(['language']);
      expect(await client.read('runtime')).toMatchObject({
        language: 'de',
        fileAutoSave: true,
        suggestions: 'main',
      });
      expect(live.acks.length).toBeGreaterThan(0);

      // The stream drops; the next call resumes it from its cursor, and a
      // commit made meanwhile still applies once.
      live.end();
      await settle();
      await foreignWrite(daemon.current, { language: 'it' });
      await client.readStoredProductAnalyticsChoice();
      await until(() => applied.length > 1);
      expect(applied).toHaveLength(2);
      expect(applied[1].next.language).toBe('it');
      expect(warn).not.toHaveBeenCalled();
      expect(clientErrors).not.toHaveBeenCalled();
    } finally {
      client.close();
      await route.close();
    }
  });

  it('selects the daemon client only when one is given', () => {
    const daemon = { current: startDaemon() };
    const repository = createPreferencesRepository<StoredDomainPreferences>({
      document: () => memoryDocument(),
      codec: preserveStoredKeys(
        DESKTOP_PREFERENCES_CODEC,
        CLIENT_LOCAL_PREFERENCE_KEYS,
      ),
      log: { error: jest.fn() },
    });
    const sources: InProcessDomainPreferencesSources = {
      readStoredProductAnalyticsChoice: () => Promise.resolve('allowed'),
    };
    mockPreferencesFilePath = join(
      daemon.current.root,
      'electron-preferences.json',
    );
    const store = jest.requireActual<typeof PreferencesStoreModule>(
      '../../lib/preferences-store',
    );
    const daemonPort = store.createDaemonDomainPreferences(
      connect(daemon).route,
    );
    try {
      expect(
        selectDomainPreferences(repository, sources, { daemon: daemonPort }),
      ).toBe(daemonPort);
      expect(selectDomainPreferences(repository, sources)).not.toBe(daemonPort);
    } finally {
      daemonPort.close();
    }
  });
});
