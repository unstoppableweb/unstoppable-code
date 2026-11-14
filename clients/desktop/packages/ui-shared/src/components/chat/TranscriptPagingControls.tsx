'use client';

import { memo, useEffect, useRef, type JSX } from 'react';
import { LoadingSpinner } from '../LoadingSpinner';
import { Notice, NoticeButton } from '../Notice';
import { TRY_AGAIN_LABEL } from '../useRetry';

export interface TranscriptPagingControlsProps {
  loading: boolean;
  error: string | null;
  hasEarlier: boolean;
  needsLoad?: boolean;
  suspended?: boolean;
  onLoadEarlier: () => void;
  onReload: () => void;
}

/** Place inside the transcript scrollport, at the gap being loaded. */
export const TranscriptPagingControls = memo(function TranscriptPagingControls({
  loading,
  error,
  hasEarlier,
  needsLoad,
  suspended = false,
  onLoadEarlier,
  onReload,
}: TranscriptPagingControlsProps): JSX.Element | null {
  const sentinel = useRef<HTMLDivElement>(null);
  const callback = useRef(onLoadEarlier);
  callback.current = onLoadEarlier;
  const reload = useRef(onReload);
  reload.current = onReload;
  const requested = useRef(false);
  useEffect(() => {
    if (loading || suspended) requested.current = false;
    if (loading || suspended || error) return;
    if (needsLoad) {
      if (!requested.current) {
        requested.current = true;
        reload.current();
      }
      return;
    }
    if (!hasEarlier) return;
    const element = sentinel.current;
    const root = element?.closest('[data-testid="chat-message-list-scroll"]');
    if (!element || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting) || requested.current)
          return;
        requested.current = true;
        callback.current();
      },
      { root, rootMargin: '240px 0px 0px', threshold: 0 },
    );
    observer.observe(element);
    return (): void => observer.disconnect();
  }, [loading, suspended, error, hasEarlier, needsLoad]);
  if (!loading && !error && !hasEarlier && !needsLoad) return null;
  return (
    <div
      ref={sentinel}
      className="flex min-h-2 shrink-0 items-center justify-center gap-2 text-xs fg-secondary"
      data-testid="chat-transcript-paging"
    >
      {(loading || needsLoad) && !error ? (
        <span className="inline-flex items-center gap-2 py-2" role="status">
          <LoadingSpinner
            decorative
            dataTestId="chat-transcript-loading-spinner"
          />
          Loading messages…
        </span>
      ) : error ? (
        // The same 8px room above and below as the loading status.
        <div className="w-full py-2">
          <Notice
            errorSource="transcript-paging-controls"
            intent="destructive"
            liveRegionScope="content"
            actions={
              <NoticeButton
                data-testid="chat-transcript-retry"
                onClick={needsLoad ? onReload : onLoadEarlier}
              >
                {TRY_AGAIN_LABEL}
              </NoticeButton>
            }
          >
            {error}
          </Notice>
        </div>
      ) : null}
    </div>
  );
});
