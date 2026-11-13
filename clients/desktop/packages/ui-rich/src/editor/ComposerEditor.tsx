import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ForwardedRef,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { Descendant } from 'slate';
import {
  defaultChatPlaceholder,
  useIsPhone,
  useMediaQuery,
} from '@canopy/ui-shared';
import type {
  ChatEditor,
  SerializedEditorValue,
  SerializedFileReference,
} from '../types';
import { createEmptyValue } from '../types';
import type { ComposerMenuChannel } from './composer-menu-channel';
import { SlateEditor, type SlateEditorHandle } from './SlateEditor';
import {
  COMPOSER_DENSITY_CLASS_NAMES,
  type ComposerDensity,
} from './composer-density';
import {
  appendFileReference,
  buildEditorValueFromMessage,
  createChatEditor,
  insertTextAtCursor,
  resetEditor,
  restoreEditorContent,
  serializeEditorValue,
} from './slate-utils';
import { useComposerMenu } from './useComposerMenu';

/**
 * Imperative handle for the composer editor. Hosts drive the draft from
 * outside React state (send, queue edits, attachments, commands, voice).
 */
export interface ComposerEditorHandle {
  /** The Slate instance itself, for hosts that still transform it directly. */
  readonly editor: ChatEditor;
  /**
   * Insert plain text at the caret. No host calls it yet: it is the seam the
   * next slice moves desktop's voice dictation and history recall onto.
   */
  insertText: (text: string) => void;
  insertFileReference: (ref: SerializedFileReference) => void;
  reset: () => void;
  replaceDraft: (
    text: string,
    fileReferences?: SerializedFileReference[],
  ) => void;
  focus: () => void;
  serialize: () => SerializedEditorValue;
  /**
   * Insert already-completed slash-command text (e.g. `/review `) at the
   * caret. Used by a Commands popup that picks a command outside the inline
   * `/` typeahead flow, so it inserts the finished text directly.
   */
  insertSlashCommand: (insertText: string) => void;
}

export interface ComposerEditorProps {
  /**
   * A host-owned Slate instance. Omit and the editor creates its own. Desktop
   * passes the instance it also hands to voice dictation and history recall.
   */
  editor?: ChatEditor;
  /**
   * Controlled value. When present, the host owns the draft and receives
   * every change through `onChange`; the editor keeps no draft state of its
   * own. When absent, the editor owns the draft and seeds it from
   * `initialText` / `initialFileReferences`.
   */
  value?: Descendant[];
  onChange?: (value: Descendant[]) => void;
  disabled?: boolean;
  /** See {@link SlateEditorProps.typeToFocus}. */
  typeToFocus?: boolean;
  /**
   * Mount-time draft seed (plain text) for the uncontrolled mode. Used when a
   * host remounts the editor on a destination switch but wants the typed
   * draft preserved. Ignored after mount and in controlled mode.
   */
  initialText?: string;
  /**
   * Serialized file references belonging to {@link initialText}, so preserved
   * drafts keep their mention pills (positions come from each reference's
   * `textStart`). Ignored after mount and in controlled mode.
   */
  initialFileReferences?: SerializedFileReference[];
  placeholder?: string;
  /** Drawn after the placeholder text, such as a key hint. */
  placeholderSuffix?: ReactNode;
  /**
   * Vertical density step (see `COMPOSER_DENSITY_CLASS_NAMES`). Desktop picks
   * a smaller step as its panel gets shorter; web stays comfortable.
   */
  density?: ComposerDensity;
  /** Override the density container classes (e.g. to reserve room for a button). */
  containerClassName?: string;
  /** Placement classes for the editor's outer box within the host layout. */
  className?: string;
  /** Override the density editable classes. */
  editableClassName?: string;
  /** Render the draft in the mono face (desktop terminal mode). */
  monospace?: boolean;
  /** Test hook attached to the editable element. */
  dataTestId?: string;
  /**
   * Host-first key handler. Runs before the typeahead and Enter handling
   * below; a host that consumes a key must call `preventDefault()`.
   */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onSelectionChange?: () => void;
  /**
   * Raw paste handler. When present it replaces the `onPasteFiles` path
   * entirely (desktop reads native file paths off the clipboard items).
   */
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  /**
   * Fired on every editor change with the serialized text. Hosts that want
   * to react to typing state (e.g. enabling/disabling Send) consume this.
   */
  onTextChange?: (text: string) => void;
  /**
   * Fired on every editor change with the serialized file references, so
   * hosts tracking a preservable draft can mirror the pill metadata alongside
   * the text.
   */
  onFileReferencesChange?: (fileReferences: SerializedFileReference[]) => void;
  /**
   * Fired when the user presses Enter (without Shift) on a fine pointer.
   * Omit it and Enter is left to the host's `onKeyDown` (or to Slate).
   */
  onSubmit?: (payload: SerializedEditorValue) => void;
  canSubmit?: (payload: SerializedEditorValue) => boolean;
  /** Forward pasted files to the host attachment pipeline. */
  onPasteFiles?: (files: File[]) => void;
  /**
   * Runs the composer menu session (`/`, `@`, `$` and the `+` toolbar) in
   * the editor and publishes it on `channel` for the host's menu. A host
   * that runs its own session (desktop) omits it.
   */
  composerMenu?: ComposerEditorMenuSession;
}

export interface ComposerEditorMenuSession {
  readonly channel: ComposerMenuChannel;
  /** Whether typed triggers open the menu. */
  readonly enabled: boolean;
  /** Codex's `$` opens the commands menu like `/`. */
  readonly dollar?: boolean;
  /** A new scope closes the session and forgets a dismissed trigger. */
  readonly scopeKey: string;
  /** Commands are listed: `/` opens them, and the placeholder says so. */
  readonly hasCommands: boolean;
  /** Files can be mentioned: `@` opens them, and the placeholder says so. */
  readonly hasFiles: boolean;
}

/**
 * The one chat composer editor both hosts render: the shared Slate editor
 * plus, when the host asks, the composer menu session that `/`, `@` and the
 * `+` share, the density map, the coarse-pointer Enter rule, and the
 * pasted-files hook.
 *
 * Two ownership modes keep both hosts on it. Web lets the editor own the
 * draft (uncontrolled, seeded by `initialText`). Desktop passes its own
 * Slate instance and controls the value, because it also feeds that instance
 * to voice dictation, message-history recall, and external insert events;
 * the raw `editor` on the handle is the escape hatch for those.
 */
function ComposerEditorInner(
  {
    editor: hostEditor,
    value: controlledValue,
    onChange,
    disabled = false,
    typeToFocus,
    initialText,
    initialFileReferences,
    placeholder,
    placeholderSuffix,
    density = 'comfortable',
    containerClassName,
    className,
    editableClassName,
    monospace = false,
    dataTestId,
    onKeyDown,
    onSelectionChange,
    onPaste,
    onTextChange,
    onFileReferencesChange,
    onSubmit,
    canSubmit,
    onPasteFiles,
    composerMenu,
  }: ComposerEditorProps,
  ref: ForwardedRef<ComposerEditorHandle>,
): JSX.Element {
  // The host's instance when it owns one, otherwise one built here once; a
  // host that switches instances gets a fresh fallback, so no cast is needed.
  const editor = useMemo(() => hostEditor ?? createChatEditor(), [hostEditor]);
  const isControlled = controlledValue !== undefined;
  // `initialText`/`initialFileReferences` are a mount-time seed only
  // (preserved drafts across a keyed remount); later prop changes
  // intentionally do not touch the live value.
  const [ownValue, setOwnValue] = useState<Descendant[]>(() =>
    initialText
      ? buildEditorValueFromMessage(initialText, initialFileReferences ?? [])
      : createEmptyValue(),
  );
  const value = isControlled ? controlledValue : ownValue;
  const editorRef = useRef<SlateEditorHandle | null>(null);
  // On touch devices the on-screen keyboard's Return key fires a plain Enter
  // keydown; consuming it as submit made multi-line drafts impossible and
  // sent partial messages (CAN-1987). A coarse primary pointer keeps Enter on
  // Slate's default insertBreak (a line break at the caret) and leaves sending
  // to the explicit Send button. Fine-pointer (desktop keyboard) semantics are
  // unchanged: Enter submits, Shift+Enter inserts the line break.
  const isCoarsePointer = useMediaQuery('(pointer: coarse)');
  // Only the fallback placeholder below reads this; every other treatment in
  // this editor is width-independent.
  const isPhonePlaceholderWidth = useIsPhone();

  /** Publish a new document to whoever owns the draft. */
  const commit = useCallback(
    (next: Descendant[]): void => {
      if (isControlled) {
        onChange?.(next);
      } else {
        setOwnValue(next);
      }
    },
    [isControlled, onChange],
  );

  const resolvedPlaceholder =
    placeholder ??
    defaultChatPlaceholder(
      composerMenu?.hasCommands ?? false,
      composerMenu?.hasFiles ?? false,
      isPhonePlaceholderWidth,
    );

  const publishSerialized = useCallback((): void => {
    const serialized = serializeEditorValue(editor.children);
    onTextChange?.(serialized.text);
    onFileReferencesChange?.(serialized.fileReferences);
  }, [editor, onFileReferencesChange, onTextChange]);

  const handleChange = useCallback(
    (next: Descendant[]): void => {
      commit([...next]);
      const serialized = serializeEditorValue(next);
      onTextChange?.(serialized.text);
      onFileReferencesChange?.(serialized.fileReferences);
    },
    [commit, onFileReferencesChange, onTextChange],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;
      // Enter and Escape that confirm or dismiss an IME candidate belong to
      // the composition, not to typeaheads or submission.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      // The open composer menu takes navigation, selection and Escape.
      if (composerMenu?.channel.getSnapshot()?.handleKeyDown(event)) return;
      if (
        onSubmit !== undefined &&
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.metaKey &&
        !isCoarsePointer
      ) {
        event.preventDefault();
        const payload = serializeEditorValue(editor.children);
        if (!(canSubmit?.(payload) ?? payload.text.trim().length > 0)) return;
        onSubmit(payload);
      }
    },
    [editor, composerMenu, onKeyDown, onSubmit, canSubmit, isCoarsePointer],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>): void => {
      if (onPaste) {
        onPaste(event);
        return;
      }
      const files = Array.from(event.clipboardData.files);
      if (files.length === 0 || onPasteFiles === undefined) return;
      event.preventDefault();
      onPasteFiles(files);
    },
    [onPaste, onPasteFiles],
  );

  useImperativeHandle(
    ref,
    () => ({
      editor,
      insertText: (text: string): void => {
        editorRef.current?.focus();
        insertTextAtCursor(editor, text);
        commit([...editor.children]);
        publishSerialized();
      },
      insertFileReference: (reference: SerializedFileReference): void => {
        editorRef.current?.focus();
        appendFileReference(editor, reference);
        commit([...editor.children]);
        publishSerialized();
      },
      reset: (): void => {
        resetEditor(editor);
        // Commit what the editor actually holds, like every other mutation.
        commit([...editor.children]);
        onTextChange?.('');
        onFileReferencesChange?.([]);
      },
      replaceDraft: (
        text: string,
        fileReferences: SerializedFileReference[] = [],
      ): void => {
        const next = buildEditorValueFromMessage(text, fileReferences);
        restoreEditorContent(editor, next);
        commit([...editor.children]);
      },
      focus: (): void => {
        editorRef.current?.focus();
      },
      serialize: (): SerializedEditorValue =>
        serializeEditorValue(editor.children),
      insertSlashCommand: (insertText: string): void => {
        editorRef.current?.focus();
        insertTextAtCursor(editor, insertText);
        commit([...editor.children]);
        // Same publication as the other inserts: text and file references.
        publishSerialized();
      },
    }),
    [commit, editor, onFileReferencesChange, onTextChange, publishSerialized],
  );

  const densityClasses = COMPOSER_DENSITY_CLASS_NAMES[density];

  return (
    <div
      className={className ? `relative ${className}` : 'relative'}
      aria-disabled={disabled || undefined}
    >
      <SlateEditor
        ref={editorRef}
        editor={editor}
        value={value}
        readOnly={disabled}
        placeholder={resolvedPlaceholder}
        placeholderSuffix={placeholderSuffix}
        onChange={handleChange}
        onSelectionChange={onSelectionChange}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        monospace={monospace}
        containerClassName={containerClassName ?? densityClasses.container}
        editableClassName={editableClassName ?? densityClasses.editable}
        dataTestId={dataTestId}
        typeToFocus={typeToFocus}
      />
      {/* After the editor, so the session's layout effects find its DOM. */}
      {composerMenu ? (
        <ComposerMenuSession
          editor={editor}
          session={composerMenu}
          onChange={(): void => {
            commit([...editor.children]);
            publishSerialized();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Runs the composer menu session beside the editor and publishes it. It
 * renders with the editor on every change, so the session reads the same
 * document and selection snapshot the editor does; it publishes only when
 * the session itself changes (the controller is memoized on its state).
 */
function ComposerMenuSession({
  editor,
  session,
  onChange,
}: {
  editor: ChatEditor;
  session: ComposerEditorMenuSession;
  onChange: () => void;
}): null {
  const controller = useComposerMenu(editor, {
    enabled: session.enabled,
    slash: session.hasCommands,
    at: session.hasFiles,
    dollar: session.dollar ?? false,
    scopeKey: session.scopeKey,
    onChange,
  });
  const { channel } = session;
  useLayoutEffect(() => {
    channel.publish(controller);
  }, [channel, controller]);
  useLayoutEffect(() => (): void => channel.publish(null), [channel]);
  return null;
}

export const ComposerEditor = forwardRef<
  ComposerEditorHandle,
  ComposerEditorProps
>(ComposerEditorInner);
ComposerEditor.displayName = 'ComposerEditor';
