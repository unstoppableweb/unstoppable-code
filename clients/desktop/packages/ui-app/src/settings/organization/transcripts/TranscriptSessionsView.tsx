'use client';

import { useCallback, useMemo, useState, type JSX } from 'react';
import {
  ORG_TRANSCRIPT_SESSIONS_DEFAULT_LIMIT,
  type OrgTranscriptFilterOptions,
  type OrgTranscriptSessionSummary,
} from '@canopy/protocol/canopy-core/core';
import {
  Badge,
  Button,
  DataTable,
  DisplayAvatar,
  ErrorBanner,
  SettingsSelect,
  type DataTableColumn,
} from '@canopy/ui-shared/components';
import { withPrivacyClass } from '../../account/privacy-class';
import {
  useSettingsClient,
  useSettingsPrivacy,
  useSettingsRouter,
} from '../../host';
import {
  ExportTranscriptsDialog,
  type TranscriptExportFilters,
} from './ExportTranscriptsDialog';
import { useTranscriptsErrorCopy } from './transcripts-errors';
import {
  DEFAULT_TRANSCRIPT_RANGE,
  TRANSCRIPT_RANGE_PRESETS,
  formatCount,
  formatTranscriptActivity,
  formatTranscriptCost,
  memberName,
  transcriptRangeForPreset,
  transcriptRangeLabel,
  transcriptSessionHref,
  transcriptsViewHref,
  type TranscriptRangePreset,
} from './transcripts-format';
import { useLoadMoreSentinel, usePagedList } from './use-paged-list';
import { useTranscriptExportsStatus } from './use-transcript-exports-status';

const ALL = 'all';

export interface TranscriptSessionsViewProps {
  readonly organizationId: string;
  /** From page data: false when this server has no export storage. */
  readonly storageAvailable: boolean;
}

/** The member cell: avatar with initials, the name, and "Former member". */
export function TranscriptMemberCell({
  member,
}: {
  readonly member: OrgTranscriptSessionSummary['member'];
}): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  const name = memberName(member);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <DisplayAvatar
        name={name}
        size="md"
        replayBlocked={blockClassName !== ''}
      />
      <span className={withPrivacyClass('min-w-0 truncate', blockClassName)}>
        {name}
      </span>
      {member.formerMember && member.name !== null ? (
        <Badge tone="neutral" muted>
          Former member
        </Badge>
      ) : null}
    </span>
  );
}

/**
 * Sessions: the filter bar (member, project, date range, model) with
 * Export, and the table of matching sessions, 50 at a time as the reader
 * scrolls. Each row opens the session.
 */
export function TranscriptSessionsView({
  organizationId,
  storageAvailable,
}: TranscriptSessionsViewProps): JSX.Element {
  const client = useSettingsClient();
  const router = useSettingsRouter();
  const errorCopy = useTranscriptsErrorCopy();
  const { blockClassName, maskClassName } = useSettingsPrivacy();
  const [rangePreset, setRangePreset] = useState<TranscriptRangePreset>(
    DEFAULT_TRANSCRIPT_RANGE,
  );
  const [memberUserId, setMemberUserId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [filterOptions, setFilterOptions] =
    useState<OrgTranscriptFilterOptions | null>(null);
  const [exporting, setExporting] = useState(false);
  const exportsStatus = useTranscriptExportsStatus(organizationId);

  const filters = useMemo(
    (): TranscriptExportFilters => ({
      range: transcriptRangeForPreset(rangePreset),
      memberUserId,
      projectId,
      model,
    }),
    [rangePreset, memberUserId, projectId, model],
  );

  // The first page asks for the filter options once, on mount.
  const [optionsRequested, setOptionsRequested] = useState(false);
  const load = useCallback(
    async (cursor: string | null) => {
      const includeFilterOptions = !optionsRequested && cursor === null;
      const result = await client.read('organization.transcripts.sessions', {
        organizationId,
        from: filters.range.from,
        to: filters.range.to,
        ...(filters.memberUserId === null
          ? {}
          : { memberUserId: filters.memberUserId }),
        ...(filters.projectId === null ? {} : { projectId: filters.projectId }),
        ...(filters.model === null ? {} : { model: filters.model }),
        ...(cursor === null ? {} : { cursor }),
        limit: ORG_TRANSCRIPT_SESSIONS_DEFAULT_LIMIT,
        ...(includeFilterOptions ? { includeFilterOptions: true } : {}),
      });
      if (result.filterOptions !== undefined) {
        setFilterOptions(result.filterOptions);
        setOptionsRequested(true);
      }
      return { items: result.sessions, nextCursor: result.nextCursor };
    },
    [client, organizationId, filters, optionsRequested],
  );
  const key = `${organizationId}|${filters.range.from}|${filters.range.to}|${memberUserId ?? ''}|${projectId ?? ''}|${model ?? ''}`;
  const { state, loadMore, retry } = usePagedList(
    key,
    load,
    (session) => session.id,
    (error: unknown) => errorCopy.loadFailure(error),
  );
  const sentinel = useLoadMoreSentinel(
    state.status === 'ready' &&
      state.nextCursor !== null &&
      !state.loadingMore &&
      state.moreFailure === null,
    loadMore,
  );

  const memberOptions = useMemo(
    () => [
      { value: ALL, label: 'All members' },
      ...(filterOptions?.members ?? []).map((member) => ({
        value: member.id,
        label: memberName(member),
      })),
    ],
    [filterOptions],
  );
  const projectOptions = useMemo(
    () => [
      { value: ALL, label: 'All projects' },
      ...(filterOptions?.projects ?? []).map((project) => ({
        value: project.id,
        label: project.name,
      })),
    ],
    [filterOptions],
  );
  const modelOptions = useMemo(
    () => [
      { value: ALL, label: 'Any model' },
      ...(filterOptions?.models ?? []).map((value) => ({
        value,
        label: value,
      })),
    ],
    [filterOptions],
  );
  const rangeOptions = useMemo(
    () =>
      TRANSCRIPT_RANGE_PRESETS.map((preset) => ({
        value: String(preset),
        label: transcriptRangeLabel(preset),
      })),
    [],
  );

  const columns = useMemo(
    (): ReadonlyArray<DataTableColumn<OrgTranscriptSessionSummary>> => [
      {
        key: 'member',
        header: 'Member',
        rowHeader: true,
        render: (session) => <TranscriptMemberCell member={session.member} />,
      },
      {
        key: 'project',
        header: 'Project · branch',
        overflow: 'truncate',
        render: (session) => (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className={withPrivacyClass('truncate', maskClassName)}>
              {session.project.name}
            </span>
            <span
              className={withPrivacyClass(
                'truncate font-mono text-xs fg-secondary',
                maskClassName,
              )}
            >
              {session.branchName}
            </span>
          </span>
        ),
      },
      {
        key: 'lastActivity',
        header: 'Last activity',
        overflow: 'nowrap',
        render: (session) => formatTranscriptActivity(session.lastActivityAt),
      },
      {
        key: 'turns',
        header: 'Turns',
        align: 'right',
        showFrom: 'md',
        render: (session) => formatCount(session.turnCount),
      },
      {
        key: 'model',
        header: 'Model',
        overflow: 'truncate',
        showFrom: 'lg',
        render: (session) => session.model ?? '—',
      },
      {
        key: 'cost',
        header: 'Cost',
        align: 'right',
        showFrom: 'md',
        render: (session) => formatTranscriptCost(session.totalCostUsd),
      },
      {
        key: 'status',
        header: 'Status',
        render: (session) =>
          session.status === 'failed' ? (
            <Badge tone="danger">Failed</Badge>
          ) : (
            <Badge tone="success">Done</Badge>
          ),
      },
    ],
    [maskClassName],
  );

  const memberLabel =
    memberOptions.find((option) => option.value === (memberUserId ?? ALL))
      ?.label ?? 'All members';
  const projectLabel =
    projectOptions.find((option) => option.value === (projectId ?? ALL))
      ?.label ?? 'All projects';
  const exportDisabled =
    !storageAvailable ||
    exportsStatus.status !== 'ready' ||
    !exportsStatus.storageAvailable ||
    exportsStatus.activeExport;

  return (
    <div className="flex flex-col gap-4" data-testid="transcripts-sessions">
      <div className="flex flex-wrap items-center gap-2">
        <SettingsSelect
          aria-label="Member"
          width="fit"
          options={memberOptions}
          value={memberUserId ?? ALL}
          onValueChange={(value): void =>
            setMemberUserId(value === ALL ? null : value)
          }
          replayPrivacy={{ blockClassName }}
          data-testid="transcripts-filter-member"
        />
        <SettingsSelect
          aria-label="Project"
          width="fit"
          options={projectOptions}
          value={projectId ?? ALL}
          onValueChange={(value): void =>
            setProjectId(value === ALL ? null : value)
          }
          replayPrivacy={{ maskClassName }}
          data-testid="transcripts-filter-project"
        />
        <SettingsSelect
          aria-label="Date range"
          width="fit"
          options={rangeOptions}
          value={String(rangePreset)}
          onValueChange={(value): void => {
            const preset = TRANSCRIPT_RANGE_PRESETS.find(
              (candidate) => String(candidate) === value,
            );
            if (preset !== undefined) setRangePreset(preset);
          }}
          data-testid="transcripts-filter-range"
        />
        <SettingsSelect
          aria-label="Model"
          width="fit"
          options={modelOptions}
          value={model ?? ALL}
          onValueChange={(value): void =>
            setModel(value === ALL ? null : value)
          }
          data-testid="transcripts-filter-model"
        />
        <Button
          variant="primary"
          size="compact"
          className="ml-auto"
          disabled={exportDisabled}
          onClick={(): void => setExporting(true)}
          data-testid="transcripts-export"
        >
          Export
        </Button>
      </div>

      {state.status === 'error' ? (
        <ErrorBanner
          errorSource="organization-transcripts-sessions"
          error={state.failure.copy}
          details={state.failure.details}
          onRetry={retry}
        />
      ) : (
        <DataTable
          caption="Sessions"
          columns={columns}
          rows={state.status === 'ready' ? state.items : []}
          rowKey={(session) => session.id}
          loading={state.status === 'loading'}
          emptyLabel="No shared sessions match these filters."
          onRowActivate={(session): void =>
            router.push(transcriptSessionHref(organizationId, session.id))
          }
          breakpoints="container"
          testId="transcripts-sessions-table"
        />
      )}
      {state.status === 'ready' && state.moreFailure !== null ? (
        <ErrorBanner
          errorSource="organization-transcripts-sessions-more"
          error={state.moreFailure.copy}
          details={state.moreFailure.details}
          onRetry={retry}
        />
      ) : null}
      <div ref={sentinel} aria-hidden="true" />

      {exporting ? (
        <ExportTranscriptsDialog
          organizationId={organizationId}
          filters={filters}
          memberLabel={memberLabel}
          projectLabel={projectLabel}
          onClose={(): void => setExporting(false)}
          onStarted={(): void => {
            setExporting(false);
            router.push(transcriptsViewHref(organizationId, 'exports'));
          }}
        />
      ) : null}
    </div>
  );
}
