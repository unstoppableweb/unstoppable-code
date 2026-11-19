import { type JSX } from 'react';
import {
  SegmentedControl,
  type SegmentedControlOption,
} from '@canopy/ui-shared/components';
import type { AutomationsViewMode } from './calendarPreferences';

interface ViewModePickerProps {
  viewMode: AutomationsViewMode;
  onChange: (mode: AutomationsViewMode) => void;
}

const OPTIONS: ReadonlyArray<SegmentedControlOption<AutomationsViewMode>> = [
  { value: 'list', label: 'List', dataTestId: 'automations-viewmode-list' },
  {
    value: 'calendar',
    label: 'Calendar',
    dataTestId: 'automations-viewmode-calendar',
  },
];

/** List | Calendar picker: the shared segmented control. */
export function ViewModePicker({
  viewMode,
  onChange,
}: ViewModePickerProps): JSX.Element {
  return (
    <SegmentedControl
      value={viewMode}
      options={OPTIONS}
      onChange={onChange}
      label="View mode"
      width="content"
    />
  );
}
