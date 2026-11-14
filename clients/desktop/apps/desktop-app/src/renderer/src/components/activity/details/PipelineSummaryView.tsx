import { useMemo, useState, type JSX } from 'react';
import type {
  ExecutionState,
  PipelineAdvisorSnapshot,
} from '@canopy/execution-engine/types/pipeline';
import { shouldPromoteAdvisor } from '@/lib/pipelineDetailsView';
import { AgentAssistantIcon, ChevronIcon } from '@canopy/ui-shared/icons';
import { Stack, Badge, Surface } from '@canopy/ui-shared/components';
import {
  PipelineFlowDiagram,
  type PipelineFlowSource,
} from '../../pipeline/flow/PipelineFlowDiagram';
import {
  AdvisorCompactStatus,
  AdvisorHeaderAction,
  AdvisorSection,
} from './PipelineAdvisorDetail';
import { PipelineSummaryBar } from './PipelineSummaryBar';
import {
  advisorHealthBadgeTone,
  isPipelineExecutionActiveStatus,
} from '../utils';

interface PipelineSummaryViewProps {
  state: ExecutionState;
  jobOrder: string[];
  advisorSnapshot?: PipelineAdvisorSnapshot;
  advisorRunning: boolean;
  onRunAdvisor: () => void;
  onSelectJob: (jobId: string) => void;
  reportSlot: JSX.Element;
  /** The owned panel's run-cost preview, when the run has observed cost. */
  costPreviewSlot?: JSX.Element | null;
  advisorStartError?: string | null;
  /**
   * Hide the adaptive advisor block entirely (archived read-only executions
   * cannot run the Pipeline Advisor).
   */
  hideAdvisor?: boolean;
}

function AdaptiveAdvisor({
  state,
  advisorSnapshot,
  advisorRunning,
  onRunAdvisor,
  advisorStartError,
}: {
  state: ExecutionState;
  advisorSnapshot?: PipelineAdvisorSnapshot;
  advisorRunning: boolean;
  onRunAdvisor: () => void;
  advisorStartError?: string | null;
}): JSX.Element {
  const promote = shouldPromoteAdvisor(advisorSnapshot);
  // Start expanded when health needs attention, or when there is no snapshot
  // yet (so the "Run Advisor" affordance is immediately visible). The user can
  // collapse/expand freely from there.
  const [expanded, setExpanded] = useState(promote || !advisorSnapshot);
  const headerHealth = advisorSnapshot?.latestReport?.health?.status;

  return (
    <Surface variant="inset" data-testid="pipeline-summary-advisor">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button
          type="button"
          onClick={(): void => setExpanded((v) => !v)}
          aria-expanded={expanded}
          data-testid="pipeline-summary-advisor-toggle"
          className="focus-ring -mx-1 flex flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left"
        >
          <AgentAssistantIcon
            size="sm"
            className="shrink-0 fg-info"
            aria-hidden="true"
          />
          <span className="text-s font-medium fg-primary">
            Workflow Advisor
          </span>
          {headerHealth ? (
            <Badge tone={advisorHealthBadgeTone(headerHealth)}>
              {headerHealth}
            </Badge>
          ) : null}
          <span className="flex-1" />
          <ChevronIcon open={expanded} />
        </button>
        <AdvisorHeaderAction
          snapshot={advisorSnapshot}
          pipelineStatus={state.status}
          running={advisorRunning}
          onRun={onRunAdvisor}
        />
      </div>
      {expanded ? (
        <Surface variant="section" boundary="top">
          <div className="px-4 pb-4 pt-3">
            <AdvisorSection
              snapshot={advisorSnapshot}
              startedAt={state.started_at}
              pipelineStatus={state.status}
              running={advisorRunning}
              onRun={onRunAdvisor}
              startError={advisorStartError}
              hideHealthBadge
            />
          </div>
        </Surface>
      ) : null}
    </Surface>
  );
}

/**
 * Pipeline details "Summary" view: condensed run metadata, an adaptive advisor
 * block that promotes itself to an expanded report only when health needs
 * attention, the execution flow diagram, and the report slot.
 */
export function PipelineSummaryView({
  state,
  jobOrder,
  advisorSnapshot,
  advisorRunning,
  onRunAdvisor,
  onSelectJob,
  reportSlot,
  costPreviewSlot,
  advisorStartError,
  hideAdvisor = false,
}: PipelineSummaryViewProps): JSX.Element {
  const flowSource = useMemo<PipelineFlowSource>(
    () => ({ kind: 'execution', state, jobOrder }),
    [state, jobOrder],
  );

  // While the run is still in progress, surface the advisor ETA in the
  // "Completed" metadata slot (matching the prior details-modal behavior).
  const completedSlot =
    !hideAdvisor &&
    isPipelineExecutionActiveStatus(state.status) &&
    advisorSnapshot ? (
      <AdvisorCompactStatus
        snapshot={advisorSnapshot}
        pipelineStatus={state.status}
        running={advisorRunning}
        onRun={onRunAdvisor}
      />
    ) : undefined;

  return (
    <Stack gap="group" data-testid="pipeline-summary-view">
      <PipelineSummaryBar state={state} completedSlot={completedSlot} />
      {costPreviewSlot}
      {!hideAdvisor && (
        <AdaptiveAdvisor
          state={state}
          advisorSnapshot={advisorSnapshot}
          advisorRunning={advisorRunning}
          onRunAdvisor={onRunAdvisor}
          advisorStartError={advisorStartError}
        />
      )}
      <Surface variant="inset" className="overflow-hidden">
        <Surface variant="section" boundary="bottom">
          <div className="px-4 py-2 text-xs font-medium fg-secondary">Flow</div>
        </Surface>
        <div className="h-80">
          <PipelineFlowDiagram
            source={flowSource}
            onSelectJob={onSelectJob}
            onSelectStep={(jobId): void => onSelectJob(jobId)}
          />
        </div>
      </Surface>
      {reportSlot}
    </Stack>
  );
}
