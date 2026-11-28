'use client';

import { useState, type JSX, type ReactNode } from 'react';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  DialogModal,
  OrchestratorInstructionsPanel,
  OrchestratorRetentionCard,
  OrchestratorSettingsFooter,
  Stack,
  TabBar,
} from '@canopy/ui-shared/components';

type SettingsTab = 'defaults' | 'instructions' | 'advanced';

export interface OrchestratorSettingsModalProps {
  readonly onClose: () => void;
  readonly testIdPrefix: string;
  /** Host catalogs and preference controls, without any dialog chrome. */
  readonly defaults: ReactNode;
  readonly loading?: ReactNode;
  readonly contentReady?: boolean;
  /** Preserve the existing compact flow and stacked form presentations. */
  readonly formLayout: 'stack' | 'flow';
  readonly instructions: string;
  readonly onInstructionsChange: (value: string) => void;
  readonly instructionsLoading?: boolean;
  readonly instructionsError?: ReactNode;
  readonly instructionsPlaceholder: string;
  readonly retentionDays: number;
  readonly onRetentionDaysChange: (value: number) => void;
  readonly autoArchiveEnabled: boolean;
  readonly onAutoArchiveEnabledChange: (value: boolean) => void;
  readonly autoArchiveDays: number;
  readonly onAutoArchiveDaysChange: (value: number) => void;
  readonly showSave: boolean;
  readonly saveDisabled: boolean;
  readonly saving: boolean;
  readonly onSave: () => void;
  readonly error?: ReactNode;
  readonly footerError?: ReactNode;
}

const TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: 'defaults', label: 'Defaults' },
  { id: 'instructions', label: 'Instructions' },
  { id: 'advanced', label: 'Advanced' },
];
const DEFAULT_DAYS = 7;
const MAX_DAYS = 36_500;

/** The Orchestrator dialog has one UX; adapters retain their save semantics. */
export function OrchestratorSettingsModal({
  onClose,
  testIdPrefix: prefix,
  defaults,
  loading,
  contentReady = true,
  formLayout,
  instructions,
  onInstructionsChange,
  instructionsLoading,
  instructionsError,
  instructionsPlaceholder,
  retentionDays,
  onRetentionDaysChange,
  autoArchiveEnabled,
  onAutoArchiveEnabledChange,
  autoArchiveDays,
  onAutoArchiveDaysChange,
  showSave,
  saveDisabled,
  saving,
  onSave,
  error,
  footerError,
}: OrchestratorSettingsModalProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<SettingsTab>('defaults');
  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title={ORCHESTRATOR_LABEL}
      titleId={`${prefix}-settings-title`}
      maxWidth="2xl"
      minHeight="28rem"
      dataTestId={`${prefix}-settings-modal`}
      trapFocus
    >
      <TabBar
        items={TABS.map((tab) => ({
          ...tab,
          dataTestId: `${prefix}-settings-tab-${tab.id}`,
        }))}
        value={activeTab}
        onChange={(next): void => setActiveTab(next)}
        label={`${ORCHESTRATOR_LABEL} settings sections`}
        density="compact"
        inset="dialog"
      />
      <div
        className={`flex-1 p-6 ${activeTab === 'instructions' ? 'flex min-h-0 flex-col' : 'overflow-y-auto'}`}
      >
        {loading}
        {contentReady && activeTab === 'defaults' ? defaults : null}
        {contentReady && activeTab === 'instructions'
          ? (instructionsError ?? (
              <OrchestratorInstructionsPanel
                value={instructions}
                onChange={onInstructionsChange}
                disabled={instructionsLoading}
                labelId={`${prefix}-claude-md-label`}
                descriptionId={
                  formLayout === 'stack'
                    ? `${prefix}-claude-md-description`
                    : undefined
                }
                testId={`${prefix}-settings-claude-md`}
                placeholder={instructionsPlaceholder}
              />
            ))
          : null}
        {contentReady && activeTab === 'advanced' ? (
          <Stack gap="group">
            <OrchestratorRetentionCard
              retentionDays={retentionDays}
              onRetentionDaysChange={onRetentionDaysChange}
              maxDays={MAX_DAYS}
              fallbackRetentionDays={DEFAULT_DAYS}
              autoArchiveEnabled={autoArchiveEnabled}
              autoArchiveDays={autoArchiveDays}
              fallbackAutoArchiveDays={DEFAULT_DAYS}
              onAutoArchiveEnabledChange={onAutoArchiveEnabledChange}
              onAutoArchiveDaysChange={onAutoArchiveDaysChange}
              autoArchiveDaysLabel={formLayout === 'flow' ? 'days' : undefined}
              testIdPrefix={prefix}
              surfaceTestId={
                formLayout === 'stack'
                  ? `${prefix}-settings-retention`
                  : undefined
              }
            />
          </Stack>
        ) : null}
      </div>
      {error}
      {showSave && (
        <OrchestratorSettingsFooter
          disabled={saveDisabled}
          label="Save"
          busy={saving}
          onSave={onSave}
          testId={`${prefix}-settings-save`}
          error={footerError}
        />
      )}
    </DialogModal>
  );
}
