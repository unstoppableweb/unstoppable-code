'use client';

import type { JSX } from 'react';
import { TerminalIcon } from '../icons/AppIcons';
import { Tooltip } from './Tooltip';
import { ErrorBanner } from './StatusBlocks';

/**
 * Added to the default composer shell in terminal mode (a draft starting with
 * `!`): a dashed warning edge, drawn as an inset outline so the box keeps its
 * size and the content does not move as the mode turns on and off.
 */
export const TERMINAL_MODE_SHELL_CLASS =
  'outline-1 -outline-offset-1 outline-dashed outline-line-attention';

/** The terminal mode edge while the last command could not be sent: red. */
export const TERMINAL_MODE_ERROR_SHELL_CLASS =
  'outline-1 -outline-offset-1 outline-dashed outline-line-destructive';

/**
 * Names terminal mode beside the run button, in the composer's text style
 * and 12px from the button (the gap + keeps to the text on the left). When
 * the last command could not be sent, the error takes the label's place, so
 * no line is added; the command stays in the box to retry or edit.
 *
 * `hint` names where a picked script runs (`Runs in web/apps/web`) when that
 * is not the composer's own directory.
 */
export function TerminalModeLabel({
  error = null,
  hint = null,
}: {
  readonly error?: string | null;
  readonly hint?: string | null;
}): JSX.Element {
  if (error !== null) {
    return (
      <ErrorBanner
        errorSource="chat-input-terminal-mode-error"
        className="mr-1"
        error={error}
        testId="chat-input-terminal-mode-error"
      />
    );
  }
  const label = (
    <span
      data-testid="chat-input-terminal-mode-label"
      className="mr-1 select-none whitespace-nowrap text-s fg-warning"
    >
      Terminal mode
    </span>
  );
  if (hint === null) return label;
  return (
    <>
      <span
        data-testid="chat-input-terminal-mode-hint"
        className="mr-1 min-w-0 select-none truncate text-s fg-tertiary"
        title={hint}
      >
        {hint}
      </span>
      {label}
    </>
  );
}

export interface TerminalRunButtonProps {
  readonly onRun: () => void;
  /** No command typed yet. */
  readonly disabled: boolean;
  /** The last command could not be sent: red rather than warning. */
  readonly failed?: boolean;
  readonly dataTestId?: string;
  readonly tapTarget?: 'compact' | 'touch';
}

/**
 * The composer's trailing action in terminal mode: runs the command in a new
 * terminal. Send's recipe on the warning surface that marks terminal mode;
 * destructive while the last command could not be sent.
 */
export function TerminalRunButton({
  onRun,
  disabled,
  failed = false,
  dataTestId,
  tapTarget = 'compact',
}: TerminalRunButtonProps): JSX.Element {
  return (
    <Tooltip label="Run terminal command">
      <button
        type="button"
        onClick={onRun}
        disabled={disabled}
        data-testid={dataTestId}
        className={`focus-ring inline-flex ${tapTarget === 'touch' ? 'h-11 w-11 lg:h-8 lg:w-8' : 'h-8 w-8'} items-center justify-center rounded-full fg-emphasis transition-transform enabled:active:scale-97 disabled:cursor-not-allowed disabled:bg-muted disabled:fg-tertiary disabled:opacity-100 ${
          failed
            ? 'bg-destructive enabled:hover:bg-destructive-hover'
            : 'bg-warning enabled:hover:bg-warning/90'
        }`}
        aria-label="Run terminal command"
      >
        <TerminalIcon size={16} aria-hidden />
      </button>
    </Tooltip>
  );
}
