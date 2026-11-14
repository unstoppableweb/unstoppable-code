import {
  useRef,
  useState,
  type ComponentProps,
  type JSX,
  type ReactNode,
} from 'react';
import {
  Button,
  CodexAccountModelNotice,
  ComposerAccessPicker,
  ComposerDrawer,
  ComposerDrawerSection,
  ComposerIconButton,
  ComposerPlusMenuPresentation,
  ComposerTipArbiterProvider,
  ComposerTray,
  ComposerTrayHost,
  ComposerTrayProvider,
  ComposerTraySlot,
  CopyDetailsButton,
  CopyStatusRegion,
  CreditLedgerTable,
  Notice,
  useAnnouncedCopy,
  useComposerTipClaim,
  type ComposerAccessOption,
  type ComposerActionRow,
  type ComposerTipKind,
  type CreditLedgerRow,
} from '@canopy/ui-shared/components';
import {
  ApprovalAskIcon,
  ApprovalAutoIcon,
  CloseIcon,
  CopyIcon,
  MicIcon,
  PencilIcon,
  PlusLargeIcon,
  ShieldAccessIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

/**
 * Sheets for the composer-edge parts and the credit and copy parts that were
 * not on the lab yet: the account model notice, the access picker, the drawer,
 * the icon button, the plus menu, the tray, the tip arbiter, the copy
 * feedback, the copy details button and the credit ledger table.
 */

const noop = (): void => undefined;

// ---------------------------------------------------------------------------
// Account model notice
// ---------------------------------------------------------------------------

const MODEL_WITH_FALLBACK = {
  kind: 'model_unsupported',
  model: 'gpt-6.1-sol',
  modelLabel: '6.1 Sol',
  fallbackModel: 'gpt-6-luna',
  fallbackModelLabel: 'Luna 6.0',
} as const satisfies ComponentProps<typeof CodexAccountModelNotice>['failure'];

const MODEL_WITHOUT_FALLBACK = {
  kind: 'model_unsupported',
  model: 'gpt-6.1-sol',
  modelLabel: '6.1 Sol',
} as const satisfies ComponentProps<typeof CodexAccountModelNotice>['failure'];

const MODEL_LONG_LABELS = {
  kind: 'model_unsupported',
  model: 'gpt-6.1-sol-extended-reasoning-preview',
  modelLabel: '6.1 Sol extended reasoning preview for long-running tasks',
  fallbackModel: 'gpt-6-luna-mini',
  fallbackModelLabel: 'Luna 6.0 mini with the standard reasoning budget',
} as const satisfies ComponentProps<typeof CodexAccountModelNotice>['failure'];

function CodexAccountModelNoticeSheet(): JSX.Element {
  return (
    <SpecimenPanel title="CodexAccountModelNotice">
      <SpecimenGrid min={360}>
        <SpecimenCell label="With a fallback: Use switches the chat and resends">
          <div className="w-full">
            <CodexAccountModelNotice
              failure={MODEL_WITH_FALLBACK}
              onUseFallback={noop}
              dataTestId="lab-codex-notice-default"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Busy: the switch is resending">
          <div className="w-full">
            <CodexAccountModelNotice
              failure={MODEL_WITH_FALLBACK}
              onUseFallback={noop}
              busy
              dataTestId="lab-codex-notice-busy"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Disabled: the chat is read-only for now">
          <div className="w-full">
            <CodexAccountModelNotice
              failure={MODEL_WITH_FALLBACK}
              onUseFallback={noop}
              disabled
              dataTestId="lab-codex-notice-disabled"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Read-only viewer: a fallback exists but no handler">
          <div className="w-full">
            <CodexAccountModelNotice
              failure={MODEL_WITH_FALLBACK}
              dataTestId="lab-codex-notice-viewer"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="No fallback model: asks to choose another">
          <div className="w-full">
            <CodexAccountModelNotice
              failure={MODEL_WITHOUT_FALLBACK}
              onUseFallback={noop}
              dataTestId="lab-codex-notice-no-fallback"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Long model names wrap inside the notice">
          <div className="w-full">
            <CodexAccountModelNotice
              failure={MODEL_LONG_LABELS}
              onUseFallback={noop}
              dataTestId="lab-codex-notice-long"
            />
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

// ---------------------------------------------------------------------------
// Composer access picker
// ---------------------------------------------------------------------------

type AccessMode = 'ask' | 'auto' | 'full';

const ACCESS_OPTIONS: readonly ComposerAccessOption<AccessMode>[] = [
  {
    value: 'ask',
    label: 'Ask',
    description: 'Asks before running tools',
    icon: ApprovalAskIcon,
    tone: 'secondary',
  },
  {
    value: 'auto',
    label: 'Auto',
    description: 'Approves safe tools for you',
    icon: ApprovalAutoIcon,
    tone: 'secondary',
  },
  {
    value: 'full',
    label: 'Full access to everything on this computer, with no approvals',
    description:
      'Runs every tool without asking, including commands that change files outside the workspace and commands that reach the network',
    icon: ShieldAccessIcon,
    tone: 'destructive',
    className: 'fg-destructive',
  },
];

function AccessPickerSpecimen({
  initialMode = 'ask',
  ...props
}: {
  readonly initialMode?: AccessMode;
} & Partial<
  Omit<ComponentProps<typeof ComposerAccessPicker<AccessMode>>, 'options'>
>): JSX.Element {
  const [mode, setMode] = useState<AccessMode>(initialMode);
  return (
    <ComposerAccessPicker
      options={ACCESS_OPTIONS}
      {...props}
      mode={mode}
      onChange={setMode}
    />
  );
}

function TriggerlessAccessPicker(): JSX.Element {
  const [openSignal, setOpenSignal] = useState(0);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex items-center gap-2">
      <Button
        ref={anchorRef}
        size="compact"
        variant="secondary"
        onClick={(): void => setOpenSignal((count) => count + 1)}
      >
        Open permissions
      </Button>
      <AccessPickerSpecimen
        anchorRef={anchorRef}
        returnFocusRef={anchorRef}
        openSignal={openSignal}
      />
    </div>
  );
}

function ComposerAccessPickerSheet(): JSX.Element {
  return (
    <SpecimenPanel title="ComposerAccessPicker (click a trigger to open its menu; the Full access trigger shows the destructive ink)">
      <SpecimenGrid min={240}>
        <SpecimenCell label="Default: glyph, label and chevron">
          <AccessPickerSpecimen />
        </SpecimenCell>
        <SpecimenCell label="Auto mode">
          <AccessPickerSpecimen initialMode="auto" />
        </SpecimenCell>
        <SpecimenCell
          label="Full access: a long label keeps the trigger on one line"
          wide
        >
          <AccessPickerSpecimen initialMode="full" />
        </SpecimenCell>
        <SpecimenCell label="Compact, icon style (Home rail): glyph alone">
          <AccessPickerSpecimen compact />
        </SpecimenCell>
        <SpecimenCell label="Compact, label style (chat settings row): name and chevron">
          <AccessPickerSpecimen compact compactStyle="label" />
        </SpecimenCell>
        <SpecimenCell label="Trigger without a glyph">
          <AccessPickerSpecimen hideTriggerIcon />
        </SpecimenCell>
        <SpecimenCell label="Trigger without a chevron">
          <AccessPickerSpecimen hideTriggerChevron />
        </SpecimenCell>
        <SpecimenCell label="Disabled: the turn is running">
          <AccessPickerSpecimen disabled />
        </SpecimenCell>
        <SpecimenCell label="Triggerless: another control opens the menu">
          <TriggerlessAccessPicker />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

// ---------------------------------------------------------------------------
// Composer icon button
// ---------------------------------------------------------------------------

type IconButtonTone = NonNullable<
  ComponentProps<typeof ComposerIconButton>['tone']
>;

const ICON_BUTTON_TONES: readonly IconButtonTone[] = [
  'default',
  'strong',
  'pending',
  'warning',
  'destructive',
];

function ComposerIconButtonSheet(): JSX.Element {
  return (
    <SpecimenPanel title="ComposerIconButton">
      <SpecimenGrid min={200}>
        {ICON_BUTTON_TONES.map((tone) => (
          <SpecimenCell key={tone} label={`Tone ${tone}, then pressed`}>
            <ComposerIconButton aria-label={`Add, tone ${tone}`} tone={tone}>
              <PlusLargeIcon />
            </ComposerIconButton>
            <ComposerIconButton
              aria-label={`Add, tone ${tone}, pressed`}
              tone={tone}
              active
              aria-pressed
            >
              <PlusLargeIcon />
            </ComposerIconButton>
          </SpecimenCell>
        ))}
        <SpecimenCell label="Disabled, default and destructive">
          <ComposerIconButton aria-label="Add, disabled" disabled>
            <PlusLargeIcon />
          </ComposerIconButton>
          <ComposerIconButton
            aria-label="Stop dictation, disabled"
            tone="destructive"
            disabled
          >
            <MicIcon />
          </ComposerIconButton>
        </SpecimenCell>
        <SpecimenCell label="Capsule: 32px circle, then wide with a trailing glyph">
          <ComposerIconButton aria-label="Dictate" capsule>
            <MicIcon />
          </ComposerIconButton>
          <ComposerIconButton aria-label="Dictate, with options" capsule wide>
            <MicIcon />
            <CloseIcon />
          </ComposerIconButton>
        </SpecimenCell>
        <SpecimenCell label="Square, wide with a trailing glyph">
          <ComposerIconButton aria-label="Add, with options" wide>
            <PlusLargeIcon />
            <CloseIcon />
          </ComposerIconButton>
        </SpecimenCell>
        <SpecimenCell label="Labeled capsule (auto width) and its long label">
          <ComposerIconButton aria-label="Copy transcript" capsule autoWidth>
            <CopyIcon />
            <span>Copy</span>
          </ComposerIconButton>
          <ComposerIconButton
            aria-label="Copy the whole transcript to the clipboard"
            capsule
            autoWidth
          >
            <CopyIcon />
            <span>Copy the whole transcript</span>
          </ComposerIconButton>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

// ---------------------------------------------------------------------------
// Composer plus menu
// ---------------------------------------------------------------------------

const PLUS_ROWS: readonly ComposerActionRow[] = [
  {
    id: 'attachment',
    label: 'Add a file or photo',
    description: 'Attach from this computer',
    icon: <PlusLargeIcon />,
    group: 'Add',
    dataTestId: 'lab-plus-row-attachment',
    onSelect: noop,
  },
  {
    id: 'edit',
    label: 'Edit the system prompt for this chat',
    description:
      'Changes the instructions the agent follows for every turn in this chat',
    icon: <PencilIcon />,
    group: 'Add',
    dataTestId: 'lab-plus-row-edit',
    onSelect: noop,
  },
  {
    id: 'clear',
    label: 'Clear the queue',
    icon: <TrashIcon />,
    group: 'Manage',
    disabled: true,
    dataTestId: 'lab-plus-row-clear',
    onSelect: noop,
  },
  {
    id: 'plan',
    label: 'Plan mode',
    icon: <ApprovalAskIcon />,
    group: 'Manage',
    ariaChecked: true,
    dataTestId: 'lab-plus-row-plan',
    onSelect: noop,
  },
];

const PLUS_SHOW_ALL = {
  label: 'Show all 14 actions',
  onSelect: noop,
  dataTestId: 'lab-plus-show-all',
} as const;

function PlusMenuSpecimen({
  rows = PLUS_ROWS,
  prefix,
  ...props
}: {
  readonly rows?: readonly ComposerActionRow[];
  readonly prefix: string;
} & Partial<
  Omit<
    ComponentProps<typeof ComposerPlusMenuPresentation>,
    'isOpen' | 'setIsOpen' | 'rows' | 'anchorRef' | 'triggerRef'
  >
>): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div ref={anchorRef} className="inline-flex">
      <ComposerPlusMenuPresentation
        keyboardNavigation
        isOpen={open}
        setIsOpen={setOpen}
        rows={[...rows]}
        anchorRef={anchorRef}
        triggerRef={triggerRef}
        returnFocusRef={triggerRef}
        dataTestIdPrefix={prefix}
        menuId={`${prefix}-menu`}
        {...props}
      />
    </div>
  );
}

function ComposerPlusMenuPresentationSheet(): JSX.Element {
  return (
    <SpecimenPanel title="ComposerPlusMenuPresentation (click a trigger to open the menu)">
      <SpecimenGrid min={200}>
        <SpecimenCell label="Default trigger">
          <PlusMenuSpecimen prefix="lab-plus-default" />
        </SpecimenCell>
        <SpecimenCell label="Capsule trigger">
          <PlusMenuSpecimen prefix="lab-plus-capsule" capsuleTrigger />
        </SpecimenCell>
        <SpecimenCell label="Active: the menu holds an attention item">
          <PlusMenuSpecimen prefix="lab-plus-active" capsuleTrigger active />
        </SpecimenCell>
        <SpecimenCell label="Disabled">
          <PlusMenuSpecimen
            prefix="lab-plus-disabled"
            capsuleTrigger
            disabled
          />
        </SpecimenCell>
        <SpecimenCell label="With a shortcut hint in the tooltip">
          <PlusMenuSpecimen
            prefix="lab-plus-shortcut"
            capsuleTrigger
            shortcut="⌘K"
          />
        </SpecimenCell>
        <SpecimenCell label="Touch tap targets">
          <PlusMenuSpecimen
            prefix="lab-plus-touch"
            capsuleTrigger
            tapTarget="touch"
          />
        </SpecimenCell>
        <SpecimenCell label="Grouped rows (open it to see): a disabled row, a toggle and long text">
          <PlusMenuSpecimen
            prefix="lab-plus-grouped"
            capsuleTrigger
            showAll={PLUS_SHOW_ALL}
          />
        </SpecimenCell>
        <SpecimenCell label="Loading results (open it to see)">
          <PlusMenuSpecimen
            prefix="lab-plus-loading"
            capsuleTrigger
            loading
            rows={[]}
          />
        </SpecimenCell>
        <SpecimenCell label="Empty: no actions (open it to see)">
          <PlusMenuSpecimen prefix="lab-plus-empty" capsuleTrigger rows={[]} />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

// ---------------------------------------------------------------------------
// Composer drawer
// ---------------------------------------------------------------------------

function ComposerBox({
  children,
}: {
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <div className="relative flex min-h-16 items-center rounded-2xl bg-tertiary px-4 text-s fg-secondary shadow-2xs">
      {children ?? 'Ask anything, or type / for commands'}
    </div>
  );
}

function DrawerTip({
  children,
  onDismiss,
}: {
  readonly children: ReactNode;
  readonly onDismiss?: () => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 text-s fg-secondary">
      <span className="min-w-0 flex-1">{children}</span>
      {onDismiss ? (
        <ComposerIconButton aria-label="Dismiss tip" onClick={onDismiss}>
          <CloseIcon />
        </ComposerIconButton>
      ) : null}
    </div>
  );
}

function DismissibleTipDrawer(): JSX.Element {
  const [shown, setShown] = useState(true);
  return (
    <div className="flex flex-col">
      <ComposerDrawer edge="top">
        {shown ? (
          <ComposerDrawerSection>
            <DrawerTip onDismiss={(): void => setShown(false)}>
              Press Shift+Tab to switch to plan mode. Dismiss it to see the
              drawer draw nothing.
            </DrawerTip>
          </ComposerDrawerSection>
        ) : null}
      </ComposerDrawer>
      <ComposerBox />
    </div>
  );
}

function ComposerDrawerSheet(): JSX.Element {
  return (
    <SpecimenPanel title="ComposerDrawer and ComposerDrawerSection">
      <SpecimenGrid min={340}>
        <SpecimenCell label="Top edge, one section: tucks 16px under the composer">
          <div className="flex w-full flex-col">
            <ComposerDrawer edge="top">
              <ComposerDrawerSection>
                <DrawerTip>Tip: type @ to mention a file.</DrawerTip>
              </ComposerDrawerSection>
            </ComposerDrawer>
            <ComposerBox />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Top edge, two sections: a hairline divides them">
          <div className="flex w-full flex-col">
            <ComposerDrawer edge="top">
              <ComposerDrawerSection>
                <DrawerTip>Tip: type @ to mention a file.</DrawerTip>
              </ComposerDrawerSection>
              <ComposerDrawerSection>
                <DrawerTip>2 background tasks are still running.</DrawerTip>
              </ComposerDrawerSection>
            </ComposerDrawer>
            <ComposerBox />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Bottom edge: sits under the composer (MCP sign-in)">
          <div className="flex w-full flex-col">
            <ComposerBox />
            <ComposerDrawer edge="bottom">
              <ComposerDrawerSection>
                <DrawerTip>
                  Sign in to the Linear connector to continue.
                </DrawerTip>
              </ComposerDrawerSection>
            </ComposerDrawer>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Labelled region (as a section) with long text">
          <div className="flex w-full flex-col">
            <ComposerDrawer edge="top" as="section" aria-label="Composer tips">
              <ComposerDrawerSection>
                <DrawerTip>
                  This drawer is a labelled region. Its text wraps instead of
                  growing the drawer sideways, however long the tip becomes, and
                  the dismiss control keeps its place at the end.
                </DrawerTip>
              </ComposerDrawerSection>
            </ComposerDrawer>
            <ComposerBox />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Empty: draws nothing, the composer keeps its place">
          <div className="flex w-full flex-col">
            <ComposerDrawer edge="top">{null}</ComposerDrawer>
            <ComposerBox />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Dismissing the only section empties the drawer">
          <div className="w-full">
            <DismissibleTipDrawer />
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

// ---------------------------------------------------------------------------
// Composer tray
// ---------------------------------------------------------------------------

function QueueCard({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="px-4">
      <div className="relative flex items-center gap-2 rounded-t-xl bg-depth px-3 py-2 pb-5 text-s fg-secondary">
        {children}
      </div>
    </div>
  );
}

function ComposerTraySheet(): JSX.Element {
  return (
    <SpecimenPanel title="ComposerTray, ComposerTrayProvider, ComposerTrayHost and ComposerTraySlot">
      <SpecimenGrid min={340}>
        <SpecimenCell label="No provider: the tray renders in place, above the transcript">
          <div className="flex w-full flex-col">
            <ComposerTray>
              <QueueCard>2 messages queued</QueueCard>
            </ComposerTray>
            <ComposerBox />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Active host, no drawer: the tray lands on the composer box">
          <div className="w-full">
            <ComposerTrayProvider>
              <div className="flex flex-col gap-2">
                <p className="px-1 text-xs fg-tertiary">
                  Transcript owns the queue content.
                </p>
                <ComposerTray>
                  <QueueCard>2 messages queued</QueueCard>
                </ComposerTray>
                <ComposerTrayHost active>
                  <ComposerTraySlot />
                  <ComposerBox />
                </ComposerTrayHost>
              </div>
            </ComposerTrayProvider>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Top drawer present: the tray tucks under the drawer">
          <div className="w-full">
            <ComposerTrayProvider>
              <ComposerTray>
                <QueueCard>Edit queued: reply to the review comment</QueueCard>
              </ComposerTray>
              <ComposerTrayHost active>
                <ComposerDrawer edge="top">
                  <ComposerDrawerSection>
                    <DrawerTip>Tip: type @ to mention a file.</DrawerTip>
                  </ComposerDrawerSection>
                </ComposerDrawer>
                <ComposerBox />
              </ComposerTrayHost>
            </ComposerTrayProvider>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Inactive host (a hidden composer): the tray stays in place">
          <div className="w-full">
            <ComposerTrayProvider>
              <ComposerTray>
                <QueueCard>1 message queued</QueueCard>
              </ComposerTray>
              <ComposerTrayHost active={false}>
                <ComposerBox />
              </ComposerTrayHost>
            </ComposerTrayProvider>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Provider off: passes through to the enclosing surface">
          <div className="w-full">
            <ComposerTrayProvider>
              <ComposerTrayProvider enabled={false}>
                <ComposerTray>
                  <QueueCard>3 messages queued</QueueCard>
                </ComposerTray>
              </ComposerTrayProvider>
              <ComposerTrayHost active>
                <ComposerTraySlot />
                <ComposerBox />
              </ComposerTrayHost>
            </ComposerTrayProvider>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Long queue text wraps inside the card">
          <div className="w-full">
            <ComposerTrayProvider>
              <ComposerTray>
                <QueueCard>
                  Queued: please rebase the branch onto the latest main, rerun
                  the full test suite, and summarize every file that changed in
                  the pull request description
                </QueueCard>
              </ComposerTray>
              <ComposerTrayHost active>
                <ComposerTraySlot />
                <ComposerBox />
              </ComposerTrayHost>
            </ComposerTrayProvider>
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

// ---------------------------------------------------------------------------
// Composer tip arbiter
// ---------------------------------------------------------------------------

function TipClaimant({
  kind,
  wants,
  children,
}: {
  readonly kind: ComposerTipKind;
  readonly wants: boolean;
  readonly children: string;
}): ReactNode {
  const { visible } = useComposerTipClaim(kind, wants);
  return visible ? (
    <ComposerDrawerSection>
      <DrawerTip>{children}</DrawerTip>
    </ComposerDrawerSection>
  ) : null;
}

function TipArbiterSpecimen({
  initialPlan,
  initialStar,
  withProvider = true,
}: {
  readonly initialPlan: boolean;
  readonly initialStar: boolean;
  readonly withProvider?: boolean;
}): JSX.Element {
  const [plan, setPlan] = useState(initialPlan);
  const [star, setStar] = useState(initialStar);
  const tips = (
    <>
      <TipClaimant kind="plan-mode" wants={plan}>
        Press Shift+Tab to switch to plan mode.
      </TipClaimant>
      <TipClaimant kind="github-star" wants={star}>
        Enjoying the app? Star it on GitHub.
      </TipClaimant>
    </>
  );
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          size="compact"
          variant="secondary"
          aria-pressed={plan}
          onClick={(): void => setPlan((current) => !current)}
        >
          {plan ? 'Plan tip wants to show' : 'Plan tip is off'}
        </Button>
        <Button
          size="compact"
          variant="secondary"
          aria-pressed={star}
          onClick={(): void => setStar((current) => !current)}
        >
          {star ? 'Star tip wants to show' : 'Star tip is off'}
        </Button>
      </div>
      <div className="flex flex-col">
        <ComposerDrawer edge="top">
          {withProvider ? (
            <ComposerTipArbiterProvider>{tips}</ComposerTipArbiterProvider>
          ) : (
            tips
          )}
        </ComposerDrawer>
        <ComposerBox />
      </div>
    </div>
  );
}

function ComposerTipArbiterSheet(): JSX.Element {
  return (
    <SpecimenPanel title="ComposerTipArbiterProvider (plan mode outranks the star prompt; toggle either tip)">
      <SpecimenGrid min={340}>
        <SpecimenCell label="Both want to show: only the plan tip does">
          <TipArbiterSpecimen initialPlan initialStar />
        </SpecimenCell>
        <SpecimenCell label="Only the star tip wants to show: it shows">
          <TipArbiterSpecimen initialPlan={false} initialStar />
        </SpecimenCell>
        <SpecimenCell label="Neither wants to show: the drawer draws nothing">
          <TipArbiterSpecimen initialPlan={false} initialStar={false} />
        </SpecimenCell>
        <SpecimenCell label="No provider: every tip that wants to show does">
          <TipArbiterSpecimen initialPlan initialStar withProvider={false} />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

// ---------------------------------------------------------------------------
// Copy feedback and the copy details button
// ---------------------------------------------------------------------------

const NEVER_SETTLES = new Promise<boolean>(() => undefined);

function CopyFeedbackSpecimen({
  write,
  failureAnnouncement,
  label,
}: {
  readonly write: (text: string) => Promise<boolean>;
  readonly failureAnnouncement?: string;
  readonly label: string;
}): JSX.Element {
  const { copied, failed, announcement, copy } = useAnnouncedCopy({
    write,
    ...(failureAnnouncement !== undefined ? { failureAnnouncement } : {}),
  });
  return (
    <div className="flex flex-col items-start gap-1.5">
      <span className="relative">
        <Button
          size="compact"
          variant="secondary"
          onClick={(): void => {
            void copy('ssh-ed25519 AAAA… agent@build-host');
          }}
        >
          {copied ? 'Copied' : failed ? 'Copy failed' : label}
        </Button>
        <CopyStatusRegion announcement={announcement} />
      </span>
      <span className="text-2xs fg-tertiary">
        Live region says: {announcement === '' ? 'nothing yet' : announcement}
      </span>
    </div>
  );
}

function CopyFeedbackSheet(): JSX.Element {
  return (
    <SpecimenPanel title="useAnnouncedCopy and CopyStatusRegion (click each button: the copy control confirms in place and the hidden live region announces)">
      <SpecimenGrid min={240}>
        <SpecimenCell label="Succeeds: Copied, announced after a beat, then back to Copy key">
          <CopyFeedbackSpecimen
            label="Copy key"
            write={(): Promise<boolean> => Promise.resolve(true)}
          />
        </SpecimenCell>
        <SpecimenCell label="Fails with a message: announces the failure">
          <CopyFeedbackSpecimen
            label="Copy key"
            failureAnnouncement="Couldn't copy to the clipboard"
            write={(): Promise<boolean> => Promise.resolve(false)}
          />
        </SpecimenCell>
        <SpecimenCell label="Rejected write counts as a failure and never throws">
          <CopyFeedbackSpecimen
            label="Copy key"
            failureAnnouncement="Couldn't copy to the clipboard"
            write={(): Promise<boolean> =>
              Promise.reject(new Error('Clipboard is blocked'))
            }
          />
        </SpecimenCell>
        <SpecimenCell label="Fails without a message: stays silent">
          <CopyFeedbackSpecimen
            label="Copy key"
            write={(): Promise<boolean> => Promise.resolve(false)}
          />
        </SpecimenCell>
        <SpecimenCell label="Pending write: nothing is announced until it settles">
          <CopyFeedbackSpecimen
            label="Copy key"
            write={(): Promise<boolean> => NEVER_SETTLES}
          />
        </SpecimenCell>
        <SpecimenCell label="Long label stays on one control">
          <CopyFeedbackSpecimen
            label="Copy the public key for the build host"
            write={(): Promise<boolean> => Promise.resolve(true)}
          />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

const SERVER_REASON =
  'ECONNRESET: upstream closed the stream at offset 4096 (request id req_9f3a2c7e)';

function CopyDetailsButtonSheet(): JSX.Element {
  return (
    <SpecimenPanel title="CopyDetailsButton (the raw reason is copied and never shown)">
      <SpecimenGrid min={360}>
        <SpecimenCell label="In a failure notice: Copy details, then Copied">
          <div className="w-full">
            <Notice
              errorSource="preview-copy-details-button-sheet"
              intent="destructive"
              title="Couldn't load usage."
              actions={
                <CopyDetailsButton
                  details={SERVER_REASON}
                  data-testid="lab-copy-details-default"
                  write={(): Promise<boolean> => Promise.resolve(true)}
                />
              }
            >
              Try again in a moment.
            </Notice>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Clipboard refuses: the label stays and the failure is announced">
          <div className="w-full">
            <Notice
              errorSource="preview-copy-details-button-sheet"
              intent="destructive"
              title="Couldn't load usage."
              actions={
                <CopyDetailsButton
                  details={SERVER_REASON}
                  data-testid="lab-copy-details-refused"
                  write={(): Promise<boolean> => Promise.resolve(false)}
                />
              }
            >
              Try again in a moment.
            </Notice>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Write rejects: counts as a refusal">
          <div className="w-full">
            <Notice
              errorSource="preview-copy-details-button-sheet"
              intent="destructive"
              title="Couldn't load usage."
              actions={
                <CopyDetailsButton
                  details={SERVER_REASON}
                  data-testid="lab-copy-details-rejected"
                  write={(): Promise<boolean> =>
                    Promise.reject(new Error('Clipboard is blocked'))
                  }
                />
              }
            >
              Try again in a moment.
            </Notice>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Long reason: still never rendered, so the notice does not grow">
          <div className="w-full">
            <Notice
              errorSource="preview-copy-details-button-sheet"
              intent="destructive"
              title="Couldn't load usage."
              actions={
                <CopyDetailsButton
                  details={SERVER_REASON.repeat(8)}
                  data-testid="lab-copy-details-long"
                  write={(): Promise<boolean> => Promise.resolve(true)}
                />
              }
            >
              Try again in a moment.
            </Notice>
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

// ---------------------------------------------------------------------------
// Credit ledger table
// ---------------------------------------------------------------------------

const LEDGER_ENTRIES: CreditLedgerRow[] = [
  {
    id: 'led-1',
    createdAt: '2026-11-03T14:20:00.000Z',
    credits: 5000,
    description: 'Top-up',
  },
  {
    id: 'led-2',
    createdAt: '2026-11-02T09:05:00.000Z',
    credits: -120,
    description: 'Usage',
  },
  {
    id: 'led-3',
    createdAt: '2026-11-01T18:40:00.000Z',
    credits: -1830,
    description: 'Usage',
  },
  {
    id: 'led-4',
    createdAt: '2026-10-30T07:00:00.000Z',
    credits: 250,
    description: 'Refund for an interrupted run',
  },
];

const LEDGER_LONG: CreditLedgerRow[] = [
  {
    id: 'led-long',
    createdAt: '2026-11-03T14:20:00.000Z',
    credits: -1250000,
    description:
      'Usage by the nightly dependency audit pipeline across all organization projects, including the retries after the provider rate limit',
  },
  {
    id: 'led-bonus',
    createdAt: '2026-11-02T09:05:00.000Z',
    credits: 1000000,
    description: 'Annual plan credits',
  },
];

const LEDGER_NO_DESCRIPTION: CreditLedgerRow[] = [
  {
    id: 'led-blank',
    createdAt: '2026-11-03T14:20:00.000Z',
    credits: -40,
  },
];

const formatLedgerDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

function CreditLedgerTableSheet(): JSX.Element {
  return (
    <SpecimenPanel title="CreditLedgerTable (the table shows from the sm breakpoint; below it the same entries stack as cards)">
      <SpecimenGrid min={420}>
        <SpecimenCell label="Credits in primary ink, debits muted">
          <div className="w-full">
            <CreditLedgerTable
              entries={LEDGER_ENTRIES}
              formatDate={formatLedgerDate}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Long description wraps; large figures stay on one line">
          <div className="w-full">
            <CreditLedgerTable
              entries={LEDGER_LONG}
              formatDate={formatLedgerDate}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Entry with no description shows a dash">
          <div className="w-full">
            <CreditLedgerTable
              entries={LEDGER_NO_DESCRIPTION}
              formatDate={formatLedgerDate}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Empty: only the header; the wrapper owns the empty state">
          <div className="w-full">
            <CreditLedgerTable entries={[]} formatDate={formatLedgerDate} />
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

export function SharedCSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <CodexAccountModelNoticeSheet />
      <ComposerAccessPickerSheet />
      <ComposerIconButtonSheet />
      <ComposerPlusMenuPresentationSheet />
      <ComposerDrawerSheet />
      <ComposerTraySheet />
      <ComposerTipArbiterSheet />
      <CopyFeedbackSheet />
      <CopyDetailsButtonSheet />
      <CreditLedgerTableSheet />
    </div>
  );
}
