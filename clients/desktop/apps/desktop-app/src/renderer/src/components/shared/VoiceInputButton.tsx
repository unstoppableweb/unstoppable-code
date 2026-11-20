import type { JSX } from 'react';
import type { VoiceSessionState } from '../../lib/voice/voice-types';
import { LoadingSpinner } from './loading/spinners/LoadingSpinner';
import { Button, Tooltip } from '@canopy/ui-shared';
import { MicIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  ComposerIconButton,
  type ComposerIconButtonTone,
} from './ComposerIconButton';

interface VoiceInputButtonProps {
  state: VoiceSessionState;
  error: string | null;
  onStart: () => void;
  onStop: () => void;
  disabled?: boolean;
  /** Uses the 32px capsule geometry shared by the Home composer toolbar. */
  capsule?: boolean;
  /**
   * The composer's primary action while the draft is empty: the send
   * button's solid accent circle. Listening, starting and errors keep their
   * own tones so the state still reads.
   */
  primary?: boolean;
  /** Its keyboard shortcut, shown in the tooltip while it can start. */
  shortcut?: string;
  /**
   * The speech model is downloading for this composer (CAN-7341): the
   * starting look, labelled for the download, and clicks do nothing.
   */
  preparing?: boolean;
}

const PREPARING_LABEL = 'Downloading the speech model…';

export function VoiceInputButton({
  state,
  error,
  onStart,
  onStop,
  disabled = false,
  capsule = false,
  primary = false,
  shortcut,
  preparing = false,
}: VoiceInputButtonProps): JSX.Element {
  const isActive = state === 'listening' || state === 'connecting';

  const handleClick = (): void => {
    if (disabled || preparing) {
      return;
    }
    if (isActive) {
      onStop();
    } else {
      onStart();
    }
  };

  const title = disabled
    ? 'Voice dictation is unavailable in terminal mode'
    : preparing
      ? PREPARING_LABEL
      : state === 'error' && error
        ? error
        : state === 'listening'
          ? 'Stop dictation'
          : state === 'connecting'
            ? 'Starting microphone…'
            : 'Start voice dictation';

  // Idle, the tooltip names the action and its key; every other state keeps
  // the state readout (listening, starting, error).
  const idle =
    !disabled &&
    !preparing &&
    (state === 'idle' || (state === 'error' && !error));
  const tooltipLabel = idle ? 'Dictate' : title;
  const tooltipShortcut = idle ? shortcut : undefined;

  // Listening is the destructive tone held active (the wash stays on); an
  // error rests in it; starting up is pending, with no hover feedback.
  const tone: ComposerIconButtonTone = preparing
    ? 'pending'
    : state === 'listening' || state === 'error'
      ? 'destructive'
      : state === 'connecting'
        ? 'pending'
        : // At rest the mic takes the primary ink, like the + beside it.
          'strong';

  // Rich tooltip, not a native `title`: the native one lags on macOS and the
  // label doubles as the state readout (listening / error) that must appear
  // the moment the pointer lands (CAN-2799).
  if (primary && tone === 'strong') {
    return (
      <Tooltip
        label={tooltipLabel}
        {...(tooltipShortcut ? { shortcut: tooltipShortcut } : {})}
      >
        <Button
          variant="primary"
          iconOnly
          data-testid="voice-input-button"
          data-state={state}
          data-emphasis="primary"
          onClick={handleClick}
          disabled={disabled}
          aria-label={title}
          aria-pressed={false}
        >
          <MicIcon size="sm" />
        </Button>
      </Tooltip>
    );
  }

  return (
    <Tooltip
      label={tooltipLabel}
      {...(tooltipShortcut ? { shortcut: tooltipShortcut } : {})}
    >
      <ComposerIconButton
        tone={tone}
        active={state === 'listening'}
        capsule={capsule}
        data-testid="voice-input-button"
        data-state={preparing ? 'preparing' : state}
        onClick={handleClick}
        disabled={disabled}
        aria-label={title}
        aria-pressed={state === 'listening'}
        {...(preparing ? { 'aria-busy': true } : {})}
      >
        {preparing || state === 'connecting' ? (
          <LoadingSpinner />
        ) : (
          <MicIcon size="sm" />
        )}
      </ComposerIconButton>
    </Tooltip>
  );
}
