'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  CLOUD_RUN_START_UNCERTAIN,
  cloudRunEventName,
  cloudRunInputDefinitions,
  launchCloudPipelineRun,
  readCloudRunDefinition,
  type CloudPipelineRunLaunch,
} from '@canopy/app-state/cloud-pipeline-runs';
import type { CoreCoworkInvoker } from '@canopy/app-state/core-cowork';
import type {
  CloudModelChoice,
  CloudModelPreflightResult,
  PipelineDefinition,
} from '@canopy/protocol/canopy-core';
import {
  Button,
  DialogModal,
  ErrorState,
  Notice,
  type SelectOption,
} from '@canopy/ui-shared/components';
import { pipelineDefinitionPublishesReview } from '@canopy/protocol/settings/github-review-approvals';
import {
  gitHubRepositoryOfPullRequestUrl,
  ReviewApprovalLaunchNotice,
  reviewApprovalReadinessInput,
} from '../../code/activity/ReviewApprovalLinkNotice';
import { CloudModelReplacementDialog } from '../../pipelines/CloudModelReplacementDialog';
import { PipelineInputField } from '../PipelineInputField';
import {
  buildInputPayload,
  initializeInputValues,
  validateInputValues,
  visibleInputDefinitions,
} from '../pipeline-input-form';
import { PipelineRunContextFields } from '../PipelineRunContextFields';
import { WORKFLOW_RUN_LOCATION_LABELS } from '../workflow-run-model';

export const CLOUD_WORKFLOW_RUN_DIALOG_COPY = {
  run: 'Run',
  starting: 'Starting…',
  cancel: 'Cancel',
  loading: 'Loading the workflow…',
  loadFailed: "Couldn't load this workflow.",
  noInputs: 'This workflow takes no inputs.',
  notStartable:
    'This workflow starts from an approved plan or a new task, not from here.',
} as const;

export interface CloudWorkflowRunDialogProps {
  /** The host's web core carrier. */
  readonly invoker: CoreCoworkInvoker;
  /** `curated:<key>` or `shared:canopy-cloud:<id>`. */
  readonly definitionId: string;
  /** Shown while the workflow loads. */
  readonly name: string;
  /** Who may own the run: Personal and the account's organizations. */
  readonly owners: readonly SelectOption[];
  /** The owner chosen first, such as the selected workspace context. */
  readonly initialOwner: string;
  readonly onClose: () => void;
  /** The run started; its execution id. */
  readonly onStarted: (executionId: string) => void;
  /**
   * The product name for the review approval "Link GitHub" notice above Run
   * (CAN-7162). Absent: no notice.
   */
  readonly reviewApprovalBrandName?: string;
}

type Loaded =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'ready'; readonly definition: PipelineDefinition };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts a cloud run of one workflow (CAN-6341): who owns it, the inputs it
 * declares, then the web core's start. Model steps the cloud can't run as
 * written are confirmed in the shared cloud model dialog first. Each launch
 * keeps one idempotency key until it settles, so Try again after an
 * uncertain answer never starts a second run. A cloud run goes to no
 * project, as on desktop (CP-36).
 */
export function CloudWorkflowRunDialog({
  invoker,
  definitionId,
  name,
  owners,
  initialOwner,
  onClose,
  onStarted,
  reviewApprovalBrandName,
}: CloudWorkflowRunDialogProps): JSX.Element {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    readCloudRunDefinition(invoker, definitionId).then(
      (definition) => {
        if (live) setLoaded({ status: 'ready', definition });
      },
      (error: unknown) => {
        if (live) setLoaded({ status: 'failed', message: messageOf(error) });
      },
    );
    return (): void => {
      live = false;
    };
  }, [attempt, definitionId, invoker]);

  const definition = loaded.status === 'ready' ? loaded.definition : null;
  const inputs = useMemo(
    () =>
      definition === null
        ? {}
        : visibleInputDefinitions(cloudRunInputDefinitions(definition)),
    [definition],
  );
  const eventName = definition === null ? null : cloudRunEventName(definition);

  const [owner, setOwner] = useState(initialOwner);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    setValues(initializeInputValues(inputs));
    setErrors({});
  }, [inputs]);

  // The review approval notice: a workflow that publishes a review, read for
  // the entered pull request's base repository under the selected owner (a
  // new owner re-reads). The library page has no workspace repository.
  const publishesReview =
    reviewApprovalBrandName !== undefined &&
    definition !== null &&
    pipelineDefinitionPublishesReview(definition.normalized);
  const reviewApprovalInputs = useMemo(() => {
    if (!publishesReview) return [];
    return Object.values(values).flatMap((value) => {
      const input = reviewApprovalReadinessInput(
        owner,
        gitHubRepositoryOfPullRequestUrl(value.trim()),
      );
      return input === null ? [] : [input];
    });
  }, [publishesReview, values, owner]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<{
    readonly preflight: CloudModelPreflightResult;
    /** Set when asked again: the earlier choices no longer apply. */
    readonly message: string | null;
  } | null>(null);
  // One key per launch (workflow, owner and inputs), kept until it settles.
  // A start whose answer was lost is sent again exactly, its confirmed
  // models included: the web core answers it with the run it recorded.
  const launchKey = useRef<{
    readonly request: string;
    readonly key: string;
    readonly modelChoices?: CloudPipelineRunLaunch['modelChoices'];
    readonly uncertain: boolean;
  } | null>(null);
  // A launch that settles after the dialog is gone does nothing more.
  // Set in the effect too: Strict Mode replays it after a cleanup.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  const launch = useCallback(
    async (
      modelChoices?: CloudPipelineRunLaunch['modelChoices'],
    ): Promise<void> => {
      if (eventName === null) return;
      const found = validateInputValues(inputs, values);
      setErrors(found);
      if (Object.keys(found).length > 0) return;
      const payload = buildInputPayload(inputs, values);
      const request = JSON.stringify([definitionId, owner, payload ?? {}]);
      const current =
        launchKey.current?.request === request ? launchKey.current : null;
      const sent =
        current?.uncertain === true ? current.modelChoices : modelChoices;
      const key = current?.key ?? crypto.randomUUID();
      const launched = {
        request,
        key,
        ...(sent === undefined ? {} : { modelChoices: sent }),
        uncertain: false,
      };
      launchKey.current = launched;
      setBusy(true);
      setError(null);
      try {
        const outcome = await launchCloudPipelineRun(invoker, {
          definitionId,
          owner,
          eventName,
          ...(payload === undefined ? {} : { inputs: payload }),
          ...(sent === undefined ? {} : { modelChoices: sent }),
          idempotencyKey: key,
        });
        if (!mounted.current) return;
        switch (outcome.kind) {
          case 'started':
            launchKey.current = null;
            setModels(null);
            onStarted(outcome.executionId);
            return;
          case 'models':
            // Nothing was recorded: the same key starts the run once the
            // models are confirmed.
            setModels({
              preflight: outcome.preflight,
              message: sent === undefined ? null : outcome.message,
            });
            return;
          case 'refused': {
            // A launch that couldn't be confirmed stays unconfirmed whatever
            // a later press of it is answered: only a start settles its key.
            const uncertain = outcome.uncertain || current?.uncertain === true;
            launchKey.current = uncertain ? { ...launched, uncertain } : null;
            setError(uncertain ? CLOUD_RUN_START_UNCERTAIN : outcome.message);
            return;
          }
        }
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [definitionId, eventName, inputs, invoker, onStarted, owner, values],
  );

  const confirmModels = useCallback(
    (choices: CloudModelChoice[]): void => {
      if (models === null) return;
      void launch({ preflight: models.preflight, choices });
    },
    [launch, models],
  );

  const ready = loaded.status === 'ready';
  const names = Object.keys(inputs);
  return (
    <>
      <DialogModal
        // A launch in flight finishes first: its run opens once it starts.
        onClose={(): void => {
          if (!busy) onClose();
        }}
        closeButtonDisabled={busy}
        maxWidth="lg"
        trapFocus
        closeOnEscape={!busy}
        dataTestId="cloud-workflow-run-dialog"
        title={`Run ${definition?.name ?? name}`}
        subtitle={`${WORKFLOW_RUN_LOCATION_LABELS.cloud} run`}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={onClose}
              data-testid="cloud-workflow-run-cancel"
            >
              {CLOUD_WORKFLOW_RUN_DIALOG_COPY.cancel}
            </Button>
            <Button
              variant="primary"
              disabled={!ready || eventName === null || busy}
              onClick={(): void => void launch()}
              data-testid="cloud-workflow-run-start"
            >
              {busy
                ? CLOUD_WORKFLOW_RUN_DIALOG_COPY.starting
                : CLOUD_WORKFLOW_RUN_DIALOG_COPY.run}
            </Button>
          </div>
        }
      >
        {loaded.status === 'loading' ? (
          <p role="status" className="text-s fg-secondary">
            {CLOUD_WORKFLOW_RUN_DIALOG_COPY.loading}
          </p>
        ) : loaded.status === 'failed' ? (
          <ErrorState
            testId="cloud-workflow-run-load-failed"
            message={`${CLOUD_WORKFLOW_RUN_DIALOG_COPY.loadFailed} ${loaded.message}`}
            onRetry={(): void => {
              setLoaded({ status: 'loading' });
              setAttempt((current) => current + 1);
            }}
          />
        ) : (
          <div className="flex flex-col gap-4">
            {eventName === null ? (
              <Notice intent="attention">
                {CLOUD_WORKFLOW_RUN_DIALOG_COPY.notStartable}
              </Notice>
            ) : null}
            {error !== null ? (
              <Notice
                errorSource="cloud-workflow-run-error"
                intent="destructive"
                data-testid="cloud-workflow-run-error"
              >
                {error}
              </Notice>
            ) : null}
            <PipelineRunContextFields
              disabled={busy}
              owner={
                owners.length > 1
                  ? {
                      kind: 'choose',
                      options: owners,
                      value: owner,
                      onChange: (next): void => {
                        setOwner(next);
                        setError(null);
                      },
                      stale: false,
                    }
                  : {
                      kind: 'fixed',
                      label:
                        owners.find((option) => option.value === owner)
                          ?.label ?? owner,
                    }
              }
            />
            {names.length === 0 ? (
              <p className="text-s fg-secondary">
                {CLOUD_WORKFLOW_RUN_DIALOG_COPY.noInputs}
              </p>
            ) : (
              <div
                className="flex flex-col gap-3"
                data-testid="cloud-workflow-run-inputs"
              >
                {names.map((inputName) => (
                  <PipelineInputField
                    key={inputName}
                    name={inputName}
                    definition={inputs[inputName] ?? {}}
                    value={values[inputName] ?? ''}
                    error={errors[inputName]}
                    onChange={(value): void => {
                      setValues((current) => ({
                        ...current,
                        [inputName]: value,
                      }));
                      setError(null);
                    }}
                  />
                ))}
              </div>
            )}
            {reviewApprovalBrandName !== undefined &&
            reviewApprovalInputs.length > 0 ? (
              <ReviewApprovalLaunchNotice
                inputs={reviewApprovalInputs}
                brandName={reviewApprovalBrandName}
              />
            ) : null}
          </div>
        )}
      </DialogModal>
      {models !== null ? (
        <CloudModelReplacementDialog
          key={
            models.preflight.definitionHash + models.preflight.policyFingerprint
          }
          preflight={models.preflight}
          busy={busy}
          error={error ?? models.message}
          onConfirm={confirmModels}
          onCancel={(): void => setModels(null)}
        />
      ) : null}
    </>
  );
}
