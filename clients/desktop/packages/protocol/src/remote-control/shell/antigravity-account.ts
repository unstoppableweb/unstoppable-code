import { z } from 'zod';

/** Longest plan label accepted from the runtime's session metadata. */
export const ANTIGRAVITY_PLAN_LABEL_MAX_LENGTH = 64;

/** Control and format characters (including bidi overrides and zero-width). */
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

/**
 * Whether a runtime-reported plan name is safe to show: non-empty, bounded,
 * and free of control or format characters that could spoof the label.
 */
export function isAntigravityPlanLabel(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= ANTIGRAVITY_PLAN_LABEL_MAX_LENGTH &&
    value.trim() === value &&
    !HIDDEN_CHARACTERS.test(value)
  );
}

/**
 * What the desktop knows about the Google account behind Antigravity chats.
 * The pinned runtime reports only a plan label with each session. It is not
 * account identity, quota, a usage period or a billing signal, and no usage
 * limits are reported. `unavailable` means the last read failed, never that
 * the user signed out.
 */
export interface AntigravityAccountSnapshot {
  status: 'ready' | 'unavailable';
  updatedAt: string;
  /**
   * Only with `ready`, and absent when the runtime did not report a plan.
   * Kept flat (like the OpenCode snapshot) so every binding, including the
   * generated mobile one, carries the fields; the schema enforces the pairing.
   */
  planLabel?: string;
}

/** Display metadata only. Never accepts credentials or account identifiers. */
export const antigravityAccountSnapshotSchema: z.ZodType<AntigravityAccountSnapshot> =
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('ready'),
      updatedAt: z.string().datetime({ offset: true }),
      planLabel: z.string().refine(isAntigravityPlanLabel).optional(),
    }),
    z.object({
      status: z.literal('unavailable'),
      updatedAt: z.string().datetime({ offset: true }),
    }),
  ]);
