'use client';

import type { JSX } from 'react';
import type { SettingsPageProps } from '../pages/page-props';
import { MemberProfilePage } from './profile/MemberProfilePage';

/**
 * `/organization/[orgId]/members/[userId]`: a read-only member profile,
 * viewable by any member. Its usage block follows the organization's
 * `usageStatsMinRole`.
 */
export function OrganizationMemberPage({
  page,
}: SettingsPageProps<'organization.member'>): JSX.Element {
  const { data } = page;
  return (
    <MemberProfilePage
      key={`${data.org.id}:${data.member.id}`}
      org={data.org}
      member={data.member}
      viewerCanViewStats={data.viewerCanViewStats}
      viewerCanViewTranscripts={data.viewerCanViewTranscripts === true}
      editContext={data.editContext}
      showDigestsTab={data.showDigestsTab}
      isOwnProfile={data.isOwnProfile}
      mobileBrowser={data.mobileBrowser}
    />
  );
}
