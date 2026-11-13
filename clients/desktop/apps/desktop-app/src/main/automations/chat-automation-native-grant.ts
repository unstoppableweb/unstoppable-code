/**
 * Native grants (CAN-5479): a converted agent automation keeps exactly the
 * settings its native chat action had, and gains nothing.
 *
 * A run an agent's automation starts is agent-originated, and D11 refuses
 * such a run a new chat's plugins, approval mode and Orchestrator model. The
 * native action ran with them, so its conversion records them, main-only, as
 * the owned pipeline's grant, bound to the automation and to the pipeline's
 * revision and content as saved. The send step honors the grant only for
 * that automation's own top-level run of exactly that definition; any other
 * write (an agent's `pipeline.update`, a person's editor save) fails it
 * closed. Everything else about the run stays agent-originated.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ChatAutomationAction } from '@canopy/desktop-shared/lib/chat-automation-conversion';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { stableStringify } from '@canopy/desktop-shared/lib/stable-hash';
import type { PipelineHostActionCaller } from '@canopy/execution-engine/node/pipelines/executor/types';
import type {
  AutomationAction,
  ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import type { Pipeline } from '@canopy/execution-engine/types/pipeline';
import type {
  PipelineLocalMetadata,
  PipelineNativeGrant,
  PipelineNativeGrantAuthority,
} from '../pipelines/pipeline-local-metadata-store';

/** `values` in a fixed order, so the same set always compares equal. */
function sortedBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => {
    const a = key(left);
    const b = key(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Selections that choose something, normalized, with an empty optional list
 * the same as none: a plugin collection's stored selections always carry
 * them (CAN-5479). Order doesn't count: a run's collection lists its
 * defaults before its preferences, whatever order the chat chose them in.
 * Else no selections.
 */
function chosenSelections(
  selections: ChatTabPluginSelections | undefined,
): ChatTabPluginSelections | undefined {
  if (selections === undefined) return undefined;
  const {
    collectionIds,
    skillRefs,
    pluginRefs,
    mcpServerRefs,
    mcpHttpAuthPreferences,
    unresolvedCapabilities,
    ...normalized
  } = normalizePluginSelections(selections);
  const chosen: ChatTabPluginSelections = {
    ...normalized,
    collectionIds: sortedBy(collectionIds, (id) => id),
    skillRefs: sortedBy(skillRefs, stableStringify),
    pluginRefs: sortedBy(pluginRefs, stableStringify),
    ...((mcpServerRefs?.length ?? 0) > 0
      ? { mcpServerRefs: sortedBy(mcpServerRefs ?? [], stableStringify) }
      : {}),
    ...((mcpHttpAuthPreferences?.length ?? 0) > 0
      ? {
          mcpHttpAuthPreferences: sortedBy(
            mcpHttpAuthPreferences ?? [],
            stableStringify,
          ),
        }
      : {}),
    ...(unresolvedCapabilities !== undefined
      ? {
          unresolvedCapabilities: sortedBy(
            unresolvedCapabilities,
            stableStringify,
          ),
        }
      : {}),
  };
  return chosen.collectionIds.length > 0 ||
    chosen.skillRefs.length > 0 ||
    chosen.pluginRefs.length > 0 ||
    (chosen.mcpServerRefs?.length ?? 0) > 0
    ? chosen
    : undefined;
}

/** The authority D11 would refuse an agent's run of `action`, if any. */
export function nativeGrantAuthority(
  action: AutomationAction,
): PipelineNativeGrantAuthority | undefined {
  // Only a chat a run creates; a send into an existing chat never converts
  // with authority.
  if (
    action.type !== 'worktree_prompt' &&
    action.type !== 'standalone_prompt' &&
    action.type !== 'app_advisor_prompt'
  )
    return undefined;
  const authority: PipelineNativeGrantAuthority = {
    ...(action.approvalMode !== undefined
      ? { approvalMode: action.approvalMode }
      : {}),
    ...((action.plugins?.length ?? 0) > 0 ? { plugins: action.plugins } : {}),
    ...(action.type === 'app_advisor_prompt' && action.model !== undefined
      ? { model: action.model }
      : {}),
    ...withSelections(action.pluginSelections),
  };
  return Object.keys(authority).length > 0 ? authority : undefined;
}

function withSelections(
  selections: ChatTabPluginSelections | undefined,
): Pick<PipelineNativeGrantAuthority, 'pluginSelections'> {
  const chosen = chosenSelections(selections);
  return chosen === undefined ? {} : { pluginSelections: chosen };
}

/** The authority fields alone; no grant is the empty authority. */
function authorityOf(
  authority: PipelineNativeGrantAuthority | undefined,
): PipelineNativeGrantAuthority {
  return {
    ...(authority?.approvalMode !== undefined
      ? { approvalMode: authority.approvalMode }
      : {}),
    ...((authority?.plugins?.length ?? 0) > 0
      ? { plugins: authority?.plugins }
      : {}),
    ...(authority?.model !== undefined ? { model: authority.model } : {}),
    ...withSelections(authority?.pluginSelections),
  };
}

export function sameNativeGrantAuthority(
  left: PipelineNativeGrantAuthority | undefined,
  right: PipelineNativeGrantAuthority | undefined,
): boolean {
  return (
    stableStringify(authorityOf(left)) === stableStringify(authorityOf(right))
  );
}

/**
 * The chat action with exactly `authority`'s settings: an agent's update
 * converts back with the authority the automation had, never with what a
 * hand edit to its pipeline set.
 */
export function withNativeGrantAuthority(
  action: ChatAutomationAction,
  authority: PipelineNativeGrantAuthority | undefined,
): ChatAutomationAction {
  if (action.type === 'worktree_session_prompt') return action;
  const {
    approvalMode: _mode,
    plugins: _plugins,
    pluginSelections: _selections,
    ...rest
  } = action;
  void _mode;
  void _plugins;
  void _selections;
  const granted = authorityOf(authority);
  const settings = {
    ...(granted.approvalMode !== undefined
      ? { approvalMode: granted.approvalMode }
      : {}),
    ...(granted.plugins !== undefined ? { plugins: granted.plugins } : {}),
    ...(granted.pluginSelections !== undefined
      ? { pluginSelections: granted.pluginSelections }
      : {}),
  };
  if (rest.type !== 'app_advisor_prompt') return { ...rest, ...settings };
  const { model: _model, ...advisor } = rest;
  void _model;
  return {
    ...advisor,
    ...settings,
    ...(granted.model !== undefined ? { model: granted.model } : {}),
  };
}

/** A pipeline definition's hash, key order aside. */
export function nativeGrantContentHash(content: unknown): string {
  return `sha256:${createHash('sha256')
    .update(stableStringify(content))
    .digest('hex')}`;
}

/**
 * The authority an agent's update of an owned pipeline must keep: the
 * grant's, else none once an agent has written the pipeline, else (only a
 * person and main have written it) its own.
 */
export function ownedPipelineAuthority(
  automationId: string,
  metadata: PipelineLocalMetadata,
  fromPipeline: ChatAutomationAction,
): PipelineNativeGrantAuthority | undefined {
  const grant = metadata.nativeGrant;
  if (grant !== undefined && grant.automationId === automationId)
    return authorityOf(grant);
  if (metadata.agentAuthor !== undefined) return undefined;
  return nativeGrantAuthority(fromPipeline);
}

/** What the grant check reads; injected in tests. */
export interface NativeGrantRunFacts {
  metadata: (pipelineId: string) => PipelineLocalMetadata;
  /** The stored user pipeline as it is now. */
  stored: (
    pipelineId: string,
  ) => { revision?: number; content: Pipeline } | undefined;
  /** The run's own record, as the executor persisted it. */
  execution: (executionId: string) => Promise<
    | {
        pipelineId: string;
        parentExecutionId?: string;
        /** The executed definition, as normalized for the run. */
        snapshot: unknown;
      }
    | undefined
  >;
  /** A stored definition as the executor normalizes it. */
  normalize: (content: Pipeline) => unknown;
}

async function defaultFacts(): Promise<NativeGrantRunFacts> {
  const [
    { readPipelineLocalMetadata },
    { getStoredPipelineBySource },
    { loadExecutionState },
    { normalizePipeline },
    { getDefaultShellTypeForCurrentProcess },
    { getDataDir },
  ] = await Promise.all([
    import('../pipelines/pipeline-local-metadata-store'),
    import('../pipelines/pipeline-service'),
    import('@canopy/execution-engine/node/pipelines/executor/execution-state'),
    import('@canopy/execution-engine/pipelines/normalize-pipeline'),
    import('@canopy/execution-engine/node/pipelines/default-shell'),
    import('../lib/paths'),
  ]);
  return {
    metadata: (pipelineId) =>
      readPipelineLocalMetadata({
        type: 'stored',
        source: 'user',
        value: pipelineId,
      }),
    stored: (pipelineId) => {
      const read = getStoredPipelineBySource('user', pipelineId);
      return read.success && read.data
        ? {
            ...(read.data.info.revision !== undefined
              ? { revision: read.data.info.revision }
              : {}),
            content: read.data.content,
          }
        : undefined;
    },
    execution: async (executionId) => {
      const state = await loadExecutionState(
        executionId,
        join(getDataDir(), 'pipeline-executions'),
      ).catch(() => null);
      return state
        ? {
            pipelineId: state.pipeline_id,
            ...(state.parent_execution_id !== undefined
              ? { parentExecutionId: state.parent_execution_id }
              : {}),
            snapshot: state.pipeline_snapshot,
          }
        : undefined;
    },
    normalize: (content) =>
      normalizePipeline(content, {
        defaultShell: getDefaultShellTypeForCurrentProcess(),
      }),
  };
}

/**
 * The native grant a send step may honor, or `undefined`: only an
 * agent-originated run that the grant's own automation started, of the
 * pipeline that automation owns (never a child run), executing exactly the
 * revision and content the grant was minted for. Anything unreadable fails
 * closed.
 */
export async function resolvePipelineNativeGrant(
  caller: Pick<
    PipelineHostActionCaller,
    'executionId' | 'pipelineId' | 'agentOrigin' | 'initiator'
  >,
  facts?: NativeGrantRunFacts,
): Promise<PipelineNativeGrant | undefined> {
  const { initiator, pipelineId, agentOrigin } = caller;
  if (
    agentOrigin === undefined ||
    initiator?.kind !== 'automation' ||
    pipelineId === undefined
  )
    return undefined;
  try {
    const read = facts ?? (await defaultFacts());
    const metadata = read.metadata(pipelineId);
    const grant = metadata.nativeGrant;
    if (
      grant === undefined ||
      grant.automationId !== initiator.automationId ||
      metadata.ownerAutomationId !== initiator.automationId
    )
      return undefined;
    const stored = read.stored(pipelineId);
    if (
      stored === undefined ||
      stored.revision !== grant.pipelineRevision ||
      nativeGrantContentHash(stored.content) !== grant.contentHash
    )
      return undefined;
    const execution = await read.execution(caller.executionId);
    if (
      execution === undefined ||
      execution.parentExecutionId !== undefined ||
      execution.pipelineId !== pipelineId ||
      // As persisted: key order aside, and an undefined field is no field.
      stableStringify(execution.snapshot) !==
        stableStringify(read.normalize(stored.content))
    )
      return undefined;
    return grant;
  } catch {
    return undefined;
  }
}
