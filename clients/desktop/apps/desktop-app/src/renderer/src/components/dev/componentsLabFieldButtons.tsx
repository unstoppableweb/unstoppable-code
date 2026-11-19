import { useState, type JSX } from 'react';
import {
  FieldButton,
  FormField,
  SearchField,
  SearchFieldButton,
  TextInput,
  type TextInputDensity,
} from '@canopy/ui-shared/components';
import {
  ArrowUpDownIcon,
  EyeIcon,
  EyeOffIcon,
  ListFilterIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

function SearchWithButtons({
  size,
  filtered = false,
}: {
  readonly size: 'sm' | 'md';
  readonly filtered?: boolean;
}): JSX.Element {
  const [query, setQuery] = useState('side');
  return (
    <div className="w-70">
      <SearchField
        size={size}
        value={query}
        onValueChange={setQuery}
        aria-label="Search workflows"
        placeholder="Search"
        count={query === '' ? undefined : 3}
        actions={
          <>
            <SearchFieldButton
              aria-label="Filter"
              active={filtered}
              icon={<ListFilterIcon size={14} aria-hidden="true" />}
              onClick={noop}
            />
            <SearchFieldButton
              aria-label="Sort: Name"
              icon={<ArrowUpDownIcon size={14} aria-hidden="true" />}
              onClick={noop}
            />
          </>
        }
      />
    </div>
  );
}

/**
 * Clear, Filter and Sort nested in the 28px and the 32px search field: each
 * button has the field's corner less its inset, and the last one sits as far
 * from the field's end as from its top and bottom.
 */
export function SearchFieldButtonsPanel(): JSX.Element {
  return (
    <SpecimenPanel
      title="Nested buttons"
      hint="The field's corner less the button's inset: 8px in the 28px field, 6px in the 32px one"
    >
      <SpecimenGrid min={300}>
        <SpecimenCell label="28px, Clear, Filter and Sort">
          <SearchWithButtons size="sm" />
        </SpecimenCell>
        <SpecimenCell label="28px, a filter is on">
          <SearchWithButtons size="sm" filtered />
        </SpecimenCell>
        <SpecimenCell label="32px, Clear, Filter and Sort">
          <SearchWithButtons size="md" />
        </SpecimenCell>
        <SpecimenCell label="32px, a filter is on">
          <SearchWithButtons size="md" filtered />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function SecretField({
  density,
}: {
  readonly density: TextInputDensity;
}): JSX.Element {
  const [visible, setVisible] = useState(false);
  const iconSize = density === 'default' ? 16 : 14;
  return (
    <div className="w-70">
      <FormField label="API key">
        {(control) => (
          <TextInput
            {...control}
            density={density}
            type={visible ? 'text' : 'password'}
            mono
            defaultValue="csk_4f9a2c7d1e8b"
            trailing={
              <FieldButton
                tone="ghost"
                aria-label={visible ? 'Hide API key' : 'Show API key'}
                onClick={(): void => setVisible((shown) => !shown)}
                icon={
                  visible ? (
                    <EyeOffIcon size={iconSize} aria-hidden />
                  ) : (
                    <EyeIcon size={iconSize} aria-hidden />
                  )
                }
              />
            }
          />
        )}
      </FormField>
    </div>
  );
}

/**
 * Show or Hide nested in a text input's end, at each density. Point at the
 * button to see its fill follow the field's corner.
 */
export function TextInputButtonsPanel(): JSX.Element {
  return (
    <SpecimenPanel
      title="Nested button"
      hint="A FieldButton in the trailing slot: 8px corners, the same inset on three sides"
    >
      <SpecimenGrid min={300}>
        <SpecimenCell label="Default, 36px">
          <SecretField density="default" />
        </SpecimenCell>
        <SpecimenCell label="Compact, 28px">
          <SecretField density="compact" />
        </SpecimenCell>
        <SpecimenCell label="Settings, 28px">
          <SecretField density="settings" />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}
