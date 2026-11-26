import { type JSX, type KeyboardEvent, useState, useRef } from 'react';
import type { Job } from '@canopy/execution-engine/types/pipeline';
import { normalizeNeeds } from '@canopy/execution-engine/types/pipeline';
import { isValidPipelineIdentifier } from '../../../lib/pipelineEditor';
import { parseMaxIterationsInput } from '../../../lib/jobDetailPanel';
import { MAX_RETRIES_LIMIT } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import {
  Surface,
  Button,
  ChoiceList,
  ChoiceListRow,
} from '@canopy/ui-shared/components';
import { FormField } from '../shared/FormField';
import { TextField } from '../shared/TextField';
import { ToggleField } from '../shared/ToggleField';
import { KeyValueEditor } from '../shared/KeyValueEditor';
import { PipelineDetailPanelShell } from './PipelinePanelPrimitives';
import type { WorkflowJobStructure } from '@canopy/pipeline-interop/workflow-designer-job-edits';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

interface JobDetailPanelProps {
  jobId: string;
  job: Job;
  allJobIds: string[];
  onChange: (jobId: string, patch: Partial<Job>) => void;
  onRenameJob: (oldId: string, newId: string) => void;
  /**
   * Removes the job and the dependencies on it. An unsaved edit like any
   * other, so Undo brings it back.
   */
  onRemove?: (jobId: string) => void;
  onClose: () => void;
  readonly?: boolean;
  /**
   * Set in the Designer (CAN-4224 phase 08): what it holds back on the job's
   * dependencies. Its ID, outputs and Remove job stay out of reach there,
   * since workflows that run this one read them by name. Absent elsewhere,
   * where every field edits freely.
   */
  structure?: WorkflowJobStructure;
  /**
   * Keeps the condition read-only and says why. The Designer sets it on a
   * split's path, whose condition is the split's route guard.
   */
  conditionLockedReason?: string;
}

/**
 * A job's `if` as the field's text. YAML can hold a boolean or a number
 * there (`if: true`), which the field shows as written.
 */
function conditionText(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'boolean' || typeof value === 'number'
    ? String(value)
    : '';
}

function blurInputOnEnter(event: KeyboardEvent<HTMLInputElement>): void {
  if (event.key === 'Enter') {
    event.currentTarget.blur();
  }
}

export function JobDetailPanel({
  jobId,
  job,
  allJobIds,
  onChange,
  onRenameJob,
  onRemove,
  onClose,
  readonly = false,
  structure,
  conditionLockedReason,
}: JobDetailPanelProps): JSX.Element {
  // A path's condition is its route guard, wherever the split is drawn.
  const conditionLock =
    conditionLockedReason ??
    (structure?.splitPath
      ? 'A path runs on its route. Change its route from the split, or in YAML.'
      : undefined);
  const [localJobId, setLocalJobId] = useState(jobId);
  const [localName, setLocalName] = useState(job.name ?? '');
  const [localCondition, setLocalCondition] = useState(conditionText(job.if));
  const [localTimeout, setLocalTimeout] = useState(
    job.timeout_minutes !== undefined ? String(job.timeout_minutes) : '',
  );
  const [localMaxRetries, setLocalMaxRetries] = useState(
    job.max_retries !== undefined ? String(job.max_retries) : '',
  );
  const [localMaxIterations, setLocalMaxIterations] = useState(
    job.max_iterations !== undefined ? String(job.max_iterations) : '',
  );
  const [jobIdError, setJobIdError] = useState<string | null>(null);

  // Sync local state when the selected job changes externally
  const prevJobIdRef = useRef(jobId);
  if (prevJobIdRef.current !== jobId) {
    prevJobIdRef.current = jobId;
    setLocalJobId(jobId);
    setLocalName(job.name ?? '');
    setLocalCondition(conditionText(job.if));
    setLocalTimeout(
      job.timeout_minutes !== undefined ? String(job.timeout_minutes) : '',
    );
    setLocalMaxRetries(
      job.max_retries !== undefined ? String(job.max_retries) : '',
    );
    setLocalMaxIterations(
      job.max_iterations !== undefined ? String(job.max_iterations) : '',
    );
    setJobIdError(null);
  }

  // The same when the job changes under the panel, from the assistant or a
  // replaced draft: a field the person hasn't edited follows it, so leaving
  // that field can't write the old value back.
  const fromJob = {
    name: job.name ?? '',
    condition: conditionText(job.if),
    timeout:
      job.timeout_minutes !== undefined ? String(job.timeout_minutes) : '',
    retries: job.max_retries !== undefined ? String(job.max_retries) : '',
    iterations:
      job.max_iterations !== undefined ? String(job.max_iterations) : '',
  };
  const syncedRef = useRef(fromJob);
  const synced = syncedRef.current;
  if (
    synced.name !== fromJob.name ||
    synced.condition !== fromJob.condition ||
    synced.timeout !== fromJob.timeout ||
    synced.retries !== fromJob.retries ||
    synced.iterations !== fromJob.iterations
  ) {
    syncedRef.current = fromJob;
    if (localName === synced.name) setLocalName(fromJob.name);
    if (localCondition === synced.condition)
      setLocalCondition(fromJob.condition);
    if (localTimeout === synced.timeout) setLocalTimeout(fromJob.timeout);
    if (localMaxRetries === synced.retries) setLocalMaxRetries(fromJob.retries);
    if (localMaxIterations === synced.iterations)
      setLocalMaxIterations(fromJob.iterations);
  }

  const currentNeeds: string[] = normalizeNeeds(job.needs);
  const otherJobIds: string[] = allJobIds.filter(
    (id: string): boolean => id !== jobId,
  );

  function handleJobIdBlur(): void {
    const trimmed: string = localJobId.trim();
    if (!trimmed || trimmed === jobId) {
      setLocalJobId(jobId);
      setJobIdError(null);
      return;
    }
    if (!isValidPipelineIdentifier(trimmed)) {
      setJobIdError(
        'Must start with a letter or underscore, then letters/digits/underscores',
      );
      return;
    }
    if (allJobIds.includes(trimmed) && trimmed !== jobId) {
      setJobIdError('Job ID already in use');
      return;
    }
    setJobIdError(null);
    onRenameJob(jobId, trimmed);
  }

  function handleNameBlur(): void {
    // Untouched, it writes nothing, even where trimming would change it.
    if (localName === syncedRef.current.name) return;
    const trimmed: string = localName.trim();
    // The field then holds what the job does, so it reads as untouched and
    // follows the next change made under the panel.
    setLocalName(trimmed);
    if (trimmed !== (job.name ?? '')) {
      onChange(jobId, { name: trimmed || undefined });
    }
  }

  function handleConditionBlur(): void {
    if (localCondition === syncedRef.current.condition) return;
    const trimmed: string = localCondition.trim();
    setLocalCondition(trimmed);
    if (trimmed !== conditionText(job.if)) {
      onChange(jobId, { if: trimmed || undefined });
    }
  }

  function handleTimeoutBlur(): void {
    if (localTimeout === syncedRef.current.timeout) return;
    const trimmed: string = localTimeout.trim();
    if (!trimmed) {
      setLocalTimeout('');
      if (job.timeout_minutes !== undefined) {
        onChange(jobId, { timeout_minutes: undefined });
      }
      return;
    }
    const num: number = parseInt(trimmed, 10);
    if (Number.isNaN(num) || num <= 0) return;
    setLocalTimeout(String(num));
    if (num !== job.timeout_minutes) {
      onChange(jobId, { timeout_minutes: num });
    }
  }

  function handleMaxRetriesBlur(): void {
    if (localMaxRetries === syncedRef.current.retries) return;
    const trimmed: string = localMaxRetries.trim();
    if (!trimmed) {
      setLocalMaxRetries('');
      if (job.max_retries !== undefined) {
        onChange(jobId, { max_retries: undefined });
      }
      return;
    }

    const num: number = Number(trimmed);
    if (!Number.isSafeInteger(num) || num < 0 || num > MAX_RETRIES_LIMIT) {
      return;
    }

    if (num === 0) {
      setLocalMaxRetries('');
      if (job.max_retries !== undefined) {
        onChange(jobId, { max_retries: undefined });
      }
      return;
    }

    setLocalMaxRetries(String(num));
    if (num !== job.max_retries) {
      onChange(jobId, { max_retries: num });
    }
  }

  function handleMaxIterationsBlur(): void {
    if (localMaxIterations === syncedRef.current.iterations) return;
    const parsedValue = parseMaxIterationsInput(localMaxIterations);
    if (parsedValue === undefined) {
      setLocalMaxIterations('');
      if (job.max_iterations !== undefined) {
        onChange(jobId, { max_iterations: undefined });
      }
      return;
    }

    if (parsedValue === null) {
      return;
    }

    setLocalMaxIterations(String(parsedValue));
    if (parsedValue !== job.max_iterations) {
      onChange(jobId, { max_iterations: parsedValue });
    }
  }

  function handleNeedsToggle(depId: string): void {
    const isCurrentDep: boolean = currentNeeds.includes(depId);
    let updated: string[];
    if (isCurrentDep) {
      updated = currentNeeds.filter((d: string): boolean => d !== depId);
    } else {
      updated = [...currentNeeds, depId];
    }
    onChange(jobId, { needs: updated.length > 0 ? updated : undefined });
  }

  function handleContinueOnErrorChange(checked: boolean): void {
    onChange(jobId, { continue_on_error: checked || undefined });
  }

  return (
    <PipelineDetailPanelShell title="Job settings" onClose={onClose}>
      {/* Job ID */}
      <FormField
        label="Job ID"
        error={jobIdError ?? undefined}
        {...(structure
          ? {
              hint: 'Other jobs and workflows can read this ID, so change it in YAML or with the assistant.',
            }
          : {})}
      >
        <TextField
          value={localJobId}
          onChange={(e) => setLocalJobId(e.target.value)}
          onBlur={handleJobIdBlur}
          onKeyDown={blurInputOnEnter}
          placeholder="job_id"
          disabled={readonly || structure !== undefined}
        />
      </FormField>

      {/* Display Name */}
      <FormField label="Display name" hint="Optional friendly name">
        <TextField
          value={localName}
          onChange={(e) => setLocalName(e.target.value)}
          onBlur={handleNameBlur}
          onKeyDown={(e) =>
            e.key === 'Enter' && (e.target as HTMLInputElement).blur()
          }
          placeholder="Job name"
          disabled={readonly}
        />
      </FormField>

      {/* Dependencies (needs) */}
      {otherJobIds.length > 0 && (
        <FormField
          label="Dependencies"
          hint={
            structure?.splitPath
              ? 'A path runs after its split. Change paths from the split.'
              : structure &&
                  (structure.readNeeds.size > 0 ||
                    structure.dependents.size > 0)
                ? 'Jobs that must complete first. A job it reads by name stays, and a job that waits on it or a split’s path can’t be added.'
                : 'Jobs that must complete first'
          }
        >
          <ChoiceList aria-label="Dependencies">
            {otherJobIds.map((otherId: string) => (
              <ChoiceListRow
                key={otherId}
                selected={currentNeeds.includes(otherId)}
                onClick={() => handleNeedsToggle(otherId)}
                disabled={
                  readonly ||
                  structure?.splitPath === true ||
                  (currentNeeds.includes(otherId)
                    ? (structure?.readNeeds.has(otherId) ?? false)
                    : (structure?.dependents.has(otherId) ?? false) ||
                      (structure?.pathJobs.has(otherId) ?? false))
                }
              >
                {/* Job IDs are authored: never recorded. */}
                <span className={REPLAY_BLOCK_CLASS}>{otherId}</span>
              </ChoiceListRow>
            ))}
          </ChoiceList>
        </FormField>
      )}

      {/* Condition (if) */}
      <FormField
        label="Condition"
        hint={conditionLock ?? 'Expression that must be truthy to run'}
      >
        <TextField
          value={localCondition}
          onChange={(e) => setLocalCondition(e.target.value)}
          onBlur={handleConditionBlur}
          onKeyDown={(e) =>
            e.key === 'Enter' && (e.target as HTMLInputElement).blur()
          }
          placeholder="e.g. ${{ needs.build.result == 'success' }}"
          disabled={readonly || conditionLock !== undefined}
        />
      </FormField>

      {/* Environment Variables */}
      <FormField label="Environment variables">
        <KeyValueEditor
          value={job.env ?? {}}
          onChange={(env) =>
            onChange(jobId, {
              env: Object.keys(env).length > 0 ? env : undefined,
            })
          }
          readonly={readonly}
        />
      </FormField>

      {/* Outputs */}
      <FormField
        label="Outputs"
        hint={
          structure
            ? 'Other jobs and workflows can read these outputs, so change them in YAML or with the assistant.'
            : 'Values exposed to downstream jobs'
        }
      >
        <KeyValueEditor
          value={job.outputs ?? {}}
          onChange={(outputs) =>
            onChange(jobId, {
              outputs:
                Object.keys(outputs).length > 0
                  ? (outputs as Record<string, string>)
                  : undefined,
            })
          }
          stringOnly
          readonly={readonly || structure !== undefined}
        />
      </FormField>

      {/* Timeout */}
      <FormField label="Timeout (minutes)">
        <TextField
          type="number"
          value={localTimeout}
          onChange={(e) => setLocalTimeout(e.target.value)}
          onBlur={handleTimeoutBlur}
          onKeyDown={(e) =>
            e.key === 'Enter' && (e.target as HTMLInputElement).blur()
          }
          placeholder="No timeout"
          min={1}
          disabled={readonly}
        />
      </FormField>

      {/* Max Retries */}
      <FormField label="Max retries">
        <TextField
          type="number"
          value={localMaxRetries}
          onChange={(e) => setLocalMaxRetries(e.target.value)}
          onBlur={handleMaxRetriesBlur}
          onKeyDown={(e) =>
            e.key === 'Enter' && (e.target as HTMLInputElement).blur()
          }
          placeholder="No retries"
          min={0}
          disabled={readonly}
        />
      </FormField>

      <FormField label="Max iterations">
        <TextField
          type="number"
          value={localMaxIterations}
          onChange={(e) => setLocalMaxIterations(e.target.value)}
          onBlur={handleMaxIterationsBlur}
          onKeyDown={(e) =>
            e.key === 'Enter' && (e.target as HTMLInputElement).blur()
          }
          placeholder="Max total passes (0 skips job)"
          min={0}
          disabled={readonly}
        />
      </FormField>

      {/* Continue on Error */}
      <FormField label="Continue on error">
        <ToggleField
          checked={job.continue_on_error === true}
          onChange={handleContinueOnErrorChange}
          label="Continue on error"
          disabled={readonly}
        />
      </FormField>

      {/* Summary */}
      <Surface variant="section" boundary="top">
        <div className="flex items-center justify-between gap-2 pt-2">
          <p className="text-xs fg-secondary">
            {job.steps.length} step{job.steps.length !== 1 ? 's' : ''} in this
            job
          </p>
          {onRemove && !readonly && structure === undefined ? (
            <Button
              variant="ghost-destructive"
              size="compact"
              onClick={(): void => onRemove(jobId)}
              data-testid="pipeline-job-remove"
            >
              Remove job
            </Button>
          ) : null}
        </div>
      </Surface>
    </PipelineDetailPanelShell>
  );
}
