import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, parse, resolve } from 'node:path';
import {
  IPC_CHANNELS,
  type ApprovalRequestEvent,
  type ApprovalCheck,
  type ApprovalEvaluation,
  type ApprovalMode,
  type ApprovalPromptDecision,
  type ApprovalRequestDetails,
  type ApprovalRule,
  type ApprovalRuleScope,
  type ApprovalRuleSets,
  type ApprovalRuleTarget,
  type PersistedChatMessage,
  type SafetyDenyReason,
} from '@canopy/desktop-shared/types';
import {
  approvalSafetyDeniedInfoSchema,
  safetyDenyReasonSchema,
  SAFETY_DENIED_COMMAND_MAX_CHARS,
  FAIL_CLOSED_MESSAGE,
  POLICY_DENIED_FALLBACK_MESSAGE,
  safetyDeniedMessage,
  savedRuleDeniedMessage,
  userDeniedMessage,
} from '@canopy/protocol/approvals';
import { redactSecrets } from '@canopy/execution-engine/lib/redaction';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  evaluateApproval,
  recursiveForcedRemoveOperations,
  commandPathOperations,
} from '@canopy/desktop-shared/lib/approval-engine';
import { addWorkspaceApprovalRule } from '../lib/approvals-persistence';
import { updatePreferencesFile } from '../lib/preferences-store';
import { sendToWindow, type SendableBrowserWindow } from '../lib/window-send';
import { getObservabilityService } from '../observability';
import { requestApprovalDecision } from './prompt-bridge';
import {
  cancelApproval,
  rejectAllApprovalsForSession,
  resolveApprovalFromMain,
} from './pending-approvals';
import { registerApprovalSession } from './approval-session-registry';
import {
  approvalPolicyWorkspaceId,
  isPathCaseInsensitiveAt,
  protectedApprovalFileWritePaths,
  readGlobalApprovalRuleTier,
  readWorkspaceApprovalRuleTier,
  resolveExistingAncestorPath as resolveExistingAncestorPathFrom,
} from './approval-rule-sources';
import { clampToLiveApprovalMode } from './live-approval-modes';
import {
  getGlobalApprovalRulesRevision,
  getGlobalApprovalRulesSaveGeneration,
  getWorkspaceApprovalRulesRevision,
  getWorkspaceApprovalRulesSaveGeneration,
  isFileWriteNarrowingInFlight,
  isGlobalApprovalRulesSettled,
  isWorkspaceApprovalRulesSettled,
  markGlobalApprovalRulesChanged,
} from './rule-revisions';
import { isApprovalPromptDecision } from './approval-decision-validation';
import { pauseOpenTurnTimer } from '@canopy/agent-transcript';
import { releaseTurnTimerPause } from '../lib/settled-turn-timer-guard';

const RULES_CACHE_TTL_MS = 5000;

export const APPROVAL_REQUEST_RESOLVED = 'approval_request_resolved';

function expandDestructiveOperandTilde(
  operand: string,
  effectiveCwd: string,
): string | undefined {
  if (operand === '~' || operand.startsWith('~/')) {
    return join(homedir(), operand.slice(2));
  }
  if (operand === '~+' || operand.startsWith('~+/')) {
    return join(effectiveCwd, operand.slice(3));
  }
  // `~-` is derived from shell-maintained OLDPWD state, which can change
  // within a command chain. The approval layer cannot reproduce it safely.
  if (operand === '~-' || operand.startsWith('~-/')) {
    return undefined;
  }
  if (operand.startsWith('~')) {
    const separatorIndex = operand.indexOf('/');
    const username = operand.slice(
      1,
      separatorIndex < 0 ? operand.length : separatorIndex,
    );
    let currentUsername: string;
    try {
      currentUsername = userInfo().username;
    } catch {
      return undefined;
    }
    if (username !== currentUsername) {
      return undefined;
    }
    const suffix = separatorIndex < 0 ? '' : operand.slice(separatorIndex + 1);
    return suffix ? join(homedir(), suffix) : homedir();
  }
  return operand;
}

interface ApprovalCheckCancellation {
  cancellation: Promise<never>;
  isCancelled(): boolean;
  registerRequestId(requestId: string): void;
  throwIfCancelled(): void;
  accept(): void;
  dispose(): void;
}

function createApprovalCheckCancellation(
  signal: AbortSignal | undefined,
  onRequestCancelled: (requestId: string) => void,
): ApprovalCheckCancellation {
  let cancelled = false;
  let accepted = false;
  let requestId: string | undefined;
  let rejectCancellation: (reason: Error) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });

  function cancelRegisteredRequest(id: string): void {
    try {
      onRequestCancelled(id);
    } catch {
      // The registry still needs to settle even if local prompt cleanup fails.
    }
    try {
      cancelApproval(id, APPROVAL_REQUEST_RESOLVED);
    } catch {
      // Cancellation remains fail-closed even if detaching the renderer card fails.
    }
  }

  function onAbort(): void {
    if (accepted || cancelled) return;
    cancelled = true;
    if (requestId !== undefined) {
      cancelRegisteredRequest(requestId);
    }
    rejectCancellation(new Error(APPROVAL_REQUEST_RESOLVED));
  }

  function isCancelled(): boolean {
    if (!accepted && signal?.aborted) {
      onAbort();
    }
    return cancelled;
  }

  function throwIfCancelled(): void {
    if (isCancelled()) {
      throw new Error(APPROVAL_REQUEST_RESOLVED);
    }
  }

  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) {
    onAbort();
  }

  return {
    cancellation,
    isCancelled,
    registerRequestId(id: string): void {
      requestId = id;
      if (cancelled) {
        cancelRegisteredRequest(id);
      }
    },
    throwIfCancelled,
    accept(): void {
      throwIfCancelled();
      accepted = true;
    },
    dispose(): void {
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

export interface ApprovalSessionContext {
  sessionKey: string;
  projectId: string;
  /** Workspace whose persisted approval rules govern a cross-surface action. */
  policyProjectId?: string;
  worktreeId: string;
  chatId: string;
  provider: ApprovalRequestEvent['provider'];
  workspaceRoot: string;
  mode: ApprovalMode;
  /** Seeded from the tab; mutated in place on session-scope grants. */
  sessionRules: ApprovalRule[];
  getWindow: () => SendableBrowserWindow | null;
  onAwaitingUser?: () => void;
  /** Optional fail-closed deadline for hosts with a shorter outer timeout. */
  promptTimeoutMs?: number;
  /** Non-chat approval surfaces have no persisted turn timer to pause. */
  trackChatTurn?: boolean;
  /** Read synchronously at check entry, before policy or receipt IO. */
  getTurnUserMessageId?: () => string | undefined;
}

interface SafetyReceiptIdentity {
  receiptId: string;
  turnUserMessageId?: string;
}

export interface ApprovalOutcome {
  decision: 'allow' | 'deny';
  message?: string;
  stopTurn?: boolean;
}

export interface ApprovalCheckDisplay {
  /** Cancels this check's prompt without affecting other checks in the session. */
  signal?: AbortSignal;
  /** Called once, when this check parks on a person; after the session's own callback */
  onAwaitingUser?: () => void;
  title: string;
  description?: string;
  details: ApprovalRequestDetails;
  suggestedTarget?: ApprovalRuleTarget;
  toolUseId?: string;
  /** See `ApprovalRequestEvent.subagentId`. */
  subagentId?: string;
}

export interface ApprovalSessionHandle {
  check(
    check: ApprovalCheck,
    display: ApprovalCheckDisplay,
  ): Promise<ApprovalOutcome>;
  /**
   * The policy's current outcome for a check, without prompting, recording a
   * decision, or queueing. Fails closed to `deny`. Used where a host must
   * decide up front what a delegate may do, such as which write grants reach
   * a Codex child's sandbox.
   */
  evaluate?(check: ApprovalCheck): Promise<ApprovalEvaluation['outcome']>;
  setMode(mode: ApprovalMode): void;
  /**
   * Changes whenever the mode or persisted project/global policy changes, and
   * when a project or global rule save starts or settles.
   */
  policyContextKey?(): string;
  /**
   * Whether a project or global save that may revoke a file-write grant is in
   * flight. Evaluations wait for its outcome; a sandbox that writes without
   * asking has to stop meanwhile.
   */
  fileWriteNarrowingInFlight?(): boolean;
  /**
   * Re-runs the policy for every prompt this handle currently has on screen,
   * under `mode`, and releases the ones the widened mode would not have asked
   * about (CAN-3083). Never rejects, and never decides *against* the user: a
   * `deny` or a still-`prompt` outcome leaves the card standing.
   *
   * `previousMode` is the mode the chat was in before the widening, supplied
   * by the dispatcher. It cannot be read off this handle: `ipc/chat.ts` pushes
   * the new mode through `setMode` on every runtime owner before it
   * broadcasts, so by now `mode` is already the widened one.
   */
  reevaluatePendingApprovals(
    mode: ApprovalMode,
    previousMode?: ApprovalMode,
  ): Promise<void>;
  /** Invalidates prompt work owned by a cancelled turn without ending the session. */
  invalidatePending?(): void;
  dispose(): void;
}

interface RuleCacheEntry {
  rules: ApprovalRule[];
  expiresAt: number;
  revision: number;
  forcePrompt?: boolean;
}

/** `ask` < `auto` < `full-access`. Only used to check widening direction. */
const APPROVAL_MODE_RANK: Record<ApprovalMode, number> = {
  ask: 0,
  auto: 1,
  'full-access': 2,
};

function scopeForMatchedRule(
  matchedRule: ApprovalRule | undefined,
  rules: ApprovalRuleSets,
): ApprovalRuleScope | 'once' {
  if (!matchedRule) {
    return 'once';
  }
  if (rules.session.includes(matchedRule)) {
    return 'session';
  }
  if (rules.project.includes(matchedRule)) {
    return 'project';
  }
  if (rules.global.includes(matchedRule)) {
    return 'global';
  }
  return 'once';
}

/**
 * Creates a per-chat-session approval handle. Owns short-lived (5s TTL)
 * per-handle caches of the project/global rule tiers, evaluates checks
 * against the pure policy engine, bridges to the renderer on `'prompt'`
 * outcomes, persists scoped grants from prompt decisions, and emits one
 * `approval_decision` observability session event per decision.
 */
export function createApprovalSession(
  ctx: ApprovalSessionContext,
): ApprovalSessionHandle {
  const policyWorkspaceId = approvalPolicyWorkspaceId(ctx);
  let mode = ctx.mode;
  let projectRulesCache: RuleCacheEntry | null = null;
  let globalRulesCache: RuleCacheEntry | null = null;
  let disposed = false;
  let promptGeneration = 0;
  /**
   * Prompts this handle currently has standing in the renderer, keyed by the
   * requestId `prompt-bridge` minted. Retains the **raw, pre-canonicalization**
   * check on purpose: `evaluateCheck` canonicalizes for itself, and re-doing it
   * is required rather than wasteful — `resolvedPath`/`protectedRoots` are live
   * filesystem reads and the disk may have changed while the card sat there.
   */
  const inFlightPrompts = new Map<
    string,
    {
      check: ApprovalCheck;
      display: ApprovalCheckDisplay;
      generation: number;
      cancellation: ApprovalCheckCancellation;
    }
  >();
  /**
   * Request ids a mode widening settled from main. A **suppression token**,
   * nothing more.
   *
   * The widening's claim loop records the `approval_decision` itself, because
   * it is the one point that knows the grant happened and has no early return
   * after it. Releasing through the bridge promise then wakes the awaiting
   * `promptForDecision`, which would otherwise run its own `recordDecision`
   * and emit a second, untagged event for the same grant. An id present here
   * tells that continuation to stay quiet.
   *
   * **Do not invert this.** Making the resuming path the recorder is the
   * obvious-looking symmetry and it is wrong: `promptForDecision`'s
   * `disposed || generation !== promptGeneration` guards return without
   * `recordDecision`, and one is reachable for a widened grant because the
   * `finally` above it awaits the durable turn-timer resume. Recording there
   * can drop the audit record for a privileged action already committed to
   * the transcript and announced to the renderer.
   *
   * A token must survive an arbitrary I/O window for that same reason, and a
   * concurrent re-evaluation that loses the compare-and-delete must not clear
   * one it did not add (`hadMark`). A token left behind by a continuation that
   * returned early is harmless: request ids are never reused, and `dispose()`
   * / `invalidatePending()` clear the set.
   */
  const modeWidenedRequestIds = new Set<string>();
  /**
   * Bumped by every widening that gets as far as re-evaluating. A check whose
   * policy read cleared under the *old* mode, and which was still inside
   * `setApprovalTurnTimerPaused`'s durable write when the widening landed, is
   * in neither the broadcast's view (not yet in `inFlightPrompts`) nor any
   * later re-evaluation's. Comparing this counter across that window is what
   * makes such a prompt visible.
   */
  let wideningGeneration = 0;
  /** Previous mode of the most recent widening, for the `onRegistered` fallback. */
  let lastWideningPreviousMode: ApprovalMode | undefined;
  /**
   * Prompts already counted in `approval_stale_deny_observed`. The dispatcher
   * and the `onRegistered` fallback can both re-evaluate the same standing
   * card, and this diagnostic is meant to be evidence of how often the hazard
   * arises — counting one card several times would inflate exactly the number
   * a decision about fixing it would rest on.
   */
  const staleDenyObservedRequestIds = new Set<string>();
  let canonicalWorkspaceRootPromise: Promise<string | undefined> | undefined;
  let canonicalProtectedRootsPromise: Promise<string[]> | undefined;
  let canonicalProtectedFileWritePathsPromise: Promise<string[]> | undefined;
  let pathCaseInsensitivePromise: Promise<boolean> | undefined;

  function resolveExistingAncestorPath(
    inputPath: string,
    basePath = ctx.workspaceRoot,
  ): Promise<string | undefined> {
    return resolveExistingAncestorPathFrom(inputPath, basePath);
  }

  function canonicalWorkspaceRoot(): Promise<string | undefined> {
    canonicalWorkspaceRootPromise ??= resolveExistingAncestorPath(
      ctx.workspaceRoot,
    );
    return canonicalWorkspaceRootPromise;
  }

  function canonicalProtectedRoots(): Promise<string[]> {
    canonicalProtectedRootsPromise ??= Promise.all([
      realpath(parse(resolve(ctx.workspaceRoot)).root).catch(() => undefined),
      realpath(homedir()).catch(() => undefined),
    ]).then((roots) =>
      Array.from(
        new Set(roots.filter((root): root is string => root !== undefined)),
      ),
    );
    return canonicalProtectedRootsPromise;
  }

  function canonicalProtectedFileWritePaths(): Promise<string[]> {
    canonicalProtectedFileWritePathsPromise ??= protectedApprovalFileWritePaths(
      policyWorkspaceId,
      ctx.workspaceRoot,
    );
    return canonicalProtectedFileWritePathsPromise;
  }

  function pathCaseInsensitive(): Promise<boolean> {
    pathCaseInsensitivePromise ??= canonicalWorkspaceRoot().then(
      isPathCaseInsensitiveAt,
    );
    return pathCaseInsensitivePromise;
  }

  async function canonicalizeCheck(approvalCheck: ApprovalCheck): Promise<{
    check: ApprovalCheck;
    workspaceRoot?: string;
    pathCaseInsensitive?: boolean;
  }> {
    if (approvalCheck.kind === 'command') {
      const caseInsensitive = await pathCaseInsensitive();
      const platformCheck: ApprovalCheck = {
        ...approvalCheck,
        shellPlatform: process.platform === 'win32' ? 'windows' : 'posix',
      };
      const pathOperations = commandPathOperations(approvalCheck.command);
      const destructiveOperations = recursiveForcedRemoveOperations(
        approvalCheck.command,
      );
      const operations = [...pathOperations, ...destructiveOperations];
      if (operations.length === 0) {
        return {
          check: platformCheck,
          workspaceRoot: ctx.workspaceRoot,
          pathCaseInsensitive: caseInsensitive,
        };
      }
      const initialCwd = approvalCheck.cwd ?? ctx.workspaceRoot;
      const operandPaths: string[] = [];
      let cwdResolutionFailed = false;
      for (const operation of operations) {
        let effectiveCwd = initialCwd;
        for (const cwdChange of operation.cwdChanges) {
          const nextCwd = await resolveExistingAncestorPath(
            cwdChange,
            effectiveCwd,
          );
          if (!nextCwd) {
            cwdResolutionFailed = true;
            break;
          }
          effectiveCwd = nextCwd;
        }
        cwdResolutionFailed ||= operation.cwdResolutionFailed;
        for (const operand of operation.operands) {
          const expandedOperand = expandDestructiveOperandTilde(
            operand,
            effectiveCwd,
          );
          if (expandedOperand === undefined) {
            cwdResolutionFailed = true;
            continue;
          }
          operandPaths.push(resolve(effectiveCwd, expandedOperand));
        }
      }
      const [resolvedPaths, protectedRoots] = await Promise.all([
        Promise.all(
          operandPaths.map((operand) => resolveExistingAncestorPath(operand)),
        ),
        destructiveOperations.length > 0
          ? canonicalProtectedRoots()
          : Promise.resolve([]),
      ]);
      const pathResolutionFailed =
        cwdResolutionFailed ||
        destructiveOperations.some(
          (operation) => operation.pathResolutionFailed,
        ) ||
        resolvedPaths.some((path) => path === undefined);
      return {
        check: {
          ...platformCheck,
          resolvedPaths: resolvedPaths.filter(
            (path): path is string => path !== undefined,
          ),
          protectedRoots,
          ...(pathResolutionFailed ? { pathResolutionFailed: true } : {}),
        },
        workspaceRoot: ctx.workspaceRoot,
        pathCaseInsensitive: caseInsensitive,
      };
    }
    if (approvalCheck.kind === 'browser-upload') {
      // Upload paths keep the case they were asked for, so rules need the drive's.
      return {
        check: approvalCheck,
        workspaceRoot: ctx.workspaceRoot,
        pathCaseInsensitive: await pathCaseInsensitive(),
      };
    }
    if (approvalCheck.kind === 'tool') {
      // Only this branch may set `resolvedReadPath`; drop a caller's copy so
      // Auto never trusts a canonical path main did not resolve.
      const { toolName, readPath } = approvalCheck;
      if (readPath === undefined) {
        return {
          check: { kind: 'tool', toolName },
          workspaceRoot: ctx.workspaceRoot,
        };
      }
      // A dangling or unreadable link leaves `resolvedReadPath` unset, so Auto
      // has no canonical target and the read prompts.
      const [resolvedReadPath, workspaceRoot, caseInsensitive] =
        await Promise.all([
          resolveExistingAncestorPath(readPath),
          canonicalWorkspaceRoot(),
          pathCaseInsensitive(),
        ]);
      return {
        check: {
          kind: 'tool',
          toolName,
          readPath,
          ...(resolvedReadPath ? { resolvedReadPath } : {}),
        },
        ...(resolvedReadPath && workspaceRoot
          ? { workspaceRoot, pathCaseInsensitive: caseInsensitive }
          : {}),
      };
    }
    if (approvalCheck.kind !== 'file-write') {
      return { check: approvalCheck, workspaceRoot: ctx.workspaceRoot };
    }
    const [resolvedPath, workspaceRoot, caseInsensitive] = await Promise.all([
      resolveExistingAncestorPath(approvalCheck.path),
      canonicalWorkspaceRoot(),
      pathCaseInsensitive(),
    ]);
    return {
      check: resolvedPath ? { ...approvalCheck, resolvedPath } : approvalCheck,
      ...(resolvedPath && workspaceRoot ? { workspaceRoot } : {}),
      ...(resolvedPath && workspaceRoot
        ? { pathCaseInsensitive: caseInsensitive }
        : {}),
    };
  }

  async function loadProjectRules(): Promise<RuleCacheEntry> {
    for (;;) {
      const now = Date.now();
      const revision = getWorkspaceApprovalRulesRevision(policyWorkspaceId);
      if (
        projectRulesCache &&
        projectRulesCache.expiresAt > now &&
        projectRulesCache.revision === revision &&
        isWorkspaceApprovalRulesSettled(policyWorkspaceId)
      ) {
        return projectRulesCache;
      }
      const tier = await readWorkspaceApprovalRuleTier(policyWorkspaceId);
      if (getWorkspaceApprovalRulesRevision(policyWorkspaceId) !== revision) {
        continue;
      }
      const entry: RuleCacheEntry = {
        rules: tier.rules,
        expiresAt: tier.unreadable ? now : now + RULES_CACHE_TTL_MS,
        revision,
        ...(tier.unreadable ? { forcePrompt: true } : {}),
      };
      if (!tier.unreadable) {
        projectRulesCache = entry;
      }
      return entry;
    }
  }

  async function loadGlobalRules(): Promise<RuleCacheEntry> {
    for (;;) {
      const now = Date.now();
      const revision = getGlobalApprovalRulesRevision();
      if (
        globalRulesCache &&
        globalRulesCache.expiresAt > now &&
        globalRulesCache.revision === revision &&
        isGlobalApprovalRulesSettled()
      ) {
        return globalRulesCache;
      }
      const tier = await readGlobalApprovalRuleTier();
      if (getGlobalApprovalRulesRevision() !== revision) {
        continue;
      }
      const entry: RuleCacheEntry = {
        rules: tier.rules,
        expiresAt: tier.unreadable ? now : now + RULES_CACHE_TTL_MS,
        revision,
        ...(tier.unreadable ? { forcePrompt: true } : {}),
      };
      if (!tier.unreadable) {
        globalRulesCache = entry;
      }
      return entry;
    }
  }

  function recordDecision(options: {
    decision: 'allow' | 'deny';
    scope: ApprovalRuleScope | 'once';
    targetKind: ApprovalCheck['kind'];
    /** Omitted for an ordinary engine/prompt decision; see the field's doc. */
    source?: 'prompt' | 'mode-widened' | 'safety-rule';
  }): void {
    getObservabilityService().recordSessionDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'approval_decision',
      sessionKey: ctx.sessionKey,
      projectId: ctx.projectId,
      worktreeId: ctx.worktreeId,
      chatId: ctx.chatId,
      providerType: ctx.provider,
      decision: options.decision,
      scope: options.scope,
      targetKind: options.targetKind,
      ...(options.source !== undefined
        ? { approvalDecisionSource: options.source }
        : {}),
    });
  }

  async function setApprovalTurnTimerPaused(
    paused: boolean,
    transitionId: string,
  ): Promise<boolean> {
    if (ctx.trackChatTurn === false) return false;
    // Defer the main-owned chat-state graph until an approval actually pauses
    // a turn; provider sessions otherwise do not need this heavy local module.
    const { getChatStateService } =
      await import('../services/chat-state-service');
    const changedAt = Date.now();
    const result = await getChatStateService().updateCompatibilityTab(
      { projectId: ctx.projectId, worktreeId: ctx.worktreeId },
      ctx.chatId,
      (tab, runtime) => {
        const messages = paused
          ? pauseOpenTurnTimer(tab.messages, changedAt, transitionId)
          : releaseTurnTimerPause(
              tab.messages,
              runtime,
              transitionId,
              changedAt,
            );
        return messages === tab.messages ? null : { ...tab, messages };
      },
      `approval-turn-timer-${paused ? 'pause' : 'resume'}:${transitionId}`,
    );
    return result.updated;
  }

  async function commitApprovalTurnPause(
    type: 'PauseOpened' | 'PauseClosed',
    ownerId: string,
  ): Promise<void> {
    if (ctx.trackChatTurn === false) return;
    const { getChatStateService } =
      await import('../services/chat-state-service');
    await getChatStateService().commitTurnPause({
      projectId: ctx.projectId,
      worktreeId: ctx.worktreeId,
      chatId: ctx.chatId,
      type,
      ownerKind: 'approval',
      ownerId,
    });
  }

  /**
   * Saves a remembered decision. Resolves true only once the save is durable,
   * so no reader in this process applies the rule before then. Once started,
   * a save is kept whatever happens to the check that asked for it: a Stop
   * withdraws the action, never the saved rule (CAN-4469 D-release).
   */
  async function persistScopedRule(
    scope: ApprovalRuleScope,
    rule: ApprovalRule,
  ): Promise<boolean> {
    if (scope === 'session') {
      // Defer the main-owned chat-state graph until a session rule is persisted;
      // most approval checks complete without loading this heavy local module.
      const { getChatStateService } =
        await import('../services/chat-state-service');
      const persisted = await getChatStateService().updateCompatibilityTab(
        { projectId: ctx.projectId, worktreeId: ctx.worktreeId },
        ctx.chatId,
        (tab) => ({
          ...tab,
          sessionApprovalRules: [...(tab.sessionApprovalRules ?? []), rule],
        }),
        `approval-session-rule:${rule.id}`,
        { metadataOnly: true },
      );
      if (!persisted.updated) {
        return false;
      }
      // A disposed handle's rules are never read again; the next session for
      // this chat is seeded from the tab, which now holds the rule.
      if (!disposed) {
        ctx.sessionRules.push(rule);
      }
      sendToWindow(ctx.getWindow(), IPC_CHANNELS.approvalRuleAdded, {
        projectId: ctx.projectId,
        worktreeId: ctx.worktreeId,
        chatId: ctx.chatId,
        rule,
      });
      return true;
    }
    if (scope === 'project') {
      await addWorkspaceApprovalRule(policyWorkspaceId, rule);
      projectRulesCache = null;
      return true;
    }
    await updatePreferencesFile((existing) => ({
      globalApprovalRules: [...existing.globalApprovalRules, rule],
    }));
    markGlobalApprovalRulesChanged();
    globalRulesCache = null;
    return true;
  }

  /**
   * Loads the current rule tiers (session rules are a live reference — no
   * caching needed there — project/global are TTL-cached) and evaluates the
   * check against them under the handle's current mode.
   */
  async function evaluateCheck(
    approvalCheck: ApprovalCheck,
    /**
     * Evaluates under this mode instead of the handle's current one. Used by
     * the pending re-evaluation path, which must *not* temporarily reassign
     * the `mode` closure variable: concurrent `check()` calls on this handle
     * would read the widened mode across the await and escalate for real.
     * Threading it explicitly keeps the widening scoped to one evaluation.
     */
    modeOverride?: ApprovalMode,
  ): Promise<{
    evaluation: ApprovalEvaluation;
    rules: ApprovalRuleSets;
    evaluatedMode: ApprovalMode;
  }> {
    let projectRules: RuleCacheEntry;
    let globalRules: RuleCacheEntry;
    let canonical: Awaited<ReturnType<typeof canonicalizeCheck>>;
    let protectedFileWritePaths: string[];
    for (;;) {
      [projectRules, globalRules, canonical, protectedFileWritePaths] =
        await Promise.all([
          loadProjectRules(),
          loadGlobalRules(),
          canonicalizeCheck(approvalCheck),
          canonicalProtectedFileWritePaths(),
        ]);
      if (
        projectRules.revision ===
          getWorkspaceApprovalRulesRevision(policyWorkspaceId) &&
        globalRules.revision === getGlobalApprovalRulesRevision()
      ) {
        break;
      }
    }
    const rules: ApprovalRuleSets = {
      session: ctx.sessionRules,
      project: projectRules.rules,
      global: globalRules.rules,
    };
    const canonicalizationFailed =
      canonical.check.kind === 'file-write' &&
      canonical.check.resolvedPath === undefined;
    const forcePrompt =
      projectRules.forcePrompt === true || globalRules.forcePrompt === true;
    const evaluationRules =
      canonicalizationFailed || forcePrompt
        ? {
            session: rules.session.filter((rule) => rule.behavior === 'deny'),
            project: rules.project.filter((rule) => rule.behavior === 'deny'),
            global: rules.global.filter((rule) => rule.behavior === 'deny'),
          }
        : rules;
    const evaluatedMode = forcePrompt ? 'ask' : (modeOverride ?? mode);
    return {
      evaluation: evaluateApproval(canonical.check, {
        mode: evaluatedMode,
        rules: evaluationRules,
        workspaceRoot: canonical.workspaceRoot,
        pathCaseInsensitive: canonical.pathCaseInsensitive,
        protectedFileWritePaths,
      }),
      rules,
      evaluatedMode,
    };
  }

  async function evaluateCheckFailClosed(
    approvalCheck: ApprovalCheck,
    modeOverride?: ApprovalMode,
  ): Promise<Awaited<ReturnType<typeof evaluateCheck>> | undefined> {
    try {
      return await evaluateCheck(approvalCheck, modeOverride);
    } catch {
      return undefined;
    }
  }

  /**
   * Bridges to the renderer for a decision, persists a scoped rule if the
   * user chose to remember it, and records the observability decision. Only
   * called once a check has been re-confirmed to actually need a prompt.
   */
  async function promptForDecision(
    approvalCheck: ApprovalCheck,
    display: ApprovalCheckDisplay,
    generation: number,
    wideningAtCheckStart: number,
    cancellation: ApprovalCheckCancellation,
  ): Promise<ApprovalOutcome> {
    cancellation.throwIfCancelled();
    if (disposed || generation !== promptGeneration) {
      return { decision: 'deny', message: FAIL_CLOSED_MESSAGE };
    }
    const timerTransitionId = `approval:${randomUUID()}`;
    let ownsTimerPause = false;
    let releaseFailed = false;
    let policyEnded: 'policy_denied' | 'revalidation_failed' | null = null;
    let promptDecision: ApprovalPromptDecision | undefined;
    let registeredRequestId: string | undefined;
    try {
      await commitApprovalTurnPause('PauseOpened', timerTransitionId);
      try {
        ownsTimerPause = await setApprovalTurnTimerPaused(
          true,
          timerTransitionId,
        );
      } catch {
        cancellation.throwIfCancelled();
        return { decision: 'deny', message: FAIL_CLOSED_MESSAGE };
      }
      // The durable timer mutation above yields to I/O. Cancellation may win
      // during that await before a prompt exists in the pending registry, so
      // re-check the generation before registering or delivering a stale card.
      cancellation.throwIfCancelled();
      if (disposed || generation !== promptGeneration) {
        return { decision: 'deny', message: FAIL_CLOSED_MESSAGE };
      }
      const bridged = await requestApprovalDecision({
        sessionKey: ctx.sessionKey,
        event: {
          ...(ctx.trackChatTurn === false ? { surface: 'non-chat' } : {}),
          projectId: ctx.projectId,
          worktreeId: ctx.worktreeId,
          chatId: ctx.chatId,
          provider: ctx.provider,
          title: display.title,
          ...(display.description !== undefined
            ? { description: display.description }
            : {}),
          details: display.details,
          ...(display.suggestedTarget !== undefined
            ? { suggestedTarget: display.suggestedTarget }
            : {}),
          ...(display.toolUseId !== undefined
            ? { toolUseId: display.toolUseId }
            : {}),
          ...(display.subagentId !== undefined
            ? { subagentId: display.subagentId }
            : {}),
          timerPauseOwnerId: timerTransitionId,
        },
        getWindow: ctx.getWindow,
        onRegistered: (requestId: string): void => {
          registeredRequestId = requestId;
          inFlightPrompts.set(requestId, {
            check: approvalCheck,
            display,
            generation,
            cancellation,
          });
          cancellation.registerRequestId(requestId);
          if (cancellation.isCancelled()) {
            return;
          }
          // A widening that landed between this check's policy read and this
          // line saw an empty (or short) `inFlightPrompts` and moved on, so
          // this card would sit on screen asking about something the current
          // mode no longer prompts for — the very bug CAN-3083 fixes. Now that
          // the prompt *is* registered, re-run the widening against it.
          // Deferred to a microtask so registration completes first, and
          // intentionally not awaited: `promptForDecision` must stay parked on
          // the bridge promise that this re-evaluation may settle.
          //
          // Deliberately not gated on `ipc/chat.ts`'s transition-currency
          // check. `mode` is read when the microtask runs, so it is already
          // the handle's latest mode, and `reevaluatePendingApprovals` clamps
          // against the live authority registry three times — the last with no
          // `await` after it. A superseded widening therefore cannot release
          // more than live authority allows; the worst case is that it, rather
          // than a newer one, is the call that wins the compare-and-delete and
          // names the mode in the receipt. Reaching across into the IPC layer's
          // transition state to settle that ordering would couple this handle
          // to its dispatcher for no safety gain.
          if (wideningGeneration !== wideningAtCheckStart) {
            queueMicrotask(() => {
              void reevaluatePendingApprovals(mode, lastWideningPreviousMode);
            });
          }
        },
        ...(ctx.onAwaitingUser !== undefined ||
        display.onAwaitingUser !== undefined
          ? {
              onAwaitingUser: (): void => {
                try {
                  ctx.onAwaitingUser?.();
                } catch {
                  // Status callbacks must not break prompt delivery.
                }
                try {
                  display.onAwaitingUser?.();
                } catch {
                  // Check callbacks must not break prompt delivery.
                }
              },
            }
          : {}),
        ...(ctx.promptTimeoutMs !== undefined
          ? { timeoutMs: ctx.promptTimeoutMs }
          : {}),
        revalidate: async () => {
          if (disposed || generation !== promptGeneration) return 'failed';
          const evaluated = await evaluateCheckFailClosed(approvalCheck);
          if (!evaluated || disposed || generation !== promptGeneration) {
            return 'failed';
          }
          return evaluated.evaluation.outcome;
        },
      });
      cancellation.throwIfCancelled();
      cancellation.accept();
      if (bridged.kind === 'decision') promptDecision = bridged.decision;
      else policyEnded = bridged.kind;
    } catch {
      cancellation.throwIfCancelled();
      recordDecision({
        decision: 'deny',
        scope: 'once',
        targetKind: approvalCheck.kind,
      });
      return { decision: 'deny', message: FAIL_CLOSED_MESSAGE };
    } finally {
      if (registeredRequestId !== undefined) {
        inFlightPrompts.delete(registeredRequestId);
      } else {
        // Never registered (the bridge threw before `onRegistered`). Identity
        // sweep is the only key available; it is safe here precisely because
        // nothing was registered for this check.
        for (const [requestId, entry] of Array.from(inFlightPrompts)) {
          if (
            entry.check === approvalCheck &&
            entry.generation === generation
          ) {
            inFlightPrompts.delete(requestId);
          }
        }
      }
      try {
        if (ownsTimerPause) {
          await setApprovalTurnTimerPaused(false, timerTransitionId);
        }
      } catch {
        releaseFailed = true;
      }
      try {
        // Always release the canonical owner, even if the legacy row did not
        // change, initialization failed, or the bridge never published a card.
        await commitApprovalTurnPause('PauseClosed', timerTransitionId);
      } catch {
        releaseFailed = true;
      }
    }

    if (policyEnded !== null) {
      recordDecision({
        decision: 'deny',
        scope: 'once',
        targetKind: approvalCheck.kind,
      });
      return {
        decision: 'deny',
        message:
          policyEnded === 'policy_denied'
            ? POLICY_DENIED_FALLBACK_MESSAGE
            : FAIL_CLOSED_MESSAGE,
      };
    }

    if (releaseFailed || !isApprovalPromptDecision(promptDecision)) {
      recordDecision({
        decision: 'deny',
        scope: 'once',
        targetKind: approvalCheck.kind,
      });
      return { decision: 'deny', message: FAIL_CLOSED_MESSAGE };
    }

    // The provider request may have been cancelled while the renderer response
    // was being delivered. Never let a stale decision persist authority after
    // its owning session has been disposed.
    if (disposed || generation !== promptGeneration) {
      return { decision: 'deny', message: FAIL_CLOSED_MESSAGE };
    }

    if (promptDecision.scope !== 'once' && promptDecision.target) {
      const rule: ApprovalRule = {
        id: randomUUID(),
        behavior: promptDecision.behavior,
        target: promptDecision.target,
        createdAt: new Date().toISOString(),
        origin: 'prompt',
      };
      let persisted = false;
      try {
        persisted = await persistScopedRule(promptDecision.scope, rule);
      } catch {
        // Saving a rule cannot grant execution. A current Deny click still
        // belongs to the user even when its durable rule could not be saved.
      }
      // Stop during the save: the rule stays saved and this action never runs.
      if (disposed || generation !== promptGeneration) {
        return { decision: 'deny', message: FAIL_CLOSED_MESSAGE };
      }
      if (!persisted) {
        // No rule exists, so the decision resolved for this check only.
        recordDecision({
          decision: 'deny',
          scope: 'once',
          targetKind: approvalCheck.kind,
        });
        return {
          decision: 'deny',
          message:
            promptDecision.behavior === 'deny'
              ? userDeniedMessage(promptDecision.message)
              : FAIL_CLOSED_MESSAGE,
          ...(promptDecision.behavior === 'deny' &&
          promptDecision.stopTurn !== undefined
            ? { stopTurn: promptDecision.stopTurn }
            : {}),
        };
      }
    }

    // A mode widening settles the bridge promise itself and records the
    // decision at the moment of the grant, leaving a mark here. Recording
    // again would emit a second, untagged `approval_decision` for one grant,
    // conflating a policy-driven auto-approval with the user clicking "Allow
    // once" — exactly the distinction `approvalDecisionSource` exists to draw.
    // A mark left behind by a continuation that returned early is harmless:
    // request ids are minted per prompt and never reused, and `dispose()` /
    // `invalidatePending()` clear the set.
    const releasedByWidening =
      registeredRequestId !== undefined &&
      modeWidenedRequestIds.delete(registeredRequestId);
    if (!releasedByWidening) {
      recordDecision({
        decision: promptDecision.behavior,
        scope: promptDecision.scope,
        targetKind: approvalCheck.kind,
      });
    }

    return {
      decision: promptDecision.behavior,
      ...(promptDecision.behavior === 'deny'
        ? { message: userDeniedMessage(promptDecision.message) }
        : promptDecision.message !== undefined
          ? { message: promptDecision.message }
          : {}),
      ...(promptDecision.stopTurn !== undefined
        ? { stopTurn: promptDecision.stopTurn }
        : {}),
    };
  }

  // Serializes actual renderer prompts for this handle: "one approval prompt
  // at a time per chat; parallel tool calls queue." A check that resolves
  // via the engine (allow/deny) never touches this chain. A check that needs
  // a prompt appends itself here so its `requestApprovalDecision` call
  // only starts once every earlier-queued prompt has been answered.
  let promptChain: Promise<unknown> = Promise.resolve();

  function safetyReceiptIdentity(
    display: ApprovalCheckDisplay,
  ): SafetyReceiptIdentity {
    const turnUserMessageId = ctx.getTurnUserMessageId?.();
    // IDs are scoped to the originating turn and subagent, never command text.
    // Without a provider invocation ID cross-hook deduplication is impossible:
    // the one UUID is retained through this check's queued re-evaluation.
    const receiptId = display.toolUseId
      ? `approval-safety-${createHash('sha256')
          .update(
            JSON.stringify([
              ctx.projectId,
              ctx.worktreeId,
              ctx.chatId,
              turnUserMessageId ?? `${ctx.sessionKey}:${promptGeneration}`,
              display.subagentId ?? '',
              display.toolUseId,
            ]),
          )
          .digest('hex')}`
      : `approval-safety-${randomUUID()}`;
    return { receiptId, ...(turnUserMessageId ? { turnUserMessageId } : {}) };
  }

  async function denyEvaluation(
    approvalCheck: ApprovalCheck,
    display: ApprovalCheckDisplay,
    evaluated: Awaited<ReturnType<typeof evaluateCheck>>,
    identity: SafetyReceiptIdentity,
  ): Promise<ApprovalOutcome> {
    const { evaluation, rules, evaluatedMode } = evaluated;
    if (evaluation.outcome !== 'deny')
      return { decision: 'deny', message: FAIL_CLOSED_MESSAGE };
    recordDecision({
      decision: 'deny',
      scope: scopeForMatchedRule(evaluation.matchedRule, rules),
      targetKind: approvalCheck.kind,
      ...(evaluation.safety ? { source: 'safety-rule' } : {}),
    });
    if (!evaluation.safety) {
      const scope = scopeForMatchedRule(evaluation.matchedRule, rules);
      return {
        decision: 'deny',
        message:
          evaluation.matchedRule?.origin === 'canopy-json'
            ? savedRuleDeniedMessage('repository')
            : scope !== 'once'
              ? savedRuleDeniedMessage(scope)
              : POLICY_DENIED_FALLBACK_MESSAGE,
      };
    }

    const labels: Record<SafetyDenyReason, string> = {
      'force-push': 'force-push',
      'destructive-delete': 'destructive delete',
      'disk-write': 'disk write',
      'unverifiable-command': 'unverifiable command',
    };
    const parsedReason = safetyDenyReasonSchema.safeParse(
      evaluation.safetyReason,
    );
    const reason = parsedReason.success
      ? parsedReason.data
      : 'unverifiable-command';
    const message = safetyDeniedMessage(labels[reason]);
    if (ctx.trackChatTurn !== false) {
      try {
        if (
          approvalCheck.kind !== 'command' ||
          evaluatedMode === 'full-access'
        ) {
          throw new Error('Invalid safety denial metadata');
        }
        const redacted = redactSecrets(approvalCheck.command);
        const suffix = '\n[truncated]';
        const command =
          redacted.length <= SAFETY_DENIED_COMMAND_MAX_CHARS
            ? redacted
            : redacted.slice(
                0,
                SAFETY_DENIED_COMMAND_MAX_CHARS - suffix.length,
              ) + suffix;
        const timestamp = Date.now();
        const receipt: PersistedChatMessage = {
          id: identity.receiptId,
          role: 'system',
          timestamp,
          blocks: [
            approvalSafetyDeniedInfoSchema.parse({
              type: 'approval_safety_denied_info',
              ...identity,
              timestamp,
              reason,
              command,
              mode: evaluatedMode,
              ...(display.toolUseId ? { toolUseId: display.toolUseId } : {}),
              ...(display.subagentId ? { subagentId: display.subagentId } : {}),
            }),
          ],
        };
        const { getChatStateService } =
          await import('../services/chat-state-service');
        let alreadyCommitted = false;
        // Provider approval gates run outside chat-state transactions. Await
        // the existing canonical transaction; no detached work survives check().
        const result = await getChatStateService().updateCompatibilityTab(
          { projectId: ctx.projectId, worktreeId: ctx.worktreeId },
          ctx.chatId,
          (tab) => {
            alreadyCommitted = tab.messages.some(
              (entry) => entry.id === receipt.id,
            );
            return alreadyCommitted
              ? null
              : { ...tab, messages: [...tab.messages, receipt] };
          },
          `approval-safety-denied:${receipt.id}`,
        );
        // A replayed canonical mutation can skip the updater entirely. Its
        // returned, durably applied state still proves receipt delivery.
        const delivered =
          result.updated ||
          alreadyCommitted ||
          result.tabsFile.tabs.some(
            (tab) =>
              tab.id === ctx.chatId &&
              tab.messages.some((entry) => entry.id === receipt.id),
          );
        if (!delivered) throw new Error('Receipt destination unavailable');
      } catch {
        // Error objects can contain command text/paths. Log only structured
        // correlation, and always preserve the specific execution denial.
        logMainProcessWarn('approval_safety_denied_receipt_failed', {
          projectId: ctx.projectId,
          worktreeId: ctx.worktreeId,
          chatId: ctx.chatId,
          receiptId: identity.receiptId,
          reason,
        });
      }
    }
    return { decision: 'deny', message };
  }

  async function checkViaQueue(
    approvalCheck: ApprovalCheck,
    display: ApprovalCheckDisplay,
    generation: number,
    cancellation: ApprovalCheckCancellation,
    identity: SafetyReceiptIdentity,
  ): Promise<ApprovalOutcome> {
    cancellation.throwIfCancelled();
    if (disposed || generation !== promptGeneration) {
      return { decision: 'deny', message: FAIL_CLOSED_MESSAGE };
    }
    // Captured *before* the policy read below, so it spans the whole window in
    // which this check is invisible to a concurrent widening: the read itself,
    // and then `promptForDecision`'s durable timer write before registration.
    const wideningAtCheckStart = wideningGeneration;
    // Re-evaluate now that it's this check's turn: an earlier-queued prompt
    // may have persisted a rule (e.g. session-scope allow) that now covers
    // this check, in which case it is resolved without ever prompting.
    const evaluated = await evaluateCheckFailClosed(approvalCheck);
    cancellation.throwIfCancelled();
    if (!evaluated) {
      cancellation.accept();
      recordDecision({
        decision: 'deny',
        scope: 'once',
        targetKind: approvalCheck.kind,
      });
      return { decision: 'deny', message: FAIL_CLOSED_MESSAGE };
    }
    const { evaluation, rules } = evaluated;
    if (disposed || generation !== promptGeneration) {
      return { decision: 'deny', message: FAIL_CLOSED_MESSAGE };
    }

    if (evaluation.outcome === 'allow') {
      cancellation.accept();
      recordDecision({
        decision: 'allow',
        scope: scopeForMatchedRule(evaluation.matchedRule, rules),
        targetKind: approvalCheck.kind,
      });
      return { decision: 'allow' };
    }

    if (evaluation.outcome === 'deny') {
      cancellation.accept();
      return denyEvaluation(approvalCheck, display, evaluated, identity);
    }

    if (disposed || generation !== promptGeneration) {
      return { decision: 'deny', message: FAIL_CLOSED_MESSAGE };
    }
    return promptForDecision(
      approvalCheck,
      display,
      generation,
      wideningAtCheckStart,
      cancellation,
    );
  }

  async function check(
    approvalCheck: ApprovalCheck,
    display: ApprovalCheckDisplay,
  ): Promise<ApprovalOutcome> {
    const cancellation = createApprovalCheckCancellation(
      display.signal,
      (requestId) => {
        inFlightPrompts.delete(requestId);
        modeWidenedRequestIds.delete(requestId);
        staleDenyObservedRequestIds.delete(requestId);
      },
    );
    try {
      return await Promise.race([
        (async (): Promise<ApprovalOutcome> => {
          cancellation.throwIfCancelled();
          if (disposed) {
            return { decision: 'deny', message: FAIL_CLOSED_MESSAGE };
          }
          const generation = promptGeneration;
          const identity = safetyReceiptIdentity(display);
          const evaluated = await evaluateCheckFailClosed(approvalCheck);
          cancellation.throwIfCancelled();
          if (!evaluated) {
            cancellation.accept();
            recordDecision({
              decision: 'deny',
              scope: 'once',
              targetKind: approvalCheck.kind,
            });
            return { decision: 'deny', message: FAIL_CLOSED_MESSAGE };
          }
          const { evaluation, rules } = evaluated;
          if (disposed || generation !== promptGeneration) {
            return { decision: 'deny', message: FAIL_CLOSED_MESSAGE };
          }

          if (evaluation.outcome === 'allow') {
            cancellation.accept();
            recordDecision({
              decision: 'allow',
              scope: scopeForMatchedRule(evaluation.matchedRule, rules),
              targetKind: approvalCheck.kind,
            });
            return { decision: 'allow' };
          }

          if (evaluation.outcome === 'deny') {
            cancellation.accept();
            return denyEvaluation(approvalCheck, display, evaluated, identity);
          }

          // Only a check that needs a prompt joins this handle's queue.
          const queued = promptChain.then(() =>
            checkViaQueue(
              approvalCheck,
              display,
              generation,
              cancellation,
              identity,
            ),
          );
          promptChain = queued.catch(() => undefined);
          return queued;
        })(),
        cancellation.cancellation,
      ]);
    } finally {
      cancellation.dispose();
    }
  }

  /**
   * Appends the transcript record for one batch of mode-released approvals.
   *
   * An auto-approval is a privileged action taken without a click, so it is
   * recorded in the conversation itself rather than only in observability.
   * Returns the committed message, or `undefined` if nothing was written —
   * the caller treats that as "do not release anything".
   */
  async function commitApprovalResolutionMessage(args: {
    mode: ApprovalMode;
    previousMode: ApprovalMode | undefined;
    titles: string[];
  }): Promise<PersistedChatMessage | undefined> {
    const timestamp = Date.now();
    const message: PersistedChatMessage = {
      id: `msg-${randomUUID()}`,
      role: 'system',
      blocks: [
        {
          type: 'approval_resolution_info',
          timestamp,
          resolvedBy: 'mode-change',
          mode: args.mode,
          ...(args.previousMode !== undefined
            ? { previousMode: args.previousMode }
            : {}),
          titles: args.titles,
        },
      ],
      timestamp,
    };
    // Defer the main-owned chat-state graph until an approval actually
    // resolves, matching the two other deferred loads in this file: pulling
    // it in at module scope would drag the whole chat-state service into
    // every session that never records a resolution.
    const { getChatStateService } =
      await import('../services/chat-state-service');
    const result = await getChatStateService().updateCompatibilityTab(
      { projectId: ctx.projectId, worktreeId: ctx.worktreeId },
      ctx.chatId,
      (tab) => ({ ...tab, messages: [...tab.messages, message] }),
      `approval-resolution:${message.id}`,
    );
    return result.updated ? message : undefined;
  }

  /**
   * Reconciles an already-committed resolution receipt with the set of
   * prompts that actually released.
   *
   * The commit deliberately precedes the grant (an unrecorded privileged
   * action is the exact failure this change exists to prevent), so the title
   * list written there is necessarily *speculative*: a prompt the user
   * answered, or that was cancelled, during the commit's durable write still
   * has its title in the receipt, while `resolveApprovalFromMain` then
   * declines to settle it. Left alone that leaves a permanent
   * "Approved by switching to <mode>" naming a request the user actually
   * denied — over-reporting an approval in the one subsystem whose job is an
   * honest record of privileged actions.
   *
   * Rewrites the block's `titles` to what really released, or drops the
   * message entirely when nothing did. Returns the corrected message, or
   * `undefined` when the receipt was removed.
   */
  async function reconcileApprovalResolutionMessage(
    committed: PersistedChatMessage,
    releasedTitles: string[],
  ): Promise<PersistedChatMessage | undefined> {
    const corrected: PersistedChatMessage | undefined =
      releasedTitles.length === 0
        ? undefined
        : {
            ...committed,
            blocks: committed.blocks.map((block) =>
              block.type === 'approval_resolution_info'
                ? { ...block, titles: releasedTitles }
                : block,
            ),
          };
    try {
      const { getChatStateService } =
        await import('../services/chat-state-service');
      await getChatStateService().updateCompatibilityTab(
        { projectId: ctx.projectId, worktreeId: ctx.worktreeId },
        ctx.chatId,
        (tab) => ({
          ...tab,
          messages: tab.messages.flatMap((existing) =>
            existing.id === committed.id
              ? corrected
                ? [corrected]
                : []
              : [existing],
          ),
        }),
        `approval-resolution-correction:${committed.id}`,
      );
    } catch {
      // Deliberately the same value as the success path: the caller's view of
      // "what this receipt now says" is what it asked for either way. Only the
      // durable write differs. The grant already happened and is already
      // recorded, so a failed correction leaves the receipt over-reporting
      // rather than under-reporting -- the safer direction to fail in -- and
      // the per-release observability record remains authoritative.
      return corrected;
    }
    return corrected;
  }

  /**
   * Re-runs the policy for the prompt(s) this handle currently has on screen
   * under a widened mode, and releases the ones the new mode would not have
   * asked about (CAN-3083).
   *
   * Three properties are load-bearing:
   *
   * - **It never decides against the user.** A widening re-evaluation can
   *   legitimately return `deny` (deny rules are mode-independent and run
   *   before every mode branch, so a rule added while the card sat there
   *   produces `deny` under any mode) and it can still return `prompt`. Both
   *   leave the card standing. A mode change may only ever *release* a
   *   pending prompt — auto-denying is irreversible, indistinguishable
   *   downstream from the user pressing Deny, and would kill the turn of a
   *   user who just widened permissions.
   * - **Resolution goes through the bridge promise**, not through some private
   *   outcome channel. Unwinding `requestApprovalDecision` is what releases
   *   the main-owned turn-timer pause, `observability.pauseChatTurn`, and the
   *   `approval:<requestId>` attention signal that drives the cloud push.
   * - **All async work happens before the map is touched**, then resolution is
   *   purely synchronous, so each entry stays a compare-and-delete token shared
   *   with the five other actors that can settle it. If the user clicked Allow
   *   first, `resolveApprovalFromMain` returns `false` and we skip — their
   *   explicit decision wins, which is the correct precedence.
   *
   * Never joins `promptChain`: the chain's current link *is* the
   * `promptForDecision` awaiting the prompt being resolved, so joining it
   * would deadlock.
   */
  async function reevaluatePendingApprovals(
    requestedMode: ApprovalMode,
    requestedPreviousMode?: ApprovalMode,
  ): Promise<void> {
    if (disposed) {
      return;
    }
    // Non-chat approval surfaces have no transcript to record the resolution
    // in, and are not reachable from a chat mode change anyway.
    if (ctx.trackChatTurn === false) {
      return;
    }
    // Bumped BEFORE the empty-map early return, not after. The window this
    // watermark exists to close is precisely the one where the map is still
    // empty: a check that has cleared its policy read but has not yet reached
    // `onRegistered`. Bumping only on the non-empty path would leave that case
    // — the original CAN-3083 report — undetectable.
    wideningGeneration++;
    // Stashed for the `onRegistered` fallback, which fires from a check that
    // was mid-registration and has no dispatcher value of its own. Only a real
    // dispatcher-supplied value is kept: `mode` is already the widened one by
    // now, so falling back to it would record "previous === current".
    if (requestedPreviousMode !== undefined) {
      lastWideningPreviousMode = requestedPreviousMode;
    }
    if (inFlightPrompts.size === 0) {
      return;
    }
    // A cancelled turn bumps `promptGeneration`. Anything that was on screen
    // when the widening arrived belongs to that turn, so if the generation
    // moves while we are awaiting the policy read, nothing here may be
    // released — the authority the user widened no longer has a turn to act on.
    const startGeneration = promptGeneration;
    // Prefer the dispatcher's value. The `mode` closure is only a fallback for
    // a direct caller that has not already applied the widening, because the
    // real dispatch path updates this handle through `setMode` first and would
    // otherwise always report "previous === current" (i.e. nothing at all).
    const previousMode = requestedPreviousMode ?? mode;
    // Second, independent read of the live authority registry at the instant
    // of the grant. The downgrade path publishes to that registry *first*, so
    // a restriction that landed during our awaits yields the tighter mode here
    // and the card correctly stays up.
    const effectiveMode =
      clampToLiveApprovalMode(
        ctx.projectId,
        ctx.worktreeId,
        ctx.chatId,
        requestedMode,
      ) ?? requestedMode;

    const candidates = Array.from(inFlightPrompts.entries());
    const releasable: Array<{
      requestId: string;
      check: ApprovalCheck;
      title: string;
      /** Rule tier that granted the allow, or `once` for a pure mode grant. */
      grantScope: ApprovalRuleScope | 'once';
    }> = [];
    for (const [requestId, entry] of candidates) {
      if (disposed || entry.generation !== promptGeneration) {
        continue;
      }
      const evaluated = await evaluateCheckFailClosed(
        entry.check,
        effectiveMode,
      );
      if (entry.cancellation.isCancelled()) {
        continue;
      }
      if (!evaluated) {
        continue;
      }
      if (evaluated.evaluation.outcome === 'deny') {
        // Pre-existing hazard, newly observable: the renderer's decision is
        // honoured without re-consulting rules, so a later click on Allow
        // would bypass this deny. Recorded, deliberately not acted on.
        if (staleDenyObservedRequestIds.has(requestId)) {
          continue;
        }
        staleDenyObservedRequestIds.add(requestId);
        getObservabilityService().recordSessionDiagnostic({
          version: 1,
          timestamp: new Date().toISOString(),
          kind: 'approval_stale_deny_observed',
          sessionKey: ctx.sessionKey,
          projectId: ctx.projectId,
          worktreeId: ctx.worktreeId,
          chatId: ctx.chatId,
          providerType: ctx.provider,
          targetKind: entry.check.kind,
          approvalStaleDenyRequestId: requestId,
        });
        continue;
      }
      if (evaluated.evaluation.outcome !== 'allow') {
        continue;
      }
      releasable.push({
        requestId,
        check: entry.check,
        title: entry.display.title,
        grantScope: scopeForMatchedRule(
          evaluated.evaluation.matchedRule,
          evaluated.rules,
        ),
      });
    }

    if (
      disposed ||
      promptGeneration !== startGeneration ||
      releasable.length === 0
    ) {
      return;
    }
    // Still standing after the awaits? Anything the user answered in the
    // meantime has already left the map.
    const stillPending = releasable.filter(({ requestId }) => {
      const entry = inFlightPrompts.get(requestId);
      return entry !== undefined && !entry.cancellation.isCancelled();
    });
    if (stillPending.length === 0) {
      return;
    }

    // Report the prior mode only when this really was a widening. The clamp
    // above can yield an `effectiveMode` narrower than the mode the chat was
    // in, and `previousMode: 'full-access'` beside `mode: 'ask'` would render
    // a widening receipt describing a narrowing.
    const reportablePreviousMode =
      previousMode !== effectiveMode &&
      APPROVAL_MODE_RANK[previousMode] < APPROVAL_MODE_RANK[effectiveMode]
        ? previousMode
        : undefined;

    // Commit first. An auto-approval that cannot be recorded is exactly the
    // unrecorded privileged action this change exists to prevent, so a failed
    // commit leaves every prompt standing and sends nothing. The title list is
    // therefore speculative by construction; `reconcileApprovalResolutionMessage`
    // below corrects it once we know what actually released.
    let resolutionMessage: PersistedChatMessage | undefined;
    try {
      resolutionMessage = await commitApprovalResolutionMessage({
        mode: effectiveMode,
        previousMode: reportablePreviousMode,
        titles: stillPending.map(({ title }) => title),
      });
    } catch {
      return;
    }
    if (
      !resolutionMessage ||
      disposed ||
      promptGeneration !== startGeneration
    ) {
      return;
    }

    // The receipt write yields to I/O; a request abort removes its own card
    // immediately, so only the remaining live prompts can be granted below.
    const claimable = stillPending.filter(({ requestId }) => {
      const entry = inFlightPrompts.get(requestId);
      return entry !== undefined && !entry.cancellation.isCancelled();
    });

    // Third and final read of the live authority registry, immediately before
    // the synchronous claim below and with no await after it. The downgrade
    // path publishes to that registry synchronously *before* entering its
    // queued operation, so a restriction that landed while the commit above
    // was writing would otherwise be invisible here — and these prompts would
    // be allowed under the wider mode while live authority had already
    // narrowed. Narrowing leaves every card standing; the speculative receipt
    // is withdrawn below.
    const liveModeAtGrant =
      clampToLiveApprovalMode(
        ctx.projectId,
        ctx.worktreeId,
        ctx.chatId,
        effectiveMode,
      ) ?? effectiveMode;

    const released: string[] = [];
    const releasedTitles: string[] = [];
    if (liveModeAtGrant === effectiveMode) {
      for (const { requestId, check, title, grantScope } of claimable) {
        const entry = inFlightPrompts.get(requestId);
        if (!entry || entry.cancellation.isCancelled()) {
          continue;
        }
        // Mark before settling: `resolveApprovalFromMain` settles the bridge
        // promise synchronously, so the resuming `promptForDecision` could
        // read this map at any point afterwards. It is NOT merely the next
        // microtask — that continuation first runs its `finally`, which awaits
        // the durable turn-timer resume — so the mark has to survive an
        // arbitrary I/O window, and a concurrent re-evaluation must not clear
        // one it did not create.
        //
        // `claimable` was rechecked after the receipt write, so a request
        // removed by a competing settlement cannot be claimed twice. Keep
        // mark ownership explicit as a defensive compare-and-delete guard:
        // when resolution loses to another actor, clear only a mark this
        // iteration added, never one already protecting that actor's grant.
        const hadMark = modeWidenedRequestIds.has(requestId);
        modeWidenedRequestIds.add(requestId);
        const resolved = resolveApprovalFromMain(requestId, ctx.sessionKey, {
          behavior: 'allow',
          // `once` deliberately: the widening already persisted the *mode*.
          // Minting a rule from a mode change would be a second, unrequested
          // durable grant the user never asked for.
          scope: 'once',
        });
        if (!resolved) {
          if (!hadMark) {
            modeWidenedRequestIds.delete(requestId);
          }
          continue;
        }
        entry.cancellation.accept();
        inFlightPrompts.delete(requestId);
        // Recorded HERE, not in the resuming continuation. This is the one
        // point that knows the grant actually happened, and it has no early
        // return after it. `promptForDecision`'s `disposed || generation !==
        // promptGeneration` guards return without recording, and one is
        // reachable for a widened grant precisely because the `finally` above
        // it awaits a durable write. Recording there could drop the audit
        // record for a privileged action already committed to the transcript
        // and announced to the renderer. `grantScope` names the tier that
        // actually granted the allow, which a rule landing while the card sat
        // there can own instead of the mode change.
        recordDecision({
          decision: 'allow',
          scope: grantScope,
          targetKind: check.kind,
          source: 'mode-widened',
        });
        released.push(requestId);
        releasedTitles.push(title);
      }
    }

    // Correct the speculative receipt whenever the claim set shrank — the user
    // answered a card during the commit, or live authority narrowed above.
    if (releasedTitles.length !== stillPending.length) {
      resolutionMessage = await reconcileApprovalResolutionMessage(
        resolutionMessage,
        releasedTitles,
      );
    }
    if (released.length === 0 || !resolutionMessage) {
      return;
    }

    for (const requestId of released) {
      sendToWindow(ctx.getWindow(), IPC_CHANNELS.approvalAutoResolved, {
        requestId,
        projectId: ctx.projectId,
        worktreeId: ctx.worktreeId,
        chatId: ctx.chatId,
        reason: 'mode-change',
        mode: effectiveMode,
        ...(reportablePreviousMode !== undefined
          ? { previousMode: reportablePreviousMode }
          : {}),
        resolutionMessage,
      });
    }
  }

  const unregisterSession = registerApprovalSession(
    ctx.projectId,
    ctx.worktreeId,
    ctx.chatId,
    { reevaluatePendingApprovals, check },
  );

  return {
    check,
    async evaluate(
      approvalCheck: ApprovalCheck,
    ): Promise<ApprovalEvaluation['outcome']> {
      if (disposed) return 'deny';
      const evaluated = await evaluateCheckFailClosed(approvalCheck);
      return disposed ? 'deny' : (evaluated?.evaluation.outcome ?? 'deny');
    },
    reevaluatePendingApprovals,
    setMode(newMode: ApprovalMode): void {
      mode = newMode;
    },
    policyContextKey(): string {
      return JSON.stringify([
        mode,
        getWorkspaceApprovalRulesRevision(policyWorkspaceId),
        getGlobalApprovalRulesRevision(),
        getWorkspaceApprovalRulesSaveGeneration(policyWorkspaceId),
        getGlobalApprovalRulesSaveGeneration(),
      ]);
    },
    fileWriteNarrowingInFlight(): boolean {
      return isFileWriteNarrowingInFlight(policyWorkspaceId);
    },
    invalidatePending(): void {
      promptGeneration++;
      modeWidenedRequestIds.clear();
      staleDenyObservedRequestIds.clear();
      lastWideningPreviousMode = undefined;
      rejectAllApprovalsForSession(ctx.sessionKey, 'turn_cancelled');
    },
    dispose(): void {
      disposed = true;
      unregisterSession();
      inFlightPrompts.clear();
      modeWidenedRequestIds.clear();
      staleDenyObservedRequestIds.clear();
      lastWideningPreviousMode = undefined;
      rejectAllApprovalsForSession(ctx.sessionKey);
    },
  };
}
