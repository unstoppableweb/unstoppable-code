'use client';

import { Dot, type DotTone } from '@canopy/ui-shared/components/Badge';
import { useId, useRef, useState, type JSX, type ReactNode } from 'react';
import {
  DisplayAvatar,
  FloatingMenu,
  Surface,
} from '@canopy/ui-shared/components';
import { PersonIcon } from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/**
 * The sidebar's bottom-pinned account footer — trigger row + upward menu —
 * extracted from the desktop app's `SidebarAccountMenu` so the web portal
 * renders the same row instead of its own. Dumb by design: identity, plan
 * subtitle, attention state, rail actions and the menu's rows all come from
 * the host, which keeps its own data, banners and confirmations.
 */
export interface SidebarAccountIdentity {
  /** Visible account name; the fallback label when signed out. */
  readonly name: string;
  /** Fallback identity for people who have not set a display name. */
  readonly email?: string | null;
  /** Remote avatar. Only http(s) is rendered; anything else falls back. */
  readonly image?: string | null;
  /** Whether a principal is present (drives avatar vs person icon). */
  readonly signedIn: boolean;
  /** Replaces the name while a sign-in is in flight. */
  readonly signingIn?: boolean;
}

export type SidebarAccountIdentityTone = 'inherit' | 'warning' | 'destructive';

const IDENTITY_TONE_CLASS_NAMES: Record<SidebarAccountIdentityTone, string> = {
  inherit: '',
  warning: 'fg-warning',
  destructive: 'fg-destructive',
};

export interface SidebarAccountAttention {
  /** Tone of the dot over the avatar. */
  readonly dotTone: DotTone;
  /** Appended to the trigger's accessible label. */
  readonly label: string;
}

export interface SidebarAccountFooterProps {
  readonly identity: SidebarAccountIdentity;
  /** Second line under the name: plan subtitle / pill. */
  readonly subtitle?: ReactNode;
  /**
   * Plain-text equivalent of {@link subtitle} for the trigger's accessible
   * name (the node itself may be a pill or skeleton). Included so the name
   * matches everything the row visibly says.
   */
  readonly subtitleLabel?: string;
  readonly attention?: SidebarAccountAttention | null;
  /** Compact icon actions rendered to the right of the row (desktop: Feedback, Settings). */
  readonly railActions?: ReactNode;
  /**
   * The menu's rows, rendered by the host with the DropdownMenu primitives.
   * Receives `close` so navigation rows can dismiss the menu; the theme
   * switch and similar in-place controls simply don't call it.
   */
  readonly menu: (close: () => void) => ReactNode;
  readonly menuAriaLabel?: string;
  /**
   * Accessible label for the signed-out trigger. Action-oriented by default
   * ("Sign in"), per docs/ux-writing.md; a host that renders a different
   * signed-out affordance passes its own.
   */
  readonly signedOutLabel?: string;
  /**
   * Ink for the identity text: `warning` and `destructive` are the desktop's
   * usage alerts. Defaults to inheriting the row's foreground.
   */
  readonly identityTone?: SidebarAccountIdentityTone;
  /** Host `data-*` attributes for the trigger (onboarding anchors and such). */
  readonly rowAttributes?: Readonly<Record<`data-${string}`, string>>;
  /**
   * Width of the menu popover. `default` is the 256px the web chat sidebar
   * uses; `compact` is the 224px that fits the desktop sidebar's denser
   * column.
   */
  readonly menuWidth?: 'default' | 'compact';
  /**
   * Re-enter the desktop sidebar's instant-feedback scope by name. The menu
   * portals out of the sidebar's subtree, so without this its rows would
   * animate the hover feedback the sidebar paints instantly. The desktop
   * stylesheet owns that scope; the web sidebar has none.
   */
  readonly menuInstantInteractions?: boolean;
  /** Extra classes on the footer's root (desktop adds `electron-no-drag`). */
  readonly className?: string;
  /** Lowest-priority banner slot above the account divider. */
  readonly footerBanner?: ReactNode;
  /**
   * Row rendered between the divider and the account row: the desktop's
   * computer picker in a window that shows another computer (CAN-4268).
   * Omitted or `null` collapses to nothing.
   */
  readonly contextRow?: ReactNode;
  /**
   * Test ids default to the desktop sidebar's (`sidebar-account-*`) so the
   * desktop suite survives adoption; a host overrides only what it must.
   */
  readonly testIds?: {
    readonly footer?: string;
    readonly listItem?: string;
    readonly row?: string;
    readonly menu?: string;
    readonly identity?: string;
    readonly avatar?: string;
    readonly initials?: string;
    readonly icon?: string;
    readonly attentionDot?: string;
  };
}

/** Only an http(s) avatar URL is rendered; anything else shows the initial. */
export function isDisplayableAvatarUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** Props of the unframed row: everything but the footer framing slot. */
export type SidebarAccountRowProps = Omit<
  SidebarAccountFooterProps,
  'footerBanner' | 'contextRow' | 'className'
>;

/**
 * The bare account row + upward menu, sized to fill whatever slot the host
 * puts it in and adding no framing of its own — for hosts whose slot already
 * draws the divider and padding (the shared sidebar's `footer` slot, the
 * plugins fallback header).
 */
export function SidebarAccountRow({
  identity,
  subtitle,
  subtitleLabel,
  attention = null,
  railActions,
  menu,
  menuAriaLabel = 'Account',
  signedOutLabel = 'Sign in',
  identityTone = 'inherit',
  rowAttributes,
  menuWidth = 'default',
  menuInstantInteractions = false,
  testIds,
}: SidebarAccountRowProps): JSX.Element {
  const displayName = identity.signedIn
    ? identity.name.trim() || identity.email?.trim() || 'Account'
    : identity.name.trim() || signedOutLabel;
  // Literal placement, so the design-system lint can read the menu's width.
  const menuWidthClassName = menuWidth === 'compact' ? 'w-56' : 'w-64';
  const [open, setOpen] = useState(false);
  // The URL that failed to load, so a later, different URL still renders.
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const labelId = useId();
  const attentionMask = attention
    ? 'sidebar-account-avatar-attention-mask'
    : '';
  // Hosts decide per row whether a selection closes the menu (close-on-select
  // is off), so the closer they get must also hand keyboard focus back to the
  // trigger — FloatingMenu only does that on Escape and on its own
  // close-on-select path.
  const closeMenu = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const showAvatar =
    identity.signedIn &&
    !!identity.image &&
    failedImage !== identity.image &&
    isDisplayableAvatarUrl(identity.image);
  // A person's name and avatar are private. An `aria-label` would carry a person's name as a recorded attribute, so
  // the trigger takes its name from a hidden label that is blocked for people.
  const accessibleLabel = identity.signedIn
    ? [displayName, subtitleLabel, attention?.label]
        .filter((part): part is string => !!part)
        .join(', ')
    : null;

  return (
    <div className="relative w-full min-w-0">
      <div
        ref={rowRef}
        className="group/sidebar-item flex w-full items-center gap-0"
      >
        <div
          data-testid={testIds?.listItem ?? 'sidebar-account-list-item'}
          className={`min-w-0 flex-1 focus-ring flex w-full items-center gap-2 overflow-hidden whitespace-nowrap rounded-row px-2 py-0 text-s font-normal fg-primary hover:bg-subtle pointer-coarse:min-h-11 ${
            subtitle ? 'h-10' : 'h-8'
          }`}
        >
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setOpen((value) => !value)}
            data-testid={testIds?.row ?? 'sidebar-account-row'}
            {...rowAttributes}
            aria-expanded={open}
            aria-haspopup="menu"
            aria-controls={open ? menuId : undefined}
            aria-labelledby={accessibleLabel === null ? undefined : labelId}
            aria-label={accessibleLabel === null ? signedOutLabel : undefined}
            className="focus-ring flex h-full min-w-0 flex-1 items-center gap-2 rounded-row text-left"
          >
            <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center fg-secondary">
              {identity.signedIn ? (
                // The mask cuts the attention dot's halo out of the avatar.
                <span className={`flex ${attentionMask}`}>
                  <DisplayAvatar
                    name={displayName}
                    image={showAvatar ? identity.image : null}
                    size="xs"
                    alt={showAvatar ? displayName : ''}
                    testId={
                      showAvatar
                        ? (testIds?.avatar ?? 'sidebar-account-avatar')
                        : (testIds?.initials ?? 'sidebar-account-initials')
                    }
                    onImageError={setFailedImage}
                  />
                </span>
              ) : (
                <PersonIcon
                  size={16}
                  data-testid={testIds?.icon ?? 'sidebar-account-icon'}
                  aria-hidden="true"
                />
              )}
              {identity.signedIn && attention ? (
                <Dot
                  tone={attention.dotTone}
                  data-testid={
                    testIds?.attentionDot ?? 'sidebar-account-attention-dot'
                  }
                  className="pointer-events-none absolute -right-0.5 -top-0.5"
                />
              ) : null}
            </span>
            <span className="flex min-w-0 flex-1 flex-col justify-center">
              <span
                className={`${REPLAY_BLOCK_CLASS} min-w-0 truncate text-s font-normal leading-snug${identityTone === 'inherit' ? '' : ` ${IDENTITY_TONE_CLASS_NAMES[identityTone]}`}`}
                data-testid={testIds?.identity ?? 'sidebar-account-identity'}
                title={displayName}
              >
                {identity.signingIn ? 'Signing in…' : displayName}
              </span>
              {subtitle}
            </span>
          </button>
          {accessibleLabel === null ? null : (
            <span id={labelId} hidden className={REPLAY_BLOCK_CLASS}>
              {accessibleLabel}
            </span>
          )}
        </div>
        {railActions === undefined ? null : (
          // The rail's buttons line up 2px in from the edge, in the same
          // column as every sidebar row's controls.
          <span className="flex shrink-0 items-center gap-0.5 pr-0.5">
            {railActions}
          </span>
        )}
      </div>
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={rowRef}
        returnFocusRef={triggerRef}
        placement="top-left"
        aria-label={menuAriaLabel}
        data-testid={testIds?.menu ?? 'sidebar-account-menu'}
        className={`pointer-coarse:[&_.canopy-dropdown-menu-item]:min-h-11 ${
          menuInstantInteractions
            ? `sidebar-instant-interactions ${menuWidthClassName}`
            : menuWidthClassName
        }`}
        closeOnSelect={false}
      >
        {menu(closeMenu)}
      </FloatingMenu>
    </div>
  );
}

/**
 * Desktop's framed account footer: the banner stack above the sidebar divider,
 * then the row. Hosts whose slot already frames the row use
 * {@link SidebarAccountRow} directly.
 */
export function SidebarAccountFooter({
  footerBanner,
  contextRow,
  className,
  ...row
}: SidebarAccountFooterProps): JSX.Element {
  return (
    <div className={`relative w-full min-w-0 px-2 pb-2 ${className ?? ''}`}>
      {/* Banner stack in priority order, owned by the host. The container
          owns all banner spacing: 4px between banners via gap, 8px down to
          the account divider via pb-2. It collapses entirely when no banner
          renders so the divider gap stays unchanged, and the data marker
          lets the desktop scroll area's bottom fade key off a visible
          banner (`.sidebar-scroll-mask`). Rendered even when the host passes
          nothing so that selector stays meaningful. */}
      <div
        className="flex flex-col gap-1 pb-2 pt-px empty:hidden"
        data-sidebar-footer-banners
      >
        {footerBanner}
      </div>
      <Surface
        variant="section"
        boundary="top"
        data-testid={row.testIds?.footer ?? 'sidebar-account-footer'}
        className="-mx-2"
      >
        <div className="px-2 pt-2">
          {contextRow}
          <SidebarAccountRow {...row} />
        </div>
      </Surface>
    </div>
  );
}
