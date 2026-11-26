import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  IN_PROCESS_LEASE_TERMS,
  IN_PROCESS_WORKER_TARGET,
  type DelegationDispatchInput,
} from '@canopy/protocol/canopy-core';
import { OperationService } from '..';
import {
  OperationLedger,
  OperationLedgerRefusedError,
  type OperationAcceptRequest,
} from '../ledger';
import { OPERATION_LEDGER_SCHEMA_VERSION } from '../ledger/database';

/*
 * CAN-6986 L3: when the daemon owns the ledger, the ledger runs as the owner
 * process's run. A new owner process is a new run of the same open ledger:
 * work earlier runs left unfinished is treated as a reopen treats it, and the
 * in-process worker is placed again, never reusing an earlier placement. The
 * same owner process resumes its run after a reconnect or the ledger's
 * reopen, and its work stays its own.
 */

const KIND = 'core.helper.run';

let dir: string;

function open(): { ledger: OperationLedger; service: OperationService } {
  const ledger = OperationLedger.open(join(dir, 'operations.sqlite'));
  const service = new OperationService({
    openLedger: (): OperationLedger => ledger,
  });
  return { ledger, service };
}

function request(
  overrides: Partial<OperationAcceptRequest> = {},
): OperationAcceptRequest {
  return {
    kind: KIND,
    status: 'running',
    origin: { kind: 'client', sourceId: 'desktop-window-1' },
    owner: { kind: 'principal', id: 'local-user' },
    scope: { workspaceId: 'alpha', worktreeId: 'main' },
    ...overrides,
  };
}

const DIGEST = `sha256:${'0'.repeat(64)}`;

/** A child of `parentOperationId` dispatched on `leaseId`. */
function dispatched(
  parentOperationId: string,
  leaseId: string,
): {
  request: OperationAcceptRequest & {
    parentOperationId: string;
    runtimeDelegationId: string;
  };
  dispatch: DelegationDispatchInput;
} {
  const delegationId = randomUUID();
  const key = randomUUID();
  return {
    request: {
      kind: 'worker.agent.helper.run',
      status: 'queued',
      receipt: {
        caller: `core.delegation:${parentOperationId}`,
        idempotencyKey: key,
        fingerprint: DIGEST,
      },
      origin: { kind: 'delegation', sourceId: parentOperationId },
      owner: { kind: 'principal', id: 'local-user' },
      scope: { workspaceId: 'alpha', worktreeId: 'main' },
      parentOperationId,
      runtimeDelegationId: delegationId,
    },
    dispatch: {
      delegationId,
      targetId: IN_PROCESS_WORKER_TARGET.targetId,
      leaseId,
      operation: {
        name: 'worker.agent.helper.run',
        version: 1,
        idempotency: 'keyed',
      },
      idempotencyKey: key,
      executorKey: delegationId,
      activation: { delivery: 'inline-parameters', digest: DIGEST },
      secrets: [],
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'operation-ledger-runs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('operation ledger runs per owner process (CAN-6986 L3)', () => {
  it("runs as the owner process's run, and a new owner process makes earlier runs read as interrupted", () => {
    const { ledger } = open();
    try {
      ledger.runAsOwner('owner-1');
      expect(ledger.ownerRun).toBe('owner-1');
      expect(ledger.runEpoch).toBe('owner-1');
      const first = ledger.accept(request());
      if (first.status !== 'accepted') throw new Error('not accepted');
      expect(ledger.listInterrupted()).toEqual([]);
      ledger.runAsOwner('owner-1');
      expect(ledger.listInterrupted()).toEqual([]);
      ledger.runAsOwner('owner-2');
      expect(ledger.runEpoch).toBe('owner-2');
      expect(
        ledger.listInterrupted().map(({ operationId }) => operationId),
      ).toEqual([first.operation.operationId]);
      const second = ledger.accept(request());
      if (second.status !== 'accepted') throw new Error('not accepted');
      expect(
        ledger.listInterrupted().map(({ operationId }) => operationId),
      ).toEqual([first.operation.operationId]);
    } finally {
      ledger.close();
    }
  });

  it("leaves the owner run's work to its process when the ledger reopens", () => {
    const before = open().ledger;
    before.runAsOwner('owner-1');
    const first = before.accept(request());
    if (first.status !== 'accepted') throw new Error('not accepted');
    before.close();
    const { ledger } = open();
    try {
      expect(ledger.ownerRun).toBe('owner-1');
      expect(ledger.runEpoch).not.toBe('owner-1');
      expect(ledger.listInterrupted()).toEqual([]);
      ledger.runAsOwner('owner-1');
      expect(ledger.listInterrupted()).toEqual([]);
      expect(ledger.get(first.operation.operationId)).toMatchObject({
        status: 'running',
      });
    } finally {
      ledger.close();
    }
  });

  it("reconciles an earlier owner process's unfinished work as an open does, and leaves the same process's alone", async () => {
    const { ledger, service } = open();
    try {
      await service.runAsOwner('owner-1');
      const earlier = await service.admit(request());
      if (earlier.status !== 'accepted') throw new Error('not accepted');
      await service.runAsOwner('owner-1');
      expect(ledger.get(earlier.operation.operationId)?.status).toBe('running');
      await service.runAsOwner('owner-2');
      const later = await service.admit(request());
      if (later.status !== 'accepted') throw new Error('not accepted');
      expect(ledger.get(earlier.operation.operationId)).toMatchObject({
        status: 'paused',
        restart: { disposition: 'unclaimed' },
      });
      expect(ledger.get(later.operation.operationId)).toMatchObject({
        status: 'running',
      });
      service.registerDomain({
        domain: 'helpers',
        kinds: [KIND],
        restartClass: 'lost',
        cancel: () => Promise.resolve('cancelled' as const),
      });
      expect(ledger.get(earlier.operation.operationId)?.status).not.toBe(
        'paused',
      );
      expect(ledger.get(later.operation.operationId)?.status).toBe('running');
    } finally {
      ledger.close();
    }
  });

  it("reconciles an earlier owner process's work when a new run's registration is retried after its reconciliation failed", async () => {
    const { ledger, service } = open();
    try {
      await service.runAsOwner('owner-1');
      const { operation } = await service.admit(request());
      jest.spyOn(ledger, 'reconcile').mockImplementationOnce(() => {
        throw new Error('The disk is full.');
      });
      await expect(service.runAsOwner('owner-2')).rejects.toThrow();
      await service.runAsOwner('owner-2');
      expect(ledger.get(operation.operationId)).toMatchObject({
        status: 'paused',
        restart: { disposition: 'unclaimed' },
      });
    } finally {
      ledger.close();
    }
  });

  it("answers one claim to a new owner process's registrations that cross while the ledger opens, and a new claim to the next process", async () => {
    const { ledger, service } = open();
    try {
      const crossing = await Promise.all([
        service.registerOwnerDomains([], { ownerRun: 'owner-1' }),
        service.registerOwnerDomains([], { ownerRun: 'owner-1' }),
      ]);
      expect(crossing.map(({ resumed }) => resumed)).toEqual([false, false]);
      const [{ claimId }] = crossing;
      expect(claimId).toEqual(expect.any(String));
      expect(crossing[1].claimId).toBe(claimId);
      const next = await service.registerOwnerDomains([], {
        ownerRun: 'owner-2',
      });
      expect(next.claimId).not.toBe(claimId);
    } finally {
      ledger.close();
    }
  });

  it('keeps the in-process placement for the same owner process, places it again for a new one, and refuses a dispatch on the earlier placement', async () => {
    const { ledger, service } = open();
    try {
      await service.runAsOwner('owner-1');
      const first = await service.placeInProcessWorker(
        IN_PROCESS_WORKER_TARGET,
        IN_PROCESS_LEASE_TERMS,
      );
      await service.runAsOwner('owner-1');
      expect(
        await service.placeInProcessWorker(
          IN_PROCESS_WORKER_TARGET,
          IN_PROCESS_LEASE_TERMS,
        ),
      ).toEqual(first);
      await service.runAsOwner('owner-2');
      const placed = await service.placeInProcessWorker(
        IN_PROCESS_WORKER_TARGET,
        IN_PROCESS_LEASE_TERMS,
      );
      expect(placed.leaseId).not.toBe(first.leaseId);
      expect(placed.runEpoch).toBe(ledger.runEpoch);
      expect(ledger.getLease(first.leaseId)).toMatchObject({
        releaseReason: 'process-ended',
      });
      const parent = await service.admit(request());
      if (parent.status !== 'accepted') throw new Error('not accepted');
      const stale = dispatched(parent.operation.operationId, first.leaseId);
      await expect(
        service.acceptDispatch(stale.request, stale.dispatch),
      ).rejects.toBeInstanceOf(OperationLedgerRefusedError);
      const fresh = dispatched(parent.operation.operationId, placed.leaseId);
      await expect(
        service.acceptDispatch(fresh.request, fresh.dispatch),
      ).resolves.toMatchObject({ result: { status: 'accepted' } });
    } finally {
      ledger.close();
    }
  });
});

/*
 * The owner run is an additive metadata key (CAN-6986 L3): no schema
 * migration, records untouched, and a reader that does not know the key
 * opens the file as before.
 */
describe('the owner run in the ledger format (CAN-6986 L3)', () => {
  function meta(): Record<string, string> {
    const db = new DatabaseSync(join(dir, 'operations.sqlite'));
    try {
      return Object.fromEntries(
        db
          .prepare('SELECT key, value FROM operation_meta')
          .all()
          .map((row) => [String(row.key), String(row.value)]),
      );
    } finally {
      db.close();
    }
  }

  it('opens a ledger written without an owner run, and treats its unfinished work as before', () => {
    const before = open().ledger;
    const first = before.accept(request());
    if (first.status !== 'accepted') throw new Error('not accepted');
    before.close();
    expect(Object.keys(meta()).sort()).toEqual([
      'events_pruned_through',
      'ledger_id',
      'schema_version',
    ]);
    const { ledger } = open();
    try {
      expect(ledger.ownerRun).toBeNull();
      expect(
        ledger.listInterrupted().map(({ operationId }) => operationId),
      ).toEqual([first.operation.operationId]);
    } finally {
      ledger.close();
    }
  });

  it('keeps the schema version with an owner run, and opens a ledger carrying metadata its reader does not know', () => {
    const before = open().ledger;
    const claimId = before.runAsOwner('owner-1');
    const first = before.accept(request());
    if (first.status !== 'accepted') throw new Error('not accepted');
    const record = before.get(first.operation.operationId);
    before.close();
    const written = meta();
    expect(written.schema_version).toBe(
      String(OPERATION_LEDGER_SCHEMA_VERSION),
    );
    expect(written.owner_run).toBe(`${written.ledger_id} owner-1 ${claimId}`);
    // A key this reader does not know, as owner_run is to an earlier one.
    const db = new DatabaseSync(join(dir, 'operations.sqlite'));
    db.prepare(
      "INSERT INTO operation_meta (key, value) VALUES ('later_key', 'x')",
    ).run();
    db.close();
    const { ledger } = open();
    try {
      expect(ledger.ownerRun).toBe('owner-1');
      expect(ledger.get(first.operation.operationId)).toEqual(record);
    } finally {
      ledger.close();
    }
  });
});
