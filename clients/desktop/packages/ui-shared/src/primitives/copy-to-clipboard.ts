import { useCallback, useEffect, useRef, useState } from 'react';
import { isFocusReturnTarget } from '../lib/focusable';

export const DEFAULT_COPIED_DURATION_MS = 1500;

/**
 * Writes `text` to the clipboard through the browser clipboard API, with a
 * hidden-textarea `execCommand` fallback for environments without one.
 * Resolves to whether the write succeeded.
 *
 * `ownerDocument` is the document of the element the copy was invoked from.
 * Pass it for a copy inside a pulled-out auxiliary window so the write and the
 * fallback use that window's clipboard and document; it defaults to the
 * global `document`.
 */
export async function copyTextToClipboard(
  text: string,
  ownerDocument?: Document,
): Promise<boolean> {
  const view = ownerDocument?.defaultView;
  const clipboard = view
    ? view.navigator.clipboard
    : typeof navigator === 'undefined'
      ? undefined
      : navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the DOM selection fallback below.
    }
  }

  return copyTextWithSelection(
    text,
    ownerDocument ?? (typeof document === 'undefined' ? undefined : document),
  );
}

function copyTextWithSelection(
  text: string,
  doc: Document | undefined,
): boolean {
  if (!doc?.body) {
    return false;
  }

  const textArea = doc.createElement('textarea');
  const previousActiveElement = doc.activeElement;
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  textArea.style.top = '0';

  doc.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  // Native copy can retain an earlier transcript selection. Supply the
  // requested plain-text payload explicitly rather than relying on which
  // selection the browser chooses after menu/preview focus changes.
  const handleCopy = (event: ClipboardEvent): void => {
    if (!event.clipboardData) return;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
  };
  doc.addEventListener('copy', handleCopy, true);

  try {
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    doc.removeEventListener('copy', handleCopy, true);
    textArea.remove();
    // A pulled-out panel can adopt main-window nodes. Their prototypes still
    // belong to the original realm, so neither window's constructor alone
    // identifies every focusable control in this document.
    if (
      isFocusReturnTarget(previousActiveElement) &&
      previousActiveElement.isConnected
    ) {
      previousActiveElement.focus();
    }
  }
}

export interface UseCopyToClipboardOptions {
  /** How long the copied confirmation stays visible. */
  copiedDurationMs?: number;
  /** Fires after a successful copy. */
  onCopy?: () => void;
  /**
   * Host clipboard writer. Defaults to {@link copyTextToClipboard}; hosts with
   * their own clipboard port inject it so every copy goes through one path.
   */
  write?: (text: string, ownerDocument?: Document) => Promise<boolean>;
}

export interface UseCopyToClipboardResult {
  /** True while the copied confirmation should show. */
  copied: boolean;
  /** Copies `text` and, on success, shows the confirmation for the duration. */
  copy: (text: string, ownerDocument?: Document) => Promise<boolean>;
}

/**
 * The copy-to-clipboard behavior behind {@link CopyButton}: the clipboard
 * write and the timed copied confirmation. Use it directly when the control
 * is not a Button, such as a chat bubble's corner badge or the blog's share
 * row, so those keep their own chrome while sharing the behavior.
 */
export function useCopyToClipboard({
  copiedDurationMs = DEFAULT_COPIED_DURATION_MS,
  onCopy,
  write = copyTextToClipboard,
}: UseCopyToClipboardOptions = {}): UseCopyToClipboardResult {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Counts copies so a slow write that a newer copy overtook, or one that
  // settles after unmount, never restarts the confirmation.
  const operationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect((): (() => void) => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  const copy = useCallback(
    async (text: string, ownerDocument?: Document): Promise<boolean> => {
      const operation = ++operationRef.current;
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setCopied(false);
      const success =
        ownerDocument === undefined
          ? await write(text)
          : await write(text, ownerDocument);
      if (!success) return false;
      if (!mountedRef.current || operation !== operationRef.current) {
        return true;
      }
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
      setCopied(true);
      timeoutRef.current = setTimeout((): void => {
        setCopied(false);
        timeoutRef.current = null;
      }, copiedDurationMs);
      onCopy?.();
      return true;
    },
    [copiedDurationMs, onCopy, write],
  );

  return { copied, copy };
}
