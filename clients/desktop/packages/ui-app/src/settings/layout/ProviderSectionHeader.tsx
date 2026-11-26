'use client';

import type { JSX, ReactNode, Ref } from 'react';
import {
  Heading,
  ProviderStatusDot,
  type ProviderStatusDotTone,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SETTINGS_CARD_SUBTITLE_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';

/** The header dot's tone and its accessible label. */
export interface ProviderSectionStatus {
  readonly tone: ProviderStatusDotTone;
  readonly label: string;
}

export interface ProviderSectionHeaderProps {
  /** The provider's logo, decorative. */
  readonly icon: ReactNode;
  readonly title: string;
  /** Nothing until the state is known. */
  readonly status: ProviderSectionStatus | null;
  readonly subtitle: ReactNode;
  /** For a card that returns focus to its heading after an action. */
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly testId?: string;
  readonly statusTestId?: string;
}

/**
 * The first row inside a provider's box on Integrations (GitHub, Slack): the
 * logo, the name at row size with a status dot, and the one-line explanation
 * under them, the way desktop's "On this computer" rows show GitHub and
 * Linear. Every provider section on the page opens with it, so their
 * headings sit at one level. The box's rows follow under a hairline.
 *
 * This deviates from `SettingsCard`'s text heading over the box
 * (`docs/account-organization-settings.md`) for provider sections only, so
 * each one reads as one connection with its state at a glance.
 */
export function ProviderSectionHeader({
  icon,
  title,
  status,
  subtitle,
  headingRef,
  testId,
  statusTestId,
}: ProviderSectionHeaderProps): JSX.Element {
  return (
    <div className={SETTINGS_CARD_ROW_CLASS} data-testid={testId}>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          {icon}
          <Heading
            level={2}
            variant="title"
            ref={headingRef}
            tabIndex={headingRef === undefined ? undefined : -1}
          >
            {title}
          </Heading>
          {status === null ? null : (
            <ProviderStatusDot
              tone={status.tone}
              label={status.label}
              data-testid={statusTestId}
            />
          )}
        </div>
        <p className={SETTINGS_CARD_SUBTITLE_CLASS}>{subtitle}</p>
      </div>
    </div>
  );
}
