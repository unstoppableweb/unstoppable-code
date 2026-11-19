'use client';

import { useCallback, useRef, useState, type JSX } from 'react';
import { RenameDialog } from '@canopy/ui-shared/components';
import { TERMINAL_CUSTOM_NAME_MAX_LENGTH } from '@canopy/protocol/terminal';
import {
  ensureTerminalWorktreeHydrated,
  isUngroupedTerminal,
  selectBucket,
  useTerminalStore,
} from '@canopy/app-state/terminal';

const LOAD_ERROR = "Couldn't load this terminal's saved names. Try again.";
const MISSING_ERROR = 'This terminal is no longer available.';
const UNGROUPED_ERROR = "This terminal's name can't be saved.";

interface TerminalRenameTarget {
  // The scope the dialog opened in, so a worktree switch can't redirect the save.
  readonly projectId: string;
  readonly worktreeId: string;
  readonly terminalId: string;
  readonly initialName: string;
  readonly ownerDocument?: Document;
}

/**
 * Rename state for a terminal tab host, the terminal counterpart of the chat
 * tab rename: `open` captures the terminal, and `dialog` renders the shared
 * rename dialog that saves through the terminal store.
 */
export function useTerminalRename(
  projectId: string,
  worktreeId: string,
): {
  open: (terminalId: string, ownerDocument?: Document) => void;
  dialog: JSX.Element | null;
} {
  const [target, setTarget] = useState<TerminalRenameTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every submit and close, so only the latest submit still open saves.
  const submitId = useRef(0);
  const open = useCallback(
    (terminalId: string, ownerDocument?: Document): void => {
      setError(null);
      setTarget({
        projectId,
        worktreeId,
        terminalId,
        initialName:
          useTerminalStore.getState().terminalCustomNames[terminalId] ?? '',
        ...(ownerDocument ? { ownerDocument } : {}),
      });
    },
    [projectId, worktreeId],
  );
  const close = (): void => {
    submitId.current += 1;
    setTarget(null);
  };
  const dialog =
    target === null ? null : (
      <RenameDialog
        title="Rename terminal"
        label="Terminal name"
        initialValue={target.initialName}
        maxLength={TERMINAL_CUSTOM_NAME_MAX_LENGTH}
        ownerDocument={target.ownerDocument}
        error={error}
        inputTestId="terminal-name-input"
        submitTestId="terminal-name-save"
        onClose={close}
        onSubmit={(draft) => {
          const id = (submitId.current += 1);
          setError(null);
          // Save only after the worktree state loads: an earlier save would
          // overwrite the other terminals' saved names. Not `busy`, so Cancel works.
          void ensureTerminalWorktreeHydrated(
            target.projectId,
            target.worktreeId,
          )
            .then(
              () =>
                selectBucket(
                  useTerminalStore.getState(),
                  target.projectId,
                  target.worktreeId,
                ),
              () => undefined,
            )
            .then((bucket) => {
              if (id !== submitId.current) return;
              if (bucket?.hydrated !== true) {
                setError(LOAD_ERROR);
                return;
              }
              // The store saves names only for the worktree's own terminals.
              if (bucket.sessions[target.terminalId] === undefined) {
                setError(MISSING_ERROR);
                return;
              }
              if (
                isUngroupedTerminal(
                  useTerminalStore.getState(),
                  target.terminalId,
                )
              ) {
                setError(UNGROUPED_ERROR);
                return;
              }
              // An untouched draft may predate the load (blank where a saved
              // name now exists), so it never overwrites the stored name.
              if (draft.trim() !== target.initialName.trim()) {
                useTerminalStore
                  .getState()
                  .setTerminalName(
                    target.projectId,
                    target.worktreeId,
                    target.terminalId,
                    draft.trim() || null,
                  );
              }
              close();
            });
        }}
      />
    );
  return { open, dialog };
}
