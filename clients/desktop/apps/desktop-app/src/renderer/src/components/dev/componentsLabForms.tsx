import type { JSX, ReactNode } from 'react';
import type { ComponentsLabEntry } from './componentsLabCatalog';
import { ChoiceMatrix, FieldStates, FieldsDemo } from './FieldsLabPage';
import {
  SearchFieldButtonsPanel,
  TextInputButtonsPanel,
} from './componentsLabFieldButtons';
import { FieldsStage } from './componentsLabStagesControls';

const SRC = 'packages/ui-shared/src/components';
const PRIMITIVES_SRC = 'packages/ui-shared/src/primitives';

/** The column every specimen sheet stacks its panels in. */
function Panels({ children }: { readonly children: ReactNode }): JSX.Element {
  return <div className="flex flex-col gap-6">{children}</div>;
}

function TextInputSpecimen(): JSX.Element {
  return (
    <Panels>
      <FieldStates rows={['text-default', 'text-compact', 'text-settings']} />
      <TextInputButtonsPanel />
    </Panels>
  );
}

function TextAreaSpecimen(): JSX.Element {
  return <FieldStates rows={['textarea']} />;
}

function SelectSpecimen(): JSX.Element {
  return <FieldStates rows={['select', 'settings-select']} />;
}

function DateFieldSpecimen(): JSX.Element {
  return <FieldStates rows={['date-field']} />;
}

function SearchFieldSpecimen(): JSX.Element {
  return (
    <Panels>
      <FieldStates rows={['search-sm', 'search-md']} />
      <SearchFieldButtonsPanel />
      <FieldsDemo demo="search-row" />
    </Panels>
  );
}

function InlineTextInputSpecimen(): JSX.Element {
  return (
    <Panels>
      <FieldStates rows={['inline']} />
      <FieldsDemo demo="inline-rename" />
    </Panels>
  );
}

function FormFieldSpecimen(): JSX.Element {
  return (
    <Panels>
      <FieldStates rows={['dialog-field', 'field-error']} />
      <FieldsDemo demo="settings-form" />
      <FieldsDemo demo="tall-form" />
      <FieldsDemo demo="dialog" />
      <FieldsDemo demo="two-factor" />
    </Panels>
  );
}

function CheckboxRadioSpecimen(): JSX.Element {
  return (
    <Panels>
      <ChoiceMatrix />
      <FieldStates rows={['choice-list']} />
      <FieldsDemo demo="choices" />
    </Panels>
  );
}

function ToggleSwitchSpecimen(): JSX.Element {
  return <FieldStates rows={['toggle']} />;
}

function ToolbarChipsSpecimen(): JSX.Element {
  return (
    <Panels>
      <FieldStates rows={['capsules']} />
      <FieldsDemo demo="chips" />
    </Panels>
  );
}

/**
 * The form controls, one sheet a field. They used to share one sheet built
 * around a single state matrix twelve columns wide, which scrolled sideways;
 * each sheet now lays its field's states out in the page column. The fields
 * lab (`fields-lab.vite.mts`) keeps the full matrix.
 */
export const FORMS_LAB_ENTRIES: readonly ComponentsLabEntry[] = [
  {
    id: 'text-input',
    name: 'Text input',
    group: 'Unified',
    note: 'Free text on one line, in three densities: the 36px form field, the 28px compact field for toolbars, and the 28px settings field. Fields are rounded rectangles; only buttons are capsules. An icon button inside the field is a FieldButton, which takes its corner from the field.',
    source: `${PRIMITIVES_SRC}/Field.tsx`,
    components: ['TextInput'],
    prs: [7214, 7219, 7220, 7221, 7222, 7223, 7224, 7255, 7257],
    Stage: FieldsStage,
    View: TextInputSpecimen,
  },
  {
    id: 'text-area',
    name: 'Text area',
    group: 'Unified',
    note: 'Free text over several lines.',
    source: `${PRIMITIVES_SRC}/Field.tsx`,
    components: ['TextArea'],
    prs: [],
    View: TextAreaSpecimen,
  },
  {
    id: 'select',
    name: 'Select',
    group: 'Unified',
    note: 'Drawn by the app, not the OS: a field trigger that opens the shared picker menu, with a checkmark on the chosen row. Select is the 36px form field; SettingsSelect is the 28px one for Settings rows, dialogs, toolbars and filters.',
    source: `${PRIMITIVES_SRC}/{Field,SettingsSelect}.tsx`,
    components: ['Select'],
    prs: [],
    View: SelectSpecimen,
  },
  {
    id: 'date-field',
    name: 'Date field',
    group: 'Unified',
    note: 'The 36px Select trigger opening a month calendar; its value is a local YYYY-MM-DD day.',
    source: `${PRIMITIVES_SRC}/DateField.tsx`,
    prs: [],
    View: DateFieldSpecimen,
  },
  {
    id: 'search-field',
    name: 'Search field',
    group: 'Unified',
    note: "A search or filter query: the 28px field of toolbars and panels and the 32px field of a page search row, with the result count and Clear at its end. Its buttons nest: the field's corner less their inset. Each of those buttons is a FieldButton.",
    source: `${PRIMITIVES_SRC}/SearchField.tsx, ${SRC}/PageSearchRow.tsx`,
    components: ['SearchField', 'FieldButton'],
    prs: [],
    View: SearchFieldSpecimen,
  },
  {
    id: 'inline-text-input',
    name: 'Inline text input',
    group: 'Unified',
    note: 'Renames a title, tab or row where it sits: no box at rest, the field focus edge while editing. Enter commits, Escape restores the saved value, and leaving the field commits.',
    source: `${PRIMITIVES_SRC}/InlineTextInput.tsx`,
    prs: [],
    View: InlineTextInputSpecimen,
  },
  {
    id: 'form-field',
    name: 'Form field and errors',
    group: 'Unified',
    note: 'One labelled field: the label, the control, its error and its help text, 6px apart in that order. Help text sits under the field and the error comes first.',
    source: `${PRIMITIVES_SRC}/FormField.tsx`,
    prs: [],
    View: FormFieldSpecimen,
  },
  {
    id: 'checkbox-radio',
    name: 'Checkbox and radio',
    group: 'Unified',
    note: 'A radio looks like a radio and a checkbox like a checkbox: 16px marks, the checkbox with a 5px corner. ChoiceList rows hold a short list ticked in place.',
    source: `${PRIMITIVES_SRC}/{Choice,ChoiceList}.tsx`,
    prs: [],
    View: CheckboxRadioSpecimen,
  },
  {
    id: 'toggle-switch',
    name: 'Toggle switch',
    group: 'Unified',
    note: 'On or off, applied at once. The label is required: the track has no text.',
    source: `${PRIMITIVES_SRC}/ToggleSwitch.tsx`,
    prs: [],
    View: ToggleSwitchSpecimen,
  },
  {
    id: 'toolbar-chips',
    name: 'Toolbar chips',
    group: 'Unified',
    note: 'The composer’s model and effort pickers are toolbar chips, not form fields, so they stay capsules.',
    source: `${SRC}/{ModelPickerTriggerControl,ThinkingLevelControl}.tsx`,
    prs: [],
    View: ToolbarChipsSpecimen,
  },
];
