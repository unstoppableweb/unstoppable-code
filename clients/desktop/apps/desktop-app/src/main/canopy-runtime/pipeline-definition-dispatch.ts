import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  CanopyClientError,
  deliverCanopy,
  toCanopyClientError,
  type CanopyClientInstructionOptions,
} from '@canopy/core-client';
import {
  CANOPY_OUTCOME_UNKNOWN_MESSAGE,
  CanopyOutcomeUnknownError,
} from '@canopy/core-client/outcome';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  pipelineDefinitionError,
  pipelineDefinitionOwnerKey,
  PipelineDefinitionSourceError,
} from '@canopy/core-runtime/node/pipeline';
import {
  isUnknownKeyedWriteOutcome,
  PIPELINE_DEFINITION_IMPORT_GRANTS,
  PIPELINE_DEFINITION_LIST_MAX_LIMIT,
  PIPELINE_GRANTS,
  type CanopyCallerDescriptor,
  type CanopyWorkspaceScope,
  type PipelineDefinition,
  type PipelineDefinitionDeleteParams,
  type PipelineDefinitionDeleteResult,
  type PipelineDefinitionDuplicateParams,
  type PipelineDefinitionDuplicateResult,
  type PipelineDefinitionImportParams,
  type PipelineDefinitionImportResult,
  type PipelineDefinitionListParams,
  type PipelineDefinitionSetEnabledParams,
  type PipelineDefinitionSetEnabledResult,
  type PipelineDefinitionSource,
  type PipelineDefinitionSummary,
  type PipelineDefinitionUpsertParams,
  type PipelineDefinitionUpsertResult,
} from '@canopy/protocol/canopy-core';
import type {
  IPCResultWithOutcome,
  Pipeline,
  PipelineAgentAuthor,
  PipelineData,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import {
  getStoredPipelineIndexEntry,
  listStoredPipelines,
  type StoredPipelineInfo,
} from '@canopy/execution-engine/pipelines/store';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { getStoredPipelineBySource } from '../pipelines/pipeline-service';
import {
  registerPendingDefinitionOwner,
  type PendingDefinitionOwner,
} from '../pipelines/daemon-definition-pending-owners';
import { withRequiredUserPipelineMarker } from '../pipelines/pipeline-local-metadata-store';
import { withPipelineEnablementCommit } from '../pipelines/pipeline-enablement-commit';
import {
  withPipelinePresentation,
  type PipelinePresentation,
} from '../pipelines/pipeline-definition-presentation';
import { buildSharedPipelineInfo } from '../pipelines/shared-pipeline-info';
import { getDesktopCanopyRuntime } from './desktop-runtime-access';
import { withAgentPlace, type AgentPlace } from './agent-place';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

/*
 * The `core.pipeline.definition.*` projection shared by the pipeline IPC
 * handlers, the Portal and the agent pipeline actions. Each caller keeps its
 * legacy result shape and records the owner and agent author of what it
 * wrote; core resolves, validates and lists definitions, refuses stale
 * revisions and read-only sources, and runs the store's effects.
 */

/** Electron main writing on behalf of the desktop window. */
export const PIPELINE_DEFINITION_DESKTOP_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-main-pipeline-definitions',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [
    PIPELINE_GRANTS.read,
    PIPELINE_GRANTS.write,
    ...PIPELINE_DEFINITION_IMPORT_GRANTS,
  ],
};

/** The Portal reading definitions for a paired browser. */
export const PIPELINE_DEFINITION_REMOTE_CONTROL_CALLER: CanopyCallerDescriptor =
  {
    principalId: 'local-desktop-user',
    clientInstanceId: 'electron-main-portal',
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'portal',
    grants: [PIPELINE_GRANTS.read],
  };

/** An agent pipeline action through the injected Canopy tools. */
export const PIPELINE_DEFINITION_AGENT_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-main-agent-actions',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'mcp',
  grants: [PIPELINE_GRANTS.read, PIPELINE_GRANTS.write],
};

/**
 * A routed write's owner (CAN-7507), or how to read it when the write is
 * routed: an in-process write never reads it.
 */
export type PendingDefinitionOwnerSource =
  | PendingDefinitionOwner
  | (() => Promise<PendingDefinitionOwner | undefined>);

/** The definition writes main can send to a daemon route (CAN-7507). */
export type PipelineDefinitionWriteOperation =
  | 'upsert'
  | 'delete'
  | 'duplicate'
  | 'setEnabled'
  | 'import';

/**
 * The daemon route for main's definition writes. `serves` is the routing
 * decision alone, read at each call: a session that is down still answers
 * true, and the write then fails with the route's typed error.
 */
export interface PipelineDefinitionWriteRoute {
  serves(operation: PipelineDefinitionWriteOperation): boolean;
  /**
   * The client instance the daemon knows this route's connection by, so a
   * routed write's owner is registered under the key the daemon derives.
   */
  readonly clientInstanceId: string;
  upsert(
    params: PipelineDefinitionUpsertParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<PipelineDefinitionUpsertResult>;
  delete(
    params: PipelineDefinitionDeleteParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<PipelineDefinitionDeleteResult>;
  duplicate(
    params: PipelineDefinitionDuplicateParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<PipelineDefinitionDuplicateResult>;
  setEnabled(
    params: PipelineDefinitionSetEnabledParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<PipelineDefinitionSetEnabledResult>;
  import(
    params: PipelineDefinitionImportParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<PipelineDefinitionImportResult>;
}

let definitionWriteRoute: (() => PipelineDefinitionWriteRoute | null) | null =
  null;

/**
 * Where main's definition writes go, set once: the same provider again is
 * ignored and another one throws. With no provider, or a null route, the
 * writes stay in process.
 */
export function setPipelineDefinitionRouteProvider(
  provider: () => PipelineDefinitionWriteRoute | null,
): void {
  if (definitionWriteRoute === provider) return;
  if (definitionWriteRoute !== null)
    throw new Error('The pipeline definition route provider is already set.');
  definitionWriteRoute = provider;
}

/**
 * Sends one keyed write in process, or on the daemon route when it serves
 * the operation. A routed write is resent with the same key when its reply
 * is lost, so a retry answers with the first write's outcome. A routed write
 * that may have landed fails as {@link CanopyOutcomeUnknownError} and is
 * never resent under another key: once any attempt ends unknown, even if a
 * later attempt is refused, or when delivery ends with an attempt still
 * out, such as a reply that never comes before the deadline. It never falls
 * back to the in-process writer: a daemon failure is the caller's typed
 * error.
 */
async function sendDefinitionWrite<Result>(
  operation: PipelineDefinitionWriteOperation,
  idempotencyKey: string,
  inProcess: () => Promise<Result>,
  routed: (
    route: PipelineDefinitionWriteRoute,
    options: CanopyClientInstructionOptions,
  ) => Promise<Result>,
  {
    marker,
    owner,
  }: {
    marker?: RequiredUserPipelineMarker;
    owner?: PendingDefinitionOwnerSource;
  } = {},
): Promise<Result> {
  const route = definitionWriteRoute?.() ?? null;
  if (marker) {
    if (route?.serves(operation))
      throw new PipelineDefinitionSourceError(
        'core.pipeline.sourceUnavailable',
        'The workflow’s author could not be recorded by its writer.',
        { reason: 'finalization_failed' },
      );
    return withRequiredUserPipelineMarker(
      marker.author,
      marker.owner,
      inProcess,
      marker.preservePending,
    );
  }
  if (!route?.serves(operation)) return inProcess();
  const pending = typeof owner === 'function' ? await owner() : owner;
  // A routed create's id is the daemon's, so its owner is recorded before
  // the commit from what is registered here (CAN-7507). The caller still
  // records it once the write answers.
  const release =
    pending &&
    registerPendingDefinitionOwner(
      pipelineDefinitionOwnerKey(route.clientInstanceId, idempotencyKey),
      pending,
    );
  try {
    const result = await deliverDefinitionWrite(route, idempotencyKey, routed);
    release?.('settled');
    return result;
  } catch (error) {
    release?.(
      error instanceof CanopyOutcomeUnknownError ? 'unknown' : 'settled',
    );
    throw error;
  }
}

async function deliverDefinitionWrite<Result>(
  route: PipelineDefinitionWriteRoute,
  idempotencyKey: string,
  routed: (
    route: PipelineDefinitionWriteRoute,
    options: CanopyClientInstructionOptions,
  ) => Promise<Result>,
): Promise<Result> {
  let uncertain = false;
  let inFlight = false;
  return deliverCanopy(
    async ({ signal }) => {
      inFlight = true;
      try {
        return await routed(route, {
          metadata: { idempotencyKey },
          signal,
        });
      } catch (error) {
        if (isUnknownKeyedWriteOutcome(toCanopyClientError(error).payload))
          uncertain = true;
        else if (!signal.aborted) inFlight = false;
        throw error;
      }
    },
    { replay: 'same_idempotency_key' },
  ).catch((error: unknown) => {
    throw uncertain ||
      inFlight ||
      (error instanceof CanopyClientError &&
        isUnknownKeyedWriteOutcome(error.payload))
      ? new CanopyOutcomeUnknownError()
      : error;
  });
}

export interface RequiredUserPipelineMarker {
  author: PipelineAgentAuthor | null;
  owner?: string;
  preservePending?: true;
}

export type UserPipelineWriteResult =
  IPCResultWithOutcome<StoredPipelineInfo> & {
    markerRefused?: true;
    revisionRefused?: true;
  };

/** A failed write's result; an unknown outcome is reported as unknown. */
function failedDefinitionWrite(
  error: unknown,
): Omit<UserPipelineWriteResult, 'data'> {
  const failure =
    error instanceof PipelineDefinitionSourceError
      ? error.sourceCause
      : pipelineSourceFailure(error);
  if (typeof failure === 'object' && failure !== null && 'reason' in failure) {
    if (failure.reason === 'finalization_unconfirmed')
      return {
        success: false,
        outcome: 'unknown',
        error: CANOPY_OUTCOME_UNKNOWN_MESSAGE,
      };
    if (failure.reason === 'finalization_failed')
      return {
        success: false,
        markerRefused: true,
        error: pipelineWriteErrorMessage(error),
      };
  }
  if (
    error instanceof CanopyOperationError &&
    (error.payload.code === 'core.pipeline.revisionConflict' ||
      error.payload.code === 'core.pipeline.definitionNotFound')
  )
    return {
      success: false,
      revisionRefused: true,
      error: pipelineWriteErrorMessage(error),
    };
  return error instanceof CanopyOutcomeUnknownError
    ? {
        success: false,
        outcome: 'unknown',
        error: CANOPY_OUTCOME_UNKNOWN_MESSAGE,
      }
    : { success: false, error: pipelineWriteErrorMessage(error) };
}

export interface UserPipelineWrite {
  /** Absent creates a pipeline under a new id. */
  id?: string;
  /** The revision the caller loaded; absent writes without a precondition. */
  expectedRevision?: number;
  name: string;
  description: string;
  icon: string;
  content: Pipeline;
  /** Validated bytes to keep verbatim instead of serializing `content`. */
  rawContent?: string;
  /** Absent keeps the pipeline's enabled state. */
  enabled?: boolean;
  /**
   * Who owns a new pipeline, recorded before a routed create commits
   * (CAN-7507); the caller still records it after the save.
   */
  owner?: PendingDefinitionOwnerSource;
}

/** The message a legacy caller showed for a failed read or write. */
export function pipelineWriteErrorMessage(error: unknown): string {
  if (error instanceof CanopyOperationError) return error.payload.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether raw bytes parse to something other than the content sent beside
 * them. Core keeps the bytes, so the pair must agree, as the store required;
 * unparsable bytes are left for core to refuse.
 */
function rawContentMismatch(rawContent: string, content: Pipeline): boolean {
  let raw: Pipeline;
  try {
    raw = { ...parsePipelineText(rawContent) };
  } catch {
    return false;
  }
  const parsed = { ...content };
  delete raw.readonly;
  delete parsed.readonly;
  return !isDeepStrictEqual(raw, parsed);
}

/**
 * A saved pipeline an automation owns changes what that automation's chat
 * stands for (CAN-4551), so windows get the automations snapshot again and
 * an open editor sees the change. Best effort: a stale save is refused
 * regardless.
 */
async function republishOwnerAutomation(pipelineId: string): Promise<void> {
  try {
    const { readPipelineLocalMetadata } =
      await import('../pipelines/pipeline-local-metadata-store');
    const { ownerAutomationId } = readPipelineLocalMetadata({
      type: 'stored',
      source: 'user',
      value: pipelineId,
    });
    if (ownerAutomationId === undefined) return;
    const { getAutomationsService } = await import('../automations/service');
    await getAutomationsService().republish();
  } catch {
    // Nothing to tell the windows; their next snapshot carries the change.
  }
}

/**
 * Saves a user pipeline through core and answers with the store's legacy
 * row, so callers keep their result shape.
 */
export async function saveUserPipeline(
  write: UserPipelineWrite,
  caller: CanopyCallerDescriptor = PIPELINE_DEFINITION_DESKTOP_CALLER,
  marker?: RequiredUserPipelineMarker,
): Promise<UserPipelineWriteResult> {
  if (
    write.rawContent !== undefined &&
    rawContentMismatch(write.rawContent, write.content)
  )
    return {
      success: false,
      error: 'Raw pipeline document does not match parsed pipeline content.',
    };
  const idempotencyKey = randomUUID();
  const params: PipelineDefinitionUpsertParams = {
    definitionId: write.id ?? null,
    expectedRevision: write.expectedRevision ?? null,
    scope: {},
    source: 'user',
    name: write.name,
    description: write.description,
    icon: write.icon,
    ...(write.enabled === undefined ? {} : { enabled: write.enabled }),
    format: 'yaml',
    document: write.rawContent ?? { pipeline: write.content },
    _meta: { idempotencyKey },
  };
  try {
    const { definition } = await sendDefinitionWrite(
      'upsert',
      idempotencyKey,
      () =>
        getDesktopCanopyRuntime().instruction(
          'core.pipeline.definition.upsert',
          params,
          { caller, metadata: { idempotencyKey } },
        ),
      (route, options) => route.upsert(params, options),
      { marker, owner: write.id === undefined ? write.owner : undefined },
    );
    void republishOwnerAutomation(definition.definitionId);
    return {
      success: true,
      data: savedPipelineInfo(definition, write.content),
    };
  } catch (error) {
    return failedDefinitionWrite(error);
  }
}

/**
 * The legacy row for a saved definition. Everything a save changes comes
 * from the snapshot core returned, so a later writer's revision is never
 * paired with this caller's content; the store supplies only what an id
 * fixes (file name, share link and curated origin).
 */
function savedPipelineInfo(
  definition: PipelineDefinition,
  content: Pipeline,
): StoredPipelineInfo {
  const stored = getStoredPipelineBySource('user', definition.definitionId);
  const row = stored.success ? stored.data?.info : undefined;
  return {
    id: definition.definitionId,
    name: definition.name,
    filename: row?.filename ?? `${definition.definitionId}.yaml`,
    description: definition.description,
    icon: definition.icon,
    createdAt: definition.createdAt ?? row?.createdAt ?? '',
    updatedAt: definition.updatedAt ?? row?.updatedAt ?? '',
    ...(row?.curatedOrigin ? { curatedOrigin: row.curatedOrigin } : {}),
    ...(row?.remote ? { remote: row.remote } : {}),
    triggerTypes: definition.triggerTypes,
    stepCount: Object.values(content.jobs).reduce(
      (count, job) => count + job.steps.length,
      0,
    ),
    scopes: definition.executionScopes,
    revision: definition.revision,
    source: 'user',
    readonly: false,
  };
}

export interface RemotePipelineImport {
  /** The `curated:` or `shared:` definition to install. */
  remoteDefinitionId: string;
  /** The content hash the caller reviewed; `null` installs the current one. */
  expectedRemoteVersion: string | null;
  /** `null` keeps the remote's name. */
  nameOverride: string | null;
  /** A user pipeline the install replaces; absent creates one. */
  definitionId?: string;
  /** Who owns the installed pipeline, recorded before a routed import commits. */
  owner?: PendingDefinitionOwnerSource;
}

/**
 * Installs a curated or shared definition as a user pipeline through core,
 * which reads and validates the remote itself, and answers with the store's
 * legacy row. A daemon route that serves imports takes it, keyed like the
 * other writes. Throws core's typed error for the caller to word.
 */
export async function importRemotePipeline(
  input: RemotePipelineImport,
  caller: CanopyCallerDescriptor = PIPELINE_DEFINITION_DESKTOP_CALLER,
): Promise<PipelineInfo> {
  const idempotencyKey = randomUUID();
  const params: PipelineDefinitionImportParams = {
    remoteDefinitionId: input.remoteDefinitionId,
    targetScope: {},
    expectedRemoteVersion: input.expectedRemoteVersion,
    nameOverride: input.nameOverride,
    ...(input.definitionId === undefined
      ? {}
      : { definitionId: input.definitionId }),
    _meta: { idempotencyKey },
  };
  const { definition } = await sendDefinitionWrite(
    'import',
    idempotencyKey,
    () =>
      getDesktopCanopyRuntime().instruction(
        'core.pipeline.definition.import',
        params,
        { caller, metadata: { idempotencyKey } },
      ),
    (route, options) => route.import(params, options),
    { owner: input.owner },
  );
  return savedPipelineInfo(definition, parsePipelineText(definition.document));
}

/** Deletes a user pipeline through core, with the store's effects. */
export async function deleteUserPipeline(
  id: string,
  expectedRevision: number | null,
  caller: CanopyCallerDescriptor = PIPELINE_DEFINITION_DESKTOP_CALLER,
): Promise<IPCResultWithOutcome & { revisionRefused?: true }> {
  const idempotencyKey = randomUUID();
  const params: PipelineDefinitionDeleteParams = {
    definitionId: id,
    expectedRevision,
    _meta: { idempotencyKey },
  };
  try {
    await sendDefinitionWrite(
      'delete',
      idempotencyKey,
      () =>
        getDesktopCanopyRuntime().instruction(
          'core.pipeline.definition.delete',
          params,
          { caller, metadata: { idempotencyKey } },
        ),
      (route, options) => route.delete(params, options),
    );
    return { success: true };
  } catch (error) {
    return failedDefinitionWrite(error);
  }
}

/** Every definition a list names, across its pages. */
/**
 * Runs a read as `caller`, from the agent place main passes for its own
 * agent reads (CAN-6032). Core checks the CAN-4551 owned-workflow rule
 * against that place, never against the read's scope.
 */
function asCaller<Result>(
  caller: CanopyCallerDescriptor,
  agentPlace: AgentPlace | undefined,
  read: () => Promise<Result>,
): Promise<Result> {
  return agentPlace ? withAgentPlace(caller, agentPlace, read) : read();
}

export async function listPipelineDefinitions(
  params: Omit<PipelineDefinitionListParams, 'cursor' | 'limit' | '_meta'>,
  caller: CanopyCallerDescriptor,
  agentPlace?: AgentPlace,
): Promise<{
  items: PipelineDefinitionSummary[];
  unavailableSources: PipelineDefinitionSource[];
}> {
  const items: PipelineDefinitionSummary[] = [];
  let unavailableSources: PipelineDefinitionSource[] = [];
  let cursor: string | undefined;
  do {
    const pageParams = {
      ...params,
      limit: PIPELINE_DEFINITION_LIST_MAX_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    };
    const page = await asCaller(caller, agentPlace, () =>
      getDesktopCanopyRuntime().query(
        'core.pipeline.definition.list',
        pageParams,
        { caller },
      ),
    );
    items.push(...page.items);
    unavailableSources = page.unavailableSources;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return { items, unavailableSources };
}

export async function getPipelineDefinition(
  definitionId: string,
  scope: CanopyWorkspaceScope,
  caller: CanopyCallerDescriptor,
  agentPlace?: AgentPlace,
): Promise<PipelineDefinition> {
  return (
    await asCaller(caller, agentPlace, () =>
      getDesktopCanopyRuntime().query(
        'core.pipeline.definition.get',
        { definitionId, scope },
        { caller },
      ),
    )
  ).definition;
}

/**
 * Copies any readable definition through core as a new user pipeline and
 * answers with the store's row for it.
 */
export async function duplicatePipelineDefinition(
  sourceDefinitionId: string,
  options: {
    scope?: CanopyWorkspaceScope;
    name?: string;
    /** The source checksum the caller checked; a changed source is refused. */
    expectedChecksum?: string;
    /** Who owns the copy, recorded before a routed copy commits. */
    owner?: PendingDefinitionOwnerSource;
  },
  caller: CanopyCallerDescriptor = PIPELINE_DEFINITION_DESKTOP_CALLER,
  marker?: RequiredUserPipelineMarker,
): Promise<UserPipelineWriteResult> {
  const idempotencyKey = randomUUID();
  const params: PipelineDefinitionDuplicateParams = {
    sourceDefinitionId,
    scope: options.scope ?? {},
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.expectedChecksum === undefined
      ? {}
      : { expectedChecksum: options.expectedChecksum }),
    _meta: { idempotencyKey },
  };
  try {
    // The copy's provenance step reuses what its source read presented.
    const { definition } = await withPipelinePresentation(() =>
      sendDefinitionWrite(
        'duplicate',
        idempotencyKey,
        () =>
          getDesktopCanopyRuntime().instruction(
            'core.pipeline.definition.duplicate',
            params,
            { caller, metadata: { idempotencyKey } },
          ),
        (route, callOptions) => route.duplicate(params, callOptions),
        { marker, owner: options.owner },
      ),
    );
    return {
      success: true,
      data: savedPipelineInfo(
        definition,
        parsePipelineText(definition.document),
      ),
    };
  } catch (error) {
    return failedDefinitionWrite(error);
  }
}

/**
 * Records through core whether a definition of any source is enabled, and
 * answers with the preferences that write committed.
 */
export async function setPipelineDefinitionEnabled(
  definitionId: string,
  enabled: boolean,
  caller: CanopyCallerDescriptor = PIPELINE_DEFINITION_DESKTOP_CALLER,
): Promise<PreferencesData | undefined> {
  const idempotencyKey = randomUUID();
  const params: PipelineDefinitionSetEnabledParams = {
    definitionId,
    enabled,
    _meta: { idempotencyKey },
  };
  return withPipelineEnablementCommit(async () => {
    await sendDefinitionWrite(
      'setEnabled',
      idempotencyKey,
      () =>
        getDesktopCanopyRuntime().instruction(
          'core.pipeline.definition.setEnabled',
          params,
          { caller, metadata: { idempotencyKey } },
        ),
      (route, options) => route.setEnabled(params, options),
    );
  });
}

/** What core lists, as the desktop's rows, in core's order. */
export interface DesktopPipelineListing {
  rows: PipelineInfo[];
  /** Optional sources that could not be read; their rows are missing. */
  unavailableSources: PipelineDefinitionSource[];
  /** Why each unavailable source failed, when its read said. */
  sourceFailures: Partial<Record<PipelineDefinitionSource, unknown>>;
}

/**
 * Lists definitions through core and answers with the desktop's legacy
 * rows. Core decides which definitions are listed and in what order; a
 * row's display details come from the store's index or, for catalog,
 * share and project rows, from the source read that listed them.
 */
export async function listDesktopPipelines(
  params: Omit<PipelineDefinitionListParams, 'cursor' | 'limit' | '_meta'>,
  caller: CanopyCallerDescriptor,
  agentPlace?: AgentPlace,
): Promise<DesktopPipelineListing> {
  return withPipelinePresentation(async (presentation) => {
    const listed = await listPipelineDefinitions(params, caller, agentPlace);
    const stored = new Map<string, PipelineInfo>();
    if (
      listed.items.some(
        (item) => item.source === 'bundled' || item.source === 'user',
      )
    )
      for (const row of listStoredPipelines().data ?? [])
        stored.set(`${row.source}\0${row.id}`, row);
    return {
      rows: listed.items.flatMap((item) => {
        const row = listedRow(item, stored, presentation);
        return row ? [row] : [];
      }),
      unavailableSources: listed.unavailableSources,
      sourceFailures: Object.fromEntries(
        listed.unavailableSources.map((source) => [
          source,
          presentation.sourceFailure(source),
        ]),
      ),
    };
  });
}

function listedRow(
  item: PipelineDefinitionSummary,
  stored: ReadonlyMap<string, PipelineInfo>,
  presentation: PipelinePresentation,
): PipelineInfo | undefined {
  if (item.source === 'bundled' || item.source === 'user')
    return stored.get(`${item.source}\0${item.definitionId}`);
  const presented = presentation.pipeline(
    'listed',
    item.source,
    item.definitionId,
  );
  if (presented?.kind === 'info') return presented.info;
  if (presented?.kind === 'shared')
    return buildSharedPipelineInfo({ pipeline: presented.pipeline });
  return undefined;
}

/**
 * Reads one definition through core and answers with the desktop's legacy
 * data: the document core resolved, parsed, with the store's index entry or
 * the source read's catalog, share or project details. Throws core's error.
 */
export async function readDesktopPipeline(
  definitionId: string,
  scope: CanopyWorkspaceScope,
  caller: CanopyCallerDescriptor,
  agentPlace?: AgentPlace,
): Promise<PipelineData> {
  return (
    await readDesktopPipelineSnapshot(definitionId, scope, caller, agentPlace)
  ).data;
}

/**
 * {@link readDesktopPipeline}, with the document core read and authorized,
 * and its checksum.
 */
export function readDesktopPipelineSnapshot(
  definitionId: string,
  scope: CanopyWorkspaceScope,
  caller: CanopyCallerDescriptor,
  agentPlace?: AgentPlace,
): Promise<{ data: PipelineData; checksum: string; document: string }> {
  return withPipelinePresentation(async (presentation) => {
    const definition = await getPipelineDefinition(
      definitionId,
      scope,
      caller,
      agentPlace,
    );
    return {
      data: desktopPipelineData(definition, presentation),
      checksum: definition.checksum,
      document: definition.document,
    };
  });
}

function desktopPipelineData(
  definition: PipelineDefinition,
  presentation: PipelinePresentation,
): PipelineData {
  const { definitionId } = definition;
  const content = parsePipelineText(definition.document);
  if (definition.source === 'bundled' || definition.source === 'user') {
    const entry = getStoredPipelineIndexEntry(definitionId, definition.source);
    if (entry)
      return {
        info: {
          ...entry,
          // The revision is the document's own, never a later save's: a
          // caller sends it back as the write's precondition.
          ...(definition.source === 'user'
            ? { revision: definition.revision }
            : {}),
          scopes: entry.scopes ?? definition.executionScopes,
          source: definition.source,
          readonly: definition.source === 'bundled',
        },
        content,
        rawContent: definition.document,
      };
  }
  const presented = presentation.pipeline(
    'read',
    definition.source,
    definitionId,
  );
  if (presented?.kind === 'data') return { ...presented.data, content };
  if (presented?.kind === 'info') return { info: presented.info, content };
  if (presented?.kind === 'shared')
    return {
      info: buildSharedPipelineInfo({
        pipeline: presented.pipeline,
        scopes: definition.executionScopes,
      }),
      content,
    };
  throw pipelineDefinitionError(
    'core.pipeline.sourceUnavailable',
    `Workflow unavailable: ${definitionId}`,
  );
}

/** Whether core found no definition under the id it was asked for. */
export function isPipelineDefinitionNotFound(error: unknown): boolean {
  return (
    error instanceof CanopyOperationError &&
    error.payload.code === 'core.pipeline.definitionNotFound'
  );
}

/**
 * The source's own failure behind a core read error, which legacy callers
 * classify (an account error, an HTTP status), or an error with core's
 * message when core refused the read itself.
 */
export function pipelineSourceFailure(error: unknown): unknown {
  if (!(error instanceof CanopyOperationError)) return error;
  const cause = error.runtimeCause;
  if (cause instanceof PipelineDefinitionSourceError)
    return cause.sourceCause ?? new Error(cause.message);
  return cause instanceof Error ? cause : new Error(error.payload.message);
}
