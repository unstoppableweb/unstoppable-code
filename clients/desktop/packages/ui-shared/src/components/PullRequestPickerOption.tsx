import type { JSX } from 'react';
import { GitDraftIcon, GitForkIcon, GitHubIcon } from '../icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import {
  PickerOption,
  PickerOptionCheck,
  PickerOptionContent,
  PickerOptionDescription,
  PickerOptionLabel,
  PickerOptionLeading,
  PickerOptionTrailing,
} from '../primitives/PickerParts';
import { Tooltip } from '../primitives/Tooltip';

/** Disabled fork-PR row tooltip — worktrees need a branch in this repo. */
export const FORK_PR_DISABLED_TOOLTIP = "Can't create a worktree from a fork";
/** Selectable draft-PR row tooltip — clarifies the draft status icon. */
export const DRAFT_PR_TOOLTIP = 'Draft PR';

/** The display fields of an open pull request row. */
export interface PullRequestPickerOptionData {
  number: number;
  title: string;
  authorLogin: string;
  isDraft: boolean;
  /** A fork (or missing head repository) PR, shown disabled. */
  isCrossRepo: boolean;
}

export interface PullRequestPickerOptionProps {
  pullRequest: PullRequestPickerOptionData;
  /** The keyboard-navigation identity, used for `data-option-key`. */
  optionKey: string;
  /** The DOM id `aria-activedescendant` points at. */
  optionId: string;
  testId: string;
  active: boolean;
  selected: boolean;
  /** Commits the row. Never called for a disabled fork row. */
  onSelect: () => void;
  /** Makes the row the active option. Never called for a disabled fork row. */
  onActivate: () => void;
}

/**
 * One open pull request in a picker list: title, `#number · author`, and a
 * draft or fork marker. Fork rows stay visible but disabled with a tooltip
 * explaining why. Pure display: the host supplies data and callbacks.
 */
export function PullRequestPickerOption({
  pullRequest,
  optionKey,
  optionId,
  testId,
  active,
  selected,
  onSelect,
  onActivate,
}: PullRequestPickerOptionProps): JSX.Element {
  const disabled = pullRequest.isCrossRepo;
  const marker = disabled ? 'Fork' : pullRequest.isDraft ? 'Draft' : null;
  const tooltip = disabled
    ? FORK_PR_DISABLED_TOOLTIP
    : pullRequest.isDraft
      ? DRAFT_PR_TOOLTIP
      : null;
  const option = (
    <PickerOption
      role="option"
      id={optionId}
      aria-selected={selected}
      tabIndex={-1}
      disabled={disabled}
      onClick={disabled ? undefined : onSelect}
      onMouseEnter={disabled ? undefined : onActivate}
      data-option-key={disabled ? undefined : optionKey}
      data-testid={testId}
      active={!disabled && active}
      selected={selected}
    >
      <PickerOptionLeading>
        <GitHubIcon />
      </PickerOptionLeading>
      <PickerOptionContent>
        <PickerOptionLabel>{pullRequest.title}</PickerOptionLabel>
        <PickerOptionDescription>
          #{pullRequest.number} ·{' '}
          {/* Session replay blocks the author's login. */}
          <span className={REPLAY_BLOCK_CLASS}>{pullRequest.authorLogin}</span>
        </PickerOptionDescription>
      </PickerOptionContent>
      {selected ? (
        <PickerOptionCheck selected />
      ) : (
        marker && (
          <PickerOptionTrailing title={marker} aria-label={marker}>
            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:!h-4 [&>svg]:!w-4">
              {disabled ? <GitForkIcon /> : <GitDraftIcon />}
            </span>
          </PickerOptionTrailing>
        )
      )}
    </PickerOption>
  );
  return (
    <div>
      {tooltip ? (
        <Tooltip
          label={tooltip}
          placement="right"
          tone="inverse"
          className="w-full"
        >
          {option}
        </Tooltip>
      ) : (
        option
      )}
    </div>
  );
}
