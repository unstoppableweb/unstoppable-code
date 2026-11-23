'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react';
import {
  GlobalWorkerOptions,
  TextLayer,
  getDocument,
  version,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from 'pdfjs-dist';
import {
  searchPdfPagesIncrementally,
  type PdfSearchMatch,
  type PdfSearchTextItem,
} from './pdf-search';
import { Button, Tooltip } from '@canopy/ui-shared/components';
import {
  MinusIcon,
  PlusIcon,
  MaximizeIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { recordSurfacedError } from '@canopy/ui-shared/lib';
import styles from './PdfPreview.module.css';
import { isPdfRectangle, pdfExternalLinks } from './pdf-links';

export const PDF_PREVIEW_MAX_PAGES = 500;
export const PDF_PREVIEW_MAX_CANVAS_PIXELS = 8_388_608;
const EMPTY_SEARCH_MATCHES: readonly PdfSearchMatch[] = [];
export const PDF_PREVIEW_MAX_SOURCE_IMAGE_PIXELS = 8_388_608;
const PDF_PREVIEW_PAGE_LOAD_CONCURRENCY = 8;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

export type PdfPreviewRenderFailure = 'password-protected' | 'corrupt';

export interface PdfPreviewAssets {
  readonly workerSrc: string;
  readonly assetBaseUrl: string;
}

export interface PdfPreviewProps {
  readonly bytes: ArrayBuffer;
  readonly fileName: string;
  readonly search?: { readonly query: string; readonly index: number };
  readonly onSearchResult?: (result: PdfPreviewSearchResult) => void;
  readonly onRenderFailure: (failure: PdfPreviewRenderFailure) => void;
  readonly resolveAssets: (pdfJsVersion: string) => PdfPreviewAssets;
}

export interface PdfPreviewSearchResult {
  readonly ready: boolean;
  readonly query: string;
  readonly totalCount: number;
  readonly currentIndex: number;
}

interface PdfLoadedPageInfo {
  readonly state: 'loaded';
  readonly page: PDFPageProxy;
  readonly width: number;
  readonly height: number;
}

interface PdfFailedPageInfo {
  readonly state: 'failed';
  readonly width: number;
  readonly height: number;
}

type PdfPageInfo = PdfLoadedPageInfo | PdfFailedPageInfo;

interface PdfPageRenderWork {
  readonly token: symbol;
  canvasTask?: RenderTask;
  textLayer?: TextLayer;
}

type PdfTextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;

function isCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'RenderingCancelledException' ||
    error.name === 'AbortException' ||
    /cancel/i.test(error.message)
  );
}

/**
 * pdf.js exceptions that mean the file's own bytes are damaged or unusable
 * (parse, format and embedded-image decode failures), never an application
 * defect.
 */
const PDF_INPUT_FAILURE_NAMES: ReadonlySet<string> = new Set([
  'InvalidPDFException',
  'FormatError',
  'XRefParseException',
  'XRefEntryException',
  'ParserEOFException',
  'MissingDataException',
  'JpegError',
  'JpxError',
  'DNLMarkerError',
  'EOIMarkerError',
  'ResponseException',
  'PasswordException',
]);

/**
 * `details` prefix of the pinned pdf.js (5.7.284) Brotli stream decoder, the
 * one decoder that fails with a plain `Error` (name `Error`, so the name set
 * cannot match it). Used only to classify; nothing from it is sent.
 */
const PDF_BROTLI_FAILURE_PREFIX = 'Error: Brotli error code:';

/**
 * True for a damaged-input failure. The pdf.js worker rewraps every error it
 * does not know as an `UnknownErrorException` whose `details` is the
 * original's `toString()` (`"FormatError: …"`); a `cause` is read too, for
 * builds that set one.
 */
function isPdfInputFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (PDF_INPUT_FAILURE_NAMES.has(error.name)) return true;
  if (error.name !== 'UnknownErrorException') return false;
  const details: unknown = Reflect.get(error, 'details');
  const cause: unknown = Reflect.get(error, 'cause');
  return (
    (typeof details === 'string' &&
      (details.startsWith(PDF_BROTLI_FAILURE_PREFIX) ||
        PDF_INPUT_FAILURE_NAMES.has(details.split(':', 1)[0] ?? ''))) ||
    (cause instanceof Error && PDF_INPUT_FAILURE_NAMES.has(cause.name))
  );
}

function textItems(content: PdfTextContent): PdfSearchTextItem[] {
  return content.items.map((item) =>
    'str' in item
      ? { text: item.str, hasEOL: item.hasEOL }
      : { text: '', hasEOL: false },
  );
}

/** CSS custom properties the pdf.js text layer scales itself from. */
type PdfPageShellStyle = CSSProperties & {
  readonly '--total-scale-factor': string;
  readonly '--scale-round-x': string;
  readonly '--scale-round-y': string;
};

export function PdfPreview({
  bytes,
  fileName,
  search,
  onSearchResult,
  onRenderFailure,
  resolveAssets,
}: PdfPreviewProps): JSX.Element {
  const [pages, setPages] = useState<readonly PdfPageInfo[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(false);
  const query = search?.query ?? '';
  const [result, setResult] = useState<{
    query: string;
    matches: readonly PdfSearchMatch[];
  }>({ query: '', matches: [] });
  const matches =
    result.query === query ? result.matches : EMPTY_SEARCH_MATCHES;
  const requestedIndex = search?.index ?? 0;
  const activeMatchIndex =
    matches.length === 0
      ? -1
      : requestedIndex >= 0 && requestedIndex < matches.length
        ? requestedIndex
        : 0;
  const previewPageCount = Math.min(totalPages, PDF_PREVIEW_MAX_PAGES);
  const searchReady = previewPageCount > 0 && pages.length === previewPageCount;
  const assets = useMemo(() => resolveAssets(version), [resolveAssets]);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const pageShells = useRef(new Map<number, HTMLElement>());
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const linkLayers = useRef(new Map<number, HTMLDivElement>());
  const annotationCache = useRef(new Map<number, Promise<unknown>>());
  const textLayers = useRef(new Map<number, HTMLDivElement>());
  const renderWork = useRef(new Map<number, PdfPageRenderWork>());
  const textDivs = useRef(new Map<number, HTMLElement[]>());
  const textCache = useRef(new Map<number, Promise<PdfTextContent>>());
  const visibleRatios = useRef(new Map<number, number>());
  const searchGeneration = useRef(0);
  // One page-failure record per opened document: zoom, scrolling back and
  // the remaining pages fail the same way and would otherwise repeat it.
  const pageFailureRecorded = useRef(false);
  const searchState = useRef<{
    readonly matches: readonly PdfSearchMatch[];
    readonly activeMatchIndex: number;
  }>({
    matches: [],
    activeMatchIndex: -1,
  });
  useEffect(() => {
    searchState.current = { matches, activeMatchIndex };
  }, [activeMatchIndex, matches]);

  const cancelPage = useCallback((pageIndex: number): void => {
    const work = renderWork.current.get(pageIndex);
    work?.canvasTask?.cancel();
    work?.textLayer?.cancel();
    renderWork.current.delete(pageIndex);
    textDivs.current.delete(pageIndex);
    const canvas = canvases.current.get(pageIndex);
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    textLayers.current.get(pageIndex)?.replaceChildren();
    linkLayers.current.get(pageIndex)?.replaceChildren();
  }, []);

  const applySearchHighlight = useCallback((pageIndex?: number): void => {
    const state = searchState.current;
    for (const [index, spans] of textDivs.current) {
      if (pageIndex !== undefined && index !== pageIndex) continue;
      const highlightStates = spans.map(
        (span) => new Uint8Array(span.textContent?.length ?? 0),
      );
      state.matches.forEach((match, matchIndex) => {
        if (match.pageIndex !== index) return;
        const highlightState = matchIndex === state.activeMatchIndex ? 2 : 1;
        for (const fragment of match.fragments) {
          const characterStates = highlightStates[fragment.itemIndex];
          if (!characterStates) continue;
          const endOffset = Math.min(
            fragment.endOffset,
            characterStates.length,
          );
          for (
            let offset = Math.max(0, fragment.startOffset);
            offset < endOffset;
            offset += 1
          ) {
            characterStates[offset] = Math.max(
              characterStates[offset] ?? 0,
              highlightState,
            );
          }
        }
      });

      for (let itemIndex = 0; itemIndex < spans.length; itemIndex += 1) {
        const span = spans[itemIndex];
        const characterStates = highlightStates[itemIndex];
        if (!span || !characterStates) continue;
        const text = span.textContent ?? '';
        const children: Node[] = [];
        let rangeStart = 0;
        while (rangeStart < text.length) {
          const rangeState = characterStates[rangeStart] ?? 0;
          let rangeEnd = rangeStart + 1;
          while (
            rangeEnd < text.length &&
            characterStates[rangeEnd] === rangeState
          ) {
            rangeEnd += 1;
          }
          const rangeText = text.slice(rangeStart, rangeEnd);
          if (rangeState === 0) {
            children.push(document.createTextNode(rangeText));
          } else {
            const mark = document.createElement('mark');
            mark.className =
              rangeState === 2 ? styles.searchMatchActive : styles.searchMatch;
            mark.dataset.pdfSearchHighlight =
              rangeState === 2 ? 'active' : 'match';
            mark.textContent = rangeText;
            children.push(mark);
          }
          rangeStart = rangeEnd;
        }
        span.replaceChildren(...children);
      }
    }
  }, []);

  const getPageTextContent = useCallback(
    (pageIndex: number): Promise<PdfTextContent> | null => {
      const existing = textCache.current.get(pageIndex);
      if (existing) return existing;
      const pageInfo = pages[pageIndex];
      const page = pageInfo?.state === 'loaded' ? pageInfo.page : undefined;
      if (!page) return null;
      const promise = page.getTextContent();
      textCache.current.set(pageIndex, promise);
      // Evict on rejection so one failed extraction cannot poison every later
      // render and search of the page. Attaching the handler here also keeps a
      // caller-abandoned rejection from surfacing as unhandled.
      void promise.catch(() => {
        if (textCache.current.get(pageIndex) === promise) {
          textCache.current.delete(pageIndex);
        }
      });
      return promise;
    },
    [pages],
  );

  const renderPage = useCallback(
    async (pageIndex: number): Promise<void> => {
      const info = pages[pageIndex];
      const canvas = canvases.current.get(pageIndex);
      const layerContainer = textLayers.current.get(pageIndex);
      if (!info || info.state !== 'loaded' || !canvas || !layerContainer)
        return;
      cancelPage(pageIndex);
      const token = Symbol(`pdf-page-${String(pageIndex)}`);
      const work: PdfPageRenderWork = { token };
      renderWork.current.set(pageIndex, work);
      const viewport = info.page.getViewport({ scale: zoom });
      const cssPixels = Math.max(1, viewport.width * viewport.height);
      const maxOutputScale = Math.sqrt(
        PDF_PREVIEW_MAX_CANVAS_PIXELS / cssPixels,
      );
      const outputScale = Math.min(
        globalThis.devicePixelRatio || 1,
        maxOutputScale,
      );
      canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
      canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
      canvas.style.width = `${String(viewport.width)}px`;
      canvas.style.height = `${String(viewport.height)}px`;
      layerContainer.replaceChildren();
      layerContainer.style.setProperty('--total-scale-factor', String(zoom));
      layerContainer.style.setProperty('--scale-round-x', '1px');
      layerContainer.style.setProperty('--scale-round-y', '1px');

      try {
        const contentPromise = getPageTextContent(pageIndex);
        if (contentPromise === null) return;
        const canvasTask = info.page.render({
          canvas,
          viewport,
          ...(outputScale === 1
            ? {}
            : { transform: [outputScale, 0, 0, outputScale, 0, 0] }),
        });
        work.canvasTask = canvasTask;
        // Observe the render promise immediately: a cancellation while this
        // routine is parked on the text-content await below would otherwise
        // reject it with no handler attached (an unhandled rejection on every
        // routine scroll-out).
        void canvasTask.promise.catch(() => undefined);
        const content = await contentPromise;
        if (renderWork.current.get(pageIndex)?.token !== token) return;
        const textLayer = new TextLayer({
          textContentSource: content,
          container: layerContainer,
          viewport,
        });
        work.textLayer = textLayer;
        await Promise.all([canvasTask.promise, textLayer.render()]);
        if (renderWork.current.get(pageIndex)?.token !== token) return;
        textDivs.current.set(pageIndex, textLayer.textDivs);
        applySearchHighlight(pageIndex);
        // Annotation failure is separate from canvas/text failure: keep the
        // readable page if only its links are damaged.
        let annotations = annotationCache.current.get(pageIndex);
        if (!annotations) {
          annotations = info.page.getAnnotations({ intent: 'display' });
          annotationCache.current.set(pageIndex, annotations);
        }
        void annotations
          .then((items: unknown) => {
            if (renderWork.current.get(pageIndex)?.token !== token) return;
            const layer = linkLayers.current.get(pageIndex);
            if (!layer) return;
            const anchors = pdfExternalLinks(items).flatMap((link) => {
              const rectangle: unknown = viewport.convertToViewportRectangle([
                ...link.rect,
              ]);
              if (!isPdfRectangle(rectangle)) return [];
              const [x1, y1, x2, y2] = rectangle;
              const anchor = layer.ownerDocument.createElement('a');
              anchor.href = link.url;
              anchor.target = '_blank';
              anchor.rel = 'noopener noreferrer';
              anchor.title = link.url;
              anchor.setAttribute('aria-label', link.url);
              anchor.dataset.testid = 'pdf-external-link';
              anchor.style.left = `${Math.min(x1, x2)}px`;
              anchor.style.top = `${Math.min(y1, y2)}px`;
              anchor.style.width = `${Math.abs(x2 - x1)}px`;
              anchor.style.height = `${Math.abs(y2 - y1)}px`;
              return anchor;
            });
            layer.replaceChildren(...anchors);
          })
          .catch(() => {
            if (annotationCache.current.get(pageIndex) === annotations)
              annotationCache.current.delete(pageIndex);
          });
      } catch (error) {
        // A cancelled or superseded render (scroll-out, zoom change) is
        // routine and must not touch page state. A real rasterization or
        // text-layer failure (a bad embedded font or image) is not a corrupt
        // document — the file already opened — but a silently blank shell is
        // indistinguishable from an empty page, so mark just this page failed
        // and let the existing per-page error placeholder render.
        if (isCancellation(error)) return;
        if (renderWork.current.get(pageIndex)?.token !== token) return;
        renderWork.current.delete(pageIndex);
        // A damaged page is the file's fault, not a defect: it keeps the
        // placeholder below but is not recorded and leaves the document's
        // one reporting slot free for a real defect on a later page.
        if (!isPdfInputFailure(error) && !pageFailureRecorded.current) {
          pageFailureRecorded.current = true;
          recordSurfacedError({
            chokePoint: 'notice',
            identifier: 'pdf-page',
            surface: 'inline',
            error,
          });
        }
        setPages((current) =>
          current.map((page, index) =>
            index === pageIndex && page.state === 'loaded'
              ? { state: 'failed', width: page.width, height: page.height }
              : page,
          ),
        );
      }
    },
    [applySearchHighlight, cancelPage, getPageTextContent, pages, zoom],
  );

  useEffect(() => {
    let active = true;
    let passwordRequested = false;
    // Keep a document switch visually clean without synchronously cascading a
    // render from the effect body under React 19's effect semantics.
    void Promise.resolve().then(() => {
      if (!active) return;
      setPages([]);
      setTotalPages(0);
      setCurrentPage(1);
      setResult({ query: '', matches: [] });
    });
    textCache.current.clear();
    annotationCache.current.clear();
    pageFailureRecorded.current = false;
    searchGeneration.current += 1;
    const documentRenderWork = renderWork.current;

    // `isEvalSupported` is kept explicit as a hardening declaration across
    // PDF.js versions: 5.7.284 removed the evaluator option (and its
    // dynamic-code path) from its public type/runtime, so the intersection
    // re-adds the field the shipped type no longer names.
    GlobalWorkerOptions.workerSrc = assets.workerSrc;
    const documentInit: Parameters<typeof getDocument>[0] & {
      isEvalSupported: boolean;
    } = {
      data: new Uint8Array(bytes.slice(0)),
      isEvalSupported: false,
      enableXfa: false,
      maxImageSize: PDF_PREVIEW_MAX_SOURCE_IMAGE_PIXELS,
      cMapUrl: `${assets.assetBaseUrl}cmaps/`,
      standardFontDataUrl: `${assets.assetBaseUrl}standard_fonts/`,
      wasmUrl: `${assets.assetBaseUrl}wasm/`,
      iccUrl: `${assets.assetBaseUrl}iccs/`,
    };
    const loadingTask = getDocument(documentInit);
    loadingTaskRef.current = loadingTask;
    loadingTask.onPassword = (
      updatePassword: (password: string | Error) => void,
    ): void => {
      passwordRequested = true;
      updatePassword(new Error('Password-protected PDF'));
    };
    // `.then(...).catch(...)` rather than a two-argument `.then` keeps failures
    // opening the document and failures forced by a mid-load destroy observed.
    // Individual page failures are settled below and rendered in place.
    void loadingTask.promise
      .then(async (document) => {
        if (!active) return;
        documentRef.current = document;
        const count = Math.min(document.numPages, PDF_PREVIEW_MAX_PAGES);
        setTotalPages(document.numPages);
        if (count === 0) return;

        const loadPage = async (
          pageIndex: number,
        ): Promise<PdfLoadedPageInfo> => {
          const page = await document.getPage(pageIndex + 1);
          const viewport = page.getViewport({ scale: 1 });
          return {
            state: 'loaded',
            page,
            width: viewport.width,
            height: viewport.height,
          };
        };
        let fallbackWidth = 612;
        let fallbackHeight = 792;
        const settlePages = async (
          pageIndexes: readonly number[],
        ): Promise<PdfPageInfo[]> => {
          const results = await Promise.allSettled(
            pageIndexes.map((pageIndex) => loadPage(pageIndex)),
          );
          return results.map((result) => {
            if (result.status === 'fulfilled') {
              fallbackWidth = result.value.width;
              fallbackHeight = result.value.height;
              return result.value;
            }
            return {
              state: 'failed',
              width: fallbackWidth,
              height: fallbackHeight,
            };
          });
        };
        const loaded = await settlePages([0]);
        if (!active) return;
        setPages([...loaded]);

        for (
          let batchStart = 1;
          batchStart < count;
          batchStart += PDF_PREVIEW_PAGE_LOAD_CONCURRENCY
        ) {
          const batchSize = Math.min(
            PDF_PREVIEW_PAGE_LOAD_CONCURRENCY,
            count - batchStart,
          );
          const batch = await settlePages(
            Array.from(
              { length: batchSize },
              (_, offset) => batchStart + offset,
            ),
          );
          if (!active) return;
          loaded.push(...batch);
        }
        if (active) {
          setPages([...loaded]);
        }
      })
      .catch((error: unknown) => {
        if (!active || isCancellation(error)) return;
        onRenderFailure(passwordRequested ? 'password-protected' : 'corrupt');
        void loadingTask.destroy();
      });

    return (): void => {
      active = false;
      searchGeneration.current += 1;
      for (const pageIndex of [...documentRenderWork.keys()]) {
        cancelPage(pageIndex);
      }
      documentRef.current = null;
      void loadingTask.destroy();
      if (loadingTaskRef.current === loadingTask) loadingTaskRef.current = null;
    };
  }, [
    assets.assetBaseUrl,
    assets.workerSrc,
    bytes,
    cancelPage,
    onRenderFailure,
  ]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || pages.length === 0) return undefined;
    const observedRenderWork = renderWork.current;
    visibleRatios.current.clear();
    const prefetchObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!(entry.target instanceof HTMLElement)) continue;
          const pageIndex = Number(entry.target.dataset.pageIndex);
          if (entry.isIntersecting) void renderPage(pageIndex);
          else cancelPage(pageIndex);
        }
      },
      { root: scroller, rootMargin: '100% 0px' },
    );
    const visibilityObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!(entry.target instanceof HTMLElement)) continue;
          const pageIndex = Number(entry.target.dataset.pageIndex);
          visibleRatios.current.set(
            pageIndex,
            entry.isIntersecting ? entry.intersectionRatio : 0,
          );
        }
        let bestIndex = 0;
        let bestRatio = -1;
        for (const [pageIndex, ratio] of visibleRatios.current) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestIndex = pageIndex;
          }
        }
        setCurrentPage(bestIndex + 1);
      },
      { root: scroller, rootMargin: '0px', threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const shell of pageShells.current.values()) {
      prefetchObserver.observe(shell);
      visibilityObserver.observe(shell);
    }
    return (): void => {
      prefetchObserver.disconnect();
      visibilityObserver.disconnect();
      for (const pageIndex of [...observedRenderWork.keys()]) {
        cancelPage(pageIndex);
      }
    };
  }, [cancelPage, pages, renderPage]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || pages.length === 0) return undefined;
    const observer = new ResizeObserver((entries) => {
      if (!fitWidth) return;
      const availableWidth =
        Math.max(1, entries[0]?.contentRect.width ?? 1) - 32;
      const widestPage = Math.max(...pages.map((page) => page.width));
      setZoom(
        Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, availableWidth / widestPage)),
      );
    });
    observer.observe(scroller);
    return (): void => observer.disconnect();
  }, [fitWidth, pages]);

  useEffect(() => {
    applySearchHighlight();
    const match = matches[activeMatchIndex];
    if (match) {
      pageShells.current.get(match.pageIndex)?.scrollIntoView({
        block: 'center',
        behavior: 'smooth',
      });
    }
  }, [activeMatchIndex, applySearchHighlight, matches]);

  useEffect(() => {
    const generation = ++searchGeneration.current;
    if (!searchReady || query.trim().length === 0) return;
    void searchPdfPagesIncrementally({
      pageCount: pages.length,
      query: query.trim(),
      getPageItems: async (pageIndex) => {
        const cached = getPageTextContent(pageIndex);
        if (!cached) return [];
        try {
          return textItems(await cached);
        } catch {
          return [];
        }
      },
      isCurrent: () => searchGeneration.current === generation,
    })
      .then((found) => {
        if (found !== null && searchGeneration.current === generation)
          setResult({ query, matches: found });
      })
      .catch(() => {
        if (searchGeneration.current === generation)
          setResult({ query, matches: [] });
      });
    return (): void => {
      searchGeneration.current += 1;
    };
  }, [getPageTextContent, pages.length, query, searchReady]);

  useEffect(() => {
    onSearchResult?.({
      ready: searchReady,
      query,
      totalCount: matches.length,
      currentIndex: Math.max(0, activeMatchIndex),
    });
  }, [activeMatchIndex, matches.length, onSearchResult, query, searchReady]);

  return (
    <div
      className={styles.preview}
      data-testid="pdf-preview"
      role="group"
      aria-label={fileName}
    >
      <div
        className={styles.zoomControls}
        data-testid="pdf-zoom-controls"
        role="group"
        aria-label="PDF zoom"
      >
        <Tooltip label="Zoom in">
          <Button
            variant="ghost"
            size="compact"
            iconOnly
            aria-label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => {
              setFitWidth(false);
              setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP));
            }}
          >
            <PlusIcon size="sm" />
          </Button>
        </Tooltip>
        <Tooltip label="Zoom out">
          <Button
            variant="ghost"
            size="compact"
            iconOnly
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => {
              setFitWidth(false);
              setZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP));
            }}
          >
            <MinusIcon size="sm" />
          </Button>
        </Tooltip>
        <Tooltip label="Fit PDF to width">
          <Button
            variant="ghost"
            size="compact"
            iconOnly
            aria-label="Fit PDF to width"
            aria-pressed={fitWidth}
            onClick={() => setFitWidth(true)}
          >
            <MaximizeIcon size="sm" />
          </Button>
        </Tooltip>
        <span className={styles.zoomLevel} aria-label="Zoom level">
          {Math.round(zoom * 100)}%
        </span>
      </div>
      <span
        className={styles.pageCounter}
        data-testid="pdf-page-counter"
        aria-label="Current PDF page"
      >
        {currentPage} / {Math.max(totalPages, pages.length)}
      </span>
      {/* The rendered pages are file content: session replay keeps a
          placeholder. The floating controls stay recorded. */}
      <div
        className={`${REPLAY_BLOCK_CLASS} ${styles.scroller}`}
        ref={scrollerRef}
      >
        {pages.map((info, pageIndex) => {
          const pageStyle: PdfPageShellStyle = {
            width:
              info.state === 'failed'
                ? `min(${String(info.width * zoom)}px, 100%)`
                : `${String(info.width * zoom)}px`,
            height: `${String(info.height * zoom)}px`,
            '--total-scale-factor': String(zoom),
            '--scale-round-x': '1px',
            '--scale-round-y': '1px',
          };
          return (
            <div
              key={pageIndex}
              ref={(node) => {
                if (node) pageShells.current.set(pageIndex, node);
                else pageShells.current.delete(pageIndex);
              }}
              className={styles.page}
              style={pageStyle}
              data-page-index={pageIndex}
              data-testid="pdf-preview-page"
            >
              {info.state === 'loaded' ? (
                <>
                  <canvas
                    ref={(node) => {
                      if (node) canvases.current.set(pageIndex, node);
                      else canvases.current.delete(pageIndex);
                    }}
                    data-testid="pdf-preview-page-canvas"
                  />
                  <div
                    ref={(node) => {
                      if (node) textLayers.current.set(pageIndex, node);
                      else textLayers.current.delete(pageIndex);
                    }}
                    className={styles.textLayer}
                  />
                  <div
                    ref={(node) => {
                      if (node) linkLayers.current.set(pageIndex, node);
                      else linkLayers.current.delete(pageIndex);
                    }}
                    className={styles.linkLayer}
                  />
                </>
              ) : (
                <div
                  className={styles.pageError}
                  data-testid="pdf-preview-page-error"
                  role="status"
                >
                  Page {pageIndex + 1} could not be previewed.
                </div>
              )}
            </div>
          );
        })}
        {totalPages > PDF_PREVIEW_MAX_PAGES && (
          <p className={styles.truncated} role="status">
            Showing first {PDF_PREVIEW_MAX_PAGES} of {totalPages} pages
          </p>
        )}
      </div>
    </div>
  );
}
