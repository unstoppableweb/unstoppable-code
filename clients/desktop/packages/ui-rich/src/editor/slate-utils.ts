import {
  Editor,
  createEditor,
  Element as SlateElement,
  Range,
  Transforms,
  type Descendant,
} from 'slate';
import { withHistory } from 'slate-history';
import { ReactEditor, withReact } from 'slate-react';
import {
  createEmptyValue,
  type ChatEditor,
  type CustomText,
  type FileReferenceElement,
  type SerializedEditorValue,
  type SerializedFileReference,
} from '../types';

function withFileReferences(editor: ChatEditor): ChatEditor {
  const { isInline, isVoid } = editor;

  editor.isInline = (element): boolean =>
    element.type === 'file-reference' ? true : isInline(element);
  editor.isVoid = (element): boolean =>
    element.type === 'file-reference' ? true : isVoid(element);

  return editor;
}

export function createChatEditor(): ChatEditor {
  return withFileReferences(withHistory(withReact(createEditor())));
}

/**
 * How many times each editor's whole document was replaced outside Slate's
 * operations (`resetEditor`, `restoreEditorContent`). Those replacements do
 * not move range refs, so a holder of one (the composer menu's held pick)
 * compares generations before trusting its paths.
 */
const documentGenerations = new WeakMap<ChatEditor, number>();

/** The editor's document generation; see `documentGenerations`. */
export function editorDocumentGeneration(editor: ChatEditor): number {
  return documentGenerations.get(editor) ?? 0;
}

function replaceDocument(editor: ChatEditor, children: Descendant[]): void {
  documentGenerations.set(editor, editorDocumentGeneration(editor) + 1);
  editor.children = children;
}

export function resetEditor(editor: ChatEditor): void {
  replaceDocument(editor, createEmptyValue());
  editor.selection = {
    anchor: { path: [0, 0], offset: 0 },
    focus: { path: [0, 0], offset: 0 },
  };
  editor.history = { undos: [], redos: [] };
  editor.onChange();
}

export function restoreEditorContent(
  editor: ChatEditor,
  content: Descendant[],
): void {
  replaceDocument(editor, structuredClone(content));
  const point = Editor.end(editor, []);
  editor.selection = { anchor: point, focus: point };
  editor.history = { undos: [], redos: [] };
  editor.onChange();
}

export function serializeEditorValue(
  value: Descendant[],
): SerializedEditorValue {
  const fileReferences: SerializedFileReference[] = [];
  let textOffset = 0;

  const serializeNode = (node: Descendant): string => {
    if (SlateElement.isElement(node)) {
      if (node.type === 'file-reference') {
        fileReferences.push({
          displayPath: node.displayPath,
          absolutePath: node.absolutePath,
          ...(node.repoName ? { repoName: node.repoName } : {}),
          ...(node.kind !== undefined ? { kind: node.kind } : {}),
          textStart: textOffset,
        });
        textOffset += node.displayPath.length;
        return node.displayPath;
      }
      return node.children.map(serializeNode).join('');
    }

    textOffset += node.text.length;
    return node.text;
  };

  const serializedLines = value.map((node, index) => {
    if (index > 0) textOffset += 1;
    return serializeNode(node);
  });

  return {
    text: serializedLines.join('\n'),
    fileReferences,
  };
}

export function focusEditor(editor: ChatEditor): void {
  try {
    if (!editor.selection) {
      const point = Editor.end(editor, []);
      editor.selection = { anchor: point, focus: point };
    }
    // Slate can ignore blur while a selection update is pending. A picker
    // then owns DOM focus while Slate still reports the editor as focused,
    // causing ReactEditor.focus to return early. Reconcile before restoring.
    if (ReactEditor.isFocused(editor)) {
      const element = ReactEditor.toDOMNode(editor, editor);
      if (element.ownerDocument.activeElement !== element) {
        ReactEditor.blur(editor);
      }
    }
    ReactEditor.focus(editor);
  } catch (error) {
    // A requestAnimationFrame focus can race a React remount: the editor
    // object is still alive while Slate's weak DOM mapping has already been
    // detached. Focus is best-effort in that narrow window; the replacement
    // composer will run its own focus effect. Preserve every other exception.
    if (!isDetachedSlateDomError(error)) {
      throw error;
    }
  }
}

export function isDetachedSlateDomError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.message.includes('Cannot resolve a DOM node from Slate node')
  );
}

/**
 * Reverse of {@link serializeEditorValue}: rebuild a Descendant tree from a
 * plain text body and a list of file references whose `displayPath` strings
 * appear inline within the text. Each serialized reference occurrence is
 * converted back into a pill so editing pre-populated content keeps the same
 * visual affordances as the original composer.
 */
export function buildEditorValueFromMessage(
  text: string,
  fileReferences: readonly SerializedFileReference[],
): Descendant[] {
  if (text === '' && fileReferences.length === 0) {
    return createEmptyValue();
  }

  const positionedRefs = fileReferences
    .filter(
      (ref): ref is SerializedFileReference & { textStart: number } =>
        ref.textStart !== undefined &&
        text.slice(ref.textStart, ref.textStart + ref.displayPath.length) ===
          ref.displayPath,
    )
    .slice()
    .sort((a, b) => a.textStart - b.textStart);
  const positionsAreExact =
    positionedRefs.length === fileReferences.length &&
    positionedRefs.every(
      (ref, index) =>
        index === 0 ||
        ref.textStart >=
          positionedRefs[index - 1].textStart +
            positionedRefs[index - 1].displayPath.length,
    );

  if (positionsAreExact) {
    let lineStart = 0;
    return text.split('\n').map((line) => {
      const children: (CustomText | FileReferenceElement)[] = [];
      let cursor = 0;
      for (const ref of positionedRefs) {
        if (
          ref.textStart < lineStart ||
          ref.textStart >= lineStart + line.length
        ) {
          continue;
        }
        const localStart = ref.textStart - lineStart;
        if (localStart > cursor) {
          children.push({ text: line.slice(cursor, localStart) });
        }
        children.push({
          type: 'file-reference',
          displayPath: ref.displayPath,
          absolutePath: ref.absolutePath,
          ...(ref.repoName ? { repoName: ref.repoName } : {}),
          ...(ref.kind !== undefined ? { kind: ref.kind } : {}),
          children: [{ text: '' }],
        });
        cursor = localStart + ref.displayPath.length;
      }
      if (cursor < line.length) children.push({ text: line.slice(cursor) });
      if (children.length === 0) children.push({ text: '' });
      lineStart += line.length + 1;
      return { type: 'paragraph' as const, children };
    });
  }

  const remainingRefs = new Map<string, SerializedFileReference[]>();
  for (const ref of fileReferences) {
    const refs = remainingRefs.get(ref.displayPath);
    if (refs) {
      refs.push(ref);
    } else {
      remainingRefs.set(ref.displayPath, [ref]);
    }
  }

  const lines = text.split('\n');
  return lines.map((line) => {
    const children: (CustomText | FileReferenceElement)[] = [];
    let cursor = 0;

    while (cursor <= line.length) {
      let bestIdx = -1;
      let bestPath = '';
      let bestRef: SerializedFileReference | undefined;
      const entries = Array.from(remainingRefs.entries());
      for (const [path, refs] of entries) {
        const ref = refs[0];
        if (!ref) continue;
        const idx = line.indexOf(path, cursor);
        if (idx >= 0 && (bestIdx === -1 || idx < bestIdx)) {
          bestIdx = idx;
          bestPath = path;
          bestRef = ref;
        }
      }

      if (bestIdx === -1 || bestRef === undefined) {
        if (cursor < line.length) {
          children.push({ text: line.slice(cursor) });
        }
        break;
      }

      if (bestIdx > cursor) {
        children.push({ text: line.slice(cursor, bestIdx) });
      }
      children.push({
        type: 'file-reference',
        displayPath: bestRef.displayPath,
        absolutePath: bestRef.absolutePath,
        ...(bestRef.repoName ? { repoName: bestRef.repoName } : {}),
        ...(bestRef.kind !== undefined ? { kind: bestRef.kind } : {}),
        children: [{ text: '' }],
      });
      cursor = bestIdx + bestPath.length;
      const refs = remainingRefs.get(bestPath);
      if (!refs || refs.length <= 1) {
        remainingRefs.delete(bestPath);
      } else {
        remainingRefs.set(bestPath, refs.slice(1));
      }
    }

    if (children.length === 0) {
      children.push({ text: '' });
    }
    return { type: 'paragraph' as const, children };
  });
}

/** Insert text at the current cursor, collapsing any selection first. */
export function insertTextAtCursor(editor: ChatEditor, text: string): void {
  if (!text) return;
  Transforms.insertText(editor, text);
}

/**
 * Insert a `FileReferenceElement` pill at the end of the editor and follow it
 * with a trailing space. Used by hosts to inject pills from external surfaces
 * (e.g. drag-drop, contextual menus).
 */
export function appendFileReference(
  editor: ChatEditor,
  reference: SerializedFileReference,
): void {
  const end = Editor.end(editor, []);
  Transforms.select(editor, end);

  const node: FileReferenceElement = {
    type: 'file-reference',
    displayPath: reference.displayPath,
    absolutePath: reference.absolutePath,
    ...(reference.repoName ? { repoName: reference.repoName } : {}),
    ...(reference.kind !== undefined ? { kind: reference.kind } : {}),
    children: [{ text: '' }],
  };
  Transforms.insertNodes(editor, node);
  Transforms.move(editor);
  Transforms.insertText(editor, ' ');
}

/**
 * Replace the text between `anchor` and `focus` with `text`, returning the new
 * range that covers the inserted text. Pass the returned range into the next
 * `replaceInterimRange` call so the interim transcript stays anchored while
 * recognition refines the result.
 */
export function replaceInterimRange(
  editor: ChatEditor,
  previousRange: Range | null,
  text: string,
): Range | null {
  const start = previousRange ? Range.start(previousRange) : null;
  if (previousRange) {
    Transforms.select(editor, previousRange);
    Transforms.delete(editor);
  }
  if (!text) {
    return start
      ? { anchor: start, focus: start }
      : editor.selection
        ? {
            anchor: Range.start(editor.selection),
            focus: Range.start(editor.selection),
          }
        : null;
  }
  const anchorBeforeInsert =
    start ?? (editor.selection ? Range.start(editor.selection) : null);
  Transforms.insertText(editor, text);
  const focusAfterInsert = editor.selection
    ? Range.end(editor.selection)
    : null;
  if (!anchorBeforeInsert || !focusAfterInsert) {
    return null;
  }
  return { anchor: anchorBeforeInsert, focus: focusAfterInsert };
}
