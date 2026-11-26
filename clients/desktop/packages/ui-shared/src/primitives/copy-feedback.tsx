import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  DEFAULT_COPIED_DURATION_MS,
  useCopyToClipboard,
  type UseCopyToClipboardOptions,
} from './copy-to-clipboard';

/** The announcement after a successful copy. */
export const COPIED_ANNOUNCEMENT = 'Copied';

export interface UseAnnouncedCopyOptions extends UseCopyToClipboardOptions {
  /**
   * Announced when the clipboard write fails or rejects. Without one, a
   * failure stays silent, as it did before announcements (CAN-5354).
   */
  failureAnnouncement?: string;
}

export interface UseAnnouncedCopyResult {
  /** True while the copied confirmation should show. */
  copied: boolean;
  /** True while the failure feedback should show. */
  failed: boolean;
  /** The live region's current text; empty between announcements. */
  announcement: string;
  /** Copies `text`. Never rejects: a rejected write counts as a failure. */
  copy: (text: string, ownerDocument?: Document) => Promise<boolean>;
}

/**
 * {@link useCopyToClipboard} plus the text of a polite live region that says
 * `Copied` after every successful copy, repeat copies included, and the
 * caller's failure message when the write fails (CAN-4704, CAN-5354).
 *
 * The region is emptied and refilled in separate updates: changing invisible
 * whitespace is not an announcement, so a repeat copy would otherwise stay
 * silent. Pending timers clear on unmount.
 */
export function useAnnouncedCopy({
  failureAnnouncement,
  copiedDurationMs = DEFAULT_COPIED_DURATION_MS,
  onCopy,
  write,
}: UseAnnouncedCopyOptions = {}): UseAnnouncedCopyResult {
  const [successCount, setSuccessCount] = useState(0);
  const [failureCount, setFailureCount] = useState(0);
  const [failed, setFailed] = useState(false);
  const [announced, setAnnounced] = useState(false);
  const operationRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
      operationRef.current += 1;
    };
  }, []);
  const handleCopied = useCallback((): void => {
    setSuccessCount((previous) => previous + 1);
    onCopy?.();
  }, [onCopy]);
  const { copied, copy: writeCopy } = useCopyToClipboard({
    copiedDurationMs,
    onCopy: handleCopied,
    ...(write !== undefined ? { write } : {}),
  });

  useEffect((): (() => void) | undefined => {
    setAnnounced(false);
    if (!copied && !failed) return undefined;
    const timer = setTimeout((): void => setAnnounced(true), 100);
    return (): void => clearTimeout(timer);
  }, [copied, failed, successCount, failureCount]);

  useEffect((): (() => void) | undefined => {
    if (!failed) return undefined;
    const timer = setTimeout((): void => setFailed(false), copiedDurationMs);
    return (): void => clearTimeout(timer);
  }, [failed, failureCount, copiedDurationMs]);

  const copy = useCallback(
    async (text: string, ownerDocument?: Document): Promise<boolean> => {
      const operation = ++operationRef.current;
      setFailed(false);
      let success: boolean;
      try {
        success = await writeCopy(text, ownerDocument);
      } catch {
        success = false;
      }
      if (
        !success &&
        mountedRef.current &&
        failureAnnouncement !== undefined &&
        operation === operationRef.current
      ) {
        setFailed(true);
        setFailureCount((previous) => previous + 1);
      }
      return success;
    },
    [failureAnnouncement, writeCopy],
  );

  const announcement = !announced
    ? ''
    : copied
      ? COPIED_ANNOUNCEMENT
      : failed
        ? (failureAnnouncement ?? '')
        : '';
  return { copied, failed, announcement, copy };
}

/**
 * The visually hidden polite status beside a copy control. Its parent must be
 * positioned: an unpositioned `sr-only` span escapes a scroller and grows the
 * nearest positioned ancestor instead.
 */
export function CopyStatusRegion({
  announcement,
  dataTestId,
}: {
  readonly announcement: string;
  readonly dataTestId?: string;
}): JSX.Element {
  return (
    <span role="status" className="sr-only" data-testid={dataTestId}>
      {announcement}
    </span>
  );
}
