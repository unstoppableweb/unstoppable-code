import { useEffect, useState, type JSX } from 'react';
import {
  Stack,
  AgentBlockCard,
  EmptyStateRow,
  Markdown,
  Surface,
} from '@canopy/ui-shared/components';
import type {
  WorkflowAgentProgress,
  WorkflowPhaseInfo,
  WorkflowRunState,
} from '@canopy/desktop-shared/types';
import { formatTokenCount, formatDuration } from '@/lib/format';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { LoadingSpinner } from '../shared/loading/spinners/LoadingSpinner';
import { TranscriptViewer } from '../chat/TranscriptViewer';

/**
 * Lazily loads and renders a workflow sub-agent's transcript. Used as the
 * `subBlocks` of `AgentBlockCard`, which only mounts its sub-blocks once the
 * card is expanded — so the transcript fetch happens on first expand.
 */
function WorkflowAgentTranscript({
  agentId,
  transcriptDir,
  resultPreview,
}: {
  agentId: string;
  transcriptDir: string | undefined;
  resultPreview: string | undefined;
}): JSX.Element {
  const [lines, setLines] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!transcriptDir) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void window.api.activity
      .readWorkflowAgentTranscript({ transcriptDir, agentId })
      .then((res) => {
        if (cancelled) return;
        setLines(res.lines);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLines([]);
        setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [agentId, transcriptDir]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs fg-secondary">
        <LoadingSpinner tone="active" /> Loading transcript…
      </div>
    );
  }
  if (lines && lines.length > 0) {
    return (
      <TranscriptViewer
        transcriptKey={`wf-agent-${agentId}`}
        lines={lines}
        providerHint="claude"
        closeOpenTurnAtEnd
        emptyMessage="No transcript available."
        className="max-h-90 overflow-auto"
      />
    );
  }
  return (
    <div className="py-1 text-xs fg-secondary">
      {resultPreview ?? 'No transcript available.'}
    </div>
  );
}

/**
 * Render a single workflow agent using the shared "Sub Agent" card so workflow
 * agents look and behave exactly like the agents launched by the `Agent` tool.
 */
function WorkflowAgentBlock({
  agent,
  transcriptDir,
}: {
  agent: WorkflowAgentProgress;
  transcriptDir: string | undefined;
}): JSX.Element {
  const isRunning = agent.state !== 'done' && agent.state !== 'error';
  const isError = agent.state === 'error';

  const hasUsage =
    (agent.tokens != null && agent.tokens > 0) ||
    (agent.toolCalls != null && agent.toolCalls > 0) ||
    (agent.durationMs != null && agent.durationMs > 0) ||
    Boolean(agent.model) ||
    (isRunning && Boolean(agent.lastToolSummary));

  const usageOverride = hasUsage ? (
    <>
      {agent.tokens != null && agent.tokens > 0 && (
        <span>{formatTokenCount(agent.tokens)} tokens</span>
      )}
      {agent.toolCalls != null && agent.toolCalls > 0 && (
        <span>
          {agent.toolCalls} {agent.toolCalls === 1 ? 'tool call' : 'tool calls'}
        </span>
      )}
      {agent.durationMs != null && agent.durationMs > 0 && (
        <span>{formatDuration(agent.durationMs)}</span>
      )}
      {agent.model && <span className="max-w-40 truncate">{agent.model}</span>}
      {isRunning && agent.lastToolSummary && (
        <span className="truncate fg-secondary/80">
          {agent.lastToolName ? `${agent.lastToolName}: ` : ''}
          {agent.lastToolSummary}
        </span>
      )}
    </>
  ) : undefined;

  return (
    <AgentBlockCard
      subagentType={agent.agentType}
      description={agent.label}
      isRunning={isRunning}
      isError={isError}
      usage={hasUsage ? {} : undefined}
      usageOverride={usageOverride}
      {...(agent.resultPreview ? { result: agent.resultPreview } : {})}
      subBlocks={
        <>
          {agent.promptPreview && (
            <Surface variant="group" size="small">
              <div className="flex flex-col px-2.5 py-1.5 gap-1">
                <div className="text-3xs font-medium fg-secondary/80">
                  Prompt
                </div>
                <div className="max-h-32 overflow-auto whitespace-pre-wrap text-2xs fg-secondary">
                  {agent.promptPreview}
                </div>
              </div>
            </Surface>
          )}
          <WorkflowAgentTranscript
            agentId={agent.agentId}
            transcriptDir={transcriptDir}
            resultPreview={agent.resultPreview}
          />
        </>
      }
    />
  );
}

export function WorkflowRunView({
  run,
  transcriptDir,
  loading,
}: {
  run: WorkflowRunState | null;
  transcriptDir: string | undefined;
  loading: boolean;
}): JSX.Element {
  if (!run) {
    return (
      <div className="flex items-center gap-2 py-6 text-s fg-secondary">
        {loading ? (
          <>
            <LoadingSpinner tone="active" /> Loading workflow…
          </>
        ) : (
          'Workflow details are not available yet.'
        )}
      </div>
    );
  }

  const doneCount = run.agents.filter((a) => a.state === 'done').length;

  // Fall back to a single synthetic phase when a run-state reports agents but
  // no phase records, so agents never silently vanish.
  const effectivePhases: WorkflowPhaseInfo[] =
    run.phases.length > 0
      ? run.phases
      : run.agents.length > 0
        ? [{ title: 'Agents' }]
        : [];

  // Assign every agent to exactly one phase bucket (prefer a phase-title match,
  // then a 1-based phaseIndex match). Unmatched agents fall into the last phase
  // so none silently vanish, and no agent renders under two phases.
  const agentsByPhase: WorkflowAgentProgress[][] = effectivePhases.map(
    () => [],
  );
  for (const agent of run.agents) {
    let target = effectivePhases.findIndex((p) => p.title === agent.phaseTitle);
    if (
      target < 0 &&
      agent.phaseIndex >= 1 &&
      agent.phaseIndex <= effectivePhases.length
    ) {
      target = agent.phaseIndex - 1;
    }
    if (target < 0) {
      target = effectivePhases.length - 1;
    }
    if (target >= 0) {
      agentsByPhase[target].push(agent);
    }
  }

  return (
    <Stack gap="group">
      {/* Aggregate header: counts only, recorded. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs fg-secondary">
        <span>
          {doneCount}/{run.agents.length || run.agentCount || 0} agents done
        </span>
        {run.totalTokens != null && run.totalTokens > 0 && (
          <span>{formatTokenCount(run.totalTokens)} tokens</span>
        )}
        {run.totalToolCalls != null && run.totalToolCalls > 0 && (
          <span>{run.totalToolCalls} tool calls</span>
        )}
        {run.durationMs != null && run.durationMs > 0 && (
          <span>{formatDuration(run.durationMs)}</span>
        )}
      </div>

      {/* Phases → agents. Agent labels, prompts, tool activity, results, and
          transcripts are conversation content: blocked from session replay. */}
      <div className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex flex-col gap-3`}>
        {effectivePhases.map((phase, phaseIndex) => {
          const phaseAgents = agentsByPhase[phaseIndex] ?? [];
          return (
            <div
              key={`${phase.title}-${phaseIndex}`}
              className="flex flex-col gap-1.5"
            >
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-semibold fg-primary/70">
                  {phase.title}
                </span>
                {phase.detail && (
                  <span className="truncate text-2xs fg-secondary">
                    {phase.detail}
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                {phaseAgents.map((agent) => (
                  <WorkflowAgentBlock
                    key={agent.agentId}
                    agent={agent}
                    transcriptDir={transcriptDir}
                  />
                ))}
                {phaseAgents.length === 0 && (
                  <EmptyStateRow title="No agents yet." />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Final result */}
      {run.result && (
        <Stack gap="tight">
          <div className="text-xs font-medium fg-secondary">Result</div>
          <Surface variant="inset" className="max-w-none">
            <div
              className={`prose prose-sm dark:prose-invert break-words px-3 py-2 ${POSTHOG_REPLAY_BLOCK_CLASS}`}
            >
              <Markdown>{run.result}</Markdown>
            </div>
          </Surface>
        </Stack>
      )}
    </Stack>
  );
}
