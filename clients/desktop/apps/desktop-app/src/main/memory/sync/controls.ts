import { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type MemorySyncConflict,
  type MemorySyncControlResult,
  type MemorySyncHistoryResult,
  type MemorySyncAuthor,
  type MemorySyncConflictAction,
  type MemorySyncPreviewResult,
  type MemorySyncScopeState,
  type MemorySyncSettingsPatch,
  type MemorySyncState,
  type MemorySyncUserScope,
} from '@canopy/desktop-shared/types';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import {
  MEMORY_SYNC_CAPABILITY,
  type MemoryRevisionRecord,
  type MemoryScopeRef,
  type MemorySyncStateFile,
} from '@canopy/protocol/memory-sync';
import { peekCanopyCloudAccount } from '../../lib/canopy-cloud-account-store';
import { readPreferencesFile } from '../../lib/preferences-store';
import { sendToWebContents } from '../../lib/web-contents-send';
import { previewMemoryMerge } from '../local/consolidation-task';
import { resolveLocalMemoryRunModel } from '../local/helper-model';
import type {
  MemoryFirstEnableMergeRunner,
  MemorySyncControlResult as EngineResult,
  MemorySyncEngine,
} from './engine';
import {
  currentMemorySyncEngine,
  freshWorkspaceProjectScope,
  listWorkspaceProjectMemory,
  onMemorySyncChange,
  setWorkspaceProjectMemoryMode,
} from './host';

/*
 * The Memory settings and panel's view of memory sync (design §14, §17): the
 * state they show and the controls they call, over the signed-in account's
 * engine. Every answer carries a fresh state, and every change is broadcast
 * to the windows, so a second window never shows an old switch.
 */

const USER_SCOPE: MemoryScopeRef = { kind: 'user' };
const BROADCAST_DEBOUNCE_MS = 250;

function availability(): MemorySyncState['availability'] {
  const entry = peekCanopyCloudAccount();
  if (entry === null || isGuestAccount(entry)) return 'signed_out';
  return entry.capabilities.includes(MEMORY_SYNC_CAPABILITY)
    ? 'available'
    : 'not_offered';
}

function latest(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

/**
 * The error the latest pass recorded, if any. A pass pulls first and then
 * commits and pushes, so an error recorded before the last pull is from an
 * earlier pass and no longer current; the state file keeps it regardless.
 */
function currentProblem(state: MemorySyncStateFile | null): string | null {
  const error = state?.lastError ?? null;
  if (error === null) return null;
  const pulled = state?.lastPulledAt ?? null;
  return pulled === null || Date.parse(error.at) >= Date.parse(pulled)
    ? error.code
    : null;
}

async function userScope(
  engine: MemorySyncEngine,
): Promise<MemorySyncUserScope> {
  const status = engine
    .status()
    .scopes.find((scope) => scope.scope.kind === 'user');
  const state = await engine.scopeState(USER_SCOPE).catch(() => null);
  let scopeState: MemorySyncScopeState = 'not_started';
  if (status?.mode === 'needs_first_enable') scopeState = 'needs_first_enable';
  else if (state !== null) {
    scopeState =
      state.firstEnable !== null && state.firstEnable.state !== 'done'
        ? 'merging'
        : state.mode;
  }
  const preMergeRevision =
    state?.firstEnable?.state === 'done' &&
    state.firstEnable.preMergeRevision !== null &&
    state.firstEnable.preMergeRevision >= 1 &&
    state.baseRevision > state.firstEnable.preMergeRevision
      ? state.firstEnable.preMergeRevision
      : null;
  return {
    state: scopeState,
    lastSyncedAt: latest(
      state?.lastPulledAt ?? null,
      state?.lastPushedAt ?? null,
    ),
    waitingToSend: status?.queuedOps ?? 0,
    keptOnDevice: state?.localOnlyNoteIds.length ?? 0,
    conflicts: (state?.conflicts ?? []).map((conflict) => ({
      path: conflict.path,
      detectedAt: conflict.detectedAt,
      reason: conflict.reason,
      merged: conflict.autoNotesQueued === true,
    })),
    preMergeRevision,
    problem: engine.status().retrying ? 'offline' : currentProblem(state),
  };
}

/**
 * The bound projects' memory, as the switch and the project's own merge
 * review show it (design §22), or none while sync is off for the account:
 * a per-project choice means nothing then, and the panel offers no switch.
 * `needsFirstEnable` comes from the engine's scope status, so building this
 * state reads no files.
 */
function projectMemory(engine: MemorySyncEngine): MemorySyncState['projects'] {
  if (engine.accountSettings()?.settings.enabled !== true) return [];
  const awaiting = new Set(
    engine
      .status()
      .scopes.filter(
        (scope) =>
          scope.scope.kind === 'project' &&
          (scope.mode === 'needs_first_enable' ||
            scope.mode === 'deleted_in_cloud'),
      )
      .map((scope) =>
        scope.scope.kind === 'project' ? scope.scope.projectId : '',
      ),
  );
  return listWorkspaceProjectMemory().map((memory) => ({
    workspaceId: memory.workspaceId,
    mode: memory.mode,
    state: memory.state,
    reason: memory.reason,
    changeable: memory.changeable,
    needsFirstEnable: awaiting.has(memory.projectId),
  }));
}

export async function getMemorySyncState(): Promise<MemorySyncState> {
  const offered = availability();
  const engine = offered === 'available' ? currentMemorySyncEngine() : null;
  if (engine === null) {
    return {
      availability: offered,
      connection: null,
      settings: null,
      user: null,
      projects: [],
      deviceLabel: null,
    };
  }
  const account = engine.accountSettings();
  return {
    availability: offered,
    connection: engine.status().state,
    settings:
      account === null
        ? null
        : {
            enabled: account.settings.enabled,
            userScope: account.settings.userScope,
            defaultProjectScope: account.settings.defaultProjectScope,
            serverConsolidation: account.settings.serverConsolidation,
            serverConsolidationAvailable:
              account.policy.serverConsolidationAvailable,
          },
    user: await userScope(engine),
    projects: projectMemory(engine),
    deviceLabel: engine.deviceLabel,
  };
}

async function withState(
  result: EngineResult<unknown>,
): Promise<MemorySyncControlResult> {
  const state = await getMemorySyncState();
  return result.ok
    ? { ok: true, state }
    : { ok: false, code: result.code, state };
}

function engineOrRefusal(): MemorySyncEngine | { ok: false; code: string } {
  return (
    currentMemorySyncEngine() ?? { ok: false, code: 'not_running' as const }
  );
}

export async function updateMemorySyncSettings(
  patch: MemorySyncSettingsPatch,
): Promise<MemorySyncControlResult> {
  const engine = engineOrRefusal();
  if ('ok' in engine) return withState(engine);
  return withState(await engine.updateSettings(patch));
}

/**
 * The merge consolidation on the user's memory model, writing nothing. A
 * project's merge names its workspace, so the model policy and the run are
 * those of the project's owner rather than Personal.
 */
const mergeRunner =
  (workspaceId: string | undefined): MemoryFirstEnableMergeRunner =>
  async (input, scopeTopics, scopeDir) => {
    const preferences = await readPreferencesFile();
    if (!preferences.localMemoryEnabled) {
      return {
        output: null,
        consumedFileKeys: [],
        model: null,
        reason: 'memory_off',
      };
    }
    const resolved = await resolveLocalMemoryRunModel(preferences, workspaceId);
    if ('refusal' in resolved) {
      return {
        output: null,
        consumedFileKeys: [],
        model: null,
        reason: 'model_unavailable',
      };
    }
    const result = await previewMemoryMerge(input, scopeTopics, {
      scopeDir,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      model: resolved.helperModel.model,
      thinkingLevel: resolved.helperModel.thinkingLevel,
      ...(resolved.helperModel.modelConfig
        ? { modelConfig: resolved.helperModel.modelConfig }
        : {}),
    });
    return result.output === null
      ? { ...result, reason: 'merge_failed' }
      : result;
  };

/**
 * The scope a control acts on: the user scope, or the cloud project the
 * workspace is bound to, resolved from its binding read again (design §22).
 * `not_bound` refuses a workspace that maps to no project scope now, so a
 * project unbound or relinked during a review never sends its memory.
 */
async function controlScope(
  workspaceId: string | undefined,
): Promise<MemoryScopeRef | { ok: false; code: string }> {
  if (workspaceId === undefined) return USER_SCOPE;
  return (
    (await freshWorkspaceProjectScope(workspaceId)) ?? {
      ok: false,
      code: 'not_bound' as const,
    }
  );
}

export async function previewMemorySyncMerge(
  workspaceId?: string,
): Promise<MemorySyncPreviewResult> {
  const engine = engineOrRefusal();
  if ('ok' in engine) return engine;
  const scope = await controlScope(workspaceId);
  if ('ok' in scope) return scope;
  const result = await engine.previewFirstEnable(
    scope,
    mergeRunner(workspaceId),
  );
  return result.ok ? { ok: true, preview: result.value } : result;
}

export async function applyMemorySyncMerge(
  previewId: string,
  workspaceId?: string,
): Promise<MemorySyncControlResult> {
  const engine = engineOrRefusal();
  if ('ok' in engine) return withState(engine);
  const scope = await controlScope(workspaceId);
  if ('ok' in scope) return withState(scope);
  const result = await engine.applyFirstEnable(scope, previewId);
  const state = await withState(result);
  return state.ok && result.ok
    ? { ...state, refusedNotes: result.value.refusedNotes }
    : state;
}

/**
 * Sets a bound project's "keep memories on this computer" switch for the
 * account, on every computer. The host reads the workspace's binding again
 * and refuses while the project is not bound, its Private memory decides,
 * or its binding no longer syncs.
 */
export async function setMemorySyncProjectMemory(
  workspaceId: string,
  keepOnThisComputer: boolean,
): Promise<MemorySyncControlResult> {
  const result = await setWorkspaceProjectMemoryMode(
    workspaceId,
    keepOnThisComputer ? 'device_only' : 'sync',
  );
  const state = await getMemorySyncState();
  return result.ok
    ? { ok: true, state }
    : { ok: false, code: result.reason, state };
}

export async function readMemorySyncConflict(
  path: string,
): Promise<MemorySyncConflict | null> {
  const engine = currentMemorySyncEngine();
  return engine === null ? null : engine.readConflict(USER_SCOPE, path);
}

export async function settleMemorySyncConflict(
  path: string,
  action: MemorySyncConflictAction,
): Promise<MemorySyncControlResult> {
  const engine = engineOrRefusal();
  if ('ok' in engine) return withState(engine);
  return withState(await engine.settleConflict(USER_SCOPE, path, action));
}

function author(record: MemoryRevisionRecord): MemorySyncAuthor {
  switch (record.holder.kind) {
    case 'desktop':
      return { kind: 'computer', name: record.holder.deviceLabel };
    case 'cloud':
      return { kind: 'cloud' };
    case 'web':
      return { kind: 'web' };
  }
}

export async function listMemorySyncHistory(
  before: number | null,
): Promise<MemorySyncHistoryResult> {
  const engine = engineOrRefusal();
  if ('ok' in engine) return engine;
  const result = await engine.listHistory(USER_SCOPE, before);
  if (!result.ok) return result;
  return {
    ok: true,
    revisions: result.value.revisions.map((record) => ({
      revision: record.revision,
      kind: record.kind,
      committedAt: record.committedAt,
      author: author(record),
      changedDocuments: record.changedPaths.length,
      consumedNotes: record.consumedNoteCount,
      restoredFromRevision: record.restoredFromRevision,
    })),
    nextBefore: result.value.nextBefore,
    currentRevision: result.value.baseRevision,
  };
}

export async function restoreMemorySyncRevision(
  revision: number,
): Promise<MemorySyncControlResult> {
  const engine = engineOrRefusal();
  if ('ok' in engine) return withState(engine);
  return withState(await engine.restoreRevision(USER_SCOPE, revision));
}

export async function deleteMemorySyncFromCloud(): Promise<MemorySyncControlResult> {
  const engine = engineOrRefusal();
  if ('ok' in engine) return withState(engine);
  const result = await engine.deleteFromCloud();
  if (result.ok) await engine.syncNow();
  return withState(result);
}

let broadcasting: (() => void) | null = null;

/**
 * Sends every window the new state after each change, debounced. The host
 * counts a binding, Private memory or per-project mode change as one, so a
 * project's switch moves without the user scope changing (design §22).
 */
export function startMemorySyncBroadcasts(): void {
  if (broadcasting !== null) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  broadcasting = onMemorySyncChange(() => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void getMemorySyncState().then((state) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
            sendToWebContents(
              window.webContents,
              IPC_CHANNELS.memorySyncChanged,
              state,
            );
          }
        }
      });
    }, BROADCAST_DEBOUNCE_MS);
    timer.unref?.();
  });
}
