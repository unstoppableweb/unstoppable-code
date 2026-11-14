import { getFeatureFlagService } from '../feature-flags';
import { isAntigravityHarnessEnabled } from './feature-flag';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { antigravityModelsFromConfig } from '@canopy/execution-engine/lib/antigravity-models';
import { initAntigravityModels } from '@canopy/execution-engine/model-catalog';
import { isAntigravityConnectionEnabled } from './connection';

let available: boolean | undefined;
let pending: Promise<boolean> | undefined;
let checkedAt = 0;
let generation = 0;
let observingRollout = false;

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
  const probe = (async (): Promise<boolean> => {
    const { antigravityProfileDirectory, openAntigravityRuntime } =
      await import('./runtime');
    const cwd = join(antigravityProfileDirectory(), 'discovery');
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const runtime = await openAntigravityRuntime({
      cwd,
      owner: { kind: 'discovery', id: randomUUID() },
      onUpdate: (): void => undefined,
    });
    try {
      const session = await runtime.client.newSession({ cwd, mcpServers: [] });
      const entries = antigravityModelsFromConfig(session.configOptions);
      await runtime.client.closeSession(session.sessionId);
      if (mine === generation) {
        initAntigravityModels(entries);
        available = entries.length > 0;
      }
      return mine === generation && entries.length > 0;
    } finally {
      await runtime.close();
    }
  })()
    .catch(() => {
      if (mine === generation) {
        available = false;
        initAntigravityModels([]);
      }
      return false;
    })
    .finally(() => {
      if (pending === probe) pending = undefined;
      if (mine === generation) checkedAt = Date.now();
    });
  pending = probe;
  return probe;
}

export function invalidateAntigravityModels(): void {
  generation += 1;
  checkedAt = 0;
  pending = undefined;
  available = undefined;
  initAntigravityModels([]);
}
