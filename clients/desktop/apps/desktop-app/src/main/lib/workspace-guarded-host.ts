import {
  CoreWorkspacePluginsUpdateResultSchema,
  CoreWorktreeCommandResultSchema,
  CoreWorktreeHooksSetPausedResultSchema,
  type CanopyCallerDescriptor,
  type CanopyWorkspaceScope,
  type CoreWorkspaceHooksUpdateParams,
  type CoreWorkspacePluginsUpdateParams,
  type CoreWorkspacePluginsUpdateResult,
  type CoreWorktreeCommandResult,
  type CoreWorktreeHooksSetPausedResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import type {
  CoreWorkspaceGuardedCall,
  CoreWorkspaceGuardedHost,
  CoreWorktreeMetadataPatch,
} from '@canopy/core-runtime/node/workspace/guarded-commands';
import {
  CoreGuardedRefusedError,
  type CoreGuardedRefusal,
} from '@canopy/core-runtime/node/workspace/guarded-wire-errors';
import type { ScriptHookSettingsSource } from '@canopy/core-runtime/node/w5/workspace-metadata/settings';
import type { HookAction, HookInputMap } from '@canopy/desktop-shared/hooks';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import { fingerprintW5File } from '@canopy/core-runtime/node/w5/commit-log/fingerprint';
import {
  projectWorktree,
  readWorktreeRevisionEvidence,
} from '../canopy-runtime/core-workspace-adapter';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import {
  runWorkspaceMetadataProjection,
  takeWorkspaceMetadataProjection,
  WorkspaceMetadataProjectionAnswered,
} from '../canopy-runtime/workspace-metadata-dispatch';
import { updateCoworkWorkspaceSettings } from './cowork-workspace-crud';
import { CoworkWorkspaceRecordRefusedError } from './cowork-workspace-records';
import { getWorkspaceWorktreesFilePath } from './paths';
import { readAllSidebarItems } from './sidebar-items';
import { W5FileWriteRefusedError } from './w5-commit-log-file-store';
import { currentW5CommitScope } from './w5-commit-scope';
import type { W5WireDecisionCall } from './w5-single-decision-operation';
import { admitWorkspace } from './workspace-metadata-host';
import {
  isStoredHookAction,
  readWorkspaceConfig,
} from './workspace-persistence';
import {
  updateWorkspacePlugins,
  WorkspacePluginsRefusedError,
  type WorkspacePluginsUpdateOutcome,
  type WorkspacePluginsUserChange,
} from './workspace-plugin-defaults';
import {
  updateWorkspaceRetention,
  WorkspaceRetentionRefusedError,
} from './workspace-retention';
import {
  setWorktreeHooksPaused,
  updateWorkspaceHooks,
  type WorkspaceHooksChange,
} from './workspace-script-hook-settings';
import {
  moveWorktree,
  updateWorktree,
  WorktreeUpdateRefusedError,
} from './worktree-update';

/*
 * The desktop host behind the registered guarded commands (W7b-1b,
 * CAN-5549; W7b-1c, CAN-5568). An IPC projection's call runs the host
 * request its projection carries, unchanged (`workspace-guarded-dispatch.ts`).
 * Any other caller is a wire call: it reaches the same W5d2 boundary with
 * receipts that name its principal (`daemon:<principalId>:<source>`),
 * addressing that runs before any reservation (RR5), and the page's result.
 */

const SCOPE_UNAVAILABLE_MESSAGE = 'The selected worktree scope is unavailable.';
const WORKTREE_NOT_FOUND_MESSAGE = 'Worktree not found.';
const REVISION_UNVERIFIED_MESSAGE =
  "This worktree's revision can't be verified, so nothing was changed.";

/** A wire caller's settings source, as W7a's metadata host names it. */
function settingsSource(
  caller: CanopyCallerDescriptor,
): ScriptHookSettingsSource {
  return caller.interfaceKind === 'portal' ? 'portal' : 'desktop';
}

function wireCall<Outcome>(
  call: CoreWorkspaceGuardedCall,
  options: Omit<W5WireDecisionCall<Outcome>, 'principalId'> = {},
): W5WireDecisionCall<Outcome> {
  return { principalId: call.caller.principalId, ...options };
}

/** A desktop refusal as the core refusal the wire maps, when it has one. */
function coreRefusal(error: unknown): CoreGuardedRefusal | undefined {
  if (
    error instanceof WorktreeUpdateRefusedError ||
    error instanceof WorkspaceRetentionRefusedError
  )
    return error.reason;
  if (error instanceof WorkspacePluginsRefusedError)
    return error.reason === 'invalid-change' ? 'invalid-request' : error.reason;
  // `identity-changed` is a staged Cowork creation's; no settings save
  // raises it, so it stays untyped.
  if (
    error instanceof CoworkWorkspaceRecordRefusedError &&
    error.reason !== 'identity-changed'
  )
    return error.reason;
  return undefined;
}

/**
 * Runs a wire call's boundary, reporting its desktop refusals as the core
 * refusal the wire maps; the boundary's error stays the runtime cause.
 */
async function wireRefusals<T>(command: () => Promise<T>): Promise<T> {
  try {
    return await command();
  } catch (error) {
    const reason = coreRefusal(error);
    if (reason !== undefined && error instanceof Error)
      throw new CoreGuardedRefusedError(reason, error.message, error);
    throw error;
  }
}

type WireHookMap = NonNullable<
  Extract<
    CoreWorkspaceHooksUpdateParams['change'],
    { kind: 'replace' }
  >['hooks']
>;

/**
 * A page hook map as the desktop stores it. An action the stored read would
 * drop (a blank prompt, a non-string model) is refused before any key is
 * used, rather than saved as success without it.
 */
function hookMap(map: WireHookMap | undefined): HookInputMap | undefined {
  if (map === undefined) return undefined;
  const hooks: HookInputMap = {};
  for (const [trigger, actions] of Object.entries(map)) {
    if (actions === null) {
      hooks[trigger] = null;
      continue;
    }
    const stored: HookAction[] = [];
    for (const action of actions) {
      if (!isStoredHookAction(action))
        throw new CoreGuardedRefusedError(
          'invalid-request',
          'A hook action is not valid.',
        );
      stored.push(action);
    }
    hooks[trigger] = stored;
  }
  return hooks;
}

/** The page's hook maps, as the desktop stores them. */
function hooksChange(
  change: CoreWorkspaceHooksUpdateParams['change'],
): WorkspaceHooksChange {
  return change.kind === 'replace'
    ? { kind: 'replace', hooks: hookMap(change.hooks) }
    : {
        kind: 'repositories',
        repos: change.repos.map((repo) => ({
          repoId: repo.repoId,
          hooks: hookMap(repo.hooks),
        })),
      };
}

function resultUnavailable(
  message = "This worktree's details can't be returned here, so nothing was changed.",
): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'capability_unavailable',
    message,
    details: { reason: 'result-unavailable' },
    retry: { kind: 'never' },
  });
}

/**
 * #9's result: the saved outcome, with the default selections in their
 * persisted shape. One the page cannot carry is refused inside the decision,
 * before it commits (`admitOutcome`).
 */
function pluginsResult(
  outcome: WorkspacePluginsUpdateOutcome,
): CoreWorkspacePluginsUpdateResult {
  const result = CoreWorkspacePluginsUpdateResultSchema.safeParse(outcome);
  if (!result.success)
    throw resultUnavailable(
      "These default plugins can't be returned here, so nothing was changed.",
    );
  return result.data;
}

/** The page's change, as the desktop boundary takes it. */
function pluginsChange(
  change: CoreWorkspacePluginsUpdateParams['change'],
): WorkspacePluginsUserChange {
  return change.kind === 'setDefaults'
    ? {
        kind: 'setDefaults',
        defaultPluginSelections: change.defaultPluginSelections,
      }
    : {
        kind: 'selectRecommended',
        selections: change.selections,
        optOutKeys: change.optOutKeys,
        clearOptOutKeys: change.clearOptOutKeys,
      };
}

/**
 * #22's result: the saved outcome's row as `core.worktree.get` projects it
 * (D-2), without a revision or write time. A row the result cannot carry is
 * refused inside the decision, before it commits (`admitOutcome`).
 */
function worktreeResult(
  workspaceId: string,
  worktree: WorktreeData,
): CoreWorktreeCommandResult {
  const result = CoreWorktreeCommandResultSchema.safeParse(
    projectWorktree(workspaceId, worktree),
  );
  if (!result.success) throw resultUnavailable();
  return result.data;
}

function pausedResult(outcome: unknown): CoreWorktreeHooksSetPausedResult {
  const result = CoreWorktreeHooksSetPausedResultSchema.safeParse(outcome);
  if (!result.success) throw resultUnavailable();
  return result.data;
}

/**
 * The selected scope, as `core.worktree.get` checks it: a field this host
 * cannot select is refused, and another worktree's id is not this one.
 */
function checkWorktreeScope(
  worktreeId: string,
  scope: CanopyWorkspaceScope | undefined,
): void {
  if (!scope) return;
  if (
    scope.targetId !== undefined ||
    (scope.authorityId !== undefined &&
      scope.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID) ||
    scope.chatId !== undefined ||
    scope.operationId !== undefined ||
    scope.executionId !== undefined ||
    scope.repoId !== undefined
  )
    throw new CoreGuardedRefusedError(
      'scope-unavailable',
      SCOPE_UNAVAILABLE_MESSAGE,
    );
  if (scope.worktreeId !== undefined && scope.worktreeId !== worktreeId)
    throw new CoreGuardedRefusedError('not-found', WORKTREE_NOT_FOUND_MESSAGE);
}

/**
 * The workspace of an unscoped worktree id, found as `core.worktree.get`
 * finds it: in a code workspace (of the organization, when one is selected),
 * and refused when more than one has it.
 */
async function resolveWorktreeWorkspace(
  worktreeId: string,
  organizationId: string | undefined,
): Promise<string> {
  const sidebar = await readAllSidebarItems({ persistRemovalCleanup: false });
  let match: string | undefined;
  for (const item of sidebar.items) {
    if (
      item.type === 'cowork' ||
      (organizationId !== undefined &&
        item.owner?.organizationId !== organizationId)
    )
      continue;
    if (!item.worktrees.some((worktree) => worktree.id === worktreeId))
      continue;
    if (match !== undefined)
      throw new CoreGuardedRefusedError(
        'ambiguous-worktree',
        'Workspace scope required for ambiguous worktree ID.',
      );
    match = item.id;
  }
  if (match === undefined)
    throw new CoreGuardedRefusedError('not-found', WORKTREE_NOT_FOUND_MESSAGE);
  return match;
}

/** RR5 for a scoped #22: the workspace, in the selected organization. */
async function admitScopedWorkspace(
  workspaceId: string,
  organizationId: string | undefined,
): Promise<void> {
  await admitWorkspace(workspaceId, 'not-found');
  if (organizationId === undefined) return;
  const config = await readWorkspaceConfig(workspaceId);
  if (config.owner?.organizationId !== organizationId)
    throw new CoreGuardedRefusedError('not-found', WORKTREE_NOT_FOUND_MESSAGE);
}

/**
 * DP-1 for #22's required revision, as the row's `core.worktree.get` read
 * decides it: a row the read cannot find is `not-found`, and one whose
 * revision it withholds for any reason but `no-revision` is refused, so the
 * counter is compared only where the read would publish it and a refusal
 * never carries it. `no-revision` (a verified list whose row has no
 * committed revision) proceeds, and the commit-log check accepts only `0`.
 * Returns the verified list's fingerprint, which the decision's preimage
 * must match (`admitVerifiedList`).
 */
async function admitRevisionProvenance(
  workspaceId: string,
  worktreeId: string,
): Promise<string | null> {
  const evidence = await readWorktreeRevisionEvidence(workspaceId, worktreeId);
  if (evidence === null)
    throw new CoreGuardedRefusedError('not-found', WORKTREE_NOT_FOUND_MESSAGE);
  const { eligibility, listFingerprint } = evidence;
  if (
    listFingerprint !== undefined &&
    (eligibility.status === 'eligible' || eligibility.reason === 'no-revision')
  )
    return listFingerprint;
  throw new CoreGuardedRefusedError(
    eligibility.status === 'unverified' && eligibility.reason === 'pending'
      ? 'revision-pending'
      : 'revision-unverified',
    REVISION_UNVERIFIED_MESSAGE,
  );
}

/**
 * Inside the decision, before it commits: the list it rewrites must be the
 * one `admitRevisionProvenance` verified, so an edit outside the commit log
 * between the two is refused as a concurrent write (the preflight then holds
 * that preimage until the commit). A decision that writes nothing has
 * nothing to check.
 */
function admitVerifiedList(
  workspaceId: string,
  fingerprint: string | null,
): void {
  const scope = currentW5CommitScope();
  if (!scope) return;
  const path = getWorkspaceWorktreesFilePath(workspaceId);
  const preimage = scope.files.get(path) ?? scope.observed.get(path);
  if (preimage && fingerprintW5File(preimage.previousRaw) !== fingerprint)
    throw new W5FileWriteRefusedError(path);
}

function desktopWorktreePatch(
  patch: CoreWorktreeMetadataPatch,
): Parameters<typeof updateWorktree>[0]['patch'] {
  const {
    label,
    hidden,
    pinned,
    branchGroupingOverride,
    trackedBaseBranch,
    trackedRepoBaseBranches,
  } = patch;
  return {
    ...(label !== undefined && { label }),
    ...(hidden !== undefined && { hidden }),
    ...(pinned !== undefined && { pinned }),
    ...(branchGroupingOverride !== undefined && { branchGroupingOverride }),
    ...(trackedBaseBranch !== undefined && { trackedBaseBranch }),
    ...(trackedRepoBaseBranches !== undefined && { trackedRepoBaseBranches }),
  };
}

function revisioned(expectedRevision: number | undefined): {
  expectedRevision?: number;
} {
  return expectedRevision === undefined ? {} : { expectedRevision };
}

export const desktopWorkspaceGuardedHost: CoreWorkspaceGuardedHost = {
  async updateHooks(input, call) {
    const projection = takeWorkspaceMetadataProjection(
      'core.workspace.hooks.update',
    );
    if (projection) {
      await runWorkspaceMetadataProjection(projection);
      return;
    }
    await updateWorkspaceHooks(
      {
        workspaceId: input.workspaceId,
        ...revisioned(input.expectedRevision),
        change: hooksChange(input.change),
        source: settingsSource(call.caller),
        idempotencyKey: call.idempotencyKey,
      },
      // An unknown workspace has no manifest (as #6 and #8 refuse it).
      wireCall(call, {
        admitAddress: () =>
          admitWorkspace(input.workspaceId, 'configuration-unavailable'),
      }),
    );
  },
  async updatePlugins(input, call) {
    const projection = takeWorkspaceMetadataProjection(
      'core.workspace.plugins.update',
    );
    if (projection) {
      const outcome = await runWorkspaceMetadataProjection(projection);
      // The IPC caller keeps the full host outcome, including legacy selections.
      return { workspaceId: outcome.workspaceId, written: outcome.written };
    }
    return pluginsResult(
      await wireRefusals(() =>
        updateWorkspacePlugins(
          {
            workspaceId: input.workspaceId,
            ...revisioned(input.expectedRevision),
            change: pluginsChange(input.change),
            // One source for every wire change, so a key names one caller.
            source: 'workspace_settings',
            idempotencyKey: call.idempotencyKey,
          },
          wireCall(call, {
            admitAddress: () => admitWorkspace(input.workspaceId, 'not-found'),
            admitOutcome: (outcome) => {
              pluginsResult(outcome);
            },
          }),
        ),
      ),
    );
  },
  async updateCoworkSettings(input, call) {
    const projection = takeWorkspaceMetadataProjection(
      'core.workspace.cowork.update',
    );
    const outcome = projection
      ? await runWorkspaceMetadataProjection(projection)
      : await wireRefusals(() =>
          updateCoworkWorkspaceSettings(
            {
              projectId: input.workspaceId,
              ...revisioned(input.expectedRevision),
              ...input.settings,
              idempotencyKey: call.idempotencyKey,
            },
            wireCall(call, {
              admitAddress: () =>
                admitWorkspace(input.workspaceId, 'not-found'),
            }),
          ),
        );
    return { workspaceId: outcome.workspaceId };
  },
  async updateRetention(input, call) {
    const projection = takeWorkspaceMetadataProjection(
      'core.workspace.retention.update',
    );
    const outcome = projection
      ? await runWorkspaceMetadataProjection(projection)
      : await wireRefusals(() =>
          updateWorkspaceRetention(
            {
              workspaceId: input.workspaceId,
              ...revisioned(input.expectedRevision),
              patch: input.patch,
              source: 'workspace_settings',
              idempotencyKey: call.idempotencyKey,
            },
            wireCall(call, {
              admitAddress: () =>
                admitWorkspace(input.workspaceId, 'not-found'),
            }),
          ),
        );
    return {
      workspaceId: outcome.workspaceId,
      activityBaselineRecorded: outcome.activityBaselineRecorded,
    };
  },
  async updateWorktree(input, call) {
    const projection = takeWorkspaceMetadataProjection('core.worktree.update');
    if (projection) {
      // The IPC caller never reads the wire result.
      await runWorkspaceMetadataProjection(projection);
      throw new WorkspaceMetadataProjectionAnswered();
    }
    const { scope, worktreeId } = input;
    checkWorktreeScope(worktreeId, scope);
    const scoped = scope?.workspaceId;
    // Unscoped, the workspace is part of the request's fingerprint, so it is
    // resolved before the receipt lookup.
    const workspaceId =
      scoped ??
      (await resolveWorktreeWorkspace(worktreeId, scope?.organizationId));
    // Set by each attempt's admission; a replay admits nothing.
    let verifiedList: string | null | undefined;
    const { worktree } = await wireRefusals(() =>
      updateWorktree(
        {
          workspaceId,
          worktreeId,
          expectedRevision: input.expectedRevision,
          patch: desktopWorktreePatch(input.patch),
          idempotencyKey: call.idempotencyKey,
        },
        wireCall(call, {
          // A new key only: a saved outcome replays without either check.
          admitAddress: async (): Promise<void> => {
            verifiedList = undefined;
            if (scoped !== undefined)
              await admitScopedWorkspace(scoped, scope?.organizationId);
            verifiedList = await admitRevisionProvenance(
              workspaceId,
              worktreeId,
            );
          },
          admitOutcome: (outcome) => {
            if (verifiedList !== undefined)
              admitVerifiedList(workspaceId, verifiedList);
            worktreeResult(workspaceId, outcome.worktree);
          },
        }),
      ),
    );
    return worktreeResult(workspaceId, worktree);
  },
  async reorderWorktree(input, call) {
    const projection = takeWorkspaceMetadataProjection('core.worktree.reorder');
    if (projection) {
      await runWorkspaceMetadataProjection(projection);
      return;
    }
    await wireRefusals(() =>
      moveWorktree(
        {
          workspaceId: input.workspaceId,
          activeWorktreeId: input.activeWorktreeId,
          overWorktreeId: input.overWorktreeId,
          ...revisioned(input.expectedRevision),
          idempotencyKey: call.idempotencyKey,
        },
        wireCall(call, {
          admitAddress: () => admitWorkspace(input.workspaceId, 'not-found'),
        }),
      ),
    );
  },
  async setWorktreeHooksPaused(input, call) {
    const projection = takeWorkspaceMetadataProjection(
      'core.worktree.hooks.setPaused',
    );
    if (projection) {
      await runWorkspaceMetadataProjection(projection);
      throw new WorkspaceMetadataProjectionAnswered();
    }
    return pausedResult(
      await setWorktreeHooksPaused(
        {
          workspaceId: input.workspaceId,
          worktreeId: input.worktreeId,
          ...revisioned(input.expectedRevision),
          change: input.change,
          source: settingsSource(call.caller),
          idempotencyKey: call.idempotencyKey,
        },
        wireCall(call, {
          admitAddress: () => admitWorkspace(input.workspaceId, 'not-found'),
          admitOutcome: (decided) => {
            pausedResult(decided);
          },
        }),
      ),
    );
  },
};
