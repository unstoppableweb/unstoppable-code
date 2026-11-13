import {
  useCallback,
  useState,
  type FocusEvent,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { CHAT_UNIT_LABEL, CHAT_UNIT_LABEL_PLURAL } from '@canopy/protocol';
import {
  ACTIVITY_POINTER_DRAG_ACTIVATION_CONSTRAINT,
  FollowUpButton,
  pipelineRunStatusBadge,
} from '@canopy/ui-app';
import {
  Stack,
  Badge,
  BubbleCopyBadge,
  ChatComposerToolbarChip,
  ChatPreviewPopover,
  type ChatPreviewRow,
  ExecutionActionButton,
  HeaderActionButton,
  Heading,
  PanelSection as SharedPanelSection,
  Surface,
  WorktreeRow,
  type WorktreeRowProps,
} from '@canopy/ui-shared/components';
import { DEFAULT_PANEL_LEAF_MINIMUM_WIDTH } from '@canopy/ui-shared/panels';
import {
  AttachmentIcon,
  ChatIcon,
  DownloadIcon,
  EyeIcon,
  FilesIcon,
  PipelineIcon,
  PlanModeIcon,
  PlansIcon,
  PlusMediumIcon,
  RerunIcon,
  RetryIcon,
  TerminalIcon,
  NoteIcon,
  EditBigIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { isChangeReviewPageEnabled } from '@/components/sidebar/change-review-page-flag';
import { WakeLockIndicatorView } from '@/components/sidebar/WakeLockIndicator';
import { VoiceInputButton } from '@/components/shared/VoiceInputButton';
import { PageTitlebar } from '../shared/PageTitlebar';
import {
  ActivitySectionChromeContext,
  PanelSection as DesktopPanelSection,
} from '../shared/panel-section';
import { AdvisorEtaBadge } from '../activity/AdvisorEtaBadge';
import { ChatMessageItem } from '../chat/ChatMessageItem';
import { FastModeButton } from '../chat/FastModeButton';
import { QueuedMessageBubble } from '../chat/QueuedMessageBubble';
import { UsageIndicator } from '../chat/UsageIndicator';
import { HeaderGalleryRow } from './HeaderStateGalleryPage';
import { useSeededHeaderGalleryState } from './headerStateGallerySeed';
import {
  ACTIVITY_CARD_FIXTURES,
  buildSeededContextMeterUsage,
  CHANGE_REVIEW_SECTIONS,
  CHANGED_FILES_REFERENCE,
  CONTEXT_METER_MODEL,
  DEMO_ADVISOR_SNAPSHOT,
  DEMO_WAKE_LOCK_STATE,
  GIT_ACTION_ROWS,
  QUEUED_BUBBLE_FIXTURES,
  TOOLTIP_SIDEBAR_ROW,
  UNREAD_AFTER_ANSWER_ROWS,
  USER_BUBBLE_FIXTURES,
  type ActivityCardIcon,
  type ChangeReviewSection,
  type ChangeReviewSectionId,
  type SidebarRowFixture,
} from './changeReviewData';

/**
 * Dev-only review page for the batch of UI fixes that landed in
 * `601a4d1575..e4a26ccc52`: one section per fix, each with the "Before"
 * described in words and the "After" rendered by the real components with
 * seeded props. Reachable from the sidebar More menu when
 * {@link isChangeReviewPageEnabled} allows it. The page renders in whatever
 * theme and color mode the app is in — toggle those from Settings.
 *
 * Mirrors the other gallery pages: flag gate at the page boundary, a data
 * module holding the fixtures, and the shared section/card chrome.
 */

const noop = (): void => {
  // Gallery controls are inert.
};

const noopAsync = async (): Promise<void> => {
  // Gallery controls are inert.
};

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

function Caption({ children }: { children: ReactNode }): JSX.Element {
  return <p className="text-2xs leading-relaxed fg-secondary">{children}</p>;
}

function StageLabel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="text-3xs font-semibold uppercase fg-secondary">{children}</p>
  );
}

interface ReviewSectionProps {
  section: ChangeReviewSection;
  children: ReactNode;
}

function ReviewSection({ section, children }: ReviewSectionProps): JSX.Element {
  return (
    <Surface
      gap="group"
      data-testid={`change-review-section-${section.id}`}
      as="section"
      variant="inset"
      padding="default"
      className="min-w-0"
    >
      <Stack gap="tight">
        <Heading level={2} variant="title">
          {section.title}
        </Heading>
        <p className="text-xs leading-relaxed fg-secondary">
          {section.summary}
        </p>
        <p className="text-2xs fg-secondary">{section.reportedBy}</p>
      </Stack>
      <Stack gap="tight">
        <StageLabel>Before</StageLabel>
        <p className="text-xs leading-relaxed fg-secondary">{section.before}</p>
      </Stack>
      <Stack gap="inline">
        <StageLabel>After</StageLabel>
        <div className="min-w-0">{children}</div>
      </Stack>
    </Surface>
  );
}

// ---------------------------------------------------------------------------
// 1. Git action buttons — real WorktreeTopBar rows from the Header States seed
// ---------------------------------------------------------------------------

function GitActionsAfter({ ready }: { ready: boolean }): JSX.Element {
  if (!ready) {
    return <Caption>Seeding…</Caption>;
  }
  return (
    <Stack gap="group">
      {GIT_ACTION_ROWS.map((row) => (
        <div
          key={row.worktreeId}
          data-testid={`change-review-git-action-${row.worktreeId}`}
          className="flex flex-col gap-1.5"
        >
          <div>
            <Caption>{row.caption}</Caption>
          </div>
          <HeaderGalleryRow worktreeId={row.worktreeId} />
        </div>
      ))}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// 2. User bubbles — the real ChatMessageItem and QueuedMessageBubble
// ---------------------------------------------------------------------------

function UserBubblesAfter(): JSX.Element {
  return (
    <Surface
      variant="inset"
      gap="block"
      padding="default"
      data-testid="change-review-bubble-surface"
    >
      <div className="flex flex-col gap-5">
        {USER_BUBBLE_FIXTURES.map((fixture) => (
          <Stack
            key={fixture.id}
            gap="inline"
            className="min-w-0"
            data-testid={`change-review-bubble-${fixture.id}`}
          >
            <div>
              <Caption>{fixture.title}</Caption>
            </div>
            <ChatMessageItem
              message={fixture.message}
              chatPendingQuestions={[]}
              onResetToPoint={noopAsync}
            />
          </Stack>
        ))}
        {QUEUED_BUBBLE_FIXTURES.map((fixture) => (
          <Stack
            key={fixture.id}
            gap="inline"
            className="min-w-0"
            data-testid={`change-review-bubble-${fixture.id}`}
          >
            <div>
              <Caption>{fixture.title}</Caption>
            </div>
            <QueuedMessageBubble
              message={fixture.message}
              index={0}
              onClear={noop}
              turnPhase={fixture.message.turnPhase}
              onForce={noop}
              onEdit={noop}
              canForce
            />
          </Stack>
        ))}
        <Caption>
          The transcript has no sticky variant of its own on this page — the
          pinned section header only exists inside a scrolling chat.
        </Caption>
      </div>
    </Surface>
  );
}

// ---------------------------------------------------------------------------
// 3. Activity cards — shared header + desktop body-only chrome
// ---------------------------------------------------------------------------

function ActivityCardIconGlyph({
  icon,
}: {
  icon: ActivityCardIcon;
}): JSX.Element {
  switch (icon) {
    case 'notes':
      return <NoteIcon size="sm" />;
    case 'prompts':
      return <EditBigIcon size="sm" />;
    case 'attachments':
      return <AttachmentIcon size={16} />;
    case 'plans':
      return <PlansIcon size={16} />;
  }
}

function ActivityCardActionGlyph({
  icon,
}: {
  icon: ActivityCardIcon;
}): JSX.Element {
  return icon === 'plans' ? (
    <DownloadIcon size={16} />
  ) : (
    <PlusMediumIcon size={16} />
  );
}

function CardRows({ rows }: { rows: readonly string[] }): JSX.Element {
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((row) => (
        <Surface as="li" variant="group" size="small" key={row}>
          <div className="flex items-center min-h-8 px-2.5 text-xs fg-primary">
            <span className="truncate">{row}</span>
          </div>
        </Surface>
      ))}
    </ul>
  );
}

function ActivityCardsAfter(): JSX.Element {
  return (
    <Stack gap="item">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] items-start gap-3">
        {ACTIVITY_CARD_FIXTURES.map((card) => (
          <div
            key={card.id}
            data-testid={`change-review-activity-card-${card.id}`}
          >
            <SharedPanelSection
              icon={<ActivityCardIconGlyph icon={card.id} />}
              title={card.title}
              subtitle={card.subtitle}
              collapsedIconColor="amber"
            >
              {/* The shipping composition: the shared header above, the
                  desktop body-only section below, whose header action is
                  portaled into the shared title-row controls slot. */}
              <ActivitySectionChromeContext.Provider value="body-only">
                <DesktopPanelSection
                  icon={<ActivityCardIconGlyph icon={card.id} />}
                  title={card.title}
                  subtitle={card.subtitle}
                  headerAction={
                    <HeaderActionButton
                      iconOnly
                      aria-label={card.actionLabel}
                      tooltipLabel={card.actionLabel}
                      data-testid={`change-review-activity-action-${card.id}`}
                      onClick={noop}
                    >
                      <ActivityCardActionGlyph icon={card.id} />
                    </HeaderActionButton>
                  }
                >
                  <CardRows rows={card.rows} />
                </DesktopPanelSection>
              </ActivitySectionChromeContext.Provider>
            </SharedPanelSection>
          </div>
        ))}
        <div data-testid="change-review-activity-card-changed-files">
          <SharedPanelSection
            icon={<FilesIcon size={16} />}
            title={CHANGED_FILES_REFERENCE.title}
            subtitle={CHANGED_FILES_REFERENCE.subtitle}
            headerAction={
              <HeaderActionButton
                iconOnly
                aria-label={CHANGED_FILES_REFERENCE.actionLabel}
                tooltipLabel={CHANGED_FILES_REFERENCE.actionLabel}
                onClick={noop}
              >
                <EyeIcon size={16} />
              </HeaderActionButton>
            }
          >
            <CardRows rows={CHANGED_FILES_REFERENCE.rows} />
          </SharedPanelSection>
        </div>
      </div>
      <Caption>
        Changed Files is the reference: its action arrives as a header prop. The
        four cards on the left now land their + and import buttons in the same
        title-row slot. Drag-and-drop reorder in the Activity panel activates
        after {ACTIVITY_POINTER_DRAG_ACTIVATION_CONSTRAINT.distance}
        px of pointer movement (previously a 250ms press delay), so press and
        drag a card header there to rearrange.
      </Caption>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// 4. Sleep paused chip — the shipping chip floating over a mock panel area
// ---------------------------------------------------------------------------

function SleepPausedPillAfter(): JSX.Element {
  return (
    <Stack gap="inline">
      <Surface
        variant="group"
        className="relative overflow-hidden"
        data-testid="change-review-panel-area"
      >
        <div className="h-80">
          {/* Placeholder panel content: the chip floats over whatever is
            there, so the stand-in is deliberately unremarkable. */}
          <div className="flex h-9 items-center gap-2 px-3 text-xs fg-secondary">
            <TerminalIcon size={14} />
            Panel
          </div>
          <div className="flex flex-col px-3 gap-2">
            <div className="h-2.5 w-3/5 rounded-full bg-subtle" />
            <div className="h-2.5 w-4/5 rounded-full bg-subtle" />
            <div className="h-2.5 w-2/5 rounded-full bg-subtle" />
            <div className="h-2.5 w-3/4 rounded-full bg-subtle" />
          </div>
          {/* Same anchoring as the app's bottom status host: `right-3 bottom-3`
            in the shell's bottom-right corner, floating over the content. */}
          <div className="pointer-events-none absolute right-3 bottom-3 z-10 flex items-center justify-end [&>*]:pointer-events-auto">
            <WakeLockIndicatorView
              state={DEMO_WAKE_LOCK_STATE}
              collapsed={false}
              statusBar
              onClick={noop}
            />
          </div>
        </div>
      </Surface>
      <Caption>
        In the app the chip floats in the bottom-right corner of the main shell
        while an agent turn or workflow runs and Keep system awake is on in
        Performance settings. Nothing reserves space for it: it floats over the
        panel content like a toast. Clicking it opens those settings. Hover for
        the full explanation.
      </Caption>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// 5. Panel minimum width — a resizable leaf plus fixed-width comparisons
// ---------------------------------------------------------------------------

function LeafCard(): JSX.Element {
  return (
    <SharedPanelSection
      icon={<FilesIcon size={16} />}
      title={CHANGED_FILES_REFERENCE.title}
      subtitle={CHANGED_FILES_REFERENCE.subtitle}
      headerAction={
        <HeaderActionButton
          iconOnly
          aria-label={CHANGED_FILES_REFERENCE.actionLabel}
          tooltipLabel={CHANGED_FILES_REFERENCE.actionLabel}
          onClick={noop}
        >
          <EyeIcon size={16} />
        </HeaderActionButton>
      }
    >
      <CardRows rows={CHANGED_FILES_REFERENCE.rows.slice(0, 2)} />
    </SharedPanelSection>
  );
}

function FixedLeaf({
  width,
  label,
  testId,
}: {
  width: number;
  label: string;
  testId: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <Caption>{label}</Caption>
      <div data-testid={testId} style={{ width: `${width}px` }}>
        <Surface variant="outline" className="overflow-hidden">
          <LeafCard />
        </Surface>
      </div>
    </div>
  );
}

function PanelMinWidthAfter(): JSX.Element {
  return (
    <div className="flex flex-wrap items-start gap-6">
      <div className="flex flex-col gap-1.5">
        <Caption>
          Drag the corner handle: the leaf stops at{' '}
          {DEFAULT_PANEL_LEAF_MINIMUM_WIDTH}px and the action stays visible.
        </Caption>
        <div
          data-testid="change-review-resizable-leaf"
          className="resize-x overflow-hidden"
          style={{
            width: '320px',
            maxWidth: '100%',
            minWidth: `${DEFAULT_PANEL_LEAF_MINIMUM_WIDTH}px`,
          }}
        >
          <Surface variant="outline" className="overflow-hidden">
            <LeafCard />
          </Surface>
        </div>
      </div>
      <FixedLeaf
        width={100}
        label="Before: the old 100px floor clips the header."
        testId="change-review-leaf-before"
      />
      <FixedLeaf
        width={DEFAULT_PANEL_LEAF_MINIMUM_WIDTH}
        label={`After: the ${DEFAULT_PANEL_LEAF_MINIMUM_WIDTH}px floor keeps the button.`}
        testId="change-review-leaf-after"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6. Pipeline row chips — every status badge and action button in one row
// ---------------------------------------------------------------------------

function PipelineRowChipsAfter(): JSX.Element {
  return (
    <Stack gap="inline">
      <Surface variant="group" data-testid="change-review-badge-row">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
          <Badge {...pipelineRunStatusBadge('running')}>running</Badge>
          <Badge {...pipelineRunStatusBadge('success', { muted: true })}>
            success
          </Badge>
          <Badge tone="special">Plan updated</Badge>
          <Badge tone="warning" aria-label="Workflow input required">
            Input required
          </Badge>
          <AdvisorEtaBadge
            snapshot={DEMO_ADVISOR_SNAPSHOT}
            pipelineStatus="running"
            interactive={false}
          />
          <FollowUpButton
            label={CHAT_UNIT_LABEL}
            icon={<ChatIcon />}
            onClick={noop}
            dataTestId="change-review-follow-up-chat"
          />
          <FollowUpButton
            label="Workflow"
            icon={<PipelineIcon />}
            onClick={noop}
          />
          <ExecutionActionButton
            label="Try again"
            icon={<RetryIcon size="sm" />}
            onClick={noop}
            ariaLabel="Try the workflow run again"
            variant="warning"
            dataTestId="change-review-retry"
          />
          <ExecutionActionButton
            label="Start over"
            icon={<RerunIcon size="sm" />}
            onClick={noop}
            ariaLabel="Start workflow run over"
            variant="destructive-chip"
            dataTestId="change-review-rerun"
          />
        </div>
      </Surface>
      <Caption>
        Left to right: the status badges — running, success (muted), Plan
        updated, Input required, Advisor ETA — then the action buttons — Chat
        and Workflow (neutral), Try again (warning), Start over (destructive).
        Same height, radius, label size, and hairline ring within each shape.
      </Caption>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// 7. Context meter — undefined usage and a seeded zeroed usage
// ---------------------------------------------------------------------------

function ContextMeterAfter(): JSX.Element {
  const [seededUsage] = useState(buildSeededContextMeterUsage);
  return (
    <Stack gap="inline">
      <div className="flex flex-wrap items-start gap-8">
        <div
          className="flex items-center gap-3"
          data-testid="change-review-context-meter-empty"
        >
          <UsageIndicator usage={undefined} isCodex={false} />
          <Caption>
            No usage yet — click the ring; the popover opens with the hint.
          </Caption>
        </div>
        <div
          className="flex items-center gap-3"
          data-testid="change-review-context-meter-seeded"
        >
          <UsageIndicator
            usage={seededUsage}
            isCodex={false}
            model={CONTEXT_METER_MODEL}
          />
          <Caption>
            Seeded after a handoff — Context reads 0 of the model’s window.
          </Caption>
        </div>
      </div>
      <Caption>
        The meter stays alive after Continue on another harness and after an
        in-place model change, where it previously painted 0% with a dead
        popover.
      </Caption>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// 8 and 9. Sidebar rows
// ---------------------------------------------------------------------------

type UnreadPreviewRowProps = Pick<
  WorktreeRowProps,
  | 'unreadPopoverSlot'
  | 'onUnreadIconMouseEnter'
  | 'onUnreadIconMouseLeave'
  | 'onUnreadIconFocus'
  | 'onUnreadIconBlur'
  | 'onUnreadIconKeyDown'
>;

/**
 * Mirror of the unread-dot popover state in `WorktreeItem`: the dot's
 * bounding rect is captured on hover/focus and cleared on leave/blur/Escape,
 * and while it is set the shared `ChatPreviewPopover` is handed to the row as
 * `unreadPopoverSlot`. `WorktreeRow` returns the dot bare whenever a host
 * mouse-enter handler exists, so the seeded rows replace the plain "Unread
 * messages" tooltip the bare row would otherwise show. The sidebar snapshots
 * its rows from the chat store on hover; here they are static fixtures.
 */
function useSeededUnreadPreview(
  rows: readonly ChatPreviewRow[] | undefined,
  hasUnread: boolean,
): UnreadPreviewRowProps {
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const show = useCallback((element: HTMLElement): void => {
    setAnchorRect(element.getBoundingClientRect());
  }, []);
  const hide = useCallback((): void => {
    setAnchorRect(null);
  }, []);
  const onMouseEnter = useCallback(
    (event: MouseEvent<HTMLSpanElement>): void => {
      show(event.currentTarget);
    },
    [show],
  );
  const onFocus = useCallback(
    (event: FocusEvent<HTMLSpanElement>): void => {
      show(event.currentTarget);
    },
    [show],
  );
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>): void => {
      if (event.key !== 'Escape') return;
      hide();
      event.currentTarget.blur();
    },
    [hide],
  );

  if (!rows || !hasUnread) return {};
  return {
    unreadPopoverSlot:
      anchorRect !== null ? (
        <ChatPreviewPopover
          anchorRect={anchorRect}
          rows={[...rows]}
          heading={`Unread ${CHAT_UNIT_LABEL_PLURAL}`}
        />
      ) : undefined,
    onUnreadIconMouseEnter: onMouseEnter,
    onUnreadIconMouseLeave: hide,
    onUnreadIconFocus: onFocus,
    onUnreadIconBlur: hide,
    onUnreadIconKeyDown: onKeyDown,
  };
}

function DemoSidebarRow({
  fixture,
}: {
  fixture: SidebarRowFixture;
}): JSX.Element {
  const unreadPreview = useSeededUnreadPreview(
    fixture.unreadPreviewRows,
    fixture.props.hasUnread === true,
  );
  return (
    // `sidebar-instant-interactions` zeroes descendant transitions, exactly
    // like the real sidebar's <aside> wrapper.
    <div className="sidebar-instant-interactions min-w-0 max-w-xs">
      <WorktreeRow
        branchLabel={fixture.label}
        branchName={`demo/${fixture.id}`}
        worktreeId={fixture.id}
        displayMode="list"
        textScale="sidebar"
        {...fixture.props}
        {...unreadPreview}
        dataTestId={`change-review-row-${fixture.id}`}
      />
    </div>
  );
}

function RichTooltipsAfter(): JSX.Element {
  const [fastMode, setFastMode] = useState<boolean | undefined>(undefined);
  return (
    <Stack gap="item">
      <Caption>
        Hover: tooltips now open instantly; previously native title tooltips
        took about a second.
      </Caption>
      <Surface variant="group" data-testid="change-review-tooltip-row">
        <div className="flex flex-wrap items-center gap-3 px-3 py-2">
          <ChatComposerToolbarChip
            icon={<PlanModeIcon size={14} />}
            label="Plan"
            title="Plan before making changes"
            ariaLabel="Plan mode"
            onClick={noop}
          />
          <FastModeButton value={fastMode} onChange={setFastMode} />
          <BubbleCopyBadge copyText="Copied from the review page" />
          <VoiceInputButton
            state="idle"
            error={null}
            onStart={noop}
            onStop={noop}
          />
        </div>
      </Surface>
      <div className="flex flex-col gap-1.5">
        <Caption>{TOOLTIP_SIDEBAR_ROW.caption}</Caption>
        <DemoSidebarRow fixture={TOOLTIP_SIDEBAR_ROW} />
      </div>
    </Stack>
  );
}

function UnreadAfterAnswerAfter(): JSX.Element {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-4">
      {UNREAD_AFTER_ANSWER_ROWS.map((fixture) => (
        <div className="flex flex-col gap-1.5" key={fixture.id}>
          <DemoSidebarRow fixture={fixture} />
          <Caption>{fixture.caption}</Caption>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function renderAfter(
  id: ChangeReviewSectionId,
  headerReady: boolean,
): JSX.Element {
  switch (id) {
    case 'git-actions':
      return <GitActionsAfter ready={headerReady} />;
    case 'user-bubble':
      return <UserBubblesAfter />;
    case 'activity-cards':
      return <ActivityCardsAfter />;
    case 'sleep-paused-pill':
      return <SleepPausedPillAfter />;
    case 'panel-min-width':
      return <PanelMinWidthAfter />;
    case 'plan-updated-badge':
      return <PipelineRowChipsAfter />;
    case 'context-meter':
      return <ContextMeterAfter />;
    case 'rich-tooltips':
      return <RichTooltipsAfter />;
    case 'unread-after-answer':
      return <UnreadAfterAnswerAfter />;
  }
}

/**
 * Flag gate at the PAGE, not just the sidebar entry. `change-review` stays in
 * `NavigationPage` and the route dispatcher so the More-menu item can reach
 * it, which means an App Advisor `navigation.go_to_page` action could
 * otherwise land here in a packaged build. Gating here closes that route at
 * the render boundary — and, since the content never mounts, seeds nothing
 * into the stores. Mirrors `HeaderStateGalleryPage`.
 */
export function ChangeReviewPage(): JSX.Element {
  if (!isChangeReviewPageEnabled()) {
    return (
      <Surface
        variant="pane"
        extent="parent"
        className="flex items-center justify-center"
        data-testid="change-review-page-disabled"
      >
        <p className="text-xs fg-secondary">
          This page is a development-only reference and is not enabled in this
          build.
        </p>
      </Surface>
    );
  }
  return <ChangeReviewContent />;
}

function ChangeReviewContent(): JSX.Element {
  // The git-action rows are the real WorktreeTopBar driven by the Header
  // States seed; the hook scopes every write to that synthetic workspace and
  // restores the projects array on unmount.
  const headerReady = useSeededHeaderGalleryState();

  return (
    <section className="flex h-full flex-col" data-testid="page-change-review">
      <PageTitlebar />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-12">
        <div className="flex flex-col mx-auto max-w-5xl gap-8">
          <Stack gap="inline">
            <Heading level={1} variant="page">
              Change review
            </Heading>
            <p className="text-s fg-secondary">
              Nine UI fixes from one batch, each with the old state described
              and the new state rendered by the shipping components with seeded
              props — no live sessions, git, or network. Switch theme and color
              mode from Settings to check both. This page is only reachable in
              dev and E2E builds.
            </p>
          </Stack>

          {CHANGE_REVIEW_SECTIONS.map((section) => (
            <ReviewSection key={section.id} section={section}>
              {renderAfter(section.id, headerReady)}
            </ReviewSection>
          ))}
        </div>
      </div>
    </section>
  );
}
