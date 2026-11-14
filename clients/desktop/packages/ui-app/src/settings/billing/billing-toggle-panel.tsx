'use client';

import type { JSX, ReactNode } from 'react';
import { ErrorBanner, ToggleSwitch } from '@canopy/ui-shared/components';
import { Divider } from '@canopy/ui-shared/components';

/**
 * Shared Billing block with a titled master on/off switch, set off from the
 * rows above it by a hairline: the title line, the description (with an optional "Learn more"
 * link), the `role="switch"` button, an inline error line, and a `children`
 * slot for content rendered below the switch (for example the auto top-up
 * meter and settings summary).
 *
 * Used by {@link AutoTopUpControls} so the Billing tab has one switch
 * implementation.
 */
export interface BillingTogglePanelProps {
  /** Test id on the panel container. */
  testId: string;
  /** Test id on the switch button. */
  toggleTestId: string;
  title: string;
  description: ReactNode;
  /** Optional "Learn more" destination rendered under the description. */
  learnMoreHref?: string;
  /** Current switch state. */
  checked: boolean;
  /** Accessible name for the switch. */
  ariaLabel: string;
  /** Disables the switch (no permission, or a save is in flight). */
  disabled: boolean;
  onToggle: () => void;
  /** Inline error shown under the switch row, or `null` for none. */
  error: string | null;
  children?: ReactNode;
}

export function BillingTogglePanel({
  testId,
  toggleTestId,
  title,
  description,
  learnMoreHref,
  checked,
  ariaLabel,
  disabled,
  onToggle,
  error,
  children,
}: BillingTogglePanelProps): JSX.Element {
  return (
    <div className="mt-4">
      <Divider />
      <div className="pt-4" data-testid={testId}>
        {/* Master toggle */}
        <p className="text-s font-medium fg-primary">{title}</p>
        {/* Toggle aligns with the description line, not the subheader above it. */}
        <div className="mt-1 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs fg-secondary">{description}</p>
            {learnMoreHref ? (
              <a
                href={learnMoreHref}
                target="_blank"
                rel="noreferrer"
                className="text-xs fg-accent hover:underline"
              >
                Learn more
              </a>
            ) : null}
          </div>
          <ToggleSwitch
            checked={checked}
            label={ariaLabel}
            disabled={disabled}
            onChange={() => onToggle()}
            dataTestId={toggleTestId}
          />
        </div>

        <ErrorBanner
          errorSource="billing-toggle-panel"
          className="mt-2"
          error={error}
        />

        {children}
      </div>
    </div>
  );
}
