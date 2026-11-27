import { useState, type JSX, type RefObject } from 'react';
import type { BranchEntry } from '@canopy/desktop-shared/types';
import {
  PickerSearchList,
  PickerOptionCheck,
  PickerOptionContent,
  PickerOptionLabel,
  PickerOptionLeading,
  PickerOptionTrailing,
} from '@canopy/ui-shared/components';
import { BranchIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  filterBranchesBySearch,
  getBranchProvenanceBadge,
} from './branch-options';

export function BaseBranchOptions({
  branches,
  currentValue,
  inputRef,
  loading,
  onPick,
  onEscape,
}: {
  readonly branches: BranchEntry[];
  readonly currentValue: string | null | undefined;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly loading: boolean;
  readonly onPick: (branchName: string) => void;
  readonly onEscape: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  return (
    <PickerSearchList
      items={filterBranchesBySearch(branches, query)}
      query={query}
      onQueryChange={setQuery}
      inputRef={inputRef}
      autoFocus={false}
      loading={loading}
      loadingLabel="Loading branches"
      emptyLabel="No branches found"
      searchLabel="Search branches"
      listLabel="Base branch options"
      getKey={(branch) => branch.name}
      getLabel={(branch) => branch.name}
      selectedKey={currentValue ?? undefined}
      preferSelectedForNavigation={false}
      optionProps={(branch) => ({ 'data-branch-name': branch.name })}
      onPick={(branch) => onPick(branch.name)}
      onEscape={onEscape}
      renderItem={(branch, state) => {
        const provenanceBadge = getBranchProvenanceBadge(branch);
        return (
          <>
            <PickerOptionLeading>
              <BranchIcon size="md" />
            </PickerOptionLeading>
            <PickerOptionContent>
              <PickerOptionLabel>{branch.name}</PickerOptionLabel>
            </PickerOptionContent>
            {provenanceBadge && (
              <PickerOptionTrailing>{provenanceBadge}</PickerOptionTrailing>
            )}
            <PickerOptionCheck selected={state.selected} />
          </>
        );
      }}
    />
  );
}
