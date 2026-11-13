import type { JSX } from 'react';
import {
  CHAT_UNIT_LABEL_PLURAL,
  WORKSPACE_LABEL_PLURAL,
} from '@canopy/protocol/ui-labels';
import {
  RailSectionHeader,
  SKELETON_KEEP,
  Skeleton,
  WorkEntryRow,
  WorkspaceSectionHeader,
  WorktreeRow,
} from '@canopy/ui-shared/components';

/** Plain chat titles, as a first load lists them. */
const SAMPLE_CHATS: readonly string[] = [
  'Plan the release notes',
  'Fix the login redirect',
  'Review pricing copy',
];

/** Short project names: the first expanded with its worktrees, the rest collapsed. */
const SAMPLE_PROJECTS: readonly string[] = ['canopy', 'website'];

/** Worktree rows under the expanded project: a branch over its worktree. */
const SAMPLE_WORKTREES: readonly (readonly [string, string])[] = [
  ['fix/login-redirect', 'brave-otter'],
  ['docs/onboarding', 'quiet-heron'],
];

const noop = (): void => undefined;

/**
 * Where the rows show their status, as the sidebar's own rows do: `leading`
 * is the compact sidebar style (a dot in each row's leading slot, chats and
 * worktrees alike), `trailing` the default.
 */
export type SidebarSkeletonRowStatus = 'trailing' | 'leading';

/**
 * The Chats section before the rail's first snapshot: its header as itself
 * and a few chat rows, the shared rows rendered from sample chats inside the
 * measured `Skeleton`.
 */
export function SidebarChatsSkeleton({
  rowStatusPlacement = 'trailing',
}: {
  readonly rowStatusPlacement?: SidebarSkeletonRowStatus;
}): JSX.Element {
  return (
    <Skeleton loading label="Loading chats">
      <RailSectionHeader
        kind="chats"
        label={CHAT_UNIT_LABEL_PLURAL}
        sticky={false}
        {...SKELETON_KEEP}
      />
      <div className="flex flex-col gap-px">
        {SAMPLE_CHATS.map((title) => (
          <WorkEntryRow
            key={title}
            title={title}
            entryId={title}
            testId={`sidebar-skeleton-chat-${title}`}
            statusPlacement={rowStatusPlacement}
          />
        ))}
      </div>
    </Skeleton>
  );
}

/**
 * The Projects list before its first snapshot: the sidebar's own project
 * headers and worktree rows, rendered from sample projects inside the
 * measured `Skeleton`, so the bars sit where the rows will. `header` also
 * draws the Projects header as itself, for a host that has not mounted its
 * own yet. "Loading projects" is announced to assistive technology only.
 */
export function SidebarProjectsSkeleton({
  testId,
  header = false,
  rowStatusPlacement = 'trailing',
}: {
  readonly testId?: string;
  readonly header?: boolean;
  readonly rowStatusPlacement?: SidebarSkeletonRowStatus;
}): JSX.Element {
  return (
    <Skeleton loading label="Loading projects" testId={testId}>
      {header && (
        <RailSectionHeader
          kind="projects"
          label={WORKSPACE_LABEL_PLURAL}
          sticky={false}
          {...SKELETON_KEEP}
        />
      )}
      <div className="flex flex-col gap-1">
        {SAMPLE_PROJECTS.map((name, index) => (
          <div key={name} className="flex flex-col gap-px">
            <WorkspaceSectionHeader
              name={name}
              workspaceType="single-repo"
              worktreeCount={0}
              countPresentation="hidden"
              textScale="sidebar"
              collapsed={index > 0}
              disableDrag
              inlineCollapseChevron
              showCollapseChevron={false}
              onToggleCollapse={noop}
            />
            {index === 0 &&
              SAMPLE_WORKTREES.map(([branch, worktree]) => (
                <WorktreeRow
                  key={branch}
                  branchLabel={branch}
                  worktreeId={worktree}
                  uiStatus="idle"
                  statusModel={
                    rowStatusPlacement === 'leading' ? 'focused' : 'classic'
                  }
                  textScale="sidebar"
                />
              ))}
          </div>
        ))}
      </div>
    </Skeleton>
  );
}

/**
 * The whole rail list before a host has a snapshot to mount the sidebar
 * with: the Chats skeleton, then Projects with its header as itself.
 */
export function SidebarRailSkeleton({
  testId,
  rowStatusPlacement = 'trailing',
}: {
  readonly testId?: string;
  readonly rowStatusPlacement?: SidebarSkeletonRowStatus;
}): JSX.Element {
  return (
    <>
      <SidebarChatsSkeleton rowStatusPlacement={rowStatusPlacement} />
      <div aria-hidden="true" className="h-3" />
      <SidebarProjectsSkeleton
        testId={testId}
        header
        rowStatusPlacement={rowStatusPlacement}
      />
    </>
  );
}
