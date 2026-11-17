import type { CopilotVaultAccount } from './copilot-grant-contracts';
import type { MigrationProcessIdentity } from './migration-platform';
import type { VaultSecretPin } from '../../vault/contracts';
import type { MigrationUseReceipt } from './repository/migration-codec';

/**
 * Ports for the ADR 7 one-time legacy-store migration (CAN-4504 VA-1).
 * VA-6b composes these only for qualification; production remains disabled.
 * V5 (CAN-4506) supplies the durable source and import ports.
 */

export type MigrationHostOs = 'darwin' | 'win32' | 'linux';

/** Lower-case kebab id; never a path. */
export const MIGRATION_SLOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface MigrationSlotDefinition {
  readonly id: string;
  /** Hosts whose Electron build ever wrote this legacy store. */
  readonly platforms: readonly MigrationHostOs[];
}

const ALL_HOSTS: readonly MigrationHostOs[] = Object.freeze([
  'darwin',
  'win32',
  'linux',
]);

/**
 * The safeStorage stores at the pin (W7): doc 07's five plus Copilot, which
 * has no Linux store (D22). Data, not a type: V5 owns additions.
 */
export const MIGRATION_SLOTS_AT_PIN: readonly MigrationSlotDefinition[] =
  Object.freeze(
    [
      { id: 'github-pat', platforms: ALL_HOSTS },
      { id: 'linear-token', platforms: ALL_HOSTS },
      { id: 'mcp-oauth-tokens', platforms: ALL_HOSTS },
      { id: 'cloud-account', platforms: ALL_HOSTS },
      { id: 'user-environment-secrets', platforms: ALL_HOSTS },
      {
        id: 'copilot-account',
        platforms: Object.freeze<MigrationHostOs[]>(['darwin', 'win32']),
      },
    ].map((slot) => Object.freeze(slot)),
  );

/**
 * The legacy source a launcher reads (C-11): flavors share one data root but
 * not one legacy store, so every session records which one it imports from.
 */
export interface MigrationSourceIdentity {
  /** The launcher's flavor identifier (brand app id per flavor). */
  readonly flavorId: string;
  /** The flavor's secure-data mode. */
  readonly secureMode: string;
}

export function sameMigrationSource(
  a: MigrationSourceIdentity,
  b: MigrationSourceIdentity,
): boolean {
  return a.flavorId === b.flavorId && a.secureMode === b.secureMode;
}

/**
 * One source's view of one slot. Generations, fences and closure are per
 * (source, slot); the JSON array encoding keeps the key injective.
 */
export function migrationSlotKey(
  source: MigrationSourceIdentity,
  slot: string,
): string {
  return JSON.stringify(['v1', source.flavorId, source.secureMode, slot]);
}

/** Doc 07's durable per-slot states. */
export type MigrationSlotState =
  | 'not_started'
  | 'imported_unverified'
  | 'verified'
  | 'legacy_deleted';

export type MigrationSlotProgress =
  | { readonly state: 'not_started' }
  | {
      readonly state: Exclude<MigrationSlotState, 'not_started'>;
      /** The source that moved the slot past `not_started`. */
      readonly source: MigrationSourceIdentity;
    };

/** Daemon-side identity, compared at issue and again at consume (R-8). */
export interface MigrationHostFacts {
  readonly authorityId: string;
  readonly coreAuthority: string;
  readonly coreIncarnation: string;
  /** The daemon's executable digest (Darwin cdhash or platform digest). */
  readonly coreDigest: string;
  readonly buildId: string;
  readonly packageDigest: string;
  readonly updateEpoch: string;
}

export const MIGRATION_HOST_FIELDS = Object.freeze([
  'authorityId',
  'coreAuthority',
  'coreIncarnation',
  'coreDigest',
  'buildId',
  'packageDigest',
  'updateEpoch',
] as const satisfies readonly (keyof MigrationHostFacts)[]);

/** The only transport a migration session accepts. */
export const MIGRATION_LAUNCHER_TRANSPORT = 'launcher-channel';

/** Natively captured facts for one admitted channel. Never from a payload. */
export interface MigrationChannelFacts {
  readonly transport: string;
  readonly channelId: string;
  readonly launcher: MigrationProcessIdentity;
  /** The launcher's executable digest (Darwin cdhash or platform digest). */
  readonly launcherDigest: string;
  readonly source: MigrationSourceIdentity;
  /** Host identity when the channel was admitted. */
  readonly admittedHost: MigrationHostFacts;
}

export interface MigrationAdmissionPort {
  /**
   * Facts for a channel handle the trusted transport admitted, or null for
   * any other value, including retired channels and payload-built objects.
   */
  channel(handle: object): MigrationChannelFacts | null;
  /** Current host facts. Throws, read as unavailable, unless a channel is live. */
  host(): MigrationHostFacts;
}

/** V5's view of the legacy sources. Keys come from `migrationSlotKey`. */
export interface MigrationSourcePort {
  /** Changes whenever the legacy value behind `key` does. */
  currentGeneration(key: string): string;
  isFenced(key: string, generation: string): boolean;
  /** Durable. Records an attempt whose release may have happened. */
  fence(key: string, generation: string): void;
  slotProgress(slot: string): MigrationSlotProgress;
}

export interface MigrationImportRequest {
  readonly slot: string;
  readonly source: MigrationSourceIdentity;
  readonly generation: string;
  /** Plaintext; zeroed by the session once the import settles. */
  readonly value: Uint8Array;
}

export type MigrationImportResult =
  | { readonly kind: 'created'; readonly receipt: string }
  /** The vault already holds an entry for the slot; it was left unchanged. */
  | { readonly kind: 'exists' };

export interface MigrationImportPort {
  /**
   * Create-only (W15): atomically writes the entry only when the vault has
   * none for `slot`. Never replaces or deletes an entry, whoever wrote it.
   * Must not retain `value` after the returned promise settles.
   */
  createIfAbsent(
    request: MigrationImportRequest,
  ): PromiseLike<MigrationImportResult>;
}

/** A receipt the wire carries; anything else leaves the import uncertain. */
export const MIGRATION_RECEIPT_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

/**
 * Reads each field once into a frozen copy, so what was checked is what the
 * wire carries. Null when the receipt is missing or malformed.
 */
export function readMigrationImportResult(
  value: unknown,
): MigrationImportResult | null {
  if (typeof value !== 'object' || value === null || !('kind' in value))
    return null;
  const kind = value.kind;
  if (kind === 'exists') return Object.freeze({ kind });
  if (kind !== 'created' || !('receipt' in value)) return null;
  const receipt = value.receipt;
  return typeof receipt === 'string' && MIGRATION_RECEIPT_PATTERN.test(receipt)
    ? Object.freeze({ kind, receipt })
    : null;
}

export function isMigrationImportResult(
  value: unknown,
): value is MigrationImportResult {
  return readMigrationImportResult(value) !== null;
}

/** Async observations never turn a failed read into an absent source. */
export type MigrationObservation =
  | { readonly kind: 'present'; readonly generation: string }
  | {
      readonly kind: 'absent' | 'malformed' | 'unreadable' | 'outcome_unknown';
    };

export interface MigrationSnapshotPort {
  observe(source: MigrationSourceIdentity): Promise<MigrationObservation>;
  /**
   * Re-read under the sanctioned source writer queue, after draining owned
   * successors. Hold that queue through `run`; no adopting read or path input.
   * Both hosts must consult the durable prepare fence before legacy use.
   */
  withGeneration<T>(
    source: MigrationSourceIdentity,
    run: (observation: MigrationObservation) => Promise<T>,
  ): Promise<T>;
}

export interface MigrationAttemptContext {
  readonly attemptId: string;
  readonly epoch: number;
  readonly source: MigrationSourceIdentity;
  readonly generation: string;
}

export interface MigrationLineageContext extends MigrationAttemptContext {
  readonly pin: VaultSecretPin;
  readonly successorKeys: readonly string[];
}

/** Trusted P4/P7 composition, never populated from a protocol frame. */
export interface MigrationFamilyPorts {
  readonly slot: string;
  readonly snapshot?: MigrationSnapshotPort;
  readonly importer?: {
    /** Trusted non-consuming checkpoint before complete P2 grant ingress. */
    begin?(
      context: MigrationAttemptContext & {
        readonly idempotencyKey: string;
        readonly account: CopilotVaultAccount;
        readonly predecessorGeneration: string | null;
      },
    ): Promise<void>;
    /** Both initial import and reconciliation must pass the family publication gate. */
    finalize?(
      context: MigrationAttemptContext,
      isCurrent: () => boolean,
    ): Promise<void>;
    /**
     * Create-only using P1's reserved key and mint/intent attachment.
     * Do not retain plaintext after settlement, including failed imports.
     */
    import(
      context: MigrationAttemptContext & {
        readonly idempotencyKey: string;
        readonly value: Uint8Array;
        readonly isCurrent?: () => boolean;
      },
    ): Promise<void>;
  };
  readonly use?: {
    /** Only actual admitted committed-lineage use, not delivery or existence. */
    use(context: MigrationLineageContext): Promise<
      | {
          readonly kind: 'used';
          readonly receipt: MigrationUseReceipt;
        }
      | { readonly kind: 'unavailable' }
    >;
  };
  readonly deletion?: {
    /** Exact-generation compare/unlink plus directory durability, same source queue. */
    remove(
      context: MigrationAttemptContext & { readonly operationId: string },
    ): Promise<MigrationDeletionResult>;
    /**
     * Recover/finish this same operation, including a crash before remove ran.
     * Retake the source queue; absence without durable evidence is not completion.
     */
    reconcile(
      context: MigrationAttemptContext & { readonly operationId: string },
    ): Promise<MigrationDeletionResult>;
  };
}

export type MigrationDeletionResult =
  | {
      readonly kind: 'completed';
      readonly operationId: string;
      readonly generation: string;
      readonly completionId: string;
    }
  | {
      readonly kind:
        | 'absent'
        | 'changed'
        | 'unreadable'
        | 'unavailable'
        | 'outcome_unknown';
    };
