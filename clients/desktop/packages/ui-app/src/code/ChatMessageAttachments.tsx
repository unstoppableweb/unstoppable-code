'use client';

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { isCloudImageAttachmentMediaType } from '@canopy/protocol/cloud-attachments';
import type { PortalChatMessageAttachment } from '@canopy/protocol/portal';
import {
  ErrorBanner,
  MessageFileTile,
  MessageMediaRow,
  MessageMediaTile,
  type MessageImageAttachment,
} from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { VIDEO_FILENAME } from '@canopy/ui-shared/lib';

/**
 * Host-owned behavior for the files a user attached to a message. ui-app stays
 * transport-neutral: the host decides how Open / Download / thumbnails resolve
 * (the web portal routes them through its cloud attachment endpoints).
 */
export interface ChatMessageAttachmentInteraction {
  readonly downloadContext?: object;
  readonly onOpen?: (attachment: PortalChatMessageAttachment) => void;
  readonly onDownload: (
    attachment: PortalChatMessageAttachment,
    signal?: AbortSignal,
  ) => Promise<void>;
  /** Host-renderable URL for an image attachment, or null for no thumbnail. */
  readonly imageSrc: (attachment: PortalChatMessageAttachment) => string | null;
  readonly resolveImage?: (
    reference: ChatAssetImageReference,
    signal: AbortSignal,
  ) => Promise<ChatAssetImageSource | null>;
  readonly onOpenImage?: (reference: ChatAssetImageReference) => void;
}

export interface ChatAssetImageReference {
  readonly assetId: string;
  readonly mediaType?: string;
  readonly filename?: string;
}

export interface ChatAssetImageSource {
  readonly src: string;
  readonly dispose?: () => void;
}

export function useChatAssetImage(reference: ChatAssetImageReference | null): {
  readonly src: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly retry: () => void;
} {
  const interaction = useChatMessageAttachmentInteraction();
  const resolve = interaction?.resolveImage;
  const assetId = reference?.assetId;
  const mediaType = reference?.mediaType;
  const filename = reference?.filename;
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<{
    resolver: typeof resolve;
    assetId: string;
    mediaType: string | undefined;
    filename: string | undefined;
    generation: number;
    src: string | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!resolve || !assetId) return;
    const controller = new AbortController();
    let image: ChatAssetImageSource | null = null;
    void resolve(
      {
        assetId,
        ...(mediaType ? { mediaType } : {}),
        ...(filename ? { filename } : {}),
      },
      controller.signal,
    ).then(
      (result) => {
        if (controller.signal.aborted) {
          result?.dispose?.();
          return;
        }
        image = result;
        setState({
          resolver: resolve,
          assetId,
          mediaType,
          filename,
          generation,
          src: result?.src ?? null,
          error: null,
        });
      },
      (reason: unknown) => {
        if (!controller.signal.aborted)
          setState({
            resolver: resolve,
            assetId,
            mediaType,
            filename,
            generation,
            src: null,
            error:
              reason instanceof Error
                ? reason.message
                : 'Image is unavailable.',
          });
      },
    );
    return (): void => {
      controller.abort();
      image?.dispose?.();
    };
  }, [resolve, assetId, mediaType, filename, generation]);
  const visible =
    state?.resolver === resolve &&
    state?.assetId === assetId &&
    state?.mediaType === mediaType &&
    state?.filename === filename &&
    state?.generation === generation
      ? state
      : null;
  return {
    src: visible?.src ?? null,
    loading: Boolean(resolve && assetId && !visible),
    error: visible?.error ?? null,
    retry: () => setGeneration((value) => value + 1),
  };
}

export function ChatAssetImage({
  reference,
}: {
  readonly reference: ChatAssetImageReference;
}): JSX.Element {
  const image = useChatAssetImage(reference);
  const interaction = useChatMessageAttachmentInteraction();
  return (
    <div className="mt-1" data-testid="chat-asset-image">
      {image.src && (
        <button
          type="button"
          className="focus-ring rounded-md"
          disabled={!interaction?.onOpenImage}
          onClick={() => interaction?.onOpenImage?.(reference)}
        >
          <img
            src={image.src}
            alt={reference.filename ?? 'Tool image'}
            className={`${REPLAY_BLOCK_CLASS} max-h-80 max-w-full rounded-md object-contain`}
          />
        </button>
      )}
      {image.loading && (
        <span role="status" className="text-xs fg-secondary">
          Loading image from desktop…
        </span>
      )}
      {image.error && (
        <ErrorBanner className="" error={image.error} onRetry={image.retry} />
      )}
    </div>
  );
}

const ChatMessageAttachmentInteractionContext =
  createContext<ChatMessageAttachmentInteraction | null>(null);

export function ChatMessageAttachmentInteractionProvider({
  value,
  children,
}: {
  value: ChatMessageAttachmentInteraction | null;
  children: ReactNode;
}): JSX.Element {
  return (
    <ChatMessageAttachmentInteractionContext.Provider value={value}>
      {children}
    </ChatMessageAttachmentInteractionContext.Provider>
  );
}

export function useChatMessageAttachmentInteraction(): ChatMessageAttachmentInteraction | null {
  return useContext(ChatMessageAttachmentInteractionContext);
}

/**
 * Whether an attachment is a video. A desktop chat projected to the Portal
 * knows its files by name only: it types anything outside the cloud
 * attachment allowlist, videos included, as `application/octet-stream`, so
 * there the file name decides.
 */
function isChatMessageVideo(attachment: PortalChatMessageAttachment): boolean {
  return (
    attachment.mediaType.startsWith('video/') ||
    (attachment.mediaType === 'application/octet-stream' &&
      VIDEO_FILENAME.test(attachment.filename))
  );
}

/** An image the hosts can preview, by its media type. */
function isChatMessageImage(attachment: PortalChatMessageAttachment): boolean {
  return isCloudImageAttachmentMediaType(attachment.mediaType);
}

/** One attachment shown as a tile in the bubble's media row. */
export interface ChatMessageMediaItem {
  readonly attachment: PortalChatMessageAttachment;
  /** A picture (`image`, `video`) or a file shown by its type and name. */
  readonly kind: 'image' | 'video' | 'file';
  /** The host's URL for an image; `null` for anything else or one to resolve. */
  readonly src: string | null;
  /** An image without a URL that the tile reads through the host's resolver. */
  readonly resolve: boolean;
}

/** A sent message's attachments as tiles in its bubble, in attach order. */
export interface ChatMessageAttachmentSplit {
  readonly media: readonly ChatMessageMediaItem[];
  /**
   * A picture tile has nothing to show (it failed to load, or the resolver
   * found none): the attachment becomes its file tile.
   */
  readonly onMediaFailed: (attachmentId: string) => void;
}

/**
 * Orders a sent message's attachments the way desktop's `useSentAttachments`
 * does. A video is always a picture tile, its play mark alone where no frame
 * is drawn. An image is a picture tile while its picture can show: the
 * host's URL, or a picture its resolver may return. Each tile reads its own
 * picture (`useChatAssetImage`), so one slow read never holds the others
 * back, and a tile that ends with nothing to show reports it through
 * `onMediaFailed`. An image with no source, or one that failed, is its file
 * tile, never a blank square, and so is everything else. An attachment id
 * that repeats is shown once.
 *
 * A failure belongs to the source that failed: if the host's URL or its
 * resolver changes (a reconnected session), the image is a picture again
 * and tries the new source.
 */
export function useChatMessageAttachmentSplit(
  attachments: readonly PortalChatMessageAttachment[],
): ChatMessageAttachmentSplit {
  const interaction = useChatMessageAttachmentInteraction();
  // Only these two host functions take part, so a host rebuilding its
  // interaction for an unrelated callback changes nothing here.
  const imageSrc = interaction?.imageSrc;
  const resolve = interaction?.resolveImage;
  const [failed, setFailed] = useState<ReadonlyMap<string, unknown>>(
    () => new Map(),
  );
  // What each image's picture comes from now: its URL, or the resolver.
  const sources = useRef<ReadonlyMap<string, unknown>>(new Map());
  const split = useMemo(() => {
    const media: ChatMessageMediaItem[] = [];
    const current = new Map<string, unknown>();
    const seen = new Set<string>();
    const file = (attachment: PortalChatMessageAttachment): void => {
      media.push({ attachment, kind: 'file', src: null, resolve: false });
    };
    for (const attachment of attachments) {
      if (seen.has(attachment.attachmentId)) continue;
      seen.add(attachment.attachmentId);
      if (isChatMessageVideo(attachment)) {
        media.push({ attachment, kind: 'video', src: null, resolve: false });
        continue;
      }
      if (!isChatMessageImage(attachment)) {
        file(attachment);
        continue;
      }
      const url = imageSrc?.(attachment) ?? null;
      const source: unknown =
        url ?? (resolve && attachment.assetId !== undefined ? resolve : null);
      if (source === null) {
        file(attachment);
        continue;
      }
      current.set(attachment.attachmentId, source);
      if (failed.get(attachment.attachmentId) === source) {
        file(attachment);
      } else {
        media.push({
          attachment,
          kind: 'image',
          src: url,
          resolve: url === null,
        });
      }
    }
    return { media, current };
  }, [attachments, failed, imageSrc, resolve]);
  useLayoutEffect(() => {
    sources.current = split.current;
  }, [split]);
  const onMediaFailed = useCallback((attachmentId: string): void => {
    const source = sources.current.get(attachmentId);
    if (source === undefined) return;
    setFailed((previous) =>
      previous.get(attachmentId) === source
        ? previous
        : new Map(previous).set(attachmentId, source),
    );
  }, []);
  return useMemo(
    (): ChatMessageAttachmentSplit => ({
      media: split.media,
      onMediaFailed,
    }),
    [split, onMediaFailed],
  );
}

/**
 * A sent message's attachments inside its bubble: the shared media row
 * desktop uses, 64px tiles in attach order (seven and a “+N” past eight).
 * Images and videos show as pictures, a video with its play mark; other
 * files show their type and name. Takes the `media` of
 * `useChatMessageAttachmentSplit`.
 */
export const ChatMessageMedia = memo(function ChatMessageMedia({
  media,
  onMediaFailed,
  alone = false,
}: {
  readonly media: readonly ChatMessageMediaItem[];
  readonly onMediaFailed: (attachmentId: string) => void;
  /** The message has no text under the row. */
  readonly alone?: boolean;
}): JSX.Element | null {
  const interaction = useChatMessageAttachmentInteraction();
  if (media.length === 0) return null;
  return (
    <MessageMediaRow alone={alone}>
      {media.map((item) => (
        <ChatMessageMediaTile
          key={item.attachment.attachmentId}
          item={item}
          interaction={interaction}
          onMediaFailed={onMediaFailed}
        />
      ))}
    </MessageMediaRow>
  );
});

function ChatMessageMediaTile({
  item,
  interaction,
  onMediaFailed,
}: {
  item: ChatMessageMediaItem;
  interaction: ChatMessageAttachmentInteraction | null;
  onMediaFailed: (attachmentId: string) => void;
}): JSX.Element {
  const { attachment } = item;
  // This tile's own read: it aborts and disposes its picture when the tile
  // goes or its source changes, whatever the other tiles are doing.
  const read = useChatAssetImage(
    item.resolve && attachment.assetId !== undefined
      ? {
          assetId: attachment.assetId,
          mediaType: attachment.mediaType,
          filename: attachment.filename,
        }
      : null,
  );
  const settledEmpty =
    item.resolve && !read.loading && (read.error !== null || read.src === null);
  useEffect(() => {
    if (settledEmpty) onMediaFailed(attachment.attachmentId);
  }, [settledEmpty, onMediaFailed, attachment.attachmentId]);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const onOpen = interaction?.onOpen;
  // The tile opens the file; a host that cannot open files downloads it
  // instead.
  const activate =
    onOpen !== undefined
      ? (): void => onOpen(attachment)
      : interaction !== null
        ? (): void => {
            setDownloadError(null);
            void interaction.onDownload(attachment).catch(() => {
              setDownloadError(
                `Couldn’t download ${attachment.filename}. Try again.`,
              );
            });
          }
        : undefined;
  const downloads = onOpen === undefined && activate !== undefined;
  const action: Pick<MessageImageAttachment, 'onOpen' | 'actionLabel'> = {
    ...(activate === undefined ? {} : { onOpen: activate }),
    ...(downloads ? { actionLabel: 'Download' } : {}),
  };
  return (
    <>
      {item.kind === 'file' ? (
        <MessageFileTile
          file={{
            key: attachment.attachmentId,
            name: attachment.filename,
            ...action,
          }}
        />
      ) : (
        <MessageMediaTile
          image={{
            key: attachment.attachmentId,
            src: item.resolve ? read.src : item.src,
            kind: item.kind,
            alt: attachment.filename,
            onError: (): void => onMediaFailed(attachment.attachmentId),
            ...action,
          }}
        />
      )}
      {downloadError && (
        <div className="basis-full">
          <ErrorBanner className="" error={downloadError} />
        </div>
      )}
    </>
  );
}
