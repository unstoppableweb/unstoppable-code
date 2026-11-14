import type { JSX } from 'react';
import { ArrowUp, StopFilledIcon } from '../icons/AppIcons';
import { LoadingSpinner } from './LoadingSpinner';
import { TerminalRunButton } from './TerminalComposerMode';
import { Tooltip } from './Tooltip';
import {
  COMPOSER_STOPPING_LABEL,
  COMPOSER_STOPPING_WAITING_FOR_WAKE_LABEL,
} from './composer-send-button-copy';

/**
 * How large the control's hit area is. `compact` is the 32px pointer control;
 * `touch` keeps a 44px tap target below `lg` and returns to 32px from `lg`
 * up. A host picks this from its own input model, not from the viewport.
 */
export type ComposerSendButtonTapTarget = 'compact' | 'touch';

/**
 * The composer's trailing action, by priority:
 * 1. Terminal mode: run the command (works while streaming too; the command
 *    runs in a new PTY and bypasses the chat queue).
 * 2. Streaming: stop the turn. Typing still queues a follow-up via Enter.
 * 3. Idle: send.
 * A pending model change disables stop and send and shows a spinner, as a
 * stop already sent does until its turn ends.
 */
export type ComposerSendButtonProps =
  | {
      kind: 'terminal';
      onRun: () => void;
      /** No command typed yet. */
      disabled: boolean;
      /** The last command could not be sent: red rather than warning. */
      failed?: boolean;
      dataTestId?: string;
      tapTarget?: ComposerSendButtonTapTarget;
    }
  | {
      kind: 'stop';
      onStop: () => void;
      /** A model change is being applied; stopping waits for it. */
      pending?: boolean;
      /** The first Esc armed the stop; the next press confirms it. */
      armed?: boolean;
      /** Esc can stop this turn from the composer. */
      shortcutReady?: boolean;
      /** The host cannot stop this turn right now. */
      disabled?: boolean;
      /** The stop was sent; the turn hasn't ended yet. */
      stopping?: boolean;
      /**
       * Stopping for a while: still reads Stopping…, and can be pressed to
       * send the stop again.
       */
      stopRetryable?: boolean;
      /**
       * The stop waits for the turn's project to wake before the turn can
       * end: Stopping… says so (CAN-6721).
       */
      stopWaitsForWake?: boolean;
      dataTestId?: string;
      tapTarget?: ComposerSendButtonTapTarget;
    }
  | {
      kind: 'send';
      onSend: () => void;
      /** Nothing to send, or sending is blocked. */
      disabled: boolean;
      /** A model change is being applied; sending waits for it. */
      pending: boolean;
      /** Why sending is blocked, shown in the tooltip. */
      blockedReason?: string;
      dataTestId?: string;
      tapTarget?: ComposerSendButtonTapTarget;
    };

// Size recipes stay whole literals so Tailwind can see every class.
const ROUND_SIZE: Record<ComposerSendButtonTapTarget, string> = {
  compact: 'h-8 w-8',
  touch: 'h-11 w-11 lg:h-8 lg:w-8',
};
// Armed, stop widens into the shared md capsule; it keeps its height and has
// no fixed width.
const CAPSULE_SIZE: Record<ComposerSendButtonTapTarget, string> = {
  compact: 'h-8 gap-1.5 px-3',
  touch: 'h-11 gap-1.5 px-3 lg:h-8',
};

const BASE =
  'focus-ring inline-flex items-center justify-center rounded-full fg-emphasis transition-transform enabled:active:scale-97 disabled:cursor-not-allowed';
// The muted disabled look send and run share, so a disabled control never
// advertises a hover it cannot honour.
const MUTED_DISABLED =
  'disabled:bg-muted disabled:fg-tertiary disabled:opacity-100';

export function ComposerSendButton(
  props: ComposerSendButtonProps,
): JSX.Element {
  const tapTarget = props.tapTarget ?? 'compact';

  if (props.kind === 'terminal') {
    // The shared run button: send's recipe on the warning surface that marks
    // terminal mode; destructive while the last command could not be sent.
    return (
      <TerminalRunButton
        onRun={props.onRun}
        disabled={props.disabled}
        failed={props.failed === true}
        dataTestId={props.dataTestId}
        tapTarget={tapTarget}
      />
    );
  }

  if (props.kind === 'stop')
    return <ComposerStopButton {...props} tapTarget={tapTarget} />;

  const { onSend, disabled, pending, blockedReason, dataTestId } = props;
  return (
    // Ready to send, the tooltip names the action and its key; blocked or
    // pending, it says why instead, so a disabled send explains itself.
    <Tooltip
      label={blockedReason ?? (pending ? 'Updating model' : 'Send')}
      {...(blockedReason || pending ? {} : { shortcut: '↵' })}
    >
      <button
        type="button"
        onClick={onSend}
        disabled={disabled || pending}
        className={`${BASE} ${ROUND_SIZE[tapTarget]} bg-accent enabled:hover:bg-accent/90 ${MUTED_DISABLED}`}
        aria-label="Send message"
        aria-busy={pending}
        data-testid={dataTestId}
      >
        {pending ? (
          <LoadingSpinner dataTestId="chat-model-change-pending" decorative />
        ) : (
          <ArrowUp width={16} height={16} aria-hidden />
        )}
      </button>
    </Tooltip>
  );
}

type ComposerStopButtonProps = Extract<
  ComposerSendButtonProps,
  { kind: 'stop' }
> & { readonly tapTarget: ComposerSendButtonTapTarget };

/** The composer's Stop while a turn runs; see ComposerSendButton. */
function ComposerStopButton(props: ComposerStopButtonProps): JSX.Element {
  const { tapTarget } = props;
  const pending = props.pending ?? false;
  const stopping = !pending && (props.stopping ?? false);
  const waiting = stopping && !(props.stopRetryable ?? false);
  const armed = props.armed ?? false;
  const shortcutReady = props.shortcutReady ?? false;
  // A pending model change outranks the armed Esc: the spinner replaces the
  // label and the control reads as a plain stop until the change lands.
  // A stop already sent reads Stopping… and can't be sent twice until the
  // host says it may be sent again.
  const showArmed = armed && !pending && !stopping;
  const label = pending
    ? 'Updating model'
    : stopping
      ? props.stopWaitsForWake === true
        ? COMPOSER_STOPPING_WAITING_FOR_WAKE_LABEL
        : COMPOSER_STOPPING_LABEL
      : showArmed
        ? 'Press Esc again to stop'
        : 'Stop generation';
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={props.onStop}
        data-testid={props.dataTestId}
        disabled={pending || waiting || (props.disabled ?? false)}
        aria-busy={pending || stopping}
        data-cancel-shortcut-ready={shortcutReady || undefined}
        data-cancel-armed={armed || undefined}
        // The primary action while a turn runs, in send's own recipe.
        className={`${BASE} ${
          showArmed ? CAPSULE_SIZE[tapTarget] : ROUND_SIZE[tapTarget]
        } bg-accent enabled:hover:bg-accent/90 disabled:opacity-40`}
        aria-label={pending ? 'Stop generation' : label}
      >
        {pending ? (
          <LoadingSpinner dataTestId="chat-model-change-pending" decorative />
        ) : waiting ? (
          <LoadingSpinner dataTestId="chat-stop-pending" decorative />
        ) : (
          <>
            <StopFilledIcon size={16} aria-hidden />
            {showArmed && (
              <span className="text-s font-medium leading-none">Esc</span>
            )}
          </>
        )}
      </button>
    </Tooltip>
  );
}
