/** The workspace kinds that have Git worktrees. */
export type WorktreeCreationWorkspaceKind = 'single-repo' | 'multi-repo';

/**
 * The loose branch and base fields of the worktree create service request.
 * {@link resolveWorktreeCreationSelection} turns them into one typed
 * selection and refuses the combinations the service cannot honor.
 */
export interface WorktreeSelectionFields {
  /** Create this new branch. */
  branchName?: string;
  /** Check out an existing local or remote branch instead of creating one. */
  existingBranch?: string;
  /**
   * Internal archive-restore allowlist for repositories that may reuse
   * `existingBranch`. Repositories outside this list must still lack the
   * branch immediately before Git setup.
   */
  existingBranchRepoPaths?: readonly string[];
  /**
   * Check out this branch when it exists locally or on origin; otherwise
   * create it. The backend resolves this immediately before Git setup.
   */
  suggestedBranch?: string;
  baseWorktreeId?: string;
  baseBranch?: string;
  /** Internal per-repository base map used by archive restore. */
  baseBranchesByRepo?: Record<string, string>;
}

/** Which branch the new worktree checks out. */
export type WorktreeBranchSelection =
  /** A new branch named `<worktree id>-<epoch ms>`. */
  | { kind: 'default' }
  | { kind: 'new'; branchName: string }
  | {
      kind: 'existing';
      branchName: string;
      /** Archive restore only: the repositories that may reuse the branch. */
      restoreRepoPaths?: readonly string[];
    }
  /** Reuse the branch when it exists, otherwise create it. */
  | { kind: 'suggested'; branchName: string };

/** Where a new branch starts and which base the worktree tracks. */
export type WorktreeBaseSelection =
  | { kind: 'repository-default' }
  | { kind: 'branch'; baseBranch: string }
  /** The current branch (or per-repository branches) of another worktree. */
  | { kind: 'worktree'; baseWorktreeId: string }
  /** Multi-repository only: a base branch or commit per repository id. */
  | { kind: 'per-repository'; baseBranches: Readonly<Record<string, string>> };

export interface WorktreeCreationSelection {
  branch: WorktreeBranchSelection;
  base: WorktreeBaseSelection;
}

export type WorktreeCreationRefusal =
  | 'branch-reserved'
  | 'invalid-branch-name'
  | 'branch-not-found'
  | 'branch-checked-out'
  | 'base-not-found'
  | 'base-task-detached'
  | 'checkout-reserved'
  | 'read-only-scope'
  | 'invalid-selection'
  | 'unsupported-workspace'
  | 'invalid-repository-selection';

/**
 * Worktree creation was refused at admission or identity validation. The name
 * stays `Error`, so the message a renderer sees through IPC is unchanged.
 */
export class WorktreeCreationRefusedError extends Error {
  /** Internal checkout identity hint; adapters must never serialize this path. */
  readonly checkoutPath?: string;

  constructor(
    readonly reason: WorktreeCreationRefusal,
    message: string,
    options?: { checkoutPath?: string },
  ) {
    super(message);
    this.checkoutPath = options?.checkoutPath;
  }
}

export function refuseWorktreeCreation(
  reason: WorktreeCreationRefusal,
  message: string,
): never {
  throw new WorktreeCreationRefusedError(reason, message);
}

function requestedBranchName(branchName: string | undefined): string | null {
  if (branchName === undefined) {
    return null;
  }
  if (!branchName || branchName.startsWith('-')) {
    refuseWorktreeCreation(
      'invalid-selection',
      'Branch name must be a non-empty value',
    );
  }
  return branchName;
}

function resolveBranchSelection(
  fields: WorktreeSelectionFields,
): WorktreeBranchSelection {
  const explicitBranch = requestedBranchName(fields.branchName?.trim());
  const existingBranch = requestedBranchName(fields.existingBranch);
  const suggestedBranch = requestedBranchName(fields.suggestedBranch);
  const intents = [explicitBranch, existingBranch, suggestedBranch].filter(
    (branch) => branch !== null,
  );
  if (intents.length > 1) {
    refuseWorktreeCreation(
      'invalid-selection',
      'existingBranch, branchName, and suggestedBranch cannot be combined',
    );
  }
  if (fields.existingBranchRepoPaths && existingBranch === null) {
    refuseWorktreeCreation(
      'invalid-selection',
      'existingBranchRepoPaths requires existingBranch',
    );
  }
  if (existingBranch !== null) {
    return {
      kind: 'existing',
      branchName: existingBranch,
      ...(fields.existingBranchRepoPaths
        ? { restoreRepoPaths: [...fields.existingBranchRepoPaths] }
        : {}),
    };
  }
  if (suggestedBranch !== null) {
    return { kind: 'suggested', branchName: suggestedBranch };
  }
  if (explicitBranch !== null) {
    return { kind: 'new', branchName: explicitBranch };
  }
  return { kind: 'default' };
}

function resolveBaseSelection(
  fields: WorktreeSelectionFields,
  workspaceKind: WorktreeCreationWorkspaceKind,
  branch: WorktreeBranchSelection,
): WorktreeBaseSelection {
  if (workspaceKind === 'single-repo' && fields.baseBranchesByRepo) {
    refuseWorktreeCreation(
      'invalid-selection',
      'baseBranchesByRepo is only supported for multi-repository projects',
    );
  }
  const baseBranches =
    fields.baseBranchesByRepo &&
    Object.keys(fields.baseBranchesByRepo).length > 0
      ? fields.baseBranchesByRepo
      : null;
  if (baseBranches && (fields.baseBranch || fields.baseWorktreeId)) {
    refuseWorktreeCreation(
      'invalid-selection',
      'baseBranchesByRepo cannot be combined with baseBranch or baseWorktreeId',
    );
  }
  // An existing branch is checkout intent and may still carry a tracked
  // base branch; a base worktree derives that tracked base itself.
  if (
    fields.baseWorktreeId &&
    (fields.baseBranch || branch.kind === 'existing')
  ) {
    refuseWorktreeCreation(
      'invalid-selection',
      'baseWorktreeId is mutually exclusive with baseBranch and existingBranch',
    );
  }
  if (baseBranches) {
    return { kind: 'per-repository', baseBranches: { ...baseBranches } };
  }
  if (fields.baseBranch) {
    return { kind: 'branch', baseBranch: fields.baseBranch };
  }
  if (fields.baseWorktreeId) {
    return { kind: 'worktree', baseWorktreeId: fields.baseWorktreeId };
  }
  return { kind: 'repository-default' };
}

/**
 * Resolves the service's loose branch and base fields into one typed
 * selection for a workspace kind. Every invalid combination is refused with
 * the message the service and its IPC adapters already used. Pure: it runs
 * before anything is read or reserved.
 */
export function resolveWorktreeCreationSelection(
  fields: WorktreeSelectionFields,
  workspaceKind: WorktreeCreationWorkspaceKind,
): WorktreeCreationSelection {
  const branch = resolveBranchSelection(fields);
  return { branch, base: resolveBaseSelection(fields, workspaceKind, branch) };
}

/** The service request fields for a typed selection. */
export function projectWorktreeCreationSelection(
  selection: WorktreeCreationSelection,
): WorktreeSelectionFields {
  const fields: WorktreeSelectionFields = {};
  const { branch, base } = selection;
  if (branch.kind === 'new') fields.branchName = branch.branchName;
  if (branch.kind === 'suggested') fields.suggestedBranch = branch.branchName;
  if (branch.kind === 'existing') {
    fields.existingBranch = branch.branchName;
    if (branch.restoreRepoPaths) {
      fields.existingBranchRepoPaths = [...branch.restoreRepoPaths];
    }
  }
  if (base.kind === 'branch') fields.baseBranch = base.baseBranch;
  if (base.kind === 'worktree') fields.baseWorktreeId = base.baseWorktreeId;
  if (base.kind === 'per-repository') {
    fields.baseBranchesByRepo = { ...base.baseBranches };
  }
  return fields;
}

/** The requested branch name of each branch intent, as the service uses them. */
export function requestedBranchNames(branch: WorktreeBranchSelection): {
  explicitBranch: string | null;
  existingBranch: string | null;
  suggestedBranch: string | null;
} {
  return {
    explicitBranch: branch.kind === 'new' ? branch.branchName : null,
    existingBranch: branch.kind === 'existing' ? branch.branchName : null,
    suggestedBranch: branch.kind === 'suggested' ? branch.branchName : null,
  };
}
