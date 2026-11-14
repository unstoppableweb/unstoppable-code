'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import type {
  RepoRuleFlag,
  RepoRuleKind,
  RepoRuleProposal,
  RepoRuleSkipped,
  RepoRulesScanResponse,
  RepoRulesStatus,
} from '@canopy/protocol/repo-rules';
import type { CanopyClient } from '@canopy/app-core';
import { useCanopyClient } from '@canopy/app-state';
import {
  Stack,
  Button,
  DelayedLoadingPlaceholder,
  Disclosure,
  ErrorBanner,
  LoadingSpinner,
  Notice,
  Skeleton,
  ToggleSwitch,
  Heading,
} from '@canopy/ui-shared/components';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import { CapabilityGate } from '../capability/CapabilityGate';
import { ruleCountLabel } from './repoRulesCopy';
import { Surface } from '@canopy/ui-shared/components';

/**
 * Review flow for using a project's Cursor rules in chats (CAN-2053): choose a
 * workspace when the entry point has none, then scan it and review each rule.
 * The scan starts as soon as a workspace is known (CAN-4675); it is read-only,
 * leaving repository files and the saved policy unchanged. Rules turn on only
 * through an explicit `repoRules.apply`. Hosts supply the flow through the
 * `repoRules.*` client operations and the `repoRulesImport` capability; a host
 * without it renders the unsupported state and makes no client calls.
 */
export interface RepoRulesReviewWorkspace {
  readonly id: string;
  readonly name: string;
}

/**
 * An offered project's latest decision (CAN-4980): a save that left rules on
 * or off, or an explicit Skip.
 */
export type RepoRulesProjectDecision = 'on' | 'off' | 'skipped';

/** Whether a multi-project offer keeps choosing or closes after a decision. */
export type RepoRulesOfferOutcome = 'continue' | 'close';

/**
 * A multi-project offer (CAN-4980). The host owns the members, their
 * decisions, and what resolving them completes; the review lists only the
 * offered projects, returns to the chooser after each save, and lets the user
 * skip an undecided one.
 */
export interface RepoRulesReviewOffer {
  /** The one authoritative decision for each offered project. */
  readonly decisions: Readonly<
    Partial<Record<string, RepoRulesProjectDecision>>
  >;
  /**
   * Records a decision and says whether projects remain. Called for a save
   * before `onApplied`, and for Skip; opening, cancelling, and failures are
   * not decisions.
   */
  readonly onDecide: (
    workspaceId: string,
    decision: RepoRulesProjectDecision,
  ) => RepoRulesOfferOutcome;
}

export interface RepoRulesReviewProps {
  /** Product name for copy, from the host's brand helper. */
  readonly appName: string;
  /** Code workspaces the user can choose from. */
  readonly workspaces: readonly RepoRulesReviewWorkspace[];
  /**
   * The workspace to review. Without it the user chooses one; the flow never
   * picks one from collection order.
   */
  readonly initialWorkspaceId?: string;
  readonly onClose: () => void;
  /** Runs the multi-project offer flow instead of closing after a save. */
  readonly offer?: RepoRulesReviewOffer;
  /**
   * Called after a successful save, before `onClose` or, in an offer with
   * projects left, before returning to the chooser.
   */
  readonly onApplied?: (result: {
    readonly workspaceId: string;
    readonly status: RepoRulesStatus;
    /** Selected rules submitted by this save; zero when rules are off. */
    readonly ruleCount: number;
  }) => void;
}

type Phase =
  | { readonly kind: 'choose' }
  | { readonly kind: 'scanning' }
  | { readonly kind: 'scan-error'; readonly message: string }
  | { readonly kind: 'review'; readonly scan: RepoRulesScanResponse };

type ScanState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly scan: RepoRulesScanResponse }
  | { readonly kind: 'error'; readonly message: string };

type StatusState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly status: RepoRulesStatus }
  | { readonly kind: 'error' };

type PreviewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly body: string }
  | { readonly kind: 'error'; readonly message: string };

/** Previews are for reading, not archiving: keep the DOM bounded. */
const PREVIEW_CHAR_LIMIT = 20_000;

const KIND_LABELS: Record<RepoRuleKind, string> = {
  always: 'Always',
  'legacy-cursorrules': 'Always',
  auto: 'Matching files',
  'agent-requested': 'When relevant',
  manual: 'When mentioned',
};

const KIND_DESCRIPTIONS: Record<RepoRuleKind, string> = {
  always: 'Added to every new chat.',
  'legacy-cursorrules': 'Legacy root rules file, added to every new chat.',
  auto: 'The agent reads it before working on matching files.',
  'agent-requested': 'The agent reads it when the description fits the task.',
  manual: 'The agent reads it only when you mention it.',
};

const FLAG_LABELS: Record<RepoRuleFlag, string> = {
  duplicate: 'Repeats AGENTS.md or CLAUDE.md',
  'malformed-frontmatter': "Header couldn't be read",
  'unsupported-frontmatter': 'Unknown header fields ignored',
  'missing-file-reference': 'References a missing file',
  'unsupported-glob': 'Unsupported file pattern',
};

const SKIP_REASONS: Record<RepoRuleSkipped['reason'], string> = {
  unavailable: "Couldn't be read",
  'unsafe-path': 'Points outside the repository',
  'too-large': 'Larger than 64 KB',
  changed: 'Changed during the scan',
  limit: 'Over the 200-rule limit',
  'unsupported-git': "Repository files couldn't be listed",
};

const DIAGNOSTIC_MESSAGES: Record<
  NonNullable<RepoRulesStatus['diagnostic']>,
  string | null
> = {
  missing: null,
  invalid:
    "Saved Cursor rule settings couldn't be read, so rules are off. Review them to turn them on again.",
  'unsupported-version':
    'Saved Cursor rule settings came from a newer version, so rules are off.',
  unavailable: "This project's checkout is unavailable.",
};

const DECISION_LABELS: Record<RepoRulesProjectDecision, string> = {
  on: 'Rules on',
  off: 'Rules off',
  skipped: 'Skipped',
};

const NEW_CHATS_NOTE =
  'Applies to new chats. Open chats keep their current rules.';

const SCAN_ERROR_FALLBACK = "Couldn't scan this project's rules.";

function activationKind(rule: RepoRuleProposal): RepoRuleKind {
  return rule.kind === 'auto' && rule.flags.includes('unsupported-glob')
    ? 'manual'
    : rule.kind;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function needsRescan(message: string): boolean {
  return /scan again/i.test(message);
}

/** Unsupported state shown where the host can't read local repositories. */
function RepoRulesUnsupported({
  onClose,
}: {
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <Stack gap="group" data-testid="repo-rules-unsupported">
      <Notice intent="neutral" title="Cursor rules need the desktop app">
        Reviewing Cursor rules reads files in your local checkout. Open this
        project in the desktop app to turn them on.
      </Notice>
      <div className="flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Stack>
  );
}

export function RepoRulesReview(props: RepoRulesReviewProps): JSX.Element {
  return (
    <CapabilityGate
      when={(capabilities) => capabilities.repoRulesImport === true}
      fallback={<RepoRulesUnsupported onClose={props.onClose} />}
    >
      <RepoRulesReviewFlow
        key={props.initialWorkspaceId ?? 'choose'}
        {...props}
      />
    </CapabilityGate>
  );
}

/**
 * The automatic scan and saved-status request for one workspace session. It
 * outlives a Strict Mode effect replay so the replayed effect subscribes to
 * the same requests instead of issuing duplicates.
 */
interface AutoScanRequest {
  readonly client: CanopyClient;
  readonly workspaceId: string;
  readonly session: number;
  readonly attempt: number;
  readonly scan: Promise<RepoRulesScanResponse>;
  readonly status: Promise<RepoRulesStatus>;
}

function RepoRulesReviewFlow({
  appName,
  workspaces,
  initialWorkspaceId,
  onClose,
  offer,
  onApplied,
}: RepoRulesReviewProps): JSX.Element {
  const client = useCanopyClient();
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    initialWorkspaceId ?? null,
  );
  // Bumps on every project choice, so returning to the same project still
  // starts a fresh scan and ignores responses from the earlier visit.
  const [session, setSession] = useState(0);
  const [scanState, setScanState] = useState<ScanState>({ kind: 'loading' });
  const [statusState, setStatusState] = useState<StatusState>({
    kind: 'loading',
  });
  // Local selection edits, keyed by rule id. They survive a failed save and
  // a rescan so the user doesn't lose their choices.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  // The offer decision just made, announced on the chooser.
  const [decided, setDecided] = useState<{
    readonly workspaceId: string;
    readonly decision: RepoRulesProjectDecision;
  } | null>(null);
  // Bumps on workspace change and unmount so late responses are ignored.
  const generation = useRef(0);
  const applyingRef = useRef(false);
  const decidingRef = useRef(false);
  const callbacks = useRef({ offer, onApplied, onClose });
  useEffect(() => {
    callbacks.current = { offer, onApplied, onClose };
    decidingRef.current = false;
  }, [offer, onApplied, onClose]);
  // Bumps on every scan attempt so only the newest one is shown.
  const scanAttempt = useRef(0);
  const autoScan = useRef<AutoScanRequest | null>(null);
  const previewRequests = useRef<Record<string, number>>({});
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const nextSkipRef = useRef<HTMLButtonElement | null>(null);

  const workspace = workspaces.find((entry) => entry.id === workspaceId);
  const workspaceName = workspace?.name ?? 'this project';

  useEffect(() => {
    const responses = generation;
    return (): void => {
      responses.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!workspaceId) {
      autoScan.current = null;
      return;
    }
    let request = autoScan.current;
    if (
      !request ||
      request.client !== client ||
      request.workspaceId !== workspaceId ||
      request.session !== session
    ) {
      scanAttempt.current += 1;
      request = {
        client,
        workspaceId,
        session,
        attempt: scanAttempt.current,
        scan: client.query('repoRules.scan', { workspaceId }),
        status: client.query('repoRules.status', { workspaceId }),
      };
      autoScan.current = request;
    }
    const { attempt } = request;
    let active = true;
    request.status.then(
      (status) => {
        if (active) setStatusState({ kind: 'ready', status });
      },
      () => {
        if (active) setStatusState({ kind: 'error' });
      },
    );
    request.scan.then(
      (result) => {
        if (active && scanAttempt.current === attempt)
          setScanState({ kind: 'ready', scan: result });
      },
      (error: unknown) => {
        if (active && scanAttempt.current === attempt)
          setScanState({
            kind: 'error',
            message: errorMessage(error, SCAN_ERROR_FALLBACK),
          });
      },
    );
    return (): void => {
      active = false;
    };
  }, [client, workspaceId, session]);

  // A finished scan waits for the saved status so the primary action never
  // flips from "Turn on" to "Save"; a failed scan shows right away.
  const phase: Phase = !workspaceId
    ? { kind: 'choose' }
    : scanState.kind === 'error'
      ? { kind: 'scan-error', message: scanState.message }
      : scanState.kind === 'ready' && statusState.kind !== 'loading'
        ? { kind: 'review', scan: scanState.scan }
        : { kind: 'scanning' };

  useEffect(() => {
    headingRef.current?.focus();
  }, [phase.kind]);
  useEffect(() => {
    if (phase.kind === 'choose' && decided?.decision === 'skipped')
      nextSkipRef.current?.focus();
  }, [phase.kind, decided]);

  const resetWorkspace = useCallback((nextWorkspaceId: string | null): void => {
    generation.current += 1;
    applyingRef.current = false;
    setApplying(false);
    scanAttempt.current += 1;
    setWorkspaceId(nextWorkspaceId);
    setSession((value) => value + 1);
    setScanState({ kind: 'loading' });
    setStatusState({ kind: 'loading' });
    setOverrides({});
    setPreviews({});
    setApplyError(null);
  }, []);

  useEffect(() => {
    if (offer && workspaceId && !workspace) resetWorkspace(null);
  }, [offer, workspaceId, workspace, resetWorkspace]);

  const rescan = useCallback((): void => {
    if (!workspaceId) return;
    const attempt = ++scanAttempt.current;
    const current = generation.current;
    setApplyError(null);
    setPreviews({});
    setScanState({ kind: 'loading' });
    client
      .query('repoRules.scan', { workspaceId })
      .then((result) => {
        if (generation.current === current && scanAttempt.current === attempt)
          setScanState({ kind: 'ready', scan: result });
      })
      .catch((error: unknown) => {
        if (generation.current === current && scanAttempt.current === attempt)
          setScanState({
            kind: 'error',
            message: errorMessage(error, SCAN_ERROR_FALLBACK),
          });
      });
  }, [client, workspaceId]);

  const apply = (
    request:
      | { readonly enabled: false }
      | { readonly enabled: true; readonly scan: RepoRulesScanResponse },
  ): void => {
    if (!workspaceId || applyingRef.current || decidingRef.current) return;
    const current = generation.current;
    applyingRef.current = true;
    setApplying(true);
    setApplyError(null);
    // The result reports what this request submitted, not the selection or
    // workspace when the response arrives.
    const selectedRuleCount = request.enabled
      ? request.scan.proposals.filter(
          (rule) => overrides[rule.id] ?? rule.selected,
        ).length
      : 0;
    const args = request.enabled
      ? {
          workspaceId,
          enabled: true,
          scanId: request.scan.scanId,
          disabledRuleIds: request.scan.proposals
            .filter((rule) => !(overrides[rule.id] ?? rule.selected))
            .map((rule) => rule.id),
        }
      : { workspaceId, enabled: false };
    client
      .command('repoRules.apply', args)
      .then((status) => {
        if (generation.current !== current) return;
        applyingRef.current = false;
        setApplying(false);
        const decision = status.enabled ? 'on' : 'off';
        const latest = callbacks.current;
        const outcome = latest.offer?.onDecide(workspaceId, decision);
        latest.onApplied?.({
          workspaceId,
          status,
          ruleCount: status.enabled ? selectedRuleCount : 0,
        });
        if (outcome !== 'continue') {
          latest.onClose();
          return;
        }
        setDecided({ workspaceId, decision });
        resetWorkspace(null);
      })
      .catch((error: unknown) => {
        if (generation.current !== current) return;
        applyingRef.current = false;
        setApplying(false);
        setApplyError(
          errorMessage(error, "Couldn't save your Cursor rule settings."),
        );
      });
  };

  const skip = (skippedId: string): void => {
    if (
      !offer ||
      applyingRef.current ||
      decidingRef.current ||
      offer.decisions[skippedId] !== undefined
    )
      return;
    decidingRef.current = true;
    if (offer.onDecide(skippedId, 'skipped') === 'close') {
      onClose();
      return;
    }
    setDecided({ workspaceId: skippedId, decision: 'skipped' });
    // Focus moves to the next remaining Skip after its new row renders.
  };

  const togglePreview = (ruleId: string, scanId: string): void => {
    if (!workspaceId) return;
    const previewRequest = (previewRequests.current[ruleId] ?? 0) + 1;
    previewRequests.current[ruleId] = previewRequest;
    if (previews[ruleId]) {
      setPreviews((prev) => {
        const next = { ...prev };
        delete next[ruleId];
        return next;
      });
      return;
    }
    const current = generation.current;
    const currentScan = scanAttempt.current;
    setPreviews((prev) => ({ ...prev, [ruleId]: { kind: 'loading' } }));
    client
      .query('repoRules.preview', { workspaceId, scanId, ruleId })
      .then(({ body }) => {
        if (
          generation.current !== current ||
          scanAttempt.current !== currentScan ||
          previewRequests.current[ruleId] !== previewRequest
        )
          return;
        setPreviews((prev) =>
          prev[ruleId] ? { ...prev, [ruleId]: { kind: 'ready', body } } : prev,
        );
      })
      .catch((error: unknown) => {
        if (
          generation.current !== current ||
          scanAttempt.current !== currentScan ||
          previewRequests.current[ruleId] !== previewRequest
        )
          return;
        setPreviews((prev) =>
          prev[ruleId]
            ? {
                ...prev,
                [ruleId]: {
                  kind: 'error',
                  message: errorMessage(error, "Couldn't load this rule."),
                },
              }
            : prev,
        );
      });
  };

  const status = statusState.kind === 'ready' ? statusState.status : null;
  const enabled = status?.enabled === true;
  const diagnostic = status?.diagnostic
    ? DIAGNOSTIC_MESSAGES[status.diagnostic]
    : null;

  const turnOffButton = enabled ? (
    <Button
      variant="secondary"
      disabled={applying}
      onClick={(): void => apply({ enabled: false })}
      data-testid="repo-rules-turn-off"
    >
      Turn off Cursor rules
    </Button>
  ) : null;

  let announcement: ReactNode = '';
  let body: ReactNode;
  switch (phase.kind) {
    case 'choose': {
      const decidedName = decided
        ? workspaces.find((entry) => entry.id === decided.workspaceId)?.name
        : undefined;
      if (decided && decidedName !== undefined)
        announcement = (
          <>
            {decided.decision === 'skipped'
              ? 'Skipped'
              : `${DECISION_LABELS[decided.decision]} for`}{' '}
            <span className={REPLAY_MASK_CLASS}>{decidedName}</span>
          </>
        );
      body = (
        <ChooseWorkspace
          headingRef={headingRef}
          nextSkipRef={nextSkipRef}
          workspaces={workspaces}
          offer={offer}
          onChoose={(nextWorkspaceId): void => {
            setDecided(null);
            resetWorkspace(nextWorkspaceId);
          }}
          onSkip={skip}
          onClose={onClose}
        />
      );
      break;
    }
    case 'scanning':
      announcement = (
        <>
          Scanning Cursor rules in{' '}
          <span className={REPLAY_MASK_CLASS}>{workspaceName}</span>
        </>
      );
      body = (
        <Stack as="section" gap="group" data-testid="repo-rules-scanning">
          <Heading level={3} variant="title" ref={headingRef} tabIndex={-1}>
            Scanning Cursor rules…
          </Heading>
          <div>
            <DelayedLoadingPlaceholder slowNote="Still scanning Cursor rules…">
              <Skeleton
                loading
                label="Scanning Cursor rules"
                testId="repo-rules-scanning-skeleton"
              >
                <Surface variant="outline">
                  <ul className="divide-y">
                    {SAMPLE_RULES.map((rule) => (
                      <RuleRow
                        key={rule.id}
                        rule={rule}
                        selected
                        preview={null}
                        disabled={false}
                        onToggle={noop}
                        onPreview={noop}
                      />
                    ))}
                  </ul>
                </Surface>
              </Skeleton>
            </DelayedLoadingPlaceholder>
          </div>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </Stack>
      );
      break;
    case 'scan-error':
      announcement = phase.message;
      body = (
        <Stack as="section" gap="group" data-testid="repo-rules-scan-error">
          <Heading level={3} variant="section" ref={headingRef} tabIndex={-1}>
            Couldn&apos;t scan Cursor rules
          </Heading>
          <ErrorBanner
            errorSource="repo-rules-review-flow-phase"
            className=""
            error={phase.message}
          />
          {applyError ? (
            <ErrorBanner
              errorSource="repo-rules-review-flow-apply"
              className=""
              error={applyError}
            />
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {turnOffButton}
            <Button variant="primary" onClick={rescan}>
              Try again
            </Button>
          </div>
        </Stack>
      );
      break;
    case 'review': {
      const { scan: result } = phase;
      const selectedCount = result.proposals.filter(
        (rule) => overrides[rule.id] ?? rule.selected,
      ).length;
      announcement = `Found ${ruleCountLabel(result.proposals.length)}`;
      body = (
        <ReviewStep
          headingRef={headingRef}
          scan={result}
          appName={appName}
          workspaceName={workspaceName}
          status={
            <StatusSummary
              statusState={statusState}
              diagnostic={diagnostic}
              disabledCount={status?.disabledRuleIds.length ?? 0}
            />
          }
          statusDiagnostic={diagnostic}
          overrides={overrides}
          previews={previews}
          onToggle={(ruleId, next): void =>
            setOverrides((prev) => ({ ...prev, [ruleId]: next }))
          }
          onPreview={(ruleId): void => togglePreview(ruleId, result.scanId)}
          disabled={applying}
          footer={
            <>
              {applyError ? (
                <ErrorBanner
                  errorSource="repo-rules-review-flow-apply"
                  className=""
                  error={applyError}
                  blockMessageFromReplay
                />
              ) : null}
              <p className="text-xs fg-tertiary">{NEW_CHATS_NOTE}</p>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="ghost" disabled={applying} onClick={onClose}>
                  Cancel
                </Button>
                {applyError && needsRescan(applyError) ? (
                  <Button
                    disabled={applying}
                    onClick={rescan}
                    data-testid="repo-rules-rescan"
                  >
                    Scan again
                  </Button>
                ) : null}
                {turnOffButton}
                {result.proposals.length > 0 ? (
                  <Button
                    variant="primary"
                    disabled={applying || selectedCount === 0}
                    onClick={(): void => apply({ enabled: true, scan: result })}
                    data-testid="repo-rules-apply"
                  >
                    {applying ? <LoadingSpinner decorative /> : null}
                    {enabled
                      ? 'Save'
                      : `Turn on ${ruleCountLabel(selectedCount)}`}
                  </Button>
                ) : (
                  <Button variant="primary" onClick={onClose}>
                    Done
                  </Button>
                )}
              </div>
            </>
          }
        />
      );
      break;
    }
  }

  return (
    <Stack gap="group" data-testid="repo-rules-review">
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {body}
      {workspaceId && initialWorkspaceId === undefined ? (
        <Button
          className="self-start"
          variant="ghost"
          disabled={applying}
          data-testid="repo-rules-change-project"
          onClick={(): void => resetWorkspace(null)}
        >
          Choose another project
        </Button>
      ) : null}
    </Stack>
  );
}

function ChooseWorkspace({
  headingRef,
  nextSkipRef,
  workspaces,
  offer,
  onChoose,
  onSkip,
  onClose,
}: {
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly nextSkipRef: RefObject<HTMLButtonElement | null>;
  readonly workspaces: readonly RepoRulesReviewWorkspace[];
  readonly offer: RepoRulesReviewOffer | undefined;
  readonly onChoose: (workspaceId: string) => void;
  readonly onSkip: (workspaceId: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const statusIdPrefix = useId();
  const nextUndecidedId = workspaces.find(
    (entry) => offer?.decisions[entry.id] === undefined,
  )?.id;
  const anyDecided = workspaces.some(
    (entry) => offer?.decisions[entry.id] !== undefined,
  );
  return (
    <Stack as="section" gap="group" data-testid="repo-rules-choose">
      <Heading level={3} variant="section" ref={headingRef} tabIndex={-1}>
        Choose a project
      </Heading>
      {workspaces.length === 0 ? (
        <p className="text-s fg-secondary">
          {offer
            ? 'These projects are no longer available.'
            : 'Add a code project first, then review its Cursor rules.'}
        </p>
      ) : (
        <>
          <p className="text-s fg-secondary">
            Cursor rules are saved per project and apply to all of its
            worktrees.
          </p>
          <Stack as="ul" gap="tight">
            {workspaces.map((entry) => {
              const decision = offer?.decisions[entry.id];
              const statusId = `${statusIdPrefix}-${entry.id}`;
              return (
                <li key={entry.id} className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    className="min-w-0 flex-1 justify-start"
                    onClick={(): void => onChoose(entry.id)}
                    {...(decision ? { 'aria-describedby': statusId } : {})}
                    data-testid={`repo-rules-choose-${entry.id}`}
                  >
                    <span className={`truncate ${REPLAY_MASK_CLASS}`}>
                      {entry.name}
                    </span>
                  </Button>
                  {decision ? (
                    <span
                      id={statusId}
                      className="shrink-0 text-xs fg-secondary"
                      data-testid={`repo-rules-decision-${entry.id}`}
                    >
                      {DECISION_LABELS[decision]}
                    </span>
                  ) : offer ? (
                    <Button
                      size="sm"
                      ref={
                        entry.id === nextUndecidedId ? nextSkipRef : undefined
                      }
                      variant="ghost"
                      className="shrink-0"
                      onClick={(): void => onSkip(entry.id)}
                      data-testid={`repo-rules-skip-${entry.id}`}
                    >
                      Skip
                      <span className={`sr-only ${REPLAY_MASK_CLASS}`}>
                        {' '}
                        {entry.name}
                      </span>
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </Stack>
        </>
      )}
      <div className="flex justify-end">
        <Button variant="ghost" onClick={onClose}>
          {offer && (anyDecided || workspaces.length === 0)
            ? 'Close'
            : 'Cancel'}
        </Button>
      </div>
    </Stack>
  );
}

function StatusSummary({
  statusState,
  diagnostic,
  disabledCount,
}: {
  readonly statusState: StatusState;
  readonly diagnostic: string | null;
  readonly disabledCount: number;
}): JSX.Element | null {
  if (statusState.kind === 'loading') return null;
  if (statusState.kind === 'error') {
    return (
      <Notice intent="attention" data-testid="repo-rules-status-error">
        Couldn&apos;t load the saved setting.
      </Notice>
    );
  }
  if (diagnostic) {
    return (
      <Notice intent="attention" data-testid="repo-rules-status-diagnostic">
        {diagnostic}
      </Notice>
    );
  }
  if (!statusState.status.enabled) return null;
  return (
    <Notice intent="positive" data-testid="repo-rules-status-enabled">
      Cursor rules are on for this project
      {disabledCount > 0
        ? `, with ${ruleCountLabel(disabledCount)} turned off.`
        : '.'}{' '}
      {NEW_CHATS_NOTE}
    </Notice>
  );
}

function ReviewStep({
  headingRef,
  scan,
  appName,
  workspaceName,
  status,
  statusDiagnostic,
  overrides,
  previews,
  onToggle,
  onPreview,
  footer,
  disabled,
}: {
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly scan: RepoRulesScanResponse;
  readonly appName: string;
  readonly workspaceName: string;
  /** Saved-status summary, shown under the reassurance. */
  readonly status: ReactNode;
  /** Saved-status diagnostic message, so a matching scan one shows once. */
  readonly statusDiagnostic: string | null;
  readonly overrides: Readonly<Record<string, boolean>>;
  readonly previews: Readonly<Record<string, PreviewState>>;
  readonly onToggle: (ruleId: string, next: boolean) => void;
  readonly onPreview: (ruleId: string) => void;
  readonly disabled: boolean;
  readonly footer: ReactNode;
}): JSX.Element {
  const repoIds = [...new Set(scan.proposals.map((rule) => rule.repoId))];
  const multiRepo = repoIds.length > 1;
  const scanDiagnostic = scan.diagnostic
    ? DIAGNOSTIC_MESSAGES[scan.diagnostic]
    : null;
  const diagnostic =
    scanDiagnostic === statusDiagnostic ? null : scanDiagnostic;
  return (
    <Stack as="section" gap="group" data-testid="repo-rules-review-step">
      <Stack gap="tight">
        <Heading level={3} variant="section" ref={headingRef} tabIndex={-1}>
          {scan.proposals.length === 0 ? (
            'No Cursor rules found'
          ) : (
            <>
              Found {ruleCountLabel(scan.proposals.length)} in{' '}
              <span className={REPLAY_MASK_CLASS}>{workspaceName}</span>
            </>
          )}
        </Heading>
        <p className="text-s fg-secondary" data-testid="repo-rules-reassurance">
          {appName} reads <code className="font-mono">.cursor/rules</code> and{' '}
          <code className="font-mono">.cursorrules</code> in{' '}
          <span className={REPLAY_MASK_CLASS}>{workspaceName}</span>. Nothing in
          the repository changes.
        </p>
      </Stack>
      {status}
      {diagnostic ? <Notice intent="attention">{diagnostic}</Notice> : null}
      {scan.proposals.length === 0 ? (
        <p className="text-s fg-secondary" data-testid="repo-rules-empty">
          Add <code className="font-mono">.mdc</code> files to a{' '}
          <code className="font-mono">.cursor/rules</code> folder, then scan
          again.
        </p>
      ) : (
        repoIds.map((repoId) => (
          <Stack gap="inline" key={repoId}>
            {multiRepo ? (
              <Heading level={4} variant="label">
                <span className={REPLAY_BLOCK_CLASS}>{repoId}</span>
              </Heading>
            ) : null}
            <Surface variant="outline">
              <ul className="divide-y">
                {scan.proposals
                  .filter((rule) => rule.repoId === repoId)
                  .map((rule) => (
                    <RuleRow
                      key={rule.id}
                      rule={rule}
                      selected={overrides[rule.id] ?? rule.selected}
                      preview={previews[rule.id] ?? null}
                      disabled={disabled}
                      onToggle={(next): void => onToggle(rule.id, next)}
                      onPreview={(): void => onPreview(rule.id)}
                    />
                  ))}
              </ul>
            </Surface>
          </Stack>
        ))
      )}
      {scan.skipped.length > 0 ? (
        <Stack gap="inline" data-testid="repo-rules-skipped">
          <Heading level={4} variant="title">
            Not included
          </Heading>
          <p className="text-xs fg-tertiary">
            These files were found but can&apos;t be used.
          </p>
          <Stack as="ul" gap="tight">
            {scan.skipped.map((item) => (
              <li
                key={`${item.repoId}:${item.path}`}
                className="flex flex-wrap items-baseline justify-between gap-2 text-s"
              >
                <code
                  className={`min-w-0 truncate font-mono fg-secondary ${REPLAY_BLOCK_CLASS}`}
                >
                  {item.path}
                </code>
                <span className="text-xs fg-tertiary">
                  {SKIP_REASONS[item.reason]}
                </span>
              </li>
            ))}
          </Stack>
        </Stack>
      ) : null}
      <Disclosure label="How rules work" dataTestId="repo-rules-how-rules-work">
        <ul className="list-disc pl-5 text-xs fg-secondary flex flex-col gap-1">
          <li>
            Each new chat reads the current rules, so edits apply without
            another review. Rules in a new nested folder need another scan.
          </li>
          <li>AGENTS.md and CLAUDE.md win when they conflict.</li>
          <li>
            Other branches can have different rules.{' '}
            {scan.worktreeId
              ? 'This review scanned the selected checkout.'
              : "This review scanned the project's repositories."}
          </li>
          <li>Cursor reads these rules itself and doesn&apos;t get a copy.</li>
          <li>
            Files a rule points to are checked for existence, not opened. Files
            read through rules or @file references stay live in chats.
          </li>
        </ul>
      </Disclosure>
      {footer}
    </Stack>
  );
}

/** Plain rules the scan's skeleton measures. */
const SAMPLE_RULES: readonly RepoRuleProposal[] = [
  {
    id: 'repo-rules-skeleton-1',
    repoId: 'repo-rules-skeleton',
    path: '.cursor/rules/testing.mdc',
    kind: 'always',
    description: 'How to write and run tests',
    globs: [],
    scope: '',
    hash: '',
    bytes: 0,
    selected: true,
    flags: [],
  },
  {
    id: 'repo-rules-skeleton-2',
    repoId: 'repo-rules-skeleton',
    path: '.cursor/rules/style.mdc',
    kind: 'always',
    description: 'Code style for the app',
    globs: [],
    scope: '',
    hash: '',
    bytes: 0,
    selected: true,
    flags: [],
  },
];

/** A short rule file the preview's skeleton measures. */
const SAMPLE_RULE_BODY = [
  'Run the affected tests before each commit.',
  'Keep test names short and plain.',
  'Prefer one assertion per behavior.',
].join('\n');

const noop = (): void => undefined;

/** A rule file's text, cut at the preview limit. */
function RulePreviewText({ body }: { readonly body: string }): JSX.Element {
  return (
    <Surface variant="group" size="small" className="overflow-hidden">
      <pre
        className={`max-h-64 overflow-auto whitespace-pre-wrap p-2 font-mono text-xs fg-secondary ${REPLAY_BLOCK_CLASS}`}
        data-testid="repo-rules-preview"
      >
        {body.length > PREVIEW_CHAR_LIMIT
          ? `${body.slice(0, PREVIEW_CHAR_LIMIT)}\n…`
          : body || '(empty)'}
      </pre>
    </Surface>
  );
}

function RuleRow({
  rule,
  selected,
  preview,
  onToggle,
  onPreview,
  disabled,
}: {
  readonly rule: RepoRuleProposal;
  readonly selected: boolean;
  readonly preview: PreviewState | null;
  readonly onToggle: (next: boolean) => void;
  readonly onPreview: () => void;
  readonly disabled: boolean;
}): JSX.Element {
  const previewId = useId();
  const pathId = useId();
  return (
    <li
      className="p-3 flex flex-col gap-2"
      role="group"
      aria-labelledby={pathId}
      data-testid="repo-rules-rule"
    >
      <div className="flex items-start gap-3">
        <Stack gap="tight" className="min-w-0 flex-1">
          <code
            id={pathId}
            className={`block truncate font-mono text-s fg-primary ${REPLAY_BLOCK_CLASS}`}
          >
            {rule.path}
          </code>
          <p className="text-xs fg-secondary">
            <span className="font-medium">
              {rule.scope && rule.kind === 'always'
                ? 'Before working in this folder'
                : KIND_LABELS[activationKind(rule)]}
            </span>
            {' · '}
            {rule.scope && rule.kind === 'always'
              ? 'The agent reads it before reading or editing files in this scope.'
              : activationKind(rule) === 'manual'
                ? 'The agent reads it only when you explicitly mention its path.'
                : KIND_DESCRIPTIONS[activationKind(rule)]}
            {rule.scope ? (
              <>
                {' '}
                Applies in{' '}
                <code className={`font-mono ${REPLAY_BLOCK_CLASS}`}>
                  {rule.scope}
                </code>
                .
              </>
            ) : null}
          </p>
          {rule.description ? (
            <p className={`text-xs fg-tertiary ${REPLAY_BLOCK_CLASS}`}>
              {rule.description}
            </p>
          ) : null}
          {rule.globs.length > 0 ? (
            <p
              className={`font-mono text-xs fg-tertiary ${REPLAY_BLOCK_CLASS}`}
            >
              {rule.globs.join(', ')}
            </p>
          ) : null}
          {rule.flags.length > 0 ? (
            <ul className="flex flex-wrap gap-1" aria-label="Notes">
              {rule.flags.map((flag) => (
                <Surface as="li" variant="group" size="small" key={flag}>
                  <div className="px-1.5 py-0.5 text-xs fg-secondary">
                    {FLAG_LABELS[flag]}
                  </div>
                </Surface>
              ))}
            </ul>
          ) : null}
        </Stack>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={preview !== null}
            aria-controls={previewId}
            onClick={onPreview}
            data-testid="repo-rules-preview-toggle"
          >
            {preview ? 'Hide' : 'Preview'}
          </Button>
          <ToggleSwitch
            checked={selected}
            disabled={disabled}
            label="Use this rule"
            onChange={onToggle}
            dataTestId="repo-rules-rule-toggle"
          />
        </div>
      </div>
      {preview ? (
        <div id={previewId}>
          {preview.kind === 'loading' ? (
            <DelayedLoadingPlaceholder slowNote="Still loading the rule…">
              <Skeleton
                loading
                label="Loading the rule"
                testId="repo-rules-preview-loading"
              >
                <RulePreviewText body={SAMPLE_RULE_BODY} />
              </Skeleton>
            </DelayedLoadingPlaceholder>
          ) : preview.kind === 'error' ? (
            <ErrorBanner
              errorSource="rule-row-preview"
              className=""
              error={preview.message}
            />
          ) : (
            <RulePreviewText body={preview.body} />
          )}
        </div>
      ) : null}
    </li>
  );
}
