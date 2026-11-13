import { useState, type JSX } from 'react';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  EmptyStateRow,
  ErrorBanner,
  ErrorState,
  Notice,
  NoticeButton,
  ToastNotice,
  ToastStack,
  type NoticeIntent,
  type NoticeShape,
  type ToastStackItem,
} from '@canopy/ui-shared/components';
import { ChatIcon, SearchIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';
import {
  INFO_TOAST_LIFETIME_MS,
  toastStackLifetimeMs,
} from '@canopy/ui-shared/lib';

const INTENTS: readonly {
  intent: NoticeIntent;
  title: string;
  body: string;
}[] = [
  {
    intent: 'neutral',
    title: 'Catching up',
    body: 'Older messages load as you scroll.',
  },
  {
    intent: 'attention',
    title: 'Codex usage limit reached',
    body: 'Chats resume at 4:00 PM, or switch to another model now.',
  },
  {
    intent: 'destructive',
    title: 'Couldn’t push the branch',
    body: 'The remote rejected the update.',
  },
  {
    intent: 'positive',
    title: 'Pull request opened',
    body: 'Reviewers were notified.',
  },
];

// A long path shortens in its middle; hover shows it and copy copies it.
const LONG_PATH_BODY =
  'Branch "sam/thinking-lightbulb-restore" is already checked out at /Users/sam/.unstoppable-code/workspaces/canopy/worktrees/sloth';

const SHAPES: readonly NoticeShape[] = ['default', 'composer', 'settings'];

const noop = (): void => undefined;

export function NoticeSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Intents (title, then message)">
        {INTENTS.map(({ intent, title, body }) => (
          <SpecimenCell key={intent} label={intent} wide>
            <div className="w-full">
              <Notice intent={intent} title={title} role="none">
                {body}
              </Notice>
            </div>
          </SpecimenCell>
        ))}
      </SpecimenPanel>
      <SpecimenPanel title="Actions, dismiss and detail">
        <SpecimenCell label="Trailing actions (primary last) and dismiss" wide>
          <div className="w-full">
            <Notice
              intent="attention"
              title="Sending paused"
              role="none"
              onDismiss={noop}
              actions={
                <>
                  <NoticeButton variant="secondary">Edit</NoticeButton>
                  <NoticeButton variant="primary">Send now</NoticeButton>
                </>
              }
            >
              Three messages are queued.
            </Notice>
          </div>
        </SpecimenCell>
        <SpecimenCell label='actionsPlacement="below" (three or more)' wide>
          <div className="w-full">
            <Notice
              intent="destructive"
              title="Sign-in expired"
              role="none"
              actionsPlacement="below"
              actions={
                <>
                  <NoticeButton variant="secondary">Copy details</NoticeButton>
                  <NoticeButton variant="secondary">
                    Open organizations
                  </NoticeButton>
                  <NoticeButton variant="primary">Sign in</NoticeButton>
                </>
              }
            >
              Sign in again to keep syncing this workspace.
            </Notice>
          </div>
        </SpecimenCell>
        <SpecimenCell label="With detail, no icon" wide>
          <div className="w-full">
            <Notice
              intent="neutral"
              icon={null}
              role="none"
              detail="Couldn’t schedule the resume."
            >
              Resumes when the limit resets.
            </Notice>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Static, announced detail" wide>
          <div className="w-full">
            <Notice
              intent="neutral"
              role="none"
              detail="Couldn’t run it now."
              announceDetail
            >
              Runs every weekday at 9:00.
            </Notice>
          </div>
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel title="Shapes">
        {SHAPES.map((shape) => (
          <SpecimenCell key={shape} label={shape} wide>
            <div className="w-full">
              <Notice
                intent="attention"
                shape={shape}
                title="Plan ready"
                role="none"
                actions={<NoticeButton variant="primary">Review</NoticeButton>}
              >
                Open it to approve or edit.
              </Notice>
            </div>
          </SpecimenCell>
        ))}
      </SpecimenPanel>
    </div>
  );
}

interface LabToast extends ToastStackItem {
  readonly title: string;
  readonly body: string;
}

export function ToastSpecimen(): JSX.Element {
  const [toasts, setToasts] = useState<readonly LabToast[]>([]);
  const push = (intent: NoticeIntent, longPath = false): void => {
    const sample = INTENTS.find((item) => item.intent === intent);
    if (!sample) return;
    setToasts((current) => [
      ...current,
      {
        id: `${intent}-${Date.now()}`,
        intent,
        timeoutMs: toastStackLifetimeMs(intent, INFO_TOAST_LIFETIME_MS),
        title: sample.title,
        body: longPath ? LONG_PATH_BODY : sample.body,
      },
    ]);
  };
  const close = (id: string): void =>
    setToasts((current) => current.filter((toast) => toast.id !== id));
  return (
    <SpecimenPanel>
      <SpecimenCell
        label="Live: toasts stack in the bottom-right corner, three at most"
        wide
      >
        {INTENTS.map(({ intent }) => (
          <Button
            key={intent}
            size="compact"
            onClick={(): void => push(intent)}
          >
            Show {intent}
          </Button>
        ))}
        <Button size="compact" onClick={(): void => push('destructive', true)}>
          Show a long path
        </Button>
      </SpecimenCell>
      <ToastStack
        toasts={toasts}
        placement="bottom-right"
        onClose={close}
        renderToast={(toast): JSX.Element => (
          <ToastNotice
            intent={toast.intent}
            title={toast.title}
            text={toast.body}
            onDismiss={(): void => close(toast.id)}
          />
        )}
      />
    </SpecimenPanel>
  );
}

export function FailureSpecimen(): JSX.Element {
  const [retrying, setRetrying] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="ErrorBanner (a failure inside a page or panel)">
        <SpecimenCell label="Message only" wide>
          <div className="w-full">
            <ErrorBanner error="The repository is archived and read-only." />
          </div>
        </SpecimenCell>
        <SpecimenCell
          label="Try again switches to a spinner and keeps its width"
          wide
        >
          <div className="w-full">
            <ErrorBanner
              error="Couldn’t load skills."
              onRetry={(): void => setRetrying(true)}
              retrying={retrying}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="With details to copy" wide>
          <div className="w-full">
            <ErrorBanner
              error="Couldn’t save the settings."
              details="EACCES: permission denied, open settings.json"
            />
          </div>
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel title="ErrorState (the whole panel failed)">
        <ErrorState
          message="Couldn’t load pull requests."
          details="GraphQL: rate limit exceeded"
          onRetry={noop}
          space="panel"
        />
      </SpecimenPanel>
      <SpecimenPanel title="EmptyState and EmptyStateRow">
        <SpecimenGrid min={260}>
          <SpecimenCell label="With icon and action">
            <EmptyState
              icon={<ChatIcon size="2xl" />}
              title="No chats yet"
              subtitle="Start one from the composer."
              action={<Button size="compact">New chat</Button>}
            />
          </SpecimenCell>
          <SpecimenCell label='tone="quiet"'>
            <EmptyState
              icon={<SearchIcon size="2xl" />}
              title="No results for “deploy”"
              tone="quiet"
            />
          </SpecimenCell>
          <SpecimenCell label="EmptyStateRow, inside a card or menu">
            <EmptyStateRow title="No teams yet" />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

type ConfirmCase = 'none' | 'plain' | 'destructive' | 'busy' | 'error';

export function ConfirmDialogSpecimen(): JSX.Element {
  const [open, setOpen] = useState<ConfirmCase>('none');
  const close = (): void => setOpen('none');
  return (
    <SpecimenPanel>
      <SpecimenCell label="Live: each opens the real ConfirmDialog" wide>
        <Button size="compact" onClick={(): void => setOpen('plain')}>
          Confirm
        </Button>
        <Button size="compact" onClick={(): void => setOpen('destructive')}>
          Destructive
        </Button>
        <Button size="compact" onClick={(): void => setOpen('busy')}>
          Busy
        </Button>
        <Button size="compact" onClick={(): void => setOpen('error')}>
          With error
        </Button>
      </SpecimenCell>
      {open === 'none' ? null : (
        <ConfirmDialog
          title={
            open === 'destructive' ? 'Delete this worktree?' : 'Archive chat?'
          }
          message={
            open === 'destructive'
              ? 'Uncommitted changes in it are lost.'
              : 'You can find it again under Archived.'
          }
          confirmLabel={open === 'destructive' ? 'Delete' : 'Archive'}
          busyLabel="Archiving…"
          busy={open === 'busy'}
          destructive={open === 'destructive'}
          errorMessage={
            open === 'error' ? 'Couldn’t archive the chat.' : undefined
          }
          errorDetails={open === 'error' ? 'ENOENT: chat index' : undefined}
          onConfirm={close}
          onCancel={close}
        />
      )}
    </SpecimenPanel>
  );
}
