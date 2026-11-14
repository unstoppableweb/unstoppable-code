import type { CanopyCapabilities } from '@canopy/app-core';

/**
 * Neutral activity-section identity, ordering, and capability gating for the
 * shared activity store.
 *
 * Mirrors `@canopy/desktop-shared`'s `ActivitySectionId` union and
 * `DEFAULT_ACTIVITY_SECTION_ORDER` / `resolveActivitySectionOrder`, which are
 * forbidden imports for `@canopy/app-state`. Desktop-only ids remain opaque here
 * and are preserved by the resolver for cross-client round trips.
 */

/**
 * The Code-tab activity sections, in canonical (default) order.
 * Keep this union in sync with `@canopy/desktop-shared`'s
 * `ActivitySectionId`; package boundaries prevent sharing it directly.
 */
export type ActivitySectionId =
  | 'summary'
  | 'changed-files'
  | 'pull-request'
  | 'background-processes'
  | 'plans'
  | 'pipeline-runs'
  | 'cost'
  | 'scripts'
  | 'hooks'
  | 'terminals'
  | 'todo'
  | 'mcp-servers';

/** Default section order (mirrors the desktop `DEFAULT_ACTIVITY_SECTION_ORDER`). */
export const DEFAULT_ACTIVITY_SECTION_ORDER: readonly ActivitySectionId[] = [
  'summary',
  'changed-files',
  'pull-request',
  'background-processes',
  'mcp-servers',
  'plans',
  'pipeline-runs',
  'cost',
  'scripts',
  'hooks',
  'terminals',
  'todo',
];

const VALID_SECTION_IDS: ReadonlySet<string> = new Set(
  DEFAULT_ACTIVITY_SECTION_ORDER,
);

/** Narrow an arbitrary string to a known {@link ActivitySectionId}. */
export function isActivitySectionId(value: string): value is ActivitySectionId {
  return VALID_SECTION_IDS.has(value);
}

/**
 * Workspace classification, mirroring the portal protocol's
 * `PortalSessionShellState.workspaces[].type`. PURE CLASSIFICATION — what the
 * workspace IS, never how it lays out.
 */
export type ActivityWorkspaceType = 'single-repo' | 'multi-repo' | 'cowork';

/**
 * THE single definition of which activity sections require a repository behind
 * them. Every one of these reads git state a repoless workspace cannot have —
 * a working tree diff, a pull request, a plan file in a checkout, or the
 * worktree scripts/hooks that run against one — so they are structurally empty
 * and their controls can only fail there.
 *
 * Desktop reads this through its `getActivitySectionsForSurface` registry
 * lookup and web through {@link isActivitySectionVisibleForWorkspaceType}, so
 * neither host keeps a second copy of the list.
 */
export const CODE_ONLY_ACTIVITY_SECTION_IDS: readonly ActivitySectionId[] = [
  'changed-files',
  'pull-request',
  'plans',
  'scripts',
  'hooks',
];

const CODE_ONLY_SECTION_ID_SET: ReadonlySet<string> = new Set(
  CODE_ONLY_ACTIVITY_SECTION_IDS,
);

/**
 * Whether a section requires a repo-backed workspace. Ids owned by another
 * client (desktop's `notes`/`prompts`/`attachments`) are repo-independent and
 * answer `false`.
 */
export function isCodeOnlyActivitySection(sectionId: string): boolean {
  return CODE_ONLY_SECTION_ID_SET.has(sectionId);
}

/**
 * Whether a section renders at all for a workspace of this type. `'cowork'` is
 * the portal protocol's repoless classification (cloud-backed cowork included,
 * which lays out as a tree), so it drops the code-only set; every other type —
 * and an absent/unknown type — keeps the full set.
 *
 * This answers CHROME VISIBILITY only. Row PLACEMENT must keep reading
 * `layout`; `type` never informs a placement predicate.
 */
export function isActivitySectionVisibleForWorkspaceType(
  sectionId: string,
  workspaceType: ActivityWorkspaceType | undefined,
): boolean {
  if (workspaceType !== 'cowork') return true;
  return !isCodeOnlyActivitySection(sectionId);
}

/**
 * The part of {@link CanopyCapabilities} that decides which activity sections
 * a target implements. Hosts that only hold the allowlist (a memoised
 * persistence helper, a presence predicate) pass just this slice; any full
 * capability set satisfies it.
 */
export type ActivitySectionCapabilities = Pick<
  CanopyCapabilities,
  'activitySectionIds' | 'taskSummary'
>;

/**
 * Whether a section renders for one target: the workspace type must show it
 * AND, when the target's client reports an explicit
 * {@link CanopyCapabilities.activitySectionIds} allowlist, the allowlist must
 * name it.
 *
 * The allowlist is optional so a client that reports none (desktop, Remote
 * Control, Cowork) keeps exactly the set its workspace type shows. It only
 * narrows: it can never reveal a section the type hides. A repository project
 * has a repository, so its type keeps every section; its client names the ones
 * it has readers for (REG-3022). Shared components read the capability, never
 * the host backend.
 */
export function isActivitySectionVisibleForTarget(
  sectionId: string,
  workspaceType: ActivityWorkspaceType | undefined,
  capabilities: ActivitySectionCapabilities,
): boolean {
  // A target without a task summary shows no Summary, nor its Refresh.
  if (sectionId === 'summary' && capabilities.taskSummary !== true)
    return false;
  return (
    isActivitySectionVisibleForWorkspaceType(sectionId, workspaceType) &&
    (capabilities.activitySectionIds === undefined ||
      capabilities.activitySectionIds.includes(sectionId))
  );
}

/** Filter an ordered section list down to what this workspace type shows. */
export function visibleActivitySectionIds<Id extends string>(
  sectionIds: readonly Id[],
  workspaceType: ActivityWorkspaceType | undefined,
): Id[] {
  return sectionIds.filter((id) =>
    isActivitySectionVisibleForWorkspaceType(id, workspaceType),
  );
}

/**
 * Normalize a persisted section order without discarding ids owned by another
 * client: de-duplicate in place, then append any known defaults the persisted
 * order is missing. Consumers filter unknown ids when rendering, but keep them
 * here so a reorder can round-trip the complete cross-client order.
 */
export function resolveActivitySectionOrder(
  persisted: readonly string[] | undefined,
): string[] {
  if (!persisted || persisted.length === 0) {
    return [...DEFAULT_ACTIVITY_SECTION_ORDER];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of persisted) {
    if (!seen.has(id)) {
      normalized.push(id);
      seen.add(id);
    }
  }
  for (const id of DEFAULT_ACTIVITY_SECTION_ORDER) {
    if (id === 'cost') continue;
    if (!seen.has(id)) {
      normalized.push(id);
      seen.add(id);
    }
  }
  if (!seen.has('cost')) {
    const pipelineRunsIndex = normalized.indexOf('pipeline-runs');
    normalized.splice(
      pipelineRunsIndex < 0 ? normalized.length : pipelineRunsIndex + 1,
      0,
      'cost',
    );
  }
  return normalized;
}

/** Reorder visible sections while leaving hidden sections in their prior slots. */
export function mergeVisibleActivitySectionOrder(
  currentOrder: readonly string[],
  visibleOrder: readonly string[],
): string[] {
  const visible = new Set(visibleOrder);
  let visibleIndex = 0;
  return currentOrder.map((id) =>
    visible.has(id) ? (visibleOrder[visibleIndex++] ?? id) : id,
  );
}

/**
 * Whether a section's *interactive* controls (run/revert/dispatch) are available
 * on this host. Display-only sections (`summary`, `todo`) are never interactive;
 * the rest gate on the relevant capability so a web relay renders them
 * read-only. Provisional mapping, refined with the desktop/web adopt tickets.
 */
export function isActivitySectionInteractive(
  sectionId: ActivitySectionId,
  capabilities: CanopyCapabilities,
): boolean {
  switch (sectionId) {
    case 'summary':
    case 'todo':
    case 'cost':
      return false;
    case 'changed-files':
      return capabilities.fileSystemAccess === 'read-write';
    case 'pipeline-runs':
      return capabilities.pipelines === 'execute';
    case 'pull-request':
    case 'plans':
    case 'scripts':
    case 'hooks':
    case 'background-processes':
    case 'mcp-servers':
      return capabilities.localExecution;
    case 'terminals':
      return capabilities.terminalPty;
    default: {
      // Exhaustiveness guard: a new section id must be classified explicitly.
      sectionId satisfies never;
      return false;
    }
  }
}

/**
 * THE single definition of which activity sections represent work *this
 * worktree produced*, as opposed to ambient workspace configuration that is
 * already true on a brand-new worktree.
 *
 * A rail Canopy collapsed by default (CAN-2836) reopens itself the first time
 * one of these reports content. The line is deliberate, because "any non-empty
 * section" would neuter the default collapse outright: in a configured
 * workspace `plugins` (default-selected plugins), `scripts`/`hooks`
 * (project-configured), `notes`/`prompts` (workspace-global, shared by every
 * worktree), `memory`, `terminals`, and `mcp-servers` (whose content flag is
 * true while merely `initializing`) are all already true before the user has
 * done anything — the rail would spring open on every new chat.
 *
 * Desktop-only ids (`attachments`) are opaque to this package's
 * {@link ActivitySectionId} union but are worktree-scoped work and belong here,
 * so the list is typed by string rather than narrowed to the union.
 */
export const WORK_ACTIVITY_SECTION_IDS: readonly string[] = [
  'summary',
  'changed-files',
  'pull-request',
  'plans',
  'pipeline-runs',
  'cost',
  'background-processes',
  'todo',
  'attachments',
];

const WORK_SECTION_ID_SET: ReadonlySet<string> = new Set(
  WORK_ACTIVITY_SECTION_IDS,
);

/**
 * Sections that are worktree-scoped work in a CODE workspace but become
 * workspace-global in Cowork, and so must not reopen a Work Entry's rail.
 *
 * `attachments` is the whole set today: `resolveAgentAttachmentsDir` ignores
 * `worktreeId` for cowork and resolves to one workspace-level directory, so a
 * cowork workspace holding any attachment reports content on the FIRST paint
 * of every newly created Work Entry. Treating it as work there would reopen
 * the rail on every new entry — exactly the "already true on a brand-new
 * worktree" failure `notes`/`prompts`/`memory` are excluded for, and for the
 * very same reason.
 */
export const COWORK_AMBIENT_ACTIVITY_SECTION_IDS: readonly string[] = [
  'attachments',
];

const COWORK_AMBIENT_SECTION_ID_SET: ReadonlySet<string> = new Set(
  COWORK_AMBIENT_ACTIVITY_SECTION_IDS,
);

/**
 * Whether content in this section means the worktree produced work worth
 * showing, rather than the workspace merely being configured.
 *
 * Pass the workspace type so sections that are per-worktree in a code
 * workspace but workspace-global in Cowork are judged correctly; omitting it
 * keeps the code-workspace answer.
 */
export function isWorkActivitySection(
  sectionId: string,
  workspaceType?: string,
): boolean {
  if (
    workspaceType === 'cowork' &&
    COWORK_AMBIENT_SECTION_ID_SET.has(sectionId)
  ) {
    return false;
  }
  return WORK_SECTION_ID_SET.has(sectionId);
}
