import type { JSX } from 'react';
import { ExperimentIcon, WrenchIcon } from '../icons/AppIcons';
import { Tooltip } from '../primitives/Tooltip';

/**
 * `dev` marks a development reference page that only dev and E2E builds show;
 * `labs` marks a page owned by a Labs experiment.
 */
export type SidebarNavMarkerKind = 'dev' | 'labs';

/** The marker's accessible name, read after the row label ("Kanban Labs"). */
export const SIDEBAR_NAV_MARKER_LABELS: Record<SidebarNavMarkerKind, string> = {
  dev: 'Dev',
  labs: 'Labs',
};

export const SIDEBAR_NAV_MARKER_TOOLTIPS: Record<SidebarNavMarkerKind, string> =
  {
    dev: 'Dev only. Not shown in shipped builds.',
    labs: 'Labs experiment. Turn it off in Settings → Labs.',
  };

const MARKER_ICONS: Record<SidebarNavMarkerKind, typeof ExperimentIcon> = {
  dev: WrenchIcon,
  labs: ExperimentIcon,
};

export interface SidebarNavMarkerProps {
  readonly kind: SidebarNavMarkerKind;
  /**
   * Defaults to `sidebar-entry-marker-<kind>`. Kept off the `sidebar-nav-` and
   * `sidebar-more-item-` prefixes so row enumerations never count a marker.
   */
  'data-testid'?: string;
}

/**
 * The trailing mark on a sidebar nav row or More item for a page that is not
 * a shipped feature: one muted glyph, in the quaternary ink and 16px box of
 * the row's other trailing glyphs (the pinned mark), with a tooltip that says
 * why the page is there.
 *
 * The glyph is `role="img"` with the kind as its name, so the row still reads
 * "Kanban Labs" to a screen reader; the tooltip only adds the explanation.
 */
export function SidebarNavMarker({
  kind,
  'data-testid': testId,
}: SidebarNavMarkerProps): JSX.Element {
  const Icon = MARKER_ICONS[kind];
  return (
    <Tooltip
      label={SIDEBAR_NAV_MARKER_TOOLTIPS[kind]}
      placement="right"
      className="ml-auto"
    >
      <span
        role="img"
        aria-label={SIDEBAR_NAV_MARKER_LABELS[kind]}
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center fg-quaternary"
        data-testid={testId ?? `sidebar-entry-marker-${kind}`}
      >
        <Icon size={16} />
      </span>
    </Tooltip>
  );
}
