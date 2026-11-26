import type { JSX } from 'react';

import { StatusPill } from '../primitives/StatusPill';

/**
 * Renders one shared-container capability token as a friendly pill.
 *
 * The recipient list used to render `grant.capabilities.join(', ')`, which put
 * raw server tokens (`VIEW`) in front of the owner. That rawness was
 * deliberate - a container that grows a capability beyond `VIEW` must render
 * without a desktop code change - so this component preserves the intent
 * rather than replacing it: a known token gets a friendly label, and an
 * unknown one falls back to title case instead of disappearing or throwing.
 *
 * There is no single-capability assumption anywhere here. Callers map over the
 * grant's array and render one pill per capability.
 *
 * Shape and metrics come from `StatusPill` rather than being restated here, so
 * this and `ViewOnlyPill` stay one visual family by construction.
 */
const CAPABILITY_LABELS: Record<string, string> = {
  VIEW: 'View',
  COMMENT: 'Comment',
  EDIT: 'Edit',
};

/**
 * Title-cases an unknown server token: `VIEW_ONLY` / `view-only` -> `View Only`.
 * Underscores and hyphens are the only separators the wire format uses.
 */
export function formatCapabilityLabel(capability: string): string {
  const known = CAPABILITY_LABELS[capability.toUpperCase()];
  if (known) return known;
  const words = capability
    .split(/[_\-\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  // An empty or separator-only token is not something we can improve on;
  // showing it verbatim beats showing an empty pill.
  return words.length > 0 ? words.join(' ') : capability;
}

export interface CapabilityPillProps {
  capability: string;
}

export function CapabilityPill({
  capability,
}: CapabilityPillProps): JSX.Element {
  return (
    <StatusPill data-testid={`shared-container-capability-pill-${capability}`}>
      {formatCapabilityLabel(capability)}
    </StatusPill>
  );
}
