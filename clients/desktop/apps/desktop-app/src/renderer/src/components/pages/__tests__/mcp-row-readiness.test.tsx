/** @jest-environment jsdom */
import '../../../cloud-chats/__tests__/jsdom-globals';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DetectedMcpServerInfo,
  ListDetectedMcpServersResponse,
  McpHttpAuthHandler,
  McpServerRef,
  McpServerIndexEntry,
  McpServerStatusEntry,
} from '@canopy/execution-engine/types/mcp-servers';
import {
  CustomizeDiscoveryProvider,
  CustomizeTabSections,
  type CustomizeMcpRowActions,
  type McpTestTarget,
} from '@canopy/ui-app/capability';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib';
import { ErrorBanner } from '@canopy/ui-shared/components';
import { setSurfacedErrorRecorder } from '@canopy/ui-shared/lib';
import { MCP_MANAGEMENT_REASONS } from '@canopy/ui-shared/lib/mcp-card-display';
import {
  MCP_ROW_CONNECT_NEEDS_CONFIG_REASON,
  mcpRowConnectEligibility,
  mcpRowConnectIsCurrent,
  mcpRowSelectionRefs,
  mcpRowTestEligibility,
  mcpServerRevisionKey,
  mcpServerRevisions,
  mcpDeviceServerRevision,
  mcpRevisionStillSaved,
  mcpRowTestRun,
  runMcpRowConnect,
  useMcpScopeGeneration,
  type McpRowConnectEligibility,
  type McpRowConnectReadiness,
  type McpRowReadiness,
  type McpRowTestEligibility,
  type McpStatusSnapshot,
} from '../mcpDeviceTestTarget';
import { useMcpRowReadiness } from '../useMcpRowReadiness';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { useDetectedMcpServers } from '@/hooks/useDetectedMcpServers';

jest.mock('@canopy/desktop-instrumentation/client', () => ({
  reportClientAppError: jest.fn(),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T1 = '2026-11-19T12:00:00.000Z';
const T2 = '2026-11-19T13:00:00.000Z';
const CONFIG_A = { id: 'a', name: 'A', enabled: true };
const CONFIG_B = { id: 'b', name: 'B', enabled: true };

type ConfigCount = 0 | 1 | 'many';
const CONFIG_COUNTS: readonly ConfigCount[] = [0, 1, 'many'];

function configsFor(count: ConfigCount): McpServerIndexEntry['configs'] {
  if (count === 0) return [];
  return count === 1 ? [CONFIG_A] : [CONFIG_A, CONFIG_B];
}

function server(over: Partial<McpServerIndexEntry> = {}): McpServerIndexEntry {
  return {
    id: 'tracker',
    name: 'Tracker',
    description: 'Tracks work',
    type: 'http',
    configs: [CONFIG_A],
    updatedAt: T1,
    ...over,
  };
}

const BASE_ENTRY: UnifiedPluginEntry = {
  id: 'local-mcp:tracker',
  kind: 'app',
  origin: 'installed-standalone',
  name: 'Tracker',
  description: 'Tracks work',
  categories: [],
  components: { skills: 0, mcpServers: 1, commands: 0, agents: 0 },
  providerSupport: { claude: true, codex: true },
  state: 'installed',
  recommended: false,
  placement: 'desktop',
  connection: { status: 'connected' },
  ref: { type: 'local-mcp', serverId: 'tracker' },
};

/** An integration card bound to the device server, optionally to one config. */
function integrationEntry(
  binding: 'device' | 'account',
  configId?: string,
): UnifiedPluginEntry {
  return {
    ...BASE_ENTRY,
    id: 'curated-mcp:tracker',
    origin: 'curated',
    ref: { type: 'curated-mcp', key: 'tracker' },
    integration: {
      curatedKey: 'tracker',
      connections: [
        {
          serverId: 'tracker',
          ...(configId === undefined ? {} : { configId }),
          name: 'Tracker',
          binding,
          state: 'installed',
        },
      ],
    },
  };
}

/** The row for a server with this many configurations, on the desktop. */
function desktopEntryFor(count: ConfigCount): UnifiedPluginEntry {
  if (count === 0) return integrationEntry('device');
  return count === 1 ? BASE_ENTRY : integrationEntry('device', 'a');
}

/** Rows that stand for no saved device server: cloud-only placements. */
const WEB_ENTRIES: readonly UnifiedPluginEntry[] = [
  { ...BASE_ENTRY, placement: 'account' },
  integrationEntry('account'),
];

function status(
  handler: McpHttpAuthHandler | undefined,
  over: Partial<McpServerStatusEntry> = {},
): McpServerStatusEntry {
  return {
    serverId: 'tracker',
    transport: 'http',
    connectionStatus: 'connected',
    reachability: 'reachable',
    ...(handler === undefined ? {} : { handler, handlerSource: 'default' }),
    configs: [],
    ...over,
  };
}

function snapshotOf(
  servers: readonly McpServerIndexEntry[],
  entries: McpServerStatusEntry[],
  scope: number,
): McpStatusSnapshot {
  return { scope, entries, revisions: mcpServerRevisions(servers) };
}

/** One sign-in read entry; `tag` says which read it came from. */
function detected(
  serverId: string,
  configId: string,
  tag = 'v1',
): DetectedMcpServerInfo {
  return {
    key: `standalone:${serverId}:${configId}`,
    source: 'standalone',
    serverName: serverId,
    displayName: tag,
    type: 'http',
    serverId,
    configId,
    enabled: true,
    authStatus: 'not_connected',
    authStatusLabel: 'Not connected',
    canConnect: true,
  };
}

/** What a sign-in read returns for these refs: an entry for each. */
function inventoryOfRefs(
  refs: readonly McpServerRef[],
  tag = 'v1',
): DetectedMcpServerInfo[] {
  return refs.map((ref) => detected(ref.serverId, ref.configId, tag));
}

/** What the sign-in read the page starts for these servers returns. */
function inventoryFor(
  servers: readonly McpServerIndexEntry[],
  tag = 'v1',
): DetectedMcpServerInfo[] {
  return inventoryOfRefs(mcpRowSelectionRefs(servers), tag);
}

/** Every input of Connect, read under the current scope and revision. */
function connectReadiness(
  servers: readonly McpServerIndexEntry[],
  over: Partial<McpRowConnectReadiness> = {},
): McpRowConnectReadiness {
  return {
    servers,
    authDefault: 'canopy',
    scopeGeneration: GENERATION,
    statusSnapshot: snapshotOf(servers, [status('canopy')], GENERATION),
    inventoryAppliedScope: GENERATION,
    inventoryAppliedRevisions: mcpServerRevisions(servers),
    inventoryServers: inventoryFor(servers),
    inventoryPending: false,
    ...over,
  };
}

const OK = 'available';
type Expected = string;

function testOutcome(gate: McpRowTestEligibility): Expected {
  return gate.available ? OK : gate.reason;
}
function connectOutcome(gate: McpRowConnectEligibility): Expected {
  return gate.available ? OK : gate.reason;
}

const NO_CONFIG = MCP_MANAGEMENT_REASONS.noConfig;
const PROVIDER = MCP_MANAGEMENT_REASONS.provider;
const LOADING = MCP_MANAGEMENT_REASONS.loadingSettings;

/**
 * The truth table for Test once the route is known: Provider is managed by the
 * agent provider, Account with no saved configuration is refused by main, and
 * everything else probes. Written out, never derived from the source.
 */
const TEST_BY_HANDLER_AND_CONFIGS: Record<
  McpHttpAuthHandler,
  Record<`${ConfigCount}`, Expected>
> = {
  canopy: { '0': OK, '1': OK, many: OK },
  provider: { '0': PROVIDER, '1': PROVIDER, many: PROVIDER },
  account: { '0': NO_CONFIG, '1': OK, many: OK },
};

const HANDLERS: readonly McpHttpAuthHandler[] = [
  'canopy',
  'provider',
  'account',
];
const GENERATION = 3;

// ---------------------------------------------------------------------------
// Test eligibility
// ---------------------------------------------------------------------------

describe('MCP row Test eligibility (CAN-7363)', () => {
  describe('a server whose handler the index records', () => {
    // Own handler, or an account-scoped server (always Account).
    const RECORDED: readonly {
      readonly label: string;
      readonly over: Partial<McpServerIndexEntry>;
      readonly handler: McpHttpAuthHandler;
    }[] = [
      {
        label: 'own Canopy',
        over: { authHandler: 'canopy' },
        handler: 'canopy',
      },
      {
        label: 'own Provider',
        over: { authHandler: 'provider' },
        handler: 'provider',
      },
      {
        label: 'own Account',
        over: { authHandler: 'account' },
        handler: 'account',
      },
      {
        label: 'account-scoped',
        over: { scope: 'account' },
        handler: 'account',
      },
    ];

    it.each(
      RECORDED.flatMap((recorded) =>
        CONFIG_COUNTS.map((count) => ({ ...recorded, count })),
      ),
    )(
      '$label with $count configs decides without a status or default',
      ({ over, handler, count }) => {
        const servers = [server({ ...over, configs: configsFor(count) })];
        // Whatever the read state: not read, wrong scope, stale, or default unread.
        const readStates: {
          authDefault: McpHttpAuthHandler | null;
          statusSnapshot: McpStatusSnapshot | null;
        }[] = [
          { authDefault: 'canopy', statusSnapshot: null },
          { authDefault: null, statusSnapshot: null },
          {
            authDefault: 'canopy',
            // A status that disagrees must not override the recorded handler.
            statusSnapshot: snapshotOf(servers, [status('canopy')], 1),
          },
        ];
        for (const readState of readStates) {
          const gate = mcpRowTestEligibility(desktopEntryFor(count), {
            servers,
            scopeGeneration: GENERATION,
            ...readState,
          });
          expect(testOutcome(gate)).toBe(
            TEST_BY_HANDLER_AND_CONFIGS[handler][`${count}`],
          );
        }
      },
    );
  });

  describe('an HTTP server whose own handler the index does not record', () => {
    const INHERITED = [{ scope: 'device' as const }, {}];

    it.each(
      INHERITED.flatMap((over) =>
        HANDLERS.flatMap((handler) =>
          CONFIG_COUNTS.map((count) => ({ over, handler, count })),
        ),
      ),
    )(
      'a status matching the server ($handler, $count configs) decides it',
      ({ over, handler, count }) => {
        const servers = [server({ ...over, configs: configsFor(count) })];
        const gate = mcpRowTestEligibility(desktopEntryFor(count), {
          servers,
          authDefault: 'canopy',
          scopeGeneration: GENERATION,
          statusSnapshot: snapshotOf(servers, [status(handler)], GENERATION),
        });
        expect(testOutcome(gate)).toBe(
          TEST_BY_HANDLER_AND_CONFIGS[handler][`${count}`],
        );
      },
    );

    it('keeps the matched status of this server only, among several', () => {
      const servers = [
        server({ id: 'other', name: 'Other' }),
        server({ configs: [CONFIG_A] }),
      ];
      const gate = mcpRowTestEligibility(BASE_ENTRY, {
        servers,
        authDefault: 'canopy',
        scopeGeneration: GENERATION,
        statusSnapshot: snapshotOf(
          servers,
          [status('provider', { serverId: 'other' }), status('canopy')],
          GENERATION,
        ),
      });
      expect(gate.available).toBe(true);
    });

    describe.each(CONFIG_COUNTS)(
      'with %s configs, Test stays unavailable',
      (count) => {
        const servers = [server({ configs: configsFor(count) })];
        const entry = desktopEntryFor(count);
        const matched = [status('canopy')];

        const holds: readonly {
          readonly label: string;
          readonly authDefault: McpHttpAuthHandler | null;
          readonly snapshot: McpStatusSnapshot | null;
        }[] = [
          {
            label: 'before any status read lands (pending)',
            authDefault: 'canopy',
            snapshot: null,
          },
          {
            label: 'when the status list is empty',
            authDefault: 'canopy',
            snapshot: snapshotOf(servers, [], GENERATION),
          },
          {
            label: 'when the list lacks this server (known-unmatched)',
            authDefault: 'canopy',
            snapshot: snapshotOf(
              servers,
              [status('canopy', { serverId: 'other' })],
              GENERATION,
            ),
          },
          {
            label: 'when its status records no handler',
            authDefault: 'canopy',
            snapshot: snapshotOf(servers, [status(undefined)], GENERATION),
          },
          {
            label: 'when its status is a command transport',
            authDefault: 'canopy',
            snapshot: snapshotOf(
              servers,
              [status(undefined, { transport: 'command' })],
              GENERATION,
            ),
          },
          {
            label: 'when the status was read for an older saved revision',
            authDefault: 'canopy',
            snapshot: snapshotOf(
              [server({ updatedAt: T2, configs: configsFor(count) })],
              matched,
              GENERATION,
            ),
          },
          {
            label: 'when the status was read under another scope generation',
            authDefault: 'canopy',
            snapshot: snapshotOf(servers, matched, GENERATION - 1),
          },
          {
            label: 'when the auth default is not read (null)',
            authDefault: null,
            snapshot: snapshotOf(servers, matched, GENERATION),
          },
        ];

        it.each(holds)('$label', ({ authDefault, snapshot }) => {
          const gate = mcpRowTestEligibility(entry, {
            servers,
            authDefault,
            scopeGeneration: GENERATION,
            statusSnapshot: snapshot,
          });
          expect(gate).toEqual({ available: false, reason: LOADING });
        });
      },
    );

    it('matches by the saved revision of the device copy, not the row above it', () => {
      // The row above holds another configuration, so only the copy resolves.
      const copy = server({ updatedAt: T2 });
      const parent = server({
        configs: [CONFIG_B],
        updatedAt: T1,
        deviceCopies: [copy],
      });
      const servers = [parent];
      const entry = integrationEntry('device', 'a');
      const readAt = (read: McpServerIndexEntry): McpRowTestEligibility =>
        mcpRowTestEligibility(entry, {
          servers,
          authDefault: 'canopy',
          scopeGeneration: GENERATION,
          statusSnapshot: {
            scope: GENERATION,
            entries: [status('canopy')],
            revisions: new Set([mcpServerRevisionKey(read)]),
          },
        });
      // A read of the row above does not describe the copy.
      expect(readAt(parent)).toEqual({ available: false, reason: LOADING });
      expect(readAt(copy).available).toBe(true);
    });
  });

  describe('a command server', () => {
    it.each(CONFIG_COUNTS.filter((count) => count !== 0))(
      'is offered with %s configs whatever the status read is',
      (count) => {
        const servers = [
          server({ type: 'command', configs: configsFor(count) }),
        ];
        for (const statusSnapshot of [null, snapshotOf(servers, [], 1)]) {
          const gate = mcpRowTestEligibility(desktopEntryFor(count), {
            servers,
            authDefault: null,
            scopeGeneration: GENERATION,
            statusSnapshot,
          });
          expect(gate.available).toBe(true);
        }
      },
    );
  });

  describe('platform', () => {
    it.each(WEB_ENTRIES.map((entry) => [entry.id, entry] as const))(
      'a cloud-only row (%s) has no device test',
      (_id, entry) => {
        const servers = [server()];
        const gate = mcpRowTestEligibility(entry, {
          servers,
          authDefault: 'canopy',
          scopeGeneration: GENERATION,
          statusSnapshot: snapshotOf(servers, [status('canopy')], GENERATION),
        });
        expect(gate).toEqual({
          available: false,
          reason: MCP_MANAGEMENT_REASONS.cloudTest,
        });
      },
    );

    it('an entry with several targets opens its detail instead', () => {
      const gate = mcpRowTestEligibility(
        { ...BASE_ENTRY, mcpTargetCount: 2 },
        {
          servers: [server()],
          authDefault: null,
          scopeGeneration: 0,
          statusSnapshot: null,
        },
      );
      expect(gate).toEqual({ available: true, target: undefined });
    });

    it('a provider-managed or disabled row keeps its own reason', () => {
      const readiness = {
        servers: [server({ authHandler: 'canopy' as const })],
        authDefault: 'canopy' as const,
        scopeGeneration: GENERATION,
        statusSnapshot: null,
      };
      expect(
        mcpRowTestEligibility(
          {
            ...BASE_ENTRY,
            connection: { status: 'connected', provider: true },
          },
          readiness,
        ),
      ).toEqual({ available: false, reason: PROVIDER });
      const disabled = mcpRowTestEligibility(
        { ...BASE_ENTRY, connection: { status: 'connected', disabled: true } },
        readiness,
      );
      expect(disabled.available).toBe(false);
    });
  });

  it('never reports a probe it could not name a target for', () => {
    const servers = [server({ authHandler: 'canopy' })];
    const gate = mcpRowTestEligibility(BASE_ENTRY, {
      servers,
      authDefault: 'canopy',
      scopeGeneration: GENERATION,
      statusSnapshot: null,
    });
    expect(gate.available && gate.target?.serverId).toBe('tracker');
    expect(gate.available && gate.target?.configId).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// Connect eligibility
// ---------------------------------------------------------------------------

describe('MCP row Connect and Reconnect eligibility (CAN-7363)', () => {
  const HTTP_UNRECORDED_COUNTS: readonly ConfigCount[] = [1, 'many'];

  it('a server with no configuration has nothing to sign in to', () => {
    for (const over of [{}, { authHandler: 'account' as const }]) {
      const servers = [server({ ...over, configs: [] })];
      const gate = mcpRowConnectEligibility(
        desktopEntryFor(0),
        connectReadiness(servers),
      );
      expect(gate).toEqual({
        available: false,
        reason: MCP_ROW_CONNECT_NEEDS_CONFIG_REASON,
      });
    }
  });

  it.each(WEB_ENTRIES.map((entry) => [entry.id, entry] as const))(
    'a cloud-only row (%s) has no device Connect; the page keeps its own path',
    (_id, entry) => {
      const servers = [server()];
      expect(
        mcpRowConnectEligibility(
          entry,
          connectReadiness(servers, {
            authDefault: null,
            scopeGeneration: 0,
            statusSnapshot: null,
            inventoryAppliedScope: null,
            inventoryAppliedRevisions: null,
            inventoryServers: [],
          }),
        ),
      ).toEqual({ available: true, target: null });
    },
  );

  describe('a recorded handler or a command server', () => {
    const NOT_SCOPE_DEPENDENT: readonly {
      readonly label: string;
      readonly over: Partial<McpServerIndexEntry>;
    }[] = [
      { label: 'own Canopy', over: { authHandler: 'canopy' } },
      { label: 'own Provider', over: { authHandler: 'provider' } },
      { label: 'own Account', over: { authHandler: 'account' } },
      { label: 'account-scoped', over: { scope: 'account' } },
      { label: 'command', over: { type: 'command' } },
    ];

    it.each(
      NOT_SCOPE_DEPENDENT.flatMap((recorded) =>
        HTTP_UNRECORDED_COUNTS.map((count) => ({ ...recorded, count })),
      ),
    )(
      '$label with $count configs waits only for a sign-in read that applied',
      ({ over, count }) => {
        const servers = [server({ ...over, configs: configsFor(count) })];
        const base: Partial<McpRowConnectReadiness> = {
          authDefault: null,
          statusSnapshot: null,
        };
        expect(
          mcpRowConnectEligibility(
            desktopEntryFor(count),
            connectReadiness(servers, {
              ...base,
              inventoryAppliedScope: null,
              inventoryAppliedRevisions: null,
            }),
          ),
        ).toEqual({ available: false, reason: LOADING });
        // The route does not depend on the default, so an older scope is fine.
        for (const applied of [GENERATION, 0]) {
          const gate = mcpRowConnectEligibility(
            desktopEntryFor(count),
            connectReadiness(servers, {
              ...base,
              inventoryAppliedScope: applied,
            }),
          );
          expect(connectOutcome(gate)).toBe(OK);
        }
      },
    );

    it.each(
      NOT_SCOPE_DEPENDENT.map(
        (recorded) => [recorded.label, recorded] as const,
      ),
    )(
      '%s: a read of an older saved revision, or without this target, holds it',
      (_label, { over }) => {
        const servers = [server({ ...over })];
        const older = mcpServerRevisions([server({ ...over, updatedAt: T2 })]);
        expect(
          mcpRowConnectEligibility(
            BASE_ENTRY,
            connectReadiness(servers, { inventoryAppliedRevisions: older }),
          ),
        ).toEqual({ available: false, reason: LOADING });
        expect(
          mcpRowConnectEligibility(
            BASE_ENTRY,
            connectReadiness(servers, { inventoryServers: [] }),
          ),
        ).toEqual({ available: false, reason: LOADING });
      },
    );
  });

  describe('an HTTP server whose own handler the index does not record', () => {
    it.each(
      HANDLERS.flatMap((handler) =>
        HTTP_UNRECORDED_COUNTS.map((count) => ({ handler, count })),
      ),
    )(
      'is offered once a status matches it and the sign-in read applied ($handler, $count configs)',
      ({ handler, count }) => {
        const servers = [server({ configs: configsFor(count) })];
        const gate = mcpRowConnectEligibility(
          desktopEntryFor(count),
          connectReadiness(servers, {
            statusSnapshot: snapshotOf(servers, [status(handler)], GENERATION),
          }),
        );
        expect(gate.available && gate.target?.serverId).toBe('tracker');
      },
    );

    describe.each(HTTP_UNRECORDED_COUNTS)(
      'with %s configs, Connect stays unavailable',
      (count) => {
        const servers = [server({ configs: configsFor(count) })];
        const entry = desktopEntryFor(count);
        const matched = [status('canopy')];

        it('baseline: all read under the current scope and revision', () => {
          expect(
            connectOutcome(
              mcpRowConnectEligibility(entry, connectReadiness(servers)),
            ),
          ).toBe(OK);
        });

        const olderServers = [
          server({ updatedAt: T2, configs: configsFor(count) }),
        ];
        const holds: readonly [string, Partial<McpRowConnectReadiness>][] = [
          ['the status read is pending or failed', { statusSnapshot: null }],
          [
            'the status list lacks the server',
            { statusSnapshot: snapshotOf(servers, [], GENERATION) },
          ],
          [
            'the status was read for an older saved revision',
            { statusSnapshot: snapshotOf(olderServers, matched, GENERATION) },
          ],
          [
            'the status was read under another scope generation',
            { statusSnapshot: snapshotOf(servers, matched, GENERATION - 1) },
          ],
          ['the auth default is unread', { authDefault: null }],
          [
            'the sign-in read is pending or failed',
            { inventoryAppliedScope: null, inventoryAppliedRevisions: null },
          ],
          [
            'the sign-in read applied under another scope generation',
            { inventoryAppliedScope: GENERATION - 1 },
          ],
          [
            'the sign-in read started at an older saved revision',
            { inventoryAppliedRevisions: mcpServerRevisions(olderServers) },
          ],
          [
            'the sign-in read applied without this target (a warning, no entry)',
            { inventoryServers: [] },
          ],
          [
            'the sign-in read holds another configuration only',
            { inventoryServers: [detected('tracker', 'other')] },
          ],
        ];
        it.each(holds)('when %s', (_label, over) => {
          expect(
            mcpRowConnectEligibility(entry, connectReadiness(servers, over)),
          ).toEqual({ available: false, reason: LOADING });
        });
      },
    );
  });

  it('a read that has started and not landed holds Connect, even when the applied one matches every key', () => {
    const servers = [server({ authHandler: 'canopy' })];
    expect(
      connectOutcome(
        mcpRowConnectEligibility(BASE_ENTRY, connectReadiness(servers)),
      ),
    ).toBe(OK);
    expect(
      connectOutcome(
        mcpRowConnectEligibility(
          BASE_ENTRY,
          connectReadiness(servers, { inventoryPending: true }),
        ),
      ),
    ).toBe(LOADING);
  });

  it('runs on the read entry of this very configuration, among several', () => {
    const servers = [server({ configs: configsFor('many') })];
    const wanted = detected('tracker', 'a', 'wanted');
    const gate = mcpRowConnectEligibility(
      desktopEntryFor('many'),
      connectReadiness(servers, {
        inventoryServers: [
          detected('tracker', 'b', 'other config'),
          detected('other', 'a', 'other server'),
          wanted,
        ],
      }),
    );
    expect(gate.available && gate.target !== null && gate.detected).toBe(
      wanted,
    );
  });

  describe('the sign-in selections and the target resolution walk the same rows', () => {
    const COPY = server({
      configs: [{ id: 'c', name: 'C', enabled: true }],
      updatedAt: T2,
    });
    // Shapes where the saved device server is not a top-level configuration.
    const SHAPES: readonly {
      readonly label: string;
      readonly servers: readonly McpServerIndexEntry[];
      readonly entry: UnifiedPluginEntry;
    }[] = [
      {
        label: 'a top-level server with one configuration',
        servers: [server()],
        entry: BASE_ENTRY,
      },
      {
        label: 'one of several configurations',
        servers: [server({ configs: configsFor('many') })],
        entry: integrationEntry('device', 'b'),
      },
      {
        label: 'a device copy with a configuration its row lacks',
        servers: [server({ configs: [CONFIG_B], deviceCopies: [COPY] })],
        entry: integrationEntry('device', 'c'),
      },
      {
        label: 'a device copy under an account row',
        servers: [
          server({
            scope: 'account',
            configs: [CONFIG_A],
            updatedAt: '',
            deviceCopies: [COPY],
          }),
        ],
        entry: integrationEntry('device', 'c'),
      },
    ];

    it.each(SHAPES.map((shape) => [shape.label, shape] as const))(
      '%s: the target it resolves is one the read is asked for',
      (_label, { servers, entry }) => {
        const gate = mcpRowConnectEligibility(entry, connectReadiness(servers));
        expect(gate.available).toBe(true);
        expect(gate.available && gate.target?.configId).toBe(
          entry.integration?.connections[0]?.configId ?? 'a',
        );
        expect(
          mcpRowSelectionRefs(servers).some(
            (ref) =>
              gate.available &&
              ref.serverId === gate.target?.serverId &&
              ref.configId === gate.target.configId,
          ),
        ).toBe(true);
      },
    );

    it('asks once for a configuration listed on a row and its copy', () => {
      const servers = [server({ deviceCopies: [server({ updatedAt: T2 })] })];
      expect(mcpRowSelectionRefs(servers)).toEqual([
        { serverId: 'tracker', configId: 'a' },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// The page wiring: the hook the page composes, and the click it runs
// ---------------------------------------------------------------------------

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Mounts a hook under React and exposes its latest return value. */
interface MountedHook<P, R> {
  readonly current: R;
  rerender(props: P): void;
  unmount(): void;
}

function mountHook<P, R>(
  useHook: (props: P) => R,
  initial: P,
): MountedHook<P, R> {
  let latest: { readonly value: R } | null = null;
  function Harness({ props }: { readonly props: P }): null {
    latest = { value: useHook(props) };
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(<Harness props={initial} />));
  return {
    get current(): R {
      if (latest === null) throw new Error('The hook did not render.');
      return latest.value;
    },
    rerender(props: P): void {
      act(() => root.render(<Harness props={props} />));
    },
    unmount(): void {
      act(() => root.unmount());
    },
  };
}

describe('the saved revision an attempt ran under (CAN-7363)', () => {
  it('stands while that revision is saved, whatever else is saved', () => {
    const attempted = 'a\u0000t1';
    expect(mcpRevisionStillSaved(attempted, new Set(['a\u0000t1']))).toBe(true);
    expect(
      mcpRevisionStillSaved(attempted, new Set(['a\u0000t1', 'b\u0000t9'])),
    ).toBe(true);
    // Another server saved alone, or the attempted one saved again.
    expect(mcpRevisionStillSaved(attempted, new Set(['b\u0000t9']))).toBe(
      false,
    );
    expect(mcpRevisionStillSaved(attempted, new Set(['a\u0000t2']))).toBe(
      false,
    );
    expect(mcpRevisionStillSaved(attempted, new Set())).toBe(false);
  });

  it('never stands for a server that was not saved', () => {
    expect(mcpRevisionStillSaved(null, new Set())).toBe(false);
    expect(mcpRevisionStillSaved(null, new Set(['a\u0000t1']))).toBe(false);
  });

  it('is the one key the saved device server lists and Connect compares', () => {
    const servers = [server(), server({ id: 'other', updatedAt: T2 })];
    expect(mcpDeviceServerRevision(servers, 'tracker', 'a')).toBe(
      mcpServerRevisionKey(server()),
    );
    expect(mcpDeviceServerRevision(servers, 'other', 'a')).toBe(
      mcpServerRevisionKey(server({ id: 'other', updatedAt: T2 })),
    );
    expect(mcpDeviceServerRevision(servers, 'gone', 'a')).toBeNull();
    expect(mcpDeviceServerRevision(servers, undefined, 'a')).toBeNull();
    expect(mcpDeviceServerRevision(servers, 'tracker', 'zzz')).toBeNull();
  });
});

describe('the scope generation (CAN-7363)', () => {
  it('moves on every change of the default and never returns to an earlier value', () => {
    const hook = mountHook<McpHttpAuthHandler | null, number>(
      useMcpScopeGeneration,
      null,
    );
    const seen: number[] = [hook.current];
    for (const next of ['canopy', 'canopy', 'provider', 'canopy'] as const) {
      hook.rerender(next);
      seen.push(hook.current);
    }
    // null, Canopy, Canopy (no change), Provider, Canopy again: A, B, A.
    expect(seen).toEqual([0, 1, 1, 2, 3]);
    hook.unmount();
  });
});

describe('the page wiring (CAN-7363)', () => {
  interface PageProps {
    readonly servers: readonly McpServerIndexEntry[];
    readonly authDefault: McpHttpAuthHandler | null;
    readonly entry: UnifiedPluginEntry;
  }

  interface InventoryRead {
    readonly refs: readonly McpServerRef[];
    readonly result: Deferred<ListDetectedMcpServersResponse>;
  }

  const statusReads: Deferred<McpServerStatusEntry[]>[] = [];
  const inventoryReads: InventoryRead[] = [];
  // The page subscribes for the statuses and the hook for the sign-in read:
  // every listener hears an event.
  const authListeners = new Set<() => void>();
  // What the sign-in start answers: refused unless a case says otherwise.
  let startOAuthLogin: () => Promise<never>;

  beforeEach(() => {
    statusReads.length = 0;
    inventoryReads.length = 0;
    authListeners.clear();
    startOAuthLogin = (): Promise<never> =>
      Promise.reject(new Error('Sign-in refused.'));
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        listDetected: (request: {
          selections: { mcpServerRefs?: McpServerRef[] };
        }): Promise<ListDetectedMcpServersResponse> => {
          const result = deferred<ListDetectedMcpServersResponse>();
          inventoryReads.push({
            refs: request.selections.mcpServerRefs ?? [],
            result,
          });
          return result.promise;
        },
        onAuthChanged: (listener: () => void): (() => void) => {
          authListeners.add(listener);
          return () => {
            authListeners.delete(listener);
          };
        },
        cancelOAuthLogin: (): Promise<void> => Promise.resolve(),
        startOAuthLogin: (): Promise<never> => startOAuthLogin(),
      },
    });
  });

  function listStatus(): Promise<McpServerStatusEntry[]> {
    const read = deferred<McpServerStatusEntry[]>();
    statusReads.push(read);
    return read.promise;
  }

  /** What PluginsPage composes: its hook, its banner state, its decisions. */
  interface PageState extends ReturnType<typeof useMcpRowReadiness> {
    /** What the page shows: its own entry first, then the read's failure. */
    readonly banner: string;
    /** The page's own entry alone: probes, attempts, account sign-ins. */
    readonly ownBanner: string;
    setBanner(message: string): void;
    readonly test: McpRowTestEligibility;
    readonly connect: McpRowConnectEligibility;
  }

  function usePage({ servers, authDefault, entry }: PageProps): PageState {
    const [banner, setBanner] = useState('');
    const state = useMcpRowReadiness({
      servers,
      authDefault,
      listStatus,
      setBannerError: setBanner,
    });
    return {
      ...state,
      banner: banner || state.readError || '',
      ownBanner: banner,
      setBanner,
      test: mcpRowTestEligibility(entry, state.readiness),
      connect: mcpRowConnectEligibility(entry, state.connectReadiness),
    };
  }

  const SERVERS: readonly McpServerIndexEntry[] = [server()];
  const props = (
    authDefault: McpHttpAuthHandler | null,
    servers: readonly McpServerIndexEntry[] = SERVERS,
    entry: UnifiedPluginEntry = BASE_ENTRY,
  ): PageProps => ({ servers, authDefault, entry });
  const EDITED: readonly McpServerIndexEntry[] = [server({ updatedAt: T2 })];

  async function settle(run: () => void): Promise<void> {
    await act(async () => {
      run();
      await Promise.resolve();
    });
  }

  function latestStatus(): Deferred<McpServerStatusEntry[]> {
    const read = statusReads[statusReads.length - 1];
    if (read === undefined) throw new Error('No status read started.');
    return read;
  }
  function latestInventory(): InventoryRead {
    const read = inventoryReads[inventoryReads.length - 1];
    if (read === undefined) throw new Error('No sign-in read started.');
    return read;
  }
  /** Answers one read with an entry for each ref it asked for. */
  function answer(read: InventoryRead, tag = 'v1'): void {
    read.result.resolve({
      servers: inventoryOfRefs(read.refs, tag),
      warnings: [],
    });
  }
  /** Every read still waiting, oldest first. */
  function answerAll(tag = 'v1'): void {
    for (const read of inventoryReads) answer(read, tag);
  }
  function emitAuthChanged(): void {
    for (const listener of [...authListeners]) listener();
  }

  /** Lands the first status and sign-in reads. */
  async function landFirstReads(
    page: MountedHook<PageProps, PageState>,
  ): Promise<void> {
    await settle(() => {
      latestStatus().resolve([status('canopy')]);
      answerAll();
    });
    expect(page.current.connect.available).toBe(true);
  }

  /** The Connect click, on what the decision at this render offers. */
  async function click(page: MountedHook<PageProps, PageState>): Promise<{
    readonly connect: jest.Mock<
      Promise<boolean>,
      [DetectedMcpServerInfo, { readonly signInRequired: boolean }]
    >;
    readonly runTest: jest.Mock<Promise<void>, [McpTestTarget]>;
    readonly outcome: 'cancelled' | undefined;
  }> {
    const gate = page.current.connect;
    if (!gate.available || gate.target === null)
      throw new Error('Connect is not offered for a device target.');
    const { target, detected: signIn } = gate;
    const connect = jest.fn<
      Promise<boolean>,
      [DetectedMcpServerInfo, { readonly signInRequired: boolean }]
    >(() => Promise.resolve(true));
    const runTest = jest.fn<Promise<void>, [McpTestTarget]>(() =>
      Promise.resolve(),
    );
    let outcome: 'cancelled' | undefined;
    await act(async () => {
      outcome = await runMcpRowConnect({
        entry: BASE_ENTRY,
        target,
        detected: signIn,
        connect,
        runTest,
        refreshStatuses: () => Promise.resolve(),
        clearError: () => undefined,
        onProbeStarted: () => undefined,
        isCurrent: mcpRowConnectIsCurrent(
          page.current.readiness,
          page.current.latestReadiness,
          target,
        ),
      });
    });
    return { connect, runTest, outcome };
  }

  it('holds Test and Connect until a status and a sign-in read land, then offers both', async () => {
    const page = mountHook(usePage, props('canopy'));
    expect(page.current.test).toEqual({ available: false, reason: LOADING });
    expect(page.current.connect).toEqual({ available: false, reason: LOADING });
    await landFirstReads(page);
    expect(page.current.test.available).toBe(true);
    page.unmount();
  });

  it('the click signs in on the entry the sign-in read returned, then probes the target', async () => {
    const page = mountHook(usePage, props('canopy'));
    await landFirstReads(page);
    const { connect, runTest, outcome } = await click(page);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(
      page.current.rowMcp.servers[0],
      expect.objectContaining({ signInRequired: false }),
    );
    expect(runTest).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'tracker', configId: 'a' }),
    );
    expect(outcome).toBeUndefined();
    page.unmount();
  });

  it('a failed first status read leaves Test unavailable, never enabled', async () => {
    const page = mountHook(usePage, props('canopy'));
    await settle(() => statusReads[0]?.reject(new Error('IPC down')));
    expect(page.current.test).toEqual({ available: false, reason: LOADING });
    // A later successful read lifts the hold.
    await settle(() => {
      void page.current.refreshStatuses();
    });
    await settle(() => latestStatus().resolve([status('canopy')]));
    expect(page.current.test.available).toBe(true);
    page.unmount();
  });

  it('an auth-default change re-holds Test until a status for the new default lands', async () => {
    const page = mountHook(usePage, props('canopy'));
    await settle(() => statusReads[0]?.resolve([status('canopy')]));
    expect(page.current.test.available).toBe(true);
    page.rerender(props('provider'));
    // The old Canopy status is not exposed under the new default.
    expect(page.current.test).toEqual({ available: false, reason: LOADING });
    expect(page.current.statuses).toEqual([]);
    await settle(() => latestStatus().resolve([status('provider')]));
    expect(page.current.test).toEqual({ available: false, reason: PROVIDER });
    page.unmount();
  });

  it('A, B, A: a snapshot read under the first A is not current again', async () => {
    const page = mountHook(usePage, props('canopy'));
    await settle(() => statusReads[0]?.resolve([status('canopy')]));
    expect(page.current.test.available).toBe(true);
    page.rerender(props('provider'));
    // B's read never lands; the default goes back to A.
    page.rerender(props('canopy'));
    expect(page.current.statuses).toEqual([]);
    expect(page.current.test).toEqual({ available: false, reason: LOADING });
    // A failing re-read keeps it held.
    await settle(() => latestStatus().reject(new Error('IPC down')));
    expect(page.current.test).toEqual({ available: false, reason: LOADING });
    page.unmount();
  });

  it('a saved server whose handler changed on the same default is held until re-read', async () => {
    const page = mountHook(usePage, props('canopy'));
    await settle(() => statusReads[0]?.resolve([status('canopy')]));
    expect(page.current.test.available).toBe(true);
    // Edited to a Provider handler: the same default, a new revision.
    page.rerender(props('canopy', EDITED));
    expect(page.current.test).toEqual({ available: false, reason: LOADING });
    await settle(() => latestStatus().resolve([status('provider')]));
    expect(page.current.test).toEqual({ available: false, reason: PROVIDER });
    page.unmount();
  });

  describe('two status reads in flight across a save', () => {
    it('the older revision landing first never matches the newer one', async () => {
      const page = mountHook(usePage, props('canopy'));
      page.rerender(props('canopy', EDITED));
      await settle(() => statusReads[0]?.resolve([status('canopy')]));
      expect(page.current.test).toEqual({ available: false, reason: LOADING });
      await settle(() => statusReads[1]?.resolve([status('canopy')]));
      expect(page.current.test.available).toBe(true);
      page.unmount();
    });

    it('the older revision landing last changes nothing', async () => {
      const page = mountHook(usePage, props('canopy'));
      page.rerender(props('canopy', EDITED));
      // The newer read lands first and decides; the older one arrives after.
      await settle(() => statusReads[1]?.resolve([status('provider')]));
      expect(page.current.test).toEqual({ available: false, reason: PROVIDER });
      await settle(() => statusReads[0]?.resolve([status('canopy')]));
      expect(page.current.test).toEqual({ available: false, reason: PROVIDER });
      page.unmount();
    });
  });

  describe('the sign-in read publishes the scope it applied under', () => {
    it('a superseded read does not publish its scope', async () => {
      const page = mountHook(usePage, props('canopy'));
      await landFirstReads(page);
      const first = page.current.rowMcp.appliedScope;
      expect(first).toBe(page.current.readiness.scopeGeneration);
      // The default moves twice while the read for the second scope is open.
      page.rerender(props('provider'));
      const superseded = latestInventory();
      page.rerender(props('canopy'));
      const newest = latestInventory();
      await settle(() => answer(superseded));
      // What was applied before stays; the superseded read names no scope.
      expect(page.current.rowMcp.appliedScope).toBe(first);
      expect(page.current.connect).toEqual({
        available: false,
        reason: LOADING,
      });
      await settle(() => answer(newest));
      expect(page.current.rowMcp.appliedScope).toBe(
        page.current.readiness.scopeGeneration,
      );
      page.unmount();
    });

    it('older responses landing after the newest one change nothing', async () => {
      const page = mountHook(usePage, props('canopy'));
      page.rerender(props('provider'));
      const newest = latestInventory();
      await settle(() => answer(newest, 'newest'));
      const applied = page.current.rowMcp.appliedScope;
      expect(applied).toBe(page.current.readiness.scopeGeneration);
      await settle(() => answerAll('older'));
      expect(page.current.rowMcp.appliedScope).toBe(applied);
      expect(page.current.rowMcp.servers.map((s) => s.displayName)).toEqual([
        'newest',
      ]);
      page.unmount();
    });

    it('a failed latest read leaves Connect unavailable, not enabled with no target', async () => {
      const page = mountHook(usePage, props('canopy'));
      await landFirstReads(page);
      // A later read for the same scope is rejected.
      await settle(() => {
        void page.current.rowMcp.refresh();
      });
      await settle(() =>
        latestInventory().result.reject(new Error('IPC down')),
      );
      expect(page.current.rowMcp.appliedScope).toBeNull();
      expect(page.current.connect).toEqual({
        available: false,
        reason: LOADING,
      });
      page.unmount();
    });

    it('a failed read for a new default does not leave the previous one standing', async () => {
      const page = mountHook(usePage, props('canopy'));
      await landFirstReads(page);
      page.rerender(props('provider'));
      await settle(() => {
        latestStatus().resolve([status('provider')]);
        latestInventory().result.reject(new Error('IPC down'));
      });
      expect(page.current.connect).toEqual({
        available: false,
        reason: LOADING,
      });
      page.unmount();
    });

    it('A, B, A: a read applied under the first A does not unlock the third scope', async () => {
      const page = mountHook(usePage, props('canopy'));
      await landFirstReads(page);
      const first = page.current.rowMcp.appliedScope;
      page.rerender(props('provider'));
      page.rerender(props('canopy'));
      // The status for the second A lands; its sign-in read is still in flight.
      await settle(() => latestStatus().resolve([status('canopy')]));
      expect(page.current.rowMcp.appliedScope).not.toBe(
        page.current.readiness.scopeGeneration,
      );
      expect(page.current.rowMcp.appliedScope).toBe(first);
      expect(page.current.connect).toEqual({
        available: false,
        reason: LOADING,
      });
      await settle(() => answer(latestInventory()));
      expect(page.current.rowMcp.appliedScope).toBe(
        page.current.readiness.scopeGeneration,
      );
      expect(page.current.connect.available).toBe(true);
      page.unmount();
    });
  });

  describe('a save that keeps every id (CAN-7363)', () => {
    it('re-reads the sign-in inventory, and holds Connect until that read applies', async () => {
      const page = mountHook(usePage, props('canopy'));
      await landFirstReads(page);
      const readsBefore = inventoryReads.length;
      const oldEntry = page.current.rowMcp.servers[0];

      page.rerender(props('canopy', EDITED));
      expect(inventoryReads.length).toBe(readsBefore + 1);
      // The old read still stands as data, but not as this revision's.
      expect(page.current.connect).toEqual({
        available: false,
        reason: LOADING,
      });

      // The fresh status lands first and asks for a sign-in.
      await settle(() => latestStatus().resolve([status('canopy')]));
      expect(page.current.connect).toEqual({
        available: false,
        reason: LOADING,
      });

      await settle(() => answer(latestInventory(), 'v2'));
      expect(page.current.connect.available).toBe(true);
      // The click signs in on the entry of the read that followed the save.
      const { connect } = await click(page);
      const signedInOn = connect.mock.calls[0]?.[0];
      expect(signedInOn).toBe(page.current.rowMcp.servers[0]);
      expect(signedInOn).not.toBe(oldEntry);
      expect(signedInOn).toEqual(
        expect.objectContaining({ displayName: 'v2' }),
      );
      page.unmount();
    });

    it('re-reads once for one save, and not again for an unchanged render', async () => {
      const page = mountHook(usePage, props('canopy'));
      await landFirstReads(page);
      const statusBefore = statusReads.length;
      const inventoryBefore = inventoryReads.length;

      page.rerender(props('canopy', EDITED));
      expect(inventoryReads.length).toBe(inventoryBefore + 1);
      expect(statusReads.length).toBe(statusBefore + 1);
      await settle(() => {
        latestStatus().resolve([status('canopy')]);
        answer(latestInventory(), 'v2');
      });
      // The same list again, the same list as a new array, and a fresh render.
      page.rerender(props('canopy', EDITED));
      page.rerender(props('canopy', [server({ updatedAt: T2 })]));
      page.rerender({ ...props('canopy', EDITED), entry: { ...BASE_ENTRY } });
      await settle(() => undefined);
      expect(inventoryReads.length).toBe(inventoryBefore + 1);
      page.unmount();
    });
  });

  describe('a sign-in read that returns without the target (CAN-7363)', () => {
    it('leaves Connect unavailable until a read contains it', async () => {
      const page = mountHook(usePage, props('canopy'));
      await settle(() => {
        latestStatus().resolve([status('canopy')]);
        // The definition could not be loaded: a warning, and no entry.
        for (const read of inventoryReads)
          read.result.resolve({
            servers: [],
            warnings: ['Could not load MCP server tracker.'],
          });
      });
      expect(page.current.rowMcp.appliedScope).toBe(
        page.current.readiness.scopeGeneration,
      );
      expect(page.current.connect).toEqual({
        available: false,
        reason: LOADING,
      });
      // The next read has it.
      await settle(emitAuthChanged);
      await settle(() => answer(latestInventory()));
      expect(page.current.connect.available).toBe(true);
      page.unmount();
    });

    it('asks for a device copy target that is not a top-level configuration', async () => {
      const copy = server({
        configs: [{ id: 'c', name: 'C', enabled: true }],
        updatedAt: T2,
      });
      const servers = [server({ configs: [CONFIG_B], deviceCopies: [copy] })];
      const page = mountHook(
        usePage,
        props('canopy', servers, integrationEntry('device', 'c')),
      );
      expect(inventoryReads[0]?.refs).toContainEqual({
        serverId: 'tracker',
        configId: 'c',
      });
      await settle(() => {
        latestStatus().resolve([status('canopy')]);
        answerAll();
      });
      expect(page.current.connect.available).toBe(true);
      page.unmount();
    });
  });

  describe('a read in flight holds Connect (CAN-7363)', () => {
    it('holds a click while a same-key refresh is pending, and applies once the read lands', async () => {
      const page = mountHook(usePage, props('canopy'));
      await landFirstReads(page);
      const statusBefore = statusReads.length;
      const inventoryBefore = inventoryReads.length;

      // The sign-in finished elsewhere: the auth event starts the reads.
      await settle(emitAuthChanged);
      // One read per trigger, no more.
      expect(inventoryReads.length).toBe(inventoryBefore + 1);
      expect(statusReads.length).toBe(statusBefore + 1);
      // The previous read still matches every key, and still stands as data.
      expect(page.current.rowMcp.appliedScope).toBe(
        page.current.readiness.scopeGeneration,
      );
      expect(page.current.rowMcp.loading).toBe(true);
      expect(page.current.connect).toEqual({
        available: false,
        reason: LOADING,
      });

      await settle(() => {
        latestStatus().resolve([status('canopy')]);
        answer(latestInventory(), 'v2');
      });
      expect(page.current.connect.available).toBe(true);
      // Landing the read starts nothing more.
      expect(inventoryReads.length).toBe(inventoryBefore + 1);
      page.unmount();
    });
  });

  describe('a sign-in that outlives its revision (CAN-7363)', () => {
    /** A click whose sign-in settles when the test says so. */
    function startClick(page: MountedHook<PageProps, PageState>): {
      readonly signIn: Deferred<boolean>;
      readonly runTest: jest.Mock<Promise<void>, [McpTestTarget]>;
      readonly refreshStatuses: jest.Mock<Promise<void>, []>;
      readonly onProbeStarted: jest.Mock<void, []>;
      readonly done: Promise<'cancelled' | undefined>;
    } {
      const gate = page.current.connect;
      if (!gate.available || gate.target === null)
        throw new Error('Connect is not offered for a device target.');
      const { target, detected: signedInOn } = gate;
      const signIn = deferred<boolean>();
      const runTest = jest.fn<Promise<void>, [McpTestTarget]>(() =>
        Promise.resolve(),
      );
      const refreshStatuses = jest.fn<Promise<void>, []>(() =>
        Promise.resolve(),
      );
      const onProbeStarted = jest.fn<void, []>();
      const done = runMcpRowConnect({
        entry: BASE_ENTRY,
        target,
        detected: signedInOn,
        connect: () => signIn.promise,
        runTest,
        refreshStatuses,
        clearError: () => undefined,
        onProbeStarted,
        isCurrent: mcpRowConnectIsCurrent(
          page.current.readiness,
          page.current.latestReadiness,
          target,
        ),
      });
      return { signIn, runTest, refreshStatuses, onProbeStarted, done };
    }

    it('never probes when a save kept every id while the browser was open', async () => {
      const page = mountHook(usePage, props('canopy'));
      await landFirstReads(page);
      const click = startClick(page);
      page.rerender(props('canopy', EDITED));
      let outcome: 'cancelled' | undefined;
      await act(async () => {
        click.signIn.resolve(true);
        outcome = await click.done;
      });
      expect(outcome).toBe('cancelled');
      expect(click.runTest).not.toHaveBeenCalled();
      expect(click.onProbeStarted).not.toHaveBeenCalled();
      expect(click.refreshStatuses).not.toHaveBeenCalled();
      page.unmount();
    });

    it('never probes when the default moved while the browser was open', async () => {
      const page = mountHook(usePage, props('canopy'));
      await landFirstReads(page);
      const click = startClick(page);
      page.rerender(props('provider'));
      await act(async () => {
        click.signIn.resolve(true);
        await click.done;
      });
      expect(click.runTest).not.toHaveBeenCalled();
      expect(click.refreshStatuses).not.toHaveBeenCalled();
      page.unmount();
    });

    it('never probes a server that left the list', async () => {
      const page = mountHook(usePage, props('canopy'));
      await landFirstReads(page);
      const click = startClick(page);
      page.rerender(props('canopy', []));
      await act(async () => {
        click.signIn.resolve(true);
        await click.done;
      });
      expect(click.runTest).not.toHaveBeenCalled();
      page.unmount();
    });

    it('probes when nothing moved, whatever the list was rebuilt as', async () => {
      const page = mountHook(usePage, props('canopy'));
      await landFirstReads(page);
      const click = startClick(page);
      // The same saved list as a new array, as an index reload returns it.
      page.rerender(props('canopy', [server()]));
      let outcome: 'cancelled' | undefined;
      await act(async () => {
        click.signIn.resolve(true);
        outcome = await click.done;
      });
      expect(outcome).toBeUndefined();
      expect(click.onProbeStarted).toHaveBeenCalledTimes(1);
      expect(click.runTest).toHaveBeenCalledWith(
        expect.objectContaining({ serverId: 'tracker', configId: 'a' }),
      );
      expect(click.refreshStatuses).toHaveBeenCalledTimes(1);
      page.unmount();
    });
  });

  describe('a read that applied without the target (CAN-7363)', () => {
    function omitting(read: InventoryRead): void {
      read.result.resolve({
        servers: [],
        warnings: ['Could not load MCP server tracker.'],
      });
    }
    async function landWithoutTarget(
      page: MountedHook<PageProps, PageState>,
    ): Promise<void> {
      await settle(() => {
        latestStatus().resolve([status('canopy')]);
        for (const read of inventoryReads) omitting(read);
      });
      expect(page.current.connect).toEqual({
        available: false,
        reason: LOADING,
      });
    }
    const focus = (): void => {
      window.dispatchEvent(new Event('focus'));
    };

    it('one focus re-reads once, and the target recovers Connect with no auth event', async () => {
      const page = mountHook(usePage, props('canopy'));
      await landWithoutTarget(page);
      const before = inventoryReads.length;

      await settle(focus);
      expect(inventoryReads.length).toBe(before + 1);
      // Connect stays held while that read is pending.
      expect(page.current.connect).toEqual({
        available: false,
        reason: LOADING,
      });
      await settle(() => answer(latestInventory()));
      expect(page.current.connect.available).toBe(true);
      expect(inventoryReads.length).toBe(before + 1);
      page.unmount();
    });

    it('a focus whose read still lacks it asks once per focus, never on a timer', async () => {
      jest.useFakeTimers();
      try {
        const page = mountHook(usePage, props('canopy'));
        await landWithoutTarget(page);
        const before = inventoryReads.length;
        await act(async () => {
          jest.advanceTimersByTime(10 * 60_000);
          await Promise.resolve();
        });
        expect(inventoryReads.length).toBe(before);
        await settle(focus);
        await settle(() => omitting(latestInventory()));
        expect(inventoryReads.length).toBe(before + 1);
        expect(page.current.connect).toEqual({
          available: false,
          reason: LOADING,
        });
        await settle(focus);
        expect(inventoryReads.length).toBe(before + 2);
        page.unmount();
      } finally {
        jest.useRealTimers();
      }
    });

    it('a focus with every target present re-reads nothing', async () => {
      const page = mountHook(usePage, props('canopy'));
      await landFirstReads(page);
      const before = inventoryReads.length;
      const statusBefore = statusReads.length;
      await settle(focus);
      await settle(focus);
      expect(inventoryReads.length).toBe(before);
      expect(statusReads.length).toBe(statusBefore);
      page.unmount();
    });

    it('a focus while a read is pending or after one failed starts no other', async () => {
      const page = mountHook(usePage, props('canopy'));
      // First read pending.
      const pending = inventoryReads.length;
      await settle(focus);
      expect(inventoryReads.length).toBe(pending);
      await settle(() => {
        latestStatus().resolve([status('canopy')]);
        for (const read of inventoryReads)
          read.result.reject(new Error('IPC down'));
      });
      await settle(focus);
      expect(inventoryReads.length).toBe(pending);
      page.unmount();
    });

    it('an Account row the device read cannot hold is not a missing target', async () => {
      const account = server({
        id: 'cloud',
        scope: 'account',
        updatedAt: '',
        configs: [CONFIG_A],
      });
      const page = mountHook(usePage, props('canopy', [server(), account]));
      await settle(() => {
        latestStatus().resolve([status('canopy')]);
        for (const read of inventoryReads)
          read.result.resolve({
            servers: inventoryOfRefs(
              read.refs.filter((ref) => ref.serverId === 'tracker'),
            ),
            warnings: [],
          });
      });
      const before = inventoryReads.length;
      await settle(focus);
      expect(inventoryReads.length).toBe(before);
      page.unmount();
    });
  });

  describe('a failed sign-in read (CAN-7363)', () => {
    async function failFirstReads(
      page: MountedHook<PageProps, PageState>,
    ): Promise<void> {
      await settle(() => {
        latestStatus().resolve([status('canopy')]);
        for (const read of inventoryReads)
          read.result.reject(new Error('IPC down'));
      });
      expect(page.current.rowMcp.appliedScope).toBeNull();
      expect(page.current.connect).toEqual({
        available: false,
        reason: LOADING,
      });
      expect(page.current.banner).toBe('IPC down');
    }

    it('a save that keeps every id starts a new read, which recovers Connect and clears the banner', async () => {
      const page = mountHook(usePage, props('canopy'));
      await failFirstReads(page);
      const readsBefore = inventoryReads.length;

      page.rerender(props('canopy', EDITED));
      expect(inventoryReads.length).toBe(readsBefore + 1);
      await settle(() => {
        latestStatus().resolve([status('canopy')]);
        answer(latestInventory(), 'fixed');
      });
      expect(page.current.connect.available).toBe(true);
      expect(page.current.banner).toBe('');
      page.unmount();
    });

    it('a successful auth-event read recovers Connect and clears the banner', async () => {
      const page = mountHook(usePage, props('canopy'));
      await failFirstReads(page);
      // The page subscribes for the statuses and the hook for the sign-in
      // read: the one event reaches both.
      expect(authListeners.size).toBeGreaterThanOrEqual(2);
      const statusBefore = statusReads.length;
      await settle(emitAuthChanged);
      expect(statusReads.length).toBe(statusBefore + 1);
      await settle(() => {
        latestStatus().resolve([status('canopy')]);
        answer(latestInventory());
      });
      expect(page.current.connect.available).toBe(true);
      expect(page.current.banner).toBe('');
      page.unmount();
    });

    it('a message from another source stays when the read recovers', async () => {
      const page = mountHook(usePage, props('canopy'));
      await failFirstReads(page);
      // A Test failure replaces the banner before the read recovers.
      await settle(() => page.current.setBanner('The probe failed.'));
      page.rerender(props('canopy', EDITED));
      await settle(() => {
        latestStatus().resolve([status('canopy')]);
        answer(latestInventory());
      });
      expect(page.current.connect.available).toBe(true);
      expect(page.current.banner).toBe('The probe failed.');
      page.unmount();
    });

    it('a probe failure with the read failure’s text is not cleared by the read’s recovery', async () => {
      const page = mountHook(usePage, props('canopy'));
      await failFirstReads(page);
      // An independent probe failure that happens to read the same.
      await settle(() => page.current.setBanner('IPC down'));
      page.rerender(props('canopy', EDITED));
      await settle(() => {
        latestStatus().resolve([status('canopy')]);
        answer(latestInventory());
      });
      expect(page.current.readError).toBeNull();
      expect(page.current.ownBanner).toBe('IPC down');
      expect(page.current.banner).toBe('IPC down');
      page.unmount();
    });

    it('a sign-in attempt’s failure is not cleared by an unrelated read', async () => {
      const page = mountHook(usePage, props('canopy'));
      await landFirstReads(page);
      const signedInOn = page.current.rowMcp.servers[0];
      if (signedInOn === undefined) throw new Error('No sign-in entry.');
      await act(async () => {
        await page.current.rowMcp.connect(signedInOn, {
          signInRequired: false,
        });
      });
      expect(page.current.banner).toBe('Sign-in refused.');
      // An auth event elsewhere re-reads, and the read applies.
      await settle(emitAuthChanged);
      await settle(() => {
        latestStatus().resolve([status('canopy')]);
        answer(latestInventory(), 'v2');
      });
      expect(page.current.rowMcp.loading).toBe(false);
      expect(page.current.banner).toBe('Sign-in refused.');
      page.unmount();
    });

    describe('a sign-in failure beside a failing read', () => {
      /** A sign-in that is pending, then an inventory read that fails. */
      async function pendingSignInThenFailedRead(
        page: MountedHook<PageProps, PageState>,
      ): Promise<{
        readonly refuse: (message: string) => Promise<void>;
      }> {
        await landFirstReads(page);
        const signedInOn = page.current.rowMcp.servers[0];
        if (signedInOn === undefined) throw new Error('No sign-in entry.');
        const start = deferred<never>();
        startOAuthLogin = (): Promise<never> => start.promise;
        let attempt: Promise<boolean> = Promise.resolve(false);
        await act(async () => {
          attempt = page.current.rowMcp.connect(signedInOn, {
            signInRequired: false,
          });
          await Promise.resolve();
        });
        expect(page.current.rowMcp.connectingKey).not.toBeNull();
        // An auth event elsewhere re-reads, and that read fails.
        await settle(emitAuthChanged);
        await settle(() => {
          latestStatus().resolve([status('canopy')]);
          latestInventory().result.reject(new Error('IPC down'));
        });
        expect(page.current.readError).toBe('IPC down');
        return {
          refuse: async (message) => {
            await act(async () => {
              start.reject(new Error(message));
              await attempt;
            });
          },
        };
      }

      it('shows the sign-in failure, and the read’s failure beside it', async () => {
        const page = mountHook(usePage, props('canopy'));
        const { refuse } = await pendingSignInThenFailedRead(page);
        await refuse('Sign-in refused.');
        expect(page.current.ownBanner).toBe('Sign-in refused.');
        expect(page.current.readError).toBe('IPC down');
        page.unmount();
      });

      it('keeps the sign-in failure when the read later recovers', async () => {
        const page = mountHook(usePage, props('canopy'));
        const { refuse } = await pendingSignInThenFailedRead(page);
        await refuse('Sign-in refused.');
        await settle(emitAuthChanged);
        await settle(() => {
          latestStatus().resolve([status('canopy')]);
          answer(latestInventory(), 'v2');
        });
        expect(page.current.rowMcp.loading).toBe(false);
        expect(page.current.readError).toBeNull();
        expect(page.current.connect.available).toBe(true);
        expect(page.current.ownBanner).toBe('Sign-in refused.');
        expect(page.current.banner).toBe('Sign-in refused.');
        page.unmount();
      });

      it('a read failing after the sign-in failed does not hide it either', async () => {
        const page = mountHook(usePage, props('canopy'));
        await landFirstReads(page);
        const signedInOn = page.current.rowMcp.servers[0];
        if (signedInOn === undefined) throw new Error('No sign-in entry.');
        await act(async () => {
          await page.current.rowMcp.connect(signedInOn, {
            signInRequired: false,
          });
        });
        expect(page.current.ownBanner).toBe('Sign-in refused.');
        await settle(emitAuthChanged);
        await settle(() => {
          latestStatus().resolve([status('canopy')]);
          latestInventory().result.reject(new Error('IPC down'));
        });
        expect(page.current.readError).toBe('IPC down');
        expect(page.current.ownBanner).toBe('Sign-in refused.');
        page.unmount();
      });
    });

    describe('a sign-in refused after its configuration was replaced (CAN-7363)', () => {
      /**
       * A row's Connect, in flight: the real sign-in and probe wiring, with the
       * probe a spy. `refuse` rejects the sign-in's start, as the old
       * configuration's route would.
       */
      async function pendingConnect(
        page: MountedHook<PageProps, PageState>,
      ): Promise<{
        readonly probe: jest.Mock<Promise<void>, [McpTestTarget]>;
        readonly outcome: () => Promise<'cancelled' | undefined>;
        readonly refuse: (message: string) => Promise<void>;
      }> {
        await landFirstReads(page);
        const gate = page.current.connect;
        if (!gate.available || gate.target === null)
          throw new Error('Connect is not offered for a device target.');
        const { target, detected: signIn } = gate;
        const clicked = page.current.readiness;
        const probe = jest.fn<Promise<void>, [McpTestTarget]>(() =>
          Promise.resolve(),
        );
        const start = deferred<never>();
        startOAuthLogin = (): Promise<never> => start.promise;
        let outcome: Promise<'cancelled' | undefined> =
          Promise.resolve(undefined);
        await act(async () => {
          outcome = runMcpRowConnect({
            entry: BASE_ENTRY,
            target,
            detected: signIn,
            connect: (server, options) =>
              page.current.rowMcp.connect(server, options),
            runTest: probe,
            refreshStatuses: () => Promise.resolve(),
            clearError: () => undefined,
            onProbeStarted: () => undefined,
            isCurrent: mcpRowConnectIsCurrent(
              clicked,
              page.current.latestReadiness,
              target,
            ),
          });
          await Promise.resolve();
        });
        expect(page.current.rowMcp.connectingKey).not.toBeNull();
        return {
          probe,
          outcome: () => outcome,
          refuse: async (message) => {
            await act(async () => {
              start.reject(new Error(message));
              await outcome;
            });
          },
        };
      }

      /** The new configuration's reads: the status lands, the inventory fails. */
      async function failNewRead(
        page: MountedHook<PageProps, PageState>,
        next: PageProps,
      ): Promise<void> {
        page.rerender(next);
        await settle(() => {
          latestStatus().resolve([status('provider')]);
          for (const read of inventoryReads)
            read.result.reject(new Error('Current read failed'));
        });
        expect(page.current.readError).toBe('Current read failed');
      }

      /** An auth event re-reads, and the read applies. */
      async function recover(
        page: MountedHook<PageProps, PageState>,
        handler: McpHttpAuthHandler,
      ): Promise<void> {
        await settle(emitAuthChanged);
        await settle(() => {
          latestStatus().resolve([status(handler)]);
          answer(latestInventory(), 'v2');
        });
        expect(page.current.rowMcp.loading).toBe(false);
        expect(page.current.readError).toBeNull();
      }

      it('the default switched and the server was saved: the current read error wins, nothing is probed', async () => {
        const page = mountHook(usePage, props('canopy'));
        const { probe, outcome, refuse } = await pendingConnect(page);
        await failNewRead(page, props('provider', EDITED));
        await refuse('Old Canopy route refused');
        expect(await outcome()).toBe('cancelled');
        expect(probe).not.toHaveBeenCalled();
        expect(page.current.ownBanner).toBe('');
        expect(page.current.banner).toBe('Current read failed');
        // The legacy slot still carries it, for the other consumers.
        expect(page.current.rowMcp.error).toBe('Old Canopy route refused');
        page.unmount();
      });

      it('and the stale refusal does not resurface once the read recovers', async () => {
        const page = mountHook(usePage, props('canopy'));
        const { refuse } = await pendingConnect(page);
        await failNewRead(page, props('provider', EDITED));
        await refuse('Old Canopy route refused');
        await recover(page, 'provider');
        expect(page.current.ownBanner).toBe('');
        expect(page.current.banner).toBe('');
        // Nor on a later re-render or read.
        page.rerender(props('provider', EDITED));
        await recover(page, 'provider');
        expect(page.current.banner).toBe('');
        page.unmount();
      });

      it('a save alone, which keeps every id and the default, drops it too', async () => {
        const page = mountHook(usePage, props('canopy'));
        const { probe, refuse } = await pendingConnect(page);
        page.rerender(props('canopy', EDITED));
        await settle(() => {
          latestStatus().resolve([status('canopy')]);
          for (const read of inventoryReads)
            read.result.reject(new Error('Current read failed'));
        });
        await refuse('Old revision refused');
        expect(probe).not.toHaveBeenCalled();
        expect(page.current.ownBanner).toBe('');
        expect(page.current.banner).toBe('Current read failed');
        page.unmount();
      });

      describe('with another server saved beside it', () => {
        const OTHER = server({ id: 'other', name: 'Other' });
        const TWO: readonly McpServerIndexEntry[] = [server(), OTHER];
        const OTHER_EDITED: readonly McpServerIndexEntry[] = [
          server(),
          server({ id: 'other', name: 'Other', updatedAt: T2 }),
        ];
        const TRACKER_EDITED: readonly McpServerIndexEntry[] = [
          server({ updatedAt: T2 }),
          OTHER,
        ];

        /** The reads of the new list land, and every one applies. */
        async function landNewReads(
          handler: McpHttpAuthHandler = 'canopy',
        ): Promise<void> {
          await settle(() => {
            latestStatus().resolve([status(handler)]);
            answerAll('v2');
          });
        }

        it('another server saved alone does not drop the failure of the attempted one', async () => {
          const page = mountHook(usePage, props('canopy', TWO));
          const { probe, outcome, refuse } = await pendingConnect(page);
          page.rerender(props('canopy', OTHER_EDITED));
          await landNewReads();
          expect(page.current.rowMcp.loading).toBe(false);
          await refuse('A refused');
          expect(await outcome()).toBe('cancelled');
          expect(probe).not.toHaveBeenCalled();
          expect(page.current.ownBanner).toBe('A refused');
          expect(page.current.rowMcp.error).toBe('A refused');
          page.unmount();
        });

        it('the attempted server saved alone drops it', async () => {
          const page = mountHook(usePage, props('canopy', TWO));
          const { probe, outcome, refuse } = await pendingConnect(page);
          page.rerender(props('canopy', TRACKER_EDITED));
          await landNewReads();
          expect(page.current.rowMcp.loading).toBe(false);
          await refuse('A refused');
          expect(await outcome()).toBe('cancelled');
          expect(probe).not.toHaveBeenCalled();
          expect(page.current.ownBanner).toBe('');
          expect(page.current.rowMcp.error).toBe('A refused');
          page.unmount();
        });

        it('the attempted server removed drops it', async () => {
          const page = mountHook(usePage, props('canopy', TWO));
          const { probe, refuse } = await pendingConnect(page);
          page.rerender(props('canopy', [OTHER]));
          await landNewReads();
          await refuse('A refused');
          expect(probe).not.toHaveBeenCalled();
          expect(page.current.ownBanner).toBe('');
          page.unmount();
        });

        it('a change of the default drops it, whichever server was saved', async () => {
          const page = mountHook(usePage, props('canopy', TWO));
          const { probe, refuse } = await pendingConnect(page);
          page.rerender(props('provider', OTHER_EDITED));
          await landNewReads('provider');
          await refuse('A refused');
          expect(probe).not.toHaveBeenCalled();
          expect(page.current.ownBanner).toBe('');
          page.unmount();
        });
      });

      it('a refusal under the unchanged configuration is still shown', async () => {
        const page = mountHook(usePage, props('canopy'));
        const { refuse } = await pendingConnect(page);
        // A re-render with the same default and the same revisions.
        page.rerender(props('canopy', [server()]));
        await refuse('Sign-in refused.');
        expect(page.current.ownBanner).toBe('Sign-in refused.');
        page.unmount();
      });
    });

    describe('the sign-in failure and the hook’s own error (CAN-7363)', () => {
      const TWO_CONFIGS: readonly McpServerIndexEntry[] = [
        server({ configs: [CONFIG_A, CONFIG_B] }),
      ];
      const B_ONLY: readonly McpServerIndexEntry[] = [
        server({ configs: [CONFIG_B], updatedAt: T2 }),
      ];

      /** Lands the first reads of a page with two configurations. */
      async function landTwo(
        page: MountedHook<PageProps, PageState>,
      ): Promise<DetectedMcpServerInfo> {
        await settle(() => {
          latestStatus().resolve([status('canopy')]);
          answerAll();
        });
        const first = page.current.rowMcp.servers[0];
        if (first === undefined) throw new Error('No sign-in entry.');
        return first;
      }
      async function refuse(
        page: MountedHook<PageProps, PageState>,
        on: DetectedMcpServerInfo,
      ): Promise<void> {
        await act(async () => {
          await page.current.rowMcp.connect(on, { signInRequired: false });
        });
      }

      it('the hook’s error still clears when a read succeeds, for the other consumers', async () => {
        const page = mountHook(usePage, props('canopy'));
        await landFirstReads(page);
        const on = page.current.rowMcp.servers[0];
        if (on === undefined) throw new Error('No sign-in entry.');
        await refuse(page, on);
        expect(page.current.rowMcp.error).toBe('Sign-in refused.');
        // An auth event elsewhere (or the strip’s Try again) re-reads.
        await settle(emitAuthChanged);
        expect(page.current.rowMcp.error).toBeNull();
        await settle(() => {
          latestStatus().resolve([status('canopy')]);
          answer(latestInventory(), 'v2');
        });
        expect(page.current.rowMcp.loading).toBe(false);
        expect(page.current.rowMcp.error).toBeNull();
        // The row’s own channel keeps what the person has not dismissed.
        expect(page.current.ownBanner).toBe('Sign-in refused.');
        page.unmount();
      });

      it('a refresh clears the hook’s error when it starts, as before', async () => {
        const page = mountHook(usePage, props('canopy'));
        await landFirstReads(page);
        const on = page.current.rowMcp.servers[0];
        if (on === undefined) throw new Error('No sign-in entry.');
        await refuse(page, on);
        expect(page.current.rowMcp.error).toBe('Sign-in refused.');
        await settle(() => {
          void page.current.rowMcp.refresh();
        });
        expect(page.current.rowMcp.loading).toBe(true);
        expect(page.current.rowMcp.error).toBeNull();
        page.unmount();
      });

      it('a banner the page cleared is not published again when a removal re-reads the inventory', async () => {
        const page = mountHook(usePage, props('canopy', TWO_CONFIGS));
        const a = await landTwo(page);
        await refuse(page, a);
        expect(page.current.ownBanner).toBe('Sign-in refused.');
        // Testing B cleared the banner.
        await settle(() => page.current.setBanner(''));
        // Removing A keeps B: the selections change and the read applies.
        page.rerender(props('canopy', B_ONLY));
        await settle(() => {
          latestStatus().resolve([status('canopy')]);
          answer(latestInventory(), 'v2');
        });
        expect(page.current.rowMcp.loading).toBe(false);
        expect(page.current.rowMcp.servers.map((entry) => entry.key)).toEqual([
          'standalone:tracker:b',
        ]);
        expect(page.current.ownBanner).toBe('');
        // A later failure with the same text is a new one: it shows.
        const b = page.current.rowMcp.servers[0];
        if (b === undefined) throw new Error('No sign-in entry.');
        await refuse(page, b);
        expect(page.current.ownBanner).toBe('Sign-in refused.');
        page.unmount();
      });

      it('the same failure is published once, however often the hook re-renders', async () => {
        const page = mountHook(usePage, props('canopy'));
        await landFirstReads(page);
        const on = page.current.rowMcp.servers[0];
        if (on === undefined) throw new Error('No sign-in entry.');
        await refuse(page, on);
        await settle(() => page.current.setBanner(''));
        // A re-render and an unrelated successful read: still dismissed.
        page.rerender(props('canopy'));
        await settle(emitAuthChanged);
        await settle(() => {
          latestStatus().resolve([status('canopy')]);
          answer(latestInventory(), 'v2');
        });
        expect(page.current.ownBanner).toBe('');
        page.unmount();
      });

      it('a new attempt clears the last failure before it settles', async () => {
        const page = mountHook(usePage, props('canopy'));
        await landFirstReads(page);
        const on = page.current.rowMcp.servers[0];
        if (on === undefined) throw new Error('No sign-in entry.');
        await refuse(page, on);
        expect(page.current.rowMcp.signInFailure?.message).toBe(
          'Sign-in refused.',
        );
        const start = deferred<never>();
        startOAuthLogin = (): Promise<never> => start.promise;
        let attempt: Promise<boolean> = Promise.resolve(false);
        await act(async () => {
          attempt = page.current.rowMcp.connect(on, { signInRequired: false });
          await Promise.resolve();
        });
        expect(page.current.rowMcp.signInFailure).toBeNull();
        await act(async () => {
          start.reject(new Error('Refused again.'));
          await attempt;
        });
        expect(page.current.ownBanner).toBe('Refused again.');
        page.unmount();
      });

      describe('a vanished target beside a failed proxy toggle', () => {
        const SELECTIONS = {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [
            { serverId: 'tracker', configId: 'a' },
            { serverId: 'tracker', configId: 'b' },
          ],
        };
        const A = detected('tracker', 'a');
        const B: DetectedMcpServerInfo = {
          ...detected('tracker', 'b'),
          canToggleCanopyProxy: true,
        };

        it('still ends the attempt on the target and reports its loss', async () => {
          const hook = mountHook(
            ({ selections }: { selections: typeof SELECTIONS }) =>
              useDetectedMcpServers(selections, {
                // The host refuses the write.
                onSelectionsChange: () => Promise.resolve(false),
              }),
            { selections: SELECTIONS },
          );
          await settle(() => {
            latestInventory().result.resolve({
              servers: [A, B],
              warnings: [],
            });
          });
          expect(hook.current.servers).toHaveLength(2);
          // A's sign-in starts and never answers.
          const start = deferred<never>();
          startOAuthLogin = (): Promise<never> => start.promise;
          await act(async () => {
            void hook.current.connect(A);
            await Promise.resolve();
          });
          expect(hook.current.connectingKey).toBe(A.key);
          // A concurrent proxy toggle on B fails.
          await act(async () => {
            await hook.current.setCanopyProxyEnabled(B, true);
          });
          expect(hook.current.error).toBe(
            'Could not update MCP proxy setting.',
          );
          expect(hook.current.connectingKey).toBe(A.key);
          // The same selections read again, and A is gone from the answer.
          await settle(() => {
            void hook.current.refresh();
          });
          await settle(() => {
            latestInventory().result.resolve({ servers: [B], warnings: [] });
          });
          expect(hook.current.loading).toBe(false);
          expect(hook.current.connectingKey).toBeNull();
          expect(hook.current.error).toBe(
            'This MCP server is no longer available',
          );
          expect(hook.current.signInFailure?.message).toBe(
            'This MCP server is no longer available',
          );
          await act(async () => {
            start.reject(new Error('Closed.'));
            await Promise.resolve();
          });
          hook.unmount();
        });
      });
    });

    it('a read still in flight keeps the banner', async () => {
      const page = mountHook(usePage, props('canopy'));
      await failFirstReads(page);
      page.rerender(props('canopy', EDITED));
      expect(page.current.banner).toBe('IPC down');
      page.unmount();
    });

    it('a failed read for a new default recovers on an auth event after the page re-read is lost', async () => {
      const page = mountHook(usePage, props('canopy'));
      await landFirstReads(page);
      page.rerender(props('provider'));
      await settle(() => latestStatus().resolve([status('provider')]));
      // The page's own re-read for the new default is lost.
      await settle(() =>
        latestInventory().result.reject(new Error('IPC down')),
      );
      expect(page.current.rowMcp.appliedScope).toBeNull();
      // The browser sign-in event reads instead, and applies.
      await settle(emitAuthChanged);
      await settle(() => answer(latestInventory()));
      expect(page.current.rowMcp.appliedScope).toBe(
        page.current.readiness.scopeGeneration,
      );
      expect(page.current.banner).toBe('');
      page.unmount();
    });
  });
});

// ---------------------------------------------------------------------------
// The row's Test and its Reconnect chip, on the shared row component
// ---------------------------------------------------------------------------

describe('a row’s Test, Reconnect chip and probe errors (CAN-7363)', () => {
  const ROW: UnifiedPluginEntry = {
    ...BASE_ENTRY,
    connection: { status: 'unreachable' },
  };
  const ROW_SERVERS: readonly McpServerIndexEntry[] = [server()];
  const READY: McpRowReadiness = {
    servers: ROW_SERVERS,
    authDefault: 'canopy',
    scopeGeneration: GENERATION,
    statusSnapshot: snapshotOf(ROW_SERVERS, [status('canopy')], GENERATION),
  };
  // A status read that never landed: Test is held, as at page load.
  const HELD: McpRowReadiness = { ...READY, statusSnapshot: null };

  const testConnection = jest.fn<
    Promise<{ success: boolean; message: string; error?: string }>,
    [string, string | undefined]
  >();
  const startOAuthLogin = jest.fn();
  const connectRun = jest.fn();
  const onError = jest.fn<void, [string]>();
  let readiness: McpRowReadiness;
  let refresh: () => Promise<void>;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.mocked(reportClientAppError).mockClear();
    testConnection.mockReset();
    startOAuthLogin.mockReset();
    connectRun.mockReset();
    onError.mockReset();
    readiness = READY;
    refresh = (): Promise<void> => Promise.resolve();
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: { testConnection, startOAuthLogin },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  /** The page's actions: its Test gate and probe, over the real decision. */
  function actions(): CustomizeMcpRowActions {
    return {
      test: (entry) => {
        const gate = mcpRowTestEligibility(entry, readiness);
        if (!gate.available) return gate;
        const { target } = gate;
        if (target === undefined)
          return {
            available: true,
            target: undefined,
            run: () => Promise.resolve('opened' as const),
          };
        // What the page wires: the probe and its re-read, paired.
        const { run, refresh: reread } = mcpRowTestRun(
          async () => {
            const result = await window.mcpServers.testConnection(
              target.serverId,
              target.configId,
            );
            if (!result.success)
              throw new Error(result.error ?? result.message);
          },
          () => refresh(),
        );
        return { available: true, target, run, refresh: reread };
      },
      connect: () => ({ available: true, run: connectRun }),
      edit: () => ({ available: true, run: () => undefined }),
      onError,
    };
  }

  function renderRow(entry: UnifiedPluginEntry = ROW): void {
    act(() => {
      root.render(
        <CustomizeDiscoveryProvider enabled>
          <CustomizeTabSections
            tab="app"
            entries={[entry]}
            query=""
            installedInventory="ready"
            installedExpanded
            onSelectEntry={() => undefined}
            mcpRowActions={actions()}
          />
        </CustomizeDiscoveryProvider>,
      );
    });
  }

  function find(id: string): HTMLElement | null {
    return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }
  function chip(): HTMLElement | null {
    return find(`customize-row-failure-${ROW.id}-retry`);
  }
  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
  async function menuTest(): Promise<void> {
    const menu = find(`customize-row-menu-${ROW.id}`);
    if (menu === null) throw new Error('No row menu.');
    act(() => menu.click());
    const item = find(`customize-row-menu-${ROW.id}-test`);
    if (item === null) throw new Error('No Test item.');
    act(() => item.click());
    await flush();
  }

  describe('the Reconnect chip after a kept failure', () => {
    // Cached health that is healthy: the chip can only come from the kept
    // failure, never from the cache.
    const HEALTHY: UnifiedPluginEntry = BASE_ENTRY;

    it('reruns the Test probe with the menu’s own call, and never starts sign-in', async () => {
      testConnection.mockResolvedValue({
        success: false,
        message: 'Failed',
        error: 'Server refused.',
      });
      renderRow(HEALTHY);
      expect(chip()).toBeNull();
      await menuTest();
      expect(testConnection).toHaveBeenCalledTimes(1);
      const menuCall = testConnection.mock.calls[0];
      const reconnect = chip();
      if (reconnect === null) throw new Error('No Reconnect chip.');
      expect(reconnect.textContent).toBe('Reconnect');
      act(() => reconnect.click());
      await flush();
      // The same probe, on the same server and configuration.
      expect(testConnection).toHaveBeenCalledTimes(2);
      expect(testConnection.mock.calls[1]).toEqual(menuCall);
      expect(startOAuthLogin).not.toHaveBeenCalled();
      expect(connectRun).not.toHaveBeenCalled();
      expect(chip()?.textContent).toBe('Reconnect');
    });

    it('is held with Test: no retry is offered, and READY restores the same probe', async () => {
      testConnection.mockResolvedValue({
        success: false,
        message: 'Failed',
        error: 'Server refused.',
      });
      renderRow(HEALTHY);
      await menuTest();
      expect(mcpRowTestEligibility(HEALTHY, readiness).available).toBe(true);
      const menuCall = testConnection.mock.calls[0];
      // The status read for the scope is gone: Test is unknown, not offered.
      readiness = HELD;
      expect(mcpRowTestEligibility(HEALTHY, readiness).available).toBe(false);
      renderRow(HEALTHY);
      expect(chip()).toBeNull();
      expect(testConnection).toHaveBeenCalledTimes(1);
      expect(startOAuthLogin).not.toHaveBeenCalled();
      expect(connectRun).not.toHaveBeenCalled();
      // The read lands again: the probe is the same one.
      readiness = READY;
      testConnection.mockClear();
      testConnection.mockResolvedValue({
        success: false,
        message: 'Failed',
        error: 'Server refused.',
      });
      renderRow(HEALTHY);
      await menuTest();
      const restored = chip();
      if (restored === null) throw new Error('No Reconnect chip.');
      act(() => restored.click());
      await flush();
      expect(testConnection).toHaveBeenCalledTimes(2);
      expect(testConnection.mock.calls[1]).toEqual(menuCall);
      expect(startOAuthLogin).not.toHaveBeenCalled();
      expect(connectRun).not.toHaveBeenCalled();
    });

    it('a cached failure with Test held offers no retry, and one offered runs the Test', async () => {
      readiness = HELD;
      renderRow();
      expect(chip()).toBeNull();
      expect(testConnection).not.toHaveBeenCalled();
      expect(startOAuthLogin).not.toHaveBeenCalled();
      readiness = READY;
      testConnection.mockResolvedValue({ success: true, message: 'Connected' });
      renderRow();
      const offered = chip();
      if (offered === null) throw new Error('No Reconnect chip.');
      act(() => offered.click());
      await flush();
      expect(testConnection).toHaveBeenCalledTimes(1);
      expect(testConnection).toHaveBeenCalledWith('tracker', 'a');
      expect(startOAuthLogin).not.toHaveBeenCalled();
    });
  });

  describe('a probe failure beside a failing status refresh', () => {
    it('the row shows the probe’s failure, not the refresh’s', async () => {
      testConnection.mockResolvedValue({
        success: false,
        message: 'Failed',
        error: 'Server refused.',
      });
      const refreshFailure = new Error('Status read failed.');
      refresh = (): Promise<void> => Promise.reject(refreshFailure);
      renderRow();
      await menuTest();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith('Server refused.');
      // The refresh’s failure is not lost: it reaches the diagnostic sink.
      expect(reportClientAppError).toHaveBeenCalledTimes(1);
      expect(reportClientAppError).toHaveBeenCalledWith(refreshFailure);
    });

    it('a refresh failing after a probe that passed is still reported', async () => {
      testConnection.mockResolvedValue({ success: true, message: 'Connected' });
      refresh = (): Promise<void> =>
        Promise.reject(new Error('Status read failed.'));
      renderRow();
      await menuTest();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith('Status read failed.');
    });

    describe('one diagnostic per failed status read, with the real banner', () => {
      const surfaced = jest.fn(() => undefined);
      let uninstall: () => void = () => undefined;

      beforeEach(() => {
        surfaced.mockClear();
        uninstall = setSurfacedErrorRecorder(surfaced);
      });
      afterEach(() => uninstall());

      /** The page's wiring: a row's failure lands in the destructive banner. */
      function BannerHost(): React.JSX.Element {
        const [message, setMessage] = useState('');
        return (
          <>
            {message === '' ? null : (
              <ErrorBanner errorSource="plugins-page" error={message} />
            )}
            <CustomizeDiscoveryProvider enabled>
              <CustomizeTabSections
                tab="app"
                entries={[ROW]}
                query=""
                installedInventory="ready"
                installedExpanded
                onSelectEntry={() => undefined}
                mcpRowActions={{ ...actions(), onError: setMessage }}
              />
            </CustomizeDiscoveryProvider>
          </>
        );
      }
      const bannerRecords = (): unknown[][] =>
        surfaced.mock.calls.filter((call) =>
          JSON.stringify(call).includes('"chokePoint":"banner"'),
        );

      it('a refresh failing after a probe that passed is recorded once, by the banner', async () => {
        testConnection.mockResolvedValue({
          success: true,
          message: 'Connected',
        });
        refresh = (): Promise<void> =>
          Promise.reject(new Error('Status read failed.'));
        act(() => root.render(<BannerHost />));
        await menuTest();
        await flush();
        expect(container.textContent).toContain('Status read failed.');
        expect(bannerRecords()).toHaveLength(1);
        expect(reportClientAppError).not.toHaveBeenCalled();
      });

      it('both failing: the banner shows the probe’s failure and the refresh’s is reported once', async () => {
        testConnection.mockResolvedValue({
          success: false,
          message: 'Failed',
          error: 'Server refused.',
        });
        const refreshFailure = new Error('Status read failed.');
        refresh = (): Promise<void> => Promise.reject(refreshFailure);
        act(() => root.render(<BannerHost />));
        await menuTest();
        await flush();
        expect(container.textContent).toContain('Server refused.');
        expect(container.textContent).not.toContain('Status read failed.');
        expect(bannerRecords()).toHaveLength(1);
        expect(reportClientAppError).toHaveBeenCalledTimes(1);
        expect(reportClientAppError).toHaveBeenCalledWith(refreshFailure);
      });

      it('a later Test after a failed one is judged on its own probe', async () => {
        testConnection.mockResolvedValueOnce({
          success: false,
          message: 'Failed',
          error: 'Server refused.',
        });
        testConnection.mockResolvedValueOnce({
          success: true,
          message: 'Connected',
        });
        refresh = (): Promise<void> =>
          Promise.reject(new Error('Status read failed.'));
        act(() => root.render(<BannerHost />));
        await menuTest();
        expect(reportClientAppError).toHaveBeenCalledTimes(1);
        await menuTest();
        await flush();
        // The second run's refresh reaches the banner, never the host too.
        expect(reportClientAppError).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain('Status read failed.');
      });
    });

    it('Connect: a refresh failing after a probe that passed is not reported here, the banner records it', async () => {
      jest.mocked(reportClientAppError).mockClear();
      await expect(
        runMcpRowConnect({
          entry: BASE_ENTRY,
          target: { serverId: 'tracker', configId: 'a', revision: T1 },
          detected: detected('tracker', 'a'),
          connect: () => Promise.resolve(true),
          runTest: () => Promise.resolve(),
          refreshStatuses: () =>
            Promise.reject(new Error('Status read failed.')),
          clearError: () => undefined,
          onProbeStarted: () => undefined,
          isCurrent: () => true,
        }),
      ).rejects.toThrow('Status read failed.');
      expect(reportClientAppError).not.toHaveBeenCalled();
    });

    it('Connect: both failing reports the refresh’s once and throws the probe’s', async () => {
      jest.mocked(reportClientAppError).mockClear();
      const refreshFailure = new Error('Status read failed.');
      await expect(
        runMcpRowConnect({
          entry: BASE_ENTRY,
          target: { serverId: 'tracker', configId: 'a', revision: T1 },
          detected: detected('tracker', 'a'),
          connect: () => Promise.resolve(true),
          runTest: () => Promise.reject(new Error('Server refused.')),
          refreshStatuses: () => Promise.reject(refreshFailure),
          clearError: () => undefined,
          onProbeStarted: () => undefined,
          isCurrent: () => true,
        }),
      ).rejects.toThrow('Server refused.');
      expect(reportClientAppError).toHaveBeenCalledTimes(1);
      expect(reportClientAppError).toHaveBeenCalledWith(refreshFailure);
    });

    it('Connect: the probe’s failure is thrown, the refresh still runs', async () => {
      const refreshStatuses = jest.fn(() =>
        Promise.reject(new Error('Status read failed.')),
      );
      const outcome = runMcpRowConnect({
        entry: BASE_ENTRY,
        target: { serverId: 'tracker', configId: 'a', revision: T1 },
        detected: detected('tracker', 'a'),
        connect: () => Promise.resolve(true),
        runTest: () => Promise.reject(new Error('Server refused.')),
        refreshStatuses,
        clearError: () => undefined,
        onProbeStarted: () => undefined,
        isCurrent: () => true,
      });
      await expect(outcome).rejects.toThrow('Server refused.');
      expect(refreshStatuses).toHaveBeenCalledTimes(1);
    });

    it('Connect: a refresh failing after a probe that passed rejects with it', async () => {
      const outcome = runMcpRowConnect({
        entry: BASE_ENTRY,
        target: { serverId: 'tracker', configId: 'a', revision: T1 },
        detected: detected('tracker', 'a'),
        connect: () => Promise.resolve(true),
        runTest: () => Promise.resolve(),
        refreshStatuses: () => Promise.reject(new Error('Status read failed.')),
        clearError: () => undefined,
        onProbeStarted: () => undefined,
        isCurrent: () => true,
      });
      await expect(outcome).rejects.toThrow('Status read failed.');
    });
  });
});
