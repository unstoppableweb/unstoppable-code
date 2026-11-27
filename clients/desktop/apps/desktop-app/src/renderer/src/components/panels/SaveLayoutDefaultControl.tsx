import { useCallback, useId, useRef, useState, type JSX } from 'react';
import {
  MenuItem,
  MenuItemIcon,
  Menu,
  TitlebarIconButton,
} from '@canopy/ui-shared';
import { ActionMenuRowStyle } from '@canopy/ui-shared/components';
import {
  BoardIcon,
  MoreHorizontalIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { saveCurrentLayoutAsDefault } from '@/lib/panels/default-layout-save';
import { panelSurfaceForWorktreeKey } from '@/lib/panels/panel-surface';
import { makeWorktreePanelKey } from '@/stores/panelLayoutStore';
import { useGitHubStore } from '@/stores/githubStore';

export interface SaveLayoutDefaultControlProps {
  projectId: string;
  worktreeId: string;
}

export function SaveLayoutDefaultControl({
  projectId,
  worktreeId,
}: SaveLayoutDefaultControlProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  const handleSave = useCallback((): void => {
    void (async (): Promise<void> => {
      const worktreeKey = makeWorktreePanelKey(projectId, worktreeId);
      const ok = await saveCurrentLayoutAsDefault(worktreeKey);
      const successMessage =
        panelSurfaceForWorktreeKey(worktreeKey) === 'cowork'
          ? 'Saved current layout as the default for Cowork projects'
          : 'Saved current layout as the default for new worktrees';
      useGitHubStore
        .getState()
        .addToast(
          ok ? successMessage : 'Could not save the default layout',
          ok ? 'success' : 'error',
        );
    })();
  }, [projectId, worktreeId]);

  return (
    <div className="inline-flex">
      <TitlebarIconButton
        ref={triggerRef}
        data-testid="worktree-top-save-layout-default"
        onClick={(): void => setMenuOpen((prev) => !prev)}
        icon={MoreHorizontalIcon}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        aria-label="Layout options"
        title="Layout options"
      />
      <Menu
        id={menuId}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        aria-label="Layout options"
        data-testid="save-layout-default-menu"
        className="w-max max-w-[calc(100vw-16px)]"
      >
        {/* "Reset layout" was removed on review (Tommy): resetting a
            worktree's panel topology is destructive enough that it should
            not sit one mis-click from "Save layout as default". The
            `resetLayoutToDefault` library path survives for the App Advisor
            action. */}
        <ActionMenuRowStyle>
          <MenuItem
            data-testid="save-layout-default-item"
            className="min-w-0"
            onClick={handleSave}
          >
            <MenuItemIcon>
              <BoardIcon />
            </MenuItemIcon>
            <span className="min-w-0 flex-1 truncate whitespace-nowrap">
              Save layout as default
            </span>
          </MenuItem>
        </ActionMenuRowStyle>
      </Menu>
    </div>
  );
}
