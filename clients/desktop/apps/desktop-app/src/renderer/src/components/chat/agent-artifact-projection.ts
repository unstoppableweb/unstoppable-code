import type {
  BackgroundProcess,
  AgentArtifactCarryByTurn,
  AgentArtifactCarryReceiptV1,
  GitHubWorkflowRunArtifactReceiptV1,
  GitHubWorkflowRunWatchProgress,
  PersistedChatMessage,
  PipelineRunArtifactReceiptV1,
  AppAdvisorWatcherSummary,
  AppAdvisorWatcherDestination,
} from '@canopy/desktop-shared/types';
import {
  agentArtifactTurnRelation,
  latestGitHubRunObservation,
} from '@canopy/protocol/agent-artifacts';
import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import { overlayManagedDelegationSnapshot } from '@canopy/ui-app/managed-delegation-progress';
import type { DisplayBlock, TurnGroupOrMessage } from './types';
import { isClaudeAgentRunning, codexAgentState } from './agent-block-state';
import { isAsyncAgentLaunchText } from '@canopy/desktop-shared/lib/background-work';
import type { ExecutionSummary } from '@canopy/execution-engine/types/pipeline';
import {
  buildGitHubWorkflowRunArtifactReceipt,
  buildPipelineRunArtifactReceipt,
  isSameAgentArtifactCarryReceipt,
} from '@canopy/desktop-shared/lib/agent-artifacts';
import {
  createEmptyAgentArtifactProjectionCache,
  projectAgentArtifactsWithCarry as projectSharedAgentArtifactsWithCarry,
  type AgentArtifactProjection,
  type AgentArtifactProjectionCache,
} from '@canopy/desktop-shared/lib/agent-artifact-projection';
import {
  watchersForPipelineExecution,
  watchersForSubscriberDestination,
} from '@/components/watchers/watcherFilters';
import { beginTranscriptPerformanceStage } from '@/lib/transcript-performance';

// Receipt parsing, the per-turn segment cache and carry merge live in the
// shared pure module so Electron main attributes Portal pipeline_run chat
// links with the same rules (CAN-3619). This file keeps the renderer-only
// instrumentation, display-block selection and watcher filters.
export {
  createEmptyAgentArtifactProjectionCache,
  mergeAgentArtifactTurn,
  type AgentArtifactProjection,
  type AgentArtifactProjectionCache,
} from '@canopy/desktop-shared/lib/agent-artifact-projection';

/**
 * Project presentation-safe receipts from a persisted transcript. Tool calls
 * are owned by the most recent user turn; only successful, recognized action
 * dispatch results participate.
 */
export function projectAgentArtifacts(
  messages: readonly PersistedChatMessage[],
): AgentArtifactProjection {
  return projectAgentArtifactsWithCarry(messages);
}

/**
 * Renderer entry point for the shared per-turn projection; records the
 * transcript performance stage around the shared implementation.
 */
export function projectAgentArtifactsWithCarry(
  messages: readonly PersistedChatMessage[],
  carryByTurn?: AgentArtifactCarryByTurn,
  cache: AgentArtifactProjectionCache = createEmptyAgentArtifactProjectionCache(),
): AgentArtifactProjection {
  const finishPerformanceStage = beginTranscriptPerformanceStage(
    'artifact_projection',
    { messages: messages.length },
  );
  return projectSharedAgentArtifactsWithCarry(
    messages,
    carryByTurn,
    cache,
    (stats) => {
      finishPerformanceStage({ turns: stats.turns, segments: stats.segments });
    },
  );
}

/**
 * Reuse the already-merged chat blocks, including their complete child
 * activity. `liveSnapshots` (a cloud chat's, CAN-7245) overlay each
 * delegate's card first: its card keeps its first state.
 */
export function selectActiveAgentBlocks(
  groups: readonly TurnGroupOrMessage[],
  processes: readonly BackgroundProcess[],
  chatId: string,
  liveSnapshots?: ReadonlyMap<string, AgentDelegationSnapshot>,
): DisplayBlock[] {
  const latest = new Map<string, DisplayBlock>();
  const nativeStatuses = new Map(
    processes
      .filter((process) => process.chatId === chatId)
      .map((process) => [process.toolUseId, process.status]),
  );
  const visit = (block: DisplayBlock): void => {
    if (block.type === 'delegated_agent_call') {
      const key = `managed:${block.delegationId}`;
      const previous = latest.get(key);
      const shown =
        liveSnapshots === undefined
          ? block
          : {
              ...block,
              ...overlayManagedDelegationSnapshot(
                block,
                liveSnapshots.get(block.delegationId),
              ),
            };
      if (
        !previous ||
        previous.type !== 'delegated_agent_call' ||
        (shown.runGeneration ?? 1) >= (previous.runGeneration ?? 1)
      ) {
        latest.set(key, shown);
      }
    } else if (block.type === 'agent') {
      latest.set(`claude:${block.toolUseId}`, block);
    } else if (block.type === 'codex_agent') {
      latest.set(`codex:${block.agentBlockId}`, block);
    }
    if ('subBlocks' in block) block.subBlocks.forEach(visit);
  };
  for (const group of groups) {
    const messages =
      group.kind === 'turn-group' ? group.assistantMessages : [group.message];
    for (const message of messages) message.blocks.forEach(visit);
  }
  return Array.from(latest.values()).filter((block) => {
    if (block.type === 'delegated_agent_call') {
      return (
        block.executionMode === 'background' &&
        (block.status === 'pending' || block.status === 'running')
      );
    }
    if (block.type === 'agent') {
      const backgroundStatus = nativeStatuses.get(block.toolUseId);
      if (backgroundStatus !== undefined) {
        return isClaudeAgentRunning(
          block.runInBackground,
          block.result,
          block.taskOutputResult,
          backgroundStatus,
        );
      }
      return (
        (block.runInBackground ||
          (block.result !== undefined &&
            !block.result.isError &&
            isAsyncAgentLaunchText(block.result.output))) &&
        isClaudeAgentRunning(
          block.runInBackground,
          block.result,
          block.taskOutputResult,
        )
      );
    }
    return block.type === 'codex_agent' && codexAgentState(block).running;
  });
}

export function selectWatchedChatInitiatedRuns(
  runs: Readonly<Record<string, PipelineRunArtifactReceiptV1>>,
  watchers: readonly AppAdvisorWatcherSummary[],
  destination: AppAdvisorWatcherDestination,
): PipelineRunArtifactReceiptV1[] {
  return selectWatchedPipelineRuns(runs, [], watchers, destination);
}

function initialReceiptStatus(
  status: string | undefined,
): PipelineRunArtifactReceiptV1['initialStatus'] {
  return status === 'running' || status === 'paused' ? status : 'pending';
}

function receiptFromExecutionSummary(
  summary: ExecutionSummary,
): PipelineRunArtifactReceiptV1 | null {
  if (!summary.project_id || !summary.worktree_id) return null;
  return buildPipelineRunArtifactReceipt({
    operation: 'pipeline.watch',
    executionId: summary.id,
    pipelineId: summary.pipeline_id,
    pipelineName: summary.pipeline_name,
    initialStatus: initialReceiptStatus(summary.status),
    queuedAt: summary.started_at,
    ...(summary.status !== 'pending' ? { startedAt: summary.started_at } : {}),
    projectId: summary.project_id,
    worktreeId: summary.worktree_id,
    createdAt: summary.started_at,
    navigationTarget: {
      kind: 'pipeline_execution',
      executionId: summary.id,
      projectId: summary.project_id,
      worktreeId: summary.worktree_id,
    },
  });
}

function receiptFromPinnedWatcher(
  watcher: AppAdvisorWatcherSummary,
): PipelineRunArtifactReceiptV1 | null {
  if (
    watcher.trigger !== 'worktree_pipeline_completion' ||
    watcher.target.kind !== 'worktree_pipeline' ||
    !watcher.target.executionId ||
    !watcher.target.pipelineId ||
    !watcher.target.executionStartedAt
  ) {
    return null;
  }
  return buildPipelineRunArtifactReceipt({
    operation: 'pipeline.watch',
    executionId: watcher.target.executionId,
    pipelineId: watcher.target.pipelineId,
    pipelineName: watcher.target.pipelineName ?? watcher.target.pipelineId,
    initialStatus: initialReceiptStatus(watcher.target.executionStatus),
    queuedAt: watcher.target.executionStartedAt,
    ...(watcher.target.executionStatus !== 'pending'
      ? { startedAt: watcher.target.executionStartedAt }
      : {}),
    projectId: watcher.target.projectId,
    worktreeId: watcher.target.worktreeId,
    createdAt: watcher.target.executionStartedAt,
    navigationTarget: {
      kind: 'pipeline_execution',
      executionId: watcher.target.executionId,
      projectId: watcher.target.projectId,
      worktreeId: watcher.target.worktreeId,
    },
  });
}

/**
 * Resolve every run this chat is actively watching. Existing transcript
 * receipts remain authoritative, but watcher-pinned or currently active
 * executions can contribute a card even when another surface started them.
 */
export function selectWatchedPipelineRuns(
  runs: Readonly<Record<string, PipelineRunArtifactReceiptV1>>,
  summaries: readonly ExecutionSummary[],
  watchers: readonly AppAdvisorWatcherSummary[],
  destination: AppAdvisorWatcherDestination,
): PipelineRunArtifactReceiptV1[] {
  const activeDestinationWatchers = watchersForSubscriberDestination(
    [...watchers],
    destination,
  ).filter((watcher) => watcher.status === 'active');
  const selected = new Map<string, PipelineRunArtifactReceiptV1>();
  const summariesById = new Map(
    summaries.map((summary) => [summary.id, summary]),
  );
  for (const receipt of Object.values(runs)) {
    const matching = watchersForPipelineExecution(activeDestinationWatchers, {
      projectId: receipt.projectId,
      worktreeId: receipt.worktreeId,
      executionId: receipt.executionId,
      pipelineId: receipt.pipelineId,
    });
    if (matching.length === 0) continue;
    const pinned = matching.some(
      (watcher) =>
        watcher.target.kind === 'worktree_pipeline' &&
        watcher.target.executionId === receipt.executionId,
    );
    const status =
      summariesById.get(receipt.executionId)?.status ?? receipt.initialStatus;
    if (
      !pinned &&
      status !== 'pending' &&
      status !== 'running' &&
      status !== 'paused'
    ) {
      continue;
    }
    selected.set(receipt.executionId, receipt);
  }
  for (const summary of summaries) {
    const matching = watchersForPipelineExecution(activeDestinationWatchers, {
      projectId: summary.project_id,
      worktreeId: summary.worktree_id,
      executionId: summary.id,
      pipelineId: summary.pipeline_id,
    });
    if (matching.length === 0) continue;
    const pinned = matching.some(
      (watcher) =>
        watcher.target.kind === 'worktree_pipeline' &&
        watcher.target.executionId === summary.id,
    );
    if (
      !pinned &&
      summary.status !== 'pending' &&
      summary.status !== 'running' &&
      summary.status !== 'paused'
    ) {
      continue;
    }
    const receipt = receiptFromExecutionSummary(summary);
    if (receipt) selected.set(summary.id, receipt);
  }
  for (const watcher of activeDestinationWatchers) {
    const receipt = receiptFromPinnedWatcher(watcher);
    if (receipt && !selected.has(receipt.executionId)) {
      selected.set(receipt.executionId, receipt);
    }
  }
  return Array.from(selected.values()).sort((left, right) =>
    left.queuedAt.localeCompare(right.queuedAt),
  );
}

function receiptFromGitHubProgress(
  watcher: AppAdvisorWatcherSummary,
  run: GitHubWorkflowRunWatchProgress,
  createdAt: string,
  watcherId = watcher.id,
): GitHubWorkflowRunArtifactReceiptV1 {
  return buildGitHubWorkflowRunArtifactReceipt({
    operation: 'github.watch',
    createdAt,
    watcherId,
    repository: run.repository,
    runId: run.runId,
    runAttempt: run.runAttempt,
    ...(run.workflowName ? { workflowName: run.workflowName } : {}),
    ...(run.runNumber !== undefined ? { runNumber: run.runNumber } : {}),
    htmlUrl: run.htmlUrl,
    state: run.state,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    observedAt: run.observedAt,
    ...(run.jobs ? { jobs: run.jobs } : {}),
    ...(run.definition ? { definition: run.definition } : {}),
    navigationTarget: {
      kind: 'github_workflow_run',
      repository: run.repository,
      runId: run.runId,
      htmlUrl: run.htmlUrl,
    },
  });
}

/**
 * The newest observation a run snapshot carries. Job cursors advance without
 * replacing the run snapshot, so the run's own `observedAt` alone would hide a
 * job-only change.
 */

/**
 * Whether a GitHub watcher still follows what it watches. While it delivers
 * an update main lists it as `firing` in the fire history, not in the active
 * list, then makes it active again; for that window its run or pull request
 * is still live and stays in the background drawer.
 */
export function isFollowingWatcher(watcher: AppAdvisorWatcherSummary): boolean {
  return watcher.status === 'active' || watcher.status === 'firing';
}

/**
 * Resolve every GitHub workflow run this chat is actively watching, one
 * receipt per run. When several watchers follow the same run the most recent
 * observation wins. Only watchers following their run
 * (`isFollowingWatcher`) whose destination is this chat contribute; their
 * progress comes from the watcher's own polling, so no additional GitHub
 * request is ever made here. Each receipt is then refreshed from
 * `completedWatchers` exactly as the run card refreshes it: the fire history
 * is read separately and can be newer, and two writers recording different
 * snapshots of one run would overwrite each other on every render.
 */
export function selectWatchedGitHubWorkflowRuns(
  watchers: readonly AppAdvisorWatcherSummary[],
  destination: AppAdvisorWatcherDestination,
  completedWatchers: readonly AppAdvisorWatcherSummary[] = [],
): GitHubWorkflowRunArtifactReceiptV1[] {
  const activeDestinationWatchers = [...watchers, ...completedWatchers].filter(
    (watcher) =>
      isFollowingWatcher(watcher) &&
      watcher.destination.projectId === destination.projectId &&
      watcher.destination.worktreeId === destination.worktreeId &&
      watcher.destination.chatId === destination.chatId,
  );
  const selected = new Map<string, GitHubWorkflowRunArtifactReceiptV1>();
  for (const watcher of activeDestinationWatchers) {
    if (
      watcher.trigger !== 'github_workflow_runs_changed' ||
      !watcher.githubProgress
    ) {
      continue;
    }
    for (const run of watcher.githubProgress.runs) {
      const receipt = receiptFromGitHubProgress(
        watcher,
        run,
        watcher.createdAt,
      );
      const existing = selected.get(receipt.dedupeKey);
      if (
        !existing ||
        latestGitHubRunObservation(existing).localeCompare(
          latestGitHubRunObservation(run),
        ) <= 0
      ) {
        selected.set(receipt.dedupeKey, receipt);
      }
    }
  }
  const known = [...watchers, ...completedWatchers];
  return Array.from(selected.values(), (receipt) =>
    refreshGitHubWorkflowRunReceipt(receipt, known),
  ).sort(
    (left, right) =>
      (left.startedAt ?? left.createdAt).localeCompare(
        right.startedAt ?? right.createdAt,
      ) || left.runId.localeCompare(right.runId),
  );
}

/**
 * Bring a carried GitHub run receipt up to date from any watcher summary
 * (active or recently completed) that observed the same run more recently.
 * Returns the same reference when nothing newer is known so memoized cards
 * and carry writes stay quiet. Identity, creation time, and the originating
 * watcher id are preserved; an older observation never regresses the card.
 */
export function refreshGitHubWorkflowRunReceipt(
  receipt: GitHubWorkflowRunArtifactReceiptV1,
  watchers: readonly AppAdvisorWatcherSummary[],
): GitHubWorkflowRunArtifactReceiptV1 {
  let best = receipt;
  for (const watcher of watchers) {
    if (
      watcher.id !== receipt.watcherId ||
      watcher.trigger !== 'github_workflow_runs_changed' ||
      !watcher.githubProgress
    ) {
      continue;
    }
    for (const run of watcher.githubProgress.runs) {
      if (
        run.repository !== receipt.repository ||
        run.runId !== receipt.runId ||
        run.runAttempt !== receipt.runAttempt ||
        latestGitHubRunObservation(run).localeCompare(
          latestGitHubRunObservation(best),
        ) < 0
      ) {
        continue;
      }
      const candidate = receiptFromGitHubProgress(
        watcher,
        run,
        receipt.createdAt,
        receipt.watcherId,
      );
      if (!isSameAgentArtifactCarryReceipt(best, candidate)) best = candidate;
    }
  }
  return best;
}

/**
 * Bring a carried GitHub run receipt up to the newest snapshot of the same run
 * attempt in `observed`, the receipts another turn just recorded. A watcher
 * turn delivered while the run is still going takes over the pinned section,
 * so the run finishes under that turn; earlier turns that carried it follow
 * it to its final state instead of keeping their last in-progress snapshot.
 *
 * Any watcher's observation counts: one run has one state, unlike
 * `refreshGitHubWorkflowRunReceipt`, which reads only the receipt's own
 * watcher summaries. The snapshot fields (state, jobs, definition, aliases,
 * navigation target) come from the newer receipt; the carried receipt keeps
 * its creation time and watcher, so its card still manages that watcher.
 * Returns the same reference when nothing newer was observed, so an older
 * observation never regresses a turn.
 */
export function refreshCarriedGitHubWorkflowRun(
  carried: AgentArtifactCarryReceiptV1,
  observed: readonly AgentArtifactCarryReceiptV1[],
): AgentArtifactCarryReceiptV1 {
  if (carried.kind !== 'github_workflow_run') return carried;
  let best: GitHubWorkflowRunArtifactReceiptV1 = carried;
  for (const receipt of observed) {
    if (
      receipt.kind !== 'github_workflow_run' ||
      receipt.dedupeKey !== carried.dedupeKey ||
      receipt.runAttempt !== carried.runAttempt ||
      latestGitHubRunObservation(receipt).localeCompare(
        latestGitHubRunObservation(best),
      ) <= 0
    ) {
      continue;
    }
    best = {
      ...receipt,
      createdAt: carried.createdAt,
      watcherId: carried.watcherId,
    };
  }
  return best;
}

/**
 * Everything a chat carries forward while it watches: pipeline runs (live
 * state read from the execution store) plus GitHub workflow runs (snapshot
 * embedded from the watcher's progress projection).
 */
export function selectWatchedCarryReceipts(
  runs: Readonly<Record<string, PipelineRunArtifactReceiptV1>>,
  summaries: readonly ExecutionSummary[],
  watchers: readonly AppAdvisorWatcherSummary[],
  destination: AppAdvisorWatcherDestination,
  completedWatchers: readonly AppAdvisorWatcherSummary[] = [],
): AgentArtifactCarryReceiptV1[] {
  return [
    ...selectWatchedPipelineRuns(runs, summaries, watchers, destination),
    ...selectWatchedGitHubWorkflowRuns(
      watchers,
      destination,
      completedWatchers,
    ),
  ];
}

/**
 * The watched runs a chat may persist as carry. A run this chat launched
 * already lives in its launching turn's transcript receipts; carrying a copy
 * would overwrite that `launched` receipt (latest wins by dedupeKey) or
 * re-list the run under a later turn, so a run whose transcript receipt is
 * `launched` is dropped. Runs started elsewhere, including ones the chat only
 * watched through a tool, are kept (CAN-4690). Returns the input array when
 * nothing is dropped.
 */
export function selectPersistableCarryReceipts(
  watchedRuns: readonly AgentArtifactCarryReceiptV1[],
  chatInitiatedPipelineRuns: Readonly<
    Record<string, PipelineRunArtifactReceiptV1>
  >,
): readonly AgentArtifactCarryReceiptV1[] {
  const kept = watchedRuns.filter((receipt) => {
    if (receipt.kind !== 'pipeline_run') return true;
    const transcriptReceipt = chatInitiatedPipelineRuns[receipt.executionId];
    return (
      transcriptReceipt === undefined ||
      agentArtifactTurnRelation(transcriptReceipt) === 'watching'
    );
  });
  return kept.length === watchedRuns.length ? watchedRuns : kept;
}
