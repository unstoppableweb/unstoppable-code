import { getModelCatalogProviderLabel } from '@canopy/ui-shared';
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';
import type { ResumeReadinessSummary } from './resume-availability';
import { interruptedWorkNouns } from './interrupted-work-copy';

/** `Codex`, `Claude and Codex`, `Claude, Codex, and Cursor`. */
function joinProviderLabels(summary: ResumeReadinessSummary): string {
  const labels = summary.waitingProviders.map(getModelCatalogProviderLabel);
  if (labels.length <= 2) return labels.join(' and ');
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

/** `waiting for Codex reset`, `waiting for Claude and Codex resets`. */
function waitingFor(summary: ResumeReadinessSummary): string {
  const resetNoun = summary.waitingProviders.length === 1 ? 'reset' : 'resets';
  return `waiting for ${joinProviderLabels(summary)} ${resetNoun}`;
}

/**
 * ` (Mon 6:13 PM)` only when every waiting session shares one known reset;
 * otherwise no time, rather than implying the earliest reset clears them all.
 */
function sharedResetSuffix(summary: ResumeReadinessSummary): string {
  if (summary.sharedWaitingResetMs === undefined) return '';
  const label = formatUsageLimitTimeLabel(summary.sharedWaitingResetMs);
  return label ? ` (${label})` : '';
}

/**
 * The Home Continue row's text: `Resume 3 interrupted chats`, or with waiting
 * work `Resume 1 chat · 2 waiting for Codex reset`. Waiting work is counted
 * apart from what can resume now. The accessible label carries the full text
 * because the visible row truncates.
 */
export function interruptedSessionsHomeCopy(summary: ResumeReadinessSummary): {
  label: string;
  accessibleLabel: string;
} {
  const ready = {
    chats: summary.readyChatCount,
    pipelines: summary.readyPipelineCount,
  };
  let label: string;
  if (summary.waitingCount === 0) {
    label = `Resume ${interruptedWorkNouns(
      { chats: summary.chatCount, pipelines: summary.pipelineCount },
      'interrupted',
    )}`;
  } else if (summary.readyCount === 0) {
    label = `${interruptedWorkNouns({
      chats: summary.chatCount,
      pipelines: summary.pipelineCount,
    })} ${waitingFor(summary)}${sharedResetSuffix(summary)}`;
  } else {
    label = `Resume ${interruptedWorkNouns(ready)} · ${summary.waitingCount} ${waitingFor(summary)}${sharedResetSuffix(summary)}`;
  }
  return { label, accessibleLabel: label };
}

/**
 * The text around a single interrupted entry's title on the Home Continue
 * row: `Resume {title}` when it can resume now, else `{title} waiting for
 * Codex reset (Mon 6:13 PM)`. `summary` describes that one entry.
 */
export function interruptedSessionHomeCopy(summary: ResumeReadinessSummary): {
  prefix?: string;
  suffix?: string;
} {
  return summary.waitingCount === 0
    ? { prefix: 'Resume' }
    : { suffix: `${waitingFor(summary)}${sharedResetSuffix(summary)}` };
}

/**
 * The resume dialog's readiness line: `All 3 ready now`, or
 * `0 ready now · 1 waiting for Codex reset` so a fully blocked list still
 * says what it is waiting on.
 */
export function resumeReadinessSummaryText(
  summary: ResumeReadinessSummary,
): string {
  if (summary.waitingCount === 0) {
    return summary.total === 1
      ? '1 ready now'
      : `All ${summary.total} ready now`;
  }
  return `${summary.readyCount} ready now · ${summary.waitingCount} ${waitingFor(summary)}`;
}
