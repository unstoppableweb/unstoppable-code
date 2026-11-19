import { z } from 'zod';
import { isBillingWebReturnPath } from '@canopy/protocol/billing';

function hasUnsafeCloudPageCharacters(value: string): boolean {
  return (
    /[\s\\]/.test(value) ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  );
}

/** Validate before URL parsing can trim whitespace or normalize backslashes. */
export const authenticatedCloudPagePathSchema = z
  .string()
  .refine(
    (value) =>
      isBillingWebReturnPath(value) && !hasUnsafeCloudPageCharacters(value),
  );

/** An asserted web origin, never a destination URL or credential. */
export function normalizeAuthenticatedCloudPageOrigin(
  value: unknown,
): string | null {
  if (
    typeof value !== 'string' ||
    hasUnsafeCloudPageCharacters(value) ||
    /[?#]/.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    if (
      !/^https?:\/\/[^/]+\/?$/i.test(value) ||
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      /^https?:\/\/[^/]*@/i.test(value) ||
      url.pathname !== '/'
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

export const authenticatedCloudPageRequestSchema = z.strictObject({
  requireAuthentication: z.literal(true),
  kind: z.enum(['signed-in', 'payment']),
  path: authenticatedCloudPagePathSchema,
  accountId: z.string().min(1).max(256),
  webOrigin: z
    .string()
    .refine((value) => normalizeAuthenticatedCloudPageOrigin(value) !== null),
});

export type AuthenticatedCloudPageRequest = z.infer<
  typeof authenticatedCloudPageRequestSchema
>;

export const authenticatedCloudPageResultSchema = z.union([
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum([
      'unavailable',
      'identity_changed',
      'failed',
      'browser_failed',
    ]),
  }),
]);

export type AuthenticatedCloudPageResult = z.infer<
  typeof authenticatedCloudPageResultSchema
>;

/** Classify a validated path without rebuilding its query or fragment. */
export function classifyAuthenticatedCloudPagePath(
  value: unknown,
): AuthenticatedCloudPageRequest['kind'] | null {
  const path = authenticatedCloudPagePathSchema.safeParse(value);
  if (!path.success) return null;
  const url = new URL(path.data, 'https://portal.invalid');
  const pathname = url.pathname;
  if (
    /^\/account\/billing(?:\/|$)/.test(pathname) ||
    /^\/organization\/[^/]+\/billing(?:\/|$)/.test(pathname) ||
    (/^\/organization\/[^/]+\/settings\/?$/.test(pathname) &&
      url.searchParams.getAll('tab').includes('billing')) ||
    /^\/(subscribe|checkout)\/?$/.test(pathname)
  )
    return 'payment';
  return 'signed-in';
}
