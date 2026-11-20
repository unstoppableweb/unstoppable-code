import type { JSX } from 'react';
import type { McpRowHealthModel } from '../lib/mcp-row-health';
import { Dot } from './Badge';
import { Tooltip } from './Tooltip';
import { AlertTriangle, CheckIcon } from '../icons/AppIcons';
import { LoadingSpinner } from './LoadingSpinner';
import { useItemStateMarks } from './ItemStateMark';

const DOT_TONE = {
  positive: 'success',
  destructive: 'danger',
  neutral: 'filter',
} as const;

const TONE_CLASS = {
  positive: 'fg-success',
  destructive: 'fg-destructive',
  neutral: 'fg-secondary',
} as const;

export interface McpRowHealthProps {
  readonly name: string;
  readonly model: McpRowHealthModel;
  readonly testId: string;
  /** The check time, already formatted for this host. */
  readonly checkedLabel?: string;
}

export function McpRowAttention({
  name,
  label,
  action,
  checkedLabel,
  testId,
  instruction: instructionOverride,
  showLabel = false,
}: {
  readonly name: string;
  readonly label: string;
  readonly action: McpRowHealthModel['action'];
  readonly checkedLabel?: string;
  readonly testId: string;
  /** Replaces the sentence that says where to fix it. */
  readonly instruction?: string;
  /** New Customize: the callout says its label in plain text. */
  readonly showLabel?: boolean;
}): JSX.Element {
  const instruction =
    instructionOverride ??
    (action === 'connect'
      ? `Open ${name} to sign in.`
      : action === 'reconnect'
        ? `Open ${name} to reconnect.`
        : `Open ${name} for details.`);
  const message = `${label}. ${instruction}${checkedLabel ? ` ${checkedLabel}.` : ''}`;
  return (
    <Tooltip
      label={message}
      clamp={false}
      className="pointer-events-auto"
      showOnPress
      replayBlock
    >
      <span
        role="img"
        tabIndex={0}
        aria-label={message}
        data-testid={testId}
        className={`focus-ring focus-ring-inset inline-flex shrink-0 items-center justify-center rounded-sm pointer-coarse:min-h-6 pointer-coarse:min-w-6 ${showLabel ? 'gap-1 fg-primary' : 'fg-warning'}`}
        onKeyDown={(event): void => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.currentTarget.click();
        }}
      >
        <AlertTriangle
          width={13}
          height={13}
          aria-hidden="true"
          className={showLabel ? 'shrink-0 fg-warning' : undefined}
        />
        {showLabel && <span>{label}</span>}
      </span>
    </Tooltip>
  );
}

/** Health for the row's subtitle, with a contextual icon for actionable warnings. */
export function McpRowHealth({
  name,
  model,
  testId,
  checkedLabel,
}: McpRowHealthProps): JSX.Element {
  // New Customize: the dot carries the color; the text stays plain.
  const neutralText = useItemStateMarks();
  // New Customize says the warning in text, so a sign-in with nothing to
  // click still reads as one without opening the tooltip.
  if (model.tone === 'attention')
    return (
      <McpRowAttention
        name={name}
        label={model.text}
        action={model.action}
        checkedLabel={checkedLabel}
        testId={testId}
        showLabel={neutralText}
      />
    );
  return (
    <Tooltip
      label={checkedLabel}
      clamp={false}
      className="pointer-events-auto"
      disabled={checkedLabel === undefined}
    >
      <span
        role="status"
        data-testid={testId}
        className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs ${neutralText ? 'fg-secondary' : TONE_CLASS[model.tone]}`}
      >
        <Dot tone={DOT_TONE[model.tone]} data-testid={`${testId}-dot`} />
        <span>{model.text}</span>
      </span>
    </Tooltip>
  );
}

/**
 * New Customize's feedback for a Test connection the person started
 * (Sergii's QA): "Checking…" with a spinner while it runs, then a green
 * "Connected" for a few seconds. A failure shows the row's usual error
 * state instead; background checks show nothing.
 */
export function McpRowCheckFeedback({
  kind,
  testId,
}: {
  readonly kind: 'checking' | 'connected';
  readonly testId: string;
}): JSX.Element {
  return (
    <span
      role="status"
      data-testid={testId}
      data-check-feedback={kind}
      className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs fg-secondary"
    >
      {kind === 'checking' ? (
        <LoadingSpinner sizePx={12} decorative />
      ) : (
        <CheckIcon size="xs" aria-hidden className="fg-success" />
      )}
      <span>{kind === 'checking' ? 'Checking…' : 'Connected'}</span>
    </span>
  );
}
