'use client';

import { Stack } from '../primitives/Stack';
import {
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from 'react';
import { Fact, FactList } from '../primitives/FactList';
import { Button } from '../primitives/Button';
import { DialogModal } from '../primitives/DialogModal';
import { FormField } from '../primitives/FormField';
import { ListRow } from '../primitives/ListRow';
import { TextInput } from '../primitives/Field';
import { ErrorBanner } from '../primitives/StatusBlocks';

function stopPropagation(event: SyntheticEvent): void {
  event.stopPropagation();
}

/**
 * Keeps a click on the dialog's scrim from reaching the sidebar row that
 * rendered it. The dialog portals to the body, but React still bubbles its
 * events through the row, where a click selects the worktree. The span is
 * hidden and holds nothing in the DOM; the dialog's own nodes live in its
 * portal.
 */
function RowEventBoundary({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span hidden onClick={stopPropagation}>
      {children}
    </span>
  );
}

export interface WorktreeInfoDialogTestIds {
  readonly dialog?: string;
  readonly labelInput?: string;
  readonly save?: string;
}

export interface WorktreeInfoDialogProps {
  readonly mode: 'label' | 'info';
  readonly branch: string;
  readonly worktreeId: string;
  readonly initialLabel?: string;
  readonly onSaveLabel?: (label: string | null) => void | Promise<void>;
  readonly onClose: () => void;
  readonly returnFocusRef?: RefObject<HTMLButtonElement | null>;
  readonly testIds?: WorktreeInfoDialogTestIds;
  /** Early access: the label mode is titled "Rename", as its menu row reads. */
  readonly renameTitle?: boolean;
}

export function WorktreeInfoDialog({
  mode,
  branch,
  worktreeId,
  initialLabel,
  onSaveLabel,
  onClose,
  returnFocusRef,
  testIds,
  renameTitle = false,
}: WorktreeInfoDialogProps): JSX.Element {
  const [label, setLabel] = useState(initialLabel ?? '');
  const [saveError, setSaveError] = useState(false);
  const [saving, setSaving] = useState(false);
  const labelInputId = useId();
  const formId = useId();
  const labelInputRef = useRef<HTMLInputElement | null>(null);
  const close = saving ? (): void => undefined : onClose;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (saving) return;
    setSaveError(false);
    const result = onSaveLabel?.(label.trim() || null);
    if (result instanceof Promise) {
      setSaving(true);
      void result.then(onClose, () => {
        // A rejected save keeps the dialog open with feedback instead of
        // silently emitting an unhandled rejection.
        setSaving(false);
        setSaveError(true);
      });
    } else {
      onClose();
    }
  };
  return (
    <RowEventBoundary>
      <DialogModal
        variant="confirm"
        onClose={close}
        closeOnBackdrop={!saving}
        title={
          mode === 'label'
            ? renameTitle
              ? 'Rename'
              : 'Set label'
            : 'Branch info'
        }
        titleId={`${formId}-title`}
        dataTestId={testIds?.dialog}
        trapFocus
        {...(mode === 'label'
          ? { initialFocusRef: labelInputRef, keepTouchKeyboardClosed: true }
          : {})}
        {...(returnFocusRef ? { restoreFocusRef: returnFocusRef } : {})}
      >
        <form
          id={formId}
          className="flex flex-col gap-5 pt-4"
          onSubmit={submit}
        >
          {mode === 'info' ? (
            <FactList size="s" columnGap="3" rowGap="2" labelTone="secondary">
              <Fact label="Branch" fit="break-all">
                {branch}
              </Fact>
              <Fact label="Worktree" fit="break-all">
                {worktreeId}
              </Fact>
            </FactList>
          ) : (
            <Stack gap="inline">
              <FormField label="Display label" id={labelInputId}>
                <TextInput
                  ref={labelInputRef}
                  id={labelInputId}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder={branch}
                  data-testid={testIds?.labelInput}
                />
              </FormField>
              {saveError && (
                <div>
                  <ErrorBanner
                    errorSource="worktree-info-dialog"
                    className=""
                    error="Failed to save the label. Try again."
                  />
                </div>
              )}
            </Stack>
          )}
          <div className="flex justify-end gap-2">
            <Button size="compact" onClick={close} disabled={saving}>
              Close
            </Button>
            {mode === 'label' && onSaveLabel && (
              <Button
                type="submit"
                variant="primary"
                size="compact"
                disabled={saving}
                aria-busy={saving}
                data-testid={testIds?.save}
              >
                Save
              </Button>
            )}
          </div>
        </form>
      </DialogModal>
    </RowEventBoundary>
  );
}

export interface PipelinePickerEntry {
  readonly id: string;
  readonly name: string;
  readonly disabled?: boolean;
  readonly statusLabel?: string;
}

export interface PipelinePickerDialogTestIds {
  readonly dialog?: string;
  readonly entry?: (id: string) => string;
}

export interface PipelinePickerDialogProps {
  readonly entries: readonly PipelinePickerEntry[];
  readonly onRun: (id: string) => void | Promise<void>;
  readonly onClose: () => void;
  readonly returnFocusRef?: RefObject<HTMLButtonElement | null>;
  readonly testIds?: PipelinePickerDialogTestIds;
  /** Optional notice above the list, such as a synced list's paused state. */
  readonly notice?: ReactNode;
}

export function PipelinePickerDialog({
  entries,
  onRun,
  onClose,
  returnFocusRef,
  testIds,
  notice,
}: PipelinePickerDialogProps): JSX.Element {
  const [running, setRunning] = useState(false);
  const [runFailed, setRunFailed] = useState(false);
  const titleId = useId();
  const close = running ? (): void => undefined : onClose;
  return (
    <RowEventBoundary>
      <DialogModal
        variant="confirm"
        onClose={close}
        closeOnBackdrop={!running}
        title="Dispatch workflow"
        titleId={titleId}
        dataTestId={testIds?.dialog}
        trapFocus
        {...(returnFocusRef ? { restoreFocusRef: returnFocusRef } : {})}
      >
        <div className="flex flex-col gap-4 pt-3">
          {notice}
          {entries.length === 0 && (
            <p className="text-s fg-secondary">No workflows to dispatch.</p>
          )}
          <Stack gap="tight">
            {entries.map((entry) => (
              <ListRow
                key={entry.id}
                disabled={entry.disabled === true || running}
                onClick={() => {
                  setRunFailed(false);
                  const result = onRun(entry.id);
                  if (result instanceof Promise) {
                    setRunning(true);
                    void result.then(onClose, () => {
                      setRunning(false);
                      setRunFailed(true);
                    });
                  } else {
                    onClose();
                  }
                }}
                data-testid={testIds?.entry?.(entry.id)}
                trailing={entry.statusLabel || undefined}
              >
                {entry.name}
              </ListRow>
            ))}
          </Stack>
          {runFailed && (
            <ErrorBanner
              errorSource="pipeline-picker-dialog"
              className=""
              error="Couldn't start the workflow. Try again."
            />
          )}
          <div className="flex justify-end">
            <Button size="compact" onClick={close} disabled={running}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogModal>
    </RowEventBoundary>
  );
}
