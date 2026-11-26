import { Dot } from '@canopy/ui-shared/primitives/Badge';
import { useCallback, useMemo, useRef, useState, type JSX } from 'react';
import { FilterIcon, SettingsIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  FloatingPickerMenu,
  HeaderActionButton,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
  PickerMenuOptionLeading,
  PickerMenuOptionTrailing,
  PickerMenuSection,
  PickerMenuState,
  RailIconButton,
} from '@canopy/ui-shared/components';
import {
  useFileLabelFilterToggle,
  type FileLabelFilterOption,
} from '@/hooks/useChangedFileLabelFilter';
import { useFileLabelsStore } from '@/stores/fileLabelsStore';
import { useNavigationStore } from '@/stores/navigationStore';

interface FileLabelFilterDropdownProps {
  options: FileLabelFilterOption[];
  hiddenLabelIds: string[];
  onChange: (hiddenLabelIds: string[]) => void;
  /** Optional controlled open state so hosts can open the menu externally. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Prefixes every data-testid so co-mounted instances stay addressable. */
  testIdPrefix?: string;
  /** Match the canonical Activity-card header action shell. */
  activityCardTrigger?: boolean;
}

/**
 * Multi-select file-label filter for the Changed Files card and the Review
 * Changes file tree: checkbox menu options that stay open on select,
 * hidden-ids selection state, and an active indicator dot — the same pattern
 * the Projects header menu uses for project visibility.
 */
export function FileLabelFilterDropdown({
  options,
  hiddenLabelIds,
  onChange,
  open,
  onOpenChange,
  testIdPrefix = 'file-label-filter',
  activityCardTrigger = false,
}: FileLabelFilterDropdownProps): JSX.Element {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isOpen = open ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const triggerRef = useRef<HTMLButtonElement>(null);

  const hiddenSet = useMemo(() => new Set(hiddenLabelIds), [hiddenLabelIds]);
  const isActive = options.some((option) => hiddenSet.has(option.id));

  const handleToggle = useFileLabelFilterToggle({
    hiddenLabelIds,
    setHiddenLabelIds: onChange,
  });

  const openSettings = useNavigationStore((s) => s.openSettings);
  const requestLabelsSectionExpand = useFileLabelsStore(
    (s) => s.requestLabelsSectionExpand,
  );

  const handleOpenSettings = useCallback((): void => {
    setOpen(false);
    // Expand first so the Files tab reads the request on its initial render.
    requestLabelsSectionExpand();
    openSettings('files');
  }, [openSettings, requestLabelsSectionExpand, setOpen]);

  const title = 'Filter files by label';

  return (
    <div className="relative">
      {activityCardTrigger ? (
        <HeaderActionButton
          ref={triggerRef}
          iconOnly
          onClick={(event) => {
            event.stopPropagation();
            setOpen(!isOpen);
          }}
          aria-label={title}
          aria-expanded={isOpen}
          aria-haspopup="true"
          data-testid={`${testIdPrefix}-trigger`}
          data-active={isActive ? 'true' : 'false'}
        >
          <FilterIcon size={16} />
        </HeaderActionButton>
      ) : (
        <RailIconButton
          ref={triggerRef}
          icon={FilterIcon}
          iconSize={16}
          onClick={(event) => {
            event.stopPropagation();
            setOpen(!isOpen);
          }}
          aria-label={title}
          aria-expanded={isOpen}
          aria-haspopup="true"
          title={title}
          data-testid={`${testIdPrefix}-trigger`}
          data-active={isActive ? 'true' : 'false'}
          hoverSurface
        />
      )}
      {isActive && (
        <Dot
          tone="filter"
          data-testid={`${testIdPrefix}-active-dot`}
          className="pointer-events-none absolute right-0.5 top-0.5"
        />
      )}

      <FloatingPickerMenu
        open={isOpen}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-left"
        heightLimit={288}
        interaction="menu"
        closeOnSelect={false}
        data-testid={`${testIdPrefix}-dropdown`}
      >
        {options.length === 0 ? (
          <PickerMenuState>No labels</PickerMenuState>
        ) : (
          options.map((option) => {
            const isVisible = !hiddenSet.has(option.id);
            return (
              <PickerMenuOption
                key={option.id}
                role="menuitemcheckbox"
                aria-checked={isVisible}
                onClick={() => handleToggle(option.id)}
                data-testid={`${testIdPrefix}-option-${option.id}`}
                selected={isVisible}
              >
                <PickerMenuOptionCheck selected={isVisible} reserveSpace />
                <PickerMenuOptionContent>
                  <PickerMenuOptionLabel>{option.name}</PickerMenuOptionLabel>
                </PickerMenuOptionContent>
                <PickerMenuOptionTrailing tone="tertiary">
                  {option.count}
                </PickerMenuOptionTrailing>
              </PickerMenuOption>
            );
          })
        )}
        <PickerMenuSection>
          <PickerMenuOption
            role="menuitem"
            onClick={handleOpenSettings}
            data-testid={`${testIdPrefix}-settings`}
          >
            <PickerMenuOptionLeading tone="secondary">
              <SettingsIcon size="sm" />
            </PickerMenuOptionLeading>
            <PickerMenuOptionContent>
              <PickerMenuOptionLabel>Settings</PickerMenuOptionLabel>
            </PickerMenuOptionContent>
          </PickerMenuOption>
        </PickerMenuSection>
      </FloatingPickerMenu>
    </div>
  );
}
