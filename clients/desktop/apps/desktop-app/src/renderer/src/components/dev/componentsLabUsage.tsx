import { useState, type ComponentProps, type JSX } from 'react';
import {
  DropdownMenuSurface,
  Button,
  HostTooltipProvider,
  NoticeButton,
  Tooltip,
  TooltipProvider,
  UninstallConfirmDialog,
  UpdateMarker,
  UsageActionRow,
  UsageExpandableRow,
  UsageLimitNotice,
  UsageResetIcon,
  UsageSectionHeader,
  UsageTextAction,
  WakeParkedNotice,
  WakeTurnBoundary,
  WorkflowLastRunText,
  type WakeParkedReason,
} from '@canopy/ui-shared/components';
import {
  UsageMeter,
  formatUsagePercent,
} from '@canopy/ui-shared/components/usage-indicator-meter';
import type { WorkflowLastRun } from '@canopy/ui-shared/lib';
import { SearchIcon, SettingsIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

// -------------------------------------------------------------- Usage

const METER_VALUES: readonly number[] = [0, 0.4, 12, 45, 69, 70, 89, 90, 100];

function UsageMeterSection(): JSX.Element {
  return (
    <SpecimenPanel title="UsageMeter (accent, then warning from 70%, destructive from 90%)">
      <SpecimenGrid min={200}>
        {METER_VALUES.map((value) => (
          <SpecimenCell
            key={value}
            label={`${value}% reads ${formatUsagePercent(value)}`}
          >
            <div className="flex w-44 flex-col gap-1">
              <div className="flex justify-between text-xs fg-secondary">
                <span>Weekly</span>
                <span className="tabular-nums">
                  {formatUsagePercent(value)}
                </span>
              </div>
              <UsageMeter percentage={value} label="Weekly usage" />
            </div>
          </SpecimenCell>
        ))}
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function UsageActionsSection(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <SpecimenPanel title="Usage popover actions">
      <SpecimenGrid min={280}>
        <SpecimenCell label="UsageSectionHeader, live (toggles the chevron)">
          <DropdownMenuSurface
            role="presentation"
            padding="readout"
            className="w-64"
          >
            <UsageSectionHeader
              label="Context"
              expanded={open}
              onToggle={(): void => setOpen((v) => !v)}
            />
          </DropdownMenuSurface>
        </SpecimenCell>
        <SpecimenCell label="UsageSectionHeader, expanded, with a quiet action">
          <DropdownMenuSurface
            role="presentation"
            padding="readout"
            className="w-64"
          >
            <UsageSectionHeader
              label="Accounts"
              expanded
              onToggle={noop}
              action={<UsageTextAction label="Manage" onClick={noop} />}
            />
          </DropdownMenuSurface>
        </SpecimenCell>
        <SpecimenCell label="UsageActionRow">
          <DropdownMenuSurface
            role="presentation"
            padding="readout"
            className="w-64"
          >
            <UsageActionRow label="See detailed breakdown" onClick={noop} />
          </DropdownMenuSurface>
        </SpecimenCell>
        <SpecimenCell label="UsageActionRow, footer band">
          <DropdownMenuSurface
            role="presentation"
            padding="none"
            className="w-64 overflow-hidden"
          >
            <UsageActionRow label="Manage usage" onClick={noop} band />
          </DropdownMenuSurface>
        </SpecimenCell>
        <SpecimenCell label="UsageTextAction">
          <UsageTextAction label="Manage" onClick={noop} />
        </SpecimenCell>
        <SpecimenCell label="UsageExpandableRow, closed">
          <div className="flex w-64 flex-col">
            <UsageExpandableRow
              label="Context"
              value="48.2k / 200k (24%)"
              open={false}
              onToggle={noop}
              bodyId="lab-usage-row-closed"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="UsageExpandableRow, open">
          <div className="flex w-64 flex-col">
            <UsageExpandableRow
              label="Cost"
              value="$1.24"
              open
              onToggle={noop}
              bodyId="lab-usage-row-open"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="UsageResetIcon, 14, 16 and 20px, quiet and primary ink">
          <span className="inline-flex items-center gap-3">
            <UsageResetIcon />
            <UsageResetIcon size="sm" className="shrink-0 fg-tertiary" />
            <UsageResetIcon size="xl" className="shrink-0 fg-primary" />
          </span>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function UsageLimitSection(): JSX.Element {
  return (
    <SpecimenPanel title="UsageLimitNotice">
      <SpecimenCell label="claude, with actions" wide>
        <div className="w-full">
          <UsageLimitNotice
            provider="claude"
            actions={
              <>
                <NoticeButton variant="secondary">Switch model</NoticeButton>
                <NoticeButton variant="primary">Buy credits</NoticeButton>
              </>
            }
            onDismiss={noop}
          >
            Chats resume at 4:00 PM, or switch to another model now.
          </UsageLimitNotice>
        </div>
      </SpecimenCell>
      <SpecimenCell label="codex, no actions, not dismissable" wide>
        <div className="w-full">
          <UsageLimitNotice provider="codex">
            Resets in 2 hours.
          </UsageLimitNotice>
        </div>
      </SpecimenCell>
      <SpecimenCell
        label="a credits purchase is open in the browser (neutral, waiting)"
        wide
      >
        <div className="w-full">
          <UsageLimitNotice
            provider="claude"
            purchaseStep={{
              title: 'Finish checkout in your browser',
              failed: false,
            }}
            onDismiss={noop}
          >
            We’ll resume your chat when the purchase goes through.
          </UsageLimitNotice>
        </div>
      </SpecimenCell>
      <SpecimenCell label="the purchase check failed (a warning again)" wide>
        <div className="w-full">
          <UsageLimitNotice
            provider="claude"
            purchaseStep={{
              title: 'Couldn’t confirm the purchase',
              failed: true,
            }}
            actions={
              <NoticeButton variant="secondary">Check again</NoticeButton>
            }
          >
            Try again, or contact support if you were charged.
          </UsageLimitNotice>
        </div>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

// ------------------------------------------------------ Wake + workflow

const WAKE_REASONS: readonly WakeParkedReason[] = [
  'consecutive_limit',
  'daily_limit',
  'delegation_limit',
  'other',
];

const WAKE_BOUNDARIES: readonly {
  label: string;
  props: ComponentProps<typeof WakeTurnBoundary>;
}[] = [
  {
    label: 'finished task, with a way back',
    props: { taskLabel: 'pnpm build', onShowSpawningTurn: noop },
  },
  { label: 'finished task, not in view', props: { taskLabel: 'pnpm build' } },
  { label: 'no task name', props: {} },
  {
    label: 'event from a running task',
    props: { event: true, taskLabel: 'dev server' },
  },
  { label: 'event, unnamed', props: { event: true } },
  {
    label: 'scheduled prompt',
    props: { scheduled: true, taskLabel: 'Daily standup summary' },
  },
  { label: 'scheduled, unnamed', props: { scheduled: true } },
  { label: 'after loading tools', props: { toolsLoaded: true } },
  {
    label: 'long task name truncates',
    props: {
      taskLabel:
        'pnpm run test:web --shard=1/3 --coverage --reporter=verbose --bail',
      onShowSpawningTurn: noop,
    },
  },
];

function WakeSection(): JSX.Element {
  const [outcome, setOutcome] = useState<'ok' | 'fail'>('fail');
  const onContinue = (): Promise<void> =>
    new Promise((resolve, reject) => {
      window.setTimeout(
        () => (outcome === 'ok' ? resolve() : reject(new Error('x'))),
        1200,
      );
    });
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="WakeParkedNotice">
        {WAKE_REASONS.map((reason) => (
          <SpecimenCell key={reason} label={`${reason}, with Continue`} wide>
            <div className="w-full">
              <WakeParkedNotice
                reason={reason}
                onContinue={onContinue}
                key={`${reason}-${outcome}`}
              />
            </div>
          </SpecimenCell>
        ))}
        <SpecimenCell label="Live: Continue ends as" wide>
          <Button
            size="compact"
            variant={outcome === 'ok' ? 'primary' : 'secondary'}
            onClick={(): void => setOutcome('ok')}
          >
            Succeeds
          </Button>
          <Button
            size="compact"
            variant={outcome === 'fail' ? 'primary' : 'secondary'}
            onClick={(): void => setOutcome('fail')}
          >
            Fails (detail line)
          </Button>
        </SpecimenCell>
        <SpecimenCell
          label="viewer who may not prompt the chat: explains only"
          wide
        >
          <div className="w-full">
            <WakeParkedNotice reason="daily_limit" />
          </div>
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel title="WakeTurnBoundary">
        <SpecimenGrid min={340}>
          {WAKE_BOUNDARIES.map(({ label, props }) => (
            <SpecimenCell key={label} label={label}>
              <div className="w-80">
                <WakeTurnBoundary {...props} />
              </div>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

const NOW = Date.now();
const RUNS: readonly { label: string; run: WorkflowLastRun | null }[] = [
  { label: 'never run', run: null },
  { label: 'running', run: { state: 'running' } },
  {
    label: 'succeeded 5 minutes ago',
    run: { state: 'success', at: NOW - 5 * 60_000 },
  },
  {
    label: 'failed 2 hours ago',
    run: {
      state: 'failure',
      at: NOW - 2 * 3_600_000,
      errorMessage: 'Step 3 timed out.',
    },
  },
  {
    label: 'skipped yesterday',
    run: { state: 'skipped', at: NOW - 86_400_000 },
  },
  {
    label: 'canceled last week',
    run: { state: 'canceled', at: NOW - 7 * 86_400_000 },
  },
  { label: 'succeeded, time unknown', run: { state: 'success' } },
];

function WorkflowSection(): JSX.Element {
  return (
    <SpecimenPanel title="WorkflowLastRunText">
      <SpecimenGrid min={260}>
        {RUNS.map(({ label, run }) => (
          <SpecimenCell key={label} label={`default: ${label}`}>
            <span className="text-s">
              <WorkflowLastRunText
                lastRun={run}
                now={NOW}
                dataTestId={`last-run-${label}`}
              />
            </span>
          </SpecimenCell>
        ))}
        {RUNS.map(({ label, run }) => (
          <SpecimenCell key={`c-${label}`} label={`customize: ${label}`}>
            <span className="text-xs">
              <WorkflowLastRunText
                lastRun={run}
                now={NOW}
                variant="customize"
                dataTestId={`last-run-c-${label}`}
              />
              {run === null ||
              (run.state !== 'running' && run.at === undefined) ? (
                <span className="fg-tertiary">(nothing)</span>
              ) : null}
            </span>
          </SpecimenCell>
        ))}
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

// ---------------------------------------------- Uninstall + update marker

type UninstallCase = 'ok' | 'message' | 'reject' | 'verb';

function UninstallSection(): JSX.Element {
  const [open, setOpen] = useState<UninstallCase | null>(null);
  const close = (): void => setOpen(null);
  const run = (kind: UninstallCase) => (): Promise<string | null> =>
    new Promise((resolve, reject) => {
      window.setTimeout(() => {
        if (kind === 'message') resolve('The share is read-only.');
        else if (kind === 'reject') reject(new Error('offline'));
        else resolve(null);
      }, 1000);
    });
  return (
    <SpecimenPanel title="UninstallConfirmDialog">
      <SpecimenCell
        label="Live: each opens the real dialog (the confirm waits one second)"
        wide
      >
        {(
          [
            ['ok', 'Succeeds'],
            ['message', 'Fails with a message'],
            ['reject', 'Rejects (fallback copy)'],
            ['verb', 'Own verb (Remove)'],
          ] as const
        ).map(([id, label]) => (
          <Button key={id} size="compact" onClick={(): void => setOpen(id)}>
            {label}
          </Button>
        ))}
      </SpecimenCell>
      {open === null ? null : (
        <UninstallConfirmDialog
          title={open === 'verb' ? 'Remove this skill?' : 'Uninstall Linear?'}
          message="Its tools stop working in new chats. Chats already open keep them."
          confirmLabel={open === 'verb' ? 'Remove' : undefined}
          busyLabel={open === 'verb' ? 'Removing…' : undefined}
          onConfirm={run(open)}
          onCancel={close}
          onUninstalled={close}
        />
      )}
    </SpecimenPanel>
  );
}

function UpdateMarkerSection(): JSX.Element {
  return (
    <SpecimenPanel title="UpdateMarker (hover or focus for the version)">
      <SpecimenGrid min={220}>
        <SpecimenCell label="version known">
          <span className="inline-flex items-center gap-1 text-s">
            Linear 1.2.0 <UpdateMarker latestVersion="1.3.0" />
          </span>
        </SpecimenCell>
        <SpecimenCell label="version unknown">
          <span className="inline-flex items-center gap-1 text-s">
            Linear 1.2.0 <UpdateMarker />
          </span>
        </SpecimenCell>
        <SpecimenCell label="version written with a v">
          <span className="inline-flex items-center gap-1 text-s">
            Linear <UpdateMarker latestVersion="v2.0.0-beta.1" />
          </span>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

// -------------------------------------------------------------- Tooltips

function TooltipHandoffSection(): JSX.Element {
  const row = (
    <span className="inline-flex gap-1">
      <Tooltip label="Search">
        <Button iconOnly variant="ghost" aria-label="Search">
          <SearchIcon />
        </Button>
      </Tooltip>
      <Tooltip label="Settings">
        <Button iconOnly variant="ghost" aria-label="Settings">
          <SettingsIcon />
        </Button>
      </Tooltip>
      <Tooltip label="Search again">
        <Button iconOnly variant="ghost" aria-label="Search again">
          <SearchIcon />
        </Button>
      </Tooltip>
    </span>
  );
  return (
    <SpecimenPanel title="TooltipProvider (hover across the buttons)">
      <SpecimenGrid min={260}>
        <SpecimenCell label="HostTooltipProvider: short first delay, then instant handoff">
          <HostTooltipProvider>{row}</HostTooltipProvider>
        </SpecimenCell>
        <SpecimenCell label="default: opens at once">{row}</SpecimenCell>
        <SpecimenCell label="openDelay 1000ms, closeDelay 600ms">
          <TooltipProvider openDelay={1000} closeDelay={600}>
            {row}
          </TooltipProvider>
        </SpecimenCell>
        <SpecimenCell label="stacking single: one tooltip at a time">
          <TooltipProvider stacking="single">{row}</TooltipProvider>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

export function UsagePartsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <UsageMeterSection />
      <UsageActionsSection />
      <UsageLimitSection />
      <WakeSection />
      <WorkflowSection />
      <UninstallSection />
      <UpdateMarkerSection />
      <TooltipHandoffSection />
    </div>
  );
}
