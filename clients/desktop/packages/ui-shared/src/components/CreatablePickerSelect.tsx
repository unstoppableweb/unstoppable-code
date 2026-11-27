'use client';

import { PickerSearchCombobox } from '../primitives/PickerSearch';

import { ControlButton } from '../primitives/Button';
import { useId, useRef, useState, type JSX, type ReactNode } from 'react';
import { ChevronDownMediumIcon, PlusIcon } from '../icons/AppIcons';
import { MENU_GAP } from '../primitives/Menu';
import { Inline } from '../primitives/Stack';
import { useMediaQuery } from '../primitives/useMediaQuery';
import { Picker } from '../primitives/Picker';
import {
  PickerList,
  PickerOption,
  PickerOptionCheck,
  PickerOptionContent,
  PickerOptionDescription,
  PickerOptionLabel,
  PickerOptionLeading,
  PickerOptionTrailing,
  PickerSearchHeader,
  PickerSection,
  PickerState,
} from '../primitives/PickerParts';

export interface CreatablePickerOption {
  /** Stable value reported to onValueChange (for sidebar groups: the group name). */
  readonly value: string;
  readonly label: string;
  /** 16px leading slot (e.g. a color dot). */
  readonly leading?: ReactNode;
  readonly description?: string;
}

export interface CreatablePickerSelectProps {
  readonly options: readonly CreatablePickerOption[];
  /** '' = the empty option; otherwise an option value or a created (unmatched) label. */
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** Label of the '' choice, always listed first while the query is blank (e.g. "No group"). */
  readonly emptyLabel: string;
  /** Builds the create row's label from normalized text, e.g. (t) => `Create “${t}”`. */
  readonly createLabel: (text: string) => string;
  /** Trailing hint on the trigger and on the pinned row when `value` matches no option (e.g. "New group"). */
  readonly unmatchedValueHint?: string;
  /** Leading slot for an unmatched value (optional). */
  readonly unmatchedValueLeading?: ReactNode;
  /** Finds the option a text matches; default: case-insensitive comparison of trimmed label. Used for both the trigger display of `value` and to decide whether to offer the create row. */
  readonly findOption?: (
    options: readonly CreatablePickerOption[],
    text: string,
  ) => CreatablePickerOption | undefined;
  /** Normalizes typed text before matching/creating; default: trim. Blank result → no create row. */
  readonly normalizeText?: (text: string) => string;
  readonly searchPlaceholder?: string;
  readonly emptyListMessage?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  readonly 'data-testid'?: string;
  /** Placement only. */
  readonly className?: string;
}

type PickerRow =
  | { readonly type: 'empty' }
  | { readonly type: 'unmatched' }
  | {
      readonly type: 'option';
      readonly option: CreatablePickerOption;
      readonly index: number;
    }
  | { readonly type: 'create'; readonly text: string };

// Mirrors Field.tsx's FIELD_CLASS so the searchable field keeps the shared
// text-field edge, neutral focus, 36px form height, and coarse-pointer floor.

function defaultFindOption(
  options: readonly CreatablePickerOption[],
  text: string,
): CreatablePickerOption | undefined {
  const normalizedText = text.trim().toLowerCase();
  return options.find(
    (option) => option.label.trim().toLowerCase() === normalizedText,
  );
}

function defaultNormalizeText(text: string): string {
  return text.trim();
}

/** Case-insensitive, with runs of whitespace treated as one space. */
function filterKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function sameIgnoringCase(left: string, right: string): boolean {
  return filterKey(left) === filterKey(right);
}

function pickerRowId(componentId: string, row: PickerRow): string {
  switch (row.type) {
    case 'empty':
      return `${componentId}-option-empty`;
    case 'unmatched':
      return `${componentId}-option-unmatched`;
    case 'option':
      return `${componentId}-option-${row.index}`;
    case 'create':
      return `${componentId}-option-create`;
  }
}

function pickerRowTestId(
  testId: string | undefined,
  row: PickerRow,
): string | undefined {
  if (testId === undefined) return undefined;
  switch (row.type) {
    case 'empty':
      return `${testId}-option-empty`;
    case 'unmatched':
      return `${testId}-option-unmatched`;
    case 'option':
      return `${testId}-option-${row.index}`;
    case 'create':
      return `${testId}-option-create`;
  }
}

function withPlacement(base: string, className: string): string {
  return className ? `${base} ${className}` : base;
}

export function CreatablePickerSelect({
  options,
  value,
  onValueChange,
  emptyLabel,
  createLabel,
  unmatchedValueHint,
  unmatchedValueLeading,
  findOption = defaultFindOption,
  normalizeText = defaultNormalizeText,
  searchPlaceholder = 'Search or create',
  emptyListMessage = 'No matches',
  disabled = false,
  id,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'data-testid': testId,
  className = '',
}: CreatablePickerSelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  // Focusing the search on a touch device raises the keyboard over the list.
  const finePointer = useMediaQuery('(pointer: fine)');
  const [query, setQuery] = useState('');
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const componentId = useId();
  const listboxId = `${componentId}-listbox`;

  const matchedOption = value === '' ? undefined : findOption(options, value);
  const hasUnmatchedValue = value !== '' && matchedOption === undefined;
  const queryIsBlank = query.trim().length === 0;
  const filterText = filterKey(query);
  const normalizedText = normalizeText(query);
  const exactOption =
    normalizedText.trim().length > 0
      ? findOption(options, normalizedText)
      : undefined;
  // The exact match stays listed even when its label differs from the typed
  // text in ways the substring filter does not ignore.
  const visibleOptions = options
    .map((option, index) => ({ option, index }))
    .filter(
      ({ option }) =>
        queryIsBlank ||
        option === exactOption ||
        filterKey(option.label).includes(filterText),
    );
  const canCreate =
    normalizedText.trim().length > 0 &&
    exactOption === undefined &&
    !(hasUnmatchedValue && sameIgnoringCase(normalizedText, value));
  const createRow: PickerRow | undefined = canCreate
    ? { type: 'create', text: normalizedText }
    : undefined;

  const rows: PickerRow[] = [];
  if (queryIsBlank) rows.push({ type: 'empty' });
  if (
    hasUnmatchedValue &&
    (queryIsBlank || filterKey(value).includes(filterText))
  ) {
    rows.push({ type: 'unmatched' });
  }
  for (const { option, index } of visibleOptions) {
    rows.push({ type: 'option', option, index });
  }
  if (createRow) rows.push(createRow);

  // Enter must pick the option the text matches, not an earlier partial match.
  const exactRow = rows.find(
    (row) => row.type === 'option' && row.option === exactOption,
  );
  const defaultActiveRow =
    exactRow ??
    (createRow && visibleOptions.length === 0 ? createRow : rows[0]);
  const activeRow =
    rows.find((row) => pickerRowId(componentId, row) === activeRowId) ??
    defaultActiveRow;

  const closeAndFocusTrigger = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const chooseRow = (row: PickerRow): void => {
    if (row.type === 'empty') {
      onValueChange('');
    } else if (row.type === 'unmatched') {
      onValueChange(value);
    } else if (row.type === 'option') {
      onValueChange(row.option.value);
    } else {
      onValueChange(row.text);
    }
    closeAndFocusTrigger();
  };

  const handleSearchChange = (text: string): void => {
    setQuery(text);
    setActiveRowId(null);
  };

  const renderRow = (row: PickerRow): JSX.Element => {
    const selected =
      row.type === 'empty'
        ? value === ''
        : row.type === 'unmatched'
          ? hasUnmatchedValue
          : row.type === 'option'
            ? matchedOption?.value === row.option.value
            : false;
    const rowId = pickerRowId(componentId, row);
    const active =
      activeRow !== undefined && pickerRowId(componentId, activeRow) === rowId;
    const rowTestId = pickerRowTestId(testId, row);

    if (row.type === 'empty') {
      return (
        <PickerOption
          key={rowId}
          id={rowId}
          role="option"
          aria-selected={selected}
          selected={selected}
          active={active}
          data-testid={rowTestId}
          onMouseMove={(): void => setActiveRowId(rowId)}
          onClick={(): void => chooseRow(row)}
        >
          <PickerOptionLeading />
          <PickerOptionContent>
            <PickerOptionLabel>{emptyLabel}</PickerOptionLabel>
          </PickerOptionContent>
          <PickerOptionCheck selected={selected} />
        </PickerOption>
      );
    }

    if (row.type === 'unmatched') {
      return (
        <PickerOption
          key={rowId}
          id={rowId}
          role="option"
          aria-selected={selected}
          selected={selected}
          active={active}
          data-testid={rowTestId}
          onMouseMove={(): void => setActiveRowId(rowId)}
          onClick={(): void => chooseRow(row)}
        >
          <PickerOptionLeading>{unmatchedValueLeading}</PickerOptionLeading>
          <PickerOptionContent>
            <PickerOptionLabel>{value}</PickerOptionLabel>
          </PickerOptionContent>
          {unmatchedValueHint ? (
            <PickerOptionTrailing>{unmatchedValueHint}</PickerOptionTrailing>
          ) : null}
          <PickerOptionCheck selected={selected} />
        </PickerOption>
      );
    }

    if (row.type === 'option') {
      return (
        <PickerOption
          key={rowId}
          id={rowId}
          role="option"
          aria-selected={selected}
          selected={selected}
          active={active}
          data-testid={rowTestId}
          onMouseMove={(): void => setActiveRowId(rowId)}
          onClick={(): void => chooseRow(row)}
        >
          <PickerOptionLeading>{row.option.leading}</PickerOptionLeading>
          <PickerOptionContent>
            <PickerOptionLabel>{row.option.label}</PickerOptionLabel>
            {row.option.description ? (
              <PickerOptionDescription>
                {row.option.description}
              </PickerOptionDescription>
            ) : null}
          </PickerOptionContent>
          <PickerOptionCheck selected={selected} />
        </PickerOption>
      );
    }

    return (
      <PickerOption
        key={rowId}
        id={rowId}
        role="option"
        aria-selected={false}
        selected={false}
        active={active}
        tone="accent"
        data-testid={rowTestId}
        onMouseMove={(): void => setActiveRowId(rowId)}
        onClick={(): void => chooseRow(row)}
      >
        <PickerOptionLeading tone="accent">
          <PlusIcon size="sm" />
        </PickerOptionLeading>
        <PickerOptionContent>
          <PickerOptionLabel>{createLabel(row.text)}</PickerOptionLabel>
        </PickerOptionContent>
      </PickerOption>
    );
  };

  const triggerLeading = matchedOption
    ? matchedOption.leading
    : hasUnmatchedValue
      ? unmatchedValueLeading
      : undefined;
  const triggerLabel = matchedOption?.label ?? (value || emptyLabel);

  return (
    <span className={withPlacement('relative flex w-full', className)}>
      <ControlButton
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        disabled={disabled}
        data-testid={testId}
        onClick={(): void => {
          if (open) {
            setOpen(false);
            return;
          }
          setQuery('');
          setActiveRowId(null);
          setOpen(true);
        }}
        presentation="creatable-picker-field"
      >
        {triggerLeading ? (
          <span
            aria-hidden="true"
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:!h-4 [&>svg]:!w-4"
          >
            {triggerLeading}
          </span>
        ) : null}
        <Inline as="span" className="min-w-0 flex-1">
          <span
            className={`min-w-0 flex-1 truncate ${value === '' ? 'fg-tertiary' : 'fg-primary'}`}
            title={triggerLabel}
          >
            {triggerLabel}
          </span>
          {hasUnmatchedValue && unmatchedValueHint ? (
            <span className="shrink-0 text-2xs fg-tertiary">
              {unmatchedValueHint}
            </span>
          ) : null}
        </Inline>
      </ControlButton>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 fg-tertiary"
      >
        <ChevronDownMediumIcon size={16} />
      </span>
      <Picker
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        returnFocusRef={triggerRef}
        initialFocusRef={finePointer ? searchRef : undefined}
        placement="bottom-left"
        gap={MENU_GAP}
        interaction="manual"
        role="dialog"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        maximumWidth="max(20rem, var(--canopy-picker-trigger-width))"
      >
        <PickerSearchHeader>
          <PickerSearchCombobox
            ref={searchRef}
            type="search"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event): void =>
              handleSearchChange(event.currentTarget.value)
            }
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            keyboard={{
              keys: rows.map((row) => pickerRowId(componentId, row)),
              activeKey: activeRow ? pickerRowId(componentId, activeRow) : null,
              onActiveKeyChange: (key) => {
                setActiveRowId(key);
                searchRef.current?.ownerDocument
                  .getElementById(key)
                  ?.scrollIntoView?.({ block: 'nearest' });
              },
              onPick: (key) => {
                const row = rows.find(
                  (item) => pickerRowId(componentId, item) === key,
                );
                if (row) chooseRow(row);
              },
              onEscape: closeAndFocusTrigger,
            }}
            listId={listboxId}
            activeDescendant={
              activeRow ? pickerRowId(componentId, activeRow) : undefined
            }
            data-testid={testId === undefined ? undefined : `${testId}-search`}
          />
        </PickerSearchHeader>
        <PickerList id={listboxId} aria-label={ariaLabel ?? searchPlaceholder}>
          {rows.length === 0 ? (
            <PickerState>{emptyListMessage}</PickerState>
          ) : (
            <>
              {rows
                .filter((row) => row.type !== 'create')
                .map((row) => renderRow(row))}
              {createRow ? (
                <PickerSection>{renderRow(createRow)}</PickerSection>
              ) : null}
            </>
          )}
        </PickerList>
      </Picker>
    </span>
  );
}
