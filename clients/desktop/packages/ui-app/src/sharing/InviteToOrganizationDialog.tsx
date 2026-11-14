'use client';

import { type JSX, useEffect, useRef, useState } from 'react';
import {
  createPersonalOrganizationUpgradeStore,
  createBrowserUpgradeRecovery,
  hasPendingProjects,
  type AdditionalOrganizationInvite,
  type PersonalOrganizationUpgradePort,
  type PersonalOrganizationUpgradeRecovery,
  type PersonalOrganizationUpgradeState,
} from '@canopy/app-state/personal-organization-upgrade';
import type {
  PersonalOrganizationPromotionOutcome,
  PersonalProject,
  PersonalProjectOperation,
} from '@canopy/protocol/organizations';
import {
  Stack,
  Button,
  EmailRecipientInput,
  isEmailRecipientValid,
  Notice,
  NoticeButton,
  ProgressChecklist,
  type ProgressChecklistStep,
} from '@canopy/ui-shared/components';
import { CreateTeamStep } from './CreateTeamStep';
import { ShareDialogFrame } from './ShareDialogFrame';
import {
  CONTEXT_SWITCH_PENDING,
  TEAM_UPGRADE_COPY as COPY,
  conversionFailureMessage,
  inviteFailureMessage,
  inviteOutcomeMessage,
  invitePendingMessage,
  invitingLabel,
  isRetryableOutcome,
  projectOutcomeLabel,
  projectsStepLabel,
  promotionFailureMessage,
  teamStepLabel,
} from './personal-organization-upgrade-copy';

/** Who the invite goes into: an existing team, or Personal turned into one. */
export type InviteToOrganizationTarget =
  | {
      readonly kind: 'team';
      readonly organizationId: string;
      readonly organizationName: string;
    }
  | {
      readonly kind: 'personal';
      readonly personalOrganizationId: string;
    };

export interface InviteToOrganizationDialogProps {
  /** Offer another setup from the Settings/sidebar checklist. */
  readonly readRestartPersonalOrganizationId?: (
    signal: AbortSignal,
  ) => Promise<string | null>;
  readonly contextOrganizationId?: string;
  readonly target: InviteToOrganizationTarget;
  /** The host's transport for these operations. */
  readonly port: PersonalOrganizationUpgradePort;
  /** Binds the run and its recovery record to the signed-in account. */
  readonly accountKey: string;
  readonly recovery?: PersonalOrganizationUpgradeRecovery;
  /**
   * Personal only. `true` for Invite a teammate (the email leads), `false`
   * for Create a team (the email is optional).
   */
  readonly inviteRequired?: boolean;
  /**
   * Runs once after a committed promotion so the host reloads its account and
   * selects the team. A failure here never reads as a failed promotion.
   */
  readonly onPromoted?: (
    outcome: PersonalOrganizationPromotionOutcome,
  ) => void | Promise<void>;
  /**
   * Opens the team's settings (desktop through an authenticated web handoff,
   * web by navigating). When absent the dialog offers Done once something
   * landed instead.
   */
  readonly onManage?: (organizationId: string) => void;
  readonly onClose: () => void;
  readonly ownerDocument?: Document;
  /** Store timing, for tests. */
  readonly pollIntervalMs?: number;
}

const P = 'invite-to-organization';
const RESTART_READ_TIMEOUT_MS = 10_000;

function useUpgradeStore(
  props: InviteToOrganizationDialogProps,
  freshSetup: boolean,
): ReturnType<typeof createPersonalOrganizationUpgradeStore> {
  const lifetime = useRef({ active: true });
  const personalOrganizationId =
    props.target.kind === 'personal'
      ? props.target.personalOrganizationId
      : props.target.organizationId;
  const [store] = useState(() =>
    createPersonalOrganizationUpgradeStore({
      port: {
        ...props.port,
        isCurrent: () =>
          lifetime.current.active && (props.port.isCurrent?.() ?? true),
      },
      accountKey: props.accountKey,
      personalOrganizationId,
      // An existing team only sends invitations, each idempotent per address,
      // so it keeps no recovery record.
      ...(props.target.kind === 'team'
        ? { existingOrganizationId: props.target.organizationId }
        : {
            recovery:
              props.recovery ?? createBrowserUpgradeRecovery(props.accountKey),
          }),
      ...(props.pollIntervalMs !== undefined
        ? { pollIntervalMs: props.pollIntervalMs }
        : {}),
    }),
  );
  const isPersonal = props.target.kind === 'personal';
  useEffect(() => {
    lifetime.current.active = true;
    const ready = freshSetup ? Promise.resolve() : store.getState().restore();
    const reply = store.getState().captureChecklistReply();
    void ready.then(() => {
      if (isPersonal && reply.isCurrent())
        return store.getState().loadProjects();
    });
    return (): void => {
      lifetime.current.active = false;
      // React replays mount effects in development. Suspend mutations
      // immediately, then dispose only if this was a real unmount.
      queueMicrotask(() => {
        if (!lifetime.current.active) store.getState().dispose();
      });
    };
  }, [freshSetup, isPersonal, store]);
  return store;
}

function projectNames(
  projects: readonly PersonalProject[],
): ReadonlyMap<string, string> {
  return new Map(projects.map((p) => [p.workspaceId, p.name]));
}

type ProjectOutcomeEntry = PersonalProjectOperation['projects'][number];

/** A clean move needs no row; anything else is listed under the projects row. */
function needsProjectRow(project: ProjectOutcomeEntry): boolean {
  return (
    (project.outcome !== 'moved' && project.outcome !== 'pending') ||
    project.refreshWarning === true
  );
}

function canRetryProject(project: ProjectOutcomeEntry): boolean {
  return isRetryableOutcome(project.outcome) || project.refreshWarning === true;
}

function ProjectProblemRow({
  project,
  name,
  team,
}: {
  readonly project: ProjectOutcomeEntry;
  readonly name: string;
  readonly team: string;
}): JSX.Element {
  const missingRepositories =
    project.outcome === 'repositories-not-in-team' &&
    project.reason?.includes(': ')
      ? project.reason.slice(project.reason.indexOf(': ') + 2)
      : null;
  return (
    <li
      className="text-xs fg-secondary"
      data-testid={`${P}-outcome-${project.workspaceId}`}
      data-outcome={project.outcome}
    >
      <span className="fg-primary">{name}</span>
      {': '}
      {project.refreshWarning && project.outcome === 'moved'
        ? 'Moved, but the team’s project list could not refresh'
        : projectOutcomeLabel(project.outcome, team)}
      {missingRepositories !== null && (
        <span className="block">
          Repositories to add: {missingRepositories}
        </span>
      )}
    </li>
  );
}

function ProjectActions({
  state,
  retryable,
  pending,
}: {
  readonly state: PersonalOrganizationUpgradeState;
  readonly retryable: readonly string[];
  readonly pending: boolean;
}): JSX.Element {
  return (
    <div className="flex gap-2">
      {retryable.length > 0 && (
        <NoticeButton
          data-testid={`${P}-retry-projects`}
          onClick={() => void state.retryProjects(retryable)}
        >
          {COPY.retryProjects}
        </NoticeButton>
      )}
      {pending && (
        <NoticeButton
          data-testid={`${P}-check-again`}
          onClick={() => void state.refreshOperation()}
        >
          {COPY.checkAgain}
        </NoticeButton>
      )}
    </div>
  );
}

/** Before the durable operation exists: still moving, or the move never started. */
function projectsStartStep(
  state: PersonalOrganizationUpgradeState,
  team: string,
  count: number,
): ProgressChecklistStep {
  const base = { key: 'projects', testId: `${P}-projects-step` };
  if (state.promotion === null)
    return {
      ...base,
      label: projectsStepLabel(count, team, 'moving'),
      status: 'pending',
    };
  if (state.conversionFailure === null)
    return {
      ...base,
      testId: `${P}-projects-moving`,
      label: projectsStepLabel(count, team, 'moving'),
      status: 'active',
    };
  return {
    ...base,
    label: projectsStepLabel(count, team, 'attention'),
    status: 'error',
    detail: (
      <Stack gap="inline" data-testid={`${P}-projects-failed`}>
        <p className="text-xs fg-secondary">{conversionFailureMessage()}</p>
        <NoticeButton
          className="self-start"
          data-testid={`${P}-retry-projects`}
          onClick={() => void state.retryProjects(state.selection)}
        >
          {COPY.retryProjects}
        </NoticeButton>
      </Stack>
    ),
  };
}

/** The projects row: one line for all of them, with detail only on trouble. */
function projectsStep(
  state: PersonalOrganizationUpgradeState,
  team: string,
  count: number,
): ProgressChecklistStep {
  const operation = state.operation;
  if (state.promotion === null || operation === null)
    return projectsStartStep(state, team, count);
  const names = projectNames(state.projects.items);
  // Clean moves get no row of their own; automation reads them from here.
  const base = {
    key: 'projects',
    testId: `${P}-projects-step`,
    dataAttributes: {
      'data-moved-projects': operation.projects
        .filter((project) => project.outcome === 'moved')
        .map((project) => project.workspaceId)
        .join(' '),
    },
  };
  const problems = operation.projects.filter(needsProjectRow);
  const retryable = problems
    .filter(canRetryProject)
    .map((project) => project.workspaceId);
  const pending = hasPendingProjects(operation);
  const total = operation.projects.length;
  const actions =
    retryable.length > 0 || pending ? (
      <ProjectActions state={state} retryable={retryable} pending={pending} />
    ) : null;
  if (problems.length === 0)
    return {
      ...base,
      label: projectsStepLabel(total, team, pending ? 'moving' : 'moved'),
      status: pending ? 'active' : 'completed',
      ...(actions ? { detail: actions } : {}),
    };
  return {
    ...base,
    label: projectsStepLabel(total, team, 'attention'),
    status: 'error',
    detail: (
      <Stack gap="inline">
        <Stack as="ul" gap="tight" aria-live="polite">
          {problems.map((project) => (
            <ProjectProblemRow
              key={project.workspaceId}
              project={project}
              name={
                project.name ??
                names.get(project.workspaceId) ??
                project.workspaceId
              }
              team={team}
            />
          ))}
        </Stack>
        {actions}
      </Stack>
    ),
  };
}

/** The first invite, sent as part of creating the team. */
function inviteStep(
  state: PersonalOrganizationUpgradeState,
  email: string,
): ProgressChecklistStep {
  const base = { key: 'invite', privateLabel: true };
  const invite = state.invite;
  if (invite.status === 'done' && invite.result !== null)
    return {
      ...base,
      testId: `${P}-invite-outcome`,
      dataAttributes: { 'data-status': invite.result.status },
      label: inviteOutcomeMessage(invite.result, email),
      status: 'completed',
    };
  if (invite.status === 'failed' && invite.failure !== null)
    return {
      ...base,
      testId: `${P}-invite-failed`,
      label: inviteFailureMessage(invite.failure, email),
      status: 'error',
      detail: (
        <NoticeButton onClick={() => void state.retryInvite()}>
          {COPY.retryInvite}
        </NoticeButton>
      ),
    };
  if (invite.status === 'pending')
    return {
      ...base,
      testId: `${P}-invite-pending`,
      label: invitePendingMessage(email),
      status: 'active',
      detail: (
        <NoticeButton onClick={() => void state.reconcileInvite()}>
          {COPY.checkAgain}
        </NoticeButton>
      ),
    };
  return {
    ...base,
    testId: `${P}-invite-sending`,
    label: invitingLabel(email),
    status: invite.status === 'sending' ? 'active' : 'pending',
  };
}

function additionalInviteStep(
  entry: AdditionalOrganizationInvite,
  index: number,
  onRetry: (id: string) => void,
): ProgressChecklistStep {
  const base = {
    key: entry.id,
    privateLabel: true,
    testId: `${P}-more-invite-${String(index)}`,
    dataAttributes: { 'data-status': entry.result?.status ?? entry.status },
  };
  if (entry.status === 'done' && entry.result !== null)
    return {
      ...base,
      label: inviteOutcomeMessage(entry.result, entry.email),
      status: 'completed',
    };
  if (entry.status === 'failed' || entry.status === 'pending')
    return {
      ...base,
      label:
        entry.status === 'failed' && entry.failure !== null
          ? inviteFailureMessage(entry.failure, entry.email)
          : invitePendingMessage(entry.email),
      status: entry.status === 'failed' ? 'error' : 'active',
      detail: (
        <NoticeButton onClick={() => onRetry(entry.id)}>
          {COPY.retryInvite}
        </NoticeButton>
      ),
    };
  return {
    ...base,
    label: invitingLabel(entry.email),
    status: 'active',
  };
}

/** One checklist row per person invited from this dialog, in order. */
function additionalInviteSteps(
  state: PersonalOrganizationUpgradeState,
): ProgressChecklistStep[] {
  return state.additionalInvites.map((entry, index) =>
    additionalInviteStep(entry, index, (id) => void state.retryAnother(id)),
  );
}

/** The email field and Invite button that add one more invite row each. */
function InviteMoreField({
  state,
  label,
  disabled = false,
}: {
  readonly state: PersonalOrganizationUpgradeState;
  readonly label: string;
  readonly disabled?: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const draftValid = !disabled && isEmailRecipientValid(draft);
  const inviteMore = (): void => {
    if (!draftValid) return;
    const next = draft;
    setDraft('');
    void state.inviteAnother(next);
  };
  return (
    <div className="flex items-end gap-2" data-testid={`${P}-invite-more`}>
      <div className="min-w-0 flex-1">
        <EmailRecipientInput
          label={label}
          value={draft}
          onChange={setDraft}
          onSubmit={inviteMore}
          disabled={disabled}
          dataTestId={`${P}-invite-more-email`}
        />
      </div>
      <Button
        variant="secondary"
        size="lg"
        disabled={!draftValid}
        onClick={inviteMore}
        data-testid={`${P}-invite-more-submit`}
      >
        {COPY.inviteMoreSubmit}
      </Button>
    </div>
  );
}

/**
 * After Create team: one checklist row per step (the team, the projects that
 * come along, and each invitation), each spinning until it lands. Trouble on
 * a row keeps its targeted retry and never undoes the team.
 */
function UpgradeChecklist({
  state,
  team,
  email,
  projectCount,
  canInvite,
  contextNote,
  onCheckContext,
}: {
  readonly state: PersonalOrganizationUpgradeState;
  readonly team: string;
  readonly email: string;
  readonly projectCount: number;
  readonly canInvite: boolean;
  readonly contextNote: string | undefined;
  readonly onCheckContext: () => void;
}): JSX.Element {
  const created = state.promotion !== null;
  const steps: ProgressChecklistStep[] = [
    {
      key: 'team',
      testId: created ? `${P}-team-created` : `${P}-team-creating`,
      label: teamStepLabel(team, created),
      status: created ? 'completed' : 'active',
      ...(contextNote
        ? {
            detail: (
              <Stack gap="inline">
                <p className="text-xs fg-secondary">{contextNote}</p>
                <NoticeButton className="self-start" onClick={onCheckContext}>
                  {COPY.checkAgain}
                </NoticeButton>
              </Stack>
            ),
          }
        : {}),
    },
  ];
  if (
    projectCount > 0 ||
    state.operation !== null ||
    state.conversionFailure !== null
  )
    steps.push(projectsStep(state, team, projectCount));
  if (canInvite && email !== '') steps.push(inviteStep(state, email));
  steps.push(...additionalInviteSteps(state));
  // Retired checklists show only row summaries. Row details own the retry controls.
  const visibleSteps = state.retired
    ? steps.map((step) => ({ ...step, detail: null, substeps: [] }))
    : steps;

  return (
    <Stack gap="block" data-testid={`${P}-outcome`}>
      <ProgressChecklist steps={visibleSteps} size="comfortable" />
      {created && canInvite && !state.retired && (
        <InviteMoreField state={state} label={COPY.inviteMoreLabel} />
      )}
    </Stack>
  );
}

/**
 * Invite someone into a team, or, from Personal, create the team first (CAN-3706).
 * Promotion, bringing projects, and the invite run in that order and land
 * independently: project or invite trouble is reported with a targeted retry
 * and never undoes the team. Only promotion and sending lock the dialog;
 * projects still moving can be closed and checked again later.
 */
export function InviteToOrganizationDialog(
  props: InviteToOrganizationDialogProps,
): JSX.Element {
  const [nextPersonalId, setNextPersonalId] = useState<string | null>(null);
  return (
    <InviteToOrganizationRun
      {...props}
      key={nextPersonalId}
      {...(nextPersonalId === null
        ? {}
        : {
            target: {
              kind: 'personal',
              personalOrganizationId: nextPersonalId,
            },
            inviteRequired: false,
          })}
      freshSetup={nextPersonalId !== null}
      openNextSetup={setNextPersonalId}
    />
  );
}

function canCreateAnotherTeam(
  state: PersonalOrganizationUpgradeState,
): boolean {
  const promotion = state.promotion;
  return (
    state.phase === 'finished' &&
    promotion !== null &&
    promotion.contextSwitched &&
    promotion.warnings.length === 0 &&
    state.additionalInvites.every(
      ({ status }) => status === 'done' || status === 'failed',
    )
  );
}

function InviteToOrganizationRun(
  props: InviteToOrganizationDialogProps & {
    readonly freshSetup: boolean;
    readonly openNextSetup: (personalOrganizationId: string) => void;
  },
): JSX.Element {
  const {
    target,
    port,
    inviteRequired = false,
    onPromoted,
    onManage,
    onClose,
  } = props;
  const store = useUpgradeStore(props, props.freshSetup);
  const state = store();
  const [restarting, setRestarting] = useState(false);
  const [restartUnavailable, setRestartUnavailable] = useState(false);
  const restartRequest = useRef<AbortController | null>(null);
  useEffect(() => (): void => restartRequest.current?.abort(), []);
  const createAnotherTeam = async (): Promise<void> => {
    if (
      restartRequest.current ||
      !props.readRestartPersonalOrganizationId ||
      port.isCurrent?.() === false ||
      !canCreateAnotherTeam(store.getState())
    )
      return;
    const request = new AbortController();
    restartRequest.current = request;
    setRestarting(true);
    setRestartUnavailable(false);
    store.getState().acknowledge();
    // The fresh account read belongs to the generation after retirement.
    const reply = store.getState().captureChecklistReply();
    const deadline = setTimeout(() => {
      request.abort();
      restartRequest.current = null;
      setRestarting(false);
      reply.apply(() => setRestartUnavailable(true));
    }, RESTART_READ_TIMEOUT_MS);
    const clearDeadline = (): void => clearTimeout(deadline);
    request.signal.addEventListener('abort', clearDeadline, { once: true });
    try {
      const personalId = await props.readRestartPersonalOrganizationId(
        request.signal,
      );
      if (request.signal.aborted) return;
      reply.apply(() => {
        const current = store.getState();
        if (
          !personalId ||
          personalId === current.promotion?.promotion.organizationId ||
          !canCreateAnotherTeam(current)
        ) {
          setRestartUnavailable(true);
          return;
        }
        props.openNextSetup(personalId);
      });
    } catch {
      if (!request.signal.aborted)
        reply.apply(() => setRestartUnavailable(true));
    } finally {
      clearDeadline();
      request.signal.removeEventListener('abort', clearDeadline);
      if (restartRequest.current === request) {
        restartRequest.current = null;
        if (!request.signal.aborted) setRestarting(false);
      }
    }
  };
  const [criticalWaitExpired, setCriticalWaitExpired] = useState(false);
  const criticalSubmission =
    state.phase === 'promoting' || state.invite.status === 'sending';
  useEffect(() => {
    setCriticalWaitExpired(false);
    if (!criticalSubmission) return;
    const timer = setTimeout(() => setCriticalWaitExpired(true), 20_000);
    return (): void => clearTimeout(timer);
  }, [criticalSubmission]);
  const promotedRef = useRef<string | null>(null);

  const promotion = state.promotion;
  const confirmContext = state.confirmContext;
  useEffect(() => {
    if (props.contextOrganizationId && promotion && !promotion.contextSwitched)
      confirmContext(props.contextOrganizationId);
  }, [props.contextOrganizationId, promotion, confirmContext]);
  useEffect(() => {
    if (promotion === null || onPromoted === undefined) return;
    const id = promotion.promotion.operationId;
    if (promotedRef.current === id) return;
    promotedRef.current = id;
    void Promise.resolve(onPromoted(promotion)).catch(() => {
      // Host refresh is best-effort; the promotion itself is committed.
    });
  }, [onPromoted, promotion]);

  const close = (): void => {
    restartRequest.current?.abort();
    onClose();
  };
  const dismiss = (): void => {
    state.acknowledge();
    close();
  };

  const frame: FrameContext = {
    ownerDocument: props.ownerDocument,
    onDismiss: dismiss,
    criticalSubmission,
    locked: criticalSubmission && !criticalWaitExpired,
    notes: restartUnavailable ? (
      <Notice intent="attention" role="status">
        {COPY.restartUnavailable}
      </Notice>
    ) : criticalSubmission && criticalWaitExpired ? (
      <Notice intent="attention" role="status">
        This is taking longer than expected. You can close this dialog and check
        again later.
      </Notice>
    ) : undefined,
  };

  if (target.kind === 'team')
    return (
      <TeamInviteFrame
        frame={frame}
        state={state}
        port={port}
        organizationId={target.organizationId}
        onManage={onManage}
        onClose={close}
      />
    );
  if (promotion !== null || state.phase === 'promoting')
    return (
      <PersonalChecklistFrame
        frame={frame}
        state={state}
        port={port}
        inviteRequired={inviteRequired}
        onPromoted={onPromoted}
        onCreateAnother={
          props.readRestartPersonalOrganizationId && state.phase === 'finished'
            ? () => void createAnotherTeam()
            : undefined
        }
        restarting={restarting}
        onManage={onManage}
        onClose={close}
      />
    );
  return (
    <PersonalFormFrame
      frame={frame}
      state={state}
      port={port}
      inviteRequired={inviteRequired}
    />
  );
}

/** What every frame of this dialog shares: closing, locking and the slow-wait note. */
interface FrameContext {
  readonly ownerDocument: Document | undefined;
  readonly onDismiss: () => void;
  readonly notes: JSX.Element | undefined;
  /** Promotion or a first invite is in flight. */
  readonly criticalSubmission: boolean;
  /** Critical work still within its bounded wait; close stays disabled. */
  readonly locked: boolean;
}

/**
 * An existing team: only invitations, as the same checklist the Create a team
 * flow ends with. Each send adds a row that spins until it lands.
 */
function TeamInviteFrame({
  frame,
  state,
  port,
  organizationId,
  onManage,
  onClose,
}: {
  readonly frame: FrameContext;
  readonly state: PersonalOrganizationUpgradeState;
  readonly port: PersonalOrganizationUpgradePort;
  readonly organizationId: string;
  readonly onManage: InviteToOrganizationDialogProps['onManage'];
  readonly onClose: () => void;
}): JSX.Element {
  const steps = additionalInviteSteps(state);
  const invited = state.additionalInvites.some(
    (entry) => entry.status === 'done',
  );
  return (
    <ShareDialogFrame
      title={COPY.inviteTeamTitle}
      testIdPrefix={P}
      ownerDocument={frame.ownerDocument}
      onDismiss={frame.onDismiss}
      notes={frame.notes}
      lifecycle={{
        status: 'idle',
        committed: invited && onManage === undefined,
      }}
      content={
        <Stack gap="block" data-testid={`${P}-outcome`}>
          {steps.length > 0 && (
            <ProgressChecklist steps={steps} size="comfortable" />
          )}
          <InviteMoreField
            state={state}
            label={steps.length > 0 ? COPY.inviteMoreLabel : COPY.inviteLabel}
            disabled={!port.canInvite}
          />
        </Stack>
      }
      showSubmit={onManage !== undefined}
      submitLabel={COPY.manage}
      sharingLabel={COPY.manage}
      submitTestId={`${P}-manage`}
      onSubmit={() => {
        state.acknowledge();
        onManage?.(organizationId);
        onClose();
      }}
    />
  );
}

/** Whether the Personal form has everything it needs to create the team. */
function canCreateTeam(
  state: PersonalOrganizationUpgradeState,
  port: PersonalOrganizationUpgradePort,
  inviteRequired: boolean,
): boolean {
  const email = state.inviteEmail.trim();
  const projectChoicesSettled =
    !port.canBringProjects ||
    state.withoutProjects ||
    state.projects.status === 'ready';
  const emailAccepted = inviteRequired
    ? port.canInvite && isEmailRecipientValid(email)
    : email === '' || isEmailRecipientValid(email);
  return (
    port.canPromote &&
    state.name.trim() !== '' &&
    projectChoicesSettled &&
    emailAccepted
  );
}

function PersonalFormFrame({
  frame,
  state,
  port,
  inviteRequired,
}: {
  readonly frame: FrameContext;
  readonly state: PersonalOrganizationUpgradeState;
  readonly port: PersonalOrganizationUpgradePort;
  readonly inviteRequired: boolean;
}): JSX.Element {
  const inviting = state.inviteEmail.trim() !== '' && port.canInvite;
  return (
    <ShareDialogFrame
      title={inviteRequired ? COPY.inviteTitle : COPY.createTitle}
      subtitle={COPY.description}
      testIdPrefix={P}
      ownerDocument={frame.ownerDocument}
      onDismiss={frame.onDismiss}
      notes={frame.notes}
      lifecycle={{
        status: state.promotionFailure !== null ? 'error' : 'idle',
        committed: state.invite.status === 'done',
      }}
      content={
        <Stack gap="group">
          <CreateTeamStep
            name={state.name}
            onNameChange={state.setName}
            canBringProjects={port.canBringProjects}
            projects={state.projects}
            selection={state.selection}
            onProjectSelected={state.setProjectSelected}
            withoutProjects={state.withoutProjects}
            onRetryProjects={() => void state.loadProjects()}
            onContinueWithoutProjects={state.continueWithoutProjects}
            testIdPrefix={P}
          />
          {port.canInvite && (
            <EmailRecipientInput
              label={
                inviteRequired ? COPY.inviteLabel : COPY.inviteOptionalLabel
              }
              value={state.inviteEmail}
              onChange={state.setInviteEmail}
              dataTestId={`${P}-email`}
            />
          )}
        </Stack>
      }
      {...(state.promotionFailure !== null
        ? { errorMessage: promotionFailureMessage(state.promotionFailure) }
        : {})}
      submitLabel={inviting ? COPY.createAndInviteSubmit : COPY.createSubmit}
      sharingLabel={COPY.creating}
      submitDisabled={
        frame.criticalSubmission || !canCreateTeam(state, port, inviteRequired)
      }
      onSubmit={() => void state.submit({ inviteRequired })}
    />
  );
}

function PersonalChecklistFrame({
  frame,
  state,
  port,
  inviteRequired,
  onPromoted,
  onCreateAnother,
  restarting,
  onManage,
  onClose,
}: {
  readonly frame: FrameContext;
  readonly state: PersonalOrganizationUpgradeState;
  readonly port: PersonalOrganizationUpgradePort;
  readonly inviteRequired: boolean;
  readonly onPromoted: InviteToOrganizationDialogProps['onPromoted'];
  readonly onCreateAnother: (() => void) | undefined;
  readonly restarting: boolean;
  readonly onManage: InviteToOrganizationDialogProps['onManage'];
  readonly onClose: () => void;
}): JSX.Element {
  const promotion = state.promotion;
  const contextNote =
    promotion !== null &&
    (!promotion.contextSwitched || promotion.warnings.length > 0)
      ? CONTEXT_SWITCH_PENDING
      : undefined;
  const projectCount =
    state.operation?.projects.length ??
    (port.canBringProjects && !state.withoutProjects
      ? state.selection.length
      : 0);
  const organizationId = promotion?.promotion.organizationId ?? null;
  const manage =
    !state.retired && onManage !== undefined && organizationId !== null
      ? (): void => {
          state.acknowledge();
          onManage(organizationId);
          onClose();
        }
      : undefined;
  return (
    <ShareDialogFrame
      title={inviteRequired ? COPY.inviteTitle : COPY.createTitle}
      testIdPrefix={P}
      ownerDocument={frame.ownerDocument}
      onDismiss={frame.onDismiss}
      notes={frame.notes}
      busy={frame.locked}
      lifecycle={{
        status: 'idle',
        committed: promotion !== null && manage === undefined,
      }}
      content={
        <UpgradeChecklist
          state={state}
          team={promotion?.promotion.name ?? state.name.trim()}
          email={state.inviteEmail.trim()}
          projectCount={projectCount}
          canInvite={port.canInvite}
          contextNote={contextNote}
          onCheckContext={() => {
            if (promotion === null) return;
            const reply = state.captureChecklistReply();
            void state
              .refreshPromotion()
              .then(() => reply.apply(() => onPromoted?.(promotion)))
              .catch(() => {
                // The host refresh is best-effort.
              });
          }}
        />
      }
      {...(onCreateAnother
        ? {
            secondaryAction: {
              label: COPY.createAnotherTeam,
              onClick: onCreateAnother,
              disabled:
                restarting || frame.locked || !canCreateAnotherTeam(state),
              testId: `${P}-create-another`,
            },
          }
        : {})}
      showSubmit={onManage !== undefined && !state.retired}
      submitLabel={COPY.manage}
      sharingLabel={COPY.manage}
      submitTestId={`${P}-manage`}
      submitDisabled={manage === undefined || frame.locked}
      onSubmit={() => manage?.()}
    />
  );
}
