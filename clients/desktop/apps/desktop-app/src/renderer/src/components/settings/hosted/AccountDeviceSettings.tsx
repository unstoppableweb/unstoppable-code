import type { JSX, ReactNode } from 'react';
import type { AccountSettingsPage } from '@canopy/protocol/settings';
import {
  DelayedLoadingPlaceholder,
  Divider,
  NoticeShapeProvider,
  Skeleton,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import { SettingsCard } from '@canopy/ui-shared/components/settings/SettingsCard';
import { ProviderAuthPanel } from '@/components/auth/ProviderAuthPanel';
import { brandText } from '@/lib/brand';
import { CanopyCloudAccountSection } from '../CanopyCloudAccountSection';
import { LinearKeyRow } from '../LinearKeyRow';
import { SlackMentionsSection } from '../SlackMentionsRow';
import {
  CategoryRows,
  InAppNotificationRows,
  OsNotificationRows,
  PromotionalNotificationRows,
  PromotionalNotificationsLoadFailedNotice,
} from '../NotificationDeviceSections';
import { useNotificationSettings } from '../notification-settings';
import { PersonalCatalogRows } from '../PersonalCatalogSettings';
import { SettingsRow } from '../SettingsLayout';

/**
 * Desktop-only "On this computer" sections under a hosted account page
 * (rendered through the shared frame's `after` region). They hold what the
 * hosted page cannot: this computer's cloud sign-in, notification
 * preferences, GitHub sign-in, Linear key, Slack mentions switch and
 * personal-catalog choice.
 *
 * The sections read and write through `window.api` only, never the hosted
 * settings client or store, so they work signed out and while hosted data
 * loads or fails. They render as shared `SettingsCard` sections, the same
 * text-only heading and grouped rows as the hosted sections above them, so
 * "On this computer" reads as one more section of the page rather than a
 * second card style.
 */

function DeviceSettingsRegion({
  page,
  children,
}: {
  page: AccountSettingsPage;
  children: ReactNode;
}): JSX.Element {
  return (
    <section
      aria-label="On this computer"
      className="flex flex-col gap-10"
      data-testid={`account-device-settings-${page}`}
    >
      {children}
    </section>
  );
}

/**
 * A section body: the desktop rows, divided like a settings group. The rows
 * bring their own 12px inset; `data-settings-card-rows` tells the shared box
 * to drop its own vertical inset, as it does for shared rows.
 */
function DeviceCardRows({
  notice,
  children,
}: {
  notice?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3" data-settings-card-rows="">
      {notice}
      <div className="flex flex-col divide-y *:py-3">
        {/* A notice inside a row is part of that row, not a card. */}
        <NoticeShapeProvider shape="default">{children}</NoticeShapeProvider>
      </div>
    </div>
  );
}

function AccountPageDeviceSettings(): JSX.Element {
  return (
    <DeviceSettingsRegion page="account">
      <SettingsCard
        title="On this computer"
        testId="account-device-card-cloud-account"
      >
        <DeviceCardRows>
          <CanopyCloudAccountSection />
        </DeviceCardRows>
      </SettingsCard>
    </DeviceSettingsRegion>
  );
}

function ProfilePageDeviceSettings(): JSX.Element | null {
  // Nothing at all, not even the heading, while the catalog is hidden.
  return (
    <PersonalCatalogRows
      placement="public-profile"
      renderFrame={({ notices, row }) => (
        <DeviceSettingsRegion page="profile">
          <SettingsCard
            title="On this computer"
            subtitle="Only you can see your personal projects on the web. Project names and repository details can be sensitive."
            testId="personal-catalog-settings"
          >
            <DeviceCardRows notice={notices}>{row}</DeviceCardRows>
          </SettingsCard>
        </DeviceSettingsRegion>
      )}
    />
  );
}

const noop = (): void => undefined;

/** Plain notification rows the loading skeleton lays out. */
const SAMPLE_NOTIFICATION_ROWS = [
  {
    label: 'Show in-app banners',
    description: 'Banners inside the app for the events you choose below.',
  },
  {
    label: 'Send OS notifications',
    description:
      'Native desktop notifications while the app is in the background.',
  },
  {
    label: 'Skip when focused',
    description: 'No OS notification while this window is in front.',
  },
] as const;

/**
 * The notifications card while preferences load: the "On this computer"
 * card and its switch rows, from sample rows. No switch shows a value the
 * user did not choose: the skeleton draws over them unseen.
 */
function NotificationsDeviceSkeleton(): JSX.Element {
  return (
    <DelayedLoadingPlaceholder slowNote="Still loading notification settings…">
      <Skeleton
        loading
        label="Loading notification settings"
        testId="account-device-settings-loading"
      >
        <SettingsCard title="On this computer">
          <DeviceCardRows>
            {SAMPLE_NOTIFICATION_ROWS.map((row) => (
              <SettingsRow
                key={row.label}
                label={row.label}
                description={row.description}
                control={
                  <ToggleSwitch
                    checked={false}
                    label={row.label}
                    onChange={noop}
                  />
                }
              />
            ))}
          </DeviceCardRows>
        </SettingsCard>
      </Skeleton>
    </DelayedLoadingPlaceholder>
  );
}

function NotificationsPageDeviceSettings(): JSX.Element {
  const settings = useNotificationSettings();
  return (
    <DeviceSettingsRegion page="notifications">
      {settings.loaded ? (
        <>
          <SettingsCard
            title="On this computer"
            testId="account-device-card-notifications"
          >
            <div data-testid="account-device-card-in-app-notifications">
              <DeviceCardRows>
                <InAppNotificationRows settings={settings} />
              </DeviceCardRows>
            </div>
            <div data-testid="account-device-card-os-notifications">
              <Divider />
              <DeviceCardRows>
                <OsNotificationRows settings={settings} />
              </DeviceCardRows>
            </div>
          </SettingsCard>
          {settings.activationJourneyEnabled ? (
            <SettingsCard
              title="Promotional notifications"
              subtitle={`Tips and product news from ${brandText.appName}, sent as OS notifications. Agent, approval, and failure alerts are not affected.`}
              testId="notifications-promotional-section"
            >
              <DeviceCardRows
                notice={
                  <PromotionalNotificationsLoadFailedNotice
                    settings={settings}
                  />
                }
              >
                <PromotionalNotificationRows settings={settings} />
              </DeviceCardRows>
            </SettingsCard>
          ) : null}
          <SettingsCard
            title="Categories"
            subtitle={
              <>
                Which events show a banner and which send an OS notification.
                Sounds set to <em>Default</em> use the default sound above.
              </>
            }
            testId="account-device-card-notification-categories"
          >
            <DeviceCardRows>
              <CategoryRows settings={settings} />
            </DeviceCardRows>
          </SettingsCard>
        </>
      ) : (
        <NotificationsDeviceSkeleton />
      )}
    </DeviceSettingsRegion>
  );
}

function IntegrationsPageDeviceSettings(): JSX.Element {
  return (
    <DeviceSettingsRegion page="integrations">
      <SettingsCard title="On this computer" testId="account-device-card-tools">
        <div data-testid="account-device-card-github">
          <DeviceCardRows>
            <ProviderAuthPanel provider="github" layout="row" />
          </DeviceCardRows>
        </div>
        <div data-testid="account-device-card-linear">
          <Divider />
          <DeviceCardRows>
            <LinearKeyRow />
          </DeviceCardRows>
        </div>
        <SlackMentionsSection />
      </SettingsCard>
    </DeviceSettingsRegion>
  );
}

export interface AccountDeviceSettingsProps {
  /** The hosted account page the sections sit under. */
  readonly page: AccountSettingsPage;
}

/**
 * This computer's settings for a hosted account page, or `null` for pages
 * without device content (Digests, Security, Billing and their detail
 * routes, and Labs, Plugins and MCP servers, which desktop shows in its own
 * sections).
 */
export function AccountDeviceSettings({
  page,
}: AccountDeviceSettingsProps): JSX.Element | null {
  switch (page) {
    case 'account':
      return <AccountPageDeviceSettings />;
    case 'profile':
      return <ProfilePageDeviceSettings />;
    case 'notifications':
      return <NotificationsPageDeviceSettings />;
    case 'integrations':
      return <IntegrationsPageDeviceSettings />;
    case 'digests':
    case 'security':
    case 'model-providers':
    case 'ai-gateway':
    case 'billing':
    case 'plugins':
    case 'mcp':
    case 'delegation':
    case 'labs':
    case 'appearance':
      return null;
  }
}
