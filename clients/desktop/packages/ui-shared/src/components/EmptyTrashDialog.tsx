import { Stack } from '../primitives/Stack';
import type { JSX, ReactNode } from 'react';
import { ConfirmDialog } from '../primitives/ConfirmDialog';
import { Surface } from '../primitives/Surface';
import { ArchivedStateIcon } from '../icons/ArchivedStateIcon';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';

export interface EmptyTrashItem {
  readonly id: string;
  readonly name: string;
  readonly trailing?: ReactNode;
}
export interface EmptyTrashDialogProps {
  readonly items: readonly EmptyTrashItem[];
  readonly summary?: ReactNode;
  /** Quiet rows retain a supporting hierarchy alongside disk-size metadata. */
  readonly itemTone?: 'default' | 'quiet';
  /** Workspace targets include every child chat and its retained history. */
  readonly includesWorkspaces?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly busy?: boolean;
}

/**
 * The shared destructive confirmation with the items it deletes listed under
 * the sentence: focus starts on Cancel and the dialog cannot close while busy.
 */
export function EmptyTrashDialog({
  items,
  summary,
  itemTone = 'default',
  includesWorkspaces = false,
  onCancel,
  onConfirm,
  busy = false,
}: EmptyTrashDialogProps): JSX.Element {
  const count = items.length;
  const itemWord = count === 1 ? 'item' : 'items';
  return (
    <ConfirmDialog
      title="Empty trash?"
      message={`This permanently deletes ${count} deleted ${itemWord} and cannot be undone. ${
        includesWorkspaces
          ? 'Selected workspaces include all their chats and retained history, including archived chats. Archived items outside those workspaces are not affected.'
          : 'Archived items are not affected.'
      }`}
      confirmLabel={`Delete ${count} ${itemWord} permanently`}
      destructive
      busy={busy}
      confirmDisabled={count === 0}
      onConfirm={onConfirm}
      onCancel={onCancel}
      dataTestId="archived-overview-empty-trash-dialog"
      confirmTestId="archived-overview-empty-trash-confirm"
      cancelTestId="archived-overview-empty-trash-cancel"
    >
      <Stack gap="item">
        <Surface
          variant="outline"
          data-testid="archived-overview-empty-trash-list"
        >
          <div className="grid max-h-56 grid-cols-1 content-start gap-0.5 overflow-y-auto p-1">
            {items.map((item) => (
              <div
                key={item.id}
                data-testid={`archived-overview-empty-trash-item-${item.id}`}
                className={`flex items-center gap-2 px-2 py-1 text-xs ${itemTone === 'quiet' ? 'fg-primary/80' : 'fg-primary'}`}
              >
                <ArchivedStateIcon state="deleted" size="sm" />
                <span
                  className={`${REPLAY_MASK_CLASS} min-w-0 flex-1 truncate`}
                >
                  {item.name}
                </span>
                {item.trailing}
              </div>
            ))}
          </div>
        </Surface>
        {summary}
      </Stack>
    </ConfirmDialog>
  );
}
