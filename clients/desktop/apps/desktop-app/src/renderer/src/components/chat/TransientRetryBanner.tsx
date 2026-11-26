import type { JSX } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  Notice,
  RetryCountdown,
  getModelCatalogProviderLabel,
} from '@canopy/ui-shared';
import type { ChatBannerTarget } from '@/stores/aiCreditsBannerStore';
import { useTransientRetryState } from '@/stores/transientRetryBannerStore';

interface TransientRetryBannerProps {
  /**
   * The chat this banner belongs to. Works on every surface because retry state
   * is keyed by target and fed centrally from the main process. Pass `null` to
   * render nothing.
   */
  target: ChatBannerTarget | null;
}

/**
 * Shared transient-retry banner. Rendered once in the universal `ChatInput`, it
 * surfaces on every chat surface, driven by the target-keyed retry store which
 * the main process feeds authoritatively over the chat-event pipeline.
 *
 * The banner is a pure view of pushed state — the attempt count, cap, and next
 * retry time all come straight from the event payload. While a retry is
 * scheduled it counts down once a second to `nextRetryAt`; when the countdown
 * reaches zero the main-process timer is dispatching the retry, so the copy
 * flips to "Retrying now" until the outcome event re-arms or clears the cycle.
 * A failed attempt can start another automatic retry. Only the authoritative
 * exhausted/cleared cycle state hands recovery back to the transcript.
 * Dismissal waits for the backend inactive event before exposing manual retry.
 */
export function TransientRetryBanner({
  target,
}: TransientRetryBannerProps): JSX.Element | null {
  const state = useTransientRetryState(target);
  if (!target || !state || state.exhausted) return null;

  const dismiss = (): void => {
    // Keep the live cycle visible until main confirms cancellation. Optimistic
    // clearing could expose manual retry while an automatic retry is pending.
    void window.api.chat
      .cancelTransientRetry(target)
      .catch(reportClientAppError);
  };

  return (
    <Notice
      intent="attention"
      title={`${getModelCatalogProviderLabel(state.provider)} didn't respond`}
      data-testid="chat-input-transient-retry-banner"
      onDismiss={dismiss}
      dismissLabel="Dismiss retry notice"
      dismissTestId="chat-input-transient-retry-dismiss"
    >
      <RetryCountdown {...state} />
    </Notice>
  );
}
