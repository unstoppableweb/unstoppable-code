import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import {
  readCoworkFolderMissing,
  type CoworkFolderStatus,
} from '@canopy/protocol/canopy-core/core';
import { resolveCoworkFolderMissing } from '@/lib/ipc-cowork-folder';
import {
  inlineFailure,
  inlineFailureText,
  type InlineFailure,
} from '@/lib/inline-app-error';
import { notifyAcceptedWorktreeTurn } from '../onboarding-tips/homeSendEvents';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { isCursorModel } from '@canopy/execution-engine/lib/cursor-models';
import type {
  AttachmentMeta,
  BranchEntry,
  ChatAttachmentPromptContext,
  ChatModel,
  ChatTabPluginSelections,
  FileReference,
  ModelHarness,
  SidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { isChatAttachmentPromptKind } from '@canopy/desktop-shared/types';
import { composerDraftContentEquals } from '@canopy/ui-app';
import { isCoworkChatTarget } from '@/lib/cowork';
import { workspaceRepoPathForCreateFrom } from '@/lib/createFromSource';
import {
  importChatAttachments,
  type AttachmentImportTarget,
} from '@/lib/chatAttachments';
import { extractIpcErrorMessage } from '@/lib/errors';
import {
  getCwdFromFileIndex,
  rewriteFileReferencesAcrossRepoRoots,
  rewriteFileReferencesForCwd,
  rewriteFileReferencesForTargetCwd,
} from '@/lib/file-reference-paths';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { showAutomationCreatedToast } from '@/lib/automationToasts';
import { ensureWorktreePanelLayout } from '@/lib/panels/persistence-bridge';
import { useChatStore } from '@/stores/chatStore';
import { nextMsgId } from '@/stores/chat/ids';
import type { ChatTab } from '@/stores/chat/types';
import { isTabAiCreditsRouted } from '@/stores/chat/tab-utils';
import { provisionalFirstSendAttemptId } from '@/stores/chat/provisional-first-send';
import { loadChatMessageListModule } from '@/components/chat/chatMessageListChunk';
import {
  getWorktreeCacheKey,
  useFileListStore,
  withRetainedFileIndex,
} from '@/stores/fileListStore';
import {
  useProjectsStore,
  type CreateWorktreeOptions,
} from '@/stores/projectsStore';
import { expandPromptMentions } from '@/lib/promptMentionExpansion';
import { missingMentionedPluginRefs } from '@canopy/desktop-shared/lib/plugin-mention';
import { mergeChatPluginSelections } from '@/lib/chatPluginSelections';
import { applyNewChatPluginSelections } from '@/lib/chatPluginEditing';
import { createEmptySelections } from '@/lib/pluginSelections';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  OrgDefaultChatsUnavailableError,
  requireOrgDefaultChatsEligibility,
  useStandaloneChatStore,
} from '@/stores/standaloneChatStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useGitHubConnectOfferStore } from '@/stores/githubConnectOfferStore';
import {
  createOptionsForBranchTarget,
  createOptionsForNewWorktreeBaseTarget,
  homeWorktreeBaseMissing,
  MISSING_HOME_WORKTREE_BASE_MESSAGE,
  homeDraftChatPluginSelections,
  missingFolderSendError,
  homeSendUsesSourceHead,
  resolveHomeEffectiveModelSettings,
  resolveHomeSpeed,
  sourceNoCommitsSendFailure,
  useHomeComposerStore,
  type HomeBranchTarget,
  type HomeNewWorktreeBaseTarget,
} from '@/stores/homeComposerStore';
import type { TaskReadyPipelineLaunchTarget } from '@/components/worktree/useTaskReadyPipelineLauncher';
import {
  materializeHomeLinkPlan,
  type HomeLinkMaterializeResult,
  homeLinkPromptWithIssueContext,
  type HomeLinkIssueContext,
} from './homeLinkTarget';
import { createHomeLinkMaterializeDeps } from './homeLinkTargetHost';
import {
  gateHomeLinkSend,
  syncHomeLinkTarget,
  type HomeLinkSendGate,
} from './homeLinkTargetSync';
import { homeLinkScopeKey } from './homeLinkTargetHost';
import {
  cachedHomeModelRefusal,
  preflightHomeModel,
  type HomeModelPreflightResult,
} from './homeModelPreflight';
import {
  homeModelDisplayLabel,
  homeModelFailureMessage,
} from './homeModelFailureCopy';

let linkSubmissionController: AbortController | null = null;
let activeHomeSubmissionId: string | null = null;

export function cancelHomeLinkSubmission(): void {
  const target = useHomeComposerStore.getState().linkTarget;
  if (target.status === 'submitting' && !target.canCancel) return;
  linkSubmissionController?.abort();
}

function isHomeSendAccountCurrent(submittedAccountEpoch: number): boolean {
  return (
    useWorkspaceContextStore.getState().accountEpoch === submittedAccountEpoch
  );
}

function attachmentsEqual(
  a: readonly AttachmentMeta[],
  b: readonly AttachmentMeta[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (attachment, index) => attachment.absolutePath === b[index]?.absolutePath,
    )
  );
}

function scheduleEqual(
  a: { runAt: string } | null,
  b: { runAt: string } | null,
): boolean {
  return a === null || b === null ? a === b : a.runAt === b.runAt;
}

/**
 * Content-based (CAN-3933): true while the user still sees the submitted
 * draft, not "no store write happened". Routine plumbing (a branch-target
 * default, a `draftGeneration` bump, an editor echo that clones references)
 * does not count as a newer draft.
 */
function isSubmittedHomeDraftCurrent(
  draft: ReturnType<typeof useHomeComposerStore.getState>,
): boolean {
  const current = useHomeComposerStore.getState();
  return (
    current.mode === draft.mode &&
    current.workspaceId === draft.workspaceId &&
    composerDraftContentEquals(current, draft) &&
    attachmentsEqual(current.attachments, draft.attachments) &&
    scheduleEqual(current.scheduledSendDraft, draft.scheduledSendDraft)
  );
}

const PIPELINE_TASK_TEXT_INSTRUCTION_HEADER =
  'Review these task context files before starting (absolute paths):';

/**
 * Builds the task text a `task_ready` pipeline run receives from the Home
 * composer's pipeline mode.
 *
 * Chat-mode sends never call this — they pass attachments through
 * `attachmentPaths`/`attachmentPromptContexts` and leave the typed text
 * untouched (D1's `<system_instruction>` block in `buildSubmittedMessageText`
 * already covers Linear snapshot context there). Pipeline runs have no such
 * mechanism, so when the draft has staged attachments this appends an
 * instruction block: a blank line, the header line, then one
 * `- {absolutePath}` line per attachment (Linear ticket snapshots — detected
 * via `promptKind: 'linear-ticket'` — get a trailing
 * ` (Linear ticket snapshot)` annotation so the agent knows to treat that
 * file as the task's source context rather than a generic reference file).
 *
 * When the user typed no text, the instruction block alone becomes the task
 * text (this is what makes an attachments-only pipeline draft — e.g. just a
 * staged Linear ticket — sendable; see `isHomeSendEnabled`).
 */
export function buildPipelineTaskText(
  text: string,
  attachments: readonly AttachmentMeta[],
): string {
  const trimmedText = text.trim();
  if (attachments.length === 0) {
    return trimmedText;
  }

  const instructionBlock = [
    PIPELINE_TASK_TEXT_INSTRUCTION_HEADER,
    ...attachments.map((attachment) => {
      const suffix =
        attachment.promptKind === 'linear-ticket'
          ? ' (Linear ticket snapshot)'
          : '';
      return `- ${attachment.absolutePath}${suffix}`;
    }),
  ].join('\n');

  return trimmedText.length > 0
    ? `${trimmedText}\n\n${instructionBlock}`
    : instructionBlock;
}

/**
 * Mirrors `ChatInput`'s local `attachmentPromptContextsFromMeta` helper: only
 * attachments staged with a known `promptKind` (in-app-browser "Pick &
 * Polish" resources and Linear ticket snapshots) carry a prompt context.
 * Membership is delegated to the shared `isChatAttachmentPromptKind`
 * predicate so new kinds flow through automatically.
 */
function attachmentPromptContextsFromMeta(
  attachments: readonly AttachmentMeta[],
): ChatAttachmentPromptContext[] | undefined {
  const contexts = attachments
    .filter(
      (
        attachment,
      ): attachment is AttachmentMeta & {
        promptKind: NonNullable<AttachmentMeta['promptKind']>;
      } => isChatAttachmentPromptKind(attachment.promptKind),
    )
    .map((attachment) => ({
      attachmentPath: attachment.absolutePath,
      promptKind: attachment.promptKind,
    }));
  return contexts.length > 0 ? contexts : undefined;
}

function attachmentPathsFromMeta(
  attachments: readonly AttachmentMeta[],
): string[] | undefined {
  return attachments.length > 0
    ? attachments.map((attachment) => attachment.absolutePath)
    : undefined;
}

/**
 * `undefined` when there is nothing to send — mirrors `ChatInput`'s
 * `outboundFileReferences` convention (an empty array is never sent over
 * IPC/persisted as `fileReferences: []`).
 */
function outboundFileReferences(
  fileReferences: readonly FileReference[],
): FileReference[] | undefined {
  return fileReferences.length > 0 ? [...fileReferences] : undefined;
}

/** A prompt plus its `@`-mention pills after cwd-aware rewriting. */
interface RewrittenDraftPrompt {
  prompt: string;
  fileReferences: FileReference[];
}

/**
 * Rewrites the draft's `@`-mention pills — AND the prompt text they're
 * inlined into — onto a worktree send target's cwd (Task F3 + review fix
 * round 1). Pills can carry stale `absolutePath`s in two ways:
 * `new-worktree`/`branch` targets index the repo-shadow checkout (no real
 * worktree exists at pick time), and the branch picker can be switched AFTER
 * a pill was inserted (pills survive target switches — clearing them would
 * delete user-typed message content). So every worktree route resolves the
 * actual target cwd and re-roots any reference that isn't already under it —
 * see `rewriteFileReferencesForTargetCwd` for the per-reference rules.
 *
 * Resolves the target cwd via the same `fetchFileIndex` +
 * `getCwdFromFileIndex` path `ChatInput` uses (no dedicated "get cwd" IPC
 * exists). No-ops (no `fetchFileIndex` call at all) when the draft has no
 * pills, so this is a pure pass-through for every send without mentions.
 *
 * Multi-repo drafts get a repoId-keyed pass first: the Home baseline index
 * for a multi-repo workspace is multi-root (workspace-root shadow + one
 * shadow per child repo, mirroring the real worktree index's repo ids), and
 * multi-root pills carry `repoName`, which the suffix-based
 * `rewriteFileReferencesForTargetCwd` deliberately passes through. Mapping
 * each pill's containing source root onto the target index root with the
 * same `repoId` re-roots those pills exactly; anything left over falls to
 * the suffix rewrite against the (possibly repo-scoped) target cwd.
 *
 * The final `rewriteFileReferencesForCwd` pass is what `ChatInput.handleSend`
 * runs before every worktree-chat send: it reformats each pill's
 * `displayPath` relative to the target cwd and patches the same occurrence
 * in the prompt text, so a child-repo mention sent from the workspace-root
 * working directory reaches the agent as `repos/<repo>/…` (resolvable from
 * its cwd) instead of the picker's `<repoName>/…` display text, and a
 * child-repo-scoped send gets plain repo-relative paths.
 */
async function rewriteDraftPromptForWorktree(
  prompt: string,
  fileReferences: readonly FileReference[],
  workspaceId: string,
  worktreeId: string,
  selectedRepoId: string | undefined,
): Promise<RewrittenDraftPrompt> {
  if (fileReferences.length === 0) {
    return { prompt, fileReferences: [...fileReferences] };
  }

  const cacheKey = getWorktreeCacheKey(workspaceId, worktreeId);
  return withRetainedFileIndex(
    cacheKey,
    async (): Promise<RewrittenDraftPrompt> => {
      await useFileListStore.getState().fetchFileIndex(workspaceId, worktreeId);
      const targetRepos =
        useFileListStore.getState().indexCache[cacheKey]?.data.repos ?? [];
      const sourceRepos = useHomeComposerStore.getState().fileIndex ?? [];
      const repoMapped = rewriteFileReferencesAcrossRepoRoots(
        [...fileReferences],
        sourceRepos,
        targetRepos,
      );
      const targetCwd = getCwdFromFileIndex(targetRepos, selectedRepoId);
      if (!targetCwd) {
        return { prompt, fileReferences: repoMapped };
      }

      const targeted = rewriteFileReferencesForTargetCwd(repoMapped, targetCwd);
      const rewritten = rewriteFileReferencesForCwd(
        prompt,
        targeted,
        targetCwd,
      );
      return {
        prompt: rewritten.text,
        fileReferences: rewritten.fileReferences,
      };
    },
  );
}

/**
 * Same stale-pill rewrite for the cowork routes: pills survive a WORKSPACE
 * switch too (`selectWorkspace` clears attachments but not editor content),
 * so a pill picked under a code workspace's shadow/worktree can reach a
 * cowork send. Resolves the cowork root via the existing
 * `homeGetCoworkRoot` IPC; on failure the references pass through
 * unchanged (display text is still correct either way). Mirrors the worktree
 * helper's final `rewriteFileReferencesForCwd` pass so the dispatched prompt
 * text carries cowork-root-relative paths, exactly like a send typed into a
 * cowork chat's own composer.
 */
async function rewriteDraftPromptForCowork(
  prompt: string,
  fileReferences: FileReference[] | undefined,
  workspaceId: string,
): Promise<{ prompt: string; fileReferences: FileReference[] | undefined }> {
  if (!fileReferences) {
    return { prompt, fileReferences: undefined };
  }
  let coworkRoot: string;
  try {
    coworkRoot = await window.api.homeGetCoworkRoot({ workspaceId });
  } catch {
    return { prompt, fileReferences };
  }
  const targeted = rewriteFileReferencesForTargetCwd(
    fileReferences,
    coworkRoot,
  );
  const rewritten = rewriteFileReferencesForCwd(prompt, targeted, coworkRoot);
  return { prompt: rewritten.text, fileReferences: rewritten.fileReferences };
}

/**
 * True when `absolutePath` already lives inside `worktreeId`'s own
 * attachment directory (`.../attachments/{worktreeId}/...`, see
 * `getWorktreeAttachmentsDir`). Matches on a full path segment rather than a
 * substring so a worktree id that happens to be a substring of another
 * segment can't produce a false positive.
 */
function isAttachmentStagedForWorktree(
  absolutePath: string,
  worktreeId: string,
): boolean {
  return absolutePath.split(/[\\/]/).includes(worktreeId);
}

/**
 * Re-imports staged Home-draft attachments into a real worktree's attachment
 * directory via the same `worktree:import-attachments` IPC the attach button
 * uses, then re-attaches each result's `promptKind` from the corresponding
 * source attachment (by request-order index — the main handler processes
 * `filePaths` with `Promise.all` and returns file-derived metas ahead of any
 * clipboard-derived ones in that same order, so index `i` of the response
 * always corresponds to index `i` of `filePaths`). The import IPC only
 * returns `filename`/`absolutePath`/`sizeBytes`, so without this the restaged
 * metas would silently lose `promptKind` and any associated
 * `<system_instruction>` prompt context (e.g. a staged Linear ticket
 * snapshot).
 */
async function reimportDraftAttachmentsPreservingPromptKind(
  target: AttachmentImportTarget,
  attachments: readonly AttachmentMeta[],
): Promise<AttachmentMeta[]> {
  const restaged = await importChatAttachments(
    target,
    attachments.map((attachment) => attachment.absolutePath),
  );
  return restaged.map((meta, index) => {
    const promptKind = attachments[index]?.promptKind;
    return promptKind ? { ...meta, promptKind } : meta;
  });
}

function findWorkspace(workspaceId: string): SidebarItem | undefined {
  return useProjectsStore
    .getState()
    .projects.find((candidate) => candidate.id === workspaceId);
}

/**
 * CAN-6019: Home's early refusal of an external Cowork project whose folder
 * is missing, before any work, schedule, or navigation. Main checks again on
 * send. An unprovisioned project has no folder to check. A check that fails
 * defers to that send, whose guards refuse a missing folder or report the
 * failure before creating work; a controlled host on an older release
 * refuses the check channel and must still accept sends.
 */
async function readMissingCoworkFolder(
  workspaceId: string,
): Promise<{ folderName: string; message: string } | null> {
  if (
    !findWorkspace(workspaceId) ||
    typeof window.api.chatProject.checkFolder !== 'function'
  )
    return null;
  let status: CoworkFolderStatus;
  try {
    status = await window.api.chatProject.checkFolder({
      projectId: workspaceId,
    });
  } catch (error) {
    reportClientAppError(error);
    return null;
  }
  return status.kind === 'external' && status.status === 'missing'
    ? status
    : null;
}

/**
 * Maps a Home draft's `branchTarget` (plus the selected workspace and the
 * loaded branch list) to the `task_ready` pipeline launcher's target shape
 * (Task C4; extended for PR / Linear-issue targets in Task 11). Cowork
 * workspaces always launch against the cowork root regardless of
 * `branchTarget` (cowork has no worktree/branch concept and the branch picker
 * is never rendered for it).
 *
 * The `branch`/`pr`/`linear-issue` cases reuse `createOptionsForBranchTarget`
 * so the branch resolution stays identical to the chat send paths:
 * - `pr` always resolves to `existingBranch` (its head branch) → a `branch`
 *   launch on that head branch.
 * - `linear-issue` resolves to `existingBranch` when its branch already exists
 *   → a `branch` launch; otherwise it resolves to `{ branchName }`
 *   (create-new). The `task_ready` launcher has no create-new-named-branch
 *   shape, so that case falls through to an auto-named new worktree.
 *   // v2 limitation: the Linear-suggested branch name is not preserved for
 *   pipeline launches when its branch does not exist yet.
 */
export function resolveTaskReadyLaunchTarget(
  workspace: SidebarItem | undefined,
  branchTarget: HomeBranchTarget,
  branches: readonly BranchEntry[],
  newWorktreeBaseTarget?: HomeNewWorktreeBaseTarget | null,
): TaskReadyPipelineLaunchTarget {
  if (workspace?.type === 'cowork') {
    return { kind: 'cowork' };
  }
  if (branchTarget.kind === 'worktree') {
    return { kind: 'worktree', worktreeId: branchTarget.worktreeId };
  }
  if (
    workspace?.type === 'single-repo' &&
    branchTarget.kind === 'new-worktree'
  ) {
    return {
      kind: 'new-worktree',
      ...createOptionsForNewWorktreeBaseTarget(newWorktreeBaseTarget ?? null),
    };
  }
  const createOptions = createOptionsForBranchTarget(branchTarget, branches);
  if (createOptions?.existingBranch) {
    return { kind: 'branch', branchName: createOptions.existingBranch };
  }
  return { kind: 'new-worktree' };
}

/** Cheap main-process status read; a failure fails closed like the picker. */
async function isCursorRuntimeAvailable(): Promise<boolean> {
  if (
    !useFeatureFlagsStore
      .getState()
      .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key)
  )
    return false;
  try {
    const status = await window.api.cursorConnection?.status();
    return Boolean(status?.supported && status.enabled && status.installed);
  } catch {
    return false;
  }
}

/**
 * Mentioning a plugin means "use it": any `@plugin` pill whose plugin the
 * user removed from the draft's selections is enabled again for the send.
 */
function withMentionedPlugins(
  selections: ChatTabPluginSelections | null,
  fileReferences: readonly FileReference[],
): ChatTabPluginSelections | null {
  const missing = missingMentionedPluginRefs(
    fileReferences,
    selections?.pluginRefs ?? [],
  );
  if (missing.length === 0) return selections;
  return mergeChatPluginSelections(selections ?? createEmptySelections(), {
    ...createEmptySelections(),
    pluginRefs: missing,
  });
}

/**
 * Dispatches a chat-mode Home send: reads the current draft off
 * `homeComposerStore` and routes it to the same underlying flows the
 * Create-Task modal uses (`createWorktree` + `sendMessage`,
 * `createStandaloneChatWithMessage`), depending on the draft's workspace type
 * and `branchTarget`.
 *
 * This function only handles chat-mode sends. Pipeline-mode sends are
 * dispatched separately by `HomeSurface` via `useTaskReadyPipelineLauncher`,
 * since opening the pipeline picker modal is inherently a React state
 * concern this module-level orchestrator has no access to.
 *
 * Guards (no-ops): no selected workspace, already sending, or
 * an attachment import still pending for the current draft.
 * A blank prompt creates a work area with an unsent attachment/settings draft.
 * On success the composer draft is reset (`useHomeComposerStore.getState().reset()`)
 * when the whole draft is still the submitted one; otherwise, when the store
 * still holds the submitted text/references, only that content is purged
 * (`clearSubmittedDraft()`) and the newer workspace, attachments, schedule, or
 * mode are kept. A different draft typed during the send is never cleared.
 * On failure `sendError` is set, `isSending` is cleared, and the rest of the
 * draft (text, attachments, config) is preserved so the user can retry.
 *
 * Returns `true` when the send succeeded, whether the draft was reset, its
 * submitted content purged, or a newer draft kept, and
 * `false` for any guard no-op or failure. `HomeSurface.handleSend` uses the
 * return value to clear its local Slate editor and re-seed the workspace
 * selection on success — the module-level store reset alone cannot touch the
 * editor's local content, and on the non-navigating scheduled-provision path
 * the surface stays mounted, so without this the stale prompt would remain
 * visible and the workspace picker would go (and stay) empty.
 *
 * Staged attachments are not deleted from the `HOME_DRAFT_WORKTREE_ID`
 * staging dir after a successful new-worktree/branch send (there is no
 * existing IPC for deleting an arbitrary attachment directory, and adding
 * one is out of scope here — see the Task B5 report). The re-imported copies
 * under the real worktree's attachment dir are small, so the orphaned
 * home-draft originals are left in place rather than added as new cleanup
 * surface area.
 */
/**
 * CAN-6016: stops a send whose new worktree would start from a source branch
 * verified to have no commits, before any chat, draft or worktree effect. A
 * cached positive is re-read first, so a commit made outside the app never
 * traps the draft; a missing, unsupported or failed read never blocks, and
 * the backend still classifies a failure that races this check. Scheduled
 * sends with an initial message provision at fire time and are checked then.
 */
async function preflightSourceHead(
  draft: ReturnType<typeof useHomeComposerStore.getState>,
  submittedAccountEpoch: number,
  submissionId: string,
): Promise<'send' | 'stop'> {
  const workspaceId = draft.workspaceId;
  const hasInitialMessage =
    draft.text.trim().length > 0 || draft.attachments.length > 0;
  if (!workspaceId || (draft.scheduledSendDraft && hasInitialMessage))
    return 'send';
  const usesSourceHead = (
    state: ReturnType<typeof useHomeComposerStore.getState>,
  ): boolean =>
    state.workspaceId === workspaceId &&
    state.branchTargetsStatus !== 'loading' &&
    state.branchTargets?.headUnborn === true &&
    homeSendUsesSourceHead({
      projectType: findWorkspace(workspaceId)?.type,
      branchTarget: state.branchTarget,
      newWorktreeBaseTarget: state.newWorktreeBaseTarget,
      branches: state.branchTargets.branches,
      defaultBranch: state.branchTargets.defaultBranch,
    });
  if (!usesSourceHead(draft)) return 'send';
  // Lock before awaiting so a repeated Enter cannot start a second send.
  useHomeComposerStore.setState({ isSending: true });
  try {
    await useHomeComposerStore.getState().loadBranchTargets();
  } finally {
    if (
      isHomeSendAccountCurrent(submittedAccountEpoch) &&
      activeHomeSubmissionId === submissionId
    )
      useHomeComposerStore.setState({ isSending: false });
  }
  const current = useHomeComposerStore.getState();
  if (
    !isHomeSendAccountCurrent(submittedAccountEpoch) ||
    activeHomeSubmissionId !== submissionId ||
    !isSubmittedHomeDraftCurrent(draft) ||
    current.workspaceSelectionGeneration !==
      draft.workspaceSelectionGeneration ||
    current.draftGeneration !== draft.draftGeneration ||
    current.branchTarget !== draft.branchTarget ||
    current.pendingAttachmentImportIds.length > 0
  )
    return 'stop';
  if (!usesSourceHead(useHomeComposerStore.getState())) return 'send';
  useHomeComposerStore.setState({
    sendError: sourceNoCommitsSendFailure(findWorkspace(workspaceId)?.name),
    sendErrorRetryable: false,
    sendErrorChooseModel: null,
  });
  return 'stop';
}

export async function dispatchHomeSend(): Promise<boolean> {
  const submittedAccountEpoch =
    useWorkspaceContextStore.getState().accountEpoch;
  // A resend after connecting GitHub gets no second offer (CAN-4466). Taken
  // before any await, so a stop here still uses the request up.
  const resumedAfterGitHubConnect = useHomeComposerStore
    .getState()
    .consumeGitHubConnectResume();
  let draft = useHomeComposerStore.getState();
  const { isSending, pendingAttachmentImportIds } = draft;

  if (
    isSending ||
    pendingAttachmentImportIds.length > 0 ||
    !draft.workspaceId
  ) {
    return false;
  }
  const submissionIdentity = {
    userMessageId: nextMsgId(),
    submittedAt: Date.now(),
  };

  activeHomeSubmissionId = submissionIdentity.userMessageId;

  // CAN-3606: link-aware routing runs before any Cowork decision. A pending,
  // blocked, or failed link destination stops here with the draft intact; it
  // never falls back to an ordinary chat.
  const quickGate = draft.mode === 'chat' ? gateHomeLinkSend() : null;
  let gate: HomeLinkSendGate;
  if (quickGate === null) {
    gate = { kind: 'none' };
  } else if (quickGate.kind === 'settle') {
    // Lock before awaiting so a second send cannot slip past the guard.
    const scope = homeLinkScopeKey();
    useHomeComposerStore.setState({ isSending: true });
    gate = await quickGate.settle();
    if (!isHomeSendAccountCurrent(submittedAccountEpoch)) return false;
    useHomeComposerStore.setState({ isSending: false });
    if (!isSubmittedHomeDraftCurrent(draft) || homeLinkScopeKey() !== scope)
      return false;
    draft = useHomeComposerStore.getState();
    if (draft.pendingAttachmentImportIds.length > 0) return false;
  } else {
    gate = quickGate;
  }
  if (gate.kind === 'none') {
    if (
      draft.branchTarget.kind === 'new-worktree' &&
      homeWorktreeBaseMissing(
        draft.newWorktreeBaseTarget,
        draft.branchTargets,
        draft.branchTargetsStatus,
      )
    ) {
      draft.setSendError(MISSING_HOME_WORKTREE_BASE_MESSAGE);
      return false;
    }
    const verdict = await preflightSourceHead(
      draft,
      submittedAccountEpoch,
      submissionIdentity.userMessageId,
    );
    if (verdict === 'stop') return false;
    draft = useHomeComposerStore.getState();
    const modelSettings = await prepareHomeModelSubmission(
      draft,
      draft.workspaceId,
      submittedAccountEpoch,
      submissionIdentity.userMessageId,
    );
    if (!modelSettings) return false;
    return dispatchHomeSendTo(draft, null, submittedAccountEpoch, {
      ...submissionIdentity,
      modelSettings,
    });
  }
  if (gate.kind === 'stop') {
    useHomeComposerStore.setState({
      sendErrorMissingFolder: null,
      sendError: { error: gate.message },
      sendErrorRetryable: false,
    });
    return false;
  }

  const { plan } = gate;
  if (draft.scheduledSendDraft && plan.kind === 'create-project') {
    useHomeComposerStore.setState({
      sendErrorMissingFolder: null,
      sendError: {
        error:
          'Scheduling isn’t available while this link’s project doesn’t exist yet. Send now, or remove the schedule.',
      },
      sendErrorRetryable: false,
    });
    return false;
  }
  const crossesProjects =
    plan.kind === 'create-project' || plan.workspaceId !== draft.workspaceId;
  if (
    crossesProjects &&
    draft.fileReferences.some(
      (reference) =>
        reference.kind === undefined ||
        reference.kind === 'file' ||
        reference.kind === 'folder',
    )
  ) {
    useHomeComposerStore.setState({
      sendErrorMissingFolder: null,
      sendError: {
        error:
          'File mentions can’t move to another project. Remove them, or dismiss the link.',
      },
      sendErrorRetryable: false,
    });
    return false;
  }

  const restorePreview = (): void => {
    if (!isSubmittedHomeDraftCurrent(draft)) return;
    const { linkTarget } = useHomeComposerStore.getState();
    if (linkTarget.status === 'submitting' && linkTarget.key === gate.key) {
      useHomeComposerStore.getState().setLinkTarget({
        status: 'ready',
        key: gate.key,
        fingerprint: gate.fingerprint,
        plan,
      });
    }
  };
  const showProgress = (progress: string): void => {
    if (!isSubmittedHomeDraftCurrent(draft)) return;
    useHomeComposerStore.getState().setLinkTarget({
      status: 'submitting',
      key: gate.key,
      fingerprint: gate.fingerprint,
      plan,
      progress,
      canCancel: true,
    });
  };

  showProgress('Preparing worktree…');
  const modelSettings = await prepareHomeModelSubmission(
    draft,
    plan.kind === 'create-project' ? draft.workspaceId : plan.workspaceId,
    submittedAccountEpoch,
    submissionIdentity.userMessageId,
  );
  if (!modelSettings) {
    restorePreview();
    return false;
  }
  useHomeComposerStore.setState({
    isSending: true,
    sendError: null,
    sendErrorRetryable: false,
    sendErrorChooseModel: null,
    sendErrorMissingFolder: null,
  });
  showProgress('Preparing worktree…');
  const controller = new AbortController();
  linkSubmissionController = controller;
  const scopeKey = homeLinkScopeKey();
  const unsubscribe = useHomeComposerStore.subscribe((): void => {
    if (!isSubmittedHomeDraftCurrent(draft)) controller.abort();
  });
  let destination: HomeLinkMaterializeResult;
  try {
    destination = await materializeHomeLinkPlan(
      plan,
      createHomeLinkMaterializeDeps(showProgress, controller.signal),
    );
  } catch (error: unknown) {
    destination = {
      ok: false,
      message: extractIpcErrorMessage(error),
      retryable: true,
    };
  }
  const cleanup = (): void => {
    unsubscribe();
    if (linkSubmissionController === controller)
      linkSubmissionController = null;
    const current = useHomeComposerStore.getState();
    if (
      isHomeSendAccountCurrent(submittedAccountEpoch) &&
      !isSubmittedHomeDraftCurrent(draft) &&
      current.linkTarget.status === 'submitting' &&
      current.linkTarget.key === gate.key &&
      current.linkTarget.fingerprint === gate.fingerprint
    ) {
      current.setLinkTarget({ status: 'idle' });
      syncHomeLinkTarget();
    }
  };
  if (!isHomeSendAccountCurrent(submittedAccountEpoch)) {
    cleanup();
    return false;
  }
  if (
    scopeKey !== homeLinkScopeKey() ||
    !isSubmittedHomeDraftCurrent(draft) ||
    controller.signal.aborted
  ) {
    if (isSubmittedHomeDraftCurrent(draft)) {
      restorePreview();
      useHomeComposerStore.setState({
        sendErrorMissingFolder: null,
        sendError: null,
      });
    }
    useHomeComposerStore.setState({ isSending: false });
    cleanup();
    return false;
  }
  if (!destination.ok) {
    cleanup();
    restorePreview();
    if (
      destination.githubAuthFailure &&
      !resumedAfterGitHubConnect &&
      useGitHubConnectOfferStore.getState().requestOffer({
        kind: 'home-link-add-project',
        operationId: crypto.randomUUID(),
        resume: 'send',
        linkKey: gate.key,
        draftText: draft.text,
        failureMessage: destination.message,
      }) === 'offered'
    ) {
      // The offer resends after connecting, or restores this failure.
      useHomeComposerStore.setState({ isSending: false });
      return false;
    }
    useHomeComposerStore.setState({
      isSending: false,
      sendErrorMissingFolder: null,
      sendError: { error: destination.message },
      sendErrorRetryable: destination.retryable,
    });
    return false;
  }
  showProgress('Creating worktree…');
  try {
    const sent = await dispatchHomeSendTo(
      draft,
      {
        ...destination,
        signal: controller.signal,
        linearIssue: plan.linearIssue,
      },
      submittedAccountEpoch,
      { ...submissionIdentity, modelSettings },
    );
    if (!sent) restorePreview();
    return sent;
  } finally {
    cleanup();
  }
}

interface HomeSendChatTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

interface FirstSendModelSelection {
  model: ChatModel;
  executionHarness?: ModelHarness;
  aiCreditsRouted?: boolean;
}

/** A Home first send whose model was refused after its chat opened. */
interface FailedFirstSendRetry {
  userMessageId: string;
  failureId: string;
  attempted: FirstSendModelSelection;
  /** The chat's model when it failed; a change since is an accepted pick. */
  tabModelAtFailure: ChatModel | undefined;
  tabHarnessAtFailure: ModelHarness | undefined;
  /** Resumes the submission's preparation in place under a new attempt. */
  resume: (
    attemptId: string,
    selection: FirstSendModelSelection,
  ) => Promise<boolean>;
}

// Session-local, like the provisional echo it recovers; never persisted.
const failedFirstSends = new Map<string, FailedFirstSendRetry>();

function chatTargetKey(target: HomeSendChatTarget): string {
  return `${target.projectId}/${target.worktreeId}/${target.chatId}`;
}

function findChatTab(target: HomeSendChatTarget): ChatTab | undefined {
  return useChatStore
    .getState()
    .worktreeChats[
      `${target.projectId}/${target.worktreeId}`
    ]?.tabs.find((tab) => tab.id === target.chatId);
}

function isChatTargetInView(target: HomeSendChatTarget): boolean {
  if (useNavigationStore.getState().activePage !== 'main') return false;
  const { selectedWorktree, worktreeChats } = useChatStore.getState();
  return (
    selectedWorktree?.projectId === target.projectId &&
    selectedWorktree.worktreeId === target.worktreeId &&
    worktreeChats[`${target.projectId}/${target.worktreeId}`]?.activeTabId ===
      target.chatId
  );
}

/**
 * CAN-5021: sends a Home first send whose model was refused again, exactly
 * once, to the chat that shows it. It keeps the message id, timestamp,
 * attachments and mentions, and uses the model accepted in that chat's picker
 * since the failure, or else the attempted one. It never creates another chat
 * or worktree. Returns whether the send was handed to dispatch.
 */
export async function retryFailedFirstSend(
  target: HomeSendChatTarget,
): Promise<boolean> {
  const key = chatTargetKey(target);
  const retry = failedFirstSends.get(key);
  const tab = findChatTab(target);
  const record = tab?.provisionalFirstSend;
  if (
    !retry ||
    !tab ||
    useChatStore.getState().pendingModelChanges[key] !== undefined ||
    record?.phase !== 'failed' ||
    record.userMessageId !== retry.userMessageId ||
    record.failure?.failureId !== retry.failureId
  )
    return false;
  // Opening or cancelling the picker leaves the attempted model in place.
  const selection: FirstSendModelSelection =
    record.failure.recoveryModelSelectionAccepted ||
    tab.model !== retry.tabModelAtFailure ||
    tab.executionHarness !== retry.tabHarnessAtFailure
      ? {
          model: tab.model ?? retry.attempted.model,
          ...(tab.executionHarness
            ? { executionHarness: tab.executionHarness }
            : {}),
        }
      : retry.attempted;
  selection.aiCreditsRouted = isTabAiCreditsRouted(tab);
  const attemptId = nextMsgId();
  if (
    !useChatStore.getState().retryProvisionalFirstSend(target, {
      userMessageId: retry.userMessageId,
      failureId: retry.failureId,
      attemptId,
    })
  )
    return false;
  failedFirstSends.delete(key);
  return retry.resume(attemptId, selection);
}

/** True when the submitted draft, its model, and its destination are unchanged. */
function isSubmittedHomeSelectionCurrent(
  draft: ReturnType<typeof useHomeComposerStore.getState>,
): boolean {
  const current = useHomeComposerStore.getState();
  return (
    isSubmittedHomeDraftCurrent(draft) &&
    current.model === draft.model &&
    current.executionHarness === draft.executionHarness &&
    current.branchTarget === draft.branchTarget &&
    current.newWorktreeBaseTarget === draft.newWorktreeBaseTarget
  );
}

/** A link-materialized destination that overrides the draft's selection. */
interface HomeSendDestination {
  workspaceId: string;
  branchTarget: HomeBranchTarget;
  branches: readonly BranchEntry[];
  signal?: AbortSignal;
  linearIssue?: HomeLinkIssueContext;
}

async function prepareHomeModelSubmission(
  draft: ReturnType<typeof useHomeComposerStore.getState>,
  workspaceId: string | null,
  submittedAccountEpoch: number,
  submissionId: string,
): Promise<ReturnType<typeof resolveHomeEffectiveModelSettings> | null> {
  const settings = resolveHomeEffectiveModelSettings(
    draft.workspaceId,
    draft.model,
    draft.thinkingLevel,
    draft.executionHarness,
  );
  const { model } = settings;
  const revision = draft.draftGeneration;
  const scopeKey = homeLinkScopeKey();
  useHomeComposerStore.setState({
    isSending: true,
    sendError: null,
    sendErrorRetryable: false,
    sendErrorChooseModel: null,
    sendErrorMissingFolder: null,
  });
  const cursorRuntimeAvailable =
    !isCursorModel(model) || (await isCursorRuntimeAvailable());
  if (
    !isHomeSendAccountCurrent(submittedAccountEpoch) ||
    activeHomeSubmissionId !== submissionId
  )
    return null;
  if (!cursorRuntimeAvailable) {
    // A stale Cursor selection must fail before any worktree, chat, or prompt
    // state exists; the draft stays intact for a retry or a model change.
    useHomeComposerStore.setState({
      isSending: false,
      sendErrorMissingFolder: null,
      sendError: {
        error: useFeatureFlagsStore
          .getState()
          .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key)
          ? 'Connect Cursor in Settings to send with Cursor, or choose another model.'
          : 'This Cursor model is unavailable. Choose another Cursor model and try again.',
      },
    });
    return null;
  }
  if (draft.scheduledSendDraft && isCursorModel(model)) {
    useHomeComposerStore.setState({
      isSending: false,
      sendErrorMissingFolder: null,
      sendError: {
        error:
          'Cursor currently supports interactive chats only. Choose another model to schedule this message.',
      },
    });
    return null;
  }
  const submittedModelSelection: FirstSendModelSelection = {
    model,
    ...(draft.executionHarness
      ? { executionHarness: draft.executionHarness }
      : {}),
  };
  // CAN-5021: a model already known to be refused stops here, before any
  // worktree, chat, or echo exists, with the whole draft intact. Unknown
  // facts pass; main still decides.
  const preflight = await preflightHomeModel(
    workspaceId,
    submittedModelSelection,
  );
  if (
    !isHomeSendAccountCurrent(submittedAccountEpoch) ||
    activeHomeSubmissionId !== submissionId
  )
    return null;
  if (
    !isSubmittedHomeSelectionCurrent(draft) ||
    homeLinkScopeKey() !== scopeKey ||
    useHomeComposerStore.getState().draftGeneration !== revision ||
    resolveHomeEffectiveModelSettings(
      draft.workspaceId,
      draft.model,
      draft.thinkingLevel,
      draft.executionHarness,
    ).model !== model
  ) {
    useHomeComposerStore.setState({ isSending: false });
    return null;
  }
  if (!preflight.ok) {
    const message = homeModelFailureMessage(
      preflight.reason,
      preflight.modelLabel,
    );
    useHomeComposerStore.setState({
      isSending: false,
      sendErrorMissingFolder: null,
      sendError: { error: message },
      sendErrorRetryable: false,
      sendErrorChooseModel: {
        failureId: crypto.randomUUID(),
        message,
        focus: true,
      },
    });
    return null;
  }
  return settings;
}

async function dispatchHomeSendTo(
  draft: ReturnType<typeof useHomeComposerStore.getState>,
  destination: HomeSendDestination | null,
  submittedAccountEpoch: number,
  submissionIdentity: {
    userMessageId: string;
    submittedAt: number;
    modelSettings: ReturnType<typeof resolveHomeEffectiveModelSettings>;
  },
): Promise<boolean> {
  let clearedSubmittedDraft: ReturnType<
    typeof useHomeComposerStore.getState
  > | null = null;
  function ownsHomeSubmission(): boolean {
    return activeHomeSubmissionId === submissionIdentity.userMessageId;
  }
  function completeSubmittedDraft(): void {
    if (
      !isHomeSendAccountCurrent(submittedAccountEpoch) ||
      !ownsHomeSubmission()
    )
      return;
    const store = useHomeComposerStore.getState();
    if (isSubmittedHomeDraftCurrent(draft)) {
      store.reset();
      clearedSubmittedDraft = useHomeComposerStore.getState();
      return;
    }
    // A retry from the failed chat never owns Home's sending state.
    if (!resumedByRetry && ownsHomeSubmission())
      useHomeComposerStore.setState({ isSending: false });
    const submittedContentNonEmpty =
      draft.text !== '' || draft.fileReferences.length > 0;
    if (
      submittedContentNonEmpty &&
      composerDraftContentEquals(useHomeComposerStore.getState(), draft)
    ) {
      store.clearSubmittedDraft();
      clearedSubmittedDraft = useHomeComposerStore.getState();
    }
  }
  const workspaceId = destination?.workspaceId ?? draft.workspaceId;
  if (!workspaceId) return false;
  // A narrowed id for the failure handlers declared below.
  const sendProjectId: string = workspaceId;
  // Selections made for the draft's own project never carry to another one.
  const sameProject = destination === null || workspaceId === draft.workspaceId;
  const draftBranches =
    destination?.branches ?? draft.branchTargets?.branches ?? [];
  const draftNewWorktreeBaseTarget =
    destination === null ? draft.newWorktreeBaseTarget : null;

  const hasInitialMessage =
    draft.text.trim().length > 0 || draft.attachments.length > 0;
  // A blank submission creates a work area immediately. Its schedule is
  // carried into the new composer as a draft, without creating an automation.
  const scheduledSendDraft = hasInitialMessage
    ? draft.scheduledSendDraft
    : null;
  // CAN-4742: an immediate send is echoed in its destination chat before
  // navigation, under this identity; `sendMessage` adopts it at dispatch.
  const firstSend =
    hasInitialMessage && !scheduledSendDraft
      ? {
          ...submissionIdentity,
          text: draft.text,
          fileReferences: draft.fileReferences,
          attachmentPaths: draft.attachments.map(
            (attachment) => attachment.absolutePath,
          ),
        }
      : null;

  useHomeComposerStore.setState({
    isSending: true,
    sendError: null,
    sendErrorRetryable: false,
    sendErrorChooseModel: null,
    sendErrorMissingFolder: null,
  });

  if (isCoworkChatTarget(workspaceId)) {
    // Prompt expansion can read project files and initialize metadata. Check
    // before those reads as well as before the scheduling/creation branches.
    const missingFolder = await readMissingCoworkFolder(workspaceId);
    if (!isHomeSendAccountCurrent(submittedAccountEpoch)) return false;
    if (!ownsHomeSubmission() || !isSubmittedHomeDraftCurrent(draft)) {
      if (ownsHomeSubmission())
        useHomeComposerStore.setState({ isSending: false });
      return false;
    }
    if (missingFolder) {
      useHomeComposerStore.setState({
        isSending: false,
        ...missingFolderSendError({ projectId: workspaceId, ...missingFolder }),
      });
      return false;
    }
  }

  // Prompt @-mentions expand into the outgoing text BEFORE any target
  // rewrites (worktree repo mapping / cowork root-relative rewriting), so
  // path rewriting only ever sees real file pills. Note/attachment mentions
  // pass through untouched.
  let expandedDraft;
  try {
    expandedDraft = await expandPromptMentions(
      draft.workspaceId ?? workspaceId,
      draft.text,
      draft.fileReferences,
    );
  } catch {
    if (!isHomeSendAccountCurrent(submittedAccountEpoch)) return false;
    useHomeComposerStore.setState({
      isSending: false,
      sendErrorMissingFolder: null,
      sendError: { error: 'Could not load the referenced prompt.' },
    });
    return false;
  }
  if (!isHomeSendAccountCurrent(submittedAccountEpoch)) return false;
  const prompt = homeLinkPromptWithIssueContext(
    expandedDraft.text,
    destination?.linearIssue,
  );
  // The transcript list is code-split. Start loading it now so the opened
  // chat can paint the question in its first frame, not a loading spinner.
  const transcriptChunkReady = firstSend
    ? loadChatMessageListModule().then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
    : null;
  // The chat currently presenting `firstSend`, until dispatch adopts it.
  let firstSendRejected = false;
  let starterWasProvisional = false;
  const firstSendPresentation: { target: HomeSendChatTarget | null } = {
    target: null,
  };
  // CAN-5021: the current preparation attempt of `firstSend`, and whether a
  // retry from its failed chat (not this Home submission) is driving it.
  let firstSendAttemptId = submissionIdentity.userMessageId;
  let resumedByRetry = false;
  // The chat attempt preparing `firstSend` now, so a failure Home can no
  // longer show stays failed in that chat, with its Try again.
  let chatAttempt: {
    target: HomeSendChatTarget;
    selection: FirstSendModelSelection;
    continueFromModel: (selection: FirstSendModelSelection) => Promise<boolean>;
  } | null = null;
  // A send to a worktree that is still setting up is held by main and
  // starts once the setup finishes, so it is presented as a starting turn.
  const presentFirstSend = (target: HomeSendChatTarget): void => {
    if (!firstSend) return;
    if (
      !useChatStore.getState().presentProvisionalFirstSend(target, firstSend)
    ) {
      throw new Error('Failed to prepare the first message in this chat.');
    }
    starterWasProvisional =
      useChatStore
        .getState()
        .worktreeChats[
          `${target.projectId}/${target.worktreeId}`
        ]?.tabs.find((tab) => tab.id === target.chatId)
        ?.pendingInitialCreation === true;
    firstSendPresentation.target = target;
  };
  const withdrawFirstSend = (): void => {
    const { target } = firstSendPresentation;
    if (!firstSend || !target) return;
    useChatStore
      .getState()
      .withdrawProvisionalFirstSend(target, firstSend.userMessageId);
    firstSendPresentation.target = null;
  };
  // Dispatch options that adopt the presented echo, or retire it when the
  // send is refused or handed to a queue.
  const firstSendDispatchOptions = (): {
    onDispatchAccepted?: () => void;
    userMessageId?: string;
    submittedAt?: number;
    onPreDispatchRejected?: () => void;
    onDispatchRejected?: () => void;
    onQueuedWithoutDispatch?: () => void;
  } => {
    const { target } = firstSendPresentation;
    const onDispatchAccepted = (): void => {
      const workspace = useProjectsStore
        .getState()
        .projects.find((entry) => entry.id === workspaceId);
      if (!resumedByRetry && workspace && workspace.type !== 'cowork')
        notifyAcceptedWorktreeTurn();
    };
    if (!firstSend || !target) return { onDispatchAccepted };
    const { userMessageId } = firstSend;
    const rejected = (): void => {
      firstSendRejected = true;
      fail(
        'Could not send the message. Your draft is available to retry.',
        true,
      );
    };
    const dispatchRejected = (): void => {
      const tab = useChatStore
        .getState()
        .worktreeChats[
          `${target.projectId}/${target.worktreeId}`
        ]?.tabs.find((entry) => entry.id === target.chatId);
      if (
        tab?.provisionalFirstSend?.phase === 'dispatched' &&
        tab.status !== 'error'
      )
        return;
      rejected();
    };
    return {
      onDispatchAccepted,
      userMessageId,
      submittedAt: firstSend.submittedAt,
      onPreDispatchRejected: rejected,
      onDispatchRejected: dispatchRejected,
      onQueuedWithoutDispatch: (): void => {
        useChatStore
          .getState()
          .handOffProvisionalFirstSend(target, userMessageId);
      },
    };
  };

  const branchTarget = destination?.branchTarget ?? draft.branchTarget;
  const selectedRepoId = sameProject ? draft.selectedRepoId : undefined;
  const {
    planMode,
    // `undefined` means "untouched" — leave the created chat's approval mode
    // unset so the normal resolution chain applies (tabMode -> hookMode ->
    // workspaceDefault -> canopyJsonDefault -> surface default ->
    // `PRODUCT_DEFAULT_APPROVAL_MODE`).
    // Unlike model/thinkingLevel, this is NOT resolved to an effective
    // default here — doing so would force a concrete mode even when the
    // user never touched the picker, overriding defaults the created chat
    // would otherwise pick up.
    approvalMode,
    pluginSelections: draftPluginSelections,
  } = draft;
  // Mentioning a plugin means "use it": any `@plugin` pill whose plugin the
  // user removed from the draft's selections is enabled again for the send.
  // The created chat inherits the workspace defaults live, so it stores only
  // the draft's own choices plus the defaults the draft turned off.
  const chatPlugins = homeDraftChatPluginSelections(
    withMentionedPlugins(draftPluginSelections, expandedDraft.fileReferences),
    workspaceId,
  );
  // Task F1: sends always pin the EFFECTIVE (concrete) model/thinking level —
  // what the composer actually displayed — rather than an untouched
  // `undefined` draft value, so a send/schedule captures exactly what the
  // user saw at that moment (workspace-kind switches no longer silently
  // change what an already-scheduled send resolves to at fire time).
  const { model, thinkingLevel } = submissionIdentity.modelSettings;
  const submittedModelSelection: FirstSendModelSelection = {
    model,
    ...(draft.executionHarness
      ? { executionHarness: draft.executionHarness }
      : {}),
  };
  // …but pinning the EFFECTIVE model is not the same as the user CHOOSING it.
  // Only a draft that actually carries a model came from the Home model picker;
  // everything else is the resolved default, which must stay ours to re-stamp.
  const modelExplicitlyChosen = draft.model !== undefined;
  // The exact Codex speed the composer displayed (staged choice, else the
  // provider default); `undefined` for providers without a Codex speed. It is
  // applied to the created chat through the canonical speed command.
  const speed = resolveHomeSpeed(
    model,
    { speed: draft.speed, fastMode: draft.fastMode },
    draft.executionHarness,
  );
  const attachmentPaths = attachmentPathsFromMeta(draft.attachments);
  const attachmentPromptContexts = attachmentPromptContextsFromMeta(
    draft.attachments,
  );
  const fileReferences = outboundFileReferences(expandedDraft.fileReferences);

  if (
    scheduledSendDraft &&
    draft.attachments.length > 0 &&
    !isCoworkChatTarget(workspaceId) &&
    (branchTarget.kind === 'new-worktree' ||
      branchTarget.kind === 'branch' ||
      branchTarget.kind === 'pr' ||
      branchTarget.kind === 'linear-issue')
  ) {
    useHomeComposerStore.setState({
      isSending: false,
      sendErrorMissingFolder: null,
      sendError: {
        error:
          'Scheduled sends to this destination cannot include attachments. Remove the attachments or send now.',
      },
    });
    return false;
  }

  /** Shows the failure on its Home draft; false when there is none to show it on. */
  function fail(
    failure: string | InlineFailure,
    retryable = false,
    modelFailure?: {
      failureId: string;
      /** The chat that keeps the failed prompt and offers recovery. */
      inlineTarget: HomeSendChatTarget | null;
      /** Home offers Choose model too; only for a model refusal. */
      chooseModel?: boolean;
    },
    /** CAN-6019: Home offers Locate folder and Choose another project. */
    missingFolder?: { folderName: string; message: string },
  ): boolean {
    const missingFolderError = missingFolder
      ? missingFolderSendError({ projectId: sendProjectId, ...missingFolder })
      : null;
    const normalized =
      missingFolderError?.sendError ??
      (typeof failure === 'string' ? { error: failure } : failure);
    const message =
      inlineFailureText(normalized) ?? "Couldn't send this message.";
    const inlineTarget = modelFailure?.inlineTarget ?? null;
    const failedTarget = firstSendPresentation.target ?? inlineTarget;
    // Home holds another draft or submission now: withdrawing the prompt
    // would leave this failure nowhere. Keep it failed in its chat instead.
    if (
      !modelFailure &&
      chatAttempt &&
      firstSendPresentation.target &&
      isHomeSendAccountCurrent(submittedAccountEpoch) &&
      (!ownsHomeSubmission() || !isSubmittedHomeDraftCurrent(draft))
    ) {
      const attempt = chatAttempt;
      failInChat(
        attempt.target,
        attempt.selection,
        resumeFirstSend(attempt.target, attempt.continueFromModel),
        message,
        { failure: normalized, retryable },
      );
      return false;
    }
    withdrawFirstSend();
    if (!isHomeSendAccountCurrent(submittedAccountEpoch)) return false;
    const currentDraft = useHomeComposerStore.getState();
    if (
      ownsHomeSubmission() &&
      clearedSubmittedDraft &&
      currentDraft.draftGeneration === clearedSubmittedDraft.draftGeneration &&
      isSubmittedHomeDraftCurrent(clearedSubmittedDraft)
    ) {
      // A host-queue rejection can arrive after Home unmounted and reset.
      // Recover only the cleared submission, never a newer draft or account.
      useHomeComposerStore.setState({
        workspaceId: draft.workspaceId,
        branchTarget: draft.branchTarget,
        newWorktreeBaseTarget: draft.newWorktreeBaseTarget,
        selectedRepoId: draft.selectedRepoId,
        mode: draft.mode,
        text: draft.text,
        fileReferences: draft.fileReferences,
        attachments: draft.attachments,
        model: draft.model,
        modelSelectionMode: draft.modelSelectionMode,
        executionHarness: draft.executionHarness,
        thinkingLevel: draft.thinkingLevel,
        speed: draft.speed,
        fastMode: draft.fastMode,
        planMode: draft.planMode,
        approvalMode: draft.approvalMode,
        pluginSelections: draft.pluginSelections,
        manualPluginSelections: draft.manualPluginSelections,
        pluginSelectionsEdited: draft.pluginSelectionsEdited,
        scheduledSendDraft: draft.scheduledSendDraft,
        draftGeneration: currentDraft.draftGeneration + 1,
      });
    }
    // Keep the failure with its Home draft; returning to Home reveals it.
    if (!ownsHomeSubmission() || !isSubmittedHomeDraftCurrent(draft)) {
      if (!resumedByRetry && ownsHomeSubmission())
        useHomeComposerStore.setState({ isSending: false });
      return false;
    }
    useHomeComposerStore.setState({
      ...(resumedByRetry ? {} : { isSending: false }),
      sendError: normalized,
      sendErrorRetryable: retryable,
      // Home shows the recovery too, but focus stays where the user is.
      sendErrorChooseModel:
        modelFailure && modelFailure.chooseModel !== false
          ? { failureId: modelFailure.failureId, message, focus: false }
          : null,
      sendErrorMissingFolder:
        missingFolderError?.sendErrorMissingFolder ?? null,
    });
    // The send carried the person to its chat, and its prompt is withdrawn
    // there: bring them back to the draft, which now says why. A chat that
    // offers its own model recovery explains itself.
    if (
      failedTarget &&
      isChatTargetInView(failedTarget) &&
      !(inlineTarget && isChatTargetInView(inlineTarget))
    )
      useNavigationStore.getState().navigate('home');
    return true;
  }

  function isAttemptCurrent(target: HomeSendChatTarget): boolean {
    if (!isHomeSendAccountCurrent(submittedAccountEpoch)) return false;
    if (!firstSend) return true;
    const record = findChatTab(target)?.provisionalFirstSend;
    return (
      record?.userMessageId === firstSend.userMessageId &&
      record.phase === 'preparing' &&
      provisionalFirstSendAttemptId(record) === firstSendAttemptId
    );
  }

  async function applyFirstSendModel(
    target: HomeSendChatTarget,
    selection: FirstSendModelSelection,
  ): Promise<'accepted' | 'refused' | 'stale'> {
    if (!isAttemptCurrent(target)) return 'stale';
    const before = findChatTab(target);
    const application = useChatStore
      .getState()
      .setModelAndWait(
        selection.model,
        target,
        ...(selection.executionHarness ? [selection.executionHarness] : []),
      );
    const requestId =
      useChatStore.getState().pendingModelChanges[chatTargetKey(target)]
        ?.requestId;
    const accepted = await application.then(
      (result: boolean) => result,
      () => false,
    );
    if (!isAttemptCurrent(target)) return 'stale';
    const pending =
      useChatStore.getState().pendingModelChanges[chatTargetKey(target)];
    const after = findChatTab(target);
    if (
      (pending && pending.requestId !== requestId) ||
      (!accepted &&
        (before?.model !== after?.model ||
          before?.executionHarness !== after?.executionHarness))
    )
      return 'stale';
    return accepted ? 'accepted' : 'refused';
  }

  /**
   * CAN-5021: a model refused after the chat opened keeps
   * the presented prompt and title there, failed, with recovery in place. A
   * specific reason is named only when cached facts still establish it.
   */
  function failRefusedModel(
    target: HomeSendChatTarget,
    selection: FirstSendModelSelection,
    resume: FailedFirstSendRetry['resume'],
    refusal: HomeModelPreflightResult = cachedHomeModelRefusal(
      draft.workspaceId,
      selection,
    ),
  ): void {
    if (!isAttemptCurrent(target)) return;
    const message = refusal.ok
      ? homeModelFailureMessage(
          'model-rejected',
          homeModelDisplayLabel(selection.model),
        )
      : homeModelFailureMessage(refusal.reason, refusal.modelLabel);
    failInChat(target, selection, resume, message);
  }

  /**
   * Keeps the prompt in the chat that shows it, failed with `message` and
   * its Try again, and tells Home too when Home still owns this draft.
   */
  function failInChat(
    target: HomeSendChatTarget,
    selection: FirstSendModelSelection,
    resume: FailedFirstSendRetry['resume'],
    message: string,
    /**
     * A failure that is not a model refusal: Home shows it as itself, with
     * Try again when it is retryable, never Choose model.
     */
    home?: { failure: string | InlineFailure; retryable: boolean },
  ): void {
    const failureId = crypto.randomUUID();
    const homeFailure = home?.failure ?? message;
    const retryable = home?.retryable ?? false;
    const chooseModel = home === undefined;
    const presented = firstSendPresentation.target;
    const tabModelAtFailure = findChatTab(target)?.model;
    if (
      firstSend &&
      presented &&
      chatTargetKey(presented) === chatTargetKey(target) &&
      useChatStore.getState().failProvisionalFirstSend(target, {
        userMessageId: firstSend.userMessageId,
        attemptId: firstSendAttemptId,
        failure: { failureId, model: selection.model, message },
        // A send main refused before dispatch keeps its prompt failed here.
        refusedBeforeDispatch: firstSendRejected,
      })
    ) {
      // The failed prompt stays; nothing withdraws it from here on.
      firstSendPresentation.target = null;
      failedFirstSends.set(chatTargetKey(target), {
        userMessageId: firstSend.userMessageId,
        failureId,
        attempted: selection,
        tabModelAtFailure,
        tabHarnessAtFailure: findChatTab(target)?.executionHarness,
        resume,
      });
      fail(homeFailure, retryable, {
        failureId,
        inlineTarget: target,
        chooseModel,
      });
      return;
    }
    fail(homeFailure, retryable, {
      failureId,
      inlineTarget: null,
      chooseModel,
    });
  }

  /**
   * A retry from the failed chat resumes this submission's preparation under
   * a new attempt, rechecking eligibility first. It never owns Home's
   * sending state.
   */
  function resumeFirstSend(
    target: HomeSendChatTarget,
    continueFromModel: (selection: FirstSendModelSelection) => Promise<boolean>,
  ): FailedFirstSendRetry['resume'] {
    return async (attemptId, selection): Promise<boolean> => {
      resumedByRetry = true;
      firstSendAttemptId = attemptId;
      firstSendRejected = false;
      firstSendPresentation.target = target;
      try {
        if (!isAttemptCurrent(target)) return false;
        const eligibility = await preflightHomeModel(
          draft.workspaceId,
          selection,
        );
        if (!isAttemptCurrent(target)) return false;
        if (!eligibility.ok) {
          failRefusedModel(
            target,
            selection,
            resumeFirstSend(target, continueFromModel),
            eligibility,
          );
          return false;
        }
        return await continueFromModel(selection);
      } catch (err: unknown) {
        if (!isAttemptCurrent(target)) return false;
        const appError = toAppError(resolveClientAppError(err));
        // The retry ran from the failed chat, and Home may belong to another
        // draft by now: the prompt stays there, failed again, with this
        // reason. Not ready yet is a known state with its own sentence and
        // Try again; neither is a model refusal.
        const home: { failure: InlineFailure; retryable: boolean } | null =
          err instanceof OrgDefaultChatsUnavailableError
            ? { failure: { error: err.message }, retryable: true }
            : appError
              ? {
                  failure: inlineFailure(
                    appError,
                    "Couldn't send this message.",
                  ),
                  retryable: false,
                }
              : null;
        if (home !== null)
          failInChat(
            target,
            selection,
            resumeFirstSend(target, continueFromModel),
            inlineFailureText(home.failure) ?? "Couldn't send this message.",
            home,
          );
        return false;
      }
    };
  }

  // A retry resumes after Home's link submission has ended; its abort no
  // longer applies to the already-registered worktree.
  const creationAborted = (): boolean =>
    !resumedByRetry && destination?.signal?.aborted === true;

  destination?.signal?.addEventListener('abort', withdrawFirstSend, {
    once: true,
  });
  try {
    if (destination?.signal?.aborted) {
      withdrawFirstSend();
      if (ownsHomeSubmission())
        useHomeComposerStore.setState({ isSending: false });
      return false;
    }
    if (isCoworkChatTarget(workspaceId)) {
      // Expansion and preparation also await: never submit a newer draft.
      if (!ownsHomeSubmission() || !isSubmittedHomeDraftCurrent(draft)) {
        if (ownsHomeSubmission())
          useHomeComposerStore.setState({ isSending: false });
        return false;
      }
      if (scheduledSendDraft && draft.attachments.length > 0) {
        fail(
          'Scheduled sends to this destination cannot include attachments. Remove the attachments or send now.',
        );
        return false;
      }
      // Scheduled cowork sends defer chat creation entirely to automation
      // fire time via the `standalone_prompt` action — exact parity with the
      // `new-worktree`/`branch` deferred path below: no draft chat is
      // created now, nothing navigates, and success surfaces via the
      // automation-created toast. Like `worktree_prompt`, the action carries
      // no attachment fields (the guard above blocks scheduled cowork sends
      // with staged attachments), no `fileReferences` (typed `@` mentions
      // survive as plain relative text in `prompt`), and no `plugins` (the
      // fired automation falls back to the workspace's default plugin
      // selections — same `ChatTabPluginSelections`/`ShareablePluginRef[]`
      // gap documented on the deferred worktree path).
      if (scheduledSendDraft) {
        try {
          const organizationId =
            await requireOrgDefaultChatsEligibility(workspaceId);
          if (organizationId && !findWorkspace(workspaceId)) {
            if (
              typeof window.api.chatProject.ensureOrgDefaultCoworkWorkspace !==
              'function'
            ) {
              throw new OrgDefaultChatsUnavailableError(workspaceId);
            }
            await window.api.chatProject.ensureOrgDefaultCoworkWorkspace(
              organizationId,
            );
          }
        } catch (error) {
          const unavailable =
            error instanceof OrgDefaultChatsUnavailableError
              ? error
              : new OrgDefaultChatsUnavailableError(workspaceId, {
                  cause: error,
                });
          fail(unavailable.message, true);
          return false;
        }
        const workspace = findWorkspace(workspaceId);
        const workspaceName = workspace
          ? getWorkspaceDisplayName(workspace)
          : undefined;

        const response = await useAutomationsStore.getState().createActivity({
          name: 'Scheduled message',
          schedule: {
            kind: 'one_time',
            runAt: scheduledSendDraft.runAt,
            timezone: 'local',
          },
          action: {
            type: 'standalone_prompt',
            chatProjectId: workspaceId,
            prompt,
            model,
            thinking: thinkingLevel,
            ...(approvalMode ? { approvalMode } : {}),
          },
        });

        if (!response.ok || !response.activity) {
          const missingFolder = !response.ok
            ? readCoworkFolderMissing(response.coworkFolderMissing)
            : undefined;
          if (missingFolder) {
            fail(missingFolder.message, false, undefined, missingFolder);
            return false;
          }
          fail('Could not schedule message.');
          return false;
        }

        showAutomationCreatedToast(response.activity, workspaceName);
        completeSubmittedDraft();
        return true;
      }

      // Pills survive workspace switches, so a reference picked under a code
      // workspace's shadow/worktree can reach this route with a stale
      // absolutePath — re-root it onto the cowork cwd (and reformat the
      // prompt's inlined mention text against it).
      const coworkRewrite = await rewriteDraftPromptForCowork(
        prompt,
        fileReferences,
        workspaceId,
      );

      await useStandaloneChatStore.getState().createStandaloneChatWithMessage({
        chatProjectId: workspaceId,
        message: coworkRewrite.prompt,
        config: {
          model,
          modelExplicitlyChosen,
          ...(draft.modelSelectionMode === 'auto'
            ? { modelSelectionMode: 'auto' as const }
            : {}),
          thinkingLevel,
          pluginSelections: chatPlugins?.pluginSelections,
          ...(chatPlugins?.disabledGlobalPluginSelections
            ? {
                disabledGlobalPluginSelections:
                  chatPlugins.disabledGlobalPluginSelections,
              }
            : {}),
          fileReferences: coworkRewrite.fileReferences,
          attachmentPaths,
          attachmentPromptContexts,
          ...(draft.attachments.length > 0
            ? { attachments: draft.attachments }
            : {}),
          ...(speed !== undefined ? { speed } : {}),
          ...(!hasInitialMessage && draft.scheduledSendDraft
            ? { scheduledSendDraft: draft.scheduledSendDraft }
            : {}),
          approvalMode,
        },
      });
      useNavigationStore.getState().navigate('chat');
      completeSubmittedDraft();
      return true;
    }

    if (branchTarget.kind === 'worktree') {
      const { worktreeId } = branchTarget;
      useChatStore.getState().createTab({
        projectId: workspaceId,
        worktreeId,
        model,
        modelExplicitlyChosen,
        thinkingLevel,
        pluginSelections: chatPlugins?.pluginSelections,
      });

      // Capture the optimistic identity synchronously. A concurrent hydration
      // can temporarily reinstall the pre-existing active tab while the
      // canonical create is in flight; the Home draft still belongs to the
      // tab this action just created, not whichever tab happens to be active
      // during that intermediate snapshot.
      const key = `${workspaceId}/${worktreeId}`;
      const chatId = useChatStore.getState().worktreeChats[key]?.activeTabId;
      if (!chatId) {
        fail('Failed to create chat tab.');
        return false;
      }
      presentFirstSend({ projectId: workspaceId, worktreeId, chatId });
      if (transcriptChunkReady) {
        const chunk = await transcriptChunkReady;
        if (!chunk.ok) throw chunk.error;
      }
      if (destination?.signal?.aborted) return false;
      if (
        firstSend &&
        !useChatStore
          .getState()
          .worktreeChats[key]?.tabs.some((tab) => tab.id === chatId)
      ) {
        fail('The destination chat is no longer available.', true);
        return false;
      }
      // Publish the new tab and its echo before revealing this worktree. The
      // explicit target leaves any pre-existing conversation untouched.
      useChatStore.getState().selectWorktree(workspaceId, worktreeId);
      useNavigationStore.getState().navigate('main');

      // `createTab` paints optimistically while the revisioned command commits
      // in the background. Join that command before any settings/scheduling
      // writes target the new tab; otherwise those writes can race the
      // canonical create and be discarded with its provisional id.
      await useChatStore.getState().ensureWorktreeHasChatTab({
        projectId: workspaceId,
        worktreeId,
      });

      const target = { projectId: workspaceId, worktreeId, chatId };
      if (chatPlugins?.disabledGlobalPluginSelections) {
        await applyNewChatPluginSelections(
          useChatStore.getState,
          target,
          chatPlugins,
        );
      }
      const continueFromModel = async (
        selection: FirstSendModelSelection,
      ): Promise<boolean> => {
        if (!isAttemptCurrent(target)) return false;
        chatAttempt = { target, selection, continueFromModel };
        // Draft settings belong to the submitted model. A replacement
        // accepted in the failed chat keeps the settings its picker applied.
        const submittedModel =
          selection.model === model &&
          selection.executionHarness === draft.executionHarness;
        if (selection.executionHarness) {
          const outcome = await applyFirstSendModel(target, selection);
          if (outcome === 'stale') return false;
          if (outcome === 'refused') {
            failRefusedModel(
              target,
              selection,
              resumeFirstSend(target, continueFromModel),
            );
            return false;
          }
          // Applying another harness can restore its provider defaults. Keep
          // the thinking level shown in Home, as the new-worktree route does.
          if (submittedModel) {
            await useChatStore
              .getState()
              .setThinkingLevel(thinkingLevel, target);
          }
        }
        // Auto rides on the TAB, not on the send options: main re-reads the
        // canonical tab at dispatch and the queue keeps whatever the accepted
        // message captured. Written after the model/harness writes above, which
        // clear the selection mode for any change that is not main's own Auto
        // transition.
        if (!isAttemptCurrent(target)) return false;
        if (submittedModel && draft.modelSelectionMode === 'auto') {
          await useChatStore.getState().setModelSelectionMode('auto', target);
        }
        if (!isAttemptCurrent(target)) return false;
        if (submittedModel && speed !== undefined) {
          await useChatStore.getState().setSpeed(speed, target);
        }
        if (!isAttemptCurrent(target)) return false;
        // Enabled, not toggled: Try again re-runs this step.
        if (planMode && findChatTab(target)?.planMode !== true) {
          useChatStore.getState().togglePlanMode(target);
        }
        if (approvalMode) {
          // Pin the composer's explicit approval-mode selection onto the
          // freshly created tab. Untouched (`undefined`) drafts leave the tab
          // unset so the normal resolution chain applies instead.
          await useChatStore
            .getState()
            .setTabApprovalMode(target, approvalMode);
        }
        if (!isAttemptCurrent(target)) return false;
        if (selectedRepoId) {
          // Pin the composer's working-directory selection onto the freshly
          // created (still-empty) tab so the session cwd, tab discovery, and
          // persisted tab state all match what the Home composer showed —
          // same normalization/locking rules as the chat composer's picker.
          useChatStore.getState().setSelectedRepoId(selectedRepoId, target);
        }

        // Pills survive branch-target switches, so a reference picked while
        // the draft targeted `new-worktree`/`branch` (shadow-checkout
        // absolutePath) — or a different worktree — can reach this route with
        // a stale absolutePath. Re-root any such reference (and its inlined
        // mention text) onto THIS worktree's cwd before dispatch (fix round 1).
        const existingWorktreeRewrite = fileReferences
          ? await rewriteDraftPromptForWorktree(
              prompt,
              fileReferences,
              workspaceId,
              worktreeId,
              selectedRepoId,
            )
          : { prompt, fileReferences: [] };
        const existingWorktreePrompt = existingWorktreeRewrite.prompt;
        const existingWorktreeFileReferences = outboundFileReferences(
          existingWorktreeRewrite.fileReferences,
        );

        // Staging can happen before the branch picker settles on this existing
        // worktree (e.g. staged under `new-worktree`, then switched to an
        // existing worktree in the picker) — those attachments still live
        // under the `HOME_DRAFT_WORKTREE_ID` staging dir and fail the send
        // path's `validateAttachmentPath` check against *this* worktree's
        // attachment dir. Re-import the whole draft set through the same
        // helper the new-worktree path uses whenever any attachment isn't
        // already staged here; attachments staged directly against this
        // worktree (the common case — see `HomeComposerControls`'s
        // `draftWorktreeId`) skip this entirely.
        let existingWorktreeAttachmentPaths = attachmentPaths;
        let existingWorktreeAttachmentPromptContexts = attachmentPromptContexts;
        let existingWorktreeAttachments = draft.attachments;
        if (!isAttemptCurrent(target)) return false;
        if (
          draft.attachments.some(
            (attachment) =>
              !isAttachmentStagedForWorktree(
                attachment.absolutePath,
                worktreeId,
              ),
          )
        ) {
          const restaged = await reimportDraftAttachmentsPreservingPromptKind(
            { projectId: workspaceId, worktreeId },
            draft.attachments,
          );
          existingWorktreeAttachments = restaged;
          existingWorktreeAttachmentPaths = attachmentPathsFromMeta(restaged);
          existingWorktreeAttachmentPromptContexts =
            attachmentPromptContextsFromMeta(restaged);
        }

        if (!isAttemptCurrent(target)) return false;
        if (!hasInitialMessage) {
          useChatStore
            .getState()
            .addPendingAttachments(existingWorktreeAttachments, target);
          if (draft.scheduledSendDraft) {
            await useChatStore
              .getState()
              .setScheduledSendDraft(draft.scheduledSendDraft, target);
          }
          await useChatStore
            .getState()
            .flushWorktreeTabs(workspaceId, worktreeId);
          completeSubmittedDraft();
          return true;
        }

        if (!isAttemptCurrent(target)) return false;
        if (scheduledSendDraft) {
          const workspace = findWorkspace(workspaceId);
          const worktreeName =
            workspace && workspace.type !== 'cowork'
              ? workspace.worktrees.find((wt) => wt.id === worktreeId)
                  ?.branchName
              : undefined;

          const response = await useAutomationsStore.getState().createActivity({
            name: 'Scheduled message',
            schedule: {
              kind: 'one_time',
              runAt: scheduledSendDraft.runAt,
              timezone: 'local',
            },
            action: {
              type: 'worktree_session_prompt',
              workspaceId,
              worktreeId,
              chatId,
              prompt: existingWorktreePrompt,
              ...(existingWorktreeFileReferences
                ? { fileReferences: existingWorktreeFileReferences }
                : {}),
              ...(existingWorktreeAttachmentPaths
                ? { attachmentPaths: existingWorktreeAttachmentPaths }
                : {}),
              ...(existingWorktreeAttachmentPromptContexts
                ? {
                    attachmentPromptContexts:
                      existingWorktreeAttachmentPromptContexts,
                  }
                : {}),
              purpose: 'scheduled_send',
              ...(workspace
                ? { workspaceName: getWorkspaceDisplayName(workspace) }
                : {}),
              ...(worktreeName ? { worktreeName } : {}),
            },
          });

          if (!response.ok) {
            fail('Could not schedule message.');
            return false;
          }

          await useChatStore
            .getState()
            .setScheduledSendDraft({ runAt: scheduledSendDraft.runAt }, target);
          await useChatStore
            .getState()
            .flushWorktreeTabs(workspaceId, worktreeId);

          completeSubmittedDraft();
          return true;
        }

        if (!isAttemptCurrent(target)) return false;
        await useChatStore
          .getState()
          .sendMessage(
            existingWorktreePrompt,
            existingWorktreeFileReferences,
            target,
            undefined,
            {
              attachmentPaths: existingWorktreeAttachmentPaths,
              attachmentPromptContexts:
                existingWorktreeAttachmentPromptContexts,
              ...firstSendDispatchOptions(),
            },
          );

        if (firstSendRejected) return false;
        completeSubmittedDraft();
        return true;
      };
      return await continueFromModel(submittedModelSelection);
    }

    // `new-worktree` / `branch` / `pr` / `linear-issue` path. Resolve the
    // worktree-create options ONCE (shared by the scheduled and immediate
    // routes below) so create semantics stay identical: `branch`/`pr` check
    // out an existing branch, and `linear-issue` checks out its branch when it
    // already exists or creates a new one otherwise. See
    // `createOptionsForBranchTarget`.
    const workspace = findWorkspace(workspaceId);
    const createOptions: CreateWorktreeOptions | undefined =
      destination &&
      !scheduledSendDraft &&
      branchTarget.kind === 'linear-issue' &&
      workspace &&
      workspaceRepoPathForCreateFrom(workspace)
        ? { suggestedBranch: branchTarget.branchName }
        : workspace?.type === 'single-repo' &&
            branchTarget.kind === 'new-worktree'
          ? createOptionsForNewWorktreeBaseTarget(draftNewWorktreeBaseTarget)
          : createOptionsForBranchTarget(branchTarget, draftBranches);

    // `new-worktree` / `branch` / `pr` / `linear-issue` scheduled path: defer
    // provisioning entirely to automation fire time via the extended
    // `worktree_prompt` action (see Task C1). No worktree or tab exists yet, so
    // there is nowhere to attach a `scheduledSendDraft` pill — success surfaces
    // via the automation-created toast instead (Task C2). This action carries
    // no attachment fields (the schedule affordance is disabled in the composer
    // whenever attachments are staged for this target) and no `plugins`
    // field: `ChatTabPluginSelections` and the action's `ShareablePluginRef[]`
    // shape are not interconvertible without a dedicated resolver, so the
    // fired automation falls back to the workspace's default plugin
    // selections rather than the composer's in-flight selection — see the
    // Task C3 report for detail. Task F3: `worktree_prompt` also carries no
    // `fileReferences` field — a shadow-relative rewrite target doesn't exist
    // until the worktree is actually provisioned at fire time, and adding a
    // deferred-rewrite mechanism to the automation executor is out of scope
    // here. `@` mentions typed into `prompt` still resolve as plain relative
    // text (the pill's `displayPath`, already relative — see
    // `rewriteFileReferencesForTargetCwd`'s doc comment), so the mention
    // itself is not lost, only its structured `FileReference` metadata.
    // The composer's multi-repo working-directory selection is likewise not
    // carried: `worktree_prompt` has no repo-scope field, so the fired
    // automation's chat runs at the workspace root like every other
    // `worktree_prompt` automation.
    if (scheduledSendDraft) {
      // Task 11 fallback: `worktree_prompt` is a persisted, cross-package
      // automation action carrying only `existingBranch` (no
      // create-new-named-branch field). A `linear-issue` target whose branch
      // doesn't exist yet resolves to `{ branchName }` (create new), which
      // cannot be deferred to fire time without extending that persisted wire
      // type. Reject the schedule with a clear error rather than silently
      // dropping the branch name. Every other target resolves to
      // `existingBranch`/none and schedules normally.
      if (createOptions?.branchName) {
        fail(
          'Scheduling is not available for a Linear issue whose branch does not exist yet. Send now, or pick its PR or an existing branch.',
        );
        return false;
      }

      const workspaceName = workspace
        ? getWorkspaceDisplayName(workspace)
        : undefined;

      if (destination?.signal?.aborted) return false;
      const linkTarget = useHomeComposerStore.getState().linkTarget;
      if (
        destination &&
        linkTarget.status === 'submitting' &&
        isHomeSendAccountCurrent(submittedAccountEpoch)
      )
        useHomeComposerStore.getState().setLinkTarget({
          ...linkTarget,
          canCancel: false,
          progress: 'Scheduling task…',
        });
      const response = await useAutomationsStore.getState().createActivity({
        name: 'Scheduled task',
        schedule: {
          kind: 'one_time',
          runAt: scheduledSendDraft.runAt,
          timezone: 'local',
        },
        action: {
          type: 'worktree_prompt',
          workspaceId,
          prompt,
          ...(createOptions?.existingBranch
            ? { existingBranch: createOptions.existingBranch }
            : {}),
          ...(createOptions?.baseWorktreeId
            ? { baseWorktreeId: createOptions.baseWorktreeId }
            : {}),
          ...(createOptions?.baseBranch
            ? { baseBranch: createOptions.baseBranch }
            : {}),
          // `model`/`thinkingLevel` are always concrete post-F1 (effective
          // defaults resolved above), so these are unconditional now — this
          // pins WYSIWYG at schedule time instead of silently falling back to
          // whatever the fired action's own default resolution would pick.
          model,
          thinking: thinkingLevel,
          ...(planMode ? { planMode: true } : {}),
          ...(approvalMode ? { approvalMode } : {}),
          purpose: 'scheduled_task',
          ...(workspaceName ? { workspaceName } : {}),
        },
      });

      if (!response.ok || !response.activity) {
        fail('Could not schedule task.');
        return false;
      }

      showAutomationCreatedToast(response.activity, workspaceName);
      if (firstSendRejected) return false;
      completeSubmittedDraft();
      return true;
    }

    // `new-worktree` / `branch` — Task I1 single-transition send. The
    // reservation is now reservation-only: the workspace-root git setup +
    // repair validation are deferred to Phase B (see `createMultiRepoWorktree`),
    // so local registration lands quickly with a `git-pending` worktree. The
    // registration callback makes ONE clean major transition possible — Home
    // composer → the real WorktreePart UI — as soon as that row is usable,
    // after chat hydration and layout initialization, without waiting for
    // post-create refreshes. Phase B setup continues independently; the
    // message can be queued on the active worktree while setup runs.
    //
    // `deselectWorktree()` runs first (synchronously, before the await): a Home
    // send can arrive with a worktree in a DIFFERENT workspace still selected,
    // and clearing it up front means a creation failure never strands the user
    // on a stale selection, and the later `navigate('main')` can never briefly
    // paint a previously-selected worktree's chat. It nulls selection WITHOUT
    // writing the MRU/`lastActiveContext` preference and without disturbing
    // `selectedWorktreeBeforeStandaloneChat`.
    useChatStore.getState().deselectWorktree();

    let activatedWorktreeId: string | null = null;
    let activationFailed = false;
    let registeredSetupPhase: WorktreeData['setupPhase'];
    let activationPromise: Promise<void> | null = null;
    const activateCreatedWorktree = async (
      worktreeId: string,
      setupPhase: WorktreeData['setupPhase'],
    ): Promise<void> => {
      if (destination?.signal?.aborted) return;
      activatedWorktreeId = worktreeId;
      registeredSetupPhase = setupPhase;
      // Hydrate the canonical chat before seeding its panel. A local starter
      // can be replaced by the initial empty snapshot; once selected, panel
      // sync would remove its group and place the final chat in another one.
      await useChatStore.getState().loadTabsForTarget(workspaceId, worktreeId, {
        model,
        thinkingLevel,
        pluginSelections: chatPlugins?.pluginSelections,
        skipActiveSessions: true,
      });
      if (destination?.signal?.aborted) return;
      await useChatStore.getState().ensureWorktreeHasChatTab({
        projectId: workspaceId,
        worktreeId,
      });
      if (destination?.signal?.aborted) return;
      if (firstSend) {
        // The destination's first frame must already show the question, so
        // present it before selection and navigation. A missing starter takes
        // the creation failure path instead of opening an empty chat.
        const starterId =
          useChatStore.getState().worktreeChats[`${workspaceId}/${worktreeId}`]
            ?.activeTabId;
        if (!starterId) {
          activationFailed = true;
          return;
        }
        presentFirstSend({
          projectId: workspaceId,
          worktreeId,
          chatId: starterId,
        });
      }
      // The Code grid restores its persisted/default layout asynchronously for
      // both pending and already-ready registrations. Finish that work while
      // Home is still mounted so neither setup phase can reveal the
      // otherwise-empty grid shell under a busy renderer.
      await ensureWorktreePanelLayout(`${workspaceId}/${worktreeId}`);
      // A failed chunk load takes the creation failure path before navigation.
      if (transcriptChunkReady) {
        const chunk = await transcriptChunkReady;
        if (!chunk.ok) throw chunk.error;
      }
      if (destination?.signal?.aborted) return;
      if (
        firstSend &&
        firstSendPresentation.target &&
        !useChatStore
          .getState()
          .worktreeChats[
            `${workspaceId}/${worktreeId}`
          ]?.tabs.some((tab) => tab.id === firstSendPresentation.target?.chatId)
      ) {
        activationFailed = true;
        return;
      }
      if (setupPhase === 'git-pending') {
        useChatStore.getState().selectWorktree(workspaceId, worktreeId, {
          deferTabLoad: true,
        });
      } else {
        useChatStore.getState().selectWorktree(workspaceId, worktreeId);
      }
      useNavigationStore.getState().navigate('main');
    };

    const created = await useProjectsStore
      .getState()
      .createWorktree(workspaceId, {
        ...createOptions,
        suppressStartPage: hasInitialMessage,
        // The Home flow needs setup-aware selection so its targeted tab
        // hydration cannot race the generic selection load. Registration is
        // therefore responsible for both selection and the page handoff.
        select: false,
        onRegistered: (worktree) => {
          activationPromise = activateCreatedWorktree(
            worktree.id,
            worktree.setupPhase,
          );
        },
      });
    if (!created) {
      // A deferred source-backed multi-repo repair requirement now arrives
      // ASYNCHRONOUSLY via the `worktree:needs-repair` event (which removes the
      // rolled-back row and sets `pendingWorkspaceRepair` on the Code page), so
      // a falsy `created` here is a plain creation failure: the user is still on
      // Home (navigate runs only after a successful create), so just surface
      // `sendError` and keep the draft intact for a retry. If a synchronous
      // repair state was nonetheless set, honor it by navigating to its modal.
      if (useProjectsStore.getState().pendingWorkspaceRepair !== null) {
        if (!isHomeSendAccountCurrent(submittedAccountEpoch)) return false;
        useNavigationStore.getState().navigate('main');
        useHomeComposerStore.setState({ isSending: false });
        return false;
      }
      const projects = useProjectsStore.getState();
      // Once the composer shows this failure where the send started, the
      // worktree error notice over every page would show it a second time.
      // When the draft changed meanwhile, the notice is the only place left.
      if (fail(projects.worktreeError ?? 'Failed to create worktree.'))
        projects.clearWorktreeError();
      return false;
    }

    const reservedWorkspace = useProjectsStore
      .getState()
      .projects.find((project) => project.id === workspaceId);
    const reservedWorktree =
      reservedWorkspace && reservedWorkspace.type !== 'cowork'
        ? reservedWorkspace.worktrees.find(
            (worktree) => worktree.id === created.id,
          )
        : undefined;
    const createdSetupPhase =
      registeredSetupPhase ??
      created.setupPhase ??
      reservedWorktree?.setupPhase;
    const createdIsGitPending = createdSetupPhase === 'git-pending';
    // Test doubles and older injected stores may not expose the registration
    // callback yet. Preserve a post-resolution fallback without making the
    // production path wait for persistence or refreshes.
    if (activatedWorktreeId !== created.id) {
      activationPromise = activateCreatedWorktree(
        created.id,
        createdSetupPhase,
      );
    }
    await activationPromise;
    if (activationFailed) {
      fail('Failed to create chat tab.');
      return false;
    }
    if (destination?.signal?.aborted) {
      fail(
        'Creation stopped after the worktree was registered. The worktree remains available.',
        false,
      );
      return false;
    }

    // Activation has hydrated the canonical starter and its layout. Refresh
    // the registered target before capturing the chat id for draft settings
    // or the setup queue.
    await useChatStore
      .getState()
      .loadAllWorktreeTabs([
        { projectId: workspaceId, worktreeId: created.id },
      ]);
    // A deleted target is not permission to create another chat from this
    // stale continuation. A nonempty replacement must pass presentation's
    // ownership check below before any settings or send can target it.
    if (
      firstSend &&
      !useChatStore.getState().worktreeChats[`${workspaceId}/${created.id}`]
        ?.tabs.length
    ) {
      fail('The destination chat is no longer available.', true);
      return false;
    }
    const refreshedTabs =
      useChatStore.getState().worktreeChats[`${workspaceId}/${created.id}`]
        ?.tabs;
    if (
      firstSend &&
      firstSendPresentation.target &&
      !refreshedTabs?.some(
        (tab) => tab.id === firstSendPresentation.target?.chatId,
      ) &&
      (!starterWasProvisional ||
        refreshedTabs.filter((tab) => tab.kind !== 'file').length !== 1)
    ) {
      fail('The destination chat is no longer available.', true);
      return false;
    }
    // Re-ensure the starter after the refresh before model/settings commands
    // target it. The canonical create is idempotent for an existing chat.
    // The first send is already on screen, so a tab the user switched to
    // since navigation keeps focus.
    await useChatStore
      .getState()
      .ensureWorktreeHasChatTab(
        { projectId: workspaceId, worktreeId: created.id },
        firstSend ? { preserveActiveTab: true } : undefined,
      );

    if (!createdIsGitPending) {
      const tabsLoaded = await useChatStore
        .getState()
        .ensureSelectedWorktreeTabsLoaded(10_000);
      if (!tabsLoaded) {
        fail('Failed to load chat tabs.');
        return false;
      }
    }

    const key = `${workspaceId}/${created.id}`;
    const scopeTabs = useChatStore.getState().worktreeChats[key];
    // The presented chat stays the target even if the user switched tabs
    // since. Only a starter the refresh replaced moves the submission, under
    // the same identity, to the sole chat that replaced it (verified above),
    // never to whichever tab happens to be active.
    const presentedChatId = firstSendPresentation.target?.chatId ?? null;
    const replacementChatTabs =
      scopeTabs?.tabs.filter((tab) => tab.kind !== 'file') ?? [];
    const chatId =
      presentedChatId &&
      scopeTabs?.tabs.some((tab) => tab.id === presentedChatId)
        ? presentedChatId
        : firstSend
          ? replacementChatTabs.length === 1
            ? replacementChatTabs[0]?.id
            : undefined
          : scopeTabs?.activeTabId;
    if (!chatId) {
      fail('Failed to create chat tab.');
      return false;
    }
    if (firstSend && chatId !== presentedChatId) {
      firstSendPresentation.target = null;
      presentFirstSend({
        projectId: workspaceId,
        worktreeId: created.id,
        chatId,
      });
    }

    // Staged attachments live under the `HOME_DRAFT_WORKTREE_ID` sentinel
    // dir, but the send path validates `attachmentPaths` against the real
    // *target* worktree's attachment dir and throws otherwise
    // (`buildSubmittedMessageText`'s `validateAttachmentPath`). Re-import
    // them into the freshly created worktree's attachment dir (the same
    // existing `worktree:import-attachments` IPC the attach button already
    // uses) so `attachmentPaths` below resolves inside the right directory.
    let newWorktreeAttachmentPaths = attachmentPaths;
    let newWorktreeAttachmentPromptContexts = attachmentPromptContexts;
    let newWorktreeAttachments = draft.attachments;
    // Runs inside the chat attempt, so a failed re-import stays failed in the
    // chat with Try again, which re-imports once more.
    let newWorktreeAttachmentsRestaged = draft.attachments.length === 0;
    const restageNewWorktreeAttachments = async (): Promise<void> => {
      if (newWorktreeAttachmentsRestaged) return;
      const restaged = await reimportDraftAttachmentsPreservingPromptKind(
        { projectId: workspaceId, worktreeId: created.id },
        draft.attachments,
      );
      newWorktreeAttachments = restaged;
      newWorktreeAttachmentPaths = attachmentPathsFromMeta(restaged);
      newWorktreeAttachmentPromptContexts =
        attachmentPromptContextsFromMeta(restaged);
      newWorktreeAttachmentsRestaged = true;
    };

    const target = { projectId: workspaceId, worktreeId: created.id, chatId };
    // Hydration may have been started by selection without the Home draft's
    // overrides, so apply them after the join. This also pins the touched
    // values when a persisted/default tab won the hydration race.
    // The model change is accepted by the main process before the tab update.
    // Wait for that update so `sendMessage` cannot build its first-turn payload
    // from the hydrated/default provider instead of the Home selection.
    // Start model persistence immediately and join it before the first message
    // is accepted, including while git setup is pending. A setup-queued first
    // message captures the tab's execution harness; queueing it before this
    // acknowledgement can permanently pin the provisional tab's default
    // harness (for example Codex) even when the selected gateway model is
    // assigned to Claude.
    // `setModelAndWait` reports "did it land" as a boolean and swallows a
    // rejected IPC as `false`, so a refusal arrives resolved, not thrown.
    // Reading only the rejection arm would make this guard unreachable.
    const continueFromModel = async (
      selection: FirstSendModelSelection,
    ): Promise<boolean> => {
      if (!isAttemptCurrent(target)) return false;
      chatAttempt = { target, selection, continueFromModel };
      await restageNewWorktreeAttachments();
      if (!isAttemptCurrent(target)) return false;
      const outcome = await applyFirstSendModel(target, selection);
      if (outcome === 'stale') return false;
      if (outcome === 'refused') {
        failRefusedModel(
          target,
          selection,
          resumeFirstSend(target, continueFromModel),
        );
        return false;
      }
      // Draft settings belong to the submitted model. A replacement accepted
      // in the failed chat keeps the settings its own picker applied.
      const submittedModel =
        selection.model === model &&
        selection.executionHarness === draft.executionHarness;
      // Re-applied after the model change: `commitCanonicalModelChange` clears
      // the selection mode for any change that is not main's own Auto
      // transition, so setting it earlier would be erased by the model write.
      if (submittedModel && draft.modelSelectionMode === 'auto') {
        await useChatStore.getState().setModelSelectionMode('auto', target);
      }
      if (!isAttemptCurrent(target)) return false;
      if (submittedModel) {
        await useChatStore.getState().setThinkingLevel(thinkingLevel, target);
      }
      if (!isAttemptCurrent(target)) return false;
      if (chatPlugins !== null) {
        await applyNewChatPluginSelections(
          useChatStore.getState,
          target,
          chatPlugins,
        );
      }
      if (!isAttemptCurrent(target)) return false;
      // Enabled, not toggled: Try again re-runs this step.
      if (planMode && findChatTab(target)?.planMode !== true) {
        useChatStore.getState().togglePlanMode(target);
      }
      if (approvalMode) {
        // Same explicit-only pinning as the existing-worktree route: an
        // untouched draft leaves the tab unset so the normal resolution chain
        // applies instead.
        await useChatStore.getState().setTabApprovalMode(target, approvalMode);
      }
      if (!isAttemptCurrent(target)) return false;
      if (selectedRepoId) {
        // Same working-directory pinning as the existing-worktree route: the
        // tab is still empty at this point, so the picker selection binds the
        // session cwd to the chosen child repo before the first message.
        useChatStore.getState().setSelectedRepoId(selectedRepoId, target);
      }

      if (!isAttemptCurrent(target)) return false;
      if (!hasInitialMessage) {
        if (!isAttemptCurrent(target)) return false;
        if (submittedModel && speed !== undefined) {
          await useChatStore.getState().setSpeed(speed, target);
        }
        useChatStore
          .getState()
          .addPendingAttachments(newWorktreeAttachments, target);
        if (draft.scheduledSendDraft) {
          await useChatStore
            .getState()
            .setScheduledSendDraft(draft.scheduledSendDraft, target);
        }
        await useChatStore
          .getState()
          .flushWorktreeTabs(workspaceId, created.id);
        completeSubmittedDraft();
        return true;
      }

      // The `@` mention typeahead ran against the workspace's repo-shadow
      // checkout(s) while this draft targeted `new-worktree`/`branch` (Task
      // F3's `baseline` file-index target — nothing was checked out yet). Now
      // that `created.id`'s real worktree exists, remap any picked file's
      // `absolutePath` off the shadow (or any other stale root) and onto the
      // new worktree's cwd — and reformat the prompt's inlined mention text
      // against that cwd — before it reaches `sendMessage`. See
      // `rewriteDraftPromptForWorktree`.
      const newWorktreeRewrite = await rewriteDraftPromptForWorktree(
        prompt,
        expandedDraft.fileReferences,
        workspaceId,
        created.id,
        selectedRepoId,
      );

      if (submittedModel && speed !== undefined) {
        await useChatStore.getState().setSpeed(speed, target);
      }
      if (!isAttemptCurrent(target)) return false;
      if (creationAborted()) {
        fail(
          'Creation stopped after the worktree was registered. The worktree remains available.',
          false,
        );
        return false;
      }
      if (
        firstSend &&
        !useChatStore
          .getState()
          .worktreeChats[key]?.tabs.some((tab) => tab.id === chatId)
      ) {
        fail('The destination chat is no longer available.', true);
        return false;
      }
      if (!isAttemptCurrent(target)) return false;
      await useChatStore
        .getState()
        .sendMessage(
          newWorktreeRewrite.prompt,
          outboundFileReferences(newWorktreeRewrite.fileReferences),
          target,
          undefined,
          {
            attachmentPaths: newWorktreeAttachmentPaths,
            attachmentPromptContexts: newWorktreeAttachmentPromptContexts,
            ...firstSendDispatchOptions(),
          },
        );

      if (firstSendRejected) return false;
      completeSubmittedDraft();
      return true;
    };
    return await continueFromModel(submittedModelSelection);
  } catch (err: unknown) {
    // CAN-6019: main refused a folder that went missing after the preflight
    // (or was never checked); Home offers the same recovery.
    const missingFolder = resolveCoworkFolderMissing(err, workspaceId);
    if (missingFolder) {
      fail(missingFolder.message, false, undefined, missingFolder);
      return false;
    }
    const appError = toAppError(resolveClientAppError(err));
    // Not ready yet is a known, retryable state with its own sentence, not a
    // defect to report.
    if (err instanceof OrgDefaultChatsUnavailableError) {
      fail(err.message, true);
    } else if (appError) {
      fail(inlineFailure(appError, "Couldn't send this message."));
    } else if (ownsHomeSubmission()) {
      withdrawFirstSend();
      useHomeComposerStore.setState({ isSending: false });
    }
    return false;
  } finally {
    destination?.signal?.removeEventListener('abort', withdrawFirstSend);
  }
}
