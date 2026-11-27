import type { JSX } from 'react';
import type { PrPickerOption } from '@/stores/navigationStore';
import {
  DialogModal,
  KeyHintFooter,
  PickerSearchList,
  PickerOptionContent,
  PickerOptionDescription,
  PickerOptionLabel,
  PickerOptionTrailing,
  PullRequestStateBadge,
} from '@canopy/ui-shared/components';
import { pickerKeyHints } from '@canopy/ui-shared/lib/shortcuts';
import { openUrlExternally } from './openUrlExternally';
import { prPickerOptionMatches } from './prPickerModel';

interface PrPickerProps {
  options: PrPickerOption[];
  onClose: () => void;
}

// Stable across renders: PickerSearchList keys its active-row reset on them.
function optionKey(option: PrPickerOption): string {
  return `${option.repoId}-${option.prNumber}`;
}

function optionLabel(option: PrPickerOption): string {
  return `${option.repoName} #${option.prNumber}`;
}

function optionTestId(option: PrPickerOption): string {
  return `pr-picker-option-${optionKey(option)}`;
}

/** Search the open pull requests, then open one in the browser. */
export function PrPicker({ options, onClose }: PrPickerProps): JSX.Element {
  function chooseOption(option: PrPickerOption): void {
    openUrlExternally(option.prUrl);
    onClose();
  }

  return (
    <DialogModal
      onClose={onClose}
      title="Open pull request"
      titleId="pr-picker-title"
      placement="top"
      maxWidth="2xl"
      inset="flush"
      headerBorder={false}
      scrollableBody={false}
      dataTestId="pr-picker"
    >
      {/* Session replay records the results. */}
      <div className="flex min-h-0 flex-1 flex-col px-4 pb-2">
        <PickerSearchList
          items={options}
          getKey={optionKey}
          getLabel={optionLabel}
          filter={prPickerOptionMatches}
          renderItem={(option) => (
            <>
              <PickerOptionContent>
                <PickerOptionLabel
                  // Keep prefix/value text nodes: merging them changes native shaping/clipping.
                  meta={<>#{option.prNumber}</>}
                >
                  {option.repoName}
                </PickerOptionLabel>
                <PickerOptionDescription>
                  {option.prTitle}
                </PickerOptionDescription>
              </PickerOptionContent>
              <PickerOptionTrailing>
                <PullRequestStateBadge state={option.prState} />
              </PickerOptionTrailing>
            </>
          )}
          onPick={chooseOption}
          onEscape={onClose}
          searchLabel="Search pull requests"
          placeholder="Search pull requests…"
          listLabel="Pull requests"
          emptyLabel="No pull requests found"
          listMaxHeight="lg"
          searchTestId="pr-picker-input"
          optionTestId={optionTestId}
        />
      </div>
      <KeyHintFooter hints={pickerKeyHints('open')} />
    </DialogModal>
  );
}
