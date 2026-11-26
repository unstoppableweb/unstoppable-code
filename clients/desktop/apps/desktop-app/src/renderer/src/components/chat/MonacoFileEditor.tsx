import { ControlButton } from '@canopy/ui-shared/components';
import { Badge } from '@canopy/ui-shared/primitives/Badge';
import Editor from '@monaco-editor/react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type * as monaco from 'monaco-editor';
import { CheckIcon } from '@canopy/ui-shared/icons';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { LoadingRegion } from '@canopy/ui-shared/components';
import { configureMonaco } from '@/lib/monaco-setup';
import {
  consumePendingEditorRangeReveal,
  isSendEditorSelectionToChatDetail,
  peekPendingEditorRangeReveal,
  REVEAL_EDITOR_RANGE_EVENT,
  SEND_EDITOR_SELECTION_TO_CHAT_EVENT,
  type RevealEditorRangeDetail,
} from '@/lib/editorSelectionContext';
import { normalizeMonacoSelectionEndLine } from './monaco-selection-range';
import { resolveMonacoEditorOptions } from './monaco-editor-options';
import {
  getEditorScrollPosition,
  saveEditorScrollPosition,
} from '@/lib/tab-scroll-positions';
import type {
  ReviewAnnotation,
  ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import { buildFileEditorDecorations } from './file-comment-markers';
import { Tooltip } from '@canopy/ui-shared';

// Configure Monaco's loader at module evaluation. Since this file is only
// imported via the lazy `EditableFilePanel` boundary, the configure call
// (and the worker imports it pulls in) only runs when an editable file tab
// is opened.
configureMonaco();

/** The precise editor range (1-based, exact columns) of a captured selection. */
export interface EditorSelectionRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

/** The chat tab a captured selection was staged on. */
export interface SelectionCaptureTarget {
  tabId: string;
  title: string;
}

interface MonacoFileEditorProps {
  /** Tab id used to retain scroll position across mount/unmount. */
  tabId: string;
  filePath: string;
  language: string;
  value: string;
  onChange: (value: string) => void;
  revealReady?: boolean;
  presentation?: {
    revision: number;
    line?: number;
    lineEnd?: number;
  };
  annotations?: ReviewAnnotation[];
  commentThreads?: ReviewCommentThread[];
  onSelectionComment?: (selection: FileEditorCommentSelection | null) => void;
  onOpenAnnotation?: (annotationId: string, anchorRect: DOMRect) => void;
  onOpenCommentThread?: (threadId: string, anchorRect: DOMRect) => void;
  /**
   * When provided, the editor context-menu action and ⌘/Ctrl+L hand the exact
   * selection to the chat composer as staged context (CAN-1250). Returns the
   * chat tab the selection was staged on, or `null` when nothing was staged.
   */
  onAddSelectionToChat?: (
    range: EditorSelectionRange,
  ) => SelectionCaptureTarget | null;
  /** Activates the chat tab a confirmation names (composer usually hidden). */
  onShowSelectionTarget?: (tabId: string) => void;
}

export interface FileEditorCommentSelection {
  lineStart: number;
  lineEnd: number;
  quote: string;
  anchorRect: DOMRect;
}

// Monaco's stable MouseTargetType enum value for the glyph margin. Checking
// target.element alone is unreliable because pseudo-elements and overlay
// layers can make the reported element the margin container instead of the
// decoration node carrying our class.
const MONACO_GUTTER_GLYPH_MARGIN_TARGET = 2;
const REVEAL_FLASH_DURATION_MS = 1600;
// Long enough to read the destination and click through to it.
const CAPTURE_CONFIRMATION_DURATION_MS = 4000;

function readIsDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

function isRevealEditorRangeDetail(
  value: unknown,
): value is RevealEditorRangeDetail {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'absolutePath' in value &&
    typeof value.absolutePath === 'string' &&
    'startLine' in value &&
    typeof value.startLine === 'number' &&
    'startColumn' in value &&
    typeof value.startColumn === 'number' &&
    'endLine' in value &&
    typeof value.endLine === 'number' &&
    'endColumn' in value &&
    typeof value.endColumn === 'number'
  );
}

export function MonacoFileEditor({
  tabId,
  filePath,
  language,
  value,
  onChange,
  presentation,
  revealReady = true,
  annotations = [],
  commentThreads = [],
  onSelectionComment,
  onOpenAnnotation,
  onOpenCommentThread,
  onAddSelectionToChat,
  onShowSelectionTarget,
}: MonacoFileEditorProps): JSX.Element {
  const [isDark, setIsDark] = useState(readIsDark);
  const [editorVersion, setEditorVersion] = useState(0);
  const [editorReady, setEditorReady] = useState(false);
  // Transient "Added to Chat" confirmation at the selection's end. The
  // composer is usually hidden behind the same panel leaf as the editor, so a
  // successful capture needs visible feedback with a click-through (View) to
  // the destination chat tab — or the capture reads as a no-op. The target's
  // title survives only in the hover tooltip.
  const [captureConfirmation, setCaptureConfirmation] = useState<{
    top: number;
    left: number;
    target: SelectionCaptureTarget;
  } | null>(null);
  const captureConfirmationTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monaco | null>(null);
  const decorationIdsRef = useRef<string[]>([]);
  const revealedRevisionRef = useRef<number | null>(null);
  const interactionsRef = useRef({
    annotations,
    commentThreads,
    onSelectionComment,
    onOpenAnnotation,
    onOpenCommentThread,
  });
  interactionsRef.current = {
    annotations,
    commentThreads,
    onSelectionComment,
    onOpenAnnotation,
    onOpenCommentThread,
  };
  // The editor instance persists across file switches (the `path` prop swaps
  // models without remounting), so callbacks registered once in `onMount` read
  // the latest prop values through refs instead of stale closures.
  const presentationRef = useRef(presentation);
  presentationRef.current = presentation;
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  const onAddSelectionToChatRef = useRef(onAddSelectionToChat);
  onAddSelectionToChatRef.current = onAddSelectionToChat;
  const onShowSelectionTargetRef = useRef(onShowSelectionTarget);
  onShowSelectionTargetRef.current = onShowSelectionTarget;
  const revealFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const revealFlashDecorationsRef =
    useRef<monaco.editor.IEditorDecorationsCollection | null>(null);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(readIsDark());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return (): void => observer.disconnect();
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    const lineCount = model.getLineCount();
    decorationIdsRef.current = editor.deltaDecorations(
      decorationIdsRef.current,
      buildFileEditorDecorations(annotations, commentThreads, lineCount),
    );
  }, [annotations, commentThreads, editorVersion, value]);

  const clearRevealFlash = useCallback((): void => {
    if (revealFlashTimerRef.current !== null) {
      clearTimeout(revealFlashTimerRef.current);
      revealFlashTimerRef.current = null;
    }
    revealFlashDecorationsRef.current?.clear();
    revealFlashDecorationsRef.current = null;
  }, []);

  const flashRange = useCallback(
    (range: monaco.IRange, isWholeLine: boolean): void => {
      const editor = editorRef.current;
      if (!editor) return;
      clearRevealFlash();
      const decorations = editor.createDecorationsCollection([
        {
          range,
          options: { className: 'canopy-editor-reveal-flash', isWholeLine },
        },
      ]);
      revealFlashDecorationsRef.current = decorations;
      revealFlashTimerRef.current = setTimeout(() => {
        decorations.clear();
        if (revealFlashDecorationsRef.current === decorations) {
          revealFlashDecorationsRef.current = null;
          revealFlashTimerRef.current = null;
        }
      }, REVEAL_FLASH_DURATION_MS);
    },
    [clearRevealFlash],
  );

  // A new request replaces the old range, including a plain-file open. Edits
  // do not clear or replay a presentation. A model switch is a fresh target.
  useEffect(() => {
    revealedRevisionRef.current = null;
    clearRevealFlash();
    return clearRevealFlash;
  }, [clearRevealFlash, filePath, editorVersion, presentation?.revision]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const monacoApi = monacoRef.current;
    if (
      !revealReady ||
      !editorReady ||
      !editor ||
      !model ||
      !monacoApi ||
      model.uri.toString() !== monacoApi.Uri.parse(filePath).toString() ||
      presentation?.line === undefined ||
      revealedRevisionRef.current === presentation.revision
    )
      return;
    // A comparison changes the editor's available height in this commit.
    // Refresh Monaco's geometry before revealing, rather than centering with
    // the previous height until automaticLayout's ResizeObserver catches up.
    editor.layout();
    const lineCount = model.getLineCount();
    const line = Math.min(lineCount, Math.max(1, presentation.line));
    const lineEnd = Math.min(
      lineCount,
      Math.max(line, presentation.lineEnd ?? line),
    );
    revealedRevisionRef.current = presentation.revision;
    if (editor.hasTextFocus()) {
      // Someone is typing: show the range without moving their caret.
      editor.revealLineInCenterIfOutsideViewport(line);
    } else {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
    }
    flashRange(
      {
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: lineEnd,
        endColumn: 1,
      },
      true,
    );
  }, [
    editorReady,
    editorVersion,
    filePath,
    flashRange,
    presentation,
    revealReady,
    value,
  ]);

  const dispatchSelectionToChat =
    useCallback((): SelectionCaptureTarget | null => {
      const editor = editorRef.current;
      const notify = onAddSelectionToChatRef.current;
      if (!editor || !notify) return null;
      const selection = editor.getSelection();
      const model = editor.getModel();
      if (!selection || selection.isEmpty() || !model) return null;
      const text = model.getValueInRange(selection);
      if (!text) return null;
      return notify({
        startLine: selection.startLineNumber,
        startColumn: selection.startColumn,
        endLine: selection.endLineNumber,
        endColumn: selection.endColumn,
        text,
      });
    }, []);

  const confirmCapture = useCallback((target: SelectionCaptureTarget): void => {
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    const dom = editor?.getDomNode();
    if (!editor || !selection || !dom) return;
    const position = editor.getScrolledVisiblePosition(
      selection.getEndPosition(),
    );
    if (!position) return;
    setCaptureConfirmation({
      top: Math.min(position.top + position.height + 6, dom.clientHeight - 30),
      left: Math.max(0, Math.min(position.left, dom.clientWidth - 160)),
      target,
    });
    if (captureConfirmationTimerRef.current !== null) {
      clearTimeout(captureConfirmationTimerRef.current);
    }
    captureConfirmationTimerRef.current = setTimeout(() => {
      setCaptureConfirmation(null);
      captureConfirmationTimerRef.current = null;
    }, CAPTURE_CONFIRMATION_DURATION_MS);
  }, []);

  useEffect(() => {
    return (): void => {
      if (captureConfirmationTimerRef.current !== null) {
        clearTimeout(captureConfirmationTimerRef.current);
        captureConfirmationTimerRef.current = null;
      }
    };
  }, []);

  /**
   * Reveal + flash a captured range. Returns false when the editor is not
   * ready or the model has not (yet) loaded enough lines — the caller then
   * leaves the pending stash in place for the content-ready effect below.
   */
  const tryRevealRange = useCallback(
    (detail: RevealEditorRangeDetail): boolean => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!editor || !model) return false;
      const lineCount = model.getLineCount();
      if (
        detail.startLine < 1 ||
        detail.endLine < detail.startLine ||
        detail.endLine > lineCount ||
        detail.startColumn < 1 ||
        detail.endColumn < 1 ||
        detail.startColumn > model.getLineMaxColumn(detail.startLine) ||
        detail.endColumn > model.getLineMaxColumn(detail.endLine)
      ) {
        return false;
      }
      const range: monaco.IRange = {
        startLineNumber: detail.startLine,
        startColumn: detail.startColumn,
        endLineNumber: detail.endLine,
        endColumn: detail.endColumn,
      };
      editor.revealRangeInCenterIfOutsideViewport(range);
      flashRange(range, false);
      return true;
    },
    [flashRange],
  );

  // Reveal a captured range when its composer chip is focused/clicked.
  // Filtered by file path: every mounted editor hears the document event, but
  // only the one showing that file reacts.
  useEffect(() => {
    const handler = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (
        !isRevealEditorRangeDetail(detail) ||
        detail.absolutePath !== filePathRef.current
      ) {
        return;
      }
      if (tryRevealRange(detail)) {
        consumePendingEditorRangeReveal(detail.absolutePath);
      }
    };
    document.addEventListener(REVEAL_EDITOR_RANGE_EVENT, handler);
    return (): void => {
      document.removeEventListener(REVEAL_EDITOR_RANGE_EVENT, handler);
      if (revealFlashTimerRef.current !== null) {
        clearTimeout(revealFlashTimerRef.current);
        revealFlashTimerRef.current = null;
      }
      revealFlashDecorationsRef.current?.clear();
      revealFlashDecorationsRef.current = null;
    };
  }, [tryRevealRange]);

  // App Advisor dispatches the same selection capture behavior exposed by the
  // context menu and keyboard shortcut. Scope the request to the active
  // file tab so split layouts cannot stage a selection from another editor.
  useEffect(() => {
    const handler = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (
        !isSendEditorSelectionToChatDetail(detail) ||
        detail.tabId !== tabId
      ) {
        return;
      }
      const target = dispatchSelectionToChat();
      if (target) {
        confirmCapture(target);
        detail.markHandled();
      }
    };
    document.addEventListener(SEND_EDITOR_SELECTION_TO_CHAT_EVENT, handler);
    return (): void => {
      document.removeEventListener(
        SEND_EDITOR_SELECTION_TO_CHAT_EVENT,
        handler,
      );
    };
  }, [confirmCapture, dispatchSelectionToChat, tabId]);

  // A reveal requested before this editor existed (chip clicked while the file
  // tab was closed or still loading) is stashed; pick it up once the editor is
  // mounted and the model actually has the file's content.
  useEffect(() => {
    if (!editorReady || value.length === 0) return;
    const pending = peekPendingEditorRangeReveal(filePath);
    if (pending && tryRevealRange(pending)) {
      consumePendingEditorRangeReveal(filePath);
    }
  }, [editorReady, filePath, tryRevealRange, value]);

  const preserveEditorSelection = (
    e: ReactMouseEvent<HTMLButtonElement>,
  ): void => {
    // Prevent the editor from treating this as a click that collapses the
    // selection before the confirmation click is handled.
    e.preventDefault();
    e.stopPropagation();
  };

  const handleConfirmationClick = (
    e: ReactMouseEvent<HTMLButtonElement>,
  ): void => {
    e.preventDefault();
    e.stopPropagation();
    const confirmation = captureConfirmation;
    setCaptureConfirmation(null);
    if (captureConfirmationTimerRef.current !== null) {
      clearTimeout(captureConfirmationTimerRef.current);
      captureConfirmationTimerRef.current = null;
    }
    if (confirmation) {
      onShowSelectionTargetRef.current?.(confirmation.target.tabId);
    }
  };

  return (
    // Blocked from session replay with the file content it edits. Monaco's
    // body-level `.monaco-aria-container` is the recorder's `blockSelector`.
    <div className={`${POSTHOG_REPLAY_BLOCK_CLASS} relative min-h-0 flex-1`}>
      <Editor
        height="100%"
        // `@monaco-editor/react` applies `className` to the editor's container
        // node (`getContainerDomNode()`), which is exactly where Monaco's hover
        // service appends the find-widget button tooltips (`.monaco-hover`). The
        // scoped rule in globals.css uses this class to hide those hover overlays
        // while the pointer is over find-widget controls so they stop flickering
        // over and blocking the toolbar buttons in a narrow editor.
        className="canopy-monaco-file-editor"
        // Stable hook for E2E interaction with the editor surface. The wrapper is
        // the outer container `@monaco-editor/react` spreads these props onto.
        wrapperProps={{ 'data-testid': 'monaco-file-editor' }}
        path={filePath}
        language={language}
        value={value}
        theme={isDark ? 'vs-dark' : 'vs'}
        loading={<LoadingRegion layout="fill" />}
        onChange={(next) => onChange(next ?? '')}
        onMount={(editor, monacoApi: typeof monaco) => {
          editorRef.current = editor;
          monacoRef.current = monacoApi;
          const modelListener = editor.onDidChangeModel(() => {
            clearRevealFlash();
            revealedRevisionRef.current = null;
            decorationIdsRef.current = [];
            setEditorVersion((current) => current + 1);
          });
          setEditorVersion((current) => current + 1);
          setEditorReady(true);
          // Cmd/Ctrl+S is owned solely by the window-level global shortcut so a
          // single keypress cannot reach two save handlers (CAN-1426). Monaco no
          // longer registers its own save command here.

          // Restore prior scroll position for this tab. Monaco lays out
          // asynchronously after content is set, so defer one frame so
          // setScrollTop/setScrollLeft are not clamped against a stale
          // scroll height.
          let disposed = false;
          let restoreFrameId: number | null = null;
          editor.onDidDispose(() => {
            disposed = true;
            modelListener.dispose();
            clearRevealFlash();
            editorRef.current = null;
            decorationIdsRef.current = [];
            revealedRevisionRef.current = null;
            if (restoreFrameId !== null) {
              cancelAnimationFrame(restoreFrameId);
              restoreFrameId = null;
            }
          });

          editor.onMouseUp(() => {
            const callback = interactionsRef.current.onSelectionComment;
            const model = editor.getModel();
            const selection = editor.getSelection();
            if (!callback || !model || !selection || selection.isEmpty()) {
              callback?.(null);
              return;
            }
            const startLine = selection.startLineNumber;
            const endLine = normalizeMonacoSelectionEndLine(
              startLine,
              selection.endLineNumber,
              selection.endColumn,
            );
            const visible = editor.getScrolledVisiblePosition({
              lineNumber: endLine,
              column: selection.endColumn,
            });
            const node = editor.getDomNode();
            if (!visible || !node) return;
            const rect = node.getBoundingClientRect();
            callback({
              lineStart: startLine,
              lineEnd: endLine,
              quote: model.getValueInRange(selection),
              anchorRect: new DOMRect(
                rect.left + visible.left,
                rect.top + visible.top,
                12,
                visible.height,
              ),
            });
          });

          editor.onMouseDown((event) => {
            const element = event.target.element;
            const line =
              event.target.position?.lineNumber ??
              event.target.range?.startLineNumber;
            const clickedGlyphMargin =
              Number(event.target.type) === MONACO_GUTTER_GLYPH_MARGIN_TARGET;
            const clickedKnownGlyph = element?.closest(
              '.canopy-file-comment-glyph, .canopy-file-annotation-glyph',
            );
            if (
              line === undefined ||
              (!clickedGlyphMargin && !clickedKnownGlyph)
            ) {
              return;
            }
            const current = interactionsRef.current;
            const annotation = current.annotations.find(
              (entry) => entry.lineStart === line,
            );
            const thread = current.commentThreads.find(
              (entry) =>
                (annotation && entry.anchor.annotationId === annotation.id) ||
                (!entry.anchor.annotationId && entry.anchor.lineStart === line),
            );
            if (!annotation && !thread) return;
            event.event.preventDefault();
            event.event.stopPropagation();
            const visible = editor.getScrolledVisiblePosition({
              lineNumber: line,
              column: 1,
            });
            const node = editor.getDomNode();
            if (!visible || !node) return;
            const rect = node.getBoundingClientRect();
            const anchorRect = new DOMRect(
              rect.left + visible.left,
              rect.top + visible.top,
              16,
              visible.height,
            );
            if (annotation) {
              current.onOpenAnnotation?.(annotation.id, anchorRect);
            } else if (thread) {
              current.onOpenCommentThread?.(thread.id, anchorRect);
            }
          });

          const saved = getEditorScrollPosition(tabId);
          if (saved && presentation?.line === undefined) {
            restoreFrameId = requestAnimationFrame(() => {
              restoreFrameId = null;
              if (disposed || presentationRef.current?.line !== undefined)
                return;
              editor.setScrollTop(saved.top);
              editor.setScrollLeft(saved.left);
            });
          }

          editor.onDidScrollChange((e) => {
            saveEditorScrollPosition(tabId, {
              top: e.scrollTop,
              left: e.scrollLeft,
            });
          });

          // Selection → composer capture (CAN-1250): a context-menu action that
          // also owns the ⌘/Ctrl+L keybinding, matching the terminal pane's
          // "Send to Chat" shortcut. The normal mouse flow is owned by the
          // completed-selection menu emitted from `onMouseUp` above.
          editor.addAction({
            id: 'canopy.sendSelectionToChat',
            label: 'Send selection to chat',
            contextMenuGroupId: '9_cutcopypaste',
            contextMenuOrder: 10,
            keybindings: [monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyL],
            precondition: 'editorHasSelection',
            run: () => {
              const target = dispatchSelectionToChat();
              if (target) {
                confirmCapture(target);
              }
            },
          });

          // Monaco renders the find-widget button tooltips as an overlay that
          // sits on top of the toolbar in a narrow editor, which globals.css
          // hides. Mirror each control's `aria-label` onto a native `title` so
          // hovering shows a standard browser tooltip positioned by the cursor
          // instead — it never overlaps or blocks the buttons. Applied lazily on
          // first hover (delegated, capture phase) so we don't have to observe
          // the lazily-created find widget.
          const rootNode = editor.getDomNode();
          const applyNativeTitle = (event: MouseEvent): void => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const control = target.closest<HTMLElement>(
              '.find-widget .button, .find-widget .monaco-custom-toggle',
            );
            if (!control) return;
            const label = control.getAttribute('aria-label');
            if (label && control.getAttribute('title') !== label) {
              control.setAttribute('title', label);
            }
          };
          rootNode?.addEventListener('mouseover', applyNativeTitle, true);
          editor.onDidDispose(() => {
            rootNode?.removeEventListener('mouseover', applyNativeTitle, true);
          });
        }}
        options={resolveMonacoEditorOptions(language)}
      />
      {captureConfirmation !== null && (
        // The positioned span (not the tooltip wrapper, which is `relative`)
        // anchors the chip at the captured selection.
        <span
          className="absolute z-20"
          style={{
            top: captureConfirmation.top,
            left: captureConfirmation.left,
          }}
        >
          <Tooltip
            label={`Open ${captureConfirmation.target.title} to see the staged selection`}
          >
            <ControlButton
              type="button"
              data-testid="editor-selection-added-confirmation"
              onMouseDown={preserveEditorSelection}
              onClick={handleConfirmationClick}
              presentation="editor-selection-confirmation"
            >
              <CheckIcon size="sm" />
              <span>Added to chat</span>
              <Badge>View</Badge>
            </ControlButton>
          </Tooltip>
        </span>
      )}
    </div>
  );
}
