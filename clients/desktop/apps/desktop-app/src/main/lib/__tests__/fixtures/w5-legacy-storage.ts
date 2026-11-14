import type * as CoreStorage from '@canopy/core-runtime/storage';

const W5_NAMESPACES = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
];

/** Historical Electron baseline only; production cannot select these rows. */
export function createLegacyW5StorageMock(): object {
  const actual = jest.requireActual<typeof CoreStorage>(
    '@canopy/core-runtime/storage',
  );
  const legacy: CoreStorage.StorageOwnershipRow[] =
    actual.STORAGE_OWNERSHIP.map((row) =>
      W5_NAMESPACES.includes(row.id)
        ? {
            ...row,
            transitionOwner: 'legacy',
            currentWriters: ['electron_main'],
          }
        : row,
    );
  const rows = [...legacy];
  return {
    ...actual,
    STORAGE_OWNERSHIP: rows,
    setDaemonOwnedForTest: (namespaceIds: readonly string[]): void => {
      legacy.forEach((row, index) => {
        rows[index] = namespaceIds.includes(row.id)
          ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
          : row;
      });
    },
  };
}
