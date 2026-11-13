import {
  Editable,
  Slate,
  type RenderElementProps,
  type RenderPlaceholderProps,
} from 'slate-react';
import {
  type ComponentPropsWithoutRef,
  type FocusEvent,
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  type ClipboardEvent,
  type ForwardedRef,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { FileReferencePillElement } from './FileReferencePill';
import type { Descendant } from 'slate';
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

function SlateEditorInner(
  {
    editor,
    value,
    placeholder,
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

  const renderElement = useCallback(renderEditorElement, []);

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

  // The placeholder takes the tertiary text token. Slate draws it in the
  // editor's own ink at 33% opacity, which is no token and drifts with the
  // surface behind it, so its opacity is reset and the token set instead.
  // It shows at once, with no fade: the editor remounts on every chat switch,
  // and an entry animation blinked the placeholder in each time.
  const renderPlaceholder = useCallback(
    ({ attributes, children }: RenderPlaceholderProps): JSX.Element => (
      <span
        {...attributes}
        style={{ ...attributes.style, opacity: 1 }}
        className="fg-tertiary"
      >
        {children}
      </span>
    ),
    [],
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
        <Editable
          as={LifecycleSafeEditableElement}
          data-chat-textarea
          data-testid={dataTestId}
          placeholder={placeholder}
          renderPlaceholder={renderPlaceholder}
          readOnly={readOnly}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          renderElement={renderElement}
          spellCheck={false}
          className={mergedEditableClassName}
        />
      </Slate>
    </div>
  );
}

export const SlateEditor = forwardRef<SlateEditorHandle, SlateEditorProps>(
  SlateEditorInner,
);
SlateEditor.displayName = 'SlateEditor';
