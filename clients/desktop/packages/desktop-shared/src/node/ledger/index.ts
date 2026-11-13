/**
 * Local Agent Ledger store (Node only).
 *
 * A durable single-writer SQLite store over `node:sqlite`, used by the desktop
 * storage worker behind the `core.ledger.*` handlers. Wire contracts come from
 * `@canopy/protocol/canopy-core`; this module adds storage, pure policy,
 * literal search, signed cursors and the typed store error.
 */
export { LedgerRepository } from './repository';
export type { LedgerRollupsInput, LedgerRollupsScopeRequest } from './rollups';
export {
  LEDGER_ACTOR_ORIGIN_KEY_MAX_CODE_POINTS,
  ledgerGlobalAccountKey,
} from './registrations';
export {
  LedgerStoreError,
  isLedgerStoreError,
  type LedgerStoreErrorOptions,
} from './errors';
export {
  LEDGER_ADD_AUTHOR_KINDS,
  LEDGER_DEFAULT_STATUS_BY_TYPE,
  LEDGER_MUTABLE_ENTRY_FIELDS,
  LEDGER_SUMMARY_AUTHOR_KIND,
  canLedgerActorAuthor,
  canLedgerActorOwn,
  checkLedgerAttribution,
  checkLedgerCreation,
  defaultLedgerStatus,
  evaluateLedgerUpdate,
  isLedgerEntryOpen,
  isLedgerPolicyViolation,
  resolveLedgerInitialStatus,
  sameLedgerActor,
  type LedgerCreationPolicyInput,
  type LedgerEntryCreationPath,
  type LedgerOwnerChange,
  type LedgerPolicyViolation,
  type LedgerStatusChange,
  type LedgerUpdateDecision,
  type LedgerUpdatePolicyInput,
  type LedgerUpdateRejection,
} from './policy';
export {
  LEDGER_SCOPE_LIFECYCLE_TRANSITIONS,
  canPurgeLedgerScope,
  canRebindLedgerScope,
  canTransitionLedgerScope,
  hasLedgerContainerLifecycle,
  isLedgerScopeLifecycleState,
  isLedgerScopeWritable,
  ledgerScopeLifecycleRejection,
  ledgerScopeLifecycleStep,
  type LedgerScopeLifecycleStep,
  type LedgerScopeLifecycleTarget,
} from './lifecycle';
export { LEDGER_DEFAULT_OPEN_BUSY_TIMEOUT_MS } from './database';
export { LEDGER_SCHEMA_VERSION } from './schema';
export {
  LEDGER_COMMAND_OPERATIONS,
  LEDGER_IDEMPOTENCY_KEY_MAX_CODE_POINTS,
  LEDGER_RECEIPT_KEYS_MAX,
  LEDGER_WORK_SUMMARY_ACTOR_IDS_MAX,
  type LedgerCommandOperation,
} from './requests';
export {
  LEDGER_SCOPE_LIFECYCLE_STATES,
  LEDGER_SYNC_REPAIR_REASONS,
  type LedgerAcknowledgeOutboxInput,
  type LedgerActorRecord,
  type LedgerAddEntryInput,
  type LedgerBindGlobalScopeInput,
  type LedgerBindScopeInput,
  type LedgerBindScopeResult,
  type LedgerCommitHookContext,
  type LedgerFindGlobalScopeInput,
  type LedgerFindScopeInput,
  type LedgerGetEntryInput,
  type LedgerHandBackEntryInput,
  type LedgerListChangesInput,
  type LedgerListReceiptKeysInput,
  type LedgerOutboxEventRecord,
  type LedgerPendingTitleRecord,
  type LedgerPublishSummaryInput,
  type LedgerPurgeScopeResult,
  type LedgerReadOutboxInput,
  type LedgerRecordPendingTitleAttemptInput,
  type LedgerRebindAccountInput,
  type LedgerRebindAccountResult,
  type LedgerRebindScopeInput,
  type LedgerRecordMirrorAudienceInput,
  type LedgerRegisterActorInput,
  type LedgerRegisterActorResult,
  type LedgerRelatedEntryChange,
  type LedgerResolvePendingTitleInput,
  type LedgerResolvePendingTitleResult,
  type LedgerRepositoryOptions,
  type LedgerSchemaStatus,
  type LedgerScopeLifecycleState,
  type LedgerScopeRecord,
  type LedgerScopeSyncRecord,
  type LedgerSearchEntriesInput,
  type LedgerSearchEntriesResult,
  type LedgerSetScopeLifecycleInput,
  type LedgerSetScopeRepairInput,
  type LedgerSourceAvailabilityResolver,
  type LedgerStorageCounts,
  type LedgerStoreCommandReceipt,
  type LedgerStoreOperation,
  type LedgerSyncRepairReason,
  type LedgerUpdateEntryInput,
  type LedgerWorkSummaryInput,
} from './types';
