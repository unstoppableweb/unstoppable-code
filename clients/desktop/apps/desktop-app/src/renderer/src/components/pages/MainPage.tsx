import { memo, type JSX } from 'react';
import { WorktreeManager } from '../worktree/WorktreeManager';

/**
 * The worktree page stays mounted under every other page. It takes no props
 * and the worktree manager reads its own state, so a render of the app root
 * (a palette opening, the sidebar being resized or previewed) stops here
 * instead of running through the manager and its panels.
 */
export const MainPage = memo(function MainPage(): JSX.Element {
  return (
    <div data-testid="page-main" className="h-full">
      <WorktreeManager />
    </div>
  );
});
