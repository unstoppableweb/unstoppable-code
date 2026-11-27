import { Button } from '@canopy/ui-shared/components';
import { useEffect, useId, useRef, useState, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  Menu,
  type ActionMenuItem,
} from '@canopy/ui-shared/components';
import { ChevronDownIcon } from '@canopy/ui-shared/icons';
import { GitCommitIcon } from '@canopy/ui-shared/icons/AppIcons';
import { DialogModal } from '@/components/shared/DialogModal';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  type BranchFromChoice,
  useBranchFromStore,
} from '@/stores/branchFromStore';

/**
 * The two ways to continue are variants of one choice (what happens to the
 * uncommitted changes), so they share one icon and only the first shows it.
 */
const CONTINUE_MENU_ITEMS: readonly ActionMenuItem<BranchFromChoice>[] = [
  { key: 'commit-first', label: 'Commit first', icon: <GitCommitIcon /> },
  { key: 'do-not-commit', label: 'Do not commit', icon: <GitCommitIcon /> },
];

export function BranchFromConfirmationModalHost(): JSX.Element | null {
  const pending = useBranchFromStore(useShallow((state) => state.pending));
  const resolveConfirmation = useBranchFromStore(
    (state) => state.resolveConfirmation,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    setMenuOpen(false);
  }, [pending]);

  useCurrentUiStateReporter(
    'worktree.branchFromModal',
    pending
      ? {
          open: true,
          confirmationId: pending.confirmationId,
          projectId: pending.projectId,
          worktreeId: pending.worktreeId,
          menuOpen,
        }
      : null,
  );

  if (!pending) return null;

  const choose = (choice: BranchFromChoice): void => {
    setMenuOpen(false);
    resolveConfirmation(choice);
  };

  return (
    <DialogModal
      onClose={() => resolveConfirmation(null)}
      title="Uncommitted changes won't be carried over"
      maxWidth="md"
      dataTestId="branch-from-uncommitted-warning"
    >
      <div className="flex flex-col gap-4">
        <p className="text-s fg-secondary">
          This worktree has uncommitted changes. They will remain here and will
          not be included in the new worktree unless you commit them first.
        </p>
        <div className="flex items-center justify-end gap-2">
          <Button size="compact" onClick={() => resolveConfirmation(null)}>
            Cancel
          </Button>
          <div>
            <Button
              ref={triggerRef}
              variant="primary"
              size="compact"
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? menuId : undefined}
            >
              Continue
              <ChevronDownIcon
                size="sm"
                aria-hidden="true"
                className={
                  menuOpen
                    ? 'rotate-180 transition-transform'
                    : 'transition-transform'
                }
              />
            </Button>
            <Menu
              id={menuId}
              open={menuOpen}
              onOpenChange={setMenuOpen}
              anchorRef={triggerRef}
              placement="top-right"
              interaction="menu"
              outsidePressSwallowsClick={false}
              className="w-40"
            >
              <ActionMenuRowStyle>
                <ActionMenuItems
                  items={CONTINUE_MENU_ITEMS}
                  onSelect={(item): void => choose(item.key)}
                />
              </ActionMenuRowStyle>
            </Menu>
          </div>
        </div>
      </div>
    </DialogModal>
  );
}
