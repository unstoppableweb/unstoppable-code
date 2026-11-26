import { Stack } from '../primitives/Stack';
import type { JSX } from 'react';
import { CUSTOMIZE_LABEL } from '@canopy/protocol/ui-labels';

const SECTIONS = ['first', 'second'] as const;
const ROWS = ['one', 'two', 'three', 'four'] as const;

/**
 * What the Marketplace list shows while its entries load, on the desktop
 * Plugins page and the web Marketplace alike: the list's own shape (section
 * headings over a two-column grid of 64px entry rows, as
 * `PluginsDiscoveryList` draws them), so the entries replace it in place
 * instead of a centred line that the list then pushes away.
 */
export function PluginsDiscoveryListLoading(): JSX.Element {
  return (
    <Stack
      role="status"
      aria-label={`Loading ${CUSTOMIZE_LABEL}`}
      aria-busy="true"
      data-testid="plugins-discovery-list-skeleton"
      gap="hero"
    >
      {SECTIONS.map((section) => (
        <Stack gap="item" key={section}>
          <div className="box-content flex h-7 items-center border-b pb-2">
            <span className="h-4 w-32 rounded bg-fg-primary/[0.06]" />
          </div>
          <div className="grid grid-cols-1 gap-x-8 gap-y-2 md:grid-cols-2">
            {ROWS.map((row) => (
              <div
                key={row}
                className="flex items-center gap-4 rounded-xl px-4 py-3.5"
              >
                <span className="h-9 w-9 shrink-0 rounded-full bg-fg-primary/[0.06]" />
                <span className="flex min-w-0 flex-1 flex-col gap-2">
                  <span className="h-3.5 w-1/3 rounded bg-fg-primary/[0.06]" />
                  <span className="h-3 w-2/3 rounded bg-fg-primary/[0.06]" />
                </span>
              </div>
            ))}
          </div>
        </Stack>
      ))}
    </Stack>
  );
}
