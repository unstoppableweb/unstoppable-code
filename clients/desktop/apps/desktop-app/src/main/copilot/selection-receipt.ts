import { randomUUID } from 'node:crypto';
import {
  CopilotHostSelectionSchema,
  type CopilotHostSelection,
  type CopilotSelectionIdentity,
} from '@canopy/protocol/copilot-selection';
import type {
  CopilotSelectionPort,
  CopilotSelectionRequest,
} from '@canopy/core-runtime/node/vault';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import type { CopilotSetupLineage } from './setup-lineage';
import {
  readPreferencesFileDetailed,
  updatePreferencesFile,
} from '../lib/preferences-store';

type Stored = Pick<
  PreferencesData,
  'copilotVaultSelection' | 'copilotAccount' | 'copilotEnabled'
>;
export interface CopilotSelectionRepository {
  read(): Promise<Stored>;
  update(updater: (current: Stored) => Partial<Stored> | null): Promise<Stored>;
}
function sameIdentity(
  a: CopilotSelectionIdentity,
  b: CopilotSelectionIdentity,
): boolean {
  return (
    a.operationId === b.operationId &&
    a.epoch === b.epoch &&
    a.origin === b.origin &&
    a.account.host === b.account.host &&
    a.account.id === b.account.id &&
    a.account.login === b.account.login
  );
}
function sameRequest(
  record: CopilotHostSelection,
  request: CopilotSelectionRequest,
): boolean {
  return (
    sameIdentity(record.identity, request) &&
    record.pin?.ref.vaultId === request.pin.ref.vaultId &&
    record.pin.ref.entryId === request.pin.ref.entryId &&
    record.pin.revision === request.pin.revision
  );
}
function ownsSelection(
  record: CopilotHostSelection,
  request: CopilotSelectionRequest,
): boolean {
  return (
    sameIdentity(record.identity, request) &&
    record.pin?.ref.vaultId === request.pin.ref.vaultId &&
    record.pin.ref.entryId === request.pin.ref.entryId &&
    record.pin.revision <= request.pin.revision
  );
}
function selection(value: Stored): CopilotHostSelection | undefined {
  return CopilotHostSelectionSchema.safeParse(value.copilotVaultSelection).data;
}

/** Served defaults/last-good are not evidence for custody or a pin acknowledgement. */
export async function readCopilotSelectionPreferences(): Promise<PreferencesData> {
  const read = await readPreferencesFileDetailed();
  if (read.authority !== 'ok' && read.authority !== 'absent')
    throw new Error('Copilot runtime is unavailable.');
  return read.preferences;
}

/** Only the preferences repository writes. The per-pin nonce ignores unrelated saves. */
export function createCopilotSelectionReceipt(
  repository: CopilotSelectionRepository = {
    read: readCopilotSelectionPreferences,
    update: (updater) => updatePreferencesFile(updater),
  },
  lineage?: CopilotSetupLineage,
): CopilotSelectionPort & {
  abandon(identity: CopilotSelectionIdentity): Promise<void>;
  prepare(
    identity: CopilotSelectionIdentity,
    expectedGeneration: string | null,
  ): Promise<boolean>;
} {
  return {
    async setupPredecessor() {
      // Only the qualification lineage composition opts into the v2 witness.
      if (!lineage) return undefined;
      const current = await repository.read();
      const record = selection(current);
      if (
        current.copilotEnabled !== false ||
        !record ||
        !lineage.ownsPredecessor(record)
      )
        throw new Error('Copilot setup predecessor unavailable.');
      return record;
    },
    async abandon(identity) {
      await repository.update((current) => {
        const record = selection(current);
        return record?.state === 'prepared' &&
          sameIdentity(record.identity, identity)
          ? {
              copilotVaultSelection: { ...record, state: 'disabled' },
              copilotEnabled: false,
              copilotAccount: undefined,
            }
          : null;
      });
    },
    async cancelledReceipt(identity) {
      // Only the qualification lineage composition commits the survivor to the v2 witness.
      if (!lineage) return undefined;
      const current = await repository.read();
      const record = selection(current);
      // P4 checks the identity and pin against its journal before committing it.
      return record?.state === 'disabled' &&
        current.copilotEnabled === false &&
        record.identity.operationId === identity.operationId
        ? record
        : undefined;
    },
    async prepare(identity, expectedGeneration) {
      const captured = structuredClone(identity);
      const pinGeneration = randomUUID();
      function finished(record: CopilotHostSelection | undefined): boolean {
        const accepted =
          !!record &&
          sameIdentity(record.identity, captured) &&
          record.state === 'prepared';
        const continuous = lineage?.prepared(captured, record) ?? true;
        return accepted && continuous;
      }
      try {
        if (captured.origin === 'setup')
          lineage?.preparing(captured, expectedGeneration);
        const saved = await repository.update((current) => {
          const previous = selection(current);
          if (previous && sameIdentity(previous.identity, captured))
            return null;
          if (current.copilotVaultSelection !== undefined && !previous)
            return null;
          if (
            (previous?.pinGeneration ?? null) !== expectedGeneration ||
            (previous && previous.state !== 'disabled')
          )
            return null;
          return {
            copilotEnabled: false,
            copilotAccount: undefined,
            copilotVaultSelection: {
              version: 1,
              identity: captured,
              pinGeneration,
              pin: null,
              state: 'prepared',
            },
          };
        });
        const record = selection(saved);
        return finished(record);
      } catch {
        // A durable read, not the rejected write acknowledgement, resolves uncertainty.
        try {
          const saved = selection(await repository.read());
          return finished(saved);
        } catch {
          return finished(undefined);
        }
      }
    },
    async confirm(input) {
      const request = structuredClone(input);
      try {
        await repository.update((current) => {
          const record = selection(current);
          if (
            !record ||
            !sameIdentity(record.identity, request) ||
            record.state !== 'prepared'
          )
            return null;
          return {
            copilotVaultSelection: {
              ...record,
              pin: request.pin,
              state: 'selected',
            },
            copilotEnabled: true,
            copilotAccount: {
              host: request.account.host,
              login: request.account.login,
            },
          };
        });
      } catch {
        /* Resolve the exact receipt below, including a lost acknowledgement. */
      }
      try {
        const record = selection(await repository.read());
        if (
          record &&
          record.state === 'selected' &&
          sameRequest(record, request)
        )
          return {
            kind: 'confirmed',
            receipt: { ...request, pinGeneration: record.pinGeneration },
          };
        return {
          kind:
            (record && !sameIdentity(record.identity, request)) ||
            record?.state === 'disabled'
              ? 'superseded'
              : 'unconfirmed',
        };
      } catch {
        return { kind: 'unconfirmed' };
      }
    },
    async disable({ head }) {
      const expected = structuredClone(head);
      try {
        await repository.update((current) => {
          const record = selection(current);
          if (
            !record ||
            record.state !== 'selected' ||
            record.pinGeneration !== expected.pinGeneration ||
            !ownsSelection(record, expected)
          )
            return null;
          return {
            copilotVaultSelection: { ...record, state: 'disabled' },
            copilotEnabled: false,
            copilotAccount: undefined,
          };
        });
      } catch {
        /* A failed save can still have committed; never assume disable. */
      }
      try {
        const current = await repository.read();
        const record = selection(current);
        if (
          record &&
          record.pinGeneration === expected.pinGeneration &&
          ownsSelection(record, expected)
        ) {
          // Only the lineage composition retires the exact receipt into the v2 witness.
          if (record.state === 'disabled' && current.copilotEnabled === false)
            return lineage
              ? { kind: 'disabled', receipt: record }
              : { kind: 'disabled' };
          if (record.state === 'selected' && current.copilotEnabled === true)
            return { kind: 'failed' };
        }
        return { kind: 'unconfirmed' };
      } catch {
        return { kind: 'unconfirmed' };
      }
    },
  };
}
