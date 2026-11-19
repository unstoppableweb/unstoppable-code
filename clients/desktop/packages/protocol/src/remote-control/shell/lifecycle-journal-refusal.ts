/**
 * CAN-5335: an entry in the desktop's destructive lifecycle journal that can't
 * be read or parsed refuses every project's destructive work. The desktop
 * announces this capability when it can inspect and quarantine such an entry.
 *
 * This module stays free of schemas: refusal surfaces on every route import
 * it, and the review's zod schemas load only once a review opens.
 */
export const REMOTE_CONTROL_CAPABILITY_LIFECYCLE_JOURNAL_QUARANTINE =
  'lifecycle_journal_quarantine' as const;

/**
 * Refusal copy that desktop IPC and Portal command failures carry verbatim.
 * Clients recognize the refusal by it, since only the message crosses either
 * transport.
 */
export const LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL =
  "A destructive operation record can't be read, so its owner can't be determined. Deleting and archiving stay paused for every project until it's moved to quarantine.";
export const LIFECYCLE_JOURNAL_DIRECTORY_UNREADABLE_REFUSAL =
  "The destructive operation records can't be listed. Deleting and archiving stay paused for every project until the folder can be read.";

/** The refusal either transport delivered, by its message. */
export function lifecycleJournalRefusalKind(
  error: unknown,
): 'unreadable-entry' | 'directory-unreadable' | null {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  if (message.includes(LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL))
    return 'unreadable-entry';
  if (message.includes(LIFECYCLE_JOURNAL_DIRECTORY_UNREADABLE_REFUSAL))
    return 'directory-unreadable';
  return null;
}
