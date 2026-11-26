import { useObservabilityStore } from '@/stores/observabilityStore';
import {
  computeRelevantAccountSnapshots,
  OtherAccountSnapshotsPanel,
} from '@/components/pages/usage/OtherAccountSnapshots';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { CodexLoginState } from '@canopy/desktop-shared/types';
import { toAppError, type AppError } from '@canopy/protocol/app-errors';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import {
  Stack,
  Button,
  ChoiceList,
  ChoiceListRow,
  DialogModal,
} from '@canopy/ui-shared/components';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { copyTextToClipboard } from '@/lib/clipboard';
import { invalidateCodexAuthStatusCache } from '@/hooks/useCodexAuthStatus';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  isRemoteSignIn,
  openSignInLink,
} from '@/lib/remote-control/open-sign-in-link';
import { isProviderSignInLink } from '@canopy/desktop-shared/lib/provider-sign-in-links';

/** Answer to a start while another window's Codex sign-in runs (CAN-6718). */
const ALREADY_RUNNING_COPY =
  'A Codex sign-in is already running on the computer. Try again when it finishes.';

interface CodexLoginModalProps {
  onClose: () => void;
  ownerDocument?: Document;
}

/**
 * Opens the waiting attempt's sign-in page. This computer's own window asks
 * main to open the browser (it holds the browser method's URL); a window that
 * shows another computer opens the device-code page that computer published,
 * in this computer's browser.
 */
function openSignInPage(
  state: CodexLoginState,
  remote: boolean,
  fail: (appError: AppError | undefined, copy: string) => void,
  refuse: (copy: string) => void,
): void {
  if (remote) {
    if (!state.verificationUrl) return;
    // The other computer checked the page before publishing it; this one
    // checks again, so that computer can't send its browser elsewhere.
    if (isProviderSignInLink('codex', state.verificationUrl))
      openSignInLink(state.verificationUrl);
    else
      refuse(
        "The other computer sent a sign-in page that isn't OpenAI's, so it wasn't opened.",
      );
    return;
  }
  void window.api.codexLogin
    .openBrowser()
    .catch((caught: unknown) =>
      fail(
        toAppError(resolveClientAppError(caught)),
        "Couldn't open your browser. Use Open browser to try again.",
      ),
    );
}

export function CodexLoginModal({
  onClose,
  ownerDocument,
}: CodexLoginModalProps): JSX.Element {
  const [state, setState] = useState<CodexLoginState>({
    attemptId: null,
    phase: 'ready',
    activeWorkCount: 0,
  });
  const [error, setError] = useState<InlineFailure | null>(null);
  /** Shows a failure of a step this dialog started; a cancellation shows nothing. */
  const fail = useCallback(
    (appError: AppError | undefined, copy: string): void => {
      if (appError) setError(inlineFailure(appError, copy));
    },
    [],
  );
  // Started from another computer, sign-in uses a device code: the browser
  // method's callback runs on the controlled computer, where nobody is.
  const remote = isRemoteSignIn();
  const initialMethod = remote ? 'chatgptDeviceCode' : 'chatgpt';
  const [method, setMethod] = useState<'chatgpt' | 'chatgptDeviceCode'>(
    initialMethod,
  );
  const [copied, setCopied] = useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const usage = useObservabilityStore((store) => store.usage);
  const initializeObservability = useObservabilityStore(
    (store) => store.initialize,
  );
  useEffect(() => {
    void initializeObservability();
  }, [initializeObservability]);
  useEffect(() => {
    if (!snapshotsOpen) return;
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return (): void => clearInterval(timer);
  }, [snapshotsOpen]);
  const activeSummary = usage.providers.find(
    (provider) => provider.provider === 'codex',
  );
  const snapshots = computeRelevantAccountSnapshots(
    'codex',
    activeSummary?.accountEmail,
    activeSummary?.subscriptionLabel,
    usage.accountSnapshots ?? [],
    nowMs,
  );
  const completed = useRef(false);
  const cancellationScheduled = useRef(false);
  const startPromise = useRef<Promise<CodexLoginState> | null>(null);
  const openedAttempt = useRef<string | null>(null);
  /**
   * The attempt this dialog's own start or cancel answered with. State is
   * pushed to every window, controllers' included, so a pushed state for any
   * other attempt is someone else's sign-in and is ignored.
   */
  const ownAttempt = useRef<string | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const refuse = useCallback((copy: string): void => {
    setError({ error: copy });
  }, []);
  const receive = useCallback(
    (next: CodexLoginState): void => {
      if (next.refusal === 'already-running') {
        refuse(ALREADY_RUNNING_COPY);
        return;
      }
      if (next.attemptId !== null) ownAttempt.current = next.attemptId;
      setState(next);
      if (
        next.phase === 'complete' ||
        (next.phase === 'verification-failed' && next.activeWorkCount > 0)
      ) {
        if (
          next.phase === 'complete' &&
          next.outcome === 'failed' &&
          next.activeWorkCount === 0
        )
          return;
        if (completed.current) return;
        completed.current = true;
        invalidateCodexAuthStatusCache();
        if (next.activeWorkCount > 0)
          useUsageLimitResumePromptStore.getState().openAuthentication(next);
        closeRef.current();
      }
    },
    [refuse],
  );

  /**
   * Pushes that arrive while a start is pending, the latest one per attempt,
   * applied once the start's answer names its attempt. The waiting state with the
   * device code can arrive before the start's answer, which carries only the
   * state when the start returned.
   */
  const earlyStates = useRef<Map<string, CodexLoginState> | null>(null);
  const receiveStartAnswer = useCallback(
    (next: CodexLoginState): void => {
      const early = earlyStates.current;
      earlyStates.current = null;
      receive(next);
      // A kept push for this attempt is no older than the answer.
      const kept =
        next.attemptId === null ? undefined : early?.get(next.attemptId);
      if (kept) receive(kept);
    },
    [receive],
  );

  const cancelAfterStart = useCallback(
    (reportError: boolean): void => {
      if (cancellationScheduled.current) return;
      cancellationScheduled.current = true;
      const pending = startPromise.current ?? Promise.resolve();
      // Cancel once the start settles either way; a failed start already shows
      // its own error.
      void Promise.allSettled([pending])
        .then(() => window.api.codexLogin.cancel())
        .catch((caught: unknown) => {
          if (reportError)
            fail(
              toAppError(resolveClientAppError(caught)),
              "Couldn't cancel. Try again.",
            );
          // Closing the dialog cancels in the background, with nowhere to show
          // a failure.
          else reportClientAppError(caught);
        });
    },
    [fail],
  );

  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.api.codexLogin.onState((next) => {
      if (disposed || next.attemptId === null) return;
      // While a start is pending, its attempt is unknown: a retry starts a
      // new attempt while this dialog still knows the old one.
      const early = earlyStates.current;
      if (early) {
        early.set(next.attemptId, next);
        return;
      }
      if (next.attemptId === ownAttempt.current) receive(next);
    });
    earlyStates.current = new Map();
    const pending = window.api.codexLogin.start({
      confirmPause: false,
      method: initialMethod,
    });
    startPromise.current = pending;
    void pending
      .then((next) => {
        if (!disposed) receiveStartAnswer(next);
      })
      .catch((caught: unknown) => {
        earlyStates.current = null;
        if (!disposed)
          fail(
            toAppError(resolveClientAppError(caught)),
            "Couldn't connect Codex.",
          );
      });
    return (): void => {
      disposed = true;
      unsubscribe();
      if (!completed.current) cancelAfterStart(false);
    };
  }, [cancelAfterStart, fail, initialMethod, receive, receiveStartAnswer]);

  useEffect(() => {
    if (
      state.phase !== 'waiting' ||
      !state.attemptId ||
      openedAttempt.current === `${state.attemptId}:${state.method}`
    )
      return;
    openedAttempt.current = `${state.attemptId}:${state.method}`;
    openSignInPage(state, remote, fail, refuse);
  }, [fail, refuse, remote, state]);

  const cancel = (): void => {
    if (!state.attemptId) {
      completed.current = true;
      cancelAfterStart(true);
      onClose();
      return;
    }
    if (state.phase === 'complete') {
      completed.current = true;
      onClose();
      return;
    }
    void window.api.codexLogin
      .cancel()
      .then(receive)
      .catch((caught: unknown) =>
        fail(
          toAppError(resolveClientAppError(caught)),
          "Couldn't cancel. Try again.",
        ),
      );
  };
  const start = (nextMethod = method): void => {
    setError(null);
    setMethod(nextMethod);
    earlyStates.current = new Map();
    const pending = window.api.codexLogin.start({
      confirmPause: true,
      method: nextMethod,
    });
    startPromise.current = pending;
    void pending.then(receiveStartAnswer).catch((caught: unknown) => {
      earlyStates.current = null;
      fail(
        toAppError(resolveClientAppError(caught)),
        "Couldn't connect Codex.",
      );
    });
  };
  useCurrentUiStateReporter('auth.loginModal', {
    open: true,
    provider: 'codex',
    snapshotsAvailable: snapshots.length > 0,
    snapshotsPanelOpen: snapshotsOpen && snapshots.length > 0,
  });

  return (
    <DialogModal
      inset="flush"
      title="Connect Codex"
      maxWidth="md"
      onClose={cancel}
      ownerDocument={ownerDocument}
      dataTestId="auth-login-modal"
      // One action row in one order, in the dialog's footer: Cancel, then
      // any alternative, then the step that moves sign-in forward.
      footer={
        <>
          <Button
            size="compact"
            variant="secondary"
            data-testid="auth-login-cancel"
            onClick={cancel}
          >
            Cancel
          </Button>
          {state.phase === 'confirm' && (
            <Button
              size="compact"
              variant="primary"
              data-testid="auth-login-submit"
              onClick={() => start()}
            >
              Pause work and sign in
            </Button>
          )}
          {state.phase === 'waiting' && (
            <>
              {state.method !== 'chatgptDeviceCode' && !remote && (
                <Button
                  size="compact"
                  variant="secondary"
                  onClick={() => start('chatgptDeviceCode')}
                >
                  Use a device code
                </Button>
              )}
              <Button
                size="compact"
                variant="primary"
                onClick={(): void =>
                  openSignInPage(state, remote, fail, refuse)
                }
              >
                Open browser
              </Button>
            </>
          )}
          {state.phase === 'complete' && state.outcome === 'failed' && (
            <Button size="compact" variant="primary" onClick={() => start()}>
              Try again
            </Button>
          )}
          {state.phase === 'verification-failed' && (
            <Button
              size="compact"
              variant="primary"
              onClick={(): void => {
                setError(null);
                void window.api.codexLogin
                  .retryVerification()
                  .then(receive)
                  .catch((caught: unknown) =>
                    fail(
                      toAppError(resolveClientAppError(caught)),
                      "Couldn't connect Codex.",
                    ),
                  );
              }}
            >
              Try again
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col">
        <div
          className="flex flex-col px-6 pt-6 pb-4.5 text-s fg-primary gap-4"
          aria-live="polite"
        >
          {state.phase === 'confirm' ? (
            <>
              <p>Your active Codex work will pause during sign-in.</p>
              <p className="fg-secondary">
                After signing in or cancelling, you can choose which chats and
                workflows to resume.
              </p>
              {!remote && (
                <ChoiceList aria-label="Sign-in method">
                  <ChoiceListRow
                    selected={method === 'chatgptDeviceCode'}
                    onClick={() =>
                      setMethod(
                        method === 'chatgptDeviceCode'
                          ? 'chatgpt'
                          : 'chatgptDeviceCode',
                      )
                    }
                  >
                    Use a device code
                  </ChoiceListRow>
                </ChoiceList>
              )}
            </>
          ) : state.phase === 'waiting' ? (
            <>
              <p>Finish signing in in your browser.</p>
              {state.userCode ? (
                <Stack gap="inline">
                  <p className="fg-secondary">
                    Enter this code on the page that opened:
                  </p>
                  <div className="flex items-center gap-3">
                    <code
                      data-testid="codex-login-device-code"
                      className={`${POSTHOG_REPLAY_BLOCK_CLASS} font-mono text-lg`}
                    >
                      {state.userCode}
                    </code>
                    <Button
                      size="compact"
                      variant="secondary"
                      onClick={(): void => {
                        void copyTextToClipboard(state.userCode ?? '').then(
                          () => setCopied(true),
                        );
                      }}
                    >
                      {copied ? 'Copied' : 'Copy code'}
                    </Button>
                  </div>
                </Stack>
              ) : (
                <p className="fg-secondary">
                  This window will update when sign-in finishes. Your paused
                  work will stay stopped until you resume it.
                </p>
              )}
            </>
          ) : state.phase === 'complete' && state.outcome === 'failed' ? (
            <p>Couldn't connect Codex.</p>
          ) : state.phase === 'verification-failed' ? (
            <p>{state.error}</p>
          ) : (
            <p>
              {state.phase === 'verifying'
                ? 'Checking your Codex account…'
                : state.phase === 'pausing'
                  ? 'Pausing Codex work…'
                  : 'Starting…'}
            </p>
          )}
          {snapshots.length > 0 && (
            <>
              <Button
                className="self-start"
                size="compact"
                variant="secondary"
                data-testid="auth-login-snapshots-toggle"
                aria-expanded={snapshotsOpen}
                onClick={() => setSnapshotsOpen(!snapshotsOpen)}
              >
                Other account snapshots
              </Button>
              {snapshotsOpen && (
                <div
                  data-testid="auth-login-snapshots-panel"
                  className="max-h-64 overflow-y-auto"
                >
                  <OtherAccountSnapshotsPanel
                    provider="codex"
                    snapshots={snapshots}
                    nowMs={nowMs}
                  />
                </div>
              )}
            </>
          )}
          <DesktopErrorBanner
            errorSource="codex-login-modal"
            className=""
            error={error?.error}
            {...(error?.details === undefined
              ? {}
              : { details: error.details })}
          />
        </div>
      </div>
    </DialogModal>
  );
}
