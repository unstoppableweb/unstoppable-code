import {
  AppErrorCopySchema,
  AppErrorDetailSchema,
  createAppError,
  toAppError,
  type AppError,
} from '@canopy/protocol/app-errors';

const MAX_TITLE_LENGTH = AppErrorCopySchema.shape.title.maxLength ?? 256;
const MAX_MESSAGE_LENGTH = AppErrorDetailSchema.shape.message.maxLength ?? 4096;

/**
 * A failure of the person's own work: a script, hook or terminal command that
 * exited nonzero or timed out, or a workflow that finished failed. Nothing here
 * is an app defect, so it has no recording, reference or Report this.
 */
export function ownWorkToastError(title: string): AppError {
  const trimmed = title.trim();
  return createAppError(
    'input.not_accepted',
    trimmed === ''
      ? {}
      : { copy: { title: trimmed.slice(0, MAX_TITLE_LENGTH) } },
  );
}

/**
 * A failure the app cannot yet classify, which may offer Report this until
 * CAN-5118 tells external failures apart. Keep the failure when supplied;
 * feedback redacts it before export. Missing or blank text keeps catalog detail.
 */
export function unclassifiedToastError(failure?: unknown): AppError {
  if (typeof failure === 'string')
    return createAppError(
      'app.unexpected',
      failure.trim().length === 0
        ? {}
        : {
            // A returned string has no caught stack; never invent one here.
            detail: {
              name: 'Error',
              message: failure.slice(0, MAX_MESSAGE_LENGTH),
            },
          },
    );
  return (
    (failure === undefined ? undefined : toAppError(failure)) ??
    createAppError('app.unexpected')
  );
}
