/**
 * A workspace's kind: a single repository, several repositories, or a Cowork
 * folder. Shared with `@canopy/desktop-shared/types`, which re-exports it.
 */
export type WorkspaceType = 'single-repo' | 'multi-repo' | 'cowork';
