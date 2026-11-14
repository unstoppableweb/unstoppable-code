import type { JSX } from 'react';
import { BranchIcon, GlobeIcon, MacbookIcon } from '../icons/AppIcons';
import {
  getBranchProvenanceBadge,
  type BranchOption,
} from '../lib/branch-options';
import {
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionDescription,
  PickerMenuOptionLabel,
  PickerMenuOptionLeading,
  PickerMenuOptionTrailing,
} from './PickerMenu';
import { Tooltip } from './Tooltip';

/** Local-only branch provenance tooltip. */
const LOCAL_BRANCH_TOOLTIP = 'Local branch';
/** Remote-only branch provenance tooltip. */
const REMOTE_BRANCH_TOOLTIP = 'Remote branch';

/** The test id of a branch's row; `hasBothRefs` names which ref it selects. */
export function branchPickerOptionTestId(
  testIdPrefix: string,
  branch: BranchOption,
  hasBothRefs: boolean,
): string {
  const refSuffix = hasBothRefs
    ? `-${branch.isRemote ? 'remote' : 'local'}`
    : '';
  return `${testIdPrefix}-branch-${branch.name}${refSuffix}`;
}

export interface BranchPickerOptionContentProps {
  /**
   * One selectable ref. A branch with both refs is passed twice, once with
   * only its local ref and once with only its remote ref.
   */
  branch: BranchOption;
  selected: boolean;
  /** Prefix for the icon and provenance badge test ids. */
  testIdPrefix: string;
}

/** A branch row's content: `origin/<name>` for a remote ref, with a provenance badge. */
export function BranchPickerOptionContent({
  branch,
  selected,
  testIdPrefix,
}: BranchPickerOptionContentProps): JSX.Element {
  const provenance = getBranchProvenanceBadge(branch);
  const provenanceLabel =
    provenance === 'local' ? LOCAL_BRANCH_TOOLTIP : REMOTE_BRANCH_TOOLTIP;
  return (
    <>
      <PickerMenuOptionLeading>
        <BranchIcon
          size="md"
          data-testid={`${testIdPrefix}-option-icon-branch-${branch.name}`}
        />
      </PickerMenuOptionLeading>
      <PickerMenuOptionContent>
        <PickerMenuOptionLabel>
          {branch.isRemote ? `origin/${branch.name}` : branch.name}
        </PickerMenuOptionLabel>
      </PickerMenuOptionContent>
      {selected ? (
        <PickerMenuOptionCheck selected />
      ) : (
        provenance && (
          <PickerMenuOptionTrailing aria-label={provenanceLabel} interactive>
            <Tooltip label={provenanceLabel} placement="right" tone="inverse">
              <span
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:!h-4 [&>svg]:!w-4"
                data-testid={`${testIdPrefix}-${provenance}-badge-${branch.name}`}
              >
                {provenance === 'local' ? <MacbookIcon /> : <GlobeIcon />}
              </span>
            </Tooltip>
          </PickerMenuOptionTrailing>
        )
      )}
    </>
  );
}

export interface WorktreePickerOptionContentProps {
  label: string;
  /** Secondary line, e.g. the worktree label that tells duplicates apart. */
  description?: string;
  selected: boolean;
}

/** The content of a row for an existing worktree a new worktree can start from. */
export function WorktreePickerOptionContent({
  label,
  description,
  selected,
}: WorktreePickerOptionContentProps): JSX.Element {
  return (
    <>
      <PickerMenuOptionLeading>
        <BranchIcon size="md" />
      </PickerMenuOptionLeading>
      <PickerMenuOptionContent>
        <PickerMenuOptionLabel>{label}</PickerMenuOptionLabel>
        {description ? (
          <PickerMenuOptionDescription>
            {description}
          </PickerMenuOptionDescription>
        ) : null}
      </PickerMenuOptionContent>
      <PickerMenuOptionCheck selected={selected} />
    </>
  );
}
