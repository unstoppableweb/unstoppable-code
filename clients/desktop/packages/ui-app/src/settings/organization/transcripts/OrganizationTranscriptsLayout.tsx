'use client';

import type { JSX, ReactNode } from 'react';
import { TabBar } from '@canopy/ui-shared/components';
import type {
  OrganizationTeamPageData,
  OrganizationTranscriptView,
} from '@canopy/protocol/settings';
import { useSettingsRouter } from '../../host';
import { TeamPage } from '../team-page';
import { teamPagePropsFromData } from '../team-page-props';
import { transcriptsViewHref } from './transcripts-format';

const VIEWS: ReadonlyArray<{
  readonly key: OrganizationTranscriptView;
  readonly label: string;
}> = [
  { key: 'sessions', label: 'Sessions' },
  { key: 'exports', label: 'Exports' },
  { key: 'access', label: 'Access history' },
];

function TranscriptViewsNav({
  orgId,
  view,
}: {
  readonly orgId: string;
  readonly view: OrganizationTranscriptView;
}): JSX.Element {
  const router = useSettingsRouter();
  return (
    <TabBar
      items={VIEWS.map((entry) => ({
        id: entry.key,
        label: entry.label,
        dataTestId: `transcripts-views-tab-${entry.key}`,
      }))}
      value={view}
      onChange={(next): void => router.push(transcriptsViewHref(orgId, next))}
      label="Transcripts views"
      scrollable
      dataTestId="transcripts-views-tabs"
    />
  );
}

export interface OrganizationTranscriptsLayoutProps {
  readonly team: OrganizationTeamPageData;
  readonly view: OrganizationTranscriptView;
  readonly children: ReactNode;
}

/**
 * Every Transcripts view: the organization page shell (its header names the
 * page and says only owners see it), then Sessions / Exports / Access
 * history directly under the header, then the view.
 */
export function OrganizationTranscriptsLayout({
  team,
  view,
  children,
}: OrganizationTranscriptsLayoutProps): JSX.Element {
  return (
    <TeamPage
      key={team.detail.id}
      {...teamPagePropsFromData(team)}
      activeTab="transcripts"
      transcriptsContent={
        <div className="flex flex-col gap-6" data-testid="transcripts-view">
          <TranscriptViewsNav orgId={team.detail.id} view={view} />
          {children}
        </div>
      }
    />
  );
}
