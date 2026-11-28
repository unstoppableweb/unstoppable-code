// Golden for the preference outbox (CAN-7993, CAN-5722 slice O): the outbox
// port around the daemon client (CAN-7986), over the daemon's real document
// handlers and repository (CAN-7956) on a temporary data root, while the
// daemon is unavailable and after it is reached again. A route stands in for
// the connection only, so the daemon can be made unreachable.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CanopyClientError, toCanopyClientError } from '@canopy/core-client';
import { CanopyOutcomeUnknownError } from '@canopy/core-client/outcome';
import type {
  PreferencesChange,
  PreferencesCodec,
} from '@canopy/core-runtime/node/preferences';
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
import { DESKTOP_PREFERENCES_CODEC } from '@canopy/desktop-shared/node/preferences/desktop-preferences-codec';
import { installPreferencesNormalizationEnvironment } from '@canopy/desktop-shared/node/preferences/normalization-environment';
import { createCatalogPreferencesModelFacts } from '@canopy/desktop-shared/node/preferences/catalog-model-facts';
import type { DomainPreferencesData } from '@canopy/desktop-shared/node/preferences/client-local-preferences';
import {
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
  resolveKnownModel,
} from '@canopy/desktop-shared/types';
import type { CanopyHandlerContext } from '@canopy/core-runtime/runtime/types';
import { ConfigDocumentUpdateParamsSchema } from '@canopy/protocol/canopy-core/core';
import {
  createDefaultApprovalDefaults,
  type ApprovalRule,
} from '@canopy/protocol/approval-policy';
import {
  markPreferencesAuthorityConfirmed,
  markPreferencesAuthorityUnconfirmed,
  readPreferencesApprovalAuthority,
  trackPreferencesAuthoritySave,
} from '../../approvals/rule-revisions';
import { createElectronDaemonHealth } from '../../canopy-runtime/electron-daemon-health';
import {
  createDaemonPreferencesClient,
  type DaemonForeignCommit,
  type DaemonPreferencesHooks,
  type PreferencesDocumentEvent,
  type PreferencesDocumentRoute,
} from '../../canopy-runtime/preferences-daemon-client';
import {
  createPreferenceOutboxPort,
  PREFERENCE_OUTBOX_FILE_NAME,
  PreferenceOutboxStore,
  readPreferencesProjection,
  warnThroughDaemonHealth,
  type PreferenceOutboxPort,
} from '../preference-outbox';

type Stored = DaemonStoredPreferences;

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
const INTERNAL = { route: 'internal' } as const;
const CALLER = { route: 'caller' } as const;

let roots: string[] = [];
const repositories: DaemonPreferences['repository'][] = [];
const freshRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'preference-outbox-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  try {
    // A save can acknowledge before its last-good backup refresh finishes.
    await Promise.all(repositories.splice(0).map((repo) => repo.flush()));
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots = [];
    markPreferencesAuthorityConfirmed();
  }
});

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

interface Daemon {
  handlers: CoreConfigDocumentHandlers;
  root: string;
  codec: PreferencesCodec<Stored>;
}

function startDaemon(
  root = freshRoot(),
  inner: PreferencesCodec<Record<string, unknown>> = codec,
): Daemon {
  const events = createConfigCommitEvents({ epoch: randomUUID() });
  const preferences = createDaemonPreferences({
    dataRoot: root,
    codec: inner,
    usageDataKeys: USAGE,
    syncDirectory: () => Promise.resolve('flushed'),
    ownership: FLIPPED,
    hooks: events.hooks,
    log: { error: jest.fn() },
  });
  repositories.push(preferences.repository);
  return {
    handlers: createCoreConfigDocumentHandlers({ preferences, events }),
    root,
    codec: preferences.codec,
  };
}

async function stored(daemon: Daemon): Promise<Record<string, unknown>> {
  const document = await daemon.handlers.queries['core.config.document.get'](
    {},
    context(DESKTOP),
  );
  return document.value;
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

/**
 * The connection to `daemon`; `down` makes every call fail before sending,
 * and `writesUntilDown` sets it after that many more writes. `refuse` has
 * the daemon refuse a patch; `emit` sends the client a document event.
 */
interface Connection {
  readonly route: PreferencesDocumentRoute;
  readonly calls: string[];
  down: boolean;
  loseNextWrite: boolean;
  writesUntilDown: number | null;
  refuse: ((patch: Record<string, unknown>) => boolean) | null;
  emit: (event: PreferencesDocumentEvent) => void;
}

function connect(daemon: Daemon): Connection {
  const unavailable = (): CanopyClientError =>
    new CanopyClientError({
      kind: 'unavailable',
      message: 'The daemon is not running.',
      retry: { kind: 'same_request' },
    });
  const call = async <R>(name: string, work: () => Promise<R>): Promise<R> => {
    connection.calls.push(name);
    const isWrite = name === 'update' || name === 'ownerUpdate';
    if (isWrite && connection.writesUntilDown !== null) {
      if (connection.writesUntilDown === 0) connection.down = true;
      else connection.writesUntilDown -= 1;
    }
    if (connection.down) throw unavailable();
    let result: R;
    try {
      result = await work();
    } catch (error) {
      throw toCanopyClientError(error);
    }
    if (connection.loseNextWrite && isWrite) {
      connection.loseNextWrite = false;
      throw new CanopyClientError({
        kind: 'unavailable',
        message: 'The connection closed before the reply.',
        retry: { kind: 'never' },
      });
    }
    return result;
  };
  const route: PreferencesDocumentRoute = {
    clientInstanceId: DESKTOP,
    get: () =>
      call('get', () =>
        daemon.handlers.queries['core.config.document.get'](
          {},
          context(DESKTOP),
        ),
      ),
    legacyClientLocal: () =>
      call('legacy', () =>
        daemon.handlers.queries['core.config.legacyClientLocal.get'](
          {},
          context(DESKTOP),
        ),
      ),
    update: (params, options) =>
      call('update', () => {
        if (connection.refuse?.(params.patch) === true)
          throw new CanopyClientError({
            kind: 'invalid_argument',
            message: 'The daemon refused the patch.',
            retry: { kind: 'never' },
          });
        return daemon.handlers.instructions['core.config.document.update'](
          params,
          context(DESKTOP, options.metadata?.idempotencyKey),
        );
      }),
    ownerUpdate: (params, options) =>
      call('ownerUpdate', () =>
        daemon.handlers.instructions['core.config.document.ownerUpdate'](
          params,
          context(DESKTOP, options.metadata?.idempotencyKey),
        ),
      ),
    acknowledgeLoadError: (params) =>
      daemon.handlers.instructions['core.config.loadError.acknowledge'](
        params,
        context(DESKTOP),
      ),
    subscribe: (listener) => {
      connection.emit = listener;
      return () => undefined;
    },
  };
  const connection: Connection = {
    route,
    calls: [],
    down: false,
    loseNextWrite: false,
    writesUntilDown: null,
    refuse: null,
    emit: () => undefined,
  };
  return connection;
}

interface Harness {
  port: PreferenceOutboxPort<Stored>;
  connection: Connection;
  outboxRoot: string;
  warn: jest.Mock;
  deny: jest.Mock;
  /** Reaches the daemon again; `writesUntilDown` loses it mid-drain. */
  reconnect(writesUntilDown?: number | null): Promise<void>;
}

function openPort(
  daemon: Daemon,
  extra: {
    outboxRoot?: string;
    hooks?: DaemonPreferencesHooks<Stored>;
    maxEntries?: number;
    warn?: () => void;
    applyForeignCommit?: (commit: DaemonForeignCommit<Stored>) => Promise<void>;
  } = {},
): Harness {
  const connection = connect(daemon);
  const outboxRoot = extra.outboxRoot ?? freshRoot();
  const warn = jest.fn(extra.warn);
  const deny = jest.fn();
  let listener: (() => void) | null = null;
  const port = createPreferenceOutboxPort<Stored>({
    createClient: ({ hooks, applyForeignCommit }) =>
      createDaemonPreferencesClient<Stored>({
        route: connection.route,
        codec: daemon.codec,
        hooks,
        applyForeignCommit,
        paths: { document: '/data/preferences.json', lastGood: '/data/lg' },
        log: { error: jest.fn() },
      }),
    hooks: extra.hooks,
    applyForeignCommit: extra.applyForeignCommit,
    codec: daemon.codec,
    store: new PreferenceOutboxStore(() => outboxRoot),
    readProjection: () =>
      readPreferencesProjection(
        {
          document: join(daemon.root, 'preferences.json'),
          lastGood: join(daemon.root, 'preferences.last-good.json'),
          usageDataDenials: join(
            daemon.root,
            'preferences.json.usage-data-denied.json',
          ),
        },
        USAGE,
      ),
    usageDataKeys: USAGE,
    denyUsageData: deny,
    warn,
    onReconnect: (next) => {
      listener = next;
      return (): void => {
        listener = null;
      };
    },
    maxEntries: extra.maxEntries,
    log: { error: jest.fn() },
  });
  return {
    port,
    connection,
    outboxRoot,
    warn,
    deny,
    reconnect: async (writesUntilDown: number | null = null) => {
      connection.down = false;
      connection.writesUntilDown = writesUntilDown;
      listener?.();
      await port.idle();
    },
  };
}

const outboxPath = (harness: Harness): string =>
  join(harness.outboxRoot, PREFERENCE_OUTBOX_FILE_NAME);

/** A save of `patch`, as the renderer's (`CALLER`) or main's own. */
const save = (
  port: PreferenceOutboxPort<Stored>,
  patch: Record<string, unknown>,
  route: typeof CALLER | typeof INTERNAL = CALLER,
): ReturnType<PreferenceOutboxPort<Stored>['update']> =>
  port.update(() => patch, undefined, route);

const selectionsOf = (value: Stored): Record<string, unknown> =>
  isObject(value.globalPluginSelections) ? value.globalPluginSelections : {};

describe('the preference outbox while the daemon is unavailable (CAN-7993)', () => {
  it('keeps saves durably, serves them through the overlay and drains them in order on reconnect', async () => {
    const daemon = startDaemon();
    const harness = openPort(daemon);
    const { port, connection } = harness;
    await port.read('persisted');
    connection.down = true;

    const first = await save(port, { language: 'fr' });
    expect(first.next.language).toBe('fr');
    const toggled = await port.update(
      (latest) => ({ fileAutoSave: latest.fileAutoSave !== true }),
      undefined,
      INTERNAL,
    );
    expect(toggled.previous.language).toBe('fr');
    await save(port, { language: 'de' });
    // A null and an unchanged save keep nothing.
    await port.update(() => null, undefined, INTERNAL);
    await save(port, { language: 'de' });

    expect(harness.warn).toHaveBeenCalled();
    expect(port.pending()).toBe(3);
    expect(existsSync(outboxPath(harness))).toBe(true);
    await expect(port.read('persisted')).resolves.toMatchObject({
      language: 'de',
      fileAutoSave: true,
    });
    await expect(port.readAuthority()).resolves.toMatchObject({
      authority: 'ok',
      preferences: { language: 'de', fileAutoSave: true },
    });
    await expect(stored(daemon)).resolves.toMatchObject({
      language: 'en',
      fileAutoSave: false,
    });

    await harness.reconnect();
    expect(port.pending()).toBe(0);
    expect(existsSync(outboxPath(harness))).toBe(false);
    await expect(stored(daemon)).resolves.toMatchObject({
      language: 'de',
      fileAutoSave: true,
    });
    // In order: fr, the toggle, then de.
    expect(
      connection.calls.filter((call) => call === 'update').length,
    ).toBeGreaterThanOrEqual(3);
    // Later saves go straight to the daemon again.
    connection.calls.length = 0;
    await save(port, { language: 'it' });
    expect(connection.calls).toEqual(['update']);
  });

  it('keeps the outbox across a restart, cold-starting from the read-only disk projection', async () => {
    const daemon = startDaemon();
    await foreignWrite(daemon, { language: 'fr' });
    const bytes = readFileSync(join(daemon.root, 'preferences.json'));
    const first = openPort(daemon);
    first.connection.down = true;

    // No cache: the disk projection answers.
    await expect(first.port.read('persisted')).resolves.toMatchObject({
      language: 'fr',
    });
    await save(first.port, { fileAutoSave: true });
    first.port.dispose();

    const second = openPort(daemon, { outboxRoot: first.outboxRoot });
    second.connection.down = true;
    await expect(second.port.read('persisted')).resolves.toMatchObject({
      language: 'fr',
      fileAutoSave: true,
    });
    expect(second.port.pending()).toBe(1);
    // Read-only: the projection never writes the preferences row.
    expect(readFileSync(join(daemon.root, 'preferences.json'))).toEqual(bytes);

    await second.reconnect();
    await expect(stored(daemon)).resolves.toMatchObject({
      language: 'fr',
      fileAutoSave: true,
    });
    expect(second.port.pending()).toBe(0);

    // A corrupt primary, served from last-good, proves no authority.
    writeFileSync(join(daemon.root, 'preferences.json'), '{"version":');
    const third = openPort(daemon);
    third.connection.down = true;
    await expect(
      third.port.readAuthority({ includeServed: true }),
    ).resolves.toMatchObject({
      authority: 'unreadable',
      served: { language: 'fr' },
    });
  });

  it('keeps usage-data revocations first and never drops them, past the bound or from a damaged outbox', async () => {
    const daemon = startDaemon();
    const harness = openPort(daemon, { maxEntries: 2 });
    const { port, connection } = harness;
    await port.read('persisted');
    connection.down = true;

    await port.update(
      (latest) => ({
        usageData: {
          ...(isObject(latest.usageData) ? latest.usageData : {}),
          productAnalytics: false,
        },
      }),
      undefined,
      CALLER,
    );
    expect(harness.deny).toHaveBeenCalledWith(['productAnalytics']);
    // Revoked, allowed again, then revoked: the last choice stands.
    await save(port, { usageData: { errorReports: false } });
    await save(port, { usageData: { errorReports: true } });
    for (const language of ['a', 'b', 'c', 'd', 'e'])
      await save(port, { language });
    // Bounded: two entries and the revocations.
    expect(port.pending()).toBe(3);
    await expect(port.read('persisted')).resolves.toMatchObject({
      language: 'e',
      usageData: { productAnalytics: false, errorReports: true },
    });

    await harness.reconnect();
    await expect(stored(daemon)).resolves.toMatchObject({
      language: 'e',
      usageData: { productAnalytics: false, errorReports: true },
    });

    // An allow queued before a revocation never follows it to the daemon,
    // even when the daemon is lost again before the queue empties.
    const unbounded = openPort(daemon);
    await unbounded.port.read('persisted');
    unbounded.connection.down = true;
    await save(unbounded.port, {
      language: 'f',
      usageData: { productAnalytics: true },
    });
    await save(unbounded.port, { usageData: { productAnalytics: false } });
    await save(unbounded.port, { language: 'g' });
    // The daemon holds the revocation already: only language f is written.
    await unbounded.reconnect(1);
    expect(unbounded.port.pending()).toBe(1);
    await expect(stored(daemon)).resolves.toMatchObject({
      language: 'f',
      usageData: { productAnalytics: false },
    });
    await unbounded.reconnect();
    expect(unbounded.port.pending()).toBe(0);
    await expect(stored(daemon)).resolves.toMatchObject({
      language: 'g',
      usageData: { productAnalytics: false },
    });

    // A damaged outbox may have held a revocation: every flow is revoked.
    const damaged = openPort(startDaemon());
    writeFileSync(outboxPath(damaged), '{"version":1,"entries":');
    damaged.connection.down = true;
    await expect(damaged.port.read('persisted')).resolves.toMatchObject({
      usageData: { productAnalytics: false, errorReports: false },
    });
    expect(damaged.deny).toHaveBeenCalledWith(USAGE);
    expect(
      readdirSync(damaged.outboxRoot).some((name) =>
        name.startsWith(`${PREFERENCE_OUTBOX_FILE_NAME}.damaged-`),
      ),
    ).toBe(true);

    // One it cannot read is set aside too, never overwritten.
    const unreadable = openPort(startDaemon());
    mkdirSync(outboxPath(unreadable));
    writeFileSync(join(outboxPath(unreadable), 'held'), 'a queued save');
    unreadable.connection.down = true;
    await expect(unreadable.port.read('persisted')).resolves.toMatchObject({
      usageData: { productAnalytics: false, errorReports: false },
    });
    const aside = readdirSync(unreadable.outboxRoot).find((name) =>
      name.startsWith(`${PREFERENCE_OUTBOX_FILE_NAME}.damaged-`),
    );
    expect(aside).toBeDefined();
    expect(
      readFileSync(join(unreadable.outboxRoot, aside ?? '', 'held'), 'utf8'),
    ).toBe('a queued save');
  });

  it('re-merges the open keys an internal save carries and admits one-key globalPluginSelections saves', async () => {
    const daemon = startDaemon();
    let foreign: (commit: DaemonForeignCommit<Stored>) => void = () =>
      undefined;
    const harness = openPort(daemon, {
      applyForeignCommit: (commit) => {
        foreign(commit);
        return Promise.resolve();
      },
    });
    const { port, connection } = harness;
    await foreignWrite(daemon, {
      globalPluginSelections: { a: true, b: true },
    });
    await port.read('persisted');
    connection.down = true;

    // As the marketplace prune: the selections and a protected key, owner-only.
    await port.update(
      (latest) => ({
        globalPluginSelections: Object.fromEntries(
          Object.entries(selectionsOf(latest)).filter(([id]) => id !== 'b'),
        ),
        suggestions: 'pruned',
      }),
      undefined,
      INTERNAL,
    );
    // A one-key selections save, open on its own.
    await port.update(
      (latest) => ({
        globalPluginSelections: { ...selectionsOf(latest), d: true },
      }),
      undefined,
      INTERNAL,
    );
    // A scalar an internal save derived from its read.
    await port.update(
      (latest) => ({ language: latest.language === 'en' ? 'fr' : 'it' }),
      undefined,
      INTERNAL,
    );
    expect(port.pending()).toBe(3);
    // Meanwhile another client adds a selection and sets the language.
    await foreignWrite(daemon, {
      globalPluginSelections: { a: true, b: true, c: true },
    });
    await foreignWrite(daemon, { language: 'de' });

    // Found before anything drains, the other client's commit reaches the
    // host with the queue over it, as the drain will leave it.
    const found = new Promise<DaemonForeignCommit<Stored>>((resolve) => {
      foreign = resolve;
    });
    connection.down = false;
    connection.emit({ name: 'resync' });
    await expect(found).resolves.toMatchObject({
      next: {
        globalPluginSelections: { a: true, c: true, d: true },
        suggestions: 'pruned',
        language: 'de',
      },
    });

    await harness.reconnect();
    expect(connection.calls).toContain('ownerUpdate');
    await expect(stored(daemon)).resolves.toMatchObject({
      globalPluginSelections: { a: true, c: true, d: true },
      suggestions: 'pruned',
      // The later change by the other client stands.
      language: 'de',
    });
    expect(port.pending()).toBe(0);
  });

  it('applies approval narrowings in memory at once and widenings only once drained (T31)', async () => {
    const daemon = startDaemon();
    const allow = (pattern: string): ApprovalRule => ({
      id: pattern,
      behavior: 'allow',
      target: { kind: 'command', pattern },
      createdAt: '2026-11-26T00:00:00.000Z',
      origin: 'settings',
    });
    const bash = allow('bash');
    const read = allow('read');
    const write = allow('write');
    // The stored rules, as the known rules they hold.
    const rulesOf = (value: unknown): ApprovalRule[] =>
      Array.isArray(value)
        ? [bash, read, write].filter((rule) =>
            value.some((held) => isObject(held) && held.id === rule.id),
          )
        : [];
    const changed = ({ previous, next }: PreferencesChange<Stored>): boolean =>
      JSON.stringify(previous.globalApprovalRules) !==
      JSON.stringify(next.globalApprovalRules);
    const hooks: DaemonPreferencesHooks<Stored> = {
      trackSave: (save, change) =>
        changed(change)
          ? trackPreferencesAuthoritySave(save, { narrowsFileWrites: false })
          : save,
      onSaveOutcomeUnknown: (change) => {
        if (changed(change))
          markPreferencesAuthorityUnconfirmed({
            globalApprovalRules: rulesOf(change.previous.globalApprovalRules),
            approvalDefaults: createDefaultApprovalDefaults(),
          });
      },
      onSaveDurable: () => markPreferencesAuthorityConfirmed(),
      onCommitted: (next) => committed.push(next),
    };
    const committed: Stored[] = [];
    const harness = openPort(daemon, { hooks });
    const { port, connection } = harness;
    await save(port, { globalApprovalRules: [bash, read] }, INTERNAL);
    const authority = (): ReturnType<
      typeof readPreferencesApprovalAuthority<
        Awaited<ReturnType<typeof port.readAuthority>>
      >
    > => readPreferencesApprovalAuthority(() => port.readAuthority());
    expect((await authority()).confirmed).toBeUndefined();
    connection.down = true;

    // Narrowed: the overlay drops Read at once; Read stays confirmed only.
    await save(port, { globalApprovalRules: [bash] }, INTERNAL);
    let current = await authority();
    expect(current.value.preferences.globalApprovalRules).toEqual([bash]);
    expect(current.confirmed?.globalApprovalRules).toEqual([bash, read]);

    // Widened: Write is in the overlay but not in the confirmed rules.
    await save(port, { globalApprovalRules: [bash, write] }, INTERNAL);
    current = await authority();
    expect(current.value.preferences.globalApprovalRules).toEqual([
      bash,
      write,
    ]);
    expect(current.confirmed?.globalApprovalRules).toEqual([bash, read]);

    // Lost again after the narrowing drained: the widening is still queued,
    // so authority stays unconfirmed, and the host is only handed the
    // document with it.
    committed.length = 0;
    await harness.reconnect(1);
    expect(port.pending()).toBe(1);
    expect(committed.length).toBeGreaterThan(0);
    for (const value of committed)
      expect(value.globalApprovalRules).toEqual([bash, write]);
    current = await authority();
    expect(current.confirmed?.globalApprovalRules).toEqual([bash, read]);

    await harness.reconnect();
    current = await authority();
    expect(current.confirmed).toBeUndefined();
    expect(current.value.preferences.globalApprovalRules).toEqual([
      bash,
      write,
    ]);
    await expect(stored(daemon)).resolves.toMatchObject({
      globalApprovalRules: [bash, write],
    });
  });

  it('warns through the background service notice and never queues an unknown outcome', async () => {
    const health = createElectronDaemonHealth({
      warn: jest.fn(),
      info: jest.fn(),
    });
    health.setConsumerEnabled('preferences', true);
    const daemon = startDaemon();
    const harness = openPort(daemon, { warn: warnThroughDaemonHealth(health) });
    const { port, connection } = harness;
    await port.read('persisted');

    connection.loseNextWrite = true;
    await expect(save(port, { language: 'fr' })).rejects.toBeInstanceOf(
      CanopyOutcomeUnknownError,
    );
    expect(port.pending()).toBe(0);
    expect(health.getStatus().state).not.toBe('unavailable');

    connection.down = true;
    await save(port, { language: 'de' });
    expect(health.getStatus()).toMatchObject({
      state: 'unavailable',
      reason: 'host_unavailable',
    });
    // A value the protocol refuses is the save's own error, never queued.
    await expect(
      save(port, { mcpProxyPort: Number.NaN }, INTERNAL),
    ).rejects.toThrow();
    expect(port.pending()).toBe(1);

    // A queued save the daemon refuses is dropped, not held before later ones.
    connection.down = false;
    connection.refuse = (patch): boolean => patch.language === 'de';
    await save(port, { fileAutoSave: true });
    expect(port.pending()).toBe(0);
    // The lost reply's save committed; the refused one never does.
    await expect(stored(daemon)).resolves.toMatchObject({
      language: 'fr',
      fileAutoSave: true,
    });
  });

  it('gives a queued caller patch the save rules a live save gets, and keeps it off the owner path', async () => {
    const daemon = startDaemon();
    const harness = openPort(daemon, { maxEntries: 3 });
    const { port, connection } = harness;
    await foreignWrite(daemon, { globalPluginSelections: { a: true } });
    const refused = { language: 'fr', approvalDefaults: { mode: 'allow' } };
    const live: unknown = await save(port, refused).catch(
      (error: unknown) => error,
    );
    connection.down = true;

    // Rule 1: refused as live, never queued.
    const queued: unknown = await save(port, refused).catch(
      (error: unknown) => error,
    );
    for (const error of [live, queued])
      expect(toCanopyClientError(error).payload).toMatchObject({
        kind: 'invalid_argument',
        code: 'core.config.protectedKey',
      });
    expect(port.pending()).toBe(0);

    // Rule 3: a wider patch's copy of the selections is never written.
    await save(port, { language: 'fr', globalPluginSelections: { x: true } });
    await save(port, { language: 'de' });
    // The one-key intent is, and never merges into a wider patch.
    await port.update(
      (latest) => ({
        globalPluginSelections: { ...selectionsOf(latest), y: true },
      }),
      undefined,
      CALLER,
    );
    // Curated seeding: two keys and the selections, owner-only.
    await port.update(
      (latest) => ({
        suggestions: 'seeded',
        fileAutoSave: true,
        globalPluginSelections: { ...selectionsOf(latest), z: true },
      }),
      undefined,
      INTERNAL,
    );
    expect(port.pending()).toBe(3);
    await expect(port.read('persisted')).resolves.toMatchObject({
      language: 'de',
      globalPluginSelections: { a: true, y: true, z: true },
    });
    // Full: the language saves merge past the two entries between them,
    // which never write it, and internal saves merge past caller ones.
    await save(port, { language: 'it' });
    await save(port, { suggestions: 'kept' }, INTERNAL);
    expect(port.pending()).toBe(3);

    connection.calls.length = 0;
    await harness.reconnect();
    expect(port.pending()).toBe(0);
    expect(connection.calls.filter((call) => call === 'ownerUpdate')).toEqual([
      'ownerUpdate',
    ]);
    const after = await stored(daemon);
    expect(after).toMatchObject({
      language: 'it',
      suggestions: 'kept',
      fileAutoSave: true,
    });
    expect(after.globalPluginSelections).toEqual({ a: true, y: true, z: true });

    // Only saves of two routes alternating on one key fill it: the save
    // fails, and its revocation is still kept.
    connection.down = true;
    await save(port, { language: 'a' });
    await save(port, { language: 'b' }, INTERNAL);
    await save(port, { language: 'c' });
    await expect(
      save(
        port,
        { language: 'd', usageData: { errorReports: false } },
        INTERNAL,
      ),
    ).rejects.toThrow("Couldn't save this preference.");
    expect(port.pending()).toBe(4);
    await harness.reconnect();
    await expect(stored(daemon)).resolves.toMatchObject({
      language: 'c',
      usageData: { errorReports: false },
    });
  });

  it("passes the client's unread answer through and marks its own only where no read proved the document (CAN-7991)", async () => {
    const clientOnly = (
      port: PreferenceOutboxPort<Stored>,
    ): ReturnType<PreferenceOutboxPort<Stored>['update']> =>
      port.update(() => null, undefined, {
        route: 'caller',
        isClientOnly: () => true,
      });
    const daemon = startDaemon();
    await foreignWrite(daemon, { language: 'fr' });
    const harness = openPort(daemon);
    const { port, connection } = harness;

    // Nothing queued or read: the client answers on the defaults, unread,
    // with no daemon call, and the outbox returns that answer.
    connection.down = true;
    await expect(clientOnly(port)).resolves.toMatchObject({
      unread: true,
      next: { language: 'en' },
    });
    expect(connection.calls).toEqual([]);
    expect(port.pending()).toBe(0);
    // Once read, the client's answers are unmarked, and so are they here.
    connection.down = false;
    await port.read('persisted');
    const warm = await clientOnly(port);
    expect(warm.next.language).toBe('fr');
    expect(warm.unread).toBeUndefined();
    expect((await save(port, { fileAutoSave: true })).unread).toBeUndefined();

    // The outbox's own answers read the client's cache: unmarked.
    connection.down = true;
    const queued = await save(port, { language: 'de' });
    expect(queued.unread).toBeUndefined();
    const overQueue = await clientOnly(port);
    expect(overQueue.next.language).toBe('de');
    expect(overQueue.unread).toBeUndefined();
    port.dispose();

    // Or the disk projection, which read the document: unmarked.
    const restarted = openPort(daemon, { outboxRoot: harness.outboxRoot });
    restarted.connection.down = true;
    const projected = await clientOnly(restarted.port);
    expect(projected.next).toMatchObject({
      language: 'de',
      fileAutoSave: true,
    });
    expect(projected.unread).toBeUndefined();

    // A corrupt document with no last-good copy proves nothing: a save is
    // refused, as a latched repository refuses it, and its revocation kept.
    const corrupt = startDaemon();
    writeFileSync(join(corrupt.root, 'preferences.json'), '{"version":');
    const latched = openPort(corrupt);
    latched.connection.down = true;
    const recovery = { code: 'PREFERENCES_RECOVERY_REQUIRED' };
    await expect(
      save(latched.port, {
        language: 'fr',
        usageData: { productAnalytics: false },
      }),
    ).rejects.toMatchObject(recovery);
    expect(latched.deny).toHaveBeenCalledWith(['productAnalytics']);
    expect(latched.port.pending()).toBe(1);
    // Over that queue, the outbox answers a client-only save itself, on the
    // defaults standing in: unread.
    await expect(clientOnly(latched.port)).resolves.toMatchObject({
      unread: true,
      next: { language: 'en', usageData: { productAnalytics: false } },
    });
    // Any other save, an updater's own null included, is refused.
    await expect(save(latched.port, { language: 'de' })).rejects.toMatchObject(
      recovery,
    );
    await expect(
      latched.port.update(() => null, undefined, CALLER),
    ).rejects.toMatchObject(recovery);
    expect(latched.port.pending()).toBe(1);

    // Reached again but latched on the same file, the daemon proves nothing
    // either: as the client refuses every save there, client-only included,
    // so does the outbox over its queue, never answering the daemon's
    // stand-in as read. A revocation is still kept.
    latched.connection.down = false;
    await expect(clientOnly(latched.port)).rejects.toMatchObject(recovery);
    await expect(save(latched.port, { language: 'de' })).rejects.toMatchObject(
      recovery,
    );
    await expect(
      save(latched.port, { usageData: { errorReports: false } }),
    ).rejects.toMatchObject(recovery);
    expect(latched.deny).toHaveBeenLastCalledWith(['errorReports']);
    expect(latched.port.pending()).toBe(1);
    expect(JSON.parse(readFileSync(outboxPath(latched), 'utf8'))).toMatchObject(
      {
        revocations: ['productAnalytics', 'errorReports'],
        entries: [],
      },
    );
  });

  it("runs the client's pre-commit step before a save is kept, and proves no stored choice while usage data is queued (CAN-7991)", async () => {
    const daemon = startDaemon();
    const before: PreferencesChange<Stored>[] = [];
    let refuse = false;
    const harness = openPort(daemon, {
      hooks: {
        beforeSave: (change) => {
          before.push(change);
          return refuse
            ? Promise.reject(new Error('Refused before the save.'))
            : Promise.resolve();
        },
      },
    });
    const { port, connection } = harness;
    await port.read('persisted');
    await expect(port.readStoredProductAnalyticsChoice()).resolves.toBe(
      'allowed',
    );
    connection.down = true;

    await save(port, { usageData: { productAnalytics: false } });
    // Once per attempt, as the client runs it: before the client's send that
    // could not reach the daemon, then on the change the queue makes.
    expect(before).toHaveLength(2);
    for (const change of before)
      expect(change).toMatchObject({
        previous: { usageData: { productAnalytics: true } },
        next: { usageData: { productAnalytics: false } },
      });
    // Reached again, the daemon still reads the allow the queued revocation
    // replaces, so no stored choice is proven until it drains.
    connection.down = false;
    await expect(port.readStoredProductAnalyticsChoice()).resolves.toBe(
      'unconfirmed',
    );
    expect(port.pending()).toBeGreaterThan(0);
    connection.down = true;

    // A rejection keeps nothing.
    const kept = port.pending();
    refuse = true;
    await expect(save(port, { language: 'fr' })).rejects.toThrow(
      'Refused before the save.',
    );
    expect(port.pending()).toBe(kept);
    await expect(port.read('persisted')).resolves.toMatchObject({
      language: 'en',
    });

    refuse = false;
    before.length = 0;
    await harness.reconnect();
    expect(port.pending()).toBe(0);
    // The drain's sends run it too, through the client.
    expect(before.length).toBeGreaterThan(0);
    await expect(port.readStoredProductAnalyticsChoice()).resolves.toBe(
      'denied',
    );
  });
});

describe('the preference outbox over the stored record (CAN-8045)', () => {
  const recordOf = (value: object): Record<string, unknown> => ({ ...value });
  /** The desktop codec over the daemon module's opaque records. */
  const desktopRecords: PreferencesCodec<Record<string, unknown>> = {
    defaults: recordOf(DESKTOP_PREFERENCES_CODEC.defaults),
    normalize: (payload, view) =>
      recordOf(DESKTOP_PREFERENCES_CODEC.normalize(payload, view)),
    project: (value) =>
      recordOf(DESKTOP_PREFERENCES_CODEC.normalize(value, 'runtime')),
    inspect: (payload) => DESKTOP_PREFERENCES_CODEC.inspect(payload),
    merge: (existing, patch, mergeContext) => {
      // The patch's own keys, typed by the persisted view (which keeps them).
      const typed: Partial<DomainPreferencesData> = {
        ...DESKTOP_PREFERENCES_CODEC.normalize(
          { ...existing, ...patch },
          'persisted',
        ),
      };
      for (const key of Object.keys(typed))
        if (!(key in patch)) Reflect.deleteProperty(typed, key);
      return recordOf(
        DESKTOP_PREFERENCES_CODEC.merge(
          DESKTOP_PREFERENCES_CODEC.normalize(existing, 'persisted'),
          typed,
          mergeContext,
        ),
      );
    },
  };
  const QWEN = {
    id: 'ollama-qwen3-coder',
    rawModelId: 'qwen3-coder',
    label: 'qwen3-coder',
    show: { capabilities: ['completion', 'tools'] },
  };
  const OPUS = { model: 'opus[1m]', thinkingLevel: 'high' };
  const OLLAMA = { model: 'ollama-qwen3-coder', thinkingLevel: 'high' };
  const SAVED = {
    defaultChatProvider: 'ollama',
    defaultChatModelByProvider: {
      claude: { model: 'sonnet', thinkingLevel: 'high' },
      codex: { model: 'gpt-6.1-sol', thinkingLevel: 'high' },
      ollama: OLLAMA,
      aiCredits: null,
    },
  };
  beforeEach(() => {
    initClaudeModels([
      { id: 'opus[1m]', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
    ]);
    initCodexModels([{ id: 'gpt-6.1-sol', label: 'Codex default' }]);
    initOllamaModels([QWEN]);
    installPreferencesNormalizationEnvironment(
      createCatalogPreferencesModelFacts({
        status: (model) =>
          resolveKnownModel(model) ? 'available' : 'unavailable',
        ollamaEnabled: () => true,
        shortcutPlatform: () => 'darwin',
      }),
    );
  });
  afterEach(() => initOllamaModels([QWEN]));
  const byProviderOf = (value: Stored): Record<string, unknown> =>
    isObject(value.defaultChatModelByProvider)
      ? value.defaultChatModelByProvider
      : {};

  /** Persisted reads keep the queued save over the stored Ollama default; runtime reads project it. */
  async function expectViews(
    port: PreferenceOutboxPort<Stored>,
  ): Promise<void> {
    expect(byProviderOf(await port.read('persisted'))).toMatchObject({
      claude: OPUS,
      ollama: OLLAMA,
    });
    const runtime = await port.read('runtime');
    expect(runtime.defaultChatProvider).toBe('claude');
    expect(byProviderOf(runtime)).toMatchObject({ claude: OPUS, ollama: null });
    const authority = await port.readAuthority();
    expect(authority.authority).toBe('ok');
    expect(authority.preferences).toEqual(runtime);
  }

  it('queues a {...byProvider, claude} save over the stored record and projects runtime reads with the live catalog', async () => {
    const root = freshRoot();
    writeFileSync(
      join(root, 'preferences.json'),
      JSON.stringify({ version: 1, preferences: SAVED }),
    );
    const daemon = startDaemon(root, desktopRecords);
    const harness = openPort(daemon);
    const { port, connection } = harness;
    // Discovery is asynchronous, so a save can land before it.
    initOllamaModels([]);
    const settings = await port.read('persisted');
    connection.down = true;

    // As ChatTab saves one provider's default over Settings' persisted read.
    await save(port, {
      defaultChatModelByProvider: { ...byProviderOf(settings), claude: OPUS },
    });
    expect(port.pending()).toBe(1);
    // Over the client's cached record, then over the disk projection.
    await expectViews(port);
    const cold = openPort(daemon, { outboxRoot: harness.outboxRoot });
    cold.connection.down = true;
    await expectViews(cold.port);
    cold.port.dispose();

    await harness.reconnect();
    expect(port.pending()).toBe(0);
    const file: unknown = JSON.parse(
      readFileSync(join(root, 'preferences.json'), 'utf8'),
    );
    expect(file).toMatchObject({
      preferences: {
        defaultChatProvider: 'ollama',
        defaultChatModelByProvider: { claude: OPUS, ollama: OLLAMA },
      },
    });
    initOllamaModels([QWEN]);
    const discovered = await port.read('runtime');
    expect(discovered.defaultChatProvider).toBe('ollama');
    expect(byProviderOf(discovered).ollama).toEqual(OLLAMA);
    port.dispose();
  });
});
