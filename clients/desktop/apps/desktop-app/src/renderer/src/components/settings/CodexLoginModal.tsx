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

interface CodexLoginModalProps {
  onClose: () => void;
  ownerDocument?: Document;
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
  const [method, setMethod] = useState<'chatgpt' | 'chatgptDeviceCode'>(
    'chatgpt',
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
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const receive = useCallback((next: CodexLoginState): void => {
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
  }, []);

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
              "Couldn't finish cancelling sign-in. Try again.",
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
      if (!disposed) receive(next);
    });
    const pending = window.api.codexLogin.start({
      confirmPause: false,
      method: 'chatgpt',
    });
    startPromise.current = pending;
    void pending
      .then((next) => {
        if (!disposed) receive(next);
      })
      .catch((caught: unknown) => {
        if (!disposed)
          fail(
            toAppError(resolveClientAppError(caught)),
            "Couldn't start Codex sign-in. Try again.",
          );
      });
    return (): void => {
      disposed = true;
      unsubscribe();
      if (!completed.current) cancelAfterStart(false);
    };
  }, [cancelAfterStart, fail, receive]);

  useEffect(() => {
    if (
      state.phase !== 'waiting' ||
      !state.attemptId ||
      openedAttempt.current === `${state.attemptId}:${state.method}`
    )
      return;
    openedAttempt.current = `${state.attemptId}:${state.method}`;
    void window.api.codexLogin
      .openBrowser()
      .catch((caught: unknown) =>
        fail(
          toAppError(resolveClientAppError(caught)),
          "Couldn't open your browser. Use Open browser to try again.",
        ),
      );
  }, [fail, state.attemptId, state.method, state.phase]);

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
          "Couldn't finish cancelling sign-in. Try again.",
        ),
      );
  };
  const start = (nextMethod = method): void => {
    setError(null);
    setMethod(nextMethod);
    const pending = window.api.codexLogin.start({
      confirmPause: true,
      method: nextMethod,
    });
    startPromise.current = pending;
    void pending
      .then(receive)
      .catch((caught: unknown) =>
        fail(
          toAppError(resolveClientAppError(caught)),
          "Couldn't start Codex sign-in. Try again.",
        ),
      );
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
      title="Sign in to Codex"
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
              {state.method !== 'chatgptDeviceCode' && (
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
                onClick={(): void => {
                  void window.api.codexLogin
                    .openBrowser()
                    .catch((caught: unknown) =>
                      fail(
                        toAppError(resolveClientAppError(caught)),
                        "Couldn't open your browser. Try again.",
                      ),
                    );
                }}
              >
                Open browser
              </Button>
            </>
          )}
          {state.phase === 'complete' && state.outcome === 'failed' && (
            <Button size="compact" variant="primary" onClick={() => start()}>
              Sign in
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
                      "Couldn't verify your Codex account.",
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
            </>
          ) : state.phase === 'waiting' ? (
            <>
              <p>Finish signing in in your browser.</p>
              {state.userCode ? (
                <Stack gap="inline">
                  <p className="fg-secondary">Enter this code when asked:</p>
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
            <p>Sign-in did not complete. Try again.</p>
          ) : state.phase === 'verification-failed' ? (
            <p>{state.error}</p>
          ) : (
            <p>
              {state.phase === 'verifying'
                ? 'Verifying your current Codex account…'
                : state.phase === 'pausing'
                  ? 'Pausing Codex work…'
                  : 'Preparing sign-in…'}
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
