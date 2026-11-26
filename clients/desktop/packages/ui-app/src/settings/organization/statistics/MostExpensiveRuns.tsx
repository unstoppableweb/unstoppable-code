'use client';

import type { JSX } from 'react';
import { ExternalLink } from '@canopy/ui-shared/icons/AppIcons';
import type { TelemetryExpensiveRun } from '@canopy/protocol/telemetry';
import { Badge } from '@canopy/ui-shared';
import { SettingsLink, useSettingsPrivacy } from '../../host';
import {
  formatDurationMs,
  formatRelativeTime,
  formatTokens,
} from '../feed-format';
import { formatUsd } from './format';
import {
  formatEventTypeLabel,
  formatProviderLabel,
  formatTurnStatusLabel,
  turnStatusBadgeTone,
} from './run-display';
import { TextLink, Surface } from '@canopy/ui-shared/components';

interface MostExpensiveRunsProps {
  runs: readonly TelemetryExpensiveRun[];
  /**
   * Set only by the member profile, for an owner with the transcript browser
   * on: each row links to its shared transcript, or says it has none. The
   * Statistics page leaves it unset.
   */
  transcriptOrgId?: string;
}

function TranscriptLink({
  orgId,
  run,
}: {
  readonly orgId: string;
  readonly run: TelemetryExpensiveRun;
}): JSX.Element {
  if (typeof run.transcriptSessionId !== 'string')
    return (
      <span
        className="text-xs whitespace-nowrap fg-tertiary"
        data-testid={`expensive-run-no-transcript-${run.sessionId}`}
      >
        No shared transcript
      </span>
    );
  return (
    <SettingsLink
      href={`/organization/${orgId}/transcripts/sessions/${run.transcriptSessionId}`}
      className="text-xs font-medium whitespace-nowrap fg-accent hover:underline"
      data-testid={`expensive-run-transcript-${run.sessionId}`}
    >
      View transcript
    </SettingsLink>
  );
}

/** Join class names, dropping empty ones so no stray whitespace remains. */
function cx(...classNames: readonly string[]): string {
  return classNames.filter(Boolean).join(' ');
}

/** Join non-empty parts with the standard middot separator. */
function joinParts(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(' · ');
}

/**
 * Top-cost runs panel. Each row foregrounds the highest-value signals — status
 * color and author — alongside the existing cost/PR affordances, then packs the
 * remaining provenance (event type, branch, provider/model, tokens, duration,
 * recency) into two dense muted lines.
 */
export function MostExpensiveRuns({
  runs,
  transcriptOrgId,
}: MostExpensiveRunsProps): JSX.Element {
  // Run titles and author names are user content: keep them out of replays.
  const { blockClassName } = useSettingsPrivacy();
  if (runs.length === 0) {
    return (
      <Surface variant="dashed">
        <p
          className="px-4 py-6 text-center text-s fg-secondary"
          data-testid="expensive-runs-empty"
        >
          No sessions recorded for this range.
        </p>
      </Surface>
    );
  }
  return (
    <ul className="flex flex-col gap-2" data-testid="expensive-runs-list">
      {runs.map((run) => {
        const totalTokens = run.inputTokens + run.outputTokens;
        const tokensValue = totalTokens > 0 ? formatTokens(totalTokens) : null;
        const tokensLabel = tokensValue ? `${tokensValue} tokens` : null;
        const durationLabel = formatDurationMs(run.durationMs);
        // The DB column is non-nullable but nothing prevents a blank/whitespace
        // value, so fall back to 'Unknown' when the trimmed name is empty.
        const authorName = run.authorName?.trim();
        const authorLabel = authorName ? authorName : 'Unknown';
        // Only surface the in/out token breakdown tooltip when there are tokens
        // to break down; otherwise a zero-token run shows a "0 in · 0 out" hint.
        const tokenBreakdown =
          totalTokens > 0
            ? `${run.inputTokens.toLocaleString()} in · ${run.outputTokens.toLocaleString()} out`
            : undefined;
        const turnCountLabel = `${run.turnCount} turn${run.turnCount === 1 ? '' : 's'}`;
        const detailLine = joinParts([
          turnCountLabel,
          formatProviderLabel(run.provider),
          run.model,
          tokensLabel,
          durationLabel,
          formatRelativeTime(run.startedAtIso),
        ]);
        const metaLine = joinParts([
          authorLabel,
          formatEventTypeLabel(run.eventType),
          run.branchName,
        ]);
        return (
          <Surface as="li" variant="card" key={run.sessionId}>
            <div className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge
                    tone={turnStatusBadgeTone(run.status)}
                    data-testid={`expensive-run-status-${run.sessionId}`}
                  >
                    {formatTurnStatusLabel(run.status)}
                  </Badge>
                  <p
                    className={cx(
                      'truncate text-s font-medium fg-primary',
                      blockClassName,
                    )}
                  >
                    {run.label}
                  </p>
                </div>
                <p
                  className={cx(
                    'mt-0.5 truncate text-xs fg-secondary',
                    blockClassName,
                  )}
                >
                  {metaLine}
                </p>
                <p
                  className="mt-0.5 truncate text-xs tabular-nums fg-secondary"
                  title={tokenBreakdown}
                >
                  {detailLine}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-s font-semibold tabular-nums fg-primary">
                  {formatUsd(run.totalCostUsd)}
                </span>
                {run.prUrl && (
                  <TextLink
                    href={run.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    size="xs"
                    emphasis="medium"
                    withIcon
                    data-testid={`expensive-run-pr-${run.sessionId}`}
                  >
                    PR
                    <ExternalLink size={12} aria-hidden="true" />
                  </TextLink>
                )}
                {transcriptOrgId === undefined ? null : (
                  <TranscriptLink orgId={transcriptOrgId} run={run} />
                )}
              </div>
            </div>
          </Surface>
        );
      })}
    </ul>
  );
}
