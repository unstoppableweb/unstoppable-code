import type { PipelineRunArtifactReceiptV1 } from '@canopy/protocol/agent-artifacts';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import {
  isAgentDelegationCardData,
  type AgentDelegationCardData,
} from '@canopy/protocol/delegation';
import type {
  PortalBackgroundProcessEntity,
  PortalChatMessage,
  PortalWatcherEntity,
  PortalGitHubRunProgress,
  PortalGitHubPullRequestProgress,
} from '@canopy/protocol/portal';
import { SUBAGENT_UNTITLED_LABEL } from '@canopy/ui-shared/components';
import {
  AGENT_STEP_LIMIT,
  delegateAgentMeta,
  delegateAgentStatus,
  type BackgroundTrayAgent,
  type BackgroundTrayAgentStep,
} from './background-tray/AgentRow';
import {
  pipelineBackgroundTrayRun,
  githubBackgroundTrayRun,
  githubPullRequestBackgroundTrayRun,
  type BackgroundTrayRun,
} from './background-tray/RunRow';
import type { PipelineRunReceiptHost } from '../agent-activity/pipeline-run-receipt-host';
import { collectTurnAgentArtifacts } from '../agent-activity/turn-agent-artifacts';
import { normalizePipelineRunStatus } from '../agent-activity/pipeline-run-receipt';
import type { BackgroundTrayWatcher } from './background-tray/WatcherRow';

/** Only the receiving chat's visible subscriptions belong in its drawer. */
export function portalBackgroundTrayWatchers(
  watchers: readonly PortalWatcherEntity[] | undefined,
  target: {
    readonly projectId: string;
    readonly worktreeId: string;
    readonly chatId: string;
  },
): BackgroundTrayWatcher[] {
  return (watchers ?? []).flatMap((watcher) => {
    if (
      watcher.projectId !== target.projectId ||
      watcher.worktreeId !== target.worktreeId ||
      watcher.chatId !== target.chatId ||
      watcher.status === 'fired'
    )
      return [];
    return [
      {
        id: watcher.id,
        name: watcher.display.title,
        watching: watcher.display.watching,
        trigger: watcher.display.subtitle,
        status: watcher.status,
        details: [
          ...watcher.display.details,
          ...(watcher.display.ownerDelegate
            ? [{ label: 'Delegate', value: watcher.display.ownerDelegate.name }]
            : []),
        ],
        followUpInstruction: watcher.followUpInstruction,
        deliveryError: watcher.deliveryError,
      },
    ];
  });
}

/**
 * Projects a Portal background process (the paired desktop's
 * `background_process` row) onto the portable task the background drawer
 * renders. The Portal carries no output lines, and its Stop is not wired,
 * so the drawer's shell inspector shows its capability-gated state.
 */
export function portalBackgroundProcessToTask(
  process: PortalBackgroundProcessEntity,
): BackgroundTask {
  const settled =
    process.status === 'completed' ||
    process.status === 'failed' ||
    process.status === 'stopped';
  return {
    id: process.localId,
    kind: process.kind,
    status: process.status,
    title: process.description,
    ownerToolUseId: process.toolUseId,
    parentTaskId: null,
    startedAt: process.startedAt,
    settledAt: settled ? process.updatedAt : null,
    updatedAt: process.updatedAt,
    lastDescription: process.lastDescription ?? null,
    summary: process.summary ?? null,
    outputLines: [],
    canStop: process.canStop,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** An agent part's tool calls, newest last. */
function agentSteps(data: Record<string, unknown>): BackgroundTrayAgentStep[] {
  const subBlocks = Array.isArray(data.subBlocks) ? data.subBlocks : [];
  return subBlocks
    .flatMap((sub: unknown, index): BackgroundTrayAgentStep[] => {
      if (!isRecord(sub) || sub.kind !== 'tool_use' || !isRecord(sub.data)) {
        return [];
      }
      const toolName = text(sub.data, 'toolName') ?? text(sub.data, 'name');
      if (toolName === null) return [];
      const raw = sub.data.input;
      return [
        {
          id: text(sub.data, 'toolUseId') ?? String(index),
          toolName,
          input:
            typeof raw === 'string'
              ? raw
              : raw === undefined
                ? ''
                : JSON.stringify(raw),
        },
      ];
    })
    .slice(-AGENT_STEP_LIMIT);
}

function delegateRow(
  delegation: AgentDelegationCardData,
  data: Record<string, unknown>,
  canStop: boolean,
): BackgroundTrayAgent | null {
  if (
    delegation.executionMode !== 'background' ||
    (delegation.status !== 'pending' && delegation.status !== 'running')
  ) {
    return null;
  }
  const title = delegation.description || SUBAGENT_UNTITLED_LABEL;
  return {
    id: `managed:${delegation.delegationId}`,
    kind: 'delegate',
    title,
    status: delegateAgentStatus(delegation),
    activity: null,
    startedAt: null,
    steps: agentSteps(data),
    prompt: delegation.prompt || null,
    meta: delegateAgentMeta(delegation),
    taskId: null,
    // Only a host that stops delegates itself (`delegationStop`) offers Stop.
    canStop,
    target: { kind: 'managed', id: delegation.delegationId, title },
  };
}

function nativeRow(
  toolUseId: string,
  data: Record<string, unknown>,
  tasks: readonly BackgroundTask[],
): BackgroundTrayAgent | null {
  if (data.isRunning !== true) return null;
  const subagentType = text(data, 'subagentType');
  const title =
    text(data, 'description') ?? subagentType ?? SUBAGENT_UNTITLED_LABEL;
  if (data.provider === 'codex') {
    return {
      id: `codex:${toolUseId}`,
      kind: 'codex',
      title,
      status: 'running',
      activity: null,
      startedAt: null,
      steps: agentSteps(data),
      prompt: text(data, 'prompt'),
      meta: ['Codex', text(data, 'model'), text(data, 'reasoningEffort')]
        .filter((part) => part !== null)
        .join(' · '),
      taskId: null,
      canStop: false,
      // The Portal opens Codex children from the Subagents panel only.
      target: null,
    };
  }
  // A Claude agent is background work only when it runs in the background.
  if (data.runInBackground !== true) return null;
  const task = tasks.find((item) => item.ownerToolUseId === toolUseId);
  return {
    id: `claude:${toolUseId}`,
    kind: 'claude',
    title,
    status: 'running',
    activity: null,
    startedAt: task?.startedAt ?? null,
    steps: agentSteps(data),
    prompt: text(data, 'prompt'),
    meta: subagentType === null ? 'Claude' : `Claude · ${subagentType}`,
    taskId: task?.id ?? null,
    canStop: false,
    target: { kind: 'claude-native', id: toolUseId, title },
  };
}

/**
 * A live Claude background agent known only from its background task: a
 * desktop-relayed Portal chat carries native agents as `background_process`
 * rows, not agent parts.
 */
function taskAgentRow(task: BackgroundTask): BackgroundTrayAgent | null {
  if (task.ownerToolUseId === null) return null;
  return {
    id: `claude:${task.ownerToolUseId}`,
    kind: 'claude',
    title: task.title,
    status: 'running',
    activity: task.lastDescription,
    startedAt: task.startedAt,
    steps: [],
    prompt: null,
    meta: 'Claude',
    taskId: task.id,
    canStop: false,
    // The Portal's subagent viewer finds agents by their transcript parts;
    // one known only from its task has no chat there to open.
    target: null,
  };
}

/**
 * The live background subagents of a Portal chat, as drawer rows: running
 * Claude background agents (from their agent parts, else their background
 * task), running Codex children with agent parts, and background delegates
 * that are queued or running. A later part for the same agent replaces an
 * earlier one. Rows offer Open chat; delegates offer Stop too when the host
 * says it stops them.
 */
export function portalBackgroundTrayAgents(
  messages: readonly PortalChatMessage[],
  tasks: readonly BackgroundTask[],
  options: {
    /** The host stops delegates through `onStopAgent` (`delegationStop`). */
    readonly canStopDelegates?: boolean;
  } = {},
): BackgroundTrayAgent[] {
  const latest = new Map<string, BackgroundTrayAgent | null>();
  const visit = (part: unknown): void => {
    if (!isRecord(part) || part.kind !== 'agent' || !isRecord(part.data)) {
      return;
    }
    const data = part.data;
    const delegation = data.delegation;
    if (isAgentDelegationCardData(delegation)) {
      latest.set(
        `managed:${delegation.delegationId}`,
        delegateRow(delegation, data, options.canStopDelegates === true),
      );
    } else {
      const toolUseId = text(data, 'toolUseId');
      if (toolUseId !== null) {
        latest.set(toolUseId, nativeRow(toolUseId, data, tasks));
      }
    }
    if (Array.isArray(data.subBlocks)) data.subBlocks.forEach(visit);
  };
  for (const message of messages) message.parts?.forEach(visit);
  for (const task of tasks) {
    if (
      task.kind !== 'agent' ||
      (task.status !== 'queued' && task.status !== 'running') ||
      task.ownerToolUseId === null ||
      latest.has(task.ownerToolUseId)
    ) {
      continue;
    }
    latest.set(task.ownerToolUseId, taskAgentRow(task));
  }
  return Array.from(latest.values()).filter((row) => row !== null);
}

/**
 * The chat's pipeline runs for the Portal's background drawer: each run its
 * transcript lists, by dedupe key, with the state the run host reports. The
 * panel lists the live ones and the finished ones it saw live until
 * dismissed; a run the host does not know stays in its record. GitHub runs
 * arrive through sanitized watcher entities. `executionIds` maps each pipeline row back to its run,
 * for Stop.
 */
export function portalBackgroundTrayRuns(
  messages: readonly PortalChatMessage[],
  host: Pick<PipelineRunReceiptHost, 'summaries' | 'statesById'> | null,
  watchers: readonly PortalWatcherEntity[] = [],
  subscriber?: {
    readonly projectId: string;
    readonly worktreeId: string;
    readonly chatId: string;
  },
): {
  runs: BackgroundTrayRun[];
  executionIds: Record<string, string>;
  githubUrls: Record<string, string>;
} {
  const runs: BackgroundTrayRun[] = [];
  const executionIds: Record<string, string> = {};
  const githubUrls: Record<string, string> = {};
  const watchedRuns = new Map<string, PortalGitHubRunProgress>();
  const watchedPrs = new Map<string, PortalGitHubPullRequestProgress>();
  const followedRuns = new Set<string>();
  const followedPrs = new Set<string>();
  for (const watcher of watchers) {
    if (
      !subscriber ||
      watcher.projectId !== subscriber.projectId ||
      watcher.worktreeId !== subscriber.worktreeId ||
      watcher.chatId !== subscriber.chatId
    )
      continue;
    for (const run of watcher.githubProgress?.runs ?? []) {
      const key = `github:${run.repository}/${run.runId}/attempt/${run.runAttempt}`;
      if (watcher.status === 'active') followedRuns.add(key);
      const previous = watchedRuns.get(key);
      if (!previous || previous.observedAt.localeCompare(run.observedAt) < 0)
        watchedRuns.set(key, run);
    }
    for (const pr of watcher.githubPullRequestProgress?.pullRequests ?? []) {
      const key = `github-pr:${pr.repository}#${pr.number}`;
      if (watcher.status === 'active') followedPrs.add(key);
      const previous = watchedPrs.get(key);
      if (!previous || previous.observedAt.localeCompare(pr.observedAt) < 0)
        watchedPrs.set(key, pr);
    }
  }
  for (const [key, run] of Array.from(watchedRuns).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const row = githubBackgroundTrayRun(key, run);
    // Match desktop: an unfinished observation is live only while followed.
    if (row.status === 'running' && !followedRuns.has(key)) continue;
    runs.push(
      run.tiers && row.dag
        ? { ...row, dag: { ...row.dag, tiers: run.tiers } }
        : row,
    );
    githubUrls[key] = run.htmlUrl;
  }
  for (const [key, pr] of Array.from(watchedPrs).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const row = githubPullRequestBackgroundTrayRun(key, pr);
    if (row.status === 'running' && !followedPrs.has(key)) continue;
    runs.push(row);
    githubUrls[key] = pr.url;
  }
  if (host === null || host.summaries.length === 0)
    return { runs, executionIds, githubUrls };
  const latest = new Map<string, PipelineRunArtifactReceiptV1>();
  for (const receipt of collectTurnAgentArtifacts(messages)) {
    if (receipt.kind === 'pipeline_run') latest.set(receipt.dedupeKey, receipt);
  }
  for (const receipt of latest.values()) {
    const summary = host.summaries.find(
      (item) => item.id === receipt.executionId,
    );
    if (summary === undefined) continue;
    runs.push(
      pipelineBackgroundTrayRun(
        receipt.dedupeKey,
        receipt,
        normalizePipelineRunStatus(summary.status),
        host.statesById[receipt.executionId],
      ),
    );
    executionIds[receipt.dedupeKey] = receipt.executionId;
  }
  return { runs, executionIds, githubUrls };
}
