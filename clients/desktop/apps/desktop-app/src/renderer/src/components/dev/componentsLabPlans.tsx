import type { JSX } from 'react';
import type { RemoteControlProviderUsageAccount } from '@canopy/protocol/remote-control/shell';
import {
  Button,
  PlanOpenImplementationAction,
  PlanProvenance,
  PlanReviewStatusBadge,
  PlanStatusNote,
  ProviderAccountUsage,
  ProviderAccountUsageDetails,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

/** PlanOpenImplementationAction: venue, emphasis and compact. */
export function PlanOpenActionSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="Open, in place of Execute while an attempt runs and after it succeeds">
      <SpecimenGrid min={200}>
        <SpecimenCell label="Chat, secondary">
          <PlanOpenImplementationAction
            venue="chat"
            onOpen={noop}
            dataTestIdPrefix="lab-plan-chat"
          />
        </SpecimenCell>
        <SpecimenCell label="Run, secondary">
          <PlanOpenImplementationAction
            venue="pipeline"
            onOpen={noop}
            dataTestIdPrefix="lab-plan-run"
          />
        </SpecimenCell>
        <SpecimenCell label="Chat, primary (plan awaiting review)">
          <PlanOpenImplementationAction
            venue="chat"
            emphasis="primary"
            onOpen={noop}
            dataTestIdPrefix="lab-plan-chat-primary"
          />
        </SpecimenCell>
        <SpecimenCell label="Compact, icon only (hover for the name)">
          <PlanOpenImplementationAction
            venue="chat"
            compact
            onOpen={noop}
            dataTestIdPrefix="lab-plan-chat-compact"
          />
          <PlanOpenImplementationAction
            venue="pipeline"
            compact
            onOpen={noop}
            dataTestIdPrefix="lab-plan-run-compact"
          />
        </SpecimenCell>
        <SpecimenCell label="Beside Execute, in a plan card's action row">
          <Button variant="secondary" size="compact" disabled>
            Execute
          </Button>
          <PlanOpenImplementationAction
            venue="pipeline"
            onOpen={noop}
            dataTestIdPrefix="lab-plan-row"
          />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

const STATUSES = [
  { kind: 'pending', label: 'Pending review' },
  { kind: 'approved', label: 'Approved' },
  { kind: 'dismissed', label: 'Dismissed' },
  { kind: 'implementing', label: 'Implementing in a chat' },
  { kind: 'implemented', label: 'Implemented' },
  { kind: 'unknown', label: 'Unknown' },
] as const;

/** PlanReviewStatusBadge, PlanStatusNote and PlanProvenance. */
export function PlanStatusSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="PlanReviewStatusBadge" hint="One tone per status">
        <SpecimenGrid min={200}>
          {STATUSES.map((status) => (
            <SpecimenCell key={status.kind} label={status.kind}>
              <PlanReviewStatusBadge status={status} />
            </SpecimenCell>
          ))}
          <SpecimenCell label="Empty label renders nothing">
            <PlanReviewStatusBadge status={{ kind: 'unknown', label: '' }} />
            <span className="text-2xs fg-tertiary">(nothing before this)</span>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel
        title="PlanStatusNote"
        hint="An outcome and a link beside the status"
      >
        <SpecimenGrid min={240}>
          <SpecimenCell label="Outcome and link">
            <PlanStatusNote
              text="Workflow failed"
              link={{ label: 'View run', onSelect: noop }}
            />
          </SpecimenCell>
          <SpecimenCell label="Link only">
            <PlanStatusNote link={{ label: 'View chat', onSelect: noop }} />
          </SpecimenCell>
          <SpecimenCell label="Outcome only">
            <PlanStatusNote text="Cancelled" />
          </SpecimenCell>
          <SpecimenCell label="Long outcome truncates; the link stays">
            <div className="w-48">
              <PlanStatusNote
                text="Workflow failed after the third retry of the build job"
                link={{ label: 'View run', onSelect: noop }}
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Neither renders nothing">
            <PlanStatusNote />
            <span className="text-2xs fg-tertiary">(nothing before this)</span>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel
        title="PlanProvenance"
        hint="Where an imported plan came from"
      >
        <SpecimenGrid min={280}>
          <SpecimenCell label="Imported with a path">
            <div className="flex w-64 text-2xs fg-secondary">
              <PlanProvenance
                source="imported"
                sourceFilePath="docs/plans/2026-11-04-feed.md"
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Long path truncates (full path on hover)">
            <div className="flex w-64 text-2xs fg-secondary">
              <PlanProvenance
                source="imported"
                sourceFilePath="docs/planning/2026-07-31-desktop-core-daemon/04-migration-plan-with-a-very-long-name.md"
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Other source renders nothing">
            <PlanProvenance source="claude" sourceFilePath="docs/plan.md" />
            <span className="text-2xs fg-tertiary">(nothing before this)</span>
          </SpecimenCell>
          <SpecimenCell label="Imported without a path renders nothing">
            <PlanProvenance source="imported" sourceFilePath=" " />
            <span className="text-2xs fg-tertiary">(nothing before this)</span>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const BASE_WINDOWS: RemoteControlProviderUsageAccount['windows'] = [
  {
    id: 'five-hour',
    label: '5-hour window',
    usedPercent: 42,
    resetsAt: '2026-11-04T15:00:00.000Z',
    windowDurationMs: FIVE_HOURS_MS,
  },
  {
    id: 'seven-day',
    label: '7-day window',
    usedPercent: 78,
    resetsAt: '2026-11-08T09:00:00.000Z',
    windowDurationMs: SEVEN_DAYS_MS,
  },
];

function account(
  overrides: Partial<RemoteControlProviderUsageAccount>,
): RemoteControlProviderUsageAccount {
  return {
    id: 'acct',
    label: 'dev@acme.test',
    status: 'active',
    usageSource: 'live',
    lastUpdatedAt: '2026-11-04T11:55:00.000Z',
    windows: BASE_WINDOWS,
    ...overrides,
  };
}

const LIVE = account({});
const FAILED_WITH_CACHE = account({
  error: { kind: 'service', message: 'Usage could not be read.' },
  retryAt: '2026-11-04T13:30:00.000Z',
});
const NO_WINDOWS = account({ windows: [], lastUpdatedAt: undefined });

const ACCOUNT_CASES: readonly {
  label: string;
  account: RemoteControlProviderUsageAccount;
}[] = [
  { label: 'Live limits', account: LIVE },
  {
    label: 'Passive limits (reported by the proxy)',
    account: account({ usageSource: 'passive', lastUpdatedAt: undefined }),
  },
  {
    label: 'Failed read, last known usage kept',
    account: FAILED_WITH_CACHE,
  },
  {
    label: 'Failed read, nothing cached',
    account: account({
      windows: [],
      error: { kind: 'service', message: 'Usage could not be read.' },
    }),
  },
  {
    label: 'No windows: usage unavailable, never 0%',
    account: NO_WINDOWS,
  },
  {
    label: 'Unlimited window',
    account: account({
      windows: [{ id: 'all', label: 'Usage', unlimited: true }],
    }),
  },
  {
    label: 'Long account label',
    account: account({
      label:
        'a.very.long.account.name.that.keeps.going@subdomain.example-company.test',
    }),
  },
];

/** ProviderAccountUsage and its Details form, every state. */
export function ProviderAccountUsageSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel
        title="ProviderAccountUsage"
        hint="A usage group's account"
      >
        <SpecimenGrid min={320}>
          {ACCOUNT_CASES.map((item) => (
            <SpecimenCell key={item.label} label={item.label}>
              <div className="w-full">
                <ProviderAccountUsage
                  account={item.account}
                  providerLabel="Claude"
                  nowMs={NOW}
                >
                  <Button variant="secondary" size="compact">
                    Disable
                  </Button>
                </ProviderAccountUsage>
              </div>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel
        title="ProviderAccountUsageDetails"
        hint="Inside a Settings row"
      >
        <SpecimenGrid min={320}>
          <SpecimenCell label="Open">
            <div className="w-full">
              <ProviderAccountUsageDetails account={LIVE} nowMs={NOW} />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Collapsible, closed disclosure">
            <div className="w-full">
              <ProviderAccountUsageDetails
                account={FAILED_WITH_CACHE}
                nowMs={NOW}
                collapsible
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Usage unavailable">
            <div className="w-full">
              <ProviderAccountUsageDetails account={NO_WINDOWS} nowMs={NOW} />
            </div>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}
