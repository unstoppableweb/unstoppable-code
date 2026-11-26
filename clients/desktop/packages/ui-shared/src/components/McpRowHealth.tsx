import type { JSX } from 'react';
import type { McpRowHealthModel } from '../lib/mcp-row-health';
import { Dot } from '../primitives/Badge';
import { Tooltip } from '../primitives/Tooltip';
import { ControlButton } from '../primitives/Button';
import { AlertTriangle, CheckIcon } from '../icons/AppIcons';
import { LoadingSpinner } from '../primitives/LoadingSpinner';
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

const MCP_CHECK_FEEDBACK_TEXT = {
  checking: 'Checking…',
  connected: 'Connected',
  failed: "Couldn't connect",
} as const;

export interface McpRowHealthProps {
  readonly name: string;
  readonly model: McpRowHealthModel;
  readonly testId: string;
  /** The check time, already formatted for this host. */
  readonly checkedLabel?: string;
  /**
   * Pass a boolean to give the row a quiet live region that speaks the text
   * only while `true` (a check the person started). Omit it for no region.
   */
  readonly announce?: boolean;
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
      {/* A press shows the tooltip, so it is a button, not an image. */}
      <ControlButton
        presentation="mcp-row-attention"
        aria-label={message}
        data-testid={testId}
      >
        <AlertTriangle
          width={13}
          height={13}
          aria-hidden="true"
          className="shrink-0"
        />
        {showLabel && <span className="fg-primary">{label}</span>}
      </ControlButton>
    </Tooltip>
  );
}

/** Health for the row's subtitle, with a contextual icon for actionable warnings. */
export function McpRowHealth({
  name,
  model,
  testId,
  checkedLabel,
  announce,
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
      {/* Not a live region: a list of rows would announce every background
          check. A check the person starts speaks through `announce` or
          McpRowCheckFeedback. */}
      <span
        data-testid={testId}
        className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs ${neutralText ? 'fg-secondary' : TONE_CLASS[model.tone]}`}
      >
        <Dot tone={DOT_TONE[model.tone]} data-testid={`${testId}-dot`} />
        <span>{model.text}</span>
        {/* Rendered before it has text, so the change is announced. */}
        {announce !== undefined && (
          <span role="status" className="sr-only">
            {announce ? model.text : ''}
          </span>
        )}
      </span>
    </Tooltip>
  );
}

/**
 * New Customize's feedback for a Test connection the person started
 * (Sergii's QA): "Checking…" with a spinner while it runs, then a green
 * "Connected · 2 min ago" that stays until another test or the page closes.
 * A failure beside Sign in is the `failed` kind ("Couldn't connect"): the same
 * status element, so the end of the check is announced. Without Sign in the
 * row's usual error state shows instead; background checks show nothing.
 */
export function McpRowCheckFeedback({
  kind,
  testId,
  checkedAgo,
}: {
  readonly kind: 'checking' | 'connected' | 'failed';
  readonly testId: string;
  /** The finished test's age, already worded ("2 min ago"). */
  readonly checkedAgo?: string;
}): JSX.Element {
  // New Customize: the dot carries the failure color; the text stays plain.
  const neutralText = useItemStateMarks();
  // The age sits outside the live region: its text changes every tick and
  // would re-announce an unchanged result.
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs ${kind === 'failed' && !neutralText ? TONE_CLASS.destructive : 'fg-secondary'}`}
    >
      <span
        role="status"
        data-testid={testId}
        data-check-feedback={kind}
        className="inline-flex items-center gap-1.5"
      >
        {kind === 'checking' ? (
          <LoadingSpinner sizePx={12} decorative />
        ) : kind === 'failed' ? (
          <Dot tone={DOT_TONE.destructive} data-testid={`${testId}-dot`} />
        ) : (
          <CheckIcon size="xs" aria-hidden className="fg-success" />
        )}
        <span>{MCP_CHECK_FEEDBACK_TEXT[kind]}</span>
      </span>
      {kind === 'connected' && checkedAgo !== undefined ? (
        <span data-testid={`${testId}-age`}>· {checkedAgo}</span>
      ) : null}
    </span>
  );
}
