import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import {
  BackgroundWorkCapNotice,
  type BillingHistoryCharge,
  BillingHistoryTable,
  BubbleCopyBadge,
  Button,
  CatchingUpNotice,
  ChatComposerOverflowMenu,
  type ChatComposerOverflowMenuItemConfig,
  ChatDetailControl,
  ChatMessageContextMenu,
  ChatMessageLinkActionsProvider,
  ChatMessageLookUpProvider,
  CHECKLIST_ROW_CLASS_NAME,
  ChecklistAction,
  ChecklistDismiss,
  ClaudeAiCreditsFallbackErrorNotice,
  Surface,
  useChatMessageContextMenu,
} from '@canopy/ui-shared/components';
import {
  FastModeIcon,
  PlanModeIcon,
  ThinkingIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import type { ChatDetail } from '@canopy/protocol/chat-detail';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

/** Presses the first button inside once on mount, so a busy or failed state shows without a pointer. */
function PressOnMount({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('button')?.click();
  }, []);
  return (
    <div ref={ref} className="w-full">
      {children}
    </div>
  );
}

const NEVER: Promise<void> = new Promise<void>(() => undefined);

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Background work cap notice
// ---------------------------------------------------------------------------

const NOW_MS = 1_760_000_000_000;

function BackgroundWorkCapSheet(): JSX.Element {
  return (
    <SpecimenPanel title="BackgroundWorkCapNotice">
      <SpecimenGrid min={360}>
        <SpecimenCell label="Default: 12 minutes left; Keep running extends after 1.5s">
          <div className="w-full">
            <BackgroundWorkCapNotice
              capExpiresAtMs={NOW_MS + 11.5 * 60_000}
              nowMs={NOW_MS}
              onKeepRunning={() => delay(1500)}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Under a minute (rounds up to 1 min)">
          <div className="w-full">
            <BackgroundWorkCapNotice
              capExpiresAtMs={NOW_MS + 12_000}
              nowMs={NOW_MS}
              onKeepRunning={() => delay(1500)}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Busy: Keep running is extending">
          <PressOnMount>
            <BackgroundWorkCapNotice
              capExpiresAtMs={NOW_MS + 5 * 60_000}
              nowMs={NOW_MS}
              onKeepRunning={() => NEVER}
            />
          </PressOnMount>
        </SpecimenCell>
        <SpecimenCell label="Error: the extension failed, try again">
          <PressOnMount>
            <BackgroundWorkCapNotice
              capExpiresAtMs={NOW_MS + 5 * 60_000}
              nowMs={NOW_MS}
              onKeepRunning={() => Promise.reject(new Error('offline'))}
            />
          </PressOnMount>
        </SpecimenCell>
        <SpecimenCell label="Read-only viewer: explains, no action">
          <div className="w-full">
            <BackgroundWorkCapNotice
              capExpiresAtMs={NOW_MS + 3 * 60_000}
              nowMs={NOW_MS}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Long wait: 3 hours left">
          <div className="w-full">
            <BackgroundWorkCapNotice
              capExpiresAtMs={NOW_MS + 180 * 60_000}
              nowMs={NOW_MS}
              onKeepRunning={() => delay(1500)}
            />
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

// ---------------------------------------------------------------------------
// Billing history table
// ---------------------------------------------------------------------------

const CHARGES: BillingHistoryCharge[] = [
  {
    id: 'ch_1',
    kind: 'SUBSCRIPTION_RENEWAL',
    status: 'SUCCEEDED',
    amountUsd: 20,
    description: 'Pro plan, monthly',
    cardBrand: 'visa',
    cardLast4: '4242',
    createdAt: '2026-10-28T09:12:00Z',
  },
  {
    id: 'ch_2',
    kind: 'CREDIT_TOP_UP',
    status: 'SUCCEEDED',
    amountUsd: 50,
    amountRefundedUsd: 15,
    description: null,
    cardBrand: 'mastercard',
    cardLast4: '4444',
    createdAt: '2026-10-21T16:40:00Z',
  },
  {
    id: 'ch_3',
    kind: 'SEAT_PRORATION',
    status: 'REFUNDED',
    amountUsd: 12.5,
    amountRefundedUsd: 12.5,
    description: 'Extra seat, prorated',
    cardBrand: null,
    cardLast4: '1881',
    createdAt: '2026-10-14T11:03:00Z',
  },
  {
    id: 'ch_4',
    kind: 'ONE_TIME',
    status: 'FAILED',
    amountUsd: 100,
    description: 'Credit top-up declined by the issuing bank',
    cardBrand: 'amex',
    cardLast4: '0005',
    createdAt: '2026-10-09T08:00:00Z',
  },
  {
    id: 'ch_5',
    kind: 'PLAN_CHANGE_PRORATION',
    status: 'PENDING',
    amountUsd: 0.004,
    description: null,
    cardBrand: null,
    cardLast4: null,
    createdAt: '2026-10-02T20:25:00Z',
  },
  {
    id: 'ch_6',
    kind: 'SUBSCRIPTION_RENEWAL',
    status: 'SUCCEEDED',
    amountUsd: 1234.5,
    description:
      'Team plan, annual, 50 seats, includes the onboarding and priority-support add-ons for the platform engineering group',
    cardBrand: 'visa',
    cardLast4: '4242',
    createdAt: '2026-09-28T09:12:00Z',
  },
];

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

function BillingHistorySheet(): JSX.Element {
  return (
    <SpecimenPanel title="BillingHistoryTable">
      <SpecimenCell
        label="Default: paid, partly refunded, refunded, failed, pending, long description"
        wide
      >
        <div className="w-full">
          <BillingHistoryTable charges={CHARGES} formatDate={formatDate} />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Single paid charge" wide>
        <div className="w-full">
          <BillingHistoryTable
            charges={CHARGES.slice(0, 1)}
            formatDate={formatDate}
          />
        </div>
      </SpecimenCell>
      <SpecimenCell
        label="Empty: header only; the host shows its own empty state"
        wide
      >
        <div className="w-full">
          <BillingHistoryTable charges={[]} formatDate={formatDate} />
        </div>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

// ---------------------------------------------------------------------------
// Bubble copy badge
// ---------------------------------------------------------------------------

function BubbleCopySheet(): JSX.Element {
  return (
    <SpecimenPanel title="BubbleCopyBadge">
      <SpecimenGrid min={260}>
        <SpecimenCell label="Default: Copy; click to see Copied">
          <BubbleCopyBadge copyText="Can you rename the settings page to Preferences?" />
        </SpecimenCell>
        <SpecimenCell label="Queued message: the same Copy">
          <BubbleCopyBadge copyText="Run the tests again after the rebase." />
        </SpecimenCell>
        <SpecimenCell label="Beside a long user bubble">
          <div className="flex w-full items-start gap-2">
            <Surface variant="group" className="min-w-0 flex-1 flex flex-col">
              <p className="px-3 py-2 text-s fg-primary min-h-0 flex-1">
                Please look into why the nightly build fails only on the Windows
                runner, compare it with the last green run on develop, and
                summarize which dependency bump introduced the new native module
                path.
              </p>
            </Surface>
            <BubbleCopyBadge copyText="long message" />
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

// ---------------------------------------------------------------------------
// Catching up notice
// ---------------------------------------------------------------------------

function CatchingUpSheet(): JSX.Element {
  return (
    <SpecimenPanel title="CatchingUpNotice">
      <SpecimenGrid min={360}>
        {(
          [
            ['A few seconds behind (under a minute)', 8_000],
            ['About 1 minute behind', 75_000],
            ['About 12 minutes behind', 12 * 60_000 + 20_000],
            ['Lag unknown (not finite): the few-seconds copy', Number.NaN],
          ] as const
        ).map(([label, lagMs]) => (
          <SpecimenCell key={label} label={label}>
            <div className="w-full">
              <CatchingUpNotice lagMs={lagMs} />
            </div>
          </SpecimenCell>
        ))}
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

// ---------------------------------------------------------------------------
// Chat detail control
// ---------------------------------------------------------------------------

function ChatDetailPicker({
  initial,
}: {
  readonly initial: ChatDetail | null;
}): JSX.Element {
  const [value, setValue] = useState<ChatDetail | null>(initial);
  return <ChatDetailControl value={value} onChange={setValue} />;
}

function ChatDetailSheet(): JSX.Element {
  return (
    <SpecimenPanel title="ChatDetailControl">
      <SpecimenGrid min={280}>
        <SpecimenCell label="Detailed">
          <ChatDetailPicker initial="detailed" />
        </SpecimenCell>
        <SpecimenCell label="Recent (the default)">
          <ChatDetailPicker initial="recent" />
        </SpecimenCell>
        <SpecimenCell label="Compact">
          <ChatDetailPicker initial="compact" />
        </SpecimenCell>
        <SpecimenCell label="Loading: the saved level is not known yet">
          <ChatDetailControl value={null} onChange={noop} />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

// ---------------------------------------------------------------------------
// Composer overflow menu
// ---------------------------------------------------------------------------

const THINKING_LEVELS = ['Low', 'Medium', 'High'] as const;

function OverflowMenuDemo({
  withFooter = false,
  withDisabled = false,
}: {
  readonly withFooter?: boolean;
  readonly withDisabled?: boolean;
}): JSX.Element {
  const [plan, setPlan] = useState(true);
  const [fast, setFast] = useState(false);
  const [level, setLevel] = useState(2);
  const items: ChatComposerOverflowMenuItemConfig[] = [
    {
      key: 'plan',
      icon: <PlanModeIcon size={16} />,
      label: 'Plan mode',
      stateLabel: plan ? 'On' : 'Off',
      active: plan,
      onSelect: () => setPlan((current) => !current),
      ariaLabel: 'Plan mode',
    },
    {
      key: 'fast',
      icon: <FastModeIcon size={16} />,
      label: 'Fast mode',
      stateLabel: withDisabled ? 'Unavailable' : fast ? 'On' : 'Off',
      active: fast,
      disabled: withDisabled,
      onSelect: () => setFast((current) => !current),
      ariaLabel: 'Fast mode',
    },
    {
      key: 'thinking',
      icon: <ThinkingIcon size={16} />,
      label: 'Thinking',
      stateLabel: THINKING_LEVELS[level] ?? 'High',
      active: true,
      role: 'menuitem',
      closeOnSelect: false,
      onSelect: () =>
        setLevel((current) => (current + 1) % THINKING_LEVELS.length),
      ariaLabel: 'Thinking level',
    },
  ];
  return (
    <ChatComposerOverflowMenu
      items={items}
      footerSlot={
        withFooter ? (
          <div className="px-3 py-2 text-xs fg-secondary">
            Context: 42% of 200k used
          </div>
        ) : undefined
      }
    />
  );
}

function OverflowMenuSheet(): JSX.Element {
  return (
    <SpecimenPanel title="ChatComposerOverflowMenu (click the ⋯ trigger to open)">
      <SpecimenGrid min={220}>
        <SpecimenCell label="Toggles and a cycler: the menu stays open on Thinking">
          <OverflowMenuDemo />
        </SpecimenCell>
        <SpecimenCell label="With the phone composer's context readout below the items">
          <OverflowMenuDemo withFooter />
        </SpecimenCell>
        <SpecimenCell label="Disabled row: skipped by the arrow keys">
          <OverflowMenuDemo withDisabled />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

// ---------------------------------------------------------------------------
// Chat message context menu
// ---------------------------------------------------------------------------

interface OpenAt {
  readonly x: number;
  readonly y: number;
  readonly selection: string;
  readonly linkUrl: string | null;
}

function MenuOpener({
  label,
  selection,
  linkUrl,
}: {
  readonly label: string;
  readonly selection: string;
  readonly linkUrl: string | null;
}): JSX.Element {
  const [at, setAt] = useState<OpenAt | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAt({ x: rect.left, y: rect.bottom + 4, selection, linkUrl });
        }}
      >
        {label}
      </Button>
      {copied === null ? null : (
        <span className="text-xs fg-secondary">Copied “{copied}”</span>
      )}
      {at === null ? null : (
        <ChatMessageContextMenu
          state={{
            token: { close: () => setAt(null) },
            messageId: 'lab-message',
            ownerDocument: document,
            x: at.x,
            y: at.y,
            selection: at.selection,
            selectionRanges: [],
            linkUrl: at.linkUrl,
            returnFocusTo: null,
          }}
          onCopy={(text) => {
            setCopied(text);
            setAt(null);
          }}
          onClose={() => setAt(null)}
        />
      )}
    </>
  );
}

function MessageRow(): JSX.Element {
  const { targetProps, menu } = useChatMessageContextMenu({
    messageId: 'lab-row',
  });
  return (
    <div
      {...targetProps}
      className="focus-ring w-full rounded-lg bg-secondary px-3 py-2 text-s fg-primary"
    >
      Select some of this text and right-click, or focus it and press the Menu
      key. See the{' '}
      <a href="https://example.com/docs" className="fg-accent underline">
        release notes
      </a>{' '}
      for a link menu.
      {menu}
    </div>
  );
}

function MessageContextMenuSheet(): JSX.Element {
  return (
    <SpecimenPanel title="ChatMessageContextMenu (click a button to open it below the button)">
      <ChatMessageLinkActionsProvider
        value={{ openInBrowser: noop, openExternal: noop }}
      >
        <SpecimenGrid min={220}>
          <SpecimenCell label="With a selection: Copy selection is enabled">
            <MenuOpener
              label="Open with selection"
              selection="rename the settings page"
              linkUrl={null}
            />
          </SpecimenCell>
          <SpecimenCell label="With a selection on macOS: Look up follows Copy selection">
            <ChatMessageLookUpProvider value={noop}>
              <MenuOpener
                label="Open with a dictionary"
                selection="idempotent"
                linkUrl={null}
              />
            </ChatMessageLookUpProvider>
          </SpecimenCell>
          <SpecimenCell label="No selection: Copy selection is disabled">
            <MenuOpener
              label="Open with no selection"
              selection=""
              linkUrl={null}
            />
          </SpecimenCell>
          <SpecimenCell label="On a link: Copy link and both open actions, then Copy selection">
            <MenuOpener
              label="Open on a link"
              selection=""
              linkUrl="https://example.com/docs/a/very/long/path/that/keeps/going?with=query&and=more"
            />
          </SpecimenCell>
        </SpecimenGrid>
      </ChatMessageLinkActionsProvider>
      <ChatMessageLinkActionsProvider value={{}}>
        <SpecimenCell label="On a link with a host that offers no open actions: Copy link only">
          <MenuOpener
            label="Open on a link (copy only)"
            selection="release notes"
            linkUrl="https://example.com/docs"
          />
        </SpecimenCell>
        <SpecimenCell label="A real message row: right-click it" wide>
          <MessageRow />
        </SpecimenCell>
      </ChatMessageLinkActionsProvider>
    </SpecimenPanel>
  );
}

// ---------------------------------------------------------------------------
// Checklist controls
// ---------------------------------------------------------------------------

function ChecklistRowDemo({
  title,
  retry = false,
  disabled = false,
  compact = false,
}: {
  readonly title: string;
  readonly retry?: boolean;
  readonly disabled?: boolean;
  readonly compact?: boolean;
}): JSX.Element {
  return (
    <div
      className={`${CHECKLIST_ROW_CLASS_NAME} flex w-full items-center gap-2 rounded-lg px-3 py-1`}
    >
      <span className="min-w-0 flex-1 truncate text-s fg-primary">{title}</span>
      <ChecklistAction
        label={retry ? 'Try again' : 'Continue'}
        testId="lab-checklist-action"
        onClick={noop}
        retry={retry}
        disabled={disabled}
        variant={compact ? 'compact' : 'prominent'}
        fillRow
      />
      <ChecklistDismiss
        label="Dismiss"
        testId="lab-checklist-dismiss"
        onDismiss={noop}
      />
    </div>
  );
}

function ChecklistSheet(): JSX.Element {
  return (
    <SpecimenPanel title="ChecklistAction and ChecklistDismiss (hover a row: it fills, and the whole row is the action)">
      <SpecimenGrid min={320}>
        <SpecimenCell label="Prominent action with dismiss">
          <ChecklistRowDemo title="Connect your GitHub account" />
        </SpecimenCell>
        <SpecimenCell label="Compact action">
          <ChecklistRowDemo title="Invite a teammate" compact />
        </SpecimenCell>
        <SpecimenCell label="Try again after a failed step">
          <ChecklistRowDemo title="Index the repository" retry />
        </SpecimenCell>
        <SpecimenCell label="Disabled action (waiting on a prior step)">
          <ChecklistRowDemo title="Review the first pull request" disabled />
        </SpecimenCell>
        <SpecimenCell label="Long title truncates; the action stays visible">
          <ChecklistRowDemo title="Set up the shared team workspace with the organization-wide defaults, agents and review rules" />
        </SpecimenCell>
        <SpecimenCell label="Standalone, without a row">
          <ChecklistAction
            label="Continue"
            testId="lab-solo-action"
            onClick={noop}
          />
          <ChecklistAction
            label="Try again"
            testId="lab-solo-retry"
            onClick={noop}
            retry
          />
          <ChecklistDismiss
            label="Dismiss"
            testId="lab-solo-dismiss"
            onDismiss={noop}
          />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

// ---------------------------------------------------------------------------
// Claude AI credits fallback error
// ---------------------------------------------------------------------------

function ClaudeFallbackSheet(): JSX.Element {
  return (
    <SpecimenPanel title="ClaudeAiCreditsFallbackErrorNotice">
      <SpecimenGrid min={360}>
        <SpecimenCell label="Host can start the sign-in: primary action">
          <div className="w-full">
            <ClaudeAiCreditsFallbackErrorNotice onSignIn={noop} />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Host cannot (web replay): tells the reader to sign in on their computer">
          <div className="w-full">
            <ClaudeAiCreditsFallbackErrorNotice />
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

export function SharedBSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <BackgroundWorkCapSheet />
      <BillingHistorySheet />
      <BubbleCopySheet />
      <CatchingUpSheet />
      <ChatDetailSheet />
      <OverflowMenuSheet />
      <MessageContextMenuSheet />
      <ChecklistSheet />
      <ClaudeFallbackSheet />
    </div>
  );
}
