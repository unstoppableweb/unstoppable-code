'use client';

import { useId, type JSX } from 'react';
import {
  AutoArchiveSettingsControl,
  DaysInput,
} from './AutoArchiveSettingsControl';
import { Heading } from '../primitives/Heading';
import { SettingsRowsSubRow } from './settings/SettingsRows';
import { Stack } from '../primitives/Stack';
import { Surface } from '../primitives/Surface';

export interface OrchestratorRetentionCardProps {
  readonly retentionDays: number;
  readonly onRetentionDaysChange: (days: number) => void;
  readonly maxDays: number;
  readonly fallbackRetentionDays: number;
  readonly autoArchiveEnabled: boolean;
  readonly autoArchiveDays: number;
  readonly fallbackAutoArchiveDays: number;
  readonly onAutoArchiveEnabledChange: (enabled: boolean) => void;
  readonly onAutoArchiveDaysChange: (days: number) => void;
  readonly autoArchiveDaysLabel?: string;
  readonly testIdPrefix: string;
  readonly surfaceTestId?: string;
}

export function OrchestratorRetentionCard({
  retentionDays,
  onRetentionDaysChange,
  maxDays,
  fallbackRetentionDays,
  autoArchiveEnabled,
  autoArchiveDays,
  fallbackAutoArchiveDays,
  onAutoArchiveEnabledChange,
  onAutoArchiveDaysChange,
  autoArchiveDaysLabel,
  testIdPrefix,
  surfaceTestId,
}: OrchestratorRetentionCardProps): JSX.Element {
  const daysId = useId();
  const settingsTestId = `${testIdPrefix}-settings`;
  const unit = retentionDays === 1 ? 'day' : 'days';

  return (
    <Surface
      variant="outline"
      padding="default"
      data-testid={surfaceTestId ?? `${settingsTestId}-retention-card`}
    >
      <Stack
        gap="item"
        data-testid={
          surfaceTestId ? `${settingsTestId}-retention-card` : undefined
        }
      >
        <Stack gap="tight">
          <Heading level={3} variant="title">
            Deletion retention
          </Heading>
          <p className="text-xs fg-secondary">
            {`Deleted and archived chats are kept for ${retentionDays} ${unit} before they're removed. Archived work entries are kept until you delete them.`}
          </p>
        </Stack>
        <div>
          <SettingsRowsSubRow
            label="Keep deleted chats for"
            htmlFor={daysId}
            control={
              <div className="w-28">
                <DaysInput
                  id={daysId}
                  trailing="days"
                  value={retentionDays}
                  maxDays={maxDays}
                  fallbackDays={fallbackRetentionDays}
                  onDaysChange={onRetentionDaysChange}
                  data-testid={`${settingsTestId}-retention-days`}
                />
              </div>
            }
          />
          <AutoArchiveSettingsControl
            enabled={autoArchiveEnabled}
            days={autoArchiveDays}
            maxDays={maxDays}
            fallbackDays={fallbackAutoArchiveDays}
            description="Delete fully idle sessions after a period of inactivity."
            toggleTestId={`${settingsTestId}-auto-archive-toggle`}
            daysTestId={`${settingsTestId}-auto-archive-days`}
            onEnabledChange={onAutoArchiveEnabledChange}
            onDaysChange={onAutoArchiveDaysChange}
            daysLabel={autoArchiveDaysLabel}
          />
        </div>
      </Stack>
    </Surface>
  );
}
