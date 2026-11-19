import { useState, type JSX } from 'react';
import {
  Button,
  Kbd,
  SearchField,
  Tooltip,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

function ShortcutField({
  size,
  initialQuery = '',
}: {
  readonly size: 'sm' | 'md';
  readonly initialQuery?: string;
}): JSX.Element {
  const [query, setQuery] = useState(initialQuery);
  return (
    <div className="w-60">
      <SearchField
        size={size}
        value={query}
        onValueChange={setQuery}
        aria-label="Search components"
        placeholder="Search"
        shortcut={['⌘', 'K']}
        count={query === '' ? undefined : 3}
      />
    </div>
  );
}

/**
 * Key caps on their own line and nested in the controls that draw them: the
 * search field, the tooltip and the button.
 */
export function KeyCapsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel
        title="On their own line"
        hint="One capsule per key, as in a settings row or a picker's footer"
      >
        <SpecimenGrid min={160}>
          <SpecimenCell label="One key">
            <Kbd shortcut={['Esc']} />
          </SpecimenCell>
          <SpecimenCell label="A modifier and a key">
            <Kbd shortcut={['⌘', 'K']} />
          </SpecimenCell>
          <SpecimenCell label="Three keys">
            <Kbd shortcut={['⌘', '⇧', 'P']} />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel
        title="In a search field"
        hint="The same inset from the field's end as from its top and bottom; the corner is the field's less that inset"
      >
        <SpecimenGrid min={260}>
          <SpecimenCell label="28px field: 5px in, 5px corner">
            <ShortcutField size="sm" />
          </SpecimenCell>
          <SpecimenCell label="32px field: 7px in, 3px corner">
            <ShortcutField size="md" />
          </SpecimenCell>
          <SpecimenCell label="With a query, the caps give way to the count and Clear">
            <ShortcutField size="sm" initialQuery="chip" />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel
        title="In a tooltip"
        hint="Point at the button: 4px in on three sides, 4px corner"
      >
        <SpecimenCell label="A control’s shortcut, in its tooltip" wide>
          <Tooltip label="New chat" shortcut="⌘N">
            <Button size="compact">New chat</Button>
          </Tooltip>
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel
        title="In a button"
        hint="A capsule in a capsule is already concentric"
      >
        <SpecimenGrid min={160}>
          <SpecimenCell label="28px button, 5px in">
            <Button size="compact" shortcut="⌘K" onClick={noop}>
              Search
            </Button>
          </SpecimenCell>
          <SpecimenCell label="32px button, 7px in">
            <Button shortcut="⌘P" onClick={noop}>
              Open
            </Button>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}
