import type { JSX } from 'react';
import { MorphLabel } from '@canopy/ui-shared/components';
import {
  repoRequiresCommitAndPush,
  repoRequiresPush,
  type BranchSyncAction,
  type PullRequestBranchFacts,
} from './branch-actions';

/**
 * The worktree header's PR action copy (REG-3025): one label table for every
 * host, moved from the desktop `PrStatusBar`.
 */

export function getBranchSyncActionLabel(action: BranchSyncAction): string {
  switch (action) {
    case 'push':
      return 'Push';
    case 'pull':
      return 'Pull';
    case 'pull-commit-and-push':
      return 'Pull, commit & push';
    case 'commit':
      return 'Commit';
    default:
      return 'Commit & push';
  }
}

export interface CreatePrLabelParams {
  readonly isMultiRepo: boolean;
  readonly uncommittedChanges: boolean;
  readonly hasUnpushedCommits: boolean;
  readonly repoBranches?: readonly PullRequestBranchFacts[];
  readonly repoCount?: number;
}

function getCreatePrPrefix(params: CreatePrLabelParams): string {
  if (params.isMultiRepo) {
    const anyNeedsCommit =
      params.repoBranches?.some((b) => repoRequiresCommitAndPush(b)) ?? false;
    if (anyNeedsCommit) return 'Commit, push & ';
    const anyNeedsPush =
      params.repoBranches?.some((b) => repoRequiresPush(b)) ?? false;
    return anyNeedsPush ? 'Push & ' : '';
  }
  if (params.uncommittedChanges) return 'Commit, push & ';
  return params.hasUnpushedCommits ? 'Push & ' : '';
}

/**
 * The button's VISIBLE copy: always just the outcome, so the control keeps a
 * fixed, compact width in the header cluster beside `Open in` / Launch
 * instead of growing to "Commit, push & create PR" whenever the branch has
 * uncommitted work.
 *
 * The preparatory steps the click also performs are not dropped, only moved:
 * {@link getCreatePrActionName} carries them in the accessible name, and the
 * commit-review modal names the full action again before anything is
 * committed.
 */
export function getCreatePrLabel(params: CreatePrLabelParams): string {
  const count = params.repoCount ?? 0;
  return params.isMultiRepo && count > 1 ? `Create ${count} PRs` : 'Create PR';
}

/** Accessible name: the full action, including commit/push preparation. */
export function getCreatePrActionName(params: CreatePrLabelParams): string {
  const prefix = getCreatePrPrefix(params);
  const label = getCreatePrLabel(params);
  // Sentence case: after a prefix, `Create` is no longer the first word.
  return prefix === ''
    ? label
    : `${prefix}${label.replace(/^Create/, 'create')}`;
}

/**
 * Narrow-bar copy: drop the verb and keep the object — `PR` / `N PRs`. The
 * button's icon and accessible name still say what it does.
 */
export function getCreatePrCompactLabel(params: CreatePrLabelParams): string {
  const count = params.repoCount ?? 0;
  return params.isMultiRepo && count > 1 ? `${count} PRs` : 'PR';
}

/**
 * The button's copy. The object (`PR` / `N PRs`) always shows; the verb
 * folds in from 640px of bar width and away below it, so the capsule morphs
 * between `Create PR` and `PR` instead of swapping copy. Its non-breaking
 * space keeps the word gap tight while it shows.
 */
export function CreatePrLabel(params: CreatePrLabelParams): JSX.Element {
  return (
    <span className="inline-flex whitespace-nowrap">
      <MorphLabel at="topbar-640">{'Create\u00a0'}</MorphLabel>
      {getCreatePrCompactLabel(params)}
    </span>
  );
}

/**
 * What Merge does for one pull request: `chat` opens a merge-pr agent chat,
 * `queue` adds it to its base branch's merge queue through the GitHub API,
 * and `direct` merges it through the GitHub API.
 */
export type PrMergeRoute = 'chat' | 'queue' | 'direct';

export interface MergeButtonPresentation {
  /** `data-merge-via`; any chat route wins so the chat glyph shows. */
  readonly via: PrMergeRoute;
  readonly help: string;
}

const UNRESOLVED_COMMENTS_HELP =
  'This PR has unresolved comments or an unknown review thread state';

/**
 * The Merge button's glyph route and idle help for the mergeable pull
 * requests' routes. The unresolved-comments warning replaces the help.
 */
export function describeMergeButton(args: {
  routes: readonly PrMergeRoute[];
  warning: boolean;
}): MergeButtonPresentation {
  const hasChat = args.routes.includes('chat');
  const hasQueue = args.routes.includes('queue');
  const via: PrMergeRoute = hasChat ? 'chat' : hasQueue ? 'queue' : 'direct';
  if (args.warning) return { via, help: UNRESOLVED_COMMENTS_HELP };
  if (args.routes.length > 1) {
    if (hasChat && hasQueue) {
      return {
        via,
        help: 'Merge the pull requests. Those on a merge queue are added to it, and a chat oversees the ones with no merge queue hook',
      };
    }
    if (hasChat) {
      return {
        via,
        help: 'Merge the pull requests. A chat handles any that use a merge queue',
      };
    }
    if (hasQueue) {
      return {
        via,
        help: 'Merge the pull requests. Any that use a merge queue are added to it',
      };
    }
    return { via, help: 'Merge the pull request' };
  }
  if (via === 'chat') {
    return {
      via,
      help: 'Start a chat that adds this pull request to the merge queue and watches it until it merges',
    };
  }
  if (via === 'queue') {
    return { via, help: 'Add this pull request to the merge queue' };
  }
  return { via, help: 'Merge the pull request' };
}

/**
 * Why an action waits, shown as its disabled control's tooltip. The merge
 * reasons are the Portal blocked-reason copy (docs/ux-writing.md): each names
 * the next useful step.
 */
export const PULL_REQUEST_BLOCKED_COPY = {
  mergeLocalChanges: 'Commit and push the local changes to merge.',
  mergeDraft: 'Mark the pull request ready for review to merge.',
  mergeConflicts: 'Resolve the conflicts to merge.',
  mergeChecksFailing: 'Fix the failing checks to merge.',
  mergeChecksPending: 'Wait for the checks to finish to merge.',
  mergeReview: 'Get an approving review to merge.',
  mergeNotReady: 'GitHub reports this pull request cannot merge yet.',
  busy: 'Wait for the running action to finish.',
  resolveLocalChanges:
    'Commit and push the local changes to resolve the conflicts.',
  fixUnavailable: "Fixing checks with an agent isn't available here yet.",
  resolveUnavailable:
    "Resolving conflicts with an agent isn't available here yet.",
} as const;

/** The non-interactive status that replaces Merge while a PR is queued. */
export function getMergeQueueStatusLabel(position: number | undefined): string {
  return typeof position === 'number'
    ? `In merge queue (#${position})`
    : 'In merge queue';
}

const CHECK_STATUS_LABEL = {
  passing: 'passing',
  failing: 'failing',
  pending: 'running',
  neutral: 'neutral',
  none: 'not run',
} as const;

/** Plain-language CI state for the CI badge's name and hover tooltip. */
export function getCheckStatusLabel(
  status: keyof typeof CHECK_STATUS_LABEL,
): string {
  return `CI ${CHECK_STATUS_LABEL[status]}`;
}
