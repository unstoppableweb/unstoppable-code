import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { documentPreviewMaxBytes } from '@canopy/protocol/document-preview';
import {
  MediaViewer,
  type MediaViewerItem,
} from '@canopy/ui-shared/components';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { getFilenameFromPath, VIDEO_FILENAME } from '@/lib/file-type';
import { resolveDesktopDocumentBytes } from '@/lib/file-viewer/desktop-document-bytes';
import { shrinkPicture } from '@/lib/shrink-picture';
import { useChatStore } from '@/stores/chatStore';

/** One image or video to show, by its file. */
export interface DesktopMediaSource {
  readonly absolutePath: string;
  /** Defaults to the file's name. */
  readonly name?: string;
  /** Defaults from the file's extension. */
  readonly kind?: 'image' | 'video';
}

/** The worktree whose files the viewer reads; videos are read through it. */
export interface DesktopMediaTarget {
  readonly projectId: string;
  readonly worktreeId: string;
}

interface OpenSet {
  readonly sources: readonly DesktopMediaSource[];
  readonly index: number;
  /** The scope videos are read through, fixed when the set is opened. */
  readonly target: DesktopMediaTarget | undefined;
  /** Another window's document, when the host sits in a pulled-out panel. */
  readonly ownerDocument: Document | undefined;
}

function kindOf(source: DesktopMediaSource): 'image' | 'video' {
  return (
    source.kind ??
    (VIDEO_FILENAME.test(source.absolutePath) ? 'video' : 'image')
  );
}

function videoType(path: string): string {
  return /\.webm$/i.test(path)
    ? 'video/webm'
    : /\.mov$/i.test(path)
      ? 'video/quicktime'
      : 'video/mp4';
}

/**
 * A picture from the preview handler: the image, or a video's first frame.
 * With `edgePx` a whole image is cut down off the main thread to that square;
 * a video's frame is small already.
 */
async function readPicture(
  absolutePath: string,
  videoFrame: boolean,
  edgePx?: number,
): Promise<string | null> {
  try {
    const preview = await window.api.readFilePreview(
      videoFrame ? { absolutePath, videoFrame } : { absolutePath },
    );
    if (preview.kind !== 'image') return null;
    return edgePx === undefined || videoFrame
      ? preview.content
      : await shrinkPicture(preview.content, edgePx);
  } catch (error) {
    reportClientAppError(error);
    return null;
  }
}

/** Thumbnail reads in flight at once. */
const THUMBNAIL_CONCURRENCY = 3;
/**
 * Strip items either side of the stage that get a picture: about what the
 * strip shows at once. The reach follows the stage as the set is stepped
 * through, so a large set is never read in one go.
 */
const THUMBNAIL_REACH = 12;
/** The strip draws a picture at 64px; twice that covers a dense screen. */
const THUMBNAIL_EDGE_PX = 128;

/**
 * The shared `MediaViewer` for desktop files: `open(sources, index)` shows a
 * set of images and videos over the window. Thumbnails load for the items
 * near the stage, a few at a time, as small copies, and are dropped when the
 * viewer closes. Only the item on the stage holds its full picture or, for a
 * video, its bytes as a playable URL (released when it leaves the stage).
 * Videos are read through `target`, the scope whose file roots hold the
 * files; a host that names none gets the worktree selected when the set is
 * opened. The viewer shows over the window the host is in: `viewer` is
 * always rendered, so a pulled-out panel's viewer finds its own document.
 * `canOpenExternal: false` leaves out Open in default app, for a folder
 * whose files another app may not open (a shared container's sealed copy).
 */
export function useDesktopMediaViewer(
  target?: DesktopMediaTarget,
  options?: { readonly canOpenExternal?: boolean },
): {
  readonly open: (
    sources: readonly DesktopMediaSource[],
    index: number,
  ) => void;
  readonly viewer: JSX.Element;
} {
  const canOpenExternal = options?.canOpenExternal ?? true;
  const [set, setSet] = useState<OpenSet | null>(null);
  // One video read at a time: main reads a whole file (up to the preview's
  // cap) for each, and a read cannot be cancelled once it is sent. Stepping
  // past a video before its turn comes skips its read altogether.
  const videoReadRef = useRef<Promise<void>>(Promise.resolve());
  // Marks the host's place in the page: its document is the window the
  // viewer opens over.
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [thumbnails, setThumbnails] = useState<Map<string, string | null>>(
    () => new Map(),
  );
  const [stage, setStage] = useState<{
    readonly path: string;
    readonly src: string | null;
  } | null>(null);

  // Thumbnail reads: asked once per file while the viewer is open, a few at
  // a time. `session` changes whenever the viewer opens or closes, so a read
  // that lands after its viewer is gone is dropped, not kept.
  const requestedRef = useRef(new Set<string>());
  const queueRef = useRef<DesktopMediaSource[]>([]);
  const readingRef = useRef(0);
  const sessionRef = useRef(0);
  const resetThumbnails = useCallback((): void => {
    sessionRef.current += 1;
    requestedRef.current = new Set();
    queueRef.current = [];
    setThumbnails(new Map());
  }, []);

  const open = useCallback(
    (sources: readonly DesktopMediaSource[], index: number): void => {
      if (sources.length === 0) return;
      resetThumbnails();
      // Read once, here: a hook in every message that subscribed to the
      // store would wake on each change to it while its viewer is closed.
      const selected = useChatStore.getState().selectedWorktree;
      const hostDocument = anchorRef.current?.ownerDocument;
      setSet({
        sources,
        index: Math.min(Math.max(index, 0), sources.length - 1),
        target:
          target ??
          (selected
            ? {
                projectId: selected.projectId,
                worktreeId: selected.worktreeId,
              }
            : undefined),
        ownerDocument:
          hostDocument !== undefined && hostDocument !== document
            ? hostDocument
            : undefined,
      });
    },
    [resetThumbnails, target],
  );
  const close = useCallback((): void => {
    resetThumbnails();
    setSet(null);
    setStage(null);
  }, [resetThumbnails]);

  // A pulled-out panel's window can close while its viewer is open, and the
  // panel returns to the main window without unmounting this host: the
  // viewer closes with that window, so its video URL and thumbnails go.
  const viewerWindow = set?.ownerDocument?.defaultView ?? null;
  useEffect(() => {
    if (viewerWindow === null) return undefined;
    viewerWindow.addEventListener('pagehide', close);
    return (): void => {
      viewerWindow.removeEventListener('pagehide', close);
    };
  }, [close, viewerWindow]);

  const pumpThumbnails = useCallback((): void => {
    while (
      readingRef.current < THUMBNAIL_CONCURRENCY &&
      queueRef.current.length > 0
    ) {
      const source = queueRef.current.shift();
      if (source === undefined) return;
      const path = source.absolutePath;
      const session = sessionRef.current;
      readingRef.current += 1;
      const videoFrame = kindOf(source) === 'video';
      void readPicture(path, videoFrame, THUMBNAIL_EDGE_PX).then((src) => {
        readingRef.current -= 1;
        if (session === sessionRef.current) {
          setThumbnails((current) => new Map(current).set(path, src));
        }
        pumpThumbnails();
      });
    }
  }, []);

  // When the host goes, nothing more is read: the queue is emptied, and a
  // read that lands late is dropped.
  useEffect(
    () => (): void => {
      sessionRef.current += 1;
      queueRef.current = [];
    },
    [],
  );

  // Thumbnails for the items near the stage, nearest first.
  const sources = set?.sources;
  const stageIndex = set?.index;
  useEffect(() => {
    if (!sources || stageIndex === undefined) return;
    const distance = new Map(
      sources.map((source, index) => [
        source.absolutePath,
        Math.abs(index - stageIndex),
      ]),
    );
    // A jump leaves the earlier position's pending reads out of reach:
    // they are dropped, and may be asked for again on the way back.
    queueRef.current = queueRef.current.filter((source) => {
      const near =
        (distance.get(source.absolutePath) ?? Infinity) <= THUMBNAIL_REACH;
      if (!near) requestedRef.current.delete(source.absolutePath);
      return near;
    });
    for (const source of sources) {
      const path = source.absolutePath;
      if ((distance.get(path) ?? Infinity) > THUMBNAIL_REACH) continue;
      if (requestedRef.current.has(path)) continue;
      requestedRef.current.add(path);
      queueRef.current.push(source);
    }
    // Nearest the stage first, then outward.
    queueRef.current.sort(
      (a, b) =>
        (distance.get(a.absolutePath) ?? Infinity) -
        (distance.get(b.absolutePath) ?? Infinity),
    );
    pumpThumbnails();
  }, [pumpThumbnails, sources, stageIndex]);

  // The stage: an image's full picture, or a video's bytes as a URL.
  const current = set ? set.sources[set.index] : undefined;
  const currentPath = current?.absolutePath;
  const currentKind = current ? kindOf(current) : undefined;
  const projectId = set?.target?.projectId;
  const worktreeId = set?.target?.worktreeId;
  useEffect(() => {
    if (currentPath === undefined || currentKind === undefined) {
      return undefined;
    }
    const path = currentPath;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setStage(null);
    if (currentKind === 'image') {
      void readPicture(path, false).then((src) => {
        if (!controller.signal.aborted) setStage({ path, src });
      });
    } else if (projectId === undefined || worktreeId === undefined) {
      setStage({ path, src: null });
    } else {
      videoReadRef.current = videoReadRef.current.then(async () => {
        // Left the stage while an earlier read was still running.
        if (controller.signal.aborted) return;
        try {
          const result = await resolveDesktopDocumentBytes(
            () =>
              window.api.readFileDocumentBytes({
                absolutePath: path,
                workspaceTarget: { projectId, worktreeId },
              }),
            controller.signal,
            documentPreviewMaxBytes(path),
          );
          if (controller.signal.aborted) return;
          if (result.status !== 'ready') {
            setStage({ path, src: null });
            return;
          }
          objectUrl = URL.createObjectURL(
            new Blob([result.bytes], { type: videoType(path) }),
          );
          setStage({ path, src: objectUrl });
        } catch (error) {
          // The reader throws only for a read that was left behind.
          if (controller.signal.aborted) return;
          reportClientAppError(error);
          setStage({ path, src: null });
        }
      });
    }
    return (): void => {
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [currentKind, currentPath, projectId, worktreeId]);

  const items = useMemo(
    (): MediaViewerItem[] =>
      (set?.sources ?? []).map((source) => {
        const path = source.absolutePath;
        return {
          key: path,
          name: source.name ?? getFilenameFromPath(path),
          kind: kindOf(source),
          thumbnail: thumbnails.get(path) ?? null,
          src: path === stage?.path ? stage.src : undefined,
        };
      }),
    [set, stage, thumbnails],
  );

  // A rejection reaches the viewer, which says so beside the action.
  const onOpenExternal = useCallback(
    (item: MediaViewerItem): Promise<void> =>
      window.api
        .openExternalFile({ absolutePath: item.key })
        .catch((error: unknown): never => {
          reportClientAppError(error);
          throw error;
        }),
    [],
  );

  const viewer = (
    <>
      <span ref={anchorRef} hidden />
      {set === null ? null : (
        <MediaViewer
          items={items}
          index={set.index}
          onIndexChange={(index): void =>
            setSet((currentSet) =>
              currentSet === null ? null : { ...currentSet, index },
            )
          }
          onClose={close}
          {...(canOpenExternal ? { onOpenExternal } : {})}
          {...(set.ownerDocument ? { ownerDocument: set.ownerDocument } : {})}
          testId="media-viewer"
        />
      )}
    </>
  );

  return { open, viewer };
}
