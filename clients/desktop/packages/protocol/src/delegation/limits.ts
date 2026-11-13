import type { DelegationStopReason } from './index';

/*
 * The delegation contract's value lists and limits, kept apart from the
 * module that re-exports them so the wire schemas (`wire.ts`) read them
 * without loading the whole delegation contract.
 */

export const DELEGATION_STOP_REASONS = [
  'parent_cancelled',
  'user_cancelled',
  'deadline_exceeded',
  'shutdown',
  'policy_revoked',
  'stopped_by_parent',
  'ancestor_stopped',
] as const satisfies readonly DelegationStopReason[];

/** The most Feed entries one Delegate Task call hands to its delegate. */
export const AGENT_DELEGATION_TASK_IDS_MAX = 25;

/** Canonical RFC UUID spelling accepted for Feed task IDs. */
export const AGENT_DELEGATION_TASK_ID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

/**
 * Why one delegated file could not be applied to the parent checkout:
 * - `parent_changed`: the parent's file differs from the copy the delegate
 *   edited (changed, created, or deleted in the parent).
 * - `too_large`: a parent, delegate or starting copy exceeds the 32 MiB
 *   per-file apply limit.
 * - `not_text`: a parent, delegate or starting copy is binary or not UTF-8
 *   text.
 * - `not_regular_file`: the parent's or delegate's path is a directory, a
 *   link, a submodule, or a hard-linked file.
 * - `protected_path`: a protected path such as `.env`, `.git` or a key file.
 * - `outside_write_grant`: outside the delegate's current write grants.
 * - `unreconciled`: reported by earlier versions for a recorded edit that did
 *   not match the delegate's worktree. Apply now reads the worktree itself.
 * - `approval_denied`: the parent's approval policy or the user declined it.
 * - `write_failed`: the write failed; every file the apply wrote was restored.
 * - `not_restored`: written by the apply and not put back. Either it changed
 *   again afterwards and keeps that newer content, or restoring it failed and
 *   is retried when the parent applies again or the app restarts.
 */
export const DELEGATION_APPLY_ISSUE_REASONS = [
  'parent_changed',
  'too_large',
  'not_text',
  'not_regular_file',
  'protected_path',
  'outside_write_grant',
  'unreconciled',
  'approval_denied',
  'write_failed',
  'not_restored',
] as const;
export type DelegationApplyIssueReason =
  (typeof DELEGATION_APPLY_ISSUE_REASONS)[number];

/**
 * - `conflict`: one or more files cannot be applied as captured; see issues.
 * - `interrupted`: the app stopped mid-apply; its writes were restored.
 * - `unavailable`: the parent cannot apply now, for example in plan mode.
 */
export const DELEGATION_APPLY_FAILURE_REASONS = [
  'conflict',
  'approval_denied',
  'write_failed',
  'cancelled',
  'interrupted',
  'unavailable',
] as const;
export type DelegationApplyFailureReason =
  (typeof DELEGATION_APPLY_FAILURE_REASONS)[number];

export const AGENT_DELEGATION_INPUT_LIMITS = Object.freeze({
  idCharacters: 256,
  descriptionCharacters: 200,
  promptCharacters: 32_768,
  nameCharacters: 128,
  waitIds: 16,
  /** Thirty minutes: long enough for a planner to sleep until its children
   * settle instead of re-arming a watch every minute. */
  waitTimeoutMs: 1_800_000,
});
