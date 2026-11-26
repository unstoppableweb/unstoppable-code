'use client';

import { useCallback, type JSX } from 'react';
import {
  ORG_TRANSCRIPT_LIST_DEFAULT_LIMIT,
  type OrgTranscriptAccessEvent,
} from '@canopy/protocol/canopy-core/core';
import {
  EmptyStateRow,
  ErrorBanner,
  Skeleton,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_GROUP_CLASS,
  SETTINGS_CARD_ROW_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { withPrivacyClass } from '../../account/privacy-class';
import { useSettingsClient, useSettingsPrivacy } from '../../host';
import { useTranscriptsErrorCopy } from './transcripts-errors';
import {
  accessEventSentence,
  formatTranscriptActivity,
  memberName,
} from './transcripts-format';
import { useLoadMoreSentinel, usePagedList } from './use-paged-list';

/** Plain sample rows the loading skeleton measures. */
const SAMPLE_EVENTS: readonly OrgTranscriptAccessEvent[] = [0, 1, 2].map(
  (index) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`,
    type: 'session_viewed',
    occurredAt: '2026-01-01T12:00:00.000Z',
    actor: { id: null, name: 'Sam Lee', formerMember: false },
    subject: { id: null, name: 'Alex Kim', formerMember: false },
    sessionId: null,
    sessionBranchName: 'feature/sample-branch',
    exportRequestedAt: null,
    sessionCount: null,
    format: null,
  }),
);

function AccessEventRow({
  event,
}: {
  readonly event: OrgTranscriptAccessEvent;
}): JSX.Element {
  const { blockClassName, maskClassName } = useSettingsPrivacy();
  const sentence = accessEventSentence(event);
  return (
    <li
      className={SETTINGS_CARD_ROW_CLASS}
      data-testid={`transcripts-access-event-${event.id}`}
    >
      <p className="min-w-0 text-s text-pretty fg-primary">
        <span className={withPrivacyClass('font-medium', blockClassName)}>
          {memberName(event.actor)}
        </span>{' '}
        <span className={withPrivacyClass('fg-secondary', blockClassName)}>
          {sentence.before}
        </span>
        {sentence.branch === null ? null : (
          <>
            {' '}
            <code
              className={withPrivacyClass(
                'font-mono text-xs fg-secondary',
                maskClassName,
              )}
            >
              {sentence.branch}
            </code>
          </>
        )}
        {sentence.after === '' ? null : (
          <span className="fg-secondary"> {sentence.after}</span>
        )}
      </p>
      <span className="shrink-0 text-xs whitespace-nowrap fg-tertiary">
        {formatTranscriptActivity(event.occurredAt)}
      </span>
    </li>
  );
}

/** Access history: who viewed, downloaded, exported or deleted what, newest first. */
export function TranscriptAccessView({
  organizationId,
}: {
  readonly organizationId: string;
}): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useTranscriptsErrorCopy();
  const load = useCallback(
    async (cursor: string | null) => {
      const result = await client.read(
        'organization.transcripts.accessEvents',
        {
          organizationId,
          limit: ORG_TRANSCRIPT_LIST_DEFAULT_LIMIT,
          ...(cursor === null ? {} : { cursor }),
        },
      );
      return { items: result.events, nextCursor: result.nextCursor };
    },
    [client, organizationId],
  );
  const { state, loadMore, retry } = usePagedList(
    organizationId,
    load,
    (event) => event.id,
    (error: unknown) => errorCopy.loadFailure(error),
  );
  const sentinel = useLoadMoreSentinel(
    state.status === 'ready' &&
      state.nextCursor !== null &&
      !state.loadingMore &&
      state.moreFailure === null,
    loadMore,
  );

  if (state.status === 'error')
    return (
      <ErrorBanner
        errorSource="organization-transcripts-access"
        error={state.failure.copy}
        details={state.failure.details}
        onRetry={retry}
      />
    );

  if (state.status === 'loading')
    return (
      <Skeleton loading label="Loading access history">
        <ul className={SETTINGS_CARD_GROUP_CLASS}>
          {SAMPLE_EVENTS.map((event) => (
            <AccessEventRow key={event.id} event={event} />
          ))}
        </ul>
      </Skeleton>
    );

  return (
    <div className="flex flex-col gap-4" data-testid="transcripts-access">
      {state.items.length === 0 ? (
        <EmptyStateRow
          title="No one has viewed or exported transcripts yet."
          testId="transcripts-access-empty"
        />
      ) : (
        <ul className={SETTINGS_CARD_GROUP_CLASS}>
          {state.items.map((event) => (
            <AccessEventRow key={event.id} event={event} />
          ))}
        </ul>
      )}
      {state.moreFailure === null ? null : (
        <ErrorBanner
          errorSource="organization-transcripts-access-more"
          error={state.moreFailure.copy}
          details={state.moreFailure.details}
          onRetry={retry}
        />
      )}
      <div ref={sentinel} aria-hidden="true" />
    </div>
  );
}
