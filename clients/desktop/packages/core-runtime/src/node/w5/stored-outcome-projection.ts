/*
 * Versioned projectors from a keyed W5 operation's stored outcome to its
 * portable result (CAN-5428, W5a3). A first keyed response and every replay
 * project the same stored value, so they are equal (RR4); neither reads
 * current state, and no stored receipt is rewritten. Outcomes saved before
 * W5a3 carry no `version` and read as version 1. Results omit revisions: a
 * stored outcome describes no committed observation a replay could label
 * (RR2). Reorders follow A17(a): an acknowledgement, after which the caller
 * re-reads the collection for its order and revision.
 */
import type {
  CoreWorkspace,
  CoreWorktree,
} from '@canopy/protocol/canopy-core/core';
import { projectCoreWorktree } from '../workspace/core-workspace-projection';
import {
  at,
  finiteNumber,
  flag,
  list,
  object,
  oneOf,
  optional,
  text,
  textList,
  textRecord,
  W5OutcomeDecodeError,
} from './outcome-decoding';
import {
  decodeW5WorktreeBranchRenameOutcome,
  decodeW5WorktreeUpdateOutcome,
  type W5WorktreeOutcome,
} from './worktree-outcome';

export { W5OutcomeDecodeError } from './outcome-decoding';

/** The stored outcome format these projectors write and read. */
export const W5_STORED_OUTCOME_VERSION = 1;

/**
 * The value the commit log saves for an outcome, and so what a replay reads:
 * `JSON.stringify(outcome ?? null)`, parsed back. Project a first response
 * from this form, never from the live value.
 */
export function w5StoredOutcomeForm(outcome: unknown): unknown {
  return JSON.parse(JSON.stringify(outcome ?? null));
}

/** A missing `version` is 1; any version no projector knows is refused. */
export function w5StoredOutcomeVersion(stored: unknown): number {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored))
    return 1;
  if (!Object.prototype.hasOwnProperty.call(stored, 'version')) return 1;
  const version: unknown = Reflect.get(stored, 'version');
  if (version !== W5_STORED_OUTCOME_VERSION)
    throw new W5OutcomeDecodeError('version');
  return version;
}

/** Fields of the keyed request; same key and fingerprint, so same context. */
export interface W5WorktreeOutcomeContext {
  workspaceId: string;
}

const WORKSPACE_TYPES = ['single-repo', 'multi-repo', 'cowork'] as const;
const SETUP_PHASES = ['git-pending', 'git-ready'] as const;
const REPAIR_CODES = [
  'missing-gitignore',
  'invalid-gitignore',
  'missing-canopy-json',
  'invalid-canopy-json',
  'missing-claude-md',
  'invalid-agents-md',
] as const;
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/** `core.workspace.create` / `.import`'s result. */
export interface W5WorkspaceCreationResult {
  workspace: CoreWorkspace;
  clonedRepoIds: string[];
  scriptActionsOperationId?: string;
}

/** Its stored message is omitted: a message can name a host path. */
export interface W5WorktreeRepairIssue {
  code: (typeof REPAIR_CODES)[number];
  blocking: boolean;
}

/** `core.worktree.create`'s result. */
export type W5WorktreeCreationResult =
  | { status: 'created'; worktree: CoreWorktree }
  | {
      status: 'needs-repair';
      worktreeId: string;
      branchName: string;
      repairIssues: W5WorktreeRepairIssue[];
    };

/** `core.worktree.update`'s result. */
export interface W5WorktreeUpdateResult {
  worktree: CoreWorktree;
  changed: boolean;
}

/** `core.worktree.branch.rename`'s result; a null row is a missing row. */
export interface W5WorktreeBranchRenameResult {
  branchName: string;
  worktree: CoreWorktree | null;
}

/**
 * A17(a): `core.workspace.reorder` and `core.worktree.reorder` acknowledge a
 * committed move; the caller re-reads the collection for order and revision.
 */
export interface W5ReorderAcknowledgement {
  acknowledged: true;
}

/**
 * A stored row as the `core.worktree.get` projection reads it, except that a
 * stored row carries no health observation, so its state is never `error`.
 */
function projectRow(
  context: W5WorktreeOutcomeContext,
  row: Pick<
    W5WorktreeOutcome,
    | 'id'
    | 'branchName'
    | 'createdAt'
    | 'label'
    | 'trackedBaseBranch'
    | 'setupPhase'
  >,
): CoreWorktree {
  return projectCoreWorktree(context.workspaceId, row);
}

/** The v1 workspace receipt: `{ workspace, clonedRepoIds, scriptActionsOperationId? }`. */
function projectWorkspaceCreationV1(
  stored: unknown,
): W5WorkspaceCreationResult {
  const input = object(stored, '');
  const row = object(input.workspace, 'workspace');
  const type = oneOf(row.type, WORKSPACE_TYPES, 'workspace.type');
  const workspace: CoreWorkspace = {
    workspaceId: text(row.id, 'workspace.id'),
    name: text(row.name, 'workspace.name'),
    kind: type === 'cowork' ? 'cowork' : 'git',
    // The receipt saves no repositories; a re-read reports their sources.
    repositorySources: [],
    settings: {},
  };
  const color = text(row.color, 'workspace.color');
  finiteNumber(row.order, 'workspace.order');
  const collapsed = optional(row.collapsed, 'workspace.collapsed', flag);
  if (HEX_COLOR.test(color)) workspace.color = color;
  if (collapsed !== undefined) workspace.collapsed = collapsed;
  const clonedRepoIds = textList(input.clonedRepoIds, 'clonedRepoIds');
  const scriptActionsOperationId = optional(
    input.scriptActionsOperationId,
    'scriptActionsOperationId',
    text,
  );
  return scriptActionsOperationId === undefined
    ? { workspace, clonedRepoIds }
    : { workspace, clonedRepoIds, scriptActionsOperationId };
}

function decodeRepairIssues(
  value: unknown,
  path: string,
): W5WorktreeRepairIssue[] {
  return list(value, path, (item, itemPath) => {
    const issue = object(item, itemPath);
    const code = oneOf(issue.code, REPAIR_CODES, at(itemPath, 'code'));
    text(issue.message, at(itemPath, 'message'));
    return { code, blocking: flag(issue.blocking, at(itemPath, 'blocking')) };
  });
}

/** The v1 created and needs-repair worktree receipts. */
function projectWorktreeCreationV1(
  stored: unknown,
  context: W5WorktreeOutcomeContext,
): W5WorktreeCreationResult {
  const input = object(stored, '');
  if (input.status === 'needs-repair') {
    oneOf(input.workspaceKind, ['multi-repo'], 'workspaceKind');
    const worktreeId = text(input.worktreeId, 'worktreeId');
    const branchName = text(input.branchName, 'branchName');
    const repairIssues = decodeRepairIssues(input.repairIssues, 'repairIssues');
    const response = object(input.response, 'response');
    text(response.id, 'response.id');
    text(response.branchName, 'response.branchName');
    optional(response.existingBranch, 'response.existingBranch', text);
    optional(
      response.trackedRepoBaseBranches,
      'response.trackedRepoBaseBranches',
      textRecord,
    );
    if (response.needsRepair !== true)
      throw new W5OutcomeDecodeError('response.needsRepair');
    decodeRepairIssues(response.repairIssues, 'response.repairIssues');
    return { status: 'needs-repair', worktreeId, branchName, repairIssues };
  }
  oneOf(input.status, ['created'], 'status');
  oneOf(input.workspaceKind, ['single-repo', 'multi-repo'], 'workspaceKind');
  const record = object(input.record, 'record');
  const row = {
    id: text(record.worktreeId, 'record.worktreeId'),
    branchName: text(record.branchName, 'record.branchName'),
    createdAt: text(record.createdAt, 'record.createdAt'),
    setupPhase: oneOf(record.setupPhase, SETUP_PHASES, 'record.setupPhase'),
    trackedBaseBranch:
      record.trackedBaseBranch === null
        ? null
        : text(record.trackedBaseBranch, 'record.trackedBaseBranch'),
  };
  textRecord(record.trackedRepoBaseBranches, 'record.trackedRepoBaseBranches');
  if (record.includedRepoIds !== null)
    textList(record.includedRepoIds, 'record.includedRepoIds');
  const response = object(input.response, 'response');
  text(response.id, 'response.id');
  text(response.branchName, 'response.branchName');
  text(response.createdAt, 'response.createdAt');
  optional(response.setupPhase, 'response.setupPhase', (value, path) =>
    oneOf(value, SETUP_PHASES, path),
  );
  optional(response.trackedBaseBranch, 'response.trackedBaseBranch', (v, p) =>
    v === null ? null : text(v, p),
  );
  optional(
    response.trackedRepoBaseBranches,
    'response.trackedRepoBaseBranches',
    textRecord,
  );
  return { status: 'created', worktree: projectRow(context, row) };
}

/** Throws {@link W5OutcomeDecodeError} for a stored outcome no version accepts. */
export function projectW5WorkspaceCreationOutcome(
  stored: unknown,
): W5WorkspaceCreationResult {
  w5StoredOutcomeVersion(stored);
  return projectWorkspaceCreationV1(stored);
}

/** Throws {@link W5OutcomeDecodeError} for a stored outcome no version accepts. */
export function projectW5WorktreeCreationOutcome(
  stored: unknown,
  context: W5WorktreeOutcomeContext,
): W5WorktreeCreationResult {
  w5StoredOutcomeVersion(stored);
  return projectWorktreeCreationV1(stored, context);
}

/** Throws {@link W5OutcomeDecodeError} for a stored outcome no version accepts. */
export function projectW5WorktreeUpdateOutcome(
  stored: unknown,
  context: W5WorktreeOutcomeContext,
): W5WorktreeUpdateResult {
  w5StoredOutcomeVersion(stored);
  const outcome = decodeW5WorktreeUpdateOutcome(stored);
  return {
    worktree: projectRow(context, outcome.worktree),
    changed: outcome.changed,
  };
}

/** Throws {@link W5OutcomeDecodeError} for a stored outcome no version accepts. */
export function projectW5WorktreeBranchRenameOutcome(
  stored: unknown,
  context: W5WorktreeOutcomeContext,
): W5WorktreeBranchRenameResult {
  w5StoredOutcomeVersion(stored);
  const outcome = decodeW5WorktreeBranchRenameOutcome(stored);
  return {
    branchName: outcome.branchName,
    worktree: outcome.worktree && projectRow(context, outcome.worktree),
  };
}

export type W5ReorderOperation =
  | 'core.workspace.reorder'
  | 'core.worktree.reorder';

/**
 * A move's v1 receipt is `null` (saved from `undefined`); a workspace
 * reorder's is `{ workspaceIds }`. Both acknowledge (A17(a)). Throws
 * {@link W5OutcomeDecodeError} for any other stored outcome.
 */
export function projectW5ReorderOutcome(
  operation: W5ReorderOperation,
  stored: unknown,
): W5ReorderAcknowledgement {
  if (operation === 'core.worktree.reorder') {
    if (stored !== null && stored !== undefined)
      throw new W5OutcomeDecodeError('');
  } else {
    w5StoredOutcomeVersion(stored);
    textList(object(stored, '').workspaceIds, 'workspaceIds');
  }
  return { acknowledged: true };
}
