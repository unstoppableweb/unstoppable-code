import {
  Fragment,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type ReactNode,
} from 'react';
import {
  Button,
  Checkbox,
  ChoiceList,
  ChoiceListRow,
  DateField,
  DialogFormField,
  DialogModal,
  FieldError,
  FilterDropdown,
  FormField,
  Heading,
  InlineTextInput,
  ModelPickerTriggerControl,
  PageSearchControls,
  PageSearchField,
  PageSearchRow,
  Radio,
  SearchField,
  SegmentedControl,
  Select,
  type SelectOption,
  SettingsSelect,
  SortDropdown,
  Surface,
  TextArea,
  TextInput,
  type TextInputDensity,
  type TextInputProps,
  ThinkingLevelControl,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import {
  THINKING_LEVELS as CANONICAL_THINKING_LEVELS,
  type ThinkingLevel,
} from '@canopy/protocol/thinking';
import { SearchIcon, SparkleIcon } from '@canopy/ui-shared/icons/AppIcons';
import { applyTheme } from '@/lib/theme';

/**
 * Localhost lab for trying every shared form field by hand
 * (`fields-lab.vite.mts`, port 5186). It mounts only the real shared
 * components; nothing here restyles them.
 *
 * - `?view=states`: one row per component and size, one column per state.
 * - default: a playground with a settings form, a dialog form, an inline
 *   rename, a search row, and a field beside capsule buttons, so tab order,
 *   focus, Escape, and menus can be tried.
 *
 * Only one element can hold focus, so the Focused column focuses one cell at
 * a time (Focus buttons, or Cycle focus). Hover and pressed can only be
 * judged live with the pointer.
 */

type ColorMode = 'light' | 'dark';
type LabView = 'playground' | 'states';
type OpenMenu = 'none' | 'select' | 'settings-select';

interface LabFlags {
  readonly allDisabled: boolean;
  readonly allInvalid: boolean;
}

const LabFlagsContext = createContext<LabFlags>({
  allDisabled: false,
  allInvalid: false,
});

const LONG_VALUE =
  'A very long value that keeps going well past the edge of the field so the overflow can be judged';

const ENVIRONMENTS: readonly SelectOption[] = [
  { value: 'staging', label: 'Staging' },
  { value: 'production', label: 'Production' },
  { value: 'preview', label: 'Preview (unavailable)', disabled: true },
];

const ROLES = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
  { value: 'owner', label: 'Owner' },
] as const;

// The effort control's levels, from the one thinking vocabulary (no local
// copy of the list), without `low` and `ultra`.
const THINKING_LEVELS: readonly ThinkingLevel[] =
  CANONICAL_THINKING_LEVELS.filter(
    (level) => level !== 'low' && level !== 'ultra',
  );

function initialView(): LabView {
  return new URLSearchParams(window.location.search).get('view') === 'states'
    ? 'states'
    : 'playground';
}

function initialColorMode(): ColorMode {
  return new URLSearchParams(window.location.search).get('theme') === 'dark'
    ? 'dark'
    : 'light';
}

/**
 * Focuses (or clicks open) the first control inside it while `active`, so a
 * state is drawn by the real browser state rather than a fake class.
 */
function Drive({
  active,
  action,
  children,
}: {
  readonly active: boolean;
  readonly action: 'focus' | 'open';
  readonly children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const target = ref.current?.querySelector<HTMLElement>(
      'input, textarea, select, button[role="combobox"], button, [tabindex]',
    );
    // preventScroll keeps the grid where it is; the cell is already in view.
    if (action === 'focus') target?.focus({ preventScroll: true });
    else target?.click();
  }, [active, action]);
  return (
    <div ref={ref} className="flex min-w-0">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- states --

const STATE_COLUMNS = [
  'Empty, placeholder',
  'Filled',
  'Long value',
  'Focused',
  'Disabled',
  'Read-only',
  'Invalid + error',
  'Help text',
  'Error + help',
  'Leading / trailing',
] as const;

type StateColumn = (typeof STATE_COLUMNS)[number];

interface StateRow {
  readonly id: string;
  readonly name: string;
  readonly cell: (state: StateColumn, focused: boolean) => ReactNode;
}

const NOT_APPLICABLE = <span className="text-xs fg-quaternary">—</span>;

function textInputRow(density: TextInputDensity, name: string): StateRow {
  return {
    id: `text-${density}`,
    name,
    cell: (state, focused): ReactNode => {
      const base = {
        density,
        'aria-label': `${name} ${state}`,
        placeholder: 'Organization name',
      } as const;
      switch (state) {
        case 'Empty, placeholder':
          return <FlaggedTextInput {...base} />;
        case 'Filled':
          return <FlaggedTextInput {...base} defaultValue="Acme" />;
        case 'Long value':
          return <FlaggedTextInput {...base} defaultValue={LONG_VALUE} />;
        case 'Focused':
          return (
            <Drive active={focused} action="focus">
              <TextInput {...base} defaultValue="Acme" />
            </Drive>
          );
        case 'Disabled':
          return <TextInput {...base} defaultValue="Acme" disabled />;
        case 'Read-only':
          return <TextInput {...base} defaultValue="Acme" readOnly />;
        case 'Invalid + error':
          return (
            <FormField label="Name" error="Enter a name.">
              {(control) => <TextInput {...control} density={density} />}
            </FormField>
          );
        case 'Help text':
          return (
            <FormField label="Name" description="Shown to your team.">
              {(control) => (
                <TextInput {...control} density={density} defaultValue="Acme" />
              )}
            </FormField>
          );
        case 'Error + help':
          return (
            <FormField
              label="Name"
              description="Shown to your team."
              error="Enter a name."
            >
              {(control) => <TextInput {...control} density={density} />}
            </FormField>
          );
        case 'Leading / trailing':
          return (
            <div className="flex w-full flex-col gap-2">
              <TextInput
                density={density}
                leading="@"
                defaultValue="daniil"
                aria-label="Username"
              />
              <TextInput
                density={density}
                trailing="days"
                defaultValue="30"
                aria-label="Retention"
              />
              <TextInput
                density={density}
                leading={<SearchIcon size={14} />}
                defaultValue="With an icon"
                aria-label="Icon adornment"
              />
            </div>
          );
      }
    },
  };
}

function FlaggedTextInput(props: TextInputProps): JSX.Element {
  const flags = useContext(LabFlagsContext);
  return (
    <TextInput
      {...props}
      disabled={flags.allDisabled || props.disabled}
      aria-invalid={flags.allInvalid || undefined}
    />
  );
}

const TEXT_AREA_ROW: StateRow = {
  id: 'textarea',
  name: 'TextArea',
  cell: (state, focused): ReactNode => {
    const base = {
      'aria-label': `TextArea ${state}`,
      placeholder: 'Tell people what you build.',
    } as const;
    switch (state) {
      case 'Empty, placeholder':
        return <TextArea {...base} />;
      case 'Filled':
        return <TextArea {...base} defaultValue="I build developer tools." />;
      case 'Long value':
        return (
          <TextArea {...base} defaultValue={`${LONG_VALUE}. ${LONG_VALUE}.`} />
        );
      case 'Focused':
        return (
          <Drive active={focused} action="focus">
            <TextArea {...base} defaultValue="I build developer tools." />
          </Drive>
        );
      case 'Disabled':
        return <TextArea {...base} defaultValue="I build tools." disabled />;
      case 'Read-only':
        return <TextArea {...base} defaultValue="I build tools." readOnly />;
      case 'Invalid + error':
        return (
          <FormField label="Bio" error="Write a short bio.">
            {(control) => <TextArea {...control} />}
          </FormField>
        );
      case 'Help text':
        return (
          <FormField label="Bio" description="Up to 160 characters.">
            {(control) => (
              <TextArea {...control} defaultValue="I build tools." />
            )}
          </FormField>
        );
      case 'Error + help':
        return (
          <FormField
            label="Bio"
            description="Up to 160 characters."
            error="Write a short bio."
          >
            {(control) => <TextArea {...control} />}
          </FormField>
        );
      case 'Leading / trailing':
        return NOT_APPLICABLE;
    }
  },
};

function selectCell(
  kind: 'select' | 'settings-select',
  state: StateColumn,
  focused: boolean,
): ReactNode {
  const render = (props: {
    readonly value: string | null;
    readonly disabled?: boolean;
    readonly id?: string;
    readonly 'aria-describedby'?: string;
    readonly 'aria-invalid'?: true;
  }): JSX.Element =>
    kind === 'select' ? (
      <Select
        {...props}
        aria-label="Environment"
        placeholder="Choose an environment"
        options={ENVIRONMENTS}
        onValueChange={() => undefined}
      />
    ) : (
      <SettingsSelect
        id={props.id}
        aria-describedby={props['aria-describedby']}
        aria-invalid={props['aria-invalid']}
        aria-label="Environment"
        value={props.value}
        disabled={props.disabled}
        placeholder="Choose"
        options={ENVIRONMENTS}
        onValueChange={() => undefined}
      />
    );
  switch (state) {
    case 'Empty, placeholder':
      return render({ value: null });
    case 'Filled':
      return render({ value: 'staging' });
    case 'Long value':
      return kind === 'select' ? (
        <Select
          aria-label="Long"
          options={[{ value: 'long', label: LONG_VALUE }]}
          value="long"
          onValueChange={() => undefined}
        />
      ) : (
        <SettingsSelect
          aria-label="Long"
          options={[{ value: 'long', label: LONG_VALUE }]}
          value="long"
          onValueChange={() => undefined}
        />
      );
    case 'Focused':
      return (
        <Drive active={focused} action="focus">
          {render({ value: 'staging' })}
        </Drive>
      );
    case 'Disabled':
      return render({ value: 'staging', disabled: true });
    case 'Read-only':
      return NOT_APPLICABLE;
    case 'Invalid + error':
      return (
        <FormField label="Environment" error="Choose an environment.">
          {(control) => render({ ...control, value: null })}
        </FormField>
      );
    case 'Help text':
      return (
        <FormField label="Environment" description="Where previews deploy.">
          {(control) => render({ ...control, value: 'staging' })}
        </FormField>
      );
    case 'Error + help':
      return (
        <FormField
          label="Environment"
          description="Where previews deploy."
          error="Choose an environment."
        >
          {(control) => render({ ...control, value: null })}
        </FormField>
      );
    case 'Leading / trailing':
      return NOT_APPLICABLE;
  }
}

function dateCell(state: StateColumn, focused: boolean): ReactNode {
  const render = (props: {
    readonly value: string;
    readonly disabled?: boolean;
    readonly id?: string;
    readonly 'aria-describedby'?: string;
    readonly 'aria-invalid'?: true;
  }): JSX.Element => (
    <DateField
      {...props}
      aria-label="Start date"
      onValueChange={() => undefined}
    />
  );
  switch (state) {
    case 'Empty, placeholder':
      return render({ value: '' });
    case 'Filled':
      return render({ value: '2026-11-04' });
    case 'Long value':
      return NOT_APPLICABLE;
    case 'Focused':
      return (
        <Drive active={focused} action="focus">
          {render({ value: '2026-11-04' })}
        </Drive>
      );
    case 'Disabled':
      return render({ value: '2026-11-04', disabled: true });
    case 'Read-only':
      return NOT_APPLICABLE;
    case 'Invalid + error':
      return (
        <FormField label="Start date" error="Choose a date.">
          {(control) => render({ ...control, value: '' })}
        </FormField>
      );
    case 'Help text':
      return (
        <FormField label="Start date" description="The first day it runs.">
          {(control) => render({ ...control, value: '2026-11-04' })}
        </FormField>
      );
    case 'Error + help':
      return (
        <FormField
          label="Start date"
          description="The first day it runs."
          error="Choose a date."
        >
          {(control) => render({ ...control, value: '' })}
        </FormField>
      );
    case 'Leading / trailing':
      return NOT_APPLICABLE;
  }
}

function searchRow(size: 'sm' | 'md'): StateRow {
  return {
    id: `search-${size}`,
    name: `SearchField ${size === 'sm' ? '28px' : '32px'}`,
    cell: (state, focused): ReactNode => {
      switch (state) {
        case 'Empty, placeholder':
          return <ControlledSearch size={size} initial="" />;
        case 'Filled':
          return (
            <ControlledSearch size={size} initial="deploy" count="2 of 6" />
          );
        case 'Long value':
          return <ControlledSearch size={size} initial={LONG_VALUE} />;
        case 'Focused':
          return (
            <Drive active={focused} action="focus">
              <ControlledSearch size={size} initial="deploy" />
            </Drive>
          );
        case 'Disabled':
          return <ControlledSearch size={size} initial="" disabled />;
        default:
          return NOT_APPLICABLE;
      }
    },
  };
}

function ControlledSearch({
  size,
  initial,
  count,
  disabled,
}: {
  readonly size: 'sm' | 'md';
  readonly initial: string;
  readonly count?: string;
  readonly disabled?: boolean;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <SearchField
      size={size}
      value={value}
      onValueChange={setValue}
      aria-label="Search workflows"
      placeholder="Search workflows"
      count={value ? count : undefined}
      disabled={disabled}
      className="w-full"
    />
  );
}

const INLINE_ROW: StateRow = {
  id: 'inline',
  name: 'InlineTextInput (at rest / editing)',
  cell: (state, focused): ReactNode => {
    switch (state) {
      case 'Empty, placeholder':
        return <LabInline initial="" placeholder="Untitled chat" />;
      case 'Filled':
        return <LabInline initial="Fix login redirect" />;
      case 'Long value':
        return <LabInline initial={LONG_VALUE} />;
      case 'Focused':
        return (
          <Drive active={focused} action="focus">
            <LabInline initial="Fix login redirect" />
          </Drive>
        );
      case 'Disabled':
        return <LabInline initial="Fix login redirect" disabled />;
      case 'Read-only':
        return <LabInline initial="Fix login redirect" readOnly />;
      default:
        return NOT_APPLICABLE;
    }
  },
};

function LabInline({
  initial,
  placeholder,
  disabled,
  readOnly,
}: {
  readonly initial: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <InlineTextInput
      aria-label="Chat title"
      value={value}
      onCommit={setValue}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
    />
  );
}

const DIALOG_FIELD_ROW: StateRow = {
  id: 'dialog-field',
  name: 'DialogFormField',
  cell: (state): ReactNode => {
    switch (state) {
      case 'Filled':
        return (
          <DialogFormField label="Organization name" htmlFor="lab-dialog-name">
            <TextInput
              id="lab-dialog-name"
              density="settings"
              defaultValue="Acme"
            />
          </DialogFormField>
        );
      case 'Help text':
        return (
          <DialogFormField
            label="Organization name"
            htmlFor="lab-dialog-help"
            description="You can change this later."
          >
            <TextInput
              id="lab-dialog-help"
              density="settings"
              defaultValue="Acme"
            />
          </DialogFormField>
        );
      case 'Error + help':
        return (
          <DialogFormField
            label="Organization name"
            htmlFor="lab-dialog-error"
            description="You can change this later."
            error="Enter a name."
          >
            <TextInput
              id="lab-dialog-error"
              density="settings"
              aria-invalid
              aria-describedby="lab-dialog-error-error"
            />
          </DialogFormField>
        );
      case 'Disabled':
        return (
          <DialogFormField label="Role" htmlFor="lab-dialog-role">
            <SettingsSelect
              id="lab-dialog-role"
              value="member"
              options={ROLES}
              onValueChange={() => undefined}
              disabled
            />
          </DialogFormField>
        );
      default:
        return NOT_APPLICABLE;
    }
  },
};

const FIELD_ERROR_ROW: StateRow = {
  id: 'field-error',
  name: 'FieldError alone',
  cell: (state): ReactNode =>
    state === 'Invalid + error' ? (
      <div className="flex flex-col gap-2">
        <FieldError id="lab-error">
          Enter a name. A longer message wraps under the glyph like this.
        </FieldError>
        <FieldError id="lab-error-announced" announce>
          Couldn’t save. With announce, it is read out when it appears.
        </FieldError>
      </div>
    ) : (
      NOT_APPLICABLE
    ),
};

const CHOICE_LIST_ROW: StateRow = {
  id: 'choice-list',
  name: 'ChoiceList rows',
  cell: (state, focused): ReactNode => {
    switch (state) {
      case 'Empty, placeholder':
      case 'Filled':
        return (
          <ChoiceList aria-label="Notify me" className="w-full">
            <ChoiceListRow selected={state === 'Filled'}>
              Pull requests
            </ChoiceListRow>
            <ChoiceListRow selected={false}>Mentions</ChoiceListRow>
          </ChoiceList>
        );
      case 'Focused':
        return (
          <Drive active={focused} action="focus">
            <ChoiceList aria-label="Plan" className="w-full">
              <ChoiceListRow kind="radio" selected>
                Team
              </ChoiceListRow>
            </ChoiceList>
          </Drive>
        );
      case 'Disabled':
        return (
          <ChoiceList aria-label="Plan" className="w-full">
            <ChoiceListRow
              kind="radio"
              selected={false}
              disabled
              trailing="Soon"
            >
              Enterprise
            </ChoiceListRow>
          </ChoiceList>
        );
      case 'Long value':
        return (
          <ChoiceList aria-label="Repos" className="w-full">
            <ChoiceListRow selected>{LONG_VALUE}</ChoiceListRow>
          </ChoiceList>
        );
      default:
        return NOT_APPLICABLE;
    }
  },
};

const TOGGLE_ROW: StateRow = {
  id: 'toggle',
  name: 'ToggleSwitch',
  cell: (state, focused): ReactNode => {
    switch (state) {
      case 'Empty, placeholder':
        return <LabToggle initial={false} />;
      case 'Filled':
        return <LabToggle initial />;
      case 'Focused':
        return (
          <Drive active={focused} action="focus">
            <LabToggle initial />
          </Drive>
        );
      case 'Disabled':
        return (
          <div className="flex gap-3">
            <ToggleSwitch
              label="Off, disabled"
              checked={false}
              disabled
              onChange={() => undefined}
            />
            <ToggleSwitch
              label="On, disabled"
              checked
              disabled
              onChange={() => undefined}
            />
          </div>
        );
      default:
        return NOT_APPLICABLE;
    }
  },
};

function LabToggle({ initial }: { readonly initial: boolean }): JSX.Element {
  const [checked, setChecked] = useState(initial);
  return (
    <ToggleSwitch
      label="Notifications"
      checked={checked}
      onChange={setChecked}
    />
  );
}

const CAPSULE_ROW: StateRow = {
  id: 'capsules',
  name: 'Toolbar chips (stay capsules)',
  cell: (state, focused): ReactNode => {
    switch (state) {
      case 'Filled':
        return <ChipTriggers />;
      case 'Focused':
        return (
          <Drive active={focused} action="focus">
            <ModelPickerTriggerControl
              icon={<SparkleIcon size={14} />}
              label="Opus 5.5"
            />
          </Drive>
        );
      case 'Disabled':
        return (
          <ModelPickerTriggerControl
            icon={<SparkleIcon size={14} />}
            label="Opus 5.5"
            disabled
          />
        );
      default:
        return NOT_APPLICABLE;
    }
  },
};

function ChipTriggers(): JSX.Element {
  const [level, setLevel] = useState<ThinkingLevel | undefined>('high');
  return (
    <div className="flex flex-wrap items-center gap-1">
      <ModelPickerTriggerControl
        icon={<SparkleIcon size={14} />}
        label="Opus 5.5"
      />
      <ThinkingLevelControl
        variant="capsule"
        value={level}
        supportedLevels={THINKING_LEVELS}
        onChange={setLevel}
      />
    </div>
  );
}

const STATE_ROWS: readonly StateRow[] = [
  textInputRow('default', 'TextInput 36px'),
  textInputRow('compact', 'TextInput compact 28px'),
  textInputRow('settings', 'TextInput settings 28px'),
  TEXT_AREA_ROW,
  {
    id: 'select',
    name: 'Select 36px',
    cell: (state, focused) => selectCell('select', state, focused),
  },
  {
    id: 'settings-select',
    name: 'SettingsSelect 28px',
    cell: (state, focused) => selectCell('settings-select', state, focused),
  },
  {
    id: 'date-field',
    name: 'DateField 36px',
    cell: (state, focused) => dateCell(state, focused),
  },
  searchRow('sm'),
  searchRow('md'),
  INLINE_ROW,
  DIALOG_FIELD_ROW,
  FIELD_ERROR_ROW,
  CHOICE_LIST_ROW,
  TOGGLE_ROW,
  CAPSULE_ROW,
];

const CHOICE_MATRIX_ROWS = [
  {
    id: 'radio-off',
    name: 'Radio, unselected',
    kind: 'radio',
    checked: false,
    mixed: false,
  },
  {
    id: 'radio-on',
    name: 'Radio, selected',
    kind: 'radio',
    checked: true,
    mixed: false,
  },
  {
    id: 'checkbox-off',
    name: 'Checkbox, unselected',
    kind: 'checkbox',
    checked: false,
    mixed: false,
  },
  {
    id: 'checkbox-on',
    name: 'Checkbox, selected',
    kind: 'checkbox',
    checked: true,
    mixed: false,
  },
  {
    id: 'checkbox-mixed',
    name: 'Checkbox, mixed',
    kind: 'checkbox',
    checked: false,
    mixed: true,
  },
] as const;

const CHOICE_MATRIX_COLUMNS = [
  'Default',
  'Hover',
  'Pressed',
  'Focused',
  'Disabled',
] as const;

/**
 * The reference matrix for the choice marks. Hover and pressed use the
 * marks' `forceState` prop, which applies the same classes as the live
 * states (lab and visual tests only); focus is real browser focus.
 */
function ChoiceMatrix(): JSX.Element {
  // Nothing here holds focus until a Focus button asks; the grid below
  // starts with its first row focused. A Focus button is a pointer press, so
  // the browser draws a mark's :focus-visible ring only after a key press
  // (Tab, or Shift then Focus).
  const [focusRow, setFocusRow] = useState('');
  return (
    <div className="flex flex-col gap-2">
      <Heading level={2} variant="title">
        Radio and checkbox
      </Heading>
      <Surface variant="group" className="w-max">
        <div
          className="grid gap-px"
          style={{
            gridTemplateColumns: `200px repeat(${CHOICE_MATRIX_COLUMNS.length}, 120px)`,
            width: 'max-content',
          }}
        >
          <Surface variant="pane" padding="tight">
            <span className="text-xs font-medium fg-tertiary">Mark</span>
          </Surface>
          {CHOICE_MATRIX_COLUMNS.map((column) => (
            <Surface key={column} variant="pane" padding="tight">
              <span className="text-xs font-medium fg-tertiary">{column}</span>
            </Surface>
          ))}
          {CHOICE_MATRIX_ROWS.map((row) => (
            <Fragment key={row.id}>
              <Surface variant="pane" padding="tight">
                <div className="flex flex-col items-start gap-1 text-xs">
                  <span>{row.name}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setFocusRow(row.id)}
                  >
                    Focus
                  </Button>
                </div>
              </Surface>
              {CHOICE_MATRIX_COLUMNS.map((column) => {
                const props = {
                  'aria-label': `${row.name}, ${column}`,
                  checked: row.checked,
                  readOnly: true,
                  disabled: column === 'Disabled',
                  forceState:
                    column === 'Hover'
                      ? ('hover' as const)
                      : column === 'Pressed'
                        ? ('pressed' as const)
                        : undefined,
                };
                const mark =
                  row.kind === 'radio' ? (
                    <Radio {...props} />
                  ) : (
                    <Checkbox {...props} indeterminate={row.mixed} />
                  );
                return (
                  <Surface
                    key={column}
                    variant="pane"
                    className="flex flex-col justify-center"
                    data-row={row.id}
                    data-state={column}
                  >
                    <div className="flex min-h-12 items-center justify-center">
                      {column === 'Focused' ? (
                        <Drive active={focusRow === row.id} action="focus">
                          {mark}
                        </Drive>
                      ) : (
                        mark
                      )}
                    </div>
                  </Surface>
                );
              })}
            </Fragment>
          ))}
        </div>
      </Surface>
    </div>
  );
}

function StatesView({
  openMenu,
}: {
  readonly openMenu: OpenMenu;
}): JSX.Element {
  const rows = STATE_ROWS;
  const [focusRow, setFocusRow] = useState(rows[0]?.id ?? '');
  const [cycle, setCycle] = useState(false);

  useEffect(() => {
    if (!cycle) return undefined;
    const timer = window.setInterval(() => {
      setFocusRow((current) => {
        const index = rows.findIndex((row) => row.id === current);
        return rows[(index + 1) % rows.length]?.id ?? current;
      });
    }, 1500);
    return (): void => window.clearInterval(timer);
  }, [cycle, rows]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 text-xs fg-secondary">
        <span>
          Focused column: one cell holds focus at a time (now:{' '}
          <span className="fg-primary">
            {rows.find((row) => row.id === focusRow)?.name}
          </span>
          ).
        </span>
        <ToggleSwitch label="Cycle focus" checked={cycle} onChange={setCycle} />
        <span>Cycle focus</span>
      </div>
      <ChoiceMatrix />
      <div className="overflow-x-auto">
        <Surface variant="group" className="w-max">
          <div
            className="grid gap-px"
            style={{
              gridTemplateColumns: `200px repeat(${STATE_COLUMNS.length + 1}, 260px)`,
              width: 'max-content',
            }}
          >
            <Surface variant="pane" padding="tight">
              <span className="text-xs font-medium fg-tertiary">Component</span>
            </Surface>
            {STATE_COLUMNS.map((column) => (
              <Surface key={column} variant="pane" padding="tight">
                <span className="text-xs font-medium fg-tertiary">
                  {column}
                </span>
              </Surface>
            ))}
            <Surface variant="pane" padding="tight">
              <span className="text-xs font-medium fg-tertiary">
                Opened (menu)
              </span>
            </Surface>
            {rows.map((row) => (
              <RowCells
                key={row.id}
                row={row}
                focused={focusRow === row.id}
                onFocusRow={() => setFocusRow(row.id)}
                openMenu={openMenu}
              />
            ))}
          </div>
        </Surface>
      </div>
    </div>
  );
}

/**
 * The states grid on its own, for the components library: no menu forced
 * open and the lab's All disabled / All invalid flags off.
 */
export function FieldsStatesGrid(): JSX.Element {
  return <StatesView openMenu="none" />;
}

/** The playground forms on their own, for the components library. */
export function FieldsPlayground(): JSX.Element {
  return <PlaygroundView />;
}

function RowCells({
  row,
  focused,
  onFocusRow,
  openMenu,
}: {
  readonly row: StateRow;
  readonly focused: boolean;
  readonly onFocusRow: () => void;
  readonly openMenu: OpenMenu;
}): JSX.Element {
  const opened =
    row.id === 'select' || row.id === 'settings-select' ? (
      <Drive active={openMenu === row.id} action="open">
        {row.id === 'select' ? (
          <Select
            aria-label="Environment, opened"
            options={ENVIRONMENTS}
            value="staging"
            onValueChange={() => undefined}
          />
        ) : (
          <SettingsSelect
            aria-label="Role, opened"
            options={ROLES}
            value="member"
            onValueChange={() => undefined}
          />
        )}
      </Drive>
    ) : (
      NOT_APPLICABLE
    );
  return (
    <>
      <Surface variant="pane" padding="tight">
        <div className="flex flex-col items-start gap-1 text-xs fg-primary">
          <span>{row.name}</span>
          <Button size="sm" variant="ghost" onClick={onFocusRow}>
            Focus
          </Button>
        </div>
      </Surface>
      {STATE_COLUMNS.map((column) => (
        <Surface
          key={column}
          variant="pane"
          padding="compact"
          className="flex flex-col justify-center"
          data-state={column}
          data-row={row.id}
        >
          <div className="flex min-h-10 items-center">
            <div className="w-full">{row.cell(column, focused)}</div>
          </div>
        </Surface>
      ))}
      <Surface
        variant="pane"
        padding="compact"
        className="flex flex-col justify-center"
      >
        <div className="flex min-h-10 items-center">{opened}</div>
      </Surface>
    </>
  );
}

// ------------------------------------------------------------ playground --

function SettingsFormDemo(): JSX.Element {
  const flags = useContext(LabFlagsContext);
  const [name, setName] = useState('');
  const [retention, setRetention] = useState('30');
  const [environment, setEnvironment] = useState<string | null>(null);
  const [role, setRole] = useState<(typeof ROLES)[number]['value']>('member');
  const [bio, setBio] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [emails, setEmails] = useState(true);
  const nameError =
    flags.allInvalid || (submitted && name.trim() === '')
      ? 'Enter an organization name.'
      : null;
  const environmentError =
    flags.allInvalid || (submitted && environment === null)
      ? 'Choose an environment.'
      : null;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSubmitted(true);
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <FormField
        label="Organization name"
        description="Shown to everyone you invite."
        error={nameError}
      >
        {(control) => (
          <TextInput
            {...control}
            density="settings"
            value={name}
            placeholder="Acme Engineering"
            disabled={flags.allDisabled}
            onChange={(event) => {
              setName(event.target.value);
              setSubmitted(false);
            }}
          />
        )}
      </FormField>
      <FormField
        label="Keep history for"
        description="Older chats are archived."
      >
        {(control) => (
          <div className="w-36">
            <TextInput
              {...control}
              density="settings"
              type="number"
              trailing="days"
              value={retention}
              disabled={flags.allDisabled}
              onChange={(event) => setRetention(event.target.value)}
            />
          </div>
        )}
      </FormField>
      <FormField label="Preview environment" error={environmentError}>
        {(control) => (
          // 28px fields here, so the 28px dropdown (forms.md, which dropdown).
          <SettingsSelect
            id={control.id}
            aria-describedby={control['aria-describedby']}
            aria-invalid={control['aria-invalid']}
            width="field"
            placeholder="Choose an environment"
            options={ENVIRONMENTS}
            value={environment}
            disabled={flags.allDisabled}
            onValueChange={(next) => {
              setEnvironment(next);
              setSubmitted(false);
            }}
          />
        )}
      </FormField>
      <FormField label="Default role">
        {(control) => (
          <SettingsSelect
            id={control.id}
            aria-describedby={control['aria-describedby']}
            value={role}
            options={ROLES}
            disabled={flags.allDisabled}
            onValueChange={setRole}
          />
        )}
      </FormField>
      <FormField label="Bio (optional)" description="Up to 160 characters.">
        {(control) => (
          <TextArea
            {...control}
            rows={3}
            value={bio}
            disabled={flags.allDisabled}
            onChange={(event) => setBio(event.target.value)}
          />
        )}
      </FormField>
      <div className="flex items-center gap-3">
        <ToggleSwitch
          label="Email me about updates"
          checked={emails}
          disabled={flags.allDisabled}
          onChange={setEmails}
        />
        <span className="text-xs fg-primary">Email me about updates</span>
      </div>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="compact"
          variant="primary"
          disabled={flags.allDisabled}
        >
          Save
        </Button>
        <Button
          type="button"
          size="compact"
          variant="secondary"
          onClick={() => {
            setSubmitted(false);
            setName('');
            setEnvironment(null);
          }}
        >
          Reset
        </Button>
      </div>
    </form>
  );
}

/** A form of 36px fields: the 36px Select belongs here. */
function TallFormDemo(): JSX.Element {
  const flags = useContext(LabFlagsContext);
  const [title, setTitle] = useState('');
  const [environment, setEnvironment] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
      }}
    >
      <FormField
        label="Title"
        error={
          flags.allInvalid || (submitted && title.trim() === '')
            ? 'Enter a title.'
            : null
        }
      >
        {(control) => (
          <TextInput
            {...control}
            value={title}
            placeholder="Release notes"
            disabled={flags.allDisabled}
            onChange={(event) => {
              setTitle(event.target.value);
              setSubmitted(false);
            }}
          />
        )}
      </FormField>
      <FormField
        label="Environment"
        error={
          flags.allInvalid || (submitted && environment === null)
            ? 'Choose an environment.'
            : null
        }
      >
        {(control) => (
          <Select
            {...control}
            options={ENVIRONMENTS}
            value={environment}
            disabled={flags.allDisabled}
            onValueChange={(next) => {
              setEnvironment(next);
              setSubmitted(false);
            }}
          />
        )}
      </FormField>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="lg"
          variant="primary"
          disabled={flags.allDisabled}
        >
          Create
        </Button>
      </div>
    </form>
  );
}

function TwoFactorRowDemo(): JSX.Element {
  const flags = useContext(LabFlagsContext);
  const [code, setCode] = useState('');
  return (
    <FormField
      label="Authentication code"
      error={flags.allInvalid ? 'Enter the 6-digit code.' : null}
    >
      {(control) => (
        <div className="flex items-center gap-2">
          <div className="w-40">
            <TextInput
              {...control}
              density="settings"
              mono
              inputMode="numeric"
              value={code}
              placeholder="123456"
              disabled={flags.allDisabled}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
          <Button size="compact" variant="primary" disabled={flags.allDisabled}>
            Verify
          </Button>
          <Button size="compact" variant="secondary">
            Cancel
          </Button>
        </div>
      )}
    </FormField>
  );
}

function SearchRowDemo(): JSX.Element {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<readonly ('running' | 'done')[]>([]);
  const [sort, setSort] = useState<'recent' | 'name'>('recent');
  return (
    <PageSearchRow>
      <PageSearchField
        value={query}
        onValueChange={setQuery}
        aria-label="Search workflows"
        placeholder="Search workflows"
        count={query ? '2 of 6' : undefined}
      />
      <PageSearchControls>
        <FilterDropdown
          title="Status"
          label={status.length === 0 ? 'Any status' : status.join(', ')}
          anyLabel="Any status"
          options={[
            { value: 'running', label: 'Running', count: 2 },
            { value: 'done', label: 'Done', count: 4 },
          ]}
          selected={status}
          onToggle={(value) =>
            setStatus((current) =>
              current.includes(value)
                ? current.filter((entry) => entry !== value)
                : [...current, value],
            )
          }
          onClear={() => setStatus([])}
          multiple
          size="page"
          testId="lab-status-filter"
        />
        <SortDropdown
          value={sort}
          options={[
            { value: 'recent', label: 'Recently run' },
            { value: 'name', label: 'Name' },
          ]}
          onChange={setSort}
          testId="lab-sort"
        />
      </PageSearchControls>
    </PageSearchRow>
  );
}

function InlineRenameDemo(): JSX.Element {
  const [title, setTitle] = useState('Fix login redirect');
  const [log, setLog] = useState<readonly string[]>([]);
  return (
    <div className="flex flex-col gap-2">
      <InlineTextInput
        aria-label="Chat title"
        value={title}
        onCommit={(next) => {
          const trimmed = next.trim();
          if (trimmed === '') {
            setLog((current) => ['Rejected an empty title', ...current]);
            return;
          }
          setTitle(trimmed);
          setLog((current) => [`Committed “${trimmed}”`, ...current]);
        }}
        onCancel={() => setLog((current) => ['Cancelled', ...current])}
      />
      <p className="text-xs fg-tertiary">
        Enter commits, Escape restores, clicking away commits. Last:{' '}
        {log[0] ?? 'nothing yet'}
      </p>
    </div>
  );
}

function DialogDemo(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof ROLES)[number]['value']>('member');
  const [submitted, setSubmitted] = useState(false);
  const invalid = submitted && !email.includes('@');
  return (
    <>
      <div>
        <Button
          size="compact"
          variant="secondary"
          onClick={() => setOpen(true)}
        >
          Open the invite dialog
        </Button>
      </div>
      {open ? (
        <DialogModal
          title="Invite a teammate"
          onClose={() => {
            setOpen(false);
            setSubmitted(false);
          }}
          maxWidth="md"
        >
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(true);
            }}
          >
            <DialogFormField
              label="Email"
              htmlFor="lab-invite-email"
              description="They get a link to join."
              error={invalid ? 'Enter an email address.' : null}
            >
              <TextInput
                id="lab-invite-email"
                density="settings"
                type="email"
                value={email}
                aria-invalid={invalid || undefined}
                aria-describedby={
                  invalid ? 'lab-invite-email-error' : undefined
                }
                onChange={(event) => {
                  setEmail(event.target.value);
                  setSubmitted(false);
                }}
              />
            </DialogFormField>
            <DialogFormField label="Role" htmlFor="lab-invite-role">
              <SettingsSelect
                id="lab-invite-role"
                value={role}
                options={ROLES}
                onValueChange={setRole}
              />
            </DialogFormField>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="compact"
                variant="secondary"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="compact" variant="primary">
                Invite
              </Button>
            </div>
          </form>
        </DialogModal>
      ) : null}
    </>
  );
}

function ChoicesDemo(): JSX.Element {
  const flags = useContext(LabFlagsContext);
  const [picked, setPicked] = useState<readonly string[]>(['prs']);
  const [plan, setPlan] = useState('team');
  const toggle = (value: string): void =>
    setPicked((current) =>
      current.includes(value)
        ? current.filter((entry) => entry !== value)
        : [...current, value],
    );
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <ChoiceList aria-label="Notify me about">
        {[
          ['prs', 'Pull requests'],
          ['mentions', 'Mentions'],
          ['digests', 'Weekly digests'],
        ].map(([value, label]) => (
          <ChoiceListRow
            key={value}
            selected={picked.includes(value ?? '')}
            disabled={flags.allDisabled}
            onClick={() => toggle(value ?? '')}
          >
            {label}
          </ChoiceListRow>
        ))}
      </ChoiceList>
      <ChoiceList aria-label="Plan">
        {[
          ['team', 'Team'],
          ['business', 'Business'],
        ].map(([value, label]) => (
          <ChoiceListRow
            key={value}
            kind="radio"
            selected={plan === value}
            disabled={flags.allDisabled}
            onClick={() => setPlan(value ?? 'team')}
          >
            {label}
          </ChoiceListRow>
        ))}
      </ChoiceList>
    </div>
  );
}

function PlaygroundCard({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Surface as="section" variant="outline" padding="default" gap="item">
      <Heading level={2} variant="title">
        {title}
      </Heading>
      {children}
    </Surface>
  );
}

function PlaygroundView(): JSX.Element {
  return (
    <div className="grid max-w-5xl gap-4 lg:grid-cols-2">
      <PlaygroundCard title="Settings form (submit with empty fields to see errors)">
        <SettingsFormDemo />
      </PlaygroundCard>
      <div className="flex flex-col gap-4">
        <PlaygroundCard title="36px form (Select beside 36px fields)">
          <TallFormDemo />
        </PlaygroundCard>
        <PlaygroundCard title="Dialog form">
          <DialogDemo />
        </PlaygroundCard>
        <PlaygroundCard title="Inline rename">
          <InlineRenameDemo />
        </PlaygroundCard>
        <PlaygroundCard title="Field beside capsule buttons">
          <TwoFactorRowDemo />
        </PlaygroundCard>
        <PlaygroundCard title="Choices">
          <ChoicesDemo />
        </PlaygroundCard>
      </div>
      <div className="lg:col-span-2">
        <PlaygroundCard title="Page search row (field is a rectangle, filters stay capsules)">
          <SearchRowDemo />
        </PlaygroundCard>
      </div>
      <div className="lg:col-span-2">
        <PlaygroundCard title="Composer chips (stay capsules)">
          <ChipTriggers />
        </PlaygroundCard>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- page --

export function FieldsLabPage(): JSX.Element {
  const [view, setView] = useState<LabView>(initialView);
  const [colorMode, setColorMode] = useState<ColorMode>(initialColorMode);
  const [allDisabled, setAllDisabled] = useState(false);
  const [allInvalid, setAllInvalid] = useState(false);
  const [openMenu, setOpenMenu] = useState<OpenMenu>('none');

  useEffect(() => {
    applyTheme('default', colorMode);
  }, [colorMode]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (view === 'states') url.searchParams.set('view', 'states');
    else url.searchParams.delete('view');
    window.history.replaceState(null, '', url);
  }, [view]);

  return (
    <LabFlagsContext.Provider value={{ allDisabled, allInvalid }}>
      <Surface variant="pane" data-testid="fields-lab">
        <div className="min-h-screen fg-primary">
          <Surface
            as="header"
            variant="pane"
            boundary="bottom"
            className="sticky top-0 z-10"
          >
            <div className="flex flex-col gap-2 px-6 py-3">
              <div className="flex flex-wrap items-center gap-4">
                <Heading level={1} variant="title">
                  Fields lab
                </Heading>
                <SegmentedControl
                  label="View"
                  value={view}
                  width="content"
                  onChange={setView}
                  options={[
                    { value: 'playground', label: 'Playground' },
                    { value: 'states', label: 'States' },
                  ]}
                />
                <SegmentedControl
                  label="Color mode"
                  value={colorMode}
                  width="content"
                  onChange={setColorMode}
                  options={[
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                  ]}
                />
                <div className="flex items-center gap-2 text-xs">
                  <ToggleSwitch
                    label="All disabled"
                    checked={allDisabled}
                    onChange={setAllDisabled}
                  />
                  All disabled
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <ToggleSwitch
                    label="All invalid"
                    checked={allInvalid}
                    onChange={setAllInvalid}
                  />
                  All invalid
                </div>
                {view === 'states' ? (
                  <SegmentedControl
                    label="Open menu"
                    value={openMenu}
                    width="content"
                    onChange={setOpenMenu}
                    options={[
                      { value: 'none', label: 'No menu' },
                      { value: 'select', label: 'Open Select' },
                      {
                        value: 'settings-select',
                        label: 'Open SettingsSelect',
                      },
                    ]}
                  />
                ) : null}
              </div>
              <p className="text-xs fg-tertiary">
                Real shared components only. Hover and pressed can only be
                judged live with the pointer (the radio and checkbox matrix
                forces them); checkbox, radio and button focus rings show after
                a key press; focus is real browser focus, one element at a time.
                All disabled and All invalid apply to the playground and the
                states grid&apos;s first three columns.
              </p>
            </div>
          </Surface>
          <main className="p-6">
            {view === 'states' ? (
              <StatesView openMenu={openMenu} />
            ) : (
              <PlaygroundView />
            )}
          </main>
        </div>
      </Surface>
    </LabFlagsContext.Provider>
  );
}
