import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  getExecutionHarnessForModel,
  resolveProviderModelConfig,
  type AgentModelConfig,
  type ChatModel,
  type CodeReviewArtifact,
  type CodeReviewFile,
  type CodeReviewGenerationResult,
  type CodeReviewScopeRequest,
  type CodeReviewUpdatedEvent,
  type DataModelDiffDiagram,
  type LogicDiffDiagram,
  type ReviewAnnotationSet,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import {
  readCodeReviewState,
  reevaluateReviewAnchors,
  removeCodeReviewDiagramArtifact,
  setCodeReviewArmed,
  setCodeReviewArtifact,
  skippedCommentThreadsField,
} from './code-review-persistence';
import {
  buildReviewDiffBundle,
  computeReviewFingerprint,
  listReviewRepos,
  type ReviewRepoRef,
} from './code-review-diff';
import {
  generateReviewAnnotations,
  generateReviewDataModelDiff,
  generateReviewLogicDiff,
  sanitizeReviewAnnotations,
} from './code-review-generator';
import { getCodeReviewTargetSync } from './code-review-registry';
import { readPreferencesFile } from './preferences-store';
import { sendToAllWindows } from './window-send';
import {
  finalizeObservedHelperTask,
  startObservedHelperTask,
} from './helper-observed-task';
import { createHelperTranscriptObserver } from './helper-transcript-observer';
import {
  __testing as deletionFenceTesting,
  drainCodeReviewTasks,
  isCodeReviewScopeStopped,
  runCodeReviewTask,
} from './code-review-deletion-fence';

export const CODE_REVIEW_IDLE_DEBOUNCE_MS = 30_000;
export const CODE_REVIEW_POLL_INTERVAL_MS = 25_000;

/** Hint that the branch touches persistent data models (ERD gating). */
const DATA_MODEL_DIFF_HINT_PATTERN =
  /\b(schema\.prisma|migration|migrations|CREATE TABLE|ALTER TABLE|drizzle|sequelize|typeorm|foreign key|primary key)\b/i;

type GetWindow = () => BrowserWindow | null;

type ReviewDiagramKey = 'annotations' | 'logicDiff' | 'dataModelDiff';

interface WorktreeReviewState {
  projectId: string;
  worktreeId: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  activeTurns: number;
  pendingWhileTurnActive: boolean;
  inFlight: boolean;
  pendingRerun: boolean;
  /**
   * Attendedness of the call(s) that queued the pending rerun — NOT of the run
   * currently in flight. A user click and a background trigger can interleave
   * either way, so replaying the in-flight call's flag would both let a
   * background regeneration inherit permission to spend credits and downgrade a
   * user's explicit request to a silent no-op. Sticky-true across every call
   * that queues while in flight, mirroring `upgradeRefreshMode` in
   * `worktree-summary-scheduler.ts` (ECW-9091 review round 9).
   */
  pendingRerunUserInitiated: boolean;
  lastGeneratedFingerprint: string | null;
  consumers: Set<string>;
}

// Keyed by the REAL `projectId/worktreeId` pair. Turn hooks receive the
// composite scope key and resolve the real ids via the code-review registry
// before touching this map, so a worktree name reused across two workspaces
// never shares scheduler state.
const states = new Map<string, WorktreeReviewState>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function trackReviewTask(
  scope: CodeReviewScopeRequest,
  run: () => Promise<void>,
): Promise<void> {
  return runCodeReviewTask(scope, run, () => undefined);
}

/** Fence new work and await every writer before worktree-owned artifacts are removed. */
export async function drainCodeReviewForDeletion(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const key = stateKey(projectId, worktreeId);
  const state = states.get(key);
  if (state) {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = null;
    state.pendingRerun = false;
    state.pendingWhileTurnActive = false;
    state.consumers.clear();
  }
  stopPollIfIdle();
  await drainCodeReviewTasks(projectId, worktreeId);
  states.delete(key);
}

function stateKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

function createState(
  projectId: string,
  worktreeId: string,
): WorktreeReviewState {
  return {
    projectId,
    worktreeId,
    idleTimer: null,
    activeTurns: 0,
    pendingWhileTurnActive: false,
    inFlight: false,
    pendingRerun: false,
    pendingRerunUserInitiated: false,
    lastGeneratedFingerprint: null,
    consumers: new Set(),
  };
}

function getOrCreateState(
  projectId: string,
  worktreeId: string,
): WorktreeReviewState {
  const key = stateKey(projectId, worktreeId);
  let state = states.get(key);
  if (!state) {
    state = createState(projectId, worktreeId);
    states.set(key, state);
  }
  return state;
}

function emitReviewUpdated(
  scope: CodeReviewScopeRequest,
  review: CodeReviewFile | null,
  _getWindow: GetWindow,
  fingerprint: string,
): void {
  if (!review) {
    return;
  }
  const event: CodeReviewUpdatedEvent = {
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    fingerprint,
    review,
    ...skippedCommentThreadsField(scope.projectId, scope.worktreeId),
  };
  sendToAllWindows(IPC_CHANNELS.codeReviewUpdated, event);
}

export function armCodeReview(
  scope: CodeReviewScopeRequest,
  getWindow: GetWindow,
): Promise<CodeReviewGenerationResult> {
  return runCodeReviewTask(
    scope,
    () => armCodeReviewNow(scope, getWindow),
    () => ({ status: 'stopped' }),
  );
}

async function armCodeReviewNow(
  scope: CodeReviewScopeRequest,
  getWindow: GetWindow,
): Promise<CodeReviewGenerationResult> {
  const repos = await listReviewRepos(scope.projectId, scope.worktreeId);
  const [review, fingerprint] = await Promise.all([
    setCodeReviewArmed(scope.projectId, scope.worktreeId),
    computeReviewFingerprint(repos),
  ]);
  emitReviewUpdated(scope, review, getWindow, fingerprint);
  // The run pipeline owns freshness: it skips when all present artifacts are
  // already ready at the current fingerprint and marks artifacts 'generating'
  // when a real regeneration starts. Do not pre-mark anything stale here — a
  // re-arm with an unchanged fingerprint (or an empty diff, where the run
  // returns before any artifact runner executes) must leave existing ready
  // artifacts untouched.
  return runNow(scope, getWindow, true);
}

export async function requestManualCodeReviewRefresh(
  scope: CodeReviewScopeRequest,
  getWindow: GetWindow,
): Promise<CodeReviewGenerationResult> {
  const state = getOrCreateState(scope.projectId, scope.worktreeId);
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  state.pendingWhileTurnActive = false;
  return runCodeReviewTask(
    scope,
    () => runNow(scope, getWindow, true),
    () => ({ status: 'stopped' }),
  );
}

/**
 * Change signal fired on turn end / poll tick. No-op unless the review is
 * armed or the fingerprint has already moved past what was last generated.
 * Fire-and-forget: callers do not await scheduling decisions.
 */
export function noteWorktreeActivityForCodeReview(
  projectId: string,
  worktreeId: string,
  getWindow: GetWindow,
): void {
  void trackReviewTask({ projectId, worktreeId }, async () => {
    await checkActivityAndScheduleRun(projectId, worktreeId, getWindow);
  });
}

async function checkActivityAndScheduleRun(
  projectId: string,
  worktreeId: string,
  getWindow: GetWindow,
): Promise<void> {
  if (isCodeReviewScopeStopped(projectId, worktreeId)) return;
  const state = getOrCreateState(projectId, worktreeId);
  const file = await readCodeReviewState(projectId, worktreeId);
  if (!file.armed) {
    return;
  }
  const repos = await listReviewRepos(projectId, worktreeId);
  const fingerprint = await computeReviewFingerprint(repos);
  if (isCodeReviewScopeStopped(projectId, worktreeId)) return;
  if (fingerprint === state.lastGeneratedFingerprint) {
    return;
  }

  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
  }
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;
    if (state.activeTurns > 0) {
      state.pendingWhileTurnActive = true;
      return;
    }
    void trackReviewTask({ projectId, worktreeId }, async () => {
      await runNow({ projectId, worktreeId }, getWindow);
    });
  }, CODE_REVIEW_IDLE_DEBOUNCE_MS);
}

/**
 * Turn-start gate. `scopeKey` is the code-review sentinel scope's worktreeId
 * (the `projectId--worktreeId` composite); resolve the real ids via the
 * registry so scheduler state keys on the real worktree.
 */
export function noteCodeReviewTurnStart(scopeKey: string): void {
  const ref = getCodeReviewTargetSync(scopeKey);
  if (!ref) {
    return;
  }
  const state = getOrCreateState(ref.projectId, ref.worktreeId);
  state.activeTurns += 1;
}

export function noteCodeReviewTurnEnd(
  scopeKey: string,
  getWindow: GetWindow,
): void {
  const ref = getCodeReviewTargetSync(scopeKey);
  if (!ref) {
    return;
  }
  const state = getOrCreateState(ref.projectId, ref.worktreeId);
  state.activeTurns = Math.max(0, state.activeTurns - 1);
  if (state.activeTurns === 0 && state.pendingWhileTurnActive) {
    state.pendingWhileTurnActive = false;
    const scope = { projectId: ref.projectId, worktreeId: ref.worktreeId };
    void trackReviewTask(scope, async () => {
      await runNow(scope, getWindow);
    });
  }
}

export function setCodeReviewModalOpen(
  scope: CodeReviewScopeRequest,
  open: boolean,
  getWindow: GetWindow,
  consumerId = 'legacy',
): void {
  if (isCodeReviewScopeStopped(scope.projectId, scope.worktreeId)) return;
  const state = getOrCreateState(scope.projectId, scope.worktreeId);
  if (open) {
    state.consumers.add(consumerId);
    startPoll(getWindow);
  } else {
    state.consumers.delete(consumerId);
    stopPollIfIdle();
  }
}

function startPoll(getWindow: GetWindow): void {
  if (pollTimer) {
    return;
  }
  pollTimer = setInterval(() => {
    for (const state of Array.from(states.values())) {
      if (state.consumers.size > 0 && state.projectId) {
        noteWorktreeActivityForCodeReview(
          state.projectId,
          state.worktreeId,
          getWindow,
        );
      }
    }
  }, CODE_REVIEW_POLL_INTERVAL_MS);
  pollTimer.unref?.();
}

function stopPollIfIdle(): void {
  const anyOpen = Array.from(states.values()).some(
    (state) => state.consumers.size > 0,
  );
  if (!anyOpen && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function runNow(
  scope: CodeReviewScopeRequest,
  getWindow: GetWindow,
  userInitiated = false,
): Promise<CodeReviewGenerationResult> {
  if (isCodeReviewScopeStopped(scope.projectId, scope.worktreeId))
    return { status: 'stopped' };
  const state = getOrCreateState(scope.projectId, scope.worktreeId);
  if (state.inFlight) {
    state.pendingRerun = true;
    // Record THIS caller's intent, not the in-flight run's. Sticky-true so a
    // user request queued behind a background run is never downgraded.
    state.pendingRerunUserInitiated =
      state.pendingRerunUserInitiated || userInitiated;
    return { status: 'queued' };
  }
  state.inFlight = true;
  try {
    return await runCodeReviewGeneration(scope, getWindow, userInitiated);
  } finally {
    state.inFlight = false;
    if (state.pendingRerun) {
      state.pendingRerun = false;
      const queuedUserInitiated = state.pendingRerunUserInitiated;
      state.pendingRerunUserInitiated = false;
      void trackReviewTask(scope, async () => {
        await runNow(scope, getWindow, queuedUserInitiated);
      });
    }
  }
}

interface ReviewRunContext {
  scope: CodeReviewScopeRequest;
  fingerprint: string;
  model: ChatModel;
  modelConfig: AgentModelConfig;
  thinkingLevel: ThinkingLevel;
  repoPath: string;
  repos: ReviewRepoRef[];
  diffBundleText: string;
  getWindow: GetWindow;
  /**
   * True when the user explicitly armed or refreshed this review. Decides
   * whether an absent native login may spend AI Credits: the debounced
   * activity trigger must not, but an explicit arm/refresh must still work
   * rather than silently producing nothing (ECW-9091).
   */
  userInitiated: boolean;
}

/**
 * All three artifacts are always expected once the review is armed, except
 * `dataModelDiff`, which is conditional on the branch touching persistent
 * data models. Skip regeneration entirely when the always-generated
 * artifacts are already fresh for this fingerprint and the conditional one
 * is either fresh or legitimately absent.
 */
function allArtifactsFreshFor(
  file: CodeReviewFile,
  fingerprint: string,
): boolean {
  const annotationsFresh =
    file.annotations?.status === 'ready' &&
    file.annotations.derivedFromFingerprint === fingerprint;
  const logicDiffFresh =
    file.diagrams.logicDiff?.status === 'ready' &&
    file.diagrams.logicDiff.derivedFromFingerprint === fingerprint;
  const dataModelDiffFresh =
    file.diagrams.dataModelDiff === undefined ||
    (file.diagrams.dataModelDiff.status === 'ready' &&
      file.diagrams.dataModelDiff.derivedFromFingerprint === fingerprint);
  return annotationsFresh && logicDiffFresh && dataModelDiffFresh;
}

async function runCodeReviewGeneration(
  scope: CodeReviewScopeRequest,
  getWindow: GetWindow,
  userInitiated: boolean,
): Promise<CodeReviewGenerationResult> {
  const state = getOrCreateState(scope.projectId, scope.worktreeId);

  const repos = await listReviewRepos(scope.projectId, scope.worktreeId);
  const [fingerprint, file, preferences] = await Promise.all([
    computeReviewFingerprint(repos),
    readCodeReviewState(scope.projectId, scope.worktreeId),
    readPreferencesFile(),
  ]);

  if (allArtifactsFreshFor(file, fingerprint)) {
    state.lastGeneratedFingerprint = fingerprint;
    return { status: 'fresh' };
  }

  const bundle = await buildReviewDiffBundle(repos);
  if (bundle.text.length === 0) {
    // Nothing to review yet (no diff, no untracked files): leave existing
    // artifacts untouched rather than overwriting them with an error. Record
    // the fingerprint so an armed diff-free worktree settles instead of
    // recomputing the fingerprint and rebuilding the bundle on every poll
    // tick; any future change moves the fingerprint and re-triggers.
    state.lastGeneratedFingerprint = fingerprint;
    return { status: 'empty' };
  }

  const model = preferences.codeReviewModel;
  const thinkingLevel = preferences.codeReviewThinkingLevel;
  const executionHarness = getExecutionHarnessForModel(model);
  if (!executionHarness) {
    throw new Error(
      `No execution harness is available for review model "${model}".`,
    );
  }
  const modelConfig = resolveProviderModelConfig(
    executionHarness,
    { thinkingLevel },
    preferences.providerModelConfigDefaults,
  );
  // `listReviewRepos` always returns at least one entry (the worktree itself
  // for single-repo projects); the empty-string fallback only guards against
  // a theoretically-empty multi-repo workspace with no child or root repos.
  const firstRepo = repos[0];
  const repoPath = firstRepo ? firstRepo.repoPath : '';

  const shouldRunDataModel =
    Boolean(file.diagrams.dataModelDiff) ||
    DATA_MODEL_DIFF_HINT_PATTERN.test(bundle.text);

  const ctx: ReviewRunContext = {
    scope,
    fingerprint,
    model,
    modelConfig,
    thinkingLevel,
    repoPath,
    repos,
    diffBundleText: bundle.text,
    getWindow,
    userInitiated,
  };

  // Mark artifacts 'generating' up front, preserving prior data/fingerprint.
  // With no prior data the renderer shows a loading state; with prior data it
  // shows the existing content under an "updating" indicator (same contract
  // as plan-diagram-scheduler).
  await markArtifactsGenerating(ctx, file);

  const runs: Array<Promise<void>> = [
    runAnnotationsArtifact(ctx, file.annotations),
    runLogicDiffArtifact(ctx, file.diagrams.logicDiff),
  ];
  if (shouldRunDataModel) {
    runs.push(runDataModelArtifact(ctx, file.diagrams.dataModelDiff));
  }
  await Promise.allSettled(runs);

  state.lastGeneratedFingerprint = fingerprint;

  const reevaluated = await reevaluateReviewAnchors(
    scope.projectId,
    scope.worktreeId,
  );
  const finalReview =
    reevaluated ??
    (await readCodeReviewState(scope.projectId, scope.worktreeId));
  emitReviewUpdated(scope, finalReview, getWindow, fingerprint);
  const failedArtifacts = [
    finalReview.annotations,
    finalReview.diagrams.logicDiff,
    finalReview.diagrams.dataModelDiff,
  ].filter((artifact) => artifact?.status === 'error');
  if (failedArtifacts.length > 0) {
    return {
      status: 'error',
      error:
        failedArtifacts
          .map((artifact) => artifact?.error)
          .filter((message): message is string => Boolean(message))
          .join('\n') || 'Unable to generate diagrams.',
    };
  }
  return { status: 'generated' };
}

async function markArtifactsGenerating(
  ctx: ReviewRunContext,
  file: CodeReviewFile,
): Promise<void> {
  // Annotations and the logic diff are always generated for an armed review,
  // so mark them 'generating' unconditionally — a first-ever run gets a
  // visible loading state. The data-model diff is conditional by design
  // (absent means "not applicable to this branch"), so only mark it when a
  // prior artifact exists; a hint-triggered first run persists its result
  // directly without a placeholder that would strand a 'generating' entry if
  // the model returns applicable: false.
  await persistArtifact(
    ctx.scope,
    'annotations',
    buildGeneratingArtifact(ctx.fingerprint, file.annotations),
    ctx.getWindow,
    ctx.fingerprint,
  );
  await persistArtifact(
    ctx.scope,
    'logicDiff',
    buildGeneratingArtifact(ctx.fingerprint, file.diagrams.logicDiff),
    ctx.getWindow,
    ctx.fingerprint,
  );
  if (file.diagrams.dataModelDiff) {
    await persistArtifact(
      ctx.scope,
      'dataModelDiff',
      buildGeneratingArtifact(ctx.fingerprint, file.diagrams.dataModelDiff),
      ctx.getWindow,
      ctx.fingerprint,
    );
  }
}

function buildGeneratingArtifact<T>(
  fingerprint: string,
  previousArtifact: CodeReviewArtifact<T> | undefined,
): CodeReviewArtifact<T> {
  return {
    data: previousArtifact?.data ?? null,
    derivedFromFingerprint:
      previousArtifact?.derivedFromFingerprint ?? fingerprint,
    status: 'generating',
    ...(previousArtifact?.generatedAt
      ? { generatedAt: previousArtifact.generatedAt }
      : {}),
  };
}

function buildErrorArtifact<T>(
  fingerprint: string,
  previousArtifact: CodeReviewArtifact<T> | undefined,
  error: string,
): CodeReviewArtifact<T> {
  return {
    data: previousArtifact?.data ?? null,
    derivedFromFingerprint: fingerprint,
    status: 'error',
    error,
    ...(previousArtifact?.generatedAt
      ? { generatedAt: previousArtifact.generatedAt }
      : {}),
  };
}

async function persistArtifact(
  scope: CodeReviewScopeRequest,
  key: ReviewDiagramKey,
  artifact:
    | CodeReviewArtifact<ReviewAnnotationSet>
    | CodeReviewArtifact<LogicDiffDiagram>
    | CodeReviewArtifact<DataModelDiffDiagram>,
  getWindow: GetWindow,
  fingerprint: string,
): Promise<void> {
  const updated = await setCodeReviewArtifact(
    scope.projectId,
    scope.worktreeId,
    key,
    artifact,
  );
  emitReviewUpdated(scope, updated, getWindow, fingerprint);
}

async function runAnnotationsArtifact(
  ctx: ReviewRunContext,
  previousArtifact: CodeReviewArtifact<ReviewAnnotationSet> | undefined,
): Promise<void> {
  const {
    scope,
    fingerprint,
    model,
    modelConfig,
    thinkingLevel,
    repoPath,
    getWindow,
  } = ctx;
  const taskKey = `helper:code-review-annotations:${scope.projectId}/${scope.worktreeId}:${fingerprint}`;

  startObservedHelperTask({
    taskKey,
    eventType: 'code_review_annotations',
    label: 'Review Annotations',
    model,
    modelConfig,
    auditContext: {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
    },
  });

  try {
    const transcriptObserver = createHelperTranscriptObserver(taskKey);
    const { value, usage } = await generateReviewAnnotations({
      diffBundleText: ctx.diffBundleText,
      repoPath,
      projectId: scope.projectId,
      model,
      modelConfig,
      thinkingLevel,
      transcriptObserver,
      userInitiated: ctx.userInitiated,
    });

    if (value) {
      const sanitized = await sanitizeReviewAnnotations(value, ctx.repos);
      const ready: CodeReviewArtifact<ReviewAnnotationSet> = {
        data: sanitized,
        derivedFromFingerprint: fingerprint,
        status: 'ready',
        generatedAt: new Date().toISOString(),
      };
      await persistArtifact(
        scope,
        'annotations',
        ready,
        getWindow,
        fingerprint,
      );
      finalizeObservedHelperTask(taskKey, 'success', undefined, usage);
    } else {
      const message = 'Review annotation generation returned no result';
      await persistArtifact(
        scope,
        'annotations',
        buildErrorArtifact(fingerprint, previousArtifact, message),
        getWindow,
        fingerprint,
      );
      finalizeObservedHelperTask(taskKey, 'failure', message, usage);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistArtifact(
      scope,
      'annotations',
      buildErrorArtifact(fingerprint, previousArtifact, message),
      getWindow,
      fingerprint,
    );
    finalizeObservedHelperTask(taskKey, 'failure', message);
  }
}

async function runLogicDiffArtifact(
  ctx: ReviewRunContext,
  previousArtifact: CodeReviewArtifact<LogicDiffDiagram> | undefined,
): Promise<void> {
  const {
    scope,
    fingerprint,
    model,
    modelConfig,
    thinkingLevel,
    repoPath,
    getWindow,
  } = ctx;
  const taskKey = `helper:code-review-logic-diagram:${scope.projectId}/${scope.worktreeId}:${fingerprint}`;

  startObservedHelperTask({
    taskKey,
    eventType: 'code_review_diagram',
    label: 'Review Logic Diagram',
    model,
    modelConfig,
    auditContext: {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
    },
  });

  try {
    const transcriptObserver = createHelperTranscriptObserver(taskKey);
    const { value, usage } = await generateReviewLogicDiff({
      diffBundleText: ctx.diffBundleText,
      repoPath,
      projectId: scope.projectId,
      model,
      modelConfig,
      thinkingLevel,
      transcriptObserver,
      userInitiated: ctx.userInitiated,
    });

    if (value) {
      const ready: CodeReviewArtifact<LogicDiffDiagram> = {
        data: value,
        derivedFromFingerprint: fingerprint,
        status: 'ready',
        generatedAt: new Date().toISOString(),
      };
      await persistArtifact(scope, 'logicDiff', ready, getWindow, fingerprint);
      finalizeObservedHelperTask(taskKey, 'success', undefined, usage);
    } else {
      const message = 'Logic diagram generation returned no graph';
      await persistArtifact(
        scope,
        'logicDiff',
        buildErrorArtifact(fingerprint, previousArtifact, message),
        getWindow,
        fingerprint,
      );
      finalizeObservedHelperTask(taskKey, 'failure', message, usage);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistArtifact(
      scope,
      'logicDiff',
      buildErrorArtifact(fingerprint, previousArtifact, message),
      getWindow,
      fingerprint,
    );
    finalizeObservedHelperTask(taskKey, 'failure', message);
  }
}

async function runDataModelArtifact(
  ctx: ReviewRunContext,
  previousArtifact: CodeReviewArtifact<DataModelDiffDiagram> | undefined,
): Promise<void> {
  const {
    scope,
    fingerprint,
    model,
    modelConfig,
    thinkingLevel,
    repoPath,
    getWindow,
  } = ctx;
  const taskKey = `helper:code-review-data-model-diagram:${scope.projectId}/${scope.worktreeId}:${fingerprint}`;

  startObservedHelperTask({
    taskKey,
    eventType: 'code_review_diagram',
    label: 'Review Data Model Diagram',
    model,
    modelConfig,
    auditContext: {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
    },
  });

  try {
    const transcriptObserver = createHelperTranscriptObserver(taskKey);
    const { value, usage } = await generateReviewDataModelDiff({
      diffBundleText: ctx.diffBundleText,
      repoPath,
      projectId: scope.projectId,
      model,
      modelConfig,
      thinkingLevel,
      transcriptObserver,
      userInitiated: ctx.userInitiated,
    });

    if (value?.applicable === true && value.diagram) {
      const ready: CodeReviewArtifact<DataModelDiffDiagram> = {
        data: value.diagram,
        derivedFromFingerprint: fingerprint,
        status: 'ready',
        generatedAt: new Date().toISOString(),
      };
      await persistArtifact(
        scope,
        'dataModelDiff',
        ready,
        getWindow,
        fingerprint,
      );
      finalizeObservedHelperTask(taskKey, 'success', undefined, usage);
      return;
    }

    if (value?.applicable === false) {
      if (previousArtifact) {
        const updated = await removeCodeReviewDiagramArtifact(
          scope.projectId,
          scope.worktreeId,
          'dataModelDiff',
          fingerprint,
        );
        emitReviewUpdated(scope, updated, getWindow, fingerprint);
      }
      finalizeObservedHelperTask(taskKey, 'success', undefined, usage);
      return;
    }

    const message =
      value?.applicable === true
        ? 'Data model diagram generation returned no diagram'
        : 'Data model diagram generation returned no result';
    await persistArtifact(
      scope,
      'dataModelDiff',
      buildErrorArtifact(fingerprint, previousArtifact, message),
      getWindow,
      fingerprint,
    );
    finalizeObservedHelperTask(taskKey, 'failure', message, usage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistArtifact(
      scope,
      'dataModelDiff',
      buildErrorArtifact(fingerprint, previousArtifact, message),
      getWindow,
      fingerprint,
    );
    finalizeObservedHelperTask(taskKey, 'failure', message);
  }
}

export const __testing = {
  reset(): void {
    for (const state of Array.from(states.values())) {
      if (state.idleTimer) {
        clearTimeout(state.idleTimer);
      }
    }
    states.clear();
    deletionFenceTesting.reset();
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },
};
