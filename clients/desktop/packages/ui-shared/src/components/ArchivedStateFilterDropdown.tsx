'use client';

import { Dot } from '../primitives/Badge';
import { useCallback, useMemo, useRef, useState, type JSX } from 'react';
import { ArchiveIcon, FilterIcon, TrashIcon } from '../icons/AppIcons';
import { Picker } from '../primitives/Picker';
import {
  PickerOption,
  PickerOptionCheck,
  PickerOptionContent,
  PickerOptionLabel,
  PickerOptionLeading,
} from '../primitives/PickerParts';
import { RailIconButton } from './RailIconButton';
import {
  getArchivedContainerStateLabel,
  type ArchivedContainerState,
} from '../lib/archived-state';

interface ArchivedStateFilterDropdownProps {
  /** States hidden from the list; empty means everything shows. */
  hiddenStates: ArchivedContainerState[];
  onChange: (hiddenStates: ArchivedContainerState[]) => void;
  /** Prefixes every data-testid. */
  testIdPrefix?: string;
}

const STATE_OPTIONS: ReadonlyArray<{
  state: ArchivedContainerState;
  Icon: typeof ArchiveIcon;
}> = [
  { state: 'archived', Icon: ArchiveIcon },
  { state: 'deleted', Icon: TrashIcon },
];

/**
 * Archived / Deleted filter for the "Archived and deleted" overview. Mirrors
 * the sidebar workspace filter and the changed-files label filter: checkbox
 * menu options that stay open on select, a hidden-states selection, and an
 * active indicator dot on the trigger.
 */
export function ArchivedStateFilterDropdown({
  hiddenStates,
  onChange,
  testIdPrefix = 'archived-overview-filter',
}: ArchivedStateFilterDropdownProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const hiddenSet = useMemo(() => new Set(hiddenStates), [hiddenStates]);
  const isActive = hiddenStates.length > 0;

  const handleToggle = useCallback(
    (state: ArchivedContainerState): void => {
      const next = new Set(hiddenSet);
      if (next.has(state)) {
        next.delete(state);
      } else {
        next.add(state);
      }
      onChange(Array.from(next));
    },
    [hiddenSet, onChange],
  );

  const title = 'Filter by state';

  return (
    <div className="relative shrink-0">
      <RailIconButton
        ref={triggerRef}
        icon={FilterIcon}
        iconSize={16}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((prev) => !prev);
        }}
        // The dot alone says a filter is on; say it in the name too.
        aria-label={isActive ? `${title}, filter on` : title}
        aria-expanded={open}
        aria-haspopup="true"
        title={title}
        data-testid={`${testIdPrefix}-trigger`}
        data-active={isActive ? 'true' : 'false'}
        hoverSurface
        coarsePointerTarget
      />
      {isActive && (
        <Dot
          tone="filter"
          data-testid={`${testIdPrefix}-active-dot`}
          className="pointer-events-none absolute right-0.5 top-0.5"
        />
      )}

      <Picker
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        heightLimit={200}
        interaction="menu"
        closeOnSelect={false}
        data-testid={`${testIdPrefix}-dropdown`}
      >
        {STATE_OPTIONS.map(({ state, Icon }) => {
          const isVisible = !hiddenSet.has(state);
          return (
            <PickerOption
              key={state}
              role="menuitemcheckbox"
              aria-checked={isVisible}
              onClick={() => handleToggle(state)}
              data-testid={`${testIdPrefix}-option-${state}`}
              selected={isVisible}
            >
              <PickerOptionCheck selected={isVisible} reserveSpace />
              <PickerOptionLeading tone="secondary">
                <Icon size="sm" aria-hidden="true" />
              </PickerOptionLeading>
              <PickerOptionContent>
                <PickerOptionLabel>
                  {getArchivedContainerStateLabel(state)}
                </PickerOptionLabel>
              </PickerOptionContent>
            </PickerOption>
          );
        })}
      </Picker>
    </div>
  );
}
