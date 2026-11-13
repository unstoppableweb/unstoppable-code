'use client';

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  CheckIcon,
  CodeIcon,
  CopyIcon,
  DownloadIcon,
  FileDownIcon,
  MoreHorizontalIcon,
  type AppIcon,
} from '../icons/AppIcons';
import { downloadBlob } from '../lib/download-blob';
import { Button } from './Button';
import { copyTextToClipboard } from './copy-to-clipboard';
import { DetailMoreMenuRows, type DetailMoreMenuItem } from './DetailMoreMenu';
import { FLOATING_MENU_GAP, FloatingMenu } from './FloatingMenu';
import {
  MERMAID_DROPPED_STYLING_NOTE,
  MERMAID_RENDER_FAILURE,
  planMermaidRender,
} from './markdown-mermaid-policy';
import {
  useMermaidExport,
  type MermaidExportFormat,
  type MermaidExportNotify,
} from './markdown-mermaid-export-context';
import {
  MARKDOWN_ROOT_ATTRIBUTE,
  mermaidAccessibleName,
  mermaidDiagramContext,
  mermaidExportFilenames,
  mermaidExportStem,
  mermaidFamilyLabel,
} from './markdown-mermaid-export-names';
import { TabContextMenu, type TabContextMenuItem } from './TabContextMenu';
import { Tooltip } from './Tooltip';

export interface MarkdownMermaidProps extends HTMLAttributes<HTMLElement> {
  readonly source: string;
  readonly streaming?: boolean;
}

interface DiagramResult {
  readonly source: string;
  readonly themeRevision: number;
  readonly svg?: string;
  readonly error?: string;
}

type ExportAction = 'copy' | 'text' | MermaidExportFormat;

type ExportFeedback =
  | { readonly kind: 'copied' }
  | { readonly kind: 'download' }
  | {
      readonly kind: 'saved';
      readonly filename: string;
      readonly open: () => void;
    }
  | { readonly kind: 'error'; readonly message: string };

interface ExportState {
  readonly identity: string;
  readonly pending: ExportAction | null;
  /**
   * The last result and the action it answers. Each result gets a new id, so
   * a repeated message is announced again and restarts the checkmark.
   */
  readonly feedback:
    | (ExportFeedback & { readonly id: number; readonly action: ExportAction })
    | null;
}

/** How long a control shows its checkmark after its action succeeds. */
const MERMAID_EXPORT_CONFIRMATION_MS = 2000;

const COPY_IMAGE_FAILED =
  'Couldn’t copy the picture. Check clipboard access and try again.';
const COPY_TEXT_FAILED = 'Couldn’t copy the diagram text. Try again.';
const SAVE_FAILED =
  'Couldn’t save the picture. Check that the folder can be written to and try again.';
const NAMES_EXHAUSTED =
  'Couldn’t find a free file name. Rename or move earlier pictures and try again.';

function feedbackMessage(
  feedback: ExportFeedback,
  action: ExportAction,
): string {
  switch (feedback.kind) {
    case 'copied':
      return action === 'text' ? 'Diagram text copied.' : 'Image copied.';
    case 'download':
      return 'Download started.';
    case 'saved':
      return `Saved ${feedback.filename}.`;
    case 'error':
      return feedback.message;
  }
}

function notifyFeedback(
  notify: MermaidExportNotify,
  feedback: ExportFeedback,
  action: ExportAction,
): void {
  const message = feedbackMessage(feedback, action);
  if (feedback.kind === 'error') {
    notify({ tone: 'error', message });
    return;
  }
  notify({
    tone: 'success',
    message,
    ...(feedback.kind === 'saved'
      ? {
          action: { label: 'Open', run: feedback.open },
          blockMessageFromReplay: true,
        }
      : {}),
  });
}

/** The visible control that owns an action's checkmark. */
type ConfirmationTarget = 'copy' | 'png' | 'more';

function confirmationTarget(action: ExportAction): ConfirmationTarget {
  if (action === 'copy' || action === 'png') return action;
  // Text copies and SVG saves live in the More menu.
  return 'more';
}

function getAccessibilityMetadata(svg: string | undefined): {
  title?: string;
  description?: string;
} {
  if (!svg) return {};
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) return {};
  const root = parsed.documentElement;
  const directText = (name: 'title' | 'desc'): string | undefined => {
    const value = Array.from(root.children)
      .find((child) => child.localName === name)
      ?.textContent?.trim();
    return value || undefined;
  };
  return { title: directText('title'), description: directText('desc') };
}

/** Snapshot every backdrop; translucent surfaces composite onto their ancestors. */
function surfaceBackground(element: Element): string[] {
  const view = element.ownerDocument.defaultView;
  const colors: string[] = [];
  for (
    let current: Element | null = element;
    current && view;
    current = current.parentElement
  ) {
    colors.push(view.getComputedStyle(current).backgroundColor);
  }
  return colors.reverse();
}

function isKeyboardMenuShortcut(event: ReactKeyboardEvent): boolean {
  return (
    event.key === 'ContextMenu' ||
    (event.key === 'F10' && event.shiftKey && !event.altKey && !event.ctrlKey)
  );
}

function MarkdownMermaidComponent({
  source,
  streaming = false,
  ...props
}: MarkdownMermaidProps): JSX.Element {
  const container = useRef<HTMLElement>(null);
  const diagramArea = useRef<HTMLDivElement>(null);
  const moreAnchor = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [themeRevision, setThemeRevision] = useState(0);
  const completed = useRef<{
    source: string;
    themeRevision: number;
    svg: string;
  } | null>(null);
  const [result, setResult] = useState<DiagramResult | null>(null);
  // Keyed by source so a new diagram always starts with its code collapsed.
  const [codeView, setCodeView] = useState({ source, open: false });
  if (codeView.source !== source) setCodeView({ source, open: false });
  const { clipboard, destination, notify } = useMermaidExport();
  const exportIdentity = JSON.stringify([
    source,
    destination.documentId ?? destination.documentName,
    streaming,
  ]);
  const [exportState, setExportState] = useState<ExportState>({
    identity: exportIdentity,
    pending: null,
    feedback: null,
  });
  if (exportState.identity !== exportIdentity) {
    setExportState({ identity: exportIdentity, pending: null, feedback: null });
  }
  const [heading, setHeading] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    keyboard: boolean;
  } | null>(null);
  const descriptionId = useId();
  const codeId = useId();
  const clipboardReasonId = useId();
  const moreMenuId = useId();
  const plan = useMemo(
    () => (streaming ? null : planMermaidRender(source)),
    [source, streaming],
  );
  const issue = plan?.issue ?? null;
  const family = useMemo(() => mermaidFamilyLabel(source), [source]);
  // Bumped on every source change and unmount so a late export result from
  // an earlier diagram never reaches this one.
  const operation = useRef(0);
  const feedbackId = useRef(0);
  useEffect(() => {
    operation.current += 1;
    return (): void => {
      operation.current += 1;
    };
  }, [exportIdentity]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible(entries.some((entry) => entry.isIntersecting));
      },
      { rootMargin: '300px' },
    );
    observer.observe(element);
    return (): void => observer.disconnect();
  }, []);

  useEffect(() => {
    if (streaming || issue) return;
    const observer = new MutationObserver(() =>
      setThemeRevision((value) => value + 1),
    );
    // Root inline styles can carry semantic token overrides. Body inline styles
    // are interaction state (cursor/user-select), not theme state.
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-brand'],
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'data-brand'],
    });
    return (): void => observer.disconnect();
  }, [streaming, issue]);

  useEffect(() => {
    const element = container.current;
    if (!element || streaming || issue) {
      setResult(null);
      return;
    }
    if (!visible) return;
    if (
      completed.current?.source === source &&
      completed.current.themeRevision === themeRevision
    ) {
      setResult(completed.current);
      return;
    }
    let current = true;
    void import('./markdown-mermaid-renderer')
      .then(async ({ renderMermaid }) => {
        if (!current) return;
        const svg = await renderMermaid(source, element, () => current);
        if (current) {
          completed.current = { source, svg, themeRevision };
          setResult({ source, svg, themeRevision });
        }
      })
      .catch(() => {
        if (current)
          setResult({
            source,
            themeRevision,
            error: MERMAID_RENDER_FAILURE,
          });
      });
    return (): void => {
      current = false;
    };
  }, [source, visible, streaming, issue, themeRevision]);

  const currentResult = !streaming && result?.source === source ? result : null;
  const svg = currentResult?.svg;
  const accessibility = useMemo(() => getAccessibilityMetadata(svg), [svg]);
  const error = streaming ? undefined : (issue ?? currentResult?.error);
  const status =
    error ??
    (svg && plan?.droppedStyling ? MERMAID_DROPPED_STYLING_NOTE : null);
  const codeOpen = codeView.source === source && codeView.open;
  const accessibleName = mermaidAccessibleName(
    accessibility.title,
    family,
    heading,
  );

  // The nearest heading can change while a document is edited or a reply
  // finishes, so follow the enclosing Markdown root rather than the SVG.
  const hasDiagram = Boolean(svg);
  useEffect(() => {
    const element = container.current;
    if (!hasDiagram || !element) return;
    const update = (): void => {
      const next = mermaidDiagramContext(element).heading;
      setHeading((previous) => (previous === next ? previous : next));
    };
    update();
    const root = element.closest(`[${MARKDOWN_ROOT_ATTRIBUTE}]`);
    if (!root || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(update);
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return (): void => observer.disconnect();
  }, [hasDiagram, exportIdentity]);

  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const finish = useCallback(
    (
      ticket: number,
      action: ExportAction,
      feedback: ExportFeedback | null,
    ): void => {
      if (ticket !== operation.current || feedback === null) return;
      feedbackId.current += 1;
      const id = feedbackId.current;
      setExportState((state) => ({
        ...state,
        pending: null,
        feedback: { ...feedback, id, action },
      }));
      if (notifyRef.current)
        notifyFeedback(notifyRef.current, feedback, action);
    },
    [],
  );

  // A success shows a checkmark briefly; the toast carries the words.
  const confirmationId =
    exportState.feedback && exportState.feedback.kind !== 'error'
      ? exportState.feedback.id
      : null;
  useEffect(() => {
    if (confirmationId === null) return;
    const timer = setTimeout(() => {
      setExportState((state) =>
        state.feedback?.id === confirmationId
          ? { ...state, feedback: null }
          : state,
      );
    }, MERMAID_EXPORT_CONFIRMATION_MS);
    return (): void => clearTimeout(timer);
  }, [confirmationId]);

  const failureMessage = async (
    reason: unknown,
    fallback: string,
  ): Promise<string> => {
    const { MermaidExportError } = await import('./markdown-mermaid-export');
    return reason instanceof MermaidExportError ? reason.message : fallback;
  };

  const pending = exportState.pending;
  const canExport =
    Boolean(svg) &&
    currentResult?.themeRevision === themeRevision &&
    pending === null;

  const copyImage = (): void => {
    const element = container.current;
    if (!canExport || !svg || !element) return;
    if (clipboard.status !== 'available') return;
    const ticket = operation.current;
    const ownerDocument = element.ownerDocument;
    const background = surfaceBackground(element);
    const alt = accessibleName;
    setExportState((state) => ({ ...state, pending: 'copy' }));
    const prepared = import('./markdown-mermaid-export').then((module) => ({
      module,
      diagram: module.standaloneMermaidSvg(
        svg,
        module.srgbHexColor(background, ownerDocument),
      ),
    }));
    const png = prepared.then(({ module, diagram }) =>
      module.rasterizeMermaidSvg(diagram, ownerDocument),
    );
    const html = prepared.then(
      ({ module, diagram }) =>
        new Blob([module.mermaidClipboardHtml(diagram, alt)], {
          type: 'text/html',
        }),
    );
    // The clipboard write owns these failures; keep them from also being
    // reported as unhandled when the write rejects first.
    png.catch(() => undefined);
    html.catch(() => undefined);
    // Started synchronously inside the gesture; the item resolves later.
    let write: Promise<void>;
    try {
      write = clipboard.write({ png, html }, ownerDocument);
    } catch (reason: unknown) {
      write = Promise.reject(
        reason instanceof Error ? reason : new Error(COPY_IMAGE_FAILED),
      );
    }
    void write.then(
      () => finish(ticket, 'copy', { kind: 'copied' }),
      async (reason: unknown) =>
        finish(ticket, 'copy', {
          kind: 'error',
          message: await failureMessage(reason, COPY_IMAGE_FAILED),
        }),
    );
  };

  const save = (format: MermaidExportFormat): void => {
    const element = container.current;
    if (!canExport || !svg || !element) return;
    const ticket = operation.current;
    const ownerDocument = element.ownerDocument;
    const background = surfaceBackground(element);
    const context = mermaidDiagramContext(element);
    // Decided before anything is written: a failed save never becomes a
    // download.
    const target = destination;
    const sibling = target.kind === 'sibling' && target.formats[format];
    const stem = mermaidExportStem({
      documentName: target.documentName,
      heading: context.heading,
      index: context.index,
    });
    setExportState((state) => ({ ...state, pending: format }));
    void (async (): Promise<ExportFeedback | null> => {
      const module = await import('./markdown-mermaid-export');
      const diagram = module.standaloneMermaidSvg(
        svg,
        module.srgbHexColor(background, ownerDocument),
      );
      const body =
        format === 'png'
          ? await module.rasterizeMermaidSvg(diagram, ownerDocument)
          : module.svgBlob(diagram);
      // The diagram changed or unmounted while the picture was prepared.
      if (ticket !== operation.current) return null;
      if (sibling && target.kind === 'sibling') {
        for (const filename of mermaidExportFilenames(stem, format)) {
          if (ticket !== operation.current) return null;
          const saved = await target.save({ filename, format, body });
          if (saved.status === 'saved') {
            return {
              kind: 'saved',
              filename: saved.filename,
              open: saved.open,
            };
          }
        }
        return { kind: 'error', message: NAMES_EXHAUSTED };
      }
      downloadBlob(body, `${stem}.${format}`, ownerDocument);
      return { kind: 'download' };
    })().then(
      (feedback) => finish(ticket, format, feedback),
      async (reason: unknown) =>
        finish(ticket, format, {
          kind: 'error',
          message: await failureMessage(reason, SAVE_FAILED),
        }),
    );
  };

  const copyText = (): void => {
    const element = container.current;
    if (!element || pending !== null) return;
    const ticket = operation.current;
    setExportState((state) => ({ ...state, pending: 'text' }));
    void copyTextToClipboard(source, element.ownerDocument).then((copied) =>
      finish(
        ticket,
        'text',
        copied
          ? { kind: 'copied' }
          : { kind: 'error', message: COPY_TEXT_FAILED },
      ),
    );
  };

  const clipboardUnavailable =
    clipboard.status === 'unavailable' ? clipboard.reason : undefined;
  const textToggleLabel = codeOpen ? 'Hide diagram text' : 'Show diagram text';

  const moreItems: DetailMoreMenuItem[] = [
    {
      id: 'toggle-text',
      label: textToggleLabel,
      icon: <CodeIcon size="sm" aria-hidden="true" />,
      testId: 'mermaid-toggle-text',
      onSelect: () => setCodeView({ source, open: !codeOpen }),
    },
    {
      id: 'copy-text',
      label: 'Copy diagram text',
      icon: <CopyIcon size="sm" aria-hidden="true" />,
      testId: 'mermaid-copy-source',
      disabled: pending !== null,
      onSelect: copyText,
    },
    {
      id: 'save-svg',
      label: 'Save as SVG…',
      icon: <FileDownIcon size="sm" aria-hidden="true" />,
      testId: 'mermaid-save-svg',
      disabled: !canExport,
      onSelect: () => save('svg'),
    },
  ];

  const contextItems: TabContextMenuItem[] = [
    {
      key: 'copy-image',
      label: 'Copy image',
      icon: <CopyIcon size="sm" aria-hidden="true" />,
      disabled: !canExport || clipboardUnavailable !== undefined,
      tooltip: clipboardUnavailable,
      testId: 'mermaid-context-copy-image',
      onSelect: copyImage,
    },
    {
      key: 'save-png',
      label: 'Save as picture…',
      icon: <DownloadIcon size="sm" aria-hidden="true" />,
      disabled: !canExport,
      testId: 'mermaid-context-save-png',
      onSelect: () => save('png'),
    },
    {
      key: 'save-svg',
      label: 'Save as SVG…',
      icon: <FileDownIcon size="sm" aria-hidden="true" />,
      disabled: !canExport,
      testId: 'mermaid-context-save-svg',
      onSelect: () => save('svg'),
    },
    {
      key: 'copy-text',
      label: 'Copy diagram text',
      icon: <CodeIcon size="sm" aria-hidden="true" />,
      separatorBefore: true,
      testId: 'mermaid-context-copy-text',
      disabled: pending !== null,
      onSelect: copyText,
    },
  ];

  const openContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    // This surface owns its menu; the message's selection menu yields here.
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, keyboard: false });
  };
  const openContextMenuFromKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    if (!isKeyboardMenuShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenu({
      x: Math.max(0, rect.left),
      y: Math.max(0, rect.top),
      keyboard: true,
    });
  };
  const contextMenuFromKeyboard = contextMenu?.keyboard === true;
  const closeContextMenu = useCallback((): void => {
    setContextMenu(null);
    // A keyboard-opened menu returns focus to the diagram it came from.
    if (contextMenuFromKeyboard) {
      diagramArea.current?.focus({ preventScroll: true });
    }
  }, [contextMenuFromKeyboard]);

  const feedback = exportState.feedback;
  const confirmed: ConfirmationTarget | null =
    feedback && feedback.kind !== 'error'
      ? confirmationTarget(feedback.action)
      : null;
  const actionIcon = (
    target: ConfirmationTarget,
    Icon: AppIcon,
  ): JSX.Element => {
    const Glyph = confirmed === target ? CheckIcon : Icon;
    return (
      <Glyph
        width={14}
        height={14}
        aria-hidden="true"
        data-confirmed={confirmed === target || undefined}
      />
    );
  };
  let errorToggle: string | null = null;
  if (!svg && error) errorToggle = textToggleLabel;
  return (
    <figure
      {...props}
      ref={container}
      data-testid="markdown-mermaid"
      className="not-prose my-3 min-w-0 text-s fg-primary"
    >
      <div
        className="flex select-none flex-wrap items-center justify-end gap-1"
        data-markdown-generated
      >
        {svg ? (
          <>
            {codeOpen && (
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={true}
                onClick={() => setCodeView({ source, open: false })}
                data-testid="mermaid-show-diagram"
              >
                Show diagram
              </Button>
            )}
            <Tooltip
              label={clipboardUnavailable}
              disabled={clipboardUnavailable === undefined}
            >
              <Button
                variant="ghost"
                size="sm"
                aria-disabled={clipboardUnavailable !== undefined || undefined}
                aria-describedby={
                  clipboardUnavailable ? clipboardReasonId : undefined
                }
                disabled={!canExport}
                aria-busy={pending === 'copy' || undefined}
                data-testid="mermaid-copy-image"
                onClick={copyImage}
              >
                {actionIcon('copy', CopyIcon)}
                Copy image
              </Button>
            </Tooltip>
            {clipboardUnavailable && (
              <span id={clipboardReasonId} className="sr-only">
                {clipboardUnavailable}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={!canExport}
              aria-busy={pending === 'png' || undefined}
              data-testid="mermaid-save-png"
              onClick={() => save('png')}
            >
              {actionIcon('png', DownloadIcon)}
              Save as picture…
            </Button>
            <span ref={moreAnchor} className="inline-flex">
              <Tooltip label="More diagram actions" suppressed={moreOpen}>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="More diagram actions"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  aria-controls={moreOpen ? moreMenuId : undefined}
                  data-testid="mermaid-more-actions"
                  onClick={() => setMoreOpen((open) => !open)}
                >
                  {actionIcon('more', MoreHorizontalIcon)}
                </Button>
              </Tooltip>
            </span>
            <FloatingMenu
              id={moreMenuId}
              open={moreOpen}
              onOpenChange={setMoreOpen}
              anchorRef={moreAnchor}
              placement="bottom-right"
              gap={FLOATING_MENU_GAP}
              interaction="menu"
              aria-label="Diagram actions"
              data-testid="mermaid-more-menu"
              className="min-w-44 max-w-64"
            >
              <DetailMoreMenuRows
                items={moreItems}
                onClose={() => setMoreOpen(false)}
              />
            </FloatingMenu>
          </>
        ) : (
          <>
            {errorToggle && (
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={codeOpen}
                aria-controls={codeId}
                onClick={() => setCodeView({ source, open: !codeOpen })}
              >
                {errorToggle}
              </Button>
            )}
            <Tooltip label="Copy">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Copy"
                data-testid="mermaid-copy-source"
                disabled={pending !== null}
                onClick={copyText}
              >
                {actionIcon('more', CopyIcon)}
              </Button>
            </Tooltip>
          </>
        )}
      </div>
      {status && (
        <p
          className="my-2 text-s fg-secondary"
          role="status"
          data-markdown-generated
        >
          {status}
        </p>
      )}
      {/* The host's toast speaks for itself; without one, results are
          announced here without taking up space. */}
      {!notify && (
        <div
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
          data-testid="mermaid-export-status"
          data-markdown-generated
        >
          {feedback && (
            <span key={feedback.id}>
              {feedbackMessage(feedback, feedback.action)}
            </span>
          )}
        </div>
      )}
      {svg && !codeOpen ? (
        <div
          ref={diagramArea}
          className="max-h-128 overflow-auto"
          tabIndex={0}
          aria-label="Diagram scroll area"
          data-owns-context-menu
          onContextMenu={openContextMenu}
          onKeyDown={openContextMenuFromKeyboard}
        >
          <div
            role="img"
            aria-label={accessibleName}
            aria-describedby={
              accessibility.description ? descriptionId : undefined
            }
            className="select-none [&_svg]:h-auto [&_svg]:max-w-none"
            data-markdown-generated
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          {accessibility.description && (
            <span
              id={descriptionId}
              className="sr-only"
              data-markdown-generated
            >
              {accessibility.description}
            </span>
          )}
        </div>
      ) : (
        <pre
          id={codeId}
          hidden={Boolean(error) && !codeOpen}
          className="my-2 max-h-128 overflow-auto rounded-md bg-secondary p-3 font-mono text-s"
        >
          <code>{source}</code>
        </pre>
      )}
      {contextMenu && svg && (
        <TabContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextItems}
          onClose={closeContextMenu}
          ownerDocument={container.current?.ownerDocument}
          focusOnOpen={contextMenu.keyboard}
          dataTestId="mermaid-context-menu"
        />
      )}
    </figure>
  );
}

export const MarkdownMermaid = memo(MarkdownMermaidComponent);
