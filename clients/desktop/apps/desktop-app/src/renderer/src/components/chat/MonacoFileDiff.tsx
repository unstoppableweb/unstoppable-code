import { DiffEditor } from '@monaco-editor/react';
import { DiffBoundNotice } from '@canopy/ui-shared/components';
import { useEffect, useRef, useState, type JSX } from 'react';
import * as monaco from 'monaco-editor';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type {
  ReviewAnnotation,
  ReviewCommentAnchor,
  ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import { configureMonaco } from '@/lib/monaco-setup';
import { getMonacoLanguage } from './file-language';
import { buildFileEditorDecorations } from './file-comment-markers';
import { normalizeMonacoSelectionEndLine } from './monaco-selection-range';
import type { FileDiffSnapshot } from './useFileDiffSnapshot';

configureMonaco();

export interface MonacoFileDiffProps {
  split: boolean;
  onSplitChange: (split: boolean) => void;
  tabId: string;
  filePath: string;
  snapshot: FileDiffSnapshot;
  threads: ReviewCommentThread[];
  annotations: ReviewAnnotation[];
  onOpenLine: (side: 'old' | 'new', line: number, rect: DOMRect) => void;
  onComment: (anchor: ReviewCommentAnchor, rect: DOMRect) => void;
  reveal?: { anchor: ReviewCommentAnchor; revision: number };
  viewState: {
    current: {
      split: boolean;
      snapshotId?: string;
      editor?: monaco.editor.IDiffEditorViewState | null;
    };
  };
}

export function MonacoFileDiff({
  tabId,
  filePath,
  snapshot,
  threads,
  annotations,
  onOpenLine,
  onComment,
  reveal,
  viewState,
  split,
  onSplitChange,
}: MonacoFileDiffProps): JSX.Element {
  useEffect(() => {
    viewState.current.split = split;
  }, [split, viewState]);
  const [editor, setEditor] =
    useState<monaco.editor.IStandaloneDiffEditor | null>(null);
  useEffect(() => {
    if (!editor) return;
    const save = (): void => {
      viewState.current = {
        split: viewState.current.split,
        snapshotId: snapshot.identity.snapshotId,
        editor: editor.saveViewState(),
      };
    };
    const listeners = [
      editor.getOriginalEditor().onDidScrollChange(save),
      editor.getModifiedEditor().onDidScrollChange(save),
    ];
    return (): void => {
      save();
      listeners.forEach((listener) => listener.dispose());
    };
  }, [editor, snapshot.identity.snapshotId, viewState]);
  const callbacks = useRef({
    onComment,
    onOpenLine,
    threads,
    annotations,
  });
  callbacks.current = {
    onComment,
    onOpenLine,
    threads,
    annotations,
  };
  const [theme, setTheme] = useState(() =>
    document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs',
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(
        document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs',
      ),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return (): void => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!editor) return;
    const disposables: monaco.IDisposable[] = [];
    for (const side of ['old', 'new'] as const) {
      const pane =
        side === 'old'
          ? editor.getOriginalEditor()
          : editor.getModifiedEditor();
      const comment = (): void => {
        const selection = pane.getSelection();
        const model = pane.getModel();
        if (!selection || !model) return;
        const lineStart = selection.startLineNumber;
        const lineEnd = normalizeMonacoSelectionEndLine(
          selection.startLineNumber,
          selection.endLineNumber,
          selection.endColumn,
        );
        const position = pane.getScrolledVisiblePosition({
          lineNumber: lineStart,
          column: 1,
        });
        const bounds = pane.getDomNode()?.getBoundingClientRect();
        if (!bounds) return;
        callbacks.current.onComment(
          {
            source: 'code',
            view: 'diff',
            filePath,
            side,
            lineStart,
            lineEnd,
            quote: Array.from({ length: lineEnd - lineStart + 1 }, (_, i) =>
              model.getLineContent(lineStart + i),
            ).join('\n'),
            diff: snapshot.identity,
          },
          new DOMRect(
            bounds.left + (position?.left ?? 0),
            bounds.top + (position?.top ?? 0),
            1,
            position?.height ?? 20,
          ),
        );
      };
      disposables.push(
        pane.addAction({
          id: `file-diff-comment-${side}`,
          label: `Comment on ${side === 'old' ? 'previous' : 'current'} lines`,
          contextMenuGroupId: 'navigation',
          contextMenuOrder: 1,
          run: comment,
        }),
      );
      disposables.push(
        pane.onMouseUp((event) => {
          const selection = pane.getSelection();
          if (
            event.target.type ===
              monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
            event.target.position
          ) {
            const line = event.target.position.lineNumber;
            const hasItems =
              callbacks.current.annotations.some(
                (a) => a.side === side && a.lineStart === line,
              ) ||
              callbacks.current.threads.some(
                (t) =>
                  t.anchor.side === side &&
                  t.anchor.lineStart === line &&
                  t.status === 'open' &&
                  t.anchorState === 'matched',
              );
            if (hasItems && event.target.element)
              callbacks.current.onOpenLine(
                side,
                line,
                event.target.element.getBoundingClientRect(),
              );
            else {
              pane.setPosition(event.target.position);
              comment();
            }
          } else if (
            selection &&
            !selection.isEmpty() &&
            event.event.leftButton
          )
            comment();
        }),
      );
    }
    return (): void => disposables.forEach((item) => item.dispose());
  }, [editor, filePath, snapshot.identity]);
  useEffect(() => {
    if (!editor) return;
    const collections = (['old', 'new'] as const).map((side) => {
      const pane =
        side === 'old'
          ? editor.getOriginalEditor()
          : editor.getModifiedEditor();
      return pane.createDecorationsCollection(
        buildFileEditorDecorations(
          annotations.filter((annotation) => annotation.side === side),
          threads.filter(
            (thread) =>
              thread.anchor.side === side && thread.anchorState === 'matched',
          ),
          pane.getModel()?.getLineCount() ?? 0,
        ),
      );
    });
    return (): void => collections.forEach((collection) => collection.clear());
  }, [editor, threads, annotations]);
  useEffect(() => {
    if (
      !reveal ||
      !editor ||
      reveal.anchor.diff?.snapshotId !== snapshot.identity.snapshotId
    )
      return;
    if (reveal.anchor.side === 'old') onSplitChange(true);
    const pane =
      reveal.anchor.side === 'old'
        ? editor.getOriginalEditor()
        : editor.getModifiedEditor();
    const frame = requestAnimationFrame(() => {
      pane.revealLineInCenter(reveal.anchor.lineStart ?? 1);
      pane.focus();
    });
    return (): void => cancelAnimationFrame(frame);
  }, [editor, reveal, snapshot.identity.snapshotId, onSplitChange]);
  return (
    <div
      className={`${POSTHOG_REPLAY_BLOCK_CLASS} canopy-monaco-file-editor flex min-h-0 flex-1 flex-col`}
    >
      {snapshot.data.truncated && (
        // The shared notice, worded as on the web (REG-3024).
        <div className="shrink-0 p-2">
          <DiffBoundNotice kind="oversized" className="shrink-0" />
        </div>
      )}
      <DiffEditor
        key={snapshot.identity.snapshotId}
        original={snapshot.data.oldValue}
        modified={snapshot.data.newValue}
        language={getMonacoLanguage(filePath)}
        theme={theme}
        originalModelPath={`canopy-diff://${encodeURIComponent(tabId)}/${snapshot.identity.snapshotId}/old`}
        modifiedModelPath={`canopy-diff://${encodeURIComponent(tabId)}/${snapshot.identity.snapshotId}/new`}
        onMount={(instance) => {
          if (
            viewState.current.snapshotId === snapshot.identity.snapshotId &&
            viewState.current.editor
          )
            instance.restoreViewState(viewState.current.editor);
          // Monaco binds its global hover-delegate factory to the services of
          // the last editor created; these inner editors' services die with the
          // diff, so later suggest, menu or find widgets in any editor throw
          // "InstantiationService has been disposed" (monaco-editor#5518). A
          // plain editor rebinds the factory to the never-disposed root services.
          // The diff editor's own onDidDispose never fires in Monaco 0.55.
          instance
            .getModifiedEditor()
            .onDidDispose(() =>
              monaco.editor.create(document.createElement('div')).dispose(),
            );
          setEditor(instance);
        }}
        options={{
          readOnly: true,
          originalEditable: false,
          renderSideBySide: split,
          useInlineViewWhenSpaceIsLimited: false,
          renderMarginRevertIcon: false,
          renderGutterMenu: false,
          automaticLayout: true,
          glyphMargin: true,
          fontSize: 12,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          hideUnchangedRegions: { enabled: true },
          stickyScroll: { enabled: false },
        }}
      />
    </div>
  );
}
