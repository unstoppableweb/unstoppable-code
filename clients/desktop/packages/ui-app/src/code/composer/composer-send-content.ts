/**
 * Whether a chat composer has something to send, shared by the desktop and
 * web composers. Typed text, a file reference, or an attached file each count
 * on their own, so an image can be sent without typed text. Pass
 * `attachmentsCarried: false` where the send cannot carry the composer's
 * attachments (a queued-message edit, a terminal command, or a scheduled
 * send); those still need text or a file reference.
 */
export function composerHasSendableContent(input: {
  readonly text: string;
  readonly attachmentCount: number;
  readonly fileReferenceCount?: number;
  readonly attachmentsCarried?: boolean;
}): boolean {
  if (input.text.trim().length > 0) return true;
  if ((input.fileReferenceCount ?? 0) > 0) return true;
  return (input.attachmentsCarried ?? true) && input.attachmentCount > 0;
}
