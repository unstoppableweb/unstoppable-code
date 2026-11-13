import { useEffect, useMemo, type JSX, type ReactNode } from 'react';
import {
  selectSettingsBootstrap,
  useSettingsBootstrap,
  useSettingsStore,
  useSettingsStoreApi,
} from '@canopy/app-state/settings';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { settingsRouteToPath } from '@canopy/protocol/settings';
import { useSettingsHost } from '@canopy/ui-app/settings/host';
import {
  buildSettingsNavGroups,
  SettingsNavGroups,
  SettingsScopePicker,
} from '@canopy/ui-app/settings/navigation';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  useHostedSettingsAccount,
  useHostedSettingsPersistedNavModel,
} from './desktop-settings-host-context';
import {
  hostedSettingsNavFallback,
  hostedSettingsNavModel,
  hostedSettingsOrganizationId,
  selectHostedSettingsRow,
  SIGNED_OUT_SETTINGS_NAV_MODEL,
} from './hosted-settings-model';

/** Test-id prefix shared with the local rows (`settings-nav-<key>`). */
export const HOSTED_SETTINGS_NAV_TEST_ID_PREFIX = 'settings-nav-';

/**
 * Keeps the browsed organization in step with the hosted destination: an
 * organization route browses its organization; account pages and the
 * Organizations list and local app settings browse Personal.
 * The store browses the route Settings opened on from its creation,
 * so this does nothing (and fetches nothing more) on the first render.
 */
function useBrowsedOrganizationSync(): void {
  const store = useSettingsStoreApi();
  const route = useNavigationStore(
    (state) => state.settingsHostedLocation?.route ?? null,
  );
  const browsed = route === null ? null : hostedSettingsOrganizationId(route);
  useEffect(() => {
    if (store.getState().selectedOrganizationId !== browsed)
      store.getState().selectOrganization(browsed);
  }, [store, browsed]);
}

export interface HostedSettingsNavProps {
  /** Settings is open; the bootstrap is fetched only then. */
  readonly open: boolean;
  /** The local app group, placed after the scope's hosted rows. */
  readonly appGroup: ReactNode;
  /** The local groups after the app group (Agents onward). */
  readonly trailingGroups: ReactNode;
}

/**
 * The settings rail with hosted settings available: the scope picker (your
 * account or the browsed organization) and that scope's hosted rows, then
 * the local app group (labeled with the product name) and the remaining
 * local groups. Hosted rows are links through the desktop host, so choosing
 * one navigates inside the overlay. The current row is selected only while a
 * hosted destination shows, so exactly one rail row is selected across
 * hosted and local groups.
 */
export function HostedSettingsNav({
  open,
  appGroup,
  trailingGroups,
}: HostedSettingsNavProps): JSX.Element {
  useBrowsedOrganizationSync();
  const host = useSettingsHost();
  const router = host.useRouter();
  const account = useHostedSettingsAccount();
  const signedIn = account.status === 'signed_in';
  const location = useNavigationStore((state) => state.settingsHostedLocation);
  const browsedOrganizationId = useSettingsStore(
    (state) => state.selectedOrganizationId,
  );
  const entry = useSettingsBootstrap(browsedOrganizationId, {
    enabled: open && signedIn,
  });
  // While the browsed organization's bootstrap loads, keep the account rows
  // from the account-only bootstrap rather than collapsing to the defaults.
  const accountBootstrap = useSettingsStore(
    (state) => selectSettingsBootstrap(state, null).data,
  );
  const bootstrap = signedIn ? (entry.data ?? accountBootstrap) : null;
  // Before the bootstrap says, draw the rows it will most likely confirm:
  // this account's persisted entry, else the flag snapshot. Bootstraps from
  // an earlier open are already in the store.
  const persisted = useHostedSettingsPersistedNavModel();
  const billingFlag = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyBillingEnabled.key),
  );
  const digestsFlag = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDigestsEnabled.key),
  );
  const freeAccessFlag = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyFreeAccessEnabled.key),
  );
  // The browsed organization's own bootstrap decides its group once known.
  const organizationKnown = entry.data !== null;
  const organizationName =
    browsedOrganizationId === null
      ? null
      : (accountBootstrap?.organizations.find(
          (organization) => organization.id === browsedOrganizationId,
        )?.name ?? null);
  const fallback = useMemo(
    () =>
      account.status === 'signed_out'
        ? SIGNED_OUT_SETTINGS_NAV_MODEL
        : hostedSettingsNavFallback({
            persisted,
            flags: {
              billingEnabled: billingFlag,
              digestsEnabled: digestsFlag,
              freeAccess: freeAccessFlag,
            },
            browsedOrganizationId: organizationKnown
              ? null
              : browsedOrganizationId,
            organizationName,
          }),
    [
      account.status,
      persisted,
      billingFlag,
      digestsFlag,
      freeAccessFlag,
      organizationKnown,
      browsedOrganizationId,
      organizationName,
    ],
  );
  const model = useMemo(
    () => hostedSettingsNavModel(bootstrap, browsedOrganizationId, fallback),
    [bootstrap, browsedOrganizationId, fallback],
  );
  const groups = useMemo(() => buildSettingsNavGroups(model), [model]);
  const currentKey = selectHostedSettingsRow(
    groups,
    location?.route ?? null,
    browsedOrganizationId,
  );
  return (
    <>
      {/* Held from the first render while the account loads, so rows never
          jump down when it arrives (the rail keeps its scroll anchor). */}
      {account.status !== 'signed_out' ? (
        <SettingsScopePicker
          model={model}
          currentPath={
            location === null ? '' : settingsRouteToPath(location.route)
          }
          onNavigate={(href) => router.push(href)}
          testIdPrefix={HOSTED_SETTINGS_NAV_TEST_ID_PREFIX}
          // Account and organization names are user-authored: replay masks
          // their text. The literal is `POSTHOG_REPLAY_MASK_CLASS` (static
          // for the design lint); the overlay's hosted test pins the two
          // together. It is the recorder's marker, not styling, so the
          // restyle contract does not apply.
          // eslint-disable-next-line shadcn/no-restyle -- replay mask marker
          maskClassName="ph-mask"
        />
      ) : null}
      <SettingsNavGroups
        groups={groups}
        currentKey={currentKey}
        LinkComponent={host.Link}
        testIdPrefix={HOSTED_SETTINGS_NAV_TEST_ID_PREFIX}
      />
      {browsedOrganizationId === null ? appGroup : null}
      {browsedOrganizationId === null ? trailingGroups : null}
    </>
  );
}
