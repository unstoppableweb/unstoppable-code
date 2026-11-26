'use client';

import type { JSX, Ref } from 'react';
import { ChevronDownMediumIcon } from '../icons/AppIcons';
import { prefersReducedMotion } from '../lib/reduced-motion';
import { ControlButton } from '../primitives/Button';

const FOCUSABLE_CONTROL =
  'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export interface SidebarProjectsReturnTarget {
  readonly viewport: HTMLElement;
  readonly header: HTMLElement;
  readonly focusTarget?: HTMLElement | null;
}

export interface SidebarProjectsReturnProps {
  readonly ref?: Ref<HTMLButtonElement>;
  readonly label: string;
  readonly testId: string;
  readonly resolveTarget: (
    trigger: HTMLButtonElement,
  ) => SidebarProjectsReturnTarget | null;
}

/** Returns to the real Projects band before this stand-in becomes hidden. */
export function SidebarProjectsReturn({
  ref,
  label,
  testId,
  resolveTarget,
}: SidebarProjectsReturnProps): JSX.Element {
  return (
    <ControlButton
      presentation="sidebar-projects-return"
      ref={ref}
      hidden
      data-sidebar-projects-pin-bottom=""
      data-testid={testId}
      aria-label={`Back to ${label}`}
      onClick={(event): void => {
        const target = resolveTarget(event.currentTarget);
        if (!target) return;
        const { header, viewport } = target;
        const focusTarget =
          target.focusTarget ??
          header.querySelector<HTMLElement>(FOCUSABLE_CONTROL) ??
          header;
        // A heading without a toggle still needs a landing point for focus.
        if (focusTarget === header && !header.hasAttribute('tabindex')) {
          header.tabIndex = -1;
        }
        focusTarget.focus({ preventScroll: true });
        viewport.scrollTo({
          top:
            viewport.scrollTop +
            header.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top,
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        });
      }}
    >
      <span className="truncate">{label}</span>
      <ChevronDownMediumIcon size="sm" className="shrink-0" aria-hidden />
    </ControlButton>
  );
}
