import { type JSX } from 'react';
import { Badge, HoverCard } from '@canopy/ui-shared/components';
import { AgentAssistantIcon } from '@canopy/ui-shared/icons';
import type {
  ExecutionSummary,
  PipelineAdvisorInefficiency,
  PipelineAdvisorReport,
  PipelineAdvisorSnapshot,
} from '@canopy/execution-engine/types/pipeline';
import {
  advisorErrorIsStale,
  formatAdvisorEta,
  usePipelineAdvisorEtaNow,
} from './PipelineAdvisorEta';
import { PipelineAdvisorMarkdownText } from './PipelineAdvisorMarkdown';

export function AdvisorEtaStatus({
  snapshot,
  pipelineStatus,
  interactive = true,
}: {
  snapshot?: PipelineAdvisorSnapshot;
  pipelineStatus?: ExecutionSummary['status'];
  interactive?: boolean;
}): JSX.Element | null {
  const etaNowMs = usePipelineAdvisorEtaNow(Boolean(snapshot?.latestReport));
  if (!snapshot) {
    return null;
  }
  const etaText =
    formatAdvisorEta(snapshot, pipelineStatus, etaNowMs) ?? 'Advisor pending';
  const stale = advisorErrorIsStale(snapshot);
  // Shared pipeline-row status badge: active tint while the advisor is
  // healthy, the warning tint once its last update failed.
  // Hover or keyboard focus shows the health/inefficiency preview.
  return (
    <HoverCard
      disabled={!interactive}
      content={
        <AdvisorPreviewContent
          snapshot={snapshot}
          pipelineStatus={pipelineStatus}
          currentTimeMs={etaNowMs}
        />
      }
      surfacePadding="card"
      surfaceClassName="w-70"
    >
      <span
        tabIndex={interactive ? 0 : undefined}
        role="status"
        aria-label="Workflow Advisor ETA"
        className={interactive ? 'focus-ring inline-flex' : 'inline-flex'}
      >
        <Badge tone={stale ? 'warning' : 'info'}>
          <AgentAssistantIcon size="sm" />
          <span>{etaText}</span>
          {stale ? <span aria-hidden="true">!</span> : null}
        </Badge>
      </span>
    </HoverCard>
  );
}

function severityLabel(
  severity: PipelineAdvisorInefficiency['severity'],
): string {
  switch (severity) {
    case 'critical':
      return 'Critical';
    case 'warning':
      return 'Warning';
    case 'info':
    default:
      return 'Info';
  }
}

function AdvisorPreviewContent({
  snapshot,
  pipelineStatus,
  currentTimeMs,
}: {
  snapshot: PipelineAdvisorSnapshot;
  pipelineStatus?: ExecutionSummary['status'];
  currentTimeMs: number;
}): JSX.Element {
  const report: PipelineAdvisorReport | undefined = snapshot.latestReport;
  const stale = advisorErrorIsStale(snapshot);
  const healthSummary =
    report?.health.summary ??
    (stale
      ? 'Advisor update failed before a health assessment.'
      : 'Waiting for first assessment.');
  const etaText =
    formatAdvisorEta(snapshot, pipelineStatus, currentTimeMs) ??
    'Advisor pending';
  const inefficiencies = report?.inefficiencies ?? [];
  const errorMessage = stale ? snapshot.lastError?.message : undefined;

  return (
    <span className="flex flex-col gap-1 leading-snug">
      <span className="block text-2xs font-semibold fg-secondary">
        Workflow Advisor
      </span>
      <span className="block">
        <span className="block text-3xs font-medium fg-secondary/70">
          Health
        </span>
        <PipelineAdvisorMarkdownText className="mt-0.5 block break-words fg-primary/85">
          {healthSummary}
        </PipelineAdvisorMarkdownText>
      </span>
      <span className="block">
        <span className="block text-3xs font-medium fg-secondary/70">ETA</span>
        <span className="mt-0.5 block break-words fg-primary/85">
          {etaText}
        </span>
      </span>
      <span className="block">
        <span className="block text-3xs font-medium fg-secondary/70">
          Inefficiencies
        </span>
        {inefficiencies.length === 0 ? (
          <span className="mt-0.5 block fg-primary/85">
            No inefficiencies flagged.
          </span>
        ) : (
          <span className="mt-0.5 flex flex-col gap-0.5">
            {inefficiencies.slice(0, 2).map((item, index) => (
              <span
                key={`${item.title}-${index}`}
                className="block break-words"
              >
                <span className="font-medium fg-primary/90">
                  {severityLabel(item.severity)}:
                </span>{' '}
                <PipelineAdvisorMarkdownText className="fg-primary/80">
                  {item.title}
                </PipelineAdvisorMarkdownText>
              </span>
            ))}
          </span>
        )}
      </span>
      {errorMessage ? (
        <span className="block break-words fg-warning">
          Advisor update failed: {errorMessage}
        </span>
      ) : null}
    </span>
  );
}
