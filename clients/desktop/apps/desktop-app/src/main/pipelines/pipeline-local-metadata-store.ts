import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { flushDirectorySync } from '@canopy/core-platform/directory-flush';
import {
  createPipelineLocalMetadataStore,
  type PipelineLocalMetadataCodec,
  type PipelineLocalMetadataWriteOutcome,
} from '@canopy/core-runtime/node/pipeline/store';
import { writeFileAtomicallySync } from '@canopy/execution-engine/node/lib/atomic-file';
import type {
  ChatPluginDefault,
  ChatPluginSelection,
} from '@canopy/desktop-shared/lib/chat-automation-conversion';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { serializePipelinePreferenceLocator } from '@canopy/execution-engine/pipelines/plugin-collections';
import {
  inspectStoredPipelineDocument,
  readStoredPipelineIndexStatus,
  readStoredPipelinePresence,
  withStoredPipelineDefinitionLock,
  type StoredPipelineWriteOptions,
} from '@canopy/execution-engine/pipelines/store';
import {
  isShareablePluginRef,
  type ShareablePluginRef,
} from '@canopy/execution-engine/plugin-refs';
import {
  APPROVAL_MODES,
  type ApprovalMode,
} from '@canopy/execution-engine/types/approvals';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type {
  PipelineAgentAuthor,
  PipelineAgentChatAddress,
  PipelinePreferenceLocator,
} from '@canopy/execution-engine/types/pipeline';
import type {
  WorkflowScheduleTarget,
  WorkflowScheduleValues,
} from '@canopy/protocol/pipelines';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import { getPipelineLocalMetadataFilePath } from '../lib/paths';

/**
 * Main-only facts about a user pipeline that never travel with its content:
 * the owner it was created in and the agent chat that last wrote it.
 */
export interface PipelineLocalMetadata {
  /** Serialized owner (`personal` / `org:<uuid>`). */
  owner?: string;
  agentAuthor?: PipelineAgentAuthor;
  markerWritePending?: true;
  /**
   * The automation this pipeline was generated for, which deletes it with
   * itself (CAN-4551, the Workflows plan's `workflow.owner`). A marker whose
   * automation is gone, or no longer runs this pipeline, is stale and ignored.
   */
  ownerAutomationId?: string;
  /**
   * CAN-5479: the authority the chat action of the automation that owns this
   * pipeline set when main last generated it. An agent-originated run of
   * exactly that revision keeps it, where D11 would refuse it; an agent's
   * update converts back with it, never with a hand-edited pipeline's.
   * Written by main alone, never from a request body; a person's own save
   * of the pipeline clears it.
   */
  nativeGrant?: PipelineNativeGrant;
  /**
   * CAN-5479: the selection each `chat_plugins` default of the automation's
   * pipeline stood for when main last generated it, so converting back needs
   * no plugin catalog. Written by main alone.
   */
  chatPluginDefaults?: ChatPluginDefault[];
  /**
   * CAN-5782: the pipeline is a workflow page although no live automation
   * owns it: a second schedule targets it, or its owner marker was cleared
   * while the pipeline stayed.
   */
  workflowPage?: true;
  /**
   * CAN-5782: the pipeline holds an Orchestrator prompt whose owner marker
   * was cleared. Agents denied Orchestrator access don't see it, and a
   * schedule on it counts as an Orchestrator automation.
   */
  agentHidden?: true;
  /** CAN-5782: the removed last schedule's run values, for the next one. */
  lastScheduleValues?: WorkflowScheduleValues;
  /**
   * CAN-5782: the content a person last approved for timed fires of a
   * `workflow`-only definition, named by its digest. Written by main alone,
   * after a person's write commits; an agent's write clears it.
   */
  personApprovedDigest?: PipelinePersonApproval;
  /**
   * CAN-7228: when a person last saved the pipeline in the editor or took
   * an agent's content over. A schedule an agent wrote before then runs as
   * the person's; an agent's write clears it. Written by main alone.
   */
  personAuthoredAt?: string;
  /**
   * CAN-7228: the `nativeGrantContentHash` digest of the content the person
   * saved at `personAuthoredAt`. A run holds their takeover only while it
   * admits exactly that content.
   */
  personAuthoredContentHash?: string;
}

/**
 * A person's approval of a user pipeline's content (CAN-5782): the
 * `nativeGrantContentHash` digest of the content they committed, and the
 * revision it was committed at. A fire matches the digest, never
 * the revision.
 */
export interface PipelinePersonApproval {
  contentHash: string;
  revision: number;
  /**
   * The installed package the content ran with when the person approved
   * it; absent when it ran with none. A fire with any other package, or
   * with a package where none was approved, isn't approved.
   */
  packageDigest?: string;
}

/**
 * The authority a converted automation's native action set: what D11
 * refuses an agent-originated run that creates a chat.
 */
export interface PipelineNativeGrantAuthority {
  approvalMode?: ApprovalMode;
  plugins?: ShareablePluginRef[];
  /** An Orchestrator prompt's model. */
  model?: string;
  /**
   * Local plugin selections. They reach the send step through the
   * automation's inputs, which the content hash doesn't cover.
   */
  pluginSelections?: ChatTabPluginSelections;
}

/**
 * A native grant, bound to the automation it was minted for and to the
 * pipeline's revision and content as saved: any later write fails it closed.
 */
export interface PipelineNativeGrant extends PipelineNativeGrantAuthority {
  automationId: string;
  pipelineRevision: number;
  contentHash: string;
}

function warn(message: string): void {
  process.stderr.write(`[pipeline-local-metadata] ${message}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeChatAddress(
  value: unknown,
): PipelineAgentChatAddress | undefined {
  if (!isRecord(value)) return undefined;
  const projectId = nonEmptyString(value.projectId);
  const worktreeId = nonEmptyString(value.worktreeId);
  const chatId = nonEmptyString(value.chatId);
  return projectId && worktreeId && chatId
    ? { projectId, worktreeId, chatId }
    : undefined;
}

function normalizeEntry(value: unknown): PipelineLocalMetadata {
  if (!isRecord(value)) return {};
  const entry: PipelineLocalMetadata = {};
  if (
    typeof value.owner === 'string' &&
    parseWorkspaceContext(value.owner) !== null
  ) {
    entry.owner = value.owner;
  }
  if (isRecord(value.agentAuthor)) {
    const chat = normalizeChatAddress(value.agentAuthor.chat);
    const recordedAt = nonEmptyString(value.agentAuthor.recordedAt);
    if (chat && recordedAt) entry.agentAuthor = { chat, recordedAt };
  }
  if (value.markerWritePending === true) entry.markerWritePending = true;
  const ownerAutomationId = nonEmptyString(value.ownerAutomationId);
  if (ownerAutomationId) entry.ownerAutomationId = ownerAutomationId;
  const nativeGrant = normalizeNativeGrant(value.nativeGrant);
  if (nativeGrant) entry.nativeGrant = nativeGrant;
  const chatPluginDefaults = normalizeChatPluginDefaults(
    value.chatPluginDefaults,
  );
  if (chatPluginDefaults) entry.chatPluginDefaults = chatPluginDefaults;
  if (value.workflowPage === true) entry.workflowPage = true;
  if (value.agentHidden === true) entry.agentHidden = true;
  const lastScheduleValues = normalizeScheduleValues(value.lastScheduleValues);
  if (lastScheduleValues) entry.lastScheduleValues = lastScheduleValues;
  const personApprovedDigest = normalizePersonApproval(
    value.personApprovedDigest,
  );
  if (personApprovedDigest) entry.personApprovedDigest = personApprovedDigest;
  const personAuthoredAt = nonEmptyString(value.personAuthoredAt);
  const personAuthoredContentHash = nonEmptyString(
    value.personAuthoredContentHash,
  );
  // The stamp counts only with the content it was made for.
  if (
    personAuthoredAt &&
    Number.isFinite(Date.parse(personAuthoredAt)) &&
    personAuthoredContentHash
  ) {
    entry.personAuthoredAt = personAuthoredAt;
    entry.personAuthoredContentHash = personAuthoredContentHash;
  }
  return entry;
}

/** An approval with a field it can't trust is dropped: it fails closed. */
function normalizePersonApproval(
  value: unknown,
): PipelinePersonApproval | undefined {
  if (!isRecord(value)) return undefined;
  const contentHash = nonEmptyString(value.contentHash);
  const { revision } = value;
  if (
    !contentHash ||
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 0
  )
    return undefined;
  if (value.packageDigest === undefined) return { contentHash, revision };
  const packageDigest = nonEmptyString(value.packageDigest);
  return packageDigest ? { contentHash, revision, packageDigest } : undefined;
}

function normalizeStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeScheduleTarget(
  value: unknown,
): WorkflowScheduleTarget | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.kind === 'global' ||
    value.kind === 'new_worktree' ||
    value.kind === 'project'
  )
    return { kind: value.kind };
  const taskId = nonEmptyString(value.taskId);
  return value.kind === 'task' && taskId ? { kind: 'task', taskId } : undefined;
}

/** Values it can't read are dropped; the next schedule fills them in. */
function normalizeScheduleValues(
  value: unknown,
): WorkflowScheduleValues | undefined {
  if (!isRecord(value)) return undefined;
  const inputs = normalizeStringRecord(value.inputs);
  const target = normalizeScheduleTarget(value.target);
  const workspaceId = nonEmptyString(value.workspaceId);
  const repoId = nonEmptyString(value.repoId);
  const values: WorkflowScheduleValues = {
    ...(inputs ? { inputs } : {}),
    ...(target ? { target } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(repoId ? { repoId } : {}),
    ...(isRecord(value.modelAliasPreferences)
      ? { modelAliasPreferences: value.modelAliasPreferences }
      : {}),
    ...(isRecord(value.pluginCollectionPreferences)
      ? { pluginCollectionPreferences: value.pluginCollectionPreferences }
      : {}),
  };
  return Object.keys(values).length > 0 ? values : undefined;
}

function normalizeChatPluginSelection(
  value: unknown,
): ChatPluginSelection | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'skill') {
    const sourceId = nonEmptyString(value.sourceId);
    const skillName = nonEmptyString(value.skillName);
    return sourceId && skillName
      ? { kind: 'skill', sourceId, skillName }
      : undefined;
  }
  if (value.kind === 'plugin') {
    const marketplaceId = nonEmptyString(value.marketplaceId);
    const pluginName = nonEmptyString(value.pluginName);
    return marketplaceId && pluginName
      ? { kind: 'plugin', marketplaceId, pluginName }
      : undefined;
  }
  return undefined;
}

/**
 * A list with an entry it can't read is dropped whole: converting back then
 * finds a default with no selection and leaves the pipeline as it is.
 */
function normalizeChatPluginDefaults(
  value: unknown,
): ChatPluginDefault[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const defaults: ChatPluginDefault[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return undefined;
    const defaultKey = nonEmptyString(raw.defaultKey);
    const selection = normalizeChatPluginSelection(raw.selection);
    if (!defaultKey || !selection) return undefined;
    defaults.push({ defaultKey, selection });
  }
  return defaults;
}

/** A grant with any field it can't trust is dropped whole: it fails closed. */
function normalizeNativeGrant(value: unknown): PipelineNativeGrant | undefined {
  if (!isRecord(value)) return undefined;
  const automationId = nonEmptyString(value.automationId);
  const contentHash = nonEmptyString(value.contentHash);
  const { pipelineRevision, approvalMode, plugins, model, pluginSelections } =
    value;
  if (
    !automationId ||
    !contentHash ||
    typeof pipelineRevision !== 'number' ||
    !Number.isInteger(pipelineRevision)
  )
    return undefined;
  const mode =
    approvalMode === undefined
      ? undefined
      : APPROVAL_MODES.find((candidate) => candidate === approvalMode);
  if (approvalMode !== undefined && mode === undefined) return undefined;
  const refs: ShareablePluginRef[] | null | undefined =
    plugins === undefined
      ? undefined
      : Array.isArray(plugins) && plugins.every(isShareablePluginRef)
        ? plugins
        : null;
  if (refs === null) return undefined;
  const grantModel = model === undefined ? undefined : nonEmptyString(model);
  if (model !== undefined && grantModel === undefined) return undefined;
  if (pluginSelections !== undefined && !isRecord(pluginSelections))
    return undefined;
  return {
    automationId,
    pipelineRevision,
    contentHash,
    ...(mode !== undefined ? { approvalMode: mode } : {}),
    ...(refs !== undefined ? { plugins: refs } : {}),
    ...(grantModel !== undefined ? { model: grantModel } : {}),
    ...(pluginSelections !== undefined
      ? { pluginSelections: normalizePluginSelections(pluginSelections) }
      : {}),
  };
}

function userPipelineKey(pipelineId: string): string {
  return serializePipelinePreferenceLocator({
    type: 'stored',
    source: 'user',
    value: pipelineId,
  });
}

/**
 * How Electron main reads a stored entry and names a user pipeline's, for a
 * trusted composition of the same file over another host (CAN-7057).
 */
export const pipelineLocalMetadataCodec: PipelineLocalMetadataCodec<PipelineLocalMetadata> =
  { normalizeEntry, userPipelineKey };

/**
 * The file over Electron main's data root (CAN-5092): the portable store
 * keeps its read, write and recovery policy, and this module keeps its path
 * and its atomic, durable write. Synchronous read-modify-write keeps writes
 * ordered on the main event loop.
 */
const metadataStore = createPipelineLocalMetadataStore<PipelineLocalMetadata>(
  {
    location: () => getPipelineLocalMetadataFilePath(),
    stat: () => fs.statSync(getPipelineLocalMetadataFilePath()),
    readText: () => fs.readFileSync(getPipelineLocalMetadataFilePath(), 'utf8'),
    install: (data) => {
      const filePath = getPipelineLocalMetadataFilePath();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileAtomicallySync(filePath, data, {
        encoding: 'utf8',
        mode: 0o600,
        durable: true,
        admittedWriter: {
          namespace: 'pipeline_local_metadata',
          writer: 'electron_main',
          module: 'main/pipelines/pipeline-local-metadata-store',
        },
      });
    },
    warn,
  },
  pipelineLocalMetadataCodec,
);

/** Confirms the metadata directory after a successful or replayed write. */
function confirmPipelineLocalMetadataDurability(): void {
  flushDirectorySync(path.dirname(getPipelineLocalMetadataFilePath()));
}

function readMetadataFile(): ReturnType<typeof metadataStore.read> {
  return metadataStore.read();
}

function updateUserPipelineEntry(
  pipelineId: string,
  update: (entry: PipelineLocalMetadata) => PipelineLocalMetadata,
): void {
  metadataStore.updateUserPipeline(pipelineId, update);
}

/** Whether stored owners can be read; a missing file counts as readable. */
export function isPipelineLocalMetadataReadable(): boolean {
  return readMetadataFile().unreadable !== true;
}

export function readPipelineLocalMetadata(
  locator: PipelinePreferenceLocator,
): PipelineLocalMetadata {
  return (
    readMetadataFile().entries[serializePipelinePreferenceLocator(locator)] ??
    {}
  );
}

export function recordUserPipelineOwner(
  pipelineId: string,
  owner: string,
): void {
  updateUserPipelineEntry(pipelineId, (entry) => ({ ...entry, owner }));
}

export type UserPipelineMarkerWriteResult =
  | 'written'
  | 'unchanged'
  | 'newer_revision'
  | 'unreadable'
  | 'write_failed'
  | 'restore_unconfirmed';

function confirmRequiredMetadataWrite(
  outcome: PipelineLocalMetadataWriteOutcome | 'unchanged',
): boolean {
  if (outcome === 'written') return true;
  if (outcome !== 'unflushed' && outcome !== 'unchanged') return false;
  try {
    confirmPipelineLocalMetadataDurability();
    return true;
  } catch {
    return false;
  }
}

/** Runs a synchronous sidecar effect only for a verified committed revision. */
export function withCurrentUserPipelineRevision<T>(
  pipelineId: string,
  revision: number,
  apply: () => T,
): T | 'unreadable' | 'newer_revision' {
  if (!Number.isSafeInteger(revision) || revision <= 0) return 'unreadable';
  const locked = withStoredPipelineDefinitionLock<
    T | 'unreadable' | 'newer_revision'
  >(() => {
    const status = readStoredPipelineIndexStatus();
    if (status !== 'ok' && status !== 'missing')
      return { ok: true, value: 'unreadable' };
    const stored = inspectStoredPipelineDocument(pipelineId);
    if (stored.kind === 'unreadable') return { ok: true, value: 'unreadable' };
    if (stored.kind !== 'stored' || stored.revision !== revision)
      return { ok: true, value: 'newer_revision' };
    return { ok: true, value: apply() };
  });
  return locked.ok ? locked.value : 'unreadable';
}

/** Sets the agent marker, or clears it and the native grant on a person save. */
export function setUserPipelineAgentAuthorIfCurrent(
  pipelineId: string,
  author: PipelineAgentAuthor | null,
  expected: {
    readonly revision: number;
    readonly requireDurable?: true;
    readonly preservePending?: true;
  },
  owner?: string,
): UserPipelineMarkerWriteResult {
  const result = withCurrentUserPipelineRevision<UserPipelineMarkerWriteResult>(
    pipelineId,
    expected.revision,
    () => {
      const metadata = readMetadataFile();
      if (metadata.unreadable === true) return 'unreadable';
      const key = userPipelineKey(pipelineId);
      const previous = metadata.entries[key];
      const {
        agentAuthor,
        nativeGrant,
        personApprovedDigest,
        personAuthoredAt,
        personAuthoredContentHash,
        ...rest
      } = previous ?? {};
      void agentAuthor;
      const expectedAuthor = normalizeEntry({
        agentAuthor: author,
      }).agentAuthor;
      if (author !== null && expectedAuthor === undefined)
        return 'write_failed';
      const next = {
        ...rest,
        // CAN-7228: an agent's write ends a person's takeover; theirs keeps it.
        ...(author === null &&
        personAuthoredAt !== undefined &&
        personAuthoredContentHash !== undefined
          ? { personAuthoredAt, personAuthoredContentHash }
          : {}),
        ...(author === null && personApprovedDigest !== undefined
          ? { personApprovedDigest }
          : {}),
        ...(owner === undefined ? {} : { owner }),
        ...(expectedAuthor === undefined
          ? {}
          : { agentAuthor: expectedAuthor }),
        ...(expectedAuthor !== undefined && nativeGrant !== undefined
          ? { nativeGrant }
          : {}),
      };
      if (expected.preservePending) next.markerWritePending = true;
      else if (expected.requireDurable) delete next.markerWritePending;
      if (isDeepStrictEqual(previous ?? {}, next))
        return !expected.requireDurable ||
          confirmRequiredMetadataWrite('unchanged')
          ? 'unchanged'
          : 'write_failed';
      metadata.entries[key] = next;
      const outcome = metadataStore.write(metadata);
      if (expected.requireDurable) {
        if (confirmRequiredMetadataWrite(outcome)) return 'written';
        if (outcome !== 'unflushed') return 'write_failed';
        // Restore the prior metadata before the definition writer compensates.
        if (previous === undefined) delete metadata.entries[key];
        else metadata.entries[key] = previous;
        return confirmRequiredMetadataWrite(metadataStore.write(metadata))
          ? 'write_failed'
          : 'restore_unconfirmed';
      }
      const readBack = readMetadataFile();
      return readBack.unreadable !== true &&
        isDeepStrictEqual(readBack.entries[key] ?? {}, next)
        ? 'written'
        : 'write_failed';
    },
  );
  if (
    expected.requireDurable &&
    (result === 'written' || result === 'unchanged')
  )
    unconfirmedMarkers.delete(pipelineId);
  return result;
}

const unconfirmedMarkers = new Set<string>();

// An unreadable sidecar may still contain owners and pending agent writes.
const PIPELINE_METADATA_UNREADABLE_MESSAGE =
  'Couldn’t read workflow metadata. Restore pipeline-local-metadata.json from a compatible backup or contact support.';

export function pipelineMarkerRefusalMessage(
  definitionId: string,
): string | undefined {
  const metadata = readMetadataFile();
  if (metadata.unreadable === true) return PIPELINE_METADATA_UNREADABLE_MESSAGE;
  if (
    unconfirmedMarkers.has(definitionId) ||
    metadata.entries[userPipelineKey(definitionId)]?.markerWritePending === true
  )
    return 'The workflow save could not be confirmed. Save the workflow again before running it.';
  return undefined;
}

type DefinitionFinalizer = NonNullable<StoredPipelineWriteOptions['finalize']>;
type RequiredMarkerWrite = Pick<StoredPipelineWriteOptions, 'prepare'> & {
  finalize: DefinitionFinalizer;
};
const requiredMarker = new AsyncLocalStorage<{ write?: RequiredMarkerWrite }>();

function prepareUserMarkerWrite(
  id: string,
): ReturnType<NonNullable<StoredPipelineWriteOptions['prepare']>> {
  const metadata = readMetadataFile();
  const key = userPipelineKey(id);
  const entry = metadata.entries[key];
  if (metadata.unreadable !== true) {
    metadata.entries[key] = { ...entry, markerWritePending: true };
    const outcome =
      entry?.markerWritePending === true
        ? 'unchanged'
        : metadataStore.write(metadata);
    const restore = (): void => {
      if (entry?.markerWritePending === true) return;
      const current = readMetadataFile();
      if (entry === undefined) delete current.entries[key];
      else current.entries[key] = entry;
      if (!confirmRequiredMetadataWrite(metadataStore.write(current)))
        throw new Error(
          'The previous workflow metadata could not be confirmed.',
        );
    };
    if (confirmRequiredMetadataWrite(outcome))
      return { ok: true, value: restore };
    if (outcome === 'unflushed') restore();
  }
  return {
    ok: false,
    reason: 'finalization_failed',
    message:
      metadata.unreadable === true
        ? PIPELINE_METADATA_UNREADABLE_MESSAGE
        : 'The workflow’s author could not be recorded.',
  };
}

export function withRequiredUserPipelineMarker<T>(
  author: PipelineAgentAuthor | null,
  owner: string | undefined,
  run: () => T,
  preservePending?: true,
): T {
  const finalize: DefinitionFinalizer = (saved) => {
    const result = setUserPipelineAgentAuthorIfCurrent(
      saved.id,
      author,
      { revision: saved.revision, requireDurable: true, preservePending },
      owner,
    );
    if (result === 'written' || result === 'unchanged')
      return { ok: true, value: undefined };
    if (result === 'restore_unconfirmed') {
      unconfirmedMarkers.add(saved.id);
      return {
        ok: false,
        reason: 'finalization_unconfirmed',
        message: 'The workflow save could not be confirmed.',
      };
    }
    return {
      ok: false,
      reason: 'finalization_failed',
      message:
        result === 'unreadable' && !isPipelineLocalMetadataReadable()
          ? PIPELINE_METADATA_UNREADABLE_MESSAGE
          : 'The workflow’s author could not be recorded.',
    };
  };
  return requiredMarker.run(
    { write: { prepare: prepareUserMarkerWrite, finalize } },
    run,
  );
}

export function takeRequiredUserPipelineMarkerWrite():
  | RequiredMarkerWrite
  | undefined {
  const scope = requiredMarker.getStore();
  if (!scope) return undefined;
  const write = scope.write;
  delete scope.write;
  return write;
}

/**
 * A person's authorship of a pipeline's content (CAN-7228): when they saved
 * it, and the digest of what they saved.
 */
export interface PersonAuthorship {
  at: string;
  contentHash: string;
}

/** The pipeline's person authorship, if it has one. */
export function userPipelinePersonAuthorship(
  pipelineId: string,
): PersonAuthorship | undefined {
  const entry = readMetadataFile().entries[userPipelineKey(pipelineId)];
  return entry?.personAuthoredAt !== undefined &&
    entry.personAuthoredContentHash !== undefined
    ? {
        at: entry.personAuthoredAt,
        contentHash: entry.personAuthoredContentHash,
      }
    : undefined;
}

/**
 * Records that a person wrote the pipeline's content, whose digest is
 * `contentHash`, now (CAN-7228), after their editor save commits.
 */
export function recordUserPipelinePersonAuthored(
  pipelineId: string,
  contentHash: string,
): void {
  const personAuthoredAt = new Date().toISOString();
  updateUserPipelineEntry(pipelineId, (entry) => ({
    ...entry,
    personAuthoredAt,
    personAuthoredContentHash: contentHash,
  }));
}

/**
 * Drops a person's authorship of the pipeline (CAN-7228): an agent wrote it,
 * or a schedule of it, after them. Returns whether it is gone when read back;
 * the store logs a failed write instead of throwing.
 */
export function clearUserPipelinePersonAuthored(pipelineId: string): boolean {
  // An unreadable store reads as empty: that is no proof the stamp is gone.
  if (!isPipelineLocalMetadataReadable()) return false;
  const key = userPipelineKey(pipelineId);
  if (!readMetadataFile().entries[key]?.personAuthoredAt) return true;
  updateUserPipelineEntry(pipelineId, (entry) => {
    const { personAuthoredAt, personAuthoredContentHash, ...rest } = entry;
    void personAuthoredAt;
    void personAuthoredContentHash;
    return rest;
  });
  return (
    isPipelineLocalMetadataReadable() &&
    !readMetadataFile().entries[key]?.personAuthoredAt
  );
}

/**
 * Puts back a person's authorship that an agent's schedule write cleared
 * before it failed to land (CAN-7228), unless anything wrote it since.
 */
export function restoreUserPipelinePersonAuthored(
  pipelineId: string,
  authorship: PersonAuthorship,
): void {
  const current = readMetadataFile().entries[userPipelineKey(pipelineId)];
  if (current?.personAuthoredAt !== undefined || current?.agentAuthor) return;
  updateUserPipelineEntry(pipelineId, (entry) => ({
    ...entry,
    personAuthoredAt: authorship.at,
    personAuthoredContentHash: authorship.contentHash,
  }));
}

/**
 * Whether a person's takeover read at `personAuthoredAt` still holds for a
 * run that admitted content with digest `admittedContentHash` (CAN-7228): no
 * agent marker, the same stamp, and exactly the content the person saved.
 * Any later write of other content fails it, whoever wrote it.
 */
export function personTakeoverHolds(
  pipelineId: string,
  personAuthoredAt: string,
  admittedContentHash: string,
): boolean {
  const entry = readMetadataFile().entries[userPipelineKey(pipelineId)];
  return (
    entry?.agentAuthor === undefined &&
    entry?.personAuthoredAt === personAuthoredAt &&
    entry.personAuthoredContentHash === admittedContentHash
  );
}

/**
 * The entry with `author` as its agent author, or none with `null`. An
 * agent's write drops a person's approval of the content (CAN-5782) and
 * their authorship of it (CAN-7228); a person's keeps both.
 */
function withAgentAuthor(
  entry: PipelineLocalMetadata,
  author: PipelineAgentAuthor | null,
): PipelineLocalMetadata {
  const {
    agentAuthor,
    nativeGrant,
    personApprovedDigest,
    personAuthoredAt,
    personAuthoredContentHash,
    ...rest
  } = entry;
  void agentAuthor;
  return author
    ? {
        ...rest,
        agentAuthor: author,
        ...(nativeGrant === undefined ? {} : { nativeGrant }),
      }
    : {
        ...rest,
        ...(personApprovedDigest === undefined ? {} : { personApprovedDigest }),
        ...(personAuthoredAt === undefined
          ? {}
          : { personAuthoredAt, personAuthoredContentHash }),
      };
}

/**
 * Records a routed write's owner and agent author in one write before its
 * commit, and reports how that write ended (CAN-7507).
 */
export function recordUserPipelineOwnerReported(
  pipelineId: string,
  owner: string,
  author: PipelineAgentAuthor | null,
): PipelineLocalMetadataWriteOutcome {
  return metadataStore.updateUserPipelineReported(pipelineId, (entry) =>
    withAgentAuthor({ ...entry, owner }, author),
  );
}

/**
 * A person's **Approve for schedules** of content an agent wrote last
 * (CAN-5782): one write records the approval and clears the agent author,
 * so neither lands without the other, and makes the content the person's
 * (CAN-7228). Callers have checked that no native grant would be dropped.
 */
export function recordPersonApprovalTakeover(
  pipelineId: string,
  approval: PipelinePersonApproval,
): void {
  const personAuthoredAt = new Date().toISOString();
  updateUserPipelineEntry(pipelineId, (entry) => {
    const { agentAuthor, personApprovedDigest, ...rest } = entry;
    void agentAuthor;
    void personApprovedDigest;
    return {
      ...rest,
      personAuthoredAt,
      personAuthoredContentHash: approval.contentHash,
      personApprovedDigest: {
        contentHash: approval.contentHash,
        revision: approval.revision,
        ...(approval.packageDigest === undefined
          ? {}
          : { packageDigest: approval.packageDigest }),
      },
    };
  });
}

/**
 * Records, or with `null` clears, a person's approval of the pipeline's
 * content for timed fires (CAN-5782). Main alone writes it, through
 * `pipeline-person-approval.ts`, which checks the stored revision first.
 */
export function setUserPipelinePersonApproval(
  pipelineId: string,
  approval: PipelinePersonApproval | null,
): void {
  const key = userPipelineKey(pipelineId);
  if (
    approval === null &&
    !readMetadataFile().entries[key]?.personApprovedDigest
  )
    return;
  updateUserPipelineEntry(pipelineId, (entry) => {
    const { personApprovedDigest, ...rest } = entry;
    void personApprovedDigest;
    return approval === null
      ? rest
      : {
          ...rest,
          personApprovedDigest: {
            contentHash: approval.contentHash,
            revision: approval.revision,
            ...(approval.packageDigest === undefined
              ? {}
              : { packageDigest: approval.packageDigest }),
          },
        };
  });
}

/**
 * Records, or with `null` clears, the native grant of the automation that
 * owns the pipeline (CAN-5479). Main alone writes it, when it generates the
 * pipeline from the automation's chat action; never from a request body.
 */
export function setUserPipelineNativeGrant(
  pipelineId: string,
  grant: PipelineNativeGrant | null,
): void {
  const key = userPipelineKey(pipelineId);
  if (grant === null && !readMetadataFile().entries[key]?.nativeGrant) return;
  updateUserPipelineEntry(pipelineId, (entry) => {
    const { nativeGrant, ...rest } = entry;
    void nativeGrant;
    return grant === null ? rest : { ...rest, nativeGrant: grant };
  });
}

/**
 * Records, or with `null` clears, the selections the automation's pipeline's
 * `chat_plugins` defaults stand for (CAN-5479). Main alone writes them, when
 * it generates the pipeline.
 */
export function setUserPipelineChatPluginDefaults(
  pipelineId: string,
  defaults: readonly ChatPluginDefault[] | null,
): void {
  const key = userPipelineKey(pipelineId);
  if (
    (defaults === null || defaults.length === 0) &&
    !readMetadataFile().entries[key]?.chatPluginDefaults
  )
    return;
  updateUserPipelineEntry(pipelineId, (entry) => {
    const { chatPluginDefaults, ...rest } = entry;
    void chatPluginDefaults;
    return defaults === null || defaults.length === 0
      ? rest
      : { ...rest, chatPluginDefaults: [...defaults] };
  });
}

/** `null` clears the owning automation (CAN-4551). */
export function setUserPipelineOwnerAutomation(
  pipelineId: string,
  automationId: string | null,
): void {
  const key = userPipelineKey(pipelineId);
  if (
    automationId === null &&
    !readMetadataFile().entries[key]?.ownerAutomationId
  )
    return;
  updateUserPipelineEntry(pipelineId, (entry) => {
    const { ownerAutomationId, ...rest } = entry;
    void ownerAutomationId;
    return automationId === null
      ? rest
      : { ...rest, ownerAutomationId: automationId };
  });
}

/**
 * CAN-5782: what a cleared owner marker leaves on a pipeline that stays.
 * `agentHidden` keeps an Orchestrator prompt hidden from denied agents.
 */
export interface ReleasedOwnerFacts {
  agentHidden: boolean;
  /** The removed last schedule's run values; absent keeps any stored. */
  lastScheduleValues?: WorkflowScheduleValues;
}

/**
 * CAN-5782: clears the owner marker of a pipeline that stays, and marks it
 * a workflow page, in one write: nothing reads the pipeline without its
 * owner and still a workflow page in between. Returns whether the write is
 * read back; a write this store failed (it logs and never throws) is not.
 */
export function releaseUserPipelineOwnerAutomation(
  pipelineId: string,
  facts: ReleasedOwnerFacts,
): boolean {
  updateUserPipelineEntry(pipelineId, (entry) => {
    const { ownerAutomationId, ...rest } = entry;
    void ownerAutomationId;
    return {
      ...rest,
      workflowPage: true,
      ...(facts.agentHidden ? { agentHidden: true } : {}),
      ...(facts.lastScheduleValues
        ? { lastScheduleValues: facts.lastScheduleValues }
        : {}),
    };
  });
  const written = readMetadataFile().entries[userPipelineKey(pipelineId)];
  return (
    written?.workflowPage === true &&
    written.ownerAutomationId === undefined &&
    (!facts.agentHidden || written.agentHidden === true) &&
    (facts.lastScheduleValues === undefined ||
      written.lastScheduleValues !== undefined)
  );
}

/**
 * CAN-5782: marks a pipeline a workflow page (a second schedule targets
 * it). A schedule writing it again drops the last removed one's values.
 */
export function markUserPipelineWorkflowPage(pipelineId: string): void {
  const current = readMetadataFile().entries[userPipelineKey(pipelineId)];
  if (current?.workflowPage && !current.lastScheduleValues) return;
  updateUserPipelineEntry(pipelineId, (entry) => {
    const { lastScheduleValues, ...rest } = entry;
    void lastScheduleValues;
    return { ...rest, workflowPage: true };
  });
}

/**
 * CAN-6065: hides an Orchestrator pipeline from denied agents by the
 * pipeline itself (`agentHidden`), not by the record its owner marker
 * names. Returns whether the flag is read back.
 */
export function markUserPipelineAgentHidden(pipelineId: string): boolean {
  if (readMetadataFile().entries[userPipelineKey(pipelineId)]?.agentHidden)
    return true;
  updateUserPipelineEntry(pipelineId, (entry) => ({
    ...entry,
    agentHidden: true,
  }));
  return (
    readMetadataFile().entries[userPipelineKey(pipelineId)]?.agentHidden ===
    true
  );
}

/** Removes a sidecar only if the definition store confirms its absence. */
export function deleteUserPipelineLocalMetadata(
  pipelineId: string,
): 'absent' | 'present' | 'unreadable' {
  const locked = withStoredPipelineDefinitionLock<
    'absent' | 'present' | 'unreadable'
  >(() => {
    const status = readStoredPipelineIndexStatus();
    if (status !== 'ok' && status !== 'missing')
      return { ok: true, value: 'unreadable' as const };
    const presence = readStoredPipelinePresence(pipelineId);
    if (presence === 'absent') metadataStore.deleteUserPipeline(pipelineId);
    return { ok: true, value: presence };
  });
  return locked.ok ? locked.value : 'unreadable';
}

/**
 * The user definitions the file keeps an entry for (CAN-7522), or `null` when
 * the file can't be read, so a reconcile never takes it for an empty one.
 */
export function userPipelineLocalMetadataIds(): string[] | null {
  const file = readMetadataFile();
  if (file.unreadable === true) return null;
  const prefix = serializePipelinePreferenceLocator({
    type: 'stored',
    source: 'user',
    value: '',
  });
  return Object.keys(file.entries).flatMap((key) =>
    key.startsWith(prefix) ? [key.slice(prefix.length)] : [],
  );
}
