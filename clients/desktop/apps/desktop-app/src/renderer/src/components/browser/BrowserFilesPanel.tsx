import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { BrowserTransfer } from '@canopy/desktop-shared/types';
import { useBrowserStore } from '@/stores/browserStore';
import { BrowserTransferRow } from './BrowserTransferRow';
import { transferStoppedAnnouncement } from './browserTransferFormat';
import { ErrorBanner, ErrorState } from '@canopy/ui-shared/components';

interface BrowserFilesPanelProps {
  browserId: string;
}

type LoadState = 'loading' | 'ready' | 'failed' | 'retrying';

const EMPTY: BrowserTransfer[] = [];

/**
 * The inspector's Files tab: this browser's downloads in the task's folder,
 * newest first. Opening it loads the list from main; `transfer` events keep
 * it live afterwards.
 */
export function BrowserFilesPanel({
  browserId,
}: BrowserFilesPanelProps): JSX.Element {
  const transfers = useBrowserStore((s) => s.transfers[browserId] ?? EMPTY);
  const hydrateTransfers = useBrowserStore((s) => s.hydrateTransfers);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const announcement = useStoppedTransferAnnouncement(transfers);
  const failed = loadState === 'failed' || loadState === 'retrying';

  const load = useCallback((): void => {
    // A retry keeps the failure on screen until it settles.
    setLoadState((current) =>
      current === 'failed' || current === 'retrying' ? 'retrying' : 'loading',
    );
    void hydrateTransfers(browserId)
      .then(() => setLoadState('ready'))
      .catch(() => setLoadState('failed'));
  }, [browserId, hydrateTransfers]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div
      data-testid="browser-files-panel"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div role="status" className="sr-only">
        {announcement}
      </div>
      {failed && transfers.length > 0 && (
        <div className="shrink-0 p-2">
          <ErrorBanner
            errorSource="browser-files-panel"
            className=""
            error="Couldn't load downloads."
            onRetry={load}
            retrying={loadState === 'retrying'}
          />
        </div>
      )}
      {failed && transfers.length === 0 ? (
        <ErrorState
          space="panel"
          message="Couldn't load downloads."
          onRetry={load}
          retrying={loadState === 'retrying'}
        />
      ) : transfers.length > 0 ? (
        <ul aria-label="Downloads" className="min-h-0 flex-1 overflow-auto">
          {transfers.map((transfer) => (
            <BrowserTransferRow
              key={transfer.id}
              browserId={browserId}
              transfer={transfer}
            />
          ))}
        </ul>
      ) : loadState === 'ready' ? (
        <div
          data-testid="browser-files-empty"
          className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs fg-secondary"
        >
          Files you download here appear in this list.
        </div>
      ) : null}
    </div>
  );
}

/**
 * The latest download that stopped without finishing, for screen readers.
 * Completion is announced by the pane's toast instead, and progress is not
 * announced at all.
 */
function useStoppedTransferAnnouncement(
  transfers: readonly BrowserTransfer[],
): string {
  const previous = useRef<Map<string, BrowserTransfer['status']> | null>(null);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    const seen = previous.current;
    const next = new Map(
      transfers.map((transfer) => [transfer.id, transfer.status]),
    );
    previous.current = next;
    if (seen === null) {
      return;
    }
    const stopped = transfers.find(
      (transfer) =>
        seen.has(transfer.id) &&
        seen.get(transfer.id) !== transfer.status &&
        transferStoppedAnnouncement(transfer) !== null,
    );
    if (stopped) {
      setAnnouncement(transferStoppedAnnouncement(stopped) ?? '');
    }
  }, [transfers]);

  return announcement;
}
