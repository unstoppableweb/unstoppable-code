import type { RepoRulesBlockedReason } from '@canopy/protocol/repo-rules';

/** Shared count copy for the Cursor rules review and its result toast. */
export function ruleCountLabel(count: number): string {
  return count === 1 ? '1 rule' : `${count} rules`;
}

/**
 * Why new chats can't read a project's Cursor rules, for the rules status
 * (CAN-6368). One plain sentence per reason `repoRules.check` reports,
 * shared by desktop and web.
 */
export const REPO_RULES_BLOCKED_REASONS: Readonly<
  Record<RepoRulesBlockedReason, string>
> = Object.freeze({
  'unsupported-git':
    "Your Git settings change which files Git ignores in a way that can't be checked safely, for example through a conditional include.",
  'too-large': 'A Git file in the project is too large to check.',
  limit: 'The project has too many files to check.',
  changed:
    'Files changed while they were being read. Reopen this page to check again.',
  'unsafe-path': 'A rules folder points outside the project.',
  unavailable: "The project's files couldn't be read.",
  'missing-checkout':
    "The project's folder is missing, so its rules can't be read.",
});
