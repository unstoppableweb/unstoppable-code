import {
  mkdir,
  readFile,
  readdir,
  rm,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  damagedCopiesOf,
  pruneDamagedCopies,
} from '@canopy/execution-engine/node/lib/damaged-copies';
import { writeFileAtomically } from '../lib/atomic-file';
import {
  COST_BILLING_BASES,
  COST_HELPER_KINDS,
  COST_SOURCES,
  type CostBillingBasis,
  type CostTotals,
} from '@canopy/protocol/cost-view';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import type {
  CostChatAggregate,
  CostChatFile,
  CostIndexCheckpoint,
  CostInternalTrigger,
  CostSummaryFile,
  CostTurnRecord,
  CostUnattachedFile,
} from './types';

export interface PersistedRead<T> {
  readonly value: T | null;
  readonly corrupt: boolean;
}

let temporaryFileSequence = 0;
let corruptFileSequence = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonnegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function isTokenTotals(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonnegativeFinite(value.input) &&
    isNonnegativeFinite(value.output) &&
    isNonnegativeFinite(value.cacheReadInputTokens) &&
    isNonnegativeFinite(value.cacheCreationInputTokens) &&
    isNonnegativeFinite(value.reasoningOutputTokens)
  );
}

/** Preserve unsplit usage without accepting malformed optional token counts. */
function hasValidTotalTokens(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.totalTokens === undefined || isNonnegativeFinite(value.totalTokens))
  );
}

/**
 * Billing bases added after version 1 files were first written. A file from
 * an earlier release has no total for them, which means nothing was billed
 * there; reading it as corrupt would throw the user's cost history aside.
 */
const BILLING_BASES_ADDED_AFTER_V1: readonly CostBillingBasis[] = [
  'account_proxy',
];

function isCostTotals(value: unknown): value is CostTotals {
  if (
    !isRecord(value) ||
    !isRecord(value.bySource) ||
    !isRecord(value.byBilling)
  ) {
    return false;
  }
  const bySource = value.bySource;
  const byBilling = value.byBilling;
  for (const basis of BILLING_BASES_ADDED_AFTER_V1) {
    if (byBilling[basis] === undefined) byBilling[basis] = 0;
  }
  return (
    isNonnegativeFinite(value.usd) &&
    COST_SOURCES.every((source) => isNonnegativeFinite(bySource[source])) &&
    COST_BILLING_BASES.every((basis) =>
      isNonnegativeFinite(byBilling[basis]),
    ) &&
    isTokenTotals(value.tokens) &&
    isNonnegativeFinite(value.notPricedCount) &&
    typeof value.hasEstimate === 'boolean'
  );
}

// Typed as a full record so a new provider must be listed before it compiles.
const PERSISTED_PROVIDERS: Readonly<Record<AgentProviderType, true>> = {
  claude: true,
  codex: true,
  ollama: true,
  cursor: true,
  opencode: true,
  copilot: true,
  antigravity: true,
};

function isPersistedProvider(value: unknown): value is AgentProviderType {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PERSISTED_PROVIDERS, value)
  );
}

function isRecordAccountProxy(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      isString(value.connectionId) &&
      Array.isArray(value.accounts) &&
      value.accounts.every(
        (account) =>
          isRecord(account) &&
          isString(account.authIndex) &&
          isOptionalString(account.provider) &&
          isNonnegativeFinite(account.requests),
      ))
  );
}

function isCostProxyAccountRow(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.accountKey) &&
    isString(value.label) &&
    isOptionalString(value.provider) &&
    isNonnegativeFinite(value.turnShare) &&
    isNonnegativeFinite(value.requestCount) &&
    isNonnegativeFinite(value.usd) &&
    isNonnegativeFinite(value.notPricedCount)
  );
}

function isOptionalProxyAccountRows(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every(isCostProxyAccountRow))
  );
}

function isCostTurnRecord(value: unknown): value is CostTurnRecord {
  if (!isRecord(value) || !isRecord(value.tokens)) return false;
  const isSource =
    value.source === 'chat' ||
    value.source === 'pipeline' ||
    value.source === 'background' ||
    value.source === 'delegation';
  const isStatus =
    value.status === 'running' ||
    value.status === 'success' ||
    value.status === 'failure' ||
    value.status === 'cancelled' ||
    value.status === 'interrupted';
  const isProvider = isPersistedProvider(value.provider);
  const isCostStatus =
    value.costStatus === 'reported' ||
    value.costStatus === 'estimated' ||
    value.costStatus === 'partial' ||
    value.costStatus === 'not_priced';
  const isPipeline =
    value.pipeline === undefined ||
    (isRecord(value.pipeline) &&
      isString(value.pipeline.rootExecutionId) &&
      isString(value.pipeline.executionId) &&
      isOptionalString(value.pipeline.pipelineName) &&
      isOptionalString(value.pipeline.jobId) &&
      isOptionalString(value.pipeline.stepId) &&
      (value.pipeline.attempt === undefined ||
        isNonnegativeFinite(value.pipeline.attempt)));
  const isToolCounts =
    value.toolCounts === undefined ||
    (isRecord(value.toolCounts) &&
      Object.values(value.toolCounts).every((count) =>
        isNonnegativeFinite(count),
      ));
  const isAttributedItems =
    (value.subagents === undefined ||
      (Array.isArray(value.subagents) &&
        value.subagents.every(hasValidTotalTokens))) &&
    (value.delegation === undefined || hasValidTotalTokens(value.delegation));
  const isContext =
    value.context === undefined ||
    (isRecord(value.context) &&
      isNonnegativeFinite(value.context.endTokens) &&
      isNonnegativeFinite(value.context.windowTokens) &&
      (value.context.peakTokens === undefined ||
        isNonnegativeFinite(value.context.peakTokens)));
  const isCompactions =
    value.compactions === undefined ||
    (Array.isArray(value.compactions) &&
      value.compactions.every(
        (compaction) =>
          isRecord(compaction) &&
          isString(compaction.at) &&
          (compaction.trigger === 'auto' ||
            compaction.trigger === 'manual' ||
            compaction.trigger === 'unknown'),
      ));

  return (
    isString(value.entryId) &&
    isString(value.day) &&
    isString(value.startedAt) &&
    isOptionalString(value.completedAt) &&
    isStatus &&
    isSource &&
    isOptionalString(value.chatId) &&
    (value.helperKind === undefined ||
      COST_HELPER_KINDS.some((kind) => kind === value.helperKind)) &&
    isPipeline &&
    isProvider &&
    isOptionalString(value.model) &&
    isOptionalString(value.agentId) &&
    isOptionalString(value.harness) &&
    COST_BILLING_BASES.some((basis) => basis === value.billingBasis) &&
    isTokenTotals(value.tokens) &&
    (value.costUsd === undefined || isNonnegativeFinite(value.costUsd)) &&
    isCostStatus &&
    (value.durationMs === undefined || isNonnegativeFinite(value.durationMs)) &&
    isToolCounts &&
    (value.subagentCount === undefined ||
      isNonnegativeFinite(value.subagentCount)) &&
    (value.toolUseCount === undefined ||
      isNonnegativeFinite(value.toolUseCount)) &&
    isAttributedItems &&
    isContext &&
    isCompactions &&
    (value.planEvents === undefined ||
      (isRecord(value.planEvents) &&
        isNonnegativeFinite(value.planEvents.created) &&
        isNonnegativeFinite(value.planEvents.approved))) &&
    isRecordAccountProxy(value.accountProxy)
  );
}

function isCostModelRow(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.model) &&
    isNonnegativeFinite(value.turnCount) &&
    isNonnegativeFinite(value.usd) &&
    isNonnegativeFinite(value.notPricedCount) &&
    isTokenTotals(value.tokens)
  );
}

function isCostChatAggregate(value: unknown): value is CostChatAggregate {
  if (
    !isRecord(value) ||
    !isRecord(value.bySource) ||
    !isRecord(value.bySource.chat) ||
    !isRecord(value.bySource.subagents) ||
    !isRecord(value.bySource.delegations) ||
    !isRecord(value.bySource.background) ||
    !isRecord(value.context) ||
    !isRecord(value.compactions) ||
    !isRecord(value.activity)
  )
    return false;
  const bySource = value.bySource;
  const chatSource = bySource.chat;
  const subagentSource = bySource.subagents;
  const delegationSource = bySource.delegations;
  const backgroundSource = bySource.background;
  if (
    !isRecord(chatSource) ||
    !isRecord(subagentSource) ||
    !isRecord(delegationSource) ||
    !isRecord(backgroundSource)
  )
    return false;
  const context = value.context;
  const compactions = value.compactions;
  const activity = value.activity;
  return (
    isCostTotals(value.totals) &&
    isNonnegativeFinite(value.turnCount) &&
    isOptionalString(value.firstActivityAt) &&
    isOptionalString(value.lastActivityAt) &&
    isOptionalString(value.contextCategoriesAt) &&
    typeof value.hasCodexEstimate === 'boolean' &&
    isNonnegativeFinite(chatSource.usd) &&
    isNonnegativeFinite(chatSource.turnCount) &&
    isNonnegativeFinite(subagentSource.usd) &&
    Array.isArray(subagentSource.items) &&
    subagentSource.items.every(hasValidTotalTokens) &&
    isNonnegativeFinite(delegationSource.usd) &&
    Array.isArray(delegationSource.items) &&
    delegationSource.items.every(hasValidTotalTokens) &&
    isNonnegativeFinite(backgroundSource.usd) &&
    Array.isArray(backgroundSource.rows) &&
    Array.isArray(value.chatTurnsByModel) &&
    value.chatTurnsByModel.every(isCostModelRow) &&
    Array.isArray(value.byModel) &&
    value.byModel.every(isCostModelRow) &&
    isOptionalProxyAccountRows(value.byProxyAccount) &&
    Array.isArray(context.categories) &&
    Array.isArray(context.timeline) &&
    isNonnegativeFinite(compactions.total) &&
    isNonnegativeFinite(compactions.auto) &&
    isNonnegativeFinite(compactions.manual) &&
    isNonnegativeFinite(activity.turnCount) &&
    isNonnegativeFinite(activity.totalDurationMs) &&
    (activity.averageTurnMs === null ||
      isNonnegativeFinite(activity.averageTurnMs)) &&
    (activity.p95TurnMs === null || isNonnegativeFinite(activity.p95TurnMs)) &&
    isNonnegativeFinite(activity.toolCallCount) &&
    isNonnegativeFinite(activity.subagentCount) &&
    isNonnegativeFinite(activity.plansCreated) &&
    isNonnegativeFinite(activity.plansApproved) &&
    Array.isArray(activity.topTools) &&
    Array.isArray(value.points) &&
    value.points.every(
      (point) =>
        isRecord(point) &&
        isString(point.startedAt) &&
        (point.durationMs === undefined ||
          isNonnegativeFinite(point.durationMs)) &&
        (point.context === undefined ||
          (isRecord(point.context) &&
            isNonnegativeFinite(point.context.endTokens) &&
            isNonnegativeFinite(point.context.windowTokens) &&
            (point.context.peakTokens === undefined ||
              isNonnegativeFinite(point.context.peakTokens)))) &&
        (point.compaction === undefined ||
          point.compaction === 'auto' ||
          point.compaction === 'manual' ||
          point.compaction === 'unknown'),
    )
  );
}

function isStringRecordOfTurns(
  value: unknown,
): value is Record<string, CostTurnRecord> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([entryId, record]) =>
        isCostTurnRecord(record) && record.entryId === entryId,
    )
  );
}

function isCostChatFile(value: unknown): value is CostChatFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isString(value.chatId) &&
    isStringRecordOfTurns(value.records) &&
    (value.sealed === undefined || isCostChatAggregate(value.sealed)) &&
    (value.sealedEntryIds === undefined ||
      (Array.isArray(value.sealedEntryIds) &&
        value.sealedEntryIds.every(isString)))
  );
}

/**
 * Sealed runs carry their own run and step totals, which later merges add to,
 * so they go through the same totals check as every other persisted total.
 */
function isSealedRuns(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (view) =>
      isRecord(view) &&
      isRecord(view.run) &&
      isCostTotals(view.run.totals) &&
      Array.isArray(view.steps) &&
      view.steps.every((step) => isRecord(step) && isCostTotals(step.totals)) &&
      (view.subagents === undefined ||
        (Array.isArray(view.subagents) &&
          view.subagents.every(hasValidTotalTokens))) &&
      (view.delegations === undefined ||
        (Array.isArray(view.delegations) &&
          view.delegations.every(hasValidTotalTokens))),
  );
}

export function isCostUnattachedFile(
  value: unknown,
): value is CostUnattachedFile {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isStringRecordOfTurns(value.records)
  ) {
    return false;
  }
  if (
    value.sealedUnattached !== undefined &&
    !isCostChatAggregate(value.sealedUnattached)
  ) {
    return false;
  }
  return (
    (value.sealedRuns === undefined || isSealedRuns(value.sealedRuns)) &&
    (value.sealedRunsLastActivityAt === undefined ||
      isString(value.sealedRunsLastActivityAt)) &&
    (value.sealedEntryIds === undefined ||
      (Array.isArray(value.sealedEntryIds) &&
        value.sealedEntryIds.every(isString)))
  );
}

function isCostSummaryFile(value: unknown): value is CostSummaryFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.totals))
    return false;
  const isChat = (chat: unknown): boolean =>
    isRecord(chat) &&
    isString(chat.chatId) &&
    isCostTotals(chat.totals) &&
    isNonnegativeFinite(chat.turnCount) &&
    isOptionalString(chat.firstActivityAt) &&
    isString(chat.lastActivityAt) &&
    Array.isArray(chat.models) &&
    chat.models.every(isString) &&
    typeof chat.running === 'boolean' &&
    typeof chat.hasCodexEstimate === 'boolean' &&
    isOptionalProxyAccountRows(chat.proxyAccounts);
  const isRun = (run: unknown): boolean =>
    isRecord(run) &&
    isString(run.executionId) &&
    isString(run.pipelineName) &&
    isString(run.startedAt) &&
    (run.status === 'running' ||
      run.status === 'succeeded' ||
      run.status === 'failed' ||
      run.status === 'cancelled') &&
    isCostTotals(run.totals) &&
    isNonnegativeFinite(run.agentStepCount);
  return (
    isString(value.projectId) &&
    isString(value.scopeId) &&
    isString(value.incarnation) &&
    (value.updatedAt === null || isString(value.updatedAt)) &&
    isOptionalString(value.sealedAt) &&
    isOptionalString(value.coverageStart) &&
    isNonnegativeFinite(value.retentionDays) &&
    isNonnegativeFinite(value.revision) &&
    isCostTotals(value.totals) &&
    Array.isArray(value.chats) &&
    value.chats.every(isChat) &&
    Array.isArray(value.pipelineRuns) &&
    value.pipelineRuns.every(isRun) &&
    (value.unattached === undefined || isCostTotals(value.unattached)) &&
    typeof value.hasCodexEstimate === 'boolean'
  );
}

function isInternalTrigger(value: unknown): value is CostInternalTrigger {
  return (
    value === 'startup' ||
    value === 'idle' ||
    value === 'open' ||
    value === 'manual' ||
    value === 'turn' ||
    value === 'archive'
  );
}

function isCheckpoint(value: unknown): value is CostIndexCheckpoint {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRecord(value.firstBuild) ||
    !isRecord(value.audit)
  ) {
    return false;
  }
  if (
    !isString(value.firstBuild.at) ||
    !isString(value.firstBuild.coverageStart) ||
    !isNonnegativeFinite(value.generation)
  ) {
    return false;
  }
  const validCursors = Object.values(value.audit).every(
    (cursor) =>
      isRecord(cursor) &&
      isNonnegativeFinite(cursor.offset) &&
      isNonnegativeFinite(cursor.size) &&
      isNonnegativeFinite(cursor.mtimeMs) &&
      (cursor.ino === undefined || isNonnegativeFinite(cursor.ino)),
  );
  const lastRefresh = value.lastRefresh;
  const validLastRefresh =
    lastRefresh === undefined ||
    (isRecord(lastRefresh) &&
      isInternalTrigger(lastRefresh.trigger) &&
      isString(lastRefresh.startedAt) &&
      isString(lastRefresh.completedAt) &&
      isNonnegativeFinite(lastRefresh.linesRead) &&
      isNonnegativeFinite(lastRefresh.durationMs));
  return validCursors && validLastRefresh;
}

/** Upgrades a checkpoint from one file version to the next. */
export type CheckpointUpgradeStep = (
  value: Readonly<Record<string, unknown>>,
) => Record<string, unknown>;

export interface CheckpointMigrations<Checkpoint> {
  readonly currentVersion: number;
  /** Keyed by the version a step upgrades from; it returns the next version. */
  readonly steps: Readonly<Record<number, CheckpointUpgradeStep>>;
  readonly isCurrent: (value: unknown) => value is Checkpoint;
}

/** What a checkpoint written by a later release keeps when this one reads it. */
export interface NewerCheckpointState {
  readonly firstBuild?: CostIndexCheckpoint['firstBuild'];
  readonly retainedFillComplete?: boolean;
}

export type CheckpointMigration<Checkpoint> =
  | { readonly kind: 'current'; readonly value: Checkpoint }
  | {
      readonly kind: 'migrated';
      readonly from: number;
      readonly value: Checkpoint;
    }
  | {
      readonly kind: 'newer';
      readonly version: number;
      readonly preserved: NewerCheckpointState;
    }
  | { readonly kind: 'corrupt' };

/**
 * The file version is the checkpoint's shape. It is separate from
 * `generation`, which records the classification rules its records follow.
 */
const CHECKPOINT_MIGRATIONS: CheckpointMigrations<CostIndexCheckpoint> = {
  currentVersion: 1,
  steps: {},
  isCurrent: isCheckpoint,
};

/**
 * The state every upgrade step carries unchanged: the audit byte cursors, the
 * first build, the retained fill flag, the generation and the last refresh.
 */
export function carryCheckpointFields(
  value: Readonly<Record<string, unknown>>,
  version: number,
): Record<string, unknown> {
  return {
    version,
    generation: value.generation,
    firstBuild: value.firstBuild,
    audit: value.audit,
    ...(value.retainedFillComplete === undefined
      ? {}
      : { retainedFillComplete: value.retainedFillComplete }),
    ...(value.lastRefresh === undefined
      ? {}
      : { lastRefresh: value.lastRefresh }),
  };
}

export function migrateCheckpoint(
  raw: unknown,
): CheckpointMigration<CostIndexCheckpoint> {
  return migrateCheckpointWith(raw, CHECKPOINT_MIGRATIONS);
}

/** Upgrades `raw` one version at a time; nothing here writes the file. */
export function migrateCheckpointWith<Checkpoint>(
  raw: unknown,
  migrations: CheckpointMigrations<Checkpoint>,
): CheckpointMigration<Checkpoint> {
  if (!isRecord(raw)) return { kind: 'corrupt' };
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    return { kind: 'corrupt' };
  if (version > migrations.currentVersion) {
    return { kind: 'newer', version, preserved: newerCheckpointState(raw) };
  }
  if (version === migrations.currentVersion) {
    return migrations.isCurrent(raw)
      ? { kind: 'current', value: raw }
      : { kind: 'corrupt' };
  }
  let value: Record<string, unknown> = raw;
  for (let from = version; from < migrations.currentVersion; from += 1) {
    const step = migrations.steps[from];
    if (step === undefined) return { kind: 'corrupt' };
    value = step(value);
  }
  return migrations.isCurrent(value)
    ? { kind: 'migrated', from: version, value }
    : { kind: 'corrupt' };
}

/** Cursors of a later file shape have no known meaning and are not kept. */
function newerCheckpointState(
  raw: Readonly<Record<string, unknown>>,
): NewerCheckpointState {
  const firstBuild = raw.firstBuild;
  return {
    ...(isRecord(firstBuild) &&
    isString(firstBuild.at) &&
    isString(firstBuild.coverageStart)
      ? {
          firstBuild: {
            at: firstBuild.at,
            coverageStart: firstBuild.coverageStart,
          },
        }
      : {}),
    ...(typeof raw.retainedFillComplete === 'boolean'
      ? { retainedFillComplete: raw.retainedFillComplete }
      : {}),
  };
}

export async function readJsonFile<T>(
  filePath: string,
  validate: (value: unknown) => value is T,
): Promise<PersistedRead<T>> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return { value: null, corrupt: false };
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    await preserveCorruptFile(filePath);
    return { value: null, corrupt: true };
  }
  if (!validate(value)) {
    await preserveCorruptFile(filePath);
    return { value: null, corrupt: true };
  }
  return { value, corrupt: false };
}

export interface CheckpointRead extends PersistedRead<CostIndexCheckpoint> {
  /** Set when a later release wrote the file; its original is kept aside. */
  readonly newer?: {
    readonly version: number;
    readonly preserved: NewerCheckpointState;
  };
}

/**
 * A checkpoint from an earlier file version is upgraded in memory; the next
 * end-of-pass write stores it. One from a later version is not corrupt: its
 * bytes are kept aside once as `<name>.v<version>-<ms>` before this release
 * replaces it.
 */
export async function readCheckpointFile(
  filePath: string,
): Promise<CheckpointRead> {
  let source: Buffer;
  try {
    source = await readFile(filePath);
  } catch (error) {
    if (isMissingFile(error)) return { value: null, corrupt: false };
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source.toString('utf8'));
  } catch {
    await preserveCorruptFile(filePath);
    return { value: null, corrupt: true };
  }
  const migration = migrateCheckpoint(raw);
  switch (migration.kind) {
    case 'current':
    case 'migrated':
      return { value: migration.value, corrupt: false };
    case 'newer':
      await preserveFileOnce(filePath, `.v${migration.version}-`, source);
      return {
        value: null,
        corrupt: false,
        newer: { version: migration.version, preserved: migration.preserved },
      };
    case 'corrupt':
      await preserveCorruptFile(filePath);
      return { value: null, corrupt: true };
  }
}

export async function readSummaryFile(
  directory: string,
): Promise<PersistedRead<CostSummaryFile>> {
  return readJsonFile(path.join(directory, 'summary.json'), isCostSummaryFile);
}

export async function readChatFile(
  directory: string,
  chatId: string,
): Promise<PersistedRead<CostChatFile>> {
  const result = await readJsonFile(
    chatFilePath(directory, chatId),
    isCostChatFile,
  );
  if (result.value !== null && result.value.chatId !== chatId) {
    await preserveCorruptFile(chatFilePath(directory, chatId));
    return { value: null, corrupt: true };
  }
  return result;
}

export async function readScopeFiles(directory: string): Promise<{
  readonly summary: PersistedRead<CostSummaryFile>;
  readonly chats: readonly CostChatFile[];
  readonly unattached: PersistedRead<CostUnattachedFile>;
  readonly corrupt: boolean;
}> {
  const summary = await readSummaryFile(directory);
  const unattached = await readJsonFile(
    path.join(directory, 'unattached.json'),
    isCostUnattachedFile,
  );
  let corrupt = summary.corrupt || unattached.corrupt;
  let filenames: string[] = [];
  try {
    filenames = await readdir(path.join(directory, 'chats'));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const chats: CostChatFile[] = [];
  for (const filename of filenames.sort()) {
    if (!filename.endsWith('.json')) continue;
    const filePath = path.join(directory, 'chats', filename);
    const result = await readJsonFile(filePath, isCostChatFile);
    if (result.corrupt) corrupt = true;
    if (result.value !== null) chats.push(result.value);
  }
  return { summary, chats, unattached, corrupt };
}

export async function writeChatFile(
  directory: string,
  value: CostChatFile,
): Promise<void> {
  await writeJsonAtomically(chatFilePath(directory, value.chatId), value);
}

export async function writeUnattachedFile(
  directory: string,
  value: CostUnattachedFile,
): Promise<void> {
  await writeJsonAtomically(path.join(directory, 'unattached.json'), value);
}

export async function writeSummaryFile(
  directory: string,
  value: CostSummaryFile,
): Promise<void> {
  await writeJsonAtomically(path.join(directory, 'summary.json'), value);
}

/** The cursors say which audit lines are already in the scope files. */
export async function writeCheckpointFile(
  filePath: string,
  value: CostIndexCheckpoint,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomically(filePath, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    durable: true,
  });
}

export async function writeJsonAtomically(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${++temporaryFileSequence}`;
  const contents = `${JSON.stringify(value)}\n`;
  try {
    await writeFile(temporaryPath, contents, 'utf8');
    await rename(temporaryPath, filePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Preserve the original write error; an absent temporary file is normal.
    }
    throw error;
  }
}

export async function moveDirectoryAside(directory: string): Promise<boolean> {
  try {
    // Incarnation-mismatched state is identity-bound private data, not a
    // recoverable corrupt copy. Never leave it in a sibling of the cost root.
    await rm(directory, { recursive: true, force: false });
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function chatFilePath(directory: string, chatId: string): string {
  const encodedId = Buffer.from(chatId, 'utf8').toString('base64url');
  return path.join(directory, 'chats', `${encodedId}.json`);
}

async function preserveCorruptFile(filePath: string): Promise<void> {
  let contents: Buffer;
  try {
    contents = await readFile(filePath);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  await preserveFileOnce(filePath, '.corrupt-', contents);
}

const preservationsInFlight = new Map<string, Promise<void>>();

/**
 * Keep `contents` beside `filePath` as `<name><marker><suffix>`, unless a copy
 * with the same marker and bytes is already there. A file read again and
 * again (a retained summary is never rebuilt) is kept once, and only the
 * newest five copies per marker are kept.
 */
async function preserveFileOnce(
  filePath: string,
  marker: string,
  contents: Buffer,
): Promise<void> {
  const key = `${filePath}\0${marker}`;
  for (;;) {
    const inFlight = preservationsInFlight.get(key);
    if (inFlight === undefined) break;
    await inFlight.catch(() => undefined);
  }
  const task = (async (): Promise<void> => {
    if (await hasPreservedCopy(filePath, marker, contents)) return;
    const corrupt = marker === '.corrupt-';
    const suffix = corrupt
      ? `${Date.now()}-${++corruptFileSequence}`
      : `${Date.now()}`;
    await writeFile(`${filePath}${marker}${suffix}`, contents, { flag: 'wx' });
    await pruneDamagedCopies(
      damagedCopiesOf(filePath, marker, { uniqueTail: corrupt }),
    );
  })();
  preservationsInFlight.set(key, task);
  try {
    await task;
  } finally {
    if (preservationsInFlight.get(key) === task)
      preservationsInFlight.delete(key);
  }
}

async function hasPreservedCopy(
  filePath: string,
  marker: string,
  contents: Buffer,
): Promise<boolean> {
  const directory = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}${marker}`;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      if (contents.equals(await readFile(path.join(directory, name))))
        return true;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  return false;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
