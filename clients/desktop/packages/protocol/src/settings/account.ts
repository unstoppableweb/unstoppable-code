/**
 * Personal account settings wire contracts, shared by the web route handlers,
 * the web account pages, and the hosted settings table that desktop executes.
 *
 * Moved from `apps/web/src/lib/account-api-contracts.ts`, which re-exports
 * every symbol here so existing web imports keep working. Fields, ids, date
 * strings and error strings are unchanged. Everything here is isomorphic: no
 * Node, browser, Next or Electron API.
 */

import type { CanopyPlanTier, SocialLink } from '../profile/index';

export type { CanopyPlanTier, SocialLink } from '../profile/index';

/* -------------------------------------------------------------------------- */
/* Provider identifiers                                                       */
/* -------------------------------------------------------------------------- */

/** OAuth social providers offered for sign-in and account linking. */
export const SOCIAL_PROVIDER_IDS = ['google', 'github'] as const;

/** A social provider id: `'google'` or `'github'`. */
export type SocialProviderId = (typeof SOCIAL_PROVIDER_IDS)[number];

/**
 * Unstoppable Domains OAuth provider id.
 *
 * UD sign-in runs through Better Auth's `genericOAuth` plugin, NOT the built-in
 * `socialProviders` config — so it is intentionally kept OUT of
 * {@link SOCIAL_PROVIDER_IDS}, the built-in provider list. Since Better Auth
 * 1.7, genericOAuth providers are reached through the same `signIn.social` /
 * `linkSocial` client methods, with this id as `provider`.
 */
export const UD_PROVIDER_ID = 'unstoppable-domains' as const;

/** The literal type of {@link UD_PROVIDER_ID}. */
export type UdProviderId = typeof UD_PROVIDER_ID;

/**
 * Canopy single-sign-on provider id.
 *
 * This generic-OAuth id must not be added to {@link SOCIAL_PROVIDER_IDS} or
 * Better Auth's trusted providers. Trusted membership would bypass the
 * per-sign-in `emailVerified` check used for safe email-match auto-linking.
 */
export const SSO_SERVER_PROVIDER_ID = 'sso-server' as const;

/** The literal type of {@link SSO_SERVER_PROVIDER_ID}. */
export type SsoServerProviderId = typeof SSO_SERVER_PROVIDER_ID;

/**
 * Provider id for any login-page button that shows a per-provider loading
 * state: the built-in social providers plus the genericOAuth providers (UD and
 * Canopy SSO).
 */
export type LoginButtonProviderId =
  | SocialProviderId
  | UdProviderId
  | SsoServerProviderId;

/**
 * Email/password provider id.
 *
 * Better Auth stores email/password credentials under the account
 * `providerId = 'credential'` (NOT `'email-password'`). This string is shared by
 * the server config, the auth-sources listing (B3), and the unlink route (B4).
 */
export const CREDENTIAL_PROVIDER_ID = 'credential';

/** The literal type of {@link CREDENTIAL_PROVIDER_ID}. */
export type CredentialProviderId = typeof CREDENTIAL_PROVIDER_ID;

/** Any provider id Canopy recognizes by name. */
export type KnownAuthProviderId =
  | SocialProviderId
  | CredentialProviderId
  | UdProviderId
  | SsoServerProviderId;

/**
 * Helper that preserves literal autocomplete in a string union while still
 * accepting any other string (Better Auth may report providers we do not name).
 */
type LooseString = string & Record<never, never>;

/**
 * Provider id as it appears on the wire. Known ids are surfaced for editor hints
 * while still accepting any string Better Auth might report (Contract B3).
 */
export type AuthProviderId = KnownAuthProviderId | LooseString;

/** Human-readable labels for each known provider id (Contract B3). */
export const AUTH_SOURCE_LABELS: Record<KnownAuthProviderId, string> = {
  google: 'Google',
  github: 'GitHub',
  credential: 'Email and password',
  [UD_PROVIDER_ID]: 'Unstoppable Domains',
  [SSO_SERVER_PROVIDER_ID]: 'Single Sign-On',
};

/** Narrow a wire provider id to one with a known display label. */
export function isKnownAuthProviderId(
  providerId: string,
): providerId is KnownAuthProviderId {
  return Object.prototype.hasOwnProperty.call(AUTH_SOURCE_LABELS, providerId);
}

/**
 * Map a provider id to its display label, falling back to the raw id for
 * providers without a configured label. Encodes the Contract B3 label mapping in
 * one place so the route handler and the UI cannot disagree.
 */
export function authSourceLabel(providerId: AuthProviderId): string {
  return isKnownAuthProviderId(providerId)
    ? AUTH_SOURCE_LABELS[providerId]
    : providerId;
}

/**
 * The cloud chat surface, and the ONLY page a browser guest (anonymous
 * session) may reach (REG-2784). Declared once so the proxy carve-out, the
 * protected layout's guest gate, and the page itself share one literal — three
 * copies of `'/chat'` that can drift is how a guest ends up either locked out
 * of its own surface or loose on the rest of the app.
 */
export const CHAT_PAGE = '/chat';

/* -------------------------------------------------------------------------- */
/* Shared response primitives                                                 */
/* -------------------------------------------------------------------------- */

/** Standard success envelope for routes that only confirm completion. */
export interface OkResponse {
  ok: true;
}

/** Standard error envelope: every error response body is `{ error: string }`. */
export interface ApiErrorResponse {
  error: string;
}

/* -------------------------------------------------------------------------- */
/* Contract B1 / B2 — /api/account/two-factor/session                         */
/* -------------------------------------------------------------------------- */

/** Request body for `POST /api/account/two-factor/session` (Contract B1). */
export type TwoFactorSessionPurpose = 'login' | 'setup';

export interface TwoFactorSessionRequest {
  /** TOTP code (or backup code) entered by the user. */
  code: string;
  /** When true, the completion cookie persists for 30 days (see Contract D). */
  trustDevice?: boolean;
  /** Login accepts backup codes; initial setup must verify TOTP only. */
  purpose?: TwoFactorSessionPurpose;
}

/** `200` body for `POST /api/account/two-factor/session` (Contract B1). */
export type TwoFactorSessionResponse = OkResponse;

/** `401` error message for an invalid TOTP/backup code (Contract B1). */
export const TWO_FACTOR_INVALID_CODE_ERROR = 'Invalid verification code';

/* -------------------------------------------------------------------------- */
/* Contract B3 — GET /api/account/auth-sources                                */
/* -------------------------------------------------------------------------- */

/** A single linked authentication source (Contract B3). */
export interface AuthSource {
  /**
   * `'google' | 'github' | 'credential' | 'unstoppable-domains' | 'sso-server'`,
   * or any other id Better Auth reports.
   */
  providerId: AuthProviderId;
  /**
   * Opaque Better Auth account id. Pass it through byte-for-byte for unlinking;
   * never parse, truncate, or render it.
   */
  accountId: string;
  /**
   * Display label, e.g. `'Google'`, `'GitHub'`, `'Email and password'`,
   * `'Unstoppable Domains'`, `'Single Sign-On'`.
   */
  label: string;
  /** ISO-8601 timestamp of when the source was linked. */
  linkedAt: string;
  /** False when this is the only remaining auth source (cannot be removed). */
  canUnlink: boolean;
}

/** Account summary embedded in the auth-sources response (Contract B3). */
export interface AuthSourcesUser {
  name: string;
  email: string;
  twoFactorEnabled: boolean;
}

/** `200` body for `GET /api/account/auth-sources` (Contract B3). */
export interface AuthSourcesResponse {
  user: AuthSourcesUser;
  sources: AuthSource[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAuthSource(value: unknown): value is AuthSource {
  return (
    isRecord(value) &&
    typeof value.providerId === 'string' &&
    typeof value.accountId === 'string' &&
    typeof value.label === 'string' &&
    typeof value.linkedAt === 'string' &&
    typeof value.canUnlink === 'boolean'
  );
}

function isAuthSourcesUser(value: unknown): value is AuthSourcesUser {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.email === 'string' &&
    typeof value.twoFactorEnabled === 'boolean'
  );
}

export function isAuthSourcesResponse(
  value: unknown,
): value is AuthSourcesResponse {
  return (
    isRecord(value) &&
    isAuthSourcesUser(value.user) &&
    Array.isArray(value.sources) &&
    value.sources.every(isAuthSource)
  );
}

export function isOkResponse(value: unknown): value is OkResponse {
  return isRecord(value) && value.ok === true;
}

/* -------------------------------------------------------------------------- */
/* Contract B4 — DELETE /api/account/auth-sources/[providerId]                */
/* -------------------------------------------------------------------------- */

/** Optional request body for the unlink route (Contract B4). */
export interface DeleteAuthSourceRequest {
  /** Disambiguates which account to unlink when several share a provider. */
  accountId?: string;
}

/** `400` error returned when unlinking the last remaining auth source (B4). */
export const LAST_AUTH_SOURCE_ERROR =
  'Add another sign-in method before removing this one.';

/* -------------------------------------------------------------------------- */
/* Contract B5 — POST /api/account/password                                   */
/* -------------------------------------------------------------------------- */

/** Request body for `POST /api/account/password` (Contract B5). */
export interface SetPasswordRequest {
  newPassword: string;
}

/** `200` body for `POST /api/account/password` (Contract B5). */
export type SetPasswordResponse = OkResponse;

/** `400` error for password validation / already-set (Contract B5). */
export const SET_PASSWORD_ERROR = 'Unable to set password.';

/** Structured `code` for a password found in known breach data. */
export const PASSWORD_COMPROMISED_CODE = 'PASSWORD_COMPROMISED';

/** Shared copy for {@link PASSWORD_COMPROMISED_CODE} on every password form. */
export const PASSWORD_COMPROMISED_ERROR =
  'This is a commonly used password. Attackers try these first, so choose a different one.';

/** Minimum password length enforced server-side (Contract B5). */
export const PASSWORD_MIN_LENGTH = 12;

/** Maximum password length enforced server-side (Contract B5). */
export const PASSWORD_MAX_LENGTH = 128;

/* -------------------------------------------------------------------------- */
/* Contract B7 — Profile owner editable name + custom avatar                  */
/* -------------------------------------------------------------------------- */

/** Minimum trimmed length for an editable display name (matches VarChar(256)). */
export const PROFILE_NAME_MIN_LENGTH = 1;

/** Maximum trimmed length for an editable display name (matches VarChar(256)). */
export const PROFILE_NAME_MAX_LENGTH = 256;

/** MIME types accepted for a custom profile avatar upload. */
export const ALLOWED_AVATAR_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
] as const;

/** A MIME type accepted for avatar uploads. */
export type AllowedAvatarMimeType = (typeof ALLOWED_AVATAR_MIME_TYPES)[number];

/** Maximum avatar upload size in bytes (5 MiB). */
export const MAX_AVATAR_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Narrow an arbitrary value to a supported avatar MIME type. */
export function isAllowedAvatarMimeType(
  value: unknown,
): value is AllowedAvatarMimeType {
  return (
    typeof value === 'string' &&
    ALLOWED_AVATAR_MIME_TYPES.some((mime) => mime === value)
  );
}

/** Request body for `PATCH /api/account/profile`. */
export interface UpdateProfileRequest {
  /** New display name (trimmed, 1–256 chars). */
  name?: string;
  /**
   * `null` clears the avatar back to initials. Setting a new avatar is not done
   * here — it goes through the moderated avatar upload/commit flow — so this
   * route only accepts `null`.
   */
  image?: null;
}

/** `200` body for `PATCH /api/account/profile`. */
export interface UpdateProfileResponse {
  name: string;
  image: string | null;
}

/** `400` error for invalid profile updates. */
export const UPDATE_PROFILE_ERROR = 'Unable to update profile.';

/** Request body for `POST /api/account/profile/avatar/upload-url`. */
export interface AvatarUploadUrlRequest {
  mimeType: AllowedAvatarMimeType;
  size: number;
}

/** `200` body for `POST /api/account/profile/avatar/upload-url`. */
export interface AvatarUploadUrlResponse {
  /** Object path inside the quarantine bucket the client will PUT to. */
  filePath: string;
  /** Signed v4 write URL the client PUTs the file bytes to. */
  uploadUrl: string;
}

/** `400` error when an avatar upload URL cannot be issued. */
export const AVATAR_UPLOAD_ERROR = 'Unable to prepare avatar upload.';

/** Request body for `POST /api/account/profile/avatar/commit`. */
export interface AvatarCommitRequest {
  /** Quarantine object path previously returned by the upload-url route. */
  filePath: string;
}

/** `200` body for `POST /api/account/profile/avatar/commit`. */
export interface AvatarCommitResponse {
  /** Public URL of the moderated + published avatar. */
  image: string;
}

/** `400` error when an avatar cannot be committed/published. */
export const AVATAR_COMMIT_ERROR = 'Unable to save avatar.';

/** `422` error when an uploaded avatar fails image moderation. */
export const AVATAR_MODERATION_ERROR = 'This image did not pass moderation.';

/* -------------------------------------------------------------------------- */
/* Contract B6 — Shared auth-gating errors                                    */
/* -------------------------------------------------------------------------- */

/**
 * Error messages returned by the shared session gate (Contract B6). Frontend
 * code matches on {@link TWO_FACTOR_REQUIRED_ERROR} (a `403`) to route the user
 * to the 2FA page.
 */
export const AUTH_GATE_ERRORS = {
  /** `401` — no Better Auth session. */
  unauthorized: 'Unauthorized',
  /** `403` — session user is not `ACTIVE`. */
  inactive: 'User account is not active',
  /** `403` — 2FA enabled but the completion cookie is missing/invalid. */
  twoFactorRequired: 'Two-factor verification required',
} as const;

/**
 * `403` error body string emitted when a 2FA-enabled user has not satisfied the
 * completion cookie (Contract B6). Frontend routes this case to `/two-factor`.
 */
export const TWO_FACTOR_REQUIRED_ERROR = AUTH_GATE_ERRORS.twoFactorRequired;

/* -------------------------------------------------------------------------- */
/* Route paths (Contract B)                                                   */
/* -------------------------------------------------------------------------- */

/*
 * Paths below are relative to the backend API base, NOT to the site origin:
 * the `/api` segment lives in web `lib/backend-api/base.ts` alone so a split
 * deployment can point them at a separate backend origin. Web passes them to
 * `fetchBackendUrl()`; the hosted settings table prefixes `/api` itself.
 */
/** Custom account API route paths (Contract B). */
export const ACCOUNT_API_ROUTES = {
  /** `POST` (verify) / `DELETE` (clear) — Contracts B1 & B2. */
  twoFactorSession: '/account/two-factor/session',
  /** `GET` — Contract B3. */
  authSources: '/account/auth-sources',
  /** `DELETE` — Contract B4. */
  authSource: (providerId: string): string =>
    `/account/auth-sources/${encodeURIComponent(providerId)}`,
  /** `POST` — Contract B5. */
  password: '/account/password',
  /** `PATCH` — Contract B7 (display name / avatar clear). */
  profile: '/account/profile',
  /** `POST` — Contract B7 (issue signed avatar upload URL). */
  avatarUploadUrl: '/account/profile/avatar/upload-url',
  /** `POST` — Contract B7 (moderate + publish uploaded avatar). */
  avatarCommit: '/account/profile/avatar/commit',
  /** `GET` / `PATCH` — Contract B8 (public profile settings). */
  publicProfile: '/account/public-profile',
  /** `GET ?username=` — Contract B8 (username availability). */
  publicProfileUsernameAvailability:
    '/account/public-profile/username-availability',
  /** `GET` — Contract B8 (list the caller's publishable artifacts). */
  publicProfileArtifacts: '/account/public-profile/artifacts',
  /** `GET`(preview) / `POST`(publish) / `DELETE`(unpublish) — Contract B8. */
  publicProfileArtifact: (kind: string, sourceId: string): string =>
    `/account/public-profile/artifacts/${encodeURIComponent(
      kind,
    )}/${encodeURIComponent(sourceId)}`,
} as const;

/** Canonical public profile page path for a claimed username. */
export const PROFILE_PUBLIC_PATH = (username: string): string =>
  `/profile/${encodeURIComponent(username)}`;

/**
 * Account settings tab where a user claims a username and toggles their public
 * profile on. Handles both the "no profile row yet" and "row exists but hidden"
 * states.
 */
export const ACCOUNT_PUBLIC_PROFILE_PATH = '/account/profile';

/**
 * Org-scoped member profile-override API routes. An org OWNER/ADMIN edits
 * another member's org-scoped name/PFP through these; the request/response
 * shapes are identical to the self-edit {@link ACCOUNT_API_ROUTES} profile flow
 * (`UpdateProfileRequest/Response`, `AvatarUploadUrl*`, `AvatarCommit*`), so the
 * client transport can be reused verbatim — only the target path differs.
 */
export function ORG_MEMBER_PROFILE_API_ROUTES(
  orgId: string,
  userId: string,
): {
  /** `PATCH` — set the member's org-scoped display name / clear avatar override. */
  profile: string;
  /** `POST` — issue an org-member-scoped signed avatar upload URL. */
  avatarUploadUrl: string;
  /** `POST` — moderate + publish the uploaded avatar and set the override. */
  avatarCommit: string;
} {
  const base = `/account/organizations/${encodeURIComponent(
    orgId,
  )}/members/${encodeURIComponent(userId)}/profile`;
  return {
    profile: base,
    avatarUploadUrl: `${base}/avatar/upload-url`,
    avatarCommit: `${base}/avatar/commit`,
  };
}

/* -------------------------------------------------------------------------- */
/* Contract B8 — Public profile settings (opt-in `/profile/<username>`)       */
/* -------------------------------------------------------------------------- */

/*
 * Authenticated settings shapes for the account management surface. The public
 * read DTO (`PublicProfileResponse`) and the username/social-link rules live in
 * `@canopy/protocol/profile`.
 */

/** Current public-profile settings for the account card. */
export interface PublicProfileSettings {
  username: string | null;
  enabled: boolean;
  bio: string | null;
  links: SocialLink[];
  showCost: boolean;
  showHeatmap: boolean;
}

/** All fields optional; only present fields are applied. */
export interface UpdatePublicProfileRequest {
  username?: string;
  enabled?: boolean;
  bio?: string | null;
  links?: SocialLink[];
  showCost?: boolean;
  showHeatmap?: boolean;
}

export interface PublicProfileSettingsResponse {
  settings: PublicProfileSettings | null;
}

export type UsernameUnavailableReason = 'invalid' | 'reserved' | 'taken';

export interface UsernameAvailabilityResponse {
  available: boolean;
  reason?: UsernameUnavailableReason;
}

export const UPDATE_PUBLIC_PROFILE_ERROR = 'Unable to update your profile.';
export const USERNAME_TAKEN_ERROR = 'That username is already taken.';
export const USERNAME_INVALID_ERROR = 'That username cannot be used.';

/** Canopy tier labels for the subscription-lineup flex (brand name prepended in UI). */
export const CANOPY_PLAN_TIER_LABELS: Record<CanopyPlanTier, string> = {
  free: 'Free',
  individual: 'Individual',
  business: 'Business',
};

/* -------------------------------------------------------------------------- */
/* API keys — /api/account/api-keys                                           */
/* -------------------------------------------------------------------------- */

/**
 * Provenance of a user API key as exposed across the API boundary. Mirrors
 * the web server `UserApiKeySource` (`apps/web/src/lib/api-keys.ts`, which
 * imports `node:crypto` and so cannot be shared). The list route never returns
 * `COWORK_SESSION` keys.
 */
export type UserApiKeySource =
  | 'MANUAL'
  | 'OAUTH_DESKTOP'
  | 'GUEST'
  | 'SERVICE_ACCOUNT'
  | 'COWORK_SESSION';

/** One row of `GET /api/account/api-keys`. Never carries a token or hash. */
export interface UserApiKeyListItem {
  id: string;
  name: string;
  source: UserApiKeySource;
  createdIp: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** `201` body for `POST /api/account/api-keys`. The token is shown once. */
export interface UserApiKeyCreateResponse {
  userApiKey: UserApiKeyListItem;
  token: string;
}

/* -------------------------------------------------------------------------- */
/* Notification preferences — /api/account/notification-preferences          */
/* -------------------------------------------------------------------------- */

/** `GET`/`PATCH` body for the push notification opt-in. */
export interface NotificationPreferences {
  pushEnabled: boolean;
}

/* -------------------------------------------------------------------------- */
/* Personal project catalog — /api/account/projects/personal                  */
/* -------------------------------------------------------------------------- */

/** Path of the desktop-synced Personal project list (relative to `/api`). */
export const PERSONAL_PROJECT_CATALOG_API_PATH = '/account/projects/personal';

/** One row of the desktop-synced Personal project list. */
export interface PersonalCatalogProject {
  id: string;
  name: string;
  kind: 'CODE' | 'COWORK';
  updatedAt: string;
  online: boolean;
}

/** `GET` body of the Personal project list. */
export interface PersonalCatalogResponse {
  projects: PersonalCatalogProject[];
}

/** `DELETE` body: the catalog generation after removal. */
export interface PersonalCatalogRemovalResponse {
  catalogGeneration: number;
}
