import { hasExactWorktreeBaseCatalogue } from '@/lib/remote-control/worktree-base-availability';
import { type InlineFailure } from '@/lib/inline-app-error';
import { formatWorktreePrepareFailure } from '@canopy/ui-shared';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { isOpenCodeModel } from '@canopy/execution-engine/lib/opencode-models';
import { encodeWorktreeBaseBranch } from '@canopy/protocol/portal';
import { isCopilotModel } from '@canopy/execution-engine/lib/copilot-models';
import { isCursorModel } from '@canopy/execution-engine/lib/cursor-models';
import { create } from 'zustand';
import type {
  ApprovalMode,
  AttachmentMeta,
  BranchEntry,
  ChatModel,
  CodexSpeed,
  ModelHarness,
  ChatTabPluginSelections,
  FileReference,
  HomeBranchTargetsResponse,
  HomeDiscoveryTarget,
  PluginSelectionTombstones,
  RepoFileIndex,
  SidebarItem,
  ThinkingLevel,
  WorktreeDiscovery,
} from '@canopy/desktop-shared/types';
import {
  COWORK_HOME_WORKTREE_ID,
  DEFAULT_MODEL,
  WORKSPACE_ROOT_REPO_ID,
  clampThinkingLevelForModel,
  getEffectiveSupportedThinkingLevelsForModel,
  getProviderForModel,
  getProviderForChatModel,
  pinInheritingAgentModel,
  getChatHarnessOptions,
  isAgentModel,
  modelConfigForProviderSupportsFastMode,
} from '@canopy/desktop-shared/types';
import { advanceThinkingControlLevel } from '@canopy/ui-shared/lib';
import {
  DEFAULT_CODEX_SPEED,
  codexSpeedFastMode,
  codexSpeedFromFastMode,
  readCodexSpeedRecord,
} from '@canopy/execution-engine/lib/codex-speed';
import { createEmptySelections } from '@/lib/pluginSelections';
import {
  subtractPluginSelections,
  unionPluginSelections,
} from '@/lib/pluginSelectionsBlend';
import {
  chatSurfaceUsesGlobalPluginDefaults,
  hasAnyTombstones,
  splitChosenChatPluginSelections,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { useProjectsStore } from './projectsStore';
import { useWorkspaceContextStore } from './workspaceContextStore';
import {
  resolveFallbackDefaultModel,
  resolveTabDefaults,
  useChatStore,
} from './chatStore';
import { resolveBillingSeed, resolveProviderDefaults } from './chat/defaults';
import { billingSeedFields, isTabAiCreditsRouted } from './chat/tab-utils';
import {
  IDLE_HOME_LINK_TARGET,
  type HomeLinkTargetState,
} from '@/components/home/homeLinkTarget';

export type HomeBranchTarget =
  | { kind: 'new-worktree' }
  | { kind: 'worktree'; worktreeId: string }
  | { kind: 'branch'; branchName: string; isRemote: boolean }
  | {
      kind: 'pr';
      number: number;
      title: string;
      headRefName: string;
      url: string;
    }
  | {
      kind: 'linear-issue';
      identifier: string;
      title: string;
      branchName: string;
    };

type HomeBaseBranch = Extract<HomeBranchTarget, { kind: 'branch' }>;

export type HomeNewWorktreeBaseTarget =
  | Extract<HomeBranchTarget, { kind: 'worktree' | 'pr' }>
  | (HomeBaseBranch & { ref?: string });

const LOCAL_BRANCH_REF_PREFIX = 'refs/heads/';
const ORIGIN_BRANCH_REF_PREFIX = 'refs/remotes/origin/';

function worktreeBaseRef(target: HomeBaseBranch): string {
  const prefix = target.isRemote
    ? ORIGIN_BRANCH_REF_PREFIX
    : LOCAL_BRANCH_REF_PREFIX;
  return `${prefix}${target.branchName}`;
}

function encodeExactWorktreeBase(ref: string): string {
  const isRemote = ref.startsWith(ORIGIN_BRANCH_REF_PREFIX);
  const prefix = isRemote ? ORIGIN_BRANCH_REF_PREFIX : LOCAL_BRANCH_REF_PREFIX;
  return encodeWorktreeBaseBranch({
    branchName: ref.slice(prefix.length),
    isRemote,
  });
}

function captureWorktreeBaseTarget(
  target: HomeNewWorktreeBaseTarget,
  response: HomeBranchTargetsResponse | null,
): HomeNewWorktreeBaseTarget {
  if (
    target.kind !== 'branch' ||
    target.ref ||
    !hasExactWorktreeBaseCatalogue(response)
  )
    return target;
  return { ...target, ref: worktreeBaseRef(target) };
}

export function homeNewWorktreeBaseTargetsEqual(
  first: HomeNewWorktreeBaseTarget,
  second: HomeNewWorktreeBaseTarget,
): boolean {
  if (
    first.kind === 'branch' &&
    second.kind === 'branch' &&
    (first.ref || second.ref)
  )
    return first.ref === second.ref;
  return homeBranchTargetsEqual(first, second);
}

type HomeBranchTargetsStatus = 'idle' | 'loading' | 'ready' | 'error';

export function homeWorktreeBaseMissing(
  target: HomeNewWorktreeBaseTarget | null,
  response: HomeBranchTargetsResponse | null,
  status: HomeBranchTargetsStatus,
): boolean {
  if (
    status === 'idle' ||
    target?.kind !== 'branch' ||
    !target.ref ||
    !response?.supported ||
    !hasExactWorktreeBaseCatalogue(response)
  )
    return false;
  const isRemote = target.ref.startsWith(ORIGIN_BRANCH_REF_PREFIX);
  const prefix = isRemote ? ORIGIN_BRANCH_REF_PREFIX : LOCAL_BRANCH_REF_PREFIX;
  return !response.branches.some(
    (branch) =>
      (isRemote ? branch.hasRemoteRef : branch.hasLocalRef) &&
      `${prefix}${branch.name}` === target.ref,
  );
}

export const MISSING_HOME_WORKTREE_BASE_MESSAGE =
  'The selected base branch is no longer available. Choose another base.';

export type HomeComposerMode = 'chat' | 'pipeline';

/**
 * The provider a Home draft's capabilities are keyed on. `cursor` has no
 * provider-side slash discovery (its skills and commands come from the
 * inventory and load from the chat's private Cursor root), so discovery
 * callers treat it like `undefined` while inventory callers use it as is.
 */
export type HomeDiscoveryProviderType =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'copilot'
  | 'antigravity'
  | 'opencode'
  | undefined;

/**
 * Sentinel worktree id under which Home-draft attachments are staged when
 * the draft's branch target has no real worktree yet (new-worktree /
 * other-branch targets). Must satisfy the main process's `validateId`
 * pattern (`/^[a-z0-9][a-z0-9-]*$/` — lowercase alphanumeric + hyphens, so
 * no underscores). The B5 send orchestrator imports this to pick up staged
 * files from `workspaces/{workspaceId}/attachments/home-draft/` once the
 * real worktree exists.
 */
export const HOME_DRAFT_WORKTREE_ID = 'home-draft';

const NEW_WORKTREE_TARGET: HomeBranchTarget = { kind: 'new-worktree' };

/**
 * Fallback branch-targets result used when the `homeListBranchTargets` IPC
 * call rejects (e.g. the main process threw). Matches the shape the backend
 * returns for workspaces that don't support branch enumeration (non-source
 * multi-repo, cowork) so callers never need a separate error path.
 */
const FALLBACK_BRANCH_TARGETS: HomeBranchTargetsResponse = {
  supported: false,
  branches: [],
  defaultBranch: null,
};

export function pluginSelectionsSignature(
  selections: ChatTabPluginSelections | null | undefined,
): string {
  return selections ? JSON.stringify(selections) : 'null';
}

/**
 * Backend default `thinkingLevel` seeded into a fresh preferences file for
 * both the Claude and Codex provider entries (see
 * `createDefaultModelDefaultsByProvider` in
 * `apps/desktop-app/src/main/lib/preferences-store.ts`). Used only as the
 * last-resort fallback in {@link resolveHomeEffectiveDefaults} for the brief
 * startup window before `useChatStore`'s `modelDefaults` has loaded, or when
 * no workspace is selected yet — `resolveTabDefaults` itself always returns
 * a concrete `thinkingLevel` once `modelDefaults` is populated.
 */
const FALLBACK_THINKING_LEVEL: ThinkingLevel = 'high';

/** How long a resend after connecting GitHub stays eligible (CAN-4466). */
const GITHUB_CONNECT_RESUME_MAX_AGE_MS = 15_000;

/** Whether a staged resend after connecting GitHub may still send. */
export function isGitHubConnectResumeFresh(
  pending: { requestedAt: number },
  now: number = Date.now(),
): boolean {
  return now - pending.requestedAt < GITHUB_CONNECT_RESUME_MAX_AGE_MS;
}

/**
 * Resolves the concrete model + thinking level the Home composer should
 * *display* and *send* for `workspaceId` when the draft hasn't overridden
 * them (`draft.model`/`draft.thinkingLevel` are `undefined`, i.e.
 * "untouched"). Delegates to `resolveTabDefaults` (chatStore.ts) — the same
 * cowork/worktree-branching resolver a freshly created chat tab uses — so
 * Home shows exactly what a new tab for this workspace would default to.
 * Falls back to `DEFAULT_MODEL` / `FALLBACK_THINKING_LEVEL` when there's no
 * selected workspace yet or `modelDefaults` hasn't loaded.
 */
export function resolveHomeEffectiveDefaults(workspaceId: string | null): {
  model: ChatModel;
  thinkingLevel: ThinkingLevel;
} {
  const resolved = workspaceId
    ? resolveTabDefaults(workspaceId, useChatStore.getState().modelDefaults)
    : {};
  return {
    // `DEFAULT_MODEL` is a Claude subscription model, so this escape hatch used
    // to show a credits-only or Codex-only user a model they cannot run for the
    // whole pre-`modelDefaults` window. Prefer the lane-resolved default and
    // keep the constant only for the case where no lane is known either.
    model: resolved.model ?? resolveFallbackDefaultModel() ?? DEFAULT_MODEL,
    thinkingLevel: resolved.thinkingLevel ?? FALLBACK_THINKING_LEVEL,
  };
}

/**
 * Maps a Home draft's `branchTarget` (plus whether the selected workspace is
 * cowork) to the `HomeDiscoveryTarget` shape `homeDiscoverEnvironment`
 * expects. Cowork workspaces always discover against the cowork root
 * regardless of `branchTarget` (cowork has no worktree/branch concept and
 * the branch picker is never rendered for it). An existing-worktree target
 * discovers against that worktree's checkout; every other target (new
 * worktree, other branch) discovers against the workspace's default-branch
 * shadow via `{ kind: 'baseline' }`.
 *
 * `selectedRepoId` (the multi-repo working-directory picker) scopes both
 * non-cowork target kinds to a child repo: the worktree target resolves to
 * that repo's checkout inside the worktree, and the baseline target resolves
 * to that repo's own default-branch shadow. `undefined` means workspace
 * root, matching `DirectoryPicker`'s convention.
 */
export function resolveHomeDiscoveryTarget(
  branchTarget: HomeBranchTarget,
  isCoworkWorkspace: boolean,
  selectedRepoId?: string,
): HomeDiscoveryTarget {
  if (isCoworkWorkspace) {
    return { kind: 'cowork' };
  }
  if (branchTarget.kind === 'worktree') {
    return {
      kind: 'worktree',
      worktreeId: branchTarget.worktreeId,
      ...(selectedRepoId ? { repoId: selectedRepoId } : {}),
    };
  }
  return {
    kind: 'baseline',
    ...(selectedRepoId ? { repoId: selectedRepoId } : {}),
  };
}

/**
 * Resolves the worktree id under which a Home draft's attachments are
 * staged. Attachments can be staged before a real worktree exists yet (new
 * worktree / other-branch targets). Cowork workspaces always stage under
 * the fixed cowork home id, existing-worktree targets stage under that
 * worktree's real id, and everything else stages under the stable
 * `HOME_DRAFT_WORKTREE_ID` sentinel (which must pass the main process's
 * `validateId` check) so files land somewhere durable and can be picked up
 * once the send orchestrator (Task B5) creates the actual worktree. Shared
 * by every Home attachment-staging entry point (the + menu file picker,
 * Linear ticket staging, and editor paste) so they all resolve the same
 * target.
 */
export function resolveHomeAttachmentWorktreeId(
  isCoworkWorkspace: boolean,
  branchTarget: HomeBranchTarget,
): string {
  if (isCoworkWorkspace) {
    return COWORK_HOME_WORKTREE_ID;
  }
  return branchTarget.kind === 'worktree'
    ? branchTarget.worktreeId
    : HOME_DRAFT_WORKTREE_ID;
}

export interface HomeAttachmentTarget {
  projectId: string;
  worktreeId: string;
}

export interface HomeAttachmentImportToken {
  id: number;
  draftGeneration: number;
}

/**
 * Returns whether an async Home attachment import still belongs to the
 * currently selected draft. Paste imports can outlive a workspace or branch
 * selection change, so callers must revalidate the captured staging target
 * before applying either imported attachments or an import error.
 */
export function isHomeAttachmentTargetCurrent(
  target: HomeAttachmentTarget,
  currentWorkspaceId: string | null,
  currentBranchTarget: HomeBranchTarget,
  currentIsCoworkWorkspace: boolean,
): boolean {
  return (
    currentWorkspaceId === target.projectId &&
    resolveHomeAttachmentWorktreeId(
      currentIsCoworkWorkspace,
      currentBranchTarget,
    ) === target.worktreeId
  );
}

/**
 * Extends the attachment-target check with draft identity. A successful send
 * resets and then re-selects the same workspace/branch target, so target
 * equality alone cannot distinguish a late import from the new draft.
 */
export function isHomeAttachmentImportCurrent(
  target: HomeAttachmentTarget,
  importDraftGeneration: number,
  currentWorkspaceId: string | null,
  currentBranchTarget: HomeBranchTarget,
  currentIsCoworkWorkspace: boolean,
  currentDraftGeneration: number,
): boolean {
  return (
    importDraftGeneration === currentDraftGeneration &&
    isHomeAttachmentTargetCurrent(
      target,
      currentWorkspaceId,
      currentBranchTarget,
      currentIsCoworkWorkspace,
    )
  );
}

/** Whether a Home draft can carry plugin selections: every known provider. */
function homeDraftAcceptsPluginSelections(
  workspaceId: string | null,
  model: ChatModel | undefined,
): boolean {
  return resolveHomeEffectiveProviderType(workspaceId, model) !== undefined;
}

/**
 * Maps the draft's model override to the provider discovery should run
 * against. `undefined` (workspace default) defaults to `'claude'`; Ollama
 * models also resolve to `'claude'` since discovery has no distinct Ollama
 * path (Ollama reuses the Claude provider internally). Cursor models resolve
 * to `'cursor'`: the composer lists the Cursor inventory rows and the plugin
 * picker, while extension discovery (which builds Claude/Codex slash
 * commands) is skipped for it.
 */
export function resolveHomeDiscoveryProviderType(
  model: ChatModel | undefined,
): HomeDiscoveryProviderType {
  if (isOpenCodeModel(model)) return 'opencode';
  if (isCopilotModel(model)) return 'copilot';
  if (isCursorModel(model)) return 'cursor';
  if (model === undefined) {
    return 'claude';
  }
  // Unknown persisted models cannot run provider discovery; use the existing
  // Claude-compatible discovery path until the user picks a current model.
  // Agent ids do not carry their base model's provider namespace. Resolve the
  // registered provider so inventory and discovery match the actual runtime.
  const provider = getProviderForModel(model);
  return provider === 'codex' ||
    provider === 'cursor' ||
    provider === 'copilot' ||
    provider === 'opencode'
    ? provider
    : 'claude';
}

/**
 * Provider-routing entry point for discovery and command-building (Task F2
 * carry-forward fix from the F1 review): resolves against the EFFECTIVE
 * model (`draft.model` when touched, else
 * `resolveHomeEffectiveDefaults(workspaceId).model`) rather than the raw,
 * possibly-`undefined` draft model `resolveHomeDiscoveryProviderType` alone
 * would use. Without this, an untouched draft on a codex-default workspace
 * would incorrectly discover/build claude-flavored commands even though the
 * composer displays and sends a codex model. Callers that already have a
 * concrete effective model in hand may call
 * `resolveHomeDiscoveryProviderType` directly; everyone else should go
 * through this function.
 */
export function resolveHomeEffectiveProviderType(
  workspaceId: string | null,
  model: ChatModel | undefined,
  executionHarness?: ModelHarness,
): HomeDiscoveryProviderType {
  const effectiveModel =
    model ?? resolveHomeEffectiveDefaults(workspaceId).model;
  if (
    (executionHarness === 'claude' || executionHarness === 'codex') &&
    getChatHarnessOptions(effectiveModel).includes(executionHarness)
  )
    return executionHarness;
  return resolveHomeDiscoveryProviderType(effectiveModel);
}

/**
 * Billing route the tab a Home send creates would execute on. A Home-created
 * tab is seeded with `billingSeed: resolveBillingSeed(...)` (see the chat
 * store's tab-creation paths), so this maps that same seed through
 * `billingSeedFields` — exactly what `createEmptyTab` writes onto the tab —
 * into `isTabAiCreditsRouted`, the shared derivation ChatInput and the
 * thinking-level cycle already use. Capability lookups must follow this
 * route: an AI-Credits-routed session is constrained to the
 * gateway-advertised thinking set, not the model's native tiers.
 */
export function resolveHomeAiCreditsRouted(
  workspaceId: string | null,
  model: ChatModel,
): boolean {
  return isTabAiCreditsRouted({
    ...billingSeedFields(
      resolveBillingSeed(
        useChatStore.getState().modelDefaults,
        workspaceId ?? undefined,
      ),
    ),
    model,
  });
}

export function resolveHomeSupportedThinkingLevels(
  workspaceId: string | null,
  model: ChatModel | undefined,
  executionHarness?: ModelHarness,
): readonly ThinkingLevel[] {
  const effectiveModel =
    model ?? resolveHomeEffectiveDefaults(workspaceId).model;
  return getEffectiveSupportedThinkingLevelsForModel(
    effectiveModel,
    resolveHomeAiCreditsRouted(workspaceId, effectiveModel),
    getProviderForChatModel(effectiveModel, executionHarness) ?? 'claude',
    executionHarness,
  );
}

/**
 * Resolves the one model/thinking selection Home displays, cycles, and sends.
 * Draft overrides remain untouched in the store, but an unsupported level is
 * clamped against the active model's exact supported set before any consumer
 * uses it, including `off` when a model does not declare that level.
 */
export function resolveHomeEffectiveModelSettings(
  workspaceId: string | null,
  model: ChatModel | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  executionHarness?: ModelHarness,
): {
  model: ChatModel;
  thinkingLevel: ThinkingLevel;
  supportedThinkingLevels: readonly ThinkingLevel[];
} {
  const defaults = resolveHomeEffectiveDefaults(workspaceId);
  // An inheriting Agent shows and sends the selected workspace's default.
  const effectiveModel = pinInheritingAgentModel(
    model ?? defaults.model,
    defaults.model,
  );
  // Model controls follow the actual provider, not the narrower tool-discovery API.
  const provider =
    executionHarness ?? getProviderForChatModel(effectiveModel) ?? 'claude';
  const supportedThinkingLevels = resolveHomeSupportedThinkingLevels(
    workspaceId,
    effectiveModel,
    executionHarness,
  );
  return {
    model: effectiveModel,
    thinkingLevel: clampThinkingLevelForModel(
      thinkingLevel ?? defaults.thinkingLevel,
      effectiveModel,
      provider,
      false,
      supportedThinkingLevels,
    ),
    supportedThinkingLevels,
  };
}

/**
 * Resolve the exact Codex speed for the displayed model: the staged draft
 * choice (its `speed`, then its legacy `fastMode`) before the provider default
 * record (read the same way), else Regular. An explicit staged choice —
 * including a legacy "off" — therefore beats an Ultra fast default.
 * `undefined` for providers without a Codex speed.
 */
export function resolveHomeSpeed(
  model: ChatModel,
  staged: { speed?: CodexSpeed; fastMode?: boolean },
  executionHarness?: ModelHarness,
): CodexSpeed | undefined {
  const provider = getProviderForChatModel(model, executionHarness);
  if (!provider || !modelConfigForProviderSupportsFastMode(provider))
    return undefined;
  return (
    readCodexSpeedRecord({ speed: staged.speed, fastMode: staged.fastMode }) ??
    readCodexSpeedRecord(
      useChatStore.getState().modelDefaults?.modelConfigDefaultsByProvider?.[
        provider
      ],
    ) ??
    DEFAULT_CODEX_SPEED
  );
}

/**
 * Legacy boolean projection of {@link resolveHomeSpeed} for the displayed
 * model, preserving an explicit off choice. Only Fast projects `true`.
 */
export function resolveHomeFastMode(
  model: ChatModel,
  override: boolean | undefined,
  executionHarness?: ModelHarness,
): boolean | undefined {
  const speed = resolveHomeSpeed(
    model,
    { fastMode: override },
    executionHarness,
  );
  return speed === undefined ? undefined : codexSpeedFastMode(speed);
}

export function homeBranchTargetsEqual(
  a: HomeBranchTarget,
  b: HomeBranchTarget,
): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'worktree' && b.kind === 'worktree') {
    return a.worktreeId === b.worktreeId;
  }
  if (a.kind === 'branch' && b.kind === 'branch') {
    return a.branchName === b.branchName && a.isRemote === b.isRemote;
  }
  if (a.kind === 'pr' && b.kind === 'pr') {
    return a.number === b.number;
  }
  if (a.kind === 'linear-issue' && b.kind === 'linear-issue') {
    return a.identifier === b.identifier;
  }
  return true;
}

/**
 * Maps a Home `branchTarget` to the worktree-create options
 * `useProjectsStore.createWorktree` accepts (Task 11 / ECW-8121). Shared by
 * both the immediate and scheduled send paths in `homeSend.ts` — and by
 * `resolveTaskReadyLaunchTarget` — so create/launch semantics stay identical
 * across every dispatch route.
 *
 * - `new-worktree` / `worktree` → `undefined` (create a fresh worktree with no
 *   pre-selected branch). The `worktree` kind targets an existing worktree and
 *   never reaches a create path, but is handled here for exhaustiveness.
 * - `branch` → check out that existing local/remote branch.
 * - `pr` → check out the PR's head branch.
 * - `linear-issue` → check out the Linear-suggested branch when it already
 *   exists among `branches`, otherwise create a new branch with that name.
 *   The exists-check is resolved on the renderer from the loaded branch list
 *   (`branchTargets.branches`) rather than deferred to the backend, which is
 *   what lets the scheduled path detect the create-new-branch case up front
 *   (see `homeSend.ts`).
 */
export function createOptionsForBranchTarget(
  target: HomeBranchTarget,
  branches: readonly BranchEntry[],
): { existingBranch?: string; branchName?: string } | undefined {
  switch (target.kind) {
    case 'new-worktree':
    case 'worktree':
      return undefined;
    case 'branch':
      return { existingBranch: target.branchName };
    case 'pr':
      return { existingBranch: target.headRefName };
    case 'linear-issue': {
      const branchExists = branches.some(
        (branch) => branch.name === target.branchName,
      );
      return branchExists
        ? { existingBranch: target.branchName }
        : { branchName: target.branchName };
    }
  }
}

/** Maps the single-repo New worktree base picker to worktree creation. */
export function createOptionsForNewWorktreeBaseTarget(
  target: HomeNewWorktreeBaseTarget | null,
): { baseWorktreeId?: string; baseBranch?: string } | undefined {
  if (!target) return undefined;
  if (target.kind === 'worktree') {
    return { baseWorktreeId: target.worktreeId };
  }
  return {
    baseBranch:
      target.kind === 'pr'
        ? target.headRefName
        : target.ref
          ? encodeExactWorktreeBase(target.ref)
          : target.isRemote
            ? `origin/${target.branchName}`
            : target.branchName,
  };
}

export function defaultNewWorktreeBaseTarget(
  response: HomeBranchTargetsResponse,
): HomeNewWorktreeBaseTarget | null {
  const defaultBranch = response.defaultBranch;
  const branchName =
    defaultBranch ||
    response.branches.find((branch) => branch.isCurrent && branch.hasLocalRef)
      ?.name;
  if (!branchName) return null;
  // isRemote marks remote-only rows; a coalesced local branch can also have
  // an origin ref that is newer than its local checkout.
  const matchingBranch =
    response.branches.find(
      (branch) => branch.name === branchName && branch.hasRemoteRef,
    ) ?? response.branches.find((branch) => branch.name === branchName);
  const target: HomeBaseBranch = {
    kind: 'branch',
    branchName,
    isRemote: Boolean(defaultBranch && matchingBranch?.hasRemoteRef),
  };
  // The remote default can be discovered before its ref has been fetched.
  // Keep the fetch-capable base until the picker can name a real ref.
  const observed = target.isRemote
    ? matchingBranch?.hasRemoteRef
    : matchingBranch?.hasLocalRef;
  return observed ? captureWorktreeBaseTarget(target, response) : target;
}

/**
 * Whether an immediate Home send would create its worktree from the source's
 * current branch (git's `HEAD`), the only start point an unborn source branch
 * cannot supply. Existing worktrees, explicit bases and existing branch, PR or
 * issue branches have their own start point. A new issue branch without a base
 * starts from `origin/{defaultBranch}` when main knows one, so only a missing
 * default leaves it on `HEAD`. Multi-repo creation is left to the backend: the
 * branch-target state describes only the canonical source.
 */
export function homeSendUsesSourceHead({
  projectType,
  branchTarget,
  newWorktreeBaseTarget,
  branches,
  defaultBranch,
}: {
  projectType: SidebarItem['type'] | undefined;
  branchTarget: HomeBranchTarget;
  newWorktreeBaseTarget: HomeNewWorktreeBaseTarget | null;
  branches: readonly BranchEntry[];
  defaultBranch: string | null | undefined;
}): boolean {
  if (projectType !== 'single-repo') return false;
  if (branchTarget.kind === 'new-worktree')
    return newWorktreeBaseTarget === null;
  if (branchTarget.kind !== 'linear-issue' || defaultBranch) return false;
  return (
    createOptionsForBranchTarget(branchTarget, branches)?.branchName !==
    undefined
  );
}

/** Preflight failures, by identity, so a committed refresh clears only these. */
const sourceNoCommitsFailures = new WeakSet<InlineFailure>();

/** The draft's send error when the source branch is verified to have no commits. */
export function sourceNoCommitsSendFailure(
  sourceName: string | undefined,
): InlineFailure {
  const failure: InlineFailure = {
    error: formatWorktreePrepareFailure({
      reason: 'source-no-commits',
      ...(sourceName ? { sourceName } : {}),
      hasDetails: false,
    }),
  };
  sourceNoCommitsFailures.add(failure);
  return failure;
}

function isCoworkWorkspaceId(workspaceId: string): boolean {
  const project = useProjectsStore
    .getState()
    .projects.find((candidate) => candidate.id === workspaceId);
  return project?.type === 'cowork';
}

/**
 * True when the Home draft can be submitted.
 *
 * Chat mode permits an empty draft to create a work area without an initial
 * message. Workspace selection and in-flight work are guarded by the caller.
 *
 * Pipeline mode allows attachments alone to enable send: `homeSend.ts`'s
 * `buildPipelineTaskText` synthesizes a full task text from the staged
 * attachment list (a "review these files" instruction block) even when the
 * user typed nothing, so an attachments-only pipeline draft (e.g. just a
 * staged Linear ticket) is still sendable.
 */
export function isHomeSendEnabled(
  mode: HomeComposerMode,
  text: string,
  attachments: readonly AttachmentMeta[],
): boolean {
  const hasText = text.trim().length > 0;
  if (mode === 'pipeline') {
    return hasText || attachments.length > 0;
  }
  return true;
}

interface HomeComposerData {
  workspaceId: string | null;
  branchTarget: HomeBranchTarget;
  /** Explicit base used only for a single-repo `new-worktree` target. */
  newWorktreeBaseTarget: HomeNewWorktreeBaseTarget | null;
  /**
   * Multi-repo working-directory selection (the `DirectoryPicker` control).
   * `undefined` means "project root" — the same convention `ChatTabData`
   * and `DirectoryPicker` use — and is the only possible value for
   * single-repo/cowork workspaces, which never render the picker. Scopes
   * discovery and the `@` file index to the selected child repo (see
   * `resolveHomeDiscoveryTarget`), and is pinned onto the chat tab created
   * by a send so the session actually runs in that repo. Reset on workspace
   * switches (repo ids are workspace-specific) but preserved across
   * branch-target switches (the repo set is the same for every worktree of
   * one workspace).
   */
  selectedRepoId: string | undefined;
  mode: HomeComposerMode;
  /**
   * `undefined` means "untouched" — the composer displays and sends
   * `resolveHomeEffectiveDefaults(workspaceId).model` instead (Task F1). Once
   * the user picks a model this becomes concrete and persists verbatim
   * across workspace switches.
   */
  model: ChatModel | undefined;
  /**
   * Per-turn Auto routing for the task this draft will start. `'auto'` leaves
   * `model` in place as the deterministic fallback and as the chip's label
   * source, and deliberately clears `executionHarness`: Auto on a NEW task may
   * choose across Claude and Codex within the selected execution lane, so an
   * explicit harness pin would contradict the control the user just chose.
   */
  modelSelectionMode: 'auto' | undefined;
  executionHarness: ModelHarness | undefined;
  /** Same "untouched" contract as {@link model}, resolved via
   * `resolveHomeEffectiveDefaults(workspaceId).thinkingLevel`. */
  thinkingLevel: ThinkingLevel | undefined;
  /**
   * Staged exact Codex speed for the chat this draft creates. `undefined`
   * means untouched: the displayed model provider's default applies (see
   * {@link resolveHomeSpeed}). Always written together with {@link fastMode}.
   */
  speed: CodexSpeed | undefined;
  /**
   * Legacy projection of {@link speed} (`speed === 'fast'`), kept for boolean
   * controls. Untouched uses the displayed model provider's default.
   */
  fastMode: boolean | undefined;
  planMode: boolean;
  /**
   * Tool-approval mode override for the composer's send target. `undefined`
   * means "untouched" — the composer displays the resolved default for the
   * selected target (`approvalDefaultsCache` in `chatStore`, with a loading
   * placeholder until that cache resolves) instead of a concrete value. Once
   * the user picks a mode via `ApprovalModePicker` this becomes concrete and
   * persists across workspace/branch-target switches, mirroring the lifecycle
   * of `model`/`thinkingLevel`. Reset (back to `undefined`) only by `reset()`
   * after a successful send, the same lifecycle `planMode` follows.
   */
  approvalMode: ApprovalMode | undefined;
  /**
   * `null` only before any workspace has ever been selected. Once
   * `selectWorkspace` runs with a non-null id, this is always a concrete
   * `union(workspaceDefaults, manualPluginSelections)` blend — see
   * {@link manualPluginSelections}.
   */
  pluginSelections: ChatTabPluginSelections | null;
  /**
   * Delta of plugin/skill/collection/MCP-server selections the user manually
   * enabled beyond the *then-current* workspace's own defaults, tracked at
   * plugin-modal save time via `subtractPluginSelections` (Task F1). Not
   * cleared on `selectWorkspace` (re-applied on top of each newly selected
   * workspace's defaults via `unionPluginSelections`) — only `reset()`
   * clears it. This means a default the user explicitly removed for one
   * workspace reappears after switching away and back, since removals are
   * per-workspace-session only.
   */
  manualPluginSelections: ChatTabPluginSelections;
  /**
   * True once the user explicitly edited the draft's plugin selections via
   * the plugins modal (i.e. `setPluginSelections` ran) for the currently
   * selected workspace. While false, the working `pluginSelections` is just
   * the seeded defaults snapshot and consumers may rebase it onto
   * later-arriving workspace defaults.
   */
  pluginSelectionsEdited: boolean;
  attachments: AttachmentMeta[];
  /**
   * The New Task draft of record (CAN-3794). It outlives every `HomeSurface`
   * editor: a newly mounted editor is seeded from it, and a hidden,
   * still-mounted one is re-synced from it when shown, so navigating away and
   * back restores the draft exactly and Send never reads invisible text.
   * Only a successful chat-mode send (`reset()` when the whole draft is still
   * the submitted one, otherwise `clearSubmittedDraft()` when only its
   * text/references are), an account change, a Personal/organization
   * context rebind,
   * an explicit replacement (command insert, suggested or staged starter
   * prompt), or the user clearing the editor empties or replaces it.
   */
  text: string;
  /**
   * `file-reference` pills serialized out of the editor alongside `text`
   * (Task F3) — mirrors `ChatInput`'s `serializedDraft.fileReferences`.
   * `HomeSurface` keeps this in lockstep with `text` on every editor change.
   * Pills survive branch-target and workspace switches (clearing them would
   * delete user-typed message content), so by send time an `absolutePath`
   * can point into a root that is not the send target's cwd (the repo
   * shadow for `new-worktree`/`branch` picks, or a previously selected
   * worktree). Every dispatch route re-roots stale references onto the
   * actual target cwd — see `rewriteFileReferencesForTargetCwd` and
   * `homeSend.ts`.
   */
  fileReferences: FileReference[];
  /**
   * Unique ids for attachment imports that still belong to this draft.
   * Sending is blocked while this list is non-empty so a send cannot snapshot
   * attachments before an import settles.
   */
  pendingAttachmentImportIds: number[];
  /**
   * Monotonic draft identity used to discard imports that complete after a
   * workspace/branch change or draft reset, even when the final target is the
   * same as the one captured when the import began.
   */
  draftGeneration: number;
  isSending: boolean;
  sendError: InlineFailure | null;
  /** Whether the current send error can be retried without changing the draft. */
  sendErrorRetryable: boolean;
  /**
   * CAN-5021: the current send error is a model refusal recoverable by
   * choosing another model. `failureId` is unique per refusal so a repeated
   * identical failure still moves focus; `message` ties it to `sendError`.
   * `focus` is false for a refusal that arrived while the user was elsewhere.
   */
  sendErrorChooseModel: {
    failureId: string;
    message: string;
    focus: boolean;
  } | null;
  /**
   * CAN-6019: the current send error is an external Cowork project whose
   * folder is missing. `failure` is the exact `sendError` it recovers, so any
   * writer that replaces the error retires these actions without clearing
   * them itself. The renderer holds the project id, never the folder path.
   */
  sendErrorMissingFolder: HomeMissingFolderRecovery | null;
  branchTargets: HomeBranchTargetsResponse | null;
  branchTargetsStatus: HomeBranchTargetsStatus;
  discovery: WorktreeDiscovery | null;
  discoveryLoading: boolean;
  /**
   * Target-aware file index backing the `@` mention typeahead (Task F3).
   * `null` before the first successful load for the current
   * workspace/branch-target combination. Mirrors `discovery`'s
   * target-resolution and stale-response-guard pattern via
   * `resolveHomeDiscoveryTarget`, but does not depend on model/provider.
   */
  fileIndex: RepoFileIndex[] | null;
  fileIndexLoading: boolean;
  /**
   * Staged one-time schedule for the draft's next send. When set,
   * `dispatchHomeSend` (Task C3) routes through the automation-backed
   * scheduled paths instead of sending immediately. `null` means "send now".
   */
  scheduledSendDraft: { runAt: string } | null;
  /**
   * Transient resume handoff for the Home branch picker's "Add
   * {owner}/{repo} as a workspace…" offer flow (ECW-8121). Set to the pasted
   * PR reference when the offer row is activated (right before opening the Add
   * Workspace modal), then consumed exactly once by `HomeBranchPicker` after
   * the modal reports a created workspace and the composer switches to it: the
   * picker reopens on the PRs tab with this reference in its search box, where
   * the per-workspace PR fetch surfaces the matching PR row. Cleared when the
   * modal closes without creating a workspace. Not persisted.
   */
  pendingCreateFromReference: string | null;
  /**
   * Transient request for `HomeBranchPicker` to open itself on a specific
   * tab (currently only the Linear Issues tab, for the onboarding
   * suggestions module's first "Try it"). The nonce makes re-staging the
   * same tab observable. Consumed exactly once by the picker, which opens,
   * seeds the requested tab, and briefly highlights it. Not persisted.
   */
  pendingBranchPickerRequest: { tab: 'issues'; nonce: number } | null;
  /**
   * Transient request to resend once after connecting GitHub fixed a Home
   * link's clone (CAN-4466). The nonce makes a repeat observable. Consumed by
   * the send it triggers, and honoured only while fresh, so a request made
   * while Home was not mounted never sends on a later mount. Not persisted.
   */
  pendingGitHubConnectResume: { nonce: number; requestedAt: number } | null;
  /**
   * Whether Work mode has revealed the worktree/branch picker for the current
   * workspace (CAN-1817). Shared, not per HomeSurface instance: both the page
   * and the embedded Code-tab surface stay mounted and share `branchTarget`,
   * so they must agree on whether the picker is hidden before either resets
   * a hidden target. Reset on workspace change and by the surfaces on mode
   * change.
   */
  branchPickerRevealed: boolean;
  /**
   * One-shot preselection for the task-ready pipeline modal, staged by the
   * onboarding suggestions module's "Create a Task Plan" CTA: the bundled
   * implementation-plan pipeline plus a `model` input matched to the lane
   * the user actually has. `HomeSurface` feeds it into the modal and clears
   * it when the modal closes. Not persisted.
   */
  pendingTaskPlanPreset: {
    pipelineId: string;
    inputs: Record<string, string>;
  } | null;
  /**
   * Whether the user chose `workspaceId` (CAN-3606). MRU, fallback, and
   * context rebinds are inherited choices: a pasted link may propose another
   * destination for them, but never silently overrides an explicit project.
   */
  workspaceSelectionExplicit: boolean;
  /**
   * Bumped by every selection, successful same-project rules Apply, and
   * `reset()`. Lets an async flow that
   * captured it reject a completion after a newer selection, even one that
   * returned to the same workspace.
   */
  workspaceSelectionGeneration: number;
  /**
   * Preview of the worktree destination a link in the draft proposes. Preview
   * only: it never changes `workspaceId`, `branchTarget`, or context. The
   * accepted send materializes it (see `homeLinkTarget.ts`).
   */
  linkTarget: HomeLinkTargetState;
  /** Canonical reference keys the user dismissed while they stay in the draft. */
  dismissedLinkKeys: string[];
  /** The reference the user chose among several in the draft. */
  chosenLinkKey: string | null;
  chosenLinkAttachmentKey: string | null;
  chosenLinkAttachmentReferenceKey: string | null;
  linkDraftRevision: number;
  linkContextSwitchPending: boolean;
  /** Bumped by an explicit retry so an identical fingerprint re-resolves. */
  linkRetryGeneration: number;
}

/** Home adds why a folder goes missing to main's one-sentence notice. */
const MISSING_FOLDER_HINT = 'It may have been moved or renamed.';

export interface HomeMissingFolderRecovery {
  projectId: string;
  folderName: string;
  failure: InlineFailure;
}

/**
 * The error and its recovery, to set together: main's one sentence names the
 * folder, and Home adds why it may be gone.
 */
export function missingFolderSendError(missing: {
  projectId: string;
  folderName: string;
  message: string;
}): {
  sendError: InlineFailure;
  sendErrorRetryable: false;
  sendErrorChooseModel: null;
  sendErrorMissingFolder: HomeMissingFolderRecovery;
} {
  const failure: InlineFailure = {
    error: `${missing.message} ${MISSING_FOLDER_HINT}`,
  };
  return {
    sendError: failure,
    sendErrorRetryable: false,
    sendErrorChooseModel: null,
    sendErrorMissingFolder: {
      projectId: missing.projectId,
      folderName: missing.folderName,
      failure,
    },
  };
}

/** The missing-folder recovery for exactly the error Home shows now. */
export function currentMissingFolderRecovery(state: {
  sendError: InlineFailure | null;
  sendErrorMissingFolder: HomeMissingFolderRecovery | null;
}): HomeMissingFolderRecovery | null {
  const recovery = state.sendErrorMissingFolder;
  return recovery && recovery.failure === state.sendError ? recovery : null;
}

function createInitialData(): HomeComposerData {
  return {
    workspaceId: null,
    branchTarget: NEW_WORKTREE_TARGET,
    newWorktreeBaseTarget: null,
    selectedRepoId: undefined,
    mode: 'chat',
    model: undefined,
    modelSelectionMode: undefined,
    executionHarness: undefined,
    thinkingLevel: undefined,
    speed: undefined,
    fastMode: undefined,
    planMode: false,
    approvalMode: undefined,
    pluginSelections: null,
    manualPluginSelections: createEmptySelections(),
    pluginSelectionsEdited: false,
    attachments: [],
    text: '',
    fileReferences: [],
    pendingAttachmentImportIds: [],
    draftGeneration: 0,
    isSending: false,
    sendError: null,
    sendErrorRetryable: false,
    sendErrorChooseModel: null,
    sendErrorMissingFolder: null,
    branchTargets: null,
    branchTargetsStatus: 'idle',
    discovery: null,
    discoveryLoading: false,
    fileIndex: null,
    fileIndexLoading: false,
    scheduledSendDraft: null,
    pendingCreateFromReference: null,
    pendingBranchPickerRequest: null,
    pendingGitHubConnectResume: null,
    branchPickerRevealed: false,
    pendingTaskPlanPreset: null,
    workspaceSelectionExplicit: false,
    workspaceSelectionGeneration: 0,
    linkTarget: IDLE_HOME_LINK_TARGET,
    dismissedLinkKeys: [],
    chosenLinkKey: null,
    chosenLinkAttachmentKey: null,
    chosenLinkAttachmentReferenceKey: null,
    linkDraftRevision: 0,
    linkContextSwitchPending: false,
    linkRetryGeneration: 0,
  };
}

/**
 * The selected workspace's own `defaultPluginSelections`, or an empty
 * selections object when there is no selected workspace, no matching
 * project, or the project has no defaults configured. Shared by
 * `selectWorkspace` (re-seeding `pluginSelections` from the newly selected
 * workspace) and the plugins-modal save handler (computing
 * `manualPluginSelections` relative to the *current* workspace's defaults).
 */
function currentWorkspaceDefaultPluginSelections(
  workspaceId: string | null,
): ChatTabPluginSelections {
  if (!workspaceId) return createEmptySelections();
  const project = useProjectsStore
    .getState()
    .projects.find((candidate) => candidate.id === workspaceId);
  return project?.defaultPluginSelections ?? createEmptySelections();
}

/** What a chat created from a Home draft stores for its plugins. */
export interface HomeDraftChatPluginSelections {
  /** The created chat's own selections. */
  pluginSelections: ChatTabPluginSelections;
  /** Workspace defaults the draft turned off; omitted when there are none. */
  disabledGlobalPluginSelections?: PluginSelectionTombstones;
}

/**
 * Splits a Home draft against the workspace defaults the created chat
 * inherits live. The draft is seeded from those defaults, so sending it whole
 * would freeze copies of them into the chat: only the draft minus the
 * defaults is the chat's own selection, and every default missing from the
 * draft is one the user turned off.
 */
export function splitHomeDraftPluginSelections(
  draft: ChatTabPluginSelections,
  workspaceDefaults: ChatTabPluginSelections | undefined,
): HomeDraftChatPluginSelections {
  if (!workspaceDefaults) return { pluginSelections: draft };
  const { localSelections, tombstones } = splitChosenChatPluginSelections({
    chosen: draft,
    projectDefaults: workspaceDefaults,
  });
  const ownAuthPreferences = subtractPluginSelections(
    draft,
    workspaceDefaults,
  ).mcpHttpAuthPreferences;
  const pluginSelections: ChatTabPluginSelections = {
    collectionIds: localSelections.collectionIds,
    skillRefs: localSelections.skillRefs,
    pluginRefs: localSelections.pluginRefs,
    mcpServerRefs: localSelections.mcpServerRefs ?? [],
    ...(ownAuthPreferences
      ? { mcpHttpAuthPreferences: ownAuthPreferences }
      : {}),
  };
  return {
    pluginSelections,
    ...(hasAnyTombstones(tombstones)
      ? { disabledGlobalPluginSelections: tombstones }
      : {}),
  };
}

/**
 * {@link splitHomeDraftPluginSelections} against `workspaceId`'s current
 * defaults, the same source the draft was seeded from. `null` for a `null`
 * draft.
 */
export function homeDraftChatPluginSelections(
  draft: ChatTabPluginSelections | null,
  workspaceId: string,
): HomeDraftChatPluginSelections | null {
  if (draft === null) return null;
  if (!chatSurfaceUsesGlobalPluginDefaults(workspaceId)) {
    return { pluginSelections: draft };
  }
  return splitHomeDraftPluginSelections(
    draft,
    currentWorkspaceDefaultPluginSelections(workspaceId),
  );
}

export interface HomeComposerState extends HomeComposerData {
  /**
   * Switches the composer's active workspace. Always resets `branchTarget`
   * back to `{ kind: 'new-worktree' }`, clears staged `attachments` (they
   * live under the previous workspace's `home-draft`/worktree attachment
   * dir and don't carry over), and re-seeds `pluginSelections` as
   * `union(newWorkspaceDefaults, manualPluginSelections)` — the newly
   * selected workspace's own defaults plus whatever the user has manually
   * enabled beyond a workspace's defaults so far this screen-open session
   * (see {@link HomeComposerData.manualPluginSelections}) — then kicks off a
   * branch-targets load for the newly selected workspace. Passing `null`
   * clears the selection (`pluginSelections` becomes `null`) without
   * starting a load or touching `manualPluginSelections`.
   */
  selectWorkspace: (
    workspaceId: string | null,
    options?: {
      explicit?: boolean;
      preserveDraft?: boolean;
    },
  ) => void;
  /** Treat the current project as inherited so a link may propose another. */
  markWorkspaceSelectionInherited: () => void;
  /**
   * Advances selection identity without reselecting, so the draft, branch
   * target, and attachments stay as they are and a successful same-project
   * rules Apply supersedes older pending review completions.
   */
  advanceWorkspaceSelectionGeneration: () => void;
  setLinkTarget: (linkTarget: HomeLinkTargetState) => void;
  /** Ignore these references until they leave the draft. */
  dismissLinkReferences: (keys: readonly string[]) => void;
  setDismissedLinkKeys: (keys: string[]) => void;
  chooseLinkReference: (key: string | null) => void;
  chooseLinkAttachment: (key: string, referenceKey: string) => void;
  retryLinkTarget: () => void;
  setBranchTarget: (target: HomeBranchTarget) => void;
  setNewWorktreeBaseTarget: (target: HomeNewWorktreeBaseTarget) => void;
  /**
   * Sets the multi-repo working-directory selection. Mirrors
   * `chatStore.setSelectedRepoId`'s normalization: `WORKSPACE_ROOT_REPO_ID`
   * collapses to `undefined` ("project root").
   */
  setSelectedRepoId: (selectedRepoId: string | undefined) => void;
  setMode: (mode: HomeComposerMode) => void;
  setModel: (
    model: ChatModel | undefined,
    billingFramework?: 'subscription' | 'ai-credits',
    executionHarness?: ModelHarness,
  ) => void;
  /**
   * Enter or leave Auto for this draft. Entering clears the explicit harness
   * pin; leaving is implicit in `setModel`, which any concrete pick calls.
   */
  setModelSelectionMode: (mode: 'auto' | 'manual') => void;
  setExecutionHarness: (harness: ModelHarness) => void;
  /**
   * Commit an explicit thinking level — the `next` value the shared
   * `ThinkingLevelControl` computed from the set it displays (CAN-2540 §3).
   * `cycleThinkingLevel` remains for keyboard shortcuts, which advance
   * without a mounted control.
   */
  setThinkingLevel: (level: ThinkingLevel) => void;
  /** Stage an exact Codex speed (with its derived legacy boolean). */
  setSpeed: (speed: CodexSpeed) => void;
  /**
   * Legacy boolean control: `true` stages Fast and `false` Regular,
   * replacing any staged speed.
   */
  setFastMode: (enabled: boolean) => void;
  cycleThinkingLevel: () => void;
  togglePlanMode: () => void;
  /**
   * Sets (or clears, via `undefined`) the composer's tool-approval mode
   * override. An explicit call always wins over the resolved default —
   * mirrors `setModel`'s "concrete value replaces the untouched sentinel"
   * contract.
   */
  setApprovalMode: (mode: ApprovalMode | undefined) => void;
  setPluginSelections: (selections: ChatTabPluginSelections) => void;
  /**
   * Rebase an UNEDITED working set onto the current workspace defaults
   * (union with the manual delta). No-op once the user explicitly edited
   * selections for this workspace, or when no workspace is selected. Called
   * when workspace defaults finish loading after `selectWorkspace` seeded a
   * stale snapshot (async projects load at startup), so both suggestion
   * eligibility and the send path consume the same fresh selections.
   */
  syncWorkspaceDefaultPluginSelections: () => void;
  addAttachments: (attachments: AttachmentMeta[]) => void;
  removeAttachment: (absolutePath: string) => void;
  setText: (text: string) => void;
  /** Publish an editor mutation as one text/reference snapshot. */
  setDraft: (draft: {
    text: string;
    fileReferences: readonly FileReference[];
  }) => void;
  /**
   * Empties the submitted text and references after a successful send
   * (CAN-3933) while leaving the rest of the draft (workspace, attachments,
   * branch target, schedule, settings, send state) alone. Bumps
   * `draftGeneration` so every mounted editor re-syncs.
   */
  clearSubmittedDraft: () => void;
  /** Sets the `file-reference` pills serialized out of the editor alongside
   * `text` (Task F3) — kept in lockstep by `HomeSurface` on every editor
   * change. */
  setFileReferences: (fileReferences: FileReference[]) => void;
  beginAttachmentImport: () => HomeAttachmentImportToken;
  finishAttachmentImport: (token: HomeAttachmentImportToken) => void;
  /**
   * Sets/clears the staged one-time schedule for the draft's next send.
   * Cleared by `selectWorkspace` and `reset`.
   */
  setScheduledSendDraft: (draft: { runAt: string } | null) => void;
  /**
   * Sets/clears the transient resume handoff consumed by the Home branch
   * picker's "Add {owner}/{repo} as a workspace…" offer flow (ECW-8121). See
   * {@link HomeComposerData.pendingCreateFromReference}.
   */
  setPendingCreateFromReference: (reference: string | null) => void;
  /**
   * Stages a one-shot "open the branch picker on this tab" request (nonce
   * bumped per request). See
   * {@link HomeComposerData.pendingBranchPickerRequest}.
   */
  requestBranchPickerTab: (tab: 'issues') => void;
  setBranchPickerRevealed: (revealed: boolean) => void;
  /** Consumes the staged branch-picker request. */
  consumeBranchPickerRequest: () => void;
  /**
   * Stages a one-shot resend after connecting GitHub. See
   * {@link HomeComposerData.pendingGitHubConnectResume}.
   */
  requestGitHubConnectResume: () => void;
  /**
   * Consumes the staged resend. Returns true only when one was pending and
   * still fresh at `now`.
   */
  consumeGitHubConnectResume: (now?: number) => boolean;
  /**
   * Stages/clears the one-shot task-ready modal preselection. See
   * {@link HomeComposerData.pendingTaskPlanPreset}.
   */
  stageTaskPlanPreset: (
    preset: { pipelineId: string; inputs: Record<string, string> } | null,
  ) => void;
  /**
   * Sets/clears the composer-level error banner. Used for attachment-import
   * failures today and available to B5's send orchestrator for send
   * failures — `selectWorkspace` and `reset` both clear it.
   */
  setSendError: (error: string | InlineFailure | null) => void;
  /**
   * Loads branch targets for the currently selected workspace via
   * `window.api.homeListBranchTargets`. Guarded against stale responses: if
   * `workspaceId` changes while the request is in flight (the user picked a
   * different workspace before this one resolved), the response is dropped
   * instead of overwriting the newly selected workspace's state.
   */
  loadBranchTargets: () => Promise<void>;
  retryBranchTargets: () => void;
  /**
   * Loads discovery (slash commands, MCP servers) for the currently
   * selected workspace/branch-target/model-provider combination via
   * `window.api.homeDiscoverEnvironment`. Guarded against stale responses
   * the same way `loadBranchTargets` is: if `workspaceId`, `branchTarget`,
   * or the resolved provider type change while the request is in flight,
   * the response is dropped instead of overwriting newer state. Does
   * nothing when no workspace is selected.
   *
   * Pass `force: true` (from the commands popup's explicit "Refresh"
   * affordance) to bypass the main process's 5-minute discovery cache and
   * re-run a fresh discovery; the automatic reload effect leaves it unset so
   * a warm cache is reused.
   */
  loadDiscovery: (force?: boolean) => Promise<void>;
  /**
   * Loads the target-aware file index (Task F3) backing the `@` mention
   * typeahead for the currently selected workspace/branch-target via
   * `window.api.homeFileIndex`. Uses the SAME target mapping as
   * `loadDiscovery` (`resolveHomeDiscoveryTarget`) and the same
   * stale-response guard: if `workspaceId` or `branchTarget` change while the
   * request is in flight, the response is dropped instead of overwriting
   * newer state. Does nothing when no workspace is selected.
   *
   * Pass `force: true` to bypass the main process's baseline-target cache
   * (shadow-keyed) and rebuild the index fresh; `worktree`/`cowork` targets
   * are never cached server-side, so `force` has no effect on them.
   */
  loadFileIndex: (force?: boolean) => Promise<void>;
  reset: () => void;
}

let nextHomeAttachmentImportId = 1;
let branchTargetsRequest = 0;

export const useHomeComposerStore = create<HomeComposerState>((set, get) => ({
  ...createInitialData(),

  selectWorkspace: (workspaceId, options): void => {
    const workspacePluginSelections = workspaceId
      ? unionPluginSelections(
          currentWorkspaceDefaultPluginSelections(workspaceId),
          get().manualPluginSelections,
        )
      : null;

    set({
      workspaceId,
      workspaceSelectionExplicit: options?.explicit === true,
      workspaceSelectionGeneration: get().workspaceSelectionGeneration + 1,
      executionHarness: undefined,
      branchTarget: NEW_WORKTREE_TARGET,
      newWorktreeBaseTarget: null,
      branchPickerRevealed: false,
      pluginSelectionsEdited: false,
      // Repo ids are workspace-specific — a carried-over selection could
      // silently match an unrelated repo with the same id in the new
      // workspace, so always fall back to the workspace root.
      selectedRepoId: undefined,
      pluginSelections: workspacePluginSelections,
      // Staged attachments live under the *previous* workspace's
      // `home-draft` (or worktree) attachment dir — they don't carry over to
      // a newly selected workspace.
      attachments: [],
      branchTargets: null,
      branchTargetsStatus: 'idle',
      discovery: null,
      discoveryLoading: false,
      fileIndex: null,
      fileIndexLoading: false,
      sendError: null,
      sendErrorRetryable: false,
      sendErrorChooseModel: null,
      sendErrorMissingFolder: null,
      pendingGitHubConnectResume: null,
      scheduledSendDraft: null,
      pendingAttachmentImportIds: [],
      draftGeneration: get().draftGeneration + 1,
      ...(options?.preserveDraft
        ? {
            attachments: get().attachments,
            scheduledSendDraft: get().scheduledSendDraft,
          }
        : {}),
    });

    if (workspaceId) {
      void get().loadBranchTargets();
    }
  },

  markWorkspaceSelectionInherited: (): void => {
    set({ workspaceSelectionExplicit: false });
  },

  advanceWorkspaceSelectionGeneration: (): void => {
    set((state) => ({
      workspaceSelectionGeneration: state.workspaceSelectionGeneration + 1,
    }));
  },

  setLinkTarget: (linkTarget): void => {
    set({ linkTarget });
  },

  dismissLinkReferences: (keys): void => {
    set((state) => ({
      dismissedLinkKeys: Array.from(
        new Set([...state.dismissedLinkKeys, ...keys]),
      ),
      chosenLinkKey: null,
      chosenLinkAttachmentKey: null,
      chosenLinkAttachmentReferenceKey: null,
      linkTarget: IDLE_HOME_LINK_TARGET,
    }));
  },

  setDismissedLinkKeys: (keys): void => {
    set({ dismissedLinkKeys: keys });
  },

  chooseLinkReference: (key): void => {
    set({
      chosenLinkKey: key,
      chosenLinkAttachmentKey: null,
      chosenLinkAttachmentReferenceKey: null,
    });
  },
  chooseLinkAttachment: (key, referenceKey): void => {
    set((state) => ({
      chosenLinkAttachmentKey: key,
      chosenLinkAttachmentReferenceKey: referenceKey,
      linkRetryGeneration: state.linkRetryGeneration + 1,
    }));
  },

  retryLinkTarget: (): void => {
    set((state) => ({ linkRetryGeneration: state.linkRetryGeneration + 1 }));
  },

  setBranchTarget: (target): void => {
    set((state) => ({
      branchTarget: target,
      pendingAttachmentImportIds: [],
      draftGeneration: state.draftGeneration + 1,
      ...(state.sendError &&
      (sourceNoCommitsFailures.has(state.sendError) ||
        state.sendError.error === MISSING_HOME_WORKTREE_BASE_MESSAGE)
        ? { sendError: null }
        : {}),
    }));
  },

  setNewWorktreeBaseTarget: (target): void => {
    set((state) => ({
      newWorktreeBaseTarget: captureWorktreeBaseTarget(
        target,
        state.branchTargets,
      ),
      draftGeneration: state.draftGeneration + 1,
      ...(state.sendError &&
      (sourceNoCommitsFailures.has(state.sendError) ||
        state.sendError.error === MISSING_HOME_WORKTREE_BASE_MESSAGE)
        ? { sendError: null }
        : {}),
    }));
  },

  setSelectedRepoId: (selectedRepoId): void => {
    set({
      selectedRepoId:
        selectedRepoId === WORKSPACE_ROOT_REPO_ID ? undefined : selectedRepoId,
    });
  },

  setMode: (mode): void => {
    if (get().mode !== mode)
      set((state) => ({ linkDraftRevision: state.linkDraftRevision + 1 }));
    // Switching to pipeline mode fully unmounts the schedule affordance (the
    // schedule button and pill live only in chat mode), so a staged
    // `scheduledSendDraft` would otherwise become a hidden schedule that
    // silently resurfaces on switching back to chat. Clear it on the way in.
    // Symmetrically, leaving pipeline mode drops any staged task-plan
    // preselection so an abandoned onboarding CTA cannot preselect a later,
    // unrelated task-ready modal.
    // Link previews belong to chat sends only; pipeline submission never
    // sees a link intent (CAN-3606).
    set(
      mode === 'pipeline'
        ? {
            mode,
            scheduledSendDraft: null,
            executionHarness: undefined,
            linkTarget: IDLE_HOME_LINK_TARGET,
          }
        : { mode, pendingTaskPlanPreset: null },
    );
  },

  setModelSelectionMode: (mode): void => {
    const state = get();
    if (
      mode === 'auto' &&
      isAgentModel(
        state.model ?? resolveHomeEffectiveDefaults(state.workspaceId).model,
      )
    )
      return;
    set(
      mode === 'auto'
        ? { modelSelectionMode: 'auto', executionHarness: undefined }
        : { modelSelectionMode: undefined },
    );
  },

  setModel: (model, billingFramework, executionHarness): void => {
    if (billingFramework)
      useChatStore.getState().rememberBillingFramework(billingFramework);
    const previous = get();
    const { model: previousModel, sendErrorChooseModel } = previous;
    const defaults = resolveHomeEffectiveDefaults(previous.workspaceId);
    const previousEffective = pinInheritingAgentModel(
      previousModel ?? defaults.model,
      defaults.model,
    );
    const nextEffective = pinInheritingAgentModel(
      model ?? defaults.model,
      defaults.model,
    );
    const previousProvider = getProviderForChatModel(
      previousEffective,
      previous.executionHarness,
    );
    const candidateHarness =
      executionHarness ??
      (model === previousModel ? previous.executionHarness : undefined);
    const nextHarness =
      candidateHarness &&
      getChatHarnessOptions(nextEffective).includes(candidateHarness)
        ? candidateHarness
        : undefined;
    const nextProvider = getProviderForChatModel(nextEffective, nextHarness);
    const agentProviderChanged =
      (isAgentModel(previousEffective) || isAgentModel(nextEffective)) &&
      previousProvider !== nextProvider &&
      nextProvider !== undefined;
    // Picking a concrete model IS the exit from Auto, on Home exactly as in an
    // ongoing chat.
    // The plugin selection is the same working set on every model — a Cursor
    // draft loads skills, plugins, MCP servers, and Collections like any
    // other — so switching models never rebuilds it; only Claude/Codex
    // extension discovery, which Cursor has no counterpart for, is dropped.
    set({
      model,
      executionHarness: nextHarness,
      modelSelectionMode: undefined,
      ...(agentProviderChanged && nextProvider
        ? {
            thinkingLevel: previous.workspaceId
              ? resolveProviderDefaults(
                  previous.workspaceId,
                  useChatStore.getState().modelDefaults,
                  nextProvider,
                ).thinkingLevel
              : undefined,
            speed: undefined,
            fastMode: undefined,
          }
        : {}),
      // An accepted replacement resolves a model refusal and its action.
      ...(sendErrorChooseModel && model !== previousModel
        ? {
            sendError: null,
            sendErrorChooseModel: null,
            sendErrorMissingFolder: null,
          }
        : {}),
      ...(isCursorModel(model)
        ? { discovery: null, discoveryLoading: false }
        : {}),
    });
  },

  setExecutionHarness: (executionHarness): void => {
    const state = get();
    const model =
      state.model ?? resolveHomeEffectiveDefaults(state.workspaceId).model;
    if (getChatHarnessOptions(model).includes(executionHarness))
      set({ model, executionHarness });
  },

  setThinkingLevel: (level): void => {
    set({ thinkingLevel: level });
  },

  cycleThinkingLevel: (): void => {
    const state = get();
    // Untouched (`undefined`) draft levels cycle starting from the
    // *effective* resolved default, not from a fixed starting point, so the
    // first click always advances relative to what the user was actually
    // shown.
    const effective = resolveHomeEffectiveModelSettings(
      state.workspaceId,
      state.model,
      state.thinkingLevel,
      state.executionHarness,
    );
    set({
      thinkingLevel: advanceThinkingControlLevel(
        effective.thinkingLevel,
        effective.supportedThinkingLevels,
        effective.supportedThinkingLevels.includes('low'),
      ),
    });
  },

  togglePlanMode: (): void => {
    set((state) => ({ planMode: !state.planMode }));
  },

  setSpeed: (speed): void => {
    set({ speed, fastMode: codexSpeedFastMode(speed) });
  },

  setFastMode: (enabled): void => {
    get().setSpeed(codexSpeedFromFastMode(enabled));
  },

  setApprovalMode: (mode): void => {
    set({ approvalMode: mode });
  },

  setPluginSelections: (rawSelections): void => {
    if (!homeDraftAcceptsPluginSelections(get().workspaceId, get().model))
      return;
    // The plugins modal saves the user's exact working set — including any
    // default the user explicitly removed for this workspace. Recompute the
    // delta beyond the *current* workspace's defaults so a later
    // `selectWorkspace` re-applies only genuinely manual additions, not
    // removals (removals are per-workspace-session only).
    const currentDefaults = currentWorkspaceDefaultPluginSelections(
      get().workspaceId,
    );
    const manualDelta = subtractPluginSelections(
      rawSelections,
      currentDefaults,
    );
    set({
      pluginSelections: rawSelections,
      pluginSelectionsEdited: true,
      manualPluginSelections: manualDelta,
    });
  },

  syncWorkspaceDefaultPluginSelections: (): void => {
    const { workspaceId, pluginSelectionsEdited, manualPluginSelections } =
      get();
    if (!homeDraftAcceptsPluginSelections(workspaceId, get().model)) return;
    if (!workspaceId || pluginSelectionsEdited) return;
    const merged = unionPluginSelections(
      currentWorkspaceDefaultPluginSelections(workspaceId),
      manualPluginSelections,
    );
    const next = merged;
    const current = get().pluginSelections;
    if (
      current !== null &&
      pluginSelectionsSignature(current) === pluginSelectionsSignature(next)
    ) {
      return;
    }
    set({ pluginSelections: next });
  },

  addAttachments: (attachments): void => {
    set((state) => {
      const existingPaths = new Set(
        state.attachments.map((attachment) => attachment.absolutePath),
      );
      const additions = attachments.filter(
        (attachment) => !existingPaths.has(attachment.absolutePath),
      );
      return { attachments: [...state.attachments, ...additions] };
    });
  },

  removeAttachment: (absolutePath): void => {
    set((state) => ({
      attachments: state.attachments.filter(
        (attachment) => attachment.absolutePath !== absolutePath,
      ),
    }));
  },

  setText: (text): void => {
    if (get().text !== text)
      set((state) => ({
        text,
        linkDraftRevision: state.linkDraftRevision + 1,
      }));
  },

  setDraft: (draft): void => {
    set((state) => ({
      text: draft.text,
      fileReferences: draft.fileReferences.map((reference) => ({
        ...reference,
      })),
      linkDraftRevision:
        state.linkDraftRevision + (state.text !== draft.text ? 1 : 0),
    }));
  },

  clearSubmittedDraft: (): void => {
    set((state) => ({
      text: '',
      fileReferences: [],
      draftGeneration: state.draftGeneration + 1,
      linkDraftRevision: state.linkDraftRevision + (state.text !== '' ? 1 : 0),
    }));
  },

  setFileReferences: (fileReferences): void => {
    set({ fileReferences });
  },

  beginAttachmentImport: (): HomeAttachmentImportToken => {
    const token = {
      id: nextHomeAttachmentImportId++,
      draftGeneration: get().draftGeneration,
    };
    set((state) => ({
      pendingAttachmentImportIds: [
        ...state.pendingAttachmentImportIds,
        token.id,
      ],
    }));
    return token;
  },

  finishAttachmentImport: (token): void => {
    set((state) => ({
      pendingAttachmentImportIds: state.pendingAttachmentImportIds.filter(
        (id) => id !== token.id,
      ),
    }));
  },

  setScheduledSendDraft: (draft): void => {
    set({
      scheduledSendDraft: draft,
      ...(draft ? { executionHarness: undefined } : {}),
    });
  },

  setPendingCreateFromReference: (reference): void => {
    set({ pendingCreateFromReference: reference });
  },

  requestBranchPickerTab: (tab): void => {
    set((state) => ({
      pendingBranchPickerRequest: {
        tab,
        nonce: (state.pendingBranchPickerRequest?.nonce ?? 0) + 1,
      },
    }));
  },

  setBranchPickerRevealed: (revealed): void => {
    if (get().branchPickerRevealed === revealed) return;
    set({ branchPickerRevealed: revealed });
  },

  consumeBranchPickerRequest: (): void => {
    set({ pendingBranchPickerRequest: null });
  },

  requestGitHubConnectResume: (): void => {
    set((state) => ({
      pendingGitHubConnectResume: {
        nonce: (state.pendingGitHubConnectResume?.nonce ?? 0) + 1,
        requestedAt: Date.now(),
      },
    }));
  },

  consumeGitHubConnectResume: (now = Date.now()): boolean => {
    const pending = get().pendingGitHubConnectResume;
    if (!pending) return false;
    set({ pendingGitHubConnectResume: null });
    return isGitHubConnectResumeFresh(pending, now);
  },

  stageTaskPlanPreset: (preset): void => {
    set({ pendingTaskPlanPreset: preset });
  },

  setSendError: (error): void => {
    set({
      sendError: typeof error === 'string' ? { error } : error,
      sendErrorRetryable: false,
      sendErrorChooseModel: null,
      sendErrorMissingFolder: null,
    });
  },

  retryBranchTargets: (): void => {
    const state = get();
    if (state.branchTargetsStatus === 'error') void state.loadBranchTargets();
  },

  loadBranchTargets: async (): Promise<void> => {
    const request = ++branchTargetsRequest;
    const requestedWorkspaceId = get().workspaceId;
    if (!requestedWorkspaceId) {
      set({ branchTargets: null, branchTargetsStatus: 'idle' });
      return;
    }

    // Keep the last authoritative catalogue and its missing-ref warning
    // until a completed read confirms that the exact ref is present.
    set({ branchTargetsStatus: 'loading' });

    let response: HomeBranchTargetsResponse | undefined;
    try {
      response = await window.api.homeListBranchTargets({
        workspaceId: requestedWorkspaceId,
      });
    } catch (error) {
      // A failed read cannot replace a selection or invalidate its last catalogue.
      reportClientAppError(error);
    }

    if (
      request !== branchTargetsRequest ||
      get().workspaceId !== requestedWorkspaceId
    ) {
      // A newer refresh or a new selection owns the result, including a
      // switch away and back to the same workspace while this read waited.
      return;
    }

    const project = useProjectsStore
      .getState()
      .projects.find((candidate) => candidate.id === requestedWorkspaceId);
    const { sendError, branchTargets, newWorktreeBaseTarget } = get();
    const catalogue =
      response ??
      (branchTargets?.supported && hasExactWorktreeBaseCatalogue(branchTargets)
        ? { ...branchTargets, headUnborn: undefined }
        : FALLBACK_BRANCH_TARGETS);
    const status = response ? 'ready' : 'error';
    set({
      branchTargets: catalogue,
      branchTargetsStatus: status,
      newWorktreeBaseTarget:
        project?.type === 'single-repo'
          ? (newWorktreeBaseTarget ?? defaultNewWorktreeBaseTarget(catalogue))
          : null,
      // A first commit made outside the app clears the preflight block. An
      // unknown result (absent) clears it too; the backend still classifies.
      ...(sendError &&
      ((catalogue.headUnborn !== true &&
        sourceNoCommitsFailures.has(sendError)) ||
        (sendError.error === MISSING_HOME_WORKTREE_BASE_MESSAGE &&
          !homeWorktreeBaseMissing(newWorktreeBaseTarget, catalogue, status)))
        ? { sendError: null }
        : {}),
    });
  },

  loadDiscovery: async (force?: boolean): Promise<void> => {
    const requestedState = get();
    const requestedWorkspaceId = requestedState.workspaceId;
    if (!requestedWorkspaceId) {
      set({ discovery: null, discoveryLoading: false });
      return;
    }

    const requestedBranchTarget = requestedState.branchTarget;
    const requestedSelectedRepoId = requestedState.selectedRepoId;
    const requestedProviderType = resolveHomeEffectiveProviderType(
      requestedWorkspaceId,
      requestedState.model,
      requestedState.executionHarness,
    );
    if (
      requestedProviderType === undefined ||
      requestedProviderType === 'antigravity' ||
      requestedProviderType === 'cursor' ||
      requestedProviderType === 'copilot' ||
      requestedProviderType === 'opencode'
    ) {
      set({ discovery: null, discoveryLoading: false });
      return;
    }
    const requestedPluginSelections = requestedState.pluginSelections;
    const requestedPluginSelectionsSignature = pluginSelectionsSignature(
      requestedPluginSelections,
    );
    const target = resolveHomeDiscoveryTarget(
      requestedBranchTarget,
      isCoworkWorkspaceId(requestedWorkspaceId),
      requestedSelectedRepoId,
    );

    set({ discoveryLoading: true });

    let discovery: WorktreeDiscovery | null;
    try {
      const response = await window.api.homeDiscoverEnvironment({
        workspaceId: requestedWorkspaceId,
        target,
        providerType: requestedProviderType,
        ...(requestedPluginSelections
          ? { pluginSelections: requestedPluginSelections }
          : {}),
        ...(force ? { force: true } : {}),
      });
      discovery = response.discovery;
    } catch (error) {
      // Discovery is best effort; Home works without it. Record the failure.
      reportClientAppError(error);
      discovery = null;
    }

    const current = get();
    const stillCurrent =
      current.workspaceId === requestedWorkspaceId &&
      homeBranchTargetsEqual(current.branchTarget, requestedBranchTarget) &&
      current.selectedRepoId === requestedSelectedRepoId &&
      resolveHomeEffectiveProviderType(
        current.workspaceId,
        current.model,
        current.executionHarness,
      ) === requestedProviderType &&
      pluginSelectionsSignature(current.pluginSelections) ===
        requestedPluginSelectionsSignature;
    if (!stillCurrent) {
      // Stale response: the user changed workspace, branch target, working
      // directory, model provider, or plugin selections while this request
      // was in flight.
      return;
    }

    set({ discovery, discoveryLoading: false });
  },

  loadFileIndex: async (force?: boolean): Promise<void> => {
    const requestedState = get();
    const requestedWorkspaceId = requestedState.workspaceId;
    if (!requestedWorkspaceId) {
      set({ fileIndex: null, fileIndexLoading: false });
      return;
    }

    const requestedBranchTarget = requestedState.branchTarget;
    const requestedSelectedRepoId = requestedState.selectedRepoId;
    const target = resolveHomeDiscoveryTarget(
      requestedBranchTarget,
      isCoworkWorkspaceId(requestedWorkspaceId),
      requestedSelectedRepoId,
    );

    set({ fileIndexLoading: true });

    let fileIndex: RepoFileIndex[] | null;
    try {
      const response = await window.api.homeFileIndex({
        workspaceId: requestedWorkspaceId,
        target,
        ...(force ? { force: true } : {}),
      });
      fileIndex = response.repos;
    } catch (error) {
      // File mentions work without the index; record the failed read.
      reportClientAppError(error);
      fileIndex = null;
    }

    const current = get();
    const stillCurrent =
      current.workspaceId === requestedWorkspaceId &&
      homeBranchTargetsEqual(current.branchTarget, requestedBranchTarget) &&
      current.selectedRepoId === requestedSelectedRepoId;
    if (!stillCurrent) {
      // Stale response: the user changed workspace, branch target, or
      // working directory while this request was in flight.
      return;
    }

    set({ fileIndex, fileIndexLoading: false });
  },

  reset: (): void => {
    set((state) => ({
      ...createInitialData(),
      draftGeneration: state.draftGeneration + 1,
      workspaceSelectionGeneration: state.workspaceSelectionGeneration + 1,
    }));
  },
}));

// The renderer store can outlive every composer view. Clear its draft even
// when no Home surface is mounted when the authenticated account changes.
useWorkspaceContextStore.subscribe((current, previous): void => {
  if (current.accountEpoch !== previous.accountEpoch) {
    useHomeComposerStore.getState().reset();
  }
});
