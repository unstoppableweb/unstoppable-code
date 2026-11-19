import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { THINKING_LEVELS } from '@canopy/protocol/thinking';
import {
  DELEGATION_STORAGE_ENTRY_LIMIT,
  DELEGATION_STORAGE_RECORD_LIMIT,
} from '@canopy/protocol/delegation/discovery';
import {
  type AgentDelegationTranscriptItem,
  type AgentDelegationTranscript,
  type AgentDelegationSnapshot,
  DELEGATION_APPLY_FAILURE_LIMITS,
  DELEGATION_APPLY_FAILURE_REASONS,
  DELEGATION_APPLY_ISSUE_REASONS,
  DELEGATION_CAPABILITY_SKIP_REASONS,
  DELEGATION_STOP_REASONS,
  isDelegationCapabilitySummary,
  isAgentDelegationTranscript,
  isAgentDelegationTranscriptItem,
  parseAgentDelegationSpawnRequest,
} from '@canopy/protocol/delegation';
import {
  delegationContentVersion,
  type DelegationStorage,
  type StoredDelegation,
} from './broker';
import { DELEGATION_APPLY_FILE_BOUND } from './apply-limits';
import {
  DELEGATION_CAPABILITY_GRANT_LIMITS,
  isDelegationCapabilityId,
  type DelegationCapabilityGrant,
} from './capability-grant';
import {
  decodeManagedMessageReceiptV2,
  encodeManagedMessageReceiptV2,
  isVersionedManagedMessageReceipt,
  type ManagedMessageReceiptV2,
} from './managed-message-receipt-v2';
import type { StoredManagedDelegationMessageResult } from '@canopy/core-runtime/node/chat/delegation/managed-message-receipt-v2';
export type { StoredManagedDelegationMessageResult } from '@canopy/core-runtime/node/chat/delegation/managed-message-receipt-v2';
import { assertPrivateDirectoryAcl, renameWithRetry } from './private-storage';
import {
  decodeStoredDelegationV3,
  encodeStoredDelegationV3,
} from './record-v3';
import { DelegationReadMetadataError } from './record-read-metadata';
import { isTerminalDelegationSummary } from './terminal-summary';

export const DELEGATION_STORAGE_RECORD_MAX_BYTES = 32 * 1024 * 1024;
const DELEGATION_STORAGE_TEXT_MAX_CHARACTERS = 16 * 1024 * 1024;
const DELEGATION_STORAGE_TRANSCRIPT_MAX_ITEMS = 65_536;

export type PrivateDelegationCommitOutcome =
  | { readonly outcome: 'written' }
  | { readonly outcome: 'not_written'; readonly error: unknown }
  | { readonly outcome: 'uncertain'; readonly error: unknown };

const label = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\0\r\n]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const capabilityId = z.custom<string>(isDelegationCapabilityId);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const thinking = z.enum(THINKING_LEVELS);
const terminal = z.enum([
  'completed',
  'failed',
  'cancelled',
  'deadline_exceeded',
]);
const settled = z.enum([
  'completed',
  'failed',
  'cancelled',
  'deadline_exceeded',
  'interrupted',
]);
const error = z.strictObject({
  code: z.enum([
    'invalid_request',
    'capability_unavailable',
    'route_unavailable',
    'auth_required',
    'interaction_required',
    'policy_blocked',
    'capacity_exceeded',
    'parent_unavailable',
    'launch_uncertain',
    'runtime_error',
    'terminated_by_parent',
  ]),
  message: z.string().max(4096),
  retryable: z.boolean(),
});
const channel = z.enum(['foreground', 'background']);
const stopReason = z.enum(DELEGATION_STOP_REASONS);
const stoppedBy = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({
    kind: z.literal('agent'),
    depth: z.number().int().min(0).max(9),
    delegationId: label.optional(),
    description: z.string().min(1).max(200).optional(),
  }),
]);
export const delegationMessageAuthorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({
    kind: z.literal('agent'),
    depth: z.number().int().min(0).max(9),
    delegationId: label.optional(),
    description: z.string().min(1).max(200).optional(),
  }),
]);
const delivery = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unclaimed') }),
  z.strictObject({ status: z.literal('queued'), channel }),
  z.strictObject({ status: z.literal('dispatching'), channel }),
  z.strictObject({ status: z.literal('uncertain'), channel }),
  z.strictObject({
    status: z.literal('acknowledged'),
    channel,
    receiptId: label,
  }),
  z.strictObject({
    status: z.literal('suppressed'),
    reason: z.enum([
      'parent_gone',
      'user_cancelled',
      'automatic_delivery_removed',
    ]),
  }),
]);
const relativePath = z.string().min(1).max(4095);
/** Earlier versions kept apply content inline, at most 64 KiB per image. */
const legacyFileContent = z.string().max(65536).nullable();

function isJsonData(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  // The storage serializer intentionally omits undefined object members.
  if (value === undefined) return true;
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((item) => isJsonData(item, depth + 1));
  if (typeof value !== 'object') return false;
  return Object.getPrototypeOf(value) === Object.prototype
    ? Object.values(value).every((item) => isJsonData(item, depth + 1))
    : false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStoredSnapshot(
  value: unknown,
): value is AgentDelegationSnapshot {
  if (!isRecord(value) || !isJsonData(value)) return false;
  const snapshot = value;
  if (
    typeof snapshot.delegationId !== 'string' ||
    typeof snapshot.status !== 'string' ||
    ![
      'pending',
      'running',
      'interrupted',
      'completed',
      'failed',
      'cancelled',
      'deadline_exceeded',
    ].includes(snapshot.status)
  )
    return false;
  try {
    return (
      Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') <=
      DELEGATION_STORAGE_RECORD_MAX_BYTES
    );
  } catch {
    return false;
  }
}

/** A file change earlier versions retained with each run, as full text. */
const legacyFileChanges = z.array(
  z.looseObject({
    id: z.string(),
    path: z.string(),
    after: z.string().nullable(),
  }),
);
type LegacyFileChange = z.output<typeof legacyFileChanges>[number];

/**
 * Earlier versions retained each run's file changes as full text and recorded
 * applies by change id. The text is never written now, but records that still
 * carry it must load: the last applied version of each file becomes its
 * applied-file receipt, then the text and ids are dropped, in the current
 * state and in every retained run.
 */
function migrateRetainedFileChanges(
  record: z.output<typeof storedRecord>,
): StoredDelegation {
  const { appliedChangeIds, ...rest } = record;
  const { fileChanges, ...state } = record.state;
  const applied = new Set(appliedChangeIds ?? []);
  const versions = new Map<string, string>();
  const receive = (changes: readonly LegacyFileChange[]): void => {
    for (const change of changes)
      if (applied.has(change.id))
        versions.set(change.path, delegationContentVersion(change.after));
  };
  const history = record.history?.map((transcript) => {
    const legacy = legacyFileChanges.safeParse(
      Reflect.get(transcript.snapshot, 'fileChanges'),
    );
    if (legacy.success) receive(legacy.data);
    const snapshot = { ...transcript.snapshot };
    Reflect.deleteProperty(snapshot, 'fileChanges');
    return { ...transcript, snapshot };
  });
  receive(fileChanges ?? []);
  return {
    ...rest,
    state,
    ...(history ? { history } : {}),
    ...(!record.appliedFiles && versions.size
      ? {
          appliedFiles: Array.from(versions, ([file, delegate]) => ({
            path: file,
            delegate,
          })),
        }
      : {}),
  };
}
const applyFailure = z.strictObject({
  reason: z.enum(DELEGATION_APPLY_FAILURE_REASONS),
  issues: z
    .array(
      z.strictObject({
        path: relativePath,
        reason: z.enum(DELEGATION_APPLY_ISSUE_REASONS),
        parentDiff: z
          .string()
          .max(DELEGATION_APPLY_FAILURE_LIMITS.diffBytes)
          .optional(),
        parentDiffTruncated: z.boolean().optional(),
      }),
    )
    .max(DELEGATION_APPLY_FAILURE_LIMITS.issues),
  omittedIssues: counter.optional(),
  guidance: z.string().max(DELEGATION_APPLY_FAILURE_LIMITS.guidanceCharacters),
});
export const delegationControlSchema = z.strictObject({
  operationId: z.uuid(),
  key: hash,
  requestHash: hash,
  occurredAt: counter.optional(),
  operation: z.enum([
    'follow_up',
    'resume',
    'steer',
    'interrupt',
    'apply',
    'discard',
  ]),
  message: z.string().max(32768).optional(),
  permissions: z
    .strictObject({ writePaths: z.array(z.string().min(1).max(4095)).max(64) })
    .optional(),
  status: z.enum(['accepted', 'completed', 'failed']),
  sender: delegationMessageAuthorSchema.optional(),
  firstOutcome: z.custom<AgentDelegationSnapshot>(isStoredSnapshot).optional(),
  firstError: error.optional(),
  steeringDelivery: z
    .discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('accepted'),
        attemptId: label,
        providerTurnId: label.optional(),
      }),
      z.strictObject({
        kind: z.enum(['rejected', 'unknown']),
        attemptId: label,
        reason: z.string().max(4096),
        fallback: z.literal('ordinary').optional(),
      }),
    ])
    .optional(),
  error: z.string().max(512).optional(),
  applyFailure: applyFailure.optional(),
});
export const delegationHistorySchema = z
  .array(z.custom<AgentDelegationTranscript>(isAgentDelegationTranscript))
  .max(16);
export const delegationResultsSchema = z
  .array(
    z.strictObject({
      resultIndex: counter.positive(),
      runGeneration: counter.positive(),
      status: settled,
      settledAt: counter,
      finalText: z
        .string()
        .max(DELEGATION_STORAGE_TEXT_MAX_CHARACTERS)
        .optional(),
      partialText: z
        .string()
        .max(DELEGATION_STORAGE_TEXT_MAX_CHARACTERS)
        .optional(),
      outputTruncated: z.boolean(),
      error: error.optional(),
      usage: z
        .strictObject({
          inputTokens: counter.optional(),
          outputTokens: counter.optional(),
          cachedInputTokens: counter.optional(),
          cacheCreationInputTokens: counter.optional(),
          costUsd: z.number().nonnegative().finite().optional(),
        })
        .optional(),
      stopReason: stopReason.optional(),
    }),
  )
  .max(17)
  .refine(
    (results) =>
      results.every((result, index) => {
        const previous = results[index - 1];
        return (
          result.resultIndex === index + 1 &&
          (previous === undefined ||
            result.runGeneration > previous.runGeneration)
        );
      }),
    'Delegation results must have stable ordered indices',
  );
const stopRequest = z.strictObject({
  operationId: z.uuid(),
  key: hash.optional(),
  runGeneration: counter.positive().optional(),
  status: z.enum(['accepted', 'completed', 'failed']),
});
const userMessageReceipt = z.strictObject({
  operationId: z.uuid(),
  key: hash,
  requestHash: hash,
  delegationId: label,
  operation: z.enum(['follow_up', 'steer', 'interrupt']),
  error,
});
const capabilityGrant = z.strictObject({
  inherit: z.boolean(),
  explicit: z
    .array(capabilityId)
    .max(DELEGATION_CAPABILITY_GRANT_LIMITS.explicit),
  discovery: z.boolean(),
  loaded: z.array(capabilityId).max(DELEGATION_CAPABILITY_GRANT_LIMITS.loaded),
  skipped: z
    .array(
      z.strictObject({
        id: capabilityId,
        reason: z.enum(DELEGATION_CAPABILITY_SKIP_REASONS),
      }),
    )
    .max(DELEGATION_CAPABILITY_GRANT_LIMITS.skipped),
  overlayHash: hash,
  summary: z.custom<DelegationCapabilityGrant['summary']>(
    isDelegationCapabilitySummary,
  ),
});
const storedRecord = z
  .strictObject({
    version: z.union([z.literal(1), z.literal(2)]),
    transcriptRevision: counter.optional(),
    notificationOnly: z.boolean().optional(),
    deliveryId: z.uuid().optional(),
    resumeSessionId: label.optional(),
    history: delegationHistorySchema.optional(),
    results: delegationResultsSchema.optional(),
    control: delegationControlSchema.optional(),
    controls: z.array(delegationControlSchema).max(64).optional(),
    userMessageReceipts: z.array(userMessageReceipt).optional(),
    spawnIdentity: z.strictObject({ key: hash, hash }).optional(),
    workspaceDiscarded: z.boolean().optional(),
    authorityRevoked: z.boolean().optional(),
    interruptedGeneration: counter.optional(),
    stopRequested: stopRequest.optional(),
    stopRequests: z.array(stopRequest).max(64).optional(),
    // Legacy: read and migrated; see migrateRetainedFileChanges.
    appliedChangeIds: z.array(z.uuid()).optional(),
    appliedFiles: z
      .array(z.strictObject({ path: relativePath, delegate: hash }))
      .max(DELEGATION_APPLY_FILE_BOUND)
      .optional(),
    applyJournal: z
      .strictObject({
        operationId: z.uuid(),
        root: z.string().min(1).max(4096),
        store: z.string().min(1).max(4096).optional(),
        files: z
          .array(
            z.union([
              z.strictObject({
                path: relativePath,
                beforeBlob: hash.nullable(),
                afterBlob: hash.nullable(),
              }),
              z.strictObject({
                path: relativePath,
                before: legacyFileContent,
                after: legacyFileContent,
              }),
            ]),
          )
          .max(DELEGATION_APPLY_FILE_BOUND),
      })
      .optional(),
    applyLeases: z
      .array(
        z.strictObject({ path: relativePath, parent: hash, delegate: hash }),
      )
      .max(DELEGATION_APPLY_FILE_BOUND)
      .optional(),
    executionCwd: z.string().min(1).max(4096).optional(),
    inheritedCwd: z.string().min(1).max(4096).optional(),
    isolationBaseCwd: z.string().min(1).max(4096).optional(),
    isolationRevision: z.string().max(64).optional(),
    isolationReady: z.boolean().optional(),
    workspaceObservation: z
      .strictObject({
        consistency: z.literal('live_shared_worktree'),
        headRevision: z
          .string()
          .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
          .nullable(),
        dirty: z.boolean().nullable(),
        observedAt: counter,
      })
      .optional(),
    depth: z.number().int().min(1).max(10).optional(),
    parentDelegationId: label.optional(),
    parentRunGeneration: counter.positive().optional(),
    parentDescription: z.string().min(1).max(200).optional(),
    parent: z.strictObject({
      harnessId: label,
      projectId: label,
      worktreeId: label,
      chatId: label,
      sessionKey: label,
      turnId: label,
      userMessageId: label.optional(),
      toolCallId: label,
      runtimeGeneration: counter.positive(),
      depth: z.number().int().min(0).max(9),
      parentDelegationId: label.optional(),
      parentRunGeneration: counter.positive().optional(),
      parentDescription: z.string().min(1).max(200).optional(),
    }),
    task: z.unknown().transform((input, context) => {
      const parsed = parseAgentDelegationSpawnRequest(input);
      if (parsed.ok) return parsed.value;
      context.addIssue({
        code: 'custom',
        message: 'Invalid retained delegation task',
      });
      return z.NEVER;
    }),
    route: z
      .strictObject({
        selectedModelId: label,
        selectedModelLabel: label.optional(),
        runtimeModelLabel: label.optional(),
        runtimeModelId: label,
        harnessId: label,
        runtimeKind: label,
        runnerRegistrationId: label,
        runtimeVersion: label,
        adapterVersion: label,
        modelSource: label,
        providerType: label,
        assignmentRevision: label,
        routeId: label.optional(),
        billingAuthority: label,
        aiCreditsRouted: z.boolean(),
        requestedThinkingLevel: thinking.optional(),
        effectiveThinkingLevel: thinking.optional(),
        capabilities: z.array(label).max(64),
        supportedThinkingLevels: z.array(thinking).max(7),
        capabilitySnapshotHash: label,
        capabilityGeneration: counter.positive(),
        policyRevision: label,
        authAccountKey: label.optional(),
        agentOverlay: z
          .strictObject({
            agentDefinitionId: label,
            agentDefinitionRevision: label,
            agentDefinitionHash: hash,
            pluginProjectionHash: hash,
            systemPromptAppend: z.string().max(1_048_576).optional(),
            artifact: z.strictObject({
              artifactId: hash,
              formatVersion: z.union([z.literal(1), z.literal(2)]),
              manifestHash: hash,
            }),
          })
          .optional(),
        capabilityOverlay: z
          .strictObject({
            capabilityProjectionHash: hash,
            artifact: z.strictObject({
              artifactId: hash,
              formatVersion: z.literal(3),
              manifestHash: hash,
            }),
          })
          .optional(),
      })
      .optional(),
    capabilityGrant: capabilityGrant.optional(),
    admission: z
      .strictObject({
        runGeneration: counter.positive(),
        state: z.enum(['waiting', 'granted']),
        queuedAt: counter,
        grantedAt: counter.optional(),
      })
      .optional(),
    callKey: hash,
    requestHash: hash,
    createdAt: counter,
    deadlineAt: counter.optional(),
    state: z.strictObject({
      delegationId: z.uuid(),
      runGeneration: counter.positive(),
      sequence: counter,
      status: z.enum([
        'pending',
        'running',
        'interrupted',
        ...terminal.options,
      ]),
      nativeSessionId: label.optional(),
      startedAt: counter.optional(),
      finishedAt: counter.optional(),
      transcript: z
        .array(
          z.custom<AgentDelegationTranscriptItem>(
            isAgentDelegationTranscriptItem,
          ),
        )
        .max(DELEGATION_STORAGE_TRANSCRIPT_MAX_ITEMS)
        .optional(),
      partialText: z
        .string()
        .max(DELEGATION_STORAGE_TEXT_MAX_CHARACTERS)
        .optional(),
      finalText: z
        .string()
        .max(DELEGATION_STORAGE_TEXT_MAX_CHARACTERS)
        .optional(),
      error: error.optional(),
      outputTruncated: z.boolean(),
      approvalPending: z.boolean().optional(),
      // Legacy: read and migrated; see migrateRetainedFileChanges.
      fileChanges: legacyFileChanges.max(64).optional(),
      stopReason: stopReason.optional(),
      cancelledByUser: z.boolean().optional(),
      stoppedBy: stoppedBy.optional(),
      usage: z
        .strictObject({
          inputTokens: counter.optional(),
          outputTokens: counter.optional(),
          cachedInputTokens: counter.optional(),
          cacheCreationInputTokens: counter.optional(),
          costUsd: z.number().nonnegative().finite().optional(),
        })
        .optional(),
    }),
    launch: z.strictObject({
      version: z.literal(1),
      delegationId: z.uuid(),
      launchKey: hash,
      runGeneration: counter.positive(),
      phase: z.enum([
        'reserved',
        'starting',
        'identified',
        'interrupted',
        'settled',
      ]),
      nativeSessionId: label.optional(),
      terminalStatus: terminal.optional(),
    }),
    delivery,
  })
  .refine(
    (record) =>
      record.state.delegationId === record.launch.delegationId &&
      record.state.runGeneration === record.launch.runGeneration &&
      record.callKey === record.launch.launchKey &&
      (record.route === undefined ||
        record.task.modelId === record.route.selectedModelId) &&
      (record.deadlineAt === undefined ||
        record.deadlineAt > record.createdAt) &&
      (record.launch.phase === 'settled') ===
        (record.launch.terminalStatus !== undefined) &&
      (record.state.stopReason === undefined
        ? record.state.cancelledByUser === undefined
        : record.state.cancelledByUser ===
          (record.state.stopReason === 'user_cancelled')) &&
      (record.state.stopReason !== 'deadline_exceeded' ||
        record.state.status === 'deadline_exceeded') &&
      (record.state.stopReason === undefined ||
        record.state.stopReason === 'deadline_exceeded' ||
        record.state.status === 'cancelled') &&
      // Only user and agent stops are attributed, each to its own kind.
      (record.state.stoppedBy === undefined ||
        record.state.stopReason === 'ancestor_stopped' ||
        record.state.stopReason ===
          (record.state.stoppedBy.kind === 'user'
            ? 'user_cancelled'
            : 'stopped_by_parent')),
    'Inconsistent delegation identity',
  );
const stored = storedRecord.transform(migrateRetainedFileChanges);

export interface StoredManagedDelegationMessageReceiptV1 {
  readonly operationId: string;
  readonly requestHash: string;
  readonly status: 'pending' | 'complete';
  readonly result?: StoredManagedDelegationMessageResult;
}

export type StoredManagedDelegationMessageReceipt =
  | StoredManagedDelegationMessageReceiptV1
  | ManagedMessageReceiptV2;

const managedMessageResult = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    snapshot: z.custom<AgentDelegationSnapshot>(isStoredSnapshot),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum([
      'parent_unavailable',
      'busy',
      'not_found',
      'discarded',
      'invalid_request',
      'failed',
    ]),
    error: z.string().max(4096),
  }),
]);
const managedMessageReceiptV1 = z.discriminatedUnion('status', [
  z.strictObject({
    operationId: z.uuid(),
    requestHash: hash,
    status: z.literal('pending'),
  }),
  z.strictObject({
    operationId: z.uuid(),
    requestHash: hash,
    status: z.literal('complete'),
    result: managedMessageResult,
  }),
]);

const managedMessageReceiptName = (operationId: string): string => {
  const digest = createHash('sha256').update(operationId).digest('hex');
  return `${digest}.json`;
};

/** One private record file's validated name and bytes. */
export class PrivateDelegationRecordFile {
  constructor(
    readonly name: string,
    readonly bytes: Buffer,
  ) {
    if (!/^[A-Za-z0-9_-]{1,128}\.json$/.test(name))
      throw new Error('Invalid delegation record name');
  }
}

// A record that doesn't parse, or is filed under another delegation's name, is
// skipped rather than failing the whole load.
const storedDelegationRecord = (
  text: string,
  name: string,
): StoredDelegation | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    Reflect.get(value, 'version') === 3
  ) {
    let record: StoredDelegation;
    try {
      record = decodeStoredDelegationV3(value);
    } catch (error) {
      if (error instanceof DelegationReadMetadataError) return undefined;
      throw error;
    }
    return name === `${record.state.delegationId}.json` ? record : undefined;
  }
  const parsed = stored.safeParse(value);
  if (!parsed.success) return undefined;
  const record = parsed.data;
  return name === `${record.state.delegationId}.json` ? record : undefined;
};

/** A point read treats invalid retained data as an error, never as absence. */
function storedDelegationRecordStrict(
  text: string,
  name: string,
): StoredDelegation {
  const record = storedDelegationRecord(text, name);
  if (record === undefined)
    throw new Error('Invalid retained delegation record');
  return record;
}

function storedDelegationFile(
  record: StoredDelegation,
): PrivateDelegationRecordFile {
  if (record.version === 3)
    return new PrivateDelegationRecordFile(
      `${record.state.delegationId}.json`,
      Buffer.from(
        encodeStoredDelegationV3(
          decodeStoredDelegationV3(JSON.parse(JSON.stringify(record))),
        ),
        'utf8',
      ),
    );
  // Validate the exact JSON representation persisted on disk. Some trusted
  // host projections contain frozen objects from another JS realm; they are
  // plain data once serialized, and records are always reloaded as JSON.
  // Parsing the normalized representation also ensures the strict schema
  // rejects any durable field that it does not explicitly recognize.
  const serialized = JSON.stringify(record);
  if (typeof serialized !== 'string')
    throw new Error('Invalid delegation record');
  const normalized: unknown = JSON.parse(serialized);
  const checked = stored.parse(normalized);
  return new PrivateDelegationRecordFile(
    `${checked.state.delegationId}.json`,
    Buffer.from(JSON.stringify(checked), 'utf8'),
  );
}

/** Private local records only. Loaded records grant no execution or delivery authority. */
export class FileDelegationStorage implements DelegationStorage {
  constructor(
    private readonly directory: string,
    private readonly options: { readonly create?: boolean } = {},
  ) {
    if (!path.isAbsolute(directory))
      throw new Error('Delegation storage must be absolute');
  }

  /** Observation only: never creates directories, repairs or skips corrupt identities. */
  async loadReadOnly(): Promise<{
    readonly records: readonly StoredDelegation[];
    readonly missing: boolean;
  }> {
    if (!(await this.validateDirectoryReadOnly()))
      return { records: [], missing: true };
    const records: StoredDelegation[] = [];
    const directory = await fs.opendir(this.directory);
    let entries = 0;
    for await (const entry of directory) {
      if (++entries > DELEGATION_STORAGE_ENTRY_LIMIT)
        throw new Error('Delegation storage exceeds its entry bound');
      if (!entry.name.endsWith('.json')) continue;
      if (!entry.isFile()) throw new Error('Invalid delegation storage entry');
      const record = await this.read(entry.name, storedDelegationRecord);
      if (!record) throw new Error('Invalid retained delegation record');
      records.push(record);
      if (records.length > DELEGATION_STORAGE_RECORD_LIMIT)
        throw new Error('Delegation storage exceeds its record bound');
    }
    return { records, missing: false };
  }

  /** Same private-directory checks as preparation, without its mkdir. */
  validateDirectoryReadOnly(): Promise<boolean> {
    return this.prepareDirectory({ create: false });
  }

  async load(): Promise<readonly StoredDelegation[]> {
    await this.prepareDirectory();
    const records: StoredDelegation[] = [];
    const directory = await fs.opendir(this.directory);
    let entries = 0;
    for await (const entry of directory) {
      if (++entries > DELEGATION_STORAGE_ENTRY_LIMIT)
        throw new Error('Delegation storage exceeds its entry bound');
      if (!entry.name.endsWith('.json')) continue;
      if (!entry.isFile()) throw new Error('Invalid delegation storage entry');
      const record = await this.read(entry.name, storedDelegationRecord);
      if (!record) continue;
      records.push(record);
      if (records.length > DELEGATION_STORAGE_RECORD_LIMIT)
        throw new Error('Delegation storage exceeds its record bound');
    }
    // Directory order differs by filesystem; recovery and readers need one order.
    return records.sort((left, right) =>
      left.state.delegationId < right.state.delegationId
        ? -1
        : left.state.delegationId > right.state.delegationId
          ? 1
          : 0,
    );
  }

  /** One delegation's record, without loading the others. */
  async loadOne(delegationId: string): Promise<StoredDelegation | undefined> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(delegationId))
      throw new Error('Invalid delegation record name');
    if (!(await this.prepareDirectory({ create: false }))) return undefined;
    let record: StoredDelegation | undefined;
    try {
      record = await this.read(
        `${delegationId}.json`,
        storedDelegationRecordStrict,
      );
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return undefined;
      throw error;
    }
    if (record === undefined)
      throw new Error('Invalid retained delegation record');
    // Observation-only callers need the decoded durable shape unchanged.
    // Broker hydration performs normalization before its revision fence.
    return record;
  }

  /**
   * Parses one private record file. It must be a regular, singly linked file
   * within the record byte bound, private to this user.
   */
  async read<T>(
    name: string,
    parse: (text: string, name: string) => T | undefined,
  ): Promise<T | undefined> {
    for (let attempt = 1; ; attempt += 1) {
      const handle = await fs.open(
        path.join(this.directory, name),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const stat = await handle.stat();
        // A commit renamed a new file over the one just opened: reopen it.
        if (stat.nlink === 0) {
          if (attempt < 3) continue;
          throw new Error('Delegation record changed while reading');
        }
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size > DELEGATION_STORAGE_RECORD_MAX_BYTES ||
          (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
        )
          throw new Error('Invalid private delegation record');
        const bytes = Buffer.alloc(stat.size + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== stat.size)
          throw new Error('Delegation record changed while reading');
        return parse(bytes.subarray(0, bytesRead).toString('utf8'), name);
      } finally {
        await handle.close();
      }
    }
  }

  /** Writes a delegation record, or another private record file, atomically. */
  async commit(
    record: StoredDelegation | PrivateDelegationRecordFile,
    progress?: { replaced: boolean },
  ): Promise<void> {
    if (
      !(record instanceof PrivateDelegationRecordFile) &&
      isTerminalDelegationSummary(record)
    )
      throw new Error(
        'Terminal delegation summaries cannot be committed as records',
      );
    const { name, bytes } =
      record instanceof PrivateDelegationRecordFile
        ? record
        : storedDelegationFile(record);
    if (bytes.byteLength > DELEGATION_STORAGE_RECORD_MAX_BYTES)
      throw new Error('Delegation record exceeds its byte bound');
    const directoryReady = await this.prepareDirectory({
      create: this.options.create ?? true,
    });
    if (!directoryReady)
      throw new Error('Delegation storage directory is missing');
    const temporary = path.join(this.directory, `${randomUUID()}.pending`);
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await renameWithRetry(temporary, path.join(this.directory, name));
      if (progress) progress.replaced = true;
      if (process.platform !== 'win32') {
        const directory = await fs.open(this.directory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  /** Writes one private file and reports whether replacement is confirmed. */
  async commitWithOutcome(
    record: StoredDelegation | PrivateDelegationRecordFile,
  ): Promise<PrivateDelegationCommitOutcome> {
    // A failure after the rename (directory sync, close or cleanup) may have
    // replaced the file; one before it leaves the old file in place.
    const progress = { replaced: false };
    try {
      await this.commit(record, progress);
      return { outcome: 'written' };
    } catch (error) {
      return progress.replaced
        ? { outcome: 'uncertain', error }
        : { outcome: 'not_written', error };
    }
  }

  /** Resolves false only when `create` is off and the directory is missing. */
  async prepareDirectory({ create = true } = {}): Promise<boolean> {
    if (create)
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    let stat: Stats;
    try {
      stat = await fs.lstat(this.directory);
    } catch (error) {
      if (
        !create &&
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return false;
      throw error;
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    )
      throw new Error('Delegation storage directory is not private');
    await assertPrivateDirectoryAcl(this.directory);
    return true;
  }
}

/** Durable operation receipts for service outcomes before/after an actor exists. */
export class FileManagedDelegationMessageStorage {
  // Receipts are private record files with the delegation records' checks.
  private readonly files: FileDelegationStorage;

  constructor(directory: string) {
    this.files = new FileDelegationStorage(directory);
  }

  async load(
    operationId: string,
  ): Promise<StoredManagedDelegationMessageReceipt | undefined> {
    const parsedId = z.uuid().safeParse(operationId);
    if (!parsedId.success) return undefined;
    await this.files.prepareDirectory();
    try {
      return await this.files.read(
        managedMessageReceiptName(operationId),
        (text, name) => {
          let value: unknown;
          try {
            value = JSON.parse(text);
          } catch {
            throw new Error('Invalid private delegation message receipt');
          }
          const receipt = isVersionedManagedMessageReceipt(value)
            ? decodeManagedMessageReceiptV2(value)
            : managedMessageReceiptV1.parse(value);
          if (
            name !== managedMessageReceiptName(receipt.operationId) ||
            receipt.operationId !== operationId
          )
            throw new Error('Invalid private delegation message receipt');
          return receipt;
        },
      );
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return undefined;
      throw error;
    }
  }

  async commit(receipt: StoredManagedDelegationMessageReceipt): Promise<void> {
    const encoded =
      'version' in receipt
        ? encodeManagedMessageReceiptV2(receipt)
        : JSON.stringify(managedMessageReceiptV1.parse(receipt));
    await this.files.commit(
      new PrivateDelegationRecordFile(
        managedMessageReceiptName(receipt.operationId),
        Buffer.from(encoded, 'utf8'),
      ),
    );
  }
}
