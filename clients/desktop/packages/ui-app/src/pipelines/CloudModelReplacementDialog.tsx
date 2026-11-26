'use client';

import { useId, useState, type JSX } from 'react';
import type {
  CloudModelChoice,
  CloudModelPreflightItem,
  CloudModelPreflightResult,
} from '@canopy/protocol/canopy-core';
import {
  Button,
  DialogFormField,
  DialogModal,
  Notice,
  SettingsSelect,
} from '@canopy/ui-shared/components';

export const CLOUD_MODEL_DIALOG_TEST_IDS = {
  dialog: 'cloud-model-replacement-dialog',
  stale: 'cloud-model-replacement-stale',
  item: 'cloud-model-replacement-item',
  select: 'cloud-model-replacement-select',
  unavailable: 'cloud-model-replacement-unavailable',
  confirm: 'cloud-model-replacement-confirm',
  cancel: 'cloud-model-replacement-cancel',
} as const;

export interface CloudModelReplacementDialogProps {
  /** The web core's cloud model preflight for the run or schedule. */
  readonly preflight: CloudModelPreflightResult;
  /** While the host saves the choices or starts the run. */
  readonly busy?: boolean;
  /** Why the last save or start failed, shown above the steps. */
  readonly error?: string | null;
  /** Called with one confirmed model for every listed step, never fewer. */
  readonly onConfirm: (choices: CloudModelChoice[]) => void;
  readonly onCancel: () => void;
}

/**
 * The confirmed choices, one per item, or null while any item has none or
 * names a model the item doesn't list. The dialog confirms only with these.
 */
export function confirmedCloudModelChoices(
  items: readonly CloudModelPreflightItem[],
  selected: Readonly<Record<string, string>>,
): CloudModelChoice[] | null {
  const choices: CloudModelChoice[] = [];
  for (const item of items) {
    const modelId = selected[item.itemKey];
    if (
      modelId === undefined ||
      !item.alternatives.some((option) => option.modelId === modelId)
    )
      return null;
    choices.push({ itemKey: item.itemKey, modelId });
  }
  return choices;
}

/**
 * The step an item names, or for a job's matrix model (CAN-7018) the job and
 * the variants it reaches, after the child workflows it runs in.
 */
function cloudModelItemLabel(item: CloudModelPreflightItem): string {
  const step =
    item.matrix === undefined
      ? (item.stepName ?? `${item.jobId}, step ${item.stepIndex + 1}`)
      : item.matrix.value === undefined
        ? `${item.jobId}, every variant`
        : `${item.jobId}, variants that use ${item.matrix.value}`;
  // A child workflow's step names the workflows it runs in (CAN-7044).
  return item.workflows === undefined
    ? step
    : [...item.workflows, step].join(' › ');
}

/** What an item uses and why it needs a cloud model. */
function itemDescription(item: CloudModelPreflightItem): string {
  const model = item.model === '' ? 'the default model' : item.model;
  // A matrix built while the run runs names no model yet.
  const uses =
    item.matrix !== undefined && item.matrix.value === undefined
      ? item.message
      : `Uses ${model}. ${item.message}`;
  return item.alternatives.length === 0
    ? `${uses} Run the workflow on this computer instead.`
    : uses;
}

/**
 * Asks the user to confirm a cloud model for each model step a cloud run
 * can't run as written (CAN-6174, plan CP-26). Every step starts with no
 * choice, including steps the user answered before the workflow or its
 * model policy changed, so a model is never picked on the user's behalf.
 * The host saves the confirmed choices for the workflow or schedule; the
 * workflow on the computer is not changed.
 */
export function CloudModelReplacementDialog({
  preflight,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: CloudModelReplacementDialogProps): JSX.Element {
  const [selected, setSelected] = useState<Record<string, string>>({});
  const idPrefix = useId();
  const choices = confirmedCloudModelChoices(preflight.items, selected);
  return (
    <DialogModal
      title="Choose cloud models"
      subtitle="Some agent steps can't run in the cloud as written. Choose a cloud model for each one. The workflow on this computer doesn't change."
      onClose={busy ? () => undefined : onCancel}
      maxWidth="lg"
      dataTestId={CLOUD_MODEL_DIALOG_TEST_IDS.dialog}
      trapFocus
      footer={
        <>
          <Button
            size="compact"
            variant="secondary"
            onClick={onCancel}
            disabled={busy}
            data-testid={CLOUD_MODEL_DIALOG_TEST_IDS.cancel}
          >
            Cancel
          </Button>
          <Button
            size="compact"
            variant="primary"
            loading={busy}
            disabled={choices === null}
            onClick={() => {
              if (choices !== null) onConfirm(choices);
            }}
            data-testid={CLOUD_MODEL_DIALOG_TEST_IDS.confirm}
          >
            Use these models
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pb-2">
        {preflight.saved === 'stale' && (
          <Notice
            intent="attention"
            data-testid={CLOUD_MODEL_DIALOG_TEST_IDS.stale}
          >
            This workflow or your organization's model policy changed since you
            last chose, so choose again.
          </Notice>
        )}
        {error !== null && (
          <Notice
            errorSource="cloud-model-replacement-dialog"
            intent="destructive"
          >
            {error}
          </Notice>
        )}
        {preflight.items.map((item) => {
          const fieldId = `${idPrefix}-${item.itemKey}`;
          return (
            <div
              key={item.itemKey}
              data-testid={CLOUD_MODEL_DIALOG_TEST_IDS.item}
              data-item-key={item.itemKey}
            >
              <DialogFormField
                label={cloudModelItemLabel(item)}
                htmlFor={fieldId}
                description={itemDescription(item)}
              >
                {item.alternatives.length === 0 ? (
                  <SettingsSelect
                    id={fieldId}
                    width="fill"
                    placeholder="No cloud model can run this step"
                    disabled
                    value={null}
                    options={[]}
                    onValueChange={() => undefined}
                    data-testid={CLOUD_MODEL_DIALOG_TEST_IDS.unavailable}
                  />
                ) : (
                  <SettingsSelect
                    id={fieldId}
                    width="fill"
                    placeholder="Choose a cloud model"
                    disabled={busy}
                    value={selected[item.itemKey] ?? null}
                    options={item.alternatives.map((option) => ({
                      value: option.modelId,
                      label: option.label,
                    }))}
                    onValueChange={(modelId) =>
                      setSelected((current) => ({
                        ...current,
                        [item.itemKey]: modelId,
                      }))
                    }
                    data-testid={CLOUD_MODEL_DIALOG_TEST_IDS.select}
                  />
                )}
              </DialogFormField>
            </div>
          );
        })}
      </div>
    </DialogModal>
  );
}
