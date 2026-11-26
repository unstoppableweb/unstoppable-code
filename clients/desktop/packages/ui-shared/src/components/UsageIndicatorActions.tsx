import { ControlButton } from '../primitives/Button';
import type { JSX, ReactNode } from 'react';
import { ChevronRightMediumIcon } from '../icons/AppIcons';
import { DisclosureChevron, DisclosureToggle } from '../primitives/Disclosure';
import { USAGE_TOUCH_FLOOR_CLASS } from './usage-indicator-meter';

/**
 * The popover's expandable rows (Context, Cost, a listed account): no hover
 * surface; the row's quieter ink brightens and its chevron turns over.
 */
export const USAGE_DISCLOSURE_ROW_CLASS = `group focus-ring flex rounded-sm text-left text-xs ${USAGE_TOUCH_FLOOR_CLASS}`;

/** The expandable row's quieter ink, brightening with the row's hover. */
export const USAGE_DISCLOSURE_INK_CLASS =
  'fg-secondary transition-colors group-hover:fg-primary';

/**
 * An expandable row with its body further down the popover (Context, Cost):
 * the name left, then the value and the chevron at the right edge. A bar can
 * sit between the row and its body, so the host places the body.
 */
export function UsageExpandableRow({
  label,
  value,
  open,
  onToggle,
  bodyId,
  testId,
}: {
  label: string;
  value: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** The body's id, for `aria-controls`. */
  bodyId: string;
  testId?: string;
}): JSX.Element {
  return (
    <DisclosureToggle
      variant="row"
      open={open}
      bodyId={bodyId}
      onClick={onToggle}
      data-testid={testId}
    >
      <span className="whitespace-nowrap fg-primary">{label}</span>
      <span
        className={`flex items-center gap-1 whitespace-nowrap tabular-nums ${USAGE_DISCLOSURE_INK_CLASS}`}
      >
        {value}
        <DisclosureChevron direction={open ? 'up' : 'down'} animated />
      </span>
    </DisclosureToggle>
  );
}

/**
 * The popover's quiet actions ("See detailed breakdown", Manage): one style,
 * so they always read alike.
 */

/**
 * The popover's action rows ("See detailed breakdown", a host's Manage row):
 * a quiet label with a chevron at the right edge; the whole row is the
 * target, and hovering it lights both. `band` is the popover's footer: a
 * full-bleed quaternary band whose clipped corners would cut a focus ring,
 * so keyboard focus tints the band instead.
 */
export function UsageActionRow({
  label,
  onClick,
  testId,
  band = false,
}: {
  label: string;
  onClick: () => void;
  testId?: string;
  band?: boolean;
}): JSX.Element {
  return (
    <ControlButton
      type="button"
      onClick={onClick}
      data-testid={testId}
      presentation="usage-indicator-action"
      appearance={{ band: !!band }}
    >
      {label}
      <ChevronRightMediumIcon
        size="sm"
        aria-hidden="true"
        className="shrink-0"
      />
    </ControlButton>
  );
}

/**
 * The popover's quiet text action ("Manage"): secondary ink that brightens
 * on hover, the touch floor on coarse pointers.
 */
export function UsageTextAction({
  label,
  onClick,
  ariaLabel,
  testId,
}: {
  label: string;
  onClick: () => void;
  ariaLabel?: string;
  testId?: string;
}): JSX.Element {
  return (
    <ControlButton
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      data-testid={testId}
      presentation="usage-indicator-text-action"
    >
      {label}
    </ControlButton>
  );
}

/**
 * A popover section's header row, styled as the Context and Cost rows: its
 * name left, then an optional quiet action and the chevron at the right
 * edge. The whole row is the toggle except the action, which sits above it.
 */
export function UsageSectionHeader({
  label,
  expanded,
  onToggle,
  action,
  testId,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  /** A quiet action between the name and the chevron (`UsageTextAction`). */
  action?: ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    // The action and chevron sit 4px apart, as the Context and Cost rows'
    // value and chevron do, so their right edges and chevrons line up.
    <div className="relative flex items-center gap-1 text-xs">
      <DisclosureToggle
        variant="usage-section"
        open={expanded}
        onClick={onToggle}
        data-testid={testId}
        // The row's overlay (`after:`) takes clicks anywhere on the row; the
        // action and chevron that follow light up with it as its peers.
      >
        <span className="whitespace-nowrap fg-primary">{label}</span>
      </DisclosureToggle>
      {action && <span className="flex pl-2">{action}</span>}
      <span
        aria-hidden="true"
        className="pointer-events-none flex fg-secondary transition-colors peer-hover:fg-primary"
      >
        <DisclosureChevron direction={expanded ? 'up' : 'down'} animated />
      </span>
    </div>
  );
}
