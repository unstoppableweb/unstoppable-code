import type { BrowserWindow } from 'electron';
import type {
  SummaryGenerationResult,
  SummaryMode,
} from '@canopy/core-runtime/node/summary';
import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { WORKTREE_UNIT_LABEL } from '@canopy/protocol';
import {
  APP_ADVISOR_PROJECT_ID,
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_NAME,
  getExecutionHarnessForModel,
  getModelSource,
  requireProviderForModel,
  resolveProviderModelConfig,
  type ChatTabsFile,
  type PersistedChatBlock,
  type PersistedChatMessage,
  type PersistedChatTab,
  type WorktreeSummaryData,
  type WorktreeSummaryGeneratingEvent,
  type WorktreeSummaryProvenance,
  type WorktreeSummaryUpdatedEvent,
} from '@canopy/desktop-shared/types';
import { codexServiceTierForModelConfig } from '@canopy/execution-engine/lib/codex-model-config';
import {
  getComparisonDiff,
  getRemoteDefaultBranch,
  getUncommittedDiff,
} from './git';
import { readChatTabsFile } from './chat-tabs-reader';
import { resolveWorktreeCwd } from './resolve-worktree';
import {
  isCoworkWorkspace,
  isMultiRepoWorkspace,
  isWorkEntryWorkspace,
} from './workspace-registry';
import { readEffectiveWorkspaceConfig } from './workspace-source';
import {
  readWorktreeSummary,
  readWorktreeSummaryWriteAbortReason,
  writeWorktreeSummarySnapshot,
  type WorktreeSummaryWriteResult,
} from './worktree-summary-persistence';
import { getWorkspaceWorktreeRepoDir } from './paths';
import { isModelBlockedByStoredPolicy } from './model-policy-state';
import { resolveHelperWorkOwner } from '../ollama/helper-invocation';
import { isHelperNoBillingSourceError } from '../agents/helper-no-billing-source';
import { readPreferencesFile } from '../lib/preferences-store';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import type { HelperUsage } from '../agents/utils';
import { sendToAllWindows } from './window-send';
import { logMainProcessWarn } from './main-process-logging';
import { getActiveDesktopRuntimeIfAccepting } from '../canopy-runtime/desktop-runtime';
import { withResolvedHelperPlugins } from './helper-plugin-resolution';
import { buildStandaloneChatLinkTarget } from './standalone-link-target';
import {
  BACKGROUND_HELPER_PRIORITIES,
  enqueueBackgroundHelperTask,
} from './background-helper-queue';
import {
  isSummaryScopePublishable,
  reportAbortedSummaryWrite,
  reportDroppedSummarySnapshots,
  reportInvalidSummarySnapshots,
  reportReplacedSummaryFile,
  reportStrippedSummaryProvenance,
} from '../ledger/summary-publication';
import { publishPendingSummarySnapshots } from '../ledger/summary-reconciliation';
import type { WorktreeSummaryResult } from './worktree-summary-generator';
import {
  applyGeneratedDisplayLabel,
  readWorktreeDisplayLabelContext,
} from './worktree-display-label';

const NO_WINDOW = (): BrowserWindow | null => null;

export function isWorktreeSummaryGenerating(
  projectId: string,
  worktreeId: string,
): boolean {
  const runtime = getActiveDesktopRuntimeIfAccepting();
  return (
    runtime?.summarySchedule.isRunning({
      workspaceId: projectId,
      worktreeId,
    }) ?? false
  );
}

/**
 * The summary helper ships chat transcript excerpts and the branch diff to the
 * explicitly configured `worktreeSummaryModel`, so an organization model policy
 * applies here as it does to an interactive chat turn. There is no non-AI
 * summary to fall back to, so the run is refused: the previously persisted
 * summary is left untouched (exactly the existing generation-failure behavior)
 * and the refusal is recorded on the Audit Trail entry.
 */
const WORKTREE_SUMMARY_MODEL_POLICY_REFUSAL =
  'Summary generation was skipped: this model is blocked by your organization policy.';

const FULL_REFRESH_TURN_THRESHOLD = 10;
const INCREMENTAL_DIFF_MAX_CHARS = 30_000;
const FULL_DIFF_MAX_CHARS = 50_000;
const INCREMENTAL_CHAT_MAX_CHARS = 12_000;
const FULL_CHAT_MAX_CHARS = 20_000;

interface ChronologicalChatMessage {
  tab: PersistedChatTab;
  message: PersistedChatMessage;
  tabIndex: number;
  messageIndex: number;
}

export function scheduleSummaryGeneration(
  projectId: string,
  worktreeId: string,
  getWindow: () => BrowserWindow | null,
): void {
  void getWindow;
  const runtime = getActiveDesktopRuntimeIfAccepting();
  if (!runtime) {
    logMainProcessWarn(
      '[summary-schedule] The desktop core is not accepting requests; the summary was not scheduled.',
    );
    return;
  }
  const scheduled = runtime.summarySchedule.schedule({
    workspaceId: projectId,
    worktreeId,
  });
  void scheduled.catch((error: unknown) =>
    logMainProcessWarn('[summary-schedule] schedule failed', error),
  );
}

export function triggerManualRefresh(
  projectId: string,
  worktreeId: string,
  getWindow: () => BrowserWindow | null,
): void {
  void getWindow;
  const runtime = getActiveDesktopRuntimeIfAccepting();
  if (!runtime) {
    logMainProcessWarn(
      '[summary-schedule] The desktop core is not accepting requests; the summary was not scheduled.',
    );
    return;
  }
  void runtime.summarySchedule
    .refresh(
      { workspaceId: projectId, worktreeId },
      {
        kind: 'client',
        sourceId: 'local-desktop-user',
        context: { mode: 'full' },
      },
    )
    .catch((error: unknown) =>
      logMainProcessWarn('[summary-schedule] refresh failed', error),
    );
}

export function cancelScheduledGeneration(
  projectId: string,
  worktreeId: string,
): void {
  const runtime = getActiveDesktopRuntimeIfAccepting();
  void runtime?.summarySchedule
    .cancel({ workspaceId: projectId, worktreeId })
    .catch((error: unknown) =>
      logMainProcessWarn('[summary-schedule] cancel failed', error),
    );
}

/**
 * One worktree summary generation (CAN-4114). The core summary schedule owns
 * when it runs; this body is the pre-CAN-4114 runSummaryGeneration moved
 * verbatim apart from the substitutions in the CAN-4114 spec.
 */
export async function generateDesktopWorktreeSummary(
  projectId: string,
  worktreeId: string,
  mode: SummaryMode,
  signal: AbortSignal,
): Promise<SummaryGenerationResult> {
  let emittedGenerating = false;

  try {
    const preferences = await readPreferencesFile();
    if (!preferences.worktreeSummaryEnabled) {
      return { result: 'skipped' };
    }

    const chatTabs = await readChatTabsFile(projectId, worktreeId);
    const currentTurnCount = countUserTurns(chatTabs);
    if (currentTurnCount === 0) {
      return { result: 'skipped' };
    }

    // Skips the model call for a summary the write would discard.
    const abortReason = await readWorktreeSummaryWriteAbortReason(
      projectId,
      worktreeId,
    );
    if (abortReason !== null) {
      reportAbortedSummaryWrite({ projectId, worktreeId }, abortReason);
      return { result: 'skipped' };
    }

    const previousSummary = await readWorktreeSummary(projectId, worktreeId);
    const isFullRefresh =
      mode === 'full' ||
      previousSummary === null ||
      currentTurnCount - previousSummary.lastFullRefreshTurnCount >
        FULL_REFRESH_TURN_THRESHOLD;

    const chatExcerpts = await buildStoredChatExcerpts(
      projectId,
      worktreeId,
      chatTabs,
      isFullRefresh,
      previousSummary?.turnCountAtGeneration ?? 0,
    );

    emitGenerating(projectId, worktreeId, true, NO_WINDOW);
    emittedGenerating = true;

    const cwd = resolveWorktreeCwd(projectId, worktreeId);
    const diffLimit = isFullRefresh
      ? FULL_DIFF_MAX_CHARS
      : INCREMENTAL_DIFF_MAX_CHARS;
    const summaryInput = await buildSummaryDiffInput(
      projectId,
      worktreeId,
      cwd,
      diffLimit,
    );

    const displayLabelContext = await readWorktreeDisplayLabelContext(
      projectId,
      worktreeId,
    );

    const { generateWorktreeSummary } =
      await import('./worktree-summary-generator');
    const observability = getExecutionObservabilityIngest();
    const taskKey = `helper:worktree-summary:${projectId}/${worktreeId}:${Date.now()}`;
    const worktreeSummaryHarness = getExecutionHarnessForModel(
      preferences.worktreeSummaryModel,
    );
    if (!worktreeSummaryHarness) {
      throw new Error(
        `No execution harness is available for worktree summary model "${preferences.worktreeSummaryModel}".`,
      );
    }
    const worktreeSummaryModelConfig = resolveProviderModelConfig(
      worktreeSummaryHarness,
      { thinkingLevel: preferences.worktreeSummaryThinkingLevel },
      preferences.providerModelConfigDefaults,
    );
    const worktreeSummaryServiceTier =
      worktreeSummaryHarness === 'codex'
        ? codexServiceTierForModelConfig(worktreeSummaryModelConfig)
        : undefined;
    const activeChatTab = chatTabs.tabs.find(
      (tab) => tab.id === chatTabs.activeTabId && tab.kind !== 'file',
    );
    const coworkChatId =
      activeChatTab?.id ??
      chatTabs.tabs.find((tab) => tab.kind !== 'file')?.id ??
      chatTabs.activeTabId;
    const linkTarget =
      // Default Bot only: the summary destination is its singleton Orchestrator page.
      projectId === APP_ADVISOR_PROJECT_ID
        ? {
            page: 'main' as const,
            kind: 'app-advisor' as const,
            chatId: coworkChatId,
          }
        : isCoworkWorkspace(projectId)
          ? buildStandaloneChatLinkTarget(projectId, coworkChatId)
          : {
              page: 'main' as const,
              kind: 'worktree-chat' as const,
              projectId,
              worktreeId,
            };
    const startObservation = (): void =>
      observability.startObservedTask(taskKey, {
        id: taskKey,
        eventType: 'worktree_summary',
        status: 'running',
        provider: requireProviderForModel(preferences.worktreeSummaryModel),
        modelSource: getModelSource(preferences.worktreeSummaryModel),
        executionHarness: worktreeSummaryHarness,
        label: `${WORKTREE_UNIT_LABEL} Summary`,
        startedAt: new Date().toISOString(),
        model: preferences.worktreeSummaryModel,
        serviceTier: worktreeSummaryServiceTier,
        tokens: {
          input: 0,
          output: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
        },
        messageCount: 0,
        assistantMessageCount: 0,
        toolUseCount: 0,
        subAgentCount: 0,
        hasTranscript: false,
        toolCounts: {
          thinking: 0,
          bash: 0,
          read: 0,
          readLines: 0,
          writeEdit: 0,
          plan: 0,
          fileEdit: 0,
          fileAdd: 0,
          fileDelete: 0,
          search: 0,
          grep: 0,
          web: 0,
          agent: 0,
          workflow: 0,
          tasks: 0,
          taskStop: 0,
          skills: 0,
          monitor: 0,
          claude: 0,
          scheduleWakeup: 0,
          askUser: 0,
          scriptOutput: 0,
          watcher: 0,
          canopy: 0,
          graph: 0,
          appAdvisor: 0,
          pipelineEditor: 0,
          mcp: 0,
          other: 0,
        },
        projectId,
        worktreeId,
        linkTarget,
      });
    // Placed after `startObservation` is defined so the refusal is visible on
    // the Audit Trail, and before the helper is enqueued so no transcript or
    // diff content reaches a blocked model.
    const workOwner = await resolveHelperWorkOwner({ workspaceId: projectId });
    if (
      await isModelBlockedByStoredPolicy(
        preferences.worktreeSummaryModel,
        workOwner,
      )
    ) {
      startObservation();
      observability.finalizeObservedTask(
        taskKey,
        'failure',
        WORKTREE_SUMMARY_MODEL_POLICY_REFUSAL,
      );
      return { result: 'skipped' };
    }
    // A provider known (from caches) to be signed out with no billing source
    // would refuse the helper (CAN-7062). Skip before opening an audit entry,
    // so repeated runs add none; the stored summary stays as it was and the
    // next run after sign-in generates it.
    const { isHelperNoBillingSourceRefusalCached } =
      await import('../agents/no-billing-source-refusal');
    if (
      isHelperNoBillingSourceRefusalCached(
        { model: preferences.worktreeSummaryModel, projectId },
        requireProviderForModel(preferences.worktreeSummaryModel),
      )
    ) {
      return { result: 'skipped' };
    }

    // Captured before the provider is invoked (LD06), so a model or setting
    // change during generation cannot misattribute the snapshot.
    const provenance: WorktreeSummaryProvenance = {
      generationId: randomUUID(),
      harness: worktreeSummaryHarness,
      model: preferences.worktreeSummaryModel,
      thinkingEffort: preferences.worktreeSummaryThinkingLevel,
      observedTaskKey: taskKey,
      capturedAt: new Date().toISOString(),
      ...(isSummaryScopePublishable({ projectId, worktreeId })
        ? { ledgerPublishable: true }
        : {}),
    };

    let nextSummary: WorktreeSummaryData | null = null;
    let displayLabel: WorktreeSummaryResult['displayLabel'] = null;
    let summaryUsage: HelperUsage = {};
    try {
      const result = await enqueueBackgroundHelperTask({
        priority: BACKGROUND_HELPER_PRIORITIES.worktreeSummary,
        task: () => {
          if (signal.aborted) {
            return Promise.resolve(null);
          }
          startObservation();
          return withResolvedHelperPlugins(
            {
              projectId,
              worktreeId,
              helperName: 'worktree-summary',
              model: preferences.worktreeSummaryModel,
              selections: preferences.worktreeSummaryPluginSelections,
            },
            (pluginRuntime) =>
              generateWorktreeSummary({
                projectId,
                cwd,
                model: preferences.worktreeSummaryModel,
                thinkingLevel: preferences.worktreeSummaryThinkingLevel,
                modelConfig:
                  worktreeSummaryHarness === 'codex'
                    ? worktreeSummaryModelConfig
                    : undefined,
                isFullRefresh,
                // The ENTRY mode, not `isFullRefresh` — an automatic run gets
                // promoted to a full refresh on turn thresholds, so only the
                // requested mode says whether a user asked for this.
                userInitiated: mode === 'full',
                previousSummary,
                chatExcerpts,
                gitDiff: summaryInput.gitDiff,
                changeInputKind: summaryInput.changeInputKind,
                currentTurnCount,
                isMultiRepo: summaryInput.isMultiRepo,
                repoDiffs: summaryInput.repoDiffs,
                observabilityTaskKey: taskKey,
                pluginRuntime,
                ...(displayLabelContext.worktreeContext
                  ? { worktreeContext: displayLabelContext.worktreeContext }
                  : {}),
                ...(displayLabelContext.request
                  ? { displayLabelRequest: displayLabelContext.request }
                  : {}),
              }),
          );
        },
      });
      if (result === null) {
        return { result: 'cancelled' };
      }
      nextSummary = result.summary;
      displayLabel = result.displayLabel;
      summaryUsage = result.usage;
    } catch (error) {
      if (isHelperNoBillingSourceError(error)) {
        // Refused before any spawn on a cold auth cache (CAN-7062). The probe
        // that refused it warms the cache, so later runs skip above without
        // an audit entry. The stored summary is left untouched.
        observability.finalizeObservedTask(taskKey, 'cancelled', error.message);
        return { result: 'skipped' };
      }
      observability.finalizeObservedTask(
        taskKey,
        'failure',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    observability.finalizeObservedTask(
      taskKey,
      nextSummary ? 'success' : 'failure',
      nextSummary ? undefined : 'Summary generation returned no summary',
      summaryUsage,
    );

    if (signal.aborted) return { result: 'cancelled' };
    if (!nextSummary) return { result: 'skipped' };

    // The label is the sidebar's name for the work; a failed write leaves the
    // row as it was and must not cost the summary.
    await applyGeneratedDisplayLabel({
      projectId,
      worktreeId,
      candidate: displayLabel,
      evidence: [
        displayLabelContext.worktreeContext ?? '',
        chatExcerpts,
        summaryInput.gitDiff,
        ...(summaryInput.repoDiffs ?? []).map((repo) => repo.diff),
      ].join('\n'),
      observabilityTaskKey: taskKey,
    }).catch(() => undefined);

    const written = await writeWorktreeSummarySnapshot(
      projectId,
      worktreeId,
      nextSummary,
      provenance,
    );
    if (written === null) {
      return { result: 'skipped' };
    }
    if (written.kind === 'aborted') {
      reportAbortedSummaryWrite({ projectId, worktreeId }, written.reason);
      return { result: 'skipped' };
    }
    // The snapshot is in the journal now, so it publishes even if the run was
    // cancelled meanwhile, as startup reconciliation would publish it.
    publishWrittenSnapshot(projectId, worktreeId, written);
    if (signal.aborted) return { result: 'cancelled' };

    emitUpdated(projectId, worktreeId, nextSummary, NO_WINDOW);
    return {
      result: written.isNewSnapshot ? 'written' : 'unchanged',
      sourceRevision: `turns:${written.snapshot.summary.turnCountAtGeneration}`,
    };
  } finally {
    if (emittedGenerating) {
      emitGenerating(projectId, worktreeId, false, NO_WINDOW);
    }
  }
}

async function buildSummaryDiffInput(
  projectId: string,
  worktreeId: string,
  cwd: string,
  diffLimit: number,
): Promise<{
  gitDiff: string;
  changeInputKind: 'git-diff' | 'folder-activity';
  isMultiRepo: boolean;
  repoDiffs?: Array<{ name: string; diff: string }>;
}> {
  // Cowork workspaces are not git-backed: skip every git call and summarize
  // recent folder activity (mtime-ordered file listing) instead of a diff.
  if (isWorkEntryWorkspace(projectId)) {
    const folderActivity = await buildCoworkFolderActivity(cwd, diffLimit);
    return {
      gitDiff: folderActivity,
      changeInputKind: 'folder-activity',
      isMultiRepo: false,
    };
  }

  if (!isMultiRepoWorkspace(projectId)) {
    const diff = await readRepoDiffForSummary(cwd, diffLimit);
    return {
      gitDiff: diff,
      changeInputKind: 'git-diff',
      isMultiRepo: false,
    };
  }

  const workspaceConfig = await readEffectiveWorkspaceConfig(projectId);
  const repoCount = Math.max(
    1,
    workspaceConfig.repos.length + (workspaceConfig.sourceRepoPath ? 1 : 0),
  );
  const perRepoLimit = Math.max(4_000, Math.floor(diffLimit / repoCount));
  const repoDiffPromises: Array<Promise<{ name: string; diff: string }>> = [];

  if (workspaceConfig.sourceRepoPath) {
    repoDiffPromises.push(
      (async (): Promise<{ name: string; diff: string }> => {
        const diff = await readRepoDiffForSummary(cwd, perRepoLimit);
        return {
          name: WORKSPACE_ROOT_REPO_NAME,
          diff,
        };
      })(),
    );
  }

  repoDiffPromises.push(
    ...workspaceConfig.repos.map(
      async (repo): Promise<{ name: string; diff: string }> => {
        const repoPath = getWorkspaceWorktreeRepoDir(
          projectId,
          worktreeId,
          repo.id,
        );
        const diff = await readRepoDiffForSummary(repoPath, perRepoLimit);
        return {
          name: repo.name,
          diff,
        };
      },
    ),
  );

  const repoDiffs = await Promise.all(repoDiffPromises);

  const populatedRepoDiffs = repoDiffs.filter(
    (repoDiff) => repoDiff.diff.trim().length > 0,
  );
  const gitDiff = truncateText(
    populatedRepoDiffs
      .map((repoDiff) => `## ${repoDiff.name}\n${repoDiff.diff}`)
      .join('\n\n'),
    diffLimit,
  );

  return {
    gitDiff,
    changeInputKind: 'git-diff',
    isMultiRepo: true,
    repoDiffs: populatedRepoDiffs,
  };
}

const FOLDER_ACTIVITY_MAX_FILES = 100;
const FOLDER_ACTIVITY_SCAN_MAX_FILES = 1_000;
const FOLDER_ACTIVITY_MAX_DEPTH = 4;

/**
 * Recently-modified-files listing for a cowork workspace folder: relative
 * path + mtime, newest first, bounded in count/depth/chars. Dot-prefixed
 * entries (including the brand-managed `.{brand}/` dir) and node_modules are
 * skipped.
 */
async function buildCoworkFolderActivity(
  rootDir: string,
  maxChars: number,
): Promise<string> {
  const entries: Array<{ path: string; mtimeMs: number }> = [];
  let scannedFiles = 0;
  let scanBudgetReached = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > FOLDER_ACTIVITY_MAX_DEPTH || scanBudgetReached) {
      return;
    }
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (scanBudgetReached) break;
      if (dirent.name.startsWith('.') || dirent.name === 'node_modules') {
        continue;
      }
      const absolutePath = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(absolutePath, depth + 1);
        continue;
      }
      if (!dirent.isFile()) {
        continue;
      }
      scannedFiles += 1;
      if (scannedFiles > FOLDER_ACTIVITY_SCAN_MAX_FILES) {
        scanBudgetReached = true;
        break;
      }
      try {
        const info = await stat(absolutePath);
        entries.push({
          path: relative(rootDir, absolutePath),
          mtimeMs: info.mtimeMs,
        });
      } catch {
        // Skip unreadable entries.
      }
    }
  }

  await walk(rootDir, 0);
  entries.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const lines = entries
    .slice(0, FOLDER_ACTIVITY_MAX_FILES)
    .map(
      (entry) =>
        `- ${entry.path} (modified ${new Date(entry.mtimeMs).toISOString()})`,
    );
  if (entries.length > FOLDER_ACTIVITY_MAX_FILES) {
    lines.push(`- … ${entries.length - FOLDER_ACTIVITY_MAX_FILES} more files`);
  }
  if (scanBudgetReached) {
    lines.push(
      `- … scan stopped after ${FOLDER_ACTIVITY_SCAN_MAX_FILES} files`,
    );
  }
  return truncateText(lines.join('\n'), maxChars);
}

async function readRepoDiffForSummary(
  repoPath: string,
  maxChars: number,
): Promise<string> {
  const baseBranch = await getRemoteDefaultBranch(repoPath).catch(() => null);
  const comparisonDiff =
    baseBranch === null
      ? ''
      : await getComparisonDiff(repoPath, baseBranch).catch(() => '');
  const workingTreeDiff = await getUncommittedDiff(repoPath).catch(() => '');

  const sections: string[] = [];
  if (comparisonDiff.trim()) {
    sections.push(
      baseBranch
        ? `# Changes since origin/${baseBranch}\n${comparisonDiff}`
        : comparisonDiff,
    );
  }

  if (workingTreeDiff.trim()) {
    if (!comparisonDiff.trim()) {
      sections.push(`# Working tree changes\n${workingTreeDiff}`);
    } else if (workingTreeDiff.trim() !== comparisonDiff.trim()) {
      sections.push(`# Uncommitted changes\n${workingTreeDiff}`);
    }
  }

  return truncateText(sections.join('\n\n').trim(), maxChars);
}

/** Background summaries consume bounded text windows, never hydrate sibling
 * transcript histories or full tool artifacts. Text truncation here affects
 * only the derived helper prompt, not durable messages.
 */
async function buildStoredChatExcerpts(
  projectId: string,
  worktreeId: string,
  tabs: ChatTabsFile,
  isFullRefresh: boolean,
  sinceTurnCount: number,
): Promise<string> {
  if (!tabs.tabs.some((tab) => tab.transcript))
    return buildChatExcerpts(tabs, isFullRefresh, sinceTurnCount);
  const maxChars = isFullRefresh
    ? FULL_CHAT_MAX_CHARS
    : INCREMENTAL_CHAT_MAX_CHARS;
  const windows: ChatTabsFile = { ...tabs, tabs: [] };
  for (const metadata of tabs.tabs) {
    if (metadata.kind === 'file') continue;
    const selected = await readChatTabsFile(projectId, worktreeId, {
      chatIds: [metadata.id],
      pageOnly: true,
    });
    const tab = selected.tabs.find((candidate) => candidate.id === metadata.id);
    if (!tab) continue;
    const messages: PersistedChatMessage[] = [];
    let remaining = maxChars;
    for (
      let index = tab.messages.length - 1;
      index >= 0 && remaining > 0;
      index--
    ) {
      const message = tab.messages[index];
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      const text = truncateText(extractBlockText(message.blocks), remaining);
      if (!text) continue;
      remaining -= text.length;
      messages.unshift({ ...message, blocks: [{ type: 'text', text }] });
    }
    windows.tabs.push({ ...tab, transcript: undefined, messages });
  }
  const omittedUserTurns = Math.max(
    0,
    countUserTurns(tabs) - countUserTurns(windows),
  );
  return buildChatExcerpts(
    windows,
    isFullRefresh,
    sinceTurnCount,
    omittedUserTurns,
  );
}

function buildChatExcerpts(
  chatTabs: ChatTabsFile,
  isFullRefresh: boolean,
  sinceTurnCount: number,
  priorUserTurns = 0,
): string {
  const maxChars = isFullRefresh
    ? FULL_CHAT_MAX_CHARS
    : INCREMENTAL_CHAT_MAX_CHARS;
  const excerpts: string[] = [];
  let userTurnCount = priorUserTurns;
  let currentLength = 0;

  for (const { tab, message } of getChronologicalChatMessages(chatTabs)) {
    const excerpt = buildMessageExcerpt(tab, message, userTurnCount);

    if (message.role === 'user' && isUserTurn(message)) {
      userTurnCount += 1;
    }

    if (excerpt === null) {
      continue;
    }

    if (!isFullRefresh && excerpt.turnIndex <= sinceTurnCount) {
      continue;
    }

    const entry = [
      `### ${tab.title} · ${excerpt.label} · turn ${excerpt.turnIndex}`,
      excerpt.text,
    ].join('\n');

    if (currentLength + entry.length > maxChars) {
      if (excerpts.length === 0) {
        return truncateText(entry, maxChars);
      }
      return excerpts.join('\n\n');
    }

    excerpts.push(entry);
    currentLength += entry.length;
  }

  return excerpts.join('\n\n');
}

function getChronologicalChatMessages(
  chatTabs: ChatTabsFile,
): ChronologicalChatMessage[] {
  const messages: ChronologicalChatMessage[] = [];

  chatTabs.tabs.forEach((tab, tabIndex) => {
    const orderedMessages = [...tab.messages].sort(
      (left, right) => left.timestamp - right.timestamp,
    );

    orderedMessages.forEach((message, messageIndex) => {
      messages.push({
        tab,
        message,
        tabIndex,
        messageIndex,
      });
    });
  });

  messages.sort((left, right) => {
    if (left.message.timestamp !== right.message.timestamp) {
      return left.message.timestamp - right.message.timestamp;
    }

    if (left.tabIndex !== right.tabIndex) {
      return left.tabIndex - right.tabIndex;
    }

    return left.messageIndex - right.messageIndex;
  });

  return messages;
}

function buildMessageExcerpt(
  tab: PersistedChatTab,
  message: PersistedChatMessage,
  currentTurnCount: number,
): { turnIndex: number; label: string; text: string } | null {
  if (message.role === 'user') {
    if (!isUserTurn(message)) {
      return null;
    }
    const text = extractBlockText(message.blocks);
    return text.length > 0
      ? {
          turnIndex: currentTurnCount + 1,
          label: 'User',
          text,
        }
      : null;
  }

  if (message.role === 'assistant' && currentTurnCount > 0) {
    const text = extractBlockText(message.blocks);
    return text.length > 0
      ? {
          turnIndex: currentTurnCount,
          label: `Assistant in ${tab.title}`,
          text,
        }
      : null;
  }

  return null;
}

function isUserTurn(message: PersistedChatMessage): boolean {
  return message.role === 'user' && message.blocks.length > 0;
}

function countUserTurns(chatTabs: ChatTabsFile): number {
  let turnCount = 0;

  for (const tab of chatTabs.tabs) {
    if (tab.transcript) {
      turnCount += tab.transcript.userMessageCount ?? 0;
      continue;
    }
    for (const message of tab.messages) {
      if (isUserTurn(message)) {
        turnCount += 1;
      }
    }
  }

  return turnCount;
}

function extractBlockText(blocks: PersistedChatBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n')
    .trim();
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const suffix = '\n\n[truncated]';
  return `${value.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

function emitUpdated(
  projectId: string,
  worktreeId: string,
  summary: WorktreeSummaryData,
  getWindow: () => BrowserWindow | null,
): void {
  const event: WorktreeSummaryUpdatedEvent = {
    projectId,
    worktreeId,
    summary,
  };
  void getWindow;
  sendToAllWindows(IPC_CHANNELS.worktreeSummaryUpdated, event);
}

function emitGenerating(
  projectId: string,
  worktreeId: string,
  generating: boolean,
  getWindow: () => BrowserWindow | null,
): void {
  const event: WorktreeSummaryGeneratingEvent = {
    projectId,
    worktreeId,
    generating,
  };
  void getWindow;
  sendToAllWindows(IPC_CHANNELS.worktreeSummaryGenerating, event);
}

/**
 * Publishes a new snapshot (with any earlier one still pending, in order) and
 * reports what the write discarded: publishable snapshots the history cap
 * dropped, publishable provenance that did not validate, history entries that
 * did not validate, or a corrupt file. Never blocks the Summary panel; what
 * does not publish now waits for startup reconciliation.
 */
function publishWrittenSnapshot(
  projectId: string,
  worktreeId: string,
  written: WorktreeSummaryWriteResult,
): void {
  const scope = { projectId, worktreeId };
  if (written.isNewSnapshot && written.snapshot.provenance?.ledgerPublishable) {
    void publishPendingSummarySnapshots(scope);
  }
  if (written.droppedPublishableSnapshotIds.length > 0) {
    void reportDroppedSummarySnapshots(
      scope,
      written.droppedPublishableSnapshotIds,
    );
  }
  if (written.strippedPublishableSnapshotIds.length > 0) {
    void reportStrippedSummaryProvenance(
      scope,
      written.strippedPublishableSnapshotIds,
    );
  }
  reportInvalidSummarySnapshots(scope, written.droppedInvalidSnapshotCount);
  if (written.replacedCorruptFile) reportReplacedSummaryFile(scope);
}
