import type { JSX } from 'react';
import { CloudBackendIcon, DeviceBackendIcon } from '../icons';
import {
  UNIFIED_ENTRY_SURFACE_HINTS,
  UNIFIED_ENTRY_SURFACE_LABELS,
  type UnifiedEntrySurface,
} from '../lib/unified-plugin-entry';
import { Tooltip } from '../primitives/Tooltip';

/**
 * Where an entry runs, as a small icon after its name on Customize rows and
 * Browse cards. The tooltip names the location; restrictions belong in details. The
 * icon sits inside the row's or card's link, so it takes no focus of its own;
 * its label joins that link's accessible name.
 */
export function EntrySurfaceIndicator({
  surface,
  testId,
  label: labelOverride,
}: {
  readonly surface: UnifiedEntrySurface;
  readonly testId: string;
  /** Replaces the surface wording, for a row that names where it is saved. */
  readonly label?: string;
}): JSX.Element {
  const label = labelOverride ?? UNIFIED_ENTRY_SURFACE_LABELS[surface];
  const Icon = surface === 'desktop' ? DeviceBackendIcon : CloudBackendIcon;
  const tooltip =
    labelOverride ??
    (surface === 'desktop'
      ? 'This device'
      : `${label}: ${UNIFIED_ENTRY_SURFACE_HINTS[surface]}`);
  return (
    <Tooltip label={tooltip}>
      <span
        data-testid={testId}
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center fg-tertiary"
      >
        <Icon />
        <span className="sr-only">{label}</span>
      </span>
    </Tooltip>
  );
}

export { EntrySurfaceIndicator as EntrySurfaceIcon };
