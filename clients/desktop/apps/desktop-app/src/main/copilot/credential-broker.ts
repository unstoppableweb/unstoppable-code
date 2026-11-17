import type { SecureStorageFailure } from '@canopy/execution-engine/types/secure-storage';
import type { GitHubTokenProviderResult } from '@github/copilot-sdk';
import type { CopilotAccount } from '@canopy/desktop-shared/types';
import {
  DeviceFlowRefreshRejectedError,
  type DeviceFlowGrant,
} from '@canopy/desktop-shared/node/copilot/device-flow';
import type { CopilotRuntimeAuth } from '@canopy/copilot-recipient/runtime-auth';
import { sameCopilotAccount } from '@canopy/desktop-shared/node/copilot/auth';
import type {
  CopilotCredential,
  CopilotCredentialDelete,
  CopilotCredentialRead,
  CopilotCredentialReplace,
  CopilotCredentialRevision,
  CopilotGrant,
} from './credential-store';

export class CopilotSignInExpiredError extends Error {
  constructor() {
    super('Copilot sign-in expired. Reconnect Copilot in Settings.');
    this.name = 'CopilotSignInExpiredError';
  }
}

export class CopilotSignInChangedError extends Error {
  constructor() {
    super(
      'Copilot sign-in changed. Reconnect the account you want to use in Settings.',
    );
    this.name = 'CopilotSignInChangedError';
  }
}

export class CopilotCredentialUnreadableError extends Error {
  constructor(readonly secureStorageFailure?: SecureStorageFailure) {
    super("Couldn't read the Copilot sign-in on this device.");
    this.name = 'CopilotCredentialUnreadableError';
  }
}

export interface CopilotCredentialBrokerDeps {
  /** The account the user confirmed in Settings; absent means never connected. */
  pin: CopilotAccount | undefined;
  read(): Promise<CopilotCredentialRead>;
  /** Replaces the stored grant only while it is still at `from`. */
  save(
    from: CopilotCredentialRevision,
    grant: CopilotGrant,
  ): Promise<CopilotCredentialReplace>;
  /** Deletes the stored grant only while it is still at `from`. */
  clear(from: CopilotCredentialRevision): Promise<CopilotCredentialDelete>;
  refresh(refreshToken: string, signal: AbortSignal): Promise<DeviceFlowGrant>;
  now?: () => number;
  /** Qualification-only gate; absent in ordinary composition. */
  migrationAdmitted?: () => boolean;
}

/** Matches the SDK's own preflight: refresh when an hour or less remains. */
export const REFRESH_THRESHOLD_MS = 60 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 30_000;
const REFRESH_TIMEOUT_MS = 30_000;

/**
 * Resolves with the promise unless the signal aborts first. The promise is
 * always observed, so a refresh that outlives its cancelled caller cannot
 * surface as an unhandled rejection.
 */
export function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '');
}

const NETWORK_REFRESH_FAILURE =
  "Couldn't refresh the Copilot sign-in. Check your connection and try again.";

function sameRevision(
  left: CopilotCredentialRevision,
  right: CopilotCredentialRevision,
): boolean {
  return left.entryId === right.entryId && left.revision === right.revision;
}

interface Rotation {
  from: CopilotCredential;
  to: CopilotCredential;
  saved: boolean;
}

/** True when the store holds the rotation's successor at the revision its save writes. */
function landed(credential: CopilotCredential, rotation: Rotation): boolean {
  return (
    credential.entryId === rotation.from.entryId &&
    credential.revision === rotation.from.revision + 1 &&
    credential.accessToken === rotation.to.accessToken &&
    credential.refreshToken === rotation.to.refreshToken
  );
}

export interface CopilotCredentialBroker extends CopilotRuntimeAuth {
  access(
    signal: AbortSignal,
    admit?: () => Promise<void>,
  ): Promise<{ accessToken: string; expiresAt: number }>;
  /** Fence new demands; finish received rotations and retry a retained save once. */
  quiesce(permanent?: boolean): Promise<void>;
  /** A failed removal preference write leaves this same epoch usable. */
  resume(): void;
  /** Affirmative drain, unlike the best-effort quit contract. */
  quiesceForMigration(): Promise<boolean>;
}

export function createCopilotCredentialBroker(
  deps: CopilotCredentialBrokerDeps,
): CopilotCredentialBroker {
  const now = deps.now ?? Date.now;
  let accepting = true;
  let permanentlyFenced = false;
  let quiescing: Promise<void> | undefined;
  const pending = new Set<Promise<CopilotCredential>>();
  let refreshing: Promise<CopilotCredential> | undefined;
  // GitHub retires a refresh token the moment it rotates. A caller that read
  // the grant before that rotation must be handed the rotated grant instead of
  // presenting the retired token, which would sign the user out. The rotation
  // is remembered before it is written so a failed write cannot lose it.
  let lastRotation: Rotation | undefined;

  const load = async (): Promise<CopilotCredential> => {
    const read = await deps.read();
    if (read.status === 'absent') {
      lastRotation = undefined;
      throw new CopilotSignInExpiredError();
    }
    if (read.status === 'unreadable')
      throw new CopilotCredentialUnreadableError(read.secureStorageFailure);
    const { credential } = read;
    const unsaved =
      lastRotation && !lastRotation.saved && landed(credential, lastRotation)
        ? lastRotation
        : undefined;
    if (
      lastRotation &&
      !unsaved &&
      !sameRevision(credential, lastRotation.from) &&
      !sameRevision(credential, lastRotation.to)
    )
      lastRotation = undefined;
    if (
      !sameCopilotAccount(
        { host: credential.host, login: credential.login },
        deps.pin,
      )
    ) {
      lastRotation = undefined;
      throw new CopilotSignInChangedError();
    }
    // A save that landed but failed to sync reads back as the successor; it is
    // retried until it reports written. A conflict means the store moved on.
    if (unsaved && !(await persist(unsaved))) return load();
    return credential;
  };

  /** True while the store still holds the grant this refresh started from. */
  const stillStored = async (current: CopilotCredential): Promise<boolean> => {
    const read = await deps.read();
    if (read.status === 'unreadable')
      throw new CopilotCredentialUnreadableError(read.secureStorageFailure);
    return read.status === 'present' && sameRevision(read.credential, current);
  };

  /**
   * False when the store has moved off the revision the rotation started
   * from; the rotation is then dropped so a cleared grant is never rewritten.
   */
  const persist = async (rotation: Rotation): Promise<boolean> => {
    let result: CopilotCredentialReplace;
    try {
      result = await deps.save(rotation.from, rotation.to);
    } catch {
      // The grant stays usable from memory; the write is retried on the next
      // call. Losing it would sign the user out for a disk hiccup.
      return true;
    }
    if (result.status === 'written') {
      rotation.to = result.credential;
      rotation.saved = true;
    } else if (result.status === 'conflict') {
      if (lastRotation === rotation) lastRotation = undefined;
      return false;
    }
    return true;
  };

  const refresh = async (
    current: CopilotCredential,
  ): Promise<CopilotCredential> => {
    if (refreshing) return refreshing;
    const retained = lastRotation;
    if (retained && sameRevision(retained.from, current)) {
      if (!retained.saved && !(await persist(retained)))
        throw new CopilotSignInChangedError();
      return retained.to;
    }
    // GitHub rotates the refresh token on every call; a second concurrent
    // refresh would present a token GitHub has already retired. The request
    // runs on its own deadline so a cancelled caller cannot strand a rotation
    // GitHub has already applied.
    refreshing ??= (async (): Promise<CopilotCredential> => {
      try {
        let grant: DeviceFlowGrant;
        try {
          grant = await deps.refresh(
            current.refreshToken,
            AbortSignal.timeout(REFRESH_TIMEOUT_MS),
          );
        } catch (error) {
          if (error instanceof DeviceFlowRefreshRejectedError) {
            // Disconnect or Change account may have replaced the grant while
            // this refresh was in flight; only the grant we started from is
            // ours to clear.
            if (!(await stillStored(current)))
              throw new CopilotSignInChangedError();
            const cleared = await deps.clear(current);
            if (cleared.status === 'unreadable')
              throw new CopilotCredentialUnreadableError(
                cleared.secureStorageFailure,
              );
            if (cleared.status === 'conflict')
              throw new CopilotSignInChangedError();
            throw new CopilotSignInExpiredError();
          }
          if (Date.parse(current.accessTokenExpiresAt) > now()) return current;
          throw new Error(NETWORK_REFRESH_FAILURE);
        }
        const rotation: Rotation = {
          from: current,
          to: { ...current, ...grant },
          saved: false,
        };
        // GitHub has already retired the old grant. Retain this rotation
        // before awaiting storage; unreadability is not an account change.
        lastRotation = rotation;
        if (!(await stillStored(current))) {
          if (lastRotation === rotation) lastRotation = undefined;
          throw new CopilotSignInChangedError();
        }
        if (!(await persist(rotation))) throw new CopilotSignInChangedError();
        return rotation.to;
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  };

  const resolveCurrent = async (
    signal: AbortSignal,
    admit?: () => Promise<void>,
  ): Promise<CopilotCredential> => {
    // Reads, retried saves and refreshes run to completion so quiescence
    // observes them; cancellation only stops a caller starting a refresh.
    const credential = await load();
    signal.throwIfAborted();
    await admit?.();
    signal.throwIfAborted();
    const remaining = Date.parse(credential.accessTokenExpiresAt) - now();
    if (remaining > REFRESH_THRESHOLD_MS) return credential;
    return refresh(credential);
  };

  const current = (
    signal: AbortSignal,
    admit?: () => Promise<void>,
  ): Promise<CopilotCredential> => {
    signal.throwIfAborted();
    if (!accepting || deps.migrationAdmitted?.() === false)
      return Promise.reject(new CopilotSignInChangedError());
    const operation = resolveCurrent(signal, admit);
    pending.add(operation);
    void operation
      .finally(() => pending.delete(operation))
      .catch(() => undefined);
    return untilAborted(operation, signal);
  };

  return {
    async access(
      signal: AbortSignal,
      admit?: () => Promise<void>,
    ): Promise<{ accessToken: string; expiresAt: number }> {
      const credential = await current(signal, admit);
      if (deps.migrationAdmitted?.() === false)
        throw new CopilotSignInChangedError();
      return {
        accessToken: credential.accessToken,
        expiresAt: Date.parse(credential.accessTokenExpiresAt),
      };
    },
    resume(): void {
      if (permanentlyFenced || deps.migrationAdmitted?.() === false) return;
      accepting = true;
      quiescing = undefined;
    },
    async quiesce(permanent = false): Promise<void> {
      permanentlyFenced ||= permanent;
      accepting = false;
      quiescing ??= (async (): Promise<void> => {
        await Promise.allSettled(Array.from(pending));
        if (lastRotation && !lastRotation.saved) await persist(lastRotation);
      })();
      await quiescing;
    },
    async quiesceForMigration(): Promise<boolean> {
      await this.quiesce();
      return !lastRotation || lastRotation.saved;
    },
    async token(signal: AbortSignal): Promise<string> {
      const credential = await current(signal);
      if (deps.migrationAdmitted?.() === false)
        throw new CopilotSignInChangedError();
      return credential.accessToken;
    },
    // The SDK's own preflight asks for a refresh when its token nears expiry;
    // the threshold below answers that without forcing a second rotation when
    // another session already rotated the shared grant.
    tokenProvider: async ({ host }): Promise<GitHubTokenProviderResult> => {
      const credential = await current(
        AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      );
      if (deps.migrationAdmitted?.() === false)
        throw new CopilotSignInChangedError();
      if (normalizeHost(host) !== normalizeHost(credential.host))
        throw new Error(
          'Copilot asked for a GitHub token for a different host than the connected account. Reconnect Copilot in Settings.',
        );
      const remaining = Date.parse(credential.accessTokenExpiresAt) - now();
      // The SDK rejects a token at or under its own one-hour preflight
      // threshold, so a refresh that failed on the network must surface as
      // that failure here rather than as an opaque SDK validation error.
      if (remaining <= REFRESH_THRESHOLD_MS)
        throw new Error(NETWORK_REFRESH_FAILURE);
      return {
        kind: 'token',
        accessToken: credential.accessToken,
        expiresIn: Math.floor(remaining / 1000),
      };
    },
  };
}
