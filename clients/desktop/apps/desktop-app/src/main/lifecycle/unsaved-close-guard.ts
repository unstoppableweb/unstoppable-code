/**
 * Main-side guard that asks the main-window renderer before a window close or
 * app quit would drop unsaved workflow edits.
 *
 * The renderer reports a dirty flag. While it is set, a close or quit is
 * prevented and the renderer is asked to show its unsaved-changes dialog. The
 * renderer answers in two steps: an acknowledgement once the dialog is shown,
 * then the user's decision. The acknowledgement timeout only covers a dead or
 * hung renderer; once the dialog is shown the guard waits for the user, so a
 * slow reader never loses their edits to a timer.
 *
 * With nothing reported dirty the guard never intercepts, so close and quit
 * stay immediate.
 */

export type UnsavedCloseReason = 'close' | 'quit';

export interface UnsavedCloseRequest {
  requestId: string;
  reason: UnsavedCloseReason;
}

export interface ShouldInterceptUnsavedCloseInput {
  dirty: boolean;
  alreadyConfirmed: boolean;
  quitting: boolean;
  hidingToTray: boolean;
}

/**
 * Close-to-tray keeps the renderer alive, and a quit already in progress has
 * passed its own check, so neither is intercepted.
 */
export function shouldInterceptUnsavedClose(
  input: ShouldInterceptUnsavedCloseInput,
): boolean {
  if (!input.dirty) return false;
  if (input.alreadyConfirmed) return false;
  if (input.quitting) return false;
  if (input.hidingToTray) return false;
  return true;
}

export interface PreventableEvent {
  preventDefault(): void;
}

export interface UnsavedCloseGuardDeps {
  /**
   * Shows and focuses the main window if it is hidden or minimized, so the
   * dialog is not raised into an invisible window. Called before asking.
   */
  revealWindow: () => void;
  /**
   * Sends the request to the main-window renderer. Returns false when there is
   * no live renderer to ask.
   */
  sendRequest: (request: UnsavedCloseRequest) => boolean;
  ackTimeoutMs?: number;
  createRequestId?: () => string;
  /** Every actual dirty-state transition, including renderer disappearance. */
  onDirtyChange?: (dirty: boolean) => void;
}

export interface InterceptOptions {
  quitting: boolean;
  hidingToTray: boolean;
}

export interface UnsavedCloseGuard {
  setDirty(dirty: boolean): void;
  isDirty(): boolean;
  isPending(): boolean;
  /**
   * Prevents `event` and asks the renderer when the close or quit would drop
   * unsaved edits. `resume` repeats the close or quit once the user proceeds.
   * Returns true when the event was intercepted.
   */
  intercept(
    event: PreventableEvent,
    reason: UnsavedCloseReason,
    options: InterceptOptions,
    resume: () => void,
  ): boolean;
  handleShown(requestId: string): void;
  handleDecision(requestId: string, proceed: boolean): void;
  /** The renderer was destroyed, crashed or navigated away. */
  handleRendererGone(): void;
}

export const UNSAVED_CLOSE_ACK_TIMEOUT_MS = 3000;

interface PendingPrompt {
  requestId: string;
  reason: UnsavedCloseReason;
  resume: () => void;
  shown: boolean;
  ackTimer: ReturnType<typeof setTimeout> | null;
}

let requestCounter = 0;

function defaultRequestId(): string {
  requestCounter += 1;
  return `unsaved-close-${Date.now()}-${requestCounter}`;
}

export function createUnsavedCloseGuard(
  deps: UnsavedCloseGuardDeps,
): UnsavedCloseGuard {
  const ackTimeoutMs = deps.ackTimeoutMs ?? UNSAVED_CLOSE_ACK_TIMEOUT_MS;
  const createRequestId = deps.createRequestId ?? defaultRequestId;

  let dirty = false;
  // One-shot: set when the user chose to proceed and consumed by the next
  // close or quit check. If the resumed close is cancelled before it reaches
  // the guard, the flag expires so a later close asks again.
  let confirmed = false;
  let confirmedTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: PendingPrompt | null = null;

  function setDirty(next: boolean): void {
    if (dirty === next) return;
    dirty = next;
    deps.onDirtyChange?.(dirty);
  }

  function clearConfirmed(): void {
    confirmed = false;
    if (confirmedTimer !== null) clearTimeout(confirmedTimer);
    confirmedTimer = null;
  }

  function settle(proceed: boolean): void {
    const prompt = pending;
    if (!prompt) return;
    pending = null;
    if (prompt.ackTimer !== null) clearTimeout(prompt.ackTimer);
    if (!proceed) return;
    clearConfirmed();
    confirmed = true;
    confirmedTimer = setTimeout(clearConfirmed, ackTimeoutMs);
    prompt.resume();
  }

  return {
    setDirty,
    isDirty(): boolean {
      return dirty;
    },
    isPending(): boolean {
      return pending !== null;
    },
    intercept(event, reason, options, resume): boolean {
      if (pending) {
        // A prompt is already open: hold this close or quit without asking
        // again. A quit outranks a close, so proceeding then quits.
        event.preventDefault();
        if (reason === 'quit' && pending.reason === 'close') {
          pending.reason = 'quit';
          pending.resume = resume;
        }
        return true;
      }
      const alreadyConfirmed = confirmed;
      clearConfirmed();
      if (
        !shouldInterceptUnsavedClose({
          dirty,
          alreadyConfirmed,
          quitting: options.quitting,
          hidingToTray: options.hidingToTray,
        })
      ) {
        return false;
      }
      event.preventDefault();
      const prompt: PendingPrompt = {
        requestId: createRequestId(),
        reason,
        resume,
        shown: false,
        ackTimer: null,
      };
      pending = prompt;
      deps.revealWindow();
      const sent = deps.sendRequest({ requestId: prompt.requestId, reason });
      if (!sent) {
        settle(true);
        return true;
      }
      prompt.ackTimer = setTimeout(() => {
        if (pending === prompt && !prompt.shown) {
          settle(true);
        }
      }, ackTimeoutMs);
      return true;
    },
    handleShown(requestId: string): void {
      if (!pending || pending.requestId !== requestId) return;
      pending.shown = true;
      if (pending.ackTimer !== null) clearTimeout(pending.ackTimer);
      pending.ackTimer = null;
    },
    handleDecision(requestId: string, proceed: boolean): void {
      if (!pending || pending.requestId !== requestId) return;
      if (proceed) setDirty(false);
      settle(proceed);
    },
    handleRendererGone(): void {
      setDirty(false);
      settle(true);
    },
  };
}
