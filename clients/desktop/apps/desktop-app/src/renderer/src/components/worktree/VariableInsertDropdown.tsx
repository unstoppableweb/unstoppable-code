import { useId, useRef, useState, type JSX } from 'react';
import {
  ActionMenuRowStyle,
  Button,
  MenuItem,
  Menu,
  Tooltip,
} from '@canopy/ui-shared';
import { ChevronDownMediumIcon as AppCatalogChevronDownMediumIcon } from '@canopy/ui-shared/icons/AppIcons';

interface VariableInsertDropdownItem {
  name: string;
  description: string;
  disabled?: boolean;
  disabledReason?: string;
}

interface VariableInsertDropdownProps {
  variables: VariableInsertDropdownItem[];
  onInsert: (variableName: string) => void;
  ownerDocument?: Document;
}

/**
 * Inserts a template variable. The list is the shared `Menu`, so it
 * places, flips and dismisses like every menu: the arrows (also from the
 * trigger), Home and End move over the rows and skip unavailable ones, and
 * Escape closes it and returns focus to the trigger.
 */
export function VariableInsertDropdown({
  variables,
  onInsert,
  ownerDocument,
}: VariableInsertDropdownProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div>
      <Button
        ref={buttonRef}
        size="compact"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (variables.length > 0) setOpen((current) => !current);
        }}
      >
        Insert variable
        <AppCatalogChevronDownMediumIcon
          size="sm"
          className={`fg-secondary transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </Button>

      <Menu
        open={open && variables.length > 0}
        onOpenChange={setOpen}
        anchorRef={buttonRef}
        {...(ownerDocument ? { ownerDocument } : {})}
        placement="bottom-left"
        heightLimit={256}
        id={menuId}
        aria-label="Available variables"
        className="w-72"
      >
        <ActionMenuRowStyle>
          {variables.map((variable) => (
            <Tooltip
              key={variable.name}
              label={variable.disabledReason}
              disabled={!variable.disabled}
              className="w-full"
            >
              <MenuItem
                multiline
                aria-disabled={variable.disabled ? true : undefined}
                onClick={(event) => {
                  if (variable.disabled) {
                    event.preventDefault();
                    return;
                  }
                  onInsert(variable.name);
                }}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="font-mono text-xs fg-primary">
                    {variable.name}
                  </span>
                  <span className="text-2xs fg-secondary">
                    {variable.description}
                  </span>
                </span>
              </MenuItem>
            </Tooltip>
          ))}
        </ActionMenuRowStyle>
      </Menu>
    </div>
  );
}
