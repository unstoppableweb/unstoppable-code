import { brandText } from '@/lib/brand';

export const DRAFT_RESTORE_FAILED_TITLE = "Couldn't restore your draft.";
export const DRAFT_RESTORE_FAILED_MESSAGE =
  "The text saved in this chat couldn't be read.";

export const DRAFT_SAVE_FAILED_TITLE = "Couldn't save your draft.";
export function draftSaveFailedMessage(): string {
  return `It's kept while ${brandText.appName} is open, but won't be restored after you quit.`;
}

// Both notices sit in the composer's notice stack beside others with their
// own Dismiss buttons, so the accessible name says which one this is.
export const DRAFT_NOTICE_DISMISS_LABEL = 'Dismiss draft notice';
