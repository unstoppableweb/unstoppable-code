import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  pipelineDefinitionError,
  PipelineDefinitionSourceError,
} from '@canopy/core-runtime/node/pipeline';
import {
  PIPELINE_DEFINITION_LIST_MAX_LIMIT,
  PIPELINE_GRANTS,
  type CanopyCallerDescriptor,
  type CanopyWorkspaceScope,
  type PipelineDefinition,
  type PipelineDefinitionListParams,
  type PipelineDefinitionSource,
  type PipelineDefinitionSummary,
} from '@canopy/protocol/canopy-core';
import type {
  IPCResult,
  Pipeline,
  PipelineData,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import {
  getStoredPipelineIndexEntry,
  listStoredPipelines,
} from '@canopy/execution-engine/pipelines/store';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { getStoredPipelineBySource } from '../pipelines/pipeline-service';
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
  grants: [PIPELINE_GRANTS.read, PIPELINE_GRANTS.write],
};

/** The Portal reading definitions for a paired browser. */
export const PIPELINE_DEFINITION_PORTAL_CALLER: CanopyCallerDescriptor = {
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
): Promise<IPCResult<PipelineInfo>> {
  if (
    write.rawContent !== undefined &&
    rawContentMismatch(write.rawContent, write.content)
  )
    return {
      success: false,
      error: 'Raw pipeline document does not match parsed pipeline content.',
    };
  const idempotencyKey = randomUUID();
  try {
    const { definition } = await getDesktopCanopyRuntime().instruction(
      'core.pipeline.definition.upsert',
      {
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
      },
      { caller, metadata: { idempotencyKey } },
    );
    void republishOwnerAutomation(definition.definitionId);
    return {
      success: true,
      data: savedPipelineInfo(definition, write.content),
    };
  } catch (error) {
    return { success: false, error: pipelineWriteErrorMessage(error) };
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
): PipelineInfo {
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
}

/**
 * Installs a curated or shared definition as a user pipeline through core,
 * which reads and validates the remote itself, and answers with the store's
 * legacy row. Throws core's typed error for the caller to word.
 */
export async function importRemotePipeline(
  input: RemotePipelineImport,
  caller: CanopyCallerDescriptor = PIPELINE_DEFINITION_DESKTOP_CALLER,
): Promise<PipelineInfo> {
  const idempotencyKey = randomUUID();
  const { definition } = await getDesktopCanopyRuntime().instruction(
    'core.pipeline.definition.import',
    {
      remoteDefinitionId: input.remoteDefinitionId,
      targetScope: {},
      expectedRemoteVersion: input.expectedRemoteVersion,
      nameOverride: input.nameOverride,
      ...(input.definitionId === undefined
        ? {}
        : { definitionId: input.definitionId }),
      _meta: { idempotencyKey },
    },
    { caller, metadata: { idempotencyKey } },
  );
  return savedPipelineInfo(definition, parsePipelineText(definition.document));
}

/** Deletes a user pipeline through core, with the store's effects. */
export async function deleteUserPipeline(
  id: string,
  expectedRevision: number | null,
  caller: CanopyCallerDescriptor = PIPELINE_DEFINITION_DESKTOP_CALLER,
): Promise<IPCResult> {
  const idempotencyKey = randomUUID();
  try {
    await getDesktopCanopyRuntime().instruction(
      'core.pipeline.definition.delete',
      { definitionId: id, expectedRevision, _meta: { idempotencyKey } },
      { caller, metadata: { idempotencyKey } },
    );
    return { success: true };
  } catch (error) {
    return { success: false, error: pipelineWriteErrorMessage(error) };
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
  },
  caller: CanopyCallerDescriptor = PIPELINE_DEFINITION_DESKTOP_CALLER,
): Promise<IPCResult<PipelineInfo>> {
  const idempotencyKey = randomUUID();
  try {
    // The copy's provenance step reuses what its source read presented.
    const { definition } = await withPipelinePresentation(() =>
      getDesktopCanopyRuntime().instruction(
        'core.pipeline.definition.duplicate',
        {
          sourceDefinitionId,
          scope: options.scope ?? {},
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.expectedChecksum === undefined
            ? {}
            : { expectedChecksum: options.expectedChecksum }),
          _meta: { idempotencyKey },
        },
        { caller, metadata: { idempotencyKey } },
      ),
    );
    const stored = getStoredPipelineBySource('user', definition.definitionId);
    if (!stored.success || !stored.data)
      return {
        success: false,
        error: stored.error ?? 'Failed to read the copied workflow',
      };
    return { success: true, data: stored.data.info };
  } catch (error) {
    return { success: false, error: pipelineWriteErrorMessage(error) };
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
  return withPipelineEnablementCommit(async () => {
    await getDesktopCanopyRuntime().instruction(
      'core.pipeline.definition.setEnabled',
      { definitionId, enabled, _meta: { idempotencyKey } },
      { caller, metadata: { idempotencyKey } },
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

/** {@link readDesktopPipeline}, with the checksum of the document core read. */
export function readDesktopPipelineSnapshot(
  definitionId: string,
  scope: CanopyWorkspaceScope,
  caller: CanopyCallerDescriptor,
  agentPlace?: AgentPlace,
): Promise<{ data: PipelineData; checksum: string }> {
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
