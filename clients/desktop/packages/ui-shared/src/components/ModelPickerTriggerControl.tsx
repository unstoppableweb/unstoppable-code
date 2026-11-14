'use client';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
  type Ref,
} from 'react';
import { FoldReveal } from './FoldReveal';
import { CAPSULE_TOUCH_FLOOR_CLASS } from './ChatComposerToolbar';
import { ChevronDownMediumIcon } from '../icons/AppIcons';

export interface ModelPickerTriggerControlProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  label: string;
  labelRef?: Ref<HTMLSpanElement>;
  labelClassName?: string;
  variant?: 'capsule' | 'compact';
  compact?: boolean;
  hideLabel?: boolean;
  hideChevron?: boolean;
  foldIcon?: boolean;
  iconFolded?: boolean;
  /**
   * The model can't run for this account (CAN-6444). The label takes the
   * warning ink; the caller swaps the icon for a warning glyph and says why in
   * the tooltip, so color never carries the state alone.
   */
  unavailable?: boolean;
}

/** The shared model capsule, including read-only/managed projections without a catalog. */
export const ModelPickerTriggerControl = forwardRef<
  HTMLButtonElement,
  ModelPickerTriggerControlProps
>(function ModelPickerTriggerControl(
  {
    icon,
    label,
    labelRef,
    labelClassName,
    variant = 'capsule',
    compact = false,
    hideLabel = false,
    hideChevron = false,
    foldIcon = false,
    iconFolded = false,
    unavailable = false,
    ...props
  },
  ref,
): JSX.Element {
  return (
    <button
      ref={ref}
      type="button"
      data-unavailable={unavailable ? 'true' : undefined}
      className={`flex min-w-0 max-w-full items-center whitespace-nowrap ${
        unavailable ? 'fg-warning-strong' : 'fg-primary'
      } transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
        variant === 'capsule'
          ? compact
            ? // 32px is desktop's capsule contract; a coarse pointer (phone,
              // tablet, touch laptop) still gets the 44px floor (DESIGN.md).
              `h-8 gap-1 rounded-full px-1 text-xs ${CAPSULE_TOUCH_FLOOR_CLASS}`
            : `h-8 gap-1 rounded-full px-2.5 text-xs${hideChevron ? ' pr-3' : ''} ${CAPSULE_TOUCH_FLOOR_CLASS}`
          : 'gap-1 rounded-md px-1.5 py-0.5 text-2xs'
      }`}
      {...props}
    >
      {foldIcon ? (
        // `pr-1.5` plus the capsule's 4px gap, less the fold's `-mr-1`, keeps
        // the icon's usual 6px inset; folded, the margin takes the gap back.
        <FoldReveal open={!iconFolded} className="-mr-1">
          <span className="flex pr-1.5">{icon}</span>
        </FoldReveal>
      ) : (
        icon
      )}
      {!hideLabel && (
        <span
          ref={labelRef}
          // Long names stop at 12rem unless the host sets its own width.
          className={`min-w-0 truncate ${labelClassName ?? 'max-w-48'}`}
        >
          {label}
        </span>
      )}
      {hideChevron ? null : (
        <ChevronDownMediumIcon
          size="sm"
          className={
            variant === 'capsule' ? 'shrink-0 fg-quaternary' : 'shrink-0'
          }
        />
      )}
    </button>
  );
});
