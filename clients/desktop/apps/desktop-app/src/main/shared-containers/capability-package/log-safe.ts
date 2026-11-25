/**
 * Text that leaves a capability install for main.log (CAN-7615). Names come
 * from whoever shared the container, and validator errors can quote a key or
 * a value from its documents, so none of it reaches the log when it looks
 * like a secret. main.log goes into feedback bundles.
 */
import { findSecretMaterialRule } from '@canopy/protocol/capability-files';
import { findSharedTextCredentialRule } from '@canopy/protocol/shared-containers';

/** A definition's name when the name itself looks like a secret. */
export const UNNAMED_DEFINITION = 'A definition from this share';

/** A validator error that quotes something secret-shaped. */
export const WITHHELD_FIELD_ERROR =
  'a field holds text that looks like a credential';

/** A whole logged message that still holds something secret-shaped. */
export const WITHHELD_ERROR =
  'Capability install error withheld because it looks like it holds a credential';

/** The name to show for a definition, checked as the refusal warnings check it. */
export function nameForMessage(name: string): string {
  return findSharedTextCredentialRule(name) === null
    ? name
    : UNNAMED_DEFINITION;
}

/** One validator error, unless it quotes a secret-shaped key or value. */
export function loggableError(text: string): string {
  return findSharedTextCredentialRule(text) === null
    ? text
    : WITHHELD_FIELD_ERROR;
}

/**
 * The last check before a log line: the broadest one, since a withheld log
 * message only costs debugging detail.
 */
export function logSafeText(text: string): string {
  return findSharedTextCredentialRule(text) === null &&
    findSecretMaterialRule(text) === null
    ? text
    : WITHHELD_ERROR;
}

export interface LogSafeError {
  error: string;
  errorType: string;
  definitionKind?: string;
}

/** An error as plain log fields: never the error object, its stack or its cause. */
export function logSafeError(error: unknown): LogSafeError {
  if (!(error instanceof Error))
    return { error: logSafeText(String(error)), errorType: typeof error };
  const kind =
    'definitionKind' in error && typeof error.definitionKind === 'string'
      ? error.definitionKind
      : undefined;
  return {
    error: logSafeText(error.message),
    errorType: error.name,
    ...(kind === undefined ? {} : { definitionKind: kind }),
  };
}
