import { getFeatureFlagService } from '../feature-flags';
import { isAntigravityHarnessEnabled } from './feature-flag';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverAntigravityModels } from '@canopy/desktop-shared/node/antigravity/session-config';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { AcpClientError } from '@canopy/desktop-shared/node/acp/errors';
import {
  getAntigravityModelEntries,
  initAntigravityModels,
} from '@canopy/execution-engine/model-catalog';
import { isAntigravityConnectionEnabled } from './connection';
import { antigravityPlanLabelFromMeta, setAntigravityAccount } from './account';

let available: boolean | undefined;
let pending: Promise<boolean> | undefined;
let checkedAt = 0;
let generation = 0;
/** Bumped by a turn that saw catalog drift; a running probe must not hide it. */
let staleEpoch = 0;
let observingRollout = false;
/** One discovery, including its per-model probes, never outlives this. */
const DISCOVERY_DEADLINE_MS = 60_000;

/** Fence probes across disable/re-enable without changing the saved connection. */
function observeRollout(): void {
  if (observingRollout) return;
  observingRollout = true;
  let enabled = isAntigravityHarnessEnabled();
  getFeatureFlagService().onSnapshotChanged(() => {
    const next = isAntigravityHarnessEnabled();
    if (next === enabled) return;
    enabled = next;
    invalidateAntigravityModels();
    // Hydrated Portal catalogs need an explicit push; renderer registry
    // broadcasts alone do not refresh their chat-summary projections.
    void import('../portal/portal-event-bus')
      .then(({ notifyPortalModelCatalogChanged }) =>
        notifyPortalModelCatalogChanged(),
      )
      .catch(() => undefined);
  });
}

export function peekAntigravityAvailability(): boolean | undefined {
  return isAntigravityHarnessEnabled() ? available : false;
}

/** Explicit provider discovery only; importing this module never starts Google. */
export async function refreshAntigravityModels(): Promise<boolean> {
  observeRollout();
  const mine = generation;
  if (!(await isAntigravityConnectionEnabled())) {
    invalidateAntigravityModels();
    available = false;
    return false;
  }
  if (mine !== generation) return false;
  if (pending) return pending;
  if (available !== undefined && Date.now() - checkedAt < 15_000)
    return Promise.resolve(available);
  const staleAtStart = staleEpoch;
  // Created outside the probe so a deadline that fires during runtime startup
  // or session creation, which surface as a closed connection, still counts
  // as transient below.
  const deadline = AbortSignal.timeout(DISCOVERY_DEADLINE_MS);
  const probe = (async (): Promise<boolean> => {
    const { antigravityProfileDirectory, openAntigravityRuntime } =
      await import('./runtime');
    const cwd = join(antigravityProfileDirectory(), 'discovery');
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const signal = deadline;
    const runtime = await openAntigravityRuntime({
      cwd,
      signal,
      owner: { kind: 'discovery', id: randomUUID() },
      onUpdate: (): void => undefined,
    });
    try {
      const session = await runtime.client.newSession({ cwd, mcpServers: [] });
      // Thinking levels are per model, so each model is selected once in
      // this disposable session and its own live options are recorded.
      const { entries, skipped } = await discoverAntigravityModels(
        runtime.client,
        session.sessionId,
        session.configOptions,
        {
          signal,
          assertCurrent: () => {
            if (mine !== generation)
              throw new Error('Google model discovery was superseded.');
          },
        },
      );
      await runtime.client.closeSession(session.sessionId);
      if (skipped.length > 0)
        logMainProcessWarn(
          '[antigravity-models] Google did not select some listed models; they were left out of the catalog',
          { skipped },
        );
      if (entries.length === 0 && skipped.length > 0)
        throw new Error('Google refused every listed model.');
      if (mine === generation) {
        initAntigravityModels(entries);
        available = entries.length > 0;
        // The runtime's plan label only; never identity, quota or billing.
        // The read succeeded even when no models are offered, so the plan
        // stays "ready"; model availability is reported by the catalog.
        const planLabel = antigravityPlanLabelFromMeta(session._meta);
        setAntigravityAccount({
          status: 'ready',
          updatedAt: new Date().toISOString(),
          ...(planLabel ? { planLabel } : {}),
        });
      }
      return mine === generation && entries.length > 0;
    } finally {
      await runtime.close();
    }
  })()
    .catch((error: unknown) => {
      // Only a transient failure (the deadline, a slow or busy runtime) keeps
      // the last good catalog. Google owns credentials shared with the user's
      // own install, so an expired or removed sign-in, a refusal or losing
      // every model never reaches Canopy's invalidation: those clear the
      // catalog and report Google unavailable, as before.
      const kept =
        mine === generation &&
        (deadline.aborted || isTransientDiscoveryFailure(error)) &&
        getAntigravityModelEntries().length > 0;
      logMainProcessWarn('[antigravity-models] Google model discovery failed', {
        error: error instanceof Error ? error.message : String(error),
        superseded: mine !== generation,
        keptPreviousCatalog: kept,
      });
      if (mine === generation && !kept) {
        available = false;
        initAntigravityModels([]);
        // A failed read is "could not check", never a sign-out.
        setAntigravityAccount({
          status: 'unavailable',
          updatedAt: new Date().toISOString(),
        });
      }
      return kept;
    })
    .finally(() => {
      if (pending === probe) pending = undefined;
      // A turn that marked the catalog stale during this probe still forces
      // the next probe to rediscover.
      if (mine === generation && staleEpoch === staleAtStart)
        checkedAt = Date.now();
    });
  pending = probe;
  return probe;
}

function isTransientDiscoveryFailure(error: unknown): boolean {
  if (error instanceof AcpClientError)
    return error.code === 'timeout' || error.code === 'busy';
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

/**
 * A turn found a model or level the catalog showed but the runtime no longer
 * offers. Entries stay published, and the next availability probe
 * rediscovers instead of using the 15-second cache. A transient rediscovery
 * failure keeps the last good entries.
 */
export function markAntigravityCatalogStale(): void {
  staleEpoch += 1;
  checkedAt = 0;
}

export function invalidateAntigravityModels(): void {
  generation += 1;
  checkedAt = 0;
  pending = undefined;
  available = undefined;
  initAntigravityModels([]);
  setAntigravityAccount(undefined);
}
