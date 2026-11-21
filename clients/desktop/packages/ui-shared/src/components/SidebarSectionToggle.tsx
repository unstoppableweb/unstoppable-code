import type { JSX, MouseEvent, ReactNode } from 'react';
import { DisclosureChevron, DisclosureToggle } from './Disclosure';

export type SidebarSectionToggleSection = 'chats' | 'workspaces';

export interface SidebarSectionToggleProps {
  /** The header's group: `group/chats` or `group/workspaces`. */
  readonly section: SidebarSectionToggleSection;
  readonly label: ReactNode;
  readonly open: boolean;
  /**
   * The header is stuck over its own rows: a click goes back to them, so the
   * button announces no open state and the chevron points up at them.
   */
  readonly stuck?: boolean;
  readonly ariaLabel?: string;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly touchTarget?: boolean;
  readonly testId?: string;
  readonly chevronTestId?: string;
  readonly onboardingAnchor?: string;
}

const LABEL_CLASS: Readonly<Record<SidebarSectionToggleSection, string>> = {
  chats: 'min-w-0 truncate',
  // Nudged 2px down, so the gap to the first project reads 4px (the sticky
  // seat's geometry contract).
  workspaces: 'shrink-0 translate-y-0.5 whitespace-nowrap',
};

const CHEVRON_SLOT_CLASS: Readonly<
  Record<SidebarSectionToggleSection, string>
> = {
  chats:
    'flex shrink-0 transition-opacity group-hover/chats:opacity-100 group-focus-within/chats:opacity-100 pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100',
  workspaces:
    'flex shrink-0 translate-y-0.5 transition-opacity group-hover/workspaces:opacity-100 group-focus-within/workspaces:opacity-100 pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100',
};

/**
 * The name of a sidebar section (Chats, Projects) as its collapse toggle. The
 * chevron rests hidden while the section is open and shows on the header's
 * hover or focus, so the rail stays quiet.
 */
export function SidebarSectionToggle({
  section,
  label,
  open,
  stuck = false,
  ariaLabel,
  onClick,
  touchTarget = false,
  testId,
  chevronTestId,
  onboardingAnchor,
}: SidebarSectionToggleProps): JSX.Element {
  return (
    <DisclosureToggle
      variant={section === 'chats' ? 'section-chats' : 'section-workspaces'}
      open={stuck ? undefined : open}
      aria-label={ariaLabel}
      data-testid={testId}
      data-onboarding-anchor={onboardingAnchor}
      touchTarget={touchTarget}
      onClick={onClick}
    >
      <span className={LABEL_CLASS[section]}>{label}</span>
      <span
        className={`${CHEVRON_SLOT_CLASS[section]} ${stuck || !open ? 'opacity-100' : 'opacity-0'}`}
      >
        <DisclosureChevron
          direction={stuck ? 'up' : open ? 'down' : 'right'}
          dataTestId={chevronTestId}
        />
      </span>
    </DisclosureToggle>
  );
}
