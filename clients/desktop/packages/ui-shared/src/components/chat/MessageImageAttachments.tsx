import {
  Children,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { PlayIcon } from '../../icons/AppIcons';
import { FileTypeIcon } from '../../icons/FileTypeIcon';
import { BUTTON_PRESS_CLASS } from '../Button';
import { Tooltip } from '../Tooltip';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

export interface MessageImageAttachment {
  /** Stable React key (e.g. the attachment's path or id). */
  readonly key: string;
  /**
   * Image URL (a video's first frame); `null` while it loads or when it
   * cannot be shown. A video without a frame keeps its tile and play mark.
   */
  readonly src: string | null;
  /** A video draws a play mark over its frame. Defaults to `image`. */
  readonly kind?: 'image' | 'video';
  /** The file name: the picture's alt text and the tile's description. */
  readonly alt: string;
  /** Opens the full image. Without it the thumbnail is not interactive. */
  readonly onOpen?: () => void;
  /** The picture failed to load; the host may show the file another way. */
  readonly onError?: () => void;
  /** What `onOpen` does, for the tile's accessible name. Defaults to `Open`. */
  readonly actionLabel?: 'Open' | 'Download';
}

/** A file with no picture to show, as a tile in the same row. */
export interface MessageFileAttachment {
  /** Stable React key (e.g. the attachment's path or id). */
  readonly key: string;
  /** The file's name; it labels the tile and picks its type icon. */
  readonly name: string;
  /** Opens the file. Without it the tile is not interactive. */
  readonly onOpen?: () => void;
  /** What `onOpen` does, for the tile's accessible name. Defaults to `Open`. */
  readonly actionLabel?: 'Open' | 'Download';
  /**
   * The host's own preview while the pointer rests on the tile (desktop's
   * file preview). Without it the tile's tooltip names the file.
   */
  readonly onHoverStart?: (anchor: HTMLElement) => void;
  readonly onHoverEnd?: () => void;
}

export interface MessageImageAttachmentsProps {
  readonly images: readonly MessageImageAttachment[];
}

/**
 * The edge every attachment tile draws: 1px of the primary ink (black in
 * light, white in dark) at 16%, so a dark or pale tile still ends on a line.
 * One strength for every tile in a row, so a file beside an image does not
 * read as fainter. A file, a video or a code selection draws it on the tile
 * itself: its content is text and an icon, which leave the edge bare.
 */
export const ATTACHMENT_TILE_EDGE_CLASS = 'inset-ring inset-ring-fg-primary/16';

/**
 * A picture draws that edge on a layer over itself: an inset ring on the
 * tile would sit under the picture. This is the composer's 120px tile, with
 * its 8px corner.
 */
export const IMAGE_THUMBNAIL_EDGE_CLASS = `pointer-events-none absolute inset-0 rounded-lg ${ATTACHMENT_TILE_EDGE_CLASS}`;

/** The same layer for a sent message's 64px thumbnail and its 6px corner. */
const IMAGE_EDGE_CLASS = `pointer-events-none absolute inset-0 rounded-md ${ATTACHMENT_TILE_EDGE_CLASS}`;

/**
 * A 64px square, with the corner of the bubble's 12px radius 6px in, so the
 * picture's corner follows the bubble's.
 */
const TILE_CLASS =
  'relative size-16 shrink-0 overflow-hidden rounded-md bg-secondary';

/**
 * The play mark over a video's tile: the tooltip's inverse pair, which keeps
 * its contrast over any frame, in both color modes.
 */
const PLAY_MARK_CLASS =
  'pointer-events-none absolute inset-0 m-auto flex size-6 items-center justify-center rounded-full bg-tooltip-inverse fg-tooltip-inverse';

/** Up to this many tiles show; past it, one fewer and a "+N" tile. */
const MESSAGE_MEDIA_CAP = 8;

/**
 * The row of a message's attachments inside its bubble: images, videos and
 * files as 64px tiles, in attach order. The bubble pads 12px across and 6px
 * down; the row reaches 6px into the side padding, so the tiles sit 6px from
 * the bubble's top and sides, and 6px above the text. With no text under it
 * (`alone`) the bubble's own 6px is the bottom inset. Up to eight tiles
 * show; past eight, the row shows seven and a "+N" tile that opens the rest.
 */
export function MessageMediaRow({
  children,
  alone = false,
}: {
  readonly children: ReactNode;
  /** Nothing follows the row in the bubble (a message with no text). */
  readonly alone?: boolean;
}): JSX.Element {
  const tiles = Children.toArray(children);
  const row = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const cut = !expanded && tiles.length > MESSAGE_MEDIA_CAP;
  const shown = cut ? tiles.slice(0, MESSAGE_MEDIA_CAP - 1) : tiles;
  const hidden = tiles.length - shown.length;
  const expand = (): void => {
    // The "+N" tile goes; keep focus on the first tile it revealed, where
    // the pointer and the keyboard both were. Focus is read from the row's
    // own document: a popped-out chat renders into another window's.
    const node = row.current;
    const focused = node?.contains(node.ownerDocument.activeElement) ?? false;
    flushSync(() => setExpanded(true));
    if (!focused) return;
    // Tiles only: a host may put other rows in the row (a download error).
    const first = row.current
      ?.querySelectorAll('[data-message-tile]')
      .item(MESSAGE_MEDIA_CAP - 1);
    // `closest` keeps the element's own window's type, unlike `instanceof`.
    first?.closest('button')?.focus();
  };
  return (
    <div
      ref={row}
      className={`-mx-1.5 flex flex-wrap gap-1.5${alone ? '' : ' mb-1.5'}`}
      data-testid="message-image-attachments"
    >
      {shown}
      {cut && (
        <MessageTile
          onPress={expand}
          label={`Show ${String(hidden)} more attachments`}
          testId="message-attachments-more"
          className={`${TILE_CLASS} flex items-center justify-center text-xs fg-secondary hover:fg-primary`}
        >
          +{hidden}
          <span aria-hidden className={IMAGE_EDGE_CLASS} />
        </MessageTile>
      )}
    </div>
  );
}

/** A pressable tile: the house press, no hover fill. */
const TILE_PRESS_CLASS = `transition-[scale] ${BUTTON_PRESS_CLASS}`;

/**
 * The one element every tile in the row is: a 64px tile that opens what it
 * shows (a tile, not a button: chat-blocks.md#actions), or the same box as
 * a named picture when nothing can open it.
 */
function MessageTile({
  onPress,
  label,
  testId,
  kind,
  className,
  hover,
  children,
  'aria-describedby': describedBy,
}: {
  readonly onPress: (() => void) | undefined;
  readonly label: string;
  readonly testId: string;
  readonly kind?: string;
  readonly className: string;
  readonly hover?: {
    readonly onPointerEnter: (event: { currentTarget: HTMLElement }) => void;
    readonly onPointerLeave: () => void;
  };
  readonly children: ReactNode;
  /** A wrapping `Tooltip` describes the tile through this. */
  readonly 'aria-describedby'?: string;
}): JSX.Element {
  return onPress ? (
    <button
      type="button"
      onClick={onPress}
      aria-label={label}
      aria-describedby={describedBy}
      data-testid={testId}
      data-kind={kind}
      data-message-tile=""
      className={`focus-ring ${TILE_PRESS_CLASS} ${className}`}
      {...hover}
    >
      {children}
    </button>
  ) : (
    <span
      role="img"
      aria-label={label}
      aria-describedby={describedBy}
      data-testid={testId}
      data-kind={kind}
      data-message-tile=""
      className={className}
      {...hover}
    >
      {children}
    </span>
  );
}

/** A zero-width space after each place a file name may break. */
function withSeams(name: string): string {
  const dot = name.lastIndexOf('.');
  const marked =
    dot > 0 ? `${name.slice(0, dot)}\u200B${name.slice(dot)}` : name;
  return marked.replace(/([-_])/g, '$1\u200B');
}

/**
 * A file tile's name: one or two lines, broken after `-` or `_` or before
 * the extension; else broken anywhere; else cut in the middle so the
 * extension stays. Measured on a hidden copy at the tile's width, once the
 * fonts are in, so the shown text never jumps through the attempts.
 */
function MessageFileTileName({ name }: { readonly name: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [fit, setFit] = useState({ text: withSeams(name), anywhere: false });
  useLayoutEffect(() => {
    let live = true;
    // The tile's own document and window: a popped-out chat renders into
    // another window's, with its own fonts.
    const owner = ref.current?.ownerDocument;
    const view = owner?.defaultView;
    if (owner === undefined || view === null || view === undefined) return;
    const measure = (): void => {
      const element = ref.current;
      if (!live || element === null || element.clientWidth === 0) return;
      const probe = owner.createElement('span');
      probe.className = element.className
        .replace(/\bbreak-(all|words)\b/g, '')
        .trim();
      probe.style.cssText = `position:absolute;visibility:hidden;width:${String(element.clientWidth)}px;overflow-wrap:break-word`;
      element.parentElement?.appendChild(probe);
      const lineHeight = parseFloat(view.getComputedStyle(element).lineHeight);
      const fits = (text: string): boolean => {
        probe.textContent = withSeams(text);
        return probe.getBoundingClientRect().height <= lineHeight * 2 + 0.5;
      };
      const dot = name.lastIndexOf('.');
      const end = dot > 0 ? name.slice(dot + 1) : name.slice(-4);
      const stem = dot > 0 ? name.slice(0, dot) : name.slice(0, -4);
      // The ellipsis holds on to the end (a word joiner), so the cut never
      // leaves the extension alone on a third line.
      const cut = (head: number): string =>
        `${stem.slice(0, head)}\u2026\u2060${end}`;
      let text = name;
      let anywhere = false;
      if (!fits(name)) {
        probe.style.wordBreak = 'break-all';
        if (fits(name)) {
          anywhere = true;
        } else {
          probe.style.wordBreak = '';
          let head = stem.length;
          while (head > 1 && !fits(cut(head))) head -= 1;
          text = cut(head);
        }
      }
      probe.remove();
      setFit({ text: withSeams(text), anywhere });
    };
    measure();
    void owner.fonts.ready.then(measure);
    return (): void => {
      live = false;
    };
  }, [name]);
  return (
    <span
      ref={ref}
      className={`block w-full text-3xs fg-secondary ${fit.anywhere ? 'break-all' : 'break-words'}`}
    >
      {fit.text}
    </span>
  );
}

/**
 * A file sent with a message, as a tile in the media row: its type icon in
 * the top-left corner and its name anchored to the bottom left, both on the
 * tile's 6px inset, so a one- or two-line name never moves the icon. Opens
 * the file when the host can.
 */
export function MessageFileTile({
  file,
}: {
  readonly file: MessageFileAttachment;
}): JSX.Element {
  // Session replay records attributes, so the file name lives only in
  // blocked text and the tile names it through aria-describedby.
  const nameId = useId();
  const content = (
    <>
      <FileTypeIcon filename={file.name} size="md" />
      <span aria-hidden className={`${REPLAY_BLOCK_CLASS} block w-full`}>
        <MessageFileTileName name={file.name} />
      </span>
      <span id={nameId} className={`${REPLAY_BLOCK_CLASS} sr-only`}>
        {file.name}
      </span>
      <span aria-hidden className={IMAGE_EDGE_CLASS} />
    </>
  );
  const tile = (
    <MessageTile
      onPress={file.onOpen}
      label={file.onOpen ? `${file.actionLabel ?? 'Open'} file` : 'File'}
      aria-describedby={nameId}
      testId="message-file-attachment"
      className={`${TILE_CLASS} flex flex-col justify-between p-1.5 text-left`}
      {...(file.onHoverStart === undefined
        ? {}
        : {
            hover: {
              onPointerEnter: (event): void =>
                file.onHoverStart?.(event.currentTarget),
              onPointerLeave: (): void => file.onHoverEnd?.(),
            },
          })}
    >
      {content}
    </MessageTile>
  );
  // A host preview names the file itself; otherwise the tooltip does.
  return file.onHoverStart ? (
    tile
  ) : (
    <Tooltip
      label={file.name}
      contentClassName="max-w-96 break-all"
      replayBlock
    >
      {tile}
    </Tooltip>
  );
}

/**
 * One sent image or video: a 64px square of the picture itself, a video as
 * its first frame with a play mark. Opens the file when the host can.
 */
export function MessageMediaTile({
  image,
}: {
  readonly image: MessageImageAttachment;
}): JSX.Element {
  // Session replay records attributes, so the file name lives only in
  // blocked text and the tile names it through aria-describedby.
  const nameId = useId();
  const picture = (
    <>
      {image.src !== null ? (
        <img
          src={image.src}
          alt={image.alt}
          draggable={false}
          // A transcript can hold many full-size pictures; load each as it
          // nears the view. The tile's fixed size keeps the layout still.
          loading="lazy"
          decoding="async"
          onError={image.onError}
          className={`${REPLAY_BLOCK_CLASS} h-full w-full object-cover`}
        />
      ) : null}
      {image.kind === 'video' ? (
        <span aria-hidden className={PLAY_MARK_CLASS}>
          <PlayIcon size="xs" />
        </span>
      ) : null}
      <span aria-hidden className={IMAGE_EDGE_CLASS} />
      <span id={nameId} className={`${REPLAY_BLOCK_CLASS} sr-only`}>
        {image.alt}
      </span>
    </>
  );
  const noun = image.kind === 'video' ? 'video' : 'image';
  const tile = (
    <MessageTile
      onPress={image.onOpen}
      label={
        image.onOpen
          ? `${image.actionLabel ?? 'Open'} ${noun}`
          : image.kind === 'video'
            ? 'Video'
            : 'Image'
      }
      aria-describedby={nameId}
      testId="message-image-attachment"
      kind={image.kind ?? 'image'}
      className={`${TILE_CLASS} block`}
    >
      {picture}
    </MessageTile>
  );
  return (
    <Tooltip
      label={image.alt}
      contentClassName="max-w-96 break-all"
      replayBlock
    >
      {tile}
    </Tooltip>
  );
}

/**
 * The images and videos sent with a chat message, shown as the pictures
 * themselves inside its bubble, in attach order. Pure display; hosts resolve
 * each image's URL. A host that resolves each picture on its own composes
 * `MessageMediaRow` and `MessageMediaTile` instead.
 */
export function MessageImageAttachments({
  images,
}: MessageImageAttachmentsProps): JSX.Element | null {
  if (images.length === 0) return null;
  return (
    <MessageMediaRow>
      {images.map((image) => (
        <MessageMediaTile key={image.key} image={image} />
      ))}
    </MessageMediaRow>
  );
}
