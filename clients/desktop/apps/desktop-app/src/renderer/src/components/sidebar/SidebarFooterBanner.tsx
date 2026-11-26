import { ControlButton } from '@canopy/ui-shared/components';
import { SidebarFooterBannerSurface } from '@canopy/ui-shared/components';
import { type JSX, type ReactNode } from 'react';
import { Button, HoverCard, Tooltip } from '@canopy/ui-shared/components';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';

interface SidebarFooterBannerAction {
  ariaLabel: string;
  icon: ReactNode;
  onClick: () => void;
  testId: string;
  title?: string;
}

interface SidebarFooterBannerProps {
  ariaLabel?: string;
  children: ReactNode;
  /**
   * `status` is the raised card every interactive prompt shares (update,
   * sign-in repair, resume queue, clone progress): the card stays under the
   * pointer and a `bg-subtle` wash darkens it, rather than each prompt
   * choosing whether hover replaces the card.
   */
  surface?: 'status' | 'development';
  onClick?: () => void;
  disabled?: boolean;
  testId: string;
  /** Hover content; only a string also becomes a static banner's native title. */
  title?: ReactNode;
  /**
   * Optional secondary icon button rendered at the trailing edge. Only valid
   * together with `onClick`; the banner then renders as a row of two sibling
   * buttons so the markup stays valid (no nested buttons).
   */
  trailingAction?: SidebarFooterBannerAction;
}

/**
 * Shared compact surface for status banners anchored immediately above the
 * sidebar account divider. Static development context and interactive prompts
 * use the same geometry while supplying their own semantic colors/elevation.
 */
export function SidebarFooterBanner({
  ariaLabel,
  children,
  surface,
  onClick,
  disabled,
  testId,
  title,
  trailingAction,
}: SidebarFooterBannerProps): JSX.Element {
  const tall = useLabsExperimentEnabled('sidebar');
  if (onClick && trailingAction) {
    return (
      <SidebarFooterBannerSurface
        split
        tall={tall}
        surface={surface}
        data-testid={`${testId}-row`}
      >
        {/* `data-banner-primary` lets the consumer scope row-level hover
            treatments to the primary action via `has-[...]` so hovering the
            trailing icon button highlights only itself. */}
        {/* HoverCard (not Tooltip): its wrapper carries no `shrink-0`,
            so it can take over the primary button's `min-w-0 flex-1` slot and
            the label keeps truncating. */}
        <HoverCard
          disabled={title === undefined}
          triggerWrapperClassName="h-full min-w-0 flex-1"
          surfaceClassName="w-max max-w-72"
          surfacePadding="compact"
          content={<span className="text-xs fg-primary">{title}</span>}
        >
          <ControlButton
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={ariaLabel}
            presentation="sidebar-banner-primary"
            data-testid={testId}
            data-banner-primary
          >
            {children}
          </ControlButton>
        </HoverCard>
        {/* The shared 28px quiet icon button sits 2px from the banner's
            trailing edge (-mr-1.5 against the banner's pr-2), which puts the
            glyph center 16px from the content edge — the same center line
            as the account row's 32px RailIconButton glyphs. */}
        <Tooltip
          label={trailingAction.title ?? trailingAction.ariaLabel}
          className="-mr-1.5"
        >
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={trailingAction.onClick}
            aria-label={trailingAction.ariaLabel}
            data-testid={trailingAction.testId}
          >
            {trailingAction.icon}
          </Button>
        </Tooltip>
      </SidebarFooterBannerSurface>
    );
  }

  if (onClick) {
    return (
      <Tooltip
        label={title}
        suppressed={title === undefined}
        className="w-full"
      >
        <ControlButton
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={ariaLabel}
          presentation="sidebar-banner-action"
          appearance={{ tall, surface: surface ?? 'plain' }}
          data-testid={testId}
        >
          {children}
        </ControlButton>
      </Tooltip>
    );
  }

  return (
    <SidebarFooterBannerSurface
      tall={tall}
      surface={surface}
      title={typeof title === 'string' ? title : undefined}
      data-testid={testId}
      // Non-interactive banners with an accessible label are live statuses
      // (e.g. update download progress); unlabeled ones are decorative.
      role={ariaLabel ? 'status' : undefined}
      aria-label={ariaLabel}
    >
      {children}
    </SidebarFooterBannerSurface>
  );
}

export type SidebarFooterBannerIconTone =
  | 'secondary'
  | 'accent'
  | 'warning'
  | 'destructive';

/**
 * The banner's 20px leading slot, 6px from the card edge, so every banner's
 * label starts on the same line. The glyph's ink carries the state; the label
 * stays `fg-primary`.
 */
export function SidebarFooterBannerIconSlot({
  tone = 'secondary',
  children,
}: {
  tone?: SidebarFooterBannerIconTone;
  children: ReactNode;
}): JSX.Element {
  const toneClassName =
    tone === 'accent'
      ? 'fg-accent'
      : tone === 'warning'
        ? 'fg-warning'
        : tone === 'destructive'
          ? 'fg-destructive'
          : 'fg-secondary';
  return (
    <span
      data-testid="sidebar-footer-banner-icon"
      className={`ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center ${toneClassName}`}
    >
      {children}
    </span>
  );
}

export { SidebarFooterBannerIconSlot as SidebarFooterBannerIcon };
