import {
  getModelDisplayName,
  resolveKnownModel,
} from '@canopy/desktop-shared/types';
import type { HomeModelRefusalReason } from './homeModelPreflight';

/**
 * CAN-5021 — the one source of copy for a first send its model refused.
 *
 * Every message names the attempted model and the way out. A billing cause is
 * named only when the pre-flight established it; a late `false`, exception,
 * or unexplained rejection uses `model-rejected`.
 */

export const FIRST_SEND_FAILED_TITLE = 'Couldn’t send';

export type HomeModelFailureCause = HomeModelRefusalReason | 'model-rejected';

/** What a model without a usable display name is called (UX writing). */
const FALLBACK_MODEL_LABEL = 'this model';
const MAX_MODEL_LABEL_LENGTH = 100;

function isUsableLabel(label: string): boolean {
  return (
    label.length > 0 &&
    label.length <= MAX_MODEL_LABEL_LENGTH &&
    Array.from(label).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}

/**
 * The catalog's display name for `model`. The display helper echoes an id it
 * has no name for, and a raw id the catalog does not know is not a name.
 */
export function homeModelDisplayLabel(model: string): string {
  const label = getModelDisplayName(model).trim();
  const unnamed = label === model && resolveKnownModel(model) === undefined;
  return !unnamed && isUsableLabel(label) ? label : FALLBACK_MODEL_LABEL;
}

export function homeModelFailureMessage(
  cause: HomeModelFailureCause,
  modelLabel: string,
): string {
  const label = modelLabel.trim();
  const model =
    label.length === 0 || label === FALLBACK_MODEL_LABEL ? 'This model' : label;
  switch (cause) {
    case 'needs-account':
      return `${model} needs an account and AI Credits. Choose another model or sign in.`;
    case 'needs-purchase':
      return `${model} isn’t included in your AI Credits yet. Choose another model.`;
    case 'not-routable':
      return `${model} isn’t available on AI Credits. Choose another model.`;
    case 'org-policy':
      return `${model} is blocked by your organization’s model policy. Choose another model.`;
    case 'org-gateway':
      return `${model} isn’t on your organization’s AI gateway. Choose another model.`;
    case 'unknown-model':
    case 'model-rejected':
      return `${model} couldn’t be used to start this chat. Choose another model.`;
  }
}
