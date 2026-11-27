'use client';

import { useCallback, useRef, useState, type JSX } from 'react';
import type {
  OrgTranscriptSessionSummary,
  OrgTranscriptTurn,
} from '@canopy/protocol/canopy-core/core';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  Button,
  ErrorBanner,
  MENU_GAP,
  Menu,
  InlineMeasuredSkeleton,
  MemoryTranscriptEntry,
  Notice,
  Skeleton,
  type ActionMenuItem,
} from '@canopy/ui-shared/components';
import { ChevronDown } from '@canopy/ui-shared/icons/AppIcons';
import { PageHeader } from '@canopy/ui-shared/primitives/PageHeader';
import { withPrivacyClass } from '../../account/privacy-class';
import {
  useSettingsErrorCopy,
  useSettingsAccessLostRefresh,
  type KnownSettingsError,
} from '../../errors';
import {
  SettingsLink,
  useSettingsClient,
  useSettingsDownloadFile,
  useSettingsPrivacy,
} from '../../host';
import { SettingsPageColumn } from '../../layout/SettingsPageColumn';
import { MarkdownTranscriptMessage } from '../../memory/SourceTranscriptView';
import { useMemorySettingsSlots } from '../../memory/memory-settings-slots';
import type { SettingsPageProps } from '../../pages/page-props';
import {
  TRANSCRIPTS_DOWNLOAD_FAILED_COPY,
  TRANSCRIPTS_LOAD_ERRORS,
  downloadFailureCopy,
} from './transcripts-errors';
import {
  formatSessionTimeRange,
  formatTranscriptCost,
  memberName,
  sessionDownloadPath,
  transcriptsViewHref,
  turnCountLabel,
} from './transcripts-format';
import { useLoadMoreSentinel, usePagedList } from './use-paged-list';

const SESSION_NOT_FOUND_COPY =
  "This session isn't available. It may no longer be shared with the organization.";

const SESSION_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  ...TRANSCRIPTS_LOAD_ERRORS,
  { code: 'not_found', copy: SESSION_NOT_FOUND_COPY },
];

const UNAVAILABLE_TURN_COPY = "This part of the transcript isn't available.";

type DownloadFormat = 'md' | 'jsonl';

/** A plain transcript the loading skeleton measures. */
const SAMPLE_TURN: OrgTranscriptTurn = {
  id: '00000000-0000-4000-8000-000000000000',
  startedAt: '2026-01-01T12:00:00.000Z',
  completedAt: '2026-01-01T12:01:00.000Z',
  model: null,
  messages: [
    {
      scope: 'worktree',
      localChatId: 'transcript-skeleton',
      localMessageId: 'transcript-skeleton-1',
      role: 'user',
      status: 'complete',
      content: 'Which database do the integration tests use?',
      occurredAt: '2026-01-01T12:00:00.000Z',
    },
    {
      scope: 'worktree',
      localChatId: 'transcript-skeleton',
      localMessageId: 'transcript-skeleton-2',
      role: 'assistant',
      status: 'complete',
      content: 'They run against the staging database on port 5433.',
      occurredAt: '2026-01-01T12:01:00.000Z',
    },
  ],
};

function DownloadMenu({
  disabled,
  onDownload,
}: {
  readonly disabled: boolean;
  readonly onDownload: (format: DownloadFormat) => void;
}): JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const items: ActionMenuItem<DownloadFormat>[] = [
    {
      key: 'md',
      label: 'Markdown (.md)',
      icon: null,
      testId: 'transcript-download-md',
      onSelect: (): void => onDownload('md'),
    },
    {
      key: 'jsonl',
      label: 'JSONL (.jsonl)',
      icon: null,
      testId: 'transcript-download-jsonl',
      onSelect: (): void => onDownload('jsonl'),
    },
  ];
  return (
    <>
      <Button
        ref={anchorRef}
        variant="secondary"
        size="compact"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={(): void => setOpen(!open)}
        data-testid="transcript-download"
      >
        Download
        <ChevronDown size={14} aria-hidden="true" />
      </Button>
      <Menu
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-right"
        gap={MENU_GAP}
        interaction="menu"
        aria-label="Download format"
        className="w-44"
      >
        <ActionMenuRowStyle>
          <ActionMenuItems
            items={items}
            onSelect={(item): void => {
              setOpen(false);
              anchorRef.current?.focus({ preventScroll: true });
              item.onSelect?.();
            }}
          />
        </ActionMenuRowStyle>
      </Menu>
    </>
  );
}

function SessionMeta({
  session,
}: {
  readonly session: OrgTranscriptSessionSummary;
}): JSX.Element {
  const { blockClassName, maskClassName } = useSettingsPrivacy();
  const parts: { key: string; text: string; className?: string }[] = [
    {
      key: 'member',
      text: memberName(session.member),
      className: blockClassName,
    },
    { key: 'project', text: session.project.name, className: maskClassName },
    { key: 'turns', text: turnCountLabel(session.turnCount) },
    ...(session.model === null ? [] : [{ key: 'model', text: session.model }]),
    { key: 'cost', text: formatTranscriptCost(session.totalCostUsd) },
    {
      key: 'time',
      text: formatSessionTimeRange(
        session.firstActivityAt,
        session.lastActivityAt,
      ),
    },
  ];
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-s fg-secondary"
      data-testid="transcript-session-meta"
    >
      {parts.map((part, index) => (
        <span key={part.key} className="flex items-center gap-2">
          {index === 0 ? null : <span aria-hidden="true">·</span>}
          <span className={withPrivacyClass('', part.className ?? '')}>
            {part.text}
          </span>
        </span>
      ))}
    </p>
  );
}

function TranscriptTurns({
  turns,
}: {
  readonly turns: readonly OrgTranscriptTurn[];
}): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  const { TranscriptMessage = MarkdownTranscriptMessage } =
    useMemorySettingsSlots();
  return (
    <div className="flex flex-col gap-3" data-testid="transcript-session-turns">
      {turns.map((turn) =>
        turn.unavailable === undefined ? (
          <div
            key={turn.id}
            className={withPrivacyClass('flex flex-col gap-3', blockClassName)}
          >
            {turn.messages.map((message) => (
              <MemoryTranscriptEntry
                key={message.localMessageId}
                highlighted={false}
              >
                <TranscriptMessage message={message} />
              </MemoryTranscriptEntry>
            ))}
          </div>
        ) : (
          <Notice
            key={turn.id}
            intent="attention"
            data-testid={`transcript-turn-unavailable-${turn.id}`}
          >
            {UNAVAILABLE_TURN_COPY}
          </Notice>
        ),
      )}
    </div>
  );
}

/**
 * `/organization/[orgId]/transcripts/sessions/[sessionId]`: one shared
 * session, owners only. The transcript loads on mount through
 * `organization.transcripts.session` (the first page records the view) and
 * further turns load as the reader scrolls. Download offers Markdown and
 * JSONL through the host's download port.
 */
export function OrganizationTranscriptSessionPage({
  page,
}: SettingsPageProps<'organization.transcripts.session'>): JSX.Element {
  const { team, sessionId } = page.data;
  const organizationId = team.detail.id;
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy('organization-transcripts');
  const refreshOnAccessLost = useSettingsAccessLostRefresh();
  const downloadFile = useSettingsDownloadFile();
  const { maskClassName } = useSettingsPrivacy();
  const [session, setSession] = useState<OrgTranscriptSessionSummary | null>(
    null,
  );
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      const result = await client.read('organization.transcripts.session', {
        organizationId,
        sessionId,
        ...(cursor === null ? {} : { turnsCursor: cursor }),
      });
      setSession(result.session);
      return { items: result.turns, nextCursor: result.nextTurnsCursor };
    },
    [client, organizationId, sessionId],
  );
  const toFailure = useCallback(
    (error: unknown) => {
      refreshOnAccessLost(error);
      return errorCopy.loadFailure(error, SESSION_KNOWN_ERRORS);
    },
    [errorCopy, refreshOnAccessLost],
  );
  const { state, loadMore, retry } = usePagedList(
    `${organizationId}/${sessionId}`,
    load,
    (turn) => turn.id,
    toFailure,
  );
  const sentinel = useLoadMoreSentinel(
    state.status === 'ready' &&
      state.nextCursor !== null &&
      !state.loadingMore &&
      state.moreFailure === null,
    loadMore,
  );

  const download = async (format: DownloadFormat): Promise<void> => {
    setDownloadNotice(null);
    if (downloadFile === null || session === null) {
      setDownloadNotice(TRANSCRIPTS_DOWNLOAD_FAILED_COPY);
      return;
    }
    const date = session.lastActivityAt.slice(0, 10);
    const result = await downloadFile({
      path: sessionDownloadPath(organizationId, sessionId, format),
      suggestedName: `${session.branchName}-${date}.${format}`,
    });
    setDownloadNotice(downloadFailureCopy(result));
  };

  const sessionsHref = transcriptsViewHref(organizationId, 'sessions');

  return (
    <SettingsPageColumn as="main" width="wide">
      <nav aria-label="Breadcrumb" data-testid="transcript-session-breadcrumb">
        <ol className="flex items-center gap-1 text-s fg-secondary">
          <li>
            <SettingsLink
              href={sessionsHref}
              className="transition-colors hover:fg-primary"
            >
              Transcripts
            </SettingsLink>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <SettingsLink
              href={sessionsHref}
              className="transition-colors hover:fg-primary"
            >
              Sessions
            </SettingsLink>
          </li>
        </ol>
      </nav>
      <PageHeader
        inset="none"
        headingLevel="h1"
        reserveActions
        title={
          session === null ? (
            <InlineMeasuredSkeleton>
              <span className="font-mono">feature/branch-name</span>
            </InlineMeasuredSkeleton>
          ) : (
            <span className={withPrivacyClass('font-mono', maskClassName)}>
              {session.branchName}
            </span>
          )
        }
        description={
          session === null ? undefined : <SessionMeta session={session} />
        }
        actions={
          <DownloadMenu
            disabled={session === null || downloadFile === null}
            onDownload={(format): void => void download(format)}
          />
        }
      />
      {downloadNotice === null ? null : (
        <Notice
          intent="destructive"
          errorSource="organization-transcripts-session-download"
          onDismiss={(): void => setDownloadNotice(null)}
        >
          {downloadNotice}
        </Notice>
      )}
      {state.status === 'error' ? (
        <ErrorBanner
          errorSource="organization-transcripts-session"
          error={state.failure.copy}
          details={state.failure.details}
          onRetry={retry}
        />
      ) : null}
      {state.status === 'loading' ? (
        <Skeleton loading label="Loading transcript">
          <TranscriptTurns turns={[SAMPLE_TURN]} />
        </Skeleton>
      ) : null}
      {state.status === 'ready' ? (
        <>
          <TranscriptTurns turns={state.items} />
          {state.moreFailure === null ? null : (
            <ErrorBanner
              errorSource="organization-transcripts-session-more"
              error={state.moreFailure.copy}
              details={state.moreFailure.details}
              onRetry={retry}
            />
          )}
          <div ref={sentinel} aria-hidden="true" />
        </>
      ) : null}
    </SettingsPageColumn>
  );
}
