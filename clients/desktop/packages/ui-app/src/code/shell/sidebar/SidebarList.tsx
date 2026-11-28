import type { HTMLAttributes, JSX, ReactNode, Ref } from 'react';

/**
 * Rhythm between rows. `hairline` keeps 1px between them so adjacent hover
 * surfaces read apart (the desktop's worktree rows, and the gap between the
 * sidebar's nav rows); `thin` keeps 2px (the web portal's rows).
 */
export type SidebarListRowGap = 'none' | 'hairline' | 'thin';

export const SIDEBAR_ROW_GAP_CLASS_NAMES: Record<SidebarListRowGap, string> = {
  none: '',
  hairline: 'gap-px',
  thin: 'gap-0.5',
};

export interface SidebarListProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'children'
> {
  readonly children: ReactNode;
  readonly ref?: Ref<HTMLDivElement>;
  readonly rowGap?: SidebarListRowGap;
  /** Fade the list to 80%: the hidden worktrees a user chose to tuck away. */
  readonly quiet?: boolean;
  /**
   * A 1px leading inset inside the list's own box, so a rail measuring the
   * list's height sees it (a margin would fall outside `offsetHeight`).
   */
  readonly leadingHairline?: boolean;
}

/** Semantic container for sidebar rows. */
export function SidebarList({
  children,
  className,
  rowGap = 'none',
  quiet = false,
  leadingHairline = false,
  role = 'list',
  ...attributes
}: SidebarListProps): JSX.Element {
  return (
    <div
      {...attributes}
      role={role}
      className={`flex min-w-0 flex-col${rowGap === 'none' ? '' : ` ${SIDEBAR_ROW_GAP_CLASS_NAMES[rowGap]}`}${quiet ? ' opacity-80' : ''}${leadingHairline ? ' pt-px' : ''}${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  );
}
