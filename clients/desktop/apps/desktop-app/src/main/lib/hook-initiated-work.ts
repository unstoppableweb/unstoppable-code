import {
  HookFiring,
  type HookChatClaims,
  type HookQueue,
  type HookFiringHost,
  type HookProjectOwner,
  type InitiatedWorkEngine,
} from '@canopy/core-runtime/node/initiated-work';
import type { HookDescriptor } from '@canopy/desktop-shared/types';
import {
  getActiveDesktopRuntime,
  getActiveDesktopRuntimeIfAccepting,
} from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { assertNotSplitLocked } from '../services/split-lock-service';
import { resolveProjectSavedOwner } from './project-owner';
import { readWorkspaceWorktreesDetailed } from './workspace-persistence';
import { assertWorkspaceTargetRuntimeStartAllowed } from './workspace-target-exclusion';

/*
 * The desktop host of the hook source (CAN-4146). The core hook source
 * (`HookFiring`) decides every firing's gates; this module supplies what it
 * reads from the desktop: the worktree's paused hooks, the split lock, the
 * deletion fence and the project's saved owner (CAN-4541).
 */

export type { HookProjectOwner };

/** The hook fields a firing needs; known before the hook's actions are read. */
export type HookIdentity = Pick<
  HookDescriptor,
  'hookKey' | 'triggerName' | 'target' | 'repoId'
>;

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

/**
 * The hook keys paused in a worktree, as the worktree list records them.
 * Throws when they can't be read, so the core hook source skips the firing
 * instead of running a hook that may be paused (CAN-7094): the list is
 * unreadable, it left the worktree's row out as unreadable, or the row's
 * paused keys are not a list of strings.
 */
export async function readPausedHookKeys(
  projectId: string,
  worktreeId: string,
): Promise<ReadonlySet<string>> {
  const list = await readWorkspaceWorktreesDetailed(projectId);
  const worktree = list.worktrees.find(
    (candidate) => candidate.id === worktreeId,
  );
  if (
    list.authority === 'unreadable' ||
    (list.authority === 'partial' && worktree === undefined)
  )
    throw list.unserved ?? new Error('The worktree list could not be read.');
  // Rows are stored as they were read, so the field is checked here.
  const paused: unknown = worktree?.pausedHookKeys;
  if (paused === undefined || paused === null) return new Set();
  if (!isStringList(paused))
    throw new Error("The worktree's paused hooks could not be read.");
  return new Set(paused);
}

/** The project's saved owner a hook run is authorized against. */
export async function resolveHookProjectOwner(
  projectId: string,
  worktreeId: string,
): Promise<HookProjectOwner> {
  const owner = await resolveProjectSavedOwner({ projectId, worktreeId });
  return owner.kind === 'none' ? { kind: 'personal' } : owner;
}

const DESKTOP_HOOK_FIRING_HOST: HookFiringHost = {
  pausedHookKeys: readPausedHookKeys,
  assertNotSplitLocked: (projectId, worktreeId): void => {
    assertNotSplitLocked(projectId, worktreeId, 'running a hook');
  },
  assertStartAllowed: assertWorkspaceTargetRuntimeStartAllowed,
  projectOwner: resolveHookProjectOwner,
  localAuthorityId: LOCAL_DESKTOP_AUTHORITY_ID,
};

const hookFirings = new WeakMap<InitiatedWorkEngine, HookFiring>();

function hookFiringFor(engine: InitiatedWorkEngine): HookFiring {
  let firing = hookFirings.get(engine);
  if (!firing) {
    firing = new HookFiring({ engine, host: DESKTOP_HOOK_FIRING_HOST });
    hookFirings.set(engine, firing);
  }
  return firing;
}

/** The hook source over the desktop runtime's initiated-work engine. */
export function getHookFiring(): HookFiring {
  return hookFiringFor(getActiveDesktopRuntime().initiatedWork);
}

export function getHookInitiatedWork(): InitiatedWorkEngine {
  return getActiveDesktopRuntime().initiatedWork;
}

export function getHookChatClaims(): HookChatClaims {
  return getActiveDesktopRuntime().hookChatClaims;
}

export function getHookQueue(): HookQueue {
  return getActiveDesktopRuntime().hookQueue;
}

/** The hook source, or null before the desktop runtime accepts work. */
export function getHookFiringIfAvailable(): HookFiring | null {
  const engine = getActiveDesktopRuntimeIfAccepting()?.initiatedWork;
  return engine ? hookFiringFor(engine) : null;
}

export function hookIdentity(hook: HookIdentity): HookIdentity {
  return {
    hookKey: hook.hookKey,
    triggerName: hook.triggerName,
    target: hook.target,
    ...(hook.repoId !== undefined ? { repoId: hook.repoId } : {}),
  };
}
