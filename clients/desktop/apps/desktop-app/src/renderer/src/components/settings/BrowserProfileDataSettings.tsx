import { Stack } from '@canopy/ui-shared/components';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  Button,
  ConfirmDialog,
  Disclosure,
  Notice,
  NoticeButton,
} from '@canopy/ui-shared';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import {
  inlineFailure,
  inlineFailureText,
  type InlineFailure,
} from '@/lib/inline-app-error';
import type { BrowserProfileRecord } from '@canopy/protocol/browser-profiles';
import type {
  BrowserClearPreview,
  BrowserDataJob,
  BrowserDataJobStatus,
  BrowserMaintenanceOperation,
  BrowserProfileDataApi,
  BrowserProfileInventory,
} from '@canopy/protocol/browser-profiles';

const dataClassLabels: Record<string, string> = {
  httpCache: 'HTTP cache',
  allSiteData: 'all site data',
  browserScratch: 'temporary browser attachments',
  cookies: 'cookies',
  fileSystems: 'site files',
  indexedDB: 'databases',
  localStorage: 'local storage',
  serviceWorkers: 'service workers',
  cache: 'site caches',
};
/**
 * Plain-language name for a job status. The wire values (`queued`, `running`,
 * `irreversible`) are transport state, not something to show a user.
 *
 * Typed against the status union rather than `string` so a new wire status
 * fails the build here instead of leaking its raw value into the interface.
 */
const jobStatusLabels: Record<BrowserDataJobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  irreversible: 'Clearing data',
  complete: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};
/** What the job is doing, in the user's words. */
const jobKindLabel = (job: BrowserDataJob): string =>
  job.kind === 'inventory' ? 'Measurement' : 'Data cleanup';

/**
 * What a cleanup is acting on, as the sentence subject.
 *
 * `reset` is the only kind that touches everything. Describing a cache or
 * single-site clear as the profile's browser data would tell the user they had
 * just lost every login they have — the one outcome they would act on, by
 * re-authenticating everywhere or abandoning the profile.
 */
function jobSubject(job: BrowserDataJob): string {
  switch (job.kind) {
    case 'cache':
      return 'the HTTP cache';
    case 'site':
      return 'the selected site data';
    case 'download':
      return 'the download';
    default:
      return 'the browser data for this profile';
  }
}

/**
 * The explanation that follows the job's state, as one sentence.
 *
 * A finished job never borrows in-flight wording: "Complete. Removing the
 * browser data…" reads as a contradiction. Only queued, running, and
 * irreversible jobs describe work still happening; every terminal state says
 * what it left behind. A job that stopped partway says so, because data the
 * user asked to remove may still be on disk.
 */
function describeJob(job: BrowserDataJob): string {
  if (job.message) return job.message;
  if (job.kind === 'inventory') {
    if (job.approximateBytes != null)
      return `${bytes(job.approximateBytes)} of browser data.`;
    if (isActive(job))
      return 'Reading the browser data stored for this profile.';
    if (job.status === 'complete')
      return 'Finished reading the browser data stored for this profile.';
    return `The measurement ${stoppedEnding(job)}.`;
  }
  const subject = jobSubject(job);
  if (isActive(job)) return `Removing ${subject}.`;
  if (job.status === 'complete') return `Removed ${subject}.`;
  return `The cleanup ${stoppedEnding(job)}. Some of ${subject} may still be stored.`;
}

/** How a job that never reached `complete` ended, as a verb phrase. */
function stoppedEnding(job: BrowserDataJob): string {
  if (job.status === 'cancelled') return 'stopped';
  return job.status === 'interrupted' ? 'was interrupted' : 'could not finish';
}
const LOAD_FAILED = "Couldn't load this profile's browser data.";
const isActive = (job: BrowserDataJob): boolean =>
  ['queued', 'running', 'irreversible'].includes(job.status);
const isBlockingMaintenance = (job: BrowserDataJob): boolean =>
  job.kind !== 'inventory' &&
  job.kind !== 'download' &&
  (isActive(job) || (job.status === 'failed' && job.retryable === true));
function bytes(value: number | null | undefined): string {
  if (value == null) return 'Not measured';
  return value < 1024 * 1024
    ? `${Math.round(value / 1024)} KiB`
    : `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

interface BrowserProfileDataSettingsProps {
  profile: BrowserProfileRecord;
  api: BrowserProfileDataApi;
  onChanged: () => Promise<void>;
}

export function BrowserProfileDataSettings({
  profile,
  api,
  onChanged,
}: BrowserProfileDataSettingsProps): JSX.Element {
  const [inventory, setInventory] = useState<BrowserProfileInventory>();
  const [job, setJob] = useState<BrowserDataJob>();
  const [preview, setPreview] = useState<BrowserClearPreview>();
  // A failed load offers Try again; any other failed action keeps the data
  // refresh beside it.
  const [error, setError] = useState<
    (InlineFailure & { readonly failedLoad: boolean }) | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const focusReturn = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const { profileId, storageGeneration, metadataRevision } = profile;
  const refresh = useCallback(async (): Promise<void> => {
    const epoch = generation.current;
    const measured = await api.inventoryGet({ profileId, storageGeneration });
    if (epoch === generation.current) setInventory(measured);
  }, [api, profileId, storageGeneration]);
  useEffect(() => {
    generation.current++;
    const epoch = generation.current;
    setJob(undefined);
    setInventory(undefined);
    setPreview(undefined);
    setError(null);
    setBusy(false);
    void api
      .jobList({ profileId })
      .then((page) => {
        if (epoch === generation.current)
          setJob(
            page.jobs.find(
              (entry) =>
                entry.profileId === profileId && isBlockingMaintenance(entry),
            ) ??
              page.jobs.find(
                (entry) =>
                  entry.profileId === profileId &&
                  entry.kind !== 'download' &&
                  entry.storageGeneration === storageGeneration &&
                  (isActive(entry) || entry.status === 'failed'),
              ),
          );
      })
      .catch((cause: unknown) => {
        reportClientAppError(cause);
      });
    void refresh().catch((cause: unknown) => {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError)
        setError({ ...inlineFailure(appError, LOAD_FAILED), failedLoad: true });
    });
    return (): void => {
      generation.current = epoch + 1;
    };
  }, [api, profileId, storageGeneration, refresh]);
  useEffect(() => {
    setPreview(undefined);
  }, [metadataRevision]);
  useEffect(() => {
    if (!job || !isActive(job)) return;
    const epoch = generation.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (): void => {
      timer = setTimeout(() => {
        void api
          .jobGet({ jobId: job.jobId })
          .then(async (current) => {
            if (cancelled) return;
            setJob(current);
            if (current.status === 'complete') {
              try {
                await onChanged();
                if (epoch !== generation.current) return;
                await refresh();
                if (epoch !== generation.current) return;
                setNotice(
                  current.cleanupPending
                    ? 'Data cleared. Old storage files will be removed after restart.'
                    : 'Browser data operation complete.',
                );
              } catch (cause) {
                const appError = toAppError(resolveClientAppError(cause));
                if (appError && epoch === generation.current)
                  setError({
                    ...inlineFailure(appError, LOAD_FAILED),
                    failedLoad: true,
                  });
              }
            }
          })
          .catch((cause: unknown) => {
            if (cancelled) return;
            const appError = toAppError(resolveClientAppError(cause));
            if (appError)
              setError({
                ...inlineFailure(
                  appError,
                  "Couldn't check on the browser data job.",
                ),
                failedLoad: false,
              });
            poll();
          });
      }, 500);
    };
    poll();
    return (): void => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, job, onChanged, refresh]);
  const run = async (
    action: () => Promise<void>,
    failureSentence: string,
    failedLoad = false,
  ): Promise<void> => {
    const epoch = generation.current;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await action();
    } catch (cause) {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError && epoch === generation.current)
        setError({ ...inlineFailure(appError, failureSentence), failedLoad });
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  };
  const closePreview = (): void => {
    setPreview(undefined);
    focusReturn.current?.focus();
  };
  const showPreview = (operation: BrowserMaintenanceOperation): void => {
    const activeElement = document.activeElement;
    focusReturn.current =
      activeElement instanceof HTMLElement ? activeElement : null;
    const epoch = generation.current;
    void run(async () => {
      const result = await api.previewClear({
        profileId,
        storageGeneration,
        metadataRevision,
        operation,
      });
      if (epoch === generation.current) setPreview(result);
    }, "Couldn't check what this cleanup clears.");
  };
  const blocked =
    busy || !!(job && (isActive(job) || isBlockingMaintenance(job)));
  // Built ahead of the notice so a job with neither control passes no actions
  // at all, rather than an empty fragment the notice would still lay out for.
  const jobButtons = job
    ? [
        job.cancellable ? (
          <NoticeButton
            key="cancel"
            data-testid="browser-profile-cancel-job"
            disabled={busy}
            onClick={() =>
              void run(
                async () => setJob(await api.jobCancel({ jobId: job.jobId })),
                `Couldn't cancel the ${jobKindLabel(job).toLowerCase()}.`,
              )
            }
          >
            {`Cancel ${jobKindLabel(job).toLowerCase()}`}
          </NoticeButton>
        ) : null,
        job.status === 'failed' && job.retryable ? (
          <NoticeButton
            key="retry"
            data-testid="browser-profile-retry-job"
            disabled={busy}
            onClick={() =>
              void run(
                async () => setJob(await api.retryJob({ jobId: job.jobId })),
                `Couldn't restart the ${jobKindLabel(job).toLowerCase()}.`,
              )
            }
          >
            Try again
          </NoticeButton>
        ) : null,
      ].filter(Boolean)
    : [];
  const jobActions = jobButtons.length > 0 ? jobButtons : undefined;
  return (
    <SettingsSection
      title="Browser data"
      ariaLabel="Profile browser data"
      dataTestId="browser-profile-data"
    >
      <DesktopErrorBanner
        errorSource="browser-profile-data-error"
        className=""
        error={error?.error}
        {...(error?.details === undefined ? {} : { details: error.details })}
        {...(error?.failedLoad
          ? { onRetry: (): void => void run(refresh, LOAD_FAILED, true) }
          : {
              secondaryAction: (
                <NoticeButton
                  onClick={() => void run(refresh, LOAD_FAILED, true)}
                >
                  Refresh data
                </NoticeButton>
              ),
            })}
        testId="browser-profile-data-error"
      />
      {notice && <Notice intent="neutral">{notice}</Notice>}
      {job && (
        <Notice
          errorSource="browser-profile-data-job"
          data-testid="browser-profile-data-job"
          intent={job.status === 'failed' ? 'destructive' : 'neutral'}
          title={`${jobKindLabel(job)}: ${jobStatusLabels[job.status]}`}
          actions={jobActions}
        >
          {describeJob(job)}
        </Notice>
      )}
      <SettingsGroup>
        <SettingsRow
          label="Size"
          description={`${
            inventory?.measuredAt
              ? `Last measured ${new Date(inventory.measuredAt).toLocaleString()}. `
              : ''
          }Cache, database, and file-system sizes may be unknown.`}
          control={
            <>
              <span
                data-testid="browser-profile-storage-total"
                className="text-xs tabular-nums fg-secondary"
              >
                {inventory?.approximateBytes == null
                  ? 'Size not measured'
                  : `Approximately ${bytes(inventory.approximateBytes)}`}
              </span>
              <Button
                size="compact"
                variant="secondary"
                disabled={blocked}
                data-testid="browser-profile-measure"
                onClick={() =>
                  void run(async () => {
                    const epoch = generation.current;
                    const result = await api.inventoryStart({
                      operationId: crypto.randomUUID(),
                      profileId,
                      storageGeneration,
                    });
                    if (epoch === generation.current) setJob(result);
                  }, "Couldn't start measuring browser data.")
                }
              >
                Measure data
              </Button>
            </>
          }
        />
        <SettingsRow
          label="Temporary attachments"
          description="Up to 256 MiB per profile and 1 GiB in total. Saved downloads and copied chat attachments are kept."
        />
        <SettingsRow
          label="HTTP cache"
          control={
            <Button
              size="compact"
              variant="secondary"
              disabled={blocked}
              data-testid="browser-profile-clear-cache"
              onClick={() => showPreview({ kind: 'cache' })}
            >
              Clear HTTP cache
            </Button>
          }
        />
        <SettingsRow
          label="Reset data"
          description="Clears all browser data for this profile."
          control={
            <Button
              size="compact"
              variant="secondary"
              disabled={blocked}
              data-testid="browser-profile-reset"
              onClick={() => showPreview({ kind: 'reset' })}
            >
              Reset {profile.kind === 'task' ? 'Task' : 'profile'}
            </Button>
          }
        />
        <SettingsRow
          label="Observed sites"
          description="Site summaries are partial."
        >
          <div
            className="max-h-56 divide-y overflow-auto"
            aria-label="Observed sites"
            data-testid="browser-profile-site-list"
          >
            {inventory?.sites.map((site) => (
              <div
                key={`${site.origin}\n${site.topLevelOrigin}`}
                className="flex items-center justify-between gap-3 py-2 text-s"
              >
                <div className="min-w-0 break-all">
                  <p className="fg-primary">{site.origin}</p>
                  {site.topLevelOrigin !== site.origin && (
                    <p className="text-xs fg-secondary">
                      Embedded in {site.topLevelOrigin}
                    </p>
                  )}
                </div>
                <Button
                  size="compact"
                  variant="secondary"
                  className="shrink-0"
                  disabled={blocked}
                  aria-label={`Clear site data for ${site.origin}`}
                  onClick={() =>
                    showPreview({ kind: 'site', origin: site.origin })
                  }
                >
                  Clear
                </Button>
              </div>
            ))}
            {inventory && inventory.sites.length === 0 && (
              <p className="py-2 text-s fg-secondary">
                No observed sites. Other stored data may still exist.
              </p>
            )}
            {inventory?.nextOffset !== undefined && (
              <Button
                size="compact"
                variant="secondary"
                className="my-1"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const epoch = generation.current;
                    const next = await api.inventoryGet({
                      profileId,
                      storageGeneration,
                      offset: inventory.nextOffset,
                    });
                    if (epoch === generation.current)
                      setInventory({
                        ...next,
                        sites: [...inventory.sites, ...next.sites],
                        cookieDomains: [
                          ...inventory.cookieDomains,
                          ...next.cookieDomains,
                        ],
                      });
                  }, "Couldn't load more sites.")
                }
              >
                Load more sites
              </Button>
            )}
          </div>
        </SettingsRow>
        {!!inventory?.cookieDomains.length && (
          <Disclosure
            label={`${inventory.cookieDomains.length} ${
              inventory.cookieDomains.length === 1
                ? 'cookie domain'
                : 'cookie domains'
            }`}
            dataTestId="browser-profile-cookie-domains"
          >
            <ul className="flex flex-col max-h-32 overflow-auto break-all text-xs fg-secondary gap-1 [&>*]:shrink-0">
              {inventory.cookieDomains.map((entry) => (
                <li key={entry.domain}>
                  {entry.domain} ({entry.count})
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
        {preview && (
          <ConfirmDialog
            dataTestId="browser-profile-clear-preview"
            confirmTestId="browser-profile-confirm-clear"
            title={
              preview.operation.kind === 'site'
                ? `Clear ${preview.operation.origin}?`
                : preview.operation.kind === 'cache'
                  ? 'Clear HTTP cache?'
                  : `Reset ${profile.displayName}?`
            }
            message={
              <Stack gap="tight">
                <p>{preview.warning}</p>
                <p>
                  Clears{' '}
                  {preview.dataClasses
                    .map((name) => dataClassLabels[name] ?? name)
                    .join(', ')}
                  . Affects {preview.tabs.length} saved{' '}
                  {preview.tabs.length === 1 ? 'tab' : 'tabs'}.
                  {preview.cookieDomains.length
                    ? ` Cookies also clear across ports and subdomains in ${preview.cookieDomains.join(', ')}.`
                    : ''}
                </p>
              </Stack>
            }
            confirmLabel="Confirm cleanup"
            destructive
            busy={busy}
            errorMessage={inlineFailureText(error)}
            {...(error?.details === undefined
              ? {}
              : { errorDetails: error.details })}
            // The control that asked for the preview is disabled while the
            // preview loads, so name it rather than restore to <body>.
            restoreFocusRef={focusReturn}
            onCancel={closePreview}
            onConfirm={() =>
              void run(async () => {
                const epoch = generation.current;
                const result = await api.clear({
                  operationId: crypto.randomUUID(),
                  token: preview.token,
                });
                if (
                  epoch === generation.current &&
                  result.profileId === profileId &&
                  result.storageGeneration === storageGeneration
                ) {
                  setJob(result);
                  closePreview();
                }
              }, "Couldn't clear browser data.")
            }
          />
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
