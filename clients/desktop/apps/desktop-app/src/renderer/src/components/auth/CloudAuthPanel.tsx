import { Notice } from '@canopy/ui-shared/components';
import { SecureStorageNotice } from '@/components/auth/SecureStorageNotice';
import {
  type JSX,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';
import {
  ArchiveIcon,
  GlobeIcon,
  ShareIcon,
  ChevronRightIcon,
} from '@canopy/ui-shared/icons';
import type { AppIcon } from '@canopy/ui-shared/icons/AppIcons';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { Button } from '@/components/shared/Button';
import { LoadingSpinner } from '@/components/shared/loading';
import { brandText } from '@/lib/brand';
import { CanopyCloudApiKeyField } from './CanopyCloudApiKeyField';
import { CloudAccountRecoveryNotice } from './CloudAccountRecoveryNotice';
import {
  useCanopyCloudAuth,
  type CanopyCloudConnectSuccess,
} from './useCanopyCloudAuth';

export interface CloudAuthBenefit {
  /** Stable key; also the testid suffix. */
  id: string;
  icon: AppIcon;
  label: string;
}

/**
 * The outcomes signing in unlocks: keep work synced, reach it from elsewhere,
 * and bring other people in. Guest-specific surfaces opt into a separate first
 * row so an ordinary signed-out user is never described as a guest.
 *
 * There is deliberately no free-credits row. Free daily AI Credits are no
 * longer offered and a new account starts at zero, so signing in alone does
 * not deliver credits and the list must not promise it.
 *
 * These icons all share one drawing family (24×24, `fill="none"`, 2px
 * `currentColor` stroke). Swapping one for a filled Material glyph on a
 * `-960 960` viewBox would put two different icon languages in a single list.
 */
export const DEFAULT_CLOUD_AUTH_BENEFITS: CloudAuthBenefit[] = [
  {
    id: 'keep-work',
    icon: ArchiveIcon,
    label: 'Keep your work synced to your account',
  },
  {
    id: 'reach-agents',
    icon: GlobeIcon,
    label: 'Reach your agents from your phone or any browser',
  },
  {
    id: 'share-team',
    icon: ShareIcon,
    label: 'Share with your team, synced across your devices',
  },
];

export const GUEST_CLOUD_AUTH_BENEFITS: CloudAuthBenefit[] =
  DEFAULT_CLOUD_AUTH_BENEFITS.map((benefit) =>
    benefit.id === 'keep-work'
      ? { ...benefit, label: "Keep the work you've done as a guest" }
      : benefit,
  );

/**
 * Supporting line under the title on the guest sign-in gate.
 *
 * Deliberately says nothing about signing in. The title, the CTA, and the
 * microcopy under it already do; a fourth restatement ("Unlock the rest of
 * Canopy by signing in.") was the only line on the surface carrying no
 * information. The two facts the rest of the screen cannot show are that an
 * account costs nothing and that existing guest work survives the upgrade, so
 * this line carries those and the benefit rows carry the rest.
 *
 * No brand name on purpose: the title already names the app, and this reads the
 * same under any brand pack.
 */
export const CLOUD_AUTH_DEFAULT_LEAD =
  "Free account, no card, nothing you've built gets left behind.";

const OAUTH_MICROCOPY = 'Opens your browser. Takes about ten seconds.';

/**
 * Vertical rhythm, as three groups: the header (title plus the lead line that
 * supports it), the benefit rows, and the action block (CTA plus microcopy).
 *
 * The lead is the title's supporting line, so it sits 8px under the title
 * (`DialogModal headerSpacing="tight"` plus this panel's `pt-0`) and a full
 * 24px above the benefit rows. The flat `gap-5` this replaced put it 24px below
 * the title and 20px above the list — visually equidistant, so it floated
 * between the two — and gave the header boundary MORE room than the
 * benefits/action boundary, inverting the hierarchy: the biggest break in the
 * dialog got the smallest gap. Both real group boundaries are now 24px, three
 * times the 8px that binds the lead to its title and twice the 12px row rhythm.
 */
const PANEL_GROUP_GAP = 'gap-6';

export interface CloudAuthPanelProps {
  /**
   * `modal` sits inside a host `DialogModal` (the cloud-connect gate).
   * `splash` centers its content for the blocking full-window sign-in gate,
   * which supplies its own brand lockup and welcome heading above the panel.
   */
  layout?: 'modal' | 'splash';
  /**
   * Supporting line under the title, above the benefit rows. Defaults to
   * {@link CLOUD_AUTH_DEFAULT_LEAD}; pass `null` to render none, for a host
   * that already fills that role with its own subheading.
   */
  lead?: string | null;
  benefits?: CloudAuthBenefit[];
  /** Manual keys cannot merge a confirmed guest identity into an account. */
  allowApiKeyFallback?: boolean;
  onConnectedChange?: (connected: boolean) => void;
  onConnectSuccess?: (result: CanopyCloudConnectSuccess) => void;
  /**
   * Reports that a connected account loaded at mount and no connect-time
   * disclosure remains. This recovery signal is distinct from the imperative
   * user-connect callback above.
   */
  onReadyToContinue?: () => void;
  /**
   * Reports any credential operation while a host dialog must remain mounted.
   * Browser OAuth needs its explicit cancellation path, while API-key validation
   * must retain the gated action and sole success confirmation until it settles.
   */
  onAuthPendingChange?: (pending: boolean) => void;
  /**
   * Exposed so a host dialog can point `initialFocusRef` at the primary CTA
   * instead of the header close button.
   */
  oauthCtaRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * The single Canopy Cloud sign-in surface: one pitch, one obvious primary
 * action, and the manual API key demoted to an escape hatch that swaps the
 * panel rather than competing with browser sign-in for attention.
 *
 * Shared by the cloud-connect modal and the blocking splash gate; the Settings
 * → Account tile keeps its own compact presentation but runs the same
 * `useCanopyCloudAuth` state machine.
 */
export function CloudAuthPanel({
  layout = 'modal',
  lead = CLOUD_AUTH_DEFAULT_LEAD,
  benefits = DEFAULT_CLOUD_AUTH_BENEFITS,
  allowApiKeyFallback = true,
  onConnectedChange,
  onConnectSuccess,
  onReadyToContinue,
  onAuthPendingChange,
  oauthCtaRef,
}: CloudAuthPanelProps): JSX.Element {
  const auth = useCanopyCloudAuth({
    onConnectedChange,
    onConnectSuccess,
    // Explicit submit only. Keeping the 600ms autosave alongside a Connect
    // button would validate a half-typed key and paint "Invalid API key"
    // while the user is still typing it.
    autoSaveApiKey: false,
  });
  const {
    cloudName,
    account,
    loading,
    mode,
    setMode,
    apiKeyInput,
    handleApiKeyInputChange,
    handleSubmitApiKey,
    apiKeyVisible,
    setApiKeyVisible,
    validating,
    oauthPending,
    accountUnreadable,
    repairing,
    errorMessage,
    successMessage,
    storageAvailable,
    busy,
    connected,
    connectCompletionPending,
  } = auth;

  const isSplash = layout === 'splash';
  const confirmedGuest = isGuestAccount(account);
  const displayedBenefits = confirmedGuest
    ? GUEST_CLOUD_AUTH_BENEFITS
    : benefits;
  // Replacing a guest credential with a manual key cannot mint the link ticket
  // that preserves guest data. Keep that destructive path unavailable until it
  // has an explicit confirmation/rollback flow; OAuth is the supported upgrade.
  const apiKeyFallbackAvailable = allowApiKeyFallback && !confirmedGuest;
  const renderedMode =
    mode === 'api_key' && !apiKeyFallbackAvailable ? 'oauth' : mode;
  const localOauthCtaRef = useRef<HTMLButtonElement | null>(null);
  const ctaRef = oauthCtaRef ?? localOauthCtaRef;
  const oauthCancelRef = useRef<HTMLButtonElement | null>(null);
  const previousOauthPendingRef = useRef(oauthPending);
  const previousValidatingRef = useRef(validating);
  const apiKeyInputRef = useRef<HTMLInputElement | null>(null);
  const apiKeySubmitRef = useRef<HTMLButtonElement | null>(null);
  const modeRef = useRef(renderedMode);
  const readyReportedRef = useRef(false);
  const previousUnreadableRef = useRef(accountUnreadable);

  useEffect(() => {
    const ready = !loading && connected && !connectCompletionPending;
    if (!ready) {
      readyReportedRef.current = false;
      return;
    }
    if (readyReportedRef.current) return;
    readyReportedRef.current = true;
    onReadyToContinue?.();
  }, [connectCompletionPending, connected, loading, onReadyToContinue]);

  // `DialogModal`'s focus trap depends only on `[trapFocus, ownerDocument]`, so
  // it does not re-run when the panel swaps and `initialFocusRef` is honored at
  // mount only. Move focus by hand on each swap, after paint.
  useEffect(() => {
    const previous = modeRef.current;
    modeRef.current = renderedMode;
    if (!renderedMode || previous === renderedMode) return;
    const frame = requestAnimationFrame(() => {
      const target =
        renderedMode === 'api_key' ? apiKeyInputRef.current : ctaRef.current;
      if (!target) return;

      if (previous === null) {
        // The modal opens on a short loading state, before its named CTA exists,
        // so DialogModal initially falls back to the header close button. Claim
        // focus once the first real pane resolves, but do not steal it if the
        // user already moved somewhere else during that loading frame.
        const doc = target.ownerDocument;
        const active = doc.activeElement;
        if (
          active !== doc.body &&
          active?.getAttribute('aria-label') !== 'Close'
        ) {
          return;
        }
      }

      target.focus();
    });
    return (): void => cancelAnimationFrame(frame);
  }, [renderedMode, ctaRef]);

  // The host's Escape/backdrop/X policy must update in the same paint as the
  // pending controls. A passive effect leaves one frame where the parent dialog
  // can unmount an in-flight auth attempt.
  useLayoutEffect(() => {
    // `repairing` is included so a host dialog cannot close mid-reset: the
    // request purges local replicas and renames the credential on disk, and an
    // unmount during that window leaves the user with no view of the outcome.
    onAuthPendingChange?.(
      oauthPending || validating || repairing || connectCompletionPending,
    );
  }, [
    connectCompletionPending,
    oauthPending,
    onAuthPendingChange,
    repairing,
    validating,
  ]);

  // After a successful reset the surface swaps from the recovery notice back to
  // the sign-in pane; move focus to the CTA the user is now expected to press
  // rather than dropping it on `document.body`.
  useEffect(() => {
    const wasUnreadable = previousUnreadableRef.current;
    previousUnreadableRef.current = accountUnreadable;
    if (!wasUnreadable || accountUnreadable) return;
    const frame = requestAnimationFrame(() => ctaRef.current?.focus());
    return (): void => cancelAnimationFrame(frame);
  }, [accountUnreadable, ctaRef]);

  useLayoutEffect(() => {
    const wasPending = previousOauthPendingRef.current;
    previousOauthPendingRef.current = oauthPending;
    if (oauthPending) {
      oauthCancelRef.current?.focus();
    } else if (wasPending) {
      ctaRef.current?.focus();
    }
  }, [ctaRef, oauthPending]);

  useLayoutEffect(() => {
    const wasValidating = previousValidatingRef.current;
    previousValidatingRef.current = validating;
    if (
      !wasValidating ||
      validating ||
      !errorMessage ||
      renderedMode !== 'api_key'
    ) {
      return;
    }
    const input = apiKeyInputRef.current;
    if (!input) return;
    const doc = input.ownerDocument;
    if (
      doc.activeElement === doc.body ||
      doc.activeElement === apiKeySubmitRef.current
    ) {
      input.focus();
    }
  }, [errorMessage, renderedMode, validating]);

  const handleApiKeyFormSubmit = (
    e: React.FormEvent<HTMLFormElement>,
  ): void => {
    e.preventDefault();
    void handleSubmitApiKey();
  };

  const rootClass = isSplash
    ? 'flex min-h-60 w-full flex-1 flex-col gap-5 text-center'
    : // `pt-0`: the host dialog's tight header spacing is the whole gap above
      // the lead, so the lead reads as the title's supporting line.
      'flex min-h-60 flex-1 flex-col gap-5 px-6 pb-6 pt-0';

  // Shared by both panels and rendered directly above the action block. A
  // failure leaves the modal open, so the message has to stay next to the
  // control the user retries with — never in a toast behind the dialog.
  const errorSlot =
    errorMessage && !validating && !auth.secureStorageFailure ? (
      <Notice intent="attention" data-testid="cloud-auth-panel-error">
        {errorMessage}
      </Notice>
    ) : null;
  const leadSlot =
    lead === null ? null : <p className="text-s fg-secondary">{lead}</p>;

  let panel: ReactNode;
  if (loading || !mode) {
    panel = (
      <div className={`flex flex-1 flex-col ${PANEL_GROUP_GAP}`}>
        <p className="text-s fg-secondary">
          Checking {cloudName} account&hellip;
        </p>
      </div>
    );
  } else if (accountUnreadable) {
    // Recovery replaces the sign-in panes outright rather than sitting above
    // them. Writing a fresh OAuth or API-key credential next to an entry this
    // build cannot decrypt leaves the user in the same broken state, so the
    // reset has to happen first.
    panel = (
      <div
        key="recovery"
        className={`flex flex-1 flex-col ${PANEL_GROUP_GAP} animate-fade-in`}
        data-testid="settings-account-canopy-cloud-recovery"
      >
        <CloudAccountRecoveryNotice
          cloudName={cloudName}
          resetting={repairing}
          errorMessage={errorMessage}
          onReset={auth.resetUnreadableAccount}
        />
      </div>
    );
  } else if (renderedMode === 'oauth') {
    panel = (
      <div
        key="oauth"
        className={`flex flex-1 flex-col ${PANEL_GROUP_GAP} animate-fade-in ${
          isSplash ? 'items-stretch' : ''
        }`}
        data-testid="settings-account-canopy-cloud-oauth"
      >
        {leadSlot}
        <ul className={`flex flex-col gap-3 ${isSplash ? 'text-left' : ''}`}>
          {displayedBenefits.map((benefit) => {
            const Icon = benefit.icon;
            return (
              <li
                key={benefit.id}
                className="flex items-start gap-3"
                data-testid={`cloud-auth-benefit-${benefit.id}`}
              >
                <Icon
                  size="sm"
                  className="mt-0.5 shrink-0 fg-accent"
                  aria-hidden="true"
                />
                <span className="text-s fg-primary">{benefit.label}</span>
              </li>
            );
          })}
        </ul>

        <div className={`${isSplash ? 'mt-auto ' : ''}flex flex-col gap-2`}>
          {errorSlot}
          <Button
            ref={ctaRef}
            type="button"
            variant="primary"
            size="lg"
            className="w-full"
            onClick={(): void => void auth.handleStartOAuthLogin()}
            disabled={busy || !storageAvailable}
            aria-busy={oauthPending || undefined}
            data-testid="settings-account-canopy-cloud-oauth-login"
          >
            {oauthPending && <LoadingSpinner decorative />}
            {oauthPending
              ? 'Waiting for browser…'
              : `Sign in with ${brandText.appName}`}
          </Button>
          <p className="text-center text-xs fg-secondary">{OAUTH_MICROCOPY}</p>
          {oauthPending ? (
            <div className="flex justify-center">
              <Button
                variant="ghost"
                size="compact"
                ref={oauthCancelRef}
                onClick={(): void => void auth.handleCancelOAuthLogin()}
                data-testid="settings-account-canopy-cloud-oauth-cancel"
              >
                Cancel
              </Button>
            </div>
          ) : apiKeyFallbackAvailable ? (
            <div className="flex justify-center">
              <Button
                variant="ghost"
                size="compact"
                onClick={(): void => setMode('api_key')}
                disabled={busy}
                data-testid="settings-account-canopy-cloud-mode-api-key"
              >
                Use an API key instead
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    );
  } else {
    panel = (
      <form
        key="api_key"
        onSubmit={handleApiKeyFormSubmit}
        className={`flex flex-1 flex-col ${PANEL_GROUP_GAP} animate-fade-in text-left`}
        data-testid="settings-account-canopy-cloud-api-key"
      >
        <div>
          <Button
            variant="ghost"
            size="compact"
            onClick={(): void => setMode('oauth')}
            disabled={busy || validating}
            data-testid="settings-account-canopy-cloud-mode-oauth"
          >
            <ChevronRightIcon
              size="sm"
              className="-scale-x-100"
              aria-hidden="true"
            />
            Back to sign in
          </Button>
        </div>

        {leadSlot}

        <CanopyCloudApiKeyField
          value={apiKeyInput}
          onChange={handleApiKeyInputChange}
          visible={apiKeyVisible}
          onToggleVisible={(): void => setApiKeyVisible((prev) => !prev)}
          disabled={loading || !storageAvailable || busy || validating}
          inputRef={apiKeyInputRef}
        />

        <div className="flex flex-col mt-auto gap-2">
          {errorSlot}
          <Button
            ref={apiKeySubmitRef}
            // The shared Button defaults to `type="button"`, so submitting on
            // Enter requires this to be explicit.
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            disabled={
              busy || !storageAvailable || apiKeyInput.trim().length === 0
            }
            aria-disabled={validating || undefined}
            aria-busy={validating || undefined}
            data-testid="settings-account-canopy-cloud-api-key-submit"
          >
            {validating && <LoadingSpinner decorative />}
            {validating ? 'Connecting…' : 'Connect'}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <>
      <div className={rootClass} data-testid="cloud-auth-panel">
        <SecureStorageNotice
          failure={auth.secureStorageFailure}
          retrying={auth.storageRetrying}
          onRetry={(): void => void auth.retrySecureStorage()}
        />
        {/* Live region for outcomes that survive a pane swap — notably the
            post-recovery confirmation, which is announced on the sign-in pane
            that replaced the recovery notice. */}
        {successMessage && !errorMessage && (
          <p
            role="status"
            data-testid="cloud-auth-panel-status"
            className="text-s fg-secondary"
          >
            {successMessage}
          </p>
        )}
        {panel}
      </div>
    </>
  );
}
