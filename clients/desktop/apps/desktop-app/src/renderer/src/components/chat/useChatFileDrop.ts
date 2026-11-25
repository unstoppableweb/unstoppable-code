import { useEffect, useRef, useState, type RefObject } from 'react';
import { CHAT_DROP_ZONE_ATTRIBUTE } from './ChatDropOverlay';

export interface UseChatFileDropOptions {
  /** The composer box. */
  readonly boxRef: RefObject<HTMLElement | null>;
  /** The composer's root, used to find the chat area it belongs to. */
  readonly rootRef: RefObject<HTMLElement | null>;
  /** Off for a read-only composer. */
  readonly enabled: boolean;
  /**
   * The queued-message editor: it sits inside the chat area and keeps drops
   * on its own box for the message it edits. It takes them in the capture
   * phase and stops them, so the chat's composer never attaches them too
   * (the chat still ends its own drag on them).
   */
  readonly ownBoxOnly: boolean;
  /** Receives the dropped files. */
  readonly onDropFiles: (files: File[]) => void;
}

export interface ChatFileDropState {
  /** Files are being dragged over the area. */
  readonly dragging: boolean;
  /**
   * The chat area to dim while dragging: the nearest element marked with
   * `data-chat-drop-zone`, or the composer itself when the host marks none.
   * `null` until the first drag, and for `ownBoxOnly`, which draws nothing
   * of its own.
   */
  readonly zone: HTMLElement | null;
}

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false;
}

/**
 * Takes files dropped anywhere on a chat (transcript and composer together)
 * for its composer. Only file drags are handled: a tab or text dragged across
 * the chat keeps its own drop.
 */
export function useChatFileDrop({
  boxRef,
  rootRef,
  enabled,
  ownBoxOnly,
  onDropFiles,
}: UseChatFileDropOptions): ChatFileDropState {
  const [dragging, setDragging] = useState(false);
  const [zone, setZone] = useState<HTMLElement | null>(null);
  const onDropFilesRef = useRef(onDropFiles);
  onDropFilesRef.current = onDropFiles;

  useEffect(() => {
    if (!enabled) return undefined;
    const root = rootRef.current;
    const el = ownBoxOnly
      ? boxRef.current
      : (root?.closest<HTMLElement>(`[${CHAT_DROP_ZONE_ATTRIBUTE}]`) ?? root);
    if (!el) return undefined;
    // The zone is set as a drag starts rather than here, so mounting the
    // composer does not render it again.
    const capture = ownBoxOnly;
    // Enter and leave fire for every child the pointer crosses.
    let depth = 0;

    const onDragEnter = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth += 1;
      if (depth === 1) {
        if (!ownBoxOnly) setZone(el);
        setDragging(true);
      }
    };
    const onDragLeave = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };
    const onDragOver = (event: DragEvent): void => {
      if (!carriesFiles(event) || !event.dataTransfer) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) onDropFilesRef.current(files);
    };
    // No dragleave follows a drop, and a drop the queued-message editor takes
    // stops before it bubbles back up to the area. So the area also ends its
    // drag on the way down, before any child can stop the drop.
    const onDropEndsDrag = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      depth = 0;
      setDragging(false);
    };

    el.addEventListener('dragenter', onDragEnter);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop, capture);
    if (!ownBoxOnly) el.addEventListener('drop', onDropEndsDrag, true);
    return (): void => {
      el.removeEventListener('dragenter', onDragEnter);
      el.removeEventListener('dragleave', onDragLeave);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('drop', onDrop, capture);
      el.removeEventListener('drop', onDropEndsDrag, true);
      setDragging(false);
      setZone(null);
    };
  }, [boxRef, rootRef, enabled, ownBoxOnly]);

  return { dragging, zone };
}
