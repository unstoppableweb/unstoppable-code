import { ControlButton } from '@canopy/ui-shared/components';
import { DeferredToolOutput } from '@canopy/ui-app';
import { useContext, useState, type JSX } from 'react';
import { isPairedComputerId } from '@canopy/protocol/authority-qualified-id';
import { ChatMarkdownFileTargetContext } from './chat-markdown-file-target';
import { useWorkflowRun } from '@/hooks/useWorkflowRun';
import { WorkflowRunView } from '../activity/WorkflowRunView';
import { WorkflowIcon } from '../activity/WorkflowIcon';
import { ThinkingSpinner } from '../shared/loading/spinners/ThinkingSpinner';
import { ChevronIcon } from '@canopy/ui-shared/icons';
import type { ToolResult } from './types';
import { Surface } from '@canopy/ui-shared/components';

const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'canceled',
  'stopped',
]);

export function WorkflowBlock({
  toolUseId,
  workflowName,
  summary,
  runId,
  transcriptDir,
  result,
}: {
  workflowName: string;
  summary: string;
  runId?: string;
  transcriptDir?: string;
  result?: ToolResult;
  /** The step's identity; a turn summary lands on its row by this id. */
  toolUseId?: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  // The chat card has no Canopy process-status signal, so derive terminality
  // from the run-state itself (passed false here; the hook still stops when the
  // run JSON reports a terminal status).
  const target = useContext(ChatMarkdownFileTargetContext);
  const isPairedScope = target !== null && isPairedComputerId(target.projectId);
  const effectiveTranscriptDir = isPairedScope ? undefined : transcriptDir;
  const effectiveRunId = isPairedScope ? undefined : runId;
  const { run, loading } = useWorkflowRun(
    effectiveTranscriptDir,
    effectiveRunId,
    false,
  );

  const launched = Boolean(effectiveRunId);
  const status = run?.status;
  const isRunning =
    launched && (!status || !TERMINAL_STATUSES.has(status.toLowerCase()));
  const doneCount = run?.agents.filter((a) => a.state === 'done').length ?? 0;
  const total = run?.agents.length ?? run?.agentCount ?? 0;

  return (
    <div className="py-1 empty:hidden">
      <Surface
        data-testid="workflow-block"
        data-tool-use-id={toolUseId}
        data-launched={launched ? 'true' : 'false'}
        variant="group"
      >
        <ControlButton
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          presentation="workflow-chat-toggle"
        >
          <span className="flex-shrink-0">
            <ChevronIcon open={expanded} />
          </span>
          <span className="flex-shrink-0 fg-special">
            <WorkflowIcon />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="text-xs font-semibold fg-primary/80">
                Workflow
              </span>
              <span className="truncate text-xs fg-secondary">
                {workflowName}
              </span>
              {isRunning && (
                <ThinkingSpinner tone="accent" className="flex-shrink-0" />
              )}
            </span>
            {summary && (
              <span className="mt-0.5 block truncate text-2xs fg-secondary">
                {summary}
              </span>
            )}
          </span>
          {launched && total > 0 && (
            <span className="flex-shrink-0 text-2xs fg-secondary">
              {doneCount}/{total}
            </span>
          )}
        </ControlButton>
        {expanded && (
          <Surface variant="section" boundary="top" padding="section-compact">
            {isPairedScope ? (
              <div className="py-2 text-xs fg-secondary">
                Workflow details are on the other computer.
              </div>
            ) : !launched ? (
              <div className="py-2 text-xs fg-secondary">
                Launching workflow…
              </div>
            ) : (
              <WorkflowRunView
                run={run}
                transcriptDir={effectiveTranscriptDir}
                loading={loading}
              />
            )}
          </Surface>
        )}
        {result?.fullOutputRef && result.messageId && result.toolUseId && (
          // The run view above owns the visible output; the viewer only adds the
          // full-output control, so it gets an empty preview.
          <div data-testid="chat-deferred-output-host">
            <DeferredToolOutput
              identity={{
                kind: 'reference',
                reference: result.fullOutputRef,
                messageId: result.messageId,
                toolUseId: result.toolUseId,
              }}
              preview=""
              isError={result.isError}
            />
          </div>
        )}
      </Surface>
    </div>
  );
}
