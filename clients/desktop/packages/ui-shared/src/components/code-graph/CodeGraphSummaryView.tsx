import { Stack } from '../Stack';
import type { JSX, ReactNode } from 'react';
import { Button } from '../Button';
import { LoadingSpinner } from '../LoadingSpinner';
import {
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsRowsSection,
} from '../settings/SettingsRows';
import { Notice, NoticeButton } from '../Notice';
import { StatusLabel } from '../StatusLabel';
import { EmptyStateRow } from '../StatusBlocks';

/**
 * Graph state shown by the summary. `'partial'` applies only to the aggregate
 * summary; repository rows use `'missing' | 'ready' | 'stale' | 'error'`.
 */
export type CodeGraphSummaryViewState =
  | 'missing'
  | 'ready'
  | 'partial'
  | 'stale'
  | 'error';

/**
 * Readability of the published summary, independent of source generation.
 * `'readable'` means the counts were measured; the other states carry no
 * measured counts.
 */
export type CodeGraphSummaryViewSnapshotState =
  | 'missing'
  | 'summary-pending'
  | 'readable'
  | 'read-error';

/** Source generation activity for the scope, independent of readability. */
export type CodeGraphSummaryViewBuildState = 'idle' | 'queued' | 'running';

/** Shown while the published summary is still being prepared. */
export const CODE_GRAPH_SUMMARY_PENDING_MESSAGE =
  'Code Graph details are being prepared. Try again.';

/** Shown when a read of the published summary failed and can be retried. */
export const CODE_GRAPH_SUMMARY_READ_FAILURE_MESSAGE =
  'Could not read the Code Graph. Try again.';

/** Shown when the read was turned away because the graph was busy. */
export const CODE_GRAPH_SUMMARY_BUSY_MESSAGE =
  'Code Graph is busy. Try again in a moment.';

/** Measured graph counts for one summary scope. */
export interface CodeGraphSummaryViewTotals {
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  unresolvedEdgeCount: number;
  filesWithErrors: number;
  communityCount: number;
  flowCount: number;
}

/** One repository row. Hosts may pass richer objects; only these fields render. */
export interface CodeGraphSummaryViewRepository {
  repoId: string;
  name: string;
  state: CodeGraphSummaryViewState;
  /** Epoch ms of the last build for this repository, or null if never built. */
  lastBuildAt: number | null;
  gitHead: string | null;
}

/**
 * Browser-safe summary data. Structurally compatible with the desktop
 * `CodeGraphUiSummary`, so a host can pass its summary through unchanged.
 * Carries safe display data only, never a filesystem or shadow path.
 */
export interface CodeGraphSummaryViewData {
  enabled: boolean;
  state: CodeGraphSummaryViewState;
  repositories: readonly CodeGraphSummaryViewRepository[];
  totals: CodeGraphSummaryViewTotals;
  /** Epoch ms of the most recent build across the scope, or null. */
  lastBuildAt: number | null;
  /** Safe, human-readable message. */
  message?: string;
  /**
   * Readability of the published summary. When absent (older hosts), an
   * aggregate `'error'` state is treated as unmeasured.
   */
  snapshotState?: CodeGraphSummaryViewSnapshotState;
  /** Source generation activity; never hides readable counts. */
  buildState?: CodeGraphSummaryViewBuildState;
}

export interface CodeGraphSummaryViewProps {
  /**
   * Load lifecycle owned by the host. While `'loading'` with a summary, the
   * previous summary stays in place until the read settles.
   */
  phase: 'loading' | 'loaded' | 'error';
  /**
   * Last loaded summary, or null when none is available. Hosts clear it when
   * a read fails, so retained counts are never shown after a failure.
   */
  summary: CodeGraphSummaryViewData | null;
  /** Safe message shown when the summary could not be loaded. */
  loadErrorMessage: string;
  /** Readiness from a failed read; carries no availability or measured counts. */
  loadSnapshotState?: CodeGraphSummaryViewSnapshotState;
  /** Safe, retryable build failure shown inline, or null. */
  buildErrorMessage: string | null;
  /** True while a build started here or elsewhere is running. */
  building: boolean;
  /** Loads the summary again after a load failure. */
  onRetry: () => void;
  /** Starts a build or refresh of the graph. */
  onBuild: () => void;
  /** Opens Code Graph settings. */
  onOpenSettings: () => void;
  testId?: string;
  /**
   * `cards` shows the counts as stat cards, for a dialog. `rows` shows them
   * as plain settings rows with the update action on the first row, for a
   * settings page.
   */
  layout?: 'cards' | 'rows';
}

type SummaryReadiness = 'missing' | 'pending' | 'unreadable' | 'measured';

/**
 * Whether the summary's counts were measured. Pending and unreadable
 * summaries carry placeholder totals that must not render as metrics.
 */
function summaryReadiness(summary: CodeGraphSummaryViewData): SummaryReadiness {
  switch (summary.snapshotState) {
    case 'missing':
      return 'missing';
    case 'summary-pending':
      return 'pending';
    case 'read-error':
      return 'unreadable';
    case 'readable':
      return 'measured';
    default:
      if (summary.state === 'missing') return 'missing';
      if (summary.state === 'error') return 'unreadable';
      return 'measured';
  }
}

function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : '0';
}

function formatTimestamp(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) {
    return 'Never';
  }
  return new Date(ms).toLocaleString();
}

function shortGitHead(gitHead: string | null): string | null {
  if (!gitHead) {
    return null;
  }
  const trimmed = gitHead.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 7) : null;
}

function repositoryStateLabel(state: CodeGraphSummaryViewState): string {
  switch (state) {
    case 'ready':
      return 'Ready';
    case 'missing':
      return 'Not generated';
    case 'stale':
      return 'Stale';
    case 'error':
      return 'Error';
    default:
      return 'Ready';
  }
}

function repositoryStateClassName(state: CodeGraphSummaryViewState): string {
  switch (state) {
    case 'ready':
      return 'fg-accent';
    case 'stale':
      return 'fg-warning';
    case 'error':
      return 'fg-destructive';
    default:
      return 'fg-secondary';
  }
}

function MetricCard({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId?: string;
}): JSX.Element {
  return (
    <div className="rounded-lg border bg-base px-3 py-2.5" data-testid={testId}>
      <div className="text-lg font-semibold fg-primary">{value}</div>
      <div className="text-xs fg-secondary">{label}</div>
    </div>
  );
}

function SummaryDetails({
  summary,
}: {
  summary: CodeGraphSummaryViewData;
}): JSX.Element {
  const { totals } = summary;
  return (
    <Stack gap="group" data-testid="code-graph-summary-details">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricCard
          label="Files"
          value={formatCount(totals.fileCount)}
          testId="code-graph-metric-files"
        />
        <MetricCard
          label="Symbols"
          value={formatCount(totals.symbolCount)}
          testId="code-graph-metric-symbols"
        />
        <MetricCard
          label="Edges"
          value={formatCount(totals.edgeCount)}
          testId="code-graph-metric-edges"
        />
        <MetricCard
          label="Repositories"
          value={formatCount(summary.repositories.length)}
          testId="code-graph-metric-repositories"
        />
      </div>

      {/* The same rows the Settings page shows for these numbers (design
          call 6B, 2026-10-31). */}
      <SettingsRowsGroup dataTestId="code-graph-summary-health">
        <HealthRows totals={totals} />
        <SummaryRow
          label="Last generated"
          trailing={
            <span className="text-s tabular-nums fg-secondary">
              {formatTimestamp(summary.lastBuildAt)}
            </span>
          }
        />
      </SettingsRowsGroup>

      {summary.repositories.length > 1 && (
        <ul
          className="flex flex-col gap-1.5"
          data-testid="code-graph-repository-list"
        >
          {summary.repositories.map((repository) => (
            <RepositoryRow key={repository.repoId} repository={repository} />
          ))}
        </ul>
      )}
    </Stack>
  );
}

function RepositoryRow({
  repository,
}: {
  repository: CodeGraphSummaryViewRepository;
}): JSX.Element {
  const sha = shortGitHead(repository.gitHead);
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border bg-base px-3 py-2"
      data-testid={`code-graph-repository-${repository.repoId}`}
    >
      <div className="min-w-0">
        <div className="truncate text-s font-medium fg-primary">
          {repository.name}
        </div>
        <div className="text-xs fg-secondary">
          Last published {formatTimestamp(repository.lastBuildAt)}
          {sha ? ` · ${sha}` : ''}
        </div>
      </div>
      <span
        className={`shrink-0 text-xs font-medium ${repositoryStateClassName(
          repository.state,
        )}`}
      >
        {repositoryStateLabel(repository.state)}
      </span>
    </li>
  );
}

/** One settings row: label and hint leading, value or control trailing. */
function SummaryRow({
  label,
  description,
  trailing,
  testId,
}: {
  label: string;
  description?: ReactNode;
  trailing: ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    <SettingsRowsRow
      label={label}
      description={description}
      control={trailing}
      dataTestId={testId}
    />
  );
}

/** A section of rows: a text-only heading over one grouped box. */
function SummarySection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <SettingsRowsSection title={title} description={description}>
      <SettingsRowsGroup>{children}</SettingsRowsGroup>
    </SettingsRowsSection>
  );
}

function CountValue({ value }: { value: number }): JSX.Element {
  return (
    <span className="text-s tabular-nums fg-secondary">
      {formatCount(value)}
    </span>
  );
}

function BuildButton({
  building,
  label,
  onBuild,
  testId,
}: {
  building: boolean;
  label: string;
  onBuild: () => void;
  testId: string;
}): JSX.Element {
  return (
    <Button
      size="compact"
      onClick={onBuild}
      disabled={building}
      data-testid={testId}
    >
      {building && <LoadingSpinner decorative />}
      {label}
    </Button>
  );
}

/** The index's health counts as settings rows, in a group the caller owns. */
function HealthRows({
  totals,
}: {
  totals: CodeGraphSummaryViewData['totals'];
}): JSX.Element {
  return (
    <>
      <SummaryRow
        label="Unresolved edges"
        description="Calls the graph could not link to a definition."
        trailing={<CountValue value={totals.unresolvedEdgeCount} />}
      />
      <SummaryRow
        label="Files with errors"
        description="Files the parser could not read completely."
        trailing={<CountValue value={totals.filesWithErrors} />}
      />
      <SummaryRow
        label="Communities"
        trailing={<CountValue value={totals.communityCount} />}
      />
      <SummaryRow
        label="Flows"
        trailing={<CountValue value={totals.flowCount} />}
      />
    </>
  );
}

/** The loaded summary as settings rows: index counts, then health. */
function SummaryRows({
  summary,
  status,
  buildAction,
}: {
  summary: CodeGraphSummaryViewData;
  status: ReactNode;
  buildAction: ReactNode;
}): JSX.Element {
  const { totals } = summary;
  return (
    <div
      className="flex flex-col gap-10"
      data-testid="code-graph-summary-details"
    >
      <SummarySection title="Index">
        <SummaryRow
          label="Code Graph"
          description={status}
          trailing={buildAction}
        />
        <SummaryRow
          label="Files"
          trailing={<CountValue value={totals.fileCount} />}
          testId="code-graph-metric-files"
        />
        <SummaryRow
          label="Symbols"
          trailing={<CountValue value={totals.symbolCount} />}
          testId="code-graph-metric-symbols"
        />
        <SummaryRow
          label="Edges"
          trailing={<CountValue value={totals.edgeCount} />}
          testId="code-graph-metric-edges"
        />
        <SummaryRow
          label="Repositories"
          trailing={<CountValue value={summary.repositories.length} />}
          testId="code-graph-metric-repositories"
        />
      </SummarySection>
      <SummarySection
        title="Health"
        description="High numbers are normal in large repositories. They matter when they grow suddenly."
      >
        <HealthRows totals={totals} />
      </SummarySection>
      {summary.repositories.length > 1 && (
        <SummarySection title="Repositories">
          {summary.repositories.map((repository) => {
            const sha = shortGitHead(repository.gitHead);
            return (
              <SummaryRow
                key={repository.repoId}
                testId={`code-graph-repository-${repository.repoId}`}
                label={repository.name}
                description={`Last published ${formatTimestamp(repository.lastBuildAt)}${sha ? ` · ${sha}` : ''}`}
                trailing={
                  <span
                    className={`text-xs font-medium ${repositoryStateClassName(repository.state)}`}
                  >
                    {repositoryStateLabel(repository.state)}
                  </span>
                }
              />
            );
          })}
        </SummarySection>
      )}
    </div>
  );
}

function RetryButton({
  onRetry,
  disabled,
  testId,
}: {
  onRetry: () => void;
  disabled: boolean;
  testId: string;
}): JSX.Element {
  return (
    <NoticeButton onClick={onRetry} disabled={disabled} data-testid={testId}>
      Try again
    </NoticeButton>
  );
}

/**
 * Notice shown in place of metrics when the summary's counts were not
 * measured: a pending summary is announced as status, an unreadable one as
 * an alert. Only an explicit read failure offers Retry; an older error
 * summary recovers by updating the graph instead.
 */
function ReadinessNotice({
  readiness,
  snapshotState,
  message,
  refreshing,
  onRetry,
  testId,
}: {
  readiness: 'pending' | 'unreadable';
  snapshotState?: CodeGraphSummaryViewSnapshotState;
  message?: string;
  refreshing: boolean;
  onRetry: () => void;
  testId: string;
}): JSX.Element {
  if (readiness === 'pending') {
    return (
      <Notice
        intent="neutral"
        shape="settings"
        data-testid={`${testId}-pending`}
        actions={
          <RetryButton
            onRetry={onRetry}
            disabled={refreshing}
            testId={`${testId}-retry`}
          />
        }
      >
        {CODE_GRAPH_SUMMARY_PENDING_MESSAGE}
      </Notice>
    );
  }
  return (
    <Notice
      errorSource="code-graph-summary"
      intent="destructive"
      shape="settings"
      data-testid={`${testId}-message`}
      actions={
        snapshotState === 'read-error' ? (
          <RetryButton
            onRetry={onRetry}
            disabled={refreshing}
            testId={`${testId}-retry`}
          />
        ) : undefined
      }
    >
      {message || CODE_GRAPH_SUMMARY_READ_FAILURE_MESSAGE}
    </Notice>
  );
}

/**
 * Pure Code Graph summary display shared by every host. Renders the loading,
 * load failure, disabled, missing, pending, unreadable, and loaded states from
 * props; the host owns loading, building, retries, and any state reporting.
 *
 * Counts render only when they were measured. A pending or unreadable summary
 * shows its notice in place of the metrics instead of placeholder zeros, and
 * readable counts stay visible whatever the source generation is doing.
 */
export function CodeGraphSummaryView({
  phase,
  summary,
  loadErrorMessage,
  loadSnapshotState,
  buildErrorMessage,
  building,
  onRetry,
  onBuild,
  onOpenSettings,
  testId = 'code-graph-summary',
  layout = 'cards',
}: CodeGraphSummaryViewProps): JSX.Element {
  // A reload keeps the previous summary in place until the read settles.
  if (phase === 'loading' && !summary) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-12"
        data-testid={`${testId}-loading`}
      >
        <LoadingSpinner tone="secondary" />
        <span className="text-s fg-secondary">Loading Code Graph…</span>
      </div>
    );
  }

  if (phase === 'error' || !summary) {
    const pending = loadSnapshotState === 'summary-pending';
    const unreadable = loadSnapshotState === 'read-error';
    return (
      <div
        className="flex flex-col gap-3 py-4"
        data-testid={pending ? testId : `${testId}-error`}
      >
        {pending || unreadable ? (
          <ReadinessNotice
            readiness={pending ? 'pending' : 'unreadable'}
            snapshotState={loadSnapshotState}
            message={loadErrorMessage}
            refreshing={building}
            onRetry={onRetry}
            testId={testId}
          />
        ) : (
          <Notice
            errorSource="code-graph-summary-load"
            intent="destructive"
            shape="settings"
            actions={
              <RetryButton
                onRetry={onRetry}
                disabled={building}
                testId={`${testId}-retry`}
              />
            }
          >
            {loadErrorMessage}
          </Notice>
        )}
        {buildErrorMessage && (
          <Notice
            errorSource="code-graph-summary-build"
            intent="destructive"
            shape="settings"
            data-testid={`${testId}-build-error`}
          >
            {buildErrorMessage}
          </Notice>
        )}
        {unreadable && (
          <Button
            className="self-start"
            variant="primary"
            size="compact"
            onClick={onBuild}
            disabled={building}
            data-testid={`${testId}-build`}
          >
            {building && <LoadingSpinner />}
            {building ? 'Updating Code Graph…' : 'Update Code Graph'}
          </Button>
        )}
      </div>
    );
  }

  const refreshing = phase === 'loading';
  const readiness = summaryReadiness(summary);
  const measured = readiness === 'measured';
  const hasData = readiness !== 'missing';
  const buildActionLabel = hasData
    ? 'Update Code Graph'
    : 'Generate Code Graph';
  const buildingLabel = hasData
    ? 'Updating Code Graph…'
    : 'Generating Code Graph…';

  return (
    <Stack gap="group" data-testid={testId} aria-busy={refreshing || undefined}>
      {!summary.enabled ? (
        <Stack gap="item">
          <Notice
            intent="neutral"
            shape="settings"
            role="none"
            data-testid={`${testId}-disabled-callout`}
            actions={
              <NoticeButton
                onClick={onOpenSettings}
                data-testid={`${testId}-open-settings`}
              >
                Open Code Graph settings
              </NoticeButton>
            }
          >
            Code Graph is not enabled for this project.
          </Notice>
          {/* Retained measured data stays visible read-only beneath the
              callout; an unmeasured summary says why instead. */}
          {(readiness === 'pending' || readiness === 'unreadable') && (
            <ReadinessNotice
              readiness={readiness}
              snapshotState={summary.snapshotState}
              message={summary.message}
              refreshing={refreshing}
              onRetry={onRetry}
              testId={testId}
            />
          )}
          {measured && <SummaryDetails summary={summary} />}
        </Stack>
      ) : layout === 'rows' && readiness === 'measured' ? (
        <div className="flex flex-col gap-4">
          {buildErrorMessage && (
            <Notice
              errorSource="code-graph-summary-build"
              intent="destructive"
              shape="settings"
              data-testid={`${testId}-build-error`}
            >
              {buildErrorMessage}
            </Notice>
          )}
          <SummaryRows
            summary={summary}
            status={
              building ? (
                buildingLabel
              ) : summary.message ? (
                summary.state === 'error' ? (
                  <StatusLabel data-testid={`${testId}-message`}>
                    {summary.message}
                  </StatusLabel>
                ) : (
                  <span data-testid={`${testId}-message`}>
                    {summary.message}
                  </span>
                )
              ) : (
                `Updated ${formatTimestamp(summary.lastBuildAt)}`
              )
            }
            buildAction={
              <BuildButton
                building={building}
                label="Update"
                onBuild={onBuild}
                testId={`${testId}-build`}
              />
            }
          />
        </div>
      ) : layout === 'rows' && readiness === 'missing' ? (
        <div className="flex flex-col gap-4" data-testid={`${testId}-missing`}>
          {buildErrorMessage && (
            <Notice
              errorSource="code-graph-summary-build"
              intent="destructive"
              shape="settings"
              data-testid={`${testId}-build-error`}
            >
              {buildErrorMessage}
            </Notice>
          )}
          <SummarySection title="Index">
            <SummaryRow
              label="Code Graph"
              description={
                building
                  ? buildingLabel
                  : 'No Code Graph has been generated yet.'
              }
              trailing={
                <BuildButton
                  building={building}
                  label="Generate"
                  onBuild={onBuild}
                  testId={`${testId}-build`}
                />
              }
            />
          </SummarySection>
        </div>
      ) : readiness === 'missing' ? (
        <div className="flex flex-col gap-3" data-testid={`${testId}-missing`}>
          <EmptyStateRow title="No Code Graph has been generated yet." />
          {buildErrorMessage && (
            <Notice
              errorSource="code-graph-summary-build"
              intent="destructive"
              shape="settings"
              data-testid={`${testId}-build-error`}
            >
              {buildErrorMessage}
            </Notice>
          )}
          <Button
            className="self-start"
            variant="primary"
            size="compact"
            onClick={onBuild}
            disabled={building}
            data-testid={`${testId}-build`}
          >
            {building && <LoadingSpinner />}
            {building ? buildingLabel : buildActionLabel}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {readiness === 'pending' || readiness === 'unreadable' ? (
            <ReadinessNotice
              readiness={readiness}
              snapshotState={summary.snapshotState}
              message={summary.message}
              refreshing={refreshing}
              onRetry={onRetry}
              testId={testId}
            />
          ) : (
            <>
              {summary.message && (
                <p
                  className="text-xs fg-secondary"
                  data-testid={`${testId}-message`}
                >
                  {summary.state === 'error' ? (
                    <StatusLabel>{summary.message}</StatusLabel>
                  ) : (
                    summary.message
                  )}
                </p>
              )}
              <SummaryDetails summary={summary} />
            </>
          )}
          {buildErrorMessage && (
            <Notice
              errorSource="code-graph-summary-build"
              intent="destructive"
              shape="settings"
              data-testid={`${testId}-build-error`}
            >
              {buildErrorMessage}
            </Notice>
          )}
          <Button
            className="self-start"
            variant="primary"
            size="compact"
            onClick={onBuild}
            disabled={building}
            data-testid={`${testId}-build`}
          >
            {building && <LoadingSpinner />}
            {building ? buildingLabel : buildActionLabel}
          </Button>
        </div>
      )}
    </Stack>
  );
}
