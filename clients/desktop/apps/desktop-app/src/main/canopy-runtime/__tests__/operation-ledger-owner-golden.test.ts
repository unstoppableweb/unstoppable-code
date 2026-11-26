import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createCanopyDispatcher } from '@canopy/core-runtime';
import {
  OperationService,
  RemoteOperationService,
  createCoreOperationLedgerHandlers,
  type OperationLedgerTransport,
} from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import {
  CORE_OPERATION_LEDGER_INSTRUCTION_DEFINITIONS,
  CORE_OPERATION_LEDGER_QUERY_DEFINITIONS,
  CORE_OPERATION_LEDGER_STREAM_DEFINITIONS,
  OPERATION_GRANTS,
  OPERATION_INSTRUCTION_DEFINITIONS,
  OPERATION_LEDGER_GRANTS,
  OPERATION_QUERY_DEFINITIONS,
  OPERATION_STREAM_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  createCoreOperationAdapter,
  createDaemonCoreOperationAdapter,
} from '../core-operation-adapter';
import {
  ELECTRON_DAEMON_DEFINITIONS,
  type ElectronDaemonClient,
} from '../electron-daemon-host';
import {
  ELECTRON_DAEMON_OWNER_DEFINITIONS,
  type ElectronDaemonOwnerClient,
} from '../electron-daemon-owner';
import { INTERFACE_RELAY_ALLOWLIST } from '../renderer-relay/interface-allowlist.generated';

/*
 * CAN-6986 L3: the desktop half of the daemon's operation ledger. Owner
 * proof alone grants `core.operationLedger.*`, an interim exception Mike
 * approved until E1 (CAN-4729), on three conditions:
 *   (a) Electron main's operation service uses its owner connection, never a
 *       leased peer connection;
 *   (b) renderer and remote cancels keep going through Electron main;
 *   (c) a public `core.operation.cancel` from any other peer stays refused
 *       (pinned at the daemon, operation-ledger-owner.test.ts).
 * Unselected: Electron main keeps its in-process service, and only a test
 * seam builds the daemon-backed adapter.
 */

const MAIN = path.join(__dirname, '..', '..');
const LEDGER = [
  ...Object.keys(CORE_OPERATION_LEDGER_QUERY_DEFINITIONS),
  ...Object.keys(CORE_OPERATION_LEDGER_INSTRUCTION_DEFINITIONS),
  ...Object.keys(CORE_OPERATION_LEDGER_STREAM_DEFINITIONS),
];

let dir: string;
const ledgers: OperationLedger[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'operation-ledger-owner-'));
});

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A seamed daemon holding the ledger, reached as its owner. */
function ownerConnection(): {
  transport: OperationLedgerTransport;
  calls: string[];
} {
  const ledger = OperationLedger.open(path.join(dir, 'operations.sqlite'));
  ledgers.push(ledger);
  const service = new OperationService({
    openLedger: (): OperationLedger => ledger,
  });
  const dispatcher = createCanopyDispatcher({
    profile: 'core+worker',
    definitions: {
      queries: CORE_OPERATION_LEDGER_QUERY_DEFINITIONS,
      instructions: CORE_OPERATION_LEDGER_INSTRUCTION_DEFINITIONS,
      streams: CORE_OPERATION_LEDGER_STREAM_DEFINITIONS,
    },
    handlers: createCoreOperationLedgerHandlers(service),
  });
  const caller: CanopyCallerDescriptor = {
    principalId: 'electron-main',
    clientInstanceId: 'electron-main:pipeline-owner',
    authorityId: 'authority',
    interfaceKind: 'desktop',
    grants: [OPERATION_LEDGER_GRANTS.owner],
  };
  const calls: string[] = [];
  return {
    calls,
    transport: {
      query: (name, params) => {
        calls.push(name);
        return dispatcher.query(name, params, { caller });
      },
      instruction: (name, params) => {
        calls.push(name);
        return dispatcher.instruction(name, params, { caller });
      },
      openStream: (name, params) => {
        calls.push(name);
        return dispatcher.openStream(name, params, { caller });
      },
    },
  };
}

describe("condition (a): the ledger goes only over Electron main's owner connection (CAN-6986 L3)", () => {
  it('declares the ledger on the owner client only; the leased peer client cannot carry it', () => {
    const owner = [
      ...Object.keys(ELECTRON_DAEMON_OWNER_DEFINITIONS.queries),
      ...Object.keys(ELECTRON_DAEMON_OWNER_DEFINITIONS.instructions),
      ...Object.keys(ELECTRON_DAEMON_OWNER_DEFINITIONS.streams),
    ];
    const peer = [
      ...Object.keys(ELECTRON_DAEMON_DEFINITIONS.queries),
      ...Object.keys(ELECTRON_DAEMON_DEFINITIONS.instructions),
      ...Object.keys(ELECTRON_DAEMON_DEFINITIONS.streams),
    ];
    for (const name of LEDGER) {
      expect(owner).toContain(name);
      expect(peer).not.toContain(name);
    }
    // Type-checked: the owner client can serve as the remote service's
    // transport, and the leased peer client cannot.
    const fromOwner = (
      client: ElectronDaemonOwnerClient,
    ): OperationLedgerTransport => client;
    const fromPeer = (
      client: ElectronDaemonClient,
      // @ts-expect-error -- the peer definitions do not carry the ledger.
    ): OperationLedgerTransport => client;
    expect([fromOwner, fromPeer]).toHaveLength(2);
  });

  it('pins every caller of the daemon-backed adapter to the owner-session getter, and none composes it yet', () => {
    const callers = mainSourcesCalling('createDaemonCoreOperationAdapter(');
    expect(callers).toEqual([]);
    // The scan itself: it accepts the owner getter and refuses anything else.
    expect(
      ownerCallViolations(
        "import { getDaemonPipelineOwnerClient } from './electron-daemon-owner';\n" +
          'createDaemonCoreOperationAdapter({ ownerClient: getDaemonPipelineOwnerClient });',
      ),
    ).toEqual([]);
    expect(
      ownerCallViolations(
        'createDaemonCoreOperationAdapter({ ownerClient: () => getElectronDaemonClient() });',
      ),
    ).toEqual([
      'does not import getDaemonPipelineOwnerClient from electron-daemon-owner',
      'a call does not pass ownerClient: getDaemonPipelineOwnerClient',
    ]);
    // Dormant: the desktop runtime builds the in-process service by default.
    expect(
      readFileSync(
        path.join(MAIN, 'canopy-runtime', 'desktop-runtime.ts'),
        'utf8',
      ),
    ).toContain('options.operationAdapter ?? createCoreOperationAdapter()');
  });

  it('selects the in-process ledger by default: nothing in main builds the remote service or replaces the default', () => {
    expect(mainSourcesCalling('new RemoteOperationService(')).toEqual([]);
    expect(mainSourcesCalling('createDaemonCoreOperationAdapter(')).toEqual([]);
    // Only the runtime names the adapter option, so no caller replaces the
    // default it builds.
    expect(mainSourcesCalling('operationAdapter')).toEqual([
      path.join('canopy-runtime', 'desktop-runtime.ts'),
    ]);
    const adapter = createCoreOperationAdapter({
      ledgerPath: () => path.join(dir, 'operations.sqlite'),
    });
    try {
      expect(adapter.service).toBeInstanceOf(OperationService);
      expect(adapter.service).not.toBeInstanceOf(RemoteOperationService);
    } finally {
      adapter.close();
    }
  });
});

describe('condition (b): renderer and remote cancels keep going through Electron main (CAN-6986 L3)', () => {
  it("applies a renderer's cancel with the owning domain in main, recording the intent at the ledger first", async () => {
    const { transport, calls } = ownerConnection();
    const adapter = createDaemonCoreOperationAdapter({
      ownerClient: () => Promise.resolve(transport),
    });
    const order: string[] = [];
    const cancel = jest.fn(() => {
      order.push(`domain after ${calls.at(-1) ?? 'nothing'}`);
      return Promise.resolve('cancelled' as const);
    });
    adapter.service.registerDomain({
      domain: 'helpers',
      kinds: ['core.helper.run'],
      restartClass: 'lost',
      cancel,
    });
    const admitted = await adapter.service.admit({
      kind: 'core.helper.run',
      status: 'running',
      origin: { kind: 'client', sourceId: 'desktop-window-1' },
      owner: { kind: 'principal', id: 'local-user' },
      scope: { workspaceId: 'alpha', worktreeId: 'main' },
    });
    // Main's dispatcher serves the window's and Remote Control's cancels.
    const main = createCanopyDispatcher({
      profile: 'core',
      definitions: {
        queries: OPERATION_QUERY_DEFINITIONS,
        instructions: OPERATION_INSTRUCTION_DEFINITIONS,
        streams: OPERATION_STREAM_DEFINITIONS,
      },
      handlers: {
        queries: adapter.queries,
        instructions: adapter.instructions,
        streams: adapter.streams,
      },
    });
    const renderer: CanopyCallerDescriptor = {
      principalId: 'local-user',
      clientInstanceId: 'renderer',
      authorityId: 'authority',
      interfaceKind: 'desktop',
      grants: [OPERATION_GRANTS.read, OPERATION_GRANTS.cancel],
    };
    await expect(
      main.instruction(
        'core.operation.cancel',
        { operationId: admitted.operation.operationId, reason: 'Stop.' },
        { caller: renderer },
      ),
    ).resolves.toMatchObject({
      outcome: 'cancelled',
      operation: {
        status: 'cancelled',
        cancellation: { requestedBy: 'local-user', reason: 'Stop.' },
      },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['domain after core.operationLedger.cancelIntent']);
    expect(calls).toContain('core.operationLedger.finishCancelled');
    expect(calls).toContain('core.operationLedger.events');
    expect(
      calls.every((name) => name.startsWith('core.operationLedger.')),
    ).toBe(true);
    adapter.close();
  });

  it('keeps the renderer relay off the ledger: no mode carries an internal operation', () => {
    for (const [mode, kinds] of Object.entries(INTERFACE_RELAY_ALLOWLIST)) {
      const carried = [
        ...kinds.query,
        ...kinds.instruction,
        ...kinds.stream,
      ].filter((name) => name.startsWith('core.operationLedger.'));
      expect({ mode, carried }).toEqual({ mode, carried: [] });
    }
  });
});

/** Main's non-test sources that call `call`, outside its definition. */
function mainSourcesCalling(call: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (entry === '__tests__' || entry === 'node_modules') continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (
        /\.tsx?$/.test(entry) &&
        !full.endsWith('core-operation-adapter.ts') &&
        readFileSync(full, 'utf8').includes(call)
      )
        found.push(path.relative(MAIN, full));
    }
  };
  walk(MAIN);
  return found;
}

/** How a source composing the adapter strays from the owner-session getter. */
function ownerCallViolations(source: string): string[] {
  const violations: string[] = [];
  if (
    !/import\s*\{[^}]*\bgetDaemonPipelineOwnerClient\b[^}]*\}\s*from\s*'[./]*(?:canopy-runtime\/)?electron-daemon-owner'/.test(
      source,
    )
  )
    violations.push(
      'does not import getDaemonPipelineOwnerClient from electron-daemon-owner',
    );
  const calls = source.split('createDaemonCoreOperationAdapter(').slice(1);
  if (
    calls.length === 0 ||
    calls.some(
      (call) =>
        !/^\s*\{\s*ownerClient:\s*getDaemonPipelineOwnerClient\s*,?\s*\}\s*\)/.test(
          call,
        ),
    )
  )
    violations.push(
      'a call does not pass ownerClient: getDaemonPipelineOwnerClient',
    );
  return violations;
}
