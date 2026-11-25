import {
  Editable,
  Slate,
  type RenderElementProps,
  type RenderPlaceholderProps,
} from 'slate-react';
import {
  type ComponentPropsWithoutRef,
  createContext,
  type FocusEvent,
  forwardRef,
  memo,
  useCallback,
  useContext,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type ClipboardEvent,
  type ForwardedRef,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { FileReferencePillElement } from './FileReferencePill';
import type { Descendant, Editor } from 'slate';
import type {
  ChatEditor,
  SerializedEditorValue,
  SerializedFileReference,
} from '../types';
import {
  appendFileReference,
  focusEditor,
  insertTextAtCursor,
  isDetachedSlateDomError,
  serializeEditorValue,
} from './slate-utils';
import { COMPOSER_DENSITY_CLASS_NAMES } from './composer-density';
import { useTypeToComposer } from './type-to-composer';

/**
 * Imperative handle exposed via `ref`. Hosts use this to drive the editor
 * from outside React state (voice dictation, drag/drop, external commands).
 */
export interface SlateEditorHandle {
  /** Insert plain text at the current cursor. */
  insertText: (text: string) => void;
  /** Append a file-reference pill (and trailing space) to the editor. */
  insertFileReference: (reference: SerializedFileReference) => void;
  /** Move focus into the editor. */
  focus: () => void;
  /** Serialize the current editor content into plain text + file references. */
  serialize: () => SerializedEditorValue;
}

export interface SlateEditorProps {
  editor: ChatEditor;
  value: Descendant[];
  placeholder: string;
  /** Drawn after the placeholder text, such as a key hint. */
  placeholderSuffix?: ReactNode;
  onChange: (value: Descendant[]) => void;
  onSelectionChange?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  monospace?: boolean;
  /** When true, the editable renders its content but rejects input. */
  readOnly?: boolean;
  /** Optional override for the outer container's class list. */
  containerClassName?: string;
  /** Optional override for the inner editable's class list. */
  editableClassName?: string;
  /** Test hook attached to the editable element. */
  dataTestId?: string;
  /**
   * Take printable keys pressed anywhere in the document while nothing else
   * wants them. Set on a page's main chat composer, never on form fields.
   */
  typeToFocus?: boolean;
}

export const DEFAULT_CONTAINER_CLASS_NAME =
  COMPOSER_DENSITY_CLASS_NAMES.comfortable.container;
const DEFAULT_EDITABLE_CLASS_NAME =
  COMPOSER_DENSITY_CLASS_NAMES.comfortable.editable;

function renderEditorElement(props: RenderElementProps): JSX.Element {
  if (props.element.type === 'file-reference') {
    return <FileReferencePillElement {...props} />;
  }
  // Each paragraph, not the editable, is the replay block: the draft stays
  // out, while focus and clicks on the editable still count as activity for
  // the recorder. File-reference pills are inline inside a paragraph.
  return (
    <p {...props.attributes} className={`${REPLAY_BLOCK_CLASS} m-0`}>
      {props.children}
    </p>
  );
}

/**
 * Slate removes its editor-to-element weak-map entry during unmount. Chromium
 * can still deliver a blur that was queued before that cleanup, so invoke
 * Slate's handler behind the same narrow stale-mapping guard used by deferred
 * focus. Other editor exceptions continue to surface normally.
 */
const LifecycleSafeEditableElement = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<'div'>
>(function LifecycleSafeEditableElement(
  { onBlur, ...props },
  ref,
): JSX.Element {
  const handleBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>): void => {
      try {
        onBlur?.(event);
      } catch (error) {
        if (!isDetachedSlateDomError(error)) {
          throw error;
        }
      }
    },
    [onBlur],
  );

  return <div {...props} ref={ref} onBlur={handleBlur} />;
});

/**
 * A handler whose identity never changes and that always calls the latest
 * `handler`, so a parent's new closure does not re-render the editable.
 */
function useLatestHandler<Input>(
  handler: ((input: Input) => void) | undefined,
): (input: Input) => void {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  // Slate reads a handler's return value to tell whether it took the event.
  return useCallback((input: Input): void => latest.current?.(input), []);
}

/**
 * What is drawn after the placeholder text. A context, so a new suffix
 * element re-renders the placeholder alone, not the editable around it.
 */
const PlaceholderSuffixContext = createContext<ReactNode>(undefined);

function PlaceholderContent({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const suffix = useContext(PlaceholderSuffixContext);
  return suffix ? (
    // The suffix sits one inline gap after the text, which may wrap.
    <span className="inline-flex max-w-full items-center gap-2">
      <span className="min-w-0">{children}</span>
      {suffix}
    </span>
  ) : (
    <>{children}</>
  );
}

// The placeholder takes the tertiary text token. Slate draws it in the
// editor's own ink at 33% opacity, which is no token and drifts with the
// surface behind it, so its opacity is reset and the token set instead.
// It shows at once, with no fade: the editor remounts on every chat switch,
// and an entry animation blinked the placeholder in each time. Slate draws
// it inside the first paragraph, the replay block, so session replay never
// records it, which matters when it is conversation-derived (a next prompt
// suggestion).
function renderEditorPlaceholder({
  attributes,
  children,
}: RenderPlaceholderProps): JSX.Element {
  return (
    <span
      {...attributes}
      style={{ ...attributes.style, opacity: 1 }}
      className="fg-tertiary"
    >
      <PlaceholderContent>{children}</PlaceholderContent>
    </span>
  );
}

interface EditableSurfaceProps {
  /**
   * The editor's document and selection, only so that a change to either
   * renders the editable. Slate tells the editable about a change itself
   * once its provider has mounted, but a draft restored before that (a chat
   * opening with one) reaches it only through its parent's next render.
   */
  content: Descendant[];
  selection: Editor['selection'];
  placeholder: string;
  readOnly: boolean;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  className: string;
  dataTestId: string | undefined;
}

/**
 * The Slate editable, memoized. After every render while it holds focus,
 * Slate reads the DOM selection, and that read makes the browser lay the
 * whole page out on the spot. The composer's parent re-renders through a
 * streamed reply and every chat or worktree switch, so the editable only
 * renders for its own changes: the editor's content and selection, and the
 * props here.
 */
const EditableSurface = memo(function EditableSurface({
  placeholder,
  readOnly,
  onKeyDown,
  onPaste,
  className,
  dataTestId,
}: EditableSurfaceProps): JSX.Element {
  return (
    <Editable
      as={LifecycleSafeEditableElement}
      data-chat-textarea
      data-testid={dataTestId}
      // The placeholder disappears once text is typed; keep it as the name.
      aria-label={placeholder}
      placeholder={placeholder}
      renderPlaceholder={renderEditorPlaceholder}
      readOnly={readOnly}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      renderElement={renderEditorElement}
      spellCheck={false}
      className={className}
    />
  );
});

function SlateEditorInner(
  {
    editor,
    value,
    placeholder,
    placeholderSuffix,
    onChange,
    onSelectionChange,
    onKeyDown,
    onPaste,
    monospace = false,
    readOnly = false,
    containerClassName,
    editableClassName,
    dataTestId,
    typeToFocus = false,
  }: SlateEditorProps,
  ref: ForwardedRef<SlateEditorHandle>,
): JSX.Element {
  useImperativeHandle(
    ref,
    () => ({
      insertText: (text: string): void => {
        insertTextAtCursor(editor, text);
      },
      insertFileReference: (reference): void => {
        appendFileReference(editor, reference);
      },
      focus: (): void => {
        focusEditor(editor);
      },
      serialize: (): SerializedEditorValue =>
        serializeEditorValue(editor.children),
    }),
    [editor],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const focusThisEditor = useCallback((): void => {
    focusEditor(editor);
  }, [editor]);
  useTypeToComposer(containerRef, focusThisEditor, typeToFocus);

  const handleKeyDown = useLatestHandler(onKeyDown);
  const handlePaste = useLatestHandler(onPaste);

  const handleSelectionChange = useCallback((): void => {
    onSelectionChange?.();
  }, [onSelectionChange]);

  const handleMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('[contenteditable="true"]')) return;
      event.preventDefault();
      focusEditor(editor);
    },
    [editor],
  );

  // Selected text uses the shared muted background token.
  const mergedEditableClassName = useMemo(
    () =>
      `${editableClassName ?? DEFAULT_EDITABLE_CLASS_NAME}${
        monospace ? ' font-mono' : ''
      } selection:bg-muted`,
    [editableClassName, monospace],
  );

  return (
    <div
      ref={containerRef}
      className={containerClassName ?? DEFAULT_CONTAINER_CLASS_NAME}
      onMouseDown={handleMouseDown}
    >
      <Slate
        editor={editor}
        initialValue={value}
        onChange={onChange}
        onSelectionChange={
          onSelectionChange ? handleSelectionChange : undefined
        }
      >
        <PlaceholderSuffixContext.Provider value={placeholderSuffix}>
          <EditableSurface
            content={editor.children}
            selection={editor.selection}
            placeholder={placeholder}
            readOnly={readOnly}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            className={mergedEditableClassName}
            dataTestId={dataTestId}
          />
        </PlaceholderSuffixContext.Provider>
      </Slate>
    </div>
  );
}

export const SlateEditor = forwardRef<SlateEditorHandle, SlateEditorProps>(
  SlateEditorInner,
);
SlateEditor.displayName = 'SlateEditor';
