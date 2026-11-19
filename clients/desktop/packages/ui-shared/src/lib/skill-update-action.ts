/**
 * Why the last update operation on an installed skill failed (CAN-4264):
 * the check, the update itself, or the skill no longer being in its source.
 * `detail` is the host's explanation, when it says more than the headline.
 */
export type SkillUpdateError =
  | { kind: 'check-failed'; detail?: string }
  /** `recorded`: the host already recorded the failure, so the notice records nothing. */
  | { kind: 'update-failed'; detail?: string; recorded?: true }
  | { kind: 'missing-source' };

/**
 * An installed skill detail's update action (CAN-4264): a host that can check
 * for and apply updates supplies runnable callbacks; a host that can only
 * read cached availability supplies the reason it cannot act. Omitting the
 * action means the skill is not updatable, and no update control renders.
 *
 * One `pending` field covers both operations so the page can never show
 * checking and applying at once.
 */
export type SkillUpdateAction =
  | {
      status: 'ready';
      updateAvailable: boolean;
      pending: 'none' | 'checking' | 'applying';
      /**
       * When a check in this session last found no update for this skill.
       * Only then may the page say it is up to date: a cached `false` only
       * means no update is known.
       */
      checkedAt?: number;
      /** The last update operation's failure, until the next one starts. */
      error?: SkillUpdateError;
      onCheck: () => void;
      onApply: () => void;
    }
  | {
      status: 'blocked';
      updateAvailable: boolean;
      reason: string;
    };

/** The reason a host without update execution shows on its update control. */
export const SKILL_UPDATE_DESKTOP_ONLY_REASON =
  'Check for and apply skill updates from the desktop app.';
