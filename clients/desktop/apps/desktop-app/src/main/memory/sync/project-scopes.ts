import type { MemoryScopeRef } from '@canopy/protocol/memory-sync';

/*
 * Which project memory scope a local workspace maps to (design §22, D6): the
 * cloud project its `workspace.json` `cloudBinding` names, under the account
 * that binding belongs to. A project scope is private to one account, so a
 * workspace maps to one only for that account. Synchronous and free of I/O:
 * the scope resolver asks it on every memory read and write, and the sync
 * host keeps it current from the workspace files.
 *
 * Fail closed: an unreadable workspace, no binding, a binding of another
 * account, or two workspaces of one account bound to the same project map to
 * no project scope, so their memory stays in the device-local folder and
 * never syncs into the wrong scope.
 */

export type ProjectMemoryScopeRef = Extract<
  MemoryScopeRef,
  { kind: 'project' }
>;

/** A workspace as its `workspace.json` stands, for project memory. */
export interface WorkspaceMemoryBinding {
  workspaceId: string;
  /** The config could not be read, or its memory settings are malformed. */
  unreadable: boolean;
  privateMemory: boolean;
  binding: {
    projectId: string;
    accountId: string;
    /** This device's binding was detached, or its project deleted. */
    detached: boolean;
    /** The project moved into an organization while this checkout waits. */
    moved: boolean;
  } | null;
}

/**
 * What a bound project's memory does on this device: `sync`; `device_only`
 * while the project keeps private memory; `stopped` while the binding is
 * detached or its project moved, when nothing syncs and local memory stays.
 */
export type ProjectMemoryScopeMode = 'sync' | 'device_only' | 'stopped';

export type ProjectMemoryScopeReason =
  | 'private_memory'
  | 'detached'
  | 'moved'
  | null;

export interface ProjectMemoryScopeTarget {
  scope: ProjectMemoryScopeRef;
  workspaceId: string;
  mode: ProjectMemoryScopeMode;
  reason: ProjectMemoryScopeReason;
}

export function projectMemoryScope(projectId: string): ProjectMemoryScopeRef {
  return { kind: 'project', projectId };
}

function targetFor(
  workspace: WorkspaceMemoryBinding,
  projectId: string,
): ProjectMemoryScopeTarget {
  const binding = workspace.binding;
  const scope = projectMemoryScope(projectId);
  if (binding?.detached === true) {
    return {
      scope,
      workspaceId: workspace.workspaceId,
      mode: 'stopped',
      reason: 'detached',
    };
  }
  if (binding?.moved === true) {
    return {
      scope,
      workspaceId: workspace.workspaceId,
      mode: 'stopped',
      reason: 'moved',
    };
  }
  if (workspace.privateMemory) {
    return {
      scope,
      workspaceId: workspace.workspaceId,
      mode: 'device_only',
      reason: 'private_memory',
    };
  }
  return {
    scope,
    workspaceId: workspace.workspaceId,
    mode: 'sync',
    reason: null,
  };
}

export class ProjectMemoryScopeDirectory {
  private readonly workspaces = new Map<string, WorkspaceMemoryBinding>();

  /**
   * @param onChange Runs after a change that may move a workspace's memory
   *   to another folder, with the projects those workspaces were or are now
   *   bound to.
   */
  constructor(
    private readonly onChange: (
      workspaceIds: readonly string[],
      projectIds: readonly string[],
    ) => void = (): void => undefined,
  ) {}

  /** Replaces every workspace, as the workspace files stand now. */
  replaceAll(workspaces: readonly WorkspaceMemoryBinding[]): void {
    const next = new Map(workspaces.map((entry) => [entry.workspaceId, entry]));
    const changed = new Set<string>();
    const projects = new Set<string>();
    const note = (
      workspaceId: string,
      left: WorkspaceMemoryBinding | undefined,
      right: WorkspaceMemoryBinding | undefined,
    ): void => {
      if (sameEntry(left, right)) return;
      changed.add(workspaceId);
      for (const projectId of [
        left?.binding?.projectId,
        right?.binding?.projectId,
      ]) {
        if (projectId !== undefined) projects.add(projectId);
      }
    };
    for (const [workspaceId, entry] of this.workspaces) {
      note(workspaceId, entry, next.get(workspaceId));
    }
    for (const [workspaceId, entry] of next) {
      note(workspaceId, this.workspaces.get(workspaceId), entry);
    }
    this.workspaces.clear();
    for (const [workspaceId, entry] of next)
      this.workspaces.set(workspaceId, entry);
    if (changed.size > 0) this.onChange([...changed], [...projects]);
  }

  /** One workspace as its file stands now; null when it is gone. */
  update(workspaceId: string, entry: WorkspaceMemoryBinding | null): void {
    const previous = this.workspaces.get(workspaceId);
    if (entry === null) this.workspaces.delete(workspaceId);
    else this.workspaces.set(workspaceId, entry);
    if (sameEntry(previous, entry ?? undefined)) return;
    const projects = new Set<string>();
    for (const projectId of [
      previous?.binding?.projectId,
      entry?.binding?.projectId,
    ]) {
      if (projectId !== undefined) projects.add(projectId);
    }
    this.onChange([workspaceId], [...projects]);
  }

  /** The project a workspace's binding names, whatever its account or state. */
  boundProjectIdOf(workspaceId: string): string | null {
    return this.workspaces.get(workspaceId)?.binding?.projectId ?? null;
  }

  /** Every workspace this directory knows, for the host's broadcasts. */
  workspaceIds(): string[] {
    return [...this.workspaces.keys()];
  }

  /**
   * The project scope `workspaceId` maps to for `accountId`, whatever its
   * mode, so a project kept on this device or no longer syncing still finds
   * the memory it has; null when it maps to none.
   */
  projectFor(
    accountId: string,
    workspaceId: string,
  ): ProjectMemoryScopeRef | null {
    const entry = this.workspaces.get(workspaceId);
    const projectId = this.boundProjectId(accountId, entry);
    if (entry === undefined || projectId === null) return null;
    return this.boundWorkspaces(accountId, projectId).length === 1
      ? projectMemoryScope(projectId)
      : null;
  }

  /** The one workspace bound to the project for the account, if exactly one. */
  workspaceFor(accountId: string, projectId: string): string | null {
    const bound = this.boundWorkspaces(accountId, projectId);
    return bound.length === 1 ? (bound[0]?.workspaceId ?? null) : null;
  }

  /** The account's project scopes, one per project bound by exactly one workspace. */
  targets(accountId: string): ProjectMemoryScopeTarget[] {
    const byProject = new Map<string, WorkspaceMemoryBinding[]>();
    for (const entry of this.workspaces.values()) {
      const projectId = this.boundProjectId(accountId, entry);
      if (projectId === null) continue;
      byProject.set(projectId, [...(byProject.get(projectId) ?? []), entry]);
    }
    const targets: ProjectMemoryScopeTarget[] = [];
    for (const [projectId, bound] of byProject) {
      const [only, ...others] = bound;
      if (only !== undefined && others.length === 0) {
        targets.push(targetFor(only, projectId));
      }
    }
    return targets.sort((left, right) =>
      left.scope.projectId.localeCompare(right.scope.projectId),
    );
  }

  /** Projects of the account more than one workspace is bound to. */
  ambiguousProjects(accountId: string): string[] {
    const counts = new Map<string, number>();
    for (const entry of this.workspaces.values()) {
      const projectId = this.boundProjectId(accountId, entry);
      if (projectId !== null)
        counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
    }
    return [...counts]
      .filter(([, count]) => count > 1)
      .map(([projectId]) => projectId);
  }

  private boundProjectId(
    accountId: string,
    entry: WorkspaceMemoryBinding | undefined,
  ): string | null {
    if (entry === undefined || entry.unreadable || entry.binding === null)
      return null;
    return entry.binding.accountId === accountId
      ? entry.binding.projectId
      : null;
  }

  private boundWorkspaces(
    accountId: string,
    projectId: string,
  ): WorkspaceMemoryBinding[] {
    return [...this.workspaces.values()].filter(
      (entry) => this.boundProjectId(accountId, entry) === projectId,
    );
  }
}

function sameEntry(
  left: WorkspaceMemoryBinding | undefined,
  right: WorkspaceMemoryBinding | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.unreadable === right.unreadable &&
    left.privateMemory === right.privateMemory &&
    left.binding?.projectId === right.binding?.projectId &&
    left.binding?.accountId === right.binding?.accountId &&
    left.binding?.detached === right.binding?.detached &&
    left.binding?.moved === right.binding?.moved
  );
}
