import type { JSX, ReactNode } from 'react';
import type { SettingsHeldChange } from '@canopy/protocol/portal';
import {
  AgentSentMarker,
  Button,
  QueuedMessageActions,
  type QueuedMessageActionsProps,
  type QueuedMessageAttachment,
  QueuedMessageReason,
  QueuedMessageRow,
  type QueuedMessageRowProps,
  QueuedMessageSettingsHeldWarning,
  Surface,
} from '@canopy/ui-shared/components';
import { ArrowUpIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  FocusOnMount,
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

// A stand-in screenshot (the lab has no network).
const SHOT = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#6b8cae"/><circle cx="16" cy="18" r="6" fill="#f1d7c1"/><path d="M0 48l16-16 10 10 8-8 14 14z" fill="#2f3e57"/></svg>',
)}`;

const LONG_TEXT =
  'Rework the sign-in flow so the session token refreshes in the background, keeps the current draft, and never shows the expired banner while a request is still in flight';

const ALL_HELD_SETTINGS: readonly SettingsHeldChange[] = [
  'model',
  'thinking_level',
  'agent',
  'plan_mode',
  'plugins',
  'tools',
  'instructions',
  'approval_rules',
  'delegation',
  'codex_preferences',
  'account',
  'organization',
];

function steeringRequest(request: string, sender: string): string {
  return `<system_instruction>A managed subordinate (${sender}) requested steering. <subordinate_request>${request}</subordinate_request></system_instruction>`;
}

/** The row inside the list it always ships in. */
function RowList({
  children,
  drawer = false,
}: {
  readonly children: ReactNode;
  readonly drawer?: boolean;
}): JSX.Element {
  return (
    <div
      role="list"
      className={`w-full min-w-0 rounded-xl py-1 ${drawer ? 'bg-base' : 'bg-secondary'}`}
    >
      {children}
    </div>
  );
}

function Row(props: QueuedMessageRowProps): JSX.Element {
  return (
    <RowList drawer={props.surface === 'drawer'}>
      <QueuedMessageRow {...props} />
    </RowList>
  );
}

const IMAGE: QueuedMessageAttachment = {
  key: 'shot',
  kind: 'image',
  name: 'checkout-error.png',
  src: SHOT,
};
const VIDEO: QueuedMessageAttachment = {
  key: 'clip',
  kind: 'video',
  name: 'repro.mov',
  src: null,
};
const FILE: QueuedMessageAttachment = {
  key: 'log',
  kind: 'file',
  name: 'server-2026-11-04.log',
};

const MESSAGE = 'Add retry handling to the upload step';

interface RowCase {
  readonly label: string;
  readonly props: QueuedMessageRowProps;
  readonly wide?: boolean;
}

const BASE_ACTIONS = {
  onSteer: noop,
  onInterrupt: noop,
  onEdit: noop,
  onDelete: noop,
} as const;

const ROW_CASES: readonly RowCase[] = [
  {
    label: 'Default: Steer, Interrupt and the more menu',
    props: { text: MESSAGE, ...BASE_ACTIONS },
  },
  {
    label: 'Reorderable: drag handle first',
    props: { text: MESSAGE, ...BASE_ACTIONS, reorder: { handleProps: {} } },
  },
  {
    label: 'Being dragged: the row is lifted',
    props: {
      text: MESSAGE,
      ...BASE_ACTIONS,
      reorder: { handleProps: {}, dragging: true },
    },
  },
  {
    label: 'Cannot move now: handle disabled, reason on hover',
    props: {
      text: MESSAGE,
      ...BASE_ACTIONS,
      reorder: {
        handleProps: {},
        unavailableReason: 'Available when the current step finishes',
      },
    },
  },
  {
    label: 'Cannot steer: Send now alone',
    props: { text: MESSAGE, onInterrupt: noop, onDelete: noop },
  },
  {
    label: 'Steer unavailable: disabled with its reason',
    props: {
      text: MESSAGE,
      ...BASE_ACTIONS,
      steerUnavailableReason: 'The agent cannot take a new message right now',
    },
  },
  {
    label: 'Steering blocked by a capability change',
    props: {
      text: MESSAGE,
      ...BASE_ACTIONS,
      steerBlockedByCapabilityChange: true,
    },
  },
  {
    label: 'Interrupt unavailable: disabled with its reason',
    props: {
      text: MESSAGE,
      ...BASE_ACTIONS,
      interruptUnavailableReason: 'Available when the current step finishes',
    },
  },
  {
    label: 'Interrupt as an icon button',
    props: { text: MESSAGE, ...BASE_ACTIONS, interruptIcon: ArrowUpIcon },
  },
  {
    label: 'Held until credits are added: Try again disabled',
    props: {
      text: MESSAGE,
      onDelete: noop,
      onEdit: noop,
      sendBlockedReason: 'insufficient_credits',
    },
  },
  {
    label: 'Try again after a failed send',
    props: { text: MESSAGE, ...BASE_ACTIONS, forceKind: 'retry' },
  },
  {
    label: 'Run now for a message waiting on a slot',
    props: { text: MESSAGE, ...BASE_ACTIONS, forceKind: 'run-now' },
  },
  {
    label: 'Settings waiting: warning before the actions',
    props: {
      text: MESSAGE,
      ...BASE_ACTIONS,
      settingsHeld: ['model', 'plugins'],
    },
  },
  {
    label: 'Sending: actions disabled until the message is queued',
    props: { text: MESSAGE, ...BASE_ACTIONS, sending: true },
  },
  {
    label: 'Status after the text',
    props: {
      text: MESSAGE,
      ...BASE_ACTIONS,
      status: 'Sends when the agent is free',
    },
  },
  {
    label: 'Status with the inline waiting reason',
    props: {
      text: MESSAGE,
      ...BASE_ACTIONS,
      status: (
        <QueuedMessageReason
          waitingReason="steer_unavailable"
          layout="inline"
        />
      ),
    },
  },
  {
    label: 'Fired watcher label',
    props: {
      text: 'The build finished with 2 warnings',
      ...BASE_ACTIONS,
      watcherFired: { kind: 'Build' },
    },
  },
  {
    label: 'Steering request from a delegate',
    props: {
      text: steeringRequest(
        'Use the shared client for retries',
        'Upload worker',
      ),
      ...BASE_ACTIONS,
    },
  },
  {
    label: 'Agent sender label',
    props: {
      text: MESSAGE,
      ...BASE_ACTIONS,
      label: (
        <AgentSentMarker
          agentSent={{
            kind: 'managed_delegate',
            delegationId: 'delegation-1',
            title: 'Upload worker',
          }}
          layout="inline"
        />
      ),
    },
  },
  {
    label: 'Image, video and file attachments',
    props: {
      text: MESSAGE,
      ...BASE_ACTIONS,
      attachments: [IMAGE, VIDEO, FILE],
    },
  },
  {
    label: 'More than three attachments are counted',
    props: {
      text: MESSAGE,
      ...BASE_ACTIONS,
      attachments: [
        IMAGE,
        { ...IMAGE, key: 'shot-2' },
        VIDEO,
        FILE,
        { ...FILE, key: 'log-2' },
      ],
    },
  },
  {
    label: 'Attachments only: no text',
    props: { text: '', ...BASE_ACTIONS, attachments: [IMAGE] },
  },
  {
    label: 'Long text truncates to one line',
    props: {
      text: LONG_TEXT,
      ...BASE_ACTIONS,
      status: 'Waiting',
      attachments: [FILE],
    },
  },
  {
    label: 'Multi-line text collapses to one line',
    props: { text: 'First line\n\n  second line\nthird line', ...BASE_ACTIONS },
  },
  {
    label: 'Drawer surface',
    props: {
      text: MESSAGE,
      ...BASE_ACTIONS,
      surface: 'drawer',
      reorder: { handleProps: {} },
    },
  },
  {
    label: 'Drawer surface, held until credits are added',
    props: {
      text: MESSAGE,
      onDelete: noop,
      onInterrupt: noop,
      surface: 'drawer',
      sendBlockedReason: 'insufficient_credits',
    },
  },
];

export function QueuedMessageRowSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Every state">
        <SpecimenGrid min={420}>
          {ROW_CASES.map(({ label, props }) => (
            <SpecimenCell key={label} label={label} wide>
              <Row {...props} />
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Keyboard focus and the list">
        <SpecimenGrid min={420}>
          <SpecimenCell label="Focused row action (keyboard ring)" wide>
            <FocusOnMount>
              <Row text={MESSAGE} onSteer={noop} onInterrupt={noop} />
            </FocusOnMount>
          </SpecimenCell>
          <SpecimenCell label="A queue of three" wide>
            <RowList>
              <QueuedMessageRow text="Add retry handling" {...BASE_ACTIONS} />
              <QueuedMessageRow
                text="Write the migration notes"
                {...BASE_ACTIONS}
                status="Waiting"
              />
              <QueuedMessageRow text={LONG_TEXT} {...BASE_ACTIONS} />
            </RowList>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

type ActionsCase = readonly [string, QueuedMessageActionsProps];

const FOOTER_CASES: readonly ActionsCase[] = [
  [
    'Steer then Interrupt',
    { placement: 'footer', onSteer: noop, onInterrupt: noop },
  ],
  [
    'Settings waiting: warning first',
    {
      placement: 'footer',
      onSteer: noop,
      onInterrupt: noop,
      settingsHeld: ['model', 'plan_mode'],
    },
  ],
  [
    'Settings waiting, no names from the host',
    { placement: 'footer', onSteer: noop, onInterrupt: noop, settingsHeld: [] },
  ],
  [
    'Steering blocked by a capability change: Steer disabled',
    {
      placement: 'footer',
      onSteer: noop,
      steeringSupported: true,
      steerBlockedByCapabilityChange: true,
    },
  ],
  [
    'Host says it cannot steer this row (canSteer off)',
    { placement: 'footer', onSteer: noop, onInterrupt: noop, canSteer: false },
  ],
  [
    'Interrupt disabled',
    {
      placement: 'footer',
      onSteer: noop,
      onInterrupt: noop,
      interruptDisabled: true,
    },
  ],
  [
    'Foreground turn with Try again',
    { placement: 'footer', onSteer: noop, onInterrupt: noop, onRetry: noop },
  ],
  [
    'Background work: Try again and Run now only',
    {
      placement: 'footer',
      turnPhase: 'background',
      onSteer: noop,
      onInterrupt: noop,
      onRetry: noop,
      onRunNow: noop,
    },
  ],
  [
    'Idle: Steer and Interrupt are withheld, nothing left to show',
    {
      placement: 'footer',
      turnPhase: 'idle',
      onSteer: noop,
      onInterrupt: noop,
    },
  ],
  ['Run now', { placement: 'footer', onRunNow: noop }],
  [
    'Held until credits are added: Try again disabled',
    {
      placement: 'footer',
      onSteer: noop,
      onInterrupt: noop,
      onRunNow: noop,
      retryBlockedReason: 'insufficient_credits',
    },
  ],
  [
    'Edit locked: Steer hidden',
    {
      placement: 'footer',
      onSteer: noop,
      onInterrupt: noop,
      onRetry: noop,
      editLocked: true,
      forceLocked: false,
    },
  ],
  [
    'Force locked: Interrupt, Try again and Run now hidden',
    {
      placement: 'footer',
      onSteer: noop,
      onInterrupt: noop,
      onRetry: noop,
      onRunNow: noop,
      forceLocked: true,
    },
  ],
  [
    'Sending: only Steer remains',
    {
      placement: 'footer',
      onSteer: noop,
      onInterrupt: noop,
      onRetry: noop,
      pending: true,
    },
  ],
  [
    'Another message is being edited: everything withheld',
    {
      placement: 'footer',
      onSteer: noop,
      onInterrupt: noop,
      anyEditing: true,
    },
  ],
];

const CORNER_CASES: readonly ActionsCase[] = [
  [
    'Popover: text Edit and Clear',
    { placement: 'corner', onEdit: noop, onCancel: noop },
  ],
  [
    'Badge: icon Edit and Clear',
    { placement: 'corner', variant: 'badge', onEdit: noop, onCancel: noop },
  ],
  [
    'Sending: Edit hidden, Clear disabled',
    {
      placement: 'corner',
      variant: 'badge',
      onEdit: noop,
      onCancel: noop,
      pending: true,
    },
  ],
  [
    'Edit locked: Clear only',
    { placement: 'corner', onEdit: noop, onCancel: noop, editLocked: true },
  ],
  [
    'Another message is being edited: Clear only',
    {
      placement: 'corner',
      variant: 'badge',
      onEdit: noop,
      onCancel: noop,
      anyEditing: true,
    },
  ],
  [
    'Custom names for Edit and Clear',
    {
      placement: 'corner',
      onEdit: noop,
      onCancel: noop,
      editLabel: 'Edit the upload message',
      cancelLabel: 'Remove the upload message',
    },
  ],
  [
    'Host control before Edit',
    {
      placement: 'corner',
      variant: 'badge',
      onEdit: noop,
      onCancel: noop,
      cornerLeading: (
        <Button size="compact" variant="secondary">
          Copy
        </Button>
      ),
    },
  ],
];

/** A bubble-sized frame so the corner badges and footer sit as they ship. */
function BubbleFrame({
  children,
  revealed = false,
}: {
  readonly children: ReactNode;
  readonly revealed?: boolean;
}): JSX.Element {
  return (
    <div className="w-full min-w-0 max-w-md pr-2 pt-2">
      <div className="group relative">
        <div className="rounded-2xl bg-secondary px-3 py-2 text-s fg-primary">
          {MESSAGE}
        </div>
        <div className={revealed ? '[&>div]:opacity-100' : undefined}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function QueuedMessageActionsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Footer pills (under the bubble)">
        <SpecimenGrid min={340}>
          {FOOTER_CASES.map(([label, props]) => (
            <SpecimenCell key={label} label={label}>
              <div className="min-h-7 w-full">
                <QueuedMessageActions {...props} />
              </div>
            </SpecimenCell>
          ))}
          <SpecimenCell label="Badge variant wraps in a narrow column">
            <div className="w-56 min-w-0">
              <QueuedMessageActions
                placement="footer"
                variant="badge"
                onSteer={noop}
                onInterrupt={noop}
                onRetry={noop}
                onRunNow={noop}
              />
            </div>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Corner badges (shown on hover or focus, held open here)">
        <SpecimenGrid min={340}>
          {CORNER_CASES.map(([label, props]) => (
            <SpecimenCell key={label} label={label}>
              <BubbleFrame revealed>
                <QueuedMessageActions {...props} />
              </BubbleFrame>
            </SpecimenCell>
          ))}
          <SpecimenCell label="At rest: hidden until the bubble is hovered or focused">
            <BubbleFrame>
              <QueuedMessageActions
                placement="corner"
                variant="badge"
                onEdit={noop}
                onCancel={noop}
              />
            </BubbleFrame>
          </SpecimenCell>
          <SpecimenCell label="Nothing to show: no callbacks, renders nothing">
            <Surface variant="group" size="small" className="w-full">
              <div className="min-h-7 px-2 py-1 text-2xs fg-tertiary">
                <QueuedMessageActions placement="corner" />
                (empty)
              </div>
            </Surface>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

export function QueuedMessageReasonSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="Why a queued message is waiting">
      <SpecimenGrid min={300}>
        <SpecimenCell label="Free-text reason">
          <QueuedMessageReason reason="Waiting for the upload to finish" />
        </SpecimenCell>
        <SpecimenCell label="Long free-text reason wraps">
          <QueuedMessageReason reason={LONG_TEXT} />
        </SpecimenCell>
        <SpecimenCell label="Host reason: the agent cannot take it yet">
          <QueuedMessageReason waitingReason="steer_unavailable" />
        </SpecimenCell>
        <SpecimenCell label="Host reason: background work">
          <QueuedMessageReason waitingReason="background_work" />
        </SpecimenCell>
        <SpecimenCell label="Inline in a row: one line, full text on hover">
          <div className="flex w-56 min-w-0">
            <QueuedMessageReason
              waitingReason="background_work"
              layout="inline"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Inline, enough room">
          <div className="flex w-full min-w-0">
            <QueuedMessageReason
              waitingReason="steer_unavailable"
              layout="inline"
            />
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

export function QueuedMessageSettingsHeldWarningSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="Warning beside Steer and Interrupt (hover or focus for the explanation)">
      <SpecimenGrid min={240}>
        <SpecimenCell label="Steer and Interrupt, one change">
          <QueuedMessageSettingsHeldWarning
            changes={['model']}
            steer
            interrupt
          />
        </SpecimenCell>
        <SpecimenCell label="Steer only, two changes">
          <QueuedMessageSettingsHeldWarning
            changes={['model', 'thinking_level']}
            steer
            interrupt={false}
          />
        </SpecimenCell>
        <SpecimenCell label="Interrupt only, three changes">
          <QueuedMessageSettingsHeldWarning
            changes={['plugins', 'tools', 'delegation']}
            steer={false}
            interrupt
          />
        </SpecimenCell>
        <SpecimenCell label="No names from the host">
          <QueuedMessageSettingsHeldWarning steer interrupt />
        </SpecimenCell>
        <SpecimenCell label="Every kind of change (long text)">
          <QueuedMessageSettingsHeldWarning
            changes={ALL_HELD_SETTINGS}
            steer
            interrupt
          />
        </SpecimenCell>
        <SpecimenCell label="Focused (keyboard ring)">
          <FocusOnMount>
            <QueuedMessageSettingsHeldWarning
              changes={['agent']}
              steer
              interrupt
            />
          </FocusOnMount>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}
