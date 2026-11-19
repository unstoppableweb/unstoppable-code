'use client';

import { CodeBlock } from '@canopy/ui-shared/components/CodeBlock';
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
  type ReactNode,
} from 'react';
import {
  FeedbackDiagnosticsExpiredError,
  FeedbackOutcomeUnknownError,
  FeedbackSubmissionConflictError,
  type FeedbackReportClient,
  type FeedbackReportContext,
  type FeedbackReportError,
  type FeedbackReportResult,
  type FeedbackReportSubmission,
  type FeedbackReportTelemetry,
} from '@canopy/protocol/feedback-report';
import {
  Button,
  ChoiceField,
  Disclosure,
  Divider,
  Fact,
  FactList,
  LoadingButton,
  Notice,
  Surface,
} from '@canopy/ui-shared/components';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import {
  FeedbackDialog,
  FeedbackSubmissionHeldError,
  type FeedbackDialogSubmission,
} from './FeedbackDialog';
import { FeedbackDiagnosticsPreview } from './FeedbackDiagnosticsPreview';
import { useFeedbackDiagnostics } from './use-feedback-diagnostics';

import type {
  DraftState,
  FeedbackReportDialogContentProps,
} from './feedback-report-dialog-types';

type DiagnosticsMode = 'snapshot' | 'host-collected' | 'none';

const SAVE_ERROR_FALLBACK = 'Could not save the diagnostics bundle.';
const OUTCOME_UNKNOWN_COPY =
  'We couldn’t confirm your report was filed. Try again to check. It won’t be filed twice.';
const SUBMISSION_CONFLICT_COPY =
  'Your earlier answer may already be filed, so this edit can’t join it. Undo your edit to try again, or close this and start a new report.';
const SAVED_COPY = 'Saved a copy to your Downloads folder.';

interface ContextRow {
  readonly label: string;
  readonly value: string;
  readonly masked?: boolean;
}

function joinParts(parts: ReadonlyArray<string | undefined>): string {
  return parts
    .filter((part) => part !== undefined && part.length > 0)
    .join(' · ');
}

/** Human-readable summary rows for the read-only auto-captured context block. */
function toContextRows(context: FeedbackReportContext): ContextRow[] {
  const rows: ContextRow[] = [];
  if (context.activePage)
    rows.push({ label: 'Page', value: context.activePage });
  const project = joinParts([context.workspaceName, context.worktreeName]);
  if (project) rows.push({ label: 'Project', value: project, masked: true });
  const chat = joinParts([context.provider, context.model]);
  if (chat) rows.push({ label: 'Chat', value: chat });
  if (context.appVersion)
    rows.push({ label: 'Version', value: context.appVersion });
  if (context.platform)
    rows.push({ label: 'Platform', value: context.platform });
  return rows;
}

/** Every captured identifier, for the full disclosure. */
function toIdentifierRows(context: FeedbackReportContext): ContextRow[] {
  const rows: ContextRow[] = [];
  if (context.workspaceId)
    rows.push({ label: 'Project ID', value: context.workspaceId });
  if (context.worktreeId)
    rows.push({ label: 'Worktree ID', value: context.worktreeId });
  if (context.chatProjectId)
    rows.push({ label: 'Chat project ID', value: context.chatProjectId });
  if (context.chatId) rows.push({ label: 'Chat ID', value: context.chatId });
  return rows;
}

function toTelemetryRows(telemetry: FeedbackReportTelemetry): ContextRow[] {
  const rows: ContextRow[] = [];
  if (telemetry.datadogSessionId)
    rows.push({ label: 'Datadog', value: telemetry.datadogSessionId });
  if (telemetry.posthogSessionId)
    rows.push({ label: 'PostHog', value: telemetry.posthogSessionId });
  if (telemetry.posthogReplayUrl)
    rows.push({ label: 'Replay', value: telemetry.posthogReplayUrl });
  return rows;
}

function FactRows({
  rows,
  testId,
}: {
  readonly rows: readonly ContextRow[];
  readonly testId?: string;
}): JSX.Element {
  return (
    <FactList
      labelWidth="5rem"
      columnGap="2"
      rowGap="1"
      labelTone="secondary"
      {...(testId ? { dataTestId: testId } : {})}
    >
      {rows.map((row) => (
        <Fact key={row.label} label={row.label} fit="truncate">
          {row.masked ? (
            <span className={REPLAY_MASK_CLASS}>{row.value}</span>
          ) : (
            row.value
          )}
        </Fact>
      ))}
    </FactList>
  );
}

function DisclosureSection({
  heading,
  children,
}: {
  readonly heading: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="block text-xs font-medium fg-secondary">{heading}</span>
      {children}
    </div>
  );
}

/**
 * The form hosts mount for feedback and for error reports: it owns the draft,
 * the diagnostics snapshot and delivery, and hosts supply only the transport.
 * Everything an opening knows (its context, error and submission intent) lives
 * and dies with this component, so hosts unmount it to close.
 */
export function FeedbackReportDialog({
  appName,
  client,
  diagnosticsSupported,
  openingDraft,
  onClose,
  initialReportType,
  error,
  telemetry,
  ownerDocument,
}: FeedbackReportDialogContentProps): JSX.Element {
  const [draft, setDraft] = useState<DraftState>({ status: 'loading' });
  const draftPromise = useRef<Promise<DraftState> | null>(null);
  const openingGeneration = useRef(0);
  const [form, setForm] = useState<FeedbackDialogSubmission>({
    type: error ? 'bug' : (initialReportType ?? 'idea'),
    description: '',
  });
  const description = form.description;
  const inlineContents = client.diagnosticTextVisibility === 'inline';
  const [downloading, setDownloading] = useState(false);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const diagnostics = useFeedbackDiagnostics(client);
  // One per opening, retained across retries so nothing is filed twice.
  const [submissionId] = useState(() => crypto.randomUUID());
  const [filedRequest, setFiledRequest] =
    useState<FeedbackReportSubmission | null>(null);
  const [delivery, setDelivery] = useState<
    FeedbackReportResult['diagnosticsStatus'] | null
  >(null);
  const [retryingDelivery, setRetryingDelivery] = useState(false);
  const [deliveryRetried, setDeliveryRetried] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [reviewingReplacement, setReviewingReplacement] = useState(false);

  // Runs once per opening, so the context reflects where the person was when
  // they decided to report, not where they end up after. A failed draft leaves
  // the form usable; a late one after closing has nothing left to update.
  useEffect(() => {
    const opening = openingGeneration.current;
    const loading =
      openingDraft ??
      Promise.resolve()
        .then(() => client.draft())
        .then(
          (loaded): DraftState => ({ status: 'ready', draft: loaded }),
          (): DraftState => ({ status: 'unavailable' }),
        );
    draftPromise.current = loading;
    void loading.then((settled) => {
      if (opening === openingGeneration.current) setDraft(settled);
    });
    return (): void => {
      openingGeneration.current += 1;
    };
  }, [client, openingDraft]);

  const context: FeedbackReportContext =
    draft.status === 'ready' ? draft.draft.context : {};
  const mode: DiagnosticsMode = diagnosticsModeFor(
    client,
    diagnosticsSupported,
    draft,
  );
  // Session links belong to error reports; ordinary feedback never gains them.
  const reportTelemetry = error
    ? (telemetry ??
      (draft.status === 'ready' ? draft.draft.telemetry : undefined))
    : undefined;
  const contextRows = [
    ...(error ? [{ label: 'Reference', value: error.referenceId }] : []),
    ...toContextRows(context),
  ];
  const identifierRows = toIdentifierRows(context);
  const telemetryRows = reportTelemetry ? toTelemetryRows(reportTelemetry) : [];
  const offersDiagnostics =
    mode !== 'none' || (draft.status === 'loading' && diagnosticsSupported);
  const diagnosticsHeld =
    mode === 'snapshot' &&
    includeDiagnostics &&
    (diagnostics.state.status === 'failed' ||
      diagnostics.state.status === 'expired');

  function diagnosticsScope(scopeContext: FeedbackReportContext): {
    context: FeedbackReportContext;
    error?: FeedbackReportError;
  } {
    return { context: scopeContext, ...(error ? { error } : {}) };
  }

  // Inspecting prepares the archive, even if the draft settles after opening.
  const { ensure: ensureDiagnostics, state: diagnosticsState } = diagnostics;
  useEffect(() => {
    if (
      disclosureOpen &&
      mode === 'snapshot' &&
      includeDiagnostics &&
      diagnosticsState.status === 'idle' &&
      draft.status === 'ready'
    )
      ensureDiagnostics({
        context: draft.draft.context,
        ...(error ? { error } : {}),
      }).catch(() => {
        // The state shows the failure and the choice it needs.
      });
  }, [
    disclosureOpen,
    mode,
    includeDiagnostics,
    diagnosticsState.status,
    draft,
    error,
    ensureDiagnostics,
  ]);

  function toggleDiagnostics(checked: boolean): void {
    setIncludeDiagnostics(checked);
    if (!checked) diagnostics.discard();
  }

  async function prepareRequest(
    submission: FeedbackDialogSubmission,
  ): Promise<FeedbackReportSubmission> {
    const opening = openingGeneration.current;
    // Sending before the draft settled still sends what the opening captured.
    const settled = (await draftPromise.current) ?? draft;
    if (opening !== openingGeneration.current)
      throw new FeedbackSubmissionHeldError();
    const settledContext =
      settled.status === 'ready' ? settled.draft.context : {};
    const settledMode = diagnosticsModeFor(
      client,
      diagnosticsSupported,
      settled,
    );
    const settledTelemetry = error
      ? (telemetry ??
        (settled.status === 'ready' ? settled.draft.telemetry : undefined))
      : undefined;
    let snapshotId: string | undefined;
    if (includeDiagnostics && settledMode === 'snapshot') {
      if (diagnostics.state.status === 'expired')
        throw new FeedbackSubmissionHeldError();
      try {
        snapshotId = (
          await diagnostics.ensure(diagnosticsScope(settledContext))
        ).id;
      } catch {
        // The block shows the failure; a different archive is never sent.
        throw new FeedbackSubmissionHeldError();
      }
    }
    if (opening !== openingGeneration.current)
      throw new FeedbackSubmissionHeldError();
    return {
      ...submission,
      context: settledContext,
      includeDiagnostics: includeDiagnostics && settledMode !== 'none',
      submissionId,
      ...(error ? { error } : {}),
      ...(settledTelemetry ? { telemetry: settledTelemetry } : {}),
      ...(snapshotId ? { diagnosticsSnapshotId: snapshotId } : {}),
    };
  }

  async function handleSubmit(
    submission: FeedbackDialogSubmission,
  ): Promise<FeedbackReportResult> {
    const opening = openingGeneration.current;
    const request = await prepareRequest(submission);
    if (opening !== openingGeneration.current)
      throw new FeedbackSubmissionHeldError();
    try {
      const result = await client.submit(request);
      setFiledRequest(request);
      setDelivery(result.diagnosticsStatus ?? null);
      return result;
    } catch (err: unknown) {
      if (err instanceof FeedbackDiagnosticsExpiredError) {
        diagnostics.markExpired();
        throw new FeedbackSubmissionHeldError();
      }
      if (err instanceof FeedbackOutcomeUnknownError)
        throw new Error(OUTCOME_UNKNOWN_COPY);
      if (err instanceof FeedbackSubmissionConflictError)
        throw new Error(SUBMISSION_CONFLICT_COPY);
      throw err;
    }
  }

  async function downloadReport(): Promise<void> {
    const opening = openingGeneration.current;
    setDownloading(true);
    try {
      // This is the same decoded request passed to the host's submit adapter.
      // Transport encoding and the separately saved ZIP do not alter its trace.
      const request = await prepareRequest(form);
      if (opening !== openingGeneration.current)
        throw new FeedbackSubmissionHeldError();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(request, null, 2)], {
          type: 'application/json',
        }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `feedback-${error?.referenceId ?? submissionId}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err: unknown) {
      if (!(err instanceof FeedbackSubmissionHeldError))
        setSavedMessage("Couldn't download report data.");
    } finally {
      setDownloading(false);
    }
  }

  async function retryDelivery(): Promise<void> {
    const request = filedRequest;
    if (!request || retryingDelivery) return;
    setRetryingDelivery(true);
    setDeliveryError(null);
    setSavedMessage(null);
    try {
      const needsReview = diagnostics.state.status !== 'ready';
      // An expired snapshot is replaced only by this explicit preparation.
      // Show the replacement before a second action attaches its exact bytes.
      const snapshot = await diagnostics.ensure(
        diagnosticsScope(request.context),
      );
      const retried: FeedbackReportSubmission = {
        ...request,
        diagnosticsSnapshotId: snapshot.id,
      };
      setFiledRequest(retried);
      if (needsReview) {
        setReviewingReplacement(true);
        return;
      }
      const result = await client.submit(retried);
      setDelivery(result.diagnosticsStatus ?? null);
      setDeliveryRetried(true);
      setReviewingReplacement(false);
    } catch (err: unknown) {
      if (err instanceof FeedbackDiagnosticsExpiredError)
        diagnostics.markExpired();
      setDeliveryError(
        `Couldn’t attach diagnostics. Your ${error ? 'report' : 'feedback'} is still filed.`,
      );
    } finally {
      setRetryingDelivery(false);
    }
  }

  async function saveDiagnostics(): Promise<void> {
    setSaving(true);
    setSavedMessage(null);
    try {
      if (mode === 'snapshot' && client.saveDiagnostics) {
        const snapshot = await diagnostics.ensure(diagnosticsScope(context));
        await client.saveDiagnostics(snapshot.id);
        setSavedMessage(SAVED_COPY);
      } else if (client.saveCollectedDiagnostics) {
        const saved = await client.saveCollectedDiagnostics({
          context,
          description:
            description.trim().length > 0
              ? description.trim()
              : 'Feedback diagnostics',
          ...(error ? { error } : {}),
        });
        setSavedMessage(`Saved ${saved.filename} to your Downloads folder.`);
      }
    } catch (err: unknown) {
      if (err instanceof FeedbackDiagnosticsExpiredError) {
        diagnostics.markExpired();
        return;
      }
      setSavedMessage(
        err instanceof Error && err.message.length > 0
          ? err.message
          : SAVE_ERROR_FALLBACK,
      );
    } finally {
      setSaving(false);
    }
  }

  const canSave =
    (mode === 'snapshot' && client.saveDiagnostics !== undefined) ||
    (mode === 'host-collected' &&
      client.saveCollectedDiagnostics !== undefined);
  const saveButton = canSave ? (
    <Button
      type="button"
      variant="secondary"
      size="compact"
      onClick={(): void => {
        void saveDiagnostics();
      }}
      // An expired archive is replaced only through the choice shown for it.
      disabled={saving || diagnosticsHeld}
      data-testid="feedback-modal-save-diagnostics"
    >
      {saving ? 'Saving…' : 'Save diagnostics to Downloads'}
    </Button>
  ) : undefined;
  const saveCopyButton =
    mode === 'snapshot' ? (
      <div>
        <Button
          type="button"
          variant="secondary"
          size="compact"
          onClick={(): void => {
            void saveDiagnostics();
          }}
          disabled={saving}
          data-testid="feedback-diagnostics-save"
        >
          {saving ? 'Saving…' : 'Save a copy'}
        </Button>
      </div>
    ) : null;

  const showAttachments =
    offersDiagnostics || error !== undefined || draft.status === 'unavailable';
  const savedNote =
    savedMessage !== null ? (
      <p
        className="text-xs fg-secondary"
        data-testid="feedback-modal-saved-message"
      >
        <span className={REPLAY_BLOCK_CLASS}>{savedMessage}</span>
      </p>
    ) : null;

  return (
    <FeedbackDialog
      appName={appName}
      mode={error ? 'error' : 'feedback'}
      {...(initialReportType ? { initialReportType } : {})}
      onClose={onClose}
      ownerDocument={ownerDocument}
      onDraftChange={setForm}
      onSubmit={handleSubmit}
      submitBlocked={diagnosticsHeld}
      successDetail={
        deliveryRetried && delivery === 'attached' ? (
          <p
            className="text-xs fg-secondary"
            data-testid="feedback-modal-delivery-attached"
          >
            Diagnostics are attached.
          </p>
        ) : includeDiagnostics &&
          (delivery === 'unavailable' || delivery === 'pending') ? (
          <div className="flex min-w-0 flex-col gap-3">
            <Notice
              intent="attention"
              data-testid="feedback-modal-delivery"
              actions={
                filedRequest?.diagnosticsSnapshotId ? (
                  <LoadingButton
                    variant="secondary"
                    size="compact"
                    loading={retryingDelivery}
                    loadingLabel={
                      diagnostics.state.status === 'ready'
                        ? 'Attaching…'
                        : 'Preparing…'
                    }
                    onClick={(): void => {
                      void retryDelivery();
                    }}
                    data-testid="feedback-modal-delivery-retry"
                  >
                    {diagnostics.state.status !== 'ready'
                      ? 'Prepare again'
                      : reviewingReplacement
                        ? 'Attach diagnostics'
                        : 'Try again'}
                  </LoadingButton>
                ) : undefined
              }
            >
              {deliveryError ??
                (reviewingReplacement && diagnostics.state.status === 'ready'
                  ? 'Review the new diagnostics below before attaching them. Your report is already filed.'
                  : `Your ${error ? 'report' : 'feedback'} is filed, but its diagnostics couldn’t be attached.`)}
            </Notice>
            {reviewingReplacement && diagnostics.state.status === 'ready' ? (
              <>
                <FeedbackDiagnosticsPreview
                  key={diagnostics.state.snapshot.id}
                  client={client}
                  snapshot={diagnostics.state.snapshot}
                  onExpired={diagnostics.markExpired}
                />
                {saveCopyButton}
                {savedNote}
              </>
            ) : null}
          </div>
        ) : null
      }
      attachments={
        showAttachments ? (
          <Surface
            variant="group"
            padding="compact"
            gap="group"
            data-testid="feedback-modal-attachments"
          >
            {/* The heading asserts something is attached, so it is gated on
                there actually being something: every field feeding the rows
                is optional, and a heading over nothing would be a lie about
                what leaves the user's machine. */}
            {(contextRows.length > 0 ||
              includeDiagnostics ||
              error !== undefined) && (
              <span className="block text-xs font-medium fg-secondary">
                Sent with your report
              </span>
            )}
            {draft.status === 'unavailable' ? (
              <p
                className="text-xs fg-secondary"
                data-testid="feedback-modal-context-unavailable"
              >
                Couldn’t read where you were in the app, so this goes without
                that context.
              </p>
            ) : null}
            {contextRows.length > 0 && (
              <FactRows rows={contextRows} testId="feedback-modal-context" />
            )}
            {offersDiagnostics ? (
              <>
                {contextRows.length > 0 ? <Divider /> : null}
                {/* The whole row is the label, so clicking the text toggles it.
                    `aria-labelledby` keeps the accessible name to the two
                    words a screen reader needs; the helper line is the
                    description. */}
                <ChoiceField
                  id="feedback-modal-diagnostics-input"
                  data-testid="feedback-modal-include-diagnostics"
                  checked={includeDiagnostics}
                  aria-labelledby="feedback-modal-diagnostics-label"
                  aria-describedby="feedback-modal-diagnostics-description"
                  onChange={(e: ChangeEvent<HTMLInputElement>): void => {
                    toggleDiagnostics(e.target.checked);
                  }}
                  label={
                    <span id="feedback-modal-diagnostics-label">
                      Include diagnostics
                    </span>
                  }
                  description={
                    <span id="feedback-modal-diagnostics-description">
                      Logs and app state, shared only with the {appName} team
                    </span>
                  }
                />
              </>
            ) : null}
            {diagnosticsHeld ? (
              <Notice
                intent="attention"
                data-testid="feedback-modal-diagnostics-held"
                actions={
                  <>
                    <Button
                      type="button"
                      variant="secondary"
                      size="compact"
                      onClick={(): void => {
                        // Back to idle first, so ensure prepares a new one.
                        diagnostics.discard();
                        diagnostics
                          .ensure(diagnosticsScope(context))
                          .catch(() => undefined);
                      }}
                      data-testid="feedback-modal-diagnostics-prepare"
                    >
                      Prepare again
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="compact"
                      onClick={(): void => toggleDiagnostics(false)}
                      data-testid="feedback-modal-diagnostics-skip"
                    >
                      Continue without diagnostics
                    </Button>
                  </>
                }
              >
                {diagnostics.state.status === 'expired'
                  ? 'The diagnostics preview expired or your report context changed. Prepare it again before sending. Nothing was sent.'
                  : 'Couldn’t prepare diagnostics. Nothing was sent.'}
              </Notice>
            ) : null}
            {mode === 'none' && error === undefined ? null : (
              <Disclosure
                label="What gets sent"
                open={disclosureOpen}
                onOpenChange={setDisclosureOpen}
                dataTestId="feedback-modal-what-gets-sent"
              >
                <div className="flex min-w-0 flex-col gap-3">
                  <p className="text-xs fg-secondary">
                    {inlineContents
                      ? 'Inspect report fields below or download their full contents.'
                      : 'Error traces stay off screen in this build. Download report data to inspect all report fields before sending.'}
                    {mode === 'snapshot' && includeDiagnostics
                      ? ' Save diagnostics separately to inspect every file in the archive.'
                      : null}
                  </p>
                  <div>
                    <LoadingButton
                      type="button"
                      variant="secondary"
                      size="compact"
                      loading={downloading}
                      loadingLabel="Preparing…"
                      disabled={diagnosticsHeld}
                      onClick={(): void => {
                        void downloadReport();
                      }}
                      data-testid="feedback-report-download"
                    >
                      Download report data
                    </LoadingButton>
                  </div>
                  <FactRows
                    rows={[
                      {
                        label: 'Type',
                        value: form.type === 'bug' ? 'Bug' : 'Idea',
                      },
                      ...(form.title
                        ? [{ label: 'Title', value: form.title, masked: true }]
                        : []),
                    ]}
                  />
                  <DisclosureSection
                    heading={error ? 'Your answer' : 'Your description'}
                  >
                    <p
                      className={`whitespace-pre-wrap break-words text-xs fg-secondary ${REPLAY_BLOCK_CLASS}`}
                      data-dd-privacy="hidden"
                      data-testid="feedback-modal-sent-answer"
                    >
                      {description.trim().length > 0
                        ? description.trim()
                        : 'Nothing yet'}
                    </p>
                  </DisclosureSection>
                  {error ? (
                    <DisclosureSection heading="Error">
                      <FactRows
                        rows={[
                          { label: 'Reference', value: error.referenceId },
                          { label: 'Code', value: error.code },
                          { label: 'Kind', value: error.kind },
                          {
                            label: 'When',
                            value: new Date(error.occurredAt).toISOString(),
                          },
                          { label: 'Shown as', value: error.copy.title },
                        ]}
                        testId="feedback-modal-sent-error"
                      />
                      {inlineContents ? (
                        <CodeBlock
                          variant="bare"
                          className="max-h-64"
                          data-dd-privacy="hidden"
                          data-selectable
                          data-testid="feedback-modal-sent-error-detail"
                        >
                          {JSON.stringify(error.detail, null, 2)}
                        </CodeBlock>
                      ) : null}
                    </DisclosureSection>
                  ) : null}
                  {identifierRows.length > 0 ? (
                    <DisclosureSection heading="Identifiers">
                      <FactRows rows={identifierRows} />
                    </DisclosureSection>
                  ) : null}
                  {telemetryRows.length > 0 ? (
                    <DisclosureSection heading="Session links">
                      <FactRows
                        rows={telemetryRows}
                        testId="feedback-modal-sent-telemetry"
                      />
                    </DisclosureSection>
                  ) : null}
                  {mode === 'none' ? null : (
                    <DisclosureSection heading="Diagnostics">
                      <DiagnosticsSection
                        client={client}
                        mode={mode}
                        included={includeDiagnostics}
                        state={diagnostics.state}
                        onExpired={diagnostics.markExpired}
                        saveAction={saveCopyButton}
                      />
                    </DisclosureSection>
                  )}
                </div>
              </Disclosure>
            )}
          </Surface>
        ) : null
      }
      {...(saveButton ? { errorActions: saveButton } : {})}
      note={savedNote}
    />
  );
}

function DiagnosticsSection({
  client,
  mode,
  included,
  state,
  onExpired,
  saveAction,
}: {
  readonly client: FeedbackReportClient;
  readonly mode: Exclude<DiagnosticsMode, 'none'>;
  readonly included: boolean;
  readonly state: ReturnType<typeof useFeedbackDiagnostics>['state'];
  readonly onExpired: () => void;
  readonly saveAction: ReactNode;
}): JSX.Element {
  if (!included)
    return <p className="text-xs fg-secondary">Not included in this report.</p>;
  if (mode === 'host-collected')
    return (
      <p className="text-xs fg-secondary">
        This computer collects its logs and app state when you send, so they
        can’t be previewed here.
      </p>
    );
  if (state.status === 'ready')
    return (
      <>
        <FeedbackDiagnosticsPreview
          client={client}
          snapshot={state.snapshot}
          onExpired={onExpired}
        />
        {saveAction}
      </>
    );
  if (state.status === 'preparing')
    return <p className="text-xs fg-secondary">Preparing diagnostics…</p>;
  return (
    <p className="text-xs fg-secondary">
      Prepared when you open this or send your report.
    </p>
  );
}

/** Exact inspection needs the capability, every method and the host's yes. */
function diagnosticsModeFor(
  client: FeedbackReportClient,
  supported: boolean,
  draft: DraftState,
): DiagnosticsMode {
  if (draft.status !== 'ready') return 'none';
  const offered = draft.draft.diagnostics;
  if (offered === 'host-collected') return 'host-collected';
  if (
    offered === 'snapshot' &&
    supported &&
    client.prepareDiagnostics &&
    client.readDiagnosticsEntry &&
    client.saveDiagnostics &&
    client.releaseDiagnostics
  )
    return 'snapshot';
  return 'none';
}
