import type { JSX } from 'react';
import type { McpRowHealthModel } from '../lib/mcp-row-health';
import { Dot } from './Badge';
import { Tooltip } from './Tooltip';
import { AlertTriangle } from '../icons/AppIcons';

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
}: {
  readonly name: string;
  readonly label: string;
  readonly action: McpRowHealthModel['action'];
  readonly checkedLabel?: string;
  readonly testId: string;
}): JSX.Element {
  const instruction =
    action === 'connect'
      ? `Open ${name} to sign in.`
      : action === 'reconnect'
        ? `Open ${name} to reconnect.`
        : `Open ${name} for details.`;
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
        className="focus-ring focus-ring-inset inline-flex shrink-0 items-center justify-center rounded-sm fg-warning pointer-coarse:min-h-6 pointer-coarse:min-w-6"
        onKeyDown={(event): void => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.currentTarget.click();
        }}
      >
        <AlertTriangle width={13} height={13} aria-hidden="true" />
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
  if (model.tone === 'attention')
    return (
      <McpRowAttention
        name={name}
        label={model.text}
        action={model.action}
        checkedLabel={checkedLabel}
        testId={testId}
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
        className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs ${TONE_CLASS[model.tone]}`}
      >
        <Dot tone={DOT_TONE[model.tone]} data-testid={`${testId}-dot`} />
        <span>{model.text}</span>
      </span>
    </Tooltip>
  );
}
