import { setSplitLockKeyResolver } from '../services/split-lock-service';

/**
 * Keys split locks by stable fake keys for a suite whose worktree IDs name no
 * directory on disk (CAN-4730). Main startup installs the real resolver; the
 * E2-G goldens prove canonical keying with real directories.
 */
export function useFakeSplitLockKeys(): void {
  let restore: () => void = () => undefined;
  const fakeKey = (workspaceId: string, worktreeId: string): string =>
    `fake-split-lock-key:${workspaceId}\0${worktreeId}`;
  beforeEach(() => {
    restore = setSplitLockKeyResolver({
      key: (workspaceId, worktreeId) =>
        Promise.resolve(fakeKey(workspaceId, worktreeId)),
      keySync: fakeKey,
    });
  });
  afterEach(() => {
    restore();
  });
}
