import { pipelineDefinitionError } from '@canopy/core-runtime/node/pipeline';
import type { PipelineAgentAuthor } from '@canopy/execution-engine/types/pipeline';

/*
 * The owners of routed definition writes, recorded before they commit
 * (CAN-7507). A routed create, import or copy gets its id from the daemon,
 * so main registers the write's owner under the write's owner key before
 * sending it, and records it when the daemon raises the write's effects
 * before the commit. The key is a digest of the sending client and the
 * idempotency key, so another client's write never matches. A registration
 * is never dropped while its write is out: a full registry refuses the next
 * write instead, and a write whose outcome is unknown keeps its registration
 * until it expires, for an effect that arrives late. Keys are never logged.
 */

/** What main records for a definition it creates. */
export interface PendingDefinitionOwner {
  readonly owner: string;
  readonly agentAuthor: PipelineAgentAuthor | null;
}

/** How the write a registration was made for ended. */
export type PendingDefinitionOwnerRelease = (
  outcome: 'settled' | 'unknown',
) => void;

/** As many writes as the definitions' scope holds pending at once. */
const PENDING_MAX = 64;
/** Longer than a routed write's delivery and an effect arriving after it. */
const PENDING_TTL_MS = 5 * 60_000;

interface Entry {
  readonly expiresAt: number;
}

const pending = new Map<
  string,
  Entry & { readonly owner: PendingDefinitionOwner }
>();
const inFlight = new Map<string, Entry>();

function live(entry: Entry | undefined): boolean {
  return entry !== undefined && entry.expiresAt > Date.now();
}

function prune<T extends Entry>(entries: Map<string, T>): void {
  for (const [key, entry] of entries) if (!live(entry)) entries.delete(key);
}

function entry(): Entry {
  return { expiresAt: Date.now() + PENDING_TTL_MS };
}

/**
 * Registers the owner of a routed write under its owner key. The returned
 * release, called once delivery ends, removes a settled write's registration
 * and keeps an unknown one's until it expires. Refuses, retryable, when
 * every slot holds a write that hasn't settled; a same-key resend reuses its
 * slot.
 */
export function registerPendingDefinitionOwner(
  ownerKey: string,
  owner: PendingDefinitionOwner,
): PendingDefinitionOwnerRelease {
  prune(pending);
  if (!pending.has(ownerKey) && pending.size >= PENDING_MAX)
    throw pipelineDefinitionError(
      'core.pipeline.sourceUnavailable',
      'Too many workflow changes are waiting to be saved. Try again in a moment.',
    );
  const registered = { ...entry(), owner };
  pending.set(ownerKey, registered);
  return (outcome) => {
    if (outcome === 'settled' && pending.get(ownerKey) === registered)
      pending.delete(ownerKey);
  };
}

/** The owner registered under exactly this key, while it lasts. */
export function pendingDefinitionOwner(
  ownerKey: string,
): PendingDefinitionOwner | undefined {
  const registered = pending.get(ownerKey);
  return live(registered) ? registered?.owner : undefined;
}

/**
 * Marks a definition whose owner was recorded before its commit, so a
 * reconcile keeps that record while the commit is in flight.
 */
export function markDefinitionOwnerInFlight(definitionId: string): void {
  prune(inFlight);
  inFlight.set(definitionId, entry());
}

/** The commit the definition's owner was recorded for has settled. */
export function clearDefinitionOwnerInFlight(definitionId: string): void {
  inFlight.delete(definitionId);
}

/** Whether a definition's owner was recorded for a commit still in flight. */
export function isDefinitionOwnerInFlight(definitionId: string): boolean {
  return live(inFlight.get(definitionId));
}
