'use client';

import { useMemo, type JSX, type RefObject } from 'react';
import {
  Picker,
  PickerOptionContent,
  PickerOptionDescription,
  PickerOptionLabel,
  PickerOptionLeading,
} from '@canopy/ui-shared/components';
import {
  workflowStepPickerSections,
  type WorkflowStepChoice,
  type WorkflowStepPickerOption,
} from './step-catalog';

interface PickerRow {
  readonly option: WorkflowStepPickerOption;
  readonly section: string;
}

export interface WorkflowStepPickerProps {
  readonly anchorRef: RefObject<HTMLElement | null>;
  /** The button that opened the picker. Escape puts focus back on it. */
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChoose: (choice: WorkflowStepChoice) => void;
  /** Offers "Split into paths": the "+" ends a job that can end in paths. */
  readonly offerSplit?: boolean;
}

/**
 * The searchable step picker behind the designer's "+" buttons: the step
 * catalog by purpose, with Run script and a custom action.
 */
export function WorkflowStepPicker({
  anchorRef,
  returnFocusRef,
  open,
  onOpenChange,
  onChoose,
  offerSplit = false,
}: WorkflowStepPickerProps): JSX.Element {
  const rows = useMemo(
    (): readonly PickerRow[] =>
      workflowStepPickerSections('', { offerSplit }).flatMap((section) =>
        section.options.map((option) => ({ option, section: section.label })),
      ),
    [offerSplit],
  );
  return (
    <Picker
      open={open}
      onOpenChange={onOpenChange}
      anchorRef={anchorRef}
      placement="bottom-left"
      interaction="manual"
      role="dialog"
      heightLimit={420}
      minimumWidth="18rem"
      aria-label="Add a step"
      data-testid="workflow-step-picker"
      search={{
        items: rows,
        getKey: (row) => row.option.key,
        getLabel: (row) => row.option.entry.label,
        getSection: (row) => row.section,
        filter: (row, query) => {
          const needle = query.trim().toLowerCase();
          return (
            row.option.entry.label.toLowerCase().includes(needle) ||
            row.option.entry.description.toLowerCase().includes(needle)
          );
        },
        renderItem: (row) => {
          const Icon = row.option.entry.icon;
          return (
            <>
              <PickerOptionLeading>
                <Icon size="sm" aria-hidden="true" />
              </PickerOptionLeading>
              <PickerOptionContent>
                <PickerOptionLabel>{row.option.entry.label}</PickerOptionLabel>
                <PickerOptionDescription>
                  {row.option.entry.description}
                </PickerOptionDescription>
              </PickerOptionContent>
            </>
          );
        },
        onPick: (row) => {
          onOpenChange(false);
          onChoose(row.option.choice);
        },
        onEscape: () => {
          onOpenChange(false);
          returnFocusRef.current?.focus();
        },
        searchLabel: 'Search steps',
        placeholder: 'Search steps',
        listLabel: 'Steps',
        emptyLabel: 'No steps match.',
        optionTestId: () => 'workflow-step-picker-option',
        searchTestId: 'workflow-step-picker-search',
      }}
    />
  );
}
