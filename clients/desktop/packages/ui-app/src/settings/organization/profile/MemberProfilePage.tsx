'use client';

import { useCallback, useEffect, useMemo, type JSX } from 'react';
import {
  BarChart3,
  Bot,
  FileText,
  Newspaper,
  Workflow,
} from '@canopy/ui-shared/icons/AppIcons';
import { TabBar, Heading } from '@canopy/ui-shared/components';
import type { MemberProfileHeader } from '@canopy/protocol/team';
import type { OrganizationMember } from '@canopy/protocol/settings';
import {
  SettingsLink,
  useSettingsPathname,
  useSettingsRouter,
  useSettingsSearchParams,
} from '../../host';
import { useViewerDataSharing } from '../use-viewer-data-sharing';
import { OrganizationDataSharingOptIn } from '../web-data-sharing-opt-in';
import { ProfileHeader } from './ProfileHeader';
import type { ProfileEditTarget } from './use-profile-editor';
import { ProfileOverviewSection } from './ProfileOverviewSection';
import { ProfileRunsSection } from './ProfileRunsSection';
import { ProfilePlansSection } from './ProfilePlansSection';
import { ProfileApprovedPlansSection } from './ProfileApprovedPlansSection';
import { ProfileSharedRunsSection } from './ProfileSharedRunsSection';
import { ProfilePipelinesSection } from './ProfilePipelinesSection';
import { SettingsPageColumn } from '../../layout/SettingsPageColumn';
import { ProfileDigestsSection } from './ProfileDigestsSection';

// The `sessions` tab keeps the historical key `runs` so existing `?tab=runs`
// deep links (this tab predates the rename) keep resolving; only its label and
// contents changed — it now stacks the member's shared sessions above the
// most-expensive-sessions cost breakdown.
type ProfileTab = 'overview' | 'digests' | 'runs' | 'plans' | 'pipelines';

const PROFILE_TABS: ReadonlyArray<{
  key: ProfileTab;
  label: string;
  icon: typeof BarChart3;
}> = [
  { key: 'overview', label: 'Overview', icon: BarChart3 },
  { key: 'digests', label: 'Digests', icon: Newspaper },
  { key: 'runs', label: 'Sessions', icon: Bot },
  { key: 'plans', label: 'Plans', icon: FileText },
  { key: 'pipelines', label: 'Workflows', icon: Workflow },
];

function isProfileTab(value: string | null): value is ProfileTab {
  return (
    value === 'overview' ||
    value === 'digests' ||
    value === 'runs' ||
    value === 'plans' ||
    value === 'pipelines'
  );
}

export interface MemberProfilePageProps {
  org: { id: string; name: string };
  member: MemberProfileHeader;
  /** Whether the viewer clears the org's usage-stats role threshold. */
  viewerCanViewStats: boolean;
  /**
   * An owner with the transcript browser on: session rows link to their
   * shared transcripts. Absent from older servers.
   */
  viewerCanViewTranscripts?: boolean;
  /**
   * Non-null when the viewer may edit this profile's name/PFP, carrying which
   * transport to use: `{ mode: 'self' }` for the viewer's own global identity,
   * `{ mode: 'org-member', … }` for an admin editing this member's org-scoped
   * override. `null` renders a read-only header.
   */
  editContext: ProfileEditTarget | null;
  /**
   * Whether the contextual Digests tab is offered. Resolved server-side: the
   * subject always gets it (behind the digest flag), and any other viewer gets
   * it only when the subject has at least one READY digest featured for THIS
   * organization — otherwise every profile in the org would grow an empty tab.
   */
  showDigestsTab?: boolean;
  /** The viewer is the profile subject. Drives headings and row links. */
  isOwnProfile?: boolean;
  /**
   * Server-derived from the request user agent. Mobile browsers cannot open
   * the desktop app, so the own-profile data-sharing hint gives text guidance.
   */
  mobileBrowser: boolean;
}

/**
 * Read-only member profile shell. One route with client-side tabs
 * (Overview / Runs / Plans / Pipelines) sharing a single member resolution;
 * the active tab lives in `?tab=` for deep-linkability. Each tab fetches its
 * own data lazily so a slow section never blocks the others.
 */
export function MemberProfilePage({
  org,
  member,
  viewerCanViewStats,
  viewerCanViewTranscripts = false,
  editContext,
  showDigestsTab = false,
  isOwnProfile = false,
  mobileBrowser,
}: MemberProfilePageProps): JSX.Element {
  const router = useSettingsRouter();
  const pathname = useSettingsPathname();
  const searchParams = useSettingsSearchParams();
  const tabParam = searchParams.get('tab');
  const requestedTab: ProfileTab = isProfileTab(tabParam)
    ? tabParam
    : 'overview';
  // `?tab=digests` on a profile without the tab falls back to Overview rather
  // than rendering a pane whose fetch is guaranteed to 404. Visibility can go
  // stale between renders (another member unfeaturing their last digest), so a
  // shared deep link outliving the feature is a normal case, not an edge one.
  const activeTab: ProfileTab =
    requestedTab === 'digests' && !showDigestsTab ? 'overview' : requestedTab;
  const visibleTabs = PROFILE_TABS.filter(
    (tab) => tab.key !== 'digests' || showDigestsTab,
  );

  // Converge the URL on what was actually rendered. Without this the address
  // bar keeps `?tab=digests` while Overview is showing, so `aria-current`
  // disagrees with the URL, and a refresh or a re-share carries the dead param
  // forward indefinitely. `replace` rather than `push` so the fallback does not
  // add a history entry the Back button would bounce off.
  useEffect(() => {
    if (requestedTab === 'digests' && !showDigestsTab) {
      router.replace(pathname);
    }
  }, [requestedTab, showDigestsTab, router, pathname]);

  // The subject as an OrganizationMember so the activity feed can resolve the
  // actor avatar (all items on this profile are authored by this member).
  const subject = useMemo<OrganizationMember>(
    () => ({
      id: member.id,
      name: member.name,
      email: member.email,
      image: member.image,
      role: member.role,
      subTeamIds: [],
    }),
    [member.id, member.name, member.email, member.image, member.role],
  );

  // CAN-3383: only the viewer's own profile may explain missing work, and
  // never another member's.
  const showSharingHint = isOwnProfile;
  const viewerSharing = useViewerDataSharing(
    showSharingHint ? org.id : null,
    member.id,
  );

  const selectTab = useCallback(
    (tab: ProfileTab): void => {
      const query = tab === 'overview' ? '' : `?tab=${tab}`;
      router.replace(`${pathname}${query}`, { scroll: false });
    },
    [pathname, router],
  );

  return (
    // The shared settings column, wide because a member's profile holds
    // activity charts; the back link leads the page in place of a header.
    <SettingsPageColumn width="wide">
      <div className="flex flex-col gap-6" data-testid="member-profile-page">
        <SettingsLink
          href={`/organization/${org.id}/members`}
          data-testid="member-profile-back"
          className="text-s font-medium fg-secondary transition-colors hover:fg-primary"
        >
          ← Back to {org.name}
        </SettingsLink>

        <ProfileHeader member={member} editContext={editContext} />

        <>
          {showSharingHint && (
            <OrganizationDataSharingOptIn
              feature="member-profiles"
              orgId={org.id}
              organizationName={org.name}
              mobileBrowser={mobileBrowser}
              sharing={viewerSharing}
            />
          )}
          {/* Digests makes this five icon-and-label tabs, past what a
                390px viewport fits, so the strip scrolls sideways. */}
          <TabBar
            items={visibleTabs.map((tab) => {
              const Icon = tab.icon;
              return {
                id: tab.key,
                label: tab.label,
                icon: <Icon size="sm" />,
                dataTestId: `profile-tab-${tab.key}`,
              };
            })}
            value={activeTab}
            onChange={(next): void => selectTab(next)}
            label="Member profile views"
            scrollable
            dataTestId="profile-tabs"
          />

          {activeTab === 'overview' && (
            <ProfileOverviewSection
              orgId={org.id}
              userId={member.id}
              viewerCanViewStats={viewerCanViewStats}
              memberName={member.name}
              subject={subject}
            />
          )}
          {activeTab === 'digests' && (
            <ProfileDigestsSection
              orgId={org.id}
              userId={member.id}
              memberName={member.name}
              isOwnProfile={isOwnProfile}
            />
          )}
          {activeTab === 'runs' && (
            <div
              className="flex flex-col gap-8"
              data-testid="profile-sessions-tab"
            >
              <section className="flex flex-col gap-3">
                <Heading level={2} variant="title">
                  Shared sessions
                </Heading>
                <ProfileSharedRunsSection
                  orgId={org.id}
                  userId={member.id}
                  memberName={member.name}
                />
              </section>
              <ProfileRunsSection
                orgId={org.id}
                userId={member.id}
                viewerCanViewStats={viewerCanViewStats}
                viewerCanViewTranscripts={viewerCanViewTranscripts}
                memberName={member.name}
              />
            </div>
          )}
          {activeTab === 'plans' && (
            <div
              className="flex flex-col gap-8"
              data-testid="profile-plans-tab"
            >
              <section className="flex flex-col gap-3">
                <Heading level={2} variant="title">
                  Shared plans
                </Heading>
                <ProfilePlansSection
                  orgId={org.id}
                  userId={member.id}
                  memberName={member.name}
                />
              </section>
              <section className="flex flex-col gap-3">
                <Heading level={2} variant="title">
                  Implemented plans
                </Heading>
                <ProfileApprovedPlansSection
                  orgId={org.id}
                  userId={member.id}
                  memberName={member.name}
                />
              </section>
            </div>
          )}
          {activeTab === 'pipelines' && (
            <ProfilePipelinesSection
              orgId={org.id}
              userId={member.id}
              memberName={member.name}
            />
          )}
        </>
      </div>
    </SettingsPageColumn>
  );
}
