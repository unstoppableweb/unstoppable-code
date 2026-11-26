import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { OrgSharingRequirementNotice } from '@canopy/ui-shared/components';
import { isConclusiveAccountRead } from '@canopy/desktop-shared/lib/canopy-cloud-account-read';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type {
  CanopyCloudAccountPublicState,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { useCanopyCloudAccountState } from '@/hooks/useCanopyCloudAccountState';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useTelemetrySharingAvailable } from '@/lib/cloud-account';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  decideOrgSharingNotice,
  isSignedInMemberAccount,
  type OrgSharingNoticeDecision,
  type OrgSharingNoticePreferences,
  type OrgSharingRequirement,
} from './orgSharingNotice';

const WAIT: OrgSharingNoticeDecision = { kind: 'wait' };
const ERROR_SOURCE = 'org-sharing-notice';

function pickNoticePreferences(
  preferences: PreferencesData,
): OrgSharingNoticePreferences {
  return {
    telemetrySharing: preferences.telemetrySharing,
    orgSharingNoticesSeen: preferences.orgSharingNoticesSeen,
    dataChoicesConfirmedAt: preferences.dataChoicesConfirmedAt,
  };
}

/**
 * The notice's preferences: read on mount, replaced by every save broadcast,
 * and re-read when main changes preferences outside a save. `null` until the
 * first good read; a failed read keeps it `null`, so nothing is seeded over
 * preferences that could not be read.
 */
function useNoticePreferences(): readonly [
  OrgSharingNoticePreferences | null,
  (next: OrgSharingNoticePreferences) => void,
] {
  const [preferences, setPreferences] =
    useState<OrgSharingNoticePreferences | null>(null);
  // Last issued wins: a save broadcast or a newer read supersedes a slow one.
  const sequenceRef = useRef(0);

  const apply = useCallback((next: OrgSharingNoticePreferences): void => {
    sequenceRef.current += 1;
    setPreferences(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      const sequence = ++sequenceRef.current;
      void window.api
        .loadPreferences()
        .then((loaded) => {
          if (cancelled || sequence !== sequenceRef.current) return;
          if (loaded.__error) return;
          setPreferences(pickNoticePreferences(loaded));
        })
        .catch((error: unknown) => {
          // Keep the last good read; the next broadcast retries.
          reportClientAppError(error, { source: ERROR_SOURCE });
        });
    };
    load();
    const unsubscribeChanged = window.api.onPreferencesChanged(load);
    const unsubscribeSynced = window.api.onPreferencesSynced((saved) => {
      if (cancelled) return;
      sequenceRef.current += 1;
      setPreferences(pickNoticePreferences(saved));
    });
    return (): void => {
      cancelled = true;
      unsubscribeChanged();
      unsubscribeSynced();
    };
  }, []);

  return [preferences, apply] as const;
}

interface EnforcementRefresh {
  /** True once the on-demand refresh has settled, or when none is needed. */
  readonly settled: boolean;
  /** The account to decide from: the refreshed one while it is the newest. */
  readonly account: CanopyCloudAccountPublicState | null;
}

/**
 * Re-probe enforcement once, the first time a signed-in member is seen.
 * Enforcement-only changes don't broadcast `preferencesChanged`, and the
 * startup re-probe in main does not notify the renderer, so the account this
 * window last read can predate the policy. The refreshed account applies
 * until the account hook reads a newer one.
 */
function useEnforcementRefresh(
  account: CanopyCloudAccountPublicState | null,
): EnforcementRefresh {
  const signedIn = isSignedInMemberAccount(account);
  const startedRef = useRef(false);
  const [result, setResult] = useState<{
    readonly basis: CanopyCloudAccountPublicState | null;
    readonly account: CanopyCloudAccountPublicState | null;
  } | null>(null);
  // Read at resolution, so the result never replaces a newer hook read.
  const accountRef = useRef(account);
  useEffect(() => {
    accountRef.current = account;
  }, [account]);

  useEffect(() => {
    if (!signedIn || startedRef.current) return;
    startedRef.current = true;
    // No cancellation: the refresh runs once per mount, and a result that
    // lands after unmount is dropped by React.
    void window.api
      .refreshCanopyCloudEnforcedSettings()
      .then((next) => {
        setResult({
          basis: accountRef.current,
          account: isConclusiveAccountRead(next) ? next : null,
        });
      })
      .catch((error: unknown) => {
        // Decide from the account this window already read.
        reportClientAppError(error, { source: ERROR_SOURCE });
        setResult({ basis: accountRef.current, account: null });
      });
  }, [signedIn]);

  if (!signedIn) return { settled: true, account };
  if (result === null) return { settled: false, account };
  return {
    settled: true,
    account:
      result.account !== null && result.basis === account
        ? result.account
        : account,
  };
}

/**
 * The one-time notice that an organization the member belongs to requires
 * some activity sharing beyond the member's own choice. Mounted once in the
 * shell after the startup gates. Hidden, with no account refresh, where the
 * host does not share data.
 */
export function OrgSharingRequirementNoticeHost(): JSX.Element | null {
  const available = useTelemetrySharingAvailable();
  if (!available) return null;
  return <OrgSharingRequirementNoticeController />;
}

function OrgSharingRequirementNoticeController(): JSX.Element | null {
  const { account: readAccount } = useCanopyCloudAccountState();
  const refresh = useEnforcementRefresh(readAccount);
  const [preferences, applyPreferences] = useNoticePreferences();
  const decision = useMemo(
    () =>
      refresh.settled
        ? decideOrgSharingNotice(refresh.account, preferences)
        : WAIT,
    [refresh.settled, refresh.account, preferences],
  );
  const optInPending = useNavigationStore(
    (state) => state.pendingPrivacyOptIn !== undefined,
  );
  const [active, setActive] = useState<OrgSharingRequirement | null>(null);
  const seedingRef = useRef(false);

  // Seed an existing user's current requirements once, silently.
  const seed = decision.kind === 'seed' ? decision.seen : null;
  useEffect(() => {
    if (seed === null || seedingRef.current) return;
    seedingRef.current = true;
    void window.api
      .savePreferences({ orgSharingNoticesSeen: seed })
      .then((saved) => {
        applyPreferences(pickNoticePreferences(saved));
      })
      .catch((error: unknown) => {
        // Not retried this session; the next launch seeds again.
        reportClientAppError(error, { source: ERROR_SOURCE });
      });
  }, [seed, applyPreferences]);

  // Open the next notice only while no opt-in sheet is waiting. Raising the
  // store flag in the same pass holds any opt-in request that arrives later.
  const candidate = decision.kind === 'show' ? decision.requirement : null;
  useEffect(() => {
    if (active !== null || candidate === null || optInPending) return;
    const navigation = useNavigationStore.getState();
    if (navigation.pendingPrivacyOptIn !== undefined) return;
    navigation.setOrgSharingNoticeOpen(true);
    setActive(candidate);
  }, [active, candidate, optInPending]);

  // Release the hold if the host unmounts while the notice is open.
  useEffect(
    () => (): void => {
      useNavigationStore.getState().setOrgSharingNoticeOpen(false);
    },
    [],
  );

  const dismiss = useCallback((): void => {
    if (active === null) return;
    const entry = { [active.organizationId]: active.signature };
    setActive(null);
    // Optimistic, so the same notice does not reopen before the save lands.
    // A failed save shows it once more next launch.
    if (preferences !== null) {
      applyPreferences({
        ...preferences,
        orgSharingNoticesSeen: {
          ...preferences.orgSharingNoticesSeen,
          ...entry,
        },
      });
    }
    useNavigationStore.getState().setOrgSharingNoticeOpen(false);
    void window.api
      .savePreferences({ orgSharingNoticesSeen: entry })
      .catch((error: unknown) => {
        reportClientAppError(error, { source: ERROR_SOURCE });
      });
  }, [active, preferences, applyPreferences]);

  useCurrentUiStateReporter(
    'orgSharingNotice',
    active === null
      ? null
      : {
          open: true,
          organizationId: active.organizationId,
          requiredScopes: [...active.requiredScopes],
          queued: decision.kind === 'show' ? decision.remaining : 0,
        },
  );

  if (active === null) return null;
  return (
    <OrgSharingRequirementNotice
      organizationName={active.organizationName}
      requiredScopes={active.requiredScopes}
      onDismiss={dismiss}
    />
  );
}
