import { createContext, useContext, type JSX, type ReactNode } from 'react';
import type { BadgeTone } from '../lib/badge';
import {
  AlertTriangle,
  CheckIcon,
  CircleCheckIcon,
  PlayIcon,
  PlusIcon,
  QuestionMarkIcon,
  RefreshIcon,
} from '../icons/AppIcons';

/**
 * Every item state and action an installed item shows, with one icon and one
 * ink each (Sergii's Customize QA). The only place these are drawn: list
 * rows, split controls and their menus, detail-page Status pickers, the
 * status filter and the components lab all render through `ItemStateMark`.
 *
 * Shapes differ, not just colors: Active is a green lightning bolt, Available
 * a neutral slash in a square ("Type / to use it"), Disabled a muted ban
 * sign. Add, Run and Installed are neutral; Sign in is the warning triangle.
 */
export type ItemStateTone =
  | 'active'
  | 'available'
  | 'disabled'
  | 'unavailable'
  | 'add'
  | 'run'
  | 'installed'
  | 'sign-in'
  | 'failed'
  | 'update';

/**
 * Whether shared status surfaces (the status picker and filter) draw the new
 * marks. Only New Customize (the `customize-discovery` Labs experiment) turns
 * it on; with the experiment off they keep the original dot glyphs.
 */
const ItemStateMarksContext = createContext(false);

export function ItemStateMarksProvider({
  enabled,
  children,
}: {
  readonly enabled: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <ItemStateMarksContext.Provider value={enabled}>
      {children}
    </ItemStateMarksContext.Provider>
  );
}

export function useItemStateMarks(): boolean {
  return useContext(ItemStateMarksContext);
}

/**
 * The ink a state's label takes beside its icon. Text is never color-coded
 * (Sergii's QA): only the icon carries the state's color, and the label is
 * plain text, muted only for states that are off.
 */
export const ITEM_STATE_LABEL_CLASS: Readonly<Record<ItemStateTone, string>> = {
  active: 'fg-primary',
  available: 'fg-primary',
  disabled: 'fg-tertiary',
  unavailable: 'fg-tertiary',
  add: 'fg-primary',
  run: 'fg-primary',
  installed: 'fg-primary',
  'sign-in': 'fg-primary',
  failed: 'fg-primary',
  update: 'fg-primary',
};

/**
 * A status said as a colored icon and plain text (New Customize): "✓
 * Installed", "⚠ Sign in required". Neutral states show the text alone.
 */
export function StatusToneText({
  tone,
  children,
  size,
  testId,
  status,
}: {
  readonly tone: BadgeTone;
  readonly children: ReactNode;
  /** Type size; the surrounding text's by default. */
  readonly size?: 'xs' | 's';
  readonly testId?: string;
  /** Kept on the element for hosts that read it (`data-status`). */
  readonly status?: string;
}): JSX.Element {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap fg-primary${size === 'xs' ? ' text-xs' : size === 's' ? ' text-s' : ''}`}
      data-testid={testId}
      data-status={status}
      data-status-tone={tone}
    >
      {tone === 'success' ? (
        <CheckIcon size="xs" aria-hidden className="shrink-0 fg-success" />
      ) : tone === 'warning' ? (
        <AlertTriangle
          width={12}
          height={12}
          aria-hidden="true"
          className="shrink-0 fg-warning"
        />
      ) : tone === 'danger' ? (
        <AlertTriangle
          width={12}
          height={12}
          aria-hidden="true"
          className="shrink-0 fg-destructive"
        />
      ) : null}
      <span>{children}</span>
    </span>
  );
}

/** Lucide's 24-unit line art (Zap, SquareSlash, Ban). */
function LineMark({
  tone,
  size,
  className,
  children,
}: {
  readonly tone: ItemStateTone;
  readonly size: number;
  readonly className: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <svg
      aria-hidden
      data-item-state-icon={tone}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
    >
      {children}
    </svg>
  );
}

/** One state's icon; 14px unless a surface asks for another size. */
export function ItemStateMark({
  tone,
  size = 14,
}: {
  readonly tone: ItemStateTone;
  readonly size?: number;
}): JSX.Element {
  switch (tone) {
    case 'active':
      return (
        <LineMark tone={tone} size={size} className="fg-success">
          <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
        </LineMark>
      );
    case 'available':
      return (
        <LineMark tone={tone} size={size} className="fg-primary">
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M9 15 15 9" />
        </LineMark>
      );
    case 'disabled':
      return (
        <LineMark tone={tone} size={size} className="fg-tertiary">
          <circle cx="12" cy="12" r="10" />
          <path d="m4.9 4.9 14.2 14.2" />
        </LineMark>
      );
    case 'unavailable':
      // A status that cannot be read: a muted question mark, never a state.
      return (
        <span aria-hidden data-item-state-icon={tone} className="inline-flex">
          <QuestionMarkIcon
            size="sm"
            aria-hidden
            className="shrink-0 fg-tertiary"
          />
        </span>
      );
    case 'add':
      return (
        <span aria-hidden data-item-state-icon={tone} className="inline-flex">
          <PlusIcon size="sm" aria-hidden className="shrink-0 fg-primary" />
        </span>
      );
    case 'run':
      return (
        <span aria-hidden data-item-state-icon={tone} className="inline-flex">
          <PlayIcon size="sm" aria-hidden className="shrink-0 fg-primary" />
        </span>
      );
    case 'installed':
      return (
        <span aria-hidden data-item-state-icon={tone} className="inline-flex">
          <CircleCheckIcon
            size="sm"
            aria-hidden
            className="shrink-0 fg-secondary"
          />
        </span>
      );
    case 'sign-in':
      return (
        <AlertTriangle
          data-item-state-icon={tone}
          width={13}
          height={13}
          aria-hidden="true"
          className="shrink-0 fg-warning"
        />
      );
    case 'failed':
      return (
        <AlertTriangle
          data-item-state-icon={tone}
          width={13}
          height={13}
          aria-hidden="true"
          className="shrink-0 fg-destructive"
        />
      );
    case 'update':
      return (
        <span aria-hidden data-item-state-icon={tone} className="inline-flex">
          <RefreshIcon
            size="xs"
            aria-hidden
            className="shrink-0 fg-secondary"
          />
        </span>
      );
  }
}
