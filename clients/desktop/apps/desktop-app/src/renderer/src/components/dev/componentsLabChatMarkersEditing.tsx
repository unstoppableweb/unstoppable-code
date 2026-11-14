import { useState, type JSX } from 'react';
import type { ApprovalFileChange } from '@canopy/protocol/approvals';
import {
  ApprovalContentModal,
  ApprovalFileChangePreview,
  Button,
  ChatCopyAction,
  ComposerIconButton,
  MessageEditBadge,
  MessageEditCancelSave,
  MessageEditCard,
  MessageEditNotice,
  MessageEditSurface,
  UnsavedMessageEdits,
  type ApprovalContentModalContent,
  type ComposerIconButtonTone,
} from '@canopy/ui-shared/components';
import {
  AttachmentIcon,
  MicIcon,
  PlusIcon,
  StopIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

function numbered(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join(
    '\n',
  );
}

const SMALL_EDIT: ApprovalFileChange = {
  kind: 'edit',
  oldText: 'const retries = 3;\nconst delay = 100;',
  newText: 'const retries = 5;\nconst delay = 250;',
};

const LONG_EDIT: ApprovalFileChange = {
  kind: 'edit',
  oldText: numbered('old line', 14),
  newText: numbered('new line', 16),
};

const WIDE_LINE: ApprovalFileChange = {
  kind: 'write',
  content: `export const value = '${'very-long-value-'.repeat(30)}';`,
};

const PREVIEW_CASES: readonly {
  readonly label: string;
  readonly change: ApprovalFileChange;
  readonly mode: 'compact' | 'expanded';
  readonly expandable?: boolean;
}[] = [
  { label: 'Edit, compact', change: SMALL_EDIT, mode: 'compact' },
  {
    label: 'Edit, replaces every occurrence',
    change: { ...SMALL_EDIT, replaceAll: true },
    mode: 'compact',
  },
  {
    label: 'Write, compact',
    change: { kind: 'write', content: 'line one\nline two\n' },
    mode: 'compact',
  },
  {
    label: 'Long edit: hidden rows offer Show all',
    change: LONG_EDIT,
    mode: 'compact',
    expandable: true,
  },
  { label: 'Long edit, expanded', change: LONG_EDIT, mode: 'expanded' },
  {
    label: 'Very wide line scrolls sideways',
    change: WIDE_LINE,
    mode: 'compact',
  },
  {
    label: 'Line endings: CRLF against LF',
    change: { kind: 'edit', oldText: 'a\r\nb\r\n', newText: 'a\nb\n' },
    mode: 'compact',
  },
  {
    label: 'Empty write',
    change: { kind: 'write', content: '' },
    mode: 'compact',
  },
  {
    label: 'Unchanged edit',
    change: { kind: 'edit', oldText: 'same', newText: 'same' },
    mode: 'compact',
  },
  {
    label: 'Cut before delivery, unavailable part noted',
    change: { kind: 'write', content: numbered('kept', 3), truncated: true },
    mode: 'compact',
  },
  {
    label: 'Cut before delivery and equal: no difference in the available text',
    change: { kind: 'edit', oldText: 'same', newText: 'same', truncated: true },
    mode: 'compact',
  },
];

export function ApprovalFileChangePreviewSheet(): JSX.Element {
  return (
    <SpecimenPanel title="Proposed file changes">
      <SpecimenGrid min={280}>
        {PREVIEW_CASES.map(({ label, change, mode, expandable }) => (
          <SpecimenCell key={label} label={label}>
            <div className="w-full min-w-0">
              <ApprovalFileChangePreview
                change={change}
                mode={mode}
                onExpand={expandable ? noop : undefined}
              />
            </div>
          </SpecimenCell>
        ))}
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

interface ModalCase {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly content: ApprovalContentModalContent;
}

const MODAL_CASES: readonly ModalCase[] = [
  {
    id: 'text',
    label: 'Open a script',
    title: 'Script to run',
    subtitle: '/repo/scripts/deploy.sh',
    content: { kind: 'text', text: 'set -e\nnpm run build\nnpm run deploy' },
  },
  {
    id: 'long',
    label: 'Open a long script',
    title: 'Script to run',
    subtitle: `/repo/${'nested/'.repeat(20)}run.sh`,
    content: { kind: 'text', text: numbered('echo step', 120) },
  },
  {
    id: 'change',
    label: 'Open a file change',
    title: 'Edit src/retry.ts',
    subtitle: 'src/retry.ts',
    content: { kind: 'change', change: LONG_EDIT },
  },
  {
    id: 'no-subtitle',
    label: 'Open without a subtitle',
    title: 'Rule target',
    content: { kind: 'text', text: 'npm run test -- --watch=false' },
  },
];

export function ApprovalContentModalSheet(): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = MODAL_CASES.find((item) => item.id === openId);
  return (
    <SpecimenPanel title="Full view of an approval’s content (opens a dialog)">
      <SpecimenCell label="Each button opens the real dialog; Escape or Close dismisses it">
        {MODAL_CASES.map((item) => (
          <Button
            key={item.id}
            variant="secondary"
            size="compact"
            onClick={(): void => setOpenId(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </SpecimenCell>
      {open ? (
        <ApprovalContentModal
          title={open.title}
          subtitle={open.subtitle}
          content={open.content}
          onClose={(): void => setOpenId(null)}
        />
      ) : null}
    </SpecimenPanel>
  );
}

export function ChatCopyActionSheet(): JSX.Element {
  return (
    <SpecimenPanel title="Message Copy action">
      <SpecimenGrid min={220}>
        <SpecimenCell label="Press to see the check and Copied">
          <>
            <ChatCopyAction text="Reply text to copy" />
          </>
        </SpecimenCell>

        <SpecimenCell label="Custom label">
          <ChatCopyAction text="Plan text" label="Copy plan" />
        </SpecimenCell>
        <SpecimenCell label="Empty text">
          <ChatCopyAction text="" />
        </SpecimenCell>
        <SpecimenCell label="Long text (copies all of it)">
          <ChatCopyAction text={numbered('A long reply line', 400)} />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

const TONES: readonly ComposerIconButtonTone[] = [
  'default',
  'strong',
  'pending',
  'warning',
  'destructive',
];

export function ComposerIconButtonSheet(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Tones: rest, active and disabled">
        <SpecimenGrid min={200}>
          {TONES.map((tone) => (
            <SpecimenCell key={tone} label={tone}>
              <ComposerIconButton aria-label={`${tone} action`} tone={tone}>
                <PlusIcon />
              </ComposerIconButton>
              <ComposerIconButton
                aria-label={`${tone} action, active`}
                tone={tone}
                active
              >
                <PlusIcon />
              </ComposerIconButton>
              <ComposerIconButton
                aria-label={`${tone} action, disabled`}
                tone={tone}
                disabled
              >
                <PlusIcon />
              </ComposerIconButton>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Geometry">
        <SpecimenGrid min={200}>
          <SpecimenCell label="Square, 28px">
            <ComposerIconButton aria-label="Attach file">
              <AttachmentIcon />
            </ComposerIconButton>
          </SpecimenCell>
          <SpecimenCell label="Square, wide (icon and disclosure)">
            <ComposerIconButton aria-label="Add" wide>
              <PlusIcon />
              <PlusIcon />
            </ComposerIconButton>
          </SpecimenCell>
          <SpecimenCell label="Capsule, 32px">
            <ComposerIconButton aria-label="Dictate" capsule>
              <MicIcon />
            </ComposerIconButton>
          </SpecimenCell>
          <SpecimenCell label="Capsule, wide">
            <ComposerIconButton aria-label="Add" capsule wide>
              <PlusIcon />
              <PlusIcon />
            </ComposerIconButton>
          </SpecimenCell>
          <SpecimenCell label="Capsule with a label (auto width)">
            <ComposerIconButton aria-label="Stop dictation" capsule autoWidth>
              <StopIcon />
              <span>Stop</span>
            </ComposerIconButton>
          </SpecimenCell>
          <SpecimenCell label="Capsule with a long label">
            <ComposerIconButton
              aria-label="Long label"
              capsule
              autoWidth
              tone="warning"
              active
            >
              <PlusIcon />
              <span>Needs your attention before sending</span>
            </ComposerIconButton>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

const LONG_DRAFT = numbered('A long queued message line', 12);

function EditCardCase({
  label,
  initial,
  readOnly,
  withStatus,
  saveDisabled,
}: {
  readonly label?: string;
  readonly initial: string;
  readonly readOnly?: boolean;
  readonly withStatus?: boolean;
  readonly saveDisabled?: boolean;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <MessageEditCard
      value={value}
      onChange={setValue}
      readOnly={readOnly}
      ariaLabel="Edit queued message"
      inputTestId="lab-edit-card-input"
      label={label}
      actions={
        <MessageEditCancelSave
          onCancel={noop}
          onSave={noop}
          saveDisabled={saveDisabled}
        />
      }
    >
      {withStatus ? (
        <p className="pt-1 text-3xs fg-secondary">
          This message is already sending.
        </p>
      ) : null}
    </MessageEditCard>
  );
}

export function MessageEditCardSheet(): JSX.Element {
  return (
    <SpecimenPanel title="Inline editor for a queued message">
      <SpecimenCell label="Editable, Cancel and Save" wide>
        <div className="w-full">
          <EditCardCase initial="Fix the failing build" />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Empty draft: Save disabled" wide>
        <div className="w-full">
          <EditCardCase initial="" saveDisabled />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Read-only, with a label (interrupted edit)" wide>
        <div className="w-full">
          <EditCardCase initial="Kept text" label="Unsaved edit" readOnly />
        </div>
      </SpecimenCell>
      <SpecimenCell label="With a status note and Save disabled" wide>
        <div className="w-full">
          <EditCardCase
            initial="Fix the failing build"
            withStatus
            saveDisabled
          />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Long draft grows, then scrolls" wide>
        <div className="w-full">
          <EditCardCase initial={LONG_DRAFT} />
        </div>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

export function MessageEditEntrySheet(): JSX.Element {
  const drafts = [
    { id: 'a', text: 'First change that was never saved' },
    { id: 'b', text: numbered('Second change line', 6) },
  ];
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Edit surface (double-click opens the editor)">
        <SpecimenGrid min={260}>
          <SpecimenCell label="Message bubble, editable">
            <MessageEditSurface onEdit={noop}>
              Queued message
            </MessageEditSurface>
          </SpecimenCell>
          <SpecimenCell label="Message bubble, not editable (native selection)">
            <MessageEditSurface>Sent message</MessageEditSurface>
          </SpecimenCell>
          <SpecimenCell label="Info tone">
            <MessageEditSurface onEdit={noop} tone="info">
              Message from another agent
            </MessageEditSurface>
          </SpecimenCell>
          <SpecimenCell label="Draft variant">
            <MessageEditSurface onEdit={noop} variant="draft">
              Draft text
            </MessageEditSurface>
          </SpecimenCell>
          <SpecimenCell label="Draft variant, info tone">
            <MessageEditSurface onEdit={noop} variant="draft" tone="info">
              Draft text
            </MessageEditSurface>
          </SpecimenCell>
          <SpecimenCell label="Long text wraps">
            <MessageEditSurface onEdit={noop}>
              {'Queued message with a long body. '.repeat(10)}
            </MessageEditSurface>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Edit badge">
        <SpecimenGrid min={200}>
          <SpecimenCell label="Default">
            <MessageEditBadge
              label="Edit queued message"
              onEdit={noop}
              testId="lab-edit-badge"
            />
          </SpecimenCell>
          <SpecimenCell label="Disabled">
            <MessageEditBadge
              label="Edit queued message"
              onEdit={noop}
              testId="lab-edit-badge-disabled"
              disabled
            />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Rejected edit and interrupted edits">
        <SpecimenCell label="Notice after a rejected edit (dismissible)" wide>
          <div className="w-full">
            <MessageEditNotice
              message="This message is no longer available to edit."
              onDismiss={noop}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Long notice wraps" wide>
          <div className="w-full">
            <MessageEditNotice
              message={`This message is no longer available to edit. ${'It changed while you were editing. '.repeat(5)}`}
              onDismiss={noop}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Unsaved edits stay readable until dismissed" wide>
          <div className="flex w-full flex-col gap-2">
            <UnsavedMessageEdits drafts={drafts} onDismiss={noop} />
          </div>
        </SpecimenCell>
        <SpecimenCell label="No unsaved edits: renders nothing" wide>
          <div className="w-full min-h-4 text-2xs fg-tertiary">
            <UnsavedMessageEdits drafts={[]} onDismiss={noop} />
          </div>
        </SpecimenCell>
      </SpecimenPanel>
    </div>
  );
}
