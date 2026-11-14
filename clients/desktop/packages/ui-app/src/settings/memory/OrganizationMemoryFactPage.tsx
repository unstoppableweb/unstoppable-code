'use client';

import { useEffect, useState, type JSX } from 'react';
import type { ExplorerSourceTranscript } from '@canopy/protocol/settings/organization-memory';
import {
  DelayedLoadingPlaceholder,
  ErrorBanner,
  Skeleton,
} from '@canopy/ui-shared/components';
import { useSettingsClient, useSettingsSearchParams } from '../host';
import type { SettingsPageProps } from '../pages/page-props';
import { fetchMemoryFactSource } from './api';
import { FactDetailDrawer } from './FactDetailDrawer';
import { useMemoryErrorCopy } from './memory-error-copy';
import type { SettingsFailure } from '../errors';
import { memoryOrganizationId } from './memory-route';
import {
  MemoryFactsBackLink,
  OrganizationMemoryLayout,
} from './OrganizationMemoryLayout';
import { SourceTranscriptView } from './SourceTranscriptView';
import { Surface } from '@canopy/ui-shared/components';

/** A plain transcript the loading skeleton measures: two short messages. */
const SAMPLE_TRANSCRIPT: ExplorerSourceTranscript = {
  restricted: false,
  evidenceQuote: null,
  source: {
    id: 'memory-source-skeleton',
    transcriptTurnId: null,
    referenceTime: '2026-01-01T12:00:00.000Z',
    actor: { id: 'memory-source-skeleton', name: 'Sam Lee', email: '' },
  },
  messages: [
    {
      scope: 'worktree',
      localChatId: 'memory-source-skeleton',
      localMessageId: 'memory-source-skeleton-1',
      role: 'user',
      status: 'complete',
      content: 'Which database do the integration tests use?',
      occurredAt: '2026-01-01T12:00:00.000Z',
    },
    {
      scope: 'worktree',
      localChatId: 'memory-source-skeleton',
      localMessageId: 'memory-source-skeleton-2',
      role: 'assistant',
      status: 'complete',
      content: 'They run against the staging database on port 5433.',
      occurredAt: '2026-01-01T12:01:00.000Z',
    },
  ],
};

type SelectedTranscript =
  | { status: 'ready'; transcript: ExplorerSourceTranscript | null }
  | { status: 'loading' }
  | { status: 'error'; failure: SettingsFailure; retry: () => void };

interface LoadedSource {
  readonly key: string;
  readonly result:
    | { ok: true; transcript: ExplorerSourceTranscript }
    | { ok: false; failure: SettingsFailure };
}

/**
 * The transcript for the `?source=` the viewer selected. Page data carries
 * the transcript of the source its loader read: the selected one on web, the
 * first one when a host's page data has no query. Any other selection is
 * read through `organization.memory.factSource`.
 */
function useSelectedTranscript(
  orgId: string,
  factId: string,
  pageTranscript: ExplorerSourceTranscript | null,
  sourceId: string | null,
): SelectedTranscript {
  const client = useSettingsClient();
  const errorCopy = useMemoryErrorCopy();
  const needsRead = sourceId !== null && pageTranscript?.source.id !== sourceId;
  // Retry bumps the attempt, which changes the key: the failed result no
  // longer matches, so the view shows its loading placeholder and reads again.
  const [attempt, setAttempt] = useState(0);
  const key = `${orgId}/${factId}/${sourceId ?? ''}/${attempt}`;
  const [loaded, setLoaded] = useState<LoadedSource | null>(null);

  useEffect(() => {
    if (!needsRead || sourceId === null) return;
    let cancelled = false;
    fetchMemoryFactSource(client, orgId, factId, sourceId).then(
      (transcript) => {
        if (!cancelled) setLoaded({ key, result: { ok: true, transcript } });
      },
      (caught: unknown) => {
        if (cancelled) return;
        setLoaded({
          key,
          result: { ok: false, failure: errorCopy.loadFailure(caught) },
        });
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [client, errorCopy, factId, key, needsRead, orgId, sourceId]);

  if (!needsRead) return { status: 'ready', transcript: pageTranscript };
  if (loaded === null || loaded.key !== key) return { status: 'loading' };
  return loaded.result.ok
    ? { status: 'ready', transcript: loaded.result.transcript }
    : {
        status: 'error',
        failure: loaded.result.failure,
        retry: () => setAttempt((current) => current + 1),
      };
}

/**
 * `/organization/[orgId]/memory/fact/[factId]`: the fact's provenance beside
 * one source's transcript, selected with `?source=`.
 */
export function OrganizationMemoryFactPage({
  route,
  page,
}: SettingsPageProps<'organization.memory.fact'>): JSX.Element {
  const orgId = memoryOrganizationId(route);
  const { data } = page;
  // A fact is a drill-down under Facts: that view stays selected, and the
  // content leads with the way back to the list.
  return (
    <OrganizationMemoryLayout
      orgId={orgId}
      team={data.team}
      view="facts"
      enabled={data.enabled}
    >
      {data.enabled && (
        <>
          <MemoryFactsBackLink orgId={orgId} />
          <div className="grid items-start gap-5 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.2fr)]">
            <FactDetailDrawer orgId={orgId} detail={data.detail} embedded />
            <FactSourceTranscript
              orgId={orgId}
              factId={data.detail.id}
              pageTranscript={data.transcript}
            />
          </div>
        </>
      )}
    </OrganizationMemoryLayout>
  );
}

function FactSourceTranscript({
  orgId,
  factId,
  pageTranscript,
}: {
  orgId: string;
  factId: string;
  pageTranscript: ExplorerSourceTranscript | null;
}): JSX.Element {
  const sourceId = useSettingsSearchParams().get('source');
  const selected = useSelectedTranscript(
    orgId,
    factId,
    pageTranscript,
    sourceId,
  );
  if (selected.status === 'loading') {
    return (
      <div className="flex min-h-40">
        <DelayedLoadingPlaceholder slowNote="Still loading the transcript…">
          <Skeleton
            loading
            label="Loading transcript"
            testId="memory-fact-transcript-loading"
          >
            <SourceTranscriptView transcript={SAMPLE_TRANSCRIPT} />
          </Skeleton>
        </DelayedLoadingPlaceholder>
      </div>
    );
  }
  if (selected.status === 'error') {
    return (
      <ErrorBanner
        errorSource="fact-source-transcript-selected"
        className=""
        error={selected.failure.copy}
        details={selected.failure.details}
        onRetry={selected.retry}
      />
    );
  }
  if (selected.transcript === null) {
    return (
      <Surface variant="dashed">
        <div className="py-16 text-center text-s fg-secondary">
          No transcript source is attached to this fact.
        </div>
      </Surface>
    );
  }
  return <SourceTranscriptView transcript={selected.transcript} />;
}
