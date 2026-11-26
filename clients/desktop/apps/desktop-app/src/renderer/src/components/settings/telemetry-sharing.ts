import type {
  CanopyCloudAccountPublicState,
  TelemetrySharingPreferences,
  TelemetrySharingVisibility,
  WorkspaceContext,
  WorkspaceContextOrganization,
} from '@canopy/desktop-shared/types';
// Narrow subpath, not the root barrel: this module is pure data consumed by the
// settings tab's initial render, and the barrel drags every shared component
// into the graph behind a few small exports.
import {
  DATA_SHARING_SCOPE_LABELS,
  DATA_SHARING_SCOPE_ORDER,
  dataSharingScopeRowHint,
} from '@canopy/ui-shared/lib/data-sharing-features';

/**
 * All telemetry sharing visibility values in canonical display order. `off` is
 * the Canopy-local non-sync state; the rest reuse the server
 * `TelemetryShareScope` vocabulary.
 *
 * The desktop UI intentionally offers only `off` / `private` ("Just me") /
 * `organization` (see `resolveAvailableTelemetryScopes`). `team` stays in this
 * order so that a value persisted before the simplification — or one set by some
 * other path — still renders in its canonical slot as a read-only fallback (the
 * `team` sync plumbing is retained server- and client-side); it is simply never
 * offered as a new choice.
 */
export const TELEMETRY_SCOPE_ORDER: readonly TelemetrySharingVisibility[] = [
  'off',
  'private',
  'team',
  'organization',
];

/** Default sharing preferences — nothing uploads until the user opts in. */
export const DEFAULT_TELEMETRY_SHARING: TelemetrySharingPreferences = {
  transcripts: 'off',
  plans: 'off',
  metadata: 'off',
  summaries: 'off',
};

/** Short, user-facing label for each visibility value. */
export const TELEMETRY_SCOPE_LABELS: Record<
  TelemetrySharingVisibility,
  string
> = {
  off: 'Off',
  private: 'Just me',
  team: 'Team',
  organization: 'Organization',
};

/**
 * One-line explanation of what each visibility value does, surfaced as a
 * tooltip on the scope selectors so the choices are self-describing without a
 * separate block of disclosure copy.
 */
export const TELEMETRY_SCOPE_DESCRIPTIONS: Record<
  TelemetrySharingVisibility,
  string
> = {
  off: 'Not shared. This data stays on your machine.',
  private: 'Uploaded but kept to you: only you can see it.',
  team: 'Uploaded and visible to members of your team.',
  organization: 'Uploaded and visible to everyone in your organization.',
};

/**
 * Scope descriptions for the selected workspace context (CAN-3459). The
 * `organization` choice only ever shares an organization's own work with that
 * organization, so its description names the selected org, and in Personal it
 * says plainly that Personal work stays private.
 */
export function resolveTelemetryScopeDescriptions(
  context: WorkspaceContext,
  organizations: readonly WorkspaceContextOrganization[],
): Record<TelemetrySharingVisibility, string> {
  if (context.kind !== 'organization') {
    return {
      ...TELEMETRY_SCOPE_DESCRIPTIONS,
      organization:
        'Applies when you work in an organization. Personal work stays private.',
    };
  }
  const selectedId = context.organizationId.toLowerCase();
  const name = organizations.find(
    (organization) => organization.id.toLowerCase() === selectedId,
  )?.name;
  return {
    ...TELEMETRY_SCOPE_DESCRIPTIONS,
    organization: name
      ? `Uploaded and visible to everyone in ${name}.`
      : TELEMETRY_SCOPE_DESCRIPTIONS.organization,
  };
}

export interface TelemetryDataTypeMeta {
  key: keyof TelemetrySharingPreferences;
  label: string;
  description: string;
}

/**
 * The per-turn data types the user can independently opt in to share, in the
 * canonical least-invasive → most-invasive order.
 *
 * Derived from the shared data-sharing vocabulary rather than restated here so
 * the member reading this list and the admin configuring the org policy on the
 * web see the same rows, in the same order, under the same words. Restating the
 * labels locally is how the member view drifted into calling `metadata` "Usage
 * details" while the org policy called it "Usage metadata".
 */
export const TELEMETRY_DATA_TYPES: readonly TelemetryDataTypeMeta[] =
  DATA_SHARING_SCOPE_ORDER.map(
    (key): TelemetryDataTypeMeta => ({
      key,
      label: DATA_SHARING_SCOPE_LABELS[key],
      description: dataSharingScopeRowHint(key),
    }),
  );

/**
 * Resolve which visibility scopes are selectable given the linked Canopy Cloud
 * account. `off` and `private` ("Just me") are always available; `organization`
 * appears only when the account actually belongs to one. When unlinked or the
 * account cannot be read, only `off` / `private` are offered.
 *
 * `team` is intentionally NOT offered here even when the account has team
 * memberships: the desktop UX is simplified to Off / Just me / Organization. The
 * `team` sync plumbing is retained (a value persisted earlier still syncs and
 * renders as a read-only fallback via `TELEMETRY_SCOPE_ORDER`), but team is no
 * longer a selectable choice.
 */
export function resolveAvailableTelemetryScopes(
  account: CanopyCloudAccountPublicState | null,
): TelemetrySharingVisibility[] {
  const scopes: TelemetrySharingVisibility[] = ['off', 'private'];
  if (account?.organizations && account.organizations.length > 0) {
    scopes.push('organization');
  }
  return scopes;
}

/**
 * Whether a visibility value actually reaches the organization surfaces the
 * feature pills name.
 *
 * `private` is NOT sharing here even though it uploads: a private-scope row is
 * visible only to its author, so it powers no Feed card, no Statistics tile, and
 * no org memory episode. Treating it as sharing would promise the member
 * features that will never appear for them.
 */
export function sharesWithOrganization(
  value: TelemetrySharingVisibility,
): boolean {
  return value === 'organization' || value === 'team';
}
