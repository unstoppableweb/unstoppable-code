import { PipelineDefinitionSourceError } from '@canopy/core-runtime/node/pipeline';
import type {
  WorkerPipelineHostRequest,
  WorkerPipelineHostResult,
  WorkerPipelineOwnerResult,
} from '@canopy/protocol/canopy-core';
import { hashPipelinePackageYaml } from '@canopy/desktop-shared/node';
import { prunePipelinePreferenceSelections } from '@canopy/execution-engine/node/pipelines/plugin-collection-store';
import {
  getStoredPipelineBySource,
  getStoredPipelineIndexEntry,
  getStoredPipelineText,
  readStoredPipelineIndexStatus,
  readStoredPipelinePresence,
} from '@canopy/execution-engine/pipelines/store';
import {
  readSharedItemSubscriptionLedger,
  recordSharedItemLocalUninstall,
} from '../canopy-cloud/shared-item-subscriptions';
import { notifyDesktopInventoryChanged } from '../services/desktop-inventory-sync-signals';
import {
  applyUserPipelineDeleteEffects,
  applyUserPipelineSaveEffects,
  assertPersonalProjectCopy,
  assertWritableContext,
  readPipelineCopySource,
  recordPipelineCopyOrigin,
} from './core-pipeline-definition-sources';
import {
  setDaemonPipelineOwnerScopeHandler,
  type DaemonPipelineOwnerAnswer,
} from './daemon-pipeline-owner';
import {
  deleteUserPipelineLocalMetadata,
  userPipelineLocalMetadataIds,
} from './pipeline-local-metadata-store';
import {
  listPackageInstalls,
  removePackageInstall,
} from './pipeline-package-service';
import { pipelineResourceContextEnabled } from './resource-lanes';

/*
 * Electron main answers the definitions' owner requests (CAN-7522) for a
 * daemon that commits definition writes: the checks it runs before an
 * in-process write, the desktop's own effects around the commit, and a
 * reconcile pass whenever it attaches. Every effect is keyed by the
 * definition, so applying one twice leaves the same state.
 */

type DefinitionAction = Extract<
  WorkerPipelineHostRequest['request'],
  { action: 'owner.definition.precheck' | 'owner.definition.effects' }
>;

const EFFECTS_APPLIED: WorkerPipelineHostResult = {
  status: 'owner',
  value: { kind: 'definition.effects' },
};

const STORED_USER_PREFIX = 'stored:user:';

type PrecheckAnswer = Extract<
  WorkerPipelineOwnerResult,
  { kind: 'definition.precheck' }
>['answer'];

function precheckResult(answer: PrecheckAnswer): WorkerPipelineHostResult {
  return { status: 'owner', value: { kind: 'definition.precheck', answer } };
}

async function precheck(
  action: Extract<DefinitionAction, { action: 'owner.definition.precheck' }>,
  signal: AbortSignal,
): Promise<WorkerPipelineHostResult> {
  try {
    if (action.op === 'duplicate') {
      if (!action.origin) throw new Error('A copy names its source.');
      // An organization's project workflow is never copied out as Personal.
      if (
        action.origin.source === 'project' &&
        pipelineResourceContextEnabled()
      )
        await assertPersonalProjectCopy(action.scope.workspaceId);
      const source = await readPipelineCopySource(
        action.origin,
        action.scope,
        signal,
      );
      return precheckResult({ allowed: true, ...(source && { source }) });
    }
    if (action.definitionId === null)
      throw new Error('An edit or delete names its definition.');
    await assertWritableContext(action.definitionId);
    return precheckResult({ allowed: true });
  } catch (error) {
    if (
      error instanceof PipelineDefinitionSourceError &&
      (error.code === 'core.pipeline.contextMismatch' ||
        error.code === 'core.pipeline.definitionNotFound')
    )
      return precheckResult({
        allowed: false,
        code:
          error.code === 'core.pipeline.contextMismatch'
            ? 'contextMismatch'
            : 'definitionNotFound',
        message: error.message.slice(0, 1024),
      });
    throw error;
  }
}

async function applyEffects(
  action: Extract<DefinitionAction, { action: 'owner.definition.effects' }>,
  signal: AbortSignal,
): Promise<void> {
  if (action.op === 'reconcile') {
    await reconcileDaemonDefinitionOwnerState(signal);
    return;
  }
  const { definitionId } = action;
  if (definitionId === null) throw new Error('A write names its definition.');
  switch (action.op) {
    case 'upsert':
      if (action.phase === 'afterCommit')
        applyUserPipelineSaveEffects(definitionId);
      return;
    case 'delete':
      if (action.phase === 'afterCommit')
        await applyUserPipelineDeleteEffects(definitionId);
      return;
    case 'duplicate':
      if (action.phase === 'beforeCommit' && action.origin)
        await recordPipelineCopyOrigin(action.origin, definitionId);
      else if (action.phase === 'afterCommit')
        notifyDesktopInventoryChanged(['pipelines']);
      return;
  }
}

type DefinitionPresence = 'present' | 'absent' | 'unreadable';

/**
 * Whether the user store holds a definition, as the store reads it: a row
 * whose document is gone, or a document no row lists, holds none. A
 * malformed row, a read that fails, a document that doesn't parse, or an
 * index that isn't sound is unreadable.
 */
function readDefinitionPresence(id: string): DefinitionPresence {
  const indexed = readStoredPipelinePresence(id);
  // Read after the presence, so an index that went missing during it counts.
  if (readStoredPipelineIndexStatus() !== 'ok') return 'unreadable';
  if (indexed !== 'present') return indexed;
  return getStoredPipelineBySource('user', id).success
    ? 'present'
    : 'unreadable';
}

/**
 * Leaves the desktop's state as if every committed write's effects had run
 * (CAN-7522): the local metadata, plugin collection preferences,
 * subscription-ledger entries and package installs of a definition the store
 * no longer holds go, as does a package install whose copy was edited.
 *
 * Each definition's absence is read from the store right before its
 * sidecar is removed, never inferred from a listing. A definition that can't
 * be read keeps everything, and the pass fails so the next attach asks
 * again. A withdrawn request stops before its next removal.
 */
export async function reconcileDaemonDefinitionOwnerState(
  signal: AbortSignal,
): Promise<void> {
  const status = readStoredPipelineIndexStatus();
  if (status !== 'ok')
    throw new Error(
      `The workflow list is ${status}, so nothing was reconciled.`,
    );
  const unreadable = new Set<string>();
  // Each read and the removal it allows run with no await between them.
  const absent = (id: string): boolean => {
    signal.throwIfAborted();
    const presence = readDefinitionPresence(id);
    if (presence === 'unreadable') unreadable.add(id);
    return presence === 'absent';
  };

  for (const install of await listPackageInstalls()) {
    const id = install.localPipelineId;
    if (absent(id)) {
      // A bundled definition keeps its install; a user copy shadows it.
      if (getStoredPipelineIndexEntry(id, 'bundled') === null)
        await removePackageInstall(id);
      continue;
    }
    if (unreadable.has(id)) continue;
    const text = getStoredPipelineText(id);
    if (
      text.success &&
      text.data !== undefined &&
      hashPipelinePackageYaml(text.data) !== install.pipelineContentHash
    ) {
      signal.throwIfAborted();
      await removePackageInstall(id);
    }
  }

  for (const id of userPipelineLocalMetadataIds() ?? [])
    if (absent(id)) deleteUserPipelineLocalMetadata(id);

  signal.throwIfAborted();
  await prunePipelinePreferenceSelections((entries) => {
    let changed = false;
    for (const [key, entry] of Object.entries(entries)) {
      if (signal.aborted) return changed;
      if (!key.startsWith(STORED_USER_PREFIX)) continue;
      if (
        typeof entry !== 'object' ||
        entry === null ||
        !('plugin_collections' in entry)
      )
        continue;
      if (!absent(key.slice(STORED_USER_PREFIX.length))) continue;
      Reflect.deleteProperty(entry, 'plugin_collections');
      changed = true;
    }
    return changed;
  }, 'electron_main');

  signal.throwIfAborted();
  const ledger = await readSharedItemSubscriptionLedger();
  for (const install of ledger.installs)
    if (install.kind === 'pipeline')
      for (const localId of install.localIds)
        if (absent(localId))
          recordSharedItemLocalUninstall({ kind: 'pipeline', localId });

  notifyDesktopInventoryChanged(['pipelines']);
  if (unreadable.size > 0)
    throw new Error(
      `${unreadable.size} workflow${unreadable.size === 1 ? '' : 's'} could not be read, so their records were kept.`,
    );
}

/*
 * A reconcile runs alone: the checks and effects of writes wait for it, and
 * it waits for those in flight. The daemon asks for no write's check while
 * its reconcile request is pending, but it stops waiting at the deadline or
 * a withdrawal; until this side's pass has stopped too, no edit, delete or
 * copy can be checked, so none can commit under it.
 */
let reconciling: Promise<void> | null = null;
let requestsInFlight = 0;
const requestsDone: (() => void)[] = [];

async function besideOtherRequests<T>(run: () => Promise<T>): Promise<T> {
  while (reconciling) await reconciling;
  requestsInFlight += 1;
  try {
    return await run();
  } finally {
    requestsInFlight -= 1;
    if (requestsInFlight === 0)
      for (const done of requestsDone.splice(0)) done();
  }
}

async function alone(run: () => Promise<void>): Promise<void> {
  while (reconciling) await reconciling;
  const turn = (async (): Promise<void> => {
    if (requestsInFlight > 0)
      await new Promise<void>((done) => requestsDone.push(done));
    await run();
  })();
  // Every later caller waits while this is set, so nothing else replaces it.
  const ended = (): void => {
    reconciling = null;
  };
  reconciling = turn.then(ended, ended);
  return turn;
}

/** One definition owner request, answered (CAN-7522). */
export async function answerDaemonDefinitionOwnerRequest(
  request: WorkerPipelineHostRequest,
  signal: AbortSignal,
): Promise<DaemonPipelineOwnerAnswer> {
  const action = request.request;
  if (action.action === 'owner.definition.precheck')
    return {
      result: await besideOtherRequests(() => precheck(action, signal)),
    };
  if (action.action === 'owner.definition.effects') {
    if (action.op === 'reconcile')
      await alone(() => applyEffects(action, signal));
    else await besideOtherRequests(() => applyEffects(action, signal));
    return { result: EFFECTS_APPLIED };
  }
  return {
    result: {
      status: 'failure',
      failureReason: null,
      message: 'This app does not answer that request for workflows.',
      outputs: {},
    },
  };
}

/** Answers the definitions' owner requests from now on; set once. */
export function registerDaemonDefinitionOwnerRequests(): void {
  setDaemonPipelineOwnerScopeHandler(
    'core:pipeline-definitions',
    answerDaemonDefinitionOwnerRequest,
  );
}
