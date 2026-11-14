// Model-library access retained for one account and authorized work owner.
// Personal entitlements stay separate from the optional owner-scoped response.
// Each network read brackets the saved account identity; stale responses never
// enter either retained projection. Retention is display-only, not payment proof.

import {
  AI_CREDITS_WORK_OWNER_HEADER,
  type ModelLibraryAccess,
  type WorkOwner,
} from '@canopy/protocol';
import type { CanopyCloudModelLibraryAccessState } from '@canopy/desktop-shared/types';
import { cloudAccountIdentityKey } from '@canopy/desktop-shared/lib/guest-account';
import {
  loadCanopyCloudAccount,
  getCanopyCloudCredentials,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from '../lib/canopy-cloud-account-store';
import {
  probeEntitlementsSummary,
  type EntitlementsSummaryProbe,
} from './entitlements';
import { parseSseEvents } from '../plans/plan-realtime-subscription';
import { CanopyCloudConfigError } from './config';

interface AccessSubscription {
  readonly callbacks: Set<(credentialsChanged?: boolean) => void>;
  readonly stop: () => void;
}
const accessSubscriptions = new Map<string, AccessSubscription>();

/** One credential/owner stream shared by all mounted picker and lane consumers. */
export async function subscribeModelLibraryAccess(
  owner: WorkOwner,
  onChanged: (credentialsChanged?: boolean) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<() => void> {
  let credentials: Awaited<ReturnType<typeof getCanopyCloudCredentials>>;
  try {
    credentials = await getCanopyCloudCredentials();
  } catch (error) {
    if (
      !(error instanceof CanopyCloudConfigError) ||
      error.code !== 'api-key-required'
    )
      throw error;
    // Signed out has no library to watch yet (CAN-6557): the watch idles
    // until an account appears, then asks its consumers to read again.
    const unsubscribe = subscribeCanopyCloudAccountChanges((): void => {
      unsubscribe();
      onChanged(true);
    });
    return unsubscribe;
  }
  const key = `${credentials.baseUrl}|${credentials.apiKey}|${modelLibraryWorkOwnerKey(owner)}`;
  let subscription = accessSubscriptions.get(key);
  if (!subscription) {
    const controller = new AbortController();
    const callbacks = new Set<(credentialsChanged?: boolean) => void>();
    let cursor: string | undefined;
    let connected = false;
    let attempt = 0;
    const notify = (credentialsChanged = false): void =>
      callbacks.forEach((callback): void => callback(credentialsChanged));
    const unsubscribeAccount = subscribeCanopyCloudAccountChanges((): void => {
      controller.abort();
      accessSubscriptions.delete(key);
      notify(true);
    });
    const stop = (): void => {
      controller.abort();
      unsubscribeAccount();
      if (accessSubscriptions.get(key)?.callbacks === callbacks)
        accessSubscriptions.delete(key);
    };
    subscription = { callbacks, stop };
    accessSubscriptions.set(key, subscription);
    const run = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetchImpl(
            `${credentials.baseUrl}/api/v1/ai-credits/model-library/stream`,
            {
              headers: {
                Accept: 'text/event-stream',
                Authorization: `Bearer ${credentials.apiKey}`,
                [AI_CREDITS_WORK_OWNER_HEADER]:
                  owner.kind === 'personal'
                    ? 'personal'
                    : `org:${owner.organizationId}`,
                ...(cursor === undefined ? {} : { 'Last-Event-ID': cursor }),
              },
              signal: controller.signal,
            },
          );
          if ([401, 403, 404].includes(response.status)) return;
          if (!response.ok || !response.body)
            throw new Error('Access stream unavailable');
          if (connected) notify();
          connected = true;
          attempt = 0;
          const reader = response.body.getReader();
          const cancelReader = (): void => {
            void reader.cancel().catch(() => undefined);
          };
          controller.signal.addEventListener('abort', cancelReader, {
            once: true,
          });
          const decoder = new TextDecoder();
          let buffer = '';
          try {
            while (!controller.signal.aborted) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              if (buffer.length > 256 * 1024)
                throw new Error('Access stream frame too large');
              const parsed = parseSseEvents(buffer);
              buffer = parsed.remainder;
              for (const event of parsed.events) {
                if (event.id && /^[0-9]+$/.test(event.id)) cursor = event.id;
                if (event.event !== 'credit.pool') continue;
                let envelope: unknown;
                try {
                  envelope = JSON.parse(event.data);
                } catch {
                  continue;
                }
                if (
                  typeof envelope !== 'object' ||
                  envelope === null ||
                  !('payload' in envelope)
                )
                  continue;
                const payload = envelope.payload;
                if (
                  typeof payload === 'object' &&
                  payload !== null &&
                  'modelLibraryAccessChanged' in payload &&
                  payload.modelLibraryAccessChanged === true
                )
                  notify();
              }
            }
          } finally {
            controller.signal.removeEventListener('abort', cancelReader);
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        if (controller.signal.aborted) return;
        await new Promise<void>((resolve): void => {
          const aborted = (): void => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(
            (): void => {
              controller.signal.removeEventListener('abort', aborted);
              resolve();
            },
            Math.min(3000 * 2 ** attempt++, 60_000),
          );
          controller.signal.addEventListener('abort', aborted, { once: true });
        });
      }
    };
    void run().finally(stop);
  }
  const watched = subscription;
  watched.callbacks.add(onChanged);
  return (): void => {
    watched.callbacks.delete(onChanged);
    if (watched.callbacks.size === 0) watched.stop();
  };
}

/**
 * The single retained answer.
 *
 * One entry, not a map: only the saved credential's account can be asked
 * about, so an entry for any other account is by definition stale. Replacing
 * rather than accumulating is what makes "never reuse another account's cached
 * value" structural instead of a lookup every caller has to get right.
 */
let retained: {
  readonly accountKey: string;
  readonly access: ModelLibraryAccess;
} | null = null;
const retainedWork = new Map<
  string,
  { accountKey: string; access: ModelLibraryAccess }
>();

export function modelLibraryWorkOwnerKey(owner: WorkOwner): string {
  return owner.kind === 'personal' ? 'personal' : `org:${owner.organizationId}`;
}

function projectWorkModelLibraryAccess(
  accountKey: string | null,
  owner: WorkOwner,
  probe: EntitlementsSummaryProbe,
): CanopyCloudModelLibraryAccessState {
  retainedWork.forEach((value, key): void => {
    if (value.accountKey !== accountKey) retainedWork.delete(key);
  });
  if (accountKey === null) return { status: 'unknown' };
  const key = modelLibraryWorkOwnerKey(owner);
  if (probe.resolved && probe.workModelLibrary?.status === 'reported') {
    if (retainedWork.size >= 100 && !retainedWork.has(key)) {
      const first = retainedWork.keys().next();
      if (!first.done) retainedWork.delete(first.value);
    }
    retainedWork.set(key, {
      accountKey,
      access: probe.workModelLibrary.access,
    });
    return { status: 'reported', access: probe.workModelLibrary.access };
  }
  if (probe.resolved && probe.workModelLibrary?.status === 'not-reported') {
    retainedWork.delete(key);
    return { status: 'not-reported' };
  }
  const previous = retainedWork.get(key);
  return previous
    ? { status: 'retained', access: previous.access }
    : { status: 'unknown' };
}

/** Identity of the saved credential's account; see the shared helper. */
export function modelLibraryAccountKey(
  entry: CanopyCloudAccountEntry | null | undefined,
): string | null {
  return cloudAccountIdentityKey(entry);
}

async function readAccountKey(): Promise<string | null> {
  try {
    return modelLibraryAccountKey(await loadCanopyCloudAccount());
  } catch {
    return null;
  }
}

/**
 * Fold one probe result into the retained answer for `accountKey`.
 *
 * Exported for tests; production callers use
 * {@link probeEntitlementsWithModelLibrary}, which supplies the identity
 * bracket this relies on.
 */
export function projectModelLibraryAccess(
  accountKey: string | null,
  probe: EntitlementsSummaryProbe,
): CanopyCloudModelLibraryAccessState {
  // Drop an answer about anyone else before deciding anything, so no branch
  // below can hand it back.
  if (retained !== null && retained.accountKey !== accountKey) {
    retained = null;
  }
  if (accountKey === null) return { status: 'unknown' };
  if (probe.resolved) {
    if (probe.modelLibrary.status === 'reported') {
      retained = { accountKey, access: probe.modelLibrary.access };
      return { status: 'reported', access: probe.modelLibrary.access };
    }
    if (probe.modelLibrary.status === 'not-reported') {
      // A definitive answer from a server without the gate. Clear the retained
      // value too: a rolled-back server must not leave this account pinned to
      // a lock the server no longer applies.
      retained = null;
      return { status: 'not-reported' };
    }
  }
  // Transient failure or an unreadable field: neither is evidence of a change.
  return retained === null
    ? { status: 'unknown' }
    : { status: 'retained', access: retained.access };
}

/**
 * Probe entitlements and resolve personal model-library access for the
 * account that was saved for the WHOLE request.
 *
 * The account is read before and after the network call. A sign-in, sign-out,
 * or account switch during the request means the response describes a
 * credential that is no longer the saved one, so it is reported as `unknown`
 * and never written to the retained answer.
 */
export async function probeEntitlementsWithModelLibrary(
  owner?: WorkOwner,
): Promise<{
  probe: EntitlementsSummaryProbe;
  modelLibrary: CanopyCloudModelLibraryAccessState;
  accountKey: string | null;
  workModelLibrary?: CanopyCloudModelLibraryAccessState;
  ownerKey?: string;
}> {
  const accountKeyAtStart = await readAccountKey();
  const probe = await probeEntitlementsSummary(owner);
  const accountKey = await readAccountKey();
  if (accountKey !== accountKeyAtStart) {
    if (retained !== null && retained.accountKey !== accountKey) {
      retained = null;
    }
    retainedWork.clear();
    return {
      probe,
      modelLibrary: { status: 'unknown' },
      accountKey,
      ...(owner
        ? {
            workModelLibrary: { status: 'unknown' } as const,
            ownerKey: modelLibraryWorkOwnerKey(owner),
          }
        : {}),
    };
  }
  return {
    probe,
    modelLibrary: projectModelLibraryAccess(accountKey, probe),
    accountKey,
    ...(owner
      ? {
          workModelLibrary: projectWorkModelLibraryAccess(
            accountKey,
            owner,
            probe,
          ),
          ownerKey: modelLibraryWorkOwnerKey(owner),
        }
      : {}),
  };
}

/**
 * The retained access for `accountKey` and the optional work owner, without contacting the
 * cloud. `undefined` when nothing valid is held for that exact account.
 */
export function readRetainedModelLibraryAccess(
  accountKey: string | null,
  owner?: WorkOwner,
): ModelLibraryAccess | undefined {
  if (owner) {
    const previous = retainedWork.get(modelLibraryWorkOwnerKey(owner));
    return previous?.accountKey === accountKey ? previous.access : undefined;
  }
  return retained !== null && retained.accountKey === accountKey
    ? retained.access
    : undefined;
}

/** Test-only: resets module state between Jest cases. */
export function resetModelLibraryAccessForTests(): void {
  retained = null;
  retainedWork.clear();
}
