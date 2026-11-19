import { useCallback, useEffect, useState } from 'react';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { organizationBillingPath } from '@canopy/protocol/billing';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { isConclusiveAccountRead } from '@canopy/desktop-shared/lib/canopy-cloud-account-read';
import type { CanopyCloudEntitlementsState } from '@canopy/desktop-shared/types';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { GUEST_SIGN_IN_CTA_LABEL } from '@/lib/guest-cta-copy';
import { openSettingsPathOrWeb } from '@/lib/navigation/settings-destinations';

/** Shape returned by {@link useSubscriptionStatus}. */
export interface UseSubscriptionStatusResult {
  /**
   * True for a real signed-in account while the billing flag is on: the
   * account menu shows the AI Credits row.
   */
  aiCreditsVisible: boolean;
  /**
   * Opens the account's billing destination in the external browser:
   * org billing for a manageable-org owner/admin, otherwise the account page.
   * No-op when the cloud base URL is unconfigured.
   */
  openBillingPage: () => void;
  /**
   * Org this user can manage billing for (OWNER/ADMIN), by org externalId, or
   * null. The server names one only when exactly one org is manageable, so
   * null also means "manages several" (CAN-3465); callers that need every
   * managed org read the membership list from `workspaceContextStore`.
   *
   * Optional on the wire, so a missing value resolves to null: a server that
   * cannot say "you are an admin" must not produce a button that assumes it.
   * Null while entitlements are unresolved, for the same reason.
   */
  billingManageableOrg: { id: string; name: string } | null;
  /**
   * Opens an arbitrary apps/web billing path through the authenticated
   * hand-off, for a caller that computes its own
   * destination (for example the AI Credits page). No-op when the cloud base URL is unconfigured.
   */
  openBillingPath: (path: string) => void;
  /**
   * True when the billing flag is on and the account is resolved but not a real
   * signed-in user (a device-scoped guest, or not connected). In that state the
   * account menu shows a sign-in-to-sync CTA. Guest AI Credits are already
   * available; the row offers account creation only to preserve and sync the
   * work the guest has started.
   */
  guestCtaVisible: boolean;
  /**
   * Starts the guest sign-in flow via the shared cloud-connect gate (the same
   * `CloudSyncModal` every contextual sign-in prompt uses). On successful
   * connect the account-changed event refreshes this hook so the footer swaps
   * to the signed-in state.
   *
   * Named for the "Start free trial" button it was introduced for; nothing in
   * the flow frames a trial any more, and the name is kept only because it is
   * load-bearing across four call sites.
   *
   * Callers that open this gate from a surface with its own pitch pass
   * {@link StartFreeTrialOptions.title} so the dialog answers the button the
   * user actually pressed. The default title names a specific offer, and a
   * caller like the Remote Control pairing CTA is asking for something else
   * entirely — an unrelated product name in that dialog's heading reads as a
   * non sequitur, not as an upsell.
   */
  startFreeTrial: (options?: StartFreeTrialOptions) => void;
}

/** Per-surface overrides for the shared sign-in gate {@link startFreeTrial} opens. */
export interface StartFreeTrialOptions {
  /** Dialog heading. Defaults to the shared guest sign-in CTA label. */
  title?: string;
  /**
   * Supporting line under the title. Omit for the panel's generic lead, which
   * supports any title rather than restating one.
   */
  description?: string;
  /**
   * Success toast copy. Overridable for the same reason as the title: a caller
   * that reframes the dialog around its own subject should not then confirm
   * with a sentence about a different one.
   */
  toastMessage?: string;
}

/**
 * Single source for the account-menu billing additions. Loads the signed-in
 * account and cloud entitlements (for the manageable organization), refreshing
 * both whenever the account changes (sign-in / sign-out). There are no plans,
 * so nothing here names one. Never throws: an initial load failure degrades to
 * hidden, while an inconclusive background refresh holds the last-known-good
 * account.
 */
export function useSubscriptionStatus(): UseSubscriptionStatusResult {
  const billingEnabled = useFeatureFlagsStore((s) =>
    s.isEnabled(CLIENT_FEATURE_FLAGS.canopyBillingEnabled.key),
  );
  const [signedIn, setSignedIn] = useState(false);
  const [guest, setGuest] = useState(false);
  // Tracks whether the account load has completed at least once. The guest CTA
  // keys off `!signedIn`, so without this it would flash for a real signed-in
  // user during the initial async load (before `signedIn` flips true).
  const [accountResolved, setAccountResolved] = useState(false);
  const [entitlements, setEntitlements] =
    useState<CanopyCloudEntitlementsState | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The identity the currently held entitlements describe:
    //   `undefined` — never resolved an account read yet
    //   `null`      — resolved to no signed-in user (signed out, or a guest)
    //   string      — that account id
    // Effect-scoped rather than a `useRef` because it is never rendered, so the
    // `[]` deps introduce no stale closure — same shape as the `latest` token
    // below and `useMobileActivation`'s `confirmedActivated`.
    let heldIdentity: string | null | undefined;
    // Per-refresh sequence token. `CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT` can fire
    // in quick succession (sign-in → upgrade), and the two loads race: without a
    // token an earlier slow load could resolve after a newer one and clobber it
    // with stale data (last-completed wins). Each `refresh()` bumps `latest` and
    // its resolutions no-op if a newer refresh has since started (last-issued
    // wins).
    let latest = 0;
    const refresh = (): void => {
      const seq = ++latest;
      const stale = (): boolean => cancelled || seq !== latest;
      // Per-invocation: true once *this* refresh's entitlements read has applied
      // a value for the account it was issued against. The two reads race, so
      // without it an account read landing second could discard the value the
      // entitlements read just produced.
      let entitlementsApplied = false;
      // Records which identity the held entitlements belong to, dropping them
      // only when the account genuinely changed away from a previously-known
      // one. Keyed on identity rather than on receipt of the
      // account-changed event because that event means "the snapshot was
      // re-read", not "the account changed" — it fires on every ambient
      // re-probe. Mirrors `useMobileActivation`'s identity reset.
      const applyIdentity = (identity: string | null): void => {
        const changed = heldIdentity !== undefined && heldIdentity !== identity;
        heldIdentity = identity;
        if (!changed || entitlementsApplied) return;
        // A different user's organization must never be shown as this one's,
        // so drop the held value.
        setEntitlements(null);
      };
      // Guard both preload bridges so a component embedding this hook in a test
      // (or any surface) without the full preload API degrades to hidden rather
      // than crashing.
      const loadAccount = window.api?.loadCanopyCloudAccount;
      const loadEntitlements = window.api?.loadCanopyCloudEntitlements;
      if (typeof loadAccount === 'function') {
        void loadAccount()
          .then((account) => {
            if (stale()) return;
            // A degraded secure-store read *resolves* with a signed-out-looking
            // snapshot rather than rejecting (the store collapses `unavailable`
            // and `error` to a null entry), so the `.catch` below never sees it.
            // Treat it exactly like a rejection: inconclusive, never proof of a
            // sign-out. Without this, one failed re-decrypt on an ambient
            // re-probe past `CACHE_TTL_MS` would swap a signed-in user's row for
            // the guest CTA — the very flicker this hook exists to prevent.
            if (!isConclusiveAccountRead(account)) {
              if (heldIdentity !== undefined) return;
              setSignedIn(false);
              setAccountResolved(true);
              return;
            }
            // Signed-in means a real account that is not a device-scoped guest.
            const isRealUser =
              account.account != null && !isGuestAccount(account);
            setGuest(isGuestAccount(account));
            setSignedIn(isRealUser);
            setAccountResolved(true);
            // A guest has no organizations of its own, so it shares the signed-out
            // identity: its entitlements must not survive into a real sign-in.
            applyIdentity(isRealUser ? (account.account?.id ?? null) : null);
          })
          .catch(() => {
            if (stale()) return;
            // A failed re-read is inconclusive, never proof of a sign-out.
            // Asserting `signedIn = false` here would replace a paying user's
            // row with the guest CTA on any flaky focus refresh.
            // Only the very first attempt (nothing known yet) falls through, so
            // a genuinely broken bridge still reaches the guest CTA and
            // first-load behavior is unchanged. `heldIdentity` is deliberately
            // left alone: a rejection tells us nothing about who is signed in.
            if (heldIdentity !== undefined) return;
            setSignedIn(false);
            setGuest(false);
            setAccountResolved(true);
          });
      } else {
        setSignedIn(false);
        setGuest(false);
        setAccountResolved(true);
        applyIdentity(null);
      }
      if (typeof loadEntitlements === 'function') {
        void loadEntitlements()
          .then((next) => {
            if (stale()) return;
            if (next.resolved) {
              // Authoritative in both directions — upgrade, downgrade, and
              // sign-out's unlinked `source: 'none'` all land here, so
              // hold-last-known-good never suppresses a real change.
              entitlementsApplied = true;
              setEntitlements(next);
            } else {
              // `resolved: false` is the documented transient-failure signal
              // (`ipc/settings.ts`): keep last-known-good rather than blanking
              // the manageable organization.
              setEntitlements((previous) =>
                previous?.resolved === true ? previous : next,
              );
            }
          })
          .catch(() => {
            if (stale()) return;
            // Hold the value.
          });
      } else {
        setEntitlements(null);
      }
    };
    refresh();
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, refresh);
    return (): void => {
      cancelled = true;
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, refresh);
    };
  }, []);

  // Gated on the billing flag like every other billing surface: the web gates
  // the AI Credits page on the same flag, so the row needs it to have a target.
  // The entitlements DTO's `freeAccess` is a compat field for remote peers and
  // is not read.
  const aiCreditsVisible = billingEnabled && signedIn;
  // Shown once the account resolves to a guest / anon user. It does not wait
  // on entitlements — a guest has none to resolve.
  const guestCtaVisible = billingEnabled && accountResolved && !signedIn;

  const startFreeTrial = useCallback(
    (options?: StartFreeTrialOptions): void => {
      // Route through the shared cloud-connect gate rather than a bespoke OAuth
      // call so the guest gets the same `CloudSyncModal` explainer every other
      // contextual sign-in prompt uses.
      useCloudConnectGateStore.getState().requestConnect(
        {
          // Overridable because this handler is shared by every guest sign-in
          // entry point, and the default title names one specific offer. A
          // surface with its own pitch (Remote Control pairing) must be able to
          // keep the dialog on the subject of the button that opened it.
          title: options?.title ?? GUEST_SIGN_IN_CTA_LABEL,
          // No subheading on either default path. For a guest the credits line
          // that used to sit here ("already available") argued against signing
          // in, and the panel's benefit rows now make the same point in the
          // other direction. For an ordinary signed-out user the line was
          // "Sign in to get your free AI credits." — which, under the current
          // title, stacked two consecutive lines both opening "Sign in to get"
          // and promising different things. Dropping it hands the slot back to
          // the panel's default lead, which supports any title rather than
          // restating one.
          subtitle: null,
          description: options?.description,
          toastMessage:
            options?.toastMessage ??
            // No credits clause: a new account starts at zero AI Credits, so
            // signing in does not by itself make any credits ready to use.
            (guest
              ? "You're all set. Your guest work is synced."
              : "You're all set."),
          guestBenefits: guest,
        },
        () => {
          // Broadcast so this hook (and the rest of the account row) re-reads
          // the now signed-in account + entitlements and swaps to the live
          // state.
          window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        },
      );
    },
    [guest],
  );

  const openBillingPage = useCallback((): void => {
    const manageableOrg =
      entitlements && entitlements.resolved
        ? entitlements.billingManageableOrg
        : null;
    openBillingDestination(
      manageableOrg ? organizationBillingPath(manageableOrg.id) : '/account',
    );
  }, [entitlements]);

  return {
    aiCreditsVisible,
    openBillingPage,
    billingManageableOrg:
      entitlements && entitlements.resolved
        ? entitlements.billingManageableOrg
        : null,
    openBillingPath: openBillingDestination,
    guestCtaVisible,
    startFreeTrial,
  };
}

/** Billing paths open inside Settings when hosted settings are openable here, otherwise on the web. */
function openBillingDestination(path: string): void {
  openSettingsPathOrWeb(path);
}
