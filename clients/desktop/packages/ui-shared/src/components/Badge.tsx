import type { JSX, ReactNode } from 'react';
import type { AppIcon } from '../icons/AppIcons';
import {
  BADGE_ICON_BY_SIZE,
  BADGE_ICON_TONE_CLASS,
  badgeClassName,
  dotClassName,
  formatBadgeCount,
  iconCountClassName,
  LABEL_COUNT_CLASS,
  type BadgeSize,
  type BadgeTone,
  type BadgeVariant,
  type CountTone,
  type DotSize,
  type DotTone,
} from '../lib/badge';

export type {
  BadgeSize,
  BadgeTone,
  BadgeVariant,
  CountTone,
  DotSize,
  DotTone,
} from '../lib/badge';

export interface BadgeProps {
  children: ReactNode;
  /** Defaults to `neutral`. Roles, plans and kinds stay neutral. */
  tone?: BadgeTone;
  /**
   * `regular` (default) is the 18px capsule. `compact` is a 16px square tag
   * for dense views only: diagrams, code views and schema tags.
   */
  size?: BadgeSize;
  /** Optional leading glyph, drawn at 12px (10px compact), 1.5px stroke. */
  icon?: AppIcon;
  /** Quieter fill and ink for a completed or de-emphasised row. */
  muted?: boolean;
  /** `solid` is the environment label (DEV); everything else stays `tint`. */
  variant?: BadgeVariant;
  /** Placement classes appended after the shared geometry and tone. */
  className?: string;
  title?: string;
  /** A fuller name when the visible word is terse, e.g. "Workflow input required". */
  'aria-label'?: string;
  'data-testid'?: string;
}

/**
 * A state or label word: one 18px neutral capsule, with the tone as a dot
 * before the word (six tones). Use it for states
 * (Connected, Failed, Merged), roles and plans; leave routine values such as
 * a trigger, a source or a pull request number as plain text.
 */
export function Badge({
  children,
  tone = 'neutral',
  size = 'regular',
  icon: Icon,
  muted = false,
  variant = 'tint',
  className,
  title,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: BadgeProps): JSX.Element {
  const base = badgeClassName(tone, {
    muted,
    size,
    variant,
    withIcon: Icon !== undefined,
  });
  const icon = BADGE_ICON_BY_SIZE[size];
  // On the capsule the icon carries the tone; the compact tag and the solid
  // label already ink the whole badge.
  const iconTone =
    size === 'regular' && variant === 'tint'
      ? `${BADGE_ICON_TONE_CLASS[tone]}${muted ? ' opacity-60' : ''}`
      : '';
  return (
    <span
      data-testid={testId}
      data-badge-tone={tone}
      data-badge-size={size === 'compact' ? size : undefined}
      data-badge-variant={variant === 'solid' ? variant : undefined}
      title={title}
      aria-label={ariaLabel}
      className={className ? `${base} ${className}` : base}
    >
      {Icon ? (
        <Icon
          className={
            iconTone ? `${icon.className} ${iconTone}` : icon.className
          }
          size={icon.px}
          exactSize
          drawnStrokeWidth={1.5}
          aria-hidden
        />
      ) : null}
      {children}
    </span>
  );
}

export interface CountProps {
  value: number;
  /**
   * `label` (default) sits next to a label as plain tabular text and shows
   * the real number. `icon` sits on an icon as a capsule and caps at 99+.
   */
  placement?: 'label' | 'icon';
  /** Capsule tone for `placement="icon"`: neutral, unread (blue), attention (orange). */
  tone?: CountTone;
  className?: string;
  'aria-hidden'?: boolean;
  'data-testid'?: string;
}

/** A number next to a label or on an icon. */
export function Count({
  value,
  placement = 'label',
  tone = 'neutral',
  className,
  'aria-hidden': ariaHidden,
  'data-testid': testId,
}: CountProps): JSX.Element {
  const base =
    placement === 'icon' ? iconCountClassName(tone) : LABEL_COUNT_CLASS;
  const text =
    placement === 'icon'
      ? formatBadgeCount(value)
      : Number.isFinite(value)
        ? String(Math.max(0, Math.floor(value)))
        : '0';
  return (
    <span
      data-testid={testId}
      data-count-tone={placement === 'icon' ? tone : undefined}
      aria-hidden={ariaHidden}
      className={className ? `${base} ${className}` : base}
    >
      {text}
    </span>
  );
}

export interface DotProps {
  tone: DotTone;
  /**
   * `regular` (default) is 6px. `large` is 8px, only where the dot stands in
   * for a row's leading icon.
   */
  size?: DotSize;
  /** Motion for a status that is in progress. */
  pulse?: boolean;
  /**
   * Accessible name when the dot is the only thing that carries its meaning
   * (an unread group). Without it the dot is decorative and the caller says
   * the meaning in text.
   */
  label?: string;
  className?: string;
  'data-testid'?: string;
}

/**
 * A 6px marker (8px `large` in a leading icon slot): unread (blue), waiting
 * on you (orange), filter on (grey), working or connected (green), offline or
 * failed (red).
 */
export function Dot({
  tone,
  size = 'regular',
  pulse = false,
  label,
  className,
  'data-testid': testId,
}: DotProps): JSX.Element {
  const base = dotClassName(tone, size);
  const cls = [base, pulse ? 'canopy-status-pulse' : undefined, className]
    .filter(Boolean)
    .join(' ');
  if (label !== undefined) {
    return (
      <span
        role="img"
        aria-label={label}
        data-testid={testId}
        data-dot-tone={tone}
        className={cls}
      />
    );
  }
  return (
    <span
      aria-hidden
      data-testid={testId}
      data-dot-tone={tone}
      className={cls}
    />
  );
}
