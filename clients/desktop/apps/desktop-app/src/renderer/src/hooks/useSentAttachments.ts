import { useEffect, useMemo, useState } from 'react';
import { PREVIEWABLE_IMAGE_FILENAME, VIDEO_FILENAME } from '@/lib/file-type';
import { cloudAttachmentPreview } from '@/cloud-chats/cloud-chat-attachments';

/**
 * Reads each image's preview (a data URL) once per path. A path whose read
 * fails or is not an image (too large, unreadable) maps to `null`; a path
 * still loading has no entry. With `videoFrame`, a video's preview is its
 * first frame, where the OS can draw one.
 */
export function useImagePreviews(
  paths: readonly string[],
  { videoFrame = false }: { readonly videoFrame?: boolean } = {},
): ReadonlyMap<string, string | null> {
  const key = paths.join('\n');
  const [previews, setPreviews] = useState<ReadonlyMap<string, string | null>>(
    () => new Map(),
  );
  useEffect(() => {
    let cancelled = false;
    const wanted = key === '' ? [] : key.split('\n');
    void Promise.all(
      wanted.map((absolutePath) => {
        // A cloud chat's attachment is never read through main.
        const cloud = cloudAttachmentPreview(absolutePath);
        if (cloud !== undefined)
          return Promise.resolve<[string, string | null]>([
            absolutePath,
            cloud.kind === 'image' ? cloud.content : null,
          ]);
        return window.api
          .readFilePreview(
            videoFrame ? { absolutePath, videoFrame } : { absolutePath },
          )
          .then((preview): [string, string | null] => [
            absolutePath,
            preview.kind === 'image' ? preview.content : null,
          ])
          .catch((): [string, string | null] => [absolutePath, null]);
      }),
    ).then((entries) => {
      if (!cancelled) setPreviews(new Map(entries));
    });
    return (): void => {
      cancelled = true;
    };
  }, [key, videoFrame]);
  return previews;
}

export type SentAttachment =
  | {
      readonly absolutePath: string;
      /**
       * Data URL: an image's picture, or a video's first frame. `null` while
       * it loads, and for a video whose frame the OS cannot draw.
       */
      readonly src: string | null;
      /** A video's tile carries a play mark over its frame. */
      readonly kind: 'image' | 'video';
    }
  | {
      readonly absolutePath: string;
      /** Any other file, or an image with no picture: its type and name. */
      readonly kind: 'file';
    };

/**
 * A message's attachments as the tiles of its bubble, in attach order. An
 * image the preview handler can draw is its picture; one whose preview does
 * not come back as an image (too large, unreadable, a type it cannot draw)
 * is a file tile. A video is always its first frame, or an empty tile with
 * its play mark where the OS draws none, the way a queued message shows it.
 * Every other file is a file tile.
 */
export function useSentAttachments(
  attachmentPaths: readonly string[] | undefined,
): readonly SentAttachment[] {
  const candidates = useMemo(
    () =>
      (attachmentPaths ?? []).filter((path) =>
        PREVIEWABLE_IMAGE_FILENAME.test(path),
      ),
    [attachmentPaths],
  );
  const videos = useMemo(
    () => (attachmentPaths ?? []).filter((path) => VIDEO_FILENAME.test(path)),
    [attachmentPaths],
  );
  const previews = useImagePreviews(candidates);
  const frames = useImagePreviews(videos, { videoFrame: true });
  return useMemo((): readonly SentAttachment[] => {
    const isVideo = new Set(videos);
    const isImage = new Set(candidates);
    const seen = new Set<string>();
    const tiles: SentAttachment[] = [];
    for (const absolutePath of attachmentPaths ?? []) {
      if (seen.has(absolutePath)) continue;
      seen.add(absolutePath);
      if (isVideo.has(absolutePath)) {
        tiles.push({
          absolutePath,
          src: frames.get(absolutePath) ?? null,
          kind: 'video',
        });
      } else if (
        isImage.has(absolutePath) &&
        previews.get(absolutePath) !== null
      ) {
        // Still loading (no entry yet) keeps the picture's tile.
        tiles.push({
          absolutePath,
          src: previews.get(absolutePath) ?? null,
          kind: 'image',
        });
      } else {
        tiles.push({ absolutePath, kind: 'file' });
      }
    }
    return tiles;
  }, [attachmentPaths, candidates, videos, previews, frames]);
}
