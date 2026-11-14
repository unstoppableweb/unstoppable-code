'use client';

import { useRef, useState, type JSX } from 'react';
import type {
  ExplorerIngestJob,
  ExplorerIngestJobStatus,
  ExplorerMemoryConfigSnapshot,
  ExplorerSearchLogEntry,
} from '@canopy/protocol/settings/organization-memory';
import {
  Stack,
  Badge,
  DataTable,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  SettingsSelect,
  Skeleton,
  EmptyStateRow,
  ValueRow,
  ValueRows,
  Heading,
  type DataTableColumn,
} from '@canopy/ui-shared/components';
import { withPrivacyClass } from '../account/privacy-class';
import { useSettingsClient, useSettingsPrivacy } from '../host';
import { fetchMemoryJobs } from './api';
import { useMemoryErrorCopy } from './memory-error-copy';
import type { SettingsFailure } from '../errors';
import { Surface } from '@canopy/ui-shared/components';

interface OpsViewProps {
  orgId: string;
  jobs: ExplorerIngestJob[];
  counts: Record<ExplorerIngestJobStatus, number>;
  searchEntries: ExplorerSearchLogEntry[];
  config: ExplorerMemoryConfigSnapshot;
}

const STATUSES: readonly ExplorerIngestJobStatus[] = [
  'PENDING',
  'RUNNING',
  'DONE',
  'FAILED',
  'DEAD',
];

function statusClasses(status: ExplorerIngestJobStatus): string {
  if (status === 'DONE') return 'bg-success-subtle fg-success';
  if (status === 'FAILED' || status === 'DEAD') {
    return 'bg-destructive-subtle fg-destructive';
  }
  if (status === 'RUNNING') return 'bg-accent-subtle fg-accent-strong';
  return 'bg-base fg-secondary';
}

const JOB_COLUMNS: ReadonlyArray<DataTableColumn<ExplorerIngestJob>> = [
  {
    key: 'status',
    header: 'Status',
    render: (job) => (
      <span
        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusClasses(job.status)}`}
      >
        {job.status}
      </span>
    ),
  },
  {
    key: 'created',
    header: 'Created',
    render: (job) => new Date(job.createdAt).toLocaleString(),
  },
  {
    key: 'attempts',
    header: 'Attempts',
    align: 'right',
    render: (job) => job.attempts,
  },
  {
    key: 'heartbeat',
    header: 'Heartbeat',
    render: (job) =>
      job.heartbeatStale ? (
        <Badge tone="danger">Stale</Badge>
      ) : job.lastHeartbeatAt === null ? (
        '—'
      ) : (
        new Date(job.lastHeartbeatAt).toLocaleString()
      ),
  },
  {
    key: 'lastError',
    header: 'Last error',
    overflow: 'truncate',
    render: (job) => job.lastError ?? '—',
  },
];

/** Plain jobs the loading skeleton measures. */
const SAMPLE_JOBS: readonly ExplorerIngestJob[] = [1, 2, 3].map(
  (index): ExplorerIngestJob => ({
    id: `memory-job-skeleton-${String(index)}`,
    status: 'DONE',
    attempts: 1,
    notBefore: '2026-01-01T12:00:00.000Z',
    lockedBy: null,
    lockedAt: null,
    lastHeartbeatAt: '2026-01-01T12:00:00.000Z',
    heartbeatStale: false,
    lastError: null,
    createdAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-01T12:00:00.000Z',
  }),
);

function isJobStatus(value: string): value is ExplorerIngestJobStatus {
  return STATUSES.some((status) => status === value);
}

export function OpsView({
  orgId,
  jobs,
  counts,
  searchEntries,
  config,
}: OpsViewProps): JSX.Element {
  const client = useSettingsClient();
  const { blockClassName } = useSettingsPrivacy();
  const errorCopy = useMemoryErrorCopy();
  const [status, setStatus] = useState<ExplorerIngestJobStatus | 'ALL'>('ALL');
  // Status selection refetches from the status-aware endpoint — the initial
  // server payload is only the first page, so filtering it client-side would
  // hide older jobs of the selected status while counts still report them.
  const [filteredJobs, setFilteredJobs] = useState<ExplorerIngestJob[] | null>(
    null,
  );
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<SettingsFailure | null>(null);
  const requestSeq = useRef(0);
  const selectStatus = (next: ExplorerIngestJobStatus | 'ALL'): void => {
    setStatus(next);
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    if (next === 'ALL') {
      setFilteredJobs(null);
      setJobsLoading(false);
      setJobsError(null);
      return;
    }
    setFilteredJobs(null);
    setJobsLoading(true);
    setJobsError(null);
    void fetchMemoryJobs(client, orgId, next)
      .then((payload) => {
        if (requestSeq.current !== seq) return;
        setFilteredJobs(payload.jobs);
      })
      .catch((caught: unknown) => {
        if (requestSeq.current !== seq) return;
        setJobsError(errorCopy.loadFailure(caught));
      })
      .finally(() => {
        if (requestSeq.current === seq) setJobsLoading(false);
      });
  };
  const visibleJobs = status === 'ALL' ? jobs : (filteredJobs ?? []);

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
      <Stack gap="section">
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Stack gap="tight">
              <Heading level={2} variant="section">
                Ingest jobs
              </Heading>
              <p className="text-xs fg-secondary">
                Attempts, worker heartbeat, and terminal errors.
              </p>
            </Stack>
            <SettingsSelect
              value={status}
              onValueChange={(value) => {
                if (value === 'ALL' || isJobStatus(value)) {
                  selectStatus(value);
                }
              }}
              width="fill"
              aria-label="Filter ingest jobs"
              options={[
                { value: 'ALL', label: 'All jobs' },
                ...STATUSES.map((item) => ({
                  value: item,
                  label: `${item} (${counts[item]})`,
                })),
              ]}
            />
          </div>
          {jobsError !== null && visibleJobs.length === 0 ? (
            <ErrorBanner
              errorSource="ops-jobs"
              className=""
              error={jobsError.copy}
              details={jobsError.details}
              onRetry={() => selectStatus(status)}
            />
          ) : jobsLoading && visibleJobs.length === 0 ? (
            <DelayedLoadingPlaceholder slowNote="Still loading ingest jobs…">
              <Skeleton
                loading
                label="Loading ingest jobs"
                testId="memory-jobs-table-loading"
              >
                <DataTable
                  columns={JOB_COLUMNS}
                  rows={SAMPLE_JOBS}
                  rowKey={(job) => job.id}
                  caption="Ingest jobs"
                  testId="memory-jobs-table"
                  minWidth="47.5rem"
                />
              </Skeleton>
            </DelayedLoadingPlaceholder>
          ) : (
            <DataTable
              columns={JOB_COLUMNS}
              rows={visibleJobs}
              rowKey={(job) => job.id}
              caption="Ingest jobs"
              testId="memory-jobs-table"
              emptyLabel="No ingest jobs"
              minWidth="47.5rem"
            />
          )}
        </section>

        <Surface gap="group" as="section" variant="card" padding="default">
          <Heading level={2} variant="section">
            Recently injected
          </Heading>
          <div className="border-l pl-4 flex flex-col gap-4">
            {searchEntries.length === 0 ? (
              <EmptyStateRow title="No search activity yet." />
            ) : (
              searchEntries.map((entry) => (
                <Stack
                  as="article"
                  gap="inline"
                  key={entry.id}
                  className="relative"
                >
                  <span
                    className={`absolute -left-5.25 top-1 h-2.5 w-2.5 rounded-full ${
                      entry.gatePassed ? 'bg-success' : 'bg-fg-tertiary'
                    }`}
                  />
                  <Stack gap="tight">
                    <div className="flex flex-wrap items-center gap-2 text-xs fg-secondary">
                      <time dateTime={entry.createdAt}>
                        {new Date(entry.createdAt).toLocaleString()}
                      </time>
                      <span>·</span>
                      <span>{entry.latencyMs} ms</span>
                      <span
                        className={
                          entry.gatePassed ? 'fg-success' : 'fg-secondary'
                        }
                      >
                        {entry.gatePassed ? 'gate passed' : 'gate blocked'}
                      </span>
                    </div>
                    <p
                      className={withPrivacyClass(
                        'text-s font-medium fg-primary',
                        blockClassName,
                      )}
                    >
                      {entry.query ??
                        (entry.queryDecryptFailed
                          ? 'Encrypted query unavailable'
                          : 'Empty query')}
                    </p>
                    <p className="text-xs fg-secondary">
                      {blockClassName === '' ? (
                        (entry.user.name ?? entry.user.email)
                      ) : (
                        <span className={blockClassName}>
                          {entry.user.name ?? entry.user.email}
                        </span>
                      )}{' '}
                      · {entry.injectedFacts.length} facts injected
                    </p>
                  </Stack>
                  {entry.injectedFacts.length > 0 && (
                    <Stack as="ul" gap="tight">
                      {entry.injectedFacts.map((fact) => (
                        <Surface as="li" variant="inset" key={fact.id}>
                          <div
                            className={withPrivacyClass(
                              'line-clamp-2 px-2 py-1.5 text-xs fg-secondary',
                              blockClassName,
                            )}
                          >
                            {fact.factText}
                          </div>
                        </Surface>
                      ))}
                    </Stack>
                  )}
                </Stack>
              ))
            )}
          </div>
        </Surface>
      </Stack>

      <Surface
        as="aside"
        gap="inline"
        variant="card"
        padding="default"
        className="self-start xl:sticky xl:top-6"
      >
        <Heading level={2} variant="section">
          Effective configuration
        </Heading>
        <ValueRows>
          {Object.entries(config).map(([key, value]) => (
            <ValueRow
              key={key}
              label={key}
              value={value === null ? 'not set' : String(value)}
              numeric={false}
              mono
            />
          ))}
        </ValueRows>
      </Surface>
    </div>
  );
}
