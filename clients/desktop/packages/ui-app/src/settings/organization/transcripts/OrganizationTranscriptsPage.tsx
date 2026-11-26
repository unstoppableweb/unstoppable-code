'use client';

import type { JSX } from 'react';
import type { SettingsPageProps } from '../../pages/page-props';
import { OrganizationTranscriptsLayout } from './OrganizationTranscriptsLayout';
import { TranscriptAccessView } from './TranscriptAccessView';
import { TranscriptExportsView } from './TranscriptExportsView';
import { TranscriptSessionsView } from './TranscriptSessionsView';

/**
 * `/organization/[orgId]/transcripts[/exports|/access]`, owners only. Page
 * data carries the header, the active view and whether exports can be
 * stored; each view loads its rows through `organization.transcripts.*`.
 */
export function OrganizationTranscriptsPage({
  page,
}: SettingsPageProps<'organization.transcripts'>): JSX.Element {
  const { team, view, storageAvailable } = page.data;
  const organizationId = team.detail.id;
  return (
    <OrganizationTranscriptsLayout team={team} view={view}>
      {view === 'sessions' ? (
        <TranscriptSessionsView
          key={organizationId}
          organizationId={organizationId}
          storageAvailable={storageAvailable}
        />
      ) : null}
      {view === 'exports' ? (
        <TranscriptExportsView
          key={organizationId}
          organizationId={organizationId}
        />
      ) : null}
      {view === 'access' ? (
        <TranscriptAccessView
          key={organizationId}
          organizationId={organizationId}
        />
      ) : null}
    </OrganizationTranscriptsLayout>
  );
}
