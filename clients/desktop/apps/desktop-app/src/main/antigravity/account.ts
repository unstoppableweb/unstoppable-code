import {
  isAntigravityPlanLabel,
  type AntigravityAccountSnapshot,
} from '@canopy/protocol/portal';

/**
 * The Antigravity plan label from the last model discovery, kept in memory.
 * Discovery already opens a native session, so reading this never launches
 * the runtime. Model invalidation (sign-in, disconnect, rollout) clears it.
 */
let snapshot: AntigravityAccountSnapshot | undefined;
const listeners = new Set<() => void>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads `_meta.antigravity.tier.name` from a native session response. The
 * pinned 1.5.1 runtime advertises this as `_meta.antigravity.tier`. Returns
 * undefined for anything that is not a short label without control or
 * format characters.
 */
export function antigravityPlanLabelFromMeta(
  meta: unknown,
): string | undefined {
  if (!isRecord(meta) || !isRecord(meta.antigravity)) return undefined;
  const tier = meta.antigravity.tier;
  if (!isRecord(tier) || typeof tier.name !== 'string') return undefined;
  const label = tier.name.trim();
  if (!isAntigravityPlanLabel(label)) return undefined;
  return label;
}

export function peekAntigravityAccount():
  | AntigravityAccountSnapshot
  | undefined {
  return snapshot ? { ...snapshot } : undefined;
}

/** What the views show; a refreshed timestamp alone does not notify. */
function displayKey(value: AntigravityAccountSnapshot | undefined): string {
  if (!value) return 'none';
  return value.status === 'ready'
    ? `ready:${value.planLabel ?? ''}`
    : 'unavailable';
}

export function setAntigravityAccount(
  next: AntigravityAccountSnapshot | undefined,
): void {
  const changed = displayKey(snapshot) !== displayKey(next);
  // An unchanged display keeps its time, so a refresh that changes nothing
  // visible never produces another usage emit or Portal delta.
  if (!changed) return;
  snapshot = next;
  for (const listener of Array.from(listeners)) listener();
}

export function onAntigravityAccountChanged(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}
