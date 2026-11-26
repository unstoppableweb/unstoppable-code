import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type JSX,
} from 'react';
import { Editor, Transforms, type RangeRef } from 'slate';
import { ReactEditor } from 'slate-react';
import type { ChatEditor } from '@canopy/ui-rich/types';
import { editorDocumentGeneration } from '@canopy/ui-rich/editor';
import type { AgentSecretsChatScope } from '@canopy/desktop-shared/types';
import { AGENT_SECRET_VALUE_MAX_LENGTH } from '@canopy/protocol/agent-secrets';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  findSecretSpans,
  type SecretSpan,
} from '@canopy/protocol/secret-redaction';
import { toAppError } from '@canopy/protocol/app-errors';
import {
  PastedSecretNotice,
  splitPastedSecret,
} from '@canopy/ui-shared/components/chat/PastedSecretNotice';
import { localChatBackend } from '@/stores/chat/backend';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { readRemoteControlContext } from '@/stores/remoteControlStore';

/*
 * The composer's paste guard (agent secret requests U6, mockups §3). Text
 * pasted into a local chat's composer that looks like a secret (the shared
 * `redactSecrets` vocabulary) is held here instead of going into the
 * editor, so it never reaches the draft until the person chooses: "Send
 * anyway" inserts it as typed text; "Send as secret" keeps the value as a
 * chat secret over the local-only IPC and inserts a mention of its name.
 */

interface HeldPaste {
  readonly text: string;
  readonly spans: readonly SecretSpan[];
  /** The chat it was pasted into; a paste never moves to another chat. */
  readonly scopeKey: string;
  /** Tells pastes apart, so a late reply for one never acts on another. */
  readonly id: number;
  /**
   * Where it was pasted, kept current through later edits, so what replaces
   * it goes there and not wherever the cursor is when a save settles.
   */
  readonly at: RangeRef | null;
  /**
   * The editor's document generation when it was pasted: a document replaced
   * since (message history, a restored draft) moves no range, so `at` then
   * no longer means anything.
   */
  readonly generation: number;
}

function scopeKeyOf(scope: AgentSecretsChatScope): string {
  return [scope.projectId, scope.worktreeId, scope.chatId].join('\0');
}

export interface PastedSecretGuard {
  /**
   * Handles a paste: true when it held the text (the event is prevented),
   * false to let the editor insert it.
   */
  readonly interceptPaste: (event: ClipboardEvent<HTMLDivElement>) => boolean;
  /** The notice while a paste is held, else null. */
  readonly notice: JSX.Element | null;
}

const GUARD_FLAG = CLIENT_FEATURE_FLAGS.canopySharedAgentSecretRequests.key;

/**
 * The guard's gate fails closed (CAN-4181 F5): on while the displayed value
 * or main's IPC copy is, so a fresh core false whose stream item lags never
 * lets a paste through unscanned.
 */
export function pastedSecretGuardEnabled(
  state: ReturnType<typeof useFeatureFlagsStore.getState>,
): boolean {
  return (
    state.isEnabled(GUARD_FLAG) || state.ipcSnapshot.values[GUARD_FLAG] === true
  );
}

/**
 * The paste guard for a local chat's composer. `scope` is undefined for
 * cloud chats (U5 keeps their secrets in the cloud) and while no chat is
 * open; the guard is then off, as it is while agent secret requests are.
 */
export function usePastedSecretGuard({
  editor,
  scope,
  readOnly,
  onInserted,
}: {
  readonly editor: ChatEditor;
  readonly scope: AgentSecretsChatScope | undefined;
  readonly readOnly: boolean;
  /** Called after text was inserted, to sync the composer's value. */
  readonly onInserted: () => void;
}): PastedSecretGuard {
  const enabled = useFeatureFlagsStore(pastedSecretGuardEnabled);
  const [held, setHeldState] = useState<HeldPaste | null>(null);
  // The paste held now, for replies that settle after it changed.
  const heldRef = useRef<HeldPaste | null>(null);
  const nextId = useRef(0);
  const setHeld = useCallback(
    (
      next:
        | HeldPaste
        | null
        | ((current: HeldPaste | null) => HeldPaste | null),
    ): void => {
      const value = typeof next === 'function' ? next(heldRef.current) : next;
      // A paste let go of no longer needs its place tracked.
      if (heldRef.current && heldRef.current !== value)
        heldRef.current.at?.unref();
      heldRef.current = value;
      setHeldState(value);
    },
    [],
  );
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const currentKey = scope ? scopeKeyOf(scope) : undefined;

  // The place a held paste tracks is let go with the composer.
  useEffect(
    () => (): void => {
      heldRef.current?.at?.unref();
    },
    [],
  );

  // A held paste belongs to its chat: switching chats drops it.
  useEffect(() => {
    setHeld((current) =>
      current && current.scopeKey === currentKey ? current : null,
    );
    setErrorMessage(undefined);
  }, [currentKey, setHeld]);

  const interceptPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>): boolean => {
      // A window showing another computer can't keep a value there: its
      // store channel never leaves this computer, so the guard stays off.
      if (!enabled || readOnly || !scope) return false;
      if (readRemoteControlContext().mode === 'remote') return false;
      const data = event.clipboardData;
      if (!data || Array.from(data.items).some((i) => i.kind === 'file'))
        return false;
      const text = data.getData('text/plain');
      const spans = findSecretSpans(text);
      if (spans.length === 0) return false;
      event.preventDefault();
      event.stopPropagation();
      setErrorMessage(undefined);
      setBusy(false);
      nextId.current += 1;
      setHeld({
        text,
        spans,
        scopeKey: scopeKeyOf(scope),
        id: nextId.current,
        at: editor.selection ? Editor.rangeRef(editor, editor.selection) : null,
        generation: editorDocumentGeneration(editor),
      });
      return true;
    },
    [editor, enabled, readOnly, scope, setHeld],
  );

  const insert = useCallback(
    (text: string, from: HeldPaste): void => {
      try {
        // Where the paste happened (replacing what it would have replaced),
        // else the end: never a selection made since, which it would erase,
        // nor a place in a document that has been replaced since.
        const at =
          from.generation === editorDocumentGeneration(editor)
            ? from.at?.current
            : undefined;
        Transforms.select(editor, at ?? Editor.end(editor, []));
        Transforms.insertText(editor, text);
        onInserted();
        ReactEditor.focus(editor);
      } catch (error: unknown) {
        // An editor that moved on can't take the text; the paste is dropped
        // rather than kept anywhere. Classified only: it holds no value.
        toAppError(error);
      }
    },
    [editor, onInserted],
  );

  const dismiss = useCallback((): void => {
    setHeld(null);
    setBusy(false);
    setErrorMessage(undefined);
  }, [setHeld]);

  const sendAnyway = useCallback((): void => {
    if (!held) return;
    insert(held.text, held);
    setHeld(null);
  }, [held, insert, setHeld]);

  const sendAsSecret = useCallback(
    (name: string): void => {
      if (!held || !scope || held.scopeKey !== scopeKeyOf(scope)) return;
      const split = splitPastedSecret(held.text, name);
      if (split.value.length > AGENT_SECRET_VALUE_MAX_LENGTH) {
        setErrorMessage(
          `This paste is too long to keep as a secret. Use at most ${AGENT_SECRET_VALUE_MAX_LENGTH.toLocaleString('en-US')} characters.`,
        );
        return;
      }
      setBusy(true);
      setErrorMessage(undefined);
      void localChatBackend()
        .chat.storePastedAgentSecret({
          projectId: scope.projectId,
          worktreeId: scope.worktreeId,
          chatId: scope.chatId,
          name,
          value: split.value,
        })
        .then((response) => {
          // The person dismissed this paste or pasted another meanwhile:
          // the reply acts on nothing that is shown now.
          if (heldRef.current !== held) return;
          if (!response.ok) {
            setErrorMessage(
              response.error ?? "Couldn't keep the secret. Try again.",
            );
            return;
          }
          insert(split.message, held);
          setHeld(null);
        })
        .catch((error: unknown) => {
          // Classified only: the failure never carries the value.
          toAppError(error);
          if (heldRef.current === held)
            setErrorMessage("Couldn't keep the secret. Try again.");
        })
        .finally(() => {
          if (heldRef.current === held || heldRef.current === null)
            setBusy(false);
        });
    },
    [held, insert, scope, setHeld],
  );

  const notice =
    held && held.scopeKey === currentKey ? (
      <PastedSecretNotice
        key={held.id}
        text={held.text}
        spans={held.spans}
        busy={busy}
        {...(errorMessage !== undefined ? { errorMessage } : {})}
        onSendAnyway={sendAnyway}
        onSendAsSecret={sendAsSecret}
        onDismiss={dismiss}
      />
    ) : null;

  return { interceptPaste, notice };
}
