import { useCallback, useEffect, useRef, useState } from 'react';
import {
  linkRecordedError,
  recordedErrorOf,
  recordSurfacedError,
} from '@canopy/ui-shared';

export interface MarketplaceSourceBulkInstallProgress {
  readonly done: number;
  readonly total: number;
}

export interface MarketplaceSourceBulkInstallOutcome {
  readonly installed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly cancelled: number;
  readonly uncertain?: number;
}

export interface UseMarketplaceSourceBulkInstallResult {
  readonly running: boolean;
  readonly cancelling: boolean;
  readonly progress: MarketplaceSourceBulkInstallProgress | undefined;
  readonly summary: string | undefined;
  /** Snapshot `pluginKeys` and install them one at a time. */
  readonly start: (pluginKeys: readonly string[]) => void;
  /** Stop after the current plugin settles. */
  readonly cancel: () => void;
}

export interface UseMarketplaceSourceBulkInstallOptions {
  readonly enabled?: boolean;
  readonly canStart?: () => boolean;
  readonly formatSummary?: (
    outcome: MarketplaceSourceBulkInstallOutcome,
    total: number,
  ) => string;
  readonly sourceId: string;
  readonly installPlugin: (
    sourceId: string,
    pluginKey: string,
  ) => Promise<boolean | null>;
  /** Read at execution time so plugins satisfied meanwhile are skipped. */
  readonly stillNeedsInstall: (pluginKey: string) => boolean;
}

export function marketplaceSourceBulkInstallSummary(
  outcome: MarketplaceSourceBulkInstallOutcome,
): string {
  const parts = [`Installed ${outcome.installed}`];
  if (outcome.skipped > 0) parts.push(`${outcome.skipped} already installed`);
  if (outcome.uncertain) parts.push(`${outcome.uncertain} need a status check`);
  if (outcome.failed > 0) parts.push(`${outcome.failed} failed`);
  if (outcome.cancelled > 0) parts.push(`${outcome.cancelled} cancelled`);
  return `${parts.join(', ')}.`;
}

/**
 * Sequential bulk install with cancel-after-current. Unmount or a source
 * change stops scheduling; an in-flight install still settles through the
 * shared state that owns `installPlugin`.
 */
export function useMarketplaceSourceBulkInstall({
  sourceId,
  enabled = true,
  canStart,
  formatSummary,
  installPlugin,
  stillNeedsInstall,
}: UseMarketplaceSourceBulkInstallOptions): UseMarketplaceSourceBulkInstallResult {
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<
    MarketplaceSourceBulkInstallProgress | undefined
  >(undefined);
  const [summary, setSummary] = useState<string | undefined>(undefined);
  const formatSummaryRef = useRef(formatSummary);
  formatSummaryRef.current = formatSummary;
  const canStartRef = useRef(canStart);
  canStartRef.current = canStart;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const runIdRef = useRef(0);
  const cancelRef = useRef(false);
  const runningRef = useRef(false);
  const installRef = useRef(installPlugin);
  installRef.current = installPlugin;
  const neededRef = useRef(stillNeedsInstall);
  neededRef.current = stillNeedsInstall;

  useEffect(() => {
    setRunning(false);
    setCancelling(false);
    setProgress(undefined);
    setSummary(undefined);
    return (): void => {
      runIdRef.current += 1;
      cancelRef.current = true;
      runningRef.current = false;
    };
  }, [enabled, sourceId]);

  const start = useCallback(
    (pluginKeys: readonly string[]) => {
      if (
        !enabledRef.current ||
        canStartRef.current?.() === false ||
        runningRef.current ||
        pluginKeys.length === 0
      )
        return;
      runIdRef.current += 1;
      const runId = runIdRef.current;
      const keys = [...pluginKeys];
      const live = (): boolean => runIdRef.current === runId;
      cancelRef.current = false;
      runningRef.current = true;
      setRunning(true);
      setCancelling(false);
      setSummary(undefined);
      setProgress({ done: 0, total: keys.length });
      void (async (): Promise<void> => {
        let firstError: { readonly error: unknown } | undefined;
        const outcome = {
          installed: 0,
          failed: 0,
          skipped: 0,
          cancelled: 0,
          uncertain: 0,
        };
        for (let index = 0; index < keys.length; index += 1) {
          if (!live()) return;
          if (cancelRef.current) {
            outcome.cancelled = keys.length - index;
            break;
          }
          const key = keys[index];
          if (key === undefined || !neededRef.current(key)) {
            outcome.skipped += 1;
          } else {
            try {
              const installed = await installRef.current(sourceId, key);
              if (installed === null) {
                outcome.uncertain += 1;
                outcome.cancelled = keys.length - index - 1;
                break;
              }
              if (installed) outcome.installed += 1;
              else outcome.failed += 1;
              // installPlugin (useMarketplaceSources) catches its own install
              // failures: it links a host-recorded error to the session or leaves
              // it to the source banner, then resolves false. So this catch only
              // sees a host whose install rejects; those are recorded here once
              // per run.
            } catch (error) {
              outcome.failed += 1;
              firstError ??= { error };
            }
          }
          if (live()) setProgress({ done: index + 1, total: keys.length });
        }
        // One record per run: the summary counts the rest, and every failure
        // of a source usually shares one cause. A failure main recorded (it
        // reached here carrying that record) is linked to this session, not
        // recorded again.
        if (firstError) {
          if (recordedErrorOf(firstError.error))
            linkRecordedError(
              firstError.error,
              'marketplace-source-bulk-install',
            );
          else
            recordSurfacedError({
              chokePoint: 'notice',
              surface: 'inline',
              identifier: 'marketplace-source-bulk-install',
              error: firstError.error,
            });
        }
        if (!live()) return;
        runningRef.current = false;
        setRunning(false);
        setCancelling(false);
        setProgress(undefined);
        setSummary(
          formatSummaryRef.current?.(outcome, keys.length) ??
            marketplaceSourceBulkInstallSummary(outcome),
        );
      })();
    },
    [sourceId],
  );

  const cancel = useCallback(() => {
    if (!runningRef.current) return;
    cancelRef.current = true;
    setCancelling(true);
  }, []);

  return { running, cancelling, progress, summary, start, cancel };
}
