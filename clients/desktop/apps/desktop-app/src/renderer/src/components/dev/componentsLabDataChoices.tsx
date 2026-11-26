import { useState, type JSX } from 'react';
import {
  DataChoicesCard,
  SKILL_SAFETY_CHECK_ROW,
  USAGE_DATA_GROUP_ROWS,
  type DataChoicesActivityValue,
  type UsageDataRowKey,
  type UsageDataRowLocks,
} from '@canopy/ui-shared/components';
import type { ComponentsLabEntry } from './componentsLabCatalog';

const ALL_ON: Readonly<Record<UsageDataRowKey, boolean>> = {
  productAnalytics: true,
  sessionReplay: true,
  errorReports: true,
  activeUseSignal: true,
  featureFlagIdentity: true,
  skillSafetyCheck: true,
};

const MIXED: Readonly<Record<UsageDataRowKey, boolean>> = {
  ...ALL_ON,
  errorReports: false,
  featureFlagIdentity: false,
};

const ACTIVITY_OFF: DataChoicesActivityValue = {
  metadata: false,
  plans: false,
  summaries: false,
  transcripts: false,
};

const ACTIVITY_NEEDS_METADATA: DataChoicesActivityValue = {
  metadata: false,
  plans: false,
  summaries: true,
  transcripts: true,
};

const SOME_LOCKED: UsageDataRowLocks<UsageDataRowKey> = {
  productAnalytics: 'Turned off by Acme',
  sessionReplay: 'Turned off by Acme',
};

const ALL_LOCKED: UsageDataRowLocks<UsageDataRowKey> = {
  productAnalytics: 'Turned off by Acme',
  sessionReplay: 'Turned off by Acme',
  errorReports: 'Turned off by Acme',
  activeUseSignal: 'Turned off by Acme',
  featureFlagIdentity: 'Turned off by Acme',
};

const USAGE_DESCRIPTION =
  'Feature usage, performance, and crash reports. Never your code or chats.';

function DataChoicesSpecimen({
  title,
  initialValue,
  initialActivity,
  initialExpanded,
  locks,
}: {
  readonly title: string;
  readonly initialValue: Readonly<Record<UsageDataRowKey, boolean>>;
  readonly initialActivity: DataChoicesActivityValue;
  readonly initialExpanded: boolean;
  readonly locks?: UsageDataRowLocks<UsageDataRowKey>;
}): JSX.Element {
  const [value, setValue] = useState(initialValue);
  const [activity, setActivity] = useState(initialActivity);
  const [expanded, setExpanded] = useState(initialExpanded);
  const idPrefix = `lab-data-choices-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <div className="flex max-w-md flex-col gap-2">
      <div className="text-xs fg-tertiary">{title}</div>
      <DataChoicesCard
        rows={USAGE_DATA_GROUP_ROWS}
        extraRows={[SKILL_SAFETY_CHECK_ROW]}
        usageDescription={USAGE_DESCRIPTION}
        value={value}
        locks={locks}
        onChange={setValue}
        activity={{ value: activity, onChange: setActivity }}
        expanded={expanded}
        onExpandedChange={setExpanded}
        footnote="Change these anytime in Settings → Privacy."
        idPrefix={idPrefix}
      />
    </div>
  );
}

function DataChoicesCardSpecimen(): JSX.Element {
  return (
    <div className="flex flex-wrap gap-8">
      <DataChoicesSpecimen
        title="Collapsed"
        initialValue={ALL_ON}
        initialActivity={ACTIVITY_OFF}
        initialExpanded={false}
      />
      <DataChoicesSpecimen
        title="Customize open"
        initialValue={ALL_ON}
        initialActivity={ACTIVITY_OFF}
        initialExpanded
      />
      <DataChoicesSpecimen
        title="Mixed"
        initialValue={MIXED}
        initialActivity={ACTIVITY_OFF}
        initialExpanded={false}
      />
      <DataChoicesSpecimen
        title="Some rows locked"
        initialValue={ALL_ON}
        initialActivity={ACTIVITY_OFF}
        initialExpanded
        locks={SOME_LOCKED}
      />
      <DataChoicesSpecimen
        title="Every row locked"
        initialValue={ALL_ON}
        initialActivity={ACTIVITY_OFF}
        initialExpanded={false}
        locks={ALL_LOCKED}
      />
      <DataChoicesSpecimen
        title="Sync on with the dependency note"
        initialValue={ALL_ON}
        initialActivity={ACTIVITY_NEEDS_METADATA}
        initialExpanded
      />
    </div>
  );
}

/** The first-run "What you share" card on the Welcome gate and web sheet. */
export const DATA_CHOICES_LAB_ENTRIES: readonly ComponentsLabEntry[] = [
  {
    id: 'data-choices-card',
    name: 'DataChoicesCard',
    group: 'Unified',
    note: 'The first-run "What you share" choices: one switch per group ("Some on" when mixed), Customize opens the Settings → Privacy rows in place, and locked rows are never set by a group switch. Shared by the desktop Welcome gate and the web signed-in sheet.',
    source: 'packages/ui-shared/src/components/DataChoicesCard.tsx',
    components: ['DataChoicesCard', 'UsageDataRows'],
    prs: [],
    View: DataChoicesCardSpecimen,
  },
];
