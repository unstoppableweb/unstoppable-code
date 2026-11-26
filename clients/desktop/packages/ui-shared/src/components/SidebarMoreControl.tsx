'use client';

import { ControlButton } from '../primitives/Button';
import {
  useId,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import { MoreHorizontalIcon } from '../icons/AppIcons';
import { ActionMenuRowStyle } from '../primitives/ActionMenuItems';
import { FloatingMenu } from '../primitives/FloatingMenu';
import { SidebarNavRow } from './SidebarNavRow';
import { SIDEBAR_LIST_ICON_CLASSNAME } from '../primitives/sidebar-item-classes';
import { Tooltip } from '../primitives/Tooltip';

export interface SidebarMoreControlProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly children: ReactNode;
  readonly triggerTestId: string;
  readonly menuTestId: string;
  readonly onboardingAnchor?: string;
  readonly compact?: boolean;
  readonly touchTarget?: 'coarse' | 'always' | 'none';
  readonly menuSize?: 'sidebar' | 'content';
  /** A landmark only where the control is a distinct navigation region. */
  readonly landmarkLabel?: string;
}

/** Shared trigger and focus lifecycle; destinations remain owned by the caller. */
export function SidebarMoreControl({
  open,
  onOpenChange,
  triggerRef,
  children,
  triggerTestId,
  menuTestId,
  onboardingAnchor,
  compact = false,
  touchTarget = 'coarse',
  menuSize = 'content',
  landmarkLabel,
}: SidebarMoreControlProps): JSX.Element {
  const menuId = useId();
  const triggerProps = {
    ref: triggerRef,
    onClick: (): void => onOpenChange(!open),
    'data-testid': triggerTestId,
    'data-onboarding-anchor': onboardingAnchor,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
  } satisfies ButtonHTMLAttributes<HTMLButtonElement> & {
    ref: RefObject<HTMLButtonElement | null>;
    'data-testid': string;
    'data-onboarding-anchor': string | undefined;
  };
  const control = (
    <>
      {compact ? (
        <Tooltip label="More">
          <ControlButton
            {...triggerProps}
            type="button"
            aria-label="More"
            presentation="sidebar-more-compact"
          >
            <span className={`${SIDEBAR_LIST_ICON_CLASSNAME} fg-secondary`}>
              <MoreHorizontalIcon size={16} />
            </span>
          </ControlButton>
        </Tooltip>
      ) : (
        <SidebarNavRow
          {...triggerProps}
          icon={<MoreHorizontalIcon size={16} />}
          touchTarget={touchTarget}
        >
          More
        </SidebarNavRow>
      )}
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={onOpenChange}
        anchorRef={triggerRef}
        placement="bottom-left"
        aria-label="More"
        data-testid={menuTestId}
        className={menuSize === 'sidebar' ? 'w-56' : 'min-w-48'}
      >
        {/* The destinations take the action-menu rows (small text, tertiary
            icons), like every other row menu. */}
        <ActionMenuRowStyle>{children}</ActionMenuRowStyle>
      </FloatingMenu>
    </>
  );
  return landmarkLabel ? (
    <nav aria-label={landmarkLabel} className="relative">
      {control}
    </nav>
  ) : (
    <div className="relative">{control}</div>
  );
}
