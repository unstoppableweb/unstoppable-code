import {
  REMOTE_CONTROL_MANAGED_PROVIDERS,
  type RemoteControlChatProviderAvailability,
  type RemoteControlManagedProvider,
  type RemoteControlProviderSetupState,
  type RemoteControlProviderSetupStatuses,
} from '@canopy/protocol/remote-control/shell';
import { isAntigravityHarnessEnabled } from '../antigravity/feature-flag';
import { isCopilotHarnessEnabled } from '../copilot/feature-flag';
import { isCursorHarnessEnabled } from '../cursor/feature-flag';
import { isOpenCodeHarnessEnabled } from '../opencode/feature-flag';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { requestDesktopSessionSnapshotInvalidation } from '../services/desktop-session-snapshot-invalidation';

/**
 * Why each managed-runtime provider is or isn't ready, for Remote Control
 * pickers (`RemoteControlChatProviderAvailability.setup`). Without it, a
 * provider whose rows come only from discovery (Antigravity, Copilot,
 * OpenCode) disappears from a remote picker with no reason, and Cursor's
 * placeholder row asks for a connect the host cannot do.
 *
 * Projections read this synchronously and never wait on it. The facts come
 * from cheap reads (pinned runtime metadata, the managed install check and
 * preferences); nothing here launches a provider, signs in or discovers
 * models. Nothing is read until the first remote session attaches; from
 * then, a read refreshes in the background at most once a minute, and after
 * a model catalog change at most every ten seconds.
 * When an answer changes, {@link publishProviderSetupProjections} pushes it:
 * controllers re-read their projections on the session-stale push.
 */
export interface ProviderSetupFacts {
  /** This host's platform and architecture have a pinned runtime. */
  supported?: boolean;
  /** The managed runtime (or, for Antigravity, a verified copy) is present. */
  installed?: boolean;
  /** The person connected it, or has not turned it off. */
  enabled?: boolean;
}

const REFRESH_INTERVAL_MS = 60_000;
/**
 * The soonest a catalog change makes the next projection read again after
 * the last read. A sign-in dialog's poll announces a change every two
 * seconds; installs and sign-ins still show within this bound.
 */
const CATALOG_REREAD_MS = 10_000;

const FLAGS: Readonly<Record<RemoteControlManagedProvider, () => boolean>> = {
  antigravity: isAntigravityHarnessEnabled,
  cursor: isCursorHarnessEnabled,
  copilot: isCopilotHarnessEnabled,
  opencode: isOpenCodeHarnessEnabled,
};

let facts = new Map<RemoteControlManagedProvider, ProviderSetupFacts>();
let refreshedAt = 0;
let catalogChanged = false;
let refreshing: Promise<boolean> | undefined;
let observingCatalog = false;
let primed = false;

/**
 * Most specific reason first. `available` is the provider's projected
 * availability, which already folds in sign-in and discovery.
 */
export function deriveProviderSetupState(input: {
  flagEnabled: boolean;
  available: boolean | undefined;
  facts: ProviderSetupFacts | undefined;
}): RemoteControlProviderSetupState | undefined {
  if (!input.flagEnabled) return 'flag_off';
  if (input.facts?.supported === false) return 'unsupported_host';
  if (input.available === true) return 'ready';
  if (input.facts?.installed === false) return 'not_installed';
  if (input.facts?.enabled === false) return 'disabled';
  if (input.available === false) return 'unavailable';
  return undefined;
}

/**
 * The setup map for one destination's picker. A destination whose catalog
 * leaves Antigravity out (App Advisor and other bot projects can't run it)
 * gets no reason for it, so its picker never offers setup for a provider
 * it can't run.
 */
export function providerSetupForDestination(
  setup: RemoteControlProviderSetupStatuses,
  destination: { readonly antigravity: boolean },
): RemoteControlProviderSetupStatuses {
  if (destination.antigravity) return setup;
  const kept = { ...setup };
  delete kept.antigravity;
  return kept;
}

/**
 * Last known facts for one provider; undefined until the first background
 * read finishes.
 */
export function peekProviderSetupFacts(
  provider: RemoteControlManagedProvider,
): ProviderSetupFacts | undefined {
  return facts.get(provider);
}

/**
 * Whether a remote session has attached since launch. Until one does, the
 * facts are never read: projections still derive what the flags and
 * availability say, and a computer nobody controls does no new work.
 */
export function isProviderSetupWatched(): boolean {
  return primed;
}

/**
 * The `setup` map for a projection. Never waits; once a remote session has
 * attached, may start a background read.
 */
export function peekRemoteControlProviderSetup(
  availability: RemoteControlChatProviderAvailability,
): RemoteControlProviderSetupStatuses {
  const sinceRead = Date.now() - refreshedAt;
  if (
    primed &&
    (sinceRead >= REFRESH_INTERVAL_MS ||
      (catalogChanged && sinceRead >= CATALOG_REREAD_MS))
  )
    void refreshProviderSetupFacts();
  const statuses: RemoteControlProviderSetupStatuses = {};
  for (const provider of REMOTE_CONTROL_MANAGED_PROVIDERS) {
    const state = deriveProviderSetupState({
      flagEnabled: FLAGS[provider](),
      available: availability[provider],
      facts: facts.get(provider),
    });
    if (state) statuses[provider] = state;
  }
  return statuses;
}

async function readAntigravityFacts(): Promise<ProviderSetupFacts> {
  const { antigravityRuntimeStatus, isAntigravityConnectionEnabled } =
    await import('../antigravity/connection');
  const [status, enabled] = await Promise.all([
    antigravityRuntimeStatus(),
    isAntigravityConnectionEnabled(),
  ]);
  return {
    supported: status.supported,
    installed: status.installed,
    enabled,
  };
}

async function readCursorFacts(): Promise<ProviderSetupFacts> {
  const { getCursorRuntimeArtifact } =
    await import('@canopy/desktop-shared/node/cursor/runtime-metadata');
  if (!getCursorRuntimeArtifact()) return { supported: false };
  const { cursorConnectionStatus } = await import('../cursor/runtime-status');
  const status = await cursorConnectionStatus();
  return {
    supported: status.supported,
    installed: status.installed,
    enabled: status.enabled,
  };
}

/**
 * Copilot's and OpenCode's own status reads also observe connections and
 * publish availability, so only the side-effect-free parts are read here: the
 * pinned artifact and the saved connect preference.
 */
async function readCopilotFacts(): Promise<ProviderSetupFacts> {
  const { getCopilotRuntimeArtifact } =
    await import('@canopy/desktop-shared/node/copilot/runtime-metadata');
  if (!getCopilotRuntimeArtifact()) return { supported: false };
  const { readPreferencesFile } = await import('../lib/preferences-store');
  return {
    supported: true,
    enabled: (await readPreferencesFile()).copilotEnabled === true,
  };
}

async function readOpenCodeFacts(): Promise<ProviderSetupFacts> {
  const { getOpenCodeRuntimeArtifact } =
    await import('@canopy/desktop-shared/node/opencode/runtime-metadata');
  if (!getOpenCodeRuntimeArtifact()) return { supported: false };
  const { readPreferencesFile } = await import('../lib/preferences-store');
  return {
    supported: true,
    enabled: (await readPreferencesFile()).opencodeEnabled === true,
  };
}

const READERS: Readonly<
  Record<RemoteControlManagedProvider, () => Promise<ProviderSetupFacts>>
> = {
  antigravity: readAntigravityFacts,
  cursor: readCursorFacts,
  copilot: readCopilotFacts,
  opencode: readOpenCodeFacts,
};

function sameFacts(
  left: ProviderSetupFacts | undefined,
  right: ProviderSetupFacts | undefined,
): boolean {
  return (
    left?.supported === right?.supported &&
    left?.installed === right?.installed &&
    left?.enabled === right?.enabled
  );
}

function observeCatalog(): void {
  if (observingCatalog) return;
  observingCatalog = true;
  // Installs, connects and sign-ins announce a catalog change; the next
  // projection then reads fresh facts instead of waiting out the interval.
  void import('./agent-catalog-compatibility')
    .then(({ onModelCatalogChanged }) =>
      onModelCatalogChanged((): Promise<void> => {
        catalogChanged = true;
        return Promise.resolve();
      }),
    )
    .catch(() => {
      observingCatalog = false;
    });
}

/**
 * Pushes the projections that carry `providerAvailability.setup` to every
 * controller. The session-stale push makes controllers re-read the session
 * snapshot (its chat summaries, App Advisor's included, and the new-task
 * controls' availability), the watched worktrees' chat summaries and the
 * web's agent setup rows, which read `setup` from those; the registry push
 * makes desktop pickers re-read their catalogs. App Advisor's settings view
 * is read when it opens, so it sees the facts as they are then.
 */
export function publishProviderSetupProjections(): void {
  requestDesktopSessionSnapshotInvalidation('provider-setup.facts');
  void import('../models/model-registry')
    .then(({ broadcastModelRegistryUpdated }) => {
      broadcastModelRegistryUpdated();
    })
    .catch((error: unknown) => {
      logMainProcessWarn('[provider-setup-status] registry push failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

async function readFacts(): Promise<boolean> {
  const next = new Map(facts);
  let changed = false;
  for (const provider of REMOTE_CONTROL_MANAGED_PROVIDERS) {
    if (!FLAGS[provider]()) continue;
    try {
      const read = await READERS[provider]();
      if (!sameFacts(next.get(provider), read)) {
        next.set(provider, read);
        changed = true;
      }
    } catch (error) {
      logMainProcessWarn('[provider-setup-status] provider read failed', {
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  facts = next;
  refreshedAt = Date.now();
  if (changed) publishProviderSetupProjections();
  return changed;
}

/**
 * Re-reads every released provider's facts and pushes the projections when
 * an answer changed; resolves whether one did. Concurrent calls share one
 * read. `fresh` waits out a read already running, which may have started
 * before the change being checked, and then reads again. A provider whose
 * read fails keeps its last facts.
 */
export async function refreshProviderSetupFacts(options?: {
  readonly fresh?: boolean;
}): Promise<boolean> {
  observeCatalog();
  if (options?.fresh === true && refreshing) {
    const older = refreshing;
    await older.catch(() => false);
    // Another fresh caller may have started the next read meanwhile.
    if (refreshing !== undefined && refreshing !== older) return refreshing;
  }
  refreshedAt = Date.now();
  catalogChanged = false;
  if (refreshing) return refreshing;
  const read = readFacts().finally(() => {
    if (refreshing === read) refreshing = undefined;
  });
  refreshing = read;
  return read;
}

/**
 * Which managed providers this host can run at all, from the pinned runtime
 * manifests alone: no status read, install check or CLI. Fills in only what
 * no read has answered yet.
 */
async function readPlatformFacts(): Promise<void> {
  const [antigravity, cursor, copilot, opencode] = await Promise.all([
    import('@canopy/desktop-shared/node/antigravity/runtime-artifacts'),
    import('@canopy/desktop-shared/node/cursor/runtime-metadata'),
    import('@canopy/desktop-shared/node/copilot/runtime-metadata'),
    import('@canopy/desktop-shared/node/opencode/runtime-metadata'),
  ]);
  const pinned: Readonly<Record<RemoteControlManagedProvider, boolean>> = {
    antigravity: antigravity.getAntigravityRuntimeArtifact() !== undefined,
    cursor: cursor.getCursorRuntimeArtifact() !== undefined,
    copilot: copilot.getCopilotRuntimeArtifact() !== undefined,
    opencode: opencode.getOpenCodeRuntimeArtifact() !== undefined,
  };
  const next = new Map(facts);
  for (const provider of REMOTE_CONTROL_MANAGED_PROVIDERS)
    if (!next.has(provider))
      next.set(provider, { supported: pinned[provider] });
  facts = next;
}

/**
 * The first remote session's attach. It waits only for the pinned-runtime
 * manifests, so its first projection already says which providers this
 * host can't run (Antigravity on Windows, say) instead of offering them,
 * and then reads the rest in the background; the answer is pushed when it
 * lands. Later attaches rely on the interval and catalog changes.
 */
export async function primeProviderSetupFacts(): Promise<void> {
  if (primed) return;
  primed = true;
  try {
    await readPlatformFacts();
  } catch (error) {
    logMainProcessWarn('[provider-setup-status] platform read failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  void refreshProviderSetupFacts();
}

/** Test-only: forgets every fact and the refresh clock. */
export function resetProviderSetupFactsForTesting(): void {
  facts = new Map();
  refreshedAt = 0;
  catalogChanged = false;
  refreshing = undefined;
  observingCatalog = false;
  primed = false;
}
