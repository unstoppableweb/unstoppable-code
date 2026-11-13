import { useState, type JSX } from 'react';
import {
  Badge,
  Button,
  CopyButton,
  DialogModal,
  EmptyState,
  ErrorState,
  Fact,
  FactList,
  InlineMention,
  ListRow,
  Notice,
  NoticeButton,
  SearchField,
  Skeleton,
  TextArea,
  ToastNotice,
  ToastStack,
  Tooltip,
  type NoticeIntent,
  type ToastStackItem,
} from '@canopy/ui-shared/components';
import {
  ArchiveIcon,
  ChatIcon,
  FileIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  LinearIcon,
  PlusIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { Bar, Collapse, type Act } from '../../../../../vendor/stageshow/kit';
import { LabStage, LabWindow, NameWithin } from './componentsLabStage';
import { pointAt, pointAway, press } from './componentsLabStageEvents';

/*
 * Stageshow stages for the unified feedback, reference and layout pieces.
 * Same frame and rules as componentsLabStagesControls.tsx: the real shared
 * component inside a Canopy window, one story, played once.
 */

const noop = (): void => undefined;
const writeNothing = (): Promise<boolean> => Promise.resolve(true);

// --- Reference chips: hover on the ones that open something ----------------

type MentionScene = { idle: boolean };

async function mentionScript(a: Act<MentionScene>): Promise<void> {
  await a.wait(600);
  await a.move({ at: 'mention-pr', x: 0.6, y: 0.75 });
  await a.wait(900);
  await a.move({ at: 'mention-issue', x: 0.6, y: 0.75 });
  await a.wait(900);
  a.mark('rest');
  await a.move({ at: 'mention-issue', x: 0.6, y: 3.2 });
  await a.wait(1600);
}

export function ReferenceChipsStage(): JSX.Element {
  return (
    <LabStage<MentionScene>
      id="reference-chips"
      initial={{ idle: true }}
      poster={{ idle: true }}
      posterHover={['mention-pr']}
      script={mentionScript}
      height={150}
    >
      {(): JSX.Element => (
        <LabWindow title="Chat">
          <div className="canopy-lab-body">
            <div className="flex flex-col gap-2">
              <p className="text-s fg-primary">
                Fixed in{' '}
                <InlineMention
                  data-target="mention-pr"
                  icon={GitPullRequestIcon}
                  onClick={noop}
                >
                  #7116
                </InlineMention>{' '}
                for{' '}
                <InlineMention
                  data-target="mention-issue"
                  icon={LinearIcon}
                  onClick={noop}
                >
                  CAN-2405
                </InlineMention>
                , landed as{' '}
                <InlineMention icon={GitCommitIcon} onClick={noop}>
                  9806bd5
                </InlineMention>
                . The press class is in{' '}
                <InlineMention icon={FileIcon}>Button.tsx:295</InlineMention>.
              </p>
            </div>
          </div>
        </LabWindow>
      )}
    </LabStage>
  );
}

// --- Notice: arrives over the composer, its action under the hand ----------

type NoticeScene = { open: boolean };

async function noticeScript(a: Act<NoticeScene>): Promise<void> {
  await a.wait(900);
  a.mark('arrive');
  a.put({ open: true });
  await a.wait(900);
  if (a.layout === 'wide') {
    await a.move({ at: 'notice-switch', x: 0.93, y: 0.8 });
  }
  await a.wait(2400);
}

export function NoticeStage(): JSX.Element {
  return (
    <LabStage<NoticeScene>
      id="notice"
      initial={{ open: false }}
      poster={{ open: true }}
      posterHover={['notice-switch']}
      script={noticeScript}
      height={232}
    >
      {(s, _rect, layout): JSX.Element => (
        <LabWindow title="Chat">
          <div className="canopy-lab-body">
            <div className="flex flex-col gap-2">
              <Bar w={240} h={7} tone={3} />
              <Bar w={180} h={7} tone={3} />
            </div>
            {/* The kit's Collapse opens the room and brings the notice up out
                of the composer whole, never sliced by the opening edge. */}
            <Collapse open={s.open} reveal="drop" from="below">
              <div>
                <Notice
                  intent="attention"
                  shape="composer"
                  role="none"
                  title="Codex usage limit reached"
                  actions={
                    // The phone design leaves the action to the wide one:
                    // under 384px the notice wraps its actions onto their own
                    // row, which the rehearsal gate reads as a spilled slot
                    // (see REHEARSAL.md).
                    layout === 'wide' ? (
                      <NoticeButton
                        data-target="notice-switch"
                        variant="primary"
                      >
                        Switch model
                      </NoticeButton>
                    ) : undefined
                  }
                >
                  Chats resume at 4:00 PM.
                </Notice>
              </div>
            </Collapse>
            <TextArea
              aria-label="Message"
              placeholder="Ask anything"
              rows={2}
            />
          </div>
        </LabWindow>
      )}
    </LabStage>
  );
}

// --- Toasts: an outcome arrives in the corner, a second stacks on it ------

interface StageToast extends ToastStackItem {
  readonly title: string;
  readonly body: string;
}

const MERGED: StageToast = {
  id: 'merged',
  intent: 'positive',
  timeoutMs: 600_000,
  title: 'Pull request merged',
  body: 'The branch is up to date with develop.',
};

type ToastScene = { toasts: readonly StageToast[] };

async function toastScript(a: Act<ToastScene>): Promise<void> {
  await a.wait(600);
  await a.move({ at: 'toast-merge', x: 0.75, y: 0.65 });
  await a.wait(300);
  a.mark('merge');
  await a.click();
  await a.wait(250);
  a.put({ toasts: [MERGED] });
  await a.move({ at: 'toast-merge', x: 0.3, y: 2.6 });
  await a.wait(2600);
}

function toastIntent(toast: StageToast): NoticeIntent {
  return toast.intent;
}

export function ToastStage(): JSX.Element {
  return (
    <LabStage<ToastScene>
      id="toast"
      initial={{ toasts: [] }}
      poster={{ toasts: [MERGED] }}
      script={toastScript}
      height={290}
    >
      {(s): JSX.Element => (
        <>
          <LabWindow title="Pull request">
            <div className="canopy-lab-body">
              <div className="flex flex-col gap-2">
                <div className="text-s font-medium fg-primary">
                  Fix sidebar collapse at 200%
                </div>
                <Bar w={260} h={7} tone={3} />
              </div>
              <div className="flex gap-2">
                <Button
                  data-target="toast-merge"
                  variant="primary"
                  disabled={s.toasts.length > 0}
                >
                  Merge
                </Button>
              </div>
              <div className="flex flex-col gap-2">
                <Bar w={150} h={7} tone={2} />
                <Bar w={120} h={7} tone={2} />
                <Bar w={140} h={7} tone={2} />
                <Bar w={100} h={7} tone={2} />
              </div>
            </div>
          </LabWindow>
          <div className="canopy-lab-toast-corner">
            <ToastStack
              toasts={s.toasts}
              placement="bottom-right"
              onClose={noop}
              renderToast={(toast): JSX.Element => (
                <ToastNotice
                  intent={toastIntent(toast)}
                  title={toast.title}
                  text={toast.body}
                  onDismiss={noop}
                />
              )}
            />
          </div>
        </>
      )}
    </LabStage>
  );
}

// --- Failures: the panel failed, Try again brings the list -----------------

type FailureScene = { retrying: boolean; loaded: boolean };

async function failureScript(a: Act<FailureScene>): Promise<void> {
  await a.wait(700);
  await a.move({ at: 'failure-retry', x: 0.75, y: 0.65 });
  await a.wait(400);
  a.mark('retry');
  await a.click();
  a.put({ retrying: true });
  await a.wait(1300);
  a.mark('loaded');
  a.put({ retrying: false, loaded: true });
  await a.move({ at: 'failure-retry', x: 0.5, y: 1.8 });
  await a.wait(2000);
}

export function FailureStage(): JSX.Element {
  return (
    <LabStage<FailureScene>
      id="failures"
      initial={{ retrying: false, loaded: false }}
      poster={{ retrying: false, loaded: false }}
      script={failureScript}
      height={294}
    >
      {(s): JSX.Element => (
        <LabWindow title="Pull requests">
          <div className="canopy-lab-body">
            <div className="canopy-lab-swap">
              <div data-on={s.loaded ? undefined : true}>
                <NameWithin name="failure-retry" text="Try again">
                  <ErrorState
                    message="Couldn’t load pull requests."
                    details="GraphQL: rate limit exceeded"
                    onRetry={noop}
                    retrying={s.retrying}
                    space="panel"
                  />
                </NameWithin>
              </div>
              <div
                className="flex flex-col gap-0.5"
                data-on={s.loaded ? true : undefined}
              >
                <ListRow
                  icon={<GitPullRequestIcon />}
                  trailing={<Badge tone="success">Open</Badge>}
                >
                  Fix sidebar collapse at 200%
                </ListRow>
                <ListRow
                  icon={<GitPullRequestIcon />}
                  trailing={<Badge tone="special">Merged</Badge>}
                >
                  Components library lab
                </ListRow>
                <ListRow
                  icon={<GitPullRequestIcon />}
                  trailing={<Badge>Draft</Badge>}
                >
                  Color tokens audit
                </ListRow>
                <ListRow
                  icon={<GitPullRequestIcon />}
                  trailing={<Badge tone="success">Open</Badge>}
                >
                  Bump Electron to 39
                </ListRow>
                <ListRow
                  icon={<GitPullRequestIcon />}
                  trailing={<Badge tone="special">Merged</Badge>}
                >
                  Release notes draft
                </ListRow>
                <ListRow
                  icon={<GitPullRequestIcon />}
                  trailing={<Badge tone="special">Merged</Badge>}
                >
                  Fix flaky checkout test
                </ListRow>
              </div>
            </div>
          </div>
        </LabWindow>
      )}
    </LabStage>
  );
}

// --- Loading: the skeleton in the list's own geometry resolves row by row --

const LOADING_ROWS = [
  'Fix flaky checkout test',
  'Sidebar collapse at 200%',
  'Color tokens audit',
  'Bump Electron to 39',
] as const;

type LoadingScene = { loaded: number };

async function loadingScript(a: Act<LoadingScene>): Promise<void> {
  await a.wait(1600);
  a.mark('resolve');
  await a.stagger(
    LOADING_ROWS.map((_, index) => index + 1),
    (count) => a.put({ loaded: count }),
    90,
  );
  await a.wait(2400);
}

export function LoadingStage(): JSX.Element {
  return (
    <LabStage<LoadingScene>
      id="loading"
      initial={{ loaded: 0 }}
      poster={{ loaded: 0 }}
      script={loadingScript}
      height={262}
      pointer={false}
    >
      {(s): JSX.Element => (
        <LabWindow title="Chats">
          <div className="canopy-lab-sidebar-body">
            <div className="px-1 pb-2">
              <SearchField
                size="sm"
                value=""
                onValueChange={noop}
                aria-label="Search chats"
                placeholder="Search chats"
                className="w-full"
              />
            </div>
            {LOADING_ROWS.map((title, index) => (
              <div key={title} className="canopy-lab-swap">
                <div
                  className="flex h-8 items-center gap-2 px-2"
                  data-on={s.loaded > index ? undefined : true}
                >
                  {/* Only the value pulses: the row's icon is chrome and
                      stays put, so the list keeps its shape while loading. */}
                  <span className="flex fg-tertiary">
                    <ChatIcon />
                  </span>
                  <div className="flex-1">
                    <Skeleton loading>
                      <span className="text-s">{title}</span>
                    </Skeleton>
                  </div>
                </div>
                <div data-on={s.loaded > index ? true : undefined}>
                  <ListRow icon={<ChatIcon />} trailing={`${index + 1}h`}>
                    {title}
                  </ListRow>
                </div>
              </div>
            ))}
          </div>
        </LabWindow>
      )}
    </LabStage>
  );
}

// --- Fact lists: the commit copies in place --------------------------------

type FactsScene = { idle: boolean };

async function factsScript(a: Act<FactsScene>): Promise<void> {
  await a.wait(700);
  await a.move({ at: 'facts-copy', x: 0.5, y: 0.55 });
  await a.wait(400);
  a.mark('copy');
  await a.click();
  press('facts-copy');
  await a.wait(500);
  await a.move({ at: 'facts-copy', x: -2, y: 2.4 });
  await a.wait(1800);
}

export function FactsStage(): JSX.Element {
  return (
    <LabStage<FactsScene>
      id="facts"
      initial={{ idle: true }}
      poster={{ idle: true }}
      script={factsScript}
      height={210}
    >
      {(): JSX.Element => (
        <LabWindow title="Run details">
          <div className="canopy-lab-body">
            <FactList labelWidth="5rem" size="s">
              <Fact label="Branch" mono>
                fix-sidebar-zoom
              </Fact>
              <Fact label="Status">
                <Badge tone="success">Passed</Badge>
              </Fact>
              <Fact label="Duration" numeric>
                4m 12s
              </Fact>
              <Fact label="Commit" fit="row" mono>
                <span className="truncate">9806bd5</span>
                <span data-target="facts-copy" className="inline-flex">
                  <CopyButton
                    value="9806bd5"
                    ariaLabel="Copy commit"
                    write={writeNothing}
                    copiedDurationMs={60_000}
                  />
                </span>
              </Fact>
            </FactList>
          </div>
        </LabWindow>
      )}
    </LabStage>
  );
}

// --- Dialogs: a confirm before archiving -----------------------------------

type DialogScene = { dialog: 'closed' | 'open' | 'closing'; archived: boolean };

async function dialogScript(a: Act<DialogScene>): Promise<void> {
  await a.wait(600);
  await a.move({ at: 'dialog-archive', x: 0.75, y: 0.65 });
  await a.wait(300);
  a.mark('open');
  await a.click();
  a.put({ dialog: 'open' });
  await a.wait(900);
  await a.move({ at: 'dialog-cancel', x: 0.7, y: 0.65 });
  await a.wait(600);
  await a.move({ at: 'dialog-confirm', x: 0.7, y: 0.65 });
  await a.wait(300);
  a.mark('confirm');
  await a.click();
  a.put({ dialog: 'closing' });
  await a.wait(260);
  a.put({ dialog: 'closed', archived: true });
  await a.move({ at: 'dialog-archive', x: 0.5, y: 3.2 });
  await a.wait(2000);
}

/**
 * The layer a stage's dialog draws in: a transformed box over the whole
 * stage is the containing block for the dialog's fixed overlay, so the real
 * `DialogModal` opens inside the frame. It fades out before the dialog
 * unmounts, so closing never pops.
 */
function DialogLayer({
  state,
}: {
  readonly state: DialogScene['dialog'];
}): JSX.Element {
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  return (
    <div
      ref={setLayer}
      className="canopy-lab-dialog-layer"
      data-open={state === 'open' ? true : undefined}
    >
      {layer && state !== 'closed' ? (
        <DialogModal
          variant="confirm"
          title="Archive chat?"
          onClose={noop}
          portalContainer={layer}
          trapFocus={false}
          closeOnEscape={false}
          footer={
            <>
              <Button data-target="dialog-cancel" size="compact">
                Cancel
              </Button>
              <Button
                data-target="dialog-confirm"
                size="compact"
                variant="primary"
              >
                Archive
              </Button>
            </>
          }
        >
          <p className="text-s fg-secondary">
            You can find it again under Archived.
          </p>
        </DialogModal>
      ) : null}
    </div>
  );
}

export function DialogStage(): JSX.Element {
  return (
    <LabStage<DialogScene>
      id="dialogs"
      initial={{ dialog: 'closed', archived: false }}
      poster={{ dialog: 'open', archived: false }}
      script={dialogScript}
      height={280}
    >
      {(s): JSX.Element => (
        <>
          <LabWindow title="Chats">
            <div className="canopy-lab-body">
              <div className="flex items-center justify-between gap-3">
                <div className="text-s font-medium fg-primary">
                  Fix flaky checkout test
                </div>
                <Button
                  data-target="dialog-archive"
                  size="compact"
                  disabled={s.archived}
                >
                  <ArchiveIcon />
                  Archive
                </Button>
              </div>
              <Collapse open={!s.archived}>
                <div className="flex flex-col gap-2">
                  <Bar w={260} h={7} tone={3} />
                  <Bar w={200} h={7} tone={3} />
                  <Bar w={230} h={7} tone={3} />
                  <Bar w={180} h={7} tone={3} />
                  <Bar w={240} h={7} tone={3} />
                  <Bar w={160} h={7} tone={3} />
                </div>
              </Collapse>
              <Collapse open={s.archived} reveal="drop">
                <EmptyState
                  icon={<ArchiveIcon size="2xl" />}
                  title="Chat archived"
                  subtitle="Find it again under Archived."
                  tone="quiet"
                />
              </Collapse>
            </div>
          </LabWindow>
          <DialogLayer state={s.dialog} />
        </>
      )}
    </LabStage>
  );
}

// --- Tooltip and CopyButton ------------------------------------------------

type TipScene = { idle: boolean };

async function tipScript(a: Act<TipScene>): Promise<void> {
  await a.wait(600);
  await a.move({ at: 'tip-new', x: 0.55, y: 0.6 });
  pointAt('tip-new');
  a.mark('tooltip');
  await a.wait(1600);
  pointAway('tip-new');
  await a.move({ at: 'tip-copy', x: 0.8, y: 0.6 });
  await a.wait(300);
  a.mark('copy');
  await a.click();
  press('tip-copy');
  await a.wait(500);
  await a.move({ at: 'tip-copy', x: 0.5, y: -1.4 });
  await a.wait(1800);
}

export function TooltipStage(): JSX.Element {
  return (
    <LabStage<TipScene>
      id="tooltip-copy"
      initial={{ idle: true }}
      poster={{ idle: true }}
      script={tipScript}
      height={168}
    >
      {(): JSX.Element => (
        <LabWindow title="Chat">
          <div className="canopy-lab-body">
            <div className="flex flex-col gap-2">
              <Bar w={240} h={7} tone={3} />
              <Bar w={190} h={7} tone={3} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <code className="min-w-0 flex-1 truncate text-s fg-primary">
                fix-sidebar-zoom
              </code>
              <div className="flex shrink-0 items-center gap-1">
                <Tooltip label="New chat" shortcut="⌘N">
                  <Button
                    data-target="tip-new"
                    size="compact"
                    variant="ghost"
                    iconOnly
                    aria-label="New chat"
                  >
                    <PlusIcon />
                  </Button>
                </Tooltip>
                <span data-target="tip-copy" className="inline-flex">
                  <CopyButton
                    value="fix-sidebar-zoom"
                    label="Copy branch"
                    variant="secondary"
                    size="compact"
                    write={writeNothing}
                    copiedDurationMs={60_000}
                  />
                </span>
              </div>
            </div>
          </div>
        </LabWindow>
      )}
    </LabStage>
  );
}
