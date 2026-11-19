import { requestAutomationProjectCreation } from '@/stores/automationInstallContinuationStore';
import {
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsRowsSection,
  SettingsRowsValue,
  Heading,
} from '@canopy/ui-shared/components';
import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared';
import {
  BusyLabel,
  Button,
  DetailPageActions,
} from '@canopy/ui-shared/components';
import { AutomationDefinitionSummary } from '@canopy/ui-shared/components/AutomationDefinitionSummary';
import {
  AutomationReadDetail,
  CenteredLoadingSpinner,
  CustomizeEntryLogo,
  CustomizePublisher,
  CustomizeRowSplitButton,
  DetailActionBar,
  DetailFactError,
  DetailVersionUpdateFact,
  WorkflowLastRunText,
} from '@canopy/ui-shared/components';
import {
  customizeRowAction,
  customizeWorkflowAvailability,
  customizeDiscoveryIdentity,
  customizeWorkflowSource,
  isPendingSharedAutomationEntry,
  sharedAutomationEntry,
  type CustomizeWorkflowActions,
  type CustomizeWorkflowAvailability,
} from '@canopy/ui-app/capability';
import { WORKFLOW_MANAGE_UNAVAILABLE_REASON } from '@canopy/ui-app/workflows';
import { toAppError } from '@canopy/protocol/app-errors';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib/unified-plugin-entry';
import { describeFiveFieldCron } from '@canopy/ui-shared/lib/cron-description';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { getAutomationTriggerLabel } from '@canopy/desktop-shared/lib/automations';
import type { SharedAutomationDetail } from '@canopy/protocol/automations';
import {
  toCuratedAutomationInstallSource,
  type CuratedAutomationDetail,
} from '@canopy/protocol/automation-catalog';
import { CUSTOMIZE_LABEL } from '@canopy/protocol/ui-labels';
import { useInstallWorkspaces } from '@/hooks/useInstallWorkspaces';
import {
  installedCopiesOf,
  localBadgeForSummary,
  staleCopiesOf,
} from '@/lib/automationShareRelationship';
import { resolveSharedResourceErrorMessage } from '@/lib/sharedResourceErrors';
import { DelayedLoadingPlaceholder } from '@canopy/ui-shared/components';
import {
  CuratedAutomationDetailSkeleton,
  SharedAutomationDetailSkeleton,
} from './AutomationCatalogDetailSkeletons';
import { McpServerLogo } from '../shared/McpServerLogo';
import { AutomationUpdateModal } from './AutomationUpdateModal';
import { InstallSharedAutomationModal } from './InstallSharedAutomationModal';
import {
  automationUpdateSourceOf,
  useAutomationUpdateSource,
  type MarketplaceAutomationSourceKind,
} from './useAutomationUpdateSource';
import { SharedAutomationPreview } from './SharedAutomationPreview';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  curatedAutomationInstallLink,
  sharedResourceInstallLink,
} from '@/lib/sharedResourceInstallLink';

/**
 * Marketplace detail surfaces for the three automation sources: a local
 * automation, a team-shared one, and a curated catalog entry. Each is a read
 * view plus one next step. Editing stays on the Workflows page. Adding opens
 * the shared install review (CAN-3710). Updating, which may pick among
 * several stale copies, and "Install another copy" still open the wizard
 * here until the review can collect those inputs.
 */

function describeTrigger(activity: ScheduledActivity): string {
  const label = getAutomationTriggerLabel(activity.schedule);
  if (activity.schedule.kind === 'cron') {
    return `${label} · ${
      describeFiveFieldCron(activity.schedule.expression) ??
      activity.schedule.expression
    }`;
  }
  if (activity.schedule.kind === 'one_time') {
    return `${label} · ${new Date(activity.schedule.runAt).toLocaleString()}`;
  }
  return label;
}

function describeOrigin(activity: ScheduledActivity): string {
  if (activity.installedFrom) {
    switch (activity.installedFrom.sourceKind ?? 'shared') {
      case 'curated':
        return `Added from ${CUSTOMIZE_LABEL}`;
      case 'public':
        return 'Added from a public link';
      case 'shared':
        return 'Added from a shared automation';
    }
  }
  return activity.remote ? 'Shared by you' : 'Local';
}

interface AutomationCatalogDetailProps {
  activity: ScheduledActivity;
  /** One line saying when the automation runs and what it does. */
  summary: string;
  /** The source this copy was installed from has changed since. */
  updateAvailable: boolean;
  onOpenInAutomations: () => void;
}

/** Read-only Marketplace summary of a local automation. */
export function AutomationCatalogDetail({
  activity,
  summary,
  updateAvailable,
  onOpenInAutomations,
}: AutomationCatalogDetailProps): JSX.Element {
  const update = useAutomationUpdateSource();
  const source = automationUpdateSourceOf(activity);
  const openUpdate = (): void => {
    // A failure shows in the notice below.
    update.openUpdate(activity).catch(() => {});
  };

  const canUpdate = updateAvailable && source !== null;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-6"
      data-testid="automation-catalog-detail"
    >
      <div className="flex items-start gap-3">
        <McpServerLogo
          size={40}
          fallback="monogram"
          name={activity.name}
          shape="circle"
          fit="contain"
        />
        <div className="min-w-0 flex-1">
          <Heading level={2} variant="section">
            {activity.name}
          </Heading>
          <p
            className="mt-0.5 text-xs fg-secondary"
            data-testid="automation-catalog-origin"
          >
            {describeOrigin(activity)}
          </p>
        </div>
        {/* Page actions join the detail's action bar: Update is primary when
            it applies, with Open beside it as a secondary. */}
        <DetailPageActions
          secondary={
            canUpdate ? (
              <Button
                size="compact"
                onClick={onOpenInAutomations}
                data-testid="automation-catalog-open"
              >
                Open in Workflows
              </Button>
            ) : undefined
          }
          primary={
            canUpdate ? (
              <Button
                variant="primary"
                size="compact"
                onClick={openUpdate}
                disabled={update.loading}
                data-testid="automation-catalog-update"
              >
                <BusyLabel busy={update.loading}>Update</BusyLabel>
              </Button>
            ) : (
              <Button
                variant="primary"
                size="compact"
                onClick={onOpenInAutomations}
                data-testid="automation-catalog-open"
              >
                Open in Workflows
              </Button>
            )
          }
        />
      </div>

      {canUpdate && (
        <Notice
          intent="neutral"
          role="none"
          title="Update available."
          data-testid="automation-catalog-update-available"
        >
          The automation this copy came from has changed. Updating keeps your
          project and inputs.
        </Notice>
      )}

      {update.error !== null && (
        <Notice
          errorSource="automation-catalog-update-error"
          intent="destructive"
          title="Couldn't load the update."
          data-testid="automation-catalog-update-error"
          actions={<NoticeButton onClick={openUpdate}>Try again</NoticeButton>}
        >
          {update.error}
        </Notice>
      )}

      {/* The entry description quotes the automation's prompt: blocked. */}
      <p
        className={`${POSTHOG_REPLAY_BLOCK_CLASS} text-s fg-secondary`}
        data-testid="automation-catalog-summary"
      >
        {summary}
      </p>

      <SettingsRowsSection title="Details">
        <SettingsRowsGroup>
          <SettingsRowsRow
            fact
            label="Trigger"
            control={
              <SettingsRowsValue dataTestId="automation-catalog-trigger">
                {describeTrigger(activity)}
              </SettingsRowsValue>
            }
          />
          <SettingsRowsRow
            fact
            label="Status"
            control={
              <SettingsRowsValue dataTestId="automation-catalog-status">
                {activity.enabled ? 'Enabled' : 'Disabled'}
              </SettingsRowsValue>
            }
          />
        </SettingsRowsGroup>
      </SettingsRowsSection>

      {update.pending && (
        <AutomationUpdateModal update={update.pending} onClose={update.clear} />
      )}
    </div>
  );
}

/** New Customize: the tile's identity, for a page on the shared layout. */
export interface AutomationDetailIdentity {
  /** The tile's entry, with New Customize's identity applied. */
  readonly entry: UnifiedPluginEntry;
  readonly logo: ReactNode;
  readonly publisher: ReactNode;
}

const NO_WORKFLOW_ACTIONS: CustomizeWorkflowAvailability = {
  run: { available: false, reason: WORKFLOW_MANAGE_UNAVAILABLE_REASON },
  toggle: { available: false, reason: WORKFLOW_MANAGE_UNAVAILABLE_REASON },
  runNow: { available: false, reason: WORKFLOW_MANAGE_UNAVAILABLE_REASON },
  edit: { available: false, reason: WORKFLOW_MANAGE_UNAVAILABLE_REASON },
  viewRuns: { available: false, reason: WORKFLOW_MANAGE_UNAVAILABLE_REASON },
  delete: { available: false, reason: WORKFLOW_MANAGE_UNAVAILABLE_REASON },
};

/** A source's own schedule, which whoever adds it may change. */
function suggestedSchedule(
  trigger: SharedAutomationDetail['automation']['trigger'],
): string {
  return trigger.kind === 'cron'
    ? (describeFiveFieldCron(trigger.expression) ?? trigger.expression)
    : `One time · ${new Date(trigger.runAt).toLocaleString()}`;
}

function formatNextRun(at: string | undefined): string | undefined {
  if (!at) return undefined;
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
}

/**
 * An automation's On/Off, as its tile draws it: the tile's split control
 * with the tile's availability, read from the live automation. A failed
 * change goes to `onError`, which the page says beside the actions.
 */
function AutomationToggle({
  activity,
  tile,
  workflowActions,
  onError,
}: {
  activity: ScheduledActivity;
  tile: UnifiedPluginEntry;
  workflowActions: CustomizeWorkflowActions | undefined;
  onError: (message: string | null) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const entry: UnifiedPluginEntry = {
    ...tile,
    workflow: { ...tile.workflow, enabled: activity.enabled },
  };
  const availability = workflowActions
    ? customizeWorkflowAvailability(entry, workflowActions)
    : NO_WORKFLOW_ACTIONS;
  const toggle = (): void => {
    const onSetEnabled = workflowActions?.onSetEnabled;
    if (!onSetEnabled || busy) return;
    const next = !activity.enabled;
    setBusy(true);
    onError(null);
    onSetEnabled(entry, next)
      .catch((failure: unknown) => {
        onError(
          toAppError(failure)?.detail.message.trim() ||
            `Couldn't turn ${next ? 'on' : 'off'} this automation`,
        );
      })
      .finally(() => setBusy(false));
  };
  const split = customizeRowAction({
    entry,
    workflow: { availability, busy, onRun: () => undefined, onToggle: toggle },
    installed: true,
    statuses: [],
    pendingKeys: new Set(),
  });
  return (
    <CustomizeRowSplitButton
      // The page's title names it; its labels keep the automation's own
      // name out of session replay.
      entryName="this automation"
      idPrefix={`automation-detail-${activity.id}`}
      action={{
        ...split,
        accessibleName: `This automation is ${activity.enabled ? 'on' : 'off'}`,
      }}
      items={[]}
      testId="automation-detail-toggle-menu"
    />
  );
}

function toggleNotice(error: string | null): ReactNode {
  return error ? (
    <DetailFactError error={error} testId="automation-detail-toggle-error" />
  ) : undefined;
}

/** The local copy's row, for a source page whose automation is installed. */
function installedCopyEntry(
  source: UnifiedPluginEntry,
  activity: ScheduledActivity,
): UnifiedPluginEntry {
  return {
    ...source,
    id: `automation:local:${activity.id}`,
    name: activity.name,
    state: 'installed',
    ref: { type: 'automation', activityId: activity.id },
  };
}

/**
 * New Customize's page for a local automation: the tile's On/Off as the
 * primary, Open in Workflows beside it, Update in the Version row.
 */
export function LocalAutomationLayoutDetail({
  activity,
  identity,
  updateAvailable,
  onOpenInAutomations,
  workflowActions,
}: {
  activity: ScheduledActivity;
  identity: AutomationDetailIdentity;
  updateAvailable: boolean;
  onOpenInAutomations: () => void;
  workflowActions?: CustomizeWorkflowActions;
}): JSX.Element {
  const update = useAutomationUpdateSource();
  const source = automationUpdateSourceOf(activity);
  const canUpdate = updateAvailable && source !== null;
  const [toggleError, setToggleError] = useState<string | null>(null);
  const entry = identity.entry;
  const openUpdate = (): void => {
    update.openUpdate(activity).catch((failure: unknown) => {
      // The hook keeps the failure, which the Version row shows.
      toAppError(failure);
    });
  };
  const workflowSource = customizeWorkflowSource(entry);
  return (
    <>
      <AutomationReadDetail
        name={entry.name}
        description={entry.description}
        logo={identity.logo}
        publisher={identity.publisher}
        actions={
          <DetailActionBar
            secondary={
              <Button
                size="compact"
                onClick={onOpenInAutomations}
                data-testid="automation-catalog-open"
              >
                Open in Workflows
              </Button>
            }
            primary={
              <AutomationToggle
                activity={activity}
                tile={entry}
                workflowActions={workflowActions}
                onError={setToggleError}
              />
            }
          />
        }
        actionsNotice={toggleNotice(toggleError)}
        {...(workflowSource
          ? {
              source: workflowSource,
              sourceIsPerson: entry.workflow?.sourceIsPerson === true,
            }
          : {})}
        schedule={{
          value: entry.workflow?.schedule?.tooltip ?? describeTrigger(activity),
        }}
        lastRun={
          <WorkflowLastRunText
            lastRun={entry.workflow?.lastRun}
            dataTestId="automation-detail-last-run-status"
          />
        }
        {...(activity.enabled && formatNextRun(activity.nextRunAt)
          ? { nextRun: formatNextRun(activity.nextRunAt) }
          : {})}
        version={
          canUpdate ? (
            <DetailVersionUpdateFact
              name={entry.name}
              testId="automation-catalog-update"
              update={{
                busy: update.loading,
                run: openUpdate,
                ...(update.error !== null ? { error: update.error } : {}),
              }}
            />
          ) : undefined
        }
        summary={entry.workflow?.summary ?? entry.description}
      />
      {update.pending && (
        <AutomationUpdateModal update={update.pending} onClose={update.clear} />
      )}
    </>
  );
}

/** "What it does" while a source automation loads, or when it can't. */
function sourceContentsNotice(
  error: string | null,
  onRetry: () => void,
): ReactNode {
  return error !== null ? (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-s">
      <DetailFactError error={error} testId="automation-source-error" />
      <span aria-hidden>·</span>
      <Button variant="link" onClick={onRetry}>
        Try again
      </Button>
    </span>
  ) : (
    <DelayedLoadingPlaceholder slowNote="Still loading automation…">
      <CenteredLoadingSpinner spacing="section" />
    </DelayedLoadingPlaceholder>
  );
}

/**
 * New Customize's actions for a source automation, as its tile offers them:
 * Add, or Open in Workflows for an installed copy, with Install another copy
 * beside it. A changed source says Update on its Version row instead.
 */
function SourceLayoutActions({
  step,
  onInstall,
  onInstallAnotherCopy,
  onOpenInAutomations,
  activities,
  source,
  workflowActions,
  onToggleError,
}: SourceActionProps & {
  activities: readonly ScheduledActivity[];
  /** The source's tile entry. */
  source: UnifiedPluginEntry;
  workflowActions: CustomizeWorkflowActions | undefined;
  onToggleError: (message: string | null) => void;
}): JSX.Element {
  const openId =
    step.kind === 'open'
      ? step.activityId
      : step.kind === 'update'
        ? step.staleActivities[0]?.id
        : undefined;
  // The installed copy (the one Open in Workflows opens): its tile's On/Off
  // is the primary.
  const copy = activities.find((activity) => activity.id === openId);
  if (openId === undefined || !copy) {
    return (
      <DetailActionBar
        primary={
          <Button
            variant="primary"
            size="compact"
            onClick={onInstall}
            data-testid="automation-source-install"
          >
            Add
          </Button>
        }
      />
    );
  }
  return (
    <DetailActionBar
      secondary={
        <>
          <Button
            size="compact"
            onClick={onInstallAnotherCopy}
            data-testid="automation-catalog-install-another-copy"
          >
            Install another copy
          </Button>
          <Button
            size="compact"
            onClick={() => onOpenInAutomations(openId)}
            data-testid="automation-source-open"
          >
            Open in Workflows
          </Button>
        </>
      }
      primary={
        <AutomationToggle
          activity={copy}
          tile={installedCopyEntry(source, copy)}
          workflowActions={workflowActions}
          onError={onToggleError}
        />
      }
    />
  );
}

/**
 * What the detail offers next for a team-shared or curated automation:
 * add it, update the installed copies, or open the copy that already exists.
 */
type SourceNextStep =
  | { kind: 'add' }
  | { kind: 'update'; staleActivities: ScheduledActivity[] }
  | { kind: 'open'; activityId: string };

function nextStepFor(
  activities: readonly ScheduledActivity[],
  source: {
    sourceKind: MarketplaceAutomationSourceKind;
    remoteId: string;
    contentHash: string;
  },
  sharedByActivityId: string | null,
): SourceNextStep {
  if (sharedByActivityId !== null) {
    return { kind: 'open', activityId: sharedByActivityId };
  }
  const stale = staleCopiesOf(activities, source);
  if (stale.length > 0) return { kind: 'update', staleActivities: stale };
  const installed = installedCopiesOf(activities, source)[0];
  return installed
    ? { kind: 'open', activityId: installed.id }
    : { kind: 'add' };
}

interface SourceActionProps {
  step: SourceNextStep;
  onInstall: () => void;
  /**
   * Installs an independent new copy while one already exists (or the user
   * shared this automation), the way the retired Shared tab's Install did.
   */
  onInstallAnotherCopy: () => void;
  onOpenInAutomations: (activityId: string) => void;
}

function SourceAction({
  step,
  onInstall,
  onInstallAnotherCopy,
  onOpenInAutomations,
}: SourceActionProps): JSX.Element {
  // The detail's primary action, in its action bar at the top right.
  if (step.kind === 'open') {
    return (
      <DetailPageActions
        secondary={
          <Button
            size="compact"
            onClick={onInstallAnotherCopy}
            data-testid="automation-catalog-install-another-copy"
          >
            Install another copy
          </Button>
        }
        primary={
          <Button
            variant="primary"
            size="compact"
            onClick={() => onOpenInAutomations(step.activityId)}
            data-testid="automation-source-open"
          >
            Open in Workflows
          </Button>
        }
      />
    );
  }
  return (
    <DetailPageActions
      primary={
        <Button
          variant="primary"
          size="compact"
          onClick={onInstall}
          data-testid="automation-source-install"
        >
          {step.kind === 'update' ? 'Update' : 'Add'}
        </Button>
      }
    />
  );
}

interface SharedAutomationMarketplaceDetailProps {
  automationId: string;
  /** Every local automation, used to tell whether this share is installed. */
  activities: readonly ScheduledActivity[];
  onOpenInAutomations: (activityId: string) => void;
  /**
   * Reports the share's name once it loads, for a host that opened the
   * detail by id before its inventory listed the share.
   */
  onNameLoaded?: (name: string) => void;
  /** New Customize: the shared layout, with the tile's identity. */
  layout?: AutomationDetailIdentity;
  /** The Workflows rows' actions: an installed copy's On/Off. */
  workflowActions?: CustomizeWorkflowActions;
}

/** A team-shared automation: the share's preview plus Add, Update, or Open. */
export function SharedAutomationMarketplaceDetail({
  automationId,
  activities,
  onOpenInAutomations,
  onNameLoaded,
  layout,
  workflowActions,
}: SharedAutomationMarketplaceDetailProps): JSX.Element {
  const workspaces = useInstallWorkspaces();
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [detail, setDetail] = useState<SharedAutomationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [installOpen, setInstallOpen] = useState(false);
  const [anotherCopyOpen, setAnotherCopyOpen] = useState(false);
  const onNameLoadedRef = useRef(onNameLoaded);
  useEffect(() => {
    onNameLoadedRef.current = onNameLoaded;
  });
  const loadedName = detail?.name ?? null;
  useEffect(() => {
    if (loadedName !== null) onNameLoadedRef.current?.(loadedName);
  }, [loadedName]);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    window.api.automations
      .getShared(automationId)
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setError(
          resolveSharedResourceErrorMessage(failure, {
            unsupportedResource: 'automations',
          }),
        );
      });
    return (): void => {
      cancelled = true;
    };
  }, [automationId, reloadKey]);

  const badge = detail ? localBadgeForSummary(detail, activities) : null;
  const sharedByActivityId =
    badge === 'shared-by-you'
      ? (activities.find((activity) => activity.remote?.remoteId === detail?.id)
          ?.id ?? null)
      : null;
  const step: SourceNextStep = detail
    ? nextStepFor(
        activities,
        {
          sourceKind: 'shared',
          remoteId: detail.id,
          contentHash: detail.contentHash,
        },
        sharedByActivityId,
      )
    : { kind: 'add' };

  // A team or organization share adds through the shared review; a private
  // one resolves for nobody else, so it keeps the wizard here.
  const installLink = detail
    ? sharedResourceInstallLink({
        entity: 'automation',
        externalId: detail.id,
        scope: detail.shareScope,
      })
    : null;
  const handleInstall = (): void => {
    if (step.kind === 'update' || installLink === null) {
      setInstallOpen(true);
      return;
    }
    useNavigationStore.getState().openShareInstall(installLink, 'in-app');
  };

  const modals = detail ? (
    <>
      {installOpen && step.kind !== 'open' && (
        <InstallSharedAutomationModal
          onCreateProject={requestAutomationProjectCreation}
          detail={detail}
          source="shared"
          staleActivities={step.kind === 'update' ? step.staleActivities : []}
          workspaces={workspaces}
          onClose={(): void => setInstallOpen(false)}
          onDone={(): void => {
            // The automations store refreshes through the service broadcast;
            // the next step recomputes from the updated activities.
          }}
        />
      )}
      {anotherCopyOpen && (
        <InstallSharedAutomationModal
          onCreateProject={requestAutomationProjectCreation}
          detail={detail}
          source="shared"
          // An independent new copy: never an update of an existing one.
          staleActivities={[]}
          workspaces={workspaces}
          onClose={(): void => setAnotherCopyOpen(false)}
          onDone={(): void => {
            // The automations store refreshes through the service broadcast.
          }}
        />
      )}
    </>
  ) : null;

  if (layout) {
    // The page keeps its layout while the share loads or fails: the header
    // from the tile, the state in What it does.
    // A share opened by link before the inventory lists it takes its whole
    // identity from the share once read, as the list would build it.
    const loaded =
      detail && isPendingSharedAutomationEntry(layout.entry)
        ? customizeDiscoveryIdentity(sharedAutomationEntry(detail))
        : undefined;
    const shown = loaded ?? layout.entry;
    return (
      <>
        <AutomationReadDetail
          dataTestId="shared-automation-marketplace-detail"
          name={shown.name}
          description={shown.description}
          logo={
            loaded ? (
              <CustomizeEntryLogo
                entry={loaded}
                McpServerLogoComponent={McpServerLogo}
              />
            ) : (
              layout.logo
            )
          }
          publisher={
            loaded ? <CustomizePublisher entry={loaded} /> : layout.publisher
          }
          actions={
            detail ? (
              <SourceLayoutActions
                step={step}
                onInstall={handleInstall}
                onInstallAnotherCopy={() => setAnotherCopyOpen(true)}
                onOpenInAutomations={onOpenInAutomations}
                activities={activities}
                source={shown}
                workflowActions={workflowActions}
                onToggleError={setToggleError}
              />
            ) : undefined
          }
          actionsNotice={toggleNotice(toggleError)}
          source={customizeWorkflowSource(shown)}
          {...(detail
            ? {
                schedule: {
                  value: suggestedSchedule(detail.automation.trigger),
                  suggested: true,
                },
                definition: detail.automation,
              }
            : {
                contentsNotice: sourceContentsNotice(error, () =>
                  setReloadKey((value) => value + 1),
                ),
              })}
          version={
            step.kind === 'update' ? (
              <DetailVersionUpdateFact
                name={shown.name}
                testId="automation-catalog-update"
                update={{ run: handleInstall }}
              />
            ) : undefined
          }
        />
        {modals}
      </>
    );
  }

  if (error !== null) {
    return (
      <Notice
        errorSource="shared-automation-load"
        intent="destructive"
        title="Couldn't load this automation."
        data-testid="automation-source-error"
        actions={
          <NoticeButton onClick={() => setReloadKey((value) => value + 1)}>
            Try again
          </NoticeButton>
        }
      >
        {error}
      </Notice>
    );
  }
  if (!detail) {
    return (
      <DelayedLoadingPlaceholder slowNote="Still loading automation…">
        <SharedAutomationDetailSkeleton />
      </DelayedLoadingPlaceholder>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4"
      data-testid="shared-automation-marketplace-detail"
    >
      <SharedAutomationPreview detail={detail} localBadge={badge} />
      <SourceAction
        step={step}
        onInstall={handleInstall}
        onInstallAnotherCopy={() => setAnotherCopyOpen(true)}
        onOpenInAutomations={onOpenInAutomations}
      />
      {modals}
    </div>
  );
}

interface CuratedAutomationMarketplaceDetailProps {
  /** Entry name shown while the catalog detail is still loading. */
  name: string;
  detail: CuratedAutomationDetail | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  activities: readonly ScheduledActivity[];
  onOpenInAutomations: (activityId: string) => void;
  /** New Customize: the shared layout, with the tile's identity. */
  layout?: AutomationDetailIdentity;
  /** The Workflows rows' actions: an installed copy's On/Off. */
  workflowActions?: CustomizeWorkflowActions;
}

/** A curated catalog automation: what it does, plus Add, Update, or Open. */
export function CuratedAutomationMarketplaceDetail({
  name,
  detail,
  loading,
  error,
  onRetry,
  activities,
  onOpenInAutomations,
  layout,
  workflowActions,
}: CuratedAutomationMarketplaceDetailProps): JSX.Element {
  const workspaces = useInstallWorkspaces();
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [anotherCopyOpen, setAnotherCopyOpen] = useState(false);

  const step: SourceNextStep = detail
    ? nextStepFor(
        activities,
        {
          sourceKind: 'curated',
          remoteId: detail.key,
          contentHash: detail.contentHash,
        },
        null,
      )
    : { kind: 'add' };

  const install = (): void => {
    if (!detail) return;
    if (step.kind === 'update') {
      setUpdateOpen(true);
      return;
    }
    useNavigationStore
      .getState()
      .openShareInstall(curatedAutomationInstallLink(detail), 'in-app');
  };
  const modals = detail ? (
    <>
      {updateOpen && step.kind === 'update' && (
        <InstallSharedAutomationModal
          onCreateProject={requestAutomationProjectCreation}
          detail={toCuratedAutomationInstallSource(detail)}
          source="curated"
          staleActivities={step.staleActivities}
          workspaces={workspaces}
          onClose={(): void => setUpdateOpen(false)}
          onDone={(): void => {
            // The automations store refreshes through the service broadcast;
            // the next step recomputes from the updated activities.
          }}
        />
      )}
      {anotherCopyOpen && (
        <InstallSharedAutomationModal
          onCreateProject={requestAutomationProjectCreation}
          detail={toCuratedAutomationInstallSource(detail)}
          source="curated"
          // An independent new copy: never an update of an existing one.
          staleActivities={[]}
          workspaces={workspaces}
          onClose={(): void => setAnotherCopyOpen(false)}
          onDone={(): void => {
            // The automations store refreshes through the service broadcast.
          }}
        />
      )}
    </>
  ) : null;

  if (layout) {
    // The page keeps its layout while the entry loads or fails: the header
    // from the tile, the state in What it does.
    const ready = detail && !loading ? detail : null;
    return (
      <>
        <AutomationReadDetail
          dataTestId="curated-automation-marketplace-detail"
          name={layout.entry.name}
          description={layout.entry.description}
          logo={layout.logo}
          publisher={layout.publisher}
          actions={
            ready ? (
              <SourceLayoutActions
                step={step}
                onInstall={install}
                onInstallAnotherCopy={() => setAnotherCopyOpen(true)}
                onOpenInAutomations={onOpenInAutomations}
                activities={activities}
                source={layout.entry}
                workflowActions={workflowActions}
                onToggleError={setToggleError}
              />
            ) : undefined
          }
          actionsNotice={toggleNotice(toggleError)}
          source={customizeWorkflowSource(layout.entry)}
          {...(ready
            ? {
                schedule: {
                  value:
                    describeFiveFieldCron(ready.cronExpression) ??
                    ready.cronExpression,
                  suggested: true,
                },
                definition: ready.automation,
              }
            : { contentsNotice: sourceContentsNotice(error, onRetry) })}
          version={
            ready && step.kind === 'update' ? (
              <DetailVersionUpdateFact
                name={layout.entry.name}
                testId="automation-catalog-update"
                update={{ run: install }}
              />
            ) : undefined
          }
        />
        {modals}
      </>
    );
  }

  if (error !== null) {
    return (
      <Notice
        errorSource="curated-automation-load"
        intent="destructive"
        title="Couldn't load this automation."
        data-testid="automation-source-error"
        actions={<NoticeButton onClick={onRetry}>Try again</NoticeButton>}
      >
        {error}
      </Notice>
    );
  }
  if (!detail || loading) {
    return (
      <DelayedLoadingPlaceholder slowNote="Still loading automation…">
        <CuratedAutomationDetailSkeleton name={name} />
      </DelayedLoadingPlaceholder>
    );
  }

  const schedule =
    describeFiveFieldCron(detail.cronExpression) ?? detail.cronExpression;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-6"
      data-testid="curated-automation-marketplace-detail"
    >
      <div className="flex items-start gap-3">
        <McpServerLogo
          size={40}
          fallback="monogram"
          name={detail.name || name}
          shape="circle"
          fit="contain"
        />
        <div className="min-w-0 flex-1">
          <Heading level={2} variant="section">
            {detail.name}
          </Heading>
          <p className="mt-0.5 text-xs fg-secondary">
            {detail.authorName ? `Curated · ${detail.authorName}` : 'Curated'}
          </p>
        </div>
        <SourceAction
          step={step}
          onInstall={install}
          onInstallAnotherCopy={() => setAnotherCopyOpen(true)}
          onOpenInAutomations={onOpenInAutomations}
        />
      </div>

      {step.kind === 'update' && (
        <Notice
          intent="neutral"
          role="none"
          title="Update available."
          data-testid="automation-catalog-update-available"
        >
          This automation has changed since you added it. Updating keeps your
          project and inputs.
        </Notice>
      )}

      {detail.shortDescription && (
        <p className="text-s fg-secondary">{detail.shortDescription}</p>
      )}

      <SettingsRowsSection title="Details">
        <SettingsRowsGroup>
          <SettingsRowsRow
            fact
            label="Schedule"
            control={
              <SettingsRowsValue dataTestId="curated-automation-schedule">
                {schedule}
              </SettingsRowsValue>
            }
          />
        </SettingsRowsGroup>
      </SettingsRowsSection>

      <AutomationDefinitionSummary automation={detail.automation} />

      {modals}
    </div>
  );
}
