/**
 * Shared artifacts (CAN-8015, docs/shared-artifacts.md): static content a
 * desktop user publishes and shares with a team, an organization or the
 * public, viewed on the web at `/share/artifacts/<id>`.
 *
 * Dependency-free (no Zod, Node or network) so renderer, main and web import
 * the same constants. The `core.sharedArtifact.*` schemas live in
 * `canopy-core/core/sharedArtifact/operations.ts` and import from here.
 *
 * Quota accounting: an owner's usage is the sum of plaintext `byteLength` over
 * the retained revisions of every artifact it governs. A team-owned artifact
 * counts against the team's organization; a `private` artifact counts against
 * its owner's personal quota. Open uploads do not count. A write is checked
 * against usage after its own retirement of the oldest revision, so replacing
 * a revision at the retention cap is charged only the difference. `stage`
 * checks quota as an early refusal; `commit`, `republish` and
 * `updateAudience` enforce it in their transaction. `updateAudience` changes
 * the owner, so it moves the artifact's whole usage to the new owner's quota.
 */
import type { ShareScope } from '../sharing';

export const SHARED_ARTIFACT_KINDS = [
  'html',
  'markdown',
  'image',
  'pdf',
] as const;
export type SharedArtifactKind = (typeof SHARED_ARTIFACT_KINDS)[number];

/**
 * The accepted media types per kind: bare, lower-case types without
 * parameters. Text kinds are UTF-8 by definition.
 */
export const SHARED_ARTIFACT_MEDIA_TYPES = {
  html: ['text/html'],
  markdown: ['text/markdown'],
  image: [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
  ],
  pdf: ['application/pdf'],
} as const satisfies Readonly<
  Record<SharedArtifactKind, readonly [string, ...string[]]>
>;
export type SharedArtifactMediaType =
  (typeof SHARED_ARTIFACT_MEDIA_TYPES)[SharedArtifactKind][number];

/** Every accepted media type, across kinds. */
export const SHARED_ARTIFACT_ALL_MEDIA_TYPES = [
  ...SHARED_ARTIFACT_MEDIA_TYPES.html,
  ...SHARED_ARTIFACT_MEDIA_TYPES.markdown,
  ...SHARED_ARTIFACT_MEDIA_TYPES.image,
  ...SHARED_ARTIFACT_MEDIA_TYPES.pdf,
] as const;

/**
 * Exact, case-sensitive match on the bare lower-case type. A value with
 * parameters (`text/html; charset=utf-8`) is refused; callers normalize
 * before staging.
 */
export function isSharedArtifactMediaTypeForKind(
  kind: SharedArtifactKind,
  mediaType: string,
): boolean {
  const accepted: readonly string[] = SHARED_ARTIFACT_MEDIA_TYPES[kind];
  return accepted.includes(mediaType);
}

/** 8 MiB of plaintext per revision. */
export const MAX_SHARED_ARTIFACT_BYTES = 8 * 1024 * 1024;
/** The latest 20 revisions are retained; older ones are retired. */
export const MAX_SHARED_ARTIFACT_RETAINED_REVISIONS = 20;
/** Quota per organization (team-owned artifacts count against it). */
export const SHARED_ARTIFACT_ORGANIZATION_QUOTA_BYTES = 1024 * 1024 * 1024;
/** Quota per personal account (`private` artifacts). */
export const SHARED_ARTIFACT_PERSONAL_QUOTA_BYTES = 100 * 1024 * 1024;
export const MAX_SHARED_ARTIFACT_TITLE_LENGTH = 256;
export const SHARED_ARTIFACT_LIST_DEFAULT_LIMIT = 20;
export const SHARED_ARTIFACT_LIST_MAX_LIMIT = 50;
/** Report detail limit; also the takedown note limit. */
export const MAX_SHARED_ARTIFACT_REPORT_DETAIL_LENGTH = 1000;
export const MAX_SHARED_ARTIFACT_AUTOMATION_ID_LENGTH = 128;
export const MAX_SHARED_ARTIFACT_AUTOMATION_LABEL_LENGTH = 256;

/**
 * The stored audience: exactly the server share scopes. Public is a flag over
 * an artifact with any of these owners, not a scope.
 */
export type SharedArtifactShareScope = ShareScope;
export const SHARED_ARTIFACT_SHARE_SCOPES = [
  'private',
  'team',
  'organization',
] as const satisfies readonly SharedArtifactShareScope[];
// Fails to compile if ShareScope gains a value this list lacks.
type MissingShareScope = Exclude<
  SharedArtifactShareScope,
  (typeof SHARED_ARTIFACT_SHARE_SCOPES)[number]
>;
const SHARE_SCOPES_COMPLETE: [MissingShareScope] extends [never]
  ? true
  : never = true;
void SHARE_SCOPES_COMPLETE;

/** Why a viewer reports an artifact; also a takedown reason. */
export const SHARED_ARTIFACT_REPORT_REASONS = [
  'malware_or_phishing',
  'illegal_content',
  'harassment',
  'private_information',
  'spam',
  'other',
] as const;
export type SharedArtifactReportReason =
  (typeof SHARED_ARTIFACT_REPORT_REASONS)[number];

/** The web page that shows an artifact. */
export function sharedArtifactSharePath(artifactId: string): string {
  return `/share/artifacts/${encodeURIComponent(artifactId)}`;
}

/** The web route that streams the latest revision's bytes. */
export function sharedArtifactContentPath(artifactId: string): string {
  return `/api/v1/shared-artifacts/${encodeURIComponent(artifactId)}/content`;
}

/**
 * The web route that accepts a staged upload's bytes: `PUT` with a desktop
 * key and exactly the staged `Content-Length`. 204 means stored. 429 (this
 * account already has 3 uploads in flight on the server) and 503 (the server
 * is busy, or storage is unavailable) are retried with the same upload: after
 * `Retry-After` when it is sent, otherwise after a short backoff (5 s,
 * doubling). 408 means the body took longer than a minute plus 1 second per
 * 64 KiB; send it again. 409 means the upload expired or was committed:
 * stage a new one. 404, 411 and 422 are not retried.
 */
export function sharedArtifactUploadPath(uploadId: string): string {
  return `/api/v1/shared-artifacts/uploads/${encodeURIComponent(uploadId)}`;
}

/**
 * The signed-out report route (CAN-8016): `POST` a `SharedArtifactReportBody`
 * as JSON. Signed-in viewers may use it or `core.sharedArtifact.report`.
 */
export const SHARED_ARTIFACT_REPORT_PATH = '/api/v1/shared-artifacts/reports';

/**
 * The content route always answers `application/octet-stream`; this header
 * carries the revision's media type for the viewer to render.
 */
export const SHARED_ARTIFACT_MEDIA_TYPE_HEADER = 'x-canopy-artifact-media-type';
