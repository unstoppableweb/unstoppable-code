/**
 * Every automatic outbound call desktop main makes, and what a local-only
 * build and a self-host build (docs/local-only-build.md) do with it.
 *
 * This table is the one place a reader can see every local-only difference
 * outside the chokepoints (cloud base URL, feature flags, PostHog, updater,
 * capabilities, child environment and the egress guard). Call sites ask
 * `allowsAutomaticCall('<id>')`, which is always true in a normal build, so
 * a guard is one line at an existing scheduler or startup site.
 *
 * `AUTOMATIC_CALLS` holds the local-only dispositions and
 * `SELF_HOST_AUTOMATIC_CALLS` the self-host ones. Keep `AUTOMATIC_CALLS`
 * first: `check:local-only-egress` reads it lexically up to its
 * `} as const`.
 *
 * Dispositions:
 * - `on` (self-host only): the call runs as in a normal build. Only calls
 *   that go to the configured server and nowhere else may be `on`.
 * - `off`: the call never happens in the profile.
 * - `on-demand`: the automatic (timer or startup) call never happens; the
 *   same request may still run when the user opens the surface that shows
 *   it, for an account the user connected. Those sites ask
 *   `allowsOnDemandCall('<id>')`.
 *
 * A new automatic outbound call must add an id here and an `automatic:<id>`
 * entry in docs/local-only/network-calls.yaml; `check:local-only-egress`
 * fails until both exist.
 */
import { isLocalOnlyBuild, isSelfHostBuild } from './profile';

export type LocalOnlyDisposition = 'off' | 'on-demand';

export type SelfHostDisposition = 'on' | LocalOnlyDisposition;

export type AutomaticCallId =
  | 'cloud.startup-outbox-flush'
  | 'cloud.blueprint-prefetch'
  | 'skills.audit'
  | 'skills.update-check'
  | 'marketplace.default-refresh'
  | 'marketplace.manifest-preview'
  | 'runtime.npm-download'
  | 'runtime.cursor-download'
  | 'helpers.unconnected-codex'
  | 'usage.anthropic-poll'
  | 'models.codex-account-refresh'
  | 'github.pr-poll'
  | 'avatars.project-cache'
  | 'telemetry.active-use-signal'
  | 'telemetry.anonymous-id'
  | 'telemetry.sync'
  | 'telemetry.usage-analytics-optout'
  | 'dictation.speech-model-update';

export const AUTOMATIC_CALLS = {
  // Startup flush of queued turn feedback and shared-item subscriptions to
  // the hosted service.
  'cloud.startup-outbox-flush': 'off',
  // Startup prefetch of the hosted workspace template (blueprint) catalog.
  'cloud.blueprint-prefetch': 'off',
  // Third-party skill safety audit (add-skill.vercel.sh). Reported as "not
  // checked" in a local-only build.
  'skills.audit': 'off',
  // GitHub check for newer versions of installed skills.
  'skills.update-check': 'off',
  // Refresh of the default marketplace sources at startup.
  'marketplace.default-refresh': 'off',
  // Background metadata read when a catalog plugin detail opens.
  'marketplace.manifest-preview': 'off',
  // Managed npm runtime downloads; only an already installed runtime is used.
  'runtime.npm-download': 'off',
  // Cursor CLI runtime download; only an already installed runtime is used.
  'runtime.cursor-download': 'off',
  // Background helpers (chat titles and summaries) whose default model runs
  // on Codex. Without a connected Codex account the helper uses the Claude
  // fallback model instead of launching Codex, which would reach OpenAI.
  'helpers.unconnected-codex': 'off',
  // Provider plan usage meters (Anthropic, and the Codex, Cursor and Copilot
  // meters refreshed beside it) read at startup and after each turn.
  'usage.anthropic-poll': 'on-demand',
  // Codex account model list, revalidated on a timer while a speed surface
  // is open.
  'models.codex-account-refresh': 'on-demand',
  // Background pull request and CI polling; refreshes when the user acts.
  'github.pr-poll': 'on-demand',
  // GitHub owner avatar URLs main projects onto project rows (main resolves
  // them from the local git remote; the renderer loads the image).
  'avatars.project-cache': 'off',
  // The active-use signal in the usage data policy.
  'telemetry.active-use-signal': 'off',
  // The PostHog anonymous id handed to the renderer.
  'telemetry.anonymous-id': 'off',
  // Telemetry sync to the hosted service.
  'telemetry.sync': 'off',
  // The daily anonymous "Usage analytics is off" ping (CAN-6069).
  'telemetry.usage-analytics-optout': 'off',
  // Launch download of a newer Linux dictation speech model to replace an
  // installed older one. The first download, and a download from the
  // Dictation settings, stay user-initiated.
  'dictation.speech-model-update': 'off',
} as const satisfies Record<AutomaticCallId, LocalOnlyDisposition>;

/**
 * The self-host dispositions. The cloud is on and pointed at the configured
 * server, so the two calls that go only to it run; every other call goes to
 * a third party (or, for `telemetry.*`, is off by decision, as in
 * local-only) and copies its local-only disposition.
 */
export const SELF_HOST_AUTOMATIC_CALLS = {
  'cloud.startup-outbox-flush': 'on',
  'cloud.blueprint-prefetch': 'on',
  'skills.audit': AUTOMATIC_CALLS['skills.audit'],
  'skills.update-check': AUTOMATIC_CALLS['skills.update-check'],
  'marketplace.default-refresh': AUTOMATIC_CALLS['marketplace.default-refresh'],
  'marketplace.manifest-preview':
    AUTOMATIC_CALLS['marketplace.manifest-preview'],
  'runtime.npm-download': AUTOMATIC_CALLS['runtime.npm-download'],
  'runtime.cursor-download': AUTOMATIC_CALLS['runtime.cursor-download'],
  'helpers.unconnected-codex': AUTOMATIC_CALLS['helpers.unconnected-codex'],
  'usage.anthropic-poll': AUTOMATIC_CALLS['usage.anthropic-poll'],
  'models.codex-account-refresh':
    AUTOMATIC_CALLS['models.codex-account-refresh'],
  'github.pr-poll': AUTOMATIC_CALLS['github.pr-poll'],
  'avatars.project-cache': AUTOMATIC_CALLS['avatars.project-cache'],
  'telemetry.active-use-signal': AUTOMATIC_CALLS['telemetry.active-use-signal'],
  'telemetry.anonymous-id': AUTOMATIC_CALLS['telemetry.anonymous-id'],
  'telemetry.sync': AUTOMATIC_CALLS['telemetry.sync'],
  'telemetry.usage-analytics-optout':
    AUTOMATIC_CALLS['telemetry.usage-analytics-optout'],
  'dictation.speech-model-update':
    AUTOMATIC_CALLS['dictation.speech-model-update'],
} as const satisfies Record<AutomaticCallId, SelfHostDisposition>;

function activeDisposition(id: AutomaticCallId): SelfHostDisposition {
  if (isLocalOnlyBuild()) return AUTOMATIC_CALLS[id];
  if (isSelfHostBuild()) return SELF_HOST_AUTOMATIC_CALLS[id];
  return 'on';
}

/**
 * Whether an automatic (timer, startup or background) call may run. Always
 * true in a normal build.
 */
export function allowsAutomaticCall(id: AutomaticCallId): boolean {
  // `off` and `on-demand` both stop the automatic call; they differ only in
  // whether a user-opened surface may still make it (see
  // allowsOnDemandCall). The switch is exhaustive, so a new disposition
  // fails typecheck here.
  switch (activeDisposition(id)) {
    case 'on':
      return true;
    case 'off':
    case 'on-demand':
      return false;
  }
}

/**
 * Whether a user-opened surface may make the call `id` describes. True in a
 * normal build, and in a guarded build for `on` and `on-demand` calls.
 */
export function allowsOnDemandCall(id: AutomaticCallId): boolean {
  const disposition = activeDisposition(id);
  return disposition === 'on' || disposition === 'on-demand';
}

/**
 * The UI-automation seams (`CANOPY_E2E_LOCAL_ONLY=1` or
 * `CANOPY_E2E_SELF_HOST=1` in an E2E build) run the deferred startup
 * background tasks immediately, so the profile goldens see every delayed
 * call. Folded away in production bundles, where the environment variables
 * are never read; a production self-host build keeps the normal delay.
 */
export function runsDeferredStartupTasksImmediately(): boolean {
  return (
    typeof __CANOPY_E2E__ !== 'undefined' &&
    __CANOPY_E2E__ &&
    ((process.env.CANOPY_E2E_LOCAL_ONLY === '1' && isLocalOnlyBuild()) ||
      (process.env.CANOPY_E2E_SELF_HOST === '1' && isSelfHostBuild()))
  );
}
