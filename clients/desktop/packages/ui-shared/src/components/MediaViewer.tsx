import {
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
} from 'react';
import {
  ChevronLeftMediumIcon,
  ChevronRightMediumIcon,
  CloseIcon,
  ExternalIcon,
} from '../icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { Button } from '../primitives/Button';
import { CometSpinner } from '../primitives/CometSpinner';
import { WindowPage } from '../primitives/DialogModal';
import {
  MediaThumbnail,
  type MediaThumbnailKind,
} from './chat/MessageImageAttachments';
import { Tooltip } from '../primitives/Tooltip';

export interface MediaViewerItem {
  /** Stable identity (the file's path or id). */
  readonly key: string;
  /** The file's name, shown above the media and read out. */
  readonly name: string;
  readonly kind: MediaThumbnailKind;
  /**
   * What the stage plays or shows: the image, or a playable video URL.
   * `undefined` while it loads, `null` when it cannot be shown here.
   */
  readonly src: string | null | undefined;
  /** The strip's picture: the image, or a video's first frame. */
  readonly thumbnail?: string | null;
}

export interface MediaViewerProps {
  readonly items: readonly MediaViewerItem[];
  /** The item on the stage. */
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
  /**
   * Opens the item in the system's app: offered in the header, and on the
   * stage when the item cannot be shown here. A rejection is told in the
   * header, beside the action.
   */
  readonly onOpenExternal?: (item: MediaViewerItem) => void | Promise<void>;
  /**
   * The document of the control that opened the viewer, when that is another
   * window's (a pulled-out panel). The viewer shows over that window and
   * hears its keys there. Defaults to this window's.
   */
  readonly ownerDocument?: Document;
  readonly testId?: string;
}

/**
 * Images and videos, one at a time, over the whole window on a black ground
 * (`media-scope`): the item's name and its place in the set above it, the
 * previous and next arrows beside it, and the set's thumbnails below, the
 * current one ringed. Arrow keys move through the set; Escape, the close
 * button or a click anywhere outside the media and the controls closes it.
 * A video plays with the browser's own controls and starts on its own.
 * Pure display: hosts resolve each item's picture and playable URL, lazily
 * for the item on the stage.
 */
export function MediaViewer({
  items,
  index,
  onIndexChange,
  onClose,
  onOpenExternal,
  ownerDocument,
  testId,
}: MediaViewerProps): JSX.Element | null {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const openExternalRef = useRef<HTMLButtonElement | null>(null);
  const groundRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  // Session replay records attributes, so the viewer is named by its
  // replay-blocked name and its place in the set, never by an `aria-label`.
  const nameId = useId();
  const positionId = useId();
  // The item whose external open failed; stepping to another clears it.
  const [openFailedKey, setOpenFailedKey] = useState<string | null>(null);
  // Only the latest open's failure is told: an earlier one that fails later
  // would replace the status of the file just tried.
  const openAttemptRef = useRef(0);
  const count = items.length;
  const current = items[Math.min(Math.max(index, 0), count - 1)];
  const hasPrevious = index > 0;
  const hasNext = index < count - 1;

  // Keep the current thumbnail in view as the set is stepped through.
  useEffect(() => {
    const strip = stripRef.current;
    const thumb = strip?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!strip || !thumb) return;
    const left = thumb.offsetLeft - strip.offsetLeft;
    const right = left + thumb.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = left - 8;
    else if (right > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = right - strip.clientWidth + 8;
    }
  }, [index]);

  // The arrow keys step through the set wherever focus sits, so they are
  // heard on the document, as Escape is. A click on the picture, or an arrow
  // button that disables at an end of the set, leaves focus on the page
  // body, where a handler on the viewer's own elements never hears a key.
  useEffect(() => {
    const keyDocument = ownerDocument ?? document;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      // Only keys meant for the viewer: from inside it, or from the page
      // body that focus falls back to. An overlay opened over the viewer (the
      // command palette's search field) keeps its arrows for its caret.
      const target = event.target;
      const ground = groundRef.current;
      if (
        target !== null &&
        target !== keyDocument.body &&
        isNode(target) &&
        ground !== null &&
        !ground.contains(target)
      ) {
        return;
      }
      // A focused video seeks with the arrows itself. Told by its name, not
      // by `instanceof`: another window's elements are not this window's.
      if (
        target !== null &&
        'nodeName' in target &&
        target.nodeName === 'VIDEO'
      ) {
        return;
      }
      const delta =
        event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      const next = index + delta;
      if (next >= 0 && next < count) onIndexChange(next);
    };
    keyDocument.addEventListener('keydown', handleKeyDown);
    return (): void => {
      keyDocument.removeEventListener('keydown', handleKeyDown);
    };
  }, [count, index, onIndexChange, ownerDocument]);

  if (current === undefined) return null;

  const openExternal = onOpenExternal
    ? (): void => {
        const item = current;
        openAttemptRef.current += 1;
        const attempt = openAttemptRef.current;
        setOpenFailedKey(null);
        void Promise.resolve(onOpenExternal(item)).catch((): void => {
          if (attempt === openAttemptRef.current) setOpenFailedKey(item.key);
        });
      }
    : undefined;

  const step = (delta: number): void => {
    const next = index + delta;
    if (next >= 0 && next < count) onIndexChange(next);
  };

  // Only a click on the ground itself closes: the media, the arrows, the
  // header and the strip's thumbnails keep theirs.
  const closeOnGround = (event: MouseEvent<HTMLElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <WindowPage
      onClose={onClose}
      aria-labelledby={count > 1 ? `${nameId} ${positionId}` : nameId}
      dataTestId={testId}
      initialFocusRef={closeRef}
      {...(ownerDocument ? { ownerDocument } : {})}
    >
      <div
        ref={groundRef}
        className="media-scope flex size-full flex-col"
        onClick={closeOnGround}
        data-testid={testId === undefined ? undefined : `${testId}-ground`}
      >
        {/* The header sits where the desktop window's title bar takes drags:
            out of the drag region, so its buttons take their clicks. */}
        <div
          className="electron-no-drag flex h-12 shrink-0 items-center gap-3 pl-4 pr-2"
          onClick={closeOnGround}
        >
          <span
            id={nameId}
            className={`min-w-0 truncate text-s fg-primary ${REPLAY_BLOCK_CLASS}`}
          >
            {current.name}
          </span>
          {count > 1 ? (
            <span
              id={positionId}
              className="shrink-0 text-s tabular-nums fg-tertiary"
            >
              {index + 1} of {count}
            </span>
          ) : null}
          <span className="flex-1 self-stretch" onClick={closeOnGround} />
          {/* Beside the action it reports; read out when it appears. */}
          <span role="status" className="shrink-0 text-s fg-secondary">
            {openFailedKey === current.key
              ? "Couldn't open this file in its default app."
              : null}
          </span>
          {openExternal ? (
            <Tooltip label="Open in default app">
              <Button
                ref={openExternalRef}
                variant="ghost"
                iconOnly
                aria-label="Open in default app"
                onClick={openExternal}
              >
                <ExternalIcon size="sm" />
              </Button>
            </Tooltip>
          ) : null}
          {/* No tooltip: the viewer opens with focus here, and a tooltip that
              keyboard focus opens takes the first Escape for itself, so a
              viewer opened by keyboard needed two presses to close. */}
          <Button
            ref={closeRef}
            variant="ghost"
            iconOnly
            aria-label="Close"
            onClick={onClose}
            data-testid={testId === undefined ? undefined : `${testId}-close`}
          >
            <CloseIcon size="sm" />
          </Button>
        </div>
        <div
          className="relative flex min-h-0 flex-1 items-center justify-center px-16 py-2"
          onClick={closeOnGround}
        >
          <MediaStage
            item={current}
            {...(openExternal ? { onOpenExternal: openExternal } : {})}
            {...(count > 1
              ? {}
              : {
                  onFocusPastVideo: (): void =>
                    (openExternalRef.current ?? closeRef.current)?.focus(),
                  ...(testId === undefined
                    ? {}
                    : { focusEndTestId: `${testId}-focus-end` }),
                })}
          />
          {count > 1 ? (
            <>
              <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center *:pointer-events-auto">
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label="Previous"
                  disabled={!hasPrevious}
                  onClick={(): void => step(-1)}
                  data-testid={
                    testId === undefined ? undefined : `${testId}-previous`
                  }
                >
                  <ChevronLeftMediumIcon size="xl" />
                </Button>
              </div>
              <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center *:pointer-events-auto">
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label="Next"
                  disabled={!hasNext}
                  onClick={(): void => step(1)}
                  data-testid={
                    testId === undefined ? undefined : `${testId}-next`
                  }
                >
                  <ChevronRightMediumIcon size="xl" />
                </Button>
              </div>
            </>
          ) : null}
        </div>
        {count > 1 ? (
          <div className="flex shrink-0 justify-center px-4 pb-4 pt-2">
            <div
              ref={stripRef}
              role="group"
              aria-label="Media"
              className="flex max-w-full gap-2 overflow-x-auto p-1 scrollbar-hide"
            >
              {items.map((item, itemIndex) => (
                <MediaThumbnail
                  key={item.key}
                  src={item.thumbnail ?? null}
                  kind={item.kind}
                  name={item.name}
                  current={itemIndex === index}
                  label={item.kind === 'video' ? 'Show video' : 'Show image'}
                  onSelect={(): void => onIndexChange(itemIndex)}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="h-4 shrink-0" onClick={closeOnGround} />
        )}
      </div>
    </WindowPage>
  );
}

/** A DOM node, told by shape: another window's nodes fail `instanceof`. */
function isNode(target: EventTarget): target is Node {
  return 'nodeType' in target;
}

/**
 * The picture or video fills at most 70% of the viewer each way, so the dark
 * ground frames it, and never more than the stage between the header and
 * the strip.
 */
const MEDIA_SIZE_CLASS = 'max-h-[min(100%,70vh)] max-w-[min(100%,70vw)]';

function MediaStage({
  item,
  onOpenExternal,
  onFocusPastVideo,
  focusEndTestId,
}: {
  readonly item: MediaViewerItem;
  readonly onOpenExternal?: () => void;
  /** A lone video: Tab past its controls goes here (see the stop below). */
  readonly onFocusPastVideo?: () => void;
  readonly focusEndTestId?: string;
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // A file that reads but cannot be decoded (a corrupt picture, a codec the
  // browser lacks) fails on the element, not in the host. The failure is kept
  // by source, so the next item, or a new read of this one, starts clean.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (item.src === undefined) {
    return (
      <span className="fg-secondary">
        <CometSpinner sizePx={20} ariaLabel="Loading" />
      </span>
    );
  }
  const src = item.src;
  if (src === null || src === failedSrc) {
    return (
      <div className="flex flex-col items-center gap-3 text-s fg-secondary">
        <span>This {item.kind} can't be shown here.</span>
        {onOpenExternal ? (
          <Button variant="secondary" onClick={onOpenExternal}>
            Open in default app
          </Button>
        ) : null}
      </div>
    );
  }
  return item.kind === 'video' ? (
    <>
      <video
        ref={videoRef}
        key={item.key}
        src={src}
        onError={(): void => setFailedSrc(src)}
        controls
        autoPlay
        playsInline
        aria-label={item.name}
        className={`${MEDIA_SIZE_CLASS} rounded-md ${REPLAY_BLOCK_CLASS}`}
      />
      {onFocusPastVideo ? (
        // A lone video is the focus trap's last stop, and focus on any of its
        // native controls reads as focus on the element, so Tab from the play
        // button would wrap before the seek bar or volume. This stop after it
        // lets Tab leave the controls first: arriving from the video it goes
        // on to the header's first control (Open in default app, else Close);
        // arriving the other way (Shift+Tab wrapping from there) it goes back
        // into the video. It renders only with the video, so a video that
        // fails to decode leaves no stop with nothing to send focus to.
        <span
          tabIndex={0}
          data-testid={focusEndTestId}
          onFocus={(event): void => {
            const video = videoRef.current;
            if (event.relatedTarget === video) {
              onFocusPastVideo();
            } else {
              video?.focus();
            }
          }}
        />
      ) : null}
    </>
  ) : (
    <img
      key={item.key}
      src={src}
      onError={(): void => setFailedSrc(src)}
      alt={item.name}
      draggable={false}
      className={`${MEDIA_SIZE_CLASS} rounded-md object-contain ${REPLAY_BLOCK_CLASS}`}
    />
  );
}
