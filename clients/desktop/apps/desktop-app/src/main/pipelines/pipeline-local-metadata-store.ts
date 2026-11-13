import * as fs from 'node:fs';
import * as path from 'node:path';
import { isStorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import { writeFileAtomicallySync } from '@canopy/execution-engine/node/lib/atomic-file';
import type {
  ChatPluginDefault,
  ChatPluginSelection,
} from '@canopy/desktop-shared/lib/chat-automation-conversion';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { serializePipelinePreferenceLocator } from '@canopy/execution-engine/pipelines/plugin-collections';
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

interface PipelineLocalMetadataFile {
  version: 1;
  entries: Record<string, PipelineLocalMetadata>;
  /** The file exists but can't be read; it is never overwritten. */
  unreadable?: true;
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
  return entry;
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

/**
 * The last parsed file. Main is the only writer, and every write here
 * replaces the file atomically (a new inode) and refreshes this copy; the
 * stat key only lets a read notice a file replaced some other way.
 */
let cachedFile:
  | {
      filePath: string;
      key: string;
      file: PipelineLocalMetadataFile;
    }
  | undefined;

function statKey(stat: fs.Stats): string {
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function copyOf(file: PipelineLocalMetadataFile): PipelineLocalMetadataFile {
  return { ...file, entries: { ...file.entries } };
}

function rememberFile(filePath: string, file: PipelineLocalMetadataFile): void {
  try {
    cachedFile = {
      filePath,
      key: statKey(fs.statSync(filePath)),
      file: copyOf(file),
    };
  } catch {
    cachedFile = undefined;
  }
}

function readMetadataFile(): PipelineLocalMetadataFile {
  const filePath = getPipelineLocalMetadataFilePath();
  try {
    const key = statKey(fs.statSync(filePath));
    if (cachedFile?.filePath === filePath && cachedFile.key === key)
      return copyOf(cachedFile.file);
  } catch {
    // Missing or unreadable; parsing below reports which.
  }
  const file = parseMetadataFile(filePath);
  // Only a parsed file is kept; a failed read is retried on the next call.
  if (file.unreadable) cachedFile = undefined;
  else rememberFile(filePath, file);
  return file;
}

function parseMetadataFile(filePath: string): PipelineLocalMetadataFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;
    if (code === 'ENOENT') return { version: 1, entries: {} };
    warn('Failed to parse metadata file; using empty defaults.');
    return { version: 1, entries: {}, unreadable: true };
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.entries)) {
    warn('Unsupported metadata file version or shape; using empty defaults.');
    return { version: 1, entries: {}, unreadable: true };
  }
  const entries: Record<string, PipelineLocalMetadata> = {};
  for (const [locatorKey, rawEntry] of Object.entries(parsed.entries)) {
    const entry = normalizeEntry(rawEntry);
    if (Object.keys(entry).length > 0) entries[locatorKey] = entry;
  }
  return { version: 1, entries };
}

function writeMetadataFile(file: PipelineLocalMetadataFile): void {
  const filePath = getPipelineLocalMetadataFilePath();
  // Rewriting a file that can't be read would drop every owner it holds.
  if (file.unreadable) {
    warn('Metadata file is unreadable; leaving it unchanged.');
    return;
  }
  const entries: Record<string, PipelineLocalMetadata> = {};
  for (const [locatorKey, entry] of Object.entries(file.entries)) {
    if (Object.keys(entry).length > 0) entries[locatorKey] = entry;
  }
  // Metadata never fails the save or run that records it.
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileAtomicallySync(
      filePath,
      `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
      {
        encoding: 'utf8',
        mode: 0o600,
        durable: true,
        admittedWriter: {
          namespace: 'pipeline_local_metadata',
          writer: 'electron_main',
          module: 'main/pipelines/pipeline-local-metadata-store',
        },
      },
    );
    rememberFile(filePath, { version: 1, entries });
  } catch (error) {
    if (isStorageOutcomeUnknownError(error)) {
      rememberFile(filePath, { version: 1, entries });
      warn('Metadata file installed, but its folder flush failed.');
      return;
    }
    warn(
      `Failed to write metadata file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function userPipelineKey(pipelineId: string): string {
  return serializePipelinePreferenceLocator({
    type: 'stored',
    source: 'user',
    value: pipelineId,
  });
}

/** Synchronous read-modify-write keeps writes ordered on the main event loop. */
function updateUserPipelineEntry(
  pipelineId: string,
  update: (entry: PipelineLocalMetadata) => PipelineLocalMetadata,
): void {
  const file = readMetadataFile();
  const key = userPipelineKey(pipelineId);
  file.entries[key] = update({ ...file.entries[key] });
  writeMetadataFile(file);
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

/**
 * `null` clears the marker, as when the user saves the pipeline themselves,
 * and with it any native grant (CAN-5479): the person's content is then the
 * pipeline's authority. An agent's write keeps the grant, which its new
 * revision fails at run time.
 */
export function setUserPipelineAgentAuthor(
  pipelineId: string,
  author: PipelineAgentAuthor | null,
): void {
  const key = userPipelineKey(pipelineId);
  const current = readMetadataFile().entries[key];
  if (author === null && !current?.agentAuthor && !current?.nativeGrant) return;
  updateUserPipelineEntry(pipelineId, (entry) => {
    const { agentAuthor, nativeGrant, ...rest } = entry;
    void agentAuthor;
    return author
      ? {
          ...rest,
          agentAuthor: author,
          ...(nativeGrant === undefined ? {} : { nativeGrant }),
        }
      : rest;
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

export function deleteUserPipelineLocalMetadata(pipelineId: string): void {
  const file = readMetadataFile();
  const key = userPipelineKey(pipelineId);
  if (!file.entries[key]) return;
  delete file.entries[key];
  writeMetadataFile(file);
}
